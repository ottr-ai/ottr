import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppCheck, ProjectView, TaskCard } from "../types.ts";
import {
	AppCheckLines,
	GitHostsSection,
	HindsightSection,
	openSettingsSection,
	ProjectSettingsForm,
	ProjectsOrderSection,
	SessionSection,
	SettingsPage,
} from "./settings.tsx";
import { stamp } from "./time.ts";

// React interaction needs browser globals; bun test has none. happy-dom (added
// with the card's approval) registers them here; afterAll puts the originals
// back, so later test files in the same process see no DOM. One named alias
// keeps the assignments type-checked in one place.
const window = new Window({ url: "http://localhost/" });
const host = globalThis as unknown as Record<string, unknown>;
const browserGlobals: Record<string, unknown> = {
	window,
	document: window.document,
	navigator: window.navigator,
	location: window.location,
	history: window.history,
	PopStateEvent: window.PopStateEvent,
	Event: window.Event,
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	HTMLTextAreaElement: window.HTMLTextAreaElement,
	Node: window.Node,
	getComputedStyle: window.getComputedStyle,
	requestAnimationFrame: window.requestAnimationFrame,
	cancelAnimationFrame: window.cancelAnimationFrame,
};
const originals = new Map<string, unknown>();

beforeAll(() => {
	host.IS_REACT_ACT_ENVIRONMENT = true;
	for (const [key, value] of Object.entries(browserGlobals)) {
		originals.set(key, host[key]);
		host[key] = value;
	}
});

afterAll(() => {
	delete host.IS_REACT_ACT_ENVIRONMENT;
	for (const [key, value] of originals) {
		if (value === undefined) delete host[key];
		else host[key] = value;
	}
});

/** The rendered GitHub App block, isolated from the other sec-blocks. */
const appBlock = (): string => {
	const html = renderToStaticMarkup(<GitHostsSection />);
	const start = html.indexOf('id="github-app-block"');
	const end = html.indexOf('id="host-tokens-block"');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return html.slice(start, end);
};

/** A React onChange picks up programmatic edits only through the native value setter. */
const typeInto = (
	el: HTMLInputElement | HTMLTextAreaElement,
	value: string,
): void => {
	const proto =
		el instanceof window.HTMLTextAreaElement
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	if (setter === undefined) throw new Error("value setter missing");
	setter.call(el, value);
};

/** happy-dom's dispatched input and change events never reach React's
 *  ChangeEventPlugin (upstream gap; the submit event does). The test therefore
 *  calls the production onChange React rendered onto the node, which is the
 *  same handler a browser input event would run. */
const onChangeOf = (node: Element): ((e: unknown) => void) => {
	const key = Object.getOwnPropertyNames(node).find((k) =>
		k.startsWith("__reactProps$"),
	);
	if (key === undefined) throw new Error("react props missing on node");
	const props = (node as unknown as Record<string, unknown>)[key] as {
		onChange?: (e: unknown) => void;
	};
	if (props.onChange === undefined) throw new Error("node has no onChange");
	return props.onChange;
};

/** The production onClick React rendered onto the node, read like onChangeOf. */
const onClickOf = (node: Element): ((e: unknown) => void) => {
	const key = Object.getOwnPropertyNames(node).find((k) =>
		k.startsWith("__reactProps$"),
	);
	if (key === undefined) throw new Error("react props missing on node");
	const props = (node as unknown as Record<string, unknown>)[key] as {
		onClick?: (e: unknown) => void;
	};
	if (props.onClick === undefined) throw new Error("node has no onClick");
	return props.onClick;
};

/** The production React handler `prop` on the node, read like onChangeOf. Drag and key
 * handlers attach conditionally (a drag only once dragstart set the state), so a missing
 * handler is a test bug and throws. */
const handlerOf = (node: Element, prop: string): ((e: unknown) => void) => {
	const key = Object.getOwnPropertyNames(node).find((k) =>
		k.startsWith("__reactProps$"),
	);
	if (key === undefined) throw new Error("react props missing on node");
	const props = (node as unknown as Record<string, unknown>)[key] as Record<
		string,
		((e: unknown) => void) | undefined
	>;
	const handler = props[prop];
	if (handler === undefined) throw new Error(`node has no ${prop}`);
	return handler;
};

/** The form-submit DOM event; happy-dom's Event class does not match lib.dom's. */
const submitEvent = (): Event =>
	new window.Event("submit", {
		bubbles: true,
		cancelable: true,
	}) as unknown as Event;

/** Mounts the section against `fetchMock`; the cleanup puts fetch and the DOM back. */
async function mountSection(fetchMock: typeof fetch): Promise<{
	container: HTMLDivElement;
	unmount: () => Promise<void>;
}> {
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchMock;
	// happy-dom's DOM classes do not structurally match lib.dom's; the test
	// speaks lib types, so the boundary converts once here.
	const container = window.document.createElement(
		"div",
	) as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	const root = createRoot(container);
	await act(async () => {
		root.render(<GitHostsSection />);
	});
	return {
		container,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		},
	};
}

describe("GitHostsSection GitHub App form", () => {
	test("Save is the form's submit button: Enter shares the button's guarded call path", () => {
		const block = appBlock();
		// With no saved app state the form branch shows. Its Save must be
		// type="submit", so a press of Enter runs the same guarded call as the
		// button: one busy flag, one error line, no duplicate POSTs.
		expect(block).toContain("<form");
		expect(block).toContain('<button type="submit"');
		expect(block).toContain("Save");
		// The old bug shipped a type="button" save control next to an onSubmit
		// that ran the request outside the busy guard; pin the corrected wiring.
		expect(block).not.toContain('<button type="button">Save</button>');
	});

	test("a 400 on save shows the server's error on the section's error line", async () => {
		let postCalls = 0;
		let postBody: { id?: string; key?: string } | undefined;
		const { promise: postInFlight, resolve: resolvePost } =
			Promise.withResolvers<Response>();
		const ok = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const view = {
			tokens: [],
			globalKey: null,
			githubApp: null,
			githubHost: "github.com",
		};
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET")
				return ok(view);
			// The GitHub token block in the same section checks its state on mount.
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (url.endsWith("/api/git-hosts/github-app")) {
				postCalls += 1;
				postBody = JSON.parse(String(init?.body));
				return postInFlight;
			}
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

		const { container, unmount } = await mountSection(fetchMock);
		try {
			// The load resolved with no saved app, so the form shows, errorless.
			const idInput = container.querySelector<HTMLInputElement>(
				"#github-app-block input",
			);
			const keyArea = container.querySelector<HTMLTextAreaElement>(
				"#github-app-block textarea",
			);
			const form = container.querySelector("#github-app-block form");
			if (idInput === null || keyArea === null || form === null)
				throw new Error("GitHub App form did not render");
			expect(
				container.querySelector(".auth-error")?.textContent ?? null,
			).toBeNull();

			// Type a numeric ID and a fake key into the fields, then let React's
			// production handlers pick the values up. The key fixture must stay
			// PEM-free: the CI secret scan pairs a BEGIN header with a KEY-----
			// tail 64+ characters later, so the two PEM strings here matched as
			// one leak and failed the Scan job (run 41583302106).
			await act(async () => {
				typeInto(idInput, "123456");
				onChangeOf(idInput)({ target: idInput, currentTarget: idInput });
				typeInto(keyArea, "fake-key-0000");
				onChangeOf(keyArea)({ target: keyArea, currentTarget: keyArea });
			});

			// Submit once through the form (the Enter path): the request starts
			// under the busy flag, the save button disables, the spinner shows.
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postCalls).toBe(1);
			expect(postBody).toEqual({
				id: "123456",
				key: "fake-key-0000",
			});
			const saveButton = container.querySelector<HTMLButtonElement>(
				"#github-app-block button[type='submit']",
			);
			if (saveButton === null) throw new Error("save button missing");
			expect(saveButton.disabled).toBe(true);
			expect(
				container.querySelector("#github-app-block .spinner"),
			).not.toBeNull();

			// A second submit while the POST is in flight is dropped by the guard.
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postCalls).toBe(1);

			// The server answers 400: the message lands on the section's error
			// line, the button comes back enabled, no success side effects.
			await act(async () => {
				resolvePost(
					new Response(JSON.stringify({ error: "key rejected: bad PEM" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					}),
				);
			});
			const line = container.querySelector(".auth-error");
			expect(line).not.toBeNull();
			expect(line?.getAttribute("role")).toBe("alert");
			expect(line?.textContent).toBe("key rejected: bad PEM");
			expect(saveButton.disabled).toBe(false);
			expect(container.querySelector("#github-app-block .spinner")).toBeNull();
		} finally {
			await unmount();
		}
	});
});

describe("GitHostsSection GitHub host", () => {
	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	const view = {
		tokens: [],
		globalKey: null,
		githubApp: null,
		githubHost: "github.com",
	};

	/** Mock for /api/git-hosts and the GitHub token check; `extra` handles the rest. */
	const baseMock = (
		loaded: { calls: number },
		extra: (url: string, init?: RequestInit) => Response | undefined,
	): typeof fetch =>
		(async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET") {
				loaded.calls += 1;
				return ok(view);
			}
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			const hit = extra(url, init);
			if (hit !== undefined) return hit;
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

	test("the input is prefilled with the host in effect", async () => {
		const loaded = { calls: 0 };
		const { container, unmount } = await mountSection(
			baseMock(loaded, () => undefined),
		);
		try {
			expect(loaded.calls).toBe(1);
			const input = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			if (input === null) throw new Error("GitHub host input did not render");
			expect(input.value).toBe("github.com");
			expect(input.getAttribute("aria-label")).toBe("GitHub host");
		} finally {
			await unmount();
		}
	});

	test("saving posts the new host and the section refetches", async () => {
		const loaded = { calls: 0 };
		let postCalls = 0;
		let postBody: { host?: string } | undefined;
		const fixture = { ...view };
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET") {
				loaded.calls += 1;
				return ok(fixture);
			}
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (
				url.endsWith("/api/settings/github-host") &&
				init?.method === "POST"
			) {
				postCalls += 1;
				postBody = JSON.parse(String(init.body));
				// The save lands; the refetch then reports the new host.
				fixture.githubHost = "acme.ghe.com";
				return ok({ host: "acme.ghe.com", expiresAt: null });
			}
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountSection(fetchMock);
		try {
			const input = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			const form = container.querySelector("#github-host-block form");
			if (input === null || form === null)
				throw new Error("form did not render");
			expect(loaded.calls).toBe(1);

			await act(async () => {
				typeInto(input, "acme.ghe.com");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postCalls).toBe(1);
			expect(postBody).toEqual({ host: "acme.ghe.com" });
			// The 200 refreshed the section: a second GET /api/git-hosts, and the
			// input now shows the host the refreshed state holds.
			expect(loaded.calls).toBe(2);
			const refetched = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			if (refetched === null) throw new Error("input gone after refetch");
			expect(refetched.value).toBe("acme.ghe.com");
		} finally {
			await unmount();
		}
	});

	test("a 400 lands on the section's error line and the view keeps the old host", async () => {
		const loaded = { calls: 0 };
		const { container, unmount } = await mountSection(
			baseMock(loaded, (url, init) => {
				if (
					url.endsWith("/api/settings/github-host") &&
					init?.method === "POST"
				)
					return new Response(
						JSON.stringify({
							error: "not a bare hostname: scheme not allowed",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				return undefined;
			}),
		);
		try {
			const input = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			const form = container.querySelector("#github-host-block form");
			if (input === null || form === null)
				throw new Error("form did not render");

			await act(async () => {
				typeInto(input, "https://acme.ghe.com");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			const line = container.querySelector(".auth-error");
			expect(line).not.toBeNull();
			expect(line?.getAttribute("role")).toBe("alert");
			expect(line?.textContent).toBe("not a bare hostname: scheme not allowed");
			// No refetch on failure: the section keeps the old host in the input.
			expect(loaded.calls).toBe(1);
			const kept = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			expect(kept?.value).toBe("https://acme.ghe.com");
		} finally {
			await unmount();
		}
	});
});

describe("ProjectSettingsForm target branch", () => {
	// A minimal ProjectView: the form reads the name and the full settings shape.
	const project = {
		name: "proj",
		icon: null,
		remote: null,
		github: null,
		hasRules: true,
		gitless: false,
		settings: {
			maxParallel: 2,
			copyExtra: [],
			displayName: null,
			releaseCommand: null,
			archReviewCap: 30,
			maxImages: 4,
			keptWorktreeDays: 7,
			autoTend: false,
			autoTendLimit: 5,
			tendChurnGlobs: [],
			holdUpdateMerges: false,
			retroSince: null,
			retroFilter: true,
			forkResearch: false,
			prReviews: false,
			prMode: false,
			pushSyncCommits: false,
			setupChecklist: false,
			targetBranch: null,
			originUrl: null,
			taskIdPrefix: null,
		},
		taskPrefix: "PROJ",
	} as unknown as ProjectView;

	/** Mounts the form against `fetchMock`; the cleanup puts fetch and the DOM back. */
	async function mountForm(fetchMock: typeof fetch): Promise<{
		container: HTMLDivElement;
		unmount: () => Promise<void>;
	}> {
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchMock;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<ProjectSettingsForm
					project={project}
					tasks={[]}
					act={async (fn) => {
						await fn();
						return true;
					}}
					openTask={() => {}}
				/>,
			);
		});
		return {
			container,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
				globalThis.fetch = realFetch;
			},
		};
	}

	test("the Worktrees card shows the target branch row and saving posts it", async () => {
		let postBody: Record<string, unknown> | undefined;
		const ok = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (
				url.endsWith("/api/projects/proj/settings") &&
				init?.method === "POST"
			) {
				postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
				return ok(project);
			}
			// Sections beside the form that load on mount.
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return ok({ own: null, expiresAt: null });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountForm(fetchMock);
		try {
			const card = container.querySelector("#project-worktrees-section");
			expect(card).not.toBeNull();
			// The Review learnings feature is removed: no card, no map entry, no fetch.
			expect(container.querySelector("#project-learnings-section")).toBeNull();
			expect(container.textContent).not.toContain("Review learnings");
			const row = card?.querySelector(".alate-def-row");
			expect(row?.textContent).toContain("Target branch");
			const input = card?.querySelector<HTMLInputElement>(
				'input[aria-label="Target branch for merges"]',
			);
			if (input === null || input === undefined)
				throw new Error("target branch input did not render");
			expect(input.value).toBe("");
			expect(input.getAttribute("placeholder")).toBe("main");
			expect(input.getAttribute("maxlength")).toBe("200");
			await act(async () => {
				typeInto(input, "develop");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			// The Worktrees card saves its own fields through its own form.
			const form = container.querySelector("#project-worktrees-section form");
			if (form === null) throw new Error("form did not render");
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postBody).not.toBeUndefined();
			expect(postBody?.targetBranch).toBe("develop");
		} finally {
			await unmount();
		}
	});

	test("the Identity card shows the task id prefix row and saving posts it", async () => {
		let postBody: Record<string, unknown> | undefined;
		const ok = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (
				url.endsWith("/api/projects/proj/settings") &&
				init?.method === "POST"
			) {
				postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
				return ok(project);
			}
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return ok({ own: null, expiresAt: null });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountForm(fetchMock);
		try {
			const card = container.querySelector("#project-identity-section");
			expect(card).not.toBeNull();
			const row = card?.querySelector(".alate-def-row");
			expect(row?.textContent).toContain("Display name");
			const input = card?.querySelector<HTMLInputElement>(
				'input[aria-label="Task ID prefix"]',
			);
			if (input === null || input === undefined)
				throw new Error("task id prefix input did not render");
			expect(input.value).toBe("");
			expect(input.getAttribute("placeholder")).toBe("PROJ");
			expect(input.getAttribute("maxlength")).toBe("8");
			await act(async () => {
				typeInto(input, "chs");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			const form = container.querySelector("#project-identity-section form");
			if (form === null) throw new Error("form did not render");
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postBody).not.toBeUndefined();
			expect(postBody?.taskIdPrefix).toBe("chs");
		} finally {
			await unmount();
		}
	});

	test("the Updates card shows the push sync commits checkbox and toggling posts it", async () => {
		let postBody: Record<string, unknown> | undefined;
		const ok = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (
				url.endsWith("/api/projects/proj/settings") &&
				init?.method === "POST"
			) {
				postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
				return ok(project);
			}
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return ok({ own: null, expiresAt: null });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountForm(fetchMock);
		try {
			const card = container.querySelector("#project-updates-section");
			expect(card).not.toBeNull();
			const label = [...(card?.querySelectorAll("label") ?? [])].find((l) =>
				l.textContent?.includes("Push sync commits"),
			);
			if (label === undefined) throw new Error("push sync commits row missing");
			const input = card?.querySelector<HTMLInputElement>(
				`input[id="${label.htmlFor}"]`,
			);
			if (input === null || input === undefined)
				throw new Error("push sync commits checkbox did not render");
			expect(input.checked).toBe(false);
			await act(async () => {
				onChangeOf(input)({ target: { checked: true }, currentTarget: input });
			});
			expect(postBody).not.toBeUndefined();
			expect(postBody?.pushSyncCommits).toBe(true);
			await act(async () => {
				onChangeOf(input)({ target: { checked: false }, currentTarget: input });
			});
			expect(postBody?.pushSyncCommits).toBe(false);
		} finally {
			await unmount();
		}
	});
});

describe("ProjectSettingsForm icon text marker", () => {
	// A minimal ProjectView: the form reads the name and the full settings shape.
	const project = {
		name: "proj",
		icon: null,
		remote: "https://github.com/octo/repo",
		github: "https://github.com/octo/repo",
		hasRules: true,
		gitless: false,
		settings: {
			maxParallel: 2,
			copyExtra: [],
			displayName: null,
			iconText: null,
			releaseCommand: null,
			archReviewCap: 30,
			maxImages: 4,
			keptWorktreeDays: 7,
			autoTend: false,
			autoTendLimit: 5,
			tendChurnGlobs: [],
			holdUpdateMerges: false,
			retroSince: null,
			retroFilter: true,
			forkResearch: false,
			prReviews: false,
			prMode: false,
			setupChecklist: false,
			targetBranch: null,
			originUrl: null,
		},
	} as unknown as ProjectView;

	/** Mounts the form against `fetchMock`; the cleanup puts fetch and the DOM back. */
	async function mountForm(fetchMock: typeof fetch): Promise<{
		container: HTMLDivElement;
		unmount: () => Promise<void>;
	}> {
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchMock;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<ProjectSettingsForm
					project={project}
					tasks={[]}
					act={async (fn) => {
						await fn();
						return true;
					}}
					openTask={() => {}}
				/>,
			);
		});
		return {
			container,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
				globalThis.fetch = realFetch;
			},
		};
	}

	test("the Icon card shows the marker row and saving posts the trimmed text", async () => {
		let postBody: Record<string, unknown> | undefined;
		const ok = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (
				url.endsWith("/api/projects/proj/settings") &&
				init?.method === "POST"
			) {
				postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
				return ok(project);
			}
			// Sections beside the form that load on mount.
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return ok({ own: null, expiresAt: null });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountForm(fetchMock);
		try {
			const card = container.querySelector("#project-icon-section");
			expect(card).not.toBeNull();
			expect(card?.textContent).toContain("Text marker");
			// No upload and no marker stored: the chip names the default chain.
			expect(card?.textContent).toContain("Default");
			const input = card?.querySelector<HTMLInputElement>(
				'input[aria-label="Text marker"]',
			);
			if (input === null || input === undefined)
				throw new Error("text marker input did not render");
			expect(input.getAttribute("maxlength")).toBe("4");
			await act(async () => {
				typeInto(input, " OT ");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			const form = card?.querySelector("form");
			if (form === null || form === undefined)
				throw new Error("text marker form did not render");
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postBody).not.toBeUndefined();
			// The server stores the trimmed text; an empty input would store null.
			expect(postBody?.iconText).toBe("OT");
		} finally {
			await unmount();
		}
	});
});

/** Mounts SessionSection against `fetchMock`, same cleanup as mountSection. */
async function mountSessions(fetchMock: typeof fetch): Promise<{
	container: HTMLDivElement;
	unmount: () => Promise<void>;
}> {
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchMock;
	const container = window.document.createElement(
		"div",
	) as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	const root = createRoot(container);
	await act(async () => {
		root.render(<SessionSection />);
	});
	return {
		container,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		},
	};
}

describe("SessionSection", () => {
	test("the list renders one row per session and marks only the current browser", async () => {
		const fetchMock = (async (): Promise<Response> =>
			new Response(
				JSON.stringify({
					sessions: [
						{
							id: "a".repeat(24),
							label: "Firefox on Windows",
							createdAt: Date.now() - 3 * 86_400_000,
							lastSeen: Date.now() - 2 * 86_400_000,
							current: false,
						},
						{
							id: "b".repeat(24),
							label: "Chrome on Linux",
							createdAt: Date.now() - 10 * 60_000,
							lastSeen: Date.now() - 2 * 60_000,
							current: true,
						},
					],
				}),
			)) as unknown as typeof fetch;
		const { container, unmount } = await mountSessions(fetchMock);
		try {
			const card = container.querySelector("#session-section");
			expect(card).not.toBeNull();
			const rows = card?.querySelectorAll(".session-row");
			expect(rows?.length).toBe(2); // one row per session; Sign out everywhere sits in the footer
			expect(container.textContent).toContain("Firefox on Windows");
			expect(container.textContent).toContain("Chrome on Linux");
			expect(container.textContent).toContain("This browser");
			expect(card?.querySelectorAll(".session-current").length).toBe(1);
			expect(
				card?.querySelectorAll(
					'button[aria-label="Sign out Firefox on Windows"]',
				),
			).toHaveLength(1);
			expect(
				card?.querySelectorAll('button[aria-label="Sign out Chrome on Linux"]'),
			).toHaveLength(1);
			expect(
				card?.querySelector(".sec-foot button.danger")?.textContent,
			).toContain("Sign out everywhere");
			// Ids are never rendered.
			expect(container.textContent).not.toContain("a".repeat(24));
		} finally {
			await unmount();
		}
	});

	test("a failed list fetch shows the failure line and keeps Sign out everywhere", async () => {
		const fetchMock = (async (): Promise<Response> =>
			new Response(JSON.stringify({ error: "boom" }), {
				status: 500,
			})) as unknown as typeof fetch;
		const { container, unmount } = await mountSessions(fetchMock);
		try {
			const card = container.querySelector("#session-section");
			expect(card).not.toBeNull();
			expect(container.textContent).toContain("Sessions could not be loaded.");
			expect(
				card?.querySelector(".sec-foot button.danger")?.textContent,
			).toContain("Sign out everywhere");
			// No per-session rows, so no per-session logout buttons.
			expect(
				card?.querySelectorAll('button[aria-label^="Sign out "]'),
			).toHaveLength(0);
		} finally {
			await unmount();
		}
	});
});

describe("GitHostsSection global SSH key", () => {
	test("Test and Save key send the server's pending:<id> reference, not the bare id", async () => {
		const ok = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const sent: { method: string; url: string; body: unknown }[] = [];
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.endsWith("/api/git-hosts") && method === "GET")
				return ok({
					tokens: [],
					globalKey: null,
					githubApp: null,
					githubHost: "github.com",
				});
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (url.endsWith("/api/git-hosts/ssh/pending"))
				return ok({
					id: "abc123",
					publicKey: "ssh-ed25519 AAAA",
					fingerprint: "SHA256:f",
				});
			if (
				url.endsWith("/api/git-hosts/ssh/test") ||
				url.endsWith("/api/git-hosts/ssh/global")
			) {
				sent.push({ method, url, body: JSON.parse(String(init?.body)) });
				return ok({ ok: true });
			}
			throw new Error(`unexpected fetch ${method} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountSection(fetchMock);
		try {
			const block = container.querySelector("#ssh-key-block");
			if (block === null) throw new Error("global key block missing");
			const button = (text: string): HTMLButtonElement => {
				const b = [...block.querySelectorAll("button")].find(
					(x) => x.textContent?.trim() === text,
				);
				if (b === undefined) throw new Error(`no ${text} button`);
				return b as HTMLButtonElement;
			};
			// Before a key and a URL exist, neither button can act.
			expect(button("Test key").disabled).toBe(true);
			expect(button("Save key").disabled).toBe(true);
			await act(async () => {
				button("Generate").click();
			});
			const url = block.querySelector<HTMLInputElement>(
				'input[aria-label^="Test URL"]',
			);
			if (url === null) throw new Error("test URL input missing");
			await act(async () => {
				typeInto(url, "git@git.example.com:a/repo.git");
				onChangeOf(url)({ target: url, currentTarget: url });
			});
			await act(async () => {
				button("Test key").click();
			});
			await act(async () => {
				button("Save key").click();
			});
			expect(sent).toEqual([
				{
					method: "POST",
					url: "/api/git-hosts/ssh/test",
					body: {
						url: "git@git.example.com:a/repo.git",
						key: "pending:abc123",
					},
				},
				{
					method: "PUT",
					url: "/api/git-hosts/ssh/global",
					body: {
						pending: "pending:abc123",
						testUrl: "git@git.example.com:a/repo.git",
					},
				},
			]);
		} finally {
			await unmount();
		}
	});
});

describe("AppCheckLines install summary", () => {
	const check = (over: Partial<AppCheck>): AppCheck => ({
		at: 0,
		name: "ottr-ai",
		url: "https://github.com/apps/ottr-ai",
		repos: [],
		missing: [],
		private: [],
		failed: [],
		error: null,
		...over,
	});

	test("private repos skipped by the install check keep the summary honest", () => {
		const html = renderToStaticMarkup(
			<AppCheckLines
				check={check({
					repos: ["octo/a", "octo/priv"],
					private: ["octo/priv"],
				})}
			/>,
		);
		expect(html).toContain(
			"Installed on all public board repos; 1 private repo skipped.",
		);
	});

	test("a repo whose check failed shows its own failure, not an all-clear", () => {
		const html = renderToStaticMarkup(
			<AppCheckLines
				check={check({
					repos: ["octo/a", "octo/b"],
					failed: [{ repo: "octo/a", detail: "repo lookup answered 500" }],
				})}
			/>,
		);
		expect(html).toContain(
			"Check failed for octo/a (repo lookup answered 500).",
		);
		expect(html).not.toContain("Installed on all");
	});
});

describe("ProjectSettingsForm review counter", () => {
	const FULL_SHA = "4f2c9ab1fullsha0000000000000000000000000";
	const SHORT = "4f2c9ab";
	const DONE_AT = 1_730_634_000_000;

	/** A project fixture like the target-branch one, plus the counter's inputs. */
	const projectWith = (
		archReview: ProjectView["archReview"],
		github: string | null,
	): ProjectView =>
		({
			name: "proj",
			icon: null,
			remote: null,
			github,
			hasRules: true,
			gitless: false,
			archReview,
			settings: {
				maxParallel: 2,
				copyExtra: [],
				displayName: null,
				releaseCommand: null,
				archReviewCap: 30,
				maxImages: 4,
				keptWorktreeDays: 7,
				autoTend: false,
				autoTendLimit: 5,
				tendChurnGlobs: [],
				holdUpdateMerges: false,
				retroSince: null,
				retroFilter: true,
				forkResearch: false,
				prReviews: false,
				prMode: false,
				setupChecklist: false,
				targetBranch: null,
				originUrl: null,
			},
		}) as unknown as ProjectView;

	/** Mounts the form for one project; the cleanup puts fetch and the DOM back. */
	async function mount(
		project: ProjectView,
		tasks: TaskCard[],
		openTask: (id: string) => void,
	): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
		const ok = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const fetchMock = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return ok({ own: null, expiresAt: null });
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchMock;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<ProjectSettingsForm
					project={project}
					tasks={tasks}
					act={async (fn) => {
						await fn();
						return true;
					}}
					openTask={openTask}
				/>,
			);
		});
		return {
			container,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
				globalThis.fetch = realFetch;
			},
		};
	}

	const counterLine = (container: HTMLDivElement): Element | null =>
		container.querySelector("#project-reviews-section .hint");

	test("counts from the review's base: the sha links to the commit, the card id opens the card", async () => {
		const opened: string[] = [];
		const review = { id: "R-1", doneAt: DONE_AT } as unknown as TaskCard;
		const { container, unmount } = await mount(
			projectWith(
				{
					delta: 12,
					reviewed: true,
					base: FULL_SHA,
					reviewCardId: "R-1",
					cap: 30,
					due: false,
					running: false,
				},
				"https://github.com/octo/repo",
			),
			[review],
			(id) => opened.push(id),
		);
		try {
			const line = counterLine(container);
			expect(line?.textContent).toContain("12 of 30 commits since");
			expect(line?.textContent).toContain(`done ${stamp(DONE_AT)}`);
			const sha = line?.querySelector("a");
			expect(sha?.getAttribute("href")).toBe(
				`https://github.com/octo/repo/commit/${FULL_SHA}`,
			);
			expect(sha?.getAttribute("rel")).toBe("noopener noreferrer");
			expect(sha?.textContent).toBe(SHORT);
			const cardButton = line?.querySelector("button");
			expect(cardButton?.getAttribute("aria-label")).toBe(
				"Open review card #R-1",
			);
			expect(cardButton?.textContent).toBe("#R-1");
			await act(async () => {
				onClickOf(cardButton!)({});
			});
			expect(opened).toEqual(["R-1"]);
		} finally {
			await unmount();
		}
	});

	test("no GitHub remote shows the sha as plain code text", async () => {
		const { container, unmount } = await mount(
			projectWith(
				{
					delta: 12,
					reviewed: true,
					base: FULL_SHA,
					reviewCardId: null,
					cap: 30,
					due: false,
					running: false,
				},
				null,
			),
			[],
			() => {},
		);
		try {
			const line = counterLine(container);
			expect(line?.textContent).toContain("12 of 30 commits since");
			expect(line?.querySelector("a")).toBeNull();
			expect(line?.querySelector("button")).toBeNull();
			expect(line?.querySelector("code")?.textContent).toBe(SHORT);
		} finally {
			await unmount();
		}
	});

	test("no full review yet says the whole history counts", async () => {
		const { container, unmount } = await mount(
			projectWith(
				{
					delta: 7,
					reviewed: false,
					base: null,
					reviewCardId: null,
					cap: 30,
					due: true,
					running: false,
				},
				"https://github.com/octo/repo",
			),
			[],
			() => {},
		);
		try {
			const line = counterLine(container);
			expect(line?.textContent).toContain(
				"No full review yet: all 7 commits count",
			);
			expect(line?.querySelector("a")).toBeNull();
			expect(line?.querySelector("button")).toBeNull();
		} finally {
			await unmount();
		}
	});

	test("a review open says so on the same line", async () => {
		const { container, unmount } = await mount(
			projectWith(
				{
					delta: 12,
					reviewed: true,
					base: FULL_SHA,
					reviewCardId: "R-1",
					cap: 30,
					due: false,
					running: true,
				},
				null,
			),
			[{ id: "R-1", doneAt: DONE_AT } as unknown as TaskCard],
			() => {},
		);
		try {
			expect(counterLine(container)?.textContent).toContain("review open");
		} finally {
			await unmount();
		}
	});

	test("a project with no arch review state shows no counter line", async () => {
		const { container, unmount } = await mount(
			projectWith(null, null),
			[],
			() => {},
		);
		try {
			expect(counterLine(container)).toBeNull();
		} finally {
			await unmount();
		}
	});
});

describe("ProjectsOrderSection", () => {
	/** A minimal project: the section reads the name, the icon and the label settings only. */
	const projectOf = (
		name: string,
		displayName: string | null = null,
	): ProjectView =>
		({
			name,
			icon: null,
			settings: { displayName, iconText: null },
		}) as unknown as ProjectView;

	const PROJECTS = [
		projectOf("alpha", "Alpha"),
		projectOf("beta"),
		projectOf("gamma"),
	];

	/** Mounts the section with `projects` against `fetchMock`, same cleanup as mountSection.
	 *  The act stub mirrors the app's act: it runs the send and reports false when it throws,
	 *  so a failed POST reaches the save tick as a failure. */
	async function mountProjects(
		fetchMock: typeof fetch,
		projects: ProjectView[] = PROJECTS,
	): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchMock;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<ProjectsOrderSection
					projects={projects}
					act={async (fn) => {
						try {
							await fn();
							return true;
						} catch {
							return false;
						}
					}}
				/>,
			);
		});
		return {
			container,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
				globalThis.fetch = realFetch;
			},
		};
	}

	const rowNames = (container: HTMLDivElement): (string | undefined)[] =>
		Array.from(
			container.querySelectorAll<HTMLElement>(".projects-order li[data-name]"),
			(el) => el.dataset.name,
		);

	/** Fixes the rows' boxes so dropBeforeId can place the slot from the pointer's clientY
	 *  (happy-dom lays out nothing: every real rect is zero). */
	const withRowBoxes = (container: HTMLDivElement): void => {
		container
			.querySelectorAll<HTMLElement>(".projects-order li[data-name]")
			.forEach((el, i) => {
				const top = i * 40;
				el.getBoundingClientRect = () =>
					({
						top,
						bottom: top + 36,
						left: 0,
						right: 200,
						width: 200,
						height: 36,
					}) as unknown as DOMRect;
			});
	};

	/** A POST mock for /api/projects/order that records the JSON body. */
	const orderFetch = (
		respond: () => Response,
	): { fetch: typeof fetch; body: () => unknown; calls: () => number } => {
		let received: unknown;
		let count = 0;
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/projects/order")) {
				count += 1;
				received = JSON.parse(String(init?.body));
				return respond();
			}
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		return { fetch: fetchMock, body: () => received, calls: () => count };
	};

	const ok = (): Response =>
		new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

	test("rows render in props order with the label and position in each aria-label", async () => {
		const fetchMock = (async (): Promise<Response> => {
			throw new Error("the section fetches nothing on mount");
		}) as unknown as typeof fetch;
		const { container, unmount } = await mountProjects(fetchMock);
		try {
			expect(rowNames(container)).toEqual(["alpha", "beta", "gamma"]);
			const labels = Array.from(
				container.querySelectorAll<HTMLElement>(
					".projects-order li[data-name]",
				),
				(el) => el.getAttribute("aria-label"),
			);
			expect(labels).toEqual([
				"Alpha, position 1 of 3",
				"beta, position 2 of 3",
				"gamma, position 3 of 3",
			]);
		} finally {
			await unmount();
		}
	});

	test("dropping row beta above row alpha posts the new full order", async () => {
		const mock = orderFetch(ok);
		const { container, unmount } = await mountProjects(mock.fetch);
		try {
			withRowBoxes(container);
			const ul = container.querySelector(".projects-order");
			const rowB = container.querySelector<HTMLElement>('li[data-name="beta"]');
			if (ul === null || rowB === null)
				throw new Error("projects list did not render");
			// dragstart dims the row only after the browser captured the drag image: one rAF.
			await act(async () => {
				handlerOf(
					rowB,
					"onDragStart",
				)({
					preventDefault() {},
					dataTransfer: { setData() {}, effectAllowed: "" },
				});
				const frame = Promise.withResolvers<void>();
				setTimeout(frame.resolve, 10);
				await frame.promise;
			});
			await act(async () => {
				handlerOf(
					ul,
					"onDragOver",
				)({
					preventDefault() {},
					clientX: 10,
					// Above row alpha's midpoint (18): the slot sits before alpha.
					clientY: 10,
					currentTarget: ul,
					dataTransfer: { dropEffect: "" },
				});
				handlerOf(
					ul,
					"onDrop",
				)({
					preventDefault() {},
					clientX: 10,
					clientY: 10,
					currentTarget: ul,
					dataTransfer: { dropEffect: "" },
				});
			});
			expect(mock.calls()).toBe(1);
			expect(mock.body()).toEqual({ order: ["beta", "alpha", "gamma"] });
			// The optimistic order shows at once; the props have not caught up here.
			expect(rowNames(container)).toEqual(["beta", "alpha", "gamma"]);
		} finally {
			await unmount();
		}
	});

	test("Alt+ArrowUp on row beta posts the same moved order", async () => {
		const mock = orderFetch(ok);
		const { container, unmount } = await mountProjects(mock.fetch);
		try {
			const ul = container.querySelector(".projects-order");
			const rowB = container.querySelector<HTMLElement>('li[data-name="beta"]');
			if (ul === null || rowB === null)
				throw new Error("projects list did not render");
			await act(async () => {
				handlerOf(
					ul,
					"onKeyDown",
				)({
					altKey: true,
					key: "ArrowUp",
					target: rowB,
					preventDefault() {},
				});
			});
			expect(mock.calls()).toBe(1);
			expect(mock.body()).toEqual({ order: ["beta", "alpha", "gamma"] });
			expect(rowNames(container)).toEqual(["beta", "alpha", "gamma"]);
		} finally {
			await unmount();
		}
	});

	test("a failed save shows Not saved and rolls the rows back to the props order", async () => {
		const mock = orderFetch(
			() =>
				new Response(JSON.stringify({ error: "x" }), {
					status: 500,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const { container, unmount } = await mountProjects(mock.fetch);
		try {
			const ul = container.querySelector(".projects-order");
			const rowB = container.querySelector<HTMLElement>('li[data-name="beta"]');
			if (ul === null || rowB === null)
				throw new Error("projects list did not render");
			await act(async () => {
				handlerOf(
					ul,
					"onKeyDown",
				)({
					altKey: true,
					key: "ArrowUp",
					target: rowB,
					preventDefault() {},
				});
				// Let the failed POST settle before reading the tick and the rows.
				const settled = Promise.withResolvers<void>();
				setTimeout(settled.resolve, 0);
				await settled.promise;
			});
			expect(mock.calls()).toBe(1);
			expect(container.textContent).toContain("Not saved");
			expect(rowNames(container)).toEqual(["alpha", "beta", "gamma"]);
		} finally {
			await unmount();
		}
	});
});

/** The HindsightView the GET on mount answers with. */
type HindsightView = {
	url: string | null;
	tokenSet: boolean;
	backend: "hindsight" | "mnemopi";
	memoryReason: string | null;
};

/** Mounts HindsightSection against a fetch mock that answers the view load, same cleanup as mountSessions. */
async function mountHindsight(view: HindsightView) {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (): Promise<Response> =>
		new Response(JSON.stringify(view))) as unknown as typeof fetch;
	const container = window.document.createElement(
		"div",
	) as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	const root = createRoot(container);
	await act(async () => {
		root.render(<HindsightSection />);
	});
	return {
		container,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		},
	};
}

/** Mounts the full General settings page; the fetch stub never resolves, so the
 *  sections stay idle and the test stays deterministic. Cleanup unmounts and
 *  puts fetch back. */
async function mountPage(): Promise<{
	container: HTMLDivElement;
	unmount: () => Promise<void>;
}> {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Promise<Response>(() => {})) as unknown as typeof fetch;
	const container = window.document.createElement(
		"div",
	) as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<SettingsPage
				projects={[]}
				tasks={[]}
				maxTotal={null}
				reviewCheck={false}
				workCheck={false}
				idleReviews={false}
				act={async () => true}
				view="settings"
				openTask={() => {}}
			/>,
		);
	});
	return {
		container,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		},
	};
}

/** The TOC row (a .smap-row button) currently pinned as `aria-current="location"`. */
const pinnedRow = (container: HTMLDivElement): string | null =>
	container.querySelector<HTMLElement>('.smap-row[aria-current="location"]')
		?.textContent ?? null;

describe("settings deep links", () => {
	test(
		"openSettingsSection pushes the settings path with the fragment and runs" +
			" the app's popstate listener",
		async () => {
			const pushed: string[] = [];
			const history = window.history;
			const realPush = history.pushState.bind(history);
			history.pushState = ((_s: unknown, _t: unknown, url: string) => {
				pushed.push(url);
			}) as typeof history.pushState;
			const seen: string[] = [];
			const listener = () => seen.push("pop");
			window.addEventListener("popstate", listener);
			let cancel: (() => void) | undefined;
			try {
				cancel = openSettingsSection("git-hosts-section");
				expect(pushed).toEqual(["/settings#git-hosts-section"]);
				expect(seen).toEqual(["pop"]);
			} finally {
				cancel?.();
				window.removeEventListener("popstate", listener);
				history.pushState = realPush;
			}
		},
	);

	test(
		"a deep link fragment pins the matching TOC row and the section exists" +
			" on mount",
		async () => {
			window.location.hash = "#git-hosts-section";
			const { container, unmount } = await mountPage();
			try {
				expect(pinnedRow(container)).toBe("Git hosts");
				expect(
					container.querySelector('[id="git-hosts-section"]'),
				).not.toBeNull();
			} finally {
				await unmount();
				window.location.hash = "";
			}
		},
	);

	test("a popstate to another fragment moves the pin to that row", async () => {
		window.location.hash = "#git-hosts-section";
		const { container, unmount } = await mountPage();
		try {
			expect(pinnedRow(container)).toBe("Git hosts");
			await act(async () => {
				window.location.hash = "#env-section";
				window.dispatchEvent(
					new window.PopStateEvent("popstate", { state: null }),
				);
			});
			expect(pinnedRow(container)).toBe("Env");
		} finally {
			await unmount();
			window.location.hash = "";
		}
	});

	test("a fragment naming nothing on the page pins nothing of its own", async () => {
		window.location.hash = "#bogus";
		const { container, unmount } = await mountPage();
		try {
			// The scroll-spy may mark a row current on its own; the bogus fragment
			// must not pin the row it names.
			const current = [
				...container.querySelectorAll('.smap-row[aria-current="location"]'),
			].map((r) => r.textContent);
			expect(current).not.toContain("Git hosts");
			expect(
				container.querySelector('[id="git-hosts-section"]'),
			).not.toBeNull();
		} finally {
			await unmount();
			window.location.hash = "";
		}
	});
});

describe("HindsightSection memory backend", () => {
	test("a mnemopi board with a failing store shows the backend chip and the no-memory warning", async () => {
		const { container, unmount } = await mountHindsight({
			url: null,
			tokenSet: false,
			backend: "mnemopi",
			memoryReason: "mnemopi store not writable: /data/home",
		});
		try {
			expect(container.textContent).toContain(
				"Memory backend: mnemopi (the default)",
			);
			const warning = container.querySelector('p[role="alert"].notif-line');
			expect(warning?.textContent).toBe(
				"omp runs with no memory: mnemopi store not writable: /data/home",
			);
			expect(container.textContent).toContain("never config.yml");
		} finally {
			await unmount();
		}
	});

	test("a healthy mnemopi board shows no warning line", async () => {
		const { container, unmount } = await mountHindsight({
			url: null,
			tokenSet: false,
			backend: "mnemopi",
			memoryReason: null,
		});
		try {
			expect(container.textContent).toContain(
				"Memory backend: mnemopi (the default)",
			);
			expect(container.textContent).not.toContain("omp runs with no memory");
		} finally {
			await unmount();
		}
	});

	test("a hindsight board shows the backend chip, the server URL and no warning line", async () => {
		const { container, unmount } = await mountHindsight({
			url: "http://hindsight.local:8888",
			tokenSet: true,
			backend: "hindsight",
			memoryReason: null,
		});
		try {
			expect(container.textContent).toContain("Memory backend: hindsight");
			expect(container.textContent).toContain("http://hindsight.local:8888");
			expect(container.textContent).not.toContain("omp runs with no memory");
		} finally {
			await unmount();
		}
	});
});

describe("GitHostsSection board GitHub token reuse", () => {
	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	const view = (githubTokenSet: boolean) => ({
		tokens: [],
		globalKey: null,
		githubApp: null,
		githubHost: "github.com",
		githubTokenSet,
	});

	/** Mock for /api/git-hosts and the GitHub token check; `extra` handles the rest. */
	const baseMock = (
		fixture: ReturnType<typeof view>,
		loaded: { calls: number },
		extra: (url: string, init?: RequestInit) => Response | undefined,
	): typeof fetch =>
		(async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET") {
				loaded.calls += 1;
				return ok(fixture);
			}
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			const hit = extra(url, init);
			if (hit !== undefined) return hit;
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

	test("the board-token button shows only for the configured GitHub host with a token", async () => {
		const loaded = { calls: 0 };
		const { container, unmount } = await mountSection(
			baseMock(view(true), loaded, () => undefined),
		);
		try {
			const hostInput = container.querySelector<HTMLInputElement>(
				"#host-tokens-block input[aria-label='Host']",
			);
			if (hostInput === null) throw new Error("Host input did not render");
			const buttons = (): Element[] =>
				Array.from(
					container.querySelectorAll("#host-tokens-block form button"),
				);
			// No host typed yet: hidden.
			expect(
				buttons().some((b) => b.textContent === "Use the board GitHub token"),
			).toBe(false);
			// The configured GitHub host: shown.
			await act(async () => {
				typeInto(hostInput, "github.com");
				onChangeOf(hostInput)({ target: hostInput, currentTarget: hostInput });
			});
			expect(
				buttons().some((b) => b.textContent === "Use the board GitHub token"),
			).toBe(true);
			// Another host: hidden again.
			await act(async () => {
				typeInto(hostInput, "gitlab.com");
				onChangeOf(hostInput)({ target: hostInput, currentTarget: hostInput });
			});
			expect(
				buttons().some((b) => b.textContent === "Use the board GitHub token"),
			).toBe(false);
		} finally {
			await unmount();
		}
	});
	describe("ProjectSettingsForm PR mode", () => {
		/** A project fixture with a settable GitHub remote and PR mode state. */
		const projectWith = (github: string | null, prMode: boolean): ProjectView =>
			({
				name: "proj",
				icon: null,
				remote: github,
				github,
				hasRules: true,
				gitless: false,
				archReviewCap: 30,
				settings: {
					maxParallel: 2,
					copyExtra: [],
					displayName: null,
					releaseCommand: null,
					archReviewCap: 30,
					maxImages: 4,
					keptWorktreeDays: 7,
					autoTend: false,
					autoTendLimit: 5,
					tendChurnGlobs: [],
					holdUpdateMerges: false,
					retroSince: null,
					retroFilter: true,
					forkResearch: false,
					prReviews: false,
					prMode,
					setupChecklist: false,
					targetBranch: null,
					originUrl: null,
				},
			}) as unknown as ProjectView;

		/** Mounts the form against `fetchMock`; the cleanup puts fetch and the DOM back. */
		async function mount(
			project: ProjectView,
			fetchMock: typeof fetch,
		): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
			const realFetch = globalThis.fetch;
			globalThis.fetch = fetchMock;
			const container = window.document.createElement(
				"div",
			) as unknown as HTMLDivElement;
			window.document.body.appendChild(container as unknown as HappyNode);
			const root = createRoot(container);
			await act(async () => {
				root.render(
					<ProjectSettingsForm
						project={project}
						tasks={[]}
						act={async (fn) => {
							await fn();
							return true;
						}}
						openTask={() => {}}
					/>,
				);
			});
			return {
				container,
				unmount: async () => {
					await act(async () => {
						root.unmount();
					});
					container.remove();
					globalThis.fetch = realFetch;
				},
			};
		}

		/** The PR mode checkbox, found through its row label like the push sync test. */
		const prModeRow = (container: HTMLDivElement) => {
			const label = [...container.querySelectorAll("label")].find((l) =>
				l.textContent?.includes("PR mode"),
			);
			if (label === undefined) throw new Error("PR mode row missing");
			const input = container.querySelector<HTMLInputElement>(
				`input[id="${label.htmlFor}"]`,
			);
			if (input === null) throw new Error("PR mode checkbox did not render");
			return input;
		};

		const fetchMockFor = (
			project: ProjectView,
			read: (postBody: Record<string, unknown> | undefined) => void,
		): typeof fetch =>
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (
					url.endsWith("/api/projects/proj/settings") &&
					init?.method === "POST"
				) {
					const body = JSON.parse(String(init.body)) as Record<string, unknown>;
					read(body);
					return new Response(JSON.stringify(project), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url.endsWith("/api/projects/proj/ssh-key"))
					return new Response(JSON.stringify({ own: null, expiresAt: null }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
			}) as typeof fetch;

		test("renders checked from the setting and toggling posts prMode true and false", async () => {
			const posts: (Record<string, unknown> | undefined)[] = [];
			const project = projectWith("https://github.com/octo/repo", true);
			const { container, unmount } = await mount(
				project,
				fetchMockFor(project, (body) => posts.push(body)),
			);
			try {
				const input = prModeRow(container);
				expect(input.checked).toBe(true);
				expect(input.disabled).toBe(false);
				await act(async () => {
					onChangeOf(input)({
						target: { checked: false },
						currentTarget: input,
					});
				});
				expect(posts[0]?.prMode).toBe(false);
				await act(async () => {
					onChangeOf(input)({
						target: { checked: true },
						currentTarget: input,
					});
				});
				expect(posts[1]?.prMode).toBe(true);
			} finally {
				await unmount();
			}
		});
		test("without a GitHub remote the row renders off and disabled until saved on", async () => {
			const project = projectWith(null, false);
			const { container, unmount } = await mount(
				project,
				fetchMockFor(project, () => {}),
			);
			try {
				const input = prModeRow(container);
				expect(input.checked).toBe(false);
				expect(input.disabled).toBe(true);
				expect(container.textContent).toContain("Needs a GitHub remote.");
			} finally {
				await unmount();
			}
		});
		test("saved on without a GitHub remote keeps the row enabled", async () => {
			const project = projectWith(null, true);
			const { container, unmount } = await mount(
				project,
				fetchMockFor(project, () => {}),
			);
			try {
				const input = prModeRow(container);
				expect(input.checked).toBe(true);
				expect(input.disabled).toBe(false);
			} finally {
				await unmount();
			}
		});
	});

	test("with no board token the button stays hidden even for github.com", async () => {
		const loaded = { calls: 0 };
		const { container, unmount } = await mountSection(
			baseMock(view(false), loaded, () => undefined),
		);
		try {
			const hostInput = container.querySelector<HTMLInputElement>(
				"#host-tokens-block input[aria-label='Host']",
			);
			if (hostInput === null) throw new Error("Host input did not render");
			await act(async () => {
				typeInto(hostInput, "github.com");
				onChangeOf(hostInput)({ target: hostInput, currentTarget: hostInput });
			});
			expect(
				Array.from(
					container.querySelectorAll("#host-tokens-block form button"),
				).some((b) => b.textContent === "Use the board GitHub token"),
			).toBe(false);
		} finally {
			await unmount();
		}
	});

	test("typing a host prefills the username with the host's convention until edited", async () => {
		const loaded = { calls: 0 };
		const { container, unmount } = await mountSection(
			baseMock(view(true), loaded, () => undefined),
		);
		try {
			const hostInput = container.querySelector<HTMLInputElement>(
				"#host-tokens-block input[aria-label='Host']",
			);
			const userInput = container.querySelector<HTMLInputElement>(
				"#host-tokens-block input[aria-label='Username']",
			);
			if (hostInput === null || userInput === null)
				throw new Error("form inputs did not render");
			const setHost = async (value: string): Promise<void> => {
				await act(async () => {
					typeInto(hostInput, value);
					onChangeOf(hostInput)({
						target: hostInput,
						currentTarget: hostInput,
					});
				});
			};
			await setHost("acme.ghe.com");
			expect(userInput.value).toBe("x-access-token");
			await setHost("gitlab.com");
			expect(userInput.value).toBe("oauth2");
			// A manual edit pins the username; later host changes keep it.
			await act(async () => {
				typeInto(userInput, "my-login");
				onChangeOf(userInput)({ target: userInput, currentTarget: userInput });
			});
			await setHost("acme.ghe.com");
			expect(userInput.value).toBe("my-login");
		} finally {
			await unmount();
		}
	});

	test("clicking the button POSTs the test URL and refreshes the view", async () => {
		const loaded = { calls: 0 };
		let postCalls = 0;
		let postBody: { testUrl?: string } | undefined;
		const fetchMock = baseMock(view(true), loaded, (url, init) => {
			if (
				url.endsWith("/api/git-hosts/github-token") &&
				init?.method === "POST"
			) {
				postCalls += 1;
				postBody = JSON.parse(String(init.body));
				return ok({ host: "github.com", username: "x-access-token" });
			}
			return undefined;
		});
		const { container, unmount } = await mountSection(fetchMock);
		try {
			const hostInput = container.querySelector<HTMLInputElement>(
				"#host-tokens-block input[aria-label='Host']",
			);
			const urlInput = container.querySelector<HTMLInputElement>(
				"#host-tokens-block input[aria-label='Test URL (a repository the token can read)']",
			);
			if (hostInput === null || urlInput === null)
				throw new Error("form inputs did not render");
			await act(async () => {
				typeInto(hostInput, "github.com");
				onChangeOf(hostInput)({ target: hostInput, currentTarget: hostInput });
				typeInto(urlInput, "https://github.com/acme/repo.git");
				onChangeOf(urlInput)({ target: urlInput, currentTarget: urlInput });
			});
			expect(loaded.calls).toBe(1);
			const button = Array.from(
				container.querySelectorAll("#host-tokens-block form button"),
			).find((b) => b.textContent === "Use the board GitHub token");
			if (button === undefined) throw new Error("board token button missing");
			await act(async () => {
				onClickOf(button)({ target: button, currentTarget: button });
			});
			expect(postCalls).toBe(1);
			expect(postBody).toEqual({ testUrl: "https://github.com/acme/repo.git" });
			expect(loaded.calls).toBe(2);
		} finally {
			await unmount();
		}
	});
});

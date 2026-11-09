import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	AppCheck,
	ProjectView,
	TaskCard,
	TrendingStatus,
} from "../types.ts";
import { resetCatalogCache } from "./models.ts";
import {
	AlateSection,
	AppCheckLines,
	asError,
	dashboardLink,
	fmtCost,
	fmtCount,
	fmtPct,
	GitHostsSection,
	HindsightSection,
	ModelRolesSection,
	NotificationsSection,
	OmpStatsSection,
	openSettingsSection,
	ProjectSettingsForm,
	ProjectSetupSteps,
	ProjectsOrderSection,
	SessionSection,
	SettingsPage,
	updatesChip,
	userLayerEmpty,
	userLayerLine,
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
	// happy-dom has no popover API; the model picker calls showPopover/hidePopover
	// directly. No-op stand-ins keep those calls working here: the top-layer
	// placement they drive in browsers is browser-only anyway. happy-dom's
	// element classes are per-Window, so this never reaches another test file.
	const proto = window.HTMLElement.prototype as unknown as Record<
		string,
		unknown
	>;
	for (const method of ["showPopover", "hidePopover", "togglePopover"])
		if (proto[method] === undefined) proto[method] = () => {};
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
		vmRunner: {
			configured: false,
			ok: false,
			reason: "OTTR_VM_RUNNER_URL is not set",
		},
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
			forkMergeHold: true,
			retroSince: null,
			retroFilter: true,
			forkResearch: false,
			prReviews: false,
			prMode: false,
			microVm: false,
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
					trendingScan={true}
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

	test("the Identity card saves both fields through one footer Save", async () => {
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
			// One Save for the card, in the footer: no save button on a row.
			const saves = card?.querySelectorAll("button.settings-save");
			expect(saves?.length).toBe(1);
			expect(
				card?.querySelector(".alate-def-row button.settings-save"),
			).toBeNull();
			const name = card?.querySelector<HTMLInputElement>(
				'input[aria-label="Display name"]',
			);
			if (name === null || name === undefined)
				throw new Error("display name input did not render");
			const input = card?.querySelector<HTMLInputElement>(
				'input[aria-label="Task ID prefix"]',
			);
			if (input === null || input === undefined)
				throw new Error("task id prefix input did not render");
			expect(input.value).toBe("");
			expect(input.getAttribute("placeholder")).toBe("PROJ");
			expect(input.getAttribute("maxlength")).toBe("8");
			await act(async () => {
				typeInto(name, "My Proj");
				onChangeOf(name)({ target: name, currentTarget: name });
				typeInto(input, "chs");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			const form = container.querySelector("#project-identity-section form");
			if (form === null) throw new Error("form did not render");
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postBody).not.toBeUndefined();
			expect(postBody?.displayName).toBe("My Proj");
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

	test("the Updates card shows the hold fork-born merges checkbox and toggling posts it", async () => {
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
				l.textContent?.includes("Hold fork-born merges"),
			);
			if (label === undefined)
				throw new Error("hold fork-born merges row missing");
			const input = card?.querySelector<HTMLInputElement>(
				`input[id="${label.htmlFor}"]`,
			);
			if (input === null || input === undefined)
				throw new Error("hold fork-born merges checkbox did not render");
			expect(input.checked).toBe(true);
			await act(async () => {
				onChangeOf(input)({ target: { checked: false }, currentTarget: input });
			});
			expect(postBody).not.toBeUndefined();
			expect(postBody?.forkMergeHold).toBe(false);
			await act(async () => {
				onChangeOf(input)({ target: { checked: true }, currentTarget: input });
			});
			expect(postBody?.forkMergeHold).toBe(true);
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
		vmRunner: {
			configured: false,
			ok: false,
			reason: "OTTR_VM_RUNNER_URL is not set",
		},
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
			microVm: false,
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
					trendingScan={true}
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

/** Mounts OmpStatsSection against `fetchMock`, same cleanup as mountSessions. */
async function mountOmpStats(fetchMock: typeof fetch): Promise<{
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
		root.render(<OmpStatsSection />);
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

describe("OmpStatsSection", () => {
	test("the report renders totals, both sources, and the by-model rows", async () => {
		const totals = {
			totalRequests: 120,
			successfulRequests: 118,
			failedRequests: 2,
			errorRate: 2 / 120,
			totalInputTokens: 24_000,
			totalOutputTokens: 6_400,
			totalCacheReadTokens: 12_000,
			totalCacheWriteTokens: 800,
			cacheRate: 0.5,
			cacheSavings: 0.4,
			totalCost: 12.5,
			unpricedRequests: 0,
			totalPremiumRequests: 3,
			avgDuration: 4_200,
			avgTtft: 300,
			avgTokensPerSecond: 42,
			firstTimestamp: null,
			lastTimestamp: null,
		};
		const fetchMock = (async (): Promise<Response> =>
			new Response(
				JSON.stringify({
					at: Date.now() - 60_000,
					sources: [
						{
							name: "board store",
							answer: { stats: { overall: totals, byModel: [] }, error: null },
						},
						{
							name: "lumen",
							answer: { stats: null, error: "exited with code 3: boom" },
						},
					],
					overall: totals,
					byModel: [{ ...totals, model: "glm-5.3-flash" }],
				}),
			)) as unknown as typeof fetch;
		const { container, unmount } = await mountOmpStats(fetchMock);
		try {
			const card = container.querySelector("#omp-stats-section");
			expect(card).not.toBeNull();
			// Totals readout: the fixture's numbers, formatted.
			expect(card?.textContent).toContain("120");
			expect(card?.textContent).toContain("$12.50");
			expect(card?.textContent).toContain("50.0%");
			// Per-source table: each row names its store, and the errored source
			// still lists with its error.
			const rows = card?.querySelectorAll("tbody tr") ?? [];
			const firstTable = [...(rows ?? [])].slice(0, 2);
			expect(firstTable[0]?.textContent).toContain("board store");
			expect(firstTable[1]?.textContent).toContain("lumen");
			expect(firstTable[1]?.textContent).toContain("exited with code 3: boom");
			// By-model table: model, requests, cost.
			expect(container.textContent).toContain("glm-5.3-flash");
		} finally {
			await unmount();
		}
	});

	test("a failed report fetch shows the failure alert", async () => {
		const fetchMock = (async (): Promise<Response> =>
			new Response(JSON.stringify({ error: "boom" }), {
				status: 500,
			})) as unknown as typeof fetch;
		const { container, unmount } = await mountOmpStats(fetchMock);
		try {
			const alert = container.querySelector('p[role="alert"]');
			expect(alert).not.toBeNull();
			expect(alert?.textContent).toContain("omp usage could not be loaded.");
		} finally {
			await unmount();
		}
	});

	/** Report fetch fails; the dashboard info answers `info`. */
	const dashboardFetch = (info: unknown): typeof fetch =>
		(async (input: RequestInfo | URL): Promise<Response> =>
			String(input).endsWith("/api/settings/omp-stats/dashboard")
				? new Response(JSON.stringify(info))
				: new Response(JSON.stringify({ error: "boom" }), {
						status: 500,
					})) as unknown as typeof fetch;

	test("a bound dashboard shows the launch link, even when the report fails", async () => {
		const { container, unmount } = await mountOmpStats(
			dashboardFetch({ port: 3848, error: null }),
		);
		try {
			const a = container.querySelector<HTMLAnchorElement>(
				"#omp-stats-section a",
			);
			expect(a?.textContent).toBe("Launch omp stats dashboard");
			expect(a?.getAttribute("href")).toBe("http://localhost:3848/");
			expect(a?.getAttribute("target")).toBe("_blank");
			expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
			expect(container.textContent).toContain(
				"omp's own dashboard with charts and session traces. The board starts it on demand and stops it after 30 minutes without use.",
			);
			expect(container.textContent).toContain("omp usage could not be loaded.");
		} finally {
			await unmount();
		}
	});

	test("a disabled dashboard shows its reason and no link", async () => {
		const { container, unmount } = await mountOmpStats(
			dashboardFetch({ port: null, error: "disabled by OTTR_OMP_STATS_PORT" }),
		);
		try {
			expect(container.querySelector("#omp-stats-section a")).toBeNull();
			expect(container.textContent).toContain(
				"The omp stats dashboard is off: disabled by OTTR_OMP_STATS_PORT",
			);
		} finally {
			await unmount();
		}
	});

	test("a failed dashboard info fetch shows its own caption", async () => {
		const { container, unmount } = await mountOmpStats(
			(async () =>
				new Response(JSON.stringify({ error: "boom" }), {
					status: 500,
				})) as unknown as typeof fetch,
		);
		try {
			expect(container.textContent).toContain(
				"The omp stats dashboard link could not be loaded.",
			);
		} finally {
			await unmount();
		}
	});

	test("dashboardLink links only on loopback hosts", () => {
		const on = { port: 3848, error: null };
		expect(dashboardLink("127.0.0.1", on)).toEqual({
			href: "http://127.0.0.1:3848/",
		});
		expect(dashboardLink("board.example.com", on)).toEqual({
			caption:
				"The omp stats dashboard opens only from the board on localhost.",
		});
		expect(dashboardLink("localhost", { port: null, error: "x" })).toEqual({
			caption: "The omp stats dashboard is off: x",
		});
	});

	test("the formatters keep the readout compact and priced", () => {
		expect(fmtCount(999)).toBe("999");
		expect(fmtCount(12_300)).toBe("12.3k");
		expect(fmtCount(2_100_000)).toBe("2.1M");
		expect(fmtCost(0.25)).toBe("$0.25");
		expect(fmtPct(0.5)).toBe("50.0%");
		expect(fmtPct(null)).toBe("—");
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
			vmRunner: {
				configured: false,
				ok: false,
				reason: "OTTR_VM_RUNNER_URL is not set",
			},
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
				microVm: false,
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
					trendingScan={true}
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

describe("Updates card", () => {
	const settings = (
		over: Partial<ProjectView["settings"]>,
	): ProjectView["settings"] =>
		({
			holdUpdateMerges: false,
			forkMergeHold: false,
			retroSince: null,
			retroFilter: false,
			forkResearch: false,
			trendingScout: false,
			prReviews: false,
			prMode: false,
			issueWatch: false,
			ompWatch: false,
			microVm: false,
			pushSyncCommits: false,
			...over,
		}) as unknown as ProjectView["settings"];

	test("the chip counts all twelve checkboxes", () => {
		expect(
			updatesChip(
				settings({
					retroSince: 1,
					retroFilter: true,
					forkResearch: true,
					trendingScout: true,
					prReviews: true,
					issueWatch: true,
					ompWatch: true,
				}),
			),
		).toEqual({ label: "7 of 12 on", tone: "ok" });
		expect(
			updatesChip(
				settings({
					holdUpdateMerges: true,
					prMode: true,
					microVm: true,
					pushSyncCommits: true,
				}),
			).label,
		).toBe("4 of 12 on");
	});

	test("the friction filter does not count while retro is off", () => {
		expect(updatesChip(settings({ retroFilter: true }))).toEqual({
			label: "0 of 12 on",
			tone: "off",
		});
	});

	const TAG = "Not needed: private repo";
	const project = (): ProjectView =>
		({
			name: "proj",
			icon: null,
			remote: null,
			github: "octo/repo",
			vmRunner: { configured: false, ok: false, reason: "not set" },
			hasRules: true,
			gitless: false,
			archReview: null,
			settings: {
				...settings({}),
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
				setupChecklist: false,
				targetBranch: null,
				originUrl: null,
			},
		}) as unknown as ProjectView;

	const json = (status: number, body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});

	/** Renders the form with the visibility route answering `visibility`; returns the names
	 *  of the rows that show the private-repo tag. */
	async function taggedRows(visibility: Response): Promise<string[]> {
		const fetchMock = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/projects/proj/github/visibility"))
				return visibility;
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return json(200, { own: null, expiresAt: null });
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchMock;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<ProjectSettingsForm
						project={project()}
						tasks={[]}
						trendingScan={true}
						act={async (fn) => {
							await fn();
							return true;
						}}
						openTask={() => {}}
					/>,
				);
			});
			await act(async () => {
				const settled = Promise.withResolvers<void>();
				setTimeout(settled.resolve, 0);
				await settled.promise;
			});
			return [
				...container.querySelectorAll("#project-updates-section .check-row"),
			]
				.filter((row) => row.textContent?.includes(TAG))
				.map((row) => row.querySelector("label")?.textContent ?? "");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	}

	test("a private repo marks fork research, PR reviews and issue watch", async () => {
		expect(await taggedRows(json(200, { private: true }))).toEqual([
			"Fork research",
			"PR reviews",
			"Issue watch",
		]);
	});

	test("a public repo or an unknown visibility marks nothing", async () => {
		expect(await taggedRows(json(200, { private: false }))).toEqual([]);
		expect(await taggedRows(json(502, { error: "gh failed" }))).toEqual([]);
	});
});

describe("Trending scout depends on the general weekly scan", () => {
	const project = (trendingScout: boolean): ProjectView =>
		({
			name: "proj",
			icon: null,
			remote: null,
			github: "octo/repo",
			vmRunner: { configured: false, ok: false, reason: "not set" },
			hasRules: true,
			gitless: false,
			archReview: null,
			settings: {
				holdUpdateMerges: false,
				retroSince: null,
				retroFilter: false,
				forkResearch: false,
				trendingScout,
				prReviews: false,
				prMode: false,
				issueWatch: false,
				microVm: false,
				pushSyncCommits: false,
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
				setupChecklist: false,
				targetBranch: null,
				originUrl: null,
			},
		}) as unknown as ProjectView;

	/** Mounts the form with the board's general trending switch at `trendingScan`; returns
	 *  the Trending scout row. The fetch stub answers the two mount calls, same as above. */
	async function scoutRow(
		trendingScan: boolean,
		trendingScout: boolean,
	): Promise<{ row: Element; unmount: () => Promise<void> }> {
		const json = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const fetchMock = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/projects/proj/github/visibility"))
				return json({ private: false });
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return json({ own: null, expiresAt: null });
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
					project={project(trendingScout)}
					tasks={[]}
					trendingScan={trendingScan}
					act={async (fn) => {
						await fn();
						return true;
					}}
					openTask={() => {}}
				/>,
			);
		});
		const row = [
			...container.querySelectorAll("#project-updates-section .check-row"),
		].find((r) => r.querySelector("label")?.textContent === "Trending scout");
		return {
			row: row as Element,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
				globalThis.fetch = realFetch;
			},
		};
	}

	test("the general switch off disables the project box and links General settings", async () => {
		const { row, unmount } = await scoutRow(false, false);
		try {
			const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
			expect(box?.disabled).toBe(true);
			const link = row.querySelector("a");
			expect(link?.textContent).toBe("General settings");
			expect(link?.getAttribute("href")).toBe("/settings#runners-section");
		} finally {
			await unmount();
		}
	});

	test("a scout already on stays clearable while the general switch is off", async () => {
		const { row, unmount } = await scoutRow(false, true);
		try {
			const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
			expect(box?.disabled).toBe(false);
			expect(row.querySelector("a")?.textContent).toBe("General settings");
		} finally {
			await unmount();
		}
	});

	test("the general switch on leaves the row enabled with no hint link", async () => {
		const { row, unmount } = await scoutRow(true, false);
		try {
			const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
			expect(box?.disabled).toBe(false);
			expect(row.querySelector("a")).toBeNull();
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
 *  puts fetch back. `trendingStatus` defaults to a board that never scanned. */
async function mountPage(
	trendingStatus: TrendingStatus = {
		lastRunAt: null,
		lastError: null,
		running: false,
	},
): Promise<{
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
				trendingScan={true}
				commitIdentity={null}
				trendingStatus={trendingStatus}
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

describe("General settings trending scan", () => {
	test("a failed scan shows its reason and time; a running scan disables Scan trending now", async () => {
		const at = 1_730_634_000_000;
		const { container, unmount } = await mountPage({
			lastRunAt: at - 7 * 86_400_000,
			lastError: { reason: "GitHub answered 502", at },
			running: true,
		});
		try {
			const text = container.textContent ?? "";
			expect(text).toContain(
				`Last trending scan failed: GitHub answered 502 (${stamp(at)})`,
			);
			// The failure replaces the last-run line until a scan succeeds.
			expect(text).not.toContain("Last scan:");
			expect(text).toContain("A scan is running.");
			const button = Array.from(container.querySelectorAll("button")).find(
				(b) => b.textContent?.trim() === "Scan trending now",
			);
			expect(button?.disabled).toBe(true);
			// The weekly switch is a labelled checkbox in the same card.
			const label = Array.from(container.querySelectorAll("label")).find(
				(l) => l.textContent === "Weekly trending scan",
			);
			const box = container.querySelector<HTMLInputElement>(
				`[id="${label?.htmlFor}"]`,
			);
			expect(box?.type).toBe("checkbox");
			expect(box?.checked).toBe(true);
		} finally {
			await unmount();
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
		const projectWith = (
			github: string | null,
			prMode: boolean,
			microVm = false,
			vmRunner: ProjectView["vmRunner"] = {
				configured: true,
				ok: true,
				reason: null,
			},
		): ProjectView =>
			({
				name: "proj",
				icon: null,
				remote: github,
				github,
				vmRunner,
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
					microVm,
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
						trendingScan={true}
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

		/** The microVM checkbox, through its row label (htmlFor), like prModeRow. */
		const microVmRow = (container: HTMLDivElement) => {
			const label = [...container.querySelectorAll("label")].find((l) =>
				l.textContent?.includes("Run work turns in microVMs"),
			);
			if (label === undefined) throw new Error("microVM row missing");
			const input = container.querySelector<HTMLInputElement>(
				`input[id="${label.htmlFor}"]`,
			);
			if (input === null) throw new Error("microVM checkbox did not render");
			return input;
		};

		test("microVM row toggles post microVm true and false while vm-runner is up", async () => {
			const posts: (Record<string, unknown> | undefined)[] = [];
			const project = projectWith(null, false);
			const { container, unmount } = await mount(
				project,
				fetchMockFor(project, (body) => posts.push(body)),
			);
			try {
				const input = microVmRow(container);
				expect(input.checked).toBe(false);
				expect(input.disabled).toBe(false);
				expect(container.textContent).not.toContain("vm-runner is not ready");
				await act(async () => {
					onChangeOf(input)({
						target: { checked: true },
						currentTarget: input,
					});
				});
				expect(posts[0]).toEqual({ microVm: true });
				await act(async () => {
					onChangeOf(input)({
						target: { checked: false },
						currentTarget: input,
					});
				});
				expect(posts[1]).toEqual({ microVm: false });
			} finally {
				await unmount();
			}
		});
		test("an unreachable vm-runner disables the off row and names the reason", async () => {
			const project = projectWith(null, false, false, {
				configured: true,
				ok: false,
				reason: "healthz answered 502",
			});
			const { container, unmount } = await mount(
				project,
				fetchMockFor(project, () => {}),
			);
			try {
				const input = microVmRow(container);
				expect(input.disabled).toBe(true);
				expect(container.textContent).toContain(
					"vm-runner is not ready (healthz answered 502). Each work turn runs",
				);
			} finally {
				await unmount();
			}
		});
		test("an unconfigured vm-runner names the env var; saved on keeps the row enabled", async () => {
			const down = {
				configured: false,
				ok: false,
				reason: "OTTR_VM_RUNNER_URL is not set",
			};
			const off = projectWith(null, false, false, down);
			const first = await mount(
				off,
				fetchMockFor(off, () => {}),
			);
			try {
				expect(microVmRow(first.container).disabled).toBe(true);
				expect(first.container.textContent).toContain(
					"Needs OTTR_VM_RUNNER_URL (docker compose --profile vm). ",
				);
			} finally {
				await first.unmount();
			}
			// Already on: the row stays enabled so the user can turn it off.
			const on = projectWith(null, false, true, down);
			const second = await mount(
				on,
				fetchMockFor(on, () => {}),
			);
			try {
				const input = microVmRow(second.container);
				expect(input.checked).toBe(true);
				expect(input.disabled).toBe(false);
			} finally {
				await second.unmount();
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

describe("NotificationsSection", () => {
	/** Mounts the section with two projects; each POST waits until the test answers it. */
	async function mountMutes(): Promise<{
		boxes: () => HTMLInputElement[];
		posts: Array<{ body: unknown; ok: () => void; fail: () => void }>;
		unmount: () => Promise<void>;
	}> {
		const projects = ["alpha", "beta"].map(
			(name) =>
				({
					name,
					icon: null,
					settings: { displayName: null, iconText: null },
				}) as unknown as ProjectView,
		);
		const posts: Array<{ body: unknown; ok: () => void; fail: () => void }> =
			[];
		const fetchMock = (async (url: string | URL, init?: RequestInit) => {
			if (init?.method === "POST") {
				const { promise, resolve } = Promise.withResolvers<Response>();
				posts.push({
					body: JSON.parse(String(init.body)),
					ok: () => resolve(Response.json({ ok: true })),
					fail: () =>
						resolve(Response.json({ error: "down" }, { status: 500 })),
				});
				return promise;
			}
			expect(String(url)).toBe("/api/notifications/prefs");
			return Response.json({ classes: null, mutedProjects: [] });
		}) as unknown as typeof fetch;
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchMock;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<NotificationsSection
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
			boxes: () => [
				...container.querySelectorAll<HTMLInputElement>(
					'.notify-group input[type="checkbox"]',
				),
			],
			posts,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
				globalThis.fetch = realFetch;
			},
		};
	}

	test("two mute switches flipped before the first answer both persist", async () => {
		const m = await mountMutes();
		try {
			const [a, b] = m.boxes();
			await act(async () => {
				onChangeOf(a!)({ target: { checked: true } });
				onChangeOf(b!)({ target: { checked: true } });
			});
			// One save in flight at a time; each sends the latest wanted list, so no POST
			// can drop the other switch's change.
			expect(m.posts.length).toBe(1);
			await act(async () => m.posts[0]!.ok());
			expect(m.posts.length).toBe(2);
			await act(async () => m.posts[1]!.ok());
			for (const p of m.posts)
				expect(p.body).toEqual({ mutedProjects: ["alpha", "beta"] });
		} finally {
			await m.unmount();
		}
	});

	test("a failed later save shows what the server holds, not an assumed inverse", async () => {
		const m = await mountMutes();
		try {
			const [a, b] = m.boxes();
			await act(async () => {
				onChangeOf(a!)({ target: { checked: true } });
				onChangeOf(b!)({ target: { checked: true } });
			});
			// The first POST already carries both mutes and succeeds; the second fails.
			await act(async () => m.posts[0]!.ok());
			await act(async () => m.posts[1]!.fail());
			expect(m.posts[0]!.body).toEqual({ mutedProjects: ["alpha", "beta"] });
			expect(m.boxes().map((x) => x.checked)).toEqual([true, true]);
		} finally {
			await m.unmount();
		}
	});
});

describe("ModelRolesSection model picker", () => {
	/** Mounts the section against `fetchMock`; the cleanup puts fetch and the catalog back. */
	async function mountRoles(fetchMock: typeof fetch): Promise<{
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
			root.render(<ModelRolesSection />);
		});
		return {
			container,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
				globalThis.fetch = realFetch;
				resetCatalogCache();
			},
		};
	}

	const rolesFetch = (
		roles: Record<string, string>,
		fallbacks: Record<string, string[]> = {},
	): typeof fetch =>
		(async (input: RequestInfo | URL) => {
			const ok = (body: unknown): Response =>
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			const url = String(input);
			if (url.endsWith("/api/model-roles"))
				return ok({
					base: "abc1234",
					hash: "h1",
					roles,
					fallbacks,
					signIns: ["zai", "anthropic"],
					seed: {
						needed: false,
						commit: null,
						roles: null,
						fallbacks: null,
						expiresAt: null,
					},
				});
			if (url.endsWith("/api/models"))
				return ok({
					models: [
						{
							id: "anthropic/claude-opus-5-5",
							selector: "anthropic/claude-opus-5-5",
							name: "Claude Opus 5.5",
							contextWindow: null,
						},
						{
							id: "zai/glm-5.3-flash",
							selector: "zai/glm-5.3-flash",
							name: "GLM 5.3 Flash",
							contextWindow: null,
						},
						{
							id: "openai/gpt-5",
							selector: "openai/gpt-5",
							name: "GPT 5",
							contextWindow: null,
						},
					],
					roles: {},
				});
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

	test("typing narrows the picker list; picking a model arms Save", async () => {
		resetCatalogCache();
		const { container, unmount } = await mountRoles(
			rolesFetch({ plan: "zai/glm-5.3-flash" }),
		);
		try {
			await act(async () => {});
			const trigger = container.querySelector("button.model-trigger");
			if (trigger === null) throw new Error("picker trigger did not render");
			expect(trigger.getAttribute("aria-label")).toBe("Model for plan");
			expect(trigger.textContent).toBe("GLM 5.3 Flash (zai/glm-5.3-flash)");
			// The untouched row saves nothing: Save arms only after a pick.
			const save = container.querySelector<HTMLButtonElement>(
				".alate-def-actions button",
			);
			if (save === null) throw new Error("Save button did not render");
			expect(save.disabled).toBe(true);

			// The unfiltered list holds the whole catalogue.
			const options = () => [
				...container.querySelectorAll("button.model-option"),
			];
			expect(options().length).toBe(3);

			// Typing filters; the note counts the matches over the catalogue.
			const search = container.querySelector<HTMLInputElement>(
				".model-pop input.search",
			);
			if (search === null) throw new Error("search box did not render");
			await act(async () => {
				typeInto(search, "opu");
				onChangeOf(search)({ target: search });
			});
			expect(options().length).toBe(1);
			expect(options()[0]!.textContent).toContain("Claude Opus 5.5");
			const note = container.querySelector(".filter-note");
			expect(note?.getAttribute("role")).toBe("status");
			expect(note?.textContent).toBe("1/3");

			// Clearing the input brings the full catalogue back.
			await act(async () => {
				typeInto(search, "");
				onChangeOf(search)({ target: search });
			});
			expect(options().length).toBe(3);

			// A pick rewrites the row and arms Save; the note leaves with the filter.
			await act(async () => {
				onClickOf(options()[0]!)({});
			});
			expect(trigger.textContent).toBe(
				"Claude Opus 5.5 (anthropic/claude-opus-5-5)",
			);
			expect(save.disabled).toBe(false);
			expect(container.querySelector(".filter-note")).toBeNull();
		} finally {
			await unmount();
		}
	});

	test("a saved model outside the catalogue keeps its note; Escape refocuses the trigger", async () => {
		resetCatalogCache();
		const { container, unmount } = await mountRoles(
			rolesFetch({ plan: "legacy/old-model" }),
		);
		try {
			await act(async () => {});
			const trigger = container.querySelector("button.model-trigger");
			if (trigger === null) throw new Error("picker trigger did not render");
			expect(trigger.textContent).toBe("legacy/old-model (not in the catalog)");
			// Nothing in the catalogue claims the unknown value.
			for (const o of container.querySelectorAll("button.model-option"))
				expect(o.getAttribute("aria-pressed")).toBe("false");

			const search = container.querySelector<HTMLInputElement>(
				".model-pop input.search",
			);
			if (search === null) throw new Error("search box did not render");
			await act(async () => {
				typeInto(search, "gpt");
				onChangeOf(search)({ target: search });
			});
			const options = [...container.querySelectorAll("button.model-option")];
			expect(options.length).toBe(1);

			// Escape hands the focus back to the trigger (the popover hides).
			await act(async () => {
				handlerOf(
					search,
					"onKeyDown",
				)({
					key: "Escape",
					preventDefault: () => {},
				});
			});
			expect(document.activeElement).toBe(trigger);
		} finally {
			await unmount();
		}
	});

	test("a role's fallbacks list in chain order; Add fallback, Move up and remove edit what Save sends", async () => {
		resetCatalogCache();
		const posts: Record<string, unknown>[] = [];
		const read = rolesFetch(
			{ plan: "zai/glm-5.3-flash", slow: "openai/gpt-5" },
			{
				plan: ["openai/gpt-5:high", "anthropic/claude-opus-5-5"],
				// A model-selector key: the file keeps it, the rows never show it.
				"zai/glm-5.3-flash": ["openai/gpt-5"],
			},
		);
		const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== "POST") return read(input, init);
			posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			return new Response(
				JSON.stringify({
					error: "Bad roles.",
					fields: {},
					fallbackFields: { plan: "fallback 3: duplicate model" },
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;
		// Let the POST, its JSON read and the state updates land.
		const settle = async (): Promise<void> => {
			for (let i = 0; i < 3; i++)
				await act(async () => {
					await Bun.sleep(0);
				});
		};
		const { container, unmount } = await mountRoles(fetchMock);
		try {
			await act(async () => {});
			const groups = [...container.querySelectorAll(".role-fallbacks")];
			expect(groups.length).toBe(2);
			const [plan, slow] = groups as [Element, Element];
			expect(plan.tagName).toBe("FIELDSET");
			expect(plan.querySelector("legend")?.textContent).toBe(
				"Fallbacks for plan",
			);
			const triggers = () => [
				...plan.querySelectorAll(".fallback-row button.model-trigger"),
			];
			expect(triggers().map((t) => t.getAttribute("aria-label"))).toEqual([
				"plan fallback 1 model",
				"plan fallback 2 model",
			]);
			expect(triggers().map((t) => t.textContent)).toEqual([
				"GPT 5 (openai/gpt-5)",
				"Claude Opus 5.5 (anthropic/claude-opus-5-5)",
			]);
			expect(
				[...plan.querySelectorAll(".fallback-row select")].map((s) =>
					s.getAttribute("aria-label"),
				),
			).toEqual(["plan fallback 1 thinking", "plan fallback 2 thinking"]);
			// Move up shows on every entry but the first.
			const ups = () => [...plan.querySelectorAll("button.fallback-up")];
			expect(ups().map((b) => b.getAttribute("aria-label"))).toEqual([
				"Move up plan fallback 2",
			]);
			// A role without a chain says so; the model-selector key shows nowhere.
			expect(slow.querySelector(".fallback-row")).toBeNull();
			expect(slow.textContent).toContain("No fallback models.");
			expect(container.querySelectorAll(".fallback-row").length).toBe(2);

			const save = container.querySelector<HTMLButtonElement>(
				".alate-def-actions button",
			);
			if (save === null) throw new Error("Save button did not render");
			expect(save.disabled).toBe(true);
			const add = plan.querySelector<HTMLButtonElement>("button.fallback-add");
			if (add === null) throw new Error("Add fallback did not render");
			expect(add.textContent).toBe("Add fallback");
			expect(add.disabled).toBe(false);

			// Add fallback appends the first catalogue model by name and arms Save.
			await act(async () => {
				onClickOf(add)({});
			});
			expect(triggers().map((t) => t.textContent)).toEqual([
				"GPT 5 (openai/gpt-5)",
				"Claude Opus 5.5 (anthropic/claude-opus-5-5)",
				"Claude Opus 5.5 (anthropic/claude-opus-5-5)",
			]);
			expect(save.disabled).toBe(false);

			// Move up swaps an entry with the one above it.
			await act(async () => {
				onClickOf(ups()[0]!)({});
			});
			expect(triggers().map((t) => t.textContent)).toEqual([
				"Claude Opus 5.5 (anthropic/claude-opus-5-5)",
				"GPT 5 (openai/gpt-5)",
				"Claude Opus 5.5 (anthropic/claude-opus-5-5)",
			]);

			// Save sends the rows' chains only, in the edited order.
			await act(async () => {
				onClickOf(save)({});
			});
			await settle();
			expect(posts.length).toBe(1);
			expect(posts[0]!.fallbacks).toEqual({
				plan: [
					"anthropic/claude-opus-5-5",
					"openai/gpt-5:high",
					"anthropic/claude-opus-5-5",
				],
			});

			// The 400's fallback message shows at the group and describes its controls.
			const message = plan.querySelector(".auth-error");
			expect(message?.textContent).toBe("fallback 3: duplicate model");
			for (const t of triggers()) {
				expect(t.getAttribute("aria-invalid")).toBe("true");
				expect(t.getAttribute("aria-describedby")).toBe(message?.id ?? null);
			}

			// Removing every entry clears the message; the emptied chain sends no key.
			for (let i = 0; i < 3; i++) {
				const remove = plan.querySelector("button.fallback-remove");
				if (remove === null) throw new Error("remove button did not render");
				expect(remove.getAttribute("aria-label")).toBe(
					"Remove plan fallback 1",
				);
				await act(async () => {
					onClickOf(remove)({});
				});
			}
			expect(plan.querySelector(".auth-error")).toBeNull();
			expect(plan.querySelector(".fallback-row")).toBeNull();
			expect(plan.textContent).toContain("No fallback models.");
			// The focus leaves the removed entry for Add fallback.
			expect(document.activeElement).toBe(add);
			await act(async () => {
				onClickOf(save)({});
			});
			await settle();
			expect(posts.length).toBe(2);
			expect(posts[1]!.fallbacks).toEqual({});
		} finally {
			await unmount();
		}
	});
});

/** Mounts AlateSection against `fetchMock`, same cleanup as mountSessions. */
async function mountAlate(fetchMock: typeof fetch): Promise<{
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
		root.render(<AlateSection />);
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

function alateFetchMock(handlers: {
	config?: {
		url: string | null;
		keySet: boolean;
		lastProvisionError?: string | null;
	};
	// A Response is handed out on every fetch; a factory builds a fresh one per call
	// and can count the calls it serves.
	keyGet?: Response | (() => Response);
	keyPost?: Response | (() => Response);
}): typeof fetch {
	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	return (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url = String(input);
		if (url.endsWith("/api/alate") && init?.method === undefined)
			return ok({
				url: null,
				keySet: false,
				lastProvisionError: null,
				...handlers.config,
			});
		if (url.endsWith("/api/alate/health")) throw new Error("no server");
		if (url.endsWith("/api/settings/alate-key")) {
			if (init?.method === "POST") {
				const h = handlers.keyPost;
				return typeof h === "function" ? h() : (h ?? ok({}));
			}
			const h = handlers.keyGet;
			return typeof h === "function" ? h() : (h ?? ok({ apiKey: null }));
		}
		throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
	}) as typeof fetch;
}

describe("AlateSection stored API key", () => {
	test("the stored key row shows the reveal, copy and regenerate controls", async () => {
		const { container, unmount } = await mountAlate(
			alateFetchMock({
				config: { url: "http://127.0.0.1:4570", keySet: true },
			}),
		);
		try {
			const card = container.querySelector("#alate-section");
			expect(card).not.toBeNull();
			expect(card?.textContent).toContain("Stored API key");
			expect(
				card?.querySelector('button[aria-label="Reveal Alate API key"]'),
			).not.toBeNull();
			expect(
				card?.querySelector('button[aria-label="Copy Alate API key"]'),
			).not.toBeNull();
			expect(
				card?.querySelector('button[aria-label="Regenerate Alate API key"]'),
			).not.toBeNull();
		} finally {
			await unmount();
		}
	});

	test("the stored key row hides when no key is set or the URL is empty", async () => {
		const noKey = await mountAlate(
			alateFetchMock({
				config: { url: "http://127.0.0.1:4570", keySet: false },
			}),
		);
		try {
			expect(noKey.container.textContent).not.toContain("Stored API key");
		} finally {
			await noKey.unmount();
		}
		const noUrl = await mountAlate(
			alateFetchMock({ config: { url: null, keySet: true } }),
		);
		try {
			expect(noUrl.container.textContent).not.toContain("Stored API key");
		} finally {
			await noUrl.unmount();
		}
	});

	test("reveal fetches the key once, then toggles between shown and masked", async () => {
		let gets = 0;
		const { container, unmount } = await mountAlate(
			alateFetchMock({
				config: { url: "http://127.0.0.1:4570", keySet: true },
				keyGet: () => {
					gets += 1;
					return new Response(JSON.stringify({ apiKey: "alate_secret_1" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				},
			}),
		);
		try {
			const eye = container.querySelector<HTMLButtonElement>(
				'button[aria-label="Reveal Alate API key"]',
			);
			if (eye === null) throw new Error("reveal button missing");
			await act(async () => {
				eye.click();
			});
			expect(gets).toBe(1);
			expect(container.textContent).toContain("alate_secret_1");
			expect(
				container.querySelector('button[aria-label="Hide Alate API key"]'),
			).not.toBeNull();
			const hidden = container.querySelector<HTMLButtonElement>(
				'button[aria-label="Hide Alate API key"]',
			);
			if (hidden === null) throw new Error("hide button missing");
			await act(async () => {
				hidden.click();
			});
			expect(gets).toBe(1);
			expect(container.textContent).not.toContain("alate_secret_1");
			expect(container.textContent).toContain("••••••••••••");
			expect(
				container.querySelector('button[aria-label="Reveal Alate API key"]'),
			).not.toBeNull();
		} finally {
			await unmount();
		}
	});

	test("regenerate replaces the shown key after the dialog confirms", async () => {
		let posts = 0;
		const { container, unmount } = await mountAlate(
			alateFetchMock({
				config: { url: "http://127.0.0.1:4570", keySet: true },
				keyPost: () => {
					posts += 1;
					return new Response(JSON.stringify({ apiKey: "rotated_key" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				},
			}),
		);
		try {
			const regen = container.querySelector<HTMLButtonElement>(
				'button[aria-label="Regenerate Alate API key"]',
			);
			if (regen === null) throw new Error("regenerate button missing");
			await act(async () => {
				regen.click();
			});
			const ok = [...window.document.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Regenerate"),
			);
			if (ok === undefined) throw new Error("confirm dialog missing");
			await act(async () => {
				ok.click();
			});
			expect(posts).toBe(1);
			expect(container.textContent).toContain("rotated_key");
		} finally {
			await unmount();
		}
	});

	test("a failed save after rotation still shows the new key with the error", async () => {
		const { container, unmount } = await mountAlate(
			alateFetchMock({
				config: { url: "http://127.0.0.1:4570", keySet: true },
				keyPost: new Response(
					JSON.stringify({
						error:
							"alate rotated the key, but the board could not save it (disk full). The key in apiKey is the new one: paste it into the Alate API key field and save.",
						apiKey: "rotated_key",
					}),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				),
			}),
		);
		try {
			const regen = container.querySelector<HTMLButtonElement>(
				'button[aria-label="Regenerate Alate API key"]',
			);
			if (regen === null) throw new Error("regenerate button missing");
			await act(async () => {
				regen.click();
			});
			const ok = [...window.document.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Regenerate"),
			);
			if (ok === undefined) throw new Error("confirm dialog missing");
			await act(async () => {
				ok.click();
			});
			const alert = container.querySelector('p[role="alert"]');
			expect(alert?.textContent).toContain("disk full");
			expect(container.textContent).toContain("rotated_key");
		} finally {
			await unmount();
		}
	});

	test("a refused rotate shows the error and leaves the key masked", async () => {
		const { container, unmount } = await mountAlate(
			alateFetchMock({
				config: { url: "http://127.0.0.1:4570", keySet: true },
				keyPost: new Response(JSON.stringify({ error: "unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
			}),
		);
		try {
			const regen = container.querySelector<HTMLButtonElement>(
				'button[aria-label="Regenerate Alate API key"]',
			);
			if (regen === null) throw new Error("regenerate button missing");
			await act(async () => {
				regen.click();
			});
			const ok = [...window.document.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Regenerate"),
			);
			if (ok === undefined) throw new Error("confirm dialog missing");
			await act(async () => {
				ok.click();
			});
			expect(container.querySelector('p[role="alert"]')?.textContent).toContain(
				"unauthorized",
			);
			expect(container.textContent).toContain("••••••••••••");
			expect(container.textContent).not.toContain("rotated_key");
		} finally {
			await unmount();
		}
	});

	test("copy fetches the key when needed and flashes Copied", async () => {
		let written: string | undefined;
		const realClipboard = Object.getOwnPropertyDescriptor(
			window.navigator,
			"clipboard",
		)?.value;
		Object.defineProperty(window.navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (t: string) => {
					written = t;
				},
			},
		});
		try {
			const { container, unmount } = await mountAlate(
				alateFetchMock({
					config: { url: "http://127.0.0.1:4570", keySet: true },
					keyGet: new Response(JSON.stringify({ apiKey: "alate_secret_2" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				}),
			);
			try {
				const copy = container.querySelector<HTMLButtonElement>(
					'button[aria-label="Copy Alate API key"]',
				);
				if (copy === null) throw new Error("copy button missing");
				await act(async () => {
					copy.click();
				});
				expect(written).toBe("alate_secret_2");
				expect(
					container.querySelector('button[aria-label="Copied"]'),
				).not.toBeNull();
			} finally {
				await unmount();
			}
		} finally {
			Object.defineProperty(window.navigator, "clipboard", {
				configurable: true,
				value: realClipboard,
			});
		}
	});
});

describe("ProjectSetupSteps rules action", () => {
	// A minimal ProjectView at step 2: the Rules section reads hasRules, gitless and the
	// settings the step's drafts seed from.
	const project = {
		name: "proj",
		hasRules: false,
		gitless: false,
		github: null,
		settings: {
			maxParallel: null,
			copyExtra: [],
			forkResearch: false,
		},
	} as unknown as ProjectView;

	const renderSteps = (props: {
		rulesTask?: string | null;
		openTask?: (id: string) => void;
	}): string =>
		renderToStaticMarkup(
			<ProjectSetupSteps
				project={project}
				rulesTask={props.rulesTask}
				openTask={props.openTask}
				act={async (fn) => {
					await fn();
					return true;
				}}
				onClose={() => {}}
			/>,
		);

	test("a live rules card offers Open rules task instead of Discuss rules", () => {
		const html = renderSteps({ rulesTask: "PROJ-7", openTask: () => {} });
		expect(html).toContain("Open rules task");
		expect(html).not.toContain("Discuss rules");
	});

	test("without a rules card or opener the Discuss rules button stays", () => {
		const html = renderSteps({});
		expect(html).toContain("Discuss rules");
		expect(html).not.toContain("Open rules task");
	});
});

describe("AlateSection user layer", () => {
	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	const server = {
		url: "http://127.0.0.1:4570",
		keySet: true,
		lastError: null,
		health: {
			state: "ok",
			version: "1.2.3",
			behind: false,
			pending: false,
			running: false,
		},
	};

	const fetchMockFor = (userLayer: Record<string, unknown>): typeof fetch => {
		const mock = (async (
			input: RequestInfo | URL,
			_init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url === "/api/alate")
				return ok({
					url: "http://127.0.0.1:4570",
					keySet: true,
					lastProvisionError: null,
				});
			if (url === "/api/alate/health")
				return ok({
					version: "1.2.3",
					update: { behind: false },
					pending: false,
					running: false,
				});
			if (url === "/api/provisioning")
				return ok({ server, workers: [], userLayer });
			return new Response(JSON.stringify({ error: "not found" }), {
				status: 404,
			});
		}) as typeof fetch;
		return mock;
	};

	test("a filled layer shows one line with counts and MCP names", async () => {
		const { container, unmount } = await mountAlate(
			fetchMockFor({
				skills: ["blast-radius", "correct"],
				plugins: ["caveman-installer"],
				mcp: ["chrome-devtools", "context-mode"],
			}),
		);
		try {
			expect(container.textContent).toContain(
				"User layer: 2 skills, 1 plugin, MCP servers: chrome-devtools, context-mode",
			);
			expect(container.textContent).not.toContain("User layer is empty");
		} finally {
			await unmount();
		}
	});

	test("an empty layer shows the callout with the sync hint", async () => {
		const { container, unmount } = await mountAlate(
			fetchMockFor({ skills: [], plugins: [], mcp: [] }),
		);
		try {
			expect(container.textContent).toContain("User layer is empty");
			expect(container.textContent).toContain("sync-user.mjs --data");
			expect(container.textContent).not.toContain("User layer: ");
			const callout = container.querySelector(".prov-callout");
			expect(callout).not.toBeNull();
			expect(callout?.getAttribute("role")).toBe("status");
		} finally {
			await unmount();
		}
	});

	test("the line helpers pluralize counts and treat MCP-only layers as empty", () => {
		expect(userLayerLine({ skills: ["a"], plugins: [], mcp: [] })).toBe(
			"User layer: 1 skill, 0 plugins, MCP servers: none",
		);
		expect(userLayerEmpty({ skills: [], plugins: [], mcp: ["x"] })).toBe(true);
		expect(userLayerEmpty({ skills: ["a"], plugins: [], mcp: [] })).toBe(false);
	});
});

describe("Error-Says-Fix messages", () => {
	// The same minimal ProjectView the form tests use: the form reads the name
	// and the full settings shape.
	const project = {
		name: "proj",
		icon: null,
		remote: null,
		github: null,
		vmRunner: {
			configured: false,
			ok: false,
			reason: "OTTR_VM_RUNNER_URL is not set",
		},
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
			microVm: false,
			pushSyncCommits: false,
			setupChecklist: false,
			targetBranch: null,
			originUrl: null,
			taskIdPrefix: null,
		},
		taskPrefix: "PROJ",
	} as unknown as ProjectView;

	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

	test("asError names the request, the status in words and a next step", () => {
		const line = asError({}, 500, "saving the token");
		expect(line).toBe(
			"saving the token failed: the server answered 500 (server error). Try again; if it repeats, the server log has the reason.",
		);
		expect(asError({}, 503, "saving the token")).toContain("(unavailable)");
		// The server's own error string wins verbatim.
		expect(asError({ error: "locked" }, 409, "saving the token")).toBe(
			"locked",
		);
	});

	test("the icon row's tick shows the server's reason after a failed upload", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/projects/proj/icon") && init?.method === "POST")
				return new Response(JSON.stringify({ error: "icon too large" }), {
					status: 413,
					headers: { "Content-Type": "application/json" },
				});
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return ok({ own: null, expiresAt: null });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
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
					tasks={[]}
					// The app's act reports the thrown message; the tick repeats it.
					act={async (fn, onError) => {
						try {
							await fn();
							return true;
						} catch (err) {
							onError?.(err instanceof Error ? err.message : String(err));
							return false;
						}
					}}
					openTask={() => {}}
				/>,
			);
		});
		try {
			const input = container.querySelector<HTMLInputElement>(
				'input[type="file"][accept^="image/"]',
			);
			if (input === null || input === undefined)
				throw new Error("icon upload input did not render");
			const file = new window.File([new Uint8Array([1])], "icon.png", {
				type: "image/png",
			});
			await act(async () => {
				onChangeOf(input)({
					target: { files: [file], value: "" },
					currentTarget: input,
				});
			});
			const tick = container.querySelector(".save-tick-failed");
			expect(tick).not.toBeNull();
			expect(tick?.getAttribute("role")).toBe("alert");
			expect(tick?.textContent).toBe("Not saved: icon too large");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("a failed Identity save marks the field and shows the reason under it", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (
				url.endsWith("/api/projects/proj/settings") &&
				init?.method === "POST"
			)
				return new Response(JSON.stringify({ error: "settings locked" }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				});
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return ok({ own: null, expiresAt: null });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
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
					tasks={[]}
					act={async (fn, onError) => {
						try {
							await fn();
							return true;
						} catch (err) {
							onError?.(err instanceof Error ? err.message : String(err));
							return false;
						}
					}}
					openTask={() => {}}
				/>,
			);
		});
		try {
			const input = container.querySelector<HTMLInputElement>(
				'input[aria-label="Display name"]',
			);
			if (input === null || input === undefined)
				throw new Error("display name input did not render");
			await act(async () => {
				typeInto(input, "chs");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			const form = container.querySelector("#project-identity-section form");
			if (form === null) throw new Error("form did not render");
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			// A card-level save failure announces once, under Display name only.
			const card = container.querySelector("#project-identity-section");
			const errors = card?.querySelectorAll(".auth-error") ?? [];
			expect(errors.length).toBe(1);
			expect(input.getAttribute("aria-invalid")).toBe("true");
			const describedBy = input.getAttribute("aria-describedby");
			expect(describedBy).not.toBeNull();
			const message = [...container.querySelectorAll(`p[role="alert"]`)].find(
				(p) => p.id === describedBy,
			);
			expect(message).not.toBeNull();
			expect(message?.getAttribute("role")).toBe("alert");
			expect(message?.className).toContain("auth-error");
			expect(message?.textContent).toBe("settings locked");
			const prefixInput = container.querySelector<HTMLInputElement>(
				'input[aria-label="Task ID prefix"]',
			);
			if (prefixInput === null || prefixInput === undefined)
				throw new Error("task id prefix input did not render");
			expect(prefixInput.getAttribute("aria-invalid")).toBeNull();
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("the git remote inputs carry inputMode, spellCheck and autoComplete off", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts"))
				return ok({
					githubHost: "github.com",
					tokens: [],
					globalKey: null,
					githubApp: null,
					githubTokenSet: false,
				});
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchMock;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(<GitHostsSection />);
		});
		try {
			const urls = [
				...container.querySelectorAll<HTMLInputElement>(
					'input[aria-label^="Test URL"]',
				),
			];
			expect(urls.length).toBe(2);
			for (const input of urls) {
				expect(input.getAttribute("inputmode")).toBe("url");
				expect(input.getAttribute("spellcheck")).toBe("false");
				expect(input.getAttribute("autocomplete")).toBe("off");
			}
			// The project SSH key's test URL carries the same three attributes.
			const formFetch = (async (
				input: RequestInfo | URL,
				init?: RequestInit,
			): Promise<Response> => {
				const url = String(input);
				if (url.endsWith("/api/projects/proj/ssh-key"))
					return ok({ own: null, expiresAt: null });
				throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
			}) as typeof fetch;
			globalThis.fetch = formFetch;
			const formContainer = window.document.createElement(
				"div",
			) as unknown as HTMLDivElement;
			window.document.body.appendChild(formContainer as unknown as HappyNode);
			const formRoot = createRoot(formContainer);
			await act(async () => {
				formRoot.render(
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
			try {
				const pUrl = formContainer.querySelector<HTMLInputElement>(
					'input[aria-label="Test URL (a repository this key can read)"]',
				);
				if (pUrl === null || pUrl === undefined)
					throw new Error("project test URL input did not render");
				expect(pUrl.getAttribute("inputmode")).toBe("url");
				expect(pUrl.getAttribute("spellcheck")).toBe("false");
				expect(pUrl.getAttribute("autocomplete")).toBe("off");
			} finally {
				await act(async () => {
					formRoot.unmount();
				});
				formContainer.remove();
			}
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("the SSH key confirm dialog names the project", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/projects/proj/ssh-key"))
				return ok({
					own: { publicKey: "ssh-ed25519 AAA", fingerprint: "FP01" },
					expiresAt: null,
				});
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
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
					tasks={[]}
					act={async (fn) => {
						await fn();
						return true;
					}}
					openTask={() => {}}
				/>,
			);
		});
		try {
			const button = [
				...container.querySelectorAll<HTMLElement>("button"),
			].find((b) => b.textContent === "Use global key");
			if (button === undefined)
				throw new Error("Use global key button did not render");
			await act(async () => {
				onClickOf(button)({ target: button, currentTarget: button });
			});
			const dialog = [...window.document.body.querySelectorAll("dialog")].at(
				-1,
			);
			expect(dialog).not.toBeNull();
			expect(dialog?.textContent).toContain("Remove proj's SSH key?");
			expect(dialog?.textContent).toContain("Use global key");
			// Close the dialog so it does not leak into later tests.
			const cancel = [...(dialog?.querySelectorAll("button") ?? [])].find(
				(b) => b.textContent === "Cancel",
			);
			await act(async () => {
				if (cancel !== undefined)
					onClickOf(cancel as unknown as Element)({
						target: cancel as unknown as Element,
						currentTarget: cancel as unknown as Element,
					});
			});
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});
});

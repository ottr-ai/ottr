import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
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
	appChip,
	asError,
	dashboardLink,
	EnvSection,
	fmtCost,
	fmtCount,
	fmtPct,
	GitHostsSection,
	HindsightSection,
	hostedHidden,
	ModelRolesSection,
	NotificationsSection,
	OmpStatsSection,
	onChip,
	openSettingsSection,
	ProjectSettingsForm,
	ProjectSetupSteps,
	ProjectsOrderSection,
	type ProvisionResult,
	pageToc,
	provisionChangeSummary,
	runCeiling,
	SETTINGS_TOC,
	SessionSection,
	SettingsPage,
	shortProvisionLines,
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
	const html = renderToStaticMarkup(
		<GitHostsSection commitIdentity={null} act={async () => true} />,
	);
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

/** Flushes confirmDialog's deferred unmount and any deferred lane update (a
 *  timer React starts for the new dialog root) inside the test's window, so a
 *  pending React update cannot outlive the file's DOM globals. */
const settleDialog = async (): Promise<void> => {
	await act(async () => {
		await Bun.sleep(50);
	});
};

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
		root.render(
			<GitHostsSection commitIdentity={null} act={async () => true} />,
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
			// The turn-token block in the same section loads its rows on mount.
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: "github.com", tokens: [] });
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
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: view.githubHost, tokens: [] });
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
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: fixture.githubHost, tokens: [] });
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

	test("one Save sends the edited host and then the pasted token; a token alone skips the host", async () => {
		const loaded = { calls: 0 };
		const posts: { url: string; body: unknown }[] = [];
		const base = baseMock(loaded, (url, init) =>
			url.endsWith("/api/settings/github-host") && init?.method === "POST"
				? ok({ host: "acme.ghe.com" })
				: undefined,
		);
		// Record every POST before the base mock answers it (it serves the token route itself).
		const { container, unmount } = await mountSection((async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			if (init?.method === "POST")
				posts.push({ url: String(input), body: JSON.parse(String(init.body)) });
			return base(input, init);
		}) as typeof fetch);
		try {
			const host = container.querySelector<HTMLInputElement>(
				'#github-host-block input[aria-label="GitHub host"]',
			);
			const token = container.querySelector<HTMLInputElement>(
				'#github-host-block input[aria-label="GitHub token"]',
			);
			const form = container.querySelector("#github-host-block form");
			const saves = container.querySelectorAll(
				'#github-host-block button[type="submit"]',
			);
			if (host === null || token === null || form === null)
				throw new Error("connection form did not render");
			expect(saves.length).toBe(1);
			await act(async () => {
				typeInto(host, "acme.ghe.com");
				onChangeOf(host)({ target: host, currentTarget: host });
				typeInto(token, "ghp_new");
				onChangeOf(token)({ target: token, currentTarget: token });
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			// The save chains two requests and a refetch: let them all land.
			for (let k = 0; k < 5; k++)
				await act(async () => {
					await new Promise((r) => setTimeout(r, 0));
				});
			expect(posts.map((p) => p.url.replace(/^.*\/api/, "/api"))).toEqual([
				"/api/settings/github-host",
				"/api/settings/github-token",
			]);
			expect(posts[1]?.body).toEqual({ token: "ghp_new" });
			expect(token.value).toBe("");
			posts.length = 0;
			await act(async () => {
				typeInto(token, "ghp_other");
				onChangeOf(token)({ target: token, currentTarget: token });
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			// The save chains two requests and a refetch: let them all land.
			for (let k = 0; k < 5; k++)
				await act(async () => {
					await new Promise((r) => setTimeout(r, 0));
				});
			expect(posts.map((p) => p.url.replace(/^.*\/api/, "/api"))).toEqual([
				"/api/settings/github-token",
			]);
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
			const card = container.querySelector("#project-merging-section");
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
			const card = container.querySelector("#project-merging-section");
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
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: "github.com", tokens: [] });
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

describe("Project switch cards", () => {
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

	test("a switch card's chip counts the checkboxes that are on", () => {
		expect(onChip([true, false, true])).toEqual({
			label: "2 of 3 on",
			tone: "ok",
		});
		expect(onChip([false, false])).toEqual({ label: "0 of 2 on", tone: "off" });
	});

	test("the Proposals chip does not count the friction filter while retro is off", async () => {
		const html = renderToStaticMarkup(
			<ProjectSettingsForm
				project={
					{
						...project(),
						settings: {
							...project().settings,
							retroFilter: true,
							trendingScout: true,
						},
					} as unknown as ProjectView
				}
				tasks={[]}
				trendingScan={true}
				act={async () => true}
				openTask={() => {}}
			/>,
		);
		const card = html.slice(html.indexOf('id="project-proposals-section"'));
		expect(card.slice(0, 600)).toContain("1 of 3 on");
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
				...container.querySelectorAll("#project-watches-section .check-row"),
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
			"Issue watch",
			"PR reviews",
			"Fork research",
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
			...container.querySelectorAll("#project-proposals-section .check-row"),
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
			expect(link?.getAttribute("href")).toBe("/settings#automation-section");
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
	tokenReadable: boolean;
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

/** Mounts General settings with an optional fetch mock and act. By default, requests stay
 * pending and act runs nothing, so sections remain idle. Cleanup unmounts and restores fetch. */
async function mountPage(
	trendingStatus: TrendingStatus = {
		lastRunAt: null,
		lastError: null,
		running: false,
	},
	fetchMock?: typeof fetch,
	actFn: (fn: () => Promise<void>) => Promise<boolean> = async () => true,
): Promise<{
	container: HTMLDivElement;
	unmount: () => Promise<void>;
}> {
	const realFetch = globalThis.fetch;
	globalThis.fetch =
		fetchMock ??
		((async () => new Promise<Response>(() => {})) as unknown as typeof fetch);
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
				act={actFn}
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

describe("provider sign-in actions", () => {
	for (const [active, label] of [
		[true, "Sign out"],
		[false, "Remove"],
	] as const) {
		test(`${label} confirms the matching action and Cancel keeps the sign-in`, async () => {
			const { container, unmount } = await mountPage(undefined, (async (
				input,
			) =>
				String(input) === "/api/provider-login"
					? Response.json({
							signIns: [
								{
									provider: "anthropic",
									kind: "oauth",
									active,
									cause: active ? null : "refresh failed",
									lent: active,
								},
							],
							providers: [{ id: "anthropic", name: "Anthropic" }],
							pending: null,
							error: null,
						})
					: new Promise<Response>(() => {})) as typeof fetch);
			try {
				const action = container.querySelector<HTMLButtonElement>(
					"#signin-section button.danger",
				);
				if (action === null) throw new Error("sign-in action missing");
				expect(action.textContent).toBe(label);
				expect(action.getAttribute("aria-label")).toBe(
					active ? "Sign out of Anthropic" : "Remove sign-in for Anthropic",
				);
				await act(async () => action.click());
				const confirm = document.querySelector(
					"dialog .dialog-actions button.danger",
				);
				const cancel = document.querySelector<HTMLButtonElement>(
					"dialog .dialog-actions button:not(.danger)",
				);
				if (cancel === null) throw new Error("Cancel button missing");
				const confirmedLabel = confirm?.textContent;
				const title = document.querySelector("dialog h2")?.textContent;
				await act(async () => cancel.click());
				await settleDialog();
				expect(confirmedLabel).toBe(label);
				expect(title).toBe(
					active
						? "Sign omp out of Anthropic?"
						: "Remove the expired sign-in for Anthropic?",
				);
				expect(container.querySelector(".providers-row")).not.toBeNull();
				expect(document.querySelector("dialog")).toBeNull();
			} finally {
				await unmount();
			}
		});
	}
});

describe("runner cap stepper", () => {
	test("no cap shows a dash and unlimited; plus starts at 1, minus from 1 goes back", async () => {
		const { container, unmount } = await mountPage();
		try {
			const row = container.querySelector(".cap-row");
			if (row === null) throw new Error("runner cap row missing");
			const field = row.querySelector<HTMLInputElement>("input");
			const fewer = row.querySelector<HTMLButtonElement>(
				'[aria-label="One runner fewer"]',
			);
			const more = row.querySelector<HTMLButtonElement>(
				'[aria-label="One runner more"]',
			);
			if (!field || !fewer || !more) throw new Error("stepper parts missing");
			// No Save: the cap saves on its own, like the checkbox rows.
			expect(row.querySelector("button.settings-save")).toBeNull();
			const unlimited = (): string | null =>
				row.querySelector(".cap-unlimited")?.textContent ?? null;
			expect(field.value).toBe("");
			expect(field.placeholder).toBe("–");
			expect(unlimited()).toBe("unlimited");
			expect(fewer.disabled).toBe(true);

			await act(async () => more.click());
			expect(field.value).toBe("1");
			expect(unlimited()).toBeNull();

			await act(async () => more.click());
			expect(field.value).toBe("2");
			await act(async () => fewer.click());
			await act(async () => fewer.click());
			expect(field.value).toBe("");
			expect(unlimited()).toBe("unlimited");
		} finally {
			await unmount();
		}
	});

	test("a burst of steps sends one save with the last figure, after the wait", async () => {
		const posts: unknown[] = [];
		const { container, unmount } = await mountPage(
			undefined,
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input) === "/api/settings" && init?.method === "POST") {
					posts.push(JSON.parse(String(init.body)));
					return Response.json({});
				}
				return new Promise<Response>(() => {});
			}) as typeof fetch,
			async (fn) => {
				await fn();
				return true;
			},
		);
		try {
			const row = container.querySelector(".cap-row");
			const more = row?.querySelector<HTMLButtonElement>(
				'[aria-label="One runner more"]',
			);
			if (!row || !more) throw new Error("stepper parts missing");
			await act(async () => more.click());
			await act(async () => more.click());
			await act(async () => more.click());
			// Inside the wait nothing is sent yet.
			expect(posts).toEqual([]);
			await act(async () => {
				await Bun.sleep(700);
			});
			expect(posts).toEqual([{ maxTotal: 3 }]);
			// The checkbox rows' tick confirms it beside the name.
			expect(
				row.querySelector('.save-tick svg[aria-label="Saved"]'),
			).not.toBeNull();
		} finally {
			await unmount();
		}
	});
});

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
				expect(pinnedRow(container)).toBe("GitHub");
				expect(
					container.querySelector('[id="git-hosts-section"]'),
				).not.toBeNull();
			} finally {
				await unmount();
				window.location.hash = "";
			}
		},
	);

	test("a sub-block fragment pins its card: the map shows no block rows", async () => {
		window.location.hash = "#github-token-block";
		const { container, unmount } = await mountPage();
		try {
			expect(pinnedRow(container)).toBe("GitHub");
			const rows = [...container.querySelectorAll(".smap-row")].map(
				(r) => r.textContent,
			);
			expect(rows).not.toContain("GitHub token");
			expect(rows).toContain("Git and integrations");
			expect(
				container.querySelector('[id="github-token-block"]'),
			).not.toBeNull();
		} finally {
			await unmount();
			window.location.hash = "";
		}
	});

	test("a popstate to another fragment moves the pin to that row", async () => {
		window.location.hash = "#git-hosts-section";
		const { container, unmount } = await mountPage();
		try {
			expect(pinnedRow(container)).toBe("GitHub");
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
			expect(current).not.toContain("GitHub");
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
		const failed = await mountPage({
			lastRunAt: at - 7 * 86_400_000,
			lastError: { reason: "GitHub answered 502", at },
			running: false,
		});
		try {
			// The failure replaces the last-run time until a scan succeeds.
			expect(failed.container.textContent).toContain(
				`Last scan: Failed: GitHub answered 502 (${stamp(at)})`,
			);
		} finally {
			await failed.unmount();
		}
		const { container, unmount } = await mountPage({
			lastRunAt: at - 7 * 86_400_000,
			lastError: null,
			running: true,
		});
		try {
			expect(container.textContent).toContain("A scan is running");
			const button = Array.from(container.querySelectorAll("button")).find(
				(b) => b.textContent?.trim() === "Scan trending now",
			);
			expect(button?.disabled).toBe(true);
			// The weekly switch is the labelled checkbox of the same row.
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

describe("appChip", () => {
	const check = (over: Partial<AppCheck>): AppCheck => ({
		at: 0,
		name: "ottr",
		url: null,
		repos: ["o/a", "o/b"],
		missing: [],
		private: [],
		failed: [],
		error: null,
		...over,
	});
	const app = (c: AppCheck | null) => ({
		id: "1",
		fingerprint: "SHA256:x",
		check: c,
	});
	test("no app, a pending check, a failed check, gaps and a clean check each get their chip", () => {
		expect(appChip(null)).toEqual({ label: "Not set", tone: "off" });
		expect(appChip(app(null))).toEqual({ label: "Checking", tone: "off" });
		expect(appChip(app(check({ error: "401" })))).toEqual({
			label: "Check failed",
			tone: "warn",
		});
		expect(
			appChip(
				app(
					check({ missing: ["o/a"], failed: [{ repo: "o/b", detail: "500" }] }),
				),
			),
		).toEqual({ label: "Not on 2 repos", tone: "warn" });
		// A private repo without an install gets no outside PRs: not a gap.
		expect(appChip(app(check({ private: ["o/a"] })))).toEqual({
			label: "Working",
			tone: "ok",
		});
	});
});

describe("runCeiling", () => {
	const p = (name: string, maxParallel: number | null) =>
		({ name, settings: { maxParallel } }) as unknown as ProjectView;
	test("the board cap wins while it is the smaller limit", () => {
		expect(runCeiling(4, [p("a", 2), p("b", 3)])).toEqual({
			limit: 4,
			why: "The board cap sets it",
		});
	});
	test("the project caps add up when they are smaller or there is no board cap", () => {
		const two = [p("a", 2), p("b", 3)];
		expect(runCeiling(9, two).limit).toBe(5);
		expect(runCeiling(null, two)).toEqual({
			limit: 5,
			why: "The project caps add up to it",
		});
	});
	test("a project without its own cap leaves only the board cap", () => {
		const open = [p("a", 2), p("b", null)];
		expect(runCeiling(3, open).limit).toBe(3);
		const none = runCeiling(null, open);
		expect(none.limit).toBeNull();
		expect(none.why).toBe("No board cap, and b has no project cap");
		expect(runCeiling(null, []).limit).toBeNull();
	});
});

describe("HindsightSection memory backend", () => {
	test("a mnemopi board with a failing store shows the backend chip and the no-memory warning", async () => {
		const { container, unmount } = await mountHindsight({
			url: null,
			tokenSet: false,
			tokenReadable: true,
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
			tokenReadable: true,
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
			tokenReadable: true,
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
	/** The /api/git-hosts view shape these tests serve; tokens carry no secrets. */
	type GitHostsFixture = {
		tokens: { host: string; username: string; tokenSet: boolean }[];
		globalKey: null;
		githubApp: null;
		githubHost: string;
		githubTokenSet: boolean;
	};

	const view = (githubTokenSet: boolean) => ({
		tokens: [],
		globalKey: null,
		githubApp: null,
		githubHost: "github.com",
		githubTokenSet,
	});

	/** Mock for /api/git-hosts and the GitHub token check; `extra` handles the rest. */
	const baseMock = (
		fixture: GitHostsFixture,
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
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: fixture.githubHost, tokens: [] });
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

	/** A view fixture with named tokens; `view` keeps `[]`. */
	const viewWith = (
		tokens: { host: string; username: string; tokenSet: boolean }[],
		githubTokenSet = true,
		githubHost = "github.com",
	): GitHostsFixture => ({
		tokens,
		globalKey: null,
		githubApp: null,
		githubHost,
		githubTokenSet,
	});

	/** The offer block shows and its text carries `host`: the offer targets that one host. */
	const offerShown = (container: HTMLDivElement, host: string): boolean => {
		const block = container.querySelector(
			"#host-tokens-block .board-token-offer",
		);
		return block !== null && (block.textContent?.includes(host) ?? false);
	};

	test("the offer shows only for a non-github.com host with no stored token", async () => {
		const cases: {
			name: string;
			view: GitHostsFixture;
			host: string;
			shown: boolean;
		}[] = [
			{
				name: "token set, github.com: the board token already serves git there",
				view: viewWith([]),
				host: "github.com",
				shown: false,
			},
			{
				name: "token set, Enterprise host, no entry",
				view: viewWith([], true, "git.acme.ghe.com"),
				host: "git.acme.ghe.com",
				shown: true,
			},
			{
				name: "token set, Enterprise host already has an entry",
				view: viewWith([
					{
						host: "git.acme.ghe.com",
						username: "x-access-token",
						tokenSet: true,
					},
				]),
				host: "git.acme.ghe.com",
				shown: false,
			},
			{
				name: "token set, only another host has an entry",
				view: viewWith(
					[{ host: "gitlab.com", username: "oauth2", tokenSet: true }],
					true,
					"git.acme.ghe.com",
				),
				host: "git.acme.ghe.com",
				shown: true,
			},
			{
				name: "no board token",
				view: viewWith([], false, "git.acme.ghe.com"),
				host: "git.acme.ghe.com",
				shown: false,
			},
		];
		for (const c of cases) {
			const loaded = { calls: 0 };
			const { container, unmount } = await mountSection(
				baseMock(c.view, loaded, () => undefined),
			);
			try {
				expect(`${c.name}: ${offerShown(container, c.host)}`).toBe(
					`${c.name}: ${c.shown}`,
				);
			} finally {
				await unmount();
			}
		}
	});

	test("the offer names the configured GitHub host, not github.com", async () => {
		const loaded = { calls: 0 };
		const { container, unmount } = await mountSection(
			baseMock(viewWith([], true, "git.acme.ghe.com"), loaded, () => undefined),
		);
		try {
			expect(offerShown(container, "git.acme.ghe.com")).toBe(true);
			expect(offerShown(container, "github.com")).toBe(false);
			// The button's label stays free of the host: a 63-label *.ghe.com host
			// in the label cannot wrap and clipped the control off the 320px card.
			// The hint above the button carries the host instead.
			const button = container.querySelector(
				"#host-tokens-block .board-token-offer .alate-def-actions button",
			);
			expect(button?.textContent?.trim()).toBe(
				"Store the board token for this host",
			);
		} finally {
			await unmount();
		}
	});

	test("the offer's click stores the board token for the configured host", async () => {
		const loaded = { calls: 0 };
		const fixture = viewWith([], true, "git.acme.ghe.com");
		const posts: { url: string; body: unknown }[] = [];
		const { container, unmount } = await mountSection(
			baseMock(fixture, loaded, (url, init) => {
				if (
					url.endsWith("/api/git-hosts/github-token") &&
					init?.method === "POST"
				) {
					posts.push({ url, body: JSON.parse(String(init.body)) });
					// The stored entry drops the offer on the reload below.
					fixture.tokens = [
						{
							host: "git.acme.ghe.com",
							username: "x-access-token",
							tokenSet: true,
						},
					];
					return ok(fixture);
				}
				return undefined;
			}),
		);
		try {
			const input = container.querySelector<HTMLInputElement>(
				"#host-tokens-block input[aria-label='Test URL for the board token']",
			);
			if (input === null)
				throw new Error("offer test URL input did not render");
			await act(async () => {
				typeInto(input, "https://git.acme.ghe.com/octo/repo.git");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			const offerForm = container.querySelector<HTMLFormElement>(
				"#host-tokens-block .board-token-offer form",
			);
			if (offerForm === null) throw new Error("offer form did not render");
			await act(async () => {
				offerForm.dispatchEvent(submitEvent());
			});
			// The click went to the reuse endpoint with only the test URL; the
			// server resolves the host itself.
			expect(posts).toEqual([
				{
					url: "/api/git-hosts/github-token",
					body: { testUrl: "https://git.acme.ghe.com/octo/repo.git" },
				},
			]);
			// The reload shows the stored entry and drops the offer.
			expect(
				Array.from(
					container.querySelectorAll("#host-tokens-block td code"),
				).some((c) => c.textContent === "git.acme.ghe.com"),
			).toBe(true);
			expect(
				container.querySelector("#host-tokens-block .board-token-offer"),
			).toBeNull();
		} finally {
			await unmount();
		}
	});

	test("rendering the section never applies the board token on its own", async () => {
		const loaded = { calls: 0 };
		const posts: string[] = [];
		const { container, unmount } = await mountSection(
			baseMock(viewWith([], true, "git.acme.ghe.com"), loaded, (url, init) => {
				if (
					url.endsWith("/api/git-hosts/github-token") &&
					init?.method === "POST"
				) {
					posts.push(url);
					return ok(viewWith([], true, "git.acme.ghe.com"));
				}
				return undefined;
			}),
		);
		try {
			// The qualifying view renders the offer; nothing clicked, nothing stored.
			expect(
				container.querySelector("#host-tokens-block .board-token-offer"),
			).not.toBeNull();
			expect(posts).toEqual([]);
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
	test("a browser subscription the board lost is registered again, then the event switches load", async () => {
		const endpoint = "https://push.example/dev-1";
		const calls: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			calls.push(`${init?.method ?? "GET"} ${u}`);
			if (u === "/api/push/subscribe") return Response.json({ ok: true });
			return Response.json({
				classes: u.includes("endpoint=")
					? { request: true, error: true, complete: false }
					: null,
				mutedProjects: [],
			});
		}) as unknown as typeof fetch;
		// A secure context with a service worker that already holds a subscription.
		const nav = window.navigator as unknown as Record<string, unknown>;
		const win = window as unknown as Record<string, unknown>;
		const sub = {
			endpoint,
			toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
		};
		Object.defineProperty(win, "isSecureContext", {
			value: true,
			configurable: true,
		});
		Object.defineProperty(nav, "serviceWorker", {
			value: {
				getRegistration: async () => ({
					pushManager: { getSubscription: async () => sub },
				}),
			},
			configurable: true,
		});
		win.PushManager = function PushManager() {};
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<NotificationsSection projects={[]} act={async () => true} />,
				);
			});
			for (let k = 0; k < 5; k++)
				await act(async () => {
					await new Promise((r) => setTimeout(r, 0));
				});
			const subscribe = calls.indexOf("POST /api/push/subscribe");
			const prefs = calls.findIndex((c) => c.includes("endpoint="));
			expect(subscribe).toBeGreaterThanOrEqual(0);
			expect(prefs).toBeGreaterThan(subscribe);
			// The event switches render with the device's saved values.
			const labels = [...container.querySelectorAll("label")].map(
				(l) => l.textContent,
			);
			expect(labels).toEqual(["Request", "Error", "Complete"]);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
			delete win.isSecureContext;
			delete nav.serviceWorker;
			delete win.PushManager;
		}
	});

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

/** Stale-sub recovery (ADR-0011): a fake push browser environment, the section's own
 * fetch mock, and a probe of what the section POSTs. */
describe("NotificationsSection stale push recovery", () => {
	/** Installs a secure-context fake browser: an existing subscription on `initialEndpoint`
	 * (unless noInitialSub), a registration whose subscribe() records the applicationServerKey
	 * it got, and a server whose stored rows and board-wide mutes the tests can watch. */
	async function withPushBrowser(
		run: (probe: {
			posts: Array<{ url: string; body: unknown }>;
			prefsReads: Array<{
				endpoint: string | null;
				classes: Record<string, boolean> | null | "unknown";
			}>;
			requestPermissionCalls: () => number;
			containerText: () => string;
			containerNode: () => HTMLDivElement;
			currentSubscription: () => unknown;
			/** Resolves every mute read a deferMuteLoad test holds back. */
			releaseMuteLoad: () => void;
		}) => Promise<void>,
		options: {
			unsubscribeRejects?: boolean;
			/** The first N subscribe POSTs answer 500 (a register, an enable). */
			failSubscribePosts?: number;
			/** The browser subscription's endpoint (default the old fixture endpoint). */
			initialEndpoint?: string;
			/** The old fixture row's classes (the set a queued record carries over). */
			oldRowClasses?: Record<string, boolean>;
			/** The subscribe-POST-failure undo (the new subscription's unsubscribe) rejects. */
			undoRejects?: boolean;
			/** Mounts with no browser subscription, for the enable flow. */
			noInitialSub?: boolean;
			/** Seeds the pending-subscribe localStorage record before mount. */
			seedPending?: unknown;
			/** The server's board-wide muted projects (default ["alpha"]). */
			mutedProjects?: string[];
			/** Holds every no-endpoint prefs GET until releaseMuteLoad runs. */
			deferMuteLoad?: boolean;
			/** The first N no-endpoint prefs GETs answer 500 (failed mute loads). */
			failMuteLoads?: number;
		} = {},
	): Promise<void> {
		const realFetch = globalThis.fetch;
		const realNavigator = globalThis.navigator;
		const realNotification = globalThis.Notification;
		// The test env's Window type lacks the DOM property; a real window always has it.
		const realSecureContext: boolean | undefined = Reflect.get(
			window,
			"isSecureContext",
		);
		const subscribedKeys: string[] = [];
		const posts: Array<{ url: string; body: unknown }> = [];
		// Every prefs GET, in order: endpoint = the query's endpoint or null,
		// classes = the row's classes or "unknown" when the answer is the 404
		// branch. Recorded at response-build time, so a test can assert what a
		// read really saw.
		const prefsReads: Array<{
			endpoint: string | null;
			classes: Record<string, boolean> | null | "unknown";
		}> = [];
		let subscribePosts = 0;
		let permissionCalls = 0;
		let bareMuteReads = 0;
		// Resolvers of mute reads a deferMuteLoad test holds back: the board
		// answered at request time, the network delivers on release.
		const heldMuteLoads: Array<() => void> = [];
		const initialEndpoint =
			options.initialEndpoint ?? "https://push.example.com/old";
		// The server's board-wide muted projects. The no-endpoint and any
		// known-endpoint prefs GET return them; the 404 branch returns no mutes.
		const muted = [...(options.mutedProjects ?? ["alpha"])];
		// The server's stored rows, endpoint → classes. The mock answers prefs GETs
		// from this map, so a test sees exactly what a real server would hold. Only
		// the old fixture row exists; a fresh or queued endpoint has none until the
		// subscribe POST creates it (its prefs GET 404s until then).
		const ALL_ON = { request: true, error: true, complete: true };
		const rows = new Map<string, Record<string, boolean>>([
			[
				"https://push.example.com/old",
				options.oldRowClasses ?? {
					request: true,
					error: false,
					complete: true,
				},
			],
		]);
		let currentSub: {
			endpoint: string;
			toJSON: () => unknown;
			unsubscribe: () => Promise<void>;
		} | null = options.noInitialSub
			? null
			: {
					endpoint: initialEndpoint,
					toJSON: () => ({
						endpoint: initialEndpoint,
						keys: { p256dh: "p", auth: "a" },
					}),
					unsubscribe: async () => {
						if (options.unsubscribeRejects)
							throw new Error("unsubscribe failed");
						currentSub = null;
					},
				};
		const registration = {
			pushManager: {
				getSubscription: async () => currentSub,
				subscribe: async (opts: { applicationServerKey: string }) => {
					subscribedKeys.push(opts.applicationServerKey);

					currentSub = {
						endpoint: initialEndpoint,
						toJSON: () => ({ endpoint: initialEndpoint }),
						// The POST-failure undo must leave no browser subscription.
						unsubscribe: async () => {
							if (options.undoRejects) throw new Error("undo failed");
							currentSub = null;
						},
					};
					return currentSub;
				},
			},
		};
		const fakeNavigator = {
			...realNavigator,
			serviceWorker: {
				getRegistration: async () => registration,
				ready: Promise.resolve(registration),
				register: async () => registration,
			},
		} as unknown as Navigator;
		const fetchMock = (async (url: string | URL, init?: RequestInit) => {
			const target = String(url);
			if (init?.method === "POST") {
				posts.push({ url: target, body: JSON.parse(String(init.body)) });
				// Server truth for the mute save: the board-wide list is replaced.
				if (target === "/api/notifications/prefs") {
					const body = JSON.parse(String(init.body)) as {
						mutedProjects?: string[];
					};
					if (body.mutedProjects !== undefined)
						muted.splice(0, muted.length, ...body.mutedProjects);
				}
				if (target === "/api/push/subscribe") {
					subscribePosts++;
					if (
						options.failSubscribePosts !== undefined &&
						subscribePosts <= options.failSubscribePosts
					)
						return Response.json({ error: "boom" }, { status: 500 });
					// Server truth: carried classes create the row with them; without
					// classes a new endpoint starts all-on, a known one keeps its classes.
					const body = JSON.parse(String(init.body)) as {
						endpoint: string;
						classes?: Record<string, boolean>;
					};
					rows.set(
						body.endpoint,
						body.classes ?? rows.get(body.endpoint) ?? ALL_ON,
					);
				}
				return Response.json({ ok: true });
			}
			if (target.startsWith("/api/notifications/prefs")) {
				const endpoint = new URL(
					target,
					"https://push.example",
				).searchParams.get("endpoint");
				if (endpoint === null) {
					bareMuteReads++;
					if (bareMuteReads <= (options.failMuteLoads ?? 0))
						return Response.json({ error: "boom" }, { status: 500 });
					// The snapshot is the list the board served at request time; the
					// deferral is transport delay, not a later server answer.
					const snapshot = muted.slice();
					if (options.deferMuteLoad) {
						const { promise, resolve } = Promise.withResolvers<void>();
						heldMuteLoads.push(resolve);
						await promise;
					}
					prefsReads.push({ endpoint: null, classes: null });
					return Response.json({ classes: null, mutedProjects: snapshot });
				}
				const row = rows.get(endpoint);
				if (row === undefined) {
					prefsReads.push({ endpoint, classes: "unknown" });
					return Response.json({ error: "unknown endpoint" }, { status: 404 });
				}
				prefsReads.push({ endpoint, classes: row });
				return Response.json({ classes: row, mutedProjects: muted });
			}
			return Response.json({ classes: null, mutedProjects: [] });
		}) as unknown as typeof fetch;
		Object.defineProperty(globalThis, "navigator", {
			value: fakeNavigator,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(globalThis, "Notification", {
			value: {
				permission: "granted",
				requestPermission: async () => {
					permissionCalls++;
					return "granted";
				},
			},
			writable: true,
			configurable: true,
		});
		Object.defineProperty(globalThis.window, "isSecureContext", {
			value: true,
			configurable: true,
		});
		Object.defineProperty(globalThis.window, "PushManager", {
			value: function PushManager() {},
			configurable: true,
		});
		globalThis.fetch = fetchMock;
		const projects = ["alpha", "beta"].map(
			(name) =>
				({
					name,
					icon: null,
					settings: { displayName: null, iconText: null },
				}) as unknown as ProjectView,
		);
		// The pending-subscribe key mirrors the section's constant. The component
		// reads bare localStorage, so the stub lives on globalThis.
		const PENDING_KEY = "ottr.push.pendingSubscribe";
		const realStorage = globalThis.localStorage;
		const storageData = new Map<string, string>();
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: (k: string) => storageData.get(k) ?? null,
				setItem: (k: string, v: string) => void storageData.set(k, v),
				removeItem: (k: string) => void storageData.delete(k),
			},
			writable: true,
			configurable: true,
		});
		if (options.seedPending !== undefined)
			globalThis.localStorage.setItem(
				PENDING_KEY,
				JSON.stringify(options.seedPending),
			);
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<NotificationsSection
						projects={projects}
						act={async (fn: () => Promise<unknown>) => {
							// The app act catches a failed save and reports false; the
							// stub mirrors that contract so a refused write rolls back.
							try {
								await fn();
							} catch {
								return false;
							}
							return true;
						}}
					/>,
				);
			});
			for (let k = 0; k < 5; k++)
				await act(async () => {
					await new Promise((r) => setTimeout(r, 0));
				});
			await run({
				posts,
				prefsReads,
				requestPermissionCalls: () => permissionCalls,
				containerText: () => container.textContent ?? "",
				containerNode: () => container,
				currentSubscription: () => currentSub,
				releaseMuteLoad: () => {
					for (const resolve of heldMuteLoads.splice(0)) resolve();
				},
			});
		} finally {
			globalThis.localStorage.removeItem(PENDING_KEY);
			Object.defineProperty(globalThis, "localStorage", {
				value: realStorage,
				writable: true,
				configurable: true,
			});
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
			Object.defineProperty(globalThis, "navigator", {
				value: realNavigator,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(globalThis, "Notification", {
				value: realNotification,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(globalThis.window, "isSecureContext", {
				value: realSecureContext,
				configurable: true,
			});
			Reflect.deleteProperty(globalThis.window, "PushManager");
		}
	}

	/** The three event switches of a mounted section, by their label's text. */
	function switchOf(
		container: HTMLDivElement,
		name: string,
	): HTMLInputElement | undefined {
		return [...container.querySelectorAll("input[type=checkbox]")].find(
			(box) => {
				const text =
					box.id !== ""
						? (container.querySelector(`label[for="${box.id}"]`)?.textContent ??
							box.closest("label")?.textContent)
						: box.closest("label")?.textContent;
				return (text ?? "").includes(name);
			},
		) as HTMLInputElement | undefined;
	}

	test("a browser subscription registers on load and the switches read the saved classes", async () => {
		await withPushBrowser(async (probe) => {
			// The register POST precedes the prefs read: the row exists, so the
			// switches render the device's saved classes (not the all-on default).
			expect(probe.posts.map((p) => p.url)).toEqual(["/api/push/subscribe"]);
			expect(probe.prefsReads.filter((r) => r.endpoint !== null)).toEqual([
				{
					endpoint: "https://push.example.com/old",
					classes: { request: true, error: false, complete: true },
				},
			]);
			const node = probe.containerNode();
			expect(switchOf(node, "Request")?.checked).toBe(true);
			expect(switchOf(node, "Error")?.checked).toBe(false);
			expect(switchOf(node, "Complete")?.checked).toBe(true);
			expect(probe.containerText()).toContain("Turn off");
			expect(probe.requestPermissionCalls()).toBe(0);
		});
	});

	test("a register failure reports the unknown endpoint and never invents mutes", async () => {
		await withPushBrowser(
			async (probe) => {
				// The register POST failed: the endpoint has no row. The prefs read
				// 404s, no mute POST can fire (the switches are hidden), and the
				// section reports the unknown endpoint instead of showing switches
				// built on a fabricated empty mute list.
				expect(probe.prefsReads.filter((r) => r.endpoint !== null)).toEqual([
					{ endpoint: "https://push.example.com/ghost", classes: "unknown" },
				]);
				expect(probe.containerText()).toContain("unknown endpoint");
				expect(probe.containerText()).toContain("Turn off");
				expect(
					probe.posts.filter((p) => p.url === "/api/notifications/prefs"),
				).toEqual([]);
				// The mute toggle still works from the board-wide list: a change
				// posts the whole known list, never a fabricated empty one.
				const node = probe.containerNode();
				const beta = switchOf(node, "Mute beta");
				expect(beta).toBeDefined();
				// React's own onChange prop, fired like the other mute tests.
				await act(async () => {
					onChangeOf(beta!)({ target: { checked: true } });
				});
				for (let k = 0; k < 5; k++)
					await act(async () => {
						await new Promise((r) => setTimeout(r, 0));
					});
				const mutePost = probe.posts.find(
					(p) =>
						p.url === "/api/notifications/prefs" &&
						(p.body as { mutedProjects?: string[] }).mutedProjects !==
							undefined,
				);
				expect(mutePost).toBeDefined();
				expect(
					(mutePost!.body as { mutedProjects: string[] }).mutedProjects.sort(),
				).toEqual(["alpha", "beta"]);
			},
			{
				initialEndpoint: "https://push.example.com/ghost",
				failSubscribePosts: 1,
			},
		);
	});

	test("a kept Turn on queue stays quiet on the 404 and never writes mutes", async () => {
		await withPushBrowser(
			async (probe) => {
				// Turn on failed (POST 500) and the undo was refused: the completion
				// is queued. The queued record explains the missing row: no "unknown
				// endpoint" error, no mute write, the switches hidden until the
				// replay lands.
				const on = [...probe.containerNode().querySelectorAll("button")].find(
					(b) => b.textContent?.trim() === "Turn on",
				);
				expect(on).toBeDefined();
				await act(async () => {
					on?.click();
				});
				await act(async () => {});
				expect(probe.containerText()).not.toContain("unknown endpoint");
				expect(
					probe.posts.filter((p) => p.url === "/api/notifications/prefs"),
				).toEqual([]);
				expect(probe.containerText()).toContain("Turn off");
				expect(
					globalThis.localStorage.getItem("ottr.push.pendingSubscribe"),
				).not.toBeNull();
			},
			{
				noInitialSub: true,
				failSubscribePosts: 1,
				undoRejects: true,
				initialEndpoint: "https://push.example.com/pending",
			},
		);
	});

	test("a queued record folds the carried classes into the register on the next load", async () => {
		const classes = { request: true, error: false, complete: true };
		await withPushBrowser(
			async (probe) => {
				// The queued classes ride inside the register body: one atomic call
				// creates the row with them, the old row drops, the record clears,
				// and the FIRST prefs read already sees the carried set. Removing
				// the fold makes this read all-on and fails the assertions.
				expect(probe.posts.map((p) => p.url)).toEqual([
					"/api/push/subscribe",
					"/api/push/unsubscribe",
				]);
				expect(probe.posts[0]?.body).toEqual({
					endpoint: "https://push.example.com/new",
					keys: { p256dh: "p", auth: "a" },
					classes,
				});
				expect(probe.posts[1]?.body).toEqual({
					endpoint: "https://push.example.com/old",
				});
				expect(
					globalThis.localStorage.getItem("ottr.push.pendingSubscribe"),
				).toBeNull();
				expect(probe.prefsReads.filter((r) => r.endpoint !== null)).toEqual([
					{
						endpoint: "https://push.example.com/new",
						classes,
					},
				]);
				const node = probe.containerNode();
				expect(switchOf(node, "Request")?.checked).toBe(true);
				expect(switchOf(node, "Error")?.checked).toBe(false);
				expect(switchOf(node, "Complete")?.checked).toBe(true);
			},
			{
				initialEndpoint: "https://push.example.com/new",
				seedPending: {
					subscription: { endpoint: "https://push.example.com/new" },
					oldEndpoint: "https://push.example.com/old",
					classes,
				},
			},
		);
	});

	test("a failed register with a queued record keeps both for the next load", async () => {
		await withPushBrowser(
			async (probe) => {
				// The register POST failed: the browser keeps the subscription, the
				// record stays, no old-row drop fires, and the 404 stays quiet.
				expect(probe.containerText()).not.toContain("unknown endpoint");
				expect(probe.posts.some((p) => p.url === "/api/push/unsubscribe")).toBe(
					false,
				);
				expect(
					globalThis.localStorage.getItem("ottr.push.pendingSubscribe"),
				).not.toBeNull();
			},
			{
				initialEndpoint: "https://push.example.com/new",
				failSubscribePosts: 1,
				seedPending: {
					subscription: { endpoint: "https://push.example.com/new" },
					oldEndpoint: "https://push.example.com/old",
					classes: { request: true, error: false, complete: true },
				},
			},
		);
	});

	test("a kept Turn on with a rejecting undo queues the completion and reports the pending registration", async () => {
		await withPushBrowser(
			async (probe) => {
				// The enable POST failed and the undo was refused: the browser keeps
				// the live subscription and the whole completion is queued.
				const on = [...probe.containerNode().querySelectorAll("button")].find(
					(b) => b.textContent?.trim() === "Turn on",
				);
				expect(on).toBeDefined();
				await act(async () => {
					on?.click();
				});
				await act(async () => {});
				expect(probe.currentSubscription()).not.toBeNull();
				expect(probe.containerText()).toContain("boom");
				expect(probe.containerText()).toContain("Turn off");
				expect(
					JSON.parse(
						globalThis.localStorage.getItem("ottr.push.pendingSubscribe") ??
							"null",
					),
				).toEqual({
					subscription: { endpoint: "https://push.example.com/old" },
					oldEndpoint: null,
					classes: null,
				});
			},
			{
				noInitialSub: true,
				failSubscribePosts: 1,
				undoRejects: true,
			},
		);
	});

	test("a deferred mute load lands across the kept-enable endpoint change", async () => {
		await withPushBrowser(
			async (probe) => {
				// The board-wide mute read is still in flight when the kept Turn on
				// moves the endpoint. A change made while the list is unknown must
				// write nothing, the answer must land anyway (the mutes load never
				// rides the endpoint effect), and the next save must carry the
				// whole list: when the response died with the endpoint effect,
				// mutedRef stayed empty and a save wiped the board-wide list the
				// other devices hold.
				const on = [...probe.containerNode().querySelectorAll("button")].find(
					(b) => b.textContent?.trim() === "Turn on",
				);
				expect(on).toBeDefined();
				await act(async () => {
					on?.click();
				});
				await act(async () => {});
				// The kept path ran while the mute read was held back.
				expect(
					globalThis.localStorage.getItem("ottr.push.pendingSubscribe"),
				).not.toBeNull();
				// Unknown list: a change now must write nothing. An empty mutedRef
				// is a guess, and the server replaces the whole board-wide list
				// with whatever a mute POST carries.
				const held = switchOf(probe.containerNode(), "Mute beta");
				expect(held?.disabled).toBe(true);
				await act(async () => {
					onChangeOf(held!)({ target: { checked: true } });
				});
				await act(async () => {});
				expect(
					probe.posts.filter((p) => p.url === "/api/notifications/prefs"),
				).toEqual([]);
				await act(async () => {
					probe.releaseMuteLoad();
				});
				const node = probe.containerNode();
				expect(switchOf(node, "Mute alpha")?.checked).toBe(true);
				expect(switchOf(node, "Mute beta")?.checked).toBe(false);
				const beta = switchOf(node, "Mute beta");
				expect(beta).toBeDefined();
				await act(async () => {
					onChangeOf(beta!)({ target: { checked: true } });
				});
				for (let k = 0; k < 5; k++)
					await act(async () => {
						await new Promise((r) => setTimeout(r, 0));
					});
				const mutePost = probe.posts.find(
					(p) =>
						p.url === "/api/notifications/prefs" &&
						(p.body as { mutedProjects?: string[] }).mutedProjects !==
							undefined,
				);
				expect(mutePost).toBeDefined();
				expect(
					(mutePost!.body as { mutedProjects: string[] }).mutedProjects.sort(),
				).toEqual(["alpha", "beta"]);
			},
			{
				noInitialSub: true,
				failSubscribePosts: 1,
				undoRejects: true,
				initialEndpoint: "https://push.example.com/pending",
				deferMuteLoad: true,
			},
		);
	});

	test("a failed mute load keeps the switches off until Retry succeeds", async () => {
		await withPushBrowser(
			async (probe) => {
				// The board-wide mute load failed: the list stays unknown, the
				// boxes stay disabled, and no change can replace the shared list
				// with a partial guess. Retry is manual only; when the retried
				// load answers, the switches unlock with the real list.
				const node = probe.containerNode();
				const beta = switchOf(node, "Mute beta");
				expect(beta?.disabled).toBe(true);
				await act(async () => {
					onChangeOf(beta!)({ target: { checked: true } });
				});
				await act(async () => {});
				expect(
					probe.posts.filter((p) => p.url === "/api/notifications/prefs"),
				).toEqual([]);
				// WCAG 4.1.3: the failure is error feedback, so the hint renders in
				// a status region screen readers announce.
				const hint = node.querySelector('p[role="status"]');
				expect(hint?.textContent ?? "").toContain("could not be loaded");
				const retry = [...node.querySelectorAll("button")].find(
					(b) => b.textContent?.trim() === "Retry",
				);
				expect(retry).toBeDefined();
				await act(async () => {
					retry?.click();
				});
				for (let k = 0; k < 5; k++)
					await act(async () => {
						await new Promise((r) => setTimeout(r, 0));
					});
				const after = probe.containerNode();
				expect(after.textContent ?? "").not.toContain("could not be loaded");
				expect(switchOf(after, "Mute beta")?.disabled).toBe(false);
				expect(switchOf(after, "Mute alpha")?.checked).toBe(true);
				const unlocked = switchOf(after, "Mute beta");
				expect(unlocked).toBeDefined();
				await act(async () => {
					onChangeOf(unlocked!)({ target: { checked: true } });
				});
				for (let k = 0; k < 5; k++)
					await act(async () => {
						await new Promise((r) => setTimeout(r, 0));
					});
				const mutePost = probe.posts.find(
					(p) =>
						p.url === "/api/notifications/prefs" &&
						(p.body as { mutedProjects?: string[] }).mutedProjects !==
							undefined,
				);
				expect(mutePost).toBeDefined();
				expect(
					(mutePost!.body as { mutedProjects: string[] }).mutedProjects.sort(),
				).toEqual(["alpha", "beta"]);
			},
			{ failMuteLoads: 2 },
		);
	});
});
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

describe("ModelRolesSection missing check roles", () => {
	test("Add critic adds the role and drops only its own button", async () => {
		resetCatalogCache();
		const { container, unmount } = await mountRoles(
			rolesFetch({ default: "zai/glm-5.3-flash" }),
		);
		try {
			await act(async () => {});
			const buttons = (): string[] =>
				[...container.querySelectorAll(".role-warn-actions button")].map(
					(b) => b.textContent ?? "",
				);
			expect(buttons()).toEqual(["Add critic", "Add adversary"]);
			const critic = container.querySelector<HTMLButtonElement>(
				".role-warn-actions button",
			);
			if (critic === null) throw new Error("Add critic did not render");
			const field =
				container.querySelector<HTMLInputElement>(".role-add input");
			if (field === null) throw new Error("role field did not render");
			await act(async () => onChangeOf(field)({ target: { value: "draft" } }));
			await act(async () => critic.click());
			expect(
				[...container.querySelectorAll(".role-row .role-name")].map(
					(n) => n.textContent,
				),
			).toEqual(["default", "critic"]);
			expect(buttons()).toEqual(["Add adversary"]);
			expect(container.querySelector(".role-warn b")?.textContent).toBe(
				"No adversary role",
			);
			// A typed draft survives: the button adds its own name, not the field's.
			expect(field.value).toBe("draft");
		} finally {
			await unmount();
		}
	});

	test("the missing-role warning shows only while a check role is unset", async () => {
		// Both check roles set: no warning.
		resetCatalogCache();
		const full = await mountRoles(
			rolesFetch({
				critic: "anthropic/claude-opus-5-5",
				adversary: "zai/glm-5.3-flash",
			}),
		);
		try {
			await act(async () => {});
			expect(full.container.querySelector(".role-warn")).toBeNull();
		} finally {
			await full.unmount();
		}
		// critic unset while adversary is set: the warning names only critic.
		resetCatalogCache();
		const half = await mountRoles(
			rolesFetch({ adversary: "zai/glm-5.3-flash" }),
		);
		try {
			await act(async () => {});
			expect(half.container.querySelector(".role-warn b")?.textContent).toBe(
				"No critic role",
			);
		} finally {
			await half.unmount();
		}
	});
});

describe("ModelRolesSection model picker", () => {
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

describe("ModelRolesSection save source", () => {
	/** The picker fixture's GET with alate's data-source fields merged in, and an
	 *  optional POST /api/model-roles answer. */
	const sourceFetch = (
		source: { repo: unknown; path: unknown; ro: unknown },
		post?: () => Response,
	): typeof fetch => {
		const read = rolesFetch({ plan: "zai/glm-5.3-flash" });
		return (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "POST" && url.endsWith("/api/model-roles")) {
				if (post === undefined)
					return new Response(
						JSON.stringify({ error: "unexpected model roles save" }),
						{ status: 500, headers: { "Content-Type": "application/json" } },
					);
				return post();
			}
			if (url.endsWith("/api/alate/provision"))
				return new Response(JSON.stringify({ ok: true, results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			const res = await read(input, init);
			if (url.endsWith("/api/model-roles")) {
				const body = (await res.json()) as Record<string, unknown>;
				return new Response(JSON.stringify({ ...body, ...source }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return res;
		}) as typeof fetch;
	};
	/** Adds a fallback entry, the smallest edit that arms Save. */
	const armDirty = async (container: HTMLDivElement): Promise<void> => {
		const add = container.querySelector<HTMLButtonElement>(
			"button.fallback-add",
		);
		if (add === null) throw new Error("Add fallback did not render");
		await act(async () => {
			onClickOf(add)({});
		});
	};
	const saveButton = (container: HTMLDivElement): HTMLButtonElement => {
		const save = container.querySelector<HTMLButtonElement>(
			".alate-def-actions button",
		);
		if (save === null) throw new Error("Save button did not render");
		return save;
	};

	test("a learned read-only verdict locks Save before any edit", async () => {
		// Both causes lock: a read-only mount (EROFS/EACCES) and a plain
		// unversioned folder (commit ""). Each hint must name the file and the
		// Alate steps, so the acceptance holds for either verdict.
		for (const cause of ["mount", "plain"] as const) {
			resetCatalogCache();
			const { container, unmount } = await mountRoles(
				sourceFetch({
					repo: null,
					path: "/data",
					ro: { path: "/data", cause },
				}),
			);
			try {
				await act(async () => {});
				// No edit yet: the verdict a refused save left locks the section
				// on its own, so the user never clicks into the refused write again.
				const save = saveButton(container);
				expect(save.disabled).toBe(true);
				const input =
					container.querySelector<HTMLInputElement>(".role-add input");
				expect(input?.disabled).toBe(true);

				// The note names the cause and the fix, and the button points at
				// it for screen readers.
				const hintId = save.getAttribute("aria-describedby");
				const hint = [...container.querySelectorAll("p")].find(
					(p) => p.id === hintId,
				);
				if (hint === null || hint === undefined)
					throw new Error(`read-only hint did not render (${cause})`);
				expect(hint.tagName).toBe("P");
				expect(hint.textContent).toContain("user/omp/agent/config.yml");
				expect(hint.textContent).toContain("Import now");
				expect(hint.textContent).toContain("Provision now");
				if (cause === "mount")
					expect(hint.textContent).toContain(
						"The data folder is mounted read-only into Alate.",
					);
				else
					expect(hint.textContent).toContain(
						"Alate's data folder is not a git repo",
					);
				// The card hint states the fact, not the save flow.
				expect(container.textContent).toContain(
					"Alate serves the data folder, so the board cannot save roles",
				);
				expect(container.textContent).not.toContain(
					"through Alate's file editor",
				);
			} finally {
				await unmount();
			}
		}
	});

	test("a folder source without a refused save keeps Save working", async () => {
		resetCatalogCache();
		const NEW = "d".repeat(40);
		const { container, unmount } = await mountRoles(
			sourceFetch(
				{ repo: null, path: "/data", ro: null },
				() =>
					// The git-folder success: alate's PUT answers a local commit.
					new Response(
						JSON.stringify({
							commit: NEW,
							base: null,
							hash: "h2",
							roles: { plan: "anthropic/claude-opus-5-5" },
							fallbacks: { plan: ["openai/gpt-5"] },
							seed: {
								needed: false,
								commit: null,
								roles: null,
								fallbacks: null,
								expiresAt: null,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);
		try {
			await act(async () => {});
			// A folder alone does not lock anything: alate commits a git folder
			// itself, and the board cannot tell git-ness without alate saying it.
			await armDirty(container);
			const save = saveButton(container);
			expect(save.disabled).toBe(false);

			// The save lands and the steps line reports the local commit.
			await act(async () => {
				onClickOf(save)({});
			});
			for (let i = 0; i < 3; i++)
				await act(async () => {
					await Bun.sleep(0);
				});
			expect(container.textContent).toContain(
				`Committed ${NEW.slice(0, 7)} to the data repo.`,
			);
		} finally {
			await unmount();
		}
	});

	test("a repo source keeps Save working as today", async () => {
		resetCatalogCache();
		const NEW = "c".repeat(40);
		const { container, unmount } = await mountRoles(
			sourceFetch(
				{ repo: { name: "o/data", ref: "main" }, path: null, ro: null },
				() =>
					new Response(
						JSON.stringify({
							commit: NEW,
							base: NEW,
							hash: "h2",
							roles: { plan: "anthropic/claude-opus-5-5" },
							fallbacks: { plan: ["openai/gpt-5"] },
							seed: {
								needed: false,
								commit: null,
								roles: null,
								fallbacks: null,
								expiresAt: null,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);
		try {
			await act(async () => {});
			await armDirty(container);
			const save = saveButton(container);
			expect(save.disabled).toBe(false);

			// The save commits and the steps line reports it, like any repo save.
			await act(async () => {
				onClickOf(save)({});
			});
			for (let i = 0; i < 3; i++)
				await act(async () => {
					await Bun.sleep(0);
				});
			expect(container.textContent).toContain(
				`Committed ${NEW.slice(0, 7)} to the data repo.`,
			);
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

/** The fetch behavior an Alate section test configures. */
type AlateMockHandlers = {
	config?: {
		url: string | null;
		keySet: boolean;
		keyReadable?: boolean;
		lastProvisionError?: string | null;
	};
	// A Response is handed out on every fetch; a factory builds a fresh one per call
	// and can count the calls it serves.
	keyGet?: Response | (() => Response);
	keyPost?: Response | (() => Response);
	// The body POST /api/alate/provision answers with, or a factory for one.
	provisionPost?:
		| {
				ok: boolean;
				running?: boolean;
				results?: ProvisionResult[];
		  }
		| (() => Response);
};

/** Every JSON body the Alate tests' fetch mock answers with: a 200 application/json Response. */
const okJson = (body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

/** The POST /api/settings/alate-key answer: the key handler's Response (a factory builds
    a fresh one per call), or the default 200 when the test configures none. */
function alateKeyResponse(
	handlers: AlateMockHandlers,
	init?: RequestInit,
): Response {
	if (init?.method === "POST") {
		const h = handlers.keyPost;
		return typeof h === "function" ? h() : (h ?? okJson({}));
	}
	const h = handlers.keyGet;
	return typeof h === "function" ? h() : (h ?? okJson({ apiKey: null }));
}

/** The POST /api/alate/provision answer: the configured body as a Response, a factory's
    fresh Response, or the thrown unexpected-fetch error when the test configures none. */
function alateProvisionResponse(
	handlers: AlateMockHandlers,
	url: string,
): Response {
	const h = handlers.provisionPost;
	if (h === undefined) throw new Error(`unexpected fetch POST ${url}`);
	return typeof h === "function" ? h() : okJson(h);
}

function alateFetchMock(handlers: AlateMockHandlers): typeof fetch {
	return (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url = String(input);
		if (url.endsWith("/api/alate") && init?.method === undefined)
			return okJson({
				url: null,
				keySet: false,
				keyReadable: true,
				lastProvisionError: null,
				...handlers.config,
			});
		if (url.endsWith("/api/alate/health")) throw new Error("no server");
		if (url.endsWith("/api/alate/provision") && init?.method === "POST")
			return alateProvisionResponse(handlers, url);
		if (url.endsWith("/api/settings/alate-key"))
			return alateKeyResponse(handlers, init);
		throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
	}) as typeof fetch;
}

describe("ModelRolesSection failed load recovery", () => {
	/** The healthy roles fetch, but the first `fail` GET /api/model-roles answers
	 *  alate's slow-provision 504; `reads()` counts the model-roles reads so a
	 *  test can prove a retry ran without parsing the error line. */
	const failingFirst = (
		fail: number,
	): { fetchMock: typeof fetch; reads: () => number } => {
		let calls = 0;
		const healthy = rolesFetch({ default: "zai/glm-5.3-flash" });
		const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/model-roles")) {
				calls++;
				if (calls <= fail)
					return new Response(
						JSON.stringify({
							error: "alate did not answer /api/file within 10 s",
						}),
						{ status: 504, headers: { "Content-Type": "application/json" } },
					);
			}
			return healthy(input, init);
		}) as typeof fetch;
		return { fetchMock, reads: () => calls };
	};

	test("Retry loads the rows and clears the error", async () => {
		resetCatalogCache();
		const { fetchMock, reads } = failingFirst(1);
		const { container, unmount } = await mountRoles(fetchMock);
		try {
			// The first load failed: the error line and the Retry button show,
			// and no rows render behind them.
			expect(container.textContent).toContain(
				"alate did not answer /api/file within 10 s",
			);
			const retry = [...container.querySelectorAll("button")].find(
				(b) => b.textContent?.trim() === "Retry",
			);
			expect(retry).toBeDefined();
			expect(container.querySelector(".role-add")).toBeNull();
			await act(async () => {
				retry!.click();
			});
			// The retried load answered: rows render and the error line is gone.
			expect(container.textContent).not.toContain(
				"Cannot load the model roles",
			);
			expect(container.querySelector(".role-add")).not.toBeNull();
			expect(container.textContent).toContain("zai/glm-5.3-flash");
			expect(reads()).toBe(2);
		} finally {
			await unmount();
		}
	});

	test("a failed load reads again by itself after 30 s", async () => {
		resetCatalogCache();
		jest.useFakeTimers();
		const { fetchMock, reads } = failingFirst(1);
		const { container, unmount } = await mountRoles(fetchMock);
		try {
			expect(container.textContent).toContain("Cannot load the model roles");
			expect(reads()).toBe(1);
			// Nothing automatic before the interval fires.
			await act(async () => {
				jest.advanceTimersByTime(29_999);
			});
			expect(reads()).toBe(1);
			await act(async () => {
				jest.advanceTimersByTime(1);
			});
			// The automatic retry answered: rows render without a click.
			expect(reads()).toBe(2);
			expect(container.textContent).not.toContain(
				"Cannot load the model roles",
			);
			expect(container.querySelector(".role-add")).not.toBeNull();
		} finally {
			await unmount();
			jest.useRealTimers();
		}
	});
});

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
			await settleDialog();
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
			await settleDialog();
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
			await settleDialog();
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
				rules: ["lang-typescript.md"],
				mcp: ["chrome-devtools", "context-mode"],
			}),
		);
		try {
			// Required entries are missing, so the counts ride the grey box, not a hint line.
			const box = container.querySelector(".layer-note.calm");
			expect(box?.textContent).toContain(
				"2 skills, 1 plugin, MCP servers: chrome-devtools, context-mode",
			);
			expect(container.textContent).not.toContain("User layer is empty");
		} finally {
			await unmount();
		}
	});

	test("an empty layer shows the callout with the sync hint", async () => {
		const { container, unmount } = await mountAlate(
			fetchMockFor({ skills: [], plugins: [], rules: [], mcp: [] }),
		);
		try {
			expect(container.textContent).toContain("User layer is empty");
			expect(container.textContent).toContain("sync-user.mjs --data");
			expect(container.textContent).not.toContain("User layer: ");
			const callout = container.querySelector(".layer-note");
			expect(callout).not.toBeNull();
			expect(callout?.getAttribute("role")).toBe("status");
		} finally {
			await unmount();
		}
	});

	test("a layer that holds every prompt-required entry renders no missing line", async () => {
		const { container, unmount } = await mountAlate(
			fetchMockFor({
				skills: [
					"security-audit",
					"codebase-design",
					"ponytail",
					"ui-ux-check",
					"diff-security-review",
					"explain-project",
					"check-ottr-board",
					"retro",
				],
				plugins: [],
				rules: ["codeguard-1-crypto-algorithms.md"],
				mcp: [],
			}),
		);
		try {
			expect(container.textContent).toContain("User layer: 8 skills");
			expect(container.textContent).not.toContain("Missing on workers");
		} finally {
			await unmount();
		}
	});

	test("a partial layer renders one grey box: the counts, then the missing names as chips", async () => {
		const { container, unmount } = await mountAlate(
			fetchMockFor({
				skills: ["ui-ux-check"],
				plugins: [],
				rules: [],
				mcp: [],
			}),
		);
		try {
			const box = container.querySelector(".layer-note");
			if (box === null) throw new Error("layer note missing");
			expect(box.classList.contains("calm")).toBe(true);
			expect(box.getAttribute("role")).toBe("status");
			expect(box.textContent).toContain("1 skill, 0 plugins");
			expect(
				[...box.querySelectorAll(".layer-chips code")].map(
					(c) => c.textContent,
				),
			).toEqual([
				"security-audit",
				"codeguard",
				"codebase-design",
				"ponytail-audit",
				"diff-security-review",
				"explain-project",
				"check-ottr-board",
				"retro",
			]);
			// One layout: no separate missing line beside the box.
			expect(container.querySelector(".notif-line")).toBeNull();
		} finally {
			await unmount();
		}
	});

	test("the line helpers pluralize counts and treat MCP-only layers as empty", () => {
		expect(
			userLayerLine({ skills: ["a"], plugins: [], rules: [], mcp: [] }),
		).toBe("User layer: 1 skill, 0 plugins, MCP servers: none");
		expect(
			userLayerEmpty({ skills: [], plugins: [], rules: [], mcp: ["x"] }),
		).toBe(true);
		expect(
			userLayerEmpty({ skills: ["a"], plugins: [], rules: [], mcp: [] }),
		).toBe(false);
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
					trendingScan={false}
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

	test("a failed Identity save marks the fields and shows the reason under them", async () => {
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
					trendingScan={false}
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
			// The audited acceptance: every field of the failed card save shows the
			// reason under it (Error-Says-Fix Rule), so the card carries one alert
			// per field.
			const card = container.querySelector("#project-identity-section");
			const errors = card?.querySelectorAll(".auth-error") ?? [];
			expect(errors.length).toBe(2);
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
			expect(prefixInput.getAttribute("aria-invalid")).toBe("true");
			const prefixDescribedBy = prefixInput.getAttribute("aria-describedby");
			expect(prefixDescribedBy).not.toBeNull();
			const prefixMessage = [
				...container.querySelectorAll(`p[role="alert"]`),
			].find((p) => p.id === prefixDescribedBy);
			expect(prefixMessage).not.toBeNull();
			expect(prefixMessage?.className).toContain("auth-error");
			expect(prefixMessage?.textContent).toBe("settings locked");
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
			root.render(
				<GitHostsSection commitIdentity={null} act={async () => true} />,
			);
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
						trendingScan={false}
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
					trendingScan={false}
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
			await settleDialog();
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});
});

describe("shortProvisionLines", () => {
	test("the example sync output keeps only the updated line and the left-in-place note", () => {
		const output = [
			"updated  coding-guideline.md",
			"40 unchanged, 0 deleted in /root/.omp/agent/rules",
			"Not from the data repo, left in place: demo-rules.md, example-rule.md",
		].join("\n");
		expect(shortProvisionLines(output)).toEqual([
			"updated  coding-guideline.md",
			"Not from the data repo, left in place: demo-rules.md, example-rule.md",
		]);
	});
	test("an all-unchanged run filters to nothing", () => {
		const output = [
			"Scanning 0 of 74 skill snapshot(s) (74 cached) with SkillSpector abc at /bin (--no-llm, static only, shipped baselines applied)...",
			"0 installed, 478 unchanged, 0 deleted in /root",
			"bun install v1.4.2 (a651cf31)",
			"Resolving dependencies",
			"Checked 301 installs across 321 packages (no changes)",
		].join("\n");
		expect(shortProvisionLines(output)).toEqual([]);
	});
	test("a line the filter does not understand stays visible", () => {
		expect(
			shortProvisionLines("Something unforeseen happened\n0 unchanged"),
		).toEqual(["Something unforeseen happened"]);
	});
	test("a count line with a non-zero change count stays visible", () => {
		expect(
			shortProvisionLines("3 added, 1 updated, 5 unchanged from /root"),
		).toEqual(["3 added, 1 updated, 5 unchanged from /root"]);
	});
	test("a changed bun install keeps its package lines", () => {
		const output =
			"bun install v1.4.2 (a651cf31)\n+ typescript@5.6.3\n1 packages installed [104.00ms]";
		expect(shortProvisionLines(output)).toEqual([
			"+ typescript@5.6.3",
			"1 packages installed [104.00ms]",
		]);
	});
	test("a scan warning is not mistaken for the scan banner", () => {
		expect(
			shortProvisionLines(
				"/root/.cache is malformed; scanning every skill snapshot.",
			),
		).toEqual(["/root/.cache is malformed; scanning every skill snapshot."]);
	});
});

describe("provisionChangeSummary", () => {
	test("counts the example run as one update", () => {
		expect(
			provisionChangeSummary([
				{
					script: "sync.mjs",
					code: 0,
					truncated: false,
					output:
						"updated  coding-guideline.md\n40 unchanged, 0 deleted in /root/.omp/agent/rules",
				},
			]),
		).toBe("1 updated");
	});
	test("an all-unchanged run reports no total", () => {
		expect(
			provisionChangeSummary([
				{
					script: "install-user.mjs",
					code: 0,
					truncated: false,
					output:
						"0 installed, 478 unchanged, 0 deleted in /root\nChecked 301 installs across 321 packages (no changes)",
				},
			]),
		).toBeNull();
	});
	test("a failed script contributes no total", () => {
		expect(
			provisionChangeSummary([
				{
					script: "sync-user.mjs",
					code: 1,
					truncated: false,
					output: "updated  user/x.md",
				},
			]),
		).toBeNull();
	});
	test("bun's plus lines and summary line do not double count", () => {
		expect(
			provisionChangeSummary([
				{
					script: "install-user.mjs",
					code: 0,
					truncated: false,
					output:
						"bun install v1.4.2 (a651cf31)\n+ typescript@5.6.3\n+ left-pad@1.3.0\n2 packages installed [104.00ms]",
				},
			]),
		).toBe("2 installed");
	});
	test("bun plus lines count alone when no summary line follows", () => {
		expect(
			provisionChangeSummary([
				{
					script: "install-user.mjs",
					code: 0,
					truncated: false,
					output: "+ typescript@5.6.3",
				},
			]),
		).toBe("1 installed");
	});
});

describe("AlateSection provision result", () => {
	const syncChanged: ProvisionResult = {
		script: "sync.mjs",
		code: 0,
		truncated: false,
		output: [
			"updated  coding-guideline.md",
			"40 unchanged, 0 deleted in /root/.omp/agent/rules",
			"Not from the data repo, left in place: demo-rules.md, example-rule.md",
		].join("\n"),
	};
	const installQuiet: ProvisionResult = {
		script: "install-user.mjs",
		code: 0,
		truncated: false,
		output: [
			"Scanning 0 of 74 skill snapshot(s) (74 cached) with SkillSpector abc at /bin (--no-llm, static only, shipped baselines applied)...",
			"0 installed, 478 unchanged, 0 deleted in /root",
			"bun install v1.4.2 (a651cf31)",
			"Resolving dependencies",
			"Checked 301 installs across 321 packages (no changes)",
		].join("\n"),
	};
	const syncUserFailed: ProvisionResult = {
		script: "sync-user.mjs",
		code: 1,
		truncated: false,
		output: [
			"Nothing synced. Fix:",
			"  key refused",
			"0 added, 0 updated, 3 unchanged from /root",
		].join("\n"),
	};

	test("a finished run shows only changes, a quiet script as one line, and the raw log behind the toggle", async () => {
		const { container, unmount } = await mountAlate(
			alateFetchMock({
				config: { url: "http://127.0.0.1:4570", keySet: true },
				provisionPost: {
					ok: true,
					results: [syncChanged, installQuiet],
				},
			}),
		);
		try {
			const button = Array.from(container.querySelectorAll("button")).find(
				(b) => b.textContent?.trim() === "Provision",
			);
			if (button === undefined)
				throw new Error("Provision button did not render");
			await act(async () => {
				button.click();
			});
			const text = container.textContent ?? "";
			// The status keeps its wording and adds the short total.
			expect(text).toContain("Provisioned 2 scripts successfully. 1 updated.");
			// The changed script shows its change and warning lines, not the quiet counts.
			expect(text).toContain("sync.mjs — exit 0");
			expect(text).toContain("updated  coding-guideline.md");
			expect(text).toContain(
				"Not from the data repo, left in place: demo-rules.md, example-rule.md",
			);
			const shortPres = Array.from(container.querySelectorAll("pre.log")).map(
				(p) => p.textContent ?? "",
			);
			expect(shortPres).toContain(
				"updated  coding-guideline.md\nNot from the data repo, left in place: demo-rules.md, example-rule.md",
			);
			// The quiet script collapses to one line.
			expect(text).toContain("install-user.mjs: no changes");
			// Both successful scripts carry the disclosure, closed by default, with the
			// raw log inside.
			const details = Array.from(
				container.querySelectorAll("details.prov-log"),
			) as HTMLDetailsElement[];
			expect(details.length).toBe(2);
			for (const d of details) {
				expect(d.open).toBe(false);
				expect(d.querySelector("summary")?.textContent).toBe("Show full log");
			}
			const raws = Array.from(details).map(
				(d) => d.querySelector("pre.log")?.textContent ?? "",
			);
			expect(raws.some((t) => t.includes("40 unchanged, 0 deleted"))).toBe(
				true,
			);
			expect(raws.some((t) => t.includes("Resolving dependencies"))).toBe(true);
			// Expanding the disclosure shows the raw text as before.
			const first = details[0]!;
			await act(async () => {
				first.querySelector("summary")?.click();
			});
			expect(first.open).toBe(true);
		} finally {
			await unmount();
		}
	});

	test("a failed script shows its full raw output open with no toggle", async () => {
		const { container, unmount } = await mountAlate(
			alateFetchMock({
				config: { url: "http://127.0.0.1:4570", keySet: true },
				provisionPost: {
					ok: false,
					results: [syncChanged, syncUserFailed],
				},
			}),
		);
		try {
			const button = Array.from(container.querySelectorAll("button")).find(
				(b) => b.textContent?.trim() === "Provision",
			);
			if (button === undefined)
				throw new Error("Provision button did not render");
			await act(async () => {
				button.click();
			});
			const text = container.textContent ?? "";
			expect(text).toContain(
				"Provisioning failed: 1 of 2 scripts exited non-zero.",
			);
			expect(text).toContain("sync-user.mjs — exit 1");
			// The raw output, unfiltered: even a quiet count line stays visible.
			expect(text).toContain("Nothing synced. Fix:");
			expect(text).toContain("0 added, 0 updated, 3 unchanged from /root");
			// The failure carries no disclosure; the successful script still does.
			const details = container.querySelectorAll("details.prov-log");
			expect(details.length).toBe(1);
			const pres = Array.from(container.querySelectorAll("pre.log")).map(
				(p) => p.textContent ?? "",
			);
			expect(pres).toContain(
				"Nothing synced. Fix:\n  key refused\n0 added, 0 updated, 3 unchanged from /root",
			);
		} finally {
			await unmount();
		}
	});
});

// The "Read-only GitHub token for turns" block: the check's verdict drives the status
// line, a write row waits for an explicit confirm, an error row for a re-check, and
// hosted mode hides the block with its card (docs/specs/turn-read-token.md).
describe("GitHostsSection turn GitHub token", () => {
	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	const gitHostsView = {
		tokens: [],
		globalKey: null,
		githubApp: null,
		githubHost: "acme.ghe.com",
	};
	/** A stored row for the configured host; tests override the verdict fields. */
	const row = (over: Record<string, unknown>): unknown => ({
		host: "acme.ghe.com",
		tokenSet: true,
		tokenReadable: true,
		status: "ok",
		detail: "read-only on every project repository",
		confirmed: false,
		...over,
	});
	/** Mock for the section's loads; `turn` serves the GET, every POST body lands in
	 *  `posts`, and `answer` returns the row a POST answers with. */
	const baseMock = (
		turn: unknown,
		posts: { url: string; body: unknown }[],
		answer?: () => unknown,
	): typeof fetch =>
		(async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET")
				return ok(gitHostsView);
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (url.includes("/api/settings/turn-github-token")) {
				if ((init?.method ?? "GET") === "GET") return ok(turn);
				posts.push({
					url: url.replace(/^.*\/api/, "/api"),
					body: JSON.parse(String(init?.body)),
				});
				return ok(answer?.() ?? {});
			}
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
	/** Lets the turn block's requests land: one act per pending microtask lane. */
	const settle = async (): Promise<void> => {
		for (let k = 0; k < 5; k++)
			await act(async () => {
				await Bun.sleep(0);
			});
	};

	test("an ok row says turns can use the token", async () => {
		const { container, unmount } = await mountSection(
			baseMock({ host: "acme.ghe.com", tokens: [row({})] }, []),
		);
		try {
			const block = container.querySelector("#turn-github-token-block");
			if (block === null) throw new Error("turn token block missing");
			expect(block.textContent).toContain("Turns can use this token");
			// The configured host and github.com render; no token value ever shows.
			expect(block.querySelectorAll("input[type='password']").length).toBe(2);
			expect(
				block.querySelector(
					"input[aria-label='Read-only GitHub token for acme.ghe.com']",
				),
			).not.toBeNull();
			expect(
				block.querySelector(
					"input[aria-label='Read-only GitHub token for github.com']",
				),
			).not.toBeNull();
			expect(block.textContent).not.toContain("Use anyway");
			expect(block.textContent).not.toContain("Check again");
		} finally {
			await unmount();
		}
	});

	test("a write row warns and waits for Use anyway, which confirms it", async () => {
		const posts: { url: string; body: unknown }[] = [];
		const { container, unmount } = await mountSection(
			baseMock(
				{
					host: "acme.ghe.com",
					tokens: [
						row({ status: "write", detail: "token can push to octo/repo" }),
					],
				},
				posts,
				() =>
					row({
						status: "write",
						detail: "token can push to octo/repo",
						confirmed: true,
					}),
			),
		);
		try {
			const block = container.querySelector("#turn-github-token-block");
			if (block === null) throw new Error("turn token block missing");
			expect(block.textContent).toContain("token can push to octo/repo");
			const useAnyway = [...block.querySelectorAll("button")].find(
				(b) => b.textContent === "Use anyway",
			);
			if (useAnyway === undefined) throw new Error("Use anyway button missing");
			await act(async () => {
				useAnyway.click();
			});
			await settle();
			expect(posts).toEqual([
				{
					url: "/api/settings/turn-github-token/confirm",
					body: { host: "acme.ghe.com" },
				},
			]);
			// Confirmed: the row reads as in use and the button goes.
			expect(block.textContent).toContain("· in use");
			expect(
				[...block.querySelectorAll("button")].some(
					(b) => b.textContent === "Use anyway",
				),
			).toBe(false);
		} finally {
			await unmount();
		}
	});

	test("an error row shows the detail and Check again, which re-checks", async () => {
		const posts: { url: string; body: unknown }[] = [];
		const { container, unmount } = await mountSection(
			baseMock(
				{
					host: "acme.ghe.com",
					tokens: [
						row({ status: "error", detail: "GitHub rejected the token" }),
					],
				},
				posts,
				() => row({ detail: "" }),
			),
		);
		try {
			const block = container.querySelector("#turn-github-token-block");
			if (block === null) throw new Error("turn token block missing");
			expect(block.textContent).toContain("GitHub rejected the token");
			const checkAgain = [...block.querySelectorAll("button")].find(
				(b) => b.textContent === "Check again",
			);
			if (checkAgain === undefined)
				throw new Error("Check again button missing");
			await act(async () => {
				checkAgain.click();
			});
			await settle();
			expect(posts).toEqual([
				{
					url: "/api/settings/turn-github-token/recheck",
					body: { host: "acme.ghe.com" },
				},
			]);
			// The re-check passed: the row reads as usable and the old detail is gone.
			expect(block.textContent).toContain("Turns can use this token");
			expect(block.textContent).not.toContain("GitHub rejected the token");
		} finally {
			await unmount();
		}
	});

	test("an unreadable row asks for the token again", async () => {
		const { container, unmount } = await mountSection(
			baseMock(
				{ host: "acme.ghe.com", tokens: [row({ tokenReadable: false })] },
				[],
			),
		);
		try {
			const block = container.querySelector("#turn-github-token-block");
			if (block === null) throw new Error("turn token block missing");
			expect(block.textContent).toContain("Unreadable — enter it again");
			expect(block.textContent).not.toContain("Turns can use this token");
			expect(block.textContent).not.toContain("Use anyway");
			expect(block.textContent).not.toContain("Check again");
		} finally {
			await unmount();
		}
	});

	test("Save posts host and token, shows the checked row and clears the input", async () => {
		const posts: { url: string; body: unknown }[] = [];
		const { container, unmount } = await mountSection(
			baseMock({ host: "acme.ghe.com", tokens: [] }, posts, () => row({})),
		);
		try {
			const input = container.querySelector<HTMLInputElement>(
				"input[aria-label='Read-only GitHub token for acme.ghe.com']",
			);
			const form = input?.closest("form");
			if (
				input === null ||
				input === undefined ||
				form === null ||
				form === undefined
			)
				throw new Error("turn token row did not render");
			await act(async () => {
				typeInto(input, "tok-read-1");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			await settle();
			expect(posts).toEqual([
				{
					url: "/api/settings/turn-github-token",
					body: { host: "acme.ghe.com", token: "tok-read-1" },
				},
			]);
			const block = container.querySelector("#turn-github-token-block");
			if (block === null) throw new Error("turn token block missing");
			expect(block.textContent).toContain("Turns can use this token");
			// The pasted token never comes back and the input is clear.
			expect(block.textContent).not.toContain("tok-read-1");
			expect(input.value).toBe("");
		} finally {
			await unmount();
		}
	});

	test("a github.com host renders one row", async () => {
		const { container, unmount } = await mountSection(
			baseMock(
				{ host: "github.com", tokens: [row({ host: "github.com" })] },
				[],
			),
		);
		try {
			const block = container.querySelector("#turn-github-token-block");
			if (block === null) throw new Error("turn token block missing");
			// github.com is the configured host: no second row joins it.
			expect(block.querySelectorAll("input[type='password']").length).toBe(1);
			expect(
				block.querySelector(
					"input[aria-label='Read-only GitHub token for github.com']",
				),
			).not.toBeNull();
		} finally {
			await unmount();
		}
	});

	test("hosted mode hides the block with its card", () => {
		expect(hostedHidden(false, "turn-github-token-block")).toBe(false);
		expect(hostedHidden(true, "turn-github-token-block")).toBe(true);
		// The block is on the general TOC under the GitHub card.
		const blocks =
			SETTINGS_TOC.find((g) => g.id === "git-group")?.sections.find(
				(s) => s.id === "git-hosts-section",
			)?.blocks ?? [];
		expect(blocks.map((b) => b.label)).toContain("Turn GitHub token");
		// The hosted TOC drops the whole GitHub card, so the block goes with it.
		expect(
			pageToc(true, true).some((g) =>
				g.sections.some((s) =>
					(s.blocks ?? []).some((b) => b.id === "turn-github-token-block"),
				),
			),
		).toBe(false);
	});
});

// OTTR-806: every stored-secret surface says "Token unreadable, enter it again"
// when the server reports the stored value as unreadable, and stays quiet when
// it is readable. The wording mirrors the Jira connections' warn chip.
describe("Unreadable stored secrets", () => {
	const MSG = "Token unreadable, enter it again";
	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

	test("GitHub token form shows the message when set and unreadable", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET")
				return ok({
					tokens: [],
					globalKey: null,
					githubApp: null,
					githubHost: "github.com",
					githubTokenSet: true,
				});
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: true, tokenReadable: false, expiresAt: null });
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: "github.com", tokens: [] });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountSection(fetchMock);
		try {
			expect(container.textContent).toContain(MSG);
		} finally {
			await unmount();
		}
	});

	test("GitHub token form stays quiet when the token is readable", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET")
				return ok({
					tokens: [],
					globalKey: null,
					githubApp: null,
					githubHost: "github.com",
					githubTokenSet: true,
				});
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: true, tokenReadable: true, expiresAt: null });
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: "github.com", tokens: [] });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountSection(fetchMock);
		try {
			expect(container.textContent).not.toContain(MSG);
		} finally {
			await unmount();
		}
	});

	test("an unreadable git-host token row shows the message per row", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET")
				return ok({
					tokens: [
						{
							host: "git.corp",
							username: "bot",
							tokenSet: true,
							tokenReadable: false,
						},
					],
					globalKey: null,
					githubApp: null,
					githubHost: "github.com",
					githubTokenSet: true,
				});
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: "github.com", tokens: [] });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountSection(fetchMock);
		try {
			expect(container.textContent).toContain(MSG);
		} finally {
			await unmount();
		}
	});

	test("a readable git-host token row shows no message", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET")
				return ok({
					tokens: [
						{
							host: "git.corp",
							username: "bot",
							tokenSet: true,
							tokenReadable: true,
						},
					],
					globalKey: null,
					githubApp: null,
					githubHost: "github.com",
					githubTokenSet: true,
				});
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: "github.com", tokens: [] });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountSection(fetchMock);
		try {
			expect(container.textContent).not.toContain(MSG);
		} finally {
			await unmount();
		}
	});

	test("a GitHub App with an unreadable key shows the message and tolerates a null fingerprint", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET")
				return ok({
					tokens: [],
					globalKey: null,
					githubApp: {
						id: "123456",
						fingerprint: null,
						check: null,
						keyReadable: false,
					},
					githubHost: "github.com",
					githubTokenSet: true,
				});
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: "github.com", tokens: [] });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountSection(fetchMock);
		try {
			const app = container.querySelector("#github-app-block");
			expect(app?.textContent).toContain(MSG);
		} finally {
			await unmount();
		}
	});

	test("a GitHub App with a readable key shows the fingerprint and no message", async () => {
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET")
				return ok({
					tokens: [],
					globalKey: null,
					githubApp: {
						id: "123456",
						fingerprint: "SHA256:abc",
						check: null,
						keyReadable: true,
					},
					githubHost: "github.com",
					githubTokenSet: true,
				});
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (url.endsWith("/api/settings/turn-github-token"))
				return ok({ host: "github.com", tokens: [] });
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountSection(fetchMock);
		try {
			const app = container.querySelector("#github-app-block");
			expect(app?.textContent).toContain("SHA256:abc");
			expect(app?.textContent).not.toContain(MSG);
		} finally {
			await unmount();
		}
	});

	test("Hindsight key shows the message when set and unreadable", async () => {
		const { container, unmount } = await mountHindsight({
			url: "http://hindsight.local",
			tokenSet: true,
			tokenReadable: false,
			backend: "hindsight",
			memoryReason: null,
		});
		try {
			expect(container.textContent).toContain(MSG);
		} finally {
			await unmount();
		}
	});

	test("Hindsight key stays quiet when readable", async () => {
		const { container, unmount } = await mountHindsight({
			url: "http://hindsight.local",
			tokenSet: true,
			tokenReadable: true,
			backend: "hindsight",
			memoryReason: null,
		});
		try {
			expect(container.textContent).not.toContain(MSG);
		} finally {
			await unmount();
		}
	});

	test("Alate stored key hides reveal and copy and shows the message when unreadable", async () => {
		const { container, unmount } = await mountAlate(
			alateFetchMock({
				config: { url: "http://alate.local", keySet: true, keyReadable: false },
			}),
		);
		try {
			expect(container.textContent).toContain(MSG);
			expect(
				container.querySelector('button[aria-label="Reveal Alate API key"]'),
			).toBeNull();
			expect(
				container.querySelector('button[aria-label="Copy Alate API key"]'),
			).toBeNull();
		} finally {
			await unmount();
		}
	});

	test("Alate stored key keeps the reveal control when readable", async () => {
		const { container, unmount } = await mountAlate(
			alateFetchMock({
				config: { url: "http://alate.local", keySet: true, keyReadable: true },
			}),
		);
		try {
			expect(container.textContent).not.toContain(MSG);
			expect(
				container.querySelector('button[aria-label="Reveal Alate API key"]'),
			).not.toBeNull();
		} finally {
			await unmount();
		}
	});

	test("an unreadable env value shows the message", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> =>
			ok({
				names: [
					{ name: "FOO_TOKEN", projects: ["_all"], set: true, readable: false },
				],
			})) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(<EnvSection />);
		});
		try {
			expect(container.textContent).toContain(MSG);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("a readable env value shows no message", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> =>
			ok({
				names: [
					{ name: "FOO_TOKEN", projects: ["_all"], set: true, readable: true },
				],
			})) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(<EnvSection />);
		});
		try {
			expect(container.textContent).not.toContain(MSG);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("the env table leads with missing values, hides set secrets behind Replace, and shows plain values", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> =>
			ok({
				names: [
					{
						name: "API_TOKEN",
						projects: ["_all"],
						plain: false,
						set: true,
						readable: true,
					},
					{
						name: "MQTT_HOST",
						projects: ["p1"],
						plain: true,
						set: true,
						readable: true,
						value: "mqtt.home.example",
					},
					{
						name: "NEW_KEY",
						projects: ["p1"],
						plain: false,
						set: false,
						readable: false,
					},
				],
			})) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(<EnvSection />);
		});
		try {
			const rows = [...container.querySelectorAll(".env-table tbody tr")];
			// The missing value leads; set rows keep env.txt order after it.
			expect(rows.map((r) => r.querySelector("code")?.textContent)).toEqual([
				"NEW_KEY",
				"API_TOKEN",
				"MQTT_HOST",
			]);
			const state = (r: Element) => r.querySelector(".env-state");
			expect(state(rows[0] as Element)?.textContent).toBe("Missing");
			expect(
				state(rows[0] as Element)?.querySelector(".mark-needs"),
			).not.toBeNull();
			expect(state(rows[1] as Element)?.textContent).toBe("Set");
			// A set secret shows no field until Replace; its value never renders.
			expect(rows[1]?.querySelector("input")).toBeNull();
			expect(
				rows[1]?.querySelector('button[aria-label="Replace API_TOKEN"]'),
			).not.toBeNull();
			// The plain row shows its stored value in a text field, with its tag.
			const plain = rows[2]?.querySelector("input");
			expect(plain?.getAttribute("type")).toBe("text");
			expect(plain?.value).toBe("mqtt.home.example");
			expect(rows[2]?.querySelector(".env-kind")?.textContent).toBe("plain");
			// The missing secret gets a password field.
			expect(rows[0]?.querySelector("input")?.getAttribute("type")).toBe(
				"password",
			);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});
});

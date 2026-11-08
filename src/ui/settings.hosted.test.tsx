import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView, StateResponse } from "../types.ts";
import type { TocGroup } from "./settings.tsx";

// Hosted mode, docs/specs/hosted-mode.md section 7: the UI hides the host-level surfaces.
// Storage must exist before the imports: app.tsx reads sessionStorage at module load. The
// DOM globals register after the imports, so app.tsx does not auto-render <App/> (same split
// as app-open.test.tsx).
const window = new Window({ url: "http://localhost/" });
const host = globalThis as unknown as Record<string, unknown>;
host.sessionStorage = window.sessionStorage;
host.localStorage = window.localStorage;

const { App, Overview, WarningLines } = await import("./app.tsx");
const { HostedContext, hostedHidden, pageToc, SETTINGS_TOC, SettingsPage } =
	await import("./settings.tsx");
const { LOGOUT_KEY } = await import("./kit.tsx");

const browserGlobals: Record<string, unknown> = {
	window,
	document: window.document,
	navigator: window.navigator,
	location: window.location,
	history: window.history,
	HTMLElement: window.HTMLElement,
	HTMLDialogElement: window.HTMLDialogElement,
	HTMLInputElement: window.HTMLInputElement,
	HTMLTextAreaElement: window.HTMLTextAreaElement,
	Node: window.Node,
	getComputedStyle: window.getComputedStyle,
	requestAnimationFrame: window.requestAnimationFrame,
	cancelAnimationFrame: window.cancelAnimationFrame,
	CSS: (window as unknown as Record<string, unknown>).CSS,
};
const originals = new Map<string, unknown>();

beforeAll(() => {
	host.IS_REACT_ACT_ENVIRONMENT = true;
	for (const [key, value] of Object.entries(browserGlobals)) {
		originals.set(key, host[key]);
		host[key] = value;
	}
	originals.set("fetch", host.fetch);
	// happy-dom implements no popover attribute yet; the menus call hidePopover().
	const proto = window.HTMLElement.prototype as unknown as Record<
		string,
		unknown
	>;
	proto.showPopover ??= () => {};
	proto.hidePopover ??= () => {};
});

afterAll(() => {
	delete host.IS_REACT_ACT_ENVIRONMENT;
	delete host.sessionStorage;
	delete host.localStorage;
	for (const [key, value] of originals) {
		if (value === undefined) delete host[key];
		else host[key] = value;
	}
});

// --- fixtures ---------------------------------------------------------------

/** Every card and block that hosted mode hides, by TOC id (spec section 7). */
const HIDDEN = [
	"runners-section",
	"projects-section",
	"api-key-section",
	"session-section",
	"omp-stats-section",
	"git-hosts-section",
	"github-host-block",
	"github-token-block",
	"github-app-block",
	"host-tokens-block",
	"ssh-key-block",
	"signin-section",
	"model-roles-section",
	"alate-section",
	"hindsight-section",
	"project-updates-section",
];

type Toc = readonly TocGroup[];

/** Every TOC target of a page: group, card, block. */
const tocTargets = (toc: Toc): string[] =>
	toc.flatMap((g) => [
		g.id,
		...g.sections.flatMap((s) => [s.id, ...(s.blocks ?? []).map((b) => b.id)]),
	]);

/** The TOC as group → card → block ids, for whole-tree comparisons. */
const tree = (toc: Toc) =>
	toc.map((g) => ({
		group: g.id,
		cards: g.sections.map((s) =>
			s.blocks === undefined
				? s.id
				: { card: s.id, blocks: s.blocks.map((b) => b.id) },
		),
	}));

const project = (): ProjectView =>
	({
		name: "proj",
		icon: null,
		remote: null,
		path: "/tmp/proj",
		github: "octo/repo",
		vmRunner: { configured: false, ok: false, reason: "not set" },
		hasRules: true,
		gitless: false,
		archReview: null,
		latestRelease: null,
		latestImage: null,
		taskPrefix: "PROJ",
		settings: {
			holdUpdateMerges: false,
			retroSince: null,
			retroFilter: false,
			forkResearch: false,
			trendingScout: false,
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

const page = (view: string, hosted?: boolean) => (
	<SettingsPage
		projects={[project()]}
		tasks={[]}
		maxTotal={null}
		reviewCheck={false}
		workCheck={false}
		idleReviews={false}
		trendingScan={true}
		trendingStatus={{ lastRunAt: null, lastError: null, running: false }}
		act={async () => true}
		view={view}
		openTask={() => {}}
		hosted={hosted}
	/>
);

/** The labels of the desktop TOC rows, in order. */
const tocLabels = (html: string): string[] => {
	const nav =
		html.match(/<nav[^>]*class="[^"]*settings-nav[\s\S]*?<\/nav>/)?.[0] ?? "";
	return [...nav.matchAll(/class="smap-row"[^>]*>([^<]*)<\/button>/g)].map(
		(m) => m[1] ?? "",
	);
};

const labelsOf = (toc: Toc): string[] =>
	toc.flatMap((g) => [
		g.label,
		...g.sections.flatMap((s) => [
			s.label,
			...(s.blocks ?? []).map((b) => b.label),
		]),
	]);

// --- settings TOC -----------------------------------------------------------

describe("hosted settings TOC", () => {
	test("flag off: both pages keep today's full TOC", () => {
		expect(pageToc(true, false)).toBe(SETTINGS_TOC);
		expect(tree(pageToc(false, false))).toEqual([
			{
				group: "project-group",
				cards: ["project-icon-section", "project-identity-section"],
			},
			{
				group: "project-work-group",
				cards: [
					"project-runners-section",
					"project-worktrees-section",
					"project-messages-section",
				],
			},
			{
				group: "project-reviews-group",
				cards: [
					"project-releases-section",
					"project-reviews-section",
					"project-updates-section",
				],
			},
			{ group: "project-git-group", cards: ["project-ssh-section"] },
			{ group: "project-danger-group", cards: ["project-remove-section"] },
		]);
		for (const id of HIDDEN) expect(hostedHidden(false, id)).toBe(false);
	});

	test("hosted: the general page keeps only the tenant cards, and empty groups go", () => {
		expect(tree(pageToc(true, true))).toEqual([
			{ group: "board-group", cards: ["notifications-section"] },
			{ group: "git-group", cards: ["env-section"] },
		]);
	});

	test("hosted: the project page drops only the Updates card", () => {
		const full = tocTargets(pageToc(false, false));
		expect(tocTargets(pageToc(false, true))).toEqual(
			full.filter((id) => id !== "project-updates-section"),
		);
	});

	test("hosted: no hidden id stays in a TOC, and no group is left empty", () => {
		for (const general of [true, false]) {
			const toc = pageToc(general, true);
			for (const id of HIDDEN) expect(tocTargets(toc)).not.toContain(id);
			for (const g of toc) expect(g.sections.length).toBeGreaterThan(0);
		}
		for (const id of HIDDEN) expect(hostedHidden(true, id)).toBe(true);
	});
});

// --- settings render --------------------------------------------------------

describe("hosted settings page render", () => {
	test("hosted: the general page renders no hidden card and a TOC without dangling rows", () => {
		const html = renderToStaticMarkup(page("settings", true));
		for (const id of HIDDEN) expect(html).not.toContain(`id="${id}"`);
		const toc = pageToc(true, true);
		for (const id of tocTargets(toc)) expect(html).toContain(`id="${id}"`);
		expect(tocLabels(html)).toEqual(labelsOf(toc));
		for (const label of [
			"Provider sign-in",
			"API key",
			"Global SSH key",
			"Git hosts",
			"Other host tokens",
			"Model roles",
			"omp usage",
			"Access",
			"Agents",
		])
			expect(tocLabels(html)).not.toContain(label);
	});

	test("hosted: every rendered settings group holds at least one TOC card", () => {
		const html = renderToStaticMarkup(page("settings", true));
		const cards = pageToc(true, true).flatMap((g) =>
			g.sections.map((s) => s.id),
		);
		const groups = html.split('<section class="settings-group"').slice(1);
		expect(groups.length).toBe(pageToc(true, true).length);
		for (const g of groups)
			expect(cards.some((id) => g.includes(`id="${id}"`))).toBe(true);
		for (const id of ["access-group", "agents-group"])
			expect(html).not.toContain(`id="${id}"`);
	});

	test("hosted: a server warning keeps no link to a hidden card", () => {
		const warning =
			"No active sign-in: sign in under Settings - Provider sign-in, or check the key under Settings - Git hosts. Docs: https://example.com/hosted.";
		const hosted = renderToStaticMarkup(
			<HostedContext.Provider value={true}>
				<WarningLines warnings={[warning]} />
			</HostedContext.Provider>,
		);
		expect(hosted).not.toContain("#signin-section");
		expect(hosted).toContain("sign in under Settings - Provider sign-in, or");
		expect(hosted).not.toContain("#git-hosts-section");
		expect(hosted).toContain("check the key under Settings - Git hosts.");
		// Links that open no settings card stay.
		expect(hosted).toContain('href="https://example.com/hosted"');
		const off = renderToStaticMarkup(<WarningLines warnings={[warning]} />);
		expect(off).toContain('href="/settings#signin-section"');
		expect(off).toContain('href="/settings#git-hosts-section"');
	});

	test("flag off: the general page renders every TOC target and today's TOC", () => {
		for (const hosted of [undefined, false]) {
			const html = renderToStaticMarkup(page("settings", hosted));
			for (const id of tocTargets(SETTINGS_TOC))
				expect(html).toContain(`id="${id}"`);
			expect(tocLabels(html)).toEqual(labelsOf(SETTINGS_TOC));
		}
	});

	test("the project page hides the Updates card only in hosted mode", () => {
		const hosted = renderToStaticMarkup(page("settings/proj", true));
		expect(hosted).not.toContain('id="project-updates-section"');
		expect(hosted).toContain('id="project-releases-section"');
		expect(hosted).toContain('id="project-reviews-section"');
		const off = renderToStaticMarkup(page("settings/proj"));
		expect(off).toContain('id="project-updates-section"');
	});

	test("hosted: a deep link to a hidden card opens the page without a pin", async () => {
		const realFetch = host.fetch;
		// The sections' loads never answer, so the page stays idle and deterministic.
		host.fetch = async () => new Promise<Response>(() => {});
		window.location.hash = "#runners-section";
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(page("settings", true));
			});
			expect(container.querySelector('[id="runners-section"]')).toBeNull();
			expect(container.querySelector("h1")?.textContent).toBe("Settings");
			const pinned = [
				...container.querySelectorAll('.smap-row[aria-current="location"]'),
			].map((r) => r.textContent);
			expect(pinned).not.toContain("Runners");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			window.location.hash = "";
			host.fetch = realFetch;
		}
	});
});

// --- app shell --------------------------------------------------------------

const boardState = (hosted: boolean): StateResponse =>
	({
		projects: [
			{
				...project(),
				sessionsDir: "/tmp/proj/.tasks/sessions",
				target: "origin/main",
				dirty: false,
				// The board's advisory points at Settings → Git hosts → GitHub host.
				githubHostNotice: "acme.ghe.com",
			},
		],
		tasks: [],
		maxTotal: null,
		reviewCheck: false,
		workCheck: false,
		idleReviews: false,
		trendingScan: true,
		trendingStatus: { lastRunAt: null, lastError: null, running: false },
		serverVersion: "vtest",
		quota: null,
		onboarding: false,
		user: "alice",
		seenAnswers: [],
		seenDoneSince: 0,
		inboxSeen: [],
		orphans: [],
		orphansError: null,
		keptWorktrees: { held: 0, stale: 0 },
		drainUntil: null,
		drainCommits: null,
		warnings: [],
		updates: null,
		alatePendingSince: null,
		deadSignIns: [],
		...(hosted ? { hosted: true } : {}),
	}) as unknown as StateResponse;

/** Every URL the board fetched, in order; a test clears it before it mounts. */
const requested: string[] = [];

/** The server as the board sees it: /api/boot and /api/state carry `hosted` only when on. */
const serverFor = (hosted: boolean): typeof fetch =>
	(async (input: RequestInfo | URL) => {
		const url = String(input);
		requested.push(url);
		let body: unknown;
		if (url === "/api/boot")
			body = {
				onboarding: false,
				version: "vtest",
				live: false,
				...(hosted ? { hosted: true } : {}),
			};
		else if (url === "/api/state") body = boardState(hosted);
		else if (url === "/api/update") body = { behind: 0, commits: [] };
		else if (url === "/api/system")
			body = {
				at: 1,
				containers: [],
				vm: {
					cpuPct: null,
					cpus: 4,
					load1: null,
					memAvailable: null,
					memTotal: null,
					history: [],
				},
				holds: {
					drainUntil: null,
					drainCommits: null,
					maxTotal: null,
					running: 0,
					queued: 0,
					oldestQueuedAt: null,
				},
			};
		// Other loads (Overview figures, provisioning) fail; their panels show the failure line.
		return new Response(JSON.stringify(body ?? { error: "not in this test" }), {
			status: body === undefined ? 503 : 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

/** Flushes fetch-fed state frames and effects until `pred` holds. */
async function waitFor(pred: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (pred()) return;
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 5);
			await promise;
		});
	}
	throw new Error(
		`condition not reached; body: ${document.body.innerHTML.slice(0, 1200)}`,
	);
}

const boardLoaded = (): boolean =>
	document.querySelector("main.main") !== null &&
	!(document.querySelector("main.main")?.textContent ?? "").includes(
		"Loading board",
	);

const loginShown = (): boolean =>
	document.querySelector('input[type="password"]') !== null;

/** Mounts App at `path` against the server, runs `check`, then unmounts. */
async function withApp(
	path: string,
	hosted: boolean,
	until: () => boolean,
	check: () => void,
): Promise<void> {
	host.fetch = serverFor(hosted);
	window.history.replaceState(null, "", path);
	const container = window.document.createElement(
		"div",
	) as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	const root: Root = createRoot(container);
	try {
		await act(async () => {
			root.render(<App />);
		});
		await waitFor(until);
		check();
	} finally {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		window.history.replaceState(null, "", "/");
	}
}

describe("hosted app shell", () => {
	test("hosted: /system shows the overview, and no System nav entry or view renders", async () => {
		await withApp("/system", true, boardLoaded, () => {
			expect(document.querySelector('a[href="/system"]')).toBeNull();
			expect(document.querySelector("#system-title")).toBeNull();
			expect(
				document
					.querySelector('a.area[href="/"]')
					?.getAttribute("aria-current"),
			).toBe("page");
		});
	});

	test("flag off: /system shows the System view and its nav entry", async () => {
		await withApp(
			"/system",
			false,
			() => document.querySelector("#system-title") !== null,
			() => {
				expect(document.querySelector('a.area[href="/system"]')).not.toBeNull();
			},
		);
	});

	test("hosted: the account menu has no sign-out and no sign-in line", async () => {
		await withApp("/", true, boardLoaded, () => {
			const menu = document.querySelector("#user-menu")?.textContent ?? "";
			expect(menu).toContain("Settings");
			expect(menu).not.toContain("Sign out");
			expect(menu).not.toContain("Signed in as");
		});
	});

	test("flag off: a signed-in user gets the sign-out control", async () => {
		await withApp("/", false, boardLoaded, () => {
			const menu = document.querySelector("#user-menu")?.textContent ?? "";
			expect(menu).toContain("Signed in as alice");
			expect(menu).toContain("Sign out");
		});
	});

	test("hosted: a stored logout shows the board, never the login page", async () => {
		window.localStorage.setItem(LOGOUT_KEY, "1");
		try {
			await withApp("/", true, boardLoaded, () => {
				expect(loginShown()).toBe(false);
			});
		} finally {
			window.localStorage.removeItem(LOGOUT_KEY);
		}
	});

	test("flag off: a stored logout shows the login page", async () => {
		window.localStorage.setItem(LOGOUT_KEY, "1");
		try {
			await withApp("/", false, loginShown, () => {
				expect(document.querySelector("main.main")).toBeNull();
			});
		} finally {
			window.localStorage.removeItem(LOGOUT_KEY);
		}
	});

	test("hosted: the app bar shows agents only, no provider quota", async () => {
		await withApp("/", true, boardLoaded, () => {
			const meters = document.querySelector("button.meters");
			expect(meters?.getAttribute("aria-label")).not.toContain("quota");
			expect(meters?.textContent).not.toContain("Quota");
			const detail =
				document.querySelector("#system-detail")?.textContent ?? "";
			expect(detail).toContain("Agents");
			expect(detail).not.toContain("Provider quota");
			expect(detail).not.toContain("omp usage");
		});
	});

	test("flag off: the app bar shows the provider quota", async () => {
		await withApp("/", false, boardLoaded, () => {
			const meters = document.querySelector("button.meters");
			expect(meters?.getAttribute("aria-label")).toContain("quota");
			expect(meters?.textContent).toContain("Quota");
			const detail =
				document.querySelector("#system-detail")?.textContent ?? "";
			expect(detail).toContain("Provider quota");
			expect(detail).toContain("Checking omp usage");
		});
	});

	const boardShown = (): boolean =>
		document.querySelector("#project-title") !== null;

	const provisioningFailed = (): boolean =>
		(document.body.textContent ?? "").includes("Provisioning data unavailable");

	const overviewShown = (): boolean =>
		document.querySelector("#ov-tab-now") !== null;

	test("hosted: the board and the overview link no hidden card, and no Setup tab shows", async () => {
		await withApp("/projects/proj", true, boardShown, () => {
			expect(document.body.textContent).not.toContain("GitHub features off");
		});
		requested.length = 0;
		await withApp("/", true, overviewShown, () => {
			expect(document.querySelector("#ov-tab-setup")).toBeNull();
			expect(document.querySelector("#ov-panel-setup")).toBeNull();
			expect(document.querySelector("#prov-title")).toBeNull();
			expect(document.querySelector("button.tri.warn")).toBeNull();
			expect(
				[...document.querySelectorAll('[role="tab"]')].map(
					(t) => t.textContent,
				),
			).toEqual(["Now", "Performance"]);
		});
		expect(requested).not.toContain("/api/provisioning");
	});

	test("flag off: the board and the overview link their setup cards", async () => {
		await withApp("/projects/proj", false, boardShown, () => {
			expect(document.body.textContent).toContain(
				"Settings → Git hosts → GitHub host",
			);
		});
		await withApp("/", false, provisioningFailed, () => {
			expect(document.querySelector("button.tri.warn")?.textContent).toContain(
				"Provisioning data unavailable",
			);
			expect(document.querySelector("#ov-tab-setup")).not.toBeNull();
			expect(document.querySelector("#prov-title")).not.toBeNull();
		});
	});

	test("a Setup tab selection falls back to Now when hosted mode turns on", async () => {
		host.fetch = serverFor(false);
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root: Root = createRoot(container);
		const overview = (hosted: boolean) => (
			<HostedContext.Provider value={hosted}>
				<Overview
					projects={boardState(false).projects}
					tasks={[]}
					compose={() => {}}
					onAdd={() => {}}
					openTask={() => {}}
					navigate={() => {}}
				/>
			</HostedContext.Provider>
		);
		const selected = (): string | null =>
			container.querySelector('[role="tab"][aria-selected="true"]')?.id ?? null;
		try {
			await act(async () => {
				root.render(overview(false));
			});
			await act(async () => {
				container.querySelector<HTMLButtonElement>("#ov-tab-setup")?.click();
			});
			expect(selected()).toBe("ov-tab-setup");
			await act(async () => {
				root.render(overview(true));
			});
			expect(selected()).toBe("ov-tab-now");
			expect(
				container.querySelector<HTMLElement>("#ov-panel-now")?.hidden,
			).toBe(false);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});
});

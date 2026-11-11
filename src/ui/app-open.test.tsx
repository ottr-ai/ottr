import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	ContainerRow,
	ProjectView,
	StateResponse,
	SystemSnapshot,
	TaskCard,
} from "../types.ts";

// Storage must exist before the import: app.tsx reads sessionStorage at module
// load. The DOM globals register after the import instead — app.tsx auto-renders
// <App/> at the bottom when document exists, and the tests mount it themselves
// under act() (same split as app.test.tsx, which keeps document undefined).
const window = new Window({ url: "http://localhost/" });
const host = globalThis as unknown as Record<string, unknown>;
host.sessionStorage = window.sessionStorage;
host.localStorage = window.localStorage;

const { App } = await import("./app.tsx");

const browserGlobals: Record<string, unknown> = {
	window,
	document: window.document,
	navigator: window.navigator,
	location: window.location,
	history: window.history,
	// Bun's own Event/CustomEvent/PopStateEvent classes stay global on purpose:
	// socket.ts dispatches them into Bun's module-level EventTarget, and a
	// happy-dom Event instance makes that dispatchEvent throw (the poll's
	// .catch swallows it and the board never leaves "Loading board…").
	HTMLElement: window.HTMLElement,
	HTMLDialogElement: window.HTMLDialogElement,
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
	// happy-dom implements no popover attribute yet; the bell rows call hidePopover().
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

const project = (name: string, display: string): ProjectView =>
	({
		name,
		icon: null,
		remote: null,
		path: `/tmp/${name}`,
		sessionsDir: `/tmp/${name}/.tasks/sessions`,
		hasRules: true,
		target: "origin/main",
		gitless: false,
		dirty: false,
		github: null,
		latestRelease: null,
		latestImage: null,
		archReview: null,
		settings: { displayName: display, maxParallel: 2 },
		taskPrefix: name.toUpperCase(),
	}) as unknown as ProjectView;

// ponytail: the board render reads only these fields; the cast keeps the rest out.
const card = (over: Partial<TaskCard>): TaskCard =>
	({
		id: "t1",
		title: "Task one",
		sessionTitle: "Task one",
		prompt: "work",
		summary: null,
		project: "alpha",
		state: "queued",
		stage: "todo",
		cancelledAt: null,
		createdAt: 0,
		doneAt: null,
		commits: [],
		dependsOn: [],
		updateIds: [],
		workCheckLog: [],
		shots: [],
		images: [],
		pendingImages: [],
		keptFiles: [],
		lateCommits: [],
		releaseVersion: null,
		followUpOf: null,
		followUpOfProject: null,
		asked: null,
		answered: false,
		answeredAt: null,
		needsReason: null,
		pendingPrompt: null,
		updatedAt: 0,
		priority: null,
		closeCandidate: null,
		...over,
	}) as unknown as TaskCard;

const projects = [project("alpha", "Alpha"), project("beta", "Beta")];
const tasks: TaskCard[] = [
	card({ id: "AL-1", title: "Alpha work", sessionTitle: "Alpha work" }),
	card({
		id: "AL-2",
		title: "Alpha parent",
		sessionTitle: "Alpha parent",
		stage: "done",
		state: "idle",
		doneAt: 1000,
	}),
	card({
		id: "BE-1",
		title: "Beta needs you",
		sessionTitle: "Beta needs you",
		project: "beta",
		state: "needs_you",
		needsReason: "A question for you",
	}),
	card({
		id: "BE-2",
		title: "Beta follow-up",
		sessionTitle: "Beta follow-up",
		project: "beta",
		stage: "in_progress",
		followUpOf: "AL-2",
		followUpOfProject: "alpha",
	}),
];
const state = {
	projects,
	tasks,
	maxTotal: null,
	reviewCheck: false,
	workCheck: false,
	idleReviews: false,
	trendingScan: true,
	trendingStatus: { lastRunAt: null, lastError: null, running: false },
	serverVersion: "vtest",
	quota: null,
	onboarding: false,
	user: null,
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
} as unknown as StateResponse;

const fetchMock = (async (input: RequestInfo | URL) => {
	const url = String(input);
	let body: unknown = {};
	if (url === "/api/boot")
		body = { onboarding: false, version: "vtest", live: false };
	else if (url === "/api/state") body = state;
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
	else {
		// The drawer's detail fetch: a TaskView built from the board card.
		const detail = /\/api\/projects\/[^/]+\/tasks\/[^/?]+$/.exec(url);
		const id = detail === null ? null : detail[0].split("/").pop();
		const row = id === null ? undefined : state.tasks.find((t) => t.id === id);
		if (row !== undefined)
			body = {
				...row,
				turns: [],
				details: null,
				report: null,
				diffFiles: null,
				worktreeFiles: [],
				shots: [],
				workCheckLog: [],
				images: [],
				pendingImages: [],
				keptFiles: [],
				lateCommits: [],
			};
		else if (url.endsWith("/context")) body = { context: null };
	}
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}) as typeof fetch;

beforeAll(() => {
	const realFetch = host.fetch;
	originals.set("fetch", realFetch);
	host.fetch = fetchMock;
});

// --- harness ----------------------------------------------------------------

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Mounts App at `path` (a pasted URL) and waits until the board is rendered. */
async function mountAt(path: string): Promise<void> {
	window.history.replaceState(null, "", path);
	container = window.document.createElement("div") as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	root = createRoot(container);
	await act(async () => {
		root?.render(<App />);
	});
	await waitFor(() => document.querySelector("#project-title") !== null);
}

async function unmountApp(): Promise<void> {
	if (root === null) return;
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	root = null;
	container = null;
}

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

const click = async (el: Element): Promise<void> => {
	await act(async () => {
		(el as HTMLElement).click();
	});
};

const header = (): string | null =>
	document.querySelector("#project-title")?.textContent ?? null;
const cardEl = (id: string): Element | null =>
	document.querySelector(`.card[data-task-id="${id}"]`);
const drawer = (): Element | null => document.querySelector("dialog.drawer");
const drawerOpen = (): boolean => drawer()?.hasAttribute("open") === true;

// --- tests ------------------------------------------------------------------

test("the bell opens another project's card and the board follows it", async () => {
	await mountAt("/projects/alpha");
	try {
		// The board starts on alpha; the bell lists beta's needs-you card.
		expect(header()).toBe("Alpha");
		const link = document.querySelector<HTMLAnchorElement>(
			'#inbox a.alarm-link[href="/projects/beta/tasks/BE-1"]',
		);
		expect(link).not.toBeNull();
		await click(link!);
		// The URL names the card's project ...
		expect(window.location.pathname).toBe("/projects/beta/tasks/BE-1");
		// ... and the board followed it: header and lanes show beta, not alpha.
		expect(header()).toBe("Beta");
		expect(cardEl("BE-1")).not.toBeNull();
		expect(cardEl("AL-1")).toBeNull();
		// The drawer shows the card over its own project.
		expect(drawerOpen()).toBe(true);
		expect(drawer()?.querySelector("h2")?.textContent).toBe("Beta needs you");
		// Closing the drawer keeps the board on the card's project.
		const close = drawer()?.querySelector<HTMLButtonElement>(
			'button[aria-label="Close"]',
		);
		expect(close).not.toBeNull();
		await click(close!);
		expect(window.location.pathname).toBe("/projects/beta");
		expect(header()).toBe("Beta");
		expect(cardEl("BE-1")).not.toBeNull();
		expect(drawerOpen()).toBe(false);
	} finally {
		await unmountApp();
	}
});

test("the kept-worktree advisory names its card and the link opens it", async () => {
	const before = state.keptWorktrees;
	// One cancelled card holds a worktree; the frame names it so the line can link it.
	state.keptWorktrees = { held: 1, stale: 0, cards: ["BE-2"] };
	await mountAt("/projects/alpha");
	try {
		const line = document.querySelector('[data-inbox-key^="kept:"]');
		expect(line?.textContent).toContain(
			"1 cancelled card still holds a worktree: BE-2.",
		);
		const link = line?.querySelector<HTMLButtonElement>("button.notif-link");
		expect(link?.getAttribute("title")).toBe("Open card BE-2");
		// The link is a real open: the drawer shows the card over its own project.
		await click(link!);
		await waitFor(drawerOpen);
		expect(window.location.pathname).toBe("/projects/beta/tasks/BE-2");
		expect(header()).toBe("Beta");
		expect(drawer()?.querySelector("h2")?.textContent).toBe("Beta follow-up");
	} finally {
		state.keptWorktrees = before;
		await unmountApp();
	}
});

test("a cross-project lineage link switches the board to the linked card's project", async () => {
	await mountAt("/projects/beta");
	try {
		const open = document.querySelector<HTMLAnchorElement>(
			'.card[data-task-id="BE-2"] a.card-open',
		);
		expect(open).not.toBeNull();
		await click(open!);
		await waitFor(drawerOpen);
		// BE-2's parent AL-2 lives on alpha: the lineage row names alpha's path.
		const parent = document.querySelector<HTMLAnchorElement>(
			'dialog.drawer a.lineage-row[href="/projects/alpha/tasks/AL-2"]',
		);
		expect(parent).not.toBeNull();
		await click(parent!);
		expect(window.location.pathname).toBe("/projects/alpha/tasks/AL-2");
		expect(header()).toBe("Alpha");
		expect(cardEl("AL-2")).not.toBeNull();
		expect(cardEl("BE-2")).toBeNull();
	} finally {
		await unmountApp();
	}
});

// A retro's proposal filed in another project (the OTTR-787 filing): the source
// card's lineage still nests it, and the proposal's drawer still reads the chain.
const pushRetroProposal = (): number => {
	const base = state.tasks.length;
	state.tasks.push(
		card({
			id: "SR-1",
			title: "Alpha retro",
			sessionTitle: "Alpha retro",
			stage: "done",
			state: "idle",
			kind: "retro",
			followUpOf: "AL-2",
			createdAt: 2000,
		}),
		card({
			id: "BP-1",
			title: "Beta proposal",
			sessionTitle: "Beta proposal",
			project: "beta",
			state: "needs_you",
			needsReason:
				"Retro proposal from AL-2. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
			followUpOf: "SR-1",
			followUpOfProject: "alpha",
			createdAt: 3000,
		}),
	);
	return base;
};

test("a retro's cross-project proposal nests under the retro in the source card's drawer", async () => {
	const base = pushRetroProposal();
	try {
		await mountAt("/projects/alpha/tasks/AL-2");
		// The retro is a follow-up row, and the foreign proposal nests under it
		// with its own project's path.
		const retro = document.querySelector<HTMLAnchorElement>(
			'dialog.drawer a.lineage-row[href="/projects/alpha/tasks/SR-1"]',
		);
		expect(retro).not.toBeNull();
		const proposal = document.querySelector<HTMLAnchorElement>(
			'dialog.drawer a.lineage-row[href="/projects/beta/tasks/BP-1"]',
		);
		expect(proposal).not.toBeNull();
	} finally {
		state.tasks.length = base;
		await unmountApp();
	}
});

test("a foreign proposal's drawer links its retro and the retro's source", async () => {
	const base = pushRetroProposal();
	try {
		await mountAt("/projects/beta/tasks/BP-1");
		// The retro parent links across projects...
		expect(
			document.querySelector<HTMLAnchorElement>(
				'dialog.drawer a.lineage-row[href="/projects/alpha/tasks/SR-1"]',
			),
		).not.toBeNull();
		// ...and the retro's source links too: no "Not on the board" row for it.
		expect(
			document.querySelector<HTMLAnchorElement>(
				'dialog.drawer a.lineage-row[href="/projects/alpha/tasks/AL-2"]',
			),
		).not.toBeNull();
		expect(document.querySelector("dialog.drawer .lineage-gone")).toBeNull();
		// The proposal reason names the source as a card link, not bare text.
		expect(
			document.querySelector<HTMLAnchorElement>(
				'dialog.drawer a.reason-card-link[href="/projects/alpha/tasks/AL-2"]',
			),
		).not.toBeNull();
	} finally {
		state.tasks.length = base;
		await unmountApp();
	}
});

test("a pasted card URL loads that project's board with the drawer open", async () => {
	await mountAt("/projects/beta/tasks/BE-1");
	try {
		expect(window.location.pathname).toBe("/projects/beta/tasks/BE-1");
		expect(header()).toBe("Beta");
		expect(drawerOpen()).toBe(true);
		expect(drawer()?.querySelector("h2")?.textContent).toBe("Beta needs you");
	} finally {
		await unmountApp();
	}
});

test("opening a card of the current project keeps the mounted lanes", async () => {
	await mountAt("/projects/alpha");
	try {
		const el = cardEl("AL-1");
		expect(el).not.toBeNull();
		// A foreign node inside a lane proves the lanes never remount: React drops
		// it on unmount only, and a same-project open must not unmount them.
		const marker = document.createElement("span");
		marker.id = "remount-marker";
		el!.appendChild(marker as unknown as Node);
		const open = el!.querySelector("a.card-open");
		expect(open).not.toBeNull();
		await click(open!);
		expect(window.location.pathname).toBe("/projects/alpha/tasks/AL-1");
		expect(header()).toBe("Alpha");
		expect(document.querySelector("#remount-marker")).not.toBeNull();
	} finally {
		await unmountApp();
	}
});

// --- optimistic read marks ---------------------------------------------------
// The read mark leads: seenAnswers gains the id at once, the POST follows, and a
// failed POST rolls the mark back (The Optimistic-Tap Rule).

test("a failed read mark rolls back: the card counts as unread again", async () => {
	const answered = card({
		id: "AL-9",
		title: "Alpha answered",
		sessionTitle: "Alpha answered",
		stage: "done",
		state: "idle",
		doneAt: 1000,
		answered: true,
	});
	state.tasks.push(answered);
	const realFetch = host.fetch;
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/seen")
			return new Response("{}", { status: 500 });
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountAt("/projects/alpha");
		const el = cardEl("AL-9");
		expect(el).not.toBeNull();
		expect(el!.hasAttribute("data-unread")).toBe(true);
		await click(el!.querySelector("a.card-open")!);
		await waitFor(drawerOpen);
		// The optimistic mark went out and the POST failed: the card keeps its
		// unread badge and the failure surfaces in the usual notice.
		expect(el!.hasAttribute("data-unread")).toBe(true);
		expect(document.body.textContent).toContain("Saving the read state failed");
	} finally {
		state.tasks.pop();
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("a failed mark-unread rolls back: the card counts as read again", async () => {
	const answered = card({
		id: "AL-10",
		title: "Alpha done answer",
		sessionTitle: "Alpha done answer",
		stage: "done",
		state: "idle",
		doneAt: 1000,
		answered: true,
	});
	state.tasks.push(answered);
	// The server frame confirms the read with both keys (OTTR-827: the plain id and
	// the completion key), so the local mark is not the only thing keeping the badge off.
	state.seenAnswers = ["AL-10", "AL-10@1000"];
	const realFetch = host.fetch;
	host.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/seen") {
			// Plain read marks succeed; only the unread flag fails.
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				unread?: boolean;
			};
			if (body.unread === true) return new Response("{}", { status: 500 });
			return new Response("{}", { status: 200 });
		}
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as unknown as typeof fetch;
	try {
		await mountAt("/projects/alpha/tasks/AL-10");
		await waitFor(drawerOpen);
		// The server frame says read: no unread badge.
		expect(cardEl("AL-10")!.hasAttribute("data-unread")).toBe(false);
		const unmark = document.querySelector<HTMLButtonElement>(
			'dialog.drawer button[title^="Puts the new badge back"]',
		);
		expect(unmark).not.toBeNull();
		await click(unmark!);
		// The failed POST rolls the optimistic unmark back, so the card counts as
		// read again (badge off) and the failure surfaces as the usual notice.
		await waitFor(() =>
			document.body.textContent!.includes("may show as read"),
		);
		expect(cardEl("AL-10")!.hasAttribute("data-unread")).toBe(false);
	} finally {
		state.tasks.pop();
		state.seenAnswers = [];
		host.fetch = realFetch;
		await unmountApp();
	}
});

// --- OTTR-827: recovery and the unread control policy ------------------------

test("a failed read mark recovers on the next explicit open", async () => {
	const answered = card({
		id: "AL-12",
		title: "Alpha answered again",
		sessionTitle: "Alpha answered again",
		stage: "done",
		state: "idle",
		doneAt: 1000,
		answered: true,
	});
	state.tasks.push(answered);
	let seenPosts = 0;
	let failSeen = true;
	const realFetch = host.fetch;
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/seen") {
			seenPosts++;
			if (failSeen) return new Response("{}", { status: 500 });
		}
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountAt("/projects/alpha/tasks/AL-12");
		await waitFor(drawerOpen);
		// The automatic mark on open fails once: the badge stays, the failure
		// surfaces, and the failed keys silence the automatic effect — no loop.
		await waitFor(() =>
			document.body.textContent!.includes("Saving the read state failed"),
		);
		expect(cardEl("AL-12")!.hasAttribute("data-unread")).toBe(true);
		const afterFailure = seenPosts;
		expect(afterFailure).toBeGreaterThan(0);
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 30);
			await promise;
		});
		expect(seenPosts).toBe(afterFailure);
		// Recovery: reopening the card is an explicit action, so it retries; the
		// POST succeeds and the badge clears.
		failSeen = false;
		const open = cardEl("AL-12")!.querySelector("a.card-open");
		expect(open).not.toBeNull();
		await click(open!);
		await waitFor(() => {
			const el = cardEl("AL-12");
			return el !== null && !el.hasAttribute("data-unread");
		});
		expect(seenPosts).toBe(afterFailure + 1);
	} finally {
		state.tasks.pop();
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("a card the baseline reads offers no Mark unread control", async () => {
	const answered = card({
		id: "AL-13",
		title: "Alpha old answer",
		sessionTitle: "Alpha old answer",
		stage: "done",
		state: "idle",
		doneAt: 500,
		answered: true,
	});
	state.tasks.push(answered);
	state.seenDoneSince = 1000;
	let seenPosts = 0;
	const realFetch = host.fetch;
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/seen") seenPosts++;
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountAt("/projects/alpha/tasks/AL-13");
		await waitFor(drawerOpen);
		// The baseline reads the card: the automatic effect marks nothing, and
		// the drawer offers no reverse action — removing marks (none exist that
		// count) could never re-light it.
		expect(seenPosts).toBe(0);
		expect(
			document.querySelector(
				'dialog.drawer button[title^="Puts the new badge back"]',
			),
		).toBeNull();
	} finally {
		state.tasks.pop();
		state.seenDoneSince = 0;
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("an opened post-baseline card offers Mark unread", async () => {
	const answered = card({
		id: "AL-14",
		title: "Alpha fresh answer",
		sessionTitle: "Alpha fresh answer",
		stage: "done",
		state: "idle",
		doneAt: 500,
		answered: true,
	});
	state.tasks.push(answered);
	try {
		await mountAt("/projects/alpha/tasks/AL-14");
		await waitFor(drawerOpen);
		// The automatic open mark lands (the frame baseline is 0), so the drawer
		// offers the reverse action for the card the user just read.
		await waitFor(
			() =>
				document.querySelector(
					'dialog.drawer button[title^="Puts the new badge back"]',
				) !== null,
		);
	} finally {
		state.tasks.pop();
		await unmountApp();
	}
});

// --- System view ---------------------------------------------------------------

test("the System view's Turns cell shows each worker turn's memory and CPU", async () => {
	const worker: ContainerRow = {
		name: "worker-a",
		reachable: true,
		unreachableSince: null,
		cpuPct: 90,
		cpuShare: 4,
		memUsed: 4 * 1024 ** 3,
		memLimit: 8 * 1024 ** 3,
		memMaxHits: 0,
		oomKills: 0,
		memMaxHitsHour: null,
		oomKillsHour: null,
		history: [],
		cards: [
			{
				project: "alpha",
				id: "AL-1",
				usage: {
					mem: 2.5 * 1024 ** 3,
					memPeak: 3 * 1024 ** 3,
					cpuPct: 87.4,
					cpuSec: 150,
				},
			},
			// A run the worker did not report yet: the link alone, no usage line.
			{ project: "beta", id: "BE-1", usage: null },
		],
		lock: { holderPid: null, holderCard: null, waiters: [] },
		warnings: [],
	};
	const realFetch = host.fetch;
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) !== "/api/system")
			return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
				input,
			);
		const base = (await (
			await (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
				input,
			)
		).json()) as SystemSnapshot;
		return new Response(JSON.stringify({ ...base, containers: [worker] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	window.history.replaceState(null, "", "/system");
	container = window.document.createElement("div") as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	root = createRoot(container);
	try {
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(() => document.querySelector("ul.sys-turns") !== null);
		const items = [...document.querySelectorAll("ul.sys-turns > li")];
		expect(items.map((li) => li.querySelector("a")?.textContent)).toEqual([
			"AL-1",
			"BE-1",
		]);
		expect(items[0]?.querySelector(".sys-sub")?.textContent).toBe(
			"2.5 GiB · peak 3.0 GiB · 87 % CPU · 3 min CPU time",
		);
		expect(items[1]?.querySelector(".sys-sub")).toBeNull();
	} finally {
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("open PR chips render per PR when three or fewer open PRs exist", async () => {
	const saved = state.projects;
	state.projects = [
		{
			...project("alpha", "Alpha"),
			github: "https://github.com/octo/repo",
			openPrs: {
				total: 2,
				prs: [
					{
						number: 7,
						title: "Add watcher",
						draft: false,
						url: "https://github.com/octo/repo/pull/7",
					},
					{
						number: 9,
						title: "Fix gates",
						draft: false,
						url: "https://github.com/octo/repo/pull/9",
					},
				],
			},
		},
		project("beta", "Beta"),
	] as typeof state.projects;
	try {
		await mountAt("/projects/alpha");
		const anchors = [...document.querySelectorAll(".project-meta a")];
		const prAnchors = anchors.filter(
			(a) =>
				(a as HTMLAnchorElement).href === "https://github.com/octo/repo/pull/7",
		);
		expect(prAnchors).toHaveLength(1);
		const first = prAnchors[0] as HTMLAnchorElement;
		expect(first.textContent).toContain("#7");
		expect(first.title).toBe("Add watcher");
		const second = anchors.find(
			(a) =>
				(a as HTMLAnchorElement).href === "https://github.com/octo/repo/pull/9",
		) as HTMLAnchorElement | undefined;
		expect(second?.textContent).toContain("#9");
	} finally {
		state.projects = saved;
		await unmountApp();
	}
});

test("more than three open PRs collapse to one count link to the pulls page", async () => {
	const saved = state.projects;
	state.projects = [
		{
			...project("alpha", "Alpha"),
			github: "https://github.com/octo/repo",
			openPrs: {
				total: 5,
				prs: [
					{
						number: 7,
						title: "Add watcher",
						draft: false,
						url: "https://github.com/octo/repo/pull/7",
					},
					{
						number: 9,
						title: "Fix gates",
						draft: false,
						url: "https://github.com/octo/repo/pull/9",
					},
					{
						number: 11,
						title: "Tune limits",
						draft: true,
						url: "https://github.com/octo/repo/pull/11",
					},
				],
			},
		},
		project("beta", "Beta"),
	] as typeof state.projects;
	try {
		await mountAt("/projects/alpha");
		const anchors = [...document.querySelectorAll(".project-meta a")];
		const pulls = anchors.filter(
			(a) =>
				(a as HTMLAnchorElement).href === "https://github.com/octo/repo/pulls",
		);
		expect(pulls).toHaveLength(1);
		expect((pulls[0] as HTMLAnchorElement).textContent).toContain("5 open PRs");
		// No per-PR chips leak out when collapsed.
		expect(
			anchors.some((a) => (a as HTMLAnchorElement).href.endsWith("/pull/7")),
		).toBe(false);
	} finally {
		state.projects = saved;
		await unmountApp();
	}
});

test("a project without openPrs data renders no pull-request chips", async () => {
	const saved = state.projects;
	state.projects = [
		{ ...project("alpha", "Alpha"), github: "https://github.com/octo/repo" },
		project("beta", "Beta"),
	] as typeof state.projects;
	try {
		await mountAt("/projects/alpha");
		const anchors = [...document.querySelectorAll(".project-meta a")];
		expect(
			anchors.some(
				(a) =>
					(a as HTMLAnchorElement).href.includes("/pull") &&
					(a as HTMLAnchorElement).href !== "https://github.com/octo/repo",
			),
		).toBe(false);
	} finally {
		state.projects = saved;
		await unmountApp();
	}
});

// --- polling-mode request hygiene (OTTR-662/OTTR-712) ------------------------

test("boot requests /api/state once, with /api/system alongside it", async () => {
	const realFetch = host.fetch;
	const seen: string[] = [];
	host.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "/api/state" || url === "/api/system") seen.push(url);
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountAt("/projects/alpha");
		// The poll's boot frame is the only /api/state request: the removed boot
		// probe would fetch it a second time, and system no longer waits for state.
		expect(seen.filter((u) => u === "/api/state")).toHaveLength(1);
		expect(seen).toContain("/api/system");
	} finally {
		host.fetch = realFetch;
		await unmountApp();
	}
});

/** Mounts App without waiting for the board: a failed poll never finishes loading it. */
async function mountRaw(path: string): Promise<void> {
	window.history.replaceState(null, "", path);
	container = window.document.createElement("div") as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	root = createRoot(container);
	await act(async () => {
		root?.render(<App />);
	});
}

test("a 401 poll gates the board without a second /api/state fetch", async () => {
	const realFetch = host.fetch;
	const stateCalls: string[] = [];
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/state") {
			stateCalls.push("/api/state");
			return new Response("{}", { status: 401 });
		}
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountRaw("/projects/alpha");
		// The poll's own status gates the board: no boot probe, no offline probe.
		await waitFor(() => document.querySelector("main.main") === null);
		expect(stateCalls).toEqual(["/api/state"]);
	} finally {
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("a failed state poll shows the offline banner without a second probe", async () => {
	const realFetch = host.fetch;
	const stateCalls: string[] = [];
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/state") {
			stateCalls.push("/api/state");
			throw new TypeError("network down");
		}
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountRaw("/projects/alpha");
		// The transport failure carries status 0, which cannot be a session loss:
		// the banner shows and no probe fetch runs.
		await waitFor(() =>
			document.body.textContent!.includes("Server connection lost. Retrying…"),
		);
		expect(document.querySelector("main.main")).not.toBeNull();
		expect(stateCalls).toEqual(["/api/state"]);
	} finally {
		host.fetch = realFetch;
		await unmountApp();
	}
});

/** Swaps the global interval functions for recording fakes and returns the restore pair. */
function fakeIntervals(): {
	ticks: Array<() => void>;
	restore: () => void;
} {
	const realSetInterval = host.setInterval;
	const realClearInterval = host.clearInterval;
	const ticks: Array<() => void> = [];
	host.setInterval = ((fn: () => void) => {
		ticks.push(fn);
		return 0;
	}) as typeof setInterval;
	host.clearInterval = (() => {}) as typeof clearInterval;
	return {
		ticks,
		restore: () => {
			host.setInterval = realSetInterval;
			host.clearInterval = realClearInterval;
		},
	};
}

test("a non-running card's session context is fetched once, never polled", async () => {
	const realFetch = host.fetch;
	const intervals = fakeIntervals();
	let contextCalls = 0;
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input).endsWith("/context")) contextCalls++;
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	state.tasks.push(
		card({
			id: "DO-9",
			title: "Done card",
			sessionTitle: "Done card",
			stage: "done",
			state: "idle",
			doneAt: 1000,
		}),
	);
	try {
		await mountAt("/projects/alpha/tasks/DO-9");
		await waitFor(drawerOpen);
		await waitFor(() => contextCalls > 0);
		expect(contextCalls).toBe(1); // the snapshot fetch on open
		await act(async () => {
			for (const fire of intervals.ticks) fire(); // every interval the page scheduled
			await Promise.resolve();
		});
		expect(contextCalls).toBe(1); // a done card earns no 5 s poll
	} finally {
		intervals.restore();
		host.fetch = realFetch;
		state.tasks.pop();
		await unmountApp();
	}
});

test("a running card's session context re-polls on the 5 s interval", async () => {
	const realFetch = host.fetch;
	const intervals = fakeIntervals();
	let contextCalls = 0;
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input).endsWith("/context")) contextCalls++;
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	state.tasks.push(
		card({
			id: "RU-9",
			title: "Running card",
			sessionTitle: "Running card",
			stage: "in_progress",
			state: "running",
		}),
	);
	try {
		await mountAt("/projects/alpha/tasks/RU-9");
		await waitFor(drawerOpen);
		await waitFor(() => contextCalls > 0);
		const before = contextCalls;
		await act(async () => {
			for (const fire of intervals.ticks) fire();
			await Promise.resolve();
		});
		await waitFor(() => contextCalls > before);
	} finally {
		intervals.restore();
		host.fetch = realFetch;
		state.tasks.pop();
		await unmountApp();
	}
});

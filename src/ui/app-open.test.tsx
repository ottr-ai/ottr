import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProjectView, StateResponse, TaskCard } from "../types.ts";

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
	serverVersion: "vtest",
	quota: null,
	onboarding: false,
	user: null,
	seenAnswers: [],
	seenDoneSince: 0,
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

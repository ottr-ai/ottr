import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { perfMetrics } from "../perf.ts";
import type {
	ContainerRow,
	ProjectView,
	StateResponse,
	SystemSnapshot,
	TaskCard,
	TaskView,
} from "../types.ts";
import { clearComposeDraft, loadComposeDraft } from "./notify.ts";
import { refreshState } from "./socket.ts";
import { onChangeOf, onClickOf, onKeyDownOf } from "./testDom.tsx";

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
	seedFailed: null,
	alateProvisionError: null,
} as unknown as StateResponse;

// --- per-test overrides -------------------------------------------------------
// The shared answers above stay fixed; a test swaps the frame the poll reads or
// serves its own fetch answers (older Done pages, the single-card route, failures).
// Every test clears what it set in its finally block.
let stateOverride: StateResponse | null = null;
let fetchTest: ((url: string) => Response | Promise<Response> | null) | null =
	null;
const setFrame = (s: StateResponse | null): void => {
	stateOverride = s;
};
const setFetch = (
	fn: ((url: string) => Response | Promise<Response> | null) | null,
): void => {
	fetchTest = fn;
};

const fetchMock = (async (input: RequestInfo | URL) => {
	const url = String(input);
	// A test's answers win; null falls through to the shared answers.
	if (fetchTest !== null) {
		const served = fetchTest(url);
		if (served !== null) return served;
	}
	let body: unknown = {};
	if (url === "/api/boot")
		body = { onboarding: false, version: "vtest", live: false };
	else if (url === "/api/state") body = stateOverride ?? state;
	else if (url === "/api/update") body = { behind: 0, commits: [] };
	else if (url === "/api/provisioning")
		body = {
			server: null,
			workers: [],
			userLayer: { skills: [], plugins: [], rules: [], mcp: [] },
		};
	else if (url === "/api/performance?range=all") {
		const perf = perfMetrics({ tasks: [], turns: [] }, "all", 0);
		body = {
			range: "all",
			bucketMs: perf.bucketMs,
			seriesStart: perf.seriesStart,
			fleet: perf.metrics,
			projects: [],
		};
	} else if (url === "/api/system")
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
		// The drawer's detail fetch: a TaskView built from the board card. The slim
		// state row carries no wide fields (OTTR-965), so the mock supplies them
		// the way the server's detail route does.
		const detail = /\/api\/projects\/[^/]+\/tasks\/[^/?]+$/.exec(url);
		const id = detail === null ? null : detail[0].split("/").pop();
		const row = id === null ? undefined : state.tasks.find((t) => t.id === id);
		if (row !== undefined)
			body = {
				...row,
				prompt: "work",
				summary: null,
				gate: null,
				workCheckReport: null,
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

/** Mounts App at `path` (a pasted URL) and waits until `ready` holds (default: the board
 * rendered its project header). */
async function mountAt(
	path: string,
	ready: () => boolean = () =>
		document.querySelector("#project-title") !== null,
): Promise<void> {
	window.history.replaceState(null, "", path);
	container = window.document.createElement("div") as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	root = createRoot(container);
	await act(async () => {
		root?.render(<App />);
	});
	await waitFor(ready);
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

const oldTask = card({
	id: "OTTR-441",
	title: "Old done task",
	sessionTitle: "Old done task",
	project: "alpha",
	state: "idle",
	stage: "done",
	createdAt: 1,
	doneAt: 100,
});
const oldTaskView = {
	...oldTask,
	prompt: "The older task prompt.",
	summary: null,
	details: null,
	report: null,
	diffFiles: null,
	turns: [],
	workCheckLog: [],
	workCheckReport: null,
	gate: null,
	worktreeFiles: [],
	shots: [],
	images: [],
	pendingImages: [],
	keptFiles: [],
	lateCommits: [],
} as unknown as TaskView;
const oldTaskPath = "/projects/alpha/tasks/OTTR-441";
const oldTaskDetailUrl = "/api/projects/alpha/tasks/OTTR-441";
const oldDonePageUrl = "/api/projects/alpha/done?page=2";

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

async function withOldTaskFixture(
	respondToDetail: (attempt: number) => Promise<Response>,
	run: (counts: {
		detailRequests: () => number;
		stateRequests: () => number;
	}) => Promise<void>,
): Promise<void> {
	const alpha = projects[0]!;
	const previousDoneTotal = alpha.doneTotal;
	const previousFetch = host.fetch;
	let detailRequests = 0;
	let stateRequests = 0;
	alpha.doneTotal =
		tasks.filter((task) => task.project === alpha.name && task.stage === "done")
			.length + 1;
	host.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === oldDonePageUrl)
			return jsonResponse({ tasks: [oldTask], total: alpha.doneTotal });
		if (url === oldTaskDetailUrl) return respondToDetail(++detailRequests);
		if (url === "/api/state") stateRequests++;
		return fetchMock(input);
	}) as typeof fetch;
	try {
		await run({
			detailRequests: () => detailRequests,
			stateRequests: () => stateRequests,
		});
	} finally {
		try {
			await unmountApp();
		} finally {
			alpha.doneTotal = previousDoneTotal;
			host.fetch = previousFetch;
		}
	}
}

const drawerHasTitle = (title: string): boolean =>
	drawerOpen() && drawer()?.querySelector("h2")?.textContent === title;
const oldTaskDrawerLoaded = (): boolean =>
	drawerHasTitle(oldTask.sessionTitle ?? oldTask.title) &&
	(drawer()?.textContent?.includes("The older task prompt.") ?? false);

const openCard = async (id: string): Promise<void> => {
	const open = cardEl(id)?.querySelector("a.card-open");
	expect(open).not.toBeNull();
	await click(open!);
};

const openOlderDoneCard = async (): Promise<void> => {
	const more = document.querySelector<HTMLButtonElement>("button.lane-more");
	expect(more).not.toBeNull();
	await click(more!);
	await waitFor(() => cardEl(oldTask.id) !== null);
	await openCard(oldTask.id);
};

const appErrorRow = (): Element | null =>
	document.querySelector('#inbox .notif-line[data-inbox-key^="crit:"]');

async function expectOldTaskRetryAfter(
	fail: () => Promise<Response>,
): Promise<void> {
	await withOldTaskFixture(
		(attempt) =>
			attempt === 1 ? fail() : Promise.resolve(jsonResponse(oldTaskView)),
		async ({ detailRequests }) => {
			await mountAt("/projects/alpha");
			await openOlderDoneCard();
			await waitFor(() => appErrorRow() !== null);
			expect(appErrorRow()?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
			const drawerTitle = drawer()?.querySelector("h2")?.textContent;
			expect(drawerTitle === undefined || drawerTitle === oldTask.title).toBe(
				true,
			);
			expect(drawer()?.textContent ?? "").not.toContain(
				"The older task prompt.",
			);
			expect(window.location.pathname).toBe(oldTaskPath);

			await openCard("AL-1");
			await waitFor(() => drawerHasTitle("Alpha work"));
			await openCard(oldTask.id);
			await waitFor(oldTaskDrawerLoaded);
			expect(detailRequests()).toBeGreaterThanOrEqual(2);
		},
	);
}

// --- old Done task details --------------------------------------------------

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

test("a cross-project child in its own project's window nests in the source card's lineage", async () => {
	await mountAt("/projects/alpha/tasks/AL-2");
	try {
		// BE-2 rides beta's own frame (its project's Done window) and names AL-2
		// as its source across the border: the Follow-ups branch links beta's path.
		const kid = document.querySelector<HTMLAnchorElement>(
			'dialog.drawer a.lineage-row[href="/projects/beta/tasks/BE-2"]',
		);
		expect(kid).not.toBeNull();
		expect(kid?.textContent).toContain("Beta follow-up");
		expect(kid?.textContent).toContain("beta");
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

test("an initial legacy hash URL opens its project", async () => {
	await mountAt("/#alpha");
	try {
		expect(header()).toBe("Alpha");
		expect(window.location.pathname).toBe("/projects/alpha");
		expect(window.location.hash).toBe("");
	} finally {
		await unmountApp();
	}
});

test("Show more opens an older done task at its canonical URL", async () => {
	await withOldTaskFixture(
		async () => jsonResponse(oldTaskView),
		async () => {
			await mountAt("/projects/alpha");
			await openOlderDoneCard();
			await waitFor(oldTaskDrawerLoaded);
			expect(window.location.pathname).toBe(oldTaskPath);
			expect(drawerOpen()).toBe(true);
			expect(drawer()?.querySelector("h2")?.textContent).toBe("Old done task");
			expect(drawer()?.textContent).toContain("The older task prompt.");
		},
	);
});

test("a pasted old task URL opens its drawer", async () => {
	await withOldTaskFixture(
		async () => jsonResponse(oldTaskView),
		async () => {
			await mountAt(oldTaskPath);
			await waitFor(oldTaskDrawerLoaded);
			expect(window.location.pathname).toBe(oldTaskPath);
			expect(drawerOpen()).toBe(true);
			expect(drawer()?.querySelector("h2")?.textContent).toBe("Old done task");
			expect(drawer()?.textContent).toContain("The older task prompt.");
		},
	);
});

test("a slim state refresh keeps an older task drawer open", async () => {
	await withOldTaskFixture(
		async () => jsonResponse(oldTaskView),
		async ({ stateRequests }) => {
			await mountAt("/projects/alpha");
			await openOlderDoneCard();
			await waitFor(oldTaskDrawerLoaded);
			const before = stateRequests();
			await act(async () => {
				refreshState();
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, 10);
				await promise;
			});
			expect(stateRequests()).toBeGreaterThan(before);
			expect(oldTaskDrawerLoaded()).toBe(true);
		},
	);
});

test("an old pinned task stays open when its state row disappears", async () => {
	const pinned = card({ ...oldTask, starred: true });
	const pinnedView = { ...oldTaskView, ...pinned } as TaskView;
	const pendingDetail = Promise.withResolvers<Response>();
	const releaseDetail = pendingDetail.resolve;
	const previousTasks = state.tasks;
	state.tasks = [...previousTasks, pinned];
	try {
		await withOldTaskFixture(
			(attempt) =>
				attempt === 1
					? Promise.resolve(jsonResponse(pinnedView))
					: pendingDetail.promise,
			async ({ detailRequests, stateRequests }) => {
				try {
					await mountAt("/projects/alpha");
					await openCard(pinned.id);
					await waitFor(() => detailRequests() === 1 && oldTaskDrawerLoaded());
					const selectedDialog = drawer();
					expect(selectedDialog).not.toBeNull();
					const workSteps = selectedDialog!.querySelector<HTMLButtonElement>(
						'button[aria-controls="drawer-steps"]',
					);
					expect(workSteps).not.toBeNull();
					await click(workSteps!);
					expect(workSteps!.getAttribute("aria-expanded")).toBe("true");
					const expectPinnedDrawer = () => {
						expect(drawer()).toBe(selectedDialog);
						expect(drawerOpen()).toBe(true);
						expect(drawerHasTitle(pinned.sessionTitle ?? pinned.title)).toBe(
							true,
						);
						expect(selectedDialog!.textContent).toContain(
							"The older task prompt.",
						);
						expect(workSteps!.getAttribute("aria-expanded")).toBe("true");
					};

					const before = stateRequests();
					state.tasks = previousTasks;
					await act(async () => {
						refreshState();
						const { promise, resolve } = Promise.withResolvers<void>();
						setTimeout(resolve, 10);
						await promise;
					});
					expect(stateRequests()).toBeGreaterThan(before);
					expect(drawer()).toBe(selectedDialog);

					await waitFor(() => detailRequests() === 2);
					expectPinnedDrawer();

					releaseDetail(jsonResponse(pinnedView));
					await act(async () => {
						const { promise, resolve } = Promise.withResolvers<void>();
						setTimeout(resolve, 10);
						await promise;
					});
					expectPinnedDrawer();
				} finally {
					releaseDetail(jsonResponse(pinnedView));
				}
			},
		);
	} finally {
		state.tasks = previousTasks;
	}
});

test("a late old task detail cannot replace a newly opened task", async () => {
	const delayedOldDetail = Promise.withResolvers<Response>();
	const releaseOldDetail = delayedOldDetail.resolve;
	await withOldTaskFixture(
		(attempt) =>
			attempt === 1
				? delayedOldDetail.promise
				: Promise.resolve(jsonResponse(oldTaskView)),
		async ({ detailRequests }) => {
			try {
				await mountAt("/projects/alpha");
				await openOlderDoneCard();
				await waitFor(() => detailRequests() === 1);
				await openCard("AL-1");
				await waitFor(() => drawerHasTitle("Alpha work"));
				expect(window.location.pathname).toBe("/projects/alpha/tasks/AL-1");

				releaseOldDetail(jsonResponse(oldTaskView));
				await act(async () => {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 10);
					await promise;
				});
				expect(drawerHasTitle("Alpha work")).toBe(true);
				expect(drawer()?.textContent ?? "").not.toContain(
					"The older task prompt.",
				);
				expect(window.location.pathname).toBe("/projects/alpha/tasks/AL-1");
			} finally {
				releaseOldDetail(jsonResponse(oldTaskView));
			}
		},
	);
});

test("a late old task detail after Back keeps the board closed", async () => {
	const pendingDetail = Promise.withResolvers<Response>();
	const releaseDetail = pendingDetail.resolve;
	await withOldTaskFixture(
		() => pendingDetail.promise,
		async ({ detailRequests }) => {
			try {
				await mountAt("/projects/alpha");
				await openOlderDoneCard();
				await waitFor(() => detailRequests() === 1);
				expect(window.location.pathname).toBe(oldTaskPath);

				await act(async () => {
					window.history.back();
				});
				await waitFor(
					() => window.location.pathname === "/projects/alpha" && !drawerOpen(),
				);
				releaseDetail(jsonResponse(oldTaskView));
				await act(async () => {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 10);
					await promise;
				});
				expect(drawerOpen()).toBe(false);
				expect(window.location.pathname).toBe("/projects/alpha");
			} finally {
				releaseDetail(jsonResponse(oldTaskView));
			}
		},
	);
});

test("a current state task keeps its title over a late old detail", async () => {
	const pendingDetail = Promise.withResolvers<Response>();
	const releaseDetail = pendingDetail.resolve;
	const currentTask = card({
		...oldTask,
		title: "Current frame title",
		sessionTitle: "Current frame title",
		updatedAt: 200,
	});
	const currentTaskView: TaskView = {
		...oldTaskView,
		title: currentTask.title,
		sessionTitle: currentTask.sessionTitle,
	};
	const previousTaskCount = state.tasks.length;
	await withOldTaskFixture(
		(attempt) =>
			attempt === 1
				? pendingDetail.promise
				: Promise.resolve(jsonResponse(currentTaskView)),
		async ({ detailRequests, stateRequests }) => {
			try {
				await mountAt("/projects/alpha");
				await openOlderDoneCard();
				await waitFor(() => detailRequests() === 1);
				const before = stateRequests();
				state.tasks.push(currentTask);
				await act(async () => {
					refreshState();
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 10);
					await promise;
				});
				expect(stateRequests()).toBeGreaterThan(before);
				await waitFor(() => drawerHasTitle("Current frame title"));

				releaseDetail(jsonResponse(oldTaskView));
				await act(async () => {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 10);
					await promise;
				});
				expect(drawerHasTitle("Current frame title")).toBe(true);
				expect(window.location.pathname).toBe(oldTaskPath);
			} finally {
				state.tasks.length = previousTaskCount;
				releaseDetail(jsonResponse(oldTaskView));
			}
		},
	);
});

test("a newer current row stays selected after an old task leaves state", async () => {
	const currentTask = card({
		...oldTask,
		title: "Current frame title",
		sessionTitle: "Current frame title",
		updatedAt: 200,
	});
	const currentTaskView = { ...oldTaskView, ...currentTask } as TaskView;
	let currentDetail: TaskView = oldTaskView;
	const pendingDetail = Promise.withResolvers<Response>();
	const releaseDetail = pendingDetail.resolve;
	const previousTasks = state.tasks;
	let afterEviction = false;
	try {
		await withOldTaskFixture(
			() =>
				afterEviction
					? pendingDetail.promise
					: Promise.resolve(jsonResponse(currentDetail)),
			async ({ detailRequests, stateRequests }) => {
				try {
					await mountAt("/projects/alpha");
					await openOlderDoneCard();
					await waitFor(oldTaskDrawerLoaded);
					const selectedDialog = drawer();
					expect(selectedDialog).not.toBeNull();
					const expectCurrentDrawer = () => {
						expect(drawer()).toBe(selectedDialog);
						expect(drawerOpen()).toBe(true);
						expect(drawerHasTitle("Current frame title")).toBe(true);
						expect(selectedDialog!.textContent).toContain(
							"The older task prompt.",
						);
					};
					currentDetail = currentTaskView;

					const before = stateRequests();
					state.tasks = [...previousTasks, currentTask];
					await act(async () => {
						refreshState();
						const { promise, resolve } = Promise.withResolvers<void>();
						setTimeout(resolve, 10);
						await promise;
					});
					expect(stateRequests()).toBeGreaterThan(before);
					await waitFor(() => drawerHasTitle("Current frame title"));
					expectCurrentDrawer();

					const detailsBeforeEviction = detailRequests();
					const stateBeforeEviction = stateRequests();
					afterEviction = true;
					state.tasks = previousTasks;
					await act(async () => {
						refreshState();
						const { promise, resolve } = Promise.withResolvers<void>();
						setTimeout(resolve, 10);
						await promise;
					});
					expect(stateRequests()).toBeGreaterThan(stateBeforeEviction);
					expect(drawer()).toBe(selectedDialog);
					await waitFor(() => detailRequests() > detailsBeforeEviction);
					expectCurrentDrawer();

					releaseDetail(jsonResponse(currentTaskView));
					await act(async () => {
						const { promise, resolve } = Promise.withResolvers<void>();
						setTimeout(resolve, 10);
						await promise;
					});
					expectCurrentDrawer();
				} finally {
					releaseDetail(jsonResponse(currentTaskView));
				}
			},
		);
	} finally {
		state.tasks = previousTasks;
	}
});

test("Back and Forward restore old task URLs and Close exits the drawer", async () => {
	await withOldTaskFixture(
		async () => jsonResponse(oldTaskView),
		async () => {
			await mountAt(oldTaskPath);
			await waitFor(oldTaskDrawerLoaded);
			await openCard("AL-1");
			await waitFor(() => drawerHasTitle("Alpha work"));
			expect(window.location.pathname).toBe("/projects/alpha/tasks/AL-1");

			await act(async () => {
				window.history.back();
			});
			await waitFor(
				() => window.location.pathname === oldTaskPath && oldTaskDrawerLoaded(),
			);
			await act(async () => {
				window.history.forward();
			});
			await waitFor(
				() =>
					window.location.pathname === "/projects/alpha/tasks/AL-1" &&
					drawerHasTitle("Alpha work"),
			);

			await act(async () => {
				window.history.back();
			});
			await waitFor(
				() => window.location.pathname === oldTaskPath && oldTaskDrawerLoaded(),
			);
			const close = drawer()?.querySelector<HTMLButtonElement>(
				'button[aria-label="Close"]',
			);
			expect(close).not.toBeNull();
			await click(close!);
			await waitFor(
				() => !drawerOpen() && window.location.pathname === "/projects/alpha",
			);
			expect(drawerOpen()).toBe(false);
			expect(window.location.pathname).toBe("/projects/alpha");
		},
	);
});

test.each(["/", "/#alpha"])(
	"Back and Forward restore a legacy task entry at %s",
	async (legacyPath) => {
		await mountAt("/projects/beta/tasks/BE-1");
		try {
			window.history.pushState({ ompTask: "AL-1" }, "", legacyPath);
			await openCard("BE-2");
			await waitFor(() => drawerHasTitle("Beta follow-up"));

			await act(async () => {
				window.history.back();
			});
			await waitFor(() => drawerHasTitle("Alpha work"));
			expect(appErrorRow()).toBeNull();

			await act(async () => {
				window.history.back();
			});
			await waitFor(() => drawerHasTitle("Beta needs you"));
			await act(async () => {
				window.history.forward();
			});
			await waitFor(() => drawerHasTitle("Alpha work"));
			expect(appErrorRow()).toBeNull();

			await act(async () => {
				window.history.forward();
			});
			await waitFor(() => drawerHasTitle("Beta follow-up"));
			expect(window.location.pathname).toBe("/projects/beta/tasks/BE-2");
		} finally {
			await unmountApp();
		}
	},
);

test("a missing old task detail shows an error and can retry", async () => {
	await expectOldTaskRetryAfter(async () =>
		jsonResponse({ error: "Task not found" }, 404),
	);
});

test("a server error for an old task detail can retry", async () => {
	await expectOldTaskRetryAfter(async () =>
		jsonResponse({ error: "Task unavailable" }, 500),
	);
});

test("a transport error for an old task detail can retry", async () => {
	await expectOldTaskRetryAfter(async () => {
		throw new Error("Network unavailable");
	});
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

test("the System view's vm-runner row shows health, fleet, disk, VM facts, and busy cards", async () => {
	const vmRunner: ContainerRow = {
		name: "vm-runner",
		reachable: true,
		unreachableSince: null,
		cpuPct: 12,
		cpuShare: 4,
		memUsed: 1024 ** 3,
		memLimit: 8 * 1024 ** 3,
		memMaxHits: 0,
		oomKills: 0,
		memMaxHitsHour: null,
		oomKillsHour: null,
		history: [],
		cards: [
			{
				project: "alpha",
				id: "V-1",
				usage: {
					mem: 0.5 * 1024 ** 3,
					memPeak: 0.6 * 1024 ** 3,
					cpuPct: 40,
					cpuSec: 30,
				},
			},
			// The validate run the runner has not weighed yet: the VM facts alone.
			{ project: "beta", id: "V-2", usage: null },
		],
		lock: { holderPid: null, holderCard: null, waiters: [] },
		warnings: [],
		vm: {
			health: { ok: true, reason: null },
			max: 10,
			vms: [
				{
					id: "run-1",
					project: "alpha",
					cardId: "V-1",
					mode: "turn",
					vcpus: 2,
					memMiB: 512,
					startedAt: 1000,
					scratchBytes: 2 * 1024 ** 3,
				},
				{
					id: "val-1",
					project: "beta",
					cardId: "V-2",
					mode: "validate",
					vcpus: 1,
					memMiB: 1024,
					startedAt: 1000,
					scratchBytes: null,
				},
			],
			disk: { base: 1024 ** 3, layers: 2 * 1024 ** 3, runs: 0.5 * 1024 ** 3 },
			busy: [{ project: "alpha", id: "V-3" }],
		},
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
		return new Response(JSON.stringify({ ...base, containers: [vmRunner] }), {
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
		const text = document.body.textContent!;
		expect(text).toContain("vm-runner ok");
		expect(text).toContain("2 / 10 VMs");
		expect(text).toContain(
			"vm-state 3.5 GiB allocated (base 1.0 · layers 2.0 · runs 0.5)",
		);
		const items = [...document.querySelectorAll("ul.sys-turns > li")];
		expect(items.map((li) => li.querySelector("a")?.textContent)).toEqual([
			"V-1",
			"V-2",
		]);
		// Second sub-line of the first item: the VM facts under the usage line.
		expect(items[0]?.querySelectorAll(".sys-sub")[1]?.textContent).toContain(
			"turn · 2 vCPU · 512 MiB guest · scratch 2.0 GiB allocated · since",
		);
		// No usage on the validate run, so its only sub-line is the VM facts —
		// and with no scratch disk yet, the scratch part is gone.
		expect(items[1]?.querySelector(".sys-sub")?.textContent).toContain(
			"validate · 1 vCPU · 1024 MiB guest · since",
		);
		expect(items[1]?.querySelector(".sys-sub")?.textContent).not.toContain(
			"scratch",
		);
		expect(text).toContain("waiting for a free VM:");
		expect(
			[...document.querySelectorAll("a")].some((a) => a.textContent === "V-3"),
		).toBe(true);
	} finally {
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("an unreachable vm-runner row keeps the gap cell, the health reason, and busy cards", async () => {
	const down: ContainerRow = {
		name: "vm-runner",
		reachable: false,
		unreachableSince: 1000,
		cpuPct: null,
		cpuShare: null,
		memUsed: null,
		memLimit: null,
		memMaxHits: null,
		oomKills: null,
		memMaxHitsHour: null,
		oomKillsHour: null,
		history: [],
		cards: [{ project: "alpha", id: "V-4", usage: null }],
		lock: { holderPid: null, holderCard: null, waiters: [] },
		warnings: [],
		vm: {
			health: { ok: false, reason: "no answer from http://vm-runner:8399" },
			max: null,
			vms: [],
			disk: null,
			busy: [{ project: "alpha", id: "V-5" }],
		},
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
		return new Response(JSON.stringify({ ...base, containers: [down] }), {
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
		await waitFor(() => document.querySelector("td.sys-gap") !== null);
		expect(document.querySelector("td.sys-gap")!.textContent).toContain(
			"not reachable since",
		);
		const text = document.body.textContent!;
		expect(text).toContain("no answer from http://vm-runner:8399");
		// No reachable reading: no fleet count and no disk line at all.
		expect(text).not.toContain("VMs");
		expect(text).not.toContain("allocated");
		expect(text).toContain("waiting for a free VM:");
		expect(
			[...document.querySelectorAll("a")].some((a) => a.textContent === "V-5"),
		).toBe(true);
		// The listed card has no usage and no live VM behind it: the bare link.
		const items = [...document.querySelectorAll("ul.sys-turns > li")];
		expect(items[0]?.querySelector("a")?.textContent).toBe("V-4");
		expect(items[0]?.querySelector(".sys-sub")).toBeNull();
	} finally {
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("a board without a vm-runner row renders containers as before", async () => {
	const server: ContainerRow = {
		name: "server",
		reachable: true,
		unreachableSince: null,
		cpuPct: 5,
		cpuShare: 4,
		memUsed: 1024 ** 3,
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
		return new Response(JSON.stringify({ ...base, containers: [server] }), {
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
		expect(document.body.textContent!.includes("vm-runner")).toBe(false);
		const items = [...document.querySelectorAll("ul.sys-turns > li")];
		expect(items[0]?.querySelector("a")?.textContent).toBe("AL-1");
		expect(items[0]?.querySelector(".sys-sub")?.textContent).toBe(
			"2.5 GiB · peak 3.0 GiB · 87 % CPU · 3 min CPU time",
		);
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

// --- offline banner reason classes (OTTR-964) -------------------------------

/** Swaps the global navigator.onLine getter; returns the restore function. */
function stubOnLine(value: boolean): () => void {
	Object.defineProperty(window.navigator, "onLine", {
		configurable: true,
		get: () => value,
	});
	return () => {
		delete (window.navigator as unknown as Record<string, unknown>).onLine;
	};
}

test("the banner names an offline device", async () => {
	const realFetch = host.fetch;
	const restoreOnLine = stubOnLine(false);
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/state") throw new TypeError("network down");
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountRaw("/projects/alpha");
		await waitFor(() =>
			document.body.textContent!.includes("This device is offline."),
		);
		const banner = document.querySelector(".conn-banner");
		expect(banner?.getAttribute("role")).toBe("status");
	} finally {
		restoreOnLine();
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("the banner names a server that did not answer in time", async () => {
	const realFetch = host.fetch;
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/state")
			throw new DOMException("The operation was aborted.", "AbortError");
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountRaw("/projects/alpha");
		await waitFor(() =>
			document.body.textContent!.includes(
				"The server did not answer within 5 s (timeout).",
			),
		);
		expect(document.body.textContent).toMatch(/Next retry in \d+ s\./);
	} finally {
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("the banner names the HTTP answer a proxy returned", async () => {
	const realFetch = host.fetch;
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/state")
			return new Response("bad gateway", { status: 502 });
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountRaw("/projects/alpha");
		await waitFor(() =>
			document.body.textContent!.includes(
				"The server answered HTTP 502. A proxy (for example tailscale serve) answers, but the board behind it does not.",
			),
		);
	} finally {
		host.fetch = realFetch;
		await unmountApp();
	}
});

test("the banner names an unreachable host and shows the contact facts", async () => {
	const realFetch = host.fetch;
	let polls = 0;
	host.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/state") {
			polls++;
			if (polls === 1)
				return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
					input,
				); // the first poll is the last good contact
			throw new TypeError("network down");
		}
		return (fetchMock as (input: RequestInfo | URL) => Promise<Response>)(
			input,
		);
	}) as typeof fetch;
	try {
		await mountAt("/projects/alpha");
		refreshState(); // poll now: this poll fails
		await waitFor(() =>
			document.body.textContent!.includes("No connection to localhost."),
		);
		expect(document.body.textContent).toMatch(
			/The browser does not say if the connection was refused, the name did not resolve, or a VPN such as Tailscale is off\./,
		);
		expect(document.body.textContent).toMatch(
			/Last good contact \d{2}:\d{2}:\d{2}\./,
		);
		expect(document.body.textContent).toMatch(/Next retry in \d+ s\./);
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

// --- OTTR-1084: card references in bell notices ------------------------------

const advisoryText =
	"agent-data main checkout changed while several cards were running (ottr#OTTR-1071, ottr#OTTR-1070): new commits abc1234 sync: add parallel-work check. No card was parked.";

/** Seeds the ottr project and its cards into the shared state frame and returns
 * the restore pair for the fields the bell tests overwrite. */
function seedOttr(ids: string[]): () => void {
	const baseProjects = state.projects;
	const baseWarnings = state.warnings;
	const baseRestart = state.restartWait;
	const taskLen = state.tasks.length;
	state.projects = [...baseProjects, project("ottr", "Ottr")];
	state.tasks.push(
		...ids.map((id, i) =>
			card({
				id,
				title: `Card ${id}`,
				sessionTitle: `Card ${id}`,
				project: "ottr",
				createdAt: 5000 + i,
			}),
		),
	);
	state.warnings = [];
	state.restartWait = null;
	return () => {
		state.projects = baseProjects;
		state.warnings = baseWarnings;
		state.restartWait = baseRestart;
		state.tasks.length = taskLen;
	};
}

const warnRow = (needle: string): Element | undefined =>
	[...document.querySelectorAll('#inbox [role="note"]')].find((r) =>
		r.textContent?.includes(needle),
	);

test("a card reference in a warning opens the card drawer", async () => {
	const restore = seedOttr(["OTTR-1070", "OTTR-1071"]);
	state.warnings = [advisoryText];
	state.restartWait = {
		running: "aaa1111",
		commit: "bbb2222",
		commits: 2,
		since: 1730990000000,
		turns: ["OTTR-1070"],
		command: "docker compose -f compose.yaml up -d --no-deps --wait server",
	};
	try {
		await mountAt("/projects/alpha");
		const ref = document.querySelector<HTMLAnchorElement>(
			'#inbox a.notif-link[data-card-link="1"][href="/projects/ottr/tasks/OTTR-1071"]',
		);
		expect(ref).not.toBeNull();
		await click(ref!);
		await waitFor(drawerOpen);
		// The warning row's reference opens the card drawer like an alarm row does.
		expect(window.location.pathname).toBe("/projects/ottr/tasks/OTTR-1071");
		expect(header()).toBe("Ottr");
		expect(drawer()?.querySelector("h2")?.textContent).toBe("Card OTTR-1071");
		// The restart line's bare id links too and opens its own card.
		const restart = document.querySelector<HTMLAnchorElement>(
			'[data-inbox-key="restart-wait:1730990000000"] a[href="/projects/ottr/tasks/OTTR-1070"]',
		);
		expect(restart).not.toBeNull();
		await click(restart!);
		await waitFor(
			() => window.location.pathname === "/projects/ottr/tasks/OTTR-1070",
		);
		expect(drawer()?.querySelector("h2")?.textContent).toBe("Card OTTR-1070");
	} finally {
		restore();
		await unmountApp();
	}
});

test("a foreign project reference and a commit sha stay text in the bell", async () => {
	const restore = seedOttr(["OTTR-1070", "OTTR-1071"]);
	state.warnings = [
		"While the checkout moved, alate#ALAT-180 stayed parked and ottr#7f78beca named the image commit.",
	];
	try {
		await mountAt("/projects/alpha");
		const row = warnRow("alate#ALAT-180");
		expect(row).toBeDefined();
		expect(row!.querySelector("a")).toBeNull();
		expect(row!.querySelector("button.notif-more")).toBeNull();
		expect(row!.textContent).toContain("ottr#7f78beca");
	} finally {
		restore();
		await unmountApp();
	}
});

test("five card references clamp to three links and expand in place", async () => {
	const restore = seedOttr([
		"OTTR-1070",
		"OTTR-1071",
		"OTTR-1072",
		"OTTR-1073",
		"OTTR-1074",
	]);
	state.warnings = [
		"Cards running across the checkout change (ottr#OTTR-1070, ottr#OTTR-1071, ottr#OTTR-1072, ottr#OTTR-1073, ottr#OTTR-1074) kept their worktrees.",
	];
	try {
		await mountAt("/projects/alpha");
		const row = warnRow("ottr#OTTR-1070");
		expect(row).toBeDefined();
		expect(row!.querySelectorAll("a[data-card-link]").length).toBe(3);
		// The clamp keeps the separator and the closing punctuation:
		// "...OTTR-1072, +2 more." instead of a glued "OTTR-1072+2 more".
		expect(row!.textContent).toContain("OTTR-1072, +2 more.");
		expect(row!.textContent).not.toContain("ottr#OTTR-1074");
		const more = row!.querySelector<HTMLButtonElement>("button.notif-more");
		expect(more?.textContent).toBe("+2 more");
		expect(more?.getAttribute("aria-label")).toBe("Show 2 more cards");
		await click(more!);
		// Expansion re-renders the row in place: all five references and no button.
		const expanded = warnRow("ottr#OTTR-1070");
		expect(expanded!.querySelectorAll("a[data-card-link]").length).toBe(5);
		expect(expanded!.textContent).toContain("ottr#OTTR-1074");
		expect(expanded!.querySelector("button.notif-more")).toBeNull();
	} finally {
		restore();
		await unmountApp();
	}
});

// --- OTTR-1136: cards outside the state frame ---------------------------------

/** One JSON answer for the per-test fetch override. */
const jsonRes = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** The wide TaskView shape the drawer's detail fetch reads, built over a slim row. */
const wideOf = (row: TaskCard): unknown => ({
	...row,
	prompt: "work",
	summary: null,
	gate: null,
	workCheckReport: null,
	turns: [],
	details: null,
	report: null,
	diffFiles: null,
	worktreeFiles: [],
	workCheckLog: [],
});

/** A Done window the state frame carries (the newest DONE_PAGE cards) with a
 * doneTotal that names five more, so the lane offers "Show more". */
const doneWindow = (): {
	win: StateResponse;
	alpha: ProjectView;
} => {
	const alpha = { ...projects[0], doneTotal: 25 } as ProjectView;
	const held = Array.from({ length: 20 }, (_, j) =>
		card({
			id: `D-${j}`,
			title: `Held ${j}`,
			sessionTitle: `Held ${j}`,
			stage: "done",
			state: "idle",
			doneAt: 2000 - j,
			revision: 1,
		}),
	);
	const win = {
		...state,
		projects: [alpha, projects[1]],
		tasks: held,
	} as unknown as StateResponse;
	return { win, alpha };
};

/** A fetched Done page card that sits outside the state frame. */
const oldCard = (over: Partial<TaskCard>): TaskCard =>
	card({
		title: "Older nine",
		sessionTitle: "Older nine",
		id: "OLD-9",
		project: "alpha",
		stage: "done",
		state: "idle",
		doneAt: 90,
		revision: 1,
		...over,
	});

test("a Show more card outside the state window opens in the drawer", async () => {
	const { win } = doneWindow();
	const page2 = [oldCard({})];
	setFetch((url) => {
		if (url === "/api/projects/alpha/done?page=2")
			return jsonRes({ tasks: page2, total: 21 });
		if (url === "/api/projects/alpha/tasks/OLD-9")
			return jsonRes(wideOf(page2[0]!));
		return null;
	});
	setFrame(win);
	await mountAt("/projects/alpha");
	try {
		const more = document.querySelector<HTMLButtonElement>("button.lane-more");
		expect(more).not.toBeNull();
		await click(more!);
		await waitFor(() => cardEl("OLD-9") !== null);
		const link = cardEl("OLD-9")!.querySelector("a.card-open");
		expect(link).not.toBeNull();
		await click(link!);
		await waitFor(drawerOpen);
		expect(drawer()?.querySelector("h2")?.textContent).toBe("Older nine");
	} finally {
		await unmountApp();
		setFetch(null);
		setFrame(null);
	}
});

test("a deep link to a done card outside the window opens it after the fetch", async () => {
	const deep = oldCard({
		id: "DEEP-1",
		title: "Deep old card",
		sessionTitle: "Deep old card",
		doneAt: 5,
	});
	let gated = false;
	const { promise: gate, resolve: release } = Promise.withResolvers<void>();
	setFetch((url) => {
		if (url === "/api/projects/alpha/tasks/DEEP-1") {
			// The first fetch waits, so the drawer's loading state renders.
			if (gated) return jsonRes(wideOf(deep));
			gated = true;
			return gate.then(() => jsonRes(wideOf(deep)));
		}
		return null;
	});
	await mountAt("/projects/alpha/tasks/DEEP-1");
	try {
		await waitFor(drawerOpen);
		expect(
			drawer()?.querySelector('[aria-label="Loading the card"]'),
		).not.toBeNull();
		release();
		await waitFor(
			() => drawer()?.querySelector("h2")?.textContent === "Deep old card",
		);
		expect(drawerOpen()).toBe(true);
	} finally {
		release();
		await unmountApp();
		setFetch(null);
	}
});

test("an unknown id shows not-found and a failed fetch offers Retry", async () => {
	let brokenCalls = 0;
	const healed = oldCard({
		id: "BROKEN-7",
		title: "Broken card",
		sessionTitle: "Broken card",
	});
	setFetch((url) => {
		if (url === "/api/projects/alpha/tasks/GONE-1")
			return jsonRes({ error: "unknown task" }, 404);
		if (url === "/api/projects/alpha/tasks/BROKEN-7") {
			brokenCalls++;
			return brokenCalls === 1
				? jsonRes({ error: "no" }, 500)
				: jsonRes(wideOf(healed));
		}
		return null;
	});
	await mountAt("/projects/alpha/tasks/GONE-1");
	try {
		await waitFor(
			() =>
				document.body.textContent?.includes("Card not found: GONE-1") === true,
		);
		const close = [...document.querySelectorAll("dialog.drawer button")].find(
			(b) => b.textContent?.trim() === "Close",
		);
		expect(close).toBeDefined();
		await click(close!);
		await waitFor(() => !drawerOpen());

		// A failed fetch shows the retry shell; the retry then opens the card.
		await unmountApp();
		await mountAt("/projects/alpha/tasks/BROKEN-7");
		await waitFor(
			() =>
				document.body.textContent?.includes("Loading the card failed.") ===
				true,
		);
		const retry = [...document.querySelectorAll("dialog.drawer button")].find(
			(b) => b.textContent?.trim() === "Retry",
		);
		expect(retry).toBeDefined();
		await click(retry!);
		await waitFor(
			() => drawer()?.querySelector("h2")?.textContent === "Broken card",
		);
		expect(drawerOpen()).toBe(true);
		// The retry's own fetch plus the drawer's detail fetch and the row refresh
		// all read the same route; the drawer opening proves the retry healed it.
		expect(brokenCalls).toBeGreaterThanOrEqual(2);
	} finally {
		await unmountApp();
		setFetch(null);
	}
});

test("an open older card stays open across frames and follows changes", async () => {
	const { win } = doneWindow();
	const v1 = oldCard({});
	const v2 = oldCard({
		title: "Older nine, revised",
		sessionTitle: "Older nine, revised",
		revision: 2,
	});
	let frame2 = false;
	setFetch((url) => {
		if (url === "/api/projects/alpha/done?page=2")
			return jsonRes({ tasks: [v1], total: 21 });
		if (url === "/api/projects/alpha/tasks/OLD-9")
			return jsonRes(wideOf(frame2 ? v2 : v1));
		return null;
	});
	setFrame(win);
	await mountAt("/projects/alpha");
	try {
		const more = document.querySelector<HTMLButtonElement>("button.lane-more");
		await click(more!);
		await waitFor(() => cardEl("OLD-9") !== null);
		const link = cardEl("OLD-9")!.querySelector("a.card-open");
		await click(link!);
		await waitFor(
			() => drawer()?.querySelector("h2")?.textContent === "Older nine",
		);
		// A new frame that still lacks the card must not close the drawer.
		frame2 = true;
		const moved = { ...win.tasks[0]!, title: "Held 0 v2" };
		setFrame({
			...win,
			tasks: [moved, ...win.tasks.slice(1)],
		} as unknown as StateResponse);
		refreshState();
		await waitFor(
			() => document.body.textContent?.includes("Held 0 v2") === true,
		);
		// The frame still lacks the card, but the drawer stays open.
		expect(drawerOpen()).toBe(true);
		// The frame refetch of the open row carries the revision bump into the drawer.
		await waitFor(
			() =>
				drawer()?.querySelector("h2")?.textContent === "Older nine, revised",
		);
		expect(drawerOpen()).toBe(true);
	} finally {
		await unmountApp();
		setFetch(null);
		setFrame(null);
	}
});

// --- optimistic New task (OTTR-1337) -----------------------------------------
// Submit closes the dialog at once and a placeholder holds the todo lane while the
// POST runs; the server's card replaces it, and a failed POST reopens the dialog.

const createUrl = "/api/projects/alpha/tasks";
const newTaskText = "Ship the lane\nwith the details below";
const newCard = card({
	id: "AL-9",
	title: "Ship the lane",
	sessionTitle: "Ship the lane",
	createdAt: 5,
});
const frameWithNewCard = (): StateResponse =>
	({ ...state, tasks: [...state.tasks, newCard] }) as unknown as StateResponse;

const newTaskDialog = (): Element | null =>
	document.querySelector('dialog[aria-label="New task for Alpha"]');
const newTaskOpen = (): boolean =>
	newTaskDialog()?.hasAttribute("open") === true;
const pendingCards = (): Element[] =>
	Array.from(document.querySelectorAll(".pending-card"));
const todoPendingCards = (): Element[] =>
	Array.from(
		document.querySelectorAll('section.stage[data-stage="todo"] .pending-card'),
	);
const cardCount = (id: string): number =>
	document.querySelectorAll(`.card[data-task-id="${id}"]`).length;

/**
 * Serves each create POST from its own deferred answer, in request order: `answer(i, res)`
 * resolves the i-th POST, before or after it runs. Passes every other request to the
 * shared mock. setFetch sees only the URL, so this wraps host.fetch to read the method
 * and body. Cleans the frame, the fetch and the on-device New task draft before and
 * after, so test order does not matter.
 */
async function withCreatePosts(
	run: (post: {
		answer: (index: number, res: Response) => void;
		bodies: { prompt?: unknown }[];
	}) => Promise<void>,
): Promise<void> {
	const previousFetch = host.fetch as typeof fetch;
	const answers: PromiseWithResolvers<Response>[] = [];
	const answerAt = (i: number): PromiseWithResolvers<Response> => {
		const d = answers[i] ?? Promise.withResolvers<Response>();
		answers[i] = d;
		return d;
	};
	const bodies: { prompt?: unknown }[] = [];
	clearComposeDraft("new:alpha");
	host.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input) === createUrl && init?.method === "POST") {
			bodies.push(JSON.parse(String(init.body)) as { prompt?: unknown });
			return answerAt(bodies.length - 1).promise;
		}
		return previousFetch(input, init);
	}) as typeof fetch;
	try {
		await run({ answer: (i, res) => answerAt(i).resolve(res), bodies });
	} finally {
		try {
			await unmountApp();
		} finally {
			host.fetch = previousFetch;
			setFrame(null);
			setFetch(null);
			clearComposeDraft("new:alpha");
		}
	}
}

/** withCreatePosts for a test that sends one create: `answer` resolves the first POST. */
async function withCreatePost(
	run: (post: {
		answer: (res: Response) => void;
		bodies: { prompt?: unknown }[];
	}) => Promise<void>,
): Promise<void> {
	await withCreatePosts(({ answer, bodies }) =>
		run({ answer: (res) => answer(0, res), bodies }),
	);
}

const headerNewTask = 'button[title="New task (N)"]';
const newTaskBox = (): HTMLTextAreaElement | null =>
	newTaskDialog()?.querySelector("textarea") ?? null;

/** Opens New task with the button `opener` names and waits for the dialog. */
async function openNewTask(opener = headerNewTask): Promise<void> {
	const open = document.querySelector<HTMLButtonElement>(opener);
	expect(open).not.toBeNull();
	await click(open!);
	await waitFor(newTaskOpen);
}

/** Types `text` into the open New task dialog, the way a keystroke reaches it. */
async function typeNewTask(text: string): Promise<void> {
	const box = newTaskBox();
	expect(box).not.toBeNull();
	await act(async () => {
		onChangeOf(box!)({
			target: { value: text },
			currentTarget: { value: text },
		});
	});
}

/** Closes the open New task dialog with its X button. */
async function closeNewTask(): Promise<void> {
	const close = newTaskDialog()?.querySelector<HTMLButtonElement>(
		'.dialog-head button[aria-label="Close"]',
	);
	expect(close).not.toBeNull();
	await click(close!);
	await waitFor(() => !newTaskOpen());
}

/** Opens New task (from the project header unless `opener` names another button), types
 * `text` and submits the form. */
async function addTask(text: string, opener = headerNewTask): Promise<void> {
	await openNewTask(opener);
	await typeNewTask(text);
	const box = newTaskBox();
	// Enter submits, as the hint says. happy-dom's form element hides React's props
	// from getOwnPropertyNames, so the textarea's key handler is the reachable path.
	await act(async () => {
		onKeyDownOf(box!)({
			key: "Enter",
			shiftKey: false,
			altKey: false,
			nativeEvent: { isComposing: false },
			preventDefault: () => {},
		});
	});
}

/** Flushes `rounds` rounds of frames and effects; `pred` must hold after every one. */
async function holdsFor(pred: () => boolean, rounds = 10): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 5);
			await promise;
		});
		expect(pred()).toBe(true);
	}
}

/** The placeholder right after submit: one, in the todo lane, titled by the first line. */
function expectPlaceholder(): void {
	expect(pendingCards().length).toBe(1);
	const placeholder = todoPendingCards()[0];
	expect(placeholder).toBeDefined();
	expect(placeholder!.textContent).toContain("Ship the lane");
	expect(placeholder!.textContent).not.toContain("with the details below");
	expect(placeholder!.textContent).toContain("Adding…");
	expect(placeholder!.getAttribute("aria-busy")).toBe("true");
	expect(placeholder!.hasAttribute("data-task-id")).toBe(false);
}

test("a new task closes its dialog at once and a placeholder holds the todo lane until the card lands", async () => {
	await withCreatePost(async ({ answer, bodies }) => {
		await mountAt("/projects/alpha");
		await addTask(newTaskText);
		// No waitFor: the dialog closes and the placeholder shows in the submit's own render.
		expect(newTaskOpen()).toBe(false);
		expectPlaceholder();
		expect(bodies.length).toBe(1);
		expect(bodies[0]!.prompt).toBe(newTaskText);
		expect(cardCount("AL-9")).toBe(0);

		// The answer names AL-9 first; the frame that carries it follows (act's own refresh).
		// Only the answer pairs, so a frame ahead of it would show both by design (next test).
		await act(async () => {
			answer(jsonResponse(newCard));
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
		setFrame(frameWithNewCard());
		refreshState();
		// Every sampled render shows the placeholder or the card, never both.
		let overlap = false;
		await waitFor(() => {
			if (cardCount("AL-9") > 0 && pendingCards().length > 0) overlap = true;
			return cardCount("AL-9") === 1 && pendingCards().length === 0;
		});
		expect(overlap).toBe(false);
		expect(
			document.querySelector(
				'section.stage[data-stage="todo"] .card[data-task-id="AL-9"]',
			),
		).not.toBeNull();
		expect(newTaskOpen()).toBe(false);
	});
});

test("a frame that carries the new card before the POST answers shows the card, and the placeholder holds until the answer", async () => {
	await withCreatePost(async ({ answer }) => {
		await mountAt("/projects/alpha");
		await addTask(newTaskText);
		expectPlaceholder();

		// No real card is held back: AL-9 renders as soon as a frame carries it. Only the
		// POST's own answer names it as this create's card, so until then the placeholder
		// holds the lane beside it.
		let answered = false;
		let broken = false;
		const sample = (): void => {
			if (cardCount("AL-9") > 1) broken = true;
			if (!answered && todoPendingCards().length !== 1) broken = true;
		};
		setFrame(frameWithNewCard());
		refreshState();
		await waitFor(() => {
			sample();
			return cardCount("AL-9") === 1;
		});
		await holdsFor(() => {
			sample();
			return cardCount("AL-9") === 1 && todoPendingCards().length === 1;
		});
		expect(broken).toBe(false);

		answered = true;
		answer(jsonResponse(newCard));
		refreshState();
		const once = (): boolean => {
			sample();
			return cardCount("AL-9") === 1 && pendingCards().length === 0;
		};
		await waitFor(once);
		await holdsFor(once);
		expect(broken).toBe(false);
	});
});

test("a failed create drops the placeholder and reopens New task with the text and the error", async () => {
	await withCreatePost(async ({ answer }) => {
		await mountAt("/projects/alpha");
		await addTask(newTaskText);
		expect(newTaskOpen()).toBe(false);
		expectPlaceholder();

		answer(jsonResponse({ error: "boom" }, 500));
		await waitFor(
			() =>
				pendingCards().length === 0 &&
				newTaskOpen() &&
				(newTaskDialog()?.querySelector('[role="alert"]')?.textContent ?? "")
					.length > 0,
		);
		const box = newTaskDialog()?.querySelector("textarea");
		expect(box).not.toBeNull();
		expect(box!.value).toBe(newTaskText);
		expect(
			newTaskDialog()?.querySelector('[role="alert"]')?.textContent,
		).toContain("Not added: boom");
		// The board's usual error line names the failure too.
		await waitFor(() => appErrorRow() !== null);
		expect(appErrorRow()?.textContent).toContain("boom");
		expect(cardCount("AL-9")).toBe(0);
	});
});

const frameWith = (...cards: TaskCard[]): StateResponse =>
	({ ...state, tasks: [...state.tasks, ...cards] }) as unknown as StateResponse;
/** The New task dialog's line about failed creates still queued for it; null when none. */
const waitingLine = (): string | null => {
	const line = newTaskDialog()?.querySelector(".compose-waiting");
	if (line === null || line === undefined) return null;
	expect(line.getAttribute("role")).toBe("status");
	return line.textContent;
};
const oneWaiting =
	"1 earlier task was not added. Send or clear this draft, then open New task again to get it back.";

test("a card from another tab shows at once while a local create runs, and the placeholder holds the lane", async () => {
	await withCreatePost(async ({ answer }) => {
		await mountAt("/projects/alpha");
		await addTask(newTaskText);
		expectPlaceholder();

		// Another tab adds AL-7 while this tab's POST runs. Only the POST's answer pairs the
		// placeholder, so it never takes AL-7 for its own card: from the moment AL-7 renders,
		// both stand on the board in every sampled render until AL-9 lands.
		const foreign = card({
			id: "AL-7",
			title: "Another tab's task",
			sessionTitle: "Another tab's task",
			createdAt: 3,
		});
		let seen = false;
		let broken = false;
		const sample = (): void => {
			if (cardCount("AL-7") === 1) seen = true;
			else if (seen) broken = true;
			if (todoPendingCards().length !== 1) broken = true;
		};
		setFrame(frameWith(foreign));
		refreshState();
		await waitFor(() => {
			sample();
			return seen;
		});
		await holdsFor(() => {
			sample();
			return true;
		});
		expect(broken).toBe(false);

		// The answer names AL-9; the frame still lacks it, so the placeholder holds on.
		answer(jsonResponse(newCard));
		await holdsFor(() => {
			sample();
			return true;
		});
		expect(broken).toBe(false);

		setFrame(frameWith(foreign, newCard));
		refreshState();
		await waitFor(() => {
			if (cardCount("AL-7") !== 1) broken = true;
			return cardCount("AL-9") === 1 && pendingCards().length === 0;
		});
		expect(broken).toBe(false);
		expect(cardCount("AL-7")).toBe(1);
	});
});

test("another tab's card titled as the local prompt never stands in for the running create's placeholder", async () => {
	await withCreatePost(async ({ answer }) => {
		await mountAt("/projects/alpha");
		await addTask(newTaskText);
		expectPlaceholder();

		// Another tab adds AL-7 with the very title the server gives this prompt. Only the
		// POST's answer pairs a placeholder, so AL-7 renders beside the placeholder.
		const foreign = card({
			id: "AL-7",
			title: "Ship the lane",
			sessionTitle: "Ship the lane",
			createdAt: 3,
		});
		let answered = false;
		let seen = false;
		let broken = false;
		const sample = (): void => {
			if (cardCount("AL-7") === 1) seen = true;
			else if (seen) broken = true;
			if (!answered && todoPendingCards().length !== 1) broken = true;
		};
		setFrame(frameWith(foreign));
		refreshState();
		await waitFor(() => {
			sample();
			return seen;
		});
		await holdsFor(() => {
			sample();
			return cardCount("AL-7") === 1 && todoPendingCards().length === 1;
		});
		refreshState();
		await holdsFor(() => {
			sample();
			return cardCount("AL-7") === 1 && todoPendingCards().length === 1;
		});
		expect(broken).toBe(false);

		answered = true;
		answer(jsonResponse(newCard));
		setFrame(frameWith(foreign, newCard));
		refreshState();
		const landed = (): boolean => {
			sample();
			return (
				cardCount("AL-7") === 1 &&
				cardCount("AL-9") === 1 &&
				pendingCards().length === 0
			);
		};
		await waitFor(landed);
		await holdsFor(landed);
		expect(broken).toBe(false);
	});
});

test("two creates each keep their own placeholder until their own card lands", async () => {
	await withCreatePosts(async ({ answer, bodies }) => {
		await mountAt("/projects/alpha");
		await addTask("First concurrent task");
		await addTask("Second concurrent task");
		expect(bodies.map((b) => b.prompt)).toEqual([
			"First concurrent task",
			"Second concurrent task",
		]);
		expect(todoPendingCards().length).toBe(2);
		const first = card({
			id: "AL-9",
			title: "First concurrent task",
			sessionTitle: "First concurrent task",
			createdAt: 5,
		});
		const second = card({
			id: "AL-10",
			title: "Second concurrent task",
			sessionTitle: "Second concurrent task",
			createdAt: 6,
		});

		answer(0, jsonResponse(first));
		setFrame(frameWith(first));
		refreshState();
		const firstLanded = (): boolean =>
			cardCount("AL-9") === 1 && todoPendingCards().length === 1;
		await waitFor(firstLanded);
		expect(todoPendingCards()[0]!.textContent).toContain(
			"Second concurrent task",
		);
		// The first create settles and drops; AL-9 stays its card and never stands in for
		// the second create, which still runs.
		await holdsFor(firstLanded);
		refreshState();
		await holdsFor(firstLanded);

		answer(1, jsonResponse(second));
		setFrame(frameWith(first, second));
		refreshState();
		await waitFor(
			() =>
				cardCount("AL-9") === 1 &&
				cardCount("AL-10") === 1 &&
				pendingCards().length === 0,
		);
	});
});

test("two creates that share a first line each keep their placeholder until their own answer pairs it", async () => {
	await withCreatePosts(async ({ answer, bodies }) => {
		await mountAt("/projects/alpha");
		await addTask("Ship the lane\nfirst body");
		await addTask("Ship the lane\nsecond body");
		expect(bodies.map((b) => b.prompt)).toEqual([
			"Ship the lane\nfirst body",
			"Ship the lane\nsecond body",
		]);
		expect(todoPendingCards().length).toBe(2);
		const first = card({
			id: "AL-9",
			title: "Ship the lane",
			sessionTitle: "Ship the lane",
			createdAt: 5,
		});
		const second = card({
			id: "AL-10",
			title: "Ship the lane",
			sessionTitle: "Ship the lane",
			createdAt: 6,
		});

		// The first create's card lands before its POST answers: it renders, and neither
		// unanswered create takes it, though both prompts share its title.
		setFrame(frameWith(first));
		refreshState();
		await waitFor(() => cardCount("AL-9") === 1);
		await holdsFor(
			() => cardCount("AL-9") === 1 && todoPendingCards().length === 2,
		);

		// The answer pairs AL-9 with the first create; the second keeps its placeholder.
		answer(0, jsonResponse(first));
		refreshState();
		const firstLanded = (): boolean =>
			cardCount("AL-9") === 1 && todoPendingCards().length === 1;
		await waitFor(firstLanded);
		await holdsFor(firstLanded);
		refreshState();
		await holdsFor(firstLanded);

		answer(1, jsonResponse(second));
		setFrame(frameWith(first, second));
		refreshState();
		const bothLanded = (): boolean =>
			cardCount("AL-9") === 1 &&
			cardCount("AL-10") === 1 &&
			pendingCards().length === 0;
		await waitFor(bothLanded);
		await holdsFor(bothLanded);
	});
});

test("two failed creates come back one at a time, and the dialog says how many wait", async () => {
	await withCreatePosts(async ({ answer }) => {
		await mountAt("/projects/alpha");
		await addTask("First failed task");
		await addTask("Second failed task");
		expect(todoPendingCards().length).toBe(2);

		answer(0, jsonResponse({ error: "boom" }, 500));
		answer(1, jsonResponse({ error: "boom" }, 500));
		// The first failure reopens New task with its input; the second waits in the queue.
		await waitFor(
			() =>
				pendingCards().length === 0 &&
				newTaskOpen() &&
				waitingLine() === oneWaiting,
		);
		expect(newTaskBox()?.value).toBe("First failed task");
		expect(
			newTaskDialog()?.querySelector('[role="alert"]')?.textContent,
		).toContain("Not added: boom");
		await waitFor(() => appErrorRow() !== null);

		// Clear the draft and close: the next open brings the second task back.
		await typeNewTask("");
		await closeNewTask();
		expect(loadComposeDraft("new:alpha")?.text ?? "").toBe("");
		await openNewTask();
		await waitFor(() => newTaskBox()?.value === "Second failed task");
		expect(waitingLine()).toBeNull();
	});
});

test("a newer unsent draft wins over a failed create, which waits for the next open", async () => {
	await withCreatePost(async ({ answer }) => {
		await mountAt("/projects/alpha");
		await addTask("Failed task");
		// A new draft, typed and closed while the POST runs: the draft cache keeps it.
		await openNewTask();
		await typeNewTask("Unsent newer draft");
		await closeNewTask();
		expect(loadComposeDraft("new:alpha")?.text).toBe("Unsent newer draft");

		answer(jsonResponse({ error: "boom" }, 500));
		await waitFor(() => pendingCards().length === 0 && appErrorRow() !== null);
		// The dialog does not open over the newer draft, and the draft stays untouched.
		expect(newTaskOpen()).toBe(false);
		expect(loadComposeDraft("new:alpha")?.text).toBe("Unsent newer draft");

		await openNewTask();
		await waitFor(() => waitingLine() === oneWaiting);
		expect(newTaskBox()?.value).toBe("Unsent newer draft");
	});
});

test("New task on the Overview shows a +1 adding chip in the project's Todo cell until the card lands", async () => {
	const rowButton = 'button[aria-label="New task for Alpha"]';
	const chips = (): Element[] =>
		Array.from(
			document
				.querySelector(rowButton)
				?.closest("tr")
				?.querySelectorAll('td[data-label="Todo"] .pending-count') ?? [],
		);
	await withCreatePost(async ({ answer }) => {
		await mountAt("/", () => document.querySelector(rowButton) !== null);
		await addTask(newTaskText, rowButton);
		expect(newTaskOpen()).toBe(false);
		await waitFor(() => chips().length === 1);
		const chip = chips()[0]!;
		expect(chip.textContent).toContain("+1 adding");
		expect(chip.getAttribute("aria-busy")).toBe("true");
		expect(chip.getAttribute("data-pending-key")).not.toBeNull();
		// Only Alpha's row shows a chip.
		expect(document.querySelectorAll(".pending-count").length).toBe(1);

		setFrame(frameWithNewCard());
		answer(jsonResponse(newCard));
		refreshState();
		await waitFor(
			() => document.querySelectorAll(".pending-count").length === 0,
		);
		expect(newTaskOpen()).toBe(false);
	});
});

/** The `data-active` flag of one board lane: the phone tier shows only the active lane. */
const laneActive = (stage: string): string | null | undefined =>
	document
		.querySelector(`section.stage[data-stage="${stage}"]`)
		?.getAttribute("data-active");

test("New task on another stage tab flips the tabs to Todo, where the placeholder stands", async () => {
	await withCreatePost(async () => {
		await mountAt("/projects/alpha");
		// The stage tabs render at every width; CSS shows them only in the phone tier.
		const inProgress = document.querySelector(
			'.stage-tabs button[role="tab"][data-tab="in_progress"]',
		);
		expect(inProgress).not.toBeNull();
		await act(async () => {
			onClickOf(inProgress!)();
		});
		expect(laneActive("in_progress")).toBe("true");
		expect(laneActive("todo")).toBe("false");

		await addTask(newTaskText);
		expect(laneActive("todo")).toBe("true");
		expect(laneActive("in_progress")).toBe("false");
		expect(
			document
				.querySelector('.stage-tabs button[role="tab"][data-tab="todo"]')
				?.getAttribute("aria-selected"),
		).toBe("true");
		expectPlaceholder();
	});
});

test("a create that fails while the board is not mounted still drops its placeholder", async () => {
	await withCreatePost(async ({ answer, bodies }) => {
		await mountAt("/projects/alpha");
		await addTask(newTaskText);
		expectPlaceholder();

		// Another project's board takes the view: Alpha's board and its placeholder unmount.
		await act(async () => {
			window.history.pushState(null, "", "/projects/beta");
			window.dispatchEvent(new window.PopStateEvent("popstate"));
		});
		await waitFor(
			() =>
				header() === "Beta" &&
				pendingCards().length === 0 &&
				cardEl("AL-1") === null,
		);

		// The POST fails off the board; well past the exit time, nothing is left to drop it.
		answer(jsonResponse({ error: "boom" }, 500));
		await holdsFor(
			() => header() === "Beta" && pendingCards().length === 0,
			80,
		);
		expect(bodies.length).toBe(1);

		// Back on the board, the failed create is gone: no placeholder renders, not even for
		// an exit. The New task dialog may reopen with the text; only placeholders count here.
		let leaked = false;
		await act(async () => {
			window.history.back();
		});
		await waitFor(() => {
			if (pendingCards().length > 0) leaked = true;
			return (
				window.location.pathname === "/projects/alpha" &&
				document.querySelector('section.stage[data-stage="todo"]') !== null
			);
		});
		await holdsFor(() => {
			if (pendingCards().length > 0) leaked = true;
			return true;
		});
		expect(leaked).toBe(false);
	});
});

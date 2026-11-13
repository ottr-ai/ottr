import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeepenCheck } from "../deepen.ts";
import { DEEPEN_POINTS } from "../prompts.ts";
import { parseUsage } from "../quota.ts";
import type {
	PerfMetrics,
	PerfStat,
	ProjectView,
	ProposalSummary,
	PrReviewView,
	StateResponse,
	Task,
	TaskCard,
	TaskView,
	TurnView,
	UpdateRow,
} from "../types.ts";
import {
	FORK_HOLD_REASON,
	MERGE_HOLD_MISMATCH_REASON,
	PR_REVIEW_WAITING,
	UPDATE_HOLD_REASON,
} from "../types.ts";
// Static: models.ts touches no browser global at load, so hoisting is safe.
import { resetCatalogCache } from "./models.ts";
// Static: queue.ts is pure lane math over types.ts and scheduler.ts, no browser global.
import { donePage } from "./queue.ts";

// app.tsx reads sessionStorage at module load; bun test has no browser storage.
globalThis.sessionStorage = {
	length: 0,
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {},
	clear: () => {},
	key: () => null,
} as Storage;
// A static import cannot work: ESM hoists it, so the modules evaluate before the stub above exists.
const {
	UpdateRowLine,
	visibleUpdateRows,
	LaneCol,
	AskBlock,
	triageWait,
	WarningLines,
	RestartWaitLine,
	UpdateCycleControl,
	AppBehindNotice,
	Overview,
	KpiStrip,
	PerfTable,
	coveredUpdateIds,
	implementSteps,
	recommendsSteps,
	serverLine,
	gateAfterLostSession,
	setupHints,
	reportHtml,
	Drawer,
	LogView,
	ProjectBoard,
	RailRows,
	SEARCH_APPLY_MS,
	ComposeDialog,
	FollowUpDialog,
	DeepenReview,
	AddProjectModal,
	OrphanNotice,
	SeedFailedLine,
	ProvisionErrorLine,
	ranOnLabel,
	AuthPage,
	PrReviewSection,
	boardFlipSig,
	cardRenderProbe,
	reuseCards,
	skillGapNote,
} = await import("./app.tsx");
const {
	monogram,
	repoSlug,
	sourceIconUrl,
	ProjectLogo,
	ProjectTag,
	windowGone,
} = await import("./kit.tsx");
const {
	alateChip,
	alateHint,
	provisionWatchStep,
	ALATE_WATCH_MAX_DOWN,
	ALATE_WATCH_DEADLINE_MS,
	SETTINGS_TOC,
	SettingsPage,
} = await import("./settings.tsx");

describe("windowGone", () => {
	const H = 3_600_000;
	const now = 1_000 * H;
	const lim = (o: {
		window?: string | null;
		windowLabel?: string | null;
		label?: string;
		resetsAt?: number | null;
	}) => ({
		provider: "p",
		label: o.label ?? "x",
		window: o.window ?? null,
		windowLabel: o.windowLabel ?? null,
		plan: null,
		usedPct: 10,
		resetsAt: o.resetsAt === undefined ? now + H : o.resetsAt,
	});
	test("reads omp's window id", () => {
		expect(windowGone(lim({ window: "5h", resetsAt: now + 4 * H }), now)).toBe(
			20,
		);
		expect(windowGone(lim({ window: "7d", resetsAt: now + 84 * H }), now)).toBe(
			50,
		);
	});
	test("falls back to the label when omp names no window", () => {
		expect(
			windowGone(
				lim({ label: "ZAI 5 Hours Credit Quota", resetsAt: now + H }),
				now,
			),
		).toBe(80);
		expect(
			windowGone(lim({ label: "Claude 7 Day", resetsAt: now + 168 * H }), now),
		).toBe(0);
		expect(
			windowGone(
				lim({ label: "ZAI Weekly Credit Quota", resetsAt: now + 42 * H }),
				now,
			),
		).toBe(75);
	});
	test("reads named calendar windows by id (Copilot sends daily/weekly/monthly)", () => {
		expect(
			windowGone(lim({ window: "daily", resetsAt: now + 18 * H }), now),
		).toBe(25);
		expect(
			windowGone(lim({ window: "weekly", resetsAt: now + 42 * H }), now),
		).toBe(75);
		// omp's window label is read as well: a named window without an id still gets a bar.
		expect(
			windowGone(
				lim({
					label: "Premium Requests",
					windowLabel: "Monthly",
					resetsAt: Date.UTC(2026, 11, 1),
				}),
				Date.UTC(2026, 10, 16),
			),
		).toBeCloseTo(50);
	});
	test("a monthly window starts one calendar month before the reset, in UTC", () => {
		const day = 86_400_000;
		// March 1 resets: February 2026 has 28 days, February 2028 (leap) has 29.
		const mar2026 = Date.UTC(2026, 2, 1);
		expect(
			windowGone(
				lim({ window: "monthly", resetsAt: mar2026 }),
				mar2026 - 14 * day,
			),
		).toBeCloseTo(50);
		const mar2028 = Date.UTC(2028, 2, 1);
		expect(
			windowGone(
				lim({ window: "monthly", resetsAt: mar2028 }),
				mar2028 - 14.5 * day,
			),
		).toBeCloseTo(50);
	});
	test("omp's Copilot payload shape gives the elapsed fraction of the monthly window", () => {
		const limits = parseUsage(
			JSON.stringify({
				reports: [
					{
						provider: "github-copilot",
						limits: [
							{
								label: "Premium Requests",
								window: {
									id: "monthly",
									label: "Monthly",
									resetsAt: Date.UTC(2026, 11, 1),
								},
								amount: { usedFraction: 0.4 },
							},
						],
					},
				],
			}),
		);
		// December's window runs 2026-11-01 -> 2026-12-01 UTC; half gone by Nov 16.
		expect(windowGone(limits[0]!, Date.UTC(2026, 10, 16))).toBeCloseTo(50);
	});
	test("unknown length or reset gives null; a past reset clamps to 100", () => {
		expect(windowGone(lim({ label: "Premium Requests" }), now)).toBeNull();
		expect(windowGone(lim({ window: "5h", resetsAt: null }), now)).toBeNull();
		expect(windowGone(lim({ window: "5h", resetsAt: now - H }), now)).toBe(100);
		expect(windowGone(lim({ window: "5h", resetsAt: now + 9 * H }), now)).toBe(
			0,
		);
	});
});

describe("monogram", () => {
	test("initials of the first two words, else the first two characters", () => {
		expect(monogram("agent-data")).toBe("AD");
		expect(monogram("Omp task tracker")).toBe("OT");
		expect(monogram("ottr")).toBe("OT");
		expect(monogram("x")).toBe("X");
		expect(monogram("_ünïcode")).toBe("ÜN");
		expect(monogram("--")).toBe("--");
	});
	test("takes whole characters: astral letters and combining marks stay intact", () => {
		for (const [label, tag] of [
			["A𐐀", "A𐐀"],
			["𐐀 Repo", "𐐀R"],
			["𐐨𐐨", "𐐀𐐀"],
			["e\u0301tude-app", "E\u0301A"],
		] as const) {
			const got = monogram(label);
			expect(got).toBe(tag);
			expect(got.isWellFormed()).toBe(true);
		}
	});
});

describe("sourceIconUrl", () => {
	const p = (remote: string | null) =>
		({ remote, icon: null, name: "demo", github: null }) as Parameters<
			typeof sourceIconUrl
		>[0];
	test("a GitHub repo adopts the owner's avatar, owner only, not the repo", () => {
		expect(sourceIconUrl(p("https://github.com/octo/repo"))).toBe(
			"https://github.com/octo.png?size=64",
		);
	});
	test("no remote: nothing to adopt from", () => {
		expect(sourceIconUrl(p(null))).toBe(null);
	});
	test("another host adopts the host's favicon", () => {
		expect(sourceIconUrl(p("https://gitlab.com/octo/repo"))).toBe(
			"https://gitlab.com/favicon.ico",
		);
		expect(sourceIconUrl(p("https://git.example.com/octo/repo"))).toBe(
			"https://git.example.com/favicon.ico",
		);
	});
	test("an invalid URL string: nothing to adopt from", () => {
		expect(sourceIconUrl(p("::not a url"))).toBe(null);
	});
	test("www.github.com is treated like github.com", () => {
		expect(sourceIconUrl(p("https://www.github.com/octo/repo"))).toBe(
			"https://github.com/octo.png?size=64",
		);
	});
	test("a GitHub URL without an owner: nothing to adopt from", () => {
		expect(sourceIconUrl(p("https://github.com/"))).toBe(null);
	});
});

describe("repoSlug", () => {
	test("the last two path segments are the owner/repo slug", () => {
		expect(repoSlug("https://github.com/octo/repo")).toBe("octo/repo");
	});
	test(".git and a trailing slash are stripped", () => {
		expect(repoSlug("https://github.com/octo/repo.git")).toBe("octo/repo");
		expect(repoSlug("https://github.com/octo/repo/")).toBe("octo/repo");
	});
	test("any host works: the slug is the URL tail", () => {
		expect(repoSlug("https://git.example.com/team/proj")).toBe("team/proj");
	});
	test("a URL without an owner/repo tail: no slug", () => {
		expect(repoSlug("https://github.com/octo")).toBe(null);
		expect(repoSlug("https://github.com/")).toBe(null);
	});
	test("an invalid URL string: no slug", () => {
		expect(repoSlug("::not a url")).toBe(null);
	});
});

describe("ProjectTag", () => {
	const p = (icon: number | null, iconText: string | null) =>
		({
			remote: "https://github.com/octo/repo",
			icon,
			name: "demo",
			github: "https://github.com/octo/repo",
			settings: { displayName: null, iconText },
		}) as Parameters<typeof ProjectTag>[0]["project"];
	const html = (x: Parameters<typeof ProjectTag>[0]["project"]) =>
		renderToStaticMarkup(<ProjectTag project={x} />);
	test("the text marker wins over the upload and the source avatar: text on the plate, no image", () => {
		const out = html(p(123, "GD"));
		expect(out).toContain("tag-text");
		expect(out).toContain(">GD<");
		expect(out).not.toContain("<img");
	});
	test("without a marker the uploaded icon still shows", () => {
		const out = html(p(123, null));
		expect(out).toContain("<img");
		expect(out).not.toContain("tag-text");
	});
});

describe("ProjectLogo", () => {
	const p = (github: string | null, remote: string | null) =>
		({
			remote,
			icon: null,
			name: "demo",
			github,
			// projectLabel reads settings.displayName; the monogram branch renders when no icon/remote exists.
			settings: { displayName: null },
		}) as Parameters<typeof ProjectLogo>[0]["project"];
	const html = (x: Parameters<typeof ProjectLogo>[0]["project"]) =>
		renderToStaticMarkup(<ProjectLogo project={x} />);
	test("the GitHub view wins and opens in a new tab", () => {
		const out = html(p("https://github.com/octo/repo", "https://x.test/r"));
		expect(out).toContain('href="https://github.com/octo/repo"');
		expect(out).toContain('rel="noopener noreferrer"');
		expect(out).toContain("<img");
		// The adopted icon is the one legit remote image; it must not leak the board origin.
		expect(out).toContain('referrerPolicy="no-referrer"');
	});
	test("no GitHub: the HTTPS origin remote is the link", () => {
		expect(html(p(null, "https://gitlab.com/octo/repo"))).toContain(
			'href="https://gitlab.com/octo/repo"',
		);
	});
	test("neither: a plain tag, no anchor", () => {
		const out = html(p(null, null));
		expect(out).not.toContain("<a ");
		expect(out).toContain('class="ptag"');
	});
});

const removedRow: UpdateRow = {
	id: "octo/repo@rm1",
	name: "demo-skill",
	kind: "skill",
	origin: "https://github.com/octo/upstream",
	repo: "octo/repo",
	pin: { file: "skills/demo/SKILL.md", key: "skill" },
	current: "1.0.0",
	latest: "1.1.0",
	target: null,
	publishedAt: "2026-10-13T06:00:00Z",
	qualifiesAt: "2026-10-20T06:00:00Z",
	notesUrl: "https://github.com/octo/upstream/compare/v1.0.0...v1.1.0",
	project: "demo",
	removed: true,
};

const youngRow: UpdateRow = {
	...removedRow,
	id: "octo/repo@young1",
	name: "fresh-skill",
	removed: undefined,
};

const qualifiedRow: UpdateRow = {
	...removedRow,
	id: "octo/repo@q1",
	name: "old-skill",
	latest: "2.0.0",
	target: "1.2.0",
	removed: undefined,
};

describe("visibleUpdateRows", () => {
	test("young releases hide until the 7-day rule is ignored; qualified and removed stay", () => {
		const rows = [qualifiedRow, youngRow, removedRow];
		expect(visibleUpdateRows(rows, false).map((r) => r.id)).toEqual([
			qualifiedRow.id,
			removedRow.id,
		]);
		expect(visibleUpdateRows(rows, true)).toEqual(rows);
	});
});

describe("UpdateRowLine", () => {
	test("a removed row shows 'Removed upstream' with Remove and Skip, no pick and no target", () => {
		const html = renderToStaticMarkup(
			<UpdateRowLine
				row={removedRow}
				act={async () => true}
				card={null}
				selected={false}
				onToggle={() => {}}
				openTask={() => {}}
			/>,
		);
		expect(html).toContain("Removed upstream");
		// No checkbox to select it for approval, but Skip dismisses the row
		// (keep the local copy) via POST /api/updates/skip.
		expect(html).not.toContain("updates-box");
		expect(html).toContain('class="updates-skip ghost"');
		expect(html).toContain(">Skip</button>");
		// Remove files a card that pins the removed upstream row.
		expect(html).toContain(">Remove</button>");
		expect(html).toContain('class="updates-remove ghost"');
		// A removed row shows only the current pin: no arrow, no target, no qualifies.
		expect(html).toContain("<code>1.0.0</code>");
		expect(html).not.toContain("updates-arrow");
		expect(html).not.toContain("qualifies");
	});

	test("a covered removed row shows in progress instead of Remove and Skip", () => {
		const html = renderToStaticMarkup(
			<UpdateRowLine
				row={removedRow}
				act={async () => true}
				card={cardFixture({ id: "t9", updateIds: [removedRow.id] })}
				selected={false}
				onToggle={() => {}}
				openTask={() => {}}
			/>,
		);
		expect(html).toContain("Removed upstream");
		expect(html).toContain(">in progress</a>");
		expect(html).not.toContain(">Remove</button>");
		expect(html).not.toContain(">Skip</button>");
	});

	test("a plain row renders no decision chip", () => {
		const html = renderToStaticMarkup(
			<UpdateRowLine
				row={qualifiedRow}
				act={async () => true}
				card={null}
				selected={false}
				onToggle={() => {}}
				openTask={() => {}}
			/>,
		);
		expect(html).not.toContain("updates-decision");
	});
});

const cardFixture = (
	over: Partial<TaskCard> &
		Partial<Pick<Task, "details" | "report">> & { prReview?: PrReviewView },
): TaskCard =>
	({
		id: "t1",
		title: "Task one",
		sessionTitle: "Task one",
		prompt: "work",
		summary: null,
		project: "proj",
		state: "queued",
		stage: "todo",
		cancelledAt: null,
		createdAt: 0,
		doneAt: null,
		dependsOn: [],
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
		// ponytail: render test reads only the fields above; the cast keeps the fixture short.
	}) as unknown as TaskCard;

describe("LaneCol backlog divider", () => {
	const base = {
		projectTasks: [] as TaskCard[],
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: () => {},
		unread: () => false,
		onReorder: async () => true,
		filtering: false,
		draining: false,
	} as const;

	test("regular cards sit above the divider, backlog cards below the label", () => {
		const todo = cardFixture({ id: "t1", stage: "todo", state: "queued" });
		const parked = cardFixture({ id: "b1", stage: "backlog", state: "idle" });
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="todo"
				tasks={[todo]}
				parked={[parked]}
				parkedTotal={1}
			/>,
		);
		expect(html).toContain("lane-divider");
		expect(html).toContain("Backlog");
		expect(html).toContain('data-stage="backlog"');
		// The todo card renders before the divider, the backlog card after it.
		expect(html.indexOf('data-task-id="t1"')).toBeLessThan(
			html.indexOf("lane-divider"),
		);
		expect(html.indexOf('data-task-id="b1"')).toBeGreaterThan(
			html.indexOf("Backlog"),
		);
	});

	test("an unread PR review card wears the new badge with its own tooltip", () => {
		const pr = cardFixture({
			id: "p1",
			kind: "pr_review",
			stage: "done",
			state: "idle",
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[pr]} unread={() => true} />,
		);
		expect(html).toContain('class="unread"');
		expect(html).toContain('title="New PR review"');
		// An answered work card keeps the answer tooltip.
		const answered = cardFixture({
			id: "t9",
			stage: "done",
			state: "idle",
			answered: true,
		});
		const work = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[answered]} unread={() => true} />,
		);
		expect(work).toContain('title="Answered; not opened yet"');
	});

	test("a default card's chip states the model its last run used", () => {
		const ran = cardFixture({
			id: "t1",
			stage: "todo",
			state: "running",
			model: null,
			lastModel: "zai/glm-5.3-flash",
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="todo" tasks={[ran]} />,
		);
		// The chip drops the provider; its tooltip keeps the full id.
		expect(html).toContain(">glm-5.3-flash</span>");
		expect(html).toContain("Main loop model: zai/glm-5.3-flash (last run)");
		// No run recorded a model yet: the chip stays on the literal default.
		const fresh = cardFixture({
			id: "t2",
			stage: "todo",
			state: "queued",
			model: null,
		});
		const bare = renderToStaticMarkup(
			<LaneCol {...base} stage="todo" tasks={[fresh]} />,
		);
		expect(bare).toContain(">default</span>");
		// A pinned model wins over the run history.
		const pinned = cardFixture({
			id: "t3",
			stage: "todo",
			state: "queued",
			model: "a/big",
			lastModel: "a/one",
		});
		const pin = renderToStaticMarkup(
			<LaneCol {...base} stage="todo" tasks={[pinned]} />,
		);
		expect(pin).toContain(">big</span>");
		expect(pin).toContain('title="Main loop model: a/big"');
		// The thinking effort stays off the chip; the tooltip keeps the full selector.
		const leveled = cardFixture({
			id: "t4",
			stage: "todo",
			state: "queued",
			model: "zai/glm-5.3-flash:max",
		});
		const eff = renderToStaticMarkup(
			<LaneCol {...base} stage="todo" tasks={[leveled]} />,
		);
		expect(eff).toContain(">glm-5.3-flash</span>");
		expect(eff).toContain('title="Main loop model: zai/glm-5.3-flash:max"');
	});

	test("a lane with only backlog cards still renders", () => {
		const parked = cardFixture({ id: "b1", stage: "backlog", state: "idle" });
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="todo" tasks={[]} parked={[parked]} />,
		);
		expect(html).toContain("lane-divider");
		expect(html).toContain("Backlog");
		expect(html).not.toContain("Nothing waiting.");
	});

	test("an empty todo lane still shows the backlog row", () => {
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="todo"
				tasks={[]}
				parked={[]}
				parkedTotal={0}
				onAddDraft={() => {}}
			/>,
		);
		expect(html).toContain("Backlog");
		expect(html).toContain("Add draft");
		expect(html).toContain("Nothing waiting.");
	});

	test("a non-todo lane with no cards stays stage-empty", () => {
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[]} />,
		);
		expect(html).toContain("Nothing landed yet.");
		expect(html).not.toContain("Backlog");
	});

	test("the done lane shows its Show more button only with hidden cards", () => {
		const done = [
			cardFixture({ id: "t1", stage: "done", state: "idle" }),
			cardFixture({ id: "t2", stage: "done", state: "idle" }),
		];
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={done}
				more={25}
				onMore={() => {}}
			/>,
		);
		expect(html).toContain("lane-more");
		expect(html).toContain("Show more");
		expect(html).toContain(">25</span>");
		const none = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={done}
				more={0}
				onMore={() => {}}
			/>,
		);
		expect(none).not.toContain("lane-more");
		const defaultOff = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={done} />,
		);
		expect(defaultOff).not.toContain("lane-more");
	});

	test("a running card's mutation line shows the percent and the time left only", () => {
		const run = cardFixture({
			id: "m1",
			stage: "in_progress",
			state: "running",
			progress:
				"Stryker 68% · 4454/6523 · 38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left",
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="in_progress" tasks={[run]} />,
		).replaceAll("<!-- -->", "");
		expect(html).toContain(
			'>Mutation <span class="card-mutation-value">68%</span> · ~1h 23m left<',
		);
		// The left-edge rail fills to the run's percent: the rail's --p drives fill and end dot.
		expect(html).toMatch(
			/class="mutation-rail"[^>]* style="--p:0.68"><i><\/i><b><\/b>/,
		);
		// Counts, survivors and elapsed time stay on the row's title, off the card face.
		expect(html).toContain('title="Stryker 68% · 4454/6523 · 38 survived');
		expect(html).not.toContain(">4454/6523<");
		expect(html).not.toContain("elapsed<");
		expect(html).not.toContain(">Stryker<");
	});

	test("a live turn's card meta ticks elapsed instead of the card age, then estimates", () => {
		const since = Date.now() - 65_000;
		const live = cardFixture({
			id: "l1",
			stage: "in_progress",
			state: "running",
			runStartedAt: since,
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="in_progress" tasks={[live]} />,
		).replaceAll("<!-- -->", "");
		// The ticking elapsed clock replaces the card age.
		expect(html).toMatch(/class="card-meta"[^>]*>\s*1m /);
		expect(html).not.toContain("ago</span>");
		// The status words move into the ticking line, not a second fragment.
		expect(html).toContain("1m · running");
		// Thin history: no estimate without etaMs.
		expect(html).not.toContain("about");

		const withEta = cardFixture({
			id: "l2",
			stage: "in_progress",
			state: "running",
			runStartedAt: since,
			// The +30s keeps the remaining floor mid-bucket: real-clock drift between the
			// fixture and the render must not flip "about 4m left" down to "3m left".
			etaMs: 65_000 + 4 * 60_000 + 30_000,
		});
		const etaHtml = renderToStaticMarkup(
			<LaneCol {...base} stage="in_progress" tasks={[withEta]} />,
		).replaceAll("<!-- -->", "");
		expect(etaHtml).toContain("1m · running · about 4m left ");

		// The estimate is used up once the median is behind the elapsed time.
		const spent = cardFixture({
			id: "l3",
			stage: "in_progress",
			state: "running",
			runStartedAt: since,
			etaMs: 60_000,
		});
		const spentHtml = renderToStaticMarkup(
			<LaneCol {...base} stage="in_progress" tasks={[spent]} />,
		).replaceAll("<!-- -->", "");
		expect(spentHtml).not.toContain("about");
		expect(spentHtml).toContain("1m · running");
	});

	test("a running card with a Stryker line keeps its Mutation span and takes no median estimate", () => {
		const since = Date.now() - 65_000;
		const run = cardFixture({
			id: "m2",
			stage: "in_progress",
			state: "running",
			runStartedAt: since,
			etaMs: 65_000 + 4 * 60_000,
			progress:
				"Stryker 68% · 4454/6523 · 38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left",
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="in_progress" tasks={[run]} />,
		).replaceAll("<!-- -->", "");
		expect(html).toContain(
			'>Mutation <span class="card-mutation-value">68%</span> · ~1h 23m left<',
		);
		// The card meta still ticks elapsed, but the card's own progress is the better
		// estimate: no median "about X left" and no duplicate status words.
		expect(html).toMatch(/class="card-meta"[^>]*>\s*1m\s*</);
		expect(html).not.toContain("about 4m left");
		expect(html).not.toContain("· running");
	});

	test("a running review card counts its landed findings instead of reading running", () => {
		const since = Date.now() - 65_000;
		const review = cardFixture({
			id: "rv1",
			kind: "review",
			stage: "in_progress",
			state: "running",
			runStartedAt: since,
		});
		const done = cardFixture({
			id: "f1",
			title: "finding one",
			followUpOf: "rv1",
			stage: "done",
			state: "idle",
			doneAt: 5,
		});
		const open = cardFixture({
			id: "f2",
			title: "finding two",
			followUpOf: "rv1",
		});
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="in_progress"
				tasks={[review]}
				projectTasks={[review, done, open]}
			/>,
		).replaceAll("<!-- -->", "");
		// The count rides the ticking meta line in place of the bare "running".
		expect(html).toContain("1m · 1 of 2 findings done");
		expect(html).not.toContain("· running<");
	});

	test("a queued card names its queue slot", () => {
		const second = cardFixture({
			id: "q2",
			stage: "todo",
			state: "queued",
			queuedAt: 20,
		});
		const first = cardFixture({
			id: "q1",
			stage: "todo",
			state: "queued",
			queuedAt: 10,
		});
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="todo"
				tasks={[first, second]}
				projectTasks={[first, second]}
			/>,
		).replaceAll("<!-- -->", "");
		// Earlier queuedAt runs first, so q1 reads #1.
		expect(html).toContain("#1 in queue");
		expect(html).toContain("#2 in queue");
		expect(html).not.toContain(">queued<");
	});

	test("a held card counts down, names the provider, and carries the reason for hover and readers", () => {
		const reason =
			"The openai-codex usage limit is reached. The board starts the task again after the limit resets at 2026-11-10 11:51 UTC. Send a message to run it now, or cancel the card.";
		const held = cardFixture({
			id: "h1",
			stage: "todo",
			state: "queued",
			needsReason: reason,
			// Half a minute inside the 13m bucket: the floor survives the render's Date.now.
			holdUntil: Date.now() + 13 * 60_000 + 30_000,
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="todo" tasks={[held]} projectTasks={[held]} />,
		).replaceAll("<!-- -->", "");
		expect(html).toContain("held · openai-codex limit · 13m left");
		// The hover title and the sr line carry the full reason.
		expect(html).toContain(`title="${reason}"`);
		expect(html).toContain(`<span class="sr">${reason}</span>`);
		// The raw reset stamp stays off the visible face: it rides only in the title
		// attribute and the sr line.
		const visible = html
			.replace(/ title="[^"]*"/g, "")
			.replace(/<span class="sr">[^<]*<\/span>/g, "");
		expect(visible).toContain("held · openai-codex limit · 13m left");
		expect(visible).not.toContain("resets at 2026-11-10");
	});

	test("a held card with an unnamed cause keeps the bare countdown", () => {
		const held = cardFixture({
			id: "h2",
			stage: "todo",
			state: "queued",
			needsReason: "An open prompt edit holds the card.",
			holdUntil: Date.now() + 13 * 60_000 + 30_000,
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="todo" tasks={[held]} projectTasks={[held]} />,
		).replaceAll("<!-- -->", "");
		expect(html).toContain("held · 13m left");
		expect(html).not.toContain("limit · 13m left");
		// The reason still reaches hover and readers on the plain label.
		expect(html).toContain('title="An open prompt edit holds the card."');
		expect(html).toContain(
			'<span class="sr">An open prompt edit holds the card.</span>',
		);
	});
});

describe("done lane star section", () => {
	const base = {
		projectTasks: [] as TaskCard[],
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: () => {},
		unread: () => false,
		onReorder: async () => true,
		filtering: false,
		draining: false,
	} as const;

	test("a starred done research card renders the star in place of the check, a plain card the check", () => {
		const research = cardFixture({
			id: "r1",
			stage: "done",
			state: "idle",
			research: true,
			starred: true,
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[research]} />,
		);
		expect(html).toContain("mark-star");
		expect(html).not.toContain("mark-done");
		// The star is state only: no button on the card.
		expect(html).not.toContain("card-star");
		expect(html).not.toContain('aria-pressed="true"');
		const plain = cardFixture({ id: "w1", stage: "done", state: "idle" });
		const bare = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[plain]} />,
		);
		expect(bare).toContain("mark-done");
		expect(bare).not.toContain("mark-star");
	});

	test("the Starred section sits below Inbox and above normal done cards", () => {
		const freshCard = cardFixture({
			id: "u1",
			stage: "done",
			state: "idle",
			answered: true,
		});
		const starredCard = cardFixture({
			id: "s1",
			stage: "done",
			state: "idle",
			research: true,
			starred: true,
		});
		const normal = cardFixture({ id: "n1", stage: "done", state: "idle" });
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={[starredCard, normal, freshCard]}
				unread={(t) => t.id === "u1"}
			/>,
		);
		const inboxAt = html.indexOf(">Inbox</p>");
		const starredAt = html.indexOf(">Starred</span>");
		const normalAt = html.indexOf('data-task-id="n1"');
		expect(inboxAt).toBeGreaterThanOrEqual(0);
		expect(starredAt).toBeGreaterThan(inboxAt);
		expect(normalAt).toBeGreaterThan(starredAt);
		// The starred card left the normal list.
		expect(html.match(/data-task-id="s1"/g)?.length).toBe(1);
	});

	test("the Starred head toggles collapsed state", () => {
		const starredCard = cardFixture({
			id: "s1",
			stage: "done",
			state: "idle",
			research: true,
			starred: true,
		});
		const open = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[starredCard]} />,
		);
		expect(open).toContain('aria-expanded="true"');
		expect(open).not.toContain("data-collapsed");
		const shut = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[starredCard]} starredCollapsed />,
		);
		expect(shut).toContain('aria-expanded="false"');
		expect(shut).toContain('data-collapsed="true"');
	});

	test("a collapsed Starred section leaves one divider, an open one two", () => {
		const freshCard = cardFixture({
			id: "u1",
			stage: "done",
			state: "idle",
			answered: true,
		});
		const starredCard = cardFixture({
			id: "s1",
			stage: "done",
			state: "idle",
			research: true,
			starred: true,
		});
		const normal = cardFixture({ id: "n1", stage: "done", state: "idle" });
		const tasks = [starredCard, normal, freshCard];
		const open = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={tasks}
				unread={(t) => t.id === "u1"}
			/>,
		);
		// One rule between Inbox and Starred, one between Starred and the rest.
		expect(open.match(/lane-divider/g)?.length).toBe(2);
		const shut = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={tasks}
				unread={(t) => t.id === "u1"}
				starredCollapsed
			/>,
		);
		// The collapsed head's own fill replaces the vanished trailing rule.
		expect(shut.match(/lane-divider/g)?.length).toBe(1);
		expect(shut.indexOf("lane-divider")).toBeLessThan(
			shut.indexOf(">Starred</span>"),
		);
	});

	test("a done research steps card pins in the Inbox and sits with the read cards once seen", () => {
		const stepsCard = cardFixture({
			id: "r1",
			stage: "done",
			state: "idle",
			research: true,
			steps: "yes",
			report: "## Recommended steps\n\n1. Buy the rack",
		});
		const answered = cardFixture({
			id: "q1",
			stage: "done",
			state: "idle",
			answered: true,
		});
		const normal = cardFixture({ id: "n1", stage: "done", state: "idle" });
		// Static markup cannot fire events, so the seen set is the `unread` callback:
		// clearing a steps report = the callback stops naming the id, marking it unread again re-pins.
		const pinned = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={[stepsCard, normal, answered]}
				unread={(t) => t.id === "r1"}
			/>,
		);
		expect(pinned).toContain(">Inbox</p>");
		expect(pinned.indexOf('data-task-id="r1"')).toBeLessThan(
			pinned.indexOf("lane-divider"),
		);
		// The same id in the seen set rides below the divider with the read cards.
		const read = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={[stepsCard, normal, answered]}
				unread={(t) => t.id === "q1"}
			/>,
		);
		expect(read).toContain(">Inbox</p>"); // the answered card keeps its own pin
		expect(read.indexOf('data-task-id="r1"')).toBeGreaterThan(
			read.indexOf("lane-divider"),
		);
	});

	test("no Starred section renders without a starred card", () => {
		const normal = cardFixture({ id: "n1", stage: "done", state: "idle" });
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[normal]} />,
		);
		expect(html).not.toContain(">Starred</span>");
	});
});

describe("alateChip", () => {
	const ok = {
		state: "ok",
		version: null,
		behind: false,
		pending: false,
	} as const;
	test("configuration outranks the probe, the probe outranks the last provision", () => {
		const label = (...a: Parameters<typeof alateChip>) => alateChip(...a).label;
		expect(label("", false, { state: "down" }, "boom")).toBe("Not configured");
		expect(label("http://a", false, { state: "down" }, "boom")).toBe(
			"No API key",
		);
		expect(label("http://a", true, null, "boom")).toBe("Checking…");
		expect(label("http://a", true, { state: "down" }, "boom")).toBe(
			"Unreachable",
		);
		expect(label("http://a", true, ok, "boom")).toBe("Provision failed");
		// A connected chip also names the update state, so no hint line repeats it.
		expect(alateChip("http://a", true, ok, null)).toEqual({
			label: "Connected · up to date",
			tone: "ok",
		});
	});
});

describe("alateHint", () => {
	test("a pending import is named; a provisioned server is not", () => {
		expect(
			alateHint({
				state: "ok",
				version: "1.2.3",
				behind: false,
				pending: true,
			}),
		).toBe("version 1.2.3 · import pending");
		expect(
			alateHint({
				state: "ok",
				version: "1.2.3",
				behind: false,
				pending: false,
			}),
		).toBe("version 1.2.3");
	});

	test("pending combines with the update flag and the versionless state", () => {
		expect(
			alateHint({ state: "ok", version: "1.2.3", behind: true, pending: true }),
		).toBe("version 1.2.3 · update available · import pending");
		expect(
			alateHint({ state: "ok", version: null, behind: false, pending: true }),
		).toBe("import pending");
		expect(
			alateHint({ state: "ok", version: null, behind: true, pending: false }),
		).toBe("update available");
		expect(
			alateHint({ state: "ok", version: null, behind: false, pending: false }),
		).toBe("up to date");
		expect(alateHint({ state: "down" })).toBe("server unreachable");
	});

	test("a running provision is named and replaces the pending flag while it consumes the import", () => {
		expect(
			alateHint({
				state: "ok",
				version: "1.2.3",
				behind: false,
				pending: true,
				running: true,
			}),
		).toBe("version 1.2.3 · provision running");
		expect(
			alateHint({
				state: "ok",
				version: null,
				behind: false,
				pending: true,
				running: true,
			}),
		).toBe("provision running");
	});
});

describe("gateAfterLostSession", () => {
	test("a board still in setup keeps the setup gate; every other gate turns to login", () => {
		// A fresh compose board walls /api/state (401) before any admin exists: login there strands the user.
		expect(gateAfterLostSession("setup")).toBe("setup");
		expect(gateAfterLostSession(null)).toBe("login");
		expect(gateAfterLostSession("login")).toBe("login");
	});
});

describe("setupHints", () => {
	const server = {
		url: "http://x",
		keySet: true,
		lastError: null,
		health: {
			state: "ok",
			version: "1",
			behind: false,
			pending: false,
			running: false,
		},
	} as const;
	test("a missing server, a failed provision and a failed fetch each give one row", () => {
		expect(
			setupHints(
				{
					server: null,
					workers: [],
					userLayer: { skills: [], plugins: [], rules: [], mcp: [] },
				},
				null,
			),
		).toEqual([{ text: "Agent server: not configured.", kind: "warn" }]);
		expect(
			setupHints(
				{
					server: { ...server, lastError: "boom" },
					workers: [],
					userLayer: { skills: [], plugins: [], rules: [], mcp: [] },
				},
				null,
			),
		).toEqual([
			{ text: "version 1 · last provision failed: boom", kind: "crit" },
		]);
		expect(setupHints(null, "HTTP 500")).toEqual([
			{ text: "Provisioning data unavailable: HTTP 500", kind: "warn" },
		]);
	});
	test("a healthy server and a load still in flight give no row", () => {
		expect(
			setupHints(
				{
					server,
					workers: [],
					userLayer: { skills: [], plugins: [], rules: [], mcp: [] },
				},
				null,
			),
		).toEqual([]);
		expect(setupHints(null, null)).toEqual([]);
	});
});

describe("serverLine", () => {
	const healthy = {
		url: "http://x",
		keySet: true,
		lastError: null,
		health: {
			state: "ok",
			version: "1.2.3",
			behind: false,
			pending: false,
			running: false,
		},
	} as const;

	test("not configured is a warning with the settings hint", () => {
		expect(serverLine(null)).toEqual({
			text: "Agent server: not configured.",
			kind: "warn",
		});
	});

	test("a clean probe is ok", () => {
		expect(serverLine(healthy)).toEqual({ text: "version 1.2.3", kind: "ok" });
	});

	test("a running provision replaces the pending flag, still ok", () => {
		expect(
			serverLine({
				...healthy,
				health: { ...healthy.health, running: true, pending: true },
			}),
		).toEqual({ text: "version 1.2.3 · provision running", kind: "ok" });
	});

	test("a missing key is a warning", () => {
		const line = serverLine({ ...healthy, keySet: false });
		expect(line.kind).toBe("warn");
		expect(line.text.endsWith(" · no API key")).toBe(true);
	});

	test("a down probe is a warning", () => {
		expect(
			serverLine({ ...healthy, keySet: false, health: { state: "down" } }),
		).toEqual({
			text: "server unreachable · no API key",
			kind: "warn",
		});
	});

	test("a recorded provision failure is critical and wins", () => {
		const line = serverLine({ ...healthy, lastError: "boom" });
		expect(line.kind).toBe("crit");
		expect(line.text).toContain("last provision failed: boom");
	});
});

describe("provisionWatchStep", () => {
	const running = {
		state: "ok",
		version: null,
		behind: false,
		pending: true,
		running: true,
	} as const;
	const down = { state: "down" } as const;

	test("a provision alate no longer reports as running has finished", () => {
		expect(provisionWatchStep({ ...running, running: false }, 0, 0)).toBe(
			"finished",
		);
		// Even past the deadline, a converged run is reported as finished.
		expect(
			provisionWatchStep(
				{ ...running, running: false },
				0,
				ALATE_WATCH_DEADLINE_MS,
			),
		).toBe("finished");
	});

	test("the watch gives up once alate stops answering for enough probes", () => {
		expect(provisionWatchStep(down, ALATE_WATCH_MAX_DOWN - 1, 0)).toBe("wait");
		expect(provisionWatchStep(down, ALATE_WATCH_MAX_DOWN, 0)).toBe("lost");
	});

	test("a run that alate keeps reporting stops being followed at the deadline", () => {
		expect(provisionWatchStep(running, 0, ALATE_WATCH_DEADLINE_MS - 1)).toBe(
			"wait",
		);
		expect(provisionWatchStep(running, 0, ALATE_WATCH_DEADLINE_MS)).toBe(
			"expired",
		);
		// A down probe short of the limit still ends at the deadline.
		expect(provisionWatchStep(down, 1, ALATE_WATCH_DEADLINE_MS)).toBe(
			"expired",
		);
	});
});

describe("AskBlock", () => {
	const base = {
		name: "ask-0",
		answered: false,
		selected: null,
		busy: false,
		changed: [],
		onOpenDiff: () => {},
		onAnswer: () => {},
		onDraft: () => {},
	};
	const multiQ = {
		question: "Pick several",
		options: [{ label: "A", description: "first" }, { label: "B" }],
		multi: true,
		recommended: 0,
	};

	test("a multi question renders checkboxes and a disabled Answer button", () => {
		const html = renderToStaticMarkup(<AskBlock {...base} q={multiQ} />);
		expect(html).toContain('type="checkbox"');
		expect(html).not.toContain('type="radio"');
		// Nothing picked and nothing typed: the send stays disabled.
		expect(html).toContain("Answer");
		expect(html).toContain("disabled");
	});

	test("a changed file path quoted in the question renders as a diff link", () => {
		const html = renderToStaticMarkup(
			<AskBlock
				{...base}
				changed={["src/prompts.ts"]}
				q={{
					...multiQ,
					question:
						"The spec proposes new wording in src/prompts.ts. Do you approve?",
				}}
			/>,
		);
		// The path is a button that opens the file's diff, not prose.
		expect(html).toContain(
			'<button type="button" class="diff-link" title="View this file&#x27;s diff">src/prompts.ts</button>',
		);
	});

	test("a quoted path without changes renders as plain text", () => {
		const html = renderToStaticMarkup(
			<AskBlock
				{...base}
				q={{
					...multiQ,
					question: "The spec docs/specs/token-expiry.md proposes wording.",
				}}
			/>,
		);
		expect(html).not.toContain("diff-link");
		expect(html).toContain("docs/specs/token-expiry.md");
	});

	test("a saved multi answer re-checks its presets and counts them", () => {
		const html = renderToStaticMarkup(
			<AskBlock {...base} q={multiQ} answered selected="A, B" />,
		);
		// Both picked presets render checked; the custom row's checkbox stays unchecked.
		expect(html.split('checked=""').length - 1).toBe(2);
		// The picks already are the recorded answer: the button has nothing to add.
		expect(html).toContain("Answered (2)");
		expect(html).toContain('type="submit" disabled=""');
	});

	test("a single question stays a radio group that answers in one click", () => {
		const html = renderToStaticMarkup(
			<AskBlock
				{...base}
				q={{
					...multiQ,
					multi: false,
					options: [{ label: "A" }, { label: "B" }],
				}}
			/>,
		);
		expect(html).toContain('type="radio"');
		expect(html).not.toContain('type="checkbox"');
	});

	test("a saved multi answer's custom part re-fills the Other field on remount", () => {
		const html = renderToStaticMarkup(
			<AskBlock {...base} q={multiQ} answered selected="A, handwritten note" />,
		);
		// The preset and the Other row both count; the typed part is back in the field.
		expect(html.split('checked=""').length - 1).toBe(2);
		expect(html).toContain('value="handwritten note"');
		expect(html).toContain("(2)");
	});

	test("a saved bare Other pick re-checks the Other row with an empty field", () => {
		const html = renderToStaticMarkup(
			<AskBlock {...base} q={multiQ} answered selected="A, Other" />,
		);
		expect(html.split('checked=""').length - 1).toBe(2);
		expect(html).toContain('value=""');
		expect(html).toContain("(2)");
	});
});

describe("AskBlock multi answers", () => {
	// React interaction needs browser globals; the same happy-dom swap as the
	// ProjectBoard search delay tests below: installed after app.tsx's import
	// (its browser mount guard reads document at module load), removed after.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
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

	const multiQ = {
		question: "Pick several",
		options: [{ label: "A", description: "first" }, { label: "B" }],
		multi: true,
		recommended: null,
	};

	/** The form-submit DOM event; happy-dom's Event class does not match lib.dom's. */
	const submitEvent = (): Event =>
		new window.Event("submit", {
			bubbles: true,
			cancelable: true,
		}) as unknown as Event;

	/** A React onChange picks up programmatic edits only through the native value setter (see settings.test.tsx). */
	const typeInto = (el: HTMLInputElement, value: string): void => {
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		if (setter === undefined) throw new Error("value setter missing");
		setter.call(el, value);
	};

	/** The production onChange React rendered onto the node; happy-dom's dispatched
	 *  input event never reaches React's ChangeEventPlugin (see settings.test.tsx). */
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

	/** One mounted multi AskBlock; every onAnswer text lands in `answers`, every onDraft in `drafts`. */
	async function mountAsk(): Promise<{
		container: HTMLDivElement;
		answers: string[];
		drafts: (string | null)[];
		form: HTMLFormElement;
		text: HTMLInputElement;
		other: HTMLInputElement;
		button: HTMLButtonElement;
	}> {
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const answers: string[] = [];
		const drafts: (string | null)[] = [];
		function Block() {
			return (
				<AskBlock
					q={multiQ}
					name="ask-0"
					answered={false}
					selected={null}
					busy={false}
					changed={[]}
					onOpenDiff={() => {}}
					onAnswer={(t: string) => {
						answers.push(t);
					}}
					onDraft={(t: string | null) => {
						drafts.push(t);
					}}
				/>
			);
		}
		await act(async () => {
			root.render(<Block />);
		});
		const inputs = [
			...container.querySelectorAll("input"),
		] as unknown as HTMLInputElement[];
		const text = inputs.find((i) => i.type === "text");
		const checkboxes = inputs.filter((i) => i.type === "checkbox");
		const other = checkboxes[checkboxes.length - 1];
		const form = container.querySelector("form") as unknown as HTMLFormElement;
		const button = container.querySelector(
			"button",
		) as unknown as HTMLButtonElement;
		if (
			text === undefined ||
			other === undefined ||
			form === null ||
			button === null
		)
			throw new Error("ask block did not render its controls");
		return { container, answers, drafts, form, text, other, button };
	}

	test("checking a preset counts as answered at once; unchecking it reopens", async () => {
		const { container, drafts } = await mountAsk();
		const box = container.querySelector(
			'input[aria-label="A"]',
		) as unknown as HTMLInputElement;
		const mark = (): string =>
			container.querySelector(".ask-text .mark")?.getAttribute("class") ?? "";
		expect(mark()).toContain("mark-asked");
		await act(async () => {
			onChangeOf(box)({ target: box, currentTarget: box });
		});
		// No Answer click: the check alone records the draft and ticks the question.
		expect(drafts).toEqual(["A"]);
		expect(mark()).toContain("mark-done");
		await act(async () => {
			onChangeOf(box)({ target: box, currentTarget: box });
		});
		expect(drafts).toEqual(["A", null]);
		expect(mark()).toContain("mark-asked");
	});

	test("clicking the Other checkbox answers even when the field stays empty", async () => {
		const { answers, form, other, button } = await mountAsk();
		await act(async () => {
			onChangeOf(other)({ target: other, currentTarget: other });
		});
		// The bare pick counts: the answer enables with nothing typed.
		expect(button.disabled).toBe(false);
		expect(button.textContent).toContain("(1)");
		await act(async () => {
			form.dispatchEvent(submitEvent());
		});
		expect(answers).toEqual(["Other"]);
		// The pick stays visible after the submit.
		expect(other.checked).toBe(true);
	});

	test("a typed custom answer survives its own submit", async () => {
		const { answers, form, text, other, button } = await mountAsk();
		await act(async () => {
			typeInto(text, "handwritten note");
			onChangeOf(text)({ target: text, currentTarget: text });
		});
		expect(button.textContent).toContain("(1)");
		await act(async () => {
			form.dispatchEvent(submitEvent());
		});
		// The answer carries the text and the field keeps showing it: that input is
		// the only place the recorded custom part is visible.
		expect(answers).toEqual(["handwritten note"]);
		expect(text.value).toBe("handwritten note");
		expect(other.checked).toBe(true);
	});
});

describe("triageWait", () => {
	test("rank sorts before wait time; unrated cards wait the longest", () => {
		const oldUnrated = cardFixture({ id: "a", updatedAt: 0 });
		const newP1 = cardFixture({ id: "b", updatedAt: 100, priority: "P1" });
		const oldP3 = cardFixture({ id: "c", updatedAt: 10, priority: "P3" });
		const newUnrated = cardFixture({ id: "d", updatedAt: 200 });
		const sorted = [oldUnrated, newP1, oldP3, newUnrated].sort(triageWait);
		// P1 first despite waiting least; P3 beats both unrated cards despite its age;
		// the two unrated cards keep their updatedAt order.
		expect(sorted.map((t) => t.id)).toEqual(["b", "c", "a", "d"]);
	});
});

describe("WarningLines", () => {
	const text =
		"No active sign-in for anthropic (role default): sign in under Settings - Provider sign-in, or set its API key in the environment.";

	test("each warning renders as its own note line in the notice bar", () => {
		const html = renderToStaticMarkup(
			<WarningLines warnings={[text, "second warning"]} />,
		);
		expect(html).toContain('role="note"');
		// The `Settings - Provider sign-in` phrase is an anchor; the sentence around it stays text.
		expect(html).toContain("sign in under ");
		expect(html).toContain(
			'<a class="notif-link" href="/settings#signin-section">Settings - Provider sign-in</a>',
		);
		expect(html).toContain(", or set its API key in the environment.");
		expect(html).toContain("second warning");
		expect(html.match(/notif-line/g)?.length).toBe(2);
	});

	test("no warnings render nothing", () => {
		expect(renderToStaticMarkup(<WarningLines warnings={[]} />)).toBe("");
	});

	test("a warning URL renders as a link and the sentence period stays text", () => {
		const html = renderToStaticMarkup(
			<WarningLines
				warnings={[
					"ottr-ai is not installed on octo/b. PR reviews there post under your own identity. Install it at https://github.com/apps/ottr-ai/installations/new.",
				]}
			/>,
		);
		expect(html).toContain(
			'<a class="notif-link" href="https://github.com/apps/ottr-ai/installations/new" target="_blank" rel="noopener noreferrer">https://github.com/apps/ottr-ai/installations/new</a>.',
		);
	});

	test("the GitHub App check message links Settings - Git hosts with the period outside", () => {
		const html = renderToStaticMarkup(
			<WarningLines
				warnings={[
					"The GitHub App check failed (app lookup answered 401). PR reviews can post under your own identity: check the App ID and key under Settings - Git hosts.",
				]}
			/>,
		);
		expect(html).toContain(
			'check the App ID and key under <a class="notif-link" href="/settings#git-hosts-section">Settings - Git hosts</a>.',
		);
	});

	test("a settings chain anchors the whole phrase to the deepest block", () => {
		const html = renderToStaticMarkup(
			<WarningLines
				warnings={[
					"Re-probe the token under Settings → Git hosts → GitHub token; the expiry notice follows at once.",
				]}
			/>,
		);
		expect(html).toContain(
			'under <a class="notif-link" href="/settings#github-token-block">Settings → Git hosts → GitHub token</a>; the expiry notice follows at once.',
		);
	});

	test("an unknown label and a bare Settings word stay plain text", () => {
		const html = renderToStaticMarkup(
			<WarningLines
				warnings={[
					"Settings - Bogus is not a card, and the word Settings alone stays text too.",
				]}
			/>,
		);
		expect(html).not.toContain("<a ");
		expect(html).toContain(
			"Settings - Bogus is not a card, and the word Settings alone stays text too.",
		);
	});
});

describe("RestartWaitLine", () => {
	const wait = {
		running: "a".repeat(40),
		commit: "b".repeat(40),
		commits: 116,
		since: 1730990000000,
		turns: ["ottr-448", "ottr-454"],
		command:
			"docker compose -f docker-compose.yml --env-file .env up -d --no-deps --wait server",
	};

	test("the wait names both shas, the turn holds, and the host command in a code span", () => {
		const html = renderToStaticMarkup(
			<RestartWaitLine
				wait={wait}
				inboxKey="restart-wait:1730990000000"
				fresh
			/>,
		);
		expect(html).toContain('role="note"');
		expect(html).toContain('data-inbox-key="restart-wait:1730990000000"');
		expect(html).toContain("mark-warn");
		expect(html).toContain(
			`The board runs ${"a".repeat(7)}; the image holds ${"b".repeat(7)} (116 commits newer).`,
		);
		expect(html).toContain("The restart waits for: ottr-448, ottr-454.");
		expect(html).toContain("Restarting now stops those turns.");
		// The recreate the update script's server step runs — never the deferring
		// script invocation, which would only defer again.
		expect(html).toContain(
			"<code>docker compose -f docker-compose.yml --env-file .env up -d --no-deps --wait server</code>",
		);
		// renderToStaticMarkup escapes the apostrophe, so assert the fragment.
		expect(html).toContain("from the stack");
		expect(html).toContain('class="new-tag"');
	});

	test("with no holding turns the waits-for sentence is gone but the command stays", () => {
		const html = renderToStaticMarkup(
			<RestartWaitLine
				wait={{ ...wait, turns: [] }}
				inboxKey="restart-wait:1730990000000"
				fresh={false}
			/>,
		);
		expect(html).not.toContain("waits for");
		expect(html).toContain("Restarting now stops the running turns.");
		expect(html).toContain(
			"<code>docker compose -f docker-compose.yml --env-file .env up -d --no-deps --wait server</code>",
		);
		expect(html).not.toContain("new-tag");
	});

	test("a singular wait still pluralizes only the commit count", () => {
		const html = renderToStaticMarkup(
			<RestartWaitLine
				wait={{ ...wait, commits: 1 }}
				inboxKey="restart-wait:1730990000000"
				fresh={false}
			/>,
		);
		expect(html).toContain("(1 commit newer).");
	});

	test("a null wait renders nothing", () => {
		expect(
			renderToStaticMarkup(
				<RestartWaitLine wait={null} inboxKey={undefined} fresh={false} />,
			),
		).toBe("");
	});
});

describe("UpdateCycleControl", () => {
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const originals = new Map<string, unknown>();
	const now = 1_700_000_000_000;
	const idle = {
		nextCycleAt: now + 120_000,
		phase: "idle" as const,
		canStart: true,
		error: null,
	};
	beforeAll(() => {
		for (const [key, value] of Object.entries({
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			IS_REACT_ACT_ENVIRONMENT: true,
		})) {
			originals.set(key, host[key]);
			host[key] = value;
		}
		originals.set("fetch", host.fetch);
	});
	afterAll(() => {
		for (const [key, value] of originals) {
			if (value === undefined) delete host[key];
			else host[key] = value;
		}
	});
	test("an absent or expired controller provides no countdown or action", () => {
		expect(
			renderToStaticMarkup(<UpdateCycleControl cycle={null} nowMs={now} />),
		).toBe("");
	});
	test("a missing controller preserves manual instructions and the notification key", () => {
		const html = renderToStaticMarkup(
			<AppBehindNotice
				behind={2}
				behindKey="behind:2"
				behindCommits={["A real change"]}
				isNew={() => false}
				updateCycle={null}
				nowMs={now}
			/>,
		);
		expect(html).toContain("bun run update");
		expect(html).toContain("Host control is unavailable");
		expect(html).toContain('data-inbox-key="behind:2"');
		expect(html).not.toContain("<button");
	});
	test("busy and preparing turns disable the action and explain the idle rule", () => {
		const html = renderToStaticMarkup(
			<UpdateCycleControl cycle={{ ...idle, canStart: false }} nowMs={now} />,
		);
		expect(html).toContain("disabled");
		expect(html).toContain("No turn can run or prepare");
	});
	test("requested and running cycles prevent duplicate actions", () => {
		for (const phase of ["requested", "running"] as const) {
			const html = renderToStaticMarkup(
				<UpdateCycleControl
					cycle={{ ...idle, phase, canStart: false }}
					nowMs={now}
				/>,
			);
			expect(html).toContain("disabled");
			expect(html).toContain(
				phase === "requested" ? "Update requested" : "Update cycle in progress",
			);
		}
	});
	test("the live clock updates the countdown and never shows a negative duration", async () => {
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(<UpdateCycleControl cycle={idle} nowMs={now} />),
			);
			expect(container.textContent).toContain("2m");
			await act(async () =>
				root.render(<UpdateCycleControl cycle={idle} nowMs={now + 60_000} />),
			);
			expect(container.textContent).toContain("1m");
			await act(async () =>
				root.render(<UpdateCycleControl cycle={idle} nowMs={now + 180_000} />),
			);
			expect(container.textContent).toContain("is due");
			expect(container.textContent).not.toContain("-1");
		} finally {
			await act(async () => root.unmount());
		}
	});
	test("an idle request posts an empty object once and gives immediate feedback", async () => {
		const response = Promise.withResolvers<void>();
		const calls: { url: string; body: unknown }[] = [];
		host.fetch = async (url: string, init?: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init?.body)) });
			await response.promise;
			return Response.json({});
		};
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(<UpdateCycleControl cycle={idle} nowMs={now} />),
			);
			const button = container.querySelector("button")!;
			await act(async () => button.click());
			expect(button.disabled).toBe(true);
			expect(container.textContent).toContain("Update requested");
			await act(async () => button.click());
			expect(calls).toEqual([{ url: "/api/update", body: {} }]);
			await act(async () => response.resolve());
			expect(button.disabled).toBe(true);
			await act(async () =>
				root.render(<UpdateCycleControl cycle={null} nowMs={now} />),
			);
			expect(container.textContent).toBe("");
		} finally {
			await act(async () => root.unmount());
		}
	});
	test("request and host failures stay beside the action with a retry step", async () => {
		host.fetch = async () =>
			Response.json({ error: "Host is unavailable" }, { status: 409 });
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(<UpdateCycleControl cycle={idle} nowMs={now} />),
			);
			await act(async () => container.querySelector("button")!.click());
			expect(container.querySelector('[role="alert"]')?.textContent).toContain(
				"Host is unavailable",
			);
			expect(container.querySelector('[role="alert"]')?.textContent).toContain(
				"Retry",
			);
			expect(container.querySelector("button")!.disabled).toBe(false);
			await act(async () =>
				root.render(
					<UpdateCycleControl cycle={{ ...idle }} nowMs={now + 5_000} />,
				),
			);
			expect(container.querySelector('[role="alert"]')?.textContent).toContain(
				"Host is unavailable",
			);
			await act(async () =>
				root.render(<UpdateCycleControl cycle={null} nowMs={now} />),
			);
			expect(container.textContent).toBe("");
			await act(async () =>
				root.render(
					<UpdateCycleControl
						cycle={{ ...idle, error: "Build failed" }}
						nowMs={now}
					/>,
				),
			);
			expect(container.querySelector('[role="alert"]')?.textContent).toContain(
				"Build failed",
			);
			expect(
				container.querySelector('[role="alert"]')?.textContent,
			).not.toContain("Host is unavailable");
			expect(container.querySelector("button")!.textContent).toBe("Update");
			expect(container.querySelector("button")!.disabled).toBe(false);
		} finally {
			await act(async () => root.unmount());
		}
	});
});

describe("SeedFailedLine", () => {
	const fail = {
		since: 1730990000000,
		commit: "d".repeat(40),
		text: "SkillSpector rejected /tmp/alate-data-9f34/user/omp/agent/skills/egm-review-loop (exit 1); nothing was installed",
	};

	test("the red notice names the time, the commit, the failure, and the baseline next step", () => {
		const html = renderToStaticMarkup(
			<SeedFailedLine fail={fail} inboxKey="seed-failed:1730990000000" fresh />,
		);
		expect(html).toContain('role="note"');
		expect(html).toContain('data-inbox-key="seed-failed:1730990000000"');
		expect(html).toContain("mark-crit");
		// stamp() is locale-dependent, so only the stable prefix is asserted.
		expect(html).toContain("Agent layer seed failed since");
		expect(html).toContain(`Tried commit ${"d".repeat(12)}.`);
		expect(html).toContain("SkillSpector rejected");
		// The recorded tail ends mid-sentence; the next step starts on a clean boundary.
		expect(html).toContain("nothing was installed. Fix the skill");
		expect(html).toContain(
			"Fix the skill egm-review-loop, or accept the findings in its .skillspector-baseline.yaml in the data repo.",
		);
		expect(html).toContain('class="new-tag"');
	});

	test("without a SkillSpector rejection the next step is the generic retry", () => {
		const html = renderToStaticMarkup(
			<SeedFailedLine
				fail={{ ...fail, text: "git ls-remote example/data failed" }}
				inboxKey="seed-failed:1"
				fresh={false}
			/>,
		);
		expect(html).toContain("The next update run seeds the agent layer again.");
		expect(html).not.toContain("skillspector-baseline");
		expect(html).not.toContain("new-tag");
	});

	test("an empty commit and text render only the header and the retry", () => {
		const html = renderToStaticMarkup(
			<SeedFailedLine
				fail={{ since: 1730990000000, commit: "", text: "" }}
				inboxKey={undefined}
				fresh={false}
			/>,
		);
		expect(html).toContain("Agent layer seed failed since");
		expect(html).not.toContain("Tried commit");
		expect(html).toContain("The next update run seeds the agent layer again.");
	});

	test("a null fail renders nothing", () => {
		expect(
			renderToStaticMarkup(
				<SeedFailedLine fail={null} inboxKey={undefined} fresh={false} />,
			),
		).toBe("");
	});
});

describe("ProvisionErrorLine", () => {
	test("the red notice names the failure and the retry", () => {
		const html = renderToStaticMarkup(
			<ProvisionErrorLine
				error="alate did not answer the provision request within 110 s"
				inboxKey="provision-error:abc"
				fresh={false}
			/>,
		);
		expect(html).toContain("mark-crit");
		expect(html).toContain("Agent layer provision failed:");
		expect(html).toContain(
			"alate did not answer the provision request within 110 s",
		);
		expect(html).toContain("Run Provision again");
		expect(html).not.toContain("new-tag");
	});

	test("a null error renders nothing", () => {
		expect(
			renderToStaticMarkup(
				<ProvisionErrorLine error={null} inboxKey={undefined} fresh={false} />,
			),
		).toBe("");
	});
});

describe("settings TOC", () => {
	test("groups and sections follow the contract order", () => {
		expect(SETTINGS_TOC.map((g) => g.label)).toEqual([
			"Board",
			"Agents",
			"Workflow",
			"Agent environment",
			"Git and integrations",
			"Access and usage",
		]);
		expect(SETTINGS_TOC.map((g) => g.sections.map((s) => s.label))).toEqual([
			["Projects", "Notifications"],
			["Provider sign-in", "Model roles", "Runners"],
			["Checks", "Automation"],
			["Env", "Alate", "Hindsight"],
			["GitHub", "Other git hosts", "Git identity", "Jira connections"],
			["API key", "Session", "omp usage"],
		]);
	});
	test("General page renders each id once, one h1, TOC in order, a GitHub card title", () => {
		const html = renderToStaticMarkup(
			<SettingsPage
				projects={[]}
				tasks={[]}
				maxTotal={null}
				reviewCheck={false}
				workCheck={false}
				idleReviews={true}
				trendingScan={true}
				commitIdentity={null}
				trendingStatus={{ lastRunAt: null, lastError: null, running: false }}
				act={async () => true}
				view="settings"
				openTask={() => {}}
			/>,
		);
		const blocks = (s: (typeof SETTINGS_TOC)[number]["sections"][number]) =>
			"blocks" in s ? s.blocks : [];
		const ids = SETTINGS_TOC.flatMap((g) => [
			g.id,
			...g.sections.flatMap((s) => [s.id, ...blocks(s).map((b) => b.id)]),
		]);
		for (const id of ids) expect(html.split(`id="${id}"`).length - 1).toBe(1);
		for (const id of ["signin-section", "model-roles-section", "alate-section"])
			expect(html).toContain(`id="${id}"`);
		// The idle-reviews switch row: labelled checkbox inside the Runners card.
		expect(html).toContain("Run due reviews while idle");
		expect(html.split("<h1").length - 1).toBe(1);
		const nav =
			html.match(/<nav[^>]*class="[^"]*settings-nav[\s\S]*?<\/nav>/)?.[0] ?? "";
		const tocLabels = [
			...nav.matchAll(/class="smap-row"[^>]*>([^<]*)<\/button>/g),
		].map((m) => m[1]);
		// The map shows groups and cards only; sub-blocks stay deep-link targets.
		expect(tocLabels).toEqual(
			SETTINGS_TOC.flatMap((g) => [g.label, ...g.sections.map((s) => s.label)]),
		);
		// GitHub is its own card; the other git hosts and the Git identity follow it.
		expect(html).toMatch(/<h3[^>]*>GitHub<\/h3>/);
	});
});

describe("recommendsSteps", () => {
	test("matches the step phrases the follow-up prompt searches for", () => {
		expect(recommendsSteps("## Next steps\n\n1. Buy the rack")).toBe(true);
		expect(recommendsSteps("Our recommended steps are listed below.")).toBe(
			true,
		);
		// Real shape (OTTR-94): a report whose steps section is the follow-up's target.
		expect(
			recommendsSteps(
				"## Suggested next steps (outside this repo)\n\n1. Add a scan.",
			),
		).toBe(true);
		// Real shape (OTTR-283, the server hardware research): a tier comparison with
		// picks but no step section earns no button. Headings from the archived report.
		expect(
			recommendsSteps(
				[
					"## Short answer",
					"",
					"| Your goal | Buy this | Price | Idle power |",
					"|---|---|---|---|",
					"| Cheapest real upgrade | GMKtec M6 Ultra 32 GB/1 TB | €599.99 | about 10 W |",
					"",
					"## What Ottr needs",
					"",
					"## Tier 1 — Budget (up to about €850)",
					"",
					"## My recommendation",
					"",
					"**Ottr/Alate only (my pick)**: Beelink GTi15 Ultra, 64 GB / 1 TB, €1589.",
					"",
					"## Limits of this research",
				].join("\n"),
			),
		).toBe(false);
	});

	test("matches the prompt's exact heading and OTTR-449's older shape", () => {
		// The heading the research prompt asks for, at the lowest and highest level.
		expect(recommendsSteps("# Recommended steps\n\n1. Buy the rack")).toBe(
			true,
		);
		expect(recommendsSteps("###### Recommended steps\n\n1. Buy the rack")).toBe(
			true,
		);
		// Case-insensitive.
		expect(recommendsSteps("### RECOMMENDED STEPS\n\n1. Buy the rack")).toBe(
			true,
		);
		// Real shape (OTTR-449): the heading sits mid-report and holds a word
		// between "recommended" and "steps".
		expect(
			recommendsSteps(
				[
					"## Short answer",
					"",
					"Answer: an explicit recommendations field.",
					"",
					"## Recommended adoption steps",
					"",
					"1. Add the field to the card state.",
				].join("\n"),
			),
		).toBe(true);
		expect(recommendsSteps("## Recommended next steps\n\n1. Add a scan.")).toBe(
			true,
		);
		// Up to three words between; four is too many.
		expect(recommendsSteps("## Recommended one two three steps")).toBe(true);
		expect(recommendsSteps("## Recommended one two three four steps")).toBe(
			false,
		);
		// A prose mention earns no button: only headings widen the old phrases.
		expect(
			recommendsSteps("our recommended adoption steps are listed below."),
		).toBe(false);
		// A report with no step section earns no button.
		expect(recommendsSteps("## Short answer\n\nNo steps are needed.")).toBe(
			false,
		);
	});
});

describe("reportHtml", () => {
	test("escapes the title and embeds the body verbatim", () => {
		const html = reportHtml('a<b>&"c', '<div class="md">x</div>');
		expect(html).toContain("<title>a&#60;b&#62;&#38;&#34;c</title>");
		expect(html).toContain('<div class="md">x</div>');
	});
});

describe("Drawer parent chip", () => {
	// The drawer's done view reads the list fields during render.
	const childCard = (over: Partial<TaskCard>): TaskCard =>
		cardFixture({
			workCheckLog: [],
			images: [],
			pendingImages: [],
			shots: [],
			keptFiles: [],
			updateIds: [],
			followUpOfProject: null,
			...over,
		});
	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1 },
	} as unknown as ProjectView;
	const base = {
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: false,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};

	test("a parent still on the board renders as a button naming it", () => {
		const parent = cardFixture({
			id: "P-1",
			stage: "done",
			state: "idle",
			sessionTitle: "Parent work",
		});
		const child = childCard({
			id: "C-1",
			stage: "done",
			state: "idle",
			followUpOf: "P-1",
		});
		const html = renderToStaticMarkup(
			<Drawer {...base} task={child} tasks={[parent]} />,
		);
		expect(html).toContain('class="lineage-row"');
		expect(html).toContain("parent");
		expect(html).toContain("Parent work");
		expect(html).toContain('aria-current="true"');
	});

	test("a parent the state dropped (cancelled) keeps the chip on the bare id", () => {
		const child = childCard({
			id: "C-1",
			stage: "done",
			state: "idle",
			followUpOf: "P-9",
		});
		const html = renderToStaticMarkup(
			<Drawer {...base} task={child} tasks={[]} />,
		);
		expect(html).toContain("lineage-gone");
		expect(html).toContain("Not on the board");
		expect(html).toContain("P-9");
		expect(html).toContain('title="P-9 is not on the board"');
	});

	test("follow-ups list oldest first, whatever order the state sends", () => {
		const self = childCard({ id: "S-1", stage: "done", state: "idle" });
		const kid = (id: string, createdAt: number) =>
			cardFixture({ id, followUpOf: "S-1", createdAt });
		const html = renderToStaticMarkup(
			<Drawer
				{...base}
				task={self}
				tasks={[kid("K-3", 3000), kid("K-1", 1000), kid("K-2", 2000)]}
			/>,
		);
		const at = (id: string) => html.indexOf(`>${id}<`);
		expect(at("K-1")).toBeGreaterThan(at("S-1"));
		expect(at("K-2")).toBeGreaterThan(at("K-1"));
		expect(at("K-3")).toBeGreaterThan(at("K-2"));
		// Parallel, not chained: all three hang in one branch under this card's row.
		const branch = html.slice(html.indexOf('class="lineage-branch"'));
		expect(html.indexOf('class="lineage-branch"')).toBeGreaterThan(at("S-1"));
		for (const id of ["K-1", "K-2", "K-3"]) expect(branch).toContain(`>${id}<`);
	});

	describe("retros in the lineage", () => {
		const self = childCard({ id: "S-1", stage: "done", state: "idle" });
		const card = (
			id: string,
			followUpOf: string,
			createdAt: number,
			over: Partial<TaskCard> = {},
		) => cardFixture({ id, followUpOf, createdAt, ...over });
		const at = (html: string, id: string) => html.indexOf(`>${id}<`);
		const PROPOSALS = 'aria-label="Proposals"';

		test("a retro is a follow-up row and its proposals nest under it, oldest first", () => {
			const html = renderToStaticMarkup(
				<Drawer
					{...base}
					task={self}
					tasks={[
						card("P-2", "R-1", 4000),
						card("R-1", "S-1", 2000, { kind: "retro" }),
						card("F-1", "S-1", 1000),
						// An accepted proposal no longer carries the proposal reason.
						card("P-1", "R-1", 3000, { needsReason: null }),
					]}
				/>,
			);
			expect(at(html, "F-1")).toBeGreaterThan(at(html, "S-1"));
			expect(at(html, "R-1")).toBeGreaterThan(at(html, "F-1"));
			const nest = html.indexOf(PROPOSALS);
			expect(nest).toBeGreaterThan(at(html, "R-1"));
			expect(at(html, "P-1")).toBeGreaterThan(nest);
			expect(at(html, "P-2")).toBeGreaterThan(at(html, "P-1"));
			const rRow = html.slice(at(html, "R-1"), nest);
			expect(rRow).toContain('<span class="lineage-tag">retro</span>');
			expect(rRow).toContain('<span class="st">queued</span>');
			expect(html).toContain('href="/projects/proj/tasks/P-1"');
			expect(html).toContain('href="/projects/proj/tasks/R-1"');
		});

		test("each retro lists only its own proposals, retros oldest first", () => {
			const html = renderToStaticMarkup(
				<Drawer
					{...base}
					task={self}
					tasks={[
						card("R-2", "S-1", 3000, { kind: "retro" }),
						card("Q-2", "R-2", 4000),
						card("R-1", "S-1", 1000, { kind: "retro" }),
						card("Q-1", "R-1", 2000),
					]}
				/>,
			);
			const parts = html.split(PROPOSALS);
			expect(parts).toHaveLength(3);
			expect(parts[0]).toContain(">R-1<");
			expect(parts[0]).not.toContain(">R-2<");
			expect(parts[1]).toContain(">Q-1<");
			expect(parts[1]!.indexOf(">Q-1<")).toBeLessThan(
				parts[1]!.indexOf(">R-2<"),
			);
			expect(parts[2]).toContain(">Q-2<");
			expect(parts[2]).not.toContain(">Q-1<");
		});

		test("a cancelled retro and a declined proposal keep their cancelled state", () => {
			const html = renderToStaticMarkup(
				<Drawer
					{...base}
					task={self}
					tasks={[
						card("R-1", "S-1", 1000, { kind: "retro", cancelledAt: 1500 }),
						card("P-1", "R-1", 2000, { cancelledAt: 2500 }),
					]}
				/>,
			);
			expect(html.match(/>cancelled</g)).toHaveLength(2);
			expect(at(html, "P-1")).toBeGreaterThan(html.indexOf(PROPOSALS));
		});

		test("a plain follow-up's own follow-ups do not nest", () => {
			const html = renderToStaticMarkup(
				<Drawer
					{...base}
					task={self}
					tasks={[card("F-1", "S-1", 1000), card("G-1", "F-1", 2000)]}
				/>,
			);
			expect(html).toContain(">F-1<");
			expect(html).not.toContain(">G-1<");
			expect(html).not.toContain(PROPOSALS);
		});

		test("a proposal's rail reads retro source, retro, this card", () => {
			const proposal = childCard({ id: "P-1", followUpOf: "R-1" });
			const html = renderToStaticMarkup(
				<Drawer
					{...base}
					task={proposal}
					tasks={[
						card("S-1", "V-1", 500, { sessionTitle: "Source work" }),
						card("R-1", "S-1", 1000, { kind: "retro" }),
					]}
				/>,
			);
			expect(at(html, "S-1")).toBeGreaterThan(-1);
			expect(at(html, "R-1")).toBeGreaterThan(at(html, "S-1"));
			expect(html.indexOf('aria-current="true"')).toBeGreaterThan(
				at(html, "R-1"),
			);
			expect(html).toContain('href="/projects/proj/tasks/S-1"');
			const sRow = html.slice(at(html, "S-1"), at(html, "R-1"));
			expect(sRow).toContain(">retro source<");
			const rRow = html.slice(at(html, "R-1"), html.indexOf("lineage-self"));
			expect(rRow).toContain(">retro<");
			// The chain stops at the source: its own parent is not shown.
			expect(html).not.toContain(">V-1<");
		});

		test("a retro source off the board renders inert", () => {
			const proposal = childCard({ id: "P-1", followUpOf: "R-1" });
			const html = renderToStaticMarkup(
				<Drawer
					{...base}
					task={proposal}
					tasks={[card("R-1", "S-9", 1000, { kind: "retro" })]}
				/>,
			);
			expect(html).toContain('title="S-9 is not on the board"');
			expect(html).not.toContain("/tasks/S-9");
			const gone = html.slice(html.indexOf("lineage-gone"), at(html, "R-1"));
			expect(gone).toContain(">retro source<");
		});

		test("a parent that is no retro gets no grandparent row", () => {
			const child = childCard({ id: "C-1", followUpOf: "P-1" });
			const html = renderToStaticMarkup(
				<Drawer
					{...base}
					task={child}
					tasks={[card("P-1", "G-1", 1000), card("G-1", "", 500)]}
				/>,
			);
			expect(html).toContain(">P-1<");
			expect(html).not.toContain(">G-1<");
			expect(html).not.toContain(">retro source<");
		});
	});
});

describe("ranOnLabel", () => {
	const turn = (over: Partial<TurnView>): TurnView =>
		({
			id: 1,
			taskId: "t1",
			kind: "work",
			input: null,
			inputBy: null,
			startedAt: 0,
			endedAt: 1,
			pid: null,
			exitCode: 0,
			outcome: "answered",
			summary: null,
			details: null,
			question: null,
			error: null,
			model: null,
			ranOn: null,
			...over,
		}) as unknown as TurnView;

	test("the newest work turn that recorded a run wins", () => {
		expect(
			ranOnLabel([
				turn({ id: 1, ranOn: "worker-a (aaaa)" }),
				turn({ id: 2, kind: "merge", ranOn: "board (ottr-server)" }),
				turn({ id: 3, ranOn: "worker-b (bbbb)" }),
			]),
		).toBe("worker-b (bbbb)");
	});

	test("a merge turn backs a history whose work turns predate the column", () => {
		expect(
			ranOnLabel([
				turn({ id: 1, ranOn: null }),
				turn({ id: 2, kind: "merge", ranOn: "board (ottr-server)" }),
			]),
		).toBe("board (ottr-server)");
	});

	test("no recorded run reads null", () => {
		expect(ranOnLabel([turn({}), turn({ id: 2, kind: "merge" })])).toBeNull();
		expect(ranOnLabel([])).toBeNull();
	});
});

describe("Drawer meta ran-on row", () => {
	const card = cardFixture({
		id: "M-1",
		stage: "done",
		state: "idle",
		workCheckLog: [],
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		updateIds: [],
	});
	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1 },
	} as unknown as ProjectView;

	test("the Meta section names where the card ran", () => {
		const html = renderToStaticMarkup(
			<Drawer
				task={card}
				project={project}
				act={async () => true}
				onClose={() => {}}
				onFollowed={() => {}}
				projects={[]}
				read={false}
				onMarkUnread={() => {}}
				onMarkSeen={() => {}}
				onOpenTask={() => {}}
				draining={false}
				usedTotal={0}
				maxTotal={null}
				tasks={[]}
			/>,
		);
		// The static render has no detail fetch: no turns arrived yet, so the row
		// shows the placeholder until the detail fill replaces it.
		const m = /Ran on<\/dt><dd>([^<]*)<\/dd>/.exec(html);
		expect(m?.[1]).toBe("-");
	});
});

describe("Drawer cross-project lineage", () => {
	const childCard = (over: Partial<TaskCard>): TaskCard =>
		cardFixture({
			workCheckLog: [],
			images: [],
			pendingImages: [],
			shots: [],
			keptFiles: [],
			updateIds: [],
			followUpOfProject: null,
			...over,
		});
	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1 },
	} as unknown as ProjectView;
	const base = {
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: false,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};

	test("a foreign parent renders as a link naming its project", () => {
		const parent = cardFixture({
			id: "P-1",
			project: "other",
			sessionTitle: "Parent work",
			stage: "done",
			state: "idle",
		});
		const child = childCard({
			id: "C-1",
			stage: "done",
			state: "idle",
			followUpOf: "P-1",
			followUpOfProject: "other",
		});
		const html = renderToStaticMarkup(
			<Drawer {...base} task={child} tasks={[parent]} />,
		);
		expect(html).toContain('class="lineage-row"');
		// The href uses the linked card's project, not the open card's.
		expect(html).toContain('href="/projects/other/tasks/P-1"');
		expect(html).toContain("Parent work");
		expect(html).toContain("parent");
		expect(html).toContain("other");
	});

	test("a foreign follow-up lists with id, project and state", () => {
		const self = childCard({ id: "S-1", stage: "done", state: "idle" });
		const kid = childCard({
			id: "K-1",
			project: "other",
			followUpOf: "S-1",
			followUpOfProject: "proj",
			state: "needs_you",
			stage: "todo",
		});
		const html = renderToStaticMarkup(
			<Drawer {...base} task={self} tasks={[kid]} />,
		);
		expect(html).toContain("K-1");
		// The href uses the linked card's project, not the open card's.
		expect(html).toContain('href="/projects/other/tasks/K-1"');
		expect(html).toContain("other");
		expect(html).toContain('class="lineage-branch"');
	});

	test("a same-id card on another board does not pose as the parent", () => {
		const child = childCard({
			id: "C-1",
			stage: "done",
			state: "idle",
			followUpOf: "P-1",
		});
		const impostor = cardFixture({
			id: "P-1",
			project: "other",
			sessionTitle: "Impostor work",
		});
		const html = renderToStaticMarkup(
			<Drawer {...base} task={child} tasks={[impostor]} />,
		);
		expect(html).toContain("lineage-gone");
		expect(html).toContain("Not on the board");
		expect(html).not.toContain("Impostor work");
	});

	test("a foreign card sharing this card's id does not list as a kid", () => {
		const self = childCard({
			id: "S-1",
			stage: "done",
			state: "idle",
			followUpOf: null,
		});
		const stranger = cardFixture({
			id: "S-1",
			project: "other",
			followUpOf: "S-1",
			followUpOfProject: "other",
		});
		const html = renderToStaticMarkup(
			<Drawer {...base} task={self} tasks={[stranger]} />,
		);
		expect(html).not.toContain("drawer-lineage");
		expect(html).not.toContain("lineage-branch");
	});

	test("a cross-project dependency row links the dependency's project", () => {
		const row = childCard({
			id: "C-1",
			stage: "todo",
			state: "queued",
			dependsOn: ["D-9"],
		});
		const dep = cardFixture({
			id: "D-9",
			project: "other",
			stage: "in_progress",
			state: "running",
		});
		const html = renderToStaticMarkup(
			<Drawer {...base} task={row} tasks={[dep]} />,
		);
		expect(html).toContain('href="/projects/other/tasks/D-9"');
	});
});

describe("Drawer prompt markdown", () => {
	// ponytail: render test reads only these fields; the cast keeps the fixture short.
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};

	test("the prompt section renders markdown instead of raw text", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
			prompt: "# Rules\n\nfix the `align` flow, **then** commit",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('class="prompt-text"');
		expect(html).toContain("<h1>Rules</h1>");
		expect(html).toContain("<code>align</code>");
		expect(html).toContain("<strong>then</strong>");
	});

	test("the editable prompt of an unstarted card renders markdown", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			prompt: "fix the `align` flow",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('class="task-prompt"');
		expect(html).toContain("<code>align</code>");
	});

	test("a parked backlog card shows the Edit task button; other stages do not", () => {
		const parked = cardFixture({
			...drawerFields,
			stage: "backlog",
			state: "idle",
			prompt: "parked idea",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={parked} />);
		expect(html).toContain('class="task-prompt"');
		expect(html).toContain("Edit task");
		const done = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
		});
		const merged = renderToStaticMarkup(<Drawer {...base} task={done} />);
		expect(merged).toContain('class="prompt-text"');
		expect(merged).not.toContain("Edit task");
	});

	test("a preparing card shows the prompt read-only without an edit button", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "preparing",
			prompt: "fix the `align` flow",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('class="prompt-text"');
		expect(html).not.toContain('class="task-prompt"');
		expect(html).not.toContain("Edit task");
	});

	test("queued steering renders markdown in the you bubble", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			pendingPrompt: "run `bun test`, **not** the full suite",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('class="you-msg"');
		expect(html).toContain("<code>bun test</code>");
		expect(html).toContain("<strong>not</strong>");
	});
});

describe("Drawer file-section loading placeholders", () => {
	// OTTR-473: while the drawer fetches the detail, the file sections hold their space with a
	// loading line, gated by what the board row predicts (a worktree for worktree files; a
	// build card for changed files). The static render never resolves the fetch, so it sees
	// exactly the loading state.
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};

	test("a build card with a worktree holds both sections while the detail loads", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "in_progress",
			state: "idle",
			worktree: "/tmp/proj/.worktrees/t1",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-wt"');
		expect(html).toContain('id="drawer-diff"');
		expect(html).toContain('class="skeleton"');
		expect(html).toContain('role="status"');
		expect(html).toContain("Loading the files");
	});

	test("a card without a worktree holds only the changed-files section", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain('id="drawer-wt"');
		expect(html).toContain('id="drawer-diff"');
	});

	test("a research card holds the worktree placeholder but no changed-files one", () => {
		const task = cardFixture({
			...drawerFields,
			research: true,
			stage: "in_progress",
			state: "idle",
			worktree: "/tmp/proj/.worktrees/t1",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-wt"');
		expect(html).not.toContain('id="drawer-diff"');
	});

	test("a release card holds no file-section placeholders", () => {
		const task = cardFixture({
			...drawerFields,
			releaseVersion: "v1.2.3",
			releaseNotes: null,
			stage: "merging",
			state: "queued",
			worktree: null,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain('id="drawer-diff"');
		expect(html).not.toContain('id="drawer-wt"');
	});
});

describe("Drawer queued steering edit", () => {
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};
	test("queued steering offers Edit next to Cancel", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			pendingPrompt: "gardening should have been hardening",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('aria-label="Edit the queued steering"');
		expect(html).toContain('aria-label="Cancel the queued steering"');
	});

	test("the resume marker hides Edit and Cancel", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			pendingPrompt: ".",
			pendingBy: "supervisor",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('class="you-chip"');
		expect(html).not.toContain('aria-label="Edit the queued steering"');
		expect(html).not.toContain('aria-label="Cancel the queued steering"');
	});
});

describe("Drawer queued steering edit (client)", () => {
	// The save flows through the act prop; the stub base.act never runs the body,
	// so save-driven tests pass an act with the production contract: run the body,
	// swallow its error, report false.
	const runAct = async (fn: () => Promise<void>): Promise<boolean> => {
		try {
			await fn();
			return true;
		} catch {
			return false;
		}
	};
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};
	// React interaction needs browser globals; the setup mirrors settings.test.tsx:
	// happy-dom registers them for this describe, and afterAll puts the originals
	// back, so later test files in the same process see no DOM.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
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

	// happy-dom's dispatched clicks never reach React's event plugin (same
	// upstream gap as settings.test.tsx's onChangeOf): call the production
	// onClick React rendered onto the node instead.
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

	test("a replaced steer never reopens the editor with the stale draft", async () => {
		const realFetch = globalThis.fetch;
		// The drawer's effects fetch the task detail, session context and model
		// catalog; every one degrades to null on a failed response, so a 404 keeps
		// the row's own fields (pendingPrompt included) authoritative.
		globalThis.fetch = (async () =>
			new Response("{}", { status: 404 })) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const task = (prompt: string) =>
			cardFixture({
				...drawerFields,
				stage: "todo",
				state: "queued",
				pendingPrompt: prompt,
			});
		const editButton = (): Element => {
			const node = container.querySelector(
				'button[aria-label="Edit the queued steering"]',
			);
			if (node === null) throw new Error("no Edit button");
			return node;
		};
		const editor = (): HTMLTextAreaElement | null =>
			container.querySelector<HTMLTextAreaElement>("#steer-edit-text");
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={task("first steer")} />);
			});
			await act(async () => {
				onClickOf(editButton())({});
			});
			expect(editor()?.value).toBe("first steer");
			// The steer the editor was opened on is replaced while the draft sits
			// open (delivered, or edited away server-side): the pendingPrompt change
			// must reset the draft, or a later Save would overwrite the new steer
			// with the stale text.
			await act(async () => {
				root.render(<Drawer {...base} task={task("second steer")} />);
			});
			expect(editor()).toBeNull();
			await act(async () => {
				onClickOf(editButton())({});
			});
			expect(editor()?.value).toBe("second steer");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("a refused steer edit keeps the draft across the detail refresh", async () => {
		const realFetch = globalThis.fetch;
		// The steer edit save is refused with the board's current row; every other
		// fetch (task detail, session context, catalog) degrades to null like the
		// replaced-steer test above, so the row's own fields stay authoritative.
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/steer/edit")) {
				return new Response(
					JSON.stringify({
						error: "card changed since it was loaded",
						task: { id: "t1", revision: 9, pendingPrompt: "second steer" },
					}),
					{ status: 409 },
				);
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const task = (prompt: string) =>
			cardFixture({
				...drawerFields,
				stage: "todo",
				state: "queued",
				pendingPrompt: prompt,
			});
		const editButton = (): Element => {
			const node = container.querySelector(
				'button[aria-label="Edit the queued steering"]',
			);
			if (node === null) throw new Error("no Edit button");
			return node;
		};
		const editor = (): HTMLTextAreaElement | null =>
			container.querySelector<HTMLTextAreaElement>("#steer-edit-text");
		try {
			await act(async () => {
				root.render(
					<Drawer {...base} act={runAct} task={task("first steer")} />,
				);
			});
			await act(async () => {
				onClickOf(editButton())({});
			});
			expect(editor()?.value).toBe("first steer");
			// The save is refused with the board's newer steering: the conflict flow
			// keeps the draft and re-arms the revision.
			const form = editor()?.closest("form");
			if (form == null) throw new Error("no steer edit form");
			await act(async () => {
				form.dispatchEvent(
					new window.Event("submit", {
						bubbles: true,
						cancelable: true,
					}) as unknown as Event,
				);
			});
			expect(container.textContent).toContain("changed while you were editing");
			expect(container.textContent).toContain("second steer");
			expect(editor()?.value).toBe("first steer");
			// A detail refresh lands the board's newer pendingPrompt while the
			// conflict is shown: the draft the notice says is kept must survive it.
			await act(async () => {
				root.render(
					<Drawer {...base} act={runAct} task={task("second steer")} />,
				);
			});
			expect(container.textContent).toContain("changed while you were editing");
			expect(editor()?.value).toBe("first steer");
			// Re-opening the editor clears the conflict, and the old behavior
			// resumes: a pendingPrompt change with no conflict closes the editor.
			await act(async () => {
				onClickOf(editButton())({});
			});
			expect(editor()?.value).toBe("second steer");
			await act(async () => {
				root.render(
					<Drawer {...base} act={runAct} task={task("fourth steer")} />,
				);
			});
			expect(editor()).toBeNull();
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("a refused steer edit keeps its draft when the queue empties or resumes", async () => {
		const realFetch = globalThis.fetch;
		// The steer edit save is refused with the board's current row; every other
		// fetch degrades to null like the replaced-steer test above.
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			if (String(input).includes("/steer/edit"))
				return new Response(
					JSON.stringify({
						error: "card changed since it was loaded",
						task: { id: "t1", revision: 9, pendingPrompt: "second steer" },
					}),
					{ status: 409 },
				);
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const task = (prompt: string) =>
			cardFixture({
				...drawerFields,
				stage: "todo",
				state: "queued",
				pendingPrompt: prompt,
			});
		const editButton = (): Element => {
			const node = container.querySelector(
				'button[aria-label="Edit the queued steering"]',
			);
			if (node === null) throw new Error("no Edit button");
			return node;
		};
		const editor = (): HTMLTextAreaElement | null =>
			container.querySelector<HTMLTextAreaElement>("#steer-edit-text");
		const submit = async (): Promise<void> => {
			await act(async () => {
				const form = editor()?.closest("form");
				if (form == null) throw new Error("no steer edit form");
				form.dispatchEvent(
					new window.Event("submit", {
						bubbles: true,
						cancelable: true,
					}) as unknown as Event,
				);
			});
		};
		try {
			await act(async () => {
				root.render(
					<Drawer {...base} act={runAct} task={task("first steer")} />,
				);
			});
			await act(async () => {
				onClickOf(editButton())({});
			});
			expect(editor()?.value).toBe("first steer");
			await submit();
			expect(container.textContent).toContain("changed while you were editing");
			// The turn consumed the steer while the conflict sat open: the queue is
			// empty, but the kept draft and the notice must stay reachable.
			await act(async () => {
				root.render(
					<Drawer
						{...base}
						act={runAct}
						task={cardFixture({
							...drawerFields,
							stage: "todo",
							state: "needs_you",
							pendingPrompt: null,
						})}
					/>,
				);
			});
			expect(editor()?.value).toBe("first steer");
			expect(container.textContent).toContain("changed while you were editing");
			expect(container.textContent).toContain("second steer");
			// An automatic resume marker replaces the queued text: the draft still
			// outranks the marker chip.
			await act(async () => {
				root.render(<Drawer {...base} act={runAct} task={task(".")} />);
			});
			expect(editor()?.value).toBe("first steer");
			expect(container.textContent).toContain("changed while you were editing");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("a refused steer edit restores the draft a pre-409 refresh cleared", async () => {
		const realFetch = globalThis.fetch;
		const gate = Promise.withResolvers<void>();
		let refused = false;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/steer/edit")) {
				if (!refused) {
					refused = true;
					// The 409 lands after the refresh below, so no conflict exists
					// while the refresh clears the editor.
					await gate.promise;
				}
				return new Response(
					JSON.stringify({
						error: "card changed since it was loaded",
						task: { id: "t1", revision: 9, pendingPrompt: "second steer" },
					}),
					{ status: 409 },
				);
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const task = (prompt: string) =>
			cardFixture({
				...drawerFields,
				stage: "todo",
				state: "queued",
				pendingPrompt: prompt,
			});
		const editButton = (): Element => {
			const node = container.querySelector(
				'button[aria-label="Edit the queued steering"]',
			);
			if (node === null) throw new Error("no Edit button");
			return node;
		};
		const editor = (): HTMLTextAreaElement | null =>
			container.querySelector<HTMLTextAreaElement>("#steer-edit-text");
		try {
			await act(async () => {
				root.render(
					<Drawer {...base} act={runAct} task={task("first steer")} />,
				);
			});
			await act(async () => {
				onClickOf(editButton())({});
			});
			expect(editor()?.value).toBe("first steer");
			await act(async () => {
				const form = editor()?.closest("form");
				if (form == null) throw new Error("no steer edit form");
				form.dispatchEvent(
					new window.Event("submit", {
						bubbles: true,
						cancelable: true,
					}) as unknown as Event,
				);
			});
			// The refresh lands while the 409 is still in flight: with no conflict
			// yet, the pendingPrompt change clears the editor.
			await act(async () => {
				root.render(
					<Drawer {...base} act={runAct} task={task("second steer")} />,
				);
			});
			expect(editor()).toBeNull();
			// The refused answer arrives: the conflict flow restores the submitted
			// draft, so the notice's "your text is kept" holds after the race.
			gate.resolve();
			await act(async () => {});
			expect(container.textContent).toContain("changed while you were editing");
			expect(container.textContent).toContain("second steer");
			expect(editor()?.value).toBe("first steer");
		} finally {
			gate.resolve();
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});
});

describe("Drawer start actions wait for the prompt edit (client)", () => {
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};
	// React interaction needs browser globals; the setup mirrors the steering
	// describe above: happy-dom registers them for this describe, and afterAll
	// puts the originals back, so later test files in the same process see no DOM.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
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

	// happy-dom's dispatched clicks never reach React's event plugin (same
	// upstream gap as the steering describe above): call the production
	// onClick React rendered onto the node instead.
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
	// Buttons are found by their exact label; queries run on the DOM-typed
	// container, so the casts stay inside the DOM lib's type family.
	const button = (box: ParentNode, name: string): HTMLButtonElement => {
		const node = [...box.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === name,
		);
		if (node === undefined) throw new Error(`no ${name} button`);
		return node as HTMLButtonElement;
	};
	// The production onChange React rendered onto the node; textareas are typed by
	// calling it with a minimal event object, since happy-dom's dispatched input
	// event never reaches React's ChangeEventPlugin.
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
	/** Renders the task, opens the prompt editor, and runs `check` against the
	 * guarded start action with the editor open and after Cancel finishes it. */
	const expectGuard = async (
		task: TaskCard,
		label: string,
		freeTitle: string,
	): Promise<void> => {
		const realFetch = globalThis.fetch;
		// The drawer's effects fetch the task detail and degrade to the row on a
		// failed response, so the fixture's fields (editable, proposal) stay authoritative.
		globalThis.fetch = (async () =>
			new Response("{}", { status: 404 })) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		// The open editor's Cancel, scoped to its form: the drawer-actions row holds a
		// "Cancel task" button whose text also contains "Cancel".
		const editorCancel = (): HTMLButtonElement => {
			const box = container.querySelector("#edit-text")?.closest("form");
			if (box === undefined || box === null)
				throw new Error("no prompt edit form");
			const node = [...box.querySelectorAll("button")].find(
				(b) => b.textContent?.trim() === "Cancel",
			);
			if (node === undefined) throw new Error("no editor cancel button");
			return node as HTMLButtonElement;
		};
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={task} />);
			});
			const action = button(container, label);
			expect(action.disabled).toBe(false);
			expect(action.title).toBe(freeTitle);
			await act(async () => {
				onClickOf(button(container, "Edit task"))({});
			});
			expect(container.querySelector("#edit-text")).not.toBeNull();
			expect(action.disabled).toBe(true);
			expect(action.title).toBe("Save or cancel the prompt edit first");
			await act(async () => {
				onClickOf(editorCancel())({});
			});
			expect(action.disabled).toBe(false);
			expect(action.title).toBe(freeTitle);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	};

	test("a parked card's Plan with agent and Move to todo wait for the edit", async () => {
		const parked = cardFixture({
			...drawerFields,
			stage: "backlog",
			state: "idle",
			prompt: "parked idea",
		});
		await expectGuard(
			parked,
			"Plan with agent",
			"Asks rounds of questions to refine the idea before it runs",
		);
		await expectGuard(
			parked,
			"Move to todo",
			"Puts the card in the todo lane so the agent can start it",
		);
	});

	// The save flows through the act prop; the stub base.act never runs the body,
	// so these tests pass an act with the production contract: run the body,
	// swallow its error, report false.
	const runAct = async (fn: () => Promise<void>): Promise<boolean> => {
		try {
			await fn();
			return true;
		} catch {
			return false;
		}
	};

	// The prompt editor's Save button, scoped to its form: the drawer-actions row
	// holds buttons whose text also matches.
	const promptSaveButton = (box: ParentNode): HTMLButtonElement => {
		const form = box.querySelector("#edit-text")?.closest("form");
		if (form == null) throw new Error("no prompt edit form");
		const node = [...form.querySelectorAll("button")].find(
			(b) => b.type === "submit",
		);
		if (node === undefined) throw new Error("no prompt save button");
		return node as HTMLButtonElement;
	};
	const submitPromptEdit = async (container: HTMLDivElement): Promise<void> => {
		await act(async () => {
			const form = container.querySelector("#edit-text")?.closest("form");
			if (form == null) throw new Error("no prompt edit form");
			form.dispatchEvent(
				new window.Event("submit", {
					bubbles: true,
					cancelable: true,
				}) as unknown as Event,
			);
		});
	};

	test("the hold claim is guarded by the draft's revision and the save carries it", async () => {
		const realFetch = globalThis.fetch;
		// The claim carries the draft's snapshot revision: the server refuses a claim
		// whose revision is stale (another tab's content edit landed), and the save
		// carries the same snapshot revision the claim confirmed.
		const claims: Array<{ revision?: unknown }> = [];
		const saves: Array<{ revision?: unknown }> = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input);
			if (url.endsWith("/edit/start") && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as { revision?: unknown };
				claims.push(body);
				if (body.revision === 1)
					return new Response(JSON.stringify({ ok: true, revision: 1 }), {
						status: 200,
					});
				return new Response(
					JSON.stringify({
						error: "card changed since it was loaded",
						task: { id: "t1", revision: 5, prompt: "other tab text" },
					}),
					{ status: 409 },
				);
			}
			if (url.endsWith("/edit") && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as { revision?: unknown };
				saves.push(body);
				if (body.revision === 1) return new Response("{}", { status: 200 });
				return new Response(
					JSON.stringify({
						error: "card changed since it was loaded",
						task: { id: "t1", revision: 5 },
					}),
					{ status: 409 },
				);
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			prompt: "queued idea",
			revision: 1,
		});
		try {
			await act(async () => {
				root.render(<Drawer {...base} act={runAct} task={card} />);
			});
			await act(async () => {
				onClickOf(button(container, "Edit task"))({});
			});
			expect(container.querySelector("#edit-text")).not.toBeNull();
			await act(async () => {});
			await submitPromptEdit(container);
			expect(claims).toHaveLength(1);
			expect(claims[0]?.revision).toBe(1);
			expect(saves).toHaveLength(1);
			expect(saves[0]?.revision).toBe(1);
			expect(container.querySelector("#edit-text")).toBeNull();
			expect(container.textContent).not.toContain(
				"changed while you were editing",
			);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("Save waits for the hold claim before it enables", async () => {
		const realFetch = globalThis.fetch;
		const gate = Promise.withResolvers<void>();
		const saves: Array<{ revision?: unknown }> = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input);
			if (url.endsWith("/edit/start")) {
				await gate.promise;
				return new Response(JSON.stringify({ ok: true, revision: 1 }), {
					status: 200,
				});
			}
			if (url.endsWith("/edit") && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as { revision?: unknown };
				saves.push(body);
				return new Response("{}", { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			prompt: "queued idea",
			revision: 1,
		});
		try {
			await act(async () => {
				root.render(<Drawer {...base} act={runAct} task={card} />);
			});
			await act(async () => {
				onClickOf(button(container, "Edit task"))({});
			});
			expect(container.querySelector("#edit-text")).not.toBeNull();
			// The claim is still in flight: Save cannot fire the unconditional path.
			expect(promptSaveButton(container).disabled).toBe(true);
			await submitPromptEdit(container);
			expect(saves).toHaveLength(0);
			// The claim landed: the armed revision enables Save.
			gate.resolve();
			await act(async () => {});
			expect(promptSaveButton(container).disabled).toBe(false);
			await submitPromptEdit(container);
			expect(saves).toHaveLength(1);
			expect(saves[0]?.revision).toBe(1);
		} finally {
			gate.resolve();
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("a failed hold claim keeps Save disabled", async () => {
		const realFetch = globalThis.fetch;
		const saves: Array<unknown> = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input);
			if (url.endsWith("/edit/start"))
				return new Response("{}", { status: 500 });
			if (url.endsWith("/edit") && init?.method === "POST") {
				saves.push(JSON.parse(String(init.body)));
				return new Response("{}", { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			prompt: "queued idea",
			revision: 1,
		});
		try {
			await act(async () => {
				root.render(<Drawer {...base} act={runAct} task={card} />);
			});
			await act(async () => {
				onClickOf(button(container, "Edit task"))({});
			});
			expect(container.querySelector("#edit-text")).not.toBeNull();
			await act(async () => {});
			expect(promptSaveButton(container).disabled).toBe(true);
			await submitPromptEdit(container);
			expect(saves).toHaveLength(0);
			expect(container.querySelector("#edit-text")).not.toBeNull();
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("a refused hold claim shows the conflict and keeps the draft", async () => {
		const realFetch = globalThis.fetch;
		const saves: Array<{ prompt: string; revision?: unknown }> = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input);
			if (url.endsWith("/edit/start"))
				return new Response(
					JSON.stringify({
						error: "card changed since it was loaded",
						task: { id: "t1", revision: 5, prompt: "other tab text" },
					}),
					{ status: 409 },
				);
			if (url.endsWith("/edit") && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as {
					prompt: string;
					revision?: unknown;
				};
				saves.push(body);
				return new Response("{}", { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			prompt: "queued idea",
			revision: 1,
		});
		try {
			await act(async () => {
				root.render(<Drawer {...base} act={runAct} task={card} />);
			});
			await act(async () => {
				onClickOf(button(container, "Edit task"))({});
			});
			await act(async () => {});
			// The claim refused: the board's current prompt shows beside the kept
			// draft, and the re-armed revision makes an explicit re-save possible.
			expect(container.textContent).toContain("changed while you were editing");
			expect(container.textContent).toContain("other tab text");
			expect(container.querySelector("#edit-text")).not.toBeNull();
			expect(promptSaveButton(container).disabled).toBe(false);
			await submitPromptEdit(container);
			expect(saves).toHaveLength(1);
			expect(saves[0]?.prompt).toBe("queued idea");
			expect(saves[0]?.revision).toBe(5);
			expect(container.querySelector("#edit-text")).toBeNull();
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	test("a refused notes append retries onto the board's current notes", async () => {
		const realFetch = globalThis.fetch;
		const calls: Array<{ notes: string; revision?: unknown }> = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input);
			if (url.endsWith("/release-notes") && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as {
					notes: string;
					revision?: unknown;
				};
				calls.push(body);
				// The first append is refused with the other tab's row; the retry
				// must carry that row's notes as its base.
				if (calls.length === 1)
					return new Response(
						JSON.stringify({
							error: "card changed since it was loaded",
							task: {
								id: "t1",
								revision: 9,
								releaseNotes: "other tab notes",
							},
						}),
						{ status: 409 },
					);
				return new Response("{}", { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const card = cardFixture({
			...drawerFields,
			stage: "done",
			state: "needs_you",
			releaseVersion: "v1.0.0",
			releaseNotes: "original notes",
		});
		try {
			await act(async () => {
				root.render(<Drawer {...base} act={runAct} task={card} />);
			});
			const editNotes = container.querySelector(
				'button[aria-label="Edit release notes"]',
			);
			if (editNotes === null) throw new Error("no Edit release notes button");
			await act(async () => {
				onClickOf(editNotes)({});
			});
			const notes = container.querySelector("#release-notes-text");
			if (notes === null) throw new Error("no notes editor");
			await act(async () => {
				onChangeOf(notes)({ target: { value: "my addition" } });
			});
			const addNotes = [...container.querySelectorAll("button")].find(
				(b) => b.textContent?.trim() === "Add to notes",
			);
			if (addNotes === undefined) throw new Error("no Add to notes button");
			await act(async () => {
				onClickOf(addNotes)({});
			});
			expect(container.textContent).toContain("changed while you were editing");
			// The retry before any refresh: base and revision come from the same
			// current row, so the other tab's notes stay in the payload.
			await act(async () => {
				onClickOf(addNotes)({});
			});
			expect(calls).toHaveLength(2);
			expect(calls[1]?.notes).toBe("other tab notes\n\nmy addition");
			expect(calls[1]?.revision).toBe(9);
			expect(container.textContent).not.toContain(
				"changed while you were editing",
			);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});

	// The Plan with agent / Move to todo dialogs read the shared model catalog.
	// Each test answers /api/models itself and clears the cache after, so later
	// tests keep their retry-on-empty behavior; every other request degrades to
	// the row (the drawer's failed detail fetch), as in expectGuard above.
	const withCatalog = async (
		roles: Record<string, string>,
		cardModel: string | null,
		open: "Plan with agent" | "Move to todo",
		want: string,
	): Promise<void> => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/api/models"))
				return new Response(
					JSON.stringify({
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
						],
						roles,
					}),
					{ status: 200 },
				);
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		resetCatalogCache();
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const parked = cardFixture({
			...drawerFields,
			stage: "backlog",
			state: "idle",
			prompt: "parked idea",
			...(cardModel !== null ? { model: cardModel } : {}),
		});
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={parked} />);
			});
			// One more act lets the catalog fetch land before the dialog opens.
			await act(async () => {});
			await act(async () => {
				onClickOf(button(container, open))({});
			});
			expect(
				container
					.querySelector("button.model-trigger")
					?.getAttribute("aria-label"),
			).toBe(want);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
			resetCatalogCache();
		}
	};

	test("Plan with agent opens on the plan role's model", async () => {
		await withCatalog(
			{
				default: "zai/glm-5.3-flash",
				plan: "anthropic/claude-opus-5-5:medium",
			},
			null,
			"Plan with agent",
			"Model: anthropic/claude-opus-5-5:medium",
		);
	});

	test("Move to todo keeps the card's model even with a plan role", async () => {
		await withCatalog(
			{
				default: "zai/glm-5.3-flash",
				plan: "anthropic/claude-opus-5-5:medium",
			},
			"zai/glm-5.3-flash",
			"Move to todo",
			"Model: zai/glm-5.3-flash",
		);
	});

	test("Plan with agent keeps the card's model when no plan or slow role is assigned", async () => {
		await withCatalog(
			{ default: "zai/glm-5.3-flash" },
			"zai/glm-5.3-flash",
			"Plan with agent",
			"Model: zai/glm-5.3-flash",
		);
	});

	test("the open editor holds the card server-side and releases it on close", async () => {
		const realFetch = globalThis.fetch;
		// Record the hold calls; every other request degrades to null detail as above.
		const holds: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/edit/start") || url.endsWith("/edit/stop"))
				holds.push(url.endsWith("start") ? "start" : "stop");
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		// A queued todo card: the scheduler could start it at any tick, so its open
		// editor must claim the hold (start) and release it when the editor is gone.
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			prompt: "do the thing",
		});
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={task} />);
			});
			expect(holds).toEqual([]);
			await act(async () => {
				onClickOf(button(container, "Edit task"))({});
			});
			expect(holds).toEqual(["start"]);
			// A tab closing mid-edit cannot rely on the unmount cleanup (the page is
			// being torn down): pagehide fires first and releases with a keepalive call.
			await act(async () => {
				window.dispatchEvent(new window.Event("pagehide"));
			});
			expect(holds).toEqual(["start", "stop"]);
			// The drawer unmounts with the editor open (Esc, X, drawer switch): the
			// cleanup must release the hold too.
			await act(async () => {
				root.unmount();
			});
			expect(holds).toEqual(["start", "stop", "stop"]);
		} finally {
			container.remove();
			globalThis.fetch = realFetch;
		}
	});
});

describe("Drawer approve button", () => {
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};
	// The drawer itself is a native <dialog>, and closed compose dialogs render their
	// children into static markup. One primary per surface judges what is on screen,
	// so the closed `class="dialog"` blocks come out before counting; the drawer stays.
	const visiblePrimaries = (html: string): string[] =>
		html
			.replace(/<dialog class="dialog"[\s\S]*?<\/dialog>/g, "")
			.match(/class="primary"/g) ?? [];

	test("a parked merge hold renders the approve button", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"Update card: read the summary, then reply to approve the merge.",
			holdHead: "sha-parked",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain("Approve merge");
	});

	test("a parked hold keeps Approve merge the only primary; Reply drops to grey", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"Update card: read the summary, then reply to approve the merge.",
			holdHead: "sha-parked",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		// One primary per surface: the hold bar's decision wins, the composer's submit demotes.
		expect(visiblePrimaries(html)).toHaveLength(1);
		// Closed compose dialogs also render their children; judge the visible reply form.
		const visible = html.replace(
			/<dialog class="dialog"[\s\S]*?<\/dialog>/g,
			"",
		);
		expect(visible).not.toContain('type="submit" class="primary"');
	});

	test("a plain needs-you card keeps Reply as the one primary", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "in_progress",
			state: "needs_you",
			needsReason: "hit a blocker",
			holdHead: null,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(visiblePrimaries(html)).toHaveLength(1);
		expect(html).toContain('type="submit" class="primary"');
	});

	test("a done PR-review card keeps Post review the one primary beside the Follow up row", () => {
		const task = cardFixture({
			...drawerFields,
			kind: "pr_review",
			details: "Looks good — one nit below.",
			stage: "done",
			state: "idle",
			prReview: {
				url: "https://github.com/acme/repo/pull/7",
				number: 7,
				state: "open",
				reviewedHead: "sha-1",
				postedHead: null,
				postedLogin: null,
				postedUrl: null,
				postError: null,
			},
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain("Post review");
		expect(html).toContain("Follow up");
		expect(visiblePrimaries(html)).toHaveLength(1);
		expect(html).toContain(
			'<div class="followup-cta"><button type="button" class="followup-row">',
		);
	});

	test("a done card offers Follow up as the next-step row with its hint, no filled button", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		const cta = html.slice(html.indexOf('class="followup-cta"'));
		expect(cta).toMatch(
			/^class="followup-cta"><button type="button" class="followup-row">/,
		);
		expect(cta).toContain("<b>Follow up</b>");
		expect(cta).toContain(
			"<small>Creates a new task that continues this one with a full handoff.</small>",
		);
		expect(visiblePrimaries(html)).toHaveLength(0);
	});

	test("a needs-you card without a parked hold renders none", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "in_progress",
			state: "needs_you",
			needsReason: "hit a blocker",
			holdHead: null,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain("Approve merge");
	});

	test("an update hold pins summary and merge actions, no cancel", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "in_progress",
			state: "needs_you",
			needsReason: UPDATE_HOLD_REASON,
			holdHead: "sha-parked",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain("Read the summary");
		expect(html).toContain("Approve merge");
		expect(html).not.toContain("Cancel card");
	});

	test("a fork hold pins the approve action; the decline sits in the drawer-actions row", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "in_progress",
			state: "needs_you",
			needsReason: FORK_HOLD_REASON,
			holdHead: "sha-parked",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain("Approve merge");
		// No danger button beside the primary: the hold bar lost its Cancel card, and
		// the drawer-actions row's Cancel task (same confirm flow) is the decline path.
		expect(html).not.toContain("Cancel card");
		expect(html).toContain("Cancel task");
		expect(html).not.toContain("Read the summary");
	});

	test("a mismatch hold pins the approve action; the decline sits in the drawer-actions row", () => {
		// The diff button keys on the fetched diffFiles, which never ride this static render;
		// the server-side park captures the push-side stat the section then shows.
		const task = cardFixture({
			...drawerFields,
			stage: "in_progress",
			state: "needs_you",
			needsReason: MERGE_HOLD_MISMATCH_REASON,
			holdHead: "sha-parked",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain("Approve merge");
		// No danger button beside the primary: the hold bar lost its Cancel card, and
		// the drawer-actions row's Cancel task (same confirm flow) is the decline path.
		expect(html).not.toContain("Cancel card");
		expect(html).toContain("Cancel task");
		expect(html).not.toContain("Read the summary");
	});

	test("a proposal card keeps the Accept button under the old and the new reason prefix", () => {
		for (const needsReason of [
			"Proposed by the retro of Fix the widget. Accept to start it, edit the prompt first, or cancel to decline.",
			"Retro proposal from t3. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		]) {
			const task = cardFixture({
				...drawerFields,
				stage: "in_progress",
				state: "needs_you",
				needsReason,
			});
			const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
			expect(html).toContain("Accept");
			expect(html).toContain("Start the proposed task");
			expect(html).not.toContain("New session");
		}
	});

	test("a proposal reason links its source id; legacy wording and a gone id stay plain", () => {
		const source = cardFixture({
			id: "t3",
			title: "Fix the widget",
			sessionTitle: "Fix the widget",
			stage: "done",
			state: "idle",
			needsReason: null,
		});
		const taskWith = (needsReason: string) =>
			renderToStaticMarkup(
				<Drawer
					{...base}
					task={cardFixture({
						...drawerFields,
						stage: "in_progress",
						state: "needs_you",
						needsReason,
					})}
					tasks={[source]}
				/>,
			);
		// The current reason: the id is a link to the card, the rest stays text.
		const html = taskWith(
			"Retro proposal from t3. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		);
		expect(html).toContain('href="/projects/proj/tasks/t3"');
		expect(html).toContain('class="reason-card-link"');
		expect(html).toContain('title="Fix the widget"');
		expect(html).toContain("Retro proposal from <a");
		// A stored quoted-title row links the same id.
		expect(
			taskWith(
				'Retro proposal from t3 ("Fix the widget"). Accept starts it. Edit task changes the prompt first. Cancel task declines it.',
			),
		).toContain('href="/projects/proj/tasks/t3"');
		// Legacy wording names a title instead of an id: no link is promised.
		const legacy = taskWith(
			"Proposed by the retro of Fix the widget. Accept to start it, edit the prompt first, or cancel to decline.",
		);
		expect(legacy).toContain("Proposed by the retro of Fix the widget.");
		expect(legacy).not.toContain("reason-card-link");
		// An id the board no longer lists renders as plain text.
		const gone = taskWith(
			"Retro proposal from t9. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		);
		expect(gone).toContain("Retro proposal from t9.");
		expect(gone).not.toContain("reason-card-link");
	});

	const releaseFields = {
		...drawerFields,
		releaseVersion: "v1.2.3",
		releaseNotes: null,
		stage: "merging",
		state: "needs_you",
		asked: [
			{
				question: "Approve the release?",
				options: [],
				multi: false,
				recommended: null,
			},
		],
	} satisfies Partial<TaskCard>;

	test("a waiting release card lists late commits above the Approve action", () => {
		// lateCommits rides the drawer's TaskView, not the board row's TaskCard.
		const task = cardFixture({
			...releaseFields,
			lateCommits: [
				{
					sha: "aaaaaaaaaaaaaaaa",
					subject: "feat: outside work",
					reviewed: false,
				},
				{ sha: "bbbbbbbbbbbbbbbb", subject: "fix: y", reviewed: true },
			],
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain("Commits since the review");
		expect(html).toContain("feat: outside work");
		expect(html).toContain("fix: y");
		expect(html).toContain("not reviewed");
		expect(html).toContain("review fix");
		const approve = html.indexOf(
			'title="Replies &quot;Approve&quot; to the waiting session"',
		);
		const section = html.indexOf("Commits since the review");
		expect(section).toBeGreaterThanOrEqual(0);
		expect(section).toBeLessThan(approve);
	});

	test("a waiting release card without late commits renders no section", () => {
		const task = cardFixture(releaseFields);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain("Commits since the review");
	});

	test("the ask renders above the worktree files section", () => {
		// The questions lead the drawer body. The changed files section renders from
		// the fetched detail, which a static render never has; it sits right after
		// this section in the JSX, so the ask stays ahead of both file lists.
		const task = cardFixture({
			...drawerFields,
			state: "needs_you",
			asked: [
				{
					question: "Which auth flow?",
					options: [],
					multi: false,
					recommended: null,
				},
			],
			worktreeFiles: ["mockup.html"],
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		const ask = html.indexOf("Which auth flow?");
		const wt = html.indexOf('id="drawer-wt"');
		expect(ask).toBeGreaterThanOrEqual(0);
		expect(wt).toBeGreaterThan(ask);
	});

	test("a done card keeps worktree files as names, not links", () => {
		// The worktree is removed once the card settles done, so the captured
		// names render as plain paths and the hint explains the capture.
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
			worktreeFiles: ["research-report.md", "scratch.txt"],
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		const wt = html.indexOf('id="drawer-wt"');
		expect(wt).toBeGreaterThanOrEqual(0);
		expect(html).toContain("research-report.md");
		expect(html).toContain("scratch.txt");
		expect(html).toContain("captured when it finished");
		expect(html).not.toContain("/files?path=");
	});

	test("a done card with saved files renders the saved files section", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
			worktreeFiles: ["research-report.md"],
			savedFiles: [
				{ name: "mockup.html", size: 63210 },
				{ name: "nested/style.css", size: 17 },
			],
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-saved"');
		expect(html).toContain("Saved files");
		expect(html).toContain("saved-files?path=mockup.html");
		expect(html).toContain("63.2 kB");
		expect(html).toContain("Kept copies are under Saved files.");
	});

	test("a done card without saved files renders no saved section and keeps the old hint", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
			worktreeFiles: ["research-report.md"],
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain('id="drawer-saved"');
		expect(html).toContain("The worktree is gone, so only the names remain.");
		expect(html).not.toContain("Kept copies are under Saved files.");
	});
});

describe("cancelled cards on the board", () => {
	const base = {
		projectTasks: [] as TaskCard[],
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: () => {},
		unread: () => false,
		onReorder: async () => true,
		filtering: false,
		draining: false,
	} as const;

	test("a cancelled done card wears the Cancelled chip with its cancel time", () => {
		const dead = cardFixture({
			id: "d1",
			stage: "done",
			state: "idle",
			cancelledAt: 1760000000000,
			answered: true,
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[dead]} more={0} />,
		);
		expect(html).toContain('data-cancelled=""');
		expect(html).toContain('class="cancelled"');
		// The chip keeps the word and a relative cancel time; the exact stamp is its title.
		expect(html).toContain("Cancelled · ");
		expect(html).toContain('title="Cancelled ');
		// The status word says cancelled, and the final answer earns no unread badge.
		expect(html).toContain("· cancelled");
		expect(html).not.toContain('class="unread"');
	});

	test("a cancelled card never joins the Starred section or the Inbox lane", () => {
		const deadStar = cardFixture({
			id: "s1",
			stage: "done",
			state: "idle",
			cancelledAt: 5,
			starred: true,
			research: true,
		});
		const html = renderToStaticMarkup(
			// The unread callback answers true, like a stale seen set would: the cancelled
			// card must still stay out of both pinned sections.
			<LaneCol
				{...base}
				stage="done"
				tasks={[deadStar]}
				unread={() => true}
				more={0}
			/>,
		);
		expect(html).not.toContain("Inbox");
		expect(html).not.toContain("Starred");
		expect(html).toContain('data-task-id="s1"');
		// The star never replaces the cancelled x, not even on a starred card.
		expect(html).toContain("mark-cancelled");
		expect(html).not.toContain("mark-star");
	});

	test("a cancelled update card covers nothing, so its rows stay actionable", () => {
		// The same updateIds sets the updates panel's Skip button and the inbox entry read.
		const open = cardFixture({
			id: "u-open",
			stage: "in_progress",
			state: "running",
			updateIds: ["u1", "u2"],
		});
		const dead = cardFixture({
			id: "u-dead",
			stage: "in_progress",
			state: "idle",
			cancelledAt: 5,
			updateIds: ["u2", "u3"],
		});
		const done = cardFixture({
			id: "u-done",
			stage: "done",
			state: "idle",
			updateIds: ["u4"],
		});
		const covered = coveredUpdateIds([open, dead, done]);
		// The cancelled card's u2 does not steal the open card's coverage, and u3 stays free.
		expect(covered.get("u1")?.id).toBe("u-open");
		expect(covered.get("u2")?.id).toBe("u-open");
		expect(covered.has("u3")).toBe(false);
		// A done card covers nothing either: its rows are pending again.
		expect(covered.has("u4")).toBe(false);
	});

	test("the Overview table counts a cancelled in-progress card under Done", () => {
		const live = cardFixture({ id: "live-1", stage: "todo", state: "queued" });
		const dead = cardFixture({
			id: "dead-1",
			stage: "in_progress",
			state: "idle",
			cancelledAt: 1760000000000,
			updatedAt: 1760000000000,
		});
		const project = {
			name: "proj",
			icon: null,
			hasRules: true,
			gitless: false,
			dirty: false,
			settings: {},
		} as unknown as ProjectView;
		const html = renderToStaticMarkup(
			<Overview
				projects={[project]}
				tasks={[live, dead]}
				compose={() => {}}
				onAdd={() => {}}
				openTask={() => {}}
				navigate={() => {}}
				prov={{ data: null, err: null }}
			/>,
		);
		// The project row's stage cells in column order: the cancelled card leaves
		// In progress empty and lands in Done, like the board lanes show it.
		const window = new Window({ url: "http://localhost/" });
		const container = window.document.createElement("div");
		container.innerHTML = html;
		const cellText = (label: string) =>
			container.querySelector(`td[data-label="${label}"]`)!.textContent;
		expect(cellText("Todo")).toBe("1");
		expect(cellText("In progress")).toBe("0");
		expect(cellText("Merging")).toBe("0");
		expect(cellText("Done")).toBe("1");
		// Last activity counts the cancel stamp: updateTask bumps updated_at, so the
		// cell shows a relative time instead of the empty dash.
		expect(cellText("Last activity")).not.toBe("–");
	});
});

describe("Drawer research report button", () => {
	// The drawer fetches the full task (with the report) in an effect, which
	// renderToStaticMarkup never runs. Mount with happy-dom, the same pattern as
	// settings.test.tsx, and serve the fetches through a mocked global fetch.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	// OTTR-449's shape: the steps heading sits mid-report and holds a word between
	// "recommended" and "steps".
	const report449 = [
		"## Short answer",
		"",
		"Answer: an explicit recommendations field.",
		"",
		"## Recommended adoption steps",
		"",
		"1. Add the field to the card state.",
		"2. Read it in the drawer.",
	].join("\n");
	// The full task the detail fetch returns; the card fixture's fields plus what
	// the done view reads beyond the row (turns, check log, hold head, report).
	const detailBody = {
		...cardFixture({ id: "R-1", stage: "done", state: "idle", research: true }),
		turns: [],
		workCheckLog: [],
		details: null,
		report: report449,
		diffFiles: null,
		holdHead: null,
		mergeHead: null,
		branch: null,
		base: null,
		worktree: null,
		sessionId: null,
		model: null,
		commits: [],
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
	} as unknown as TaskView;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Node: window.Node,
		getComputedStyle: window.getComputedStyle,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		fetch: (url: unknown): Promise<Response> => {
			const u = String(url);
			const body = u.endsWith("/tasks/R-1")
				? detailBody
				: u.endsWith("/tasks/R-1/context")
					? { context: null }
					: null;
			return Promise.resolve(
				body === null
					? new Response("{}", { status: 404 })
					: new Response(JSON.stringify(body), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
			);
		},
	};
	const originals = new Map<string, unknown>();
	// Fields the Drawer body reads before the detail fetch lands; cardFixture's
	// short cast omits them (the cancelled-card fixture carries the same set).
	const rowFields = {
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	};

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

	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1 },
	} as unknown as ProjectView;
	const base = {
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};

	/** Mounts the drawer for a task row and flushes the detail fetch. */
	const mountDrawer = async (
		task: TaskCard,
	): Promise<{
		container: HTMLElement;
		unmount: () => Promise<void>;
	}> => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(<Drawer {...base} task={task} />);
		});
		await act(async () => {});
		return {
			container,
			// Inside act, so no callback survives the test into the next one.
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
			},
		};
	};

	test("a live turn's chip ticks elapsed instead of reading running", async () => {
		// The Work steps chip shows the shared duration for a finished turn; the live
		// turn renders the ticking elapsed clock (LiveElapsed), never the old word.
		const liveTurn = {
			id: 1,
			taskId: "R-1",
			kind: "work",
			input: null,
			inputBy: null,
			startedAt: Date.now() - 65_000,
			endedAt: null,
			pid: null,
			exitCode: null,
			outcome: null,
			summary: null,
			details: null,
			question: null,
			error: null,
			model: null,
		};
		detailBody.turns = [liveTurn] as unknown as typeof detailBody.turns;
		const row = cardFixture({
			id: "R-1",
			kind: "work",
			research: true,
			stage: "in_progress",
			state: "running",
			// The pre-fetch render builds the steps from the row: the short cast's
			// missing workCheckLog would crash workSteps (same set as the siblings).
			...rowFields,
		});
		const { container, unmount } = await mountDrawer(row);
		const dur = container.querySelector(".turn-dur")?.textContent ?? "";
		expect(dur).toContain("1m");
		expect(dur).not.toBe("running");
		await act(async () => {
			detailBody.turns = [];
		});
		await unmount();
	});

	test("Work steps opens on a live ticket and starts collapsed on a done one", async () => {
		const live = cardFixture({
			id: "R-1",
			kind: "work",
			research: true,
			stage: "in_progress",
			state: "running",
			...rowFields,
		});
		const open = await mountDrawer(live);
		try {
			const btn = open.container.querySelector<HTMLButtonElement>(
				'button[aria-controls="drawer-steps"]',
			);
			expect(btn?.getAttribute("aria-expanded")).toBe("true");
			expect(btn?.closest("h3")?.hasAttribute("data-collapsed")).toBe(false);
			expect(
				open.container.querySelector("#drawer-steps")?.hasAttribute("hidden"),
			).toBe(false);
		} finally {
			await open.unmount();
		}
		const done = cardFixture({
			id: "R-2",
			kind: "work",
			research: true,
			stage: "done",
			state: "idle",
			...rowFields,
		});
		const shut = await mountDrawer(done);
		try {
			const btn = shut.container.querySelector<HTMLButtonElement>(
				'button[aria-controls="drawer-steps"]',
			);
			expect(btn?.getAttribute("aria-expanded")).toBe("false");
			expect(btn?.closest("h3")?.getAttribute("data-collapsed")).toBe("true");
			expect(
				shut.container.querySelector("#drawer-steps")?.hasAttribute("hidden"),
			).toBe(true);
		} finally {
			await shut.unmount();
		}
	});

	test("a turn that served another model than dispatched names the swap", async () => {
		// The provider-error fallback: the timeline row says what was dispatched and
		// what ran, so a steered model pick that did not run is legible, not silent.
		const swapped = {
			id: 1,
			taskId: "R-1",
			kind: "work",
			input: null,
			inputBy: null,
			startedAt: Date.now() - 65_000,
			endedAt: Date.now() - 5_000,
			pid: null,
			exitCode: 0,
			outcome: "ready",
			summary: null,
			details: null,
			question: null,
			error: null,
			model: "zai/glm-5.3",
			dispatchedModel: "anthropic/claude-opus-5-5:medium",
		};
		detailBody.turns = [swapped] as unknown as typeof detailBody.turns;
		const row = cardFixture({
			id: "R-1",
			kind: "work",
			research: true,
			stage: "done",
			state: "idle",
			...rowFields,
		});
		const { container, unmount } = await mountDrawer(row);
		try {
			const note = container.querySelector(".turn-sum")?.textContent ?? "";
			expect(note).toContain("dispatched");
			expect(note).toContain("claude-opus-5-5:medium");
			expect(note).toContain("ran");
			expect(note).toContain("glm-5.3");
		} finally {
			await act(async () => {
				detailBody.turns = [];
			});
			await unmount();
		}
	});

	test("a turn without a dispatched selector renders no swap note", async () => {
		const steady = {
			id: 2,
			taskId: "R-1",
			kind: "work",
			input: null,
			inputBy: null,
			startedAt: Date.now() - 65_000,
			endedAt: Date.now() - 5_000,
			pid: null,
			exitCode: 0,
			outcome: "ready",
			summary: null,
			details: null,
			question: null,
			error: null,
			model: "zai/glm-5.3",
			dispatchedModel: null,
		};
		detailBody.turns = [steady] as unknown as typeof detailBody.turns;
		const row = cardFixture({
			id: "R-1",
			kind: "work",
			research: true,
			stage: "done",
			state: "idle",
			...rowFields,
		});
		const { container, unmount } = await mountDrawer(row);
		try {
			const head = container.querySelector(".turn-head")?.textContent ?? "";
			expect(head).toContain("glm-5.3");
			expect(container.textContent).not.toContain("dispatched");
		} finally {
			await act(async () => {
				detailBody.turns = [];
			});
			await unmount();
		}
	});

	test("a done research card whose report recommends steps shows Implement steps", async () => {
		const row = cardFixture({
			id: "R-1",
			kind: "work",
			research: true,
			stage: "done",
			state: "idle",
			...rowFields,
		});
		const { container, unmount } = await mountDrawer(row);
		try {
			expect(container.innerHTML).toContain("Follow up");
			expect(container.innerHTML).toContain("Implement steps");
		} finally {
			await unmount();
		}
	});

	test("Implement steps opens a model pick on the default model and posts nothing yet", async () => {
		const row = cardFixture({
			id: "R-1",
			kind: "work",
			research: true,
			stage: "done",
			state: "idle",
			...rowFields,
		});
		const { container, unmount } = await mountDrawer(row);
		const realFetch = host.fetch as typeof fetch;
		const posted: string[] = [];
		host.fetch = ((url: unknown, init?: RequestInit) => {
			if (init?.method === "POST") posted.push(String(url));
			return realFetch(url as RequestInfo, init);
		}) as typeof fetch;
		try {
			const button = [...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Implement steps",
			);
			expect(button).toBeDefined();
			await act(async () => {
				button?.click();
			});
			const dialog = document.querySelector(
				'dialog[aria-label="Implement steps"]',
			);
			expect(dialog).not.toBeNull();
			expect(dialog?.innerHTML).toContain("Default model");
			expect(posted).toEqual([]);
		} finally {
			host.fetch = realFetch;
			await unmount();
		}
	});

	test("a done research card without a step section hides Implement steps", async () => {
		detailBody.report = "## Short answer\n\nNothing to do.";
		const row = cardFixture({
			id: "R-1",
			kind: "work",
			research: true,
			stage: "done",
			state: "idle",
			...rowFields,
		});
		const { container, unmount } = await mountDrawer(row);
		try {
			expect(container.innerHTML).toContain("Follow up");
			expect(container.innerHTML).not.toContain("Implement steps");
		} finally {
			await unmount();
		}
	});
});

describe("Drawer of a cancelled card opens read-only", () => {
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1 },
	} as unknown as ProjectView;
	const base = {
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};

	test("a cancelled done card keeps its story and loses every action", () => {
		const dead = cardFixture({
			...drawerFields,
			id: "D-1",
			stage: "done",
			state: "idle",
			cancelledAt: 1760000000000,
			prompt: "the original ask, kept readable",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={dead} />);
		// Read-only does not mean blind: prompt, cancel stamp, summary and log stay.
		expect(html).toContain("the original ask, kept readable");
		expect(html).toContain("cancelled");
		expect(html).toContain('class="turns"');
		// No action button survives: follow-up, cancel/delete, unread flip.
		expect(html).not.toContain("Follow up");
		expect(html).not.toContain("Implement steps");
		expect(html).not.toContain("Cancel task");
		expect(html).not.toContain("Delete task");
		expect(html).not.toContain("Mark unread");
		expect(html).not.toContain("Merge anyway");
	});

	test("a done steps report offers both drawer buttons", () => {
		const task = cardFixture({
			...drawerFields,
			id: "R-1",
			stage: "done",
			state: "idle",
			research: true,
			steps: "yes",
			report: "## Recommended steps\n\n1. Buy the rack",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain("Implement steps");
		expect(html).toContain("No further steps");
	});

	test("a pure-info research card offers neither steps button", () => {
		const task = cardFixture({
			...drawerFields,
			id: "R-2",
			stage: "done",
			state: "idle",
			research: true,
			steps: "no",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain("Implement steps");
		expect(html).not.toContain("No further steps");
	});

	test("a quiet research card with an unmatched report offers neither steps button", () => {
		const task = cardFixture({
			...drawerFields,
			id: "R-3",
			stage: "done",
			state: "idle",
			research: true,
			steps: "unknown",
			report: "## Short answer\n\nThe rack fits as-is.",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain("Implement steps");
		expect(html).not.toContain("No further steps");
	});

	test("a cancelled steps card stays read-only: no steps buttons", () => {
		const dead = cardFixture({
			...drawerFields,
			id: "R-4",
			stage: "done",
			state: "idle",
			cancelledAt: 1760000000000,
			research: true,
			steps: "yes",
			report: "## Recommended steps\n\n1. Buy the rack",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={dead} />);
		expect(html).not.toContain("Implement steps");
		expect(html).not.toContain("No further steps");
	});

	test("a cancelled non-done card hides triage, editing and the cancel button", () => {
		const dead = cardFixture({
			...drawerFields,
			id: "D-2",
			stage: "in_progress",
			state: "idle",
			cancelledAt: 1760000000000,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={dead} />);
		expect(html).not.toContain("drawer-triage");
		expect(html).not.toContain("Cancel task");
		// The reply and steer forms key off state needs_you/running; idle shows none.
		expect(html).not.toContain('id="drawer-reply"');
		expect(html).not.toContain('label="Steer"');
	});

	// OTTR-565: the pr_review drawer's second composer asks for a fresh draft.
	const prView = (state: "open" | "closed"): PrReviewView => ({
		number: 7,
		url: "https://github.com/acme/widget/pull/7",
		state,
		reviewedHead: "c".repeat(40),
		postedHead: null,
		postedUrl: null,
		postedLogin: null,
		postError: null,
	});

	test("an open pr_review drawer shows the ask-for-draft composer", () => {
		const task = cardFixture({
			...drawerFields,
			id: "P-1",
			kind: "pr_review",
			stage: "done",
			state: "idle",
			details: "## Summary\nreview",
			prReview: prView("open"),
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain("Ask for a new draft");
		expect(html).toContain('id="pr-review-note"');
	});

	test("a closed pr_review drawer hides the ask-for-draft composer", () => {
		const task = cardFixture({
			...drawerFields,
			id: "P-2",
			kind: "pr_review",
			stage: "done",
			state: "idle",
			details: "## Summary\nreview",
			prReview: prView("closed"),
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain("Ask for a new draft");
		expect(html).not.toContain('id="pr-review-note"');
	});

	// A pr_review card waits as needs_you until its draft is posted; the PR section owns the input.
	const waitingReview = (): TaskCard =>
		cardFixture({
			...drawerFields,
			id: "P-3",
			kind: "pr_review",
			stage: "in_progress",
			state: "needs_you",
			needsReason: PR_REVIEW_WAITING,
			// drawerFields parks a merge hold; a PR review card never has one.
			holdHead: null,
			prReview: prView("open"),
		});
	// The drawer fetches details after mount, so a static Drawer render never has the draft;
	// the draft-dependent checks render the PR section with the loaded view instead.
	const section = (
		card: TaskCard,
		draft: string,
		pr = prView("open"),
	): string => {
		const view: TaskView = {
			...card,
			turns: [],
			details: draft,
			report: null,
			diffFiles: null,
		};
		return renderToStaticMarkup(
			<PrReviewSection
				task={view}
				pr={pr}
				draft={draft}
				act={async () => true}
				onLoaded={() => {}}
			/>,
		);
	};
	const postButton = (html: string): string => {
		const m = /<button(?:(?!<button)[\s\S])*?Post review<\/button>/.exec(html);
		if (m === null) throw new Error("no Post review button");
		return m[0];
	};

	test("a needs_you pr_review drawer shows the PR section and no generic reply composer", () => {
		const html = renderToStaticMarkup(
			<Drawer {...base} task={waitingReview()} />,
		);
		expect(html).toContain('id="pr-review-text"');
		expect(html).not.toContain('id="drawer-reply"');
		expect(html).not.toContain("New session");
		// The Post button is the one primary; closed compose dialogs do not count.
		const visible = html.replace(
			/<dialog class="dialog"[\s\S]*?<\/dialog>/g,
			"",
		);
		expect(visible.match(/class="primary"/g)).toHaveLength(1);
	});

	test("a needs_you pr_review draft is postable", () => {
		const html = section(waitingReview(), "## Summary\nreview");
		expect(html).toContain("## Summary\nreview</textarea>");
		expect(postButton(html)).not.toContain("disabled");
	});

	test("a posted head or a cancelled card keeps Post disabled", () => {
		const posted = section(waitingReview(), "## Summary\nreview", {
			...prView("open"),
			postedHead: "c".repeat(40),
		});
		expect(postButton(posted)).toContain("disabled");
		const cancelled = section(
			{ ...waitingReview(), cancelledAt: 1760000000000 },
			"## Summary\nreview",
		);
		expect(postButton(cancelled)).toContain("disabled");
		expect(cancelled).toContain("The card is cancelled");
	});

	test("the pr_review hint counts the inline comments of the draft", () => {
		const draft = [
			"## Summary",
			"Two nits.",
			"<!-- inline src/a.ts:3 -->",
			"Rename this.",
			"<!-- /inline -->",
			"<!-- inline src/b.ts:4-6 -->",
			"```suggestion",
			"const x = 1;",
			"```",
			"<!-- /inline -->",
		].join("\n");
		const two = section(waitingReview(), draft);
		expect(two).toMatch(/id="pr-review-inline"[^>]*>2 inline comments/);
		expect(two).toContain('aria-describedby="pr-review-inline"');
		const none = section(waitingReview(), "## Summary\nfine");
		expect(none).toMatch(/id="pr-review-inline"[^>]*>No inline comments/);
	});
});

describe("LaneCol release hold", () => {
	const base = {
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: () => {},
		unread: () => false,
		onReorder: async () => true,
		filtering: false,
		draining: false,
		onRerelease: () => {},
	} as const;

	// The release card parked with its findings done: the board names the held merges.
	const releaseCard = (heldMerges?: string[]): TaskCard =>
		cardFixture({
			id: "r1",
			releaseVersion: "v0.3.0",
			stage: "merging",
			state: "needs_you",
			doneAt: 10,
			heldMerges,
		});
	const finding = (stage: "done" | "todo", id: string): TaskCard =>
		cardFixture({
			id,
			followUpOf: "r1",
			stage,
			state: stage === "done" ? "idle" : "queued",
		});
	const heldMerge = (id: string): TaskCard =>
		cardFixture({ id, stage: "merging", state: "queued" });

	test("a stalled release card names its done findings and the waiting merges", () => {
		const r1 = releaseCard(["m1", "m2"]);
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="merging"
				tasks={[r1]}
				projectTasks={[
					r1,
					finding("done", "f1"),
					finding("done", "f2"),
					heldMerge("m1"),
					heldMerge("m2"),
				]}
			/>,
		);
		expect(html).toContain("merges wait for this release");
		expect(html).toContain("All 2 findings are done.");
		expect(html).toContain("m1, m2");
		expect(html).toContain("Release again");
	});

	test("a waiting PR review card shows its reason as a grey line, not an error", () => {
		const pr = cardFixture({
			id: "p9",
			kind: "pr_review",
			stage: "in_progress",
			state: "needs_you",
			needsReason: PR_REVIEW_WAITING,
		});
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="in_progress"
				tasks={[pr]}
				projectTasks={[pr]}
			/>,
		);
		expect(html).toContain(
			`class="card-error card-silent" title="${PR_REVIEW_WAITING}"`,
		);
	});

	test("an unread PR review card still renders in the In progress lane", () => {
		// Every pr_review card is seenable, so a new one is unread; only Done pins unread cards.
		const pr = cardFixture({
			id: "p10",
			kind: "pr_review",
			stage: "in_progress",
			state: "needs_you",
			needsReason: PR_REVIEW_WAITING,
		});
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="in_progress"
				tasks={[pr]}
				projectTasks={[pr]}
				unread={() => true}
			/>,
		);
		expect(html.match(/title="Task p10"/g)).toHaveLength(1);
	});

	test("a release card with an open finding shows no re-release line", () => {
		const r1 = releaseCard(["m1"]);
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="merging"
				tasks={[r1]}
				projectTasks={[r1, finding("todo", "f1"), heldMerge("m1")]}
			/>,
		);
		expect(html).not.toContain("merges wait for this release");
		expect(html).not.toContain("Release again");
	});

	test("a held queued merging card links to the release card holding it", () => {
		const r1 = releaseCard(["m1"]);
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="todo"
				tasks={[heldMerge("m1")]}
				projectTasks={[r1, finding("done", "f3"), heldMerge("m1")]}
			/>,
		);
		expect(html).toContain("hold-link");
		expect(html).toContain("r1");
	});
});

describe("Overview Context, max tile and column", () => {
	// A stat with one reading or a silent one; the fixtures stay as small as the strip reads.
	const st = (v: number | null): PerfStat => ({
		value: v,
		prev: null,
		series: v === null ? [null] : [v],
	});
	const fleet = (
		contextMaxTokens: PerfStat,
		contextMaxTask: {
			project: string;
			id: string;
		} | null,
	): PerfMetrics => ({
		throughput: st(3),
		leadMedianMs: st(60000),
		leadP90Ms: st(120000),
		firstPass: st(0.8),
		failure: st(0.05),
		spend: st(1.5),
		contextAvgTokens: st(90_000),
		contextMaxTokens,
		contextMaxTask,
		done: 4,
		firstPassDone: 3,
		turns: 10,
		failedTurns: 1,
		costMissing: 0,
		contextMissing: 0,
	});
	// PerfTable's project lookup reads only the name and display name.
	const project = {
		name: "ottr",
		settings: {},
	} as unknown as ProjectView;

	test("the max tile renders and links its task", () => {
		let opened = "";
		const html = renderToStaticMarkup(
			<KpiStrip
				fleet={fleet(st(130_000), { project: "ottr", id: "big-2" })}
				openTask={(id) => {
					opened = id;
				}}
			/>,
		);
		expect(html).toContain("Context, max");
		expect(html).toContain("130k");
		expect(html).toContain("big-2");
		expect(html).toContain(`title="Open ottr big-2"`);
		// Static markup cannot fire events; the onClick wiring is the openTask id above.
		expect(opened).toBe("");
	});

	test("the max tile shows a dash without any reading", () => {
		const html = renderToStaticMarkup(
			<KpiStrip fleet={fleet(st(null), null)} openTask={() => {}} />,
		);
		expect(html).toContain("Context, max");
		expect(html).toContain("–");
		expect(html).not.toContain("v-link");
	});

	test("the per-project table column links its task", () => {
		const html = renderToStaticMarkup(
			<PerfTable
				perf={{
					range: "all",
					bucketMs: 3_600_000,
					seriesStart: 0,
					fleet: fleet(st(130_000), { project: "ottr", id: "big-2" }),
					projects: [
						{
							...fleet(st(130_000), { project: "ottr", id: "big-2" }),
							name: "ottr",
						},
					],
				}}
				projects={[project]}
				openTask={() => {}}
			/>,
		);
		expect(html).toContain("Context (max)");
		expect(html).toContain("130k");
		expect(html).toContain(`title="Open ottr big-2"`);
	});
});

describe("implementSteps", () => {
	/** Fetch stub recording each URL and request body; answers one JSON body. */
	function stubFetch(responses: Array<{ status: number; body: unknown }>) {
		const calls: string[] = [];
		const bodies: unknown[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push(String(input));
			bodies.push(JSON.parse(String(init?.body)));
			const next = responses.shift()!;
			return new Response(JSON.stringify(next.body), { status: next.status });
		}) as typeof fetch;
		return {
			calls,
			bodies,
			restore: () => {
				globalThis.fetch = real;
			},
		};
	}

	test("clears the pin after the follow-up lands on the picked model, then hands off", async () => {
		const stub = stubFetch([
			{ status: 200, body: { id: "NEXT-1", project: "proj" } },
		]);
		try {
			await implementSteps({
				task: { project: "proj", id: "R-1" },
				model: "anthropic/claude-opus:high",
				onMarkSeen: () => stub.calls.push("markSeen"),
				onFollowed: (id, from) => stub.calls.push(`followed:${id}:${from}`),
			});
		} finally {
			stub.restore();
		}
		expect(stub.calls).toEqual([
			"/api/projects/proj/tasks/R-1/follow-up",
			"markSeen",
			"followed:NEXT-1:R-1",
		]);
		expect(stub.bodies[0]).toMatchObject({
			model: "anthropic/claude-opus:high",
		});
	});

	test("an unchanged pick sends no model, so the server runs the default", async () => {
		const stub = stubFetch([
			{ status: 200, body: { id: "NEXT-1", project: "proj" } },
		]);
		try {
			await implementSteps({
				task: { project: "proj", id: "R-1" },
				model: "",
				onMarkSeen: () => {},
				onFollowed: () => {},
			});
		} finally {
			stub.restore();
		}
		expect(stub.bodies[0]).not.toHaveProperty("model");
	});

	test("a failed follow-up leaves the pin up", async () => {
		const stub = stubFetch([{ status: 500, body: { error: "nope" } }]);
		try {
			await expect(
				implementSteps({
					task: { project: "proj", id: "R-1" },
					model: "",
					onMarkSeen: () => stub.calls.push("markSeen"),
					onFollowed: () => stub.calls.push("followed"),
				}),
			).rejects.toThrow("nope");
		} finally {
			stub.restore();
		}
		// Only the failed fetch ran: nothing marked, nothing followed.
		expect(stub.calls).toEqual(["/api/projects/proj/tasks/R-1/follow-up"]);
	});
});

describe("FollowUpDialog project picker", () => {
	// Same happy-dom setup as the drawer tests: globals for this describe only.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const bodies: Array<{ url: string; body: unknown }> = [];
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Node: window.Node,
		getComputedStyle: window.getComputedStyle,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		fetch: (url: unknown, init?: RequestInit): Promise<Response> => {
			const u = String(url);
			if (!u.endsWith("/follow-up"))
				return Promise.resolve(new Response("{}", { status: 404 }));
			bodies.push({ url: u, body: JSON.parse(String(init?.body)) });
			return Promise.resolve(
				new Response(JSON.stringify({ id: "N-1", project: "other" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		},
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
	test("files the follow-up into the picked project", async () => {
		const proj = (name: string) =>
			({ name, gitless: false, settings: {} }) as unknown as ProjectView;
		const followed: string[] = [];
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const q = (sel: string): Element => {
			const node = container.querySelector(sel);
			if (node === null) throw new Error(`no ${sel}`);
			return node as unknown as Element;
		};
		try {
			await act(async () => {
				root.render(
					<FollowUpDialog
						task={
							{
								...cardFixture({ id: "D-1" }),
								project: "proj",
							} as unknown as TaskView
						}
						projects={[proj("proj"), proj("other")]}
						open
						onClose={() => {}}
						act={async (fn) => {
							await fn();
							return true;
						}}
						onFollowed={(id, from) => followed.push(`${id}:${from}`)}
					/>,
				);
			});
			const select = q(".followup-project select") as HTMLSelectElement;
			expect(select.value).toBe("proj");
			// happy-dom's dispatched events never reach React's event plugin (see onClickOf):
			// call the handlers React rendered. Its select and form are Proxies that hide own
			// keys, so the props key comes from the textarea; every node of one root shares it.
			const form = q("form.dialog-body");
			const key = Object.getOwnPropertyNames(q("textarea")).find((k) =>
				k.startsWith("__reactProps$"),
			);
			if (key === undefined) throw new Error("no React props");
			const handler = (node: Element, name: string): ((e: unknown) => void) => {
				const props: unknown = Reflect.get(node, key);
				const fn =
					typeof props === "object" && props !== null
						? Reflect.get(props, name)
						: undefined;
				if (typeof fn !== "function") throw new Error(`no ${name}`);
				return fn;
			};
			await act(async () => {
				handler(select, "onChange")({ target: { value: "other" } });
			});
			await act(async () => {
				handler(q("textarea"), "onChange")({ target: { value: "next step" } });
			});
			await act(async () => {
				handler(form, "onSubmit")({ preventDefault: () => {} });
				// The send resolves after the handler returns: let the POST and its state updates land.
				await Bun.sleep(0);
			});
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.url).toBe("/api/projects/proj/tasks/D-1/follow-up");
		expect(bodies[0]?.body).toMatchObject({
			text: "next step",
			project: "other",
		});
		expect(followed).toEqual(["N-1:D-1"]);
	});
});

describe("path URL card links", () => {
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
		updateIds: [],
	} as unknown as Partial<TaskCard>;
	const drawerBase = {
		project: {
			name: "proj",
			hasRules: true,
			github: null,
			sessionsDir: "/tmp/sessions",
			settings: { maxParallel: 1 },
		} as unknown as ProjectView,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: false,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};

	test("a board card opens through an anchor to the card's path", () => {
		const html = renderToStaticMarkup(
			<LaneCol
				stage="todo"
				tasks={[cardFixture({ id: "X" })]}
				projectTasks={[]}
				hasRules={true}
				github={null}
				deltas={new Map()}
				open={() => {}}
				unread={() => false}
				onReorder={async () => true}
				filtering={false}
				draining={false}
			/>,
		);
		// The card shell renders as a real link: the browser can open it in a new tab.
		expect(html).toContain(
			'<a class="card-open" href="/projects/proj/tasks/X"',
		);
		// The card's title renders inside the anchor, so it is the accessible name.
		expect(html).toContain("Task one");
	});

	test("a covered update row's in-progress chip links the card's path", () => {
		const html = renderToStaticMarkup(
			<UpdateRowLine
				row={removedRow}
				act={async () => true}
				card={cardFixture({ id: "t9", updateIds: [removedRow.id] })}
				selected={false}
				onToggle={() => {}}
				openTask={() => {}}
			/>,
		);
		expect(html).toContain('href="/projects/proj/tasks/t9"');
		expect(html).toContain(">in progress</a>");
	});

	test("a drawer lineage parent and follow-up link the cards' paths", () => {
		const parent = cardFixture({
			...drawerFields,
			id: "P-1",
			stage: "done",
			state: "idle",
			sessionTitle: "Parent work",
		});
		const child = cardFixture({
			...drawerFields,
			id: "C-1",
			stage: "done",
			state: "idle",
			followUpOf: "P-1",
		});
		const kid = cardFixture({
			...drawerFields,
			id: "K-1",
			stage: "todo",
			state: "queued",
			followUpOf: "C-1",
		});
		const html = renderToStaticMarkup(
			<Drawer {...drawerBase} task={child} tasks={[parent, kid]} />,
		);
		expect(html).toContain('href="/projects/proj/tasks/P-1"');
		expect(html).toContain('href="/projects/proj/tasks/K-1"');
		// Both rows name their card with its title text, not just a URL.
		expect(html).toContain("Parent work");
	});
});

describe("LogView log slice controls", () => {
	const project = { name: "proj", settings: {} } as unknown as ProjectView;
	test("an expanded turn offers its section and the full log, slice active", () => {
		const html = renderToStaticMarkup(
			<LogView project={project} taskId="t1" startedAt={1_000} />,
		);
		expect(html).toContain("Turn log");
		expect(html).toContain("Full log");
		// Default is the turn's own section; the full log is the opt-in.
		expect(html).toContain('aria-pressed="true"');
		expect(html).toContain("(no log output yet)");
	});
});

test("OTTR-827: the rail dot counts exactly the cards whose face shows New", () => {
	const since = 1000;
	const mkProject = (name: string): ProjectView =>
		({
			name,
			hasRules: true,
			github: null,
			sessionsDir: `/tmp/${name}`,
			settings: { maxParallel: 1 },
			latestImage: null,
			archReview: null,
			dirty: false,
			mainBranch: null,
			latestRelease: null,
			latestReleaseUrl: null,
			openPrs: null,
			target: null,
		}) as unknown as ProjectView;
	// Solari: one merged work card done after the baseline — its face shows nothing.
	const merged = cardFixture({
		id: "m1",
		project: "solari",
		stage: "done",
		state: "idle",
		doneAt: since + 1,
		kind: "work",
	});
	// Velvarr: one answered card, never opened — its face shows New.
	const answered = cardFixture({
		id: "q1",
		project: "velvarr",
		stage: "done",
		state: "idle",
		doneAt: since + 1,
		answered: true,
		kind: "work",
	});
	const rail = renderToStaticMarkup(
		<RailRows
			projects={[mkProject("solari"), mkProject("velvarr")]}
			tasks={[merged, answered]}
			seenAnswers={new Set()}
			seenDoneSince={since}
			project={null}
			overviewCurrent={false}
			systemCurrent={false}
			hosted={false}
			version={null}
			collapsed={false}
			navigate={() => {}}
			onAdd={() => {}}
		/>,
	);
	// The merged-only project lights no dot; the answered card lights exactly one.
	expect(rail.match(/area-ind unread/g)).toEqual(["area-ind unread"]);
	expect(rail).toContain('title="1 unread"');
	expect(rail).not.toContain("0 unread");
	// The same empty seen set drives the card face badge on the board.
	const board = renderToStaticMarkup(
		<ProjectBoard
			project={mkProject("velvarr")}
			tasks={[answered]}
			deltas={new Map()}
			open={() => {}}
			seenAnswers={new Set()}
			seenDoneSince={since}
			compose={() => {}}
			composeDraft={() => {}}
			act={async () => true}
			onNotice={() => {}}
			draining={false}
		/>,
	);
	expect(board).toContain('class="unread"');
});

describe("ProjectBoard search delay", () => {
	// React interaction needs browser globals; bun test has none. The same happy-dom
	// swap as settings.test.tsx: installed after app.tsx's import (its browser mount
	// guard reads document at module load), removed after this file's tests.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
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

	/** A React onChange picks up programmatic edits only through the native value setter (see settings.test.tsx). */
	const typeInto = (el: HTMLInputElement, value: string): void => {
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		if (setter === undefined) throw new Error("value setter missing");
		setter.call(el, value);
	};

	/** The production onChange React rendered onto the node; happy-dom's dispatched
	 *  input event never reaches React's ChangeEventPlugin (see settings.test.tsx). */
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

	/** The board with three queued cards: "docs" matches exactly one. */
	async function mountBoard(): Promise<{
		container: HTMLDivElement;
		input: HTMLInputElement;
		unmount: () => Promise<void>;
	}> {
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const tasks = [
			cardFixture({ id: "t1", title: "Fix bug", sessionTitle: "Fix bug" }),
			cardFixture({
				id: "t2",
				title: "Write docs",
				sessionTitle: "Write docs",
			}),
			cardFixture({ id: "t3", title: "Add icon", sessionTitle: "Add icon" }),
		];
		const project = {
			name: "proj",
			hasRules: true,
			github: null,
			gitless: false,
			dirty: false,
			archReview: null,
			latestRelease: null,
			latestImage: null,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
		} as unknown as ProjectView;
		await act(async () => {
			root.render(
				<ProjectBoard
					project={project}
					tasks={tasks}
					deltas={new Map()}
					open={() => {}}
					seenAnswers={new Set()}
					seenDoneSince={0}
					compose={() => {}}
					composeDraft={() => {}}
					act={async () => true}
					onNotice={() => {}}
					draining={false}
				/>,
			);
		});
		const input = container.querySelector(
			'input[aria-label="Search tasks"]',
		) as HTMLInputElement | null;
		if (input === null) throw new Error("search input missing");
		return {
			container,
			input,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
			},
		};
	}

	test("the task search re-filters only after the typing settles", async () => {
		const { container, input, unmount } = await mountBoard();
		try {
			const count = (): string | null =>
				container.querySelector(".search-count")?.textContent ?? null;
			const cards = (): string[] =>
				[...container.querySelectorAll("[data-task-id]")].map(
					(el) => (el as HTMLElement).dataset.taskId ?? "",
				);
			expect(count()).toBe("3");
			expect(input.value).toBe("");
			expect(cards().sort()).toEqual(["t1", "t2", "t3"]);
			// Each phase is its own act: React defers an update from the apply timer to
			// the act scope's exit, so the flush lands between phases, before the assert.
			await act(async () => {
				typeInto(input, "docs");
				onChangeOf(input)({ target: { value: "docs" } });
			});
			// Inside the wait window the deadline has not passed: nothing filters.
			await act(async () => {
				await Bun.sleep(SEARCH_APPLY_MS - 100);
			});
			expect(count()).toBe("3");
			expect(cards().sort()).toEqual(["t1", "t2", "t3"]);
			// Past the deadline, one card matches and the count box says so.
			await act(async () => {
				await Bun.sleep(SEARCH_APPLY_MS + 60);
			});
			expect(count()).toBe("1/3");
			expect(cards()).toEqual(["t2"]);
			// Clearing waits the same way, then brings every card back.
			await act(async () => {
				typeInto(input, "");
				onChangeOf(input)({ target: { value: "" } });
			});
			await act(async () => {
				await Bun.sleep(SEARCH_APPLY_MS - 100);
			});
			expect(count()).toBe("1/3");
			await act(async () => {
				await Bun.sleep(SEARCH_APPLY_MS + 60);
			});
			expect(count()).toBe("3");
			expect(cards().sort()).toEqual(["t1", "t2", "t3"]);
			expect(
				container
					.querySelector(".search-group")
					?.classList.contains("filtered"),
			).toBe(false);
		} finally {
			await unmount();
		}
	});
});

describe("ProjectBoard done lane time view", () => {
	// React rendering needs browser globals; the same happy-dom swap as the search
	// delay tests above.
	const window = new Window({ url: "http://localhost/projects/proj" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
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

	test("the done lane stays on the time view: no toggle, one paged flat list", async () => {
		// 25 landed cards, none answered or starred: no pinned card may bend the cut.
		const doneCards = Array.from({ length: 25 }, (_, j) =>
			cardFixture({
				id: `d${j}`,
				stage: "done",
				state: "idle",
				doneAt: j + 1,
			}),
		);
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const project = {
			name: "proj",
			hasRules: true,
			github: null,
			gitless: false,
			dirty: false,
			archReview: null,
			latestRelease: null,
			latestImage: null,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
		} as unknown as ProjectView;
		try {
			await act(async () => {
				root.render(
					<ProjectBoard
						project={project}
						tasks={doneCards}
						deltas={new Map()}
						open={() => {}}
						seenAnswers={new Set()}
						seenDoneSince={0}
						compose={() => {}}
						composeDraft={() => {}}
						act={async () => true}
						onNotice={() => {}}
						draining={false}
					/>,
				);
			});
			// The switch is gone for good: no view-toggle element anywhere, and the
			// words "By topic" / "By time" appear nowhere on the board.
			expect(container.querySelector(".view-toggle")).toBeNull();
			expect(container.textContent).not.toContain("By topic");
			expect(container.textContent).not.toContain("By time");
			expect(container.innerHTML).not.toContain("By topic");
			expect(container.innerHTML).not.toContain("By time");
			// The done stage head renders no tools at all: not even one button.
			const head = container.querySelector("#stage-done");
			expect(head?.querySelectorAll("button")).toHaveLength(0);
			// The flat list pages by time: donePage's cut decides the first page.
			// The lane sorts newest landed first, then donePage cuts at the page size
			// (app.tsx's unexported DONE_PAGE is 20), so no number here is guessed.
			const { shown, hidden } = donePage(
				[...doneCards].sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
				() => false,
				20,
			);
			expect(hidden).toBeGreaterThan(0);
			const lane = container.querySelector('[data-stage="done"]');
			expect(lane).not.toBeNull();
			const visibleIds = [...lane!.querySelectorAll("[data-task-id]")].map(
				(el) => el.getAttribute("data-task-id"),
			);
			expect(visibleIds).toEqual(shown.map((t) => t.id));
			// One lane-wide "Show more" carries the hidden count in its label.
			const more = lane!.querySelector("button.lane-more");
			expect(more?.textContent).toContain("Show more");
			expect(more?.getAttribute("aria-label")).toBe(
				`Show more, ${hidden} older cards`,
			);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});

	test("the Starred section stays collapsible in the time view", async () => {
		const doneCards = [
			cardFixture({ id: "d0", stage: "done", state: "idle", doneAt: 1 }),
			cardFixture({
				id: "s1",
				stage: "done",
				state: "idle",
				starred: true,
				doneAt: 2,
			}),
			cardFixture({ id: "d2", stage: "done", state: "idle", doneAt: 3 }),
		];
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const project = {
			name: "proj",
			hasRules: true,
			github: null,
			gitless: false,
			dirty: false,
			archReview: null,
			latestRelease: null,
			latestImage: null,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
		} as unknown as ProjectView;
		try {
			await act(async () => {
				root.render(
					<ProjectBoard
						project={project}
						tasks={doneCards}
						deltas={new Map()}
						open={() => {}}
						seenAnswers={new Set()}
						seenDoneSince={0}
						compose={() => {}}
						composeDraft={() => {}}
						act={async () => true}
						onNotice={() => {}}
						draining={false}
					/>,
				);
			});
			const section = container.querySelector(
				'[data-stage="done"] section.starred',
			);
			expect(section).not.toBeNull();
			const head = section!.querySelector("button.starred-head");
			expect(head?.getAttribute("aria-expanded")).toBe("true");
			// The head names its count, and aria-controls points at the body it folds.
			expect(head!.querySelector(".topic-count")?.textContent).toBe("1");
			expect(head?.getAttribute("aria-controls")).toBe(
				section!.querySelector(".starred-body")?.id,
			);
			// The pinned card renders once, inside the section.
			expect(container.querySelectorAll('[data-task-id="s1"]')).toHaveLength(1);
			expect(section!.querySelector('[data-task-id="s1"]')).not.toBeNull();
			// A click flips the state through the board's own toggle handler.
			await act(async () => {
				// happy-dom's MouseEvent class does not match lib.dom's, like submitEvent above.
				head!.dispatchEvent(
					new window.MouseEvent("click", {
						bubbles: true,
						cancelable: true,
					}) as unknown as Event,
				);
			});
			const shut = container.querySelector(
				'[data-stage="done"] section.starred',
			);
			expect(shut?.getAttribute("data-collapsed")).toBe("true");
			expect(
				shut!
					.querySelector("button.starred-head")
					?.getAttribute("aria-expanded"),
			).toBe("false");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});
});

describe("ProjectBoard settings shortcut", () => {
	// React interaction needs browser globals; the same happy-dom swap as the search
	// delay tests above, plus the history/location pair settingsNavigate() drives.
	const window = new Window({ url: "http://localhost/projects/proj" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		history: window.history,
		location: window.location,
		PopStateEvent: window.PopStateEvent,
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

	/** The production onClick React rendered onto the node; a dispatched click never
	 *  reaches React's event plugin under happy-dom (see the search delay tests). */
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

	/** The board with one card; the header's actions row is what the shortcut lives in. */
	async function mountBoard(): Promise<{
		container: HTMLDivElement;
		unmount: () => Promise<void>;
	}> {
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const tasks = [cardFixture({ id: "t1", title: "Fix bug" })];
		const project = {
			name: "proj",
			hasRules: true,
			github: null,
			gitless: false,
			dirty: false,
			archReview: null,
			latestRelease: null,
			latestImage: null,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
		} as unknown as ProjectView;
		await act(async () => {
			root.render(
				<ProjectBoard
					project={project}
					tasks={tasks}
					deltas={new Map()}
					open={() => {}}
					seenAnswers={new Set()}
					seenDoneSince={0}
					compose={() => {}}
					composeDraft={() => {}}
					act={async () => true}
					onNotice={() => {}}
					draining={false}
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
			},
		};
	}

	test("the project menu links to the project's settings page", async () => {
		const { container, unmount } = await mountBoard();
		try {
			const link = container.querySelector(".project-menu a");
			expect(link?.getAttribute("href")).toBe("/settings/proj");
			expect(link?.getAttribute("aria-label")).toBe("Project settings");
		} finally {
			await unmount();
		}
	});

	test("a plain click walks the project's settings view", async () => {
		const { container, unmount } = await mountBoard();
		try {
			const link = container.querySelector(".project-menu a");
			if (link === null) throw new Error("settings shortcut missing");
			let popped = 0;
			window.addEventListener("popstate", () => {
				popped += 1;
			});
			let prevented = false;
			await act(async () => {
				onClickOf(link)({
					button: 0,
					metaKey: false,
					ctrlKey: false,
					shiftKey: false,
					altKey: false,
					preventDefault: () => {
						prevented = true;
					},
					currentTarget: { pathname: "/settings/proj" },
				});
			});
			// The default navigation is suppressed and the settings view's URL is the
			// pushed history entry, announced with the popstate the App listens on.
			expect(prevented).toBe(true);
			expect(popped).toBe(1);
			expect(window.location.pathname).toBe("/settings/proj");
		} finally {
			await unmount();
		}
	});
});

describe("skillGapNote", () => {
	// The full layer: every REQUIRED_SKILLS entry a worker home can hold, the rules
	// entry by its file-name prefix.
	const complete = {
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
		rules: ["codeguard-1-hardcoded-credentials.md"],
		mcp: [],
	};
	test("a null layer and a complete layer name no gap", () => {
		expect(skillGapNote(null, "review")).toBe(null);
		expect(skillGapNote(null, "diagrams")).toBe(null);
		expect(skillGapNote(complete, "review")).toBe(null);
		expect(skillGapNote(complete, "diagrams")).toBe(null);
		expect(skillGapNote(complete, "board-check")).toBe(null);
	});
	test("an incomplete layer names the missing entries of one use, in shipped order", () => {
		expect(skillGapNote({ ...complete, skills: [], rules: [] }, "review")).toBe(
			"Missing on workers: security-audit, codeguard, codebase-design, ponytail-audit, ui-ux-check",
		);
		expect(skillGapNote(complete, "board-check")).toBe(null);
		// The bar's check control reads its own group: the shipped skill, not the rules entry.
		expect(skillGapNote({ ...complete, skills: [] }, "board-check")).toBe(
			"Missing on workers: check-ottr-board",
		);
	});
});

describe("ProjectBoard skill-gap markers", () => {
	// React interaction needs browser globals; the same happy-dom swap as the
	// settings shortcut tests above, plus the dialog pair the Diagrams modal shows.
	const window = new Window({ url: "http://localhost/projects/proj" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLDialogElement: window.HTMLDialogElement,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		history: window.history,
		location: window.location,
		PopStateEvent: window.PopStateEvent,
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

	/** The production onClick React rendered onto the node (see the settings shortcut tests). */
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

	/** An arch review with unreviewed commits: the menu's Start review button shows. */
	const archReview = {
		delta: 2,
		reviewed: true,
		base: "abc123",
		reviewCardId: null,
		cap: 3,
		due: false,
		running: false,
	};
	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		gitless: false,
		dirty: false,
		archReview,
		latestRelease: null,
		latestImage: null,
		target: "origin/main",
		settings: { setupChecklist: false },
		sessionsDir: "/tmp/s",
	} as unknown as ProjectView;

	/** The review group the fake layer lacks: every review entry except the shipped ui-ux-check. */
	const REVIEW_NOTE =
		"Missing on workers: security-audit, codeguard, codebase-design, ponytail-audit";

	type UserLayer = Parameters<typeof ProjectBoard>[0]["userLayer"];

	async function mountBoard(
		userLayer: UserLayer,
		due = false,
	): Promise<{
		container: HTMLDivElement;
		unmount: () => Promise<void>;
	}> {
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const boardProject = { ...project, archReview: { ...archReview, due } };
		await act(async () => {
			root.render(
				<ProjectBoard
					project={boardProject}
					tasks={[]}
					deltas={new Map()}
					open={() => {}}
					seenAnswers={new Set()}
					seenDoneSince={0}
					compose={() => {}}
					composeDraft={() => {}}
					act={async () => true}
					onNotice={() => {}}
					draining={false}
					userLayer={userLayer}
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
			},
		};
	}

	const buttonWithText = (
		container: HTMLDivElement,
		text: string,
	): HTMLButtonElement => {
		const b = [...container.querySelectorAll("button")].find((x) =>
			(x.textContent ?? "").includes(text),
		);
		if (b === undefined) throw new Error(`no "${text}" button`);
		return b;
	};

	test("an incomplete layer appends the note to the review and release titles and shows the marks", async () => {
		const { container, unmount } = await mountBoard({
			skills: ["ui-ux-check"],
			plugins: [],
			rules: [],
			mcp: [],
		});
		try {
			const review = buttonWithText(container, "Start review");
			const release = buttonWithText(container, "Create release");
			expect(review.getAttribute("title")).toContain(`. ${REVIEW_NOTE}`);
			expect(release.getAttribute("title")).toContain(`. ${REVIEW_NOTE}`);
			// The mark is a visible span on the button, with the note as its accessible name.
			for (const b of [review, release]) {
				const mark = b.querySelector('[role="img"]');
				expect(mark?.getAttribute("aria-label")).toBe(REVIEW_NOTE);
				expect(mark?.querySelector("svg")?.getAttribute("class")).toContain(
					"mark-warn",
				);
			}
		} finally {
			await unmount();
		}
	});

	test("an overdue review's Start review button carries the same note and mark", async () => {
		// due: true moves Start review out of the menu onto the head's arch-start button.
		const { container, unmount } = await mountBoard(
			{ skills: [], plugins: [], rules: [], mcp: [] },
			true,
		);
		try {
			const review =
				container.querySelector<HTMLButtonElement>("button.arch-start");
			if (review === null) throw new Error("no arch-start button");
			expect(review.textContent).toContain("Start review");
			expect(review.getAttribute("title")).toContain(
				". Missing on workers: security-audit, codeguard, codebase-design, ponytail-audit, ui-ux-check",
			);
			expect(
				review.querySelector('[role="img"]')?.getAttribute("aria-label"),
			).toBe(
				"Missing on workers: security-audit, codeguard, codebase-design, ponytail-audit, ui-ux-check",
			);
		} finally {
			await unmount();
		}
	});

	test("a complete layer keeps the plain titles and renders no marks", async () => {
		const { container, unmount } = await mountBoard({
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
			rules: ["codeguard-1-hardcoded-credentials.md"],
			mcp: [],
		});
		try {
			expect(
				buttonWithText(container, "Start review").getAttribute("title"),
			).toBe(
				"2 commits on origin/main since the last review — start one early, the same review a release runs",
			);
			expect(
				buttonWithText(container, "Create release").getAttribute("title"),
			).toBe("Release all new commits");
			expect(container.querySelector('[role="img"]')).toBeNull();
		} finally {
			await unmount();
		}
	});

	test("the Diagrams window names the gap on Create/update diagrams", async () => {
		// The modal fetches the file on mount; 404 keeps the create-hint body, which is enough.
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("no file", {
				status: 404,
			})) as unknown as typeof fetch;
		const { container, unmount } = await mountBoard({
			skills: [],
			plugins: [],
			rules: [],
			mcp: [],
		});
		try {
			const show = buttonWithText(container, "Show diagrams");
			await act(async () => {
				onClickOf(show)({});
			});
			const create = buttonWithText(container, "Create/update diagrams");
			const note = "Missing on workers: explain-project";
			expect(create.getAttribute("title")).toContain(`. ${note}`);
			expect(
				create.querySelector('[role="img"]')?.getAttribute("aria-label"),
			).toBe(note);
		} finally {
			globalThis.fetch = realFetch;
			await unmount();
		}
	});
});

/** Minimal ComposeDialog props: the copy the three callers pin, with a no-op send and act. */
const compose = (extra?: Partial<Parameters<typeof ComposeDialog>[0]>) => ({
	open: true,
	onClose: () => {},
	act: () => Promise.resolve(true),
	draftKey: "test:new",
	label: "New task for demo",
	heading: "New task",
	sub: null,
	inputLabel: "Task",
	placeholder: "Describe the task",
	hint: "hint",
	icon: "plus" as const,
	submitLabel: "Add task",
	send: () => Promise.resolve(),
	...extra,
});

describe("ComposeDialog deepen", () => {
	test("a deepen-enabled composer shows the Help badge, the Deepen button and its hint; both buttons start disabled on an empty draft", () => {
		const html = renderToStaticMarkup(
			<ComposeDialog
				{...compose({
					deepen: () =>
						Promise.resolve({ deepened: "x", check: null, checkError: null }),
				})}
			/>,
		);
		expect(html).toContain('aria-label="About Deepen"');
		expect(html).toContain("Deepen");
		expect(html).toContain("compose-keys");
		// Empty draft: Deepen and the submit button are both disabled in the markup.
		expect(html).toContain('class="ghost deepen-btn" disabled=""');
		expect(html).toContain('type="submit" class="primary" disabled=""');
		expect(html).not.toContain("Use rewrite");
	});
	test("without the deepen prop no badge and no Deepen button render, and the submit button is untouched", () => {
		const html = renderToStaticMarkup(<ComposeDialog {...compose()} />);
		expect(html).not.toContain('aria-label="About Deepen"');
		expect(html).not.toContain("deepen-btn");
		expect(html).toContain('type="submit"');
	});
});

describe("DeepenReview", () => {
	const review = (
		original: string,
		deepened: string,
		check: DeepenCheck | null = null,
		checkError: string | null = null,
	) =>
		renderToStaticMarkup(
			<DeepenReview
				original={original}
				deepened={deepened}
				check={check}
				checkError={checkError}
				onUse={() => {}}
				onDiscard={() => {}}
			/>,
		);
	/** A check over the five canonical points from per-point verdict lists. */
	const checkOf = (
		draft: ("covered" | "missing")[],
		rewrite: ("covered" | "missing")[],
		additions: string[] = [],
	): DeepenCheck => ({
		points: DEEPEN_POINTS.map((_point, i) => ({
			draft: draft[i]!,
			rewrite: rewrite[i]!,
			reason: `reason ${i + 1}`,
		})),
		additions,
	});
	test("a mixed rewrite renders add and del rows, each with its +/- glyph", () => {
		const html = review("keep\nold", "keep\nnew");
		expect(html).toContain("dl-add");
		expect(html).toContain("dl-del");
		expect(html).toContain("+");
		expect(html).toContain("\u2212");
		expect(html).toContain(">old</span>");
		expect(html).toContain(">new</span>");
		expect(html).toContain("Use rewrite");
		expect(html).toContain("Discard");
	});
	test("a rewrite that differs in no line says so instead of an empty diff box", () => {
		const html = review("same\ntext", "same\ntext");
		expect(html).not.toContain("dl-add");
		expect(html).toContain("matches the draft line for line");
		expect(html).toContain("Use rewrite");
	});
	test("exactly two improved points render two improved rows and the 2-of-5 summary", () => {
		// Points 1 and 2 improve (draft missing, rewrite covered); 3-5 are covered
		// by both, so they read "already present".
		const check = checkOf(
			["missing", "missing", "covered", "covered", "covered"],
			["covered", "covered", "covered", "covered", "covered"],
		);
		const html = review("draft", "rewrite", check, null);
		expect(html).toContain("Improves 2 of 5 deepen points.");
		expect(html.match(/>improved<\/span>/g)).toHaveLength(2);
		expect(html.match(/>already present<\/span>/g)).toHaveLength(3);
		expect(html).not.toContain("still missing");
		expect(html).toContain("reason 1");
		// Two improved points and no additions: Use rewrite stays the default action.
		expect(html).toContain('class="primary"');
	});
	test("an addition renders under its own heading and demotes Use rewrite", () => {
		const check = checkOf(
			["missing", "missing", "covered", "covered", "covered"],
			["covered", "covered", "covered", "covered", "covered"],
			["Deploy to staging"],
		);
		const html = review("draft", "rewrite", check, null);
		expect(html).toContain("Adds what the draft did not ask for");
		expect(html).toContain(">Deploy to staging</li>");
		expect(html).not.toContain('class="primary"');
		expect(html).toContain(">Use rewrite</button>");
	});
	test("a rewrite that improves no point demotes Use rewrite even with no additions", () => {
		const check = checkOf(
			["missing", "missing", "covered", "covered", "covered"],
			["missing", "missing", "covered", "missing", "covered"],
		);
		const html = review("draft", "rewrite", check, null);
		expect(html).toContain("The rewrite improves no deepen point.");
		expect(html.match(/>still missing<\/span>/g)).toHaveLength(3);
		expect(html).not.toContain('class="primary"');
	});
	test("a failed check replaces the panel with the unavailable line", () => {
		const html = review(
			"draft",
			"rewrite",
			null,
			"bad JSON: expected 5 points",
		);
		expect(html).toContain("Check unavailable: bad JSON: expected 5 points");
		expect(html).not.toContain("deepen-points");
		expect(html).not.toContain("Improves");
	});
});

describe("Drawer prompt gate Start anyway", () => {
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1 },
	} as unknown as ProjectView;
	const base = {
		project,
		// sendReply wraps its POST in this act: it must run the fn (the App act
		// executes it; a no-op would swallow the reply and the POST never fires).
		act: async (fn: () => Promise<unknown>) => {
			await fn();
			return true;
		},
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};
	// React interaction needs browser globals; the setup mirrors settings.test.tsx.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Node: window.Node,
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
	// happy-dom clicks never reach React's plugin: call the rendered onClick instead.
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
	const gateTask = (gate: Task["gate"]) =>
		cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: "Prompt gate: two open questions",
			asked: [
				{
					question: "Which environment deploys this?",
					options: [],
					multi: false,
					recommended: null,
				},
			],
			gate,
		});

	test("a gate park renders the reason and Start anyway; its click replies with the exact marker", async () => {
		const realFetch = globalThis.fetch;
		const posts: { url: string; body: unknown }[] = [];
		// The drawer's detail, session and catalog fetches degrade to null on a 404;
		// only the reply POST is captured.
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input);
			if (url.endsWith("/tasks/t1/reply")) {
				posts.push({ url, body: String(init?.body ?? "") });
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<Drawer
						{...base}
						task={gateTask({
							hash: null,
							seen: null,
							fails: 1,
							sig: "Which environment deploys this?",
							parked: true,
						})}
					/>,
				);
			});
			const reason = container.querySelectorAll(".gate-start .needs-reason");
			expect(reason).toHaveLength(1);
			expect(reason[0]!.textContent).toContain(
				"Prompt gate: two open questions",
			);
			const btn = container.querySelector<HTMLButtonElement>(
				".gate-start .gate-start-btn",
			);
			if (btn === null) throw new Error("no Start anyway button");
			await act(async () => {
				onClickOf(btn)({});
			});
			await act(async () => {});
			const post = posts.at(-1);
			expect(post?.url).toContain("/api/projects/proj/tasks/t1/reply");
			// The exact serialized form: the marker text verbatim, no images.
			expect(post?.body).toBe(
				JSON.stringify({ text: "Start anyway", images: [] }),
			);
		} finally {
			globalThis.fetch = realFetch;
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});

	test("a needs_you card without a parked gate renders no Start anyway", () => {
		const html = renderToStaticMarkup(
			<Drawer {...base} task={gateTask(null)} />,
		);
		expect(html).not.toContain("Start anyway");
		expect(html).not.toContain("gate-start");
	});

	test("a parked gate with facts renders the answered facts with evidence", async () => {
		const realFetch = globalThis.fetch;
		// The drawer's detail, session and catalog fetches degrade to null on a 404.
		globalThis.fetch = (async () =>
			new Response("{}", { status: 404 })) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<Drawer
						{...base}
						task={gateTask({
							hash: null,
							seen: null,
							fails: 1,
							sig: "q",
							parked: true,
							facts: [
								{
									question: "Where does the release currently run?",
									answer: "gh release create",
									evidence: "src/release.ts:827",
								},
							],
						})}
					/>,
				);
			});
			const facts = container.querySelectorAll(".gate-facts");
			expect(facts).toHaveLength(1);
			expect(facts[0]!.textContent).toContain("Answered from the code");
			expect(facts[0]!.textContent).toContain(
				"Where does the release currently run?",
			);
			expect(facts[0]!.textContent).toContain("gh release create");
			expect(facts[0]!.textContent).toContain("src/release.ts:827");
		} finally {
			globalThis.fetch = realFetch;
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});

	test("a parked gate without facts renders no gate-facts and keeps Start anyway", () => {
		const html = renderToStaticMarkup(
			<Drawer
				{...base}
				task={gateTask({
					hash: null,
					seen: null,
					fails: 1,
					sig: "q",
					parked: true,
				})}
			/>,
		);
		expect(html).not.toContain("gate-facts");
		expect(html).toContain("Start anyway");
	});
});

describe("OrphanNotice", () => {
	const row = {
		pid: 4242,
		started: 90_000,
		cmd: "bun run retro --card O-9",
		project: "ottr",
		card: "O-9",
		kind: "retro",
	};

	test("the definition line renders once above the rows", () => {
		const html = renderToStaticMarkup(
			<OrphanNotice
				orphans={[row]}
				fresh={false}
				nowMs={210_000}
				openTask={() => {}}
			/>,
		);
		expect(html).toContain(
			"An orphan is an agent run that no card owns any more.",
		);
		expect(html).toContain("Ottr never kills a process on its own.");
	});

	test("a row with project and card renders a card button for the card id", () => {
		const opened: string[] = [];
		const html = renderToStaticMarkup(
			<OrphanNotice
				orphans={[row]}
				fresh={false}
				nowMs={210_000}
				openTask={(id) => {
					opened.push(id);
				}}
			/>,
		);
		expect(html).toContain("pid 4242");
		expect(html).toContain("started 2m ago");
		expect(html).toContain("retro");
		expect(html).toContain("ottr");
		// The command summary is a code element whose title repeats it for hover.
		expect(html).toContain('<code title="bun run retro --card O-9">');
		const html2 = renderToStaticMarkup(
			<OrphanNotice
				orphans={[row]}
				fresh={false}
				nowMs={210_000}
				openTask={(id) => {
					opened.push(id);
				}}
			/>,
		);
		expect(html2).toContain(">O-9</button>");
		// Static markup cannot fire events; the click wiring is tested in the actions describe.
	});

	test("a row without a card renders no card button", () => {
		const html = renderToStaticMarkup(
			<OrphanNotice
				orphans={[{ ...row, card: null, project: null }]}
				fresh={false}
				nowMs={210_000}
				openTask={() => {}}
			/>,
		);
		expect(html).not.toContain(">O-9</button>");
	});

	test("the list caps at five rows and marks the overflow", () => {
		const rows = Array.from({ length: 7 }, (_, i) => ({
			...row,
			pid: 100 + i,
			started: 0,
		}));
		const html = renderToStaticMarkup(
			<OrphanNotice
				orphans={rows}
				fresh={false}
				nowMs={210_000}
				openTask={() => {}}
			/>,
		);
		expect(html.match(/Stop process/g)?.length).toBe(5);
		expect(html).toContain("2 more orphaned processes");
	});
});

describe("OrphanNotice actions", () => {
	// React interaction needs browser globals; bun test has none. happy-dom registers
	// them here; afterAll puts the originals back (same pattern as settings.test.tsx).
	const win = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window: win,
		document: win.document,
		navigator: win.navigator,
		Event: win.Event,
		HTMLElement: win.HTMLElement,
		Node: win.Node,
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

	const onClickOf = (node: Element): (() => void) => {
		const key = Object.getOwnPropertyNames(node).find((k) =>
			k.startsWith("__reactProps$"),
		);
		if (key === undefined) throw new Error("react props missing on node");
		const props = (node as unknown as Record<string, unknown>)[key] as {
			onClick?: () => void;
		};
		if (props.onClick === undefined) throw new Error("node has no onClick");
		return props.onClick;
	};

	const buttonOf = (container: HTMLDivElement, label: string): Element => {
		const el = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent === label,
		);
		if (el === undefined) throw new Error(`no ${label} button`);
		return el;
	};

	const row = {
		pid: 4242,
		started: 90_000,
		cmd: "bun run retro --card O-9",
		project: "ottr",
		card: "O-9",
		kind: "retro",
	};

	async function mount(open: (id: string) => void = () => {}): Promise<{
		container: HTMLDivElement;
		unmount: () => void;
	}> {
		// happy-dom's DOM classes do not structurally match lib.dom's; convert once here.
		const container = win.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		win.document.body.append(container as never);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<OrphanNotice
					orphans={[row]}
					fresh={false}
					nowMs={210_000}
					openTask={open}
				/>,
			);
		});
		return { container, unmount: () => root.unmount() };
	}

	// happy-dom's Window type omits the dialog methods; speak them through this cast.
	const w = win as unknown as { confirm: (m: string) => boolean };

	test("stop without confirm does not post", async () => {
		const posts: string[] = [];
		const realConfirm = w.confirm;
		const realFetch = globalThis.fetch;
		w.confirm = () => false;
		globalThis.fetch = ((input: unknown) => {
			posts.push(String(input));
			throw new Error("must not fetch");
		}) as unknown as typeof fetch;
		const { container, unmount } = await mount();
		try {
			await act(async () => {
				onClickOf(buttonOf(container, "Stop process"))();
			});
			expect(posts).toEqual([]);
		} finally {
			w.confirm = realConfirm;
			globalThis.fetch = realFetch;
			await act(async () => {
				unmount();
			});
			container.remove();
		}
	});

	test("stop with confirm posts the orphan identity to /api/orphans/stop", async () => {
		let body: unknown = null;
		let url = "";
		const realConfirm = w.confirm;
		const realFetch = globalThis.fetch;
		w.confirm = () => true;
		globalThis.fetch = ((
			input: unknown,
			init?: { method?: string; body?: string },
		) => {
			url = String(input);
			body = JSON.parse(init?.body ?? "null");
			return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
		}) as unknown as typeof fetch;
		const { container, unmount } = await mount();
		try {
			await act(async () => {
				onClickOf(buttonOf(container, "Stop process"))();
			});
			expect(url).toBe("/api/orphans/stop");
			expect(body).toEqual({
				pid: 4242,
				started: 90_000,
				cmd: "bun run retro --card O-9",
			});
		} finally {
			w.confirm = realConfirm;
			globalThis.fetch = realFetch;
			await act(async () => {
				unmount();
			});
			container.remove();
		}
	});

	test("copy writes kill <pid> to the clipboard", async () => {
		const written: string[] = [];
		const realNavigator = host.navigator;
		host.navigator = {
			clipboard: {
				writeText: (text: string) => {
					written.push(text);
					return Promise.resolve();
				},
			},
		};
		const { container, unmount } = await mount();
		try {
			await act(async () => {
				onClickOf(buttonOf(container, "Copy kill command"))();
			});
			expect(written).toEqual(["kill 4242"]);
		} finally {
			host.navigator = realNavigator;
			await act(async () => {
				unmount();
			});
			container.remove();
		}
	});

	test("the card button opens the card through openTask", async () => {
		const opened: string[] = [];
		const { container, unmount } = await mount((id) => {
			opened.push(id);
		});
		try {
			await act(async () => {
				onClickOf(buttonOf(container, "O-9"))();
			});
			expect(opened).toEqual(["O-9"]);
		} finally {
			await act(async () => {
				unmount();
			});
			container.remove();
		}
	});
});

describe("Drawer proposal decision panel", () => {
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};
	const reason =
		"Retro proposal from t3. Accept starts it. Edit task changes the prompt first. Cancel task declines it.";
	const summary: ProposalSummary = {
		whatChanges: "Rework the proposal reason wording",
		why: "Duplicated text on OTTR-404, and ZZZ-9 never existed",
		gain: "One line less on every proposal card",
		risk: "none found",
		check: "bun test passes",
	};

	test("a summary proposal renders the five labeled lines and links the known Why card id", () => {
		const source = cardFixture({
			id: "OTTR-404",
			title: "Add the summary fields",
			sessionTitle: "Add the summary fields",
			stage: "done",
			state: "idle",
		});
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
			prompt: "Rework the wording\n\nsecond paragraph",
			proposalSummary: summary,
		});
		const html = renderToStaticMarkup(
			<Drawer {...base} task={task} tasks={[source]} />,
		);
		expect(html).toContain('id="drawer-decide"');
		// Always open, no section head: nothing can fold the decision away.
		expect(html).not.toContain('aria-controls="drawer-decide"');
		expect(html).toContain("<dt>What changes</dt>");
		expect(html).toContain("<dt>Why</dt>");
		expect(html).toContain("<dt>Gain</dt>");
		expect(html).toContain("<dt>Risk</dt>");
		expect(html).toContain("<dt>Check</dt>");
		expect(html).toContain("Rework the proposal reason wording");
		expect(html).toContain("One line less on every proposal card");
		// The known id renders as a link to its card; the unknown one stays text.
		expect(html).toContain('href="/projects/proj/tasks/OTTR-404"');
		expect(html).not.toContain("tasks/ZZZ-9");
		expect(html).toContain("ZZZ-9 never existed");
	});

	test("a proposal without a summary shows the prompt's first paragraph, no five labels", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
			prompt: "First paragraph only\n\nSecond paragraph",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-decide"');
		expect(html).toContain("First paragraph only");
		expect(html).toContain('class="decide-fallback"');
		expect(html).not.toContain("<dt>What changes</dt>");
		expect(html).not.toContain("<dt>Why</dt>");
		expect(html).not.toContain("<dt>Gain</dt>");
		expect(html).not.toContain("<dt>Risk</dt>");
		expect(html).not.toContain("<dt>Check</dt>");
		// The full prompt stays available under the collapsed section.
		expect(html).toContain("Second paragraph");
	});

	test("the panel carries Accept and Edit beside it, and the collapsed full prompt", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
			prompt: "Rework the wording",
			proposalSummary: summary,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		// Accept is the primary action; Edit renders beside it; the decline moved to the
		// drawer-actions row's Cancel task.
		expect(html).toContain('class="primary"');
		expect(html).toContain('title="Start the proposed task"');
		expect(html).toContain('title="Edit the task text"');
		expect(html).not.toContain("Decline this proposal");
		// The full prompt sits collapsed under a visible summary.
		expect(html).toMatch(
			/<summary><svg class="chev"[\s\S]*?<\/svg>Full prompt<\/summary>/,
		);
		// One decision card: the body (reason, summary, full prompt) first, then the footer
		// with Accept and Edit, so the buttons close the decision instead of splitting it.
		const card = html.slice(html.indexOf('class="decide-card"'));
		expect(card.indexOf('class="decide-body"')).toBeGreaterThan(-1);
		expect(card.indexOf('class="decide-actions"')).toBeGreaterThan(
			card.indexOf("Full prompt</summary>"),
		);
		// The panel replaces the standalone prompt section and the needs-reason box.
		expect(html).not.toContain('id="drawer-prompt"');
		expect(html).not.toContain('class="needs-reason"');
		// Real buttons, Tab reachable, visible text as the accessible name.
		expect(html).toContain(">Accept</button>");
		expect(html).toContain(">Edit</button>");
		expect(html).toContain(">Cancel task</button>");
		// All three decisions share the card's footer: Cancel task renders once, inside it,
		// and the drawer's action row no longer carries it.
		expect(html.split(">Cancel task</button>").length - 1).toBe(1);
		const foot = html.slice(html.indexOf('class="decide-actions"'));
		expect(foot.indexOf(">Cancel task</button>")).toBeLessThan(
			foot.indexOf(">Accept</button>"),
		);
		expect(html).not.toContain("Go to reply");
		// The two panel buttons carry no tabindex: keyboard order follows document order.
		// The drawer dialog itself sets tabindex="-1" as its focus target, so scope to the
		// buttons' own tags.
		for (const title of ["Start the proposed task", "Edit the task text"]) {
			const tag = new RegExp(`<button[^>]*title="${title}"[^>]*>`).exec(
				html,
			)?.[0];
			expect(tag).toBeDefined();
			expect(tag).not.toContain("tabindex");
		}
	});

	test("a plain needs_you card keeps the needs-reason box and the prompt section, no panel", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: "hit a blocker",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain('id="drawer-decide"');
		expect(html).not.toContain(">Decide</button>");
		expect(html).toContain('class="needs-reason"');
		expect(html).toContain('id="drawer-prompt"');
		// A blocker keeps the head's amber "action required" with its triangle.
		expect(html).toContain('class="st st-needs_you"');
		expect(html).toContain("action required");
	});

	test("a proposal drawer reads as not started: grey head word, the lineage arrow, no alarm", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('<span class="st">not started</span>');
		expect(html).not.toContain("st-needs_you");
		expect(html).not.toContain("action required");
		expect(html).not.toContain("mark-needs");
		expect(html).not.toContain('class="needs-reason"');
		expect(html).toMatch(/<div class="decide-reason"><svg class="icon-svg"/);
	});

	test("a proposal card in needs_you renders exactly one Accept button", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
			prompt: "Rework the wording",
			proposalSummary: summary,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		// The Decide panel owns the one Accept; the composer's twin is gone.
		const accepts = html.match(/title="Start the proposed task"/g) ?? [];
		expect(accepts).toHaveLength(1);
		expect(html.match(/>Accept<\/button>/g) ?? []).toHaveLength(1);
		// The composer itself stays: Reply keeps rendering under it.
		expect(html).toContain('id="drawer-reply"');
	});

	test("the reply band starts folded: a reply field and a Reply head, the form not open", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: "hit a blocker",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		const form = html.slice(html.indexOf('id="drawer-reply"'));
		// Phones show only the field until a tap; the CSS keys off data-open.
		expect(form).toMatch(/^id="drawer-reply" class="reply-form reply-fold">/);
		expect(form).toContain('aria-label="Write a reply"');
		expect(form).toContain("Reply to the agent…");
		expect(form).toContain('class="reply-head" aria-expanded="false"');
	});

	test("a cancelled proposal hides the panel and keeps the composer's Accept", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
			prompt: "Rework the wording",
			cancelledAt: 1760000000000,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).not.toContain('id="drawer-decide"');
		expect(html).toContain('id="drawer-reply"');
		const accepts = html.match(/title="Start the proposed task"/g) ?? [];
		expect(accepts).toHaveLength(1);
		expect(html.match(/>Accept<\/button>/g) ?? []).toHaveLength(1);
	});

	test("a non-proposal interrupted card still renders Resume", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: "hit a blocker",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-reply"');
		expect(html).toContain(">Resume</button>");
		expect(html).not.toContain(">Accept</button>");
		expect(html).not.toContain('id="drawer-decide"');
	});

	test("a proposal card reads as a draft with a Decide chip; an ordinary needs_you card keeps the alarm", () => {
		const laneBase = {
			projectTasks: [] as TaskCard[],
			hasRules: true,
			github: null,
			deltas: new Map<string, number>(),
			open: () => {},
			unread: () => false,
			onReorder: async () => true,
			filtering: false,
			draining: false,
		} as const;
		const proposal = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
		});
		const plain = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: "hit a blocker",
		});
		const withProposal = renderToStaticMarkup(
			<LaneCol {...laneBase} stage="todo" tasks={[proposal]} />,
		);
		expect(withProposal).toContain('class="decide-link"');
		expect(withProposal).toContain(">Decide</button>");
		expect(withProposal).toContain(
			'title="Accept, edit or cancel this proposal"',
		);
		// A suggestion, not a fault: the draft face, no amber error line, no needs triangle.
		expect(withProposal).toContain("data-proposal");
		expect(withProposal).toContain(
			'<span class="proposal-chip">Proposal</span>',
		);
		expect(withProposal).toContain("· not started");
		expect(withProposal).toContain('class="mark mark-queued"');
		expect(withProposal).not.toContain("card-error");
		expect(withProposal).not.toContain("mark-needs");
		expect(withProposal).not.toContain("action required");
		const withPlain = renderToStaticMarkup(
			<LaneCol {...laneBase} stage="todo" tasks={[plain]} />,
		);
		expect(withPlain).not.toContain("decide-link");
		expect(withPlain).not.toContain("data-proposal");
		expect(withPlain).toContain('class="card-error"');
		expect(withPlain).toContain("mark-needs");
	});
});

describe("Drawer proposal panel editing (client)", () => {
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
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
	// happy-dom's dispatched clicks never reach React's event plugin: call the
	// production onClick React rendered onto the node instead.
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

	test("the panel's Edit opens exactly one prompt editor for the proposal", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("{}", { status: 404 })) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const reason =
			"Retro proposal from t3. Accept starts it. Edit task changes the prompt first. Cancel task declines it.";
		const task = cardFixture({
			kind: "work",
			research: false,
			report: null,
			details: null,
			branch: null,
			model: null,
			worktree: null,
			sessionId: null,
			images: [],
			pendingImages: [],
			shots: [],
			keptFiles: [],
			workCheckLog: [],
			updateIds: [],
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
			prompt: "Rework the wording",
		} as unknown as Partial<TaskCard> & Partial<Pick<Task, "report">>);
		const panelEdit = (): Element => {
			const node = [...container.querySelectorAll("button")].find(
				(b) => b.textContent?.trim() === "Edit",
			);
			if (node === undefined) throw new Error("no panel Edit button");
			return node;
		};
		try {
			const base = {
				project: {
					name: "proj",
					github: null,
					hasRules: true,
					sessionsDir: "/tmp/proj/.tasks/sessions",
					settings: {},
				} as unknown as ProjectView,
				act: async () => true,
				onClose: () => {},
				onFollowed: () => {},
				projects: [],
				read: true,
				onMarkUnread: () => {},
				onMarkSeen: () => {},
				tasks: [],
				onOpenTask: () => {},
				draining: false,
				usedTotal: 0,
				maxTotal: null,
			};
			await act(async () => {
				root.render(<Drawer {...base} task={task} />);
			});
			await act(async () => {
				onClickOf(panelEdit())({});
			});
			// One editor with the proposal's prompt, and no duplicate edit-text id.
			const editors = container.querySelectorAll("#edit-text");
			expect(editors.length).toBe(1);
			expect((editors[0] as unknown as HTMLTextAreaElement).value).toBe(
				"Rework the wording",
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

describe("ProjectBoard sync-commit advisories", () => {
	const projectWith = (over: Record<string, unknown>): ProjectView =>
		({
			name: "proj",
			hasRules: true,
			github: null,
			gitless: false,
			dirty: false,
			mainBranch: null,
			mainUnpushed: false,
			prModeSuggestion: false,
			target: "origin/main",
			archReview: null,
			latestRelease: null,
			latestImage: null,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
			...over,
		}) as unknown as ProjectView;

	const renderBoard = (project: ProjectView): string => {
		const tasks = [cardFixture({ id: "t1", title: "Fix bug" })];
		return renderToStaticMarkup(
			<ProjectBoard
				project={project}
				tasks={tasks}
				deltas={new Map()}
				open={() => {}}
				seenAnswers={new Set()}
				seenDoneSince={0}
				compose={() => {}}
				composeDraft={() => {}}
				act={async () => true}
				onNotice={() => {}}
				draining={false}
			/>,
		);
	};

	test("a checkout left on a foreign branch names it in the advisory", () => {
		const html = renderBoard(projectWith({ mainBranch: "ott/ottr-516-mean" }));
		expect(html).toContain("ott/ottr-516-mean");
		expect(html).toContain("never to a task branch.");
	});

	test("an unpushed local main offers the Push to origin button", () => {
		const html = renderBoard(projectWith({ mainUnpushed: true }));
		expect(html).toContain("Push to origin");
		expect(html).toContain("has commits origin lacks");
	});

	test("a PR-mode suggestion renders the advisory with the turn-on action", () => {
		const html = renderBoard(projectWith({ prModeSuggestion: true }));
		expect(html).toContain("GitHub requires pull requests into");
		expect(html).toContain("Turn on PR mode");
	});

	test("no PR-mode suggestion renders no advisory", () => {
		const html = renderBoard(projectWith({}));
		expect(html).not.toContain("GitHub requires pull requests into");
		expect(html).not.toContain("Turn on PR mode");
	});

	test("a ghe.com origin mismatch names the host and links the GitHub host setting", () => {
		const html = renderBoard(projectWith({ githubHostNotice: "acme.ghe.com" }));
		expect(html).toContain("GitHub features off: set GitHub host to");
		expect(html).toContain("<code>acme.ghe.com</code>");
		expect(html).toContain('class="notif-link"');
		expect(html).toContain("Settings → GitHub → GitHub host");
	});

	test("a clean project renders neither advisory", () => {
		const html = renderBoard(projectWith({}));
		expect(html).not.toContain("Push to origin");
		expect(html).not.toContain("never to a task branch.");
		expect(html).not.toContain("has commits origin lacks");
		expect(html).not.toContain("GitHub features off");
	});
});

describe("ProjectBoard repo link", () => {
	const projectWith = (over: Record<string, unknown>): ProjectView =>
		({
			name: "proj",
			hasRules: true,
			github: null,
			gitless: false,
			dirty: false,
			mainBranch: null,
			mainUnpushed: false,
			target: "origin/main",
			archReview: null,
			latestRelease: null,
			latestImage: null,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
			...over,
		}) as unknown as ProjectView;

	const renderBoard = (project: ProjectView): string =>
		renderToStaticMarkup(
			<ProjectBoard
				project={project}
				tasks={[cardFixture({ id: "t1", title: "Fix bug" })]}
				deltas={new Map()}
				open={() => {}}
				seenAnswers={new Set()}
				seenDoneSince={0}
				compose={() => {}}
				composeDraft={() => {}}
				act={async () => true}
				onNotice={() => {}}
				draining={false}
			/>,
		);

	test("the header links the repo by its owner/repo slug", () => {
		const html = renderBoard(
			projectWith({ github: "https://github.com/octo/repo.git" }),
		);
		expect(html).toContain('title="GitHub repository"');
		expect(html).toContain('href="https://github.com/octo/repo.git"');
		expect(html).toContain("octo/repo</a>");
		expect(html).not.toContain('aria-label="GitHub"');
	});

	test("a remote without an owner/repo tail keeps the icon-only link", () => {
		const html = renderBoard(
			projectWith({ github: "https://github.com/octo" }),
		);
		expect(html).toContain('title="GitHub repository"');
		expect(html).not.toContain("octo</a>");
	});
});

describe("ProjectBoard rules interview action", () => {
	const projectNoRules = {
		name: "proj",
		hasRules: false,
		github: null,
		gitless: false,
		dirty: false,
		mainBranch: null,
		mainUnpushed: false,
		target: "origin/main",
		archReview: null,
		latestRelease: null,
		latestImage: null,
		settings: { setupChecklist: false },
		sessionsDir: "/tmp/s",
	} as unknown as ProjectView;

	const renderBoard = (tasks: TaskCard[]): string =>
		renderToStaticMarkup(
			<ProjectBoard
				project={projectNoRules}
				tasks={tasks}
				deltas={new Map()}
				open={() => {}}
				seenAnswers={new Set()}
				seenDoneSince={0}
				compose={() => {}}
				composeDraft={() => {}}
				act={async () => true}
				onNotice={() => {}}
				draining={false}
			/>,
		);

	test("a live rules card offers Open rules task instead of Discuss rules", () => {
		const html = renderBoard([
			cardFixture({ id: "PROJ-7", kind: "interview", stage: "todo" }),
		]);
		expect(html).toContain("Open rules task");
		expect(html).not.toContain("Discuss rules");
	});

	test("a done rules card is not live: Discuss rules stays", () => {
		const html = renderBoard([
			cardFixture({ id: "PROJ-7", kind: "interview", stage: "done" }),
		]);
		expect(html).toContain("Discuss rules");
		expect(html).not.toContain("Open rules task");
	});

	test("a cancelled rules card is not live: Discuss rules stays", () => {
		const html = renderBoard([
			cardFixture({
				id: "PROJ-7",
				kind: "interview",
				stage: "done",
				cancelledAt: 5,
			}),
		]);
		expect(html).toContain("Discuss rules");
		expect(html).not.toContain("Open rules task");
	});

	test("no rules card at all: Discuss rules stays", () => {
		const html = renderBoard([cardFixture({ id: "t1", title: "Fix bug" })]);
		expect(html).toContain("Discuss rules");
		expect(html).not.toContain("Open rules task");
	});
});

describe("ProjectBoard PR-mode suggestion action", () => {
	// React interaction needs browser globals; the same happy-dom swap as the
	// settings-shortcut tests above.
	const window = new Window({ url: "http://localhost/projects/proj" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
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

	/** The production onClick React rendered onto the node; a dispatched click never
	 *  reaches React's event plugin under happy-dom (see the search delay tests). */
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

	test("the Turn on PR mode button posts prMode true to the project settings", async () => {
		const realFetch = globalThis.fetch;
		const posts: { url: string; body: unknown }[] = [];
		globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
			if (String(url).endsWith("/api/projects/proj/settings")) {
				posts.push({
					url: String(url),
					body: JSON.parse(String(init?.body ?? "{}")),
				});
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<ProjectBoard
						project={
							{
								name: "proj",
								hasRules: true,
								github: null,
								gitless: false,
								dirty: false,
								mainBranch: null,
								mainUnpushed: false,
								prModeSuggestion: true,
								target: "origin/main",
								archReview: null,
								latestRelease: null,
								latestImage: null,
								settings: { setupChecklist: false },
								sessionsDir: "/tmp/s",
							} as unknown as ProjectView
						}
						tasks={[cardFixture({ id: "t1", title: "Fix bug" })]}
						deltas={new Map()}
						open={() => {}}
						seenAnswers={new Set()}
						seenDoneSince={0}
						compose={() => {}}
						composeDraft={() => {}}
						act={async (fn) => {
							await fn();
							return true;
						}}
						onNotice={() => {}}
						draining={false}
					/>,
				);
			});
			const btn = Array.from(container.querySelectorAll("button")).find(
				(b) => b.textContent === "Turn on PR mode",
			);
			if (btn === undefined) throw new Error("no Turn on PR mode button");
			await act(async () => {
				onClickOf(btn)({});
			});
			await act(async () => {});
			const post = posts.at(-1);
			expect(post?.url).toContain("/api/projects/proj/settings");
			expect(post?.body).toEqual({ prMode: true });
		} finally {
			globalThis.fetch = realFetch;
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});
});

describe("AddProjectModal board GitHub token reuse", () => {
	// React interaction needs browser globals; the same happy-dom swap as the
	// AskBlock tests above: installed after app.tsx's import, removed after.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
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

	/** The form-submit DOM event; happy-dom's Event class does not match lib.dom's. */
	const submitEvent = (): Event =>
		new window.Event("submit", {
			bubbles: true,
			cancelable: true,
		}) as unknown as Event;

	const typeInto = (el: HTMLInputElement, value: string): void => {
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		if (setter === undefined) throw new Error("value setter missing");
		setter.call(el, value);
	};

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

	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1, copyExtra: [] },
	} as unknown as ProjectView;

	const hostsView = (githubTokenSet: boolean): Record<string, unknown> => ({
		tokens: githubTokenSet
			? [{ host: "github.com", username: "x-access-token", tokenSet: true }]
			: [],
		globalKey: null,
		githubApp: null,
		githubHost: "github.com",
		githubTokenSet,
	});

	// The fetch mountAdd serves: gh-status 404, the git-hosts view for the token state,
	// a first project POST that fails for the missing token, then success; every POST
	// body lands in `posts`, and the github-token POST answers with the token set.
	async function addProjectFetch(
		hostsView: (githubTokenSet: boolean) => Record<string, unknown>,
		posts: { url: string; body: Record<string, unknown> }[],
		calls: { project: number },
		project: ProjectView,
		githubTokenSet: boolean,
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url.endsWith("/api/gh-status")) {
			return new Response("{}", { status: 404 });
		}
		if (url.endsWith("/api/git-hosts")) {
			return new Response(JSON.stringify(hostsView(githubTokenSet)), {
				status: 200,
			});
		}
		if (url.endsWith("/api/projects") && method === "POST") {
			calls.project += 1;
			posts.push({
				url,
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			if (calls.project === 1) {
				return new Response(
					JSON.stringify({
						error: "Authentication failed",
						needsToken: "github.com",
					}),
					{ status: 400 },
				);
			}
			return new Response(JSON.stringify({ project, interview: "i1" }), {
				status: 200,
			});
		}
		if (url.endsWith("/api/git-hosts/github-token")) {
			posts.push({
				url,
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			return new Response(JSON.stringify(hostsView(true)), { status: 200 });
		}
		return new Response("{}", { status: 404 });
	}

	async function mountAdd(
		githubTokenSet: boolean,
		projects: ProjectView[] = [],
	): Promise<{
		container: HTMLDivElement;
		root: ReturnType<typeof createRoot>;
		posts: { url: string; body: Record<string, unknown> }[];
		added: string[];
		restore: () => void;
	}> {
		const posts: { url: string; body: Record<string, unknown> }[] = [];
		const added: string[] = [];
		const calls = { project: 0 };
		const realFetch = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
			addProjectFetch(
				hostsView,
				posts,
				calls,
				project,
				githubTokenSet,
				input,
				init,
			)) as unknown as typeof fetch;

		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		// Minimal Act: run the work, hand a failure to the dialog's inline error.
		const actProp = async (
			fn: () => Promise<void>,
			onError?: (message: string) => void,
		): Promise<boolean> => {
			try {
				await fn();
			} catch (e) {
				onError?.(e instanceof Error ? e.message : String(e));
				return false;
			}
			return true;
		};
		try {
			await act(async () => {
				root.render(
					<AddProjectModal
						act={actProp}
						projects={projects}
						onClose={() => {}}
						onAdded={(interview: string) => added.push(interview)}
						openTask={() => {}}
					/>,
				);
			});
		} catch (e) {
			globalThis.fetch = realFetch;
			throw e;
		}
		return {
			container,
			root,
			posts,
			added,
			restore: () => {
				globalThis.fetch = realFetch;
			},
		};
	}

	test("the board token button retries Add with the prefilled x-access-token", async () => {
		const { container, root, posts, added, restore } = await mountAdd(true);
		try {
			const urlInput = container.querySelector(
				"input[data-autofocus]",
			) as unknown as HTMLInputElement;
			expect(urlInput).not.toBeNull();
			await act(async () => {
				typeInto(urlInput, "https://github.com/o/r.git");
				onChangeOf(urlInput)({
					target: urlInput,
					currentTarget: urlInput,
				});
			});
			const form = container.querySelector(
				"form",
			) as unknown as HTMLFormElement;
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			// The 400's needsToken opened the token step, pre-filled with the
			// GitHub host's convention, and the board token button is offered.
			const user = container.querySelector(
				"fieldset input",
			) as unknown as HTMLInputElement;
			expect(user.value).toBe("x-access-token");
			const boardButton = [...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Use the board GitHub token",
			);
			expect(boardButton).toBeDefined();
			await act(async () => {
				onClickOf(boardButton as unknown as Element)({});
			});
			expect(
				posts.find((p) => p.url.endsWith("/api/git-hosts/github-token"))?.body,
			).toEqual({ testUrl: "https://github.com/o/r.git" });
			expect(posts.filter((p) => p.url.endsWith("/api/projects")).length).toBe(
				2,
			);
			expect(added).toEqual(["i1"]);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	});

	test("without a board token the button is absent", async () => {
		const { container, root, restore } = await mountAdd(false);
		try {
			const urlInput = container.querySelector(
				"input[data-autofocus]",
			) as unknown as HTMLInputElement;
			await act(async () => {
				typeInto(urlInput, "https://github.com/o/r.git");
				onChangeOf(urlInput)({
					target: urlInput,
					currentTarget: urlInput,
				});
			});
			const form = container.querySelector(
				"form",
			) as unknown as HTMLFormElement;
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(container.textContent).toContain("Token for github.com");
			expect(
				[...container.querySelectorAll("button")].some(
					(b) => b.textContent === "Use the board GitHub token",
				),
			).toBe(false);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	});

	test("the prefix field mirrors the name segment until edited", async () => {
		const { container, root, restore } = await mountAdd(false);
		try {
			const urlInput = container.querySelector(
				"input[data-autofocus]",
			) as unknown as HTMLInputElement;
			await act(async () => {
				typeInto(urlInput, "https://github.com/acme/cmis-cli.git");
				onChangeOf(urlInput)({
					target: urlInput,
					currentTarget: urlInput,
				});
			});
			const prefixInput = container.querySelector(
				'input[aria-label="Task ID prefix"]',
			) as unknown as HTMLInputElement;
			expect(prefixInput.value).toBe("CMIS");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	});

	test("a typed prefix reaches the Add request body", async () => {
		const { container, root, posts, restore } = await mountAdd(false);
		try {
			const urlInput = container.querySelector(
				"input[data-autofocus]",
			) as unknown as HTMLInputElement;
			await act(async () => {
				typeInto(urlInput, "https://github.com/acme/cmis-cli.git");
				onChangeOf(urlInput)({
					target: urlInput,
					currentTarget: urlInput,
				});
			});
			const prefixInput = container.querySelector(
				'input[aria-label="Task ID prefix"]',
			) as unknown as HTMLInputElement;
			await act(async () => {
				typeInto(prefixInput, "fix");
				onChangeOf(prefixInput)({
					target: prefixInput,
					currentTarget: prefixInput,
				});
			});
			const form = container.querySelector(
				"form",
			) as unknown as HTMLFormElement;
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			// The mocked answer is the 400 needsToken step; the harness still records the body.
			expect(posts[0]?.body.taskIdPrefix).toBe("FIX");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	});

	test("a prefix that another project uses warns, a free one does not", async () => {
		const clash = { ...project, taskPrefix: "FIX" } as unknown as ProjectView;
		const { container, root, restore } = await mountAdd(false, [clash]);
		try {
			const prefixInput = container.querySelector(
				'input[aria-label="Task ID prefix"]',
			) as unknown as HTMLInputElement;
			await act(async () => {
				typeInto(prefixInput, "FIX");
				onChangeOf(prefixInput)({
					target: prefixInput,
					currentTarget: prefixInput,
				});
			});
			expect(container.querySelector('p[role="status"]')).not.toBeNull();
			await act(async () => {
				typeInto(prefixInput, "XYZ");
				onChangeOf(prefixInput)({
					target: prefixInput,
					currentTarget: prefixInput,
				});
			});
			expect(container.querySelector('p[role="status"]')).toBeNull();
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	});

	test("an invalid prefix blocks the submit with an inline error and no request", async () => {
		const { container, root, posts, restore } = await mountAdd(false);
		try {
			const urlInput = container.querySelector(
				"input[data-autofocus]",
			) as unknown as HTMLInputElement;
			await act(async () => {
				typeInto(urlInput, "https://github.com/acme/cmis-cli.git");
				onChangeOf(urlInput)({
					target: urlInput,
					currentTarget: urlInput,
				});
			});
			const prefixInput = container.querySelector(
				'input[aria-label="Task ID prefix"]',
			) as unknown as HTMLInputElement;
			await act(async () => {
				typeInto(prefixInput, "A-B");
				onChangeOf(prefixInput)({
					target: prefixInput,
					currentTarget: prefixInput,
				});
			});
			const form = container.querySelector(
				"form",
			) as unknown as HTMLFormElement;
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			const errText = container.querySelector(".auth-error")?.textContent;
			expect(errText).toBe(
				"The task ID prefix must be 1 to 8 letters and digits.",
			);
			expect(posts.filter((p) => p.url.endsWith("/api/projects"))).toEqual([]);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	});
});

describe("AuthPage setup form", () => {
	// The same happy-dom browser-mount pattern as the other client describes:
	// React interaction needs browser globals, and afterAll puts them back.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		location: window.location,
		localStorage: window.localStorage,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
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

	/** The form-submit DOM event; happy-dom's Event class does not match lib.dom's. */
	const submitEvent = (): Event =>
		new window.Event("submit", {
			bubbles: true,
			cancelable: true,
		}) as unknown as Event;
	/** A React onChange picks up programmatic edits only through the native value setter. */
	const typeInto = (el: HTMLInputElement, value: string): void => {
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		if (setter === undefined) throw new Error("value setter missing");
		setter.call(el, value);
	};
	/** Dispatched input events never reach React's ChangeEventPlugin: call the production onChange. */
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
	/** Buttons get the same treatment: dispatch never reaches React's onClick. */
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

	interface PostCall {
		url: string;
		body: unknown;
	}

	/** Mounts the setup form against `respond`; the cleanup puts fetch and the DOM back. */
	async function mountAuth(
		respond: (url: string, body: unknown) => Response,
	): Promise<{
		container: HTMLDivElement;
		form: HTMLFormElement;
		field: (text: string) => HTMLInputElement;
		posts: PostCall[];
		reloadCalls: { n: number };
		unmount: () => Promise<void>;
	}> {
		const posts: PostCall[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const url = String(input);
			const body =
				init?.body === undefined ? null : JSON.parse(String(init.body));
			if (init?.method === "POST") posts.push({ url, body });
			return respond(url, body);
		}) as typeof fetch;
		// The success path reloads the page; happy-dom's reload would navigate away.
		const reloadCalls = { n: 0 };
		window.location.reload = () => {
			reloadCalls.n++;
		};
		// happy-dom's DOM classes do not structurally match lib.dom's; the test
		// speaks lib types, so the boundary converts once here.
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(<AuthPage mode="setup" version={null} />);
		});
		const form = container.querySelector("form") as unknown as HTMLFormElement;
		/** A setup field by its label text; only the token and host inputs carry aria-labels. */
		const field = (text: string): HTMLInputElement => {
			const label = [...container.querySelectorAll("label")].find((l) =>
				(l.textContent ?? "").startsWith(text),
			);
			const node = label?.querySelector(
				"input",
			) as unknown as HTMLInputElement | null;
			if (node === null || node === undefined)
				throw new Error(`no ${text} field`);
			return node;
		};
		return {
			container,
			form,
			field,
			posts,
			reloadCalls,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
				globalThis.fetch = realFetch;
			},
		};
	}

	/** Fills every required field plus the host field ("": leave it empty). */
	async function fill(
		field: (text: string) => HTMLInputElement,
		hostValue: string,
	): Promise<void> {
		const set = (text: string, value: string) => {
			const el = field(text);
			typeInto(el, value);
			onChangeOf(el)({ target: el, currentTarget: el });
		};
		set("Name", "ada");
		set("Password", "hunter222");
		set("GitHub token", "ghp_t");
		if (hostValue !== "") set("GitHub host", hostValue);
	}

	const hostPosts = (posts: PostCall[]): PostCall[] =>
		posts.filter((p) => p.url.endsWith("/api/settings/github-host"));

	test("renders the GitHub host field", async () => {
		const { container, unmount } = await mountAuth(() => Response.json({}));
		try {
			expect(
				container.querySelector('input[aria-label="GitHub host"]'),
			).not.toBeNull();
			const hints = [...container.querySelectorAll(".hint")].map(
				(h) => h.textContent ?? "",
			);
			expect(hints.some((t) => t.includes("Settings → Other git hosts"))).toBe(
				true,
			);
		} finally {
			await unmount();
		}
	});

	test("onboarding posts the host like Settings saves it", async () => {
		const { form, field, posts, reloadCalls, unmount } = await mountAuth(
			(url, body) => {
				if (url.endsWith("/api/setup")) {
					expect(body).toEqual({
						name: "ada",
						password: "hunter222",
						githubToken: "ghp_t",
					});
					return Response.json({ ok: true, apiKey: "k" });
				}
				if (url.endsWith("/api/settings/github-host")) {
					return Response.json({ host: "acme.ghe.com", expiresAt: null });
				}
				return Response.json({}, { status: 404 });
			},
		);
		try {
			await act(async () => {
				await fill(field, "acme.ghe.com");
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			const saved = hostPosts(posts);
			expect(saved).toHaveLength(1);
			expect(saved[0]?.body).toEqual({ host: "acme.ghe.com" });
			expect(reloadCalls.n).toBe(1);
		} finally {
			await unmount();
		}
	});

	test("an empty host field skips the host save", async () => {
		const { form, field, posts, reloadCalls, unmount } = await mountAuth(
			(url) => {
				if (url.endsWith("/api/setup")) {
					return Response.json({ ok: true, apiKey: "k" });
				}
				return Response.json({}, { status: 404 });
			},
		);
		try {
			await act(async () => {
				await fill(field, "");
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(hostPosts(posts)).toEqual([]);
			expect(reloadCalls.n).toBe(1);
		} finally {
			await unmount();
		}
	});

	test("a failed host save shows the error and stays", async () => {
		const { container, form, field, posts, reloadCalls, unmount } =
			await mountAuth((url) => {
				if (url.endsWith("/api/setup")) {
					return Response.json({ ok: true, apiKey: "k" });
				}
				if (url.endsWith("/api/settings/github-host")) {
					return Response.json(
						{
							error:
								"OTTR_GITHUB_HOST: drop the scheme and path; use a bare hostname",
						},
						{ status: 400 },
					);
				}
				return Response.json({}, { status: 404 });
			});
		try {
			await act(async () => {
				await fill(field, "acme.ghe.com");
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(hostPosts(posts)).toHaveLength(1);
			const alert = container.querySelector('[role="alert"]');
			expect(alert?.textContent ?? "").toContain("bare hostname");
			expect(alert?.textContent ?? "").toContain(
				"Settings → GitHub → GitHub host",
			);
			expect(reloadCalls.n).toBe(0);
		} finally {
			await unmount();
		}
	});

	test("the password reveal toggle switches the input type", async () => {
		const { container, unmount } = await mountAuth(() => Response.json({}));
		try {
			const input = container.querySelector<HTMLInputElement>(".pw-wrap input");
			const button = container.querySelector<HTMLButtonElement>(".pw-toggle");
			if (input === null || button === null)
				throw new Error("no password field");
			expect(input.type).toBe("password");
			expect(button.getAttribute("aria-pressed")).toBe("false");
			expect(button.getAttribute("aria-label")).toBe("Show password");
			expect(button.getAttribute("aria-controls")).toBe(input.id);
			await act(async () => {
				onClickOf(button)({} as unknown);
			});
			expect(input.type).toBe("text");
			expect(button.getAttribute("aria-pressed")).toBe("true");
			expect(button.getAttribute("aria-label")).toBe("Hide password");
			await act(async () => {
				onClickOf(button)({} as unknown);
			});
			expect(input.type).toBe("password");
			expect(button.getAttribute("aria-pressed")).toBe("false");
		} finally {
			await unmount();
		}
	});

	test("setup shows a live count that reports ok at eight characters", async () => {
		const { container, field, unmount } = await mountAuth(() =>
			Response.json({}),
		);
		try {
			expect(container.textContent).not.toContain("Repeat password");
			const count = container.querySelector(".pw-count");
			if (count === null) throw new Error("no count line");
			expect(count.getAttribute("role")).toBe("status");
			expect(count.textContent).toBe("0 / 8 characters");
			const pw = field("Password");
			typeInto(pw, "hunter2");
			await act(async () => {
				onChangeOf(pw)({ target: pw, currentTarget: pw });
			});
			expect(count.textContent).toBe("7 / 8 characters");
			typeInto(pw, "hunter222");
			await act(async () => {
				onChangeOf(pw)({ target: pw, currentTarget: pw });
			});
			expect(count.textContent).toBe("ok");
		} finally {
			await unmount();
		}
	});
});

describe("Drawer PR link", () => {
	const project = {
		name: "proj",
		hasRules: true,
		github: "https://github.com/octo/repo",
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1 },
	} as unknown as ProjectView;
	const base = {
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: false,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
		tasks: [],
	};

	test("a card with an open PR links PR #N from its drawer meta", () => {
		const card = cardFixture({
			id: "P-12",
			stage: "merging",
			state: "idle",
			workCheckLog: [],
			images: [],
			pendingImages: [],
			shots: [],
			keptFiles: [],
			updateIds: [],
			branch: "ott/ottr-1-do-a-thing",
			prNumber: 12,
			prUrl: "https://github.com/octo/repo/pull/12",
			prHeadSha: "4f2c9ab1fullsha0000000000000000000000000",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={card} />);
		expect(html).toContain("<dt>PR</dt>");
		expect(html).toContain('href="https://github.com/octo/repo/pull/12"');
		expect(html).toContain("PR #12");
		expect(html).toContain('rel="noopener noreferrer"');
	});

	test("without a PR number the drawer shows no PR row", () => {
		const card = cardFixture({
			id: "P-13",
			stage: "merging",
			state: "idle",
			workCheckLog: [],
			images: [],
			pendingImages: [],
			shots: [],
			keptFiles: [],
			updateIds: [],
			branch: "ott/ottr-2-do-a-thing",
			prNumber: null,
			prUrl: null,
			prHeadSha: null,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={card} />);
		expect(html).not.toContain("<dt>PR</dt>");
		expect(html).not.toContain("PR #");
	});

	test("a PR number without a URL renders plain text, not a link", () => {
		const card = cardFixture({
			id: "P-14",
			stage: "merging",
			state: "idle",
			workCheckLog: [],
			images: [],
			pendingImages: [],
			shots: [],
			keptFiles: [],
			updateIds: [],
			prNumber: 14,
			prUrl: null,
			prHeadSha: null,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={card} />);
		expect(html).toContain("<dt>PR</dt>");
		expect(html).toContain("PR #14");
		expect(html).not.toMatch(/<dt>PR<\/dt><dd><a/);
	});
});

describe("Optimistic taps (client)", () => {
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		HTMLSelectElement: window.HTMLSelectElement,
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
		// LaneCol's FLIP effect animates committed order changes; happy-dom has no WAAPI.
		const proto = window.HTMLElement.prototype as unknown as Record<
			string,
			unknown
		>;
		proto.animate ??= () => ({ finished: Promise.resolve() });
		proto.showPopover ??= () => {};
		proto.hidePopover ??= () => {};
	});
	afterAll(() => {
		delete host.IS_REACT_ACT_ENVIRONMENT;
		for (const [key, value] of originals) {
			if (value === undefined) delete host[key];
			else host[key] = value;
		}
	});

	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	const base = {
		project,
		act: async (fn: () => Promise<void>) => {
			try {
				await fn();
				return true;
			} catch {
				return false;
			}
		},
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: false,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
		tasks: [] as TaskCard[],
	};
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;

	// happy-dom's dispatched events never reach React's event plugin; call the
	// production prop React rendered onto the node instead (same as above).
	const propHandler = (
		node: object,
		key: "onClick" | "onChange" | "onSubmit" | "onKeyDown",
	): ((e: unknown) => void) => {
		const propsKey = Object.getOwnPropertyNames(node).find((k) =>
			k.startsWith("__reactProps$"),
		);
		if (propsKey === undefined) throw new Error("react props missing on node");
		const props = (node as unknown as Record<string, unknown>)[
			propsKey
		] as Record<string, ((e: unknown) => void) | undefined>;
		const handler = props[key];
		if (handler === undefined) throw new Error(`node has no ${key}`);
		return handler;
	};
	/** The form-submit DOM event; happy-dom's Event class does not match lib.dom's. */
	const submitEvent = (): InstanceType<typeof window.Event> =>
		new window.Event("submit", {
			bubbles: true,
			cancelable: true,
		});
	// Per-URL fetch stub: gated URLs hold until their gate resolves with a status,
	// everything else degrades to 404 (the drawer's failed detail fetch).
	const stubFetch = (
		gates: { url: string; resolve: (status: number) => void }[],
	): (() => void) => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			const g = gates.find((x) => url.endsWith(x.url));
			if (g !== undefined) {
				const status = await new Promise<number>((r) => (g.resolve = r));
				return new Response("{}", { status });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		return () => {
			globalThis.fetch = realFetch;
		};
	};
	/** Mounts the Drawer with `task` under act(), runs `body`, unmounts. */
	const withDrawer = async (
		task: TaskCard,
		gates: Parameters<typeof stubFetch>[0],
		body: () => Promise<void>,
	): Promise<void> => {
		const restore = stubFetch(gates);
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={task} />);
			});
			await act(async () => {});
			await body();
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	};

	const starTask = (starred = false) =>
		cardFixture({
			...drawerFields,
			research: true,
			stage: "done",
			state: "idle",
			starred,
		});
	const starButton = () =>
		window.document.querySelector(
			'button[aria-label="Star"], button[aria-label="Starred"]',
		)!;

	test("star shows the flip before the server answers and rolls it back on failure", async () => {
		const g = { url: "/star" } as Parameters<typeof stubFetch>[0][number];
		await withDrawer(starTask(), [g], async () => {
			const btn = starButton();
			expect(btn.getAttribute("aria-pressed")).toBe("false");
			await act(async () => {
				propHandler(btn, "onClick")({} as unknown);
			});
			// In flight: the star shows the new value before any server frame.
			expect(starButton().getAttribute("aria-pressed")).toBe("true");
			expect(starButton().getAttribute("aria-label")).toBe("Starred");
			await act(async () => {});
			g.resolve(500);
			await act(async () => {});
			// Failed sync: the visible state rolls back.
			expect(starButton().getAttribute("aria-pressed")).toBe("false");
			expect(starButton().getAttribute("aria-label")).toBe("Star");
		});
	});

	test("star keeps the flip after the server confirms", async () => {
		const g = { url: "/star" } as Parameters<typeof stubFetch>[0][number];
		await withDrawer(starTask(), [g], async () => {
			await act(async () => {
				propHandler(starButton(), "onClick")({} as unknown);
			});
			expect(starButton().getAttribute("aria-pressed")).toBe("true");
			await act(async () => {});
			g.resolve(200);
			await act(async () => {});
			expect(starButton().getAttribute("aria-pressed")).toBe("true");
		});
	});

	const rankTask = () =>
		cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: "pick a rank",
			priority: null,
		});

	test("triage rank shows the pick before the server answers and rolls it back on failure", async () => {
		const g = { url: "/triage" } as Parameters<typeof stubFetch>[0][number];
		await withDrawer(rankTask(), [g], async () => {
			const seg = () =>
				[...window.document.querySelectorAll(".rank-seg button")].find(
					(b) => b.textContent === "P1",
				)!;
			const defaultSeg = () =>
				[...window.document.querySelectorAll(".rank-seg button")].find(
					(b) => b.textContent === "Default",
				)!;
			expect(seg().getAttribute("aria-pressed")).toBe("false");
			await act(async () => {
				propHandler(seg(), "onClick")({} as unknown);
			});
			// In flight: the pick leads, the POST follows.
			expect(seg().getAttribute("aria-pressed")).toBe("true");
			g.resolve(500);
			await act(async () => {});
			expect(seg().getAttribute("aria-pressed")).toBe("false");
			expect(defaultSeg().getAttribute("aria-pressed")).toBe("true");
		});
	});

	test("triage rank keeps the pick after the server confirms", async () => {
		const g = { url: "/triage" } as Parameters<typeof stubFetch>[0][number];
		await withDrawer(rankTask(), [g], async () => {
			const seg = () =>
				[...window.document.querySelectorAll(".rank-seg button")].find(
					(b) => b.textContent === "P1",
				)!;
			await act(async () => {
				propHandler(seg(), "onClick")({} as unknown);
			});
			expect(seg().getAttribute("aria-pressed")).toBe("true");
			g.resolve(200);
			await act(async () => {});
			expect(seg().getAttribute("aria-pressed")).toBe("true");
		});
	});

	const modelTask = () =>
		cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
			model: "zai/glm-5.3-flash",
		});
	test("model pick shows before the server answers and rolls back on failure", async () => {
		resetCatalogCache();
		const g = { url: "/model" } as Parameters<typeof stubFetch>[0][number];
		const models = new Response(
			JSON.stringify({
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
				],
				roles: { default: "zai/glm-5.3-flash" },
			}),
			{ status: 200 },
		);
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/models")) return models.clone();
			const gateHit = url.endsWith(g.url);
			if (gateHit) {
				const status = await new Promise<number>((r) => (g.resolve = r));
				return new Response("{}", { status });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={modelTask()} />);
			});
			await act(async () => {});
			const trigger = container.querySelector("button.model-trigger");
			expect(trigger).not.toBeNull();
			expect(trigger!.getAttribute("aria-label")).toBe(
				"Model: zai/glm-5.3-flash",
			);
			// happy-dom has no popover: the options sit in the DOM unshown, so pick
			// one directly through its rendered onClick.
			const option = [
				...container.querySelectorAll("button.model-option"),
			].find((b) => b.textContent?.includes("Claude Opus 5.5"));
			expect(option).toBeDefined();
			await act(async () => {
				propHandler(option!, "onClick")({} as unknown);
			});
			// In flight: the pick leads, the POST follows.
			expect(trigger!.getAttribute("aria-label")).toBe(
				"Model: anthropic/claude-opus-5-5",
			);
			await act(async () => {});
			g.resolve(500);
			await act(async () => {});
			expect(trigger!.getAttribute("aria-label")).toBe(
				"Model: zai/glm-5.3-flash",
			);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
			resetCatalogCache();
		}
	});

	test("the model picker shows labelled skeleton rows while the catalog loads", async () => {
		resetCatalogCache();
		const { promise: pending, resolve: resolveModels } =
			Promise.withResolvers<Response>();
		const models = new Response(
			JSON.stringify({
				models: [
					{
						id: "anthropic/claude-opus-5-5",
						selector: "anthropic/claude-opus-5-5",
						name: "Claude Opus 5.5",
						contextWindow: null,
					},
				],
				roles: {},
			}),
			{ status: 200 },
		);
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/models")) return pending;
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={modelTask()} />);
			});
			await act(async () => {});
			// In flight: a named, list-shaped placeholder, never a silent empty list.
			const skeleton = container.querySelector(".model-list .skeleton");
			expect(skeleton).not.toBeNull();
			expect(skeleton!.getAttribute("role")).toBe("status");
			expect(skeleton!.getAttribute("aria-label")).toBe(
				"Loading the model list",
			);
			expect(
				container.querySelector(".model-list button.model-option"),
			).toBeNull();
			await act(async () => {
				resolveModels(models);
			});
			// Landed: the skeleton leaves, the options arrive.
			expect(container.querySelector(".model-list .skeleton")).toBeNull();
			const option = [
				...container.querySelectorAll("button.model-option"),
			].find((b) => b.textContent?.includes("Claude Opus 5.5"));
			expect(option).toBeDefined();
		} finally {
			resolveModels(models);
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
			resetCatalogCache();
		}
	});

	const laneBase = {
		projectTasks: [] as TaskCard[],
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: () => {},
		unread: () => false,
		filtering: false,
		draining: false,
	};
	const laneTasks = () => [
		cardFixture({ id: "a", stage: "todo", state: "queued" }),
		cardFixture({ id: "b", stage: "todo", state: "queued" }),
		cardFixture({ id: "c", stage: "todo", state: "idle" }),
	];
	test("queue reorder applies the new order at once and rolls it back on failure", async () => {
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		let resolveReorder!: (ok: boolean) => void;
		const onReorder = ((): Promise<boolean> => {
			return new Promise<boolean>((r) => {
				resolveReorder = r;
			});
		})();
		const order = (): (string | null)[] =>
			[...container.querySelectorAll(".card[data-task-id]")].map((el) =>
				el.getAttribute("data-task-id"),
			);
		try {
			await act(async () => {
				root.render(
					<LaneCol
						{...laneBase}
						stage="todo"
						tasks={laneTasks()}
						onReorder={() => onReorder}
					/>,
				);
			});
			expect(order()).toEqual(["a", "b", "c"]);
			const b = container.querySelector('.card[data-task-id="b"]')!;
			// Keyboard reorder (the pointer-free path): Alt+ArrowUp moves b above a.
			await act(async () => {
				propHandler(
					container.querySelector(".stage-cards")!,
					"onKeyDown",
				)({
					altKey: true,
					key: "ArrowUp",
					target: b,
					preventDefault: () => {},
				} as unknown);
			});
			// In flight: the overlay shows the new order at once, no spinner slot.
			expect(order()).toEqual(["c", "b", "a"]);
			expect(container.querySelector(".drop-slot")).toBeNull();
			resolveReorder(false);
			await act(async () => {});
			// Failed sync: the FLIP slide-back restores the server order.
			expect(order()).toEqual(["a", "b", "c"]);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});

	test("queue reorder keeps the overlay after the server confirms", async () => {
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		let resolveReorder!: (ok: boolean) => void;
		const onReorder = new Promise<boolean>((r) => {
			resolveReorder = r;
		});
		const order = (): (string | null)[] =>
			[...container.querySelectorAll(".card[data-task-id]")].map((el) =>
				el.getAttribute("data-task-id"),
			);
		try {
			await act(async () => {
				root.render(
					<LaneCol
						{...laneBase}
						stage="todo"
						tasks={laneTasks()}
						onReorder={() => onReorder}
					/>,
				);
			});
			const b = container.querySelector('.card[data-task-id="b"]')!;
			await act(async () => {
				propHandler(
					container.querySelector(".stage-cards")!,
					"onKeyDown",
				)({
					altKey: true,
					key: "ArrowUp",
					target: b,
					preventDefault: () => {},
				} as unknown);
			});
			expect(order()).toEqual(["c", "b", "a"]);
			resolveReorder(true);
			await act(async () => {});
			// Confirmed: the overlay holds until a server frame settles it (none
			// arrives in this fixture, so the client's order stays shown).
			expect(order()).toEqual(["c", "b", "a"]);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});

	const steerTask = () =>
		cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
			pendingPrompt: null,
		});

	test("the queued steer bubble renders from the local send at once and rolls back on failure", async () => {
		const g = { url: "/steer" } as Parameters<typeof stubFetch>[0][number];
		await withDrawer(steerTask(), [g], async () => {
			expect(window.document.querySelector(".you-bubble")).toBeNull();
			const form = window.document.querySelector("form.steer-form")!;
			const textarea = form.querySelector("textarea")!;
			await act(async () => {
				propHandler(
					textarea,
					"onChange",
				)({ target: { value: "try the red path" } });
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			// In flight, no server frame yet: the bubble shows the local text and
			// no Edit/Cancel buttons (those wait for the server-confirmed prompt).
			const bubble = window.document.querySelector(".you-bubble");
			expect(bubble).not.toBeNull();
			expect(bubble!.textContent).toContain("try the red path");
			expect(
				window.document.querySelector(
					'button[aria-label="Edit the queued steering"]',
				),
			).toBeNull();
			g.resolve(500);
			await act(async () => {});
			// Failed sync: the bubble rolls back (the task had no pendingPrompt).
			expect(window.document.querySelector(".you-bubble")).toBeNull();
		});
	});
});

describe("Drawer re-run failed jobs action", () => {
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async () => true,
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};
	// React interaction needs browser globals; the setup mirrors the steering
	// describes above: happy-dom registers them for this describe, and afterAll
	// puts the originals back, so later test files in the same process see no DOM.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
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

	// happy-dom's dispatched clicks never reach React's event plugin (same
	// upstream gap as settings.test.tsx's onChangeOf): call the production
	// onClick React rendered onto the node instead.
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

	/** Renders a drawer for `card` under a fetch stub; the stub records the
	 * rerun POSTs and answers them with `rerun`, everything else with 404. */
	const withRoot = async (
		card: TaskCard,
		rerun: { status: number; body: unknown },
		run: (args: {
			posts: { url: string; body: unknown }[];
			container: HTMLDivElement;
			root: ReturnType<typeof createRoot>;
		}) => Promise<void>,
	): Promise<void> => {
		const posts: { url: string; body: unknown }[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith("/rerun-failed-jobs")) {
				posts.push({
					url: u,
					body: JSON.parse(String(init?.body)) as unknown,
				});
				return new Response(JSON.stringify(rerun.body), {
					status: rerun.status,
				});
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={card} />);
			});
			await run({ posts, container, root });
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	};

	const rerunButton = (container: HTMLDivElement): Element => {
		for (const node of container.querySelectorAll(".drawer-actions button"))
			if (node.textContent?.includes("Re-run failed jobs")) return node;
		throw new Error("no Re-run failed jobs button");
	};

	test("a card whose text links a run renders the Re-run failed jobs button", async () => {
		const card = cardFixture({
			...drawerFields,
			prompt:
				"Fix the CI failure in https://github.com/ottr-ai/ottr/actions/runs/42313545100",
		}) as TaskCard;
		await withRoot(
			card,
			{ status: 200, body: { ok: true, url: "" } },
			async ({ container }) => {
				expect(rerunButton(container)).not.toBeNull();
			},
		);
	});

	test("clicking it POSTs to the rerun route; a 403 naming actions:write surfaces as an alert", async () => {
		const card = cardFixture({
			...drawerFields,
			prompt:
				"Fix the CI failure in https://github.com/ottr-ai/ottr/actions/runs/42313545100",
		}) as TaskCard;
		await withRoot(
			card,
			{
				status: 403,
				body: {
					error:
						"GitHub refused the re-run (HTTP 403): the board's token lacks the actions:write scope for ottr/ottr",
				},
			},
			async ({ posts, container }) => {
				await act(async () => {
					onClickOf(rerunButton(container))({});
				});
				await act(async () => {});
				const post = posts.at(-1);
				expect(post?.url.endsWith("/rerun-failed-jobs")).toBe(true);
				expect(post?.body).toEqual({});
				const alerts = [...container.querySelectorAll('p[role="alert"]')];
				expect(
					alerts.some((a) => a.textContent?.includes("actions:write")),
				).toBe(true);
			},
		);
	});

	test("an ok:true response surfaces the Re-run requested status line", async () => {
		const card = cardFixture({
			...drawerFields,
			prompt:
				"Fix the CI failure in https://github.com/ottr-ai/ottr/actions/runs/42313545100",
		}) as TaskCard;
		await withRoot(
			card,
			{
				status: 200,
				body: {
					ok: true,
					url: "https://github.com/ottr-ai/ottr/actions/runs/42313545100",
				},
			},
			async ({ container }) => {
				await act(async () => {
					onClickOf(rerunButton(container))({});
				});
				await act(async () => {});
				const statuses = [...container.querySelectorAll('p[role="status"]')];
				expect(
					statuses.some((s) => s.textContent?.includes("Re-run requested.")),
				).toBe(true);
			},
		);
	});

	test("a card without a run link renders no Re-run failed jobs button", async () => {
		const card = cardFixture({
			...drawerFields,
			prompt: "Fix the flaky test in src/quota.ts",
		}) as TaskCard;
		await withRoot(
			card,
			{ status: 200, body: { ok: true, url: "" } },
			async ({ container }) => {
				expect(container.textContent).not.toContain("Re-run failed jobs");
			},
		);
	});
});

describe("AddProjectModal Git URL field error", () => {
	// React interaction needs browser globals; the same happy-dom swap as the
	// board-GitHub-token describe above: installed after app.tsx's import,
	// removed after this describe's tests.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
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

	const submitEvent = (): Event =>
		new window.Event("submit", {
			bubbles: true,
			cancelable: true,
		}) as unknown as Event;

	const typeInto = (el: HTMLInputElement, value: string): void => {
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		if (setter === undefined) throw new Error("value setter missing");
		setter.call(el, value);
	};

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

	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1, copyExtra: [] },
	} as unknown as ProjectView;

	/** Mounts the Add-project dialog under a stub; the stub records /api/projects
	 * POSTs (the field error must keep them at zero) and 404s everything else. */
	async function withAdd(
		run: (args: {
			container: HTMLDivElement;
			root: ReturnType<typeof createRoot>;
			posts: { url: string }[];
		}) => Promise<void>,
	): Promise<void> {
		const posts: { url: string }[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.endsWith("/api/projects") && method === "POST") {
				posts.push({ url });
				return new Response(JSON.stringify({ project, interview: "i1" }), {
					status: 200,
				});
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<AddProjectModal
						act={async (fn) => {
							await fn();
							return true;
						}}
						onClose={() => {}}
						onAdded={() => {}}
						openTask={() => {}}
						projects={[]}
					/>,
				);
			});
			await run({ container, root, posts });
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	}

	const typeUrl = async (
		container: HTMLDivElement,
		value: string,
	): Promise<HTMLInputElement> => {
		const urlInput = container.querySelector(
			"input[data-autofocus]",
		) as unknown as HTMLInputElement;
		if (urlInput === null) throw new Error("no Git URL input");
		await act(async () => {
			typeInto(urlInput, value);
			onChangeOf(urlInput)({ target: urlInput, currentTarget: urlInput });
		});
		return urlInput;
	};

	test("an invalid URL sets aria-invalid and shows the message under the field", async () => {
		await withAdd(async ({ container, posts }) => {
			const urlInput = await typeUrl(container, "not a url");
			// The field carries the error state (The Error-Says-Fix Rule).
			expect(urlInput.getAttribute("aria-invalid")).toBe("true");
			expect(urlInput.getAttribute("aria-describedby")).toBe(
				"add-git-url-error",
			);
			// The message sits directly under the field it names, linked by that id.
			const message = urlInput.nextElementSibling;
			expect(message?.id).toBe("add-git-url-error");
			expect(message?.getAttribute("role")).toBe("alert");
			expect(message?.textContent).toContain("Not a git repository URL");
			// A URL the field already rejects never reaches the server, so the
			// dialog-level alert cannot repeat the same message.
			const form = container.querySelector(
				"form",
			) as unknown as HTMLFormElement;
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(posts).toHaveLength(0);
		});
	});

	test("a valid URL clears the error and the input carries the git remote attributes", async () => {
		await withAdd(async ({ container }) => {
			const urlInput = await typeUrl(container, "git@github.com:o/r.git");
			expect(urlInput.getAttribute("aria-invalid")).toBeNull();
			expect(urlInput.getAttribute("aria-describedby")).toBeNull();
			expect(container.querySelector("#add-git-url-error")).toBeNull();
			// A Git remote field: git@host:path is no type="url" value, so the
			// input keyboard comes from inputMode, and spell check and autofill stay off.
			expect(urlInput.getAttribute("inputmode")).toBe("url");
			expect(urlInput.getAttribute("spellcheck")).toBe("false");
			expect(urlInput.getAttribute("autocomplete")).toBe("off");
		});
	});
});

describe("Drawer triage rank segmented control", () => {
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	// Fields the Drawer body reads before rendering; cardFixture's short cast omits them.
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async (fn: () => Promise<void>) => {
			await fn();
			return true;
		},
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};
	// React interaction needs browser globals; the same happy-dom swap as the
	// steering describes above.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
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

	/** Renders a drawer for `card` under a fetch stub; the stub records the
	 * triage POSTs and answers 200, everything else 404. */
	const withDrawer = async (
		card: TaskCard,
		run: (args: {
			container: HTMLDivElement;
			root: ReturnType<typeof createRoot>;
			posts: { url: string; body: unknown }[];
		}) => Promise<void>,
	): Promise<void> => {
		const posts: { url: string; body: unknown }[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith("/triage")) {
				posts.push({
					url: u,
					body: JSON.parse(String(init?.body)) as unknown,
				});
				return new Response("{}", { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={card} />);
			});
			await run({ container, root, posts });
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	};

	const segment = (container: HTMLDivElement, label: string): Element => {
		for (const node of container.querySelectorAll(".rank-seg button"))
			if (node.textContent === label) return node;
		throw new Error(`no ${label} segment`);
	};

	test("five segments show the task rank pressed and no select remains", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
			priority: "P1",
		}) as TaskCard;
		await withDrawer(card, async ({ container }) => {
			const group = container.querySelector("fieldset.triage-rank");
			expect(group).not.toBeNull();
			const buttons = [
				...(group as Element).querySelectorAll(".rank-seg button"),
			];
			expect(buttons.map((b) => b.textContent)).toEqual([
				"Default",
				"P0",
				"P1",
				"P2",
				"P3",
			]);
			const pressed = buttons.map(
				(b) => b.getAttribute("aria-pressed") === "true",
			);
			expect(pressed).toEqual([false, false, true, false, false]);
			// Five fixed options show all at once; the select is gone.
			expect(container.querySelector(".triage-row select")).toBeNull();
		});
	});

	test("clicking a rank shows the pick at once and POSTs the triage priority", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
			priority: "P1",
		}) as TaskCard;
		await withDrawer(card, async ({ container, posts }) => {
			await act(async () => {
				onClickOf(segment(container, "P2"))({});
			});
			// The Optimistic-Tap Rule: the pick leads, the POST follows.
			expect(segment(container, "P2").getAttribute("aria-pressed")).toBe(
				"true",
			);
			expect(segment(container, "P1").getAttribute("aria-pressed")).toBe(
				"false",
			);
			expect(posts).toHaveLength(1);
			expect(posts[0]?.url).toBe("/api/projects/proj/tasks/t1/triage");
			expect(posts[0]?.body).toEqual({ priority: "P2" });
		});
	});
});

describe("Confirm dialogs name their target", () => {
	const project = {
		name: "proj",
		github: null,
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	const drawerFields = {
		kind: "work",
		research: false,
		report: null,
		details: null,
		branch: null,
		model: null,
		worktree: null,
		sessionId: null,
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
		workCheckLog: [],
	} as unknown as Partial<TaskCard>;
	const base = {
		task: null as never,
		project,
		act: async (fn: () => Promise<void>) => {
			await fn();
			return true;
		},
		onClose: () => {},
		onFollowed: () => {},
		projects: [],
		read: true,
		onMarkUnread: () => {},
		onMarkSeen: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};
	// React interaction needs browser globals; the same happy-dom swap as the
	// describes above. confirmDialog mounts into document.body, so the dialogs
	// live outside the rendered container and this describe reads them there.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
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

	/** A dialog button's handler reads `e.currentTarget` to close its dialog, so
	 * the stubbed event carries the node (React's SyntheticEvent would too). */
	const press = (node: Element): void => {
		onClickOf(node)({ currentTarget: node });
	};

	/** The confirm dialog's title: the question text up to the first "?". */
	const question = (): string => {
		const h2 = window.document.querySelector(
			"dialog.confirm-dialog .dialog-head h2",
		);
		if (h2 === null) throw new Error("no confirm dialog open");
		return h2.textContent ?? "";
	};

	/** A button in the open dialog whose label ends with `label`. */
	const dialogButton = (label: string): Element => {
		for (const node of window.document.querySelectorAll(
			"dialog.confirm-dialog .dialog-actions button",
		))
			if (node.textContent?.includes(label)) return node as unknown as Element;
		throw new Error(`no ${label} button in the dialog`);
	};

	/** Lets the confirm flow's promises settle before the next dialog renders. */
	const settle = async (): Promise<void> => {
		await act(async () => {
			await Bun.sleep(20);
		});
	};

	/** Closes the open dialog through its safe button (the actions row leads with
	 * it) and waits for the unmount. */
	const dismiss = async (): Promise<void> => {
		const safe = window.document.querySelector(
			"dialog.confirm-dialog .dialog-actions button",
		) as Element | null;
		if (safe === null) throw new Error("no button in the dialog");
		await act(async () => {
			press(safe);
		});
		await settle();
	};

	/** Renders a drawer for `card` under a fetch stub; the stub records cancel,
	 * stop and triage POSTs, answers `cancelBody` on the cancel route (a kept
	 * worktree re-asks), and 404s everything else. */
	const withDrawer = async (
		card: TaskCard,
		run: (args: {
			container: HTMLDivElement;
			root: ReturnType<typeof createRoot>;
			posts: { url: string; body: unknown }[];
		}) => Promise<void>,
		cancelBody: Record<string, unknown> = {},
	): Promise<void> => {
		const posts: { url: string; body: unknown }[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (
				(u.endsWith("/cancel") || u.endsWith("/stop")) &&
				(init?.method ?? "GET") === "POST"
			) {
				posts.push({
					url: u,
					body: JSON.parse(String(init?.body)) as unknown,
				});
				return new Response(
					JSON.stringify(u.endsWith("/cancel") ? cancelBody : {}),
					{ status: 200 },
				);
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<Drawer {...base} task={card} />);
			});
			await run({ container, root, posts });
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	};

	const actionButton = (container: HTMLDivElement, label: string): Element => {
		for (const node of container.querySelectorAll(".drawer-actions button"))
			if (node.textContent?.includes(label)) return node;
		throw new Error(`no ${label} button in the drawer`);
	};

	test("the delete confirm names the done task", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
		}) as TaskCard;
		await withDrawer(card, async ({ container }) => {
			await act(async () => {
				onClickOf(actionButton(container, "Delete task"))({});
			});
			expect(question()).toBe(
				'Delete the done task t1 "Task one" from the board?',
			);
			await dismiss();
		});
	});

	test("the cancel confirm names the task", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
		}) as TaskCard;
		await withDrawer(card, async ({ container }) => {
			await act(async () => {
				onClickOf(actionButton(container, "Cancel task"))({});
			});
			expect(question()).toBe('Cancel t1 "Task one"?');
			await dismiss();
		});
	});

	test("the kept-worktree cancel confirm names the task too", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
		}) as TaskCard;
		await withDrawer(
			card,
			async ({ container, posts }) => {
				await act(async () => {
					onClickOf(actionButton(container, "Cancel task"))({});
				});
				await settle();
				// The cancel went through; the kept worktree asks a second yes.
				await act(async () => {
					press(dialogButton("Cancel task"));
				});
				await settle();
				expect(question()).toBe(
					'Delete the kept worktree and branch of t1 "Task one"?',
				);
				expect(
					window.document.querySelector(".confirm-detail")?.textContent,
				).toContain("/tmp/wt");
				// The second yes (Delete) forces the delete through the same route.
				await act(async () => {
					press(dialogButton("Delete"));
				});
				await settle();
				expect(
					posts.some(
						(p) =>
							p.body !== null && "force" in (p.body as Record<string, unknown>),
					),
				).toBe(true);
			},
			{ kept: "/tmp/wt" },
		);
	});

	test("the fresh-session confirm names the task", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
		}) as TaskCard;
		await withDrawer(card, async ({ container }) => {
			const newSession = [...container.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("New session"),
			);
			if (newSession === undefined) throw new Error("no New session button");
			await act(async () => {
				onClickOf(newSession)({});
			});
			expect(question()).toBe('Start a fresh omp session for t1 "Task one"?');
			await dismiss();
		});
	});

	test("the stop-turn confirm names the task", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
		}) as TaskCard;
		await withDrawer(card, async ({ container }) => {
			const stop = [...container.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Stop turn"),
			);
			if (stop === undefined) throw new Error("no Stop turn button");
			await act(async () => {
				onClickOf(stop)({});
			});
			expect(question()).toBe('Stop the running turn of t1 "Task one"?');
			await dismiss();
		});
	});

	test("the double-check stop confirm names the task too", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
		}) as TaskCard;
		await withDrawer(card, async ({ container, posts }) => {
			const stop = [...container.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Stop turn"),
			);
			if (stop === undefined) throw new Error("no Stop turn button");
			await act(async () => {
				onClickOf(stop)({});
			});
			await act(async () => {
				press(dialogButton("Stop turn"));
			});
			await settle();
			expect(question()).toBe('Really stop the running turn of t1 "Task one"?');
			// The second yes (Stop turn) sends the stop.
			await act(async () => {
				press(dialogButton("Stop turn"));
			});
			await settle();
			expect(posts.some((p) => p.url.endsWith("/stop"))).toBe(true);
		});
	});
});

describe("Release card re-release confirm names its target", () => {
	// React interaction needs browser globals; the same happy-dom swap as the
	// ProjectBoard search-delay describe above.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
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

	const question = (): string => {
		const h2 = window.document.querySelector(
			"dialog.confirm-dialog .dialog-head h2",
		);
		if (h2 === null) throw new Error("no confirm dialog open");
		return h2.textContent ?? "";
	};

	const dialogButton = (label: string): Element => {
		for (const node of window.document.querySelectorAll(
			"dialog.confirm-dialog .dialog-actions button",
		))
			if (node.textContent?.includes(label)) return node as unknown as Element;
		throw new Error(`no ${label} button in the dialog`);
	};

	/** A dialog button's handler reads `e.currentTarget` to close its dialog, so
	 * the stubbed event carries the node (React's SyntheticEvent would too). */
	const press = (node: Element): void => {
		onClickOf(node)({ currentTarget: node });
	};

	const settle = async (): Promise<void> => {
		await act(async () => {
			await Bun.sleep(20);
		});
	};

	const dismiss = async (): Promise<void> => {
		const safe = window.document.querySelector(
			"dialog.confirm-dialog .dialog-actions button",
		) as Element | null;
		if (safe === null) throw new Error("no button in the dialog");
		await act(async () => {
			press(safe);
		});
		await settle();
	};

	test("the kept-worktree confirm of Release again names the release card", async () => {
		const posts: { url: string; body: unknown }[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith("/cancel") && (init?.method ?? "GET") === "POST") {
				posts.push({
					url: u,
					body: JSON.parse(String(init?.body)) as unknown,
				});
				// The release card kept unmerged work, so the flow asks a second yes.
				return new Response(JSON.stringify({ kept: "/tmp/wt" }), {
					status: 200,
				});
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		try {
			// A stalled release card: parked for the user, merges still held, every
			// finding landed — reReleaseOf's re-release view, so the card carries
			// the Release again chip.
			const release = cardFixture({
				id: "r-1",
				title: "Release the docs",
				sessionTitle: "Release the docs",
				releaseVersion: "v2",
				heldMerges: ["m-1"],
				stage: "todo",
				state: "needs_you",
			}) as TaskCard;
			const boardProject = {
				name: "proj",
				hasRules: true,
				github: null,
				gitless: false,
				dirty: false,
				archReview: null,
				latestRelease: null,
				latestImage: null,
				settings: { setupChecklist: false },
				sessionsDir: "/tmp/s",
			} as unknown as ProjectView;
			await act(async () => {
				root.render(
					<ProjectBoard
						project={boardProject}
						tasks={[release]}
						deltas={new Map()}
						open={() => {}}
						seenAnswers={new Set()}
						seenDoneSince={0}
						compose={() => {}}
						composeDraft={() => {}}
						act={async (fn) => {
							await fn();
							return true;
						}}
						onNotice={() => {}}
						draining={false}
					/>,
				);
			});
			const again = [...container.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Release again"),
			);
			if (again === undefined) throw new Error("no Release again chip");
			await act(async () => {
				// The chip keeps the click off the card's stretched link.
				onClickOf(again)({
					preventDefault: () => {},
					stopPropagation: () => {},
				});
			});
			// Sanity: the first ask names the release version.
			expect(question()).toBe("Cancel release v2 and open Create release?");
			await act(async () => {
				press(dialogButton("Cancel release"));
			});
			await settle();
			expect(question()).toBe(
				'Delete the kept worktree and branch of r-1 "Release the docs"?',
			);
			await dismiss();
			expect(posts).toHaveLength(1);
			expect(posts[0]?.url).toBe("/api/projects/proj/tasks/r-1/cancel");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});
});
describe("LogView fetch start offset (client)", () => {
	// The same happy-dom swap as the ProjectBoard block above: installed after
	// app.tsx's import (its browser mount guard reads document at module load).
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
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
		for (const [key, value] of Object.entries(originals)) {
			if (value === undefined) delete host[key];
			else host[key] = value;
		}
	});

	const project = { name: "proj", settings: {} } as unknown as ProjectView;

	/** Mount LogView with a mocked fetch that records every log URL and serves one chunk. */
	async function mountLogView(props: {
		startedAt: number;
		logOffset?: number | null;
	}): Promise<{ urls: string[]; unmount: () => Promise<void> }> {
		const urls: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/log?")) {
				urls.push(url);
				const res = new Response("chunk", {
					headers: { "X-Log-Size": String(5) },
				});
				return res;
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		await act(async () => {
			root.render(<LogView project={project} taskId="t1" {...props} />);
		});
		return {
			urls,
			unmount: async () => {
				await act(async () => {
					root.unmount();
				});
				container.remove();
				globalThis.fetch = realFetch;
			},
		};
	}

	test("with logOffset set, the first fetch starts at the turn's byte offset", async () => {
		const { urls, unmount } = await mountLogView({
			startedAt: 1_000,
			logOffset: 4096,
		});
		try {
			expect(urls[0]).toContain("/tasks/t1/log?from=4096");
		} finally {
			await unmount();
		}
	});

	test("with logOffset absent, the first fetch starts at 0", async () => {
		const { urls, unmount } = await mountLogView({ startedAt: 1_000 });
		try {
			expect(urls[0]).toContain("/tasks/t1/log?from=0");
		} finally {
			await unmount();
		}
	});

	test("with logOffset null, the first fetch starts at 0", async () => {
		const { urls, unmount } = await mountLogView({
			startedAt: 1_000,
			logOffset: null,
		});
		try {
			expect(urls[0]).toContain("/tasks/t1/log?from=0");
		} finally {
			await unmount();
		}
	});
});

describe("reuseCards", () => {
	const frame = (tasks: TaskCard[]): StateResponse =>
		({ tasks }) as unknown as StateResponse;

	test("an unchanged card keeps its object, a changed card gets the new one", () => {
		const a = cardFixture({ id: "a1", title: "Alpha" });
		const b = cardFixture({ id: "b1", title: "Beta" });
		const b2 = { ...b, summary: "update" };
		const merged = reuseCards(frame([a, b]), frame([a, b2]));
		expect(merged.tasks[0]).toBe(a);
		expect(merged.tasks[1]).toBe(b2);
	});

	test("a frame that changes no card keeps the cards and the tasks array", () => {
		const a = cardFixture({ id: "a1" });
		const b = cardFixture({ id: "b1" });
		const prev = frame([a, b]);
		// The server re-serializes every frame: fresh objects, equal content. The
		// cards and the array keep their identity; the state itself is the new frame.
		const merged = reuseCards(prev, frame([{ ...a }, { ...b }]));
		expect(merged).not.toBe(prev);
		expect(merged.tasks).toBe(prev.tasks);
		expect(merged.tasks[0]).toBe(a);
	});

	test("a frame that moves only non-task fields still reaches the UI", () => {
		const a = cardFixture({ id: "a1" });
		const prev = { tasks: [a], quota: null } as unknown as StateResponse;
		const next = {
			tasks: [{ ...a }],
			quota: { provider: "p" },
		} as unknown as StateResponse;
		const merged = reuseCards(prev, next);
		expect(merged.quota).toBe(next.quota);
		expect(merged.tasks[0]).toBe(a);
	});

	test("a card the frame drops is a change even when the rest are equal", () => {
		const a = cardFixture({ id: "a1" });
		const b = cardFixture({ id: "b1" });
		const prev = frame([a, b]);
		const merged = reuseCards(prev, frame([{ ...a }]));
		expect(merged).not.toBe(prev);
		expect(merged.tasks).toHaveLength(1);
	});

	test("a server field gained or lost counts as a change", () => {
		const plain = cardFixture({ id: "a1" });
		const withHold = cardFixture({ id: "a1", pushHold: true });
		const prev = frame([plain]);
		expect(reuseCards(prev, frame([withHold]))).not.toBe(prev);
		expect(reuseCards(frame([withHold]), frame([{ ...plain }]))).not.toBe(
			frame([withHold]),
		);
	});
});

describe("boardFlipSig", () => {
	const t = (id: string, stage: TaskCard["stage"]): TaskCard =>
		cardFixture({ id, stage });

	test("a frame with the same cards and stages keeps the signature", () => {
		expect(boardFlipSig([t("a", "todo")])).toBe(boardFlipSig([t("a", "todo")]));
	});

	test("a stage change or a new card changes the signature", () => {
		expect(boardFlipSig([t("a", "todo")])).not.toBe(
			boardFlipSig([t("a", "in_progress")]),
		);
		expect(boardFlipSig([t("a", "todo")])).not.toBe(
			boardFlipSig([t("a", "todo"), t("b", "todo")]),
		);
	});
});

describe("memoized Card renders", () => {
	// React interaction needs browser globals; the setup mirrors the drawer
	// describes: happy-dom registers them for this describe, and afterAll puts
	// the originals back, so later test files in the same process see no DOM.
	const window = new Window({ url: "http://localhost/" });
	const host = globalThis as unknown as Record<string, unknown>;
	const browserGlobals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
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

	// The callbacks the production board also keeps stable (App's openTask is a
	// useCallback): fresh closures per render would break the memo in the test itself.
	const stable = {
		open: (): void => {},
		unread: (): boolean => false,
		onReorder: async (): Promise<boolean> => true,
	};
	const laneProps = (tasks: TaskCard[], projectTasks: TaskCard[]) => ({
		stage: "todo" as const,
		tasks,
		projectTasks,
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: stable.open,
		unread: stable.unread,
		onReorder: stable.onReorder,
		filtering: false,
		draining: false,
	});

	test("a state push that changes one card does not re-render the unchanged card", async () => {
		const realFetch = globalThis.fetch;
		// Card's model catalog fetch degrades to no catalog on a failed response.
		globalThis.fetch = (async () =>
			new Response("{}", { status: 404 })) as unknown as typeof fetch;
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const frame = (tasks: TaskCard[]): StateResponse =>
			({ tasks }) as unknown as StateResponse;
		let renders = 0;
		try {
			const a = cardFixture({
				id: "a1",
				title: "Alpha",
				state: "running",
				progress: "10%",
			});
			const b = cardFixture({ id: "b1", title: "Beta", state: "queued" });
			const renderLane = async (tasks: TaskCard[]): Promise<void> => {
				await act(async () => {
					root.render(<LaneCol {...laneProps(tasks, tasks)} tick={0} />);
				});
			};
			cardRenderProbe.fn = (): void => {
				renders += 1;
			};
			await renderLane([a, b]);
			// First paint: each card renders, then once more when the model catalog
			// lands (useModels sets the fetched catalog after mount; the fetch here
			// answers 404, which degrades to an empty catalog).
			const afterMount = renders;
			expect(afterMount).toBe(4);
			// A frame that changes only Alpha: Beta's card object survives the
			// merge, so Beta's memoized Card skips its render.
			const a2 = { ...a, progress: "50%" };
			const merged = reuseCards(frame([a, b]), frame([a2, b]));
			expect(merged.tasks[0]).toBe(a2);
			expect(merged.tasks[1]).toBe(b);
			await renderLane(merged.tasks);
			expect(renders).toBe(afterMount + 1);
			expect(container.textContent).toContain("50%");
			// A frame with equal content but fresh objects changes nothing: the merge
			// keeps the cards and the tasks array, so no card re-renders.
			const same = reuseCards(merged, frame([{ ...a2 }, { ...b }]));
			expect(same.tasks).toBe(merged.tasks);
			expect(same.tasks[1]).toBe(b);
			await renderLane(same.tasks);
			expect(renders).toBe(afterMount + 1);
			// A frame that changes Beta re-renders Beta, and still not Alpha.
			const b2 = { ...b, title: "Beta 2" };
			const merged2 = reuseCards(merged, frame([a2, b2]));
			expect(merged2.tasks[0]).toBe(a2);
			await renderLane(merged2.tasks);
			expect(renders).toBe(afterMount + 2);
			expect(container.textContent).toContain("Beta 2");
		} finally {
			cardRenderProbe.fn = null;
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		}
	});
});

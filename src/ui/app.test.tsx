import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	PerfMetrics,
	PerfStat,
	ProjectView,
	TaskCard,
	UpdateRow,
} from "../types.ts";

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
	doneTopicPages,
	cancelledTopic,
	Overview,
	KpiStrip,
	PerfTable,
	coveredUpdateIds,
	recommendsSteps,
	serverLine,
	gateAfterLostSession,
	setupHints,
	reportHtml,
	Drawer,
} = await import("./app.tsx");
const { monogram, sourceIconUrl, ProjectLogo, windowGone } = await import(
	"./kit.tsx"
);
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
		label?: string;
		resetsAt?: number | null;
	}) => ({
		provider: "p",
		label: o.label ?? "x",
		window: o.window ?? null,
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
	test("unknown length or reset gives null; a past reset clamps to 100", () => {
		expect(windowGone(lim({ label: "Monthly" }), now)).toBeNull();
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
		expect(html).toContain(">in progress</button>");
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

const cardFixture = (over: Partial<TaskCard>): TaskCard =>
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
		groups: null,
		collapsed: {},
		onToggle: () => {},
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: () => {},
		unread: () => false,
		onReorder: async () => {},
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
		expect(html).toContain(">zai/glm-5.3-flash</span>");
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
		expect(pin).toContain(">a/big</span>");
		expect(pin).toContain('title="Main loop model: a/big"');
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

	test("the topic view puts a Show more button in each topic that hides cards", () => {
		const t1 = cardFixture({ id: "t1", stage: "done", state: "idle" });
		const t2 = cardFixture({ id: "t2", stage: "done", state: "idle" });
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={[t1, t2]}
				more={0}
				groups={[
					{ key: "a", label: "Alpha", tasks: [t1], hidden: 7 },
					{ key: "b", label: "Beta", tasks: [t2], hidden: 0 },
				]}
				onTopicMore={() => {}}
			/>,
		);
		expect(html.match(/lane-more/g)?.length).toBe(1);
		// Every topic head reads loaded/total, a fully loaded topic too.
		expect(html).toContain(">1/8</span>");
		expect(html).toContain(">1/1</span>");
		expect(html).toContain(">7</span>");
	});

	test("each topic pages its newest cards, Everything else by landing time too", () => {
		// 11 named topics: the smallest overflows into Everything else ahead of the
		// unclassified cards, though the unclassified cards landed later.
		const tasks: TaskCard[] = [];
		for (let i = 0; i < 10; i++)
			for (let j = 0; j < 3; j++)
				tasks.push(
					cardFixture({ id: `n${i}-${j}`, topic: `topic${i}`, doneAt: 1000 }),
				);
		for (let j = 0; j < 2; j++)
			tasks.push(cardFixture({ id: `old${j}`, topic: "overflow", doneAt: j }));
		for (let j = 0; j < 25; j++)
			tasks.push(cardFixture({ id: `new${j}`, topic: null, doneAt: 500 - j }));
		const other = doneTopicPages(tasks, new Map()).at(-1)!;
		expect(other.key).toBe("");
		expect(other.tasks.map((t) => t.id)).toEqual(
			Array.from({ length: 20 }, (_, j) => `new${j}`),
		);
		expect(other.hidden).toBe(7);
		const grown = doneTopicPages(tasks, new Map([["", 40]])).at(-1)!;
		expect(grown.tasks.at(-1)!.id).toBe("old0");
		expect(grown.hidden).toBe(0);
	});

	test("Show more on Everything else leaves a topic named other alone", () => {
		const tasks = [
			...Array.from({ length: 25 }, (_, j) =>
				cardFixture({ id: `o${j}`, topic: "other", doneAt: j }),
			),
			...Array.from({ length: 25 }, (_, j) =>
				cardFixture({ id: `u${j}`, topic: null, doneAt: j }),
			),
		];
		const before = doneTopicPages(tasks, new Map());
		const rest = before.find((g) => g.label === "Everything else")!;
		const pages = doneTopicPages(tasks, new Map([[rest.key, 40]]));
		expect(pages.find((g) => g.label === "other")!.tasks).toHaveLength(20);
		expect(
			pages.find((g) => g.label === "Everything else")!.tasks,
		).toHaveLength(25);
	});

	test("a topic named constructor still pages", () => {
		const tasks = Array.from({ length: 25 }, (_, j) =>
			cardFixture({ id: `c${j}`, topic: "constructor", doneAt: j }),
		);
		const [g] = doneTopicPages(tasks, new Map());
		expect(g!.tasks).toHaveLength(20);
		expect(g!.hidden).toBe(5);
	});

	test("a running card's mutation meter reads the tool-neutral label", () => {
		const run = cardFixture({
			id: "m1",
			stage: "in_progress",
			state: "running",
			progress:
				"Stryker 68% · 4454/6523 · 38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left",
		});
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="in_progress" tasks={[run]} />,
		);
		expect(html).toContain("Mutation testing");
		expect(html).toContain("card-mutation");
		expect(html).toContain("mutation-stats");
		// The stats tail keeps the tool's own words; the raw line stays on the row's title.
		expect(html).toContain("38 survived (0.9%)");
		expect(html).toContain('title="Stryker 68%');
		expect(html).not.toContain(">Stryker<");
		expect(html).not.toContain("card-stryker");
	});
});

describe("done lane star section", () => {
	const base = {
		projectTasks: [] as TaskCard[],
		groups: null,
		collapsed: {},
		onToggle: () => {},
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: () => {},
		unread: () => false,
		onReorder: async () => {},
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

	test("the Starred section sits below Unread and above normal done cards", () => {
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
		const unreadAt = html.indexOf(">Unread</p>");
		const starredAt = html.indexOf(">Starred</span>");
		const normalAt = html.indexOf('data-task-id="n1"');
		expect(unreadAt).toBeGreaterThanOrEqual(0);
		expect(starredAt).toBeGreaterThan(unreadAt);
		expect(normalAt).toBeGreaterThan(starredAt);
		// The starred card left the normal list.
		expect(html.match(/data-task-id="s1"/g)?.length).toBe(1);
	});

	test("no Starred section renders without a starred card", () => {
		const normal = cardFixture({ id: "n1", stage: "done", state: "idle" });
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="done" tasks={[normal]} />,
		);
		expect(html).not.toContain(">Starred</span>");
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
			<LaneCol
				{...base}
				stage="done"
				tasks={[starredCard]}
				collapsed={{ starred: true }}
			/>,
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
		// One rule between Unread and Starred, one between Starred and the rest.
		expect(open.match(/lane-divider/g)?.length).toBe(2);
		const shut = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={tasks}
				unread={(t) => t.id === "u1"}
				collapsed={{ starred: true }}
			/>,
		);
		// The head's own border-bottom replaces the vanished trailing rule.
		expect(shut.match(/lane-divider/g)?.length).toBe(1);
		expect(shut.indexOf("lane-divider")).toBeLessThan(
			shut.indexOf(">Starred</span>"),
		);
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
		expect(alateChip("http://a", true, ok, null)).toEqual({
			label: "Connected",
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
		expect(setupHints({ server: null, workers: [] }, null)).toEqual([
			{ text: "Agent server: not configured.", kind: "warn" },
		]);
		expect(
			setupHints(
				{ server: { ...server, lastError: "boom" }, workers: [] },
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
		expect(setupHints({ server, workers: [] }, null)).toEqual([]);
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
		onOpenDiff: () => {},
		onAnswer: () => {},
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

	test("a saved multi answer re-checks its presets and counts them", () => {
		const html = renderToStaticMarkup(
			<AskBlock {...base} q={multiQ} answered selected="A, B" />,
		);
		// Both picked presets render checked; the custom row's checkbox stays unchecked.
		expect(html.split('checked=""').length - 1).toBe(2);
		expect(html).toContain("(2)");
		expect(html).toContain("Replace answer");
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
		expect(html).toContain(text);
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
});

describe("settings TOC", () => {
	test("groups and sections follow the contract order", () => {
		expect(SETTINGS_TOC.map((g) => g.label)).toEqual([
			"Board",
			"Access",
			"Git and secrets",
			"Agents",
		]);
		expect(SETTINGS_TOC.map((g) => g.sections.map((s) => s.label))).toEqual([
			["Runners", "Push notifications"],
			["API key", "Session"],
			["Git hosts", "Env"],
			["Provider sign-in", "Model roles", "Alate", "Hindsight"],
		]);
	});
	test("General page renders each id once, one h1, TOC in order, no GitHub card title", () => {
		const html = renderToStaticMarkup(
			<SettingsPage
				projects={[]}
				tasks={[]}
				maxTotal={null}
				reviewCheck={false}
				workCheck={false}
				idleReviews={true}
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
		expect(tocLabels).toEqual(
			SETTINGS_TOC.flatMap((g) => [
				g.label,
				...g.sections.flatMap((s) => [
					s.label,
					...blocks(s).map((b) => b.label),
				]),
			]),
		);
		expect(html).not.toMatch(/<h[23][^>]*>GitHub<\/h[23]>/);
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
		read: false,
		onMarkUnread: () => {},
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
		read: false,
		onMarkUnread: () => {},
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};

	test("a foreign parent renders as a button naming its project", () => {
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
		read: true,
		onMarkUnread: () => {},
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
			state: "idle",
			prompt: "fix the `align` flow",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('class="task-prompt"');
		expect(html).toContain("<code>align</code>");
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
		read: true,
		onMarkUnread: () => {},
		tasks: [],
		onOpenTask: () => {},
		draining: false,
		usedTotal: 0,
		maxTotal: null,
	};

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
});

describe("cancelled cards on the board", () => {
	const base = {
		projectTasks: [] as TaskCard[],
		groups: null,
		collapsed: {},
		onToggle: () => {},
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: () => {},
		unread: () => false,
		onReorder: async () => {},
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

	test("a cancelled card never joins the Starred section or the Unread lane", () => {
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
		expect(html).not.toContain("Unread");
		expect(html).not.toContain("Starred");
		expect(html).toContain('data-task-id="s1"');
		// The star never replaces the cancelled x, not even on a starred card.
		expect(html).toContain("mark-cancelled");
		expect(html).not.toContain("mark-star");
	});

	test("the topic view lists cancelled cards in a Cancelled section, outside every topic", () => {
		const done = cardFixture({
			id: "t1",
			stage: "done",
			state: "idle",
			topic: "Cut",
		});
		const dead = cardFixture({
			id: "d1",
			stage: "done",
			state: "idle",
			cancelledAt: 1000,
		});
		const groups = [
			...doneTopicPages([done], new Map()),
			...cancelledTopic([done, dead], new Map()),
		];
		const html = renderToStaticMarkup(
			<LaneCol
				{...base}
				stage="done"
				tasks={[done, dead]}
				groups={groups}
				onTopicMore={() => {}}
			/>,
		);
		expect(html).toContain("Cut");
		// The cancelled card's null topic must not open an Everything else section.
		expect(html).not.toContain("Everything else");
		expect(html).toContain('data-task-id="d1"');
		// Both sections count their own card only.
		expect(html.match(/>1\/1<\/span>/g)?.length).toBe(2);
	});

	test("cancelledTopic pages its section and stays empty without cancelled cards", () => {
		const dead = cardFixture({
			id: "d1",
			stage: "done",
			state: "idle",
			cancelledAt: 1000,
		});
		const fresh = cardFixture({ id: "t1", stage: "done", state: "idle" });
		expect(cancelledTopic([fresh], new Map())).toEqual([]);
		const page = cancelledTopic([dead], new Map());
		expect(page).toHaveLength(1);
		expect(page[0]!.key).toBe("__cancelled");
		expect(page[0]!.label).toBe("Cancelled");
		expect(page[0]!.tasks.map((t) => t.id)).toEqual(["d1"]);
		// A grown limit stops the paging: no hidden cards, no Show more.
		const grown = cancelledTopic([dead], new Map([["__cancelled", 40]]));
		expect(grown[0]!.hidden).toBe(0);
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
			/>,
		);
		// The project row's stage cells in column order: the cancelled card leaves
		// In progress empty and lands in Done, like the board lanes show it.
		const body = /<tbody>[\s\S]*<\/tbody>/.exec(html)![0]!;
		const cells = [...body.matchAll(/<td[^>]*>(\d+)<\/td>/g)].map((m) => m[1]);
		expect(cells).toEqual(["1", "0", "0", "1"]);
		// Last activity counts the cancel stamp: updateTask bumps updated_at, so the
		// cell shows a relative time instead of the empty dash.
		const ageCell = /<td class="age">([^<]*)<\/td>/.exec(body)![1]!;
		expect(ageCell).not.toBe("–");
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
		read: true,
		onMarkUnread: () => {},
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
});

describe("LaneCol release hold", () => {
	const base = {
		groups: null,
		collapsed: {},
		onToggle: () => {},
		hasRules: true,
		github: null,
		deltas: new Map<string, number>(),
		open: () => {},
		unread: () => false,
		onReorder: async () => {},
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

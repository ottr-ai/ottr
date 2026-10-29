import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskCard, UpdateRow } from "../types.ts";

// app.tsx reads sessionStorage at module load; bun test has no browser storage.
globalThis.sessionStorage = {
	length: 0,
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {},
	clear: () => {},
	key: () => null,
} as Storage;
// A static import cannot work: ESM hoists it, so app.tsx evaluates before the stub above exists.
const {
	UpdateRowLine,
	visibleUpdateRows,
	LaneCol,
	alateHint,
	monogram,
	sourceIconUrl,
	AskBlock,
	triageWait,
	provisionWatchStep,
	ALATE_WATCH_MAX_DOWN,
	ALATE_WATCH_DEADLINE_MS,
	WarningLines,
	SETTINGS_TOC,
	SettingsPage,
} = await import("./app.tsx");

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
	test("a removed row shows 'Removed upstream' with Skip and no pick", () => {
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
		expect(html).toContain("Replace");
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
			["Runners", "Push"],
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
				act={async () => true}
				view="settings"
			/>,
		);
		const ids = SETTINGS_TOC.flatMap((g) => [
			g.id,
			...g.sections.map((s) => s.id),
		]);
		for (const id of ids) expect(html.split(`id="${id}"`).length - 1).toBe(1);
		for (const id of ["signin-section", "model-roles-section", "alate-section"])
			expect(html).toContain(`id="${id}"`);
		expect(html.split("<h1").length - 1).toBe(1);
		const nav =
			html.match(/<nav[^>]*class="[^"]*settings-nav[\s\S]*?<\/nav>/)?.[0] ?? "";
		const tocLabels = [
			...nav.matchAll(/class="toc-(?:group|item)"[^>]*>([^<]*)<\/button>/g),
		].map((m) => m[1]);
		expect(tocLabels).toEqual(
			SETTINGS_TOC.flatMap((g) => [g.label, ...g.sections.map((s) => s.label)]),
		);
		expect(html).not.toMatch(/<h[23][^>]*>GitHub<\/h[23]>/);
	});
});

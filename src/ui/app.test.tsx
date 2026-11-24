import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeepenCheck } from "../deepen.ts";
import { DEEPEN_POINTS } from "../prompts.ts";
import { parseUsage } from "../quota.ts";
import { FINDINGS_HOLD } from "../scheduler.ts";
import fc from "../test/properties.ts";
import type {
	PerfMetrics,
	PerfStat,
	ProjectView,
	ProposalSummary,
	PrReviewView,
	PrRunState,
	ReleasePlan,
	ServiceQuotaMetric,
	ServiceQuotaSourceState,
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
	newestLanded,
	PR_REVIEW_WAITING,
	UPDATE_HOLD_REASON,
} from "../types.ts";
import type { Act } from "./kit.tsx";
// Static: models.ts touches no browser global at load, so hoisting is safe.
import { resetCatalogCache } from "./models.ts";
// Static: notify.ts reads localStorage only when called, never at load.
import { loadAskDrafts, saveAskDraft } from "./notify.ts";
import { ServiceQuotas } from "./serviceQuotas.tsx";
// Static: status.ts touches no browser global at load.
import { bellAlarms } from "./status.ts";
import {
	installBrowserGlobals,
	mount,
	onChangeOf,
	onClickOf,
	stubFetch,
} from "./testDom.tsx";
import { stamp } from "./time.ts";

// app.tsx reads sessionStorage at module load; bun test has no browser storage.
globalThis.sessionStorage = {
	length: 0,
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {},
	clear: () => {},
	key: () => null,
} as Storage;

/** The ProjectBoard tests' shared project fixture; doneTotal is the only
 * field the board tests vary. */
const boardProject = (doneTotal: number): ProjectView =>
	({
		name: "proj",
		hasRules: true,
		github: null,
		gitless: false,
		dirty: false,
		archReview: null,
		latestRelease: null,
		latestImage: null,
		doneTotal,
		settings: { setupChecklist: false },
		sessionsDir: "/tmp/s",
	}) as unknown as ProjectView;

/** Mounts a ProjectBoard with the props every board test passes unchanged. */
const mountProjectBoard = async (project: ProjectView, tasks: TaskCard[]) =>
	await mount(
		<ProjectBoard
			project={project}
			tasks={tasks}
			deltas={new Map()}
			open={() => {}}
			seenAnswers={new Set()}
			seenDoneSince={0}
			compose={() => {}}
			composeDraft={() => {}}
			act={async (fn: () => Promise<void>) => {
				await fn();
				return true;
			}}
			onNotice={() => {}}
			draining={false}
		/>,
	);

/** Builds the native-value setter used to type into happy-dom inputs; each
 * describe binds it to its own window. */
const typeIntoFor =
	(window: Window) =>
	(el: HTMLInputElement, value: string): void => {
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		if (setter === undefined) throw new Error("value setter missing");
		setter.call(el, value);
	};

// LaneCol props every lane describe passes unchanged.
const laneColBase = {
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

/** The happy-dom globals the client-side drawer describes mount under. */
const installDrawerClientGlobals = () =>
	installBrowserGlobals([
		"Event",
		"HTMLElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

/** Parse static markup in a fresh happy-dom document for DOM queries. */
const parseMarkup = (html: string) => {
	const document = new Window({ url: "http://localhost/" }).document;
	document.body.innerHTML = html;
	return document;
};

type DrawerRunArgs = {
	posts: { url: string; body: unknown }[];
	container: HTMLDivElement;
	root: ReturnType<typeof createRoot>;
};

/** Mounts the drawer for `card` under a fetch stub that records the POSTs to
 * `route` and answers them with `respond`, serves the detail row for the card
 * back loaded (OTTR-965: the prompt rides only on the task route), and 404s
 * everything else. One more act lets the detail fetch land before `run`. */
const withDrawerRoute = async (
	base: Parameters<typeof Drawer>[0],
	card: TaskCard,
	route: string,
	respond: { status: number; body: unknown },
	run: (args: DrawerRunArgs) => Promise<void>,
	projectView?: ProjectView,
): Promise<void> => {
	const posts: { url: string; body: unknown }[] = [];
	const { restore } = stubFetch(async (url, init) => {
		const u = String(url);
		if (u.endsWith(route)) {
			posts.push({
				url: u,
				body: JSON.parse(String(init?.body)) as unknown,
			});
			return new Response(JSON.stringify(respond.body), {
				status: respond.status,
			});
		}
		if (u.endsWith(`/tasks/${card.id}`)) {
			return new Response(JSON.stringify({ ...card, turns: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("{}", { status: 404 });
	});
	const { container, root, unmount } = await mount(
		<Drawer
			{...base}
			task={card}
			{...(projectView === undefined ? {} : { project: projectView })}
		/>,
	);
	try {
		// One more act lets the detail fetch land before the run callback queries.
		await act(async () => {});
		await run({ posts, container, root });
	} finally {
		await unmount();
		restore();
	}
};
// A static import cannot work: ESM hoists it, so the modules evaluate before the stub above exists.
const {
	App,
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
	appNoticeKeys,
	implementSteps,
	recommendsSteps,
	serverLine,
	gateAfterLostSession,
	dropReasonDiag,
	pollTransportDiag,
	setupHints,
	reportHtml,
	shortNoticeText,
	Drawer,
	AppDrawer,
	LogView,
	ProjectBoard,
	RailRows,
	SEARCH_APPLY_MS,
	ComposeDialog,
	ConsolidationReview,
	FollowUpDialog,
	DeepenReview,
	ReleaseDialog,
	AddProjectModal,
	draftGithubSource,
	OrphanNotice,
	SeedFailedLine,
	ProvisionErrorLine,
	SetupChecklist,
	ranOnLabel,
	AuthPage,
	PrReviewSection,
	boardFlipSig,
	cardRenderProbe,
	reuseCards,
	skillGapNote,
	appInboxMeta,
	AppInboxBell,
	AppInboxPanel,
	HoldResumeButton,
	CreditsChip,
	SystemBar,
} = await import("./app.tsx");
const {
	monogram,
	repoSlug,
	sourceIconUrl,
	ProjectLogo,
	ProjectTag,
	windowGone,
	windowPace,
	modelPace,
} = await import("./kit.tsx");
const {
	alateChip,
	alateHint,
	provisionWatchStep,
	ALATE_WATCH_MAX_DOWN,
	ALATE_WATCH_DEADLINE_MS,
	SETTINGS_TOC,
	SettingsPage,
	HostedContext,
} = await import("./settings.tsx");

describe("draftGithubSource", () => {
	test("source capability requires the exact configured GitHub host", () => {
		expect(draftGithubSource("https://github.com/o/r.git", "github.com")).toBe(
			true,
		);
		expect(draftGithubSource("git@github.com:o/r.git", "github.com")).toBe(
			true,
		);
		for (const source of [
			"https://github.com.evil.test/o/r.git",
			"https://github.com@evil.test/o/r.git",
			"https://evil.test/github.com/r.git",
			"git@github.com.evil.test:o/r.git",
			"not a remote",
		]) {
			expect(draftGithubSource(source, "github.com")).toBe(false);
		}
	});

	test("generated source hosts cannot gain GitHub capability through a suffix", () => {
		const hostLabel = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), {
				minLength: 1,
				maxLength: 20,
			})
			.map((characters) => characters.join(""));
		fc.assert(
			fc.property(hostLabel, (label) => {
				const host = `${label}.example.test`;
				for (const source of [
					`https://${host}/o/r.git`,
					`git@${host}:o/r.git`,
				]) {
					expect(draftGithubSource(source, host)).toBe(true);
					expect(draftGithubSource(source, `${host}.other.test`)).toBe(false);
				}
				expect(
					draftGithubSource(`https://${host}.other.test/o/r.git`, host),
				).toBe(false);
			}),
		);
	});
});

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

describe("appNoticeKeys upstream updates", () => {
	test("skips a hands-off project's rows, keeps rows a person must file and removed rows", () => {
		const row = (id: string, project: string | null, over = {}) => ({
			id,
			project,
			target: "v2",
			...over,
		});
		const state = {
			projects: [
				{ name: "auto", settings: { holdUpdateMerges: false } },
				{ name: "manual", settings: { holdUpdateMerges: true } },
			],
			updates: {
				checkedAt: "x",
				rows: [
					row("a@2", "auto"), // the board files it
					row("m@2", "manual"),
					row("u@2", null), // no project: a person maps or skips it
					row("young@3", "manual", { target: null }),
					row("gone@1", "auto", { target: null, removed: true }),
					row("covered@2", "manual"),
				],
			},
		} as unknown as StateResponse;
		const covered = new Map([["covered@2", {} as TaskCard]]);
		const keys = appNoticeKeys(
			state,
			covered,
			null,
			null,
			false,
			0,
			null,
			null,
			false,
			[],
			null,
			{ held: 0, stale: 0 } as StateResponse["keptWorktrees"],
			0,
		);
		expect(keys.updateIds).toEqual(["m@2", "u@2", "gone@1"]);
	});
});

describe("windowPace", () => {
	const H = 3_600_000;
	const now = 1_000 * H;
	const lim = (usedPct: number, resetsAt: number | null) => ({
		provider: "p",
		label: "x",
		window: "7d",
		windowLabel: null,
		plan: null,
		usedPct,
		resetsAt,
	});
	test("names the lead or lag of the quota against the window's clock", () => {
		// 7d window, 84h left: half the time gone.
		expect(windowPace(lim(75, now + 84 * H), now)).toEqual({
			label: "1d 18h ahead",
			pace: "ahead",
		});
		expect(windowPace(lim(25, now + 84 * H), now)).toEqual({
			label: "1d 18h behind",
			pace: "behind",
		});
		expect(windowPace(lim(50, null), now)).toBeNull();
	});
	test("holds 'on pace' inside the 30 minute deadzone, not past it", () => {
		// 7d = 168h; 1 point = 1.68h. 0.25 points = 25.2m (inside), 0.5 points = 50.4m (outside).
		expect(windowPace(lim(50.25, now + 84 * H), now)?.pace).toBe("on");
		expect(windowPace(lim(49.75, now + 84 * H), now)?.pace).toBe("on");
		expect(windowPace(lim(50.5, now + 84 * H), now)?.pace).toBe("ahead");
		expect(windowPace(lim(49.5, now + 84 * H), now)?.pace).toBe("behind");
	});
});

describe("modelPace", () => {
	const H = 3_600_000;
	const now = 1_000 * H;
	const lim = (
		provider: string,
		window: string,
		usedPct: number,
		resetsAt: number,
	) => ({
		provider,
		label: window,
		window,
		windowLabel: null,
		plan: null,
		usedPct,
		resetsAt,
	});
	test("a used-up window wins and names when the provider is back", () => {
		const limits = [
			lim("openai-codex", "5h", 12, now + 4 * H),
			lim("openai-codex", "7d", 100, now + 2 * H),
		];
		expect(modelPace(limits, "openai-codex/gpt-6-sol", now)).toEqual({
			label: "limit · back in 2h 0m",
			pace: "full",
		});
	});
	test("otherwise the window furthest ahead of its clock, only for the model's provider", () => {
		const limits = [
			// 5h, 1h left: 80 % of the time gone, 42 % used → 38 points behind.
			lim("anthropic", "5h", 42, now + H),
			// 7d, 84h left: 50 % gone, 81 % used → 31 points ahead.
			lim("anthropic", "7d", 81, now + 84 * H),
			lim("openai-codex", "7d", 100, now + 2 * H),
		];
		expect(modelPace(limits, "anthropic/claude-sonnet-5-5", now)?.pace).toBe(
			"ahead",
		);
		expect(modelPace(limits, "ollama/llama", now)).toBeNull();
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
		Partial<
			Pick<
				Task,
				"details" | "gate" | "prompt" | "report" | "summary" | "workCheckLog"
			>
		> & {
			prReview?: PrReviewView;
		},
): TaskCard =>
	({
		id: "t1",
		title: "Task one",
		sessionTitle: "Task one",
		project: "proj",
		state: "queued",
		stage: "todo",
		cancelledAt: null,
		createdAt: 0,
		doneAt: null,
		dependsOn: [],
		// The Drawer body iterates these card arrays before the detail fetch
		// lands; every TaskCard carries them on the wire (OTTR-965), so the
		// fixture does too.
		images: [],
		pendingImages: [],
		shots: [],
		keptFiles: [],
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

// Shared Drawer render fixtures. The drawer describes below repeated these
// verbatim; each describe now references one hoisted copy and never mutates
// it (describes that override fields spread instead).
const drawerProject = {
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
// Props every Drawer fixture shares; the named bases spread it and add the
// fields that differ.
const drawerBaseCore = {
	act: async () => true,
	onClose: () => {},
	onFollowed: () => {},
	projects: [],
	onMarkUnread: () => {},
	onMarkSeen: () => {},
	draining: false,
	usedTotal: 0,
	maxTotal: null,
};
const drawerBase = {
	task: null as never,
	project: drawerProject,
	...drawerBaseCore,
	read: true,
	tasks: [],
	onOpenTask: () => {},
};

// The text AskBlock question fixture, shared by the AskBlock describes.
const textQ = {
	question: "Name the branch",
	options: [],
	multi: false,
	recommended: null,
	text: true,
};

// Shared board-list Drawer fixtures (same story as drawerProject above).
const listChildCard = (over: Partial<TaskCard>): TaskCard =>
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
const listProject = {
	name: "proj",
	hasRules: true,
	github: null,
	sessionsDir: "/tmp/sessions",
	settings: { maxParallel: 1 },
} as unknown as ProjectView;
const listBaseReadonly = {
	project: listProject,
	...drawerBaseCore,
	read: false,
	onOpenTask: () => {},
};
const listBaseRead = {
	project: listProject,
	...drawerBaseCore,
	read: true,
	tasks: [],
	onOpenTask: () => {},
};

describe("LaneCol backlog divider", () => {
	const base = laneColBase;

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
		expect(html).not.toContain("No drafts yet.");
	});

	test("an empty backlog shows a placeholder", () => {
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="todo" tasks={[]} parked={[]} parkedTotal={0} />,
		);
		expect(html).toContain("Backlog");
		expect(html).toContain("No drafts yet.");
		expect(html).toContain("Nothing waiting.");
	});

	test("a backlog filtered to nothing shows no empty placeholder", () => {
		const html = renderToStaticMarkup(
			<LaneCol {...base} stage="todo" tasks={[]} parked={[]} parkedTotal={3} />,
		);
		expect(html).not.toContain("No drafts yet.");
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
	const base = laneColBase;

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

	// The Starred-section fixtures: one fresh answered card, one starred
	// research card, one plain done card.
	const starredTrio = () => ({
		freshCard: cardFixture({
			id: "u1",
			stage: "done",
			state: "idle",
			answered: true,
		}),
		starredCard: cardFixture({
			id: "s1",
			stage: "done",
			state: "idle",
			research: true,
			starred: true,
		}),
		normal: cardFixture({ id: "n1", stage: "done", state: "idle" }),
	});

	test("the Starred section sits below Inbox and above normal done cards", () => {
		const { freshCard, starredCard, normal } = starredTrio();
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
		const { freshCard, starredCard, normal } = starredTrio();
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

describe("dropReasonDiag", () => {
	test("the timeout reasons carry their seconds; error and close carry none", () => {
		expect(dropReasonDiag("connect-timeout")).toEqual({
			kind: "timeout",
			seconds: 5,
		});
		expect(dropReasonDiag("timeout")).toEqual({ kind: "timeout", seconds: 5 });
		expect(dropReasonDiag("watchdog")).toEqual({
			kind: "timeout",
			seconds: 15,
		});
		// An error/close proves nothing: the probe decides the reason class.
		expect(dropReasonDiag("error")).toBeNull();
		expect(dropReasonDiag("close")).toBeNull();
		expect(dropReasonDiag(undefined)).toBeNull();
	});

	test("a poll transport failure reads as timeout on the abort, network otherwise", () => {
		expect(pollTransportDiag("timeout", "localhost")).toEqual({
			kind: "timeout",
			seconds: 5,
		});
		expect(pollTransportDiag("error", "localhost")).toEqual({
			kind: "network",
			host: "localhost",
		});
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
		text: false,
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

	test("a long unbroken token wraps inside the ask panel instead of overflowing it", async () => {
		// VELV-286's question shape: a path and a jq filter without spaces, here with a
		// 300-character token as the worst case.
		const token = "x".repeat(300);
		const html = renderToStaticMarkup(
			<AskBlock
				{...base}
				q={{
					question: `Read repos/Skare69/velvarr/code-scanning/alerts/$n and reply per error type after ${token}.`,
					options: [
						{
							label: "One card per rule id",
							description: `jq -c '.[] | {number,created_at,tool:.tool.name,rule:.rule.id,${token}}'`,
						},
					],
					multi: false,
					recommended: 0,
					text: false,
				}}
			/>,
		);
		// The wrap lives in app.css: load the stylesheet into the document the markup
		// parses under and read the rules off the rendered elements.
		const win = new Window({ url: "http://localhost/" });
		win.document.head.innerHTML = `<style>${await Bun.file(
			new URL("./app.css", import.meta.url),
		).text()}</style>`;
		win.document.body.innerHTML = html;
		const text = win.document.querySelector(".ask-text > span:first-of-type");
		if (text === null) throw new Error("the question span is missing");
		expect(text.textContent).toContain(token);
		const cs = win.getComputedStyle(text);
		// The span shrinks below its longest token and breaks it, and newlines stay breaks.
		expect(cs.minWidth).toBe("0");
		expect(cs.overflowWrap).toBe("anywhere");
		expect(cs.whiteSpace).toBe("pre-line");
		const desc = win.document.querySelector(".ask-desc");
		if (desc === null) throw new Error("the option description is missing");
		expect(win.getComputedStyle(desc).overflowWrap).toBe("anywhere");
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

	test("the Other field's placeholder stays neutral, never a suggested answer", () => {
		const html = renderToStaticMarkup(
			<AskBlock
				{...base}
				q={{
					question: "Which database?",
					options: [{ label: "Postgres" }],
					multi: false,
					recommended: null,
					text: false,
				}}
			/>,
		);
		expect(html).toContain('placeholder="Your answer"');
		// A fixed composer example would read as a suggested answer under a park question.
		expect(html).not.toContain("Deploy only the API");
	});

	test("a text question renders a labeled field and no choice controls", () => {
		const html = renderToStaticMarkup(<AskBlock {...base} q={textQ} />);
		expect(html).toContain('type="text"');
		expect(html).not.toContain('type="radio"');
		expect(html).not.toContain('type="checkbox"');
		// The field carries the question text as its label.
		expect(html).toContain('aria-label="Name the branch"');
		// Nothing typed: the Answer button stays disabled.
		expect(html).toContain("Answer");
		expect(html).toContain("disabled");
	});

	test("a saved text answer seeds the field and shows the answered state", () => {
		const html = renderToStaticMarkup(
			<AskBlock {...base} q={textQ} answered selected="release-branch" />,
		);
		expect(html).toContain('value="release-branch"');
		expect(html).toContain("Replace answer");
		expect(html).toContain('class="ask-q answered"');
	});
});

describe("AskBlock multi answers", () => {
	// React interaction needs browser globals; the same happy-dom swap as the
	// ProjectBoard search delay tests below: installed after app.tsx's import
	// (its browser mount guard reads document at module load), removed after.
	const { window } = installBrowserGlobals([
		"HTMLElement",
		"HTMLInputElement",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	const multiQ = {
		question: "Pick several",
		options: [{ label: "A", description: "first" }, { label: "B" }],
		multi: true,
		recommended: null,
		text: false,
	};

	/** The form-submit DOM event; happy-dom's Event class does not match lib.dom's. */
	const submitEvent = (): Event =>
		new window.Event("submit", {
			bubbles: true,
			cancelable: true,
		}) as unknown as Event;

	/** A React onChange picks up programmatic edits only through the native value setter (see settings.test.tsx). */
	const typeInto = typeIntoFor(window);

	/** The mounted AskBlock scaffolding both question kinds share: recorders,
	 * form and submit button. `q` picks the question; the probes differ per kind. */
	const mountAskBlock = async (q: typeof textQ | typeof multiQ) => {
		const answers: string[] = [];
		const drafts: (string | null)[] = [];
		function Block() {
			return (
				<AskBlock
					q={q}
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
		const { container } = await mount(<Block />);
		const form = container.querySelector("form") as unknown as HTMLFormElement;
		const button = container.querySelector(
			"button",
		) as unknown as HTMLButtonElement;
		if (form === null || button === null)
			throw new Error("ask block did not render its controls");
		return { container, answers, drafts, form, button };
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
		const base = await mountAskBlock(multiQ);
		const inputs = [
			...base.container.querySelectorAll("input"),
		] as unknown as HTMLInputElement[];
		const text = inputs.find((i) => i.type === "text");
		const checkboxes = inputs.filter((i) => i.type === "checkbox");
		const other = checkboxes[checkboxes.length - 1];
		if (text === undefined || other === undefined)
			throw new Error("ask block did not render its controls");
		return { ...base, text, other };
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

	/** One mounted text AskBlock; every onAnswer text lands in `answers`, every onDraft in `drafts`. */
	async function mountTextAsk(): Promise<{
		container: HTMLDivElement;
		answers: string[];
		drafts: (string | null)[];
		form: HTMLFormElement;
		text: HTMLInputElement;
		button: HTMLButtonElement;
	}> {
		const base = await mountAskBlock(textQ);
		const text = base.container.querySelector(
			'input[type="text"]',
		) as unknown as HTMLInputElement | null;
		if (text === null)
			throw new Error("text ask block did not render its controls");
		return { ...base, text };
	}

	test("a text block drafts as it types and answers the trimmed text on submit", async () => {
		const { answers, drafts, form, text, button } = await mountTextAsk();
		// Nothing typed: the button is disabled and a submit answers nothing.
		expect(button.disabled).toBe(true);
		await act(async () => {
			form.dispatchEvent(submitEvent());
		});
		expect(answers).toEqual([]);
		await act(async () => {
			typeInto(text, "  release-branch  ");
			onChangeOf(text)({ target: text, currentTarget: text });
		});
		// The draft rides the trimmed text; the button enables.
		expect(drafts).toEqual(["release-branch"]);
		expect(button.disabled).toBe(false);
		await act(async () => {
			form.dispatchEvent(submitEvent());
		});
		expect(answers).toEqual(["release-branch"]);
		// Emptying the field withdraws the draft and disables the button again.
		await act(async () => {
			typeInto(text, "");
			onChangeOf(text)({ target: text, currentTarget: text });
		});
		expect(drafts).toEqual(["release-branch", null]);
		expect(button.disabled).toBe(true);
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

describe("card links in bell text", () => {
	// Mirrors the panel's resolver: only ottr's ids resolve, foreign projects
	// and unknown ids stay text.
	const cardsCtx = {
		resolve: (id: string, project: string | null) => {
			if (project !== null && project !== "ottr") return null;
			return id === "OTTR-1071" || id === "OTTR-1070"
				? { project: "ottr", id }
				: null;
		},
		open: () => {},
	};
	const advisory =
		"agent-data main checkout changed while several cards were running (ottr#OTTR-1071, alate#ALAT-180): new commits abc1234 sync: add parallel-work check. No card was parked.";

	test("a project#id reference in a warning links; a foreign project's stays text", () => {
		const html = renderToStaticMarkup(
			<WarningLines warnings={[advisory]} cards={cardsCtx} />,
		);
		expect(html).toContain(
			'<a class="notif-link" data-card-link="1" href="/projects/ottr/tasks/OTTR-1071" title="Open card OTTR-1071">ottr#OTTR-1071</a>',
		);
		// alate is not a project the resolver knows: the reference stays text.
		expect(html).toContain("alate#ALAT-180");
		expect(html).not.toContain("alate#ALAT-180</a>");
	});

	test("project-prefixed, hash-only, and bare id forms all link", () => {
		const html = renderToStaticMarkup(
			<WarningLines
				warnings={[
					"Refs: ottr#OTTR-1071, #OTTR-1072 and OTTR-1073 were running",
				]}
				cards={{
					resolve: (id: string) => ({ project: "ottr", id }),
					open: () => {},
				}}
			/>,
		);
		expect(html).toContain('href="/projects/ottr/tasks/OTTR-1071"');
		expect(html).toContain('href="/projects/ottr/tasks/OTTR-1072"');
		expect(html).toContain('href="/projects/ottr/tasks/OTTR-1073"');
		// The anchor text keeps each form as written.
		expect(html).toContain(">ottr#OTTR-1071</a>");
		expect(html).toContain(">#OTTR-1072</a>");
		expect(html).toContain(">OTTR-1073</a>");
	});

	test("a commit sha after project# stays text", () => {
		const html = renderToStaticMarkup(
			<WarningLines
				warnings={["The image holds ottr#7f78beca while the board runs."]}
				cards={cardsCtx}
			/>,
		);
		expect(html).not.toContain("<a ");
		expect(html).toContain("ottr#7f78beca");
	});

	test("an unknown card id stays text", () => {
		const html = renderToStaticMarkup(
			<WarningLines
				warnings={["The run waits for ottr#OTTR-9999 to finish."]}
				cards={cardsCtx}
			/>,
		);
		expect(html).not.toContain("<a ");
		expect(html).toContain("ottr#OTTR-9999");
	});

	test("a bare known id in the restart line links; without cards the same text stays plain", () => {
		const wait = {
			running: "a".repeat(40),
			commit: "b".repeat(40),
			commits: 2,
			since: 1730990000000,
			turns: ["OTTR-1070"],
			command:
				"docker compose -f /srv/ottr/compose.yaml up -d --no-deps --wait server",
		};
		const linked = renderToStaticMarkup(
			<RestartWaitLine
				wait={wait}
				inboxKey="restart-wait:1730990000000"
				fresh={false}
				cards={cardsCtx}
			/>,
		);
		expect(linked).toContain(
			'<a class="notif-link" data-card-link="1" href="/projects/ottr/tasks/OTTR-1070" title="Open card OTTR-1070">OTTR-1070</a>',
		);
		const plain = renderToStaticMarkup(
			<RestartWaitLine
				wait={wait}
				inboxKey="restart-wait:1730990000000"
				fresh={false}
			/>,
		);
		expect(plain).not.toContain("data-card-link");
		expect(plain).toContain("The restart waits for: OTTR-1070.");
	});

	test("the restart host command lives behind the Details disclosure", () => {
		const html = renderToStaticMarkup(
			<RestartWaitLine
				wait={{
					running: "a".repeat(40),
					commit: "b".repeat(40),
					commits: 2,
					since: 1730990000000,
					turns: [],
					command:
						"docker compose -f /srv/ottr/compose.yaml up -d --no-deps --wait server",
				}}
				inboxKey="restart-wait:1730990000000"
				fresh={false}
			/>,
		);
		const doc = parseMarkup(html);
		const details = doc.querySelector(".notif-details");
		expect(details?.querySelector("summary")?.textContent).toBe("Details");
		expect(details?.textContent).toContain(
			"docker compose -f /srv/ottr/compose.yaml up -d --no-deps --wait server",
		);
		// The collapsed line carries no piece of the host command.
		doc.querySelectorAll(".notif-details").forEach((d) => {
			d.remove();
		});
		expect(doc.body.textContent).not.toContain("docker compose");
	});

	test("the seed failure's multi-line tail hides behind Details", () => {
		const fail = {
			since: 1730990000000,
			commit: "c".repeat(40),
			text: "Seed pull failed for the agent layer image.\ncontainer ottr-worker-1 exited with code 1\nrepair steps live in /tmp/ottr-seed-9912/repair.sh",
		};
		const html = renderToStaticMarkup(
			<SeedFailedLine
				fail={fail}
				inboxKey="seed-failed:1730990000000"
				fresh={false}
			/>,
		);
		const doc = parseMarkup(html);
		// The collapsed line keeps only the first line of the recorded text.
		expect(doc.body.textContent).toContain(
			"Seed pull failed for the agent layer image.",
		);
		const details = doc.querySelector(".notif-details");
		expect(details?.querySelector("summary")?.textContent).toBe("Details");
		expect(details?.textContent).toContain("ottr-worker-1");
		expect(details?.textContent).toContain("/tmp/ottr-seed-9912/repair.sh");
		doc.querySelectorAll(".notif-details").forEach((d) => {
			d.remove();
		});
		expect(doc.body.textContent).not.toContain("ottr-worker-1");
		expect(doc.body.textContent).not.toContain("/tmp/ottr-seed-9912");
	});

	test("five card references clamp to three anchors and a +2 more control", () => {
		const ids = ["OTTR-1", "OTTR-2", "OTTR-3", "OTTR-4", "OTTR-5"];
		const html = renderToStaticMarkup(
			<WarningLines
				warnings={[
					"Cards running across the checkout change (ottr#OTTR-1, ottr#OTTR-2, ottr#OTTR-3, ottr#OTTR-4, ottr#OTTR-5) kept their worktrees.",
				]}
				cards={{
					resolve: (id: string) =>
						ids.includes(id) ? { project: "ottr", id } : null,
					open: () => {},
				}}
			/>,
		);
		expect(html.match(/data-card-link="1"/g)?.length).toBe(3);
		expect(html).toContain("+2 more");
		expect(html).toContain('aria-label="Show 2 more cards"');
		expect(html).toContain('aria-expanded="false"');
		// The clamp keeps the separator after the third reference and moves the
		// line's closing punctuation behind the button, so it reads
		// "...OTTR-3, +2 more." instead of "OTTR-3+2 more".
		expect(html).toContain("</a>, <button");
		expect(html).toContain("+2 more</button>.");
		// The 4th and 5th references only come back after expansion.
		expect(html).not.toContain("OTTR-4");
		expect(html).not.toContain("OTTR-5");
	});

	test("shortNoticeText keeps the first line and first sentence", () => {
		expect(shortNoticeText("First sentence. Second one follows.")).toBe(
			"First sentence.",
		);
		expect(shortNoticeText("Head: tail stays out of the collapsed line.")).toBe(
			"Head:",
		);
		expect(shortNoticeText("No sentence end here\nsecond line\nthird")).toBe(
			"No sentence end here",
		);
		expect(shortNoticeText("Trailing end is the whole line.")).toBe(
			"Trailing end is the whole line.",
		);
	});

	test("shortNoticeText drops host paths, flags, and container names from the collapsed copy", () => {
		// Stripping runs before the cut, so the ";" after "(exit 1)" becomes the
		// first clean sentence end and the tail moves behind Details.
		expect(
			shortNoticeText(
				"SkillSpector rejected /tmp/alate-data-9f34/user/omp/agent/skills/egm-review-loop (exit 1); nothing was installed",
			),
		).toBe("SkillSpector rejected (exit 1);");
		expect(
			shortNoticeText("bun install failed (exit 1) in /opt/agent-data"),
		).toBe("bun install failed (exit 1)");
		expect(
			shortNoticeText(
				"container ottr-worker-1 exited before the seed finished",
			),
		).toBe("container exited before the seed finished");
		expect(
			shortNoticeText(
				"Install it at https://github.com/apps/ottr-ai/installations/new.",
			),
		).toBe("Install it at https://github.com/apps/ottr-ai/installations/new.");
		expect(shortNoticeText("seed flags -d --no-deps --wait ignored")).toBe(
			"seed flags ignored",
		);
		// Card refs match no detail-token shape, tagged or bare.
		expect(
			shortNoticeText("cards ottr#OTTR-1071, alate#ALAT-180 were running"),
		).toBe("cards ottr#OTTR-1071, alate#ALAT-180 were running");
	});

	test("shortNoticeText keeps a removed path's period and drops its connector", () => {
		expect(
			shortNoticeText(
				"bun install failed (exit 1) in /opt/agent-data. Run node sync.mjs to repair.",
			),
		).toBe("bun install failed (exit 1).");
	});

	test("shortNoticeText strips container names that carry punctuation", () => {
		// The shape test runs on the token's bare core, so a sentence period or
		// a bracket pair riding on the name cannot keep the name in the pane.
		expect(
			shortNoticeText(
				"bun install failed (exit 1) in container ottr-worker-1. Run node sync.mjs to repair.",
			),
		).toBe("bun install failed (exit 1) in container.");
		expect(
			shortNoticeText("container (ottr-worker-1) and (alate-seed-2) exited"),
		).toBe("container and exited");
	});

	test("shortNoticeText caps a flattened single-line record to one short clean line", () => {
		const record =
			"bun install failed (exit 1) in /opt/agent-data container ottr-worker-1 exited before the seed finished temp tree /tmp/ottr-seed-3182 left in place alate snapshot import stopped at step 3 of 5 repair: run node sync.mjs from the alate checkout repair: clear /tmp/ottr-seed-3182 and re-run the update";
		const short = shortNoticeText(record, 160);
		expect(short.startsWith("bun install failed")).toBe(true);
		expect(short).not.toContain("/");
		expect(short).not.toContain("sync.mjs");
		expect(short.length).toBeLessThanOrEqual(161);
		expect(short.length).toBeLessThan(record.length);
		// The cap cannot engage on this record: the stripped line's first clause
		// end ("repair:") is a clean cut below 160 chars, so the line ends there
		// and Details carries the repair steps. No partially cut word: whatever
		// ends the line is a whole fixture word.
		const body = short.endsWith("…") ? short.slice(0, -1) : short;
		const lastWord = body.split(" ").at(-1) ?? "";
		expect(lastWord !== "" && record.split(/\s+/).includes(lastWord)).toBe(
			true,
		);
	});

	test("shortNoticeText caps a long clean sentence at a word boundary", () => {
		const sentence = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
		const short = shortNoticeText(sentence, 40);
		expect(short.length).toBeLessThanOrEqual(41);
		expect(short.endsWith("…")).toBe(true);
		const lastWord = short.slice(0, -1).split(" ").at(-1) ?? "";
		expect(lastWord !== "" && sentence.split(" ").includes(lastWord)).toBe(
			true,
		);
	});

	test("shortNoticeText without a cap returns a long clean sentence whole", () => {
		const sentence = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
		expect(shortNoticeText(sentence)).toBe(sentence);
	});

	// Properties (OTTR-1086): OTTR-1084's send-backs were shapes the examples
	// above missed — a temp path inside a flattened record, a path-dirty cut,
	// a punctuated container name. One generator builds the shapes
	// scripts/update-image.ts really sends: a single flattened line, card ids
	// up front where the collapsed line must keep them, then the detail tail
	// (paths, flags, containers, commands, shas) it must drop.
	const plainWord = fc.constantFrom(
		"bun",
		"install",
		"failed",
		"exited",
		"container",
		"seed",
		"finished",
		"repair",
		"run",
		"node",
		"snapshot",
		"import",
		"stopped",
		"step",
		"left",
		"place",
		"update",
		"card",
		"rejected",
		"SkillSpector",
		"scheduled",
	);
	const connector = fc.constantFrom(
		"in",
		"at",
		"on",
		"from",
		"with",
		"to",
		"for",
		"by",
		"into",
		"under",
		"via",
	);
	const pathToken = fc
		.tuple(
			fc.constantFrom("tmp", "opt", "var", "usr", "etc"),
			fc.array(
				fc.constantFrom(
					"alate-data-9f34",
					"ottr-seed-3182",
					"user",
					"omp",
					"agent",
					"skills",
					"egm-review-loop",
					"bin",
					"cache",
				),
				{ minLength: 1, maxLength: 3 },
			),
		)
		.map(([root, segs]) => `/${root}/${segs.join("/")}`);
	const flagToken = fc
		.tuple(
			fc.constantFrom("-", "--"),
			fc.constantFrom("d", "f", "wait", "no-deps", "env-file", "help"),
		)
		.map(([dashes, word]) => `${dashes}${word}`);
	const containerCore = fc.constantFrom(
		"ottr-worker-1",
		"ottr-worker-2",
		"alate-seed-2",
		"dev-board-7",
		"worker-3",
	);
	// A tail container may carry punctuation or a bracket: the send-back 3
	// shape the bare-core shape test must see through.
	const containerToken = fc
		.tuple(
			containerCore,
			fc.constantFrom("", "("),
			fc.constantFrom("", ".", ",", ":", ")", ")."),
		)
		.map(([core, pre, suf]) => `${pre}${core}${suf}`);
	// A head token must not end a sentence before a later id, so its
	// decorations carry no sentence punctuation.
	const headContainer = fc
		.tuple(containerCore, fc.constantFrom("", "(", ","))
		.map(([core, deco]) =>
			deco === "" ? core : deco === "," ? `${core},` : `(${core})`,
		);
	const cardId = fc
		.tuple(
			fc.constantFrom("OTTR", "ALAT", "MYST", "VELV"),
			fc.integer({ min: 100, max: 1299 }),
		)
		.map(([prefix, n]) => `${prefix}-${n}`);
	const projectCardId = fc
		.tuple(fc.constantFrom("ottr", "alate", "mystic-realms", "velvarr"), cardId)
		.map(([project, id]) => `${project}#${id}`);
	const shaToken = fc
		.array(fc.constantFrom(..."0123456789abcdef"), {
			minLength: 7,
			maxLength: 10,
		})
		.map((chars) => chars.join(""));
	const commandFragment = fc.constantFrom(
		"docker compose",
		"up -d --wait",
		"up -d --no-deps",
		"git push origin main",
		"systemctl restart server",
	);
	const headToken = fc.oneof(
		{ weight: 4, arbitrary: cardId },
		{ weight: 1, arbitrary: projectCardId },
		{ weight: 5, arbitrary: plainWord },
		{ weight: 2, arbitrary: connector },
		{ weight: 1, arbitrary: pathToken },
		{ weight: 1, arbitrary: headContainer },
		{ weight: 1, arbitrary: fc.constantFrom("(exit 1)", "(exit 125)") },
	);
	const tailToken = fc.oneof(
		{ weight: 4, arbitrary: plainWord },
		{ weight: 2, arbitrary: connector },
		{ weight: 3, arbitrary: pathToken },
		{ weight: 2, arbitrary: flagToken },
		{ weight: 2, arbitrary: containerToken },
		{ weight: 1, arbitrary: shaToken },
		{ weight: 1, arbitrary: commandFragment },
		{
			weight: 1,
			arbitrary: fc.constantFrom(
				"sync.mjs",
				"repair:",
				"re-run",
				"update-image.ts",
			),
		},
	);
	const noticeText = fc
		.tuple(
			fc.array(headToken, { minLength: 1, maxLength: 6 }),
			fc.constantFrom(".", ";", "!", "?", ":"),
			fc.array(tailToken, { minLength: 1, maxLength: 40 }),
			fc.boolean(),
		)
		.map(([head, end, tail, withEnd]) => {
			const lead = `${head.join(" ")}${withEnd ? end : ""}`;
			return `${lead} ${tail.join(" ")}`;
		});
	// Independent leak oracle (never the helpers' code): the three detail
	// shapes, judged on the token's bare core — leading and trailing
	// punctuation and brackets ride on the token and must not hide the shape
	// (OTTR-1084 send-back 3). A helper gap against this contract fails P1.
	const leakShape = (token: string): "path" | "flag" | "container" | null => {
		const core = token.replace(/^[^\w/@#-]+/, "").replace(/[^\w/@#-]+$/, "");
		if (/^https?:\/\//i.test(core)) return null;
		if (core.includes("/")) return "path";
		if (/^-{1,2}[a-zA-Z0-9]/.test(core)) return "flag";
		if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+$/.test(core)) return "container";
		return null;
	};

	test("property: the collapsed line leaks no path, flag, or container token", () => {
		fc.assert(
			fc.property(noticeText, (text) => {
				for (const line of [
					shortNoticeText(text, 160),
					shortNoticeText(text),
				]) {
					for (const token of line.split(/\s+/)) {
						expect(leakShape(token)).toBeNull();
					}
				}
			}),
		);
	});

	test("property: every bare card id reaches the collapsed line unchanged", () => {
		fc.assert(
			fc.property(noticeText, (text) => {
				const short = shortNoticeText(text, 160);
				for (const token of text.split(/\s+/)) {
					// The code's bare reference shape (WARNING_LINK_RE's m[6]):
					// the id must survive whole where the renderer would link
					// it. The sentence punctuation the code keeps from a
					// dropped token may ride behind the id ("OTTR-100."); no
					// cut or cap may split or drop the id itself.
					if (/^[A-Z][A-Z0-9]*-\d+$/.test(token)) {
						const linkable = new RegExp(
							`(?<![A-Za-z0-9-])${token}(?![A-Za-z0-9-])`,
						).test(short);
						expect(linkable).toBe(true);
					}
				}
			}),
		);
	});

	test("property: the seed-line cap bounds the collapsed line", () => {
		fc.assert(
			fc.property(noticeText, (text) => {
				// 160 cap characters, plus the ellipsis the code appends on a cut.
				expect(shortNoticeText(text, 160).length).toBeLessThanOrEqual(161);
			}),
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
	installBrowserGlobals(["HTMLElement"]);
	const host = globalThis as unknown as Record<string, unknown>;
	const now = 1_700_000_000_000;
	const idle = {
		nextCycleAt: now + 120_000,
		phase: "idle" as const,
		canStart: true,
		error: null,
	};
	// fetch is swapped per test through host.fetch; its original comes back after all.
	const realFetch = globalThis.fetch;
	afterAll(() => {
		globalThis.fetch = realFetch;
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
		const { container, root, unmount } = await mount(
			<UpdateCycleControl cycle={idle} nowMs={now} />,
		);
		try {
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
			await unmount();
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
		const { container, root, unmount } = await mount(
			<UpdateCycleControl cycle={idle} nowMs={now} />,
		);
		try {
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
			await unmount();
		}
	});
	test("request and host failures stay beside the action with a retry step", async () => {
		host.fetch = async () =>
			Response.json({ error: "Host is unavailable" }, { status: 409 });
		const { container, root, unmount } = await mount(
			<UpdateCycleControl cycle={idle} nowMs={now} />,
		);
		try {
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
			await unmount();
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
				trendingStatus={{
					lastRunAt: null,
					lastError: null,
					running: false,
					tokenPresent: false,
				}}
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
	const childCard = listChildCard;
	const _project = listProject;
	const base = listBaseReadonly;
	installBrowserGlobals([
		"Event",
		"HTMLElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);
	// The production onClick React rendered onto the node; happy-dom's dispatched
	// events never reach React's plugin (same helper the prompt editor tests use).
	const json = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	/** Renders the drawer with `fetch` stubbed: every URL 404s except the ones
	 * `serve` answers. The two acts let the mount fetches land, like the prompt
	 * editor tests; `fetches` records every URL the drawer asked for. */
	const mountDrawer = async (
		task: TaskCard,
		tasks: TaskCard[],
		serve: (url: string) => Response | Promise<Response>,
	): Promise<{
		container: HTMLDivElement;
		fetches: string[];
		close: () => Promise<void>;
	}> => {
		const fetches: string[] = [];
		const { restore } = stubFetch(async (url) => {
			fetches.push(url);
			return serve(url);
		});
		const { container, unmount } = await mount(
			<Drawer {...base} task={task} tasks={tasks} />,
		);
		await act(async () => {});
		return {
			container,
			fetches,
			close: async () => {
				await unmount();
				restore();
			},
		};
	};

	test("a parent outside the Done window loads: loading row first, then the card as a link", async () => {
		const parent = cardFixture({
			id: "P-9",
			stage: "done",
			state: "idle",
			sessionTitle: "Parent work",
		});
		const child = childCard({
			id: "C-1",
			stage: "done",
			state: "idle",
			followUpOf: "P-9",
		});
		// Held release: the fetch stays pending until the test releases it, so the
		// loading row is observable.
		const { promise: pending, resolve: release } =
			Promise.withResolvers<Response>();
		const { container, fetches, close } = await mountDrawer(child, [], (url) =>
			url.endsWith("/tasks/P-9")
				? pending
				: new Response("{}", { status: 404 }),
		);
		try {
			// The fetch went to the parent's tasks route, the same one the drawer's
			// detail read uses.
			expect(fetches).toContain("/api/projects/proj/tasks/P-9");
			// Before the fetch lands: the id on the same three-column row shape, so
			// nothing shifts when the card arrives. Never "Not on the board".
			expect(container.querySelector(".lineage-gone") !== null).toBe(true);
			expect(container.textContent).toContain("P-9");
			expect(container.textContent).toContain("Loading");
			expect(container.textContent).not.toContain("Not on the board");
			release(json({ ...parent, turns: [] }));
			await act(async () => {});
			const link = container.querySelector<HTMLAnchorElement>(
				'.lineage-rail a.lineage-row[href="/projects/proj/tasks/P-9"]',
			);
			expect(link !== null).toBe(true);
			// Real id, title and live stage; the link's text is its accessible name.
			expect(link?.textContent).toContain("P-9");
			expect(link?.textContent).toContain("Parent work");
			expect(link?.textContent).toContain("done");
			expect(container.textContent).not.toContain("Not on the board");
			expect(container.querySelector(".lineage-gone")).toBeNull();
		} finally {
			await close();
		}
	});

	test("a parent whose fetch fails offers Retry, and Retry loads the card", async () => {
		const parent = cardFixture({
			id: "P-5",
			stage: "done",
			state: "idle",
			sessionTitle: "Late parent",
		});
		const child = childCard({
			id: "C-1",
			stage: "done",
			state: "idle",
			followUpOf: "P-5",
		});
		let fail = true;
		const { container, close } = await mountDrawer(child, [], (url) =>
			url.endsWith("/tasks/P-5")
				? fail
					? new Response("{}", { status: 500 })
					: json({ ...parent, turns: [] })
				: new Response("{}", { status: 404 }),
		);
		try {
			// Only a 404 proves the card does not exist; a server error keeps the id
			// visible with an inline retry.
			expect(container.textContent).toContain("Could not load card");
			expect(container.textContent).not.toContain("Card not found");
			const retry = container.querySelector<HTMLButtonElement>(
				".lineage-gone button",
			);
			expect(retry?.textContent).toBe("Retry");
			fail = false;
			await act(async () => {
				onClickOf(retry as unknown as Element)({});
			});
			await act(async () => {});
			const link = container.querySelector<HTMLAnchorElement>(
				'.lineage-rail a.lineage-row[href="/projects/proj/tasks/P-5"]',
			);
			expect(link !== null).toBe(true);
			expect(link?.textContent).toContain("Late parent");
			expect(container.querySelector(".lineage-gone")).toBeNull();
		} finally {
			await close();
		}
	});

	test("a cross-project parent outside the window fetches from its own project", async () => {
		const parent = cardFixture({
			id: "P-2",
			project: "other",
			stage: "done",
			state: "idle",
			sessionTitle: "Far parent",
		});
		const child = childCard({
			id: "C-1",
			stage: "done",
			state: "idle",
			followUpOf: "P-2",
			followUpOfProject: "other",
		});
		const { container, fetches, close } = await mountDrawer(child, [], (url) =>
			url.endsWith("/projects/other/tasks/P-2")
				? json({ ...parent, turns: [] })
				: new Response("{}", { status: 404 }),
		);
		try {
			// The route uses the linked card's project, and the link href follows it.
			expect(fetches).toContain("/api/projects/other/tasks/P-2");
			const link = container.querySelector<HTMLAnchorElement>(
				'.lineage-rail a.lineage-row[href="/projects/other/tasks/P-2"]',
			);
			expect(link !== null).toBe(true);
			expect(link?.textContent).toContain("P-2");
			expect(link?.textContent).toContain("Far parent");
			expect(link?.textContent).toContain("other");
			expect(container.textContent).not.toContain("Not on the board");
		} finally {
			await close();
		}
	});

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
		const SUBTASKS = 'aria-label="Sub-tasks"';

		test("a retro source outside the Done window loads as a link", async () => {
			// The retro parent sits in the state; its source is older than the window,
			// so the drawer fetches it from the source's tasks route.
			const source = cardFixture({
				id: "SRC-1",
				stage: "done",
				state: "idle",
				sessionTitle: "Source work",
			});
			const retro = cardFixture({
				id: "R-1",
				kind: "retro",
				stage: "done",
				state: "idle",
				followUpOf: "SRC-1",
				sessionTitle: "The retro",
			});
			const self = childCard({
				id: "S-1",
				stage: "done",
				state: "idle",
				followUpOf: "R-1",
			});
			const { container, fetches, close } = await mountDrawer(
				self,
				[retro],
				(url) =>
					url.endsWith("/tasks/SRC-1")
						? json({ ...source, turns: [] })
						: new Response("{}", { status: 404 }),
			);
			try {
				expect(fetches).toContain("/api/projects/proj/tasks/SRC-1");
				const link = container.querySelector<HTMLAnchorElement>(
					'.lineage-rail a.lineage-row[href="/projects/proj/tasks/SRC-1"]',
				);
				expect(link !== null).toBe(true);
				expect(link?.textContent).toContain("SRC-1");
				expect(link?.textContent).toContain("Source work");
				expect(link?.textContent).toContain("retro source");
				expect(container.textContent).not.toContain("Not on the board");
			} finally {
				await close();
			}
		});

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

		test("a follow-up's own follow-ups nest one level deeper", () => {
			const html = renderToStaticMarkup(
				<Drawer
					{...base}
					task={self}
					tasks={[card("F-1", "S-1", 1000), card("G-1", "F-1", 2000)]}
				/>,
			);
			expect(html).toContain(">F-1<");
			expect(html).toContain(">G-1<");
			// G-1 nests inside F-1's own branch; a non-retro parent labels it
			// "Sub-tasks", never "Proposals".
			const nest = html.indexOf(SUBTASKS);
			expect(nest).toBeGreaterThan(at(html, "F-1"));
			expect(at(html, "G-1")).toBeGreaterThan(nest);
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

		test("a retro source the window dropped holds its id until its fetch lands", () => {
			const proposal = childCard({ id: "P-1", followUpOf: "R-1" });
			const html = renderToStaticMarkup(
				<Drawer
					{...base}
					task={proposal}
					tasks={[card("R-1", "S-9", 1000, { kind: "retro" })]}
				/>,
			);
			// Static render runs no fetch: the loading row keeps the source's id and
			// tag on the same row shape, with no link yet and no "Not on the board".
			expect(html).toContain("lineage-gone");
			expect(html).toContain("Loading");
			expect(html).not.toContain("/tasks/S-9");
			const gone = html.slice(html.indexOf("lineage-gone"), at(html, "R-1"));
			expect(gone).toContain(">retro source<");
			expect(html).not.toContain("Not on the board");
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

	// The descendant tree tests: a done root and the row's key-span indexOf.
	const treeSelf = childCard({ id: "S-1", stage: "done", state: "idle" });
	const at = (html: string, id: string) => html.indexOf(`>${id}<`);
	// The lineage section's markup: the fold assertions must not read later sections.
	const railHtml = (html: string): string => {
		const start = html.indexOf('id="drawer-lineage"');
		const end = html.indexOf("<section", start + 1);
		return html.slice(start, end === -1 ? undefined : end);
	};
	// The fold disclosure button's own markup.
	const foldButton = (html: string): string => {
		const start = html.indexOf('class="lineage-fold"');
		return html.slice(start, html.indexOf("</button>", start));
	};

	test("a done child with a running grandchild counts its open subtree", () => {
		const html = renderToStaticMarkup(
			<Drawer
				{...base}
				task={treeSelf}
				tasks={[
					cardFixture({
						id: "K-1",
						followUpOf: "S-1",
						createdAt: 1000,
						stage: "done",
					}),
					cardFixture({
						id: "G-1",
						followUpOf: "K-1",
						createdAt: 2000,
						stage: "in_progress",
					}),
				]}
			/>,
		);
		// The grandchild renders one indent under the done child.
		const nest = html.indexOf('aria-label="Sub-tasks"');
		expect(nest).toBeGreaterThan(at(html, "K-1"));
		expect(at(html, "G-1")).toBeGreaterThan(nest);
		// The child's row carries the count; the grandchild's row (no descendants) does not.
		const kRow = html.slice(at(html, "K-1"), nest);
		expect(kRow).toContain("1 open below");
		expect(kRow).toContain('aria-label="1 open sub-task"');
		expect(html.slice(at(html, "G-1"))).not.toContain("open below");
	});

	test("the hold banner names the cards a review's findings hold parks", () => {
		// A review held by its findings waits on its OPEN findings only: the done
		// finding drops out, while its running child still counts as a finding.
		const review = cardFixture({
			id: "R-1",
			kind: "review",
			stage: "merging",
			state: "idle",
			needsReason: FINDINGS_HOLD,
			doneAt: 5000,
			createdAt: 500,
		});
		const html = renderToStaticMarkup(
			<Drawer
				{...base}
				task={review}
				tasks={[
					cardFixture({
						id: "F-1",
						followUpOf: "R-1",
						createdAt: 1000,
						stage: "done",
					}),
					cardFixture({
						id: "G-1",
						followUpOf: "F-1",
						createdAt: 2000,
						stage: "in_progress",
					}),
				]}
			/>,
		);
		const waiting = html.slice(html.indexOf('id="drawer-waiting"'));
		expect(waiting).toContain('href="/projects/proj/tasks/G-1"');
		expect(waiting).not.toContain('href="/projects/proj/tasks/F-1"');
	});

	test("the tree caps at four levels and folds the rest into a +N more row", () => {
		const html = renderToStaticMarkup(
			<Drawer
				{...base}
				task={treeSelf}
				tasks={[
					cardFixture({ id: "L-1", followUpOf: "S-1", createdAt: 1000 }),
					cardFixture({ id: "L-2", followUpOf: "L-1", createdAt: 2000 }),
					cardFixture({ id: "L-3", followUpOf: "L-2", createdAt: 3000 }),
					cardFixture({ id: "L-4", followUpOf: "L-3", createdAt: 4000 }),
					cardFixture({ id: "L-5", followUpOf: "L-4", createdAt: 5000 }),
					cardFixture({ id: "L-6", followUpOf: "L-5", createdAt: 6000 }),
				]}
			/>,
		);
		// Levels 1-4 render; levels 5 and 6 collapse into L-4's "+2 more" row.
		expect(html).toContain(">L-4<");
		expect(html).not.toContain(">L-5<");
		expect(html).not.toContain(">L-6<");
		expect(html.indexOf("+2 more")).toBeGreaterThan(at(html, "L-4"));
		// The more row opens the deepest shown card, L-4 itself.
		expect(html).toContain('href="/projects/proj/tasks/L-4"');
	});

	test("a duplicate card object renders once", () => {
		// Two task objects with the same (project, id) render once: the visited set
		// keys by card, not by object. The cycle case has its own test below.
		const html = renderToStaticMarkup(
			<Drawer
				{...base}
				task={treeSelf}
				tasks={[
					cardFixture({ id: "C-1", followUpOf: "S-1", createdAt: 1000 }),
					cardFixture({ id: "D-1", followUpOf: "C-1", createdAt: 2000 }),
					cardFixture({ id: "D-1", followUpOf: "C-1", createdAt: 3000 }),
				]}
			/>,
		);
		expect(html.match(/>D-1</g)).toHaveLength(1);
	});

	test("a quiet subtree folds and an open card keeps its rows visible", () => {
		// Four rows with no open card below Q-1: the default folds it. One running
		// grandchild keeps the same-size subtree expanded.
		const doneKid = (id: string, followUpOf: string, createdAt: number) =>
			cardFixture({ id, followUpOf, createdAt, stage: "done" });
		const quiet = renderToStaticMarkup(
			<Drawer
				{...base}
				task={treeSelf}
				tasks={[
					doneKid("Q-1", "S-1", 1000),
					doneKid("G-1", "Q-1", 2000),
					doneKid("G-2", "Q-1", 3000),
					doneKid("G-3", "Q-1", 4000),
				]}
			/>,
		);
		const open = renderToStaticMarkup(
			<Drawer
				{...base}
				task={treeSelf}
				tasks={[
					doneKid("Q-1", "S-1", 1000),
					doneKid("G-1", "Q-1", 2000),
					cardFixture({
						id: "G-2",
						followUpOf: "Q-1",
						createdAt: 3000,
						stage: "in_progress",
					}),
					doneKid("G-3", "Q-1", 4000),
				]}
			/>,
		);
		expect(foldButton(quiet)).toContain('aria-expanded="false"');
		expect(foldButton(quiet)).toContain('aria-label="Show sub-tasks"');
		// Folded: the grandchildren render nothing and no elbow dangles.
		expect(railHtml(quiet)).not.toContain(">G-1<");
		expect(railHtml(quiet)).not.toContain("lineage-holds");
		expect(foldButton(open)).toContain('aria-expanded="true"');
		expect(foldButton(open)).toContain('aria-label="Hide sub-tasks"');
		expect(railHtml(open)).toContain(">G-1<");
		expect(railHtml(open)).toContain("lineage-holds");
	});

	test("an open child keeps its subtree expanded", () => {
		// The fold predicate counts the node itself: a running child with three
		// done children has no open descendant but is open work, so it must not
		// fold away its own unfinished state.
		const kid = (
			id: string,
			followUpOf: string,
			createdAt: number,
			stage: TaskCard["stage"],
		) => cardFixture({ id, followUpOf, createdAt, stage });
		const html = renderToStaticMarkup(
			<Drawer
				{...base}
				task={treeSelf}
				tasks={[
					kid("Q-1", "S-1", 1000, "in_progress"),
					kid("G-1", "Q-1", 2000, "done"),
					kid("G-2", "Q-1", 3000, "done"),
					kid("G-3", "Q-1", 4000, "done"),
				]}
			/>,
		);
		expect(foldButton(html)).toContain('aria-expanded="true"');
		expect(railHtml(html)).toContain(">G-1<");
	});

	test("a card outside merging names no review's cards", () => {
		// mergeHold applies at merging only (holdFor): a queued todo card and a
		// done card list no running review's findings under Waiting for.
		const runningReview = cardFixture({
			id: "R-9",
			kind: "review",
			stage: "in_progress",
			state: "running",
			createdAt: 100,
		});
		const finding = cardFixture({
			id: "F-9",
			followUpOf: "R-9",
			createdAt: 200,
			stage: "todo",
		});
		const todo = renderToStaticMarkup(
			<Drawer
				{...base}
				task={cardFixture({ id: "T-1", stage: "todo", createdAt: 300 })}
				tasks={[runningReview, finding]}
			/>,
		);
		expect(todo).not.toContain('id="drawer-waiting"');
		const landed = renderToStaticMarkup(
			<Drawer
				{...base}
				task={cardFixture({
					id: "D-9",
					stage: "done",
					state: "idle",
					createdAt: 300,
				})}
				tasks={[runningReview, finding]}
			/>,
		);
		expect(landed).not.toContain('id="drawer-waiting"');
	});

	test("a queued merge names the review that holds it", () => {
		// The run hold (a review still running) names the review card itself,
		// and only the held merge lists it — no other stage does.
		const held = cardFixture({
			id: "M-1",
			stage: "merging",
			state: "queued",
			createdAt: 300,
		});
		const running = cardFixture({
			id: "R-1",
			kind: "review",
			stage: "in_progress",
			state: "running",
			createdAt: 100,
		});
		const html = renderToStaticMarkup(
			<Drawer {...base} task={held} tasks={[running]} />,
		);
		const waiting = html.slice(html.indexOf('id="drawer-waiting"'));
		expect(waiting).toContain('href="/projects/proj/tasks/R-1"');
		const bystander = renderToStaticMarkup(
			<Drawer
				{...base}
				task={cardFixture({ id: "T-2", stage: "todo", createdAt: 300 })}
				tasks={[running, held]}
			/>,
		);
		expect(bystander).not.toContain('id="drawer-waiting"');
	});

	test("the fold state keys by project and id", async () => {
		// Real stores reuse ids across projects (src/app.test.ts documents them):
		// opening one D-1's folded branch must not open the other project's D-1.
		const d = (project: string, createdAt: number): TaskCard =>
			cardFixture({
				id: "D-1",
				project,
				followUpOf: "S-1",
				followUpOfProject: "proj",
				createdAt,
				stage: "done",
				state: "idle",
			});
		const kid = (project: string, prefix: string, n: number): TaskCard =>
			cardFixture({
				id: `${prefix}-${n}`,
				project,
				followUpOf: "D-1",
				followUpOfProject: project,
				createdAt: 1000 + n,
				stage: "done",
				state: "idle",
			});
		const tasks = [
			d("proj", 1000),
			d("other", 2000),
			kid("proj", "P", 1),
			kid("proj", "P", 2),
			kid("proj", "P", 3),
			kid("other", "O", 1),
			kid("other", "O", 2),
			kid("other", "O", 3),
		];
		const { container, close } = await mountDrawer(
			treeSelf,
			tasks,
			() => new Response("{}", { status: 404 }),
		);
		try {
			// Both D-1 subtrees start folded (quiet, four rows each).
			const before = railHtml(container.innerHTML);
			expect(before).not.toContain(">P-1<");
			expect(before).not.toContain(">O-1<");
			const folds = container.querySelectorAll("button.lineage-fold");
			expect(folds).toHaveLength(2);
			await act(async () => onClickOf(folds[0] as unknown as Element)({}));
			const after = railHtml(container.innerHTML);
			expect(after).toContain(">P-1<");
			expect(after).not.toContain(">O-1<");
		} finally {
			await close();
		}
	});

	test("a followUpOf cycle renders each card once and stops", () => {
		// Caller-controlled links (OTTR-1009) can name a descendant as a parent:
		// S-1 -> K-1 -> S-1. The walk roots at the drawer card, so the seen set
		// stops the return edge instead of recursing forever.
		const self = childCard({
			id: "S-1",
			stage: "done",
			state: "idle",
			followUpOf: "K-1",
		});
		const k = cardFixture({
			id: "K-1",
			followUpOf: "S-1",
			createdAt: 1000,
			stage: "done",
			state: "idle",
		});
		// The board list holds the drawer card itself, as the live state does:
		// only then does K-1's bucket point back at S-1 and close the cycle.
		const html = renderToStaticMarkup(
			<Drawer {...base} task={self} tasks={[self, k]} />,
		);
		const rail = railHtml(html);
		// K-1 renders twice: the parent chip row above this card's node, and its
		// tree row below. The self row never repeats inside its own tree.
		expect(rail.match(/>S-1</g)).toHaveLength(1);
		expect(rail.match(/>K-1</g)).toHaveLength(2);
	});

	test("the tree keeps cross-project grandchildren the context list drops", async () => {
		// A/R -> A/C -> B/G, C no retro: AppDrawer's project-scoped context filter
		// drops G, so the tree reads it from the unfiltered loaded board list.
		const review = cardFixture({
			id: "R-1",
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 900,
		});
		const child = cardFixture({
			id: "C-1",
			followUpOf: "R-1",
			createdAt: 200,
			stage: "done",
			state: "idle",
		});
		const grand = cardFixture({
			id: "G-1",
			project: "other",
			followUpOf: "C-1",
			followUpOfProject: "proj",
			createdAt: 300,
			stage: "in_progress",
			state: "running",
		});
		const { restore } = stubFetch(
			async () => new Response("{}", { status: 404 }),
		);
		const { container, unmount } = await mount(
			<AppDrawer
				selected={review}
				selectedProject={listProject}
				sheet={null}
				pendingDrawer={null}
				retryPending={() => {}}
				state={null}
				projects={[listProject]}
				tasks={[review, child, grand]}
				deltas={new Map()}
				draining={false}
				usedTotal={0}
				seenAnswers={new Set()}
				origin={{ current: null }}
				act={async () => true}
				openTask={() => {}}
				markRead={() => {}}
				markUnread={() => {}}
				closeDrawer={() => {}}
				seenDoneSince={0}
			/>,
		);
		try {
			const rail = railHtml(container.innerHTML);
			expect(rail).toContain('href="/projects/other/tasks/G-1"');
			// C's row carries the open count for its foreign grandchild.
			const cRow = rail.slice(rail.indexOf(">C-1<"));
			expect(cRow).toContain("1 open below");
		} finally {
			await unmount();
			restore();
		}
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
	const project = listProject;

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
	const childCard = listChildCard;
	const _project = listProject;
	const base = listBaseReadonly;
	installBrowserGlobals([
		"Event",
		"HTMLElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

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

	test("a same-id card on another board does not pose as the parent", async () => {
		// The id+project lookup and the fetch both use the child's project
		// (followUpOfProject ?? project), so the impostor's project never serves the
		// row; the route's 404 earns the not-found row, never a stale link.
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
		const fetches: string[] = [];
		const { restore } = stubFetch(async (url) => {
			fetches.push(url);
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mount(
			<Drawer {...base} task={child} tasks={[impostor]} />,
		);
		try {
			await act(async () => {});
			// The fetch went to the child's project, and its 404 reads as not-found.
			expect(fetches).toContain("/api/projects/proj/tasks/P-1");
			expect(container.textContent).toContain("Card not found");
			expect(container.textContent).not.toContain("Impostor work");
			expect(container.textContent).not.toContain("Not on the board");
		} finally {
			await unmount();
			restore();
		}
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

describe("Drawer prompt loading", () => {
	// ponytail: render test reads only these fields; the cast keeps the fixture short.
	const _project = drawerProject;
	const base = drawerBase;

	test("the read-only prompt section holds a loading line until the detail fetch lands", () => {
		// The state row carries no prompt text (OTTR-965): the drawer fetches it from
		// the task route. The static render never resolves the fetch, so it sees the
		// loading state; the loaded text renders in the mounted tests further down.
		const done = cardFixture({ ...drawerFields, stage: "done", state: "idle" });
		const html = renderToStaticMarkup(<Drawer {...base} task={done} />);
		expect(html).toContain('aria-label="Loading the prompt"');
		expect(html).not.toContain('class="prompt-text"');
		const preparing = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "preparing",
		});
		const preparingHtml = renderToStaticMarkup(
			<Drawer {...base} task={preparing} />,
		);
		expect(preparingHtml).toContain('aria-label="Loading the prompt"');
		expect(preparingHtml).not.toContain("Edit task");
	});

	test("the editable card hides its Edit task button until the prompt lands", () => {
		const parked = cardFixture({
			...drawerFields,
			stage: "backlog",
			state: "idle",
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={parked} />);
		expect(html).toContain('aria-label="Loading the prompt"');
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
	const _project = drawerProject;
	const base = drawerBase;

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
	const _project = drawerProject;
	const base = drawerBase;
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

describe("Drawer hold hint expiry", () => {
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
	const held = (holdUntil: number): TaskCard =>
		cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			holdUntil,
			holdProvider: "openai-codex",
			holdWindow: "7d",
			holdSetAt: holdUntil - 120_000,
			needsReason: "The openai-codex usage limit is reached.",
		});
	const HINT =
		"To start now, pick a model from another provider in the composer";
	const RESUME_TITLE = "End the usage-limit hold and start the task now";

	test("a live hold names the composer way out and offers Resume", () => {
		const html = renderToStaticMarkup(
			<Drawer {...base} task={held(Date.now() + 3_600_000)} />,
		).replaceAll("<!-- -->", "");
		expect(html).toContain(HINT);
		expect(html).toContain(RESUME_TITLE);
	});

	test("an expired hold hides the hint and the Resume button", () => {
		// pickRunnable starts holdUntil <= now on its own: the card waits for a slot,
		// so neither the hint nor the hold-only Resume button may render.
		const html = renderToStaticMarkup(
			<Drawer {...base} task={held(Date.now() - 60_000)} />,
		).replaceAll("<!-- -->", "");
		expect(html).not.toContain(HINT);
		expect(html).not.toContain(RESUME_TITLE);
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
	const _project = drawerProject;
	const base = drawerBase;
	const { window } = installDrawerClientGlobals();

	// happy-dom's dispatched clicks never reach React's event plugin (same
	// upstream gap as settings.test.tsx's onChangeOf): call the production
	// onClick React rendered onto the node instead.

	// Shared harness for the queued steering tests: a mounted container plus
	// the Edit-button and editor probes the tests assert through.
	const steerHarness = () => {
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
		return { container, root, task, editButton, editor };
	};

	/** Mounts the queued steer editor on the harness and submits its form once. */
	const openAndSubmit = async (parts: ReturnType<typeof steerHarness>) => {
		const { root, task, editButton, editor } = parts;
		await act(async () => {
			root.render(<Drawer {...base} act={runAct} task={task("first steer")} />);
		});
		await act(async () => {
			onClickOf(editButton())({});
		});
		expect(editor()?.value).toBe("first steer");
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
	};

	test("a replaced steer never reopens the editor with the stale draft", async () => {
		// The drawer's effects fetch the task detail, session context and model
		// catalog; every one degrades to null on a failed response, so a 404 keeps
		// the row's own fields (pendingPrompt included) authoritative.
		const { restore } = stubFetch(
			async () => new Response("{}", { status: 404 }),
		);
		const { container, root, task, editButton, editor } = steerHarness();
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
			restore();
		}
	});

	test("a refused steer edit keeps the draft across the detail refresh", async () => {
		const { restore } = stubFetch(async (url) => {
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
		});
		const h = steerHarness();
		const { container, root, task, editButton, editor } = h;
		try {
			// The save is refused with the board's newer steering: the conflict flow
			// keeps the draft and re-arms the revision.
			await openAndSubmit(h);
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
			restore();
		}
	});

	test("a refused steer edit keeps its draft when the queue empties or resumes", async () => {
		const { restore } = stubFetch(async (url) => {
			if (String(url).includes("/steer/edit"))
				return new Response(
					JSON.stringify({
						error: "card changed since it was loaded",
						task: { id: "t1", revision: 9, pendingPrompt: "second steer" },
					}),
					{ status: 409 },
				);
			return new Response("{}", { status: 404 });
		});
		const { container, root, task, editButton, editor } = steerHarness();
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
			restore();
		}
	});

	test("a refused steer edit restores the draft a pre-409 refresh cleared", async () => {
		const gate = Promise.withResolvers<void>();
		let refused = false;
		const { restore } = stubFetch(async (url) => {
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
		});
		const h = steerHarness();
		const { container, root, task, editor } = h;
		try {
			await openAndSubmit(h);
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
			restore();
		}
	});
});

describe("Drawer start actions wait for the prompt edit (client)", () => {
	const _project = drawerProject;
	const base = drawerBase;
	const { window } = installDrawerClientGlobals();

	// happy-dom's dispatched clicks never reach React's event plugin (same
	// upstream gap as the steering describe above): call the production
	// onClick React rendered onto the node instead.
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
	/** Renders the task, opens the prompt editor, and runs `check` against the
	 * guarded start action with the editor open and after Cancel finishes it. */
	const expectGuard = async (
		task: TaskCard,
		label: string,
		freeTitle: string,
	): Promise<void> => {
		const { restore } = stubFetch(async (url) => {
			if (url.endsWith(`/tasks/${task.id}`)) {
				return new Response(JSON.stringify({ ...task, turns: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
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
			// One more act lets the detail fetch land, so the Edit task button renders.
			await act(async () => {});
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
			restore();
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

	// The queued task these claim/save tests render, and the loaded detail the
	// drawer's fetch effect reads back (OTTR-965): every test stubs the edit
	// routes uniquely and falls through to serveTaskDetail for /tasks/t1.
	const queuedCard = cardFixture({
		...drawerFields,
		stage: "todo",
		state: "queued",
		prompt: "queued idea",
		revision: 1,
	});
	const serveTaskDetail = (url: string | URL): Response | null =>
		String(url).endsWith("/tasks/t1")
			? new Response(JSON.stringify({ ...queuedCard, turns: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			: null;

	/** Mounts the queued card, lands the detail fetch, and opens the prompt
	 * editor: the shared head of the hold-claim and save tests. */
	const openPromptEditor = async () => {
		const { container, unmount } = await mount(
			<Drawer {...base} act={runAct} task={queuedCard} />,
		);
		// One more act lets the detail fetch land, so the Edit task button renders.
		await act(async () => {});
		await act(async () => {
			onClickOf(button(container, "Edit task"))({});
		});
		expect(container.querySelector("#edit-text")).not.toBeNull();
		return { container, unmount };
	};

	test("the hold claim is guarded by the draft's revision and the save carries it", async () => {
		// The claim carries the draft's snapshot revision: the server refuses a claim
		// whose revision is stale (another tab's content edit landed), and the save
		// carries the same snapshot revision the claim confirmed.
		const claims: Array<{ revision?: unknown }> = [];
		const saves: Array<{ revision?: unknown }> = [];
		const { restore } = stubFetch(async (url, init) => {
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
			// The detail fetch fills the prompt (OTTR-965): serve the row back loaded.
			return serveTaskDetail(url) ?? new Response("{}", { status: 404 });
		});
		const { container, unmount } = await openPromptEditor();
		try {
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
			await unmount();
			restore();
		}
	});

	test("Save waits for the hold claim before it enables", async () => {
		const gate = Promise.withResolvers<void>();
		const saves: Array<{ revision?: unknown }> = [];
		const { restore } = stubFetch(async (url, init) => {
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
			// The detail fetch fills the prompt (OTTR-965): serve the row back loaded.
			return serveTaskDetail(url) ?? new Response("{}", { status: 404 });
		});
		const { container, unmount } = await openPromptEditor();
		try {
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
			await unmount();
			restore();
		}
	});

	test("a failed hold claim keeps Save disabled", async () => {
		const saves: Array<unknown> = [];
		const { restore } = stubFetch(async (url, init) => {
			if (url.endsWith("/edit/start"))
				return new Response("{}", { status: 500 });
			if (url.endsWith("/edit") && init?.method === "POST") {
				saves.push(JSON.parse(String(init.body)));
				return new Response("{}", { status: 200 });
			}
			// The detail fetch fills the prompt (OTTR-965): serve the row back loaded.
			return serveTaskDetail(url) ?? new Response("{}", { status: 404 });
		});
		const { container, unmount } = await openPromptEditor();
		try {
			await act(async () => {});
			expect(promptSaveButton(container).disabled).toBe(true);
			await submitPromptEdit(container);
			expect(saves).toHaveLength(0);
			expect(container.querySelector("#edit-text")).not.toBeNull();
		} finally {
			await unmount();
			restore();
		}
	});

	test("a refused hold claim shows the conflict and keeps the draft", async () => {
		const saves: Array<{ prompt: string; revision?: unknown }> = [];
		const { restore } = stubFetch(async (url, init) => {
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
			// The detail fetch fills the prompt (OTTR-965): serve the row back loaded.
			return serveTaskDetail(url) ?? new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mount(
			<Drawer {...base} act={runAct} task={queuedCard} />,
		);
		try {
			// One more act lets the detail fetch land, so the Edit task button renders.
			await act(async () => {});
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
			await unmount();
			restore();
		}
	});

	test("a refused notes append retries onto the board's current notes", async () => {
		const calls: Array<{ notes: string; revision?: unknown }> = [];
		const { restore } = stubFetch(async (url, init) => {
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
		});
		const card = cardFixture({
			...drawerFields,
			stage: "done",
			state: "needs_you",
			releaseVersion: "v1.0.0",
			releaseNotes: "original notes",
		});
		const { container, unmount } = await mount(
			<Drawer {...base} act={runAct} task={card} />,
		);
		try {
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
			await unmount();
			restore();
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
		const { restore } = stubFetch(async (url) => {
			if (String(url).endsWith("/api/models"))
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
		});
		resetCatalogCache();
		const parked = cardFixture({
			...drawerFields,
			stage: "backlog",
			state: "idle",
			prompt: "parked idea",
			...(cardModel !== null ? { model: cardModel } : {}),
		});
		const { container, unmount } = await mount(
			<Drawer {...base} task={parked} />,
		);
		try {
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
			await unmount();
			restore();
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
		// Record the hold calls; the detail GET serves the row back loaded (OTTR-965),
		// so the Edit task button renders; everything else degrades to null detail.
		const holds: string[] = [];
		const { restore } = stubFetch(async (url) => {
			if (url.endsWith("/edit/start") || url.endsWith("/edit/stop"))
				holds.push(url.endsWith("start") ? "start" : "stop");
			if (url.endsWith("/tasks/t1")) {
				return new Response(JSON.stringify({ ...task, turns: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
		// A queued todo card: the scheduler could start it at any tick, so its open
		// editor must claim the hold (start) and release it when the editor is gone.
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "queued",
			prompt: "do the thing",
		});
		const { container, unmount } = await mount(
			<Drawer {...base} task={task} />,
		);
		try {
			// One more act lets the detail fetch land, so the Edit task button renders.
			await act(async () => {});
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
			await unmount();
			expect(holds).toEqual(["start", "stop", "stop"]);
		} finally {
			container.remove();
			restore();
		}
	});
});

describe("Drawer approve button", () => {
	const _project = drawerProject;
	const base = drawerBase;
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
				run: null,
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

	test("a duplicate-work close reason links the matched card ids; other reasons stay plain (OTTR-941)", () => {
		const match = cardFixture({
			id: "OTTR-12",
			title: "Add the widget",
			sessionTitle: "Add the widget",
			stage: "in_progress",
			state: "running",
			needsReason: null,
		});
		const render = (needsReason: string) =>
			renderToStaticMarkup(
				<Drawer
					{...base}
					task={cardFixture({
						...drawerFields,
						stage: "todo",
						state: "idle",
						cancelledAt: 1,
						needsReason,
					})}
					tasks={[match]}
				/>,
			);
		const html = render(
			"Duplicate work gate: OTTR-12 already adds the widget. Matches: OTTR-12 (in progress), src/widget.ts:4",
		);
		expect(html).toContain('href="/projects/proj/tasks/OTTR-12"');
		expect(html).toContain('title="Add the widget"');
		expect(html).toContain("src/widget.ts:4");
		// The same id in a reason from another writer is not linked.
		expect(render("Tracker error: OTTR-12 broke")).not.toContain(
			"reason-card-link",
		);
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
				text: true,
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
					text: true,
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

	test("a done card with a truncated saved list shows the truncated hint, not a count", () => {
		// The server caps the saved list. With the truncation flag, the drawer
		// shows the open hint and not a false exact count.
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
			worktreeFiles: ["research-report.md"],
			savedFiles: Array.from({ length: 60 }, (_, i) => ({
				name: `kept-${String(i).padStart(2, "0")}.md`,
				size: 10,
			})),
			savedFilesTruncated: true,
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-saved"');
		expect(html).toContain("saved-files?path=kept-00.md");
		expect(html).toContain("The list is truncated.");
		expect(html).not.toContain("…and 10 more");
	});

	test("a done card with a saved list past 50 and no truncation keeps the count", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
			worktreeFiles: ["research-report.md"],
			savedFiles: Array.from({ length: 60 }, (_, i) => ({
				name: `kept-${String(i).padStart(2, "0")}.md`,
				size: 10,
			})),
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain("…and 10 more");
	});

	test("a truncated saved list with few entries still shows the section and the truncated hint", () => {
		// The visited-entry cap can return fewer rows than the 50-row render
		// cap, so the flag alone must keep the section and its hint visible.
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
			worktreeFiles: ["research-report.md"],
			savedFiles: [{ name: "kept-00.md", size: 10 }],
			savedFilesTruncated: true,
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-saved"');
		expect(html).toContain("saved-files?path=kept-00.md");
		expect(html).toContain("The list is truncated.");
	});

	test("a truncated saved list with no entries still shows the section and the truncated hint", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
			worktreeFiles: ["research-report.md"],
			savedFiles: [],
			savedFilesTruncated: true,
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-saved"');
		expect(html).toContain("The list is truncated.");
		expect(html).not.toContain("saved-files?path=");
	});

	test("a saved list of a few entries with no truncation renders no count hint", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
			worktreeFiles: ["research-report.md"],
			savedFiles: [
				{ name: "a.md", size: 10 },
				{ name: "b.md", size: 10 },
				{ name: "c.md", size: 10 },
			],
		} as Partial<TaskCard>);
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-saved"');
		expect(html).toContain("saved-files?path=c.md");
		expect(html).not.toContain("…and");
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
	const base = laneColBase;

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
		const container = parseMarkup(html).createElement("div");
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
	// renderToStaticMarkup never runs. Mount with happy-dom (testDom.tsx) and
	// serve the fetches through the install's fetch stub.
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
	// The prompt rides only here (OTTR-965): the state row carries none.
	const detailBody = {
		...cardFixture({ id: "R-1", stage: "done", state: "idle", research: true }),
		prompt: "Loaded from the task route",
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
	const drawerExtras = {
		turns: [],
		workCheckLog: [],
		details: null,
		report: null,
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
	};
	// The editable card's loaded task: the Edit task button renders from it.
	const parkedDetail = {
		...cardFixture({ id: "P-1", stage: "backlog", state: "idle" }),
		prompt: "parked idea",
		...drawerExtras,
	} as unknown as TaskView;
	// The proposal's loaded task: the decision panel's prompt slots fill from it.
	const proposalDetail = {
		...cardFixture({
			id: "PR-1",
			stage: "todo",
			state: "needs_you",
			needsReason:
				"Retro proposal from t3. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		}),
		prompt: "Loaded from the task route",
		...drawerExtras,
	} as unknown as TaskView;
	installBrowserGlobals(
		[
			"Event",
			"HTMLInputElement",
			"HTMLTextAreaElement",
			"Node",
			"getComputedStyle",
			"requestAnimationFrame",
			"cancelAnimationFrame",
		],
		{
			fetch: (url: unknown): Promise<Response> => {
				const u = String(url);
				const body = u.endsWith("/tasks/R-1")
					? detailBody
					: u.endsWith("/tasks/R-1/context")
						? { context: null }
						: u.endsWith("/tasks/P-1")
							? parkedDetail
							: u.endsWith("/tasks/P-1/context")
								? { context: null }
								: u.endsWith("/tasks/PR-1")
									? proposalDetail
									: u.endsWith("/tasks/PR-1/context")
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
		},
	);
	const host = globalThis as unknown as Record<string, unknown>;
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

	const _project = listProject;
	const base = listBaseRead;

	/** Mounts the drawer for a task row and flushes the detail fetch. */
	const mountDrawer = async (
		task: TaskCard,
	): Promise<{
		container: HTMLElement;
		unmount: () => Promise<void>;
	}> => {
		const { container, unmount } = await mount(
			<Drawer {...base} task={task} />,
		);
		await act(async () => {});
		return {
			container,
			// Inside act, so no callback survives the test into the next one.
			unmount: async () => {
				await unmount();
			},
		};
	};

	/** One settled run row for R-1; only the id and dispatched model vary. */
	const turnRow = (id: number, dispatchedModel: string | null) => ({
		id,
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
		dispatchedModel,
	});

	/** Mounts the done research row R-1 and opens the drawer. */
	const mountDoneRow = async () => {
		const row = cardFixture({
			id: "R-1",
			kind: "work",
			research: true,
			stage: "done",
			state: "idle",
			...rowFields,
		});
		const { container, unmount } = await mountDrawer(row);
		return { container, unmount };
	};

	test("the drawer renders the prompt from the task route, not the row", async () => {
		// The row carries no prompt (OTTR-965): the first paint holds the section's
		// loading line without crashing, then the fetched prompt text renders.
		// The detail fetch waits on a deferred promise. The test releases the body
		// after the first paint, so the loading line stays observable.
		const { promise: detailLanding, resolve: resolveDetail } =
			Promise.withResolvers<TaskView>();
		// This body matches the shape that the other mocks in this describe serve
		// for a read-only card.
		const deferredDetail = {
			...cardFixture({
				id: "R-1",
				stage: "done",
				state: "idle",
				research: true,
			}),
			prompt: "Loaded from the task route",
			...drawerExtras,
		} as unknown as TaskView;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const u = String(input);
			if (u.endsWith("/tasks/R-1")) {
				const body = await detailLanding;
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return realFetch(input, init);
		}) as unknown as typeof fetch;
		const { container, unmount } = await mount(
			<Drawer
				{...base}
				task={cardFixture({
					id: "R-1",
					stage: "done",
					state: "idle",
					research: true,
				})}
			/>,
		);
		try {
			expect(
				container.querySelector('[aria-label="Loading the prompt"]'),
			).not.toBeNull();
			expect(container.textContent).not.toContain("Loaded from the task route");
			await act(async () => {
				resolveDetail(deferredDetail);
			});
			await act(async () => {});
			expect(container.textContent).toContain("Loaded from the task route");
			expect(
				container.querySelector('[aria-label="Loading the prompt"]'),
			).toBeNull();
			// The read-only card renders the loaded text without an Edit button.
			expect(container.querySelector(".prompt-text")).not.toBeNull();
			expect(container.textContent).not.toContain("Edit task");
		} finally {
			globalThis.fetch = realFetch;
			await unmount();
		}
	});

	test("an editable card offers Edit task once the prompt lands", async () => {
		const { container, unmount } = await mountDrawer(
			cardFixture({ id: "P-1", stage: "backlog", state: "idle" }),
		);
		try {
			expect(container.querySelector(".task-prompt")).not.toBeNull();
			expect(container.textContent).toContain("parked idea");
			expect(container.textContent).toContain("Edit task");
		} finally {
			await unmount();
		}
	});

	test("a proposal's prompt slots fill in when the detail lands", async () => {
		const { container, unmount } = await mountDrawer(
			cardFixture({
				id: "PR-1",
				stage: "todo",
				state: "needs_you",
				needsReason:
					"Retro proposal from t3. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
			}),
		);
		try {
			// Without a stored summary the loaded prompt's first paragraph becomes
			// the decision facts, and the full prompt sits collapsed under it.
			expect(container.querySelector(".decide-fallback")).not.toBeNull();
			expect(container.textContent).toContain("Loaded from the task route");
			expect(container.innerHTML).toMatch(
				/<summary><svg class="chev"[\s\S]*?<\/svg>Full prompt<\/summary>/,
			);
		} finally {
			await unmount();
		}
	});

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

	test("the work check rows name the role each check ran with", async () => {
		// OTTR-916: the row names the role the model came from. A fallback check
		// (picked role unset, model from the default role) reads "default role",
		// a record written before the field existed renders without a role, and
		// a routed check names its own role (OTTR-1116).
		const at = 1_700_000_000_000;
		detailBody.workCheckLog = [
			{
				at,
				model: "openai/gpt-6",
				role: "adversary",
				outcome: "pass",
				blockers: [],
				notes: [],
				durationMs: 41_000,
			},
			{
				at,
				model: "fake/default-model",
				role: "default",
				outcome: "pass",
				blockers: [],
				notes: [],
				durationMs: 12_000,
			},
			{
				at,
				model: null,
				role: "default",
				outcome: "error",
				blockers: [],
				notes: [],
				durationMs: 0,
				error: "lost",
			},
			{
				at,
				model: "zai/glm-5.3-flash",
				outcome: "pass",
				blockers: [],
				notes: [],
				durationMs: 9_000,
			},
			{
				at,
				model: "zai/glm-5.3-flash",
				role: "reviewer",
				outcome: "pass",
				blockers: [],
				notes: [],
				durationMs: 3_000,
			},
		] as unknown as typeof detailBody.workCheckLog;

		const { container, unmount } = await mountDoneRow();
		try {
			const rows = container.querySelectorAll(".wc-run");
			expect(rows.length).toBe(5);
			const texts = Array.from(rows, (p) => p.textContent ?? "");
			const [adversary, fallback, fallbackDefault, legacy, routed] = texts;
			expect(adversary).toContain("adversary");
			expect(adversary).toContain("gpt-6");
			expect(fallback).toContain("default role");
			expect(fallback).toContain("default-model");
			expect(fallback).not.toContain("critic");
			expect(fallback).not.toContain("adversary");
			// No model, no role to name: the row stays "default model" alone.
			expect(fallbackDefault).toContain("default model");
			expect(fallbackDefault).not.toContain("default role");
			expect(fallbackDefault).not.toContain("critic");
			expect(fallbackDefault).not.toContain("adversary");
			expect(legacy).toContain("glm-5.3-flash");
			expect(legacy).not.toContain("critic");
			expect(legacy).not.toContain("adversary");
			expect(legacy).not.toContain("default role");
			// A routing rule's own role shows by name with its model.
			expect(routed).toContain("reviewer");
			expect(routed).toContain("glm-5.3-flash");
			expect(routed).not.toContain("default role");
			expect(routed).not.toContain("critic");
			expect(routed).not.toContain("adversary");
		} finally {
			await act(async () => {
				detailBody.workCheckLog = [];
			});
			await unmount();
		}
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
		const swapped = turnRow(1, "anthropic/claude-opus-5-5:medium");
		detailBody.turns = [swapped] as unknown as typeof detailBody.turns;
		const { container, unmount } = await mountDoneRow();
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
		const steady = turnRow(2, null);
		detailBody.turns = [steady] as unknown as typeof detailBody.turns;
		const { container, unmount } = await mountDoneRow();
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
		const { container, unmount } = await mountDoneRow();
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
		const { container, unmount } = await mountDoneRow();
		try {
			expect(container.innerHTML).toContain("Follow up");
			expect(container.innerHTML).not.toContain("Implement steps");
		} finally {
			await unmount();
		}
	});
});

describe("Drawer of a cancelled card opens read-only", () => {
	const _project = listProject;
	const base = listBaseRead;

	test("a cancelled done card keeps its story and loses every action", () => {
		const dead = cardFixture({
			...drawerFields,
			id: "D-1",
			stage: "done",
			state: "idle",
			cancelledAt: 1760000000000,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={dead} />);
		// Read-only does not mean blind: the cancel stamp and the log stay; the prompt
		// and the summary land with the detail fetch (OTTR-965), so the section holds
		// its loading line here.
		expect(html).toContain('aria-label="Loading the prompt"');
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
		run: null,
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
			prompt: "review the draft",
			summary: null,
			gate: null,
			workCheckLog: [],
			workCheckReport: null,
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

	test("a closed pr_review drawer says the PR closed without a merge", () => {
		const html = section(
			waitingReview(),
			"## Summary\nreview",
			prView("closed"),
		);
		expect(html).toContain("closed without merge");
	});

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

	test("the drawer lists the fixed threads the post will resolve", () => {
		const two = section(waitingReview(), "## Summary\nreview", {
			...prView("open"),
			willResolve: [
				{ id: 9001, path: "src/a.ts", line: 12 },
				{ id: 9002, path: "src/b.ts", line: 30 },
			],
		});
		expect(two).toContain("pr-resolve-hint");
		expect(two).toContain(
			"Posting will resolve 2 fixed-finding threads: src/a.ts:12, src/b.ts:30",
		);
		// A blocked post never resolves anything, so it never shows the hint.
		const posted = section(waitingReview(), "## Summary\nreview", {
			...prView("open"),
			postedHead: "c".repeat(40),
			willResolve: [{ id: 9001, path: "src/a.ts", line: 12 }],
		});
		expect(postButton(posted)).toContain("disabled");
		expect(posted).not.toContain("pr-resolve-hint");
		// One thread names itself singular.
		const one = section(waitingReview(), "## Summary\nreview", {
			...prView("open"),
			willResolve: [{ id: 9001, path: "src/a.ts", line: 12 }],
		});
		expect(one).toContain(
			"Posting will resolve 1 fixed-finding thread: src/a.ts:12",
		);
		// No pending fixed findings: no hint either.
		const none = section(waitingReview(), "## Summary\nreview");
		expect(none).not.toContain("pr-resolve-hint");
	});

	// The ask composer mirrors the card's last draft run (docs/specs/pr-reviews.md,
	// "Draft runs"): in flight shows the spinner line, a failed run shows its error,
	// and a clean end names the draft ready — the record is the status, so it also
	// survives the section remount a moved head causes.
	test("a draft run in flight shows Writing a new draft beside the composer", () => {
		const html = section(waitingReview(), "## Summary\nreview", {
			...prView("open"),
			run: { startedAt: 1_000, endedAt: null, error: null, model: "@plan" },
		});
		expect(html).toContain("Writing a new draft...");
		expect(html).toMatch(
			/class="dim"><span class="spinner" aria-hidden="true"><\/span> Writing/,
		);
		expect(html).not.toContain("New draft ready.");
	});

	test("a failed draft run shows its error with role alert", () => {
		const html = section(waitingReview(), "## Summary\nreview", {
			...prView("open"),
			run: {
				startedAt: 1_000,
				endedAt: 1_500,
				error: "gateway down",
				model: "@plan",
			},
		});
		expect(html).toContain('role="alert"');
		expect(html).toContain("gateway down");
		expect(html).not.toContain("Writing a new draft...");
		expect(html).not.toContain("New draft ready.");
	});

	test("a clean ended run shows New draft ready without an ask", () => {
		const html = section(waitingReview(), "## Summary\nreview", {
			...prView("open"),
			run: {
				startedAt: 1_000,
				endedAt: 1_500,
				error: null,
				model: "@plan",
			},
		});
		expect(html).toContain("New draft ready.");
		expect(html).not.toContain("Writing a new draft...");
	});

	// The head moved between the ask and the run's end: requestReview refreshed the
	// head, savePrDraft wrote the new reviewed_head, and the drawer's reviewedHead
	// key remounts the section. The fresh mount still sees the ended run and shows
	// its result (OTTR-1073 send-back).
	test("a fresh mount after a head move shows the landed run's result", () => {
		const moved = section(
			{
				...waitingReview(),
				prReview: { ...prView("open"), reviewedHead: "d".repeat(40) },
			} as TaskCard,
			"## Summary\nreview of the new head",
			{
				...prView("open"),
				reviewedHead: "d".repeat(40),
				run: {
					startedAt: 2_000,
					endedAt: 2_500,
					error: null,
					model: "@plan",
				},
			},
		);
		expect(moved).toContain("New draft ready.");
		expect(moved).toContain("review of the new head");
	});
});

// The run status after a real ask needs the noteFor state, so these tests mount
// PrReviewSection on happy-dom (the same swap as the drawer mount tests above).
describe("PR review draft-run status on a mounted ask composer", () => {
	installBrowserGlobals([
		"Event",
		"HTMLElement",
		"HTMLInputElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	const project = listProject;
	const drawerBase = {
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
	const prView = (run: PrRunState | null): PrReviewView => ({
		number: 7,
		url: "https://github.com/acme/widget/pull/7",
		state: "open",
		reviewedHead: "c".repeat(40),
		postedHead: null,
		postedUrl: null,
		postedLogin: null,
		postError: null,
		run,
	});
	const draft = "## Summary\nreview";
	const card = (): TaskCard =>
		cardFixture({
			...({
				kind: "pr_review",
				report: null,
				details: draft,
				branch: null,
				model: null,
				worktree: null,
				sessionId: null,
				images: [],
				pendingImages: [],
				shots: [],
				keptFiles: [],
				workCheckLog: [],
			} as unknown as Partial<TaskCard>),
			id: "P-5",
			stage: "in_progress",
			state: "needs_you",
			prReview: prView(null),
		});
	const view = (cardRow: TaskCard): TaskView => ({
		...cardRow,
		turns: [],
		details: draft,
		report: null,
		diffFiles: null,
		prompt: "review the draft",
		summary: null,
		gate: null,
		workCheckLog: [],
		workCheckReport: null,
	});
	/** The React prop handler on a node; happy-dom events never reach React's plugins. */
	const propOf = (
		node: Element,
		name: "onClick" | "onChange",
	): ((e: unknown) => void) => {
		const key = Object.getOwnPropertyNames(node).find((k) =>
			k.startsWith("__reactProps$"),
		);
		if (key === undefined) throw new Error("react props missing on node");
		const fn = (
			(node as unknown as Record<string, unknown>)[key] as Record<
				string,
				((e: unknown) => void) | undefined
			>
		)[name];
		if (fn === undefined) throw new Error(`node has no ${name}`);
		return fn;
	};
	// Minimal Act: run the work, hand a failure to the composer's inline error.
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

	test("an ask shows Writing a new draft, then the failed run's error", async () => {
		const posts: { url: string; body: string }[] = [];
		const { restore } = stubFetch(async (url, init) => {
			if (url.endsWith("/tasks/P-5/reply") && init?.method === "POST") {
				posts.push({ url, body: String(init.body) });
				return new Response(JSON.stringify({ ok: true }));
			}
			return new Response("{}", { status: 404 });
		});
		const { container, root, unmount } = await mount(
			<PrReviewSection
				task={view(card())}
				pr={prView(null)}
				draft={draft}
				act={actProp}
				onLoaded={() => {}}
			/>,
		);
		try {
			const note = container.querySelector(
				"#pr-review-note",
			) as unknown as HTMLTextAreaElement;
			expect(note).not.toBeNull();
			await act(async () => {
				propOf(note, "onChange")({ target: { value: "Cover the retry path" } });
			});
			const ask = [...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Ask for draft",
			);
			expect(ask).toBeDefined();
			await act(async () => {
				propOf(ask as unknown as Element, "onClick")({});
			});
			// The POST answered and no run record reached the view yet: the spinner
			// line shows, the field is cleared, and the note went out as the reply.
			expect(container.textContent).toContain("Writing a new draft...");
			expect(note.value).toBe("");
			expect(posts).toHaveLength(1);
			expect(JSON.parse(posts[0]!.body)).toEqual({
				text: "Cover the retry path",
			});
			// The run record arrives ended with an error: the spinner line gives way
			// to the error, still keyed to the untouched field.
			await act(async () => {
				root.render(
					<PrReviewSection
						task={view(card())}
						pr={prView({
							startedAt: 1_000,
							endedAt: 1_500,
							error: "gateway down",
							model: "@plan",
						})}
						draft={draft}
						act={actProp}
						onLoaded={() => {}}
					/>,
				);
			});
			expect(container.textContent).toContain("gateway down");
			expect(container.textContent).not.toContain("Writing a new draft...");
			const alert = container.querySelector('[role="alert"]');
			expect(alert?.textContent).toBe("gateway down");
		} finally {
			await unmount();
			restore();
		}
	});

	test("a landed draft flips the status to New draft ready, typing hides it", async () => {
		const { restore } = stubFetch(
			async () => new Response(JSON.stringify({ ok: true })),
		);
		const { container, root, unmount } = await mount(
			<PrReviewSection
				task={view(card())}
				pr={prView(null)}
				draft={draft}
				act={actProp}
				onLoaded={() => {}}
			/>,
		);
		try {
			const note = container.querySelector(
				"#pr-review-note",
			) as unknown as HTMLTextAreaElement;
			await act(async () => {
				propOf(note, "onChange")({ target: { value: "Look at the loop" } });
			});
			const ask = [...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Ask for draft",
			);
			await act(async () => {
				propOf(ask as unknown as Element, "onClick")({});
			});
			// The run ended clean and its draft landed on the card: the new draft is
			// the one the drawer now holds, so the status names it ready.
			await act(async () => {
				root.render(
					<PrReviewSection
						task={view(card())}
						pr={prView({
							startedAt: 2_000,
							endedAt: 2_400,
							error: null,
							model: "@plan",
						})}
						draft={"## Summary\nrewritten review"}
						act={actProp}
						onLoaded={() => {}}
					/>,
				);
			});
			expect(container.textContent).toContain("New draft ready.");
			expect(container.textContent).not.toContain("Writing a new draft...");
			// The unedited review box follows the landed draft.
			const box = container.querySelector(
				"#pr-review-text",
			) as unknown as HTMLTextAreaElement;
			expect(box.value).toBe("## Summary\nrewritten review");
			// The status is the run record, not the typed text: typing the next ask
			// leaves it up until that ask's own run arrives.
			await act(async () => {
				propOf(note, "onChange")({ target: { value: "One more pass" } });
			});
			expect(container.textContent).toContain("New draft ready.");
			// The next run arriving in flight replaces the result with the spinner.
			await act(async () => {
				root.render(
					<PrReviewSection
						task={view(card())}
						pr={prView({
							startedAt: 3_000,
							endedAt: null,
							error: null,
							model: "@plan",
						})}
						draft={"## Summary\nrewritten review"}
						act={actProp}
						onLoaded={() => {}}
					/>,
				);
			});
			expect(container.textContent).toContain("Writing a new draft...");
			expect(container.textContent).not.toContain("New draft ready.");
		} finally {
			await unmount();
			restore();
		}
	});

	test("an edited review box keeps the user's text when a draft lands", async () => {
		const { restore } = stubFetch(
			async () => new Response(JSON.stringify({ ok: true })),
		);
		const { container, root, unmount } = await mount(
			<PrReviewSection
				task={view(card())}
				pr={prView(null)}
				draft={draft}
				act={actProp}
				onLoaded={() => {}}
			/>,
		);
		try {
			const box = container.querySelector(
				"#pr-review-text",
			) as unknown as HTMLTextAreaElement;
			await act(async () => {
				propOf(box, "onChange")({ target: { value: "my own edit" } });
			});
			await act(async () => {
				root.render(
					<PrReviewSection
						task={view(card())}
						pr={prView({
							startedAt: 2_000,
							endedAt: 2_400,
							error: null,
							model: "@plan",
						})}
						draft="## Summary\nrewritten review"
						act={actProp}
						onLoaded={() => {}}
					/>,
				);
			});
			// The user's edit wins over the landed draft. The status still names the
			// clean run: it rides the run record, not the composer's own ask.
			expect(
				(
					container.querySelector(
						"#pr-review-text",
					) as unknown as HTMLTextAreaElement
				).value,
			).toBe("my own edit");
			expect(container.textContent).toContain("New draft ready.");
		} finally {
			await unmount();
			restore();
		}
	});

	test("a second ask waits past the stale ended record and shows the new run", async () => {
		const { restore } = stubFetch(
			async () => new Response(JSON.stringify({ ok: true })),
		);
		const { container, root, unmount } = await mount(
			<PrReviewSection
				task={view(card())}
				pr={prView({
					startedAt: 1_000,
					endedAt: 1_400,
					error: null,
					model: "@plan",
				})}
				draft={draft}
				act={actProp}
				onLoaded={() => {}}
			/>,
		);
		try {
			// The card already holds a clean ended run from an earlier ask.
			const note = container.querySelector(
				"#pr-review-note",
			) as unknown as HTMLTextAreaElement;
			await act(async () => {
				propOf(note, "onChange")({ target: { value: "Second pass" } });
			});
			const ask = [...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Ask for draft",
			);
			await act(async () => {
				propOf(ask as unknown as Element, "onClick")({});
			});
			// The stale ended record must not end the wait before the new run lands.
			await act(async () => {
				root.render(
					<PrReviewSection
						task={view(card())}
						pr={prView({
							startedAt: 1_000,
							endedAt: 1_400,
							error: null,
							model: "@plan",
						})}
						draft={draft}
						act={actProp}
						onLoaded={() => {}}
					/>,
				);
			});
			expect(container.textContent).toContain("Writing a new draft...");
			// The wait is exclusive: the stale record's result must not show beside
			// the spinner while this ask waits for its own run.
			expect(container.textContent).not.toContain("New draft ready.");
			// The ask's own run arrives, still in flight: the spinner stays.
			await act(async () => {
				root.render(
					<PrReviewSection
						task={view(card())}
						pr={prView({
							startedAt: 2_000,
							endedAt: null,
							error: null,
							model: "@plan",
						})}
						draft={draft}
						act={actProp}
						onLoaded={() => {}}
					/>,
				);
			});
			expect(container.textContent).toContain("Writing a new draft...");
			// It ends failed: the error replaces the spinner.
			await act(async () => {
				root.render(
					<PrReviewSection
						task={view(card())}
						pr={prView({
							startedAt: 2_000,
							endedAt: 2_400,
							error: "gateway down",
							model: "@plan",
						})}
						draft={draft}
						act={actProp}
						onLoaded={() => {}}
					/>,
				);
			});
			expect(container.textContent).toContain("gateway down");
			expect(container.textContent).not.toContain("Writing a new draft...");
		} finally {
			await unmount();
			restore();
		}
	});

	// A pr_review card has no turns: its Work steps section shows the card log
	// through LogView, so the draft-run lines live-update like a turn's output.
	test("a pr_review drawer's Work steps show the card log, not No turns yet", async () => {
		const logText =
			"== pr review draft 2026-11-16T10:00:00.000Z (model @plan)\n" +
			"- draft saved 2026-11-16T10:00:30.000Z (took 30s)\n";
		const { restore } = stubFetch(async (url) => {
			if (url.endsWith("/tasks/P-5")) {
				return new Response(JSON.stringify(view(card())), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.endsWith("/tasks/P-5/context")) {
				return new Response(JSON.stringify({ context: null }));
			}
			if (url.includes("/tasks/P-5/log?")) {
				return new Response(logText, {
					headers: {
						"X-Log-Size": String(new TextEncoder().encode(logText).length),
					},
				});
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mount(
			<Drawer {...drawerBase} task={card()} />,
		);
		try {
			await act(async () => {
				await Bun.sleep(10);
			});
			const log = container.querySelector("#drawer-steps pre.log");
			expect(log).not.toBeNull();
			expect(log?.textContent).toContain("== pr review draft");
			expect(log?.textContent).toContain("draft saved");
			expect(container.textContent).not.toContain("No turns yet.");
		} finally {
			await unmount();
			restore();
		}
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
	function jsonStub(responses: Array<{ status: number; body: unknown }>) {
		const calls: string[] = [];
		const bodies: unknown[] = [];
		const real = globalThis.fetch;
		stubFetch(async (url, init) => {
			calls.push(String(url));
			bodies.push(JSON.parse(String(init?.body)));
			const next = responses.shift()!;
			return new Response(JSON.stringify(next.body), { status: next.status });
		});
		return {
			calls,
			bodies,
			restore: () => {
				globalThis.fetch = real;
			},
		};
	}

	test("clears the pin after the follow-up lands on the picked model, then hands off", async () => {
		const stub = jsonStub([
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
		const stub = jsonStub([
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
		const stub = jsonStub([{ status: 500, body: { error: "nope" } }]);
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
	const bodies: Array<{ url: string; body: unknown }> = [];
	const { window } = installBrowserGlobals(
		[
			"Event",
			"HTMLTextAreaElement",
			"Node",
			"getComputedStyle",
			"requestAnimationFrame",
			"cancelAnimationFrame",
		],
		{
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
		},
	);
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
	const drawerBase = listBaseReadonly;

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
			doneTotal: 1,
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
	const { window } = installBrowserGlobals([
		"HTMLElement",
		"HTMLInputElement",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	/** A React onChange picks up programmatic edits only through the native value setter (see settings.test.tsx). */
	/** Types and fires the native change in one act scope. */
	const typeAndSearch = async (
		el: HTMLInputElement,
		value: string,
	): Promise<void> => {
		await act(async () => {
			typeInto(el, value);
			onChangeOf(el)({ target: { value } });
		});
	};
	const typeInto = typeIntoFor(window);

	/** The board with three queued cards: "docs" matches exactly one. */
	async function mountBoard(): Promise<{
		container: HTMLDivElement;
		input: HTMLInputElement;
		unmount: () => Promise<void>;
	}> {
		const tasks = [
			cardFixture({ id: "t1", title: "Fix bug", sessionTitle: "Fix bug" }),
			cardFixture({
				id: "t2",
				title: "Write docs",
				sessionTitle: "Write docs",
			}),
			cardFixture({ id: "t3", title: "Add icon", sessionTitle: "Add icon" }),
		];
		const project = boardProject(0);
		const { container, unmount } = await mountProjectBoard(project, tasks);
		const input = container.querySelector(
			'input[aria-label="Search tasks"]',
		) as HTMLInputElement | null;
		if (input === null) throw new Error("search input missing");
		return {
			container,
			input,
			unmount: async () => {
				await unmount();
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
			await typeAndSearch(input, "docs");
			// Inside the wait window the deadline has not passed: nothing filters.
			await act(async () => {
				await Bun.sleep(SEARCH_APPLY_MS - 100);
			});
			expect(count()).toBe("3");
			expect(cards().sort()).toEqual(["t1", "t2", "t3"]);
			// Past the deadline, one card matches. The board's fetch carries no mock
			// here, so the done search fails: the count marks the done matches
			// unknown instead of posing the window's count as the whole result.
			await act(async () => {
				await Bun.sleep(SEARCH_APPLY_MS + 60);
			});
			expect(count()).toBe("—/3");
			expect(cards()).toEqual(["t2"]);
			// Clearing waits the same way, then brings every card back.
			await typeAndSearch(input, "");
			await act(async () => {
				await Bun.sleep(SEARCH_APPLY_MS - 100);
			});
			expect(count()).toBe("—/3");
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
	const { window } = installBrowserGlobals([
		"HTMLElement",
		"HTMLInputElement",
		// The lane's Show more handler reads Node.DOCUMENT_POSITION_PRECEDING;
		// happy-dom exposes it on its own Window only.
		"Node",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	test("the done lane shows the state window and Show more fetches the server pages", async () => {
		const fetches: string[] = [];
		// The state holds only the newest window (OTTR-965): 20 held cards here, five
		// older ones on the server. "Show more" fetches page 2; the head count and the
		// button label read doneTotal, the project's true done+cancelled size.
		const held = Array.from({ length: 20 }, (_, j) =>
			cardFixture({ id: `d${j}`, stage: "done", state: "idle", doneAt: j + 1 }),
		);
		const olderPage = Array.from({ length: 5 }, (_, j) =>
			cardFixture({ id: `o${j}`, stage: "done", state: "idle", doneAt: j - 5 }),
		);
		const project = {
			name: "proj",
			hasRules: true,
			github: null,
			gitless: false,
			dirty: false,
			archReview: null,
			latestRelease: null,
			latestImage: null,
			doneTotal: held.length + olderPage.length,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
		} as unknown as ProjectView;
		const { restore } = stubFetch(async (url) => {
			const u = String(url);
			if (u === "/api/projects/proj/done?page=2") {
				fetches.push(u);
				return new Response(JSON.stringify({ tasks: olderPage, total: 25 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mountProjectBoard(project, held);
		try {
			const lane = container.querySelector('[data-stage="done"]');
			expect(lane).not.toBeNull();
			// The switch is gone for good: no view-toggle element anywhere, and the
			// done stage head renders no tools but the lane-wide "Show more" button.
			expect(container.querySelector(".view-toggle")).toBeNull();
			expect(container.textContent).not.toContain("By topic");
			expect(container.textContent).not.toContain("By time");
			const ids = (): string[] =>
				[...lane!.querySelectorAll("[data-task-id]")].map(
					(el) => el.getAttribute("data-task-id") ?? "",
				);
			// The window renders newest landed first; the head count reads the true total.
			expect(ids()).toEqual([...held].sort(newestLanded).map((t) => t.id));
			expect(lane!.querySelector(".count")?.textContent).toBe("25");
			// One lane-wide "Show more" carries the hidden count in its label.
			const more = lane!.querySelector<HTMLButtonElement>("button.lane-more");
			expect(more?.getAttribute("aria-label")).toBe("Show more, 5 older cards");
			await act(async () => {
				more!.click();
			});
			await act(async () => {});
			// The fetched page appends below the window, still newest landed first.
			expect(fetches).toEqual(["/api/projects/proj/done?page=2"]);
			expect(ids()).toEqual(
				[...held, ...olderPage].sort(newestLanded).map((t) => t.id),
			);
			// Every card the server holds is on the board now: the button is gone.
			expect(lane!.querySelector("button.lane-more")).toBeNull();
		} finally {
			await unmount();
			restore();
		}
	});

	test("Show more keeps advancing pages when a page holds pinned cards", async () => {
		const fetches: string[] = [];
		// The server pins starred past the window into the state (boardCards) but
		// slices every page over all settled cards (donePage): page 2 here carries
		// the starred card plus only 19 older ones. Counting the held cards repeats
		// page 2 forever (OTTR-975); the counter must advance on every success.
		const held = Array.from({ length: 20 }, (_, j) =>
			cardFixture({ id: `d${j}`, stage: "done", state: "idle", doneAt: j + 1 }),
		);
		const pinned = cardFixture({
			id: "s0",
			stage: "done",
			state: "idle",
			starred: true,
			doneAt: 0,
		});
		const older = Array.from({ length: 40 }, (_, j) =>
			cardFixture({
				id: `o${j}`,
				stage: "done",
				state: "idle",
				doneAt: -(j + 1),
			}),
		);
		const settled = [...held, pinned, ...older].sort(newestLanded);
		const project = {
			name: "proj",
			hasRules: true,
			github: null,
			gitless: false,
			dirty: false,
			archReview: null,
			latestRelease: null,
			latestImage: null,
			doneTotal: settled.length,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
		} as unknown as ProjectView;
		const { restore } = stubFetch(async (url) => {
			const u = String(url);
			const m = /^\/api\/projects\/proj\/done\?page=(\d+)$/.exec(u);
			if (m) {
				const page = Number(m[1]);
				fetches.push(u);
				// donePage slices every settled card, pinned ones included.
				const tasks = settled.slice((page - 1) * 20, page * 20);
				return new Response(JSON.stringify({ tasks, total: settled.length }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mountProjectBoard(project, [
			...held,
			pinned,
		]);
		try {
			const lane = container.querySelector('[data-stage="done"]');
			const ids = (): string[] =>
				[...lane!.querySelectorAll("[data-task-id]")].map(
					(el) => el.getAttribute("data-task-id") ?? "",
				);
			const more = lane!.querySelector<HTMLButtonElement>("button.lane-more");
			// The state holds the window and the pinned starred card only.
			expect([...ids()].sort()).toEqual(
				[...held.map((t) => t.id), "s0"].sort(),
			);
			expect(more!.getAttribute("aria-label")).toBe(
				"Show more, 40 older cards",
			);
			// Click 1: page 2 carries the starred card plus 19 older ones, so the
			// board adds 19 and the hidden count drops 40 -> 21.
			await act(async () => {
				more!.click();
			});
			await act(async () => {});
			expect(fetches).toEqual(["/api/projects/proj/done?page=2"]);
			// 21 held plus 19 new: the fetched starred copy deduped away.
			expect(ids()).toHaveLength(40);
			expect(more!.getAttribute("aria-label")).toBe(
				"Show more, 21 older cards",
			);
			// Click 2 must move on to page 3, not repeat page 2.
			await act(async () => {
				more!.click();
			});
			await act(async () => {});
			expect(fetches).toEqual([
				"/api/projects/proj/done?page=2",
				"/api/projects/proj/done?page=3",
			]);
			expect(more!.getAttribute("aria-label")).toBe("Show more, 1 older cards");
			// Click 3: page 4 holds the last older card.
			await act(async () => {
				more!.click();
			});
			await act(async () => {});
			expect(fetches).toEqual([
				"/api/projects/proj/done?page=2",
				"/api/projects/proj/done?page=3",
				"/api/projects/proj/done?page=4",
			]);
			// All 61 settled cards are on the board now: all 40 older ones revealed,
			// the starred card still rendered once, the button gone.
			expect([...ids()].sort()).toEqual(settled.map((t) => t.id).sort());
			expect(lane!.querySelector("button.lane-more")).toBeNull();
		} finally {
			await unmount();
			restore();
		}
	});

	/** A React onChange picks up programmatic edits only through the native value setter (see settings.test.tsx). */
	const typeInto = typeIntoFor(window);

	/** Types and fires the native change in one act scope. */
	const typeAndSearch = async (
		el: HTMLInputElement,
		value: string,
	): Promise<void> => {
		await act(async () => {
			typeInto(el, value);
			onChangeOf(el)({ target: { value } });
		});
	};
	/** One act past the search apply window. */
	const searchSettle = async (): Promise<void> => {
		await act(async () => {
			await Bun.sleep(SEARCH_APPLY_MS + 100);
		});
	};

	test("a search query fetches the server's matching Done cards", async () => {
		const fetches: string[] = [];
		// The state holds only the Done window (OTTR-965): 20 held cards here, none
		// matching, while the one card that matches "prompt" lives only on the
		// server's page for the query. Typing must fetch it, the head and the search
		// count must read the server's total, and clearing must restore the held
		// window with no fetch for the empty query.
		const held = Array.from({ length: 20 }, (_, j) =>
			cardFixture({
				id: `d${j}`,
				title: "plain j",
				stage: "done",
				state: "idle",
				doneAt: j + 1,
			}),
		);
		const found = cardFixture({
			id: "o0",
			title: "fix the prompt flow",
			sessionTitle: "fix the prompt flow",
			stage: "done",
			state: "idle",
			doneAt: -50,
		});
		const project = boardProject(61);
		const { restore } = stubFetch(async (url) => {
			const u = String(url);
			if (u === "/api/projects/proj/done?page=1&q=prompt") {
				fetches.push(u);
				return new Response(JSON.stringify({ tasks: [found], total: 1 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mountProjectBoard(project, held);
		try {
			const lane = container.querySelector('[data-stage="done"]');
			expect(lane).not.toBeNull();
			const ids = (): string[] =>
				[...lane!.querySelectorAll("[data-task-id]")].map(
					(el) => el.getAttribute("data-task-id") ?? "",
				);
			const input = container.querySelector(
				'input[aria-label="Search tasks"]',
			) as HTMLInputElement;
			// Before typing: no search fetch, the held window and the plain "Show more".
			expect(fetches).toEqual([]);
			expect(ids()).toEqual([...held].sort(newestLanded).map((t) => t.id));
			expect(lane!.querySelector("button.lane-more")).not.toBeNull();
			await typeAndSearch(input, "prompt");
			await searchSettle();
			// The query fetched the server's page, and the only matching card renders
			// below the held window's absence: the lane reads the server answer.
			expect(fetches).toEqual(["/api/projects/proj/done?page=1&q=prompt"]);
			expect(ids()).toEqual(["o0"]);
			expect(lane!.querySelector(".count")?.textContent).toBe("1/1");
			expect(container.querySelector(".search-count")?.textContent).toBe(
				"1/61",
			);
			// Clearing the box brings the held window back, with no fetch for the
			// empty query.
			await typeAndSearch(input, "");
			await searchSettle();
			expect(fetches).toEqual(["/api/projects/proj/done?page=1&q=prompt"]);
			expect(ids()).toEqual([...held].sort(newestLanded).map((t) => t.id));
			expect(lane!.querySelector("button.lane-more")).not.toBeNull();
		} finally {
			await unmount();
			restore();
		}
	});

	/** Mounts the done lane board and resolves the lane id/search probes. */
	const openDoneLane = async (project: ProjectView, held: TaskCard[]) => {
		const { container, unmount } = await mountProjectBoard(project, held);
		const ids = (): string[] =>
			[
				...container
					.querySelector('[data-stage="done"]')!
					.querySelectorAll("[data-task-id]"),
			].map((el) => el.getAttribute("data-task-id") ?? "");
		const input = container.querySelector(
			'input[aria-label="Search tasks"]',
		) as HTMLInputElement;
		return { container, unmount, ids, input };
	};

	test("a late answer for an old query is dropped", async () => {
		const fetches: string[] = [];
		const promptPage = Promise.withResolvers<Response>();
		// The first prompt request stays deferred; the same URL typed again answers
		// at once with the fresh card, so the late answer must not win.
		let promptCalls = 0;
		// The "prompt" answer resolves only after the query moved on to "other": the
		// newer query owns the lane, so the stale answer must not render its card.
		const held = Array.from({ length: 20 }, (_, j) =>
			cardFixture({
				id: `d${j}`,
				title: "plain j",
				stage: "done",
				state: "idle",
				doneAt: j + 1,
			}),
		);
		const promptCard = cardFixture({
			id: "o0",
			title: "fix the prompt flow",
			sessionTitle: "fix the prompt flow",
			stage: "done",
			state: "idle",
			doneAt: -50,
		});
		const otherCard = cardFixture({
			id: "o1",
			title: "other thing",
			sessionTitle: "other thing",
			stage: "done",
			state: "idle",
			doneAt: -60,
		});
		const freshPromptCard = cardFixture({
			id: "o2",
			title: "fresh prompt answer",
			sessionTitle: "fresh prompt answer",
			stage: "done",
			state: "idle",
			doneAt: -70,
		});
		const project = boardProject(61);
		const { restore } = stubFetch(async (url) => {
			const u = String(url);
			if (u === "/api/projects/proj/done?page=1&q=prompt") {
				fetches.push(u);
				promptCalls += 1;
				if (promptCalls === 1) return promptPage.promise;
				return new Response(
					JSON.stringify({ tasks: [freshPromptCard], total: 1 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (u === "/api/projects/proj/done?page=1&q=other") {
				fetches.push(u);
				return new Response(JSON.stringify({ tasks: [otherCard], total: 1 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount, ids, input } = await openDoneLane(
			project,
			held,
		);
		const lane = container.querySelector('[data-stage="done"]');
		try {
			await typeAndSearch(input, "prompt");
			await searchSettle();
			// The prompt fetch went out and is still waiting for its answer.
			expect(fetches).toEqual(["/api/projects/proj/done?page=1&q=prompt"]);
			// The query moves on; "other" answers at once while prompt stays pending.
			await typeAndSearch(input, "other");
			await searchSettle();
			expect(fetches).toEqual([
				"/api/projects/proj/done?page=1&q=prompt",
				"/api/projects/proj/done?page=1&q=other",
			]);
			expect(ids()).toEqual(["o1"]);
			// The query comes back: the same text, a new generation. The fresh answer
			// renders at once while the first prompt request still waits.
			await typeAndSearch(input, "prompt");
			await searchSettle();
			expect(fetches).toEqual([
				"/api/projects/proj/done?page=1&q=prompt",
				"/api/projects/proj/done?page=1&q=other",
				"/api/projects/proj/done?page=1&q=prompt",
			]);
			expect(ids()).toEqual(["o2"]);
			expect(lane!.querySelector(".count")?.textContent).toBe("1/1");
			// The first prompt answer lands last: its generation is long gone, so the
			// same-text re-entry's result stays.
			await act(async () => {
				promptPage.resolve(
					new Response(JSON.stringify({ tasks: [promptCard], total: 1 }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);
				await Bun.sleep(50);
			});
			expect(ids()).toEqual(["o2"]);
			expect(lane!.querySelector(".count")?.textContent).toBe("1/1");
		} finally {
			await unmount();
			restore();
		}
	});

	test("a failed search fetch shows the retry line and Retry refetches", async () => {
		const fetches: string[] = [];
		// A rejected fetch (server down, blocked request) fails the lane the same way
		// a non-ok answer does: the short error shows, the held window stays, and the
		// Retry button refetches page 1 of the query that still stands.
		const held = Array.from({ length: 4 }, (_, j) =>
			cardFixture({
				id: `d${j}`,
				title: "plain j",
				sessionTitle: "plain j",
				stage: "done",
				state: "idle",
				doneAt: j + 1,
			}),
		);
		const project = boardProject(4);
		const { restore } = stubFetch(async (url) => {
			const u = String(url);
			if (u === "/api/projects/proj/done?page=1&q=prompt") {
				fetches.push(u);
				throw new Error("blocked");
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mountProjectBoard(project, held);
		try {
			const lane = container.querySelector('[data-stage="done"]');
			expect(lane).not.toBeNull();
			const input = container.querySelector(
				'input[aria-label="Search tasks"]',
			) as HTMLInputElement;
			await typeAndSearch(input, "prompt");
			await searchSettle();
			// The rejection shows the short error with its retry control. The lane reads
			// the server answer only: with the page failed and no answer, it holds no
			// cards and never poses the empty lane as a complete result.
			expect(fetches).toEqual(["/api/projects/proj/done?page=1&q=prompt"]);
			expect(container.textContent).toContain("Search failed");
			// The header count marks the done matches unknown instead of repeating
			// the state window's count as the whole result.
			expect(container.querySelector(".search-count")?.textContent).toBe("—/4");
			expect(lane!.querySelector("button.lane-retry")).not.toBeNull();
			expect(lane!.textContent).toContain("No matches.");
			expect(lane!.querySelectorAll("[data-task-id]")).toHaveLength(0);
			// Retry refetches the same page 1 of the standing query.
			const retry = lane!.querySelector<HTMLButtonElement>("button.lane-retry");
			await act(async () => {
				retry!.click();
			});
			await act(async () => {});
			expect(fetches).toEqual([
				"/api/projects/proj/done?page=1&q=prompt",
				"/api/projects/proj/done?page=1&q=prompt",
			]);
		} finally {
			await unmount();
			restore();
		}
	});

	test("a Done-lane data change refetches the standing search", async () => {
		const fetches: string[] = [];
		let searchCalls = 0;
		// The cached matching total describes a snapshot. When the lane's own data
		// moves (another matching card settles), the search restarts at page 1, so
		// the lane head and the search count keep describing the cards instead of
		// drifting apart ("2/1" beside a cached total of 1).
		const held = Array.from({ length: 20 }, (_, j) =>
			cardFixture({
				id: `d${j}`,
				title: "plain j",
				sessionTitle: "plain j",
				stage: "done",
				state: "idle",
				doneAt: j + 1,
			}),
		);
		const firstMatch = cardFixture({
			id: "o0",
			title: "fix the prompt flow",
			sessionTitle: "fix the prompt flow",
			stage: "done",
			state: "idle",
			doneAt: -50,
		});
		const landedMatch = cardFixture({
			id: "m0",
			title: "more prompt work",
			sessionTitle: "more prompt work",
			stage: "done",
			state: "idle",
			doneAt: 100,
		});
		const project = boardProject(61);
		const { restore } = stubFetch(async (url) => {
			const u = String(url);
			if (u === "/api/projects/proj/done?page=1&q=prompt") {
				fetches.push(u);
				searchCalls += 1;
				// The settled card rides page 1 too: it is a settled matching card of
				// the lane, newest landed first.
				const tasks =
					searchCalls === 1 ? [firstMatch] : [landedMatch, firstMatch];
				return new Response(JSON.stringify({ tasks, total: searchCalls }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
		const { container, root, unmount } = await mount(
			<ProjectBoard
				project={project}
				tasks={held}
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
		try {
			const lane = container.querySelector('[data-stage="done"]');
			const ids = (): string[] =>
				[...lane!.querySelectorAll("[data-task-id]")].map(
					(el) => el.getAttribute("data-task-id") ?? "",
				);
			const input = container.querySelector(
				'input[aria-label="Search tasks"]',
			) as HTMLInputElement;
			await typeAndSearch(input, "prompt");
			await searchSettle();
			expect(ids()).toEqual(["o0"]);
			expect(lane!.querySelector(".count")?.textContent).toBe("1/1");
			expect(container.querySelector(".search-count")?.textContent).toBe(
				"1/61",
			);
			// Another matching card settles: the state window and the project's
			// doneTotal move. The search restarts at page 1 and the answer carries
			// the new total, so every count describes the lane again.
			await act(async () => {
				root.render(
					<ProjectBoard
						project={{ ...project, doneTotal: 62 }}
						tasks={[...held, landedMatch]}
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
			await searchSettle();
			expect(fetches).toEqual([
				"/api/projects/proj/done?page=1&q=prompt",
				"/api/projects/proj/done?page=1&q=prompt",
			]);
			expect(ids()).toEqual(["m0", "o0"]);
			expect(lane!.querySelector(".count")?.textContent).toBe("2/2");
			expect(container.querySelector(".search-count")?.textContent).toBe(
				"2/62",
			);
		} finally {
			await unmount();
			restore();
		}
	});

	test("a fetched retro counts as rendered; the match beyond page 1 keeps Show more", async () => {
		const fetches: string[] = [];
		// A real donePage response slices every settled match, so page 1 can carry
		// a retro card the state window also holds. laneColumnData keeps that
		// fetched retro (it renders like any card), and the hidden count must
		// subtract only retro matches missing from the rendered IDs — otherwise
		// the match on page 2 loses its "Show more" control.
		const held = [
			...Array.from({ length: 19 }, (_, j) =>
				cardFixture({
					id: `d${j}`,
					title: "plain j",
					sessionTitle: "plain j",
					stage: "done",
					state: "idle",
					doneAt: j + 1,
				}),
			),
			// The newest settled match is the retro itself: the server's page 1
			// contains it, and the state window holds it too.
			cardFixture({
				id: "r0",
				kind: "retro",
				title: "Retro of the heatmap work",
				sessionTitle: "Retro of the heatmap work",
				stage: "done",
				state: "idle",
				doneAt: 100,
			}),
		];
		// 21 matches: page 1 = the retro plus 19 work cards, page 2 = the last
		// matching work card (DONE_PAGE = 20).
		const work = Array.from({ length: 20 }, (_, j) =>
			cardFixture({
				id: `w${j}`,
				title: `heatmap work ${j}`,
				sessionTitle: `heatmap work ${j}`,
				stage: "done",
				state: "idle",
				doneAt: 50 - j,
			}),
		);
		const page1 = [held[19]!, ...work.slice(0, 19)];
		const page2 = [work[19]!];
		const project = boardProject(21);
		const { restore } = stubFetch(async (url) => {
			const u = String(url);
			if (u === "/api/projects/proj/done?page=1&q=heatmap") {
				fetches.push(u);
				return new Response(JSON.stringify({ tasks: page1, total: 21 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (u === "/api/projects/proj/done?page=2&q=heatmap") {
				fetches.push(u);
				return new Response(JSON.stringify({ tasks: page2, total: 21 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount, ids, input } = await openDoneLane(
			project,
			held,
		);
		const lane = container.querySelector('[data-stage="done"]');
		try {
			await typeAndSearch(input, "heatmap");
			await searchSettle();
			// Page 1 renders all 20 of its cards — the fetched retro included — and
			// the one match beyond page 1 keeps the button at exactly 1. Subtracting
			// the held retro here would hide the button and strand that card.
			expect(fetches).toEqual(["/api/projects/proj/done?page=1&q=heatmap"]);
			expect(ids()).toEqual([
				held[19]!.id,
				...work.slice(0, 19).map((t) => t.id),
			]);
			expect(lane!.querySelector(".count")?.textContent).toBe("20/21");
			// Every Done card matches here, including the hidden retro both sides
			// count: the header reads 21 matching of 21 tasks, never 21 of 20.
			expect(container.querySelector(".search-count")?.textContent).toBe(
				"21/21",
			);
			const more = lane!.querySelector<HTMLButtonElement>("button.lane-more");
			expect(more?.getAttribute("aria-label")).toBe("Show more, 1 older cards");
			// Paging to page 2 renders the last match and retires the button.
			await act(async () => {
				more!.click();
			});
			await act(async () => {});
			expect(fetches).toEqual([
				"/api/projects/proj/done?page=1&q=heatmap",
				"/api/projects/proj/done?page=2&q=heatmap",
			]);
			expect(ids()).toEqual([held[19]!.id, ...work.map((t) => t.id)]);
			expect(lane!.querySelector(".count")?.textContent).toBe("21/21");
			expect(container.querySelector(".search-count")?.textContent).toBe(
				"21/21",
			);
			expect(lane!.querySelector("button.lane-more")).toBeNull();
		} finally {
			await unmount();
			restore();
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
		const project = boardProject(3);
		const { container, unmount } = await mountProjectBoard(project, doneCards);
		try {
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
			await unmount();
		}
	});
});

describe("ProjectBoard settings shortcut", () => {
	const { window } = installBrowserGlobals([
		"HTMLElement",
		"HTMLInputElement",
		"requestAnimationFrame",
		"cancelAnimationFrame",
		"history",
		"location",
		"PopStateEvent",
	]);

	/** The board with one card; the header's actions row is what the shortcut lives in. */
	async function mountBoard(): Promise<{
		container: HTMLDivElement;
		unmount: () => Promise<void>;
	}> {
		const tasks = [cardFixture({ id: "t1", title: "Fix bug" })];
		const project = boardProject(0);
		const { container, unmount } = await mountProjectBoard(project, tasks);
		return {
			container,
			unmount: async () => {
				await unmount();
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
	installBrowserGlobals([
		"HTMLElement",
		"HTMLInputElement",
		"HTMLDialogElement",
		"requestAnimationFrame",
		"cancelAnimationFrame",
		"history",
		"location",
		"PopStateEvent",
	]);

	/** An arch review with unreviewed commits: the menu's Start review button shows. */
	const archReview = {
		delta: 2,
		reviewed: true,
		base: "abc123",
		reviewCardId: null,
		cap: 3,
		due: false,
		running: false,
		runningCardId: null as string | null,
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
		doneTotal: 0,
		sessionsDir: "/tmp/s",
	} as unknown as ProjectView;

	/** The review group the fake layer lacks: every review entry except the shipped ui-ux-check. */
	const REVIEW_NOTE =
		"Missing on workers: security-audit, codeguard, codebase-design, ponytail-audit";

	type UserLayer = Parameters<typeof ProjectBoard>[0]["userLayer"];

	async function mountBoard(
		userLayer: UserLayer,
		due = false,
		runningCardId: string | null = null,
		open: (id: string) => void = () => {},
	): Promise<{
		container: HTMLDivElement;
		unmount: () => Promise<void>;
	}> {
		const boardProject = {
			...project,
			archReview: {
				...archReview,
				due,
				running: runningCardId !== null,
				runningCardId,
			},
		};
		const { container, unmount } = await mount(
			<ProjectBoard
				project={boardProject}
				tasks={[]}
				deltas={new Map()}
				open={open}
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
		return {
			container,
			unmount: async () => {
				await unmount();
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

	test("a running review's chip links to its card and opens it in place", async () => {
		const opened: string[] = [];
		const { container, unmount } = await mountBoard(
			{ skills: [], plugins: [], rules: [], mcp: [] },
			false,
			"R-7",
			(id) => opened.push(id),
		);
		try {
			const chip = container.querySelector(".project-meta a.arch-live");
			if (chip === null) throw new Error("no review chip link");
			expect(chip.textContent).toBe("Review in progress");
			expect(chip.getAttribute("href")).toBe("/projects/proj/tasks/R-7");
			await act(async () => {
				onClickOf(chip)({
					button: 0,
					preventDefault() {},
					currentTarget: { pathname: "/projects/proj/tasks/R-7" },
				});
			});
			expect(opened).toEqual(["R-7"]);
		} finally {
			await unmount();
		}
	});

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
		const { restore } = stubFetch(
			async () =>
				new Response("no file", {
					status: 404,
				}),
		);
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
			restore();
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

describe("ConsolidationReview", () => {
	const review = (original: string, consolidated: string) =>
		renderToStaticMarkup(
			<ConsolidationReview
				original={original}
				consolidated={consolidated}
				onUse={() => {}}
				onDiscard={() => {}}
			/>,
		);
	test("a changed proposal renders add and del rows with +/- glyphs and both actions", () => {
		const html = review("keep\nold line", "keep\nnew line");
		expect(html).toContain('aria-label="Consolidation review"');
		expect(html).toContain("dl-add");
		expect(html).toContain("dl-del");
		expect(html).toContain("+");
		expect(html).toContain("\u2212");
		expect(html).toContain(">old line</span>");
		expect(html).toContain(">new line</span>");
		expect(html).toContain("Use consolidated notes");
		expect(html).toContain("Discard");
	});
	test("an identical proposal says so instead of an empty diff box", () => {
		const html = review("same\nnotes", "same\nnotes");
		expect(html).not.toContain("dl-add");
		expect(html).toContain("nothing to change");
	});
});

describe("ReleaseDialog consolidation", () => {
	const { window } = installBrowserGlobals([
		"Event",
		"HTMLElement",
		"HTMLTextAreaElement",
		"Node",
	]);
	// happy-dom's dispatched clicks never reach React's event plugin: call the
	// production onClick React rendered onto the node instead.
	// Buttons are found by their exact label.
	const button = (box: ParentNode, name: string): HTMLButtonElement => {
		const node = [...box.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === name,
		);
		if (node === undefined) throw new Error(`no ${name} button`);
		return node as HTMLButtonElement;
	};
	// The production onChange React rendered onto the node; the textarea is typed by
	// calling it with a minimal event object, since happy-dom's dispatched input
	// event never reaches React's ChangeEventPlugin.
	const notesValue = (box: ParentNode): string =>
		(box.querySelector("#release-notes-proposal") as HTMLTextAreaElement).value;
	const notes = "- add the thing\n- fix the bug";
	const consolidated =
		"- the thing landed\n\n## Bug fixes\n\n- the bug is gone";
	const plan: ReleasePlan = {
		sha: "a".repeat(40),
		from: "v1.0.0",
		version: "v1.1.0",
		notes,
		commits: 12,
		tasks: [{ id: "t1", title: "Add the thing" }],
		blocked: null,
	};
	const project = {
		name: "proj",
		github: null,
		settings: { releaseCommand: null, postReleaseCommand: null },
	} as unknown as ProjectView;
	const runAct = async (fn: () => Promise<unknown>): Promise<boolean> => {
		await fn();
		return true;
	};
	type Call = { url: string; method?: string; body?: unknown };
	type Harness = {
		calls: Call[];
		container: HTMLDivElement;
		/** Paths the dialog's goRoles callback navigated to. */
		navigated: string[];
		/** Re-renders the same root with a new `open` value, for close/reopen tests. */
		render: (open: boolean) => Promise<void>;
		done: () => Promise<void>;
	};
	const json = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	/** Mounts the open dialog over a fetch mock and lets the plan fetch land.
	 *  GET /release answers the plan, POST /release answers {} (Start); the
	 *  release-summary POST goes to `summary`; `models`, when given, answers
	 *  GET /api/models (with those roles); every other URL 404s (the model
	 *  catalog reads its failure and stays null). */
	const mount = async (
		summary?: () => Response | Promise<Response>,
		models?: Record<string, string>,
	): Promise<Harness> => {
		const calls: Call[] = [];
		const { restore } = stubFetch(async (url, init) => {
			const call: Call = {
				url: String(url),
				method: init?.method,
				body:
					typeof init?.body === "string"
						? (JSON.parse(init.body) as unknown)
						: undefined,
			};
			calls.push(call);
			if (String(call.url).endsWith("/api/models") && models !== undefined)
				return json({ models: [], roles: models });
			if (call.url.endsWith("/release-summary") && call.method === "POST")
				return summary !== undefined
					? summary()
					: new Response("{}", { status: 404 });
			if (call.url.endsWith("/release") && call.method === "POST")
				return json({});
			if (call.url.endsWith("/release")) return json(plan);
			return new Response("{}", { status: 404 });
		});
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.appendChild(container as unknown as HappyNode);
		const root = createRoot(container);
		const navigated: string[] = [];
		const render = (open: boolean): Promise<void> =>
			act(async () => {
				root.render(
					<ReleaseDialog
						project={project}
						open={open}
						onClose={() => {}}
						act={runAct}
						goRoles={() => navigated.push("/settings#model-roles-section")}
					/>,
				);
			});
		try {
			await render(true);
			// One more act lets the plan fetch land.
			await act(async () => {});
		} catch (e) {
			restore();
			throw e;
		}
		return {
			calls,
			container,
			navigated,
			render,
			done: async () => {
				resetCatalogCache();
				await act(async () => {
					root.unmount();
				});
				container.remove();
				restore();
			},
		};
	};
	/** Clicks a button by label and lets the resulting state settle. */
	const click = async (h: Harness, name: string): Promise<void> => {
		await act(async () => {
			onClickOf(button(h.container, name))({});
		});
		await act(async () => {});
	};

	test("opening runs no consolidation request and keeps the commit-history notes", async () => {
		const h = await mount();
		try {
			expect(h.calls.some((c) => c.url.endsWith("/release-summary"))).toBe(
				false,
			);
			expect(notesValue(h.container)).toBe(notes);
			expect(button(h.container, "Consolidate notes").disabled).toBe(false);
			expect(h.container.textContent).not.toContain("Consolidation review");
		} finally {
			await h.done();
		}
	});

	test("Consolidate notes posts once and shows the diff of both texts", async () => {
		const h = await mount(() => json({ summary: consolidated, reason: null }));
		try {
			await click(h, "Consolidate notes");
			const post = h.calls.find((c) => c.url.endsWith("/release-summary"));
			expect(post?.method).toBe("POST");
			expect(post?.body).toEqual({ sha: plan.sha });
			expect(h.container.textContent).toContain("Proposed notes");
			// One proposal at a time: the button re-arms after Use or Discard.
			expect(button(h.container, "Consolidate notes").disabled).toBe(true);
			expect(h.container.querySelector(".deepen-diff")).not.toBeNull();
			expect(h.container.textContent).toContain("the thing landed");
			expect(h.container.textContent).toContain("fix the bug");
			// The proposal is a review, not a replacement: the draft still holds
			// the deterministic notes until the user accepts.
			expect(notesValue(h.container)).toBe(notes);
		} finally {
			await h.done();
		}
	});

	test("the diff bases on the live draft, so Use cannot silently drop the user's edits", async () => {
		const h = await mount(() => json({ summary: consolidated, reason: null }));
		try {
			// The user edits the deterministic notes before asking for a proposal.
			const box = h.container.querySelector(
				"#release-notes-proposal",
			) as HTMLTextAreaElement;
			await act(async () => {
				onChangeOf(box)({ target: { value: `${notes}\n- my own edit line` } });
			});
			await click(h, "Consolidate notes");
			// The review diffs the edited draft against the proposal, so the edit
			// the Use action would remove shows as a removed line.
			const diff = h.container.querySelector(".deepen-diff");
			expect(diff).not.toBeNull();
			expect(diff?.textContent).toContain("my own edit line");
			expect(diff?.textContent).toContain("the thing landed");
			expect(notesValue(h.container)).toContain("my own edit line");
			// Use replaces the whole draft with the proposal, as the diff showed.
			await click(h, "Use consolidated notes");
			expect(notesValue(h.container)).toBe(consolidated);
		} finally {
			await h.done();
		}
	});

	test("a consolidation reply that lands after a close and reopen never fills the new dialog", async () => {
		const { promise: pending, resolve } = Promise.withResolvers<Response>();
		let asked = 0;
		const h = await mount(() => {
			asked += 1;
			return asked === 1
				? pending
				: json({ summary: consolidated, reason: null });
		});
		try {
			await click(h, "Consolidate notes");
			// Close and reopen (the plan refetches) while the first request is
			// still unanswered; the reopen must invalidate the in-flight reply.
			await h.render(false);
			await h.render(true);
			expect(
				h.calls.filter((c) => c.url.endsWith("/release-summary")),
			).toHaveLength(1);
			resolve(json({ summary: consolidated, reason: null }));
			await act(async () => {});
			await act(async () => {});
			// The stale reply belongs to the closed session: no review, no busy
			// state, and the notes editor keeps the deterministic notes.
			expect(h.container.textContent).not.toContain("Proposed notes");
			expect(notesValue(h.container)).toBe(notes);
			expect(button(h.container, "Consolidate notes").disabled).toBe(false);
		} finally {
			await h.done();
		}
	});

	test("Use consolidated notes writes the draft and Start sends it", async () => {
		const h = await mount(() => json({ summary: consolidated, reason: null }));
		try {
			await click(h, "Consolidate notes");
			await click(h, "Use consolidated notes");
			expect(notesValue(h.container)).toBe(consolidated);
			expect(h.container.textContent).not.toContain("Consolidation review");
			await click(h, "Start release");
			const rel = h.calls.find(
				(c) => c.url.endsWith("/release") && c.method === "POST",
			);
			expect(rel?.body).toEqual({ sha: plan.sha, notes: consolidated });
		} finally {
			await h.done();
		}
	});

	test("Discard keeps the original notes and Start sends no notes override", async () => {
		const h = await mount(() => json({ summary: consolidated, reason: null }));
		try {
			await click(h, "Consolidate notes");
			await click(h, "Discard");
			expect(notesValue(h.container)).toBe(notes);
			expect(h.container.textContent).not.toContain("Use consolidated notes");
			// Discard re-arms the button, so a fresh proposal can be requested.
			expect(button(h.container, "Consolidate notes").disabled).toBe(false);
			await click(h, "Start release");
			const rel = h.calls.find(
				(c) => c.url.endsWith("/release") && c.method === "POST",
			);
			expect(rel?.body).toEqual({ sha: plan.sha });
		} finally {
			await h.done();
		}
	});

	test("a failed consolidation shows the advisory, keeps the notes, and a retry succeeds", async () => {
		let n = 0;
		const h = await mount(() => {
			n += 1;
			return n === 1
				? json({ summary: null, reason: "the gateway is down" })
				: json({ summary: consolidated, reason: null });
		});
		try {
			await click(h, "Consolidate notes");
			expect(h.container.textContent).toContain(
				"Consolidated notes unavailable: the gateway is down",
			);
			expect(notesValue(h.container)).toBe(notes);
			expect(h.container.textContent).not.toContain("Consolidation review");
			// The button re-arms: a retry clears the advisory and opens the review.
			await click(h, "Consolidate notes");
			expect(n).toBe(2);
			expect(h.container.textContent).not.toContain("the gateway is down");
			expect(h.container.querySelector(".deepen-diff")).not.toBeNull();
		} finally {
			await h.done();
		}
	});

	test("a failed consolidation names the smol role and links to Settings' model roles", async () => {
		const h = await mount(
			() => json({ summary: null, reason: "the gateway is down" }),
			{ smol: "zai/glm-5.3-flash" },
		);
		try {
			await click(h, "Consolidate notes");
			expect(h.container.textContent).toContain(
				"The call runs on the smol role — add a fallback for it in",
			);
			const link = h.container.querySelector(
				'a[href="/settings#model-roles-section"]',
			);
			expect(link?.textContent).toBe("Settings → Model roles");
			// A plain click SPA-navigates to the Settings deep link (via goRoles).
			await act(async () => {
				onClickOf(link as HTMLAnchorElement)({
					button: 0,
					preventDefault: () => {},
					currentTarget: { pathname: "/settings" },
				});
			});
			expect(h.navigated).toEqual(["/settings#model-roles-section"]);
		} finally {
			await h.done();
		}
	});

	test("an identical proposal reports no line changes instead of an empty diff box", async () => {
		const h = await mount(() => json({ summary: notes, reason: null }));
		try {
			await click(h, "Consolidate notes");
			expect(h.container.textContent).toContain("nothing to change");
			expect(h.container.querySelector(".deepen-diff")).toBeNull();
			expect(button(h.container, "Use consolidated notes").disabled).toBe(
				false,
			);
		} finally {
			await h.done();
		}
	});
});

const replyDrawerBase = {
	project: {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1 },
	} as unknown as ProjectView,
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

describe("Drawer prompt gate Start anyway", () => {
	installBrowserGlobals(["Event", "HTMLElement", "Node"]);
	// happy-dom clicks never reach React's plugin: call the rendered onClick instead.
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
					text: true,
				},
			],
			gate,
		});

	test("a gate park renders the reason and Start anyway; its click replies with the exact marker", async () => {
		const posts: { url: string; body: string }[] = [];
		const { restore } = stubFetch(async (url, init) => {
			if (url.endsWith("/tasks/t1/reply")) {
				posts.push({ url, body: String(init?.body ?? "") });
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			if (url.endsWith("/tasks/t1")) {
				return new Response(
					JSON.stringify({
						...gateTask({
							hash: null,
							seen: null,
							fails: 1,
							sig: "Which environment deploys this?",
							parked: true,
						}),
						// The slim row carries no prompt (OTTR-965); the loaded task
						// does, and the prompt panel renders it once the detail lands.
						prompt: "gate park prompt",
						turns: [],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mount(
			<Drawer
				{...replyDrawerBase}
				task={gateTask({
					hash: null,
					seen: null,
					fails: 1,
					sig: "Which environment deploys this?",
					parked: true,
				})}
			/>,
		);
		try {
			// One more act lets the detail fetch land, so the gate banner renders.
			await act(async () => {});
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
			restore();
			await unmount();
		}
	});

	test("a needs_you card without a parked gate renders no Start anyway", () => {
		const html = renderToStaticMarkup(
			<Drawer {...replyDrawerBase} task={gateTask(null)} />,
		);
		expect(html).not.toContain("Start anyway");
		expect(html).not.toContain("gate-start");
	});

	test("a parked gate's section context renders once above the ask panel", async () => {
		const gate = gateTask({
			hash: null,
			seen: null,
			fails: 1,
			sig: "Which environment deploys this?",
			parked: true,
			context: ["We need a decision on the rollout timing.", "Pick one"],
		});
		// The drawer body renders only once the detail fetch lands, so the GET
		// serves the same context-carrying fixture back.
		const { restore } = stubFetch(async (url) => {
			if (String(url).endsWith("/tasks/t1")) {
				return new Response(
					JSON.stringify({ ...gate, prompt: "gate park prompt", turns: [] }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mount(
			<Drawer {...replyDrawerBase} task={gate} />,
		);
		try {
			// One more act lets the detail fetch land, so the ask body renders.
			await act(async () => {});
			const ctx = container.querySelector(".gate-context");
			expect(ctx).not.toBeNull();
			expect(ctx!.textContent).toContain(
				"We need a decision on the rollout timing.",
			);
			expect(ctx!.textContent).toContain("Pick one");
			// Once: the lines are context, never an ask question.
			const hits =
				container.innerHTML.split("We need a decision on the rollout timing.")
					.length - 1;
			expect(hits).toBe(1);
			// Above the questions: the ask panel follows the context block.
			const panel = container.querySelector(".ask-panel");
			expect(panel).not.toBeNull();
			expect(
				ctx!.compareDocumentPosition(panel!) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		} finally {
			restore();
			await unmount();
		}
	});

	test("a parked gate without section context renders no gate-context", () => {
		const html = renderToStaticMarkup(
			<Drawer
				{...replyDrawerBase}
				task={gateTask({
					hash: null,
					seen: null,
					fails: 1,
					sig: "Which environment deploys this?",
					parked: true,
				})}
			/>,
		);
		expect(html).not.toContain("gate-context");
	});

	test("a needs_you card without a parked gate renders no stale context", () => {
		// The context lines stay in the gate state after an un-park; only a live
		// park may show them above the ask.
		const html = renderToStaticMarkup(
			<Drawer
				{...replyDrawerBase}
				task={gateTask({
					hash: null,
					seen: null,
					fails: 0,
					sig: null,
					parked: false,
					context: ["Pick one"],
				})}
			/>,
		);
		expect(html).not.toContain("gate-context");
	});
});

describe("Drawer ask drafts on the server", () => {
	const { window } = installBrowserGlobals([
		"localStorage",
		"Event",
		"HTMLElement",
		"HTMLInputElement",
		"Node",
	]);
	const draftUrl = "/api/projects/proj/tasks/t1/ask-draft";
	const fp = "Which database?\nWhich region?";
	const askTask = cardFixture({
		...drawerFields,
		stage: "todo",
		state: "needs_you",
		asked: [
			{
				question: "Which database?",
				options: [{ label: "Postgres" }, { label: "SQLite" }],
				multi: true,
				recommended: null,
				text: false,
			},
			{
				question: "Which region?",
				options: [{ label: "EU" }, { label: "US" }],
				multi: false,
				recommended: null,
				text: false,
			},
		],
		gate: null,
	});
	/** The React prop handler on a node; happy-dom events never reach React's plugins. */
	const propOf = (node: Element, name: "onClick" | "onChange") => {
		const key = Object.getOwnPropertyNames(node).find((k) =>
			k.startsWith("__reactProps$"),
		);
		if (key === undefined) throw new Error("react props missing on node");
		const fn = (
			(node as unknown as Record<string, unknown>)[key] as Record<
				string,
				((e: unknown) => void) | undefined
			>
		)[name];
		if (fn === undefined) throw new Error(`node has no ${name}`);
		return fn;
	};
	/** Lets the mocked fetch chains and React updates settle. */
	const settle = (ms = 0) =>
		act(async () => {
			await Bun.sleep(ms);
		});
	/** Mounts the drawer on a fetch mock whose GET .../ask-draft answers `server`. */
	async function mountAsk(server: unknown) {
		const calls: { url: string; method: string; body: string }[] = [];
		const { restore } = stubFetch(async (url, init) => {
			const method = init?.method ?? "GET";
			calls.push({ url, method, body: String(init?.body ?? "") });
			if (url === draftUrl && method === "GET")
				return new Response(JSON.stringify({ draft: server }));
			if (url === draftUrl || url.endsWith("/tasks/t1/reply"))
				return new Response(JSON.stringify({ ok: true }));
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mount(
			<Drawer {...replyDrawerBase} task={askTask} />,
		);
		await settle();
		const chosen = () =>
			[...container.querySelectorAll(".ask-opt.chosen")].map(
				(n) => n.textContent,
			);
		const input = (label: string) => {
			const el = container.querySelector(`input[aria-label="${label}"]`);
			if (el === null) throw new Error(`no ${label} input`);
			return el;
		};
		const draftPosts = () =>
			calls.filter((c) => c.url === draftUrl && c.method === "POST");
		return { container, calls, chosen, input, draftPosts, unmount, restore };
	}

	test("a server draft newer than the local one shows when the panel opens", async () => {
		window.localStorage.clear();
		saveAskDraft("t1", { fp, answers: { 1: "EU" }, at: 100 });
		const server = { fp, answers: { 0: "SQLite", 1: "US" }, at: 200 };
		const m = await mountAsk(server);
		try {
			expect(
				m.calls.some((c) => c.url === draftUrl && c.method === "GET"),
			).toBe(true);
			expect(m.chosen()).toEqual(["SQLite", "US"]);
			// The server draft also replaces the local cache.
			expect(loadAskDrafts().t1).toEqual(server);
		} finally {
			await m.unmount();
			m.restore();
		}
	});

	test("a local draft newer than the server draft wins and syncs to the server", async () => {
		window.localStorage.clear();
		const local = { fp, answers: { 0: "Postgres" }, at: 300 };
		saveAskDraft("t1", local);
		const m = await mountAsk({ fp, answers: { 0: "SQLite" }, at: 200 });
		try {
			expect(m.chosen()).toEqual(["Postgres"]);
			expect(loadAskDrafts().t1).toEqual(local);
			// A draft saved offline reaches the server once the load shows it is newer.
			expect(m.draftPosts().map((c) => JSON.parse(c.body))).toEqual([local]);
		} finally {
			await m.unmount();
			m.restore();
		}
	});

	test("a pick saves locally at once and POSTs the draft after the debounce", async () => {
		window.localStorage.clear();
		const m = await mountAsk(null);
		try {
			const eu = m.input("EU");
			const before = Date.now();
			await act(async () => {
				propOf(eu, "onChange")({ target: eu, currentTarget: eu });
			});
			expect(loadAskDrafts().t1?.answers).toEqual({ 1: "EU" });
			expect(m.draftPosts()).toEqual([]);
			await settle(600);
			const posts = m.draftPosts();
			expect(posts).toHaveLength(1);
			const body = JSON.parse(posts[0]!.body) as {
				fp: string;
				answers: Record<string, string>;
				at: number;
			};
			expect(body.fp).toBe(fp);
			expect(body.answers).toEqual({ 1: "EU" });
			expect(body.at).toBeGreaterThanOrEqual(before);
		} finally {
			await m.unmount();
			m.restore();
		}
	});

	test("closing the panel sends a pending save at once", async () => {
		window.localStorage.clear();
		const m = await mountAsk(null);
		try {
			const eu = m.input("EU");
			await act(async () => {
				propOf(eu, "onChange")({ target: eu, currentTarget: eu });
			});
			await m.unmount();
			await settle();
			expect(m.draftPosts()).toHaveLength(1);
		} finally {
			m.restore();
		}
	});

	test("a reply cancels the pending save", async () => {
		window.localStorage.clear();
		const m = await mountAsk(null);
		try {
			const eu = m.input("EU");
			await act(async () => {
				propOf(eu, "onChange")({ target: eu, currentTarget: eu });
			});
			const approve = m.container.querySelector(
				".ask-actions .ask-send:not(.primary)",
			);
			if (approve === null) throw new Error("no Approve button");
			await act(async () => {
				propOf(approve, "onClick")({});
			});
			await settle(600);
			expect(m.calls.some((c) => c.url.endsWith("/tasks/t1/reply"))).toBe(true);
			expect(m.draftPosts()).toEqual([]);
			// The sent reply drops the local draft too.
			expect(loadAskDrafts().t1).toBeUndefined();
		} finally {
			await m.unmount();
			m.restore();
		}
	});

	test("a local draft from an older build syncs when the server has none", async () => {
		window.localStorage.clear();
		window.localStorage.setItem(
			"ottr.ask.drafts",
			JSON.stringify({ t1: { fp, answers: { 1: "EU" } } }),
		);
		const m = await mountAsk(null);
		try {
			expect(m.chosen()).toEqual(["EU"]);
			expect(m.draftPosts().map((c) => JSON.parse(c.body))).toEqual([
				{ fp, answers: { 1: "EU" }, at: 1 },
			]);
		} finally {
			await m.unmount();
			m.restore();
		}
	});

	test("a pick after a draft at the largest safe `at` stays within the API's range", async () => {
		window.localStorage.clear();
		const m = await mountAsk({
			fp,
			answers: { 0: "SQLite" },
			at: Number.MAX_SAFE_INTEGER,
		});
		try {
			const eu = m.input("EU");
			await act(async () => {
				propOf(eu, "onChange")({ target: eu, currentTarget: eu });
			});
			await settle(600);
			const posts = m.draftPosts().map((c) => JSON.parse(c.body));
			expect(posts).toEqual([
				{ fp, answers: { 0: "SQLite", 1: "EU" }, at: Number.MAX_SAFE_INTEGER },
			]);
		} finally {
			await m.unmount();
			m.restore();
		}
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
	// them via the shared helper; afterAll puts the originals back.
	const { window: win } = installBrowserGlobals([
		"Event",
		"HTMLElement",
		"Node",
	]);
	const host = globalThis as unknown as Record<string, unknown>;

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

	async function mountNotice(open: (id: string) => void = () => {}): Promise<{
		container: HTMLDivElement;
		unmount: () => void;
	}> {
		// happy-dom's DOM classes do not structurally match lib.dom's; convert once here.
		const { container, root } = await mount(
			<OrphanNotice
				orphans={[row]}
				fresh={false}
				nowMs={210_000}
				openTask={open}
			/>,
		);
		return { container, unmount: () => root.unmount() };
	}

	// happy-dom's Window type omits the dialog methods; speak them through this cast.
	const w = win as unknown as { confirm: (m: string) => boolean };

	test("stop without confirm does not post", async () => {
		const posts: string[] = [];
		const realConfirm = w.confirm;
		w.confirm = () => false;
		const { restore } = stubFetch(async (url) => {
			posts.push(url);
			throw new Error("must not fetch");
		});
		const { container, unmount } = await mountNotice();
		try {
			await act(async () => {
				onClickOf(buttonOf(container, "Stop process"))();
			});
			expect(posts).toEqual([]);
		} finally {
			w.confirm = realConfirm;
			restore();
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
		w.confirm = () => true;
		const { restore } = stubFetch(async (u, init) => {
			url = u;
			body = JSON.parse(String(init?.body ?? "null"));
			return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
		});
		const { container, unmount } = await mountNotice();
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
			restore();
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
		const { container, unmount } = await mountNotice();
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
		const { container, unmount } = await mountNotice((id) => {
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
	const _project = drawerProject;
	const base = drawerBase;
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
		// No decision: no Decision line.
		expect(html).not.toContain("<dt>Decision</dt>");
		expect(html).toContain("Rework the proposal reason wording");
		expect(html).toContain("One line less on every proposal card");
		// The known id renders as a link to its card; the unknown one stays text.
		expect(html).toContain('href="/projects/proj/tasks/OTTR-404"');
		expect(html).not.toContain("tasks/ZZZ-9");
		expect(html).toContain("ZZZ-9 never existed");
	});

	test("a proposal with a decision shows its question first", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
			proposalSummary: {
				...summary,
				decision: "Keep the old flag or drop it?",
			},
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		const decision = html.indexOf("<dt>Decision</dt>");
		expect(decision).toBeGreaterThan(-1);
		expect(decision).toBeLessThan(html.indexOf("<dt>What changes</dt>"));
		expect(html).toContain("Keep the old flag or drop it?");
	});

	test("a proposal without a summary holds a loading line, no five labels", () => {
		// The prompt rides the detail fetch (OTTR-965): while it is in flight, the
		// fallback paragraph holds its space with the loading line.
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		expect(html).toContain('id="drawer-decide"');
		expect(html).toContain('aria-label="Loading the prompt"');
		expect(html).not.toContain('class="decide-fallback"');
		expect(html).not.toContain("<dt>What changes</dt>");
		expect(html).not.toContain("<dt>Why</dt>");
		expect(html).not.toContain("<dt>Gain</dt>");
		expect(html).not.toContain("<dt>Risk</dt>");
		expect(html).not.toContain("<dt>Check</dt>");
	});

	test("the panel carries Accept and Edit beside it, and the collapsed full prompt", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
			proposalSummary: summary,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		// Accept is the primary action; Edit renders beside it; the decline moved to the
		// drawer-actions row's Cancel task.
		expect(html).toContain('class="primary"');
		expect(html).toContain('title="Start the proposed task"');
		expect(html).toContain('title="Edit the task text"');
		expect(html).not.toContain("Decline this proposal");
		// The prompt slot holds its loading line until the detail fetch lands
		// (OTTR-965); the loaded prompt renders in the mounted tests further down.
		expect(html).toContain('aria-label="Loading the prompt"');
		// One decision card: the body (reason, summary, loading prompt) first, then the
		// footer with Accept and Edit, so the buttons close the decision instead of
		// splitting it.
		const card = html.slice(html.indexOf('class="decide-card"'));
		expect(card.indexOf('class="decide-body"')).toBeGreaterThan(-1);
		expect(card.indexOf('class="decide-actions"')).toBeGreaterThan(
			card.indexOf('class="decide-body"'),
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

	test("a proposal card in needs_you renders one Accept, the model picker, and no Reply composer", () => {
		const task = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "needs_you",
			needsReason: reason,
			proposalSummary: summary,
		});
		const html = renderToStaticMarkup(<Drawer {...base} task={task} />);
		// The Decide panel owns the one Accept; the composer's twin is gone.
		const accepts = html.match(/title="Start the proposed task"/g) ?? [];
		expect(accepts).toHaveLength(1);
		expect(html.match(/>Accept<\/button>/g) ?? []).toHaveLength(1);
		// Nothing to reply to before Accept: the composer stays hidden until the task starts.
		expect(html).not.toContain('id="drawer-reply"');
		// The first turn's model is picked in the Decide panel, beside Accept.
		const decide = html.slice(
			html.indexOf('id="drawer-decide"'),
			html.indexOf("</section>", html.indexOf('id="drawer-decide"')),
		);
		expect(decide).toMatch(
			/<div class="decide-model"><div class="model-fields">/,
		);
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

	test("a proposal card opens through its card link without a separate action; an ordinary needs_you card keeps the alarm", () => {
		const laneBase = laneColBase;
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
		const document = parseMarkup(withProposal);
		expect(document.querySelectorAll(".card button").length).toBe(0);
		expect(document.querySelector("a.card-open")?.getAttribute("href")).toBe(
			"/projects/proj/tasks/t1",
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
		expect(withPlain).not.toContain("data-proposal");
		expect(withPlain).toContain('class="card-error"');
		expect(withPlain).toContain("mark-needs");
	});
});

describe("Drawer proposal panel editing (client)", () => {
	const { window } = installDrawerClientGlobals();
	// happy-dom's dispatched clicks never reach React's event plugin: call the
	// production onClick React rendered onto the node instead.

	test("the panel's Edit opens exactly one prompt editor for the proposal", async () => {
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
		} as unknown as Partial<TaskCard> & Partial<Pick<Task, "report">>);
		// The detail fetch fills the prompt (OTTR-965): the row carries none, so the
		// loaded task carries the text the editor must prefill.
		const detail = { ...task, prompt: "Rework the wording", turns: [] };
		const { restore } = stubFetch(async (url) => {
			if (String(url).endsWith("/tasks/t1")) {
				return new Response(JSON.stringify(detail), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
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
			// One more act lets the detail fetch land: the editor prefills from it.
			await act(async () => {});
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
			restore();
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
			doneTotal: 0,
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

	test("a dependabot-off repo renders the advisory with the enable link", () => {
		const html = renderBoard(
			projectWith({
				dependabotOff: true,
				github: "https://github.com/acme/widget",
			}),
		);
		expect(html).toContain("Dependabot alerts are off");
		expect(html).toContain("Enable on GitHub");
		expect(html).toContain(
			'href="https://github.com/acme/widget/settings/security_analysis"',
		);
		expect(html).toContain("Settings → Watches → Dependabot warning");
	});

	test("no dependabot-off state renders no dependabot advisory", () => {
		const html = renderBoard(projectWith({}));
		expect(html).not.toContain("Dependabot alerts are off");
		expect(html).not.toContain("security_analysis");
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
			doneTotal: 0,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
			homepage: null,
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

	test("the header links a configured project homepage", () => {
		const html = renderBoard(
			projectWith({
				github: "https://github.com/octo/repo",
				homepage: { url: "https://example.org/project", domain: "example.org" },
			}),
		);
		expect(html).toContain('href="https://example.org/project"');
		expect(html).toContain("example.org</a>");
		const homepageLink = html.match(
			/<a[^>]*href="https:\/\/example\.org\/project"[^>]*>(.*?)<\/a>/s,
		);
		expect(homepageLink?.[1]).toContain("<svg");
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('title="Project homepage"');
	});

	test("the header hides a missing project homepage", () => {
		const html = renderBoard(projectWith({ homepage: null }));
		expect(html).not.toContain('title="Project homepage"');
		expect(html).not.toContain("example.org");
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
		doneTotal: 0,
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
	installBrowserGlobals([
		"HTMLElement",
		"HTMLInputElement",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	test("the Turn on PR mode button posts prMode true to the project settings", async () => {
		const posts: { url: string; body: unknown }[] = [];
		const { restore } = stubFetch(async (url, init) => {
			if (String(url).endsWith("/api/projects/proj/settings")) {
				posts.push({
					url: String(url),
					body: JSON.parse(String(init?.body ?? "{}")),
				});
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mount(
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
						doneTotal: 0,
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
		try {
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
			restore();
			await unmount();
		}
	});
});

describe("AddProjectModal board GitHub token reuse", () => {
	const { window } = installBrowserGlobals([
		"localStorage",
		"sessionStorage",
		"HTMLElement",
		"HTMLInputElement",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	/** The form-submit DOM event; happy-dom's Event class does not match lib.dom's. */
	const submitEvent = (): Event =>
		new window.Event("submit", {
			bubbles: true,
			cancelable: true,
		}) as unknown as Event;

	const typeInto = typeIntoFor(window);
	// Types and fires the native change in one act scope; the Add form's
	// wizard steps read the value on change.
	const typeAndChange = async (
		el: HTMLInputElement,
		value: string,
	): Promise<void> => {
		await act(async () => {
			typeInto(el, value);
			onChangeOf(el)({
				target: el,
				currentTarget: el,
			});
		});
	};

	const project = {
		name: "proj",
		hasRules: true,
		github: null,
		sessionsDir: "/tmp/sessions",
		settings: { maxParallel: 1, copyExtra: [] },
	} as unknown as ProjectView;

	// The wizard's fresh project: retro off keeps the board step first, and the GitHub
	// remote enables the PR mode row (docs/specs/add-project-wizard.md).
	const wizardProject = {
		name: "wiz",
		hasRules: false,
		gitless: false,
		github: "https://github.com/o/wiz",
		sessionsDir: "/tmp/sessions",
		settings: {
			retroSince: null,
			retroFilter: false,
			forkResearch: false,
			holdUpdateMerges: false,
			forkMergeHold: false,
			prMode: false,
			targetBranch: null,
			maxParallel: null,
			copyExtra: [],
		},
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

	type AddOptions = {
		tokenChallenge?: boolean;
		fail?: "create" | "init" | "settings" | "interview" | "checklist";
		waitForCreate?: Promise<void>;
		onClose?: () => void;
		savedSettings?: Partial<ProjectView["settings"]>;
		hasRules?: boolean;
		sshAccess?: boolean;
		hosted?: boolean;
		createdSource?: Pick<ProjectView, "github" | "gitless">;
	};

	// The fetch mountAdd serves: gh-status 404, the git-hosts view for the token state,
	// a first project POST that fails for the missing token, then success; every POST
	// body lands in `posts`, and the github-token POST answers with the token set.
	async function addProjectFetch(
		hostsView: (githubTokenSet: boolean) => Record<string, unknown>,
		posts: { url: string; body: Record<string, unknown> }[],
		calls: { project: number; settings: number; interview: number },
		project: ProjectView,
		githubTokenSet: boolean,
		input: RequestInfo | URL,
		init?: RequestInit,
		options: AddOptions = {},
	): Promise<Response> {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url.endsWith("/api/gh-status")) {
			return new Response("{}", { status: 404 });
		}
		if (url.endsWith("/api/git-hosts")) {
			return new Response(
				JSON.stringify({
					...hostsView(githubTokenSet),
					...(options.sshAccess
						? {
								globalKey: {
									publicKey: "test public key",
									fingerprint: "SHA256:before",
								},
							}
						: {}),
				}),
				{ status: 200 },
			);
		}
		if (url === "/api/git-hosts/ssh/test" && method === "POST") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			posts.push({ url, body });
			if (body.trust === undefined) {
				return new Response(
					JSON.stringify({
						error: "Host needs trust",
						needsTrust: true,
						host: "github.com",
						fingerprints: ["SHA256:before"],
						changed: false,
					}),
					{ status: 409 },
				);
			}
			return new Response("{}", { status: 200 });
		}
		if (url.endsWith("/api/projects") && method === "POST") {
			calls.project += 1;
			posts.push({
				url,
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			if (options.waitForCreate !== undefined) await options.waitForCreate;
			if (calls.project === 1 && options.fail === "create") {
				return new Response(JSON.stringify({ error: "Create failed" }), {
					status: 500,
				});
			}
			if (calls.project === 1 && options.tokenChallenge !== false) {
				return new Response(
					JSON.stringify({
						error: "Authentication failed",
						needsToken: "github.com",
					}),
					{ status: 400 },
				);
			}
			if (
				options.sshAccess &&
				JSON.stringify(posts.at(-1)?.body.trust) !==
					JSON.stringify(["SHA256:after"])
			) {
				return new Response(
					JSON.stringify({
						error: "Host key changed",
						needsTrust: true,
						host: "github.com",
						fingerprints: ["SHA256:after"],
						changed: true,
					}),
					{ status: 409 },
				);
			}
			return new Response(JSON.stringify({ project }), {
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
		// The wizard's calls once it replaced the form: settings saves return the view,
		// the interview call files a card, the fork facts answer empty.
		if (url.endsWith("/init") && method === "POST") {
			posts.push({ url, body: {} });
			if (
				options.fail === "init" &&
				posts.filter((p) => p.url === url).length === 1
			) {
				return new Response(JSON.stringify({ error: "Init failed" }), {
					status: 500,
				});
			}
			project.gitless = false;
			return new Response(JSON.stringify({ project }));
		}
		if (url.endsWith("/settings") && method === "POST") {
			posts.push({
				url,
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			if (
				options.fail === "checklist" &&
				posts.at(-1)?.body.setupChecklist === false &&
				posts.filter((p) => p.body.setupChecklist === false).length === 1
			) {
				return new Response(JSON.stringify({ error: "Checklist failed" }), {
					status: 500,
				});
			}
			calls.settings += 1;
			if (calls.settings === 1 && options.fail === "settings") {
				return new Response(JSON.stringify({ error: "Settings failed" }), {
					status: 500,
				});
			}
			const body = posts.at(-1)?.body ?? {};
			Object.assign(project.settings, body);
			if (typeof body.retro === "boolean") {
				project.settings.retroSince = body.retro ? 1 : null;
			}
			return new Response(JSON.stringify(project), { status: 200 });
		}
		if (url.endsWith("/interview") && method === "POST") {
			posts.push({
				url,
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			calls.interview += 1;
			if (calls.interview === 1 && options.fail === "interview") {
				return new Response(JSON.stringify({ error: "Interview failed" }), {
					status: 500,
				});
			}
			return new Response(
				JSON.stringify(
					project.hasRules
						? { interview: "not-needed", id: null }
						: { interview: "queued", id: "WIZ-1" },
				),
				{ status: 200 },
			);
		}
		if (url.endsWith("/github")) {
			return new Response(JSON.stringify({ forks: 0, active: 0, recent: [] }), {
				status: 200,
			});
		}
		return new Response("{}", { status: 404 });
	}

	async function mountAdd(
		githubTokenSet: boolean,
		projects: ProjectView[] = [],
		wizardProject?: ProjectView,
		options: AddOptions = {},
	): Promise<{
		container: HTMLDivElement;
		root: ReturnType<typeof createRoot>;
		unmount: () => Promise<void>;
		posts: { url: string; body: Record<string, unknown> }[];
		restore: () => void;
	}> {
		const posts: { url: string; body: Record<string, unknown> }[] = [];
		const calls = { project: 0, settings: 0, interview: 0 };
		const responseProject = structuredClone(wizardProject ?? project);
		const { restore } = stubFetch(async (url, init) =>
			addProjectFetch(
				hostsView,
				posts,
				calls,
				responseProject,
				githubTokenSet,
				url,
				init,
				options,
			),
		);

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
		const { container, root, unmount } = await mount(
			<HostedContext.Provider value={options.hosted === true}>
				<AddProjectModal
					act={actProp}
					projects={projects}
					onClose={options.onClose ?? (() => {})}
					openTask={() => {}}
				/>
			</HostedContext.Provider>,
		);
		return {
			container,
			root,
			unmount,
			posts,
			restore: () => {
				restore();
			},
		};
	}

	const buttonOf = (
		container: HTMLDivElement,
		label: string,
	): HTMLButtonElement => {
		const button = [...container.querySelectorAll("button")].find(
			(node) => node.textContent?.trim() === label,
		);
		if (button === undefined) throw new Error(`no ${label} button`);
		return button;
	};

	const clickAction = async (
		container: HTMLDivElement,
		label: string,
	): Promise<void> => {
		await act(async () => {
			buttonOf(container, label).click();
		});
	};

	const changeField = async (
		field: HTMLInputElement | HTMLTextAreaElement,
		value: string,
	): Promise<void> => {
		await act(async () => {
			field.value = value;
			onChangeOf(field)({ target: field, currentTarget: field });
		});
	};

	const chooseSource = async (
		container: HTMLDivElement,
		mode: "new" | "url",
	): Promise<void> => {
		await clickAction(container, mode === "new" ? "New" : "Git URL");
		const input = container.querySelector(
			mode === "url" ? "input[data-autofocus]" : "#add-panel-new input",
		) as HTMLInputElement;
		await changeField(
			input,
			mode === "url" ? "https://github.com/o/wiz.git" : "wiz",
		);
	};

	const sourceNext = async (container: HTMLDivElement): Promise<void> => {
		const form = container.querySelector("form");
		if (form === null) throw new Error("no Source form");
		await act(async () => {
			form.dispatchEvent(submitEvent());
		});
	};

	const reachRules = async (container: HTMLDivElement): Promise<void> => {
		await sourceNext(container);
		for (let step = 2; step < 5; step += 1) {
			await clickAction(container, "Next");
		}
	};

	const withWizard = async (
		mode: "new" | "url",
		run: (args: {
			container: HTMLDivElement;
			posts: { url: string; body: Record<string, unknown> }[];
			closeCount: () => number;
		}) => Promise<void>,
		options: AddOptions = {},
	): Promise<void> => {
		let closes = 0;
		const fixture = {
			...wizardProject,
			gitless: mode === "new",
			github: mode === "new" ? null : wizardProject.github,
			settings: { ...wizardProject.settings, ...options.savedSettings },
			hasRules: options.hasRules ?? wizardProject.hasRules,
			...options.createdSource,
		};
		const { container, root, posts, restore } = await mountAdd(
			true,
			[],
			fixture,
			{
				tokenChallenge: false,
				...options,
				onClose: () => {
					closes += 1;
				},
			},
		);
		try {
			await chooseSource(container, mode);
			await run({ container, posts, closeCount: () => closes });
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	};

	test("Source stays local until Finish", async () => {
		const { container, root, posts, restore } = await mountAdd(true);
		try {
			const input = container.querySelector(
				"input[data-autofocus]",
			) as HTMLInputElement;
			await act(async () => {
				typeInto(input, "https://github.com/o/r.git");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			const form = container.querySelector("form") as HTMLFormElement;
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(posts.filter((p) => p.url === "/api/projects")).toHaveLength(0);
			const steps = [
				...container.querySelectorAll('[aria-label="Setup steps"] li'),
			];
			expect(steps).toHaveLength(5);
			expect(steps[1]?.getAttribute("aria-current")).toBe("step");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	});

	test("clicking a source tab puts the caret in that tab's field", async () => {
		const { container, root, restore } = await mountAdd(true);
		const settle = (): Promise<void> =>
			act(async () => {
				const { promise, resolve } = Promise.withResolvers<void>();
				requestAnimationFrame(() => resolve());
				await promise;
			});
		try {
			await clickAction(container, "New");
			await settle();
			expect(document.activeElement).toBe(
				container.querySelector("#add-panel-new input"),
			);
			await clickAction(container, "Git URL");
			await settle();
			expect(document.activeElement).toBe(
				container.querySelector("#add-panel-url input"),
			);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			restore();
		}
	});

	test("Cancel discards an unsaved token draft without browser storage", async () => {
		const draft = "draft-value-not-a-credential";
		const assertNoStoredDraft = (): void => {
			for (const storage of [window.localStorage, window.sessionStorage]) {
				for (let index = 0; index < storage.length; index += 1) {
					const key = storage.key(index);
					expect(key).not.toContain(draft);
					if (key !== null) expect(storage.getItem(key)).not.toContain(draft);
				}
			}
		};
		await withWizard(
			"url",
			async ({ container, posts, closeCount }) => {
				await reachRules(container);
				await clickAction(container, "Finish");
				const token = container.querySelector(
					'input[type="password"]',
				) as HTMLInputElement;
				expect(token).not.toBeNull();
				await changeField(token, draft);
				expect(token.value).toBe(draft);
				assertNoStoredDraft();
				await clickAction(container, "Cancel");
				expect(closeCount()).toBe(1);
				expect(posts.filter((p) => p.url === "/api/projects")).toHaveLength(1);
				expect(posts.some((p) => p.url.endsWith("/tokens"))).toBe(false);
				expect(posts.some((p) => p.url.endsWith("/interview"))).toBe(false);
			},
			{ tokenChallenge: true },
		);
		assertNoStoredDraft();
		await withWizard(
			"url",
			async ({ container, posts }) => {
				await reachRules(container);
				await clickAction(container, "Finish");
				const token = container.querySelector(
					'input[type="password"]',
				) as HTMLInputElement;
				expect(token).not.toBeNull();
				expect(token.value).toBe("");
				assertNoStoredDraft();
				expect(posts.filter((p) => p.url === "/api/projects")).toHaveLength(1);
				expect(posts.some((p) => p.url.endsWith("/tokens"))).toBe(false);
			},
			{ tokenChallenge: true },
		);
	});

	test("the board token button retries Add with the prefilled x-access-token", async () => {
		const { container, root, posts, restore } = await mountAdd(true);
		try {
			const urlInput = container.querySelector(
				"input[data-autofocus]",
			) as unknown as HTMLInputElement;
			expect(urlInput).not.toBeNull();
			await typeAndChange(urlInput, "https://github.com/o/r.git");
			await reachRules(container);
			expect(posts).toHaveLength(0);
			await clickAction(container, "Finish");
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
			expect(posts.filter((p) => p.url.endsWith("/interview"))).toHaveLength(1);
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
			await typeAndChange(urlInput, "https://github.com/o/r.git");
			await reachRules(container);
			await clickAction(container, "Finish");
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
			await typeAndChange(urlInput, "https://github.com/acme/cmis-cli.git");
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
			await typeAndChange(urlInput, "https://github.com/acme/cmis-cli.git");
			const prefixInput = container.querySelector(
				'input[aria-label="Task ID prefix"]',
			) as unknown as HTMLInputElement;
			await typeAndChange(prefixInput, "fix");
			await reachRules(container);
			expect(posts).toHaveLength(0);
			await clickAction(container, "Finish");
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
			await typeAndChange(prefixInput, "FIX");
			expect(container.querySelector('p[role="status"]')).not.toBeNull();
			await typeAndChange(prefixInput, "XYZ");
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
			await typeAndChange(urlInput, "https://github.com/acme/cmis-cli.git");
			const prefixInput = container.querySelector(
				'input[aria-label="Task ID prefix"]',
			) as unknown as HTMLInputElement;
			await typeAndChange(prefixInput, "A-B");
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

	for (const mode of ["new", "url"] as const) {
		for (let step = 1; step <= 5; step += 1) {
			test(`${mode}: Cancel at step ${step} leaves no project or interview`, async () => {
				await withWizard(mode, async ({ container, posts, closeCount }) => {
					if (step > 1) await sourceNext(container);
					for (let current = 2; current < step; current += 1) {
						await clickAction(container, "Next");
					}
					const steps = [
						...container.querySelectorAll('[aria-label="Setup steps"] li'),
					];
					expect(steps).toHaveLength(5);
					expect(steps[step - 1]?.getAttribute("aria-current")).toBe("step");
					await clickAction(container, "Cancel");
					expect(closeCount()).toBe(1);
					expect(posts).toHaveLength(0);
				});
			});
		}

		test(`${mode}: Back preserves source and settings drafts without a write`, async () => {
			await withWizard(mode, async ({ container, posts }) => {
				const prefix = container.querySelector(
					'input[aria-label="Task ID prefix"]',
				) as HTMLInputElement;
				await changeField(prefix, "DRAFT");
				await sourceNext(container);
				const retro = container.querySelector(
					'input[type="checkbox"]',
				) as HTMLInputElement;
				await act(async () => {
					onChangeOf(retro)({
						target: { checked: true },
						currentTarget: retro,
					});
				});
				await clickAction(container, "Next");
				await changeField(
					container.querySelector('input[type="number"]') as HTMLInputElement,
					"3",
				);
				await changeField(
					container.querySelector("textarea") as HTMLTextAreaElement,
					"config/local.json\n.env.local",
				);
				await clickAction(container, "Next");
				await changeField(
					container.querySelector(
						'input[aria-label="Target branch for merges"]',
					) as HTMLInputElement,
					"release",
				);
				await clickAction(container, "Next");
				await clickAction(container, "Back");
				expect(
					(
						container.querySelector(
							'input[aria-label="Target branch for merges"]',
						) as HTMLInputElement
					).value,
				).toBe("release");
				await clickAction(container, "Back");
				expect(
					(container.querySelector('input[type="number"]') as HTMLInputElement)
						.value,
				).toBe("3");
				expect(
					(container.querySelector("textarea") as HTMLTextAreaElement).value,
				).toBe("config/local.json\n.env.local");
				await clickAction(container, "Back");
				expect(
					(
						container.querySelector(
							'input[type="checkbox"]',
						) as HTMLInputElement
					).checked,
				).toBe(true);
				await clickAction(container, "Back");
				expect(
					(
						container.querySelector(
							'input[aria-label="Task ID prefix"]',
						) as HTMLInputElement
					).value,
				).toBe("DRAFT");
				expect(
					container
						.querySelector(`[data-tab="${mode}"]`)
						?.getAttribute("aria-selected"),
				).toBe("true");
				const source = container.querySelector(
					mode === "url" ? "input[data-autofocus]" : "#add-panel-new input",
				) as HTMLInputElement;
				expect(source.value).toBe(
					mode === "url" ? "https://github.com/o/wiz.git" : "wiz",
				);
				expect(posts).toHaveLength(0);
			});
		});

		test(`${mode}: Finish creates once and saves all settings before the interview`, async () => {
			await withWizard(mode, async ({ container, posts, closeCount }) => {
				await sourceNext(container);
				const retro = container.querySelector(
					'input[type="checkbox"]',
				) as HTMLInputElement;
				// Retro starts on; clearing it must save off, not drop the field.
				expect(retro.checked).toBe(true);
				await act(async () => {
					onChangeOf(retro)({
						target: { checked: false },
						currentTarget: retro,
					});
				});
				await clickAction(container, "Next");
				await changeField(
					container.querySelector('input[type="number"]') as HTMLInputElement,
					"3",
				);
				await changeField(
					container.querySelector("textarea") as HTMLTextAreaElement,
					"config/local.json",
				);
				await clickAction(container, "Next");
				await changeField(
					container.querySelector(
						'input[aria-label="Target branch for merges"]',
					) as HTMLInputElement,
					"release",
				);
				if (mode === "url") {
					const pr = container.querySelector(
						'input[type="checkbox"]',
					) as HTMLInputElement;
					expect(pr.disabled).toBe(false);
					await act(async () => {
						onChangeOf(pr)({ target: { checked: true }, currentTarget: pr });
					});
				}
				await clickAction(container, "Next");
				expect(posts).toHaveLength(0);
				await clickAction(container, "Finish");
				const creates = posts.filter((p) => p.url === "/api/projects");
				expect(creates).toHaveLength(1);
				expect(creates[0]?.body).toMatchObject(
					mode === "url"
						? { name: "wiz", url: "https://github.com/o/wiz.git" }
						: { name: "wiz", github: false },
				);
				const interview = posts.findIndex(
					(p) => p.url === "/api/projects/wiz/interview",
				);
				expect(interview).toBeGreaterThan(0);
				const saved = Object.assign(
					{},
					...posts
						.slice(0, interview)
						.filter((p) => p.url === "/api/projects/wiz/settings")
						.map((p) => p.body),
				);
				expect(saved).toMatchObject({
					retro: false,
					maxParallel: 3,
					copyExtra: ["config/local.json"],
					targetBranch: "release",
					...(mode === "url" ? { prMode: true } : {}),
				});
				const init = posts.findIndex((p) => p.url === "/api/projects/wiz/init");
				const settings = posts.findIndex(
					(p) => p.url === "/api/projects/wiz/settings",
				);
				if (mode === "new") {
					expect(init).toBeGreaterThan(0);
					expect(settings).toBeGreaterThan(init);
				} else {
					expect(init).toBe(-1);
				}
				expect(posts.filter((p) => p.url.endsWith("/interview"))).toHaveLength(
					1,
				);
				expect(
					posts
						.slice(interview + 1)
						.some(
							(p) =>
								p.url === "/api/projects/wiz/settings" &&
								p.body.setupChecklist === false,
						),
				).toBe(true);
				expect(closeCount()).toBe(1);
			});
		});
	}

	test("Start retro proposals without asking starts on, waits on Retro, and saves a clear on Finish", async () => {
		await withWizard("new", async ({ container, posts }) => {
			await sourceNext(container);
			const box = (label: string): HTMLInputElement => {
				const row = [...container.querySelectorAll("label")].find((l) =>
					l.textContent?.startsWith(label),
				);
				if (row === undefined) throw new Error(`no ${label} row`);
				return row.querySelector("input") as HTMLInputElement;
			};
			const set = async (input: HTMLInputElement, checked: boolean) => {
				await act(async () => {
					onChangeOf(input)({ target: { checked }, currentTarget: input });
				});
			};
			const auto = box("Start retro proposals without asking");
			expect(auto.checked).toBe(true);
			expect(auto.disabled).toBe(false);
			// Retro cleared: the sub-option locks, as the friction filter does.
			await set(box("Retro"), false);
			expect(box("Start retro proposals without asking").disabled).toBe(true);
			await set(box("Retro"), true);
			await set(box("Start retro proposals without asking"), false);
			for (let i = 0; i < 3; i += 1) await clickAction(container, "Next");
			await clickAction(container, "Finish");
			const saved = Object.assign(
				{},
				...posts.filter((p) => p.url.endsWith("/settings")).map((p) => p.body),
			);
			expect(saved).toMatchObject({ retro: true, retroAutoStart: false });
		});
	});

	test("the Automation step offers the watches: PR review options need PR reviews, Finish sends only changes", async () => {
		await withWizard("url", async ({ container, posts }) => {
			await sourceNext(container);
			const box = (label: string): HTMLInputElement => {
				const row = [...container.querySelectorAll("label")].find((l) =>
					l.textContent?.startsWith(label),
				);
				if (row === undefined) throw new Error(`no ${label} row`);
				return row.querySelector("input") as HTMLInputElement;
			};
			const set = async (input: HTMLInputElement, checked: boolean) => {
				await act(async () => {
					onChangeOf(input)({ target: { checked }, currentTarget: input });
				});
			};
			// The stored defaults: notifications and the Dependabot warning start on.
			expect(box("PR review notifications").checked).toBe(true);
			expect(box("Dependabot warning").checked).toBe(true);
			expect(box("Approve when no blocking issues remain").disabled).toBe(true);
			await set(box("PR reviews"), true);
			expect(box("Approve when no blocking issues remain").disabled).toBe(
				false,
			);
			await set(box("Approve when no blocking issues remain"), true);
			await set(box("Issue watch"), true);
			await set(box("Trending scout"), true);
			for (let i = 0; i < 3; i += 1) await clickAction(container, "Next");
			await clickAction(container, "Finish");
			const saved = Object.assign(
				{},
				...posts.filter((p) => p.url.endsWith("/settings")).map((p) => p.body),
			);
			expect(saved).toMatchObject({
				prReviews: true,
				prReviewApprove: true,
				issueWatch: true,
				trendingScout: true,
			});
			// Untouched rows keep the project's own values: never sent.
			expect(saved).not.toHaveProperty("dependabotWarn");
			expect(saved).not.toHaveProperty("ompWatch");
		});
	});

	test("a project without GitHub gets no GitHub watch rows, but omp watch and trending scout", async () => {
		await withWizard("new", async ({ container }) => {
			await sourceNext(container);
			const labels = [...container.querySelectorAll("label")].map(
				(l) => l.textContent ?? "",
			);
			for (const gone of ["Issue watch", "PR reviews", "Dependabot warning"])
				expect(labels.some((t) => t.startsWith(gone))).toBe(false);
			for (const kept of ["omp watch", "Trending scout"])
				expect(labels.some((t) => t.startsWith(kept))).toBe(true);
		});
	});

	test("the Runners step offers the microVM switch, locked while no vm-runner reports ready", async () => {
		await withWizard("new", async ({ container }) => {
			await sourceNext(container);
			await clickAction(container, "Next");
			const row = [...container.querySelectorAll("label")].find((l) =>
				l.textContent?.startsWith("Run work turns in microVMs"),
			);
			if (row === undefined) throw new Error("no microVM row");
			const box = row.querySelector("input") as HTMLInputElement;
			expect(box.checked).toBe(false);
			// This board has no project yet, so no vm-runner state: the switch stays off.
			expect(box.disabled).toBe(true);
			expect(row.textContent).toContain("No vm-runner on this board");
		});
	});

	test("a runner cap of 0 saves as no cap on Finish", async () => {
		await withWizard("new", async ({ container, posts }) => {
			await sourceNext(container);
			await clickAction(container, "Next");
			await changeField(
				container.querySelector('input[type="number"]') as HTMLInputElement,
				"0",
			);
			await clickAction(container, "Next");
			await clickAction(container, "Next");
			await clickAction(container, "Finish");
			const saved = Object.assign(
				{},
				...posts.filter((p) => p.url.endsWith("/settings")).map((p) => p.body),
			);
			expect(saved).toHaveProperty("maxParallel", null);
		});
	});

	for (const changed of [false, true]) {
		test(`clone settings survive Finish with ${changed ? "one explicit change" : "untouched drafts"}`, async () => {
			await withWizard(
				"url",
				async ({ container, posts, closeCount }) => {
					await sourceNext(container);
					await clickAction(container, "Next");
					if (changed) {
						await changeField(
							container.querySelector(
								'input[type="number"]',
							) as HTMLInputElement,
							"2",
						);
					}
					await clickAction(container, "Next");
					await clickAction(container, "Next");
					expect(posts).toHaveLength(0);
					await clickAction(container, "Finish");
					const interview = posts.findIndex((p) =>
						p.url.endsWith("/interview"),
					);
					expect(interview).toBeGreaterThan(0);
					const saved = Object.assign(
						{},
						...posts
							.slice(0, interview)
							.filter((p) => p.url.endsWith("/settings"))
							.map((p) => p.body),
					);
					// Retro and its auto-start are the drafts Finish always sends: both start on.
					const always = { retro: true, retroAutoStart: true };
					expect(saved).toEqual(
						changed ? { ...always, maxParallel: 2 } : always,
					);
					expect(closeCount()).toBe(1);
				},
				{
					hasRules: true,
					savedSettings: {
						retroSince: 1,
						retroFilter: true,
						forkResearch: true,
						holdUpdateMerges: true,
						forkMergeHold: true,
						prMode: true,
						targetBranch: "stable",
						maxParallel: 6,
						copyExtra: ["config/existing.json"],
					},
				},
			);
		});
	}

	test("property: Finish preserves ordered nonempty Extra paths after whitespace normalization", async () => {
		const line = fc
			.tuple(
				fc.constantFrom("", " ", "\t", " \t"),
				fc.string({
					unit: fc.constantFrom("a", "b", "0", ".", "/", "-", "_", " "),
					maxLength: 16,
				}),
				fc.constantFrom("", " ", "\t", "\t "),
			)
			.map((parts) => parts.join(""));
		await fc.assert(
			fc.asyncProperty(fc.array(line, { maxLength: 8 }), async (lines) => {
				await withWizard("url", async ({ container, posts }) => {
					await sourceNext(container);
					await clickAction(container, "Next");
					await changeField(
						container.querySelector("textarea") as HTMLTextAreaElement,
						lines.join("\n"),
					);
					await clickAction(container, "Next");
					await clickAction(container, "Next");
					expect(posts).toHaveLength(0);
					await clickAction(container, "Finish");
					const settings = posts.filter((p) => p.url.endsWith("/settings"));
					expect(settings[0]?.body).toEqual({
						retro: true,
						retroAutoStart: true,
						copyExtra: lines
							.map((value) => value.trim())
							.filter((value) => value !== ""),
					});
					expect(settings.at(-1)?.body).toEqual({ setupChecklist: false });
				});
			}),
		);
	}, 30_000);

	for (const originalMode of ["new", "url"] as const) {
		test(`${originalMode}: source edits after Back reach the final create request`, async () => {
			await withWizard(originalMode, async ({ container, posts }) => {
				await sourceNext(container);
				await clickAction(container, "Next");
				await changeField(
					container.querySelector('input[type="number"]') as HTMLInputElement,
					"3",
				);
				await clickAction(container, "Next");
				await clickAction(container, "Next");
				for (let step = 5; step > 1; step -= 1) {
					await clickAction(container, "Back");
				}
				const finalMode = originalMode === "new" ? "url" : "new";
				await chooseSource(container, finalMode);
				await changeField(
					container.querySelector(
						finalMode === "url"
							? "input[data-autofocus]"
							: "#add-panel-new input",
					) as HTMLInputElement,
					finalMode === "url" ? "https://github.com/o/edited.git" : "edited",
				);
				await changeField(
					container.querySelector(
						'input[aria-label="Task ID prefix"]',
					) as HTMLInputElement,
					"EDITED",
				);
				await sourceNext(container);
				await clickAction(container, "Next");
				expect(
					(container.querySelector('input[type="number"]') as HTMLInputElement)
						.value,
				).toBe("3");
				await clickAction(container, "Next");
				await clickAction(container, "Next");
				expect(posts).toHaveLength(0);
				await clickAction(container, "Finish");
				const creates = posts.filter((p) => p.url === "/api/projects");
				expect(creates).toHaveLength(1);
				expect(creates[0]?.body).toMatchObject({
					name: "edited",
					taskIdPrefix: "EDITED",
					...(finalMode === "url"
						? { url: "https://github.com/o/edited.git" }
						: { github: false }),
				});
				if (finalMode === "new") expect(creates[0]?.body.url).toBeUndefined();
			});
		});
	}

	for (const source of ["new", "non-GitHub URL"] as const) {
		test(`${source}: changed source blocks selected PR mode before writes and permits correction`, async () => {
			await withWizard(
				"url",
				async ({ container, posts, closeCount }) => {
					await sourceNext(container);
					await clickAction(container, "Next");
					await clickAction(container, "Next");
					const pr = container.querySelector(
						'input[type="checkbox"]',
					) as HTMLInputElement;
					await act(async () => {
						onChangeOf(pr)({ target: { checked: true }, currentTarget: pr });
					});
					for (let step = 4; step > 1; step -= 1) {
						await clickAction(container, "Back");
					}
					if (source === "new") {
						await chooseSource(container, "new");
					} else {
						await changeField(
							container.querySelector(
								"input[data-autofocus]",
							) as HTMLInputElement,
							"https://gitlab.com/o/wiz.git",
						);
					}
					await sourceNext(container);
					await clickAction(container, "Next");
					await clickAction(container, "Next");
					await clickAction(container, "Next");
					if (
						[...container.querySelectorAll("button")].some(
							(button) => button.textContent?.trim() === "Finish",
						)
					) {
						await clickAction(container, "Finish");
					}
					expect(
						container.querySelector(
							'[aria-label="Setup steps"] li[aria-current="step"]',
						)?.textContent,
					).toContain("Project");
					const error = container.querySelector('[role="alert"]')?.textContent;
					expect(error).toContain("GitHub");
					expect(error).toContain("PR mode");
					expect(error).toMatch(/Turn off|Source/);
					expect(posts).toHaveLength(0);
					expect(closeCount()).toBe(0);
					const retained = container.querySelector(
						'input[type="checkbox"]',
					) as HTMLInputElement;
					expect(retained.checked).toBe(true);
					expect(retained.disabled).toBe(false);
					await act(async () => {
						onChangeOf(retained)({
							target: { checked: false },
							currentTarget: retained,
						});
					});
					await clickAction(container, "Next");
					await clickAction(container, "Finish");
					const creates = posts.filter((p) => p.url === "/api/projects");
					expect(creates).toHaveLength(1);
					expect(creates[0]?.body).toMatchObject(
						source === "new"
							? { name: "wiz", github: false }
							: { name: "wiz", url: "https://gitlab.com/o/wiz.git" },
					);
					expect(
						posts.find((p) => p.url.endsWith("/settings"))?.body.prMode,
					).toBe(false);
					expect(
						posts.filter((p) => p.url.endsWith("/interview")),
					).toHaveLength(1);
					expect(closeCount()).toBe(1);
				},
				{ createdSource: { github: null, gitless: source === "new" } },
			);
		});
	}

	test("a non-GitHub source omits a hidden fork draft and preserves untouched clone settings", async () => {
		await withWizard(
			"url",
			async ({ container, posts, closeCount }) => {
				await sourceNext(container);
				// The row's own label starts with its name; the fork hold's text also names it.
				const forkRow = (): HTMLLabelElement | undefined =>
					[...container.querySelectorAll("label")].find((label) =>
						label.textContent?.startsWith("Fork research"),
					);
				const forkLabel = forkRow();
				if (forkLabel === undefined) throw new Error("no Fork research row");
				const fork = forkLabel.querySelector("input") as HTMLInputElement;
				await act(async () => {
					onChangeOf(fork)({ target: { checked: true }, currentTarget: fork });
				});
				await clickAction(container, "Back");
				await changeField(
					container.querySelector("input[data-autofocus]") as HTMLInputElement,
					"https://gitlab.com/o/wiz.git",
				);
				await sourceNext(container);
				expect(forkRow()).toBeUndefined();
				await clickAction(container, "Next");
				await clickAction(container, "Next");
				await clickAction(container, "Next");
				expect(posts).toHaveLength(0);
				await clickAction(container, "Finish");
				expect(posts.filter((p) => p.url === "/api/projects")).toHaveLength(1);
				const settings = posts.filter((p) => p.url.endsWith("/settings"));
				// Only Retro and its auto-start (on by default) and the checklist close: no fork draft.
				expect(settings.map((p) => p.body)).toEqual([
					{ retro: true, retroAutoStart: true },
					{ setupChecklist: false },
				]);
				expect(posts.filter((p) => p.url.endsWith("/interview"))).toHaveLength(
					1,
				);
				expect(closeCount()).toBe(1);
			},
			{
				createdSource: { github: null, gitless: false },
				hasRules: true,
				savedSettings: {
					retroSince: 1,
					retroFilter: false,
					forkResearch: true,
					holdUpdateMerges: true,
					forkMergeHold: true,
					maxParallel: 6,
					copyExtra: ["config/existing.json"],
					targetBranch: "stable",
				},
			},
		);
	});

	test("hosted wizard keeps target branch and omits PR mode", async () => {
		await withWizard(
			"url",
			async ({ container, posts }) => {
				await sourceNext(container);
				await clickAction(container, "Next");
				await clickAction(container, "Next");
				expect(container.querySelector('input[type="checkbox"]')).toBeNull();
				const target = container.querySelector(
					'input[aria-label="Target branch for merges"]',
				) as HTMLInputElement;
				expect(target).not.toBeNull();
				await changeField(target, "release");
				await clickAction(container, "Next");
				expect(posts).toHaveLength(0);
				await clickAction(container, "Finish");
				expect(posts.some((p) => p.body.targetBranch === "release")).toBe(true);
				expect(posts.some((p) => "prMode" in p.body)).toBe(false);
			},
			{ hosted: true },
		);
	});

	for (const failure of [
		"create",
		"init",
		"settings",
		"interview",
		"checklist",
	] as const) {
		test(`Finish recovers from ${failure} failure without a duplicate project`, async () => {
			await withWizard(
				failure === "init" ? "new" : "url",
				async ({ container, posts, closeCount }) => {
					await sourceNext(container);
					await clickAction(container, "Next");
					await changeField(
						container.querySelector('input[type="number"]') as HTMLInputElement,
						"3",
					);
					await clickAction(container, "Next");
					await clickAction(container, "Next");
					await clickAction(container, "Finish");
					expect(container.querySelector('[role="alert"]')).not.toBeNull();
					expect(closeCount()).toBe(0);
					if (failure !== "interview" && failure !== "checklist") {
						expect(
							posts.filter((p) => p.url.endsWith("/interview")),
						).toHaveLength(0);
					}
					if (failure === "interview") {
						expect(posts.some((p) => p.body.setupChecklist === false)).toBe(
							false,
						);
					}
					await clickAction(container, "Finish");
					expect(posts.filter((p) => p.url === "/api/projects")).toHaveLength(
						failure === "create" ? 2 : 1,
					);
					const interviewCount = posts.filter((p) =>
						p.url.endsWith("/interview"),
					).length;
					if (failure === "checklist") {
						expect(interviewCount).toBeGreaterThanOrEqual(1);
						expect(interviewCount).toBeLessThanOrEqual(2);
						expect(
							posts.filter((p) => p.body.setupChecklist === false),
						).toHaveLength(2);
					} else {
						expect(interviewCount).toBe(failure === "interview" ? 2 : 1);
					}
					expect(closeCount()).toBe(1);
				},
				{ fail: failure },
			);
		});
	}

	test("SSH tests and changed-host approval do not create before Finish", async () => {
		await withWizard(
			"url",
			async ({ container, posts, closeCount }) => {
				await changeField(
					container.querySelector("input[data-autofocus]") as HTMLInputElement,
					"git@github.com:o/wiz.git",
				);
				await clickAction(container, "Test key");
				expect(posts.filter((p) => p.url === "/api/projects")).toHaveLength(0);
				await clickAction(container, "Trust and test key");
				const tests = posts.filter((p) => p.url === "/api/git-hosts/ssh/test");
				expect(tests).toHaveLength(2);
				expect(tests[0]?.body).toMatchObject({
					url: "git@github.com:o/wiz.git",
					key: "global",
				});
				expect(tests[0]?.body.trust).toBeUndefined();
				expect(tests[1]?.body.trust).toEqual(["SHA256:before"]);
				await reachRules(container);
				expect(posts.filter((p) => p.url === "/api/projects")).toHaveLength(0);
				await clickAction(container, "Finish");
				expect(closeCount()).toBe(0);
				expect(posts.filter((p) => p.url.endsWith("/interview"))).toHaveLength(
					0,
				);
				await clickAction(container, "Trust and finish");
				const creates = posts.filter((p) => p.url === "/api/projects");
				expect(creates.at(-1)?.body).toMatchObject({
					url: "git@github.com:o/wiz.git",
					sshKey: "global",
					trust: ["SHA256:after"],
				});
				expect(
					creates.filter(
						(p) =>
							JSON.stringify(p.body.trust) === JSON.stringify(["SHA256:after"]),
					),
				).toHaveLength(1);
				expect(posts.filter((p) => p.url.endsWith("/interview"))).toHaveLength(
					1,
				);
				expect(closeCount()).toBe(1);
			},
			{ sshAccess: true },
		);
	});

	test("double Finish sends only one create request", async () => {
		const { promise: waitForCreate, resolve: release } =
			Promise.withResolvers<void>();
		try {
			await withWizard(
				"url",
				async ({ container, posts, closeCount }) => {
					await reachRules(container);
					const finish = buttonOf(container, "Finish");
					await act(async () => {
						finish.click();
						finish.click();
					});
					expect(posts.filter((p) => p.url === "/api/projects")).toHaveLength(
						1,
					);
					await act(async () => {
						release();
					});
					expect(posts.filter((p) => p.url === "/api/projects")).toHaveLength(
						1,
					);
					expect(
						posts.filter((p) => p.url.endsWith("/interview")),
					).toHaveLength(1);
					expect(closeCount()).toBe(1);
				},
				{ waitForCreate },
			);
		} finally {
			release();
		}
	});
});

describe("SetupChecklist rules item", () => {
	// Retro and fork research are settled, so the checklist's only possible item is the
	// rules one the add wizard's last step normally settles (docs/specs/add-project-wizard.md).
	const base = {
		name: "proj",
		hasRules: false,
		gitless: false,
		github: null,
		settings: {
			retroSince: 1,
			retroFilter: false,
			forkResearch: true,
			setupChecklist: true,
		},
	} as unknown as ProjectView;

	const renderChecklist = (
		project: ProjectView,
		rulesTask: string | null,
	): string =>
		renderToStaticMarkup(
			<SetupChecklist
				project={project}
				save={async () => true}
				rulesTask={rulesTask === null ? null : ({ id: rulesTask } as TaskCard)}
				openTask={() => {}}
				interview={async () => true}
				initGit={async () => true}
				onOpenSetup={() => {}}
			/>,
		);

	test("a project without rules shows the way to start the interview", () => {
		const html = renderChecklist(base, null);
		expect(html).toContain("No AGENTS.md yet");
		expect(html).toContain("Start rules interview");
	});

	test("a live rules card turns the item into an open action", () => {
		const html = renderChecklist(base, "PROJ-7");
		expect(html).toContain("Open rules task");
		expect(html).not.toContain("Start rules interview");
	});

	test("a gitless project offers Create git repo first", () => {
		const html = renderChecklist(
			{ ...base, gitless: true } as unknown as ProjectView,
			null,
		);
		expect(html).toContain("Create git repo");
		expect(html).not.toContain("Start rules interview");
	});

	test("a project with rules shows no rules item", () => {
		const html = renderChecklist(
			{ ...base, hasRules: true } as unknown as ProjectView,
			null,
		);
		expect(html).not.toContain("No AGENTS.md yet");
		expect(html).not.toContain("Start rules interview");
	});
});

describe("AuthPage setup form", () => {
	const { window } = installBrowserGlobals([
		"location",
		"localStorage",
		"Event",
		"HTMLElement",
		"HTMLInputElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	/** The form-submit DOM event; happy-dom's Event class does not match lib.dom's. */
	const submitEvent = (): Event =>
		new window.Event("submit", {
			bubbles: true,
			cancelable: true,
		}) as unknown as Event;
	/** A React onChange picks up programmatic edits only through the native value setter. */
	const typeInto = typeIntoFor(window);

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
		const { restore } = stubFetch(async (url, init) => {
			const body =
				init?.body === undefined ? null : JSON.parse(String(init.body));
			if (init?.method === "POST") posts.push({ url, body });
			return respond(url, body);
		});
		// The success path reloads the page; happy-dom's reload would navigate away.
		const reloadCalls = { n: 0 };
		window.location.reload = () => {
			reloadCalls.n++;
		};
		// happy-dom's DOM classes do not structurally match lib.dom's; the test
		// speaks lib types, so the boundary converts once here.
		const { container, unmount } = await mount(
			<AuthPage mode="setup" version={null} />,
		);
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
				await unmount();
				restore();
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
	const { window } = installBrowserGlobals([
		"Event",
		"HTMLSelectElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);
	beforeAll(() => {
		// LaneCol's FLIP effect animates committed order changes; happy-dom has no WAAPI.
		const proto = window.HTMLElement.prototype as unknown as Record<
			string,
			unknown
		>;
		proto.animate ??= () => ({ finished: Promise.resolve() });
		proto.showPopover ??= () => {};
		proto.hidePopover ??= () => {};
	});

	const project = drawerProject;
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
	const stubGatedFetch = (
		gates: { url: string; resolve: (status: number) => void }[],
	): (() => void) => {
		const { restore } = stubFetch(async (url) => {
			const g = gates.find((x) => url.endsWith(x.url));
			if (g !== undefined) {
				const status = await new Promise<number>((r) => (g.resolve = r));
				return new Response("{}", { status });
			}
			return new Response("{}", { status: 404 });
		});
		return () => {
			restore();
		};
	};
	/** Mounts the Drawer with `task` under act(), runs `body`, unmounts. */
	const withDrawer = async (
		task: TaskCard,
		gates: Parameters<typeof stubGatedFetch>[0],
		body: () => Promise<void>,
	): Promise<void> => {
		const restore = stubGatedFetch(gates);
		const { unmount } = await mount(<Drawer {...base} task={task} />);
		try {
			await act(async () => {});
			await body();
		} finally {
			await unmount();
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
		const g = { url: "/star" } as Parameters<typeof stubGatedFetch>[0][number];
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
		const g = { url: "/star" } as Parameters<typeof stubGatedFetch>[0][number];
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
		const g = { url: "/triage" } as Parameters<
			typeof stubGatedFetch
		>[0][number];
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
		const g = { url: "/triage" } as Parameters<
			typeof stubGatedFetch
		>[0][number];
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
		const g = { url: "/model" } as Parameters<typeof stubGatedFetch>[0][number];
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
		const { restore } = stubFetch(async (url) => {
			if (url.endsWith("/api/models")) return models.clone();
			const gateHit = url.endsWith(g.url);
			if (gateHit) {
				const status = await new Promise<number>((r) => (g.resolve = r));
				return new Response("{}", { status });
			}
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mount(
			<Drawer {...base} task={modelTask()} />,
		);
		try {
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
			await unmount();
			restore();
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
		const { restore } = stubFetch(async (url) => {
			if (url.endsWith("/api/models")) return pending;
			return new Response("{}", { status: 404 });
		});
		const { container, unmount } = await mount(
			<Drawer {...base} task={modelTask()} />,
		);
		try {
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
			await unmount();
			restore();
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
	/** Mounts the todo LaneCol with a deferred onReorder promise. */
	const mountReorderLane = async () => {
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
		return { container, root, resolveReorder, order };
	};
	/** Moves card b above a through the keyboard handler (the pointer-free path). */
	const moveBUp = async (container: HTMLDivElement): Promise<void> => {
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
	};
	test("queue reorder applies the new order at once and rolls it back on failure", async () => {
		const { container, root, resolveReorder, order } = await mountReorderLane();
		try {
			expect(order()).toEqual(["a", "b", "c"]);
			// Keyboard reorder (the pointer-free path): Alt+ArrowUp moves b above a.
			await moveBUp(container);
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
		const { container, root, resolveReorder, order } = await mountReorderLane();
		try {
			await moveBUp(container);
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

	test("a queue reorder posts the moved card and its anchor, not the full order", async () => {
		const bodies: unknown[] = [];
		const { restore } = stubFetch(async (url, init) => {
			if (url.endsWith("/queue") && (init?.method ?? "GET") === "POST") {
				bodies.push(JSON.parse(String(init?.body)));
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			return new Response("{}", { status: 404 });
		});
		const tasks = [
			cardFixture({ id: "a", stage: "todo", state: "queued" }),
			cardFixture({ id: "b", stage: "todo", state: "queued" }),
			cardFixture({ id: "c", stage: "todo", state: "idle" }),
		];
		const project = boardProject(0);
		const { container, unmount } = await mountProjectBoard(project, tasks);
		try {
			const b = container.querySelector('.card[data-task-id="b"]')!;
			// Keyboard reorder (the pointer-free path): Alt+ArrowUp moves b above a.
			// The lanes all render a .stage-cards; the todo lane is the one b queues in.
			await act(async () => {
				propHandler(
					container.querySelector('[data-stage="todo"] .stage-cards')!,
					"onKeyDown",
				)({
					altKey: true,
					key: "ArrowUp",
					target: b,
					preventDefault: () => {},
				} as unknown);
			});
			// The request names the moved card and the card below it only.
			expect(bodies).toEqual([{ id: "b", before: "a" }]);
		} finally {
			await unmount();
			restore();
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
		const g = { url: "/steer" } as Parameters<typeof stubGatedFetch>[0][number];
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
		github: "https://github.com/ottr-ai/ottr",
		hasRules: true,
		sessionsDir: "/tmp/proj/.tasks/sessions",
		settings: {},
	} as unknown as ProjectView;
	const base = { ...drawerBase, project };
	installBrowserGlobals([
		"Event",
		"HTMLElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	// happy-dom's dispatched clicks never reach React's event plugin (same
	// upstream gap as settings.test.tsx's onChangeOf): call the production
	// onClick React rendered onto the node instead.

	/** Renders a drawer for `card` under a fetch stub; the stub records the
	 * rerun POSTs and answers them with `rerun`, everything else with 404.
	 * `projectView` overrides the suite's project fixture (OTTR-1005 binding cases). */
	const withRoot = (
		card: TaskCard,
		rerun: { status: number; body: unknown },
		run: (args: DrawerRunArgs) => Promise<void>,
		projectView: ProjectView = project,
	): Promise<void> =>
		withDrawerRoute(base, card, "/rerun-failed-jobs", rerun, run, projectView);

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

	test("a card linking another repository's run renders no button", async () => {
		const card = cardFixture({
			...drawerFields,
			prompt:
				"See https://github.com/octocat/other/actions/runs/777 — same failure shape",
		}) as TaskCard;
		await withRoot(
			card,
			{ status: 200, body: { ok: true, url: "" } },
			async ({ container }) => {
				expect(container.textContent).not.toContain("Re-run failed jobs");
			},
		);
	});

	test("a project with no GitHub repository renders no button even on a project-repo link", async () => {
		const card = cardFixture({
			...drawerFields,
			prompt:
				"Fix the CI failure in https://github.com/ottr-ai/ottr/actions/runs/42313545100",
		}) as TaskCard;
		await withRoot(
			card,
			{ status: 200, body: { ok: true, url: "" } },
			async ({ container }) => {
				expect(container.textContent).not.toContain("Re-run failed jobs");
			},
			{ ...project, github: null } as unknown as ProjectView,
		);
	});
});

describe("Drawer validate blocked leads again action", () => {
	// OTTR-1129: a done review card's drawer offers "Validate blocked leads again"
	// — a required datetime and a busy button that POSTs to the validate route.
	const _project = drawerProject;
	const base = drawerBase;
	const { window } = installBrowserGlobals([
		"Event",
		"HTMLElement",
		"HTMLInputElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	// happy-dom's dispatched clicks never reach React's event plugin (same
	// upstream gap as settings.test.tsx's onChangeOf): call the production
	// onClick React rendered onto the node instead.

	// A React onChange picks up programmatic edits only through the native value
	// setter, and happy-dom's dispatched input event never reaches React's
	// ChangeEventPlugin: set the value natively, then call the production onChange.
	const typeInto = (el: HTMLInputElement, value: string): void => {
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		if (setter === undefined) throw new Error("value setter missing");
		setter.call(el, value);
		onChangeOf(el)({ target: el, currentTarget: el });
	};

	// Same happy-dom gap as onClickOf above, for onChange handlers.

	const doneReviewCard = (): TaskCard =>
		cardFixture({
			...drawerFields,
			kind: "review",
			stage: "done",
			state: "idle",
			prompt: "Review the quota changes",
		}) as TaskCard;

	// OTTR-1166: a done release card is kind "work" with a non-null
	// releaseVersion; isReview includes it, so the drawer offers the same
	// control. releaseNotes stays null so the notes section renders its empty
	// line instead of Markdown over a missing field.
	const doneReleaseCard = (): TaskCard =>
		cardFixture({
			...drawerFields,
			kind: "work",
			releaseVersion: "v0.44.0",
			releaseNotes: null,
			stage: "done",
			state: "idle",
			prompt: "Release v0.44.0",
		}) as TaskCard;

	/** Renders a drawer for `card` under a fetch stub; the stub records the
	 * validate POSTs and answers them with `respond`, everything else with 404. */
	const withRoot = (
		card: TaskCard,
		respond: { status: number; body: unknown },
		run: (args: DrawerRunArgs) => Promise<void>,
	): Promise<void> => withDrawerRoute(base, card, "/validate", respond, run);

	const validateInput = (container: HTMLDivElement): HTMLInputElement => {
		const node = container.querySelector(
			'input[type="datetime-local"]#validate-again-before',
		);
		if (node === null) throw new Error("no validate-again datetime input");
		return node as unknown as HTMLInputElement;
	};

	const validateButton = (container: HTMLDivElement): Element => {
		for (const node of container.querySelectorAll("button"))
			if (node.textContent?.includes("Validate blocked leads again"))
				return node;
		throw new Error("no Validate blocked leads again button");
	};

	test("a done review card renders the datetime and the button, disabled while the input is empty", async () => {
		await withRoot(
			doneReviewCard(),
			{ status: 200, body: { id: "v1", reset: [] } },
			async ({ container }) => {
				const input = validateInput(container);
				const button = validateButton(container);
				const label = container.querySelector(
					'label[for="validate-again-before"]',
				);
				expect(label?.textContent).toContain("Validate blocked leads again");
				expect(input.getAttribute("required")).not.toBeNull();
				expect((button as HTMLButtonElement).disabled).toBe(true);
			},
		);
	});

	test("a non-done or cancelled review card renders no validate control", async () => {
		const card = cardFixture({
			...drawerFields,
			kind: "review",
			stage: "in_progress",
			state: "running",
			prompt: "Review the quota changes",
		}) as TaskCard;
		await withRoot(
			card,
			{ status: 200, body: { id: "v1", reset: [] } },
			async ({ container }) => {
				expect(container.textContent).not.toContain(
					"Validate blocked leads again",
				);
			},
		);
	});

	test("setting a datetime enables the button; clicking POSTs again:blocked with the chosen instant", async () => {
		await withRoot(
			doneReviewCard(),
			{ status: 200, body: { id: "v1", reset: [] } },
			async ({ posts, container }) => {
				const input = validateInput(container);
				const button = validateButton(container);
				expect((button as HTMLButtonElement).disabled).toBe(true);
				await act(async () => {
					typeInto(input, "2026-11-05T09:30");
				});
				expect((validateButton(container) as HTMLButtonElement).disabled).toBe(
					false,
				);
				await act(async () => {
					onClickOf(validateButton(container))({});
				});
				await act(async () => {});
				const post = posts.at(-1);
				expect(post?.url.endsWith("/tasks/t1/validate")).toBe(true);
				expect(post?.body).toEqual({
					again: "blocked",
					before: new Date("2026-11-05T09:30").toISOString(),
				});
			},
		);
	});

	/** Fills the validate datetime, POSTs, and expects the inline in-flight alert. */
	const expectValidateInFlightAlert = async (card: TaskCard) => {
		await withRoot(
			card,
			{
				status: 409,
				body: { error: "a validation run is already in flight" },
			},
			async ({ posts, container }) => {
				await act(async () => {
					typeInto(validateInput(container), "2026-11-05T09:30");
				});
				await act(async () => {
					onClickOf(validateButton(container))({});
				});
				await act(async () => {});
				expect(posts).toHaveLength(1);
				const alerts = [...container.querySelectorAll('p[role="alert"]')];
				expect(
					alerts.some((a) =>
						a.textContent?.includes("a validation run is already in flight"),
					),
				).toBe(true);
				expect(container.textContent).not.toContain("Validation run filed.");
			},
		);
	};

	test("a failed validate POST surfaces the message as an inline alert", async () => {
		await expectValidateInFlightAlert(doneReviewCard());
	});

	test("an ok response surfaces the Validation run filed status line", async () => {
		await withRoot(
			doneReviewCard(),
			{ status: 200, body: { id: "v1", reset: [] } },
			async ({ container }) => {
				await act(async () => {
					typeInto(validateInput(container), "2026-11-05T09:30");
				});
				await act(async () => {
					onClickOf(validateButton(container))({});
				});
				await act(async () => {});
				const statuses = [...container.querySelectorAll('p[role="status"]')];
				expect(
					statuses.some((s) =>
						s.textContent?.includes("Validation run filed."),
					),
				).toBe(true);
				expect(container.textContent).not.toContain(
					"a validation run is already in flight",
				);
			},
		);
	});

	test("a done release card renders the datetime and the button too (OTTR-1166)", async () => {
		await withRoot(
			doneReleaseCard(),
			{ status: 200, body: { id: "v1", reset: [] } },
			async ({ container }) => {
				const input = validateInput(container);
				const button = validateButton(container);
				const label = container.querySelector(
					'label[for="validate-again-before"]',
				);
				expect(label?.textContent).toContain("Validate blocked leads again");
				expect(input.getAttribute("required")).not.toBeNull();
				expect((button as HTMLButtonElement).disabled).toBe(true);
			},
		);
	});

	test("a done release card's retry POSTs the validate route with the again body (OTTR-1166)", async () => {
		await withRoot(
			doneReleaseCard(),
			{ status: 200, body: { id: "v1", reset: [] } },
			async ({ posts, container }) => {
				await act(async () => {
					typeInto(validateInput(container), "2026-11-05T09:30");
				});
				await act(async () => {
					onClickOf(validateButton(container))({});
				});
				await act(async () => {});
				const post = posts.at(-1);
				expect(post?.url.endsWith("/tasks/t1/validate")).toBe(true);
				expect(post?.body).toEqual({
					again: "blocked",
					before: new Date("2026-11-05T09:30").toISOString(),
				});
				const statuses = [...container.querySelectorAll('p[role="status"]')];
				expect(
					statuses.some((s) =>
						s.textContent?.includes("Validation run filed."),
					),
				).toBe(true);
			},
		);
	});

	test("a failed validate POST on a release card surfaces the inline alert (OTTR-1166)", async () => {
		await expectValidateInFlightAlert(doneReleaseCard());
	});

	test("an ordinary done work card renders no validate control (OTTR-1166)", async () => {
		const card = cardFixture({
			...drawerFields,
			kind: "work",
			stage: "done",
			state: "idle",
			prompt: "Fix the widget",
		}) as TaskCard;
		await withRoot(
			card,
			{ status: 200, body: { id: "v1", reset: [] } },
			async ({ container }) => {
				expect(container.textContent).not.toContain(
					"Validate blocked leads again",
				);
			},
		);
	});

	test("an unfinished or cancelled release card renders no validate control (OTTR-1166)", async () => {
		const unfinished = cardFixture({
			...drawerFields,
			kind: "work",
			releaseVersion: "v0.44.0",
			releaseNotes: null,
			stage: "merging",
			state: "running",
			prompt: "Release v0.44.0",
		}) as TaskCard;
		const cancelledDone = cardFixture({
			...drawerFields,
			kind: "work",
			releaseVersion: "v0.44.0",
			releaseNotes: null,
			stage: "done",
			state: "idle",
			cancelledAt: 1,
			prompt: "Release v0.44.0",
		}) as TaskCard;
		for (const card of [unfinished, cancelledDone]) {
			await withRoot(
				card,
				{ status: 200, body: { id: "v1", reset: [] } },
				async ({ container }) => {
					expect(container.textContent).not.toContain(
						"Validate blocked leads again",
					);
				},
			);
		}
	});
});

describe("Drawer start validation run on a queued lead", () => {
	// OTTR-1247: a queued pending sandbox lead's drawer offers the manual start of
	// its review's batch validation run. One POST names the lead: the filing parks
	// it in the review's backlog inside its own transaction, so a refusal leaves
	// the hold, the button and the error untouched. The review resolves through
	// the lineage fetch too, because the Done window can drop it from the board's
	// task list.
	installBrowserGlobals([
		"Event",
		"HTMLElement",
		"HTMLInputElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	const leadCard = (over: Partial<TaskCard> = {}): TaskCard =>
		cardFixture({
			...drawerFields,
			prompt: "Needs validation: retry\nBlocker: sandbox run: no network deny",
			validatedAt: null,
			followUpOf: "r9",
			...over,
		}) as TaskCard;

	const reviewCard = (over: Partial<TaskCard> = {}): TaskCard =>
		cardFixture({
			...drawerFields,
			id: "r9",
			kind: "review",
			prompt: "Review the quota changes",
			stage: "done",
			state: "idle",
			...over,
		}) as TaskCard;

	/** Renders the lead's drawer with the review out of the board's task list;
	 * the drawer loads it through the lineage route. `handlers` answer the
	 * action POSTs and record them. */
	const withLeadDrawer = async (
		lead: TaskCard,
		review: TaskCard | null,
		handlers: { suffix: string; status: number; body: unknown }[],
		run: (args: DrawerRunArgs) => Promise<void>,
	): Promise<void> => {
		const posts: { url: string; body: unknown }[] = [];
		const { restore } = stubFetch(async (url, init) => {
			const u = String(url);
			const hit = handlers.find((h) => u.endsWith(h.suffix));
			if (hit) {
				posts.push({
					url: u,
					body: JSON.parse(String(init?.body)) as unknown,
				});
				return new Response(JSON.stringify(hit.body), { status: hit.status });
			}
			if (u.endsWith(`/tasks/${lead.id}`))
				return new Response(JSON.stringify({ ...lead, turns: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			if (review !== null && u.endsWith(`/tasks/${review.id}`))
				return new Response(JSON.stringify({ ...review, turns: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			return new Response("{}", { status: 404 });
		});
		const { container, root, unmount } = await mount(
			<Drawer {...drawerBase} task={lead} tasks={[lead]} />,
		);
		try {
			// One act for the lead detail, one for the lineage fetch of the review.
			await act(async () => {});
			await act(async () => {});
			await run({ posts, container, root });
		} finally {
			await unmount();
			restore();
		}
	};

	const startButton = (container: HTMLDivElement): Element => {
		for (const node of container.querySelectorAll("button"))
			if (node.textContent?.includes("Start validation run")) return node;
		throw new Error("no Start validation run button");
	};

	test("POSTs the validate route with the lead id", async () => {
		await withLeadDrawer(
			leadCard(),
			reviewCard(),
			[
				{
					suffix: "/tasks/r9/validate",
					status: 200,
					body: { id: "v1", reset: [] },
				},
			],
			async ({ posts, container }) => {
				await act(async () => {
					onClickOf(startButton(container))({});
				});
				await act(async () => {});
				expect(posts).toHaveLength(1);
				expect(posts[0]?.url.endsWith("/tasks/r9/validate")).toBe(true);
				// One atomic POST: the filing parks the lead in its transaction.
				expect(posts[0]?.body).toEqual({ lead: "t1" });
				const statuses = [...container.querySelectorAll('p[role="status"]')];
				expect(
					statuses.some((s) =>
						s.textContent?.includes("Validation run filed."),
					),
				).toBe(true);
			},
		);
	});

	test("an in_progress queued lead renders the button and POSTs once", async () => {
		// The hold shows for in_progress too, and the filing's park handles that
		// stage server-side — no backlog route involved (OTTR-1247 send-back 2).
		await withLeadDrawer(
			leadCard({ stage: "in_progress" }),
			reviewCard(),
			[
				{
					suffix: "/tasks/r9/validate",
					status: 200,
					body: { id: "v1", reset: [] },
				},
			],
			async ({ posts, container }) => {
				await act(async () => {
					onClickOf(startButton(container))({});
				});
				await act(async () => {});
				expect(posts).toHaveLength(1);
				expect(posts[0]?.url.endsWith("/tasks/r9/validate")).toBe(true);
			},
		);
	});

	test("a started lead with a worktree renders the button disabled", async () => {
		await withLeadDrawer(
			leadCard({ worktree: "/tmp/lead-worktree" }),
			reviewCard(),
			[],
			async ({ container }) => {
				const button = startButton(container) as HTMLButtonElement;
				expect(button.disabled).toBe(true);
				expect(button.getAttribute("title")).toBe(
					"Only a queued lead without a worktree and without a queued reply can join a batch. Reply to settle the steer first, or cancel.",
				);
			},
		);
	});

	test("a steered lead renders the button disabled with the reason", async () => {
		// A queued reply (Steer) makes the filing refuse; the drawer must show
		// that as a disabled action, never one that cannot work (send-back 3).
		await withLeadDrawer(
			leadCard({ pendingPrompt: "please merge" }),
			reviewCard(),
			[],
			async ({ posts, container }) => {
				const button = startButton(container) as HTMLButtonElement;
				expect(button.disabled).toBe(true);
				expect(button.getAttribute("title")).toBe(
					"Only a queued lead without a worktree and without a queued reply can join a batch. Reply to settle the steer first, or cancel.",
				);
				await act(async () => {
					onClickOf(startButton(container))({});
				});
				await act(async () => {});
				expect(posts).toHaveLength(0);
			},
		);
	});

	test("a failed filing keeps the error and the button visible", async () => {
		// The filing refused (another run open): the lead never moved, so the hold
		// and the action stay — the operator can retry or cancel (send-back 2).
		await withLeadDrawer(
			leadCard(),
			reviewCard(),
			[
				{
					suffix: "/tasks/r9/validate",
					status: 409,
					body: { error: "a validation run is already open" },
				},
			],
			async ({ posts, container }) => {
				await act(async () => {
					onClickOf(startButton(container))({});
				});
				await act(async () => {});
				expect(posts).toHaveLength(1);
				const alerts = [...container.querySelectorAll('p[role="alert"]')];
				expect(
					alerts.some((a) =>
						a.textContent?.includes("a validation run is already open"),
					),
				).toBe(true);
				expect(container.textContent?.includes("Start validation run")).toBe(
					true,
				);
				expect(container.textContent).not.toContain("Validation run filed.");
			},
		);
	});

	test("a lead whose review still runs renders the button disabled", async () => {
		// The review cannot take a batch yet — the drawer names that instead of
		// offering an action that answers 409.
		await withLeadDrawer(
			leadCard(),
			reviewCard({ stage: "in_progress", state: "running" }),
			[],
			async ({ container }) => {
				const button = startButton(container) as HTMLButtonElement;
				expect(button.disabled).toBe(true);
				expect(button.getAttribute("title")).toBe(
					"Review r9 must finish (or hold at merging for its findings) before a batch validation can start.",
				);
			},
		);
	});

	test("a validated lead renders no validate control", async () => {
		await withLeadDrawer(
			leadCard({ validatedAt: 5 }),
			reviewCard(),
			[],
			async ({ container }) => {
				expect(container.textContent).not.toContain("Start validation run");
			},
		);
	});
});

describe("AddProjectModal Git URL field error", () => {
	const { window } = installBrowserGlobals([
		"HTMLElement",
		"HTMLInputElement",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	const submitEvent = (): Event =>
		new window.Event("submit", {
			bubbles: true,
			cancelable: true,
		}) as unknown as Event;

	const typeInto = typeIntoFor(window);

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
		const { restore } = stubFetch(async (url, init) => {
			const method = init?.method ?? "GET";
			if (url.endsWith("/api/projects") && method === "POST") {
				posts.push({ url });
				return new Response(JSON.stringify({ project }), {
					status: 200,
				});
			}
			return new Response("{}", { status: 404 });
		});
		const { container, root, unmount } = await mount(
			<AddProjectModal
				act={async (fn) => {
					await fn();
					return true;
				}}
				onClose={() => {}}
				openTask={() => {}}
				projects={[]}
			/>,
		);
		try {
			await run({ container, root, posts });
		} finally {
			await unmount();
			restore();
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
	const _project = drawerProject;
	const base = {
		...drawerBase,
		act: async (fn: () => Promise<void>) => {
			await fn();
			return true;
		},
	};
	installBrowserGlobals([
		"Event",
		"HTMLElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	/** Renders a drawer for `card` under a fetch stub; the stub records the
	 * triage POSTs and answers 200, everything else 404. */
	const withDrawer = async (
		card: TaskCard,
		run: (args: {
			container: HTMLDivElement;
			root: ReturnType<typeof createRoot>;
			posts: { url: string; body: unknown }[];
		}) => Promise<void>,
		// Without cancelBody the stub routes the triage POST; with it, the
		// cancel/stop POSTs, answering the given body on /cancel.
		cancelBody?: Record<string, unknown>,
	): Promise<void> => {
		const posts: { url: string; body: unknown }[] = [];
		const { restore } = stubFetch(async (url, init) => {
			const u = String(url);
			const routed =
				cancelBody === undefined
					? u.endsWith("/triage")
					: (u.endsWith("/cancel") || u.endsWith("/stop")) &&
						(init?.method ?? "GET") === "POST";
			if (!routed) return new Response("{}", { status: 404 });
			posts.push({
				url: u,
				body: JSON.parse(String(init?.body)) as unknown,
			});
			if (cancelBody === undefined) return new Response("{}", { status: 200 });
			return new Response(
				JSON.stringify(u.endsWith("/cancel") ? cancelBody : {}),
				{ status: 200 },
			);
		});
		const { container, root, unmount } = await mount(
			<Drawer {...base} task={card} />,
		);
		try {
			await run({ container, root, posts });
		} finally {
			await unmount();
			restore();
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
	const _project = drawerProject;
	const base = {
		...drawerBase,
		act: async (fn: () => Promise<void>) => {
			await fn();
			return true;
		},
	};
	const { window } = installDrawerClientGlobals();

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
	const actionButton = (container: HTMLDivElement, label: string): Element => {
		for (const node of container.querySelectorAll(".drawer-actions button"))
			if (node.textContent?.includes(label)) return node;
		throw new Error(`no ${label} button in the drawer`);
	};

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
		const { restore } = stubFetch(async (url, init) => {
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
		});
		const { container, root, unmount } = await mount(
			<Drawer {...base} task={card} />,
		);
		try {
			await run({ container, root, posts });
		} finally {
			await unmount();
			restore();
		}
	};

	test("the delete confirm names the done task", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "done",
			state: "idle",
		}) as TaskCard;
		await withDrawer(
			card,
			async ({ container }) => {
				await act(async () => {
					onClickOf(actionButton(container, "Delete task"))({});
				});
				expect(question()).toBe(
					'Delete the done task t1 "Task one" from the board?',
				);
				await dismiss();
			},
			{},
		);
	});

	test("the cancel confirm names the task", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
		}) as TaskCard;
		await withDrawer(
			card,
			async ({ container }) => {
				await act(async () => {
					onClickOf(actionButton(container, "Cancel task"))({});
				});
				expect(question()).toBe('Cancel t1 "Task one"?');
				await dismiss();
			},
			{},
		);
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
		await withDrawer(
			card,
			async ({ container }) => {
				const newSession = [...container.querySelectorAll("button")].find((b) =>
					b.textContent?.includes("New session"),
				);
				if (newSession === undefined) throw new Error("no New session button");
				await act(async () => {
					onClickOf(newSession)({});
				});
				expect(question()).toBe('Start a fresh omp session for t1 "Task one"?');
				await dismiss();
			},
			{},
		);
	});

	test("the stop-turn confirm names the task", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
		}) as TaskCard;
		await withDrawer(
			card,
			async ({ container }) => {
				const stop = [...container.querySelectorAll("button")].find((b) =>
					b.textContent?.includes("Stop turn"),
				);
				if (stop === undefined) throw new Error("no Stop turn button");
				await act(async () => {
					onClickOf(stop)({});
				});
				expect(question()).toBe('Stop the running turn of t1 "Task one"?');
				await dismiss();
			},
			{},
		);
	});

	test("the double-check stop confirm names the task too", async () => {
		const card = cardFixture({
			...drawerFields,
			stage: "todo",
			state: "running",
		}) as TaskCard;
		await withDrawer(
			card,
			async ({ container, posts }) => {
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
				expect(question()).toBe(
					'Really stop the running turn of t1 "Task one"?',
				);
				// The second yes (Stop turn) sends the stop.
				await act(async () => {
					press(dialogButton("Stop turn"));
				});
				await settle();
				expect(posts.some((p) => p.url.endsWith("/stop"))).toBe(true);
			},
			{},
		);
	});
});

describe("Release card re-release confirm names its target", () => {
	const { window } = installBrowserGlobals([
		"HTMLElement",
		"HTMLInputElement",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

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
		const { restore } = stubFetch(async (url, init) => {
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
		});
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
			doneTotal: 0,
			settings: { setupChecklist: false },
			sessionsDir: "/tmp/s",
		} as unknown as ProjectView;
		const { container, unmount } = await mount(
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
		try {
			// A stalled release card: parked for the user, merges still held, every
			// finding landed — reReleaseOf's re-release view, so the card carries
			// the Release again chip.
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
			await unmount();
			restore();
		}
	});
});
describe("LogView fetch start offset (client)", () => {
	// The same happy-dom swap as the ProjectBoard block above: installed after
	// app.tsx's import (its browser mount guard reads document at module load).
	installBrowserGlobals([
		"HTMLElement",
		"HTMLInputElement",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

	const project = { name: "proj", settings: {} } as unknown as ProjectView;

	/** Mount LogView with a mocked fetch that records every log URL and serves one chunk. */
	async function mountLogView(props: {
		startedAt: number;
		logOffset?: number | null;
	}): Promise<{ urls: string[]; unmount: () => Promise<void> }> {
		const urls: string[] = [];
		const { restore } = stubFetch(async (url) => {
			if (url.includes("/log?")) {
				urls.push(url);
				const res = new Response("chunk", {
					headers: { "X-Log-Size": String(5) },
				});
				return res;
			}
			return new Response("{}", { status: 404 });
		});
		const { unmount } = await mount(
			<LogView project={project} taskId="t1" {...props} />,
		);
		return {
			urls,
			unmount: async () => {
				await unmount();
				restore();
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
	installBrowserGlobals([
		"Event",
		"HTMLElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]);

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
		// A sibling test file can leave the shared catalog cache filled (one bun
		// process runs several files); the two-paint premise needs it empty.
		resetCatalogCache();
		// Card's model catalog fetch degrades to no catalog on a failed response.
		const { restore } = stubFetch(
			async () => new Response("{}", { status: 404 }),
		);
		const frame = (tasks: TaskCard[]): StateResponse =>
			({ tasks }) as unknown as StateResponse;
		let renders = 0;
		const board = await mount(<LaneCol {...laneProps([], [])} tick={0} />);
		const { container, root, unmount } = board;
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
			await unmount();
			restore();
		}
	});
});

describe("AppInboxBell badge", () => {
	test("Ops faults count once as action-required and share notice acknowledgement keys", () => {
		const state = {
			hosted: false,
			projects: [],
			deadSignIns: [{ provider: "anthropic" }],
			seedFailed: { since: 123, commit: "abc", text: "Seed failed" },
			alateProvisionError: "Provision failed",
		} as unknown as StateResponse;
		const keys = appNoticeKeys(
			state,
			new Map(),
			null,
			null,
			false,
			0,
			null,
			state.seedFailed ?? null,
			false,
			[],
			null,
			{ held: 0, stale: 0 } as StateResponse["keptWorktrees"],
			0,
		);
		const noticeKeys = [
			"signin:anthropic",
			keys.seedFailKey!,
			keys.provisionErrKey!,
		];
		const meta = appInboxMeta(
			state,
			new Set(),
			null,
			null,
			[],
			[],
			[],
			[],
			noticeKeys,
			[],
			0,
			"",
		);
		expect(meta.entries).toEqual(
			noticeKeys.map((key) => ({ key, level: "needs" })),
		);
		expect(meta.inbox.total).toBe(3);
		expect(meta.inbox.fresh).toHaveLength(3);
		expect(meta.inbox.level).toBe("needs");
		const read = appInboxMeta(
			{ ...state, inboxSeen: noticeKeys },
			new Set(),
			null,
			null,
			[],
			[],
			[],
			[],
			noticeKeys,
			[],
			0,
			"",
		);
		expect(read.inbox.fresh).toHaveLength(0);
		expect(read.inbox.lit).toBe(true);
		const markedAll = appInboxMeta(
			state,
			new Set(meta.entries.map((entry) => entry.key)),
			null,
			null,
			[],
			[],
			[],
			[],
			noticeKeys,
			[],
			0,
			"",
		);
		expect(markedAll.inbox.fresh).toHaveLength(0);
		const hosted = appInboxMeta(
			{ ...state, hosted: true },
			new Set(),
			null,
			null,
			[],
			[],
			[],
			[],
			[],
			[],
			0,
			"",
		);
		expect(hosted.inbox.total).toBe(0);
	});

	// 5 needs-you + 18 asked + 6 notices = 29 entries, as the panel lists them. The
	// last `ackedCount` entries count as acknowledged, so the rest stay fresh.
	const inboxMeta = (
		acked: Set<string>,
		need: TaskCard[],
		ask: TaskCard[],
		info: string[],
	): ReturnType<typeof appInboxMeta> =>
		appInboxMeta(null, acked, null, null, need, ask, [], [], info, [], 0, "");
	const metaWithAcks = (ackedCount: number) => {
		const need = Array.from({ length: 5 }, (_, n) =>
			cardFixture({ id: `need${n}` }),
		);
		const ask = Array.from({ length: 18 }, (_, n) =>
			cardFixture({ id: `ask${n}` }),
		);
		const info = Array.from({ length: 6 }, (_, n) => `notice:n${n}`);
		const probe = inboxMeta(new Set<string>(), need, ask, info);
		const ackLocal = new Set(
			probe.entries.slice(probe.entries.length - ackedCount).map((e) => e.key),
		);
		return inboxMeta(ackLocal, need, ask, info);
	};
	/** The meta for entry lists where every entry is acknowledged: a probe pass
	 * collects the keys, then the real pass takes the ack set. */
	const ackedAllMeta = (
		need: TaskCard[],
		ask: TaskCard[],
		info: string[],
	): ReturnType<typeof appInboxMeta> => {
		const probe = inboxMeta(new Set<string>(), need, ask, info);
		const ackLocal = new Set(probe.entries.map((e) => e.key));
		return inboxMeta(ackLocal, need, ask, info);
	};

	const bell = (meta: ReturnType<typeof appInboxMeta>) =>
		renderToStaticMarkup(
			<AppInboxBell
				inbox={meta.inbox}
				inboxTitle={meta.inboxTitle}
				inboxName={meta.inboxName}
				loaded={false}
			/>,
		);

	test("with unread entries the badge counts every entry, the bell stays lit", () => {
		const meta = metaWithAcks(5);
		expect(meta.inbox.total).toBe(29);
		expect(meta.inbox.fresh.length).toBe(24);
		expect(meta.inbox.lit).toBe(true);
		const html = bell(meta);
		expect(html).toContain('class="icon inbox lit"');
		expect(html).toContain('data-level="needs"');
		expect(html).toContain('<span class="inbox-n">29</span>');
		expect(html).not.toContain("inbox-new");
		// The screen-reader name keeps both numbers; the sr status line names the unread count.
		expect(html).toContain('aria-label="Notifications, 24 new of 29"');
		expect(html).toContain("24 new notifications");
	});

	test("18 asked entries stay lit and counted after acknowledgement", () => {
		const ask = Array.from({ length: 18 }, (_, n) =>
			cardFixture({ id: `ask${n}` }),
		);
		const meta = ackedAllMeta([], ask, []);
		expect(meta.inbox.total).toBe(18);
		expect(meta.inbox.fresh.length).toBe(0);
		expect(meta.inbox.lit).toBe(true);
		const html = bell(meta);
		expect(html).toContain('class="icon inbox lit"');
		expect(html).toContain('data-level="asked"');
		expect(html).toContain('<span class="inbox-n">18</span>');
		expect(html).toContain('aria-label="Notifications, 0 new of 18"');
	});

	test("only read notices leave the bell grey; the badge keeps the count", () => {
		const info = Array.from({ length: 6 }, (_, n) => `notice:n${n}`);
		const meta = ackedAllMeta([], [], info);
		expect(meta.inbox.lit).toBe(false);
		const html = bell(meta);
		// The dim count on a grey bell keys on data-level="info" (app.css).
		expect(html).toContain('data-level="info"');
		expect(html).toContain('class="icon inbox"');
		expect(html).not.toContain("icon inbox lit");
		expect(html).toContain('<span class="inbox-n">6</span>');
	});
});

// The panel renders every section from null keys and empty lists, so tests override
// only the props they look at.
const panelBase = {
	error: null,
	critKey: null,
	needTasks: [],
	askCards: [],
	prActivity: [],
	prPosted: [],
	alarmCount: 0,
	updatesKey: null,
	updateCount: 0,
	isNew: () => false,
	notice: null,
	noticeKey: null,
	orphansError: null,
	drainNotice: false,
	drainKey: null,
	drainCommits: [],
	behind: 0,
	behindKey: null,
	behindCommits: [],
	restartWait: null,
	restartWaitKey: null,
	seedFailed: null,
	seedFailKey: null,
	provisionError: null,
	provisionErrKey: null,
	state: null,
	warnings: [],
	orphanList: [],
	orphansErrorKey: null,
	orphansKey: null,
	keptCount: { held: 0, stale: 0 },
	keptKey: null,
	alatePendingKey: null,
	signinAdvisories: [],
	projects: [],
	nowMs: 0,
	openTask: () => {},
	ackInbox: () => {},
	setShowUpdates: () => {},
	setError: () => {},
	setNotice: () => {},
};

describe("Inbox panel ack footer", () => {
	const askedMeta = (ackedCount: number) => {
		const ask = Array.from({ length: 18 }, (_, n) =>
			cardFixture({ id: `ask${n}` }),
		);
		const probe = appInboxMeta(
			null,
			new Set<string>(),
			null,
			null,
			[],
			ask,
			[],
			[],
			[],
			[],
			0,
			"",
		);
		const ackLocal = new Set(
			probe.entries.slice(probe.entries.length - ackedCount).map((e) => e.key),
		);
		return appInboxMeta(
			null,
			ackLocal,
			null,
			null,
			[],
			ask,
			[],
			[],
			[],
			[],
			0,
			"",
		);
	};
	const footerButton = (meta: ReturnType<typeof appInboxMeta>) => {
		const html = renderToStaticMarkup(
			<AppInboxPanel
				{...panelBase}
				entries={meta.entries}
				inbox={meta.inbox}
			/>,
		);
		const document = parseMarkup(html);
		const btn = document.querySelector("#inbox .inbox-foot button");
		if (btn === null) throw new Error("the ack footer button did not render");
		// React renders disabled="" for true and drops the attribute for false.
		return btn.getAttribute("disabled") !== null;
	};

	test("18 read asked entries keep the bell lit but disable Mark all as read", () => {
		const meta = askedMeta(18);
		expect(meta.inbox.lit).toBe(true);
		expect(meta.inbox.fresh.length).toBe(0);
		expect(footerButton(meta)).toBe(true);
	});

	test("a fresh entry enables Mark all as read", () => {
		const meta = askedMeta(17);
		expect(meta.inbox.fresh.length).toBe(1);
		expect(footerButton(meta)).toBe(false);
	});
});

describe("PR review activity posted rows", () => {
	const POSTED_HEAD = "a".repeat(40);
	const postedCard = cardFixture({
		id: "pr1",
		kind: "pr_review",
		stage: "done",
		state: "idle",
		prOccurrence: {
			draft: 3,
			comments: null,
			posted: {
				head: POSTED_HEAD,
				url: "https://github.com/acme/widget/pull/7",
				number: 7,
			},
		},
	});
	const panel = (prActivity: TaskCard[], prPosted: TaskCard[]) => {
		const meta = appInboxMeta(
			null,
			new Set<string>(),
			null,
			null,
			[],
			[],
			prActivity,
			prPosted,
			[],
			[],
			1,
			"1 PR review has activity",
		);
		const html = renderToStaticMarkup(
			<AppInboxPanel
				{...panelBase}
				prActivity={prActivity}
				prPosted={prPosted}
				alarmCount={1}
				entries={meta.entries}
				inbox={meta.inbox}
			/>,
		);
		const document = parseMarkup(html);
		return { meta, document };
	};

	test("a posted-stamped review renders an external PR row and the count", () => {
		const { meta, document } = panel([], [postedCard]);
		// The posted key joins the inbox entries: the badge counts it and the seen
		// prune keeps it only while the stamp is current.
		expect(meta.entries.map((e) => e.key)).toEqual([
			`pr:pr1:posted:${POSTED_HEAD}`,
		]);
		const link = document.querySelector(
			`#inbox [data-inbox-key="pr:pr1:posted:${POSTED_HEAD}"] a.alarm-link`,
		) as HTMLAnchorElement | null;
		expect(link).not.toBeNull();
		// An external link to the PR, not a drawer link.
		expect(link!.getAttribute("href")).toBe(
			"https://github.com/acme/widget/pull/7",
		);
		expect(link!.getAttribute("target")).toBe("_blank");
		expect(link!.getAttribute("rel")).toBe("noreferrer");
		expect(link!.textContent).toContain("proj");
		expect(link!.textContent).toContain("PR #7");
		expect(link!.textContent).toContain("Ottr posted the review on GitHub");
		expect(document.querySelector("#inbox h2")?.textContent).toBe(
			"PR review activity · 1",
		);
	});

	test("a manually posted review renders no posted row", () => {
		const manual = cardFixture({
			id: "pr2",
			kind: "pr_review",
			stage: "done",
			state: "idle",
			prOccurrence: { draft: 2, comments: 5 },
		});
		const { meta, document } = panel([manual], []);
		expect(meta.entries.map((e) => e.key)).toEqual(["pr:pr2:5"]);
		expect(document.querySelector('[data-inbox-key*=":posted:"]')).toBeNull();
		expect(document.body.innerHTML).not.toContain(
			"Ottr posted the review on GitHub",
		);
		// The unseen-comment row still renders as today.
		expect(
			document.querySelector('[data-inbox-key="pr:pr2:5"]'),
		).not.toBeNull();
	});
});

describe("bell PR rows in quiet projects", () => {
	const project = (prReviewNotify: boolean): ProjectView =>
		({ name: "proj", settings: { prReviewNotify } }) as unknown as ProjectView;
	const card = (id: string, over: Partial<TaskCard>): TaskCard =>
		cardFixture({
			id,
			kind: "pr_review",
			stage: "done",
			state: "idle",
			...over,
		});

	test("a quiet project drops the posted, comment and needs rows", () => {
		const posted = card("pr1", {
			prOccurrence: {
				draft: 1,
				comments: null,
				posted: {
					head: "a".repeat(40),
					url: "https://github.com/acme/widget/pull/7",
					number: 7,
				},
			},
		});
		const commented = card("pr2", { prOccurrence: { draft: 1, comments: 4 } });
		const waiting = card("pr3", { state: "needs_you" });
		const plain = cardFixture({ id: "t9", state: "needs_you" });
		const split = bellAlarms(
			[posted, commented, waiting, plain],
			[waiting, plain],
			[project(false)],
		);
		expect(split.posted).toEqual([]);
		expect(split.activity).toEqual([]);
		expect(split.needsShown.map((t) => t.id)).toEqual(["t9"]);
	});

	test("a notifying project keeps the posted and comment rows", () => {
		const posted = card("pr1", {
			prOccurrence: {
				draft: 3,
				comments: null,
				posted: {
					head: "a".repeat(40),
					url: "https://github.com/acme/widget/pull/7",
					number: 7,
				},
			},
		});
		const commented = card("pr2", { prOccurrence: { draft: 3, comments: 4 } });
		const split = bellAlarms([posted, commented], [], [project(true)]);
		expect(split.posted.map((t) => t.id)).toEqual(["pr1"]);
		expect(split.activity.map((t) => t.id)).toEqual(["pr2"]);
	});
});

describe("service quotas in the overview", () => {
	const observedAt = 1_700_000_000_000;
	const balance: ServiceQuotaMetric = {
		id: "balance",
		label: "Credits",
		kind: "balance",
		unit: { kind: "currency", code: "EUR" },
		remaining: -0.125,
		reportedTotal: null,
		resetsAt: null,
		providerStatus: null,
		plan: null,
	};
	const windowMetric: ServiceQuotaMetric = {
		id: "window",
		label: "Requests",
		kind: "window",
		unit: { kind: "count", name: "requests" },
		used: 25,
		limit: 100,
		startsAt: null,
		resetsAt: null,
	};
	const source = (
		id = "account-a",
		metrics: readonly ServiceQuotaMetric[] = [balance],
	): ServiceQuotaSourceState => ({
		id,
		adapterId: "service-v2",
		label: "anthropic",
		status: "ok",
		lastAttemptAt: observedAt,
		nextAttemptAt: observedAt + 60_000,
		sample: { observedAt, metrics },
		error: null,
	});
	const documentOf = (html: string) => {
		const document = parseMarkup(html);
		return document;
	};
	const services = (
		sources: readonly ServiceQuotaSourceState[] | undefined,
		now = observedAt,
	) =>
		documentOf(
			renderToStaticMarkup(<ServiceQuotas sources={sources} now={now} />),
		);
	const quota: StateResponse["quota"] = {
		at: observedAt,
		error: null,
		limits: [
			{
				provider: "anthropic",
				label: "Model window",
				window: null,
				windowLabel: null,
				plan: null,
				usedPct: 42,
				resetsAt: null,
			},
		],
	};
	const overview = (
		modelQuota: StateResponse["quota"],
		sources: StateResponse["serviceQuotas"],
		hosted = false,
	) =>
		documentOf(
			renderToStaticMarkup(
				<SystemBar
					tasks={[]}
					maxTotal={3}
					quota={modelQuota}
					serviceQuotas={sources}
					hosted={hosted}
					navigate={() => {}}
				/>,
			),
		);
	// OTTR-1143: minimal cards for the slot meter; its slot path reads only stage,
	// state and cancelledAt.
	const slotCard = (
		id: string,
		stage: "todo" | "in_progress" | "merging",
		state: "running" | "preparing",
	): TaskCard =>
		({
			id,
			stage,
			state,
			cancelledAt: null,
			queuedAt: null,
			createdAt: 1,
		}) as unknown as TaskCard;
	// One in_progress/running and one todo/preparing card: the frame's own sum is 2.
	const slotCards = [
		slotCard("slot-a", "in_progress", "running"),
		slotCard("slot-b", "todo", "preparing"),
	];
	const slotOverview = (slotsUsed?: number) =>
		documentOf(
			renderToStaticMarkup(
				<SystemBar
					tasks={slotCards}
					maxTotal={1}
					slotsUsed={slotsUsed}
					quota={null}
					hosted={false}
					navigate={() => {}}
				/>,
			),
		);

	test("model quotas coexist with ordered service identities and equal labels", () => {
		const document = overview(quota, [
			source("account-b"),
			source("account-a"),
		]);
		expect(document.querySelector("#system-detail")?.textContent).toContain(
			"Provider quota",
		);
		expect(document.querySelector(".qt")?.textContent).toContain(
			"Model window",
		);
		expect(document.querySelector(".qt")?.textContent).toContain("42 %");
		expect(
			[...document.querySelectorAll(".service-source h3")].map(
				(node) => node.textContent,
			),
		).toEqual(["anthropic", "anthropic"]);
		const identities = [
			...document.querySelectorAll(".service-source > .caption:first-of-type"),
		].map((node) => node.textContent);
		expect(identities).toEqual([
			"Source: account-b · Adapter: service-v2",
			"Source: account-a · Adapter: service-v2",
		]);
		expect(document.querySelector(".meters")?.outerHTML).toBe(
			overview(quota, undefined).querySelector(".meters")?.outerHTML,
		);
		expect(
			document.querySelector("#system-detail")?.getAttribute("popover"),
		).toBe("auto");
		expect(
			document.querySelector(".meters")?.getAttribute("popovertarget"),
		).toBe("system-detail");
	});

	test("services remain visible without model quota and never supply the bar metric", () => {
		const document = overview(null, [source()]);
		expect(document.querySelector("#system-detail")?.textContent).toContain(
			"Checking omp usage",
		);
		expect(document.querySelector(".service-quotas")?.textContent).toContain(
			"EUR -0.125 remaining",
		);
		expect(document.querySelector(".meters")?.outerHTML).toBe(
			overview(null, undefined).querySelector(".meters")?.outerHTML,
		);
	});

	test("the slot meter shows the server's count over the frame's own cards", () => {
		const document = slotOverview(1);
		expect(document.querySelector(".sb-big")?.textContent).toBe("1");
		expect(
			document.querySelector("#system-detail .meter-value")?.textContent,
		).toContain("1/1");
		expect(document.querySelector(".ag-nums div dd")?.textContent).toBe("1");
	});

	test("without the server field the meter keeps the frame's own count", () => {
		const document = slotOverview();
		expect(document.querySelector(".sb-big")?.textContent).toBe("2");
		expect(
			document.querySelector("#system-detail .meter-value")?.textContent,
		).toContain("2/1");
	});

	test("absent and empty services stay hidden and hosted mode hides supplied service data", () => {
		expect(services(undefined).body.textContent).toBe("");
		expect(services([]).body.textContent).toBe("");
		const document = overview(quota, [source()], true);
		expect(document.querySelector(".service-quotas")).toBeNull();
		expect(document.querySelector("#system-detail")?.textContent).not.toContain(
			"Provider quota",
		);
	});

	test("balances preserve signed fractions and count units without percentages or invented resets", () => {
		const document = services([
			source("account-a", [
				balance,
				{
					...balance,
					id: "generations",
					label: "Generations",
					unit: { kind: "count", name: "generations" },
					remaining: 12.75,
					reportedTotal: 2_000,
					providerStatus: "active",
					plan: "Monthly",
				},
			]),
		]);
		expect(document.body.textContent).toContain("EUR -0.125 remaining");
		expect(document.body.textContent).toContain("12.75 generations remaining");
		expect(document.body.textContent).toContain(
			"Provider total: 2,000 generations",
		);
		expect(document.body.textContent).toContain("Provider status: active");
		expect(document.body.textContent).toContain("Plan: Monthly");
		expect(document.body.textContent).not.toContain("%");
		expect(document.body.textContent).not.toContain("Resets");
		expect(document.body.textContent).not.toContain("Starts");
		expect(document.querySelector(".mark")).toBeNull();
	});

	test("a z.ai coding plan source renders grant counts and reset stamps", () => {
		// Counts 0/1 mirror the capture plus the card screenshot's one available weekly grant.
		const fiveHourResetsAt = 1_795_467_218_287;
		const weeklyResetsAt = 1_795_974_608_999;
		const document = services([
			{
				id: "zai",
				adapterId: "zai-coding-plan",
				label: "Z.AI GLM Coding Plan",
				status: "ok",
				lastAttemptAt: observedAt,
				nextAttemptAt: observedAt + 60_000,
				sample: {
					observedAt,
					metrics: [
						{
							id: "five-hour-window",
							label: "5-hour window",
							kind: "balance",
							unit: { kind: "count", name: "unused reset grants" },
							remaining: 0,
							reportedTotal: null,
							resetsAt: fiveHourResetsAt,
							providerStatus: null,
							plan: null,
						},
						{
							id: "weekly-window",
							label: "Weekly window",
							kind: "balance",
							unit: { kind: "count", name: "unused reset grants" },
							remaining: 1,
							reportedTotal: null,
							resetsAt: weeklyResetsAt,
							providerStatus: null,
							plan: null,
						},
					],
				},
				error: null,
			},
		]);
		const text = document.body.textContent ?? "";
		expect(document.querySelector("h3")?.textContent).toBe(
			"Z.AI GLM Coding Plan",
		);
		expect(text).toContain("0 unused reset grants remaining");
		expect(text).toContain("1 unused reset grants remaining");
		expect(text).toContain(`Resets ${stamp(fiveHourResetsAt)}`);
		expect(text).toContain(`Resets ${stamp(weeklyResetsAt)}`);
	});

	test("zero windows show raw values and positive windows retain over-limit percentages", () => {
		for (const [used, limit, expected] of [
			[3, 0, null],
			[25, 100, "25 % used"],
			[125, 100, "125 % used"],
		] as const) {
			const document = services([
				source("account-a", [{ ...windowMetric, used, limit }]),
			]);
			expect(
				document.querySelector(".service-metric dd > div:first-child")
					?.textContent,
			).toBe(`Used: ${used} requests`);
			expect(
				document.querySelector(".service-metric dd > div:nth-child(2)")
					?.textContent,
			).toBe(`Limit: ${limit} requests`);
			if (expected === null)
				expect(document.body.textContent).not.toContain("%");
			else expect(document.body.textContent).toContain(expected);
			expect(document.querySelector(".mark")).toBeNull();
		}
	});

	test("equal metric labels retain their order and only reported dates appear", () => {
		const document = services([
			source("account-a", [
				{ ...balance, label: "Allowance", reportedTotal: 0 },
				{
					...windowMetric,
					label: "Allowance",
					startsAt: observedAt,
					resetsAt: observedAt + 60_000,
				},
			]),
		]);
		expect(
			[...document.querySelectorAll("dt")].map((node) => node.textContent),
		).toEqual(["Allowance", "Allowance"]);
		const rows = document.querySelectorAll(".service-metric");
		expect(rows[0]?.textContent).toContain("Provider total: EUR 0");
		expect(rows[0]?.textContent).not.toContain("Resets");
		expect(rows[1]?.textContent).toContain("Starts");
		expect(rows[1]?.textContent).toContain("Resets");
	});

	test("service-only state updates survive card reuse without changing model quota", () => {
		const task = cardFixture({ id: "service-state" });
		const prev = {
			tasks: [task],
			quota,
			serviceQuotas: [],
		} as unknown as StateResponse;
		const next = { ...prev, tasks: [{ ...task }], serviceQuotas: [source()] };
		const merged = reuseCards(prev, next);
		expect(merged.serviceQuotas).toBe(next.serviceQuotas);
		expect(merged.quota).toBe(quota);
		expect(merged.tasks).toBe(prev.tasks);
	});

	test("old frames become stale at the five-minute boundary and retain observed age", () => {
		const frame = [source()];
		expect(services(frame, observedAt + 299_999).body.textContent).toContain(
			"Current · Observed 4m ago",
		);
		for (const elapsed of [300_000, 300_001, 360_000]) {
			const text = services(frame, observedAt + elapsed).body.textContent;
			expect(text).toContain(
				`Stale · Observed ${Math.floor(elapsed / 60_000)}m ago`,
			);
			expect(text).toContain("EUR -0.125 remaining");
		}
	});

	test("unconfigured pending and first-read errors stay explicit without fake balances", () => {
		const identity = {
			id: "account-a",
			adapterId: "service-v2",
			label: "anthropic",
		};
		const states: ServiceQuotaSourceState[] = [
			{
				...identity,
				status: "unconfigured",
				sample: null,
				lastAttemptAt: null,
				nextAttemptAt: null,
				error: { code: "configuration" },
			},
			{
				...identity,
				id: "pending",
				status: "pending",
				sample: null,
				lastAttemptAt: null,
				nextAttemptAt: observedAt,
				error: null,
			},
			{
				...identity,
				id: "error",
				status: "error",
				sample: null,
				lastAttemptAt: observedAt,
				nextAttemptAt: null,
				error: { code: "authentication", httpStatus: 401, retryAfterAt: null },
			},
		];
		const document = services(states);
		expect(document.body.textContent).toContain("Unconfigured");
		expect(document.body.textContent).toContain(
			"Server configuration is missing or invalid",
		);
		expect(document.body.textContent).toContain("Pending");
		expect(document.body.textContent).toContain(
			"The first provider read has not completed",
		);
		expect(document.body.textContent).toContain("Error");
		expect(document.body.textContent).toContain(
			"The provider refused the server credentials. HTTP 401.",
		);
		expect(document.body.textContent).toContain("Automatic reads are paused");
		expect(document.querySelectorAll(".service-metric")).toHaveLength(0);
		const statusRows = document.querySelectorAll(".service-status");
		expect(statusRows[0]?.getAttribute("data-level")).toBe("needs");
		expect(statusRows[0]?.querySelector(".mark-needs")).not.toBeNull();
		expect(statusRows[1]?.querySelector(".mark")).toBeNull();
		expect(statusRows[2]?.getAttribute("data-level")).toBe("crit");
		expect(statusRows[2]?.querySelector(".mark-crit")).not.toBeNull();
	});

	test("refresh errors retain stale samples and their original observed age", () => {
		const stale: ServiceQuotaSourceState = {
			...source(),
			status: "stale",
			staleReason: "refresh_error",
			sample: { observedAt, metrics: [balance] },
			lastAttemptAt: observedAt + 60_000,
			nextAttemptAt: observedAt + 120_000,
			error: { code: "network", httpStatus: null, retryAfterAt: null },
		};
		for (const elapsed of [60_000, 360_000]) {
			const document = services([stale], observedAt + elapsed);
			expect(document.body.textContent).toContain(
				`Stale · Observed ${elapsed / 60_000}m ago`,
			);
			expect(document.body.textContent).toContain("EUR -0.125 remaining");
			expect(document.body.textContent).toContain(
				"The server could not reach the provider.",
			);
			expect(document.body.textContent).toContain(
				"The server will retry automatically.",
			);
			expect(document.querySelector(".mark")).toBeNull();
		}
	});

	test("provider labels status and plan remain plain text", () => {
		const unsafe = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
		const document = services([
			{
				...source("account-a", [
					{ ...balance, label: unsafe, plan: unsafe, providerStatus: unsafe },
				]),
				label: unsafe,
			},
		]);
		expect(document.querySelectorAll("img, script")).toHaveLength(0);
		expect(document.querySelector(".service-source h3")?.textContent).toBe(
			unsafe,
		);
		expect(document.querySelector("dt")?.textContent).toBe(unsafe);
		expect(document.body.textContent).toContain(`Provider status: ${unsafe}`);
		expect(document.body.textContent).toContain(`Plan: ${unsafe}`);
	});

	test("generated balances preserve numeric values without a percentage denominator", () => {
		fc.assert(
			fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (n) => {
				const remaining = n / 8;
				const document = services([
					source("account-a", [{ ...balance, remaining, reportedTotal: 1 }]),
				]);
				const value =
					document.querySelector(".service-metric dd > div")?.textContent ?? "";
				expect(
					Number(
						value
							.replace("EUR ", "")
							.replace(" remaining", "")
							.replaceAll(",", ""),
					),
				).toBe(remaining);
				expect(document.body.textContent).not.toContain("%");
			}),
		);
	});
});

describe("HoldResumeButton refusal surface (client)", () => {
	// React interaction needs browser globals; the same happy-dom swap as the
	// AskBlock tests above: installed after app.tsx's import, removed after.
	const { window } = installBrowserGlobals(
		[
			"HTMLElement",
			"HTMLInputElement",
			"HTMLButtonElement",
			"requestAnimationFrame",
			"cancelAnimationFrame",
		],
		{
			// The accepted-resume case runs the button's real `post` body: happy-dom
			// cannot fetch a relative URL, so the network boundary answers 200 here.
			fetch: async () =>
				({
					ok: true,
					status: 200,
					json: async () => ({}),
				}) as unknown as Response,
		},
	);

	const MESSAGE =
		"anthropic is still out of quota; the limit resets at 2026-11-21 19:00 UTC. Pick another model.";
	const task = { project: "proj", id: "t1", holdProvider: "openai-codex" };

	/** act with the production contract for a refused resume: the server answered
	 *  409, the message went to the inline surface, act reports false. */
	const refusedAct = (): Act => async (_fn, onError) => {
		onError?.(MESSAGE);
		return false;
	};

	/** act with the production contract for an accepted resume: the body ran, the
	 *  switch landed, act reports true. */
	const acceptedAct = (): Act => async (fn) => {
		await fn();
		return true;
	};

	/** An act whose refusal parks until the test releases it: reproduces a slow
	 *  server's 409 landing after the view changed. */
	const parkedRefusal = (): {
		act: Act;
		release: (message: string) => void;
	} => {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let deliver: ((message: string) => void) | null = null;
		return {
			act: (_fn, onError) => {
				deliver = (message: string) => {
					onError?.(message);
					resolve(false);
				};
				return promise;
			},
			release: (message) => deliver?.(message),
		};
	};

	const click = (): Event =>
		new window.Event("click", { bubbles: true }) as unknown as Event;

	async function mountHold(
		actStub: Act,
		model = "anthropic/claude-sonnet-5-5",
	): Promise<{
		container: HTMLDivElement;
		root: ReturnType<typeof createRoot>;
		unmount: () => Promise<void>;
	}> {
		const { container, root, unmount } = await mount(
			<HoldResumeButton
				task={task}
				catalog={null}
				model={model}
				act={actStub}
			/>,
		);
		return { container, root, unmount };
	}

	const resumeButton = (container: HTMLDivElement): HTMLButtonElement =>
		container.querySelector(
			"button:not(.icon)",
		) as unknown as HTMLButtonElement;

	const problemLine = (container: HTMLDivElement): Element | null =>
		container.querySelector(".resume-problem");

	test("a refused resume shows the server's message beside the button", async () => {
		const { container, root } = await mountHold(refusedAct());
		// Closed until the click: no line, no alert role.
		expect(problemLine(container)).toBeNull();
		await act(async () => {
			resumeButton(container).dispatchEvent(click());
			await Promise.resolve();
		});
		const line = problemLine(container);
		expect(line?.getAttribute("role")).toBe("alert");
		expect(line?.textContent).toContain(MESSAGE);
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	test("a successful retry clears the shown refusal", async () => {
		const { container, root } = await mountHold(refusedAct());
		await act(async () => {
			resumeButton(container).dispatchEvent(click());
			await Promise.resolve();
		});
		expect(problemLine(container)?.textContent).toContain(MESSAGE);
		// The same button retries with an accepting act: the line drops.
		await act(async () => {
			root.render(
				<HoldResumeButton
					task={task}
					catalog={null}
					model="anthropic/claude-sonnet-5-5"
					act={acceptedAct()}
				/>,
			);
		});
		await act(async () => {
			resumeButton(container).dispatchEvent(click());
			await Promise.resolve();
		});
		expect(problemLine(container)).toBeNull();
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	test("a different model pick hides a stale refusal", async () => {
		const { container, root } = await mountHold(refusedAct());
		await act(async () => {
			resumeButton(container).dispatchEvent(click());
			await Promise.resolve();
		});
		expect(problemLine(container)?.textContent).toContain(MESSAGE);
		// The reset time named anthropic; the zai pick must not keep that text up.
		await act(async () => {
			root.render(
				<HoldResumeButton
					task={task}
					catalog={null}
					model="zai/glm-5.3-flash"
					act={refusedAct()}
				/>,
			);
		});
		expect(problemLine(container)).toBeNull();
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	test("a 409 that lands after a different pick never names the old model", async () => {
		// The response stays in flight until the test releases it, so the pick
		// races it the way a slow server does.
		const late = parkedRefusal();
		const { container, root } = await mountHold(late.act);
		await act(async () => {
			resumeButton(container).dispatchEvent(click());
			// Only the click starts; the response is parked.
			await Promise.resolve();
		});
		// The user picks another model while the anthropic request is in flight.
		await act(async () => {
			root.render(
				<HoldResumeButton
					task={task}
					catalog={null}
					model="zai/glm-5.3-flash"
					act={refusedAct()}
				/>,
			);
		});
		// The parked anthropic 409 lands now: it names the old pick, so the line
		// must not show it under the zai selection.
		await act(async () => {
			late.release(MESSAGE);
			await Promise.resolve();
		});
		expect(problemLine(container)).toBeNull();
		// Picking the old model back stays clean too: the parked refusal was dropped
		// by the pick away, not parked for a later resurrection.
		await act(async () => {
			root.render(
				<HoldResumeButton
					task={task}
					catalog={null}
					model="anthropic/claude-sonnet-5-5"
					act={refusedAct()}
				/>,
			);
		});
		expect(problemLine(container)).toBeNull();
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	test("a delayed 409 for the still-selected model shows", async () => {
		// The guard must only drop responses for a superseded pick: a slow server's
		// refusal for the pick that stayed shows like any other.
		const late = parkedRefusal();
		const { container, root } = await mountHold(late.act);
		await act(async () => {
			resumeButton(container).dispatchEvent(click());
			await Promise.resolve();
		});
		expect(problemLine(container)).toBeNull();
		await act(async () => {
			late.release(MESSAGE);
			await Promise.resolve();
		});
		const line = problemLine(container);
		expect(line?.getAttribute("role")).toBe("alert");
		expect(line?.textContent).toContain(MESSAGE);
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});
});
describe("CreditsChip", () => {
	const account = "https://cp.example/account";

	test("a positive balance shows the balance and links to the account page", () => {
		const html = renderToStaticMarkup(
			<CreditsChip credits={{ balance: 12.5, accountUrl: account }} />,
		);
		expect(html).toContain(`href="https://cp.example/account"`);
		expect(html).toContain(`target="_blank"`);
		expect(html).toContain(`rel="noopener noreferrer"`);
		expect(html).toContain(">12.5 credits</a>");
		expect(html).not.toContain("data-empty");
		expect(html).toContain('title="Credits balance — opens the account page"');
	});

	test("a zero balance names the hard stop with the short-label spans", () => {
		const html = renderToStaticMarkup(
			<CreditsChip credits={{ balance: 0, accountUrl: account }} />,
		);
		expect(html).toContain('data-empty=""');
		expect(html).toContain("Out of credit — work stopped");
		expect(html).toContain(
			'<span class="credits-full">Out of credit — work stopped</span>',
		);
		expect(html).toContain('<span class="credits-short">Out of credit</span>');
		expect(html).toContain(
			'title="Out of credit — top up on the account page"',
		);
	});

	test("a negative balance names the hard stop too", () => {
		const html = renderToStaticMarkup(
			<CreditsChip credits={{ balance: -1.5, accountUrl: account }} />,
		);
		expect(html).toContain('data-empty=""');
		expect(html).toContain("Out of credit — work stopped");
	});

	test("an unknown balance renders nothing", () => {
		expect(
			renderToStaticMarkup(
				<CreditsChip credits={{ balance: null, accountUrl: account }} />,
			),
		).toBe("");
	});
});

describe("credits chip in the board bar", () => {
	// The full board mount needs the same globals as settings.hosted.test.tsx's harness:
	// a happy-dom Window swapped in beforeAll and restored in afterAll, plus a fetch stub
	// that answers the boot conversation and fails every other load with its 503 line.
	const { window } = installBrowserGlobals([
		"location",
		"history",
		"HTMLDialogElement",
		"HTMLTextAreaElement",
		"Node",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
		"CSS",
		"sessionStorage",
		"localStorage",
	]);
	const host = globalThis as unknown as Record<string, unknown>;
	// happy-dom implements no popover attribute yet; the menus call hidePopover().
	const proto = window.HTMLElement.prototype as unknown as Record<
		string,
		unknown
	>;
	beforeAll(() => {
		proto.showPopover ??= () => {};
		proto.hidePopover ??= () => {};
	});
	// fetch is swapped per test in this describe; its original comes back after all.
	const realFetch = globalThis.fetch;
	afterAll(() => {
		globalThis.fetch = realFetch;
	});

	/** The board state with the fields App reads at boot; `extra` carries the credits. */
	const stateBody = (extra: Record<string, unknown>): unknown => ({
		projects: [],
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
		alateProvisionError: null,
		deadSignIns: [],
		seedFailed: null,
		...extra,
	});

	/** The server as the board sees it: boot and state answer, every other load 503s. */
	const serverFor = (
		hosted: boolean,
		state: Record<string, unknown>,
		requested: string[],
	): typeof fetch =>
		(async (input: RequestInfo | URL) => {
			const url = String(input);
			requested.push(url);
			let body: unknown = { error: "not in this test" };
			let status = 503;
			if (url === "/api/boot") {
				body = {
					onboarding: false,
					version: "vtest",
					live: false,
					...(hosted ? { hosted: true } : {}),
				};
				status = 200;
			} else if (url === "/api/state") {
				body = stateBody({ ...state, ...(hosted ? { hosted: true } : {}) });
				status = 200;
			} else if (url === "/api/update") {
				body = { behind: 0, commits: [] };
				status = 200;
			} else if (url === "/api/system") {
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
				status = 200;
			}
			return new Response(JSON.stringify(body), {
				status,
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

	const boardLoaded = (): boolean => {
		const main = document.querySelector("main.main");
		return main !== null && !(main.textContent ?? "").includes("Loading board");
	};

	/** Mounts App against the server, runs `check`, unmounts; reports every fetched URL. */
	async function withApp(
		hosted: boolean,
		state: Record<string, unknown>,
		check: () => void,
	): Promise<string[]> {
		const requested: string[] = [];
		host.fetch = serverFor(hosted, state, requested);
		window.history.replaceState(null, "", "/");
		const { unmount } = await mount(<App />);
		try {
			await waitFor(boardLoaded);
			check();
		} finally {
			await unmount();
		}
		return requested;
	}

	test("hosted: the bar links the balance to the account page", async () => {
		await withApp(
			true,
			{ credits: { balance: 12.5, accountUrl: "https://cp.example/account" } },
			() => {
				const chip = document.querySelector("header.bar a.credits-chip");
				expect(chip).not.toBeNull();
				expect(chip?.getAttribute("href")).toBe("https://cp.example/account");
				expect(chip?.getAttribute("target")).toBe("_blank");
				expect(chip?.getAttribute("rel")).toBe("noopener noreferrer");
				expect(chip?.hasAttribute("data-empty")).toBe(false);
				expect(chip?.textContent).toContain("12.5 credits");
				expect(
					document.querySelectorAll("header.bar a.credits-chip"),
				).toHaveLength(1);
			},
		);
	});

	test("hosted: a null balance hides the chip", async () => {
		await withApp(
			true,
			{ credits: { balance: null, accountUrl: "https://cp.example/account" } },
			() => {
				expect(document.querySelector(".credits-chip")).toBeNull();
			},
		);
	});

	test("flag off: a payload without credits means no chip and no fetch for one", async () => {
		const requested = await withApp(false, {}, () => {
			expect(document.querySelector(".credits-chip")).toBeNull();
			expect(document.body.innerHTML).not.toContain("credits-chip");
		});
		// The chip fetches nothing; the recorded loads are the board's own boot calls.
		expect(requested.every((url) => !url.includes("credit"))).toBe(true);
	});
});

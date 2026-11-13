import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalStore } from "./globalStore.ts";
import { ProjectStore } from "./store.ts";
import {
	createTrendingScanner,
	EMPTY_TRENDING_STATE,
	parseTrending,
	TRENDING_PAGES,
	type TrendingProject,
	type TrendingState,
} from "./trending.ts";
import type { TrendingVerdict } from "./types.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "trending");
const fixture = (name: string) =>
	readFileSync(join(FIXTURES, `${name}.html`), "utf8");

const [ALL_URL, TS_URL, JS_URL] = TRENDING_PAGES as [string, string, string];
const API = "https://api.test";
const ALL = [
	"thedotmack/claude-mem",
	"donchitos/claude-code-game-studios",
	"pingdotgg/t3code",
];
const TS = ["thedotmack/claude-mem", "pingdotgg/t3code", "garrytan/gstack"];
const JS = ["cloudflare/security-audit-skill", "leonxlnx/taste-skill"];
const UNION = [...new Set([...ALL, ...TS, ...JS])];

let root: string;
const stores: ProjectStore[] = [];

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ottr-trending-"));
});

afterAll(async () => {
	for (const s of stores) await s.close();
	rmSync(root, { recursive: true, force: true });
});

let seq = 0;
async function project(
	settings = { trendingScout: true },
): Promise<TrendingProject> {
	const name = `p${++seq}`;
	const path = mkdtempSync(join(root, `${name}-`));
	const store = await ProjectStore.init(path);
	stores.push(store);
	await store.setSettings(settings);
	return { name: store.name, path, store, github: `o/${store.name}` };
}

type Fake = {
	pages: Record<string, string>;
	/** Per-URL override: return a Response to replace the default answer. */
	respond?: (
		url: string,
	) => Response | undefined | Promise<Response | undefined>;
	calls: { url: string; headers: Record<string, string> }[];
};

function fakeFetch(fake: Fake): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		fake.calls.push({
			url,
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
		});
		const over = await fake.respond?.(url);
		if (over) return over;
		const page = fake.pages[url];
		if (page !== undefined) return new Response(page, { status: 200 });
		const m =
			/^https:\/\/api\.test\/repos\/([^/]+\/[^/]+)(\/readme|\/git\/trees\/main\?recursive=1)?$/.exec(
				url,
			);
		if (!m) return new Response("not found", { status: 404 });
		const repo = m[1] as string;
		if (m[2] === "/readme") return new Response(`# ${repo}\n`, { status: 200 });
		if (m[2])
			return Response.json({
				tree: [
					{ path: "src", type: "tree" },
					{ path: "src/index.ts", type: "blob" },
					{ path: "README.md", type: "blob" },
				],
				truncated: false,
			});
		return Response.json({
			full_name: repo,
			description: `about ${repo}`,
			stargazers_count: 42,
			language: "TypeScript",
			license: { spdx_id: "MIT" },
			pushed_at: "2026-11-01T00:00:00Z",
			archived: false,
			default_branch: "main",
			html_url: `https://github.com/${repo}`,
		});
	}) as typeof fetch;
}

const goodPages = (): Record<string, string> => ({
	[ALL_URL]: fixture("all"),
	[TS_URL]: fixture("typescript"),
	[JS_URL]: fixture("javascript"),
});

function harness(o: {
	projects: TrendingProject[];
	fake?: Partial<Fake>;
	now?: () => number;
	state?: { value: TrendingState };
	enabled?: () => boolean;
	token?: string;
	globalStore?: GlobalStore;
}) {
	const fake: Fake = { pages: goodPages(), calls: [], ...o.fake };
	const state = o.state ?? { value: { ...EMPTY_TRENDING_STATE } };
	const logs: string[] = [];
	let scheduled = 0;
	const scanner = createTrendingScanner({
		projects: () => o.projects,
		enabled: o.enabled ?? (() => true),
		load: async () =>
			(await o.globalStore?.get<TrendingState>("trending")) ?? state.value,
		update: async (modify) => {
			if (o.globalStore)
				return o.globalStore.update<TrendingState>("trending", (current) =>
					modify(current ?? { ...EMPTY_TRENDING_STATE }),
				);
			state.value = modify(state.value);
			return state.value;
		},
		token: () => o.token,
		apiBase: () => API,
		fetch: fakeFetch(fake),
		now: o.now,
		log: (m) => logs.push(m),
		schedule: () => {
			scheduled++;
		},
	});
	return { scanner, fake, state, logs, scheduled: () => scheduled };
}

const scouts = async (p: TrendingProject) =>
	(await p.store.listTasks()).filter((t) => t.kind === "trending");

/** The one bundle the scanner wrote for `p`. */
function bundle(p: TrendingProject): {
	project: string;
	github: string | null;
	candidates: {
		repo: string;
		trendingNow: boolean;
		earlierReason: string | null;
		readme: string | null;
		readmeTruncated: boolean;
		tree: string[];
	}[];
	hints: { repo: string; reason: string }[];
} {
	const dir = join(p.store.tasksDir, "trending");
	const files = readdirSync(dir);
	expect(files).toHaveLength(1);
	return JSON.parse(readFileSync(join(dir, files[0] as string), "utf8"));
}

function verdict(
	repo: string,
	kind: TrendingVerdict["verdict"],
	reason: string,
	rejectedByUser = false,
): TrendingVerdict {
	return {
		repo,
		verdict: kind,
		reason,
		rejectedByUser,
		firstSeenAt: 1,
		judgedAt: 1,
		scoutCardId: null,
		proposalCardId: null,
	};
}

/** Closes every scout card of `p` so the next scan may file a new one. */
async function closeScouts(p: TrendingProject): Promise<void> {
	for (const t of await scouts(p))
		if (t.cancelledAt === null)
			await p.store.updateTask(t.id, { cancelledAt: Date.now() });
}

describe("parseTrending", () => {
	test("reads the h2 repo link of each article, lowercase, page order", () => {
		expect(parseTrending(fixture("all"))).toEqual(ALL);
		expect(parseTrending(fixture("typescript"))).toEqual(TS);
		expect(parseTrending(fixture("javascript"))).toEqual(JS);
	});

	test("changed markup and an empty page list no repos", () => {
		expect(parseTrending(fixture("changed-markup"))).toEqual([]);
		expect(parseTrending(fixture("empty"))).toEqual([]);
	});

	test("dedupes a repo listed twice on one page", () => {
		const html = fixture("all");
		expect(parseTrending(html + html)).toEqual(ALL);
	});
});

describe("scanNow", () => {
	test("files one scout card per opted-in project with the deduped union as candidates", async () => {
		const a = await project();
		const off = await project({ trendingScout: false });
		const h = harness({ projects: [a, off], token: "tok" });
		const r = await h.scanner.scanNow();
		expect(r.ok).toBe(true);
		const cards = await scouts(a);
		expect(cards).toHaveLength(1);
		expect(r).toEqual({ ok: true, filed: [cards[0]?.id as string] });
		expect(cards[0]?.title).toMatch(/^Trending scout: \d{4}-\d{2}-\d{2}$/);
		expect(cards[0]?.topic).toBe("trending scout");
		expect(await scouts(off)).toHaveLength(0);
		expect(h.scheduled()).toBe(1);
		const b = bundle(a);
		expect(b.project).toBe(a.name);
		expect(b.github).toBe(a.github);
		expect(b.candidates.map((c) => c.repo)).toEqual(UNION);
		expect(b.candidates.every((c) => c.trendingNow)).toBe(true);
		expect(b.candidates[0]?.tree).toEqual(["src/index.ts", "README.md"]);
		const apiCall = h.fake.calls.find((c) => c.url.startsWith(API));
		expect(apiCall?.headers.authorization).toBe("Bearer tok");
		expect(apiCall?.headers["user-agent"]).toBe("ottr");
		const pageCall = h.fake.calls.find((c) => c.url === ALL_URL);
		expect(pageCall?.headers.authorization).toBeUndefined();
		expect(await h.scanner.status()).toMatchObject({
			lastError: null,
			running: true,
		});
	});

	test("no token sends no authorization header", async () => {
		const a = await project();
		const h = harness({ projects: [a] });
		expect((await h.scanner.scanNow()).ok).toBe(true);
		expect(
			h.fake.calls.some((c) => c.headers.authorization !== undefined),
		).toBe(false);
	});

	test("truncates the readme, skips archived and vanished repos", async () => {
		const a = await project();
		const h = harness({
			projects: [a],
			fake: {
				respond: (url) => {
					if (url === `${API}/repos/pingdotgg/t3code/readme`)
						return new Response("x".repeat(7000));
					if (url === `${API}/repos/garrytan/gstack`)
						return new Response("gone", { status: 404 });
					if (url === `${API}/repos/leonxlnx/taste-skill`)
						return Response.json({ archived: true, default_branch: "main" });
					return undefined;
				},
			},
		});
		expect((await h.scanner.scanNow()).ok).toBe(true);
		const c = bundle(a).candidates;
		expect(c.map((x) => x.repo)).toEqual(
			UNION.filter(
				(r) => r !== "garrytan/gstack" && r !== "leonxlnx/taste-skill",
			),
		);
		const t3 = c.find((x) => x.repo === "pingdotgg/t3code");
		expect(t3?.readme).toHaveLength(6000);
		expect(t3?.readmeTruncated).toBe(true);
	});

	for (const [name, page] of [
		["changed markup", "changed-markup"],
		["an empty page", "empty"],
	] as const)
		test(`${name} fails the scan with 502 and files no card`, async () => {
			const a = await project();
			const h = harness({
				projects: [a],
				fake: { pages: { ...goodPages(), [TS_URL]: fixture(page) } },
			});
			const r = await h.scanner.scanNow();
			expect(r).toEqual({
				ok: false,
				status: 502,
				error: `trending page ${TS_URL} listed no repos (markup changed?)`,
			});
			expect((await h.scanner.status()).lastError?.reason).toContain(
				"markup changed",
			);
			expect(await scouts(a)).toHaveLength(0);
			expect(h.scheduled()).toBe(0);
		});

	test("a rate-limited API call fails the scan", async () => {
		const a = await project();
		const h = harness({
			projects: [a],
			fake: {
				respond: (url) =>
					url.startsWith(`${API}/repos/`)
						? new Response("limit", { status: 403 })
						: undefined,
			},
		});
		const r = await h.scanner.scanNow();
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.status).toBe(502);
			expect(r.error).toContain("HTTP 403");
		}
		expect(await scouts(a)).toHaveLength(0);
	});

	// The headers arrived, then the body timed out: no optional-field fallback may hide it.
	for (const [part, match] of [
		["metadata", (u: string) => /\/repos\/[^/]+\/[^/]+$/.test(u)],
		["readme", (u: string) => u.endsWith("/readme")],
		["tree", (u: string) => u.includes("/git/trees/")],
	] as const)
		test(`a ${part} body that times out fails the scan`, async () => {
			const a = await project();
			const h = harness({
				projects: [a],
				fake: {
					respond: (url) =>
						url.startsWith(`${API}/repos/`) && match(url)
							? new Response(
									new ReadableStream({
										start(c) {
											c.error(
												new DOMException("body timed out", "TimeoutError"),
											);
										},
									}),
									{ status: 200 },
								)
							: undefined,
				},
			});
			const r = await h.scanner.scanNow();
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.status).toBe(502);
				expect(r.error).toContain("reading the body failed: timed out");
			}
			expect((await h.scanner.status()).lastError?.reason).toContain(
				"reading the body failed: timed out",
			);
			expect(await scouts(a)).toHaveLength(0);
		});

	test("an open scout card or a scan in flight answers 409", async () => {
		const a = await project();
		const h = harness({ projects: [a] });
		const first = h.scanner.scanNow();
		expect(await h.scanner.scanNow()).toEqual({
			ok: false,
			status: 409,
			error: "a trending scan is already running",
		});
		const r = await first;
		expect(r.ok).toBe(true);
		const id = (await scouts(a))[0]?.id as string;
		expect(await h.scanner.scanNow()).toEqual({
			ok: false,
			status: 409,
			error: `a trending scout card is still open: ${id}`,
		});
		await closeScouts(a);
		expect((await h.scanner.status()).running).toBe(false);
	});

	test("no opted-in project answers 409", async () => {
		const h = harness({ projects: [await project({ trendingScout: false })] });
		const r = await h.scanner.scanNow();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(409);
	});

	test("concurrent scanners file one complete scout and one event pair", async () => {
		const a = await project();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let arrivals = 0;
		const respond = async (url: string) => {
			if (url === ALL_URL) {
				if (++arrivals === 2) reached.resolve();
				await release.promise;
			}
			return undefined;
		};
		const first = harness({ projects: [a], fake: { respond } });
		const second = harness({ projects: [a], fake: { respond } });
		const scans = [first.scanner.scanNow(), second.scanner.scanNow()];
		await reached.promise;
		release.resolve();
		const results = await Promise.all(scans);
		const cards = await scouts(a);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.title).toMatch(/^Trending scout: /);
		expect(cards[0]?.topic).toBe("trending scout");
		expect(results.filter((r) => r.ok).length).toBe(2);
		expect(results.flatMap((r) => (r.ok ? r.filed : []))).toEqual([
			cards[0]!.id,
		]);
		expect(first.scheduled() + second.scheduled()).toBe(1);
		expect(
			(await a.store.events()).map((e) => ({
				taskId: e.taskId,
				kind: e.kind,
				to: e.to,
			})),
		).toEqual([
			{ taskId: cards[0]!.id, kind: "create", to: "todo" },
			{ taskId: cards[0]!.id, kind: "state", to: "queued" },
		]);
	});

	for (const change of ["settings", "verdicts"] as const)
		test(`a concurrent ${change} change prevents a stale scout`, async () => {
			const a = await project();
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const h = harness({
				projects: [a],
				fake: {
					respond: async (url) => {
						if (url === `${API}/repos/${UNION[0]}`) {
							reached.resolve();
							await release.promise;
						}
						return undefined;
					},
				},
			});
			const scan = h.scanner.scanNow();
			await reached.promise;
			if (change === "settings")
				await a.store.setSettings({ trendingScout: false });
			else
				for (const repo of UNION)
					await a.store.saveTrendingVerdict(verdict(repo, "no_fit", "no"));
			release.resolve();
			expect(await scan).toEqual({ ok: true, filed: [] });
			expect(await scouts(a)).toEqual([]);
			expect(await a.store.events()).toEqual([]);
			expect(h.scheduled()).toBe(0);
		});

	test("final global persistence preserves a concurrent weekly state update", async () => {
		const a = await project();
		const globalStore = await GlobalStore.open(
			mkdtempSync(join(root, "global-")),
		);
		try {
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const at = 42;
			const h = harness({
				projects: [a],
				globalStore,
				now: () => at,
				fake: {
					respond: async (url) => {
						if (url === ALL_URL) {
							reached.resolve();
							await release.promise;
						}
						return undefined;
					},
				},
			});
			const scan = h.scanner.scanNow();
			await reached.promise;
			await globalStore.update<TrendingState>("trending", () => ({
				...EMPTY_TRENDING_STATE,
				lastWeek: "2026-W46",
				firstFailAt: 7,
			}));
			release.resolve();
			const result = await scan;
			expect(result.ok).toBe(true);
			expect(await globalStore.get<TrendingState>("trending")).toEqual({
				lastWeek: "2026-W46",
				firstFailAt: 7,
				lastRunAt: at,
				lastError: null,
			});
			const cards = await scouts(a);
			expect(cards).toHaveLength(1);
			expect((await a.store.events()).map((event) => event.kind)).toEqual([
				"create",
				"state",
			]);
		} finally {
			await globalStore.close();
		}
	});
});

describe("verdict memory", () => {
	test("final verdicts never return, deferred ones do, per project", async () => {
		const a = await project();
		const b = await project();
		await a.store.saveTrendingVerdict(
			verdict("thedotmack/claude-mem", "filed", "good fit"),
		);
		await a.store.saveTrendingVerdict(
			verdict("pingdotgg/t3code", "no_fit", "too big", true),
		);
		await a.store.saveTrendingVerdict(
			verdict("garrytan/gstack", "deferred", "revisit"),
		);
		await a.store.saveTrendingVerdict(
			verdict("old/repo", "deferred", "not yet"),
		);
		const h = harness({ projects: [a, b] });
		expect((await h.scanner.scanNow()).ok).toBe(true);

		const ca = bundle(a).candidates;
		const repos = ca.map((c) => c.repo);
		expect(repos).not.toContain("thedotmack/claude-mem");
		expect(repos).not.toContain("pingdotgg/t3code");
		expect(ca.find((c) => c.repo === "garrytan/gstack")).toMatchObject({
			trendingNow: true,
			earlierReason: "revisit",
		});
		// Deferred but no longer trending: offered again with its metadata fetched.
		expect(ca.find((c) => c.repo === "old/repo")).toMatchObject({
			trendingNow: false,
			earlierReason: "not yet",
		});
		expect(h.fake.calls.some((c) => c.url === `${API}/repos/old/repo`)).toBe(
			true,
		);
		expect(bundle(a).hints).toEqual([
			{ repo: "pingdotgg/t3code", reason: "too big" },
		]);

		// Project B never judged anything: A's verdicts do not hide repos from it.
		const rb = bundle(b).candidates.map((c) => c.repo);
		expect(rb).toEqual(UNION);
		expect(bundle(b).hints).toEqual([]);
	});

	test("a project whose every repo is judged gets no card", async () => {
		const a = await project();
		for (const r of UNION)
			await a.store.saveTrendingVerdict(verdict(r, "no_fit", "no"));
		const h = harness({ projects: [a] });
		expect(await h.scanner.scanNow()).toEqual({ ok: true, filed: [] });
		expect(await scouts(a)).toHaveLength(0);
		expect(h.scheduled()).toBe(0);
	});
});

describe("weekly schedule", () => {
	const HOUR = 60 * 60 * 1000;
	// Local wall-clock times so the test holds in any TZ.
	const monday = new Date(2026, 10, 9, 6, 0).getTime();
	const sundayBefore = new Date(2026, 10, 8, 12, 0).getTime();
	const wednesday = new Date(2026, 10, 11, 10, 0).getTime();
	const nextMonday = new Date(2026, 10, 16, 6, 0).getTime();

	test("fixture dates are Mondays", () => {
		expect(new Date(monday).getDay()).toBe(1);
		expect(new Date(nextMonday).getDay()).toBe(1);
	});

	test("fires on the first tick at or after Monday 06:00, once per week", async () => {
		const a = await project();
		let t = monday - 60_000;
		const state = { value: { ...EMPTY_TRENDING_STATE } };
		const h = harness({ projects: [a], now: () => t, state });
		await h.scanner.tick();
		expect(await scouts(a)).toHaveLength(0);
		expect(h.fake.calls).toHaveLength(0);
		t = monday;
		await h.scanner.tick();
		expect(await scouts(a)).toHaveLength(1);
		expect(state.value.lastWeek).toBe("2026-W46");
		expect(state.value.lastRunAt).toBe(monday);
		await closeScouts(a);
		t = monday + 5 * 60_000;
		await h.scanner.tick();
		// A restart reads the persisted state: still no second run this week.
		const again = harness({ projects: [a], now: () => wednesday, state });
		await again.scanner.tick();
		expect(await scouts(a)).toHaveLength(1);
		expect(again.fake.calls).toHaveLength(0);
	});

	test("a board down at the slot catches up later the same week", async () => {
		const a = await project();
		const state = { value: { ...EMPTY_TRENDING_STATE } };
		const h = harness({ projects: [a], now: () => wednesday, state });
		await h.scanner.tick();
		expect(await scouts(a)).toHaveLength(1);
		expect(state.value.lastWeek).toBe("2026-W46");
	});

	test("disabled or no opted-in project is a no-op", async () => {
		const a = await project();
		const off = harness({
			projects: [a],
			now: () => monday,
			enabled: () => false,
		});
		await off.scanner.tick();
		const none = harness({
			projects: [await project({ trendingScout: false })],
			now: () => monday,
		});
		await none.scanner.tick();
		expect(off.fake.calls).toHaveLength(0);
		expect(none.fake.calls).toHaveLength(0);
		expect(off.state.value).toEqual(EMPTY_TRENDING_STATE);
	});

	test("a manual scan does not consume the week's slot", async () => {
		const a = await project();
		let t = sundayBefore;
		const state = { value: { ...EMPTY_TRENDING_STATE } };
		const h = harness({ projects: [a], now: () => t, state });
		expect((await h.scanner.scanNow()).ok).toBe(true);
		expect(state.value.lastWeek).toBeNull();
		expect(state.value.lastRunAt).toBe(sundayBefore);
		await closeScouts(a);
		t = monday;
		await h.scanner.tick();
		expect(await scouts(a)).toHaveLength(2);
		expect(state.value.lastWeek).toBe("2026-W46");
	});

	test("a failure retries for 24h, then waits for next week", async () => {
		const a = await project();
		let t = monday;
		let broken = true;
		const state = { value: { ...EMPTY_TRENDING_STATE } };
		const h = harness({
			projects: [a],
			now: () => t,
			state,
			fake: {
				respond: (url) =>
					broken && url === ALL_URL
						? new Response("down", { status: 500 })
						: undefined,
			},
		});
		const pageCalls = () =>
			h.fake.calls.filter((c) => c.url === ALL_URL).length;
		await h.scanner.tick();
		expect(state.value.firstFailAt).toBe(monday);
		expect(state.value.lastWeek).toBeNull();
		expect(state.value.lastError?.reason).toContain("HTTP 500");
		t = monday + 23 * HOUR;
		await h.scanner.tick();
		expect(pageCalls()).toBe(2);
		expect(state.value.firstFailAt).toBe(monday);
		t = monday + 24 * HOUR;
		await h.scanner.tick();
		expect(pageCalls()).toBe(2);
		expect(state.value.lastWeek).toBe("2026-W46");
		expect(state.value.lastError).not.toBeNull();
		broken = false;
		t = wednesday;
		await h.scanner.tick();
		expect(pageCalls()).toBe(2);
		expect(await scouts(a)).toHaveLength(0);
		t = nextMonday;
		await h.scanner.tick();
		expect(await scouts(a)).toHaveLength(1);
		expect(state.value).toMatchObject({
			lastWeek: "2026-W47",
			lastRunAt: nextMonday,
			lastError: null,
			firstFailAt: null,
		});
	});

	test("a failure streak from last week does not stop this week's run", async () => {
		const a = await project();
		const state = {
			value: {
				...EMPTY_TRENDING_STATE,
				firstFailAt: monday - 7 * 24 * HOUR,
				lastError: { reason: "old", at: monday - 7 * 24 * HOUR },
			},
		};
		const h = harness({ projects: [a], now: () => wednesday, state });
		await h.scanner.tick();
		expect(await scouts(a)).toHaveLength(1);
		expect(state.value.lastError).toBeNull();
	});
});

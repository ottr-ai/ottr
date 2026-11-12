import { join } from "node:path";
import { writeBelow } from "./confine.ts";
import { withGithubRetry } from "./githubRetry.ts";
import { trendingScoutPrompt } from "./prompts.ts";
import type { ProjectStore } from "./store.ts";
import type { ListedTask, TrendingStatus } from "./types.ts";

// Weekly GitHub trending pages the scan reads; their union is the week's candidate pool.
export const TRENDING_PAGES: readonly string[] = [
	"https://github.com/trending?since=weekly",
	"https://github.com/trending/typescript?since=weekly",
	"https://github.com/trending/javascript?since=weekly",
];
/** Max proposal cards one scout files per project per scan (server-enforced by the verdict route). */
export const TRENDING_CAP = 3;
/** Repos the scout may clone or read deeply per scan. */
export const DEEP_REPOS = 6;
/** Files the scout may read per deeply inspected repo. */
export const DEEP_FILES = 15;

const FETCH_TIMEOUT_MS = 20_000;
const README_MAX = 6000;
const TREE_MAX = 200;
const CONCURRENCY = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_HOUR = 6;
const REPO_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

const ARTICLE_RE =
	/<article\b[^>]*\bclass="[^"]*\bBox-row\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
const H2_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2>/;
const H2_LINK_RE = /<a\b[^>]*?\bhref="\/([^"/?#]+)\/([^"/?#]+)"/;

/** A lowercase `owner/repo` that is safe to put in an API path ("." and ".." segments refused). */
function validRepo(repo: string): boolean {
	return (
		REPO_RE.test(repo) && repo.split("/").every((s) => s !== "." && s !== "..")
	);
}

/**
 * Repos on one GitHub trending page: the `/owner/repo` link inside each Box-row article's h2
 * (sponsor, login, and stargazer links sit outside the h2). Lowercase, deduped, page order.
 */
export function parseTrending(html: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of html.matchAll(ARTICLE_RE)) {
		const h2 = H2_RE.exec(m[1] ?? "");
		if (!h2) continue;
		const link = H2_LINK_RE.exec(h2[1] ?? "");
		if (!link) continue;
		const repo = `${link[1]}/${link[2]}`.toLowerCase();
		if (!validRepo(repo) || seen.has(repo)) continue;
		seen.add(repo);
		out.push(repo);
	}
	return out;
}

export interface TrendingProject {
	name: string;
	path: string;
	store: ProjectStore;
	github: string | null;
}

/** Board-wide scan state the server persists between ticks and restarts. */
export interface TrendingState {
	/** ISO week key (`2026-W45`, server-local) whose weekly slot is done (ran or gave up). */
	lastWeek: string | null;
	lastRunAt: number | null;
	lastError: { reason: string; at: number } | null;
	/** First failed weekly attempt of the current week; retries stop 24h after it. */
	firstFailAt: number | null;
}

export const EMPTY_TRENDING_STATE: TrendingState = {
	lastWeek: null,
	lastRunAt: null,
	lastError: null,
	firstFailAt: null,
};

/** One repo in a scout bundle. */
interface RepoFacts {
	repo: string;
	url: string;
	description: string | null;
	stars: number | null;
	language: string | null;
	license: string | null;
	pushedAt: string | null;
	defaultBranch: string;
	readme: string | null;
	readmeTruncated: boolean;
	tree: string[];
	treeTruncated: boolean;
}

type RepoLookup = RepoFacts | { skip: string };

/** Monday 00:00 (server-local) of the week holding `ms`. */
function mondayOf(ms: number): Date {
	const d = new Date(ms);
	const back = (d.getDay() + 6) % 7;
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

/** ISO 8601 week key of `ms` in server-local time, e.g. `2026-W45`. */
function isoWeekKey(ms: number): string {
	const mon = mondayOf(ms);
	// The ISO year is the Thursday's year; week 1 holds January 4th.
	const thu = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 3);
	const year = thu.getFullYear();
	const week1 = mondayOf(new Date(year, 0, 4).getTime());
	// Round: a DST switch between the two Mondays shifts the difference by an hour.
	const week = 1 + Math.round((mon.getTime() - week1.getTime()) / (7 * DAY_MS));
	return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The weekly slot of the week holding `ms`: Monday 06:00 server-local. */
function weeklySlot(ms: number): number {
	const mon = mondayOf(ms);
	return new Date(
		mon.getFullYear(),
		mon.getMonth(),
		mon.getDate(),
		SLOT_HOUR,
	).getTime();
}

function localDate(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function errText(e: unknown): string {
	if (e instanceof Error)
		return e.name === "TimeoutError" || e.name === "AbortError"
			? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
			: e.message;
	return String(e);
}

/** A live scout card blocks another scan for its project: not cancelled and not done. */
function liveScout(store: ProjectStore): ListedTask | null {
	return (
		store
			.listTasks()
			.find(
				(t) =>
					t.kind === "trending" && t.cancelledAt === null && t.stage !== "done",
			) ?? null
	);
}

/** Runs `fn` over `items` with at most `limit` in flight; the first rejection stops new starts and rethrows. */
async function pool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const worker = async () => {
		while (!failed && next < items.length) {
			const i = next++;
			try {
				out[i] = await fn(items[i] as T);
			} catch (e) {
				failed = true;
				throw e;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return out;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function createTrendingScanner(deps: {
	projects: () => Iterable<TrendingProject>;
	enabled: () => boolean;
	load: () => TrendingState;
	save: (s: TrendingState) => void;
	token: () => string | undefined;
	apiBase?: () => string;
	fetch?: typeof fetch;
	now?: () => number;
	log: (m: string) => void;
	schedule: () => void;
}): {
	tick(): Promise<void>;
	scanNow(): Promise<
		| { ok: true; filed: string[] }
		| { ok: false; status: 409 | 502; error: string }
	>;
	status(): TrendingStatus;
} {
	const doFetch = withGithubRetry(deps.fetch ?? fetch);
	const now = deps.now ?? Date.now;
	// Shared by tick and scanNow: one scan at a time board-wide.
	let inFlight = false;

	// Fresh iteration per call: a one-shot iterator would be empty on the next tick.
	const optedIn = (): TrendingProject[] =>
		[...deps.projects()].filter(
			(p) => p.store.getSettings().trendingScout === true,
		);

	async function fetchPage(url: string): Promise<string[]> {
		let res: Response;
		try {
			res = await doFetch(url, {
				headers: { accept: "text/html", "user-agent": "ottr" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch (e) {
			throw new Error(`trending page ${url}: ${errText(e)}`);
		}
		if (!res.ok)
			throw new Error(`trending page ${url} returned HTTP ${res.status}`);
		let html: string;
		try {
			html = await res.text();
		} catch (e) {
			throw new Error(`trending page ${url}: ${errText(e)}`);
		}
		const repos = parseTrending(html);
		if (repos.length === 0)
			throw new Error(`trending page ${url} listed no repos (markup changed?)`);
		return repos;
	}

	/** GET on the REST API with the board token; redirects are refused so the token never follows a hop. */
	async function api(path: string, accept: string): Promise<Response> {
		const base = (deps.apiBase?.() ?? "https://api.github.com").replace(
			/\/+$/,
			"",
		);
		const url = `${base}${path}`;
		const headers: Record<string, string> = { accept, "user-agent": "ottr" };
		const token = deps.token();
		if (token) headers.authorization = `Bearer ${token}`;
		try {
			return await doFetch(url, {
				headers,
				redirect: "manual",
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch (e) {
			throw new Error(`GitHub API ${path}: ${errText(e)}`);
		}
	}

	/** Non-2xx the scan cannot work around: rate limit, server error, auth. */
	function apiFailure(path: string, res: Response): Error {
		const why =
			res.status === 403 || res.status === 429
				? " (rate limited or forbidden)"
				: "";
		return new Error(`GitHub API ${path} returned HTTP ${res.status}${why}`);
	}

	/** Reads an API body; a timeout, network error or malformed JSON mid-body fails the scan. */
	async function readBody(path: string, res: Response, as: "json" | "text") {
		try {
			return as === "json" ? ((await res.json()) as unknown) : await res.text();
		} catch (e) {
			throw new Error(
				`GitHub API ${path}: reading the body failed: ${errText(e)}`,
			);
		}
	}

	/** The README text, cut to the cap; null on 404, throws on other failures. */
	async function fetchReadme(
		base: string,
	): Promise<{ readme: string | null; truncated: boolean }> {
		const readmePath = `${base}/readme`;
		const rd = await api(readmePath, "application/vnd.github.raw");
		if (rd.ok) {
			const text = (await readBody(readmePath, rd, "text")) as string;
			return {
				readme: text.slice(0, README_MAX),
				truncated: text.length > README_MAX,
			};
		}
		if (rd.status !== 404) throw apiFailure(readmePath, rd);
		return { readme: null, truncated: false };
	}

	/** The default branch's blob paths, cut to the cap; empty on 404/409. */
	async function fetchTree(
		base: string,
		branch: string,
	): Promise<{ tree: string[]; truncated: boolean }> {
		const treePath = `${base}/git/trees/${branch}?recursive=1`;
		const tr = await api(treePath, "application/vnd.github+json");
		if (!tr.ok) {
			// 404 = branch gone, 409 = empty repository: no tree, not a scan failure.
			if (tr.status !== 404 && tr.status !== 409)
				throw apiFailure(treePath, tr);
			return { tree: [], truncated: false };
		}
		const t = (await readBody(treePath, tr, "json")) as {
			tree?: unknown;
			truncated?: unknown;
		} | null;
		const entries = t?.tree;
		const blobs = Array.isArray(entries)
			? (entries as { path?: unknown; type?: unknown }[])
					.filter((e) => e?.type === "blob" && typeof e.path === "string")
					.map((e) => e.path as string)
			: [];
		return {
			tree: blobs.slice(0, TREE_MAX),
			truncated: blobs.length > TREE_MAX || t?.truncated === true,
		};
	}

	/** A redirect/404 answer means the repo is skipped, not failed. */
	function metaSkipReason(status: number): string | null {
		if (status === 404) return "not found (deleted or private)";
		if (status >= 300 && status < 400) return `moved (HTTP ${status})`;
		return null;
	}

	async function lookup(repo: string): Promise<RepoLookup> {
		const base = `/repos/${repo}`;
		const meta = await api(base, "application/vnd.github+json");
		const skip = metaSkipReason(meta.status);
		if (skip !== null) return { skip };
		if (!meta.ok) throw apiFailure(base, meta);
		const body = (await readBody(base, meta, "json")) as Record<
			string,
			unknown
		> | null;
		if (body === null || typeof body !== "object")
			throw new Error(`GitHub API ${base} returned a non-JSON body`);
		if (body.archived === true) return { skip: "archived" };
		const defaultBranch = str(body.default_branch) ?? "main";
		const readme = await fetchReadme(base);
		const tree = await fetchTree(
			base,
			defaultBranch.split("/").map(encodeURIComponent).join("/"),
		);
		const license = body.license as { spdx_id?: unknown } | null | undefined;
		return {
			repo,
			url: str(body.html_url) ?? `https://github.com/${repo}`,
			description: str(body.description),
			stars:
				typeof body.stargazers_count === "number"
					? body.stargazers_count
					: null,
			language: str(body.language),
			license: str(license?.spdx_id),
			pushedAt: str(body.pushed_at),
			defaultBranch,
			readme: readme.readme,
			readmeTruncated: readme.truncated,
			tree: tree.tree,
			treeTruncated: tree.truncated,
		};
	}

	/** One project's picks and hints from the trending repos and its past verdicts. */
	function planFor(
		p: TrendingProject,
		trending: string[],
		seen: Set<string>,
	): {
		project: TrendingProject;
		picks: {
			repo: string;
			trendingNow: boolean;
			earlierReason: string | null;
		}[];
		hints: { repo: string; reason: string }[];
	} {
		const verdicts = p.store.listTrendingVerdicts();
		const byRepo = new Map(verdicts.map((v) => [v.repo.toLowerCase(), v]));
		const picks: {
			repo: string;
			trendingNow: boolean;
			earlierReason: string | null;
		}[] = [];
		for (const repo of trending) {
			const v = byRepo.get(repo);
			if (v && v.verdict !== "deferred") continue;
			picks.push({
				repo,
				trendingNow: true,
				earlierReason: v ? v.reason : null,
			});
		}
		for (const v of verdicts) {
			const repo = v.repo.toLowerCase();
			if (v.verdict !== "deferred" || seen.has(repo) || !validRepo(repo))
				continue;
			picks.push({ repo, trendingNow: false, earlierReason: v.reason });
		}
		const hints = verdicts
			.filter((v) => v.verdict === "no_fit" && v.rejectedByUser)
			.map((v) => ({ repo: v.repo, reason: v.reason }));
		return { project: p, picks, hints };
	}

	/** Writes the bundle and files the scout card; null when the project has no candidates. */
	function fileScoutCard(
		project: TrendingProject,
		candidates: (RepoLookup & {
			trendingNow: boolean;
			earlierReason: string | null;
		})[],
		hints: { repo: string; reason: string }[],
		startedAt: number,
	): string | null {
		if (candidates.length === 0) {
			deps.log(`trending: ${project.name}: no new candidates, no card`);
			return null;
		}
		// The task data dir, not serverDir: a worker runs the scout (D6), and only the data dir
		// is mounted there. writeBelow follows no symlink a worker planted under the data root.
		const bundlePath = join(
			project.store.tasksDir,
			"trending",
			`${startedAt}.json`,
		);
		writeBelow(
			project.store.dataRoot,
			bundlePath,
			JSON.stringify(
				{
					project: project.name,
					github: project.github,
					scannedAt: startedAt,
					pages: TRENDING_PAGES,
					candidates,
					hints,
				},
				null,
				2,
			),
		);
		const task = project.store.createTask(
			trendingScoutPrompt({
				project: project.name,
				repo: project.github,
				bundlePath,
				candidates: candidates.length,
				cap: TRENDING_CAP,
				maxDeep: DEEP_REPOS,
				maxFiles: DEEP_FILES,
			}),
			null,
			"trending",
		);
		project.store.updateTask(task.id, {
			title: `Trending scout: ${localDate(startedAt)}`,
			promptAuthor: "board",
			topic: "trending scout",
		});
		deps.log(
			`trending: ${project.name}: filed scout card ${task.id} with ${candidates.length} candidate(s)`,
		);
		return task.id;
	}

	/** Looks every wanted repo up in a bounded pool; skipped repos are logged, not dropped. */
	async function lookupFacts(
		wanted: string[],
	): Promise<Map<string, RepoLookup>> {
		const facts = new Map<string, RepoLookup>();
		const looked = await pool(wanted, CONCURRENCY, lookup);
		wanted.forEach((repo, i) => {
			const f = looked[i] as RepoLookup;
			if ("skip" in f) deps.log(`trending: ${repo}: skipped, ${f.skip}`);
			facts.set(repo, f);
		});
		return facts;
	}

	/** Projects with no open scout card; open ones are logged. */
	function eligibleProjects(projects: TrendingProject[]): TrendingProject[] {
		return projects.filter((p) => {
			const live = liveScout(p.store);
			if (live)
				deps.log(
					`trending: ${p.name}: skipped, scout card ${live.id} is still open`,
				);
			return live === null;
		});
	}

	/** A pick's lookup, with its trending flags; skipped or failed lookups drop out. */
	function candidatesFor(
		picks: {
			repo: string;
			trendingNow: boolean;
			earlierReason: string | null;
		}[],
		facts: Map<string, RepoLookup>,
	): (RepoLookup & {
		trendingNow: boolean;
		earlierReason: string | null;
	})[] {
		return picks.flatMap((x) => {
			const f = facts.get(x.repo);
			if (!f || "skip" in f) return [];
			return [
				{ ...f, trendingNow: x.trendingNow, earlierReason: x.earlierReason },
			];
		});
	}

	/** New trending repos, deduped across pages in page order. */
	function mergeTrending(pages: string[][]): {
		trending: string[];
		seen: Set<string>;
	} {
		const trending: string[] = [];
		const seen = new Set<string>();
		for (const repos of pages)
			for (const r of repos)
				if (!seen.has(r)) {
					seen.add(r);
					trending.push(r);
				}
		return { trending, seen };
	}

	/**
	 * One scan over `projects`: fetch the trending pages, the candidates' metadata, then one
	 * bundle and scout card per project with candidates. Throws a readable reason on fetch or
	 * parse failure before any card is filed. Returns the filed card ids.
	 */
	async function scan(projects: TrendingProject[]): Promise<string[]> {
		const startedAt = now();
		const eligible = eligibleProjects(projects);
		if (eligible.length === 0) return [];

		const pages = await Promise.all(TRENDING_PAGES.map(fetchPage));
		const { trending, seen } = mergeTrending(pages);

		// Per project: trending repos without a final verdict, then every deferred repo.
		const plans = eligible.map((p) => planFor(p, trending, seen));

		const facts = await lookupFacts([
			...new Set(plans.flatMap((pl) => pl.picks.map((x) => x.repo))),
		]);

		const filed: string[] = [];
		for (const { project, picks, hints } of plans) {
			const id = fileScoutCard(
				project,
				candidatesFor(picks, facts),
				hints,
				startedAt,
			);
			if (id !== null) filed.push(id);
		}
		if (filed.length > 0) deps.schedule();
		return filed;
	}

	/** Runs a scan under the shared guard; persists lastRunAt/lastError (and the week fields via `week`). */
	async function attempt(
		projects: TrendingProject[],
		week: ((s: TrendingState, ok: boolean, at: number) => TrendingState) | null,
	): Promise<{ ok: true; filed: string[] } | { ok: false; error: string }> {
		inFlight = true;
		try {
			const filed = await scan(projects);
			const at = now();
			const s: TrendingState = {
				...deps.load(),
				lastRunAt: at,
				lastError: null,
			};
			deps.save(week ? week(s, true, at) : s);
			return { ok: true, filed };
		} catch (e) {
			const reason = errText(e).slice(0, 500);
			const at = now();
			deps.log(`trending: scan failed: ${reason}`);
			const s: TrendingState = { ...deps.load(), lastError: { reason, at } };
			deps.save(week ? week(s, false, at) : s);
			return { ok: false, error: reason };
		} finally {
			inFlight = false;
		}
	}

	async function tick(): Promise<void> {
		if (inFlight || !deps.enabled()) return;
		const projects = optedIn();
		if (projects.length === 0) return;
		const t = now();
		const thisWeek = isoWeekKey(t);
		const state = deps.load();
		if (state.lastWeek === thisWeek || t < weeklySlot(t)) return;
		// A failure streak from an earlier week does not count against this one.
		const firstFailAt =
			state.firstFailAt !== null && isoWeekKey(state.firstFailAt) === thisWeek
				? state.firstFailAt
				: null;
		if (firstFailAt !== null && t >= firstFailAt + DAY_MS) {
			deps.log(
				`trending: giving up on ${thisWeek} after 24h of failures, next try next week`,
			);
			deps.save({ ...state, lastWeek: thisWeek, firstFailAt: null });
			return;
		}
		await attempt(projects, (s, ok, at) =>
			ok
				? { ...s, lastWeek: thisWeek, firstFailAt: null }
				: { ...s, firstFailAt: firstFailAt ?? at },
		);
	}

	async function scanNow(): Promise<
		| { ok: true; filed: string[] }
		| { ok: false; status: 409 | 502; error: string }
	> {
		if (inFlight)
			return {
				ok: false,
				status: 409,
				error: "a trending scan is already running",
			};
		const projects = optedIn();
		if (projects.length === 0)
			return {
				ok: false,
				status: 409,
				error: "no project has the trending scout on",
			};
		for (const p of deps.projects()) {
			const live = liveScout(p.store);
			if (live)
				return {
					ok: false,
					status: 409,
					error: `a trending scout card is still open: ${live.id}`,
				};
		}
		const r = await attempt(projects, null);
		return r.ok ? r : { ok: false, status: 502, error: r.error };
	}

	function status(): TrendingStatus {
		const s = deps.load();
		let running = inFlight;
		if (!running)
			for (const p of deps.projects())
				if (liveScout(p.store)) {
					running = true;
					break;
				}
		return { lastRunAt: s.lastRunAt, lastError: s.lastError, running };
	}

	return { tick, scanNow, status };
}

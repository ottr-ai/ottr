import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	analyzeRange,
	proposalPrompt,
	renderReport,
	stripInvisible,
} from "./forkAnalysis.ts";
import { githubHost } from "./githubHost.ts";
import { isProposalReason } from "./prompts.ts";
import { listPulls, type PullInfo, pullState } from "./prs.ts";
import { ownerRepo, runGh } from "./release.ts";
import { singleFlightTick } from "./singleFlight.ts";
import type { ProjectStore } from "./store.ts";
import type {
	ForkAnalysisResult,
	ForkBranchState,
	ForkCommit,
	ForkHoldState,
	ForkInfo,
	ForkRange,
	GithubFacts,
} from "./types.ts";
import { git } from "./worktree.ts";

// Hard gates for the fork watcher; the model never lifts them.
export const FORK_GATES = {
	/** A fork must sit this quiet after a push before we spend a run on it. */
	QUIET_MS: 6 * 60 * 60 * 1000,
	/** A pending head older than this is analyzed even past the retry pause. */
	MAX_WAIT_MS: 24 * 60 * 60 * 1000,
	/** One analysis attempt per fork per day. */
	FORK_RUN_SPACING_MS: 24 * 60 * 60 * 1000,
	/** Analysis attempts started per project per day. */
	PROJECT_DAILY_RUNS: 3,
	FETCH_TIMEOUT_MS: 120_000,
	MODEL_TIMEOUT_MS: 15 * 60_000,
	/** GitHub's size estimate cap: huge forks are not research targets. */
	MAX_SIZE_KB: 500 * 1024,
} as const;

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type GhFn = (
	args: string[],
	timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;
export type GitFn = (
	args: string[],
	cwd: string,
	timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** URL built only from validated ForkInfo fields; never from data-supplied strings. */
export function forkUrl(f: ForkInfo): string {
	return `${githubHost().webBase}/${f.owner}/${f.name}.git`;
}

/** Validates one GitHub /forks page; invalid entries are skipped, never thrown. */
export function parseForkPage(body: unknown): ForkInfo[] {
	if (!Array.isArray(body)) return [];
	const out: ForkInfo[] = [];
	for (const e of body) {
		if (typeof e !== "object" || e === null) continue;
		const r = e as Record<string, unknown>;
		if (typeof r.id !== "number" || !Number.isInteger(r.id) || r.id <= 0)
			continue;
		const owner = r.owner;
		if (typeof owner !== "object" || owner === null) continue;
		const login = (owner as Record<string, unknown>).login;
		if (
			typeof login !== "string" ||
			!NAME_RE.test(login) ||
			login.startsWith(".")
		)
			continue;
		const name = r.name;
		if (typeof name !== "string" || !NAME_RE.test(name) || name.startsWith("."))
			continue;
		const defaultBranch =
			typeof r.default_branch === "string" ? r.default_branch : null;
		const pushedAt =
			typeof r.pushed_at === "string" ? Date.parse(r.pushed_at) || null : null;
		const sizeKb = typeof r.size === "number" ? r.size : null;
		out.push({
			id: r.id,
			owner: login,
			name,
			defaultBranch,
			pushedAt,
			sizeKb,
		});
	}
	return out;
}

/** Pure rollup for the onboarding fork panel: total, active (pushed within 90 days), five newest. */
export function forkSummary(
	forks: ForkInfo[],
	now: number,
): Omit<GithubFacts, "repo"> {
	const dated = forks.filter((f) => f.pushedAt !== null);
	const cutoff = now - 90 * 24 * 60 * 60 * 1000;
	const recent = dated
		.sort((a, b) => b.pushedAt! - a.pushedAt!)
		.slice(0, 5)
		.map((f) => ({ owner: f.owner, name: f.name, pushedAt: f.pushedAt! }));
	return {
		forks: forks.length,
		active: dated.filter((f) => f.pushedAt! >= cutoff).length,
		recent,
	};
}

/** Pages the upstream fork list until a short page; throws on gh failure (auth problems stay visible). */
export async function listForks(repo: string, gh: GhFn): Promise<ForkInfo[]> {
	if (!REPO_RE.test(repo)) throw new Error(`invalid repo id: ${repo}`);
	const forks: ForkInfo[] = [];
	for (let page = 1; page <= 100; page++) {
		// ponytail: caps at 10k forks; more needs a cursor, not a loop bound.
		const res = await gh(
			["api", `repos/${repo}/forks?per_page=100&page=${page}`],
			FORK_GATES.MODEL_TIMEOUT_MS,
		);
		if (res.code !== 0)
			throw new Error(
				`gh api forks failed (${res.code}): ${res.stderr.slice(0, 300)}`,
			);
		let body: unknown;
		try {
			body = JSON.parse(res.stdout);
		} catch {
			throw new Error("gh api forks returned non-JSON output");
		}
		const pageForks = parseForkPage(body);
		forks.push(...pageForks);
		if (pageForks.length < 100) break;
	}
	return forks;
}

/** First 16 hex chars of sha256(branch): the local ref name and the watch row key. */
export function branchHash(branch: string): string {
	return createHash("sha256").update(branch).digest("hex").slice(0, 16);
}

/** Branch heads of one fork; branch names are data, so every name passes check-ref-format first. */
export async function listBranchHeads(
	url: string,
	dir: string,
	git: GitFn,
): Promise<{ heads: Map<string, string>; skipped: number }> {
	const res = await git(
		["ls-remote", "--heads", url],
		dir,
		FORK_GATES.FETCH_TIMEOUT_MS,
	);
	if (res.code !== 0)
		throw new Error(
			`ls-remote failed (${res.code}): ${res.stderr.slice(0, 300)}`,
		);
	const heads = new Map<string, string>();
	let skipped = 0;
	for (const line of res.stdout.split("\n")) {
		const m = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(line.trim());
		if (!m || m[1] === undefined || m[2] === undefined) continue;
		const branch = m[2];
		const sha = m[1];
		const chk = await git(
			["check-ref-format", "--branch", branch],
			dir,
			10_000,
		);
		if (chk.code !== 0) {
			skipped++;
			continue;
		}
		heads.set(branch, sha);
	}
	return { heads, skipped };
}

/** Bare mirror cache for one fork, keyed by its stable GitHub id, below the server-only state dir. */
export async function ensureCache(
	stateDir: string,
	fork: ForkInfo,
	git: GitFn,
): Promise<string> {
	const cachePath = join(stateDir, "forks", `${fork.id}.git`);
	if (existsSync(cachePath)) return cachePath;
	const res = await git(["init", "--bare", "-q", cachePath], stateDir, 60_000);
	if (res.code !== 0)
		throw new Error(
			`git init --bare failed (${res.code}): ${res.stderr.slice(0, 300)}`,
		);
	return cachePath;
}

/** Hardened fetch: no credential helper, only https, fsck every object. */
export async function fetchFork(
	cachePath: string,
	url: string,
	refspecs: string[],
	git: GitFn,
): Promise<void> {
	const res = await git(
		[
			"-c",
			"credential.helper=",
			"-c",
			"protocol.allow=never",
			"-c",
			"protocol.https.allow=always",
			"-c",
			"fetch.fsckObjects=true",
			"-c",
			"transfer.fsckObjects=true",
			"fetch",
			"--no-tags",
			"--no-recurse-submodules",
			url,
			...refspecs,
		],
		cachePath,
		FORK_GATES.FETCH_TIMEOUT_MS,
	);
	if (res.code !== 0)
		throw new Error(`fetch failed (${res.code}): ${res.stderr.slice(0, 300)}`);
}

/** Local cache ref holding one pull's head: `refs/pull/<n>/head` fetched as `refs/heads/pr-<n>`. */
const prRef = (n: number) => `refs/heads/pr-${n}`;

async function revList(
	args: string[],
	cachePath: string,
	git: GitFn,
): Promise<string[]> {
	const r = await git(["rev-list", ...args], cachePath, 60_000);
	if (r.code !== 0)
		throw new Error(`rev-list failed (${r.code}): ${r.stderr.slice(0, 300)}`);
	return r.stdout.split("\n").filter(Boolean);
}

/** Raw range of one branch, no PR excludes: the shas, the merges, and the upstream-side list. */
async function rawRange(
	cachePath: string,
	analyzedHead: string | null,
	head: string,
	upstreamHead: string,
	git: GitFn,
): Promise<{ shas: string[]; merges: string[]; up: Set<string> }> {
	const base = analyzedHead ?? upstreamHead;
	const fromAnalysis = await revList(
		["--no-merges", "--cherry-pick", "--right-only", `${base}...${head}`],
		cachePath,
		git,
	);
	let shas = fromAnalysis;
	let up = new Set<string>();
	if (analyzedHead !== null) {
		const fromUpstream = await revList(
			[
				"--no-merges",
				"--cherry-pick",
				"--right-only",
				`${upstreamHead}...${head}`,
			],
			cachePath,
			git,
		);
		up = new Set(fromUpstream);
		shas = fromAnalysis.filter((s) => up.has(s));
	}
	const merges = await revList(
		["--merges", `${base}..${head}`],
		cachePath,
		git,
	);
	return { shas, merges, up };
}

/**
 * Non-merge new work of one branch: exact-SHA intersection of the analysis-base and upstream
 * comparisons, so rewritten commits already analyzed count as new only when they carry work
 * upstream lacks. Each exclude ref (a PR head) removes the commits it covers: a sha is
 * covered when it is absent from `R...head` (patch-equal counts, matching cherry-pick
 * semantics), a merge when `base..head ^R` drops it.
 */
export async function rangeCommits(
	cachePath: string,
	analyzedHead: string | null,
	head: string,
	upstreamHead: string,
	git: GitFn,
	exclude: string[] = [],
): Promise<{ shas: string[]; merges: string[] }> {
	const { shas, merges } = await rawRange(
		cachePath,
		analyzedHead,
		head,
		upstreamHead,
		git,
	);
	if (exclude.length === 0) return { shas, merges };
	const base = analyzedHead ?? upstreamHead;
	let kept = shas;
	let keptMerges = merges;
	for (const ref of exclude) {
		// Right-only of `ref...head` lists the commits head carries WITHOUT the ref:
		// the not-covered set. Keeping only those removes everything the ref covers.
		const keep = new Set(
			await revList(
				["--no-merges", "--cherry-pick", "--right-only", `${ref}...${head}`],
				cachePath,
				git,
			),
		);
		const stillMerges = new Set(
			await revList(
				["--merges", `${base}..${head}`, `^${ref}`],
				cachePath,
				git,
			),
		);
		kept = kept.filter((s) => keep.has(s));
		keptMerges = keptMerges.filter((m) => stillMerges.has(m));
	}
	return { shas: kept, merges: keptMerges };
}

function errSnippet(e: string, code: number, stderr: string): Error {
	return new Error(`${e} failed (${code}): ${stderr.slice(0, 300)}`);
}

/** Parses `git show --format=%H%x00%s` output into a ForkCommit. */
function parseShow(out: string): {
	sha: string;
	subject: string;
	patch: string;
} | null {
	const nl = out.indexOf("\n");
	const header = nl < 0 ? out : out.slice(0, nl);
	const i = header.indexOf("\0");
	if (i < 0) return null;
	const sha = header.slice(0, i);
	const subject = header.slice(i + 1);
	const rest = nl < 0 ? "" : out.slice(nl + 1);
	const lines = rest.split("\n");
	const patchStart = lines.findIndex((l) => l.startsWith("diff --git "));
	const patch = stripInvisible(
		(patchStart < 0 ? [] : lines.slice(patchStart)).join("\n"),
	).text;
	return { sha, subject, patch };
}

/**
 * One upstream fetch into the cache plus the full ForkRange for the pending branches. Commits
 * an exclude entry (an open PR) covers become unreleased hold rows attributed to the first
 * entry (ascending `n`) that covers them, keyed by branch hash; released shas ride the range
 * as extra commits, and the ones the upstream intersection drops land in `filteredReleased`.
 * Coverage uses the cache refs `prRef(n)`, which the watcher fetched beforehand.
 */
export async function collectRange(o: {
	cachePath: string;
	mainPath: string;
	fork: ForkInfo;
	branches: Array<{
		branchHash: string;
		branch: string;
		head: string;
		analyzedHead: string | null;
		/** The branch's released hold shas; they ride this range as extra commits. */
		released?: string[];
	}>;
	git: GitFn;
	exclude?: Array<{ n: number; head: string }>;
}): Promise<{
	range: ForkRange;
	/** Newly covered commits per branch hash, to store as unreleased hold rows. */
	holds: Map<string, Array<{ sha: string; pr: number; prHead: string }>>;
	/** Released shas per branch hash that the upstream intersection dropped. */
	filteredReleased: Map<string, string[]>;
}> {
	const { cachePath, mainPath, fork, branches, git } = o;
	const holds = new Map<
		string,
		Array<{ sha: string; pr: number; prHead: string }>
	>();
	const filteredReleased = new Map<string, string[]>();
	const fetchUp = await git(
		[
			"-c",
			"credential.helper=",
			"-c",
			"protocol.allow=never",
			"-c",
			"protocol.https.allow=always",
			// The upstream remote is the operator's own local project path, not network data.
			"-c",
			"protocol.file.allow=always",
			"-c",
			"fetch.fsckObjects=true",
			"-c",
			"transfer.fsckObjects=true",
			"fetch",
			"--no-tags",
			"--no-recurse-submodules",
			mainPath,
			"+HEAD:refs/heads/upstream",
		],
		cachePath,
		FORK_GATES.FETCH_TIMEOUT_MS,
	);
	if (fetchUp.code !== 0)
		throw errSnippet("upstream fetch", fetchUp.code, fetchUp.stderr);
	const up = await git(["rev-parse", "refs/heads/upstream"], cachePath, 10_000);
	if (up.code !== 0) throw errSnippet("rev-parse upstream", up.code, up.stderr);
	const upstreamHead = up.stdout.trim();

	const bySha = new Map<string, ForkCommit>();
	const commits: ForkCommit[] = [];
	const merges: ForkCommit[] = [];
	for (const b of branches) {
		const raw = await rawRange(
			cachePath,
			b.analyzedHead,
			b.head,
			upstreamHead,
			git,
		);
		let shas = raw.shas;
		let mergeShas = raw.merges;
		const isAncestor = async (a: string, tip: string) => {
			const r = await git(
				["merge-base", "--is-ancestor", a, tip],
				cachePath,
				60_000,
			);
			return r.code === 0;
		};
		const branchFiltered: string[] = [];
		const extras = (b.released ?? []).filter((s) => !shas.includes(s));
		for (const s of extras) {
			if (b.analyzedHead === null) continue;
			// A released commit inside the head's history reads the window set; one the
			// PR dropped (outside it) is invisible to the window and is judged against
			// upstream directly.
			const arrived = (await isAncestor(s, b.head))
				? !raw.up.has(s)
				: await isAncestor(s, upstreamHead);
			// Dropped by the upstream check: the content reached upstream some other way.
			if (arrived) branchFiltered.push(s);
		}
		shas = [...shas, ...extras.filter((s) => !branchFiltered.includes(s))];
		// Attribute each commit an exclude entry covers to the first entry, ascending n.
		const branchHolds: Array<{ sha: string; pr: number; prHead: string }> = [];
		const base = b.analyzedHead ?? upstreamHead;
		for (const e of [...(o.exclude ?? [])].sort((a, z) => a.n - z.n)) {
			// Right-only of `e.head...b.head` is the NOT-covered set for commits in the
			// branch head's history. A commit outside that history (a released commit
			// the PR dropped) is invisible to the window, so it is judged directly
			// against the PR head with merge-base.
			const notCovered = new Set(
				await revList(
					[
						"--no-merges",
						"--cherry-pick",
						"--right-only",
						`${e.head}...${b.head}`,
					],
					cachePath,
					git,
				),
			);
			const keptMerges = new Set(
				await revList(
					["--merges", `${base}..${b.head}`, `^${e.head}`],
					cachePath,
					git,
				),
			);
			for (const s of shas) {
				const covered = (await isAncestor(s, b.head))
					? !notCovered.has(s)
					: await isAncestor(s, e.head);
				if (covered) branchHolds.push({ sha: s, pr: e.n, prHead: e.head });
			}
			shas = shas.filter((s) => !branchHolds.some((h) => h.sha === s));
			for (const m of mergeShas) {
				if (!keptMerges.has(m))
					branchHolds.push({ sha: m, pr: e.n, prHead: e.head });
			}
			mergeShas = mergeShas.filter((m) => keptMerges.has(m));
		}
		holds.set(b.branchHash, branchHolds);
		if (branchFiltered.length > 0)
			filteredReleased.set(b.branchHash, branchFiltered);
		for (const sha of shas) {
			const r = await git(
				[
					"show",
					"--format=%H%x00%s",
					"--numstat",
					"--patch",
					"--no-textconv",
					"--no-ext-diff",
					sha,
				],
				cachePath,
				60_000,
			);
			if (r.code !== 0) throw errSnippet(`git show ${sha}`, r.code, r.stderr);
			const p = parseShow(r.stdout);
			if (!p) continue;
			const numstat = r.stdout
				.split("\n")
				.filter((l) => /^(\d+|-)\t(\d+|-)\t/.test(l));
			let existing = bySha.get(sha);
			if (!existing) {
				const n = (i: number) =>
					numstat.reduce(
						(a, l) =>
							a + (l.split("\t")[i] === "-" ? 0 : Number(l.split("\t")[i])),
						0,
					);
				existing = {
					sha,
					subject: p.subject,
					files: numstat.length,
					plus: n(0),
					minus: n(1),
					patch: p.patch,
					branches: [],
				};
				bySha.set(sha, existing);
				commits.push(existing);
			}
			if (!existing.branches.includes(b.branch))
				existing.branches.push(b.branch);
		}
		for (const sha of mergeShas) {
			if (bySha.has(sha)) {
				const m = bySha.get(sha)!;
				if (!m.branches.includes(b.branch)) m.branches.push(b.branch);
				continue;
			}
			let r = await git(
				["show", "--remerge-diff", "--format=%H%x00%s", sha],
				cachePath,
				60_000,
			);
			if (r.code !== 0)
				r = await git(
					["show", "--format=%H%x00%s", "--cc", sha],
					cachePath,
					60_000,
				);
			if (r.code !== 0) throw errSnippet(`git show ${sha}`, r.code, r.stderr);
			const p = parseShow(r.stdout);
			if (!p) continue;
			const m: ForkCommit = {
				sha,
				subject: p.subject,
				files: 0,
				plus: 0,
				minus: 0,
				patch: p.patch,
				branches: [b.branch],
			};
			bySha.set(sha, m);
			merges.push(m);
		}
	}

	const list = async (args: string[], cap: number) => {
		const r = await git(args, cachePath, 60_000);
		if (r.code !== 0) throw errSnippet(args[0] ?? "git", r.code, r.stderr);
		return r.stdout.split("\n").filter(Boolean).slice(0, cap);
	};
	const firstBranch = branches[0];
	// Commits UPSTREAM has that the fork's first branch lacks: what the fork is behind on
	// (the comparison evidence), not the fork-side list the range already carries.
	const upstreamCommits =
		firstBranch === undefined
			? []
			: (
					await list(
						[
							"rev-list",
							"--no-merges",
							"--format=%h %s",
							`refs/heads/${firstBranch.branchHash}..upstream`,
						],
						400,
					)
				)
					.filter((l) => !l.startsWith("commit "))
					.slice(0, 200);
	const upstreamFiles = await list(
		["ls-tree", "-r", "--name-only", "upstream"],
		500,
	);
	const docNames = upstreamFiles.filter((f) =>
		/^(README[^/]*\.md|LICENSE[^/]*|COPYING[^/]*)$/.test(f),
	);
	let upstreamDocs = "";
	for (const f of docNames) {
		if (upstreamDocs.length >= 8000) break;
		const r = await git(["show", `upstream:${f}`], cachePath, 60_000);
		if (r.code !== 0) continue;
		upstreamDocs += `${r.stdout.slice(0, 8000 - upstreamDocs.length)}\n`;
	}
	return {
		range: {
			fork,
			commits,
			merges,
			upstreamCommits,
			upstreamFiles,
			upstreamDocs,
			heads: branches.map((b) => ({
				branchHash: b.branchHash,
				branch: b.branch,
				head: b.head,
			})),
		},
		holds,
		filteredReleased,
	};
}

export interface ForkProject {
	name: string;
	path: string;
	store: ProjectStore;
	github: string | null;
}

const capStrings = (a: string[]) => a.slice(0, 50).map((s) => s.slice(0, 200));

/** Prior fork-research titles and declines the model should not repeat. */
async function buildPrior(store: ProjectStore): Promise<{
	titles: string[];
	declines: string[];
}> {
	const tasks = await store.listTasks();
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const titles: string[] = [];
	const declines: string[] = [];
	for (const t of tasks) {
		if (!t.followUpOf) continue;
		const parent = byId.get(t.followUpOf);
		if (!parent || parent.topic !== "fork research") continue;
		if (t.cancelledAt !== null) {
			if (t.needsReason) declines.push(t.needsReason);
		} else if (t.title) titles.push(t.title);
	}
	return { titles: capStrings(titles), declines: capStrings(declines) };
}

/** Open held proposals from retros and fork research; the board caps these at 3. */
async function openProposals(store: ProjectStore): Promise<number> {
	let count = 0;
	for (const task of await store.listTasks()) {
		if (
			!task.cancelledAt &&
			task.state === "needs_you" &&
			isProposalReason(task.needsReason) &&
			(await store.listTurns(task.id)).length === 0
		)
			count++;
	}
	return count;
}

function holdKey(holds: ForkHoldState[]): string {
	return JSON.stringify(
		holds
			.map((h) =>
				JSON.stringify([h.branchHash, h.sha, h.pr, h.prHead, h.released]),
			)
			.sort(),
	);
}

type ForkSnapshot = {
	rows: ForkBranchState[];
	holds: ForkHoldState[];
	bases: Map<string, string | null>;
};

async function readFork(
	store: ProjectStore,
	forkId: number,
): Promise<ForkSnapshot> {
	return store.transaction(async () => {
		const rows = await store.listForkBranches(forkId);
		const holds = await store.listForkHolds(forkId);
		const bases = new Map<string, string | null>();
		for (const row of rows) {
			bases.set(
				row.branchHash,
				await store.legacyForkHoldBase(forkId, row.branchHash),
			);
		}
		return { rows, holds, bases };
	});
}

/** Call only inside a database transaction. External facts belong to this snapshot. */
async function unchangedFork(
	store: ProjectStore,
	forkId: number,
	snapshot: ForkSnapshot,
): Promise<boolean> {
	if (!(await store.getSettings()).forkResearch) return false;
	const current = await readFork(store, forkId);
	return (
		JSON.stringify(current.rows) === JSON.stringify(snapshot.rows) &&
		holdKey(current.holds) === holdKey(snapshot.holds) &&
		snapshot.rows.every(
			(row) =>
				current.bases.get(row.branchHash) ===
				snapshot.bases.get(row.branchHash),
		)
	);
}

export function createForkWatcher(deps: {
	projects: () => Iterable<ForkProject>;
	log: (msg: string) => void;
	gh?: GhFn;
	git?: GitFn;
	analyze?: (
		range: ForkRange,
		prior: { titles: string[]; declines: string[] },
	) => Promise<ForkAnalysisResult>;
	now?: () => number;
}): { tick(opts?: { manual?: string }): Promise<void> } {
	const gh = deps.gh ?? runGh;
	const runGit = deps.git ?? git;
	const analyze =
		deps.analyze ??
		((range: ForkRange, prior: { titles: string[]; declines: string[] }) =>
			analyzeRange(range, prior));
	const now = deps.now ?? Date.now;

	async function scan(opts?: { manual?: string }): Promise<void> {
		const manual = opts?.manual;
		// Fresh iteration per tick: a one-shot iterator (Map#values) would be exhausted after
		// the boot tick and every later tick would silently see zero projects.
		for (const project of deps.projects()) {
			if (manual !== undefined && project.name !== manual) continue;
			const store = project.store;
			if (
				(await store.getSettings()).forkResearch !== true ||
				project.github === null
			)
				continue;
			const repo =
				ownerRepo(`https://github.com/${project.github}.git`) ?? project.github;
			const beforeScan = await store.transaction(async () => {
				const snapshots = new Map<number, ForkSnapshot>();
				for (const row of await store.listAllForkBranches()) {
					if (!snapshots.has(row.forkId))
						snapshots.set(row.forkId, await readFork(store, row.forkId));
				}
				return snapshots;
			});
			let forks: ForkInfo[];
			try {
				forks = await listForks(repo, gh);
			} catch (e) {
				deps.log(`forks: ${project.name}: ${(e as Error).message}`);
				continue;
			}
			const forkIds = forks.map((f) => f.id);
			for (const fork of forks) {
				const observed = await readFork(store, fork.id);
				// Neutral cwd (server-only state dir, OTTR_SERVER_DATA_DIR): ls-remote carries GH_TOKEN
				// via gitEnv, so it must not read a worker-writable repo config (planted credential.helper).
				const { heads, skipped } = await listBranchHeads(
					forkUrl(fork),
					store.serverDir,
					runGit,
				);
				if (skipped > 0)
					deps.log(
						`forks: ${fork.owner}/${fork.name}: skipped ${skipped} branch name(s) git rejects`,
					);
				await store.transaction(async () => {
					if (!(await unchangedFork(store, fork.id, observed))) return;
					const byHash = new Map(observed.rows.map((r) => [r.branchHash, r]));
					for (const [branch, sha] of heads) {
						const bh = branchHash(branch);
						const row = byHash.get(bh);
						if (!row) {
							await store.saveForkBranch({
								forkId: fork.id,
								branchHash: bh,
								branch,
								head: sha,
								analyzedHead: null,
								firstPendingAt: null,
								lastRunAt: null,
								lastError: null,
								retries: 0,
							});
							continue;
						}
						if (row.head === sha) continue;
						const firstPendingAt =
							sha !== row.analyzedHead && row.firstPendingAt === null
								? now()
								: row.firstPendingAt;
						await store.saveForkBranch({
							...row,
							head: sha,
							firstPendingAt: sha === row.analyzedHead ? null : firstPendingAt,
						});
					}
				});
			}
			// Prune only after the project's whole scan succeeded; the fork_branch rows live in
			// this project's own store, so absent ids are this project's vanished forks.
			await store.transaction(async () => {
				if (!(await store.getSettings()).forkResearch) return;
				const keep = new Set(forkIds);
				const currentIds = new Set(
					(await store.listAllForkBranches()).map((row) => row.forkId),
				);
				for (const forkId of currentIds) {
					if (keep.has(forkId)) continue;
					const original = beforeScan.get(forkId);
					if (
						original === undefined ||
						!(await unchangedFork(store, forkId, original))
					)
						keep.add(forkId);
				}
				await store.deleteForkBranchesNotIn([...keep]);
			});
			const isManual = manual !== undefined;
			// One open-pull list per project per tick; a failure stops the project's fork loop
			// before any fork acts on a partial list.
			const projectPulls = new Map<string, PullInfo[]>();
			for (const fork of forks) {
				if ((fork.sizeKb ?? 0) > FORK_GATES.MAX_SIZE_KB) {
					deps.log(
						`forks: ${fork.owner}/${fork.name}: skipped, ${fork.sizeKb} KB over the size gate`,
					);
					continue;
				}
				let snapshot = await readFork(store, fork.id);
				let { rows } = snapshot;
				// Step 1: nothing held and nothing pending — listPulls stays uncalled.
				// (The run's pending recomputes after the re-judge; this check only
				// decides whether PR facts are needed at all.)
				const holdRows = snapshot.holds;
				const heldOrPending =
					holdRows.length > 0 ||
					rows.some((r) => r.head !== null && r.head !== r.analyzedHead);
				if (!heldOrPending) continue;
				// Step 2: one open-pull list per project, on first need; never act on a
				// partial list, so a failure stops the project's whole fork loop.
				let pulls = projectPulls.get(project.name);
				if (pulls === undefined) {
					try {
						pulls = await listPulls(repo, gh);
					} catch (e) {
						deps.log(`forks: ${project.name}: ${(e as Error).message}`);
						break;
					}
					projectPulls.set(project.name, pulls);
				}
				const openByN = new Map(pulls.map((p) => [p.number, p.head]));
				const openNums = [...openByN.keys()].sort((a, z) => a - z);
				const toRow = (h: ForkHoldState) => ({
					sha: h.sha,
					pr: h.pr,
					prHead: h.prHead,
					released: h.released === 1,
				});
				try {
					// Steps 3 and 4 run ungated: the pull refs and the re-judged holds exist
					// before any run gate decides, and hold writes persist even when the run
					// is later gated off or fails.
					// Server-only state dir (OTTR_SERVER_DATA_DIR, docker: ottr-state volume), never the
					// worker-shared OTTR_DATA_DIR or checkout: fork objects and the fetch config must stay
					// out of workers' reach.
					const cachePath = await ensureCache(store.serverDir, fork, runGit);
					// Step 3: pull refs before any judgment, so step 4's merge-base checks
					// always find their objects. Held PRs outside the open list get their ref
					// too: pullState may report them merged with another head, and the proof
					// needs the pr-<n> ref.
					const refNums = new Set<number>([...openByN.keys()]);
					for (const h of holdRows) refNums.add(h.pr);
					if (refNums.size > 0) {
						if (!REPO_RE.test(repo))
							throw new Error(`invalid repo id: ${repo}`);
						await fetchFork(
							cachePath,
							`${githubHost().webBase}/${repo}.git`,
							[...refNums].map((n) => `+refs/pull/${n}/head:${prRef(n)}`),
							runGit,
						);
					}
					// Step 4: re-judge every unreleased hold row against the PR facts.
					const stateCache = new Map<
						number,
						{ merged: boolean; head: string } | null | "error"
					>();
					const prState = async (
						n: number,
					): Promise<{ merged: boolean; head: string } | null | "error"> => {
						const c = stateCache.get(n);
						if (c !== undefined) return c;
						let v: { merged: boolean; head: string } | null | "error";
						try {
							v = await pullState(repo, n, gh);
						} catch (e) {
							deps.log(
								`forks: ${fork.owner}/${fork.name}: pullState ${n}: ${(e as Error).message}`,
							);
							v = "error";
						}
						stateCache.set(n, v);
						return v;
					};
					const isAncestor = async (
						sha: string,
						ref: string,
					): Promise<"covered" | "not" | "fail"> => {
						const r = await runGit(
							["merge-base", "--is-ancestor", sha, ref],
							cachePath,
							60_000,
						);
						if (r.code === 0) return "covered";
						if (r.code === 1) return "not";
						return "fail";
					};
					const holdsByBranch = new Map<string, ForkHoldState[]>();
					for (const h of holdRows) {
						const list = holdsByBranch.get(h.branchHash);
						if (list) list.push(h);
						else holdsByBranch.set(h.branchHash, [h]);
					}
					for (const [bh, branchHolds] of holdsByBranch) {
						const next: Array<{
							sha: string;
							pr: number;
							prHead: string;
							released: boolean;
						}> = [];
						let changed = false;
						// Legacy conversion: the retired cursor hold seeded one row per PR
						// head; the PR's other held commits live between the retired base
						// and the branch head. Expand them once into per-commit rows, so a
						// later release carries the whole held range. A failed expansion
						// keeps the base, and the next tick retries.
						const branchRow = rows.find((r) => r.branchHash === bh);
						const legacyBase = snapshot.bases.get(bh) ?? null;
						let expanded = false;
						let expansionFailed = false;
						if (
							branchRow !== undefined &&
							branchRow.analyzedHead !== null &&
							branchRow.head !== null &&
							legacyBase !== null
						) {
							const seeded = branchHolds.filter((h) => h.released === 0);
							const lr = await runGit(
								["rev-list", `${legacyBase}..${branchRow.head}`],
								cachePath,
								60_000,
							);
							if (lr.code === 0) {
								expanded = true;
								for (const sha of lr.stdout.split("\n").filter(Boolean)) {
									if (branchHolds.some((h) => h.sha === sha)) continue;
									let owner = seeded[0];
									for (const h of seeded) {
										if ((await isAncestor(sha, h.prHead)) === "covered") {
											owner = h;
											break;
										}
									}
									if (owner === undefined) {
										expansionFailed = true;
										break;
									}
									branchHolds.push({
										forkId: fork.id,
										branchHash: bh,
										sha,
										pr: owner.pr,
										prHead: owner.prHead,
										released: 0,
									});
								}
								changed = changed || expanded;
							} else {
								expansionFailed = true;
								deps.log(
									`forks: ${fork.owner}/${fork.name}: legacy hold expansion skipped, missing objects (${lr.stderr.slice(0, 120)})`,
								);
							}
						}
						if (expansionFailed) continue;
						for (const row of branchHolds) {
							if (row.released === 1) {
								next.push(toRow(row));
								continue;
							}
							const cur = openByN.get(row.pr);
							if (cur !== undefined && cur === row.prHead) {
								next.push(toRow(row));
								continue;
							}
							if (cur !== undefined) {
								// Open PR with a new head: coverage re-judge against its pull ref.
								const v = await isAncestor(row.sha, prRef(row.pr));
								if (v === "covered") {
									next.push({ ...toRow(row), prHead: cur });
									changed = true;
									continue;
								}
								if (v === "fail") {
									// Unprovable; leave the row unchanged.
									next.push(toRow(row));
									continue;
								}
							} else {
								const st = await prState(row.pr);
								if (st === "error" || st === null) {
									// gh failure, or GitHub still reports the PR open (a race):
									// leave the row unchanged.
									next.push(toRow(row));
									continue;
								}
								if (st.merged && row.prHead === st.head) {
									// Merged with the held head — a squash merge, or a merge the
									// local checkout has not pulled: drop the row, no analysis.
									changed = true;
									continue;
								}
								if (st.merged) {
									// Merged with another head: coverage proof against the final head.
									const v = await isAncestor(row.sha, prRef(row.pr));
									if (v === "covered") {
										// The final head provably carries the commit: drop the row.
										changed = true;
										continue;
									}
									if (v === "not") {
										next.push({ ...toRow(row), released: true });
										changed = true;
										continue;
									}
									// Unprovable (objects missing): the PR carried the work, drop.
									changed = true;
									continue;
								}
								// Closed unmerged: the row's own PR can no longer carry the sha,
								// so only another open PR head counts as coverage.
							}
							// Not covered by the row's own PR: re-point to the first other open
							// PR head (ascending n) that covers the sha, else release it.
							let repointed = false;
							for (const m of openNums) {
								if (m === row.pr) continue;
								if ((await isAncestor(row.sha, prRef(m))) === "covered") {
									next.push({
										sha: row.sha,
										pr: m,
										prHead: openByN.get(m)!,
										released: false,
									});
									changed = true;
									repointed = true;
									break;
								}
							}
							if (!repointed) {
								next.push({ ...toRow(row), released: true });
								changed = true;
							}
						}
						if (changed) {
							const applied = await store.transaction(async () => {
								if (!(await unchangedFork(store, fork.id, snapshot)))
									return false;
								await store.setForkHolds(fork.id, bh, next);
								if (expanded) await store.clearLegacyForkHoldBase(fork.id, bh);
								snapshot = await readFork(store, fork.id);
								return true;
							});
							if (!applied) break;
						}
					}
					// An incomplete legacy expansion must not advance its checkpoint.
					if ([...snapshot.bases.values()].some((base) => base !== null))
						continue;
					// Step 5: pending = a moved head OR released hold rows; released commits
					// are pending analysis work and reach the gated run without a new push.
					// Recomputed after the re-judge: its releases make branches pending.
					rows = snapshot.rows;
					const curHolds = snapshot.holds;
					const pending = rows.filter(
						(r) =>
							(r.head !== null && r.head !== r.analyzedHead) ||
							curHolds.some(
								(h) => h.branchHash === r.branchHash && h.released === 1,
							),
					);
					if (pending.length === 0) continue;
					// The run gates, exactly in the base order.
					const lastRun = Math.max(0, ...rows.map((r) => r.lastRunAt ?? 0));
					if (lastRun + FORK_GATES.FORK_RUN_SPACING_MS > now()) continue;
					if (!isManual && pending.every((r) => r.retries >= 3)) continue;
					if (
						!isManual &&
						!pending.some(
							(r) =>
								// A brand-new branch (firstPendingAt null) has waited its whole life.
								r.firstPendingAt === null ||
								r.firstPendingAt <= now() - FORK_GATES.QUIET_MS ||
								r.firstPendingAt <= now() - FORK_GATES.MAX_WAIT_MS,
						)
					)
						continue;
					if (
						(await store.forkRunsSince(
							now() - FORK_GATES.FORK_RUN_SPACING_MS,
						)) >= FORK_GATES.PROJECT_DAILY_RUNS
					) {
						deps.log(
							`forks: ${project.name}: daily cap of ${FORK_GATES.PROJECT_DAILY_RUNS} runs reached, stopping analysis`,
						);
						break;
					}
					// Step 6: the pending branches' own refspecs, inside the gated run section.
					await fetchFork(
						cachePath,
						forkUrl(fork),
						pending.map(
							(r) => `+refs/heads/${r.branch}:refs/heads/${r.branchHash}`,
						),
						runGit,
					);
					// Step 7: the range, with the open pulls and each branch's released shas
					// excluded from analysis (holds re-read once at step 5, after the
					// re-judge).
					const releasedByBranch = new Map<string, string[]>();
					for (const h of curHolds) {
						if (h.released !== 1) continue;
						const list = releasedByBranch.get(h.branchHash);
						if (list) list.push(h.sha);
						else releasedByBranch.set(h.branchHash, [h.sha]);
					}
					const {
						range,
						holds: newHolds,
						filteredReleased,
					} = await collectRange({
						cachePath,
						mainPath: project.path,
						fork,
						branches: pending.map((r) => ({
							branchHash: r.branchHash,
							branch: r.branch,
							head: r.head!,
							analyzedHead: r.analyzedHead,
							released: releasedByBranch.get(r.branchHash) ?? [],
						})),
						git: runGit,
						exclude: pulls.map((p) => ({ n: p.number, head: p.head })),
					});
					// Merges the step-7 holds over a branch's surviving rows. Released rows
					// survive only when `keepReleased` says so; filteredReleased rows never do.
					const mergeRows = (
						bh: string,
						keepReleased: (h: ForkHoldState) => boolean,
					): Array<{
						sha: string;
						pr: number;
						prHead: string;
						released: boolean;
					}> => {
						const dropped = filteredReleased.get(bh) ?? [];
						const next = new Map<
							string,
							{ sha: string; pr: number; prHead: string; released: boolean }
						>();
						for (const h of curHolds) {
							if (h.branchHash !== bh || dropped.includes(h.sha)) continue;
							const isReleased = h.released === 1;
							if (isReleased && !keepReleased(h)) continue;
							next.set(h.sha, {
								sha: h.sha,
								pr: h.pr,
								prHead: h.prHead,
								released: isReleased,
							});
						}
						for (const nh of newHolds.get(bh) ?? []) {
							next.set(nh.sha, {
								sha: nh.sha,
								pr: nh.pr,
								prHead: nh.prHead,
								released: false,
							});
						}
						return [...next.values()];
					};
					// Step 8: every pending branch's filtered range is empty — hold the
					// covered commits, advance the cursors, and skip the run entirely.
					if (range.commits.length === 0 && range.merges.length === 0) {
						await store.transaction(async () => {
							if (!(await unchangedFork(store, fork.id, snapshot))) return;
							for (const r of pending) {
								await store.setForkHolds(
									fork.id,
									r.branchHash,
									mergeRows(r.branchHash, () => false),
								);
								await store.saveForkBranch({
									...r,
									analyzedHead: r.head,
									firstPendingAt: null,
									lastError: null,
									retries: 0,
								});
							}
						});
						continue;
					}
					// Step 9.
					const claim = await store.transaction(async () => {
						if (!(await unchangedFork(store, fork.id, snapshot))) return false;
						const at = now();
						if (
							(await store.forkRunsSince(
								at - FORK_GATES.FORK_RUN_SPACING_MS,
							)) >= FORK_GATES.PROJECT_DAILY_RUNS
						)
							return false;
						if (
							Math.max(0, ...snapshot.rows.map((r) => r.lastRunAt ?? 0)) +
								FORK_GATES.FORK_RUN_SPACING_MS >
							at
						)
							return false;
						await store.recordForkRun(fork.id, at);
						for (const row of pending)
							await store.saveForkBranch({ ...row, lastRunAt: at });
						snapshot = await readFork(store, fork.id);
						return true;
					});
					if (!claim) continue;
					const result = await analyze(range, await buildPrior(store));
					// Step 10: cursors and the consumed released rows.
					const covered = new Set(result.commits);
					const analyzed: Array<{
						forkId: number;
						branchHash: string;
						head: string;
						at: number;
						consumed?: string[];
					}> = [];
					if (result.deferred.length > 0)
						deps.log(
							`forks: ${fork.owner}/${fork.name}: deferred ${result.deferred.length} commit(s), cursor stays on the last covered sha`,
						);
					for (const h of range.heads) {
						const branchCommits = range.commits.filter((c) =>
							c.branches.includes(h.branch),
						);
						let cursor: string;
						if (branchCommits.length === 0) {
							// The branch's work is all held: forward to the observed head.
							cursor = h.head;
						} else if (result.deferred.length > 0) {
							let last: string | null = null;
							for (const c of branchCommits) {
								if (covered.has(c.sha)) last = c.sha;
							}
							if (last === null) continue; // nothing covered yet: retried next tick
							cursor = last;
						} else {
							cursor = h.head;
						}
						// Released∩covered rows ride to createForkResult: its transaction is
						// their only deletion point, so a failed card creation cannot lose them.
						const consumed = (releasedByBranch.get(h.branchHash) ?? []).filter(
							(s) => covered.has(s),
						);
						// The final transaction installs these holds with the result.
						analyzed.push({
							forkId: fork.id,
							branchHash: h.branchHash,
							head: cursor,
							at: now(),
							consumed,
						});
					}
					const rangeLabel = range.heads
						.map((h) => `${h.branch}:${h.head.slice(0, 7)}`)
						.join(", ");
					let prompt = `Server-generated fork research result for ${fork.owner}/${fork.name}. The report holds the commit, feature, and verdict tables. Range: ${rangeLabel}.`;
					if (prompt.length > 500) prompt = prompt.slice(0, 500);
					const title = `Fork research: ${fork.owner}/${fork.name} (${range.commits.length} new commits)`;
					const proposals = result.proposals.slice(0, 5).map((p) => ({
						prompt: proposalPrompt(fork.owner, fork.name, p),

						model: null,
					}));
					const report = renderReport(range, result);
					const dropped = await store.transaction(async () => {
						if (!(await unchangedFork(store, fork.id, snapshot))) return false;
						for (const branch of analyzed) {
							await store.setForkHolds(
								fork.id,
								branch.branchHash,
								mergeRows(branch.branchHash, (rel) => covered.has(rel.sha)),
							);
						}
						const open = await openProposals(store);
						const kept = proposals.slice(0, Math.max(0, 3 - open));
						await store.createForkResult({
							prompt,
							title,
							report,
							topic: "fork research",
							proposals: kept,
							analyzed,
						});
						return kept.length < proposals.length;
					});
					if (dropped)
						deps.log(
							`forks: ${fork.owner}/${fork.name}: proposal(s) dropped: cap of 3 open proposals reached`,
						);
				} catch (e) {
					const msg = ((e as Error).message ?? String(e)).slice(0, 300);
					await store.transaction(async () => {
						if (!(await unchangedFork(store, fork.id, snapshot))) return;
						for (const r of snapshot.rows.filter(
							(x) => x.head !== null && x.head !== x.analyzedHead,
						)) {
							await store.saveForkBranch({
								...r,
								retries: r.retries + 1,
								lastError: msg,
								lastRunAt: now(),
							});
						}
					});
					deps.log(`forks: ${fork.owner}/${fork.name}: ${msg}`);
				}
			}
		}
	}

	return { tick: singleFlightTick(scan) };
}

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	analyzeRange,
	proposalPrompt,
	renderReport,
	stripInvisible,
} from "./forkAnalysis.ts";
import {
	FORK_PROPOSED_REASON_PREFIX,
	forkProposedReason,
	PROPOSED_REASON_PREFIX,
} from "./prompts.ts";
import { ownerRepo, runGh } from "./release.ts";
import type { ProjectStore } from "./store.ts";
import type {
	ForkAnalysisResult,
	ForkCommit,
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
	return `https://github.com/${f.owner}/${f.name}.git`;
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

/**
 * Non-merge new work of one branch: exact-SHA intersection of the analysis-base and upstream
 * comparisons, so rewritten commits already analyzed count as new only when they carry work
 * upstream lacks.
 */
export async function rangeCommits(
	cachePath: string,
	analyzedHead: string | null,
	head: string,
	upstreamHead: string,
	git: GitFn,
): Promise<{ shas: string[]; merges: string[] }> {
	const base = analyzedHead ?? upstreamHead;
	const run = (args: string[]) =>
		git(["rev-list", ...args], cachePath, 60_000).then((r) => {
			if (r.code !== 0)
				throw new Error(
					`rev-list failed (${r.code}): ${r.stderr.slice(0, 300)}`,
				);
			return r.stdout.split("\n").filter(Boolean);
		});
	const fromAnalysis = await run([
		"--no-merges",
		"--cherry-pick",
		"--right-only",
		`${base}...${head}`,
	]);
	let shas = fromAnalysis;
	if (analyzedHead !== null) {
		const fromUpstream = await run([
			"--no-merges",
			"--cherry-pick",
			"--right-only",
			`${upstreamHead}...${head}`,
		]);
		const up = new Set(fromUpstream);
		shas = fromAnalysis.filter((s) => up.has(s));
	}
	const merges = await run(["--merges", `${base}..${head}`]);
	return { shas, merges };
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

/** One upstream fetch into the cache plus the full ForkRange for the pending branches. */
export async function collectRange(o: {
	cachePath: string;
	mainPath: string;
	fork: ForkInfo;
	branches: Array<{
		branchHash: string;
		branch: string;
		head: string;
		analyzedHead: string | null;
	}>;
	git: GitFn;
}): Promise<ForkRange> {
	const { cachePath, mainPath, fork, branches, git } = o;
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
		const { shas, merges: mergeShas } = await rangeCommits(
			cachePath,
			b.analyzedHead,
			b.head,
			upstreamHead,
			git,
		);
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
function buildPrior(store: ProjectStore): {
	titles: string[];
	declines: string[];
} {
	const tasks = store.listTasks();
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
function openProposals(store: ProjectStore): number {
	return store
		.listTasks()
		.filter(
			(x) =>
				!x.cancelledAt &&
				x.state === "needs_you" &&
				((x.needsReason ?? "").startsWith(PROPOSED_REASON_PREFIX) ||
					(x.needsReason ?? "").startsWith(FORK_PROPOSED_REASON_PREFIX)) &&
				store.listTurns(x.id).length === 0,
		).length;
}

// One watcher at a time: a second concurrent tick is a no-op, not a queue.
let inFlight: Promise<void> | null = null;

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
			if (store.getSettings().forkResearch !== true || project.github === null)
				continue;
			const repo =
				ownerRepo(`https://github.com/${project.github}.git`) ?? project.github;
			let forks: ForkInfo[];
			try {
				forks = await listForks(repo, gh);
			} catch (e) {
				deps.log(`forks: ${project.name}: ${(e as Error).message}`);
				continue;
			}
			const forkIds = forks.map((f) => f.id);
			for (const fork of forks) {
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
				const rows = store
					.listAllForkBranches()
					.filter((r) => r.forkId === fork.id);
				const byHash = new Map(rows.map((r) => [r.branchHash, r]));
				for (const [branch, sha] of heads) {
					const bh = branchHash(branch);
					const row = byHash.get(bh);
					if (!row) {
						store.saveForkBranch({
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
					if (sha === row.analyzedHead) {
						store.saveForkBranch({ ...row, head: sha, firstPendingAt: null });
					} else {
						store.saveForkBranch({ ...row, head: sha, firstPendingAt });
					}
				}
			}
			// Prune only after the project's whole scan succeeded; the fork_branch rows live in
			// this project's own store, so absent ids are this project's vanished forks.
			store.deleteForkBranchesNotIn(forkIds);

			const fresh = store.listAllForkBranches();
			const isManual = manual !== undefined;
			for (const fork of forks) {
				if ((fork.sizeKb ?? 0) > FORK_GATES.MAX_SIZE_KB) {
					deps.log(
						`forks: ${fork.owner}/${fork.name}: skipped, ${fork.sizeKb} KB over the size gate`,
					);
					continue;
				}
				const rows = fresh.filter((r) => r.forkId === fork.id);
				const pending = rows.filter(
					(r) => r.head !== null && r.head !== r.analyzedHead,
				);
				if (pending.length === 0) continue;
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
					store.forkRunsSince(now() - FORK_GATES.FORK_RUN_SPACING_MS) >=
					FORK_GATES.PROJECT_DAILY_RUNS
				) {
					deps.log(
						`forks: ${project.name}: daily cap of ${FORK_GATES.PROJECT_DAILY_RUNS} runs reached, stopping analysis`,
					);
					break;
				}
				store.recordForkRun(fork.id, now());
				try {
					// Server-only state dir (OTTR_SERVER_DATA_DIR, docker: ottr-state volume), never the
					// worker-shared OTTR_DATA_DIR or checkout: fork objects and the fetch config must stay
					// out of workers' reach.
					const cachePath = await ensureCache(store.serverDir, fork, runGit);
					const refspecs = pending.map(
						(r) => `+refs/heads/${r.branch}:refs/heads/${r.branchHash}`,
					);
					await fetchFork(cachePath, forkUrl(fork), refspecs, runGit);
					const range = await collectRange({
						cachePath,
						mainPath: project.path,
						fork,
						branches: pending.map((r) => ({
							branchHash: r.branchHash,
							branch: r.branch,
							head: r.head!,
							analyzedHead: r.analyzedHead,
						})),
						git: runGit,
					});
					const result = await analyze(range, buildPrior(store));
					const covered = new Set(result.commits);
					const analyzed: Array<{
						forkId: number;
						branchHash: string;
						head: string;
						at: number;
					}> = [];
					if (result.deferred.length > 0) {
						deps.log(
							`forks: ${fork.owner}/${fork.name}: deferred ${result.deferred.length} commit(s), cursor stays on the last covered sha`,
						);
						for (const h of range.heads) {
							let last: string | null = null;
							for (const c of range.commits) {
								if (covered.has(c.sha) && c.branches.includes(h.branch))
									last = c.sha;
							}
							if (last)
								analyzed.push({
									forkId: fork.id,
									branchHash: h.branchHash,
									head: last,
									at: now(),
								});
						}
					} else {
						for (const h of range.heads)
							analyzed.push({
								forkId: fork.id,
								branchHash: h.branchHash,
								head: h.head,
								at: now(),
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
						needsReason: forkProposedReason(
							`Fork research: ${fork.owner}/${fork.name}`,
						),
						model: null,
					}));
					const open = openProposals(store);
					const kept =
						open >= 3
							? (deps.log(
									`forks: ${fork.owner}/${fork.name}: proposal(s) dropped: cap of 3 open proposals reached`,
								),
								[])
							: proposals;
					store.createForkResult({
						prompt,
						title,
						report: renderReport(range, result),
						topic: "fork research",
						proposals: kept,
						analyzed,
					});
				} catch (e) {
					const msg = ((e as Error).message ?? String(e)).slice(0, 300);
					for (const r of store
						.listAllForkBranches()
						.filter(
							(x) =>
								x.forkId === fork.id &&
								x.head !== null &&
								x.head !== x.analyzedHead,
						)) {
						store.saveForkBranch({
							...r,
							retries: r.retries + 1,
							lastError: msg,
							lastRunAt: now(),
						});
					}
					deps.log(`forks: ${fork.owner}/${fork.name}: ${msg}`);
				}
			}
		}
	}

	return {
		tick(opts?: { manual?: string }): Promise<void> {
			if (inFlight !== null) return Promise.resolve();
			inFlight = (async () => {
				try {
					await scan(opts);
				} finally {
					inFlight = null;
				}
			})();
			return inFlight;
		},
	};
}

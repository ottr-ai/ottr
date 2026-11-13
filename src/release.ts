import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghEnvFor, githubHost } from "./githubHost.ts";
import { platform } from "./platform/index.ts";
import { type ReviewTask, reviewBlocked } from "./scheduler.ts";
import type { LateCommit, LatestImage, ReleasePlan, Task } from "./types.ts";
import { VERSION_RE } from "./types.ts";
import {
	checkPinnedRemote,
	git,
	hostedGitAuth,
	redact,
	spawnPiped,
} from "./worktree.ts";

export interface ConventionalCommit {
	type: string;
	scope: string | null;
	breaking: boolean;
	description: string;
}

/** Types that get a release-notes bullet on their own merit. */
const LISTED: Record<string, true> = {
	feat: true,
	fix: true,
	perf: true,
	refactor: true,
	revert: true,
};
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

/** `type(scope)!: description`; also breaking on a `BREAKING CHANGE:`/`BREAKING-CHANGE:` body line; null otherwise. */
export function parseCommit(
	subject: string,
	body: string,
): ConventionalCommit | null {
	const m = subject.match(/^([a-zA-Z]+)(?:\(([^()]*)\))?(!)?: (.+)$/);
	if (!m) return null;
	const [, type = "", scope, bang = "", description = ""] = m;
	const breakingFooter = body
		.split(/\r?\n/)
		.some((l) => /^BREAKING[ -]CHANGE:/.test(l));
	return {
		type: type.toLowerCase(),
		scope: scope || null,
		breaking: bang === "!" || breakingFooter,
		description,
	};
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Body lines that name a commit by (abbreviated) sha; git's revert line counts as `Reverts:`. */
const TRAILER =
	/^(?:(Supersedes|Reverts|Fixes):\s*|This reverts commit )([0-9a-f]{7,40})\b/gim;

/**
 * Indexes of commits that get no bullet and no version bump.
 * - A `Supersedes:`/`Reverts:` line cancels the named in-range commit, but only while the
 *   canceller itself stays in effect: a revert of a revert, or of a superseding commit,
 *   restores the original.
 * - A non-breaking commit whose `Reverts:`/`Fixes:` lines all name in-range commits folds away:
 *   a revert nets out, a fix joins its feature. One out-of-range target keeps its bullet.
 */
function droppedCommits(
	commits: { sha?: string; subject: string; body: string }[],
): Set<number> {
	const refs = commits.map((c, i) =>
		[...c.body.matchAll(TRAILER)].map(([, kind = "reverts", ref = ""]) => {
			const t = commits.findIndex((o) => o.sha?.startsWith(ref.toLowerCase()));
			return { kind: kind.toLowerCase(), t: t === i ? -1 : t };
		}),
	);
	const memo = new Map<number, boolean>();
	// Sha references only point back in history; the in-progress guard stops a forged cycle.
	const effective = (i: number): boolean => {
		const known = memo.get(i);
		if (known !== undefined) return known;
		memo.set(i, true);
		const cancelled = refs.some(
			(rs, j) =>
				rs.some((r) => r.t === i && r.kind !== "fixes") && effective(j),
		);
		memo.set(i, !cancelled);
		return !cancelled;
	};
	const dropped = new Set<number>();
	for (const [i, c] of commits.entries()) {
		const folds = refs[i]?.filter((r) => r.kind !== "supersedes") ?? [];
		const folded =
			folds.length > 0 &&
			folds.every((r) => r.t >= 0) &&
			!parseCommit(c.subject, c.body)?.breaking;
		if (folded || !effective(i)) dropped.add(i);
	}
	return dropped;
}

/** The semver bump the parsed commits ask for: breaking lifts the major (or the minor before
 * 1.0), a feat lifts the minor, everything else the patch. */
function bumpVersion(
	m: RegExpMatchArray,
	parsed: (ConventionalCommit | null)[],
): string {
	let [x = 0, y = 0, z = 0] = m.slice(1).map(Number);
	if (parsed.some((c) => c?.breaking)) {
		if (x >= 1) {
			x++;
			y = 0;
			z = 0;
		} else {
			y++;
			z = 0;
		}
	} else if (parsed.some((c) => c?.type === "feat")) {
		y++;
		z = 0;
	} else z++;
	return `v${x}.${y}.${z}`;
}

/** The notes heading a commit's bullet lands under: parsed types get their own, the rest Changes. */
function noteSection(c: ConventionalCommit | null): string {
	return c === null
		? "## Changes"
		: c.type === "feat"
			? "## New features"
			: c.type === "fix"
				? "## Bug fixes"
				: "## Changes";
}

/** One bullet per listed commit, in commit order; unlisted types only when breaking; dedupe. */
function buildNotes(
	commits: { subject: string; body: string }[],
	parsed: (ConventionalCommit | null)[],
): { notes: string; releasable: boolean } {
	const sections: Record<string, string[]> = {
		"## New features": [],
		"## Bug fixes": [],
		"## Changes": [],
	};
	const seen = new Set<string>();
	for (const [i, commit] of commits.entries()) {
		const c = parsed[i] ?? null;
		let text: string;
		if (c === null) text = upperFirst(commit.subject.trim());
		else if (!LISTED[c.type] && !c.breaking) continue;
		else text = (c.scope ? `${c.scope}: ` : "") + upperFirst(c.description);
		if (c?.breaking) text = `**Breaking:** ${text}`;
		if (seen.has(text)) continue;
		seen.add(text);
		const section = noteSection(c);
		const list = sections[section] ?? [];
		list.push(text);
		sections[section] = list;
	}
	const notes = Object.entries(sections)
		.filter(([, bullets]) => bullets.length > 0)
		.map(
			([title, bullets]) =>
				`${title}\n\n${bullets.map((b) => `- ${b}`).join("\n")}`,
		)
		.join("\n\n");
	return { notes, releasable: seen.size > 0 };
}

export function computeRelease(
	from: string | null,
	all: { sha?: string; subject: string; body: string }[],
): { version: string; notes: string; releasable: boolean } {
	if (from === null) {
		return {
			version: "v0.1.0",
			notes: "First release.",
			releasable: all.length > 0,
		};
	}
	const m = from.match(SEMVER);
	if (!m) throw new Error(`previous release tag ${from} is not vX.Y.Z`);
	const dropped = droppedCommits(all);
	const commits = all.filter((_, i) => !dropped.has(i));
	const parsed = commits.map((c) => parseCommit(c.subject, c.body));
	const version = bumpVersion(m, parsed);
	const { notes, releasable } = buildNotes(commits, parsed);
	return { version, notes, releasable };
}

/** Highest strictly-semantic `vX.Y.Z` tag among lines. */
export function highestTag(lines: string[]): string | null {
	let best: string | null = null;
	let bestN: readonly [number, number, number] = [0, 0, 0];
	for (const line of lines) {
		const tag = line.trim();
		const m = tag.match(SEMVER);
		if (!m) continue;
		const [maj = 0, min = 0, pat = 0] = m.slice(1).map(Number);
		const n: readonly [number, number, number] = [maj, min, pat];
		// Components are unbounded in theory, so compare pairwise, not by a packed number.
		const higher =
			best === null ||
			(n[0] !== bestN[0]
				? n[0] > bestN[0]
				: n[1] !== bestN[1]
					? n[1] > bestN[1]
					: n[2] > bestN[2]);
		if (higher) {
			best = tag;
			bestN = n;
		}
	}
	return best;
}

/** Ceiling for each ghcr.io fetch inside latestImage: slow endpoints must not hold callers. */
const GHCR_FETCH_TIMEOUT_MS = 20_000;

function isTimeout(e: unknown): boolean {
	return (
		e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
	);
}

/** Clear message for a timeout; ms shapes the seconds shown. */
function timeoutText(ms: number): string {
	return `timed out after ${ms / 1000}s`;
}

/** The anonymous pull token of the image; undefined when ghcr answers without one. */
async function ghcrToken(
	image: string,
	timeoutMs: number,
): Promise<string | undefined> {
	const tokenRes = await fetch(
		`https://ghcr.io/token?scope=repository:${image}:pull&service=ghcr.io`,
		{ signal: AbortSignal.timeout(timeoutMs) },
	).catch((e: unknown) => {
		if (isTimeout(e))
			throw new Error(`ghcr token request ${timeoutText(timeoutMs)}`);
		return null;
	});
	// ghcr's token endpoint: { "token": "..." }; anything else means no public pull.
	try {
		const tokenBody = tokenRes?.ok ? await tokenRes.json() : undefined;
		return typeof tokenBody === "object" &&
			tokenBody !== null &&
			"token" in tokenBody &&
			typeof tokenBody.token === "string"
			? tokenBody.token
			: undefined;
	} catch (e: unknown) {
		if (isTimeout(e))
			throw new Error(`ghcr token request ${timeoutText(timeoutMs)}`);
		throw e;
	}
}

/**
 * The image's tag list; an empty list on every "no chip" answer — the 404 of an absent
 * image, the 401/403 of a private one, and any redirect off ghcr.io.
 */
async function ghcrTags(
	image: string,
	token: string,
	timeoutMs: number,
): Promise<string[]> {
	// n=1000: ghcr pages at 100 tags oldest-first, so a bare call loses the newest tags.
	// ponytail: >1000-tag images truncate; follow Link headers if one ever shows up.
	// redirect: "manual": the bearer must never follow a redirect off ghcr.io;
	// a 3xx answer joins 401/403 as "no chip".
	const tagsRes = await fetch(`https://ghcr.io/v2/${image}/tags/list?n=1000`, {
		headers: { authorization: `Bearer ${token}` },
		redirect: "manual",
		signal: AbortSignal.timeout(timeoutMs),
	}).catch((e: unknown) => {
		if (isTimeout(e))
			throw new Error(`ghcr tags request ${timeoutText(timeoutMs)}`);
		return null;
	});
	// 404 without an image, 401/403 for private ones; both mean "no chip".
	if (!tagsRes?.ok) return [];
	try {
		const tagsBody = await tagsRes.json();
		return typeof tagsBody === "object" &&
			tagsBody !== null &&
			"tags" in tagsBody &&
			Array.isArray(tagsBody.tags)
			? tagsBody.tags
			: [];
	} catch (e: unknown) {
		if (isTimeout(e))
			throw new Error(`ghcr tags request ${timeoutText(timeoutMs)}`);
		throw e;
	}
}

/**
 * Latest `vX.Y.Z` tag of the repo's public ghcr.io image (the "owner/name" image, lowercased),
 * with its package page. Anonymous registry pull (the v2 API), so private or absent images
 * come back null. timeoutMs: per-fetch probe ceiling; tests inject a short one.
 */
export async function latestImage(
	repo: string,
	timeoutMs: number = GHCR_FETCH_TIMEOUT_MS,
): Promise<LatestImage | null> {
	const [owner, name] = repo.split("/");
	if (owner === undefined || name === undefined) return null;
	const image = `${owner}/${name}`.toLowerCase();
	const token = await ghcrToken(image, timeoutMs);
	if (token === undefined) return null;
	const tags = await ghcrTags(image, token, timeoutMs);
	const tag = highestTag(tags);
	return tag === null
		? null
		: {
				tag,
				url: `https://github.com/${owner}/${name}/pkgs/container/${name.toLowerCase()}`,
			};
}

/** The repo's latest GitHub release, as the board shows it (GET .../releases/latest). */
export interface LatestGhRelease {
	/** Display name: the release title, else the tag. Never empty. */
	name: string;
	/** The tag the release points at; null when GitHub omits it. */
	tag: string | null;
	/** Web page of the release; null when GitHub omits it. */
	url: string | null;
	/** True when the tag is `vX.Y.Z`, the only format Ottr's release flow speaks. */
	semver: boolean;
}

/** What runGh answers; injectable so tests feed canned `gh api` replies. */
export type GhReply = { code: number; stdout: string; stderr: string };

/**
 * The repo's latest GitHub release via `gh api repos/<repo>/releases/latest` — the same
 * client as the watchers. Total: any failure (gh missing, unauthenticated, network, the
 * 404 of a repo without releases, a malformed reply) returns null and the caller falls
 * back to tags.
 */
export async function latestGhRelease(
	repo: string,
	gh: (args: string[]) => Promise<GhReply> = runGh,
): Promise<LatestGhRelease | null> {
	let r: GhReply;
	try {
		r = await gh(["api", `repos/${repo}/releases/latest`]);
	} catch {
		return null;
	}
	if (r.code !== 0) return null;
	let body: unknown;
	try {
		body = JSON.parse(r.stdout);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null) return null;
	const x = body as Record<string, unknown>;
	const tag = typeof x.tag_name === "string" ? x.tag_name.trim() : "";
	const title = typeof x.name === "string" ? x.name.trim() : "";
	if (tag === "" && title === "") return null;
	return {
		name: title === "" ? tag : title,
		tag: tag === "" ? null : tag,
		url:
			typeof x.html_url === "string" && x.html_url !== "" ? x.html_url : null,
		semver: tag !== "" && VERSION_RE.test(tag),
	};
}

// The latest-release probe feeds the chip every scheduler tick and the release dialog;
// one GitHub call per repo per TTL (the image chip's cadence in server.ts).
const LATEST_TTL = 15 * 60_000;
const latestCache = new Map<
	string,
	{ at: number; value: LatestGhRelease | null }
>();

/** Cached latest GitHub release, one probe per repo per TTL; a failed probe seeds null until the next TTL. */
export async function cachedLatestGhRelease(
	repo: string,
): Promise<LatestGhRelease | null> {
	const cached = latestCache.get(repo);
	if (cached !== undefined && Date.now() - cached.at < LATEST_TTL)
		return cached.value;
	// Seed before fetching so a hung probe cannot stack one request per tick.
	latestCache.set(repo, { at: Date.now(), value: null });
	const value = await latestGhRelease(repo);
	latestCache.set(repo, { at: Date.now(), value });
	return value;
}

/** The release chip's fact: the shown release text and the page it links (null = releases/tag link). */
export interface ReleaseChip {
	release: string | null;
	url: string | null;
}

/**
 * The project's latest release for the chip: the repo's latest GitHub release when the
 * project has a GitHub remote and GitHub answers, else the highest `vX.Y.Z` tag merged
 * into the target — the no-GitHub state and the degraded state while GitHub is
 * unreachable. A vX.Y.Z release keeps the tag-text chip; any other release shows its own
 * name and links its page, so a merged vX.Y.Z tag never poses as the current release.
 */
export async function releaseChip(o: {
	/** "owner/name" of the project's GitHub remote; null when it has none. */
	repo: string | null;
	mainPath: string;
	target: string | null;
	latest?: (repo: string) => Promise<LatestGhRelease | null>;
}): Promise<ReleaseChip> {
	if (o.target === null) return { release: null, url: null };
	if (o.repo !== null) {
		const gh = await (o.latest ?? cachedLatestGhRelease)(o.repo);
		if (gh !== null)
			return gh.semver
				? { release: gh.tag, url: null }
				: { release: gh.name, url: gh.url };
	}
	const r = await git(
		["tag", "--list", "v*", "--merged", o.target],
		o.mainPath,
	).catch(() => null);
	return {
		release: r?.code === 0 ? highestTag(r.stdout.split("\n")) : null,
		url: null,
	};
}

/** The task fields includedTasks reads. */
type IncludableTask = Pick<
	Task,
	| "id"
	| "title"
	| "stage"
	| "cancelledAt"
	| "releaseVersion"
	| "doneAt"
	| "commits"
>;

/** Done, not cancelled, not yet in a release, and merged at a known time. */
function isUnreleasedDone(t: IncludableTask): t is IncludableTask & {
	doneAt: number;
} {
	return (
		t.stage === "done" &&
		t.cancelledAt === null &&
		t.releaseVersion === null &&
		t.doneAt !== null
	);
}

/**
 * Done tasks whose work is in the next release: merged after `since` (the last release tag's commit
 * time; 0 before the first release). Cards that moved the target by zero commits (question-only or
 * answer-only tasks) are dropped via the per-task target-commits counter; unmeasured counts keep the
 * task rather than silently hiding it.
 */
export function includedTasks(
	tasks: IncludableTask[],
	since: number,
): { id: string; title: string }[] {
	const done = tasks
		.filter(isUnreleasedDone)
		.sort((a, b) => a.doneAt - b.doneAt);
	// The last task merged before `since` saw the target at count(from), so its counter is the
	// delta baseline; from there each task's delta is its own work (merges are serialized).
	let prev: number = done.filter((t) => t.doneAt <= since).at(-1)?.commits ?? 0;
	const out: { id: string; title: string }[] = [];
	for (const t of done) {
		if (t.doneAt <= since) continue;
		if (t.commits === null || t.commits > prev)
			out.push({ id: t.id, title: t.title });
		if (t.commits !== null) prev = t.commits;
	}
	return out;
}

async function hasOrigin(mainPath: string): Promise<boolean> {
	const r = await git(["remote"], mainPath);
	return r.stdout.split("\n").includes("origin");
}

/** Why Create release can't start now, else null. Pure release policy over one project's task
 * list; `releaseCommand` is the project setting of the same name. */
export function releaseBlocked(
	tasks: readonly (ReviewTask & Pick<Task, "state">)[],
	releaseCommand: string | null,
): string | null {
	// One review at a time: a release runs the same review the Review button starts.
	const review = reviewBlocked(tasks);
	if (review !== null) return review;
	const live = tasks.filter((t) => t.cancelledAt === null);
	// A release command fast-forwards main from the reviewed commit: a merge landing meanwhile would break it.
	if (
		releaseCommand !== null &&
		live.some(
			(t) =>
				t.stage === "merging" &&
				(t.state === "running" || t.state === "preparing"),
		)
	) {
		return "A merge is running. Start the release when it is done.";
	}
	return null;
}

/** The commit the release reads at, and why it is not on the target, else null. */
async function resolveSha(
	mainPath: string,
	target: string,
	wanted: string,
): Promise<{ sha: string; blocked: string | null }> {
	const v = await git(
		["rev-parse", "--verify", "--quiet", `${wanted}^{commit}`],
		mainPath,
	);
	if (v.code !== 0)
		return {
			sha: wanted,
			blocked: `Commit ${wanted.slice(0, 7)} is not on ${target}.`,
		};
	const sha = v.stdout.trim();
	const anc = await git(["merge-base", "--is-ancestor", sha, target], mainPath);
	return {
		sha,
		blocked:
			anc.code !== 0 ? `Commit ${sha.slice(0, 7)} is not on ${target}.` : null,
	};
}

/** The commits the release notes cover: count placeholders before the first release, full
 * bodies since `from` after it. */
async function collectCommits(
	mainPath: string,
	from: string | null,
	sha: string,
): Promise<{ sha?: string; subject: string; body: string }[]> {
	if (from === null) {
		const count = await git(
			["rev-list", "--count", "--no-merges", sha],
			mainPath,
		);
		// First release: only the count is needed (notes are fixed), so don't read every body.
		return Array.from({ length: Number(count.stdout.trim()) || 0 }, () => ({
			subject: "",
			body: "",
		}));
	}
	const log = await git(
		["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", `${from}..${sha}`],
		mainPath,
	);
	return log.stdout
		.split("\x1e")
		.map((r) => r.trim())
		.filter(Boolean)
		.map((r) => {
			const [hash = "", subject = "", body = ""] = r.split("\x1f");
			return { sha: hash, subject, body };
		});
}

export async function planRelease(o: {
	mainPath: string;
	target: string;
	sha: string;
	/** The server-pinned origin URL (docs/specs/pinned-origin-url.md); null skips the fetch. */
	originUrl: string | null;
}): Promise<Omit<ReleasePlan, "tasks">> {
	// R5-1: the fetch names the pinned origin URL, never the remote name a work turn can
	// re-point. No pin (or a refused one): skip — the plan reads the tags already fetched,
	// the same degraded state as a failed fetch.
	if (
		o.originUrl !== null &&
		(await hasOrigin(o.mainPath)) &&
		(await checkPinnedRemote(o.mainPath, o.originUrl)) === null
	)
		await git(["fetch", "--tags", o.originUrl], o.mainPath);
	const { sha, blocked: offTarget } = await resolveSha(
		o.mainPath,
		o.target,
		o.sha,
	);
	const tags = await git(["tag", "--list", "v*", "--merged", sha], o.mainPath);
	const from = highestTag(tags.stdout.split("\n"));
	const commits = await collectCommits(o.mainPath, from, sha);
	const { version, notes, releasable } = computeRelease(from, commits);
	let blocked = offTarget;
	if (blocked === null) {
		if (!releasable)
			blocked =
				from === null
					? "Nothing to release."
					: `Nothing to release since ${from}.`;
		else if (
			(
				await git(
					["rev-parse", "--verify", "--quiet", `refs/tags/${version}`],
					o.mainPath,
				)
			).code === 0
		) {
			blocked = `Tag ${version} already exists.`;
		}
	}
	return { sha, from, version, notes, commits: commits.length, blocked };
}

const GH_MISSING =
	"GitHub CLI (gh) not found: install it and run gh auth login";

/** "owner/name" from a GitHub HTTPS remote URL; null when it does not match. */
export function ownerRepo(url: string): string | null {
	return (
		url
			.match(/\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
			?.slice(1)
			.join("/") ?? null
	);
}
export async function runGh(
	args: string[],
	// gh talks to the GitHub API; a hung call must not pin a card for good. 2 min covers the
	// release create/view calls; app.ts's repo create passes its own ceiling if it needs more.
	timeoutMs = 2 * 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return spawnGh(args, timeoutMs, {
		...process.env,
		...ghEnvFor(githubHost(), process.env.GH_TOKEN),
	});
}

async function spawnGh(
	args: string[],
	timeoutMs: number,
	env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		return await spawnPiped(["gh", ...args], undefined, timeoutMs, env);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(GH_MISSING);
		throw e;
	}
}

/** Hosted gh's config dir: empty and private to this process, made on first use. */
let hostedGhConfigDir: string | null = null;

/**
 * Hosted mode's gh for one project (docs/specs/hosted-mode.md section 6): it authenticates
 * with the token the control plane minted for the project that owns cwd and its remote,
 * never the board's GH_TOKEN and never a credential gh stored (hosts.yml, keyring): gh runs
 * with an empty GH_CONFIG_DIR. No token: gh runs without any. The token never leaves raw.
 */
export async function hostedGh(
	cwd: string,
	remote: string | null,
): Promise<typeof runGh> {
	const auth = hostedGitAuth();
	return async (args, timeoutMs = 2 * 60_000) => {
		const token =
			auth === null || remote === null ? null : await auth.ghToken(cwd, remote);
		const env: Record<string, string | undefined> = { ...process.env };
		for (const k of [
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"GH_ENTERPRISE_TOKEN",
			"GITHUB_ENTERPRISE_TOKEN",
		])
			delete env[k];
		hostedGhConfigDir ??= mkdtempSync(join(tmpdir(), "ottr-hosted-gh-"));
		env.GH_CONFIG_DIR = hostedGhConfigDir;
		const r = await spawnGh(args, timeoutMs, {
			...env,
			...ghEnvFor(githubHost(), token ?? undefined),
		});
		if (token === null) return r;
		return {
			...r,
			stdout: redact(r.stdout, [token]),
			stderr: redact(r.stderr, [token]),
		};
	};
}

/** One late commit with its full message body, the shape `lateNotes` groups into notes sections. */
export interface LateCommitInfo extends LateCommit {
	body: string;
}

/**
 * Commits in `reviewed..sha` (the range publishRelease tags), newest first; null when git fails.
 * Marking: the findings' mergeHeads, in done order, anchor the range — commits after the previous
 * anchor (the reviewed commit for the first segment) up to and including a finding head are that
 * finding's merge (reviewed: true); commits before the first anchor or between segments are not.
 */
export async function lateCommits(
	mainPath: string,
	reviewed: string,
	sha: string,
	findings: readonly string[],
): Promise<LateCommitInfo[] | null> {
	const log = await git(
		["log", "--format=%H%x1f%s%x1f%b%x1e", `${reviewed}..${sha}`],
		mainPath,
	);
	if (log.code !== 0) return null;
	const all = log.stdout
		.split("\x1e")
		.filter((rec) => rec.trim() !== "")
		.map((rec) => {
			const [sha = "", subject = "", body = ""] = rec.trimStart().split("\x1f");
			return { sha, subject, body };
		});
	// Newest first from git; walk from the tip back to each anchor, so every commit after the
	// previous anchor and up to (and including) the finding head lands in that finding's segment.
	const anchors = new Set([reviewed, ...findings]);
	let marked = false;
	const out: LateCommitInfo[] = [];
	for (const c of all) {
		if (!marked && anchors.has(c.sha) && c.sha !== reviewed) marked = true;
		out.push({ ...c, reviewed: marked });
	}
	return out;
}

/** Groups the late commits under Conventional Commit headings and appends them to the planned notes. */
export function lateNotes(notes: string, marked: LateCommitInfo[]): string {
	const dropped = droppedCommits(marked);
	const kept = marked.filter((_, i) => !dropped.has(i));
	const sections: Record<string, string[]> = {};
	for (const c of kept) {
		const type = parseCommit(c.subject, c.body)?.type;
		const head =
			type === "feat"
				? "New features"
				: type === "fix"
					? "Bug fixes"
					: "Other changes";
		const list = sections[head] ?? [];
		list.push(`- ${c.subject}${c.reviewed ? "" : " (not reviewed)"}`);
		sections[head] = list;
	}
	const body = Object.entries(sections)
		.map(([head, bullets]) => `## ${head}\n\n${bullets.join("\n")}`)
		.join("\n\n");
	if (body === "") return notes;
	return [notes.trim(), body].filter(Boolean).join("\n\n");
}

/** Creates the release tag, or verifies it already sits at `sha`; returns the progress part. */
async function tagReleasePart(
	o: {
		mainPath: string;
		version: string;
		sha: string;
		archReview?: { delta: number } | null;
	},
	marked: LateCommitInfo[],
): Promise<string> {
	// Every step is idempotent so a failed publish can be retried by replying to the release card.
	const cur = await git(
		["rev-parse", "--verify", "--quiet", `refs/tags/${o.version}^{commit}`],
		o.mainPath,
	);
	if (cur.code === 0) {
		const at = cur.stdout.trim();
		if (at !== o.sha)
			throw new Error(
				`tag ${o.version} already exists at ${at.slice(0, 7)}, not ${o.sha.slice(0, 7)}`,
			);
		return `tag ${o.version} already at ${o.sha.slice(0, 7)}`;
	}
	const message = o.archReview
		? `${o.version}\n\narch-review: ${o.archReview.delta}`
		: o.version;
	const t = await git(
		["tag", "-a", o.version, "-m", message, o.sha],
		o.mainPath,
	);
	if (t.code !== 0)
		throw new Error(`git tag ${o.version} failed: ${t.stderr.trim()}`);
	return `tagged ${o.version} at ${o.sha.slice(0, 7)}${marked.length > 0 ? ` (late fixes: ${marked.length})` : ""}`;
}

/** Pushes the tag to the pinned origin when the repo has one; "pushed" as the progress part. */
async function pushReleaseTag(o: {
	mainPath: string;
	originUrl: string | null;
	version: string;
}): Promise<string> {
	if (!(await hasOrigin(o.mainPath))) return "";
	// R5-1: the push names the pinned origin URL, never the remote name a work turn can
	// re-point (the named repo's hooks would run here). No pin: fail loudly, never skip.
	if (o.originUrl === null)
		throw new Error(
			"the origin URL is not pinned; restart the board so the server pins it, then run the release again",
		);
	const guard = await checkPinnedRemote(o.mainPath, o.originUrl);
	if (guard !== null) throw new Error(guard);
	const p = await git(
		["push", o.originUrl, `refs/tags/${o.version}`],
		o.mainPath,
	);
	if (p.code !== 0)
		throw new Error(`git push ${o.version} failed: ${p.stderr.trim()}`);
	return "pushed";
}

/** Creates the GitHub release, or reports it exists; the release page as the progress part. */
async function ghReleasePart(
	o: { github: string | null; version: string; notes: string },
	gh: (args: string[]) => Promise<GhReply>,
): Promise<string> {
	if (o.github === null) return "";
	const repo = ownerRepo(o.github);
	if (repo === null)
		throw new Error(`cannot read owner/name from GitHub remote ${o.github}`);
	if ((await gh(["release", "view", o.version, "--repo", repo])).code === 0)
		return `GitHub release ${o.version} already exists`;
	const c = await gh([
		"release",
		"create",
		o.version,
		"--repo",
		repo,
		"--title",
		o.version,
		"--notes",
		o.notes,
		"--verify-tag",
	]);
	if (c.code !== 0)
		throw new Error(
			`gh release create ${o.version} failed: ${c.stderr.trim()}`,
		);
	return `GitHub release ${githubHost().webBase}/${repo}/releases/tag/${o.version}`;
}

export async function publishRelease(o: {
	mainPath: string;
	/** The commit the review saw. */
	reviewed: string;
	/** The commit to tag: the target's head, which must contain `reviewed`. */
	sha: string;
	version: string;
	notes: string;
	/** Ordered mergeHeads of the review's finding cards: the anchors that mark which late commits are review fixes. */
	findings?: string[];
	github: string | null;
	archReview?: { delta: number } | null;
	/** The server-pinned origin URL (docs/specs/pinned-origin-url.md); null fails the push. */
	originUrl: string | null;
	/** gh runner for the release calls; hosted mode passes hostedGh's project-scoped client. */
	gh?: typeof runGh;
}): Promise<string> {
	const gh = o.gh ?? runGh;
	// The release waits for its review's fixes, and the merge hold keeps every other card off the
	// target, so the commits after `reviewed` are those fixes: the tag holds them, the notes list
	// them. The findings' mergeHeads anchor the attribution; a commit pushed outside the board
	// before the first finding's merge sits in its segment (ponytail; later segments are exact).
	const anc = await git(
		["merge-base", "--is-ancestor", o.reviewed, o.sha],
		o.mainPath,
	);
	if (anc.code !== 0)
		throw new Error(
			`${o.sha.slice(0, 7)} does not contain the reviewed commit ${o.reviewed.slice(0, 7)}`,
		);
	const marked = await lateCommits(
		o.mainPath,
		o.reviewed,
		o.sha,
		o.findings ?? [],
	);
	if (marked === null) throw new Error("git log for the late fixes failed");
	const notes = lateNotes(o.notes, marked);
	const parts: string[] = [];
	const tagged = await tagReleasePart(o, marked);
	parts.push(tagged);
	const pushed = await pushReleaseTag(o);
	if (pushed !== "") parts.push(pushed);
	const released = await ghReleasePart({ ...o, notes }, gh);
	if (released !== "") parts.push(released);
	return parts.join(", ");
}

function withoutHostedSecret(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const { OTTR_HOSTED_SECRET: _, ...rest } = env;
	return rest;
}

/** Splits the command on spaces; double quotes group a part that holds spaces. No shell, no escapes. */
function releaseArgv(command: string): string[] {
	const argv = (command.match(/"[^"]*"|[^\s"]+/g) ?? []).map((a) =>
		a.startsWith('"') ? a.slice(1, -1) : a,
	);
	if (argv.length === 0) throw new Error("the release command is empty");
	return argv;
}

/** The command's env: the process env minus the hosted secret, plus the release facts. */
function releaseEnv(o: {
	sha: string;
	version: string;
	notesFile: string;
	archReview?: { delta: number } | null;
}): Record<string, string | undefined> {
	return {
		// The hosted signing key never reaches the tenant's command (hosted-mode spec).
		...withoutHostedSecret(process.env),
		OTTR_RELEASE_VERSION: o.version,
		OTTR_RELEASE_COMMIT: o.sha,
		OTTR_RELEASE_NOTES_FILE: o.notesFile,
		...(o.archReview ? { OTTR_ARCH_REVIEW: String(o.archReview.delta) } : {}),
	};
}

/** Spawns the command's process tree; a missing binary names the command in the error. */
function spawnRelease(
	argv: string[],
	cwd: string,
	env: Record<string, string | undefined>,
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	try {
		return Bun.spawn(argv, {
			cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Stryker disable next-line BooleanLiteral: no test can see a console window
			windowsHide: true,
		});
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(`release command not found: ${argv[0]}`);
		throw e;
	}
}

/** Streams one pipe of the command into `emit`, newline-split; the unterminated tail flushes at EOF. */
async function pumpLines(
	stream: ReadableStream<Uint8Array>,
	emit: (raw: string) => void | Promise<void>,
): Promise<void> {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of stream) {
		buf += decoder.decode(chunk, { stream: true });
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			await emit(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
		}
	}
	await emit(buf + decoder.decode());
}

/** The commit the command's tag points at: from the pinned origin when the repo has one
 * (and the fetch brings the tag home), else from the local tag. */
async function claimedTagSha(
	mainPath: string,
	originUrl: string | null,
	version: string,
): Promise<string> {
	if (!(await hasOrigin(mainPath))) {
		const t = await git(
			["rev-parse", "--verify", "--quiet", `refs/tags/${version}^{commit}`],
			mainPath,
		);
		if (t.code !== 0)
			throw new Error(`the release command did not create tag ${version}`);
		return t.stdout.trim();
	}
	// R5-1: the claim check reads the pinned origin URL, never the remote name a work
	// turn can re-point. No pin: fail loudly, never fall back to the local tag.
	if (originUrl === null)
		throw new Error(
			"the origin URL is not pinned; restart the board so the server pins it, then run the release again",
		);
	const guard = await checkPinnedRemote(mainPath, originUrl);
	if (guard !== null) throw new Error(guard);
	const ls = await git(["ls-remote", "--tags", originUrl], mainPath);
	if (ls.code !== 0)
		throw new Error(`git ls-remote ${originUrl} failed: ${ls.stderr.trim()}`);
	const refs = new Map(
		ls.stdout.split("\n").map((l) => {
			const [hash = "", ref = ""] = l.trim().split(/\s+/);
			return [ref, hash];
		}),
	);
	// An annotated tag's `^{}` line names its commit; a lightweight tag's own line does.
	const remote =
		refs.get(`refs/tags/${version}^{}`) ?? refs.get(`refs/tags/${version}`);
	if (remote === undefined)
		throw new Error(`the release command did not push tag ${version}`);
	const f = await git(["fetch", "--quiet", "--tags", originUrl], mainPath);
	if (f.code !== 0)
		throw new Error(`git fetch ${originUrl} failed: ${f.stderr.trim()}`);
	return remote;
}

/**
 * Runs the project's release command instead of Ottr's tag, push and GitHub release, then checks its claim
 * with git: the tag is on origin (a local tag without origin), holds the reviewed commit, and is on the
 * target. A reply to a failed release card runs the command again, so the command must be idempotent.
 */
export async function runReleaseCommand(o: {
	command: string;
	/** The release card's worktree, checked out at the reviewed commit. */
	cwd: string;
	mainPath: string;
	/** The server-pinned origin URL (docs/specs/pinned-origin-url.md); null fails the check. */
	originUrl: string | null;
	target: string;
	sha: string;
	version: string;
	notesFile: string;
	/** Commits since the previous review, exposed as OTTR_ARCH_REVIEW for the command's tag message.
	 * Informational: the board counts its review watermark from review cards, not from tags. */
	archReview?: { delta: number } | null;
	log: (line: string) => void | Promise<void>;
	/** Lets Cancel and shutdown stop the command's process tree. */
	onSpawn?: (h: {
		pid: number;
		done: Promise<unknown>;
		kill(): Promise<void>;
	}) => void;
}): Promise<string> {
	const argv = releaseArgv(o.command);
	const proc = spawnRelease(argv, o.cwd, releaseEnv(o));
	const pid = proc.pid;
	o.onSpawn?.({
		pid,
		done: proc.exited,
		kill: async () => platform.killTree(pid),
	});
	let last = "";
	const emit = async (raw: string): Promise<void> => {
		const line = raw.replace(/\r$/, "");
		if (line.trim() === "") return;
		await o.log(line);
		last = line.trim();
	};
	const [code] = await Promise.all([
		proc.exited,
		pumpLines(proc.stdout, emit),
		pumpLines(proc.stderr, emit),
	]);
	if (code !== 0)
		throw new Error(
			`release command exited with code ${code}${last ? `: ${last}` : ""}`,
		);

	const at = await claimedTagSha(o.mainPath, o.originUrl, o.version);
	const short = at.slice(0, 7);
	if (
		(await git(["merge-base", "--is-ancestor", o.sha, at], o.mainPath)).code !==
		0
	) {
		throw new Error(
			`tag ${o.version} (${short}) does not contain the reviewed commit ${o.sha.slice(0, 7)}`,
		);
	}
	if (
		(await git(["merge-base", "--is-ancestor", at, o.target], o.mainPath))
			.code !== 0
	) {
		throw new Error(`tag ${o.version} (${short}) is not on ${o.target}`);
	}
	return `release command published ${o.version} at ${short}`;
}

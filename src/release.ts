import { platform } from "./platform/index.ts";
import { type ReviewTask, reviewBlocked } from "./scheduler.ts";
import type { LatestImage, ReleasePlan, Task } from "./types.ts";
import { git, spawnPiped } from "./worktree.ts";

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

export function computeRelease(
	from: string | null,
	commits: { subject: string; body: string }[],
): { version: string; notes: string; releasable: boolean } {
	if (from === null) {
		return {
			version: "v0.1.0",
			notes: "First release.",
			releasable: commits.length > 0,
		};
	}
	const m = from.match(SEMVER);
	if (!m) throw new Error(`previous release tag ${from} is not vX.Y.Z`);
	const parsed = commits.map((c) => parseCommit(c.subject, c.body));
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

	// One bullet per listed commit, in commit order; unlisted types only when breaking; dedupe.
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
		const section =
			c === null
				? "## Changes"
				: c.type === "feat"
					? "## New features"
					: c.type === "fix"
						? "## Bug fixes"
						: "## Changes";
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
	return { version: `v${x}.${y}.${z}`, notes, releasable: seen.size > 0 };
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

/**
 * Latest `vX.Y.Z` tag of the repo's public ghcr.io image (the "owner/name" image, lowercased),
 * with its package page. Anonymous registry pull (the v2 API), so private or absent images
 * come back null.
 */
export async function latestImage(repo: string): Promise<LatestImage | null> {
	const [owner, name] = repo.split("/");
	if (owner === undefined || name === undefined) return null;
	const image = `${owner}/${name}`.toLowerCase();
	const tokenRes = await fetch(
		`https://ghcr.io/token?scope=repository:${image}:pull&service=ghcr.io`,
	).catch(() => null);
	// ghcr's token endpoint: { "token": "..." }; anything else means no public pull.
	const tokenBody: unknown = tokenRes?.ok ? await tokenRes.json() : undefined;
	const token =
		typeof tokenBody === "object" &&
		tokenBody !== null &&
		"token" in tokenBody &&
		typeof tokenBody.token === "string"
			? tokenBody.token
			: undefined;
	if (token === undefined) return null;
	// n=1000: ghcr pages at 100 tags oldest-first, so a bare call loses the newest tags.
	// ponytail: >1000-tag images truncate; follow Link headers if one ever shows up.
	// redirect: "manual": the bearer must never follow a redirect off ghcr.io;
	// a 3xx answer joins 401/403 as "no chip".
	const tagsRes = await fetch(`https://ghcr.io/v2/${image}/tags/list?n=1000`, {
		headers: { authorization: `Bearer ${token}` },
		redirect: "manual",
	}).catch(() => null);
	// 404 without an image, 401/403 for private ones; both mean "no chip".
	if (!tagsRes?.ok) return null;
	const tagsBody: unknown = await tagsRes.json();
	const tags =
		typeof tagsBody === "object" &&
		tagsBody !== null &&
		"tags" in tagsBody &&
		Array.isArray(tagsBody.tags)
			? tagsBody.tags
			: [];
	const tag = highestTag(tags);
	return tag === null
		? null
		: {
				tag,
				url: `https://github.com/${owner}/${name}/pkgs/container/${name.toLowerCase()}`,
			};
}

/**
 * Done tasks whose work is in the next release: merged after `since` (the last release tag's commit
 * time; 0 before the first release). Cards that moved the target by zero commits (question-only or
 * answer-only tasks) are dropped via the per-task target-commits counter; unmeasured counts keep the
 * task rather than silently hiding it.
 */
export function includedTasks(
	tasks: Pick<
		Task,
		| "id"
		| "title"
		| "stage"
		| "cancelledAt"
		| "releaseVersion"
		| "doneAt"
		| "commits"
	>[],
	since: number,
): { id: string; title: string }[] {
	const done = tasks
		.filter(
			(t) =>
				t.stage === "done" &&
				t.cancelledAt === null &&
				t.releaseVersion === null &&
				t.doneAt !== null,
		)
		.sort((a, b) => a.doneAt! - b.doneAt!);
	// The last task merged before `since` saw the target at count(from), so its counter is the
	// delta baseline; from there each task's delta is its own work (merges are serialized).
	let prev: number =
		done.filter((t) => t.doneAt! <= since).at(-1)?.commits ?? 0;
	const out: { id: string; title: string }[] = [];
	for (const t of done) {
		if (t.doneAt! <= since) continue;
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

export async function planRelease(o: {
	mainPath: string;
	target: string;
	sha: string;
}): Promise<Omit<ReleasePlan, "tasks">> {
	if (await hasOrigin(o.mainPath))
		await git(["fetch", "--tags", "origin"], o.mainPath);
	let sha: string;
	let blocked: string | null = null;
	const v = await git(
		["rev-parse", "--verify", "--quiet", `${o.sha}^{commit}`],
		o.mainPath,
	);
	if (v.code === 0) {
		sha = v.stdout.trim();
		const anc = await git(
			["merge-base", "--is-ancestor", sha, o.target],
			o.mainPath,
		);
		if (anc.code !== 0)
			blocked = `Commit ${sha.slice(0, 7)} is not on ${o.target}.`;
	} else {
		sha = o.sha;
		blocked = `Commit ${o.sha.slice(0, 7)} is not on ${o.target}.`;
	}

	const tags = await git(["tag", "--list", "v*", "--merged", sha], o.mainPath);
	const from = highestTag(tags.stdout.split("\n"));
	const count =
		from === null
			? await git(["rev-list", "--count", "--no-merges", sha], o.mainPath)
			: await git(
					["rev-list", "--count", "--no-merges", `${from}..${sha}`],
					o.mainPath,
				);
	// First release: only the count is needed (notes are fixed), so don't read every body.
	const commits =
		from === null
			? Array.from({ length: Number(count.stdout.trim()) || 0 }, () => ({
					subject: "",
					body: "",
				}))
			: (
					await git(
						["log", "--no-merges", "--format=%s%x1f%b%x1e", `${from}..${sha}`],
						o.mainPath,
					)
				).stdout
					.split("\x1e")
					.map((r) => r.trim())
					.filter(Boolean)
					.map((r) => {
						const [subject = "", body = ""] = r.split("\x1f");
						return { subject, body };
					});
	const { version, notes, releasable } = computeRelease(from, commits);
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
	try {
		return await spawnPiped(["gh", ...args], undefined, timeoutMs);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(GH_MISSING);
		throw e;
	}
}

export async function publishRelease(o: {
	mainPath: string;
	/** The commit the review saw. */
	reviewed: string;
	/** The commit to tag: the target's head, which must contain `reviewed`. */
	sha: string;
	version: string;
	notes: string;
	github: string | null;
	archReview?: { delta: number } | null;
}): Promise<string> {
	const parts: string[] = [];
	// The release waits for its review's fixes, and the merge hold keeps every other card off the
	// target, so the commits after `reviewed` are those fixes: the tag holds them, the notes list them.
	// ponytail: a commit pushed outside the board during the review ships too (it is listed); match
	// the late commits against the findings' merges if that ever bites.
	const anc = await git(
		["merge-base", "--is-ancestor", o.reviewed, o.sha],
		o.mainPath,
	);
	if (anc.code !== 0)
		throw new Error(
			`${o.sha.slice(0, 7)} does not contain the reviewed commit ${o.reviewed.slice(0, 7)}`,
		);
	const late = await git(
		["log", "--format=- %s", `${o.reviewed}..${o.sha}`],
		o.mainPath,
	);
	if (late.code !== 0)
		throw new Error(`git log for the late fixes failed: ${late.stderr.trim()}`);
	const fixes = late.stdout.trim();
	const lateCount = fixes === "" ? 0 : fixes.split("\n").length;
	const notes =
		fixes === ""
			? o.notes
			: [o.notes.trim(), `## Late fixes\n\n${fixes}`]
					.filter(Boolean)
					.join("\n\n");
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
		parts.push(`tag ${o.version} already at ${o.sha.slice(0, 7)}`);
	} else {
		const message = o.archReview
			? `${o.version}\n\narch-review: ${o.archReview.delta}`
			: o.version;
		const t = await git(
			["tag", "-a", o.version, "-m", message, o.sha],
			o.mainPath,
		);
		if (t.code !== 0)
			throw new Error(`git tag ${o.version} failed: ${t.stderr.trim()}`);
		parts.push(
			`tagged ${o.version} at ${o.sha.slice(0, 7)}${lateCount > 0 ? ` (late fixes: ${lateCount})` : ""}`,
		);
	}
	if (await hasOrigin(o.mainPath)) {
		const p = await git(
			["push", "origin", `refs/tags/${o.version}`],
			o.mainPath,
		);
		if (p.code !== 0)
			throw new Error(`git push ${o.version} failed: ${p.stderr.trim()}`);
		parts.push("pushed");
	}
	if (o.github !== null) {
		const repo = ownerRepo(o.github);
		if (!repo)
			throw new Error(`cannot read owner/name from GitHub remote ${o.github}`);
		if (
			(await runGh(["release", "view", o.version, "--repo", repo])).code === 0
		) {
			parts.push(`GitHub release ${o.version} already exists`);
		} else {
			const c = await runGh([
				"release",
				"create",
				o.version,
				"--repo",
				repo,
				"--title",
				o.version,
				"--notes",
				notes,
				"--verify-tag",
			]);
			if (c.code !== 0)
				throw new Error(
					`gh release create ${o.version} failed: ${c.stderr.trim()}`,
				);
			parts.push(
				`GitHub release https://github.com/${repo}/releases/tag/${o.version}`,
			);
		}
	}
	return parts.join(", ");
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
	target: string;
	sha: string;
	version: string;
	notesFile: string;
	/** Commits since the previous review, exposed as OTTR_ARCH_REVIEW for the command's tag message.
	 * Informational: the board counts its review watermark from review cards, not from tags. */
	archReview?: { delta: number } | null;
	log: (line: string) => void;
	/** Lets Cancel and shutdown stop the command's process tree. */
	onSpawn?: (h: {
		pid: number;
		done: Promise<unknown>;
		kill(): Promise<void>;
	}) => void;
}): Promise<string> {
	// Split on spaces; double quotes group a part that holds spaces. No shell, no escapes.
	const argv = (o.command.match(/"[^"]*"|[^\s"]+/g) ?? []).map((a) =>
		a.startsWith('"') ? a.slice(1, -1) : a,
	);
	if (argv.length === 0) throw new Error("the release command is empty");
	const spawn = () => {
		try {
			return Bun.spawn(argv, {
				cwd: o.cwd,
				env: {
					...process.env,
					OTTR_RELEASE_VERSION: o.version,
					OTTR_RELEASE_COMMIT: o.sha,
					OTTR_RELEASE_NOTES_FILE: o.notesFile,
					...(o.archReview
						? { OTTR_ARCH_REVIEW: String(o.archReview.delta) }
						: {}),
				},
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
	};
	const proc = spawn();
	const pid = proc.pid;
	o.onSpawn?.({
		pid,
		done: proc.exited,
		kill: async () => platform.killTree(pid),
	});
	let last = "";
	const emit = (raw: string) => {
		const line = raw.replace(/\r$/, "");
		if (line.trim() === "") return;
		o.log(line);
		last = line.trim();
	};
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		let buf = "";
		for await (const chunk of stream) {
			buf += decoder.decode(chunk, { stream: true });
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				emit(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
			}
		}
		emit(buf + decoder.decode());
	};
	const [code] = await Promise.all([
		proc.exited,
		pump(proc.stdout),
		pump(proc.stderr),
	]);
	if (code !== 0)
		throw new Error(
			`release command exited with code ${code}${last ? `: ${last}` : ""}`,
		);

	let at: string;
	if (await hasOrigin(o.mainPath)) {
		const ls = await git(["ls-remote", "--tags", "origin"], o.mainPath);
		if (ls.code !== 0)
			throw new Error(`git ls-remote origin failed: ${ls.stderr.trim()}`);
		const refs = new Map(
			ls.stdout.split("\n").map((l) => {
				const [hash = "", ref = ""] = l.trim().split(/\s+/);
				return [ref, hash];
			}),
		);
		// An annotated tag's `^{}` line names its commit; a lightweight tag's own line does.
		const remote =
			refs.get(`refs/tags/${o.version}^{}`) ??
			refs.get(`refs/tags/${o.version}`);
		if (remote === undefined)
			throw new Error(`the release command did not push tag ${o.version}`);
		at = remote;
		const f = await git(["fetch", "--quiet", "--tags", "origin"], o.mainPath);
		if (f.code !== 0)
			throw new Error(`git fetch origin failed: ${f.stderr.trim()}`);
	} else {
		const t = await git(
			["rev-parse", "--verify", "--quiet", `refs/tags/${o.version}^{commit}`],
			o.mainPath,
		);
		if (t.code !== 0)
			throw new Error(`the release command did not create tag ${o.version}`);
		at = t.stdout.trim();
	}
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

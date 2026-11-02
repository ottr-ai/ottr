import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	appendLineBelow,
	copyBelow,
	moveBelow,
	readRegular,
	removeBelow,
	trustedAnchor,
} from "./confine.ts";
import type { DiffFileStat, KeptChoice } from "./types.ts";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Fast git binary path. On Windows, PATH often resolves through wrapper exes (scoop shims,
 * Git for Windows' cmd\git.exe) that re-exec the real binary and add ~0.4 s per spawn, while
 * the native mingw64\bin\git.exe in the same install costs ~0.05 s. `resolved` is injectable for tests.
 */
export function gitExe(resolved: string | null = Bun.which("git")): string {
	if (!resolved) return "git";
	if (process.platform !== "win32") return resolved;
	// A scoop shim is a stub exe whose sibling <name>.shim (no .exe) names the real binary.
	const shimPath = `${resolved.replace(/\.exe$/i, "")}.shim`;
	const exe = existsSync(shimPath)
		? (readFileSync(shimPath, "utf8").match(/^path\s*=\s*(.+)$/m)?.[1] ?? "")
				.trim()
				.replace(/^"+|"+$/g, "") || resolved
		: resolved;
	// Prefer the native binaries over a cmd\ or bin\ wrapper in the same install. Resolve scoop's
	// `current` junction first: spawning through the junction costs ~0.2 s more per call.
	let base = exe;
	try {
		base = realpathSync(exe);
	} catch {
		// missing binary: keep the given path
	}
	const root = path.dirname(path.dirname(base));
	return (
		[
			path.join(root, "mingw64", "bin", "git.exe"),
			path.join(root, "bin", "git.exe"),
		].find((c) => c !== exe && existsSync(c)) ?? exe
	);
}

/**
 * One piped spawn, shared by git() and runGh(). `timeout` (Bun 1.4) bounds a hung child:
 * Bun kills it and `exited` resolves non-zero, so no caller can wait forever.
 */
export async function spawnPiped(
	argv: string[],
	cwd: string | undefined,
	timeoutMs: number,
	env: Record<string, string | undefined> = process.env,
): Promise<GitResult> {
	const proc = Bun.spawn(argv, {
		cwd,
		// Explicit: the caller picks the env; Bun's default would be this process's boot env
		// (git scopes GH_TOKEN to network subcommands via gitEnv; gh keeps it for its API).
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// Stryker disable next-line BooleanLiteral: no test can see a console window, and the mutant would flash one per git call
		windowsHide: true,
		timeout: timeoutMs,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

/** Git subcommands that touch the network and so need GH_TOKEN for their credential helper; every other board git runs without it. */
const NETWORK_GIT: Record<string, true> = {
	clone: true,
	fetch: true,
	"ls-remote": true,
	pull: true,
	push: true,
};

/**
 * Flags the board puts right after the subcommand. Repo config a work turn planted (R5-1)
 * can name a command in keys no `-c` can clear: `diff.external` (an empty value makes git
 * fail, not skip it), `diff.<driver>.textconv`/`command` (driver names come from planted
 * attributes) and `remote.<name>.uploadpack`/`receivepack` (git keeps the first value it
 * reads). Command-line flags outrank all of them. The flags reach only this git process, not
 * the child git a submodule diff, fetch or push starts, and a submodule's config is
 * worker-writable too: so the board never recurses into submodules either.
 */
const NO_EXT_DIFF = ["--no-ext-diff", "--no-textconv", "--submodule=short"];
const UPLOAD_PACK = [
	"--upload-pack=git-upload-pack",
	"--no-recurse-submodules",
];
const PINNED_ARGS: Record<string, readonly string[]> = {
	diff: NO_EXT_DIFF,
	log: NO_EXT_DIFF,
	show: NO_EXT_DIFF,
	clone: UPLOAD_PACK,
	fetch: UPLOAD_PACK,
	"ls-remote": ["--upload-pack=git-upload-pack"],
	pull: UPLOAD_PACK,
	push: ["--receive-pack=git-receive-pack", "--recurse-submodules=no"],
};

/**
 * Child env for one board git call: GH_TOKEN only when the subcommand touches the network
 * (finding the subcommand skips `-c <k>=<v>` global pairs). Work turns share the workspace
 * and home volumes the board runs git in and can write its repo's .git/config or the home
 * .gitconfig (R5-1), so local subcommands never carry the token where planted config or
 * hooks could reach it.
 *
 * Credential boundary: network subcommands get the per-host auth env (tokens + ssh key)
 * from the resolver (or an explicit authEnv, which replaces the resolver). Local
 * subcommands get neither, and every credential name is stripped so a worker's boot env
 * cannot leak into them. `GIT_AUTH_ENV_NAME` must match gitHosts.ts `GIT_AUTH_ENV_RE`.
 */
export const GIT_AUTH_ENV_NAME =
	/^(GIT_ASKPASS|GIT_SSH_COMMAND|GIT_ALLOW_PROTOCOL|GIT_PROXY_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+|OTTR_GIT_(USER|TOKEN)_\d+)$/;

let networkAuthResolver: (cwd: string) => Record<string, string> = () => ({});
export function setNetworkGitAuth(
	fn: (cwd: string) => Record<string, string>,
): void {
	networkAuthResolver = fn;
}
export function networkGitAuth(cwd: string): Record<string, string> {
	return networkAuthResolver(cwd);
}

/** Deletes every git host credential name in place: GH_TOKEN, GITHUB_TOKEN and the
 * `GIT_AUTH_ENV_NAME` set. Local board git and every worker turn run without them. */
export function stripGitAuthEnv(env: Record<string, string | undefined>): void {
	delete env.GH_TOKEN;
	delete env.GITHUB_TOKEN;
	for (const k of Object.keys(env)) {
		if (GIT_AUTH_ENV_NAME.test(k)) delete env[k];
	}
}

export function gitEnv(
	args: readonly string[],
	auth: Record<string, string> = {},
): Record<string, string | undefined> {
	const env = { ...process.env };
	let sub = "";
	let isNetwork = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-c") {
			i++; // global option: its value is a config line, not the subcommand
			continue;
		}
		if (a && !a.startsWith("-")) {
			sub = a;
			isNetwork = NETWORK_GIT[sub] === true;
			break;
		}
	}
	if (isNetwork) {
		Object.assign(env, auth);
	} else {
		stripGitAuthEnv(env);
	}
	return env;
}

/**
 * Run git; never throws for non-zero exit. Bounded: default ceiling 10 min; callers with
 * slow ops (clone, a big remote fetch) pass a larger timeoutMs. `env` adds to the child env.
 */
export async function git(
	args: string[],
	cwd: string,
	timeoutMs = 10 * 60_000,
	authEnv?: Record<string, string>,
	env: Record<string, string> = {},
): Promise<GitResult> {
	let at = -1;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-c") {
			i++;
			continue;
		}
		if (a && !a.startsWith("-")) {
			at = i;
			break;
		}
	}
	const sub = at < 0 ? "" : (args[at] as string);
	const isNetwork = NETWORK_GIT[sub] === true;
	const auth = isNetwork ? (authEnv ?? networkGitAuth(cwd)) : {};
	// The redaction list is fixed at spawn: the stored secrets now, plus the tokens this call
	// itself carries. A token rotated or removed while the call runs stays redacted in its output.
	const list = [
		...secrets,
		...Object.entries(auth)
			.filter(([k]) => /^OTTR_GIT_TOKEN_\d+$/.test(k))
			.map(([, v]) => v),
	];
	const r = await spawnPiped(
		[
			gitExe(),
			// Command-line config outranks repo and global config, so config a work turn planted
			// in the shared workspace or home volume (R5-1) cannot run an fsmonitor command, a
			// hook or a signing program in the board's git, which holds GH_TOKEN. The board never
			// signs, and a planted log.showSignature or signed commit can only reach `false`.
			// PINNED_ARGS covers the diff and pack keys -c cannot clear. Filter drivers need
			// sealedGit. Residual: network subcommands still read credential.helper and
			// core.sshCommand from planted config (docs/WORKERS.md).
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgSign=false",
			"-c",
			"tag.gpgSign=false",
			"-c",
			"gpg.program=false",
			"-c",
			"gpg.x509.program=false",
			"-c",
			"gpg.ssh.program=false",
			// Auto gc/maintenance prunes stale worktree admin entries, and git follows a symlinked
			// entry when it deletes one (guardAdminEntries): the board's git never runs either.
			"-c",
			"gc.auto=0",
			"-c",
			"maintenance.auto=false",
			...args.slice(0, at + 1),
			...(PINNED_ARGS[sub] ?? []),
			...args.slice(at + 1),
		],
		cwd,
		timeoutMs,
		{ ...gitEnv(args, auth), ...env },
	);
	// Network git carries host tokens, and a remote may echo one back: its output reaches task
	// logs and API errors, so stored secrets never leave this function raw.
	if (!isNetwork || list.length === 0) return r;
	return {
		...r,
		stdout: redact(r.stdout, list),
		stderr: redact(r.stderr, list),
	};
}

let secrets: readonly string[] = [];

/** Stores the redaction list for one app lifetime (every stored git host token). */
export function setGitSecrets(s: readonly string[]): void {
	secrets = [...s];
}

export function gitSecrets(): readonly string[] {
	return secrets;
}

/** Repo-local core keys that git probes at init (file modes, symlinks, case, Unicode, line
 * endings). sealedGit copies them, so status reads the files as the repo's own git does.
 * They steer only git's builtin conversion, never a command. */
const PROBED_CORE =
	"^core\\.(filemode|symlinks|ignorecase|precomposeunicode|autocrlf|eol)$";

/**
 * Board git over a worktree's files: status, diffs against the files, the first checkout.
 * A work turn can write the shared gitdir (R5-1). Its config defines filter drivers
 * (`filter.<d>.clean`/`smudge`/`process`) under names that planted attributes pick, so no
 * `-c` can clear them, and git reads `$GIT_DIR/info/attributes` above every override. These
 * calls run against a board-written stub gitdir instead: HEAD as a sha, the worktree's own
 * index and objects, a copy of the main checkout's info/exclude, no repo config. Tracked
 * .gitattributes still apply, but they can only name drivers of system, global or
 * command-line config (git-lfs). A partial clone's promisor remote (name, url, filter) is
 * copied, so a missing blob still fetches lazily; that fetch reads the stub too, never the
 * planted remote keys (uploadpack, sshCommand, helpers), and its ssh runs pinned
 * (`ssh -F /dev/null -o BatchMode=yes`, transports https:ssh), so the shared home ssh
 * config never reaches it. Callers pass
 * `--ignore-submodules=dirty`: a submodule status runs git in the submodule's own gitdir,
 * which is planted the same way. dirtySubmodules probes each submodule through this stub.
 */
async function sealedGit(
	args: string[],
	worktreePath: string,
): Promise<GitResult> {
	const info = await git(
		[
			"rev-parse",
			"--path-format=absolute",
			"--git-dir",
			"--git-common-dir",
			"--show-object-format",
			"HEAD",
		],
		worktreePath,
	);
	if (info.code !== 0) return info;
	const [gitDir = "", common = "", format = "", head = ""] =
		info.stdout.split("\n");
	// Both values land in the stub's files: a planted objectformat must not inject config lines.
	if (
		!/^(sha1|sha256)$/.test(format) ||
		!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(head)
	)
		return {
			code: 128,
			stdout: "",
			stderr: `unexpected git rev-parse output: ${info.stdout.trim()}`,
		};
	const probed = await git(
		["config", "-z", "--get-regexp", PROBED_CORE],
		worktreePath,
	);
	const keep = probed.stdout
		.split("\0")
		.filter(Boolean)
		.flatMap((kv) => ["-c", kv.replace("\n", "=")]);
	const stub = mkdtempSync(path.join(tmpdir(), "ottr-git-"));
	try {
		mkdirSync(path.join(stub, "refs"));
		mkdirSync(path.join(stub, "info"));
		writeFileSync(path.join(stub, "HEAD"), `${head}\n`);
		writeFileSync(
			path.join(stub, "config"),
			`[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = ${format}\n`,
		);
		try {
			writeFileSync(
				path.join(stub, "info", "exclude"),
				readRegular(path.join(common, "info", "exclude")),
			);
		} catch (e) {
			if (!(e instanceof Error && "code" in e && e.code === "ENOENT"))
				return { code: 128, stdout: "", stderr: String(e) };
		}
		// Promisor remotes: extensions.partialClone and every remote.<name>.promisor=true.
		const pc = await git(
			[
				"config",
				"-z",
				"--get-regexp",
				"^(extensions\\.partialclone|remote\\..*\\.(url|promisor|partialclonefilter))$",
			],
			worktreePath,
		);
		const entries = pc.stdout
			.split("\0")
			.filter(Boolean)
			.map((kv) => {
				const nl = kv.indexOf("\n");
				return nl < 0 ? [kv, ""] : [kv.slice(0, nl), kv.slice(nl + 1)];
			});
		const remoteOf = (k: string, v: string) =>
			k === "extensions.partialclone"
				? v
				: k.slice("remote.".length, k.lastIndexOf("."));
		const promisors = new Set(
			entries
				.filter(
					([k = "", v = ""]) =>
						k === "extensions.partialclone" ||
						(k.endsWith(".promisor") && /^(true|yes|on|1)$/i.test(v)),
				)
				.map(([k = "", v = ""]) => remoteOf(k, v)),
		);
		// git config --file escapes every value: a planted name or url cannot add config lines.
		for (const [k = "", v = ""] of entries) {
			if (!promisors.has(remoteOf(k, v))) continue;
			const w = await git(
				["config", "--file", path.join(stub, "config"), "--add", k, v],
				stub,
			);
			if (w.code !== 0) return w;
		}
		return await git(
			[
				"--no-optional-locks",
				...keep,
				// git-lfs finds its object cache through the gitdir, which is now the stub.
				"-c",
				`lfs.storage=${path.join(common, "lfs")}`,
				...args,
			],
			worktreePath,
			undefined,
			undefined,
			{
				GIT_DIR: stub,
				GIT_WORK_TREE: worktreePath,
				GIT_INDEX_FILE: path.join(gitDir, "index"),
				GIT_OBJECT_DIRECTORY: path.join(common, "objects"),
				// The lazy promisor fetch shells out to ssh (gitEnv stripped GIT_SSH_COMMAND), and
				// ssh reads ~/.ssh/config from the passwd home (/root), which the shared home
				// volume makes worker-writable: a planted ProxyCommand would run here. gitAuthEnv
				// pins the same way (OTTR-264); GIT_ALLOW_PROTOCOL pins the fetch transport.
				GIT_SSH_COMMAND: "ssh -F /dev/null -o BatchMode=yes",
				GIT_ALLOW_PROTOCOL: "https:ssh",
			},
		);
	} finally {
		rmSync(stub, { recursive: true, force: true });
	}
}

/**
 * Checked-out submodules below `dir` whose files differ from their HEAD (edits or untracked
 * files, also deeper down), each probed through sealedGit, since the `--ignore-submodules=dirty`
 * the sealed calls pass hides them. Throws when a submodule cannot be read: unknown is not clean.
 */
async function dirtySubmodules(
	dir: string,
	seen = new Set<string>(),
): Promise<string[]> {
	// A planted symlink loop (sub -> ..) would recurse forever.
	const real = realpathSync(dir);
	if (seen.has(real)) throw new Error(`submodule loop at ${dir}`);
	seen.add(real);
	const ls = await git(["ls-files", "-z", "--stage"], dir);
	if (ls.code !== 0)
		throw new Error(`git ls-files failed in ${dir}: ${ls.stderr.trim()}`);
	const dirty: string[] = [];
	for (const rec of ls.stdout.split("\0")) {
		if (!rec.startsWith("160000 ")) continue;
		const rel = rec.slice(rec.indexOf("\t") + 1);
		const sub = path.join(dir, rel);
		if (!existsSync(path.join(sub, ".git"))) continue; // not checked out: no files to lose
		const st = await sealedGit(
			[
				"status",
				"--porcelain",
				"--untracked-files=all",
				"--ignore-submodules=dirty",
			],
			sub,
		);
		if (st.code !== 0)
			throw new Error(`git status failed in ${sub}: ${st.stderr.trim()}`);
		if (st.stdout !== "" || (await dirtySubmodules(sub, seen)).length > 0)
			dirty.push(rel);
	}
	return dirty;
}

/** Every non-empty secret becomes [REDACTED] in ONE pass (longest first), so a secret that
 * occurs inside "[REDACTED]" can neither loop nor rewrite an earlier replacement. */
export function redactCount(
	text: string,
	list: readonly string[],
): { text: string; hits: number } {
	const live = list.filter((s) => s !== "").sort((a, b) => b.length - a.length);
	if (live.length === 0) return { text, hits: 0 };
	const re = new RegExp(
		live.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
		"g",
	);
	let hits = 0;
	const out = text.replace(re, () => {
		hits++;
		return "[REDACTED]";
	});
	return { text: out, hits };
}

export function redact(text: string, list: readonly string[]): string {
	return redactCount(text, list).text;
}

/**
 * A stream writer that redacts across write boundaries: it holds back the tail that could
 * still be the start of a secret (at most the longest secret minus one char, and never a
 * cut through a match), so a token split across two writes is one match. The joined output
 * always equals redact() of the joined input. flush() releases the held tail.
 */
export function redactingWriter(
	emit: (s: string) => void,
	list: () => readonly string[],
): { write(s: string): void; flush(): void } {
	let held = "";
	const release = (all: boolean): void => {
		const live = list().filter((s) => s !== "");
		const longest = live.reduce((n, s) => Math.max(n, s.length), 0);
		let cut = all || longest === 0 ? held.length : held.length - (longest - 1);
		// Never cut inside a match: move the cut to the start of any match that crosses it.
		for (let moved = true; moved; ) {
			moved = false;
			for (const s of live)
				for (
					let i = held.indexOf(s);
					i !== -1 && i < cut;
					i = held.indexOf(s, i + 1)
				)
					if (i + s.length > cut) {
						cut = i;
						moved = true;
					}
		}
		if (cut <= 0) return;
		const out = redact(held.slice(0, cut), live);
		held = held.slice(cut);
		emit(out);
	};
	return {
		write: (s) => {
			held += s;
			release(false);
		},
		flush: () => release(true),
	};
}

/** null = ok, else human-readable reason. */
export function validateCopyPath(p: string): string | null {
	if (p.trim() === "") return "path is empty";
	if (p.includes("\0")) return "path contains NUL";
	const norm = p.replaceAll("\\", "/");
	// Same rule on every OS: a leading slash (after \ -> /) covers /etc and \\server\share, the regex covers C: drives.
	if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm))
		return "path must be relative";
	// Windows normalizes each component: trailing spaces vanish, all-dot names with
	// two or more dots climb ("..." is ".."), other trailing dots vanish (".git." is
	// ".git"). Validate those Windows-effective segment names.
	const segs: string[] = [];
	for (const raw of norm.split("/")) {
		const spaced = raw.replace(/ +$/, "");
		if (/^\.\.+$/.test(spaced)) return "path must not contain '..'";
		const name = spaced.replace(/\.+$/, "");
		if (name !== "" && name !== ".") segs.push(name);
	}
	if (segs.length === 0) return "path must be inside the worktree";
	if (segs.some((s) => s.toLowerCase() === ".git"))
		return "path must not contain '.git'";
	const base = segs[segs.length - 1] ?? "";
	if (/^\.env/i.test(base)) return "env files cannot be copied";
	return null;
}

export function slugify(text: string): string {
	const s = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	return s === "" ? "task" : s;
}

export function hasRules(mainPath: string): boolean {
	return existsSync(path.join(mainPath, "AGENTS.md"));
}

/** HTTPS URL of the main checkout's GitHub remote (origin preferred); null when it has none. */
export async function githubUrl(mainPath: string): Promise<string | null> {
	const r = await git(["remote", "-v"], mainPath);
	if (r.code !== 0) return null;
	const byName = new Map<string, string>();
	for (const line of r.stdout.split("\n")) {
		const [name = "", url = "", kind = ""] = line.trim().split(/\s+/);
		const m =
			kind === "(push)" ? /github\.com[:/](.+?)(?:\.git)?$/i.exec(url) : null;
		if (m?.[1]) byName.set(name, `https://github.com/${m[1]}`);
	}
	return byName.get("origin") ?? [...byName.values()][0] ?? null;
}

/** Normalizes a git remote URL (https, ssh, scp-like) to an https URL; null for anything
 * else, so local and file paths never become icon sources. Userinfo (embedded tokens) is
 * stripped: the URL ships to board clients and must never carry credentials. */
export function httpsRemote(raw: string): string | null {
	const m =
		/^(?:https?:\/\/([^/]+)\/|ssh:\/\/git@([^/]+)\/|git@([^:/]+):)(.+?)(?:\.git)?\/?$/i.exec(
			raw.trim(),
		);
	const host = (m?.[1] ?? m?.[2] ?? m?.[3])?.replace(/.*@/, "");
	const p = m?.[4];
	if (host === undefined || host === "" || p === undefined || p === "")
		return null;
	return `https://${host}/${p}`;
}

/** HTTPS URL of the main checkout's origin push remote on any host (GitHub, GitLab,
 * self-hosted); null when it has none. Icon adoption reads this; githubUrl stays the
 * github.com-only view the release flow uses. */
export async function remoteUrl(mainPath: string): Promise<string | null> {
	const r = await git(["remote", "-v"], mainPath);
	if (r.code !== 0) return null;
	const byName = new Map<string, string>();
	for (const line of r.stdout.split("\n")) {
		const [name = "", url = "", kind = ""] = line.trim().split(/\s+/);
		if (kind !== "(push)") continue;
		const https = httpsRemote(url);
		if (https !== null) byName.set(name, https);
	}
	return byName.get("origin") ?? [...byName.values()][0] ?? null;
}

/** Repo name from a GitHub HTTPS or SSH clone URL; null for anything else. Guards the clone
 * destination: a dot-leading name could escape the workspace via path traversal. */
export function githubRepoName(raw: string): string | null {
	const m =
		/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
			raw.trim(),
		);
	const name = m?.[2];
	if (name === undefined || name.startsWith(".")) return null;
	return name;
}

export async function isGitRepoWithCommit(dir: string): Promise<boolean> {
	// Behavior check, not a path-string compare: git prints the resolved long path while Node
	// may hold an 8.3 short form (RUNNER~1), so samePath-style equality misreads a repo toplevel.
	const r = await git(
		["rev-parse", "--is-inside-work-tree", "--show-prefix"],
		dir,
	).catch(() => null);
	if (r?.code !== 0) return false;
	const [inside = "", prefix = ""] = r.stdout.split("\n");
	if (inside.trim() !== "true" || prefix.trim() !== "") return false;
	const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], dir);
	return head.code === 0;
}

/** Version stamp for a checkout: HEAD sha, else boot time when git fails (e.g. no commits yet). */
export async function headVersion(dir: string): Promise<string> {
	try {
		const r = await git(["rev-parse", "HEAD"], dir);
		if (r.code === 0 && r.stdout.trim() !== "") return r.stdout.trim();
	} catch {
		// git missing or unusable
	}
	return String(Date.now());
}

/** What `archReviewDelta` reports: the commit delta, whether a watermark anchors it (false = never
 * reviewed), and the anchor commit ("" when there is none). */
export interface ArchReviewDelta {
	delta: number;
	reviewed: boolean;
	anchor: string;
}

/** Commits on `target` since the newest review watermark: `lastReview` (the frozen base of the
 * newest finished review card, scheduler.ts lastReviewBase) or a legacy `docs(arch-review):`
 * commit, whichever is newer; the whole history when there is none; null when git fails.
 * `reviewed` is false when no watermark exists, so a newly added project counts as un-reviewed
 * whatever its history size. */
export async function archReviewDelta(
	mainPath: string,
	target: string,
	lastReview: string | null,
): Promise<ArchReviewDelta | null> {
	try {
		const a = await git(
			["log", "-1", "--format=%H %ct", "--grep=^docs(arch-review):", target],
			mainPath,
		);
		if (a.code !== 0) return null;
		let anchor = "";
		let anchorAt = -1;
		const [sha, ct] = a.stdout.trim().split(" ");
		if (sha) {
			anchor = sha;
			anchorAt = Number(ct);
		}
		if (lastReview !== null) {
			// A review base this clone does not have (rewritten history) is skipped, not fatal.
			const d = await git(
				["show", "-s", "--format=%ct", `${lastReview}^{commit}`],
				mainPath,
			);
			const at = Number(d.stdout.trim());
			if (d.code === 0 && at > anchorAt) {
				anchor = lastReview;
				anchorAt = at;
			}
		}
		const r = await git(
			["rev-list", "--count", anchor !== "" ? `${anchor}..${target}` : target],
			mainPath,
		);
		const n = Number(r.stdout.trim());
		// reviewed = the delta counts from a real watermark, not from the start of history.
		return r.code === 0 && Number.isInteger(n) && n >= 0
			? { delta: n, reviewed: anchor !== "", anchor }
			: null;
	} catch {
		return null;
	}
}

/** A review is due once the delta reaches the cap; a project with no watermark yet is always due. Pure: testable without git. */
export function archReviewDue(
	delta: number,
	cap: number,
	reviewed: boolean,
): boolean {
	return !reviewed || delta >= cap;
}

/**
 * Upstream of the main checkout's branch, else the branch itself; sha of target.
 * fetch (before a new worktree): refresh the upstream first. A failed fetch only warns, but an upstream
 * that still doesn't resolve stops, instead of silently basing the work on the local branch.
 */
export async function resolveTarget(
	mainPath: string,
	fetch = false,
): Promise<{ target: string; sha: string; warning: string | null }> {
	const head = await git(
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		mainPath,
	);
	if (head.code === 1) throw new Error("main checkout is on a detached HEAD");
	if (head.code !== 0)
		throw new Error(
			`cannot read branch of main checkout: ${head.stderr.trim()}`,
		);
	const branch = head.stdout.trim();
	// The configured upstream, even when its remote-tracking ref is missing (@{u} fails then).
	const fmt =
		"--format=%(upstream:short) %(upstream:remotename) %(upstream:remoteref)";
	const up = await git(["for-each-ref", fmt, `refs/heads/${branch}`], mainPath);
	if (up.code !== 0)
		throw new Error(`git for-each-ref failed: ${up.stderr.trim()}`);
	const [upstream = "", remote = "", remoteRef = ""] = up.stdout
		.trim()
		.split(" ");
	const target = upstream || branch;
	let fetchError: string | null = null;
	if (fetch && remote !== "") {
		// ponytail: a remote branch deleted since the last fetch only warns (its stale ref still resolves); add `git ls-remote --exit-code` if that bites
		const f = await git(["fetch", "--quiet", remote, remoteRef], mainPath);
		if (f.code !== 0)
			fetchError = `git fetch ${remote} ${remoteRef} failed: ${f.stderr.trim()}`;
	}
	const sha = await git(
		["rev-parse", "--verify", "--quiet", `${target}^{commit}`],
		mainPath,
	);
	if (sha.code !== 0) {
		if (!upstream) throw new Error(`cannot resolve ${target}`);
		throw new Error(
			`upstream ${target} of ${branch} not found${fetchError ? ` (${fetchError})` : ""}; push ${branch} or set its upstream with git branch -u`,
		);
	}
	return {
		target,
		sha: sha.stdout.trim(),
		warning: fetchError && `${fetchError}; using ${target} as last fetched`,
	};
}

export async function createWorktree(o: {
	mainPath: string;
	worktreePath: string;
	branch: string;
	base: string;
	copyExtra: string[];
	log: (line: string) => void;
}): Promise<void> {
	for (const p of o.copyExtra) {
		const reason = validateCopyPath(p);
		if (reason) throw new Error(`invalid copy path ${p}: ${reason}`);
		if (!existsSync(path.join(o.mainPath, p)))
			throw new Error(`copy path missing in main checkout: ${p}`);
	}

	// A crashed attempt (omp dying before its turn was recorded) can leave the branch and/or
	// worktree behind; both names derive from the task id, so a retry reuses them instead of
	// failing with "branch already exists". Reuse is decided by behavior, not by comparing
	// registered path strings: on Windows git prints long paths while Node may hold 8.3 short
	// forms (RUNNER~1), so a textual set lookup misreads a registered worktree as a scratch dir
	// and deletes it behind git's back, and the next add dies with "already registered".
	const onDisk = existsSync(o.worktreePath);
	let fresh = false;
	if (onDisk && (await worktreeLinked(o.worktreePath))) {
		o.log(`reusing worktree ${o.worktreePath} on ${o.branch}`);
	} else {
		if (onDisk)
			// scratch dir from an interrupted add; the tracker owns .worktrees/<id>
			removeBelow(worktreeAnchor(o.mainPath, o.worktreePath), o.worktreePath);
		// a stale admin entry would fail the add with "missing but already registered"
		await guardAdminEntries(o.mainPath, o.worktreePath);
		const branchExists =
			(await git(["rev-parse", "--quiet", "--verify", o.branch], o.mainPath))
				.code === 0;
		const add = await git(
			branchExists
				? ["worktree", "add", "--no-checkout", o.worktreePath, o.branch]
				: [
						"worktree",
						"add",
						"--no-checkout",
						"-b",
						o.branch,
						o.worktreePath,
						o.base,
					],
			o.mainPath,
		);
		if (add.code !== 0)
			throw new Error(`git worktree add failed: ${add.stderr.trim()}`);
		fresh = true;
	}
	o.log(`worktree ${o.worktreePath} on ${o.branch}`);

	try {
		// The checkout `worktree add` would run, minus planted smudge drivers (sealedGit).
		// ponytail: a crash between add and this checkout leaves an empty worktree that a retry
		// reuses as is; check for the missing index on reuse if that ever bites.
		if (fresh) {
			const co = await sealedGit(
				["reset", "--hard", "--no-recurse-submodules", "-q"],
				o.worktreePath,
			);
			if (co.code !== 0)
				throw new Error(
					`git checkout of the worktree failed: ${co.stderr.trim()}`,
				);
		}
		const candidates = ["AGENTS.md", ".omp", ...o.copyExtra].filter((p) =>
			existsSync(path.join(o.mainPath, p)),
		);
		const copied: string[] = [];
		if (candidates.length > 0) {
			// No ignore filter: local-only rules are ignored files by design (.git/info/exclude
			// or a .gitignore), and the exclude entries that this copy adds would hide them from
			// the next worktree. validateCopyPath rejects "." and the loop skips env files.
			// ponytail: ls-files --others copies whole dirs (e.g. .omp) wholesale, ignored caches too; fine for rules-scale files
			const ls = await git(
				["ls-files", "-z", "--others", "--", ...candidates],
				o.mainPath,
			);
			if (ls.code !== 0)
				throw new Error(`git ls-files failed: ${ls.stderr.trim()}`);
			for (const rel of ls.stdout.split("\0")) {
				if (rel === "") continue;
				if (/^\.env/i.test(path.posix.basename(rel.replaceAll("\\", "/"))))
					continue;
				copyBelow(
					{
						anchor: trustedAnchor(o.mainPath),
						file: path.join(o.mainPath, rel),
					},
					{
						anchor: worktreeAnchor(o.mainPath, o.worktreePath),
						file: path.join(o.worktreePath, rel),
					},
					o.mainPath,
				);
				copied.push(rel);
				o.log(`copied ${rel}`);
			}
		}

		if (copied.length > 0) {
			const exclude = await excludeFile(o.mainPath);
			for (const rel of copied) {
				const relFwd = rel.replaceAll("\\", "/");
				const ci = await git(["check-ignore", "-q", "--", rel], o.worktreePath);
				if (ci.code === 1) {
					appendLineBelow(exclude.anchor, exclude.file, `/${relFwd}`);
					o.log(`added /${relFwd} to .git/info/exclude`);
				} else if (ci.code > 1) {
					throw new Error(
						`git check-ignore failed for ${rel}: ${ci.stderr.trim()}`,
					);
				}
			}
			const st = await sealedGit(
				[
					"status",
					"--porcelain",
					"--untracked-files=all",
					"--ignore-submodules=dirty",
				],
				o.worktreePath,
			);
			if (st.code !== 0)
				throw new Error(`git status failed in worktree: ${st.stderr.trim()}`);
			if (st.stdout !== "")
				throw new Error(
					`worktree not clean after copying rules:\n${st.stdout}`,
				);
		}
	} catch (e) {
		// worktree add succeeded; roll it back so a retry doesn't hit "already exists"
		try {
			await removeWorktree({
				mainPath: o.mainPath,
				worktreePath: o.worktreePath,
				branch: o.branch,
			});
		} catch (rmErr) {
			o.log(
				`cleanup after failed createWorktree failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
			);
		}
		throw e;
	}
}

export async function removeWorktree(o: {
	mainPath: string;
	worktreePath: string;
	branch: string | null;
}): Promise<void> {
	await guardAdminEntries(o.mainPath, null);
	await git(["worktree", "remove", "--force", o.worktreePath], o.mainPath); // best effort
	if (existsSync(o.worktreePath)) {
		const anchor = worktreeAnchor(o.mainPath, o.worktreePath);
		for (let attempt = 0; ; attempt++) {
			try {
				removeBelow(anchor, o.worktreePath);
				break;
			} catch (e) {
				const code = (e as { code?: string }).code;
				if (attempt >= 3 || (code !== "EBUSY" && code !== "EPERM")) throw e;
				await Bun.sleep(500);
			}
		}
	}
	await guardAdminEntries(o.mainPath, o.worktreePath);
	if (o.branch) await git(["branch", "-D", o.branch], o.mainPath); // best effort
}

export async function commitsAhead(
	worktreePath: string,
	base: string,
): Promise<number> {
	const r = await git(["rev-list", "--count", `${base}..HEAD`], worktreePath);
	if (r.code !== 0) throw new Error(`git rev-list failed: ${r.stderr.trim()}`);
	return Number.parseInt(r.stdout.trim(), 10);
}

export async function isClean(worktreePath: string): Promise<boolean> {
	const r = await sealedGit(
		[
			"status",
			"--porcelain",
			"--untracked-files=all",
			"--ignore-submodules=dirty",
		],
		worktreePath,
	);
	if (r.code !== 0 || r.stdout !== "") return false;
	return dirtySubmodules(worktreePath).then(
		(d) => d.length === 0,
		() => false,
	);
}

export async function isIntegrated(
	worktreePath: string,
	target: string,
): Promise<boolean> {
	if (!(await worktreeLinked(worktreePath))) return false;
	const r = await git(
		["merge-base", "--is-ancestor", "HEAD", target],
		worktreePath,
	);
	return r.code === 0;
}

/**
 * The server's merge push (no agent holds git host credentials; the merge prompt tells the
 * agent not to push). Pushes the local target branch to origin when origin lacks its tip and
 * the main repo proves the local merge. The proof is the worktree's HEAD, else the task branch,
 * in the local branch. A merge agent may remove both before it reports (a project's AGENTS.md
 * can say so). Then the local branch ahead of origin is the proof: only merge turns move it.
 * git() adds the host auth: per-host tokens or the ssh key, and GH_TOKEN for GitHub. The local
 * tip is refs/heads/<branch>: `origin/<branch>` names the remote-tracking ref, which only this
 * push moves. A hold-approved merge passes `leaseTip` (OTTR-274): the audited origin tip the
 * gate fetched. The push then requires the local target to contain that tip, and pins the
 * remote with --force-with-lease, so a merge agent cannot aim the gate's fetch at one remote
 * and the push at another: the real remote rejects any push whose lease does not match.
 */
export async function serverMergePush(
	mainPath: string,
	worktreePath: string,
	target: string,
	taskBranch: string,
	leaseTip: string | null = null,
): Promise<
	| { status: "skipped" }
	| { status: "pushed"; output: string }
	| { status: "failed"; error: string }
> {
	if (!target.startsWith("origin/")) return { status: "skipped" };
	const branch = target.slice("origin/".length);
	const sha = async (ref: string, cwd = mainPath) => {
		const r = await git(
			["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
			cwd,
		);
		return r.code === 0 ? r.stdout.trim() : null;
	};
	const local = await sha(`refs/heads/${branch}`);
	if (local === null || local === (await sha(`refs/remotes/origin/${branch}`)))
		return { status: "skipped" };
	if (leaseTip !== null) {
		const pinned = await git(
			["merge-base", "--is-ancestor", leaseTip, `refs/heads/${branch}`],
			mainPath,
		);
		if (pinned.code !== 0)
			return {
				status: "failed",
				error: `merge-hold gate: the audited origin tip ${leaseTip} is not contained in refs/heads/${branch}`,
			};
	}
	const head = (await worktreeLinked(worktreePath))
		? await sha("HEAD", worktreePath)
		: taskBranch === ""
			? null
			: await sha(`refs/heads/${taskBranch}`);
	if (head !== null) {
		const merged = await git(
			["merge-base", "--is-ancestor", head, local],
			mainPath,
		);
		if (merged.code !== 0) return { status: "skipped" };
	}
	const r = await git(
		[
			"push",
			// With the lease the update is a fast-forward by construction (the local target
			// contains the audited tip the remote must still sit at), so the force part of
			// the lease never fires; it only rejects a remote that moved off the audited tip.
			...(leaseTip !== null
				? [`--force-with-lease=refs/heads/${branch}:${leaseTip}`]
				: []),
			"origin",
			`refs/heads/${branch}:refs/heads/${branch}`,
		],
		mainPath,
	);
	if (r.code === 0)
		return { status: "pushed", output: `${r.stdout}${r.stderr}`.trim() };
	const last = r.stderr.trim().split("\n").filter(Boolean).pop();
	return { status: "failed", error: last ?? `git push exited ${r.code}` };
}

/**
 * OTTR-274: whether the commits a server push would ship (refs/heads/<branch>) carry exactly the
 * approved hold's content change (base..approvedHead), plus the push-side diff for the reviewer
 * and the audited origin tip for the push's lease. A merge turn resumes the same agent session
 * and can commit beyond an approved head, so the push's total tree effect must equal the
 * approved one. A rebase onto a moved target keeps the effect equal. The tree diff is the check
 * (not per-commit patch-ids): a merge commit can take one parent's stale side, which git's
 * combined diff hides — only the total effect against the target shows a smuggled revert. The
 * merge agent can rewrite any local ref and the repo's remote config, so the fetch uses a
 * gate-owned refspec into refs/ottr/gate/<branch> (configured refspecs and the remote-tracking
 * ref stay irrelevant) and serverMergePush pins the real remote to the returned auditedTip. Any
 * git trouble mismatches: the hold fails closed. Runs in the main repo, where the target refs
 * live.
 */
export async function mergeHoldMismatch(
	mainPath: string,
	target: string,
	base: string,
	approvedHead: string,
): Promise<{
	mismatch: boolean;
	pushDiff: string | null;
	auditedTip: string | null;
}> {
	const failClosed = (pushDiff: string | null = null) => ({
		mismatch: true,
		pushDiff,
		auditedTip: null,
	});
	if (!target.startsWith("origin/"))
		return { mismatch: false, pushDiff: null, auditedTip: null };
	const branch = target.slice("origin/".length);
	// --no-renames keeps the text deterministic across the two tree pairs (rename detection is
	// pair-dependent); --full-index keeps blob ids content-exact.
	// ponytail: full diff text in memory; upgrade to hashing only if a card ships a range big
	// enough to block a settle.
	const effect = async (from: string, to: string): Promise<string | null> => {
		const r = await git(
			["diff", "--no-renames", "--full-index", from, to],
			mainPath,
		);
		return r.code === 0 ? r.stdout : null;
	};
	const fetch = await git(
		["fetch", "origin", `+refs/heads/${branch}:refs/ottr/gate/${branch}`],
		mainPath,
	);
	if (fetch.code !== 0) return failClosed();
	const tip = await git(["rev-parse", `refs/ottr/gate/${branch}`], mainPath);
	if (tip.code !== 0) return failClosed();
	const auditedTip = tip.stdout.trim();
	const push = await effect(auditedTip, `refs/heads/${branch}`);
	if (push === null) return failClosed();
	const approved = await effect(base, approvedHead);
	return {
		mismatch: approved === null || push !== approved,
		pushDiff: push,
		auditedTip,
	};
}

/**
 * OTTR-326: a mismatch park must not leave the held patches on the local target branch — the
 * next card's push has no approved heads, so it would ship them. Moves the branch the main
 * checkout has checked out back to `tip` (the gate's audited origin fetch) with --keep, which
 * refuses instead of overwriting uncommitted changes there. False when HEAD is another branch,
 * the tip is unknown to git, or the reset refused: the caller parks the card anyway and logs
 * that the patches stayed. Runs in the main repo, where the target branch lives.
 */
export async function resetBranchTo(
	mainPath: string,
	branch: string,
	tip: string,
): Promise<boolean> {
	const head = await git(
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		mainPath,
	);
	if (head.code !== 0 || head.stdout.trim() !== branch) return false;
	const r = await git(["reset", "--keep", tip], mainPath);
	return r.code === 0;
}

/**
 * True when path is itself the top of a checkout with its own git link. A plain directory inside
 * the main repo must not borrow the main repo's state: git climbs out of unlinked dirs, so status
 * and ancestor checks would silently report the main checkout (observed: an emptied worktree dir
 * made merge turns "keep the worktree" over the main checkout's untracked files).
 */
export async function worktreeLinked(path: string): Promise<boolean> {
	// Empty `--show-prefix` means the dir is a checkout's own toplevel. No path strings compared:
	// on Windows git prints the resolved long path while Node may hold an 8.3 short form
	// (RUNNER~1 from tmpdir()), so textual equality misreads a linked worktree as unlinked.
	const r = await git(
		["rev-parse", "--is-inside-work-tree", "--show-prefix"],
		path,
	).catch(() => null);
	if (r?.code !== 0) return false;
	const [inside = "", prefix = ""] = r.stdout.split("\n");
	return inside.trim() === "true" && prefix.trim() === "";
}

/** True when path is an unlinked husk: not a worktree and holds no checkout (missing or empty dir) — nothing left to lose.
 * A deregistered-but-undeleted worktree (Windows: a process held the dir while `git worktree remove` ran) counts too:
 * it keeps every checkout file plus a `.git` file whose gitdir is gone, so git there cannot speak for any branch and
 * the husk proof comes from the main repo (branchMergedOrGone). The same shape with the `.git` file gone entirely
 * counts: git there climbs out to the enclosing repo, so it still cannot speak for its old branch. */
export async function worktreeHusk(dir: string): Promise<boolean> {
	if (await worktreeLinked(dir)) return false;
	try {
		if (statSync(path.join(dir, ".git")).isFile()) return true;
	} catch {
		// no .git file here: a climbing-git dir or only an empty dir is a husk
	}
	const r = await git(
		["rev-parse", "--is-inside-work-tree", "--show-prefix"],
		dir,
	).catch(() => null);
	if (r?.code === 0) {
		const [, prefix = ""] = r.stdout.split("\n");
		// Non-empty prefix: git resolved to an enclosing checkout, not this dir.
		if (prefix.trim() !== "") return true;
	}
	try {
		return readdirSync(dir).length === 0;
	} catch {
		return true;
	}
}

/** True when nothing recoverable is left to integrate: the branch is gone or already contained in target. */
export async function branchMergedOrGone(
	mainPath: string,
	branch: string,
	target: string,
): Promise<boolean> {
	const exists = await git(
		["rev-parse", "--verify", "--quiet", branch],
		mainPath,
	);
	if (exists.code !== 0) return true;
	const r = await git(
		["merge-base", "--is-ancestor", branch, target],
		mainPath,
	);
	return r.code === 0;
}

/** What deleting this worktree would lose (uncommitted changes, commits not on `target`); null if nothing. */
export async function unsavedWork(
	worktreePath: string,
	target: string,
): Promise<string | null> {
	// An unlinked husk holds no checkout: nothing to lose, so the delete check must pass and
	// the tracker can remove the empty folder. Only an unlinked dir WITH files stays suspect.
	if (await worktreeHusk(worktreePath)) return null;
	if (!(await worktreeLinked(worktreePath)))
		return "the worktree is missing or no longer linked to the repo";
	try {
		const lost: string[] = [];
		if (!(await isClean(worktreePath))) lost.push("uncommitted changes");
		const n = await commitsAhead(worktreePath, target);
		if (n > 0) lost.push(`${n} commit${n === 1 ? "" : "s"} not on ${target}`);
		return lost.length > 0 ? lost.join(" and ") : null;
	} catch (err) {
		return `cannot check it: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/** Repo-relative path from one `git status --porcelain -z` record (XY + path); -z never quotes or backslash-escapes. */
export function rowPath(line: string): string {
	return line.slice(3);
}

/** Raw `git status --porcelain -z --untracked-files=all` records (XY + path). [] means proven
 * clean; throws when the dir is not a linked checkout or git status fails — [] must never
 * mean "unknown", or callers could treat unknown status as safe to destroy. */
export async function statusRows(worktreePath: string): Promise<string[]> {
	if (!(await worktreeLinked(worktreePath)))
		throw new Error(`not a linked git worktree: ${worktreePath}`);
	const r = await sealedGit(
		[
			"status",
			"--porcelain",
			"-z",
			"--untracked-files=all",
			"--ignore-submodules=dirty",
		],
		worktreePath,
	);
	if (r.code !== 0) throw new Error(`git status failed: ${r.stderr.trim()}`);
	// -z: NUL-terminated records, never quoted; a rename/copy entry is followed by its original path.
	const recs = r.stdout.split("\0");
	const out: string[] = [];
	for (let i = 0; i < recs.length; i++) {
		const rec = recs[i]!;
		if (rec === "") continue; // trailing NUL
		out.push(rec);
		// Skip the original-path record of a rename/copy (X or Y is R/C).
		if (rec[0] === "R" || rec[0] === "C" || rec[1] === "R" || rec[1] === "C")
			i++;
	}
	// Same row plain git status prints for a dirty submodule; throws when one is unreadable.
	for (const rel of await dirtySubmodules(worktreePath))
		if (!out.some((row) => rowPath(row) === rel)) out.push(` M ${rel}`);
	return out;
}

/** Repo-relative paths `git status --porcelain --untracked-files=all` reports, for display lists
 * (drawer, kept files); [] when clean or unreadable. A merged card keeps its worktree path after
 * the directory is gone, so unreadable is routine here. Decisions read statusRows, which throws. */
export async function statusFiles(worktreePath: string): Promise<string[]> {
	const rows = await statusRows(worktreePath).catch(() => []);
	return [...new Set(rows.map(rowPath))];
}

/** The commit the branch's diff reads from: the merge-base with `target`, so commits a rebase
 * pulled in from `target` are not the branch's; `base` when that merge-base is unreadable. */
async function diffFrom(
	worktreePath: string,
	base: string,
	target: string,
): Promise<string> {
	// A sha: sealedGit's stub gitdir holds no refs, so a branch name in `base` must resolve here.
	const mb = await git(["merge-base", "HEAD", target], worktreePath);
	if (mb.code === 0) return mb.stdout.trim();
	const b = await git(
		["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
		worktreePath,
	);
	return b.code === 0 ? b.stdout.trim() : base;
}

/** Repo-relative paths the branch changed (committed branch work plus uncommitted edits; untracked
 * files excluded), from the newest `target` commit HEAD holds, so commits a rebase pulled in from
 * `target` are not the branch's; from `base` when that merge-base is unreadable. [] when
 * unreadable or unchanged. */
export async function changedFiles(
	worktreePath: string,
	base: string,
	target: string,
): Promise<string[]> {
	// ponytail: a branch already integrated into target diffs as only its uncommitted edits; work
	// turns never push, so that case means a broken rule, not a missed screenshot.
	const from = await diffFrom(worktreePath, base, target);
	// -z: NUL-separated names, never quoted — byte-exact even for non-ASCII or whitespace.
	const r = await sealedGit(
		["diff", "--name-only", "-z", "--ignore-submodules=dirty", from, "--"],
		worktreePath,
	);
	if (r.code !== 0) return [];
	const files = r.stdout.split("\0").filter(Boolean);
	// Display list: an unreadable submodule drops out of it; decisions read statusRows.
	for (const rel of await dirtySubmodules(worktreePath).catch(() => []))
		if (!files.includes(rel)) files.push(rel);
	return files;
}

/** Parses `git diff --numstat` output. A `-` count marks a binary file (null here); a rename
 * keeps git's `old => new` (or `dir/{old => new}`) spelling in `file`. ponytail: without -z the
 * path is C-quoted for exotic names — display-only; the raw diff endpoint shows the real bytes. */
export function parseNumstat(out: string): DiffFileStat[] {
	const files: DiffFileStat[] = [];
	for (const line of out.split("\n")) {
		if (line.trim() === "") continue;
		const [plus = "", minus = "", ...rest] = line.split("\t");
		if (rest.length === 0) continue;
		files.push({
			file: rest.join("\t"),
			plus: plus === "-" ? null : Number.parseInt(plus, 10),
			minus: minus === "-" ? null : Number.parseInt(minus, 10),
		});
	}
	return files;
}

/** Per-file +/- counts for the same diff changedFiles reads; [] when unreadable or unchanged. */
export async function diffStat(
	worktreePath: string,
	base: string,
	target: string,
): Promise<DiffFileStat[]> {
	const from = await diffFrom(worktreePath, base, target);
	const r = await sealedGit(
		["diff", "--numstat", "--ignore-submodules=dirty", from, "--"],
		worktreePath,
	);
	if (r.code !== 0) return [];
	const files = parseNumstat(r.stdout);
	// Plain git counts a submodule with only uncommitted edits as 0/0.
	for (const rel of await dirtySubmodules(worktreePath).catch(() => []))
		if (!files.some((f) => f.file === rel))
			files.push({ file: rel, plus: 0, minus: 0 });
	return files;
}

/** The branch's unified diff (same base as diffStat), or null when git fails. */
export async function diffText(
	worktreePath: string,
	base: string,
	target: string,
): Promise<string | null> {
	const from = await diffFrom(worktreePath, base, target);
	const r = await sealedGit(
		["diff", "--ignore-submodules=dirty", from, "--"],
		worktreePath,
	);
	if (r.code !== 0) return null;
	let text = r.stdout;
	// Plain git marks a dirty submodule's new commit line `-dirty`; the sealed diff cannot see it.
	// ponytail: matches the header by its unquoted path; a C-quoted submodule path gets a second section.
	for (const rel of await dirtySubmodules(worktreePath).catch(() => [])) {
		const head = `diff --git a/${rel} b/${rel}\n`;
		const at = text.indexOf(head);
		if (at >= 0) {
			const next = text.indexOf("\ndiff --git ", at);
			const end = next < 0 ? text.length : next + 1;
			text =
				text.slice(0, at) +
				text
					.slice(at, end)
					.replace(/^\+Subproject commit [0-9a-f]+$/m, "$&-dirty") +
				text.slice(end);
			continue;
		}
		const sha = (
			await git(["rev-parse", "HEAD"], path.join(worktreePath, rel))
		).stdout.trim();
		text += `${head}--- a/${rel}\n+++ b/${rel}\n@@ -1 +1 @@\n-Subproject commit ${sha}\n+Subproject commit ${sha}-dirty\n`;
	}
	return text;
}

/** Progress increment: commits on the integration target. Null when it cannot be counted (no target, unknown ref, git failure). */
export async function targetCommits(
	mainPath: string,
	target: string | null,
): Promise<number | null> {
	if (target === null) return null;
	try {
		const r = await git(["rev-list", "--count", target], mainPath);
		const n = Number(r.stdout.trim());
		return r.code === 0 && Number.isInteger(n) && n >= 0 ? n : null;
	} catch {
		return null; // git spawn failed: no count
	}
}

/** One `sha subject` line per commit on the target since `from`, oldest first, capped at the
 * newest 200. [] when the range is empty or git fails: the review check treats it as no data,
 * never as proof that main already fixed a finding. */
export async function commitSubjects(
	mainPath: string,
	from: string,
	target: string,
): Promise<string[]> {
	try {
		const r = await git(
			["log", "--format=%h %s", "-n", "200", `${from}..${target}`],
			mainPath,
		);
		if (r.code !== 0) return [];
		return r.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l !== "");
	} catch {
		return [];
	}
}

/**
 * Moves every non-ignored untracked file in the worktree into `quarantineDir`, preserving repo-relative
 * paths; returns the moved paths (repo-relative, forward slashes). Ignored files and tracked files stay
 * untouched. [] when there is nothing to move. Throws when git fails. No symlink below the worktree or
 * below `dataRoot` is followed: an untracked symlink moves as a link, and a symlinked parent on either
 * side throws ("refusing ...").
 */
export async function quarantineUntracked(
	worktreePath: string,
	quarantineDir: string,
	dataRoot: string,
): Promise<string[]> {
	const r = await git(
		["ls-files", "-z", "--others", "--exclude-standard"],
		worktreePath,
	);
	if (r.code !== 0) throw new Error(r.stderr || "git ls-files failed");
	const moved: string[] = [];
	for (const rel of r.stdout.split("\0")) {
		if (rel === "") continue;
		moveBelow(
			{
				anchor: trustedAnchor(worktreePath),
				file: path.join(worktreePath, rel),
			},
			{ anchor: dataRoot, file: path.join(quarantineDir, rel) },
		);
		moved.push(rel.replaceAll("\\", "/"));
	}
	return moved;
}

/**
 * Repo-relative paths git tracks under `rel` (the index, not the working tree); forward slashes.
 * [] when git fails: a caller that cannot tell a committed file from a fresh one fails open.
 */
export async function trackedFiles(
	worktreePath: string,
	rel: string,
): Promise<string[]> {
	const r = await git(["ls-files", "-z", "--", rel], worktreePath);
	if (r.code !== 0) return [];
	return r.stdout.split("\0").filter((line) => line !== "");
}

/** Validates a {path: choice} body against the kept list; unknown paths error, absent paths default to "move". */
export function parseKeptChoices(
	raw: unknown,
	kept: readonly string[],
): { choices: Record<string, KeptChoice> } | { error: string } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			error:
				"choices must be an object of file path -> move, ignore, or delete",
		};
	}
	const choices: Record<string, KeptChoice> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!kept.includes(key)) return { error: `unknown kept file: ${key}` };
		if (value !== "move" && value !== "ignore" && value !== "delete") {
			return { error: `choice for ${key} must be move, ignore, or delete` };
		}
		choices[key] = value;
	}
	for (const f of kept) choices[f] ??= "move";
	return { choices };
}

/** Splits kept files per choice; the first "move" whose path already exists in the main checkout is the conflict. */
export function planKeptFinish(
	files: readonly string[],
	choices: Record<string, KeptChoice>,
	existsInMain: (rel: string) => boolean,
):
	| { moves: string[]; ignores: string[]; deletes: string[] }
	| { conflict: string } {
	const moves: string[] = [];
	const ignores: string[] = [];
	const deletes: string[] = [];
	for (const f of files) {
		const choice = choices[f] ?? "move";
		if (choice === "move") {
			if (existsInMain(f)) return { conflict: f };
			moves.push(f);
		} else if (choice === "ignore") ignores.push(f);
		else deletes.push(f);
	}
	return { moves, ignores, deletes };
}

/** Appends /<rel> to the main checkout's .git/info/exclude unless git already ignores the path there. */
export async function ignoreInMain(
	mainPath: string,
	rel: string,
): Promise<void> {
	const ci = await git(["check-ignore", "-q", "--", rel], mainPath);
	if (ci.code === 0) return;
	if (ci.code > 1)
		throw new Error(`git check-ignore failed for ${rel}: ${ci.stderr.trim()}`);
	const exclude = await excludeFile(mainPath);
	appendLineBelow(
		exclude.anchor,
		exclude.file,
		`/${rel.replaceAll("\\", "/")}`,
	);
}

function isBelow(root: string, p: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(p));
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(rel)
	);
}

/**
 * The trusted anchor for server writes into a worktree: the main checkout when the worktree
 * lies below it (the tracker's .worktrees/<id>), so a symlink planted at .worktrees is caught;
 * widened to the OMP_TRACKER_ROOTS mount that holds it (trustedAnchor).
 */
export function worktreeAnchor(mainPath: string, worktreePath: string): string {
	return trustedAnchor(
		isBelow(mainPath, worktreePath)
			? mainPath
			: path.dirname(path.resolve(worktreePath)),
	);
}

/** The main checkout's git dir. A worker can point .git at any git dir, so one outside the checkout is refused. */
async function gitCommonDir(mainPath: string): Promise<string> {
	const common = await git(["rev-parse", "--git-common-dir"], mainPath);
	if (common.code !== 0)
		throw new Error(
			`git rev-parse --git-common-dir failed: ${common.stderr.trim()}`,
		);
	const dir = path.resolve(mainPath, common.stdout.trim());
	if (!isBelow(mainPath, dir))
		throw new Error(`refusing ${dir}: the git dir is outside ${mainPath}`);
	return dir;
}

/**
 * The main checkout's .git/info/exclude; no anchor would keep an append to a git dir outside
 * the checkout on the shared volume.
 */
async function excludeFile(
	mainPath: string,
): Promise<{ anchor: string; file: string }> {
	return {
		anchor: trustedAnchor(mainPath),
		file: path.join(await gitCommonDir(mainPath), "info", "exclude"),
	};
}

/**
 * Run before every board `git worktree` command. A worker can write the main checkout's
 * .git/worktrees, and git (2.47) recurses through a symlinked admin entry when it deletes
 * one, emptying the link's target as root. So symlinked entries (and a symlinked worktrees
 * dir) are removed here, never their targets, and the board never runs a global
 * `git worktree prune`: it drops only `worktreePath`'s own admin entry, when given.
 */
async function guardAdminEntries(
	mainPath: string,
	worktreePath: string | null,
): Promise<void> {
	const anchor = trustedAnchor(mainPath);
	const dir = path.join(await gitCommonDir(mainPath), "worktrees");
	const st = lstatSync(dir, { throwIfNoEntry: false });
	if (!st) return;
	if (!st.isDirectory()) return removeBelow(anchor, dir);
	for (const name of readdirSync(dir))
		if (
			lstatSync(path.join(dir, name), {
				throwIfNoEntry: false,
			})?.isSymbolicLink()
		)
			removeBelow(anchor, path.join(dir, name));
	if (!worktreePath) return;
	// ponytail: git names the entry after the checkout's basename and appends a digit on a
	// clash; a clashed entry stays registered (add then fails loudly). Match every entry's
	// gitdir file if that ever happens.
	const entry = path.join(dir, path.basename(worktreePath));
	// Like git's prune, a locked entry stays: its lock protects the index (add then fails loudly).
	if (lstatSync(path.join(entry, "locked"), { throwIfNoEntry: false })) return;
	if (!liveAdminEntry(entry)) removeBelow(anchor, entry);
}

/**
 * True when the admin entry's gitdir file names a checkout that still exists: a same-named
 * worktree elsewhere, never this card's stale one. O_NONBLOCK: a planted FIFO cannot hang
 * the board, and O_NOFOLLOW reads no planted link.
 */
function liveAdminEntry(entry: string): boolean {
	let fd: number;
	try {
		fd = openSync(
			path.join(entry, "gitdir"),
			constants.O_RDONLY |
				(constants.O_NONBLOCK ?? 0) |
				(constants.O_NOFOLLOW ?? 0),
		);
	} catch {
		return false; // no readable gitdir file: git itself prunes such an entry
	}
	try {
		return existsSync(readFileSync(fd, "utf8").trim());
	} finally {
		closeSync(fd);
	}
}

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
	readBelow,
	readRegular,
	removeBelow,
	trustedAnchor,
	writeBelow,
} from "./confine.ts";
import { githubHost, hostMatcher } from "./githubHost.ts";
import { type CommitIdentity, identityArgs } from "./gitIdentity.ts";
import { HOSTED_SECRET_ENV } from "./hosted.ts";
import { platform } from "./platform/index.ts";
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

/** One hosted network git call's auth: the env, and the redaction list of the project that
 * owns cwd (every token the board minted for it, docs/specs/hosted-mode.md section 6). */
export interface HostedNetworkAuth {
	env: Record<string, string>;
	secrets: readonly string[];
}

/** Hosted mode's per-project git credential; createHostedGitAuth in gitHosts.ts builds it. */
export interface HostedGitAuth {
	network(cwd: string, args: readonly string[]): Promise<HostedNetworkAuth>;
	/** The auth for a clone of a project that is not registered yet: minted for (name, remote). */
	pending(name: string, remote: string): Promise<HostedNetworkAuth>;
	/** The token for a gh call of the project that owns cwd; null when there is none. */
	ghToken(cwd: string, remote: string): Promise<string | null>;
}

/** Set: network git asks it instead of the resolver above. null on every self-hosted board. */
let hostedAuth: HostedGitAuth | null = null;
export function setHostedGitAuth(a: HostedGitAuth | null): void {
	hostedAuth = a;
}
export function hostedGitAuth(): HostedGitAuth | null {
	return hostedAuth;
}

/** Deletes every git host credential name in place: GH_TOKEN, GITHUB_TOKEN,
 * GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN and the `GIT_AUTH_ENV_NAME` set. Local
 * board git and every worker turn run without them; a turn may hold only the delivered
 * read-only token (docs/specs/turn-read-token.md). */
export function stripGitAuthEnv(env: Record<string, string | undefined>): void {
	delete env.GH_TOKEN;
	delete env.GITHUB_TOKEN;
	delete env.GH_ENTERPRISE_TOKEN;
	delete env.GITHUB_ENTERPRISE_TOKEN;
	for (const k of Object.keys(env)) {
		if (GIT_AUTH_ENV_NAME.test(k)) delete env[k];
	}
}

/** Proxy URL variable names (`i` flag covers the lower-case twins); NO_PROXY is a host
 * list, never a URL with credentials, and never matches. */
const PROXY_URL_ENV = /^(HTTPS?_PROXY|ALL_PROXY)$/i;

/** Rewrites every proxy URL variable in place without its userinfo: the corporate proxy's
 * `http://user:pass@proxy:8080` becomes `http://proxy:8080`, so no turn env carries the
 * credentials. A value without userinfo, or without a `scheme://` authority to hang a
 * userinfo on (`user:pass@proxy:8080`, `http:proxy:8080`), stays byte-identical: never
 * mangle a proxy value the strip cannot read confidently. */
export function stripProxyCredentials(
	env: Record<string, string | undefined>,
): void {
	for (const k of Object.keys(env)) {
		if (!PROXY_URL_ENV.test(k)) continue;
		const value = env[k];
		if (value === undefined) continue;
		const stripped = value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, "$1");
		if (stripped !== value) env[k] = stripped;
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
	const hosted =
		isNetwork && authEnv === undefined && hostedAuth !== null
			? await hostedAuth.network(cwd, args)
			: null;
	const auth = isNetwork ? (authEnv ?? hosted?.env ?? networkGitAuth(cwd)) : {};
	// The redaction list is fixed at spawn: the stored secrets now, plus the tokens this call
	// itself carries. A token rotated or removed while the call runs stays redacted in its output.
	const list = [
		...secrets,
		...(hosted?.secrets ?? []),
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
 * calls run against a board-written stub gitdir instead: HEAD as a sha (symbolic when
 * HEAD is unborn, so an unborn repo keeps the same seal), the worktree's own index and
 * objects, a copy of the main checkout's info/exclude, no repo config. Tracked
 * .gitattributes still apply, but they can only name drivers of system, global or
 * command-line config (git-lfs). A partial clone's promisor remote (name, url, filter) is
 * copied, so a missing blob still fetches lazily; that fetch reads the stub too, never the
 * planted remote keys (uploadpack, sshCommand, helpers), and its ssh runs pinned
 * (`ssh -F /dev/null -o BatchMode=yes`, transports https:ssh), so the shared home ssh
 * config never reaches it. Callers pass
 * `--ignore-submodules=dirty`: a submodule status runs git in the submodule's own gitdir,
 * which is planted the same way. dirtySubmodules probes each submodule through this stub.
 */
export async function sealedGit(
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
	const [gitDir = "", common = "", format = "", head = ""] =
		info.stdout.split("\n");
	// Both values land in the stub's files: a planted objectformat must not inject config lines.
	if (!/^(sha1|sha256)$/.test(format)) {
		// A broken repo keeps its real error; a planted format string fails closed.
		if (info.code !== 0) return info;
		return {
			code: 128,
			stdout: "",
			stderr: `unexpected git rev-parse output: ${info.stdout.trim()}`,
		};
	}
	// An unborn HEAD must not turn the seal off: a work turn can leave HEAD unborn
	// while the index keeps every staged entry (`git checkout --orphan`, a
	// hand-written HEAD ref), so plain status would still hash dirty files there.
	// The stub keeps HEAD symbolic — the empty-tree base git itself uses for an
	// unborn branch — so the sealed call answers as plain git would. Anything that
	// is neither a sha nor a real symbolic ref fails closed.
	let stubHead = `${head}\n`;
	if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
		const unborn = await git(["symbolic-ref", "HEAD"], worktreePath);
		const name = unborn.stdout.trim();
		if (unborn.code !== 0 || !/^refs\/\S+$/.test(name))
			return {
				code: 128,
				stdout: "",
				stderr: `unexpected git rev-parse output: ${info.stdout.trim()}`,
			};
		stubHead = `ref: ${name}\n`;
	}
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
		writeFileSync(path.join(stub, "HEAD"), stubHead);
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
/** The cut release emits up to: all of `held`, or the longest-secret holdback, moved back so it never cuts inside a match. */
function releaseCut(
	held: string,
	live: readonly string[],
	all: boolean,
): number {
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
	return cut;
}

export function redactingWriter(
	emit: (s: string) => void,
	list: () => readonly string[],
): { write(s: string): void; flush(): void } {
	let held = "";
	const release = (all: boolean): void => {
		const live = list().filter((s) => s !== "");
		const cut = releaseCut(held, live, all);
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

/** Rules are available: the main checkout has AGENTS.md or .omp/AGENTS.md, or the target
 * tracks AGENTS.md (targetRules is the scheduler tick's cached git fact, Entry.targetRules;
 * a fresh worktree then carries the file from the checkout). */
export function hasRules(mainPath: string, targetRules = false): boolean {
	return (
		existsSync(path.join(mainPath, "AGENTS.md")) ||
		existsSync(path.join(mainPath, ".omp", "AGENTS.md")) ||
		targetRules === true
	);
}

/** True when the target ref's tree holds AGENTS.md; a null target and a failed read (the
 * ref or the path missing) count as no. Reads real git state. */
export async function targetTracksRules(
	mainPath: string,
	target: string | null,
): Promise<boolean> {
	if (target === null || target === "") return false;
	const r = await git(["cat-file", "-e", `${target}:AGENTS.md`], mainPath);
	return r.code === 0;
}

/** HTTPS URL of the main checkout's GitHub remote on the configured host (origin preferred);
 * null when it has none. */
export async function githubUrl(
	mainPath: string,
	host: string = githubHost().host,
): Promise<string | null> {
	const r = await git(["remote", "-v"], mainPath);
	if (r.code !== 0) return null;
	const hostRe = new RegExp(
		`${hostMatcher(host).source}(.+?)(?:\\.git)?$`,
		"i",
	);
	const byName = new Map<string, string>();
	for (const line of r.stdout.split("\n")) {
		const [name = "", url = "", kind = ""] = line.trim().split(/\s+/);
		const m = kind === "(push)" ? hostRe.exec(url) : null;
		if (m?.[1]) byName.set(name, `https://${host}/${m[1]}`);
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
 * configured-host view the release flow uses. */
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

/** Version the board shows: the release stamp baked into the image first (OTTR_VERSION; the
 * image ships no .git to describe), then the newest release tag reachable from HEAD
 * (`vX.Y.Z`, or `vX.Y.Z-N-g<short>` when HEAD sits past it), the short HEAD sha on a dev
 * checkout with no release, and headVersion's boot-time fallback when git is unusable. */
export async function describeVersion(dir: string): Promise<string> {
	const stamp = process.env.OTTR_VERSION?.trim();
	if (stamp !== undefined && stamp !== "") return stamp;
	try {
		const r = await git(
			["describe", "--tags", "--match", "v[0-9]*", "HEAD"],
			dir,
		);
		if (r.code === 0 && r.stdout.trim() !== "") return r.stdout.trim();
		const sha = await git(["rev-parse", "--short", "HEAD"], dir);
		if (sha.code === 0 && sha.stdout.trim() !== "") return sha.stdout.trim();
	} catch {
		// git missing or unusable
	}
	return headVersion(dir);
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

/**
 * Resolution ladder for the target, in order:
 * 1. `targetBranch` set (project setting): target = `origin/<targetBranch>`; the main
 *    checkout's checked-out branch and its upstream stay irrelevant. A target that does
 *    not resolve fails loudly, never falls back to the checked-out branch.
 * 2. `targetBranch` null: `origin/HEAD` names the repo's default branch — target =
 *    `origin/<default>`. No `origin/HEAD` (solo repo, clone without it): today's
 *    derivation — the canonical `origin/<short>` for an origin upstream of the
 *    checked-out branch, else the upstream as registered, else the checked-out branch.
 * fetch (before a new worktree): refresh the upstream first. A failed fetch only warns, but an upstream
 * that still doesn't resolve stops, instead of silently basing the work on the local branch.
 * The fetch names the server-pinned originUrl with an explicit refspec (R5-1,
 * docs/specs/pinned-origin-url.md): a work turn can re-point remote names and the configured
 * refspecs through the worker-writable .git/config, and a fetch by name would run the named
 * repo's upload-pack in the server's git next to the tokens. No pin yet — or an upstream the
 * pin does not cover (a fork remote, a merge ref outside refs/heads) — skips the fetch with
 * a warning, the same degraded state as a failed fetch.
 */
/** git's word for a fetch of a ref the remote does not have (OTTR-605): the only fetch
 * failure that proves the remote branch is absent, so a network or auth outage never
 * poses as an empty origin. */
const REMOTE_REF_MISSING = /couldn't find remote ref refs\/heads\//;
export async function resolveTarget(
	mainPath: string,
	fetch = false,
	originUrl: string | null = null,
	targetBranch: string | null = null,
): Promise<{
	target: string;
	sha: string;
	warning: string | null;
	/** OTTR-605: set on the aspirational resolution of an origin that has no branch for
	 * the local branch yet — `target` is origin/<branch>, `sha` is the local branch's tip
	 * (origin has none). The board lifts mainUnpushed from it (refreshRemote) so the
	 * "Push to origin" advisory shows before the first tick. */
	unpushed?: true;
}> {
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
	if (targetBranch !== null) {
		// Project setting wins: the checked-out branch and its upstream are irrelevant.
		return resolveLadderTarget(mainPath, fetch, originUrl, {
			target: `origin/${targetBranch}`,
			remote: "origin",
			remoteRef: `refs/heads/${targetBranch}`,
			short: targetBranch,
			branch: targetBranch,
			upstream: "",
			fetchErrorNote: `cannot resolve origin/${targetBranch}`,
		});
	}
	// The repo's default branch, when origin/HEAD names one; else the checked-out
	// branch's upstream derivation below (byte-for-byte today's behavior).
	const def = await git(
		["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
		mainPath,
	);
	if (def.code === 0) {
		const defaultBranch = def.stdout
			.trim()
			.replace(/^refs\/remotes\/origin\//, "");
		return resolveLadderTarget(mainPath, fetch, originUrl, {
			target: `origin/${defaultBranch}`,
			remote: "origin",
			remoteRef: `refs/heads/${defaultBranch}`,
			short: defaultBranch,
			branch: defaultBranch,
			upstream: "",
			fetchErrorNote: `cannot resolve origin/${defaultBranch}`,
		});
	}
	// The configured upstream, even when its remote-tracking ref is missing (@{u} fails then).
	const fmt =
		"--format=%(upstream:short) %(upstream:remotename) %(upstream:remoteref)";
	const up = await git(["for-each-ref", fmt, `refs/heads/${branch}`], mainPath);
	if (up.code !== 0)
		throw new Error(`git for-each-ref failed: ${up.stderr.trim()}`);
	const [upstream = "", remote = "", remoteRef = ""] = up.stdout
		.trim()
		.split(" ");
	// R5-1 (docs/specs/pinned-origin-url.md): the board names its integration target
	// canonically (`origin/<branch>`); the `upstream:short` rendering follows a planted
	// remote.origin.fetch refspec, which would point the target into a planted namespace.
	// An upstream on another remote (a fork) keeps its own name.
	const short = remoteRef.startsWith("refs/heads/")
		? remoteRef.slice("refs/heads/".length)
		: null;
	return resolveLadderTarget(mainPath, fetch, originUrl, {
		target:
			remote === "origin" && short !== null
				? `origin/${short}`
				: upstream || branch,
		remote,
		remoteRef,
		short,
		branch,
		upstream,
		fetchErrorNote: null,
	});
}

/** The pinned-URL fetch for an origin target; its warning, or null when nothing fetched or the fetch succeeded. */
async function pinnedFetch(
	mainPath: string,
	fetch: boolean,
	originUrl: string | null,
	o: {
		target: string;
		remote: string;
		remoteRef: string;
		short: string | null;
		upstream: string;
	},
): Promise<string | null> {
	if (!fetch || o.remote === "") return null;
	// ponytail: a remote branch deleted since the last fetch only warns (its stale ref still resolves); add `git ls-remote --exit-code` if that bites
	if (o.remote === "origin" && o.short !== null) {
		// R5-1: fetch the pinned origin URL with an explicit refspec into the canonical
		// tracking ref — a planted remote.origin.url and the configured refspecs stay
		// irrelevant. No pin yet: skip (same degraded state as a failed fetch), never a
		// fetch by the worker-writable name.
		if (originUrl === null)
			return `the origin URL is not pinned yet; using the last fetched ${o.target}`;
		const guard = await checkPinnedRemote(mainPath, originUrl);
		if (guard !== null) return `not fetching ${o.target}: ${guard}`;
		const f = await git(
			[
				"fetch",
				"--quiet",
				originUrl,
				`+${o.remoteRef}:refs/remotes/origin/${o.short}`,
			],
			mainPath,
		);
		if (f.code !== 0)
			return `git fetch ${originUrl} ${o.remoteRef} failed: ${f.stderr.trim()}`;
		return null;
	}
	// R5-1: a fetch by remote name runs the named repo's upload-pack in the server's
	// git next to the tokens (a plantable uploadpack.packObjectsHook executes there).
	// The board targets origin/<branch> only; any other upstream (a fork remote, a
	// merge ref outside refs/heads) skips the refresh with the same warning a failed
	// fetch gets, instead of trusting a plantable name.
	return `not fetching ${o.upstream || o.remote}: the board fetches only the pinned origin`;
}

/** OTTR-605, derivation half: with no upstream and no origin/HEAD the ladder falls back
 * to the bare local branch — a target the board never pushes. When origin exists but
 * has no branch for the local branch yet (the new-project wizard pointed at an empty
 * repo), aim the target at origin/<branch> instead, so the empty-origin resolution in
 * the failure half below applies. Probed only on this rare fallback shape: a healthy
 * clone has origin/HEAD or an upstream and never pays for the three local git reads. */
async function deriveTarget(
	mainPath: string,
	o: {
		remote: string;
		branch: string;
		upstream: string;
		/** Loud error when the target does not resolve and no upstream message applies. */
		fetchErrorNote: string | null;
	},
	target: string,
): Promise<{ target: string; emptyOriginAim: boolean }> {
	if (
		o.fetchErrorNote !== null ||
		o.remote !== "" ||
		o.upstream !== "" ||
		target !== o.branch
	)
		return { target, emptyOriginAim: false };
	const [local, tracking, originGet] = await Promise.all([
		git(
			["rev-parse", "--verify", "--quiet", `refs/heads/${o.branch}`],
			mainPath,
		),
		git(
			["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${o.branch}`],
			mainPath,
		),
		git(["remote", "get-url", "origin"], mainPath),
	]);
	if (local.code === 0 && tracking.code !== 0 && originGet.code === 0)
		return { target: `origin/${o.branch}`, emptyOriginAim: true };
	return { target, emptyOriginAim: false };
}

/** OTTR-605, failure half: the aspirational resolution of an origin that exists but has
 * no branch for the local branch yet, or null when it does not apply and the standard
 * throws must run. When the derivation names the checked-out branch and the local
 * branch holds a commit, resolve origin/<branch> aspirationally: fetch=false
 * callers (refreshRemote, boot) get the target plus the unpushed flag, so the
 * project view shows the target and the "Push to origin" advisory at once, and the
 * tick's branchUnpushed keeps the flag true. A fetch=true caller (merge turn,
 * release, review) must not base work on a commit origin does not have, so it
 * still fails — but with a reason that names the button instead of a manual git
 * command, and only when the missing branch is proven (a fetch that failed naming
 * the remote ref, or no fetch being possible at all), so a network outage or auth
 * failure never poses as an empty origin. */
async function unpushedOutcome(
	mainPath: string,
	fetch: boolean,
	fetchError: string | null,
	o: {
		remote: string;
		short: string | null;
		branch: string;
		/** Loud error when the target does not resolve and no upstream message applies. */
		fetchErrorNote: string | null;
	},
	emptyOriginAim: boolean,
	target: string,
): Promise<{
	target: string;
	sha: string;
	warning: string;
	unpushed: true;
} | null> {
	const aimsAtLocalBranch =
		emptyOriginAim || (o.remote === "origin" && o.short === o.branch);
	if (o.fetchErrorNote !== null || !aimsAtLocalBranch) return null;
	const [local, tracking, originGet] = await Promise.all([
		git(
			["rev-parse", "--verify", "--quiet", `refs/heads/${o.branch}`],
			mainPath,
		),
		git(
			["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${o.branch}`],
			mainPath,
		),
		o.remote === "origin"
			? Promise.resolve({ code: 0, stdout: "", stderr: "" })
			: git(["remote", "get-url", "origin"], mainPath),
	]);
	const emptyOrigin =
		local.code === 0 && tracking.code !== 0 && originGet.code === 0;
	// fetch=true with an origin upstream runs the pinned fetch above, so a null
	// fetchError cannot coexist with an unresolvable ref there; the no-fetch forms
	// (fetch=false, or the derivation never names a fetchable remote) rest on the
	// same local knowledge the board's fetch=false paths use.
	const proven =
		!fetch ||
		o.remote === "" ||
		(fetchError !== null && REMOTE_REF_MISSING.test(fetchError));
	if (!emptyOrigin || !proven) return null;
	if (fetch) {
		throw new Error(
			`origin has no ${o.branch} branch yet, so ${target} cannot resolve. Push the local ${o.branch} with the board's "Push to origin" button, then reply to this card.`,
		);
	}
	return {
		target,
		sha: local.stdout.trim(),
		warning: `origin has no ${o.branch} branch yet; the board targets origin/${o.branch} and treats the local ${o.branch} as unpushed until it is pushed`,
		unpushed: true,
	};
}

/** Shared tail of the ladder: the pinned-URL fetch for an origin target, then resolve the target's sha. */
async function resolveLadderTarget(
	mainPath: string,
	fetch: boolean,
	originUrl: string | null,
	o: {
		target: string;
		remote: string;
		remoteRef: string;
		short: string | null;
		branch: string;
		upstream: string;
		/** Loud error when the target does not resolve and no upstream message applies. */
		fetchErrorNote: string | null;
	},
): Promise<{
	target: string;
	sha: string;
	warning: string | null;
	/** OTTR-605: set on the aspirational resolution of an origin that has no branch for
	 * the local branch yet; resolveTarget passes it through (see the type there). */
	unpushed?: true;
}> {
	// OTTR-605 may re-aim this at origin/<branch> before the rev-parse (see below).
	const fetched = await pinnedFetch(mainPath, fetch, originUrl, o);
	const derived = await deriveTarget(mainPath, o, o.target);
	const target = derived.target;
	const sha = await git(
		["rev-parse", "--verify", "--quiet", `${target}^{commit}`],
		mainPath,
	);
	if (sha.code !== 0) {
		const unpushed = await unpushedOutcome(
			mainPath,
			fetch,
			fetched,
			o,
			derived.emptyOriginAim,
			target,
		);
		if (unpushed !== null) return unpushed;
		if (o.fetchErrorNote !== null) throw new Error(o.fetchErrorNote);
		if (!o.upstream) throw new Error(`cannot resolve ${target}`);
		throw new Error(
			`upstream ${target} of ${o.branch} not found${fetched ? ` (${fetched})` : ""}; push ${o.branch} or set its upstream with git branch -u`,
		);
	}
	return {
		target,
		sha: sha.stdout.trim(),
		warning: fetched && `${fetched}; using ${target} as last fetched`,
	};
}

/** Adds the worktree, reusing one a crashed attempt left behind when it is still linked.
 * Reuse is decided by behavior, not by comparing registered path strings: on Windows git prints
 * long paths while Node may hold 8.3 short forms (RUNNER~1), so a textual set lookup misreads a
 * registered worktree as a scratch dir and deletes it behind git's back, and the next add dies
 * with "already registered". Returns true when a fresh add ran. */
async function addWorktree(o: {
	mainPath: string;
	worktreePath: string;
	branch: string;
	base: string;
	log: (line: string) => void;
}): Promise<boolean> {
	const onDisk = existsSync(o.worktreePath);
	if (onDisk && (await worktreeLinked(o.worktreePath))) {
		o.log(`reusing worktree ${o.worktreePath} on ${o.branch}`);
		return false;
	}
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
	return true;
}

/** The checkout `worktree add` would run, minus planted smudge drivers (sealedGit). */
async function checkoutFresh(worktreePath: string): Promise<void> {
	// ponytail: a crash between add and this checkout leaves an empty worktree that a retry
	// reuses as is; check for the missing index on reuse if that ever bites.
	const co = await sealedGit(
		["reset", "--hard", "--no-recurse-submodules", "-q"],
		worktreePath,
	);
	if (co.code !== 0)
		throw new Error(`git checkout of the worktree failed: ${co.stderr.trim()}`);
}

/** Logs the skip of a candidate the base already tracks, naming the rules conflict when
 * the local AGENTS.md differs from the base's (the target ships its own rules now). */
async function logSkippedTracked(
	o: { mainPath: string; base: string; log: (line: string) => void },
	relFwd: string,
): Promise<void> {
	o.log(`skipped ${relFwd}: ${o.base} tracks it`);
	if (relFwd !== "AGENTS.md") return;
	const local = readRegular(path.join(o.mainPath, relFwd)).toString("utf8");
	const atBase = await git(["show", `${o.base}:AGENTS.md`], o.mainPath);
	if (atBase.code !== 0)
		throw new Error(`git show failed: ${atBase.stderr.trim()}`);
	if (local.replaceAll("\r\n", "\n") !== atBase.stdout.replaceAll("\r\n", "\n"))
		o.log(
			"! the target now tracks AGENTS.md; move your local rules to .omp/AGENTS.md",
		);
}

/** Copies the untracked candidate files (rules, .omp, copy extras) into the worktree; returns the copied paths. */
async function copyUntracked(o: {
	mainPath: string;
	worktreePath: string;
	base: string;
	copyExtra: string[];
	log: (line: string) => void;
}): Promise<string[]> {
	const candidates = ["AGENTS.md", ".omp", ...o.copyExtra].filter((p) =>
		existsSync(path.join(o.mainPath, p)),
	);
	const copied: string[] = [];
	if (candidates.length === 0) return copied;
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
	// A path the base already tracks comes with the checkout: overwriting it with the
	// main checkout's stale local copy would dirty every fresh worktree (the main
	// checkout can sit behind the target that just started shipping its own rules).
	const tree = await git(
		["ls-tree", "-r", "--name-only", "-z", o.base],
		o.mainPath,
	);
	if (tree.code !== 0)
		throw new Error(`git ls-tree failed: ${tree.stderr.trim()}`);
	const trackedAtBase = new Set(tree.stdout.split("\0"));
	for (const rel of ls.stdout.split("\0")) {
		if (rel === "") continue;
		if (/^\.env/i.test(path.posix.basename(rel.replaceAll("\\", "/"))))
			continue;
		const relFwd = rel.replaceAll("\\", "/");
		if (trackedAtBase.has(relFwd)) {
			await logSkippedTracked(o, relFwd);
			continue;
		}
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
	return copied;
}

/** Adds the copied untracked files to .git/info/exclude, then proves the worktree clean. */
async function excludeAndVerify(
	o: {
		mainPath: string;
		worktreePath: string;
		log: (line: string) => void;
	},
	copied: string[],
): Promise<void> {
	if (copied.length === 0) return;
	const exclude = await excludeFile(o.mainPath);
	// Exclude lines accumulate across attempts (a repeated add appends the same line
	// again); append only when the exact line is not there yet.
	const excludeLines = new Set(
		(readBelow(exclude.anchor, exclude.file, 1024 * 1024) ?? Buffer.alloc(0))
			.toString("utf8")
			.split("\n"),
	);
	for (const rel of copied) {
		const relFwd = rel.replaceAll("\\", "/");
		const ci = await git(["check-ignore", "-q", "--", rel], o.worktreePath);
		if (ci.code === 1) {
			if (!excludeLines.has(`/${relFwd}`)) {
				appendLineBelow(exclude.anchor, exclude.file, `/${relFwd}`);
				excludeLines.add(`/${relFwd}`);
				o.log(`added /${relFwd} to .git/info/exclude`);
			}
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
		throw new Error(`worktree not clean after copying rules:\n${st.stdout}`);
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
	// failing with "branch already exists".
	const fresh = await addWorktree(o);
	o.log(`worktree ${o.worktreePath} on ${o.branch}`);

	try {
		if (fresh) await checkoutFresh(o.worktreePath);
		const copied = await copyUntracked(o);
		await excludeAndVerify(o, copied);
	} catch (e) {
		// worktree add succeeded; roll it back so a retry doesn't hit "already exists"
		try {
			await removeWorktree({
				mainPath: o.mainPath,
				worktreePath: o.worktreePath,
				branch: o.branch,
				log: o.log,
			});
		} catch (rmErr) {
			o.log(
				`cleanup after failed createWorktree failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
			);
		}
		throw e;
	}
}

/**
 * OTTR-697, worktrunk's `wt remove --reap` pattern: a process a turn left behind and that
 * reparented to init (a leftover dev server) escapes killTree's descendant walk, and its
 * working directory sits in the tree the caller is about to destroy. The reap therefore runs
 * before the first removal attempt: the holder loses its files either way, so a holder-caused
 * failure never starts. An errno-reactive reap cannot do this job — a held cwd does not fail
 * rmdir on Linux, so EBUSY/EPERM never names the holder there, and reacting to an unrelated
 * EPERM would turn it into kills. Discovery is the platform's read-only sweep; it never names
 * the tracker's own tree or a process holding a controlling terminal (interactive shells,
 * editors). Every kill lands in the task log with pid, command and reason. No-op on platforms
 * whose discovery has no data (Windows, non-Linux).
 */
function reapHolders(root: string, log?: (line: string) => void): void {
	for (const holder of platform.processesWithCwdUnder(root)) {
		log?.(
			`reap: killing ${holder.pid} (${holder.cmd}): its working directory sits inside the worktree being removed`,
		);
		platform.killTree(holder.pid);
	}
}

export async function removeWorktree(o: {
	mainPath: string;
	worktreePath: string;
	branch: string | null;
	/** Task-log hook: reap kills land here; callers pass their card log. */
	log?: (line: string) => void;
}): Promise<void> {
	await guardAdminEntries(o.mainPath, null);
	// Reap before the first attempt (see reapHolders): never as a reaction to an errno.
	if (existsSync(o.worktreePath)) reapHolders(o.worktreePath, o.log);
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
 * Worker-writable roots for the pinned-origin check (R5-1): compose mounts the project roots
 * (OMP_TRACKER_ROOTS, /workspace), OTTR_DATA_DIR (/data) and the shared home volume (/root)
 * into every worker read-write, so a repo under them is a repo a work turn can rewrite, and
 * a push runs its pre-receive hook in the server's git next to the tokens. Set once at boot,
 * only when OTTR_DATA_DIR names a worker boundary; empty (native single-user boards, tests)
 * allows every local pin.
 */
let workerRoots: readonly string[] = [];
export function setWorkerRoots(roots: readonly string[]): void {
	workerRoots = roots.map((r) => path.resolve(r));
}

/** The local path a pinned URL names, resolved; null when the URL is not local
 * (https/ssh and other schemes, scp-style ssh). A `file://` URL is always local: current
 * git ignores its authority and serves the path after the first raw `/` locally, and with
 * no raw `/` it url-decodes the whole remainder as the path — both forms get the
 * worker-root check. Without a scheme, git reads scp-style ssh only when the first colon
 * precedes the first slash (connect.c url_is_local_not_ssh) — `./x:y.git` and `../bare.git`
 * are local paths and get the worker-root check. */
function localPinPath(mainPath: string, pinned: string): string | null {
	if (/^file:\/\//i.test(pinned)) {
		const slash = pinned.indexOf("/", 7);
		return path.resolve(
			mainPath,
			decodeURIComponent(pinned.slice(slash === -1 ? 7 : slash)),
		);
	}
	if (/^[A-Za-z]:[\\/]/.test(pinned) || pinned.startsWith("\\\\"))
		return path.resolve(pinned);
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(pinned)) return null; // https:, ssh:, ext::, …
	if (pinned.startsWith("/")) return path.resolve(pinned);
	const colon = pinned.indexOf(":");
	if (colon === -1) return path.resolve(mainPath, pinned);
	const slash = pinned.indexOf("/");
	return slash !== -1 && slash < colon ? path.resolve(mainPath, pinned) : null;
}

const sameOrUnder = (child: string, root: string): boolean => {
	const rel = path.relative(root, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Refuses to run network git for a pinned origin URL that a work turn could have bent (R5-1,
 * docs/specs/pinned-origin-url.md): a local pin under a worker-writable root would push into
 * a repo the turn can rewrite; a pin that is not a URL or path (a leading `-` would parse as
 * a git option and could drop the repository argument, falling back to the planted default
 * remote) is refused; and an `url.<base>.insteadOf` or `url.<base>.pushInsteadOf` entry
 * matching the pin (any config scope — the repo config is worker-writable) would redirect the
 * call to a repo the pin never named. git's rewrite rule is over-approximated to fail closed:
 * any matching prefix refuses, whatever the longest-match outcome would be. The config read is
 * a local subcommand: gitEnv strips the auth env from it. Returns the error text, else null.
 */
export async function checkPinnedRemote(
	mainPath: string,
	pinned: string,
): Promise<string | null> {
	if (pinned.startsWith("-"))
		return `the pinned origin ${pinned} is not a URL or path; re-pin the origin remote`;
	const local = localPinPath(mainPath, pinned);
	if (local !== null) {
		const root = workerRoots.find((root) => sameOrUnder(local, root));
		if (root !== undefined)
			return `the pinned origin ${pinned} sits under worker-writable ${root}; the board never pushes or fetches a repo a work turn can rewrite`;
	}
	const r = await git(["config", "--list", "-z"], mainPath);
	for (const entry of r.stdout.split("\0")) {
		const nl = entry.indexOf("\n");
		if (nl === -1) continue;
		// Both rewrite keys: insteadOf bends fetches, pushInsteadOf bends pushes only —
		// either would send the pinned call to a repo the pin never named.
		if (!/^url\..*\.(?:push)?insteadof$/i.test(entry.slice(0, nl))) continue;
		if (pinned.startsWith(entry.slice(nl + 1)))
			return `repo config rewrites the pinned origin: an url.<…>.(push)insteadOf entry matches it; remove that entry, the board pushes and fetches only the pinned URL`;
	}
	return null;
}

/**
 * The raw URL of the origin remote, read once to pin it (docs/specs/pinned-origin-url.md);
 * null when origin is missing or git cannot read it. `get-url` applies `insteadOf`, so a
 * rewrite planted before the pin lands is stored rewritten — and every use still runs
 * checkPinnedRemote, which refuses while that entry exists.
 */
export async function originRemoteUrl(
	mainPath: string,
): Promise<string | null> {
	const r = await git(["remote", "get-url", "origin"], mainPath);
	return r.code === 0 ? r.stdout.trim() || null : null;
}

/**
 * Replaces userinfo in URLs ("//user:pass@host") with "[REDACTED]": git echoes the configured
 * URL in push and fetch errors, and a pinned origin URL may embed credentials. Hosts without
 * userinfo stay byte-identical; scp-style remotes ("git@host:path") carry no credential.
 */
export function redactUrlCredentials(text: string): string {
	return text.replace(
		/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s@/]*@/g,
		(m) => `${m.slice(0, m.indexOf("://") + 3)}[REDACTED]@`,
	);
}

/** stderr lines that name a push failure's cause; hint lines stay out of needsReason. */
const PUSH_REASON_LINE = /^\s*(?:!\s*\[|error:|fatal:|remote:)/;
/** OTTR-743: the remote's race wording — the ref moved between the push's negotiation and its update. */
const CANNOT_LOCK_REF_RE = /cannot lock ref/;
/** Output prefix of a failed push whose head the remote already holds; turn.ts logs it as the done reason. */
export const PUSH_LANDED_BEFORE_ATTEMPT =
	"push landed on origin before this attempt";
/** Card-log cap for a push's full output; the reason lines stay complete above it (same shape as the hold diff cap). */
const PUSH_OUTPUT_MAX = 200_000;

/** The push's full output for the card log; undefined when git said nothing. */
function cappedPushOutput(text: string): string | undefined {
	if (text === "") return undefined;
	return text.length > PUSH_OUTPUT_MAX
		? `${text.slice(0, PUSH_OUTPUT_MAX)}\n… push output truncated at 200 KB`
		: text;
}

/**
 * The server's merge push (no agent holds git host credentials; the merge prompt tells the
 * agent not to push). Pushes the local target branch to the pinned origin when origin lacks
 * its tip and the main repo proves the local merge. The proof is the worktree's HEAD, else the task branch,
 * in the local branch. A merge agent may remove both before it reports (a project's AGENTS.md
 * can say so). Then the local branch ahead of origin is the proof: only merge turns move it.
 * git() adds the host auth: per-host tokens or the ssh key, and GH_TOKEN for GitHub. The local
 * tip is refs/heads/<branch>: `origin/<branch>` names the remote-tracking ref, which only this
 * push moves. A hold-approved merge passes `leaseTip` (OTTR-274): the audited origin tip the
 * gate fetched. The push then requires the local target to contain that tip, and pins the
 * remote with --force-with-lease, so a merge agent cannot aim the gate's fetch at one remote
 * and the push at another: the real remote rejects any push whose lease does not match.
 * The push names `originUrl` — the server-pinned URL (project settings), never the remote
 * name: a work turn can re-point a name through the worker-writable .git/config, and the
 * named repo's pre-receive hook would run here. A null pin, or one checkPinnedRemote
 * refuses, fails closed. A push git rejects because the remote moved (a non-fast-forward,
 * "fetch first", or a --force-with-lease "stale info") returns `rejected` (OTTR-394), so the
 * merge turn can queue its own rebase; any other failure stays `failed`. A failed or
 * rejected push carries `error` with every reason line ("! [rejected]", "remote:", "fatal:",
 * "error:") and `output` with git's complete output (OTTR-465), so the card log shows the
 * cause a permission failure points at.
 */
/** The merge-hold gate: the audited origin tip must be contained in the local branch. Null when it holds. */
async function holdGate(
	mainPath: string,
	leaseTip: string,
	branch: string,
): Promise<{ status: "failed"; error: string } | null> {
	const pinned = await git(
		["merge-base", "--is-ancestor", leaseTip, `refs/heads/${branch}`],
		mainPath,
	);
	if (pinned.code === 0) return null;
	return {
		status: "failed",
		error: `merge-hold gate: the audited origin tip ${leaseTip} is not contained in refs/heads/${branch}`,
	};
}

/** The commit this merge would integrate: the worktree HEAD when linked, else the task branch's tip; null when neither applies. */
async function integrationHead(
	worktreePath: string,
	taskBranch: string,
	sha: (ref: string, cwd?: string) => Promise<string | null>,
): Promise<string | null> {
	if (await worktreeLinked(worktreePath)) return sha("HEAD", worktreePath);
	return taskBranch === "" ? null : sha(`refs/heads/${taskBranch}`);
}

/** Result of serverMergePush and its helpers. */
type MergePushResult =
	| { status: "skipped" }
	| { status: "pushed"; output: string }
	| { status: "failed"; error: string; output?: string }
	| { status: "rejected"; error: string; output?: string };

/** The bookkeeping a landed push runs: record the tip (R5-1) and track the branch on
 * origin (OTTR-605). Shared by the direct-success path and the OTTR-743 landed-before-attempt
 * path. */
async function recordLandedPush(
	mainPath: string,
	branch: string,
	tip: string,
): Promise<void> {
	await git(["update-ref", `refs/remotes/origin/${branch}`, tip], mainPath);
	await git(["branch", "-u", `origin/${branch}`, branch], mainPath);
}

/** OTTR-743: a "cannot lock ref" rejection is the remote's race wording — another writer
 * moved the ref between this push's negotiation and its update (an earlier attempt of
 * the same push landed, or a parallel push carried the head). When the fetched target
 * already contains the pushed head, the push's goal is already met: run the same
 * bookkeeping a successful push runs and land the card instead of parking it. A fetch
 * that fails, or a remote tip that does not contain the head, keeps today's
 * retry-then-park behavior with the full output. */
async function lockRefAlreadyLanded(
	mainPath: string,
	branch: string,
	originUrl: string,
	local: string,
): Promise<MergePushResult | null> {
	const fetchError = await fetchOriginBranch(mainPath, branch, originUrl);
	if (fetchError !== null) return null;
	const tip = await git(
		[
			"rev-parse",
			"--verify",
			"--quiet",
			`refs/remotes/origin/${branch}^{commit}`,
		],
		mainPath,
	);
	const remoteTip = tip.code === 0 ? tip.stdout.trim() : null;
	if (remoteTip === null) return null;
	const landed = await git(
		["merge-base", "--is-ancestor", local, remoteTip],
		mainPath,
	);
	if (landed.code !== 0) return null;
	await recordLandedPush(mainPath, branch, remoteTip);
	return {
		status: "pushed",
		output: `${PUSH_LANDED_BEFORE_ATTEMPT}: the remote ref moved while the push ran ("cannot lock ref"), and the fetched ${branch} already contains the pushed head ${local}`,
	};
}

/** The pre-flight gates of a server merge push: the branch and local tip to push and the
 * pinned origin to push to. A result means the push is skipped or failed outright. */
async function mergePushPreflight(
	mainPath: string,
	worktreePath: string,
	target: string,
	taskBranch: string,
	leaseTip: string | null,
	originUrl: string | null,
): Promise<
	{ branch: string; local: string; originUrl: string } | MergePushResult
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
		const gate = await holdGate(mainPath, leaseTip, branch);
		if (gate !== null) return gate;
	}
	const head = await integrationHead(worktreePath, taskBranch, sha);
	if (head !== null) {
		const merged = await git(
			["merge-base", "--is-ancestor", head, local],
			mainPath,
		);
		if (merged.code !== 0) return { status: "skipped" };
	}
	if (originUrl === null)
		return {
			status: "failed",
			error:
				"no pinned origin URL; restart the board (or set it in project settings) so the server pins the origin remote before merging",
		};
	const guard = await checkPinnedRemote(mainPath, originUrl);
	if (guard !== null) return { status: "failed", error: guard };
	return { branch, local, originUrl };
}

export async function serverMergePush(
	mainPath: string,
	worktreePath: string,
	target: string,
	taskBranch: string,
	leaseTip: string | null = null,
	originUrl: string | null = null,
): Promise<
	| { status: "skipped" }
	| { status: "pushed"; output: string }
	| { status: "failed"; error: string; output?: string }
	| { status: "rejected"; error: string; output?: string }
> {
	const pre = await mergePushPreflight(
		mainPath,
		worktreePath,
		target,
		taskBranch,
		leaseTip,
		originUrl,
	);
	if ("status" in pre) return pre;
	const { branch, local, originUrl: pinnedUrl } = pre;
	const r = await git(
		[
			"push",
			// With the lease the update is a fast-forward by construction (the local target
			// contains the audited tip the remote must still sit at), so the force part of
			// the lease never fires; it only rejects a remote that moved off the audited tip.
			...(leaseTip !== null
				? [`--force-with-lease=refs/heads/${branch}:${leaseTip}`]
				: []),
			pinnedUrl,
			`refs/heads/${branch}:refs/heads/${branch}`,
		],
		mainPath,
	);
	if (r.code === 0) {
		// A push by URL moves no remote-tracking ref (and a planted fetch refspec could point
		// it anywhere), so record the tip this push landed: the next merge's skip check and
		// the gate's `refs/remotes/origin/<branch>` compare stay exact (R5-1).
		// OTTR-605: a first push to an origin that lacked the branch leaves no upstream, and
		// the next target derivation would fall back to the bare local branch — a target the
		// board never pushes. Track the branch this push just created on origin (best
		// effort: the tracking ref above already carries the push's state; a project whose
		// derivation came from origin/HEAD loses nothing), so origin/<branch> stays the
		// resolved target after "Push to origin".
		await recordLandedPush(mainPath, branch, local);
		return { status: "pushed", output: `${r.stdout}${r.stderr}`.trim() };
	}
	// OTTR-465: the card log gets git's complete output (URL credentials redacted), and
	// needsReason keeps every reason line — "! [rejected]", "remote:", "fatal:" and the
	// "error:" line — not only one line, so a push the server could not write shows its
	// cause (a missing App installation, a token scope) instead of a bare summary.
	const { error, output } = pushFailure(r);
	// OTTR-394: git's rejection of a remote that moved while the merge ran ("fetch first" is
	// the same rejection worded for a still-fast-forwardable local side); "(stale info)" is a
	// --force-with-lease rejection, which the caller refuses to retry on a held push. Any
	// other failure keeps today's parking.
	if (
		/\[rejected\].*\((?:non-fast-forward|fetch first|stale info)\)/.test(
			r.stderr,
		)
	)
		return { status: "rejected", error, output };
	if (CANNOT_LOCK_REF_RE.test(r.stderr)) {
		const landed = await lockRefAlreadyLanded(
			mainPath,
			branch,
			pinnedUrl,
			local,
		);
		if (landed !== null) return landed;
	}
	return { status: "failed", error, output };
}

/** The redacted error and capped output of a failed git push (OTTR-465). */
function pushFailure(r: GitResult): {
	error: string;
	output: string | undefined;
} {
	const output = cappedPushOutput(
		redactUrlCredentials(`${r.stdout}${r.stderr}`).trim(),
	);
	const reasons = r.stderr
		.split("\n")
		.filter((line) => PUSH_REASON_LINE.test(line))
		.join("\n")
		.trim();
	const error = redactUrlCredentials(
		reasons !== ""
			? reasons
			: (r.stderr.trim().split("\n").filter(Boolean).pop() ??
					`git push exited ${r.code}`),
	);
	return { error, output };
}

/**
 * PR mode's server-side branch push: pushes the card branch's tip to the pinned origin from the
 * main checkout with the same credential plumbing as serverMergePush (git() adds the host auth;
 * per-host tokens or the ssh key), the server-pinned originUrl named instead of the remote name
 * (R5-1). The lease pins the remote-tracking tip this push read first, so a concurrent rewrite
 * of the branch rejects: the server is the card branch's only writer, but a rebase between two
 * pushes rewrites history, so the update must be forced-with-a-lease, never a plain push. Like
 * serverMergePush, a push by URL moves no remote-tracking ref, so the tip this push landed is
 * recorded on `refs/remotes/origin/<branch>`. A push git rejects because the remote moved
 * ("! [rejected]", "fetch first", or a --force-with-lease "stale info") returns `rejected`;
 * any other failure stays `failed`. Errors carry the reason lines and `output` the complete
 * redacted output, the same shape as serverMergePush (OTTR-465).
 */
export async function pushBranch(
	mainPath: string,
	branch: string,
	originUrl: string,
	/** Push to a different ref name on origin (OTTR-760: a source PR's head branch); default the branch's own name. */
	dstBranch: string = branch,
): Promise<
	| { status: "pushed"; output: string }
	| { status: "failed" | "rejected"; error: string; output?: string }
> {
	const sha = async (ref: string) => {
		const r = await git(
			["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
			mainPath,
		);
		return r.code === 0 ? r.stdout.trim() : null;
	};
	const guard = await checkPinnedRemote(mainPath, originUrl);
	if (guard !== null) return { status: "failed", error: guard };
	const tip = await sha(`refs/remotes/origin/${dstBranch}`);
	const r = await git(
		[
			"push",
			// Absent a remote-tracking tip (first push of the branch) there is nothing to lease
			// against: the push itself establishes the branch on origin. A different
			// destination (OTTR-760: a source PR's head branch) never forces — the push must
			// be the fast-forward the ancestor check proved, and a moved remote branch
			// rejects instead of overwriting someone else's new commits.
			...(tip !== null && dstBranch === branch
				? [`--force-with-lease=refs/heads/${dstBranch}:${tip}`]
				: []),
			originUrl,
			`refs/heads/${branch}:refs/heads/${dstBranch}`,
		],
		mainPath,
	);
	if (r.code === 0) {
		const local = await sha(`refs/heads/${branch}`);
		if (local !== null)
			await git(
				["update-ref", `refs/remotes/origin/${dstBranch}`, local],
				mainPath,
			);
		return { status: "pushed", output: `${r.stdout}${r.stderr}`.trim() };
	}
	const output = cappedPushOutput(
		redactUrlCredentials(`${r.stdout}${r.stderr}`).trim(),
	);
	const reasons = r.stderr
		.split("\n")
		.filter((line) => PUSH_REASON_LINE.test(line))
		.join("\n")
		.trim();
	const error = redactUrlCredentials(
		reasons !== ""
			? reasons
			: (r.stderr.trim().split("\n").filter(Boolean).pop() ??
					`git push exited ${r.code}`),
	);
	if (/! \[rejected\]|fetch first|stale info/.test(r.stderr))
		return { status: "rejected", error, output };
	return { status: "failed", error, output };
}

/**
 * OTTR-800, PR mode's end-of-card remote branch delete: the mirror of pushBranch. When a
 * PR-mode card ends (the PR merged, or the card is cancelled), the remote card branch the
 * ship step pushed would otherwise stay on origin for ever. The delete runs the same
 * pinned-origin-URL guard and credential plumbing as the push (git() adds the host auth)
 * and names exactly `refs/heads/<branch>`. `keep` lists branch names the card does not own
 * (the target branch, an OTTR-760 source PR head); a branch on that list is refused
 * without touching git. A missing remote ref (GitHub's auto-delete ran first, a second
 * delete) is success, and on success the stale remote-tracking ref goes too (best effort,
 * like pushBranch's write). Returns the redacted error text, else null; callers log it
 * and never treat a failed delete as a card-end failure.
 */
export async function deleteRemoteBranch(
	mainPath: string,
	branch: string,
	originUrl: string,
	keep: readonly string[] = [],
): Promise<string | null> {
	if (keep.includes(branch))
		return `refusing to delete refs/heads/${branch}: the card does not own it (target branch or source-PR head)`;
	const guard = await checkPinnedRemote(mainPath, originUrl);
	if (guard !== null) return guard;
	const r = await git(
		["push", originUrl, "--delete", `refs/heads/${branch}`],
		mainPath,
	);
	if (r.code === 0) {
		await git(["update-ref", "-d", `refs/remotes/origin/${branch}`], mainPath); // best effort
		return null;
	}
	const out = `${r.stdout}${r.stderr}`;
	// The wanted end state already happened (GitHub's auto-delete, a second delete).
	if (out.includes("remote ref does not exist")) return null;
	return deleteFailureText(out, r.code);
}

/**
 * The delete's failure text: the redacted, capped push output, else git's exit code — a
 * push killed with no output (a hung child the runner killed) must not read as success.
 * Exported for the empty-output test: a fixture cannot make real git fail silently.
 */
export function deleteFailureText(out: string, code: number): string {
	return (
		cappedPushOutput(redactUrlCredentials(out.trim())) ??
		`git push exited ${code}`
	);
}

/**
 * OTTR-394: the server-side fetch that backs an automatic rebase retry. A rejected merge
 * push means origin moved while the merge ran; the queued rebase turn needs a current
 * origin/<branch> to rebase onto, and the merge agent holds no git credentials (D6). The
 * fetch names the pinned origin URL (never the remote name a work turn can re-point, R5-1)
 * with an explicit force refspec into the remote-tracking ref, so planted fetch refspecs
 * stay irrelevant, and --no-tags keeps a planted tag opt from dragging tags in. Returns the
 * error text, else null.
 */
export async function fetchOriginBranch(
	mainPath: string,
	branch: string,
	originUrl: string,
): Promise<string | null> {
	const guard = await checkPinnedRemote(mainPath, originUrl);
	if (guard !== null) return guard;
	const r = await git(
		[
			"fetch",
			"--no-tags",
			originUrl,
			`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
		],
		mainPath,
	);
	return r.code === 0
		? null
		: redactUrlCredentials(
				r.stderr.trim().split("\n").filter(Boolean).pop() ??
					`git fetch exited ${r.code}`,
			);
}

/**
 * OTTR-755: fetches one pull request's head into the main checkout with the board's git
 * env (git() adds the host auth), so a Dependabot card's turn needs no git credentials of
 * its own: card worktrees share the main checkout's refs. The caller builds the URL (the
 * GitHub web base plus a validated owner/repo slug, forks.ts prepareForkFetch's shape —
 * never remote names a work turn can re-point, R5-1) and keeps untrusted JSON out of it.
 * The `+` refspec force-updates the ref, so a re-fetch always names the current head.
 * Returns the error text, else null.
 */
export async function fetchPrHead(
	mainPath: string,
	/** Validated PR number: the refspec is built from it alone. */
	n: number,
	url: string,
): Promise<string | null> {
	if (!Number.isSafeInteger(n) || n <= 0) return `invalid PR number: ${n}`;
	const guard = await checkPinnedRemote(mainPath, url);
	if (guard !== null) return guard;
	const r = await git(
		["fetch", "--no-tags", url, `+refs/pull/${n}/head:refs/ottr/pr/${n}`],
		mainPath,
	);
	return r.code === 0
		? null
		: redactUrlCredentials(
				r.stderr.trim().split("\n").filter(Boolean).pop() ??
					`git fetch exited ${r.code}`,
			);
}

/**
 * OTTR-510: the server-side rebase behind an automatic push retry. A rejected merge push means
 * origin moved mid-merge; the server now runs this rebase itself — and the merge gates on the
 * result (runMergeGates) — before it retries the push, so the automatic path skips no gate and
 * queues a recovery steer only when the retry cannot converge. A conflict aborts, so
 * refs/heads/<branch> stays on its rejected head and the checkout never sits mid-rebase; an
 * abort that itself fails reports a non-conflict failure (the caller then fails closed).
 */
export async function rebaseTargetBranch(
	mainPath: string,
	branch: string,
	/** OTTR-693: the Settings commit identity; null keeps the built-in Ottr one. */
	identity: CommitIdentity | null = null,
): Promise<{ ok: true } | { ok: false; conflict: boolean; error: string }> {
	const r = await git(
		[
			// The replay re-creates commits, so it needs a committer identity; pin the board's
			// own (the same app.ts pins) so a checkout without git config cannot wedge the
			// automatic retry.
			...identityArgs(identity),
			"rebase",
			`refs/remotes/origin/${branch}`,
			branch,
		],
		mainPath,
	);
	if (r.code === 0) return { ok: true };
	const out = `${r.stdout}${r.stderr}`;
	const mergePath = await git(
		["rev-parse", "--git-path", "rebase-merge"],
		mainPath,
	);
	const applyPath = await git(
		["rev-parse", "--git-path", "rebase-apply"],
		mainPath,
	);
	const inProgress =
		(mergePath.code === 0 &&
			existsSync(path.resolve(mainPath, mergePath.stdout.trim()))) ||
		(applyPath.code === 0 &&
			existsSync(path.resolve(mainPath, applyPath.stdout.trim())));
	if (out.includes("CONFLICT") || inProgress) {
		const abort = await git(["rebase", "--abort"], mainPath);
		if (abort.code !== 0)
			return {
				ok: false,
				conflict: false,
				error: `${out.trim().split("\n").filter(Boolean).pop() ?? `git rebase exited ${r.code}`}; git rebase --abort also failed: ${abort.stderr.trim()}`,
			};
		return {
			ok: false,
			conflict: true,
			error:
				out.split("\n").find((line) => line.includes("CONFLICT")) ??
				`git rebase exited ${r.code}`,
		};
	}
	return {
		ok: false,
		conflict: false,
		error:
			r.stderr.split("\n").find((line) => /^(error|fatal):/i.test(line)) ??
			r.stderr.trim().split("\n").filter(Boolean).pop() ??
			`git rebase exited ${r.code}`,
	};
}

/**
 * OTTR-510: the merge gates a push retry must clear before the push goes out again. `bun run
 * check` runs first, `bun test` only when it exited 0, both in the main checkout; the spawns
 * name process.execPath (bun itself), so a planted PATH cannot substitute another binary. Each
 * gate is killed after 30 minutes. Returns the failing gate's output (capped like a push's),
 * else empty output.
 */
export async function runMergeGates(
	mainPath: string,
): Promise<{ ok: boolean; output: string }> {
	// The gates run repo code: never hand it the hosted identity-signing key.
	const env = { ...process.env };
	delete env[HOSTED_SECRET_ENV];
	const check = Bun.spawn([process.execPath, "run", "check"], {
		cwd: mainPath,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 1_800_000,
	});
	const checkOut = await new Response(check.stdout).text();
	const checkErr = await new Response(check.stderr).text();
	const checkCode = await check.exited;
	if (checkCode !== 0)
		return {
			ok: false,
			output: `bun run check exited ${checkCode}\n${cappedPushOutput(`${checkOut}${checkErr}`.trim()) ?? ""}`,
		};
	const test = Bun.spawn([process.execPath, "test"], {
		cwd: mainPath,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 1_800_000,
	});
	const testOut = await new Response(test.stdout).text();
	const testErr = await new Response(test.stderr).text();
	const testCode = await test.exited;
	if (testCode !== 0)
		return {
			ok: false,
			output: `bun test exited ${testCode}\n${cappedPushOutput(`${testOut}${testErr}`.trim()) ?? ""}`,
		};
	return { ok: true, output: "" };
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
 * ref stay irrelevant), names the server-pinned origin URL, not the remote name (R5-1), and
 * serverMergePush pins the real remote to the returned auditedTip. When the local target branch
 * is an ancestor of the fetched tip (VELV-89: a merge that shipped through a project rule
 * pushed the target from the worktree and never moved the local branch), the local head is not
 * the push set: the patches the card's merge put on the remote target are judged instead — the
 * remote's total tree effect since base must equal the approved one. Any
 * git trouble mismatches: the hold fails closed. Runs in the main repo, where the target refs
 * live.
 */
export async function mergeHoldMismatch(
	mainPath: string,
	target: string,
	base: string,
	approvedHead: string,
	originUrl: string | null = null,
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
	// pair-dependent); --full-index keeps blob ids content-exact. --ignore-submodules=none
	// overrides planted diff.ignoreSubmodules, which would otherwise drop a committed gitlink
	// change from both texts and make a smuggled submodule bump match the approval.
	// ponytail: full diff text in memory; upgrade to hashing only if a card ships a range big
	// enough to block a settle.
	const effect = async (from: string, to: string): Promise<string | null> => {
		const r = await git(
			[
				"diff",
				"--no-renames",
				"--full-index",
				"--ignore-submodules=none",
				from,
				to,
			],
			mainPath,
		);
		return r.code === 0 ? r.stdout : null;
	};
	// The gate names the pinned origin URL, never the remote name a work turn can re-point
	// (R5-1). No pin, or one the pinned-URL check refuses: the hold fails closed.
	if (
		originUrl === null ||
		(await checkPinnedRemote(mainPath, originUrl)) !== null
	)
		return failClosed();
	const fetch = await git(
		["fetch", originUrl, `+refs/heads/${branch}:refs/ottr/gate/${branch}`],
		mainPath,
	);
	if (fetch.code !== 0) return failClosed();
	const tip = await git(["rev-parse", `refs/ottr/gate/${branch}`], mainPath);
	if (tip.code !== 0) return failClosed();
	const auditedTip = tip.stdout.trim();
	const approved = await effect(base, approvedHead);
	// VELV-89: the local branch can sit behind the fetched remote tip (an ancestor of it) when
	// the card's merge shipped through a project rule that pushed the target itself. Then the
	// local head is not the push set: judge the patches the card's merge put on the remote
	// target — the remote's total tree effect since base must equal the approved one. Commits
	// cannot be attributed to cards, so the tree-effect proof judges the remote side exactly
	// as it judges the push set. An unreadable approved-side diff falls through: the return
	// below then mismatches, and the hold still fails closed.
	if (
		approved !== null &&
		(await targetContains(
			mainPath,
			`refs/heads/${branch}`,
			`refs/ottr/gate/${branch}`,
		))
	) {
		const remoteEffect = await effect(base, `refs/ottr/gate/${branch}`);
		return {
			mismatch: remoteEffect === null || remoteEffect !== approved,
			pushDiff: remoteEffect,
			auditedTip,
		};
	}
	const push = await effect(auditedTip, `refs/heads/${branch}`);
	if (push === null) return failClosed();
	return {
		mismatch: approved === null || push !== approved,
		pushDiff: push,
		auditedTip,
	};
}

/**
 * VELV-89: whether a held merge already landed without the main checkout's local branch
 * moving. A merge turn can ship through a project rule that pushes the target from the
 * worktree with its own credentials, so origin holds the work while refs/heads/<branch> still
 * sits behind it — the mismatch gate would read a stale push set and park a landed card.
 * Fetches the target with the gate's own refspec and pinned URL (R5-1) and lands only when
 * every approved head is contained in the fetched tip and the remote carries no patches
 * beyond the approval: commits cannot be attributed to cards, so the remote's total tree
 * effect since base must equal the approved one — the same proof the push-set gate uses.
 * False on any git trouble: the caller then judges the gate (mergeHoldMismatch), which fails
 * closed into the park. Runs in the main repo, where the target refs live.
 */
export async function mergeHoldLanded(
	mainPath: string,
	target: string,
	base: string,
	approvedHeads: readonly string[],
	originUrl: string | null = null,
): Promise<boolean> {
	if (!target.startsWith("origin/")) return false;
	const branch = target.slice("origin/".length);
	if (
		originUrl === null ||
		(await checkPinnedRemote(mainPath, originUrl)) !== null
	)
		return false;
	const fetch = await git(
		["fetch", originUrl, `+refs/heads/${branch}:refs/ottr/gate/${branch}`],
		mainPath,
	);
	if (fetch.code !== 0) return false;
	const gate = `refs/ottr/gate/${branch}`;
	const effect = async (from: string, to: string): Promise<string | null> => {
		const r = await git(
			[
				"diff",
				"--no-renames",
				"--full-index",
				"--ignore-submodules=none",
				from,
				to,
			],
			mainPath,
		);
		return r.code === 0 ? r.stdout : null;
	};
	const remote = await effect(base, gate);
	if (remote === null) return false;
	for (const ah of approvedHeads) {
		const on = await git(["merge-base", "--is-ancestor", ah, gate], mainPath);
		if (on.code !== 0) return false;
		const approved = await effect(base, ah);
		if (approved === null || approved !== remote) return false;
	}
	return true;
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
 * counts: git there climbs out to the enclosing repo, so it still cannot speak for its old branch.
 * A `.git` file whose gitdir still lives is NOT a husk (OTTR-349): git failed above for another reason (an index
 * lock, dubious ownership) and the worktree may be healthy — a husk verdict there would let the pre-dispatch guard
 * settle a zero-commit card done on a vacuous proof or rebuild a live checkout. */
/** The gitdir a `.git` link file in `dir` names, resolved; null when the link is missing, unreadable, or names nothing. */
function readGitdir(dir: string): string | null {
	try {
		if (!statSync(path.join(dir, ".git")).isFile()) return null;
		const m = readFileSync(path.join(dir, ".git"), "utf8").match(
			/^gitdir:\s*(.+)$/m,
		);
		const named = m === null ? "" : (m[1] ?? "").trim();
		if (named === "") return null;
		return path.isAbsolute(named) ? named : path.resolve(dir, named);
	} catch {
		// no readable .git link here: a climbing-git dir or only an empty dir is a husk
		return null;
	}
}

export async function worktreeHusk(dir: string): Promise<boolean> {
	if (await worktreeLinked(dir)) return false;
	// worktreeLinked's git read already failed, so the `.git` file alone proves nothing: read
	// the gitdir it names and let that decide. An unreadable or malformed `.git` file leaves
	// gitdir null and the climbing-git and empty-dir checks below decide instead.
	const gitdir = readGitdir(dir);
	if (gitdir !== null) {
		let alive = false;
		try {
			alive = statSync(gitdir).isDirectory();
		} catch {
			// gitdir gone: the deregistered-but-undeleted husk
		}
		return !alive;
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

/** OTTR-552: the PR-mode integrated proof — the worktree tree is clean and origin's
 * target ref is an ancestor of HEAD, i.e. the rebase a PR-mode merge turn performs
 * is complete and nothing is uncommitted. Both checks run in the worktree; a git
 * failure is not a proof. */
export async function prIntegrated(
	_mainPath: string,
	worktreePath: string,
	target: string,
): Promise<boolean> {
	const clean = await isClean(worktreePath);
	if (!clean) return false;
	const r = await git(
		["merge-base", "--is-ancestor", target, "HEAD"],
		worktreePath,
	);
	return r.code === 0;
}

/** OTTR-506: true while the local `branch` in the main checkout holds commits the fetched
 * `origin/<branch>` lacks — the state a rejected server push leaves the target in. The
 * scheduler holds every queued merge but the rejected card's rebase retry while this is true,
 * so one rejection cannot pile merges onto an unpushed main. Missing refs: no local branch
 * counts as pushed (nothing to push); a missing origin branch while the local branch has
 * commits counts as unpushed since OTTR-605 — the local commits cannot reach origin until
 * the first push (an empty origin, the new-project wizard's state), so the merge hold and
 * the "Push to origin" advisory apply. A git failure counts
 * as unpushed: the hold errs conservative and the next refresh re-checks. */
export async function branchUnpushed(
	mainPath: string,
	branch: string,
): Promise<boolean> {
	const origin = `refs/remotes/origin/${branch}`;
	const tip = async (ref: string): Promise<string | null> => {
		const r = await git(
			["rev-parse", "--verify", "--quiet", ref],
			mainPath,
		).catch(() => null);
		return r !== null && r.code === 0 ? r.stdout.trim() : null;
	};
	const [local, pushed] = await Promise.all([
		tip(`refs/heads/${branch}`),
		tip(origin),
	]);
	if (local === null || local === pushed) return false;
	if (pushed === null) return true;
	// is-ancestor answers 0 when local is contained in origin (behind is fine: a merge may
	// fast-forward); anything else holds commits origin lacks.
	const r = await git(
		["merge-base", "--is-ancestor", local, origin],
		mainPath,
	).catch(() => null);
	return r === null || r.code !== 0;
}

/** OTTR-531: the branch the main checkout has checked out (HEAD minus its refs/heads
 * prefix), or null on a detached HEAD or any git failure — the off-default banner and the
 * turn-outcome finding read it to name a checkout left on a foreign branch. */
export async function checkedOutBranch(
	mainPath: string,
): Promise<string | null> {
	const head = await git(["symbolic-ref", "--quiet", "HEAD"], mainPath).catch(
		() => null,
	);
	if (head === null || head.code !== 0) return null;
	const branch = head.stdout.trim();
	return branch.startsWith("refs/heads/")
		? branch.slice("refs/heads/".length)
		: null;
}

/** True when the main checkout's target already contains sha (AGEN-24: the approving turn
 * merged by itself and removed the worktree; the settle then finishes instead of parking again). */
export async function targetContains(
	mainPath: string,
	sha: string,
	target: string,
): Promise<boolean> {
	const r = await git(["merge-base", "--is-ancestor", sha, target], mainPath);
	return r.code === 0;
}

/** OTTR-760: true when two commits hold identical trees — a cherry-picked PR head landed
 * unchanged, so the card branch carries exactly the source PR's content. */
export async function treesEqual(
	mainPath: string,
	a: string,
	b: string,
): Promise<boolean> {
	const r = await git(["diff", "--quiet", "--no-ext-diff", a, b], mainPath);
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
		const rec = recs[i];
		if (rec === undefined || rec === "") continue; // trailing NUL
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

/** One commit's guard metadata: short sha, subject, committer time (ms) and files. */
export interface CommitMeta {
	sha: string;
	subject: string;
	time: number;
	files: string[];
}

/**
 * OTTR-763: per-commit metadata for the cross-project checkout guard: the committer
 * time attributes a change to the turn window that holds it, and the file list carries
 * the AGENTS.md sync rule's provisioned-copy exemption. A failed git read answers
 * empty and never throws, like commitSubjects: the guard proves only what it read.
 */
export async function commitMeta(
	mainPath: string,
	from: string,
	target: string,
): Promise<CommitMeta[]> {
	try {
		const r = await git(
			[
				"log",
				"--format=%x1e%h%x1f%cI%x1f%s",
				"--name-only",
				"--no-renames",
				"-n",
				"200",
				`${from}..${target}`,
			],
			mainPath,
		);
		if (r.code !== 0) return [];
		const out: CommitMeta[] = [];
		for (const record of r.stdout.split("\x1e")) {
			const nl = record.indexOf("\n");
			const head = nl === -1 ? record : record.slice(0, nl);
			const [sha, iso, subject] = head.split("\x1f");
			if (sha === undefined || iso === undefined || subject === undefined)
				continue;
			const time = new Date(iso.trim()).getTime();
			if (!Number.isFinite(time)) continue;
			const files = (nl === -1 ? "" : record.slice(nl + 1))
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l !== "");
			out.push({ sha: sha.trim(), subject: subject.trim(), time, files });
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * OTTR-708: a main checkout's HEAD sha and porcelain status (including untracked files), the
 * input of the cross-project checkout guard. A missing directory or a failed git read never
 * throws: head reads null and the status empty, and the caller skips the project then.
 */
export async function checkoutState(
	mainPath: string,
): Promise<{ head: string | null; status: string }> {
	let head: string | null = null;
	try {
		const h = await git(["rev-parse", "HEAD"], mainPath);
		if (h.code === 0) head = h.stdout.trim();
	} catch {
		// The checkout is missing or not a git repository: head stays null.
	}
	let status = "";
	try {
		const s = await sealedGit(
			[
				"status",
				"--porcelain",
				"--untracked-files=all",
				"--ignore-submodules=dirty",
			],
			mainPath,
		);
		if (s.code === 0) status = s.stdout;
	} catch {
		// The checkout is missing: the status stays empty.
	}
	return { head, status };
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
 * Saves every file a done worktree leaves behind into `saveDir`: untracked files MOVE
 * (repo-relative paths preserved, symlinks move as links), tracked files with staged or
 * unstaged content changes COPY their current content (a symlink entry copies as a link).
 * A regular file larger than `maxBytes` is not saved and its repo-relative path lands in
 * `tooLarge`. A path that vanishes between status and save is skipped. A missing worktree
 * directory (a merged card keeps its worktree path after the directory is gone) saves
 * nothing. An untracked entry that is not a regular file (a nested repository, which git
 * lists as `dir/`) moves whole when it can and lands in `failed` with a reason when it
 * cannot (a directory cannot cross a mount point); a tracked gitlink (a submodule) is
 * skipped — the submodule pins its own content. Either way the save continues, so
 * entries after them are still saved. Returns
 * { moved, copied, tooLarge, failed } (repo-relative, forward slashes). Throws when git
 * fails; a symlinked parent on either side throws from the confine helpers.
 */
export async function saveDoneFiles(
	worktreePath: string,
	saveDir: string,
	dataRoot: string,
	maxBytes: number,
): Promise<{
	moved: string[];
	copied: string[];
	tooLarge: string[];
	failed: { path: string; reason: string }[];
}> {
	const moved: string[] = [];
	const copied: string[] = [];
	const tooLarge: string[] = [];
	const failed: { path: string; reason: string }[] = [];
	const fwd = (rel: string): string => rel.replaceAll("\\", "/");
	const reason = (err: unknown): string =>
		err instanceof Error ? err.message : String(err);
	if (!existsSync(worktreePath))
		return { moved: [], copied: [], tooLarge: [], failed: [] };
	const anchor = trustedAnchor(worktreePath);

	// Untracked files move; a symlink entry moves as a link, so readBelow's refusals are
	// expected and acted on instead of thrown.
	const r = await git(
		["ls-files", "-z", "--others", "--exclude-standard"],
		worktreePath,
	);
	if (r.code !== 0) throw new Error(r.stderr || "git ls-files failed");
	for (const rel of r.stdout.split("\0")) {
		if (rel === "") continue;
		let bytes: Buffer | null;
		let moveAsIs = false;
		try {
			bytes = readBelow(anchor, path.join(worktreePath, rel), maxBytes);
		} catch (err) {
			const msg = String((err as Error)?.message ?? err);
			if (msg.endsWith(`: larger than ${maxBytes} bytes`)) {
				tooLarge.push(fwd(rel));
				continue;
			}
			if (msg.endsWith(": a symlink") || msg.endsWith(": not a regular file")) {
				// A symlink moves as a link; a nested repository moves whole.
				moveAsIs = true;
				bytes = null;
			} else throw err;
		}
		if (bytes === null && !moveAsIs) continue; // vanished between listing and reading
		try {
			moveBelow(
				{ anchor, file: path.join(worktreePath, rel) },
				{ anchor: dataRoot, file: path.join(saveDir, rel) },
			);
			moved.push(fwd(rel));
		} catch (err) {
			// A directory entry cannot cross a mount point (EXDEV's copy refuses
			// non-regular entries): skip it, keep saving the rest, and name it.
			failed.push({ path: fwd(rel), reason: reason(err) });
		}
	}

	// Tracked files with content changes copy; they stay in the worktree until it goes away.
	// sealedGit: a work turn can plant a filter.<d>.clean that plain git runs here (the
	// regression tests plant one, with HEAD resolving and on an unborn branch). Like the
	// other sealed status callers, --ignore-submodules=dirty keeps git out of a submodule's
	// planted gitdir; a dirty gitlink row still arrives and the read below skips it.
	const s = await sealedGit(
		[
			"status",
			"--porcelain",
			"-z",
			"--untracked-files=no",
			"--ignore-submodules=dirty",
		],
		worktreePath,
	);
	if (s.code !== 0) throw new Error(s.stderr || "git status failed");
	const tokens = s.stdout.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === undefined || token === "") continue;
		const rel = token.slice(3);
		const xy = token.slice(0, 2);
		// A staged rename row is "R <new>\0<old>": consume the old path, never save it.
		if (xy[0] === "R") i++;
		if (!/[AMTURC]/.test(xy)) continue;
		try {
			const bytes = readBelow(anchor, path.join(worktreePath, rel), maxBytes);
			if (bytes === null) continue;
			writeBelow(dataRoot, path.join(saveDir, rel), bytes, "truncate");
			copied.push(fwd(rel));
		} catch (err) {
			const msg = String((err as Error)?.message ?? err);
			if (msg.endsWith(`: larger than ${maxBytes} bytes`)) {
				tooLarge.push(fwd(rel));
				continue;
			}
			if (msg.endsWith(": not a regular file")) continue; // a gitlink (submodule)
			if (!msg.endsWith(": a symlink")) throw err;
			copyBelow(
				{ anchor, file: path.join(worktreePath, rel) },
				{ anchor: dataRoot, file: path.join(saveDir, rel) },
				worktreePath,
			);
			copied.push(fwd(rel));
		}
	}
	return { moved, copied, tooLarge, failed };
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

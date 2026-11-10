import { type VmGrant, type VmTokens, vmTokenOf } from "./vmTokens.ts";
import { git, gitExe, sealedGit } from "./worktree.ts";

/**
 * The board's git endpoint for microVM turns (OTTR-532): smart HTTP through `git http-backend`
 * over the project's main checkout. The VM clones and pushes its card's branch here with its
 * per-turn token; it never sees the workspace or a host credential. Every ref but the card's
 * branch (and the task base, when that is a ref) is hidden, HEAD included: no other branch is
 * advertised or fetchable.
 *
 *   GET  /git/<project>.git/info/refs?service=git-upload-pack|git-receive-pack
 *   POST /git/<project>.git/git-upload-pack
 *   POST /git/<project>.git/git-receive-pack
 */
const ROUTE =
	/^\/git\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICES: Record<string, true> = {
	"git-upload-pack": true,
	"git-receive-pack": true,
};
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO = /^0+$/;
/** A CGI header block larger than this is not git http-backend talking. */
const MAX_CGI_HEAD = 64 * 1024;

export interface GitHttpOptions {
	tokens: VmTokens;
	log: (line: string) => void;
}

/**
 * Command-line config (GIT_CONFIG_COUNT) outranks the repo's .git/config, which work turns of
 * classic projects can write (R5-1): no hook runs, no auto gc, no planted alternates command.
 * denyCurrentBranch=ignore: the task branch is checked out in the server's linked worktree,
 * which syncWorktreeTo resets after the push.
 */
const PINNED_CONFIG: [string, string][] = [
	["http.receivepack", "true"],
	["core.hooksPath", "/dev/null"],
	["core.fsmonitor", "false"],
	["core.alternateRefsCommand", "true"],
	["receive.denyCurrentBranch", "ignore"],
	["receive.denyDeleteCurrent", "refuse"],
	["receive.autogc", "false"],
	["gc.auto", "0"],
	["maintenance.auto", "false"],
	["uploadpack.allowAnySHA1InWant", "false"],
	["uploadpack.allowReachableSHA1InWant", "false"],
	["uploadpack.allowTipSHA1InWant", "false"],
];

/** transfer.hideRefs for a grant: everything hidden, then the card's branch and base ref unhidden. */
export function refVisibility(grant: VmGrant): [string, string][] {
	const out: [string, string][] = [
		["transfer.hideRefs", "refs/"],
		["transfer.hideRefs", "HEAD"],
		["transfer.hideRefs", `!refs/heads/${grant.branch}`],
	];
	const base = grant.base;
	if (base !== undefined && !SHA.test(base))
		out.push([
			"transfer.hideRefs",
			`!${base.startsWith("refs/") ? base : `refs/heads/${base}`}`,
		]);
	return out;
}

const plain = (text: string, status: number, headers?: HeadersInit) =>
	new Response(`${text}\n`, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
	});

/** One pushed ref update from the receive-pack command section. */
export interface PushCommand {
	old: string;
	new: string;
	ref: string;
}

/** One read of a receive-pack pkt-line. */
type PktLine =
	| { kind: "command"; line: string; at: number }
	| { kind: "flush" }
	| { kind: "error"; error: string };

/** Reads one pkt-line from the body: a flush (0000), a payload line, or an error. */
function readPktLine(body: Uint8Array, at: number, text: TextDecoder): PktLine {
	if (at + 4 > body.length)
		return { kind: "error", error: "truncated command list" };
	const lenHex = text.decode(body.subarray(at, at + 4));
	if (!/^[0-9a-f]{4}$/.test(lenHex))
		return { kind: "error", error: "malformed pkt-line" };
	const len = Number.parseInt(lenHex, 16);
	if (len === 0) return { kind: "flush" };
	if (len < 4 || at + len > body.length)
		return { kind: "error", error: "malformed pkt-line" };
	return {
		kind: "command",
		line: text.decode(body.subarray(at + 4, at + len)),
		at: at + len,
	};
}

/** One receive-pack command line: a command, null for a skipped shallow line, or an error. */
type ParsedCommand = { command: PushCommand | null } | { error: string };

/** Cleans and validates one command payload line. */
function parseCommandLine(raw: string, isFirst: boolean): ParsedCommand {
	let line = raw;
	if (isFirst) {
		const nul = line.indexOf("\0");
		if (nul >= 0) line = line.slice(0, nul); // capabilities ride on the first command
	}
	line = line.replace(/\n$/, "");
	if (/^shallow [0-9a-f]+$/.test(line)) return { command: null };
	const [old = "", neu = "", ref = "", ...extra] = line.split(" ");
	if (!SHA.test(old) || !SHA.test(neu) || ref === "" || extra.length > 0)
		return { error: `unsupported push request line: ${line.slice(0, 80)}` };
	return { command: { old, new: neu, ref } };
}

/**
 * The command section of a receive-pack request body: pkt-lines up to the first flush. Shallow
 * lines (a shallow VM clone) are skipped; anything else that is not `<old> <new> <ref>` (a
 * signed push certificate, a garbled line) is an error, so no ref escapes the check.
 */
export function parseReceiveCommands(
	body: Uint8Array,
): { commands: PushCommand[] } | { error: string } {
	// Non-UTF-8 bytes decode to U+FFFD, which no ASCII branch name can equal.
	const text = new TextDecoder();
	const commands: PushCommand[] = [];
	let at = 0;
	for (;;) {
		const pkt = readPktLine(body, at, text);
		if (pkt.kind === "error") return { error: pkt.error };
		if (pkt.kind === "flush") return { commands };
		at = pkt.at;
		const parsed = parseCommandLine(pkt.line, commands.length === 0);
		if ("error" in parsed) return { error: parsed.error };
		if (parsed.command !== null) commands.push(parsed.command);
	}
}

/** The refusal for a push that leaves the card's branch, or deletes it; null when allowed. */
export function pushRefusal(
	commands: readonly PushCommand[],
	branch: string,
): string | null {
	const own = `refs/heads/${branch}`;
	for (const c of commands) {
		if (c.ref !== own) return `this token pushes only ${own}, not ${c.ref}`;
		if (ZERO.test(c.new)) return `deleting ${own} is refused`;
	}
	return null;
}

/**
 * Moves the server worktree's files and index to `sha` after a VM push. The pushed ref is the
 * branch checked out there, so HEAD already names `sha`; reset --hard brings the files along.
 * sealedGit: the shared gitdir's config is worker-writable, and a planted smudge filter must
 * not run in the board.
 */
export async function syncWorktreeTo(
	worktree: string,
	sha: string,
): Promise<void> {
	if (!SHA.test(sha)) throw new Error(`not a commit sha: ${sha}`);
	const r = await sealedGit(
		["reset", "--hard", "--no-recurse-submodules", "-q", sha],
		worktree,
	);
	if (r.code !== 0)
		throw new Error(
			`git reset --hard ${sha} in ${worktree} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
		);
}

/** One reset at a time per worktree: a periodic push and the exit push may land together. */
const syncing = new Map<string, Promise<void>>();

/** Resets the worktree to the branch head as it is now, so the last sync always wins. */
function syncAfterPush(
	grant: VmGrant,
	log: (l: string) => void,
): Promise<void> {
	const prev = syncing.get(grant.worktree) ?? Promise.resolve();
	const next = prev.then(async () => {
		const head = await git(
			["rev-parse", "--verify", "-q", `refs/heads/${grant.branch}`],
			grant.repoPath,
		);
		if (head.code !== 0) {
			log(
				`${grant.project}/${grant.taskId}: branch ${grant.branch} vanished after a push`,
			);
			return;
		}
		await syncWorktreeTo(grant.worktree, head.stdout.trim()).catch((err) =>
			log(`${grant.project}/${grant.taskId}: ${String(err)}`),
		);
	});
	syncing.set(grant.worktree, next);
	void next.finally(() => {
		if (syncing.get(grant.worktree) === next) syncing.delete(grant.worktree);
	});
	return next;
}

function headerEnd(buf: Uint8Array): { end: number; sep: number } | null {
	for (let i = 0; i + 1 < buf.length; i++) {
		if (buf[i] !== 10) continue;
		if (buf[i + 1] === 10) return { end: i, sep: 2 };
		if (buf[i + 1] === 13 && buf[i + 2] === 10) return { end: i, sep: 3 };
	}
	return null;
}

/**
 * The CGI answer of http-backend as a Response: the header block (Status:, Content-Type, cache
 * headers) up front, the rest streamed as it arrives.
 */
async function cgiResponse(
	out: ReadableStream<Uint8Array>,
	kill: () => void,
): Promise<Response> {
	const reader = out.getReader();
	let buf = new Uint8Array(0);
	let found: { end: number; sep: number } | null = null;
	while (found === null && buf.length <= MAX_CGI_HEAD) {
		const { value, done } = await reader.read();
		if (done) break;
		const joined = new Uint8Array(buf.length + value.length);
		joined.set(buf);
		joined.set(value, buf.length);
		buf = joined;
		found = headerEnd(buf);
	}
	if (found === null) {
		kill();
		void reader.cancel();
		return plain("git http-backend gave no answer", 502);
	}
	const head = new TextDecoder().decode(buf.subarray(0, found.end));
	const rest = buf.subarray(found.end + found.sep);
	const headers = new Headers();
	let status = 200;
	for (const line of head.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (name.toLowerCase() === "status") {
			const n = Number.parseInt(value, 10);
			if (n >= 100 && n <= 599) status = n;
		} else headers.append(name, value);
	}
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			if (rest.length > 0) c.enqueue(rest);
		},
		async pull(c) {
			const { value, done } = await reader.read();
			if (done) c.close();
			else c.enqueue(value);
		},
		cancel() {
			kill();
			void reader.cancel();
		},
	});
	return new Response(body, { status, headers });
}

/** The grant for a routed request, or the error Response to return. */
type GitAccess = { grant: VmGrant; rest: string } | { response: Response };

/** Route match, token check, and project ownership; also picks the request kind. */
function checkAccess(req: Request, url: URL, o: GitHttpOptions): GitAccess {
	const m = ROUTE.exec(url.pathname);
	if (!m) return { response: plain("not found", 404) };
	const grant = o.tokens.check(vmTokenOf(req));
	if (grant === null)
		return {
			response: plain("unauthorized", 401, {
				"WWW-Authenticate": 'Basic realm="ottr"',
			}),
		};
	let project: string;
	try {
		project = decodeURIComponent(m[1] ?? "");
	} catch {
		return { response: plain("not found", 404) };
	}
	if (project !== grant.project)
		return {
			response: plain(`this token opens only ${grant.project}.git`, 403),
		};
	return { grant, rest: m[2] ?? "" };
}

/** The method/service guard; null when the request may continue. */
function methodGuard(req: Request, rest: string, url: URL): Response | null {
	if (rest === "info/refs") {
		if (req.method !== "GET") return plain("method not allowed", 405);
		if (SERVICES[url.searchParams.get("service") ?? ""] !== true)
			return plain("dumb HTTP is not served", 403);
	} else if (req.method !== "POST") return plain("method not allowed", 405);
	return null;
}

/** The Content-Encoding guard; also hands the parsed encoding to the backend. */
function encodingGuard(
	req: Request,
	rest: string,
): { encoding: string } | { response: Response } {
	const encoding = (req.headers.get("content-encoding") ?? "").toLowerCase();
	if (encoding !== "" && encoding !== "gzip" && encoding !== "x-gzip")
		return { response: plain(`unsupported content encoding ${encoding}`, 415) };
	// git never gzips a push; refusing it keeps a gzip bomb out of the buffered body check.
	if (rest === "git-receive-pack" && encoding !== "")
		return {
			response: plain(
				`unsupported content encoding ${encoding} on a push`,
				415,
			),
		};
	return { encoding };
}

/** The CGI environment for http-backend: board secrets out, pinned and per-grant config in. */
function cgiEnv(
	grant: VmGrant,
	rest: string,
	req: Request,
	url: URL,
): Record<string, string> {
	const config = [...PINNED_CONFIG, ...refVisibility(grant)];
	const env: Record<string, string> = {
		// Built from scratch: http-backend and the git it starts see no board secret.
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		// The home .gitconfig sits on the worker-writable home volume (R5-1), and global config
		// is protected config: uploadpack.packObjectsHook there would run in the board.
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_PROJECT_ROOT: grant.repoPath,
		// http-backend's enter_repo finds <root>/.git for a non-bare checkout.
		PATH_INFO: `/${rest}`,
		GIT_HTTP_EXPORT_ALL: "1",
		REQUEST_METHOD: req.method,
		QUERY_STRING: url.search.replace(/^\?/, ""),
		REMOTE_USER: "ottr-vm",
		GIT_CONFIG_COUNT: String(config.length),
	};
	for (const [i, [k, v]] of config.entries()) {
		env[`GIT_CONFIG_KEY_${i}`] = k;
		env[`GIT_CONFIG_VALUE_${i}`] = v;
	}
	const ctype = req.headers.get("content-type");
	if (ctype !== null) env.CONTENT_TYPE = ctype;
	const proto = req.headers.get("git-protocol");
	// Protocol v2 for fetches; the value lands in git's env, so only its own grammar passes.
	if (proto !== null && /^[A-Za-z0-9=:._-]{1,64}$/.test(proto))
		env.HTTP_GIT_PROTOCOL = proto;
	return env;
}

/** http-backend's stdin plus the parsed push commands; or the refusal Response. */
type GitInput =
	| {
			stdin: Uint8Array | ReadableStream<Uint8Array> | "ignore";
			pushed: PushCommand[];
	  }
	| { response: Response };

/** Prepares the request body for the request kind: buffered (and checked) for a push. */
async function gitInput(
	req: Request,
	grant: VmGrant,
	rest: string,
	env: Record<string, string>,
	encoding: string,
	o: GitHttpOptions,
): Promise<GitInput> {
	if (rest === "git-receive-pack") {
		// Buffered: the ref check reads the command section before git sees a byte.
		const body: Uint8Array<ArrayBuffer> = new Uint8Array(
			await req.arrayBuffer(),
		);
		const parsed = parseReceiveCommands(body);
		if ("error" in parsed) {
			o.log(`${grant.project}/${grant.taskId}: push refused: ${parsed.error}`);
			return { response: plain(parsed.error, 403) };
		}
		const refusal = pushRefusal(parsed.commands, grant.branch);
		if (refusal !== null) {
			o.log(`${grant.project}/${grant.taskId}: push refused: ${refusal}`);
			return { response: plain(refusal, 403) };
		}
		env.CONTENT_LENGTH = String(body.length);
		return { stdin: body, pushed: parsed.commands };
	}
	if (rest === "git-upload-pack") {
		// Streamed; http-backend inflates a gzip body itself (git gzips large fetch requests).
		if (encoding !== "") env.HTTP_CONTENT_ENCODING = "gzip";
		return { stdin: req.body ?? new Uint8Array(0), pushed: [] };
	}
	return { stdin: "ignore", pushed: [] };
}

/** One running http-backend: the CGI answer and the process's exit code. */
interface Backend {
	res: Response;
	exited: Promise<number>;
}

/** Spawns http-backend, wires abort killing and the stderr log, and answers as CGI. */
async function runBackend(
	grant: VmGrant,
	rest: string,
	env: Record<string, string>,
	stdin: Uint8Array | ReadableStream<Uint8Array> | "ignore",
	req: Request,
	o: GitHttpOptions,
): Promise<Backend> {
	const proc = Bun.spawn([gitExe(), "http-backend"], {
		cwd: grant.repoPath,
		env,
		stdin,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const kill = () => {
		if (proc.exitCode === null) proc.kill();
	};
	req.signal.addEventListener("abort", kill, { once: true });
	const stderr = new Response(proc.stderr).text();
	void Promise.all([proc.exited, stderr]).then(([code, err]) => {
		if (code !== 0 && !req.signal.aborted)
			o.log(
				`${grant.project}/${grant.taskId}: git http-backend ${rest} exited ${code}: ${err.trim().slice(-500)}`,
			);
	});
	return { res: await cgiResponse(proc.stdout, kill), exited: proc.exited };
}

/** Serves one smart-HTTP request for a VM token's own project and branch. */
export async function handleGit(
	req: Request,
	o: GitHttpOptions,
): Promise<Response> {
	const url = new URL(req.url);
	const access = checkAccess(req, url, o);
	if ("response" in access) return access.response;
	const { grant, rest } = access;
	const badMethod = methodGuard(req, rest, url);
	if (badMethod !== null) return badMethod;
	const badEncoding = encodingGuard(req, rest);
	if ("response" in badEncoding) return badEncoding.response;
	const env = cgiEnv(grant, rest, req, url);
	const input = await gitInput(req, grant, rest, env, badEncoding.encoding, o);
	if ("response" in input) return input.response;
	const backend = await runBackend(grant, rest, env, input.stdin, req, o);
	if (rest !== "git-receive-pack") return backend.res;
	// The push answer is a short report-status: buffer it, so the VM's push returns only once
	// the server worktree shows the pushed head.
	const bytes = new Uint8Array(await backend.res.arrayBuffer());
	const code = await backend.exited;
	if (backend.res.status === 200 && code === 0 && input.pushed.length > 0)
		await syncAfterPush(grant, o.log);
	return new Response(bytes, {
		status: backend.res.status,
		headers: backend.res.headers,
	});
}

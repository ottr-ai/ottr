import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ensureProjectPackages } from "./apt.ts";
import { platform } from "./platform/index.ts";
import { ensureProjectPython } from "./python.ts";
import { ensureProjectTools } from "./tools.ts";
import { type VmOutcome, WORKER_DONE } from "./workers.ts";

/**
 * The guest agent: the one process a microVM runs after its init (docker/ottr-vm-init). vm-runner
 * drives it over HTTP on <guestIp>:7070 (the guest protocol in the OTTR-532 design): copy files
 * in and out as tar, bake a project layer, and run one omp turn in a fresh clone of the task
 * branch that it pushes back to the board's git endpoint.
 */

export const GUEST_PORT = 7070;

/** The /run body vm-runner sends: the classic worker request plus where the branch lives. */
export interface GuestRunRequest {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	stdin: string;
	vm: {
		/** `${boardUrl}/git/${project}.git`. */
		gitUrl: string;
		branch: string;
		base: string;
		/** Per-turn VM token: git, /llm, /hindsight. */
		token: string;
		boardUrl: string;
		providers: string[];
		hindsight: boolean;
	};
}

/** One bake install step: ensureProjectPackages / ensureProjectTools / ensureProjectPython. */
export type Ensure = (project: string, home: string) => Promise<string[]>;

const TAIL = 4000;

/** Two zero blocks: a valid tar with no members, for a copy-out that found nothing. */
const EMPTY_TAR = new Uint8Array(1024);

/** A YAML mapping (not a sequence or scalar): the only shape models.yml can be merged into. */
const isMapping = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const isStrings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((s) => typeof s === "string");

type Loose<T> = { [K in keyof T]?: unknown };

function parseRun(raw: unknown): GuestRunRequest | null {
	if (typeof raw !== "object" || raw === null) return null;
	const v = raw as Loose<GuestRunRequest>;
	if (typeof v.vm !== "object" || v.vm === null) return null;
	const vm = v.vm as Loose<GuestRunRequest["vm"]>;
	if (
		!isStrings(v.argv) ||
		typeof v.cwd !== "string" ||
		!isAbsolute(v.cwd) ||
		typeof v.stdin !== "string" ||
		typeof v.env !== "object" ||
		v.env === null ||
		!Object.values(v.env).every((s) => typeof s === "string") ||
		typeof vm.gitUrl !== "string" ||
		vm.gitUrl === "" ||
		typeof vm.branch !== "string" ||
		vm.branch === "" ||
		typeof vm.base !== "string" ||
		typeof vm.token !== "string" ||
		typeof vm.boardUrl !== "string" ||
		!isStrings(vm.providers) ||
		typeof vm.hindsight !== "boolean"
	)
		return null;
	return raw as GuestRunRequest;
}

// The guest's git must act on the clone it names: a GIT_DIR or GIT_INDEX_FILE inherited from
// whatever launched the guest (a git hook running the test suite) would redirect every call.
function toolEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
	// A missing credential must fail the call, not wait forever on a prompt nobody sees.
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

interface ExecResult {
	ok: boolean;
	/** Raw stdout: porcelain lines keep their leading status column. */
	out: string;
	/** stderr trimmed, or a synthetic line when the command said nothing. */
	err: string;
}

/** Runs a guest tool (git, tar, sync) to its end; never throws. */
async function exec(argv: string[], cwd?: string): Promise<ExecResult> {
	try {
		const p = Bun.spawn(argv, {
			cwd,
			env: toolEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		return {
			ok: code === 0,
			out,
			err: err.trim() || `${argv.slice(0, 2).join(" ")} exited ${code}`,
		};
	} catch (err) {
		return {
			ok: false,
			out: "",
			err: err instanceof Error ? err.message : String(err),
		};
	}
}

const git = (cwd: string | undefined, args: string[]): Promise<ExecResult> =>
	exec(["git", ...args], cwd);

/**
 * Routes each provider through the board's /llm proxy in `<agentDir>/models.yml`: the VM holds no
 * provider secret, only the per-turn token omp reads from OTTR_VM_TOKEN. Every other key of the
 * file (other providers, a provider's own model list) stays as the layer shipped it.
 */
function writeProviderOverrides(
	agentDir: string,
	providers: readonly string[],
	llmUrl: string,
): void {
	const file = join(agentDir, "models.yml");
	const doc: unknown = existsSync(file)
		? (Bun.YAML.parse(readFileSync(file, "utf8")) ?? {})
		: {};
	if (!isMapping(doc)) throw new Error(`${file}: not a YAML mapping`);
	const current = doc.providers ?? {};
	if (!isMapping(current))
		throw new Error(`${file}: providers is not a YAML mapping`);
	const next: Record<string, unknown> = { ...current };
	for (const id of providers) {
		const own = current[id];
		next[id] = {
			...(isMapping(own) ? own : {}),
			baseUrl: llmUrl,
			apiKey: "OTTR_VM_TOKEN",
			transport: "pi-native",
		};
	}
	doc.providers = next;
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(file, Bun.YAML.stringify(doc, null, 2));
}

/** Regular files under `abs` (or `abs` itself) changed after `since`, as names relative to /. */
function changedFiles(abs: string, since: number, out: string[]): void {
	let st: Stats;
	try {
		st = lstatSync(abs);
	} catch {
		return; // gone, or vanished mid-walk
	}
	if (st.isFile()) {
		if (st.mtimeMs > since) out.push(abs.slice(1));
		return;
	}
	// Symlinks are never followed: a link out of the dir must not copy foreign files back.
	if (!st.isDirectory()) return;
	let names: string[];
	try {
		names = readdirSync(abs);
	} catch {
		return;
	}
	for (const name of names) changedFiles(join(abs, name), since, out);
}

/** Why a copy-in tar is refused: a member that names a path outside its relative-to-/ form. */
function unsafeMember(names: readonly string[]): string | null {
	for (const name of names)
		if (name.startsWith("/") || name.split("/").includes("..")) return name;
	return null;
}

const tail = (s: string): string => s.replace(/\r\n/g, "\n").slice(-TAIL);

/**
 * One NDJSON response whose body `pump` fills. `push` turns silent once the client is gone;
 * `onGone` fires once when the client left before the body ended.
 */
function ndjson(
	pump: (push: (text: string) => void) => Promise<void>,
	onGone: () => void,
): Response {
	const enc = new TextEncoder();
	let closed = false;
	const gone = (): void => {
		if (closed) return;
		closed = true;
		onGone();
	};
	const stream = new ReadableStream({
		start(controller) {
			const push = (text: string): void => {
				if (closed) return;
				try {
					controller.enqueue(enc.encode(text));
				} catch {
					gone(); // the stream ended without cancel(): nobody reads the run now
				}
			};
			void pump(push)
				// An unhandled rejection would end the guest, and with it the VM and every
				// later call; the stream ends without a sentinel instead (the client's lost run).
				.catch((err) => console.error(`vmGuest: ${String(err)}`))
				.finally(() => {
					if (closed) return;
					closed = true;
					try {
						controller.close();
					} catch {
						// already gone
					}
				});
		},
		cancel() {
			gone();
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

export interface GuestOptions {
	/** 7070 by default; tests pass 0 for a free port. */
	port?: number;
	/** Every route but GET /healthz needs it in x-ottr-guest-token. */
	token: string;
	/** Only for tests: the command the guest runs instead of `omp`. */
	ompPath?: string;
	/** How often a moved HEAD is pushed to the board while omp runs; 60 s by default. */
	pushIntervalMs?: number;
	/** Only for tests: replace the bake installs. */
	ensure?: { packages?: Ensure; tools?: Ensure; python?: Ensure };
}

export function serveGuest(opts: GuestOptions): Bun.Server<never> {
	const pushIntervalMs = opts.pushIntervalMs ?? 60_000;
	// One turn per VM: /kill reaches it, and a second /run is refused while it lives.
	let current: { kill(): void } | null = null;

	const handleRun = (request: Request, body: GuestRunRequest): Response => {
		const { vm, cwd } = body;
		const boardUrl = vm.boardUrl.replace(/\/+$/, "");
		let child: ChildProcess | null = null;
		let killed = false;
		const kill = (): void => {
			killed = true;
			if (child?.pid !== undefined) platform.killTree(child.pid);
		};
		const self = { kill };
		current = self;
		request.signal.addEventListener("abort", kill);

		const outcome: VmOutcome = { head: null, pushError: null, dirty: null };
		const status = async (): Promise<string[] | null> => {
			const st = await git(cwd, [
				"status",
				"--porcelain",
				"--untracked-files=all",
			]);
			return st.ok ? st.out.split("\n").filter((l) => l !== "") : null;
		};
		const finish = (
			push: (text: string) => void,
			exitCode: number | null,
			stderrTail: string,
		): void => {
			push(
				`${JSON.stringify({ [WORKER_DONE]: { exitCode, stderrTail: tail(stderrTail), vm: outcome } })}\n`,
			);
		};
		// The VM has no shared home with an identity; commits must still work. A global
		// identity the image ships wins.
		const setIdentity = async (): Promise<void> => {
			for (const [key, value] of [
				["user.name", "Ottr agent"],
				["user.email", "ottr-agent@localhost"],
			] as const)
				if (!(await git(cwd, ["config", "--get", key])).ok)
					await git(cwd, ["config", key, value]);
		};
		// The clone authenticates with the turn token; the header persists in the clone's
		// own config, scoped to the board's URL, so every later push and fetch carries it.
		const cloneTurn = async (
			push: (text: string) => void,
		): Promise<string | null> => {
			const header = `Authorization: Bearer ${vm.token}`;
			const clone = await git(undefined, [
				"-c",
				`http.extraHeader=${header}`,
				"clone",
				"--branch",
				vm.branch,
				"--no-single-branch",
				"--",
				vm.gitUrl,
				cwd,
			]);
			if (!clone.ok) {
				outcome.pushError = clone.err;
				finish(push, 1, `${clone.err}\n`);
				return null;
			}
			const scoped = await git(cwd, [
				"config",
				`http.${vm.gitUrl}.extraHeader`,
				header,
			]);
			if (!scoped.ok) {
				outcome.pushError = scoped.err;
				finish(push, 1, `${scoped.err}\n`);
				return null;
			}
			await setIdentity();
			const cloned = await git(cwd, ["rev-parse", "HEAD"]);
			if (!cloned.ok) {
				outcome.pushError = cloned.err;
				finish(push, 1, `${cloned.err}\n`);
				return null;
			}
			return cloned.out.trim();
		};
		// The guest's own env stays out of the turn (its token above all); omp gets a
		// working PATH, locale and home, then exactly what the board sent.
		const turnEnv = (): Record<string, string> => {
			const env: Record<string, string> = {};
			for (const k of ["PATH", "LANG", "HOME"]) {
				const v = process.env[k];
				if (v !== undefined) env[k] = v;
			}
			Object.assign(env, body.env);
			return env;
		};
		// Routes the turn's providers through the board's /llm proxy; false ends the turn.
		const addProviders = async (
			push: (text: string) => void,
			env: Record<string, string>,
		): Promise<boolean> => {
			const agentDir = body.env.PI_CODING_AGENT_DIR;
			if (vm.providers.length === 0 || !agentDir) return true;
			try {
				writeProviderOverrides(agentDir, vm.providers, `${boardUrl}/llm`);
			} catch (err) {
				outcome.dirty = await status();
				finish(
					push,
					1,
					`${err instanceof Error ? err.message : String(err)}\n`,
				);
				return false;
			}
			env.OTTR_VM_TOKEN = vm.token;
			return true;
		};
		// --no-verify: this push only syncs the board's copy of the branch; the
		// project's own pre-push checks belong to the real push to origin.
		const pushSha = async (sha: string): Promise<void> => {
			const r = await git(cwd, [
				"push",
				"--no-verify",
				"origin",
				`+${sha}:refs/heads/${vm.branch}`,
			]);
			if (r.ok) {
				outcome.head = sha;
				outcome.pushError = null;
			} else outcome.pushError = r.err;
		};
		// Pushes run one at a time, and each pushes the exact sha it read: HEAD can move
		// between the read and the push, and head must name what the board received.
		let chain: Promise<void> = Promise.resolve();
		const pushIfMoved = (cloneHead: string): Promise<void> => {
			chain = chain.then(async () => {
				const rev = await git(cwd, ["rev-parse", "HEAD"]);
				if (!rev.ok) {
					outcome.pushError = rev.err;
					return;
				}
				const sha = rev.out.trim();
				if (sha === (outcome.head ?? cloneHead)) return;
				await pushSha(sha);
			});
			return chain;
		};
		// Runs omp to its end, streaming its stdout; returns the turn's exit and stderr.
		const runOmp = async (
			push: (text: string) => void,
			env: Record<string, string>,
			cloneHead: string,
		): Promise<{ exitCode: number | null; stderrTail: string }> => {
			let exitCode: number | null = null;
			let stderrTail = "";
			// A /kill or a client abort during the clone means no turn at all.
			if (!killed) {
				try {
					child = spawn(opts.ompPath ?? "omp", body.argv, {
						cwd,
						env,
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
					});
				} catch (err) {
					stderrTail = `spawn failed: ${String(err)}\n`;
					exitCode = 1;
				}
			}
			const spawned = child;
			if (spawned !== null) {
				const timer = setInterval(
					() => void pushIfMoved(cloneHead),
					pushIntervalMs,
				);
				const ended = Promise.withResolvers<number | null>();
				spawned.stderr?.on("data", (chunk: Buffer) => {
					stderrTail = tail(`${stderrTail}${chunk.toString("utf8")}`);
				});
				let partial = "";
				spawned.stdout?.on("data", (chunk: Buffer) => {
					partial += chunk.toString("utf8");
					let idx = partial.indexOf("\n");
					while (idx >= 0) {
						push(partial.slice(0, idx + 1));
						partial = partial.slice(idx + 1);
						idx = partial.indexOf("\n");
					}
				});
				// omp may die before reading stdin; a bare write would then crash the guest.
				spawned.stdin?.on("error", () => {});
				spawned.stdin?.write(body.stdin, "utf8");
				spawned.stdin?.end();
				// A spawn failure (omp missing) never runs the turn: it ends as a failure.
				spawned.on("error", (err: Error) => {
					stderrTail = tail(`${stderrTail}${err.message}\n`);
					ended.resolve(1);
				});
				spawned.on("close", (code) => {
					if (partial.length > 0) push(`${partial}\n`);
					ended.resolve(code);
				});
				exitCode = await ended.promise;
				clearInterval(timer);
				// The pid is free for reuse now: a late abort or /kill must not signal it.
				child = null;
			}
			return { exitCode, stderrTail };
		};
		// The board reads the turn's uncommitted files with the sentinel; a file over the
		// cap is named, not sent.
		const settle = async (
			push: (text: string) => void,
			exitCode: number | null,
			stderrTail: string,
		): Promise<void> => {
			outcome.dirty = await status();
			const left = collectBoardFiles(cwd);
			if (left.files.length > 0) outcome.files = left.files;
			let sent = stderrTail;
			if (left.skipped.length > 0)
				sent = tail(
					`${stderrTail}board files over ${BOARD_FILES_MAX_BYTES} bytes, not sent: ${left.skipped.join(", ")}\n`,
				);
			finish(push, exitCode, sent);
		};
		const pump = async (push: (text: string) => void): Promise<void> => {
			const cloneHead = await cloneTurn(push);
			if (cloneHead === null) return;
			const env = turnEnv();
			if (!(await addProviders(push, env))) return;
			if (vm.hindsight) {
				env.HINDSIGHT_API_URL = `${boardUrl}/hindsight`;
				env.HINDSIGHT_API_TOKEN = vm.token;
			}
			const { exitCode, stderrTail } = await runOmp(push, env, cloneHead);
			await pushIfMoved(cloneHead);
			await settle(push, exitCode, stderrTail);
		};

		return ndjson(
			(push) =>
				pump(push).finally(() => {
					if (current === self) current = null;
				}),
			kill,
		);
	};

	/** Runs the bake installs, pushing each note line; the turn's exit code and stderr. */
	const runBake = async (
		project: string,
		push: (text: string) => void,
	): Promise<{ exitCode: number; stderrTail: string }> => {
		const steps: Ensure[] = [
			opts.ensure?.packages ?? ensureProjectPackages,
			opts.ensure?.tools ?? ensureProjectTools,
			opts.ensure?.python ?? ensureProjectPython,
		];
		let exitCode = 0;
		let stderrTail = "";
		try {
			for (const step of steps)
				for (const line of await step(project, "/root")) push(`${line}\n`);
		} catch (err) {
			exitCode = 1;
			stderrTail = tail(
				`${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		return { exitCode, stderrTail };
	};

	const handleBake = (project: string): Response =>
		ndjson(
			async (push) => {
				const { exitCode, stderrTail } = await runBake(project, push);
				// vm-runner stops the VM right after the sentinel, with no clean shutdown: the
				// installs must be on the layer disk before it can read the line.
				await exec(["sync"]);
				push(
					`${JSON.stringify({ [WORKER_DONE]: { exitCode, stderrTail } })}\n`,
				);
			},
			() => {},
		);

	/** PUT /files: unpacks the copy-in tar at /, after refusing unsafe member names. */
	const putFiles = async (request: Request): Promise<Response> => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-guest-in-"));
		try {
			const file = join(dir, "in.tar");
			await Bun.write(file, new Response(request.body));
			// Listed before extracting: GNU tar only warns about (and strips) a leading "/" or
			// "../", and the copy-in must refuse such a tar whole rather than write part of it.
			const list = await exec(["tar", "-t", "-f", file]);
			if (!list.ok) return new Response(list.err, { status: 400 });
			const bad = unsafeMember(list.out.split("\n").filter((l) => l !== ""));
			if (bad !== null)
				return new Response(`refused member: ${bad}`, { status: 400 });
			const x = await exec([
				"tar",
				"-x",
				"-f",
				file,
				"-C",
				"/",
				"--no-same-owner",
			]);
			if (!x.ok) return new Response(x.err, { status: 500 });
			return new Response("ok");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	const getFiles = (url: URL): Response => {
		const path = url.searchParams.get("path");
		const since = Number(url.searchParams.get("since") ?? "0");
		if (path === null || !isAbsolute(path) || !Number.isFinite(since))
			return new Response("bad request", { status: 400 });
		const names: string[] = [];
		changedFiles(resolve(path), since, names);
		if (names.length === 0)
			return new Response(EMPTY_TAR, {
				headers: { "content-type": "application/x-tar" },
			});
		const p = Bun.spawn(
			[
				"tar",
				"-c",
				"-f",
				"-",
				"-C",
				"/",
				"--no-recursion",
				"--null",
				"--verbatim-files-from",
				"-T",
				"-",
			],
			{
				stdin: new TextEncoder().encode(`${names.join("\0")}\0`),
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		return new Response(p.stdout, {
			headers: { "content-type": "application/x-tar" },
		});
	};

	/** The /files routes; null falls through when the method does not match. */
	const handleFiles = async (
		request: Request,
		url: URL,
	): Promise<Response | null> => {
		if (url.pathname !== "/files") return null;
		if (request.method === "PUT") return putFiles(request);
		if (request.method === "GET") return getFiles(url);
		return null;
	};

	const handleKill = (): Response => {
		const running = current;
		running?.kill();
		return Response.json({ killed: running !== null });
	};

	/** A project name the bake may act on, or null. */
	const bakeProject = (body: unknown): string | null => {
		const project =
			typeof body === "object" && body !== null && "project" in body
				? body.project
				: undefined;
		// The name becomes a path under /root/.ottr/workers.
		if (
			typeof project !== "string" ||
			project === "" ||
			project.includes("/") ||
			project === ".."
		)
			return null;
		return project;
	};

	const handleBakeRequest = async (request: Request): Promise<Response> => {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return new Response("bad json", { status: 400 });
		}
		const project = bakeProject(body);
		if (project === null) return new Response("bad request", { status: 400 });
		return handleBake(project);
	};

	const handleRunRequest = async (request: Request): Promise<Response> => {
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return new Response("bad json", { status: 400 });
		}
		const body = parseRun(raw);
		if (body === null) return new Response("bad request", { status: 400 });
		if (current !== null)
			return new Response("a run is active", { status: 409 });
		return handleRun(request, body);
	};

	/** The POST routes; null falls through to the not-found answer. */
	const handlePost = async (
		request: Request,
		url: URL,
	): Promise<Response | null> => {
		if (url.pathname === "/kill") return handleKill();
		if (url.pathname === "/bake") return handleBakeRequest(request);
		if (url.pathname === "/run") return handleRunRequest(request);
		return null;
	};

	return Bun.serve({
		port: opts.port ?? GUEST_PORT,
		hostname: "0.0.0.0",
		// Long silent turns must not be cut by an idle timeout.
		idleTimeout: 0,
		// Copy-in tars carry whole data dirs; Bun's 128 MB default would cut them.
		maxRequestBodySize: 64 * 1024 ** 3,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/healthz")
				return new Response("ok");
			if (request.headers.get("x-ottr-guest-token") !== opts.token)
				return new Response("unauthorized", { status: 401 });
			const files = await handleFiles(request, url);
			if (files !== null) return files;
			if (request.method === "POST") {
				const posted = await handlePost(request, url);
				if (posted !== null) return posted;
			}
			return new Response("not found", { status: 404 });
		},
	});
}

if (import.meta.main) {
	const token = process.env.OTTR_VM_GUEST_TOKEN;
	if (!token) {
		console.error("vmGuest: OTTR_VM_GUEST_TOKEN is not set");
		process.exit(1);
	}
	// The bake installs inherit this process's env: the guest token goes no further.
	delete process.env.OTTR_VM_GUEST_TOKEN;
	serveGuest({ token });
}

/** Total raw bytes of the uncommitted files a turn hands back on the done sentinel. */
export const BOARD_FILES_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The uncommitted files the board reads after a turn: `research-report.md` and every regular
 * file under `shots/` (no symlink followed), worktree-relative with base64 bytes. Files that
 * would push the total past BOARD_FILES_MAX_BYTES are skipped and named in `skipped`.
 */
export function collectBoardFiles(cwd: string): {
	files: { path: string; b64: string }[];
	skipped: string[];
} {
	const found: string[] = [];
	try {
		if (lstatSync(join(cwd, "research-report.md")).isFile())
			found.push("research-report.md");
	} catch {
		// no report
	}
	const walk = (rel: string): void => {
		let st: Stats;
		try {
			st = lstatSync(join(cwd, rel));
		} catch {
			return;
		}
		if (st.isFile()) found.push(rel);
		else if (st.isDirectory())
			for (const name of readdirSync(join(cwd, rel)).sort())
				walk(`${rel}/${name}`);
	};
	walk("shots");
	const files: { path: string; b64: string }[] = [];
	const skipped: string[] = [];
	let total = 0;
	for (const path of found) {
		let data: Buffer;
		try {
			data = readFileSync(join(cwd, path));
		} catch {
			continue;
		}
		if (total + data.length > BOARD_FILES_MAX_BYTES) {
			skipped.push(path);
			continue;
		}
		total += data.length;
		files.push({ path, b64: data.toString("base64") });
	}
	return { files, skipped };
}

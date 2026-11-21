/**
 * sandbox_run's board client and server-side runner client
 * (docs/specs/microvm-validation-mode.md, "Board endpoint and tool"). The
 * tool (extension/tracker.ts) POSTs its args to the board's sandbox endpoint
 * with the run's own credential (runSandboxViaBoard); the board's server
 * packs the target checkout with git archive plus the checkout's installed
 * node_modules (OTTR-1167), writes the tar under the run
 * dir, and POSTs the runner's /validate with its own token (runSandboxJob).
 * The endpoint caps the job and the VM at VM_VALIDATE.timeoutSec +
 * lifetimeSlackSec and answers after both, so neither client sets a timeout
 * of its own. Callers: extension/tracker.ts (the tool), src/app.ts (the
 * endpoint), src/vmValidateSmoke.ts and src/vmValidateBoardSmoke.ts (the
 * host smokes). Everything effectful is injected, so tests run without git,
 * network or /data.
 */
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { childDatabaseEnv } from "./childEnv.ts";
import { projectTrustedLists } from "./trustedLists.ts";
import {
	cwdUnderTarget,
	type ValidateRequest,
	type ValidateResponse,
	VM_VALIDATE,
} from "./vmValidateShared.ts";

/** The runner's project-name rule, copied from src/vmRunner.ts PROJECT_NAME. */
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The job cwd's root in the guest; the runner takes only paths at or under it. */
const TARGET_ROOT = "/target";

/** One spawn on the job-prep path (the git archive, the tar append): the
 * produced bytes, or the failure with its stderr. */
export type ProcSpawn = (
	argv: string[],
) => Promise<{ code: number; stdout: Uint8Array; stderr: string }>;

const defaultSpawn: ProcSpawn = async (argv) => {
	const proc = Bun.spawn(argv, {
		env: childDatabaseEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, stdout: new Uint8Array(stdout), stderr };
};

/** val-<epoch seconds>-<4 random hex bytes>; fits the ValidateRequest id rule. */
export const newJobId = (): string =>
	`val-${Math.floor(Date.now() / 1000)}-${randomBytes(4).toString("hex")}`;

export interface SandboxJobOptions {
	/** Must pass PROJECT_NAME; names the run dir and the /data record. */
	project: string;
	/** The calling run's card id, carried on the ValidateRequest (its taskId) so the
	 *  runner names the card on the System view; optional. */
	taskId?: string;
	/** Git ref to archive; default HEAD. */
	ref?: string;
	/** The job's command; a non-empty list of strings. */
	argv: string[];
	/** Job cwd; absolute, normalized, at or under /target. Default "/target". */
	cwd?: string;
	/** Scratch-relative paths to promote; at most VM_VALIDATE.collectMaxNames. */
	collect?: string[];
	/** The checkout git packs; default /workspace/<project>. */
	checkout?: string;
	/** Defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Defaults to a Bun.spawn runner for the archive and the tar append. */
	spawnImpl?: ProcSpawn;
	/** Read per call; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** The run dir sits at <dataRoot>/<project>/validate-jobs/<id>; default /data. */
	dataRoot?: string;
	/** Defaults to newJobId. */
	idFactory?: () => string;
}

export type SandboxJobResult =
	| { ok: true; result: ValidateResponse }
	| { ok: false; error: string };

function argvError(argv: string[]): string | null {
	if (argv.length === 0 || !argv.every((x) => typeof x === "string"))
		return "job.argv must be a non-empty list of strings";
	return null;
}

// Absolute, a posix.normalize identity, and at or under /target: the same shape
// the runner's inside() check takes (src/vmRunner.ts), plus the root itself
// because the default cwd is /target.
function cwdError(cwd: string): string | null {
	if (!cwdUnderTarget(cwd))
		return `job.cwd must be an absolute, normalized path at or under ${TARGET_ROOT} (got "${cwd}")`;
	return null;
}

// The runner's promotion rules reject absolute, empty, "." and ".." names
// before the job runs, so the caller sees the rule and not a 400.
function collectError(collect: string[]): string | null {
	if (collect.length > VM_VALIDATE.collectMaxNames)
		return `job.collect takes at most ${VM_VALIDATE.collectMaxNames} names (got ${collect.length})`;
	for (const name of collect) {
		const bad =
			isAbsolute(name) ||
			name === "" ||
			name.split("/").some((c) => c === "" || c === "." || c === "..");
		if (bad)
			return `job.collect names must be relative paths without empty, "." or ".." parts (got "${name}")`;
	}
	return null;
}

/**
 * Packs the target and runs one validation job. All input checks run before
 * any effect, so a bad call spends no git run and no tar write; the env checks
 * come first, because a misconfigured host must not pack at all.
 */
export async function runSandboxJob(
	o: SandboxJobOptions,
): Promise<SandboxJobResult> {
	const project = o.project;
	if (!PROJECT_NAME.test(project))
		return {
			ok: false,
			error: `project "${project}" is not a project name (src/vmRunner.ts PROJECT_NAME)`,
		};
	const argvErrorText = argvError(o.argv);
	if (argvErrorText !== null) return { ok: false, error: argvErrorText };
	const argv = o.argv;

	const cwd = o.cwd ?? TARGET_ROOT;
	const cwdErrorText = cwdError(cwd);
	if (cwdErrorText !== null) return { ok: false, error: cwdErrorText };

	const collect = o.collect ?? [];
	const collectErrorText = collectError(collect);
	if (collectErrorText !== null) return { ok: false, error: collectErrorText };

	const env = o.env ?? process.env;
	const base = (env.OTTR_VM_RUNNER_URL ?? "").trim().replace(/\/+$/, "");
	if (base === "")
		return {
			ok: false,
			error:
				"OTTR_VM_RUNNER_URL is not set; set it and bring up the vm-runner compose service (--profile vm) to run sandbox jobs.",
		};
	const token = (env.OTTR_WORKER_TOKEN ?? "").trim();
	if (token === "")
		return {
			ok: false,
			error:
				"OTTR_WORKER_TOKEN is not set; the runner rejects an unauthorized /validate call.",
		};

	const id = (o.idFactory ?? newJobId)();
	const runDir = join(
		// OTTR_DATA_DIR is the board’s data dir (the compose stack sets it to /data);
		// honoring it here keeps the tar on the volume the runner reads, on any layout.
		o.dataRoot ?? env.OTTR_DATA_DIR ?? "/data",
		project,
		"validate-jobs",
		id,
	);
	const targetTar = join(runDir, "target.tar");

	const spawn = o.spawnImpl ?? defaultSpawn;
	const checkout = o.checkout ?? join("/workspace", project);
	// `--` ends git's option parsing: a caller-supplied ref is a tree-ish, never a
	// flag. Without it, a value like --output=/path would truncate a host file or
	// --remote=<host> would dial out from this process before git failed on the
	// missing tree-ish.
	const archive = await spawn([
		"git",
		"-C",
		checkout,
		"archive",
		"--",
		o.ref ?? "HEAD",
	]);
	if (archive.code !== 0 || archive.stdout.length === 0) {
		const why = archive.stderr.trim().slice(-500);
		const empty = archive.code === 0 ? ", empty archive" : "";
		return {
			ok: false,
			error: `git archive failed (exit ${archive.code}${empty}): ${why}`,
		};
	}

	try {
		await mkdir(runDir, { recursive: true });
		await writeFile(targetTar, archive.stdout);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `cannot write ${targetTar} (${why})` };
	}

	// Pack the checkout's installed node_modules after the tree (OTTR-1167): the
	// sandbox has no network, no package cache, and the baked project layer
	// installs apt and pip lists only, so a job that imports a project
	// dependency resolves it only from /target/node_modules. --hard-dereference
	// matters: bun installs hard-link files from its cache, and the runner's tar
	// reader unpacks regular files, dirs and symlinks but skips hard-link
	// members, so a dereferenced copy is the only layout that unpacks whole.
	// The tree comes from the checkout's working install, so it can skew the
	// packed ref; reusing it beats leaving every dependency lead blocked.
	const nodeModules = join(checkout, "node_modules");
	let nmExists = false;
	try {
		nmExists = lstatSync(nodeModules).isDirectory();
	} catch {
		nmExists = false;
	}
	if (nmExists) {
		const pack = await spawn([
			"tar",
			"--append",
			"--file",
			targetTar,
			"--hard-dereference",
			"--directory",
			checkout,
			"node_modules",
		]);
		if (pack.code !== 0) {
			const why = pack.stderr.trim().slice(-500);
			return {
				ok: false,
				error: `tar append of node_modules failed (exit ${pack.code}): ${why}`,
			};
		}
	}

	const request: ValidateRequest = {
		id,
		project,
		...(o.taskId ? { taskId: o.taskId } : {}),
		targetTar,
		// The validate bake reads the dispatch's trusted texts, never the shared
		// home (docs/specs/vm-list-isolation.md).
		lists: projectTrustedLists(project),
		job: {
			argv,
			cwd,
			...(collect.length > 0 ? { collect } : {}),
		},
	};

	// No client-side timeout: the runner kills the job at VM_VALIDATE.timeoutSec
	// and the VM at timeoutSec + lifetimeSlackSec, then answers.
	const fetchImpl = o.fetchImpl ?? fetch;
	let res: Response;
	try {
		res = await fetchImpl(`${base}/validate`, {
			method: "POST",
			headers: {
				// The token rides the wire only, like /run; it never enters the
				// request body or any text this function returns.
				"x-otwr-token": token,
				"content-type": "application/json",
			},
			body: JSON.stringify(request),
		});
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `the runner at ${base} is unreachable (${why})`,
		};
	}
	const bodyText = await res.text();
	// Defense in depth: a misbehaving runner must not echo the wire token into
	// the error text the audit stores as its exact blocker.
	const safe =
		token === "" ? bodyText : bodyText.replaceAll(token, "[REDACTED]");
	if (res.status !== 200)
		return { ok: false, error: `${res.status}: ${safe.slice(0, 500)}` };
	let result: ValidateResponse;
	try {
		result = JSON.parse(bodyText) as ValidateResponse;
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `the runner answered 200 with invalid JSON (${why}): ${safe.slice(0, 500)}`,
		};
	}
	return { ok: true, result };
}

/** The board coordinates the tracker injects into every task session; the
 * sandbox_run tool reads them per call, like propose_task. */
export interface SandboxBoardEnv {
	/** OTTR_BOARD_URL, without a trailing slash. */
	base: string;
	/** OTTR_PROJECT: the calling run's own project, the route's scope. */
	project: string;
	/** OTTR_TASK_ID: the calling run's card; the endpoint checks its kind. */
	taskId: string;
	/** OTTR_BOARD_TOKEN; "" on loopback, where the wall needs no token. */
	token: string;
	/** OTTR_RUN_TOKEN: this run's own credential, bound to `project` and `taskId`. */
	runToken: string;
}

/** The JSON body the tool POSTs to the board's sandbox endpoint. */
export interface SandboxRunBody {
	taskId: string;
	project: string;
	ref?: string;
	argv: string[];
	cwd?: string;
	collect?: string[];
}

/**
 * The arg rules the tool client and the board endpoint share: an agent sees
 * the rule before a round trip, and the server re-checks the untrusted body
 * at its boundary. Returns the error text, or null when the body is valid.
 */
export function sandboxRequestError(body: unknown): string | null {
	if (typeof body !== "object" || body === null)
		return "the sandbox request must be a JSON object";
	const b = body as Record<string, unknown>;
	if (typeof b.taskId !== "string" || b.taskId.trim() === "")
		return "taskId must be this run's task id (OTTR_TASK_ID)";
	if (typeof b.project !== "string" || !PROJECT_NAME.test(b.project))
		return "project must be a project name (letters, digits, dot, dash, underscore)";
	if (
		!Array.isArray(b.argv) ||
		b.argv.length === 0 ||
		!b.argv.every((x) => typeof x === "string")
	)
		return "argv must be a non-empty list of strings";
	if (b.ref !== undefined && (typeof b.ref !== "string" || b.ref.trim() === ""))
		return "ref must be a non-empty string when given";
	if (b.cwd !== undefined) {
		if (typeof b.cwd !== "string" || cwdError(b.cwd) !== null)
			return `cwd must be an absolute, normalized path at or under ${TARGET_ROOT}`;
	}
	if (b.collect !== undefined) {
		if (
			!Array.isArray(b.collect) ||
			b.collect.some((x) => typeof x !== "string")
		)
			return "collect must be a list of scratch-relative paths";
		const collectErrorText = collectError(b.collect as string[]);
		if (collectErrorText !== null) return collectErrorText;
	}
	return null;
}

export type SandboxBoardResult =
	| { ok: true; result: ValidateResponse }
	| { ok: false; error: string };

/**
 * The board leg of sandbox_run: POST the args to the board's sandbox endpoint
 * with this run's own credential. The server checks the run kind, packs and
 * calls the runner with its own token; this client holds none. No client-side
 * timeout: one validation runs up to the mode's job cap plus boot slack, and
 * the endpoint lifts the idle cut for its request.
 */
export async function runSandboxViaBoard(
	board: SandboxBoardEnv,
	req: Omit<SandboxRunBody, "taskId">,
	fetchImpl: typeof fetch = fetch,
): Promise<SandboxBoardResult> {
	const body: SandboxRunBody = { taskId: board.taskId, ...req };
	const invalid = sandboxRequestError(body);
	if (invalid !== null) return { ok: false, error: invalid };
	let res: Response;
	try {
		res = await fetchImpl(
			`${board.base}/api/projects/${encodeURIComponent(board.project)}/sandbox`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: board.base,
					...(board.token !== "" ? { "x-board-token": board.token } : {}),
					...(board.runToken !== "" ? { "x-run-token": board.runToken } : {}),
				},
				body: JSON.stringify(body),
			},
		);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `the board at ${board.base} is unreachable (${why})`,
		};
	}
	const text = await res.text();
	if (res.status !== 200) {
		const named = jsonError(text);
		return {
			ok: false,
			error: named ?? `${res.status}: ${text.slice(0, 500)}`,
		};
	}
	let parsed: { ok?: unknown; result?: unknown };
	try {
		parsed = JSON.parse(text) as { ok?: unknown; result?: unknown };
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `the board answered 200 with invalid JSON (${why})`,
		};
	}
	if (
		parsed.ok !== true ||
		typeof parsed.result !== "object" ||
		parsed.result === null
	)
		return { ok: false, error: "the board answered 200 without a result" };
	return { ok: true, result: parsed.result as ValidateResponse };
}

/** The board's `{"error": "..."}` text, or null when the body names no error. */
function jsonError(text: string): string | null {
	try {
		const out = JSON.parse(text) as { error?: unknown };
		return typeof out.error === "string" && out.error !== "" ? out.error : null;
	} catch {
		return null;
	}
}

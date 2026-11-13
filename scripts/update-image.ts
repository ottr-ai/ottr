#!/usr/bin/env bun
import { createHash } from "node:crypto";
// Deploys main to a compose stack. Run it on a schedule from a clean `main` checkout
// (docs/WORKERS.md, "Updates"): it fast-forwards main, builds the image, and rolls the
// stack one runner at a time. The restart is idle-first: a runner that runs no turn at
// this moment recreates with the new image at once and without a hold, and a busy runner
// is skipped — it stays on the old image, and a later run rolls it. Only when a pending
// restart has waited longer than RESTART_WAIT_WARN_MS (6 h) does a run hold new turns
// again: it holds one worker's new turns, recreates that worker with the new image,
// waits until it is healthy and connected, releases it, and goes to the next worker.
// The server rolls last without a board-wide hold: when no turn needs the server, it
// holds local and the workers for the seconds of the restart window and recreates; in
// the hold phase it also holds the server's own turns, waits them out, and tells each
// busy worker to detach its running turn (the turn survives the restart, and the new
// server re-binds it). A runner that keeps a turn past 1 h in the hold phase is released, and
// the step waits for a later run. A board without the runner API holds the whole board
// and restarts it at once. With ALATE_DATA or ALATE_DATA_REPO in the env file
// it also seeds the board's agent layer (docs/WORKERS.md, "Seed the board config"). The omp
// pin moves on main only
// (.github/workflows/omp-bump.yml), so a host needs read access and never pushes.
// Its arguments go to every `docker compose` call, e.g. -f docker-compose.yml -f <override>.
// `--seed-only` seeds the board's agent layer only when the data source moved — no
// build, no pull, no restart. Both modes share one lock: the seed-only run skips with
// exit 0 when the lock is held, and the full run waits up to 10 minutes, then exits 1.
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { type GitResult, git, redact } from "../src/worktree.ts";

export interface Deps {
	/** `docker <args>` in the checkout: exit code and output. */
	docker: (...args: string[]) => Promise<{ code: number; out: string }>;
	log: (line: string) => void;
	/** Pause between two turn counts while the board finishes its turns. */
	wait: (ms: number) => Promise<void>;
	/** Clock in ms (Date.now) that measures the hold against its limit. */
	now: () => number;
	/** GitHub REST probe; the default prefixes https://api.github.com. Tests inject a fake. */
	githubApi?: (path: string, token: string) => Promise<Response>;
}

// Counted inside the server container, so the host needs no board port.
const COUNT_TURNS =
	"const s = await (await fetch('http://127.0.0.1:' + process.env.PORT + '/api/state')).json();" +
	"console.log(s.tasks.filter((t) => t.state === 'running' || t.state === 'preparing').length);";
// Holds new turns for 30 min (POST /api/drain), on loopback like the count. The board's
// Origin wall wants its own origin on a POST. The body is JSON-encoded twice, so quotes
// and backslashes in the subjects survive the bun -e code string.
const holdTurns = (commits: string[]): string => {
	const body = JSON.stringify(JSON.stringify({ commits }));
	return (
		"const u = 'http://127.0.0.1:' + process.env.PORT;" +
		`const r = await fetch(u + '/api/drain', { method: 'POST', headers: { origin: u, 'content-type': 'application/json' }, body: ${body} });` +
		"if (!r.ok) { console.log('HTTP ' + r.status); process.exit(1); }"
	);
};
// Ends the hold at once (DELETE /api/drain), with the same origin as the hold.
const FREE_TURNS =
	"const u = 'http://127.0.0.1:' + process.env.PORT;" +
	"const r = await fetch(u + '/api/drain', { method: 'DELETE', headers: { origin: u } });" +
	"if (!r.ok) { console.log('HTTP ' + r.status); process.exit(1); }";
// The runner state the roll reads (GET /api/drain): per-runner holds and turn counts.
// A GET needs no origin. A board older than the runner API answers 404, and the run
// takes the whole-board path.
const READ_RUNNERS =
	"const u = 'http://127.0.0.1:' + process.env.PORT;" +
	"const r = await fetch(u + '/api/drain');" +
	"if (!r.ok) { console.log('HTTP ' + r.status); process.exit(1); }" +
	"console.log(await r.text());";
// Holds one runner (a worker hostname) for 30 min (POST /api/drain), with the same
// origin and double-encoded body as holdTurns.
const holdRunner = (runner: string): string => {
	const body = JSON.stringify(JSON.stringify({ runner }));
	return (
		"const u = 'http://127.0.0.1:' + process.env.PORT;" +
		`const r = await fetch(u + '/api/drain', { method: 'POST', headers: { origin: u, 'content-type': 'application/json' }, body: ${body} });` +
		"if (!r.ok) { console.log('HTTP ' + r.status); process.exit(1); }"
	);
};
// Ends one runner's hold (DELETE /api/drain?runner=), with the same origin as the hold.
// The runner id is a plain string, so one encode: the double-encoded body style above
// is for JSON text, and a second encode here would send quotes in the query param.
const freeRunner = (runner: string): string =>
	"const u = 'http://127.0.0.1:' + process.env.PORT;" +
	`const r = await fetch(u + '/api/drain?runner=' + encodeURIComponent(${JSON.stringify(runner)}), { method: 'DELETE', headers: { origin: u } });` +
	"if (!r.ok) { console.log('HTTP ' + r.status); process.exit(1); }";
// Probes a new worker's own /healthz from the server, so the roll knows the worker is
// connected before the next one rolls. The url comes from the board's runner list, as
// one string: a second encode would fetch a quoted literal and never reach the worker.
const probeRunner = (url: string): string =>
	`const r = await fetch(${JSON.stringify(`${url}/healthz`)});` +
	"if (!r.ok) { console.log('HTTP ' + r.status); process.exit(1); }";
// Tells a busy worker to release its /run streams and keep its omp children (POST
// /detach, token-gated like /run): the server's death then drops only the streams,
// and the new server's boot recovery re-binds the runs. It runs inside the worker's
// own container, so the port and the token come from its env.
const DETACH_WORKER =
	"const r = await fetch('http://127.0.0.1:' + (process.env.WORKER_PORT || 8787) + '/detach', { method: 'POST', headers: { 'x-otwr-token': process.env.OTTR_WORKER_TOKEN } });" +
	"if (!r.ok) { console.log('HTTP ' + r.status); process.exit(1); }";
// Reads a worker's detached runs (GET /detached, token-gated like /run): a run the
// server step detached in an earlier run re-binds on the new server, and the board's
// runner count cannot see it. An old worker without the route answers 404: no runs.
const DETACHED_LIST =
	'const r = await fetch("http://127.0.0.1:" + (process.env.WORKER_PORT || 8787) + "/detached", { headers: { "x-otwr-token": process.env.OTTR_WORKER_TOKEN } });' +
	'if (r.status === 404) console.log("[]");' +
	'else if (!r.ok) { console.log("HTTP " + r.status); process.exit(1); }' +
	"else console.log(await r.text());";
// The running turns a deferred server restart waits for: card ids from /api/state,
// read like the count. They name the warning line a long wait logs.
const WAIT_TURNS =
	"const s = await (await fetch('http://127.0.0.1:' + process.env.PORT + '/api/state')).json();" +
	"console.log(s.tasks.filter((t) => t.state === 'running' || t.state === 'preparing').map((t) => t.id).join(' '));";
// The runner poll repeats every 30 s while a hold waits its turns out. The scheduled task
// starts no second run meanwhile (IgnoreNew), so the run that built the image restarts the stack.
const POLL_MS = 30_000;
// The hold phase caps each hold at 1 h, so a long turn (a mutation run of several hours)
// stops the queue of new turns for 1 h at most. The hold phase starts only when a pending
// restart has waited past RESTART_WAIT_WARN_MS; before that, a run holds no new turns.
// Then the run ends the hold, and a later run tries again.
const HOLD_LIMIT_MS = 60 * 60_000;
// A deferred server restart logs its wait, and warns past 6 h: a turn that holds the
// restart overnight must not sit in the log unnamed. The same 6 h also arms the hold
// phase: until the pending restart has waited this long, a run holds no new turns.
const RESTART_WAIT_WARN_MS = 6 * 60 * 60_000;
// A rolled worker must answer its healthz soon: at most 5 min, then the roll stops and
// keeps the not-yet-rolled containers on the old image.
const CONNECT_LIMIT_MS = HOLD_LIMIT_MS / 12;

/** The real docker dep puts stderr first: compose warnings come before the answer's last line. */
const lastLine = (out: string): string =>
	out.trim().split("\n").at(-1)?.trim() ?? "";

/** A wait in hours and minutes: 0 min, 7 h 5 min, and exact hours without minutes (8 h). */
const fmtWait = (ms: number): string => {
	const m = Math.round(ms / 60_000);
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
};

/** The env-file keys this script reads itself; compose reads the rest from --env-file. */
const SCRIPT_KEYS = new Set([
	"ALATE_DATA",
	"ALATE_DATA_REPO",
	"ALATE_IMAGE",
	"GH_TOKEN",
]);

/** Parses one env-file line for a SCRIPT_KEYS key: key and value, or null to skip. */
function parseEnvLine(line: string): [string, string] | null {
	const t = line.trim();
	if (t === "" || t.startsWith("#")) return null;
	const eq = t.indexOf("=");
	if (eq <= 0) return null;
	const key = t.slice(0, eq).trim();
	if (!SCRIPT_KEYS.has(key)) return null;
	const raw = t.slice(eq + 1).trim();
	const end = raw[0] === '"' || raw[0] === "'" ? raw.indexOf(raw[0], 1) : -1;
	// ponytail: no escapes inside double quotes; add them when a key needs one.
	return [key, end > 0 ? raw.slice(1, end) : raw.replace(/\s+#.*$/, "")];
}

/**
 * The script's own keys (SCRIPT_KEYS) from the env files a run passes as `--env-file`,
 * else from the repo root's `.env` (cwd-relative), as compose does. Later files win;
 * blank and `#` lines are skipped, and a value may itself contain `=`. Like compose, a
 * quoted value loses its quotes and the text after them, and an unquoted value loses a
 * ` # comment`. Pure: it reads, it never touches the environment.
 */
export function envFileValues(args: string[]): Record<string, string> {
	const files = envFiles(args);
	if (files.length === 0 && existsSync(".env")) files.push(".env");
	const values: Record<string, string> = {};
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue; // a named file that is gone must not fail the run
		}
		for (const line of text.split("\n")) {
			const parsed = parseEnvLine(line);
			if (parsed === null) continue;
			values[parsed[0]] = parsed[1];
		}
	}
	return values;
}

/** The files a run passes as `--env-file`, in order. */
function envFiles(args: string[]): string[] {
	const files: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === undefined) break;
		if (a === "--env-file") files.push(args[++i] ?? "");
		else if (a.startsWith("--env-file="))
			files.push(a.slice("--env-file=".length));
	}
	return files;
}

/**
 * Bun loads the cwd's `.env` files into process.env before the script starts, and every
 * compose child would pass them on as shell values that beat `--env-file`. Compose ignores
 * `.env` when `--env-file` is given, so this removes what Bun loaded: it asks a bare Bun
 * child (empty env) what it loads in the cwd and in tmpdir, and deletes each key that only
 * the cwd child shows. On Windows a child gets the OS user variables (PATH, USERPROFILE,
 * ...) even with an empty env, so the cwd child alone cannot tell .env keys from OS keys.
 * A shell key with another value stays.
 */
export function dropBunDotenv(
	args: string[],
	env: Record<string, string | undefined> = process.env,
): void {
	if (envFiles(args).length === 0) return;
	// Windows needs SYSTEMROOT to start a process; NODE_ENV picks Bun's `.env.<mode>` file.
	const base: Record<string, string> = {};
	for (const k of ["SYSTEMROOT", "NODE_ENV"])
		if (env[k] !== undefined) base[k] = env[k];
	const probe = (cwd?: string) => {
		const r = Bun.spawnSync(
			[process.execPath, "-e", "console.log(JSON.stringify(process.env))"],
			{ env: base, cwd },
		);
		if (r.exitCode !== 0)
			throw new Error(`bun could not list its .env values: ${r.stderr}`);
		return JSON.parse(r.stdout.toString()) as Record<string, string>;
	};
	const loaded = probe();
	const bare = probe(tmpdir());
	// ponytail: a shell key with the same value as `.env` goes too; compose then reads it
	// from --env-file. Read the start env (/proc/self/environ) if that case matters.
	for (const [k, v] of Object.entries(loaded))
		if (!(k in base) && !(k in bare) && env[k] === v) delete env[k];
}

/**
 * The platform manifest a compose service's container runs. Only the containerd image
 * store reports one; null there means no descriptor (classic store, an older engine, or
 * output that is no JSON), and the image ids decide as before.
 */
async function serviceManifest(
	d: Deps,
	compose: string[],
	service: string,
): Promise<{ digest: string; platform: string } | null> {
	const ps = await d.docker("compose", ...compose, "ps", "-q", service);
	if (ps.code !== 0) return null;
	const r = await d.docker(
		"inspect",
		"-f",
		"{{json .ImageManifestDescriptor}}",
		lastLine(ps.out),
	);
	if (r.code !== 0) return null;
	try {
		const m = JSON.parse(lastLine(r.out)) as {
			digest?: string;
			platform?: { os: string; architecture: string; variant?: string };
		} | null;
		if (!m?.digest || !m.platform) return null;
		const p = m.platform;
		return {
			digest: m.digest,
			platform: [p.os, p.architecture, p.variant].filter(Boolean).join("/"),
		};
	} catch {
		return null;
	}
}

/**
 * Whether a service's build differs from the image its container runs, or the docker
 * output of the step that failed. Under the containerd image store each build gets a new
 * index id, because its provenance attestation records the build, so the platform
 * manifests compare, not the image ids, or every rebuild would count as new.
 */
async function imageChanged(
	d: Deps,
	compose: string[],
	service: string,
): Promise<{ changed: boolean } | { error: string }> {
	const runs = await serviceManifest(d, compose, service);
	const live = runs
		? { code: 0, out: runs.digest }
		: await d.docker("compose", ...compose, "images", "-q", service);
	const name = await d.docker(
		"compose",
		...compose,
		"config",
		"--images",
		service,
	);
	const built = await d.docker(
		"image",
		"inspect",
		...(runs ? ["--platform", runs.platform] : []),
		"-f",
		"{{.Id}}",
		lastLine(name.out),
	);
	const failed = [live, name, built].find((r) => r.code !== 0);
	if (failed !== undefined) return { error: failed.out.trim() };
	return {
		changed:
			lastLine(built.out).replace(/^sha256:/, "") !==
			lastLine(live.out).replace(/^sha256:/, ""),
	};
}

/**
 * The compose services a host-only override builds from another local git checkout
 * (docs/WORKERS.md, "Updates"); the compose files in this repo build only from the repo.
 * The build contexts come from `compose config`, so this repo never names the foreign
 * service. A context in this repo, or outside a git checkout, is not one.
 */
async function sidecarCheckouts(
	d: Deps,
	compose: string[],
	repo: string,
	running: string[],
): Promise<{ service: string; dir: string }[]> {
	const cfg = await d.docker(
		"compose",
		...compose,
		"config",
		"--format",
		"json",
	);
	const start = cfg.out.indexOf("{");
	if (cfg.code !== 0 || start < 0) {
		d.log(`compose config failed: ${lastLine(cfg.out)}`);
		return [];
	}
	let services: Record<string, { build?: { context?: string } }> | null = null;
	// docker compose config's own JSON: its top shape is stable, the per-service shape is
	// read fail-soft (a malformed entry only skips that service).
	try {
		const parsed: unknown = JSON.parse(cfg.out.slice(start));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"services" in parsed &&
			typeof parsed.services === "object" &&
			parsed.services !== null
		)
			services = parsed.services as Record<
				string,
				{ build?: { context?: string } }
			>;
	} catch {
		// not JSON: services stays null, logged below
	}
	if (services === null) {
		d.log("compose config is not JSON: deploying no foreign checkouts");
		return [];
	}
	// compose config keeps only the active services, while compose ps lists every
	// container of the project: a service whose profile the env file does not enable
	// runs, but this run would never see it in the config and never rebuild it.
	for (const service of running)
		if (!Object.hasOwn(services, service))
			d.log(
				`${service} runs but its compose profile is not active; set COMPOSE_PROFILES so updates reach it`,
			);
	const found: { service: string; dir: string }[] = [];
	for (const [service, s] of Object.entries(services)) {
		const ctx = s.build?.context;
		if (!ctx) continue;
		const dir = resolve(repo, ctx);
		if (dir === resolve(repo) || !existsSync(join(dir, ".git"))) continue;
		found.push({ service, dir });
	}
	return found;
}

type Git = (...args: string[]) => ReturnType<typeof git>;

/** Why a sidecar checkout keeps its state instead of a fast-forward to origin/main, else
 * null after the fast-forward. */
async function fastForward(sg: Git): Promise<string | null> {
	if ((await sg("branch", "--show-current")).stdout.trim() !== "main")
		return "is not on main";
	if ((await sg("status", "--porcelain")).stdout.trim())
		return "has uncommitted changes";
	if ((await sg("merge", "--ff-only", "--quiet", "origin/main")).code !== 0)
		return "does not fast-forward to origin/main";
	return null;
}

/** Builds `service` from a fresh worktree of `sha`, removed again afterwards; null when
 * no worktree comes up. One more compose file points the build at the worktree; every
 * other build setting of the service stays. */
async function buildFromWorktree(
	d: Deps,
	compose: string[],
	sg: Git,
	service: string,
	sha: string,
): Promise<{ code: number; out: string } | null> {
	const tree = mkdtempSync(join(tmpdir(), `ottr-deploy-${service}-`));
	const ctx = `${tree}.yml`;
	try {
		if ((await sg("worktree", "add", "--detach", "--quiet", tree, sha)).code)
			return null;
		writeFileSync(
			ctx,
			`services:\n  ${JSON.stringify(service)}:\n    build:\n      context: ${JSON.stringify(tree)}\n`,
		);
		return await d.docker("compose", ...compose, "-f", ctx, "build", service);
	} finally {
		await sg("worktree", "remove", "--force", tree);
		rmSync(tree, { recursive: true, force: true });
		rmSync(ctx, { force: true });
	}
}

/**
 * Deploys one service that a host-only override builds from another local git checkout.
 * A person works in such a checkout, so the build never reads it: its local files would
 * land in the image (COPY . .), and a commit made there moves no HEAD on a fast-forward.
 * Each run builds the service from a fresh worktree of its origin/main instead (a cached
 * build is cheap), and a changed image restarts that service at once: no turn calls it,
 * and the board's provision trigger fires only when no turn runs (src/app.ts). The checkout
 * itself fast-forwards only when it is clean and on main, so the host's tools in it stay
 * current.
 */
async function deploySidecar(
	d: Deps,
	compose: string[],
	{ service, dir }: { service: string; dir: string },
): Promise<void> {
	const sg = (...args: string[]) => git(args, dir);
	if ((await sg("fetch", "--quiet", "origin", "main")).code !== 0) {
		d.log(`skipping ${service}: git fetch origin main failed in ${dir}`);
		return;
	}
	const kept = await fastForward(sg);
	if (kept !== null) d.log(`${service}: ${dir} ${kept}, so it stays as it is`);
	const sha = (
		await sg("rev-parse", "--short=12", "origin/main")
	).stdout.trim();
	const made =
		sha === "" ? null : await buildFromWorktree(d, compose, sg, service, sha);
	if (made === null) {
		d.log(`skipping ${service}: no worktree of origin/main from ${dir}`);
		return;
	}
	if (made.code !== 0) {
		d.log(made.out.trim().split("\n").slice(-10).join("\n"));
		d.log(
			`skipping ${service}: the image does not build; the stack keeps the old one`,
		);
		return;
	}
	const r = await imageChanged(d, compose, service);
	if ("error" in r) {
		d.log(
			`skipping ${service}: its image cannot be compared with the build: ${r.error}`,
		);
		return;
	}
	if (!r.changed) {
		d.log(`${service}: the rebuild matches the running image`);
		return;
	}
	d.log(`${service}: the build changes the running image`);
	const up = await d.docker(
		"compose",
		...compose,
		"up",
		"-d",
		"--no-deps",
		"--wait",
		service,
	);
	d.log(
		up.code === 0
			? `${service}: the stack runs origin/main at ${sha}`
			: `${service}: docker compose up --wait failed: ${up.out.trim()}`,
	);
}

/** Deploys exactly origin/main: returns the stop reason, or null when the checkout is clean. */
async function preflightStop(g: (...args: string[]) => Promise<GitResult>) {
	if ((await g("branch", "--show-current")).stdout.trim() !== "main")
		return "the checkout is not on main";
	if ((await g("status", "--porcelain")).stdout.trim())
		return "the checkout has uncommitted changes";
	if ((await g("fetch", "--quiet", "origin", "main")).code !== 0)
		return "git fetch origin main failed";
	if (
		(await g("rev-list", "--count", "origin/main..HEAD")).stdout.trim() !== "0"
	)
		return "main has commits that origin/main lacks";
	return null;
}

/**
 * The ALATE_DATA_REPO branch of seedSource: ls-remote the wanted ref and probe the seed
 * token's expiry. The probe is advisory: it logs a failure and never fails the run, and
 * only the date leaves this function, never the token.
 */
async function repoSeed(
	d: Deps,
	env: Record<string, string | undefined>,
	repo: string,
	ALATE_DATA_REPO: string,
): Promise<
	| { wanted: string; args: string[]; tokenExpires?: string | null }
	| { failed: string }
> {
	const { GH_TOKEN } = env;
	const [name, ref = "main"] = ALATE_DATA_REPO.split("@");
	const auth =
		GH_TOKEN === undefined
			? []
			: [
					"-c",
					"credential.helper=!f(){ echo username=x-access-token; echo password=$GH_TOKEN; };f",
				];
	const r = await git(
		[...auth, "ls-remote", `https://github.com/${name}`, `refs/heads/${ref}`],
		repo,
	);
	const wanted = r.stdout.trim().split(/\s+/)[0] ?? "";
	if (r.code !== 0 || wanted === "")
		return { failed: `git ls-remote ${name} failed` };
	// Advisory probe: the seed token's expiry from the REST response header. Never
	// fails the run, and only the date leaves this function, never the token.
	let tokenExpires: string | null | undefined;
	if (GH_TOKEN !== undefined) {
		const api =
			d.githubApi ??
			((path: string, token: string) =>
				fetch(`https://api.github.com${path}`, {
					headers: {
						authorization: `Bearer ${token}`,
						accept: "application/vnd.github+json",
					},
				}));
		try {
			const res = await api(`/repos/${name}`, GH_TOKEN);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const h = res.headers.get("github-authentication-token-expiration");
			tokenExpires =
				h === null
					? "none"
					: new Date(h.replace(" ", "T").replace(/ UTC$/, "Z")).toISOString();
		} catch {
			d.log("board seed token expiry check failed");
		}
	}
	return {
		wanted,
		args: ["run", "--rm", "--no-deps", "board-seed", "--repo", ALATE_DATA_REPO],
		tokenExpires,
	};
}

/**
 * What seeds the board's agent layer, and the board-seed args for it: ALATE_DATA (a local
 * checkout of the data repo, its HEAD is wanted) or ALATE_DATA_REPO (`owner/name[@ref]`
 * on GitHub, with the token in the child env, never in argv). ALATE_DATA wins when both
 * are set. Null means the environment names no data source; `{ failed }` means the wanted
 * head could not be read.
 */
async function seedSource(
	d: Deps,
	env: Record<string, string | undefined>,
	repo: string,
): Promise<
	| { wanted: string; args: string[]; tokenExpires?: string | null }
	| { failed: string }
	| null
> {
	const { ALATE_DATA, ALATE_DATA_REPO } = env;
	if (ALATE_DATA === undefined) {
		if (ALATE_DATA_REPO === undefined) {
			d.log(
				"board seed: no ALATE_DATA or ALATE_DATA_REPO in the environment; the board keeps its current agent layer",
			);
			return null;
		}
		return repoSeed(d, env, repo, ALATE_DATA_REPO);
	}
	if (ALATE_DATA_REPO !== undefined)
		d.log("board seed: ALATE_DATA wins over ALATE_DATA_REPO");
	const r = await git(["rev-parse", "HEAD"], ALATE_DATA);
	const wanted = r.stdout.trim();
	if (r.code !== 0 || wanted === "")
		return { failed: `git rev-parse HEAD failed in ${ALATE_DATA}` };
	return {
		wanted,
		args: [
			"run",
			"--rm",
			"--no-deps",
			"-v",
			`${ALATE_DATA}:/data:ro`,
			"board-seed",
			"--data",
			"/data",
		],
	};
}

/**
 * The alate image the board-seed service runs in: ALATE_IMAGE, else the running alate of
 * this compose project, else the running container named exactly `alate`. Docker's name
 * filter is an unanchored regex, so a bare `name=alate` also matches `translate-api`: the
 * seed would run that image with GH_TOKEN and the board-config volume. `discovered` marks
 * an image read from docker, which the compose child then needs as ALATE_IMAGE for
 * `${ALATE_IMAGE:-...}`.
 */
async function alateImage(
	d: Deps,
	compose: string[],
	env: Record<string, string | undefined>,
): Promise<{ image: string; discovered: boolean } | null> {
	if (env.ALATE_IMAGE !== undefined)
		return { image: env.ALATE_IMAGE, discovered: false };
	const ps = await d.docker("compose", ...compose, "ps", "-q", "alate");
	if (ps.code === 0 && ps.out.trim() !== "") {
		const r = await d.docker(
			"inspect",
			"-f",
			"{{.Config.Image}}",
			lastLine(ps.out),
		);
		if (r.code === 0 && r.out.trim() !== "")
			return { image: lastLine(r.out), discovered: true };
	}
	const dps = await d.docker(
		"ps",
		"--filter",
		"name=^/?alate$",
		"--format",
		"{{.Image}}",
	);
	const image = dps.out.split("\n")[0]?.trim() ?? "";
	return image === "" ? null : { image, discovered: true };
}

/**
 * Ends the hold once the next poll would end past HOLD_LIMIT_MS: the hold ends (FREE_TURNS),
 * and the restart waits for a later run (exit code 0).
 */
async function releaseHold(
	d: Deps,
	exec: (code: string) => Promise<{ code: number; out: string }>,
	turns: string,
): Promise<0> {
	const freed = await exec(FREE_TURNS);
	d.log(
		freed.code === 0
			? `${turns} turns run after ${HOLD_LIMIT_MS / 60_000} min of hold: the hold ends, and the restart waits for a later run`
			: `${turns} turns run after ${HOLD_LIMIT_MS / 60_000} min of hold, and the board cannot end the hold (${lastLine(freed.out)}): it lapses 30 min after the last renewal`,
	);
	return 0;
}

/**
 * Legacy only: the whole-board hold a board older than the runner API keeps (the
 * rolling path never calls this). Waits out the running turns on the live board.
 * Returns an early exit code (1 via stop, 0 when the restart waits for a later
 * run), or null to proceed to `compose up`. `pending` says what makes the coming
 * restart worth the hold: a new image, a seeded agent layer, or both.
 */
async function drainRunningBoard(
	d: Deps,
	compose: string[],
	commits: string[],
	pending: boolean,
	stop: (why: string) => number,
): Promise<number | null> {
	const exec = (code: string) =>
		d.docker("compose", ...compose, "exec", "-T", "server", "bun", "-e", code);
	// A new image holds new turns, so the running ones finish and the restart finds the board
	// idle. The run waits while turns run, for at most HOLD_LIMIT_MS. Then it ends the hold
	// (FREE_TURNS), so queued cards start at once instead of when the last renewal lapses.
	// A board that refuses the hold (one older than POST /api/drain) ends the wait: then the
	// restart waits for an idle hour.
	const hold = async (): Promise<boolean> => {
		const r = await exec(holdTurns(commits));
		if (r.code !== 0)
			d.log(`the board cannot hold new turns: ${lastLine(r.out)}`);
		return r.code === 0;
	};
	let held = pending && (await hold());
	const since = d.now();
	let turns = "";
	for (let i = 0; ; i++) {
		const count = await exec(COUNT_TURNS);
		turns = lastLine(count.out);
		if (count.code !== 0 || !/^\d+$/.test(turns))
			return stop(`the board's turns cannot be counted: ${count.out.trim()}`);
		if (!held || turns === "0") break;
		if (i === 0)
			d.log(
				`${turns} turns run: the board holds new turns, and the restart follows when they finish`,
			);
		// The next poll would end past the limit.
		if (d.now() - since + POLL_MS > HOLD_LIMIT_MS)
			return releaseHold(d, exec, turns);
		await d.wait(POLL_MS);
		held = await hold();
	}
	if (turns !== "0") {
		d.log(`${turns} turns run: the restart waits for a later run`);
		return 0;
	}
	return null;
}

/** What the run deploys, read once before the build and reused by the later phases. */
type RunMeta = { head: string; omp: string; commits: string[] };

/** Deploys exactly origin/main and reads the deploy metadata; a number stops the run. */
async function preflightAndRead(
	repo: string,
	g: (...args: string[]) => Promise<GitResult>,
	stop: (why: string) => number,
): Promise<RunMeta | number> {
	const stopped = await preflightStop(g);
	if (stopped !== null) return stop(stopped);
	// Before the merge: HEAD is what the running stack was built from, so its subjects
	// are what the restart brings. A failed read must never block the deploy.
	const rev = await g("rev-parse", "HEAD");
	const deployed = rev.code === 0 ? rev.stdout.trim() : "";
	if ((await g("merge", "--ff-only", "--quiet", "origin/main")).code !== 0)
		return stop("main does not fast-forward to origin/main");
	// Read before the build: the hold between build and restart can last an hour, and main
	// can move in the checkout meanwhile. The success line names what the image built.
	const head = (await g("log", "-1", "--format=%h")).stdout.trim();
	const dockerfile = await Bun.file(resolve(repo, "Dockerfile.worker")).text();
	const omp = /^ARG OMP_VERSION=(\S+)/m.exec(dockerfile)?.[1] ?? "unknown";
	// Computed once: the hold renews every 30 s and each renewal reuses this list.
	const commits =
		deployed === ""
			? []
			: (await g("log", "--format=%s", "-n", "50", `${deployed}..HEAD`)).stdout
					.split("\n")
					.map((s) => s.trim().slice(0, 200))
					.filter(Boolean)
					.slice(0, 50);
	return { head, omp, commits };
}

/** Builds the server image and deploys the sidecar checkouts; a number stops the run. */
async function buildAndSidecars(
	d: Deps,
	compose: string[],
	repo: string,
	running: string[],
	stop: (why: string) => number,
): Promise<number | null> {
	const build = await d.docker("compose", ...compose, "build", "server");
	if (build.code !== 0) {
		d.log(build.out.trim().split("\n").slice(-10).join("\n"));
		return stop("the image does not build; the stack keeps the old one");
	}
	// Services a host-only override builds from another local git checkout (the compose
	// files in this repo name none) deploy on their own (deploySidecar).
	for (const s of await sidecarCheckouts(d, compose, repo, running))
		await deploySidecar(d, compose, s);
	return null;
}

/**
 * The microVM runner (compose profile `vm`) builds another target of the same
 * Dockerfile under its own image name, so the server build above leaves it on its old
 * image, and its compare would never see a change. It builds only where it runs: a
 * host without the profile never fetches Firecracker and the guest kernel.
 */
async function buildVmRunner(
	d: Deps,
	compose: string[],
	services: string[],
	stop: (why: string) => number,
): Promise<number | null> {
	if (!services.includes("vm-runner")) return null;
	const build = await d.docker("compose", ...compose, "build", "vm-runner");
	if (build.code === 0) return null;
	d.log(build.out.trim().split("\n").slice(-10).join("\n"));
	return stop(
		"the vm-runner image does not build; the stack keeps the old one",
	);
}

/** One ps of the running services; a ps that fails stops the run (fails closed). */
async function runningServices(
	d: Deps,
	compose: string[],
	stop: (why: string) => number,
): Promise<string[] | number> {
	const running = await d.docker(
		"compose",
		...compose,
		"ps",
		"--services",
		"--status",
		"running",
	);
	if (running.code !== 0)
		return stop(`docker compose ps failed: ${running.out.trim()}`);
	return running.out
		.trim()
		.split("\n")
		.map((s) => s.trim());
}

/** What the seed phase leaves for the later phases. */
type SeedOutcome = {
	seeded: boolean;
	failed: boolean;
	wantedSha: string;
	expires: string | null | undefined;
};

/** The board's current seed-commit record, or null when absent or the board is down. */
async function readSeedRecord(
	d: Deps,
	compose: string[],
	serverWasRunning: boolean,
): Promise<string | null> {
	if (!serverWasRunning) return null;
	const r = await d.docker(
		"compose",
		...compose,
		"exec",
		"-T",
		"server",
		"sh",
		"-c",
		"cat /etc/ottr/seed-commit",
	);
	const read = r.code === 0 ? r.out.trim() : "";
	return read !== "" ? read : null;
}

/**
 * The seed-failure record the board reads for its red bell notice: the first failure's
 * time (a later failed run keeps it, like the wait clock), the data-repo sha the seed
 * tried, and the redacted tail of the failure text. Secret-shaped env values are
 * redacted out, quotes and control characters never reach the printf's shell string,
 * and the tail holds about 1000 characters. Advisory: a failed read or write only
 * loses or restarts the notice, and never fails the run.
 */
async function seedFailRecord(
	d: Deps,
	compose: string[],
	wantedSha: string,
	failText: string,
	env: Record<string, string | undefined>,
): Promise<void> {
	const exec = (code: string) =>
		d.docker("compose", ...compose, "exec", "-T", "server", "sh", "-c", code);
	const prev = await exec("cat /etc/ottr/seed-failed");
	let since = d.now();
	if (prev.code === 0) {
		try {
			const kept: unknown = JSON.parse(prev.out.trim());
			if (
				typeof kept === "object" &&
				kept !== null &&
				"since" in kept &&
				typeof kept.since === "number" &&
				Number.isInteger(kept.since) &&
				kept.since > 0
			)
				since = kept.since;
		} catch {
			// An unreadable record restarts the first-failure clock.
		}
	}
	const secrets = Object.entries(env)
		.filter(
			([name, value]) =>
				value !== undefined &&
				value.length >= 8 &&
				/TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|KEY/i.test(name),
		)
		.map(([, value]) => value as string);
	const text = redact(failText, secrets)
		// Control characters become spaces so a multi-line failure stays one readable
		// line, and a single quote is dropped: it would end the printf's shell string.
		.replace(/[\p{Cc}]+/gu, " ")
		.replaceAll("'", "")
		.trim()
		.slice(-1000);
	const record = {
		since,
		commit: /^[0-9a-f]{7,40}$/.test(wantedSha) ? wantedSha : "",
		text,
	};
	const w = await exec(
		`printf %s '${JSON.stringify(record)}' > /etc/ottr/seed-failed`,
	);
	if (w.code !== 0)
		d.log(
			"the seed-failed record write failed: the board cannot show a notice",
		);
}

/** A successful seed removes the record, so the notice goes with the failure. Advisory:
 * a failed removal only keeps a stale notice until the next successful seed. */
async function seedFailClear(d: Deps, compose: string[]): Promise<void> {
	const w = await d.docker(
		"compose",
		...compose,
		"exec",
		"-T",
		"server",
		"sh",
		"-c",
		"rm -f /etc/ottr/seed-failed",
	);
	if (w.code !== 0)
		d.log("the seed-failed record removal failed: the board keeps the notice");
}

/** Runs the board-seed service once, discovering ALATE_IMAGE for the child when needed. */
async function runSeed(
	d: Deps,
	compose: string[],
	env: Record<string, string | undefined>,
	seed: { wanted: string; args: string[] },
	outcome: SeedOutcome,
): Promise<SeedOutcome> {
	const found = await alateImage(d, compose, env);
	if (found === null) {
		d.log(
			"board seed failed: no alate image found; set ALATE_IMAGE in the env file",
		);
		await seedFailRecord(
			d,
			compose,
			outcome.wantedSha,
			"no alate image found; set ALATE_IMAGE in the env file",
			env,
		);
		return { ...outcome, failed: true };
	}
	// A discovered image must reach the compose child, or the board-seed service
	// interpolates the ghcr default and pulls an image that may not exist.
	const prev = process.env.ALATE_IMAGE;
	if (found.discovered) process.env.ALATE_IMAGE = found.image;
	try {
		const run = await d.docker("compose", ...compose, ...seed.args);
		if (run.code !== 0) {
			d.log(
				`board seed failed: ${run.out.trim().split("\n").slice(-3).join("\n")}`,
			);
			await seedFailRecord(d, compose, outcome.wantedSha, run.out, env);
			return { ...outcome, failed: true };
		}
		d.log(`board agent layer seeded at ${seed.wanted.slice(0, 12)}`);
		await seedFailClear(d, compose);
		return { ...outcome, seeded: true };
	} finally {
		if (found.discovered) {
			if (prev === undefined) delete process.env.ALATE_IMAGE;
			else process.env.ALATE_IMAGE = prev;
		}
	}
}

/**
 * Seeds the board's agent layer when the data source moved. The board-seed service is
 * its only writer (never the worker-writable shared home). A failed seed never blocks
 * the deploy, but the run exits 1: after the normal success line, or when the drain
 * ends it early.
 */
async function seedBoard(
	d: Deps,
	compose: string[],
	repo: string,
	env: Record<string, string | undefined>,
	serverWasRunning: boolean,
): Promise<SeedOutcome> {
	const untouched: SeedOutcome = {
		seeded: false,
		failed: false,
		wantedSha: "",
		expires: undefined,
	};
	const seed = await seedSource(d, env, repo);
	if (seed === null) return untouched; // seedSource already logged the skip.
	if ("failed" in seed) {
		d.log(`board seed failed: ${seed.failed}`);
		await seedFailRecord(d, compose, "", seed.failed, env);
		return { ...untouched, failed: true };
	}
	const outcome: SeedOutcome = {
		seeded: false,
		failed: false,
		wantedSha: seed.wanted,
		expires: seed.tokenExpires,
	};
	if ((await readSeedRecord(d, compose, serverWasRunning)) === seed.wanted) {
		d.log(`board agent layer current at ${seed.wanted.slice(0, 12)}`);
		return outcome;
	}
	return runSeed(d, compose, env, seed, outcome);
}

/** One runner the board reports on GET /api/drain: a worker hostname, or local for the server. */
type Runner = {
	id: string;
	url: string | null;
	until: number | null;
	turns: number;
};

/**
 * The board's answer to GET /api/drain, or null when no board answers the route (a
 * board one version older, or a failed read). A failed read falls to the legacy path,
 * which holds and restarts the whole board or stops — it never rolls half-blind.
 */
async function readRunners(
	exec: (code: string) => Promise<{ code: number; out: string }>,
): Promise<{ preparing: number; runners: Runner[] } | null> {
	const r = await exec(READ_RUNNERS);
	// ponytail: the exec prints only HTTP text when the route fails, so JSON.parse
	// would throw on it anyway — this check fails fast, and its false-mutant cannot
	// change the outcome (the catch below returns null all the same).
	if (r.code !== 0) return null;
	try {
		const s = JSON.parse(lastLine(r.out)) as {
			preparing?: number;
			runners?: Runner[];
		};
		if (!Array.isArray(s.runners)) return null;
		return { preparing: s.preparing ?? 0, runners: s.runners };
	} catch {
		return null;
	}
}

/**
 * The whole-board flow a board older than the runner API keeps, unchanged: hold new
 * turns on the whole board, wait them out, `up -d --wait`, and restart a running
 * server that keeps its image but took a seed. Returns the early exit code, or null
 * when the stack is up.
 */
async function legacyDrainAndRestart(
	d: Deps,
	compose: string[],
	commits: string[],
	seeded: boolean,
	seedFailed: boolean,
	serverWasRunning: boolean,
	wantedSha: string,
	stop: (why: string) => number,
): Promise<number | null> {
	// The build tags the server's image name; a server on another image means that the
	// restart brings a new image. imageChanged compares the platform manifests where
	// the containerd image store reports them: the image ids differ on every build.
	const r = await imageChanged(d, compose, "server");
	if ("error" in r)
		return stop(
			`the server's image cannot be compared with the build: ${r.error}`,
		);
	const holdCommits = seeded
		? [...commits, `board agent layer seed ${wantedSha.slice(0, 12)}`]
		: commits;
	const early = await drainRunningBoard(
		d,
		compose,
		holdCommits,
		r.changed || seeded,
		stop,
	);
	// ponytail: seedFailed forces exit 1 at the end regardless, and stop() always
	// returns 1, so this mapping cannot change the run's exit — Stryker's mutants of
	// it are behavior-preserving.
	if (early !== null) return early === 0 && seedFailed ? 1 : early;
	// --wait fails the run when the recreated board never turns healthy, so the script
	// never logs success for a crash-loop.
	const up = await d.docker("compose", ...compose, "up", "-d", "--wait");
	if (up.code !== 0)
		return stop(`docker compose up --wait failed: ${up.out.trim()}`);
	// The recreate already rebooted a server whose image changed, and up started a board
	// that was down with the seed. Only a running board that keeps its image restarts.
	if (seeded && serverWasRunning && !r.changed) {
		const rs = await d.docker("compose", ...compose, "restart", "server");
		if (rs.code !== 0)
			return stop(`docker compose restart server failed: ${rs.out.trim()}`);
	}
	return null;
}

/**
 * Rolls the stack one runner at a time, idle-first: a runner that runs no turn
 * at this moment recreates alone (`up -d --no-deps --wait`) with no hold, and a
 * busy runner is skipped with one log line — it stays on the old image, and a
 * later run rolls it. Only when a pending restart has waited past
 * RESTART_WAIT_WARN_MS does a run hold new turns again: each running worker
 * whose image changed holds its runner (POST /api/drain {runner}), waits until
 * its turns end, recreates, waits until it answers its healthz, and releases
 * its hold; a runner that keeps a turn past HOLD_LIMIT_MS is released, left on
 * the old image, and rolled by a later run. The server rolls last and only when
 * no runner is stuck, because a server restart kills the stuck worker's turn.
 * A board without the runner API (GET /api/drain answers nothing) keeps the
 * legacy whole-board flow, and a board that is not running just starts. Returns
 * the early exit code, and whether the board took the seed (or restarted), so
 * the seed record is only written then.
 */
/** Recreates one service alone and waits for its compose healthcheck; null when it is up. */
async function recreate(
	d: Deps,
	compose: string[],
	service: string,
	stop: (why: string) => number,
): Promise<number | null> {
	const up = await d.docker(
		"compose",
		...compose,
		"up",
		"-d",
		"--no-deps",
		"--wait",
		service,
	);
	// ponytail: up.out is always a defined string (the docker dep never returns
	// undefined out), so the trim's optional-chain mutant is a no-op.
	return up.code === 0
		? null
		: stop(`docker compose up --wait ${service} failed: ${up.out.trim()}`);
}

/** One listed runner's roll: the run stops early, the runner is stuck, or the service rolled. */
type RollOne =
	| { kind: "stop"; early: number }
	| { kind: "stuck" }
	| { kind: "rolled" };

/** One wait-poll step's outcome: the run stops early, the hold ran out with a
 * turn still on it, the runner idles (the roll goes on), or the poll keeps
 * waiting. */
type IdleWait =
	| { kind: "stop"; early: number }
	| { kind: "stuck" }
	| { kind: "idle" }
	| { kind: "busy" };

/** Holds one runner for its roll; a failed hold stops the run. Null when the hold is on. */
async function holdForRoll(
	exec: (code: string) => Promise<{ code: number; out: string }>,
	service: string,
	stop: (why: string) => number,
): Promise<RollOne | null> {
	const held = await exec(holdRunner(service));
	if (held.code !== 0)
		return {
			kind: "stop",
			early: stop(`the board cannot hold ${service}: ${lastLine(held.out)}`),
		};
	return null;
}

/**
 * Asks the worker itself about the runs the board cannot see: a run the server
 * step detached in an earlier run re-binds its row on the new server, and the
 * count reads a map the restart emptied. The worker itself answers for them, and
 * an old worker without the route answers []. A failed read is a real worker
 * error: like an unreadable runner state, the roll stops, for recreating now
 * would kill the run nobody can see. The probe execs in the worker's own
 * container, not the server.
 */
async function detachedStillRuns(
	d: Deps,
	compose: string[],
	service: string,
	stop: (why: string) => number,
): Promise<IdleWait> {
	const listed = await d.docker(
		"compose",
		...compose,
		"exec",
		"-T",
		service,
		"bun",
		"-e",
		DETACHED_LIST,
	);
	// ponytail: a failed exec prints only HTTP text, so JSON.parse would throw
	// on it anyway and the catch below stops with the same words — this check
	// fails fast, and its false-mutant cannot change the outcome.
	if (listed.code !== 0)
		return {
			kind: "stop",
			early: stop(
				`${service} cannot read its detached runs: ${lastLine(listed.out)}`,
			),
		};
	let detached: { running?: boolean }[];
	try {
		detached = JSON.parse(listed.out) as { running?: boolean }[];
	} catch {
		return {
			kind: "stop",
			early: stop(
				`${service} cannot read its detached runs: ${lastLine(listed.out)}`,
			),
		};
	}
	// ponytail: the busy answer keeps the wait running when a detached entry
	// still runs, so the next poll's probe sees it finished.
	return detached.some((x) => x.running === true)
		? { kind: "busy" }
		: { kind: "idle" };
}

/**
 * A wait poll's head: when the board counts the runner busy, the wait goes on
 * without asking the worker. Otherwise the worker's own detached-runs answer
 * decides.
 */
async function waitPollHead(
	d: Deps,
	compose: string[],
	service: string,
	board: { preparing: number; runners: Runner[] },
	stop: (why: string) => number,
): Promise<IdleWait> {
	const r = board.runners.find((x) => x.id === service);
	if (r === undefined || r.turns !== 0 || board.preparing !== 0)
		return { kind: "busy" };
	return detachedStillRuns(d, compose, service, stop);
}

/**
 * A wait poll's tail: pauses one poll interval, re-reads the board into `board`
 * in place, and renews the hold. A failed read stops the run, and a refused
 * renewal leaves the turn on the runner (stuck).
 */
async function waitPollTail(
	d: Deps,
	exec: (code: string) => Promise<{ code: number; out: string }>,
	service: string,
	board: { preparing: number; runners: Runner[] },
	stop: (why: string) => number,
): Promise<IdleWait> {
	await d.wait(POLL_MS);
	const next = await readRunners(exec);
	if (next === null)
		return {
			kind: "stop",
			early: stop(
				`the board's runners cannot be read: the hold on ${service} lapses 30 min after the last renewal`,
			),
		};
	board.preparing = next.preparing;
	board.runners = next.runners;
	// One POST holds the runner for DRAIN_MS (30 min), and this wait can reach
	// HOLD_LIMIT_MS (1 h): renew each poll like the whole-board hold does, or the
	// hold lapses mid-wait and the worker takes turns again before its recreate.
	// A refused renewal ends the wait as stuck: keepTurnStuck releases, and a
	// later run rolls.
	const renewed = await exec(holdRunner(service));
	return renewed.code !== 0 ? { kind: "stuck" } : { kind: "busy" };
}

/**
 * Waits while the runner keeps a turn: each poll renews the hold and refreshes
 * `board` in place. "stuck" ends the wait at the hold limit (or on a refused
 * renewal) with a turn still on it, "idle" frees the roll to recreate, and
 * "stop" ends the run.
 */
async function waitRunnerIdle(
	d: Deps,
	compose: string[],
	exec: (code: string) => Promise<{ code: number; out: string }>,
	service: string,
	board: { preparing: number; runners: Runner[] },
	stop: (why: string) => number,
): Promise<IdleWait> {
	// The runner's turns drain while the other runners keep working. `preparing` is
	// not attributable to one runner, so a preparing turn holds every runner idle.
	const since = d.now();
	// ponytail: i only guards the first-poll note below, and i-- keeps i === 0
	// exclusive to the first pass, so Stryker's i-- mutant prints the same note.
	for (let i = 0; ; i++) {
		const head = await waitPollHead(d, compose, service, board, stop);
		if (head.kind !== "busy") return head;
		// The next poll would end past the limit.
		if (d.now() - since + POLL_MS > HOLD_LIMIT_MS) return { kind: "stuck" };
		if (i === 0)
			d.log(
				`${service} still runs its turns: the roll follows when they finish`,
			);
		const tail = await waitPollTail(d, exec, service, board, stop);
		if (tail.kind !== "busy") return tail;
	}
}

/**
 * The runner keeps its turn past the hold limit: release it, leave it on the old
 * image, and let a later run roll it.
 */
async function keepTurnStuck(
	d: Deps,
	exec: (code: string) => Promise<{ code: number; out: string }>,
	service: string,
): Promise<RollOne> {
	const freed = await exec(freeRunner(service));
	d.log(
		freed.code === 0
			? `${service} keeps a turn after ${HOLD_LIMIT_MS / 60_000} min: its hold ends, and its restart waits for a later run`
			: `${service} keeps a turn after ${HOLD_LIMIT_MS / 60_000} min, and the board cannot end its hold (${lastLine(freed.out)}): it lapses 30 min after the last renewal`,
	);
	return { kind: "stuck" };
}

/**
 * Healthy is not connected: the roll goes on only when the server reaches the
 * new worker again. Null when it does; else the run's exit code.
 */
async function awaitConnected(
	d: Deps,
	exec: (code: string) => Promise<{ code: number; out: string }>,
	service: string,
	url: string,
	stop: (why: string) => number,
): Promise<number | null> {
	const since = d.now();
	for (;;) {
		const h = await exec(probeRunner(url));
		if (h.code === 0) return null;
		if (d.now() - since + POLL_MS > CONNECT_LIMIT_MS)
			return stop(
				`${service} never answers ${url}/healthz: ${lastLine(h.out)}`,
			);
		await d.wait(POLL_MS);
	}
}

/**
 * Rolls one listed runner. Idle-first (no pending-restart wait past the limit): no hold —
 * the runner that runs no turn at this moment recreates at once, and a busy runner is
 * skipped with one log line, left on the old image, and rolled by a later run. In the
 * hold phase (the restart has waited past the limit): the runner is held, its turns are
 * waited out (the wait renews the hold each poll), and a turn that runs past HOLD_LIMIT_MS
 * releases the hold and waits for a later run. `board` carries the live runner state and
 * is refreshed in place.
 */
async function rollRunner(
	d: Deps,
	compose: string[],
	exec: (code: string) => Promise<{ code: number; out: string }>,
	service: string,
	runner: Runner,
	board: { preparing: number; runners: Runner[] },
	stop: (why: string) => number,
	holdTurns: boolean,
): Promise<RollOne> {
	if (holdTurns) {
		const held = await holdForRoll(exec, service, stop);
		if (held !== null) return held;
		const waited = await waitRunnerIdle(d, compose, exec, service, board, stop);
		if (waited.kind === "stop") return waited;
		if (waited.kind === "stuck") return keepTurnStuck(d, exec, service);
	} else {
		// No hold: the runner is rolled only when it is idle at this moment. The
		// check is the wait poll's head, so it also asks the worker's own
		// /detached for runs the board cannot see.
		const head = await waitPollHead(d, compose, service, board, stop);
		if (head.kind === "stop") return head;
		if (head.kind === "busy") {
			d.log(`${service} runs turns: the restart waits for an idle run`);
			return { kind: "stuck" };
		}
	}
	// --wait waits for the worker's own compose healthcheck; a failed recreate is a
	// failed health check: the roll stops, and the other containers stay on the old image.
	const failed = await recreate(d, compose, service, stop);
	if (failed !== null) return { kind: "stop", early: failed };
	if (runner.url !== null) {
		const early = await awaitConnected(d, exec, service, runner.url, stop);
		if (early !== null) return { kind: "stop", early };
	}
	if (holdTurns) {
		const freed = await exec(freeRunner(service));
		if (freed.code !== 0)
			d.log(
				`the board cannot end ${service}'s hold (${lastLine(freed.out)}): it lapses 30 min after the last renewal`,
			);
	}
	// ponytail: the caller treats any non-stop/non-stuck tag as rolled, so an
	// empty or mislabeled kind cannot change the flow.
	return { kind: "rolled" };
}

/**
 * The server's own roll, always last, with no board-wide hold. Idle-first: the
 * server restarts only when no turn needs it — local runs no turn (its turns
 * are children of the server process and cannot survive the restart). The step
 * holds local for the restart window before the fresh read, so no local turn
 * can start in those seconds; a turn the read finds defers the step, and every
 * hold releases. In the hold phase (a pending restart has waited past
 * RESTART_WAIT_WARN_MS), local drains first with the same 1 h limit as a
 * worker. Then every worker runner holds (its queued cards just wait out the
 * restart window), and every busy worker detaches its running turn through an
 * exec in its own container, so the turn survives the server's death and the
 * new server's boot recovery re-binds it. A busy worker that cannot detach (an
 * old image answers 404) blocks the step: every hold releases, and the step
 * waits for a later run — killing that turn is not worth the update. The
 * recreate (a new image) or the restart (a seed only) clears every in-memory
 * drain, so the held runners release without an undrain call.
 */
type ServerRoll =
	| { kind: "early"; early: number }
	| { kind: "deferred" }
	| { kind: "done" };

/**
 * Ends every hold on the board: a deferred step released nothing itself, so
 * every hold must end now, and queued cards start again instead of waiting out
 * the lapsed holds. A DELETE for a runner that never held clears nothing and
 * answers either way.
 */
async function releaseAll(
	exec: (code: string) => Promise<{ code: number; out: string }>,
	board: { preparing: number; runners: Runner[] },
): Promise<void> {
	for (const r of board.runners) await exec(freeRunner(r.id));
}

/** Defers the server step to a later run: every hold ends, and the run logs why. */
function deferRoll(d: Deps, why: string): ServerRoll {
	d.log(`${why}: the holds end, and the server step waits for a later run`);
	return { kind: "deferred" };
}

/**
 * The server's local drain, hold phase only: holds local, reads the board
 * fresh, and waits local's own turns out with the same 1 h limit as a worker.
 * Null when local idles; else the step's outcome.
 */
async function drainLocal(
	d: Deps,
	exec: (code: string) => Promise<{ code: number; out: string }>,
	board: { preparing: number; runners: Runner[] },
	stop: (why: string) => number,
): Promise<ServerRoll | null> {
	// Server-local turns die with the server process: they must finish first.
	const held = await exec(holdRunner("local"));
	if (held.code !== 0)
		return {
			kind: "early",
			early: stop(`the board cannot hold local: ${lastLine(held.out)}`),
		};
	const since = d.now();
	// The worker rolls refreshed this board only while a runner was busy: read it
	// fresh, so a turn that started after its worker rolled still detaches.
	const fresh = await readRunners(exec);
	if (fresh === null) {
		await releaseAll(exec, board);
		return {
			kind: "early",
			early: stop(
				"the board's runners cannot be read: the hold on local lapses 30 min after the last renewal",
			),
		};
	}
	board.preparing = fresh.preparing;
	board.runners = fresh.runners;
	// ponytail: i only guards the first-poll note below, and i-- keeps i === 0
	// exclusive to the first pass, so Stryker's i-- mutant prints the same note;
	// its i !== 0 mutant only moves the note one poll later, same count.
	for (let i = 0; ; i++) {
		const local = board.runners.find((r) => r.id === "local");
		if (local === undefined || local.turns === 0) return null;
		// The next poll would end past the limit.
		if (d.now() - since + POLL_MS > HOLD_LIMIT_MS) {
			await releaseAll(exec, board);
			return deferRoll(
				d,
				`local keeps a turn after ${HOLD_LIMIT_MS / 60_000} min`,
			);
		}
		if (i === 0)
			d.log(
				"local still runs its turns: the server restart follows when they finish",
			);
		const step = await pollLocalTurn(d, exec, board, stop);
		if (step !== null) return step;
	}
}

/**
 * One drain poll for local: pauses one poll interval, re-reads the board into
 * `board` in place, and renews the hold. A failed read stops the run, and a
 * refused renewal defers the step. Null when the poll went through; else the
 * step's outcome.
 */
async function pollLocalTurn(
	d: Deps,
	exec: (code: string) => Promise<{ code: number; out: string }>,
	board: { preparing: number; runners: Runner[] },
	stop: (why: string) => number,
): Promise<ServerRoll | null> {
	await d.wait(POLL_MS);
	const next = await readRunners(exec);
	if (next === null) {
		await releaseAll(exec, board);
		return {
			kind: "early",
			early: stop(
				"the board's runners cannot be read: the hold on local lapses 30 min after the last renewal",
			),
		};
	}
	board.preparing = next.preparing;
	board.runners = next.runners;
	// One POST holds the runner for DRAIN_MS (30 min), and this wait can reach
	// HOLD_LIMIT_MS (1 h): renew each poll like the worker holds do. A refused
	// renewal ends the wait: release, and a later run rolls.
	const renewed = await exec(holdRunner("local"));
	if (renewed.code !== 0) {
		await releaseAll(exec, board);
		return deferRoll(d, "the board cannot hold local any more");
	}
	return null;
}

/**
 * Holds every worker runner: worker holds stop new dispatches for the seconds of
 * the restart window, the cards stay queued, and no board-wide notice shows.
 * Local skips: the step held it before the fresh read (hold phase: drainLocal
 * holds it), and a second hold for it would name an empty runner. Null when
 * every hold is on; else the step's outcome.
 */
async function holdWorkers(
	exec: (code: string) => Promise<{ code: number; out: string }>,
	board: { preparing: number; runners: Runner[] },
	stop: (why: string) => number,
): Promise<ServerRoll | null> {
	for (const r of board.runners) {
		if (r.id === "local") continue;
		const h = await exec(holdRunner(r.id));
		if (h.code !== 0) {
			await releaseAll(exec, board);
			return {
				kind: "early",
				early: stop(`the board cannot hold ${r.id}: ${lastLine(h.out)}`),
			};
		}
	}
	return null;
}

/**
 * Tells every busy worker to detach its running turn: the exec runs in the
 * worker's own container, with its own token, so the turn survives the server's
 * death and the new server's boot recovery re-binds it. An idle worker skips it.
 * A worker that cannot detach (an old image answers 404) defers the step: every
 * hold releases, and the step waits for a later run — killing that turn is not
 * worth the update. Null when every busy worker detached; else the outcome.
 */
async function detachBusyWorkers(
	d: Deps,
	compose: string[],
	exec: (code: string) => Promise<{ code: number; out: string }>,
	board: { preparing: number; runners: Runner[] },
): Promise<ServerRoll | null> {
	for (const r of board.runners) {
		if (r.id === "local" || r.turns === 0) continue;
		const det = await d.docker(
			"compose",
			...compose,
			"exec",
			"-T",
			r.id,
			"bun",
			"-e",
			DETACH_WORKER,
		);
		if (det.code !== 0) {
			await releaseAll(exec, board);
			return deferRoll(
				d,
				`${r.id} cannot detach its turn (${lastLine(det.out)})`,
			);
		}
	}
	return null;
}

async function rollServer(
	d: Deps,
	compose: string[],
	board: { preparing: number; runners: Runner[] },
	seeded: boolean,
	changed: boolean,
	stop: (why: string) => number,
	holdTurns: boolean,
): Promise<ServerRoll> {
	// Nothing changed and no seed waits: the done path and the fallen-through
	// path both no-op (a final up with unchanged images, recordSeed with seeded
	// false), and the caller treats any non-early/non-deferred kind as done.
	// ponytail: mutants of the done literal are behavior-preserving — here and at
	// the recreate/restart returns below, a mislabeled done still reaches the same
	// no-work path the caller already treats as done.
	if (!changed && !seeded) return { kind: "done" };
	const exec = (code: string) =>
		d.docker("compose", ...compose, "exec", "-T", "server", "bun", "-e", code);
	if (holdTurns) {
		const drained = await drainLocal(d, exec, board, stop);
		if (drained !== null) return drained;
	} else {
		// Idle-first: the server restarts only when no turn needs it, and the
		// server's own turns are children of its process — local must run no
		// turn. Hold local for the restart window first, so a turn that starts
		// in the seconds of the fresh read cannot die with the restart; a turn
		// that already runs shows in that read, and the step defers.
		const held = await exec(holdRunner("local"));
		if (held.code !== 0)
			return {
				kind: "early",
				early: stop(`the board cannot hold local: ${lastLine(held.out)}`),
			};
		const fresh = await readRunners(exec);
		if (fresh === null) {
			await releaseAll(exec, board);
			return {
				kind: "early",
				early: stop(
					"the board's runners cannot be read before the server step",
				),
			};
		}
		board.preparing = fresh.preparing;
		board.runners = fresh.runners;
		const local = board.runners.find((r) => r.id === "local");
		if (local !== undefined && local.turns !== 0) {
			await releaseAll(exec, board);
			d.log(
				"local runs turns: the restart waits for an idle run; the holds end, and the server step waits for a later run",
			);
			return { kind: "deferred" };
		}
	}
	const held = await holdWorkers(exec, board, stop);
	if (held !== null) return held;
	const detached = await detachBusyWorkers(d, compose, exec, board);
	if (detached !== null) return detached;
	if (changed) {
		const failed = await recreate(d, compose, "server", stop);
		return failed !== null
			? { kind: "early", early: failed }
			: { kind: "done" };
	}
	const rs = await d.docker("compose", ...compose, "restart", "server");
	// ponytail: rs.out is always a defined string, so the trim's optional-chain
	// mutant cannot change the message.
	return rs.code === 0
		? { kind: "done" }
		: {
				kind: "early",
				early: stop(`docker compose restart server failed: ${rs.out.trim()}`),
			};
}

/** The roll's outcome: an early exit code (the run stops or waits for a later run),
 * or a stack that is up and took the seed. `settled` is only read on the no-early
 * variants, so the early returns carry no flag a mutant could flip in the dark. */
type RollOutcome = { early: number } | { early: null; settled: boolean };

/**
 * `up -d --wait` for the whole stack: starts a service that is not running and
 * waits for the server's health. The early exit code when it fails; null when it
 * is up.
 */
async function upAndWait(
	d: Deps,
	compose: string[],
	stop: (why: string) => number,
): Promise<number | null> {
	const up = await d.docker("compose", ...compose, "up", "-d", "--wait");
	// ponytail: up.out is always a defined string, so the trim's
	// optional-chain mutant is a no-op.
	if (up.code !== 0)
		return stop(`docker compose up --wait failed: ${up.out.trim()}`);
	return null;
}

/**
 * Starts a stack that is not running: no board, no turn can run (workers kill a
 * turn when the board's request drops, and merge turns die with the board), so
 * the roll skips and the stack starts.
 */
async function startWithoutBoard(
	d: Deps,
	compose: string[],
	stop: (why: string) => number,
): Promise<RollOutcome> {
	d.log("no running board to count turns in; restarting anyway");
	const failed = await upAndWait(d, compose, stop);
	return failed !== null ? { early: failed } : { early: null, settled: true };
}

/** One worker service's step of the roll: the run stops early, the runner keeps
 * its turn, or the step moved on. */
type ServiceStep =
	| { kind: "stop"; early: number }
	| { kind: "stuck" }
	| { kind: "next" };

/**
 * Rolls one worker service: compares its image with the build, recreates it
 * without a hold when no runner lists it, or rolls its runner — idle-first
 * without a hold, or through the hold-wait-recreate-release phases in the hold
 * phase (`holdTurns`).
 */
async function rollWorkerService(
	d: Deps,
	compose: string[],
	exec: (code: string) => Promise<{ code: number; out: string }>,
	service: string,
	board: { preparing: number; runners: Runner[] },
	stop: (why: string) => number,
	holdTurns: boolean,
): Promise<ServiceStep> {
	const ch = await imageChanged(d, compose, service);
	if ("error" in ch) {
		d.log(
			`skipping ${service}: its image cannot be compared with the build: ${ch.error}`,
		);
		return { kind: "next" };
	}
	if (!ch.changed) return { kind: "next" };
	const runner = board.runners.find((r) => r.id === service);
	if (runner === undefined) {
		// No runner lists this hostname, so no turn can reach it: it recreates
		// without a hold and without a turns wait, like a sidecar service does.
		d.log(`${service} is no runner on the board: it recreates without a hold`);
		const failed = await recreate(d, compose, service, stop);
		if (failed !== null) return { kind: "stop", early: failed };
		return { kind: "next" };
	}
	const one = await rollRunner(
		d,
		compose,
		exec,
		service,
		runner,
		board,
		stop,
		holdTurns,
	);
	if (one.kind === "stop") return { kind: "stop", early: one.early };
	if (one.kind === "stuck") return { kind: "stuck" };
	return { kind: "next" };
}

/**
 * From the server step's outcome to the run's end: a deferred step leaves turns
 * running un-detached, so the whole-stack up would recreate exactly those
 * containers — the run skips it, and leaves the seed record for the run that
 * rolls the server (a failed seed still fails the run). Otherwise the whole
 * stack starts what is not running and waits for the server's health: every
 * changed container was rolled per service above.
 */
async function settleAfterRoll(
	d: Deps,
	compose: string[],
	step: ServerRoll,
	seedFailed: boolean,
	stop: (why: string) => number,
): Promise<RollOutcome> {
	if (step.kind === "deferred") return { early: seedFailed ? 1 : 0 };
	const failed = await upAndWait(d, compose, stop);
	return failed !== null ? { early: failed } : { early: null, settled: true };
}

async function rollAndRestart(
	d: Deps,
	compose: string[],
	services: string[],
	commits: string[],
	seeded: boolean,
	seedFailed: boolean,
	serverWasRunning: boolean,
	wantedSha: string,
	stop: (why: string) => number,
): Promise<RollOutcome> {
	const exec = (code: string) =>
		d.docker("compose", ...compose, "exec", "-T", "server", "bun", "-e", code);
	if (!serverWasRunning) return startWithoutBoard(d, compose, stop);
	const board = await readRunners(exec);
	if (board === null) {
		// A board one version older has none of the per-runner parts.
		const early = await legacyDrainAndRestart(
			d,
			compose,
			commits,
			seeded,
			seedFailed,
			serverWasRunning,
			wantedSha,
			stop,
		);
		return early !== null ? { early } : { early: null, settled: true };
	}
	// Workers roll first, one at a time, in compose ps order; the server rolls last.
	// The roll is idle-first: no new turns are held until a pending restart has
	// waited past RESTART_WAIT_WARN_MS; then the hold phase returns (each hold at
	// most HOLD_LIMIT_MS).
	const holdTurns = (await pendingWaitMs(d, compose)) > RESTART_WAIT_WARN_MS;
	let stuck = false;
	for (const service of services.filter((s) => s !== "server")) {
		const step = await rollWorkerService(
			d,
			compose,
			exec,
			service,
			board,
			stop,
			holdTurns,
		);
		if (step.kind === "stop") return { early: step.early };
		if (step.kind === "stuck") stuck = true;
	}
	// The server is the last runner: a restart kills every turn it runs itself and every
	// turn a worker streams to it, so a stuck runner's turn forbids the restart.
	if (stuck) {
		d.log(
			"a runner keeps its turn: the server restart waits for a later run, because a restart kills that turn",
		);
		return { early: null, settled: false };
	}
	const ch = await imageChanged(d, compose, "server");
	if ("error" in ch)
		return {
			early: stop(
				`the server's image cannot be compared with the build: ${ch.error}`,
			),
		};
	const step = await rollServer(
		d,
		compose,
		board,
		seeded,
		ch.changed,
		stop,
		holdTurns,
	);
	if (step.kind === "early") return { early: step.early };
	return settleAfterRoll(d, compose, step, seedFailed, stop);
}

/**
 * Records the seed commit and the token expiry on the running board. Returns true when
 * the seed record failed, so the run exits 1.
 */
async function recordSeed(
	d: Deps,
	compose: string[],
	seeded: boolean,
	wantedSha: string,
	seedExpires: string | null | undefined,
	env: Record<string, string | undefined>,
): Promise<boolean> {
	let seedFailed = false;
	// The record lands only after the board took the seed (recreate or restart): a run
	// that ends early — turns still run past the hold — leaves it unwritten, so the
	// next run seeds again and retries the restart. up has the server running here.
	if (seeded) {
		const w = await d.docker(
			"compose",
			...compose,
			"exec",
			"-T",
			"server",
			"sh",
			"-c",
			`printf %s '${wantedSha}' > /etc/ottr/seed-commit`,
		);
		if (w.code !== 0) {
			d.log(
				"board seed failed: the seed commit cannot be recorded; the next run seeds again",
			);
			await seedFailRecord(
				d,
				compose,
				wantedSha,
				"the seed commit cannot be recorded; the next run seeds again",
				env,
			);
			seedFailed = true;
		}
	}
	// Every run that probed writes the expiry, so a renewed token updates the file even
	// when the data repo did not move. Advisory: a failed write never fails the run.
	if (seedExpires !== undefined) {
		const w = await d.docker(
			"compose",
			...compose,
			"exec",
			"-T",
			"server",
			"sh",
			"-c",
			`printf %s '${seedExpires ?? "none"}' > /etc/ottr/seed-token-expires`,
		);
		if (w.code !== 0) d.log("board seed token expiry check failed");
		else d.log(`board seed token expires ${seedExpires ?? "none"}`);
	}
	return seedFailed;
}

/**
 * Records the commit the running server holds and clears the restart-wait clock, after
 * the board took the deploy (a rolled server, a legacy restart, or a start). Advisory:
 * a failed write only degrades a later deferral's line, and never fails the run.
 */
async function recordDeployed(
	d: Deps,
	compose: string[],
	head: string,
): Promise<void> {
	const w = await d.docker(
		"compose",
		...compose,
		"exec",
		"-T",
		"server",
		"sh",
		"-c",
		`printf %s '${head}' > /etc/ottr/build-commit && rm -f /etc/ottr/restart-waiting-since /etc/ottr/restart-wait`,
	);
	if (w.code !== 0)
		d.log(
			"the deploy record failed: a later deferral cannot name the server's commit",
		);
}

/**
 * The wait's start: the first deferral writes its time, and a later one counts
 * from it, so the wait survives the hourly runs on the board-config volume. A
 * failed write only restarts the clock on a later run.
 */
async function waitStart(
	d: Deps,
	exec: (code: string) => Promise<{ code: number; out: string }>,
): Promise<number> {
	const since = await exec("cat /etc/ottr/restart-waiting-since");
	const kept = since.code === 0 ? since.out.trim() : "";
	const read = Number(kept);
	if (Number.isInteger(read) && read > 0) return read;
	const first = d.now();
	const w = await exec(
		`printf %s '${first}' > /etc/ottr/restart-waiting-since`,
	);
	if (w.code !== 0)
		d.log("the wait record failed: a later run starts the wait clock again");
	return first;
}

/**
 * How long a pending restart has already waited: the first-deferral time the wait
 * log reads (/etc/ottr/restart-waiting-since, kept on the board-config volume). No
 * record, or a failed read, waits nothing: the run starts idle-first, and a later
 * deferred run writes the clock. Advisory: a failed read never fails the run.
 */
async function pendingWaitMs(d: Deps, compose: string[]): Promise<number> {
	const since = await d.docker(
		"compose",
		...compose,
		"exec",
		"-T",
		"server",
		"sh",
		"-c",
		"cat /etc/ottr/restart-waiting-since",
	);
	if (since.code !== 0) return 0;
	const read = Number(since.out.trim());
	return Number.isInteger(read) && read > 0 ? Math.max(0, d.now() - read) : 0;
}

/**
 * The turn ids a deferral reads on every run: the warning line uses them past
 * RESTART_WAIT_WARN_MS, and the restart-wait record names them so the board can
 * show a bell notice. Null when the read fails.
 */
async function holdingTurns(
	d: Deps,
	compose: string[],
	first: number,
): Promise<string | null> {
	const t = await d.docker(
		"compose",
		...compose,
		"exec",
		"-T",
		"server",
		"bun",
		"-e",
		WAIT_TURNS,
	);
	const ids = t.code === 0 ? lastLine(t.out).trim() : null;
	if (d.now() - first > RESTART_WAIT_WARN_MS) {
		d.log(
			ids === null
				? "warning: the server restart still waits, and its turns cannot be read"
				: ids === ""
					? "warning: the server restart still waits, and no turn runs any more"
					: `warning: the server restart still waits; these turns hold it: ${ids}`,
		);
	}
	return ids;
}

/**
 * The commit the running server holds (the deploy record lands only when the
 * board took the deploy, so it names that commit), and how many commits it
 * lacks: a server that has none recorded (or already runs the head) has nothing
 * to catch up on, and a failed count reads as 0.
 */
async function runningServer(
	exec: (code: string) => Promise<{ code: number; out: string }>,
	head: string,
	repo: string,
): Promise<{ running: string; commits: number }> {
	const dep = await exec("cat /etc/ottr/build-commit");
	const running = dep.code === 0 ? dep.out.trim() : "";
	if (running === "" || running === head) return { running, commits: 0 };
	const c = await git(["rev-list", "--count", `${running}..${head}`], repo);
	const n = Number(c.stdout.trim());
	return {
		running,
		commits: c.code === 0 && Number.isInteger(n) && n >= 0 ? n : 0,
	};
}

/**
 * The wait report a deferred server restart ends the run with: how long the restart has
 * already waited (the first deferral time, kept next to the seed record), a warning past
 * RESTART_WAIT_WARN_MS that names the turns that hold it, and both commits — the main
 * the image holds and the one the running server still has. The server keeps running,
 * so every exec answers. Advisory: a failed read or write only degrades a line.
 */
async function reportRestartWait(
	d: Deps,
	compose: string[],
	head: string,
	omp: string,
	repo: string,
): Promise<void> {
	const exec = (code: string) =>
		d.docker("compose", ...compose, "exec", "-T", "server", "sh", "-c", code);
	const first = await waitStart(d, exec);
	d.log(`the server restart has waited ${fmtWait(d.now() - first)}`);
	const ids = await holdingTurns(d, compose, first);
	const srv = await runningServer(exec, head, repo);
	const running = srv.running;
	const commits = srv.commits;
	// The record the board reads to show a bell notice after 6 h of waiting. The ids
	// are sanitized to a safe charset, so the printf never sees a quote.
	const turns = (ids ?? "")
		.split(/\s+/)
		.filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(id))
		.slice(0, 20);
	// The exact command that restarts the server now, with this run's own compose
	// arguments: the same recreate the server step runs. Re-running this script
	// would only defer again, so the notice must name the recreate instead. A
	// compose argument with a quote cannot ride the printf; the record then omits
	// the command and the board falls back to the plain form.
	const command = `docker compose ${compose.join(" ")} up -d --no-deps --wait server`;
	const record = command.includes("'")
		? { commit: head, since: first, commits, turns }
		: { commit: head, since: first, commits, turns, command };
	const w = await exec(
		`printf %s '${JSON.stringify(record)}' > /etc/ottr/restart-wait`,
	);
	if (w.code !== 0)
		d.log("the restart-wait record failed: the board cannot show a notice");
	d.log(
		running !== ""
			? `the image holds main at ${head} with omp ${omp}; the server still runs ${running} until a later run restarts it`
			: `the image holds main at ${head} with omp ${omp}; the server still runs an older commit until a later run restarts it`,
	);
}

/** The lock file path for a checkout: one per checkout, shared by both run modes. */
export function updateLockPath(repo: string): string {
	return join(
		tmpdir(),
		`ottr-update-image-${createHash("sha256").update(repo).digest("hex").slice(0, 16)}.lock`,
	);
}

/** How often the waiting full run re-reads the lock. */
const LOCK_POLL_MS = 5_000;
/** How long the full run waits for a seed-only run's lock before it stops with an error. */
const LOCK_WAIT_MS = 10 * 60_000;

/**
 * Takes the run lock. A live holder skips the seed-only run at once (its next start is
 * 5 minutes later) and makes the full run poll up to LOCK_WAIT_MS (10 min) before it
 * gives up — a full run never skips as a success, because the host controller reads
 * exit 0 as a finished cycle. A lock whose pid is gone (a hard-killed run's leftover)
 * is dead, and this run steals it: the file is removed and the create is retried.
 */
async function acquireLock(
	repo: string,
	d: Deps,
	seedOnly: boolean,
): Promise<boolean> {
	const path = updateLockPath(repo);
	const deadline = d.now() + LOCK_WAIT_MS;
	let told = false;
	for (;;) {
		try {
			const fd = openSync(path, "wx");
			try {
				writeSync(fd, JSON.stringify({ pid: process.pid }));
			} finally {
				closeSync(fd);
			}
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		if (!holderLive(path)) {
			rmSync(path, { force: true });
			continue;
		}
		if (seedOnly || d.now() >= deadline) {
			d.log(
				seedOnly
					? "another update-image run holds the lock; the seed-only run skips"
					: `another update-image run still holds the lock after ${LOCK_WAIT_MS / 60_000} min; this run stops`,
			);
			return false;
		}
		if (!told) {
			d.log(
				`another update-image run holds the lock; this run waits up to ${LOCK_WAIT_MS / 60_000} min`,
			);
			told = true;
		}
		await d.wait(LOCK_POLL_MS);
	}
}

/** Whether the lock's recorded pid still runs. An unreadable or unparseable file counts
 * as a dead holder, a kill that does not throw as a live one, and a process of another
 * user (EPERM) as a live one — the same read scripts/stryker-load.mjs makes. */
function holderLive(path: string): boolean {
	try {
		const holder = JSON.parse(readFileSync(path, "utf8")) as {
			pid?: unknown;
		};
		if (typeof holder.pid !== "number") return false;
		process.kill(holder.pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Removes the lock only when it still records this run's pid: a stolen lock is not ours. */
function releaseLock(repo: string): void {
	const path = updateLockPath(repo);
	try {
		const holder = JSON.parse(readFileSync(path, "utf8")) as {
			pid?: unknown;
		};
		if (holder.pid !== process.pid) return;
	} catch {
		return; // The file is gone or unreadable: nothing of ours to remove.
	}
	rmSync(path, { force: true });
}

/** The full run's exit code: 1 when it stopped early or failed, else 0. */
async function deployMain(
	repo: string,
	compose: string[],
	d: Deps,
	env: Record<string, string | undefined> = process.env,
): Promise<number> {
	const stop = (why: string): number => {
		d.log(`stopped: ${why}`);
		return 1;
	};
	const g = (...args: string[]) => git(args, repo);
	const meta = await preflightAndRead(repo, g, stop);
	if (typeof meta === "number") return meta;

	// One ps lists the running services, before the builds: the sidecar phase
	// cross-checks it against compose config, and a failed ps fails closed before
	// any build work. A board that does not run cannot be counted, and that must
	// not block every later deploy.
	const services = await runningServices(d, compose, stop);
	if (typeof services === "number") return services;

	const built = await buildAndSidecars(d, compose, repo, services, stop);
	if (built !== null) return built;

	const serverWasRunning = services.includes("server");
	const vmBuilt = await buildVmRunner(d, compose, services, stop);
	if (vmBuilt !== null) return vmBuilt;

	const seed = await seedBoard(d, compose, repo, env, serverWasRunning);

	const rolled = await rollAndRestart(
		d,
		compose,
		services,
		meta.commits,
		seed.seeded,
		seed.failed,
		serverWasRunning,
		seed.wantedSha,
		stop,
	);
	if (rolled.early !== null) {
		// early 0 is a deferred wait (the seed is fine): the run ends with the wait
		// report instead of a settled summary. early 1 keeps its stop line.
		if (rolled.early === 0)
			await reportRestartWait(d, compose, meta.head, meta.omp, repo);
		return rolled.early;
	}
	// The record lands only after the board took the seed (a rolled server, a legacy
	// restart, or a start): a stuck runner defers the restart, and the next run seeds
	// again and retries. The deploy record rides the same rule, and clears the wait.
	let recordFailed = false;
	if (rolled.settled) {
		recordFailed = await recordSeed(
			d,
			compose,
			seed.seeded,
			seed.wantedSha,
			seed.expires,
			env,
		);
		await recordDeployed(d, compose, meta.head);
	}
	await d.docker(
		"image",
		"prune",
		"--force",
		"--filter",
		"label=ottr.image=worker",
	);
	if (rolled.settled)
		d.log(`the stack runs main at ${meta.head} with omp ${meta.omp}`);
	else await reportRestartWait(d, compose, meta.head, meta.omp, repo);
	// ponytail: a dirty ALATE_DATA checkout records HEAD, so uncommitted edits do not
	// retrigger a seed; the next pushed commit does.
	return seed.failed || recordFailed ? 1 : 0;
}

/**
 * Deploys main under the shared run lock. When another run holds the lock, this run
 * waits up to 10 minutes and then stops with exit 1 — never a silent skip; the exit
 * code is 1 when the deploy stopped early or failed.
 */
export async function updateImage(
	repo: string,
	compose: string[],
	d: Deps,
	env: Record<string, string | undefined> = process.env,
): Promise<number> {
	if (!(await acquireLock(repo, d, false))) return 1;
	try {
		return await deployMain(repo, compose, d, env);
	} finally {
		releaseLock(repo);
	}
}

/**
 * Seeds the board's agent layer only when the data source moved: no build, no pull, no
 * restart — the seed is the whole job. Shares the run lock with the full deploy, so a
 * blocked seed-only run logs one line and exits 0; its next start is 5 minutes later.
 */
export async function seedOnlyUpdate(
	repo: string,
	compose: string[],
	d: Deps,
	env: Record<string, string | undefined> = process.env,
): Promise<number> {
	if (!(await acquireLock(repo, d, true))) return 0;
	try {
		const seed = await seedSource(d, env, repo);
		if (seed === null) return 0; // seedSource already logged the skip.
		if ("failed" in seed) {
			d.log(`board seed failed: ${seed.failed}`);
			await seedFailRecord(d, compose, "", seed.failed, env);
			return 1;
		}
		if ((await readSeedRecord(d, compose, true)) === seed.wanted) {
			d.log(`board agent layer current at ${seed.wanted.slice(0, 12)}`);
			return 0;
		}
		const outcome = await runSeed(d, compose, env, seed, {
			seeded: false,
			failed: false,
			wantedSha: seed.wanted,
			expires: seed.tokenExpires,
		});
		// runSeed already logged the failure and wrote the seed-failed notice, and
		// left the record untouched.
		if (outcome.failed) return 1;
		// The full run records the seed commit only after the restart settles;
		// seed-only has no restart step — the seed is the whole job, and the record
		// is what makes the next 5-minute run compare equal instead of
		// re-provisioning. Advisory: the seed itself landed.
		const w = await d.docker(
			"compose",
			...compose,
			"exec",
			"-T",
			"server",
			"sh",
			"-c",
			`printf %s '${seed.wanted}' > /etc/ottr/seed-commit`,
		);
		if (w.code !== 0)
			d.log("the seed commit cannot be recorded; the next run seeds again");
		return 0;
	} finally {
		releaseLock(repo);
	}
}

if (import.meta.main) {
	const repo = resolve(import.meta.dir, "..");
	const seedOnly = process.argv.slice(2).includes("--seed-only");
	const compose = process.argv.slice(2).filter((arg) => arg !== "--seed-only");
	dropBunDotenv(compose);
	// The shell env wins over --env-file values, matching compose's precedence.
	for (const [key, value] of Object.entries(envFileValues(compose))) {
		if (process.env[key] === undefined) process.env[key] = value;
	}
	const d: Deps = {
		docker: async (...args) => {
			const r = await $`docker ${args}`.cwd(repo).nothrow().quiet();
			// stderr first: compose warnings must not land after the turn count.
			return { code: r.exitCode, out: `${r.stderr}${r.stdout}` };
		},
		log: (line) => console.log(`${new Date().toISOString()} ${line}`),
		wait: (ms) => Bun.sleep(ms),
		now: Date.now,
	};
	process.exitCode = seedOnly
		? await seedOnlyUpdate(repo, compose, d)
		: await updateImage(repo, compose, d);
}

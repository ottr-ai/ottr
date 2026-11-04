#!/usr/bin/env bun
// Deploys main to a compose stack. Run it on a schedule from a clean `main` checkout
// (docs/WORKERS.md, "Updates"): it fast-forwards main, builds the image, and rolls the
// stack one runner at a time: it holds one worker's new turns, recreates that worker
// with the new image, waits until it is healthy and connected, releases it, and goes to
// the next worker. The server rolls last, only when no turn runs anywhere. A worker
// that keeps a turn past 1 h is released, and its restart waits for a later run. A
// board without the runner API holds the whole board and restarts it at once. With
// ALATE_DATA or ALATE_DATA_REPO in the env file
// it also seeds the board's agent layer (docs/WORKERS.md, "Seed the board config"). The omp
// pin moves on main only
// (.github/workflows/omp-bump.yml), so a host needs read access and never pushes.
// Its arguments go to every `docker compose` call, e.g. -f docker-compose.yml -f <override>.
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { type GitResult, git } from "../src/worktree.ts";

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
	`const r = await fetch(${JSON.stringify(url + "/healthz")});` +
	"if (!r.ok) { console.log('HTTP ' + r.status); process.exit(1); }";
// While a new image waits, the count repeats every 30 s until no turn runs. The scheduled task
// starts no second run meanwhile (IgnoreNew), so the run that built the image restarts the stack.
const POLL_MS = 30_000;
// A hold lasts at most 1 h, so a long turn (a mutation run of several hours) stops the queue
// of new turns for 1 h at most. Then the run ends the hold, and a later run tries again.
const HOLD_LIMIT_MS = 60 * 60_000;
// A rolled worker must answer its healthz soon: at most 5 min, then the roll stops and
// keeps the not-yet-rolled containers on the old image.
const CONNECT_LIMIT_MS = HOLD_LIMIT_MS / 12;

/** The real docker dep puts stderr first: compose warnings come before the answer's last line. */
const lastLine = (out: string): string =>
	out.trim().split("\n").at(-1)?.trim() ?? "";

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
		const a = args[i]!;
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
 * Waits out the running turns on the live board. Returns an early exit code
 * (1 via stop, 0 when the restart waits for a later run), or null to proceed
 * to `compose up`. `pending` says what makes the coming restart worth the hold: a new
 * image, a seeded agent layer, or both.
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
	stop: (why: string) => number,
): Promise<number | null> {
	const build = await d.docker("compose", ...compose, "build", "server");
	if (build.code !== 0) {
		d.log(build.out.trim().split("\n").slice(-10).join("\n"));
		return stop("the image does not build; the stack keeps the old one");
	}
	// Services a host-only override builds from another local git checkout (the compose
	// files in this repo name none) deploy on their own (deploySidecar).
	for (const s of await sidecarCheckouts(d, compose, repo))
		await deploySidecar(d, compose, s);
	return null;
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
	return running.out.trim().split("\n");
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
			return { ...outcome, failed: true };
		}
		d.log(`board agent layer seeded at ${seed.wanted.slice(0, 12)}`);
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
 * Rolls the stack one runner at a time. Each running worker whose image changed holds
 * its runner (POST /api/drain {runner}), waits until its turns end, recreates alone
 * (`up -d --no-deps --wait`), waits until it answers its healthz, and releases its
 * hold; a runner that keeps a turn past HOLD_LIMIT_MS is released, left on the old
 * image, and rolled by a later run. The server rolls last and only when no runner is
 * stuck, because a server restart kills the stuck worker's turn. A board without the
 * runner API (GET /api/drain answers nothing) keeps the legacy whole-board flow, and a
 * board that is not running just starts. Returns the early exit code, and whether the
 * board took the seed (or restarted), so the seed record is only written then.
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
	return up.code === 0
		? null
		: stop(`docker compose up --wait ${service} failed: ${up.out.trim()}`);
}

/** One listed runner's roll: the run stops early, the runner is stuck, or the service rolled. */
type RollOne =
	| { kind: "stop"; early: number }
	| { kind: "stuck" }
	| { kind: "rolled" };

/**
 * Rolls one listed runner: holds it, waits its turns out (the wait renews the hold each
 * poll), recreates only its container, waits until the server reaches it again, and
 * releases it. `board` carries the live runner state and is refreshed in place.
 */
async function rollRunner(
	d: Deps,
	compose: string[],
	exec: (code: string) => Promise<{ code: number; out: string }>,
	service: string,
	runner: Runner,
	board: { preparing: number; runners: Runner[] },
	stop: (why: string) => number,
): Promise<RollOne> {
	const held = await exec(holdRunner(service));
	if (held.code !== 0)
		return {
			kind: "stop",
			early: stop(`the board cannot hold ${service}: ${lastLine(held.out)}`),
		};
	// The runner's turns drain while the other runners keep working. `preparing` is
	// not attributable to one runner, so a preparing turn holds every runner idle.
	const since = d.now();
	let busy = true;
	// ponytail: i only guards the first-poll note below, and i-- keeps i === 0
	// exclusive to the first pass, so Stryker's i-- mutant prints the same note.
	for (let i = 0; ; i++) {
		const r = board.runners.find((x) => x.id === service);
		if (r !== undefined && r.turns === 0 && board.preparing === 0) {
			busy = false;
			break;
		}
		// The next poll would end past the limit.
		if (d.now() - since + POLL_MS > HOLD_LIMIT_MS) break;
		if (i === 0)
			d.log(
				`${service} still runs its turns: the roll follows when they finish`,
			);
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
		// A refused renewal lands in the busy path below: release, and a later run rolls.
		const renewed = await exec(holdRunner(service));
		if (renewed.code !== 0) break;
	}
	if (busy) {
		// The runner keeps its turn: release it, leave it on the old image, and let
		// a later run roll it.
		const freed = await exec(freeRunner(service));
		d.log(
			freed.code === 0
				? `${service} keeps a turn after ${HOLD_LIMIT_MS / 60_000} min: its hold ends, and its restart waits for a later run`
				: `${service} keeps a turn after ${HOLD_LIMIT_MS / 60_000} min, and the board cannot end its hold (${lastLine(freed.out)}): it lapses 30 min after the last renewal`,
		);
		return { kind: "stuck" };
	}
	// --wait waits for the worker's own compose healthcheck; a failed recreate is a
	// failed health check: the roll stops, and the other containers stay on the old image.
	const failed = await recreate(d, compose, service, stop);
	if (failed !== null) return { kind: "stop", early: failed };
	if (runner.url !== null) {
		// Healthy is not connected: the roll goes on only when the server reaches
		// the new worker again.
		const cSince = d.now();
		for (;;) {
			const h = await exec(probeRunner(runner.url));
			if (h.code === 0) break;
			if (d.now() - cSince + POLL_MS > CONNECT_LIMIT_MS)
				return {
					kind: "stop",
					early: stop(
						`${service} never answers ${runner.url}/healthz: ${lastLine(h.out)}`,
					),
				};
			await d.wait(POLL_MS);
		}
	}
	const freed = await exec(freeRunner(service));
	if (freed.code !== 0)
		d.log(
			`the board cannot end ${service}'s hold (${lastLine(freed.out)}): it lapses 30 min after the last renewal`,
		);
	return { kind: "rolled" };
}

/**
 * The server's own roll, always last: the whole-board hold carries the commit subjects
 * and the notices show it, then the recreate (a new image) or the restart (a seed only)
 * takes the seed. The recreate or restart clears every in-memory drain, so no undrain
 * is needed. Returns the early exit code, or null when the board took the seed.
 */
async function rollServer(
	d: Deps,
	compose: string[],
	commits: string[],
	seeded: boolean,
	seedFailed: boolean,
	changed: boolean,
	wantedSha: string,
	stop: (why: string) => number,
): Promise<number | null> {
	if (!changed && !seeded) return null;
	const holdCommits = seeded
		? [...commits, `board agent layer seed ${wantedSha.slice(0, 12)}`]
		: commits;
	const early = await drainRunningBoard(d, compose, holdCommits, true, stop);
	// ponytail: as in legacyDrainAndRestart — seedFailed dominates the final exit,
	// so this mapping's mutants cannot change the run's exit.
	if (early !== null) return early === 0 && seedFailed ? 1 : early;
	if (changed) return recreate(d, compose, "server", stop);
	const rs = await d.docker("compose", ...compose, "restart", "server");
	return rs.code === 0
		? null
		: stop(`docker compose restart server failed: ${rs.out.trim()}`);
}

/** The roll's outcome: an early exit code (the run stops or waits for a later run),
 * or a stack that is up and took the seed. `settled` is only read on the no-early
 * variants, so the early returns carry no flag a mutant could flip in the dark. */
type RollOutcome = { early: number } | { early: null; settled: boolean };

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
	// No running board, no turn can run: workers kill a turn when the board's request
	// drops, and merge turns die with the board. Skip the roll and start the stack.
	if (!serverWasRunning) {
		d.log("no running board to count turns in; restarting anyway");
		const up = await d.docker("compose", ...compose, "up", "-d", "--wait");
		if (up.code !== 0)
			return {
				early: stop(`docker compose up --wait failed: ${up.out.trim()}`),
			};
		return { early: null, settled: true };
	}
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
	let stuck = false;
	for (const service of services.filter((s) => s !== "server")) {
		const ch = await imageChanged(d, compose, service);
		if ("error" in ch) {
			d.log(
				`skipping ${service}: its image cannot be compared with the build: ${ch.error}`,
			);
			continue;
		}
		if (!ch.changed) continue;
		const runner = board.runners.find((r) => r.id === service);
		if (runner === undefined) {
			// No runner lists this hostname, so no turn can reach it: it recreates
			// without a hold and without a turns wait, like a sidecar service does.
			d.log(
				`${service} is no runner on the board: it recreates without a hold`,
			);
			const failed = await recreate(d, compose, service, stop);
			if (failed !== null) return { early: failed };
			continue;
		}
		const one = await rollRunner(
			d,
			compose,
			exec,
			service,
			runner,
			board,
			stop,
		);
		if (one.kind === "stop") return { early: one.early };
		if (one.kind === "stuck") stuck = true;
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
	const early = await rollServer(
		d,
		compose,
		commits,
		seeded,
		seedFailed,
		ch.changed,
		wantedSha,
		stop,
	);
	if (early !== null) return { early };
	// The whole-stack up only starts a service that is not running and waits for the
	// server's health: every changed container was rolled per service above.
	const up = await d.docker("compose", ...compose, "up", "-d", "--wait");
	if (up.code !== 0)
		return {
			early: stop(`docker compose up --wait failed: ${up.out.trim()}`),
		};
	return { early: null, settled: true };
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

/** The run's exit code: 1 when it stopped early or failed, else 0. */
export async function updateImage(
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

	const built = await buildAndSidecars(d, compose, repo, stop);
	if (built !== null) return built;

	// One ps lists the running services. A board that does not run cannot be counted,
	// and that must not block every later deploy; a failed ps fails closed.
	const services = await runningServices(d, compose, stop);
	if (typeof services === "number") return services;
	const serverWasRunning = services.includes("server");

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
	if (rolled.early !== null) return rolled.early;
	// The record lands only after the board took the seed (a rolled server, a legacy
	// restart, or a start): a stuck runner defers the restart, and the next run seeds
	// again and retries.
	const recordFailed = rolled.settled
		? await recordSeed(d, compose, seed.seeded, seed.wantedSha, seed.expires)
		: false;
	await d.docker(
		"image",
		"prune",
		"--force",
		"--filter",
		"label=ottr.image=worker",
	);
	d.log(`the stack runs main at ${meta.head} with omp ${meta.omp}`);
	// ponytail: a dirty ALATE_DATA checkout records HEAD, so uncommitted edits do not
	// retrigger a seed; the next pushed commit does.
	return seed.failed || recordFailed ? 1 : 0;
}

if (import.meta.main) {
	const repo = resolve(import.meta.dir, "..");
	dropBunDotenv(process.argv.slice(2));
	// The shell env wins over --env-file values, matching compose's precedence.
	for (const [key, value] of Object.entries(
		envFileValues(process.argv.slice(2)),
	)) {
		if (process.env[key] === undefined) process.env[key] = value;
	}
	process.exitCode = await updateImage(repo, process.argv.slice(2), {
		docker: async (...args) => {
			const r = await $`docker ${args}`.cwd(repo).nothrow().quiet();
			// stderr first: compose warnings must not land after the turn count.
			return { code: r.exitCode, out: `${r.stderr}${r.stdout}` };
		},
		log: (line) => console.log(`${new Date().toISOString()} ${line}`),
		wait: (ms) => Bun.sleep(ms),
		now: Date.now,
	});
}

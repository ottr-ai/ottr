#!/usr/bin/env bun
// Deploys main to a compose stack. Run it on a schedule from a clean `main` checkout
// (docs/WORKERS.md, "Updates"): it fast-forwards main, builds the image, and restarts the
// stack once no turn runs. While a new image waits, it holds new turns on the board for at
// most 1 h, so the running turns finish. With ALATE_DATA or ALATE_DATA_REPO in the env file
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
// While a new image waits, the count repeats every 30 s until no turn runs. The scheduled task
// starts no second run meanwhile (IgnoreNew), so the run that built the image restarts the stack.
const POLL_MS = 30_000;
// A hold lasts at most 1 h, so a long turn (a mutation run of several hours) stops the queue
// of new turns for 1 h at most. Then the run ends the hold, and a later run tries again.
const HOLD_LIMIT_MS = 60 * 60_000;

/** The real docker dep puts stderr first: compose warnings come before the answer's last line. */
const lastLine = (out: string): string =>
	out.trim().split("\n").at(-1)?.trim() ?? "";

/**
 * The env-file values a run passes as `--env-file`, plus the repo root's `.env` when it
 * exists (cwd-relative). Later files win; blank and `#` lines are skipped, and a value
 * may itself contain `=`. Pure: it reads, it never touches the environment.
 */
export function envFileValues(args: string[]): Record<string, string> {
	const files: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--env-file") files.push(args[++i] ?? "");
		else if (a.startsWith("--env-file="))
			files.push(a.slice("--env-file=".length));
	}
	if (existsSync(".env")) files.push(".env");
	const values: Record<string, string> = {};
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue; // a named file that is gone must not fail the run
		}
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (t === "" || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq <= 0) continue;
			values[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
		}
	}
	return values;
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
): Promise<{ wanted: string; args: string[] } | { failed: string } | null> {
	const { ALATE_DATA, ALATE_DATA_REPO, GH_TOKEN } = env;
	if (ALATE_DATA === undefined) {
		if (ALATE_DATA_REPO === undefined) {
			d.log(
				"board seed: no ALATE_DATA or ALATE_DATA_REPO in the environment; the board keeps its current agent layer",
			);
			return null;
		}
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
		return {
			wanted,
			args: [
				"run",
				"--rm",
				"--no-deps",
				"board-seed",
				"--repo",
				ALATE_DATA_REPO,
			],
		};
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
 * this compose project, else any running alate container. `discovered` marks an image read
 * from docker, which the compose child then needs as ALATE_IMAGE for `${ALATE_IMAGE:-...}`.
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
		"name=alate",
		"--format",
		"{{.Image}}",
	);
	const image = dps.out.split("\n")[0]?.trim() ?? "";
	return image === "" ? null : { image, discovered: true };
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
		if (d.now() - since + POLL_MS > HOLD_LIMIT_MS) {
			const freed = await exec(FREE_TURNS);
			d.log(
				freed.code === 0
					? `${turns} turns run after ${HOLD_LIMIT_MS / 60_000} min of hold: the hold ends, and the restart waits for a later run`
					: `${turns} turns run after ${HOLD_LIMIT_MS / 60_000} min of hold, and the board cannot end the hold (${lastLine(freed.out)}): it lapses 30 min after the last renewal`,
			);
			return 0;
		}
		await d.wait(POLL_MS);
		held = await hold();
	}
	if (turns !== "0") {
		d.log(`${turns} turns run: the restart waits for a later run`);
		return 0;
	}
	return null;
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

	const build = await d.docker("compose", ...compose, "build", "server");
	if (build.code !== 0) {
		d.log(build.out.trim().split("\n").slice(-10).join("\n"));
		return stop("the image does not build; the stack keeps the old one");
	}
	// Services a host-only override builds from another local git checkout (the compose
	// files in this repo name none) deploy on their own (deploySidecar).
	for (const s of await sidecarCheckouts(d, compose, repo))
		await deploySidecar(d, compose, s);
	// One ps lists the running services. A board that does not run cannot be counted,
	// and that must not block every later deploy; a failed ps fails closed.
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
	const serverWasRunning = running.out.trim().split("\n").includes("server");
	// The board's agent layer comes from the data repo, and the board-seed service is its
	// only writer (never the worker-writable shared home). A commit the volume has not
	// recorded yet seeds once, before the drain. A failed seed never blocks the deploy;
	// the run only exits 1 after the normal success line.
	let seeded = false;
	let seedFailed = false;
	let wantedSha = "";
	const seed = await seedSource(d, env, repo);
	if (seed === null) {
		// seedSource already logged the skip.
	} else if ("failed" in seed) {
		d.log(`board seed failed: ${seed.failed}`);
		seedFailed = true;
	} else {
		wantedSha = seed.wanted;
		let record: string | null = null;
		if (serverWasRunning) {
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
			if (read !== "") record = read;
		}
		if (record === seed.wanted) {
			d.log(`board agent layer current at ${seed.wanted.slice(0, 12)}`);
		} else {
			const found = await alateImage(d, compose, env);
			if (found === null) {
				d.log(
					"board seed failed: no alate image found; set ALATE_IMAGE in the env file",
				);
				seedFailed = true;
			} else {
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
						seedFailed = true;
					} else {
						d.log(`board agent layer seeded at ${seed.wanted.slice(0, 12)}`);
						seeded = true;
					}
				} finally {
					if (found.discovered) {
						if (prev === undefined) delete process.env.ALATE_IMAGE;
						else process.env.ALATE_IMAGE = prev;
					}
				}
			}
		}
	}
	// No running board, no turn can run: merge turns die with the board and workers
	// kill a turn when the board's request drops. Skip counting and go straight to up.
	let serverImageChanged = false;
	if (serverWasRunning) {
		// The build tags the server's image name; a server on another image means that the
		// restart brings a new image. imageChanged compares the platform manifests where
		// the containerd image store reports them: the image ids differ on every build.
		const r = await imageChanged(d, compose, "server");
		if ("error" in r)
			return stop(
				`the server's image cannot be compared with the build: ${r.error}`,
			);
		serverImageChanged = r.changed;
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
		if (early !== null) return early;
	} else d.log("no running board to count turns in; restarting anyway");
	// --wait fails the run when the recreated board never turns healthy, so the script
	// never logs success for a crash-loop.
	const up = await d.docker("compose", ...compose, "up", "-d", "--wait");
	if (up.code !== 0)
		return stop(`docker compose up --wait failed: ${up.out.trim()}`);
	// The recreate already rebooted a server whose image changed, and up started a board
	// that was down with the seed. Only a running board that keeps its image restarts.
	if (seeded && serverWasRunning && !serverImageChanged) {
		const rs = await d.docker("compose", ...compose, "restart", "server");
		if (rs.code !== 0)
			return stop(`docker compose restart server failed: ${rs.out.trim()}`);
	}
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
	await d.docker(
		"image",
		"prune",
		"--force",
		"--filter",
		"label=ottr.image=worker",
	);
	d.log(`the stack runs main at ${head} with omp ${omp}`);
	// ponytail: a dirty ALATE_DATA checkout records HEAD, so uncommitted edits do not
	// retrigger a seed; the next pushed commit does.
	return seedFailed ? 1 : 0;
}

if (import.meta.main) {
	const repo = resolve(import.meta.dir, "..");
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

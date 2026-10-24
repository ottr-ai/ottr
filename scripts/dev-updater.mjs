#!/usr/bin/env bun
// Dev-only Windows updater: hosts the Ottr board as a child process and, whenever the
// board is idle and origin/main has moved, stops it, fast-forwards, reinstalls and starts
// the new build. Run from the repo root: `bun scripts/dev-updater.mjs`. The board port is
// PORT (Bun also reads it from `.env`), default 4850. At start, an existing `tailscale serve`
// HTTPS root is re-pointed at that port, so phone access survives a port change.
// ponytail: one file, zero deps, restart-on-exit as the only crash policy; wrap it in a
// service manager only if it outgrows a dev machine.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PORT = process.env.PORT ?? "4850";
const INTERVAL = Number(process.env.UPDATER_INTERVAL_MS ?? 30_000);
const BASE = `http://127.0.0.1:${PORT}`;

const log = (...a) =>
	console.log(new Date().toISOString().slice(11, 19), "[dev-updater]", ...a);

let child = null;
let updating = false;
let ticking = false;
let stopping = false;
let lastFailLog = 0;

function realGit(args) {
	return spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
}

/** Guard messages repeat every tick while blocked; log them at most every 10 minutes. */
let lastGuardLog = 0;
function guardLog(message) {
	if (Date.now() - lastGuardLog < 600_000) return;
	lastGuardLog = Date.now();
	log(message, "; not restarting the board");
}

/** Re-points an existing `tailscale serve` HTTPS root at the board; never creates one. */
function syncTailscale() {
	const ts = (...args) =>
		spawnSync("tailscale", args, { encoding: "utf8", timeout: 10_000 });
	const status = ts("serve", "status", "--json");
	if (status.status !== 0)
		return log(
			"tailscale check skipped:",
			status.error?.message ?? status.stderr.trim(),
		);
	const target = `http://127.0.0.1:${PORT}`;
	// ponytail: re-points whatever the :443 root proxies; check that it is a board first if
	// that root ever serves another app.
	const web = JSON.parse(status.stdout)?.Web ?? {};
	const root = Object.entries(web).find(([host]) => host.endsWith(":443"))?.[1]
		.Handlers?.["/"]?.Proxy;
	if (root === undefined || root === target) return;
	const set = ts("serve", "--bg", PORT);
	if (set.status === 0) log(`tailscale serve: ${root} -> ${target}`);
	else
		log(
			"tailscale serve --bg failed:",
			set.error?.message ?? set.stderr.trim(),
		);
}

function startServer() {
	log(`starting the board on :${PORT}`);
	const c = spawn("bun", ["src/server.ts"], {
		cwd: REPO,
		env: { ...process.env, PORT },
		stdio: "inherit",
	});
	c.on("exit", (code) => {
		if (stopping || updating) return;
		log(`board exited unexpectedly (code ${code}); restarting in 2 s`);
		setTimeout(() => {
			// A check started meanwhile: its finally owns the next start.
			if (stopping || updating) return;
			child = startServer();
		}, 2_000);
	});
	return c;
}

function stopServer() {
	return new Promise((resolve) => {
		if (child === null || child.exitCode !== null) return resolve();
		const c = child;
		const force = setTimeout(() => {
			log("board did not exit in 5 s; killing the process tree");
			spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"]);
			resolve();
		}, 5_000);
		c.on("exit", () => {
			clearTimeout(force);
			resolve();
		});
		c.kill();
	});
}

/** No running or preparing turn in any project: the only safe moment to swap builds. */
async function boardIdle() {
	try {
		const r = await fetch(`${BASE}/api/state`, {
			signal: AbortSignal.timeout(10_000),
		});
		const { tasks } = await r.json();
		if (!Array.isArray(tasks)) throw new Error("unexpected /api/state shape");
		return !tasks.some((t) => t.state === "running" || t.state === "preparing");
	} catch (e) {
		// Unknown means unsafe: the boot check answered just before this call.
		log("idle check failed:", e.message ?? e);
		return false;
	}
}

async function servedVersion() {
	try {
		const r = await fetch(`${BASE}/api/boot`, {
			signal: AbortSignal.timeout(10_000),
		});
		return (await r.json()).version ?? null;
	} catch {
		return null;
	}
}

function installBuild() {
	return spawnSync("bun", ["install", "--frozen-lockfile"], {
		cwd: REPO,
		stdio: "inherit",
	});
}

/** Logs the reason and returns null when the board must not restart, else { remote, version }. */
async function restartTarget({ git, served, idle }) {
	const fetched = git(["fetch", "origin", "--quiet"]);
	if (fetched.status !== 0) {
		log("git fetch failed:", fetched.stderr.trim());
		return null;
	}
	const remote = git(["rev-parse", "origin/main"]).stdout?.trim();
	const version = await served();
	if (!remote || remote === version) return null;
	// Restart only when main can fast-forward to origin/main, or already is origin/main
	// while the board still serves an older build (its own merge or a manual update).
	// Ahead, diverged or non-main HEAD would restart the board every tick with no
	// change, so log once and leave the board alone.
	const branch = git(["branch", "--show-current"]).stdout?.trim();
	if (branch !== "main") {
		guardLog(`HEAD is on ${branch || "a detached state"}, not main`);
		return null;
	}
	if (
		git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]).status !== 0
	) {
		guardLog("main does not fast-forward to origin/main");
		return null;
	}
	const down = version === null && (child === null || child.exitCode !== null);
	if (version === null && !down) {
		log("board runs but does not answer; not restarting it");
		return null;
	}
	if (!down && !(await idle())) return null;
	return { remote, version };
}

/** One origin/main refresh; tests inject dep fakes instead of real effects. */
export async function check({
	git = realGit,
	served = servedVersion,
	idle = boardIdle,
	stop = stopServer,
	start = startServer,
	install = installBuild,
} = {}) {
	const restart = await restartTarget({ git, served, idle });
	if (restart === null) return;
	const { remote, version } = restart;
	log(
		`update: ${version?.slice(0, 7) ?? "down"} -> ${remote.slice(0, 7)}; stopping the board`,
	);
	updating = true;
	try {
		await stop();
		const ff = git(["merge", "--ff-only", "origin/main"]);
		if (ff.status !== 0) {
			// Keep serving nothing rather than a non-fast-forwarded tree: fail loudly, retry next tick.
			log("ff-only merge failed; leaving HEAD as is:", ff.stderr.trim());
			if (Date.now() - lastFailLog > 600_000) {
				lastFailLog = Date.now();
				log("still blocked; will keep retrying every tick");
			}
			return;
		}
		if (install().status !== 0) log("bun install failed; starting anyway");
	} finally {
		updating = false;
		child = start();
	}
}

/** One check at a time: overlapping ticks answered twice and started two boards. */
async function tick() {
	if (ticking) return;
	ticking = true;
	try {
		await check();
	} finally {
		ticking = false;
	}
}

// Side effects only when run as a script; the test imports check() instead.
if (import.meta.main) {
	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, () => {
			stopping = true;
			log("stopping");
			if (child !== null) child.kill();
			process.exit(0);
		});
	}
	syncTailscale();
	child = startServer();
	setInterval(tick, INTERVAL);
	setTimeout(tick, 5_000);
	log(
		`watching ${REPO.trim()} (origin/main vs :${PORT}); interval ${INTERVAL / 1000} s`,
	);
}

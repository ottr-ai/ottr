import { createHash } from "node:crypto";
import {
	closeSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Stryker sandbox parent for one checkout: tmpdir()/ott-stryker-<12 hex chars of the repo
 * root path>. A machine-global parent put every worktree's sandbox next to every other's, and a
 * killed run's leftover sandbox then held a foreign or stale tree (OTTR-500). Stryker creates a
 * fresh randomly-named sandbox-N inside the parent per run (mkdtemp), so the parent needs no
 * per-run name — wiping it at run start (see stryker.config.mjs) clears a killed run's leftover.
 * The repo root defaults to cwd: every Stryker run here starts at the checkout's root.
 */
export function sandboxTempDirName(
	repoRoot = realpathSync(process.cwd()),
	tmp = tmpdir(),
) {
	const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
	return join(tmp, `ott-stryker-${hash}`);
}

/**
 * Stryker worker count: half of the host CPUs, at least 1, so a mutation run never asks for more
 * CPU than the host has. STRYKER_CONCURRENCY is the calibration knob and wins when set.
 */
export function mutationConcurrency(
	env = process.env,
	parallelism = os.availableParallelism(),
) {
	const raw = env.STRYKER_CONCURRENCY;
	if (raw) {
		const value = Number(raw);
		if (!Number.isInteger(value) || value < 1) {
			throw new Error(
				`STRYKER_CONCURRENCY must be a positive integer, got ${JSON.stringify(raw)}`,
			);
		}
		return value;
	}
	return Math.max(1, Math.floor(parallelism / 2));
}

/**
 * True when this process is a Stryker run itself: its entry script is Stryker's own bin
 * (`node_modules/.bin/stryker`, or the `stryker.js` file it points at). A plain import of a
 * config — a tool reading the `mutate` arrays — must take no mutation lock, or the Stryker
 * children it starts would wait for the lock their own parent holds (OTTR-366).
 */
export function isStrykerRun(argv = process.argv) {
	const entry = String(argv[1] ?? "").replaceAll("\\", "/");
	const base = entry.slice(entry.lastIndexOf("/") + 1);
	return /^stryker(\.(cjs|mjs|js))?$/.test(base);
}

// Atomics.wait is a synchronous sleep, so the Stryker config modules need no top-level await.
const sleepSync = (ms) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function lockPid(lockPath) {
	try {
		return JSON.parse(readFileSync(lockPath, "utf8")).pid;
	} catch {
		return null; // unreadable or corrupt: a stale lock from a killed run
	}
}

function lockHolderAlive(lockPath) {
	const pid = lockPid(lockPath);
	if (pid === null || pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM"; // the process exists but belongs to another user
	}
}

function tryCreateLock(lockPath) {
	try {
		const fd = openSync(lockPath, "wx");
		writeSync(fd, JSON.stringify({ pid: process.pid }));
		closeSync(fd);
		return true;
	} catch (err) {
		if (err?.code !== "EEXIST") throw err;
		return false;
	}
}

/**
 * Lets one mutation run at a time use a Stryker temp root: creates `<tempDirName>.lock` and
 * returns the release function, which the process exit hook calls. A second run waits and logs
 * once, then logs when it gets the lock. A lock whose holder died is taken over. With
 * `timeoutMs`, the wait throws when the budget ends while the lock is still held.
 */
export function acquireMutationLock(
	tempDirName,
	{ timeoutMs = 0, log = (message) => console.log(message) } = {},
) {
	const lockPath = `${tempDirName}.lock`;
	const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
	let waited = false;
	while (!tryCreateLock(lockPath)) {
		if (!lockHolderAlive(lockPath)) {
			rmSync(lockPath, { force: true });
			continue;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`mutation lock ${lockPath} is still held by pid ${lockPid(lockPath)} after ${timeoutMs} ms`,
			);
		}
		if (!waited) {
			log(
				`[stryker] waiting for the mutation lock ${lockPath} (pid ${lockPid(lockPath)})`,
			);
			waited = true;
		}
		sleepSync(500);
	}
	if (waited) log(`[stryker] mutation lock ${lockPath} acquired`);
	const release = () => {
		if (lockPid(lockPath) === process.pid) rmSync(lockPath, { force: true });
	};
	process.on("exit", release);
	return release;
}

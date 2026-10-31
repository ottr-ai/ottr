import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import os from "node:os";

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
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid }));
			closeSync(fd);
			break;
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
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
	}
	if (waited) log(`[stryker] mutation lock ${lockPath} acquired`);
	const release = () => {
		if (lockPid(lockPath) === process.pid) rmSync(lockPath, { force: true });
	};
	process.on("exit", release);
	return release;
}

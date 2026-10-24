import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { platform } from "./index.ts";
import { unix } from "./unix.ts";

/** First stdout line of a long-lived child; the pipe stays open, so read incrementally. */
async function firstLine(stream: Readable): Promise<string> {
	let buf = "";
	for await (const chunk of stream) {
		buf += String(chunk);
		const nl = buf.indexOf("\n");
		if (nl >= 0) return buf.slice(0, nl).trim();
	}
	return buf.trim();
}

/** True once the pid is reaped, or (Linux) a SIGKILLed zombie waiting for its reaper. */
function isGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return true;
	}
	if (process.platform === "win32") return false;
	try {
		// /proc/<pid>/stat field 3 is the state; comm may contain spaces, so read after the last ")"
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return (
			stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z"
		);
	} catch {
		return true; // vanished between kill(0) and the read
	}
}

// killTree needs a real procps/busybox `ps` to snapshot the tree; spawnSync execs the
// binary directly, so a shell builtin never masks its absence.
const hasPs =
	spawnSync("ps", ["-A", "-o", "pid="], { stdio: "ignore" }).status === 0;

test("killTree no-ops on pid <= 0", () => {
	// A fake kill, never the real one: with the guard mutated, killTree(0) would signal
	// process group 0 — the caller's whole group, the Stryker worker included (exit 137).
	const noSignals: Array<[number, string]> = [];
	const probeKill = ((pid: number, signal: string) => {
		noSignals.push([pid, signal]);
		return true;
	}) as unknown as typeof process.kill;
	unix.killTree(0, probeKill);
	unix.killTree(-1, probeKill);
	expect(noSignals).toEqual([]);
	expect(() => process.kill(process.pid, 0)).not.toThrow(); // the test process survived
});

test.skipIf(!hasPs)(
	"killTree kills a two-level tree",
	async () => {
		// Parent spawns a grandchild (stdio ignore), prints its pid, then both idle until killed.
		const PARENT_SCRIPT = [
			'const kid = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });',
			"console.log(kid.pid);",
			"setInterval(() => {}, 1000);",
		].join("\n");
		const parent = spawn(process.execPath, ["-e", PARENT_SCRIPT], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		parent.once("error", () => {});
		const grandchild = Number(await firstLine(parent.stdout));
		expect(grandchild).toBeGreaterThan(0);
		// spawn() assigns pid synchronously; only a spawn error (handled above) leaves it undefined.
		const pid = parent.pid;
		if (pid === undefined) throw new Error("spawn produced no pid");
		expect(isGone(pid)).toBe(false);

		platform.killTree(pid);

		// Real wall-clock: process death has no promise or event to await; the loop exits on the condition, not a guessed duration.
		for (
			let waited = 0;
			waited < 5000 && !(isGone(pid) && isGone(grandchild));
			waited += 100
		) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(isGone(pid)).toBe(true);
		expect(isGone(grandchild)).toBe(true);
	},
	30_000,
);

describe.skipIf(process.platform === "win32")("unix platform", () => {
	test("listProcesses throws when the ps scan fails", () => {
		const fail = ((command: string) => {
			if (command !== "ps") throw new Error(`unexpected ${command}`);
			return { status: 1, stdout: "", stderr: "" };
		}) as unknown as typeof spawnSync;
		expect(() => unix.listProcesses(fail)).toThrow(
			/process scan failed: exit 1/,
		);
	});

	test("listProcesses throws when ps is missing", () => {
		const err = new Error("spawn ps ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		const missing = (() => ({
			status: null,
			stdout: "",
			error: err,
		})) as unknown as typeof spawnSync;
		expect(() => unix.listProcesses(missing)).toThrow(
			/process scan failed: .*ENOENT/,
		);
	});

	test("listProcesses passes a 32 MiB maxBuffer to ps", () => {
		const calls: Array<{ options: unknown }> = [];
		const ok = ((command: string, _args: string[], options: unknown) => {
			if (command !== "ps") throw new Error(`unexpected ${command}`);
			calls.push({ options });
			return { status: 0, stdout: "" };
		}) as unknown as typeof spawnSync;
		expect(unix.listProcesses(ok)).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.options).toMatchObject({
			maxBuffer: 32 * 1024 * 1024,
		});
	});

	test("listProcesses parses ps output", () => {
		const before = Date.now();
		const ok = ((command: string) => {
			if (command !== "ps") throw new Error(`unexpected ${command}`);
			return { status: 0, stdout: "  42  10 omp -p\n" };
		}) as unknown as typeof spawnSync;
		const list = unix.listProcesses(ok);
		expect(list).toHaveLength(1);
		expect(list[0]!.pid).toBe(42);
		expect(list[0]!.cmd).toBe("omp -p");
		// started ≈ now - 10s of etimes
		expect(Math.abs(list[0]!.started - (before - 10_000))).toBeLessThan(5_000);
	});

	test("listProcesses handles >1MiB of ps output via a real child", () => {
		// ponytail: sh prints the fake ps table instead of running ps, so the test stays fast (~1.2 MiB).
		// Regression guard: without a raised maxBuffer the default 1 MiB cap kills the child and
		// listProcesses throws instead of parsing.
		const bigRun = ((_command: string, _args: string[], options?: object) =>
			spawnSync(
				"sh",
				[
					"-c",
					"awk 'BEGIN{for(i=1;i<=42000;i++) printf \"  %d 10 fake-proc-%d --flag\\n\", i, i}'",
				],
				options,
			)) as unknown as typeof spawnSync;
		const list = unix.listProcesses(bigRun);
		expect(list).toHaveLength(42000);
		expect(list[41999]!.pid).toBe(42000);
		expect(list[41999]!.cmd).toBe("fake-proc-42000 --flag");
	});
});

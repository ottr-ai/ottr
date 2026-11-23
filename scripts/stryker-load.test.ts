import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireMutationLock,
	cappedConcurrency,
	concurrencyLogLine,
	isStrykerRun,
	mutationConcurrency,
	sandboxTempDirName,
	sweepSandboxProcesses,
} from "./stryker-load.mjs";

// Cgroup v2 paths that do not exist, so the CPU rule decides alone (the pre-OTTR-886
// behavior) no matter what the host's real cgroup says.
const NO_CGROUP = {
	max: "/ottr-886-absent/memory.max",
	current: "/ottr-886-absent/memory.current",
};
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function withCgroup(
	max: string,
	current: string,
	run: (cgroup: { max: string; current: string }) => void,
): void {
	const dir = mkdtempSync(join(tmpdir(), "ottr-886-cgroup-"));
	const cgroup = {
		max: join(dir, "memory.max"),
		current: join(dir, "memory.current"),
	};
	writeFileSync(cgroup.max, max);
	writeFileSync(cgroup.current, current);
	try {
		run(cgroup);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("mutationConcurrency is half of the CPUs, at least 1", () => {
	// NO_CGROUP keeps this the CPU rule in isolation; with a real cgroup the memory rule may
	// lower the result.
	expect(mutationConcurrency({}, 24, NO_CGROUP)).toBe(12);
	expect(mutationConcurrency({}, 25, NO_CGROUP)).toBe(12);
	expect(mutationConcurrency({}, 2, NO_CGROUP)).toBe(1);
	expect(mutationConcurrency({}, 1, NO_CGROUP)).toBe(1);
	for (let cpus = 1; cpus <= 64; cpus++) {
		expect(mutationConcurrency({}, cpus, NO_CGROUP)).toBe(
			Math.max(1, Math.floor(cpus / 2)),
		);
	}
});

test("the memory rule sizes slots from free cgroup memory", () => {
	// The OTTR-886 acceptance case: 8 GiB limit, 4 GiB used, 24 CPUs. Free 3072 MiB after
	// the 1 GiB reserve at 400 MiB per slot gives 7; the CPU rule alone (the behavior before
	// this change) would return 12.
	withCgroup(String(8 * GIB), String(4 * GIB), (cgroup) => {
		expect(mutationConcurrency({}, 24, cgroup)).toBe(7);
	});
	// Slot boundaries: reserve + 400 MiB gives 1 slot, reserve + 800 MiB gives 2.
	withCgroup(String(GIB + 400 * MIB), "0", (cgroup) => {
		expect(mutationConcurrency({}, 24, cgroup)).toBe(1);
	});
	withCgroup(String(GIB + 800 * MIB), "0", (cgroup) => {
		expect(mutationConcurrency({}, 24, cgroup)).toBe(2);
	});
});

test("memory.max 'max' or missing cgroup files keep the CPU rule", () => {
	withCgroup("max", String(4 * GIB), (cgroup) => {
		expect(mutationConcurrency({}, 24, cgroup)).toBe(12);
	});
	expect(mutationConcurrency({}, 24, NO_CGROUP)).toBe(12);
});

test("very low free memory gives 1 slot, never 0", () => {
	// Free memory inside the reserve: the floor would be 0 or negative, clamped to 1.
	withCgroup(String(8 * GIB), String(8 * GIB - 512 * MIB), (cgroup) => {
		expect(mutationConcurrency({}, 24, cgroup)).toBe(1);
	});
	// Used beyond the limit, on 1 CPU: still 1.
	withCgroup(String(GIB), String(2 * GIB), (cgroup) => {
		expect(mutationConcurrency({}, 1, cgroup)).toBe(1);
	});
});

test("STRYKER_CONCURRENCY wins over the memory rule", () => {
	withCgroup(String(8 * GIB), String(4 * GIB), (cgroup) => {
		expect(mutationConcurrency({ STRYKER_CONCURRENCY: "5" }, 24, cgroup)).toBe(
			5,
		);
		expect(mutationConcurrency({ STRYKER_CONCURRENCY: "20" }, 24, cgroup)).toBe(
			20,
		);
	});
});

test("cappedConcurrency takes the lowest of cap and the rules", () => {
	withCgroup(String(8 * GIB), String(4 * GIB), (cgroup) => {
		// The memory rule (7) under the cap (8).
		expect(cappedConcurrency(8, {}, 24, cgroup)).toBe(7);
		// The cap (5) under the memory rule (7).
		expect(cappedConcurrency(5, {}, 24, cgroup)).toBe(5);
		// STRYKER_CONCURRENCY still lands under the cap.
		expect(
			cappedConcurrency(8, { STRYKER_CONCURRENCY: "20" }, 24, cgroup),
		).toBe(8);
	});
});

test("STRYKER_CONCURRENCY overrides the CPU value when set", () => {
	expect(mutationConcurrency({ STRYKER_CONCURRENCY: "5" }, 24, NO_CGROUP)).toBe(
		5,
	);
	expect(mutationConcurrency({ STRYKER_CONCURRENCY: "3" }, 2, NO_CGROUP)).toBe(
		3,
	);
	expect(mutationConcurrency({ STRYKER_CONCURRENCY: "" }, 24, NO_CGROUP)).toBe(
		12,
	);
});

test("STRYKER_CONCURRENCY rejects values below 1 and non-integers", () => {
	expect(() => mutationConcurrency({ STRYKER_CONCURRENCY: "0" })).toThrow();
	expect(() => mutationConcurrency({ STRYKER_CONCURRENCY: "-3" })).toThrow();
	expect(() => mutationConcurrency({ STRYKER_CONCURRENCY: "2.5" })).toThrow();
	expect(() => mutationConcurrency({ STRYKER_CONCURRENCY: "abc" })).toThrow();
});

test("sandboxTempDirName keys the sandbox parent on the checkout root", () => {
	// Stable for one checkout, distinct across checkouts (OTTR-500): parallel
	// worktrees must not share a sandbox parent.
	expect(sandboxTempDirName("/repo-a")).toBe(sandboxTempDirName("/repo-a"));
	expect(sandboxTempDirName("/repo-a")).not.toBe(sandboxTempDirName("/repo-b"));
	expect(sandboxTempDirName("/repo-a", "/tmp-x")).toMatch(
		/^\/tmp-x\/ott-stryker-[0-9a-f]{12}$/,
	);
	expect(sandboxTempDirName()).toBe(
		sandboxTempDirName(realpathSync(process.cwd())),
	);
});

const helperUrl = JSON.stringify(
	new URL("./stryker-load.mjs", import.meta.url).href,
);
// The child script imports the helper by a runtime-computed absolute file URL (the path differs
// between Windows and Linux hosts), so a static import specifier cannot express it here.
// Tries the lock with a 1.5 s budget: prints ACQUIRED when it gets the lock, WAITED when the
// budget ends while another run still holds it.
const tryLock = `const { acquireMutationLock } = await import(${helperUrl});
try {
	const release = acquireMutationLock(process.env.LOCK_SANDBOX, { timeoutMs: 1500 });
	console.log("ACQUIRED");
	release();
} catch {
	console.log("WAITED");
}`;

function withSandbox(run: (sandbox: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "ottr-stryker-lock-"));
	try {
		run(join(dir, "ott-stryker"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function tryLockRun(sandbox: string): string {
	const child = spawnSync(process.execPath, ["-e", tryLock], {
		env: { ...process.env, LOCK_SANDBOX: sandbox },
		encoding: "utf8",
	});
	return child.stdout ?? "";
}

test("a second run waits while the lock is held, then acquires it", () => {
	withSandbox((sandbox) => {
		const release = acquireMutationLock(sandbox);
		try {
			expect(existsSync(`${sandbox}.lock`)).toBe(true);
			const output = tryLockRun(sandbox);
			expect(output).toContain("WAITED");
			expect(output).toContain("waiting for the mutation lock");
			expect(output).not.toContain("ACQUIRED");
		} finally {
			release();
			release(); // idempotent
		}
		expect(existsSync(`${sandbox}.lock`)).toBe(false);
		expect(tryLockRun(sandbox)).toContain("ACQUIRED");
	});
});

test("a lock whose holder died is taken over", () => {
	withSandbox((sandbox) => {
		const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		writeFileSync(`${sandbox}.lock`, JSON.stringify({ pid: dead.pid! }));
		const release = acquireMutationLock(sandbox);
		release();
		expect(existsSync(`${sandbox}.lock`)).toBe(false);
	});
});

test("a corrupt lock file is taken over", () => {
	withSandbox((sandbox) => {
		writeFileSync(`${sandbox}.lock`, "");
		const release = acquireMutationLock(sandbox);
		expect(JSON.parse(readFileSync(`${sandbox}.lock`, "utf8"))).toEqual({
			pid: process.pid,
		});
		release();
	});
});

test("isStrykerRun matches Stryker's own entry scripts only", () => {
	expect(isStrykerRun(["node", "/repo/node_modules/.bin/stryker", "run"])).toBe(
		true,
	);
	expect(
		isStrykerRun([
			"node",
			"/repo/node_modules/@stryker-mutator/core/bin/stryker.js",
			"run",
		]),
	).toBe(true);
	expect(
		isStrykerRun(["bun", "/repo/scripts/mutation-delta.ts", "v0.2.0"]),
	).toBe(false);
	expect(isStrykerRun(["bun", "run", "test:mutation"])).toBe(false);
	expect(isStrykerRun(["node", "/repo/scripts/boot-smoke.ts"])).toBe(false);
	expect(isStrykerRun([])).toBe(false);
});

// The delta gate's regression (OTTR-366): the config modules took the mutation lock at
// import time, so a tool that imported them to read `mutate` (scripts/mutation-delta.ts)
// held the lock its own Stryker children then waited for. The config takes the lock only
// under a Stryker-shaped argv now (scripts/stryker-base.mjs gates on isStrykerRun). These tests
// drive the REAL stryker.config.mjs; TMPDIR points into the sandbox, so the config's lock
// path (tmpdir()/ott-stryker) lands inside it and the assertions touch no real lock.
// The child scripts import the config by a runtime-computed absolute file URL (the path
// differs between hosts and the children are separate processes), so a static import
// specifier cannot express it — the same pattern as helperUrl above; they exercise the
// module-loading boundary on purpose.
const configUrl = JSON.stringify(
	new URL("../stryker.config.mjs", import.meta.url).href,
);

function runChild(script: string, env: Record<string, string>): string {
	const child = spawnSync(process.execPath, ["-e", script], {
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
	if (child.status !== 0)
		throw new Error(
			`child failed (${child.status}): ${child.stderr ?? ""}\n${child.stdout ?? ""}`,
		);
	return child.stdout ?? "";
}

test("a plain import of the real config takes no lock", () => {
	withSandbox((sandbox) => {
		const out = runChild(
			`const { existsSync } = await import("node:fs");
			await import(${configUrl});
			if (existsSync(process.env.LOCK_FILE))
				throw new Error("plain import holds the lock: " + (await import("node:fs")).readFileSync(process.env.LOCK_FILE, "utf8"));
			console.log("NO-LOCK");`,
			{
				SANDBOX_ROOT: sandbox.slice(0, sandbox.lastIndexOf("/")),
				LOCK_FILE: `${sandbox}.lock`,
			},
		);
		expect(out).toContain("NO-LOCK");
		expect(existsSync(`${sandbox}.lock`)).toBe(false);
	});
});

test("a Stryker-shaped import of the real config takes and releases the lock", () => {
	withSandbox((sandbox) => {
		const bin = join(
			new URL("..", import.meta.url).pathname,
			"node_modules",
			".bin",
			"stryker",
		);
		const out = runChild(
			`const { readFileSync } = await import("node:fs");
			process.env.TMPDIR = process.env.SANDBOX_ROOT;
			process.argv[1] = process.env.FAKE_BIN;
			await import(${configUrl});
			if (JSON.parse(readFileSync(process.env.LOCK_FILE, "utf8")).pid !== process.pid)
				throw new Error("the run does not hold the lock");
			console.log("TOOK-LOCK");`,
			{
				SANDBOX_ROOT: sandbox.slice(0, sandbox.lastIndexOf("/")),
				LOCK_FILE: `${sandbox}.lock`,
				FAKE_BIN: bin,
			},
		);
		expect(out).toContain("TOOK-LOCK");
		// The exit hook released it: the next run acquires at once.
		expect(tryLockRun(sandbox)).toContain("ACQUIRED");
	});
});

test("a plain importer then a Stryker child: the child takes the lock itself", () => {
	withSandbox((sandbox) => {
		const parent = `const { spawnSync } = await import("node:child_process");
			process.env.TMPDIR = process.env.SANDBOX_ROOT;
			await import(${configUrl});
			const grand = spawnSync(process.execPath, ["-e", ${JSON.stringify(tryLock)}], {
				env: { ...process.env, LOCK_SANDBOX: process.env.LOCK_FILE.replace(/\\.lock$/, "") },
				encoding: "utf8",
			});
			if (!(grand.stdout ?? "").includes("ACQUIRED"))
				throw new Error("grandchild waited on its parent: " + grand.stdout + grand.stderr);
			console.log("PARENT-FREE");`;
		const out = runChild(parent, {
			SANDBOX_ROOT: sandbox.slice(0, sandbox.lastIndexOf("/")),
			LOCK_FILE: `${sandbox}.lock`,
		});
		expect(out).toContain("PARENT-FREE");
	});
});

// OTTR-500: a Stryker run wipes its checkout's sandbox parent first, so a killed run's
// leftover sandbox cannot reach the run; a plain import must touch nothing (it may run
// while another checkout's run is active). The children run with the test runner's cwd,
// so the parent the config wipes is the one computed here from the same root.
function leftoverParent(sandbox: string, name: string): string {
	const root = sandbox.slice(0, sandbox.lastIndexOf("/"));
	const parent = sandboxTempDirName(realpathSync(process.cwd()), root);
	mkdirSync(join(parent, name), { recursive: true });
	return parent;
}

test("a Stryker-shaped import of the real config wipes a leftover sandbox parent", () => {
	withSandbox((sandbox) => {
		const parent = leftoverParent(sandbox, "sandbox-STALE");
		const out = runChild(
			`const { existsSync } = await import("node:fs");
			process.env.TMPDIR = process.env.SANDBOX_ROOT;
			process.argv[1] = process.env.FAKE_BIN;
			await import(${configUrl});
			if (existsSync(process.env.STALE_DIR))
				throw new Error("the run kept a leftover sandbox parent");
			console.log("WIPED");`,
			{
				SANDBOX_ROOT: sandbox.slice(0, sandbox.lastIndexOf("/")),
				STALE_DIR: join(parent, "sandbox-STALE"),
				FAKE_BIN: join(
					new URL("..", import.meta.url).pathname,
					"node_modules",
					".bin",
					"stryker",
				),
			},
		);
		expect(out).toContain("WIPED");
	});
});

test("a plain import of the real config leaves a sandbox parent alone", () => {
	withSandbox((sandbox) => {
		const parent = leftoverParent(sandbox, "sandbox-KEEP");
		const out = runChild(
			`const { existsSync } = await import("node:fs");
			process.env.TMPDIR = process.env.SANDBOX_ROOT;
			await import(${configUrl});
			if (!existsSync(process.env.STALE_DIR))
				throw new Error("a plain import wiped a sandbox parent");
			console.log("KEPT");`,
			{
				SANDBOX_ROOT: sandbox.slice(0, sandbox.lastIndexOf("/")),
				STALE_DIR: join(parent, "sandbox-KEEP"),
			},
		);
		expect(out).toContain("KEPT");
	});
});

// OTTR-886 send-back: a run logs exactly one concurrency line. The children drive the REAL
// configs with a Stryker-shaped argv, so the line prints; the sandbox TMPDIR keeps the lock
// and wipe away from the real host state. These two pin only the wiring (one line per run,
// through the real configs); the line SHAPES are pinned by the concurrencyLogLine tests
// below with fake cgroup files, so they must fail on a regression.
const strykerBin = join(
	new URL("..", import.meta.url).pathname,
	"node_modules",
	".bin",
	"stryker",
);

function concurrencyLines(out: string): string[] {
	return out.split("\n").filter((line) => line.startsWith("stryker-load:"));
}

test("the base config logs exactly one concurrency line for a run", () => {
	withSandbox((sandbox) => {
		const out = runChild(
			`process.env.TMPDIR = process.env.SANDBOX_ROOT;
			process.argv[1] = process.env.FAKE_BIN;
			await import(${configUrl});
			console.log("DONE");`,
			{
				SANDBOX_ROOT: sandbox.slice(0, sandbox.lastIndexOf("/")),
				FAKE_BIN: strykerBin,
			},
		);
		const lines = concurrencyLines(out);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^stryker-load: \d+ slots; /);
		expect(lines[0]).toMatch(/MiB free|free memory unknown/);
		expect(out).toContain("DONE");
	});
});

test("a wrapper config logs one line with its own cap", () => {
	withSandbox((sandbox) => {
		const wrapperUrl = JSON.stringify(
			new URL("../stryker.release.config.mjs", import.meta.url).href,
		);
		const out = runChild(
			`process.env.TMPDIR = process.env.SANDBOX_ROOT;
			process.argv[1] = process.env.FAKE_BIN;
			await import(${wrapperUrl});
			console.log("DONE");`,
			{
				SANDBOX_ROOT: sandbox.slice(0, sandbox.lastIndexOf("/")),
				FAKE_BIN: strykerBin,
			},
		);
		const lines = concurrencyLines(out);
		expect(lines).toHaveLength(1);
		const slots = Number(
			/^stryker-load: (\d+) slots/.exec(lines[0] ?? "")?.[1],
		);
		expect(slots).toBeLessThanOrEqual(8);
		expect(out).toContain("DONE");
	});
});

// The line SHAPES, pinned with fake cgroup files so each assertion must fail on a
// regression. concurrencyLogLine is the exact builder cappedConcurrency prints.
test("the cpu-rule line names the free reading", () => {
	// Free memory far above the cpu rule: the memory rule cannot bind, and the line still
	// carries the MiB figure (the earlier blocker-4 gap).
	withCgroup(String(100 * GIB), String(4 * GIB), (cgroup) => {
		expect(concurrencyLogLine(24, {}, 24, cgroup)).toBe(
			"stryker-load: 12 slots; cpu rule (24 CPUs, 98304 MiB free; memory rule allowed 243)",
		);
	});
	expect(concurrencyLogLine(24, {}, 24, NO_CGROUP)).toBe(
		"stryker-load: 12 slots; cpu rule (24 CPUs, free memory unknown, no cgroup limit)",
	);
});

test("the line names the cap when the cap decides", () => {
	// Wrapper case: cap 8 under the cpu rule 12, memory plentiful.
	withCgroup(String(100 * GIB), String(4 * GIB), (cgroup) => {
		expect(concurrencyLogLine(8, {}, 24, cgroup)).toBe(
			"stryker-load: 8 slots; cpu rule (24 CPUs, 98304 MiB free; memory rule allowed 243) (cap 8 below 12)",
		);
	});
});

test("the memory-rule line shows its readings", () => {
	// The OTTR-886 acceptance case: 8 GiB limit, 4 GiB used, 24 CPUs -> 7 slots.
	withCgroup(String(8 * GIB), String(4 * GIB), (cgroup) => {
		expect(concurrencyLogLine(24, {}, 24, cgroup)).toBe(
			"stryker-load: 7 slots; memory rule (4096 MiB free, 1024 MiB reserve, 400 MiB per slot) beat cpu rule 12",
		);
	});
});

test("STRYKER_CONCURRENCY logs the free reading when one exists", () => {
	withCgroup(String(8 * GIB), String(4 * GIB), (cgroup) => {
		expect(
			concurrencyLogLine(24, { STRYKER_CONCURRENCY: "5" }, 24, cgroup),
		).toBe(
			"stryker-load: 5 slots; STRYKER_CONCURRENCY=5, free memory 4096 MiB",
		);
	});
	expect(
		concurrencyLogLine(24, { STRYKER_CONCURRENCY: "5" }, 24, NO_CGROUP),
	).toBe("stryker-load: 5 slots; STRYKER_CONCURRENCY=5, free memory unknown");
});

// OTTR-1244: the run-end sweep. No test may signal a pid it did not create, so every sweep
// test drives a FAKE /proc tree (plain directories and files under a mkdtempSync dir) with
// a RECORDING kill; production keeps the real /proc and process.kill. The fake self entry
// carries the sandbox path in its cmdline on purpose: the sweep must skip its own caller
// even when the caller's cmdline names the sandbox.
type FakeProc = {
	procRoot: string;
	selfPid: number;
	sandboxDir: string;
	kills: Array<[number, string]>;
	kill: (pid: number, signal: string) => void;
	addEntry: (pid: number, files: { cmdline?: string; stat?: string }) => void;
};

function withFakeProc(selfPgrp: number, run: (proc: FakeProc) => void): void {
	const procRoot = mkdtempSync(join(tmpdir(), "ottr-stryker-proc-"));
	const kills: Array<[number, string]> = [];
	const kill = (pid: number, signal: string): void => {
		kills.push([pid, signal]);
	};
	const selfPid = 424242;
	const sandboxDir = join(procRoot, "ott-stryker-fake");
	const addEntry = (
		pid: number,
		files: { cmdline?: string; stat?: string },
	): void => {
		mkdirSync(join(procRoot, String(pid)), { recursive: true });
		if (files.cmdline !== undefined)
			writeFileSync(join(procRoot, String(pid), "cmdline"), files.cmdline);
		if (files.stat !== undefined)
			writeFileSync(join(procRoot, String(pid), "stat"), files.stat);
	};
	addEntry(selfPid, {
		cmdline: `bun\0-e\0/* ${sandboxDir} */ setInterval(() => {}, 250)\0`,
		stat: `${selfPid} (bun) S 1 ${selfPgrp} ${selfPid} 0`,
	});
	try {
		run({ procRoot, selfPid, sandboxDir, kills, kill, addEntry });
	} finally {
		rmSync(procRoot, { recursive: true, force: true });
	}
}

// stat lines below use the real layout: pid (comm) state ppid pgrp session tty, and the
// sweep takes pgrp from index 2 after the LAST ") ".
const leftoverStat = (pid: number, pgrp: number): string =>
	`${pid} (bun) S 1 ${pgrp} ${pid} 0`;
const leftoverCmdline = (sandboxDir: string): string =>
	`bun\0-e\0/* ${sandboxDir} */ setInterval(() => {}, 250)\0`;

test("the sweep on a clean fake /proc tree kills nothing", () => {
	withFakeProc(
		4100,
		({ procRoot, selfPid, sandboxDir, kills, kill, addEntry }) => {
			addEntry(101, {
				cmdline: "bun\0run\0test:mutation\0",
				stat: leftoverStat(101, 999),
			});
			addEntry(102, {
				cmdline: "some binary --workdir=/tmp/elsewhere",
				stat: leftoverStat(102, 999),
			});
			addEntry(103, { stat: leftoverStat(103, 999) }); // empty cmdline: dead or zombie
			addEntry(104, { cmdline: "" }); // cmdline present but empty
			addEntry(105, { stat: leftoverStat(105, 999) }); // no cmdline file: unreadable
			// A real /proc also holds non-numeric entries; this one carries a matching
			// cmdline so only the numeric-name filter can spare it.
			mkdirSync(join(procRoot, "acpi"), { recursive: true });
			writeFileSync(join(procRoot, "acpi", "cmdline"), sandboxDir);
			const result = sweepSandboxProcesses(sandboxDir, {
				procRoot,
				kill,
				selfPid,
			});
			expect(result).toEqual({ killed: 0, failed: 0 });
			expect(kills).toEqual([]);
		},
	);
});

test("the sweep group-kills a leftover in a foreign group", () => {
	withFakeProc(
		4100,
		({ procRoot, selfPid, sandboxDir, kills, kill, addEntry }) => {
			addEntry(500, {
				cmdline: leftoverCmdline(sandboxDir),
				stat: leftoverStat(500, 4200), // pgrp 4200 differs from the fake self's 4100
			});
			const result = sweepSandboxProcesses(sandboxDir, {
				procRoot,
				kill,
				selfPid,
			});
			expect(kills).toEqual([
				[-4200, "SIGKILL"],
				[500, "SIGKILL"],
			]);
			expect(result).toEqual({ killed: 1, failed: 0 });
		},
	);
});

test("the sweep never signals its own group for a matching pid", () => {
	withFakeProc(
		4100,
		({ procRoot, selfPid, sandboxDir, kills, kill, addEntry }) => {
			addEntry(501, {
				cmdline: leftoverCmdline(sandboxDir),
				stat: leftoverStat(501, 4100), // same group as the fake self
			});
			const result = sweepSandboxProcesses(sandboxDir, {
				procRoot,
				kill,
				selfPid,
			});
			// Only the single pid: never -4100, the own group.
			expect(kills).toEqual([[501, "SIGKILL"]]);
			expect(result).toEqual({ killed: 1, failed: 0 });
		},
	);
});

test("a failed group kill is counted and the pid kill still runs", () => {
	withFakeProc(4100, ({ procRoot, selfPid, sandboxDir, addEntry }) => {
		addEntry(502, {
			cmdline: leftoverCmdline(sandboxDir),
			stat: leftoverStat(502, 4200),
		});
		const pidKills: Array<[number, string]> = [];
		const kill = (pid: number, signal: string): void => {
			if (pid < 0) throw new Error("group kill failed"); // an EPERM on -pgrp
			pidKills.push([pid, signal]);
		};
		const result = sweepSandboxProcesses(sandboxDir, {
			procRoot,
			kill,
			selfPid,
		});
		expect(pidKills).toEqual([[502, "SIGKILL"]]); // the pid kill still attempted
		expect(result).toEqual({ killed: 0, failed: 1 }); // counted, not thrown
	});
});

test("a matching pid with an unreadable stat is killed by pid alone", () => {
	withFakeProc(
		4100,
		({ procRoot, selfPid, sandboxDir, kills, kill, addEntry }) => {
			addEntry(503, {
				cmdline: leftoverCmdline(sandboxDir),
				// no stat file: the group cannot be read, so it is never guessed
			});
			const result = sweepSandboxProcesses(sandboxDir, {
				procRoot,
				kill,
				selfPid,
			});
			expect(kills).toEqual([[503, "SIGKILL"]]);
			expect(result).toEqual({ killed: 1, failed: 0 });
		},
	);
});

// The live proof that the real /proc path works: a real child whose cmdline embeds the
// sandbox dir, the production procRoot, but still only the RECORDING kill. The one real
// signal of this test is the finally block's, and it targets the child the test itself
// spawned (the child shares the caller's process group, so -child.pid names no group and
// the child's own pid is the fallback). Reading /proc is reader-only throughout.
test("the live sweep finds a real leftover child through the real /proc", async () => {
	const sandboxDir = mkdtempSync(join(tmpdir(), "ottr-stryker-sweep-"));
	const child = Bun.spawn([
		process.execPath,
		"-e",
		`/* ${sandboxDir} */ setInterval(() => {}, 250)`,
	]);
	const kills: Array<[number, string]> = [];
	const kill = (pid: number, signal: string): void => {
		kills.push([pid, signal]);
	};
	try {
		// /proc/<pid>/cmdline is empty until the child has execed; poll for the tag.
		let visible = false;
		for (let waited = 0; waited < 2000 && !visible; waited += 25) {
			try {
				visible = readFileSync(`/proc/${child.pid}/cmdline`, "utf8").includes(
					sandboxDir,
				);
			} catch {
				// not execed yet
			}
			if (!visible) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(visible).toBe(true);
		const pgrpOf = (pid: number): number => {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2]);
		};
		const childPgrp = pgrpOf(child.pid);
		const ownPgrp = pgrpOf(process.pid);
		const result = sweepSandboxProcesses(sandboxDir, { kill });
		// Own group -> the single pid; a foreign group -> the group and the pid.
		const expected: Array<[number, string]> =
			childPgrp === ownPgrp
				? [[child.pid, "SIGKILL"]]
				: [
						[-childPgrp, "SIGKILL"],
						[child.pid, "SIGKILL"],
					];
		expect(kills).toEqual(expected);
		expect(result).toEqual({ killed: 1, failed: 0 });
		// The sweep never matched the test process itself.
		expect(kills.some(([target]) => target === process.pid)).toBe(false);
	} finally {
		// The only real signals: to the child the test created.
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			process.kill(child.pid, "SIGKILL");
		}
		await child.exited;
		rmSync(sandboxDir, { recursive: true, force: true });
	}
});

// OTTR-1244: the run-end hook. A Stryker-shaped import registers a process exit hook that
// sweeps this checkout's sandbox parent and always prints the line — a normal run reports
// zero leftovers. A plain import must register nothing (OTTR-366 invariant: a config
// import that only reads the mutate arrays takes no lock and starts no sweep). The
// children drive the REAL config with TMPDIR inside the sandbox, so the sweep's target
// path is unique to this test run and no process on the host names it — the child's own
// exit sweep cannot signal a pid the test did not create.
test("the run-end hook sweeps the sandbox and reports zero leftovers", () => {
	withSandbox((sandbox) => {
		const out = runChild(
			`process.env.TMPDIR = process.env.SANDBOX_ROOT;
			process.argv[1] = process.env.FAKE_BIN;
			await import(${configUrl});
			console.log("DONE");`,
			{
				SANDBOX_ROOT: sandbox.slice(0, sandbox.lastIndexOf("/")),
				FAKE_BIN: strykerBin,
			},
		);
		expect(out).toContain("sandbox sweep: killed 0 leftover process(es)");
		expect(out).toContain("0 kill attempt(s) failed");
		expect(out).toContain("DONE");
	});
});

test("a plain import registers no sweep hook", () => {
	withSandbox((sandbox) => {
		const out = runChild(
			`await import(${configUrl});
			console.log("DONE");`,
			{
				SANDBOX_ROOT: sandbox.slice(0, sandbox.lastIndexOf("/")),
			},
		);
		expect(out).not.toContain("sandbox sweep");
		expect(out).toContain("DONE");
	});
});

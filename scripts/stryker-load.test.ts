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
	isStrykerRun,
	mutationConcurrency,
	sandboxTempDirName,
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
// under a Stryker-shaped argv now (stryker.config.mjs gates on isStrykerRun). These tests
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

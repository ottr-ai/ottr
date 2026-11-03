import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireMutationLock,
	isStrykerRun,
	mutationConcurrency,
} from "./stryker-load.mjs";

test("mutationConcurrency is half of the CPUs, at least 1", () => {
	expect(mutationConcurrency({}, 24)).toBe(12);
	expect(mutationConcurrency({}, 25)).toBe(12);
	expect(mutationConcurrency({}, 2)).toBe(1);
	expect(mutationConcurrency({}, 1)).toBe(1);
	for (let cpus = 1; cpus <= 64; cpus++) {
		expect(mutationConcurrency({}, cpus)).toBe(
			Math.max(1, Math.floor(cpus / 2)),
		);
	}
});

test("STRYKER_CONCURRENCY overrides the CPU value when set", () => {
	expect(mutationConcurrency({ STRYKER_CONCURRENCY: "5" }, 24)).toBe(5);
	expect(mutationConcurrency({ STRYKER_CONCURRENCY: "3" }, 2)).toBe(3);
	expect(mutationConcurrency({ STRYKER_CONCURRENCY: "" }, 24)).toBe(12);
});

test("STRYKER_CONCURRENCY rejects values below 1 and non-integers", () => {
	expect(() => mutationConcurrency({ STRYKER_CONCURRENCY: "0" })).toThrow();
	expect(() => mutationConcurrency({ STRYKER_CONCURRENCY: "-3" })).toThrow();
	expect(() => mutationConcurrency({ STRYKER_CONCURRENCY: "2.5" })).toThrow();
	expect(() => mutationConcurrency({ STRYKER_CONCURRENCY: "abc" })).toThrow();
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

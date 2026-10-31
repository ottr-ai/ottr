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
import { acquireMutationLock, mutationConcurrency } from "./stryker-load.mjs";

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

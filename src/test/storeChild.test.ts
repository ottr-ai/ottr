import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StoreChildHandle, spawnStoreChild } from "./storeChild.ts";

const isWindows = process.platform === "win32";

// The inner parent run of the real-timeout acceptance test is a separate process: it
// imports the helper by a runtime-computed absolute file URL (the path differs between
// hosts), the same pattern as the config-url imports in scripts/stryker-load.test.ts.
const helperUrl = new URL("./storeChild.ts", import.meta.url).href;

// A child that records the grandchild pid and then burns the JavaScript thread forever:
// a synchronous loop never turns the event loop, so no timer inside this process can
// ever fire. Only an outside supervisor or a group kill can clean this child up.
const spinWithGrandchild = `
import { writeFileSync } from "node:fs";
const grand = Bun.spawn(
	[process.execPath, "-e", "setInterval(() => {}, 250)"],
	{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
);
writeFileSync(process.env.GRAND_PID_FILE!, String(grand.pid));
for (;;) {}
`;

// The two pollers below run on the platform clock on purpose: the awaited condition is
// process death and reparenting, which fake timers cannot drive. Each poll probes real OS
// state (`kill(pid, 0)` ESRCH, pid file content) and each helper carries a hard failure
// bound, so a stuck child fails the test fast instead of hanging it.
/** Polls `process.kill(pid, 0)` until every pid throws ESRCH, bounded by `limitMs`. */
async function assertAllDead(pids: number[], limitMs: number): Promise<void> {
	const deadline = Date.now() + limitMs;
	const pending = new Set(pids);
	while (pending.size > 0) {
		for (const pid of pending) {
			try {
				process.kill(pid, 0);
			} catch {
				pending.delete(pid);
			}
		}
		if (pending.size === 0) return;
		if (Date.now() > deadline) {
			throw new Error(
				`pids still alive after ${limitMs}ms: ${[...pending].join(", ")}`,
			);
		}
		await Bun.sleep(25);
	}
}

/** Polls the grandchild-pid file the child writes, bounded by `limitMs`. */
async function readGrandPid(file: string, limitMs = 5000): Promise<number> {
	const deadline = Date.now() + limitMs;
	for (;;) {
		const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
		const pid = Number(text);
		if (Number.isInteger(pid) && pid > 1) return pid;
		if (Date.now() > deadline) {
			throw new Error(`grandchild pid never landed in ${file}`);
		}
		await Bun.sleep(25);
	}
}

describe("spawnStoreChild", () => {
	test.skipIf(isWindows)(
		"killGroup() kills the child's whole group, including the child's own grandchild",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "store-child-"));
			let handle: StoreChildHandle | undefined;
			try {
				const pidFile = join(dir, "grand-pid");
				handle = spawnStoreChild({
					script: spinWithGrandchild,
					env: { GRAND_PID_FILE: pidFile },
				});
				const grandPid = await readGrandPid(pidFile);
				handle.killGroup(); // the same call the teardown/timeout path makes
				await handle.exited;
				// Both pids were created by this test: the child via the helper, the
				// grandchild by the child script.
				await assertAllDead([handle.pid, grandPid], 5000);
			} finally {
				handle?.killGroup(); // a failed test must not leak its own child
				rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
			}
		},
	);

	test.skipIf(isWindows)(
		// Fast mechanism pin for the same fault the real-timeout test below proves: the
		// child hard-spins a synchronous loop (no timer inside it can ever fire) and the
		// supervisor's baseline parent is a dead probe, so the supervisor must kill it
		// within a few seconds; an in-child watchdog cannot, which is the failure this
		// test pins without paying for a second parent process.
		"the supervisor group-kills a sync-spinning child and its grandchild when the baseline parent is gone",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "store-child-"));
			let handle: StoreChildHandle | undefined;
			try {
				const pidFile = join(dir, "grand-pid");
				// A short-lived probe whose pid can never match the runner's ppid.
				const probe = Bun.spawn(
					[process.execPath, "-e", "await Bun.sleep(300)"],
					{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
				);
				await probe.exited;
				handle = spawnStoreChild({
					script: spinWithGrandchild,
					env: { GRAND_PID_FILE: pidFile },
					parentPid: probe.pid, // the dead probe is the supervisor's baseline
					watchdogMs: 100,
				});
				const grandPid = await readGrandPid(pidFile);
				// The child dies BY the supervisor's SIGKILL: Bun reports the signal death
				// as 137 (128 + 9). Any other code means the supervisor did not fire; NaN
				// means the child never exited at all.
				const code = await Promise.race([
					handle.exited,
					Bun.sleep(3000).then(() => Number.NaN),
				]);
				expect(code).toBe(137);
				await assertAllDead([handle.pid, grandPid], 3000);
			} finally {
				handle?.killGroup(); // a failed test must not leak its own child
				rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
			}
		},
	);

	test.skipIf(isWindows)(
		// THE OTTR-1244 acceptance test with the default parentPid: an inner parent run
		// spawns the store child through the helper with no injected pid (its own pid is the
		// supervisor's baseline), then a timeout ends that parent run the way a runner's
		// timeout kill ends a hung test run (SIGKILL). The child hard-spins a synchronous
		// loop, so nothing inside it can clean itself up; the supervisor must have the child
		// and its grandchild gone within a few seconds, and leave no helper process behind.
		"the real parent run ending by timeout leaves the sync-spinning child gone within seconds",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "store-child-"));
			const pidFile = join(dir, "grand-pid");
			const statusFile = join(dir, "status.json");
			// The inner parent run: it spawns the child (default parentPid), reports the
			// helper's pids, and stays alive until the outer timeout ends it.
			const innerRun = `
import { writeFileSync } from "node:fs";
import { spawnStoreChild } from ${JSON.stringify(helperUrl)};
const handle = spawnStoreChild({
	script: ${JSON.stringify(spinWithGrandchild)},
	env: { GRAND_PID_FILE: process.env.GRAND_PID_FILE },
});
writeFileSync(process.env.STATUS_FILE, JSON.stringify({ child: handle.pid, supervisor: handle.supervisor.pid }));
setInterval(() => {}, 250);
`;
			const parent = Bun.spawn([process.execPath, "-e", innerRun], {
				env: {
					...process.env,
					GRAND_PID_FILE: pidFile,
					STATUS_FILE: statusFile,
				},
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			let pids: { child: number; supervisor: number } | undefined;
			try {
				// Wait until the inner run has spawned the child (its own pid is the
				// supervisor's baseline — nothing is injected) and the child spawned the
				// grandchild whose pid the pid file now holds.
				const deadline = Date.now() + 5000;
				while (pids === undefined) {
					try {
						pids = JSON.parse(readFileSync(statusFile, "utf8"));
					} catch {
						// not written yet
					}
					if (pids === undefined) {
						if (Date.now() > deadline)
							throw new Error("inner run never reported its pids");
						await Bun.sleep(25);
					}
				}
				const grandPid = await readGrandPid(pidFile);
				// The timeout that ends the parent run: SIGKILL, the shape of a runner's
				// per-test timeout kill. After it, only the supervisor can clean up.
				parent.kill(9);
				await parent.exited;
				await assertAllDead([pids.child, pids.supervisor, grandPid], 3000);
			} finally {
				// Best effort: a failed test must not leak the parent run or its helper
				// processes. Every pid below was created by this test.
				parent.kill(9);
				for (const pid of [pids?.child, pids?.supervisor]) {
					if (pid === undefined) continue;
					try {
						process.kill(-pid, "SIGKILL");
					} catch {}
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
				rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
			}
		},
	);

	test("normal completion exits 0, surfaces stdout, and leaves no process behind", async () => {
		const handle = spawnStoreChild({
			script: `process.stdout.write("ok"); process.exit(0);`,
			stdio: ["inherit", "pipe", "inherit"],
		});
		expect(await handle.exited).toBe(0);
		expect(
			await new Response(
				handle.child.stdout as ReadableStream<Uint8Array>,
			).text(),
		).toBe("ok");
		// The supervisor notices the child is gone and exits within one poll tick; NaN
		// would mean it leaked.
		const supervisorCode = await Promise.race([
			handle.supervisorExited,
			Bun.sleep(2000).then(() => Number.NaN),
		]);
		expect(supervisorCode).toBe(0);
		await assertAllDead([handle.pid], 2000);
	});
});

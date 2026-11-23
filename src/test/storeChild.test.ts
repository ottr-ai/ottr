import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StoreChildHandle, spawnStoreChild } from "./storeChild.ts";

const isWindows = process.platform === "win32";

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
		// THE OTTR-1244 acceptance test: the child hard-spins a synchronous loop (no timer
		// inside it can ever fire), and the parent run it belongs to ends by timeout — the
		// dead probe's pid is the supervisor's baseline, so from the supervisor's view the
		// parent is gone at once. The outside supervisor must kill the child within a few
		// seconds; an in-child watchdog cannot, which is the failure this test pins.
		"the supervisor group-kills a sync-spinning child and its grandchild when the parent run ends",
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

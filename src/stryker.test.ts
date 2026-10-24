import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "./platform/index.ts";
import { mutateStatus, runProgress, strykerStatus } from "./stryker.ts";

const line = (
	pct: number,
	left: string,
	tested: number,
	survived = 38,
	timedOut = 0,
): string =>
	`Mutation testing ${pct}% (elapsed: ~2h 59m, remaining: ${left}) ${tested}/6523 tested (${survived} survived${timedOut > 0 ? `, ${timedOut} timed out` : ""})\n`;

test("strykerStatus reads the newest progress line", () => {
	const log = `INFO Initial test run succeeded.\n${line(67, "~1h 30m", 4400)}${line(68, "~1h 23m", 4454)}`;
	expect(strykerStatus(log)).toBe(
		"Stryker 68% · 4454/6523 · 38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left",
	);
});

test("strykerStatus rate rounding and omitted segments", () => {
	// 12/900 = 1.333…% → 1.3%
	expect(strykerStatus(line(42, "~8m", 900, 12, 2))).toBe(
		"Stryker 42% · 900/6523 · 12 survived (1.3%) · 2 timed out · ~2h 59m elapsed · ~8m left",
	);
	// tested 0: no rate segment
	expect(strykerStatus(line(0, "n/a", 0, 0))).toBe(
		"Stryker 0% · 0/6523 · ~2h 59m elapsed",
	);
	// no progress line at all
	expect(strykerStatus("INFO Initial test run succeeded.\n")).toBeNull();
});

const mline = (
	n: number,
	total: number,
	status: string,
	count?: number,
): string =>
	`[${n}/${total}] clipshelf/lib.py:89 str->+"x" ${status} 42.3s${count !== undefined ? ` (${count} survived)` : ""}\n`;

test("mutateStatus reads the newest progress line", () => {
	const log = `pytest starting\n${mline(19, 116, "KILLED", 1)}${mline(20, 116, "SURVIVED", 2)}`;
	expect(mutateStatus(log)).toBe("mutate.py 17% · 20/116 · 2 survived (10.0%)");
});

test("mutateStatus variants", () => {
	// no count segment
	expect(mutateStatus(mline(20, 116, "SURVIVED"))).toBe(
		"mutate.py 17% · 20/116",
	);
	// 1/3 = 33.333…% → 33.3%
	expect(mutateStatus(mline(3, 116, "KILLED", 1))).toBe(
		"mutate.py 2% · 3/116 · 1 survived (33.3%)",
	);
	// TIMEOUT parses too
	expect(mutateStatus(mline(4, 116, "TIMEOUT"))).toBe("mutate.py 3% · 4/116");
	// pytest-like noise after the last progress line does not win
	expect(
		mutateStatus(`${mline(20, 116, "SURVIVED")}FAILED tests/test_x.py\n`),
	).toBe("mutate.py 17% · 20/116");
	// no progress line at all
	expect(mutateStatus("pytest starting\n")).toBeNull();
});

const kids: ChildProcess[] = [];
afterEach(() => {
	for (const k of kids.splice(0)) if (k.pid) platform.killTree(k.pid);
});

test.skipIf(process.platform !== "linux")(
	"runProgress finds Stryker under the root: numbers from a log file, none from a pipe",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "ott-stryker-"));
		try {
			// A stand-in named stryker; `; true` keeps the outer sh as the root instead of exec'ing it away.
			const script = join(dir, "stryker");
			writeFileSync(script, "sleep 30; true\n");
			const log = join(dir, "run.log");
			writeFileSync(log, line(68, "~1h 23m", 4454));
			const fd = openSync(log, "a");
			const cmd = ["-c", `sh '${script}' run; true`];
			const toFile = spawn("sh", cmd, { stdio: ["ignore", fd, "ignore"] });
			// Under Node, Stryker's bin sets process.title = "stryker": its cmdline is then the
			// bare name, with no "run" after it.
			const titled = spawn(
				"sh",
				["-c", "bash -c 'exec -a stryker sleep 30'; true"],
				{ stdio: ["ignore", fd, "ignore"] },
			);
			closeSync(fd);
			const toPipe = spawn("sh", cmd, { stdio: ["ignore", "pipe", "ignore"] });
			const idle = spawn("sleep", ["30"]);
			kids.push(toFile, titled, toPipe, idle);
			const settled = async (pid: number): Promise<string | null> => {
				for (let i = 0; i < 100; i++) {
					const status = runProgress(pid);
					if (status !== null) return status;
					await Bun.sleep(20);
				}
				return null;
			};
			expect(await settled(toFile.pid ?? -1)).toBe(
				"Stryker 68% · 4454/6523 · 38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left",
			);
			expect(await settled(titled.pid ?? -1)).toBe(
				"Stryker 68% · 4454/6523 · 38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left",
			);
			expect(await settled(toPipe.pid ?? -1)).toBe("Stryker running");
			expect(runProgress(idle.pid ?? -1)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform !== "linux")(
	"runProgress keeps the numbers once the final summary pushes the last progress line out of a 16 KiB tail",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "ott-stryker-tail-"));
		try {
			const script = join(dir, "stryker");
			writeFileSync(script, "sleep 30; true\n");
			// One progress line, then a final summary larger than the old 16 KiB read window
			// (alate's end-of-run survivor list once hid the line and the card dropped to
			// bare "Stryker running" while the process lived on).
			const log = join(dir, "run.log");
			writeFileSync(
				log,
				`${line(99, "<1m", 2417, 207, 49)}[Survived] CallExpression\nserver.ts:465:1\n-   timer.unref()\n+   ;\n`.repeat(
					800,
				),
			);
			const fd = openSync(log, "a");
			const proc = spawn("sh", ["-c", `sh '${script}' run; true`], {
				stdio: ["ignore", fd, "ignore"],
			});
			closeSync(fd);
			kids.push(proc);
			// Real backoff, not fake timers: the awaited condition is /proc visibility of a spawned
			// process, which exposes no awaitable signal to poll deterministically.
			for (let i = 0; i < 100; i++) {
				const status = runProgress(proc.pid ?? -1);
				if (status !== null) {
					expect(status).toBe(
						"Stryker 99% · 2417/6523 · 207 survived (8.6%) · 49 timed out · ~2h 59m elapsed · <1m left",
					);
					return;
				}
				await Bun.sleep(20);
			}
			throw new Error("no progress status within the poll window");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform !== "linux")(
	"runProgress finds mutate.py under the root: numbers from a log file, none from a pipe",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "ott-mutate-"));
		try {
			// A stand-in named mutate.py; `; true` keeps the outer sh as the root instead of exec'ing it away.
			const script = join(dir, "mutate.py");
			writeFileSync(script, "sleep 30; true\n");
			const log = join(dir, "run.log");
			writeFileSync(log, mline(20, 116, "SURVIVED", 2));
			const fd = openSync(log, "a");
			const cmd = ["-c", `sh '${script}' --max-mutants 116; true`];
			const toFile = spawn("sh", cmd, { stdio: ["ignore", fd, "ignore"] });
			closeSync(fd);
			const toPipe = spawn("sh", cmd, { stdio: ["ignore", "pipe", "ignore"] });
			kids.push(toFile, toPipe);
			// Real backoff, not fake timers: the awaited condition is /proc visibility of spawned
			// processes, which exposes no awaitable signal to poll deterministically.
			const settled = async (pid: number): Promise<string | null> => {
				for (let i = 0; i < 100; i++) {
					const status = runProgress(pid);
					if (status !== null) return status;
					await Bun.sleep(20);
				}
				return null;
			};
			expect(await settled(toFile.pid ?? -1)).toBe(
				"mutate.py 17% · 20/116 · 2 survived (10.0%)",
			);
			expect(await settled(toPipe.pid ?? -1)).toBe("mutate.py running");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform !== "linux" || Bun.which("node") === null)(
	"the tap gives a Node Stryker run with a piped stdout its numbers, and skips other processes",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "ott-tap-"));
		// The image's form: NODE_OPTIONS, not a --require argument.
		const tap = join(import.meta.dir, "stryker-tap.cjs");
		const env = { ...process.env, NODE_OPTIONS: `--require=${tap}` };
		let copy = "";
		try {
			// A stand-in Stryker bin: one progress line, then it runs until its stdin ends.
			const bin = join(dir, "stryker.js");
			writeFileSync(
				bin,
				`process.stdout.write(${JSON.stringify(line(68, "~1h 23m", 4454))});\nprocess.stdin.resume().on("end", () => process.exit(0));\n`,
			);
			const run = spawn("node", [bin, "run"], {
				env,
				stdio: ["pipe", "pipe", "ignore"],
			});
			const other = spawn(
				"node",
				["-e", "console.log('up'); setTimeout(() => {}, 30_000)"],
				{ env, stdio: ["ignore", "pipe", "ignore"] },
			);
			kids.push(run, other);
			copy = `/tmp/ottr-stryker-${run.pid}.log`;
			let piped = "";
			run.stdout?.on("data", (b: Buffer) => {
				piped += b.toString();
			});
			let otherOut = "";
			other.stdout?.on("data", (b: Buffer) => {
				otherOut += b.toString();
			});
			let status: string | null = null;
			for (let i = 0; i < 250 && !status?.includes("%"); i++) {
				status = runProgress(run.pid ?? -1);
				await Bun.sleep(20);
			}
			expect(status).toBe(
				"Stryker 68% · 4454/6523 · 38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left",
			);
			for (let i = 0; i < 250 && !otherOut.includes("up"); i++)
				await Bun.sleep(20);
			expect(otherOut).toContain("up");
			expect(existsSync(`/tmp/ottr-stryker-${other.pid}.log`)).toBe(false);
			// The run's own reader still gets every byte, and a normal exit removes the copy.
			run.stdin?.end();
			await once(run, "close");
			expect(piped).toBe(line(68, "~1h 23m", 4454));
			expect(existsSync(copy)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			if (copy !== "") rmSync(copy, { force: true });
		}
	},
);

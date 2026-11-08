import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import {
	counterGrowth,
	cpuPercent,
	createSystemSampler,
	fetchWorkerStats,
	HOUR_MS,
	keepWindow,
	type LiveRun,
	MUTATION_LOCK_PATH,
	parseCgroupReading,
	pushRing,
	readCgroup,
	readRunUsage,
	readVm,
	rowWarnings,
	type VmReading,
	vmCpuPercent,
} from "./systemStats.ts";
import type {
	CgroupReading,
	RunUsage,
	SystemHolds,
	SystemPoint,
} from "./types.ts";

const dir = mkdtempSync(join(tmpdir(), "ottr-system-"));
/** Stops the test servers: a callback, so the list holds any Bun.serve server type. */
const stops: (() => void)[] = [];
afterAll(() => {
	for (const stop of stops) stop();
	rmSync(dir, { recursive: true, force: true });
});

let rootN = 0;
/** A fake cgroup (or /proc) directory holding `files`. */
function fakeRoot(files: Record<string, string>): string {
	const root = join(dir, `root-${rootN++}`);
	mkdirSync(root, { recursive: true });
	for (const [name, text] of Object.entries(files))
		writeFileSync(join(root, name), text);
	return root;
}

let procN = 0;
/** A fake /proc: `<pid>/stat` with the comm, ppid and the utime, stime, cutime and cstime
 *  ticks at their real field positions, plus `<pid>/smaps_rollup` unless pssKb is null. */
function fakeProc(
	procs: {
		pid: number;
		ppid: number;
		comm?: string;
		ticks: [number, number, number, number];
		pssKb: number | null;
	}[],
): string {
	const root = join(dir, `proc-${procN++}`);
	for (const p of procs) {
		const pidDir = join(root, String(p.pid));
		mkdirSync(pidDir, { recursive: true });
		const [utime, stime, cutime, cstime] = p.ticks;
		writeFileSync(
			join(pidDir, "stat"),
			`${p.pid} (${p.comm ?? "bun"}) S ${p.ppid} 1 1 0 -1 4194560 100 0 0 0 ${utime} ${stime} ${cutime} ${cstime} 20 0 1 0 100 1000 50\n`,
		);
		if (p.pssKb !== null)
			writeFileSync(
				join(pidDir, "smaps_rollup"),
				`55d0-7ffe ---p 00000000 00:00 0 [rollup]\nRss: ${p.pssKb * 2} kB\nPss: ${p.pssKb} kB\nPss_Anon: 7 kB\nPss_File: 9 kB\n`,
			);
	}
	return root;
}

const NO_LOCK = join(dir, "no-such.lock");

const reading = (over: Partial<CgroupReading> = {}): CgroupReading => ({
	at: 0,
	cpuUsageUsec: null,
	cpuMax: null,
	memoryCurrent: null,
	memoryMax: null,
	memoryEvents: null,
	lock: { exists: false, pid: null, alive: false },
	runs: [],
	...over,
});

const vmAt = (at: number, over: Partial<VmReading> = {}): VmReading => ({
	at,
	cpuTicks: null,
	load1: null,
	memAvailable: null,
	memTotal: null,
	cpus: 4,
	...over,
});

const HOLDS: SystemHolds = {
	drainUntil: null,
	drainCommits: null,
	maxTotal: null,
	running: 0,
	queued: 0,
	oldestQueuedAt: null,
};

const TICK = 30_000;

describe("readCgroup", () => {
	test("parses every cgroup v2 file", () => {
		const root = fakeRoot({
			"cpu.stat": "usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n",
			"cpu.max": "200000 100000\n",
			"memory.current": "52428800\n",
			"memory.stat":
				"anon 1000\nfile 30000000\ninactive_file 20000000\nactive_file 10000000\n",
			"memory.max": "1073741824\n",
			"memory.events": "low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\n",
		});
		expect(readCgroup({ root, lockPath: NO_LOCK, now: 42 })).toEqual({
			at: 42,
			cpuUsageUsec: 123456,
			cpuMax: { quotaUsec: 200000, periodUsec: 100000 },
			memoryCurrent: 52428800,
			memoryMax: 1073741824,
			memoryEvents: { max: 12, oom: 3, oomKill: 2 },
			lock: { exists: false, pid: null, alive: false },
			runs: [],
		});
	});

	test('max values stay "max"', () => {
		const root = fakeRoot({ "cpu.max": "max 100000\n", "memory.max": "max\n" });
		const r = readCgroup({ root, lockPath: NO_LOCK });
		expect(r.cpuMax).toBe("max");
		expect(r.memoryMax).toBe("max");
	});

	test("memory.current stays raw: page cache in memory.stat counts against the limit", () => {
		const root = fakeRoot({
			"memory.current": "950\n",
			"memory.stat": "anon 700\nfile 250\ninactive_file 200\n",
			"memory.max": "1000\n",
		});
		expect(readCgroup({ root, lockPath: NO_LOCK }).memoryCurrent).toBe(950);
	});

	test("missing files (cgroup v1) read as null", () => {
		const r = readCgroup({ root: fakeRoot({}), lockPath: NO_LOCK, now: 7 });
		expect(r).toEqual({
			at: 7,
			cpuUsageUsec: null,
			cpuMax: null,
			memoryCurrent: null,
			memoryMax: null,
			memoryEvents: null,
			lock: { exists: false, pid: null, alive: false },
			runs: [],
		});
	});

	test("garbled files read as null", () => {
		const root = fakeRoot({
			"cpu.stat": "user_usec 5\n",
			"cpu.max": "lots\n",
			"memory.current": "12abc\n",
			"memory.max": "-1\n",
			"memory.events": "max 1\noom 0\n",
		});
		const r = readCgroup({ root, lockPath: NO_LOCK });
		expect(r.cpuUsageUsec).toBeNull();
		expect(r.cpuMax).toBeNull();
		expect(r.memoryCurrent).toBeNull();
		expect(r.memoryMax).toBeNull();
		expect(r.memoryEvents).toBeNull();
	});

	test("a lock held by a live pid is alive", () => {
		const lockPath = join(dir, "live.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
		expect(readCgroup({ root: fakeRoot({}), lockPath }).lock).toEqual({
			exists: true,
			pid: process.pid,
			alive: true,
		});
	});

	test("a lock left by a dead pid is not alive", () => {
		const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		const lockPath = join(dir, "dead.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: dead.pid! }));
		expect(readCgroup({ root: fakeRoot({}), lockPath }).lock).toEqual({
			exists: true,
			pid: dead.pid!,
			alive: false,
		});
	});

	test("an unparsable lock exists without a pid", () => {
		const lockPath = join(dir, "garbled.lock");
		writeFileSync(lockPath, "");
		expect(readCgroup({ root: fakeRoot({}), lockPath }).lock).toEqual({
			exists: true,
			pid: null,
			alive: false,
		});
	});

	test("the default lock is the one scripts/stryker-load.mjs creates", () => {
		expect(MUTATION_LOCK_PATH).toBe(join(tmpdir(), "ott-stryker.lock"));
	});
});

describe("readRunUsage", () => {
	// Run r1 is the tree 100 → 101 → 102; run r2 is 200 alone; 300 belongs to no run.
	const tree = () =>
		fakeProc([
			// comm may hold ") (": the fields start after the last ")".
			{ pid: 100, ppid: 1, comm: "omp) (x", ticks: [5, 3, 2, 1], pssKb: 1000 },
			{ pid: 101, ppid: 100, ticks: [10, 0, 0, 0], pssKb: 2000 },
			// Its smaps_rollup is unreadable: no memory, but its CPU still counts.
			{ pid: 102, ppid: 101, ticks: [1, 1, 0, 0], pssKb: null },
			{ pid: 200, ppid: 1, ticks: [4, 0, 0, 0], pssKb: 50 },
			{ pid: 300, ppid: 1, ticks: [99, 99, 99, 99], pssKb: 9999 },
		]);

	test("sums each run's own tree: Pss memory and CPU with the waited-for children", () => {
		const procRoot = tree();
		expect(
			readRunUsage(
				[
					{ id: "r1", pid: 100 },
					{ id: "r2", pid: 200 },
				],
				procRoot,
			),
		).toEqual([
			// (5+3+2+1) + 10 + (1+1) ticks of 10 000 µs.
			{ id: "r1", memBytes: 3000 * 1024, cpuUsec: 230_000 },
			{ id: "r2", memBytes: 50 * 1024, cpuUsec: 40_000 },
		]);
		// A subtree root counts only its own descendants.
		expect(readRunUsage([{ id: "sub", pid: 101 }], procRoot)).toEqual([
			{ id: "sub", memBytes: 2000 * 1024, cpuUsec: 120_000 },
		]);
	});

	test("a run whose root pid is gone is left out; a missing /proc gives []", () => {
		expect(
			readRunUsage(
				[
					{ id: "gone", pid: 555 },
					{ id: "r2", pid: 200 },
				],
				tree(),
			),
		).toEqual([{ id: "r2", memBytes: 50 * 1024, cpuUsec: 40_000 }]);
		expect(
			readRunUsage([{ id: "r1", pid: 100 }], join(dir, "no-such-proc")),
		).toEqual([]);
	});

	test("readCgroup reports the runs it is given, and none without them", () => {
		const procRoot = tree();
		const root = fakeRoot({});
		expect(
			readCgroup({
				root,
				lockPath: NO_LOCK,
				runs: [{ id: "r2", pid: 200 }],
				procRoot,
			}).runs,
		).toEqual([{ id: "r2", memBytes: 50 * 1024, cpuUsec: 40_000 }]);
		expect(readCgroup({ root, lockPath: NO_LOCK, procRoot }).runs).toEqual([]);
	});
});

describe("readVm", () => {
	test("reads /proc/stat, /proc/loadavg and /proc/meminfo", () => {
		const procRoot = fakeRoot({
			stat: "cpu  100 5 50 800 20 3 2 0 7 0\ncpu0 50 2 25 400 10 1 1 0 0 0\n",
			loadavg: "1.25 0.80 0.50 2/300 4242\n",
			meminfo:
				"MemTotal:       16000 kB\nMemFree:         2000 kB\nMemAvailable:    6000 kB\n",
		});
		expect(readVm({ procRoot, now: 5 })).toEqual({
			at: 5,
			// idle = 800 + 20; total = user … steal (guest is inside user already).
			cpuTicks: { idle: 820, total: 980 },
			load1: 1.25,
			memAvailable: 6000 * 1024,
			memTotal: 16000 * 1024,
			cpus: availableParallelism(),
		});
	});

	test("missing /proc files read as null", () => {
		const r = readVm({ procRoot: fakeRoot({}), now: 1 });
		expect(r.cpuTicks).toBeNull();
		expect(r.load1).toBeNull();
		expect(r.memAvailable).toBeNull();
		expect(r.memTotal).toBeNull();
	});

	test("VM CPU is the busy share of the tick delta", () => {
		expect(
			vmCpuPercent({ idle: 800, total: 1000 }, { idle: 860, total: 1100 }),
		).toBe(40);
		expect(vmCpuPercent(null, { idle: 860, total: 1100 })).toBeNull();
		expect(
			vmCpuPercent({ idle: 800, total: 1000 }, { idle: 800, total: 1000 }),
		).toBeNull();
	});
});

describe("parseCgroupReading", () => {
	test("accepts a reading and rejects a wrong shape", () => {
		const r = reading({
			at: 1,
			cpuUsageUsec: 5,
			cpuMax: "max",
			memoryMax: 10,
			memoryEvents: { max: 0, oom: 0, oomKill: 0 },
			lock: { exists: true, pid: 9, alive: false },
		});
		expect(parseCgroupReading(JSON.parse(JSON.stringify(r)))).toEqual(r);
		expect(parseCgroupReading(null)).toBeNull();
		expect(parseCgroupReading([])).toBeNull();
		expect(parseCgroupReading({ ...r, cpuUsageUsec: "5" })).toBeNull();
		expect(parseCgroupReading({ ...r, cpuMax: { quotaUsec: 1 } })).toBeNull();
		expect(parseCgroupReading({ ...r, memoryEvents: { max: 1 } })).toBeNull();
		expect(parseCgroupReading({ ...r, lock: undefined })).toBeNull();
	});

	test("runs: a missing field (an older worker) parses as none; a malformed one rejects the reading", () => {
		const r = reading({
			at: 1,
			runs: [{ id: "w1", memBytes: 2048, cpuUsec: 10 }],
		});
		expect(parseCgroupReading(JSON.parse(JSON.stringify(r)))).toEqual(r);
		// JSON drops an undefined field: the body has no runs key at all.
		const old = JSON.parse(JSON.stringify({ ...r, runs: undefined }));
		expect(parseCgroupReading(old)).toEqual({ ...r, runs: [] });
		for (const runs of [
			null,
			{},
			[null],
			[{ memBytes: 1, cpuUsec: 1 }],
			[{ id: 7, memBytes: 1, cpuUsec: 1 }],
			[{ id: "w1", memBytes: -1, cpuUsec: 1 }],
			[{ id: "w1", memBytes: 1, cpuUsec: "1" }],
			[{ id: "w1", memBytes: 1 }],
		])
			expect(parseCgroupReading({ ...r, runs })).toBeNull();
	});
});

describe("fetchWorkerStats", () => {
	test("returns the worker's reading; a refused token gives null", async () => {
		const body = reading({ at: 3, cpuUsageUsec: 8 });
		const server = Bun.serve({
			port: 0,
			fetch: (req) =>
				req.headers.get("x-otwr-token") === "tok"
					? Response.json(body)
					: new Response("unauthorized", { status: 401 }),
		});
		stops.push(() => {
			void server.stop(true);
		});
		const url = `http://127.0.0.1:${server.port}`;
		expect(await fetchWorkerStats(url, "tok")).toEqual(body);
		expect(await fetchWorkerStats(url, "nope")).toBeNull();
	});
});

describe("cpuPercent", () => {
	test("is Δusage over Δwall in percent of one CPU", () => {
		expect(
			cpuPercent(
				{ at: 0, cpuUsageUsec: 1_000_000 },
				{ at: TICK, cpuUsageUsec: 46_000_000 },
			),
		).toBe(150);
	});

	test("a negative delta (restart) or no previous reading gives null", () => {
		expect(
			cpuPercent(
				{ at: 0, cpuUsageUsec: 9_000_000 },
				{ at: TICK, cpuUsageUsec: 1_000 },
			),
		).toBeNull();
		expect(cpuPercent(null, { at: TICK, cpuUsageUsec: 1_000 })).toBeNull();
	});
});

describe("counterGrowth", () => {
	const at = (values: number[]) => values.map((value, i) => ({ at: i, value }));
	test("sums growth; a counter that went down restarted from 0", () => {
		expect(counterGrowth(at([3, 5, 5, 6]), 0)).toBe(3);
		expect(counterGrowth(at([4, 1, 2]), 0)).toBe(2);
		expect(counterGrowth(at([7]), 0)).toBe(0);
	});
	test("an increase counts by the time of the reading that shows it", () => {
		// Readings at 0, 1, 2: the 0→1 step shows at 1, so a window from 1 still counts it.
		expect(counterGrowth(at([0, 1, 1]), 1)).toBe(1);
		expect(counterGrowth(at([0, 1, 1]), 2)).toBe(0);
	});
});

describe("keepWindow", () => {
	test("keeps the newest reading before the window as the baseline", () => {
		const ev = [{ at: 0 }, { at: 10 }, { at: 20 }, { at: 30 }];
		expect(keepWindow(ev, 15)).toEqual([{ at: 10 }, { at: 20 }, { at: 30 }]);
		expect(keepWindow(ev, 0)).toEqual(ev);
		expect(keepWindow(ev, 99)).toEqual([{ at: 30 }]);
	});
});

describe("pushRing", () => {
	test("the 121st point drops the oldest", () => {
		let ring: SystemPoint[] = [];
		for (let i = 0; i < 121; i++)
			ring = pushRing(ring, { at: i * 1000, cpu: i, mem: i });
		expect(ring).toHaveLength(120);
		expect(ring[0]!.at).toBe(1000);
		expect(ring.at(-1)!.at).toBe(120_000);
	});

	test("points older than one hour drop", () => {
		const ring = pushRing([{ at: 0, cpu: 1, mem: 1 }], {
			at: HOUR_MS + 1,
			cpu: 2,
			mem: 2,
		});
		expect(ring).toEqual([{ at: HOUR_MS + 1, cpu: 2, mem: 2 }]);
	});
});

describe("rowWarnings", () => {
	const quiet = {
		memUsed: null,
		memLimit: null,
		oomKillsHour: 0,
		cpuShare: null,
		history: [],
	};

	test("memory warns from 90 % of the limit, not at 89.9 %", () => {
		expect(rowWarnings({ ...quiet, memUsed: 899, memLimit: 1000 })).toEqual([]);
		expect(rowWarnings({ ...quiet, memUsed: 900, memLimit: 1000 })).toEqual([
			"memory 90 %",
		]);
		expect(rowWarnings({ ...quiet, memUsed: 999, memLimit: null })).toEqual([]);
	});

	test("CPU warns after 10 samples at 90 % of the share, not after 9", () => {
		const point = (i: number): SystemPoint => ({ at: i, cpu: 190, mem: null });
		const ten = Array.from({ length: 10 }, (_, i) => point(i));
		expect(rowWarnings({ ...quiet, cpuShare: 2, history: ten })).toEqual([
			"CPU at 90 % of its share for 5 min",
		]);
		expect(
			rowWarnings({ ...quiet, cpuShare: 2, history: ten.slice(1) }),
		).toEqual([]);
		const gap = [...ten.slice(0, 9), { at: 9, cpu: null, mem: null }];
		expect(rowWarnings({ ...quiet, cpuShare: 2, history: gap })).toEqual([]);
	});
});

describe("createSystemSampler", () => {
	test("before any record: no containers and a VM row of nulls", () => {
		const s = createSystemSampler().snapshot([], HOLDS, 100);
		expect(s).toEqual({
			at: 100,
			containers: [],
			vm: {
				cpuPct: null,
				cpus: availableParallelism(),
				load1: null,
				memAvailable: null,
				memTotal: null,
				history: [],
			},
			holds: HOLDS,
		});
	});

	test("CPU % from two usage_usec samples; share from cpu.max or the VM", () => {
		const sampler = createSystemSampler();
		sampler.record(
			[
				{
					name: "server",
					reading: reading({ at: 0, cpuUsageUsec: 0, cpuMax: "max" }),
				},
				{
					name: "worker-a",
					reading: reading({
						at: 0,
						cpuUsageUsec: 0,
						cpuMax: { quotaUsec: 150000, periodUsec: 100000 },
					}),
				},
			],
			vmAt(0, { cpus: 8 }),
		);
		let [server, worker] = sampler.snapshot([], HOLDS, 0).containers;
		expect(server!.cpuPct).toBeNull();
		sampler.record(
			[
				{
					name: "server",
					reading: reading({
						at: TICK,
						cpuUsageUsec: 15_000_000,
						cpuMax: "max",
					}),
				},
				{
					name: "worker-a",
					reading: reading({
						at: TICK,
						cpuUsageUsec: 30_000_000,
						cpuMax: { quotaUsec: 150000, periodUsec: 100000 },
					}),
				},
			],
			vmAt(TICK, { cpus: 8 }),
		);
		[server, worker] = sampler.snapshot([], HOLDS, TICK).containers;
		expect(server!.name).toBe("server");
		expect(server!.cpuPct).toBe(50);
		expect(server!.cpuShare).toBe(8);
		expect(worker!.cpuPct).toBe(100);
		expect(worker!.cpuShare).toBe(1.5);
		expect(worker!.history).toEqual([
			{ at: 0, cpu: null, mem: null },
			{ at: TICK, cpu: 100, mem: null },
		]);
	});

	test("memory warning on the row; none without a limit", () => {
		const sampler = createSystemSampler();
		sampler.record(
			[
				{
					name: "server",
					reading: reading({ memoryCurrent: 950, memoryMax: 1000 }),
				},
				{
					name: "worker-a",
					reading: reading({ memoryCurrent: 950, memoryMax: "max" }),
				},
			],
			vmAt(0),
		);
		const [server, worker] = sampler.snapshot([], HOLDS, 0).containers;
		expect(server!.memUsed).toBe(950);
		expect(server!.memLimit).toBe(1000);
		expect(server!.warnings).toEqual(["memory 95 %"]);
		expect(worker!.memLimit).toBeNull();
		expect(worker!.warnings).toEqual([]);
	});

	const events = (max: number, oomKill: number) => ({
		max,
		oom: oomKill,
		oomKill,
	});

	test("oom_kill growth inside the last hour warns; a growing max never does", () => {
		const sampler = createSystemSampler();
		sampler.record(
			[
				{
					name: "server",
					reading: reading({ at: 0, memoryEvents: events(5, 0) }),
				},
			],
			vmAt(0),
		);
		sampler.record(
			[
				{
					name: "server",
					reading: reading({ at: TICK, memoryEvents: events(9, 1) }),
				},
			],
			vmAt(TICK),
		);
		const [row] = sampler.snapshot([], HOLDS, TICK).containers;
		expect(row!.memMaxHits).toBe(9);
		expect(row!.oomKills).toBe(1);
		expect(row!.memMaxHitsHour).toBe(4);
		expect(row!.oomKillsHour).toBe(1);
		expect(row!.warnings).toEqual(["OOM kill in the last hour"]);
	});

	test("oom_kill growth older than one hour does not warn", () => {
		const sampler = createSystemSampler();
		const tick = (at: number, oomKill: number) =>
			sampler.record(
				[
					{
						name: "server",
						reading: reading({ at, memoryEvents: events(0, oomKill) }),
					},
				],
				vmAt(at),
			);
		tick(0, 0);
		tick(TICK, 1);
		tick(70 * 60_000, 1);
		tick(71 * 60_000, 1);
		const [row] = sampler.snapshot([], HOLDS, 71 * 60_000).containers;
		expect(row!.oomKills).toBe(1);
		expect(row!.oomKillsHour).toBe(0);
		expect(row!.warnings).toEqual([]);
	});

	test("an OOM kill seen 30 s after the first reading still counts just under one hour later", () => {
		const sampler = createSystemSampler();
		let last = 0;
		for (let at = 0; at <= 3_600_001; at += TICK) {
			sampler.record(
				[
					{
						name: "server",
						reading: reading({
							at,
							memoryEvents: events(at >= TICK ? 3 : 0, at >= TICK ? 1 : 0),
						}),
					},
				],
				vmAt(at),
			);
			last = at;
		}
		// The increase showed at 30 000 ms; at 3 600 001 ms it is 3 570 001 ms old.
		const [row] = sampler.snapshot([], HOLDS, 3_600_001).containers;
		expect(last).toBe(3_600_000);
		expect(row!.oomKillsHour).toBe(1);
		expect(row!.memMaxHitsHour).toBe(3);
		expect(row!.warnings).toEqual(["OOM kill in the last hour"]);
	});

	test("a restarted container counts its new oom_kill value as growth", () => {
		const sampler = createSystemSampler();
		sampler.record(
			[
				{
					name: "server",
					reading: reading({ at: 0, memoryEvents: events(0, 3) }),
				},
			],
			vmAt(0),
		);
		sampler.record(
			[
				{
					name: "server",
					reading: reading({ at: TICK, memoryEvents: events(0, 1) }),
				},
			],
			vmAt(TICK),
		);
		const [row] = sampler.snapshot([], HOLDS, TICK).containers;
		expect(row!.oomKillsHour).toBe(1);
	});

	/** `samples` CPU samples at 100 % of a 2-CPU quota (the first reading has no delta). */
	function cpuSampler(samples: number) {
		const sampler = createSystemSampler();
		for (let i = 0; i <= samples; i++)
			sampler.record(
				[
					{
						name: "server",
						reading: reading({
							at: i * TICK,
							cpuUsageUsec: i * 60_000_000,
							cpuMax: { quotaUsec: 200000, periodUsec: 100000 },
						}),
					},
				],
				vmAt(i * TICK),
			);
		return sampler.snapshot([], HOLDS, samples * TICK).containers[0]!;
	}

	test("CPU at 90 % of its share for 10 samples warns, 9 do not", () => {
		const ten = cpuSampler(10);
		expect(ten.cpuPct).toBe(200);
		expect(ten.warnings).toEqual(["CPU at 90 % of its share for 5 min"]);
		expect(cpuSampler(9).warnings).toEqual([]);
	});

	test("the 121st sample drops the oldest point", () => {
		const sampler = createSystemSampler();
		for (let i = 0; i < 121; i++)
			sampler.record(
				[
					{
						name: "server",
						reading: reading({ at: i * 1000, memoryCurrent: i }),
					},
				],
				vmAt(i * 1000, { memTotal: 100, memAvailable: 100 - i }),
			);
		const snap = sampler.snapshot([], HOLDS, 120_000);
		const history = snap.containers[0]!.history;
		expect(history).toHaveLength(120);
		expect(history[0]).toEqual({ at: 1000, cpu: null, mem: 1 });
		expect(snap.vm.history).toHaveLength(120);
		expect(snap.vm.history[0]!.mem).toBe(1);
	});

	test("an unreachable runner: null fields, first failure time, a gap point", () => {
		const sampler = createSystemSampler();
		const ok = reading({
			at: 0,
			cpuUsageUsec: 0,
			memoryCurrent: 10,
			memoryMax: 100,
			memoryEvents: events(0, 0),
			lock: { exists: true, pid: 77, alive: true },
		});
		sampler.record([{ name: "worker-a", reading: ok }], vmAt(0));
		sampler.record([{ name: "worker-a", reading: null }], vmAt(TICK));
		let [row] = sampler.snapshot([], HOLDS, TICK).containers;
		expect(row!.reachable).toBe(false);
		expect(row!.unreachableSince).toBe(TICK);
		sampler.record([{ name: "worker-a", reading: null }], vmAt(2 * TICK));
		[row] = sampler.snapshot([], HOLDS, 2 * TICK).containers;
		expect(row).toMatchObject({
			name: "worker-a",
			reachable: false,
			unreachableSince: TICK,
			cpuPct: null,
			cpuShare: null,
			memUsed: null,
			memLimit: null,
			memMaxHits: null,
			oomKills: null,
			memMaxHitsHour: null,
			oomKillsHour: null,
			warnings: [],
		});
		expect(row!.lock.holderPid).toBeNull();
		expect(row!.history).toEqual([
			{ at: 0, cpu: null, mem: 10 },
			{ at: TICK, cpu: null, mem: null },
			{ at: 2 * TICK, cpu: null, mem: null },
		]);
		sampler.record(
			[{ name: "worker-a", reading: { ...ok, at: 3 * TICK } }],
			vmAt(3 * TICK),
		);
		[row] = sampler.snapshot([], HOLDS, 3 * TICK).containers;
		expect(row!.reachable).toBe(true);
		expect(row!.unreachableSince).toBeNull();
	});

	test("lock holder and waiters come from the live runs on that runner", () => {
		const sampler = createSystemSampler();
		sampler.record(
			[
				{
					name: "server",
					reading: reading({ lock: { exists: true, pid: 4242, alive: true } }),
				},
				{
					name: "worker-a",
					reading: reading({ lock: { exists: true, pid: 99, alive: false } }),
				},
			],
			vmAt(0),
		);
		const runs: LiveRun[] = [
			{
				project: "p",
				id: "A",
				runner: "server",
				progress: "Stryker 40% · 4/10 · 1 survived (25.0%) · 2m elapsed",
				runId: null,
			},
			{
				project: "p",
				id: "B",
				runner: "server",
				progress: "Stryker waiting for the mutation lock (pid 4242)",
				runId: null,
			},
			{ project: "q", id: "C", runner: "server", progress: null, runId: null },
			{
				project: "q",
				id: "M",
				runner: "server",
				progress: "mutate.py running",
				runId: null,
			},
			{
				project: "p",
				id: "D",
				runner: "worker-a",
				progress: "Stryker 10% · 1/10 · 2m elapsed",
				runId: null,
			},
			{
				project: "p",
				id: "E",
				runner: "worker-a",
				progress: "Stryker 20% · 2/10 · 4m elapsed",
				runId: null,
			},
		];
		const [server, worker] = sampler.snapshot(runs, HOLDS, 0).containers;
		expect(server!.cards).toEqual([
			{ project: "p", id: "A", usage: null },
			{ project: "p", id: "B", usage: null },
			{ project: "q", id: "C", usage: null },
			{ project: "q", id: "M", usage: null },
		]);
		// The mutate.py run on the same container is no Stryker holder: A stays the one holder.
		expect(server!.lock).toEqual({
			holderPid: 4242,
			holderCard: { project: "p", id: "A" },
			waiters: [{ project: "p", id: "B" }],
		});
		// A dead holder frees the lock; two runs with progress name no single holder.
		expect(worker!.lock).toEqual({
			holderPid: null,
			holderCard: null,
			waiters: [],
		});
	});

	const turn = (
		id: string,
		runId: string | null,
		runner = "worker-a",
	): LiveRun => ({ project: "p", id, runner, progress: null, runId });
	const workerAt = (at: number, runs: RunUsage[]) => ({
		name: "worker-a",
		reading: reading({ at, runs }),
	});

	test("a turn's CPU % from two samples, and its peak memory across an outage", () => {
		const sampler = createSystemSampler();
		const live = [turn("A", "w1")];
		const usageAt = (now: number) =>
			sampler.snapshot(live, HOLDS, now).containers[0]!.cards[0]!.usage;
		sampler.record(
			[workerAt(0, [{ id: "w1", memBytes: 300, cpuUsec: 0 }])],
			vmAt(0),
		);
		expect(usageAt(0)).toEqual({
			mem: 300,
			memPeak: 300,
			cpuPct: null,
			cpuSec: 0,
		});
		sampler.record(
			[workerAt(TICK, [{ id: "w1", memBytes: 100, cpuUsec: 15_000_000 }])],
			vmAt(TICK),
		);
		// 15 s of CPU in a 30 s tick; memory went down, the peak stays.
		expect(usageAt(TICK)).toEqual({
			mem: 100,
			memPeak: 300,
			cpuPct: 50,
			cpuSec: 15,
		});
		sampler.record([{ name: "worker-a", reading: null }], vmAt(2 * TICK));
		expect(usageAt(2 * TICK)).toBeNull();
		sampler.record(
			[workerAt(3 * TICK, [{ id: "w1", memBytes: 200, cpuUsec: 45_000_000 }])],
			vmAt(3 * TICK),
		);
		// The sample before the outage is the CPU base (30 s over 60 s), and its peak survived.
		expect(usageAt(3 * TICK)).toEqual({
			mem: 200,
			memPeak: 300,
			cpuPct: 50,
			cpuSec: 45,
		});
		// A run the worker stops reporting drops its samples: back, it starts over.
		sampler.record([workerAt(4 * TICK, [])], vmAt(4 * TICK));
		expect(usageAt(4 * TICK)).toBeNull();
		sampler.record(
			[workerAt(5 * TICK, [{ id: "w1", memBytes: 50, cpuUsec: 46_000_000 }])],
			vmAt(5 * TICK),
		);
		expect(usageAt(5 * TICK)).toEqual({
			mem: 50,
			memPeak: 50,
			cpuPct: null,
			cpuSec: 46,
		});
	});

	test("cards: the largest memory first, turns without usage last in board order", () => {
		const sampler = createSystemSampler();
		sampler.record(
			[
				// The server reports no runs of its own; its turns carry no runId.
				{ name: "server", reading: reading({ at: 0 }) },
				workerAt(0, [
					{ id: "w1", memBytes: 100, cpuUsec: 0 },
					{ id: "w2", memBytes: 500, cpuUsec: 0 },
					{ id: "w3", memBytes: 300, cpuUsec: 0 },
				]),
			],
			vmAt(0),
		);
		const live = [
			turn("S", null, "server"),
			turn("A", "w1"),
			turn("U", "not-reported"),
			turn("B", "w2"),
			turn("N", null),
			turn("C", "w3"),
		];
		const [server, worker] = sampler.snapshot(live, HOLDS, 0).containers;
		expect(server!.cards).toEqual([{ project: "p", id: "S", usage: null }]);
		expect(worker!.cards.map((c) => [c.id, c.usage?.mem ?? null])).toEqual([
			["B", 500],
			["C", 300],
			["A", 100],
			["U", null],
			["N", null],
		]);
	});

	test("a runner missing from the latest record loses its row", () => {
		const sampler = createSystemSampler();
		sampler.record(
			[
				{ name: "server", reading: reading() },
				{ name: "worker-a", reading: reading() },
			],
			vmAt(0),
		);
		sampler.record(
			[{ name: "server", reading: reading({ at: TICK }) }],
			vmAt(TICK),
		);
		expect(
			sampler.snapshot([], HOLDS, TICK).containers.map((c) => c.name),
		).toEqual(["server"]);
	});

	test("the VM row: CPU from the tick delta, memory used in history", () => {
		const sampler = createSystemSampler();
		sampler.record(
			[],
			vmAt(0, {
				cpuTicks: { idle: 800, total: 1000 },
				memTotal: 1000,
				memAvailable: 400,
			}),
		);
		sampler.record(
			[],
			vmAt(TICK, {
				cpuTicks: { idle: 830, total: 1100 },
				load1: 2.5,
				memTotal: 1000,
				memAvailable: 300,
				cpus: 6,
			}),
		);
		expect(sampler.snapshot([], HOLDS, TICK).vm).toEqual({
			cpuPct: 70,
			cpus: 6,
			load1: 2.5,
			memAvailable: 300,
			memTotal: 1000,
			history: [
				{ at: 0, cpu: null, mem: 600 },
				{ at: TICK, cpu: 70, mem: 700 },
			],
		});
	});
});

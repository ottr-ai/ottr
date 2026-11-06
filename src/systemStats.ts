// System view sampler: each container reads its own cgroup v2 files (the server directly, a
// worker through GET /stats), and the server keeps one hour of 30 s samples per container plus
// the Docker VM as its /proc sees it. Container numbers come from cgroups, not /proc: inside a
// container /proc shows the whole VM, so only the cgroup says what the container itself uses.
import { readFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "./dblock.ts";
import type {
	CgroupReading,
	ContainerRow,
	SystemCard,
	SystemHolds,
	SystemPoint,
	SystemSnapshot,
	VmRow,
} from "./types.ts";

/** join(os.tmpdir(), "ott-stryker.lock") — the same file scripts/stryker-load.mjs creates. */
export const MUTATION_LOCK_PATH = join(tmpdir(), "ott-stryker.lock");

/** How far back history, counter growth and warnings look. */
export const HOUR_MS = 60 * 60 * 1000;
/** Points per history ring: one hour of 30 s ticks. */
export const RING_CAP = 120;
/** Fraction of memory.max (and of the CPU share) at which a row warns. */
const WARN_FRACTION = 0.9;
/** Consecutive CPU samples at the share's edge that warn: 10 × 30 s = 5 min. */
export const CPU_WARN_SAMPLES = 10;
/** The progress text of a run that waits for another run's mutation lock (src/stryker.ts). */
const LOCK_WAIT_PREFIX = "Stryker waiting for the mutation lock";
/** Every Stryker progress text starts with this (src/stryker.ts strykerStatus, runProgress). */
const STRYKER_PREFIX = "Stryker ";

/** File text, or null when it is missing or unreadable (cgroup v1 has none of these files). */
function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** A non-negative integer written in decimal digits only; anything else is garbled. */
function parseCount(text: string): number | null {
	if (!/^\d+$/.test(text)) return null;
	const n = Number(text);
	return Number.isSafeInteger(n) ? n : null;
}

/** `key value` lines (cpu.stat, memory.events) as a map; a line of another shape is skipped. */
function keyedCounts(text: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of text.split("\n")) {
		const [key, value, ...rest] = line.trim().split(/\s+/);
		if (!key || value === undefined || rest.length > 0) continue;
		const n = parseCount(value);
		if (n !== null) out.set(key, n);
	}
	return out;
}

/** cpu.stat's usage_usec. */
export function parseCpuStat(text: string | null): number | null {
	if (text === null) return null;
	return keyedCounts(text).get("usage_usec") ?? null;
}

/** cpu.max: `max 100000` → "max", `200000 100000` → quota and period. */
export function parseCpuMax(text: string | null): CgroupReading["cpuMax"] {
	if (text === null) return null;
	const [quota, period, ...rest] = text.trim().split(/\s+/);
	if (quota === undefined || period === undefined || rest.length > 0)
		return null;
	const periodUsec = parseCount(period);
	if (periodUsec === null || periodUsec === 0) return null;
	if (quota === "max") return "max";
	const quotaUsec = parseCount(quota);
	return quotaUsec === null ? null : { quotaUsec, periodUsec };
}

/** memory.current: one byte count. */
export function parseMemoryCurrent(text: string | null): number | null {
	return text === null ? null : parseCount(text.trim());
}

/** memory.max: a byte count, or "max" (no limit). */
export function parseMemoryMax(text: string | null): number | "max" | null {
	if (text === null) return null;
	const t = text.trim();
	return t === "max" ? "max" : parseCount(t);
}

/** memory.events max, oom and oom_kill; null unless all three are there. */
export function parseMemoryEvents(
	text: string | null,
): CgroupReading["memoryEvents"] {
	if (text === null) return null;
	const counts = keyedCounts(text);
	const max = counts.get("max");
	const oom = counts.get("oom");
	const oomKill = counts.get("oom_kill");
	if (max === undefined || oom === undefined || oomKill === undefined)
		return null;
	return { max, oom, oomKill };
}

/** The mutation lock file `{"pid":N}`: an unparsable one still exists, but holds no pid.
 *  Liveness mirrors lockHolderAlive in scripts/stryker-load.mjs (EPERM counts as alive). */
export function readLock(lockPath: string): CgroupReading["lock"] {
	let text: string;
	try {
		text = readFileSync(lockPath, "utf8");
	} catch (err) {
		const exists = (err as NodeJS.ErrnoException)?.code !== "ENOENT";
		return { exists, pid: null, alive: false };
	}
	let pid: number | null = null;
	try {
		const parsed = JSON.parse(text) as { pid?: unknown } | null;
		const p = parsed?.pid;
		if (typeof p === "number" && Number.isSafeInteger(p) && p > 0) pid = p;
	} catch {
		// Garbled: the lock exists, but nobody can say who holds it.
	}
	return { exists: true, pid, alive: pid !== null && pidAlive(pid) };
}

/** Reads cgroup v2 files under root (default "/sys/fs/cgroup") + the lock file. Sync, never throws; unreadable field → null. */
export function readCgroup(opts?: {
	root?: string;
	lockPath?: string;
	now?: number;
}): CgroupReading {
	const root = opts?.root ?? "/sys/fs/cgroup";
	const file = (name: string): string | null => readText(join(root, name));
	const memoryCurrent = parseMemoryCurrent(file("memory.current"));
	return {
		at: opts?.now ?? Date.now(),
		cpuUsageUsec: parseCpuStat(file("cpu.stat")),
		cpuMax: parseCpuMax(file("cpu.max")),
		memoryCurrent,
		memoryMax: parseMemoryMax(file("memory.max")),
		memoryEvents: parseMemoryEvents(file("memory.events")),
		lock: readLock(opts?.lockPath ?? MUTATION_LOCK_PATH),
	};
}

export interface VmReading {
	at: number;
	cpuTicks: { idle: number; total: number } | null;
	load1: number | null;
	memAvailable: number | null;
	memTotal: number | null;
	cpus: number;
}

/** The aggregate `cpu ` line of /proc/stat: idle = idle + iowait, total = the sum of the first
 *  eight fields (user … steal). guest and guest_nice are left out: the kernel already counts
 *  them inside user and nice. */
export function parseProcStat(text: string | null): VmReading["cpuTicks"] {
	if (text === null) return null;
	const line = text.split("\n").find((l) => l.startsWith("cpu "));
	if (!line) return null;
	const fields = line.trim().split(/\s+/).slice(1, 9).map(parseCount);
	if (fields.length < 5 || fields.some((f) => f === null)) return null;
	const ticks = fields as number[];
	return {
		idle: ticks[3]! + ticks[4]!,
		total: ticks.reduce((s, t) => s + t, 0),
	};
}

/** The 1-minute load average: the first number of /proc/loadavg. */
export function parseLoadavg(text: string | null): number | null {
	const first = text?.trim().split(/\s+/)[0];
	if (!first || !/^\d+(\.\d+)?$/.test(first)) return null;
	return Number(first);
}

/** MemTotal and MemAvailable of /proc/meminfo, converted from kB to bytes. */
export function parseMeminfo(text: string | null): {
	memTotal: number | null;
	memAvailable: number | null;
} {
	const kb = (key: string): number | null => {
		const m = text?.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"));
		return m ? Number(m[1]) * 1024 : null;
	};
	return { memTotal: kb("MemTotal"), memAvailable: kb("MemAvailable") };
}

/** /proc/stat aggregate "cpu" line, /proc/loadavg, /proc/meminfo (bytes) under procRoot (default "/proc"); cpus = os.availableParallelism(). Never throws. */
export function readVm(opts?: { procRoot?: string; now?: number }): VmReading {
	const procRoot = opts?.procRoot ?? "/proc";
	const file = (name: string): string | null => readText(join(procRoot, name));
	const mem = parseMeminfo(file("meminfo"));
	return {
		at: opts?.now ?? Date.now(),
		cpuTicks: parseProcStat(file("stat")),
		load1: parseLoadavg(file("loadavg")),
		memAvailable: mem.memAvailable,
		memTotal: mem.memTotal,
		cpus: availableParallelism(),
	};
}

const isCount = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;
const isCountOrNull = (v: unknown): v is number | null =>
	v === null || isCount(v);
/** A JSON object whose fields are not checked yet. */
type Unchecked<T> = { [K in keyof T]?: unknown };

/** Validates a worker's GET /stats JSON body; null when the shape is wrong. */
export function parseCgroupReading(body: unknown): CgroupReading | null {
	if (typeof body !== "object" || body === null) return null;
	const b = body as Unchecked<CgroupReading>;
	if (
		!isCount(b.at) ||
		!isCountOrNull(b.cpuUsageUsec) ||
		!isCountOrNull(b.memoryCurrent) ||
		!(b.memoryMax === "max" || isCountOrNull(b.memoryMax))
	)
		return null;
	let cpuMax: CgroupReading["cpuMax"] = null;
	if (b.cpuMax === "max") cpuMax = "max";
	else if (b.cpuMax !== null) {
		if (typeof b.cpuMax !== "object") return null;
		const m = b.cpuMax as Unchecked<
			Exclude<CgroupReading["cpuMax"], "max" | null>
		>;
		if (!isCount(m.quotaUsec) || !isCount(m.periodUsec) || m.periodUsec === 0)
			return null;
		cpuMax = { quotaUsec: m.quotaUsec, periodUsec: m.periodUsec };
	}
	let memoryEvents: CgroupReading["memoryEvents"] = null;
	if (b.memoryEvents !== null) {
		if (typeof b.memoryEvents !== "object") return null;
		const e = b.memoryEvents as Unchecked<
			NonNullable<CgroupReading["memoryEvents"]>
		>;
		if (!isCount(e.max) || !isCount(e.oom) || !isCount(e.oomKill)) return null;
		memoryEvents = { max: e.max, oom: e.oom, oomKill: e.oomKill };
	}
	if (typeof b.lock !== "object" || b.lock === null) return null;
	const l = b.lock as Unchecked<CgroupReading["lock"]>;
	if (
		typeof l.exists !== "boolean" ||
		typeof l.alive !== "boolean" ||
		!isCountOrNull(l.pid)
	)
		return null;
	return {
		at: b.at,
		cpuUsageUsec: b.cpuUsageUsec,
		cpuMax,
		memoryCurrent: b.memoryCurrent,
		memoryMax: b.memoryMax,
		memoryEvents,
		lock: { exists: l.exists, pid: l.pid, alive: l.alive },
	};
}

/** GET `${url}/stats` with x-otwr-token, redirect "manual", AbortSignal.timeout(timeoutMs default 5000). null on any failure (network, non-200, 401, bad body). */
export async function fetchWorkerStats(
	url: string,
	token: string | undefined,
	timeoutMs = 5000,
): Promise<CgroupReading | null> {
	try {
		const res = await fetch(`${url}/stats`, {
			headers: token ? { "x-otwr-token": token } : {},
			// redirect: "manual": the worker token must never follow a redirect off-host.
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.status !== 200) return null;
		return parseCgroupReading(await res.json());
	} catch {
		return null;
	}
}

/** reading null = unreachable this tick. name = "server" or the worker hostname. */
export interface RunnerReading {
	name: string;
	reading: CgroupReading | null;
}

/** A live run of the board. runner = "server" (local/merge turn) or the worker hostname. progress = the run's Stryker progress text (RunEntry.progress), null when none. */
export interface LiveRun {
	project: string;
	id: string;
	runner: string;
	progress: string | null;
}

export interface SystemSampler {
	/** One 30 s tick: rows follow `runners` order; keeps a 1 h / 120-point ring per row and for the VM. */
	record(runners: RunnerReading[], vm: VmReading): void;
	/** Builds the snapshot; before any record() → containers [] and a VM row of nulls (cpus from os). */
	snapshot(runs: LiveRun[], holds: SystemHolds, now: number): SystemSnapshot;
}

/** CPU in percent of one CPU between two readings: Δusage_usec / Δwall_usec × 100. null without
 *  a previous reading, or when usage went down (the container restarted) or time did not move. */
export function cpuPercent(
	prev: Pick<CgroupReading, "at" | "cpuUsageUsec"> | null,
	cur: Pick<CgroupReading, "at" | "cpuUsageUsec">,
): number | null {
	if (prev?.cpuUsageUsec == null || cur.cpuUsageUsec === null) return null;
	const used = cur.cpuUsageUsec - prev.cpuUsageUsec;
	const wallUsec = (cur.at - prev.at) * 1000;
	if (used < 0 || wallUsec <= 0) return null;
	return (used / wallUsec) * 100;
}

/** VM busy percent between two /proc/stat reads: (Δtotal − Δidle) / Δtotal × 100. */
export function vmCpuPercent(
	prev: VmReading["cpuTicks"],
	cur: VmReading["cpuTicks"],
): number | null {
	if (!prev || !cur) return null;
	const total = cur.total - prev.total;
	const idle = cur.idle - prev.idle;
	if (total <= 0 || idle < 0 || idle > total) return null;
	return ((total - idle) / total) * 100;
}

/** `ring` plus `point`, without points older than an hour before `point` and capped at `cap`
 *  (the oldest go first). */
export function pushRing(
	ring: readonly SystemPoint[],
	point: SystemPoint,
	cap = RING_CAP,
): SystemPoint[] {
	return [...ring, point].filter((p) => p.at >= point.at - HOUR_MS).slice(-cap);
}

/** Growth of a counter within a window, from readings oldest first. An increase counts when
 *  the reading that shows it is at or after `since`; the reading before it may be older, so the
 *  last reading before the window serves as the baseline. A value lower than the one before
 *  means the container restarted and its counter began again at 0, so that value is all growth
 *  since the restart; the sum is never negative. */
export function counterGrowth(
	readings: readonly { at: number; value: number }[],
	since: number,
): number {
	let growth = 0;
	for (let i = 1; i < readings.length; i++) {
		const cur = readings[i]!;
		if (cur.at < since) continue;
		const prev = readings[i - 1]!.value;
		growth += cur.value >= prev ? cur.value - prev : cur.value;
	}
	return growth;
}

/** `events` (oldest first) from `since` on, plus the newest one before `since`: the baseline
 *  counterGrowth needs for an increase seen in the window's first reading. */
export function keepWindow<T extends { at: number }>(
	events: readonly T[],
	since: number,
): T[] {
	const first = events.findIndex((e) => e.at >= since);
	if (first === -1) return events.slice(-1);
	return events.slice(Math.max(0, first - 1));
}

/** The warning reasons of one reachable row. `history` is oldest first; the CPU warning needs
 *  its last CPU_WARN_SAMPLES points all at or above 90 % of the share. memory.events `max`
 *  growth never warns: a cgroup at its limit reclaims page cache, which is normal. */
export function rowWarnings(row: {
	memUsed: number | null;
	memLimit: number | null;
	oomKillsHour: number | null;
	cpuShare: number | null;
	history: readonly SystemPoint[];
}): string[] {
	const warnings: string[] = [];
	if (row.memUsed !== null && row.memLimit !== null && row.memLimit > 0) {
		const pct = (row.memUsed / row.memLimit) * 100;
		if (pct >= WARN_FRACTION * 100)
			warnings.push(`memory ${Math.round(pct)} %`);
	}
	if (row.oomKillsHour !== null && row.oomKillsHour > 0)
		warnings.push("OOM kill in the last hour");
	if (row.cpuShare !== null && row.history.length >= CPU_WARN_SAMPLES) {
		const edge = WARN_FRACTION * row.cpuShare * 100;
		const last = row.history.slice(-CPU_WARN_SAMPLES);
		if (last.every((p) => p.cpu !== null && p.cpu >= edge))
			warnings.push("CPU at 90 % of its share for 5 min");
	}
	return warnings;
}

/** The lock part of a row: the holder pid from the reading, the cards from the board's runs. */
export function rowLock(
	lock: CgroupReading["lock"] | null,
	runs: readonly LiveRun[],
): ContainerRow["lock"] {
	const card = (r: LiveRun): SystemCard => ({ project: r.project, id: r.id });
	const waiters = runs.filter((r) => r.progress?.startsWith(LOCK_WAIT_PREFIX));
	// Only a Stryker status can hold the Stryker lock: runProgress also reports mutate.py runs.
	const running = runs.filter(
		(r) =>
			r.progress !== null &&
			r.progress.startsWith(STRYKER_PREFIX) &&
			!r.progress.startsWith(LOCK_WAIT_PREFIX),
	);
	return {
		holderPid: lock?.exists && lock.alive ? lock.pid : null,
		holderCard: running.length === 1 ? card(running[0]!) : null,
		waiters: waiters.map(card),
	};
}

/** One container's state between ticks. */
interface RunnerState {
	/** The latest reading; null while unreachable. */
	latest: CgroupReading | null;
	cpuPct: number | null;
	/** The VM CPU count of the latest tick: the share of a container without a CPU quota. */
	vmCpus: number;
	unreachableSince: number | null;
	history: SystemPoint[];
	/** memory.events readings of the last hour, oldest first. */
	events: { at: number; max: number; oomKill: number }[];
}

export function createSystemSampler(): SystemSampler {
	let runners: { name: string; state: RunnerState }[] = [];
	let vmLatest: VmReading | null = null;
	let vmCpuPct: number | null = null;
	let vmHistory: SystemPoint[] = [];

	const recordRunner = (
		prev: RunnerState | undefined,
		reading: CgroupReading | null,
		vm: VmReading,
	): RunnerState => {
		const tick = vm.at;
		const events = keepWindow(prev?.events ?? [], tick - HOUR_MS);
		if (reading === null) {
			// An outage: a gap point, and no previous reading for the next CPU delta, so the
			// first CPU after it spans one tick, not the whole outage.
			return {
				latest: null,
				cpuPct: null,
				vmCpus: vm.cpus,
				unreachableSince: prev?.unreachableSince ?? tick,
				history: pushRing(prev?.history ?? [], {
					at: tick,
					cpu: null,
					mem: null,
				}),
				events,
			};
		}
		const cpuPct = cpuPercent(prev?.latest ?? null, reading);
		if (reading.memoryEvents)
			events.push({
				at: reading.at,
				max: reading.memoryEvents.max,
				oomKill: reading.memoryEvents.oomKill,
			});
		return {
			latest: reading,
			cpuPct,
			vmCpus: vm.cpus,
			unreachableSince: null,
			history: pushRing(prev?.history ?? [], {
				at: reading.at,
				cpu: cpuPct,
				mem: reading.memoryCurrent,
			}),
			events,
		};
	};

	const row = (
		name: string,
		s: RunnerState,
		runs: readonly LiveRun[],
		now: number,
	): ContainerRow => {
		const r = s.latest;
		const history = s.history.filter((p) => p.at >= now - HOUR_MS);
		const cards = runs.filter((run) => run.runner === name);
		const lock = rowLock(r?.lock ?? null, cards);
		const base = {
			name,
			history,
			cards: cards.map((c) => ({ project: c.project, id: c.id })),
			lock,
		};
		if (r === null)
			return {
				...base,
				reachable: false,
				unreachableSince: s.unreachableSince,
				cpuPct: null,
				cpuShare: null,
				memUsed: null,
				memLimit: null,
				memMaxHits: null,
				oomKills: null,
				memMaxHitsHour: null,
				oomKillsHour: null,
				warnings: [],
			};
		const cpuShare =
			r.cpuMax === null
				? null
				: r.cpuMax === "max"
					? s.vmCpus
					: r.cpuMax.quotaUsec / r.cpuMax.periodUsec;
		const memLimit = typeof r.memoryMax === "number" ? r.memoryMax : null;
		const since = now - HOUR_MS;
		const memMaxHitsHour = r.memoryEvents
			? counterGrowth(
					s.events.map((e) => ({ at: e.at, value: e.max })),
					since,
				)
			: null;
		const oomKillsHour = r.memoryEvents
			? counterGrowth(
					s.events.map((e) => ({ at: e.at, value: e.oomKill })),
					since,
				)
			: null;
		return {
			...base,
			reachable: true,
			unreachableSince: null,
			cpuPct: s.cpuPct,
			cpuShare,
			memUsed: r.memoryCurrent,
			memLimit,
			memMaxHits: r.memoryEvents?.max ?? null,
			oomKills: r.memoryEvents?.oomKill ?? null,
			memMaxHitsHour,
			oomKillsHour,
			warnings: rowWarnings({
				memUsed: r.memoryCurrent,
				memLimit,
				oomKillsHour,
				cpuShare,
				history,
			}),
		};
	};

	return {
		record(readings, vm) {
			const prev = new Map(runners.map((r) => [r.name, r.state]));
			// Rebuilt from this tick's list: a runner no longer polled loses its row.
			runners = readings.map(({ name, reading }) => ({
				name,
				state: recordRunner(prev.get(name), reading, vm),
			}));
			vmCpuPct = vmCpuPercent(vmLatest?.cpuTicks ?? null, vm.cpuTicks);
			vmLatest = vm;
			vmHistory = pushRing(vmHistory, {
				at: vm.at,
				cpu: vmCpuPct,
				mem:
					vm.memTotal !== null && vm.memAvailable !== null
						? vm.memTotal - vm.memAvailable
						: null,
			});
		},
		snapshot(runs, holds, now) {
			const vm: VmRow = {
				cpuPct: vmCpuPct,
				cpus: vmLatest?.cpus ?? availableParallelism(),
				load1: vmLatest?.load1 ?? null,
				memAvailable: vmLatest?.memAvailable ?? null,
				memTotal: vmLatest?.memTotal ?? null,
				history: vmHistory.filter((p) => p.at >= now - HOUR_MS),
			};
			return {
				at: now,
				containers: runners.map(({ name, state }) =>
					row(name, state, runs, now),
				),
				vm,
				holds,
			};
		},
	};
}

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	lstatSync,
	openSync,
	readSync,
	renameSync,
	type Stats,
} from "node:fs";

/*
 * /dev/null guard (OTTR-1215): a board container must never run a turn while
 * /dev/null is not the character device 1:3. The 2026-11-22 incident: something
 * running as root removed the device on the server container, the next root
 * `2>/dev/null` redirect recreated it as a plain regular file, and every git
 * call with GIT_CONFIG_GLOBAL=/dev/null parsed that file's text until a human
 * repaired it (ALAT-210). The guard probes before each turn and check run
 * (runner.ts startRun, workers.ts /run), and inside the container health
 * checks (/api/boot, /healthz); on a broken probe it keeps the bad file aside
 * under a timestamped name, recreates the device with mknod and mode 0666,
 * and records one bell notice with the evidence (the bad file's head is the
 * clue to what wrote it).
 */

/** makedev(1, 3): the Linux /dev/null char device numbers. */
export const DEV_NULL_PATH = "/dev/null";
export const DEV_NULL_RDEV = (1 << 8) | 3;
const DEV_NULL_MODE = 0o666;

/** glibc makedev(): a major/minor pair as a dev_t number, JS-number safe. The
 * terms hold disjoint bit ranges, so the sum is the bit or without the int32
 * truncation JS's | would apply. */
export function makedev(major: number, minor: number): number {
	return (
		((major & 0xfff) << 8) +
		(minor & 0xff) +
		(major & ~0xfff) * 2 ** 32 +
		(minor & ~0xff) * 2 ** 12
	);
}

/** glibc major() of a dev_t number. */
export function majorOf(rdev: number): number {
	const lo = rdev % 2 ** 32;
	const hi = Math.floor(rdev / 2 ** 32);
	return (
		(Math.floor(lo / 2 ** 8) % 2 ** 12) + Math.floor(hi / 2 ** 12) * 2 ** 12
	);
}

/** glibc minor() of a dev_t number: low 8 bits in place, bits 12+ shifted down
 * with their own low 8 bits masked off (they carry major bits), JS-number safe. */
export function minorOf(rdev: number): number {
	const lo = rdev % 2 ** 32;
	const mid = Math.floor(lo / 2 ** 12);
	return (lo % 2 ** 8) + (mid - (mid % 2 ** 8));
}

/** What the probe found at the device path. */
export interface DevNullProbe {
	/** true when the path is not the expected character device. */
	broken: boolean;
	/** One-line human shape, e.g. "a regular file (259 bytes, starts \"...\")". */
	describe: string;
	/** Head bytes of a regular file, when readable: the incident's evidence. */
	head: string | null;
}

/** One repair attempt's outcome. */
interface DevNullRepair {
	repaired: boolean;
	keptAs: string | null;
	/** The step that failed, when the repair did not. */
	failedStep: string | null;
}

export interface DevNullResult {
	/** The probe saw something other than the expected character device. */
	broken: boolean;
	/** The repair ran and a re-probe sees the right device. */
	repaired: boolean;
	/** Where the bad file was kept aside, when the rename worked. */
	keptAs: string | null;
	/** The one-line notice with the evidence; null when nothing was wrong. */
	notice: string | null;
	/** true when this check newly recorded the notice in the ring. */
	first: boolean;
}

/** The seams the guard needs, injectable for tests. */
export interface DevNullGuardOps {
	path: string;
	/** The dev_t number the device must carry (makedev(major, minor)). */
	rdev: number;
	/** lstat: never follows a symlink at the device path. */
	stat(path: string): Stats | null;
	rename(from: string, to: string): void;
	chmod(path: string, mode: number): void;
	/** Runs one repair command (mknod); ok is its exit status 0. */
	exec(argv: string[]): { ok: boolean; detail: string | null };
	/** First bytes of a regular file, when readable. */
	readHead(path: string, bytes: number): string | null;
	now(): number;
}

const HEAD_BYTES = 256;
const HEAD_MAX = 120;
/** One bell notice per incident per day at most when the repair cannot run. */
const NOTICE_TTL_MS = 24 * 60 * 60_000;
const NOTICE_MAX = 20;
const MKNOD_CANDIDATES = ["mknod", "/bin/mknod", "/usr/bin/mknod"];

function realStat(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

function realExec(argv: string[]): { ok: boolean; detail: string | null } {
	// mknod ships in coreutils, but the PATH of a health probe is short; try
	// the bare name and the two usual absolute spots before giving up.
	let detail: string | null = null;
	const head = argv[0] ?? "mknod";
	for (const bin of MKNOD_CANDIDATES) {
		const r = spawnSync(head === "mknod" ? bin : head, argv.slice(1), {
			encoding: "utf8",
		});
		if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			detail = `${head} not found`;
			continue;
		}
		if (r.status === 0) return { ok: true, detail: null };
		detail = `${head} exited ${r.status === null ? "?" : r.status}`;
		const err = `${r.stderr ?? ""}`.trim();
		if (err !== "") detail = `${detail}: ${err.split("\n")[0]}`;
		return { ok: false, detail };
	}
	return { ok: false, detail };
}

function realReadHead(path: string, bytes: number): string | null {
	try {
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(bytes);
			const n = readSync(fd, buf, 0, bytes, 0);
			return buf.toString("utf8", 0, n);
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

const realOps: DevNullGuardOps = {
	path: DEV_NULL_PATH,
	rdev: DEV_NULL_RDEV,
	stat: realStat,
	rename: renameSync,
	chmod: chmodSync,
	exec: realExec,
	readHead: realReadHead,
	now: () => Date.now(),
};

function resolveOps(deps?: Partial<DevNullGuardOps>): DevNullGuardOps {
	return deps === undefined ? realOps : { ...realOps, ...deps };
}

/** Probes the device path once; never throws. */
export function probeDevNull(ops: DevNullGuardOps): DevNullProbe {
	const st = ops.stat(ops.path);
	if (st === null) return { broken: true, describe: "missing", head: null };
	if (st.isCharacterDevice() && st.rdev === ops.rdev)
		return {
			broken: false,
			describe: "the expected character device",
			head: null,
		};
	if (st.isCharacterDevice()) {
		const describe = `a character device ${majorOf(st.rdev)}:${minorOf(st.rdev)} instead of ${majorOf(ops.rdev)}:${minorOf(ops.rdev)}`;
		return { broken: true, describe, head: null };
	}
	let describe: string;
	let head: string | null = null;
	if (st.isFile()) {
		const raw = ops.readHead(ops.path, HEAD_BYTES);
		if (raw !== null) {
			head = raw
				.replace(/[\r\n\t]+/g, " ")
				.replace(/ {2,}/g, " ")
				.trim()
				.slice(0, HEAD_MAX);
		}
		describe = `a regular file (${st.size} bytes${head === null ? "" : `, starts ${JSON.stringify(head)}`})`;
	} else {
		const kind = st.isDirectory()
			? "a directory"
			: st.isSymbolicLink()
				? "a symbolic link"
				: st.isBlockDevice()
					? "a block device"
					: st.isFIFO()
						? "a fifo"
						: st.isSocket()
							? "a socket"
							: "an unknown kind";
		describe = kind;
	}
	return { broken: true, describe, head };
}

/** Keeps the bad file aside under a timestamped name, then mknod + chmod. */
function repairDevNull(ops: DevNullGuardOps, bad: DevNullProbe): DevNullRepair {
	// A missing path has nothing to keep aside; only a found wrong-shape entry does.
	const keep = bad.describe !== "missing";
	const stampMs = ops.now();
	const stamp = new Date(stampMs).toISOString().replace(/\.\d+Z$/, "Z");
	let keptAs: string | null = null;
	if (keep) {
		let name = `${ops.path}.broken-${stamp}`;
		for (let attempt = 0; ; attempt++) {
			if (ops.stat(name) === null) {
				keptAs = name;
				break;
			}
			if (attempt > 9)
				return { repaired: false, keptAs: null, failedStep: "keep-aside name" };
			name = `${ops.path}.broken-${stamp}-${attempt}`;
		}
		try {
			ops.rename(ops.path, keptAs);
		} catch (err) {
			return {
				repaired: false,
				keptAs: null,
				failedStep: `keep aside (${String(err)})`,
			};
		}
	}
	const r = ops.exec([
		"mknod",
		ops.path,
		"c",
		String(majorOf(ops.rdev)),
		String(minorOf(ops.rdev)),
	]);
	if (!r.ok)
		return {
			repaired: false,
			keptAs,
			failedStep: `mknod (${r.detail ?? "failed"})`,
		};
	try {
		ops.chmod(ops.path, DEV_NULL_MODE);
	} catch (err) {
		return { repaired: false, keptAs, failedStep: `chmod (${String(err)})` };
	}
	const after = probeDevNull(ops);
	if (after.broken)
		return {
			repaired: false,
			keptAs,
			failedStep: `re-probe (still ${after.describe})`,
		};
	return { repaired: true, keptAs, failedStep: null };
}

interface RecordedNotice {
	at: number;
	key: string;
	text: string;
}

/** One guard instance: the probe/repair logic plus its notice ring. */
export interface DevNullGuard {
	check(): DevNullResult;
	/** The recorded notice lines, oldest first; the bell reads these. */
	notices(): string[];
}

export function createDevNullGuard(
	deps?: Partial<DevNullGuardOps>,
): DevNullGuard {
	const ops = resolveOps(deps);
	const ring: RecordedNotice[] = [];
	const record = (key: string, text: string): boolean => {
		const now = ops.now();
		while (ring.length > 0 && now - (ring[0]?.at ?? now) > NOTICE_TTL_MS)
			ring.shift();
		if (ring.some((n) => n.key === key)) return false;
		while (ring.length >= NOTICE_MAX) ring.shift();
		ring.push({ at: now, key, text });
		return true;
	};
	return {
		check(): DevNullResult {
			const bad = probeDevNull(ops);
			if (!bad.broken)
				return {
					broken: false,
					repaired: false,
					keptAs: null,
					notice: null,
					first: false,
				};
			const r = repairDevNull(ops, bad);
			const evidence = bad.head === null ? "" : ` ${JSON.stringify(bad.head)}`;
			const notice =
				`${ops.path} was ${bad.describe}${evidence}; ` +
				(r.repaired
					? `kept aside as ${r.keptAs}, recreated as char ${majorOf(ops.rdev)}:${minorOf(ops.rdev)} mode 0666`
					: `repair failed at ${r.failedStep ?? "unknown step"}`);
			// A repaired incident keys on its unique keep-aside name, so every new
			// break posts its own notice; an unrepairable one posts once per day.
			const key = r.repaired
				? `devnull:${r.keptAs}`
				: `devnull:${ops.path}:${Math.floor(ops.now() / NOTICE_TTL_MS)}`;
			const first = record(key, notice);
			return {
				broken: true,
				repaired: r.repaired,
				keptAs: r.keptAs,
				notice,
				first,
			};
		},
		notices(): string[] {
			const now = ops.now();
			while (ring.length > 0 && now - (ring[0]?.at ?? now) > NOTICE_TTL_MS)
				ring.shift();
			return ring.map((n) => n.text);
		},
	};
}

/** The container's real guard: every hook (turn start, check start, health
 * probes) shares this one instance, so one incident records one notice. */
export const devNullGuard = createDevNullGuard();

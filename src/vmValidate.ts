import {
	closeSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import { isAbsolute, join } from "node:path";
import { platform } from "./platform/index.ts";
import {
	cwdUnderTarget,
	MISSING_CONTROL,
	type ValidateArtifact,
	type ValidateCheck,
	type ValidateJobOutcome,
	type ValidateJobSpec,
	type ValidateResult,
	type ValidateSelfCheck,
	VM_VALIDATE,
} from "./vmValidateShared.ts";

/**
 * The guest side of validation mode (docs/specs/microvm-validation-mode.md): one VM runs one
 * audit job under the harness controls. Init (docker/ottr-vm-init) starts this flow with
 * OTTR_VM_MODE=validate. The guest reads /job/job.json, proves each control with a self-check,
 * runs the job through one spawn path, promotes the collected scratch files into the result,
 * and writes the length-prefixed result JSON to the raw result drive /dev/vdd. vm-runner reads
 * that drive after the VM powers off. Nothing here reaches the network: the VM has no
 * interface, and the result leaves on the drive.
 */

/** Where the runner places the job input on the scratch ext4. */
const JOB_SPEC_PATH = "/job/job.json";

/** The raw result medium: guest-writable, root-only node (init chmods it 0600). */
const RESULT_DEVICE = "/dev/vdd";

/** The routes and the connect probe prove the same control: no path out. */
const NET_CLASS = "/sys/class/net";
const NET_PROBE_HOST = "1.1.1.1";
const NET_PROBE_PORT = 53;
const NET_PROBE_MS = 2000;

/** The probe cwd: a scratch bind that always exists, never the target. */
const PROBE_CWD = "/tmp";

/**
 * The limits probe: the same reads as before, with the process limit read from
 * /proc/self/limits and the live pids cap read from the job cgroup. The guest's
 * /bin/sh is dash, and dash has no `ulimit -u`; the table read works in every
 * POSIX sh, bash included. Exported so a test can run this exact command line
 * under the real shell.
 */
export const LIMITS_PROBE_ARGV: string[] = [
	"sh",
	"-c",
	`head -30 /proc/self/limits && nproc && head -1 /proc/meminfo && df -k /tmp && echo "pids=$(cat ${VM_VALIDATE.jobCgroup}/pids.max 2>/dev/null)"`,
];

/** The collect name's first component selects one of the scratch roots. */
const SCRATCH_ROOTS: Record<string, string> = {
	tmp: "/tmp",
	home: "/home",
	work: "/work",
};

/** The reason an artifact carries when only its bytes had to go to fit the drive. */
const DROPPED_TO_FIT = "dropped to fit the result drive";

/** The file facts promotion and the medium check need; every lstat follows no symlink. */
export interface ValidateStat {
	isFile(): boolean;
	isSymbolicLink(): boolean;
	/** Regular-file size in bytes. */
	size: number;
	/** Hard-link count of the node. */
	nlink: number;
	/** Owner uid. */
	uid: number;
	/** Full mode bits, including the file type. */
	mode: number;
}

export interface ValidateFs {
	readFile(path: string): Uint8Array;
	lstat(path: string): ValidateStat;
	/** One policy write: the job cgroup's `pids.max`, before the limits probe. */
	writeFile(path: string, content: string): void;
}

export interface JobSpawnOptions {
	cwd: string;
	env: Record<string, string>;
	/**
	 * No uid/gid here on purpose: the wrapper is spawned with the agent's root
	 * and drops to the job user itself, because only a root process can move
	 * its own pid into the job cgroup first.
	 */
}

/** What the job path needs from a spawned process: a Bun.Subprocess with piped stdio. */
export interface JobProcess {
	pid: number;
	/** Resolves when the process ends; a null exit code means it died on a signal. */
	exited: Promise<number | null>;
	/** null until the process ends, and null after a signal death. */
	exitCode: number | null;
	/** The signal name on a signal death, otherwise null. */
	signalCode: string | null;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
}

export type JobSpawn = (argv: string[], opts: JobSpawnOptions) => JobProcess;

export interface ProbeOptions {
	/** Left out for the root probes; the job-user probes pass nobody. */
	uid?: number;
	gid?: number;
}

export interface ProbeResult {
	stdout: string;
	stderr: string;
	/** 0 on success; non-zero means the probe failed. */
	exitCode: number;
}

/**
 * The seams the guest flow needs injected. The defaults build the real environment; the
 * tests (src/vmValidate.test.ts) inject fakes, so the flow never needs a real VM to prove.
 */
export interface ValidateDeps {
	/** File reads and no-follow lstats for the job spec and the promotion walk. */
	fs: ValidateFs;
	/** The result medium's node facts: mode and owner. */
	stat(path: string): ValidateStat;
	/** Directory names, for /sys/class/net. */
	readdir(path: string): string[];
	/** The one job spawn path every probe and the job use. */
	spawn: JobSpawn;
	/** One-shot probes (ip route, touch) run to their end. */
	exec(argv: string[], opts?: ProbeOptions): Promise<ProbeResult>;
	/** Resolves when host:port connects; rejects when the connect fails. */
	connectProbe(host: string, port: number): Promise<void>;
	/** The probe-race bound; the real sleep by default, instant in tests. */
	sleep(ms: number): Promise<void>;
	/** The guest clock. */
	now(): number;
	/** Writes the encoded result to the raw result drive. */
	writeResult(bytes: Uint8Array): Promise<void>;
	/** The job's process-tree killer (platform.killTree). */
	killTree(pid: number): void;
	/** The job timeout in seconds; a fraction in tests keeps the suite fast. */
	timeoutSec: number;
	/** The promotion caps; smaller in tests so the cumulative cap needs no 4 MiB files. */
	collectFileBytes: number;
	collectTotalBytes: number;
}

/** The job env: exactly the allowlist, never the request env. A fresh copy each call. */
export function buildJobEnv(): Record<string, string> {
	return { ...VM_VALIDATE.envAllowlist };
}

const JOB_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Why the raw value fails the job spec schema; null when it is a valid ValidateJobSpec. */
function specProblem(raw: unknown): string | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return "the job spec is not a JSON object";
	const v = raw as { [key: string]: unknown };
	if (v.schema !== 1) return "schema is not 1";
	if (typeof v.id !== "string" || !JOB_ID.test(v.id))
		return "id is not 1-64 chars of [A-Za-z0-9._-]";
	const argv = Array.isArray(v.argv) ? (v.argv as unknown[]) : undefined;
	if (argv === undefined || argv.length === 0)
		return "argv is not a non-empty list of non-empty strings";
	if (
		!argv.every(
			(item): item is string => typeof item === "string" && item !== "",
		)
	)
		return "argv is not a non-empty list of non-empty strings";
	if (typeof v.cwd !== "string" || !cwdUnderTarget(v.cwd))
		return "cwd is not an absolute, normalized path at or under /target";
	if (v.collect !== undefined) {
		const collect = Array.isArray(v.collect)
			? (v.collect as unknown[])
			: undefined;
		if (collect === undefined) return "collect is not a list";
		if (collect.length > VM_VALIDATE.collectMaxNames)
			return `collect names more than ${VM_VALIDATE.collectMaxNames} entries`;
		for (const name of collect) {
			if (typeof name !== "string" || name === "" || isAbsolute(name))
				return "a collect name is not a non-empty relative path";
			const parts = name.split("/");
			if (parts.some((p) => p === "" || p === "." || p === ".."))
				return "a collect name has an empty, . or .. component";
		}
	}
	return null;
}

export function parseJobSpec(raw: unknown): ValidateJobSpec | null {
	return specProblem(raw) === null ? (raw as ValidateJobSpec) : null;
}

/** Keeps the last `cap` bytes pushed to it: the tail of one job output stream. */
class TailBuffer {
	private chunks: Uint8Array[] = [];
	private length = 0;

	constructor(private readonly cap: number) {}

	push(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.length += chunk.byteLength;
		let excess = this.length - this.cap;
		while (excess > 0 && this.chunks.length > 0) {
			const first = this.chunks[0];
			if (first === undefined) break;
			if (first.byteLength <= excess) {
				this.chunks.shift();
				this.length -= first.byteLength;
				excess -= first.byteLength;
			} else {
				this.chunks[0] = first.subarray(excess);
				this.length -= excess;
				excess = 0;
			}
		}
	}

	/** The kept bytes as UTF-8 text; a byte that splits a code point decodes to U+FFFD. */
	text(): string {
		const all = new Uint8Array(this.length);
		let offset = 0;
		for (const chunk of this.chunks) {
			all.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder().decode(all);
	}
}

/** Reads one piped stream to its end into a tail buffer; the kill may tear the pipe. */
async function drain(
	stream: ReadableStream<Uint8Array>,
	tail: TailBuffer,
): Promise<void> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value) tail.push(value);
		}
	} catch {
		// A timeout kill closes the pipe mid-read; the bytes already buffered are the tail.
	} finally {
		reader.releaseLock();
	}
}

/** The run outcome runJob records for the result. */
interface RunOutcome {
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	stdoutTail: string;
	stderrTail: string;
}

/**
 * The one spawn path: a root wrapper moves its own pid into the job's pids
 * cgroup (the process cap is `pids.max` there, docs/specs/microvm-validation-mode.md),
 * drops to the job user with setpriv, and execs prlimit with the file rlimits. The
 * env is the allowlist and the timeout kills the whole tree. Probes and the real job
 * share this path, so the self-check proves the same controls the job runs under.
 * The move precedes every fork, so no job task is born outside the cgroup, and no
 * RLIMIT_NPROC is set: that limit counts the shared uid's tasks on the whole host
 * (OTTR-1225), not the job's.
 */
async function runProcess(
	argv: string[],
	cwd: string,
	deps: ValidateDeps,
): Promise<RunOutcome> {
	const proc = deps.spawn(
		[
			"sh",
			"-c",
			`echo "$$" > ${VM_VALIDATE.jobCgroup}/cgroup.procs && exec setpriv --reuid=${jobUid} --regid=${jobGid} --clear-groups prlimit --core=0 --fsize=${VM_VALIDATE.fileSizeBytes} -- "$0" "$@"`,
			...argv,
		],
		{
			cwd,
			env: buildJobEnv(),
		},
	);
	const stdout = new TailBuffer(VM_VALIDATE.outputTailBytes);
	const stderr = new TailBuffer(VM_VALIDATE.outputTailBytes);
	const out = drain(proc.stdout, stdout);
	const err = drain(proc.stderr, stderr);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		deps.killTree(proc.pid);
	}, deps.timeoutSec * 1000);
	let exitCode: number | null;
	try {
		exitCode = await proc.exited;
	} finally {
		clearTimeout(timer);
	}
	await Promise.all([out, err]);
	return {
		exitCode,
		signal: proc.signalCode,
		timedOut,
		stdoutTail: stdout.text(),
		stderrTail: stderr.text(),
	};
}

export async function runJob(
	spec: ValidateJobSpec,
	deps: ValidateDeps = realDeps(),
): Promise<ValidateJobOutcome> {
	const run = await runProcess(spec.argv, spec.cwd, deps);
	return {
		argv: spec.argv,
		cwd: spec.cwd,
		exitCode: run.exitCode,
		signal: run.signal,
		timedOut: run.timedOut,
		stdoutTail: run.stdoutTail,
		stderrTail: run.stderrTail,
	};
}

const message = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

const jobUid = VM_VALIDATE.jobUser.uid;
const jobGid = VM_VALIDATE.jobUser.gid;

interface SelfCheckStep {
	name: string;
	/** The MISSING_CONTROL name a failure reports. */
	control: string;
	run: (deps: ValidateDeps) => Promise<{ ok: boolean; detail: string }>;
}

/** What the limits check reads out of the probe's stdout; null means the read failed. */
export interface LimitsReadback {
	/** RLIMIT_NPROC's soft limit, from the /proc/self/limits table row. */
	nprocLimit: string | null;
	/** The vCPU count `nproc` printed; its output is one bare number. */
	cpus: string | null;
	/** MemTotal in kB. */
	memKb: number | null;
	/** The scratch filesystem total in 1K blocks. */
	scratchKb: number | null;
	/** The job cgroup's `pids.max`; "max" is possible, the cap is a number. */
	pidsMax: string | null;
}

/**
 * Parses the limits probe's stdout. Each field is found by its own shape, never by
 * line position: the limits table's row count is kernel-dependent, so fixed indexes
 * would break when the kernel grows the table. A probe that died early (dash's
 * `ulimit -u` failure) leaves every field null.
 */
export function parseLimitsReadback(stdoutTail: string): LimitsReadback {
	const lines = stdoutTail
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	// The table row is "Max processes <soft> <hard> processes"; the first number is
	// the soft limit. "unlimited" reads as null, and so does an absent row.
	const nprocLimit =
		/^Max processes\s+(\d+)\s/.exec(
			lines.find((line) => line.startsWith("Max processes")) ?? "",
		)?.[1] ?? null;
	// No limits-table row is a bare number, so the bare number is nproc's output.
	const cpus = lines.find((line) => /^\d+$/.test(line)) ?? null;
	const mem = /^MemTotal:\s+(\d+) kB$/.exec(
		lines.find((line) => line.startsWith("MemTotal:")) ?? "",
	);
	// The df data line starts with the device path; its second field is the total in 1K blocks.
	const df = lines.find((line) => line.startsWith("/dev/"))?.split(/\s+/);
	const dfTotal = Number(df?.[1]);
	// The probe's dedicated pids line: `pids=<pids.max>`. Never a bare number,
	// so it cannot collide with nproc's output.
	const pidsMax = /^pids=(\S+)$/.exec(
		lines.find((line) => line.startsWith("pids=")) ?? "",
	)?.[1];
	return {
		nprocLimit,
		cpus,
		memKb: mem === null ? null : Number(mem[1]),
		scratchKb: Number.isFinite(dfTotal) ? dfTotal : null,
		pidsMax: pidsMax ?? null,
	};
}

/**
 * The self-check catalog, in the spec table's order. Every check runs even after a
 * failure: the result keeps each check's own evidence, and the first failure alone
 * names the missing control.
 */
const steps: readonly SelfCheckStep[] = [
	{
		name: "interfaces",
		control: MISSING_CONTROL.network,
		run: async (deps) => {
			const nets = deps.readdir(NET_CLASS).slice().sort();
			const ok = nets.length === 1 && nets[0] === "lo";
			return { ok, detail: `${NET_CLASS}: ${nets.join(", ")}` };
		},
	},
	{
		name: "routes",
		control: MISSING_CONTROL.network,
		run: async (deps) => {
			const v4 = await deps.exec(["ip", "route", "show"]);
			const v6 = await deps.exec(["ip", "-6", "route", "show"]);
			const empty = v4.stdout.trim() === "" && v6.stdout.trim() === "";
			// A route table can lie about paths the kernel still has; the connect probe
			// settles it. A probe that neither fails nor connects in time is a failure too.
			const probe = await Promise.race([
				deps.connectProbe(NET_PROBE_HOST, NET_PROBE_PORT).then(
					() => "reachable",
					() => "blocked",
				),
				deps.sleep(NET_PROBE_MS).then(() => "slow"),
			]);
			return {
				ok: empty && probe === "blocked",
				detail: `ip route ${empty ? "empty" : "has entries"}; 1.1.1.1:53 ${probe}`,
			};
		},
	},
	{
		name: "env",
		control: MISSING_CONTROL.env,
		run: async (deps) => {
			const keys = Object.keys(buildJobEnv()).sort();
			const allowed = Object.keys(VM_VALIDATE.envAllowlist).sort();
			const built =
				keys.length === allowed.length &&
				keys.every((key, i) => key === allowed[i]);
			// The probe goes through the exact job spawn path, so the read-back env is the
			// env the job itself will see: prlimit prefix, allowlist env, nobody.
			const run = await runProcess(["env"], PROBE_CWD, deps);
			const printed = run.stdoutTail
				.split("\n")
				.filter((line) => line !== "")
				.sort();
			const expected = Object.entries(VM_VALIDATE.envAllowlist)
				.map(([key, value]) => `${key}=${value}`)
				.sort();
			const readBack =
				run.exitCode === 0 &&
				printed.length === expected.length &&
				printed.every((line, i) => line === expected[i]);
			return {
				ok: built && readBack,
				detail: `built ${built ? "matches" : "differs"}; probe printed ${printed.join(", ")}`,
			};
		},
	},
	{
		name: "target read-only",
		control: MISSING_CONTROL.targetRo,
		run: async (deps) => {
			const asJob = await deps.exec(
				["sh", "-c", "touch /target/.ottr-vc-probe"],
				{
					uid: jobUid,
					gid: jobGid,
				},
			);
			const asRoot = await deps.exec([
				"sh",
				"-c",
				"touch /target/.ottr-vc-probe",
			]);
			return {
				ok: asJob.exitCode !== 0 && asRoot.exitCode !== 0,
				detail: `touch /target/.ottr-vc-probe as nobody exited ${asJob.exitCode}, as root exited ${asRoot.exitCode}`,
			};
		},
	},
	{
		name: "toolchain read-only",
		control: MISSING_CONTROL.toolchainRo,
		run: async (deps) => {
			const asJob = await deps.exec(["sh", "-c", "touch /usr/.ottr-vc-probe"], {
				uid: jobUid,
				gid: jobGid,
			});
			const asRoot = await deps.exec(["sh", "-c", "touch /usr/.ottr-vc-probe"]);
			return {
				ok: asJob.exitCode !== 0 && asRoot.exitCode !== 0,
				detail: `touch /usr/.ottr-vc-probe as nobody exited ${asJob.exitCode}, as root exited ${asRoot.exitCode}`,
			};
		},
	},
	{
		name: "scratch writable",
		control: MISSING_CONTROL.scratch,
		run: async (deps) => {
			const tmp = await deps.exec(
				["sh", "-c", "touch /tmp/.ottr-vc-probe && rm /tmp/.ottr-vc-probe"],
				{
					uid: jobUid,
					gid: jobGid,
				},
			);
			const work = await deps.exec(
				["sh", "-c", "touch /work/.ottr-vc-probe && rm /work/.ottr-vc-probe"],
				{ uid: jobUid, gid: jobGid },
			);
			return {
				ok: tmp.exitCode === 0 && work.exitCode === 0,
				detail: `scratch write from /tmp exited ${tmp.exitCode}, from /work exited ${work.exitCode}`,
			};
		},
	},
	{
		name: "result medium guarded",
		control: MISSING_CONTROL.promotion,
		run: async (deps) => {
			const asJob = await deps.exec(["sh", "-c", ": > /dev/vdd"], {
				uid: jobUid,
				gid: jobGid,
			});
			const node = deps.stat(RESULT_DEVICE);
			// 0600 root:root is what keeps the job from forging the result the runner reads.
			const guarded = (node.mode & 0o7777) === 0o600 && node.uid === 0;
			return {
				ok: asJob.exitCode !== 0 && guarded,
				detail: `write to /dev/vdd as nobody exited ${asJob.exitCode}; node mode ${node.mode.toString(8)}, uid ${node.uid}`,
			};
		},
	},
	{
		name: "limits read back",
		control: MISSING_CONTROL.limits,
		run: async (deps) => {
			// The cap is policy the agent applies: written before the probe, the probe
			// then proves the guest's live value. A write that fails fails the check,
			// and the job never runs without it.
			try {
				deps.fs.writeFile(
					`${VM_VALIDATE.jobCgroup}/pids.max`,
					String(VM_VALIDATE.maxProcesses),
				);
			} catch (err) {
				return {
					ok: false,
					detail: `cannot write ${VM_VALIDATE.jobCgroup}/pids.max: ${message(err)}`,
				};
			}
			const run = await runProcess(LIMITS_PROBE_ARGV, PROBE_CWD, deps);
			const readback = parseLimitsReadback(run.stdoutTail);
			// The RAM band pins the booted memory to the configuration: MemTotal is
			// the RAM minus the kernel's reservation, so it sits below mem_size_mib
			// but must reach 90% of it. A VM booted at a stale size (a 512 MiB
			// runner image after the constant moved) fails here instead of passing
			// a result that proves nothing about its RAM (OTTR-1167 blocker 1).
			const memFloorKb = (VM_VALIDATE.memMiB * 1024 * 9) / 10;
			const memCeilKb = VM_VALIDATE.memMiB * 1024;
			const memOk =
				readback.memKb !== null &&
				readback.memKb >= memFloorKb &&
				readback.memKb <= memCeilKb;
			const ok =
				readback.pidsMax === String(VM_VALIDATE.maxProcesses) &&
				// No RLIMIT_NPROC on the job: that limit counts the shared uid's tasks
				// across the host's containers, not the job's (OTTR-1225).
				readback.nprocLimit === null &&
				readback.cpus === String(VM_VALIDATE.vcpus) &&
				memOk &&
				readback.scratchKb !== null &&
				readback.scratchKb > 0 &&
				readback.scratchKb <= VM_VALIDATE.diskBytes / 1024;
			return {
				ok,
				detail: `pids.max ${readback.pidsMax ?? "(none)"}, nproc limit ${readback.nprocLimit ?? "unlimited"}, nproc ${readback.cpus ?? "(none)"}, MemTotal ${readback.memKb ?? "(none)"} kB in the ${VM_VALIDATE.memMiB} MiB band ${memFloorKb}-${memCeilKb} kB, scratch ${readback.scratchKb ?? "(none)"} 1K blocks`,
			};
		},
	},
];

export interface SelfCheckOutcome {
	selfCheck: ValidateSelfCheck;
	missingControl: string | null;
}

export async function runSelfCheck(
	deps: ValidateDeps = realDeps(),
): Promise<SelfCheckOutcome> {
	const checks: ValidateCheck[] = [];
	let missingControl: string | null = null;
	for (const step of steps) {
		let ok = false;
		let detail: string;
		try {
			({ ok, detail } = await step.run(deps));
		} catch (err) {
			// A probe that throws is a failed check, not a crashed guest.
			ok = false;
			detail = message(err);
		}
		checks.push({ name: step.name, ok, detail });
		// The first failure names the control; later checks still record their own result.
		if (!ok && missingControl === null) missingControl = step.control;
	}
	return { selfCheck: { ok: missingControl === null, checks }, missingControl };
}

/**
 * Promotes the collected scratch files into the result. The job's process tree is already
 * dead here, so no writer races this walk: the lstat then read below cannot TOCTOU against
 * a live writer. Any name that fails a promotion rule is dropped and named, never fatal.
 */
export function promoteArtifacts(
	collect: readonly string[],
	deps: ValidateDeps = realDeps(),
): ValidateArtifact[] {
	const artifacts: ValidateArtifact[] = [];
	let total = 0;
	for (const name of collect) {
		const artifact = promoteOne(name, deps, total);
		// Only promoted bytes count against the cumulative cap.
		total += artifact.dropped === undefined ? artifact.size : 0;
		artifacts.push(artifact);
	}
	return artifacts;
}

function promoteOne(
	name: string,
	deps: ValidateDeps,
	total: number,
): ValidateArtifact {
	const drop = (reason: string): ValidateArtifact => ({
		name,
		size: 0,
		bytes: "",
		dropped: reason,
	});
	if (name === "" || isAbsolute(name))
		return drop("not a scratch-relative path");
	const parts = name.split("/");
	if (parts.some((p) => p === "" || p === "." || p === ".."))
		return drop("a path component is empty, . or ..");
	const root = SCRATCH_ROOTS[parts[0] ?? ""];
	if (root === undefined)
		return drop("not under a scratch root (tmp, home, work)");
	const below = parts.slice(1);
	// Every component no-follow: a symlink anywhere in the chain is rejected.
	for (let i = 0; i < below.length - 1; i++) {
		let parent: ValidateStat;
		try {
			parent = deps.fs.lstat(join(root, ...below.slice(0, i + 1)));
		} catch {
			return drop("a parent path is missing or unreadable");
		}
		if (parent.isSymbolicLink())
			return drop("a parent path component is a symlink");
	}
	let leaf: ValidateStat;
	try {
		leaf = deps.fs.lstat(join(root, ...below));
	} catch {
		return drop("the file is missing or unreadable");
	}
	if (leaf.isSymbolicLink()) return drop("the file is a symlink");
	if (!leaf.isFile()) return drop("not a regular file");
	if (leaf.nlink !== 1) return drop("the file has more than one hard link");
	if (leaf.size > deps.collectFileBytes)
		return drop(
			`larger than the per-file cap (${deps.collectFileBytes} bytes)`,
		);
	if (total + leaf.size > deps.collectTotalBytes)
		return drop(`would exceed the total cap (${deps.collectTotalBytes} bytes)`);
	let bytes: Uint8Array;
	try {
		bytes = deps.fs.readFile(join(root, ...below));
	} catch {
		return drop("the file could not be read");
	}
	// Re-check against the read: the size lstat saw must be the size the read returned.
	if (bytes.byteLength !== leaf.size)
		return drop("the file changed size between stat and read");
	return {
		name,
		size: bytes.byteLength,
		bytes: Buffer.from(bytes).toString("base64"),
	};
}

/** 8-byte little-endian length prefix, then the UTF-8 JSON payload. */
function encodeLengthPrefixed(json: string): Uint8Array {
	const payload = new TextEncoder().encode(json);
	const bytes = new Uint8Array(8 + payload.byteLength);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(payload.byteLength), true);
	bytes.set(payload, 8);
	return bytes;
}

/**
 * Encodes the result for the 1 MiB drive. Artifacts drop largest-bytes-first (each leaves
 * a named shell) until the encoding fits; null means even the artifact-less result does
 * not fit, and the caller falls back to writeMinimalResult.
 */
export function encodeResult(result: ValidateResult): Uint8Array | null {
	let current: ValidateResult = { ...result, artifacts: [...result.artifacts] };
	let encoded = encodeLengthPrefixed(JSON.stringify(current));
	while (encoded.byteLength > VM_VALIDATE.resultDriveBytes) {
		let largest = -1;
		for (let i = 0; i < current.artifacts.length; i++) {
			const size = current.artifacts[i]?.size ?? -1;
			const best =
				largest === -1 ? -1 : (current.artifacts[largest]?.size ?? -1);
			if (size > best) largest = i;
		}
		const victim = current.artifacts[largest];
		if (largest === -1 || victim === undefined || victim.bytes === "")
			return null;
		const shells = [...current.artifacts];
		shells[largest] = {
			name: victim.name,
			size: 0,
			bytes: "",
			dropped: DROPPED_TO_FIT,
		};
		current = { ...current, artifacts: shells };
		encoded = encodeLengthPrefixed(JSON.stringify(current));
	}
	return encoded;
}

/**
 * The fallback the drive still accepts: every artifact reduced to its dropped shell and
 * both job tails halved. Bounded by the caps (two 32 KiB tails, at most 16 names), it
 * always fits the drive.
 */
export function writeMinimalResult(result: ValidateResult): Uint8Array {
	return encodeLengthPrefixed(
		JSON.stringify({
			...result,
			artifacts: result.artifacts.map((artifact) => ({
				name: artifact.name,
				size: 0,
				bytes: "",
				dropped: DROPPED_TO_FIT,
			})),
			job: result.job && {
				...result.job,
				stdoutTail: result.job.stdoutTail.slice(
					0,
					Math.floor(result.job.stdoutTail.length / 2),
				),
				stderrTail: result.job.stderrTail.slice(
					0,
					Math.floor(result.job.stderrTail.length / 2),
				),
			},
		}),
	);
}

/** Reads and validates the job spec; the detail names why a null spec failed. */
function readJobSpec(deps: ValidateDeps): {
	spec: ValidateJobSpec | null;
	detail: string;
} {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(deps.fs.readFile(JOB_SPEC_PATH)));
	} catch (err) {
		return {
			spec: null,
			detail: `cannot read ${JOB_SPEC_PATH}: ${message(err)}`,
		};
	}
	const problem = specProblem(raw);
	if (problem !== null) return { spec: null, detail: problem };
	return { spec: raw as ValidateJobSpec, detail: "" };
}

function failureResult(
	deps: ValidateDeps,
	id: string,
	checkName: string,
	detail: string,
	missingControl: string,
): ValidateResult {
	return {
		schema: 1,
		id,
		selfCheck: { ok: false, checks: [{ name: checkName, ok: false, detail }] },
		missingControl,
		job: null,
		artifacts: [],
		endedAt: deps.now(),
	};
}

async function writeResult(
	deps: ValidateDeps,
	result: ValidateResult,
): Promise<void> {
	const bytes = encodeResult(result) ?? writeMinimalResult(result);
	await deps.writeResult(bytes);
}

/**
 * The entry the agent runs when OTTR_VM_MODE=validate: read the spec, prove the controls,
 * run the job only when every control held, promote the collected files, write the result.
 * Never throws: a failure becomes the result the drive carries out of the VM.
 */
export async function runValidationMode(
	deps: ValidateDeps = realDeps(),
): Promise<void> {
	let spec: ValidateJobSpec | null = null;
	try {
		const read = readJobSpec(deps);
		spec = read.spec;
		if (spec === null) {
			await writeResult(
				deps,
				failureResult(deps, "", "job spec", read.detail, "job spec invalid"),
			);
			console.log(`vmValidate: no valid job spec (${read.detail})`);
			return;
		}
		const { selfCheck, missingControl } = await runSelfCheck(deps);
		// The job runs only behind every proven control; the checks above are that proof.
		const job = missingControl === null ? await runJob(spec, deps) : null;
		const artifacts = promoteArtifacts(spec.collect ?? [], deps);
		await writeResult(deps, {
			schema: 1,
			id: spec.id,
			selfCheck,
			missingControl,
			job,
			artifacts,
			endedAt: deps.now(),
		});
		const dropped = artifacts.filter(
			(artifact) => artifact.dropped !== undefined,
		).length;
		console.log(
			`vmValidate: ${spec.id} selfCheck ${selfCheck.ok ? "ok" : "failed"}` +
				(missingControl === null ? "" : `, missing control ${missingControl}`) +
				`, job ${job === null ? "not run" : `exit ${job.exitCode ?? "on signal"}`}` +
				`, artifacts ${artifacts.length - dropped}/${artifacts.length} promoted`,
		);
	} catch (err) {
		// Last resort: name the failure in the result, or on the serial log if even that fails.
		const detail = message(err);
		try {
			await writeResult(
				deps,
				failureResult(
					deps,
					spec?.id ?? "",
					"validation run",
					detail,
					"validation run failed",
				),
			);
			console.error(`vmValidate: failed (${detail}); the result names it`);
		} catch (writeErr) {
			console.error(
				`vmValidate: failed (${detail}) and could not write the result: ${message(writeErr)}`,
			);
		}
	}
}

/** Bun.spawn narrowed to the job path; Bun's numeric signal codes become null here. */
const realSpawn: JobSpawn = (argv, opts) => {
	const proc = Bun.spawn(argv, {
		...opts,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		pid: proc.pid,
		exited: proc.exited,
		get exitCode() {
			return proc.exitCode;
		},
		get signalCode() {
			return typeof proc.signalCode === "string" ? proc.signalCode : null;
		},
		stdout: proc.stdout,
		stderr: proc.stderr,
	};
};

const realExec = async (
	argv: string[],
	opts?: ProbeOptions,
): Promise<ProbeResult> => {
	const proc = Bun.spawn(argv, {
		env: buildJobEnv(),
		uid: opts?.uid,
		gid: opts?.gid,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	// A signal death has no code; it is still a failed probe.
	return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
};

/** The real environment: node fs, Bun spawn and connect, the platform's tree killer. */
const realDeps = (): ValidateDeps => ({
	fs: {
		readFile: (path) => readFileSync(path),
		lstat: (path) => lstatSync(path),
		writeFile: (path, content) => writeFileSync(path, content),
	},
	stat: (path) => lstatSync(path),
	readdir: (path) => readdirSync(path),
	spawn: realSpawn,
	exec: realExec,
	connectProbe: async (host, port) => {
		// node:net reports the kernel's errno on the error event; Bun.connect's typed
		// shape rejects before it connects in this runtime.
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			s.destroy();
			reject(new Error("connect timed out"));
		}, 2000);
		const s = netConnect({ host, port }, () => {
			clearTimeout(timer);
			s.destroy();
			resolve(); // a connect succeeded: the isolation is broken
		});
		s.on("error", (err: Error) => {
			clearTimeout(timer);
			s.destroy();
			reject(err);
		});
		await promise;
	},
	sleep: (ms) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	},
	now: () => Date.now(),
	writeResult: async (bytes) => {
		// One O_WRONLY open at offset 0: the guest never reads the drive back, and init's
		// sync before power-off flushes it to the image vm-runner reads.
		const fd = openSync(RESULT_DEVICE, "w");
		try {
			writeSync(fd, bytes);
		} finally {
			closeSync(fd);
		}
	},
	killTree: (pid) => platform.killTree(pid),
	timeoutSec: VM_VALIDATE.timeoutSec,
	collectFileBytes: VM_VALIDATE.collectFileBytes,
	collectTotalBytes: VM_VALIDATE.collectTotalBytes,
});

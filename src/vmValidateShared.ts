/**
 * The validation mode's shared contract (docs/specs/microvm-validation-mode.md):
 * the fixed limits and the shapes the three sides agree on — vm-runner builds
 * the request and reads the result, the guest agent (src/vmValidate.ts) runs
 * the self-check and the job, and src/sandboxRun.ts packs the target and calls
 * the endpoint. No request knob changes a limit: the audit proves the mode's
 * limits, so they are constants here.
 */
import type { ProvisionLists } from "./workers.ts";

/** The validation mode's fixed limits. */
export const VM_VALIDATE = {
	/** Firecracker machine-config vcpu_count. */
	vcpus: 1,
	/** Firecracker machine-config mem_size_mib. 512 MiB could not start Chrome's
	 * renderer: V8 process OOM reserving the CodeRange, then every CDP command
	 * timed out (OTTR-1167, the VELV-245 block). 2048 MiB runs the browser
	 * oracle; the 1 vCPU, process, file and time caps stay. */
	memMiB: 2048,
	/** The scratch disk's size in bytes (the job's whole writable space). */
	diskBytes: 1024 ** 3,
	/** RLIMIT_NPROC on the job. */
	maxProcesses: 256,
	/** RLIMIT_FSIZE on the job; RLIMIT_CORE is always 0. */
	fileSizeBytes: 1024 ** 3,
	/** The guest kills the job at this many seconds. */
	timeoutSec: 600,
	/** The runner kills the VM at timeoutSec + this slack, to cover the boot. */
	lifetimeSlackSec: 180,
	/** The raw result drive's size; the result JSON must fit under it. */
	resultDriveBytes: 1024 * 1024,
	/** Kept bytes of the job's stdout and stderr, each. */
	outputTailBytes: 64 * 1024,
	/** The job runs as this user (nobody, ships in the Debian base). */
	jobUser: { uid: 65534, gid: 65534 },
	/** The env the job gets: exactly these three, never the request env. */
	envAllowlist: {
		PATH: "/usr/local/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		HOME: "/home/job",
		LANG: "C.UTF-8",
	},
	/** Artifact promotion caps: per file, and all files together. */
	collectFileBytes: 1024 * 1024,
	collectTotalBytes: 4 * 1024 * 1024,
	collectMaxNames: 16,
} as const;

/** The job input the runner places at /job/job.json on the scratch ext4. */
export interface ValidateJobSpec {
	schema: 1;
	id: string;
	argv: string[];
	/** Absolute path under /target. */
	cwd: string;
	/** Scratch-relative paths (under /tmp, /home or /work) to promote. */
	collect?: string[];
}

/** One self-check line: name, pass, and the evidence detail. */
export interface ValidateCheck {
	name: string;
	ok: boolean;
	detail: string;
}

export interface ValidateSelfCheck {
	ok: boolean;
	checks: ValidateCheck[];
}

/** What the guest records about the job it ran (null when it never ran). */
export interface ValidateJobOutcome {
	argv: string[];
	cwd: string;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	stdoutTail: string;
	stderrTail: string;
}

/** One promoted artifact; `dropped` names the promotion rule that failed it. */
export interface ValidateArtifact {
	name: string;
	size: number;
	/** base64; empty when dropped. */
	bytes: string;
	dropped?: string;
}

/** The JSON the guest writes to the raw result drive (length-prefixed). */
export interface ValidateResult {
	schema: 1;
	id: string;
	selfCheck: ValidateSelfCheck;
	/** The first failed control's name; null when every check passed. */
	missingControl: string | null;
	job: ValidateJobOutcome | null;
	artifacts: ValidateArtifact[];
	/** Seconds since the epoch, guest clock. */
	endedAt: number;
}

/** The POST /validate body. */
export interface ValidateRequest {
	/** [A-Za-z0-9._-]{1,64}; names the run dir and the /data record. */
	id: string;
	project: string;
	/** The card the job serves (the sandbox run's own card); the runner names it on the
	 *  System view. Absent = the caller carried no card. */
	taskId?: string;
	/** Tar of the target checkout; under <dataRoot>/<project>/ on the runner. */
	targetTar: string;
	/** The board's trusted provisioning lists (docs/specs/vm-list-isolation.md); the
	 * validate bake installs exactly these texts, never the shared home's. */
	lists?: ProvisionLists;
	job: {
		argv: string[];
		cwd: string;
		collect?: string[];
	};
}

/** The POST /validate answer. */
export interface ValidateResponse {
	id: string;
	selfCheck: ValidateSelfCheck | null;
	missingControl: string | null;
	job: ValidateJobOutcome | null;
	artifacts: ValidateArtifact[];
	limits: typeof VM_VALIDATE;
	bootMs: number | null;
	totalMs: number;
	logTail: string;
	/** "guest": the result drive held a valid result; "absent": it did not. */
	resultSource: "guest" | "absent";
	error?: string;
}

/** True when `cwd` is exactly "/target" or a normalized path under it: no trailing or
 * doubled slash, no "." or ".." segment. Bun's posix.normalize keeps trailing and
 * doubled slashes, so the segment list is the rule, not a normalize round trip. */
export function cwdUnderTarget(cwd: string): boolean {
	const parts = cwd.split("/");
	return (
		parts[0] === "" &&
		parts[1] === "target" &&
		parts.length >= 2 &&
		parts.slice(2).every((p) => p !== "" && p !== "." && p !== "..")
	);
}

/** The control names a failed self-check reports. */
export const MISSING_CONTROL = {
	network: "network isolation",
	env: "allowlisted empty environment",
	targetRo: "read-only target",
	toolchainRo: "read-only toolchain",
	scratch: "scratch-only writes",
	promotion: "artifact promotion guard",
	limits: "resource limits",
} as const;

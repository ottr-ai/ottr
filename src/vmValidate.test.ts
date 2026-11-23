import { describe, expect, test } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildJobEnv,
	encodeResult,
	type JobProcess,
	type JobSpawn,
	type JobSpawnOptions,
	LIMITS_PROBE_ARGV,
	parseJobSpec,
	parseLimitsReadback,
	promoteArtifacts,
	runJob,
	runSelfCheck,
	runValidationMode,
	type ValidateDeps,
	writeMinimalResult,
} from "./vmValidate.ts";
import {
	MISSING_CONTROL,
	type ValidateJobSpec,
	type ValidateResult,
	VM_VALIDATE,
} from "./vmValidateShared.ts";

/**
 * The job path's wrapper argv for `argv`, rebuilt here so the tests pin it without
 * an export (OTTR-1225): a root shell moves its own pid into the job's pids cgroup
 * first, then drops to nobody with setpriv, then execs prlimit with the file
 * rlimits. No RLIMIT_NPROC: that limit counts the shared uid's tasks on the whole
 * host, not the job's.
 */
const jobWrapper = (argv: string[]): string[] => [
	"sh",
	"-c",
	`echo "$$" > ${VM_VALIDATE.jobCgroup}/cgroup.procs && exec setpriv --reuid=${VM_VALIDATE.jobUser.uid} --regid=${VM_VALIDATE.jobUser.gid} --clear-groups prlimit --core=0 --fsize=${VM_VALIDATE.fileSizeBytes} -- "$0" "$@"`,
	...argv,
];

/** The job path's rlimit prefix alone: what a host without the cgroup can spawn. */
const hostPrefix = (): string[] => [
	"prlimit",
	"--core=0",
	`--fsize=${VM_VALIDATE.fileSizeBytes}`,
	"--",
];

const jobSpec = (over: Partial<ValidateJobSpec> = {}): ValidateJobSpec => ({
	schema: 1,
	id: "val-test",
	argv: ["job-marker", "--prove"],
	cwd: "/target",
	...over,
});

/** A job spec whose argv no probe shares, so a job spawn is unmistakable. */
const markedSpec = (): ValidateJobSpec =>
	jobSpec({ argv: ["target-job-marker", "--run"] });

const streamOf = (text: string): ReadableStream<Uint8Array> => {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
};

/** A process that prints `stdout`, exits `exitCode`, and ends its streams at once. */
function textProc(stdout: string, exitCode: number): JobProcess {
	return {
		pid: 4242,
		exited: Promise.resolve(exitCode),
		exitCode,
		signalCode: null,
		stdout: streamOf(stdout),
		stderr: streamOf(""),
	};
}

interface HangingProc extends JobProcess {
	killNow(): void;
}

/** A process that never exits until killNow; the timeout test's victim. */
function hangingProc(pid: number): HangingProc {
	const { promise, resolve } = Promise.withResolvers<number | null>();
	let signal: string | null = null;
	return {
		pid,
		exited: promise,
		exitCode: null,
		get signalCode() {
			return signal;
		},
		stdout: streamOf(""),
		stderr: streamOf(""),
		killNow() {
			signal = "SIGKILL";
			resolve(null);
		},
	};
}

/** The env the env probe must print: exactly the allowlist, sorted. */
const envText = (): string =>
	Object.entries(VM_VALIDATE.envAllowlist)
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join("\n");

/**
 * The limits probe's stdout: every line the limits check reads back, at the limit
 * values. The limits table is the /proc/self/limits format the probe prints (head -30
 * of the file); the process row is unlimited because the job path sets no
 * RLIMIT_NPROC, `pids` defaults to the configured cap so the check passes, and
 * `memTotalKb` defaults to a reading inside the configured RAM band (MemTotal is
 * the RAM minus the kernel's reservation, as on a real guest).
 */
const limitsText = (
	pids: string = String(VM_VALIDATE.maxProcesses),
	memTotalKb: number = Math.floor(VM_VALIDATE.memMiB * 1024 * 0.96),
): string =>
	[
		"Limit                     Soft Limit           Hard Limit           Units",
		"Max cpu time              unlimited            unlimited            seconds",
		"Max file size             1073741824           1073741824           bytes",
		"Max processes             unlimited            unlimited            processes",
		String(VM_VALIDATE.vcpus),
		`MemTotal:       ${memTotalKb} kB`,
		"Filesystem     1K-blocks    Used Available Use% Mounted on",
		`/dev/vdc       ${Math.floor(VM_VALIDATE.diskBytes / 1024)} 0 ${Math.floor(VM_VALIDATE.diskBytes / 1024)} 0% /tmp`,
		`pids=${pids}`,
	].join("\n");

interface SpawnCall {
	argv: string[];
	opts: JobSpawnOptions;
}

/**
 * A deps set where every self-check passes: interfaces is lo only, the route tables are
 * empty, the connect probe is blocked, the scratch writes succeed and every other probe
 * fails. Tests override the one piece under test. `spawnImpl` replaces what a spawn
 * answers; the recording wrapper stays, so `spawns` lists every job-path call.
 */
function makeDeps(
	opts: { overrides?: Partial<ValidateDeps>; spawnImpl?: JobSpawn } = {},
): {
	deps: ValidateDeps;
	spawns: SpawnCall[];
	fsWrites: { path: string; content: string }[];
} {
	const spawns: SpawnCall[] = [];
	/** The fs writes the flow made: the limits check's pids.max write lands here. */
	const fsWrites: { path: string; content: string }[] = [];
	const defaultSpawn: JobSpawn = (argv) => {
		const inner = argv.slice(3); // the wrapper argv: "sh", "-c", script, then the job argv
		if (inner[0] === "env") return textProc(envText(), 0);
		if (inner[0] === "sh") return textProc(limitsText(), 0);
		return textProc("", 0);
	};
	const spawn: JobSpawn = (argv, spawnOpts) => {
		spawns.push({ argv, opts: spawnOpts });
		return (opts.spawnImpl ?? defaultSpawn)(argv, spawnOpts);
	};
	const deps: ValidateDeps = {
		fs: {
			readFile: (path) => readFileSync(path),
			lstat: (path) => lstatSync(path),
			writeFile: (path, content) => {
				fsWrites.push({ path, content });
			},
		},
		// /dev/vdd does not exist in the test host: the default fakes a root-owned 0600
		// node, so the medium-guard check passes unless a test overrides it.
		stat: (path) =>
			path === "/dev/vdd"
				? {
						isFile: () => true,
						isSymbolicLink: () => false,
						size: VM_VALIDATE.resultDriveBytes,
						nlink: 1,
						uid: 0,
						mode: 0o600,
					}
				: lstatSync(path),
		readdir: () => ["lo"],
		spawn,
		exec: async (argv) => {
			const cmd = argv[2] ?? "";
			const scratch =
				cmd.startsWith("touch /tmp/") || cmd.startsWith("touch /work/");
			return { stdout: "", stderr: "", exitCode: scratch ? 0 : 1 };
		},
		connectProbe: async () => {
			throw new Error("blocked");
		},
		sleep: async () => undefined,
		now: () => 1_700_000_000_000,
		writeResult: async () => undefined,
		killTree: () => undefined,
		timeoutSec: 0.05,
		collectFileBytes: VM_VALIDATE.collectFileBytes,
		collectTotalBytes: VM_VALIDATE.collectTotalBytes,
		...opts.overrides,
	};
	return { deps, spawns, fsWrites };
}

/** A deps.fs whose readFile serves the job spec from memory (no real /job exists here). */
const fsWithSpec = (
	spec: ValidateJobSpec,
	writes: { path: string; content: string }[] = [],
): ValidateDeps["fs"] => ({
	readFile: (path) => {
		if (path === "/job/job.json") return Buffer.from(JSON.stringify(spec));
		return readFileSync(path);
	},
	lstat: (path) => lstatSync(path),
	writeFile: (path, content) => {
		writes.push({ path, content });
	},
});

function decodeResult(bytes: Uint8Array): ValidateResult {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const length = Number(view.getBigUint64(0, true));
	const json = new TextDecoder().decode(bytes.subarray(8, 8 + length));
	return JSON.parse(json) as ValidateResult;
}

describe("buildJobEnv", () => {
	test("returns exactly the allowlist, as a fresh object", () => {
		const env = buildJobEnv();
		expect(env).toEqual({ ...VM_VALIDATE.envAllowlist });
		expect(env).not.toBe(VM_VALIDATE.envAllowlist);
		env.PATH = "changed";
		expect(VM_VALIDATE.envAllowlist.PATH).not.toBe("changed");
	});
});

describe("parseJobSpec", () => {
	test("accepts a valid spec with collect names", () => {
		const spec = jobSpec({
			collect: ["tmp/poc.txt", "home/out.bin", "work/a/b.log"],
		});
		expect(parseJobSpec(spec)).toEqual(spec);
	});

	test("rejects schema, id, argv and cwd violations", () => {
		expect(parseJobSpec({ ...jobSpec(), schema: 2 })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), id: "bad id!" })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), id: "a".repeat(65) })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), id: "" })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), argv: [] })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), argv: ["ok", 5] })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), argv: ["ok", ""] })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), cwd: "target" })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), cwd: "/etc" })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), cwd: "/target/../etc" })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), cwd: "/target//x" })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), cwd: "/target/." })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), cwd: "/target/x/" })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), cwd: "/targetizer" })).toBeNull();
		// /target itself is a valid cwd: the spec's example request uses it.
		expect(parseJobSpec({ ...jobSpec(), cwd: "/target" })).toEqual(jobSpec());
	});

	test("rejects bad collect lists", () => {
		expect(parseJobSpec({ ...jobSpec(), collect: [] })).toEqual({
			...jobSpec(),
			collect: [],
		});
		expect(parseJobSpec({ ...jobSpec(), collect: ["/abs"] })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), collect: [""] })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), collect: ["tmp/./x"] })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), collect: ["tmp/../x"] })).toBeNull();
		expect(parseJobSpec({ ...jobSpec(), collect: ["tmp//x"] })).toBeNull();
		expect(
			parseJobSpec({ ...jobSpec(), collect: Array(16).fill("tmp/x") }),
		).not.toBeNull();
		expect(
			parseJobSpec({ ...jobSpec(), collect: Array(17).fill("tmp/x") }),
		).toBeNull();
	});
});

describe("runSelfCheck", () => {
	test("the default fake deps pass every check", async () => {
		const { deps } = makeDeps();
		const { selfCheck, missingControl } = await runSelfCheck(deps);
		expect(missingControl).toBeNull();
		expect(selfCheck.ok).toBe(true);
		expect(selfCheck.checks.map((check) => check.name)).toEqual([
			"interfaces",
			"routes",
			"env",
			"target read-only",
			"toolchain read-only",
			"scratch writable",
			"result medium guarded",
			"limits read back",
		]);
	});

	test("an env probe that prints an extra variable fails the env check", async () => {
		const { deps } = makeDeps({
			spawnImpl: (argv) => {
				const inner = argv.slice(3); // the wrapper argv: "sh", "-c", script, then the job argv
				if (inner[0] === "env") return textProc(`${envText()}\nEXTRA=1`, 0);
				if (inner[0] === "sh") return textProc(limitsText(), 0);
				return textProc("", 0);
			},
		});
		const { selfCheck, missingControl } = await runSelfCheck(deps);
		expect(missingControl).toBe(MISSING_CONTROL.env);
		const env = selfCheck.checks.find((check) => check.name === "env");
		expect(env?.ok).toBe(false);
		expect(env?.detail).toContain("EXTRA=1");
	});

	test("a guest booted below the configured RAM band fails the limits check (OTTR-1167)", async () => {
		// The real reading of the stale 512 MiB image: a runner that still boots
		// the old size must produce a failed self-check naming the control, never
		// a passing result silent about its RAM.
		const { deps } = makeDeps({
			spawnImpl: (argv) => {
				const inner = argv.slice(3); // the wrapper argv: "sh", "-c", script, then the job argv
				if (inner[0] === "env") return textProc(envText(), 0);
				if (inner[0] === "sh")
					return textProc(
						limitsText(String(VM_VALIDATE.maxProcesses), 493248),
						0,
					);
				return textProc("", 0);
			},
		});
		const { selfCheck, missingControl } = await runSelfCheck(deps);
		expect(missingControl).toBe(MISSING_CONTROL.limits);
		const limits = selfCheck.checks.find(
			(check) => check.name === "limits read back",
		);
		expect(limits?.ok).toBe(false);
		expect(limits?.detail).toContain("493248 kB");
		expect(limits?.detail).toContain(`${VM_VALIDATE.memMiB} MiB band`);
	});

	test("a probe that throws is a failed check, not a crash", async () => {
		const { deps } = makeDeps({
			overrides: {
				exec: async () => {
					throw new Error("ip is missing");
				},
			},
		});
		const { selfCheck, missingControl } = await runSelfCheck(deps);
		expect(missingControl).toBe(MISSING_CONTROL.network);
		const routes = selfCheck.checks.find((check) => check.name === "routes");
		expect(routes?.ok).toBe(false);
		expect(routes?.detail).toContain("ip is missing");
	});

	test("each failed check names its MISSING_CONTROL entry", async () => {
		const failing = async (
			mutate: (deps: ValidateDeps) => void,
			control: string,
		): Promise<void> => {
			const { deps } = makeDeps();
			mutate(deps);
			const { missingControl } = await runSelfCheck(deps);
			expect(missingControl).toBe(control);
		};
		await failing((deps) => {
			deps.readdir = () => ["lo", "eth0"];
		}, MISSING_CONTROL.network);
		await failing((deps) => {
			deps.connectProbe = async () => undefined; // the probe connects: a path out exists
		}, MISSING_CONTROL.network);
		await failing((deps) => {
			deps.exec = async (argv) => {
				const cmd = argv[2] ?? "";
				const scratch =
					cmd.startsWith("touch /tmp/") || cmd.startsWith("touch /work/");
				const target = cmd.startsWith("touch /target");
				return { stdout: "", stderr: "", exitCode: target || scratch ? 0 : 1 };
			};
		}, MISSING_CONTROL.targetRo);
		await failing((deps) => {
			deps.exec = async (argv) => {
				const cmd = argv[2] ?? "";
				const scratch =
					cmd.startsWith("touch /tmp/") || cmd.startsWith("touch /work/");
				const toolchain = cmd.startsWith("touch /usr");
				return {
					stdout: "",
					stderr: "",
					exitCode: toolchain || scratch ? 0 : 1,
				};
			};
		}, MISSING_CONTROL.toolchainRo);
		await failing((deps) => {
			deps.exec = async () => ({ stdout: "", stderr: "", exitCode: 1 }); // no scratch write works
		}, MISSING_CONTROL.scratch);
		await failing((deps) => {
			deps.exec = async (argv) => {
				const cmd = argv[2] ?? "";
				const scratch =
					cmd.startsWith("touch /tmp/") || cmd.startsWith("touch /work/");
				const medium = cmd === ": > /dev/vdd";
				return { stdout: "", stderr: "", exitCode: medium || scratch ? 0 : 1 };
			};
		}, MISSING_CONTROL.promotion);
		await failing((deps) => {
			deps.spawn = (argv) => {
				const inner = argv.slice(3); // the wrapper argv: "sh", "-c", script, then the job argv
				if (inner[0] === "sh") return textProc(limitsText("999"), 0); // the cap reads back wrong
				return textProc(inner[0] === "env" ? envText() : "", 0);
			};
		}, MISSING_CONTROL.limits);
		await failing((deps) => {
			// The coupling regression: a finite Max processes row means the job path
			// set an RLIMIT_NPROC again, whose count is the shared uid's on the host.
			deps.spawn = (argv) => {
				const inner = argv.slice(3); // the wrapper argv: "sh", "-c", script, then the job argv
				if (inner[0] === "sh")
					return textProc(
						limitsText().replace(
							"Max processes             unlimited            unlimited            processes",
							"Max processes             256                  256                  processes",
						),
						0,
					);
				return textProc(inner[0] === "env" ? envText() : "", 0);
			};
		}, MISSING_CONTROL.limits);
		await failing((deps) => {
			deps.fs.writeFile = () => {
				throw new Error("no cgroup");
			};
		}, MISSING_CONTROL.limits);
	});

	test("the job still forks and passes while this uid owns more than 256 tasks", async () => {
		// The OTTR-1163 acceptance: the gate runs as the project's shared uid, and
		// other turns of the same project (Chrome, bun, Stryker) hold tasks of that
		// uid on the same host. The job path must carry no RLIMIT_NPROC of its own —
		// the kernel counts that limit per real uid over every container, so an
		// absolute 256 fails the job's first fork whenever the shared uid is loaded.
		// The cap lives in the guest's pids cgroup instead. This test holds more
		// than 256 real tasks of this uid, then runs the job path's rlimit prefix
		// (its host form: prlimit, no cgroup move, no setpriv) over the real limits
		// probe and over a job that forks eight subshells. Both must fork and pass.
		const holders: Bun.Subprocess<"ignore", "ignore", "ignore">[] = [];
		try {
			while (holders.length <= VM_VALIDATE.maxProcesses) {
				holders.push(
					Bun.spawn(["sleep", "120"], {
						stdin: "ignore",
						stdout: "ignore",
						stderr: "ignore",
					}),
				);
			}
			// This process and the probe spawns themselves count too: the uid's task
			// count is well above the job's 256 here.
			expect(holders.length).toBeGreaterThan(VM_VALIDATE.maxProcesses);
			const probe = Bun.spawn([...hostPrefix(), ...LIMITS_PROBE_ARGV], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(probe.stdout).text();
			const stderr = await new Response(probe.stderr).text();
			expect(await probe.exited).toBe(0);
			expect(stderr).toBe("");
			const readback = parseLimitsReadback(stdout);
			expect(readback.cpus).not.toBeNull();
			expect(readback.memKb).not.toBeNull();
			// scratchKb is deliberately not asserted here: a host's /tmp can sit on the
			// overlay root, whose df data line names no /dev/ device, so the parser's
			// null is correct there. The guest's /tmp is the /dev/vdc scratch ext4, and
			// the fixture tests cover that line's parsing. The probe's pids line names
			// nothing on a host without the job cgroup, which the parser reads as null.
			expect(readback.pidsMax).toBeNull();
			const job = Bun.spawn(
				[
					...hostPrefix(),
					"sh",
					"-c",
					// Eight forks that outlive no pipe: each child is fully detached, so
					// the shell's stdout closes at its own exit. A failed fork makes dash
					// print to stderr, which the assertion below refuses.
					'i=0; while [ "$i" -lt 8 ]; do sleep 30 </dev/null >/dev/null 2>&1 & i=$((i+1)); done; echo "forked=$i"; exit 0',
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const jobOut = (await new Response(job.stdout).text()).trim();
			const jobErr = await new Response(job.stderr).text();
			expect(jobErr).toBe("");
			expect(await job.exited).toBe(0);
			expect(jobOut).toBe("forked=8");
		} finally {
			for (const holder of holders) holder.kill();
		}
	}, 60_000);

	test("the limits check writes the pids cap before the probe reads it back", async () => {
		const { deps, fsWrites } = makeDeps();
		const { selfCheck, missingControl } = await runSelfCheck(deps);
		expect(missingControl).toBeNull();
		expect(selfCheck.ok).toBe(true);
		const cap = `${VM_VALIDATE.jobCgroup}/pids.max`;
		expect(fsWrites).toContainEqual({
			path: cap,
			content: String(VM_VALIDATE.maxProcesses),
		});
	});
});

describe("parseLimitsReadback", () => {
	test("reads the pids cap, an unlimited process row, and the host fields", () => {
		const readback = parseLimitsReadback(limitsText());
		expect(readback.pidsMax).toBe(String(VM_VALIDATE.maxProcesses));
		expect(readback.nprocLimit).toBeNull();
		expect(readback.cpus).toBe(String(VM_VALIDATE.vcpus));
		expect(readback.memKb).toBe(524288);
	});

	test("reads a 'max' cap and misses a failed or empty pids read", () => {
		expect(parseLimitsReadback(limitsText("max")).pidsMax).toBe("max");
		// An empty read (`cat` failed, the echo still printed) parses as null.
		expect(parseLimitsReadback(limitsText("")).pidsMax).toBeNull();
		// The pids line never collides with nproc's bare-number output.
		const readback = parseLimitsReadback(limitsText());
		expect(readback.cpus).toBe(String(VM_VALIDATE.vcpus));
	});
});

describe("runJob", () => {
	test("a hung job is killed at the timeout and still reported", async () => {
		const proc = hangingProc(777);
		const killedPids: number[] = [];
		const { deps } = makeDeps({
			spawnImpl: () => proc,
			overrides: {
				killTree: (pid) => {
					killedPids.push(pid);
					proc.killNow();
				},
				timeoutSec: 0.05,
			},
		});
		const outcome = await runJob(markedSpec(), deps);
		expect(killedPids).toEqual([777]);
		expect(outcome.timedOut).toBe(true);
		expect(outcome.exitCode).toBeNull();
		expect(outcome.signal).toBe("SIGKILL");
		expect(outcome.argv).toEqual(markedSpec().argv);
		expect(outcome.cwd).toBe("/target");
	});

	test("a job that exits keeps its code and its output tails", async () => {
		const { deps } = makeDeps({
			spawnImpl: () => textProc("out line\n", 3),
		});
		const outcome = await runJob(markedSpec(), deps);
		expect(outcome.timedOut).toBe(false);
		expect(outcome.exitCode).toBe(3);
		expect(outcome.signal).toBeNull();
		expect(outcome.stdoutTail).toBe("out line\n");
	});
});

describe("promoteArtifacts", () => {
	test("a plain scratch file promotes; rule breakers drop with reasons", () => {
		const scratch = mkdtempSync(join(tmpdir(), "vm-validate-test-"));
		try {
			mkdirSync(join(scratch, "tmp"), { recursive: true });
			writeFileSync(join(scratch, "tmp", "poc.txt"), "proof");
			symlinkSync("/etc/hostname", join(scratch, "tmp", "link.txt"));
			symlinkSync("poc.txt", join(scratch, "tmp", "sub")); // a symlinked parent component
			writeFileSync(
				join(scratch, "tmp", "big.bin"),
				Buffer.alloc(VM_VALIDATE.collectFileBytes + 1),
			);
			const { deps } = makeDeps({
				overrides: {
					fs: {
						readFile: (path) =>
							readFileSync(join(scratch, path.replace(/^\//, ""))),
						lstat: (path) => lstatSync(join(scratch, path.replace(/^\//, ""))),
						writeFile: () => {},
					},
				},
			});
			const artifacts = promoteArtifacts(
				[
					"tmp/poc.txt",
					"tmp/link.txt",
					"tmp/big.bin",
					"tmp/sub/poc.txt",
					"../x",
					"/etc/passwd",
					"etc/passwd",
				],
				deps,
			);
			expect(artifacts[0]).toEqual({
				name: "tmp/poc.txt",
				size: 5,
				bytes: Buffer.from("proof").toString("base64"),
			});
			expect(artifacts[1]?.dropped).toContain("symlink");
			expect(artifacts[2]?.dropped).toContain("per-file cap");
			expect(artifacts[3]?.dropped).toContain("symlink");
			expect(artifacts[4]?.dropped).toContain("..");
			expect(artifacts[5]?.dropped).toContain("relative");
			expect(artifacts[6]?.dropped).toContain("scratch root");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test("the cumulative cap stops later files", () => {
		const scratch = mkdtempSync(join(tmpdir(), "vm-validate-test-"));
		try {
			mkdirSync(join(scratch, "tmp"), { recursive: true });
			writeFileSync(join(scratch, "tmp", "a.txt"), "123456"); // 6 bytes
			writeFileSync(join(scratch, "tmp", "b.txt"), "12345"); // 5 bytes: 6 + 5 > 10
			const { deps } = makeDeps({
				overrides: {
					fs: {
						readFile: (path) =>
							readFileSync(join(scratch, path.replace(/^\//, ""))),
						lstat: (path) => lstatSync(join(scratch, path.replace(/^\//, ""))),
						writeFile: () => {},
					},
					collectFileBytes: 8,
					collectTotalBytes: 10,
				},
			});
			const artifacts = promoteArtifacts(["tmp/a.txt", "tmp/b.txt"], deps);
			expect(artifacts[0]?.dropped).toBeUndefined();
			expect(artifacts[0]?.size).toBe(6);
			expect(artifacts[1]?.dropped).toContain("total cap");
			expect(artifacts[1]?.bytes).toBe("");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("encodeResult", () => {
	const base = (over: Partial<ValidateResult> = {}): ValidateResult => ({
		schema: 1,
		id: "val-test",
		selfCheck: { ok: true, checks: [] },
		missingControl: null,
		job: null,
		artifacts: [],
		endedAt: 1_700_000_000,
		...over,
	});

	test("a fitting result encodes as an 8-byte little-endian length then UTF-8 JSON", () => {
		const bytes = encodeResult(base());
		expect(bytes).not.toBeNull();
		const view = new DataView(
			bytes!.buffer,
			bytes!.byteOffset,
			bytes!.byteLength,
		);
		const length = Number(view.getBigUint64(0, true));
		expect(8 + length).toBe(bytes!.byteLength);
		const parsed = JSON.parse(
			new TextDecoder().decode(bytes!.subarray(8)),
		) as ValidateResult;
		expect(parsed.id).toBe("val-test");
	});

	test("artifacts drop largest-bytes-first until the result fits", () => {
		const big = {
			name: "big.bin",
			size: 1_200_000,
			bytes: "A".repeat(1_200_000),
		};
		const small = {
			name: "small.txt",
			size: 300_000,
			bytes: "B".repeat(300_000),
		};
		const bytes = encodeResult(base({ artifacts: [big, small] }));
		expect(bytes).not.toBeNull();
		expect(bytes!.byteLength).toBeLessThanOrEqual(VM_VALIDATE.resultDriveBytes);
		const parsed = decodeResult(bytes!);
		expect(parsed.artifacts[0]?.dropped).toBe(
			"dropped to fit the result drive",
		);
		expect(parsed.artifacts[0]?.bytes).toBe("");
		expect(parsed.artifacts[1]?.bytes).toBe("B".repeat(300_000));
	});

	test("a result that cannot fit returns null; the minimal form halves the tails", () => {
		const job = {
			argv: ["job"],
			cwd: "/target",
			exitCode: 0,
			signal: null,
			timedOut: false,
			stdoutTail: "x".repeat(2_000_000),
			stderrTail: "y".repeat(11),
		};
		const result = base({ job });
		expect(encodeResult(result)).toBeNull();
		const bytes = writeMinimalResult(result);
		expect(bytes.byteLength).toBeLessThanOrEqual(VM_VALIDATE.resultDriveBytes);
		const parsed = decodeResult(bytes);
		expect(parsed.job?.stdoutTail).toBe("x".repeat(1_000_000));
		expect(parsed.job?.stderrTail).toBe("y".repeat(5));
		expect(parsed.artifacts).toEqual([]);
	});
});

describe("runValidationMode", () => {
	test("a failed interfaces check stops the job and names network isolation", async () => {
		const written: Uint8Array[] = [];
		const { deps, spawns } = makeDeps({
			overrides: {
				readdir: () => ["lo", "eth0"],
				fs: fsWithSpec(markedSpec()),
				writeResult: async (bytes) => {
					written.push(bytes);
				},
			},
		});
		await runValidationMode(deps);
		expect(written).toHaveLength(1);
		const result = decodeResult(written[0]!);
		expect(result.missingControl).toBe(MISSING_CONTROL.network);
		expect(result.selfCheck.ok).toBe(false);
		expect(result.job).toBeNull();
		// No spawn carried the job's own argv: the probes' argv end with env or sh.
		expect(spawns.some((call) => call.argv.includes("target-job-marker"))).toBe(
			false,
		);
	});

	test("a job user that can write /dev/vdd names the promotion guard", async () => {
		const written: Uint8Array[] = [];
		const { deps, spawns } = makeDeps({
			overrides: {
				exec: async (argv) => {
					const cmd = argv[2] ?? "";
					const scratch =
						cmd.startsWith("touch /tmp/") || cmd.startsWith("touch /work/");
					const medium = cmd === ": > /dev/vdd";
					return {
						stdout: "",
						stderr: "",
						exitCode: medium || scratch ? 0 : 1,
					};
				},
				fs: fsWithSpec(markedSpec()),
				writeResult: async (bytes) => {
					written.push(bytes);
				},
			},
		});
		await runValidationMode(deps);
		const result = decodeResult(written[0]!);
		expect(result.missingControl).toBe(MISSING_CONTROL.promotion);
		expect(result.job).toBeNull();
		expect(spawns.some((call) => call.argv.includes("target-job-marker"))).toBe(
			false,
		);
	});

	test("a passing self-check runs the job once through the job spawn path", async () => {
		const spec = jobSpec({ argv: ["bun", "test", "src/parse.ts"] });
		const written: Uint8Array[] = [];
		const { deps, spawns } = makeDeps({
			overrides: {
				fs: fsWithSpec(spec),
				writeResult: async (bytes) => {
					written.push(bytes);
				},
			},
		});
		await runValidationMode(deps);
		const result = decodeResult(written[0]!);
		expect(result.missingControl).toBeNull();
		expect(result.selfCheck.ok).toBe(true);
		expect(result.job?.argv).toEqual(["bun", "test", "src/parse.ts"]);
		expect(result.job?.cwd).toBe("/target");
		expect(result.job?.exitCode).toBe(0);
		expect(result.job?.timedOut).toBe(false);
		const jobSpawns = spawns.filter((call) =>
			call.argv.includes("src/parse.ts"),
		);
		expect(jobSpawns).toHaveLength(1);
		const call = jobSpawns[0]!;
		expect(call.argv).toEqual(jobWrapper(["bun", "test", "src/parse.ts"]));
		// The exact spawn options: no uid and no gid, because the wrapper is spawned
		// with the agent's root and drops to the job user itself, after it moved into
		// the job cgroup.
		expect(call.opts).toEqual({ cwd: "/target", env: buildJobEnv() });
	});

	test("a timed-out job still carries its outcome in the result", async () => {
		// The probes must answer at once; only the job itself hangs until the kill.
		const procs: HangingProc[] = [];
		const written: Uint8Array[] = [];
		const { deps } = makeDeps({
			spawnImpl: (argv) => {
				const inner = argv.slice(3); // the wrapper argv: "sh", "-c", script, then the job argv
				if (inner[0] === "env" || inner[0] === "sh")
					return textProc(inner[0] === "env" ? envText() : limitsText(), 0);
				const proc = hangingProc(4242);
				procs.push(proc);
				return proc;
			},
			overrides: {
				fs: fsWithSpec(markedSpec()),
				killTree: () =>
					procs.forEach((proc) => {
						proc.killNow();
					}),
				timeoutSec: 0.05,
				writeResult: async (bytes) => {
					written.push(bytes);
				},
			},
		});
		await runValidationMode(deps);
		const result = decodeResult(written[0]!);
		expect(result.missingControl).toBeNull();
		expect(result.job?.timedOut).toBe(true);
		expect(result.job?.exitCode).toBeNull();
		expect(result.job?.signal).toBe("SIGKILL");
	});

	test("an invalid job spec writes a result that names it and never spawns", async () => {
		const written: Uint8Array[] = [];
		const { deps, spawns } = makeDeps({
			overrides: {
				fs: {
					readFile: () => Buffer.from("{ not json"),
					lstat: (path) => lstatSync(path),
					writeFile: () => {},
				},
				writeResult: async (bytes) => {
					written.push(bytes);
				},
			},
		});
		await runValidationMode(deps);
		expect(written).toHaveLength(1);
		const result = decodeResult(written[0]!);
		expect(result.missingControl).toBe("job spec invalid");
		expect(result.selfCheck.ok).toBe(false);
		expect(result.selfCheck.checks[0]?.name).toBe("job spec");
		expect(result.selfCheck.checks[0]?.detail).toContain("/job/job.json");
		expect(result.job).toBeNull();
		expect(spawns).toHaveLength(0);
	});

	test("an unreadable spec drive still writes a result (never throws)", async () => {
		const written: Uint8Array[] = [];
		const { deps } = makeDeps({
			overrides: {
				fs: {
					readFile: () => {
						throw new Error("no medium");
					},
					lstat: (path) => lstatSync(path),
					writeFile: () => {},
				},
				writeResult: async (bytes) => {
					written.push(bytes);
				},
			},
		});
		await runValidationMode(deps);
		const result = decodeResult(written[0]!);
		expect(result.missingControl).toBe("job spec invalid");
		expect(result.selfCheck.checks[0]?.detail).toContain("no medium");
	});

	test("runValidationMode never throws, even when the result write fails", async () => {
		const { deps } = makeDeps({
			overrides: {
				fs: {
					readFile: () => {
						throw new Error("no medium");
					},
					lstat: (path) => lstatSync(path),
					writeFile: () => {},
				},
				writeResult: async () => {
					throw new Error("drive gone");
				},
			},
		});
		await expect(runValidationMode(deps)).resolves.toBeUndefined();
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxJobOptions } from "../src/sandboxRun.ts";
import { type ValidateResponse, VM_VALIDATE } from "../src/vmValidateShared.ts";
import {
	acceptanceViolations,
	bombArgv,
	bombViolations,
	expectedEnvNames,
	main,
	parseAttempts,
	parseBomb,
	probeArgv,
	type SmokeDeps,
} from "./vm-validate-smoke.ts";

// A fixed sample line, not derived from the expected value: if the allowlist ever
// changes, the real-probe tests below catch the drift, not this fixture.
const envLine = "ATTEMPT env HOME LANG PATH";

// Belt against /data: merge and review turns run bun test inside the server
// container, where OTTR_DATA_DIR is the board's live data root. No test here
// reaches the real runSandboxJob today (every main() test injects its runner),
// but a future one that drops the dep would stage under the ambient env — point
// that at a disposable dir, and fail the file if anything ever stages in it.
// The sandbox data guard provides OTTR_TEST_DATA_ROOT: the belt then IS the
// guard's watched dir, so an ambient staging call fails here and in the guard.
const providedRoot = process.env.OTTR_TEST_DATA_ROOT;
const ambientDataRoot =
	providedRoot ?? mkdtempSync(join(tmpdir(), "ottr-sbx-smoke-ambient-"));
// Only remove and restore what this file created; the guard owns its own dir.
const ownsRoot = providedRoot === undefined;

// The sandbox staging signature: <project>/validate-jobs/<id>. The belt root may
// legally carry other OTTR_DATA_DIR consumers — ProjectStore adopts
// <dataRoot>/<store name> per board entry — so only this signature names a leak.
function sandboxStageDirs(root: string): string[] {
	const out: string[] = [];
	for (const project of readdirSync(root, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		for (const leaf of readdirSync(join(root, project.name), {
			withFileTypes: true,
		}))
			if (leaf.isDirectory() && leaf.name === "validate-jobs")
				out.push(join(project.name, leaf.name));
	}
	return out;
}
const savedDataDir = process.env.OTTR_DATA_DIR;
beforeAll(() => {
	// Both modes: in guard mode this re-establishes the value after earlier
	// files delete it, so ambient staging still lands in the belt root.
	process.env.OTTR_DATA_DIR = ambientDataRoot;
});
afterAll(() => {
	const staged = sandboxStageDirs(ambientDataRoot);
	if (savedDataDir === undefined) delete process.env.OTTR_DATA_DIR;
	else process.env.OTTR_DATA_DIR = savedDataDir;
	// The guard owns its watched dir; this file removes only what it created.
	if (ownsRoot)
		rmSync(ambientDataRoot, { recursive: true, force: true, maxRetries: 5 });
	expect(staged).toEqual([]);
});

const heldResult = (
	over: Partial<ValidateResponse> = {},
): ValidateResponse => ({
	id: "val-smoke",
	selfCheck: {
		ok: true,
		checks: [{ name: "network", ok: true, detail: "lo only" }],
	},
	missingControl: null,
	job: {
		argv: ["sh", "-c", "probe"],
		cwd: "/target",
		exitCode: 0,
		signal: null,
		timedOut: false,
		stdoutTail: [
			"ATTEMPT network blocked tcp/1.1.1.1:53 routes=",
			"ATTEMPT target-write blocked /target/.ottr-smoke",
			envLine,
		].join("\n"),
		stderrTail: "",
	},
	artifacts: [],
	limits: VM_VALIDATE,
	bootMs: null,
	totalMs: 4200,
	logTail: "",
	resultSource: "guest",
	...over,
});

describe("probeArgv", () => {
	test("attempts the network, the target write and the env read", () => {
		const [shell, flag, script] = probeArgv();
		expect(shell).toBe("sh");
		expect(flag).toBe("-c");
		expect(script).toContain("ATTEMPT network");
		expect(script).toContain("ATTEMPT target-write");
		expect(script).toContain("ATTEMPT env");
		expect(script).toContain('net.connect({host:"1.1.1.1",port:53}');
		expect(script).toContain("touch /target/.ottr-smoke");
	});
});

describe("parseAttempts", () => {
	test("splits verdict and detail, and keeps the env list whole", () => {
		const a = parseAttempts(
			[
				"ATTEMPT network blocked tcp/1.1.1.1:53 routes=",
				"ATTEMPT target-write allowed /target/.ottr-smoke",
				envLine,
				"omp noise line",
			].join("\n"),
		);
		expect(a).toHaveLength(3);
		expect(a[0]).toEqual({
			name: "network",
			verdict: "blocked",
			detail: "tcp/1.1.1.1:53 routes=",
		});
		expect(a[1]).toEqual({
			name: "target-write",
			verdict: "allowed",
			detail: "/target/.ottr-smoke",
		});
		expect(a[2]).toEqual({
			name: "env",
			verdict: expectedEnvNames,
			detail: "",
		});
	});
});

describe("acceptanceViolations", () => {
	test("a fully blocked run has no violations", () => {
		expect(acceptanceViolations(heldResult())).toEqual([]);
	});

	test("an allowed attempt, a failed self-check, a missing control and an absent result each violate", () => {
		const allowed = heldResult({
			job: {
				argv: [],
				cwd: "/target",
				exitCode: 0,
				signal: null,
				timedOut: false,
				stdoutTail: "ATTEMPT network allowed tcp/1.1.1.1:53 routes=\n",
				stderrTail: "",
			},
		});
		expect(acceptanceViolations(allowed)).toContain(
			"the network attempt was allowed, not blocked (tcp/1.1.1.1:53 routes=)",
		);
		expect(acceptanceViolations(allowed)).toContain(
			"the target-write attempt never ran",
		);
		expect(
			acceptanceViolations(
				heldResult({ selfCheck: { ok: false, checks: [] } }),
			),
		).toContain("the guest self-check did not pass");
		expect(
			acceptanceViolations(heldResult({ missingControl: "network isolation" })),
		).toContain("missing control: network isolation");
		const absent = heldResult({ resultSource: "absent", job: null });
		expect(acceptanceViolations(absent)).toContain(
			"no guest result (absent): no error line",
		);
	});

	test("an env read past the three allowlist names violates", () => {
		const extra = heldResult({
			job: {
				argv: [],
				cwd: "/target",
				exitCode: 0,
				signal: null,
				timedOut: false,
				stdoutTail: `ATTEMPT env HOME LANG PATH OTTR_LEAK\nATTEMPT network blocked x\nATTEMPT target-write blocked y`,
				stderrTail: "",
			},
		});
		const v = acceptanceViolations(extra);
		expect(v).toHaveLength(1);
		expect(v[0]).toContain('the job env was "HOME LANG PATH OTTR_LEAK"');
		expect(v[0]).toContain('not the allowlist "HOME LANG PATH"');
	});
});

/** The probe result and the bomb result share a runner; dispatch by the bomb's argv. */
const isBomb = (o: SandboxJobOptions): boolean =>
	o.argv.join(" ").includes("ottr-bomb-count");

/** A bomb result whose self-check held and whose outer shell reported `forked`. */
const heldBombResult = (forked: string): ValidateResponse =>
	heldResult({
		job: {
			argv: bombArgv(),
			cwd: "/target",
			exitCode: 0,
			signal: null,
			timedOut: false,
			stdoutTail: `FORKED=${forked}\n`,
			stderrTail: "",
		},
	});

describe("bombArgv", () => {
	test("forks detached sleeps and reports the count from the scratch file", () => {
		const argv = bombArgv();
		expect(argv[0]).toBe("sh");
		const script = argv[2] ?? "";
		expect(script).toContain("ottr-bomb-count");
		// The child forks are fully detached, so a failed fork (the pids cap) kills
		// only the inner shell and the outer still prints the last recorded count.
		expect(script).toContain("sleep 30 </dev/null >/dev/null 2>&1 &");
		expect(script).toContain('echo "FORKED=$(cat /tmp/ottr-bomb-count');
	});
});

describe("parseBomb", () => {
	test("reads the FORKED line and misses everything else", () => {
		expect(parseBomb("FORKED=254\n")).toBe(254);
		expect(parseBomb("FORKED=2000\n")).toBe(2000);
		expect(parseBomb("sh: 1: Cannot fork\n")).toBeNull();
		expect(parseBomb("FORKED=\n")).toBeNull();
	});
});

describe("bombViolations", () => {
	test("a bomb stopped at or under the cap has no violations", () => {
		expect(bombViolations(heldBombResult("254"))).toEqual([]);
		expect(bombViolations(heldBombResult("1"))).toEqual([]);
	});

	test("a past-cap bomb, a missing report, a failed self-check and a bad exit violate", () => {
		const past = bombViolations(heldBombResult("2000"));
		expect(past).toEqual([
			"the job forked 2000 times past the 256 cap: the pids limit is not live",
		]);
		const silent = heldBombResult("254");
		if (!silent.job) throw new Error("fixture lost its job");
		silent.job.stdoutTail = "";
		expect(bombViolations(silent)).toEqual([
			"the fork bomb never reported its count",
		]);
		const failed = heldBombResult("254");
		failed.selfCheck = { ok: false, checks: [] };
		failed.missingControl = "resource limits";
		expect(bombViolations(failed)).toEqual([
			"the guest self-check did not pass",
			"missing control: resource limits",
		]);
		const crashed = heldBombResult("254");
		if (!crashed.job) throw new Error("fixture lost its job");
		crashed.job.exitCode = 2;
		expect(bombViolations(crashed)).toEqual(["the fork bomb exited 2"]);
	});
});

describe("main", () => {
	type Runner = NonNullable<SmokeDeps["runner"]>;
	const lines = (argv: string[], runner: Runner) => {
		const out: string[] = [];
		const code = async () =>
			await main(argv, { runner, print: (line) => out.push(line) });
		return { code, out };
	};

	test("a held run exits 0 and prints every attempt", async () => {
		const { code, out } = lines([], async (o) => ({
			ok: true,
			result: isBomb(o) ? heldBombResult("254") : heldResult(),
		}));
		expect(await code()).toBe(0);
		expect(out.join("\n")).toContain("ATTEMPT network: blocked");
		expect(out.join("\n")).toContain(
			"fork-bomb: stopped after 254 forks (cap 256)",
		);
		expect(out.join("\n")).toContain(
			"PASS: every control held and the fork bomb stopped at the cap",
		);
	});

	test("an allowed attempt exits 1 and names the leak", async () => {
		const leaked = heldResult({
			job: {
				argv: [],
				cwd: "/target",
				exitCode: 0,
				signal: null,
				timedOut: false,
				stdoutTail:
					"ATTEMPT network allowed tcp/1.1.1.1:53\nATTEMPT target-write blocked y\n" +
					envLine,
				stderrTail: "",
			},
		});
		const { code, out } = lines([], async () => ({ ok: true, result: leaked }));
		expect(await code()).toBe(1);
		expect(out.join("\n")).toContain("NOT BLOCKED");
		expect(out.join("\n")).toContain("FAIL: the network attempt was allowed");
	});

	test("a runner refusal exits 1 with the exact blocker", async () => {
		const { code, out } = lines([], async () => ({
			ok: false,
			error: "OTTR_VM_RUNNER_URL is not set",
		}));
		expect(await code()).toBe(1);
		expect(out.join("\n")).toContain("FAIL: OTTR_VM_RUNNER_URL is not set");
	});

	test("flags reach the runner: project, ref, url and token", async () => {
		let seen: Record<string, unknown> | null = null;
		const { code } = lines(
			[
				"--project",
				"demo",
				"--ref",
				"abc123",
				"--url",
				"http://r:1",
				"--token",
				"tok",
			],
			async (o: SandboxJobOptions) => {
				seen = { ...o };
				return {
					ok: true,
					result: isBomb(o) ? heldBombResult("254") : heldResult(),
				};
			},
		);
		expect(await code()).toBe(0);
		expect(seen).toMatchObject({
			project: "demo",
			ref: "abc123",
			checkout: "/workspace/demo",
			env: { OTTR_VM_RUNNER_URL: "http://r:1", OTTR_WORKER_TOKEN: "tok" },
		});
	});

	test("a bomb past the cap exits 1 and names the leak", async () => {
		const { code, out } = lines([], async (o) => ({
			ok: true,
			result: isBomb(o) ? heldBombResult("2000") : heldResult(),
		}));
		expect(await code()).toBe(1);
		expect(out.join("\n")).toContain(
			"FAIL: the job forked 2000 times past the 256 cap: the pids limit is not live",
		);
	});

	test("a bomb that never reports exits 1", async () => {
		const silent = heldBombResult("254");
		if (!silent.job) throw new Error("fixture lost its job");
		silent.job.stdoutTail = "nothing\n";
		const { code, out } = lines([], async (o) => ({
			ok: true,
			result: isBomb(o) ? silent : heldResult(),
		}));
		expect(await code()).toBe(1);
		expect(out.join("\n")).toContain(
			"FAIL: the fork bomb never reported its count",
		);
	});
});

describe("the real probe process", () => {
	// The probe runs for real, under exactly the job env the guest would get: no
	// fixture stands in for its output.
	const jobEnv = {
		PATH: process.env.PATH ?? "",
		HOME: "/tmp",
		LANG: "C.UTF-8",
	};

	function runProbe(over?: {
		connectHost?: string;
		connectPort?: number;
		targetPath?: string;
	}): ReturnType<typeof parseAttempts> {
		const dir = mkdtempSync(join(tmpdir(), "ottr-probe-"));
		try {
			const r = Bun.spawnSync(probeArgv(over), {
				cwd: dir,
				env: jobEnv,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			return parseAttempts(r.stdout.toString());
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}

	test("the env attempt names exactly the allowlist: PWD and shell additions are filtered", () => {
		const env = runProbe().find((a) => a.name === "env");
		expect(env).toBeDefined();
		expect(env?.verdict).toBe(expectedEnvNames);
		expect(env?.verdict).not.toContain("PWD");
	});

	test("a refused connect reports blocked with the kernel reason", () => {
		// Bind a port, then close it: the next connect is refused, deterministically.
		const srv = Bun.serve({ port: 0, fetch: () => new Response("x") });
		const port = srv.port;
		srv.stop(true);
		const net = runProbe({ connectHost: "127.0.0.1", connectPort: port }).find(
			(a) => a.name === "network",
		);
		expect(net?.verdict).toBe("blocked");
		expect(net?.detail).toContain("ECONNREFUSED");
	});

	test("a missing interpreter is inconclusive, not blocked", () => {
		// bun lives only under /usr/local on this image: a worker-style PATH without it
		// must make the network attempt probe-failed, which the acceptance counts as a
		// violation, instead of a false "blocked".
		const dir = mkdtempSync(join(tmpdir(), "ottr-probe-nobun-"));
		try {
			const r = Bun.spawnSync(
				probeArgv({ connectHost: "127.0.0.1", connectPort: 1 }),
				{
					cwd: dir,
					env: { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const attempts = parseAttempts(r.stdout.toString());
			const net = attempts.find((a) => a.name === "network");
			expect(net?.verdict).toBe("probe-failed");
			const violations = acceptanceViolations({
				id: "x",
				selfCheck: { ok: true, checks: [] },
				missingControl: null,
				job: {
					argv: [],
					cwd: "/target",
					exitCode: 0,
					signal: null,
					timedOut: false,
					stdoutTail: r.stdout.toString(),
					stderrTail: "",
				},
				artifacts: [],
				limits: VM_VALIDATE,
				bootMs: null,
				totalMs: 1,
				logTail: "",
				resultSource: "guest",
			});
			expect(violations.join("\n")).toContain("probe failed: inconclusive");
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a target write into a missing directory is blocked", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-probe-t-"));
		const net = runProbe({
			targetPath: join(dir, "no-such-dir", "smoke"),
		}).find((a) => a.name === "target-write");
		expect(net?.verdict).toBe("blocked");
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	});
});

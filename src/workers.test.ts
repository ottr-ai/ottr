import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readLayerUse, rebuildLayerUse } from "./layers.ts";
import { signIns } from "./login.ts";
import { createRunSink, type RunSink } from "./runner.ts";
import type { KillExpect } from "./staleTurn.ts";
import { SWEEP_CLOCK_SKEW_MS, sweepTmpDirs } from "./tmpsweep.ts";
import {
	projectTurnUid,
	STORE_MOUNT_BLOCKED,
	type TurnIdentity,
} from "./turnUid.ts";
import {
	detachedRuns,
	feedCappedLines,
	flushCappedLines,
	killDetached,
	lineDropNotice,
	MAX_STREAM_LINE_CHARS,
	matchSweepTarget,
	probeRun,
	runWorker,
	serveWorker,
	staleFix,
	sweepWorker,
	WORKER_DONE,
	WorkerConnectError,
	type WorkerRequest,
	type WorkerTarget,
} from "./workers.ts";

const dir = mkdtempSync(join(tmpdir(), "ottr-workers-"));

// Fake omp: echoes one JSON line describing the request, then exits with code 3.
const echoPath = join(dir, "echo-omp.js");
writeFileSync(
	echoPath,
	`process.stdout.write(JSON.stringify({ argv: process.argv, cwd: process.cwd(), env: { FOO: process.env.FOO, OTTR_WORKER_TOKEN: process.env.OTTR_WORKER_TOKEN, ALATE_API_KEY: process.env.ALATE_API_KEY } }) + "\\n");
process.exit(3);`,
);

// Env-dump omp: echoes its whole env as one JSON line.
const envDumpPath = join(dir, "env-omp.js");
writeFileSync(
	envDumpPath,
	`process.stdout.write(JSON.stringify(process.env) + "\\n");`,
);

// Sleeper omp: emits a JSON event, then stays alive until killed. With a beat
// path argument it also rewrites that file every 50 ms, so a test can observe
// liveness and death (the beat stalls) without a pid liveness probe.
const sleepPath = join(dir, "sleep-omp.js");
writeFileSync(
	sleepPath,
	`process.stdout.write('{"type":"tick"}\\n');
const fs = require("node:fs");
let beat = 0;
if (process.argv[2]) setInterval(() => fs.writeFileSync(process.argv[2], String(++beat)), 50);
setTimeout(() => process.exit(0), 60000);`,
);

// Flooding omp: records its pid, then writes 4096 JSON events every millisecond until killed, so
// the pipe still holds lines when the daemon kills it.
const floodPath = join(dir, "flood-omp.js");
writeFileSync(
	floodPath,
	`require("node:fs").writeFileSync(process.argv[2], String(process.pid));
const burst = '{"type":"tick"}\\n'.repeat(4096);
setInterval(() => process.stdout.write(burst), 1);`,
);

// Scratch omp: prints "<TMPDIR> <OTTR_TMP_ROOT> <BUN_INSTALL_CACHE_DIR>", writes a
// file into its TMPDIR, then stays alive until killed — the test observes the
// scratch live, then gone at run end. The write lands before the print, so the
// test's first read proves the file exists.
const scratchPath = join(dir, "scratch-omp.js");
writeFileSync(
	scratchPath,
	`const fs = require("node:fs");
fs.writeFileSync(require("node:path").join(process.env.TMPDIR, "used"), "x");
process.stdout.write([process.env.TMPDIR, process.env.OTTR_TMP_ROOT, process.env.BUN_INSTALL_CACHE_DIR].join(" ") + "\\n");
setInterval(() => {}, 1000);`,
);

// Quiet scratch omp: prints only its TMPDIR and never writes — the scratch stays at
// its creation mtime, the shape the sweep's live-run guard must protect a day later.
const quietScratchPath = join(dir, "quiet-scratch-omp.js");
writeFileSync(
	quietScratchPath,
	`process.stdout.write(process.env.TMPDIR + "\\n");
setInterval(() => {}, 1000);`,
);

// Probe stub: one JSON line naming the marker, the paths a probe run saw (cwd, HOME,
// TMPDIR), and the credential names it must never hold. The tests pick the line by
// the marker.
const probeStubPath = join(dir, "probe-omp.js");
writeFileSync(
	probeStubPath,
	`process.stdout.write(JSON.stringify({
	marker: "probe-ran",
	pwd: process.cwd(),
	home: process.env.HOME,
	tmp: process.env.TMPDIR,
	token: process.env.OTTR_WORKER_TOKEN,
	hindsight: Object.keys(process.env).filter((k) => k.startsWith("HINDSIGHT_")),
}) + "\\n");`,
);

// Pid-writing sleeper omp: drops its pid, then stays alive until killed. The sweep test
// uses it as the live run child whose worktree disappears mid-run. Optional beat
// file as argv[3], same 50 ms heartbeat.
const sweepSleepPath = join(dir, "sweep-sleep-omp.js");
writeFileSync(
	sweepSleepPath,
	`require("node:fs").writeFileSync(process.argv[2], String(process.pid));
const fs = require("node:fs");
let beat = 0;
if (process.argv[3]) setInterval(() => fs.writeFileSync(process.argv[3], String(++beat)), 50);
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 60000);`,
);

// Linger omp: emits one stderr line, then exits on its own a bit later — the
// detached run that finishes without a client attached.
const lingerPath = join(dir, "linger-omp.js");
writeFileSync(
	lingerPath,
	`process.stdout.write('{"type":"tick"}\\n');
process.stderr.write("detach tail\\n");
setTimeout(() => process.exit(7), 2000);`,
);

// OOM grow + self-kill omp: rewrites the memory.events fixture it receives as argv[2]
// to a grown oom_kill count, then kills itself with SIGKILL — the end shape a kernel
// OOM kill gives the daemon (close with no exit code). A child the test created may
// signal itself.
const oomGrowKillPath = join(dir, "oom-grow-kill-omp.js");
writeFileSync(
	oomGrowKillPath,
	`require("node:fs").writeFileSync(process.argv[2], "low 0\\nhigh 0\\nmax 0\\noom 0\\noom_kill 7\\n");
process.kill(process.pid, "SIGKILL");`,
);

// OOM grow + exit omp: grows the same fixture, then ends with an exit code — the
// shape that must never flag OOM even when the count grew.
const oomGrowExitPath = join(dir, "oom-grow-exit-omp.js");
writeFileSync(
	oomGrowExitPath,
	`require("node:fs").writeFileSync(process.argv[2], "low 0\\nhigh 0\\nmax 0\\noom 0\\noom_kill 7\\n");
process.exit(3);`,
);

// OOM self-kill omp: kills itself without touching the fixture, so the count never
// grows while the run lives.
const oomKillPath = join(dir, "oom-kill-omp.js");
writeFileSync(oomKillPath, `process.kill(process.pid, "SIGKILL");`);

// Every test below that runs one of these fakes through serveWorker or runWorker spawns a real
// bun child, and child boot is unbounded under concurrent machine load (past 4 s observed).
// Such tests carry a 30 s budget: the 5 s default bounds the machine, not the assertions.

const servers: Bun.Server<never>[] = [];
const workerHomes: string[] = [];
afterAll(() => {
	for (const s of servers) s.stop(true);
	for (const h of workerHomes) rmSync(h, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});

// Port 0: the OS picks a free port. Fixed ports collided when two suites ran at once
// (Stryker runs 16), and the EADDRINUSE failure counted as a killed mutant.
function start(opts: Parameters<typeof serveWorker>[0] = {}) {
	const server = serveWorker({ port: 0, ...opts });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

// The tools install path pins https:// downloads and parseToolsJson refuses every other
// scheme, so a plain HTTP listener cannot serve a tools.json entry. Same shim as
// tools.test.ts: the fixture host maps to in-memory bodies and records hits, so a test can
// assert a planted url was never fetched; everything past fetch (hash, unpack, rename) is real.
const hits: Record<string, number> = {};
const bodies: Record<string, Uint8Array> = {};
const HOST = "https://fixtures.ottr.test";
const realFetch = globalThis.fetch;
beforeAll(() => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.startsWith(`${HOST}/`)) return realFetch(input, init);
		const path = url.slice(HOST.length);
		hits[path] = (hits[path] ?? 0) + 1;
		const body = bodies[path];
		return new Response(body === undefined ? null : (body as BodyInit), {
			status: body === undefined ? 404 : 200,
		});
	}) as typeof fetch;
});

let fixtureN = 0;
function serveFile(body: Uint8Array): string {
	const path = `/fixture-${fixtureN++}`;
	bodies[path] = body;
	return `${HOST}${path}`;
}

const sha256 = (bytes: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A fresh provisioning home for the worker server (cleaned up in afterAll). */
function freshWorkerHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ottr-worker-home-"));
	workerHomes.push(h);
	return h;
}

/** Plants a provisioning list file the way a past worker turn would have (the shared home). */
function plant(
	project: string,
	file: string,
	text: string,
	home: string,
): void {
	mkdirSync(join(home, ".ottr", "workers", project), { recursive: true });
	writeFileSync(join(home, ".ottr", "workers", project, file), text);
}

/** Real sink plumbing with a recording wrapper; log files land in the temp dir. */
let sinkN = 0;
function fakeSink(): RunSink & { lines: string[] } {
	const base = createRunSink({
		logPath: join(dir, `sink-${sinkN++}.log`),
		dataRoot: dir,
	});
	const lines: string[] = [];
	return {
		...base,
		lines,
		line: (raw: string) => {
			lines.push(`${raw}\n`);
			base.line(raw);
		},
		logMark: (text: string) => {
			lines.push(text);
			base.logMark(text);
		},
		stderrLine: (line: string) => {
			lines.push(`! ${line}\n`);
			base.stderrLine(line);
		},
	};
}

// Helpers shared by the sweep and detach describes: every sweep a test runs
// scans a fake proc tree through a recording kill, so no test can ever signal a
// pid it did not create — not even under a Stryker mutant that widens the target
// set (dropping the match guard would otherwise make every process in the
// container a target and kill the worker itself).

// Pure recording kill for fake proc scans: no signal ever leaves the test.
function recordingKill() {
	const calls: { pid: number; signal: string | number }[] = [];
	const kill = (pid: number, signal?: number | string): true => {
		calls.push({ pid, signal: signal ?? 0 });
		return true;
	};
	return { calls, kill };
}

// Fake proc tree: exactly the files sweepLeftovers reads — stat (the ppid field
// after the last ")"), cwd (the readlink target, which may dangle and may carry
// the kernel's " (deleted)" marker), cmdline (NUL-separated argv).
let fakeProcN = 0;
type FakeProcEntry = {
	pid: number;
	ppid?: number;
	cwd?: string;
	cmd?: string[];
};
function fakeProcEntry(procRoot: string, e: FakeProcEntry): void {
	const p = join(procRoot, String(e.pid));
	mkdirSync(p, { recursive: true });
	writeFileSync(join(p, "stat"), `${e.pid} (bun) S ${e.ppid ?? 1} 0 0\n`);
	if (e.cwd) symlinkSync(e.cwd, join(p, "cwd"));
	writeFileSync(
		join(p, "cmdline"),
		(e.cmd ?? ["bun", "run", "dev"]).map((seg) => `${seg}\0`).join(""),
	);
}

function makeFakeProc(entries: FakeProcEntry[]): string {
	const procRoot = join(dir, `fake-proc-${fakeProcN++}`);
	for (const e of entries) fakeProcEntry(procRoot, e);
	return procRoot;
}

// Child liveness and death, observable without a pid liveness probe (no signal
// call, no proc read — banned in this file so a widening sweep mutant can never
// find a real target): the fake omp children rewrite a beat file every 50 ms,
// and SIGKILL cannot be caught or reported, so the only test-side proof that a
// kill landed is the beat stalling.
function readBeat(hbPath: string): string {
	try {
		return readFileSync(hbPath, "utf8");
	} catch {
		return "";
	}
}

async function awaitBeatAdvance(
	hbPath: string,
	prev: string,
	what: string,
): Promise<void> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const beat = readBeat(hbPath);
		if (beat !== prev && beat !== "") return;
		if (Date.now() > deadline) throw new Error(`${what}: never happened`);
		await Bun.sleep(20);
	}
}

async function awaitBeatStall(hbPath: string, what: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	let prev: string | undefined;
	let prevAt = 0;
	for (;;) {
		const beat = readBeat(hbPath);
		const now = Date.now();
		if (beat !== prev) {
			prev = beat;
			prevAt = now;
		} else if (prev !== "" && prev !== undefined && now - prevAt > 1500)
			// Frozen for many beat intervals (50 ms each): the child is gone.
			return;
		if (Date.now() > deadline) throw new Error(`${what}: never happened`);
		await Bun.sleep(20);
	}
}

async function readLines(res: Response): Promise<string[]> {
	const text = await res.text();
	return text.split("\n").filter((l) => l.length > 0);
}

describe("serveWorker", () => {
	test("healthz returns ok; other paths 404", async () => {
		const url = start();
		expect(await (await fetch(`${url}/healthz`)).text()).toBe("ok");
		expect((await fetch(`${url}/nope`)).status).toBe(404);
		expect((await fetch(`${url}/run`, { method: "GET" })).status).toBe(404);
	});

	test("the daemon refuses to boot without OTTR_WORKER_TOKEN", () => {
		// src/worker.ts exits 1 before binding the port; the timeout only bounds an old
		// binary that would otherwise serve forever on 0.0.0.0:8787. 15 s: it must also
		// outlast a loaded boot, or it races this test's own budget.
		const r = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "worker.ts")],
			{
				env: { ...process.env, OTTR_WORKER_TOKEN: "" },
				stdout: "pipe",
				stderr: "pipe",
				timeout: 15_000,
			},
		);
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain("OTTR_WORKER_TOKEN is required");
	}, 30_000);

	test("token mismatch is 401; matching token passes", async () => {
		const url = start({ token: "sekrit", ompPath: process.execPath });
		const req = {
			id: "r1",
			argv: ["-p"],
			cwd: dir,
			stdin: "",
			env: {},
		};
		expect(
			(
				await fetch(`${url}/run`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(req),
				})
			).status,
		).toBe(401);
		expect(
			(
				await fetch(`${url}/run`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-otwr-token": "sekrit",
					},
					body: JSON.stringify(req),
				})
			).status,
		).toBe(200);
	}, 30_000);

	test("bad argv/cwd is 400", async () => {
		const url = start();
		for (const body of [
			{ argv: "nope", cwd: dir },
			{ argv: [], cwd: "Z:/definitely/not/here" },
		]) {
			expect(
				(
					await fetch(`${url}/run`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					})
				).status,
			).toBe(400);
		}
	});

	test("stdout streams verbatim; sentinel carries exit code and stderr tail; request arrives intact", async () => {
		const url = start({ ompPath: process.execPath });
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "r2",
				argv: [echoPath, "--mode", "json", "--flag"],
				cwd: dir,
				stdin: "the prompt",
				env: { FOO: "bar" },
			}),
		});
		expect(res.status).toBe(200);
		const lines = await readLines(res);
		expect(lines.length).toBe(2);
		const echoed = JSON.parse(lines[0]!) as {
			argv: string[];
			cwd: string;
			env: Record<string, string>;
		};
		// bun's argv layout differs from node's; the tail proves argv passed through.
		expect(echoed.argv.join(" ").endsWith("--mode json --flag")).toBe(true);
		expect(echoed.argv.some((a) => a.endsWith("echo-omp.js"))).toBe(true);
		expect(echoed.cwd).toBe(dir);
		expect(echoed.env.FOO).toBe("bar");
		const sentinel = JSON.parse(lines[1]!) as {
			[WORKER_DONE]: {
				exitCode: number | null;
				stderrTail: string;
				host: string;
			};
		};
		expect(sentinel[WORKER_DONE].exitCode).toBe(3);
		expect(sentinel[WORKER_DONE].stderrTail).toBe("");
		expect(typeof sentinel[WORKER_DONE].host).toBe("string");
		expect(sentinel[WORKER_DONE].host.length).toBeGreaterThan(0);
	}, 30_000);

	test("omp never sees the worker's own token, from its env or the request", async () => {
		const saved = process.env.OTTR_WORKER_TOKEN;
		const savedAlate = process.env.ALATE_API_KEY;
		process.env.OTTR_WORKER_TOKEN = "worker-secret";
		// Same class of credential as the worker token: the daemon env can hold the
		// alate bearer key (compose passes it through), and a turn must never inherit it.
		process.env.ALATE_API_KEY = "alate-secret";
		try {
			const url = start({ ompPath: process.execPath });
			const res = await fetch(`${url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "r-token",
					argv: [echoPath],
					cwd: dir,
					stdin: "",
					env: {
						FOO: "bar",
						OTTR_WORKER_TOKEN: "forwarded",
						ALATE_API_KEY: "forwarded",
					},
				}),
			});
			const echoed = JSON.parse((await readLines(res))[0] ?? "") as {
				env: Record<string, string>;
			};
			expect(echoed.env).toEqual({ FOO: "bar" });
		} finally {
			if (saved === undefined) delete process.env.OTTR_WORKER_TOKEN;
			else process.env.OTTR_WORKER_TOKEN = saved;
			if (savedAlate === undefined) delete process.env.ALATE_API_KEY;
			else process.env.ALATE_API_KEY = savedAlate;
		}
	}, 30_000);

	test("omp never inherits a git host token, from the container env or the request", async () => {
		const planted: Record<string, string> = {
			GH_TOKEN: "ghp_operator",
			GITHUB_TOKEN: "ghp_operator2",
			GIT_ASKPASS: "/bin/askpass",
			GIT_SSH_COMMAND: "ssh -i /key",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "credential.helper",
			GIT_CONFIG_VALUE_0: "!echo",
			OTTR_GIT_TOKEN_0: "glpat_x",
			OTTR_GIT_USER_0: "oauth2",
		};
		const saved = Object.fromEntries(
			[...Object.keys(planted), "OTTR_PROBE_KEPT"].map((k) => [
				k,
				process.env[k],
			]),
		);
		Object.assign(process.env, planted, { OTTR_PROBE_KEPT: "kept" });
		try {
			const url = start({ ompPath: process.execPath });
			const res = await fetch(`${url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "r-git-auth",
					argv: [envDumpPath],
					cwd: dir,
					stdin: "",
					env: { FOO: "bar", GH_TOKEN: "ghp_forwarded" },
				}),
			});
			const env = JSON.parse((await readLines(res))[0] ?? "") as Record<
				string,
				string
			>;
			for (const k of Object.keys(planted)) expect(env).not.toHaveProperty(k);
			// The strip is by name: the rest of the container env and the request still travel.
			expect(env).toHaveProperty("OTTR_PROBE_KEPT", "kept");
			expect(env).toHaveProperty("FOO", "bar");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}, 30_000);

	test("worker children retain test variables but reject production URLs from every source", async () => {
		const inherited = {
			OTTR_DATABASE_URL: crypto.randomUUID(),
			OTTR_TEST_PG_URL: `postgres://localhost/${crypto.randomUUID()}`,
			OTTR_REQUIRE_PG_TESTS: "1",
		};
		const saved = Object.fromEntries(
			Object.keys(inherited).map((key) => [key, process.env[key]]),
		);
		Object.assign(process.env, inherited);
		try {
			const url = start({ ompPath: process.execPath });
			for (const source of ["daemon", "request", "githubReadEnv"]) {
				const requestEnv =
					source === "request"
						? {
								OTTR_DATABASE_URL: crypto.randomUUID(),
								OTTR_TEST_PG_URL: `postgres://localhost/${crypto.randomUUID()}`,
								OTTR_REQUIRE_PG_TESTS: "0",
							}
						: {};
				const res = await fetch(`${url}/run`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						id: `r-database-${source}`,
						argv: [envDumpPath],
						cwd: dir,
						stdin: "",
						env: requestEnv,
						...(source === "githubReadEnv"
							? { githubReadEnv: { OTTR_DATABASE_URL: crypto.randomUUID() } }
							: {}),
					}),
				});
				expect(res.status).toBe(200);
				const env = JSON.parse((await readLines(res))[0] ?? "") as Record<
					string,
					string
				>;
				expect(env).not.toHaveProperty("OTTR_DATABASE_URL");
				expect(env.OTTR_TEST_PG_URL).toBe(
					requestEnv.OTTR_TEST_PG_URL ?? inherited.OTTR_TEST_PG_URL,
				);
				expect(env.OTTR_REQUIRE_PG_TESTS).toBe(
					requestEnv.OTTR_REQUIRE_PG_TESTS ?? inherited.OTTR_REQUIRE_PG_TESTS,
				);
			}
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}, 30_000);

	test("the delivered githubReadEnv reaches omp after the strips and overrides ambient names", async () => {
		const planted: Record<string, string> = {
			GH_ENTERPRISE_TOKEN: "ghp_container_ent",
			GITHUB_ENTERPRISE_TOKEN: "ghp_container_ent2",
		};
		const saved = Object.fromEntries(
			Object.keys(planted).map((k) => [k, process.env[k]]),
		);
		Object.assign(process.env, planted);
		try {
			const url = start({ ompPath: process.execPath });
			const res = await fetch(`${url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "r-read-token",
					argv: [envDumpPath],
					cwd: dir,
					stdin: "",
					// Every ambient name, in the request env too: only the delivered
					// read-only token may survive the strips.
					env: {
						GH_TOKEN: "ambient-classic",
						GITHUB_TOKEN: "ambient-classic2",
						GH_ENTERPRISE_TOKEN: "ambient-ent",
						GITHUB_ENTERPRISE_TOKEN: "ambient-ent2",
					},
					githubReadEnv: { GH_TOKEN: "tok-read" },
				}),
			});
			const env = JSON.parse((await readLines(res))[0] ?? "") as Record<
				string,
				string
			>;
			// The delivered token lands; no other GitHub token name survives anywhere.
			expect(env).toHaveProperty("GH_TOKEN", "tok-read");
			expect(env).not.toHaveProperty("GITHUB_TOKEN");
			expect(env).not.toHaveProperty("GH_ENTERPRISE_TOKEN");
			expect(env).not.toHaveProperty("GITHUB_ENTERPRISE_TOKEN");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}, 30_000);

	test("omp never sees proxy credentials, from the container env or the request", async () => {
		const planted: Record<string, string> = {
			HTTP_PROXY: "http://user:pass@proxy:8080",
			HTTPS_PROXY: "http://user:pass@proxy:8080",
			ALL_PROXY: "socks5://user:pass@proxy:1080",
			// The test's own fetches to the loopback daemon must bypass the planted proxy.
			NO_PROXY: "127.0.0.1,localhost",
		};
		const saved = Object.fromEntries(
			Object.keys(planted).map((k) => [k, process.env[k]]),
		);
		Object.assign(process.env, planted);
		try {
			const url = start({ ompPath: process.execPath });
			const res = await fetch(`${url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "r-proxy",
					argv: [envDumpPath],
					cwd: dir,
					stdin: "",
					env: {
						http_proxy: "http://forwarded:creds@proxy:8080",
						HTTPS_PROXY: "http://proxy:8080",
						NO_PROXY: "localhost,127.0.0.1",
					},
				}),
			});
			const env = JSON.parse((await readLines(res))[0] ?? "") as Record<
				string,
				string
			>;
			expect(env.HTTP_PROXY).toBe("http://proxy:8080");
			expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
			expect(env.ALL_PROXY).toBe("socks5://proxy:1080");
			expect(env.http_proxy).toBe("http://proxy:8080");
			// NO_PROXY is a host list, never a URL: it travels untouched.
			expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}, 30_000);

	test("stderr accumulates into the sentinel tail", async () => {
		const errPath = join(dir, "err-omp.js");
		writeFileSync(
			errPath,
			`process.stderr.write("boom one\\r\\nboom two\\n");process.exit(1);`,
		);
		const url = start({ ompPath: process.execPath });
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "r3",
				argv: [errPath],
				cwd: dir,
				stdin: "",
				env: {},
			}),
		});
		const lines = await readLines(res);
		const sentinel = JSON.parse(lines.at(-1)!) as {
			[WORKER_DONE]: {
				exitCode: number | null;
				stderrTail: string;
				host: string;
			};
		};
		expect(sentinel[WORKER_DONE].exitCode).toBe(1);
		expect(sentinel[WORKER_DONE].stderrTail).toBe("boom one\nboom two\n");
		expect(typeof sentinel[WORKER_DONE].host).toBe("string");
		expect(sentinel[WORKER_DONE].host.length).toBeGreaterThan(0);
	}, 30_000);

	test("the request's package list installs before omp; its notes ride stdout, not the stderr tail", async () => {
		const asked: string[][] = [];
		const url = start({
			ompPath: process.execPath,
			ensurePackages: async (names) => {
				asked.push(names);
				return ["apt: installed libnss3"];
			},
		});
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "r5",
				argv: [echoPath],
				cwd: dir,
				stdin: "",
				env: { OTTR_PROJECT: "velvarr" },
				lists: { apt: "libnss3\n" },
			}),
		});
		const lines = await readLines(res);
		const sentinel = JSON.parse(lines.at(-1)!) as {
			[WORKER_DONE]: {
				exitCode: number | null;
				stderrTail: string;
				host: string;
			};
		};
		// The core got the request's parsed names, not a project name to read files for.
		expect(asked).toEqual([["libnss3"]]);
		expect(sentinel[WORKER_DONE].exitCode).toBe(3); // omp still ran
		// The notes streamed as a plain line before the sentinel; the sentinel's tail holds
		// only omp's stderr, so classify's no-stderr death rules still fire.
		// readLines strips the trailing \n: the notes are one complete line of their own,
		// apart from omp's first line (the echo JSON) and the sentinel.
		expect(lines[0]).toBe("apt: installed libnss3");
		expect(JSON.parse(lines[1]!)).toHaveProperty("argv");
		expect(lines).toHaveLength(3);
		expect(sentinel[WORKER_DONE].stderrTail).toBe("");
		expect(typeof sentinel[WORKER_DONE].host).toBe("string");
		expect(sentinel[WORKER_DONE].host.length).toBeGreaterThan(0);
	}, 30_000);

	test("a failed install ends the run with apt's error, and omp never starts", async () => {
		const marker = join(dir, "omp-started");
		const markPath = join(dir, "mark-omp.js");
		writeFileSync(
			markPath,
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");`,
		);
		const url = start({
			ompPath: process.execPath,
			ensurePackages: async () => {
				throw new Error(
					"apt: apt-get install failed (exit 100): E: Unable to locate package nope",
				);
			},
		});
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "r6",
				argv: [markPath],
				cwd: dir,
				stdin: "",
				env: { OTTR_PROJECT: "p" },
			}),
		});
		expect(res.status).toBe(200);
		const lines = await readLines(res);
		expect(lines).toHaveLength(1);
		const sentinel = JSON.parse(lines[0]!) as {
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
		};
		expect(sentinel[WORKER_DONE].exitCode).toBe(1);
		expect(sentinel[WORKER_DONE].stderrTail).toContain(
			"Unable to locate package nope",
		);
		expect(existsSync(marker)).toBe(false);
	});

	test("a failed tools install ends the run like a failed apt install", async () => {
		const marker = join(dir, "omp-started-tools");
		const markPath = join(dir, "mark-omp-tools.js");
		writeFileSync(
			markPath,
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");`,
		);
		const url = start({
			ompPath: process.execPath,
			ensureTools: async () => {
				throw new Error("tools: pip install failed (exit 1): nope");
			},
		});
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "r6b",
				argv: [markPath],
				cwd: dir,
				stdin: "",
				env: { OTTR_PROJECT: "p" },
			}),
		});
		expect(res.status).toBe(200);
		const lines = await readLines(res);
		expect(lines).toHaveLength(1);
		const sentinel = JSON.parse(lines[0]!) as {
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
		};
		expect(sentinel[WORKER_DONE].exitCode).toBe(1);
		expect(sentinel[WORKER_DONE].stderrTail).toContain(
			"pip install failed (exit 1)",
		);
		expect(existsSync(marker)).toBe(false);
	});

	test("the tools link dir prefixes only the child's PATH; its notes ride stdout", async () => {
		// Real omp fake: reports the PATH it saw, so the test checks the spawned env.
		const pathEchoPath = join(dir, "echo-path.js");
		writeFileSync(
			pathEchoPath,
			`process.stdout.write(JSON.stringify({ path: process.env.PATH }) + "\\n");process.exit(0);`,
		);
		const linkDir = join(dir, "tools-link");
		const containerPath = "/usr/local/bin:/usr/bin";
		const asked: string[][] = [];
		const url = start({
			ompPath: process.execPath,
			ensureTools: async (entries) => {
				asked.push(entries.map((e) => e.name));
				return ["tools: installed ruff"];
			},
			buildPath: () => linkDir,
		});
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "r7",
				argv: [pathEchoPath],
				cwd: dir,
				stdin: "",
				env: { OTTR_PROJECT: "velvarr", PATH: containerPath },
			}),
		});
		const lines = await readLines(res);
		const sentinel = JSON.parse(lines.at(-1)!) as {
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
		};
		// The request carried no tools lists, so the core got no entries.
		expect(asked).toEqual([[]]);
		expect(lines[0]).toBe("tools: installed ruff");
		expect(JSON.parse(lines[1]!) as { path: string }).toEqual({
			path: `${linkDir}:${containerPath}`,
		});
		expect(sentinel[WORKER_DONE].exitCode).toBe(0);
	}, 30_000);

	test("no OTTR_PROJECT: no tools install and no PATH prefix", async () => {
		let toolsAsked = false;
		let pathAsked = false;
		const pathEchoPath = join(dir, "echo-path.js");
		writeFileSync(
			pathEchoPath,
			`process.stdout.write(JSON.stringify({ path: process.env.PATH }) + "\\n");process.exit(0);`,
		);
		const containerPath = "/usr/local/bin:/usr/bin";
		const url = start({
			ompPath: process.execPath,
			ensureTools: async () => {
				toolsAsked = true;
				return [];
			},
			buildPath: () => {
				pathAsked = true;
				return join(dir, "never");
			},
		});
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "r8",
				argv: [pathEchoPath],
				cwd: dir,
				stdin: "",
				env: { PATH: containerPath },
			}),
		});
		const lines = await readLines(res);
		expect(toolsAsked).toBe(false);
		expect(pathAsked).toBe(false);
		expect(JSON.parse(lines[0]!) as { path: string }).toEqual({
			path: containerPath,
		});
		expect(lines).toHaveLength(2);
	}, 30_000);

	test("bad lists shapes answer 400 before any provisioning", async () => {
		const url = start();
		for (const lists of [
			"nope",
			5,
			[],
			{ tools: 5 },
			{ apt: null },
			{ requirementsAll: ["x"] },
		] as unknown[]) {
			expect(
				(
					await fetch(`${url}/run`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							id: "lists-shape",
							argv: [echoPath],
							cwd: dir,
							stdin: "",
							env: { OTTR_PROJECT: "p" },
							lists,
						}),
					})
				).status,
			).toBe(400);
		}
	});

	test("a broken list ends the run with the parser's message naming the list", async () => {
		const url = start({ ompPath: process.execPath });
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "lists-broken",
				argv: [echoPath],
				cwd: dir,
				stdin: "",
				env: { OTTR_PROJECT: "p" },
				lists: { apt: "--allow-unauthenticated\n" },
			}),
		});
		expect(res.status).toBe(200);
		const lines = await readLines(res);
		expect(lines).toHaveLength(1);
		const sentinel = JSON.parse(lines[0]!) as {
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
		};
		expect(sentinel[WORKER_DONE].exitCode).toBe(1);
		expect(sentinel[WORKER_DONE].stderrTail).toContain(
			"apt: not a Debian package name",
		);
		expect(sentinel[WORKER_DONE].stderrTail).toContain("(request field: apt)");
	}, 30_000);

	// The shared home the worker runs with is worker-writable (home:/root on compose), so
	// a past turn could plant tools.json / apt.txt / requirements.txt there for any project.
	// The provisioning lists ride the /run request instead, and the daemon provisions from
	// those texts only (docs/specs/worker-list-isolation.md).
	const PLANT_PROJECT = "victim";
	const plantedBytes = new TextEncoder().encode("#!/bin/sh\necho planted\n");
	const plantedSha = sha256(plantedBytes);

	function plantSharedHome(home: string): void {
		plant(
			PLANT_PROJECT,
			"tools.json",
			JSON.stringify([
				{
					name: "planted",
					url: `${HOST}/planted-tool`,
					sha256: plantedSha,
					unpack: "none",
				},
			]),
			home,
		);
		plant(PLANT_PROJECT, "apt.txt", "planted-pkg\n", home);
		plant(
			PLANT_PROJECT,
			"requirements.txt",
			`plantedpkg==1.0 --hash=sha256:${"b".repeat(64)}\n`,
			home,
		);
	}

	test("the request's lists provision; the shared home's plants never do", async () => {
		const home = freshWorkerHome();
		plantSharedHome(home);
		const trustedBytes = new TextEncoder().encode("#!/bin/sh\necho trusted\n");
		const trustedSha = sha256(trustedBytes);
		const trustedUrl = serveFile(trustedBytes);
		// Real tools install and real link dir (no injection); capture fakes only where the
		// real command would apt-get install or pip-build on this machine.
		const aptAsked: string[][] = [];
		const pipAsked: string[][] = [];
		const pathEchoPath = join(dir, "echo-path-lists.js");
		writeFileSync(
			pathEchoPath,
			`process.stdout.write(JSON.stringify({ path: process.env.PATH }) + "\\n");process.exit(0);`,
		);
		const containerPath = "/usr/local/bin:/usr/bin";
		const url = start({
			ompPath: process.execPath,
			home,
			ensurePackages: async (names) => {
				aptAsked.push(names);
				return [];
			},
			ensurePython: async (reqs) => {
				pipAsked.push(reqs.map((r) => r.name));
				return [];
			},
		});
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "lists-plant",
				argv: [pathEchoPath],
				cwd: dir,
				stdin: "",
				env: { OTTR_PROJECT: PLANT_PROJECT, PATH: containerPath },
				lists: {
					tools: JSON.stringify([
						{
							name: "trusted",
							url: trustedUrl,
							sha256: trustedSha,
							unpack: "none",
						},
					]),
					apt: "libnss3\n",
					requirements: `idna==3.10 --hash=sha256:${"a".repeat(64)}\n`,
				},
			}),
		});
		const lines = await readLines(res);
		const sentinel = JSON.parse(lines.at(-1)!) as {
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
		};
		expect(sentinel[WORKER_DONE].exitCode).toBe(0);
		// The trusted tool went through the real fetch + install path into the worker home.
		expect(lines[0]).toBe(
			`tools: installed trusted (${trustedSha.slice(0, 12)})`,
		);
		expect(hits[new URL(trustedUrl).pathname]).toBe(1);
		expect(
			existsSync(join(home, ".ottr", "tools", trustedSha, "trusted")),
		).toBe(true);
		// The child's PATH dir links the trusted tool and no planted name.
		const child = JSON.parse(lines[1]!) as { path: string };
		const pathDir = child.path.split(":")[0]!;
		expect(pathDir.startsWith(join(home, ".ottr", "tools", "path-"))).toBe(
			true,
		);
		expect(readlinkSync(join(pathDir, "trusted"))).toBe(
			join(home, ".ottr", "tools", trustedSha, "trusted"),
		);
		expect(existsSync(join(pathDir, "planted"))).toBe(false);
		// The planted entry's url was never fetched and never installed.
		expect(hits["/planted-tool"] ?? 0).toBe(0);
		expect(existsSync(join(home, ".ottr", "tools", plantedSha))).toBe(false);
		// apt and pip saw only the request lists' content, never the planted files'.
		expect(aptAsked).toEqual([["libnss3"]]);
		expect(pipAsked).toEqual([["idna"]]);
	}, 30_000);

	test("no lists field: the plants provision nothing and no PATH dir is built", async () => {
		const home = freshWorkerHome();
		plantSharedHome(home);
		const aptAsked: string[][] = [];
		const pipAsked: string[][] = [];
		const pathEchoPath = join(dir, "echo-path-nolists.js");
		writeFileSync(
			pathEchoPath,
			`process.stdout.write(JSON.stringify({ path: process.env.PATH }) + "\\n");process.exit(0);`,
		);
		const containerPath = "/usr/local/bin:/usr/bin";
		const url = start({
			ompPath: process.execPath,
			home,
			ensurePackages: async (names) => {
				aptAsked.push(names);
				return [];
			},
			ensurePython: async (reqs) => {
				pipAsked.push(reqs.map((r) => r.name));
				return [];
			},
		});
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "lists-absent",
				argv: [pathEchoPath],
				cwd: dir,
				stdin: "",
				env: { OTTR_PROJECT: PLANT_PROJECT, PATH: containerPath },
			}),
		});
		const lines = await readLines(res);
		const sentinel = JSON.parse(lines.at(-1)!) as {
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
		};
		expect(sentinel[WORKER_DONE].exitCode).toBe(0);
		// No fallback read: the child runs on the container PATH, nothing installs or links.
		expect(JSON.parse(lines[0]!) as { path: string }).toEqual({
			path: containerPath,
		});
		expect(aptAsked).toEqual([[]]);
		expect(pipAsked).toEqual([[]]);
		expect(hits["/planted-tool"] ?? 0).toBe(0);
		expect(existsSync(join(home, ".ottr", "tools"))).toBe(false);
	}, 30_000);

	test("client abort kills the child: the response ends without a sentinel", async () => {
		const url = start({ ompPath: process.execPath });
		const controller = new AbortController();
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "r4",
				argv: [sleepPath],
				cwd: dir,
				stdin: "",
				env: {},
			}),
			signal: controller.signal,
		});
		const reader = res.body!.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe('{"type":"tick"}\n');
		controller.abort();
		// The daemon kills the child on abort, which ends the response; the awaited
		// read itself is the signal, so no wall-clock wait is needed.
		try {
			const r = await reader.read();
			expect(r.done).toBe(true);
		} catch {
			// an aborted stream equally proves the child is gone
		}
	}, 15000);

	test("the run's private scratch dies when the run ends (OTTR-1211)", async () => {
		const homes = mkdtempSync(join(tmpdir(), "ottr-homes-"));
		const savedHomes = process.env.OTTR_TURN_HOMES;
		process.env.OTTR_TURN_HOMES = homes;
		try {
			const url = start({ ompPath: process.execPath });
			const controller = new AbortController();
			const res = await fetch(`${url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "r-scratch",
					argv: [scratchPath],
					cwd: dir,
					stdin: "",
					env: {},
					project: "alpha",
				}),
				signal: controller.signal,
			});
			const reader = res.body!.getReader();
			const firstLine = new TextDecoder().decode((await reader.read()).value);
			const [scratch, tmpRoot, bunCache] = firstLine.trim().split(" ");
			// The scratch lives in the project's turn home, one sanitized run id
			// segment deep; the cache env points at the project's shared bun dir.
			expect(
				scratch!.startsWith(join(homes, "alpha", "tmp", "run-r-scratch-")),
			).toBe(true);
			expect(tmpRoot).toBe(tmpdir());
			expect(bunCache).toBe(join(homes, "alpha", "cache", "bun"));
			// The run really used its scratch before the test ends it.
			expect(existsSync(join(scratch!, "used"))).toBe(true);
			// OTTR-1295: the daemon writes the liveness marker beside the scratch,
			// daemon-owned, so a sibling worker sharing the volume keeps a live run.
			const marker = `${scratch}.live`;
			expect(existsSync(marker)).toBe(true);
			expect(readFileSync(marker, "utf8")).toBe(`${basename(scratch!)}\n`);
			if (typeof process.getuid === "function")
				expect(statSync(marker).uid).toBe(process.getuid());
			// The card's run ends here: the child dies, and the close handler removes
			// the scratch. The child's close event lives inside the daemon, so the test
			// has no promise to await — poll the observable condition like awaitBeatStall.
			controller.abort();
			try {
				const r = await reader.read();
				expect(r.done).toBe(true);
			} catch {
				// an aborted stream equally proves the child is gone
			}
			const deadline = Date.now() + 10_000;
			while (
				(existsSync(scratch!) || existsSync(marker)) &&
				Date.now() < deadline
			)
				await Bun.sleep(20);
			expect(existsSync(scratch!)).toBe(false);
			expect(existsSync(marker)).toBe(false);
			// The scratch parent and the cache dirs stay: other cards of the project use them.
			expect(existsSync(join(homes, "alpha", "tmp"))).toBe(true);
			expect(existsSync(join(homes, "alpha", "cache", "bun"))).toBe(true);
		} finally {
			if (savedHomes === undefined) delete process.env.OTTR_TURN_HOMES;
			else process.env.OTTR_TURN_HOMES = savedHomes;
			rmSync(homes, { recursive: true, force: true });
		}
	}, 15000);

	test("two cards of one project share the cache dirs; two projects do not (OTTR-1211)", async () => {
		const homes = mkdtempSync(join(tmpdir(), "ottr-homes-share-"));
		const savedHomes = process.env.OTTR_TURN_HOMES;
		process.env.OTTR_TURN_HOMES = homes;
		try {
			const url = start({ ompPath: process.execPath });
			const envOf = async (
				id: string,
				project: string,
			): Promise<Record<string, string>> => {
				const res = await fetch(`${url}/run`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						id,
						argv: [envDumpPath],
						cwd: dir,
						stdin: "",
						env: {},
						project,
					}),
				});
				const lines = await readLines(res);
				return JSON.parse(lines[0]!) as Record<string, string>;
			};
			const a1 = await envOf("a1", "alpha");
			const a2 = await envOf("a2", "alpha");
			const b1 = await envOf("b1", "beta");
			// Same project: every card shares one cache dir per tool family.
			const expectedSubs: Record<string, string> = {
				XDG_CACHE_HOME: "xdg",
				BUN_INSTALL_CACHE_DIR: "bun",
				PIP_CACHE_DIR: "pip",
				UV_CACHE_DIR: "uv",
				npm_config_cache: "npm",
			};
			for (const [key, sub] of Object.entries(expectedSubs)) {
				expect(a1[key]).toBe(join(homes, "alpha", "cache", sub));
				expect(a1[key]).toBe(a2[key]);
				expect(a1[key]).not.toBe(b1[key]);
			}
			// Scratch stays per run, inside the project's turn home.
			expect(a1.TMPDIR).not.toBe(a2.TMPDIR);
			expect(
				a1.TMPDIR!.startsWith(join(homes, "alpha", "tmp", "run-a1-")),
			).toBe(true);
			expect(b1.TMPDIR!.startsWith(join(homes, "beta", "tmp", "run-b1-"))).toBe(
				true,
			);
			// Both runs ended (envDump exits): their scratch dirs are gone again.
			for (const tmp of [a1.TMPDIR!, a2.TMPDIR!, b1.TMPDIR!]) {
				const deadline = Date.now() + 10_000;
				while (existsSync(tmp) && Date.now() < deadline) await Bun.sleep(20);
				expect(existsSync(tmp)).toBe(false);
			}
			// The project cache dirs were really created under the turn homes.
			expect(existsSync(join(homes, "alpha", "cache", "bun"))).toBe(true);
			expect(existsSync(join(homes, "beta", "cache", "npm"))).toBe(true);
		} finally {
			if (savedHomes === undefined) delete process.env.OTTR_TURN_HOMES;
			else process.env.OTTR_TURN_HOMES = savedHomes;
			rmSync(homes, { recursive: true, force: true });
		}
	}, 30000);

	test("the daily tmp sweep keeps a live run's quiet scratch (guard ordering)", async () => {
		// The run's start must be stamped before its scratch exists: a scratch that
		// never sees a write after creation (the common case now that the caches live
		// outside TMPDIR) ages past the TTL while its run is still live, and only
		// `start <= newest mtime` can keep it then.
		const homes = mkdtempSync(join(tmpdir(), "ottr-homes-guard-"));
		const savedHomes = process.env.OTTR_TURN_HOMES;
		process.env.OTTR_TURN_HOMES = homes;
		try {
			const server = serveWorker({ port: 0, ompPath: process.execPath });
			servers.push(server);
			const url = `http://127.0.0.1:${server.port}`;
			const controller = new AbortController();
			const res = await fetch(`${url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "r-guard",
					argv: [quietScratchPath],
					cwd: dir,
					stdin: "",
					env: {},
					project: "alpha",
				}),
				signal: controller.signal,
			});
			const reader = res.body!.getReader();
			const scratch = new TextDecoder()
				.decode((await reader.read()).value)
				.trim();
			// The scratch never sees a write: its newest mtime is its creation time.
			const created = statSync(scratch).mtimeMs;
			// The contract the sweeps' guard carries: a live run's start covers its own
			// scratch's birth mtime even across the kernel/userspace clock skew.
			const starts = server.runStarts();
			expect(starts.length).toBeGreaterThan(0);
			expect(
				starts.some((start) => start - SWEEP_CLOCK_SKEW_MS <= created),
			).toBe(true);
			// The daily tick's sweep, at a clock 25 hours later, with the real starts.
			// A rival aged entry older than every live run (skew included) proves the
			// sweep ran and that the guard — not the age rule — kept the scratch.
			const quietGone = join(homes, "alpha", "tmp", "quiet-gone");
			mkdirSync(quietGone);
			writeFileSync(join(quietGone, "old.txt"), "x");
			const uncovered =
				starts.reduce((a, s) => Math.min(a, s), Infinity) -
				SWEEP_CLOCK_SKEW_MS -
				60_000;
			// Age the dir and its file: newestMtime reads the newest child too.
			utimesSync(quietGone, uncovered / 1000, uncovered / 1000);
			utimesSync(
				join(quietGone, "old.txt"),
				uncovered / 1000,
				uncovered / 1000,
			);
			const swept = sweepTmpDirs(join(homes, "alpha", "tmp"), {
				liveTurnStarts: starts,
				now: created + 25 * 60 * 60 * 1000,
				procRoot: join(homes, "no-proc"),
			});
			expect(swept.map((e) => e.name)).toContain("quiet-gone");
			expect(existsSync(quietGone)).toBe(false);
			expect(existsSync(scratch)).toBe(true);
			// The run is still going; end it and its scratch goes as always.
			controller.abort();
			const deadline = Date.now() + 10_000;
			while (existsSync(scratch) && Date.now() < deadline) await Bun.sleep(20);
			expect(existsSync(scratch)).toBe(false);
		} finally {
			if (savedHomes === undefined) delete process.env.OTTR_TURN_HOMES;
			else process.env.OTTR_TURN_HOMES = savedHomes;
			rmSync(homes, { recursive: true, force: true });
		}
	}, 15000);

	test("omp output that arrives after the client left raises no error", async () => {
		// The daemon kills omp when the client leaves, but lines omp wrote before the kill
		// still drain from the pipe. Pushing them into the cancelled stream threw "Controller is
		// already closed" from an event handler, which crashes a daemon without a crash trap.
		const errors: unknown[] = [];
		const onError = (err: unknown) => errors.push(err);
		process.on("uncaughtException", onError);
		try {
			const pidFile = join(dir, "flood.pid");
			const url = start({ ompPath: process.execPath });
			const controller = new AbortController();
			const res = await fetch(`${url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "r5",
					argv: [floodPath, pidFile],
					cwd: dir,
					stdin: "",
					env: {},
				}),
				signal: controller.signal,
			});
			await res.body?.getReader().read();
			controller.abort();
			// The daemon killTree's the child with SIGKILL, which no test can observe
			// with a pid liveness probe (signal calls and proc reads are banned in
			// this file so a widening sweep mutant can never find a real target), and
			// this child's own 1 ms stdout bursts block its event loop, so a
			// heartbeat cannot advance either. The buffered lines drain for a moment
			// after the abort; the platform tests cover killTree's signals and the
			// /detach/kill route proves the kill lands via its sleeper child.
			await Bun.sleep(200);
			expect(errors).toEqual([]);
		} finally {
			process.off("uncaughtException", onError);
		}
	}, 15000);

	test("a probe run runs argv[0] as the full command inside the daemon scratch", async () => {
		const url = start({ ompPath: process.execPath });
		const sink = fakeSink();
		const { done } = runWorker(
			{
				id: "probe-1",
				argv: [process.execPath, probeStubPath],
				cwd: dir,
				stdin: "",
				env: {},
				probe: true,
			},
			{ urls: [url] },
			sink,
		);
		const result = await done;
		expect(result.exitCode).toBe(0);
		const seen = JSON.parse(
			sink.lines.find((l) => l.includes("probe-ran")) ?? "",
		) as { pwd: string; home: string; tmp: string };
		// The probe's argv[0] was the full command, and the daemon's per-run scratch
		// replaced body.cwd: cwd, HOME and TMPDIR are one `run-` dir under the
		// daemon's temp root, HOME being the scratch dir itself.
		expect(seen.pwd.startsWith(join(tmpdir(), "run-probe-1-"))).toBe(true);
		expect(seen.home.startsWith(join(tmpdir(), "run-probe-1-"))).toBe(true);
		expect(seen.home).toBe(seen.pwd);
		expect(seen.tmp).toBe(seen.home);
	}, 30_000);

	test("probe runs keep the env strips: no worker token, no HINDSIGHT seed", async () => {
		const savedToken = process.env.OTTR_WORKER_TOKEN;
		const savedHindsight = process.env.HINDSIGHT_PROBE_URL;
		process.env.OTTR_WORKER_TOKEN = "worker-secret";
		process.env.HINDSIGHT_PROBE_URL = "http://hindsight.test";
		try {
			const url = start({ ompPath: process.execPath });
			const sink = fakeSink();
			const { done } = runWorker(
				{
					id: "probe-env",
					argv: [process.execPath, probeStubPath],
					cwd: dir,
					stdin: "",
					// The request env is the token name's other leak path.
					env: { OTTR_WORKER_TOKEN: "forwarded" },
					probe: true,
				},
				{ urls: [url] },
				sink,
			);
			await done;
			const seen = JSON.parse(
				sink.lines.find((l) => l.includes("probe-ran")) ?? "",
			) as { token?: string; hindsight: string[] };
			expect(seen.token).toBeUndefined();
			expect(seen.hindsight).toEqual([]);
		} finally {
			if (savedToken === undefined) delete process.env.OTTR_WORKER_TOKEN;
			else process.env.OTTR_WORKER_TOKEN = savedToken;
			if (savedHindsight === undefined) delete process.env.HINDSIGHT_PROBE_URL;
			else process.env.HINDSIGHT_PROBE_URL = savedHindsight;
		}
	}, 30_000);

	test("a probe value that is not the literal true is refused before any spawn", async () => {
		const server = serveWorker({ port: 0, ompPath: process.execPath });
		servers.push(server);
		const url = `http://127.0.0.1:${server.port}`;
		// JSON round-trip: the wire can carry probe: "yes" even though the request
		// type forbids it.
		const body = JSON.parse(
			JSON.stringify({
				id: "probe-bad",
				argv: [process.execPath, probeStubPath],
				cwd: dir,
				stdin: "",
				env: {},
				probe: "yes",
			}),
		) as WorkerRequest;
		const sink = fakeSink();
		const { done } = runWorker(body, { urls: [url] }, sink);
		const outcome = await done.then(
			() => null,
			(error: unknown) => error,
		);
		expect(outcome).toBeInstanceOf(WorkerConnectError);
		expect((outcome as Error).message).toContain("responded 400");
		// Refused at the body check: no run entry ever existed.
		expect(server.runStarts()).toEqual([]);
	}, 30_000);

	test("the probe run's scratch dies with the run", async () => {
		const url = start({ ompPath: process.execPath });
		const sink = fakeSink();
		const { done } = runWorker(
			{
				id: "probe-scratch",
				argv: [process.execPath, probeStubPath],
				cwd: dir,
				stdin: "",
				env: {},
				probe: true,
			},
			{ urls: [url] },
			sink,
		);
		await done;
		const seen = JSON.parse(
			sink.lines.find((l) => l.includes("probe-ran")) ?? "",
		) as { home: string };
		const scratch = seen.home;
		expect(basename(scratch).startsWith("run-")).toBe(true);
		// The child's close event lives inside the daemon, so the test has no
		// promise to await — poll the observable condition like the scratch tests
		// above; removeScratch also deleted the probe's HOME.
		const deadline = Date.now() + 10_000;
		while (existsSync(scratch) && Date.now() < deadline) await Bun.sleep(20);
		expect(existsSync(scratch)).toBe(false);
	}, 30_000);
});

describe("GET /signins", () => {
	// omp's auth_credentials as a seeded sign-in writes it (src/app.test.ts builds the same).
	const SCHEMA = `CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY,
		provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL,
		disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)`;

	function credStore(path: string, list: Array<[string, string | null]>): void {
		// A fresh store each call: a later list must not keep an earlier row.
		rmSync(path, { force: true });
		mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path);
		db.exec(SCHEMA);
		const add = db.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, 'oauth', '{}', ?, 1, 1)",
		);
		for (const [provider, cause] of list) add.run(provider, cause);
		add.finalize(); // an unfinalized statement keeps the file open on Windows
		db.close();
	}

	test("unauthenticated /signins answers 401 like /sweep", async () => {
		const url = start({ token: "tok", readSignIns: () => [] });
		expect((await fetch(`${url}/signins`)).status).toBe(401);
	});

	test("GET /signins reports the worker store's sign-ins", async () => {
		const dbPath = join(dir, "signins-home", ".omp", "agent", "agent.db");
		credStore(dbPath, [
			["anthropic", null],
			["cursor", null],
		]);
		const url = start({ token: "tok", readSignIns: () => signIns(dbPath) });
		const res = await fetch(`${url}/signins`, {
			headers: { "x-otwr-token": "tok" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			signIns: unknown[];
			tmp: { freeBytes: number; totalBytes: number };
		};
		expect(body.signIns).toEqual([
			// Sorted by provider; lent only for a LENT_ENV provider (src/login.ts).
			{
				provider: "anthropic",
				kind: "oauth",
				active: true,
				cause: null,
				lent: true,
			},
			{
				provider: "cursor",
				kind: "oauth",
				active: true,
				cause: null,
				lent: false,
			},
		]);
		// OTTR-754: the success branch carries the worker's real /tmp statfs numbers.
		expect(body.tmp.freeBytes).toBeGreaterThan(0);
		expect(body.tmp.totalBytes).toBeGreaterThan(body.tmp.freeBytes);
	});

	test("an unreadable store answers 200 {signIns: null, error} naming the path", async () => {
		// The default resolution is the request-time HOME (loginStores' worker path), so a
		// directory where the store must be exercises the real unreadable-store answer.
		const home = join(dir, "signins-broken-home");
		mkdirSync(join(home, ".omp", "agent", "agent.db"), { recursive: true });
		const saved = process.env.HOME;
		process.env.HOME = home;
		try {
			const url = start({ token: "tok" });
			const res = await fetch(`${url}/signins`, {
				headers: { "x-otwr-token": "tok" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				signIns: null;
				error: string;
				tmp: { freeBytes: number; totalBytes: number } | null;
			};
			expect(body.signIns).toBeNull();
			expect(body.error).toContain(join(home, ".omp", "agent", "agent.db"));
			// OTTR-754: the store-error branch still carries the /tmp numbers.
			expect(body.tmp).not.toBeNull();
			expect(body.tmp?.freeBytes).toBeGreaterThan(0);
		} finally {
			if (saved === undefined) delete process.env.HOME;
			else process.env.HOME = saved;
		}
	});
});

describe("serveWorker handle", () => {
	// OTTR-754: the sweep reads this to protect a live turn's /tmp scratch.
	test("the handle exposes runStarts returning numbers", () => {
		const server = serveWorker({ port: 0, token: "tok" });
		servers.push(server);
		const starts = server.runStarts();
		expect(Array.isArray(starts)).toBe(true);
		for (const s of starts) expect(typeof s).toBe("number");
	});
});

describe("GET /stats", () => {
	test("unauthenticated /stats answers 401 like /sweep", async () => {
		const url = start({ token: "tok", cgroupRoot: join(dir, "no-cgroup") });
		expect((await fetch(`${url}/stats`)).status).toBe(401);
	});

	test("GET /stats reports the worker's own cgroup and mutation lock", async () => {
		const root = join(dir, "stats-cgroup");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "cpu.stat"), "usage_usec 4200\nuser_usec 4000\n");
		writeFileSync(join(root, "cpu.max"), "200000 100000\n");
		writeFileSync(join(root, "memory.current"), "1048576\n");
		writeFileSync(join(root, "memory.max"), "max\n");
		writeFileSync(
			join(root, "memory.events"),
			"low 0\nhigh 0\nmax 7\noom 2\noom_kill 1\noom_group_kill 0\n",
		);
		const lockPath = join(dir, "stats.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
		const url = start({ token: "tok", cgroupRoot: root, lockPath });
		const res = await fetch(`${url}/stats`, {
			headers: { "x-otwr-token": "tok" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body.at).toBe("number");
		expect({ ...body, at: 0 } as Record<string, unknown>).toEqual({
			at: 0,
			cpuUsageUsec: 4200,
			cpuMax: { quotaUsec: 200000, periodUsec: 100000 },
			memoryCurrent: 1048576,
			memoryMax: "max",
			memoryEvents: { max: 7, oom: 2, oomKill: 1 },
			lock: { exists: true, pid: process.pid, alive: true },
			runs: [],
		});
	});

	// The daemon reads the real /proc of its own /run child: Linux only. Reading signals
	// nothing, and the abort below ends the child the test started.
	test.skipIf(process.platform !== "linux")(
		"GET /stats reports a running /run's process tree by its run id",
		async () => {
			const url = start({
				token: "tok",
				ompPath: process.execPath,
				cgroupRoot: join(dir, "no-cgroup"),
			});
			const controller = new AbortController();
			const res = await fetch(`${url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-otwr-token": "tok" },
				body: JSON.stringify({
					id: "stats-run",
					argv: [sleepPath],
					cwd: dir,
					stdin: "",
					env: {},
				}),
				signal: controller.signal,
			});
			const reader = res.body!.getReader();
			try {
				// The child's first stdout line proves it spawned; no guessed delay.
				await reader.read();
				const stats = await fetch(`${url}/stats`, {
					headers: { "x-otwr-token": "tok" },
				});
				const body = (await stats.json()) as {
					runs: { id: string; memBytes: number; cpuUsec: number }[];
				};
				expect(body.runs.map((r) => r.id)).toEqual(["stats-run"]);
				expect(body.runs[0]!.memBytes).toBeGreaterThan(0);
			} finally {
				controller.abort();
			}
		},
		30_000,
	);
});

describe("run OOM detection", () => {
	// The live-path proof: the real readCgroup reader over a real temp cgroup dir
	// around a real spawned child. Each fixture starts at oom_kill 5 under an 8 GiB
	// memory.max; the child rewrites memory.events mid-run to grow the count like a
	// real kernel would, then ends the way the kernel's OOM killer ends a run
	// (SIGKILL, close with no exit code) or with an exit code.
	let oomCgroupN = 0;
	function cgroupFixture(): string {
		const root = join(dir, `oom-cgroup-${oomCgroupN++}`);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "memory.max"), "8589934592\n");
		writeFileSync(
			join(root, "memory.events"),
			"low 0\nhigh 0\nmax 0\noom 0\noom_kill 5\n",
		);
		return root;
	}

	async function runOom(
		url: string,
		id: string,
		argv: string[],
	): Promise<{
		exitCode: number | null;
		stderrTail: string;
		oomKilled?: boolean;
		memoryLimitBytes?: number | null;
	}> {
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id, argv, cwd: dir, stdin: "", env: {} }),
		});
		expect(res.status).toBe(200);
		const lines = await readLines(res);
		const sentinel = JSON.parse(lines[lines.length - 1]!) as {
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
		};
		return sentinel[WORKER_DONE];
	}

	test("a signal death whose oom_kill grew carries oomKilled and the memory limit", async () => {
		const cgroupRoot = cgroupFixture();
		const url = start({ ompPath: process.execPath, cgroupRoot });
		const sentinel = await runOom(url, "oom1", [
			oomGrowKillPath,
			join(cgroupRoot, "memory.events"),
		]);
		expect(sentinel.exitCode).toBeNull();
		expect(sentinel.oomKilled).toBe(true);
		expect(sentinel.memoryLimitBytes).toBe(8589934592);
	}, 30_000);

	test("an exit-code end with a grown oom_kill count carries no OOM fields", async () => {
		const cgroupRoot = cgroupFixture();
		const url = start({ ompPath: process.execPath, cgroupRoot });
		const sentinel = await runOom(url, "oom2", [
			oomGrowExitPath,
			join(cgroupRoot, "memory.events"),
		]);
		expect(sentinel.exitCode).toBe(3);
		expect(sentinel.oomKilled).toBeUndefined();
		expect(sentinel.memoryLimitBytes).toBeUndefined();
	}, 30_000);

	test("a signal death without oom_kill growth carries no OOM fields", async () => {
		const cgroupRoot = cgroupFixture();
		const url = start({ ompPath: process.execPath, cgroupRoot });
		const sentinel = await runOom(url, "oom3", [oomKillPath]);
		expect(sentinel.exitCode).toBeNull();
		expect(sentinel.oomKilled).toBeUndefined();
		expect(sentinel.memoryLimitBytes).toBeUndefined();
	}, 30_000);

	test("a signal death with an unreadable cgroup root carries no OOM fields", async () => {
		// Degraded, never thrown: both snapshots null, today's sentinel shape.
		const url = start({
			ompPath: process.execPath,
			cgroupRoot: join(dir, "oom-cgroup-missing"),
		});
		const sentinel = await runOom(url, "oom4", [oomKillPath]);
		expect(sentinel.exitCode).toBeNull();
		expect(sentinel.stderrTail).toBe("");
		expect(sentinel.oomKilled).toBeUndefined();
		expect(sentinel.memoryLimitBytes).toBeUndefined();
	}, 30_000);
});

describe("runWorker", () => {
	test.each(["sentinel", "lost", "killed"] as const)(
		"%s completion waits for ordered session and finding persistence",
		async (ending) => {
			const gate = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const persisted: string[] = [];
			const payload = `${[
				{ type: "session", id: "worker-session" },
				{
					type: "tool_execution_start",
					toolName: "propose_task",
					toolCallId: "finding",
					args: { prompt: "worker finding" },
				},
				{
					type: "tool_execution_end",
					toolName: "propose_task",
					toolCallId: "finding",
					isError: false,
				},
				...(ending === "sentinel"
					? [{ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } }]
					: []),
			]
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`;
			const server = Bun.serve({
				port: 0,
				fetch: () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								const bytes = new TextEncoder().encode(payload);
								controller.enqueue(bytes.slice(0, 13));
								controller.enqueue(bytes.slice(13));
								if (ending !== "killed") controller.close();
							},
						}),
					),
			});
			servers.push(server);
			const sink = createRunSink({
				logPath: join(dir, `ordered-${ending}.log`),
				dataRoot: dir,
				onSession: async (id) => {
					started.resolve();
					await gate.promise;
					persisted.push(id);
				},
				onRecorded: (finding) => {
					persisted.push(finding.prompt);
				},
			});
			const handle = runWorker(
				{ id: `ordered-${ending}`, argv: [], cwd: dir, stdin: "", env: {} },
				{ urls: [server.url.origin] },
				sink,
			);
			let completed = false;
			const done = handle.done.then((result) => {
				completed = true;
				return result;
			});
			try {
				await started.promise;
				if (ending === "killed") handle.kill();
				await Promise.resolve();
				expect(persisted).toEqual([]);
				expect(completed).toBe(false);
				gate.resolve();
				const result = await done;
				expect(persisted).toEqual(["worker-session", "worker finding"]);
				expect(result.sessionId).toBe("worker-session");
				expect(result.killed).toBe(ending === "killed");
				expect(result.workerLost === true).toBe(ending === "lost");
			} finally {
				gate.resolve();
			}
		},
	);

	test("a rejected finding callback rejects worker completion without a lost-worker fallback", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const failure = new Error("finding persistence failed");
		const payload = `${[
			{
				type: "tool_execution_start",
				toolName: "propose_task",
				toolCallId: "rejected",
				args: { prompt: "rejected finding" },
			},
			{
				type: "tool_execution_end",
				toolName: "propose_task",
				toolCallId: "rejected",
				isError: false,
			},
			{ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } },
		]
			.map((event) => JSON.stringify(event))
			.join("\n")}\n`;
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(payload),
		});
		servers.push(server);
		const sink = createRunSink({
			logPath: join(dir, "rejected-finding.log"),
			dataRoot: dir,
			onRecorded: () => {
				started.resolve();
				return gate.promise;
			},
		});
		const { done } = runWorker(
			{ id: "rejected-finding", argv: [], cwd: dir, stdin: "", env: {} },
			{ urls: [server.url.origin] },
			sink,
		);
		const outcome = done.then(
			() => null,
			(error: unknown) => error,
		);
		await started.promise;
		gate.reject(failure);
		expect(await outcome).toBe(failure);
	});

	test("non-sentinel lines go to the sink; sentinel settles the result and logs the stderr tail", async () => {
		const errPath = join(dir, "err2-omp.js");
		writeFileSync(
			errPath,
			`process.stderr.write("bad thing\\n");process.exit(2);`,
		);
		const url = start({ ompPath: process.execPath });
		const sink = fakeSink();
		const { pid, done } = runWorker(
			{ id: "c1", argv: [errPath], cwd: dir, stdin: "hi", env: {} },
			{ urls: [url] },
			sink,
		);
		expect(pid).toBeNull();
		const result = await done;
		expect(result.exitCode).toBe(2);
		expect(result.killed).toBe(false);
		expect(result.workerLost).toBeUndefined();
		// The worker's stderr tail is relayed to the log as "! ..." lines.
		expect(sink.lines).toContain("! bad thing\n");
	}, 30_000);

	test("a sentinel with a host settles the result with worker ranOn (hostname without port)", async () => {
		const hostPath = join(dir, "host-sentinel-omp.js");
		writeFileSync(
			hostPath,
			`process.stdout.write(JSON.stringify({ ${JSON.stringify(WORKER_DONE)}: { exitCode: 0, stderrTail: "", host: "abc-123" } }) + "\\n");\nprocess.exit(0);`,
		);
		const url = start({ ompPath: process.execPath });
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "h1", argv: [hostPath], cwd: dir, stdin: "", env: {} },
			{ urls: [url] },
			sink,
		);
		const result = await done;
		expect(result.exitCode).toBe(0);
		expect(result.ranOn).toBe(`worker ${new URL(url).hostname} (abc-123)`);
	}, 30_000);

	test("a sentinel without a host settles the result with no ranOn", async () => {
		const noHostPath = join(dir, "no-host-sentinel-omp.js");
		writeFileSync(
			noHostPath,
			`process.stdout.write(JSON.stringify({ ${JSON.stringify(WORKER_DONE)}: { exitCode: 0, stderrTail: "" } }) + "\\n");\nprocess.exit(0);`,
		);
		const url = start({ ompPath: process.execPath });
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "h2", argv: [noHostPath], cwd: dir, stdin: "", env: {} },
			{ urls: [url] },
			sink,
		);
		const result = await done;
		expect(result.exitCode).toBe(0);
		expect(result.ranOn).toBeUndefined();
	}, 30_000);

	test("the daemon's close audit rides the sentinel into the result", async () => {
		const driftScript = join(dir, "drift-omp.js");
		writeFileSync(driftScript, `process.exit(0);`);
		const url = start({
			ompPath: process.execPath,
			auditProvisioned: () => [".omp/agent/skills/x/SKILL.md changed"],
		});
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "drift1", argv: [driftScript], cwd: dir, stdin: "", env: {} },
			{ urls: [url] },
			sink,
		);
		const result = await done;
		expect(result.exitCode).toBe(0);
		expect(result.provisionDrift).toEqual([
			".omp/agent/skills/x/SKILL.md changed",
		]);
	}, 30_000);

	test("a clean audit leaves provisionDrift unset", async () => {
		const cleanScript = join(dir, "clean-omp.js");
		writeFileSync(cleanScript, `process.exit(0);`);
		const url = start({
			ompPath: process.execPath,
			auditProvisioned: () => [],
		});
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "clean1", argv: [cleanScript], cwd: dir, stdin: "", env: {} },
			{ urls: [url] },
			sink,
		);
		const result = await done;
		expect(result.provisionDrift).toBeUndefined();
	}, 30_000);

	test("a sentinel with the OOM fields settles them onto the result", async () => {
		const oomSentinelPath = join(dir, "oom-sentinel-omp.js");
		writeFileSync(
			oomSentinelPath,
			`process.stdout.write(JSON.stringify({ ${JSON.stringify(WORKER_DONE)}: { exitCode: null, stderrTail: "", oomKilled: true, memoryLimitBytes: 8589934592 } }) + "\\n");\nprocess.exit(0);`,
		);
		const url = start({ ompPath: process.execPath });
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "oom-r1", argv: [oomSentinelPath], cwd: dir, stdin: "", env: {} },
			{ urls: [url] },
			sink,
		);
		const result = await done;
		expect(result.exitCode).toBeNull();
		expect(result.oomKilled).toBe(true);
		expect(result.memoryLimitBytes).toBe(8589934592);
	}, 30_000);

	test("a sentinel without the OOM fields leaves them absent", async () => {
		const noOomSentinelPath = join(dir, "no-oom-sentinel-omp.js");
		writeFileSync(
			noOomSentinelPath,
			`process.stdout.write(JSON.stringify({ ${JSON.stringify(WORKER_DONE)}: { exitCode: 0, stderrTail: "" } }) + "\\n");\nprocess.exit(0);`,
		);
		const url = start({ ompPath: process.execPath });
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "oom-r2", argv: [noOomSentinelPath], cwd: dir, stdin: "", env: {} },
			{ urls: [url] },
			sink,
		);
		const result = await done;
		expect(result.exitCode).toBe(0);
		expect(result.oomKilled).toBeUndefined();
		expect(result.memoryLimitBytes).toBeUndefined();
	}, 30_000);

	test("round-robins across urls", async () => {
		const urls = [
			start({ ompPath: process.execPath }),
			start({ ompPath: process.execPath }),
		];
		const sink = fakeSink();
		for (let i = 0; i < 4; i++) {
			const { done } = runWorker(
				{ id: `rr${i}`, argv: [echoPath], cwd: dir, stdin: "", env: {} },
				{ urls },
				sink,
			);
			await done;
		}
		const dispatches = sink.lines.filter((l) => l.startsWith("worker:"));
		expect(dispatches).toHaveLength(4);
		expect(dispatches.filter((l) => l.includes(urls[0]!))).toHaveLength(2);
		expect(dispatches.filter((l) => l.includes(urls[1]!))).toHaveLength(2);
	}, 30_000); // Four sequential worker spawns; the 5 s default is tighter than the test under load.

	test("connect failure rejects with WorkerConnectError", async () => {
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "c2", argv: [], cwd: dir, stdin: "", env: {} },
			{ urls: ["http://127.0.0.1:1"] },
			sink,
		);
		expect(done).rejects.toBeInstanceOf(WorkerConnectError);
	});

	test("a redirecting worker url rejects and never forwards the token", async () => {
		// The redirect target must never see a request at all: the dispatch
		// refuses to follow, so the x-otwr-token cannot hop hosts.
		let bounceToken: string | null | undefined;
		const bounce = Bun.serve({
			port: 0,
			fetch: (req) => {
				bounceToken = req.headers.get("x-otwr-token");
				return new Response("ok");
			},
		});
		const redir = Bun.serve({
			port: 0,
			fetch: () => Response.redirect(`${bounce.url.origin}/run`, 302),
		});
		servers.push(bounce, redir as Bun.Server<never>);
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "c2b", argv: [], cwd: dir, stdin: "", env: {} },
			{ urls: [redir.url.origin], token: "sekrit" },
			sink,
		);
		const err = await done.then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(WorkerConnectError);
		expect(String(err)).toContain("redirect not followed");
		expect(String(err)).toContain(
			"a proxy may intercept this call: check NO_PROXY",
		);
		expect(bounceToken).toBeUndefined();
	});

	test("a same-origin redirecting worker url rejects without the proxy hint", async () => {
		const redir = Bun.serve({
			port: 0,
			// redirect: "manual" never follows this; the same-origin location only
			// proves the proxy hint stays off for a same-host bounce.
			fetch: (req) => Response.redirect(req.url, 302),
		});
		servers.push(redir as Bun.Server<never>);
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "c2c", argv: [], cwd: dir, stdin: "", env: {} },
			{ urls: [redir.url.origin], token: "sekrit" },
			sink,
		);
		const err = await done.then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(WorkerConnectError);
		expect(String(err)).toContain("redirect not followed");
		expect(String(err)).not.toContain("NO_PROXY");
	});

	test("kill aborts and settles killed immediately", async () => {
		const url = start({ ompPath: process.execPath });
		const sink = fakeSink();
		const { done, kill } = runWorker(
			{ id: "c3", argv: [sleepPath], cwd: dir, stdin: "", env: {} },
			{ urls: [url] },
			sink,
		);
		kill();
		const result = await done;
		expect(result.exitCode).toBeNull();
		expect(result.killed).toBe(true);
		expect(result.workerLost).toBeUndefined();
	}, 15000);

	test("lost connection without sentinel settles workerLost", async () => {
		// Daemon that streams one line then dies with the child gone silent: use a
		// fake omp that exits but the sentinel is stripped by a proxy is complex; instead
		// point at a server that returns 200 with a truncated stream.
		const truncated = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch: () =>
				new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode('{"type":"partial"}\n'));
							c.close();
						},
					}),
					{ headers: { "content-type": "text/plain" } },
				),
		});
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "c4", argv: [], cwd: dir, stdin: "", env: {} },
			{ urls: [`http://127.0.0.1:${truncated.port}`] },
			sink,
		);
		const result = await done;
		expect(result.exitCode).toBeNull();
		expect(result.workerLost).toBe(true);
		expect(result.stderrTail).toContain("worker connection lost");
		expect(sink.lines).toContain('{"type":"partial"}\n');
		truncated.stop(true);
	});

	test("a silent turn is not cut by Bun's fetch idle timeout", async () => {
		// Real platform clock, deliberately: the subject under test is Bun's socket idle
		// timer, which fake timers cannot advance, so the silence must actually elapse.
		// The daemon sends the headers, then stays silent for 10 s before the sentinel.
		// The client child runs with BUN_CONFIG_HTTP_IDLE_TIMEOUT=1, the shortest idle
		// timer Bun has: its coarse socket ticks fire it within ~8 s (measured 2026-10-12;
		// a 6 s silence survived it). runWorker's explicit `timeout: false` must override
		// it, or the read dies with "The operation timed out" as workerLost.
		const silent = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch: () =>
				new Response(
					new ReadableStream({
						async start(c) {
							c.enqueue(new TextEncoder().encode("\n"));
							await Bun.sleep(10_000);
							c.enqueue(
								new TextEncoder().encode(
									`${JSON.stringify({ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } })}\n`,
								),
							);
							c.close();
						},
					}),
					{ headers: { "content-type": "text/plain" } },
				),
		});
		try {
			// Async spawn, not spawnSync: spawnSync blocks this process's event loop, so the
			// `silent` server above could never answer the child's request.
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { runWorker } from "./src/workers.ts";
import { createRunSink } from "./src/runner.ts";
const sink = createRunSink({
	logPath: ${JSON.stringify(join(dir, "idle-client.log"))},
	dataRoot: ${JSON.stringify(dir)},
});
runWorker({ id: "idle", argv: [], cwd: ${JSON.stringify(dir)}, stdin: "", env: {} }, { urls: ["http://127.0.0.1:${silent.port}"] }, sink)
	.done.then(
		(r) => console.log(JSON.stringify(r)),
		(e) => console.log(JSON.stringify({ rejected: String(e) })),
	);`,
				],
				{
					cwd: join(import.meta.dir, ".."),
					env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
					stdout: "pipe",
					stderr: "pipe",
					timeout: 20_000,
				},
			);
			const [out] = await Promise.all([
				new Response(child.stdout).text(),
				child.exited,
			]);
			expect(child.exitCode).toBe(0);
			const r = JSON.parse(out.trim()) as {
				exitCode: number | null;
				workerLost?: boolean;
			};
			expect(r.exitCode).toBe(0);
			expect(r.workerLost).toBeUndefined();
		} finally {
			silent.stop(true);
		}
	}, 30_000);
});

describe("sweepLeftovers", () => {
	// Safety contract for every test in this block: the sweep under test scans a
	// fake proc tree (helpers above) and "signals" through a recording kill, so
	// no test can ever signal a pid it did not create — not even under a Stryker
	// mutant that widens the target set (e.g. dropping the match guard would
	// otherwise make every process in the container a target and kill the worker
	// itself). The fake tree below holds non-matching pids on purpose: the exact
	// kill log fails the test if the sweep ever names one.
	test("sweeps exactly the deleted-worktree process in a fake /proc", async () => {
		const root = join(dir, "ottr-sweep-fake");
		const procRoot = makeFakeProc([
			{ pid: 4111, ppid: 1, cwd: `${root}/proj/.worktrees/T1 (deleted)` },
			// Live worktree: not a leftover.
			{ pid: 4112, ppid: 1, cwd: `${root}/proj/.worktrees/T2` },
			// Deleted, but outside every sweep root.
			{ pid: 4113, ppid: 1, cwd: "/elsewhere/proj/.worktrees/T3 (deleted)" },
			// Exited between readdir and the cwd readlink: no cwd link.
			{ pid: 4114, ppid: 1 },
		]);
		const { calls, kill } = recordingKill();
		const url = start({
			token: "t",
			sweepRoots: [root],
			sweepGraceMs: 50,
			sweepProcRoot: procRoot,
			sweepKill: kill,
		});
		const res = await fetch(`${url}/sweep`, {
			method: "POST",
			headers: { "x-otwr-token": "t" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([
			{ pid: 4111, project: "proj", cardId: "T1", command: "bun run dev" },
		]);
		// TERM, the liveness probe, and the escalation: the exact sequence and
		// nothing else. A foreign pid here is a test failure, not a signal.
		expect(calls).toEqual([
			{ pid: 4111, signal: "SIGTERM" },
			{ pid: 4111, signal: 0 },
			{ pid: 4111, signal: "SIGKILL" },
		]);
	});

	// Real run child, fake scan: the sweep never reads the kernel's /proc and the
	// kill is a recording spy, so a widened target set can only ever "signal" the
	// fake neighbor; the pid-file poll uses the platform clock because no event
	// fires when a separate process writes a file.
	test("a live /run child with a deleted worktree survives the sweep", async () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-sweep-run-"));
		const wt = join(root, "proj", ".worktrees", "T3");
		mkdirSync(wt, { recursive: true });
		const pidFile = join(root, "pid");
		const procRoot = makeFakeProc([
			// A leftover neighbor: the only process the sweep may "signal".
			{
				pid: 4301,
				ppid: 1,
				cwd: `${root}/other/.worktrees/T9 (deleted)`,
			},
		]);
		const { calls, kill } = recordingKill();
		const beatPath = join(dir, "sweep-live-beat");
		const url = start({
			token: "t",
			ompPath: process.execPath,
			sweepRoots: [root],
			sweepGraceMs: 100,
			sweepProcRoot: procRoot,
			sweepKill: kill,
		});
		const handle = runWorker(
			{
				id: "sweep-live",
				argv: [sweepSleepPath, pidFile, beatPath],
				cwd: wt,
				stdin: "",
				env: {},
			},
			{ urls: [url], token: "t" },
			fakeSink(),
		);
		let ompPid: number | undefined;
		try {
			// The run child must be up and have dropped its pid before the worktree goes.
			const deadline = Date.now() + 20_000;
			for (;;) {
				try {
					ompPid = Number(readFileSync(pidFile, "utf8"));
					break;
				} catch {
					if (Date.now() > deadline)
						throw new Error("run child never wrote its pid");
					await Bun.sleep(100);
				}
			}
			rmSync(root, { recursive: true, force: true });
			// The merge-turn shape: the agent removed its own worktree mid-run, so a
			// live turn's cwd link ends in " (deleted)". Mirror that shape into the
			// fake /proc tree; runChildren must keep the live run out of the sweep.
			fakeProcEntry(procRoot, {
				pid: ompPid!,
				ppid: 1,
				cwd: `${wt} (deleted)`,
			});
			const res = await fetch(`${url}/sweep`, {
				method: "POST",
				headers: { "x-otwr-token": "t" },
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual([
				{ pid: 4301, project: "other", cardId: "T9", command: "bun run dev" },
			]);
			// Exact kill log: the live run child was never signaled.
			expect(calls).toEqual([
				{ pid: 4301, signal: "SIGTERM" },
				{ pid: 4301, signal: 0 },
				{ pid: 4301, signal: "SIGKILL" },
			]);
			// Still alive: the heartbeat keeps advancing, the observable stand-in
			// for the old pid liveness probe.
			await awaitBeatAdvance(
				beatPath,
				readBeat(beatPath),
				"heartbeat after sweep",
			);
		} finally {
			handle.kill();
			rmSync(root, { recursive: true, force: true });
		}
		await handle.done;
	}, 30_000);

	test("rejects a request without the token", async () => {
		const server = start({ token: "t" });
		const res = await fetch(`${server}/sweep`, { method: "POST" });
		expect(res.status).toBe(401);
		expect(await res.text()).toBe("unauthorized");
	});
});

describe("matchSweepTarget", () => {
	const roots = ["/workspace/ottr", "/workspace/other"];

	test("a live link without the deleted suffix does not match", () => {
		expect(matchSweepTarget("/workspace/ottr/.worktrees/T1", roots)).toBeNull();
	});

	test("a path outside every root does not match", () => {
		expect(
			matchSweepTarget("/tmp/x/.worktrees/T1 (deleted)", roots),
		).toBeNull();
	});

	test("a link ending at .worktrees with no card segment does not match", () => {
		expect(
			matchSweepTarget("/workspace/ottr/.worktrees (deleted)", roots),
		).toBeNull();
	});

	test("a deeper path keeps the .worktrees child segment as the card id", () => {
		expect(
			matchSweepTarget(
				"/workspace/ottr/proj/.worktrees/T3/sub (deleted)",
				roots,
			),
		).toEqual({ project: "proj", cardId: "T3" });
	});

	test("the root boundary is exact per segment", () => {
		expect(
			matchSweepTarget("/workspace/ottr2/proj/.worktrees/T4 (deleted)", roots),
		).toBeNull();
	});

	test("the second root matches too", () => {
		expect(
			matchSweepTarget("/workspace/other/proj/.worktrees/T5 (deleted)", roots),
		).toEqual({ project: "proj", cardId: "T5" });
	});
});

describe("detach protocol", () => {
	// Real children boot unbounded under load: the same 30 s budget as above. The
	// awaited conditions are process facts (pid liveness, /detached state) that no
	// fake timer can drive; each poll is a check, not a guessed duration.
	async function pollUntil(
		cond: () => Promise<boolean> | boolean,
		what: string,
	): Promise<void> {
		const deadline = Date.now() + 20_000;
		for (;;) {
			if (await cond()) return;
			if (Date.now() > deadline) throw new Error(`${what}: never happened`);
			await Bun.sleep(50);
		}
	}

	// Kill landing is observed through the child's heartbeat stalling (the beat
	// file the fake omp rewrites every 50 ms): real pid liveness probes and
	// signal calls are banned in this file so a widening sweep mutant can never
	// find a real target here. killTree's signals are covered by the platform
	// tests.

	async function run(
		url: string,
		token: string | undefined,
		id: string,
		argv: string[],
		cwd: string = dir,
	): Promise<Response> {
		return await fetch(`${url}/run`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { "x-otwr-token": token } : {}),
			},
			body: JSON.stringify({ id, argv, cwd, stdin: "", env: {} }),
		});
	}

	interface Entry {
		id: string;
		cwd: string;
		pid: number;
		running: boolean;
		startedAt: number;
		result?: { exitCode: number | null; stderrTail: string };
		killed?: boolean;
	}

	async function detachedList(url: string, token?: string): Promise<Entry[]> {
		const res = await fetch(`${url}/detached`, {
			headers: token ? { "x-otwr-token": token } : {},
		});
		expect(res.status).toBe(200);
		return (await res.json()) as Entry[];
	}

	test("POST /detach closes the stream, keeps the child, and captures the result", async () => {
		const url = start({ ompPath: process.execPath });
		const res = await run(url, undefined, "d1", [lingerPath]);
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		// The child's first stdout line proves it spawned; no guessed delay.
		await reader.read();
		expect(await detachedList(url)).toEqual([]);
		const detach = await fetch(`${url}/detach`, { method: "POST" });
		expect(detach.status).toBe(200);
		expect(await detach.json()).toEqual({ detached: 1 });
		// The /run stream closed, with no sentinel on a released stream.
		expect((await reader.read()).done).toBe(true);
		// Listed while running, never killed, then finished with the child's own
		// exit code and stderr tail.
		let entry: Entry | undefined;
		await pollUntil(async () => {
			entry = (await detachedList(url))[0];
			return entry !== undefined;
		}, "entry");
		expect(entry?.running).toBe(true);
		expect(entry?.cwd).toBe(dir);
		expect(typeof entry?.pid).toBe("number");
		expect(entry?.killed).toBeUndefined();
		expect(entry?.result).toBeUndefined();
		await pollUntil(
			async () => (await detachedList(url))[0]?.running === false,
			"child exit",
		);
		entry = (await detachedList(url))[0];
		expect(entry?.result).toEqual({ exitCode: 7, stderrTail: "detach tail\n" });
		// An empty active set answers zero.
		const again = await fetch(`${url}/detach`, { method: "POST" });
		expect(await again.json()).toEqual({ detached: 0 });
	}, 30_000);

	test("POST /detach/kill kills the child and marks the entry; unknown id is 404", async () => {
		const url = start({ ompPath: process.execPath });
		const beatPath = join(dir, "d2-beat");
		const res = await run(url, undefined, "d2", [sleepPath, beatPath]);
		expect(res.status).toBe(200);
		// No cancel before detach: a client abort would kill the child. The detach
		// below closes the stream; drain it afterwards.
		expect(
			await (await fetch(`${url}/detach`, { method: "POST" })).json(),
		).toEqual({ detached: 1 });
		// The released stream carries what the child streamed live before the
		// detach — its tick line — and nothing from the close: no partial tail and
		// no sentinel, which /detached holds instead of the drained stream.
		const drained = await res.text();
		expect(drained.startsWith('{"type":"tick"}\n')).toBe(true);
		expect(drained.includes(WORKER_DONE)).toBe(false);
		let entry: Entry | undefined;
		await pollUntil(async () => {
			entry = (await detachedList(url))[0];
			return entry !== undefined;
		}, "entry");
		expect(entry?.running).toBe(true);
		// Alive before the kill: the child's heartbeat keeps advancing.
		await awaitBeatAdvance(beatPath, readBeat(beatPath), "heartbeat");
		const miss = await fetch(`${url}/detach/kill`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "nope" }),
		});
		expect(miss.status).toBe(404);
		const kill = await fetch(`${url}/detach/kill`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "d2" }),
		});
		expect(kill.status).toBe(200);
		expect(await kill.json()).toEqual({ killed: true });
		// The killed flag is set synchronously with the fire-and-forget killTree,
		// so it proves nothing about the child; the beat stalling does.
		await awaitBeatStall(beatPath, "kill landing");
		expect((await detachedList(url))[0]?.killed).toBe(true);
	}, 30_000);

	test("/sweep does not stop a detached child", async () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-detach-sweep-"));
		const cwd = join(root, "proj", ".worktrees", "T9");
		mkdirSync(cwd, { recursive: true });
		const pidFile = join(dir, "detach-sweep.pid");
		// Fake scan + recording kill: the sweep can never signal a real process.
		const procRoot = makeFakeProc([
			{
				pid: 4401,
				ppid: 1,
				cwd: `${root}/other/.worktrees/T8 (deleted)`,
			},
		]);
		const { calls, kill } = recordingKill();
		const beatPath = join(dir, "d3-beat");
		const url = start({
			ompPath: process.execPath,
			sweepRoots: [root],
			sweepGraceMs: 100,
			sweepProcRoot: procRoot,
			sweepKill: kill,
		});
		let ompPid = 0;
		try {
			// The child writes no stdout, so Bun's client only resolves the /run
			// response when the stream closes: start it un-awaited and let the pid
			// file prove the spawn instead. The cwd is the worktree the sweep roots
			// watch: its death mid-run is the merge-turn shape this test builds.
			const resP = run(
				url,
				undefined,
				"d3",
				[sweepSleepPath, pidFile, beatPath],
				cwd,
			);
			await pollUntil(() => {
				try {
					ompPid = Number(readFileSync(pidFile, "utf8"));
					return Number.isInteger(ompPid) && ompPid > 0;
				} catch {
					return false;
				}
			}, "child pid file");
			rmSync(root, { recursive: true, force: true });
			// The merge-turn shape: the worktree is gone while the child still runs,
			// so its cwd link ends in " (deleted)". Mirror it into the fake /proc
			// tree; the detached entry must keep the child out of the sweep.
			fakeProcEntry(procRoot, {
				pid: ompPid,
				ppid: 1,
				cwd: `${cwd} (deleted)`,
			});
			expect(
				await (await fetch(`${url}/detach`, { method: "POST" })).json(),
			).toEqual({ detached: 1 });
			// The detach closed the silent stream: the head resolves now, status 200,
			// and the drain carries nothing — the child never wrote stdout and the
			// close added no sentinel.
			const res = await resP;
			expect(res.status).toBe(200);
			expect((await res.text()).length).toBe(0);
			// The keep-set must cover a detached run: only the fake neighbor is
			// listed and signaled, and the exact kill log holds no real pid.
			const sweep = await fetch(`${url}/sweep`, {
				method: "POST",
			});
			expect(sweep.status).toBe(200);
			expect(await sweep.json()).toEqual([
				{ pid: 4401, project: "other", cardId: "T8", command: "bun run dev" },
			]);
			expect(calls).toEqual([
				{ pid: 4401, signal: "SIGTERM" },
				{ pid: 4401, signal: 0 },
				{ pid: 4401, signal: "SIGKILL" },
			]);
			// Alive after the sweep: the child's heartbeat keeps advancing, the
			// observable stand-in for the old pid liveness probe.
			await awaitBeatAdvance(
				beatPath,
				readBeat(beatPath),
				"heartbeat after sweep",
			);
			// Clean up the 60 s sleeper; the beat stalling proves the SIGKILL landed
			// (the killed flag is set synchronously with the fire-and-forget killTree).
			await fetch(`${url}/detach/kill`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "d3" }),
			});
			await awaitBeatStall(beatPath, "kill landing");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("the detach routes answer 401 without the token", async () => {
		const url = start({ token: "sekrit", ompPath: process.execPath });
		expect((await fetch(`${url}/detach`, { method: "POST" })).status).toBe(401);
		expect((await fetch(`${url}/detached`)).status).toBe(401);
		expect(
			(
				await fetch(`${url}/detach/kill`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: "x" }),
				})
			).status,
		).toBe(401);
	}, 30_000);

	test("detached entries expire after the ttl", async () => {
		const url = start({ ompPath: process.execPath, detachedTtlMs: 1500 });
		const res = await run(url, undefined, "d4", [lingerPath]);
		expect(res.status).toBe(200);
		await fetch(`${url}/detach`, { method: "POST" });
		await res.text();
		await pollUntil(
			async () => (await detachedList(url)).length === 1,
			"entry",
		);
		// Fake-timer-free: the ttl is a real worker feature against its own clock; the
		// second poll names the expiry, not a guessed wait.
		await pollUntil(
			async () => (await detachedList(url)).length === 0,
			"expiry",
		);
	}, 30_000);

	test("an expired running entry stays killable: the sweep keeps it and the kill lands", async () => {
		const url = start({ ompPath: process.execPath, detachedTtlMs: 1500 });
		const beatPath = join(dir, "d8-beat");
		const res = await run(url, undefined, "d8", [sleepPath, beatPath]);
		expect(res.status).toBe(200);
		expect(
			await (await fetch(`${url}/detach`, { method: "POST" })).json(),
		).toEqual({ detached: 1 });
		await res.text();
		await pollUntil(
			async () => (await detachedList(url)).length === 1,
			"entry",
		);
		// Age the entry past the ttl without another sweep: every detached GET is
		// itself the sweep, so the wait is wall-clock time from the entry's
		// appearance (its startedAt is older still).
		const appearedAt = Date.now();
		await pollUntil(() => Date.now() - appearedAt > 1500, "age past ttl");
		// Still running past the ttl: the sweep must keep the entry killable.
		// Deleting it here would leave the child unstoppable until it exits.
		const kept = await detachedList(url);
		expect(kept.map((e) => e.id)).toEqual(["d8"]);
		expect(kept[0]?.running).toBe(true);
		const kill = await fetch(`${url}/detach/kill`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "d8" }),
		});
		expect(kill.status).toBe(200);
		expect(await kill.json()).toEqual({ killed: true });
		// The killed flag is set synchronously with the fire-and-forget killTree;
		// the beat stalling proves the child received it.
		await awaitBeatStall(beatPath, "kill landing");
		// Finished and past the ttl: the next sweep reaps the entry and
		// remembers the id for the ttl.
		await pollUntil(async () => (await detachedList(url)).length === 0, "reap");
		const late = await fetch(`${url}/detach/kill`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "d8" }),
		});
		expect(late.status).toBe(410);
		expect(await late.text()).toBe(`detached run d8 expired and was reaped`);
	}, 30_000);

	test("detachedRuns parses the list and throws WorkerConnectError on non-200", async () => {
		const url = start({ token: "sekrit" });
		const runs = await detachedRuns(url, "sekrit");
		expect(runs).toEqual([]);
		// Wrong token: the worker answers 401, which surfaces as WorkerConnectError.
		await expect(detachedRuns(url, "wrong")).rejects.toBeInstanceOf(
			WorkerConnectError,
		);
		// Unreachable worker: same error class for the caller.
		await expect(detachedRuns("http://127.0.0.1:9")).rejects.toBeInstanceOf(
			WorkerConnectError,
		);
	}, 30_000);

	test("killDetached posts the id and throws WorkerConnectError on non-200", async () => {
		const url = start({ token: "sekrit", ompPath: process.execPath });
		const res = await run(url, "sekrit", "d6", [sleepPath]);
		expect(res.status).toBe(200);
		await fetch(`${url}/detach`, {
			method: "POST",
			headers: { "x-otwr-token": "sekrit" },
		});
		await res.text();
		let listed: Entry[] = [];
		await pollUntil(async () => {
			listed = await detachedList(url, "sekrit");
			return listed.length === 1;
		}, "entry");
		await killDetached(url, "sekrit", "d6");
		await pollUntil(
			async () => (await detachedList(url, "sekrit"))[0]?.killed === true,
			"kill landing",
		);
		// Unknown id: the worker answers 404, which surfaces as WorkerConnectError.
		await expect(killDetached(url, "sekrit", "nope")).rejects.toBeInstanceOf(
			WorkerConnectError,
		);
	}, 30_000);

	test("sweepWorker names a proxy on a cross-host redirect", async () => {
		const redir = Bun.serve({
			port: 0,
			// redirect: "manual" never follows this; the cross-host location must
			// surface the NO_PROXY hint in the WorkerConnectError message.
			fetch: () => Response.redirect("http://www.example.com/run", 302),
		});
		servers.push(redir as Bun.Server<never>);
		await expect(
			sweepWorker(
				{ token: undefined } as WorkerTarget,
				`http://127.0.0.1:${redir.port}`,
			),
		).rejects.toThrow(
			"redirect not followed; a proxy may intercept this call: check NO_PROXY",
		);
	}, 30_000);

	test("detachedRuns names a proxy on a cross-host redirect", async () => {
		const redir = Bun.serve({
			port: 0,
			// redirect: "manual" never follows this; the cross-host location must
			// surface the NO_PROXY hint in the WorkerConnectError message.
			fetch: () => Response.redirect("http://www.example.com/run", 302),
		});
		servers.push(redir as Bun.Server<never>);
		await expect(
			detachedRuns(`http://127.0.0.1:${redir.port}`),
		).rejects.toThrow(
			"redirect not followed; a proxy may intercept this call: check NO_PROXY",
		);
	}, 30_000);

	test("detachedRuns omits the proxy hint on a same-origin redirect", async () => {
		const redir = Bun.serve({
			port: 0,
			// Same-host bounce: the message names the redirect but must not blame
			// a proxy.
			fetch: (req) => Response.redirect(`${new URL(req.url).origin}/run`, 302),
		});
		servers.push(redir as Bun.Server<never>);
		const err = await detachedRuns(`http://127.0.0.1:${redir.port}`).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(WorkerConnectError);
		expect(String(err)).toContain("redirect not followed");
		expect(String(err)).not.toContain("NO_PROXY");
	}, 30_000);

	test("killDetached names a proxy on a cross-host redirect", async () => {
		const redir = Bun.serve({
			port: 0,
			// redirect: "manual" never follows this; the cross-host location must
			// surface the NO_PROXY hint in the WorkerConnectError message.
			fetch: () => Response.redirect("http://www.example.com/run", 302),
		});
		servers.push(redir as Bun.Server<never>);
		await expect(
			killDetached(`http://127.0.0.1:${redir.port}`, undefined, "x"),
		).rejects.toThrow(
			"redirect not followed; a proxy may intercept this call: check NO_PROXY",
		);
	}, 30_000);
});

describe("worker layer lease (OTTR-1132)", () => {
	// Gate omp: emits one tick, then exits 0 on its own once its release file exists.
	// Every test ends its children by writing those files in a finally, never by a
	// kill, and waits there for each close. The 60 s fallback is a natural exit too.
	const gatePath = join(dir, "gate-omp.js");
	writeFileSync(
		gatePath,
		`process.stdout.write('{"type":"tick"}\\n');
const fs = require("node:fs");
setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(0); }, 20);
setTimeout(() => process.exit(0), 60000);`,
	);

	type Reader = ReadableStreamDefaultReader<Uint8Array>;

	let leaseN = 0;
	/** A fresh worker home with one real layer dir straight below its .alate/layers. */
	function layerHome(): { home: string; id: string; layer: string } {
		const home = freshWorkerHome();
		const id = `lease-layer-${leaseN++}`;
		const layer = join(home, ".alate", "layers", id);
		mkdirSync(layer, { recursive: true });
		return { home, id, layer };
	}
	const releaseFile = (): string => join(dir, `lease-release-${leaseN++}`);
	const leasedIds = (home: string): string[] =>
		readLayerUse(home).map((e) => e.id);

	async function until(
		cond: () => Promise<boolean> | boolean,
		what: string,
	): Promise<void> {
		const deadline = Date.now() + 20_000;
		for (;;) {
			if (await cond()) return;
			if (Date.now() > deadline) throw new Error(`${what}: never happened`);
			await Bun.sleep(50);
		}
	}

	async function postRun(
		url: string,
		id: string,
		home: string,
		release: string,
	): Promise<Response> {
		return await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id,
				argv: [gatePath, release],
				cwd: dir,
				stdin: "",
				env: { HOME: home },
			}),
		});
	}

	/** POST /run of the gate child with the request HOME the board's pin sends. */
	async function gateRun(
		url: string,
		id: string,
		home: string,
		release: string,
		readers: Reader[],
	): Promise<Reader> {
		const res = await postRun(url, id, home, release);
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		readers.push(reader);
		// The tick proves the spawn, and the lease is taken before the spawn.
		expect((await reader.read()).done).toBe(false);
		return reader;
	}

	async function drain(reader: Reader): Promise<string> {
		const dec = new TextDecoder();
		let text = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return text;
			text += dec.decode(value, { stream: true });
		}
	}

	async function detachedList(url: string): Promise<Record<string, unknown>[]> {
		const res = await fetch(`${url}/detached`);
		expect(res.status).toBe(200);
		return (await res.json()) as Record<string, unknown>[];
	}

	async function detachAll(url: string, n: number): Promise<void> {
		const res = await fetch(`${url}/detach`, { method: "POST" });
		expect(await res.json()).toEqual({ detached: n });
	}

	/** The finally of every test: release each gate child and wait for its natural close
	 * (attached: its stream ends; detached: its /detached entry stops running). */
	async function settle(
		releases: string[],
		readers: Reader[],
		urls: string[],
	): Promise<void> {
		for (const r of releases) writeFileSync(r, "");
		for (const r of readers) await drain(r);
		for (const u of urls)
			await until(
				async () => (await detachedList(u)).every((e) => e.running === false),
				"detached children close",
			);
	}

	test("a detached child keeps its lease past the stream and a rebuild; its close clears it", async () => {
		const { home, id, layer } = layerHome();
		const release = releaseFile();
		const readers: Reader[] = [];
		const url = start({ ompPath: process.execPath, home });
		try {
			const reader = await gateRun(url, "lease-d1", layer, release, readers);
			expect(leasedIds(home)).toEqual([id]);
			// The board stream settles: the detach closes it with the child still live.
			await detachAll(url, 1);
			expect((await reader.read()).done).toBe(true);
			expect(leasedIds(home)).toEqual([id]);
			// Boot reconciliation with no open turn layers keeps the live worker holder.
			rebuildLayerUse(home, []);
			expect(leasedIds(home)).toEqual([id]);
			// The public registry keeps its exact shape: no owner metadata.
			const raw = JSON.parse(
				readFileSync(join(home, ".alate", "in-use.json"), "utf8"),
			) as { layers: Record<string, unknown>[] };
			expect(Object.keys(raw)).toEqual(["layers"]);
			expect(raw.layers.map((e) => Object.keys(e).sort())).toEqual([
				["id", "since"],
			]);
			// The /detached wire shape: the lease never rides it. OTTR-1261 added
			// one field, the run's data dir the /runprobe session check reads.
			const [entry] = await detachedList(url);
			expect(Object.keys(entry ?? {}).sort()).toEqual([
				"cwd",
				"dataDir",
				"id",
				"pid",
				"running",
				"startedAt",
			]);
			writeFileSync(release, "");
			await until(
				async () => (await detachedList(url))[0]?.running === false,
				"detached child close",
			);
			await until(() => leasedIds(home).length === 0, "lease release");
		} finally {
			await settle([release], readers, [url]);
		}
	}, 30_000);

	test("independent workers and runs on one layer release only their own lease", async () => {
		const { home, id, layer } = layerHome();
		const relA = releaseFile();
		const relB = releaseFile();
		const relC = releaseFile();
		const readers: Reader[] = [];
		const urlA = start({ ompPath: process.execPath, home });
		const urlB = start({ ompPath: process.execPath, home });
		try {
			const readerA = await gateRun(urlA, "lease-a", layer, relA, readers);
			const readerB = await gateRun(urlB, "lease-b", layer, relB, readers);
			const readerC = await gateRun(urlB, "lease-c", layer, relC, readers);
			expect(leasedIds(home)).toEqual([id]);
			// Worker B loses both streams; worker A stays attached.
			await detachAll(urlB, 2);
			expect((await readerB.read()).done).toBe(true);
			expect((await readerC.read()).done).toBe(true);
			expect(leasedIds(home)).toEqual([id]);
			// B's first child closes: A and C still hold the layer, through a rebuild too.
			writeFileSync(relB, "");
			await until(
				async () =>
					(await detachedList(urlB)).find((e) => e.id === "lease-b")
						?.running === false,
				"lease-b close",
			);
			expect(leasedIds(home)).toEqual([id]);
			rebuildLayerUse(home, []);
			expect(leasedIds(home)).toEqual([id]);
			// A's attached child closes with its sentinel: C still holds the layer.
			writeFileSync(relA, "");
			expect(await drain(readerA)).toContain(WORKER_DONE);
			expect(leasedIds(home)).toEqual([id]);
			// The last holder's close clears the layer.
			writeFileSync(relC, "");
			await until(() => leasedIds(home).length === 0, "last lease release");
		} finally {
			await settle([relA, relB, relC], readers, [urlA, urlB]);
		}
	}, 60_000);

	test("a spawn error releases its own lease once and spares a live holder", async () => {
		const { home, id, layer } = layerHome();
		const release = releaseFile();
		const readers: Reader[] = [];
		const live = start({ ompPath: process.execPath, home });
		// A missing omp binary: Bun fires both "error" and "close", and no child exists.
		const broken = start({ ompPath: join(dir, "no-such-omp"), home });
		try {
			const reader = await gateRun(live, "lease-live", layer, release, readers);
			expect(leasedIds(home)).toEqual([id]);
			for (const n of [1, 2]) {
				const res = await postRun(broken, `lease-err-${n}`, layer, release);
				await res.text();
				expect(leasedIds(home)).toEqual([id]);
			}
			// The failed runs left no lease behind: the live close alone clears the layer.
			writeFileSync(release, "");
			expect(await drain(reader)).toContain(WORKER_DONE);
			await until(() => leasedIds(home).length === 0, "live lease release");
		} finally {
			await settle([release], readers, [live]);
		}
	}, 30_000);

	test("a HOME outside the worker home's real direct layers takes no lease", async () => {
		const { home, layer } = layerHome();
		const foreign = layerHome();
		const nested = join(layer, "nested");
		mkdirSync(nested);
		const linked = join(home, ".alate", "layers", "linked");
		symlinkSync(foreign.layer, linked);
		const releases: string[] = [];
		const readers: Reader[] = [];
		const url = start({ ompPath: process.execPath, home });
		try {
			for (const [i, requestHome] of [
				foreign.layer,
				nested,
				linked,
				home,
			].entries()) {
				const release = releaseFile();
				releases.push(release);
				const reader = await gateRun(
					url,
					`lease-out-${i}`,
					requestHome,
					release,
					readers,
				);
				expect(leasedIds(home)).toEqual([]);
				expect(leasedIds(foreign.home)).toEqual([]);
				writeFileSync(release, "");
				expect(await drain(reader)).toContain(WORKER_DONE);
			}
		} finally {
			await settle(releases, readers, [url]);
		}
	}, 60_000);
});

// Per-project turn identity through the daemon (OTTR-994): root-only, because the
// feature drops the child to a non-root uid and chowns fixtures.
describe("serveWorker turn identity", () => {
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	const rootTest = isRoot ? test : test.skip;

	const post = async (
		url: string,
		body: Record<string, unknown>,
	): Promise<Response> =>
		// The stream stays open un-drained; the pid file proves the spawn, and the
		// detach cleanup closes it. The callers await the response.
		fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	rootTest(
		"each project drops to its own uid and home; the layer copy retargets caches",
		async () => {
			const workerHome = freshWorkerHome();
			const homesRoot = freshWorkerHome();
			// A real workspace: each project dir holds a git repo, the daemon's
			// structural git-dir derivation and per-run chown run against it.
			const ws = freshWorkerHome();
			// Own passwd/group fixtures: provisioning writes these, never the host's
			// real files (a leftover ottr-<id> entry carrying another run's temp home
			// would fail the identity check closed).
			const passwd = join(homesRoot, "passwd");
			const group = join(homesRoot, "group");
			writeFileSync(passwd, "root:x:0:0:root:/root:/bin/bash\n");
			writeFileSync(group, "root:x:0:\n");
			const mkRepo = (name: string): string => {
				const repo = join(ws, name);
				mkdirSync(repo, { recursive: true });
				Bun.spawnSync(["git", "-C", repo, "init", "-b", "main"], {
					stdout: "ignore",
					stderr: "ignore",
				});
				return repo;
			};
			const cwdA = mkRepo("proj-a");
			const cwdB = mkRepo("proj-b");
			// Identity stub: prints the child's uid and the env values the boundary
			// protects. Executable (0755) and reachable: the stub dir gets a plain
			// world-readable mode, because mkdtemp dirs are 0700 root-only and the
			// real omp binary lives in the image's world-executable PATH instead.
			const identPath = join(workerHome, "ident-omp.js");
			writeFileSync(
				identPath,
				`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ uid: process.getuid(), HOME: process.env.HOME, PI: process.env.PI_CODING_AGENT_DIR, SECRET: process.env.DUMMY_SECRET }) + "\\n");`,
			);
			chmodSync(identPath, 0o755);
			chmodSync(workerHome, 0o755);
			// One pinned layer in the shared home, with the pin's absolute state links.
			const layerDir = join(workerHome, ".alate", "layers", "l1");
			mkdirSync(join(layerDir, ".omp", "agent"), { recursive: true });
			mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
			mkdirSync(join(workerHome, ".cache"), { recursive: true });
			const dbTarget = join(workerHome, ".omp", "agent", "agent.db");
			symlinkSync(dbTarget, join(layerDir, ".omp", "agent", "agent.db"));
			symlinkSync(join(workerHome, ".cache"), join(layerDir, ".cache"));
			// The per-turn store check verifies the shared chain before spawn
			// (OTTR-1291): the fixture carries the healthy boot state, or the
			// drift note would precede the stub's JSON line in the stream.
			chmodSync(join(workerHome, ".omp", "agent"), 0o1777);
			writeFileSync(dbTarget, "store");
			chmodSync(dbTarget, 0o666);

			const url = start({
				ompPath: identPath,
				home: workerHome,
				turnUid: {
					homesRoot,
					workerHome,
					dataRoots: [],
					workspaceRoot: ws,
					provisionPaths: { passwd, group },
				},
			});
			const run = async (
				project: string,
				repo: string,
				extra?: { bodyProject?: boolean; flatHome?: boolean },
			): Promise<string[]> => {
				const res = await post(url, {
					id: `ti-${project}`,
					argv: ["-p"],
					cwd: repo,
					stdin: "",
					...(extra?.bodyProject ? { project } : {}),
					env: {
						...(extra?.bodyProject ? {} : { OTTR_PROJECT: project }),
						...(extra?.flatHome ? {} : { HOME: layerDir }),
						...(extra?.flatHome
							? {}
							: { PI_CODING_AGENT_DIR: join(layerDir, ".omp", "agent") }),
						DUMMY_SECRET: `s3cret-${project}`,
					},
				});
				expect(res.status).toBe(200);
				return readLines(res);
			};

			// OTTR-1210: the run's marker line. A foreign holder line (a live
			// turn on the other worker) pre-exists; the run appends its own
			// line at start and releases exactly it at child close. The layers
			// dir does not exist yet (prepareTurnHome makes it inside the run),
			// so the pre-write makes it first.
			const markerA = join(homesRoot, "proj-a", "layers", "l1.inuse");
			mkdirSync(join(homesRoot, "proj-a", "layers"), { recursive: true });
			const foreignLine = "cafe0102 2026-11-22T00:00:00.000Z\n";
			writeFileSync(markerA, foreignLine);
			const resA = await post(url, {
				id: "ti-proj-a",
				argv: ["-p"],
				cwd: cwdA,
				stdin: "",
				env: {
					OTTR_PROJECT: "proj-a",
					HOME: layerDir,
					PI_CODING_AGENT_DIR: join(layerDir, ".omp", "agent"),
					DUMMY_SECRET: "s3cret-proj-a",
				},
			});
			expect(resA.status).toBe(200);
			// Mid-run: the marker holds the foreign line plus the run's own.
			// No promise signals the daemon's marker write, so this polls the
			// file (the file's poll helpers above use the same real-time loop).
			const deadline = Date.now() + 5_000;
			let mid = "";
			while (Date.now() < deadline) {
				mid = readFileSync(markerA, "utf8");
				if (mid.startsWith(foreignLine) && mid.length > foreignLine.length)
					break;
				await Bun.sleep(20);
			}
			expect(mid.startsWith(foreignLine)).toBe(true);
			expect(mid.length).toBeGreaterThan(foreignLine.length);
			const linesA = await readLines(resA);
			const dumpedA = JSON.parse(linesA[0]!) as {
				uid: number;
				HOME: string;
				PI: string;
				SECRET: string;
			};
			const idsA = projectTurnUid("proj-a");
			expect(dumpedA.uid).toBe(idsA.uid);
			const homeA = join(homesRoot, "proj-a", "layers", "l1");
			expect(dumpedA.HOME).toBe(homeA);
			expect(dumpedA.PI).toBe(join(homeA, ".omp", "agent"));
			expect(dumpedA.SECRET).toBe("s3cret-proj-a");
			// The cache link inside the copy points into the project's writable home;
			// the cache dir itself the turn creates through the link.
			expect(readlinkSync(join(homeA, ".cache"))).toBe(
				join(homesRoot, "proj-a", "home", ".cache"),
			);
			expect(existsSync(join(homesRoot, "proj-a", "home", ".cache"))).toBe(
				false,
			);
			// The state link keeps its flat shared-home target.
			expect(readlinkSync(join(homeA, ".omp", "agent", "agent.db"))).toBe(
				dbTarget,
			);
			const sentinelA = JSON.parse(linesA[1]!) as {
				[WORKER_DONE]: { exitCode: number };
			};
			expect(sentinelA[WORKER_DONE].exitCode).toBe(0);
			// At close the run's own line is gone and the foreign holder line
			// stays byte-exact: the release never touches another run's line.
			expect(readFileSync(markerA, "utf8")).toBe(foreignLine);

			// A second project lands on a different uid and its own home.
			const linesB = await run("proj-b", cwdB);
			const dumpedB = JSON.parse(linesB[0]!) as { uid: number; HOME: string };
			expect(dumpedB.uid).toBe(projectTurnUid("proj-b").uid);
			expect(dumpedB.uid).not.toBe(idsA.uid);
			expect(dumpedB.HOME).toBe(join(homesRoot, "proj-b", "layers", "l1"));

			// A stripBoard run (retro, proposal) carries no OTTR_PROJECT in its env;
			// the request's project field keeps its identity.
			const linesC = await run("proj-a", cwdA, { bodyProject: true });
			const dumpedC = JSON.parse(linesC[0]!) as { uid: number };
			expect(dumpedC.uid).toBe(idsA.uid);

			// An unpinned run gets the turn home's writable home with the flat
			// identity link instead of the layer copy.
			const linesD = await run("proj-a", cwdA, { flatHome: true });
			const dumpedD = JSON.parse(linesD[0]!) as { HOME: string };
			expect(dumpedD.HOME).toBe(join(homesRoot, "proj-a", "home"));
			expect(readlinkSync(join(dumpedD.HOME, ".omp"))).toBe(
				join(workerHome, ".omp"),
			);
		},
		30_000,
	);

	rootTest(
		"a vanished pinned layer fails the run closed",
		async () => {
			const workerHome = freshWorkerHome();
			const homesRoot = freshWorkerHome();
			const ws = freshWorkerHome();
			// Own passwd/group fixtures: provisioning writes these, never the host's
			// real files.
			const passwd = join(homesRoot, "passwd");
			const group = join(homesRoot, "group");
			writeFileSync(passwd, "root:x:0:0:root:/root:/bin/bash\n");
			writeFileSync(group, "root:x:0:\n");
			const url = start({
				ompPath: process.execPath,
				home: workerHome,
				turnUid: {
					homesRoot,
					workerHome,
					dataRoots: [],
					workspaceRoot: ws,
					provisionPaths: { passwd, group },
				},
			});
			const res = await post(url, {
				id: "ti-gone",
				argv: ["-p"],
				cwd: ws,
				stdin: "",
				env: {
					OTTR_PROJECT: "gone-proj",
					HOME: join(workerHome, ".alate", "layers", "gone"),
				},
			});
			expect(res.status).toBe(500);
			expect(await res.text()).toContain("vanished");
		},
		30_000,
	);

	// The run's identity under test. A root gate keeps the project's real
	// hashed uid — the production path: the caller is root, this fixture's
	// records hold uid 0 for root, and ensureProjectIdentity refuses an id
	// an unrelated account holds. An unprivileged gate runs as the caller's
	// own uid, where chown-to-self needs no privilege and no fixture record
	// holds the id. Both keep the identity check fully intact.
	const turnIdentity = (project: string): TurnIdentity =>
		isRoot
			? projectTurnUid(project)
			: {
					uid: typeof process.getuid === "function" ? process.getuid() : 0,
					gid: typeof process.getgid === "function" ? process.getgid() : 0,
				};

	test("a run provisions the project identity and pins its git identity env", async () => {
		const ids = turnIdentity("git-env-proj");
		const workerHome = freshWorkerHome();
		const homesRoot = freshWorkerHome();
		const ws = freshWorkerHome();
		const passwd = join(homesRoot, "passwd");
		const group = join(homesRoot, "group");
		writeFileSync(passwd, "root:x:0:0:root:/root:/bin/bash\n");
		writeFileSync(group, "root:x:0:\n");
		const repo = join(ws, "git-env-proj");
		mkdirSync(repo, { recursive: true });
		Bun.spawnSync(["git", "-C", repo, "init", "-b", "main"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		// Identity stub: dumps the env keys the git-identity rewrite must touch.
		const identPath = join(workerHome, "gitenv-omp.js");
		writeFileSync(
			identPath,
			`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, A_NAME: process.env.GIT_AUTHOR_NAME, A_EMAIL: process.env.GIT_AUTHOR_EMAIL, C_NAME: process.env.GIT_COMMITTER_NAME, C_EMAIL: process.env.GIT_COMMITTER_EMAIL }) + "\\n");`,
		);
		chmodSync(identPath, 0o755);
		chmodSync(workerHome, 0o755);
		// The per-turn store check verifies the shared chain before spawn
		// (OTTR-1291): without the healthy store the guard refuses the run
		// and the run never reaches the identity stub.
		const sharedAgent = join(workerHome, ".omp", "agent");
		mkdirSync(sharedAgent, { recursive: true });
		chmodSync(sharedAgent, 0o1777);
		writeFileSync(join(sharedAgent, "agent.db"), "store");
		chmodSync(join(sharedAgent, "agent.db"), 0o666);

		const url = start({
			ompPath: identPath,
			home: workerHome,
			turnUid: {
				homesRoot,
				workerHome,
				dataRoots: [],
				workspaceRoot: ws,
				ids,
				provisionPaths: { passwd, group },
			},
		});
		const res = await post(url, {
			id: "ti-git-env",
			argv: ["-p"],
			cwd: repo,
			stdin: "",
			project: "git-env-proj",
			env: {
				GIT_AUTHOR_NAME: "junk",
				GIT_AUTHOR_EMAIL: "junk@junk",
			},
		});
		expect(res.status).toBe(200);
		const dumped = JSON.parse((await readLines(res))[0] ?? "") as Record<
			string,
			string | undefined
		>;
		const gitconfig = join(homesRoot, "git-env-proj", "ottr", "gitconfig");
		expect(dumped.GIT_CONFIG_GLOBAL).toBe(gitconfig);
		expect(dumped.A_NAME).toBeUndefined();
		expect(dumped.A_EMAIL).toBeUndefined();
		expect(dumped.C_NAME).toBeUndefined();
		expect(dumped.C_EMAIL).toBeUndefined();

		// The passwd and group files gained one entry each for the project uid.
		const passwdLine = readFileSync(passwd, "utf8")
			.split("\n")
			.find((l) => l.split(":")[2] === String(ids.uid));
		expect(passwdLine).toBeDefined();
		const groupLine = readFileSync(group, "utf8")
			.split("\n")
			.find((l) => l.split(":")[2] === String(ids.uid));
		expect(groupLine).toBeDefined();
		// The daemon-owned gitconfig pins the project identity.
		const gitconfigText = readFileSync(gitconfig, "utf8");
		expect(gitconfigText).toContain("[user]");
	}, 30_000);

	// The pinned-layer fixture both store tests share: passwd/group snapshots,
	// one git repo, a pinned layer whose db link targets the flat shared home,
	// and an omp stub that plays the store access omp does (OTTR-1291).
	function storeFixture(project: string): {
		workerHome: string;
		homesRoot: string;
		ws: string;
		repo: string;
		layerDir: string;
		dbTarget: string;
	} {
		const workerHome = freshWorkerHome();
		const homesRoot = freshWorkerHome();
		const ws = freshWorkerHome();
		const passwd = join(homesRoot, "passwd");
		const group = join(homesRoot, "group");
		writeFileSync(passwd, "root:x:0:0:root:/root:/bin/bash\n");
		writeFileSync(group, "root:x:0:\n");
		const repo = join(ws, project);
		mkdirSync(repo, { recursive: true });
		Bun.spawnSync(["git", "-C", repo, "init", "-b", "main"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const layerDir = join(workerHome, ".alate", "layers", "l1");
		mkdirSync(join(layerDir, ".omp", "agent"), { recursive: true });
		mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
		const dbTarget = join(workerHome, ".omp", "agent", "agent.db");
		writeFileSync(dbTarget, "store");
		symlinkSync(dbTarget, join(layerDir, ".omp", "agent", "agent.db"));
		// The stub dir gets a plain world-readable mode, because mkdtemp dirs
		// are 0700 root-only and the real omp binary lives in the image's
		// world-executable PATH instead.
		chmodSync(workerHome, 0o755);
		// The turn uid must traverse the homes root to reach its layer copy
		// (HOME lives under it): the real homes root is a volume mount point,
		// so give the fixture the same traversable-not-listable mode instead
		// of mkdtemp's 0700.
		chmodSync(homesRoot, 0o711);
		return { workerHome, homesRoot, ws, repo, layerDir, dbTarget };
	}

	// Both store tests run the daemon's identity steps against the test's own
	// uid (chown-to-self and setuid-to-self need no privilege), so the two
	// acceptance scenarios execute on every gate. The root-gated test above
	// covers the real cross-uid drop.

	test("a root omp reset of the store modes is restored before each turn", async () => {
		const project = "store-restore-proj";
		const ids = turnIdentity(project);
		const { workerHome, homesRoot, ws, repo, layerDir, dbTarget } =
			storeFixture(project);
		// Store stub: opens the store through PI_CODING_AGENT_DIR the way omp
		// does, and prints the result with the uid the turn ran under.
		const stubPath = join(workerHome, "store-omp.js");
		writeFileSync(
			stubPath,
			`#!${process.execPath}
const fs = require("node:fs");
let opened = "ok";
try {
	fs.closeSync(fs.openSync(process.env.PI_CODING_AGENT_DIR + "/agent.db", "r+"));
} catch (err) {
	opened = String(err);
}
process.stdout.write(JSON.stringify({ uid: process.getuid(), opened }) + "\\n");
`,
		);
		chmodSync(stubPath, 0o755);
		// The between-turns root omp reset: agent dir 0700, db and wal 0600.
		chmodSync(join(workerHome, ".omp", "agent"), 0o700);
		chmodSync(dbTarget, 0o600);
		writeFileSync(`${dbTarget}-wal`, "wal");
		chmodSync(`${dbTarget}-wal`, 0o600);

		const url = start({
			ompPath: stubPath,
			home: workerHome,
			turnUid: {
				homesRoot,
				workerHome,
				dataRoots: [],
				workspaceRoot: ws,
				ids,
				provisionPaths: {
					passwd: join(homesRoot, "passwd"),
					group: join(homesRoot, "group"),
				},
			},
		});
		const res = await post(url, {
			id: "ti-store-restore",
			argv: ["-p"],
			cwd: repo,
			stdin: "",
			env: {
				OTTR_PROJECT: project,
				HOME: layerDir,
				PI_CODING_AGENT_DIR: join(layerDir, ".omp", "agent"),
			},
		});
		expect(res.status).toBe(200);
		const lines = await readLines(res);
		// The turn uid opened the store: the modes were restored before spawn.
		const stubLine = lines.find((l) => l.includes('"opened"'));
		expect(stubLine).toBeDefined();
		const dumped = JSON.parse(stubLine!) as {
			uid: number;
			opened: string;
		};
		expect(dumped.opened).toBe("ok");
		expect(dumped.uid).toBe(ids.uid);
		// Exactly one drift line rode the stream. A shared test uid can add a
		// collision note (the uid-owners map is per process); it names no
		// drift, so only the drift prefix counts.
		const driftLines = lines.filter((l) =>
			l.startsWith("turn-uid: shared store modes drifted"),
		);
		expect(driftLines.length).toBe(1);
		expect(driftLines[0]).toContain("shared store modes drifted");
		// The shared home carries the boot modes again.
		expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o7777).toBe(
			0o1777,
		);
		expect(statSync(dbTarget).mode & 0o777).toBe(0o666);
		expect(statSync(`${dbTarget}-wal`).mode & 0o777).toBe(0o666);
	}, 30_000);

	test("a mounted drifted store refuses the run instead of chmodding through the mount", async () => {
		const project = "store-mounted-proj";
		const ids = turnIdentity(project);
		const { workerHome, homesRoot, ws, repo, layerDir, dbTarget } =
			storeFixture(project);
		// Store stub: writes a marker first thing, so an assertion on the
		// marker proves omp never started.
		const marker = join(homesRoot, "mounted-marker");
		const stubPath = join(workerHome, "mounted-omp.js");
		writeFileSync(
			stubPath,
			`#!${process.execPath}
require("node:fs").writeFileSync(process.env.STORE_MARKER, "started\\n");
`,
		);
		chmodSync(stubPath, 0o755);
		chmodSync(join(workerHome, ".omp", "agent"), 0o700);
		chmodSync(dbTarget, 0o600);

		const url = start({
			ompPath: stubPath,
			home: workerHome,
			turnUid: {
				homesRoot,
				workerHome,
				dataRoots: [],
				workspaceRoot: ws,
				ids,
				provisionPaths: {
					passwd: join(homesRoot, "passwd"),
					group: join(homesRoot, "group"),
				},
				isMounted: (p) => p === dbTarget,
			},
		});
		const res = await post(url, {
			id: "ti-store-mounted",
			argv: ["-p"],
			cwd: repo,
			stdin: "",
			env: {
				OTTR_PROJECT: project,
				HOME: layerDir,
				PI_CODING_AGENT_DIR: join(layerDir, ".omp", "agent"),
				STORE_MARKER: marker,
			},
		});
		expect(res.status).toBe(500);
		const body = await res.text();
		expect(body).toContain(STORE_MOUNT_BLOCKED);
		expect(body).toContain(dbTarget);
		expect(body).toContain("host");
		// omp never started.
		expect(existsSync(marker)).toBe(false);
		// Nothing was chmodded through the mount: the drift stays as it was.
		expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o7777).toBe(
			0o700,
		);
		expect(statSync(dbTarget).mode & 0o777).toBe(0o600);
	}, 30_000);
});

describe("stale turn probe and fix (OTTR-1261)", () => {
	// Safety contract for this block: kill assertions run against a fake proc tree
	// through the staleKill seam (a recording kill), so no test can ever signal a
	// process it did not create; the only real signals land via the daemon's own
	// /detach/kill cleanup path on children these tests started. pidAlive reads are
	// signal-0 probes on dead pids or on the run child itself.
	//
	// A dead pid for lock fixtures: a real child the test spawned to completion.
	function spawnDeadPid(): number {
		const p = Bun.spawnSync([process.execPath, "-e", ""]);
		return p.pid;
	}

	// Fake proc entry with tick fields: the stat layout readTree parses — fields after
	// the last ")" are state, ppid, then nine counters, then utime stime cutime cstime.
	function staleProcFixture(
		procRoot: string,
		e: {
			pid: number;
			ppid: number;
			ticks?: [number, number, number, number];
			cmd?: string[];
		},
	): void {
		const p = join(procRoot, String(e.pid));
		mkdirSync(p, { recursive: true });
		const [ut, st, cut, cst] = e.ticks ?? [0, 0, 0, 0];
		writeFileSync(
			join(p, "stat"),
			`${e.pid} (bun) S ${e.ppid} 0 0 0 0 0 0 0 0 0 ${ut} ${st} ${cut} ${cst}\n`,
		);
		if (e.cmd !== undefined)
			writeFileSync(
				join(p, "cmdline"),
				e.cmd.map((seg) => `${seg}\0`).join(""),
			);
	}

	function freshProcRoot(): string {
		return join(dir, `stale-proc-${procRootN++}`);
	}
	let procRootN = 0;

	// Starts the daemon's run with the sleeper fake omp and waits for the child's pid
	// file: the stream stays open (the pid file proves the spawn, like the detach
	// tests). No beat file: under load a spawned child's wall-clock beats lag by
	// seconds, so cleanup below proves the kill by the pid's death instead.
	async function startStaleRun(
		url: string,
		token: string,
		id: string,
		cwd: string,
		env: Record<string, string>,
	): Promise<{ pid: number; pidFile: string }> {
		const pidFile = join(dir, `stale-${id}.pid`);
		// The stream stays open un-drained; the pid file proves the spawn, and the
		// detach cleanup closes it. void: intentionally floating (biome).
		void fetch(`${url}/run`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-otwr-token": token,
			},
			body: JSON.stringify({
				id,
				argv: [sweepSleepPath, pidFile],
				cwd,
				stdin: "",
				env,
			}),
		});
		const deadline = Date.now() + 20_000;
		for (;;) {
			try {
				const pid = Number(readFileSync(pidFile, "utf8"));
				if (Number.isInteger(pid) && pid > 0) return { pid, pidFile };
			} catch {
				// not written yet
			}
			if (Date.now() > deadline)
				throw new Error(`run ${id}: child never wrote its pid`);
			await Bun.sleep(50);
		}
	}

	// The approved cleanup: the daemon's own detach + detach/kill path stops the child
	// the test created; the child's pid disappearing proves the kill landed (the
	// daemon TERMs first and SIGKILLs after its grace, so the poll cannot hang).
	async function stopStaleRun(
		url: string,
		token: string,
		id: string,
		pidFile: string,
	): Promise<void> {
		await fetch(`${url}/detach`, {
			method: "POST",
			headers: { "x-otwr-token": token },
		});
		await fetch(`${url}/detach/kill`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-otwr-token": token,
			},
			body: JSON.stringify({ id }),
		});
		const pid = Number(readFileSync(pidFile, "utf8"));
		const deadline = Date.now() + 20_000;
		for (;;) {
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch {
				alive = false;
			}
			if (!alive) return;
			if (Date.now() > deadline)
				throw new Error(`stale run cleanup: pid ${pid} survived the kill`);
			await Bun.sleep(20);
		}
	}

	const postJson = (
		url: string,
		path: string,
		token: string,
		body: unknown,
	): Promise<Response> =>
		fetch(`${url}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-otwr-token": token,
			},
			body: JSON.stringify(body),
		});

	test("runprobe and stalefix need the token", async () => {
		const url = start({ token: "sekrit", ompPath: process.execPath });
		for (const path of ["/runprobe", "/stalefix"]) {
			const res = await postJson(url, path, "wrong", { run: "x" });
			expect(res.status).toBe(401);
			expect(await res.text()).toBe("unauthorized");
		}
	});

	test("malformed probe and fix bodies answer 400", async () => {
		const url = start({ token: "t", ompPath: process.execPath });
		const bad = await postJson(url, "/runprobe", "t", { run: 42 });
		expect(bad.status).toBe(400);
		expect(await bad.text()).toBe("bad request");
		expect((await postJson(url, "/runprobe", "t", {})).status).toBe(400);
		expect((await postJson(url, "/runprobe", "t", { run: "" })).status).toBe(
			400,
		);
		const raw = await fetch(`${url}/runprobe`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-otwr-token": "t" },
			body: "not json",
		});
		expect(raw.status).toBe(400);
		expect(await raw.text()).toBe("bad json");
		// Fix shapes: run string, then unlock needs a path, kill needs a positive
		// integer pid — every miss 400s before any run lookup.
		expect((await postJson(url, "/stalefix", "t", {})).status).toBe(400);
		expect((await postJson(url, "/stalefix", "t", { run: "x" })).status).toBe(
			400,
		);
		expect(
			(await postJson(url, "/stalefix", "t", { run: "x", action: "unlock" }))
				.status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "kill",
					pid: "5",
				})
			).status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "kill",
					pid: 1.5,
				})
			).status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "kill",
					pid: 0,
				})
			).status,
		).toBe(400);
		// The session id selects the run's own transcript: absent is fine, anything
		// but a short non-empty string is a bad body (OTTR-1261).
		expect(
			(await postJson(url, "/runprobe", "t", { run: "x", sessionId: "" }))
				.status,
		).toBe(400);
		expect(
			(await postJson(url, "/runprobe", "t", { run: "x", sessionId: 42 }))
				.status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/runprobe", "t", {
					run: "x",
					sessionId: "s".repeat(201),
				})
			).status,
		).toBe(400);
		// At the cap the shape is valid: the unknown run id answers 404.
		expect(
			(
				await postJson(url, "/runprobe", "t", {
					run: "ghost",
					sessionId: "s".repeat(200),
				})
			).status,
		).toBe(404);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "unlock",
					path: "/tmp/gate-7/x.lock",
					expect: { sessionCommand: "sleep 600" },
					sessionId: "",
				})
			).status,
		).toBe(400);
		// OTTR-1261: both fixes carry the diagnosis (expect) — a kill without it,
		// or with an off-shape one, 400s before any run lookup; so does an unlock
		// without the expect.
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "kill",
					pid: 5,
				})
			).status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "unlock",
					path: "/tmp/gate-7/x.lock",
				})
			).status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "kill",
					pid: 5,
					expect: "no",
				})
			).status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "kill",
					pid: 5,
					expect: { sessionCommand: "sleep 600" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "kill",
					pid: 5,
					expect: {
						sessionCommand: "sleep 600",
						ticks: -1,
						dep: { kind: "inline", pid: 2 },
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "kill",
					pid: 5,
					expect: {
						sessionCommand: "sleep 600",
						ticks: 0,
						dep: { kind: "alien" },
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "x",
					action: "kill",
					pid: 5,
					expect: {
						sessionCommand: "sleep 600",
						ticks: 0,
						dep: { kind: "inline", pid: 0 },
					},
				})
			).status,
		).toBe(400);
	});

	test("unknown run id errors on both endpoints and clients", async () => {
		const url = start({ token: "t", ompPath: process.execPath });
		const target: WorkerTarget = { urls: [url], token: "t" };
		const miss = await postJson(url, "/runprobe", "t", { run: "ghost" });
		expect(miss.status).toBe(404);
		expect(await miss.text()).toBe("not found");
		// A well-shaped fix body on an unknown run: 404 (the shape validated first).
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "ghost",
					action: "unlock",
					path: "/tmp/gate-ghost/x.lock",
					expect: { sessionCommand: "sleep 600" },
				})
			).status,
		).toBe(404);
		expect(
			(
				await postJson(url, "/stalefix", "t", {
					run: "ghost",
					action: "kill",
					pid: 5000,
					expect: {
						sessionCommand: "sleep 600",
						ticks: 3,
						dep: { kind: "inline", pid: 5001 },
					},
				})
			).status,
		).toBe(404);
		await expect(probeRun(target, url, "ghost")).rejects.toBeInstanceOf(
			WorkerConnectError,
		);
		await expect(
			staleFix(target, url, {
				run: "ghost",
				action: "kill",
				pid: 5000,
				expect: {
					sessionCommand: "sleep 600",
					ticks: 3,
					dep: { kind: "inline", pid: 5001 },
				},
			}),
		).rejects.toBeInstanceOf(WorkerConnectError);
	});

	test("probeRun and staleFix POST the exact method and path", async () => {
		const seen: {
			method: string;
			path: string;
			token: string | null;
			body: unknown;
		}[] = [];
		let answer: () => Response = () => Response.json({});
		const cap = Bun.serve({
			port: 0,
			async fetch(req) {
				const u = new URL(req.url);
				let body: unknown = null;
				try {
					body = JSON.parse(await req.text());
				} catch {
					body = null;
				}
				seen.push({
					method: req.method,
					path: u.pathname,
					token: req.headers.get("x-otwr-token"),
					body,
				});
				return answer();
			},
		});
		servers.push(cap as Bun.Server<never>);
		const capUrl = `http://127.0.0.1:${cap.port}`;
		const target: WorkerTarget = { urls: [capUrl], token: "t" };
		// The documented wire shapes: POST { run } on /runprobe — with the session id
		// only when the caller knows it (OTTR-1261) — and the fix request verbatim
		// on /stalefix.
		const probeBody = {
			pid: 77,
			alive: false,
			procs: [{ pid: 77, ppid: 1, ticks: 3, command: "bun run dev" }],
			sessionAt: 1000,
			lastTool: { tool: "bash", command: "sleep 600", timeout: 0 },
			locks: [
				{ path: "/tmp/gate-7/x.lock", exists: true, pid: 5, alive: false },
			],
			pidFiles: [
				{ path: "/tmp/gate-7/t.pid", exists: false, pid: null, alive: null },
			],
			pids: [{ pid: 5100, alive: false }],
			ports: [{ port: 3000, listeners: null }],
		};
		answer = () => Response.json(probeBody);
		expect(await probeRun(target, capUrl, "r-7")).toEqual(probeBody);
		expect(seen.at(-1)).toEqual({
			method: "POST",
			path: "/runprobe",
			token: "t",
			body: { run: "r-7" },
		});
		await probeRun(target, capUrl, "r-7", "sess-9");
		expect(seen.at(-1)?.body).toEqual({ run: "r-7", sessionId: "sess-9" });
		await probeRun(target, capUrl, "r-7", null);
		expect(seen.at(-1)?.body).toEqual({ run: "r-7" });
		answer = () => Response.json({ ok: true });
		const killExpect: KillExpect = {
			sessionCommand: "sleep 600",
			ticks: 3,
			dep: { kind: "inline", pid: 77 },
		};
		expect(
			await staleFix(target, capUrl, {
				run: "r-7",
				action: "kill",
				pid: 5102,
				expect: killExpect,
			}),
		).toEqual({ ok: true });
		expect(seen.at(-1)).toEqual({
			method: "POST",
			path: "/stalefix",
			token: "t",
			body: { run: "r-7", action: "kill", pid: 5102, expect: killExpect },
		});
		answer = () =>
			Response.json({ ok: false, reason: "lock pid 5 still alive" });
		expect(
			await staleFix(target, capUrl, {
				run: "r-7",
				action: "unlock",
				path: "/tmp/gate-7/x.lock",
				expect: {
					sessionCommand: "while [ -f /tmp/gate-7/x.lock ]; do sleep 600; done",
				},
				sessionId: "sess-9",
			}),
		).toEqual({ ok: false, reason: "lock pid 5 still alive" });
		expect(seen.at(-1)?.body).toEqual({
			run: "r-7",
			action: "unlock",
			path: "/tmp/gate-7/x.lock",
			expect: {
				sessionCommand: "while [ -f /tmp/gate-7/x.lock ]; do sleep 600; done",
			},
			sessionId: "sess-9",
		});
		// A 200 body off the shape is null, not an error: the caller reads it as
		// "no usable answer".
		answer = () => Response.json({ pid: 7 });
		expect(await probeRun(target, capUrl, "r-7")).toBeNull();
		answer = () => Response.json({ ok: "yes" });
		expect(
			await staleFix(target, capUrl, {
				run: "r",
				action: "kill",
				pid: 1,
				expect: killExpect,
			}),
		).toBeNull();
		// Non-200 stays a WorkerConnectError.
		answer = () => new Response("boom", { status: 500 });
		await expect(probeRun(target, capUrl, "r-7")).rejects.toBeInstanceOf(
			WorkerConnectError,
		);
		await expect(
			staleFix(target, capUrl, {
				run: "r",
				action: "kill",
				pid: 1,
				expect: killExpect,
			}),
		).rejects.toBeInstanceOf(WorkerConnectError);
		// No token on the target: the header stays off the request.
		answer = () => Response.json({ ok: true });
		await staleFix({ urls: [capUrl] }, capUrl, {
			run: "r",
			action: "kill",
			pid: 2,
			expect: killExpect,
		});
		expect(seen.at(-1)?.token).toBeNull();
	});

	test("/runprobe reports a real child's tree, session, and locks", async () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-stale-probe-"));
		const wt = join(root, "proj", ".worktrees", "OTTR-1191");
		mkdirSync(wt, { recursive: true });
		const dataDir = join(root, "data");
		const sessions = join(dataDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const deadPid = spawnDeadPid();
		const lockPath = join(wt, "ott-stryker.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: deadPid }));
		// A previous turn's session: older than the run start, so the probe must
		// never pick it (its tool call names nothing this run locked).
		const oldSession = join(sessions, "1000_old.jsonl");
		writeFileSync(
			oldSession,
			`${JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "old",
				toolName: "bash",
				args: { command: "echo from-the-old-session", timeout: 30 },
			})}\n`,
		);
		const past = new Date(Date.now() - 60_000);
		utimesSync(oldSession, past, past);
		// This run's session: the OTTR-1191 shape — a bash tool call looping on a
		// lock file with timeout 0 (unbounded).
		const sessionPath = join(sessions, "1700000000000_probe.jsonl");
		const command = `while [ -f ${lockPath} ]; do sleep 600; done`;
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command, timeout: 0 },
			})}\n`,
		);
		const url = start({ token: "t", ompPath: process.execPath });
		const target: WorkerTarget = { urls: [url], token: "t" };
		try {
			const { pid, pidFile } = await startStaleRun(url, "t", "probe1", wt, {
				OTTR_DATA_DIR: dataDir,
			});
			// Force the mtime order past the run's startedAt stamp instead of
			// trusting Date.now() to have advanced (AGENTS.md).
			const fresh = new Date(Date.now() + 2000);
			utimesSync(sessionPath, fresh, fresh);
			// No session id: the newest-since-start fallback still works, and a loop
			// command names no pid files, inline pids, or ports.
			const probe = await probeRun(target, url, "probe1");
			expect(probe).not.toBeNull();
			expect(probe?.pid).toBe(pid);
			expect(probe?.alive).toBe(true);
			// The real /proc tree: exactly the child, whose parent is the daemon
			// itself (this test process).
			expect(probe?.procs.length).toBe(1);
			expect(probe?.procs[0]?.pid).toBe(pid);
			expect(probe?.procs[0]?.ppid).toBe(process.pid);
			expect(probe?.procs[0]?.ticks).toBeGreaterThanOrEqual(0);
			expect(probe?.procs[0]?.command).toContain("sweep-sleep-omp.js");
			expect(Math.abs((probe?.sessionAt ?? 0) - fresh.getTime())).toBeLessThan(
				5,
			);
			expect(probe?.lastTool).toEqual({
				tool: "bash",
				command,
				timeout: 0,
			});
			expect(probe?.locks).toEqual([
				{ path: lockPath, exists: true, pid: deadPid, alive: false },
			]);
			expect(probe?.pidFiles).toEqual([]);
			expect(probe?.pids).toEqual([]);
			expect(probe?.ports).toEqual([]);
			// The run's own session id picks the same file by name (OTTR-1261).
			const mine = await probeRun(target, url, "probe1", "probe");
			expect(mine?.sessionAt).not.toBeNull();
			expect(Math.abs((mine?.sessionAt ?? 0) - fresh.getTime())).toBeLessThan(
				5,
			);
			expect(mine?.lastTool).toEqual(probe?.lastTool);
			expect(mine?.locks).toEqual(probe?.locks);
			// A session id is resolved strictly by name: "old" is a real file, so its
			// own facts come back — a different command, no lock candidates.
			const old = await probeRun(target, url, "probe1", "old");
			expect(old?.sessionAt).not.toBeNull();
			expect(old?.lastTool).toEqual({
				tool: "bash",
				command: "echo from-the-old-session",
				timeout: 30,
			});
			expect(old?.locks).toEqual([]);
			// A known-missing sid reads no foreign transcript: every session fact
			// degrades to null/empty (OTTR-1261).
			const ghost = await probeRun(target, url, "probe1", "ghost");
			expect(ghost?.sessionAt).toBeNull();
			expect(ghost?.lastTool).toBeNull();
			expect(ghost?.locks).toEqual([]);
			expect(ghost?.pidFiles).toEqual([]);
			expect(ghost?.pids).toEqual([]);
			expect(ghost?.ports).toEqual([]);
			// After a detach the entry moves to the detached map, keeps dataDir on
			// the wire, and the probe still answers from it.
			expect(
				await (
					await fetch(`${url}/detach`, {
						method: "POST",
						headers: { "x-otwr-token": "t" },
					})
				).json(),
			).toEqual({ detached: 1 });
			const listed = (await (
				await fetch(`${url}/detached`, {
					headers: { "x-otwr-token": "t" },
				})
			).json()) as { dataDir?: string | null; running: boolean }[];
			expect(listed[0]?.dataDir).toBe(dataDir);
			expect(listed[0]?.running).toBe(true);
			const again = await probeRun(target, url, "probe1");
			expect(again?.pid).toBe(pid);
			expect(again?.alive).toBe(true);
			expect(again?.sessionAt).not.toBeNull();
			await stopStaleRun(url, "t", "probe1", pidFile);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("/runprobe walks the seam proc tree with exact ticks", async () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-stale-seam-"));
		const wt = join(root, "proj", ".worktrees", "OTTR-1261");
		mkdirSync(wt, { recursive: true });
		const procRoot = freshProcRoot();
		// Grandchild and an out-of-tree neighbor exist before the run spawns; the
		// run pid and its child join the fake tree once the pid is known.
		staleProcFixture(procRoot, {
			pid: 5002,
			ppid: 5001,
			ticks: [12, 0, 0, 0],
		});
		staleProcFixture(procRoot, { pid: 5099, ppid: 1, ticks: [1, 1, 1, 1] });
		const url = start({
			token: "t",
			ompPath: process.execPath,
			staleProcRoot: procRoot,
		});
		const target: WorkerTarget = { urls: [url], token: "t" };
		try {
			const { pid, pidFile } = await startStaleRun(url, "t", "seam1", wt, {});
			staleProcFixture(procRoot, {
				pid,
				ppid: 1,
				ticks: [7, 0, 0, 0],
				cmd: ["bun", "run", "dev"],
			});
			staleProcFixture(procRoot, {
				pid: 5001,
				ppid: pid,
				ticks: [10, 10, 5, 5],
				cmd: ["bash", "-c", "sleep 600"],
			});
			const probe = await probeRun(target, url, "seam1");
			expect(probe?.pid).toBe(pid);
			expect(probe?.alive).toBe(true);
			expect(probe?.procs).toEqual([
				{ pid, ppid: 1, ticks: 7, command: "bun run dev" },
				{ pid: 5001, ppid: pid, ticks: 30, command: "bash -c sleep 600" },
				{ pid: 5002, ppid: 5001, ticks: 12, command: "" },
			]);
			// No OTTR_DATA_DIR: no session facts, and no lock candidates.
			expect(probe?.sessionAt).toBeNull();
			expect(probe?.lastTool).toBeNull();
			expect(probe?.locks).toEqual([]);
			expect(probe?.pidFiles).toEqual([]);
			expect(probe?.pids).toEqual([]);
			expect(probe?.ports).toEqual([]);
			await stopStaleRun(url, "t", "seam1", pidFile);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("/runprobe picks the run's own session by id over a newer foreign one", async () => {
		// OTTR-1261 review: the fallback reads the newest transcript under the data
		// dir, so a concurrent card's newer session could suppress detection or feed
		// a foreign diagnosis. A known session id must pick the run's own file alone.
		const root = mkdtempSync(join(tmpdir(), "ottr-stale-own-"));
		const wt = join(root, "proj", ".worktrees", "OTTR-1191");
		mkdirSync(wt, { recursive: true });
		const dataDir = join(root, "data");
		const sessions = join(dataDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const deadPid = spawnDeadPid();
		const lockPath = join(wt, "ott-stryker.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: deadPid }));
		// This run's own session: the timeout-0 loop on its card's lock. Its mtime
		// stays behind the run's start — a by-name pick must ignore that.
		const ownPath = join(sessions, "1700000000000_probe.jsonl");
		const ownCommand = `while [ -f ${lockPath} ]; do sleep 600; done`;
		writeFileSync(
			ownPath,
			`${JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: ownCommand, timeout: 0 },
			})}\n`,
		);
		const past = new Date(Date.now() - 60_000);
		utimesSync(ownPath, past, past);
		// A concurrent card's session: NEWER than the run start, so the fallback
		// picks it — its tool call names only the other card's scratch lock.
		const foreignPath = join(sessions, "1700000009999_other.jsonl");
		const foreignLock = "/var/tmp/gate-1244/tmp/other.lock";
		writeFileSync(
			foreignPath,
			`${JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "call_9",
				toolName: "bash",
				args: { command: `tail -f ${foreignLock}`, timeout: 0 },
			})}\n`,
		);
		const url = start({ token: "t", ompPath: process.execPath });
		const target: WorkerTarget = { urls: [url], token: "t" };
		try {
			const { pid, pidFile } = await startStaleRun(url, "t", "own1", wt, {
				OTTR_DATA_DIR: dataDir,
			});
			// Push the foreign file's mtime past the run's startedAt stamp instead of
			// trusting Date.now() to have advanced (AGENTS.md).
			const fresh = new Date(Date.now() + 2000);
			utimesSync(foreignPath, fresh, fresh);
			// The session id wins over recency: the run's own file, older mtime and all.
			const mine = await probeRun(target, url, "own1", "probe");
			expect(mine?.pid).toBe(pid);
			expect(mine?.alive).toBe(true);
			expect(mine?.sessionAt).not.toBeNull();
			expect(Math.abs((mine?.sessionAt ?? 0) - past.getTime())).toBeLessThan(5);
			expect(mine?.lastTool).toEqual({
				tool: "bash",
				command: ownCommand,
				timeout: 0,
			});
			expect(mine?.locks).toEqual([
				{ path: lockPath, exists: true, pid: deadPid, alive: false },
			]);
			// The foreign card's lock never enters the own-session facts.
			expect(mine?.locks.every((l) => l.path !== foreignLock)).toBe(true);
			// Without an id the fallback still reports (a signal only): it names the
			// newest file, the foreign one — never an auto-fix on that guess.
			const fallback = await probeRun(target, url, "own1");
			expect(fallback?.sessionAt).not.toBeNull();
			expect(fallback?.lastTool?.command).toBe(`tail -f ${foreignLock}`);
			// A known-missing sid reads nothing: no foreign file, all facts degraded.
			const ghost = await probeRun(target, url, "own1", "ghost");
			expect(ghost?.sessionAt).toBeNull();
			expect(ghost?.lastTool).toBeNull();
			expect(ghost?.locks).toEqual([]);
			expect(ghost?.pidFiles).toEqual([]);
			expect(ghost?.pids).toEqual([]);
			expect(ghost?.ports).toEqual([]);
			await stopStaleRun(url, "t", "own1", pidFile);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("/runprobe reads pid file, inline pid, and port facts from the session command", async () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-stale-facts-"));
		const wt = join(root, "proj", ".worktrees", "OTTR-1261");
		mkdirSync(wt, { recursive: true });
		const procRoot = freshProcRoot();
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const deadPid = spawnDeadPid();
		// The bare-integer pid file the command names, holding a dead pid.
		const pidPath = join(root, "gate-1261", "tracker.pid");
		mkdirSync(dirname(pidPath), { recursive: true });
		writeFileSync(pidPath, String(deadPid));
		// The seam's /proc/net/tcp{,6}: one LISTEN entry (state 0A) for port 9090
		// (hex 2382), so 9090 counts one listener and the absent 9091 counts zero.
		// Both halves must be readable, else portListeners answers null.
		mkdirSync(join(procRoot, "net"), { recursive: true });
		const listenHeader =
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
		const listenRow =
			"   0: 00000000:2382 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000 0 100 0 0 0 0\n";
		writeFileSync(join(procRoot, "net", "tcp"), `${listenHeader}${listenRow}`);
		writeFileSync(join(procRoot, "net", "tcp6"), listenHeader);
		// The session command names a live inline pid (this test runner), two ports,
		// and the pid file above.
		const command = `watch --pid ${process.pid} --port 9090 --port 9091 tail ${pidPath}`;
		writeFileSync(
			join(sessions, "1700000000000_probe.jsonl"),
			`${JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command, timeout: 0 },
			})}\n`,
		);
		const url = start({
			token: "t",
			ompPath: process.execPath,
			staleProcRoot: procRoot,
			staleSessionsDir: sessions,
		});
		const target: WorkerTarget = { urls: [url], token: "t" };
		try {
			const { pidFile } = await startStaleRun(url, "t", "facts1", wt, {});
			const fresh = new Date(Date.now() + 2000);
			utimesSync(join(sessions, "1700000000000_probe.jsonl"), fresh, fresh);
			const probe = await probeRun(target, url, "facts1", "probe");
			expect(probe?.pidFiles).toEqual([
				{ path: pidPath, exists: true, pid: deadPid, alive: false },
			]);
			// The live inline pid: signal-0 only, true for the test runner's own pid.
			expect(probe?.pids).toEqual([{ pid: process.pid, alive: true }]);
			expect(probe?.ports).toEqual([
				{ port: 9090, listeners: 1 },
				{ port: 9091, listeners: 0 },
			]);
			expect(probe?.locks).toEqual([]);
			expect(probe?.lastTool).toEqual({
				tool: "bash",
				command,
				timeout: 0,
			});
			expect(Math.abs((probe?.sessionAt ?? 0) - fresh.getTime())).toBeLessThan(
				5,
			);
			await stopStaleRun(url, "t", "facts1", pidFile);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("/stalefix unlock removes only a dead-pid card-dir lock", async () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-stale-fix-"));
		const wt = join(root, "proj", ".worktrees", "OTTR-1261");
		mkdirSync(wt, { recursive: true });
		const deadPid = spawnDeadPid();
		const lockPath = join(wt, "ott-stryker.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: deadPid }));
		const liveLock = join(wt, "live.lock");
		writeFileSync(liveLock, JSON.stringify({ pid: process.pid }));
		const outsideLock = join(root, "other.lock");
		writeFileSync(outsideLock, JSON.stringify({ pid: deadPid }));
		const scratchDir = join(root, "gate-1261", "tmp");
		mkdirSync(scratchDir, { recursive: true });
		const scratchLock = join(scratchDir, "ott-stryker.lock");
		writeFileSync(scratchLock, JSON.stringify({ pid: deadPid }));
		const victimDir = join(root, "outside");
		mkdirSync(victimDir, { recursive: true });
		const victim = join(victimDir, "victim.lock");
		writeFileSync(victim, JSON.stringify({ pid: deadPid }));
		const link = join(wt, "link.lock");
		symlinkSync(victim, link);
		const dirLock = join(wt, "dir.lock");
		mkdirSync(dirLock);
		const garbageLock = join(wt, "garbage.lock");
		writeFileSync(garbageLock, "scree");
		const initLock = join(wt, "init.lock");
		writeFileSync(initLock, JSON.stringify({ pid: 1 }));
		// The act-time session recheck (OTTR-1261): the unlock refuses unless the
		// session's last tool call still names the path. Each sub-case points the
		// run's own session at the one path it exercises — one loop-command builder
		// keeps every command under the normalize cap.
		const dataDir = join(root, "data");
		const sessions = join(dataDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const sessionPath = join(sessions, "1700000000000_probe.jsonl");
		const loop = (p: string): string => `while [ -f ${p} ]; do sleep 600; done`;
		const setSession = (command: string, timeout = 0): void => {
			writeFileSync(
				sessionPath,
				`${JSON.stringify({
					type: "tool_execution_start",
					toolCallId: "call_1",
					toolName: "bash",
					args: { command, timeout },
				})}\n`,
			);
		};
		const url = start({ token: "t", ompPath: process.execPath });
		const target: WorkerTarget = { urls: [url], token: "t" };
		const unlock = (path: string, sessionCommand: string) =>
			staleFix(target, url, {
				run: "fix1",
				action: "unlock",
				path,
				expect: { sessionCommand },
				sessionId: "probe",
			});
		try {
			const { pidFile } = await startStaleRun(url, "t", "fix1", wt, {
				OTTR_DATA_DIR: dataDir,
			});
			// Success: the session still names the worktree lock, the pid is dead.
			setSession(loop(lockPath));
			expect(await unlock(lockPath, loop(lockPath))).toEqual({ ok: true });
			expect(existsSync(lockPath)).toBe(false);
			// The OTTR-1191 scratch shape: under a temp root, one segment carries
			// the card number, pid dead.
			setSession(loop(scratchLock));
			expect(await unlock(scratchLock, loop(scratchLock))).toEqual({
				ok: true,
			});
			expect(existsSync(scratchLock)).toBe(false);
			// The turn moved on: the session's last tool call no longer names the
			// lock. Refused, the lock file intact (OTTR-1261).
			writeFileSync(scratchLock, JSON.stringify({ pid: deadPid }));
			writeFileSync(
				sessionPath,
				`${JSON.stringify({
					type: "tool_execution_start",
					toolCallId: "call_2",
					toolName: "bash",
					args: { command: "echo moved on to other work", timeout: 30 },
				})}\n`,
			);
			const moved = await unlock(scratchLock, loop(scratchLock));
			expect(moved?.ok).toBe(false);
			expect(moved?.reason).toContain("no longer the wait");
			expect(existsSync(scratchLock)).toBe(true);
			// The session names the lock again: the same fix now goes through.
			setSession(loop(scratchLock));
			expect(await unlock(scratchLock, loop(scratchLock))).toEqual({
				ok: true,
			});
			expect(existsSync(scratchLock)).toBe(false);
			// A live pid in the lock refuses and changes nothing.
			setSession(loop(liveLock));
			const live = await unlock(liveLock, loop(liveLock));
			expect(live?.ok).toBe(false);
			expect(live?.reason).toContain("still alive");
			expect(readFileSync(liveLock, "utf8")).toBe(
				JSON.stringify({ pid: process.pid }),
			);
			// Outside the worktree and outside the card-number scratch rule.
			setSession(loop(outsideLock));
			const outside = await unlock(outsideLock, loop(outsideLock));
			expect(outside?.ok).toBe(false);
			expect(outside?.reason).toContain("outside the card's own dirs");
			expect(existsSync(outsideLock)).toBe(true);
			// A symlinked lock resolves outside: refused, link and target intact.
			setSession(loop(link));
			const escaped = await unlock(link, loop(link));
			expect(escaped?.ok).toBe(false);
			expect(escaped?.reason).toContain("outside the card's own dirs");
			expect(existsSync(link)).toBe(true);
			expect(readFileSync(victim, "utf8")).toBe(
				JSON.stringify({ pid: deadPid }),
			);
			// Not a regular file, not a pid, pid 1, and a path that does not
			// resolve: every precondition refuses by name.
			setSession(loop(dirLock));
			const notFile = (await (
				await postJson(url, "/stalefix", "t", {
					run: "fix1",
					action: "unlock",
					path: dirLock,
					expect: { sessionCommand: loop(dirLock) },
					sessionId: "probe",
				})
			).json()) as { ok: boolean; reason: string };
			expect(notFile.ok).toBe(false);
			expect(notFile.reason).toContain("not a regular file");
			setSession(loop(garbageLock));
			const garbage = (await (
				await postJson(url, "/stalefix", "t", {
					run: "fix1",
					action: "unlock",
					path: garbageLock,
					expect: { sessionCommand: loop(garbageLock) },
					sessionId: "probe",
				})
			).json()) as { ok: boolean; reason: string };
			expect(garbage.ok).toBe(false);
			expect(garbage.reason).toContain("does not name a pid");
			setSession(loop(initLock));
			const init = (await (
				await postJson(url, "/stalefix", "t", {
					run: "fix1",
					action: "unlock",
					path: initLock,
					expect: { sessionCommand: loop(initLock) },
					sessionId: "probe",
				})
			).json()) as { ok: boolean; reason: string };
			expect(init.ok).toBe(false);
			expect(init.reason).toContain("does not name a pid");
			setSession(loop(join(wt, "absent.lock")));
			const missing = (await (
				await postJson(url, "/stalefix", "t", {
					run: "fix1",
					action: "unlock",
					path: join(wt, "absent.lock"),
					expect: { sessionCommand: loop(join(wt, "absent.lock")) },
					sessionId: "probe",
				})
			).json()) as { ok: boolean; reason: string };
			expect(missing.ok).toBe(false);
			expect(missing.reason).toContain("does not resolve");
			await stopStaleRun(url, "t", "fix1", pidFile);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("/stalefix kill TERMs one strict descendant after full revalidation", async () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-stale-kill-"));
		const wt = join(root, "proj", ".worktrees", "OTTR-1261");
		mkdirSync(wt, { recursive: true });
		const procRoot = freshProcRoot();
		const deadPid = spawnDeadPid();
		const lockPath = join(wt, "ott-stryker.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: deadPid }));
		// The diagnosed hung child: a strict descendant whose argv is the whole
		// timeout-0 loop command (OTTR-1261).
		const loop = `while [ -f ${lockPath} ]; do sleep 600; done`;
		staleProcFixture(procRoot, {
			pid: 5102,
			ppid: 5101,
			ticks: [12, 0, 0, 0],
			cmd: ["bash", "-c", loop],
		});
		// A sibling of the run: its parent chain never reaches the run pid.
		staleProcFixture(procRoot, { pid: 5099, ppid: 1 });
		const { calls, kill } = recordingKill();
		// The run's own session: still the diagnosed timeout-0 call. The act-time
		// recheck re-reads this tail through the entry's data dir.
		const dataDir = join(root, "data");
		const sessions = join(dataDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const sessionPath = join(sessions, "1700000000000_probe.jsonl");
		const setSession = (command: string, timeout = 0): void => {
			writeFileSync(
				sessionPath,
				`${JSON.stringify({
					type: "tool_execution_start",
					toolCallId: "call_1",
					toolName: "bash",
					args: { command, timeout },
				})}\n`,
			);
		};
		setSession(loop);
		const expectLock: KillExpect = {
			sessionCommand: loop,
			ticks: 12,
			dep: { kind: "lockfile", path: lockPath, pid: deadPid },
		};
		const url = start({
			token: "t",
			ompPath: process.execPath,
			staleProcRoot: procRoot,
			staleKill: kill,
		});
		const target: WorkerTarget = { urls: [url], token: "t" };
		try {
			const { pid, pidFile } = await startStaleRun(url, "t", "kill1", wt, {
				OTTR_DATA_DIR: dataDir,
			});
			staleProcFixture(procRoot, { pid, ppid: 1, cmd: ["omp"] });
			staleProcFixture(procRoot, {
				pid: 5101,
				ppid: pid,
				cmd: ["bash", "-c", "exec wrapper"],
			});
			// Success: every recheck passes, exactly one TERM through the seam.
			expect(
				await staleFix(target, url, {
					run: "kill1",
					action: "kill",
					pid: 5102,
					expect: expectLock,
					sessionId: "probe",
				}),
			).toEqual({ ok: true });
			expect(calls).toEqual([{ pid: 5102, signal: "SIGTERM" }]);
			// Ancestry refusals, each leaving the kill log untouched: a sibling, an
			// unknown pid, the run's own pid, the daemon's own pid, and pid 1.
			const refusals: [number, string][] = [
				[5099, "not in the turn's process tree"],
				[999999, "not in the turn's process tree"],
				[pid, "the run's own pid"],
				[process.pid, "the daemon's own pid"],
				[1, "pid 1 is never a fix target"],
			];
			for (const [badPid, reason] of refusals) {
				const res = await staleFix(target, url, {
					run: "kill1",
					action: "kill",
					pid: badPid,
					expect: expectLock,
					sessionId: "probe",
				});
				expect(res?.ok).toBe(false);
				expect(res?.reason).toContain(reason);
				expect(calls).toEqual([{ pid: 5102, signal: "SIGTERM" }]);
			}
			// The session's last tool call changed: the agent moved on, no signal.
			setSession("echo moved on to other work", 30);
			const moved = await staleFix(target, url, {
				run: "kill1",
				action: "kill",
				pid: 5102,
				expect: expectLock,
				sessionId: "probe",
			});
			expect(moved?.ok).toBe(false);
			expect(moved?.reason).toBe("the session's last tool call changed");
			setSession(loop);
			// The child's argv no longer matches the diagnosis (fixture cmdline
			// edited in the seam between probe and fix): refused.
			writeFileSync(
				join(procRoot, "5102", "cmdline"),
				["sleep", "600"].map((seg) => `${seg}\0`).join(""),
			);
			const argvChanged = await staleFix(target, url, {
				run: "kill1",
				action: "kill",
				pid: 5102,
				expect: expectLock,
				sessionId: "probe",
			});
			expect(argvChanged?.ok).toBe(false);
			expect(argvChanged?.reason).toBe("the child's command changed");
			staleProcFixture(procRoot, {
				pid: 5102,
				ppid: 5101,
				ticks: [12, 0, 0, 0],
				cmd: ["bash", "-c", loop],
			});
			// The child resumed: at the BUSY_MIN_TICKS window boundary the kill is
			// still allowed, one tick past it refused.
			staleProcFixture(procRoot, {
				pid: 5102,
				ppid: 5101,
				ticks: [16, 0, 0, 0],
				cmd: ["bash", "-c", loop],
			});
			expect(
				await staleFix(target, url, {
					run: "kill1",
					action: "kill",
					pid: 5102,
					expect: expectLock,
					sessionId: "probe",
				}),
			).toEqual({ ok: true });
			expect(calls).toEqual([
				{ pid: 5102, signal: "SIGTERM" },
				{ pid: 5102, signal: "SIGTERM" },
			]);
			staleProcFixture(procRoot, {
				pid: 5102,
				ppid: 5101,
				ticks: [17, 0, 0, 0],
				cmd: ["bash", "-c", loop],
			});
			const resumed = await staleFix(target, url, {
				run: "kill1",
				action: "kill",
				pid: 5102,
				expect: expectLock,
				sessionId: "probe",
			});
			expect(resumed?.ok).toBe(false);
			expect(resumed?.reason).toContain("the child resumed");
			staleProcFixture(procRoot, {
				pid: 5102,
				ppid: 5101,
				ticks: [12, 0, 0, 0],
				cmd: ["bash", "-c", loop],
			});
			// The dependency cleared: the lock now names a live pid.
			writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
			const cleared = await staleFix(target, url, {
				run: "kill1",
				action: "kill",
				pid: 5102,
				expect: expectLock,
				sessionId: "probe",
			});
			expect(cleared?.ok).toBe(false);
			expect(cleared?.reason).toBe("the dependency cleared");
			writeFileSync(lockPath, JSON.stringify({ pid: deadPid }));
			// Port dependency: no listener on the seam's net tables — the kill is
			// proven; one LISTEN row for the port appears and it refuses.
			mkdirSync(join(procRoot, "net"), { recursive: true });
			const listenHeader =
				"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
			writeFileSync(join(procRoot, "net", "tcp"), listenHeader);
			writeFileSync(join(procRoot, "net", "tcp6"), listenHeader);
			const expectPort: KillExpect = {
				sessionCommand: loop,
				ticks: 12,
				dep: { kind: "port", port: 9090 },
			};
			expect(
				await staleFix(target, url, {
					run: "kill1",
					action: "kill",
					pid: 5102,
					expect: expectPort,
					sessionId: "probe",
				}),
			).toEqual({ ok: true });
			expect(calls).toEqual([
				{ pid: 5102, signal: "SIGTERM" },
				{ pid: 5102, signal: "SIGTERM" },
				{ pid: 5102, signal: "SIGTERM" },
			]);
			const listenRow =
				"   1: 00000000:2382 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000 0 100 0 0 0 0\n";
			writeFileSync(
				join(procRoot, "net", "tcp"),
				`${listenHeader}${listenRow}`,
			);
			const ported = await staleFix(target, url, {
				run: "kill1",
				action: "kill",
				pid: 5102,
				expect: expectPort,
				sessionId: "probe",
			});
			expect(ported?.ok).toBe(false);
			expect(ported?.reason).toBe("the dependency cleared");
			await stopStaleRun(url, "t", "kill1", pidFile);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("feedCappedLines", () => {
	const emit =
		(out: string[]) =>
		(t: string): void => {
			out.push(t);
		};

	test("splits a line across chunks and keeps the tail bounded", () => {
		const cap = { partial: "", dropping: false };
		const out: string[] = [];
		feedCappedLines(cap, "he", emit(out), () => out.push("<dropped>"));
		expect(out).toEqual([]);
		expect(cap.partial).toBe("he");
		feedCappedLines(cap, "llo\nwor", emit(out), () => out.push("<dropped>"));
		feedCappedLines(cap, "ld\n", emit(out), () => out.push("<dropped>"));
		expect(out).toEqual(["hello", "world"]);
		expect(cap.partial).toBe("");
		expect(cap.dropping).toBe(false);
	});

	test("keeps a line that ends exactly at the cap", () => {
		const cap = { partial: "", dropping: false };
		const out: string[] = [];
		feedCappedLines(
			cap,
			`${"x".repeat(MAX_STREAM_LINE_CHARS)}\n`,
			emit(out),
			() => out.push("<dropped>"),
		);
		expect(out).toEqual(["x".repeat(MAX_STREAM_LINE_CHARS)]);
		expect(out.some((l) => l === "<dropped>")).toBe(false);
	});

	test("drops an oversized line once and keeps the next line, even from the same chunk", () => {
		const cap = { partial: "", dropping: false };
		const out: string[] = [];
		// One under the cap: the next chunk pushes the line over it and also
		// carries the line's end plus a following normal line.
		feedCappedLines(cap, "x".repeat(MAX_STREAM_LINE_CHARS - 1), emit(out), () =>
			out.push("<dropped>"),
		);
		feedCappedLines(cap, "yy\nok\n", emit(out), () => out.push("<dropped>"));
		expect(out).toEqual(["<dropped>", "ok"]);
		expect(cap.partial).toBe("");
		expect(cap.dropping).toBe(false);
	});

	test("flushCappedLines emits the bounded tail once and clears it", () => {
		const cap = { partial: "", dropping: false };
		const out: string[] = [];
		feedCappedLines(cap, "tail", emit(out), () => out.push("<dropped>"));
		flushCappedLines(cap, emit(out));
		flushCappedLines(cap, emit(out));
		expect(out).toEqual(["tail"]);
		expect(cap.partial).toBe("");
	});
});

describe("stream line cap", () => {
	// Streams `bytes` of newline-free filler, then a normal event line and the done
	// sentinel, as 64 KiB chunks over a real local HTTP server. Validation #OTTR-1231
	// ran this shape through the unfixed reader and OOM-killed a 512 MiB job at a
	// 128 MiB line.
	function floodServer(bytes: number, onFlood?: (sentBytes: number) => void) {
		const chunkSize = 64 * 1024;
		let sent = 0;
		const enc = new TextEncoder();
		return Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch: () =>
				new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(enc.encode("a".repeat(chunkSize)));
							sent += chunkSize;
						},
						pull(c) {
							if (sent >= bytes) {
								// End the dropped line first: the event and sentinel after
								// it are ordinary lines the reader must keep.
								c.enqueue(enc.encode("\n"));
								c.enqueue(enc.encode('{"type":"after-flood"}\n'));
								c.enqueue(
									enc.encode(
										`${JSON.stringify({ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } })}\n`,
									),
								);
								c.close();
								return;
							}
							c.enqueue(enc.encode("a".repeat(chunkSize)));
							sent += chunkSize;
							onFlood?.(sent);
						},
					}),
					{ headers: { "content-type": "text/plain" } },
				),
		});
	}

	test("a 64 MiB chunked flood never grows the retained tail past the cap", () => {
		// The memory bound of the reader is exactly this invariant: the accumulated
		// tail stays at or under MAX_STREAM_LINE_CHARS and the dropped line leaves no
		// retained string behind. Asserting it directly keeps the bound deterministic;
		// a raw RSS delta on this box is dominated by GC scheduling noise (measured
		// 205 MB growth with the fix in place under load, against the unfixed
		// reader's real 191 MB baseline in validation #OTTR-1231 — no threshold
		// separates the two, so the RSS form false-alarms).
		const cap = { partial: "", dropping: false };
		let dropped = 0;
		const chunk = "a".repeat(64 * 1024);
		for (let i = 0; i < 1024; i++)
			feedCappedLines(
				cap,
				chunk,
				() => {},
				() => {
					dropped++;
				},
			);
		expect(dropped).toBe(1); // one notice for the one dropped line
		expect(cap.dropping).toBe(true);
		expect(cap.partial.length).toBeLessThanOrEqual(MAX_STREAM_LINE_CHARS);
	});

	test("a newline-free 64 MiB line settles with a drop notice and bounded reader memory", async () => {
		// Peak RSS measured mid-flood under forced GC: Bun.gc(true) collapses the
		// flood's transient allocation churn (a plain end-to-end delta measures GC
		// scheduling noise: 205 MB growth with the fix in place under load), but it
		// cannot reclaim the reader's live partial, so a retained line shows up as
		// peak growth while a capped reader stays near the baseline. The unfixed
		// reader retained the whole 64 MiB line at this point (validation
		// #OTTR-1231, ~191 MB end-to-end).
		let rssPeak = 0;
		const gcAndSample = (): void => {
			Bun.gc(true);
			const rss = process.memoryUsage.rss();
			if (rss > rssPeak) rssPeak = rss;
		};
		gcAndSample();
		const rssBefore = rssPeak;
		const server = floodServer(64 * 1024 * 1024, (sent) => {
			// Sample every 4 MiB of flood sent, while consumeRun holds the line.
			if (sent % (4 * 1024 * 1024) < 64 * 1024) gcAndSample();
		});
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "flood", argv: [], cwd: dir, stdin: "", env: {} },
			{ urls: [`http://127.0.0.1:${server.port}`] },
			sink,
		);
		const result = await done;
		expect(result.exitCode).toBe(0);
		// The oversized line never reached the sink: the plain-text notice replaces it.
		expect(sink.lines).toContain(`${lineDropNotice()}\n`);
		expect(sink.lines.some((l) => l.startsWith("a"))).toBe(false);
		server.stop(true);
		// Peak reader RSS growth stays under the cap plus a margin: the retained
		// tail never exceeds MAX_STREAM_LINE_CHARS. Measured peak growth with the
		// fix in place is a few MB; the uncapped reader retains the whole line and
		// fails this by more than the margin (drill: set MAX_STREAM_LINE_CHARS to
		// Number.MAX_SAFE_INTEGER and rerun this test).
		const growth = rssPeak - rssBefore;
		expect(growth).toBeLessThan(MAX_STREAM_LINE_CHARS + 24 * 1024 * 1024);
	}, 60_000);

	test("a normal event line after a dropped oversized line still reaches sink.line", async () => {
		const server = floodServer(MAX_STREAM_LINE_CHARS + 1024 * 1024);
		const sink = fakeSink();
		const { done } = runWorker(
			{ id: "flood-next", argv: [], cwd: dir, stdin: "", env: {} },
			{ urls: [`http://127.0.0.1:${server.port}`] },
			sink,
		);
		const result = await done;
		expect(result.exitCode).toBe(0);
		expect(sink.lines).toContain(`${lineDropNotice()}\n`);
		expect(sink.lines).toContain('{"type":"after-flood"}\n');
		server.stop(true);
	}, 30_000);
});

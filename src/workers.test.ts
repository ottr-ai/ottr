import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { signIns } from "./login.ts";
import { createRunSink, type RunSink } from "./runner.ts";
import {
	detachedRuns,
	killDetached,
	matchSweepTarget,
	runWorker,
	serveWorker,
	sweepWorker,
	WORKER_DONE,
	WorkerConnectError,
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

// Every test below that runs one of these fakes through serveWorker or runWorker spawns a real
// bun child, and child boot is unbounded under concurrent machine load (past 4 s observed).
// Such tests carry a 30 s budget: the 5 s default bounds the machine, not the assertions.

const servers: Bun.Server<never>[] = [];
afterAll(() => {
	for (const s of servers) s.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

// Port 0: the OS picks a free port. Fixed ports collided when two suites ran at once
// (Stryker runs 16), and the EADDRINUSE failure counted as a killed mutant.
function start(opts: Parameters<typeof serveWorker>[0] = {}) {
	const server = serveWorker({ port: 0, ...opts });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
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

	test("the project's package list installs before omp; its notes ride stdout, not the stderr tail", async () => {
		const asked: string[] = [];
		const url = start({
			ompPath: process.execPath,
			ensurePackages: async (project) => {
				asked.push(project);
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
		expect(asked).toEqual(["velvarr"]);
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
		const url = start({
			ompPath: process.execPath,
			ensureTools: async () => ["tools: installed ruff"],
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
		expect(await res.json()).toEqual({
			signIns: [
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
			],
		});
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
			const body = (await res.json()) as { signIns: null; error: string };
			expect(body.signIns).toBeNull();
			expect(body.error).toContain(join(home, ".omp", "agent", "agent.db"));
		} finally {
			if (saved === undefined) delete process.env.HOME;
			else process.env.HOME = saved;
		}
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
		});
	});
});

describe("GET /omp-stats", () => {
	test("unauthenticated /omp-stats answers 401 like /stats", async () => {
		const url = start({ token: "tok" });
		expect((await fetch(`${url}/omp-stats`)).status).toBe(401);
	});

	test("GET /omp-stats returns the fixture script's JSON answer", async () => {
		const bin = join(dir, "fake-omp");
		writeFileSync(
			bin,
			'#!/bin/sh\necho \'{"overall":{"totalRequests":5,"totalCost":0.25},"byModel":[]}\'\n',
		);
		chmodSync(bin, 0o755);
		const url = start({ token: "tok", ompStatsPath: bin });
		const res = await fetch(`${url}/omp-stats`, {
			headers: { "x-otwr-token": "tok" },
		});
		expect(res.status).toBe(200);
		// The worker answers parseOmpStats' full shape: absent counts fill 0, absent
		// rates fill null, so the board can merge without re-guarding.
		expect(await res.json()).toEqual({
			stats: {
				overall: {
					totalRequests: 5,
					successfulRequests: 0,
					failedRequests: 0,
					errorRate: null,
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCacheReadTokens: 0,
					totalCacheWriteTokens: 0,
					cacheRate: null,
					cacheSavings: null,
					totalCost: 0.25,
					unpricedRequests: 0,
					totalPremiumRequests: 0,
					avgDuration: null,
					avgTtft: null,
					avgTokensPerSecond: null,
					firstTimestamp: null,
					lastTimestamp: null,
				},
				byModel: [],
			},
			error: null,
		});
	});

	test("a failing binary still answers 200 with stats: null and the cause", async () => {
		const bin = join(dir, "boom-omp");
		writeFileSync(bin, "#!/bin/sh\necho boom >&2\nexit 3\n");
		chmodSync(bin, 0o755);
		const url = start({ token: "tok", ompStatsPath: bin });
		const res = await fetch(`${url}/omp-stats`, {
			headers: { "x-otwr-token": "tok" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { stats: null; error: string };
		expect(body.stats).toBeNull();
		expect(body.error).toContain("exited with code 3");
		expect(body.error).toContain("boom");
	});

	test("a missing binary answers stats: null with a failed-to-start cause", async () => {
		const url = start({
			token: "tok",
			ompStatsPath: join(dir, "no-such-bin"),
		});
		const res = await fetch(`${url}/omp-stats`, {
			headers: { "x-otwr-token": "tok" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { stats: null; error: string };
		expect(body.stats).toBeNull();
		expect(body.error).toContain("failed to start");
	});
});

describe("runWorker", () => {
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
			fetch: () => Response.redirect(bounce.url.origin + "/run", 302),
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
const sink = {
	line() {}, stdout() {}, stderr() {}, stderrLine() {}, childError() {}, logMark() {}, flush() {},
	state: { sessionId: null, model: null, outcome: null, asked: null, approvalRefused: false, sawTerminalEnd: false, finalText: "", remembered: new Map() },
	tail: () => "",
	result: (r) => ({ sessionId: null, model: null, outcome: null, asked: null, approvalRefused: false, sawTerminalEnd: false, finalText: "", recorded: [], ...r }),
};
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
			fetch: (req) => Response.redirect(new URL(req.url).origin + "/run", 302),
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

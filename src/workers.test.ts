import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunSink, type RunSink } from "./runner.ts";
import {
	runWorker,
	serveWorker,
	WORKER_DONE,
	WorkerConnectError,
} from "./workers.ts";

const dir = mkdtempSync(join(tmpdir(), "ottr-workers-"));

// Fake omp: echoes one JSON line describing the request, then exits with code 3.
const echoPath = join(dir, "echo-omp.js");
writeFileSync(
	echoPath,
	`process.stdout.write(JSON.stringify({ argv: process.argv, cwd: process.cwd(), env: { FOO: process.env.FOO, OTTR_WORKER_TOKEN: process.env.OTTR_WORKER_TOKEN } }) + "\\n");
process.exit(3);`,
);

// Env-dump omp: echoes its whole env as one JSON line.
const envDumpPath = join(dir, "env-omp.js");
writeFileSync(
	envDumpPath,
	`process.stdout.write(JSON.stringify(process.env) + "\\n");`,
);

// Sleeper omp: emits a JSON event, then stays alive until killed.
const sleepPath = join(dir, "sleep-omp.js");
writeFileSync(
	sleepPath,
	`process.stdout.write('{"type":"tick"}\\n');
setTimeout(() => {}, 60000);`,
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
		// binary that would otherwise serve forever on 0.0.0.0:8787.
		const r = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "worker.ts")],
			{
				env: { ...process.env, OTTR_WORKER_TOKEN: "" },
				stdout: "pipe",
				stderr: "pipe",
				timeout: 5000,
			},
		);
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain("OTTR_WORKER_TOKEN is required");
	});

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
	});

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
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
		};
		expect(sentinel[WORKER_DONE].exitCode).toBe(3);
		expect(sentinel[WORKER_DONE].stderrTail).toBe("");
	});

	test("omp never sees the worker's own token, from its env or the request", async () => {
		const saved = process.env.OTTR_WORKER_TOKEN;
		process.env.OTTR_WORKER_TOKEN = "worker-secret";
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
					env: { FOO: "bar", OTTR_WORKER_TOKEN: "forwarded" },
				}),
			});
			const echoed = JSON.parse((await readLines(res))[0] ?? "") as {
				env: Record<string, string>;
			};
			expect(echoed.env).toEqual({ FOO: "bar" });
		} finally {
			if (saved === undefined) delete process.env.OTTR_WORKER_TOKEN;
			else process.env.OTTR_WORKER_TOKEN = saved;
		}
	});

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
	});

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
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
		};
		expect(sentinel[WORKER_DONE].exitCode).toBe(1);
		expect(sentinel[WORKER_DONE].stderrTail).toBe("boom one\nboom two\n");
	});

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
			[WORKER_DONE]: { exitCode: number | null; stderrTail: string };
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
	});

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
			const pid = Number(readFileSync(pidFile, "utf8"));
			const alive = () => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			// Real wall-clock: neither the kill nor the drained pipe has an event the test can
			// await; the loop exits on the condition, then the last buffered lines get a moment.
			for (const end = Date.now() + 10_000; alive() && Date.now() < end; )
				await Bun.sleep(10);
			await Bun.sleep(200);
			expect(alive()).toBe(false);
			expect(errors).toEqual([]);
		} finally {
			process.off("uncaughtException", onError);
		}
	}, 15000);
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
	});

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
		expect(bounceToken).toBeUndefined();
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

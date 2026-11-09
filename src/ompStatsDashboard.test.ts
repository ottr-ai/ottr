// ompStatsDashboard contract tests: env/port parsing, the child state machine with a fake omp
// child whose output and exit the test controls, the idle clock, the wait page, and the
// forwarder against a real local upstream.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createOmpStatsDashboard,
	type DashboardChild,
	type DashboardDeps,
	type DashboardPhase,
	forwardToDashboard,
	OMP_STATS_IDLE_MS,
	type OmpStatsDashboard,
	parseDashboardPort,
	parseOmpStatsPort,
	startingPage,
} from "./ompStatsDashboard.ts";
import type { MirrorResult } from "./ompStatsMirror.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-omp-dashboard-"));
let n = 0;

describe("parseOmpStatsPort", () => {
	test("unset or empty is the default 3848", () => {
		expect(parseOmpStatsPort(undefined)).toEqual({ port: 3848, error: null });
		expect(parseOmpStatsPort("")).toEqual({ port: 3848, error: null });
	});
	test("a port in 1..65535 is taken", () => {
		expect(parseOmpStatsPort("1")).toEqual({ port: 1, error: null });
		expect(parseOmpStatsPort("65535")).toEqual({ port: 65535, error: null });
	});
	test("0 and off disable the listener", () => {
		for (const raw of ["0", "off", "OFF"]) {
			expect(parseOmpStatsPort(raw)).toEqual({
				port: null,
				error: "disabled by OTTR_OMP_STATS_PORT",
			});
		}
	});
	test("anything else disables it with the reason", () => {
		for (const raw of ["65536", "-1", "12ab", "3848.5", "1e3", "abc"]) {
			expect(parseOmpStatsPort(raw)).toEqual({
				port: null,
				error: `OTTR_OMP_STATS_PORT is not a port: ${raw}`,
			});
		}
	});
});

describe("parseDashboardPort", () => {
	test("reads omp's line, plain and with ANSI codes", () => {
		expect(
			parseDashboardPort("Dashboard available at: http://127.0.0.1:41234"),
		).toBe(41234);
		expect(
			parseDashboardPort(
				"\x1b[32mDashboard available at:\x1b[0m \x1b[4mhttp://127.0.0.1:5001\x1b[0m\n",
			),
		).toBe(5001);
	});
	test("other text has no port", () => {
		expect(parseDashboardPort("Syncing sessions…")).toBeNull();
		expect(
			parseDashboardPort("Dashboard available at: http://example.com:80"),
		).toBeNull();
		expect(
			parseDashboardPort("Dashboard available at: http://127.0.0.1:99999"),
		).toBeNull();
		expect(parseDashboardPort("")).toBeNull();
	});
});

/** A fake omp child: the test writes its output and decides when and how it exits. */
function fakeChild() {
	const enc = new TextEncoder();
	let out!: ReadableStreamDefaultController<Uint8Array>;
	let err!: ReadableStreamDefaultController<Uint8Array>;
	const exit = Promise.withResolvers<number>();
	const kills: (NodeJS.Signals | number | undefined)[] = [];
	const child: DashboardChild = {
		stdout: new ReadableStream<Uint8Array>({
			start: (c) => {
				out = c;
			},
		}),
		stderr: new ReadableStream<Uint8Array>({
			start: (c) => {
				err = c;
			},
		}),
		exited: exit.promise,
		kill: (signal) => void kills.push(signal),
	};
	return {
		child,
		kills,
		stdout: (s: string) => out.enqueue(enc.encode(s)),
		stderr: (s: string) => err.enqueue(enc.encode(s)),
		exit(code: number) {
			out.close();
			err.close();
			exit.resolve(code);
		},
	};
}

type Fake = ReturnType<typeof fakeChild>;

/** A dashboard with a fake spawn, a stub mirror, and a clock the test moves. */
function harness(over: Partial<DashboardDeps> = {}) {
	const children: Fake[] = [];
	const spawns: { argv: string[]; env: Record<string, string | undefined> }[] =
		[];
	let mirrors = 0;
	const clock = { t: 1_000_000 };
	const logs: string[] = [];
	const baseDir = join(root, String(n++));
	const dash = createOmpStatsDashboard({
		baseDir,
		sources: () => [],
		env: () => ({
			HOME: "/board-home",
			TERN_PANE: "p1",
			TERN_PANE_SOCKET: "/s",
			PATH: "/bin",
		}),
		spawn: (argv, env) => {
			spawns.push({ argv, env });
			const f = fakeChild();
			children.push(f);
			return f.child;
		},
		mirror: async (): Promise<MirrorResult> => {
			mirrors++;
			return { written: 0, errors: [] };
		},
		now: () => clock.t,
		log: (m) => void logs.push(m),
		...over,
	});
	return {
		dash,
		children,
		spawns,
		clock,
		logs,
		baseDir,
		mirrors: () => mirrors,
	};
}

/** Polls for a phase: the manager's start runs on async fs and stream reads, with no promise
 *  to await from outside. */
async function until(
	dash: OmpStatsDashboard,
	phase: DashboardPhase,
	budgetMs = 1000,
): Promise<void> {
	for (
		let waited = 0;
		waited < budgetMs && dash.state().phase !== phase;
		waited += 5
	)
		await Bun.sleep(5);
	expect(dash.state().phase).toBe(phase);
}

/** Lets queued stream reads and exit handlers run before a check that something did NOT
 *  happen: absence has no event to await. */
const settle = () => Bun.sleep(20);

/** Starts the dashboard and brings the fake child to `running` on `port`. */
async function running(
	h: ReturnType<typeof harness>,
	port = 40001,
): Promise<Fake> {
	h.dash.ensure();
	await until(h.dash, "starting");
	const child = h.children.at(-1)!;
	child.stdout(`Syncing…\nDashboard available at: http://127.0.0.1:${port}\n`);
	await until(h.dash, "running");
	return child;
}

describe("createOmpStatsDashboard", () => {
	test("ensure copies first, then starts omp stats with the dashboard agent dir", async () => {
		const h = harness();
		expect(h.dash.state().phase).toBe("stopped");
		expect(h.dash.ensure().phase).toBe("copying");
		await until(h.dash, "starting");
		expect(h.mirrors()).toBe(1);
		expect(h.spawns).toHaveLength(1);
		const { argv, env } = h.spawns[0]!;
		expect(argv).toEqual(["stats", "--port", "0", "--host", "127.0.0.1"]);
		expect(env.PI_CODING_AGENT_DIR).toBe(join(h.baseDir, "agent"));
		expect(env.HOME).toBe("/board-home");
		expect(env.PATH).toBe("/bin");
		expect("TERN_PANE" in env).toBe(false);
		expect("TERN_PANE_SOCKET" in env).toBe(false);
	});

	test("the dashboard line, even split over chunks and coloured, reaches running with its port", async () => {
		const h = harness();
		h.dash.ensure();
		await until(h.dash, "starting");
		const c = h.children[0]!;
		c.stdout("\x1b[1mDashboard available at: http://127.0.0.1:41");
		await settle();
		expect(h.dash.state().phase).toBe("starting");
		c.stdout("234\x1b[0m\n");
		await until(h.dash, "running");
		expect(h.dash.state()).toEqual({
			phase: "running",
			port: 41234,
			error: null,
		});
	});

	test("a child that exits before the line fails with its last output line", async () => {
		const h = harness();
		h.dash.ensure();
		await until(h.dash, "starting");
		const c = h.children[0]!;
		c.stdout("Syncing sessions\n");
		c.stderr("\x1b[31mError: database is locked\x1b[0m\n\n");
		c.exit(1);
		await until(h.dash, "failed");
		expect(h.dash.state()).toEqual({
			phase: "failed",
			port: null,
			error: "Error: database is locked",
		});
	});

	test("a silent child that exits fails with its exit code", async () => {
		const h = harness();
		h.dash.ensure();
		await until(h.dash, "starting");
		h.children[0]!.exit(0);
		await until(h.dash, "failed");
		expect(h.dash.state().error).toBe("omp stats exited with 0");
	});

	test("ensure while copying, starting, or running starts no second child", async () => {
		const h = harness();
		h.dash.ensure();
		h.dash.ensure();
		await until(h.dash, "starting");
		h.dash.ensure();
		h.children[0]!.stdout("Dashboard available at: http://127.0.0.1:40001\n");
		await until(h.dash, "running");
		h.dash.ensure();
		await settle();
		expect(h.spawns).toHaveLength(1);
		expect(h.mirrors()).toBe(1);
	});

	test("a failed start is retried by the next ensure", async () => {
		const h = harness();
		h.dash.ensure();
		await until(h.dash, "starting");
		h.children[0]!.exit(2);
		await until(h.dash, "failed");
		h.dash.ensure();
		await until(h.dash, "starting");
		expect(h.spawns).toHaveLength(2);
	});

	test("no dashboard line within the start timeout kills the child and fails", async () => {
		// A real 1 s timer: the error names whole seconds, and the timer runs beside live
		// stream reads that fake timers would not drive.
		const h = harness({ startTimeoutMs: 1000 });
		h.dash.ensure();
		await until(h.dash, "starting");
		const c = h.children[0]!;
		await until(h.dash, "failed", 3000);
		expect(h.dash.state()).toEqual({
			phase: "failed",
			port: null,
			error: "omp stats printed no dashboard address within 1 s",
		});
		expect(c.kills).toEqual(["SIGTERM"]);
		// Its exit after the kill keeps the timeout's error.
		c.stderr("Terminated\n");
		c.exit(143);
		await settle();
		expect(h.dash.state().error).toBe(
			"omp stats printed no dashboard address within 1 s",
		);
	});

	test("a spawn that throws fails the start with its message", async () => {
		const h = harness({
			spawn: () => {
				throw new Error("Executable not found in $PATH: omp");
			},
		});
		h.dash.ensure();
		await until(h.dash, "failed");
		expect(h.dash.state().error).toContain(
			"Executable not found in $PATH: omp",
		);
	});

	test("a mirror that throws fails the start without a spawn", async () => {
		const h = harness({
			mirror: async () => {
				throw new Error("EACCES: permission denied");
			},
		});
		h.dash.ensure();
		await until(h.dash, "failed");
		expect(h.dash.state().error).toContain("EACCES: permission denied");
		expect(h.spawns).toHaveLength(0);
	});

	test("a running child that exits 0 is stopped, any other code is failed", async () => {
		const h = harness();
		(await running(h)).exit(0);
		await until(h.dash, "stopped");
		expect(h.dash.state()).toEqual({
			phase: "stopped",
			port: null,
			error: null,
		});

		const c = await running(h, 40002);
		c.stderr("panic: out of memory\n");
		c.exit(1);
		await until(h.dash, "failed");
		expect(h.dash.state().error).toBe("panic: out of memory");
	});

	test("the idle tick stops the child after exactly 30 minutes without ensure", async () => {
		const h = harness();
		const start = h.clock.t;
		const c = await running(h);

		h.clock.t = start + OMP_STATS_IDLE_MS - 1000;
		await h.dash.tick();
		expect(h.dash.state().phase).toBe("running");
		expect(c.kills).toEqual([]);

		h.clock.t = start + OMP_STATS_IDLE_MS;
		await h.dash.tick();
		expect(h.dash.state()).toEqual({
			phase: "stopped",
			port: null,
			error: null,
		});
		expect(c.kills).toEqual(["SIGTERM"]);
	});

	test("ensure resets the idle clock", async () => {
		const h = harness();
		const start = h.clock.t;
		const c = await running(h);
		h.clock.t = start + 20 * 60_000;
		h.dash.ensure();
		h.clock.t = start + OMP_STATS_IDLE_MS + 60_000;
		await h.dash.tick();
		expect(h.dash.state().phase).toBe("running");
		expect(c.kills).toEqual([]);
	});

	test("a tick while running refreshes the mirror; a failing refresh is only logged", async () => {
		let calls = 0;
		const h = harness({
			mirror: async () => {
				calls++;
				if (calls === 2) throw new Error("disk full");
				return { written: 0, errors: calls === 3 ? ["/x.jsonl: EIO"] : [] };
			},
		});
		await running(h);
		await h.dash.tick();
		await h.dash.tick();
		expect(calls).toBe(3);
		expect(h.dash.state().phase).toBe("running");
		expect(h.logs.some((l) => l.includes("disk full"))).toBe(true);
		expect(h.logs.some((l) => l.includes("/x.jsonl: EIO"))).toBe(true);
	});

	test("two overlapping ticks run one refresh", async () => {
		let calls = 0;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const h = harness({
			mirror: async () => {
				calls++;
				if (calls === 2) {
					entered.resolve();
					await release.promise;
				}
				return { written: 0, errors: [] };
			},
		});
		await running(h);
		const first = h.dash.tick();
		await entered.promise;
		await h.dash.tick();
		expect(calls).toBe(2);
		release.resolve();
		await first;
	});

	test("a stopped child's late exit does not touch the newer start", async () => {
		const h = harness();
		const old = await running(h, 40001);
		h.dash.stop();
		expect(old.kills).toEqual(["SIGTERM"]);
		expect(h.dash.state().phase).toBe("stopped");
		await running(h, 40002);
		old.stderr("killed\n");
		old.exit(143);
		await settle();
		expect(h.dash.state()).toEqual({
			phase: "running",
			port: 40002,
			error: null,
		});
	});

	test("stop while copying aborts the start", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const h = harness({
			mirror: async () => {
				entered.resolve();
				await release.promise;
				return { written: 0, errors: [] };
			},
		});
		h.dash.ensure();
		await entered.promise;
		h.dash.stop();
		release.resolve();
		await settle();
		expect(h.dash.state().phase).toBe("stopped");
		expect(h.spawns).toHaveLength(0);
	});
});

describe("startingPage", () => {
	test("copying and starting answer 503 pages that reload every 2 s", async () => {
		const copying = startingPage({ phase: "copying", port: null, error: null });
		expect(copying.status).toBe(503);
		expect(copying.headers.get("content-type")).toContain("text/html");
		const html = await copying.text();
		expect(html).toContain('<meta http-equiv="refresh" content="2">');
		expect(html).toContain("Copying session transcripts");
		const starting = await startingPage({
			phase: "starting",
			port: null,
			error: null,
		}).text();
		expect(starting).toContain('<meta http-equiv="refresh" content="2">');
		expect(starting).toContain("Starting omp stats");
	});

	test("a failed start shows the escaped error, asks for a reload, and does not reload itself", async () => {
		const res = startingPage({
			phase: "failed",
			port: null,
			error: `<script>alert("x")</script> & co`,
		});
		expect(res.status).toBe(503);
		const html = await res.text();
		expect(html).not.toContain("http-equiv");
		expect(html).not.toContain("<script>");
		expect(html).toContain(
			"&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62; &#38; co",
		);
		expect(html).toContain("Reload the page");
	});
});

describe("forwardToDashboard", () => {
	const upstream = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/teapot")
				return new Response("short and stout", { status: 418 });
			if (url.pathname === "/moved")
				return new Response(null, {
					status: 302,
					headers: { location: "/elsewhere" },
				});
			return Response.json(
				{
					method: req.method,
					path: url.pathname,
					search: url.search,
					headers: Object.fromEntries(req.headers),
					body: await req.text(),
				},
				{
					status: req.method === "POST" ? 201 : 200,
					headers: { "x-upstream": "yes", "set-cookie": "a=b" },
				},
			);
		},
	});
	afterAll(() => upstream.stop(true));
	const port = upstream.port!;

	const request = (path: string, init: RequestInit = {}) =>
		new Request(`http://localhost:3848${path}`, init);

	test("a GET arrives with path and query, without credentials or proxy headers", async () => {
		const res = await forwardToDashboard(
			request("/api/stats/models?range=24h&x=%20y", {
				headers: {
					cookie: "ottr.session=secret",
					authorization: "Bearer t",
					"x-api-key": "k",
					"x-forwarded-for": "10.0.0.1",
					forwarded: "for=10.0.0.1",
					accept: "application/json",
				},
			}),
			port,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-upstream")).toBe("yes");
		expect(res.headers.get("set-cookie")).toBeNull();
		const seen = (await res.json()) as {
			method: string;
			path: string;
			search: string;
			headers: Record<string, string>;
		};
		expect(seen.method).toBe("GET");
		expect(seen.path).toBe("/api/stats/models");
		expect(seen.search).toBe("?range=24h&x=%20y");
		expect(seen.headers.accept).toBe("application/json");
		expect(seen.headers.host).toBe(`127.0.0.1:${port}`);
		for (const name of [
			"cookie",
			"authorization",
			"x-api-key",
			"x-forwarded-for",
			"forwarded",
		]) {
			expect(seen.headers[name]).toBeUndefined();
		}
	});

	test("a POST body and its status pass through", async () => {
		const res = await forwardToDashboard(
			request("/api/action", {
				method: "POST",
				body: JSON.stringify({ go: 1 }),
				headers: {
					"content-type": "application/json",
					"x-omp-stats-action": "1",
				},
			}),
			port,
		);
		expect(res.status).toBe(201);
		const seen = (await res.json()) as {
			method: string;
			body: string;
			headers: Record<string, string>;
		};
		expect(seen.method).toBe("POST");
		expect(seen.body).toBe('{"go":1}');
		expect(seen.headers["x-omp-stats-action"]).toBe("1");
	});

	test("upstream statuses and redirects pass through unfollowed", async () => {
		const teapot = await forwardToDashboard(request("/teapot"), port);
		expect(teapot.status).toBe(418);
		expect(await teapot.text()).toBe("short and stout");
		const moved = await forwardToDashboard(request("/moved"), port);
		expect(moved.status).toBe(302);
		expect(moved.headers.get("location")).toBe("/elsewhere");
	});

	test("an unreachable upstream answers 502 with the error", async () => {
		const gone = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(""),
		});
		const deadPort = gone.port!;
		await gone.stop(true);
		const res = await forwardToDashboard(request("/"), deadPort);
		expect(res.status).toBe(502);
		expect(await res.text()).toStartWith("omp stats dashboard unreachable: ");
	});
});

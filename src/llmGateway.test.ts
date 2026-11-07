import { describe, expect, test } from "bun:test";
import {
	type GatewayChild,
	type GatewayRun,
	type GatewaySpawn,
	startLlmGateway,
} from "./llmGateway.ts";

interface FakeChild {
	argv: string[];
	env: Record<string, string | undefined>;
	up: boolean;
	killed: boolean;
	exit: (code: number) => void;
	exited: Promise<number>;
}

/** Fake omp: children are promises the test settles; a child answers health once `up`. */
function fakeOmp() {
	const spawned: FakeChild[] = [];
	const waiters: { n: number; resolve: () => void }[] = [];
	const spawn: GatewaySpawn = (argv, env) => {
		const { promise, resolve } = Promise.withResolvers<number>();
		const rec: FakeChild = {
			argv,
			env,
			up: false,
			killed: false,
			exit: resolve,
			exited: promise,
		};
		spawned.push(rec);
		for (const w of waiters) if (spawned.length >= w.n) w.resolve();
		const child: GatewayChild = {
			exited: promise,
			kill: () => {
				rec.killed = true;
				rec.up = false;
				resolve(143);
			},
		};
		return child;
	};
	/** Resolves with child `n` (1-based) once it has been spawned. */
	const spawnedChild = async (n: number): Promise<FakeChild> => {
		if (spawned.length < n) {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ n, resolve });
			await promise;
		}
		const c = spawned[n - 1];
		if (c === undefined) throw new Error(`child ${n} missing`);
		return c;
	};
	const run: GatewayRun = async (argv) => ({
		code: 0,
		stdout: JSON.stringify({
			token: argv[1] === "auth-broker" ? "broker-tok" : "gw-tok",
			path: "/x",
		}),
		stderr: "",
	});
	const fetch = async (url: string) => {
		const port = new URL(url).port;
		const live = spawned.find(
			(s) => s.up && (s.argv[4] ?? "").endsWith(`:${port}`),
		);
		if (live === undefined) throw new Error("ECONNREFUSED");
		return new Response("ok");
	};
	let next = 4101;
	return { spawned, spawnedChild, spawn, run, fetch, freePort: () => next++ };
}

describe("startLlmGateway", () => {
	test("restarts a child that exits, starts the gateway only once the broker answers, and stop() ends the restarts", async () => {
		const f = fakeOmp();
		const logs: string[] = [];
		const started = startLlmGateway({
			agentDir: "/board/agent",
			home: "/board/home",
			log: (l) => logs.push(l),
			omp: "omp",
			spawn: f.spawn,
			run: f.run,
			fetch: f.fetch,
			freePort: f.freePort,
			restartDelayMs: 0,
			readyTimeoutMs: 10_000,
		});
		// The first broker dies before it ever answered: a restart follows, and no gateway yet.
		const first = await f.spawnedChild(1);
		first.exit(1);
		const broker = await f.spawnedChild(2);
		expect(f.spawned.map((s) => s.argv[1])).toEqual([
			"auth-broker",
			"auth-broker",
		]);
		expect(broker.argv).toEqual([
			"omp",
			"auth-broker",
			"serve",
			"--bind",
			"127.0.0.1:4101",
		]);
		expect(broker.env.PI_CODING_AGENT_DIR).toBe("/board/agent");
		expect(broker.env.HOME).toBe("/board/home");
		expect(broker.env.OMP_AUTH_BROKER_URL).toBeUndefined();
		expect(broker.env.GH_TOKEN).toBeUndefined();
		broker.up = true;
		const gateway = await f.spawnedChild(3);
		expect(gateway.argv).toEqual([
			"omp",
			"auth-gateway",
			"serve",
			"--bind",
			"127.0.0.1:4102",
		]);
		expect(gateway.env.OMP_AUTH_BROKER_URL).toBe("http://127.0.0.1:4101");
		expect(gateway.env.OMP_AUTH_BROKER_TOKEN).toBe("broker-tok");
		gateway.up = true;
		const g = await started;
		expect(g.url).toBe("http://127.0.0.1:4102");
		expect(g.token).toBe("gw-tok");
		expect(logs.some((l) => l.includes("auth-broker exited with code 1"))).toBe(
			true,
		);

		// A running gateway that exits comes back on the same port.
		gateway.exit(2);
		const again = await f.spawnedChild(4);
		expect(again.argv).toEqual(gateway.argv);

		g.stop();
		expect(broker.killed).toBe(true);
		expect(again.killed).toBe(true);
		await again.exited;
		// Negative check: a respawn would be a 0 ms timer after the exit, so one real macrotask
		// is the only way to see that none was scheduled.
		await Bun.sleep(5);
		expect(f.spawned).toHaveLength(4);
	});

	test("a broker that never answers fails the start and leaves nothing running", async () => {
		const f = fakeOmp();
		// The ready deadline is wall-clock by design (a hung omp); 200 ms keeps it short.
		await expect(
			startLlmGateway({
				agentDir: "/a",
				home: "/h",
				log: () => {},
				spawn: f.spawn,
				run: f.run,
				fetch: f.fetch,
				freePort: f.freePort,
				restartDelayMs: 0,
				readyTimeoutMs: 200,
			}),
		).rejects.toThrow("auth-broker did not answer");
		expect(f.spawned.map((s) => s.argv[1])).toEqual(["auth-broker"]);
		expect(f.spawned[0]?.killed).toBe(true);
	});

	test("a token command that fails stops the start before any child runs", async () => {
		const f = fakeOmp();
		await expect(
			startLlmGateway({
				agentDir: "/a",
				home: "/h",
				log: () => {},
				spawn: f.spawn,
				run: async () => ({ code: 1, stdout: "", stderr: "no store" }),
				fetch: f.fetch,
				freePort: f.freePort,
			}),
		).rejects.toThrow("no store");
		expect(f.spawned).toEqual([]);
	});
});

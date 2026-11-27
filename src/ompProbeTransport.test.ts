import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createOmpProbeTransport,
	probeArgv,
	probeRequestEnv,
} from "./ompProbeTransport.ts";
import type { RunSink } from "./runner.ts";
import {
	runWorker,
	serveWorker,
	WorkerConnectError,
	type WorkerRequest,
	type WorkerTarget,
} from "./workers.ts";

const dir = mkdtempSync(join(tmpdir(), "ottr-omp-probe-transport-"));

// Every live test runs one real bun child on an in-process daemon, and child
// boot is unbounded under concurrent machine load (workers.test.ts), so each
// carries a 30 s budget: the 5 s default bounds the machine, not the assertions.

const servers: Bun.Server<never>[] = [];
afterAll(() => {
	for (const s of servers) s.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

// One daemon for the live tests; port 0 lets the OS pick a free port (fixed
// ports collide when two suites run at once).
let workerUrl: string | null = null;
function startWorker(): string {
	if (workerUrl === null) {
		const server = serveWorker({ port: 0, token: "probe-test-token" });
		servers.push(server);
		workerUrl = `http://127.0.0.1:${server.port}`;
	}
	return workerUrl;
}

// A stub the probe command runs on the worker: the daemon spawns a probe's
// argv[0] directly (full-command spawn), so the stub is an executable bun
// script with a shebang.
function stub(path: string, source: string): string {
	writeFileSync(path, `#!/usr/bin/env bun\n${source}`);
	chmodSync(path, 0o755);
	return path;
}

// Prints the models JSON the watch parses, plus the cwd and HOME it ran with.
const stubModelsPath = stub(
	join(dir, "stub-models.js"),
	`process.stdout.write(JSON.stringify({
	models: [{ id: "glm-5.3-flash", provider: "zai" }],
	pwd: process.cwd(),
	home: process.env.HOME,
}) + "\\n");
`,
);

// Exits non-zero with stderr text the transport must carry back.
const stubExit3Path = stub(
	join(dir, "stub-exit3.js"),
	`process.stderr.write("probe boom: the model list refused\\n");
process.exit(3);
`,
);

// Sleeps past the transport's timeout, then writes a completion marker: the
// marker never appearing proves the kill reached the daemon child.
const timeoutMarker = join(dir, "marker-timeout");
const stubSleepPath = stub(
	join(dir, "stub-sleep.js"),
	`await Bun.sleep(3000);
await Bun.write(${JSON.stringify(timeoutMarker)}, "done");
`,
);

// The env the tests hand the transport: the six proxy names plus exactly the
// names a probe request must never carry.
const sourceEnv: NodeJS.ProcessEnv = {
	HTTP_PROXY: "http://proxy-1:3128",
	HTTPS_PROXY: "http://proxy-2:3128",
	NO_PROXY: "localhost,127.0.0.1",
	http_proxy: "http://proxy-3:3128",
	https_proxy: "http://proxy-4:3128",
	no_proxy: "internal",
	PATH: "/usr/local/sbin:/usr/bin",
	HOME: "/root",
	OTTR_WORKER_TOKEN: "worker-secret",
	ALATE_API_KEY: "alate-secret",
	ANTHROPIC_API_KEY: "provider-secret",
};
const expectedRequestEnv: Record<string, string> = {
	HTTP_PROXY: sourceEnv.HTTP_PROXY!,
	HTTPS_PROXY: sourceEnv.HTTPS_PROXY!,
	NO_PROXY: sourceEnv.NO_PROXY!,
	http_proxy: sourceEnv.http_proxy!,
	https_proxy: sourceEnv.https_proxy!,
	no_proxy: sourceEnv.no_proxy!,
};

type SpawnSeam = NonNullable<
	Parameters<typeof createOmpProbeTransport>[0]["spawn"]
>;

/** The live-path spawn seam: first asserts the wire request the transport
 * built (the trust boundary), then dispatches the real runWorker with the argv
 * swapped to the test's stub command. */
const liveSpawnSeam = (stub: string): SpawnSeam => {
	return (req: WorkerRequest, target: WorkerTarget, sink: RunSink) => {
		expect(req.argv).toEqual(probeArgv("18.16.0"));
		expect(req.probe).toBe(true);
		for (const name of Object.keys(req.env))
			expect(Object.keys(expectedRequestEnv)).toContain(name);
		expect(req.env).toEqual(expectedRequestEnv);
		expect(req.cwd).toBe("/tmp");
		expect(req.id.startsWith("ompprobe-")).toBe(true);
		return runWorker({ ...req, argv: [stub] }, target, sink);
	};
};

describe("ompProbeTransport", () => {
	test("probeArgv: exact argv for a strict x.y.z; every other shape throws", () => {
		expect(probeArgv("18.16.0")).toEqual([
			"bunx",
			"@oh-my-pi/pi-coding-agent@18.16.0",
			"models",
			"--json",
		]);
		expect(() => probeArgv("18.16.0-x")).toThrow(
			"omp models probe: version is not x.y.z: 18.16.0-x",
		);
		expect(() => probeArgv("18.16.0; rm -rf /")).toThrow(
			"version is not x.y.z",
		);
		expect(() => probeArgv("")).toThrow("version is not x.y.z");
	});

	test("probeRequestEnv: copies only the six proxy names; drops PATH, HOME and credential names", () => {
		expect(probeRequestEnv(sourceEnv)).toEqual(expectedRequestEnv);
		// A name absent from the source stays absent: no invented defaults.
		expect(probeRequestEnv({ PATH: "/bin", HOME: "/root" })).toEqual({});
	});

	test("no worker target: every call rejects with the configuration error", async () => {
		await expect(
			createOmpProbeTransport({ target: null })("18.16.0", 30_000),
		).rejects.toThrow(
			"omp models probe: no worker target configured (OTTR_WORKER_URLS)",
		);
		await expect(
			createOmpProbeTransport({ target: { urls: [] } })("18.16.0", 30_000),
		).rejects.toThrow("no worker target configured");
	});

	test("a dead worker target rejects with the worker connect error", async () => {
		const transport = createOmpProbeTransport({
			target: { urls: ["http://127.0.0.1:9"] },
		});
		await expect(transport("18.16.0", 30_000)).rejects.toThrow(
			WorkerConnectError,
		);
	}, 30_000);

	test("live path: a real daemon runs the probe in its scratch and returns the stub's stdout", async () => {
		const transport = createOmpProbeTransport({
			target: { urls: [startWorker()], token: "probe-test-token" },
			spawn: liveSpawnSeam(stubModelsPath),
			env: () => sourceEnv,
		});
		const res = await transport("18.16.0", 30_000);
		expect(res.code).toBe(0);
		expect(res.stderr).toBe("");
		const out = JSON.parse(res.stdout) as {
			models: { id: string }[];
			pwd: string;
			home: string;
		};
		expect(out.models.map((m) => m.id)).toEqual(["glm-5.3-flash"]);
		// The daemon ran the probe inside its per-run scratch: both paths are
		// run- prefixed dirs under the daemon's tmp root. The scratch dies with
		// the run, so only the path shape is observable afterwards.
		expect(out.pwd.startsWith(join(tmpdir(), "run-"))).toBe(true);
		expect(out.home.startsWith(join(tmpdir(), "run-"))).toBe(true);
	}, 30_000);

	test("live path: a non-zero exit comes back as {code, stderr}", async () => {
		const transport = createOmpProbeTransport({
			target: { urls: [startWorker()], token: "probe-test-token" },
			spawn: liveSpawnSeam(stubExit3Path),
			env: () => sourceEnv,
		});
		const res = await transport("18.16.0", 30_000);
		expect(res.code).toBe(3);
		expect(res.stderr).toContain("probe boom: the model list refused");
	}, 30_000);

	test("live path: the timeout kills the run and the stub never completes", async () => {
		const transport = createOmpProbeTransport({
			target: { urls: [startWorker()], token: "probe-test-token" },
			spawn: liveSpawnSeam(stubSleepPath),
			env: () => sourceEnv,
		});
		await expect(transport("18.16.0", 250)).rejects.toThrow(
			"omp models probe timed out after 250 ms",
		);
		// The stub's own sleep is 3000 ms: waiting past it proves the kill
		// reached the daemon child, not just the client's promise. The sleep
		// runs in a separate OS process, so fake timers cannot advance its
		// clock — this wait is deliberately real.
		await Bun.sleep(3400);
		expect(existsSync(timeoutMarker)).toBe(false);
	}, 30_000);
});

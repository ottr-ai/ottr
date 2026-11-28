import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smokeEnv } from "../scripts/boot-smoke-env.ts";
import { type LlmGateway, startRunWithBroker } from "./llmGateway.ts";
import type { startRun } from "./runner.ts";
import { memoryGrant, VmTokens } from "./vmTokens.ts";

type RunOptions = Parameters<typeof startRun>[0];

const mergeOptions: RunOptions = {
	cwd: "/project",
	prompt: "merge",
	sessionDir: "/sessions",
	resumeId: null,
	logPath: "/logs/merge.log",
	dataRoot: "/data",
	localMerge: { workspaceRoot: "/project" },
	model: "provider/model",
};

test("an isolated local merge waits for the shared broker before dispatch", async () => {
	const ready = Promise.withResolvers<LlmGateway>();
	const calls: RunOptions[] = [];
	const start: typeof startRun = async (o) => {
		calls.push(o);
		throw new Error("dispatch observed");
	};
	const run = startRunWithBroker(mergeOptions, start, ready.promise, true);
	expect(calls).toHaveLength(0);
	const broker = { url: "http://127.0.0.1:4101", token: crypto.randomUUID() };
	ready.resolve({
		url: "http://127.0.0.1:4102",
		token: crypto.randomUUID(),
		broker,
		stop() {},
	});
	await expect(run).rejects.toThrow("dispatch observed");
	expect(calls).toHaveLength(1);
	expect(calls[0]?.authBroker === broker).toBe(true);
	expect(calls[0]?.model).toBe(mergeOptions.model);
});

test("a broker readiness error prevents the merge child", async () => {
	let calls = 0;
	const start: typeof startRun = async () => {
		calls++;
		throw new Error("unexpected dispatch");
	};
	await expect(
		startRunWithBroker(
			mergeOptions,
			start,
			Promise.reject(new Error("broker unavailable")),
			true,
		),
	).rejects.toThrow("broker unavailable");
	await expect(
		startRunWithBroker(mergeOptions, start, null, true),
	).rejects.toThrow("the merge provider broker is unavailable");
	expect(calls).toBe(0);
});

test.each([
	["non-root merge", false, mergeOptions],
	["ordinary local run", true, { ...mergeOptions, localMerge: undefined }],
	[
		"worker run",
		true,
		{ ...mergeOptions, worker: { urls: ["http://127.0.0.1:9"], token: "" } },
	],
	[
		"VM run",
		true,
		{
			...mergeOptions,
			vm: {
				target: { urls: ["http://127.0.0.1:9"] },
				tokens: new VmTokens({ file: null }),
				grant: memoryGrant("project", "task"),
				base: "main",
				boardUrl: "http://127.0.0.1:9",
			},
		},
	],
] satisfies [string, boolean, RunOptions][])(
	"%s receives no broker grant",
	async (_name, isolated, options) => {
		let called = false;
		const start: typeof startRun = async (o) => {
			called = true;
			expect(o.authBroker).toBeUndefined();
			expect(o.model).toBe(mergeOptions.model);
			throw new Error("dispatch observed");
		};
		await expect(
			startRunWithBroker(
				{ ...options, authBroker: { url: "http://127.0.0.1:9", token: "" } },
				start,
				null,
				isolated,
			),
		).rejects.toThrow("dispatch observed");
		expect(called).toBe(true);
	},
);

test.each([
	["", false],
	["build", false],
	["not-alate", false],
	["alate", true],
	["build, alate,vm", true],
	["*", true],
] as const)(
	"startup access with COMPOSE_PROFILES=%j",
	async (profiles, enabled) => {
		// ponytail: reserve then release a port; retry allocation if CI ever hits the gap.
		const probe = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(),
		});
		const port = probe.port;
		await probe.stop(true);
		const root = mkdtempSync(join(tmpdir(), "ottr-startup-"));
		const key = "startup-check-secret-never-print";
		const child = Bun.spawn(["bun", "src/server.ts"], {
			cwd: join(import.meta.dir, ".."),
			env: smokeEnv({
				PORT: String(port),
				OTTR_OMP_STATS_PORT: "off",
				OMP_TRACKER_ROOTS: root,
				OTTR_STATE_DIR: join(root, "state"),
				COMPOSE_PROFILES: profiles,
				// Pairing alone must not make a disabled bundled profile appear enabled.
				ALATE_URL: "http://127.0.0.1:9",
				ALATE_API_KEY: key,
			}),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 15_000,
			killSignal: "SIGKILL",
		});
		let stdout = "";
		const ready = Promise.withResolvers<void>();
		const stdoutDone = (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of child.stdout) {
				stdout += decoder.decode(chunk, { stream: true });
				if (stdout.includes("After detached startup")) ready.resolve();
			}
		})();
		const stderrDone = new Response(child.stderr).text();
		try {
			await Promise.race([
				ready.promise,
				child.exited.then((code) => {
					throw new Error(`server exited before startup banner: ${code}`);
				}),
			]);
			const url = `http://127.0.0.1:${port}`;
			expect(stdout).toContain(`Ottr on ${url}`);
			expect((await fetch(`${url}/api/boot`)).status).toBe(200);
			expect(stdout).toMatch(
				enabled ? /Alate\s+http:\/\/127\.0\.0\.1:4570/ : /Alate\s+off\b/,
			);
			if (!enabled) expect(stdout).not.toContain("http://127.0.0.1:4570");
		} finally {
			child.kill();
			await child.exited;
			await stdoutDone;
			const stderr = await stderrDone;
			rmSync(root, { recursive: true, force: true });
			expect(stdout).not.toContain(key);
			expect(stderr).not.toContain(key);
		}
	},
	20_000,
);

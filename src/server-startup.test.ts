import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smokeEnv } from "../scripts/boot-smoke-env.ts";

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

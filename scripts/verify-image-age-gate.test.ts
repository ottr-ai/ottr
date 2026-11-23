import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const scriptPath = join(root, "scripts/verify-image-age-gate.ts");

describe("verify-image-age-gate --grep", () => {
	test("every global install line carries the release-age flag", () => {
		const out = Bun.spawnSync([process.execPath, scriptPath, "--grep"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(out.exitCode).toBe(0);
		expect(out.stdout.toString()).toContain("age-gate: ok");
	});

	test("an ungated install line fails the gate", () => {
		const dir = mkdtempSync(join(tmpdir(), "age-gate-"));
		try {
			writeFileSync(
				join(dir, "Dockerfile.worker"),
				"RUN bun install -g typescript@7.0.2\n",
			);
			const out = Bun.spawnSync([process.execPath, scriptPath, "--grep"], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(out.exitCode).toBe(1);
			expect(out.stderr.toString()).toContain("FAIL");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the default mode exits 2 with the hint when docker is absent", () => {
		const out = Bun.spawnSync([process.execPath, scriptPath], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PATH: "/age-gate-no-docker" },
		});
		expect(out.exitCode).toBe(2);
		expect(out.stderr.toString()).toContain("no docker engine here");
	});
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { grepGate, WAIVER } from "../scripts/verify-image-age-gate.ts";

const root = join(import.meta.dir, "..");
const scriptPath = join(root, "scripts/verify-image-age-gate.ts");

const ompLine =
	'RUN bun install -g --ignore-scripts "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" \\';
const pinLine = "ARG OMP_VERSION=19.1.1";
const gatedLine = `RUN bun install -g --ignore-scripts --minimum-release-age 604800 "typescript@7.0.2" \\`;
const otherLine =
	'RUN bun install -g --ignore-scripts "@toon-format/cli@4.4.0" \\';

describe("grepGate waiver", () => {
	test("the real Dockerfile passes with the live waiver", () => {
		const result = grepGate(
			readFileSync(join(root, "Dockerfile.worker"), "utf8"),
		);
		expect(result.ok).toBe(true);
		expect(result.output).toContain("age-gate: ok");
		expect(result.output).toContain("waiver");
	});

	test("the waived line passes with pin 19.1.1 while the waiver is live", () => {
		const result = grepGate(
			`${pinLine}\n${gatedLine}\n${ompLine}\n`,
			new Date("2026-11-27T12:00:00Z"),
		);
		expect(result.ok).toBe(true);
		expect(result.output).toContain("1 line(s) under the omp 19.1.1 waiver");
	});

	test("a moved pin loses the waiver", () => {
		const result = grepGate(
			`${pinLine.replace("19.1.1", "19.1.2")}\n${gatedLine}\n${ompLine}\n`,
			new Date("2026-11-27T12:00:00Z"),
		);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("FAIL");
	});

	test("an appended install target on the waived line loses the waiver", () => {
		const appended =
			'RUN bun install -g --ignore-scripts "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" "new-tool@0.1.0" \\';
		const result = grepGate(
			`${pinLine}\n${gatedLine}\n${appended}\n`,
			new Date("2026-11-27T12:00:00Z"),
		);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("FAIL");
		expect(result.output).toContain("new-tool");
	});

	test("the same line fails after the waiver expires, naming the expiry", () => {
		const result = grepGate(
			`${pinLine}\n${gatedLine}\n${ompLine}\n`,
			new Date("2027-01-01T00:00:00Z"),
		);
		expect(result.ok).toBe(false);
		expect(result.output).toContain(`waiver expired ${WAIVER.until}`);
	});

	test("a non-waived ungated line still fails while the waiver is live", () => {
		const result = grepGate(
			`${gatedLine}\n${otherLine}\n`,
			new Date("2026-11-27T12:00:00Z"),
		);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("FAIL");
		expect(result.output).toContain("@toon-format/cli");
	});

	test("a file with no install lines still fails", () => {
		const result = grepGate(
			"FROM oven/bun:1.4.5\n",
			new Date("2026-11-27T12:00:00Z"),
		);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("FAIL");
	});
});

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

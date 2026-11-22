// Live spawn tests for the tracked-text marker gate (OTTR-1059): every case
// builds its marker fixture in the OS temp dir, and the defect literals sit
// inside longer source lines, so this file needs no exemption. The
// real-script spawn with no arguments proves the live path through
// `git ls-files` (AGENTS.md work-turn rule 1).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markerLines } from "./check-markers.ts";

const SCRIPT = join(import.meta.dir, "check-markers.ts");
const ROOT = join(import.meta.dir, "..");

const root = mkdtempSync(join(tmpdir(), "ottr-check-markers-"));
afterAll(() => {
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The README's real `10: @ours` residue and the three rows git writes for
 * a conflict block. The literals sit inside longer source lines, so the
 * gate's whole-line patterns never match this file. */
const EDIT_TOOL = "10: @ours";
const OPEN = "<<<<<<< HEAD";
const MID = "=======";
const CLOSE = ">>>>>>> main";

function fixture(name: string, text: string): string {
	const path = join(root, name);
	writeFileSync(path, text);
	return path;
}

function run(args: string[]): {
	code: number | null;
	stdout: string;
	stderr: string;
} {
	const r = Bun.spawnSync(["bun", SCRIPT, ...args], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: r.exitCode,
		stdout: r.stdout.toString(),
		stderr: r.stderr.toString(),
	};
}

/** The tracked tree exists only where a repo does: a Stryker sandbox copy has
 * no .git, so `git ls-files` cannot enumerate there (OTTR-1191 dry run). The
 * live tracked-tree proof stays with the normal runs — plain `bun test` and
 * `bun run check`, which runs the script against the real repo. */
const trackedTree = test.skipIf(!existsSync(join(ROOT, ".git")));

describe("check-markers (live spawns)", () => {
	test("fails on a temp file holding the edit-tool marker line", () => {
		const f = fixture("edit-tool.md", `# t\n\n${EDIT_TOOL}\n| a | b |\n`);
		const r = run([f]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(`${f}:3: ${EDIT_TOOL}`);
	});

	test("fails on a temp file holding a full conflict block", () => {
		const f = fixture(
			"conflict.ts",
			`const a = 1;\n${OPEN}\n${MID}\n${CLOSE}\n`,
		);
		const r = run([f]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(OPEN);
		expect(r.stderr).toContain(MID);
		expect(r.stderr).toContain(CLOSE);
	});

	test("skips a binary file whose bytes embed a marker line", () => {
		const f = join(root, "blob.png");
		writeFileSync(
			f,
			Buffer.concat([
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00]),
				Buffer.from(`\n${OPEN}\n`),
			]),
		);
		const r = run([f]);
		expect(r.code).toBe(0);
	});

	test("fails when an explicitly named path is unreadable", () => {
		const r = run([join(root, "absent.md")]);
		expect(r.code).toBe(1);
	});

	test("passes a lone ======= line outside a conflict block", () => {
		const f = fixture("underline.md", "Title\n=======\nbody\n");
		const r = run([f]);
		expect(r.code).toBe(0);
	});

	trackedTree("passes on the tracked tree after the README fix", () => {
		const r = run([]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("markers: ok");
	});
});

describe("markerLines (core)", () => {
	test("flags the edit-tool marker and both conflict rows", () => {
		const hits = markerLines(`${EDIT_TOOL}\nclean\n${OPEN}\nx\n${CLOSE}\n`);
		expect(hits.map((h) => h.line)).toEqual([1, 3, 5]);
	});

	test("flags ======= only between the conflict rows", () => {
		expect(
			markerLines(`${OPEN}\n${MID}\n${CLOSE}\n`).map((h) => h.text),
		).toEqual([OPEN, MID, CLOSE]);
		expect(markerLines("Title\n=======\nbody\n")).toEqual([]);
	});

	test("accepts text without a trailing newline", () => {
		expect(markerLines(`${EDIT_TOOL}`).map((h) => h.line)).toEqual([1]);
	});

	test("rejects near-miss lines", () => {
		expect(
			markerLines("11: @ours now\n10 : @ours\n1: @our\n<<<<<<< x\n>>>>>>>x\n"),
		).toEqual([{ line: 4, text: "<<<<<<< x" }]);
	});
});

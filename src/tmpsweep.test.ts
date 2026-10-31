import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTmpDirs } from "./tmpsweep.ts";

describe("sweepTmpDirs", () => {
	const root = mkdtempSync(join(tmpdir(), "sweeptest-"));
	const old = Date.now() / 1000 - 25 * 60 * 60;

	test("removes old prefixed entries, keeps fresh and unprefixed", () => {
		mkdirSync(join(root, "turn-old"));
		writeFileSync(join(root, "turn-oldfile"), "x");
		mkdirSync(join(root, "turn-new"));
		mkdirSync(join(root, "keepme"));
		for (const name of ["turn-old", "turn-oldfile", "keepme"]) {
			utimesSync(join(root, name), old, old);
		}
		expect(sweepTmpDirs(root)).toBe(2);
		expect(existsSync(join(root, "turn-old"))).toBe(false);
		expect(existsSync(join(root, "turn-oldfile"))).toBe(false);
		expect(existsSync(join(root, "turn-new"))).toBe(true);
		expect(existsSync(join(root, "keepme"))).toBe(true);
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));
});

// ompStatsMirror contract tests: folder mapping, the grow/replace/skip copy rule, symlink and
// compaction-dir refusal, and that a run without source changes writes nothing.
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorFolderName, mirrorSessions } from "./ompStatsMirror.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-omp-mirror-"));
let n = 0;

/** A fresh source + target pair per test. */
function fixture() {
	const base = join(root, String(n++));
	const src = join(base, "src");
	const target = join(base, "target");
	mkdirSync(src, { recursive: true });
	return { base, src, target };
}

describe("mirrorFolderName", () => {
	test("prefixes the project and replaces characters outside A-Za-z0-9._-", () => {
		expect(mirrorFolderName("my proj/x")).toBe("--ottr--my-proj-x");
		expect(mirrorFolderName("Ottr_1.2-b")).toBe("--ottr--Ottr_1.2-b");
		expect(mirrorFolderName("../up")).toBe("--ottr--..-up");
	});
});

describe("mirrorSessions", () => {
	test("a store keeps its folders, a flat project dir lands in its --ottr-- folder", async () => {
		const { base, src, target } = fixture();
		mkdirSync(join(src, "--work-a--", "sub"), { recursive: true });
		writeFileSync(join(src, "--work-a--", "s1.jsonl"), "one\n");
		writeFileSync(join(src, "--work-a--", "sub", "s2.jsonl"), "two\n");
		writeFileSync(join(src, "--work-a--", "notes.txt"), "not a transcript");
		writeFileSync(
			join(src, "loose.jsonl"),
			"files at the store root are no folder",
		);
		const project = join(base, "project");
		mkdirSync(project);
		writeFileSync(join(project, "t1.jsonl"), "turn\n");

		const r = await mirrorSessions(target, [
			{ dir: src, folder: null },
			{ dir: project, folder: mirrorFolderName("my proj") },
		]);

		expect(r).toEqual({ written: 3, errors: [] });
		expect(readFileSync(join(target, "--work-a--", "s1.jsonl"), "utf8")).toBe(
			"one\n",
		);
		expect(
			readFileSync(join(target, "--work-a--", "sub", "s2.jsonl"), "utf8"),
		).toBe("two\n");
		expect(
			readFileSync(join(target, "--ottr--my-proj", "t1.jsonl"), "utf8"),
		).toBe("turn\n");
		expect(existsSync(join(target, "--work-a--", "notes.txt"))).toBe(false);
		expect(existsSync(join(target, "loose.jsonl"))).toBe(false);
		if (process.platform !== "win32") {
			expect(statSync(join(target, "--work-a--")).mode & 0o777).toBe(0o700);
		}
	});

	test("a grown source appends only the new bytes", async () => {
		const { src, target } = fixture();
		writeFileSync(join(src, "s.jsonl"), "AAAAtail\n");
		mkdirSync(join(target, "p"), { recursive: true });
		// Different bytes of the old length: a full copy would overwrite them, an append keeps them.
		writeFileSync(join(target, "p", "s.jsonl"), "xxxx");

		const r = await mirrorSessions(target, [{ dir: src, folder: "p" }]);

		expect(r).toEqual({ written: 1, errors: [] });
		expect(readFileSync(join(target, "p", "s.jsonl"), "utf8")).toBe(
			"xxxxtail\n",
		);
	});

	test("a target larger than its source is replaced by a full copy", async () => {
		const { src, target } = fixture();
		writeFileSync(join(src, "s.jsonl"), "new\n");
		mkdirSync(join(target, "p"), { recursive: true });
		writeFileSync(join(target, "p", "s.jsonl"), "an older and longer file\n");

		const r = await mirrorSessions(target, [{ dir: src, folder: "p" }]);

		expect(r).toEqual({ written: 1, errors: [] });
		expect(readFileSync(join(target, "p", "s.jsonl"), "utf8")).toBe("new\n");
	});

	test.skipIf(process.platform === "win32")(
		"symlinked files and folders are not copied",
		async () => {
			const { base, src, target } = fixture();
			const outside = join(base, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "secret.jsonl"), "secret\n");
			mkdirSync(join(src, "f"));
			symlinkSync(join(outside, "secret.jsonl"), join(src, "f", "link.jsonl"));
			symlinkSync(outside, join(src, "linked-folder"));
			symlinkSync(outside, join(src, "f", "linked-sub"));

			const r = await mirrorSessions(target, [{ dir: src, folder: null }]);

			expect(r).toEqual({ written: 0, errors: [] });
			expect(existsSync(join(target, "f", "link.jsonl"))).toBe(false);
			expect(existsSync(join(target, "linked-folder"))).toBe(false);
			expect(existsSync(join(target, "f", "linked-sub"))).toBe(false);
		},
	);

	test("omp's compaction dirs are skipped", async () => {
		const { src, target } = fixture();
		mkdirSync(join(src, ".omp-gc-compress-123"));
		writeFileSync(join(src, ".omp-gc-compress-123", "s.jsonl"), "half\n");
		mkdirSync(join(src, "f", ".omp-gc-compress-9"), { recursive: true });
		writeFileSync(join(src, "f", ".omp-gc-compress-9", "s.jsonl"), "half\n");

		const r = await mirrorSessions(target, [{ dir: src, folder: null }]);

		expect(r).toEqual({ written: 0, errors: [] });
		expect(existsSync(join(target, ".omp-gc-compress-123"))).toBe(false);
	});

	test("a second run without source changes writes nothing", async () => {
		const { src, target } = fixture();
		mkdirSync(join(src, "f"));
		writeFileSync(join(src, "f", "a.jsonl"), "a\n");
		writeFileSync(join(src, "f", "b.jsonl"), "b\n");

		expect(
			(await mirrorSessions(target, [{ dir: src, folder: null }])).written,
		).toBe(2);
		expect(await mirrorSessions(target, [{ dir: src, folder: null }])).toEqual({
			written: 0,
			errors: [],
		});
	});

	test("the mirror keeps a transcript that its source deleted", async () => {
		const { base, target } = fixture();
		const project = join(base, "gone-later");
		mkdirSync(project);
		writeFileSync(join(project, "t.jsonl"), "t\n");
		await mirrorSessions(target, [{ dir: project, folder: "p" }]);

		const r = await mirrorSessions(target, [
			{ dir: join(base, "missing"), folder: "p" },
		]);

		expect(r).toEqual({ written: 0, errors: [] });
		expect(readFileSync(join(target, "p", "t.jsonl"), "utf8")).toBe("t\n");
	});

	test("a missing source dir is no error, store or flat", async () => {
		const { base, target } = fixture();
		const r = await mirrorSessions(target, [
			{ dir: join(base, "nope"), folder: null },
			{ dir: join(base, "nope2"), folder: "p" },
		]);
		expect(r).toEqual({ written: 0, errors: [] });
		expect(existsSync(target)).toBe(false);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"an unreadable file is recorded and the other files still copy",
		async () => {
			const { src, target } = fixture();
			writeFileSync(join(src, "bad.jsonl"), "bad\n", { mode: 0o000 });
			writeFileSync(join(src, "good.jsonl"), "good\n");

			const r = await mirrorSessions(target, [{ dir: src, folder: "p" }]);

			expect(r.written).toBe(1);
			expect(r.errors).toHaveLength(1);
			expect(r.errors[0]).toStartWith(`${join(src, "bad.jsonl")}: `);
			expect(readFileSync(join(target, "p", "good.jsonl"), "utf8")).toBe(
				"good\n",
			);
		},
	);
});

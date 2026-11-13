import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	strykerEntryExists,
	writeInnerScript,
} from "./measure-stryker-concurrency.ts";

test("strykerEntryExists checks the real package file, not the .bin entry", () => {
	const repo = mkdtempSync(join(tmpdir(), "ott-886-measure-test-"));
	try {
		// Nothing installed: the guard refuses.
		expect(strykerEntryExists(repo)).toBe(false);
		// A .bin/stryker entry alone must not satisfy the guard: a Linux-installed
		// node_modules holds a symlink a Windows host cannot follow (2026-11-13 host run).
		mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(repo, "node_modules", ".bin", "stryker"), "#!/bin/sh\n");
		expect(existsSync(join(repo, "node_modules", ".bin", "stryker"))).toBe(
			true,
		);
		expect(strykerEntryExists(repo)).toBe(false);
		// The real package file satisfies the guard with no .bin entry at all.
		mkdirSync(join(repo, "node_modules", "@stryker-mutator", "core", "bin"), {
			recursive: true,
		});
		writeFileSync(
			join(
				repo,
				"node_modules",
				"@stryker-mutator",
				"core",
				"bin",
				"stryker.js",
			),
			"//",
		);
		expect(strykerEntryExists(repo)).toBe(true);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("the generated ballast keeps its buffer alive against the GC", () => {
	// The ballast runs only inside the measurement container, which tests cannot spawn:
	// after the touch loop the GC freed the local-only buffer and the ballast silently
	// died (2026-11-13 host run), so pin the reference-holding lines of the generated script.
	const dir = mkdtempSync(join(tmpdir(), "ott-886-measure-test-"));
	try {
		writeInnerScript(dir);
		const inner = readFileSync(join(dir, "inner.sh"), "utf8");
		expect(inner).toContain("globalThis.keep = b");
		expect(inner).toContain("setInterval(() => globalThis.keep.length");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

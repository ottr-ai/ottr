import { describe, expect, test } from "bun:test";
import { diffFileSlice, diffLineClass, diffLinkParts } from "./diff.ts";

const TWO_FILES = [
	"diff --git a/one.ts b/one.ts",
	"index 111..222 100644",
	"--- a/one.ts",
	"+++ b/one.ts",
	"@@ -1,2 +1,3 @@",
	" context",
	"-gone",
	"+here",
	"+added",
	"diff --git a/sub/two.ts b/sub/two.ts",
	"index 333..444 100644",
	"--- a/sub/two.ts",
	"+++ b/sub/two.ts",
	"@@ -1 +1 @@",
	"-old line",
	"+new line",
	"",
].join("\n");

describe("diffLineClass", () => {
	test("classifies additions, removals, hunks and context", () => {
		expect(diffLineClass("+added")).toBe("add");
		expect(diffLineClass("-gone")).toBe("del");
		expect(diffLineClass(" context")).toBe("ctx");
		expect(diffLineClass("")).toBe("ctx");
		expect(diffLineClass("@@ -1,2 +1,3 @@")).toBe("hunk");
	});

	test("classifies headers as meta, not as +/- lines", () => {
		expect(diffLineClass("--- a/one.ts")).toBe("meta");
		expect(diffLineClass("+++ b/one.ts")).toBe("meta");
		expect(diffLineClass("diff --git a/one.ts b/one.ts")).toBe("meta");
		expect(diffLineClass("index 111..222 100644")).toBe("meta");
		expect(diffLineClass("new file mode 100644")).toBe("meta");
		expect(diffLineClass("rename to one.ts")).toBe("meta");
		expect(diffLineClass("Binary files a/x and b/x differ")).toBe("meta");
	});
});

describe("diffFileSlice", () => {
	test("returns exactly one file's section, without the next file's lines", () => {
		const slice = diffFileSlice(TWO_FILES, "one.ts");
		expect(slice).toContain("+++ b/one.ts");
		expect(slice).toContain("+added");
		expect(slice).not.toContain("two.ts");
		expect(diffFileSlice(TWO_FILES, "sub/two.ts")).toContain("+new line");
	});

	test("binary and deleted sections match through the diff --git line", () => {
		const text = [
			"diff --git a/img.png b/img.png",
			"Binary files a/img.png and b/img.png differ",
			"diff --git a/gone.ts b/gone.ts",
			"deleted file mode 100644",
			"--- a/gone.ts",
			"+++ /dev/null",
			"-bye",
			"",
		].join("\n");
		expect(diffFileSlice(text, "img.png")).toContain("Binary files");
		expect(diffFileSlice(text, "gone.ts")).toContain("-bye");
	});

	test("rename stat paths match either side, brace form included", () => {
		const text = [
			"diff --git a/old.ts b/new.ts",
			"similarity index 90%",
			"rename from old.ts",
			"rename to new.ts",
			"",
		].join("\n");
		expect(diffFileSlice(text, "old.ts => new.ts")).toContain("rename to");
		expect(diffFileSlice(text, "src/{old => new}.ts")).toBeNull();
		const braced = [
			"diff --git a/pkg/old.ts b/pkg/new.ts",
			"similarity index 90%",
			"rename from pkg/old.ts",
			"rename to pkg/new.ts",
			"",
		].join("\n");
		expect(diffFileSlice(braced, "pkg/{old => new}.ts")).toContain(
			"rename to pkg/new.ts",
		);
	});

	test("returns null for a file the diff does not name", () => {
		expect(diffFileSlice(TWO_FILES, "missing.ts")).toBeNull();
		expect(diffFileSlice("", "one.ts")).toBeNull();
	});
});

describe("diffLinkParts", () => {
	test("plain question text stays one literal run", () => {
		expect(diffLinkParts("Proceed with the schema change?")).toEqual([
			{ kind: "text", text: "Proceed with the schema change?" },
		]);
	});

	test("splits text around a labelled link and keeps the file list", () => {
		expect(
			diffLinkParts("See [the diff](diff:src/prompts.ts) before answering."),
		).toEqual([
			{ kind: "text", text: "See " },
			{ kind: "link", label: "the diff", files: ["src/prompts.ts"] },
			{ kind: "text", text: " before answering." },
		]);
	});

	test("a comma-separated href names several files", () => {
		// The href charset excludes spaces, so the list is comma-separated without them.
		expect(diffLinkParts("[both files](diff:src/a.ts,src/b.ts)")).toEqual([
			{ kind: "link", label: "both files", files: ["src/a.ts", "src/b.ts"] },
		]);
	});

	test("an http link and an empty diff href stay literal text", () => {
		const text = "open [the site](https://example.com) or [nothing](diff:)";
		expect(diffLinkParts(text)).toEqual([{ kind: "text", text }]);
	});
});

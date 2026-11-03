import { describe, expect, test } from "bun:test";
import {
	diffLineClass,
	diffLinkParts,
	numberDiffLines,
	pickDiffSections,
	splitDiffSections,
} from "./diff.ts";

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

describe("splitDiffSections", () => {
	test("splits two files into sections in file order, without trailing empty line", () => {
		const sections = splitDiffSections(TWO_FILES);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.names).toContain("one.ts");
		expect(sections[0]?.lines).not.toContain("");
		expect(sections[0]?.lines.at(-1)).toBe("+added");
		expect(sections[1]?.names).toContain("sub/two.ts");
		expect(sections[1]?.lines.at(-1)).toBe("+new line");
	});

	test("text without a diff --git line yields []", () => {
		expect(splitDiffSections("just some text\nmore text\n")).toEqual([]);
		expect(splitDiffSections("")).toEqual([]);
	});
});

describe("pickDiffSections", () => {
	const sections = splitDiffSections(
		[
			"diff --git a/img.png b/img.png",
			"Binary files a/img.png and b/img.png differ",
			"diff --git a/gone.ts b/gone.ts",
			"deleted file mode 100644",
			"--- a/gone.ts",
			"+++ /dev/null",
			"-bye",
			"diff --git a/pkg/old.ts b/pkg/new.ts",
			"similarity index 90%",
			"rename from pkg/old.ts",
			"rename to pkg/new.ts",
		].join("\n"),
	);

	test("binary and deleted sections match through the diff --git line", () => {
		const picked = pickDiffSections(sections, ["img.png", "gone.ts"]);
		expect(picked).toHaveLength(2);
		expect(picked[0]?.lines.join("\n")).toContain("Binary files");
		expect(picked[1]?.lines.join("\n")).toContain("-bye");
	});

	test("rename stat paths match either side, brace form included", () => {
		// Pure renames display the b-side (new) path.
		expect(
			pickDiffSections(sections, ["pkg/old.ts => pkg/new.ts"])[0]?.path,
		).toBe("pkg/new.ts");
		expect(pickDiffSections(sections, ["pkg/{old => new}.ts"])).toHaveLength(1);
		expect(pickDiffSections(sections, ["src/{old => new}.ts"])).toEqual([]);
	});

	test("skips files whose section is absent and keeps requested order", () => {
		const picked = pickDiffSections(sections, [
			"gone.ts",
			"missing.ts",
			"img.png",
		]);
		expect(picked.map((s) => s.path)).toEqual(["gone.ts", "img.png"]);
	});

	test("display path: deleted file uses a-side, new file uses b-side", () => {
		expect(sections.find((s) => s.names.includes("gone.ts"))?.path).toBe(
			"gone.ts",
		);
		expect(
			splitDiffSections(
				[
					"diff --git a/fresh.ts b/fresh.ts",
					"new file mode 100644",
					"--- /dev/null",
					"+++ b/fresh.ts",
					"+new",
				].join("\n"),
			)[0]?.path,
		).toBe("fresh.ts");
	});

	test("display path: pure rename without ---/+++ headers uses the b-side", () => {
		expect(
			splitDiffSections(
				[
					"diff --git a/old-name.ts b/new-name.ts",
					"similarity index 100%",
					"rename from old-name.ts",
					"rename to new-name.ts",
				].join("\n"),
			)[0]?.path,
		).toBe("new-name.ts");
	});
});

describe("numberDiffLines", () => {
	test("numbers one hunk with counts, including context, adds and deletions", () => {
		const out = numberDiffLines([
			"@@ -12,4 +12,5 @@",
			" ctx",
			"-gone",
			"+here",
			"+added",
		]);
		expect(out[0]).toEqual({
			cls: "hunk",
			old: null,
			new: null,
			text: "@@ -12,4 +12,5 @@",
		});
		expect(out[1]).toEqual({ cls: "ctx", old: 12, new: 12, text: " ctx" });
		expect(out[2]).toEqual({ cls: "del", old: 13, new: null, text: "-gone" });
		expect(out[3]).toEqual({ cls: "add", old: null, new: 13, text: "+here" });
		expect(out[4]).toEqual({ cls: "add", old: null, new: 14, text: "+added" });
	});

	test("handles omitted counts and a second hunk resetting counters", () => {
		const out = numberDiffLines([
			"@@ -5 +5,2 @@",
			"-a",
			"+b",
			"+c",
			"@@ -100 +100 @@",
			" d",
		]);
		expect(out[1]).toEqual({ cls: "del", old: 5, new: null, text: "-a" });
		expect(out[2]).toEqual({ cls: "add", old: null, new: 5, text: "+b" });
		expect(out[3]).toEqual({ cls: "add", old: null, new: 6, text: "+c" });
		expect(out[5]).toEqual({ cls: "ctx", old: 100, new: 100, text: " d" });
	});

	test("meta lines, the no-newline marker and pre-hunk lines get null numbers", () => {
		const out = numberDiffLines([
			"diff --git a/one.ts b/one.ts",
			"--- a/one.ts",
			"+++ b/one.ts",
			"@@ -1,2 +1,2 @@",
			"-x",
			"\\ No newline at end of file",
			"+y",
		]);
		expect(out[0]?.old).toBeNull();
		expect(out[0]?.new).toBeNull();
		expect(out[1]?.old).toBeNull();
		expect(out[1]?.new).toBeNull();
		expect(out[2]?.old).toBeNull();
		expect(out[2]?.new).toBeNull();
		expect(out[5]).toEqual({
			cls: "ctx",
			old: null,
			new: null,
			text: "\\ No newline at end of file",
		});
		expect(out[6]?.old).toBeNull();
		expect(out[6]?.new).toBe(1);
	});

	test("a combined-diff @@@ hunk clears numbers for its following lines", () => {
		const out = numberDiffLines([
			"@@ -1,2 +1,2 @@",
			" a",
			"@@@ -1,2 -1,2 +1,2 @@@",
			" b",
			"+c",
		]);
		expect(out[1]?.old).toBe(1);
		expect(out[2]?.old).toBeNull();
		expect(out[3]?.old).toBeNull();
		expect(out[3]?.new).toBeNull();
		expect(out[4]?.new).toBeNull();
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

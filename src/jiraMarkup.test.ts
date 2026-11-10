import { describe, expect, test } from "bun:test";
import { adfToMarkdown, fieldText, wikiToMarkdown } from "./jiraMarkup.ts";
import fc from "./test/properties.ts";

const text = (t: string, marks?: unknown[]) => ({
	type: "text",
	text: t,
	marks,
});
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const li = (...content: unknown[]) => ({ type: "listItem", content });
const cell = (type: string, t: string) => ({ type, content: [p(text(t))] });

describe("adfToMarkdown", () => {
	test("converts headings, marks, nested lists, code, tables, quotes and unknown nodes", () => {
		const doc = {
			type: "doc",
			version: 1,
			content: [
				{ type: "heading", attrs: { level: 2 }, content: [text("Steps")] },
				p(
					text("Use "),
					text("this", [{ type: "strong" }]),
					text(" and "),
					text("docs", [
						{ type: "link", attrs: { href: "https://x.test/a b" } },
					]),
					text(" plus "),
					text("it", [{ type: "em" }]),
					text(" "),
					text("x()", [{ type: "code" }]),
					text(" "),
					text("old", [{ type: "strike" }]),
					{ type: "hardBreak" },
					{ type: "mention", attrs: { id: "1", text: "@Ann" } },
					text(" "),
					{ type: "emoji", attrs: { shortName: ":smile:" } },
					text(" "),
					{ type: "inlineCard", attrs: { url: "https://x.test/c" } },
				),
				{
					type: "bulletList",
					content: [
						li(p(text("one")), {
							type: "bulletList",
							content: [li(p(text("nested")))],
						}),
						li(p(text("two"))),
					],
				},
				{
					type: "orderedList",
					attrs: { order: 3 },
					content: [li(p(text("third"))), li(p(text("fourth")))],
				},
				{
					type: "codeBlock",
					attrs: { language: "js" },
					content: [text("const a = 1;\nconsole.log(a);")],
				},
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [cell("tableHeader", "A"), cell("tableHeader", "B")],
						},
						{
							type: "tableRow",
							content: [cell("tableCell", "1"), cell("tableCell", "2")],
						},
					],
				},
				{ type: "rule" },
				{ type: "blockquote", content: [p(text("quoted")), p(text("more"))] },
				{
					type: "mediaSingle",
					content: [{ type: "weird", content: [text("inner")] }],
				},
			],
		};
		expect(adfToMarkdown(doc)).toBe(
			[
				"## Steps",
				"Use **this** and [docs](https://x.test/a%20b) plus *it* `x()` ~~old~~\n@Ann :smile: https://x.test/c",
				"- one\n  - nested\n- two",
				"3. third\n4. fourth",
				"```js\nconst a = 1;\nconsole.log(a);\n```",
				"A | B\n1 | 2",
				"---",
				"> quoted\n>\n> more",
				"inner",
			].join("\n\n"),
		);
	});

	test("code containing a backtick fence gets a longer fence", () => {
		const doc = {
			type: "doc",
			content: [{ type: "codeBlock", content: [text("a\n```\nb")] }],
		};
		expect(adfToMarkdown(doc)).toBe("````\na\n```\nb\n````");
	});

	test("anything that is not ADF gives an empty string", () => {
		for (const v of [null, undefined, 3, "doc", [], { type: "doc" }])
			expect(adfToMarkdown(v)).toBe("");
	});

	test("nesting past the depth cap is dropped, not a stack overflow", () => {
		let node: unknown = text("deep");
		for (let i = 0; i < 5000; i++)
			node = { type: "blockquote", content: [node] };
		expect(typeof adfToMarkdown({ type: "doc", content: [node] })).toBe(
			"string",
		);
	});

	test("never throws on any value", () => {
		fc.assert(
			fc.property(fc.anything(), (v) => {
				expect(typeof adfToMarkdown(v)).toBe("string");
			}),
		);
	});

	test("never throws on ADF-like trees", () => {
		const type = fc.constantFrom(
			"doc",
			"paragraph",
			"heading",
			"bulletList",
			"orderedList",
			"listItem",
			"codeBlock",
			"blockquote",
			"rule",
			"hardBreak",
			"text",
			"mention",
			"emoji",
			"inlineCard",
			"date",
			"status",
			"table",
			"tableRow",
			"tableCell",
			"tableHeader",
			"panel",
			"weird",
		);
		const mark = fc.record({
			type: fc.constantFrom("strong", "em", "code", "strike", "link", "x"),
			attrs: fc.option(fc.record({ href: fc.anything() })),
		});
		const { node } = fc.letrec((tie) => ({
			node: fc.record(
				{
					type,
					text: fc.oneof(fc.string(), fc.anything()),
					marks: fc.oneof(fc.array(mark, { maxLength: 3 }), fc.anything()),
					attrs: fc.oneof(
						fc.record({
							level: fc.anything(),
							language: fc.anything(),
							order: fc.anything(),
							url: fc.anything(),
							text: fc.anything(),
							timestamp: fc.anything(),
						}),
						fc.anything(),
					),
					content: fc.oneof(
						{ depthSize: "small" },
						fc.array(tie("node"), { maxLength: 4 }),
						fc.anything(),
					),
				},
				{ requiredKeys: ["type"] },
			),
		}));
		fc.assert(
			fc.property(node, (n) => {
				expect(typeof adfToMarkdown(n)).toBe("string");
			}),
		);
	});
});

describe("wikiToMarkdown", () => {
	test("converts headings, nested lists, code, links, emphasis, mono and quotes", () => {
		const wiki = [
			"h2. Setup",
			"Run *bold* and _it_ now, see [the docs|https://x.test/d] or [https://x.test/e].",
			"* one",
			"** nested",
			"# first",
			"## sub",
			"#* mixed",
			"{code:java}",
			"int *x* = _y_; [a|b]",
			"{code}",
			"bq. quoted",
			"{{mono_text *x*}} stays",
			"----",
			"unknown {color:red}red{color} and [~ann]",
		].join("\r\n");
		expect(wikiToMarkdown(wiki)).toBe(
			[
				"## Setup",
				"Run **bold** and *it* now, see [the docs](https://x.test/d) or <https://x.test/e>.",
				"- one",
				"  - nested",
				"1. first",
				"   1. sub",
				"   - mixed",
				"```java",
				"int *x* = _y_; [a|b]",
				"```",
				"> quoted",
				"`mono_text *x*` stays",
				"---",
				"unknown {color:red}red{color} and [~ann]",
			].join("\n"),
		);
	});

	test("noformat, inline code, named language and an unclosed block", () => {
		expect(wikiToMarkdown("a {noformat}*x*{noformat} b")).toBe(
			"a \n```\n*x*\n```\n b",
		);
		expect(wikiToMarkdown("{code:title=A.java|language=java}x{code}")).toBe(
			"```java\nx\n```",
		);
		expect(wikiToMarkdown("{code}\nopen *x*")).toBe("```\nopen *x*\n```");
	});

	test("a bold word at line start is not a list, snake_case is not italic", () => {
		expect(wikiToMarkdown("*bold* start")).toBe("**bold** start");
		expect(wikiToMarkdown("call my_func_name now")).toBe(
			"call my_func_name now",
		);
		expect(wikiToMarkdown("see https://x.test/_a_/b")).toBe(
			"see https://x.test/_a_/b",
		);
	});

	test("never throws on any string", () => {
		const piece = fc.constantFrom(
			"{code}",
			"{code:java}",
			"{noformat}",
			"{{",
			"}}",
			"[",
			"]",
			"|",
			"*",
			"_",
			"#",
			"h1. ",
			"bq. ",
			"\n",
			"\r\n",
			" ",
			"x",
			"https://x.test/",
			"`",
		);
		const markup = fc.array(piece, { maxLength: 40 }).map((a) => a.join(""));
		fc.assert(
			fc.property(fc.oneof(fc.string({ unit: "binary" }), markup), (s) => {
				expect(typeof wikiToMarkdown(s)).toBe("string");
			}),
		);
	});
});

describe("fieldText", () => {
	test("reads strings, numbers, options, users, arrays and ADF", () => {
		expect(fieldText("plain")).toBe("plain");
		expect(fieldText(3.5)).toBe("3.5");
		expect(fieldText(false)).toBe("false");
		expect(fieldText({ value: "High", id: "1" })).toBe("High");
		expect(fieldText({ displayName: "Ann", accountId: "x" })).toBe("Ann");
		expect(fieldText({ key: "PROJ-9" })).toBe("PROJ-9");
		expect(fieldText([{ name: "a" }, null, { name: "b" }, ""])).toBe("a, b");
		expect(
			fieldText({ type: "doc", content: [p(text("x", [{ type: "strong" }]))] }),
		).toBe("**x**");
	});

	test("null, undefined and unknown shapes give an empty string", () => {
		for (const v of [null, undefined, {}, { id: "1" }, [], [null]])
			expect(fieldText(v)).toBe("");
	});
});

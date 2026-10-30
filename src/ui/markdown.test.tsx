import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import fc from "../test/properties.ts";
import { Markdown } from "./markdown.tsx";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
	test("empty or blank text renders nothing", () => {
		expect(render("")).toBe("");
		expect(render("  \n\t")).toBe("");
	});

	test("headings, paragraphs, and soft wraps", () => {
		expect(render("# Title\n\nBody text.")).toBe(
			'<div class="md"><h1>Title</h1><p>Body text.</p></div>',
		);
		expect(render("## Head ##\n\none\ntwo")).toBe(
			'<div class="md"><h2>Head</h2><p>one\ntwo</p></div>',
		);
	});

	test("inline code, bold, italic, strike", () => {
		expect(render("a `code` and **bold** and *em* and ~~gone~~")).toBe(
			'<div class="md"><p>a <code>code</code> and <strong>bold</strong> and <em>em</em> and <del>gone</del></p></div>',
		);
	});

	test("markup inside inline code stays literal", () => {
		expect(render("use `**not bold**` here")).toBe(
			'<div class="md"><p>use <code>**not bold**</code> here</p></div>',
		);
	});

	test("fence hook replaces only the blocks it claims, quotes included", () => {
		const fence = (lang: string, code: string) =>
			lang === "mermaid" ? <figure>{code}</figure> : null;
		expect(
			renderToStaticMarkup(
				<Markdown
					text={
						"```mermaid x\nA-->B\n```\n\n```ts\nlet a\n```\n\n> ```mermaid\n> C\n> ```"
					}
					fence={fence}
				/>,
			),
		).toBe(
			'<div class="md"><figure>A--&gt;B</figure><pre><code>let a</code></pre><blockquote><figure>C</figure></blockquote></div>',
		);
	});

	test("fenced code keeps newlines verbatim", () => {
		expect(render("```\nconst x = 1;\n\nkeep me\n```")).toBe(
			'<div class="md"><pre><code>const x = 1;\n\nkeep me</code></pre></div>',
		);
	});

	test("flat and nested lists", () => {
		expect(render("- one\n- two\n  - nested\n- three")).toBe(
			'<div class="md"><ul><li>one</li><li>two<ul><li>nested</li></ul></li><li>three</li></ul></div>',
		);
		expect(render("1. first\n2. second")).toBe(
			'<div class="md"><ol><li>first</li><li>second</li></ol></div>',
		);
	});

	test("blockquote nests blocks", () => {
		expect(render("> quoted\n> more")).toBe(
			'<div class="md"><blockquote><p>quoted\nmore</p></blockquote></div>',
		);
	});

	test("pipe tables render header and rows", () => {
		expect(render("| A | B |\n| --- | --- |\n| one | two |")).toBe(
			'<div class="md"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>one</td><td>two</td></tr></tbody></table></div>',
		);
	});

	test("table cells keep inline markup and escaped pipes", () => {
		expect(render("| k | v |\n| --- | --- |\n| **b** | a \\| b |")).toBe(
			'<div class="md"><table><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td><strong>b</strong></td><td>a | b</td></tr></tbody></table></div>',
		);
	});

	test("a table interrupts a paragraph without a blank line", () => {
		expect(render("Intro\n| A |\n| --- |\n| x |")).toBe(
			'<div class="md"><p>Intro</p><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table></div>',
		);
	});

	test("a bare hr still renders as hr, not table", () => {
		expect(render("text\n\n---\n\nmore")).toBe(
			'<div class="md"><p>text</p><hr/><p>more</p></div>',
		);
	});

	test("links and bare URLs", () => {
		expect(
			render("[docs](https://example.com/a) and https://example.com/b"),
		).toBe(
			'<div class="md"><p><a href="https://example.com/a" target="_blank" rel="noreferrer">docs</a> and <a href="https://example.com/b" target="_blank" rel="noreferrer">https://example.com/b</a></p></div>',
		);
	});

	test("javascript: URLs render as plain text", () => {
		expect(render("[click](javascript:alert(1))")).toBe(
			'<div class="md"><p>[click](javascript:alert(1))</p></div>',
		);
	});

	test("HTML in text stays escaped", () => {
		const out = render(
			"<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>",
		);
		expect(out).toContain("&lt;script&gt;");
		expect(out).not.toContain("<script>");
		expect(out).not.toContain("<img");
	});

	test("fenced code accepts CommonMark info strings", () => {
		const out = render('```js title="app.tsx"\nconst x = 1;\n```');
		expect(out).toBe(
			'<div class="md"><pre><code>const x = 1;</code></pre></div>',
		);
		// Info strings with hyphens or spaces were rejected and used to hang the parser.
		expect(render("```release-dialog\nhi\n```")).toContain("<pre><code>hi");
		expect(render("``` ts\nhi\n```")).toContain("<pre><code>hi");
	});

	test("every input line makes progress (no hang on unhandled block starts)", () => {
		// "# " alone matches BLOCK_START but no branch; used to spin forever.
		expect(render("# ")).toBe('<div class="md"><p># </p></div>');
		// 1-3 indented headings are headings; 4+ renders as a paragraph instead of hanging.
		expect(render("   ## Indented")).toContain("<h2>Indented</h2>");
		expect(render("    # Deep")).toContain("<p># Deep</p>");
		// A ``` line with junk after it must not wedge the outer loop either.
		expect(render("```x y z\n// code\n```")).toContain("// code");
	});

	test("4-backtick fence closes only with a run of >= 4 backticks", () => {
		expect(render("````md\ncode\n````\nafter")).toBe(
			'<div class="md"><pre><code>code</code></pre><p>after</p></div>',
		);
		// A 3-tick line inside a 4-tick fence is content, not the closer.
		expect(render("````md\n```\nstill code\n````")).toBe(
			'<div class="md"><pre><code>```\nstill code</code></pre></div>',
		);
	});

	test("property: parse never throws and renders content for any string", () => {
		fc.assert(
			fc.property(fc.string(), (text) => {
				const out = render(text);
				if (text.trim() !== "") expect(out.length).toBeGreaterThan(0);
			}),
		);
	});
});

import { Fragment, type ReactNode } from "react";

// ponytail: subset markdown — headings, paragraphs, fenced code, lists (nested),
// blockquotes, hr, tables (GFM pipe), bold/italic/code/strike, links, bare URLs,
// images (markdown syntax and raw <img> tags; same-origin srcs render,
// remote http(s) srcs render as links).
// No reference links; swap in a real parser if reports start needing them.

/** Inline tokens; alternation order is precedence: code first so markup inside stays literal.
 *  The bare-URL group stops before trailing punctuation (GFM autolink style): "…/jira:" and
 *  "…/a." must link without the final : or . — interior : and . still match via backtracking. */
const INLINE_RE =
	/(`[^`\n]+`)|(\*\*[^*]+?\*\*)|(__[^_]+?__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[([^\]\n]*)\]\(([^()\s]+)\))|(https?:\/\/[^\s<>")\]]*[^\s<>")\].,:;!?'])|(!\[([^\]\n]*)\]\(([^()\s]+)\))|(<img\s[^>]*>)/g;

/** Only http(s) links become anchors; anything else renders as plain text. */
function safeHref(url: string): string | null {
	return /^https?:\/\//i.test(url) ? url : null;
}

/** Copies only safe attributes out of a raw <img> tag: src, alt, numeric width.
 *  Everything else (on* handlers, style, srcset) is dropped; a tag without a src attribute
 *  is dropped. Whether the src itself renders is imageNode's call. */
function parseImg(tag: string): {
	src: string;
	alt: string;
	width: string | undefined;
} | null {
	const attr = (name: string): string | null => {
		const m = tag.match(
			new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s">]+))`, "i"),
		);
		return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
	};
	const src = attr("src");
	if (src === null) return null;
	const width = attr("width");
	return {
		src,
		alt: attr("alt") ?? "",
		width: width !== null && /^\d+$/.test(width) ? width : undefined,
	};
}

/** Images: same-origin (root-relative) srcs render; remote http(s) srcs become links, so
 *  untrusted card text (PR titles, agent output) cannot make the viewer's browser call the
 *  attacker's server (tracking, Referer/secret exfiltration) just by opening the card.
 *  Other srcs (javascript:, protocol-relative, empty) render nothing. */
function imageNode(
	src: string,
	alt: string,
	key: string,
	width?: string,
): ReactNode {
	// Root-relative only: "//host" and "/\host" are protocol-relative, and browsers strip
	// tab/newline from URLs, so "/\t/host" resolves the same way — reject them all; any of
	// these fetches a remote server the moment the card is viewed.
	// loading="lazy": reports can embed many same-origin shots; the browser then only
	// fetches the ones near the viewport instead of the whole report at once.
	if (/^\/[^\s/\\]/.test(src))
		return <img key={key} src={src} alt={alt} width={width} loading="lazy" />;
	if (safeHref(src) !== null)
		return (
			<a key={key} href={src} target="_blank" rel="noreferrer">
				{alt === "" ? src : alt}
			</a>
		);
	return null;
}

/** Renders one inline token; null means the token renders nothing (a dropped <img> tag). */
function inlineToken(
	tok: string,
	m: RegExpMatchArray,
	key: string,
): ReactNode | null {
	if (tok.startsWith("`")) return <code key={key}>{tok.slice(1, -1)}</code>;
	if (tok.startsWith("**") || tok.startsWith("__"))
		return <strong key={key}>{inline(tok.slice(2, -2), key)}</strong>;
	if (tok.startsWith("~~"))
		return <del key={key}>{inline(tok.slice(2, -2), key)}</del>;
	if (tok.startsWith("[")) return linkToken(tok, m, key);
	if (tok.startsWith("!") || tok.startsWith("<img"))
		return imageToken(tok, m, key);
	if (tok.startsWith("http"))
		return (
			<a key={key} href={tok} target="_blank" rel="noreferrer">
				{tok}
			</a>
		);
	return <em key={key}>{inline(tok.slice(1, -1), key)}</em>;
}

/** `[text](href)`: only http(s) hrefs become anchors; any other href stays literal text. */
function linkToken(tok: string, m: RegExpMatchArray, key: string): ReactNode {
	const href = safeHref(m[9] ?? "");
	if (href === null) return tok;
	return (
		<a key={key} href={href} target="_blank" rel="noreferrer">
			{m[8] ?? tok}
		</a>
	);
}

/** The `![alt](src)` and raw `<img …>` tokens; null means nothing renders. */
function imageToken(
	tok: string,
	m: RegExpMatchArray,
	key: string,
): ReactNode | null {
	if (tok.startsWith("!"))
		return imageNode(m[13] ?? "", m[12] ?? "", key) ?? tok;
	const img = parseImg(tok);
	if (img === null) return null;
	return imageNode(img.src, img.alt, key, img.width);
}

function inline(text: string, keyPrefix: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let k = 0;
	for (const m of text.matchAll(INLINE_RE)) {
		const { index = 0 } = m;
		const tok = m[0];
		if (index > last) out.push(text.slice(last, index));
		const node = inlineToken(tok, m, `${keyPrefix}-${k++}`);
		if (node !== null) out.push(node);
		last = index + tok.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** Opening fence: ``` plus any CommonMark info string; group 2 is its first word (the language). */
const FENCE_OPEN = /^\s*(`{3,})\s*([^\s`]*)/;
/** A line that would start a new block, ending paragraph collection. */
const BLOCK_START = /^\s{0,3}(?:```|#{1,6}\s|>)/;
/** GFM delimiter row: |-cells, optional colons. Must contain a pipe so a bare `---` never matches. */
const TABLE_SEP = /^\s{0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** Pipe-table start: this row has a pipe and the next row is a delimiter row with a pipe. */
const isTableStart = (lines: string[], i: number): boolean =>
	at(lines, i).includes("|") &&
	at(lines, i + 1).includes("|") &&
	TABLE_SEP.test(at(lines, i + 1));
/** split() never yields holes; "" only appears past the end, where it matches no branch. */
const at = (lines: string[], i: number): string => lines[i] ?? "";

const indentWidth = (lead: string): number => lead.replace(/\t/g, "  ").length;

function parseListAt(
	lines: string[],
	start: number,
	indent: number,
): [ReactNode, number] {
	const ordered = /^\s*\d/.test(at(lines, start));
	const items: ReactNode[][] = [];
	let i = start;
	while (i < lines.length) {
		const line = at(lines, i);
		const m = line.match(BULLET);
		if (!m) break;
		const itemIndent = indentWidth(m[1] ?? "");
		if (itemIndent < indent) break;
		if (itemIndent > indent) {
			const [nested, next] = parseListAt(lines, i, itemIndent);
			items[items.length - 1]?.push(nested);
			i = next;
			continue;
		}
		const text = [m[3] ?? ""];
		i++;
		// Continuation lines (indented prose under one bullet) join the item.
		while (
			i < lines.length &&
			!/^\s*$/.test(at(lines, i)) &&
			!BULLET.test(at(lines, i))
		) {
			text.push(at(lines, i).trim());
			i++;
		}
		items.push([inline(text.join(" "), `li${items.length}`)]);
	}
	const Tag = (ordered ? "ol" : "ul") as "ol";
	return [
		<Tag key={`l${start}`}>
			{items.map((nodes, idx) => (
				<li key={idx}>{nodes}</li>
			))}
		</Tag>,
		i,
	];
}

/** Renders a fenced block in place of the default <pre>; null keeps the default. */
type Fence = (lang: string, code: string) => ReactNode | null;

/** One parsed block: the node, the next unconsumed line, and how many key slots it
 *  consumed (block keys and heading/paragraph inline prefixes share one counter). */
type BlockResult = [ReactNode, number, number];

function fenceBlock(
	lines: string[],
	i: number,
	open: RegExpMatchArray,
	fence: Fence | undefined,
	base: number,
): BlockResult {
	// Closing fence needs a backtick run at least as long as the opener's.
	const close = new RegExp(`^\\s*\`{${open[1]?.length},}\\s*$`);
	const buf: string[] = [];
	i++;
	while (i < lines.length && !close.test(at(lines, i))) {
		buf.push(at(lines, i));
		i++;
	}
	i++; // closing fence or EOF
	const code = buf.join("\n");
	return [
		<Fragment key={`b${base}`}>
			{fence?.(open[2] ?? "", code) ?? (
				<pre>
					<code>{code}</code>
				</pre>
			)}
		</Fragment>,
		i,
		1,
	];
}

function headingBlock(
	h: RegExpMatchArray,
	i: number,
	base: number,
): BlockResult {
	const Tag = `h${(h[1] ?? "#").length}` as "h1";
	return [
		<Tag key={`b${base}`}>{inline(h[2] ?? "", `b${base + 1}`)}</Tag>,
		i + 1,
		2,
	];
}

function quoteBlock(
	lines: string[],
	i: number,
	fence: Fence | undefined,
	base: number,
): BlockResult {
	const buf: string[] = [];
	while (i < lines.length && /^\s*>/.test(at(lines, i))) {
		buf.push(at(lines, i).replace(/^\s*>\s?/, ""));
		i++;
	}
	return [
		<blockquote key={`b${base}`}>
			{parseBlocks(buf.join("\n"), fence)}
		</blockquote>,
		i,
		1,
	];
}

function tableBlock(lines: string[], i: number, base: number): BlockResult {
	// ponytail: pipes inside inline code still split cells; escaped \| works.
	// Body rows take t(base+1): the original built the <table> key before its children.
	const cells = (row: string, prefix: string): ReactNode[] =>
		row
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split(/(?<!\\)\|/)
			.map((c) => inline(c.trim().replace(/\\\|/g, "|"), prefix));
	const head = cells(at(lines, i), `t${base}`);
	i += 2;
	const rows: ReactNode[][] = [];
	while (
		i < lines.length &&
		!/^\s*$/.test(at(lines, i)) &&
		at(lines, i).includes("|")
	) {
		rows.push(cells(at(lines, i), `t${base + 1}`));
		i++;
	}
	return [
		<table key={`b${base}`}>
			<thead>
				<tr>
					{head.map((c, ci) => (
						<th key={ci}>{c}</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((r, ri) => (
					<tr key={ri}>
						{r.map((c, ci) => (
							<td key={ci}>{c}</td>
						))}
					</tr>
				))}
			</tbody>
		</table>,
		i,
		1,
	];
}

function paragraphBlock(lines: string[], i: number, base: number): BlockResult {
	const buf: string[] = [];
	while (
		i < lines.length &&
		!/^\s*$/.test(at(lines, i)) &&
		!BLOCK_START.test(at(lines, i)) &&
		!BULLET.test(at(lines, i)) &&
		!isTableStart(lines, i)
	) {
		buf.push(at(lines, i).trim());
		i++;
	}
	// Backstop: a line that starts a block the branches above don't handle
	// must still be consumed, or the while loop hangs forever.
	if (buf.length === 0) {
		buf.push(at(lines, i));
		i++;
	}
	return [
		<p key={`b${base}`}>{inline(buf.join("\n"), `b${base + 1}`)}</p>,
		i,
		2,
	];
}

/** Parses whichever block type starts at line i; the paragraph branch always matches. */
function blockAt(
	lines: string[],
	i: number,
	fence: Fence | undefined,
	base: number,
): BlockResult {
	const line = at(lines, i);
	const open = line.match(FENCE_OPEN);
	if (open) return fenceBlock(lines, i, open, fence, base);
	const h = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
	if (h) return headingBlock(h, i, base);
	if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line))
		return [<hr key={`b${base}`} />, i + 1, 1];
	if (/^\s*>/.test(line)) return quoteBlock(lines, i, fence, base);
	if (isTableStart(lines, i)) return tableBlock(lines, i, base);
	if (BULLET.test(line)) {
		const [list, next] = parseListAt(
			lines,
			i,
			indentWidth(line.match(BULLET)?.[1] ?? ""),
		);
		return [list, next, 0];
	}
	return paragraphBlock(lines, i, base);
}

function parseBlocks(src: string, fence?: Fence): ReactNode[] {
	const lines = src.replace(/\r\n?/g, "\n").split("\n");
	const out: ReactNode[] = [];
	let i = 0;
	let k = 0;
	while (i < lines.length) {
		if (/^\s*$/.test(at(lines, i))) {
			i++;
			continue;
		}
		const [node, next, used] = blockAt(lines, i, fence, k);
		out.push(node);
		i = next;
		k += used;
	}
	return out;
}

/** Renders markdown text as React elements; all text stays escaped, no raw HTML except
 *  same-origin <img> srcs — remote image srcs render as links, never as loaded images. */
export function Markdown({
	text,
	fence,
}: {
	text: string;
	fence?: Fence;
}): ReactNode {
	if (text.trim() === "") return null;
	return <div className="md">{parseBlocks(text, fence)}</div>;
}

import { Fragment, type ReactNode } from "react";

// ponytail: subset markdown — headings, paragraphs, fenced code, lists (nested),
// blockquotes, hr, tables (GFM pipe), bold/italic/code/strike, links, bare URLs.
// No images, no reference links; swap in a real parser if reports start needing them.

/** Inline tokens; alternation order is precedence: code first so markup inside stays literal. */
const INLINE_RE =
	/(`[^`\n]+`)|(\*\*[^*]+?\*\*)|(__[^_]+?__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[([^\]\n]*)\]\(([^()\s]+)\))|(https?:\/\/[^\s<>")\]]+)/g;

/** Only http(s) links become anchors; anything else renders as plain text. */
function safeHref(url: string): string | null {
	return /^https?:\/\//i.test(url) ? url : null;
}

function inline(text: string, keyPrefix: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let k = 0;
	for (const m of text.matchAll(INLINE_RE)) {
		const { index = 0 } = m;
		const tok = m[0];
		if (index > last) out.push(text.slice(last, index));
		const key = `${keyPrefix}-${k++}`;
		if (tok.startsWith("`")) {
			out.push(<code key={key}>{tok.slice(1, -1)}</code>);
		} else if (tok.startsWith("**") || tok.startsWith("__")) {
			out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
		} else if (tok.startsWith("~~")) {
			out.push(<del key={key}>{inline(tok.slice(2, -2), key)}</del>);
		} else if (tok.startsWith("[")) {
			const href = safeHref(m[9] ?? "");
			out.push(
				href === null ? (
					tok
				) : (
					<a key={key} href={href} target="_blank" rel="noreferrer">
						{m[8] ?? tok}
					</a>
				),
			);
		} else if (tok.startsWith("http")) {
			out.push(
				<a key={key} href={tok} target="_blank" rel="noreferrer">
					{tok}
				</a>,
			);
		} else {
			out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
		}
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
				// biome-ignore lint/suspicious/noArrayIndexKey: pure function of text; items are positional
				<li key={idx}>{nodes}</li>
			))}
		</Tag>,
		i,
	];
}

/** Renders a fenced block in place of the default <pre>; null keeps the default. */
type Fence = (lang: string, code: string) => ReactNode | null;

function parseBlocks(src: string, fence?: Fence): ReactNode[] {
	const lines = src.replace(/\r\n?/g, "\n").split("\n");
	const out: ReactNode[] = [];
	let i = 0;
	let k = 0;
	while (i < lines.length) {
		const line = at(lines, i);
		if (/^\s*$/.test(line)) {
			i++;
			continue;
		}
		const open = line.match(FENCE_OPEN);
		if (open) {
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
			out.push(
				<Fragment key={`b${k++}`}>
					{fence?.(open[2] ?? "", code) ?? (
						<pre>
							<code>{code}</code>
						</pre>
					)}
				</Fragment>,
			);
			continue;
		}
		const h = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (h) {
			const Tag = `h${(h[1] ?? "#").length}` as "h1";
			out.push(<Tag key={`b${k++}`}>{inline(h[2] ?? "", `b${k++}`)}</Tag>);
			i++;
			continue;
		}
		if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
			out.push(<hr key={`b${k++}`} />);
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const buf: string[] = [];
			while (i < lines.length && /^\s*>/.test(at(lines, i))) {
				buf.push(at(lines, i).replace(/^\s*>\s?/, ""));
				i++;
			}
			out.push(
				<blockquote key={`b${k++}`}>
					{parseBlocks(buf.join("\n"), fence)}
				</blockquote>,
			);
			continue;
		}
		if (isTableStart(lines, i)) {
			// ponytail: pipes inside inline code still split cells; escaped \| works
			const cells = (row: string): ReactNode[] =>
				row
					.trim()
					.replace(/^\|/, "")
					.replace(/\|$/, "")
					.split(/(?<!\\)\|/)
					.map((c) => inline(c.trim().replace(/\\\|/g, "|"), `t${k}`));
			const head = cells(at(lines, i));
			i += 2;
			const rows: ReactNode[][] = [];
			while (
				i < lines.length &&
				!/^\s*$/.test(at(lines, i)) &&
				at(lines, i).includes("|")
			) {
				rows.push(cells(at(lines, i)));
				i++;
			}
			out.push(
				<table key={`b${k++}`}>
					<thead>
						<tr>
							{head.map((c, ci) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: pure function of text; cells are positional
								<th key={ci}>{c}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((r, ri) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: pure function of text; rows are positional
							<tr key={ri}>
								{r.map((c, ci) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: pure function of text; cells are positional
									<td key={ci}>{c}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>,
			);
			continue;
		}
		if (BULLET.test(line)) {
			const [list, next] = parseListAt(
				lines,
				i,
				indentWidth(line.match(BULLET)?.[1] ?? ""),
			);
			out.push(list);
			i = next;
			continue;
		}
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
		out.push(<p key={`b${k++}`}>{inline(buf.join("\n"), `b${k++}`)}</p>);
	}
	return out;
}

/** Renders markdown text as React elements; all text stays escaped, no raw HTML. */
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

// Jira ticket text to Markdown: Cloud ADF documents and Data Center wiki markup. Input is
// untrusted Jira data: the converters check every shape and never throw.

/** Deeper ADF nesting is dropped: real documents stay far below it. */
const MAX_DEPTH = 100;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const children = (n: Obj): unknown[] =>
	Array.isArray(n.content) ? n.content : [];

/** A code fence longer than any backtick run inside the code, so the code cannot close it. */
function fence(code: string, lang: string): string {
	let longest = 0;
	for (const m of code.matchAll(/`+/g))
		longest = Math.max(longest, m[0].length);
	const f = "`".repeat(Math.max(3, longest + 1));
	return `${f}${lang}\n${code}\n${f}`;
}

/** Prefix the first line with `first` and the others with `rest` (trailing spaces cut on blank lines). */
function prefixLines(text: string, first: string, rest: string): string {
	return text
		.split("\n")
		.map((l, i) => (i === 0 ? first : l === "" ? rest.trimEnd() : rest) + l)
		.join("\n");
}

/** ADF node types that sit inside a paragraph; the other nodes are blocks. */
const INLINE: Record<string, true> = {
	text: true,
	hardBreak: true,
	mention: true,
	emoji: true,
	inlineCard: true,
	date: true,
	status: true,
};

function markText(text: string, marks: unknown): string {
	if (text === "" || !Array.isArray(marks)) return text;
	const has = (t: string) => marks.find((m) => isObj(m) && m.type === t);
	let out = text;
	if (has("code")) out = out.includes("`") ? `\`\` ${out} \`\`` : `\`${out}\``;
	if (has("em")) out = `*${out}*`;
	if (has("strong")) out = `**${out}**`;
	if (has("strike")) out = `~~${out}~~`;
	const link = has("link");
	const href = isObj(link) && isObj(link.attrs) ? str(link.attrs.href) : "";
	if (href !== "")
		out = `[${out}](${href.replace(/[\s()]/g, encodeURIComponent)})`;
	return out;
}

/** One node of the INLINE set. */
function inlineNode(n: Obj): string {
	const attrs = isObj(n.attrs) ? n.attrs : {};
	switch (n.type) {
		case "text":
			return markText(str(n.text), n.marks);
		case "hardBreak":
			return "\n";
		case "inlineCard":
			return str(attrs.url);
		case "emoji":
			return str(attrs.text) || str(attrs.shortName);
		case "date": {
			const ts = attrs.timestamp;
			const d = new Date(
				typeof ts === "number" || typeof ts === "string" ? Number(ts) : NaN,
			);
			return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
		}
		default: // mention, status
			return str(attrs.text);
	}
}

/** Children in order: runs of inline nodes concatenate, block nodes join with `sep`. */
function blocks(nodes: unknown[], depth: number, sep: string): string {
	if (depth > MAX_DEPTH) return "";
	const parts: string[] = [];
	let run = "";
	for (const n of nodes) {
		if (isObj(n) && INLINE[str(n.type)] === true) {
			run += inlineNode(n);
			continue;
		}
		if (run !== "") parts.push(run);
		run = "";
		const b = blockNode(n, depth);
		if (b !== "") parts.push(b);
	}
	if (run !== "") parts.push(run);
	return parts.join(sep);
}

function listItems(n: Obj, depth: number, ordered: boolean): string {
	const attrs = isObj(n.attrs) ? n.attrs : {};
	const order = attrs.order;
	let num =
		ordered && typeof order === "number" && Number.isSafeInteger(order)
			? order
			: 1;
	return children(n)
		.map((item) => {
			const marker = ordered ? `${num++}. ` : "- ";
			const body = isObj(item) ? blocks(children(item), depth + 1, "\n") : "";
			return prefixLines(body, marker, " ".repeat(marker.length));
		})
		.join("\n");
}

function tableRows(n: Obj, depth: number): string {
	return children(n)
		.map((row) =>
			isObj(row)
				? children(row)
						.map((cell) =>
							isObj(cell)
								? blocks(children(cell), depth + 2, " ")
										.replace(/\s*\n\s*/g, " ")
										.trim()
								: "",
						)
						.join(" | ")
				: "",
		)
		.filter((r) => r !== "")
		.join("\n");
}

function blockNode(n: unknown, depth: number): string {
	if (!isObj(n) || depth > MAX_DEPTH) return "";
	const attrs = isObj(n.attrs) ? n.attrs : {};
	switch (n.type) {
		case "paragraph":
			return blocks(children(n), depth + 1, "");
		case "heading": {
			const lvl = typeof attrs.level === "number" ? attrs.level : 1;
			const hashes = "#".repeat(Math.min(6, Math.max(1, Math.trunc(lvl) || 1)));
			return `${hashes} ${blocks(children(n), depth + 1, " ")}`;
		}
		case "bulletList":
			return listItems(n, depth, false);
		case "orderedList":
			return listItems(n, depth, true);
		case "codeBlock": {
			const code = children(n)
				.map((c) => (isObj(c) ? str(c.text) : ""))
				.join("");
			return fence(code, str(attrs.language).replace(/[^\w+#.-]/g, ""));
		}
		case "blockquote":
		case "panel":
			return prefixLines(blocks(children(n), depth + 1, "\n\n"), "> ", "> ");
		case "rule":
			return "---";
		case "table":
			return tableRows(n, depth);
		default:
			return blocks(children(n), depth + 1, "\n\n");
	}
}

/** An ADF document (or any ADF node) as Markdown; anything that is not ADF gives "". */
export function adfToMarkdown(doc: unknown): string {
	return blockNode(doc, 0).replace(/^\n+|\s+$/g, "");
}

// Inline wiki spans whose content is kept as written: {{mono}}, [text|url], [url], bare URLs.
const WIKI_TOKEN_RE =
	/\{\{([^\n]{1,1000}?)\}\}|\[([^[\]|\n]*)\|([^[\]|\n]+)(?:\|[^[\]\n]*)?\]|\[([^[\]|\n]+)\]|\b((?:https?|ftp):\/\/[^\s<>[\]]+)/g;
const URL_RE = /^(?:https?|ftp|mailto):/i;

function wikiEmphasis(s: string): string {
	return s
		.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=[^\w*]|$)/g, "$1**$2**")
		.replace(/(^|[^\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?=[^\w_]|$)/g, "$1*$2*");
}

function wikiInline(line: string): string {
	let out = "";
	let at = 0;
	for (const m of line.matchAll(WIKI_TOKEN_RE)) {
		const i = m.index ?? 0;
		out += wikiEmphasis(line.slice(at, i));
		at = i + m[0].length;
		const [all, mono, text, url, single, bare] = m;
		if (mono !== undefined)
			out += mono.includes("`") ? `\`\` ${mono} \`\`` : `\`${mono}\``;
		else if (url !== undefined)
			out += text?.trim()
				? `[${wikiEmphasis(text)}](${url.trim()})`
				: `<${url.trim()}>`;
		else if (single !== undefined)
			out += URL_RE.test(single.trim()) ? `<${single.trim()}>` : all;
		else out += bare ?? all;
	}
	return out + wikiEmphasis(line.slice(at));
}

function wikiLine(line: string): string {
	const h = /^\s*h([1-6])\.\s*(.*)$/.exec(line);
	if (h) return `${"#".repeat(Number(h[1]))} ${wikiInline(h[2] ?? "")}`;
	const bq = /^\s*bq\.\s?(.*)$/.exec(line);
	if (bq) return `> ${wikiInline(bq[1] ?? "")}`;
	if (/^\s*-{4,}\s*$/.test(line)) return "---";
	const li = /^\s*([*#]+)\s+(.*)$/.exec(line);
	if (li) {
		const marks = li[1] ?? "";
		const indent = [...marks.slice(0, -1)]
			.map((c) => (c === "#" ? "   " : "  "))
			.join("");
		return `${indent}${marks.endsWith("#") ? "1." : "-"} ${wikiInline(li[2] ?? "")}`;
	}
	return wikiInline(line);
}

const wikiText = (s: string): string => s.split("\n").map(wikiLine).join("\n");

const CODE_OPEN_RE = /\{(code|noformat)(?::([^}\n]*))?\}/g;

/** The language of `{code:java}` or `{code:title=A.java|language=java}`; "" when none. */
function codeLang(params: string): string {
	const named = /(?:^|\|)\s*language\s*=\s*([^|]*)/i.exec(params);
	const lang = named
		? (named[1] ?? "")
		: params.includes("=")
			? ""
			: (params.split("|")[0] ?? "");
	return lang.trim().replace(/[^\w+#.-]/g, "");
}

/** Jira wiki markup as Markdown; code and noformat content is kept as written. */
export function wikiToMarkdown(s: string): string {
	if (typeof s !== "string") return "";
	const src = s.replace(/\r\n?/g, "\n");
	let out = "";
	let at = 0;
	CODE_OPEN_RE.lastIndex = 0;
	for (;;) {
		const m = CODE_OPEN_RE.exec(src);
		if (m === null) break;
		const close = `{${m[1]}}`;
		const start = m.index + m[0].length;
		const endAt = src.indexOf(close, start);
		const end = endAt === -1 ? src.length : endAt;
		const before = wikiText(src.slice(at, m.index));
		out += before === "" || before.endsWith("\n") ? before : `${before}\n`;
		const code = src.slice(start, end).replace(/^\n/, "").replace(/\n$/, "");
		out += `${fence(code, m[1] === "code" ? codeLang(m[2] ?? "") : "")}\n`;
		at = endAt === -1 ? src.length : end + close.length;
		if (src[at] === "\n") at++;
		CODE_OPEN_RE.lastIndex = at;
	}
	return (out + wikiText(src.slice(at))).replace(/\n+$/, "");
}

/** A Jira field value as text: options, users, arrays and ADF documents included. */
export function fieldText(v: unknown): string {
	return valueText(v, 0);
}

function valueText(v: unknown, depth: number): string {
	if (v === null || v === undefined || depth > 10) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint")
		return String(v);
	if (Array.isArray(v))
		return v
			.map((x) => valueText(x, depth + 1))
			.filter((x) => x !== "")
			.join(", ");
	if (!isObj(v)) return "";
	if (v.type === "doc") return adfToMarkdown(v);
	for (const k of ["value", "name", "displayName", "key"]) {
		const t = valueText(v[k], depth + 1);
		if (t !== "") return t;
	}
	return "";
}

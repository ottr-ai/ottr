// The Settings model roles editor: reads and edits the `modelRoles` block and the managed keys of
// `retry.fallbackChains` in the data repo's user/omp/agent/config.yml text, byte for byte outside
// the changed lines (docs/specs/model-roles-editor.md "Text edit").
import { splitLevel, THINKING_LEVELS } from "./levels.ts";

/** A config.yml the editor cannot edit safely; the route answers 422. */
export class RolesLayoutError extends Error {}

/** `retry.fallbackChains`: a chain of model selectors for each role or model key. */
export type Fallbacks = Record<string, string[]>;

const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HEADER = /^modelRoles:[ \t]*(#.*)?$/;
const SCALAR = `'(?:[^']|'')*'|"(?:[^"\\\\]|\\\\.)*"|[^\\s'"&*!|>{}[\\],#%@\`?:][^\\s#]*`;
const ENTRY = new RegExp(
	`^([ \\t]+)([A-Za-z0-9_.-]+):([ \\t]+)(${SCALAR})([ \\t]+#.*)?$`,
);
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/;
const RETRY = /^retry:[ \t]*(#.*)?$/;
const CHAINS = /^fallbackChains:[ \t]*(#.*)?$/;
/** A chain key line without its indent: the key text, then everything after the colon. */
const CHAIN_KEY =
	/^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s#'"?&*!|>{}[\],%@`][^\s#]*?):((?:[ \t].*)?)$/;
const ITEM = new RegExp(`^[ \\t]*-[ \\t]+(${SCALAR})([ \\t]+#.*)?$`);
const SEQ_ITEM = /^-(?:[ \t]|$)/;

type Doc = Record<string, unknown>;

const isMap = (v: unknown): v is Doc =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const skippable = (body: string): boolean => /^\s*(#.*)?$/.test(body);
const indentOf = (body: string): string => /^[ \t]*/.exec(body)?.[0] ?? "";

function parse(text: string): Doc {
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(text);
	} catch (err) {
		throw new RolesLayoutError(
			`config.yml does not parse: ${(err as Error).message}`,
		);
	}
	if (doc === null || doc === undefined) return {};
	if (!isMap(doc)) throw new RolesLayoutError("config.yml is not a YAML map");
	return doc;
}

/** The `modelRoles` map in file order: nonempty string values only. Throws RolesLayoutError
 *  for a file the editor cannot edit, so a read never offers an unsaveable form. */
export function readRoles(text: string): Record<string, string> {
	scan(text);
	const roles = parse(text).modelRoles;
	// Null prototype: a "__proto__" role in the file stays a role, not the map's prototype.
	const out: Record<string, string> = Object.create(null);
	if (isMap(roles))
		for (const [name, v] of Object.entries(roles))
			if (typeof v === "string" && v !== "") out[name] = v;
	return out;
}

/** `retry.fallbackChains` in file order: every key whose value is a list of nonempty strings
 *  (also an empty list). Throws RolesLayoutError for a layout the editor cannot edit. */
export function readFallbacks(text: string): Fallbacks {
	const doc = parse(text);
	const roles = doc.modelRoles;
	const managed = new Set(isMap(roles) ? Object.keys(roles) : []);
	scanRetry(splitLines(text), doc, managed);
	const out: Fallbacks = Object.create(null);
	for (const [key, v] of Object.entries(chainsOf(doc).chains))
		if (Array.isArray(v) && v.every((s) => typeof s === "string" && s !== ""))
			out[key] = [...(v as string[])];
	return out;
}

/** The `fallbackChains` map (null and absent read as no chains) and the other `retry` keys. */
function chainsOf(doc: Doc): { chains: Doc; other: Doc } {
	const retry: Doc = isMap(doc.retry) ? doc.retry : {};
	const { fallbackChains, ...other } = retry;
	return { chains: isMap(fallbackChains) ? fallbackChains : {}, other };
}

interface Line {
	body: string;
	eol: string;
}

function splitLines(text: string): Line[] {
	return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((l) => {
		const eol = l.endsWith("\r\n") ? "\r\n" : l.endsWith("\n") ? "\n" : "";
		return { body: l.slice(0, l.length - eol.length), eol };
	});
}

const fileEol = (lines: Line[]): string =>
	lines.find((l) => l.eol !== "")?.eol ?? "\n";

interface Entry {
	index: number;
	role: string;
	/** The line up to the value, and from the end of the value (trailing comment). */
	head: string;
	tail: string;
}

/** The block's one-line entries below the header, until a column-0 line ends the block. */
function scanEntries(
	lines: Line[],
	header: number,
): {
	entries: Entry[];
	indent: string;
} {
	const entries: Entry[] = [];
	let indent: string | null = null;
	for (let i = header + 1; i < lines.length; i++) {
		const body = (lines[i] as Line).body;
		if (skippable(body)) continue;
		if (!/^\s/.test(body)) break;
		const m = ENTRY.exec(body);
		if (m === null)
			throw new RolesLayoutError(
				`unsupported modelRoles entry on line ${i + 1} of config.yml`,
			);
		const [, ind, role, sep, , comment] = m as unknown as string[];
		if (indent !== null && ind !== indent)
			throw new RolesLayoutError(
				`modelRoles entries do not share one indent (line ${i + 1})`,
			);
		indent = ind as string;
		entries.push({
			index: i,
			role: role as string,
			head: `${ind}${role}:${sep}`,
			tail: comment ?? "",
		});
	}
	return { entries, indent: indent ?? "  " };
}

/** Locates the block; throws RolesLayoutError for every layout the spec does not support. */
function scan(text: string) {
	const lines = splitLines(text);
	const eol = fileEol(lines);
	const headers = lines.flatMap((l, i) =>
		l.body.startsWith("modelRoles:") ? [i] : [],
	);
	if (headers.length > 1)
		throw new RolesLayoutError("config.yml has more than one modelRoles key");
	if (headers.length === 0) {
		if ("modelRoles" in parse(text))
			throw new RolesLayoutError(
				"modelRoles is not a column-0 block in config.yml",
			);
		return { lines, eol, header: -1, indent: "  ", entries: [] as Entry[] };
	}
	const header = headers[0] as number;
	const h = lines[header] as Line;
	if (!HEADER.test(h.body))
		throw new RolesLayoutError(
			"modelRoles must be a block of one-line entries (no flow map or anchor)",
		);
	const { entries, indent } = scanEntries(lines, header);
	return {
		lines,
		eol: h.eol || eol,
		header,
		indent,
		entries,
	};
}

interface ChainKey {
	/** The key line, its content lines after it (the items of a managed key), its last content line. */
	index: number;
	body: number[];
	last: number;
	name: string;
	/** The key line up to and with the colon. */
	prefix: string;
	/** Managed keys: the trailing comment with its leading blanks (after `[]` for an empty list). */
	comment: string;
	empty: boolean;
	/** The parsed value: a list of nonempty strings, or null for `key:` without items. */
	value: unknown;
}

interface RetryScan {
	/** The `retry:` line, -1 when the file has none. */
	header: number;
	childIndent: string;
	/** The last content line of the `retry` block (blank and comment lines after it are not in it). */
	retryLast: number;
	/** The `fallbackChains:` line, -1 when `retry` has none. */
	chains: number;
	chainsLast: number;
	keyIndent: string | null;
	itemIndent: string | null;
	keys: ChainKey[];
	eol: string;
}

function chainKeyName(text: string): string {
	if (text.startsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
	if (!text.startsWith('"')) return text;
	try {
		return JSON.parse(text) as string;
	} catch {
		throw new RolesLayoutError(
			`unsupported fallbackChains key ${text} in config.yml`,
		);
	}
}

/** The `retry:` header line, -1 when the file has none; throws when the doc disagrees. */
function retryHeader(lines: Line[], doc: Doc): number {
	const headers = lines.flatMap((l, i) =>
		l.body.startsWith("retry:") ? [i] : [],
	);
	if (headers.length > 1)
		throw new RolesLayoutError("config.yml has more than one retry key");
	if (headers.length === 0) {
		if (Object.hasOwn(doc, "retry"))
			throw new RolesLayoutError("retry is not a column-0 block in config.yml");
	}
	return (headers[0] as number) ?? -1;
}

/** The retry block's child indent, last content line, and the `fallbackChains:` lines. */
function scanRetryBlock(
	lines: Line[],
	header: number,
): { childIndent: string; retryLast: number; found: number[] } {
	let ci: string | null = null;
	let retryLast = header;
	const found: number[] = [];
	for (let i = header + 1; i < lines.length; i++) {
		const body = (lines[i] as Line).body;
		if (skippable(body)) continue;
		if (!/^\s/.test(body)) break;
		retryLast = i;
		const ind = indentOf(body);
		ci ??= ind;
		if (ind === ci && body.slice(ind.length).startsWith("fallbackChains:"))
			found.push(i);
	}
	return { childIndent: ci ?? "  ", retryLast, found };
}

/** One `name:` key line under fallbackChains; throws for an unsupported key form. */
function newChainKey(i: number, ind: string, rest: string): ChainKey {
	const m = CHAIN_KEY.exec(rest);
	if (m === null)
		throw new RolesLayoutError(
			`unsupported fallbackChains key on line ${i + 1} of config.yml`,
		);
	const [, text, after] = m as unknown as [string, string, string];
	return {
		index: i,
		body: [],
		last: i,
		name: chainKeyName(text),
		prefix: `${ind}${text}:`,
		comment: after,
		empty: false,
		value: undefined,
	};
}

/** The fallbackChains block's keys; throws for every unsupported key layout. */
function scanChainsKeys(
	lines: Line[],
	fc: number,
	retryLast: number,
	childIndent: string,
): { keys: ChainKey[]; ki: string | null; chainsLast: number } {
	const keys: ChainKey[] = [];
	let ki: string | null = null;
	let chainsLast = fc;
	for (let i = fc + 1; i <= retryLast; i++) {
		const body = (lines[i] as Line).body;
		if (skippable(body)) continue;
		const ind = indentOf(body);
		if (ind.length <= childIndent.length) break;
		chainsLast = i;
		ki ??= ind;
		if (ind.length <= ki.length && ind !== ki)
			throw new RolesLayoutError(
				`fallbackChains keys do not share one indent (line ${i + 1})`,
			);
		const rest = body.slice(ind.length);
		if (ind !== ki || SEQ_ITEM.test(rest)) {
			const k = keys.at(-1);
			if (k === undefined)
				throw new RolesLayoutError(
					`retry.fallbackChains is not a map (line ${i + 1} of config.yml)`,
				);
			k.body.push(i);
			k.last = i;
			continue;
		}
		keys.push(newChainKey(i, ki, rest));
	}
	return { keys, ki, chainsLast };
}

/** The parsed keys must cover exactly the doc's fallbackChains entries; managed keys get their shape check. */
function checkChainsKeys(
	chains: Doc,
	keys: ChainKey[],
	lines: Line[],
	managed: ReadonlySet<string>,
): void {
	const names = keys.map((k) => k.name);
	if (
		new Set(names).size !== names.length ||
		names.length !== Object.keys(chains).length ||
		!names.every((n) => Object.hasOwn(chains, n))
	)
		throw new RolesLayoutError(
			"unsupported retry.fallbackChains layout in config.yml",
		);
	for (const k of keys) {
		if (!managed.has(k.name)) continue;
		checkManaged(k, lines, chains[k.name]);
	}
}

/** Validates the `fallbackChains:` line and its doc value; returns the chains doc. */
function chainsDoc(
	lines: Line[],
	fc: number,
	childIndent: string,
	value: unknown,
): Doc {
	if (
		!CHAINS.test((lines[fc] as Line).body.slice(childIndent.length)) ||
		!(value === null || isMap(value))
	)
		throw new RolesLayoutError(
			"retry.fallbackChains must be a block map in config.yml (no flow map or anchor)",
		);
	return (value ?? {}) as Doc;
}

/** The indent of the first block-list item under the keys; null when none has items. */
function chainItemIndent(lines: Line[], keys: ChainKey[]): string | null {
	const first = keys
		.map((k) => k.body[0])
		.find(
			(i) =>
				i !== undefined && SEQ_ITEM.test((lines[i] as Line).body.trimStart()),
		);
	return first === undefined ? null : indentOf((lines[first] as Line).body);
}

/**
 * Locates `retry` and `retry.fallbackChains`; throws RolesLayoutError for every layout of them or
 * of a managed key that the spec does not support. An unmanaged key can have any layout.
 */
function scanRetry(
	lines: Line[],
	doc: Doc,
	managed: ReadonlySet<string>,
): RetryScan {
	const eol = fileEol(lines);
	const header = retryHeader(lines, doc);
	const none: RetryScan = {
		header: -1,
		childIndent: "  ",
		retryLast: -1,
		chains: -1,
		chainsLast: -1,
		keyIndent: null,
		itemIndent: null,
		keys: [],
		eol,
	};
	if (header === -1) return none;
	const retry = doc.retry;
	if (
		!RETRY.test((lines[header] as Line).body) ||
		!(retry === null || isMap(retry))
	)
		throw new RolesLayoutError(
			"retry must be a block map in config.yml (no flow map or anchor)",
		);
	const { childIndent, retryLast, found } = scanRetryBlock(lines, header);
	const scanned = {
		...none,
		header,
		childIndent,
		retryLast,
		eol: (lines[header] as Line).eol || eol,
	};
	if (found.length > 1)
		throw new RolesLayoutError(
			"retry has more than one fallbackChains key in config.yml",
		);
	if (found.length === 0) {
		if (isMap(retry) && Object.hasOwn(retry, "fallbackChains"))
			throw new RolesLayoutError(
				"retry.fallbackChains is not a one-line key under retry in config.yml",
			);
		return scanned;
	}
	const fc = found[0] as number;
	const chains = chainsDoc(
		lines,
		fc,
		childIndent,
		isMap(retry) ? retry.fallbackChains : undefined,
	);
	const { keys, ki, chainsLast } = scanChainsKeys(
		lines,
		fc,
		retryLast,
		childIndent,
	);
	checkChainsKeys(chains, keys, lines, managed);
	return {
		...scanned,
		chains: fc,
		chainsLast,
		keyIndent: ki,
		itemIndent: chainItemIndent(lines, keys),
		keys,
		eol: (lines[fc] as Line).eol || scanned.eol,
	};
}

/** A managed key holds `key:` with one-line block list items, or `key: []`. */
function checkManaged(k: ChainKey, lines: Line[], value: unknown): void {
	const where = `retry.fallbackChains.${k.name} (line ${k.index + 1})`;
	const flow = /^[ \t]+\[\]([ \t]+#.*)?$/.exec(k.comment);
	if (flow !== null) {
		k.empty = true;
		k.comment = flow[1] ?? "";
	} else if (!/^([ \t]+(#.*)?)?$/.test(k.comment))
		throw new RolesLayoutError(
			`${where} must be a block list or [] (no flow list with entries or anchor)`,
		);
	if (k.empty && k.body.length > 0)
		throw new RolesLayoutError(`${where} must be one line when it is []`);
	for (const i of k.body)
		if (!ITEM.test((lines[i] as Line).body))
			throw new RolesLayoutError(
				`unsupported item of ${where} on line ${i + 1}`,
			);
	const ok = k.empty
		? Array.isArray(value) && value.length === 0
		: k.body.length === 0
			? value === null
			: Array.isArray(value) &&
				value.length === k.body.length &&
				value.every((s) => typeof s === "string" && s !== "");
	if (!ok)
		throw new RolesLayoutError(`${where} must be a list of model selectors`);
	k.value = value;
}

const scalar = (v: string): string =>
	PLAIN.test(v) && v.includes("/") ? v : JSON.stringify(v);

/** Line changes by original line index: a replacement (empty drops the line), lines after it. */
interface Changes {
	replace: Map<number, Line[]>;
	insert: Map<number, Line[]>;
}

function insertAfter(c: Changes, index: number, add: Line[]): void {
	if (add.length > 0)
		c.insert.set(index, [...(c.insert.get(index) ?? []), ...add]);
}

/** Applies the changes. A file without a final newline keeps its open end. */
function render(text: string, lines: Line[], c: Changes): string {
	const eol = fileEol(lines);
	const out: Line[] = [...(c.insert.get(-1) ?? [])];
	lines.forEach((l, i) => {
		out.push(...(c.replace.get(i) ?? [l]), ...(c.insert.get(i) ?? []));
	});
	const open = text !== "" && !text.endsWith("\n");
	return out
		.map((l, i) => l.body + (open && i === out.length - 1 ? "" : l.eol || eol))
		.join("");
}

/**
 * The text with `modelRoles` set to `next` and each managed chain set to `fallbacks`: unchanged
 * lines stay byte for byte. Managed chain keys are the file's current roles and the keys of
 * `next`; a managed key without an entry in `fallbacks` loses its chain. A new chain follows the
 * last content line of `fallbackChains`, so blank and comment lines after it stay with the key
 * that follows them. Checked by parsing both texts.
 */
export function editModelRoles(
	text: string,
	next: Record<string, string>,
	fallbacks: Fallbacks,
): string {
	const s = scan(text);
	const before = parse(text);
	const old = (before.modelRoles ?? {}) as Record<string, unknown>;
	const managed = new Set([...Object.keys(next), ...Object.keys(old)]);
	const r = scanRetry(s.lines, before, managed);
	const c: Changes = { replace: new Map(), insert: new Map() };
	for (const e of s.entries) {
		const v = Object.hasOwn(next, e.role) ? next[e.role] : undefined;
		if (v === undefined) c.replace.set(e.index, []);
		else if (old[e.role] !== v)
			c.replace.set(e.index, [
				{
					body: e.head + scalar(v) + e.tail,
					eol: (s.lines[e.index] as Line).eol,
				},
			]);
	}
	const known = new Set(s.entries.map((e) => e.role));
	const added = Object.entries(next)
		.filter(([role]) => !known.has(role))
		.map(([role, v]) => ({
			body: `${s.indent}${role}: ${scalar(v)}`,
			eol: s.eol,
		}));
	if (s.header === -1 && added.length > 0)
		added.unshift({ body: "modelRoles:", eol: s.eol });
	insertAfter(
		c,
		s.header === -1
			? s.lines.length - 1
			: (s.entries.at(-1)?.index ?? s.header),
		added,
	);
	editChains(c, s.lines, r, managed, fallbacks);
	const out = render(text, s.lines, c);
	const after = parse(out);
	const { modelRoles: got, retry: _r, ...rest } = after;
	const { modelRoles: _m, retry: _rb, ...restBefore } = before;
	if (!Bun.deepEquals(got, next) || !Bun.deepEquals(rest, restBefore))
		throw new RolesLayoutError(
			"the edited config.yml does not hold exactly the requested roles",
		);
	if (!sameChains(chainsOf(before), chainsOf(after), managed, fallbacks))
		throw new RolesLayoutError(
			"the edited config.yml does not hold exactly the requested fallback chains",
		);
	return out;
}

/** Rewrites one managed key's list to the requested chain; removes the key when unset. */
function editChainKey(
	c: Changes,
	lines: Line[],
	k: ChainKey,
	r: RetryScan,
	chain: string[] | undefined,
	blockItem: string,
): void {
	if (chain === undefined) {
		for (let i = k.index; i <= k.last; i++) c.replace.set(i, []);
		return;
	}
	if (Bun.deepEquals(k.value, chain)) return;
	const eol = (lines[k.index] as Line).eol;
	if (chain.length === 0) {
		c.replace.set(k.index, [{ body: `${k.prefix} []${k.comment}`, eol }]);
		for (const i of k.body) c.replace.set(i, []);
		return;
	}
	const firstItem = k.body[0];
	if (k.empty) c.replace.set(k.index, [{ body: k.prefix + k.comment, eol }]);
	if (firstItem === undefined) {
		insertAfter(c, k.index, items(r, blockItem, chain));
		return;
	}
	const indent = indentOf((lines[firstItem] as Line).body);
	c.replace.set(firstItem, items(r, indent, chain));
	for (const i of k.body.slice(1)) c.replace.set(i, []);
}

/** The list items of one chain at `indent`, using the block's eol. */
function items(r: RetryScan, indent: string, chain: string[]): Line[] {
	return chain.map((v) => ({ body: `${indent}- ${scalar(v)}`, eol: r.eol }));
}

/** The block that adds the managed keys missing from fallbackChains (empty when none). */
function missingKeysBlock(
	r: RetryScan,
	managed: ReadonlySet<string>,
	want: (k: string) => string[] | undefined,
	blockItem: string,
): Line[] {
	const present = new Set(r.keys.map((k) => k.name));
	const keyIndent = r.keyIndent ?? `${r.childIndent}  `;
	const block = [...managed].flatMap((name): Line[] => {
		const chain = want(name);
		if (present.has(name) || chain === undefined) return [];
		const plain = /^[A-Za-z0-9_.-]+$/.test(name);
		const head = `${keyIndent}${plain ? name : JSON.stringify(name)}:`;
		return chain.length === 0
			? [{ body: `${head} []`, eol: r.eol }]
			: [{ body: head, eol: r.eol }, ...items(r, blockItem, chain)];
	});
	if (block.length === 0) return [];
	if (r.chains === -1)
		block.unshift({ body: `${r.childIndent}fallbackChains:`, eol: r.eol });
	if (r.header === -1) block.unshift({ body: "retry:", eol: r.eol });
	return block;
}

function editChains(
	c: Changes,
	lines: Line[],
	r: RetryScan,
	managed: ReadonlySet<string>,
	fallbacks: Fallbacks,
): void {
	const want = (k: string) =>
		Object.hasOwn(fallbacks, k) ? fallbacks[k] : undefined;
	const blockItem = r.itemIndent ?? `${r.keyIndent ?? `${r.childIndent}  `}  `;
	for (const k of r.keys) {
		if (!managed.has(k.name)) continue;
		editChainKey(c, lines, k, r, want(k.name), blockItem);
	}
	const block = missingKeysBlock(r, managed, want, blockItem);
	if (block.length === 0) return;
	insertAfter(
		c,
		r.header === -1
			? lines.length - 1
			: r.chains === -1
				? r.retryLast
				: r.chainsLast,
		block,
	);
}

/** Managed keys hold exactly the requested chains; every other `retry` key keeps its value. */
function sameChains(
	before: { chains: Doc; other: Doc },
	after: { chains: Doc; other: Doc },
	managed: ReadonlySet<string>,
	fallbacks: Fallbacks,
): boolean {
	if (!Bun.deepEquals(after.other, before.other)) return false;
	const expected = (k: string): unknown => {
		const from = managed.has(k) ? fallbacks : before.chains;
		return Object.hasOwn(from, k) ? from[k] : undefined;
	};
	const names = new Set([
		...Object.keys(before.chains),
		...Object.keys(after.chains),
		...managed,
	]);
	return [...names].every((k) =>
		Object.hasOwn(after.chains, k)
			? expected(k) !== undefined &&
				Bun.deepEquals(after.chains[k], expected(k))
			: expected(k) === undefined,
	);
}

/** The message for a value that is not `<catalog selector>[:<level>]`, or null when it is. */
function selectorError(
	v: unknown,
	catalog: ReadonlySet<string>,
): string | null {
	if (typeof v !== "string" || v === "")
		return "the value must be a model selector";
	if (catalog.has(v)) return null;
	const [base, level] = splitLevel(v);
	if (level !== "" && catalog.has(base)) return null;
	const i = v.lastIndexOf(":");
	return i > 0 && catalog.has(v.slice(0, i))
		? `unknown thinking level (use one of ${THINKING_LEVELS.join(", ")})`
		: `unknown model ${base}`;
}

function chainError(
	role: string,
	chain: unknown,
	next: Record<string, unknown>,
	catalog: ReadonlySet<string>,
): string | null {
	if (!Object.hasOwn(next, role)) return "this role is not in roles";
	if (!Array.isArray(chain)) return "the fallbacks must be a list";
	for (const [i, v] of chain.entries()) {
		const err = selectorError(v, catalog);
		if (err !== null) return `fallback ${i + 1}: ${err}`;
		if (v === next[role]) return `fallback ${i + 1}: the role's own value`;
		const j = chain.indexOf(v);
		if (j < i) return `fallback ${i + 1}: a duplicate of fallback ${j + 1}`;
	}
	return null;
}

/** Presence-sensitive: an absent chain and an empty chain differ. */
function sameChain(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	role: string,
): boolean {
	const has = Object.hasOwn(a, role);
	return (
		has === Object.hasOwn(b, role) && (!has || Bun.deepEquals(a[role], b[role]))
	);
}

/** 400 body for a save that must not reach Alate, or null when it may. */
export function validateRoles(
	next: Record<string, unknown>,
	current: Record<string, string>,
	catalog: ReadonlySet<string>,
	fallbacks: Record<string, unknown>,
	currentFallbacks: Fallbacks,
): {
	error: string;
	fields: Record<string, string>;
	fallbackFields: Record<string, string>;
} | null {
	// Null prototype: a "__proto__" role must land as a field error, not vanish.
	const fields: Record<string, string> = Object.create(null);
	const fallbackFields: Record<string, string> = Object.create(null);
	for (const [role, v] of Object.entries(next)) {
		// Names already in the file stay editable; only a new name must match.
		const err =
			!Object.hasOwn(current, role) && !ROLE_NAME.test(role)
				? "a role name starts with a letter and holds only letters, digits, _ and - (max 64)"
				: selectorError(v, catalog);
		if (err !== null) fields[role] = err;
	}
	if (!isMap(fallbacks))
		return { error: "fallbacks must be an object", fields, fallbackFields };
	for (const [role, chain] of Object.entries(fallbacks)) {
		const err = chainError(role, chain, next, catalog);
		if (err !== null) fallbackFields[role] = err;
	}
	if (Object.keys(fields).length > 0 || Object.keys(fallbackFields).length > 0)
		return { error: "some model roles are not valid", fields, fallbackFields };
	if (Object.keys(next).length === 0)
		return {
			error: "roles must hold at least one role",
			fields,
			fallbackFields,
		};
	const same =
		Object.keys(next).length === Object.keys(current).length &&
		Object.entries(next).every(
			([r, v]) => current[r] === v && sameChain(fallbacks, currentFallbacks, r),
		);
	return same ? { error: "nothing to save", fields, fallbackFields } : null;
}

const MAX_MESSAGE = 500;

/** The subject for exactly one changed role with no removals. */
function singleChangeMessage(
	current: Record<string, string>,
	next: Record<string, string>,
	nextFallbacks: Fallbacks,
	role: string,
): string {
	const chain = Object.hasOwn(nextFallbacks, role)
		? nextFallbacks[role]
		: undefined;
	if (current[role] !== next[role])
		return `chore: set the ${role} model role to ${next[role]}`;
	if (chain === undefined)
		return `chore: remove the ${role} model role fallbacks`;
	return `chore: set the ${role} model role fallbacks to ${chain.length > 0 ? chain.join(", ") : "none"}`;
}

/** The subject for several changes: as many names as fit, then an ellipsis. */
function multiChangeMessage(names: string[]): string {
	const fit = (n: string[]) => `chore: update the ${n.join(", ")} model roles`;
	let k = names.length;
	while (k > 0 && fit(names.slice(0, k)).length > MAX_MESSAGE) k--;
	if (k === names.length) return fit(names);
	return fit([...names.slice(0, Math.max(k - 1, 0)), "…"]);
}

/** Conventional Commit subject for the save, at most 500 characters. */
export function commitMessage(
	current: Record<string, string>,
	next: Record<string, string>,
	currentFallbacks: Fallbacks,
	nextFallbacks: Fallbacks,
): string {
	const changed = Object.keys(next).filter(
		(r) =>
			current[r] !== next[r] || !sameChain(currentFallbacks, nextFallbacks, r),
	);
	const removed = Object.keys(current).filter((r) => !Object.hasOwn(next, r));
	let msg: string;
	const [role] = changed as [string];
	if (changed.length === 0 && removed.length === 1)
		msg = `chore: remove the ${removed[0]} model role`;
	else if (changed.length === 1 && removed.length === 0)
		msg = singleChangeMessage(current, next, nextFallbacks, role);
	else {
		msg = multiChangeMessage([...changed, ...removed]);
	}
	return msg.length > MAX_MESSAGE ? `${msg.slice(0, MAX_MESSAGE - 1)}…` : msg;
}

// The Settings model roles editor: reads and edits the `modelRoles` block of the data repo's
// user/omp/agent/config.yml text, byte for byte outside the changed lines
// (docs/specs/model-roles-editor.md "Text edit").
import { splitLevel, THINKING_LEVELS } from "./ui/models.ts";

/** A config.yml the editor cannot edit safely; the route answers 422. */
export class RolesLayoutError extends Error {}

const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HEADER = /^modelRoles:[ \t]*(#.*)?$/;
const ENTRY =
	/^([ \t]+)([A-Za-z0-9_.-]+):([ \t]+)('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"&*!|>{}[\],#%@`?:][^\s#]*)([ \t]+#.*)?$/;
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/;

type Doc = Record<string, unknown>;

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
	if (typeof doc !== "object" || Array.isArray(doc))
		throw new RolesLayoutError("config.yml is not a YAML map");
	return doc as Doc;
}

/** The `modelRoles` map in file order: nonempty string values only. Throws RolesLayoutError
 *  for a file the editor cannot edit, so a read never offers an unsaveable form. */
export function readRoles(text: string): Record<string, string> {
	scan(text);
	const roles = parse(text).modelRoles;
	const out: Record<string, string> = {};
	if (typeof roles === "object" && roles !== null)
		for (const [name, v] of Object.entries(roles))
			if (typeof v === "string" && v !== "") out[name] = v;
	return out;
}

interface Line {
	body: string;
	eol: string;
}

interface Entry {
	index: number;
	role: string;
	/** The line up to the value, and from the end of the value (trailing comment). */
	head: string;
	tail: string;
}

/** Locates the block; throws RolesLayoutError for every layout the spec does not support. */
function scan(text: string) {
	const lines: Line[] = (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((l) => {
		const eol = l.endsWith("\r\n") ? "\r\n" : l.endsWith("\n") ? "\n" : "";
		return { body: l.slice(0, l.length - eol.length), eol };
	});
	const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
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
	const entries: Entry[] = [];
	let indent: string | null = null;
	for (let i = header + 1; i < lines.length; i++) {
		const body = (lines[i] as Line).body;
		if (/^\s*$/.test(body) || /^\s*#/.test(body)) continue;
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
	return {
		lines,
		eol: h.eol || eol,
		header,
		indent: indent ?? "  ",
		entries,
	};
}

const scalar = (v: string): string =>
	PLAIN.test(v) && v.includes("/") ? v : JSON.stringify(v);

/**
 * The text with `modelRoles` set to `next`: unchanged entry lines stay byte for byte, removed
 * roles lose their line, new roles follow the last entry. Checked by parsing both texts.
 */
export function editModelRoles(
	text: string,
	next: Record<string, string>,
): string {
	const s = scan(text);
	const before = parse(text);
	const old = (before.modelRoles ?? {}) as Record<string, unknown>;
	const lines = s.lines.map((l) => ({ ...l }));
	const drop = new Set<number>();
	for (const e of s.entries) {
		const v = Object.hasOwn(next, e.role) ? next[e.role] : undefined;
		if (v === undefined) drop.add(e.index);
		else if (old[e.role] !== v)
			(lines[e.index] as Line).body = e.head + scalar(v) + e.tail;
	}
	const known = new Set(s.entries.map((e) => e.role));
	const added = Object.entries(next)
		.filter(([role]) => !known.has(role))
		.map(([role, v]) => ({
			body: `${s.indent}${role}: ${scalar(v)}`,
			eol: s.eol,
		}));
	if (s.header === -1) added.unshift({ body: "modelRoles:", eol: s.eol });
	const at =
		s.header === -1 ? lines.length - 1 : (s.entries.at(-1)?.index ?? s.header);
	// Inserting after the last line: that line gains the line end, the new last line keeps
	// the file's (missing) final newline.
	const prev = lines[at];
	if (added.length > 0 && prev !== undefined && prev.eol === "") {
		prev.eol = s.eol;
		(added.at(-1) as Line).eol = "";
	}
	lines.splice(at + 1, 0, ...added);
	const out = lines
		.filter((_, i) => !drop.has(i) || i > at)
		.map((l) => l.body + l.eol)
		.join("");
	const { modelRoles: got, ...rest } = parse(out);
	const { modelRoles: _, ...restBefore } = before;
	if (!Bun.deepEquals(got, next) || !Bun.deepEquals(rest, restBefore))
		throw new RolesLayoutError(
			"the edited config.yml does not hold exactly the requested roles",
		);
	return out;
}

/** 400 body for a save that must not reach Alate, or null when it may. */
export function validateRoles(
	next: Record<string, unknown>,
	current: Record<string, string>,
	catalog: ReadonlySet<string>,
): { error: string; fields: Record<string, string> } | null {
	// Null prototype: a "__proto__" role must land as a field error, not vanish.
	const fields: Record<string, string> = Object.create(null);
	for (const [role, v] of Object.entries(next)) {
		// Names already in the file stay editable; only a new name must match.
		if (!Object.hasOwn(current, role) && !ROLE_NAME.test(role))
			fields[role] =
				"a role name starts with a letter and holds only letters, digits, _ and - (max 64)";
		else if (typeof v !== "string" || v === "")
			fields[role] = "the value must be a model selector";
		else if (current[role] !== v && !catalog.has(v)) {
			const [base, level] = splitLevel(v);
			const i = v.lastIndexOf(":");
			if (level !== "" && catalog.has(base)) continue;
			fields[role] =
				i > 0 && catalog.has(v.slice(0, i))
					? `unknown thinking level (use one of ${THINKING_LEVELS.join(", ")})`
					: `unknown model ${base}`;
		}
	}
	if (Object.keys(fields).length > 0)
		return { error: "some model roles are not valid", fields };
	if (Object.keys(next).length === 0)
		return { error: "roles must hold at least one role", fields };
	const same =
		Object.keys(next).length === Object.keys(current).length &&
		Object.entries(next).every(([r, v]) => current[r] === v);
	return same ? { error: "nothing to save", fields } : null;
}

const MAX_MESSAGE = 500;

/** Conventional Commit subject for the save, at most 500 characters. */
export function commitMessage(
	current: Record<string, string>,
	next: Record<string, string>,
): string {
	const set = Object.keys(next).filter((r) => current[r] !== next[r]);
	const removed = Object.keys(current).filter((r) => !Object.hasOwn(next, r));
	let msg: string;
	if (set.length === 1 && removed.length === 0)
		msg = `chore: set the ${set[0]} model role to ${next[set[0] as string]}`;
	else if (set.length === 0 && removed.length === 1)
		msg = `chore: remove the ${removed[0]} model role`;
	else {
		const names = [...set, ...removed];
		const fit = (n: string[]) =>
			`chore: update the ${n.join(", ")} model roles`;
		let k = names.length;
		while (k > 0 && fit(names.slice(0, k)).length > MAX_MESSAGE) k--;
		msg =
			k === names.length
				? fit(names)
				: fit([...names.slice(0, Math.max(k - 1, 0)), "…"]);
	}
	return msg.length > MAX_MESSAGE ? `${msg.slice(0, MAX_MESSAGE - 1)}…` : msg;
}

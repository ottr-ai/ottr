// Pure readers of omp's JSONL session transcripts: file lookup, context-window
// snapshot, and first-title recovery. No store state; callers pass the project's
// sessions dir.

import type { Stats } from "node:fs";
import {
	closeSync,
	fstatSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { isSizeRefusal, readBoundedFile, readRegular } from "./confine.ts";

import type { SessionContext } from "./types.ts";

/** `<ts>_<sessionId>.jsonl` in the sessions dir, or null when omp hasn't written it (yet). */
export function sessionFile(
	dir: string,
	sessionId: string | null,
): string | null {
	if (sessionId === null) return null; // skip the listing; no omp file ends in `_null.jsonl`
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null; // missing sessions dir
	}
	const f = names.find((n) => n.endsWith(`_${sessionId}.jsonl`));
	return f === undefined ? null : join(dir, f);
}

/**
 * The model the saved session runs: the `model` of its last default-role `model_change` record
 * (omp writes one at the start and on each switch, as `provider/id`). Records with a set
 * non-default `role`, or with `resolvedModelIsFallback: true`, name a model omp does not restore
 * on resume, so they do not count. Null when the session file is missing, unreadable, or names
 * no model.
 */
export function sessionModel(
	dir: string,
	sessionId: string | null,
): string | null {
	const file = sessionFile(dir, sessionId);
	if (file === null) return null;
	let text: string;
	try {
		text = readRegular(file, TRANSCRIPT_MAX_BYTES).toString("utf8");
	} catch {
		return null; // unreadable or over-cap file -> no model
	}
	let model: string | null = null;
	for (const line of text.split("\n")) {
		const m = modelChangeLine(line);
		if (m !== null) model = m;
	}
	return model;
}

/** The restored model one `model_change` line names, or null when the line names none. */
function modelChangeLine(line: string): string | null {
	if (!line.startsWith('{"type":"model_change"')) return null;
	try {
		const rec: unknown = JSON.parse(line);
		if (typeof rec !== "object" || rec === null || !("model" in rec))
			return null;
		const r = rec as { role?: unknown; resolvedModelIsFallback?: unknown };
		// Fallback and temporary switches name a model omp will not restore on resume.
		if (r.role !== undefined && r.role !== "default") return null;
		if (r.resolvedModelIsFallback === true) return null;
		return typeof rec.model === "string" && rec.model.trim() !== ""
			? rec.model.trim()
			: null;
	} catch {
		return null;
	}
}

/**
 * A session message's user text: the content string, or the text parts of a content
 * array. omp writes both shapes; other shapes carry no matchable text.
 */
function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const p = part as { type?: unknown; text?: unknown };
			return p.type === "text" && typeof p.text === "string" ? p.text : "";
		})
		.join("\n");
}

/**
 * Whether a user message of the session transcript holds `prompt` verbatim: the guard for
 * re-sending an interrupted turn's prompt on resume. False when the session file is missing
 * or unreadable — such a turn starts a fresh session whose start re-sends the card's
 * instructions, so the caller must not prepend them a second time.
 */
export async function sessionHoldsPrompt(
	dir: string,
	sessionId: string | null,
	prompt: string,
): Promise<boolean> {
	const file = sessionFile(dir, sessionId);
	if (file === null) return false;
	let text: string;
	try {
		// Async: the resume path runs on the request path, and a transcript can be large.
		text = (await readBoundedFile(file, TRANSCRIPT_MAX_BYTES)).toString("utf8");
	} catch {
		return false; // unreadable, a symlink, or over-cap -> no re-send guard
	}
	for (const line of text.split("\n")) {
		if (!line.includes('"user"')) continue; // cheap pre-filter; only user lines can match
		let rec: { message?: { role?: unknown; content?: unknown } };
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		const m = rec.message;
		if (typeof m !== "object" || m === null || m.role !== "user") continue;
		if (userText(m.content).includes(prompt)) return true;
	}
	return false;
}

/**
 * Context-window reading from the task's omp session transcript, or null when there is no
 * session, the file is missing/unreadable, or no assistant message carries a usable
 * contextSnapshot. Reads only the file tail; sync is fine (request-path callers).
 */
export function sessionContext(
	dir: string,
	sessionId: string | null,
): SessionContext | null {
	const file = sessionFile(dir, sessionId);
	if (file === null) return null;
	const lines = tailLines(file);
	if (lines === null) return null;
	for (let i = lines.length - 1; i >= 0; i--) {
		const ctx = contextFromLine(lines[i] ?? "");
		if (ctx !== null) return ctx;
	}
	return null;
}

/** The file's last ≤1 MiB as lines, dropping a partial first line; null when unreadable. */
function tailLines(file: string): string[] | null {
	try {
		const fd = openSync(file, "r");
		try {
			const size = fstatSync(fd).size;
			// ponytail: 1 MiB tail read; a last assistant message line longer than the window is reported as no data. Scan the whole file if that ever matters.
			const len = Math.min(size, 1024 * 1024);
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, size - len);
			const lines = buf.toString("utf8").split("\n");
			if (len < size) lines.shift(); // first line may be partial
			return lines;
		} finally {
			closeSync(fd);
		}
	} catch {
		return null; // unreadable file -> no data
	}
}

/** The context snapshot one transcript message line carries, or null when it carries none. */
function contextFromLine(line: string): SessionContext | null {
	if (!line.startsWith('{"type":"mess')) return null;
	try {
		const parsed = JSON.parse(line) as {
			message?: {
				role?: unknown;
				provider?: unknown;
				model?: unknown;
				completedAt?: unknown;
				timestamp?: unknown;
				contextSnapshot?: {
					promptTokens?: unknown;
					compactionEpoch?: unknown;
				};
			};
		};
		const m = parsed.message;
		const tokens = m?.contextSnapshot?.promptTokens;
		if (m?.role !== "assistant" || typeof tokens !== "number") return null;
		const provider = messageField(m.provider);
		const model = messageField(m.model);
		const t = Date.parse(
			typeof m.completedAt === "string"
				? m.completedAt
				: typeof m.timestamp === "string"
					? m.timestamp
					: "",
		);
		return {
			promptTokens: tokens,
			model: modelSelector(provider, model),
			compactions:
				typeof m.contextSnapshot?.compactionEpoch === "number"
					? m.contextSnapshot.compactionEpoch
					: 0,
			at: Number.isFinite(t) ? t : 0,
		};
	} catch {
		return null;
	}
}

/** A message field that holds a usable string, else null. */
function messageField(v: unknown): string | null {
	return typeof v === "string" && v !== "" ? v : null;
}

/** The `provider/model` selector the message names, or whichever half exists. */
function modelSelector(
	provider: string | null,
	model: string | null,
): string | null {
	return provider !== null && model !== null
		? `${provider}/${model}`
		: (provider ?? model);
}

/** The largest transcript file the board reads whole; larger files stay unread. */
export const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
/** The most subagent transcripts read for one session; beyond it the rest stay unread.
 *  Generous on purpose: legit fan-out spans many waves, and the byte budget below stays
 *  the memory bound. */
export const TRANSCRIPT_MAX_SUB_FILES = 200;
/** The total byte budget for one session's subagent transcripts. */
export const TRANSCRIPT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** The full transcript of one omp session: the main session text plus its subagent files.
 *  `complete` is false when a subagent source exists but could not be read, so a sum over
 *  these texts would miss usage. */
export interface TranscriptTexts {
	sessionText: string | null;
	subagentTexts: string[];
	complete: boolean;
	/** True when a size or count cap refused part of the transcript, so usage is unknown. */
	oversize: boolean;
}

/**
 * The omp transcript of one session: the `<ts>_<sessionId>.jsonl` file plus every
 * subagent file in its sibling `<ts>_<sessionId>/` folder. Reads never throw (R1): a
 * missing main file gives null, an absent subagent folder gives [], and any other
 * subagent read failure sets `complete` to false. Every read opens once with O_NOFOLLOW,
 * refuses non-regular and oversize files, and reads into a bounded buffer, so a symlink
 * or a file grown after the size check cannot get past the caps. An over-cap file, a
 * symlinked file, an over-cap subagent count, or a subagent set over its byte budget
 * sets `oversize` and keeps `complete` false. Async: whole transcripts are the largest
 * reads on the board, so they must never block the request path.
 */
export async function readTranscript(
	dir: string,
	sessionId: string | null,
): Promise<TranscriptTexts> {
	const file = sessionFile(dir, sessionId);
	if (file === null)
		return {
			sessionText: null,
			subagentTexts: [],
			complete: true,
			oversize: false,
		};
	const refuse = {
		sessionText: null,
		subagentTexts: [],
		complete: false,
	};
	let sessionText: string | null;
	try {
		const buf = await readBoundedFile(file, TRANSCRIPT_MAX_BYTES);
		sessionText = buf.toString("utf8");
	} catch (err) {
		return { ...refuse, oversize: isSizeRefusal(err) };
	}
	const subagentTexts: string[] = [];
	const subDir = file.slice(0, -".jsonl".length);
	let names: string[];
	try {
		names = (await readdir(subDir)).filter((n) => n.endsWith(".jsonl"));
	} catch (err) {
		// Only a folder that does not exist means "no subagents"; any other failure hides files.
		const absent =
			err instanceof Error && "code" in err && err.code === "ENOENT";
		return { sessionText, subagentTexts, complete: absent, oversize: false };
	}
	if (names.length > TRANSCRIPT_MAX_SUB_FILES)
		return { sessionText, subagentTexts, complete: false, oversize: true };
	let complete = true;
	let oversize = false;
	let total = 0;
	for (const name of names) {
		let buf: Buffer;
		try {
			buf = await readBoundedFile(join(subDir, name), TRANSCRIPT_MAX_BYTES);
		} catch (err) {
			if (isSizeRefusal(err)) {
				complete = false; // over a cap: this subagent and the rest stay unread
				oversize = true;
				break;
			}
			complete = false; // unreadable subagent transcript: its usage is unknown
			continue;
		}
		// Budget on the bytes actually read (never a stat size); the per-file cap
		// bounds the overshoot to one file.
		if (total + buf.length > TRANSCRIPT_MAX_TOTAL_BYTES) {
			complete = false;
			oversize = true;
			break;
		}
		subagentTexts.push(buf.toString("utf8"));
		total += buf.length;
	}
	return { sessionText, subagentTexts, complete, oversize };
}

/**
 * omp 18.13.x heads its session titles with a small card: an icon or emoji, then a short
 * upper-case tag and a colon (`🩻 SKELE: Add loading skeletons …`). The tag is the titler's
 * category, not the task's name, so the whole head is stripped on read. The icon is
 * required: a title that starts with an upper-case tag and a colon but carries no icon is a
 * plain title ("CI: fix flaky test") and keeps its tag. Without the tag-and-colon head
 * nothing is stripped, not even a lone leading icon.
 */
const CARD_TITLE_PREFIX =
	/^\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]?\s*[A-Z0-9]{2,8}:\s/u;

/**
 * Strips the Markdown a titler model echoes into a card title: leading heading marks and
 * emphasis runs at the string edges (`**bold**`, `__ul__`, `*em*`, `` `code` ``), plus omp's
 * card prefix. Marks in the middle stay: `_` and `*` are real in identifiers like
 * `__init__` or `*args`, and a board title is prose, so only wrapped noise needs removing.
 */
export function cleanTitle(raw: string): string {
	return raw
		.replace(/^\s*#+\s*/, "")
		.replace(/^[*_`]+/, "")
		.replace(/[*_`]+$/, "")
		.replace(CARD_TITLE_PREFIX, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Reply heads that mark a model refusal instead of a title (OTTR-538): the titler answered
 * the prompt's content — usually a link — rather than naming the request. Curly apostrophes
 * normalize to straight ones before matching. */
const TITLE_REFUSAL_HEADS = [
	"i can't",
	"i cannot",
	"i can not",
	"i couldn't",
	"i could not",
	"i don't",
	"i do not",
	"i'm unable",
	"i am unable",
	"i'm sorry",
	"i am sorry",
	"sorry",
];

/** Reply heads that name the handoff-reading step instead of the work (OTTR-516, OTTR-570). */
const TITLE_HANDOFF_HEADS = ["read the handoff", "read handoff"];

/** Why a cleaned titler reply is not a title, or null when it is one: at most 8 words, and
 * not a first-person refusal, a file path, or a handoff-reading step. A rejected reply counts
 * as a failure, so the scheduled retry and the run's rename stay the fallback instead of the
 * store freezing a sentence into session_title (nameTask keeps only the first write). The
 * same filter gates a rename's rise to work title (OTTR-912). */
export function titleProblem(title: string): string | null {
	const lower = title.toLowerCase().replace(/[\u2019\u2018]/g, "'");
	if (TITLE_REFUSAL_HEADS.some((head) => lower.startsWith(head)))
		return "refusal reply";
	// OTTR-516: a title that carries a file path names the instruction, not the work.
	if (lower.includes("@/") || lower.includes("/data/") || lower.includes(".md"))
		return "names a file path";
	if (TITLE_HANDOFF_HEADS.some((head) => lower.startsWith(head)))
		return "names the handoff step";
	return title.split(/\s+/).filter(Boolean).length > 8 ? "over 8 words" : null;
}

/** omp's per-file pieces of firstSessionTitle: the latest title from line 1, and the first title_change record. */
function latestTitle(file: string): string | null {
	try {
		const fd = openSync(file, "r");
		try {
			// ponytail: 4 KiB first-line read; omp pads line 1 to a fixed width well under this.
			const buf = Buffer.alloc(4096);
			const line =
				buf
					.toString("utf8", 0, readSync(fd, buf, 0, 4096, 0))
					.split("\n", 1)[0] ?? "";
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || !("title" in parsed))
				return null;
			const title = parsed.title;
			return typeof title === "string" && title.trim() !== "" ? title : null;
		} finally {
			closeSync(fd);
		}
	} catch {
		return null; // unreadable file -> no title
	}
}

/**
 * The first title omp gave a session. Line 1 holds only the latest; every change is also
 * appended as a `title_change` record, and a later turn (merge, resume) re-titles the session.
 * ponytail: the scan is cached per size+mtime inside topTitleChanges (OTTR-1027), so an
 * unchanged transcript costs one stat per call. An earlier mtime+size cache was removed as
 * dead weight because its hit path could never fire; the draft-title branch (OTTR-912)
 * now rescans on every state build until a valid rename lands, so the hit path is live.
 */
export function firstSessionTitle(
	dir: string,
	sessionId: string | null,
): string | null {
	if (sessionId === null) return null;
	const file = sessionFile(dir, sessionId);
	if (file === null) return null;
	const latest = latestTitle(file);
	// First top-level `title_change`, else the line-1 latest; null when the file has neither.
	return latest === null ? null : (topTitleChanges(file)[0] ?? latest);
}

/** Completed top-title scans, keyed by file, size, and mtimeMs (OTTR-1027): every board
 * state build resolves the stored titles, and an open card with a draft title rescans its
 * transcript until a valid rename lands, so each unchanged transcript is read and parsed
 * once. Transcripts are append-only, so the newest key is the warm one; the cap bounds the
 * map across projects and dead sessions. */
const titleScanCache = new Map<string, string[]>();
const TITLE_SCAN_CACHE_MAX = 64;

/** The file's top-level `title_change` titles, in order; empty when it has none or cannot be read. */
function topTitleChanges(file: string): string[] {
	// Stat before the read: an append that lands mid-read moves size or mtime, so the
	// next call misses the cache instead of reusing a truncated scan.
	let stat: Stats;
	try {
		stat = statSync(file);
	} catch {
		return []; // vanished between the listing and here -> no titles
	}
	const key = `${file}\u0000${stat.size}\u0000${stat.mtimeMs}`;
	const cached = titleScanCache.get(key);
	if (cached !== undefined) return cached;
	let text: string;
	try {
		text = readRegular(file, TRANSCRIPT_MAX_BYTES).toString("utf8");
	} catch {
		return []; // unreadable or over-cap -> no titles; uncached, a later state may read
	}
	const titles: string[] = [];
	const needle = '"type":"title_change"';
	for (const line of text.split("\n")) {
		// The needle holds no newline, so per-line matching sees the same occurrences as a
		// whole-text scan; each needle-holding line is parsed once, not once per occurrence
		// (a needle-dense line used to reparse its whole length for every hit — quadratic).
		if (!line.includes(needle)) continue;
		try {
			// The needle can also sit in another record's nested data; only a top-level title_change counts.
			const rec = JSON.parse(line) as { type?: unknown; title?: unknown };
			if (
				rec.type === "title_change" &&
				typeof rec.title === "string" &&
				rec.title.trim() !== ""
			)
				titles.push(rec.title);
		} catch {
			// not a whole record line; keep looking
		}
	}
	if (titleScanCache.size >= TITLE_SCAN_CACHE_MAX) {
		const oldest = titleScanCache.keys().next().value;
		if (oldest !== undefined) titleScanCache.delete(oldest);
	}
	titleScanCache.set(key, titles);
	return titles;
}

/**
 * The run agent's first valid rename (OTTR-912): the first top-level `title_change` whose
 * cleaned title differs from the card's current title and passes the same filter the draft
 * title passes (`titleProblem`). Failing records are skipped, not blocking. The comparison
 * runs on `cleanTitle` output of both sides, so a transcript echo of the stored title never
 * counts as a rename. Null when the session is missing or has no such record.
 */
export function firstWorkTitle(
	dir: string,
	sessionId: string | null,
	current: string,
): string | null {
	const file = sessionFile(dir, sessionId);
	if (file === null) return null;
	for (const raw of topTitleChanges(file)) {
		const title = cleanTitle(raw);
		if (title === "" || title === current) continue;
		if (titleProblem(title) !== null) continue;
		return title;
	}
	return null;
}

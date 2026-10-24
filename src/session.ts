// Pure readers of omp's JSONL session transcripts: file lookup, context-window
// snapshot, and first-title recovery. No store state; callers pass the project's
// sessions dir.
import {
	closeSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
} from "node:fs";
import { join } from "node:path";

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
export function sessionHoldsPrompt(
	dir: string,
	sessionId: string | null,
	prompt: string,
): boolean {
	const file = sessionFile(dir, sessionId);
	if (file === null) return false;
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return false;
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
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i] ?? "";
				if (!line.startsWith('{"type":"mess')) continue;
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
					if (m?.role !== "assistant" || typeof tokens !== "number") continue;
					const provider =
						typeof m.provider === "string" && m.provider !== ""
							? m.provider
							: null;
					const model =
						typeof m.model === "string" && m.model !== "" ? m.model : null;
					const t = Date.parse(
						typeof m.completedAt === "string"
							? m.completedAt
							: typeof m.timestamp === "string"
								? m.timestamp
								: "",
					);
					return {
						promptTokens: tokens,
						model:
							provider !== null && model !== null
								? `${provider}/${model}`
								: (provider ?? model),
						compactions:
							typeof m.contextSnapshot?.compactionEpoch === "number"
								? m.contextSnapshot.compactionEpoch
								: 0,
						at: Number.isFinite(t) ? t : 0,
					};
				} catch {}
			}
			return null;
		} finally {
			closeSync(fd);
		}
	} catch {
		return null; // unreadable file -> no data
	}
}

/** The full transcript of one omp session: the main session text plus its subagent files.
 *  `complete` is false when a subagent source exists but could not be read, so a sum over
 *  these texts would miss usage. */
export interface TranscriptTexts {
	sessionText: string | null;
	subagentTexts: string[];
	complete: boolean;
}

/**
 * The omp transcript of one session: the `<ts>_<sessionId>.jsonl` file plus every
 * subagent file in its sibling `<ts>_<sessionId>/` folder. Reads never throw (R1): a
 * missing main file gives null, an absent subagent folder gives [], and any other
 * subagent read failure sets `complete` to false.
 */
export function readTranscript(
	dir: string,
	sessionId: string | null,
): TranscriptTexts {
	const file = sessionFile(dir, sessionId);
	if (file === null)
		return { sessionText: null, subagentTexts: [], complete: true };
	let sessionText: string | null = null;
	try {
		sessionText = readFileSync(file, "utf8");
	} catch {
		return { sessionText: null, subagentTexts: [], complete: false };
	}
	const subagentTexts: string[] = [];
	const subDir = file.slice(0, -".jsonl".length);
	let names: string[];
	try {
		names = readdirSync(subDir);
	} catch (err) {
		// Only a folder that does not exist means "no subagents"; any other failure hides files.
		const absent =
			err instanceof Error && "code" in err && err.code === "ENOENT";
		return { sessionText, subagentTexts, complete: absent };
	}
	let complete = true;
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			subagentTexts.push(readFileSync(join(subDir, name), "utf8"));
		} catch {
			complete = false; // unreadable subagent transcript: its usage is unknown
		}
	}
	return { sessionText, subagentTexts, complete };
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
 * ponytail: the whole file is rescanned on each call (state polls every 2 s); a cache keyed
 * by mtime+size was removed as dead weight — its hit path could never fire before the first
 * session_title write, which freezes the title in the DB.
 */
export function firstSessionTitle(
	dir: string,
	sessionId: string | null,
): string | null {
	if (sessionId === null) return null;
	const file = sessionFile(dir, sessionId);
	if (file === null) return null;
	const latest = latestTitle(file);
	return latest === null ? null : (firstTitleChange(file) ?? latest);
}

/** First top-level `title_change` record in the file; null when it has none or cannot be read. */
function firstTitleChange(file: string): string | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const needle = '"type":"title_change"';
	for (
		let at = text.indexOf(needle);
		at >= 0;
		at = text.indexOf(needle, at + 1)
	) {
		const end = text.indexOf("\n", at);
		try {
			// The needle can also sit in another record's nested data; only a top-level title_change counts.
			const rec = JSON.parse(
				text.slice(text.lastIndexOf("\n", at) + 1, end < 0 ? text.length : end),
			) as { type?: unknown; title?: unknown };
			if (
				rec.type === "title_change" &&
				typeof rec.title === "string" &&
				rec.title.trim() !== ""
			)
				return rec.title;
		} catch {
			// not a whole record line; keep looking
		}
	}
	return null;
}

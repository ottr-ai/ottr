import { PROPOSED_REASON_PREFIX } from "./prompts.ts";
import type { TranscriptTexts } from "./session.ts";
import type { Task, Turn } from "./types.ts";

/** Facts the retro card's handoff carries. Pure data: no tool output text, only
 * names, counts, isError flags, seconds, cost/token numbers and the agent's own
 * intent strings. Turn input text is cut at 300 chars. */
export interface RetroFacts {
	turns: {
		kind: string;
		outcome: string | null;
		model: string | null;
		seconds: number | null;
		error: string | null;
		/** Reply/steer text the user sent with the turn, cut at 300 chars; null for prompt-started turns. */
		input: string | null;
	}[];
	needsYouEpisodes: number;
	/** The last `supervisor: CI` line of the card log, or null when the log has none. */
	ciVerdict: string | null;
	/** Failed CI: the last CI line says "CI failed". */
	ciFailed: boolean;
	tools: { name: string; calls: number; errors: number; seconds: number }[];
	/** The 5 slowest tool calls, main session and subagents together. */
	slowest: { tool: string; intent: string; seconds: number }[];
	continuations: number;
	/** Extra transcript sessions in the `<ts>_<id>/` folder. */
	subagents: { count: number; cost: number; costShare: number | null };
	cost: {
		total: number;
		byModel: Record<string, number>;
		tokens: number;
		cacheRead: number;
		/** cacheRead / total tokens, or null when no tokens. */
		cacheReadShare: number | null;
	};
	openProposals: { id: string; title: string }[];
	declinedProposals: { id: string; title: string }[];
	/** "Lessons queued" sections of the last 20 retro reports of the project. */
	lessons: string[];
}

const INPUT_CUT = 300;
const SLOWEST_KEEP = 5;

interface Usage {
	model: string;
	/** Record timestamp in epoch ms; NaN when the record carries no parseable one. */
	timestamp: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface ToolStat {
	calls: number;
	errors: number;
	seconds: number;
}

interface SlowCall {
	tool: string;
	intent: string;
	seconds: number;
}

interface ParsedSession {
	usage: Usage[];
	tools: Record<string, ToolStat>;
	slow: SlowCall[];
	continuations: number;
}

function ts(v: unknown): number {
	return typeof v === "number"
		? v
		: typeof v === "string"
			? Date.parse(v)
			: NaN;
}

function parseSession(text: string): ParsedSession {
	const s: ParsedSession = { usage: [], tools: {}, slow: [], continuations: 0 };
	/** toolCallId → start data; a `tool_execution_start` overwrites startedAt (it is the precise one). */
	const starts = new Map<
		string,
		{ tool: string; intent: string; startedAt: number }
	>();
	const bump = (
		tool: string,
		patch?: { error?: boolean; seconds?: number },
	) => {
		const t = s.tools[tool] ?? { calls: 0, errors: 0, seconds: 0 };
		t.calls += 1;
		if (patch?.error) t.errors += 1;
		if (patch?.seconds !== undefined) t.seconds += patch.seconds;
		s.tools[tool] = t;
	};
	for (const line of text.split("\n")) {
		if (!line) continue;
		let d: unknown;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof d !== "object" || d === null) continue;
		const rec = d as {
			type?: string;
			customType?: string;
			timestamp?: string;
			message?: unknown;
			data?: unknown;
		};
		if (
			rec.type === "custom_message" &&
			rec.customType === "session-stop-continuation"
		) {
			s.continuations += 1;
			continue;
		}
		if (
			rec.type === "custom" &&
			rec.customType === "tool_execution_start" &&
			typeof rec.data === "object" &&
			rec.data !== null
		) {
			const data = rec.data as {
				toolCallId?: unknown;
				toolName?: unknown;
				intent?: unknown;
				startedAt?: unknown;
			};
			if (typeof data.toolCallId === "string") {
				starts.set(data.toolCallId, {
					tool: typeof data.toolName === "string" ? data.toolName : "unknown",
					intent: typeof data.intent === "string" ? data.intent : "",
					startedAt: ts(data.startedAt ?? rec.timestamp),
				});
			}
			continue;
		}
		if (
			rec.type !== "message" ||
			typeof rec.message !== "object" ||
			rec.message === null
		)
			continue;
		const m = rec.message as {
			role?: string;
			model?: unknown;
			usage?: unknown;
			content?: unknown;
			toolCallId?: unknown;
			toolName?: unknown;
			isError?: unknown;
			details?: unknown;
		};
		if (
			m.role === "assistant" &&
			typeof m.usage === "object" &&
			m.usage !== null
		) {
			const u = m.usage as {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
			};
			s.usage.push({
				model: typeof m.model === "string" ? m.model : "unknown",
				timestamp: ts(rec.timestamp),
				input: u.input ?? 0,
				output: u.output ?? 0,
				cacheRead: u.cacheRead ?? 0,
				cacheWrite: u.cacheWrite ?? 0,
				cost: u.cost?.total ?? 0,
			});
		} else if (m.role === "assistant" && Array.isArray(m.content)) {
			// Fallback start time when no tool_execution_start custom event precedes the result.
			for (const c of m.content) {
				if (typeof c !== "object" || c === null) continue;
				const call = c as {
					type?: string;
					id?: unknown;
					name?: unknown;
					intent?: unknown;
					arguments?: { i?: unknown };
				};
				if (
					call.type !== "toolCall" ||
					typeof call.id !== "string" ||
					starts.has(call.id)
				)
					continue;
				starts.set(call.id, {
					tool: typeof call.name === "string" ? call.name : "unknown",
					intent: typeof call.intent === "string" ? call.intent : "",
					startedAt: ts(rec.timestamp),
				});
			}
		} else if (m.role === "toolResult" && typeof m.toolName === "string") {
			const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : null;
			const start = toolCallId ? starts.get(toolCallId) : undefined;
			let seconds: number | undefined;
			if (start) {
				const details = m.details as { wallTimeMs?: unknown } | null;
				if (
					typeof details?.wallTimeMs === "number" &&
					Number.isFinite(details.wallTimeMs) &&
					details.wallTimeMs >= 0
				) {
					seconds = details.wallTimeMs / 1000;
				} else {
					const elapsed = (ts(rec.timestamp) - start.startedAt) / 1000;
					if (Number.isFinite(elapsed) && elapsed >= 0) seconds = elapsed;
				}
			}
			bump(m.toolName, { error: m.isError === true, seconds });
			if (start && seconds !== undefined)
				s.slow.push({ tool: start.tool, intent: start.intent, seconds });
		}
	}
	return s;
}

function mergeSessions(sessions: ParsedSession[]): ParsedSession {
	if (sessions.length === 1 && sessions[0]) return sessions[0];
	const out: ParsedSession = {
		usage: sessions.flatMap((s) => s.usage),
		tools: {},
		slow: sessions.flatMap((s) => s.slow),
		continuations: sessions.reduce((n, s) => n + s.continuations, 0),
	};
	for (const s of sessions) {
		for (const [tool, t] of Object.entries(s.tools)) {
			const cur = out.tools[tool] ?? { calls: 0, errors: 0, seconds: 0 };
			cur.calls += t.calls;
			cur.errors += t.errors;
			cur.seconds += t.seconds;
			out.tools[tool] = cur;
		}
	}
	return out;
}

function sumUsage(u: Usage[]): RetroFacts["cost"] {
	let total = 0;
	let tokens = 0;
	let cacheRead = 0;
	const byModel: Record<string, number> = {};
	for (const x of u) {
		total += x.cost;
		tokens += x.input + x.output + x.cacheRead + x.cacheWrite;
		cacheRead += x.cacheRead;
		byModel[x.model] = (byModel[x.model] ?? 0) + x.cost;
	}
	return {
		total,
		byModel,
		tokens,
		cacheRead,
		cacheReadShare: tokens > 0 ? cacheRead / tokens : null,
	};
}

/** The token and cost facts one turn owns: the summed usage of the assistant messages
 * whose record timestamp falls inside the turn's `[from, to]` window (inclusive, the
 * turn-ownership rule). A record without a parseable
 * timestamp belongs to no window. */
export interface UsageSum {
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/**
 * Checks a transcript before its usage counts. Null: a non-blank line is not a JSON object,
 * so a skipped record could hide usage. Otherwise, true iff a record is stamped inside
 * `[from, to]`: the turn ran in this session (a turn of a replaced session finds none).
 */
function activeIn(text: string, from: number, to: number): boolean | null {
	let active = false;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let rec: unknown;
		try {
			rec = JSON.parse(line);
		} catch {
			return null;
		}
		if (typeof rec !== "object" || rec === null) return null;
		if ("timestamp" in rec) {
			const at = ts(rec.timestamp);
			if (at >= from && at <= to) active = true;
		}
	}
	return active;
}

/**
 * The turn's usage sum, or null when the transcript cannot prove it: no main session text,
 * an unreadable subagent source, a malformed record in any file, or a session without
 * activity in the window (the turn belongs to another session). Null keeps the cost
 * columns NULL, so a later read can still fill them; a zero sum is a confirmed zero.
 */
export function sumUsageIn(
	texts: TranscriptTexts,
	from: number,
	to: number,
): UsageSum | null {
	if (texts.sessionText === null || !texts.complete) return null;
	if (activeIn(texts.sessionText, from, to) !== true) return null;
	if (texts.subagentTexts.some((t) => activeIn(t, from, to) === null))
		return null;
	const all = [texts.sessionText, ...texts.subagentTexts];
	const sum: UsageSum = {
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	for (const text of all) {
		for (const u of parseSession(text).usage) {
			if (!(u.timestamp >= from && u.timestamp <= to)) continue;
			sum.tokensIn += u.input;
			sum.tokensOut += u.output;
			sum.cacheRead += u.cacheRead;
			sum.cacheWrite += u.cacheWrite;
			sum.cost += u.cost;
		}
	}
	return sum;
}

/** A "Lessons queued" section of an old retro report's details: from the heading to the next `## `. */
export function lessonsQueued(details: string | null): string | null {
	if (!details) return null;
	const at = details.indexOf("Lessons queued");
	if (at === -1) return null;
	const end = details.indexOf("\n## ", at);
	return details.slice(at, end === -1 ? undefined : end).trim();
}

type RetroTask = Pick<
	Task,
	| "id"
	| "title"
	| "state"
	| "stage"
	| "cancelledAt"
	| "needsReason"
	| "kind"
	| "details"
>;

export function collectRetroFacts(o: {
	turns: Turn[];
	log: string | null;
	sessionText: string | null;
	subagentTexts: string[];
	tasks: readonly RetroTask[];
}): RetroFacts {
	// ponytail: only the current session counts (turns carry no session id), so a
	// "New session" restart hides the older transcript. Upgrade path: match older
	// files by their session.cwd header.
	const main = o.sessionText ? parseSession(o.sessionText) : null;
	const subs = o.subagentTexts.map(parseSession);
	const all = mergeSessions([...(main ? [main] : []), ...subs]);
	const subCost = sumUsage(subs.flatMap((s) => s.usage));
	const cost = sumUsage(all.usage);

	const ciVerdict =
		o.log
			?.split("\n")
			.filter((l) => l.includes("supervisor: CI"))
			.at(-1)
			?.trim() ?? null;

	const isProposal = (t: RetroTask) =>
		t.needsReason !== null && t.needsReason.startsWith(PROPOSED_REASON_PREFIX);
	const pick = (t: RetroTask) => ({ id: t.id, title: t.title });

	return {
		turns: o.turns.map((t) => ({
			kind: t.kind,
			outcome: t.outcome,
			model: t.model,
			seconds:
				t.endedAt !== null
					? Math.max(0, (t.endedAt - t.startedAt) / 1000)
					: null,
			error: t.error,
			input: t.input === null ? null : t.input.slice(0, INPUT_CUT),
		})),
		needsYouEpisodes: o.turns.filter((t) => t.outcome === "needs_you").length,
		ciVerdict,
		ciFailed: ciVerdict !== null && ciVerdict.includes("CI failed"),
		tools: Object.entries(all.tools)
			.map(([name, t]) => ({ name, ...t }))
			.sort((a, b) => b.calls - a.calls),
		slowest: [...all.slow]
			.sort((a, b) => b.seconds - a.seconds)
			.slice(0, SLOWEST_KEEP),
		continuations: all.continuations,
		subagents: {
			count: subs.length,
			cost: subCost.total,
			costShare: cost.total > 0 ? subCost.total / cost.total : null,
		},
		cost,
		openProposals: o.tasks
			.filter((t) => isProposal(t) && t.cancelledAt === null)
			.map(pick),
		declinedProposals: o.tasks
			.filter((t) => isProposal(t) && t.cancelledAt !== null)
			.map(pick),
		lessons: o.tasks
			.filter((t) => t.kind === "retro")
			.map((t) => lessonsQueued(t.details))
			.filter((l): l is string => l !== null)
			.slice(-20),
	};
}

/** The `## Facts (computed by Ottr)` section of the retro handoff. Markdown only;
 * no tool output text ever enters it. */
export function factsMarkdown(f: RetroFacts): string {
	const turns = f.turns.length
		? f.turns
				.map(
					(t, i) =>
						`${i + 1}. ${t.kind} turn — ${t.outcome ?? "no outcome"} — ${t.model ?? "default model"}${
							t.seconds === null ? "" : ` — ${t.seconds.toFixed(2)}s`
						}${t.error ? ` — error: ${t.error}` : ""}${
							t.input === null
								? ""
								: `\n   Reply/steer: ${JSON.stringify(t.input)}`
						}`,
				)
				.join("\n")
		: "1. (no turns recorded)";
	const tools = f.tools.length
		? f.tools
				.map(
					(t) =>
						`- ${t.name}: ${t.calls} call(s), ${t.errors} error(s), ${t.seconds.toFixed(2)}s`,
				)
				.join("\n")
		: "- (no tool calls)";
	const slowest = f.slowest.length
		? f.slowest
				.map(
					(s, i) =>
						`${i + 1}. ${s.tool} — ${s.seconds.toFixed(2)}s — ${JSON.stringify(s.intent)}`,
				)
				.join("\n")
		: "1. (none recorded)";
	const byModel = Object.entries(f.cost.byModel)
		.map(([m, c]) => `${m}: $${c.toFixed(4)}`)
		.join(", ");
	const lines = [
		"## Facts (computed by Ottr)",
		"",
		`- needs_you episodes: ${f.needsYouEpisodes}`,
		`- session-stop continuations: ${f.continuations}`,
		`- CI verdict: ${f.ciVerdict ?? "not watched / unknown"}`,
		`- cost: $${f.cost.total.toFixed(4)} (${byModel || "no usage"})`,
		`- tokens: ${f.cost.tokens} (cache read ${f.cost.cacheRead}${
			f.cost.cacheReadShare === null
				? ""
				: `, ${(f.cost.cacheReadShare * 100).toFixed(1)}%`
		})`,
		`- subagents: ${f.subagents.count} session(s), $${f.subagents.cost.toFixed(4)}${
			f.subagents.costShare === null
				? ""
				: ` (${(f.subagents.costShare * 100).toFixed(1)}% of cost)`
		}`,
		`- open proposals: ${f.openProposals.length ? f.openProposals.map((p) => `${p.id} (${p.title})`).join(", ") : "none"}`,
		`- declined proposals: ${f.declinedProposals.length ? f.declinedProposals.map((p) => `${p.id} (${p.title})`).join(", ") : "none"}`,
		"",
		"### Turns",
		turns,
		"",
		"### Tools",
		tools,
		"",
		"### Slowest calls",
		slowest,
	];
	if (f.lessons.length) {
		lines.push("", "### Lessons from earlier retros");
		for (const l of f.lessons) lines.push(l);
	}
	return lines.join("\n");
}

/** R8 friction filter, on by default. A task gets a retro when any of these holds. */
export function frictionFilter(
	f: Pick<
		RetroFacts,
		"needsYouEpisodes" | "tools" | "continuations" | "ciFailed" | "cost"
	> & {
		turns: Pick<RetroFacts["turns"][number], "kind" | "input" | "outcome">[];
	},
): boolean {
	return (
		f.turns.some((t) => t.input !== null) ||
		f.needsYouEpisodes > 0 ||
		f.turns.some((t) => t.outcome === "needs_you") ||
		f.turns.filter((t) => t.kind === "work").length > 1 ||
		f.tools.some((t) => t.name === "report_outcome" && t.errors > 0) ||
		f.continuations > 0 ||
		f.ciFailed ||
		f.cost.total >= 0.5
	);
}

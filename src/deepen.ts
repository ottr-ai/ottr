import { runGateway, type SpawnFn } from "./forkAnalysis.ts";
import {
	deepenCheckPrompt,
	deepenCheckSystem,
	deepenPrompt,
	deepenSystem,
} from "./prompts.ts";

/** Cap for a returned rewrite: a runaway answer never floods the composer. */
export const DEEPEN_MAX_CHARS = 40000;

/** Cap for each kept string of a check answer: a runaway reason never floods the review. */
const CHECK_STRING_CAP = 500;

/** Cap for the additions list: a runaway answer stays a short list. */
const CHECK_ADDITIONS_CAP = 20;

/** One deepen point's verdict: does the draft cover it, does the rewrite cover it. */
export interface DeepenPointCheck {
	draft: "covered" | "missing";
	rewrite: "covered" | "missing";
	reason: string;
}

/** The full check verdict: one point check per DEEPEN_POINTS entry, plus the
 * features the rewrite added that the draft did not ask for. */
export interface DeepenCheck {
	points: DeepenPointCheck[];
	additions: string[];
}

/** Trims the model answer, strips one markdown-fence wrapper when the whole answer
 * starts with a fence, caps at DEEPEN_MAX_CHARS, and throws RangeError on empty. */
export function parseDeepened(raw: string): string {
	let out = raw.trim();
	if (out.startsWith("```")) {
		let body = out.slice(3);
		if (body.includes("\n")) body = body.slice(body.indexOf("\n") + 1);
		if (body.endsWith("```")) body = body.slice(0, -3);
		out = body.trim();
	}
	if (out.length > DEEPEN_MAX_CHARS) out = out.slice(0, DEEPEN_MAX_CHARS);
	if (!out) throw new RangeError("the model returned no text");
	return out;
}

/** One gateway call that rewrites a draft task prompt into a deeper version. */
export async function deepenDraft(o: {
	prompt: string;
	model?: string | null;
	spawn?: SpawnFn;
	timeoutMs?: number;
}): Promise<string> {
	const raw = await runGateway(
		[
			{ role: "system", content: deepenSystem },
			{ role: "user", content: deepenPrompt(o.prompt) },
		],
		o.spawn,
		o.timeoutMs ?? 120_000,
		(o.model ?? "").trim() || "@default",
	);
	return parseDeepened(raw);
}

/** Validates one points item and shapes it: the canonical name comes from
 * DEEPEN_POINTS[i], so the model's "point" string can never drift the names. */
function parsePointCheck(item: unknown, i: number): DeepenPointCheck {
	if (typeof item !== "object" || item === null || Array.isArray(item))
		throw new RangeError(`points[${i}] is not an object`);
	const p = item as Record<string, unknown>;
	if (typeof p.point !== "string")
		throw new RangeError(`points[${i}].point is not a string`);
	const oneOf = (v: unknown, field: string): "covered" | "missing" => {
		if (v !== "covered" && v !== "missing")
			throw new RangeError(
				`points[${i}].${field} must be "covered" or "missing", got ${JSON.stringify(v)}`,
			);
		return v;
	};
	if (typeof p.reason !== "string")
		throw new RangeError(`points[${i}].reason is not a string`);
	return {
		draft: oneOf(p.draft, "draft"),
		rewrite: oneOf(p.rewrite, "rewrite"),
		reason: p.reason.slice(0, CHECK_STRING_CAP),
	};
}

/** Validates the additions array: every item a string, capped at 20 items of 500 chars. */
function parseAdditions(items: unknown[]): string[] {
	const additions: string[] = [];
	for (const item of items) {
		if (typeof item !== "string")
			throw new RangeError("an additions item is not a string");
		if (additions.length >= CHECK_ADDITIONS_CAP) break;
		additions.push(item.slice(0, CHECK_STRING_CAP));
	}
	return additions;
}

/** Validates and shapes the check model's answer: fence-tolerant, exact on the five
 * points, and canonical point names come from DEEPEN_POINTS so names cannot drift. */
export function parseDeepenCheck(raw: string): DeepenCheck {
	let out = raw.trim();
	if (out.startsWith("```")) {
		let body = out.slice(3);
		if (body.includes("\n")) body = body.slice(body.indexOf("\n") + 1);
		if (body.endsWith("```")) body = body.slice(0, -3);
		out = body.trim();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch (err) {
		throw new RangeError(
			`the check answer is not valid JSON: ${err instanceof Error ? err.message : "unknown error"}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new RangeError("the check answer is not a JSON object");
	const obj = parsed as Record<string, unknown>;
	if (!Array.isArray(obj.points))
		throw new RangeError("points is not an array");
	if (obj.points.length !== 5)
		throw new RangeError(
			`points must hold exactly 5 items, got ${obj.points.length}`,
		);
	const points = obj.points.map((item: unknown, i: number) =>
		parsePointCheck(item, i),
	);
	if (!Array.isArray(obj.additions))
		throw new RangeError("additions is not an array");
	return { points, additions: parseAdditions(obj.additions) };
}

/** One gateway call that judges the Deepen rewrite against the five deepen points. */
export async function checkDeepened(o: {
	draft: string;
	rewrite: string;
	model?: string | null;
	spawn?: SpawnFn;
	timeoutMs?: number;
}): Promise<DeepenCheck> {
	const raw = await runGateway(
		[
			{ role: "system", content: deepenCheckSystem },
			{ role: "user", content: deepenCheckPrompt(o.draft, o.rewrite) },
		],
		o.spawn,
		o.timeoutMs ?? 120_000,
		(o.model ?? "").trim() || "@default",
	);
	return parseDeepenCheck(raw);
}

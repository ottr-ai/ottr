import { runGateway, type SpawnFn } from "./forkAnalysis.ts";
import { deepenPrompt, deepenSystem } from "./prompts.ts";

/** Cap for a returned rewrite: a runaway answer never floods the composer. */
export const DEEPEN_MAX_CHARS = 40000;

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

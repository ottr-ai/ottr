import { runGateway, type SpawnFn } from "./forkAnalysis.ts";
import { modelRoles } from "./models.ts";
import {
	RELEASE_SUMMARY_CHUNK_INSTRUCTIONS,
	RELEASE_SUMMARY_INSTRUCTIONS,
} from "./prompts.ts";

/** Card details are release notes; 1500 chars keeps the header sections of a normal report. */
const CARD_DETAIL_CAP = 1500;
/** Total model input bound; a bigger range goes through the chunk pass first. */
const INPUT_CAP = 80_000;
/** At most 10 chunk calls before the oldest cards lose their details. */
const CHUNK_MAX = 10;
/** The chunk instructions ask for at most 8 bullets; this pins the reply cap. */
const CHUNK_LINES = 8;
/** Published release bodies stay short; the sanitizer caps the model reply at 8000 chars. */
const OUTPUT_CAP = 8000;
/** One gateway call per pass, 90 s ceiling (the dialog waits on every open). */
const DEFAULT_TIMEOUT_MS = 90_000;

export type ReleaseSummaryCard = {
	id: string;
	title: string;
	details: string | null;
};

/** Trim one card's details at a line boundary, but only when that boundary keeps most of
 * the window (last newline past cap/2, the normal case of many short lines); a line longer
 * than half the cap hard-cuts, so an early short header line never collapses the block. */
function trimAtLine(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const cut = text.slice(0, cap);
	const nl = cut.lastIndexOf("\n");
	return (nl >= cap / 2 ? cut.slice(0, nl) : cut).trimEnd();
}

/** One card block: `- [id] title` plus the trimmed details when the report holds any. */
function cardBlock(card: ReleaseSummaryCard, withDetails: boolean): string {
	const head = `- [${card.id}] ${card.title}`;
	const details =
		withDetails && card.details !== null
			? trimAtLine(card.details, CARD_DETAIL_CAP)
			: "";
	return details === "" ? head : `${head}\n${details}`;
}

/** The deterministic notes plus one block per card; exported for the input tests. */
export function buildSummaryInput(
	notes: string,
	cards: ReleaseSummaryCard[],
	withDetails: boolean,
): string {
	const blocks = cards.map((c) => cardBlock(c, withDetails));
	return blocks.length === 0 ? notes : `${notes}\n\n${blocks.join("\n\n")}`;
}

/** Greedy pack card blocks into chunks, each within `cap`; a card block larger than the cap
 * still forms its own (oversized) chunk, so packing always terminates. */
function packChunks(
	cards: ReleaseSummaryCard[],
	withDetails: boolean,
	cap: number,
): ReleaseSummaryCard[][] {
	const chunks: ReleaseSummaryCard[][] = [];
	let current: ReleaseSummaryCard[] = [];
	let size = 0;
	for (const card of cards) {
		const block = cardBlock(card, withDetails);
		if (current.length > 0 && size + block.length + 2 > cap) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		current.push(card);
		size += block.length + 2;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** The first pass: chunks of raw card blocks condensed by the model, oldest cards stripped
 * of details first when more than CHUNK_MAX chunks would be needed. */
function chunkInputs(cards: ReleaseSummaryCard[]): string[] {
	let chunks = packChunks(cards, true, INPUT_CAP / 2);
	const stripped = cards.map((c) => ({ ...c }));
	while (
		chunks.length > CHUNK_MAX &&
		stripped.some((c) => c.details !== null)
	) {
		// Oldest cards keep only id and title (cards arrive oldest-first).
		const first = stripped.find((c) => c.details !== null);
		if (first === undefined) break;
		first.details = null;
		chunks = packChunks(stripped, true, INPUT_CAP / 2);
	}
	return chunks.map((cs) => cs.map((c) => cardBlock(c, true)).join("\n\n"));
}

/** Strip HTML tags, Markdown links and images (keep the text), collapse blank-line runs,
 * cap at OUTPUT_CAP at a line boundary. */
export function sanitizeSummary(text: string): string {
	// Script/style bodies are not proposal content: drop them with their tags first.
	let out = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
	out = out.replace(/<[^>]*>/g, "");
	out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\n{3,}/g, "\n\n");
	if (out.length > OUTPUT_CAP) {
		const cut = out.slice(0, OUTPUT_CAP);
		const nl = cut.lastIndexOf("\n");
		out = (nl > 0 ? cut.slice(0, nl) : cut).trimEnd();
	}
	return out;
}

/** The deterministic breaking bullets of the notes, marker included, list marker stripped. */
function breakingBullets(notes: string): string[] {
	const out: string[] = [];
	for (const line of notes.split("\n")) {
		const m = /^\s*[-*]\s+(\*\*Breaking:\*\*.+)$/.exec(line);
		const bullet = m?.[1];
		if (bullet !== undefined) out.push(bullet.trim());
	}
	return out;
}

export async function summarizeRelease(o: {
	notes: string;
	cards: ReleaseSummaryCard[];
	spawn?: SpawnFn;
	roles?: Record<string, string>;
	timeoutMs?: number;
}): Promise<{ summary: string | null; reason: string | null }> {
	const selector = (o.roles ?? modelRoles()).smol?.trim() || "@default";
	const call = async (system: string, user: string): Promise<string | null> => {
		try {
			const reply = await runGateway(
				[
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				o.spawn,
				o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				selector,
			);
			const text = reply.trim();
			return text === "" ? null : text;
		} catch (err) {
			throw new Error(err instanceof Error ? err.message : String(err));
		}
	};
	try {
		let input = buildSummaryInput(o.notes, o.cards, true);
		if (input.length > INPUT_CAP && o.cards.length > 0) {
			// All chunk calls run in parallel so the whole summary stays within one
			// call ceiling; Promise.all keeps the oldest-first order of the inputs.
			const chunkReplies = await Promise.all(
				chunkInputs(o.cards).map((chunk) =>
					call(RELEASE_SUMMARY_CHUNK_INSTRUCTIONS, chunk),
				),
			);
			const lines: string[] = [];
			for (const condensed of chunkReplies) {
				if (condensed === null)
					return { summary: null, reason: "the model returned an empty reply" };
				lines.push(
					...condensed
						.split("\n")
						.map((l) => l.trim())
						.filter((l) => l.startsWith("-"))
						.slice(0, CHUNK_LINES),
				);
			}
			input = `${o.notes}\n\n${lines.join("\n")}`;
		}
		const reply = await call(RELEASE_SUMMARY_INSTRUCTIONS, input);
		if (reply === null)
			return { summary: null, reason: "the model returned an empty reply" };
		const summary = sanitizeSummary(reply);
		if (summary.trim() === "")
			return { summary: null, reason: "the model returned an empty reply" };
		// Deterministic guarantee: the model cannot drop a breaking change.
		const missing = breakingBullets(o.notes).filter(
			(b) => summary.includes(b) === false,
		);
		const appended =
			missing.length > 0
				? `${summary}\n\n## Breaking changes\n\n${missing.map((b) => `- ${b}`).join("\n")}`
				: summary;
		return { summary: appended, reason: null };
	} catch (err) {
		return {
			summary: null,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

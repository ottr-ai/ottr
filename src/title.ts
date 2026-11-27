// The task title derived from a prompt. Shared by the store (the title a new task gets)
// and the board (pairing an optimistic placeholder with its card), so the two never drift.
import { leadCardTitle } from "./auditLeads.ts";
import { shortTitle } from "./prompts.ts";

/**
 * First non-empty trimmed line of the prompt, max 80 chars — the task's title. Skips section
 * labels (Markdown headings with a single word, e.g. "# Goal") and strips leading `#` marks,
 * so a heading like "# Set up agent rules" becomes the bare text. Overlong lines cut at a
 * word boundary (shortTitle), never mid-word. A lead filed with the review prompt's bare tag
 * line ("Needs validation" alone on line 1, OTTR-1164) titles from its claim instead, so
 * leads stay tellable apart on the board. Card kind is a trusted, server-set field, never derived
 * from the title. The board derives the same title to pair a New task placeholder with its
 * card before the POST answers (src/ui/pending.ts), so both sides share this one function.
 */
export function deriveTitle(prompt: string): string {
	// OTTR-1164: "Needs validation: <subject>" beats the bare tag as the title.
	const lead = leadCardTitle(prompt);
	if (lead !== null) return lead;
	const lines = prompt.split("\n").map((line) => line.trim());
	const isSectionLabel = (line: string) => /^#{1,6}\s+\S+$/.test(line);
	const line =
		lines.find((line) => line.length > 0 && !isSectionLabel(line)) ??
		lines.find((line) => line.length > 0) ??
		"";
	return shortTitle(line.replace(/^#+\s*/, ""), 80);
}

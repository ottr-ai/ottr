import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The skills this repo ships under .agents/skills are public. Only the
 * board's private data knows its task ids, so a skill must state the rule or
 * the fact itself and never cite a card id. */
const ROOT = join(import.meta.dir, "..", ".agents", "skills");

/** A board task id: an upper-case prefix of 2-6 letters, a hyphen, digits, as
 * a whole word. */
const CARD_ID = /\b[A-Z]{2,6}-\d+\b/g;

/** Standard identifiers that match the shape above and name no card. */
const STANDARD = ["SHA-", "UTF-", "ISO-", "CVE-", "CWE-", "WCAG"];

function skillFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...skillFiles(path));
		else found.push(path);
	}
	return found.sort();
}

describe("shipped skills (.agents/skills)", () => {
	test("no file cites a board task id", () => {
		const offenders: string[] = [];
		for (const file of skillFiles(ROOT)) {
			const name = relative(join(import.meta.dir, ".."), file);
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, index) => {
				for (const match of line.matchAll(CARD_ID)) {
					const id = match[0] ?? "";
					if (STANDARD.some((prefix) => id.startsWith(prefix))) continue;
					offenders.push(
						`${name}:${index + 1} cites "${id}" — shipped skills are public: state the rule or the fact itself, never a board task id.`,
					);
				}
			});
		}
		expect(offenders).toEqual([]);
	});
});

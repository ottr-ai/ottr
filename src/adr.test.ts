import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The ADR folder is the project's decision log (docs/adr/README.md): numbers
// are unique and monotonic, the index lists every record, statuses use the
// documented values, and a superseded record names its replacement. ADR-0012
// holds the recorded stack decision of OTTR-807; its presence and accepted
// status are pinned so the decision cannot vanish or flip without a new ADR.
const adrDir = join(import.meta.dir, "..", "docs", "adr");

interface AdrFile {
	file: string;
	number: string;
}

function adrFiles(): AdrFile[] {
	return readdirSync(adrDir)
		.filter((f) => f.endsWith(".md") && f !== "README.md")
		.map((file) => ({ file, number: file.slice(0, 4) }))
		.sort((a, b) => a.number.localeCompare(b.number));
}

function statusLine(file: string): string {
	const text = readFileSync(join(adrDir, file), "utf8");
	const at = text.indexOf("## Status");
	expect(at, `${file} has a Status section`).toBeGreaterThanOrEqual(0);
	const rest = text.slice(at + "## Status".length);
	const line = rest.split("\n").find((l) => l.trim().length > 0);
	return (line ?? "").trim();
}

function indexRows(): Map<string, string> {
	const readme = readFileSync(join(adrDir, "README.md"), "utf8");
	const rows = new Map<string, string>();
	for (const line of readme.split("\n")) {
		const row = /^\|\s*(\d{4})\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
		if (row) rows.set(row[1] ?? "", row[3] ?? "");
	}
	return rows;
}

describe("docs/adr registry", () => {
	test("file names are NNNN-slug.md with unique numbers", () => {
		const files = adrFiles();
		expect(files.length).toBeGreaterThan(0);
		const seen = new Set<string>();
		for (const { file } of files) {
			expect(file).toMatch(/^\d{4}-[a-z0-9-]+\.md$/);
			expect(seen.has(file.slice(0, 4)), `duplicate number in ${file}`).toBe(
				false,
			);
			seen.add(file.slice(0, 4));
		}
	});

	test("the index lists every ADR and no row without a file", () => {
		const rows = indexRows();
		for (const { number, file } of adrFiles()) {
			expect(rows.has(number), `${file} is missing from the index`).toBe(true);
		}
		for (const number of rows.keys()) {
			expect(
				adrFiles().some((f) => f.number === number),
				`index row ${number} has no ADR file`,
			).toBe(true);
		}
	});

	test("statuses use the documented values and supersessions link forward", () => {
		const files = adrFiles();
		for (const { file } of files) {
			const status = statusLine(file);
			const head = status.split(/[\s—-]/)[0] ?? "";
			expect(
				["proposed", "accepted", "superseded"].includes(head),
				`${file} has unknown status: ${status}`,
			).toBe(true);
			if (head === "superseded") {
				const link =
					/superseded by \[ADR-(\d{4})\]\(([^)]+)\)/.exec(status)?.[2] ?? "";
				expect(link, `${file} names no replacing ADR`).not.toBe("");
				expect(
					existsSync(join(adrDir, link)),
					`${file} supersedes to a missing file`,
				).toBe(true);
			}
		}
	});

	test("the OTTR-807 stack decision is recorded in an accepted ADR", () => {
		const decision = adrFiles().find((f) => f.number === "0012");
		expect(
			decision?.file,
			"ADR-0012 with the stack decision is missing",
		).toBeDefined();
		const file = decision?.file ?? "";
		expect(statusLine(file).startsWith("accepted")).toBe(true);
		const text = readFileSync(join(adrDir, file), "utf8");
		expect(text).toContain("Ottr stays on TypeScript and Bun");
		expect(text).toContain("thresholds are proposed");
		const rows = indexRows();
		expect(rows.get("0012") ?? "").toBe("accepted");
	});
});

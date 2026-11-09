import { expect, test } from "bun:test";
import { mermaidSrc } from "../mermaidVersion.ts";
import { loadMermaid } from "./mermaid.ts";

/** Minimal document seam: records the script element loadMermaid creates and appends. */
function recordingDoc() {
	const created: Array<{ src: string | null }> = [];
	return {
		created,
		doc: {
			createElement: () => {
				const el: { src: string | null } = { src: null };
				created.push(el);
				return el;
			},
			head: { append: () => {} },
		} as unknown as Document,
	};
}

test("loadMermaid injects the versioned mermaid path once", () => {
	const { created, doc } = recordingDoc();
	const p = loadMermaid(doc);
	expect(created).toHaveLength(1);
	expect(created[0]?.src).toBe(mermaidSrc);
	// Every later open reuses the same load; a failed load clears it, so the next open retries.
	expect(loadMermaid(doc)).toBe(p);
});

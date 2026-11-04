import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "./forkAnalysis.ts";
import {
	RELEASE_SUMMARY_CHUNK_INSTRUCTIONS,
	RELEASE_SUMMARY_INSTRUCTIONS,
} from "./prompts.ts";
import {
	buildSummaryInput,
	type ReleaseSummaryCard,
	sanitizeSummary,
	summarizeRelease,
} from "./releaseSummary.ts";

const okSpawn = (reply: string): { spawn: SpawnFn; calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		spawn: async (_argv, o) => {
			calls.push(JSON.parse(o.stdin).body.messages[0].content);
			return {
				code: 0,
				stdout: [
					JSON.stringify({ ready: true }),
					JSON.stringify({
						id: 1,
						status: 200,
						body: { choices: [{ message: { content: reply } }] },
					}),
				].join("\n"),
				stderr: "",
			};
		},
	};
};

const card = (
	id: string,
	title: string,
	details: string | null = null,
): ReleaseSummaryCard => ({ id, title, details });

const CARDS: ReleaseSummaryCard[] = [
	card("A-1", "Fix the login", "## Bug fixes\n\n- one login"),
	card("B-2", "Speed up merges", "## Changes\n\n- faster"),
];

describe("buildSummaryInput", () => {
	test("holds the notes and every card id and title", () => {
		const input = buildSummaryInput("- feat: x", CARDS, true);
		expect(input).toContain("- feat: x");
		expect(input).toContain("- [A-1] Fix the login");
		expect(input).toContain("- [B-2] Speed up merges");
		expect(input).toContain("one login");
	});

	test("a card without details keeps id and title only", () => {
		const input = buildSummaryInput("notes", [card("A-1", "Empty")], true);
		expect(input).toBe("notes\n\n- [A-1] Empty");
	});

	test("card details trim at 1500 characters at a line boundary", () => {
		const lines: string[] = [];
		for (let i = 0; i < 60; i++) lines.push(`line ${i}: ${"x".repeat(40)}`);
		const details = lines.join("\n");
		const input = buildSummaryInput(
			"notes",
			[card("A-1", "Big", details)],
			true,
		);
		const block = input.slice(input.indexOf("- [A-1]"));
		expect(block.length).toBeLessThan(1550);
		expect(block.endsWith("x".repeat(40))).toBe(true);
	});

	test("zero cards leaves the notes alone", () => {
		expect(buildSummaryInput("notes only", [], true)).toBe("notes only");
	});
});

describe("sanitizeSummary", () => {
	test("strips HTML tags", () => {
		expect(sanitizeSummary("## New features\n\n<script>x</script>- ok")).toBe(
			"## New features\n\n- ok",
		);
	});

	test("replaces links and images with their text", () => {
		expect(
			sanitizeSummary(
				"- [docs](https://evil.example) and ![pic](https://x/y.png)",
			),
		).toBe("- docs and pic");
	});

	test("collapses three or more newlines to two", () => {
		expect(sanitizeSummary("a\n\n\n\nb")).toBe("a\n\nb");
	});

	test("caps the output at 8000 characters at a line boundary", () => {
		const lines: string[] = [];
		for (let i = 0; i < 400; i++) lines.push(`- bullet ${i} ${"y".repeat(40)}`);
		const out = sanitizeSummary(lines.join("\n"));
		expect(out.length).toBeLessThanOrEqual(8000);
		expect(out.endsWith("y".repeat(40))).toBe(true);
	});

	test("a reply of only HTML sanitizes to empty", () => {
		expect(sanitizeSummary("<b></b><script>go()</script>").trim()).toBe("");
	});
});

describe("summarizeRelease", () => {
	const reply =
		"## Highlights\n\n- Faster merges\n\n## Bug fixes\n\n- One login";

	test("answers the fake gateway summary with reason null", async () => {
		const { spawn, calls } = okSpawn(reply);
		const out = await summarizeRelease({
			notes: "- fix: login",
			cards: CARDS,
			spawn,
		});
		expect(out).toEqual({ summary: reply, reason: null });
		// One final call: input within the bound, so no chunk pass.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toBe(RELEASE_SUMMARY_INSTRUCTIONS);
	});

	test("the final call uses the release-summary instructions and the smol selector", async () => {
		let system = "";
		let model = "";
		const spawn: SpawnFn = async (_argv, o) => {
			const body = JSON.parse(o.stdin).body;
			system = body.messages[0].content;
			model = body.model;
			return {
				code: 0,
				stdout: [
					JSON.stringify({ ready: true }),
					JSON.stringify({
						id: 1,
						status: 200,
						body: { choices: [{ message: { content: reply } }] },
					}),
				].join("\n"),
				stderr: "",
			};
		};
		await summarizeRelease({
			notes: "n",
			cards: [],
			spawn,
			roles: { smol: "@smol" },
		});
		expect(system).toBe(RELEASE_SUMMARY_INSTRUCTIONS);
		expect(model).toBe("@smol");
	});

	test("a gateway throw answers the fallback with the error message", async () => {
		const spawn: SpawnFn = async () => ({
			code: 1,
			stdout: "",
			stderr: "no quota",
		});
		const out = await summarizeRelease({ notes: "n", cards: [], spawn });
		expect(out.summary).toBeNull();
		expect(out.reason).toMatch(/no quota/);
	});

	test("an empty reply answers the fallback reason", async () => {
		const { spawn } = okSpawn("   \n");
		const out = await summarizeRelease({ notes: "n", cards: [], spawn });
		expect(out).toEqual({
			summary: null,
			reason: "the model returned an empty reply",
		});
	});

	test("a reply of only HTML counts as an empty reply", async () => {
		const { spawn } = okSpawn("<b></b><script>go()</script>");
		const out = await summarizeRelease({ notes: "n", cards: [], spawn });
		expect(out.summary).toBeNull();
		expect(out.reason).toBe("the model returned an empty reply");
	});

	test("a dropped breaking bullet is appended under a breaking section", async () => {
		const notes = "- **Breaking:** Drop node 16\n- feat: x";
		const { spawn } = okSpawn("## New features\n\n- New api");
		const out = await summarizeRelease({ notes, cards: [], spawn });
		expect(out.summary).toContain(
			"## Breaking changes\n\n- **Breaking:** Drop node 16",
		);
	});

	test("a reply that holds the breaking bullet does not duplicate it", async () => {
		const notes = "- **Breaking:** Drop node 16";
		const { spawn } = okSpawn("## Changes\n\n- **Breaking:** Drop node 16");
		const out = await summarizeRelease({ notes, cards: [], spawn });
		expect(out.summary).not.toContain("## Breaking changes");
		const hits = (out.summary?.match(/Drop node 16/g) ?? []).length;
		expect(hits).toBe(1);
	});

	test("an oversized input runs the chunk pass and feeds chunk lines to the final call", async () => {
		// The input builder trims each card's details to 1500, so 60 cards ≈ 92k
		// (60×1500 + headers) > 80k INPUT_CAP: chunking kicks in with 3 chunks at ≤40k,
		// well under the 10-chunk strip limit, so every card keeps its details.
		const big: ReleaseSummaryCard[] = [];
		for (let i = 0; i < 60; i++)
			big.push(
				card(`C-${i}`, `card ${i}`, `## Changes\n\n- ${"z".repeat(3500)}`),
			);
		const chunkReplies = [
			"- chunk one work",
			"- chunk two work",
			"- chunk three work",
		];
		let pass = 0;
		const systems: string[] = [];
		const users: string[] = [];
		const spawn: SpawnFn = async (_argv, o) => {
			const body = JSON.parse(o.stdin).body;
			systems.push(body.messages[0].content);
			users.push(body.messages[1].content);
			const content = pass < chunkReplies.length ? chunkReplies[pass] : reply;
			pass++;
			return {
				code: 0,
				stdout: [
					JSON.stringify({ ready: true }),
					JSON.stringify({
						id: 1,
						status: 200,
						body: { choices: [{ message: { content } }] },
					}),
				].join("\n"),
				stderr: "",
			};
		};
		const out = await summarizeRelease({
			notes: "- fix: login",
			cards: big,
			spawn,
		});
		expect(out.reason).toBeNull();
		// Three chunk calls, then the final call.
		expect(pass).toBe(4);
		expect(systems[0]).toBe(RELEASE_SUMMARY_CHUNK_INSTRUCTIONS);
		expect(systems[1]).toBe(RELEASE_SUMMARY_CHUNK_INSTRUCTIONS);
		expect(systems[2]).toBe(RELEASE_SUMMARY_CHUNK_INSTRUCTIONS);
		expect(systems[3]).toBe(RELEASE_SUMMARY_INSTRUCTIONS);
		// The final input holds the chunk lines, not the raw card details.
		expect(users[3]).toContain("- chunk one work");
		expect(users[3]).toContain("- chunk three work");
		expect(users[3]).not.toContain("z".repeat(3500));
		// Each chunk input stays within half the input bound.
		for (const u of users.slice(0, 3))
			expect(u.length).toBeLessThanOrEqual(40_000);
	});
});

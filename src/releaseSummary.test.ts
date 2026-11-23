import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn } from "./forkAnalysis.ts";
import {
	RELEASE_SUMMARY_CHUNK_INSTRUCTIONS,
	RELEASE_SUMMARY_INSTRUCTIONS,
} from "./prompts.ts";
import {
	buildSummaryInput,
	type ReleaseSummaryCard,
	readProductDescription,
	sanitizeSummary,
	summarizeRelease,
} from "./releaseSummary.ts";

const okSpawn = (
	reply: string,
): { spawn: SpawnFn; calls: string[]; users: string[] } => {
	const calls: string[] = [];
	const users: string[] = [];
	return {
		calls,
		users,
		spawn: async (_argv, o) => {
			const body = JSON.parse(o.stdin).body;
			calls.push(body.messages[0].content);
			users.push(body.messages[1].content);
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
			projectName: "p",
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
			projectName: "p",
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
		const out = await summarizeRelease({
			notes: "n",
			cards: [],
			spawn,
			projectName: "p",
			fallbacks: {},
		});
		expect(out.summary).toBeNull();
		expect(out.reason).toMatch(/no quota/);
	});

	test("an empty reply answers the fallback reason", async () => {
		const { spawn } = okSpawn("   \n");
		const out = await summarizeRelease({
			notes: "n",
			cards: [],
			spawn,
			projectName: "p",
		});
		expect(out).toEqual({
			summary: null,
			reason: "the model returned an empty reply",
		});
	});

	test("a reply of only HTML counts as an empty reply", async () => {
		const { spawn } = okSpawn("<b></b><script>go()</script>");
		const out = await summarizeRelease({
			notes: "n",
			cards: [],
			spawn,
			projectName: "p",
		});
		expect(out.summary).toBeNull();
		expect(out.reason).toBe("the model returned an empty reply");
	});

	test("a dropped breaking bullet is appended under a breaking section", async () => {
		const notes = "- **Breaking:** Drop node 16\n- feat: x";
		const { spawn } = okSpawn("## New features\n\n- New api");
		const out = await summarizeRelease({
			notes,
			cards: [],
			spawn,
			projectName: "p",
		});
		expect(out.summary).toContain(
			"## Breaking changes\n\n- **Breaking:** Drop node 16",
		);
	});

	test("a reply that holds the breaking bullet does not duplicate it", async () => {
		const notes = "- **Breaking:** Drop node 16";
		const { spawn } = okSpawn("## Changes\n\n- **Breaking:** Drop node 16");
		const out = await summarizeRelease({
			notes,
			cards: [],
			spawn,
			projectName: "p",
		});
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
			projectName: "p",
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

	test("a credit hold that lands during the chunk pass stops the final call", async () => {
		const big: ReleaseSummaryCard[] = [];
		for (let i = 0; i < 60; i++)
			big.push(
				card(`C-${i}`, `card ${i}`, `## Changes\n\n- ${"z".repeat(3500)}`),
			);
		let spawns = 0;
		const spawn: SpawnFn = async () => {
			spawns += 1;
			return {
				code: 0,
				stdout: [
					JSON.stringify({ ready: true }),
					JSON.stringify({
						id: 1,
						status: 200,
						body: {
							choices: [{ message: { content: "- chunk work" } }],
						},
					}),
				].join("\n"),
				stderr: "",
			};
		};
		// Every dispatch re-checks the hold: the chunks start in one synchronous map, so
		// only the first chunk passes the check at zero spawns; the rest and the final
		// call see the flipped hold and never dispatch.
		const out = await summarizeRelease({
			notes: "- fix: login",
			cards: big,
			spawn,
			projectName: "p",
			creditHoldActive: () => spawns > 0,
		});
		expect(out).toEqual({
			summary: null,
			reason: "the board is out of credit",
		});
		// One chunk call ran; the hold stopped the other chunks and the final dispatch.
		expect(spawns).toBe(1);
	});

	test("the system message stays project-neutral and the user message names the project and description", async () => {
		const { spawn, calls, users } = okSpawn(reply);
		const out = await summarizeRelease({
			notes: "- feat: x",
			cards: [],
			spawn,
			projectName: "velvarr",
			projectDescription: "A media library app for film collectors",
		});
		expect(out.reason).toBeNull();
		expect(calls[0]).not.toContain("Ottr");
		expect(users[0]).toContain("PROJECT: velvarr");
		expect(users[0]).toContain(
			"DESCRIPTION: A media library app for film collectors",
		);
	});

	test("a project without a description names the project only", async () => {
		const { spawn, users } = okSpawn(reply);
		await summarizeRelease({
			notes: "n",
			cards: [],
			spawn,
			projectName: "velvarr",
		});
		expect(users[0]).toContain("PROJECT: velvarr");
		expect(users[0]).not.toContain("DESCRIPTION:");
	});

	test("an ottr release still gets its name in the input", async () => {
		const { spawn, users } = okSpawn(reply);
		await summarizeRelease({
			notes: "n",
			cards: [],
			spawn,
			projectName: "ottr",
		});
		expect(users[0]).toContain("PROJECT: ottr");
	});

	test("both instruction constants name no project", () => {
		expect(RELEASE_SUMMARY_INSTRUCTIONS).not.toContain("Ottr");
		expect(RELEASE_SUMMARY_CHUNK_INSTRUCTIONS).not.toContain("Ottr");
	});

	// Fails on the first model with the given stderr text; answers the rest with `reply`.
	const failSpawn = (
		failModel: string,
		stderr: string,
		reply: string,
	): { spawn: SpawnFn; models: string[] } => {
		const models: string[] = [];
		return {
			models,
			spawn: async (_argv, o) => {
				const model = JSON.parse(o.stdin).body.model as string;
				models.push(model);
				if (model === failModel) return { code: 1, stdout: "", stderr };
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

	test("a provider error on smol walks the smol fallback chain", async () => {
		const { spawn, models } = failSpawn(
			"a/b:max",
			"gateway status 502: Codex error event: Codex is at capacity",
			reply,
		);
		const out = await summarizeRelease({
			notes: "n",
			cards: [],
			spawn,
			projectName: "p",
			roles: { smol: "a/b:max" },
			fallbacks: { smol: ["c/d:max"] },
		});
		expect(out.summary).toContain(reply);
		expect(out.reason).toBeNull();
		expect(models).toEqual(["a/b:max", "c/d:max"]);
	});

	test("a provider error without a chain answers the gateway error as the reason", async () => {
		const errText =
			"gateway status 502: Codex error event: Codex is at capacity";
		const { spawn, models } = failSpawn("a/b:max", errText, reply);
		const out = await summarizeRelease({
			notes: "n",
			cards: [],
			spawn,
			projectName: "p",
			roles: { smol: "a/b:max" },
			fallbacks: {},
		});
		expect(out.summary).toBeNull();
		expect(out.reason).toBe(`gateway exited with code 1: ${errText}`);
		expect(models).toEqual(["a/b:max"]);
	});

	test("a non-provider failure does not walk a present chain", async () => {
		const { spawn, models } = failSpawn("a/b:max", "stop", reply);
		const out = await summarizeRelease({
			notes: "n",
			cards: [],
			spawn,
			projectName: "p",
			roles: { smol: "a/b:max" },
			fallbacks: { smol: ["c/d:max"] },
		});
		expect(out.summary).toBeNull();
		expect(out.reason).toBe("gateway exited with code 1: stop");
		expect(models).toEqual(["a/b:max"]);
	});
});

describe("readProductDescription", () => {
	// The helper reads real files: every test builds its own temp directory.
	const temp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-reldesc-"));
		return dir;
	};

	test("the package.json description wins over the README", () => {
		const dir = temp();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "x", description: "A widget manager" }),
		);
		writeFileSync(join(dir, "README.md"), "# x\n\nIgnored paragraph");
		try {
			expect(readProductDescription(dir)).toBe("A widget manager");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("without a package.json description it reads the README's first non-heading paragraph", () => {
		const dir = temp();
		writeFileSync(
			join(dir, "README.md"),
			"# Velvarr\n\nA media library\nfor film collectors.\n\nInstall notes here.",
		);
		try {
			expect(readProductDescription(dir)).toBe(
				"A media library for film collectors.",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a package.json without a usable description falls through to the README", () => {
		const dir = temp();
		writeFileSync(join(dir, "package.json"), "{ not json at all");
		writeFileSync(join(dir, "README.md"), "Only one paragraph.");
		try {
			expect(readProductDescription(dir)).toBe("Only one paragraph.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a description longer than 500 characters is cut at a word boundary", () => {
		const dir = temp();
		const words: string[] = [];
		for (let i = 0; i < 200; i++) words.push(`word${i}`);
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ description: words.join(" ") }),
		);
		try {
			const out = readProductDescription(dir)!;
			expect(out.length).toBeLessThanOrEqual(500);
			expect(out.endsWith("word")).toBe(false);
			expect(words.join(" ").startsWith(out)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no package.json and no README answers null", () => {
		const dir = temp();
		try {
			expect(readProductDescription(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

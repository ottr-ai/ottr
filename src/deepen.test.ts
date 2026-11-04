import { describe, expect, test } from "bun:test";
import { DEEPEN_MAX_CHARS, deepenDraft, parseDeepened } from "./deepen.ts";
import type { SpawnFn } from "./forkAnalysis.ts";
import { deepenPrompt, deepenSystem } from "./prompts.ts";

describe("parseDeepened", () => {
	test("trims plain text", () => {
		expect(parseDeepened("  do it well  ")).toBe("do it well");
	});

	test("strips one markdown-fence wrapper", () => {
		expect(parseDeepened("```\ndo it well\n```")).toBe("do it well");
		expect(parseDeepened("```markdown\ndo it well\n```")).toBe("do it well");
	});

	test("keeps an interior fence and strips only the wrapper", () => {
		expect(parseDeepened("```\na\n```\nb\n```")).toBe("a\n```\nb");
	});

	test("does not strip a fence that does not start the answer", () => {
		expect(parseDeepened("text\n```\nx\n```")).toBe("text\n```\nx\n```");
	});

	test("caps a runaway answer at DEEPEN_MAX_CHARS", () => {
		expect(parseDeepened("x".repeat(DEEPEN_MAX_CHARS + 500))).toBe(
			"x".repeat(DEEPEN_MAX_CHARS),
		);
		expect(DEEPEN_MAX_CHARS).toBe(40000);
	});

	test("throws RangeError on empty", () => {
		for (const raw of ["", "   ", "```\n```", "```  ```"]) {
			expect(() => parseDeepened(raw)).toThrow(RangeError);
		}
	});
});

describe("deepenDraft", () => {
	/** Gateway harness: records what runGateway saw, replies with a fixed answer. */
	function gatewaySpawn(answer: string): {
		spawn: SpawnFn;
		calls: Array<{ argv: string[]; stdin: string; timeoutMs?: number }>;
	} {
		const calls: Array<{ argv: string[]; stdin: string; timeoutMs?: number }> =
			[];
		const spawn: SpawnFn = async (argv, o) => {
			calls.push({ argv, stdin: o.stdin, timeoutMs: o.timeoutMs });
			return {
				code: 0,
				stdout: `${JSON.stringify({ ready: true })}\n${JSON.stringify({
					id: 1,
					status: 200,
					body: {
						choices: [{ message: { role: "assistant", content: answer } }],
					},
				})}\n`,
				stderr: "",
			};
		};
		return { spawn, calls };
	}

	test("sends system+user messages and returns the parsed rewrite", async () => {
		const { spawn, calls } = gatewaySpawn("  deeper text  ");
		const out = await deepenDraft({ prompt: "draft", spawn });
		expect(out).toBe("deeper text");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.argv).toEqual(["omp", "auth-gateway", "stdio"]);
		const body = JSON.parse(calls[0]!.stdin).body;
		expect(body.model).toBe("@default");
		expect(body.messages).toEqual([
			{ role: "system", content: deepenSystem },
			{ role: "user", content: deepenPrompt("draft") },
		]);
	});

	test("trims the model selector and falls back to @default when empty", async () => {
		const a = gatewaySpawn("x");
		await deepenDraft({ prompt: "p", spawn: a.spawn, model: " @plan " });
		expect(JSON.parse(a.calls[0]!.stdin).body.model).toBe("@plan");
		const b = gatewaySpawn("x");
		await deepenDraft({ prompt: "p", spawn: b.spawn, model: "   " });
		expect(JSON.parse(b.calls[0]!.stdin).body.model).toBe("@default");
		const c = gatewaySpawn("x");
		await deepenDraft({ prompt: "p", spawn: c.spawn, model: null });
		expect(JSON.parse(c.calls[0]!.stdin).body.model).toBe("@default");
	});

	test("defaults the timeout to 120000 ms and honors an override", async () => {
		const a = gatewaySpawn("x");
		await deepenDraft({ prompt: "p", spawn: a.spawn });
		expect(a.calls[0]!.timeoutMs).toBe(120_000);
		const b = gatewaySpawn("x");
		await deepenDraft({ prompt: "p", spawn: b.spawn, timeoutMs: 5 });
		expect(b.calls[0]!.timeoutMs).toBe(5);
	});

	test("empty model answer throws (the route 502 path)", async () => {
		const { spawn } = gatewaySpawn("  ");
		await expect(deepenDraft({ prompt: "p", spawn })).rejects.toThrow(
			RangeError,
		);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import {
	PROPOSE_TOOL_DESCRIPTION,
	REVIEW_PROPOSE_TOOL_DESCRIPTION,
} from "../src/prompts.ts";
import createTracker from "./tracker.ts";

/** The seam the extension registers through; omp's real type is not installed. */
interface RegisteredTool {
	name: string;
	description?: string;
	approval?: string;
	parameters?: Record<string, unknown>;
	loadMode?: string;
	execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
}
interface ToolResult {
	content: { type: string; text: string }[];
	details: object;
}

// Minimal fake of omp's extension API: capture registered tools, hand back the shape builder.
// Captured by the fake below so tests can pin what the extension writes/reads.
const setSessionNameCalls: string[] = [];
let currentSessionName: string | undefined;
let sessionNameFails = false;
// session_stop handlers, for tests that pin what `reported` gates.
const stopHandlers: Array<(...args: unknown[]) => unknown> = [];
// tool_result handlers: the session-file redaction of git host secrets.
const resultHandlers: Array<(...args: unknown[]) => unknown> = [];

function fakePi(
	tracker: typeof createTracker = createTracker,
): Record<string, RegisteredTool> {
	const tools: Record<string, RegisteredTool> = {};
	const chain = () => {
		// ponytail: the extension only builds shapes; execute reads params directly
		const s: Record<string, unknown> = {};
		s.optional = () => s;
		// Capture describe/enum/array payloads: the declared schema is the tool's contract.
		s.describe = (text: unknown) => {
			s.description = text;
			return s;
		};
		return s;
	};
	const pi = {
		zod: {
			object: (shape: Record<string, unknown>) => shape,
			enum: (values: unknown[]) => Object.assign(chain(), { values }),
			string: () => chain(),
			number: () => chain(),
			boolean: () => chain(),
			array: (element: unknown) => Object.assign(chain(), { element }),
		},
		registerTool: (def: object) => {
			const tool = def as RegisteredTool; // omp's registerTool passes an untyped definition record
			tools[tool.name] = tool;
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			if (event === "session_stop") stopHandlers.push(handler);
			if (event === "tool_result") resultHandlers.push(handler);
		},
		getSessionName: async () => {
			if (sessionNameFails) throw new Error("name lookup failed");
			return currentSessionName;
		},
		setSessionName: (name: string) => {
			setSessionNameCalls.push(name);
		},
	};
	tracker(pi as never);
	return tools;
}

const envKeys = [
	"OTTR_BOARD_URL",
	"OTTR_BOARD_TOKEN",
	"OTTR_PROJECT",
	"OTTR_TASK_ID",
	"OTTR_RETRO",
	"OTTR_REVIEW",
] as const;
function setEnv(v: Partial<Record<(typeof envKeys)[number], string>>) {
	for (const k of envKeys) if (v[k] !== undefined) process.env[k] = v[k];
}
// Bun runs test files in one process: never delete globals, restore them.
const realFetch = globalThis.fetch;
afterEach(() => {
	for (const k of envKeys) delete process.env[k];
	delete process.env.OTTR_SESSION_NAME;
	globalThis.fetch = realFetch;
	setSessionNameCalls.length = 0;
	currentSessionName = undefined;
	sessionNameFails = false;
	stopHandlers.length = 0;
	resultHandlers.length = 0;
});

const text = (r: ToolResult) => r.content[0]!.text;

// The refusal state is module-level: a static import always returns the cached instance,
// so each test imports a virgin module through a query suffix instead (test-only module
// loading boundary). No test may see a previous test's refusedOnce.
let freshModules = 0;
async function freshTools(): Promise<Record<string, RegisteredTool>> {
	stopHandlers.length = 0;
	const mod = await import(`./tracker.ts?refuse-${++freshModules}`);
	return fakePi(mod.default as typeof createTracker);
}

describe("report_outcome tool", () => {
	test("declares shots, so a reported screenshot survives the harness's schema", () => {
		expect(Object.keys(fakePi().report_outcome?.parameters ?? {})).toContain(
			"shots",
		);
	});

	test("declares dependsOn with a hint naming the hold behavior", () => {
		const tools = fakePi().report_outcome;
		const params = tools?.parameters ?? {};
		expect(Object.keys(params)).toContain("dependsOn");
		// unchecked cast: the fake schema shape is built in this file's harness, not external input
		const dependsOn = params.dependsOn as { description?: string };
		expect(dependsOn.description).toContain(
			"requeues the card in its current stage",
		);
	});

	test("description names dependsOn", () => {
		expect(fakePi().report_outcome?.description).toContain("dependsOn");
	});

	test("records an outcome that carries dependsOn", async () => {
		const tools = await freshTools();
		currentSessionName = "Hold for siblings";
		expect(
			text(
				await tools.report_outcome!.execute("t1", {
					status: "needs_you",
					summary: "blocked on fix",
					dependsOn: ["id1"],
				}),
			),
		).toBe("Outcome recorded: needs_you");
	});
});

describe("report_outcome refuses once while the session has no name", () => {
	const call = (tools: Record<string, RegisteredTool>) =>
		tools.report_outcome!.execute("t1", { status: "ready", summary: "done" });

	test("first call without a name throws the rename hint and leaves reported false", async () => {
		const tools = await freshTools();
		let err: unknown;
		try {
			await call(tools);
		} catch (e) {
			err = e;
		}
		expect((err as Error).message).toContain("rename");
		// reported stays false: session_stop still blocks for the missing outcome.
		const stop = stopHandlers[0]?.() as { decision?: string } | undefined;
		expect(stop?.decision).toBe("block");
	});

	test("rename, then a second call, records the second outcome", async () => {
		const tools = await freshTools();
		await expect(call(tools)).rejects.toThrow(/rename/);
		await tools.rename!.execute("t2", { title: "Fix the report gate" });
		expect(text(await call(tools))).toBe("Outcome recorded: ready");
	});

	test("a second call without a rename records the outcome", async () => {
		const tools = await freshTools();
		await expect(call(tools)).rejects.toThrow(/rename/);
		expect(text(await call(tools))).toBe("Outcome recorded: ready");
	});

	test("a named session records on the first call", async () => {
		currentSessionName = "Pinned review name";
		const tools = await freshTools();
		expect(text(await call(tools))).toBe("Outcome recorded: ready");
	});

	test("a getSessionName failure records on the first call", async () => {
		sessionNameFails = true;
		const tools = await freshTools();
		expect(text(await call(tools))).toBe("Outcome recorded: ready");
	});

	test("a retro run without a name records on the first call", async () => {
		setEnv({ OTTR_RETRO: "1" });
		const tools = await freshTools();
		expect(text(await call(tools))).toBe("Outcome recorded: ready");
	});
});

describe("create_task tool", () => {
	test("registers headless-safe like the other board tools", () => {
		const tools = fakePi();
		expect(tools.create_task).toBeDefined();
		expect(tools.create_task?.approval).toBe("read");
		expect(tools.create_task?.loadMode).toBe("essential");
	});

	test("posts the prompt to the project's tasks route with followUpOf, model and the board token", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_BOARD_TOKEN: "boot-token",
			OTTR_PROJECT: "ottr",
			OTTR_TASK_ID: "parent1",
		});
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(JSON.stringify({ id: "abc12345" }), { status: 200 });
		}) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", {
			prompt: "  implement the thing  ",
			model: " zai/glm ",
		});
		expect(seen!.url).toBe("http://127.0.0.1:4747/api/projects/ottr/tasks");
		expect(seen!.init.method).toBe("POST");
		expect(seen!.init.headers).toMatchObject({
			"content-type": "application/json",
			origin: "http://127.0.0.1:4747",
			"x-board-token": "boot-token",
		});
		expect(JSON.parse(String(seen!.init.body))).toEqual({
			prompt: "implement the thing",
			followUpOf: "parent1",
			model: "zai/glm",
		});
		expect(text(out)).toContain("abc12345");
	});

	test("omits the model key when none given", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://localhost:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		let body: unknown = null;
		globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
			body = JSON.parse(String(init.body));
			return new Response(JSON.stringify({ id: "x" }), { status: 200 });
		}) as unknown as typeof fetch;
		await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(body).toEqual({ prompt: "p", followUpOf: "t" });
	});

	test("without injected coordinates it refuses honestly and fetches nothing", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(text(out)).toContain("unavailable");
		expect(called).toBe(false);
	});

	test("rejects an empty or oversized prompt before any HTTP call", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		for (const prompt of ["   ", "x".repeat(20001)]) {
			const out = await fakePi().create_task!.execute("t1", { prompt });
			expect(text(out)).toContain("1-20000");
		}
		expect(called).toBe(false);
	});

	test("surfaces the board's error status and message", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "unknown followUpOf task" }), {
				status: 404,
			})) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(text(out)).toContain("HTTP 404");
		expect(text(out)).toContain("unknown followUpOf task");
	});

	test("reports an unreachable board without throwing", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		globalThis.fetch = (async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(text(out)).toContain("unreachable");
		expect(text(out)).toContain("connection refused");
	});
});

describe("propose_task tool", () => {
	// Module state `proposed` is process-global: run the never-setting tests first, then
	// consume the one-shot flag in the last test.
	test("absent without OTTR_RETRO so normal work runs never see it", () => {
		expect(fakePi().propose_task).toBeUndefined();
	});

	test("present with OTTR_RETRO and headless-safe like the other tools", () => {
		process.env.OTTR_RETRO = "1";
		const tool = fakePi().propose_task;
		expect(tool).toBeDefined();
		expect(tool?.approval).toBe("read");
		expect(tool?.loadMode).toBe("essential");
	});

	test("declares exactly prompt and model", () => {
		process.env.OTTR_RETRO = "1";
		expect(Object.keys(fakePi().propose_task?.parameters ?? {})).toEqual([
			"prompt",
			"model",
		]);
	});

	test("rejects a missing, blank, oversized prompt and a blank model", async () => {
		process.env.OTTR_RETRO = "1";
		const tools = fakePi();
		const bad: Record<string, unknown>[] = [
			{},
			{ prompt: "   " },
			{ prompt: "x".repeat(20001) },
			{ prompt: "p", model: "   " },
		];
		for (const params of bad) {
			const out = await tools.propose_task!.execute("t1", params);
			expect(text(out)).toMatch(/^Error: /);
		}
	});

	test("resolves locally once, then refuses the second call; create_task untouched", async () => {
		process.env.OTTR_RETRO = "1";
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const tools = fakePi();
		const out = await tools.propose_task!.execute("t1", {
			prompt: "  improve the thing  ",
		});
		expect(text(out)).toBe(
			"Recorded. Ottr files it as a held card when this retro ends.",
		);
		expect(fetched).toBe(false);
		const again = await tools.propose_task!.execute("t2", { prompt: "p" });
		expect(text(again)).toContain("only one proposal is allowed");
	});
});

describe("propose_task tool in review runs", () => {
	test("inlined descriptions match src/prompts.ts (retro and review)", async () => {
		process.env.OTTR_RETRO = "1";
		expect(fakePi().propose_task?.description).toBe(PROPOSE_TOOL_DESCRIPTION);
		process.env.OTTR_RETRO = undefined;
		process.env.OTTR_REVIEW = "1";
		expect(fakePi().propose_task?.description).toBe(
			REVIEW_PROPOSE_TOOL_DESCRIPTION,
		);
	});

	test("absent without either mode env", () => {
		expect(fakePi().propose_task).toBeUndefined();
	});

	test("declares prompt, model, rank and security; allows many calls", async () => {
		process.env.OTTR_REVIEW = "1";
		const tools = fakePi();
		expect(Object.keys(tools.propose_task?.parameters ?? {})).toEqual([
			"prompt",
			"model",
			"rank",
			"security",
		]);
		const first = await tools.propose_task!.execute("t1", {
			prompt: "Bug in src/a.ts",
			rank: 1,
		});
		expect(text(first)).toBe(
			"Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.",
		);
		// One finding per call: a second call records instead of refusing.
		const second = await tools.propose_task!.execute("t2", {
			prompt: "Another",
			rank: 2,
			security: "high",
		});
		expect(text(second)).toContain("Recorded.");
	});

	test("rejects a blank prompt and a bad rank", async () => {
		process.env.OTTR_REVIEW = "1";
		const tools = fakePi();
		for (const params of [
			{ prompt: "   " },
			{ prompt: "p", rank: 0 },
			{ prompt: "p", rank: 1.5 },
			{ prompt: "p", rank: "1" },
		]) {
			const out = await tools.propose_task!.execute("t1", params);
			expect(text(out)).toMatch(/^Error: /);
		}
	});
});

describe("arch-review changed-line coverage", () => {
	test("report_outcome declares exactly the parameters the runner reads", () => {
		expect(Object.keys(fakePi().report_outcome?.parameters ?? {})).toEqual([
			"status",
			"summary",
			"details",
			"question",
			"shots",
			"dependsOn",
		]);
	});

	test("ask declares the questions parameter", () => {
		expect(Object.keys(fakePi().ask?.parameters ?? {})).toEqual(["questions"]);
	});

	// Module state `asked` is process-global: the empty-questions branch is only
	// reachable before the first successful ask, so this test must run first.
	test("ask rejects empty and non-array questions before setting the flag", async () => {
		for (const questions of [[], "nope", undefined]) {
			const out = await fakePi().ask!.execute("t1", { questions });
			expect(text(out)).toBe("Error: questions must not be empty.");
		}
	});

	test("ask delivers questions and reports the pause", async () => {
		const out = await fakePi().ask!.execute("t1", {
			questions: [{ question: "Go left?", options: [{ label: "yes" }] }],
		});
		expect(text(out)).toBe(
			"Your question was delivered to the tracker user. The run is paused; the answer arrives as the next user message. End your turn now WITHOUT calling report_outcome (the tracker knows you are waiting).",
		);
	});

	test("ask refuses a second question while the first waits", async () => {
		const out = await fakePi().ask!.execute("t2", {
			questions: [{ question: "Again?", options: [{ label: "no" }] }],
		});
		expect(text(out)).toBe(
			"Error: one ask per turn. The first ask is already waiting for the user's answer. End your turn; ask the remaining questions after the answer arrives.",
		);
	});

	test("rename keeps an existing non-blank name untouched", async () => {
		currentSessionName = "Existing Name";
		const out = await fakePi().rename!.execute("t1", { title: "New Name" });
		expect(text(out)).toBe(
			'Session already named "Existing Name". Kept it; nothing to do.',
		);
		expect(setSessionNameCalls).toEqual([]);
	});

	test("rename treats a blank current name as unnamed", async () => {
		currentSessionName = "   ";
		const out = await fakePi().rename!.execute("t1", { title: "Fresh" });
		expect(setSessionNameCalls).toEqual(["Fresh"]);
		expect(text(out)).toBe('Session renamed to "Fresh".');
	});

	test("rename collapses whitespace and truncates to 80 characters", async () => {
		const out = await fakePi().rename!.execute("t1", {
			title: `  a   b\n\t c  ${"x".repeat(90)}  `,
		});
		expect(setSessionNameCalls).toEqual([`a b c ${"x".repeat(74)}`]);
		expect(text(out)).toBe(`Session renamed to "a b c ${"x".repeat(74)}".`);
	});

	test("rename rejects a non-string or blank title", async () => {
		for (const title of [42, "   ", "\n\t"]) {
			const out = await fakePi().rename!.execute("t1", { title });
			expect(text(out)).toBe("Error: title must be a non-empty string.");
		}
		expect(setSessionNameCalls).toEqual([]);
	});

	test("create_task declares exactly prompt, model and dependsOn", () => {
		expect(Object.keys(fakePi().create_task?.parameters ?? {})).toEqual([
			"prompt",
			"model",
			"dependsOn",
		]);
	});

	test("report_outcome status accepts exactly the four tracker statuses", () => {
		// The zod fake records the enum payload on the captured schema node.
		const status = (fakePi().report_outcome?.parameters?.status ?? {}) as {
			values?: string[];
		};
		expect(status.values).toEqual([
			"ready",
			"answered",
			"integrated",
			"needs_you",
		]);
	});

	test("ask describes the option description field and the options array", () => {
		// The zod fake records describe strings and array elements on the captured nodes.
		const questions = (fakePi().ask?.parameters?.questions ?? {}) as {
			element?: {
				options?: {
					element?: { description?: { description?: unknown } };
					description?: unknown;
				};
			};
		};
		expect(questions.element?.options?.element?.description?.description).toBe(
			"Optional explanation of the choice",
		);
		expect(questions.element?.options?.description).toBe(
			"2-5 answer choices; the user can also type a custom answer",
		);
	});

	test("create_task blocks the fetch when any blocking coordinate env var is missing", async () => {
		for (const missing of [
			"OTTR_BOARD_URL",
			"OTTR_PROJECT",
			"OTTR_TASK_ID",
		] as const) {
			let called = false;
			globalThis.fetch = (() => {
				called = true;
				return new Response(JSON.stringify({ id: "x" }), { status: 200 });
			}) as unknown as typeof fetch;
			setEnv({
				OTTR_BOARD_URL: "http://127.0.0.1:4747",
				OTTR_PROJECT: "p",
				OTTR_TASK_ID: "t",
			});
			delete process.env[missing];
			const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
			expect(text(out)).toContain("unavailable");
			expect(called).toBe(false);
		}
	});

	test("rename declares the title parameter", () => {
		expect(Object.keys(fakePi().rename?.parameters ?? {})).toEqual(["title"]);
	});

	test("create_task trims and filters dependsOn entries and sends them in the body", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		let body: unknown = null;
		globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
			body = JSON.parse(String(init.body));
			return new Response(JSON.stringify({ id: "x" }), { status: 200 });
		}) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", {
			prompt: "p",
			dependsOn: [" b ", "a", "", 42, null, "   "],
		});
		expect(body).toEqual({
			prompt: "p",
			followUpOf: "t",
			dependsOn: ["b", "a"],
		});
		expect(text(out)).toContain("x");
	});

	test("create_task omits the dependsOn key when the array is empty or absent", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		const bodies: unknown[] = [];
		globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
			bodies.push(JSON.parse(String(init.body)));
			return new Response(JSON.stringify({ id: "x" }), { status: 200 });
		}) as unknown as typeof fetch;
		await fakePi().create_task!.execute("t1", { prompt: "p", dependsOn: [] });
		await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(bodies).toEqual([
			{ prompt: "p", followUpOf: "t" },
			{ prompt: "p", followUpOf: "t" },
		]);
	});

	test("create_task URL-encodes the project in the tasks route and sends no token header when absent", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "my proj/x",
			OTTR_TASK_ID: "t",
		});
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(JSON.stringify({ id: "x" }), { status: 200 });
		}) as unknown as typeof fetch;
		await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(seen!.url).toBe(
			"http://127.0.0.1:4747/api/projects/my%20proj%2Fx/tasks",
		);
		expect(seen!.init.headers).toEqual({
			"content-type": "application/json",
			origin: "http://127.0.0.1:4747",
		});
	});

	test("create_task strings a non-Error rejection into the unreachable message", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		globalThis.fetch = (async () => {
			throw "boom";
		}) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(text(out)).toBe(
			"Error: the board at http://127.0.0.1:4747 is unreachable (boom). File no cards; report the blocker.",
		);
	});

	test("create_task reports a 200 with an unparseable body as not filed, without an error suffix", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		globalThis.fetch = (async () =>
			new Response("<html>not json</html>", {
				status: 200,
			})) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(text(out)).toBe(
			"Error: card not filed (HTTP 200). Fix the cause or report the blocker.",
		);
	});

	test("create_task omits the suffix when the error body is not a string", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: { code: 7 } }), {
				status: 500,
			})) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(text(out)).toBe(
			"Error: card not filed (HTTP 500). Fix the cause or report the blocker.",
		);
	});

	test("create_task rejects a non-string id even on an ok response", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ id: 99 }), {
				status: 200,
			})) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(text(out)).toContain("card not filed");
	});

	test("create_task reports the exact filed-card text with the board id", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ id: "card9" }), {
				status: 200,
			})) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(text(out)).toBe(
			"Card card9 filed and linked to this task. It starts when the scheduler picks it up. File more cards or continue; report_outcome as usual when done.",
		);
	});

	test("create_task treats blank injected coordinates as missing", async () => {
		setEnv({
			OTTR_BOARD_URL: "   ",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(text(out)).toContain("unavailable");
		expect(called).toBe(false);
	});
});

describe("git host secrets in tool results", () => {
	const token = "glpat-session-leak-0001";
	const keyDir = "/state/.tasks/ssh";
	test("a failed push that echoes a token-bearing URL is redacted before omp persists it", () => {
		process.env.OTTR_GIT_TOKEN_0 = token;
		process.env.GIT_SSH_COMMAND = `ssh -i '${keyDir}/projects/p' -o UserKnownHostsFile='${keyDir}/known_hosts' -o StrictHostKeyChecking=yes`;
		try {
			fakePi();
			const echoed = `fatal: unable to access 'https://oauth2:${token}@git.example.com/a/r.git/': 403\nLoad key "${keyDir}/projects/p": invalid format`;
			const out = resultHandlers[0]?.({
				type: "tool_result",
				toolName: "bash",
				content: [{ type: "text", text: echoed }],
				details: { output: echoed, exitCode: 128 },
				isError: true,
			}) as {
				content: { text: string }[];
				details: { output: string; exitCode: number };
			};
			// What omp writes to the session file is exactly this content and details.
			const persisted = JSON.stringify(out);
			expect(persisted).not.toContain(token);
			expect(persisted).not.toContain(keyDir);
			expect(out.content[0]?.text).toContain(
				"https://oauth2:[REDACTED]@git.example.com",
			);
			expect(out.details.exitCode).toBe(128);
		} finally {
			delete process.env.OTTR_GIT_TOKEN_0;
			delete process.env.GIT_SSH_COMMAND;
		}
	});

	test("tokens with quotes and backslashes are found in the raw text, not its JSON form", () => {
		for (const tok of [
			'tok"en-with-quote',
			"tok\\en-back\\slash",
			'mix\\"ed-0001',
		]) {
			process.env.OTTR_GIT_TOKEN_0 = tok;
			try {
				fakePi();
				const echoed = `fatal: auth failed for ${tok}`;
				const out = resultHandlers.at(-1)?.({
					type: "tool_result",
					content: [{ type: "text", text: echoed }],
					details: { output: echoed },
				}) as { content: { text: string }[]; details: { output: string } };
				expect(out).toBeDefined();
				expect(out.content[0]?.text).toBe("fatal: auth failed for [REDACTED]");
				expect(out.details.output).not.toContain(tok);
			} finally {
				delete process.env.OTTR_GIT_TOKEN_0;
			}
		}
	});

	test("results without a secret, and runs without git host env, stay untouched", () => {
		fakePi();
		const ev = { content: [{ type: "text", text: "ok" }], details: undefined };
		expect(resultHandlers[0]?.(ev)).toBeUndefined();
		process.env.OTTR_GIT_TOKEN_0 = token;
		try {
			expect(resultHandlers[0]?.(ev)).toBeUndefined();
		} finally {
			delete process.env.OTTR_GIT_TOKEN_0;
		}
	});
});

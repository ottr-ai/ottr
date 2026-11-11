import { afterEach, describe, expect, test } from "bun:test";
import {
	PROPOSE_TOOL_DESCRIPTION,
	REVIEW_PROPOSE_TOOL_DESCRIPTION,
} from "../src/prompts.ts";
import createTracker from "./tracker.ts";

// Hermeticity: every named omp session exports OTTR_SESSION_NAME into its child shells, and an
// ambient value would flip the refusal tests below into the pinned-name path. tracker.ts reads
// the pin per call (pinnedName), so clearing it here before any test runs is enough; tests that
// need a pin set their own.
delete process.env.OTTR_SESSION_NAME;

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
// omp hands extensions a stub whose action methods throw until its session
// initialize() patches them (OTTR-418); tests flip this to model that window.
let runtimeReady = true;
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
			if (!runtimeReady)
				throw new Error(
					"Extension runtime not initialized. Action methods cannot be called during extension loading.",
				);
			if (sessionNameFails) throw new Error("name lookup failed");
			return currentSessionName;
		},
		setSessionName: async (name: string) => {
			if (!runtimeReady)
				throw new Error(
					"Extension runtime not initialized. Action methods cannot be called during extension loading.",
				);
			setSessionNameCalls.push(name);
			currentSessionName = name;
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
	"OTTR_TRENDING",
	"OTTR_MODELS",
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
	runtimeReady = true;
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

	test("a trending scout run without a name records on the first call", async () => {
		setEnv({ OTTR_TRENDING: "1" });
		const tools = await freshTools();
		expect(text(await call(tools))).toBe("Outcome recorded: ready");
	});
});

describe("report_outcome applies the pinned session name", () => {
	const call = (tools: Record<string, RegisteredTool>) =>
		tools.report_outcome!.execute("t1", { status: "ready", summary: "done" });
	// The retry loop paces itself with real setTimeout calls, and bun:test 1.4.4's fake
	// timers lack advanceTimersByTimeAsync, so tests wait out one real 500 ms attempt gap.
	const settle = async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 600);
		await promise;
	};

	test("an unnamed pinned session records at once and applies the pin", async () => {
		// Padded: pins the trim in tracker.ts pinnedName.
		process.env.OTTR_SESSION_NAME = " Board check ";
		runtimeReady = false; // the load-time attempt dies on omp's stub, as in OTTR-413
		const tools = await freshTools();
		await settle();
		runtimeReady = true;
		expect(text(await call(tools))).toBe("Outcome recorded: ready");
		expect(setSessionNameCalls).toEqual(["Board check"]);
		expect(currentSessionName).toBe("Board check");
		await settle(); // let the deferred retry loop finish so no timer leaks
	});

	test("the deferred retry names the session once omp's runtime is ready", async () => {
		process.env.OTTR_SESSION_NAME = "Review";
		runtimeReady = false;
		const tools = await freshTools();
		await settle(); // the load-time attempt fires here and dies on the stub
		expect(setSessionNameCalls).toEqual([]);
		runtimeReady = true;
		await settle();
		expect(setSessionNameCalls).toEqual(["Review"]);
		expect(currentSessionName).toBe("Review");
		expect(text(await call(tools))).toBe("Outcome recorded: ready");
	});

	test("a named pinned session is not renamed", async () => {
		process.env.OTTR_SESSION_NAME = "Review";
		runtimeReady = false;
		await freshTools();
		await settle(); // the load-time attempt fires here and dies on the stub
		currentSessionName = "Agent named it first";
		runtimeReady = true;
		await settle(); // the retry sees the agent's name and leaves it alone
		expect(setSessionNameCalls).toEqual([]);
	});

	test("an unnamed session without a pinned name still refuses once", async () => {
		const tools = await freshTools();
		await expect(call(tools)).rejects.toThrow(/rename/);
		// Yield one macrotask: a wrongly scheduled load-time naming loop (setTimeout 0) then
		// fires before the assertion, and with no pin none may run, let alone set an empty
		// name — this kills the registration-guard mutants at tracker.ts's pinnedName guard.
		// Real scheduling, not fake timers: bun:test 1.4.4's fake timers lack
		// advanceTimersByTimeAsync (see the settle helper above).
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve);
		await promise;
		expect(setSessionNameCalls).toEqual([]);
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

	test("refuses a model that is an agent type, not a model id, and fetches nothing", async () => {
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: "p",
			model: "sonic",
		});
		expect(text(out)).toBe(
			"Error: sonic is not a model; omit model to use the board default, or pass provider/model such as anthropic/claude-opus-5-5.",
		);
		expect(called).toBe(false);
	});

	test("surfaces the board's catalog refusal with its fix", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					error:
						"model zai/retired: unknown model zai/retired. Omit model to use the board default, or pick provider/model from the New task model list",
				}),
				{ status: 400 },
			)) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", {
			prompt: "p",
			model: "zai/retired",
		});
		expect(text(out)).toContain("HTTP 400");
		expect(text(out)).toContain("unknown model zai/retired");
	});

	test("project param files into the named project's route and still links back", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(JSON.stringify({ id: "abc12345" }), { status: 200 });
		}) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", {
			prompt: "p",
			project: " agent-data ",
		});
		expect(seen!.url).toBe(
			"http://127.0.0.1:4747/api/projects/agent-data/tasks",
		);
		expect(JSON.parse(String(seen!.init.body))).toEqual({
			prompt: "p",
			followUpOf: "t",
		});
		expect(text(out)).toContain("abc12345");
		expect(text(out)).toContain("agent-data");
	});

	test("without project the card files in its own project", async () => {
		setEnv({
			OTTR_BOARD_URL: "http://127.0.0.1:4747",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(JSON.stringify({ id: "abc12345" }), { status: 200 });
		}) as unknown as typeof fetch;
		const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
		expect(seen!.url).toBe("http://127.0.0.1:4747/api/projects/p/tasks");
		expect(text(out)).toContain("abc12345");
	});

	test("a blank project refuses before any HTTP call", async () => {
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: "p",
			project: "   ",
		});
		expect(text(out)).toContain("non-empty");
		expect(called).toBe(false);
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

describe("trending scout tools", () => {
	const scoutEnv = {
		OTTR_BOARD_URL: "http://127.0.0.1:4747",
		OTTR_BOARD_TOKEN: "boot-token",
		OTTR_PROJECT: "ottr",
		OTTR_TASK_ID: "scout1",
		OTTR_TRENDING: "1",
	};

	test("absent without OTTR_TRENDING so other runs never see them", () => {
		const tools = fakePi();
		expect(tools.propose_repo).toBeUndefined();
		expect(tools.judge_repo).toBeUndefined();
	});

	test("present with OTTR_TRENDING and headless-safe like the other board tools", () => {
		setEnv({ OTTR_TRENDING: "1" });
		const tools = fakePi();
		for (const name of ["propose_repo", "judge_repo"]) {
			expect(tools[name]?.approval).toBe("read");
			expect(tools[name]?.loadMode).toBe("essential");
		}
		expect(Object.keys(tools.propose_repo?.parameters ?? {})).toEqual([
			"repo",
			"title",
			"prompt",
		]);
		expect(Object.keys(tools.judge_repo?.parameters ?? {})).toEqual([
			"repo",
			"verdict",
			"reason",
		]);
	});

	test("propose_repo posts a filed verdict for this scout with the board token", async () => {
		setEnv(scoutEnv);
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(JSON.stringify({ ok: true, id: "OTTR-9" }), {
				status: 200,
			});
		}) as unknown as typeof fetch;
		const out = await fakePi().propose_repo!.execute("t1", {
			repo: " acme/widget ",
			title: " Adopt widget for the board ",
			prompt: "  Header\nFit\nRisks\nDraft  ",
		});
		expect(seen!.url).toBe(
			"http://127.0.0.1:4747/api/projects/ottr/trending/verdicts",
		);
		expect(seen!.init.method).toBe("POST");
		expect(seen!.init.headers).toMatchObject({
			"content-type": "application/json",
			origin: "http://127.0.0.1:4747",
			"x-board-token": "boot-token",
		});
		expect(JSON.parse(String(seen!.init.body))).toEqual({
			scoutId: "scout1",
			repo: "acme/widget",
			verdict: "filed",
			reason: "Adopt widget for the board",
			prompt: "Header\nFit\nRisks\nDraft",
			title: "Adopt widget for the board",
		});
		expect(text(out)).toBe("Proposal OTTR-9 filed for acme/widget.");
	});

	test("judge_repo posts its verdict and reason", async () => {
		setEnv(scoutEnv);
		let body: unknown = null;
		globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
			body = JSON.parse(String(init.body));
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as unknown as typeof fetch;
		const out = await fakePi().judge_repo!.execute("t1", {
			repo: "acme/widget",
			verdict: "deferred",
			reason: " fits, but the cap is used up ",
		});
		expect(body).toEqual({
			scoutId: "scout1",
			repo: "acme/widget",
			verdict: "deferred",
			reason: "fits, but the cap is used up",
		});
		expect(text(out)).toBe("Recorded deferred for acme/widget.");
	});

	test("the board's refusal and an unreachable board come back as Error text, never a throw", async () => {
		setEnv(scoutEnv);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "proposal cap reached" }), {
				status: 409,
			})) as unknown as typeof fetch;
		const refused = await fakePi().propose_repo!.execute("t1", {
			repo: "acme/widget",
			prompt: "p",
		});
		expect(text(refused)).toStartWith("Error: ");
		expect(text(refused)).toContain("HTTP 409");
		expect(text(refused)).toContain("proposal cap reached");
		globalThis.fetch = (async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch;
		const down = await fakePi().judge_repo!.execute("t1", {
			repo: "acme/widget",
			verdict: "no_fit",
			reason: "r",
		});
		expect(text(down)).toContain("unreachable");
		expect(text(down)).toContain("connection refused");
	});

	test("bad params refuse before any HTTP call", async () => {
		setEnv(scoutEnv);
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const tools = fakePi();
		for (const params of [
			{ repo: "widget", prompt: "p" },
			{ repo: "acme/widget", prompt: "   " },
			{ repo: "acme/widget", prompt: "p", title: "x".repeat(201) },
		])
			expect(text(await tools.propose_repo!.execute("t1", params))).toStartWith(
				"Error: ",
			);
		for (const params of [
			{ repo: "acme/widget", verdict: "filed", reason: "r" },
			{ repo: "acme/widget", verdict: "no_fit", reason: "  " },
			{ repo: "acme/widget", verdict: "no_fit", reason: "x".repeat(501) },
		])
			expect(text(await tools.judge_repo!.execute("t1", params))).toStartWith(
				"Error: ",
			);
		expect(called).toBe(false);
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

	test("declares exactly prompt, model, project and the five summary fields", () => {
		process.env.OTTR_RETRO = "1";
		expect(Object.keys(fakePi().propose_task?.parameters ?? {})).toEqual([
			"prompt",
			"model",
			"project",
			"whatChanges",
			"why",
			"gain",
			"risk",
			"check",
		]);
	});

	test("rejects a missing, blank, oversized prompt and a blank model", async () => {
		process.env.OTTR_RETRO = "1";
		// The board injects the project names a retro run checks proposal
		// projects against; the list stays set for the accept test below.
		process.env.OTTR_PROJECTS = "alate\nagent-data\nottr";
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
		const blank = await tools.propose_task!.execute("t1", {
			prompt: "p",
			project: "   ",
		});
		expect(text(blank)).toBe(
			"Error: project must be a non-empty string when given.",
		);
	});

	test("refuses a model that is an agent type, not a model id, and spends no proposal", async () => {
		process.env.OTTR_RETRO = "1";
		const out = await fakePi().propose_task!.execute("t1", {
			prompt: "p",
			model: "sonic",
		});
		expect(text(out)).toBe(
			"Error: sonic is not a model; omit model to use the board default, or pass provider/model such as anthropic/claude-opus-5-5.",
		);
	});

	test("refuses a shaped model the run's catalog does not name, level misses included", async () => {
		process.env.OTTR_RETRO = "1";
		process.env.OTTR_MODELS = "zai/glm-5.3-flash\nanthropic/claude-opus-5-5";
		const tools = fakePi();
		const unknown = await tools.propose_task!.execute("t1", {
			prompt: "p",
			model: "zai/no-such-model",
		});
		expect(text(unknown)).toBe(
			"Error: model zai/no-such-model: unknown model zai/no-such-model. Omit model to use the board default, or pick provider/model from the New task model list.",
		);
		const level = await tools.propose_task!.execute("t1", {
			prompt: "p",
			model: "zai/glm-5.3-flash:turbo",
		});
		expect(text(level)).toContain(
			"unknown thinking level (use one of off, minimal",
		);
	});

	test("rejects non-string, blank and over-400 summary fields", async () => {
		process.env.OTTR_RETRO = "1";
		const tools = fakePi();
		const bad: Record<string, unknown>[] = [
			{ prompt: "p", whatChanges: 7 },
			{ prompt: "p", whatChanges: "   " },
			{ prompt: "p", why: "x".repeat(401) },
			{ prompt: "p", gain: "" },
			{ prompt: "p", risk: {} },
			{ prompt: "p", check: "x".repeat(401) },
		];
		for (const params of bad) {
			const out = await tools.propose_task!.execute("t1", params);
			expect(text(out)).toMatch(
				/^Error: (whatChanges|why|gain|risk|check) must be a string of 1-400 characters \(trimmed\) when given\.$/,
			);
		}
	});

	test("accepts all five summary fields and resolves locally once, then refuses the second call; create_task untouched", async () => {
		process.env.OTTR_RETRO = "1";
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const tools = fakePi();
		// An unknown name fails the call with the board's list and spends no
		// proposal lock: the retry with a listed name records below.
		const unknown = await tools.propose_task!.execute("t1", {
			prompt: "improve the thing",
			project: "no-such-project",
		});
		expect(text(unknown)).toBe(
			'Error: unknown project "no-such-project". Known projects: alate, agent-data, ottr. Propose again with one of these projects, or without one.',
		);
		const out = await tools.propose_task!.execute("t1", {
			prompt: "  improve the thing  ",
			project: "agent-data",
			whatChanges: "edit prompts.ts",
			why: "OTTR-1 duplicated text",
			gain: "200 characters per card",
			risk: "none found",
			check: "bun test",
		});
		expect(text(out)).toBe(
			"Recorded. Ottr files it as a held card when this retro ends.",
		);
		expect(fetched).toBe(false);
		const again = await tools.propose_task!.execute("t2", { prompt: "p" });
		expect(text(again)).toContain("only one proposal is allowed");
		delete process.env.OTTR_PROJECTS;
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

	test("a catalog model with a thinking level records; without the catalog env the shape check stands alone", async () => {
		process.env.OTTR_REVIEW = "1";
		process.env.OTTR_MODELS = "zai/glm-5.3-flash\nanthropic/claude-opus-5-5";
		const tools = fakePi();
		const levelled = await tools.propose_task!.execute("t1", {
			prompt: "Bug in src/a.ts",
			model: "zai/glm-5.3-flash:high",
			rank: 1,
		});
		expect(text(levelled)).toContain("Recorded.");
		// An old board injects no OTTR_MODELS: the record-time check degrades to the
		// shape rule, and turn start remains the backstop.
		delete process.env.OTTR_MODELS;
		const shaped = await tools.propose_task!.execute("t2", {
			prompt: "Another",
			model: "zai/no-such-model",
			rank: 2,
		});
		expect(text(shaped)).toContain("Recorded.");
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

	test("create_task declares exactly prompt, model, project and dependsOn", () => {
		expect(Object.keys(fakePi().create_task?.parameters ?? {})).toEqual([
			"prompt",
			"model",
			"project",
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

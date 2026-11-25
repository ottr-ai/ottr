import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROPOSE_TOOL_DESCRIPTION,
	REVIEW_PROPOSE_TOOL_DESCRIPTION,
} from "../src/prompts.ts";
import { applyEvent, newEventState } from "../src/runner.ts";
import { ProjectStore } from "../src/store.ts";
import { CARD_ENV_NOTE } from "../src/tokens.ts";
import { VM_VALIDATE } from "../src/vmValidateShared.ts";
import createTracker, { hasAcceptanceSection } from "./tracker.ts";

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
// before_agent_start handlers: the card-env guidance injected into the system prompt.
const startHandlers: Array<(...args: unknown[]) => unknown> = [];

function fakePi(
	tracker: typeof createTracker = createTracker,
	setSessionNameHook?: (name: string) => Promise<void>,
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
			if (event === "before_agent_start") startHandlers.push(handler);
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
			if (setSessionNameHook) {
				// The hook replaces the capture: it writes the live shape omp writes, so a
				// test can run the tool's write through the real readers downstream.
				await setSessionNameHook(name);
				return;
			}
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
	"OTTR_RUN_TOKEN",
	"OTTR_RETRO",
	"OTTR_REVIEW",
	"OTTR_TRENDING",
	"OTTR_MODELS",
	"OTTR_VM_RUNNER_URL",
	"OTTR_CARD_ENV_NOTE",
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
	startHandlers.length = 0;
});

// The sandbox staging signature: <project>/validate-jobs/<id>. The belt root may
// legally carry other OTTR_DATA_DIR consumers — ProjectStore adopts
// <dataRoot>/<store name> per board entry — so only this signature names a leak.
function sandboxStageDirs(root: string): string[] {
	const out: string[] = [];
	for (const project of readdirSync(root, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		for (const leaf of readdirSync(join(root, project.name), {
			withFileTypes: true,
		}))
			if (leaf.isDirectory() && leaf.name === "validate-jobs")
				out.push(join(project.name, leaf.name));
	}
	return out;
}

// Belt against /data: merge and review turns run bun test inside the server
// container, where OTTR_DATA_DIR is the board's live data root. The sandbox_run
// execute tests set their own data root, but a future staging call that drops
// it would consult the ambient env — and the afterEach above deletes it after
// every test, so this file re-establishes the belt root before every test. The
// sandbox data guard (src/sandboxRunDataGuard.test.ts) provides
// OTTR_TEST_DATA_ROOT: the belt then IS the guard's watched dir, so such a call
// lands there and fails both this file's afterAll and the guard.
const providedRoot = process.env.OTTR_TEST_DATA_ROOT;
const beltDataRoot =
	providedRoot ?? mkdtempSync(join(tmpdir(), "ottr-tracker-ambient-"));
// Only remove and restore what this file created; the guard owns its own dir.
const ownsRoot = providedRoot === undefined;
const savedDataDir = process.env.OTTR_DATA_DIR;
beforeEach(() => {
	process.env.OTTR_DATA_DIR = beltDataRoot;
});
afterAll(() => {
	// Read, restore, remove, then assert: a failure here must not orphan the dir.
	const staged = sandboxStageDirs(beltDataRoot);
	if (savedDataDir === undefined) delete process.env.OTTR_DATA_DIR;
	else process.env.OTTR_DATA_DIR = savedDataDir;
	if (ownsRoot)
		rmSync(beltDataRoot, { recursive: true, force: true, maxRetries: 5 });
	// Nothing may stage through the ambient env; the execute tests own their root.
	expect(staged).toEqual([]);
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

// OTTR-850: create_task and propose_task refuse a prompt without an Acceptance
// section, so every fixture prompt that reaches the tools carries this tail.
const acceptance = "\n\n## Acceptance\n- bun test passes";

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
			prompt: `  implement the thing  ${acceptance}`,
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
			prompt: `implement the thing  ${acceptance}`,
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
		await fakePi().create_task!.execute("t1", { prompt: `p${acceptance}` });
		expect(body).toEqual({ prompt: `p${acceptance}`, followUpOf: "t" });
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
			prompt: `p${acceptance}`,
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
			prompt: `p${acceptance}`,
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
			prompt: `p${acceptance}`,
			project: " agent-data ",
		});
		expect(seen!.url).toBe(
			"http://127.0.0.1:4747/api/projects/agent-data/tasks",
		);
		expect(JSON.parse(String(seen!.init.body))).toEqual({
			prompt: `p${acceptance}`,
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: `p${acceptance}`,
		});
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
			prompt: `p${acceptance}`,
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: `p${acceptance}`,
		});
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: `p${acceptance}`,
		});
		expect(text(out)).toContain("unreachable");
		expect(text(out)).toContain("connection refused");
	});

	test("refuses a prompt without an Acceptance section and files no card", async () => {
		// The seeded URL is the listener's own host and port, so a wrongly sent
		// request is observable on the wire and its count must stay zero.
		let received = 0;
		const listener = Bun.serve({
			port: 0,
			fetch: () => {
				received++;
				return new Response(JSON.stringify({ id: "x" }), { status: 200 });
			},
		});
		setEnv({
			OTTR_BOARD_URL: `http://localhost.:${listener.port}`,
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t",
		});
		try {
			const out = await fakePi().create_task!.execute("t1", { prompt: "p" });
			expect(text(out)).toBe(
				'Error: the prompt needs an "Acceptance" section with at least one observable check (a command to run or a result to see). Add it and call create_task again.',
			);
			expect(received).toBe(0);
		} finally {
			listener.stop(true);
		}
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

	test("declares exactly prompt, model, project, the five summary fields and decision", () => {
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
			"decision",
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
			{ prompt: `p${acceptance}`, model: "   " },
		];
		for (const params of bad) {
			const out = await tools.propose_task!.execute("t1", params);
			expect(text(out)).toMatch(/^Error: /);
		}
		const blank = await tools.propose_task!.execute("t1", {
			prompt: `p${acceptance}`,
			project: "   ",
		});
		expect(text(blank)).toBe(
			"Error: project must be a non-empty string when given.",
		);
	});

	test("refuses a model that is an agent type, not a model id, and spends no proposal", async () => {
		process.env.OTTR_RETRO = "1";
		const out = await fakePi().propose_task!.execute("t1", {
			prompt: `p${acceptance}`,
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
			prompt: `p${acceptance}`,
			model: "zai/no-such-model",
		});
		expect(text(unknown)).toBe(
			"Error: model zai/no-such-model: unknown model zai/no-such-model. Omit model to use the board default, or pick provider/model from the New task model list.",
		);
		const level = await tools.propose_task!.execute("t1", {
			prompt: `p${acceptance}`,
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
			{ prompt: `p${acceptance}`, whatChanges: 7 },
			{ prompt: `p${acceptance}`, whatChanges: "   " },
			{ prompt: `p${acceptance}`, why: "x".repeat(401) },
			{ prompt: `p${acceptance}`, gain: "" },
			{ prompt: `p${acceptance}`, risk: {} },
			{ prompt: `p${acceptance}`, check: "x".repeat(401) },
			{ prompt: `p${acceptance}`, decision: "  " },
			{ prompt: `p${acceptance}`, decision: "x".repeat(401) },
		];
		for (const params of bad) {
			const out = await tools.propose_task!.execute("t1", params);
			expect(text(out)).toMatch(
				/^Error: (whatChanges|why|gain|risk|check|decision) must be a string of 1-400 characters \(trimmed\) when given\.$/,
			);
		}
	});

	test("accepts all five summary fields and resolves locally once, then refuses the second call; create_task untouched", async () => {
		process.env.OTTR_RETRO = "1";
		// The board's project list this run proposes against; set here, not inherited
		// from an earlier test's value (OTTR-1180: the suite env belt restores the env
		// after each test, so a leaked value no longer reaches this call).
		process.env.OTTR_PROJECTS = "alate\nagent-data\nottr";
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const tools = fakePi();
		// An unknown name fails the call with the board's list and spends no
		// proposal lock: the retry with a listed name records below.
		const unknown = await tools.propose_task!.execute("t1", {
			prompt: `improve the thing${acceptance}`,
			project: "no-such-project",
		});
		expect(text(unknown)).toBe(
			'Error: unknown project "no-such-project". Known projects: alate, agent-data, ottr. Propose again with one of these projects, or without one.',
		);
		const out = await tools.propose_task!.execute("t1", {
			prompt: `  improve the thing  ${acceptance}`,
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

	test("refuses a proposal without an Acceptance section and spends nothing", async () => {
		process.env.OTTR_RETRO = "1";
		// A virgin module copy: the refusal must leave the one-shot flag unspent,
		// which the recording follow-up call proves.
		const tools = await freshTools();
		const refused = await tools.propose_task!.execute("t1", { prompt: "p" });
		expect(text(refused)).toBe(
			'Error: the prompt needs an "Acceptance" section with at least one observable check (a command to run or a result to see). Add it and call propose_task again.',
		);
		const ok = await tools.propose_task!.execute("t2", {
			prompt: `p${acceptance}`,
		});
		expect(text(ok)).toBe(
			"Recorded. Ottr files it as a held card when this retro ends.",
		);
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
			prompt: `Bug in src/a.ts${acceptance}`,
			model: "zai/glm-5.3-flash:high",
			rank: 1,
		});
		expect(text(levelled)).toContain("Recorded.");
		// An old board injects no OTTR_MODELS: the record-time check degrades to the
		// shape rule, and turn start remains the backstop.
		delete process.env.OTTR_MODELS;
		const shaped = await tools.propose_task!.execute("t2", {
			prompt: `Another${acceptance}`,
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
			prompt: `Bug in src/a.ts${acceptance}`,
			rank: 1,
		});
		expect(text(first)).toBe(
			"Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.",
		);
		// One finding per call: a second call records instead of refusing.
		const second = await tools.propose_task!.execute("t2", {
			prompt: `Another${acceptance}`,
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
			{ prompt: `p${acceptance}`, rank: 0 },
			{ prompt: `p${acceptance}`, rank: 1.5 },
			{ prompt: `p${acceptance}`, rank: "1" },
		]) {
			const out = await tools.propose_task!.execute("t1", params);
			expect(text(out)).toMatch(/^Error: /);
		}
	});

	test("refuses a finding without an Acceptance section and records nothing", async () => {
		process.env.OTTR_REVIEW = "1";
		const tools = await freshTools();
		const refused = await tools.propose_task!.execute("t1", { prompt: "p" });
		expect(text(refused)).toBe(
			'Error: the prompt needs an "Acceptance" section with at least one observable check (a command to run or a result to see). Add it and call propose_task again.',
		);
		const ok = await tools.propose_task!.execute("t2", {
			prompt: `p${acceptance}`,
			rank: 1,
		});
		expect(text(ok)).toBe(
			"Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.",
		);
	});
});

describe("hasAcceptanceSection", () => {
	test("a heading or bold line with a body opens the section", () => {
		expect(
			hasAcceptanceSection("Add the gate\n\n## Acceptance\n- bun test passes"),
		).toBe(true);
		expect(
			hasAcceptanceSection("Add the gate\n\n### acceptance criteria\nbun test"),
		).toBe(true);
		expect(
			hasAcceptanceSection("Add the gate\n\n**Acceptance**\nbun test"),
		).toBe(true);
		expect(hasAcceptanceSection("**Acceptance**: bun test passes")).toBe(true);
	});

	test("no section, an empty section, or a next heading is false", () => {
		expect(hasAcceptanceSection("no acceptance here")).toBe(false);
		expect(hasAcceptanceSection("## Acceptance\n## Follow-up")).toBe(false);
		expect(hasAcceptanceSection("## Acceptance\n\n   \n")).toBe(false);
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
			"prBody",
			"followUp",
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

	test("ask delivers mixed questions with one without options and reports the pause", async () => {
		const out = await fakePi().ask!.execute("t1", {
			questions: [
				{ question: "Go left?", options: [{ label: "yes" }] },
				{ question: "Name it?" },
			],
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

	test("rename with the session's current title keeps it untouched", async () => {
		currentSessionName = "Existing Name";
		const out = await fakePi().rename!.execute("t1", {
			title: "Existing Name",
		});
		expect(text(out)).toBe(
			'Session already named "Existing Name". Kept it; nothing to do.',
		);
		expect(setSessionNameCalls).toEqual([]);
	});

	// OTTR-912: the runner pins the draft title as the session name, so a name almost
	// always exists when the agent renames. The pre-fix early return made that rename a
	// no-op, so no title_change record ever reached the session and the card never saw
	// the agent's work title.
	test("rename with a different title replaces the pinned name", async () => {
		currentSessionName = "Add TikTok link check?";
		const out = await fakePi().rename!.execute("t1", {
			title: "Evaluate check idea from TikTok video",
		});
		expect(setSessionNameCalls).toEqual([
			"Evaluate check idea from TikTok video",
		]);
		expect(text(out)).toBe(
			'Session renamed to "Evaluate check idea from TikTok video".',
		);
	});

	// The live path end to end: the tool's write lands in a real omp-format session
	// file, and the store's title ladder lifts it onto the card (OTTR-912).
	test("a rename reaches the card through a real session file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rename-live-"));
		const store = await ProjectStore.open(dir);
		try {
			const sid = "cccc0000-0000-0000-0000-000000009901";
			const task = await store.updateTask(
				(await store.createTask("live rename path")).id,
				{ sessionId: sid },
			);
			// The runner pins the generated draft title; omp applies it to the session,
			// which writes line 1 and the first title_change record.
			await store.nameTask(task.id, "Add TikTok link check?");
			mkdirSync(store.sessionsDir, { recursive: true });
			const file = join(
				store.sessionsDir,
				`2026-09-27T10-00-00-000Z_${sid}.jsonl`,
			);
			writeFileSync(
				file,
				'{"type":"title","v":1,"title":"Add TikTok link check?"}\n{"type":"session"}\n{"type":"title_change","title":"Add TikTok link check?"}\n',
			);
			currentSessionName = "Add TikTok link check?";
			const tools = fakePi(createTracker, async (name) =>
				writeFileSync(
					file,
					`{"type":"title","v":1,"title":${JSON.stringify(name)}}\n{"type":"session"}\n{"type":"title_change","title":"Add TikTok link check?"}\n{"type":"title_change","title":${JSON.stringify(name)}}\n`,
				),
			);
			const out = await tools.rename!.execute("t1", {
				title: "Evaluate check idea from TikTok video",
			});
			expect(text(out)).toBe(
				'Session renamed to "Evaluate check idea from TikTok video".',
			);
			expect(await store.frozenTitle((await store.getTask(task.id))!)).toBe(
				"Evaluate check idea from TikTok video",
			);
		} finally {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
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

	test("report_outcome status accepts exactly the five tracker statuses", () => {
		// The zod fake records the enum payload on the captured schema node.
		const status = (fakePi().report_outcome?.parameters?.status ?? {}) as {
			values?: string[];
		};
		expect(status.values).toEqual([
			"ready",
			"answered",
			"integrated",
			"needs_you",
			"superseded",
		]);
	});

	test("followUp describes the superseded close's follow-up card id", () => {
		const params = fakePi().report_outcome?.parameters ?? {};
		expect(Object.keys(params)).toContain("followUp");
		// unchecked cast: the fake schema shape is built in this file's harness, not external input
		const followUp = params.followUp as { description?: string };
		expect(followUp.description).toContain("Superseded merge turns only");
		expect(followUp.description).toContain("parks the card instead of closing");
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
			"2-5 answer choices; omit for a free-text question the user answers by typing one line",
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
			prompt: `p${acceptance}`,
			dependsOn: [" b ", "a", "", 42, null, "   "],
		});
		expect(body).toEqual({
			prompt: `p${acceptance}`,
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
		await fakePi().create_task!.execute("t1", {
			prompt: `p${acceptance}`,
			dependsOn: [],
		});
		await fakePi().create_task!.execute("t1", { prompt: `p${acceptance}` });
		expect(bodies).toEqual([
			{ prompt: `p${acceptance}`, followUpOf: "t" },
			{ prompt: `p${acceptance}`, followUpOf: "t" },
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
		await fakePi().create_task!.execute("t1", { prompt: `p${acceptance}` });
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: `p${acceptance}`,
		});
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: `p${acceptance}`,
		});
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: `p${acceptance}`,
		});
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: `p${acceptance}`,
		});
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
		const out = await fakePi().create_task!.execute("t1", {
			prompt: `p${acceptance}`,
		});
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

// OTTR-863: omp's eval kernel mints nested `tool.<name>` call ids `js-<name>-<uuid>`.
// The runner reads board tools only from direct tool_execution events, so an eval call's
// success text would be a false success the board never sees. Each event-riding board tool
// refuses the nested call; tools with real side effects (create_task, rename, the trending
// POSTs) keep working through eval.
describe("board tools called through the eval kernel", () => {
	const evalId = (name: string) => `js-${name}-${crypto.randomUUID()}`;

	test("two eval propose_task calls and one eval report_outcome refuse; direct calls still record", async () => {
		process.env.OTTR_REVIEW = "1";
		const tools = await freshTools();
		for (const prompt of ["First finding", "Second finding"])
			expect(
				text(
					await tools.propose_task!.execute(evalId("propose_task"), {
						prompt,
						rank: 1,
					}),
				),
			).toContain("Call propose_task directly, not through eval");
		expect(
			text(
				await tools.report_outcome!.execute(evalId("report_outcome"), {
					status: "ready",
					summary: "s",
				}),
			),
		).toContain("Call report_outcome directly, not through eval");
		// Nothing was consumed by the refusals: the direct calls after them still record.
		expect(
			text(
				await tools.propose_task!.execute("t1", {
					prompt: `Direct${acceptance}`,
					rank: 2,
				}),
			),
		).toContain("Recorded");
		currentSessionName = "Named before the direct report";
		expect(
			text(
				await tools.report_outcome!.execute("t2", {
					status: "ready",
					summary: "s",
				}),
			),
		).toBe("Outcome recorded: ready");
	});

	test("an eval ask refuses and spends no ask budget", async () => {
		const tools = await freshTools();
		expect(
			text(
				await tools.ask!.execute(evalId("ask"), {
					questions: [{ question: "Q?", options: [{ label: "a" }] }],
				}),
			),
		).toContain("Call ask directly, not through eval");
		// The one-ask-per-turn budget is untouched: the direct ask still delivers.
		expect(
			text(
				await tools.ask!.execute("t1", {
					questions: [{ question: "Q?", options: [{ label: "a" }] }],
				}),
			),
		).toContain("delivered to the tracker user");
	});

	// The acceptance's event-stream half: the refusal text comes from the REAL execute
	// (the code under test), wrapped in the bridge envelope omp actually returns — each
	// nested result serialized as a {text, details} object, the eval cell output carrying
	// that JSON (recorded live in src/fixtures/eval-bridge-stream.jsonl). Without the
	// guard the execute returns its success text, the refusal assertion fails, and the
	// stream would carry a false success the runner reads as nothing.
	test("a refused eval call rides the bridge envelope into the event stream", async () => {
		process.env.OTTR_REVIEW = "1";
		const tools = await freshTools();
		const runEval = async (name: string, params: Record<string, unknown>) => {
			const result = await tools[name]!.execute(evalId(name), params);
			const cell = JSON.stringify({ text: text(result), details: {} });
			const s = newEventState();
			applyEvent(s, {
				type: "tool_execution_start",
				toolName: "eval",
				toolCallId: "call_probe",
				args: { code: `await tool.${name}(...)`, language: "js" },
			});
			applyEvent(s, {
				type: "tool_execution_end",
				toolName: "eval",
				toolCallId: "call_probe",
				isError: false,
				result: { content: [{ type: "text", text: cell }] },
			});
			return { s, cell };
		};
		const finding = await runEval("propose_task", { prompt: "F", rank: 1 });
		expect(finding.s.recorded).toHaveLength(0);
		expect(finding.s.outcome).toBeNull();
		expect(finding.cell).toContain(
			"Call propose_task directly, not through eval",
		);
		const outcome = await runEval("report_outcome", {
			status: "ready",
			summary: "s",
		});
		expect(outcome.s.outcome).toBeNull();
		expect(outcome.cell).toContain(
			"Call report_outcome directly, not through eval",
		);
	});

	test("a retro eval proposal records nothing and the direct proposal still lands", async () => {
		process.env.OTTR_RETRO = "1";
		const tools = await freshTools();
		expect(
			text(
				await tools.propose_task!.execute(evalId("propose_task"), {
					prompt: "Eval proposal",
				}),
			),
		).toContain("Call propose_task directly, not through eval");
		// The refusal spent no proposal: the direct call records, a second direct one hits the cap.
		expect(
			text(
				await tools.propose_task!.execute("t1", {
					prompt: `Direct proposal${acceptance}`,
				}),
			),
		).toContain("Recorded");
		expect(
			text(
				await tools.propose_task!.execute("t2", {
					prompt: `Second direct${acceptance}`,
				}),
			),
		).toContain("only one proposal is allowed");
	});
});

describe("sandbox_run tool", () => {
	// The board coordinates the runner injects into a review or scout session;
	// the tool reads them per call and POSTs to the board, whose server holds
	// the worker token (src/sandboxRun.ts runSandboxViaBoard).
	const boardEnv = {
		OTTR_BOARD_URL: "http://ottr:8080",
		OTTR_PROJECT: "p1",
		OTTR_TASK_ID: "P1-42",
		OTTR_BOARD_TOKEN: "boot-token",
		OTTR_RUN_TOKEN: "run-token",
	};
	// The runner's answer fixture, copied from src/sandboxRun.test.ts.
	const guestResponse = {
		id: "val-1763000000-cafebabe",
		selfCheck: {
			ok: true,
			checks: [{ name: "interfaces", ok: true, detail: "lo only" }],
		},
		missingControl: null,
		job: {
			argv: ["bun", "test", "src/parse.ts"],
			cwd: "/target",
			exitCode: 0,
			signal: null,
			timedOut: false,
			stdoutTail: "1 pass",
			stderrTail: "",
		},
		artifacts: [],
		limits: { ...VM_VALIDATE },
		bootMs: 812,
		totalMs: 9400,
		logTail: "",
		resultSource: "guest",
	};

	test("absent without a review or scout run kind so work runs never see it", () => {
		// The board injection alone must not enable the tool.
		setEnv(boardEnv);
		expect(fakePi().sandbox_run).toBeUndefined();
	});

	test("absent in a retro run, which propose_task serves instead", () => {
		process.env.OTTR_RETRO = "1";
		expect(fakePi().sandbox_run).toBeUndefined();
	});

	test("present in review runs and headless-safe like the other tools", () => {
		process.env.OTTR_REVIEW = "1";
		const tool = fakePi().sandbox_run;
		expect(tool).toBeDefined();
		expect(tool?.approval).toBe("read");
		expect(tool?.loadMode).toBe("essential");
	});

	test("present in trending scout runs", () => {
		process.env.OTTR_TRENDING = "1";
		expect(fakePi().sandbox_run).toBeDefined();
	});

	test("declares exactly project, ref, argv, cwd and collect", () => {
		process.env.OTTR_REVIEW = "1";
		expect(Object.keys(fakePi().sandbox_run?.parameters ?? {})).toEqual([
			"project",
			"ref",
			"argv",
			"cwd",
			"collect",
		]);
	});

	test("rejects a bad project name or an empty argv before any call", async () => {
		process.env.OTTR_REVIEW = "1";
		setEnv(boardEnv);
		const tools = fakePi();
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		expect(
			text(
				await tools.sandbox_run!.execute("t1", {
					project: "../evil",
					argv: ["true"],
				}),
			),
		).toContain("project must be a project name");
		expect(
			text(
				await tools.sandbox_run!.execute("t2", {
					project: "p1",
					argv: [],
				}),
			),
		).toBe("Error: argv must be a non-empty list of strings");
		expect(called).toBe(false);
	});

	test("execute posts the run's args and credential to the board and returns the runner's JSON", async () => {
		process.env.OTTR_REVIEW = "1";
		setEnv(boardEnv);
		// The regression this card fixes: the runner strips both credentials from
		// agent env (src/runner.ts childEnv), and the run still lands through the
		// board, whose server holds the worker token.
		delete process.env.OTTR_WORKER_TOKEN;
		delete process.env.OTTR_VM_RUNNER_URL;
		expect(process.env.OTTR_WORKER_TOKEN).toBeUndefined();
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(JSON.stringify({ ok: true, result: guestResponse }), {
				status: 200,
			});
		}) as unknown as typeof fetch;
		const out = await fakePi().sandbox_run!.execute("t1", {
			project: "p1",
			argv: ["sh", "-c", "true"],
			ref: "main",
			collect: ["scratch/poc.txt"],
		});
		expect(seen!.url).toBe("http://ottr:8080/api/projects/p1/sandbox");
		expect(seen!.init.method).toBe("POST");
		expect(seen!.init.headers).toMatchObject({
			"x-board-token": "boot-token",
			"x-run-token": "run-token",
			origin: "http://ottr:8080",
		});
		expect(JSON.parse(String(seen!.init.body))).toEqual({
			taskId: "P1-42",
			project: "p1",
			ref: "main",
			argv: ["sh", "-c", "true"],
			collect: ["scratch/poc.txt"],
		});
		const parsed = JSON.parse(text(out)) as {
			id: string;
			resultSource: string;
		};
		expect(parsed.id).toBe("val-1763000000-cafebabe");
		expect(parsed.resultSource).toBe("guest");
		// The board token rides the header only; the result text never carries it.
		expect(text(out)).not.toContain("boot-token");
	});

	test("refuses before any call when the run carries no OTTR_RUN_TOKEN", async () => {
		process.env.OTTR_REVIEW = "1";
		setEnv(boardEnv);
		delete process.env.OTTR_RUN_TOKEN;
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		expect(
			text(
				await fakePi().sandbox_run!.execute("t1", {
					project: "p1",
					argv: ["true"],
				}),
			),
		).toContain("OTTR_RUN_TOKEN");
		expect(called).toBe(false);
	});

	test("relays the board's refusal and the runner blocker as the error text", async () => {
		process.env.OTTR_REVIEW = "1";
		setEnv(boardEnv);
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					error: "sandbox_run runs only in review or trending scout runs",
				}),
				{ status: 403 },
			)) as unknown as typeof fetch;
		expect(
			text(
				await fakePi().sandbox_run!.execute("t1", {
					project: "p1",
					argv: ["true"],
				}),
			),
		).toBe("Error: sandbox_run runs only in review or trending scout runs");
		// The runner blocker rides through unchanged: the audit records it as the
		// exact blocker of a needs_validation lead.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					error:
						"OTTR_VM_RUNNER_URL is not set; set it and bring up the vm-runner compose service (--profile vm) to run sandbox jobs.",
				}),
				{ status: 502 },
			)) as unknown as typeof fetch;
		expect(
			text(
				await fakePi().sandbox_run!.execute("t2", {
					project: "p1",
					argv: ["true"],
				}),
			),
		).toBe(
			"Error: OTTR_VM_RUNNER_URL is not set; set it and bring up the vm-runner compose service (--profile vm) to run sandbox jobs.",
		);
	});

	test("execute without the board coordinates reports the missing injection", async () => {
		process.env.OTTR_REVIEW = "1";
		setEnv(boardEnv);
		delete process.env.OTTR_BOARD_URL;
		const out = await fakePi().sandbox_run!.execute("t1", {
			project: "p1",
			argv: ["true"],
		});
		expect(text(out)).toStartWith("Error: ");
		expect(text(out)).toContain("OTTR_BOARD_URL");
		expect(text(out)).toContain("sandbox_run is unavailable");
	});

	test("posts no boot token header on loopback, where the wall needs none", async () => {
		process.env.OTTR_REVIEW = "1";
		// A run inside the board's own container reaches it over loopback: no
		// boot token is injected, but the run keeps its own credential.
		setEnv({
			OTTR_BOARD_URL: "http://ottr:8080",
			OTTR_PROJECT: "p1",
			OTTR_TASK_ID: "P1-42",
			OTTR_RUN_TOKEN: "run-token",
		});
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(JSON.stringify({ ok: true, result: guestResponse }), {
				status: 200,
			});
		}) as unknown as typeof fetch;
		await fakePi().sandbox_run!.execute("t1", {
			project: "p1",
			argv: ["sh", "-c", "true"],
		});
		const headers = seen!.init.headers as Record<string, string>;
		expect(headers["x-board-token"]).toBeUndefined();
	});
});

// The sync gate tool (docs/specs/agent-data-sync-gate.md): the turn uid cannot
// read the alate checkout (OTTR-994), so the tool routes through the board like
// sandbox_run, whose server runs sync.mjs with its own rights and records the
// run on the card. Work runs on agent-data cards only.
describe("sync_gate tool", () => {
	// The board coordinates the runner injects into an agent-data work session.
	const gateEnv = {
		OTTR_BOARD_URL: "http://ottr:8080",
		OTTR_PROJECT: "agent-data",
		OTTR_TASK_ID: "AGEN-7",
		OTTR_BOARD_TOKEN: "boot-token",
		OTTR_RUN_TOKEN: "run-token",
	};
	const record = {
		at: 1764000000000,
		code: 0,
		output: "sync: installed ottr/AGENTS.md\nsync: done\n",
		truncated: false,
		files: [
			{
				path: "projects/ottr/AGENTS.md",
				sourceSha256: "a".repeat(64),
				installedSha256: "a".repeat(64),
				match: true,
			},
		],
		durationMs: 4200,
	};

	test("absent outside agent-data projects", () => {
		setEnv({ ...gateEnv, OTTR_PROJECT: "ottr" });
		expect(fakePi().sync_gate).toBeUndefined();
	});

	test("absent in review, retro and trending runs even on agent-data", () => {
		process.env.OTTR_REVIEW = "1";
		setEnv(gateEnv);
		expect(fakePi().sync_gate).toBeUndefined();
		process.env.OTTR_RETRO = "1";
		expect(fakePi().sync_gate).toBeUndefined();
		process.env.OTTR_TRENDING = "1";
		expect(fakePi().sync_gate).toBeUndefined();
	});

	test("present for work runs on agent-data cards, headless-safe, files-only parameter", () => {
		setEnv(gateEnv);
		const tool = fakePi().sync_gate;
		expect(tool).toBeDefined();
		expect(tool?.approval).toBe("read");
		expect(tool?.loadMode).toBe("essential");
		expect(Object.keys(tool?.parameters ?? {})).toEqual(["files"]);
	});

	test("missing run token refuses before any call", async () => {
		setEnv(gateEnv);
		delete process.env.OTTR_RUN_TOKEN;
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const out = await fakePi().sync_gate!.execute("t1", {});
		expect(text(out)).toContain("no OTTR_RUN_TOKEN");
		expect(called).toBe(false);
	});

	test("execute posts the credential headers and returns the stored record", async () => {
		setEnv(gateEnv);
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(JSON.stringify(record), { status: 200 });
		}) as unknown as typeof fetch;
		const out = await fakePi().sync_gate!.execute("t1", {});
		expect(seen!.url).toBe(
			"http://ottr:8080/api/projects/agent-data/sync-gate",
		);
		expect(seen!.init.method).toBe("POST");
		const headers = seen!.init.headers as Record<string, string>;
		expect(headers["x-board-token"]).toBe("boot-token");
		expect(headers["x-run-token"]).toBe("run-token");
		expect(headers.origin).toBe("http://ottr:8080");
		expect(String(seen!.init.body)).toBe("{}");
		expect(JSON.parse(text(out))).toEqual(record);
	});

	test("requested files ride the body as strings", async () => {
		setEnv(gateEnv);
		let seen: { init: RequestInit } | null = null;
		globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
			seen = { init };
			return new Response(JSON.stringify(record), { status: 200 });
		}) as unknown as typeof fetch;
		await fakePi().sync_gate!.execute("t1", {
			files: ["projects/ottr/AGENTS.md", "guard.md"],
		});
		expect(JSON.parse(String(seen!.init.body))).toEqual({
			files: ["projects/ottr/AGENTS.md", "guard.md"],
		});
	});

	test("an error envelope surfaces the board's reason", async () => {
		setEnv(gateEnv);
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({ error: "sync_gate runs only in work runs" }),
				{ status: 403 },
			)) as unknown as typeof fetch;
		const out = await fakePi().sync_gate!.execute("t1", {});
		expect(text(out)).toContain("HTTP 403");
		expect(text(out)).toContain("sync_gate runs only in work runs");
	});

	test("an unreachable board reports the blocker", async () => {
		setEnv(gateEnv);
		globalThis.fetch = (async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch;
		const out = await fakePi().sync_gate!.execute("t1", {});
		expect(text(out)).toContain("is unreachable");
		expect(text(out)).toContain("connection refused");
	});
});

// The card-env guidance must reach the model, not only the process env: turnEnv sets
// OTTR_CARD_ENV_NOTE and the extension's before_agent_start handler puts the guidance
// into the session system prompt on its presence (OTTR-1099).
describe("before_agent_start card-env guidance", () => {
	const event = (systemPrompt: string[]) => ({
		type: "before_agent_start",
		reason: "prompt",
		prompt: "do the task",
		systemPrompt,
	});

	test("a turn env that carries the note injects the guidance into the system prompt", () => {
		fakePi();
		expect(startHandlers.length).toBe(1);
		process.env.OTTR_CARD_ENV_NOTE = CARD_ENV_NOTE;
		const out = startHandlers[0]?.(event(["base prompt"])) as
			| { systemPrompt?: string[] }
			| undefined;
		expect(out).not.toBeUndefined();
		expect(out?.systemPrompt).toEqual([
			"base prompt",
			expect.stringContaining("eval kernel env"),
		]);
		// The guidance names the documented path an eval cell must take.
		expect(out?.systemPrompt?.[1]).toContain("bash tool");
	});

	test("no note in the env injects nothing", () => {
		fakePi();
		expect(startHandlers[0]?.(event(["base prompt"]))).toBeUndefined();
	});

	test("the injection appends to omp's chained prompt, it never replaces it", () => {
		fakePi();
		process.env.OTTR_CARD_ENV_NOTE = CARD_ENV_NOTE;
		const base = ["first block", "second block"];
		const out = startHandlers[0]?.(event(base)) as
			| { systemPrompt?: string[] }
			| undefined;
		expect(out?.systemPrompt?.slice(0, 2)).toEqual(base);
		expect(out?.systemPrompt).toHaveLength(3);
	});
});

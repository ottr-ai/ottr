import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentDir } from "./login.ts";
import { LOST_SESSION } from "./prompts.ts";
import type { EventState, RunLauncher } from "./runner.ts";
import {
	APPROVAL_REFUSAL,
	applyEvent,
	buildOmpArgs,
	childEnv,
	classify,
	createRunSink,
	findHttp400Rejection,
	newEventState,
	rejectedReport,
	renderEvent,
	resumePlan,
	startRun,
	WORKER_LOST,
	workerFromEnv,
} from "./runner.ts";
import type { GitFacts, Next, Outcome, RunResult, TurnKind } from "./types.ts";
import { serveWorker } from "./workers.ts";
import { setGitSecrets } from "./worktree.ts";

const result = (over: Partial<RunResult> = {}): RunResult => ({
	exitCode: 0,
	sessionId: "sess-1",
	model: null,
	outcome: null,
	asked: null,
	proposed: null,
	recorded: [],
	approvalRefused: false,
	sawTerminalEnd: true,
	finalText: "",
	killed: false,
	stderrTail: "",
	...over,
});

const git = (over: Partial<GitFacts> = {}): GitFacts => ({
	commitsAhead: 1,
	clean: true,
	integrated: false,
	...over,
});

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
	status: "ready",
	summary: "all good",
	...over,
});

// A compiled stand-in for worker-dispatched omp. `bun build --compile` alone can take
// seconds under concurrent machine load, so it runs once here, outside every test's
// timeout budget; a compiled exe also boots without bun's per-spawn transpile cost.
const workerOmpDir = mkdtempSync(join(tmpdir(), "ottr-worker-omp-"));
const workerOmp = join(workerOmpDir, "fake-omp.exe");
writeFileSync(
	join(workerOmpDir, "fake-omp.js"),
	`process.stdout.write(JSON.stringify({ type: "session", id: "sess-worker" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end", isTerminal: true }) + "\\n");
process.exit(0);`,
);
Bun.spawnSync([
	process.execPath,
	"build",
	"--compile",
	join(workerOmpDir, "fake-omp.js"),
	"--outfile",
	workerOmp,
]);
afterAll(() =>
	rmSync(workerOmpDir, { recursive: true, force: true, maxRetries: 5 }),
);

describe("childEnv", () => {
	test("carries board coordinates and token; an operator-set OTTR_BOARD_URL wins, an inherited token never does", () => {
		expect(
			childEnv({
				board: {
					url: "http://127.0.0.1:4747",
					token: "boot-token",
					project: "ottr",
					taskId: "t1",
				},
				base: {
					PATH: "/bin",
					OTTR_BOARD_URL: "http://ottr:8080",
					OTTR_BOARD_TOKEN: "parent-board-token",
				},
			}),
		).toEqual({
			PATH: "/bin",
			OTTR_BOARD_URL: "http://ottr:8080",
			OTTR_BOARD_TOKEN: "boot-token",
			OTTR_PROJECT: "ottr",
			OTTR_TASK_ID: "t1",
		});
	});

	test("fills the loopback URL when unset and drops undefined values", () => {
		expect(
			childEnv({
				board: {
					url: "http://127.0.0.1:5747",
					token: "boot-token",
					project: "p",
					taskId: "t2",
				},
				base: { PATH: "/bin", DROP: undefined },
			}),
		).toEqual({
			PATH: "/bin",
			OTTR_BOARD_URL: "http://127.0.0.1:5747",
			OTTR_BOARD_TOKEN: "boot-token",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "t2",
		});
	});

	test("without board or pinned name the env is the inherited base", () => {
		expect(childEnv({ base: { PATH: "/bin" } })).toEqual({ PATH: "/bin" });
	});
	test("drops the board's data dir; a local turn keeps GH_TOKEN for its merge push", () => {
		expect(
			childEnv({
				base: {
					PATH: "/bin",
					OTTR_DATA_DIR: "/data",
					OTTR_SERVER_DATA_DIR: "/app/.tasks/projects",
					GH_TOKEN: "ghp_x",
				},
			}),
		).toEqual({ PATH: "/bin", GH_TOKEN: "ghp_x" });
	});
	test("strips the worker dispatch credentials; a turn must never hold them", () => {
		expect(
			childEnv({
				base: {
					PATH: "/bin",
					OTTR_WORKER_URLS: "http://w:1",
					OTTR_WORKER_TOKEN: "worker-secret",
					GH_TOKEN: "ghp_x",
				},
			}),
		).toEqual({ PATH: "/bin", GH_TOKEN: "ghp_x" });
	});
	test("stripBoard removes the board coordinates (a retro run proposes through the tracker)", () => {
		expect(
			childEnv({
				board: {
					url: "http://127.0.0.1:4747",
					token: "boot-token",
					project: "ottr",
					taskId: "t1",
				},
				base: { PATH: "/bin", OTTR_BOARD_URL: "http://ottr:8080" },
				stripBoard: true,
			}),
		).toEqual({ PATH: "/bin" });
	});
});

describe("buildOmpArgs", () => {
	test("without resumeId", () => {
		expect(
			buildOmpArgs({ sessionDir: "S", extensionPath: "E", resumeId: null }),
		).toEqual([
			"-p",
			"--mode",
			"json",
			"--session-dir",
			"S",
			"--extension",
			"E",
			"--config",
			"run.yml",
		]);
	});

	test("with model", () => {
		expect(
			buildOmpArgs({
				sessionDir: "S",
				extensionPath: "E",
				resumeId: null,
				model: "openai/gpt-5.2",
			}),
		).toEqual([
			"-p",
			"--mode",
			"json",
			"--session-dir",
			"S",
			"--extension",
			"E",
			"--config",
			"run.yml",
			"--model",
			"openai/gpt-5.2",
		]);
	});

	test("with resumeId", () => {
		expect(
			buildOmpArgs({ sessionDir: "S", extensionPath: "E", resumeId: "R" }),
		).toEqual([
			"-p",
			"--mode",
			"json",
			"--session-dir",
			"S",
			"--extension",
			"E",
			"--config",
			"run.yml",
			"--resume",
			"R",
		]);
	});

	test("retro flags emit run.yml, --tools, retro config and --skills in that order, before images", () => {
		expect(
			buildOmpArgs({
				sessionDir: "S",
				extensionPath: "E",
				resumeId: null,
				tools: "read,grep,glob,report_outcome,propose_task",
				config: "ext/retro.yml",
				skills: "retro",
				images: ["shot.png"],
			}),
		).toEqual([
			"-p",
			"--mode",
			"json",
			"--session-dir",
			"S",
			"--extension",
			"E",
			"--config",
			"run.yml",
			"--tools",
			"read,grep,glob,report_outcome,propose_task",
			"--config",
			"ext/retro.yml",
			"--skills",
			"retro",
			"@shot.png",
		]);
	});

	test("empty or null flag values emit nothing", () => {
		expect(
			buildOmpArgs({
				sessionDir: "S",
				extensionPath: "E",
				resumeId: null,
				tools: "",
				config: null,
				skills: undefined,
			}),
		).toEqual([
			"-p",
			"--mode",
			"json",
			"--session-dir",
			"S",
			"--extension",
			"E",
			"--config",
			"run.yml",
		]);
	});

	test("null extensionPath (a review check run) passes no extension and no run.yml", () => {
		expect(
			buildOmpArgs({
				sessionDir: "S",
				extensionPath: null,
				resumeId: null,
				tools: "read,grep,glob",
				config: "ext/check.yml",
			}),
		).toEqual([
			"-p",
			"--mode",
			"json",
			"--session-dir",
			"S",
			"--tools",
			"read,grep,glob",
			"--config",
			"ext/check.yml",
		]);
	});

	test("images become @ arguments after the flags", () => {
		expect(
			buildOmpArgs({
				sessionDir: "S",
				extensionPath: "E",
				resumeId: null,
				images: ["C:\\p\\1.png", "C:\\p\\2.jpg"],
			}),
		).toEqual([
			"-p",
			"--mode",
			"json",
			"--session-dir",
			"S",
			"--extension",
			"E",
			"--config",
			"run.yml",
			"@C:\\p\\1.png",
			"@C:\\p\\2.jpg",
		]);
	});

	test("images follow --resume", () => {
		expect(
			buildOmpArgs({
				sessionDir: "S",
				extensionPath: "E",
				resumeId: "R",
				images: ["C:\\p\\3.gif"],
			}).slice(-3),
		).toEqual(["--resume", "R", "@C:\\p\\3.gif"]);
	});
});

describe("resumePlan", () => {
	test("a saved session resumes and keeps the reply as is", () => {
		expect(resumePlan("S", true, "use option B")).toEqual({
			resumeId: "S",
			note: "use option B",
		});
	});

	test("before the first session the reply is the fresh session's note, with no lost-session note", () => {
		expect(resumePlan(null, false, "use option B")).toEqual({
			resumeId: null,
			note: "use option B",
		});
		expect(resumePlan(null, false, null)).toEqual({
			resumeId: null,
			note: null,
		});
	});

	test("a card that never ran drops the '.' continue marker (a resumed proposal card must not carry 'Note from the user: .')", () => {
		expect(resumePlan(null, false, ".")).toEqual({
			resumeId: null,
			note: null,
		});
	});

	test("a saved session keeps '.' as its pending reply (the reply flow decides what it means)", () => {
		expect(resumePlan("S", true, ".")).toEqual({ resumeId: "S", note: "." });
	});

	test("a session omp never saved starts fresh with the lost-session note instead of the continue marker", () => {
		expect(resumePlan("S", false, ".")).toEqual({
			resumeId: null,
			note: LOST_SESSION,
		});
		expect(resumePlan("S", false, null)).toEqual({
			resumeId: null,
			note: LOST_SESSION,
		});
	});

	test("a reply to a session omp never saved follows the lost-session note", () => {
		expect(resumePlan("S", false, "use option B")).toEqual({
			resumeId: null,
			note: `${LOST_SESSION}\n\nuse option B`,
		});
	});
});

describe("rejectedReport", () => {
	test("a report the tracker did not accept comes back with the tracker's reason", () => {
		for (const outcome of ["ready", "answered", "integrated"] as const)
			expect(
				rejectedReport({ outcome, error: "Reported it, but git disagrees." }),
			).toBe("Reported it, but git disagrees.");
	});

	test("an accepted report, the agent's own question, a turn without a report, or no turn give nothing", () => {
		expect(rejectedReport({ outcome: "ready", error: null })).toBeNull();
		expect(
			rejectedReport({ outcome: "needs_you", error: "Which color?" }),
		).toBeNull();
		expect(
			rejectedReport({ outcome: null, error: "tracker restarted" }),
		).toBeNull();
		expect(rejectedReport(undefined)).toBeNull();
	});
});

describe("renderEvent", () => {
	test("text_delta passes through", () => {
		expect(
			renderEvent({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hi there" },
			}),
		).toBe("hi there");
	});

	test("bash tool_execution_start shows the command", () => {
		expect(
			renderEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "git status" },
			}),
		).toBe("\n▸ bash: git status\n");
	});

	test("non-bash tool without command falls back to intent, long cut to 300+…", () => {
		const long = "x".repeat(301);
		expect(
			renderEvent({
				type: "tool_execution_start",
				toolCallId: "t2",
				toolName: "read",
				intent: long,
				args: { path: "f" },
			}),
		).toBe(`\n▸ read: ${"x".repeat(300)}…\n`);
		expect(
			renderEvent({
				type: "tool_execution_start",
				toolCallId: "t3",
				toolName: "odd",
				args: { n: 1 },
			}),
		).toBe('\n▸ odd: {"n":1}\n');
	});

	test("report_outcome start line", () => {
		expect(
			renderEvent({
				type: "tool_execution_start",
				toolCallId: "t4",
				toolName: "report_outcome",
				args: { status: "ready", summary: "all good" },
			}),
		).toBe("\n▸ report_outcome: ready — all good\n");
	});

	test("ask start renders questions and options readably", () => {
		expect(
			renderEvent({
				type: "tool_execution_start",
				toolCallId: "t8",
				toolName: "ask",
				args: {
					questions: [
						{
							question: "Which way?",
							options: [{ label: "A" }, { label: "B", description: "safer" }],
						},
					],
				},
			}),
		).toBe("\n▸ ask\n  ? Which way?\n    • A\n    • B — safer\n");
	});

	test("task tool is not mistaken for ask", () => {
		expect(
			renderEvent({
				type: "tool_execution_start",
				toolCallId: "t9",
				toolName: "task",
				args: {},
			}),
		).toBe("\n▸ task: {}\n");
	});

	test("error end contains approval text with newlines flattened", () => {
		expect(
			renderEvent({
				type: "tool_execution_end",
				toolCallId: "t5",
				toolName: "bash",
				args: {},
				result: {
					content: [{ type: "text", text: `oops\n${APPROVAL_REFUSAL}` }],
				},
				isError: true,
			}),
		).toBe(`  ✗ oops ⏎ ${APPROVAL_REFUSAL}\n`);
	});

	test("thinking streams between start/end markers", () => {
		expect(
			renderEvent({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_start" },
			}),
		).toBe("\n⟦thinking⟧ ");
		expect(
			renderEvent({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
			}),
		).toBe("hmm");
		expect(
			renderEvent({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta" },
			}),
		).toBe("");
		expect(
			renderEvent({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_end" },
			}),
		).toBe("\n");
	});

	test("malformed input renders nothing", () => {
		expect(renderEvent(null)).toBe("");
		expect(renderEvent("x")).toBe("");
		expect(renderEvent({})).toBe("");
	});

	test("session, agent_end, assistant message_end", () => {
		expect(renderEvent({ type: "session", id: "abc" })).toBe(
			"[omp session abc]\n",
		);
		expect(
			renderEvent({ type: "agent_end", messages: [], isTerminal: true }),
		).toBe("\n");
		expect(
			renderEvent({ type: "message_end", message: { role: "assistant" } }),
		).toBe("\n");
		expect(
			renderEvent({ type: "message_end", message: { role: "user" } }),
		).toBe("");
	});
});

describe("findHttp400Rejection", () => {
	test("returns the newest entry file whose timestamp falls inside the window", () => {
		const dir = mkdtempSync(join(tmpdir(), "http400-"));
		writeFileSync(join(dir, "1791198198684-1ok2qphomb4gt.json"), "{}");
		writeFileSync(join(dir, "1791200010270-2t9z28pqy95db.json"), "{}");
		try {
			expect(
				findHttp400Rejection({ from: 1791198198000, to: 1791198199000, dir }),
			).toBe("1791198198684-1ok2qphomb4gt.json");
			expect(
				findHttp400Rejection({ from: 1791200010000, to: 1791200020000, dir }),
			).toBe("1791200010270-2t9z28pqy95db.json");
			// Two entries in one window: the newest wins.
			expect(
				findHttp400Rejection({ from: 1791198198000, to: 1791200020000, dir }),
			).toBe("1791200010270-2t9z28pqy95db.json");
			// Bounds are inclusive: an entry written exactly at the turn's start counts.
			expect(
				findHttp400Rejection({ from: 1791198198684, to: 1791198198684, dir }),
			).toBe("1791198198684-1ok2qphomb4gt.json");
			expect(findHttp400Rejection({ from: 1, to: 2, dir })).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing or unreadable directory is null, not a throw", () => {
		expect(
			findHttp400Rejection({
				from: 0,
				to: Date.now(),
				dir: join(tmpdir(), "http400-missing-xyz"),
			}),
		).toBeNull();
	});

	test("finds the board's own turns' entries under the board omp home (R5-1)", () => {
		const board = mkdtempSync(join(tmpdir(), "http400-board-"));
		const logs = join(board, ".omp", "logs", "http-400-requests");
		mkdirSync(logs, { recursive: true });
		// Far future: no real entry of the developer's own ~/.omp falls in this window.
		writeFileSync(join(logs, "9791198198684-board.json"), "{}");
		const saved = process.env.OTTR_BOARD_OMP_HOME;
		process.env.OTTR_BOARD_OMP_HOME = board;
		try {
			expect(
				findHttp400Rejection({ from: 9791198198000, to: 9791198199000 }),
			).toBe("9791198198684-board.json");
		} finally {
			if (saved === undefined) delete process.env.OTTR_BOARD_OMP_HOME;
			else process.env.OTTR_BOARD_OMP_HOME = saved;
			rmSync(board, { recursive: true, force: true });
		}
	});
});

describe("classify", () => {
	const run = (
		kind: TurnKind,
		result: RunResult,
		g = git(),
		target: string | null = "origin/main",
		previousError: string | null = null,
	) => classify({ kind, result, git: g, target, previousError });

	test("1. killed wins over everything", () => {
		expect(
			run("work", result({ killed: true, exitCode: 1, outcome: outcome() })),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "Stopped by the tracker.",
		});
	});

	test("2. a received terminal report wins over a post-report crash; no report still fails", () => {
		// omp crashed at shutdown after report_outcome: the work decides, not the exit code.
		expect(
			run(
				"work",
				result({
					exitCode: 1,
					outcome: outcome(),
					stderrTail: "warning\nboom\n",
				}),
			),
		).toEqual({ stage: "merging", state: "queued", needsReason: null });
		expect(
			run(
				"work",
				result({
					exitCode: 1,
					outcome: outcome({ status: "answered" }),
				}),
				git({ commitsAhead: 0 }),
			),
		).toEqual({ stage: "done", state: "idle", needsReason: null });
		expect(run("work", result({ exitCode: 1 }))).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing.",
		});
		// An ask plus a crash is still a failure: the ask never reached a live session end.
		expect(
			run(
				"work",
				result({ exitCode: 1, outcome: outcome({ status: "needs_you" }) }),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing.",
		});
	});

	test("2b. null exit code reports unknown", () => {
		expect(run("merge", result({ exitCode: null }))).toEqual({
			stage: "merging",
			state: "needs_you",
			needsReason: "omp exited with code unknown before finishing.",
		});
	});

	test("2c. a no-stderr death folds the dispatch context into the reason", () => {
		const dispatch = "local, argv 12, cwd card-7, pid 76904, 41s";
		expect(run("work", result({ exitCode: 1, dispatch }))).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: `omp exited with code 1 before finishing (dispatch ${dispatch}, no stderr).`,
		});
		// stderr spoke: the plain message stays as it was.
		expect(
			run("work", result({ exitCode: 1, stderrTail: "boom\n", dispatch })),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing: boom.",
		});
		// No context recorded (old results): the plain message is unchanged.
		expect(run("work", result({ exitCode: 1 }))).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing.",
		});
	});

	test("2d. a pre-event exit with attached images queues one text-only retry", () => {
		const dead = {
			exitCode: 1,
			sessionId: null,
			sawTerminalEnd: false,
			finalText: "",
		};
		const call = (over: Partial<RunResult> = {}, images?: number) =>
			classify({
				kind: "work",
				result: result({ ...dead, ...over }),
				git: git(),
				target: "origin/main",
				previousError: null,
				images,
			});
		// The provider rejected the image input (died before any event, empty stderr):
		// requeue text-only and have the caller quarantine the files.
		expect(call({}, 2)).toEqual({
			stage: "in_progress",
			state: "queued",
			needsReason:
				"The provider rejected the attached images (the run died before any output). Quarantining them and retrying text-only.",
			quarantineImages: true,
		});
		// The text-only retry that dies the same way is an ordinary failure.
		expect(call({})).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing.",
		});
		// A session was announced or stderr spoke: not the rejection shape, a human decides.
		expect(call({ sessionId: "sess-1" }, 2)).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing.",
		});
		expect(call({ stderrTail: "boom\n" }, 2)).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing: boom.",
		});
	});

	test("2e. a text pre-event exit with a logged HTTP 400 names the evidence file", () => {
		const dead = {
			exitCode: 1,
			sessionId: null,
			sawTerminalEnd: false,
			finalText: "",
		};
		const evidenceFile = "1791200010270-2t9z28pqy95db.json";
		// The provider rejected the prompt's text content: point at the log entry,
		// not at a generic exit code.
		expect(
			classify({
				kind: "work",
				result: result(dead),
				git: git(),
				target: "origin/main",
				previousError: null,
				http400: () => evidenceFile,
			}),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: `The provider rejects this prompt's content - reword the task (evidence: ~/.omp/logs/http-400-requests/${evidenceFile}).`,
		});
		// No log entry inside the turn's window: the generic failure stands.
		expect(
			classify({
				kind: "work",
				result: result(dead),
				git: git(),
				target: "origin/main",
				previousError: null,
				http400: () => null,
			}),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing.",
		});
		// A session was announced: not the rejection shape, a human decides.
		expect(
			classify({
				kind: "work",
				result: result({ ...dead, sessionId: "sess-1" }),
				git: git(),
				target: "origin/main",
				previousError: null,
				http400: () => evidenceFile,
			}),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing.",
		});
		// Attached images keep the quarantine branch even when the log has evidence.
		expect(
			classify({
				kind: "work",
				result: result(dead),
				git: git(),
				target: "origin/main",
				previousError: null,
				images: 2,
				http400: () => evidenceFile,
			}),
		).toEqual({
			stage: "in_progress",
			state: "queued",
			needsReason:
				"The provider rejected the attached images (the run died before any output). Quarantining them and retrying text-only.",
			quarantineImages: true,
		});
	});

	test("2f. no http400 reader (older callers) keeps the generic message", () => {
		expect(
			classify({
				kind: "work",
				result: result({
					exitCode: 1,
					sessionId: null,
					sawTerminalEnd: false,
					finalText: "",
				}),
				git: git(),
				target: "origin/main",
				previousError: null,
			}),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing.",
		});
	});

	test("2g. a crash names omp's error line, not a stack frame or the resume hint", () => {
		// Velvarr's release turn died like this (2026-10-11): Bun's crash print, then omp's
		// [Recovery] block. The card showed "Main: omp --resume …" instead of the cause.
		const stderrTail = [
			"30284 | Then use /model to select a model.`);throw Error(`No API key found for anthropic.",
			"                                                      ^",
			"error: No API key found for anthropic.",
			"Use /login, set an API key environment variable, or create /root/.omp/agent/agent.db",
			"      at #io (/usr/local/bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js:30284:105)",
			"[Recovery]",
			"  Main: omp --resume 01a12b29-d45f-74c3-9e7d-425fbb7cba10",
			"",
		].join("\n");
		expect(run("work", result({ exitCode: 1, stderrTail }))).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"omp exited with code 1 before finishing: No API key found for anthropic.",
		});
		// Only the hint: it still beats an empty reason.
		expect(
			run(
				"work",
				result({
					exitCode: 1,
					stderrTail: "[Recovery]\n  Main: omp --resume s-1\n",
				}),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"omp exited with code 1 before finishing: Main: omp --resume s-1.",
		});
	});

	test("2h. a model restore failure retries once, then names the cause in plain words", () => {
		const stderrTail = "error: Could not restore model zai/glm-5.3-flash.\n";
		const retry = run("merge", result({ exitCode: 1, stderrTail }));
		expect(retry).toEqual({
			stage: "merging",
			state: "queued",
			needsReason:
				"This board cannot load the session's model zai/glm-5.3-flash (no sign-in for its provider here) - retrying with the board's default model role. Cancel to stop it instead.",
		});
		expect(
			run(
				"merge",
				result({
					exitCode: 1,
					stderrTail: "error: No API key found for anthropic.\n",
				}),
				git(),
				"origin/main",
				retry.needsReason,
			),
		).toEqual({
			stage: "merging",
			state: "needs_you",
			needsReason:
				"This board cannot load the session's model, and the retry with the board's default model role failed too: No API key found for anthropic. Sign in to a provider under Settings, set a default model role, or switch the card's model, then reply.",
		});
	});

	test("2c. exit 0 without a terminal end (background wait) continues once, then asks", () => {
		const resumed: Next = {
			stage: "in_progress",
			state: "queued",
			needsReason:
				"The agent ended its turn while waiting on a background job - resuming automatically. Cancel to stop it instead.",
			pendingPrompt: ".",
		};
		expect(run("work", result({ sawTerminalEnd: false }))).toEqual(resumed);
		// A crash also ends without agent_end; only exit 0 counts as a background wait.
		expect(run("work", result({ exitCode: 1, sawTerminalEnd: false }))).toEqual(
			{
				stage: "in_progress",
				state: "needs_you",
				needsReason: "omp exited with code 1 before finishing.",
			},
		);
		// An earlier turn that failed differently still gets the automatic continue.
		expect(
			run(
				"work",
				result({ sawTerminalEnd: false }),
				git(),
				"origin/main",
				"tracker restarted",
			),
		).toEqual(resumed);
		// The previous turn already ended this way: no second continue, so a looping agent stops at a human.
		expect(
			run(
				"merge",
				result({ sawTerminalEnd: false }),
				git(),
				"origin/main",
				resumed.needsReason,
			),
		).toEqual({
			stage: "merging",
			state: "needs_you",
			needsReason:
				'The agent ended its turn while waiting on a background job again; a one-shot omp run exits instead of being woken. Reply "." to let it re-check, or use New session.',
		});
	});

	test("3. approval refused beats a valid outcome", () => {
		expect(
			run("work", result({ approvalRefused: true, outcome: outcome() })),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"A tool call needed approval, which tracker runs can't answer. Allow the tool in omp's config or continue in a terminal (see the card).",
		});
	});

	test("4. no outcome reported", () => {
		// Nothing provable: an empty branch cannot show ready, an unmerged merge cannot show done.
		expect(run("work", result(), git({ commitsAhead: 0 }))).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "The agent finished without calling report_outcome.",
		});
		expect(run("work", result(), git({ clean: false }))).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "The agent finished without calling report_outcome.",
		});
		expect(run("merge", result())).toEqual({
			stage: "merging",
			state: "needs_you",
			needsReason: "The agent finished without calling report_outcome.",
		});
	});

	test("4a. no outcome, but a clean committed branch proves ready", () => {
		// The receipt path can be down (extension failed to load); git decides the turn finished.
		expect(run("work", result())).toEqual({
			stage: "merging",
			state: "queued",
			needsReason: null,
		});
	});

	test("4b. no outcome, but a merged head proves integrated", () => {
		expect(run("merge", result(), git({ integrated: true }))).toEqual({
			stage: "done",
			state: "idle",
			needsReason: null,
		});
	});

	test("4c. no outcome, but a research card's report file settles done", () => {
		const call = (over: {
			git?: Partial<GitFacts>;
			research?: boolean;
			hasReport?: boolean;
		}) =>
			classify({
				kind: "work",
				result: result(),
				git: git(over.git),
				target: "origin/main",
				previousError: null,
				research: over.research,
				hasReport: over.hasReport,
			});
		// The report is the research deliverable: exit 0 with it present needs no receipt.
		expect(call({ research: true, hasReport: true })).toEqual({
			stage: "done",
			state: "idle",
			needsReason: null,
		});
		// Stray commits do not matter: research never merges, the report is the deliverable.
		expect(
			call({ git: { commitsAhead: 3 }, research: true, hasReport: true }),
		).toEqual({ stage: "done", state: "idle", needsReason: null });
		// No report file: still a human decision when git proves nothing either.
		expect(
			call({ git: { commitsAhead: 0 }, research: true, hasReport: false }),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "The agent finished without calling report_outcome.",
		});
		// A plain work card with nothing provable still asks; no report can speak for it.
		expect(
			call({ git: { commitsAhead: 0 }, research: false, hasReport: true }),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "The agent finished without calling report_outcome.",
		});
	});

	const ask = [
		{
			question: "Which way?",
			options: [{ label: "A" }, { label: "B" }],
			multi: false,
			recommended: null,
		},
	];

	test("4b. an outstanding ask pauses as needs_you and carries the payload", () => {
		expect(run("work", result({ asked: ask }))).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "Wants your answer: Which way?",
			asked: ask,
		});
		// A long question truncates in the reason; the payload stays whole.
		expect(
			run(
				"work",
				result({ asked: [{ ...ask[0]!, question: "x".repeat(300) }] }),
			),
		).toMatchObject({
			needsReason: `Wants your answer: ${"x".repeat(160)}…`,
		});
	});

	test("4c. a needs_you outcome keeps the ask; a finished turn makes it moot", () => {
		expect(
			run(
				"work",
				result({
					asked: ask,
					outcome: outcome({
						status: "needs_you",
						summary: "stuck",
						question: "why?",
					}),
				}),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "Wants your answer: Which way?",
			asked: ask,
		});
		// The agent asked, then finished ready on its own: the merge queue logic owns the card again.
		expect(run("work", result({ asked: ask, outcome: outcome() }))).toEqual({
			stage: "merging",
			state: "queued",
			needsReason: null,
		});
	});

	test("5. work ready with commits ahead and clean tree queues the merge", () => {
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "ready" }) }),
				git({ commitsAhead: 2, clean: true }),
			),
		).toEqual({
			stage: "merging",
			state: "queued",
			needsReason: null,
		});
	});

	test("5b. work ready with zero commits needs you", () => {
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "ready" }) }),
				git({ commitsAhead: 0 }),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"Reported ready, but git shows 0 commit(s) ahead of the base.",
		});
	});

	test("5d. work ready with zero commits and a merged head is done (sibling landed the fix)", () => {
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "ready" }) }),
				git({ commitsAhead: 0, integrated: true }),
			),
		).toEqual({ stage: "done", state: "idle", needsReason: null });
		// Without a merged head the zero-commit rejection still holds.
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "ready" }) }),
				git({ commitsAhead: 0, integrated: false }),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"Reported ready, but git shows 0 commit(s) ahead of the base.",
		});
	});

	test("5c. work ready with a dirty tree needs you", () => {
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "ready" }) }),
				git({ commitsAhead: 1, clean: false }),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"Reported ready, but git shows 1 commit(s) ahead of the base and uncommitted changes.",
		});
	});

	test("6. work answered with no commits is done", () => {
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "answered" }) }),
				git({ commitsAhead: 0 }),
			),
		).toEqual({
			stage: "done",
			state: "idle",
			needsReason: null,
		});
	});

	test("6b. work answered with uncommitted tracked changes needs you", () => {
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "answered" }) }),
				git({ commitsAhead: 3, clean: false }),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"Reported answered, but the branch has 3 commit(s) that were never integrated.",
		});
	});

	test("6c. answered with clean landable commits queues the merge unless research", () => {
		const answered = result({ outcome: outcome({ status: "answered" }) });
		const g = git({ commitsAhead: 2 });
		expect(run("work", answered, g)).toEqual({
			stage: "merging",
			state: "queued",
			needsReason: null,
		});
		// A dirty tree cannot prove the commits are landable: the rejection keeps winning.
		expect(
			run("work", answered, git({ commitsAhead: 2, clean: false })),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"Reported answered, but the branch has 2 commit(s) that were never integrated.",
		});
		// Research cards never merge.
		expect(
			classify({
				kind: "work",
				result: answered,
				git: g,
				target: "origin/main",
				previousError: null,
				research: true,
			}),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"Reported answered, but the branch has 2 commit(s) that were never integrated.",
		});
	});

	test("7. work integrated is verified against git like a merge", () => {
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "integrated" }) }),
				git({ integrated: true }),
			),
		).toEqual({
			stage: "done",
			state: "idle",
			needsReason: null,
		});
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "integrated" }) }),
				git({ integrated: false }),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "Reported integrated, but HEAD is not on origin/main.",
		});
	});

	test("8. merge integrated verified against git", () => {
		expect(
			run(
				"merge",
				result({ outcome: outcome({ status: "integrated" }) }),
				git({ integrated: true }),
			),
		).toEqual({
			stage: "done",
			state: "idle",
			needsReason: null,
		});
		expect(
			run(
				"merge",
				result({ outcome: outcome({ status: "integrated" }) }),
				git({ integrated: false }),
			),
		).toEqual({
			stage: "merging",
			state: "needs_you",
			needsReason: "Reported integrated, but HEAD is not on origin/main.",
		});
		expect(
			classify({
				kind: "merge",
				result: result({ outcome: outcome({ status: "integrated" }) }),
				git: git(),
				target: null,
				previousError: null,
			}),
		).toEqual({
			stage: "merging",
			state: "needs_you",
			needsReason:
				"Reported integrated, but HEAD is not on the integration target.",
		});
	});

	test("9. merge ready/answered is unexpected", () => {
		expect(
			run("merge", result({ outcome: outcome({ status: "ready" }) })),
		).toEqual({
			stage: "merging",
			state: "needs_you",
			needsReason: 'Unexpected outcome "ready" in a merge turn.',
		});
		expect(
			run("merge", result({ outcome: outcome({ status: "answered" }) })),
		).toEqual({
			stage: "merging",
			state: "needs_you",
			needsReason: 'Unexpected outcome "answered" in a merge turn.',
		});
	});

	test("10. needs_you outcome prefers trimmed question, falls back to summary", () => {
		expect(
			run(
				"work",
				result({
					outcome: outcome({ status: "needs_you", question: "  Which key?  " }),
				}),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "Which key?",
		});
		expect(
			run(
				"merge",
				result({
					outcome: outcome({ status: "needs_you", summary: "conflict" }),
				}),
			),
		).toEqual({
			stage: "merging",
			state: "needs_you",
			needsReason: "conflict",
		});
	});
});

describe("classify grill", () => {
	const grillRun = (over: Partial<RunResult> = {}, g = git()) =>
		classify({
			kind: "work",
			result: result(over),
			git: g,
			target: "origin/main",
			previousError: null,
			grill: true,
		});

	test("a ready report marks the item grilled: backlog, idle", () => {
		expect(grillRun({ outcome: outcome() })).toEqual({
			stage: "backlog",
			state: "idle",
			needsReason: null,
		});
	});

	test("an answered report also settles backlog idle", () => {
		expect(grillRun({ outcome: outcome({ status: "answered" }) })).toEqual({
			stage: "backlog",
			state: "idle",
			needsReason: null,
		});
	});

	test("killed stays a needs_you in backlog", () => {
		expect(grillRun({ killed: true, exitCode: 1 })).toEqual({
			stage: "backlog",
			state: "needs_you",
			needsReason: "Stopped by the tracker.",
		});
	});

	test("an ask surfaces needs_you with the questions, stage backlog", () => {
		const next = grillRun({
			outcome: null,
			asked: [
				{
					question: "Which scope?",
					options: [],
					multi: false,
					recommended: null,
				},
			],
		});
		expect(next.stage).toBe("backlog");
		expect(next.state).toBe("needs_you");
	});

	test("a ready report with no receipt (outcome null) stays needs_you in backlog", () => {
		// ponytail: outcome null with landable commits is the receipt-down path; a grill card
		// has no branch, so it cannot prove anything — belt the merging line instead.
		expect(
			grillRun({ outcome: null }, git({ commitsAhead: 0, clean: true })),
		).toEqual({
			stage: "backlog",
			state: "needs_you",
			needsReason: "The agent finished without calling report_outcome.",
		});
	});

	test("landable commits never send a grill to merging", () => {
		// ready with git commits ahead and clean: a work turn would take the merging path.
		expect(grillRun({ outcome: outcome() })).toEqual({
			stage: "backlog",
			state: "idle",
			needsReason: null,
		});
		// outcome null too: the belted oc-null merging rule holds.
		expect(grillRun({ outcome: null })).toEqual({
			stage: "backlog",
			state: "needs_you",
			needsReason: "The agent finished without calling report_outcome.",
		});
	});
});

describe("applyEvent", () => {
	const feed = (s: EventState, ...list: unknown[]): void => {
		for (const ev of list) applyEvent(s, ev);
	};
	const reportStart = (id: string, args: unknown) => ({
		type: "tool_execution_start",
		toolName: "report_outcome",
		toolCallId: id,
		args,
	});
	const reportEnd = (id: string, isError: boolean, text: string) => ({
		type: "tool_execution_end",
		toolName: "report_outcome",
		toolCallId: id,
		isError,
		result: { content: [{ type: "text", text }] },
	});

	test("a propose_task start is captured with its model; the first valid call wins", () => {
		const s = newEventState();
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p1",
			args: { prompt: "Add tests for X", model: "zai/glm" },
		});
		expect(s.proposed).toEqual({
			prompt: "Add tests for X",
			model: "zai/glm",
		});
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p2",
			args: { prompt: "Second proposal" },
		});
		expect(s.proposed?.prompt).toBe("Add tests for X");
	});

	test("propose_task without a non-empty prompt or before any call leaves proposed null; a bad call does not block a later good one", () => {
		const s = newEventState();
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p1",
			args: { prompt: "" },
		});
		expect(s.proposed).toBeNull();
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p2",
			args: { prompt: "Good" },
		});
		expect(s.proposed).toEqual({ prompt: "Good", model: null });
	});

	test("a model-less or non-string model propose becomes null", () => {
		const s = newEventState();
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p1",
			args: { prompt: "P", model: 42 },
		});
		expect(s.proposed).toEqual({ prompt: "P", model: null });
	});

	test("a review's propose_task calls all land in recorded, with rank and security", () => {
		const s = newEventState();
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p1",
			args: { prompt: "First", rank: 1, security: "critical" },
		});
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p2",
			args: { prompt: "Second", rank: 2 },
		});
		expect(s.recorded).toEqual([
			{ prompt: "First", model: null, rank: 1, security: "critical" },
			{ prompt: "Second", model: null, rank: 2, security: null },
		]);
		// Retro semantics keep the first valid call as the proposal.
		expect(s.proposed).toEqual({ prompt: "First", model: null });
	});

	test("a bad rank, a fractional rank, and an unknown security fall back to null", () => {
		const s = newEventState();
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p1",
			args: { prompt: "P", rank: 0, security: "low" },
		});
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p2",
			args: { prompt: "Q", rank: 1.5 },
		});
		expect(s.recorded).toEqual([
			{ prompt: "P", model: null, rank: null, security: null },
			{ prompt: "Q", model: null, rank: null, security: null },
		]);
	});

	test("a bad prompt call records nothing, a later good one still lands", () => {
		const s = newEventState();
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p1",
			args: { prompt: "" },
		});
		feed(s, {
			type: "tool_execution_start",
			toolName: "propose_task",
			toolCallId: "p2",
			args: { prompt: "Good", rank: 3 },
		});
		expect(s.recorded).toEqual([
			{ prompt: "Good", model: null, rank: 3, security: null },
		]);
	});

	test("a. errored bash end with approval text flags approvalRefused even when not remembered", () => {
		const s = newEventState();
		feed(
			s,
			{
				type: "tool_execution_start",
				toolName: "bash",
				toolCallId: "b1",
				args: { command: "ls" },
			},
			{
				type: "tool_execution_end",
				toolName: "bash",
				toolCallId: "b1",
				isError: true,
				result: {
					content: [
						{
							type: "text",
							text: `Tool "bash" ${APPROVAL_REFUSAL}.\nOptions: ...`,
						},
					],
				},
			},
		);
		expect(s.approvalRefused).toBe(true);
	});

	test("b. successful report_outcome end sets outcome", () => {
		const s = newEventState();
		const args = { status: "ready", summary: "done" };
		feed(s, reportStart("r1", args), reportEnd("r1", false, "ok"));
		expect(s.outcome).toEqual({ status: "ready", summary: "done" });
	});

	test("c. errored report_outcome end leaves outcome null", () => {
		const s = newEventState();
		feed(
			s,
			reportStart("r1", { status: "ready", summary: "done" }),
			reportEnd("r1", true, "boom"),
		);
		expect(s.outcome).toBeNull();
		expect(s.approvalRefused).toBe(false);
	});

	test("d. invalid status in report_outcome args is ignored", () => {
		const s = newEventState();
		feed(
			s,
			reportStart("r1", { status: "bogus", summary: "x" }),
			reportEnd("r1", false, "ok"),
		);
		expect(s.outcome).toBeNull();
	});

	test("e. terminal agent_end sets sawTerminalEnd and finalText from last assistant text parts", () => {
		const s = newEventState();
		feed(s, {
			type: "agent_end",
			isTerminal: true,
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "part1" },
						{ type: "text", text: "part2" },
					],
				},
			],
		});
		expect(s.sawTerminalEnd).toBe(true);
		expect(s.finalText).toBe("part1part2");
	});

	test("f. a later valid report_outcome replaces an earlier one", () => {
		const s = newEventState();
		feed(
			s,
			reportStart("r1", { status: "ready", summary: "first" }),
			reportEnd("r1", false, "ok"),
			reportStart("r2", { status: "answered", summary: "second" }),
			reportEnd("r2", false, "ok"),
		);
		expect(s.outcome).toEqual({ status: "answered", summary: "second" });
	});

	test("g. first session event sets sessionId, a second one does not change it", () => {
		const s = newEventState();
		expect(applyEvent(s, { type: "session", id: "s1" })).toEqual({
			sessionStarted: "s1",
		});
		expect(s.sessionId).toBe("s1");
		expect(applyEvent(s, { type: "session", id: "s2" })).toEqual({});
		expect(s.sessionId).toBe("s1");
	});

	test("h. assistant message_start captures provider/model, later ones win", () => {
		const s = newEventState();
		expect(s.model).toBeNull();
		feed(
			s,
			{
				type: "message_start",
				message: {
					role: "assistant",
					content: [],
					provider: "zai",
					model: "glm-5.3-flash",
				},
			},
			{
				type: "message_start",
				message: {
					role: "user",
					content: [],
					provider: "other",
					model: "ignored",
				},
			},
			{
				type: "message_start",
				message: {
					role: "assistant",
					content: [],
					provider: "openai",
					model: "gpt-5",
				},
			},
		);
		expect(s.model).toBe("openai/gpt-5");
	});

	test("i. assistant message_start without provider keeps bare model, junk is ignored", () => {
		const s = newEventState();
		feed(
			s,
			{
				type: "message_start",
				message: { role: "assistant", content: [], model: "glm-5.3-flash" },
			},
			{
				type: "message_start",
				message: { role: "assistant", content: [], model: "" },
			},
			{
				type: "message_start",
				message: { role: "assistant", content: [], model: 42 },
			},
			{ type: "message_start", message: "nope" },
			{ type: "message_start" },
		);
		expect(s.model).toBe("glm-5.3-flash");
	});

	test("provider errors ignore other roles and clear after a successful retry", () => {
		const s = newEventState();
		const failed = {
			role: "assistant",
			stopReason: "error",
			errorMessage: "429 quota exhausted",
		};
		feed(s, { type: "message_end", message: failed });
		expect(s.providerError).toBe("429 quota exhausted");
		feed(s, {
			type: "message_end",
			message: {
				...failed,
				role: "toolResult",
				errorMessage: "not a provider",
			},
		});
		expect(s.providerError).toBe("429 quota exhausted");
		feed(s, {
			type: "message_end",
			message: { role: "assistant", stopReason: "toolUse" },
		});
		expect(s.providerError).toBeNull();
		feed(s, {
			type: "message_end",
			message: { ...failed, errorMessage: { message: "malformed" } },
		});
		expect(s.providerError).toBeNull();
	});

	test("j. report_outcome through the xd:// device takes its args from the end event's details", () => {
		// Shape recorded from omp's JSON stream on 2026-09-27: the `write` tool carries the call.
		const start = {
			type: "tool_execution_start",
			toolName: "write",
			toolCallId: "w1",
			args: { path: "xd://report_outcome", content: "{}" },
		};
		const end = (isError: boolean, tool: string, args: unknown) => ({
			type: "tool_execution_end",
			toolName: "write",
			toolCallId: "w1",
			isError,
			result: {
				content: [{ type: "text", text: "Outcome recorded" }],
				details: { xdev: { tool, mode: "execute", args } },
			},
		});
		const outcomeAfter = (ev: unknown) => {
			const s = newEventState();
			feed(s, start, ev);
			return s.outcome;
		};
		expect(
			outcomeAfter(
				end(false, "report_outcome", { status: "ready", summary: "done" }),
			),
		).toEqual({ status: "ready", summary: "done" });
		expect(
			outcomeAfter(
				end(true, "report_outcome", { status: "ready", summary: "done" }),
			),
		).toBeNull();
		expect(
			outcomeAfter(
				end(false, "report_outcome", { status: "bogus", summary: "x" }),
			),
		).toBeNull();
		expect(
			outcomeAfter(
				end(false, "ast_edit", { status: "ready", summary: "done" }),
			),
		).toBeNull();
	});

	test("k. ask tool_execution_start is normalized onto the state, the first usable ask wins", () => {
		const s = newEventState();
		feed(
			s,
			{
				type: "tool_execution_start",
				toolName: "ask",
				toolCallId: "a1",
				args: { questions: [{ question: "Q1?", options: [{ label: "a" }] }] },
			},
			{
				type: "tool_execution_start",
				toolName: "ask",
				toolCallId: "a2",
				args: {
					questions: [
						{
							question: "Q2?",
							options: [{ label: "b" }, { label: "c", description: "best" }],
							multi: true,
							recommended: 9,
						},
					],
				},
			},
		);
		// The extension refuses the second ask, so Q1 is the one waiting for an answer;
		// surfacing Q2 would resume a session that expects Q1's answer.
		expect(s.asked).toEqual([
			{
				question: "Q1?",
				options: [{ label: "a" }],
				multi: false,
				recommended: null,
			},
		]);
	});

	test("l. malformed ask args and the task tool never take the ask slot", () => {
		const s = newEventState();
		feed(
			s,
			{
				type: "tool_execution_start",
				toolName: "ask",
				toolCallId: "a1",
				args: { questions: "nope" },
			},
			{
				type: "tool_execution_start",
				toolName: "ask",
				toolCallId: "a2",
				args: {},
			},
			{
				type: "tool_execution_start",
				toolName: "task",
				toolCallId: "a3",
				args: { questions: [{ question: "Q?", options: [] }] },
			},
			// An unusable ask does not consume the first-ask slot: the next usable one is durable.
			{
				type: "tool_execution_start",
				toolName: "ask",
				toolCallId: "a4",
				args: {
					questions: [{ question: "Usable?", options: [{ label: "y" }] }],
				},
			},
		);
		expect(s.asked).toEqual([
			{
				question: "Usable?",
				options: [{ label: "y" }],
				multi: false,
				recommended: null,
			},
		]);
	});
});

/** EventEmitter stand-in for the spawned omp child; the only lie is the cast in the launcher. */
class FakeOmp extends EventEmitter {
	pid: number | undefined;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = Object.assign(new EventEmitter(), {
		write: (s: string) => {
			this.written.push(s);
		},
		end: () => {},
	});
	written: string[] = [];

	constructor(pid?: number) {
		super();
		this.pid = pid;
	}
}

function fakeStart(o: {
	logPath: string;
	pid?: number;
	onSession?: (sessionId: string) => void;
}) {
	const fake = new FakeOmp(o.pid);
	const launcher: RunLauncher = () => fake as unknown as ChildProcess; // the fake stands in for Node's class
	const handle = startRun({
		cwd: "/unused",
		prompt: "do the thing",
		sessionDir: "/unused",
		extensionPath: "/unused.ts",
		resumeId: null,
		logPath: o.logPath,
		dataRoot: dirname(o.logPath),
		onSession: o.onSession,
		launcher,
	});
	return { handle, fake };
}

describe("startRun", () => {
	test("a pinned sessionName reaches the child env; unpinned launches inherit untouched", async () => {
		// A task session inherits OTTR_BOARD_URL from its own board, and the operator value
		// wins over the injected coordinates: on a non-default board port the assertion
		// below would flip. The test needs the injection path, so drop any ambient value.
		const ambientBoardUrl = process.env.OTTR_BOARD_URL;
		delete process.env.OTTR_BOARD_URL;
		const dir = mkdtempSync(join(tmpdir(), "ottr-startrun-"));
		try {
			const seen: Parameters<RunLauncher>[2][] = [];
			const fakes: FakeOmp[] = [];
			const launcher: RunLauncher = (_c, _a, options) => {
				seen.push(options);
				const fake = new FakeOmp();
				fakes.push(fake);
				return fake as unknown as ChildProcess;
			};
			const base = {
				cwd: "/unused",
				prompt: "do the thing",
				sessionDir: "/unused",
				extensionPath: "/unused.ts",
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher,
			};
			const pinned = startRun({ ...base, sessionName: "Architecture review" });
			const plain = startRun({ ...base });
			const board = startRun({
				...base,
				board: {
					url: "http://127.0.0.1:4747",
					token: "boot-token",
					project: "ottr",
					taskId: "tid",
				},
			});
			for (const fake of fakes) fake.emit("close", 0);
			await Promise.all([pinned.done, plain.done, board.done]);

			expect(seen[0]!.env).toMatchObject({
				OTTR_SESSION_NAME: "Architecture review",
			});
			// The env spread keeps each key's original casing ("Path" on some Windows
			// environments, "PATH" elsewhere), so look it up case-insensitively.
			const pathKey = Object.keys(seen[0]!.env!).find(
				(k) => k.toUpperCase() === "PATH",
			);
			expect(pathKey).toBeDefined();
			expect(seen[0]!.env![pathKey!]).toBe(process.env.PATH);
			// Every local launch now passes an explicit env (worker credentials stripped);
			// the plain launch's base is still the inherited process env.
			expect("env" in seen[1]!).toBe(true);
			expect(seen[1]!.env).not.toHaveProperty("OTTR_WORKER_TOKEN");
			expect(seen[2]!.env).toMatchObject({
				OTTR_BOARD_URL: "http://127.0.0.1:4747",
				OTTR_BOARD_TOKEN: "boot-token",
				OTTR_PROJECT: "ottr",
				OTTR_TASK_ID: "tid",
			});
		} finally {
			if (ambientBoardUrl !== undefined)
				process.env.OTTR_BOARD_URL = ambientBoardUrl;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("splits JSON events across chunks, writes the prompt, and settles the result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-startrun-"));
		try {
			const logPath = join(dir, "logs", "run.log");
			const sessions: string[] = [];
			const { handle, fake } = fakeStart({
				logPath,
				pid: 7,
				onSession: (sid) => sessions.push(sid),
			});
			expect(handle.pid).toBe(7);

			const l1 = JSON.stringify({ type: "session", id: "sess-9" });
			const l2 = JSON.stringify({
				type: "message_start",
				message: { role: "assistant", provider: "zai", model: "glm-5.3-flash" },
			});
			const stream = `${l1}\n${l2}\nplain stdout noise`;
			fake.stdout.emit("data", Buffer.from(stream.slice(0, 30), "utf8")); // cut mid-JSON
			fake.stdout.emit("data", Buffer.from(stream.slice(30), "utf8")); // rest, no trailing newline
			fake.stderr.emit("data", Buffer.from("warn: slow disk\n", "utf8"));
			fake.emit("close", 0); // close flushes the trailing partial line

			const r = await handle.done;
			expect(fake.written).toEqual(["do the thing"]);
			expect(sessions).toEqual(["sess-9"]);
			expect(r).toMatchObject({
				exitCode: 0,
				sessionId: "sess-9",
				model: "zai/glm-5.3-flash",
				sawTerminalEnd: false,
				killed: false,
				stderrTail: "warn: slow disk\n",
			});
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("[omp session sess-9]");
			expect(log).toContain("plain stdout noise");
			expect(log).toContain("! warn: slow disk");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a provider error reaches the card without stderr and hides credentials", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-provider-error-"));
		const stored = "plain-stored-0000";
		setGitSecrets([stored]);
		try {
			const logPath = join(dir, "run.log");
			const { handle, fake } = fakeStart({ logPath });
			const hidden = "test-only-value";
			const event = {
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: [
						"429 Weekly/Monthly Limit Exhausted.",
						`Authorization: Bearer ${hidden}`,
						`password="${hidden} \\"private-fragment\\""`,
						`https://${hidden}:${hidden}@example.invalid/?token=${hidden}`,
						`sk-proj-${hidden} github_pat_${hidden} AIza${hidden}`,
						`eyJ${hidden}.payload.signature`,
						`retry with Bearer ${hidden}`,
						`echo ${stored}`,
					].join("\n"),
				},
			};
			fake.stdout.emit("data", Buffer.from(JSON.stringify(event)));
			fake.emit("close", 1);
			const r = await handle.done;
			const next = classify({
				kind: "work",
				result: r,
				git: git(),
				target: "origin/main",
				previousError: null,
				images: 1,
			});
			expect(next.state).toBe("needs_you");
			expect(next.needsReason).toContain("429 Weekly/Monthly Limit Exhausted");
			expect(next.needsReason).not.toContain("test-only-value");
			expect(next.needsReason).not.toContain("private-fragment");
			expect(next.needsReason).not.toContain(stored);
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("429 Weekly/Monthly Limit Exhausted");
			expect(log).not.toContain("test-only-value");
			expect(log).not.toContain("private-fragment");
			expect(next.quarantineImages).toBeUndefined();
		} finally {
			setGitSecrets([]);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a spawn failure settles exitCode null and logs the error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-startrun-"));
		try {
			const logPath = join(dir, "run.log");
			const { handle, fake } = fakeStart({ logPath, pid: undefined });
			expect(handle.pid).toBeNull();

			fake.emit("error", new Error("spawn omp ENOENT"));
			const r = await handle.done;
			expect(r.exitCode).toBeNull();
			expect(r.stderrTail).toContain("spawn omp ENOENT");
			expect(readFileSync(logPath, "utf8")).toContain("! spawn omp ENOENT");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("workerFromEnv", () => {
	test("absent or empty OTTR_WORKER_URLS is null", () => {
		expect(workerFromEnv({})).toBeNull();
		expect(workerFromEnv({ OTTR_WORKER_URLS: " , " })).toBeNull();
	});

	test("urls without a token fail closed; a token is carried", () => {
		expect(() =>
			workerFromEnv({ OTTR_WORKER_URLS: " http://a:1 , ,http://b:2 " }),
		).toThrow("OTTR_WORKER_TOKEN");
		expect(
			workerFromEnv({
				OTTR_WORKER_URLS: "http://a:1",
				OTTR_WORKER_TOKEN: "t",
			}),
		).toEqual({ urls: ["http://a:1"], token: "t" });
	});
});

describe("startRun worker dispatch", () => {
	// The compiled omp stand-in is built once at module scope (see the top of this file).

	function baseOpts(dir: string, logPath: string) {
		return {
			cwd: dir,
			prompt: "do it",
			sessionDir: join(dir, "sessions"),
			extensionPath: join(dir, "ext.ts"),
			resumeId: null,
			logPath,
			dataRoot: dir,
		};
	}

	test("a worker target runs the turn over HTTP, not the launcher", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		const server = serveWorker({ port: 0, ompPath: workerOmp });
		try {
			const logPath = join(dir, "run.log");
			let launched = 0;
			const { pid, done } = startRun({
				...baseOpts(dir, logPath),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
				launcher: (() => {
					launched++;
					return new FakeOmp() as unknown as ChildProcess;
				}) as RunLauncher,
			});
			expect(pid).toBeNull();
			const r = await done;
			expect(r.exitCode).toBe(0);
			expect(r.killed).toBe(false);
			expect(r.sessionId).toBe("sess-worker");
			expect(r.sawTerminalEnd).toBe(true);
			expect(launched).toBe(0);
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("worker: dispatching to");
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000); // The dispatch runs the real daemon and a real child; the 5 s default is tighter than that under load.

	test("a connect failure falls back to the local launcher", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		const saved = {
			GH_TOKEN: process.env.GH_TOKEN,
			OTTR_WORKER_TOKEN: process.env.OTTR_WORKER_TOKEN,
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		};
		process.env.GH_TOKEN = "ghp_board_token";
		process.env.OTTR_WORKER_TOKEN = "worker-secret";
		process.env.PI_CODING_AGENT_DIR = "/etc/ottr/omp-agent";
		try {
			const logPath = join(dir, "run.log");
			const fake = new FakeOmp();
			// The fallback starts inside the done-.catch, a tick later; the fake must
			// emit close only once startLocal's listeners are attached, so the launcher
			// schedules it.
			const seen: Parameters<RunLauncher>[2][] = [];
			const launcher: RunLauncher = (_c, _a, options) => {
				seen.push(options);
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			// A server that was stopped: the port refuses connections immediately.
			const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
			const deadUrl = `http://127.0.0.1:${dead.port}`;
			dead.stop(true);
			const handle = startRun({
				...baseOpts(dir, logPath),
				worker: { urls: [deadUrl] },
				board: {
					url: "http://127.0.0.1:4747",
					token: "boot-token",
					project: "ottr",
					taskId: "t1",
				},
				launcher,
			});
			fake.emit("close", 0);
			const r = await handle.done;
			expect(r.exitCode).toBe(0);
			// The fallback is still a work turn on the server: neither the worker token
			// nor the board's GitHub token may reach it (D6); the board coordinates must.
			// The pinned agent dir stays out too: a turn must not hold the directory the
			// board's privileged turns execute (R5-1).
			expect(seen[0]!.env).not.toHaveProperty("OTTR_WORKER_TOKEN");
			expect(seen[0]!.env).not.toHaveProperty("GH_TOKEN");
			expect(seen[0]!.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
			expect(seen[0]!.env).toHaveProperty("OTTR_BOARD_TOKEN", "boot-token");
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("worker: dispatching to");
			expect(log).toContain("falling back to local spawn");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("R5-1: a plugin or skill planted in the shared home never reaches the board's own omp", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-board-home-"));
		const shared = join(dir, "shared");
		const board = join(dir, "board");
		// A work turn's plants. omp loads plugins from <HOME>/.omp/plugins and user skills from
		// <HOME>/.agents/skills, whatever PI_CODING_AGENT_DIR says.
		const plants = [
			[".omp", "plugins", "node_modules", "planted"],
			[".agents", "skills", "planted"],
		];
		for (const p of plants) mkdirSync(join(shared, ...p), { recursive: true });
		mkdirSync(board);
		const reachable = (env: NodeJS.ProcessEnv | undefined): number =>
			plants.filter((p) => existsSync(join(env?.HOME ?? "", ...p))).length;
		const saved = {
			OTTR_BOARD_OMP_HOME: process.env.OTTR_BOARD_OMP_HOME,
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		};
		process.env.OTTR_BOARD_OMP_HOME = board;
		delete process.env.PI_CODING_AGENT_DIR;
		try {
			const seen: Parameters<RunLauncher>[2][] = [];
			const launcher: RunLauncher = (_c, _a, options) => {
				seen.push(options);
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			// The board process's HOME is the shared home; the run's env carries it here so the
			// test never moves the process-wide HOME other suites read.
			const opts = { env: { HOME: shared }, launcher };
			// A board-side turn (merge, release review, release): no worker target.
			await startRun({ ...baseOpts(dir, join(dir, "board.log")), ...opts })
				.done;
			// A work turn whose worker is down runs locally and keeps the shared home.
			const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
			const deadUrl = `http://127.0.0.1:${dead.port}`;
			dead.stop(true);
			await startRun({
				...baseOpts(dir, join(dir, "work.log")),
				...opts,
				worker: { urls: [deadUrl] },
			}).done;
			expect(seen.map((s) => s.env?.HOME)).toEqual([board, shared]);
			expect(reachable(seen[0]!.env)).toBe(0);
			expect(reachable(seen[1]!.env)).toBe(plants.length);
			expect(seen[1]!.env).not.toHaveProperty("OTTR_BOARD_OMP_HOME");
			// The board's own config readers (model roles, sign-in store) follow its omp.
			expect(agentDir()).toBe(join(board, ".omp", "agent"));
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a 500 spawn-failed body reaches the dispatch context and the failure reason", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("spawn failed: no such image", { status: 500 }),
		});
		try {
			const fake = new FakeOmp(4242);
			// The fallback starts inside the done-.catch, a tick later; the fake must
			// emit close only once startLocal's listeners are attached, so the launcher
			// schedules it.
			const launcher: RunLauncher = () => {
				queueMicrotask(() => fake.emit("close", 1));
				return fake as unknown as ChildProcess;
			};
			const handle = startRun({
				...baseOpts(dir, join(dir, "run.log")),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
				launcher,
			});
			fake.emit("close", 1);
			const r = await handle.done;
			expect(r.exitCode).toBe(1);
			expect(r.stderrTail).toBe("");
			expect(r.dispatch).toContain(
				`local fallback (worker http://127.0.0.1:${server.port} responded 500: spawn failed: no such image)`,
			);
			expect(r.dispatch).toContain("argv ");
			expect(r.dispatch).toContain("pid 4242");
			// The board's failure reason answers "why did my turn die" in one glance.
			const next = classify({
				kind: "work",
				result: r,
				git: git(),
				target: null,
				previousError: null,
			});
			expect(next.needsReason).toContain(
				"before finishing (dispatch local fallback (worker http://127.0.0.1:",
			);
			expect(next.needsReason).toContain("spawn failed: no such image");
			expect(next.needsReason?.endsWith(", no stderr).")).toBe(true);
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a worker never receives the board's GitHub token or data dir (D6)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		let forwarded: object | null = null;
		// Records the run request, then refuses it: the turn falls back to the local launcher.
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const body: unknown = await req.json();
				if (
					typeof body === "object" &&
					body !== null &&
					"env" in body &&
					typeof body.env === "object" &&
					body.env !== null
				)
					forwarded = body.env;
				return new Response("spawn failed: recorded", { status: 500 });
			},
		});
		const saved = {
			GH_TOKEN: process.env.GH_TOKEN,
			OTTR_DATA_DIR: process.env.OTTR_DATA_DIR,
			OTTR_SERVER_DATA_DIR: process.env.OTTR_SERVER_DATA_DIR,
			OTTR_PROBE_KEPT: process.env.OTTR_PROBE_KEPT,
		};
		process.env.GH_TOKEN = "ghp_board_token";
		process.env.OTTR_DATA_DIR = join(dir, "data");
		process.env.OTTR_SERVER_DATA_DIR = join(dir, "state");
		process.env.OTTR_PROBE_KEPT = "kept"; // stands in for provider keys, which must travel
		try {
			const fake = new FakeOmp();
			const launcher: RunLauncher = () => {
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const handle = startRun({
				...baseOpts(dir, join(dir, "run.log")),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
				launcher,
			});
			await handle.done;
			expect(forwarded).not.toBeNull();
			expect(forwarded).not.toHaveProperty("GH_TOKEN");
			expect(forwarded).not.toHaveProperty("OTTR_DATA_DIR");
			expect(forwarded).not.toHaveProperty("OTTR_SERVER_DATA_DIR");
			expect(forwarded).toHaveProperty("OTTR_PROBE_KEPT", "kept");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a worker's forwarded env holds no git credential names (D6)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		let forwarded: Record<string, string> | null = null;
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const body: unknown = await req.json();
				if (
					typeof body === "object" &&
					body !== null &&
					"env" in body &&
					typeof body.env === "object" &&
					body.env !== null
				)
					forwarded = body.env as Record<string, string>;
				return new Response("spawn failed: recorded", { status: 500 });
			},
		});
		const names = [
			"GIT_SSH_COMMAND",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
			"OTTR_GIT_TOKEN_0",
			"OTTR_GIT_USER_0",
		];
		const keyPath = "/srv/ottr/.tasks/ssh/global";
		const saved: Record<string, string | undefined> = {};
		for (const n of names) {
			saved[n] = process.env[n];
			process.env[n] = keyPath;
		}
		try {
			const fake = new FakeOmp();
			const launcher: RunLauncher = () => {
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const handle = startRun({
				...baseOpts(dir, join(dir, "run.log")),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
				launcher,
			});
			await handle.done;
			expect(forwarded).not.toBeNull();
			for (const n of names) expect(forwarded).not.toHaveProperty(n);
			// No credential value (here: the key path string) survives anywhere in the payload.
			expect(JSON.stringify(forwarded)).not.toContain(keyPath);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("kill on a worker run settles killed immediately", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		// A daemon that never answers keeps the run unsettled, which is the kill path.
		const server = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
		try {
			const handle = startRun({
				...baseOpts(dir, join(dir, "run.log")),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
			});
			await handle.kill();
			const r = await handle.done;
			expect(r.exitCode).toBeNull();
			expect(r.killed).toBe(true);
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15000);
});

describe("classify workerLost", () => {
	test("first loss queues an automatic resume with '.'", () => {
		const next = classify({
			kind: "work",
			result: result({ workerLost: true, exitCode: null }),
			git: git(),
			target: null,
			previousError: null,
		});
		expect(next.state).toBe("queued");
		expect(next.pendingPrompt).toBe(".");
		expect(next.needsReason).toContain(WORKER_LOST);
	});

	test("a repeat loss within the streak needs you", () => {
		const next = classify({
			kind: "work",
			result: result({ workerLost: true, exitCode: null }),
			git: git(),
			target: null,
			previousError: `${WORKER_LOST} - resuming automatically. Cancel to stop it instead.`,
		});
		expect(next.state).toBe("needs_you");
		expect(next.needsReason).toContain(WORKER_LOST);
	});
});

describe("arch-review changed-line coverage", () => {
	test("createRunSink() redacts stored git secrets from the task log and the stderr tail", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-sink-"));
		const secret = "glpat-merge-echo-0000";
		setGitSecrets([secret]);
		try {
			const logPath = join(dir, "run.log");
			const sink = createRunSink({ logPath, dataRoot: dir });
			sink.stderr(`remote: denied for ${secret}\n`);
			sink.stdout(`not json ${secret}\n`);
			const log = readFileSync(logPath, "utf8");
			expect(log).not.toContain(secret);
			expect(log).toContain("[REDACTED]");
			expect(sink.tail()).not.toContain(secret);
		} finally {
			setGitSecrets([]);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("createRunSink() redacts a token split across two writes and two stderr chunks", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-sink-"));
		const secret = "glpat-split-across-0000";
		setGitSecrets([secret]);
		try {
			const logPath = join(dir, "run.log");
			const sink = createRunSink({ logPath, dataRoot: dir });
			sink.logMark(`push to ${secret.slice(0, 9)}`);
			sink.logMark(`${secret.slice(9)} failed\n`);
			sink.stderr(`remote: ${secret.slice(0, 5)}`);
			sink.stderr(`${secret.slice(5)} denied\n`);
			sink.flush();
			const log = readFileSync(logPath, "utf8");
			expect(log).not.toContain(secret.slice(0, 9));
			expect(log).toContain("push to [REDACTED] failed");
			expect(log).toContain("! remote: [REDACTED] denied");
		} finally {
			setGitSecrets([]);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a plain local run (a merge turn) gets no git host auth from the server env", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-local-"));
		const names = [
			"GIT_SSH_COMMAND",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
			"OTTR_GIT_TOKEN_0",
			"OTTR_GIT_USER_0",
		];
		for (const n of names) process.env[n] = `planted-${n}`;
		try {
			const fake = new FakeOmp();
			const seen: Parameters<RunLauncher>[2][] = [];
			const handle = startRun({
				cwd: dir,
				prompt: "merge it",
				sessionDir: join(dir, "sessions"),
				extensionPath: join(dir, "ext.ts"),
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher: (_c, _a, options) => {
					seen.push(options);
					queueMicrotask(() => fake.emit("close", 0));
					return fake as unknown as ChildProcess;
				},
			});
			await handle.done;
			for (const n of names) expect(seen[0]!.env).not.toHaveProperty(n);
		} finally {
			for (const n of names) delete process.env[n];
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("createRunSink() keeps redacting a token rotated away while the run lasts", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-sink-"));
		const old = "glpat-rotated-away-0000";
		setGitSecrets([old]);
		try {
			const logPath = join(dir, "run.log");
			const sink = createRunSink({ logPath, dataRoot: dir });
			setGitSecrets(["glpat-new-token-00000"]);
			sink.stderr(`push failed for ${old}\n`);
			sink.flush();
			expect(readFileSync(logPath, "utf8")).not.toContain(old);
			expect(sink.tail()).not.toContain(old);
		} finally {
			setGitSecrets([]);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("createRunSink().result() merges the event-state snapshot with the caller's settle fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-sink-"));
		try {
			const sink = createRunSink({
				logPath: join(dir, "run.log"),
				dataRoot: dir,
			});
			sink.line(JSON.stringify({ type: "session", id: "sess-sink" }));
			sink.line(
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "ask",
					toolCallId: "a1",
					args: {
						questions: [{ question: "Q?", options: [{ label: "y" }] }],
					},
				}),
			);
			sink.line(
				JSON.stringify({
					type: "agent_end",
					isTerminal: true,
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "done text" }],
						},
					],
				}),
			);
			sink.stderr("boom\n");
			const r = sink.result({
				exitCode: 3,
				killed: true,
				stderrTail: sink.tail(),
				dispatch: "local, argv 6, cwd d, pid 1, 2s",
			});
			expect(r).toEqual({
				sessionId: "sess-sink",
				model: null,
				outcome: null,
				asked: [
					{
						question: "Q?",
						options: [{ label: "y" }],
						multi: false,
						recommended: null,
					},
				],
				proposed: null,
				recorded: [],
				approvalRefused: false,
				sawTerminalEnd: true,
				finalText: "done text",
				providerError: null,
				exitCode: 3,
				killed: true,
				stderrTail: "boom\n",
				dispatch: "local, argv 6, cwd d, pid 1, 2s",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("result(): caller-provided fields override the snapshot fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-sink-"));
		try {
			const sink = createRunSink({
				logPath: join(dir, "run.log"),
				dataRoot: dir,
			});
			sink.line(JSON.stringify({ type: "session", id: "sess-a" }));
			const r = sink.result({
				exitCode: 0,
				killed: false,
				stderrTail: "",
				sessionId: "caller-wins",
			});
			expect(r.sessionId).toBe("caller-wins");
			expect(r.sawTerminalEnd).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")(
		"createRunSink() refuses a log dir planted as a symlink and writes nothing outside",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "ottr-sink-"));
			const outside = mkdtempSync(join(tmpdir(), "ottr-outside-"));
			try {
				symlinkSync(outside, join(dir, "logs"));
				expect(() =>
					createRunSink({
						logPath: join(dir, "logs", "run.log"),
						dataRoot: dir,
					}),
				).toThrow(/refusing/);
				expect(readdirSync(outside)).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
				rmSync(outside, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform !== "linux")(
		"createRunSink() refuses a log file planted as a symlink and leaves its target unchanged",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "ottr-sink-"));
			const outside = mkdtempSync(join(tmpdir(), "ottr-outside-"));
			try {
				const target = join(outside, "victim.txt");
				writeFileSync(target, "original\n");
				const logPath = join(dir, "run.log");
				symlinkSync(target, logPath);
				const sink = createRunSink({ logPath, dataRoot: dir });
				expect(() => {
					sink.logMark("planted\n");
					sink.flush();
				}).toThrow(/refusing/);
				expect(readFileSync(target, "utf8")).toBe("original\n");
			} finally {
				rmSync(dir, { recursive: true, force: true });
				rmSync(outside, { recursive: true, force: true });
			}
		},
	);
});

import { describe, expect, mock, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { IdentProbeEnv } from "./gitIdentity.ts";
import { readLayerUse } from "./layers.ts";
import { agentDir } from "./login.ts";
import { pluginSkillsOverlayPath } from "./pluginSkills.ts";
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
	hitUsageLimit,
	NO_DISCOVERY_CONFIG,
	newEventState,
	OOM_KILL,
	QUOTA_LIMIT,
	rateLimitWaitMs,
	rejectedReport,
	renderEvent,
	resumePlan,
	startRun,
	usageLimitResetMs,
	vmEnv,
	vmProviders,
	vmRunnerFromEnv,
	WORKER_LOST,
	workerFromEnv,
} from "./runner.ts";
import type {
	GitFacts,
	Next,
	Outcome,
	RecordedFinding,
	RunResult,
	TurnKind,
} from "./types.ts";
import { VmTokens } from "./vmTokens.ts";
import {
	serveWorker,
	type VmOutcome,
	WORKER_DONE,
	type WorkerRequest,
} from "./workers.ts";
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

/**
 * Builds a compiled fake omp once per source content, at a fixed hash-keyed temp path,
 * and reuses the exe when it exists. Compiling per load leaked ~100 MB folders into the
 * temp dir on every bun test and every Stryker mutant run (OTTR-524); killed mutant
 * runs never reach afterAll, so deletion cannot be relied on — reuse can. The js and
 * the exe stage under pid-suffixed temp names and rename into place, so parallel
 * test-file loads never race on a half-written build. The folder keeps an ottr- prefix,
 * so worker.ts's hourly sweepTmpDirs ages it out like any other test litter once the
 * source changes and the hash moves on.
 */
const compiledFakeOmp = (
	prefix: string,
	exeName: string,
	source: string,
): string => {
	const dir = join(
		tmpdir(),
		`${prefix}${createHash("sha256").update(source).digest("hex").slice(0, 16)}`,
	);
	const exe = join(dir, exeName);
	if (existsSync(exe)) return exe;
	mkdirSync(dir, { recursive: true });
	const js = join(dir, `${exeName}.js`);
	const jsTmp = `${js}.${process.pid}.tmp`;
	writeFileSync(jsTmp, source);
	renameSync(jsTmp, js);
	const exeTmp = `${exe}.${process.pid}.tmp`;
	Bun.spawnSync([
		process.execPath,
		"build",
		"--compile",
		js,
		"--outfile",
		exeTmp,
	]);
	renameSync(exeTmp, exe);
	return exe;
};

// A compiled stand-in for worker-dispatched omp. `bun build --compile` alone can take
// seconds under concurrent machine load, so it runs once here, outside every test's
// timeout budget; a compiled exe also boots without bun's per-spawn transpile cost.
const workerOmpSource = `process.stdout.write("ARGV " + JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(JSON.stringify({ type: "session", id: "sess-worker" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end", isTerminal: true }) + "\\n");
process.exit(0);`;
const workerOmp = compiledFakeOmp(
	"ottr-worker-omp-",
	"fake-omp.exe",
	workerOmpSource,
);

describe("compiledFakeOmp", () => {
	test("a second load of the same source reuses the compiled exe without recompiling", () => {
		const before = statSync(workerOmp);
		const again = compiledFakeOmp(
			"ottr-worker-omp-",
			"fake-omp.exe",
			workerOmpSource,
		);
		expect(again).toBe(workerOmp);
		// A rebuild would rename a fresh exe over this one: a new inode with a new mtime.
		const after = statSync(again);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});
});

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
					OTTR_BACKUP_DIR: "/backup",
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
					ALATE_API_KEY: "alate-secret",
					GH_TOKEN: "ghp_x",
				},
			}),
		).toEqual({ PATH: "/bin", GH_TOKEN: "ghp_x" });
	});
	test("strips proxy credentials; a proxy URL without userinfo stays byte-identical", () => {
		expect(
			childEnv({
				base: {
					PATH: "/bin",
					HTTP_PROXY: "http://proxy:8080",
					HTTPS_PROXY: "http://user:pass@proxy:8080",
					https_proxy: "http://otherserver:s3cret@proxy:3128",
					ALL_PROXY: "socks5://user:pass@proxy:1080",
					// No scheme:// authority: not a URL the strip can read; unchanged.
					all_proxy: "user:pass@proxy:1080",
					NO_PROXY: "localhost,127.0.0.1",
				},
			}),
		).toEqual({
			PATH: "/bin",
			HTTP_PROXY: "http://proxy:8080",
			HTTPS_PROXY: "http://proxy:8080",
			https_proxy: "http://proxy:3128",
			ALL_PROXY: "socks5://proxy:1080",
			all_proxy: "user:pass@proxy:1080",
			NO_PROXY: "localhost,127.0.0.1",
		});
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
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
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
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
		]);
	});

	test("the memory overlay rides after NO_DISCOVERY_CONFIG and before images", () => {
		expect(
			buildOmpArgs({
				sessionDir: "S",
				extensionPath: "E",
				resumeId: null,
				images: ["shot.png"],
				memoryConfig: "/data/omp-memory.yml",
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
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
			"--config",
			"/data/omp-memory.yml",
			"@shot.png",
		]);
	});

	test("the plugin-skills overlay rides after NO_DISCOVERY_CONFIG and before the memory overlay", () => {
		expect(
			buildOmpArgs({
				sessionDir: "S",
				extensionPath: "E",
				resumeId: null,
				pluginSkillsConfig: "/data/omp-plugin-skills.yml",
				memoryConfig: "/data/omp-memory.yml",
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
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
			"--config",
			"/data/omp-plugin-skills.yml",
			"--config",
			"/data/omp-memory.yml",
		]);
		// A home with no plugin skills (null) keeps today's argv: no extra --config pair.
		expect(
			buildOmpArgs({ sessionDir: "S", extensionPath: "E", resumeId: null }),
		).not.toContain("/data/omp-plugin-skills.yml");
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
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
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
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
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
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
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
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
		]);
	});

	test("the no-discovery overlay ships next to the extension", () => {
		// A missing file makes every run die at omp startup, so pin its presence.
		expect(existsSync(NO_DISCOVERY_CONFIG)).toBe(true);
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
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
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
			}).slice(-7),
		).toEqual([
			"--resume",
			"R",
			"--no-extensions",
			"--no-lsp",
			"--config",
			NO_DISCOVERY_CONFIG,
			"@C:\\p\\3.gif",
		]);
	});
});

describe("worktree hardening against planted config (real omp)", () => {
	const ompPath = Bun.which("omp");
	// The gate machines that run the board always have omp; a bare dev box may not.
	const testIfOmp = test.skipIf(!ompPath);

	testIfOmp(
		"planted .omp extensions and project MCP servers do not execute under the built args",
		// Two real omp boots sit near bun's 5 s default under the Stryker dry run's
		// sandbox overhead, so the test carries its own budget.
		60_000,
		() => {
			// Decisive but slow: two real omp boots over a planted worktree. The second
			// drops the hardening args, so the test notices if the flags ever stop doing
			// anything. The bogus model makes both boots die at startup, right after
			// discovery, so no provider is ever called.
			const dir = mkdtempSync(join(tmpdir(), "ottr-plant-"));
			const home = mkdtempSync(join(tmpdir(), "ottr-plant-home-"));
			try {
				mkdirSync(join(dir, ".omp", "extensions"), { recursive: true });
				const extMarker = join(dir, "ext-marker.txt");
				const mcpMarker = join(dir, "mcp-marker.txt");
				writeFileSync(
					join(dir, ".omp", "extensions", "planted.ts"),
					`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(extMarker)}, "loaded");
export default {};`,
				);
				writeFileSync(
					join(dir, ".omp", "mcp.json"),
					JSON.stringify({
						mcpServers: {
							evil: {
								type: "stdio",
								command: process.execPath,
								args: [
									"-e",
									`require("fs").writeFileSync(${JSON.stringify(mcpMarker)}, "x")`,
								],
							},
						},
					}),
				);
				const args = [
					...buildOmpArgs({
						sessionDir: join(dir, "sessions"),
						extensionPath: null,
						resumeId: null,
					}),
					"--model",
					"ottr-no-such-provider/no-such-model",
				];
				const env = { ...process.env, HOME: home, USERPROFILE: home };
				const spawn = (argv: string[]) =>
					Bun.spawnSync([ompPath!, ...argv], {
						cwd: dir,
						env,
						stdin: new Response("hi\n"),
						timeout: 120_000,
					});

				const hardened = spawn(args);
				expect(existsSync(extMarker)).toBe(false);
				expect(existsSync(mcpMarker)).toBe(false);
				// A null exitCode means the timeout killed the boot, not the model check.
				expect(hardened.exitCode).not.toBe(null);
				expect(hardened.exitCode).not.toBe(0);

				const control = spawn(
					args.filter(
						(a) =>
							a !== "--no-extensions" &&
							a !== "--no-lsp" &&
							a !== "--config" &&
							a !== NO_DISCOVERY_CONFIG,
					),
				);
				expect(existsSync(extMarker)).toBe(true);
				expect(existsSync(mcpMarker)).toBe(true);
				expect(control.exitCode).not.toBe(null);
			} finally {
				rmSync(dir, { recursive: true, force: true });
				rmSync(home, { recursive: true, force: true });
			}
		},
	);
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

describe("hitUsageLimit", () => {
	test("matches the providers' quota wordings on stderr or the structured error", () => {
		expect(
			hitUsageLimit(result({ stderrTail: "error: usage_limit_reached\n" })),
		).toBe(true);
		expect(
			hitUsageLimit(
				result({ providerError: "The usage limit has been reached" }),
			),
		).toBe(true);
		expect(
			hitUsageLimit(result({ providerError: "429 quota exhausted" })),
		).toBe(true);
		expect(
			hitUsageLimit(result({ stderrTail: "gateway status 502: no quota\n" })),
		).toBe(true);
		expect(
			hitUsageLimit(
				result({
					providerError: "insufficient_quota: You exceeded your current quota",
				}),
			),
		).toBe(true);
		expect(
			hitUsageLimit(
				result({ providerError: "quota exceeded for this project" }),
			),
		).toBe(true);
		expect(
			hitUsageLimit(
				result({
					providerError:
						'429 {"type":"error","error":{"type":"rate_limit_error","code":"1310","message":"[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-10 19:51:43]"}}',
				}),
			),
		).toBe(true);
	});

	test("leaves rate limits and ordinary deaths to the generic rules", () => {
		expect(
			hitUsageLimit(
				result({
					providerError:
						'429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}',
				}),
			),
		).toBe(false);
		expect(hitUsageLimit(result({ stderrTail: "boom\n" }))).toBe(false);
		expect(
			hitUsageLimit(
				result({ stderrTail: "error: rate limit (429), retry in 2s\n" }),
			),
		).toBe(false);
		expect(hitUsageLimit(result({}))).toBe(false);
	});

	describe("usageLimitResetMs", () => {
		const err = (providerError: string) =>
			result({ exitCode: 1, providerError });

		test("reads a zoned reset time and rejects a zoneless one", () => {
			const at = Date.parse("2027-03-01T19:45:04Z");
			expect(
				usageLimitResetMs(
					err(
						"429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2027-03-01 19:45:04 UTC (type=1310)",
					),
				),
			).toBe(at);
			expect(
				usageLimitResetMs(
					err("limit exhausted. Your limit will reset at 2027-03-01T19:45:04Z"),
				),
			).toBe(at);
			expect(
				usageLimitResetMs(
					err("limit exhausted. will reset at 2027-03-01 20:45:04+01:00"),
				),
			).toBe(Date.parse("2027-03-01T20:45:04+01:00"));
			// Z.AI writes Beijing time without a zone: the board never guesses one.
			expect(
				usageLimitResetMs(
					err(
						"429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2027-03-01 19:45:04 (type=1310)",
					),
				),
			).toBeNull();
			expect(usageLimitResetMs(err("429 quota exhausted"))).toBeNull();
			expect(
				usageLimitResetMs(result({ exitCode: 1, stderrTail: "boom\n" })),
			).toBeNull();
		});
	});

	describe("rateLimitWaitMs", () => {
		test("reads a 429's retry-after-ms in ms and a Retry-After value in seconds", () => {
			expect(
				rateLimitWaitMs(
					result({
						exitCode: 1,
						stderrTail:
							'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=9169000\n',
					}),
				),
			).toBe(9_169_000);
			expect(
				rateLimitWaitMs(
					result({
						providerError: '429 rate_limit_error "retry-after-ms":2000',
					}),
				),
			).toBe(2000);
			expect(
				rateLimitWaitMs(result({ stderrTail: "http 429 retry-after: 120\n" })),
			).toBe(120_000);
		});

		test("returns null off the rate-limit signature or without a wait", () => {
			expect(
				rateLimitWaitMs(
					result({
						stderrTail:
							'429 {"error":{"type":"rate_limit_error","message":"too many requests"}}\n',
					}),
				),
			).toBeNull();
			expect(
				rateLimitWaitMs(
					result({ stderrTail: "error: rate limit (429), retry in 2s\n" }),
				),
			).toBeNull();
			expect(rateLimitWaitMs(result({ stderrTail: "boom\n" }))).toBeNull();
			expect(
				rateLimitWaitMs(result({ providerError: "retry-after-ms=5000" })),
			).toBeNull();
		});
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

	test("1b. provision drift wins over killed and over a received receipt", () => {
		const drift = [".omp/agent/skills/ui-ux-check/SKILL.md changed"];
		expect(
			run("work", result({ killed: true, provisionDrift: drift })),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: `A turn changed the alate-provisioned agent layer: ${drift[0]}. The next provision refuses or overwrites these files — do not edit the installed copies; change it in agent-data, then reply.`,
		});
		// A received ready report cannot outweigh drift: the next provision refuses the files.
		expect(
			run(
				"work",
				result({
					exitCode: 0,
					outcome: outcome(),
					provisionDrift: [
						".agents/x.md changed",
						".ottr/workers/y.json missing",
					],
				}),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: `A turn changed the alate-provisioned agent layer: .agents/x.md changed, .ottr/workers/y.json missing. The next provision refuses or overwrites these files — do not edit the installed copies; change it in agent-data, then reply.`,
		});
		// The reason names at most four files, then counts the rest.
		expect(
			run("work", result({ provisionDrift: ["a", "b", "c", "d", "e"] }))
				.needsReason,
		).toContain("c, d (+1 more)");
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

	test("2i. a usage-limit death keeps queueing with the continue prompt", () => {
		// The z.ai gateway shape: the provider's structured error, no stderr line.
		const gateway = run(
			"work",
			result({ exitCode: 1, providerError: "429 quota exhausted" }),
		);
		expect(gateway).toEqual({
			stage: "in_progress",
			state: "queued",
			needsReason: `${QUOTA_LIMIT} - continuing automatically. Cancel to stop it instead.`,
			pendingPrompt: ".",
		});
		// omp's own wording on stderr, on a merge turn.
		expect(
			run(
				"merge",
				result({
					exitCode: 1,
					stderrTail:
						"error: The usage limit has been reached (code=usage_limit_reached)\n",
				}),
			),
		).toEqual({
			stage: "merging",
			state: "queued",
			needsReason: `${QUOTA_LIMIT} - continuing automatically. Cancel to stop it instead.`,
			pendingPrompt: ".",
		});
		// The continue fired already and the provider still refuses: it queues again, and
		// the settle's hold (reset, named reset, or probe wait) gates the retry (OTTR-880).
		expect(
			run(
				"work",
				result({ exitCode: 1, providerError: "429 quota exhausted" }),
				git(),
				"origin/main",
				gateway.needsReason ?? null,
			),
		).toEqual({
			stage: "in_progress",
			state: "queued",
			needsReason: `${QUOTA_LIMIT} - continuing automatically. Cancel to stop it instead.`,
			pendingPrompt: ".",
		});
		// A rate limit is not a quota: it clears in seconds, so the generic death park stays.
		expect(
			run(
				"work",
				result({
					exitCode: 1,
					stderrTail: "error: rate limit exceeded (429), retrying in 2s\n",
				}),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"omp exited with code 1 before finishing: rate limit exceeded (429), retrying in 2s.",
		});
	});

	test("2j. a worker OOM kill continues once, then parks", () => {
		// A signal death with the cgroup oom_kill counter grown: the limit lands in the reason.
		const oom = run(
			"work",
			result({ exitCode: null, oomKilled: true, memoryLimitBytes: 8589934592 }),
		);
		expect(oom).toEqual({
			stage: "in_progress",
			state: "queued",
			needsReason: `${OOM_KILL}, limit 8 GiB) - continuing automatically. Cancel to stop it instead.`,
			pendingPrompt: ".",
		});
		// The continue fired once already and the same wall killed the retry: a human decides.
		expect(
			run(
				"work",
				result({
					exitCode: null,
					oomKilled: true,
					memoryLimitBytes: 8589934592,
				}),
				git(),
				"origin/main",
				oom.needsReason ?? null,
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: `${OOM_KILL}, limit 8 GiB) again after the automatic continue. Free memory or raise the worker limit, then reply.`,
		});
		// A container with no memory.max (or unreadable cgroup files) drops the limit clause.
		expect(
			run("work", result({ exitCode: null, oomKilled: true })).needsReason,
		).toBe(
			`${OOM_KILL}) - continuing automatically. Cancel to stop it instead.`,
		);
		// A signal death with no oom_kill growth keeps today's generic park.
		expect(run("work", result({ exitCode: null }))).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "omp exited with code unknown before finishing.",
		});
	});

	test("2c. exit 0 without a terminal end (background wait) continues once, then asks", () => {
		const resumed: Next = {
			stage: "in_progress",
			state: "queued",
			needsReason:
				"The agent ended its turn while waiting on a background job - the run exited and the background job died with it; resuming automatically. Cancel to stop it instead.",
			pendingPrompt:
				"Your previous turn ended while a background job ran; the run exits and kills the job. Continue the task and run slow gates in the foreground.",
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

	test("7. a work turn that reports integrated is rejected", () => {
		// Merging is the merge turn's job (rebase, gates, server push): a work turn's
		// integrated report is rejected regardless of what git shows (AGEN-33). A head
		// already on the target names the out-of-turn merge instead of the generic text.
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "integrated" }) }),
				git({ integrated: false }),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason: "Work turns do not merge; report ready.",
		});
		expect(
			run(
				"work",
				result({ outcome: outcome({ status: "integrated" }) }),
				git({ integrated: true }),
			),
		).toEqual({
			stage: "in_progress",
			state: "needs_you",
			needsReason:
				"Out-of-turn merge: the branch head is already on origin/main. A work turn never merges; report ready.",
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
	const proposeStart = (id: string, args: unknown) => ({
		type: "tool_execution_start",
		toolName: "propose_task",
		toolCallId: id,
		args,
	});
	const RETRO_RECORDED =
		"Recorded. Ottr files it as a held card when this retro ends.";
	const proposeEnd = (id: string, isError = false, text = RETRO_RECORDED) => ({
		type: "tool_execution_end",
		toolName: "propose_task",
		toolCallId: id,
		isError,
		result: { content: [{ type: "text", text }] },
	});

	test("a propose_task call is captured with its model when it ends; the first succeeded call wins", () => {
		const s = newEventState();
		// A start alone records nothing: the end event decides the call.
		feed(
			s,
			proposeStart("p1", { prompt: "Add tests for X", model: "zai/glm" }),
		);
		expect(s.proposed).toBeNull();
		feed(s, proposeEnd("p1"));
		expect(s.proposed).toEqual({
			prompt: "Add tests for X",
			model: "zai/glm",
			summary: null,
			project: null,
		});
		feed(s, proposeStart("p2", { prompt: "Second proposal" }));
		feed(s, proposeEnd("p2"));
		expect(s.proposed?.prompt).toBe("Add tests for X");
	});

	test("a refused propose_task call never records; the retry after an unknown project does", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", { prompt: "Fix it", project: "no-such-project" }),
			proposeEnd(
				"p1",
				false,
				'Error: unknown project "no-such-project". Known projects: alate, agent-data. Propose again with one of these projects, or without one.',
			),
		);
		expect(s.proposed).toBeNull();
		expect(s.recorded).toHaveLength(0);
		// The extension's retry with a listed project is the call that counts.
		feed(
			s,
			proposeStart("p2", { prompt: "Fix it", project: " agent-data " }),
			proposeEnd("p2"),
		);
		expect(s.proposed).toEqual({
			prompt: "Fix it",
			model: null,
			summary: null,
			project: "agent-data",
		});
		// An errored end refuses the call even without the Error: text.
		const t = newEventState();
		feed(t, proposeStart("p1", { prompt: "Fix it" }), proposeEnd("p1", true));
		expect(t.proposed).toBeNull();
		expect(t.recorded).toHaveLength(0);
	});

	// OTTR-863: omp emits only the outer `eval` tool events for an eval-kernel call;
	// a nested `tool.propose_task`/`tool.report_outcome` ride no tool_execution events.
	// The guard that refuses those calls lives in the extension (tracker.ts), whose
	// tests separate before and after. This test pins the recorded ground truth the
	// path decision rests on: feed the real recorded run (src/fixtures/eval-bridge-stream.jsonl,
	// captured live from omp 18.15.0 with the guarded extension) and check the parser
	// reads the direct retry's outcome but nothing from the eval window. It also pins
	// the boundary the parser must never cross: the eval cell output is agent text,
	// and a quoted marker line would forge findings, so no eval-output text parse.
	test("the recorded eval-bridge run: the direct retry records, the eval window records nothing", async () => {
		const fixture = await Bun.file(
			join(import.meta.dir, "fixtures", "eval-bridge-stream.jsonl"),
		).text();
		const lines = fixture
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l !== "");
		// The recording's tool events: one eval pair and one DIRECT report_outcome pair.
		// A nested propose_task/report_outcome event would mean omp changed the bridge;
		// the refusal guard and this fixture must then be revisited together.
		const toolNames = lines
			.map((l) => {
				const e = JSON.parse(l) as { type?: string; toolName?: string };
				return e.type?.startsWith("tool_execution") ? e.toolName : null;
			})
			.filter((n) => n !== null);
		expect([...new Set(toolNames)].sort()).toEqual(["eval", "report_outcome"]);
		const s = newEventState();
		for (const l of lines) feed(s, JSON.parse(l));
		// Nothing from the eval window: the two nested propose_task calls and the
		// nested report_outcome ride no events, refused or not.
		expect(s.recorded).toHaveLength(0);
		expect(s.proposed).toBeNull();
		// The agent's DIRECT retry after the refusals is the call the board reads.
		expect(s.outcome?.status).toBe("answered");
		expect(s.outcome?.summary).toContain(
			"Ran the requested eval routing probe",
		);
		// What the agent saw in the recording: the real bridge wraps each nested
		// result as a {text, details} object, and the refusal texts ride in the
		// eval result. Descriptive of the recording, not a guard check.
		const evalEnd = lines
			.map(
				(l) =>
					JSON.parse(l) as {
						type?: string;
						toolName?: string;
						result?: unknown;
					},
			)
			.find(
				(e) => e.type === "tool_execution_end" && e.toolName === "eval",
			) as {
			result: { content: { type: string; text: string }[] };
		};
		const resultText = evalEnd.result.content
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("");
		expect(resultText).toContain(
			"Call propose_task directly, not through eval",
		);
		expect(resultText).toContain(
			"Call report_outcome directly, not through eval",
		);
	});

	test("a blank-project refusal drops the call; the retry without a project files on the own project", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", { prompt: "Fix it", project: "   " }),
			proposeEnd(
				"p1",
				false,
				"Error: project must be a non-empty string when given.",
			),
		);
		expect(s.proposed).toBeNull();
		feed(s, proposeStart("p2", { prompt: "Fix it" }), proposeEnd("p2"));
		expect(s.proposed).toEqual({
			prompt: "Fix it",
			model: null,
			summary: null,
			project: null,
		});
	});

	test("propose_task without a non-empty prompt or before any call leaves proposed null; a bad call does not block a later good one", () => {
		const s = newEventState();
		feed(s, proposeStart("p1", { prompt: "" }), proposeEnd("p1"));
		expect(s.proposed).toBeNull();
		feed(s, proposeStart("p2", { prompt: "Good" }), proposeEnd("p2"));
		expect(s.proposed).toEqual({
			prompt: "Good",
			model: null,
			summary: null,
			project: null,
		});
	});

	test("a propose_task project names the filing project; blank or non-string stays null", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", { prompt: "P", project: "  agent-data  " }),
			proposeEnd("p1"),
		);
		expect(s.proposed).toEqual({
			prompt: "P",
			model: null,
			summary: null,
			project: "agent-data",
		});
		const t = newEventState();
		feed(t, proposeStart("p1", { prompt: "P", project: 42 }), proposeEnd("p1"));
		expect(t.proposed?.project).toBeNull();
	});

	test("a model-less or non-string model propose becomes null", () => {
		const s = newEventState();
		feed(s, proposeStart("p1", { prompt: "P", model: 42 }), proposeEnd("p1"));
		expect(s.proposed).toEqual({
			prompt: "P",
			model: null,
			summary: null,
			project: null,
		});
	});

	test("all five summary fields are captured, trimmed", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", {
				prompt: "P",
				whatChanges: "  edit src/prompts.ts  ",
				why: " OTTR-1 duplicated text ",
				gain: " 200 characters per card ",
				risk: " none found ",
				check: " bun test ",
			}),
			proposeEnd("p1"),
		);
		expect(s.proposed?.summary).toEqual({
			whatChanges: "edit src/prompts.ts",
			why: "OTTR-1 duplicated text",
			gain: "200 characters per card",
			risk: "none found",
			check: "bun test",
		});
	});

	test("an absent or non-string risk defaults to none found", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", {
				prompt: "P",
				whatChanges: "w",
				why: "y",
				gain: "g",
				check: "c",
				risk: 42,
			}),
			proposeEnd("p1"),
		);
		expect(s.proposed?.summary).toEqual({
			whatChanges: "w",
			why: "y",
			gain: "g",
			risk: "none found",
			check: "c",
		});
	});

	test("a missing or empty required summary field yields summary null", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", {
				prompt: "P",
				whatChanges: "w",
				why: "y",
				gain: "g",
			}),
			proposeEnd("p1"),
		);
		expect(s.proposed?.summary).toBeNull();
		feed(
			s,
			proposeStart("p2", {
				prompt: "Q",
				whatChanges: "w",
				why: "  ",
				gain: "g",
				check: "c",
			}),
			proposeEnd("p2"),
		);
		// The first succeeded call stays the proposal; its summary stays null.
		expect(s.proposed?.summary).toBeNull();
	});

	test("a summary field over 400 characters is capped at 399 plus an ellipsis", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", {
				prompt: "P",
				whatChanges: "w",
				why: "y",
				gain: "g".repeat(500),
				check: "c",
			}),
			proposeEnd("p1"),
		);
		expect(s.proposed?.summary?.gain).toBe(`${"g".repeat(399)}…`);
		expect(s.proposed?.summary?.gain).toHaveLength(400);
	});

	test("a non-string required summary field counts as absent", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", {
				prompt: "P",
				whatChanges: "w",
				why: { note: "y" },
				gain: "g",
				check: "c",
			}),
			proposeEnd("p1"),
		);
		expect(s.proposed?.summary).toBeNull();
	});

	test("review-mode recorded findings carry no summary", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", {
				prompt: "F",
				rank: 1,
				whatChanges: "w",
				why: "y",
				gain: "g",
				risk: "r",
				check: "c",
			}),
			proposeEnd("p1"),
		);
		expect(s.recorded).toEqual([
			{ prompt: "F", model: null, rank: 1, security: null },
		]);
	});

	test("a review's propose_task calls all land in recorded, with rank and security", () => {
		const s = newEventState();
		const REVIEW_RECORDED =
			"Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.";
		feed(
			s,
			proposeStart("p1", { prompt: "First", rank: 1, security: "critical" }),
			proposeEnd("p1", false, REVIEW_RECORDED),
			proposeStart("p2", { prompt: "Second", rank: 2 }),
			proposeEnd("p2", false, REVIEW_RECORDED),
		);
		expect(s.recorded).toEqual([
			{ prompt: "First", model: null, rank: 1, security: "critical" },
			{ prompt: "Second", model: null, rank: 2, security: null },
		]);
		// Retro semantics keep the first valid call as the proposal.
		expect(s.proposed).toEqual({
			prompt: "First",
			model: null,
			summary: null,
			project: null,
		});
	});

	test("a bad rank, a fractional rank, and an unknown security fall back to null", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", { prompt: "P", rank: 0, security: "low" }),
			proposeEnd("p1"),
			proposeStart("p2", { prompt: "Q", rank: 1.5 }),
			proposeEnd("p2"),
		);
		expect(s.recorded).toEqual([
			{ prompt: "P", model: null, rank: null, security: null },
			{ prompt: "Q", model: null, rank: null, security: null },
		]);
	});

	test("a bad prompt call records nothing, a later good one still lands", () => {
		const s = newEventState();
		feed(
			s,
			proposeStart("p1", { prompt: "" }),
			proposeEnd(
				"p1",
				false,
				"Error: prompt must be a string of 1-20000 characters (trimmed).",
			),
			proposeStart("p2", { prompt: "Good", rank: 3 }),
			proposeEnd("p2"),
		);
		expect(s.recorded).toEqual([
			{ prompt: "Good", model: null, rank: 3, security: null },
		]);
	});

	test("createRunSink() fires onRecorded per propose_task finding, in order, before the run resolves", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-sink-"));
		try {
			const recorded: RecordedFinding[] = [];
			const sink = createRunSink({
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				onRecorded: (finding) => {
					recorded.push(finding);
				},
			});
			sink.line(
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "propose_task",
					toolCallId: "p1",
					args: { prompt: "First", model: "", rank: 1, security: "critical" },
				}),
			);
			sink.line(
				JSON.stringify({
					type: "tool_execution_end",
					toolName: "propose_task",
					toolCallId: "p1",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: "Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.",
							},
						],
					},
				}),
			);
			// An unrelated event line between findings must not change the order.
			sink.line(
				JSON.stringify({
					type: "agent_end",
					isTerminal: false,
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "note" }] },
					],
				}),
			);
			sink.line(
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "propose_task",
					toolCallId: "p2",
					args: { prompt: "Second", model: "m2", rank: 0, security: "low" },
				}),
			);
			sink.line(
				JSON.stringify({
					type: "tool_execution_end",
					toolName: "propose_task",
					toolCallId: "p2",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: "Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.",
							},
						],
					},
				}),
			);
			// An empty prompt and a missing prompt fire nothing.
			sink.line(
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "propose_task",
					toolCallId: "p3",
					args: { prompt: "" },
				}),
			);
			sink.line(
				JSON.stringify({
					type: "tool_execution_end",
					toolName: "propose_task",
					toolCallId: "p3",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: "Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.",
							},
						],
					},
				}),
			);
			sink.line(
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "propose_task",
					toolCallId: "p4",
					args: { rank: 2 },
				}),
			);
			sink.line(
				JSON.stringify({
					type: "tool_execution_end",
					toolName: "propose_task",
					toolCallId: "p4",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: "Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.",
							},
						],
					},
				}),
			);
			sink.line(
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "propose_task",
					toolCallId: "p5",
					args: { prompt: "Third", rank: 1.5 },
				}),
			);
			sink.line(
				JSON.stringify({
					type: "tool_execution_end",
					toolName: "propose_task",
					toolCallId: "p5",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: "Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.",
							},
						],
					},
				}),
			);
			sink.line(
				JSON.stringify({
					type: "agent_end",
					isTerminal: true,
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "done" }] },
					],
				}),
			);
			const r = sink.result({
				exitCode: 0,
				killed: false,
				stderrTail: sink.tail(),
				dispatch: "local, argv 6, cwd d, pid 1, 2s",
			});
			expect(r.exitCode).toBe(0);
			expect(recorded).toEqual([
				{ prompt: "First", model: null, rank: 1, security: "critical" },
				{ prompt: "Second", model: "m2", rank: null, security: null },
				{ prompt: "Third", model: null, rank: null, security: null },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
	onSession?: (sessionId: string) => void | Promise<void>;
	onRecorded?: (finding: RecordedFinding) => void | Promise<void>;
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
		onRecorded: o.onRecorded,
		launcher,
	});
	return { handle, fake };
}

describe("startRun", () => {
	test("session and findings persist in arrival order before local completion", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-startrun-"));
		const sessionGate = Promise.withResolvers<void>();
		const findingGate = Promise.withResolvers<void>();
		const findingStarted = Promise.withResolvers<void>();
		try {
			const persisted: string[] = [];
			const started: string[] = [];
			const { handle, fake } = fakeStart({
				logPath: join(dir, "run.log"),
				onSession: async (id) => {
					started.push(id);
					await sessionGate.promise;
					persisted.push(id);
				},
				onRecorded: async (finding) => {
					started.push(finding.prompt);
					if (finding.prompt === "First") {
						findingStarted.resolve();
						await findingGate.promise;
					}
					persisted.push(finding.prompt);
				},
			});
			let completed = false;
			const done = handle.done.then((result) => {
				completed = true;
				return result;
			});
			const events = [{ type: "session", id: "session-ordered" }];
			const stream = [
				...events,
				...["First", "Second"].flatMap((prompt, i) => [
					{
						type: "tool_execution_start",
						toolName: "propose_task",
						toolCallId: `p${i}`,
						args: { prompt },
					},
					{
						type: "tool_execution_end",
						toolName: "propose_task",
						toolCallId: `p${i}`,
						isError: false,
						result: { content: [{ type: "text", text: "Recorded." }] },
					},
				]),
				{ type: "agent_end", isTerminal: true },
			]
				.map((event) => JSON.stringify(event))
				.join("\n");
			fake.stdout.emit("data", Buffer.from(stream.slice(0, 17)));
			fake.stdout.emit("data", Buffer.from(stream.slice(17, 83)));
			fake.stdout.emit("data", Buffer.from(stream.slice(83)));
			fake.emit("close", 0);
			expect(started).toEqual(["session-ordered"]);
			expect(persisted).toEqual([]);
			expect(completed).toBe(false);
			sessionGate.resolve();
			await findingStarted.promise;
			expect(started).toEqual(["session-ordered", "First"]);
			expect(persisted).toEqual(["session-ordered"]);
			expect(completed).toBe(false);
			findingGate.resolve();
			const result = await done;
			expect(persisted).toEqual(["session-ordered", "First", "Second"]);
			expect(result.sessionId).toBe("session-ordered");
			expect(result.sawTerminalEnd).toBe(true);
		} finally {
			sessionGate.resolve();
			findingGate.resolve();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("local completion rejects persistence errors instead of treating them as bad JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-startrun-"));
		const gate = Promise.withResolvers<void>();
		try {
			const failure = new Error("session persistence failed");
			const persisted: string[] = [];
			const { handle, fake } = fakeStart({
				logPath: join(dir, "run.log"),
				onSession: async (id) => {
					if (id === "first") await gate.promise;
					persisted.push(id);
				},
				onRecorded: (finding) => {
					persisted.push(finding.prompt);
				},
			});
			const outcome = handle.done.then(
				() => null,
				(error: unknown) => error,
			);
			fake.stdout.emit(
				"data",
				Buffer.from(
					[
						{ type: "session", id: "first" },
						{
							type: "tool_execution_start",
							toolName: "propose_task",
							toolCallId: "after-failure",
							args: { prompt: "after failure" },
						},
						{
							type: "tool_execution_end",
							toolName: "propose_task",
							toolCallId: "after-failure",
							isError: false,
						},
					]
						.map((event) => JSON.stringify(event))
						.join("\n"),
				),
			);
			fake.emit("close", 0);
			gate.reject(failure);
			expect(await outcome).toBe(failure);
			expect(persisted).toEqual(["after failure"]);
			expect(readFileSync(join(dir, "run.log"), "utf8")).toContain(
				"[omp session first]",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

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

	test("a local run always passes --no-extensions, --no-lsp and the no-discovery overlay", async () => {
		// The worktree cwd is worker-writable, so even a run with no explicit extension
		// (a review check) must carry the hardening: the audit's vector rides in the cwd.
		const dir = mkdtempSync(join(tmpdir(), "ottr-hardening-"));
		try {
			const seen: (readonly string[])[] = [];
			const launcher: RunLauncher = (_c, args) => {
				seen.push(args);
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const handle = startRun({
				cwd: dir,
				prompt: "do the thing",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher,
			});
			const r = await handle.done;
			expect(seen[0]).toContain("--no-extensions");
			expect(seen[0]).toContain("--no-lsp");
			expect(seen[0]).toContain(NO_DISCOVERY_CONFIG);
			expect(r.ranOn).toBe(`board (${hostname()})`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a local run carries the plugin-skills overlay of its home; a plugin-free home carries the pins-only overlay", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugin-skills-"));
		const dataDir = join(dir, "data");
		mkdirSync(dataDir, { recursive: true });
		// The fixture home stands in for the shared home: one enabled plugin whose
		// pi.skills names ./skills (docs/specs/turn-home-plugin-skills.md).
		const home = join(dir, "home");
		const pkgDir = join(
			home,
			".omp",
			"plugins",
			"node_modules",
			"@acme",
			"cool",
		);
		mkdirSync(join(pkgDir, "skills", "wizard"), { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ pi: { skills: ["./skills"] } }),
		);
		writeFileSync(
			join(home, ".omp", "plugins", "omp-plugins.lock.json"),
			JSON.stringify({
				plugins: {
					"@acme/cool": { version: "1", enabledFeatures: null, enabled: true },
				},
			}),
		);
		const ambientDataDir = process.env.OTTR_DATA_DIR;
		process.env.OTTR_DATA_DIR = dataDir;
		try {
			const seen: (readonly string[])[] = [];
			const launcher: RunLauncher = (_c, args) => {
				seen.push(args);
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const base = {
				cwd: dir,
				prompt: "do the thing",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher,
			};
			const handle = startRun({ ...base, pluginSkillsHome: home });
			await handle.done;
			// The overlay rides as the --config pair after NO_DISCOVERY_CONFIG.
			const overlay = seen[0]![seen[0]!.indexOf(NO_DISCOVERY_CONFIG) + 2]!;
			expect(seen[0]![seen[0]!.indexOf(NO_DISCOVERY_CONFIG) + 1]).toBe(
				"--config",
			);
			expect(overlay).toBe(
				pluginSkillsOverlayPath({ OTTR_DATA_DIR: dataDir }, home),
			);
			expect(readFileSync(overlay, "utf8")).toBe(
				`skills:\n  enableAgentsProject: false\n  enableClaudeProject: false\n  enablePiProject: false\n  customDirectories:\n    - ${JSON.stringify(join(pkgDir, "skills"))}\n`,
			);
			// The worktree cwd enters no path: no planted .omp dir is loaded.
			expect(seen[0]!.join(" ")).not.toContain(join(dir, ".omp"));

			// A home without plugins still carries the overlay: the project-skill
			// pins ride on every run, only customDirectories stays empty.
			const empty = join(dir, "empty-home");
			mkdirSync(empty, { recursive: true });
			seen.length = 0;
			await startRun({ ...base, pluginSkillsHome: empty }).done;
			const pinsOverlay = seen[0]![seen[0]!.indexOf(NO_DISCOVERY_CONFIG) + 2]!;
			expect(pinsOverlay).toBe(
				pluginSkillsOverlayPath({ OTTR_DATA_DIR: dataDir }, empty),
			);
			expect(readFileSync(pinsOverlay, "utf8")).toBe(
				"skills:\n  enableAgentsProject: false\n  enableClaudeProject: false\n  enablePiProject: false\n",
			);
			expect(seen[0]!.filter((a) => a === "--config")).toEqual([
				"--config",
				"--config",
				"--config",
			]);
			expect(seen[0]!.filter((a) => a.endsWith(".yml"))).toEqual([
				NO_DISCOVERY_CONFIG,
				pluginSkillsOverlayPath({ OTTR_DATA_DIR: dataDir }, empty),
				join(dataDir, "omp-memory.yml"),
			]);
		} finally {
			if (ambientDataDir === undefined) delete process.env.OTTR_DATA_DIR;
			else process.env.OTTR_DATA_DIR = ambientDataDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a local run settles with the provision drift its audit reports", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-provision-drift-"));
		try {
			const launcher: RunLauncher = () => {
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const handle = startRun({
				cwd: dir,
				prompt: "do the thing",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher,
				auditProvisioned: () => [
					".omp/agent/skills/ui-ux-check/SKILL.md changed",
				],
			});
			const r = await handle.done;
			expect(r.exitCode).toBe(0);
			expect(r.provisionDrift).toEqual([
				".omp/agent/skills/ui-ux-check/SKILL.md changed",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a local run without the audit option settles without provisionDrift", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-provision-clean-"));
		try {
			const launcher: RunLauncher = () => {
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const handle = startRun({
				cwd: dir,
				prompt: "do the thing",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher,
			});
			const r = await handle.done;
			expect(r.provisionDrift).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an explicit memoryConfigPath shows the overlay arg in the spawned argv", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-memory-arg-"));
		try {
			const seen: (readonly string[])[] = [];
			const launcher: RunLauncher = (_c, args) => {
				seen.push(args);
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const overlay = join(dir, "omp-memory.yml");
			const handle = startRun({
				cwd: dir,
				prompt: "do the thing",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher,
				memoryConfigPath: overlay,
			});
			await handle.done;
			// The plugin-skills overlay rides between the hardening and memory overlays
			// (docs/specs/turn-home-plugin-skills.md); locate the memory pair by path.
			const i = seen[0]!.indexOf(overlay) - 1;
			expect(seen[0]!.slice(i, i + 2)).toEqual(["--config", overlay]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("without memoryConfigPath the overlay comes from the deployment env", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-memory-default-"));
		const savedUrl = process.env.HINDSIGHT_API_URL;
		const savedData = process.env.OTTR_DATA_DIR;
		process.env.HINDSIGHT_API_URL = "http://h:8888";
		process.env.OTTR_DATA_DIR = dir;
		try {
			const seen: (readonly string[])[] = [];
			const launcher: RunLauncher = (_c, args) => {
				seen.push(args);
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const handle = startRun({
				cwd: dir,
				prompt: "do the thing",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher,
			});
			await handle.done;
			const overlay = join(dir, "omp-memory.yml");
			// The plugin-skills overlay rides between the hardening and memory overlays
			// (docs/specs/turn-home-plugin-skills.md); locate the memory pair by path.
			const i = seen[0]!.indexOf(overlay) - 1;
			expect(seen[0]!.slice(i, i + 2)).toEqual(["--config", overlay]);
			expect(readFileSync(overlay, "utf8")).toBe(
				"memory:\n  backend: hindsight\n",
			);
		} finally {
			if (savedUrl === undefined) delete process.env.HINDSIGHT_API_URL;
			else process.env.HINDSIGHT_API_URL = savedUrl;
			if (savedData === undefined) delete process.env.OTTR_DATA_DIR;
			else process.env.OTTR_DATA_DIR = savedData;
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
				onSession: (sid) => {
					sessions.push(sid);
				},
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
						"500 upstream connect error.",
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
			expect(next.needsReason).toContain("500 upstream connect error");
			expect(next.needsReason).not.toContain("test-only-value");
			expect(next.needsReason).not.toContain("private-fragment");
			expect(next.needsReason).not.toContain(stored);
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("500 upstream connect error");
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
			expect(r.ranOn).toMatch(/^worker 127\.0\.0\.1 \(.+\)$/);
			expect(launched).toBe(0);
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("worker: dispatching to");
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000); // The dispatch runs the real daemon and a real child; the 5 s default is tighter than that under load.

	test("a worker dispatch carries the memory overlay in the run request argv", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-mem-"));
		const server = serveWorker({ port: 0, ompPath: workerOmp });
		try {
			const logPath = join(dir, "run.log");
			const overlay = join(dir, "omp-memory.yml");
			const { done } = startRun({
				...baseOpts(dir, logPath),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
				launcher: (() => {
					throw new Error("a worker turn must never spawn locally");
				}) as RunLauncher,
				memoryConfigPath: overlay,
			});
			const r = await done;
			expect(r.exitCode).toBe(0);
			// The fake omp echoes its argv: the request the worker executed had the overlay pair.
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain(`"--config","${overlay}"`);
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("a connect failure with a worker pool never runs the turn locally", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		try {
			const logPath = join(dir, "run.log");
			// The server mounts board-only volumes (tokens, ssh keys): a worker turn must never spawn here.
			let spawned = 0;
			const launcher: RunLauncher = () => {
				spawned++;
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			// A server that was stopped: the port refuses connections immediately.
			const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
			const deadUrl = `http://127.0.0.1:${dead.port}`;
			dead.stop(true);
			const r = await startRun({
				...baseOpts(dir, logPath),
				worker: { urls: [deadUrl] },
				launcher,
			}).done;
			expect(spawned).toBe(0);
			expect(r.exitCode).toBeNull();
			expect(r.workerLost).toBe(true);
			expect(readFileSync(logPath, "utf8")).toContain("worker dispatch failed");
			// Settled as a lost worker: requeued once for a worker, then parked for a human.
			const first = classify({
				kind: "work",
				result: r,
				git: git(),
				target: null,
				previousError: null,
			});
			expect(first.state).toBe("queued");
			const again = classify({
				kind: "work",
				result: r,
				git: git(),
				target: null,
				previousError: first.needsReason ?? null,
			});
			expect(again.state).toBe("needs_you");
		} finally {
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
			expect(seen.map((s) => s.env?.HOME)).toEqual([board]);
			expect(reachable(seen[0]!.env)).toBe(0);
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

	test("a 500 spawn-failed body reaches the dispatch context and the stderr tail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("spawn failed: no such image", { status: 500 }),
		});
		try {
			const r = await startRun({
				...baseOpts(dir, join(dir, "run.log")),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
			}).done;
			expect(r.workerLost).toBe(true);
			expect(r.dispatch).toContain(`worker http://127.0.0.1:${server.port}`);
			expect(r.stderrTail).toContain(
				`worker http://127.0.0.1:${server.port} responded 500: spawn failed: no such image`,
			);
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a worker never receives the board's GitHub token or data dir (D6)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		let forwarded: object | null = null;
		// Records the run request, then refuses it: the turn settles as a lost worker.
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
			const handle = startRun({
				...baseOpts(dir, join(dir, "run.log")),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
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
			const handle = startRun({
				...baseOpts(dir, join(dir, "run.log")),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
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

	test("githubReadEnv rides the worker request after the ambient token names are gone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-read-"));
		let body: WorkerRequest | null = null;
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				body = (await req.json()) as WorkerRequest;
				return new Response("spawn failed: recorded", { status: 500 });
			},
		});
		const names = [
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"GH_ENTERPRISE_TOKEN",
			"GITHUB_ENTERPRISE_TOKEN",
		];
		const saved: Record<string, string | undefined> = {};
		for (const n of names) {
			saved[n] = process.env[n];
			process.env[n] = "ambient";
		}
		try {
			const handle = startRun({
				...baseOpts(dir, join(dir, "run.log")),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
				githubReadEnv: {
					GH_HOST: "acme.ghe.com",
					GH_ENTERPRISE_TOKEN: "tok-ent",
				},
			});
			await handle.done;
			expect(body).not.toBeNull();
			// The delivered read-only token rides its dedicated field...
			expect(body!.githubReadEnv).toEqual({
				GH_HOST: "acme.ghe.com",
				GH_ENTERPRISE_TOKEN: "tok-ent",
			});
			// ...and no ambient GitHub token name reaches the request env.
			expect(body!.env).not.toHaveProperty("GH_TOKEN");
			expect(body!.env).not.toHaveProperty("GITHUB_TOKEN");
			expect(body!.env).not.toHaveProperty("GH_ENTERPRISE_TOKEN");
			expect(body!.env).not.toHaveProperty("GITHUB_ENTERPRISE_TOKEN");
		} finally {
			for (const n of names) {
				if (saved[n] === undefined) delete process.env[n];
				else process.env[n] = saved[n];
			}
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a worker dispatch without githubReadEnv carries none of the four ambient names", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-ambient-"));
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
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"GH_ENTERPRISE_TOKEN",
			"GITHUB_ENTERPRISE_TOKEN",
		];
		const saved: Record<string, string | undefined> = {};
		for (const n of names) {
			saved[n] = process.env[n];
			process.env[n] = "ambient";
		}
		try {
			const handle = startRun({
				...baseOpts(dir, join(dir, "run.log")),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
			});
			await handle.done;
			expect(forwarded).not.toBeNull();
			for (const n of names) expect(forwarded).not.toHaveProperty(n);
			expect(JSON.stringify(forwarded)).not.toContain("ambient");
		} finally {
			for (const n of names) {
				if (saved[n] === undefined) delete process.env[n];
				else process.env[n] = saved[n];
			}
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a local dispatch ignores githubReadEnv", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-local-read-"));
		// The delivered names must be absent from the boot env too: a local run
		// inherits it as-is, and only the delivered env must be provably ignored.
		const saved = {
			GH_HOST: process.env.GH_HOST,
			GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
		};
		delete process.env.GH_HOST;
		delete process.env.GH_ENTERPRISE_TOKEN;
		try {
			const seen: Parameters<RunLauncher>[2][] = [];
			const handle = startRun({
				...baseOpts(dir, join(dir, "run.log")),
				launcher: (_c, _a, options) => {
					seen.push(options);
					const fake = new FakeOmp();
					queueMicrotask(() => fake.emit("close", 0));
					return fake as unknown as ChildProcess;
				},
				githubReadEnv: {
					GH_HOST: "acme.ghe.com",
					GH_ENTERPRISE_TOKEN: "tok-ent",
				},
			});
			await handle.done;
			expect(seen).toHaveLength(1);
			expect(seen[0]?.env).not.toHaveProperty("GH_HOST");
			expect(seen[0]?.env).not.toHaveProperty("GH_ENTERPRISE_TOKEN");
		} finally {
			if (saved.GH_HOST === undefined) delete process.env.GH_HOST;
			else process.env.GH_HOST = saved.GH_HOST;
			if (saved.GH_ENTERPRISE_TOKEN === undefined)
				delete process.env.GH_ENTERPRISE_TOKEN;
			else process.env.GH_ENTERPRISE_TOKEN = saved.GH_ENTERPRISE_TOKEN;
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

	test("a worker's sentinel stderr tail reaches the result with the lent token redacted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-worker-"));
		const lent = "sk-ant-oat01-worker-echo-0000";
		const sentinel = {
			[WORKER_DONE]: { exitCode: 1, stderrTail: `401 for ${lent}\n` },
		};
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(`${JSON.stringify(sentinel)}\n`),
		});
		try {
			const logPath = join(dir, "run.log");
			const r = await startRun({
				...baseOpts(dir, logPath),
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
				secrets: [lent],
			}).done;
			expect(r.exitCode).toBe(1);
			expect(r.stderrTail).toBe("401 for [REDACTED]\n");
			expect(readFileSync(logPath, "utf8")).not.toContain(lent);
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

	test("startRun() redacts the lent provider token from the task log and the stderr tail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-sink-"));
		const lent = "sk-ant-oat01-lent-echo-0000";
		try {
			const fake = new FakeOmp();
			const logPath = join(dir, "run.log");
			const handle = startRun({
				cwd: dir,
				prompt: "print env",
				sessionDir: join(dir, "sessions"),
				extensionPath: join(dir, "ext.ts"),
				resumeId: null,
				logPath,
				dataRoot: dir,
				env: { ANTHROPIC_OAUTH_TOKEN: lent },
				secrets: [lent],
				launcher: () => {
					queueMicrotask(() => {
						fake.stdout.emit(
							"data",
							Buffer.from(`ANTHROPIC_OAUTH_TOKEN=${lent}\n`),
						);
						fake.stderr.emit("data", Buffer.from(`401 for ${lent}\n`));
						fake.emit("close", 1);
					});
					return fake as unknown as ChildProcess;
				},
			});
			const r = await handle.done;
			const log = readFileSync(logPath, "utf8");
			expect(log).not.toContain(lent);
			expect(log).toContain("ANTHROPIC_OAUTH_TOKEN=[REDACTED]");
			expect(r.stderrTail).not.toContain(lent);
			expect(r.stderrTail).toContain("[REDACTED]");
		} finally {
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

// --- Agent layer pinning (OTTR-451) -----------------------------------------

import * as realOsNamespace from "node:os";
import { homedir as realHomedir } from "node:os";

// Bun caches os.homedir() per process, so a test cannot redirect the worker branch's
// shared-home resolution through $HOME. Patch the module instead; the patch falls back
// to the real homedir whenever testHome is null (reset in every finally).
const realHome = realHomedir(); // captured before the patch (Bun caches homedir anyway)
let testHome: string | null = null;
mock.module("node:os", () => ({
	...realOsNamespace,
	homedir: () => testHome ?? realHome,
}));

// A compiled worker omp stand-in that reports its env and holds the run open until a
// release file appears, so the test can switch the layer under a live run.
const layerOmpSource = `import { writeFileSync, existsSync } from "node:fs";
writeFileSync(process.env.LAYER_ENV_OUT, JSON.stringify(process.env));
const release = process.env.LAYER_RELEASE;
const t0 = Date.now();
while (!existsSync(release) && Date.now() - t0 < 20000) {}
process.stdout.write(JSON.stringify({ type: "session", id: "sess-layer" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end", isTerminal: true }) + "\\n");
`;
const layerOmp = compiledFakeOmp(
	"ottr-layer-omp-",
	"layer-omp.exe",
	layerOmpSource,
);

/** A minimal installed layer with its mnemopi config, the shape alate ships. */
function makeLayerDir(home: string, id: string): string {
	const dir = join(home, ".alate", "layers", id);
	mkdirSync(join(dir, ".omp", "agent"), { recursive: true });
	mkdirSync(join(dir, ".omp", "plugins"), { recursive: true });
	mkdirSync(join(dir, ".agents"), { recursive: true });
	writeFileSync(
		join(dir, ".omp", "agent", "config.yml"),
		"model: x\n  backend: mnemopi\n",
	);
	return dir;
}

/** Atomic current-switch, the way alate does it: temp symlink + rename. */
function switchCurrentTo(home: string, id: string): void {
	const tmp = join(home, ".alate", `current.${process.pid}.tmp`);
	symlinkSync(join("layers", id), tmp);
	renameSync(tmp, join(home, ".alate", "current"));
}

/** Poll until the predicate holds (the fake omp child signals through files). */
async function until(pred: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !pred(); i++)
		await new Promise((r) => setTimeout(r, 25));
	if (!pred()) throw new Error("timed out waiting for the fake omp child");
}

describe("startRun agent layer pinning", () => {
	const ENV_KEYS = [
		"HOME",
		"HINDSIGHT_API_URL",
		"OTTR_BOARD_OMP_HOME",
		"GH_TOKEN",
		"PI_CODING_AGENT_DIR",
	];
	function saveEnv(): Record<string, string | undefined> {
		const saved: Record<string, string | undefined> = {};
		for (const k of ENV_KEYS) saved[k] = process.env[k];
		return saved;
	}
	function restoreEnv(saved: Record<string, string | undefined>): void {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}

	test("worker dispatch pins the current layer: env carries the resolved layer, the registry records it, a switch under the live run never moves it", async () => {
		const saved = saveEnv();
		const shared = mkdtempSync(join(tmpdir(), "ottr-layer-shared-"));
		const aDir = makeLayerDir(shared, "A");
		symlinkSync(aDir, join(shared, ".alate", "current"));
		const rel1 = join(shared, "release-1");
		const out1 = join(shared, "env-1.json");
		const rel2 = join(shared, "release-2");
		const out2 = join(shared, "env-2.json");
		const dir = mkdtempSync(join(tmpdir(), "ottr-layer-run-"));
		const server = serveWorker({ port: 0, ompPath: layerOmp });
		try {
			testHome = shared; // the worker branch resolves its shared home via homedir()
			process.env.HINDSIGHT_API_URL = "https://hindsight.example/api";
			process.env.GH_TOKEN = "gh-secret";
			delete process.env.OTTR_BOARD_OMP_HOME;
			const workerOpts = (out: string, rel: string) => ({
				cwd: dir,
				prompt: "do it",
				sessionDir: join(dir, "sessions"),
				extensionPath: join(dir, "ext.ts"),
				resumeId: null,
				logPath: join(dir, `run-${basename(out)}.log`),
				dataRoot: dir,
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
				env: { LAYER_ENV_OUT: out, LAYER_RELEASE: rel },
			});

			const h1 = startRun(workerOpts(out1, rel1));
			expect(h1.pid).toBeNull();
			expect(h1.layerId).toBe("A");
			await until(() => existsSync(out1));
			const env1: Record<string, string> = JSON.parse(
				readFileSync(out1, "utf8"),
			);
			expect(env1.HOME).toBe(realpathSync(aDir));
			expect(env1.PI_CODING_AGENT_DIR).toBe(
				join(realpathSync(aDir), ".omp", "agent"),
			);
			expect(env1.GH_TOKEN).toBeUndefined();
			expect(env1.OTTR_BOARD_OMP_HOME).toBeUndefined();
			expect(env1.HINDSIGHT_API_URL).toBe("https://hindsight.example/api");
			// The pin registered the layer and never rewrote its config: memory.backend
			// is not layer content (OTTR-453), so the layer ships the backend as installed.
			expect(
				readFileSync(join(aDir, ".omp", "agent", "config.yml"), "utf8"),
			).toContain("  backend: mnemopi");
			expect(readLayerUse(shared).map((e) => e.id)).toEqual(["A"]);

			// Switch current -> B while run 1 holds A open: run 1 stays on A, run 2 pins B.
			const bDir = makeLayerDir(shared, "B");
			switchCurrentTo(shared, "B");
			const h2 = startRun(workerOpts(out2, rel2));
			expect(h2.layerId).toBe("B");
			await until(() => existsSync(out2));
			const env2: Record<string, string> = JSON.parse(
				readFileSync(out2, "utf8"),
			);
			expect(env1.HOME).toBe(realpathSync(aDir)); // run 1 never moved
			expect(env2.HOME).toBe(realpathSync(bDir));
			expect(env2.PI_CODING_AGENT_DIR).toBe(
				join(realpathSync(bDir), ".omp", "agent"),
			);
			expect(
				readLayerUse(shared)
					.map((e) => e.id)
					.sort(),
			).toEqual(["A", "B"]);

			writeFileSync(rel1, "go\n");
			writeFileSync(rel2, "go\n");
			const [r1, r2] = await Promise.all([h1.done, h2.done]);
			expect(r1.exitCode).toBe(0);
			expect(r2.exitCode).toBe(0);
			// Both runs settled: the registry drops both ids, so clean-up may run.
			expect(readLayerUse(shared)).toEqual([]);
		} finally {
			server.stop(true);
			testHome = null;
			restoreEnv(saved);
			rmSync(shared, { recursive: true, force: true, maxRetries: 5 });
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 30_000);

	test("local dispatch pins the board home's current layer", async () => {
		const saved = saveEnv();
		const board = mkdtempSync(join(tmpdir(), "ottr-layer-board-"));
		const dir = mkdtempSync(join(tmpdir(), "ottr-layer-local-"));
		try {
			const aDir = makeLayerDir(board, "A");
			symlinkSync(aDir, join(board, ".alate", "current"));
			process.env.OTTR_BOARD_OMP_HOME = board;
			process.env.HINDSIGHT_API_URL = "https://hindsight.example/api";
			delete process.env.PI_CODING_AGENT_DIR;
			delete process.env.GH_TOKEN;
			const seen: Parameters<RunLauncher>[2][] = [];
			const launcher: RunLauncher = (_c, _a, options) => {
				seen.push(options);
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const logPath = join(dir, "run.log");
			const handle = startRun({
				cwd: dir,
				prompt: "do it",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath,
				dataRoot: dir,
				launcher,
			});
			expect(handle.layerId).toBe("A");
			await handle.done;
			expect(seen).toHaveLength(1);
			expect(seen[0]?.env?.HOME).toBe(realpathSync(aDir));
			expect(seen[0]?.env?.PI_CODING_AGENT_DIR).toBe(
				join(realpathSync(aDir), ".omp", "agent"),
			);
			// The run settled: the board home's registry is empty again.
			expect(readLayerUse(board)).toEqual([]);
		} finally {
			restoreEnv(saved);
			rmSync(board, { recursive: true, force: true, maxRetries: 5 });
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("stripGithubToken: a local child runs without GH_TOKEN and GITHUB_TOKEN; other local runs keep GH_TOKEN", async () => {
		const saved = saveEnv();
		const savedGithub = process.env.GITHUB_TOKEN;
		const dir = mkdtempSync(join(tmpdir(), "ottr-strip-gh-"));
		try {
			process.env.GH_TOKEN = "ghp_board_token";
			process.env.GITHUB_TOKEN = "ghp_other";
			const seen: Parameters<RunLauncher>[2][] = [];
			const launcher: RunLauncher = (_c, _a, options) => {
				seen.push(options);
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const run = (stripGithubToken: boolean) =>
				startRun({
					cwd: dir,
					prompt: "do it",
					sessionDir: join(dir, "sessions"),
					extensionPath: null,
					resumeId: null,
					logPath: join(dir, `run-${stripGithubToken}.log`),
					dataRoot: dir,
					launcher,
					stripGithubToken,
				}).done;
			await run(true);
			await run(false);
			expect(seen).toHaveLength(2);
			expect(seen[0]?.env).not.toHaveProperty("GH_TOKEN");
			expect(seen[0]?.env).not.toHaveProperty("GITHUB_TOKEN");
			// A merge turn runs locally too and needs the token for its push.
			expect(seen[1]?.env?.GH_TOKEN).toBe("ghp_board_token");
		} finally {
			restoreEnv(saved);
			if (savedGithub === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedGithub;
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("no layer: the env stays exactly as today and no warning is logged", async () => {
		const saved = saveEnv();
		const board = mkdtempSync(join(tmpdir(), "ottr-layer-flat-"));
		const dir = mkdtempSync(join(tmpdir(), "ottr-layer-nolayer-"));
		try {
			process.env.OTTR_BOARD_OMP_HOME = board;
			delete process.env.PI_CODING_AGENT_DIR;
			const seen: Parameters<RunLauncher>[2][] = [];
			const launcher: RunLauncher = (_c, _a, options) => {
				seen.push(options);
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const logPath = join(dir, "run.log");
			const handle = startRun({
				cwd: dir,
				prompt: "do it",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath,
				dataRoot: dir,
				launcher,
			});
			expect(handle.layerId).toBeNull();
			await handle.done;
			expect(seen).toHaveLength(1);
			expect(seen[0]?.env?.HOME).toBe(board); // the flat board home, unchanged
			expect(seen[0]?.env?.PI_CODING_AGENT_DIR).toBeUndefined();
			// No warning mark: a missing layer is the normal migration state, not a failure.
			expect(existsSync(logPath)).toBe(false);
		} finally {
			restoreEnv(saved);
			rmSync(board, { recursive: true, force: true, maxRetries: 5 });
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a broken current link: warning mark logged, the run falls back to the flat home", async () => {
		const saved = saveEnv();
		const board = mkdtempSync(join(tmpdir(), "ottr-layer-broken-"));
		const dir = mkdtempSync(join(tmpdir(), "ottr-layer-brokenrun-"));
		try {
			mkdirSync(join(board, ".alate"), { recursive: true });
			symlinkSync(join("layers", "gone"), join(board, ".alate", "current"));
			process.env.OTTR_BOARD_OMP_HOME = board;
			delete process.env.PI_CODING_AGENT_DIR;
			const seen: Parameters<RunLauncher>[2][] = [];
			const launcher: RunLauncher = (_c, _a, options) => {
				seen.push(options);
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const logPath = join(dir, "run.log");
			const handle = startRun({
				cwd: dir,
				prompt: "do it",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath,
				dataRoot: dir,
				launcher,
			});
			expect(handle.layerId).toBeNull();
			await handle.done;
			expect(seen).toHaveLength(1);
			expect(seen[0]?.env?.HOME).toBe(board); // flat fallback
			expect(seen[0]?.env?.PI_CODING_AGENT_DIR).toBeUndefined();
			expect(readFileSync(logPath, "utf8")).toContain(
				"! agent layer pin failed (broken); running the flat home",
			);
		} finally {
			restoreEnv(saved);
			rmSync(board, { recursive: true, force: true, maxRetries: 5 });
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("http400Dirs follows each home's current layer (moment-in-time)", () => {
		// White-box: the reader must include a layer dir's http-400 root alongside the flat
		// homes. Exercised through findHttp400Rejection with the board home pinned to a temp
		// home whose layer holds the entry.
		const saved = saveEnv();
		const board = mkdtempSync(join(tmpdir(), "http400-layer-"));
		try {
			const layer = makeLayerDir(board, "L");
			symlinkSync(layer, join(board, ".alate", "current"));
			const logs = join(layer, ".omp", "logs", "http-400-requests");
			mkdirSync(logs, { recursive: true });
			writeFileSync(join(logs, "9791198198684-layer.json"), "{}");
			process.env.OTTR_BOARD_OMP_HOME = board;
			expect(
				findHttp400Rejection({ from: 9791198198000, to: 9791198199000 }),
			).toBe("9791198198684-layer.json");
		} finally {
			restoreEnv(saved);
			rmSync(board, { recursive: true, force: true, maxRetries: 5 });
		}
	});
	test("a worker dispatch failure unregisters the pinned layer from the registry", async () => {
		const saved = saveEnv();
		const shared = mkdtempSync(join(tmpdir(), "ottr-layer-dead-"));
		mkdirSync(join(shared, ".alate", "layers", "A", ".omp", "agent"), {
			recursive: true,
		});
		symlinkSync(join("layers", "A"), join(shared, ".alate", "current"));
		const dir = mkdtempSync(join(tmpdir(), "ottr-layer-dead-run-"));
		// A server that was stopped: the port refuses connections immediately.
		const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
		const deadUrl = `http://127.0.0.1:${dead.port}`;
		dead.stop(true);
		try {
			testHome = shared; // the worker branch resolves its shared home via homedir()
			let spawned = 0;
			const launcher: RunLauncher = () => {
				spawned++;
				const fake = new FakeOmp();
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			};
			const r = await startRun({
				cwd: dir,
				prompt: "p",
				sessionDir: join(dir, "sessions"),
				extensionPath: join(dir, "ext.ts"),
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				worker: { urls: [deadUrl] },
				launcher,
			}).done;
			expect(spawned).toBe(0); // fail closed: never run a worker turn locally
			expect(r.workerLost).toBe(true);
			// The failed dispatch released the layer: alate's clean-up sees no in-use entry.
			expect(readLayerUse(shared)).toEqual([]);
		} finally {
			restoreEnv(saved);
			testHome = null;
			rmSync(shared, { recursive: true, force: true, maxRetries: 5 });
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});
});

describe("vmRunnerFromEnv", () => {
	test("unset or blank is null", () => {
		expect(vmRunnerFromEnv({})).toBeNull();
		expect(vmRunnerFromEnv({ OTTR_VM_RUNNER_URL: "  " })).toBeNull();
	});

	test("a url without the worker token fails closed; with it one url, no trailing slash", () => {
		expect(() =>
			vmRunnerFromEnv({ OTTR_VM_RUNNER_URL: "http://vm-runner:8787" }),
		).toThrow("OTTR_WORKER_TOKEN");
		expect(
			vmRunnerFromEnv({
				OTTR_VM_RUNNER_URL: " http://vm-runner:8787/ ",
				OTTR_WORKER_TOKEN: "t",
			}),
		).toEqual({ urls: ["http://vm-runner:8787"], token: "t" });
	});
});

describe("vmProviders", () => {
	test("active sign-ins, env API keys and the model's provider, deduplicated and sorted", () => {
		expect(
			vmProviders(
				"zai/glm-5",
				[
					{ provider: "openai-codex", active: true },
					{ provider: "anthropic", active: true },
					// A disabled sign-in has no credential the gateway could use.
					{ provider: "google", active: false },
				],
				{ OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "" },
			),
		).toEqual(["anthropic", "openai", "openai-codex", "zai"]);
	});

	test("an unreadable store still routes the turn model's provider", () => {
		expect(vmProviders("anthropic/claude", null, {})).toEqual(["anthropic"]);
		// A model without a provider prefix adds nothing.
		expect(vmProviders("bare-model", null, {})).toEqual([]);
	});
});

describe("vmEnv", () => {
	const board = {
		url: "http://127.0.0.1:4747",
		token: "boot-token",
		project: "p",
		taskId: "P-1",
	};

	test("an allowlist: env.txt values and run flags pass, credentials and board-process names never", () => {
		const env = vmEnv({
			env: {
				FOO: "bar",
				OTTR_REVIEW: "1",
				ANTHROPIC_API_KEY: "sk-ant",
				ANTHROPIC_OAUTH_TOKEN: "lent-oauth",
				ZAI_API_KEY: "zai-lent",
				OPENAI_API_KEY: "sk-oai",
				GH_TOKEN: "ghp",
				GITHUB_TOKEN: "ghp2",
				HINDSIGHT_API_TOKEN: "hs",
				OTTR_WORKER_TOKEN: "wt",
				SOME_NAME: "lent-elsewhere",
				PATH: "/board/bin",
			},
			secrets: ["lent-elsewhere"],
			sessionName: "Fix it",
			board,
			boardUrl: "http://ottr:8080",
			token: "vm-token",
			layerEnv: {
				HOME: "/root/.alate/layers/l1",
				PI_CODING_AGENT_DIR: "/root/.alate/layers/l1/.omp/agent",
			},
		});
		expect(env).toEqual({
			FOO: "bar",
			OTTR_REVIEW: "1",
			OTTR_SESSION_NAME: "Fix it",
			OTTR_BOARD_URL: "http://ottr:8080",
			OTTR_BOARD_TOKEN: "vm-token",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "P-1",
			HOME: "/root/.alate/layers/l1",
			PI_CODING_AGENT_DIR: "/root/.alate/layers/l1/.omp/agent",
		});
	});

	test("the board's GIT_CONFIG_GLOBAL pointer never rides to the guest", () => {
		// OTTR-693: the guest mounts no board-config; a pointer to a missing file would
		// make the turn's git skip the global scope and hide an identity the image ships.
		const env = vmEnv({
			env: { GIT_CONFIG_GLOBAL: "/etc/ottr/gitconfig", KEEP_ME: "1" },
			board,
			boardUrl: "http://ottr:8080",
			token: "vm-token",
			layerEnv: null,
		});
		expect(env).toEqual({
			KEEP_ME: "1",
			OTTR_BOARD_URL: "http://ottr:8080",
			OTTR_BOARD_TOKEN: "vm-token",
			OTTR_PROJECT: "p",
			OTTR_TASK_ID: "P-1",
		});
	});

	test("stripBoard drops the board coordinates and the VM token", () => {
		const env = vmEnv({
			env: { OTTR_RETRO: "1" },
			board,
			stripBoard: true,
			boardUrl: "http://ottr:8080",
			token: "vm-token",
			layerEnv: null,
		});
		expect(env).toEqual({ OTTR_RETRO: "1" });
	});
});

describe("classify microVM dirty tree", () => {
	const ready = (vmDirty: string[] | null) =>
		classify({
			kind: "work",
			result: result({ outcome: outcome() }),
			git: git({ clean: false }),
			target: null,
			previousError: null,
			vmDirty,
		});

	test("a ready report over a dirty VM tree parks and names the first 20 files", () => {
		const files = Array.from({ length: 23 }, (_, i) => `?? f${i}.txt`);
		const next = ready(files);
		expect(next.state).toBe("needs_you");
		expect(next.needsReason).toContain("?? f0.txt, ?? f1.txt");
		expect(next.needsReason).toContain("?? f19.txt");
		expect(next.needsReason).not.toContain("?? f20.txt");
		expect(next.needsReason).toContain("(+3 more)");
	});

	test("a VM that could not report its tree says so", () => {
		const next = ready(null);
		expect(next.state).toBe("needs_you");
		expect(next.needsReason).toContain("could not report");
	});

	test("a classic run keeps today's reason", () => {
		const next = classify({
			kind: "work",
			result: result({ outcome: outcome() }),
			git: git({ clean: false }),
			target: null,
			previousError: null,
		});
		expect(next.needsReason).toBe(
			"Reported ready, but git shows 1 commit(s) ahead of the base and uncommitted changes.",
		);
	});
});

describe("startRun microVM dispatch", () => {
	const grant = {
		project: "p",
		taskId: "P-1",
		branch: "ott/p-1-x",
		repoPath: "/workspace/p",
		worktree: "/workspace/p/.worktrees/P-1",
	};
	const vmOut: VmOutcome = {
		head: "a".repeat(40),
		pushError: null,
		dirty: [],
	};

	/** A fake vm-runner: records each /run body and the token's grant at dispatch time. */
	function fakeRunner(tokens: VmTokens, answer: "run" | "busy" | "plain503") {
		const seen: { body: WorkerRequest; grantAtDispatch: unknown }[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const body = (await req.json()) as WorkerRequest;
				seen.push({ body, grantAtDispatch: tokens.check(body.vm?.token) });
				if (answer === "busy")
					return new Response("busy", {
						status: 503,
						headers: { "x-ottr-busy": "1" },
					});
				if (answer === "plain503") return new Response("down", { status: 503 });
				return new Response(
					[
						JSON.stringify({ type: "session", id: "sess-vm" }),
						JSON.stringify({ type: "agent_end", isTerminal: true }),
						JSON.stringify({
							[WORKER_DONE]: {
								exitCode: 0,
								stderrTail: "",
								host: "vm",
								vm: vmOut,
							},
						}),
						"",
					].join("\n"),
				);
			},
		});
		return { server, seen, url: `http://127.0.0.1:${server.port}` };
	}

	function vmOpts(dir: string, tokens: VmTokens, url: string) {
		const sessionDir = join(dir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "1_sess-old.jsonl"), "{}\n");
		writeFileSync(join(sessionDir, "2_other.jsonl"), "{}\n");
		return {
			cwd: dir,
			prompt: "do it",
			sessionDir,
			extensionPath: join(dir, "ext.ts"),
			resumeId: "sess-old",
			images: [join(dir, "img.png")],
			model: "anthropic/claude-x",
			logPath: join(dir, "run.log"),
			dataRoot: dir,
			memoryConfigPath: join(dir, "omp-memory.yml"),
			board: {
				url: "http://127.0.0.1:4747",
				token: "boot-token",
				project: "p",
				taskId: "P-1",
			},
			env: { FOO: "bar", ANTHROPIC_OAUTH_TOKEN: "lent-tok" },
			secrets: ["lent-tok"],
			launcher: (() => {
				throw new Error("a microVM turn must never spawn locally");
			}) as RunLauncher,
			vm: {
				target: { urls: [url], token: "wtok" },
				tokens,
				grant,
				base: "sha-base",
				boardUrl: "http://ottr:8080",
				providers: ["anthropic"],
				hindsight: false,
			},
		};
	}

	test("the VM gets its own token, never the boot token or a lent or board credential; the token dies at settle", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-vm-"));
		const tokens = new VmTokens({ file: null });
		const { server, seen, url } = fakeRunner(tokens, "run");
		const saved = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-board-key";
		try {
			const run = startRun(vmOpts(dir, tokens, url));
			expect(run.url).toBe(url);
			const r = await run.done;
			expect(await run.accepted).toBe(true);
			expect(r.exitCode).toBe(0);
			expect(r.vm).toEqual(vmOut);
			expect(r.workerBusy).toBeUndefined();
			const { body, grantAtDispatch } = seen[0]!;
			const token = body.vm!.token;
			// Live while the VM ran, revoked once the run settled.
			expect(grantAtDispatch).toEqual({ ...grant, base: "sha-base" });
			expect(tokens.check(token)).toBeNull();
			expect(body.env.OTTR_BOARD_TOKEN).toBe(token);
			expect(body.env.FOO).toBe("bar");
			const values = Object.values(body.env);
			for (const leaked of ["boot-token", "lent-tok", "sk-board-key"])
				expect(values).not.toContain(leaked);
			expect(
				Object.keys(body.env).filter((k) =>
					/^(ANTHROPIC|OPENAI|GH|HINDSIGHT)_/.test(k),
				),
			).toEqual([]);
			expect(body.vm).toMatchObject({
				project: "p",
				taskId: "P-1",
				branch: "ott/p-1-x",
				base: "sha-base",
				boardUrl: "http://ottr:8080",
				providers: ["anthropic"],
				hindsight: false,
				copyOut: [join(dir, "sessions")],
			});
			// Only the resumed session's file, the turn's images and the memory overlay go in.
			expect(body.vm!.copyIn).toEqual([
				join(dir, "sessions", "1_sess-old.jsonl"),
				join(dir, "img.png"),
				join(dir, "omp-memory.yml"),
			]);
			// The raw VM token never reaches the task log.
			expect(readFileSync(join(dir, "run.log"), "utf8")).not.toContain(token);
		} finally {
			if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = saved;
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a busy runner settles workerBusy, not a lost worker, and the token is revoked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-vm-busy-"));
		const tokens = new VmTokens({ file: null });
		const { server, seen, url } = fakeRunner(tokens, "busy");
		try {
			const run = startRun(vmOpts(dir, tokens, url));
			expect(await run.accepted).toBe(false);
			const r = await run.done;
			expect(r.workerBusy).toBe(true);
			expect(r.workerLost).toBeUndefined();
			expect(r.exitCode).toBeNull();
			expect(tokens.check(seen[0]!.body.vm!.token)).toBeNull();
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the memory overlay of a VM turn lives in the project's data dir, which vm-runner copies in", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-vm-mem-"));
		const tokens = new VmTokens({ file: null });
		const { server, seen, url } = fakeRunner(tokens, "run");
		try {
			const { memoryConfigPath: _omit, ...opts } = vmOpts(dir, tokens, url);
			await startRun(opts).done;
			const overlay = join(dir, "omp-memory.yml");
			const { body } = seen[0]!;
			expect(existsSync(overlay)).toBe(true);
			expect(body.vm!.copyIn).toContain(overlay);
			const at = body.argv.lastIndexOf("--config");
			expect(body.argv[at + 1]).toBe(overlay);
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a 503 without the busy header is a lost dispatch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-vm-503-"));
		const tokens = new VmTokens({ file: null });
		const { server, url } = fakeRunner(tokens, "plain503");
		try {
			const r = await startRun(vmOpts(dir, tokens, url)).done;
			expect(r.workerLost).toBe(true);
			expect(r.workerBusy).toBeUndefined();
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the default commit identity does not ride the VM env; an explicit identity does", async () => {
		// The guest seeds the clone's own git config (src/vmGuest.ts), so the automatic
		// Ottr default must stay out of the dispatch; the Settings identity is opt-in.
		const dir = mkdtempSync(join(tmpdir(), "ottr-vm-ident-"));
		const tokens = new VmTokens({ file: null });
		const { server, seen, url } = fakeRunner(tokens, "run");
		try {
			const { memoryConfigPath: _omit, ...opts } = vmOpts(dir, tokens, url);
			await startRun(opts).done;
			const env = seen[0]!.body.env ?? {};
			expect(env.GIT_AUTHOR_NAME).toBeUndefined();
			expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();

			seen.length = 0;
			await startRun({
				...opts,
				commitIdentity: { name: "Acme", email: "ci@acme.dev" },
			}).done;
			const custom = seen[0]!.body.env ?? {};
			expect(custom.GIT_AUTHOR_NAME).toBe("Acme");
			expect(custom.GIT_AUTHOR_EMAIL).toBe("ci@acme.dev");
			expect(custom.GIT_COMMITTER_NAME).toBe("Acme");
			expect(custom.GIT_COMMITTER_EMAIL).toBe("ci@acme.dev");
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("startRun commit identity env", () => {
	function localLauncher(seen: Parameters<RunLauncher>[2][]): RunLauncher {
		return (_c, _a, options) => {
			seen.push(options);
			const fake = new FakeOmp();
			queueMicrotask(() => fake.emit("close", 0));
			return fake as unknown as ChildProcess;
		};
	}

	const IDENT_VARS = [
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
	] as const;

	test("an unset identity applies the Ottr default for every field the probe leaves empty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-ident-default-"));
		const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = "/etc/ottr/gitconfig";
		try {
			const seen: Parameters<RunLauncher>[2][] = [];
			const probes: IdentProbeEnv[] = [];
			const handle = startRun({
				cwd: dir,
				prompt: "do the thing",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher: localLauncher(seen),
				gitProbe: (o) => {
					probes.push(o);
					return { name: false, email: false };
				},
			});
			await handle.done;
			expect(seen[0]!.env).toMatchObject({
				GIT_AUTHOR_NAME: "Ottr",
				GIT_AUTHOR_EMAIL: "ottr@localhost",
				GIT_COMMITTER_NAME: "Ottr",
				GIT_COMMITTER_EMAIL: "ottr@localhost",
			});
			// A local turn keeps the board's pinned global: the probe must read what the
			// turn's git reads, so the pinned identity never gets replaced by the env.
			expect(probes[0]).toMatchObject({
				cwd: dir,
				gitConfigGlobal: "/etc/ottr/gitconfig",
			});
			expect(seen[0]?.env?.GIT_CONFIG_GLOBAL ?? "").toBe("/etc/ottr/gitconfig");
		} finally {
			if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a fully configured git identity injects nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-ident-set-"));
		try {
			const seen: Parameters<RunLauncher>[2][] = [];
			const handle = startRun({
				cwd: dir,
				prompt: "do the thing",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher: localLauncher(seen),
				gitProbe: () => ({ name: true, email: true }),
			});
			await handle.done;
			for (const k of IDENT_VARS) expect(seen[0]!.env).not.toHaveProperty(k);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an explicit Settings identity wins over the Ottr default", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-ident-custom-"));
		try {
			const seen: Parameters<RunLauncher>[2][] = [];
			const handle = startRun({
				cwd: dir,
				prompt: "do the thing",
				sessionDir: join(dir, "sessions"),
				extensionPath: null,
				resumeId: null,
				logPath: join(dir, "run.log"),
				dataRoot: dir,
				launcher: localLauncher(seen),
				gitProbe: () => ({ name: false, email: false }),
				commitIdentity: { name: "Acme", email: "ci@acme.dev" },
			});
			await handle.done;
			expect(seen[0]!.env).toMatchObject({
				GIT_AUTHOR_NAME: "Acme",
				GIT_AUTHOR_EMAIL: "ci@acme.dev",
				GIT_COMMITTER_NAME: "Acme",
				GIT_COMMITTER_EMAIL: "ci@acme.dev",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a worker dispatch POSTs the default identity to the worker", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-ident-worker-"));
		// A compiled omp stand-in that echoes the ident vars it received, so the
		// board's run.log proves what the worker env carried.
		const identOmp = compiledFakeOmp(
			"ottr-ident-omp-",
			"fake-omp-ident.exe",
			[
				`for (const k of ${JSON.stringify([...IDENT_VARS, "GIT_CONFIG_GLOBAL"])})`,
				'\tprocess.stdout.write("IDENT " + k + "=" + String(process.env[k]) + "\\n");',
				'process.stdout.write(JSON.stringify({ type: "session", id: "sess-ident" }) + "\\n");',
				'process.stdout.write(JSON.stringify({ type: "agent_end", isTerminal: true }) + "\\n");',
				"process.exit(0);",
			].join("\n"),
		);
		const server = serveWorker({ port: 0, ompPath: identOmp });
		const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = "/etc/ottr/gitconfig";
		try {
			const probes: IdentProbeEnv[] = [];
			const logPath = join(dir, "run.log");
			const { done } = startRun({
				cwd: dir,
				prompt: "do it",
				sessionDir: join(dir, "sessions"),
				extensionPath: join(dir, "ext.ts"),
				resumeId: null,
				logPath,
				dataRoot: dir,
				worker: { urls: [`http://127.0.0.1:${server.port}`] },
				gitProbe: (o) => {
					probes.push(o);
					return { name: false, email: false };
				},
			});
			const r = await done;
			expect(r.exitCode).toBe(0);
			// The worker probe must mirror the worker's git: no pointer, because the
			// dispatch strips GIT_CONFIG_GLOBAL (the worker mounts no board-config).
			expect(probes[0]).toMatchObject({ cwd: dir, gitConfigGlobal: null });
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("IDENT GIT_AUTHOR_NAME=Ottr");
			expect(log).toContain("IDENT GIT_AUTHOR_EMAIL=ottr@localhost");
			expect(log).toContain("IDENT GIT_COMMITTER_NAME=Ottr");
			expect(log).toContain("IDENT GIT_COMMITTER_EMAIL=ottr@localhost");
			// The board's pinned pointer never reaches the worker's git: it would hide
			// the shared home's ~/.gitconfig (the CMIS-1 failure).
			expect(log).toContain("IDENT GIT_CONFIG_GLOBAL=undefined");
		} finally {
			if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

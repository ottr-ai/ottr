// omp extension: tracks whether the agent reported its outcome via report_outcome.
// Loaded per run via `--extension <abs path>`; the task runner reads the tool call
// from omp's JSON event stream.

// ponytail: minimal structural typing of omp's extension API; @oh-my-pi packages not installed
interface ZodBuilder {
	object(shape: Record<string, unknown>): unknown;
	enum(values: readonly string[]): {
		optional(): { describe(hint: string): unknown };
		describe(hint: string): unknown;
	};
	string(): {
		optional(): { describe(hint: string): unknown };
		describe(hint: string): unknown;
	};
	number(): {
		optional(): { describe(hint: string): unknown };
		describe(hint: string): unknown;
	};
	boolean(): {
		optional(): { describe(hint: string): unknown };
		describe(hint: string): unknown;
	};
	array(item: unknown): {
		optional(): { describe(hint: string): unknown };
		describe(hint: string): unknown;
	};
}
interface ReportParams {
	status: string;
}
interface AskParams {
	questions?: unknown;
}
interface RenameParams {
	title?: unknown;
}
interface CreateTaskParams {
	prompt?: unknown;
	model?: unknown;
	dependsOn?: unknown;
	rank?: unknown;
	security?: unknown;
}
interface Pi {
	zod: ZodBuilder;
	registerTool(def: Record<string, unknown>): void;
	on(event: string, handler: (...args: unknown[]) => unknown): void;
	/** omp's session name; undefined or blank while the session is unnamed (fresh session or no auto title yet). */
	getSessionName(): string | undefined | Promise<string | undefined>;
	setSessionName(name: string): unknown;
}

let reported = false;
let refusedOnce = false;
let blocks = 0;
let asked = false;
let proposed = false;

// Build the standard single-text tool result both executes return.
function textResult(text: string) {
	return { content: [{ type: "text", text }], details: {} };
}

// Trimmed, non-empty dependsOn ids; non-string or blank entries are dropped.
function parseDependsOn(params: CreateTaskParams): string[] {
	return Array.isArray(params.dependsOn)
		? params.dependsOn
				.filter((x): x is string => typeof x === "string" && x.trim() !== "")
				.map((x) => x.trim())
		: [];
}

// POST the card to the board and interpret the response. Returns the filed id
// or a ready-to-show error text; the tool's own validation runs before this.
async function fileCard(args: {
	base: string;
	project: string;
	parent: string;
	token: string;
	prompt: string;
	model: string;
	dependsOn: string[];
}): Promise<{ ok: true; id: string } | { ok: false; text: string }> {
	const { base, project, parent, token, prompt, model, dependsOn } = args;
	let res: Response;
	try {
		// The origin header satisfies the board's allowlist (non-browser clients send none).
		res = await fetch(
			`${base}/api/projects/${encodeURIComponent(project)}/tasks`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: base,
					...(token !== "" ? { "x-board-token": token } : {}),
				},
				body: JSON.stringify({
					prompt,
					followUpOf: parent,
					...(model !== "" ? { model } : {}),
					...(dependsOn.length > 0 ? { dependsOn } : {}),
				}),
			},
		);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			text: `Error: the board at ${base} is unreachable (${why}). File no cards; report the blocker.`,
		};
	}
	const body = (await res.json().catch(() => null)) as {
		id?: unknown;
		error?: unknown;
	} | null;
	if (!res.ok || body === null || typeof body.id !== "string") {
		const why =
			body !== null && typeof body.error === "string" ? ` — ${body.error}` : "";
		return {
			ok: false,
			text: `Error: card not filed (HTTP ${res.status}${why}). Fix the cause or report the blocker.`,
		};
	}
	return { ok: true, id: body.id };
}

// Shared validation of propose_task params; returns the error text or null.
// The prompt/model messages keep the propose_task wording (not create_task's).
function proposeValidationError(
	params: CreateTaskParams,
	reviewMode: boolean,
): string | null {
	const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
	if (prompt === "" || prompt.length > 20000) {
		return "Error: prompt must be a string of 1-20000 characters (trimmed).";
	}
	const model = typeof params.model === "string" ? params.model.trim() : "";
	if (params.model !== undefined && model === "") {
		return "Error: model must be a non-empty string when given.";
	}
	if (
		reviewMode &&
		params.rank !== undefined &&
		(typeof params.rank !== "number" ||
			!Number.isInteger(params.rank) ||
			params.rank < 1)
	) {
		return "Error: rank must be an integer of 1 or more when given.";
	}
	return null;
}

// The tracker pins review session names via env so every review run gets the same board title.
const pinned = (process.env.OTTR_SESSION_NAME ?? "").trim();

/**
 * Git host secrets this run holds: a merge turn gets per-host tokens as OTTR_GIT_TOKEN_<i>
 * and Ottr's ssh dir in GIT_SSH_COMMAND (src/gitHosts.ts gitAuthEnv). Read per call: the env
 * is fixed for the run, but tests set it after load.
 */
export function runGitSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(env))
		if (/^OTTR_GIT_TOKEN_\d+$/.test(k) && v) out.push(v);
	const kh = /UserKnownHostsFile='([^']+)'/.exec(
		env.GIT_SSH_COMMAND ?? "",
	)?.[1];
	if (kh) out.push(kh.slice(0, kh.lastIndexOf("/")) || kh);
	return out;
}

/** One pass, longest secret first: "[REDACTED]" is never rescanned (mirrors src/worktree.ts redact). */
export function redactText(text: string, secrets: readonly string[]): string {
	const live = secrets
		.filter((s) => s !== "")
		.sort((a, b) => b.length - a.length);
	if (live.length === 0) return text;
	const re = new RegExp(
		live.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
		"g",
	);
	return text.replace(re, "[REDACTED]");
}

export default function (pi: Pi) {
	const z = pi.zod;

	// Defense in depth: no agent run gets git host credentials (D6, src/runner.ts), so this
	// fires only if one leaked into the env. omp persists every tool result to the session
	// file, which Ottr's log sink never sees: redact content and details before omp stores
	// them and before the model reads them.
	pi.on("tool_result", (event: unknown) => {
		const secrets = runGitSecrets();
		if (secrets.length === 0) return undefined;
		const e = event as { content?: unknown; details?: unknown }; // omp's ToolResultEvent; only these two fields persist
		// Walk the raw values, never a re-serialized form: JSON escapes a quote or backslash
		// inside a token, and a scan of the escaped text would miss it. Untouched values keep
		// their identity, so a result without a secret goes back to omp unchanged.
		const scrub = (v: unknown): unknown => {
			if (typeof v === "string") return redactText(v, secrets);
			if (Array.isArray(v)) {
				const out = v.map(scrub);
				return out.some((x, i) => x !== v[i]) ? out : v;
			}
			if (typeof v === "object" && v !== null && v.constructor === Object) {
				const entries = Object.entries(v);
				const out = entries.map(([k, x]) => [k, scrub(x)] as const);
				return out.some(([, x], i) => x !== entries[i]?.[1])
					? Object.fromEntries(out)
					: v;
			}
			return v;
		};
		const content = scrub(e.content);
		const details = scrub(e.details);
		if (content === e.content && details === e.details) return undefined;
		return { content, details };
	});

	// Proactive naming: name a fresh session before the agent runs; a named session keeps its name.
	// omp throws "Extension runtime not initialized" when an action method is called during
	// extension load — and a synchronous throw escapes the .catch below, aborting the whole
	// extension (no report_outcome/ask for the run). Defer the call past load; a macrotask
	// runs after omp finishes initializing the runtime.
	if (pinned !== "") {
		setTimeout(() => {
			void (async () => {
				try {
					const current = await pi.getSessionName();
					if (typeof current !== "string" || current.trim() === "")
						await pi.setSessionName(pinned);
				} catch {
					// ponytail: cosmetic; the prompt's rename call stays as fallback
				}
			})();
		}, 0);
	}

	pi.registerTool({
		name: "report_outcome",
		label: "Report outcome",
		description:
			"Report how this turn ended to the omp task tracker. Call it exactly once, as your last action. " +
			"status: ready = work committed on the task branch and needs integration; " +
			"answered = question-only task, nothing to merge; " +
			"integrated = merge turn finished and the branch is on the integration target; " +
			"needs_you = you need the user (put the exact question in question). " +
			"summary: 1-3 lines for the board card. details: the full report shown on the card (answered: your complete answer; integrated: the integration output verbatim). " +
			"dependsOn: ids of cards this turn waits for — a needs_you outcome with dependsOn requeues the card in its current stage, and the tracker restarts it when every id is done or cancelled.",
		parameters: z.object({
			status: z
				.enum(["ready", "answered", "integrated", "needs_you"])
				.describe("How the turn ended"),
			summary: z.string().describe("1-3 lines for the board card"),
			details: z
				.string()
				.optional()
				.describe(
					"Full report shown on the card: your complete answer (answered) or the integration output verbatim (integrated)",
				),
			question: z
				.string()
				.optional()
				.describe("Exact question for the user, when status is needs_you"),
			// Without this field the harness drops every reported screenshot before the tracker sees it.
			shots: z
				.array(z.string())
				.optional()
				.describe(
					"Worktree-relative paths of the screenshots that prove a visible UI change (save them under shots/); the board shows them on the card",
				),
			dependsOn: z
				.array(z.string())
				.optional()
				.describe(
					"Ids of cards in the same project that must be done (or cancelled) before this card's next turn starts. A needs_you outcome with dependsOn requeues the card in its current stage instead of parking at needs_you; the tracker restarts the turn when they finish. A turn that must wait for a card it filed with create_task passes that id here.",
				),
		}),
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId: string, params: ReportParams) {
			// A card without a session title shows the prompt's first line, so refuse once and
			// send the agent to rename. The next call records even when the name is still
			// missing, so an agent that ignores the hint keeps its outcome. Retro runs have no
			// rename tool, so they never refuse; a getSessionName failure records rather than
			// blocks the outcome.
			if (!refusedOnce && process.env.OTTR_RETRO !== "1") {
				let unnamed = true;
				try {
					const name = await pi.getSessionName();
					unnamed = typeof name !== "string" || name.trim() === "";
				} catch {
					unnamed = false;
				}
				if (unnamed) {
					refusedOnce = true;
					throw new Error(
						"This session has no title yet, so the board card would show the prompt's first line. " +
							"Call the rename tool with a 3-8 word title for the task, then call report_outcome again with the same arguments. " +
							"A second report_outcome without a rename is also recorded.",
					);
				}
			}
			reported = true;
			return {
				content: [{ type: "text", text: `Outcome recorded: ${params.status}` }],
				details: {},
			};
		},
	});

	// ponytail: parameters must produce exactly the runner's args.questions shape (see src/types.ts)
	pi.registerTool({
		name: "ask",
		label: "Ask the user",
		description:
			"Ask the tracker user one or more questions with clickable choices. Pauses the run until the answer " +
			"arrives as the next message. Use it instead of guessing a direction. Bundle all questions of one " +
			"pause into a single call.",
		parameters: z.object({
			questions: z
				.array(
					z.object({
						question: z.string().describe("The question text"),
						options: z
							.array(
								z.object({
									label: z.string().describe("Choice shown as a button"),
									description: z
										.string()
										.optional()
										.describe("Optional explanation of the choice"),
								}),
							)
							.describe(
								"2-5 answer choices; the user can also type a custom answer",
							),
						multi: z
							.boolean()
							.optional()
							.describe("Allow choosing several options"),
						recommended: z
							.number()
							.optional()
							.describe("Zero-based index of the recommended option"),
					}),
				)
				.describe("One or more questions (max 5)"),
		}),
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId: string, params: AskParams) {
			if (asked) {
				return {
					content: [
						{
							type: "text",
							text: "Error: one ask per turn. The first ask is already waiting for the user's answer. End your turn; ask the remaining questions after the answer arrives.",
						},
					],
					details: {},
				};
			}
			const questions = params.questions;
			if (!Array.isArray(questions) || questions.length === 0) {
				return {
					content: [
						{ type: "text", text: "Error: questions must not be empty." },
					],
					details: {},
				};
			}
			asked = true;
			return {
				content: [
					{
						type: "text",
						text: "Your question was delivered to the tracker user. The run is paused; the answer arrives as the next user message. End your turn now WITHOUT calling report_outcome (the tracker knows you are waiting).",
					},
				],
				details: {},
			};
		},
	});

	// Names the session for the board card. omp's auto titler can take ~30 minutes or never fire,
	// so the work prompt asks for one rename call per turn; this tool keeps an existing name.
	pi.registerTool({
		name: "rename",
		label: "Rename session",
		description:
			"Give this session its board title. Call it once per turn. When a name is already set " +
			"(omp auto-title or an earlier call), it is kept and the tool does nothing. " +
			"title: 3-8 words naming the task's goal; no branch names, no filler.",
		parameters: z.object({
			title: z.string().describe("Short title for the session, 3-8 words"),
		}),
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId: string, params: RenameParams) {
			const current = await pi.getSessionName();
			if (typeof current === "string" && current.trim() !== "") {
				return {
					content: [
						{
							type: "text",
							text: `Session already named "${current}". Kept it; nothing to do.`,
						},
					],
					details: {},
				};
			}
			const title = (typeof params.title === "string" ? params.title : "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 80);
			if (title === "") {
				return {
					content: [
						{ type: "text", text: "Error: title must be a non-empty string." },
					],
					details: {},
				};
			}
			await pi.setSessionName(title);
			return {
				content: [{ type: "text", text: `Session renamed to "${title}".` }],
				details: {},
			};
		},
	});

	// Files a new card on the board through the tracker's own HTTP API. The runner injects the
	// coordinates (OTTR_BOARD_URL/OTTR_PROJECT/OTTR_TASK_ID) and the board's boot token
	// (OTTR_BOARD_TOKEN) into every task session, so the agent never has to discover the board
	// URL; children link back to the filing card automatically. Loopback needs no token; the
	// compose address (http://ottr:<port>) files cards only with it.
	// ponytail: a public-host board demands a session/API key this tool does not carry; the HTTP
	// status surfaces honestly.
	pi.registerTool({
		name: "create_task",
		label: "Create task",
		description:
			"File a new task card on the tracker board. One call = one card; call it repeatedly to split a " +
			"large task into linked sub-tasks (each card links back to this one as a follow-up). The scheduler " +
			"starts filed cards automatically, in parallel up to the project's max-parallel setting. Pass dependsOn with the ids of cards that must be done first to run cards in sequence (e.g. milestones); a dependent card stays queued until they are done. Every card " +
			"runs in a FRESH session with its own worktree: its prompt must be fully self-contained (goal, " +
			"target paths, constraints, acceptance criteria) — the new agent sees nothing of this session. " +
			"A turn that must wait for its new card (e.g. a merge turn blocked on a fix) reports that id in report_outcome's dependsOn instead of stopping at needs_you.",
		parameters: z.object({
			prompt: z
				.string()
				.describe(
					"Self-contained task text for the new card, 1-20000 characters",
				),
			model: z
				.string()
				.optional()
				.describe("Model override for the new card (provider/model)"),
			dependsOn: z
				.array(z.string())
				.optional()
				.describe(
					"Task ids of cards that must be done before this card starts; the scheduler holds the new card in the queue until then. File dependency cards first to learn their ids.",
				),
		}),
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId: string, params: CreateTaskParams) {
			const base = (process.env.OTTR_BOARD_URL ?? "").trim();
			const project = (process.env.OTTR_PROJECT ?? "").trim();
			const parent = (process.env.OTTR_TASK_ID ?? "").trim();
			const token = (process.env.OTTR_BOARD_TOKEN ?? "").trim();
			if (base === "" || project === "" || parent === "") {
				return textResult(
					"Error: create_task is unavailable — the tracker did not inject OTTR_BOARD_URL/OTTR_PROJECT/OTTR_TASK_ID into this session. File no cards; finish the turn and report the blocker.",
				);
			}
			const prompt =
				typeof params.prompt === "string" ? params.prompt.trim() : "";
			if (prompt === "" || prompt.length > 20000) {
				return textResult("Error: prompt must be 1-20000 characters.");
			}
			const model = typeof params.model === "string" ? params.model.trim() : "";
			const dependsOn = parseDependsOn(params);
			const filed = await fileCard({
				base,
				project,
				parent,
				token,
				prompt,
				model,
				dependsOn,
			});
			if (!filed.ok) return textResult(filed.text);
			return textResult(
				`Card ${filed.id} filed and linked to this task. It starts when the scheduler picks it up. File more cards or continue; report_outcome as usual when done.`,
			);
		},
	});

	// Proposal tools the runner reads from the event stream and files as cards when the run
	// ends. Retro (OTTR_RETRO=1): ONE proposal, filed as a held card. Review (OTTR_REVIEW=1):
	// one call per finding with a rank and an optional confirmed security severity; Ottr checks
	// the best ones with a second model and files the kept ones. Both run without board env, so
	// they are local-only. The description texts must match src/prompts.ts
	// (PROPOSE_TOOL_DESCRIPTION / REVIEW_PROPOSE_TOOL_DESCRIPTION); the extension loads
	// standalone, so they are inlined here.
	const retroMode = process.env.OTTR_RETRO === "1";
	const reviewMode = process.env.OTTR_REVIEW === "1";
	if (retroMode || reviewMode) {
		pi.registerTool({
			name: "propose_task",
			label: "Propose task",
			description: retroMode
				? "Propose ONE improvement task from this retro. Ottr files it as a held card when the retro ends: it starts only after the user accepts it. prompt: the self-contained task text. model: optional model for the task."
				: 'Record ONE finding of this review; call it once per finding, as many times as you need. After the review ends, Ottr ranks the findings, checks the best ones with a second model, and files the ones that pass as cards (at most 10, plus confirmed high or critical security findings). prompt: the self-contained finding text (what is wrong, the evidence, the effect, the fix). rank: the finding\'s importance, 1 = most important. security: "critical" or "high" for a confirmed security finding of that severity, else leave it out.',
			parameters: z.object(
				retroMode
					? {
							prompt: z
								.string()
								.describe(
									"Self-contained task text for the new card, 1-20000 characters",
								),
							model: z
								.string()
								.optional()
								.describe("Model override for the task (provider/model)"),
						}
					: {
							prompt: z
								.string()
								.describe(
									"Self-contained finding text: what is wrong, the evidence, the effect, the fix (1-20000 characters)",
								),
							model: z
								.string()
								.optional()
								.describe(
									"Model override for the finding's card (provider/model)",
								),
							rank: z
								.number()
								.optional()
								.describe("The finding's importance, 1 = most important"),
							security: z
								.enum(["critical", "high"])
								.optional()
								.describe(
									"Set only for a confirmed security finding of that severity",
								),
						},
			),
			loadMode: "essential",
			approval: "read",
			async execute(_toolCallId: string, params: CreateTaskParams) {
				if (retroMode && proposed) {
					return textResult(
						"Error: propose_task was already called in this retro; only one proposal is allowed.",
					);
				}
				const error = proposeValidationError(params, reviewMode);
				if (error !== null) return textResult(error);
				if (retroMode) proposed = true;
				return textResult(
					retroMode
						? "Recorded. Ottr files it as a held card when this retro ends."
						: "Recorded. Ottr checks the best findings with a second model when this review ends, and files the ones that pass as cards.",
				);
			},
		});
	}

	pi.on("session_stop", () => {
		if (asked && !reported) return undefined;
		if (!reported && blocks < 2) {
			blocks += 1;
			return {
				decision: "block",
				reason:
					"Before finishing, call the report_outcome tool (status ready | answered | integrated | needs_you, " +
					"a 1-3 line summary, optional details and question). The task tracker reads it to decide what happens next.",
			};
		}
		return undefined;
	});
}

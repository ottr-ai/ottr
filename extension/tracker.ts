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
	project?: unknown;
	rank?: unknown;
	security?: unknown;
	whatChanges?: unknown;
	why?: unknown;
	gain?: unknown;
	risk?: unknown;
	check?: unknown;
}
interface TrendingParams {
	repo?: unknown;
	title?: unknown;
	prompt?: unknown;
	verdict?: unknown;
	reason?: unknown;
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

// The prompt text: 1-20000 trimmed characters.
function promptValidationError(params: CreateTaskParams): string | null {
	const prompt = trimmed(params.prompt);
	if (prompt === "" || prompt.length > 20000) {
		return "Error: prompt must be a string of 1-20000 characters (trimmed).";
	}
	return null;
}

// The model name: non-empty when given.
function modelValidationError(params: CreateTaskParams): string | null {
	const model = trimmed(params.model);
	if (params.model !== undefined && model === "") {
		return "Error: model must be a non-empty string when given.";
	}
	return null;
}

// The five summary fields: 1-400 trimmed characters each, when given.
function summaryFieldsValidationError(params: CreateTaskParams): string | null {
	const summaryFields = [
		"whatChanges",
		"why",
		"gain",
		"risk",
		"check",
	] as const;
	for (const field of summaryFields) {
		if (params[field] === undefined) continue;
		const value = trimmed(params[field]);
		if (value === "" || value.length > 400) {
			return `Error: ${field} must be a string of 1-400 characters (trimmed) when given.`;
		}
	}
	return null;
}

// The rank: an integer of 1 or more, checked only in review mode.
function rankValidationError(
	params: CreateTaskParams,
	reviewMode: boolean,
): string | null {
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

// Shared validation of propose_task params; returns the error text or null.
// The prompt/model messages keep the propose_task wording (not create_task's).
function proposeValidationError(
	params: CreateTaskParams,
	reviewMode: boolean,
): string | null {
	return (
		promptValidationError(params) ??
		modelValidationError(params) ??
		summaryFieldsValidationError(params) ??
		rankValidationError(params, reviewMode)
	);
}

// The tracker pins review session names via env so every review run gets the same board title.
// Read per call like runGitSecrets: the env is fixed for the run, but a load-time capture leaks
// an ambient OTTR_SESSION_NAME into instances loaded before a test cleared it (OTTR-499).
const pinnedName = (): string => (process.env.OTTR_SESSION_NAME ?? "").trim();

// The report_outcome session-title gate: a card without a session title shows the prompt's
// first line. A run with a pinned name (OTTR_SESSION_NAME) applies that name here instead of
// refusing, so the outcome records at once. Without a pin, refuse once and send the agent to
// rename; the next call records even when the name is still missing, so an agent that ignores
// the hint keeps its outcome. Retro and trending scout runs have no rename tool, so they never
// refuse; a getSessionName failure records rather than blocks the outcome.
async function ensureNamedSession(pi: Pi): Promise<void> {
	if (refusedOnce) return;
	if (process.env.OTTR_RETRO === "1") return;
	if (process.env.OTTR_TRENDING === "1") return;
	let unnamed = true;
	try {
		const name = await pi.getSessionName();
		unnamed = typeof name !== "string" || name.trim() === "";
	} catch {
		unnamed = false;
	}
	if (unnamed && pinnedName() !== "") {
		try {
			await pi.setSessionName(pinnedName());
		} catch {
			// A failed name must not lose the outcome; record anyway.
		}
		return;
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
function scrubArray(
	v: readonly unknown[],
	scrub: (x: unknown) => unknown,
): unknown {
	const out = v.map((x) => scrub(x));
	return out.some((x, i) => x !== v[i]) ? out : v;
}
function scrubRecord(
	v: Record<string, unknown>,
	scrub: (x: unknown) => unknown,
): unknown {
	const entries = Object.entries(v);
	const out = entries.map(([k, x]) => [k, scrub(x)] as const);
	return out.some(([, x], i) => x !== entries[i]?.[1])
		? Object.fromEntries(out)
		: v;
}

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

const trimmed = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// The board coordinates and token the runner injects into every task session.
interface BoardEnv {
	base: string;
	project: string;
	parent: string;
	token: string;
}

function requireBoardEnv(tool = "create_task"): { error: string } | BoardEnv {
	const base = (process.env.OTTR_BOARD_URL ?? "").trim();
	const project = (process.env.OTTR_PROJECT ?? "").trim();
	const parent = (process.env.OTTR_TASK_ID ?? "").trim();
	const token = (process.env.OTTR_BOARD_TOKEN ?? "").trim();
	if (base === "" || project === "" || parent === "") {
		return {
			error: `Error: ${tool} is unavailable — the tracker did not inject OTTR_BOARD_URL/OTTR_PROJECT/OTTR_TASK_ID into this session. File no cards; finish the turn and report the blocker.`,
		};
	}
	return { base, project, parent, token };
}

// A GitHub `owner/repo`: the trending scout's tools name repos this way.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// POST one trending verdict to the board (src/app.ts /trending/verdicts, the board token like
// create_task) with this run's card as the scout. Returns the filed proposal's id (null for
// no_fit and deferred) or a ready-to-show error text; the tool's own validation runs first.
async function postVerdict(
	tool: string,
	body: {
		repo: string;
		verdict: "filed" | "no_fit" | "deferred";
		reason: string;
		prompt?: string;
		title?: string;
	},
): Promise<{ ok: true; id: string | null } | { ok: false; text: string }> {
	const env = requireBoardEnv(tool);
	if ("error" in env) return { ok: false, text: env.error };
	const { base, project, parent, token } = env;
	let res: Response;
	try {
		res = await fetch(
			`${base}/api/projects/${encodeURIComponent(project)}/trending/verdicts`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: base,
					...(token !== "" ? { "x-board-token": token } : {}),
				},
				body: JSON.stringify({ scoutId: parent, ...body }),
			},
		);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			text: `Error: the board at ${base} is unreachable (${why}). Record no more verdicts; report the blocker.`,
		};
	}
	const out = (await res.json().catch(() => null)) as {
		ok?: unknown;
		id?: unknown;
		error?: unknown;
	} | null;
	if (!res.ok || out === null || out.ok !== true) {
		const why =
			out !== null && typeof out.error === "string" ? ` — ${out.error}` : "";
		return {
			ok: false,
			text: `Error: ${body.verdict === "filed" ? "proposal not filed" : "verdict not recorded"} (HTTP ${res.status}${why}).`,
		};
	}
	return { ok: true, id: typeof out.id === "string" ? out.id : null };
}

// A normalized propose_repo call: the checked repo, title and prompt, or the error text.
type ProposeRepoDraft =
	| { ok: false; text: string }
	| { ok: true; repo: string; title: string; prompt: string };

// Normalize and validate one propose_repo call: repo as owner/repo, an optional title of
// 1-200 trimmed characters and a prompt of 1-20000. Returns the error text or the draft.
function proposeRepoDraft(params: TrendingParams): ProposeRepoDraft {
	const repo = trimmed(params.repo);
	if (!REPO_RE.test(repo))
		return { ok: false, text: "Error: repo must be owner/repo." };
	const title = trimmed(params.title);
	if (params.title !== undefined && (title === "" || title.length > 200))
		return {
			ok: false,
			text: "Error: title must be a string of 1-200 characters (trimmed) when given.",
		};
	const prompt = trimmed(params.prompt);
	if (prompt === "" || prompt.length > 20000)
		return {
			ok: false,
			text: "Error: prompt must be a string of 1-20000 characters (trimmed).",
		};
	return { ok: true, repo, title, prompt };
}

// A prompt's first line, trimmed: the fallback headline of an untitled proposal.
function firstLine(prompt: string): string {
	return (prompt.split("\n")[0] ?? "").trim();
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
			if (Array.isArray(v)) return scrubArray(v, scrub);
			if (typeof v === "object" && v !== null && v.constructor === Object)
				return scrubRecord(v as Record<string, unknown>, scrub);
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
	// The first macrotask is still too early: omp hands extensions a stub runtime whose
	// action methods throw until its session initialize() patches them, seconds later in
	// real runs (OTTR-413: ~23 s), so the one-shot attempt always died in the catch below.
	// Retry until the methods answer or the cap; a lapsed run gets its pin at report_outcome.
	if (pinnedName() !== "") {
		setTimeout(() => {
			void (async () => {
				for (let attempt = 0; attempt < 60; attempt++) {
					try {
						const current = await pi.getSessionName();
						if (typeof current !== "string" || current.trim() === "")
							await pi.setSessionName(pinnedName());
						return;
					} catch {
						await new Promise((r) => setTimeout(r, 500));
					}
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
			await ensureNamedSession(pi);
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
			"A turn that must wait for its new card (e.g. a merge turn blocked on a fix) reports that id in report_outcome's dependsOn instead of stopping at needs_you. " +
			"project: file the card in another project on the board; omit to file in this one.",
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
			project: z
				.string()
				.optional()
				.describe(
					"Project name on the board to file the card in; omit to file in this task's own project",
				),
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
			const env = requireBoardEnv();
			if ("error" in env) return textResult(env.error);
			const { base, project, parent, token } = env;
			const prompt = trimmed(params.prompt);
			if (prompt === "" || prompt.length > 20000) {
				return textResult("Error: prompt must be 1-20000 characters.");
			}
			const dependsOn = parseDependsOn(params);
			const target = trimmed(params.project);
			if (params.project !== undefined && target === "") {
				return textResult(
					"Error: project must be a non-empty string when given.",
				);
			}
			const filed = await fileCard({
				base,
				project: target === "" ? project : target,
				parent,
				token,
				prompt,
				model: trimmed(params.model),
				dependsOn,
			});
			if (!filed.ok) return textResult(filed.text);
			if (target !== "" && target !== project)
				return textResult(
					`Card ${filed.id} filed in project ${target} and linked to this task. It starts when the scheduler picks it up. File more cards or continue; report_outcome as usual when done.`,
				);
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
				? "Propose ONE improvement task from this retro. Ottr files it as a held card when the retro ends: it starts only after the user accepts it. prompt: the self-contained task text in this shape. Line 1: one plain sentence that says what changes and where, for example: Add 'summary is one line' to the ready and integrated prompts. No repo notes or meta text on line 1; this line becomes the card title. Then: Why: the evidence with card ids. Change: the exact edit; repo and path notes go here. Check: the acceptance test. Gain: the saving in concrete units. model: optional model for the task. summary: five short strings the board shows next to the prompt, each the same fact as its prompt part: whatChanges: the file or setting and the edit, in one sentence; why: the cause and the evidence, with the card ids; gain: the saving in concrete units; risk: what can break, or \"none found\"; check: how the result is verified."
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
							whatChanges: z
								.string()
								.optional()
								.describe(
									"The file or setting and the edit, in one sentence (1-400 characters)",
								),
							why: z
								.string()
								.optional()
								.describe(
									"The cause and the evidence, with the card ids (1-400 characters)",
								),
							gain: z
								.string()
								.optional()
								.describe("The saving in concrete units (1-400 characters)"),
							risk: z
								.string()
								.optional()
								.describe('What can break, or "none found" (1-400 characters)'),
							check: z
								.string()
								.optional()
								.describe("How the result is verified (1-400 characters)"),
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

	// The weekly trending scout (OTTR_TRENDING=1): its two verdict tools post straight to the
	// board, which files the proposal card, caps the proposals per scan and stores every
	// verdict. A refusal comes back as an Error: text, never a throw.
	if (process.env.OTTR_TRENDING === "1") {
		pi.registerTool({
			name: "propose_repo",
			label: "Propose repo",
			description:
				"File one trending repo as a backlog proposal card for this project; call it once per proposal, best first. " +
				"The board caps the proposals per scan and refuses the rest: record those with judge_repo as deferred. " +
				"repo: the trending repo as owner/repo. title: optional card title. " +
				"prompt: the whole proposal (header with repo link, license, stars and last push; fit category and concrete use; risks and cost; a self-contained draft task prompt).",
			parameters: z.object({
				repo: z.string().describe("The trending repo as owner/repo"),
				title: z
					.string()
					.optional()
					.describe(
						"Card title, at most 200 characters; omit to use the prompt's first line",
					),
				prompt: z
					.string()
					.describe("The whole proposal text, 1-20000 characters"),
			}),
			loadMode: "essential",
			approval: "read",
			async execute(_toolCallId: string, params: TrendingParams) {
				const draft = proposeRepoDraft(params);
				if (!draft.ok) return textResult(draft.text);
				const { repo, title, prompt } = draft;
				// The board stores a one-line reason with every verdict: a filed repo's is its
				// proposal's headline.
				const headline = title !== "" ? title : firstLine(prompt);
				const out = await postVerdict("propose_repo", {
					repo,
					verdict: "filed",
					reason: headline.slice(0, 500),
					prompt,
					...(title !== "" ? { title } : {}),
				});
				if (!out.ok) return textResult(out.text);
				return textResult(`Proposal ${out.id ?? "?"} filed for ${repo}.`);
			},
		});
		pi.registerTool({
			name: "judge_repo",
			label: "Judge repo",
			description:
				"Record your verdict on one trending repo you do not propose; call it once per such repo. " +
				"no_fit: it does not fit this project (final, later scans skip it). " +
				"deferred: it fits, but the proposals for this scan are used up (offered again next scan). " +
				"reason: one line.",
			parameters: z.object({
				repo: z.string().describe("The trending repo as owner/repo"),
				verdict: z
					.enum(["no_fit", "deferred"])
					.describe("no_fit (final) or deferred (offered again next scan)"),
				reason: z.string().describe("One-line reason, 1-500 characters"),
			}),
			loadMode: "essential",
			approval: "read",
			async execute(_toolCallId: string, params: TrendingParams) {
				const repo = trimmed(params.repo);
				if (!REPO_RE.test(repo))
					return textResult("Error: repo must be owner/repo.");
				const verdict = params.verdict;
				if (verdict !== "no_fit" && verdict !== "deferred")
					return textResult("Error: verdict must be no_fit or deferred.");
				const reason = trimmed(params.reason);
				if (reason === "" || reason.length > 500)
					return textResult(
						"Error: reason must be a string of 1-500 characters (trimmed).",
					);
				const out = await postVerdict("judge_repo", { repo, verdict, reason });
				if (!out.ok) return textResult(out.text);
				return textResult(`Recorded ${verdict} for ${repo}.`);
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

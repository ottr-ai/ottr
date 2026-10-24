// Compose memory proof: one omp turn inside a worker container over the real HTTP
// handoff, asserting one memory retain and one recall of the previous run's
// retain against the shared HOME store. Repeatable: each run recalls the
// previous run's pass word, retains a fresh one, and chains the state on the
// workspace volume; the first run on a fresh volume only seeds.
//
// Usage (repo root, compose stack up):
//   docker compose exec -T server bun - < scripts/compose-memory-proof.ts
// Optional env: PROOF_WORKER_URL (default http://worker-a:8787), PROOF_CWD
// (default /workspace/scratch), OTTR_WORKER_TOKEN (required, no default).

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const worker = process.env.PROOF_WORKER_URL ?? "http://worker-a:8787";
// No default: a proof that authenticated with a guessed token proves nothing.
if (
	process.env.OTTR_WORKER_TOKEN === undefined ||
	process.env.OTTR_WORKER_TOKEN === ""
)
	fail(
		"OTTR_WORKER_TOKEN is unset — refusing to run the proof with an unknown auth token",
	);
const token = process.env.OTTR_WORKER_TOKEN;
const cwd = process.env.PROOF_CWD ?? "/workspace/scratch";
const statePath = `${cwd}/.memory-proof-state.json`;

function fail(message: string): never {
	console.error(`FAIL ${message}`);
	process.exit(1);
}

const prevState = (() => {
	try {
		return JSON.parse(readFileSync(statePath, "utf8")) as {
			word?: string;
			round?: string;
		};
	} catch {
		return {}; // fresh volume: no proof has ever run here
	}
})();
const prev = prevState.word ?? null;
const prevRound = prevState.round ?? null;
const round = `r${Date.now()}`;
const word = `w${Date.now()}${process.pid % 10}`;
const startedAt = Date.now();

const recallAsk = prevRound
	? `2. Recall from long-term memory: find the memory "ottr compose memory proof round ${prevRound}" and read its pass word.`
	: '2. Recall from long-term memory: search for "ottr compose memory proof" and read the pass word a previous session stored.';

const prompt = [
	"Memory proof turn. Make exactly two memory calls, then report:",
	`1. Retain in long-term memory: "ottr compose memory proof round ${round}: the pass word is ${word}."`,
	recallAsk,
	"Then reply with exactly two lines and nothing else:",
	`RETAINED=${word}`,
	"RECALLED=<the recalled pass word, or NONE if memory had none>",
].join("\n");

type AnyRec = Record<string, unknown>;

/** Joined text of all {type:"text"} parts of an omp content array (same shape as runner.textParts). */
const textParts = (content: unknown): string =>
	Array.isArray(content)
		? content
				.filter(
					(p): p is { type: "text"; text: string } =>
						typeof p === "object" &&
						p !== null &&
						(p as AnyRec).type === "text" &&
						typeof (p as AnyRec).text === "string",
				)
				.map((p) => p.text)
				.join("")
		: "";

// The request is the WorkerRequest wire shape (src/workers.ts); the argv mirrors
// buildOmpArgs for a fresh turn.
const res = await fetch(`${worker}/run`, {
	method: "POST",
	headers: { "content-type": "application/json", "x-otwr-token": token },
	body: JSON.stringify({
		id: crypto.randomUUID(),
		argv: [
			"-p",
			"--mode",
			"json",
			"--session-dir",
			`${cwd}/.tasks/sessions`,
			"--extension",
			"/app/extension/tracker.ts",
		],
		cwd,
		stdin: prompt,
		env: {},
	}),
});
const { body } = res;
if (res.status !== 200 || !body)
	fail(`worker /run answered ${res.status} (healthz/token/mounts?)`);

let text = "";
let tools = "";
let exitCode: number | null = null;
let stderrTail = "";
let partial = "";
let done = false;
const decoder = new TextDecoder();
for await (const chunk of body) {
	partial += decoder.decode(chunk, { stream: true });
	for (;;) {
		const idx = partial.indexOf("\n");
		if (idx < 0) break;
		const line = partial.slice(0, idx);
		partial = partial.slice(idx + 1);
		if (!line.trim()) continue;
		let evt: AnyRec;
		try {
			evt = JSON.parse(line) as AnyRec;
		} catch {
			continue; // non-JSON stdout noise: the sentinel is what matters
		}
		if ("xdevWorkerDone" in evt) {
			const d = evt.xdevWorkerDone as {
				exitCode: number | null;
				stderrTail: string;
			};
			exitCode = d.exitCode;
			stderrTail = d.stderrTail;
			done = true;
			break;
		}
		if (evt.type === "message_update") {
			const ame = evt.assistantMessageEvent as AnyRec | undefined;
			if (ame?.type === "text_delta" && typeof ame.delta === "string")
				text += ame.delta;
		} else if (evt.type === "message_end") {
			const m = evt.message as AnyRec | undefined;
			// The final assistant message replaces the delta reconstruction (deltas + full
			// text would duplicate the reply and glue regex captures).
			if (m?.role === "assistant") text = textParts(m.content);
			for (const part of Array.isArray(m?.content) ? m.content : [])
				if ((part as AnyRec).type === "toolCall")
					tools += ` ${(part as AnyRec).name ?? "?"}`;
		} else if (
			evt.type === "tool_execution_start" &&
			typeof evt.toolName === "string"
		) {
			tools += ` ${evt.toolName}`;
		}
	}
	if (done) break;
}

if (exitCode !== 0)
	fail(`turn exited ${exitCode}; stderr tail: ${stderrTail.slice(-400)}`);

// This turn's session files: both backends leave deterministic evidence here —
// mnemopi's retain tool call and hindsight's retain/recall round trips carry
// the round key and the previous word, and nothing else does (the prompt has
// the round key but never the previous word).
const sessionDir = `${cwd}/.tasks/sessions`;
let sessionText = "";
let sessionFile = "";
for (const name of readdirSync(sessionDir)) {
	const path = `${sessionDir}/${name}`;
	if (!name.endsWith(".jsonl") || statSync(path).mtimeMs < startedAt) continue;
	sessionText += readFileSync(path, "utf8");
	sessionFile = path;
}

// Retain: strongest artifact wins. Mnemopi mode: the local store's
// working_memory, written synchronously per session (`facts` extraction is an
// LLM step at dispose — it lags or skips, so it is displayed, not asserted).
// Hindsight mode: worker omp never writes the local store, so the evidence is
// the session files, which carry the retain call's round key. A store that
// exists but shows no row for this round (stale mnemopi volume) falls back to
// the session evidence instead of failing.
const storePath = "/root/.omp/agent/memories/mnemopi/mnemopi.db";
let stored = 0;
let factRows = 0;
let storeUsable = false;
try {
	const db = new Database(storePath, { readonly: true });
	stored =
		(
			db
				.prepare("select count(*) c from working_memory where content like ?")
				.get(`%${round}%`) as { c: number } | undefined
		)?.c ?? 0;
	factRows =
		(
			db
				.prepare("select count(*) c from facts where object like ?")
				// Mnemopi's fact extractor canonicalizes the fact to its core
				// sentence ("The pass word is <word>"), dropping the round
				// key — so match on the word itself.
				.get(`%${word}%`) as { c: number } | undefined
		)?.c ?? 0;
	db.close();
	storeUsable = stored > 0;
} catch {
	storeUsable = false; // no local store (hindsight-only stack): handled below
}
const sessionHasRetain = sessionText.includes(round);
if (!storeUsable && !sessionHasRetain)
	fail(
		`neither the local store nor this turn's session files carry the retain round key ${round} — retain never happened (final text: ${text.slice(-200)})`,
	);
const retainVia = storeUsable
	? `store (working_memory rows: ${stored}, facts rows: ${factRows})`
	: "session files (hindsight mode)";

// Recall: the previous run's pass word may only enter this turn's session files
// through the memory backend (the prompt carries the round key, never the word).
if (prev !== null && !sessionText.includes(prev))
	fail(
		`no session file from this turn mentions the previous pass word ${prev} — recall returned nothing (final text: ${text.slice(-200)})`,
	);

writeFileSync(statePath, `${JSON.stringify({ round, word })}\n`);
console.log(
	`PASS worker=${worker} retained=${word} via ${retainVia} recalled=${prev ?? "seed"} via ${sessionFile || "n/a"} tools:${tools || " NONE SEEN"}`,
);

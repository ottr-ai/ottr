// Throwaway e2e proof for steering: fake omp shim + scratch git project + real server.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { platform } from "../src/platform/index.ts";
import { RULES_INTERVIEW_MARKER } from "../src/prompts.ts";

const WT = resolve(import.meta.dir, "..");
const SHIM_EXE = `omp${process.platform === "win32" ? ".exe" : ""}`;
const SCRATCH = join(tmpdir(), `ott-steer-${Date.now()}`);
const PORT = 4700 + (process.pid % 200);
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(SCRATCH, "roots"), { recursive: true });
mkdirSync(join(SCRATCH, "bin"), { recursive: true });

// Fake omp: logs argv+stdin, then answers by invocation kind, matching the server's real omp
// calls: `auth-gateway stdio` (the prepare phase's title generation) gets one chat completion;
// other non-agent calls (the `usage --json` quota probe) exit 0 quietly; an agent run (-p) emits
// a session event, saves the session file like real omp, stays alive 6s and exits 0 without
// agent_end (background-wait) — except from the third agent run on, where it ends terminally so
// a task can settle and steer-after-settle can be proven.
writeFileSync(
	join(SCRATCH, "shim.js"),
	`
const fs = require("node:fs");
const log = process.env.OMP_SHIM_LOG;
const countFile = process.env.OMP_SHIM_COUNT;
const exitLog = () => fs.appendFileSync(log, JSON.stringify({ t: Date.now(), ev: "exit" }) + "\\n");
const argv = process.argv.slice(1);
fs.appendFileSync(log, JSON.stringify({ t: Date.now(), ev: "start", argv, stdin: fs.readFileSync(0, "utf8") }) + "\\n");
if (argv.includes("auth-gateway")) {
  process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
  process.stdout.write(JSON.stringify({ id: 1, status: 200, body: { choices: [{ message: { content: "steering flow proof" } }] } }) + "\\n");
  exitLog();
} else if (!argv.includes("-p")) {
  exitLog();
} else {
  let count = 0;
  try { count = Number(fs.readFileSync(countFile, "utf8").trim() || 0); } catch {}
  count += 1;
  fs.writeFileSync(countFile, String(count));
  const dir = process.argv[process.argv.indexOf("--session-dir") + 1];
  fs.writeFileSync(dir + "/1_sess-deadbeef.jsonl", "{}\\n");
  process.stdout.write(JSON.stringify({ type: "session", id: "sess-deadbeef" }) + "\\n");
  if (count >= 3) {
    process.stdout.write(JSON.stringify({ type: "agent_end", isTerminal: true, messages: [] }) + "\\n");
    exitLog();
  } else {
    setTimeout(exitLog, 6000);
  }
}
`,
);
const $ = Bun.$;
await $`bun build --compile ${join(SCRATCH, "shim.js")} --outfile ${join(SCRATCH, "bin", SHIM_EXE)}`.quiet();

const server = spawn("bun", ["run", "src/server.ts"], {
	cwd: WT,
	env: {
		...process.env,
		PORT: String(PORT),
		OMP_TRACKER_ROOTS: join(SCRATCH, "roots"),
		OTTR_STATE_DIR: join(SCRATCH, "state"),
		OMP_SHIM_LOG: join(SCRATCH, "shim.log"),
		OMP_SHIM_COUNT: join(SCRATCH, "shim-count"),
		PATH: `${join(SCRATCH, "bin")}${delimiter}${process.env.PATH}`,
	},
	stdio: ["ignore", "pipe", "pipe"],
});
const srvLog = [];
server.stdout.on("data", (c) => srvLog.push(c.toString()));
server.stderr.on("data", (c) => srvLog.push(c.toString()));
const BASE = `http://127.0.0.1:${PORT}`;
const post = (p, body) =>
	fetch(BASE + p, {
		method: "POST",
		headers: { "content-type": "application/json", origin: BASE },
		body: JSON.stringify(body),
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, extra = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) fails++;
};

try {
	for (let i = 0; i < 40 && !srvLog.join("").includes("Ottr on http"); i++)
		await sleep(250);
	ok("server up", srvLog.join("").includes("Ottr on http"));

	// Register by name: addProject creates and git-inits the folder under the tracker root.
	let r = await post("/api/projects", { name: "demo" });
	const reg = await r.json();
	ok(
		"project registered",
		r.status === 200 && reg.project?.name === "demo",
		`${r.status} ${JSON.stringify(reg.error ?? reg.project?.name)}`,
	);

	// The scheduler holds every task of a rules-less project, so give the project its AGENTS.md
	// and cancel the interview card that registration queued (force: it may have started).
	writeFileSync(
		join(SCRATCH, "roots", "demo", "AGENTS.md"),
		"# demo rules\nWork turn: report_outcome ready. Merge turn: report_outcome integrated.\n",
	);
	await $`git -C ${join(SCRATCH, "roots", "demo")} add -A`.quiet();
	await $`git -C ${join(SCRATCH, "roots", "demo")} -c user.name=t -c user.email=t@t commit -m init`.quiet();
	const state0 = await (await fetch(`${BASE}/api/state`)).json();
	for (const it of state0.tasks.filter((x) =>
		x.prompt?.startsWith(RULES_INTERVIEW_MARKER),
	)) {
		r = await post(`/api/projects/demo/tasks/${it.id}/cancel`, {
			force: true,
		});
		const c = await r.json();
		ok(
			"rules interview cancelled",
			r.status === 200 && c.ok === true,
			r.status,
		);
	}

	r = await post("/api/projects/demo/tasks", { prompt: "demo steering task" });
	const created = await r.json();
	ok(
		"task created",
		r.status === 200 && typeof created.id === "string",
		r.status,
	);
	const id = created.id;
	const stateUrl = `/api/state`;

	// wait until running
	let t = null;
	for (let i = 0; i < 120; i++) {
		t = (await (await fetch(BASE + stateUrl)).json()).tasks.find(
			(x) => x.id === id,
		);
		if (t?.state === "running") break;
		await sleep(500);
	}
	ok("turn 1 running", t?.state === "running", t?.state);

	// Steer only once the omp process is actually up (session event received): the pre-spawn
	// window is covered by the second task below.
	for (let i = 0; i < 120; i++) {
		t = (await (await fetch(BASE + stateUrl)).json()).tasks.find(
			(x) => x.id === id,
		);
		if (t?.sessionId !== null && t?.sessionId !== undefined) break;
		await sleep(250);
	}
	ok("omp spawned", !!t?.sessionId, t?.sessionId);

	r = await post(`/api/projects/demo/tasks/${id}/steer`, { text: "STEER-ME" });
	let j = await r.json();
	ok(
		"steer 1 accepted",
		r.status === 200 && j.pendingPrompt === "STEER-ME",
		`${r.status} ${JSON.stringify(j.pendingPrompt)}`,
	);

	r = await post(`/api/projects/demo/tasks/${id}/steer`, { text: "STEER-TWO" });
	j = await r.json();
	ok(
		"steer 2 appended",
		r.status === 200 && j.pendingPrompt === "STEER-ME\n\nSTEER-TWO",
		JSON.stringify(j.pendingPrompt),
	);

	r = await post(`/api/projects/demo/tasks/${id}/steer`, { text: "   " });
	ok("blank steer rejected", r.status === 400, r.status);

	// Steer with a pasted image: the endpoint saves it and queues it with the next turn.
	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
	r = await post(`/api/projects/demo/tasks/${id}/steer`, {
		text: "STEER-IMG",
		images: [png],
	});
	j = await r.json();
	ok(
		"steer with image accepted",
		r.status === 200 && j.pendingImages?.length === 1,
		`${r.status} ${JSON.stringify(j.pendingImages ?? j.error)}`,
	);
	r = await fetch(
		`${BASE}/api/projects/demo/tasks/${id}/images/${j.pendingImages?.[0]}`,
	);
	const got = Buffer.from(await r.arrayBuffer());
	ok(
		"steered image served back",
		r.status === 200 && got.toString("base64") === png,
		`${r.status} ${got.length}B`,
	);
	r = await post(`/api/projects/demo/tasks/${id}/steer`, {
		text: "BAD-IMG",
		images: ["zzz"],
	});
	ok("bad image rejected", r.status === 400, r.status);

	// Picture-only steer: no text at all — queues a "." reply turn so the next turn carries just the image.
	r = await post(`/api/projects/demo/tasks/${id}/steer`, {
		text: "",
		images: [png],
	});
	j = await r.json();
	ok(
		"picture-only steer accepted",
		r.status === 200 &&
			j.pendingPrompt?.endsWith("\n\n.") &&
			j.pendingImages?.length === 2,
		`${r.status} ${JSON.stringify(j.pendingPrompt ?? j.error)}`,
	);

	// Second task: steer immediately after create, before the omp spawn — the fresh-read build
	// must fold it into turn 1 as a note.
	r = await post("/api/projects/demo/tasks", { prompt: "early steering task" });
	const early = await r.json();
	await post(`/api/projects/demo/tasks/${early.id}/steer`, {
		text: "STEER-EARLY",
	});
	let earlySession = null;
	for (let i = 0; i < 120 && earlySession === null; i++) {
		const et = (await (await fetch(BASE + stateUrl)).json()).tasks.find(
			(x) => x.id === early.id,
		);
		earlySession = et?.sessionId ?? null;
		await sleep(250);
	}
	ok("early task spawned", earlySession !== null, earlySession);

	// Turn 2 resumes the session, delivers the steering and ends terminally, so the task settles.
	// A run's log line can lag the running state (the shim logs after stdin EOF), so poll for both.
	const readRuns = () => {
		try {
			return readFileSync(join(SCRATCH, "shim.log"), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
				.filter((e) => e.ev === "start");
		} catch {
			return [];
		}
	};
	let turns = [];
	let resumed = null;
	for (let i = 0; i < 120; i++) {
		const nt = await (
			await fetch(`${BASE}/api/projects/demo/tasks/${id}`)
		).json();
		t = nt; // keep the snapshot fresh for failure dumps
		turns = nt?.turns ?? [];
		resumed = readRuns().find((e) => e.argv.includes("--resume")) ?? null;
		const settled = nt.state === "done" || nt.state === "needs_you";
		if (settled && resumed !== null) break;
		await sleep(500);
	}
	// The shim never calls report_outcome, so a terminal turn lands needs_you; a real agent would
	// settle done. Either way the task has left the steerable states.
	ok(
		"turn 2 fired and settled the task",
		turns.length >= 2 && (t?.state === "done" || t?.state === "needs_you"),
		`turns=${turns.length} state=${t?.state} stage=${t?.stage}`,
	);
	ok(
		"turn 2 consumed pending images",
		t?.pendingPrompt === null && t?.pendingImages?.length === 0,
		JSON.stringify({ p: t?.pendingPrompt, i: t?.pendingImages }),
	);
	if (fails > 0) {
		console.log(`== server log ==\n${srvLog.join("")}`);
		console.log(`== task ==\n${JSON.stringify(t, null, 2)}`);
	}

	const runs = readRuns();
	// Main turn 1 exits as a background-wait with the steering pending (queued to deliver it); the
	// early task's turn 1 slips in next and also background-waits; main turn 2 then resumes and ends
	// terminally. Pin the floor here, the specific runs below.
	ok(
		"shim ran for main and early tasks",
		runs.length >= 3,
		`runs=${runs.length}`,
	);
	ok(
		"turn 2 resumed session",
		!!resumed && resumed.argv.includes("sess-deadbeef"),
		resumed?.argv.join(" "),
	);
	ok(
		"turn 2 carries steering",
		!!resumed &&
			resumed.stdin.includes("STEER-ME") &&
			resumed.stdin.includes("STEER-TWO"),
		"",
	);
	ok(
		"turn 2 is a reply turn",
		!!resumed &&
			resumed.stdin.includes(
				"When you are done, call report_outcome before you finish",
			),
		"",
	);
	const earlyRun = runs.find((e) => e.stdin.startsWith("early steering task"));
	ok(
		"early steer folded into turn 1",
		!!earlyRun && earlyRun.stdin.includes("Note from the user: STEER-EARLY"),
		earlyRun?.stdin.slice(0, 120),
	);

	// The main task settled after the terminal turn 2, so steering it now must refuse.
	r = await post(`/api/projects/demo/tasks/${id}/steer`, { text: "late" });
	ok("steer after settle rejected", r.status === 409, r.status);
} finally {
	platform.killTree(server.pid);
	await sleep(500);
	console.log(
		fails === 0
			? "E2E PASS"
			: `E2E FAIL (${fails}) — scratch kept at ${SCRATCH}`,
	);
	if (fails === 0) rmSync(SCRATCH, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);

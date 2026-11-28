// OTTR-1259 UI proof: plants pinned research cards and a done inbox sweep run
// with recorded verdicts into a fresh demo board, then shoots the done lane's
// Inbox head (the Sweep inbox button) and the sweep card's drawer result table
// into shots/. `bun scripts/sweep-shot.ts` — reuses the card-shot machinery
// (shot-lib.ts, demo-data.ts), plants before the board boots, and exits once
// the shots verify. Needs a working Chrome (findChrome's search order); a
// container whose security profile blocks chrome_crashpad_handler cannot run
// it — run it on the host instead.
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sweepResult } from "../src/inboxSweep.ts";
import { newSweepState } from "../src/inboxSweepState.ts";
import {
	insertTaskRow,
	type ProjectSpec,
	type Spec,
	seedDemo,
	seedTaskEvents,
} from "./demo-data.ts";
import {
	Cdp,
	fail,
	findChrome,
	freePort,
	PNG_SIGNATURE,
	stopChildren,
	withTimeout,
} from "./shot-lib.ts";

const REPO = resolve(import.meta.dir, "..");
const SHOTS_DIR = resolve(REPO, "shots");
const WIDTH = 1440;
const HEIGHT = 900;
const LOCALE = "en-US";
const SETTLE_MS = 2500;
const PROJECT = "lumen";
const MIN = 60_000;
const HOUR = 60 * MIN;

/** insertTaskRow reads the project name for the task id prefix; the pool itself is unused. */
const LUMEN: ProjectSpec = {
	name: PROJECT,
	displayName: "Lumen",
	rules: true,
	tasks: [],
};

const now = Date.now();

const spec = (title: string): Spec => ({
	title,
	stage: "done",
	state: "idle",
	age: 2,
	work: 12,
	research: true,
});

const root = mkdtempSync(join(tmpdir(), "ottr-sweep-shot-"));
const stateDir = join(root, "state");
await seedDemo(root, false, stateDir);

const db = new Database(join(root, PROJECT, ".tasks", "tasks.db"));
const ids: Record<string, string | undefined> = {};
let n = 901;
// Fixture keys stay internal; the titles are what the shots render.
const TITLES: Record<string, string> = {
	targetDone: "Rate limit the public API endpoints",
	targetPartial: "Extract the retry helper out of src/http.ts",
	targetInfo: "Measure the queue depths for the record",
	targetPending: "Split the config loader into modules",
};
for (const key of [
	"targetDone",
	"targetPartial",
	"targetInfo",
	"targetPending",
]) {
	const seed = insertTaskRow(
		db,
		LUMEN,
		spec(TITLES[key] ?? key),
		n,
		now,
		`LUM-${n}`,
	);
	ids[key] = seed.id;
	seedTaskEvents(db, seed);
	n++;
}
const sweepSeed = insertTaskRow(
	db,
	LUMEN,
	spec("Inbox sweep for lumen"),
	n,
	now,
	`LUM-${n}`,
);
ids.sweep = sweepSeed.id;
seedTaskEvents(db, sweepSeed);

const report = (steps: string) =>
	`# Research: rate limiter\n\nFindings summary.\n\n## Recommended steps\n${steps}\n`;

const upd = db.query(
	"UPDATE tasks SET report = ?, research_steps = ?, updated_at = ? WHERE id = ?",
);
// Fresh targets predate the sweep stamp; the partial target changed after it
// (its row renders stale and its checkbox stays disabled).
upd.run(
	report("- add the limiter\n- document the env var"),
	"yes",
	now - 3 * HOUR,
	ids.targetDone!,
);
upd.run(
	report("- extract the retry helper\n- write the retry tests"),
	"yes",
	now - 30 * MIN,
	ids.targetPartial!,
);
upd.run(
	"# Research: queue depths\n\nPure info, no steps.",
	"no",
	now - 3 * HOUR,
	ids.targetInfo!,
);
upd.run(
	report("- split the config loader"),
	"yes",
	now - 3 * HOUR,
	ids.targetPending!,
);
db.query(
	"UPDATE tasks SET kind = 'sweep', prompt_author = 'board', prompt = ?, created_at = ?, updated_at = ?, done_at = ? WHERE id = ?",
).run(
	`Inbox sweep for ${PROJECT}`,
	now - 2 * HOUR,
	now - 2 * HOUR,
	now - HOUR,
	ids.sweep,
);

const findings: Array<[string, string]> = [
	[
		ids.targetDone!,
		"Sweep: #<id> done\nCommit 3f2a91c landed the limiter on main yesterday; the env var doc shipped with it.",
	],
	[
		ids.targetPartial!,
		`Sweep: #<id> partial\nThe retry helper exists in src/http.ts, but no test names it.\n--- card draft ---\nAdd retry tests for src/http.ts\n\nThe research report asks for tests around the retry helper. Change: add a unit test file covering the retry path. Check: the new test file passes and names the retry helper.`,
	],
	[
		ids.targetInfo!,
		"Sweep: #<id> info\nThe report recommends no steps; queue depths measured for the record.",
	],
];
for (const [target, prompt] of findings)
	db.query(
		"INSERT INTO review_findings (card_id, prompt, model, rank, security, created_at) VALUES (?, ?, NULL, NULL, NULL, ?)",
	).run(ids.sweep!, prompt.replaceAll("<id>", target!), now - 2 * HOUR + 1000);
const sweepState = newSweepState(findings.map(([target]) => target));
sweepState.verdicts = findings.map(([target, prompt]) => {
	const result = sweepResult(prompt.replaceAll("<id>", target));
	if (result === null) throw new Error("Invalid sweep fixture verdict");
	return result;
});
db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(
	`inbox-sweep:${ids.sweep}`,
	JSON.stringify(sweepState),
);

db.query(
	"INSERT INTO settings (key, value) VALUES ('next-task-num', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run(JSON.stringify(n + 1));
db.close();

// Older-than-every-plant stamp: the cards' doneAt sits two days back, so the
// stamp must predate it or the board counts them read and never pins them.
const gdb = new Database(join(stateDir, ".tasks", "tracker.db"));
gdb
	.query(
		"INSERT INTO kv (key, value) VALUES ('seen_done_since', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
	.run(JSON.stringify(now - 30 * 24 * HOUR));
gdb.close();

const chromePath = findChrome("sweep-shot");
const port = await freePort();

const board = Bun.spawn(["bun", "src/server.ts"], {
	cwd: REPO,
	env: {
		...process.env,
		PORT: String(port),
		NODE_ENV: "production",
		OTTR_DEMO: "1",
		OMP_TRACKER_ROOTS: root,
		OTTR_STATE_DIR: stateDir,
		OTTR_WORKERS_HOME: join(root, "workers-home"),
		OMP_TRACKER_MAX_TOTAL: "none",
		// The host's VM runner env must not reach the demo board: a runner URL
		// without its token refuses the boot (src/runner.ts).
		OTTR_VM_RUNNER_URL: "",
		OTTR_VM_RUNNER_TOKEN: "",
		OTTR_WORKER_TOKEN: "",
	},
	stdout: "ignore",
	stderr: "pipe",
});

const userDir = mkdtempSync(join(tmpdir(), "ottr-sweep-shot-chrome-"));
const chrome = Bun.spawn(
	[
		chromePath,
		"--headless=new",
		"--remote-debugging-port=0",
		`--user-data-dir=${userDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--hide-scrollbars",
		`--window-size=${WIDTH},${HEIGHT}`,
		...(typeof process.getuid === "function" &&
		(process.getuid() === 0 || process.env.OTTR_SHOT_NO_SANDBOX === "1")
			? ["--no-sandbox"]
			: []),
		"about:blank",
	],
	{ stdout: "ignore", stderr: "pipe" },
);

/** One capture run; every await below carries its own deadline. */
async function capture(): Promise<void> {
	const endpoint = await withTimeout(
		(async () => {
			const reader = chrome.stderr.getReader();
			const decoder = new TextDecoder();
			let text = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
				const hit = text.match(/DevTools listening on (ws:\/\/\S+)/);
				if (hit?.[1]) {
					reader.releaseLock();
					return hit[1];
				}
			}
			throw new Error("chrome printed no DevTools endpoint");
		})(),
		15_000,
		"the chrome endpoint line",
	);

	const client = new Cdp(new WebSocket(endpoint));
	await withTimeout(client.open(), 10_000, "CDP open");
	client.listen();

	let ready = false;
	for (let waited = 0; waited < 30_000; waited += 250) {
		if (board.exitCode !== null)
			throw new Error(`the board exited early (code ${board.exitCode})`);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/`, {
				signal: AbortSignal.timeout(1_000),
			});
			await res.body?.cancel();
			if (res.ok) {
				ready = true;
				break;
			}
		} catch {
			// not listening yet
		}
		await Bun.sleep(250);
	}
	if (!ready) throw new Error("the board did not become ready within 30 s");

	const created = await withTimeout(
		client.send("Target.createTarget", { url: "about:blank" }),
		10_000,
		"Target.createTarget",
	);
	const attached = await withTimeout(
		client.send("Target.attachToTarget", {
			targetId: created.targetId,
			flatten: true,
		}),
		10_000,
		"Target.attachToTarget",
	);
	const sessionId = attached.sessionId;
	if (typeof sessionId !== "string")
		throw new Error("chrome gave no page session");

	await client.send(
		"Emulation.setDeviceMetricsOverride",
		{ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
		sessionId,
	);
	await client.send(
		"Emulation.setEmulatedMedia",
		{ features: [{ name: "prefers-color-scheme", value: "dark" }] },
		sessionId,
	);
	await client.send(
		"Emulation.setLocaleOverride",
		{ locale: LOCALE },
		sessionId,
	);
	await client.send("Page.enable", undefined, sessionId);
	mkdirSync(SHOTS_DIR, { recursive: true });

	const views: Array<{ name: string; url: string; probe: string }> = [
		{
			name: "board",
			url: `http://127.0.0.1:${port}/projects/${PROJECT}`,
			// The done lane must carry the Inbox head and the sweep button.
			probe: "Sweep inbox",
		},
		{
			name: "drawer",
			url: `http://127.0.0.1:${port}/projects/${PROJECT}/tasks/${ids.sweep!}`,
			probe: "Apply selected",
		},
	];

	for (const view of views) {
		const load = client.waitEvent("Page.loadEventFired", sessionId);
		await withTimeout(
			client.send("Page.navigate", { url: view.url }, sessionId),
			15_000,
			`the ${view.name} navigate`,
		);
		await withTimeout(load, 30_000, `the ${view.name} load`);
		// Card entrance animations run about 2 s; let them finish before the shot.
		await Bun.sleep(SETTLE_MS);
		const probe = await withTimeout(
			client.send(
				"Runtime.evaluate",
				{
					returnByValue: true,
					expression: `document.body.innerText.includes(${JSON.stringify(view.probe)})`,
				},
				sessionId,
			),
			10_000,
			`the ${view.name} probe`,
		);
		const result = probe?.result;
		const value =
			result && typeof result === "object" && "value" in result
				? result.value
				: undefined;
		if (value !== true) {
			const text = await withTimeout(
				client.send(
					"Runtime.evaluate",
					{
						returnByValue: true,
						expression:
							"document.body.innerText.slice(0, 600).replace(/\\s+/g, ' ')",
					},
					sessionId,
				),
				10_000,
				`the ${view.name} text probe`,
			);
			const seen =
				text?.result &&
				typeof text.result === "object" &&
				"value" in text.result
					? text.result.value
					: "";
			fail(
				"sweep-shot",
				`the ${view.name} view misses "${view.probe}" — page reads: ${String(seen)}`,
			);
		}
		const shot = await withTimeout(
			client.send("Page.captureScreenshot", { format: "png" }, sessionId),
			15_000,
			`the ${view.name} screenshot`,
		);
		if (typeof shot.data !== "string")
			throw new Error("chrome returned no image data");
		const png = Buffer.from(shot.data, "base64");
		if (png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE)
			fail("sweep-shot", `${view.name}.png is not a PNG`);
		const file = resolve(SHOTS_DIR, `sweep-${view.name}.png`);
		await Bun.write(file, png);
		console.log(`sweep-shot: wrote ${file} (${png.length} bytes)`);
	}
}

let failure: Error | null = null;
const run = capture();
try {
	await withTimeout(run, 120_000, "the capture run");
} catch (err) {
	failure = err instanceof Error ? err : new Error(String(err));
} finally {
	await stopChildren(chrome, board);
}
// A deadline win can leave capture() pending; keep its rejection from crashing the exit.
run.catch(() => {});
if (failure) fail("sweep-shot", failure.message);
console.log(`sweep-shot: board and drawer written under ${SHOTS_DIR}`);
process.exit(0);

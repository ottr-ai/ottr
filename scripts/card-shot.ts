// Shoots named card views of a planted demo board into shots/ for UI work turns:
// `bun scripts/card-shot.ts --view card --pr 53`. The script plants fixture rows into a
// fresh state dir with direct sqlite (plant-then-boot: never a write against a live
// board's database, never the worktree .dev), boots its own board on a free port, and
// exits once the shots verify. Reuses the readme-screenshot machinery via shot-lib.ts;
// adds no npm dependency. Spec: docs/specs/card-shot.md.
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	insertEvent,
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
const WATCHDOG_MS = 90_000;
const MIN = 60_000;
const PROJECT = "lumen";

/** insertTaskRow reads the project name for the task id prefix; the pool itself is unused. */
const LUMEN: ProjectSpec = {
	name: PROJECT,
	displayName: "Lumen",
	rules: true,
	tasks: [],
};

/** The parked PR-mode card: stage merging, PR open, the board waiting for its merge. */
const PR_SPEC: Spec = {
	title: "Move the thermostat scheduler to the rules engine",
	// insertTaskRow writes the held-merge shape; the UPDATE below parks the card idle.
	stage: "merging",
	state: "queued",
	age: 0.2,
	work: 12,
};

/** The contrast card: a normal done card says "done" and carries no PR chip. */
const DONE_SPEC: Spec = {
	title: "Fix the sensor polling backoff on reconnect",
	stage: "done",
	state: "idle",
	age: 0.3,
	work: 9,
	merge: 2,
};

/** The ask card: a round parked on the operator, its question full of the long
 *  unbroken tokens (API paths, jq filters) that overflowed the drawer (OTTR-1257). */
const ASK_SPEC: Spec = {
	title:
		"Consolidate Velvarr code-scanning alerts into one card per error type",
	stage: "in_progress",
	state: "needs_you",
	age: 0.2,
	work: 12,
	needs:
		"Wants your answer: group the open alerts by rule, by tool, or as one card?",
	asked: {
		questions: [
			{
				q: "The Velvarr code-scanning poll reads repos/Skare69/velvarr/code-scanning/alerts/$n every turn and returns one blob per tool. List the 14 open alerts with jq -c '.[] | {number,created_at,tool:.tool.name,rule:.rule.id,most_recent_instance:.most_recent_instance.state}' — how should the board group them into cards?",
				options: [
					"One card per rule id (rule:.rule.id)",
					"One card per tool (tool:.tool.name)",
					"One card for all alerts",
				],
			},
			{
				q: "Dismiss the tool.name duplicates that LUME-4 already tracks?",
				options: ["Dismiss them", "Keep them open"],
			},
		],
	},
};

interface Planted {
	prId: string;
	doneId: string;
	askId: string;
}

const VIEWS = ["card", "done", "ask", "board", "settings-hindsight"];

function parseView(raw: string | undefined, usage: string, views: string[]) {
	if (raw === undefined || !VIEWS.includes(raw)) fail("card-shot", usage);
	if (!views.includes(raw)) views.push(raw);
}

function parseArgs(argv: string[]): { pr: number | null; views: string[] } {
	const usage =
		"usage: bun scripts/card-shot.ts --pr <number> [--view card|done|ask|board|settings-hindsight]...";
	let pr: number | null = null;
	const views: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--pr") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value <= 0) fail("card-shot", usage);
			pr = value;
		} else if (arg === "--view") {
			parseView(argv[++i], usage, views);
		} else {
			fail("card-shot", usage);
		}
	}
	if (views.length === 0) views.push("card");
	if (
		pr === null &&
		(views.includes("card") || views.includes("done") || views.includes("ask"))
	)
		fail("card-shot", "the card, done and ask views need --pr");
	return { pr, views };
}

/** Plant the fixture cards into the project database while no board holds it. */
function plantCards(root: string, pr: number): Planted {
	const db = new Database(join(root, PROJECT, ".tasks", "tasks.db"));
	try {
		const prefix = PROJECT.replaceAll(/[^A-Za-z0-9]/g, "")
			.toUpperCase()
			.slice(0, 4);
		const rows = db.query("SELECT id FROM tasks").all() as Array<{
			id: string;
		}>;
		const used = rows.flatMap((row) => {
			const hit = row.id.match(new RegExp(`^${prefix}-(\\d+)$`));
			return hit ? [Number(hit[1])] : [];
		});
		const next = (used.length > 0 ? Math.max(...used) : 0) + 1;
		const now = Date.now();

		// Explicit ids from the counted free numbers: LUMEN.tasks is empty, so
		// seedTaskId's index counting would derive LUME-1 for both cards and collide
		// with the pool's seeded rows (OTTR-776).
		const prSeed = insertTaskRow(
			db,
			LUMEN,
			PR_SPEC,
			next - 1,
			now,
			`${prefix}-${next}`,
		);
		seedTaskEvents(db, prSeed);
		// Parked PR mode (OTTR-552): the merge turn ended, the PR is open, the card
		// reads "PR #N open · waiting for merge" — never "done".
		db.run(
			"UPDATE tasks SET state = 'idle', queued_at = NULL, pr_number = ?, pr_url = ? WHERE id = ?",
			[pr, `https://github.com/ottr-ai/ottr/pull/${pr}`, prSeed.id],
		);
		insertEvent(
			db,
			prSeed.id,
			"state",
			"queued",
			"idle",
			prSeed.createdAt + 16 * MIN,
		);

		const doneSeed = insertTaskRow(
			db,
			LUMEN,
			DONE_SPEC,
			next,
			now,
			`${prefix}-${next + 1}`,
		);
		seedTaskEvents(db, doneSeed);
		// The ask round parks on the operator; the drawer's ask panel reads it.
		const askSeed = insertTaskRow(
			db,
			LUMEN,
			ASK_SPEC,
			next,
			now,
			`${prefix}-${next + 2}`,
		);
		seedTaskEvents(db, askSeed);
		// Cards created later on this board continue the id sequence.
		db.run(
			"INSERT INTO settings (key, value) VALUES ('next-task-num', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			[JSON.stringify(next + 3)],
		);
		// OTTR-826: the done drawer's Saved files section reads the card's kept
		// quarantine folder; plant two files and the captured uncommitted names for it.
		db.run("UPDATE tasks SET uncommitted_files = ? WHERE id = ?", [
			JSON.stringify(["mockup.html", "data/notes.csv"]),
			doneSeed.id,
		]);
		const savedDir = join(root, PROJECT, ".tasks", "quarantine", doneSeed.id);
		mkdirSync(join(savedDir, "data"), { recursive: true });
		writeFileSync(join(savedDir, "mockup.html"), "<h1>Backoff mock</h1>\n");
		writeFileSync(join(savedDir, "data", "notes.csv"), "t,ms\n0,250\n1,480\n");
		return { prId: prSeed.id, doneId: doneSeed.id, askId: askSeed.id };
	} finally {
		db.close();
	}
}

/** The board URL path each view name shoots; card and done open the card's drawer. */
function viewPath(name: string, planted: Planted | null): string {
	if (name === "board") return `/projects/${PROJECT}`;
	// Settings opens on its own path; the shot drives the scroll to the section.
	if (name === "settings-hindsight") return "/settings";
	if (planted === null) throw new Error(`the ${name} view needs --pr`);
	const id =
		name === "card"
			? planted.prId
			: name === "ask"
				? planted.askId
				: planted.doneId;
	return `/projects/${PROJECT}/tasks/${id}`;
}

function verifyPng(png: Buffer, file: string): void {
	if (png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
		fail(
			"card-shot",
			`${file} is not a PNG (first bytes ${png.subarray(0, 8).toString("hex")})`,
		);
	}
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	if (width !== WIDTH || height !== HEIGHT) {
		fail(
			"card-shot",
			`${file} has the wrong size ${width}x${height}, expected ${WIDTH}x${HEIGHT}`,
		);
	}
	console.log(
		`card-shot: wrote ${file} (${width}x${height}, ${png.length} bytes)`,
	);
}

const { pr, views } = parseArgs(process.argv.slice(2));
const chromePath = findChrome("card-shot");
const port = await freePort();

// Everything lives under a fresh temp root: the worktree .dev pool stays untouched, no
// leftover board can hold the state this run plants into, and the plant happens while
// no board boots on it.
const root = mkdtempSync(join(tmpdir(), "ottr-card-shot-"));
const stateDir = join(root, "state");
await seedDemo(root, false, stateDir);
const planted: Planted | null = pr !== null ? plantCards(root, pr) : null;
if (planted !== null) {
	console.log(
		`card-shot: planted ${planted.prId} (PR #${pr} open, parked at merging) and ${planted.doneId} (done) in ${PROJECT}`,
	);
}

const hostEnv = { ...process.env };
// The host's VM runner env must not reach the demo board: a runner URL without its
// token refuses the boot (src/runner.ts), and a shot board runs no agents anyway.
delete hostEnv.OTTR_VM_RUNNER_URL;
delete hostEnv.OTTR_VM_RUNNER_TOKEN;
delete hostEnv.OTTR_WORKER_TOKEN;
// The settings-hindsight shot shows the no-memory warning line, which renders only
// when the memory probe fails. Strip the host's Hindsight endpoint (its probe would
// pass against it, so the line never renders) and pin the mnemopi store probe to the
// read-only /proc: the line renders deterministically, with no network dependency.
if (views.includes("settings-hindsight")) {
	delete hostEnv.HINDSIGHT_API_URL;
	delete hostEnv.HINDSIGHT_API_TOKEN;
	hostEnv.OTTR_BOARD_OMP_HOME = "/proc/nonexistent";
}

// Demo board only, production asset mode: the dev-mode HMR server stalls the first
// request while it bundles the app. OTTR_DEMO blocks every agent run.
const board = Bun.spawn(["bun", "src/server.ts"], {
	cwd: REPO,
	env: {
		...hostEnv,
		PORT: String(port),
		NODE_ENV: "production",
		OTTR_DEMO: "1",
		OMP_TRACKER_ROOTS: root,
		OTTR_STATE_DIR: stateDir,
		OTTR_WORKERS_HOME: join(root, "workers-home"),
		OMP_TRACKER_MAX_TOTAL: "none",
	},
	stdout: "ignore",
	stderr: "pipe",
});

// Chrome writes its caches and the crash database under HOME; a read-only HOME (a
// service account's) kills the boot before any endpoint line. Give chrome its own.
const chromeHome = mkdtempSync(join(tmpdir(), "ottr-card-shot-chrome-home-"));
const userDir = mkdtempSync(join(tmpdir(), "ottr-card-shot-chrome-"));
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
		...(typeof process.getuid === "function" && process.getuid() === 0
			? ["--no-sandbox"]
			: []),
		"about:blank",
	],
	{
		stdout: "ignore",
		stderr: "pipe",
		env: { ...process.env, HOME: chromeHome },
	},
);

/** Waits for chrome's CDP endpoint line on stderr; null when the deadline wins. */
async function waitEndpoint(
	proc: { stderr: ReadableStream<Uint8Array> },
	ms: number,
): Promise<string | null> {
	const reader = proc.stderr.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const chunk = await Promise.race([
			reader.read(),
			Bun.sleep(deadline - Date.now()).then(() => null),
		]);
		if (chunk === null) break; // the deadline won
		const { done, value } = chunk;
		if (done) break;
		text += decoder.decode(value, { stream: true });
		const hit = text.match(/DevTools listening on (ws:\/\/\S+)/);
		if (hit?.[1]) {
			reader.releaseLock();
			return hit[1];
		}
	}
	await reader.cancel().catch(() => {});
	return null;
}

/** Polls the board home page until it answers; refuses a board that exits early. */
async function waitBoardReady(): Promise<void> {
	// The server answers the home page once the bundle is served.
	for (let waited = 0; waited < 30_000; waited += 250) {
		if (board.exitCode !== null)
			throw new Error(`the board exited early (code ${board.exitCode})`);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/`, {
				signal: AbortSignal.timeout(1_000),
			});
			await res.body?.cancel();
			if (res.ok) return;
		} catch {
			// not listening yet
		}
		await Bun.sleep(250);
	}
	throw new Error("the board did not become ready within 30 s");
}

/** Opens a blank tab, attaches to it, and returns its page session id. */
async function attachPage(client: Cdp): Promise<string> {
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
	return sessionId;
}

/** Pins the emulated viewport, dark color scheme, and locale; enables page events. */
async function configurePage(client: Cdp, sessionId: string): Promise<void> {
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
}

/** The plain value of a Runtime.evaluate reply, or undefined when it carries none. */
function resultValue(result: unknown): unknown {
	return result && typeof result === "object" && "value" in result
		? result.value
		: undefined;
}

/** Scrolls the Hindsight card under the page header and reads its warning line. */
async function readHindsightLine(
	client: Cdp,
	sessionId: string,
): Promise<unknown> {
	// The warning line sits at the top of the Hindsight card; scroll the card
	// under the page header before reading it.
	const probe = await withTimeout(
		client.send(
			"Runtime.evaluate",
			{
				returnByValue: true,
				expression:
					"document.getElementById('hindsight-section')?.scrollIntoView({ block: 'start' }); scrollBy(0, -90); (document.querySelector('#hindsight-section p[role=alert]')?.textContent ?? 'MISSING').trim()",
			},
			sessionId,
		),
		10_000,
		"the Hindsight section probe",
	);
	return resultValue(probe?.result);
}

/** Refuses the shot when the Hindsight card shows no memory warning line. */
async function verifyHindsight(client: Cdp, sessionId: string): Promise<void> {
	const value = await readHindsightLine(client, sessionId);
	if (typeof value !== "string" || !value.includes("no memory"))
		fail(
			"card-shot",
			`the Hindsight section shows no memory warning (${String(value)})`,
		);
	await Bun.sleep(500);
}

/** Screenshots the page, writes its PNG under shots/, and verifies the image. */
async function writeShot(
	client: Cdp,
	sessionId: string,
	name: string,
): Promise<void> {
	const shot = await withTimeout(
		client.send("Page.captureScreenshot", { format: "png" }, sessionId),
		30_000,
		"Page.captureScreenshot",
	);
	if (typeof shot.data !== "string")
		throw new Error("chrome returned no image data");
	const png = Buffer.from(shot.data, "base64");
	const file = join(SHOTS_DIR, `${name}.png`);
	await Bun.write(file, png);
	verifyPng(png, file);
}

/** Navigates one view, waits for its load, settles animations, and writes it. */
async function captureView(
	client: Cdp,
	sessionId: string,
	name: string,
	planted: Planted | null,
): Promise<void> {
	// Register the waiter first: a load that lands before the wait would time out.
	const load = client.waitEvent("Page.loadEventFired", sessionId);
	await withTimeout(
		client.send(
			"Page.navigate",
			{ url: `http://127.0.0.1:${port}${viewPath(name, planted)}` },
			sessionId,
		),
		15_000,
		"Page.navigate",
	);
	await withTimeout(load, 30_000, `the ${name} view load`);
	// Card entrance animations run about 2 s; let them finish before the shot.
	await Bun.sleep(SETTLE_MS);
	if (name === "settings-hindsight") await verifyHindsight(client, sessionId);
	await writeShot(client, sessionId, name);
	if (name === "ask") {
		// The same drawer in the light theme: the wrap rules must hold in both.
		// The board pins its theme from localStorage at first paint, so the
		// emulation flip alone cannot reach it — store the theme, then navigate
		// fresh: a reload's style-only repaint can miss the headless surface.
		const setTheme = (theme: string) =>
			client.send(
				"Runtime.evaluate",
				{ expression: `localStorage.setItem('ottr.theme', '${theme}')` },
				sessionId,
			);
		const navigate = async () => {
			const load = client.waitEvent("Page.loadEventFired", sessionId);
			await withTimeout(
				client.send(
					"Page.navigate",
					{ url: `http://127.0.0.1:${port}${viewPath(name, planted)}` },
					sessionId,
				),
				15_000,
				"Page.navigate",
			);
			await withTimeout(load, 30_000, "the ask light load");
			await Bun.sleep(SETTLE_MS);
		};
		await setTheme("light");
		await navigate();
		await writeShot(client, sessionId, "ask-light");
		// Leave the stored theme as the board's default for any later view.
		await setTheme("system");
	}
}

/** One capture run; every await below carries its own deadline. */
async function capture(): Promise<void> {
	// The endpoint line arrives on stderr: "DevTools listening on ws://...".
	const endpoint = await waitEndpoint(chrome, 15_000);
	if (endpoint === null) throw new Error("chrome printed no DevTools endpoint");

	const client = new Cdp(new WebSocket(endpoint));
	await withTimeout(client.open(), 10_000, "CDP open");
	client.listen();

	await waitBoardReady();

	const sessionId = await attachPage(client);
	await configurePage(client, sessionId);
	mkdirSync(SHOTS_DIR, { recursive: true });

	for (const name of views) {
		await captureView(client, sessionId, name, planted);
	}
}

let failure: Error | null = null;
const run = capture();
try {
	// Watchdog: the capture must always end, so the script never hangs a work turn.
	const { promise: deadline, reject } = Promise.withResolvers<never>();
	const watchdog = setTimeout(
		() =>
			reject(new Error(`the capture gave up after ${WATCHDOG_MS / 1000} s`)),
		WATCHDOG_MS,
	);
	watchdog.unref?.();
	deadline.catch(() => {}); // stays handled when capture wins the race
	await Promise.race([run, deadline]);
	clearTimeout(watchdog);
} catch (err) {
	failure = err instanceof Error ? err : new Error(String(err));
} finally {
	await stopChildren(chrome, board);
}
// A deadline win can leave capture() pending; keep its rejection from crashing the exit.
run.catch(() => {});
if (failure) fail("card-shot", failure.message);
// Every artifact verified: leave now, so no pending read can hang the process.
console.log(`card-shot: ${views.join(", ")} written under ${SHOTS_DIR}`);
process.exit(0);

import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	type Mock,
	mock,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { execSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import {
	behindMain,
	boardWarnings,
	type Entry,
	reconcileLayerUse,
	storedProjectPaths,
	workerSignInWarnings,
} from "./app.ts";
import { hashPassword, signSession } from "./auth.ts";
import type { SpawnFn } from "./forkAnalysis.ts";
import type { GhFn } from "./forks.ts";
import { defaultSshDir, GIT_URL_ERROR, type Keyscan } from "./gitHosts.ts";
import { GlobalStore } from "./globalStore.ts";
import { MAX_IMAGE_BYTES } from "./images.ts";
import { boardOmpEnv, type SignIn, signIns } from "./login.ts";
import { modelRoles } from "./models.ts";
import { summarizeCmd } from "./orphans.ts";
import {
	ARCH_REVIEW_MARKER,
	BOARD_CHECK_PROMPT,
	FORK_PROPOSED_REASON_PREFIX,
	forkProposedReason,
	RELEASE_SUMMARY_INSTRUCTIONS,
	RETRO_MARKER,
	RULES_INTERVIEW_MARKER,
	WORK_CHECK_SENDBACK_OPENING,
} from "./prompts.ts";
import { createRunSink } from "./runner.ts";
import {
	PROMPT_EDIT_HELD,
	type ReviewTask,
	SILENT_LOG_MS,
	WORK_CHECK_THIRD_BLOCK,
	workCheckAsk,
} from "./scheduler.ts";
import { ProjectStore } from "./store.ts";
import fc from "./test/properties.ts";
import {
	cancelKeptReason,
	FORK_HOLD_REASON,
	MERGE_HOLD_MISMATCH_REASON,
	UPDATE_HOLD_REASON,
} from "./turn.ts";
import {
	type AddProjectResponse,
	type PrReviewRow,
	REVIEW_BODY_MAX,
	REVIEW_FOOTER,
	type Task,
} from "./types.ts";
import { loadSkips } from "./updates.ts";
import { PUSH_SUBJECT, saveSubs } from "./webpush.ts";
import { git, gitSecrets, networkGitAuth } from "./worktree.ts";

// The push tests observe sends and VAPID details (R1-1, R2-3). The mock must be registered
// before app.ts evaluates — mock.module cannot intercept a static import — so app.ts loads
// through the await below (deliberate module-load boundary, the rule's test exception).
const pushSends: Array<{ endpoint: string; payload: string }> = [];
let pushFail: { statusCode?: number } | null = null;
let vapidApplied: {
	subject: string;
	publicKey: string;
	privateKey: string;
} | null = null;
mock.module("web-push", () => ({
	generateVAPIDKeys: () => ({
		publicKey: "test-public-key",
		privateKey: "test-private-key",
	}),
	setVapidDetails: (subject: string, publicKey: string, privateKey: string) => {
		vapidApplied = { subject, publicKey, privateKey };
	},
	sendNotification: async (sub: { endpoint: string }, payload: string) => {
		pushSends.push({ endpoint: sub.endpoint, payload });
		if (pushFail !== null)
			throw Object.assign(new Error("push rejected"), pushFail);
		return {};
	},
}));
const { createApp } = await import("./app.ts");

const root = mkdtempSync(join(tmpdir(), "app-routes-"));

// Clone tests point github.com URLs at local fixture repos via git's insteadOf, so no
// network and no real clone ever runs; file:// maps the URL prefix to fixtureRepos. A
// rewrite keeps the URL's remainder verbatim, so clone URLs carry no .git suffix.
const fixtureRepos = join(root, "fixture-repos");
mkdirSync(fixtureRepos, { recursive: true });
const gitConfigGlobal = join(root, "git-config");
// One rewrite per remote form: each maps its URL prefix onto a fixture
// subdir, so clone and ls-remote never touch a network. A rewrite keeps the URL's remainder
// verbatim, so the fixture dir name is the whole remainder of the URL.
writeFileSync(
	gitConfigGlobal,
	[
		`[url "file://${fixtureRepos}"]`,
		"\tinsteadOf = https://github.com/octo",
		`[url "file://${fixtureRepos}/gl"]`,
		// No trailing slash on a prefix: git concatenates base + remainder verbatim, so the
		// remainder must keep its leading "/" (the github entry above works the same way).
		"\tinsteadOf = https://gitlab.com/g/sub",
		`[url "file://${fixtureRepos}/ex"]`,
		"\tinsteadOf = https://git.example.com:8443/a/b/c",
		`[url "file://${fixtureRepos}/scp"]`,
		"\tinsteadOf = git@git.example.com:a",
		`[url "file://${fixtureRepos}/ssh2"]`,
		"\tinsteadOf = ssh://git@git.example.com:2222/a",
		"",
	].join("\n"),
);
process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;
/** Local repo the insteadOf rewrite serves for https://github.com/octo/<name>; empty=true skips the commit (gitless clone). */
const makeFixture = (name: string, empty = false) => {
	const p = join(fixtureRepos, name);
	mkdirSync(p, { recursive: true });
	const run = (cmd: string) => execSync(cmd, { cwd: p, stdio: "ignore" });
	run("git init -q -b main");
	if (!empty) {
		run("git config user.email t@t && git config user.name t");
		writeFileSync(join(p, "seed.txt"), "s");
		run("git add seed.txt && git commit -qm seed");
	}
	return p;
};
/**
 * Host key + keyscan stub for the ssh flows: the stub answers the generated public key, so
 * the host-key check, the trust confirm and the clone all run against one known identity.
 * No real network: insteadOf rewrites every git@git.example.com / ssh:// URL onto a fixture.
 */
const sshFixture = () => {
	const dir = mkdtempSync(join(tmpdir(), "git-hosts-ssh-"));
	sshTempDirs.push(dir);
	execSync(`ssh-keygen -t ed25519 -N "" -q -f ${join(dir, "hostkey")}`);
	const pub = readFileSync(join(dir, "hostkey.pub"), "utf8").trim();
	// known_hosts line form: [host]:port for a non-default port, bare host otherwise.
	const line = (port: number | null) =>
		port === null
			? `git.example.com ${pub}`
			: `[git.example.com]:${port} ${pub}`;
	const keyscan: Keyscan = async (host, port) =>
		host === "git.example.com"
			? [line(port)]
			: { error: `no route to ${host}` };
	return { dir, keyscan };
};
/** A global ssh key file in an ssh dir, as Settings → Git hosts would leave it. */
const seedGlobalKey = (dir: string): void => {
	execSync(`ssh-keygen -t ed25519 -N "" -q -f ${join(dir, "global")}`);
};
/** Servers mounted by the per-describe helpers, and the global stores mount() opened; the shared afterAll stops and closes them. */
const mounted: Server<undefined>[] = [];
const mountStores: GlobalStore[] = [];
/** ssh dirs handed to mounted apps; the shared afterAll removes them with root. */
const sshTempDirs: string[] = [];
afterAll(() => {
	store.close();
	for (const e of projects.values()) e.store.close(); // renamed/re-added entries hold their own stores
	gstore.close();
	server.stop(true);
	for (const s of mounted) s.stop(true);
	// Windows cannot delete an open db: every store under root must be closed before the rm.
	for (const g of mountStores) g.close();
	for (const d of sshTempDirs) rmSync(d, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	// The whole-shutdown sweep (every mounted server's graceful stop, then the root rm) passes
	// bun's 5 s hook default on a loaded machine (OTTR-548 gate): a ceiling, not a wait.
}, 60_000);

const projectDir = join(root, "p1");
mkdirSync(projectDir, { recursive: true });
const gstore = GlobalStore.open(join(root, "g"));
const store = ProjectStore.open(projectDir);
const projects = new Map<string, Entry>();
let calls = 0;
const shared = {
	maxTotalRuns: 3,
	reviewCheck: true,
	workCheck: true,
	idleReviews: true,
	removedPaths: [] as string[],
	projectPaths: [] as string[],
	projectOrder: [] as string[],
	envValues: {} as Record<string, string>,
};
// Compose turns reach the board at OTTR_BOARD_URL, a host no allowlist covers ("turns' own host").
const BOARD_TOKEN = "boot-token-test";
type CancelOutcome = { kept: string } | { removed: true };
type FinishKeptOutcome =
	| { ok: true }
	| { error: string; status: 400 | 404 | 409 };
type StopOutcome = { ok: true } | { error: string; status: 404 | 409 };
let cancelImpl: (
	e: Entry,
	id: string,
	force: boolean,
) => Promise<CancelOutcome> = async () => ({ removed: true });
let finishKeptImpl: (
	e: Entry,
	id: string,
	choices: unknown,
) => Promise<FinishKeptOutcome> = async () => ({ ok: true });
let stopTurnImpl: (e: Entry, id: string) => Promise<StopOutcome> =
	async () => ({
		ok: true,
	});
const loopStubs = () => ({
	cancel: (e: Entry, id: string, force: boolean) => cancelImpl(e, id, force),
	finishKept: (e: Entry, id: string, choices: unknown) =>
		finishKeptImpl(e, id, choices),
	stopTurn: (e: Entry, id: string) => stopTurnImpl(e, id),
	claimedPids: () => new Set<number>(),
});
// Deepen seam: the route tests swap deepenImpl per test; unstubbed calls fail loudly.
let deepenImpl: (prompt: string, model: string | null) => Promise<string> =
	async () => {
		throw new Error("deepen not stubbed");
	};
// Live progress the /api/state silent tests set ({ text, at }); null is the default:
// no progress at all, the log-only warning rule.
let fakeProgress: { text: string; at?: number } | null = null;
const app = createApp({
	gstore,
	defaultDir: root,
	// Server-only ssh state for the git-hosts routes; a root subdir, not a project checkout.
	sshDir: join(root, "ssh"),
	// env.txt name lists for the Settings env routes; a root subdir provisioned below.
	workersHome: root,
	projects,
	...loopStubs(),
	deepen: (prompt, model) => deepenImpl(prompt, model),
	progressOf: () => fakeProgress,
	schedule: () => {
		calls++;
	},
	serverVersion: "test",
	port: 0,
	publicHosts: [],
	shared,
	serverRef: { current: undefined },
	board: { url: "http://ottr:4852", token: BOARD_TOKEN },
});
const server = Bun.serve({ port: 0, ...app.serveOptions });
app.serverRef.current = server;
projects.set("p1", {
	path: projectDir,
	name: "p1",
	store,
	target: null,
	gitless: false,
	github: null,
	remote: null,
	dirty: false,
	mainUnpushed: false,
	mainBranch: null,
	latestRelease: null,
	latestImage: null,
	archReview: null,
});
// Extra registered projects for the /api/projects/order tests; same shape as p1.
const projectDir2 = join(root, "p2");
const store2 = ProjectStore.open(projectDir2);
projects.set("p2", {
	path: projectDir2,
	name: "p2",
	store: store2,
	target: null,
	gitless: false,
	github: null,
	remote: null,
	dirty: false,
	mainUnpushed: false,
	mainBranch: null,
	latestRelease: null,
	latestImage: null,
	archReview: null,
});
const projectDir3 = join(root, "p3");
const store3 = ProjectStore.open(projectDir3);
projects.set("p3", {
	path: projectDir3,
	name: "p3",
	store: store3,
	target: null,
	gitless: false,
	github: null,
	remote: null,
	dirty: false,
	mainUnpushed: false,
	mainBranch: null,
	latestRelease: null,
	latestImage: null,
	archReview: null,
});

const post = async (
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	fetch(new URL(path, server.url), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			// deps.port is 0 in the test mount; api()/readJson() match Host and Origin on it.
			Host: "127.0.0.1:0",
			Origin: "http://127.0.0.1:0",
			...headers,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

/** Narrowed reader for API error envelopes. */
const errorOf = async (res: Response): Promise<string> => {
	const b: unknown = await res.json();
	return typeof b === "object" && b !== null && "error" in b
		? String(b.error)
		: "";
};

// Same guard headers as post(): api() matches Host and Origin on deps.port (0 here).
const get = async (path: string) =>
	fetch(new URL(path, server.url), {
		headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
	});

/**
 * Fresh isolated app+server for one describe (own global store, own limiter/limiter buckets,
 * own onboarding state); registered for the shared shutdown.
 */
function mount(
	input: {
		gstore?: GlobalStore;
		admin?: { name: string; password: string };
		projects?: Map<string, Entry>;
		defaultDir?: string;
		gh?: GhFn;
		githubAppFetch?: (url: string, init?: RequestInit) => Promise<Response>;
		sshDir?: string;
		keyscan?: Keyscan;
		/** Fetch/timeout seam for the git 401/403 probe; passed through to createApp. */
		githubAuthProbe?: Parameters<typeof createApp>[0]["githubAuthProbe"];
		models?: Parameters<typeof createApp>[0]["models"];
		/** Idle-review clock seam (docs/specs/mutation-delta.md §7); defaults to Date.now. */
		now?: () => number;
		schedule?: () => void;
		/** Gateway spawn seam for the release-summary route; defaults to the real spawn. */
		releaseSummarySpawn?: Parameters<
			typeof createApp
		>[0]["releaseSummarySpawn"];
	} = {},
) {
	const g =
		input.gstore ??
		GlobalStore.open(
			join(
				root,
				`g-mount-${mounted.length}-${Math.random().toString(36).slice(2)}`,
			),
		);
	if (g !== input.gstore) mountStores.push(g);
	if (input.admin)
		g.set("config", {
			admin: {
				name: input.admin.name,
				passHash: hashPassword(input.admin.password),
			},
			sessionSecret: "test-secret",
		});
	const created = createApp({
		gstore: g,
		projects: input.projects ?? new Map(),
		cancel: async () => ({ removed: true }),
		stopTurn: async () => ({ ok: true }),
		finishKept: async () => ({ ok: true }),
		claimedPids: () => new Set<number>(),
		schedule: input.schedule ?? (() => {}),
		now: input.now,
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared: {
			maxTotalRuns: 3,
			reviewCheck: true,
			workCheck: true,
			idleReviews: true,
			removedPaths: [],
			envValues: {},
			projectPaths: [],
			projectOrder: [],
		},
		defaultDir: input.defaultDir ?? root,
		gh: input.gh,
		githubAppFetch: input.githubAppFetch,
		sshDir: input.sshDir,
		keyscan: input.keyscan,
		githubAuthProbe: input.githubAuthProbe,
		models: input.models,
		releaseSummarySpawn: input.releaseSummarySpawn,
		serverRef: { current: undefined },
	});
	const srv = Bun.serve({ port: 0, ...created.serveOptions });
	created.serverRef.current = srv;
	mounted.push(srv);
	const call = (
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	) => {
		// An explicit headers.method (PUT/DELETE) wins; it is consumed, not sent as a header.
		const { method, ...rest } = headers;
		return fetch(new URL(path, srv.url), {
			method: method ?? (body === undefined ? "GET" : "POST"),
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
				...rest,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	};
	return { g, app: created, server: srv, call };
}

describe("task routes", () => {
	test("create returns a queued task with a PREFIX-n id and kicks the scheduler", async () => {
		const before = calls;
		const res = await post("/api/projects/p1/tasks", { prompt: "do it" });
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		const task =
			typeof b === "object" && b !== null && "id" in b && "state" in b
				? b
				: { id: "", state: "" };
		expect(String(task.id)).toMatch(/^[A-Z0-9]{1,4}-[0-9]+$/);
		expect(String(task.state)).toBe("queued");
		expect(store.getTask(String(task.id))?.prompt).toBe("do it");
		expect(calls).toBe(before + 1);
	});

	test("create with dependsOn links the cards and persists the ids", async () => {
		const other = store.createTask("first card");
		const res = await post("/api/projects/p1/tasks", {
			prompt: "second card",
			dependsOn: [other.id],
		});
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		const task =
			typeof b === "object" && b !== null && "dependsOn" in b ? b : null;
		expect(task?.dependsOn).toEqual([other.id]);
		expect(store.getTask(String(other.id)) !== null).toBe(true);
	});

	test("create rejects an unknown dependsOn task with 404 naming the id", async () => {
		const res = await post("/api/projects/p1/tasks", {
			prompt: "doomed",
			dependsOn: ["nope1234"],
		});
		expect(res.status).toBe(404);
		expect(await errorOf(res)).toBe("unknown dependsOn task: nope1234");
	});

	test("create rejects a non-array dependsOn with 400", async () => {
		const res = await post("/api/projects/p1/tasks", {
			prompt: "bad dep",
			dependsOn: "x",
		});
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("dependsOn must be an array of task ids");
	});

	test("create dedupes dependsOn ids", async () => {
		const other = store.createTask("dep");
		const res = await post("/api/projects/p1/tasks", {
			prompt: "dupe dep",
			dependsOn: [other.id, other.id],
		});
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		const task =
			typeof b === "object" && b !== null && "dependsOn" in b ? b : null;
		expect(task?.dependsOn).toEqual([other.id]);
	});

	const get = async (path: string) =>
		fetch(new URL(path, server.url), {
			headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
		});

	test("drawer detail exposes worktree files and serves them safely", async () => {
		const t = store.createTask("with worktree");
		// statusFiles only reports for a linked git worktree, so build a real one.
		const repo = join(root, "wt-repo");
		const run = (cmd: string, cwd: string) =>
			execSync(cmd, { cwd, stdio: "ignore" });
		mkdirSync(repo, { recursive: true });
		run("git init -q", repo);
		run("git config user.email t@t && git config user.name t", repo);
		writeFileSync(join(repo, "seed.txt"), "s");
		run("git add seed.txt && git commit -qm seed", repo);
		const wt = join(root, "wt-files");
		run(`git worktree add -q "${wt}" -b wt-files`, repo);
		mkdirSync(join(wt, "nested"), { recursive: true });
		writeFileSync(join(wt, "mockup.html"), "<h1>hi</h1>");
		writeFileSync(join(wt, "nested", "style.css"), "h1 { color: red }");
		writeFileSync(join(root, "secret.txt"), "no");
		store.updateTask(t.id, { worktree: wt });
		const noWt = store.createTask("without worktree");

		const detail = await get(`/api/projects/p1/tasks/${t.id}`);
		expect(detail.status).toBe(200);
		const b = (await detail.json()) as { worktreeFiles?: string[] };
		expect([...(b.worktreeFiles ?? [])].sort()).toEqual([
			"mockup.html",
			"nested/style.css",
		]);

		const html = await get(
			`/api/projects/p1/tasks/${t.id}/files?path=mockup.html`,
		);
		expect(html.status).toBe(200);
		expect(await html.text()).toBe("<h1>hi</h1>");
		expect(html.headers.get("content-type")).toContain("text/html");
		expect(html.headers.get("content-security-policy")).toBe(
			"sandbox allow-scripts",
		);

		const css = await get(
			`/api/projects/p1/tasks/${t.id}/files?path=nested/style.css`,
		);
		expect(css.status).toBe(200);

		const traversal = await get(
			`/api/projects/p1/tasks/${t.id}/files?path=${encodeURIComponent("../secret.txt")}`,
		);
		expect(traversal.status).toBe(400);
		const empty = await get(`/api/projects/p1/tasks/${t.id}/files?path=`);
		expect(empty.status).toBe(400);

		expect(
			(await get("/api/projects/p1/tasks/00000000/files?path=mockup.html"))
				.status,
		).toBe(404);
		expect(
			(await get(`/api/projects/p1/tasks/${noWt.id}/files?path=mockup.html`))
				.status,
		).toBe(404);
	});

	test("drawer detail serves the captured uncommitted files for done cards", async () => {
		// A merged card keeps its worktree path after the merge turn removed the directory.
		const t = store.createTask("merged earlier");
		store.updateTask(t.id, {
			stage: "done",
			state: "idle",
			worktree: join(root, "removed-after-merge"),
			uncommittedFiles: ["report.md"],
		});
		const detail = await get(`/api/projects/p1/tasks/${t.id}`);
		expect(detail.status).toBe(200);
		const b = (await detail.json()) as { worktreeFiles?: string[] };
		expect(b.worktreeFiles).toEqual(["report.md"]);
	});

	test("diff endpoint serves the captured stat and text for finished cards", async () => {
		const t = store.createTask("captured diff");
		store.updateTask(t.id, {
			stage: "done",
			state: "idle",
			diffFiles: [{ file: "a.ts", plus: 2, minus: 1 }],
			diffText: "diff --git a/a.ts b/a.ts\n",
		});
		const detail = await get(`/api/projects/p1/tasks/${t.id}`);
		const b = (await detail.json()) as {
			diffFiles?: unknown;
			diffText?: unknown;
		};
		expect(b.diffFiles).toEqual([{ file: "a.ts", plus: 2, minus: 1 }]);
		// The raw text ships only from /diff, never inside the drawer payload.
		expect("diffText" in b).toBe(false);
		const raw = await get(`/api/projects/p1/tasks/${t.id}/diff`);
		expect(raw.status).toBe(200);
		expect(await raw.text()).toBe("diff --git a/a.ts b/a.ts\n");
		expect(raw.headers.get("content-type")).toContain("text/plain");
		expect(raw.headers.get("content-security-policy")).toBe("sandbox");

		const none = store.createTask("no capture");
		store.updateTask(none.id, { stage: "done", state: "idle" });
		expect((await get(`/api/projects/p1/tasks/${none.id}/diff`)).status).toBe(
			404,
		);
	});

	test("an open card reads its diff live from the branch", async () => {
		const repo = join(root, "diff-repo");
		const run = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "ignore" });
		mkdirSync(repo, { recursive: true });
		run("git init -q -b main");
		run("git config user.email t@t && git config user.name t");
		writeFileSync(join(repo, "seed.txt"), "s");
		run("git add seed.txt && git commit -qm seed");
		const seed = execSync("git rev-parse HEAD", {
			cwd: repo,
		})
			.toString()
			.trim();
		const wt = join(root, "diff-wt");
		run(`git worktree add -q "${wt}" -b card`);
		writeFileSync(join(wt, "a.txt"), "added\n");
		execSync('git add a.txt && git commit -qm "card work"', {
			cwd: wt,
			stdio: "ignore",
		});

		const e = projects.get("p1");
		if (e === undefined) throw new Error("p1 is not registered");
		const prevTarget = e.target;
		e.target = "main";
		try {
			const t = store.createTask("open diff");
			store.updateTask(t.id, { branch: "card", base: seed, worktree: wt });
			const detail = await get(`/api/projects/p1/tasks/${t.id}`);
			const b = (await detail.json()) as { diffFiles?: unknown };
			expect(b.diffFiles).toEqual([{ file: "a.txt", plus: 1, minus: 0 }]);
			const raw = await get(`/api/projects/p1/tasks/${t.id}/diff`);
			expect(raw.status).toBe(200);
			expect(await raw.text()).toContain("+added");

			// Without a resolved target there is no base to read the branch against.
			e.target = null;
			const ungrown = await get(`/api/projects/p1/tasks/${t.id}`);
			expect(
				((await ungrown.json()) as { diffFiles?: unknown }).diffFiles,
			).toBeNull();
			expect((await get(`/api/projects/p1/tasks/${t.id}/diff`)).status).toBe(
				404,
			);
		} finally {
			e.target = prevTarget;
		}
	});

	test("create validation rejects bad prompts, unknown projects, and wrong content types", async () => {
		expect((await post("/api/projects/p1/tasks", { prompt: 42 })).status).toBe(
			400,
		);
		const empty = await post("/api/projects/p1/tasks", { prompt: "" });
		expect(empty.status).toBe(400);
		expect(await errorOf(empty)).toBe("prompt must be 1-20000 characters");
		const long = await post("/api/projects/p1/tasks", {
			prompt: "x".repeat(20001),
		});
		expect(long.status).toBe(400);
		expect(await errorOf(long)).toBe("prompt must be 1-20000 characters");
		const unknown = await post("/api/projects/ghost/tasks", { prompt: "hi" });
		expect(unknown.status).toBe(404);
		expect(await errorOf(unknown)).toBe("unknown project");
		const wrongType = await post("/api/projects/p1/tasks", "{ prompt: 'x' }", {
			"content-type": "text/plain",
		});
		expect(wrongType.status).toBe(415);
	});

	describe("create_task cross-project followUpOf", () => {
		// Foreign stores with the SAME folder basename: taskPrefix() derives from the
		// folder name, so each store's first createTask() yields the same id.
		const p2Dir = join(root, "a", "dup");
		const p3Dir = join(root, "b", "dup");
		let p2: Entry;
		let p3: Entry;
		beforeAll(() => {
			p2 = {
				path: p2Dir,
				name: "p2",
				store: ProjectStore.open(p2Dir),
				target: null,
				gitless: false,
				github: null,
				remote: null,
				dirty: false,
				mainUnpushed: false,
				mainBranch: null,
				latestRelease: null,
				latestImage: null,
				archReview: null,
			};
			p3 = {
				path: p3Dir,
				name: "p3",
				store: ProjectStore.open(p3Dir),
				target: null,
				gitless: false,
				github: null,
				remote: null,
				dirty: false,
				mainUnpushed: false,
				mainBranch: null,
				latestRelease: null,
				latestImage: null,
				archReview: null,
			};
			projects.set("p2", p2);
			projects.set("p3", p3);
		});
		afterAll(() => {
			projects.delete("p2");
			projects.delete("p3");
			p2.store.close();
			p3.store.close();
		});

		test("create links a card into another project and stores the parent's project", async () => {
			const parent = store.createTask("p1 parent");
			store.updateTask(parent.id, { updateIds: ["x@1"] });
			const res = await post("/api/projects/p2/tasks", {
				prompt: "child in p2",
				followUpOf: parent.id,
			});
			expect(res.status).toBe(200);
			const child = p2.store
				.listTasks()
				.find((t) => t.followUpOf === parent.id)!;
			expect(child.followUpOfProject).toBe("p1");
			// The merge hold never crosses a project border.
			expect(child.updateIds).toEqual([]);
		});

		test("create with a parent on this board keeps the link local", async () => {
			const parent = store.createTask("p1 parent again");
			store.updateTask(parent.id, { updateIds: ["x@1"] });
			const res = await post("/api/projects/p1/tasks", {
				prompt: "local child",
				followUpOf: parent.id,
			});
			expect(res.status).toBe(200);
			const kid = store.listTasks().find((t) => t.followUpOf === parent.id)!;
			expect(kid.followUpOfProject).toBeNull();
			expect(kid.updateIds).toEqual(["x@1"]);
		});

		test("an unknown parent still 404s with the same error", async () => {
			const res = await post("/api/projects/p1/tasks", {
				prompt: "lost child",
				// A well-formed id that exists on no board; a malformed shape still 400s
				// from resolveTask before the fleet scan.
				followUpOf: "abcd1234",
			});
			expect(res.status).toBe(404);
			expect(await errorOf(res)).toBe("unknown followUpOf task");
			const badShape = await post("/api/projects/p1/tasks", {
				prompt: "lost child",
				followUpOf: "nope1234",
			});
			expect(badShape.status).toBe(400);
			expect(await errorOf(badShape)).toBe("bad task id");
		});

		test("a parent id on several foreign boards is ambiguous", async () => {
			// p2 already holds DUP-1 (the test above filed its child there); p3's
			// first createTask() yields the same id.
			const dupId = p2.store.listTasks()[0]!.id;
			p3.store.createTask("dup twin");
			const res = await post("/api/projects/p1/tasks", {
				prompt: "ambiguous child",
				followUpOf: dupId,
			});
			expect(res.status).toBe(409);
			expect(await errorOf(res)).toBe(
				"followUpOf names cards in several projects: p2, p3",
			);
		});
	});

	test("state cards omit details and report", async () => {
		const t = store.createTask("card shape");
		store.updateTask(t.id, { details: "secret", report: "finding" });
		// A default card carries the model its last run used.
		store.finishTurn(store.startTurn(t.id, "work", "p", null).id, {
			model: "zai/glm-5.3-flash",
		});
		const res = await get("/api/state");
		const b: unknown = await res.json();
		if (typeof b !== "object" || b === null || !("tasks" in b)) {
			expect.unreachable("state response missing tasks");
		}
		const { tasks } = b as { tasks: unknown };
		// The server's own state payload; only the fields this test reads are named.
		const cards = (Array.isArray(tasks) ? tasks : []) as Array<{
			id: string;
			lastModel?: string | null;
		}>;
		const card = cards.find((c) => c.id === t.id);
		if (card === undefined) {
			expect.unreachable("card for created task missing");
		}
		expect(card).not.toHaveProperty("details");
		expect(card).not.toHaveProperty("report");
		expect(card.lastModel).toBe("zai/glm-5.3-flash");
	});

	test("detail carries the card's retro with prompt-free turns", async () => {
		const parent = store.createTask("retro source");
		store.updateTask(parent.id, { stage: "done", state: "idle" });
		const retro = store.createTask("retro prompt", null, "retro");
		store.updateTask(retro.id, { followUpOf: parent.id });
		const turn = store.startTurn(retro.id, "work", "retro turn prompt", null);
		const res = await get(`/api/projects/p1/tasks/${parent.id}`);
		expect(res.status).toBe(200);
		const b = (await res.json()) as {
			retro?: { id: string; turns: Array<Record<string, unknown>> };
		};
		expect(b.retro?.id).toBe(retro.id);
		expect(b.retro?.turns.map((x) => x.id)).toEqual([turn.id]);
		expect(b.retro?.turns[0]).not.toHaveProperty("prompt");

		const plain = store.createTask("no retro");
		const plainRes = await get(`/api/projects/p1/tasks/${plain.id}`);
		expect(((await plainRes.json()) as { retro?: unknown }).retro).toBe(
			undefined,
		);
	});

	test("detail carries a review's findings with prompt-free turns", async () => {
		const review = store.createTask("review prompt", null, "review");
		const finding = store.createTask("the found bug");
		store.updateTask(finding.id, { followUpOf: review.id });
		const turn = store.startTurn(
			finding.id,
			"work",
			"finding turn prompt",
			null,
		);
		// The closure: a follow-up of the finding and a dependency join it; a retro never does.
		const grand = store.createTask("follow-up of the finding");
		store.updateTask(grand.id, { followUpOf: finding.id });
		const dep = store.createTask("prerequisite of the finding");
		store.updateTask(finding.id, { dependsOn: [dep.id] });
		const retro = store.createTask("retro prompt", null, "retro");
		store.updateTask(retro.id, { followUpOf: review.id });
		const res = await get(`/api/projects/p1/tasks/${review.id}`);
		expect(res.status).toBe(200);
		const b = (await res.json()) as {
			findings?: Array<{
				id: string;
				title: string;
				turns: Array<Record<string, unknown>>;
			}>;
		};
		expect(b.findings?.map((f) => f.id)).toEqual([
			finding.id,
			grand.id,
			dep.id,
		]);
		expect(b.findings?.[0]?.title).toBe("the found bug");
		expect(b.findings?.[0]?.turns.map((x) => x.id)).toEqual([turn.id]);
		expect(b.findings?.[0]?.turns[0]).not.toHaveProperty("prompt");
		expect(b.findings?.map((f) => f.id)).not.toContain(retro.id);

		// A card filed after the review finished is not part of this review any more.
		store.updateTask(review.id, { stage: "done", state: "idle" });
		const landed = store.getTask(review.id)?.doneAt ?? 0;
		while (Date.now() <= landed) {} // the late card must be created strictly after the landing
		const late = store.createTask("a later follow-up of the finding");
		store.updateTask(late.id, { followUpOf: finding.id });
		const doneRes = await get(`/api/projects/p1/tasks/${review.id}`);
		const done = (await doneRes.json()) as { findings?: Array<{ id: string }> };
		expect(done.findings?.map((f) => f.id)).not.toContain(late.id);

		// A release card runs the same review flow: its findings ride on its detail too.
		const release = store.createTask("cut the release");
		store.updateTask(release.id, { releaseVersion: "v0.4.0" });
		const releaseFinding = store.createTask("the release blocker");
		store.updateTask(releaseFinding.id, { followUpOf: release.id });
		const releaseRes = await get(`/api/projects/p1/tasks/${release.id}`);
		const rb = (await releaseRes.json()) as {
			findings?: Array<{ id: string }>;
		};
		expect(rb.findings?.map((f) => f.id)).toEqual([releaseFinding.id]);

		// A plain work card has no findings.
		const plain = store.createTask("no review here");
		const plainRes = await get(`/api/projects/p1/tasks/${plain.id}`);
		expect(((await plainRes.json()) as { findings?: unknown }).findings).toBe(
			undefined,
		);
	});

	test("state lists a cancelled card with its cancelledAt", async () => {
		const t = store.createTask("cancelled card stays visible");
		store.updateTask(t.id, { cancelledAt: 1760000000000, state: "idle" });
		const res = await get("/api/state");
		const b = (await res.json()) as {
			tasks: Array<{ id: string; cancelledAt: number | null; state: string }>;
		};
		const card = b.tasks.find((c) => c.id === t.id);
		if (card === undefined) {
			expect.unreachable("cancelled card missing from the state task list");
		}
		expect(card.cancelledAt).toBe(1760000000000);
		expect(card.state).toBe("idle");
	});

	test("edit persists a new prompt on a todo task and rejects bad ids", async () => {
		const created = store.createTask("first draft");
		const res = await post(`/api/projects/p1/tasks/${created.id}/edit`, {
			prompt: "second draft",
		});
		expect(res.status).toBe(200);
		expect(store.getTask(created.id)?.prompt).toBe("second draft");
		const badId = await post("/api/projects/p1/tasks/zz/edit", {
			prompt: "x",
		});
		expect(badId.status).toBe(400);
		expect(await errorOf(badId)).toBe("bad task id");
		const unknownId = await post("/api/projects/p1/tasks/00000000/edit", {
			prompt: "x",
		});
		expect(unknownId.status).toBe(404);
	});

	test("a preparing or parked card cannot be edited, even with no turn row yet", async () => {
		// A claimed card has no turn row until startRun, so the no-turns check alone
		// would let an edit land on a prompt the preparing run already consumed.
		const preparing = store.createTask("claimed for a run");
		store.updateTask(preparing.id, { state: "preparing" });
		const res = await post(`/api/projects/p1/tasks/${preparing.id}/edit`, {
			prompt: "too late",
		});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe(
			"only a queued todo task or a parked backlog task can be edited",
		);
		expect(store.getTask(preparing.id)?.prompt).toBe("claimed for a run");
		const parked = store.createTask("parked before the first turn");
		store.updateTask(parked.id, {
			state: "needs_you",
			needsReason: "held",
		});
		const parkedRes = await post(`/api/projects/p1/tasks/${parked.id}/edit`, {
			prompt: "also too late",
		});
		expect(parkedRes.status).toBe(409);
		expect(store.getTask(parked.id)?.prompt).toBe(
			"parked before the first turn",
		);
		// A backlog card still edits while parked idle, but not once a grill turn claimed it.
		const backlog = store.createTask("backlog draft");
		store.updateTask(backlog.id, {
			stage: "backlog",
			state: "idle",
			queuedAt: null,
		});
		const backlogRes = await post(`/api/projects/p1/tasks/${backlog.id}/edit`, {
			prompt: "edited while parked",
		});
		expect(backlogRes.status).toBe(200);
		expect(store.getTask(backlog.id)?.prompt).toBe("edited while parked");
		store.updateTask(backlog.id, { state: "preparing" });
		const grillingRes = await post(
			`/api/projects/p1/tasks/${backlog.id}/edit`,
			{ prompt: "edited while grilling" },
		);
		expect(grillingRes.status).toBe(409);
		expect(store.getTask(backlog.id)?.prompt).toBe("edited while parked");
	});

	test("a held proposal card edits via /edit and /edit/start; a plain needs_you card does not", async () => {
		// A retro proposal parks needs_you with zero turns: the drawer edits its
		// prompt before the user accepts, so the edit gates take that one shape too.
		const proposal = store.createTask("proposal draft");
		store.updateTask(proposal.id, {
			state: "needs_you",
			needsReason:
				"Retro proposal from t9. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		});
		const editRes = await post(`/api/projects/p1/tasks/${proposal.id}/edit`, {
			prompt: "Refactor the retry loop in src/push.ts instead",
		});
		expect(editRes.status).toBe(200);
		expect(store.getTask(proposal.id)?.prompt).toBe(
			"Refactor the retry loop in src/push.ts instead",
		);
		// editTask re-derives the title from the new prompt.
		expect(store.getTask(proposal.id)?.title).toBe(
			"Refactor the retry loop in src/push.ts instead",
		);
		const startRes = await post(
			`/api/projects/p1/tasks/${proposal.id}/edit/start`,
			{},
		);
		expect(startRes.status).toBe(200);
		expect(store.getTask(proposal.id)?.holdUntil).toBe(PROMPT_EDIT_HELD);
		await post(`/api/projects/p1/tasks/${proposal.id}/edit/stop`, {});

		// Any other needs_you card (a user park, a question) still gets 409.
		const parked = store.createTask("parked with a question");
		store.updateTask(parked.id, {
			state: "needs_you",
			needsReason: "asked a question",
		});
		const parkedEdit = await post(`/api/projects/p1/tasks/${parked.id}/edit`, {
			prompt: "nope",
		});
		expect(parkedEdit.status).toBe(409);
		expect(store.getTask(parked.id)?.prompt).toBe("parked with a question");
		const parkedStart = await post(
			`/api/projects/p1/tasks/${parked.id}/edit/start`,
			{},
		);
		expect(parkedStart.status).toBe(409);
		expect(store.getTask(parked.id)?.holdUntil).toBeNull();
	});

	test("an open prompt edit holds the card and every close path releases it", async () => {
		const created = store.createTask("edited while queued");
		// The drawer's editor claims the hold; pickRunnable defers a held card like any
		// usage-limit hold, so the scheduler cannot start the card over the open draft.
		// No heartbeat renews it: PROMPT_EDIT_HELD never arrives, so background-tab timer
		// throttling cannot lapse the hold mid-edit.
		const started = await post(
			`/api/projects/p1/tasks/${created.id}/edit/start`,
			{},
		);
		expect(started.status).toBe(200);
		const held = store.getTask(created.id)!;
		expect(held.holdUntil).toBe(PROMPT_EDIT_HELD);
		// Saving finishes the edit: the hold clears in the same write as the prompt.
		const saved = await post(`/api/projects/p1/tasks/${created.id}/edit`, {
			prompt: "saved draft",
		});
		expect(saved.status).toBe(200);
		expect(store.getTask(created.id)?.holdUntil).toBeNull();
		// A cancel (or any editor close) releases the hold without an edit.
		await post(`/api/projects/p1/tasks/${created.id}/edit/start`, {});
		expect(store.getTask(created.id)?.holdUntil).toBe(PROMPT_EDIT_HELD);
		const stopped = await post(
			`/api/projects/p1/tasks/${created.id}/edit/stop`,
			{},
		);
		expect(stopped.status).toBe(200);
		expect(store.getTask(created.id)?.holdUntil).toBeNull();
		// Every route that queues the card clears the hold, so a user action never
		// stalls behind a hold whose editor died silently.
		const parked = store.createTask("parked idea");
		store.updateTask(parked.id, { stage: "backlog", state: "idle" });
		await post(`/api/projects/p1/tasks/${parked.id}/edit/start`, {});
		expect(store.getTask(parked.id)?.holdUntil).toBe(PROMPT_EDIT_HELD);
		const promoted = await post(`/api/projects/p1/tasks/${parked.id}/backlog`, {
			to: "todo",
		});
		expect(promoted.status).toBe(200);
		expect(store.getTask(parked.id)?.holdUntil).toBeNull();
		expect(store.getTask(parked.id)?.state).toBe("queued");
		// A claim on a queued card dies with the park too: moving the card clears the
		// hold, so another tab's action never stalls behind a dead editor.
		await post(`/api/projects/p1/tasks/${created.id}/edit/start`, {});
		expect(store.getTask(created.id)?.holdUntil).toBe(PROMPT_EDIT_HELD);
		const parkedFromQueue = await post(
			`/api/projects/p1/tasks/${created.id}/backlog`,
			{ to: "backlog" },
		);
		expect(parkedFromQueue.status).toBe(200);
		expect(store.getTask(created.id)?.holdUntil).toBeNull();
		expect(store.getTask(created.id)?.state).toBe("idle");
		// Started cards keep their holds: a turn means no editable prompt, and a stray
		// hold must never stall a started card's next queue entry.
		const run = store.createTask("started card");
		store.startTurn(run.id, "work", "started card", null);
		const refused = await post(
			`/api/projects/p1/tasks/${run.id}/edit/start`,
			{},
		);
		expect(refused.status).toBe(409);
		expect(await errorOf(refused)).toBe(
			"only a queued todo task or a parked backlog task can be edited",
		);
		expect(store.getTask(run.id)?.holdUntil).toBeNull();
		// stop is guard-free: an editor closing on a just-started card still releases.
		const released = await post(
			`/api/projects/p1/tasks/${run.id}/edit/stop`,
			{},
		);
		expect(released.status).toBe(200);
	});

	test("a retro id passes the route checks; a traversal shape still fails", async () => {
		const source = store.createTask("retro source");
		const retro = store.createTask(
			"retro prompt",
			null,
			"retro",
			`${source.id}-retro`,
		);
		store.updateTask(retro.id, { followUpOf: source.id });
		// The retro drawer's link target opens: GET detail on the retro id.
		const got = await get(`/api/projects/p1/tasks/${retro.id}`);
		expect(got.status).toBe(200);
		// POST on the retro id (edit) passes the id check too.
		const edited = await post(`/api/projects/p1/tasks/${retro.id}/edit`, {
			prompt: "edited retro",
		});
		expect(edited.status).toBe(200);
		expect(store.getTask(retro.id)?.prompt).toBe("edited retro");
		// The source card's detail still names the retro (Work steps and its drawer link).
		const detail = (await (
			await get(`/api/projects/p1/tasks/${source.id}`)
		).json()) as { retro?: { id: string } };
		expect(detail.retro?.id).toBe(retro.id);
		// A retro-shaped id may not smuggle path parts: one segment, decoded or not.
		const smuggled = await get(`/api/projects/p1/tasks/${retro.id}%2F..%2Fx`);
		expect(smuggled.status).toBe(400);
	});

	test("a retro of a legacy 8-hex card passes the route checks too", async () => {
		// A legacy card keeps its 8-hex id, and the retro child id follows it:
		// `deadbeef-retro`, not the counter's next number.
		const source = store.createTask("legacy source", null, "work", "deadbeef");
		const retro = store.createTask(
			"retro prompt",
			null,
			"retro",
			"deadbeef-retro",
		);
		store.updateTask(retro.id, { followUpOf: source.id });
		// The Work steps link's target opens: GET detail on the retro id.
		const got = await get("/api/projects/p1/tasks/deadbeef-retro");
		expect(got.status).toBe(200);
		const detail = (await (
			await get("/api/projects/p1/tasks/deadbeef")
		).json()) as { retro?: { id: string } };
		expect(detail.retro?.id).toBe(retro.id);
		// A second retro of the same legacy card gets -retro-2, and /api/seen takes the batch.
		const second = store.createTask(
			"retro prompt",
			null,
			"retro",
			"deadbeef-retro",
		);
		expect(second.id).toBe("deadbeef-retro-2");
		const seen = await post("/api/seen", {
			ids: ["deadbeef-retro", second.id],
		});
		expect(seen.status).toBe(200);
	});

	test("reply queues a needs-you task and refuses queued ones", async () => {
		const t = store.createTask("needs answer");
		store.updateTask(t.id, { state: "needs_you", needsReason: "?" });
		const before = calls;
		const res = await post(`/api/projects/p1/tasks/${t.id}/reply`, {
			text: "ok",
		});
		expect(res.status).toBe(200);
		const row = store.getTask(t.id);
		expect(row?.state).toBe("queued");
		expect(row?.pendingPrompt).toBe("ok");
		expect(row?.needsReason).toBeNull();
		expect(calls).toBe(before + 1);
		const queued = store.createTask("still queued");
		const refusal = await post(`/api/projects/p1/tasks/${queued.id}/reply`, {
			text: "ok",
		});
		expect(refusal.status).toBe(409);
		expect(await errorOf(refusal)).toBe("task is not waiting for you");
	});

	test("reply and Resume keep a steer queued before the stop", async () => {
		const t = store.createTask("stopped while steered");
		store.updateTask(t.id, {
			state: "needs_you",
			needsReason: "Turn stopped.",
			pendingPrompt: "use the fixed config",
			pendingBy: "user",
		});
		await post(`/api/projects/p1/tasks/${t.id}/reply`, { text: "go on" });
		expect(store.getTask(t.id)?.pendingPrompt).toBe(
			"use the fixed config\n\ngo on",
		);
		const r = store.createTask("stopped, then resumed");
		store.updateTask(r.id, {
			state: "needs_you",
			needsReason: "Turn stopped.",
			pendingPrompt: "use the fixed config",
			pendingBy: "user",
		});
		await post(`/api/projects/p1/tasks/${r.id}/reply`, { text: "." });
		expect(store.getTask(r.id)?.pendingPrompt).toBe("use the fixed config");
	});

	test("star toggles the flag and rejects a non-boolean body", async () => {
		const t = store.createTask("pin me");
		expect(store.getTask(t.id)?.starred).toBe(false);
		const res = await post(`/api/projects/p1/tasks/${t.id}/star`, {
			starred: true,
		});
		expect(res.status).toBe(200);
		expect(store.getTask(t.id)?.starred).toBe(true);
		const bad = await post(`/api/projects/p1/tasks/${t.id}/star`, {
			starred: "yes",
		});
		expect(bad.status).toBe(400);
	});
});

describe("interview routes", () => {
	test("post queues the interview once; existing rules answer not-needed", async () => {
		const res = await post("/api/projects/p1/interview", {});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ interview: "queued" });
		const task = store
			.listTasks()
			.find((t) => t.prompt.startsWith(RULES_INTERVIEW_MARKER));
		expect(task).toBeDefined();
		expect(task!.cancelledAt).toBeNull();
		// Idempotent while the first interview is live.
		const again = await post("/api/projects/p1/interview", {});
		expect(await again.json()).toEqual({ interview: "queued" });
		const count = store
			.listTasks()
			.filter((t) => t.prompt.startsWith(RULES_INTERVIEW_MARKER)).length;
		expect(count).toBe(1);

		// AGENTS.md present -> no interview.
		const agents = join(projectDir, "AGENTS.md");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(agents, "rules");
		try {
			const notNeeded = await post("/api/projects/p1/interview", {});
			expect(await notNeeded.json()).toEqual({ interview: "not-needed" });
		} finally {
			rmSync(agents);
		}
	});

	test("unknown project 404s", async () => {
		const res = await post("/api/projects/nope/interview", {});
		expect(res.status).toBe(404);
	});

	test("fix queues an alignment interview even when rules exist", async () => {
		// Retire the live interview card from the test above, as a finished interview would be.
		for (const t of store
			.listTasks()
			.filter((t) => t.prompt.startsWith(RULES_INTERVIEW_MARKER)))
			store.updateTask(t.id, { cancelledAt: Date.now(), stage: "done" });
		const agents = join(projectDir, "AGENTS.md");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(agents, "rules");
		try {
			const res = await post("/api/projects/p1/interview", { fix: true });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ interview: "queued" });
			const task = store
				.listTasks()
				.find((t) => t.prompt.startsWith(RULES_INTERVIEW_MARKER));
			expect(task).toBeDefined();
			expect(task!.prompt).toContain("already has an AGENTS.md");
			// Idempotent while that alignment card is live: still exactly one live interview.
			const again = await post("/api/projects/p1/interview", { fix: true });
			expect(await again.json()).toEqual({ interview: "queued" });
			const count = store
				.listTasks()
				.filter(
					(t) =>
						t.prompt.startsWith(RULES_INTERVIEW_MARKER) &&
						t.cancelledAt === null &&
						t.stage !== "done",
				).length;
			expect(count).toBe(1);
		} finally {
			rmSync(agents);
		}
	});
});

describe("board check route", () => {
	const check = async (project = "p1") => {
		const res = await post(`/api/projects/${project}/board-check`, {});
		const b: unknown = await res.json();
		const id =
			typeof b === "object" && b !== null && "id" in b ? String(b.id) : "";
		return { status: res.status, id };
	};

	test("files one marked check card, reopens the live one, and files a new one after Done", async () => {
		const first = await check();
		expect(first.status).toBe(200);
		expect(store.getTask(first.id)?.prompt).toBe(BOARD_CHECK_PROMPT);
		expect(store.boardCheckId()).toBe(first.id);
		// A second click opens the live check instead of starting a parallel one.
		expect((await check()).id).toBe(first.id);
		store.updateTask(first.id, { stage: "done", state: "idle" });
		const next = await check();
		expect(next.id).not.toBe(first.id);
		expect(store.boardCheckId()).toBe(next.id);
		// A cancelled check does not block the next one either.
		store.updateTask(next.id, { cancelledAt: Date.now(), state: "idle" });
		expect((await check()).id).not.toBe(next.id);
		expect((await check("nope")).status).toBe(404);
	});
});

describe("settings routes", () => {
	test("maxTotal: a positive integer or null lands in shared", async () => {
		const low = await post("/api/settings", { maxTotal: 0 });
		expect(low.status).toBe(400);
		expect(await errorOf(low)).toBe(
			"maxTotal must be a positive integer or null",
		);
		const ok = await post("/api/settings", { maxTotal: 17 });
		expect(ok.status).toBe(200);
		const b: unknown = await ok.json();
		const maxTotal =
			typeof b === "object" && b !== null && "maxTotal" in b
				? Number(b.maxTotal)
				: -1;
		expect(maxTotal).toBe(17);
		expect(shared.maxTotalRuns).toBe(17);
		const uncapped = await post("/api/settings", { maxTotal: null });
		expect(uncapped.status).toBe(200);
		expect(shared.maxTotalRuns).toBeNull();
	});

	test("reviewCheck must be a boolean and lands in shared", async () => {
		const bad = await post("/api/settings", { reviewCheck: "yes" });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe("reviewCheck must be a boolean");
		const off = await post("/api/settings", { reviewCheck: false });
		expect(off.status).toBe(200);
		expect(await off.json()).toEqual({
			maxTotal: shared.maxTotalRuns,
			reviewCheck: false,
			workCheck: shared.workCheck,
			idleReviews: shared.idleReviews,
		});
		expect(shared.reviewCheck).toBe(false);
	});

	test("empty settings body is a valid no-op", async () => {
		const before = {
			maxTotal: shared.maxTotalRuns,
			reviewCheck: shared.reviewCheck,
			workCheck: shared.workCheck,
			idleReviews: shared.idleReviews,
		};
		const ok = await post("/api/settings", {});
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual(before);
	});

	test("workCheck must be a boolean and lands in shared", async () => {
		const bad = await post("/api/settings", { workCheck: "yes" });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe("workCheck must be a boolean");
		const off = await post("/api/settings", {
			reviewCheck: false,
			workCheck: false,
		});
		expect(off.status).toBe(200);
		expect(await off.json()).toEqual({
			maxTotal: shared.maxTotalRuns,
			reviewCheck: false,
			workCheck: false,
			idleReviews: shared.idleReviews,
		});
		expect(shared.workCheck).toBe(false);
	});

	test("idleReviews must be a boolean, lands in shared, and persists", async () => {
		const m = mount({ projects: new Map() });
		const bad = await m.call("/api/settings", { idleReviews: "yes" });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe("idleReviews must be a boolean");
		const off = await m.call("/api/settings", { idleReviews: false });
		expect(off.status).toBe(200);
		expect(await off.json()).toEqual({
			maxTotal: 3,
			reviewCheck: true,
			workCheck: true,
			idleReviews: false,
		});
		// The state payload exposes it for the Settings switch.
		const state = (await (await m.call("/api/state")).json()) as {
			idleReviews: boolean;
		};
		expect(state.idleReviews).toBe(false);
		// saveConfig persists it in the gstore config blob.
		const cfg = m.g.get<{ idleReviews?: unknown }>("config");
		expect(cfg?.idleReviews).toBe(false);
	});

	test("idleReviews defaults to true on a fresh app", async () => {
		const m = mount({ projects: new Map() });
		const state = (await (await m.call("/api/state")).json()) as {
			idleReviews: boolean;
		};
		expect(state.idleReviews).toBe(true);
	});

	test("maxParallel: a positive integer or null persists", async () => {
		const low = await post("/api/projects/p1/settings", { maxParallel: 0 });
		expect(low.status).toBe(400);
		expect(await errorOf(low)).toBe(
			"maxParallel must be a positive integer or null",
		);
		const ok = await post("/api/projects/p1/settings", { maxParallel: 9 });
		expect(ok.status).toBe(200);
		expect(store.getSettings().maxParallel).toBe(9);
		const uncapped = await post("/api/projects/p1/settings", {
			maxParallel: null,
		});
		expect(uncapped.status).toBe(200);
		expect(store.getSettings().maxParallel).toBeNull();
	});

	test("iconText: a string or null, at most 4 characters, empty becomes null", async () => {
		const tooLong = await post("/api/projects/p1/settings", {
			iconText: "TOOLONG",
		});
		expect(tooLong.status).toBe(400);
		expect(await errorOf(tooLong)).toBe(
			"iconText must be at most 4 characters",
		);
		const badType = await post("/api/projects/p1/settings", { iconText: 7 });
		expect(badType.status).toBe(400);
		expect(await errorOf(badType)).toBe("iconText must be a string or null");
		const ok = await post("/api/projects/p1/settings", { iconText: " OT " });
		expect(ok.status).toBe(200);
		expect(store.getSettings().iconText).toBe("OT");
		const empty = await post("/api/projects/p1/settings", { iconText: "  " });
		expect(empty.status).toBe(200);
		expect(store.getSettings().iconText).toBeNull();
	});

	test("taskIdPrefix validates, persists, and overrides the derived task id handle", async () => {
		const ok = await post("/api/projects/p1/settings", { taskIdPrefix: "chs" });
		expect(ok.status).toBe(200);
		expect(store.getSettings().taskIdPrefix).toBe("CHS");
		const body = (await ok.json()) as { taskPrefix?: string };
		expect(body.taskPrefix).toBe("CHS");
		expect(store.createTask("with override").id).toMatch(/^CHS-[0-9]+$/);
		const clear = await post("/api/projects/p1/settings", { taskIdPrefix: "" });
		expect(clear.status).toBe(200);
		expect(store.getSettings().taskIdPrefix).toBeNull();
		const cleared = (await clear.json()) as { taskPrefix?: string };
		expect(cleared.taskPrefix).toBe("P1");
		expect(store.createTask("derived again").id).toMatch(/^P1-[0-9]+$/);
		const bad1 = await post("/api/projects/p1/settings", {
			taskIdPrefix: "ch st",
		});
		expect(bad1.status).toBe(400);
		expect(await errorOf(bad1)).toBe(
			"taskIdPrefix must be 1 to 8 letters and digits",
		);
		const bad2 = await post("/api/projects/p1/settings", {
			taskIdPrefix: "ABCDEFGHIJKLMNOP",
		});
		expect(bad2.status).toBe(400);
		expect(await errorOf(bad2)).toBe(
			"taskIdPrefix must be 1 to 8 letters and digits",
		);
		const wrongType = await post("/api/projects/p1/settings", {
			taskIdPrefix: 5,
		});
		expect(wrongType.status).toBe(400);
		expect(await errorOf(wrongType)).toBe(
			"taskIdPrefix must be a string or null",
		);
	});

	test("auto-tend settings validate and round-trip through the project settings route", async () => {
		const ok = await post("/api/projects/p1/settings", {
			autoTend: true,
			autoTendLimit: 3,
			tendChurnGlobs: ["*.log"],
		});
		expect(ok.status).toBe(200);
		const body: unknown = await ok.json();
		expect(
			typeof body === "object" && body !== null && "settings" in body
				? body.settings
				: undefined,
		).toMatchObject({
			autoTend: true,
			autoTendLimit: 3,
			tendChurnGlobs: ["*.log"],
		});
		const bad = await post("/api/projects/p1/settings", { autoTend: "yes" });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe("autoTend must be a boolean");
	});

	test("retro maps onto retroSince: on sets it once, re-save keeps it, off clears it; retroFilter passes through", async () => {
		// A pre-existing mark must survive a re-save while on (no sleep: the stored
		// timestamp itself is the assertion).
		store.setSettings({ retroSince: 12345 });
		const on = await post("/api/projects/p1/settings", { retro: true });
		expect(on.status).toBe(200);
		expect(store.getSettings().retroSince).toBe(12345);
		// Off clears the mark; retroFilter rides along in the same body.
		const off = await post("/api/projects/p1/settings", {
			retro: false,
			retroFilter: false,
		});
		expect(off.status).toBe(200);
		expect(store.getSettings().retroSince).toBeNull();
		expect(store.getSettings().retroFilter).toBe(false);
		// A patch without retro leaves retroSince untouched.
		await post("/api/projects/p1/settings", { retroFilter: true });
		expect(store.getSettings().retroSince).toBeNull();
		// Non-boolean values and unknown keys: retro validates, anything else is ignored.
		const bad = await post("/api/projects/p1/settings", { retro: "yes" });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe("retro must be a boolean");
		const badFilter = await post("/api/projects/p1/settings", {
			retroFilter: 1,
		});
		expect(badFilter.status).toBe(400);
		expect(await errorOf(badFilter)).toBe("retroFilter must be a boolean");
		const unknown = await post("/api/projects/p1/settings", {
			retroScope: "everything",
		});
		expect(unknown.status).toBe(200);
		expect(store.getSettings()).not.toHaveProperty("retroScope");
	});

	test("adding a project persists its path; removing drops it", async () => {
		// A fixture that carries AGENTS.md: no rules interview queues, so remove's
		// active-task guard passes without opening the store behind the app's back —
		// its SQLite exclusive lock forbids a second direct open.
		makeFixture("persist-me");
		writeFileSync(join(fixtureRepos, "persist-me", "AGENTS.md"), "rules");
		// Clones carry committed files only: the rules file must be in the fixture's commit.
		execSync("git add AGENTS.md && git commit -qm rules", {
			cwd: join(fixtureRepos, "persist-me"),
			stdio: "ignore",
		});
		const res = await post("/api/projects", {
			url: "https://github.com/octo/persist-me",
		});
		expect(res.status).toBe(200);
		expect(shared.projectPaths).toContain(join(root, "persist-me"));
		const rm = await post("/api/projects/persist-me/remove", {});
		expect(rm.status).toBe(200);
		expect(shared.projectPaths).not.toContain(join(root, "persist-me"));
	});

	test("adding a gitless project succeeds and stays blocked until init", async () => {
		// An empty fixture repo clones with no commit: the gitless path of the url branch.
		makeFixture("gitless-proj", true);
		const dir = join(root, "gitless-proj");
		const add = await post("/api/projects", {
			// No .git suffix: insteadOf rewrites the prefix verbatim, so the fixture dir name
			// is the whole remainder of the URL.
			url: "https://github.com/octo/gitless-proj",
		});
		expect(add.status).toBe(200);
		// Our own API's documented response shape; no runtime validator exists in this suite.
		const added = (await add.json()) as AddProjectResponse;
		expect(added.project.gitless).toBe(true);
		expect(added.interview).toBe("gitless");

		// Actions are blocked while gitless: one write route, one read route.
		const task = await post("/api/projects/gitless-proj/tasks", {
			prompt: "nope",
		});
		expect(task.status).toBe(409);
		expect(await errorOf(task)).toBe("init a git repository first");
		const settings = await post("/api/projects/gitless-proj/settings", {});
		expect(settings.status).toBe(409);
		expect(await errorOf(settings)).toBe("init a git repository first");
		// The interview route is blocked too: the turn machinery needs a HEAD.
		const iv = await post("/api/projects/gitless-proj/interview", {});
		expect(iv.status).toBe(409);

		// Init: git-inits, commits, and queues the interview.
		const init = await post("/api/projects/gitless-proj/init", {});
		expect(init.status).toBe(200);
		// Our own API's documented response shape; no runtime validator exists in this suite.
		const inited = (await init.json()) as AddProjectResponse;
		expect(inited.project.gitless).toBe(false);
		expect(inited.interview).toBe("queued");
		const head = execSync("git rev-parse HEAD", {
			cwd: dir,
			encoding: "utf8",
		}).trim();
		expect(head).toMatch(/^[0-9a-f]{40}$/);

		// Init again is refused: the repo now has a commit.
		const again = await post("/api/projects/gitless-proj/init", {});
		expect(again.status).toBe(409);
		expect(await errorOf(again)).toBe("already a git repository");

		// The init queued the rules interview; settle it so remove's active-task guard passes.
		// The entry's own store: a second open would fight the exclusive instance lock.
		const gs = projects.get("gitless-proj")!.store;
		const interviewTask = gs.listTasks().at(-1);
		expect(interviewTask?.prompt.startsWith(RULES_INTERVIEW_MARKER)).toBe(true);
		gs.updateTask(interviewTask!.id, {
			cancelledAt: Date.now(),
			state: "idle",
			stage: "done",
		});

		const rm2 = await post("/api/projects/gitless-proj/remove", {});
		expect(rm2.status).toBe(200);
	});

	test("adding a new project creates the folder under the default dir and registers it", async () => {
		const dest = join(root, "fresh");
		const res = await post("/api/projects", { name: "fresh" });
		expect(res.status).toBe(200);
		// Every new project opens with the setup checklist.
		const added = (await res.json()) as {
			project: { settings: { setupChecklist: boolean } };
		};
		expect(added.project.settings.setupChecklist).toBe(true);
		expect(shared.projectPaths).toContain(dest);
		expect(projects.get("fresh")?.path).toBe(dest);
		// The handler initialized a repo with a commit, even without a global git identity.
		const head = execSync("git rev-parse HEAD", {
			cwd: dest,
			encoding: "utf8",
		}).trim();
		expect(head).toMatch(/^[0-9a-f]{40}$/);

		// Guards, in validation order.
		const bad = await post("/api/projects", { name: "a/b" });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe(
			"name must be a folder name without path separators",
		);
		const neither = await post("/api/projects", {});
		expect(neither.status).toBe(400);
		expect(await errorOf(neither)).toBe("provide a git URL or a project name");
		const dup = await post("/api/projects", { name: "fresh" });
		expect(dup.status).toBe(400);
		expect(await errorOf(dup)).toBe("path already exists");
	});

	test("cloning a url lands under the default dir", async () => {
		makeFixture("clone-me");
		writeFileSync(join(fixtureRepos, "clone-me", "AGENTS.md"), "rules");
		const res = await post("/api/projects", {
			url: "https://github.com/octo/clone-me",
		});
		expect(res.status).toBe(200);
		// Our own API's documented response shape; no runtime validator exists in this suite.
		const added = (await res.json()) as AddProjectResponse;
		expect(added.project.path).toBe(join(root, "clone-me"));
	});

	test("a missing projects directory is a 400", async () => {
		const m = mount({ defaultDir: join(root, "no-such-dir") });
		const res = await m.call("/api/projects", { name: "x" });
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("projects directory does not exist");
	});
});

describe("production mode", () => {
	const server2 = Bun.serve({
		port: 0,
		...createApp({
			gstore,
			defaultDir: root,
			projects,
			...loopStubs(),
			schedule: () => {
				calls++;
			},
			serverVersion: "test",
			port: 0,
			publicHosts: [],
			shared,
			serverRef: { current: undefined },
			prod: true,
		}).serveOptions,
	});

	afterAll(() => {
		server2.stop(true);
	});

	test("/api/boot reports live by default", async () => {
		const res = await fetch(new URL("/api/boot", server.url), {
			headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
		});
		expect(res.status).toBe(200);
		const b = (await res.json()) as { live?: boolean };
		expect(b.live).toBe(true);
	});

	test("prod app reports live: false and refuses /api/ws", async () => {
		const boot = await fetch(new URL("/api/boot", server2.url), {
			headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
		});
		expect(boot.status).toBe(200);
		const b = (await boot.json()) as { live?: boolean };
		expect(b.live).toBe(false);

		const ws = await fetch(new URL("/api/ws", server2.url), {
			headers: {
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
				Upgrade: "websocket",
				Connection: "Upgrade",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version": "13",
			},
		});
		expect(ws.status).toBe(404);
		expect(await errorOf(ws)).toBe(
			"live updates are disabled in production mode",
		);
	});
});

describe("alate routes", () => {
	type AlateReq = {
		method: string;
		url: string;
		auth: string | null;
		body?: unknown;
	};
	let lastAlateReq: AlateReq | null = null;
	// Some tests need more than the last request: a pull is never the only
	// provider call a test wants to inspect.
	let alateReqs: AlateReq[] = [];
	let alateDelay = 0;
	// When set, the fake answers every path with a 302 to this origin: the
	// redirect-following tests point it at a target that records what it sees.
	let alateRedirect: string | null = null;
	let alateStatus = 200;
	let alateBody: unknown = {
		ok: true,
		results: [{ script: "sync.mjs", code: 0, output: "out", truncated: false }],
	};
	const fakeAlate = Bun.serve({
		port: 0,
		fetch: async (req) => {
			if (alateDelay > 0) await Bun.sleep(alateDelay);
			if (alateRedirect !== null) return Response.redirect(alateRedirect, 302);
			const reqBody = await req.json().catch(() => undefined);
			const entry: AlateReq = {
				method: req.method,
				url: new URL(req.url).pathname,
				auth: req.headers.get("authorization"),
				...(reqBody === undefined ? {} : { body: reqBody }),
			};
			lastAlateReq = entry;
			alateReqs.push(entry);
			return Response.json(alateBody, { status: alateStatus });
		},
	});
	afterAll(() => {
		fakeAlate.stop(true);
	});
	const alateUrl = fakeAlate.url.origin;

	test("GET before any config returns null url and keySet false", async () => {
		const res = await get("/api/alate");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			url: null,
			keySet: false,
			lastProvisionError: null,
		});
	});

	test("POST saves url and key; GET returns keySet true without the key", async () => {
		const res = await post("/api/alate", {
			url: alateUrl,
			key: "alate_secret",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			url: alateUrl,
			keySet: true,
			lastProvisionError: null,
		});
		const raw = await (await get("/api/alate")).text();
		expect(raw).not.toContain("alate_secret");
	});

	test("POST rejects wrong types, control chars, and non-http(s) urls", async () => {
		expect((await post("/api/alate", { key: 42 })).status).toBe(400);
		expect((await post("/api/alate", { url: "a\u0000b" })).status).toBe(400);
		const ftp = await post("/api/alate", { url: "ftp://x" });
		expect(ftp.status).toBe(400);
		expect(await errorOf(ftp)).toBe("url must be a valid http(s) URL");
	});

	test("trailing-slash url is stored stripped", async () => {
		await post("/api/alate", { url: "http://127.0.0.1:9/" });
		expect((await (await get("/api/alate")).json()).url).toBe(
			"http://127.0.0.1:9",
		);
		await post("/api/alate", { url: alateUrl });
	});

	test("provision happy path posts bearer auth to alate", async () => {
		const res = await post("/api/alate/provision", {});
		expect(res.status).toBe(200);
		expect(lastAlateReq).toEqual({
			method: "POST",
			url: "/provision",
			auth: "Bearer alate_secret",
		});
		expect(await res.json()).toEqual({
			ok: true,
			results: [
				{ script: "sync.mjs", code: 0, output: "out", truncated: false },
			],
		});
	});

	test("provision without url or key is 400", async () => {
		await post("/api/alate", { url: null });
		const noUrl = await post("/api/alate/provision", {});
		expect(noUrl.status).toBe(400);
		expect(await errorOf(noUrl)).toBe("alate server url is not configured");
		await post("/api/alate", { url: alateUrl, key: null });
		const noKey = await post("/api/alate/provision", {});
		expect(noKey.status).toBe(400);
		expect(await errorOf(noKey)).toBe("alate api key is not configured");
		await post("/api/alate", { key: "alate_secret" });
	});

	test("alate non-2xx error is forwarded with status and error", async () => {
		alateStatus = 401;
		alateBody = { error: "unauthorized" };
		const res = await post("/api/alate/provision", {});
		expect(res.status).toBe(401);
		expect(await errorOf(res)).toBe("unauthorized");
		alateStatus = 200;
		alateBody = {
			ok: true,
			results: [
				{ script: "sync.mjs", code: 0, output: "out", truncated: false },
			],
		};
	});

	test("unreachable alate is 502", async () => {
		await post("/api/alate", { url: "http://127.0.0.1:9" });
		const res = await post("/api/alate/provision", {});
		expect(res.status).toBe(502);
		expect(await errorOf(res)).toContain("cannot reach alate server");
		await post("/api/alate", { url: alateUrl });
	});

	// AbortSignal.timeout rejects with a TimeoutError when the 110 s bound fires.
	// Reject like that directly instead of waiting 110 s. The follow-up `/health`
	// probe reaches the fake, unless `healthDown` times it out too.
	async function provisionAfterTimeout(healthDown = false): Promise<Response> {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const path = new URL(String(input)).pathname;
			if (path === "/provision" || (healthDown && path === "/health")) {
				const err = new Error("The operation was aborted due to timeout");
				err.name = "TimeoutError";
				throw err;
			}
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			return await post("/api/alate/provision", {});
		} finally {
			globalThis.fetch = realFetch;
		}
	}

	test("a timed-out provision that alate's health reports running is 202 running", async () => {
		const prev = alateBody;
		alateBody = { ok: true, running: true };
		try {
			const res = await provisionAfterTimeout();
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ running: true });
		} finally {
			alateBody = prev;
		}
	});

	test("a timeout before any response is 504, never running", async () => {
		// A black-holed host times out in connect: nothing proves alate got the POST.
		const down = await provisionAfterTimeout(true);
		expect(down.status).toBe(504);
		expect(await errorOf(down)).toContain("alate did not answer");
		// alate answers health but runs no provision: the POST never started a run.
		const prev = alateBody;
		alateBody = { ok: true, running: false };
		try {
			const idle = await provisionAfterTimeout();
			expect(idle.status).toBe(504);
			expect(await errorOf(idle)).toContain("reports no running provision");
		} finally {
			alateBody = prev;
		}
	});

	test("a redirecting alate never forwards the bearer; the 3xx is an error", async () => {
		// The host the redirect points at: it must never see a request at all,
		// because both authenticated paths refuse to follow the redirect.
		let bounceAuth: string | null | undefined;
		const bounce = Bun.serve({
			port: 0,
			fetch: (req) => {
				bounceAuth = req.headers.get("authorization");
				return Response.json({});
			},
		});
		const errors: string[] = [];
		const origError = console.error;
		console.error = (...parts: unknown[]) => errors.push(parts.join(" "));
		try {
			alateRedirect = bounce.url.origin;
			await post("/api/alate", { url: alateUrl, key: "alate_secret" });
			const res = await post("/api/alate/provision", {});
			expect(res.status).toBe(502);
			expect(await errorOf(res)).toContain("redirect not followed");
			// The pull fails the same way; the route keeps the last good result.
			expect((await post("/api/updates/refresh", {})).status).toBe(200);
		} finally {
			alateRedirect = null;
			console.error = origError;
			bounce.stop(true);
		}
		expect(bounceAuth).toBeUndefined();
		expect(
			errors.some(
				(e) =>
					e.includes("updates pull failed") &&
					e.includes("redirect not followed"),
			),
		).toBe(true);
	});

	test("concurrent provision is 409", async () => {
		// Real timers required: the flag lives in the live server process and the fake
		// alate must hold it for real wall-clock time; fake timers cannot advance either.
		alateDelay = 300;
		const slow = post("/api/alate/provision", {});
		const gate = Promise.withResolvers<void>();
		setTimeout(gate.resolve, 50);
		await gate.promise;
		const second = await post("/api/alate/provision", {});
		expect(second.status).toBe(409);
		expect(await errorOf(second)).toBe("provisioning already running");
		expect((await slow).status).toBe(200);
		alateDelay = 0;
	});

	test("health proxies the alate /health payload", async () => {
		alateBody = {
			ok: true,
			running: false,
			version: "abc1234",
			update: { enabled: true, lastChecked: null, behind: true },
		};
		const res = await get("/api/alate/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(alateBody);
		expect(lastAlateReq).toEqual({
			method: "GET",
			url: "/health",
			auth: null,
		});
		alateBody = {
			ok: true,
			results: [
				{ script: "sync.mjs", code: 0, output: "out", truncated: false },
			],
		};
	});

	test("health without url is 400", async () => {
		await post("/api/alate", { url: null });
		const res = await get("/api/alate/health");
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("alate server url is not configured");
		await post("/api/alate", { url: alateUrl });
	});

	test("health unreachable is 502", async () => {
		await post("/api/alate", { url: "http://127.0.0.1:9" });
		const res = await get("/api/alate/health");
		expect(res.status).toBe(502);
		expect(await errorOf(res)).toContain("cannot reach alate server");
		await post("/api/alate", { url: alateUrl });
	});

	test("a bad later key leaves the live config untouched (R1-10)", async () => {
		// Old code wrote each key as it validated: url landed live, then the bad key 400'd,
		// and health/provision used the new url until a restart restored the persisted value.
		const before = await (await get("/api/alate")).json();
		const res = await post("/api/alate", {
			url: "http://127.0.0.1:1",
			key: 42,
		});
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("key must be a string or null");
		expect(await (await get("/api/alate")).json()).toEqual(before);
		// And a bad URL alone does not clobber the stored key either.
		const badUrl = await post("/api/alate", { url: "ftp://x", key: null });
		expect(badUrl.status).toBe(400);
		expect((await (await get("/api/alate")).json()).keySet).toBe(true);
	});

	// Shares the fake alate and the get/post helpers: /api/updates is one more path the
	// fake answers, and the updates flow reuses this describe's config round-trips.
	describe("updates routes", () => {
		const iso = "2026-10-13T08:00:00Z";
		const goodRec = {
			id: "octo/repo@v2",
			name: "Repo pin",
			kind: "image-pin",
			origin: "https://github.com/octo/repo",
			repo: "octo/repo",
			pin: { file: "agent-data/workers/ottr.yml", key: "image" },
			current: "v1",
			latest: "v2",
			target: "v2",
			publishedAt: "2026-10-01T00:00:00Z",
			qualifiesAt: "2026-10-02T00:00:00Z",
			notesUrl: "https://github.com/octo/repo/releases/tag/v2",
		};
		const otherRec = {
			...goodRec,
			id: "nobody/else@v3",
			repo: "nobody/else",
			name: "Other pin",
			target: null,
		};
		type UpdatesJson = {
			checkedAt: string;
			rows: Array<{ id: string; project: string | null }>;
		};
		const stateUpdates = async (): Promise<UpdatesJson | null> =>
			(
				(await (await get("/api/state")).json()) as {
					updates: UpdatesJson | null;
				}
			).updates;
		// Test-side reader for the updates view our own routes produce.
		const readView = (res: Response): Promise<UpdatesJson> =>
			res.json() as Promise<UpdatesJson>;
		const envelope = (updates: unknown): unknown => ({
			checkedAt: iso,
			updates,
		});
		afterAll(() => {
			// Leave the shared store and closure clean for later describes.
			gstore.set("updateSkips", []);
			gstore.set("updatesPush", null);
			gstore.set("updates", null);
			saveSubs(gstore, []);
			alateBody = {
				ok: true,
				results: [
					{ script: "sync.mjs", code: 0, output: "out", truncated: false },
				],
			};
		});

		test("refresh validates, maps repos, and hits alate with the bearer key", async () => {
			await post("/api/alate", { url: alateUrl, key: "alate_secret" });
			const p1 = projects.get("p1")!;
			p1.github = "https://github.com/Octo/Repo.GIT";
			try {
				alateBody = envelope([
					goodRec,
					otherRec,
					// Already at latest (current === latest): the refresh drops it, never stored.
					{
						...goodRec,
						id: "octo/repo@v1",
						current: "v1",
						latest: "v1",
						target: null,
					},
					{ ...goodRec, id: "bad/kind@1", kind: "bogus" },
					{ ...goodRec, id: "bad/origin@1", origin: "ftp://x/y" },
					{ ...goodRec, id: "bad/name@1", name: "x".repeat(201) },
					{ ...goodRec, id: "bad/iso@1", publishedAt: "yesterday" },
					{ ...goodRec, id: "bad/target@1", target: 7 },
				]);
				const res = await post("/api/updates/refresh", {});
				expect(res.status).toBe(200);
				const view = await readView(res);
				expect(view.checkedAt).toBe(iso);
				expect(view.rows.map((r) => [r.id, r.project])).toEqual([
					[goodRec.id, "p1"],
					[otherRec.id, null],
				]);
				expect(await stateUpdates()).toEqual(view);
				expect(lastAlateReq).toEqual({
					method: "GET",
					url: "/api/updates",
					auth: "Bearer alate_secret",
				});
			} finally {
				p1.github = null;
			}
		});

		test("a bad envelope keeps the previous good rows", async () => {
			alateBody = "nope";
			const res = await post("/api/updates/refresh", {});
			expect(res.status).toBe(200);
			expect((await readView(res)).rows.map((r) => r.id)).toEqual([
				goodRec.id,
				otherRec.id,
			]);
			alateBody = envelope([goodRec, otherRec]);
		});

		test("skip hides a row from state and refresh; unknown id is 400", async () => {
			const skip = await post("/api/updates/skip", { id: otherRec.id });
			expect(skip.status).toBe(200);
			expect((await readView(skip)).rows.map((r) => r.id)).toEqual([
				goodRec.id,
			]);
			expect((await stateUpdates())!.rows.map((r) => r.id)).toEqual([
				goodRec.id,
			]);
			expect((await post("/api/updates/skip", { id: "nope@1" })).status).toBe(
				400,
			);
			expect((await post("/api/updates/skip", { id: 7 })).status).toBe(400);
			gstore.set("updateSkips", []);
		});

		test("a board skip hides the row after a pull and posts no decision", async () => {
			alateReqs = [];
			alateBody = envelope([goodRec, otherRec]);
			await post("/api/updates/refresh", {});
			const skip = await post("/api/updates/skip", { id: otherRec.id });
			expect(skip.status).toBe(200);
			expect((await readView(skip)).rows.map((r) => r.id)).toEqual([
				goodRec.id,
			]);
			// The next pull keeps the row hidden and never forwards the decision:
			// the only provider request is the pull itself.
			alateReqs = [];
			await post("/api/updates/refresh", {});
			expect((await stateUpdates())!.rows.map((r) => r.id)).toEqual([
				goodRec.id,
			]);
			expect(alateReqs).toEqual([
				{ method: "GET", url: "/api/updates", auth: "Bearer alate_secret" },
			]);
			gstore.set("updateSkips", []);
		});

		test("a pending decision from the old store migrates to a skip and still hides its row", async () => {
			const oldId = "octo/repo@vOld";
			const oldG = GlobalStore.open(join(root, "g-old-pending"));
			oldG.set("updateDecisionsPending", [{ id: oldId, decision: "skipped" }]);
			oldG.set("updates", {
				checkedAt: iso,
				updates: [goodRec, { ...goodRec, id: oldId }],
			});
			const m = mount({ gstore: oldG });
			// Boot migrated the queued skip into the plain skip store…
			expect(loadSkips(oldG)).toEqual([oldId]);
			expect(oldG.get<unknown[]>("updateDecisionsPending")).toEqual([]);
			// …so the state view hides the row.
			const state = (await (await m.call("/api/state")).json()) as {
				updates: { rows: Array<{ id: string }> } | null;
			};
			expect(state.updates!.rows.map((r) => r.id)).toEqual([goodRec.id]);
		});

		test("push fires once per day; a skipped qualified id does not count", async () => {
			pushSends.length = 0;
			gstore.set("updatesPush", { date: "2000-01-01", ids: [] });
			saveSubs(gstore, [
				{
					endpoint: "https://push.test/ep1",
					keys: { p256dh: "k", auth: "a" },
					addedAt: 0,
				},
			]);
			alateBody = envelope([goodRec, otherRec]);
			await post("/api/updates/refresh", {});
			expect(pushSends.length).toBe(1);
			expect(JSON.parse(pushSends[0]!.payload)).toEqual({
				title: "Upstream updates",
				body: "1 upstream update(s) ready",
				tag: "updates",
				url: "/",
			});
			// Same day, a new qualified id: the day is already consumed.
			alateBody = envelope([
				goodRec,
				otherRec,
				{ ...goodRec, id: "octo/repo@v4", latest: "v4", target: "v4" },
			]);
			await post("/api/updates/refresh", {});
			expect(pushSends.length).toBe(1);
			// Next day, only a skipped id is left: no push.
			gstore.set("updatesPush", { date: "2000-01-01", ids: [goodRec.id] });
			await post("/api/updates/skip", { id: goodRec.id });
			alateBody = envelope([goodRec]);
			await post("/api/updates/refresh", {});
			expect(pushSends.length).toBe(1);
		});

		// U6/U7: POST /api/updates/allow files update cards; the merge hold approves via reply.
		test("allow groups same-project ids into one card with updateIds and the validated prompt", async () => {
			const p1 = projects.get("p1")!;
			p1.github = "https://github.com/Octo/Repo.GIT";
			try {
				const second = {
					...goodRec,
					id: "octo/repo@v3",
					latest: "v3",
					target: "v3",
					notesUrl: "https://github.com/octo/repo/releases/tag/v3",
				};
				alateBody = envelope([goodRec, second]);
				await post("/api/updates/refresh", {});
				const res = await post("/api/updates/allow", {
					ids: [goodRec.id, second.id],
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					tasks: Array<{ project: string; id: string }>;
				};
				// Both ids land on ONE card for the mapped project.
				expect(body.tasks).toEqual([{ project: "p1", id: body.tasks[0]!.id }]);
				const task = p1.store.getTask(body.tasks[0]!.id)!;
				expect(task.updateIds).toEqual([goodRec.id, second.id]);
				expect(task.prompt).toContain("Repo pin: v1 -> v2");
				expect(task.prompt).toContain(
					`notes: ${goodRec.notesUrl} (pin ${goodRec.pin.file}:${goodRec.pin.key})`,
				);
			} finally {
				p1.github = null;
			}
		});

		test("propose now creates a card from latest with the G21 line", async () => {
			const p1 = projects.get("p1")!;
			p1.github = "https://github.com/Octo/Repo.GIT";
			try {
				const young = {
					...goodRec,
					id: "octo/repo@v5",
					target: null,
					latest: "v5",
				};
				alateBody = envelope([young]);
				await post("/api/updates/refresh", {});
				const res = await post("/api/updates/allow", {
					ids: [young.id],
					propose: true,
				});
				expect(res.status).toBe(200);
				const { tasks } = (await res.json()) as {
					tasks: Array<{ id: string }>;
				};
				const task = p1.store.getTask(tasks[0]!.id)!;
				expect(task.prompt).toContain("-> v5,");
				expect(task.prompt).toContain("(a G21 exception)");
			} finally {
				p1.github = null;
			}
		});

		test("allow validates ids, targets, mapping, and open coverage", async () => {
			const p1 = projects.get("p1")!;
			p1.github = "https://github.com/Octo/Repo.GIT";
			try {
				alateBody = envelope([goodRec, otherRec]);
				await post("/api/updates/refresh", {});
				expect(
					(await post("/api/updates/allow", { ids: ["nope@1"] })).status,
				).toBe(400);
				// A managedBy row offers no actions (U5).
				const managed = {
					...goodRec,
					id: "octo/repo@m1",
					managedBy: "renovate",
				};
				alateBody = envelope([goodRec, otherRec, managed]);
				await post("/api/updates/refresh", {});
				expect(
					(await post("/api/updates/allow", { ids: [managed.id] })).status,
				).toBe(400);
				// A removed row (pinned path deleted upstream) files no card.
				const removed = {
					...goodRec,
					id: "octo/repo@rm1",
					target: null,
					removed: true as const,
				};
				alateBody = envelope([goodRec, otherRec, managed, removed]);
				await post("/api/updates/refresh", {});
				expect(
					(await post("/api/updates/allow", { ids: [removed.id] })).status,
				).toBe(400);
				expect((await post("/api/updates/allow", { ids: "x" })).status).toBe(
					400,
				);
				// Unmapped repo.
				expect(
					(await post("/api/updates/allow", { ids: [otherRec.id] })).status,
				).toBe(400);
				// Allow needs a qualified target.
				const young = {
					...goodRec,
					id: "octo/repo@v5",
					target: null,
					latest: "v5",
				};
				alateBody = envelope([young]);
				await post("/api/updates/refresh", {});
				expect(
					(await post("/api/updates/allow", { ids: [young.id] })).status,
				).toBe(400);
				// Propose refuses an already-qualified target. Fresh ids: earlier tests
				// in this describe left open cards that would otherwise cover goodRec.id.
				const fresh = {
					...goodRec,
					id: "octo/repo@v7",
					latest: "v7",
					target: "v7",
					notesUrl: "https://github.com/octo/repo/releases/tag/v7",
				};
				alateBody = envelope([fresh]);
				await post("/api/updates/refresh", {});
				expect(
					(await post("/api/updates/allow", { ids: [fresh.id] })).status,
				).toBe(200);
				expect(
					(
						await post("/api/updates/allow", {
							ids: [fresh.id],
							propose: true,
						})
					).status,
				).toBe(400);
				// The card just filed still covers the id: a second allow is 409.
				expect(
					(await post("/api/updates/allow", { ids: [fresh.id] })).status,
				).toBe(409);
			} finally {
				p1.github = null;
			}
		});

		test("remove files one card for a removed id and rejects the rest", async () => {
			const p1 = projects.get("p1")!;
			p1.github = "https://github.com/Octo/Repo.GIT";
			// Set the alate config here too: -t filtered runs skip the test that sets it.
			await post("/api/alate", { url: alateUrl, key: "alate_secret" });
			try {
				const removed = {
					...goodRec,
					id: "octo/repo@rm9",
					name: "resolving-merge-conflicts",
					kind: "skill",
					target: null,
					removed: true as const,
				};
				alateBody = envelope([goodRec, removed]);
				await post("/api/updates/refresh", {});
				// A not-removed id is rejected.
				expect(
					(await post("/api/updates/remove", { id: goodRec.id })).status,
				).toBe(400);
				// An unknown id is rejected.
				expect(
					(await post("/api/updates/remove", { id: "nope@1" })).status,
				).toBe(400);
				// A managedBy row offers no actions (U5).
				const managed = {
					...removed,
					id: "octo/repo@rm8",
					managedBy: "renovate",
				};
				alateBody = envelope([goodRec, removed, managed]);
				await post("/api/updates/refresh", {});
				expect(
					(await post("/api/updates/remove", { id: managed.id })).status,
				).toBe(400);
				// An unmapped repo is rejected.
				const elsewhere = {
					...removed,
					id: "elsewhere/other@rm7",
					repo: "nobody/else",
				};
				alateBody = envelope([removed, elsewhere]);
				await post("/api/updates/refresh", {});
				expect(
					(await post("/api/updates/remove", { id: elsewhere.id })).status,
				).toBe(400);
				const res = await post("/api/updates/remove", { id: removed.id });
				expect(res.status).toBe(200);
				const { tasks } = (await res.json()) as {
					tasks: Array<{ project: string; id: string }>;
				};
				expect(tasks).toEqual([{ project: "p1", id: tasks[0]!.id }]);
				const task = p1.store.getTask(tasks[0]!.id)!;
				expect(task.updateIds).toEqual([removed.id]);
				expect(task.prompt).toContain(
					"`npx skills remove 'resolving-merge-conflicts' -g -y`",
				);
				// A covered id is rejected: the open card owns the row, a second click files no duplicate.
				expect(
					(await post("/api/updates/remove", { id: removed.id })).status,
				).toBe(409);
			} finally {
				p1.github = null;
			}
		});

		test("a reply on a parked update card approves the parked head; other replies do not", async () => {
			const p1 = projects.get("p1")!;
			const held = p1.store.createTask("update pins");
			p1.store.updateTask(held.id, {
				updateIds: ["x@1"],
				needsReason: UPDATE_HOLD_REASON,
				state: "needs_you",
				holdHead: "sha-parked",
			});
			const res = await post(`/api/projects/p1/tasks/${held.id}/reply`, {
				text: "approved",
			});
			expect(res.status).toBe(200);
			const approved = p1.store.getTask(held.id)!;
			// stage merging + state queued: the scheduler picks it for a merge turn, not a work turn.
			expect(approved.stage).toBe("merging");
			expect(approved.state).toBe("queued");
			expect(approved.updateMergeHead).toBe("sha-parked");
			expect(approved.holdHead).toBeNull();
			// The approval itself queues no work prompt.
			expect(approved.pendingPrompt).toBeNull();
			// An agent can write the hold text itself (a needs_you question): no settle parked
			// a head, so the reply approves nothing.
			const forged = p1.store.createTask("update pins");
			p1.store.updateTask(forged.id, {
				updateIds: ["x@1"],
				needsReason: UPDATE_HOLD_REASON,
				state: "needs_you",
			});
			const fres = await post(`/api/projects/p1/tasks/${forged.id}/reply`, {
				text: "approved",
			});
			expect(fres.status).toBe(200);
			expect(p1.store.getTask(forged.id)!.updateMergeHead).toBeNull();
			// A change request keeps the work-reply path: a work turn with the text, the hold stays parked.
			const revise = p1.store.createTask("update pins");
			p1.store.updateTask(revise.id, {
				updateIds: ["x@1"],
				needsReason: UPDATE_HOLD_REASON,
				state: "needs_you",
				holdHead: "sha-parked",
				stage: "in_progress",
			});
			const rres = await post(`/api/projects/p1/tasks/${revise.id}/reply`, {
				text: "also bump the minor version",
			});
			expect(rres.status).toBe(200);
			const revised = p1.store.getTask(revise.id)!;
			expect(revised.stage).toBe("in_progress");
			expect(revised.state).toBe("queued");
			expect(revised.pendingPrompt).toBe("also bump the minor version");
			expect(revised.updateMergeHead).toBeNull();
			expect(revised.holdHead).toBe("sha-parked");
			// Control: a needs_you card with any other reason keeps the column null.
			const control = p1.store.createTask("other question");
			p1.store.updateTask(control.id, {
				needsReason: "something else",
				state: "needs_you",
				holdHead: "sha-parked",
			});
			const cres = await post(`/api/projects/p1/tasks/${control.id}/reply`, {
				text: "answered",
			});
			expect(cres.status).toBe(200);
			expect(p1.store.getTask(control.id)!.updateMergeHead).toBeNull();
			expect(p1.store.getTask(control.id)!.holdHead).toBe("sha-parked");
		});

		test("a reply on a parked merge-mismatch card approves the parked push head", async () => {
			const p1 = projects.get("p1")!;
			const held = p1.store.createTask("held merge");
			p1.store.updateTask(held.id, {
				updateIds: ["x@1"],
				needsReason: MERGE_HOLD_MISMATCH_REASON,
				state: "needs_you",
				holdHead: "sha-push",
			});
			const res = await post(`/api/projects/p1/tasks/${held.id}/reply`, {
				text: "approved",
			});
			expect(res.status).toBe(200);
			expect(p1.store.getTask(held.id)!.updateMergeHead).toBe("sha-push");
			expect(p1.store.getTask(held.id)!.holdHead).toBeNull();
			// A fork-born card parks the same way: the reply lands in forkMergeHead.
			const fork = p1.store.createTask("fork merge");
			p1.store.updateTask(fork.id, {
				needsReason: MERGE_HOLD_MISMATCH_REASON,
				state: "needs_you",
				holdHead: "sha-push-f",
			});
			const fres = await post(`/api/projects/p1/tasks/${fork.id}/reply`, {
				text: "approved",
			});
			expect(fres.status).toBe(200);
			expect(p1.store.getTask(fork.id)!.forkMergeHead).toBe("sha-push-f");
			expect(p1.store.getTask(fork.id)!.updateMergeHead).toBeNull();
			// No parked head: the reply approves nothing.
			const forged = p1.store.createTask("held merge");
			p1.store.updateTask(forged.id, {
				updateIds: ["x@1"],
				needsReason: MERGE_HOLD_MISMATCH_REASON,
				state: "needs_you",
			});
			const gres = await post(`/api/projects/p1/tasks/${forged.id}/reply`, {
				text: "approved",
			});
			expect(gres.status).toBe(200);
			expect(p1.store.getTask(forged.id)!.updateMergeHead).toBeNull();
		});

		test("a merge-mismatch park serves the stored push diff", async () => {
			const p1 = projects.get("p1")!;
			const held = p1.store.createTask("held merge");
			p1.store.updateTask(held.id, {
				needsReason: MERGE_HOLD_MISMATCH_REASON,
				state: "needs_you",
				diffText: "diff --git a/evil.txt b/evil.txt",
				diffFiles: [{ file: "evil.txt", plus: 1, minus: 0 }],
			});
			// The park's own delta, not the live branch diff: the worktree no longer speaks
			// for the push set once the branch is integrated.
			const raw = await get(`/api/projects/p1/tasks/${held.id}/diff`);
			expect(raw.status).toBe(200);
			expect(await raw.text()).toContain("evil.txt");
			const detail = await get(`/api/projects/p1/tasks/${held.id}`);
			const b = (await detail.json()) as { diffFiles?: unknown };
			expect(b.diffFiles).toEqual([{ file: "evil.txt", plus: 1, minus: 0 }]);
			// After the reply the reason is gone and the card reads live again.
			p1.store.updateTask(held.id, { needsReason: null });
			expect((await get(`/api/projects/p1/tasks/${held.id}/diff`)).status).toBe(
				404,
			);
		});

		test("a card filed from an update card inherits its merge hold; others do not", async () => {
			const p1 = projects.get("p1")!;
			const held = p1.store.createTask("update pins");
			p1.store.updateTask(held.id, {
				updateIds: ["x@1"],
				updateMergeHead: "abc123",
			});
			const plain = p1.store.createTask("plain parent");
			for (const parent of [held, plain]) {
				const res = await post("/api/projects/p1/tasks", {
					prompt: `split from ${parent.id}`,
					followUpOf: parent.id,
					backlog: true,
				});
				expect(res.status).toBe(200);
			}
			const kid = (id: string) =>
				p1.store.listTasks().find((t) => t.followUpOf === id)!;
			// The parent's approval covers its own diff only: the child starts unapproved.
			expect(kid(held.id).updateIds).toEqual(["x@1"]);
			expect(kid(held.id).updateMergeHead).toBeNull();
			expect(kid(plain.id).updateIds).toEqual([]);
		});

		test("a pin already at its qualified target is applied; the refresh drops it", async () => {
			// The push-throttle test above skips goodRec.id and leaves the skip set.
			gstore.set("updateSkips", []);
			alateBody = envelope([
				// current === target !== latest: v2 was applied, a young v3 is out. The
				// id is unchanged, so without the drop the row lists as available again.
				{ ...goodRec, current: "v2", latest: "v3" },
				goodRec,
			]);
			const res = await post("/api/updates/refresh", {});
			expect(res.status).toBe(200);
			expect((await readView(res)).rows.map((r) => r.id)).toEqual([goodRec.id]);
		});

		test("an allow-filed version cannot re-file from the provider approval echo", async () => {
			const p1 = projects.get("p1")!;
			p1.github = "https://github.com/Octo/Repo.GIT";
			try {
				const again = {
					...goodRec,
					id: "octo/repo@v10",
					latest: "v10",
					target: "v10",
					notesUrl: "https://github.com/octo/repo/releases/tag/v10",
				};
				alateBody = envelope([again]);
				await post("/api/updates/refresh", {});
				const ares = await post("/api/updates/allow", { ids: [again.id] });
				expect(ares.status).toBe(200);
				// Exactly one card covers the id after Allow.
				const cards = p1.store
					.listTasks()
					.filter((t) => t.updateIds.includes(again.id));
				expect(cards.length).toBe(1);
			} finally {
				p1.github = null;
				alateBody = envelope([goodRec, otherRec]);
			}
		});
	});

	// GET /api/provisioning reads the workers lists from the shared app's workersHome
	// (`root`, injected at boot). Each row test provisions its own fixture lists and
	// removes them after, so later describes that list the same directory see only
	// their own rows.
	const provList = (project: string, file: string, body: string): void => {
		mkdirSync(join(root, ".ottr", "workers", project), { recursive: true });
		writeFileSync(join(root, ".ottr", "workers", project, file), body);
	};
	const provCleanup = (): void => {
		for (const p of ["p-a", "p-b"])
			rmSync(join(root, ".ottr", "workers", p), {
				recursive: true,
				force: true,
			});
	};

	test("no alate config: server null and the worker rows list lists", async () => {
		await post("/api/alate", { url: null, key: null });
		provList("p-a", "apt.txt", "curl\n");
		provList("p-a", "tools.json", "[]\n");
		provList(
			"p-a",
			"requirements.txt",
			`idna==3.10 --hash=sha256:${"a".repeat(64)}\n`,
		);
		provList("p-b", "env.txt", "FOO\n");
		try {
			const res = await get("/api/provisioning");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				server: null,
				workers: [
					{
						name: "p-a",
						apt: true,
						tools: true,
						requirements: true,
						env: false,
					},
					{
						name: "p-b",
						apt: false,
						tools: false,
						requirements: false,
						env: true,
					},
				],
			});
		} finally {
			provCleanup();
		}
	});

	test("configured alate reports its health probe", async () => {
		await post("/api/alate", { url: alateUrl, key: "alate_secret" });
		provList("p-a", "apt.txt", "curl\n");
		provList("p-a", "tools.json", "[]\n");
		provList("p-b", "env.txt", "FOO\n");
		const prev = alateBody;
		alateStatus = 200;
		alateBody = {
			version: "1.2.3",
			update: { behind: true },
			pending: true,
			running: false,
		};
		try {
			const res = await get("/api/provisioning");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				server: {
					url: alateUrl,
					keySet: true,
					lastError: null,
					health: {
						state: "ok",
						version: "1.2.3",
						behind: true,
						pending: true,
						running: false,
					},
				},
				workers: [
					{
						name: "p-a",
						apt: true,
						tools: true,
						requirements: false,
						env: false,
					},
					{
						name: "p-b",
						apt: false,
						tools: false,
						requirements: false,
						env: true,
					},
				],
			});
		} finally {
			alateStatus = 200;
			alateBody = prev;
			provCleanup();
		}
	});

	test("alate health failure still answers 200 with state down", async () => {
		const prev = alateStatus;
		alateStatus = 500;
		alateBody = { error: "boom" };
		try {
			const res = await get("/api/provisioning");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { server: { health: unknown } };
			expect(body.server!.health).toEqual({ state: "down" });
		} finally {
			alateStatus = prev;
		}
	});

	test("garbage health fields classify to null version and false flags", async () => {
		const prev = alateBody;
		alateBody = { version: 7, pending: "yes", update: "x" };
		try {
			const res = await get("/api/provisioning");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { server: { health: unknown } };
			expect(body.server!.health).toEqual({
				state: "ok",
				version: null,
				behind: false,
				pending: false,
				running: false,
			});
		} finally {
			alateBody = prev;
		}
	});
});

// The compose `alate` profile pairs the board with a bundled alate service through
// ALATE_URL and ALATE_API_KEY (docker-compose.yml): an install without saved
// Settings boots with the pair in effect, and a saved Settings value wins over the
// env at the next boot.
describe("alate env seeding", () => {
	const saved = {
		ALATE_URL: process.env.ALATE_URL,
		ALATE_API_KEY: process.env.ALATE_API_KEY,
	};
	afterAll(() => {
		for (const [k, v] of Object.entries(saved))
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
	});

	test("empty settings seed both fields from the env, and the seeded pair drives provision", async () => {
		// The stand-in proves both seeded fields work: the provision reaches the
		// seeded URL and hands it the seeded key as the bearer.
		const standIn = Bun.serve({
			port: 0,
			fetch: (req) =>
				req.method === "POST" && new URL(req.url).pathname === "/provision"
					? Response.json({ seen: req.headers.get("authorization") })
					: new Response(null, { status: 404 }),
		});
		try {
			// Trailing slash: the seed stores the URL stripped, like a Settings save.
			process.env.ALATE_URL = `${standIn.url.origin}/`;
			process.env.ALATE_API_KEY = "seed-key";
			const m = mount();
			expect(await (await m.call("/api/alate")).json()).toEqual({
				url: standIn.url.origin,
				keySet: true,
				lastProvisionError: null,
			});
			// Write-only: the view says the key is set, never what it is.
			expect(await (await m.call("/api/alate")).text()).not.toContain(
				"seed-key",
			);
			const res = await m.call("/api/alate/provision", {});
			expect(res.status).toBe(200);
			// The stand-in echoes the authorization header it saw.
			const seen = (await res.json()) as { seen: string | null };
			expect(seen.seen).toBe("Bearer seed-key");
		} finally {
			standIn.stop(true);
		}
	});

	test("a saved Settings value wins over the env seed at the next boot", async () => {
		process.env.ALATE_URL = "http://alate:4570";
		process.env.ALATE_API_KEY = "seed-key";
		const m = mount();
		await m.call("/api/alate", {
			url: "http://127.0.0.1:9",
			key: "saved-key",
		});
		// A restart on the same store with a different env pair replaces nothing;
		// provision still reaches the saved URL (connection refused -> 502).
		const m2 = mount({ gstore: m.g });
		expect(await (await m2.call("/api/alate")).json()).toEqual({
			url: "http://127.0.0.1:9",
			keySet: true,
			lastProvisionError: null,
		});
		expect((await m2.call("/api/alate/provision", {})).status).toBe(502);
	});
});

describe("alate provision trigger (U9)", () => {
	// Fake provider: /health reports a mutable pending flag and the agent-layer capability
	// flag; /provision flips it like the real server and can be told to fail.
	let pending = true;
	let running = false;
	let layers = true;
	let provisionStatus = 200;
	let provisions = 0;
	let lastAuth: string | null = null;
	const fake = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const u = new URL(req.url);
			if (u.pathname === "/provision") {
				lastAuth = req.headers.get("authorization");
				provisions++;
				if (provisionStatus !== 200)
					return Response.json({ error: "nope" }, { status: provisionStatus });
				pending = false;
				return Response.json({ ok: true, results: [] });
			}
			return Response.json({ ok: true, pending, running, layers });
		},
	});
	afterAll(() => {
		fake.stop(true);
	});

	const tickDir = join(root, "p-tick");
	mkdirSync(tickDir, { recursive: true });
	const tickStore = ProjectStore.open(tickDir);
	const tickProjects = new Map<string, Entry>();
	tickProjects.set("pt", {
		path: tickDir,
		name: "pt",
		store: tickStore,
		target: null,
		gitless: false,
		github: null,
		remote: null,
		dirty: false,
		mainUnpushed: false,
		mainBranch: null,
		latestRelease: null,
		latestImage: null,
		archReview: null,
	});
	afterAll(() => {
		tickStore.close();
	});
	const m = mount({ projects: tickProjects });

	beforeAll(async () => {
		const res = await m.call("/api/alate", {
			url: fake.url.origin,
			key: "tick_secret",
		});
		expect(res.status).toBe(200);
	});

	test("provisions once when pending and the board is idle", async () => {
		await m.app.alateProvisionTick();
		expect(provisions).toBe(1);
		expect(lastAuth).toBe("Bearer tick_secret");
	});

	test("does not repeat after success", async () => {
		// The provider flipped pending on provision, so the next tick is a no-op.
		await m.app.alateProvisionTick();
		expect(provisions).toBe(1);
		const v = (await (await m.call("/api/alate")).json()) as {
			lastProvisionError: string | null;
		};
		expect(v.lastProvisionError).toBe(null);
	});

	test("provisions while a turn runs when alate reports agent layers", async () => {
		// A layered provision installs a new layer and switches a symlink, so a running
		// turn keeps the layer it started with: no idle wait (docs/specs/
		// agent-layer-switch.md, "Provision trigger").
		pending = true; // a new import arrived
		const t = tickStore.createTask("busy");
		tickStore.updateTask(t.id, { state: "running" });
		await m.app.alateProvisionTick();
		expect(provisions).toBe(2);
		expect(lastAuth).toBe("Bearer tick_secret");
		// The provision consumed the import; a fresh one arrives for the next cases.
		pending = true;
		tickStore.updateTask(t.id, { state: "idle" });
	});

	test("keeps the idle gate while a turn runs when alate lacks agent layers", async () => {
		// An old alate writes the flat home under running turns, so the old idle gate
		// defers this attempt (docs/specs/agent-layer-switch.md, "Provision trigger").
		layers = false;
		const t = tickStore.createTask("busy flat");
		tickStore.updateTask(t.id, { state: "running" });
		await m.app.alateProvisionTick();
		expect(provisions).toBe(2);
		// An idle board without the flag still provisions: the flag only decides whether
		// a busy board defers, never whether an idle one does (today's behavior kept).
		tickStore.updateTask(t.id, { state: "idle" });
		await m.app.alateProvisionTick();
		expect(provisions).toBe(3);
		layers = true;
		pending = true; // a fresh import for the next cases
	});

	test("a provision already running on alate defers the trigger", async () => {
		// alate single-flights provisions: a run still executing there (its board-side
		// wait may have timed out) must not be re-triggered into a 409 that would be
		// recorded as a failure.
		running = true;
		await m.app.alateProvisionTick();
		expect(provisions).toBe(3);
		const v = (await (await m.call("/api/alate")).json()) as {
			lastProvisionError: string | null;
		};
		expect(v.lastProvisionError).toBe(null);
		running = false;
	});

	test("the trigger's own provision outliving the wait records no failure or backoff", async () => {
		// Same mapping as the manual route: the TimeoutError from the transport bound
		// plus a health report of the running provision means alate accepted it, so
		// neither an error nor the hour backoff applies.
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			if (new URL(String(input)).pathname === "/provision") {
				running = true; // alate took the POST and still runs the scripts
				const err = new Error("The operation was aborted due to timeout");
				err.name = "TimeoutError";
				throw err;
			}
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			await m.app.alateProvisionTick();
		} finally {
			globalThis.fetch = realFetch;
			running = false;
		}
		const v = (await (await m.call("/api/alate")).json()) as {
			lastProvisionError: string | null;
		};
		expect(v.lastProvisionError).toBe(null);
		// No backoff either: the next tick attempts again and the fake flips pending.
		await m.app.alateProvisionTick();
		expect(provisions).toBe(4);
	});

	test("waits an hour after a failure and shows the error", async () => {
		provisionStatus = 500;
		pending = true; // the timed-out attempt above consumed the earlier import
		await m.app.alateProvisionTick();
		expect(provisions).toBe(5);
		const v = (await (await m.call("/api/alate")).json()) as {
			lastProvisionError: string | null;
		};
		expect(v.lastProvisionError).toBe("nope");
		// Backoff: pending is still true and the board is idle, yet no retry happens.
		await m.app.alateProvisionTick();
		expect(provisions).toBe(5);
		// A manual success clears the recorded error.
		provisionStatus = 200;
		pending = false;
		const manual = await m.call("/api/alate/provision", {});
		expect(manual.status).toBe(200);
		const after = (await (await m.call("/api/alate")).json()) as {
			lastProvisionError: string | null;
		};
		expect(after.lastProvisionError).toBe(null);
	});

	test("records the pending episode even when a turn defers provisioning", async () => {
		pending = true; // a new import arrived
		layers = false; // an old alate: the idle gate defers the attempt below
		const t = tickStore.createTask("busy again");
		tickStore.updateTask(t.id, { state: "running" });
		await m.app.alateProvisionTick();
		expect(provisions).toBe(6); // gated: no provision attempt
		const state = (await (await m.call("/api/state")).json()) as {
			alatePendingSince: number | null;
		};
		expect(state.alatePendingSince ?? 0).toBeGreaterThan(0);
		// The episode keeps its first-seen stamp on repeat checks: one entry, not one per tick.
		const first = state.alatePendingSince ?? 0;
		await m.app.alateProvisionTick();
		const again = (await (await m.call("/api/state")).json()) as {
			alatePendingSince: number | null;
		};
		expect(again.alatePendingSince).toBe(first);
		tickStore.updateTask(t.id, { state: "idle" });
		layers = true;
	});

	test("clears the episode when the provider stops reporting pending", async () => {
		pending = false;
		await m.app.alateProvisionTick();
		const state = (await (await m.call("/api/state")).json()) as {
			alatePendingSince: number | null;
		};
		expect(state.alatePendingSince).toBe(null);
	});

	test("a completed import dates a recorded trigger failure", async () => {
		// Own mount: the describe's instance sits in the failure backoff from the test
		// above, and this mapping needs a live trigger to record the error first.
		const m2 = mount({ projects: tickProjects });
		const cfg = await m2.call("/api/alate", {
			url: fake.url.origin,
			key: "tick_secret",
		});
		expect(cfg.status).toBe(200);
		provisionStatus = 500;
		pending = true;
		await m2.app.alateProvisionTick();
		const v = (await (await m2.call("/api/alate")).json()) as {
			lastProvisionError: string | null;
		};
		expect(v.lastProvisionError).toBe("nope");
		// The import completes elsewhere (alate's own dashboard): the health section
		// of the next tick runs ahead of the backoff gate and dates the failure.
		provisionStatus = 200;
		pending = false;
		await m2.app.alateProvisionTick();
		const after = (await (await m2.call("/api/alate")).json()) as {
			lastProvisionError: string | null;
		};
		expect(after.lastProvisionError).toBe(null);
	});

	test("an hour of backoff after a failure holds without agent layers too", async () => {
		// Own mount: the describe's instance is idle between tests. The backoff gate runs
		// before the capability gate, so the one-hour hold is mode-independent — the test
		// pins that for the old-alate mode.
		const m3 = mount({ projects: tickProjects });
		const cfg = await m3.call("/api/alate", {
			url: fake.url.origin,
			key: "tick_secret",
		});
		expect(cfg.status).toBe(200);
		provisionStatus = 500;
		pending = true;
		layers = false;
		await m3.app.alateProvisionTick();
		expect(provisions).toBe(8);
		const v = (await (await m3.call("/api/alate")).json()) as {
			lastProvisionError: string | null;
		};
		expect(v.lastProvisionError).toBe("nope");
		await m3.app.alateProvisionTick();
		expect(provisions).toBe(8); // the hour holds
		provisionStatus = 200;
		pending = false;
		layers = true;
	});
});

describe("agent layer boot reconcile", () => {
	/** The registry ids one home's in-use.json holds. */
	const registry = (home: string): string[] => {
		const parsed = JSON.parse(
			readFileSync(join(home, ".alate", "in-use.json"), "utf8"),
		) as { layers: { id: string }[] };
		return parsed.layers.map((l) => l.id);
	};

	test("boot rebuilds each home's registry from the stores' open turns", () => {
		// Two homes with layer folders; the stores hold open turns on "bbb", on "gone"
		// (no folder anywhere) and on "../escape" (never a folder name). Both registries
		// keep only "bbb": an open turn pins it and its folder exists in each home — an
		// unpinned folder ("aaa") and a pinned id without a folder ("gone") drop out.
		const suffix = Math.random().toString(36).slice(2, 8);
		const shared = join(root, `rec-shared-${suffix}`);
		const board = join(root, `rec-board-${suffix}`);
		mkdirSync(join(shared, ".alate", "layers", "aaa"), { recursive: true });
		mkdirSync(join(shared, ".alate", "layers", "bbb"), { recursive: true });
		mkdirSync(join(board, ".alate", "layers", "bbb"), { recursive: true });
		const dir = join(root, `rec-proj-${suffix}`);
		const store = ProjectStore.open(dir);
		const tasks = [
			store.createTask("open bbb"),
			store.createTask("open gone"),
			store.createTask("open escape"),
		];
		store.startTurn(tasks[0]!.id, "work", "p", null, null, null, null, "bbb");
		store.startTurn(tasks[1]!.id, "work", "p", null, null, null, null, "gone");
		store.startTurn(
			tasks[2]!.id,
			"work",
			"p",
			null,
			null,
			null,
			null,
			"../escape",
		);
		const projects = new Map<string, Entry>();
		projects.set("rec", {
			path: dir,
			name: "rec",
			store,
			target: null,
			gitless: false,
			github: null,
			remote: null,
			dirty: false,
			mainUnpushed: false,
			mainBranch: null,
			latestRelease: null,
			latestImage: null,
			archReview: null,
		});
		const savedHome = process.env.HOME;
		const savedBoard = process.env.OTTR_BOARD_OMP_HOME;
		process.env.HOME = shared;
		process.env.OTTR_BOARD_OMP_HOME = board;
		try {
			mount({ projects }); // createApp runs the reconcile once, with the projects open
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
			if (savedBoard === undefined) delete process.env.OTTR_BOARD_OMP_HOME;
			else process.env.OTTR_BOARD_OMP_HOME = savedBoard;
			store.close();
		}
		expect([...registry(shared)].sort()).toEqual(["bbb"]);
		expect(registry(board)).toEqual(["bbb"]);
	});

	test("reconcileLayerUse drops stale and unsafe ids, skips homes without layers", () => {
		const home = join(
			root,
			`rec-direct-${Math.random().toString(36).slice(2, 8)}`,
		);
		mkdirSync(join(home, ".alate", "layers", "real"), { recursive: true });
		writeFileSync(
			join(home, ".alate", "in-use.json"),
			'{"layers":[{"id":"stale","since":1}]}',
		);
		reconcileLayerUse(["stale", "../escape", "real"], [home]);
		expect(registry(home)).toEqual(["real"]);
		// No `.alate` dir: nothing to reconcile, and no registry is created there.
		const bare = join(
			root,
			`rec-bare-${Math.random().toString(36).slice(2, 8)}`,
		);
		reconcileLayerUse(["real"], [bare]);
		expect(existsSync(join(bare, ".alate"))).toBe(false);
	});
});

describe("boardOmpEnv layer pin", () => {
	test("HOME follows the board home's current layer, with shared state linked", () => {
		const saved = {
			board: process.env.OTTR_BOARD_OMP_HOME,
			url: process.env.HINDSIGHT_API_URL,
		};
		const h = join(root, `omp-env-${Math.random().toString(36).slice(2, 8)}`);
		const layer = join(h, ".alate", "layers", "lay1");
		mkdirSync(join(layer, ".omp", "agent"), { recursive: true });
		symlinkSync(join("layers", "lay1"), join(h, ".alate", "current"));
		process.env.OTTR_BOARD_OMP_HOME = h;
		try {
			const env = boardOmpEnv();
			expect(env.HOME).toBe(realpathSync(layer));
			// pinnedAgentLayer prepared the links: the credential store inside the layer
			// points at the flat home's agent.db (one store per stack).
			expect(readlinkSync(join(layer, ".omp", "agent", "agent.db"))).toBe(
				join(h, ".omp", "agent", "agent.db"),
			);
			// The pin never rewrites the layer's config: memory.backend is not layer
			// content (OTTR-453), so the layer keeps the backend it shipped, env or not.
			writeFileSync(
				join(layer, ".omp", "agent", "config.yml"),
				"memory:\n  backend: mnemopi\n",
			);
			process.env.HINDSIGHT_API_URL = "http://127.0.0.1:9";
			boardOmpEnv();
			expect(
				readFileSync(join(layer, ".omp", "agent", "config.yml"), "utf8"),
			).toContain("backend: mnemopi");
			// A broken link falls back to the flat home, exactly as today.
			rmSync(join(h, ".alate", "current"));
			expect(boardOmpEnv().HOME).toBe(h);
		} finally {
			if (saved.board === undefined) delete process.env.OTTR_BOARD_OMP_HOME;
			else process.env.OTTR_BOARD_OMP_HOME = saved.board;
			if (saved.url === undefined) delete process.env.HINDSIGHT_API_URL;
			else process.env.HINDSIGHT_API_URL = saved.url;
		}
	});
});

describe("idle auto review tick", () => {
	// Fixed idle clock: createApp stamps lastInputAt at mount, tests move t forward.
	let t = 1_750_000_000_000;
	let scheduled = 0;
	const opened: Entry[] = [];
	afterAll(() => {
		for (const e of opened) e.store.close();
	});

	/** A fresh app (own shared state, own remembered card) with one due project: target
	 * main and archReview.due, like a refresh left it. */
	async function idleMount() {
		const name = `idle-${opened.length}-${Math.random()
			.toString(36)
			.slice(2, 6)}`;
		const projects = new Map<string, Entry>();
		const m = mount({
			projects,
			now: () => t,
			schedule: () => {
				scheduled++;
			},
		});
		const add = await m.call("/api/projects", { name });
		expect(add.status).toBe(200);
		const e = projects.get(name)!;
		e.target = "main";
		e.archReview = {
			delta: 150,
			reviewed: true,
			base: null,
			reviewCardId: null,
			cap: 150,
			due: true,
			running: false,
		};
		opened.push(e);
		return { m, e, dir: join(root, name), projects };
	}

	const reviewCards = (e: Entry): Task[] =>
		e.store.listTasks().filter((task) => task.kind === "review");

	test("files the due project's review card at exactly two hours of silence", async () => {
		const { m, e, dir } = await idleMount();
		t += 2 * 60 * 60_000; // the boundary itself: now() - lastInputAt == 2h files
		await m.app.idleReviewTick();
		const cards = reviewCards(e);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.kind).toBe("review");
		// The review freezes the target head, like a release card.
		const head = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
		expect(cards[0]?.base).toBe(head);
		expect(scheduled).toBeGreaterThan(0);
	});

	test("stays silent at one hour fifty-nine minutes", async () => {
		const { m, e } = await idleMount();
		t += 2 * 60 * 60_000 - 60_000;
		await m.app.idleReviewTick();
		expect(reviewCards(e)).toHaveLength(0);
	});

	test("a preparing turn on any project blocks the tick", async () => {
		const { m, e, projects } = await idleMount();
		// The busy turn lives on a second project: anyTurnActive scans them all.
		const busyName = `idle-busy-${opened.length}-${Math.random()
			.toString(36)
			.slice(2, 6)}`;
		const add = await m.call("/api/projects", { name: busyName });
		expect(add.status).toBe(200);
		const busy = projects.get(busyName)!;
		opened.push(busy);
		const turn = busy.store.createTask("busy");
		busy.store.updateTask(turn.id, { state: "preparing" });
		t += 3 * 60 * 60_000;
		await m.app.idleReviewTick();
		expect(reviewCards(e)).toHaveLength(0);
	});

	test("a blocked review keeps the tick silent", async () => {
		const { m, e } = await idleMount();
		// A live review card the refreshed entry does not know about yet: the entry still
		// shows running false, and reviewBlocked inside the helper catches it.
		e.store.createTask("earlier review", null, "review");
		t += 3 * 60 * 60_000;
		await m.app.idleReviewTick();
		expect(reviewCards(e)).toHaveLength(1);
	});

	test("an auto review already live files nothing new", async () => {
		const { m, e } = await idleMount();
		t += 2 * 60 * 60_000;
		await m.app.idleReviewTick();
		expect(reviewCards(e)).toHaveLength(1);
		// The tick remembers its card: a later tick with every other gate open files nothing.
		await m.app.idleReviewTick();
		expect(reviewCards(e)).toHaveLength(1);
	});

	test("a fresh app counts as input and files nothing", async () => {
		const { m, e } = await idleMount();
		// No request since mount: lastInputAt is the createApp stamp, so a restart never
		// files at once, even with the due badge showing.
		await m.app.idleReviewTick();
		expect(reviewCards(e)).toHaveLength(0);
	});

	test("the setting off keeps the tick silent", async () => {
		const { m, e } = await idleMount();
		const off = await m.call("/api/settings", { idleReviews: false });
		expect(off.status).toBe(200);
		t += 3 * 60 * 60_000;
		await m.app.idleReviewTick();
		expect(reviewCards(e)).toHaveLength(0);
	});
});

describe("model roles routes", () => {
	const ORIGINAL = `theme: dark
modelRoles:
  default: zai/glm-5.3-flash:max
  slow: anthropic/claude-opus-5-5:medium  # planner
extensions:
  - ./check.yml
`;
	const sha = (s: string) =>
		new Bun.CryptoHasher("sha256").update(s).digest("hex");
	const BASE = "a".repeat(40);
	const OTHER = "b".repeat(40);
	const NEW = "c".repeat(40);
	// The data repo's branch head: content and commit. Alate's snapshot (`snapshot`/`snapSha`)
	// follows it on each import. `afterImport` moves main once, right after an import.
	let head = ORIGINAL;
	let headSha = BASE;
	let snapshot = ORIGINAL;
	let snapSha = BASE;
	let afterImport: (() => void) | null = null;
	// Another writer's commit that lands on main right after the save's own ref move.
	let afterRefMove: (() => void) | null = null;
	let alateReqs: { method: string; url: string; auth: string | null }[] = [];
	// Path-source mode: alate serves a local folder ("/data") instead of a GitHub repo.
	// `folderGit` false makes alate write without committing (commit ""); `putConflict`
	// simulates the editor's 409. `puts` records the PUT /api/file bodies.
	let pathMode = false;
	let folderGit = true;
	let putConflict = false;
	let puts: { path: string; base: string; content: string; message: string }[] =
		[];
	// gh api calls; `pending` holds the tree content until the ref moves.
	let ghCalls: string[][] = [];
	let pending: { content: string; parent: string } | null = null;
	const reset = () => {
		head = snapshot = ORIGINAL;
		headSha = snapSha = BASE;
		afterImport = null;
		afterRefMove = null;
		alateReqs = [];
		pathMode = false;
		folderGit = true;
		putConflict = false;
		puts = [];
		ghCalls = [];
		pending = null;
	};
	const source = () =>
		pathMode
			? {
					kind: "path",
					spec: "/data",
					name: "/data",
					ref: "",
					importedSha: "",
				}
			: {
					kind: "repo",
					spec: "o/data",
					name: "o/data",
					ref: "main",
					importedSha: snapSha,
				};
	const fake = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const u = new URL(req.url);
			alateReqs.push({
				method: req.method,
				url: u.pathname + u.search,
				auth: req.headers.get("authorization"),
			});
			if (u.pathname === "/health")
				return Response.json(
					pathMode
						? { ok: true, running: false, path: "/data" }
						: { ok: true, running: false, repo: "o/data" },
				);
			if (u.pathname === "/api/file" && req.method === "PUT") {
				const body = (await req.json()) as {
					path: string;
					base: string;
					content: string;
					message: string;
				};
				if (putConflict || body.base !== sha(snapshot))
					return Response.json(
						{
							error:
								"user/omp/agent/config.yml changed since it was loaded; reload it and retry",
						},
						{ status: 409 },
					);
				puts.push(body);
				snapshot = body.content;
				return Response.json({
					ok: true,
					commit: folderGit ? NEW : "",
					pushed: false,
				});
			}
			if (u.pathname === "/api/state")
				return Response.json({ source: source() });
			if (u.pathname === "/api/import") {
				// A path source reports importedSha "" forever: the import refreshes the
				// snapshot but never a commit.
				snapshot = head;
				if (!pathMode) snapSha = headSha;
				const moved = afterImport;
				afterImport = null;
				moved?.();
				return Response.json({ ok: true, state: { source: source() } });
			}
			return Response.json({
				path: u.searchParams.get("path"),
				content: snapshot,
				hash: sha(snapshot),
			});
		},
	});
	afterAll(() => {
		fake.stop(true);
	});
	const field = (args: string[], key: string) =>
		args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1) as string;
	// Fake GitHub: the ref moves only as a fast-forward, like `force: false` on GitHub.
	const gh = async (args: string[]) => {
		ghCalls.push(args);
		const ok = (body: unknown) => ({
			code: 0,
			stdout: JSON.stringify(body),
			stderr: "",
		});
		const path = args.find((a) => a.startsWith("repos/")) ?? "";
		if (path.startsWith("repos/o/data/git/commits/"))
			return ok({ sha: path.split("/").at(-1), tree: { sha: "t0" } });
		if (path === "repos/o/data/git/trees") {
			pending = { content: field(args, "tree[][content]"), parent: "" };
			return ok({ sha: "t1" });
		}
		if (path === "repos/o/data/git/commits") {
			if (pending) pending.parent = field(args, "parents[]");
			return ok({ sha: NEW });
		}
		if (path === "repos/o/data/git/refs/heads/main") {
			if (pending === null || pending.parent !== headSha)
				return {
					code: 1,
					stdout: JSON.stringify({ message: "Update is not a fast forward" }),
					stderr: "gh: Update is not a fast forward (HTTP 422)",
				};
			head = pending.content;
			headSha = NEW;
			const next = afterRefMove;
			afterRefMove = null;
			next?.();
			return ok({ object: { sha: NEW } });
		}
		return { code: 1, stdout: "", stderr: `unexpected gh call: ${path}` };
	};
	const model = (selector: string) => ({
		id: selector,
		selector,
		name: selector,
		contextWindow: null,
	});
	const m = mount({
		gh,
		models: async () => [
			model("zai/glm-5.3-flash"),
			model("anthropic/claude-opus-5-5"),
		],
	});
	beforeAll(async () => {
		const res = await m.call("/api/alate", {
			url: fake.url.origin,
			key: "roles_secret",
		});
		expect(res.status).toBe(200);
	});
	const refMoves = () =>
		ghCalls.filter((a) => a.includes("repos/o/data/git/refs/heads/main"));
	const imports = () => alateReqs.filter((r) => r.url === "/api/import");

	test("GET returns the roles in file order, the base commit, the hash, sign-ins and the seed", async () => {
		reset();
		const res = await m.call("/api/model-roles");
		expect(res.status).toBe(200);
		const b = (await res.json()) as {
			base: string | null;
			hash: string;
			roles: Record<string, string>;
			signIns: string[] | null;
			seed: { needed: boolean };
		};
		expect(b.base).toBe(BASE);
		expect(b.hash).toBe(sha(ORIGINAL));
		expect(Object.entries(b.roles)).toEqual([
			["default", "zai/glm-5.3-flash:max"],
			["slow", "anthropic/claude-opus-5-5:medium"],
		]);
		// The board store pinned by PI_CODING_AGENT_DIR decides the list: none there reads as null.
		expect(b.signIns).toBeNull();
		expect(typeof b.seed.needed).toBe("boolean");
		expect(alateReqs.map((r) => `${r.method} ${r.url} ${r.auth}`)).toEqual([
			"GET /api/state Bearer roles_secret",
			"GET /api/file?path=user%2Fomp%2Fagent%2Fconfig.yml Bearer roles_secret",
		]);
	});

	test("GET lists the providers with an active sign-in in the board store", async () => {
		reset();
		const agent = mkdtempSync(join(tmpdir(), "ottr-roles-agent"));
		const db = new Database(join(agent, "agent.db"));
		db.exec(`CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY,
			provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL,
			disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)`);
		db.exec(`INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES
			('deepseek', 'api_key', '{"key":"k"}', NULL, 1, 1),
			('zai', 'oauth', '{"access":"a","refresh":"r","expires":1}', 'refresh failed', 1, 1)`);
		db.close();
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const res = await m.call("/api/model-roles");
			expect(res.status).toBe(200);
			const b: unknown = await res.json();
			expect(
				typeof b === "object" && b !== null && "signIns" in b && b.signIns,
			).toEqual(["deepseek"]);
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
			rmSync(agent, { recursive: true, force: true });
		}
	});

	test("an unknown model or level is refused and nothing is committed", async () => {
		reset();
		const res = await m.call("/api/model-roles", {
			base: BASE,
			hash: sha(ORIGINAL),
			roles: {
				default: "nope/model",
				slow: "anthropic/claude-opus-5-5:turbo",
			},
		});
		expect(res.status).toBe(400);
		const b = (await res.json()) as { fields: Record<string, string> };
		expect(b.fields.default).toBe("unknown model nope/model");
		expect(b.fields.slow).toStartWith("unknown thinking level");
		expect(ghCalls).toEqual([]);
	});

	test("a save commits only the changed value line on top of the loaded commit", async () => {
		reset();
		const res = await m.call("/api/model-roles", {
			base: BASE,
			hash: sha(ORIGINAL),
			roles: {
				default: "anthropic/claude-opus-5-5:high",
				slow: "anthropic/claude-opus-5-5:medium",
			},
		});
		expect(res.status).toBe(200);
		const want = ORIGINAL.replace(
			"default: zai/glm-5.3-flash:max",
			"default: anthropic/claude-opus-5-5:high",
		);
		expect(await res.json()).toMatchObject({
			commit: NEW,
			base: NEW,
			hash: sha(want),
			roles: {
				default: "anthropic/claude-opus-5-5:high",
				slow: "anthropic/claude-opus-5-5:medium",
			},
		});
		expect(head).toBe(want);
		expect(ghCalls).toEqual([
			["api", `repos/o/data/git/commits/${BASE}`],
			[
				"api",
				"-X",
				"POST",
				"repos/o/data/git/trees",
				"-f",
				"base_tree=t0",
				"-f",
				"tree[][path]=user/omp/agent/config.yml",
				"-f",
				"tree[][mode]=100644",
				"-f",
				"tree[][type]=blob",
				"-f",
				`tree[][content]=${want}`,
			],
			[
				"api",
				"-X",
				"POST",
				"repos/o/data/git/commits",
				"-f",
				"message=chore: set the default model role to anthropic/claude-opus-5-5:high",
				"-f",
				"tree=t1",
				"-f",
				`parents[]=${BASE}`,
			],
			[
				"api",
				"-X",
				"PATCH",
				"repos/o/data/git/refs/heads/main",
				"-f",
				`sha=${NEW}`,
				"-F",
				"force=false",
			],
		]);
		// One import for the conflict check, one so the provision installs the new commit.
		expect(imports()).toHaveLength(2);
		// The answer's base and hash are the next save's starting point: no false conflict.
		const b = (await (await m.call("/api/model-roles")).json()) as {
			base: string;
		};
		expect(b.base).toBe(NEW);
		const again = await m.call("/api/model-roles", {
			base: NEW,
			hash: sha(want),
			roles: {
				default: "anthropic/claude-opus-5-5:low",
				slow: "anthropic/claude-opus-5-5:medium",
			},
		});
		expect(again.status).toBe(200);
	});

	test("a commit that lands on main right after the save does not leak into the save's answer", async () => {
		reset();
		const theirs = ORIGINAL.replace(
			"anthropic/claude-opus-5-5:medium",
			"zai/glm-5.3-flash",
		);
		afterRefMove = () => {
			head = theirs;
			headSha = OTHER;
		};
		const roles = {
			default: "anthropic/claude-opus-5-5:high",
			slow: "anthropic/claude-opus-5-5:medium",
		};
		const res = await m.call("/api/model-roles", {
			base: BASE,
			hash: sha(ORIGINAL),
			roles,
		});
		expect(res.status).toBe(200);
		const want = ORIGINAL.replace(
			"default: zai/glm-5.3-flash:max",
			"default: anthropic/claude-opus-5-5:high",
		);
		const b = (await res.json()) as {
			commit: string;
			base: string;
			hash: string;
			roles: Record<string, string>;
		};
		// The created commit, its content hash and its roles: not the head alate imported after it.
		expect(snapSha).toBe(OTHER);
		expect(b).toMatchObject({ commit: NEW, base: NEW, hash: sha(want), roles });
		// The next save from that answer meets the other commit as a real conflict.
		const next = await m.call("/api/model-roles", {
			base: b.base,
			hash: b.hash,
			roles: { ...roles, default: "anthropic/claude-opus-5-5:low" },
		});
		expect(next.status).toBe(409);
		expect(await next.json()).toMatchObject({
			base: OTHER,
			hash: sha(theirs),
			roles: { default: "zai/glm-5.3-flash:max", slow: "zai/glm-5.3-flash" },
		});
	});

	test("an unrelated commit on main between the check and the write gives 409, not a commit on top", async () => {
		reset();
		// config.yml stays the same: only the loaded parent commit can catch this move.
		afterImport = () => {
			headSha = OTHER;
		};
		const res = await m.call("/api/model-roles", {
			base: BASE,
			hash: sha(ORIGINAL),
			roles: {
				default: "anthropic/claude-opus-5-5",
				slow: "anthropic/claude-opus-5-5:medium",
			},
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error:
				"the data repo changed while the roles saved; check the current roles and save again",
			base: OTHER,
			hash: sha(ORIGINAL),
			roles: {
				default: "zai/glm-5.3-flash:max",
				slow: "anthropic/claude-opus-5-5:medium",
			},
		});
		expect(head).toBe(ORIGINAL);
		expect(headSha).toBe(OTHER);
		// One refused fast-forward, never retried and never forced.
		expect(refMoves()).toHaveLength(1);
		expect(refMoves()[0]).toContain("force=false");
	});

	test("a commit on main before the save leaves config.yml alone and still gives 409 and no write", async () => {
		reset();
		headSha = OTHER;
		const res = await m.call("/api/model-roles", {
			base: BASE,
			hash: sha(ORIGINAL),
			roles: {
				default: "anthropic/claude-opus-5-5",
				slow: "anthropic/claude-opus-5-5:medium",
			},
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			base: OTHER,
			hash: sha(ORIGINAL),
			roles: {
				default: "zai/glm-5.3-flash:max",
				slow: "anthropic/claude-opus-5-5:medium",
			},
		});
		expect(ghCalls).toEqual([]);
	});

	test("a stale form whose values another save already set gets 409, not 'nothing to save'", async () => {
		reset();
		const wanted = {
			default: "anthropic/claude-opus-5-5",
			slow: "anthropic/claude-opus-5-5:medium",
		};
		head = ORIGINAL.replace("zai/glm-5.3-flash:max", wanted.default);
		headSha = OTHER;
		const res = await m.call("/api/model-roles", {
			base: BASE,
			hash: sha(ORIGINAL),
			roles: wanted,
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			base: OTHER,
			hash: sha(head),
			roles: wanted,
		});
		expect(ghCalls).toEqual([]);
	});

	test("a stale body hash gives 409 with the current roles and no write", async () => {
		reset();
		const res = await m.call("/api/model-roles", {
			base: BASE,
			hash: "stale",
			roles: { default: "anthropic/claude-opus-5-5" },
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			hash: sha(ORIGINAL),
			roles: {
				default: "zai/glm-5.3-flash:max",
				slow: "anthropic/claude-opus-5-5:medium",
			},
		});
		expect(ghCalls).toEqual([]);
	});

	test("a git folder source saves with a local commit through alate", async () => {
		reset();
		pathMode = true;
		const get = await m.call("/api/model-roles");
		expect(get.status).toBe(200);
		expect(await get.json()).toMatchObject({ base: null, hash: sha(ORIGINAL) });
		const edited = ORIGINAL.replace(
			"slow: anthropic/claude-opus-5-5:medium  # planner",
			"slow: zai/glm-5.3-flash:max  # planner",
		);
		const res = await m.call("/api/model-roles", {
			base: null,
			hash: sha(ORIGINAL),
			roles: {
				default: "zai/glm-5.3-flash:max",
				slow: "zai/glm-5.3-flash:max",
			},
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			commit: NEW,
			base: null,
			hash: sha(edited),
			roles: {
				default: "zai/glm-5.3-flash:max",
				slow: "zai/glm-5.3-flash:max",
			},
			seed: expect.anything(),
		});
		// The save went through alate's editor PUT with the hash the editor loaded.
		expect(puts).toEqual([
			{
				path: "user/omp/agent/config.yml",
				base: sha(ORIGINAL),
				content: edited,
				message: "chore: set the slow model role to zai/glm-5.3-flash:max",
			},
		]);
		expect(ghCalls).toEqual([]);
		// One import for the conflict check; alate imports inside the PUT, so the route
		// makes no import call of its own after it.
		expect(imports()).toHaveLength(1);
	});

	test("a plain folder source answers read-only and restores the file", async () => {
		reset();
		pathMode = true;
		folderGit = false;
		const res = await m.call("/api/model-roles", {
			base: null,
			hash: sha(ORIGINAL),
			roles: {
				default: "zai/glm-5.3-flash:max",
				slow: "zai/glm-5.3-flash:max",
			},
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "read-only: folder source",
			path: "/data",
		});
		// The first PUT wrote the edit, the second undid it byte for byte with the hash
		// the first PUT gave back.
		const edited = ORIGINAL.replace(
			"slow: anthropic/claude-opus-5-5:medium  # planner",
			"slow: zai/glm-5.3-flash:max  # planner",
		);
		expect(puts.map((p) => ({ base: p.base, content: p.content }))).toEqual([
			{ base: sha(ORIGINAL), content: edited },
			{ base: sha(edited), content: ORIGINAL },
		]);
		expect(snapshot).toBe(ORIGINAL);
		const get = await m.call("/api/model-roles");
		expect(get.status).toBe(200);
		expect(await get.json()).toMatchObject({
			base: null,
			hash: sha(ORIGINAL),
			roles: {
				default: "zai/glm-5.3-flash:max",
				slow: "anthropic/claude-opus-5-5:medium",
			},
		});
	});

	test("an alate editor conflict passes through", async () => {
		reset();
		pathMode = true;
		putConflict = true;
		const res = await m.call("/api/model-roles", {
			base: null,
			hash: sha(ORIGINAL),
			roles: {
				default: "zai/glm-5.3-flash:max",
				slow: "zai/glm-5.3-flash:max",
			},
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error:
				"user/omp/agent/config.yml changed since it was loaded; reload it and retry",
		});
		expect(puts).toEqual([]);
		expect(ghCalls).toEqual([]);
	});
});

describe("model switch route", () => {
	test("switches the model on a queued task; empty string resets to default", async () => {
		const t = store.createTask("switch me");
		const res = await post(`/api/projects/p1/tasks/${t.id}/model`, {
			model: "zai/glm-5.3-flash",
		});
		expect(res.status).toBe(200);
		expect(store.getTask(t.id)!.model).toBe("zai/glm-5.3-flash");
		const back = await post(`/api/projects/p1/tasks/${t.id}/model`, {
			model: "",
		});
		expect(back.status).toBe(200);
		expect(store.getTask(t.id)!.model).toBeNull();
	});

	test("switches the model while a task waits for a reply", async () => {
		const t = store.createTask("reply me");
		store.updateTask(t.id, { state: "needs_you", needsReason: "?" });
		const res = await post(`/api/projects/p1/tasks/${t.id}/model`, {
			model: "zai/glm-5.3-flash",
		});
		expect(res.status).toBe(200);
		expect(store.getTask(t.id)!.model).toBe("zai/glm-5.3-flash");
	});

	test("absent or non-string model is 400", async () => {
		const t = store.createTask("validate me");
		const absent = await post(`/api/projects/p1/tasks/${t.id}/model`, {});
		expect(absent.status).toBe(400);
		expect(await errorOf(absent)).toBe("model must be a string");
		const wrong = await post(`/api/projects/p1/tasks/${t.id}/model`, {
			model: 7,
		});
		expect(wrong.status).toBe(400);
	});

	test("only a running, preparing, queued, or needs-you task can switch", async () => {
		const t = store.createTask("too late");
		store.updateTask(t.id, { stage: "done", state: "idle" });
		const res = await post(`/api/projects/p1/tasks/${t.id}/model`, {
			model: "x",
		});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe(
			"only a running, preparing, queued, or needs-you task can switch model",
		);
		const gone = await post("/api/projects/p1/tasks/ffffffff/model", {
			model: "x",
		});
		expect(gone.status).toBe(404);
	});
});

describe("steer cancel route", () => {
	test("cancels queued steering on a running task; the row keeps its state", async () => {
		const t = store.createTask("steer me");
		store.updateTask(t.id, { state: "running" });
		await post(`/api/projects/p1/tasks/${t.id}/steer`, { text: "hold on" });
		expect(store.getTask(t.id)!.pendingPrompt).toBe("hold on");
		const res = await post(`/api/projects/p1/tasks/${t.id}/steer/cancel`, {});
		expect(res.status).toBe(200);
		expect(store.getTask(t.id)!.pendingPrompt).toBeNull();
		expect(store.getTask(t.id)!.pendingImages).toEqual([]);
		expect(store.getTask(t.id)!.state).toBe("running");
	});

	test("canceling a steer that queued the follow-up turn settles the card", async () => {
		const t = store.createTask("steer me");
		store.updateTask(t.id, { stage: "in_progress", state: "queued" });
		await post(`/api/projects/p1/tasks/${t.id}/steer`, {
			text: "one more thing",
		});
		const res = await post(`/api/projects/p1/tasks/${t.id}/steer/cancel`, {});
		expect(res.status).toBe(200);
		const after = store.getTask(t.id)!;
		expect(after.pendingPrompt).toBeNull();
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("Steering canceled");
	});

	test("a fresh queued task stays queued; its first turn is not steering", async () => {
		const t = store.createTask("first turn pending");
		await post(`/api/projects/p1/tasks/${t.id}/steer`, { text: "also" });
		const res = await post(`/api/projects/p1/tasks/${t.id}/steer/cancel`, {});
		expect(res.status).toBe(200);
		const after = store.getTask(t.id)!;
		expect(after.pendingPrompt).toBeNull();
		expect(after.state).toBe("queued");
	});

	test("a steer on a card held for a usage limit ends the hold", async () => {
		const t = store.createTask("held");
		store.updateTask(t.id, {
			stage: "in_progress",
			holdUntil: Date.now() + 3_600_000,
			pendingPrompt: "hold prompt",
		});
		await post(`/api/projects/p1/tasks/${t.id}/steer`, { text: "run now" });
		const after = store.getTask(t.id)!;
		expect(after.holdUntil).toBeNull();
		expect(after.pendingPrompt).toBe("hold prompt\n\nrun now");
	});

	test("nothing queued, or an automatic resume, is 409", async () => {
		const t = store.createTask("nothing queued");
		store.updateTask(t.id, { state: "running" });
		const none = await post(`/api/projects/p1/tasks/${t.id}/steer/cancel`, {});
		expect(none.status).toBe(409);
		expect(await errorOf(none)).toBe("no steering is queued");
		store.updateTask(t.id, { pendingPrompt: ".", pendingImages: ["a.png"] });
		const resume = await post(
			`/api/projects/p1/tasks/${t.id}/steer/cancel`,
			{},
		);
		expect(resume.status).toBe(409);
		expect(store.getTask(t.id)!.pendingPrompt).toBe(".");
	});

	test("cancelled task and unknown id are 404", async () => {
		const t = store.createTask("gone");
		store.updateTask(t.id, { cancelledAt: Date.now(), state: "idle" });
		const dead = await post(`/api/projects/p1/tasks/${t.id}/steer/cancel`, {});
		expect(dead.status).toBe(404);
		const unknown = await post(
			"/api/projects/p1/tasks/ffffffff/steer/cancel",
			{},
		);
		expect(unknown.status).toBe(404);
	});
});

describe("steer edit route", () => {
	test("replaces the queued steering text before the agent sees it", async () => {
		const t = store.createTask("typo in the steer");
		store.updateTask(t.id, {
			state: "running",
			pendingPrompt: "gardening should have been hardening",
			pendingBy: "user",
		});
		const res = await post(`/api/projects/p1/tasks/${t.id}/steer/edit`, {
			text: "hardening, not gardening",
		});
		expect(res.status).toBe(200);
		const after = store.getTask(t.id)!;
		expect(after.pendingPrompt).toBe("hardening, not gardening");
		expect(after.pendingImages).toEqual([]);
		expect(after.state).toBe("running");
	});

	test("trims the replacement text and keeps queued images", async () => {
		const t = store.createTask("steer with a picture");
		store.updateTask(t.id, {
			stage: "in_progress",
			state: "queued",
			pendingPrompt: "one more thing",
			pendingBy: "user",
			pendingImages: ["a.png"],
		});
		const res = await post(`/api/projects/p1/tasks/${t.id}/steer/edit`, {
			text: "  one more thing, then stop  ",
		});
		expect(res.status).toBe(200);
		const after = store.getTask(t.id)!;
		expect(after.pendingPrompt).toBe("one more thing, then stop");
		expect(after.pendingImages).toEqual(["a.png"]);
		// Unlike cancel, an edit keeps a card that is queued only for the steer queued.
		expect(after.state).toBe("queued");
	});

	test("rewriting a supervisor park makes the text the user's", async () => {
		const t = store.createTask("parked by the tracker");
		store.updateTask(t.id, {
			state: "running",
			pendingPrompt: "the merge is held: resolve the conflict",
			pendingBy: "supervisor",
		});
		const res = await post(`/api/projects/p1/tasks/${t.id}/steer/edit`, {
			text: "the merge is held: take their version",
		});
		expect(res.status).toBe(200);
		expect(store.getTask(t.id)!.pendingBy).toBe("user");
	});

	test("nothing queued, an automatic resume, and empty text are rejected", async () => {
		const t = store.createTask("nothing queued");
		store.updateTask(t.id, { state: "running" });
		const none = await post(`/api/projects/p1/tasks/${t.id}/steer/edit`, {
			text: "hello",
		});
		expect(none.status).toBe(409);
		expect(await errorOf(none)).toBe("no steering is queued");
		store.updateTask(t.id, { pendingPrompt: "." });
		const resume = await post(`/api/projects/p1/tasks/${t.id}/steer/edit`, {
			text: "hello",
		});
		expect(resume.status).toBe(409);
		expect(await errorOf(resume)).toBe(
			"the queued turn is an automatic resume, not steering",
		);
		expect(store.getTask(t.id)!.pendingPrompt).toBe(".");
		store.updateTask(t.id, { pendingPrompt: "hold on", pendingBy: "user" });
		const blank = await post(`/api/projects/p1/tasks/${t.id}/steer/edit`, {
			text: "   ",
		});
		expect(blank.status).toBe(400);
		expect(await errorOf(blank)).toBe("text must be a non-empty string");
		const notText = await post(`/api/projects/p1/tasks/${t.id}/steer/edit`, {});
		expect(notText.status).toBe(400);
		expect(store.getTask(t.id)!.pendingPrompt).toBe("hold on");
	});

	test("cancelled task and unknown id are 404", async () => {
		const t = store.createTask("gone");
		store.updateTask(t.id, { cancelledAt: Date.now(), state: "idle" });
		const dead = await post(`/api/projects/p1/tasks/${t.id}/steer/edit`, {
			text: "hello",
		});
		expect(dead.status).toBe(404);
		const unknown = await post("/api/projects/p1/tasks/ffffffff/steer/edit", {
			text: "hello",
		});
		expect(unknown.status).toBe(404);
	});
});

describe("unmark research route", () => {
	test("clears the flag and leaves turns, commits, and the report alone", async () => {
		const t = store.createTask("coerced card");
		store.updateTask(t.id, {
			research: true,
			report: "# Findings",
			commits: 2,
		});
		store.startTurn(t.id, "work", "coerced card", null);
		const res = await post(
			`/api/projects/p1/tasks/${t.id}/unmark-research`,
			{},
		);
		expect(res.status).toBe(200);
		const after = store.getTask(t.id)!;
		expect(after.research).toBe(false);
		expect(after.report).toBe("# Findings");
		expect(after.commits).toBe(2);
		expect(store.listTurns(t.id)).toHaveLength(1);
		const b: unknown = await res.json();
		expect(
			typeof b === "object" &&
				b !== null &&
				"research" in b &&
				b.research === false,
		).toBe(true);
	});

	test("a running card is 409 and keeps its flag; unknown id is 404", async () => {
		const t = store.createTask("mid-run");
		store.updateTask(t.id, { research: true, state: "running" });
		const busy = await post(
			`/api/projects/p1/tasks/${t.id}/unmark-research`,
			{},
		);
		expect(busy.status).toBe(409);
		expect(await errorOf(busy)).toBe(
			"a running task cannot be unmarked as research",
		);
		expect(store.getTask(t.id)!.research).toBe(true);
		const unknown = await post(
			"/api/projects/p1/tasks/ffffffff/unmark-research",
			{},
		);
		expect(unknown.status).toBe(404);
	});
});

describe("release notes route", () => {
	const releaseCard = () => {
		const t = store.createTask("release card");
		store.updateTask(t.id, {
			releaseVersion: "v1.0.0",
			releaseNotes: "old notes",
			state: "needs_you",
			stage: "done",
		});
		return t;
	};

	test("rejects non-string, empty, blank, and oversized notes with 400", async () => {
		const t = releaseCard();
		for (const body of [
			{},
			{ notes: 5 },
			{ notes: "" },
			{ notes: "   " },
			{ notes: "x".repeat(20001) },
		]) {
			const res = await post(
				`/api/projects/p1/tasks/${t.id}/release-notes`,
				body,
			);
			expect(res.status).toBe(400);
			expect(await errorOf(res)).toMatch(/notes/);
		}
	});

	test("a plain task without a releaseVersion is 409", async () => {
		const t = store.createTask("not a release");
		const res = await post(`/api/projects/p1/tasks/${t.id}/release-notes`, {
			notes: "hi",
		});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("only release cards have release notes");
	});

	test("a running release card is 409", async () => {
		const t = releaseCard();
		store.updateTask(t.id, { releaseVersion: "v9.9.9", state: "running" });
		const res = await post(`/api/projects/p1/tasks/${t.id}/release-notes`, {
			notes: "hi",
		});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe(
			"only an idle or needs-you release card can edit release notes",
		);
	});

	test("edits the stored notes on a needs-you release card", async () => {
		const t = releaseCard();
		const res = await post(`/api/projects/p1/tasks/${t.id}/release-notes`, {
			notes: "new notes",
		});
		expect(res.status).toBe(200);
		expect(store.getTask(t.id)!.releaseNotes).toBe("new notes");
	});
});

describe("release-summary route", () => {
	// The route plans a real release, so the project needs a git repo; each test builds its
	// own checkout under root and removes it afterwards (same pattern as the drawer tests).
	const run = (dir: string, cmd: string): string =>
		execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
	const commit = (dir: string, file: string, msg: string): string => {
		writeFileSync(join(dir, file), "x");
		run(dir, `git add ${file} && git commit -qm '${msg}'`);
		return run(dir, "git rev-parse HEAD");
	};

	const setup = (
		name: string,
		opts: { tag?: boolean } = {},
	): {
		dir: string;
		store: ProjectStore;
		projects: Map<string, Entry>;
		cleanup: () => void;
	} => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		run(dir, "git init -q -b main");
		run(dir, "git config user.email t@t && git config user.name t");
		const seed = commit(dir, "seed.txt", "seed");
		if (opts.tag !== false) run(dir, `git tag v0.1.0 ${seed}`);
		commit(dir, "feat.txt", "feat: consolidated feature");
		const store = ProjectStore.open(dir);
		// One done card inside the release window, with the merge counter includedTasks reads.
		const t = store.createTask("add the feature");
		// Entering Done stamps done_at (updateTask), which includedTasks reads; the
		// merge counter makes this card the one inside the release window.
		store.updateTask(t.id, {
			stage: "done",
			state: "idle",
			commits: 1,
		});
		// The card's release notes live in its ready report (the work turn's outcome
		// details), not in Task.details: turn.ts overwrites the details with every
		// settled turn, so the merge turn leaves the integration output there.
		store.finishTurn(store.startTurn(t.id, "work", "work please", null).id, {
			outcome: "ready",
			summary: "did it",
			details: "Release notes from the ready report: quokka counter",
			endedAt: Date.now(),
		});
		store.finishTurn(store.startTurn(t.id, "merge", "merge please", null).id, {
			outcome: "integrated",
			summary: "merged",
			details: "integration output: walrus stdout",
			endedAt: Date.now(),
		});
		store.updateTask(t.id, { details: "integration output: walrus stdout" });
		const entry: Entry = {
			path: dir,
			name,
			store,
			target: "main",
			gitless: false,
			github: null,
			remote: null,
			dirty: false,
			mainUnpushed: false,
			mainBranch: null,
			latestRelease: null,
			latestImage: null,
			archReview: null,
		};
		return {
			dir,
			store,
			projects: new Map([[name, entry]]),
			cleanup: () => rmSync(dir, { recursive: true, force: true }),
		};
	};

	const gateway = (content: string) => {
		const calls: string[] = [];
		const users: string[] = [];
		const spawn: SpawnFn = async (_argv, o) => {
			const body = JSON.parse(o.stdin).body;
			calls.push(body.messages[0].content);
			users.push(body.messages[1].content);
			return {
				code: 0,
				stdout: [
					JSON.stringify({ ready: true }),
					JSON.stringify({
						id: 1,
						status: 200,
						body: { choices: [{ message: { content } }] },
					}),
				].join("\n"),
				stderr: "",
			};
		};
		return { calls, users, spawn };
	};

	test("answers the fake gateway summary with reason null", async () => {
		const s = setup("p-relsum");
		const gw = gateway("## Highlights\n\n- Consolidated");
		try {
			const { call } = mount({
				projects: s.projects,
				releaseSummarySpawn: gw.spawn,
			});
			const res = await call("/api/projects/p-relsum/release-summary", {
				sha: run(s.dir, "git rev-parse HEAD"),
			});
			expect(res.status).toBe(200);
			const b = (await res.json()) as {
				summary: string | null;
				reason: string | null;
			};
			expect(b.summary).toBe("## Highlights\n\n- Consolidated");
			expect(b.reason).toBeNull();
			expect(gw.calls).toHaveLength(1);
			expect(gw.calls[0]).toBe(RELEASE_SUMMARY_INSTRUCTIONS);
		} finally {
			s.cleanup();
		}
	});

	test("card notes come from the ready report, not the overwritten details", async () => {
		const s = setup("p-relsum-source");
		const gw = gateway("## Highlights\n\n- Consolidated");
		try {
			const { call } = mount({
				projects: s.projects,
				releaseSummarySpawn: gw.spawn,
			});
			const res = await call("/api/projects/p-relsum-source/release-summary", {
				sha: run(s.dir, "git rev-parse HEAD"),
			});
			expect(res.status).toBe(200);
			const b = (await res.json()) as {
				summary: string | null;
				reason: string | null;
			};
			expect(b.summary).toBe("## Highlights\n\n- Consolidated");
			expect(b.reason).toBeNull();
			// The model reads the ready report; the merge turn's integration output and
			// the overwritten Task.details never reach it.
			expect(gw.users[0]).toContain(
				"Release notes from the ready report: quokka counter",
			);
			expect(gw.users[0]).toMatch(/- \[[A-Z0-9]+-\d+\] add the feature/);
			expect(gw.users[0]).not.toContain("walrus");
		} finally {
			s.cleanup();
		}
	});

	test("first release without a tag skips the model call", async () => {
		const s = setup("p-relsum-first", { tag: false });
		const gw = gateway("should never run");
		try {
			const { call } = mount({
				projects: s.projects,
				releaseSummarySpawn: gw.spawn,
			});
			const res = await call("/api/projects/p-relsum-first/release-summary", {
				sha: run(s.dir, "git rev-parse HEAD"),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ summary: null, reason: null });
			expect(gw.calls).toHaveLength(0);
		} finally {
			s.cleanup();
		}
	});

	test("a failing gateway answers the fallback with 200", async () => {
		const s = setup("p-relsum-fail");
		const spawn: SpawnFn = async () => ({
			code: 1,
			stdout: "",
			stderr: "no quota",
		});
		try {
			const { call } = mount({
				projects: s.projects,
				releaseSummarySpawn: spawn,
			});
			const res = await call("/api/projects/p-relsum-fail/release-summary", {
				sha: run(s.dir, "git rev-parse HEAD"),
			});
			expect(res.status).toBe(200);
			const b = (await res.json()) as {
				summary: string | null;
				reason: string | null;
			};
			expect(b.summary).toBeNull();
			expect(b.reason).toMatch(/no quota/);
		} finally {
			s.cleanup();
		}
	});

	test("rejects a bad sha with 400", async () => {
		const s = setup("p-relsum-sha");
		const gw = gateway("no");
		try {
			const { call } = mount({
				projects: s.projects,
				releaseSummarySpawn: gw.spawn,
			});
			for (const sha of ["zzz", "abc", "x".repeat(41), 5]) {
				const res = await call("/api/projects/p-relsum-sha/release-summary", {
					sha,
				});
				expect(res.status).toBe(400);
				expect(await errorOf(res)).toBe(
					"sha must be a 7-40 character hex string",
				);
			}
			expect(gw.calls).toHaveLength(0);
		} finally {
			s.cleanup();
		}
	});

	test("POST /release accepts notes and lands them on the release card", async () => {
		const s = setup("p-relnotes");
		try {
			const { call } = mount({ projects: s.projects });
			const res = await call("/api/projects/p-relnotes/release", {
				sha: run(s.dir, "git rev-parse HEAD"),
				notes: "user edited notes",
			});
			expect(res.status).toBe(200);
			const release = s.store
				.listTasks()
				.find((t) => t.releaseVersion !== null);
			expect(release?.releaseNotes).toBe("user edited notes");
			expect(release?.prompt).toContain("user edited notes");
		} finally {
			s.cleanup();
		}
	});

	test("POST /release without notes keeps the planned notes", async () => {
		const s = setup("p-relnotes-plain");
		try {
			const { call } = mount({ projects: s.projects });
			const res = await call("/api/projects/p-relnotes-plain/release", {
				sha: run(s.dir, "git rev-parse HEAD"),
			});
			expect(res.status).toBe(200);
			const release = s.store
				.listTasks()
				.find((t) => t.releaseVersion !== null);
			// No notes: the card stores plan.notes verbatim, rendered by computeRelease.
			expect(release?.releaseNotes).toBe(
				"## New features\n\n- Consolidated feature",
			);
		} finally {
			s.cleanup();
		}
	});

	test("POST /release rejects bad notes with 400", async () => {
		const s = setup("p-relnotes-bad");
		try {
			const { call } = mount({ projects: s.projects });
			for (const notes of [42, "", "   ", "x".repeat(20001)]) {
				const res = await call("/api/projects/p-relnotes-bad/release", {
					sha: run(s.dir, "git rev-parse HEAD"),
					notes,
				});
				expect(res.status).toBe(400);
				expect(await errorOf(res)).toBe(
					"notes must be a string of 1-20000 characters",
				);
			}
		} finally {
			s.cleanup();
		}
	});
});

describe("drawer late commits route", () => {
	const run = (cmd: string): string =>
		execSync(cmd, { cwd: projectDir, stdio: "pipe" }).toString().trim();
	const commit = (file: string, msg: string): string => {
		writeFileSync(join(projectDir, file), "x");
		run(`git add ${file} && git commit -qm '${msg}'`);
		return run("git rev-parse HEAD");
	};

	test("a waiting release card lists the commits past its base, finding merges marked", async () => {
		// The route reads the target head without a fetch, so a local branch without upstream
		// resolves to itself; the repo lives only for this test and is removed afterwards.
		execSync("git init -q -b main", { cwd: projectDir, stdio: "ignore" });
		try {
			run("git config user.email t@t && git config user.name t");
			commit("seed.txt", "seed");
			const reviewed = run("git rev-parse HEAD");
			const fix = commit("fix.txt", "fix: y");
			const feat = commit("feat.txt", "feat: z");
			const e = projects.get("p1")!;
			const prevTarget = e.target;
			e.target = "main";
			try {
				const release = store.createTask("release card");
				store.updateTask(release.id, {
					releaseVersion: "v1.2.3",
					state: "needs_you",
					stage: "merging",
					base: reviewed,
				});
				const finding = store.createTask("fix finding");
				store.updateTask(finding.id, {
					followUpOf: release.id,
					stage: "done",
					state: "idle",
					mergeHead: fix,
				});
				// The parked release card has no doneAt, so reviewFindings counts every
				// card it filed, this one included.
				const res = await get(`/api/projects/p1/tasks/${release.id}`);
				expect(res.status).toBe(200);
				const view = (await res.json()) as { lateCommits?: unknown };
				expect(view.lateCommits).toEqual([
					{ sha: feat, subject: "feat: z", reviewed: false },
					{ sha: fix, subject: "fix: y", reviewed: true },
				]);
				const plain = store.createTask("plain card");
				const plainRes = await get(`/api/projects/p1/tasks/${plain.id}`);
				expect(plainRes.status).toBe(200);
				expect(
					((await plainRes.json()) as { lateCommits?: unknown }).lateCommits,
				).toBeUndefined();
			} finally {
				e.target = prevTarget;
			}
		} finally {
			rmSync(join(projectDir, ".git"), { recursive: true, force: true });
		}
	});
});

describe("github token", () => {
	// Own global store: creating the admin here must not end onboarding for the shared app.
	const g = GlobalStore.open(join(root, "g-token"));
	const boot = () =>
		createApp({
			gstore: g,
			defaultDir: root,
			projects: new Map(),
			...loopStubs(),
			schedule: () => {},
			serverVersion: "test",
			port: 0,
			publicHosts: [],
			shared: {
				maxTotalRuns: 3,
				reviewCheck: true,
				workCheck: true,
				idleReviews: true,
				removedPaths: [],
				envValues: {},
				projectPaths: [],
				projectOrder: [],
			},
			serverRef: { current: undefined },
			// The save probes at once; a stub keeps the test off the network.
			githubTokenExpiry: async () => null,
		});
	const served = boot();
	const srv = Bun.serve({ port: 0, ...served.serveOptions });
	served.serverRef.current = srv; // api() reads the connection's address through it
	const savedToken = process.env.GH_TOKEN;
	afterAll(() => {
		srv.stop(true);
		g.close();
		if (savedToken === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = savedToken;
	});
	const call = (path: string, body?: unknown) =>
		fetch(new URL(path, srv.url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const first = `ghp_${"a".repeat(36)}`;
	const second = `github_pat_${"b".repeat(82)}`;
	const admin = { name: "ada", password: "correct horse" };
	// A getter: after `delete`, TypeScript narrows a direct read to undefined for good.
	const ghToken = (): string | undefined => process.env.GH_TOKEN;

	test("onboarding needs a token-shaped GitHub token and gives it to server-side git", async () => {
		delete process.env.GH_TOKEN;
		const missing = await call("/api/setup", admin);
		expect(missing.status).toBe(400);
		// A second line would smuggle extra fields into the git credential helper's answer.
		const twoLines = await call("/api/setup", {
			...admin,
			githubToken: `${first}\nusername=x`,
		});
		expect(twoLines.status).toBe(400);
		expect(ghToken()).toBeUndefined();
		const ok = await call("/api/setup", {
			...admin,
			githubToken: ` ${first} `,
		});
		expect(ok.status).toBe(200);
		expect(ghToken()).toBe(first);
		// Write-only: the views say whether it is set, never what it is.
		expect(await (await call("/api/settings/github-token")).json()).toEqual({
			tokenSet: true,
			expiresAt: null,
		});
		expect(await (await call("/api/state")).text()).not.toContain(first);
	});

	test("Settings replaces the token; a bad one keeps the old; boot reapplies it", async () => {
		const bad = await call("/api/settings/github-token", { token: "short" });
		expect(bad.status).toBe(400);
		expect(ghToken()).toBe(first);
		const ok = await call("/api/settings/github-token", { token: second });
		expect(ok.status).toBe(200);
		expect(ghToken()).toBe(second);
		delete process.env.GH_TOKEN; // a restarted server starts without it
		boot();
		expect(ghToken()).toBe(second);
	});
});

describe("settings env", () => {
	// env.txt name lists as alate would provision them under <home>/.ottr/workers.
	const workersDir = join(root, ".ottr", "workers");
	beforeAll(() => {
		mkdirSync(join(workersDir, "_all"), { recursive: true });
		mkdirSync(join(workersDir, "p1"), { recursive: true });
		writeFileSync(join(workersDir, "_all", "env.txt"), "API_KEY\nDB_PASS\n");
		writeFileSync(join(workersDir, "p1", "env.txt"), "API_KEY\n");
	});
	afterAll(() => {
		rmSync(workersDir, { recursive: true, force: true });
	});

	test("GET lists the union of names with projects and set state; POST stores without echoing", async () => {
		const before = await get("/api/settings/env");
		expect(before.status).toBe(200);
		expect(await before.json()).toEqual({
			names: [
				{ name: "API_KEY", projects: ["_all", "p1"], set: false },
				{ name: "DB_PASS", projects: ["_all"], set: false },
			],
		});
		const value = "s3cret-env-value";
		const saved = await post("/api/settings/env", {
			name: "API_KEY",
			value,
		});
		expect(saved.status).toBe(200);
		expect(await saved.json()).toEqual({ ok: true });
		// The stored value reaches redaction and the turn loop, never an answer.
		expect(gitSecrets()).toContain(value);
		expect(shared.envValues["API_KEY"]).toBe(value);
		const after = await get("/api/settings/env");
		const text = await after.text();
		// The parsed answer and its raw body never hold the value.
		expect(JSON.parse(text)).toEqual({
			names: [
				{ name: "API_KEY", projects: ["_all", "p1"], set: true },
				{ name: "DB_PASS", projects: ["_all"], set: false },
			],
		});
		expect(text).not.toContain(value);
	});

	test("POST rejects an unlisted name and a bad name", async () => {
		expect(
			(await post("/api/settings/env", { name: "NOT_LISTED", value: "x" }))
				.status,
		).toBe(400);
		expect(
			(await post("/api/settings/env", { name: "bad-name", value: "x" }))
				.status,
		).toBe(400);
	});
});

describe("hindsight settings", () => {
	// Stand-in for the NAS Hindsight: its bank list answers only the tenant key.
	const hindsight = Bun.serve({
		port: 0,
		fetch: (req) =>
			new Response(null, {
				status:
					new URL(req.url).pathname === "/v1/default/banks" &&
					req.headers.get("authorization") === "Bearer key-two"
						? 200
						: 401,
			}),
	});
	const url = `http://127.0.0.1:${hindsight.port}`;
	const saved = {
		HINDSIGHT_API_URL: process.env.HINDSIGHT_API_URL,
		HINDSIGHT_API_TOKEN: process.env.HINDSIGHT_API_TOKEN,
	};
	afterAll(() => {
		hindsight.stop(true);
		for (const [k, v] of Object.entries(saved))
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
	});
	// The board no longer edits ~/.omp/agent/config.yml: point HOME at a stand-in so a
	// regression that writes there fails these tests instead of touching the developer's own
	// omp config. flipCfg stays absent unless the board writes it.
	const savedHome = process.env.HOME;
	const flipHome = mkdtempSync(join(tmpdir(), "ottr-hindsight-home"));
	const flipCfg = join(flipHome, ".omp", "agent", "config.yml");
	beforeAll(() => {
		process.env.HOME = flipHome;
	});
	afterAll(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(flipHome, { recursive: true, force: true });
	});
	// A getter: after an assignment, TypeScript narrows a direct read for good.
	const token = (): string | undefined => process.env.HINDSIGHT_API_TOKEN;
	const set = (t: string) => post("/api/settings/hindsight", { token: t });
	// A restarted server: a fresh app on the same store, with its own HTTP surface so tests
	// can read its view and state frame (the outer get/post hit the long-lived app instead).
	// Returns its request fn and an awaited memory health tick.
	const boot = () => {
		const created = createApp({
			gstore,
			defaultDir: root,
			projects: new Map(),
			...loopStubs(),
			schedule: () => {},
			serverVersion: "test",
			port: 0,
			publicHosts: [],
			shared: {
				maxTotalRuns: 3,
				reviewCheck: true,
				workCheck: true,
				idleReviews: true,
				removedPaths: [],
				envValues: {},
				projectPaths: [],
				projectOrder: [],
			},
			serverRef: { current: undefined },
		});
		const srv = Bun.serve({ port: 0, ...created.serveOptions });
		created.serverRef.current = srv;
		mounted.push(srv);
		const call = (path: string, body?: unknown): Promise<Response> =>
			fetch(new URL(path, srv.url), {
				method: body === undefined ? "GET" : "POST",
				headers: {
					...(body === undefined ? {} : { "content-type": "application/json" }),
					Host: "127.0.0.1:0",
					Origin: "http://127.0.0.1:0",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		return { call, tick: () => created.memoryHealthTick() };
	};
	// The config blob keeps the last saved URL and key; tests that pin the env's effect
	// start from a store without them.
	const clearSavedHindsight = (): void => {
		const cfg = gstore.get<Record<string, unknown>>("config");
		if (cfg === null || typeof cfg !== "object") return;
		const { hindsightUrl: _url, hindsightToken: _token, ...rest } = cfg;
		gstore.set("config", rest);
	};

	test("Settings keeps only a key Hindsight accepts, hands it to new turns and reapplies it at boot", async () => {
		process.env.HINDSIGHT_API_URL = url;
		process.env.HINDSIGHT_API_TOKEN = "key-one"; // the compose env file's seed
		expect((await set("key-bad")).status).toBe(400);
		expect(token()).toBe("key-one");
		expect((await set(" key-two ")).status).toBe(200);
		expect(token()).toBe("key-two");
		// Write-only: the views say whether a key is set, never what it is.
		expect(await (await get("/api/settings/hindsight")).json()).toEqual({
			url,
			tokenSet: true,
			// The save's fresh check against the stand-in answered 2xx.
			backend: "hindsight",
			memoryReason: null,
		});
		expect(await (await get("/api/state")).text()).not.toContain("key-two");
		// A restarted server starts from the env file's seed again; the stored key wins.
		process.env.HINDSIGHT_API_TOKEN = "key-one";
		boot();
		expect(token()).toBe("key-two");
		// A board without a Hindsight server leaves the key to omp's own settings.
		delete process.env.HINDSIGHT_API_URL;
		process.env.HINDSIGHT_API_TOKEN = "key-one";
		boot();
		expect(token()).toBe("key-one");
		// A server that does not answer keeps the last good key.
		process.env.HINDSIGHT_API_URL = url;
		process.env.HINDSIGHT_API_TOKEN = "key-two";
		hindsight.stop(true);
		expect((await set("key-three")).status).toBe(502);
		expect(token()).toBe("key-two");
	});

	test("Settings keeps the server URL too: a saved URL beats the env seed at boot and the key check runs against it", async () => {
		// Two more stand-ins that answer "key-two"; their URLs are what the board stores.
		const serveKeyTwo = () =>
			Bun.serve({
				port: 0,
				fetch: (req) =>
					new Response(null, {
						status:
							new URL(req.url).pathname === "/v1/default/banks" &&
							req.headers.get("authorization") === "Bearer key-two"
								? 200
								: 401,
					}),
			});
		const first = serveKeyTwo();
		const other = serveKeyTwo();
		const firstUrl = `http://127.0.0.1:${first.port}`;
		const otherUrl = `http://127.0.0.1:${other.port}`;
		const savedUrl = process.env.HINDSIGHT_API_URL;
		afterAll(() => {
			first.stop(true);
			other.stop(true);
			if (savedUrl === undefined) delete process.env.HINDSIGHT_API_URL;
			else process.env.HINDSIGHT_API_URL = savedUrl;
		});
		const postUrl = (body: Record<string, string>) =>
			post("/api/settings/hindsight", body);
		const envUrl = (): string | undefined => process.env.HINDSIGHT_API_URL;
		process.env.HINDSIGHT_API_URL = firstUrl;
		process.env.HINDSIGHT_API_TOKEN = "key-two";
		// A save with a new URL and key checks the key against the new URL.
		expect(
			await postUrl({ url: otherUrl, token: "key-two" }).then((r) => r.status),
		).toBe(200);
		expect(await (await get("/api/settings/hindsight")).json()).toEqual({
			url: otherUrl,
			tokenSet: true,
			backend: "hindsight",
			memoryReason: null,
		});
		expect(envUrl()).toBe(otherUrl);
		// A malformed URL is rejected and leaves the env alone.
		expect((await postUrl({ url: "not a url" })).status).toBe(400);
		expect(envUrl()).toBe(otherUrl);
		expect((await postUrl({ url: "ftp://x.example" })).status).toBe(400);
		// A URL-only save keeps the key already in effect.
		expect((await postUrl({ url: firstUrl })).status).toBe(200);
		expect(await (await get("/api/settings/hindsight")).json()).toEqual({
			url: firstUrl,
			tokenSet: true,
			backend: "hindsight",
			memoryReason: null,
		});
		expect(token()).toBe("key-two");
		// A restarted server starts from the env file's seed again; the stored URL wins.
		process.env.HINDSIGHT_API_URL = otherUrl;
		boot();
		expect(envUrl()).toBe(firstUrl);
		expect(token()).toBe("key-two");
	});

	test("boot derives the backend from the env: hindsight with a URL, mnemopi without", async () => {
		clearSavedHindsight();
		const standIn = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 200 }),
		});
		const standInUrl = `http://127.0.0.1:${standIn.port}`;
		try {
			process.env.HINDSIGHT_API_URL = standInUrl;
			process.env.HINDSIGHT_API_TOKEN = "key-two";
			let booted = boot();
			await booted.tick();
			expect(
				await (await booted.call("/api/settings/hindsight")).json(),
			).toEqual({
				url: standInUrl,
				tokenSet: true,
				backend: "hindsight",
				memoryReason: null,
			});
			// The boot above never touched config.yml.
			expect(existsSync(flipCfg)).toBe(false);
			// A stale backend line from the old flip is inert: the env decides, and the
			// board never rewrites the file.
			mkdirSync(dirname(flipCfg), { recursive: true });
			writeFileSync(flipCfg, "memory:\n  backend: hindsight\n");
			delete process.env.HINDSIGHT_API_URL;
			booted = boot();
			await booted.tick();
			expect(
				await (await booted.call("/api/settings/hindsight")).json(),
			).toEqual({
				url: null,
				tokenSet: true,
				backend: "mnemopi",
				memoryReason: null,
			});
			expect(readFileSync(flipCfg, "utf8")).toBe(
				"memory:\n  backend: hindsight\n",
			);
		} finally {
			standIn.stop(true);
		}
	});

	const stateWarnings = async (
		call: (path: string) => Promise<Response>,
	): Promise<string[]> =>
		((await (await call("/api/state")).json()) as { warnings: string[] })
			.warnings;

	test("an unreachable server surfaces its reason in the view and the state warnings", async () => {
		clearSavedHindsight();
		const dead = Bun.serve({ port: 0, fetch: () => new Response(null) });
		const deadUrl = `http://127.0.0.1:${dead.port}`;
		dead.stop(true);
		process.env.HINDSIGHT_API_URL = deadUrl;
		const booted = boot();
		await booted.tick();
		const v = (await (await booted.call("/api/settings/hindsight")).json()) as {
			backend: string;
			memoryReason: string;
		};
		expect(v.backend).toBe("hindsight");
		expect(v.memoryReason).toMatch(/did not answer/);
		expect(await stateWarnings(booted.call)).toContain(
			`omp runs with no memory: ${v.memoryReason}`,
		);
	});

	test("a refused key surfaces a rejected-key reason that never names the key", async () => {
		clearSavedHindsight();
		const rejector = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 401 }),
		});
		try {
			process.env.HINDSIGHT_API_URL = `http://127.0.0.1:${rejector.port}`;
			process.env.HINDSIGHT_API_TOKEN = "secret-token-value";
			const booted = boot();
			await booted.tick();
			const v = (await (
				await booted.call("/api/settings/hindsight")
			).json()) as { memoryReason: string };
			expect(v.memoryReason).toMatch(/rejected the key/);
			expect(v.memoryReason).not.toContain("secret-token-value");
			expect(await stateWarnings(booted.call)).toContain(
				`omp runs with no memory: ${v.memoryReason}`,
			);
		} finally {
			rejector.stop(true);
		}
	});

	test("a healthy server means a null reason and no memory warning", async () => {
		clearSavedHindsight();
		const healthy = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 200 }),
		});
		try {
			process.env.HINDSIGHT_API_URL = `http://127.0.0.1:${healthy.port}`;
			process.env.HINDSIGHT_API_TOKEN = "key-two";
			const booted = boot();
			await booted.tick();
			const v = (await (
				await booted.call("/api/settings/hindsight")
			).json()) as { memoryReason: string | null };
			expect(v.memoryReason).toBeNull();
			expect(await stateWarnings(booted.call)).not.toContain(
				expect.stringMatching(/^omp runs with no memory:/),
			);
		} finally {
			healthy.stop(true);
		}
	});

	test("a save reports the health of the new URL immediately", async () => {
		clearSavedHindsight();
		const dead = Bun.serve({ port: 0, fetch: () => new Response(null) });
		const deadEndpoint = `http://127.0.0.1:${dead.port}`;
		dead.stop(true);
		process.env.HINDSIGHT_API_URL = deadEndpoint;
		process.env.HINDSIGHT_API_TOKEN = "key-two";
		const booted = boot();
		await booted.tick();
		const v = (await (await booted.call("/api/settings/hindsight")).json()) as {
			memoryReason: string;
		};
		expect(v.memoryReason).toMatch(/did not answer/);
		const healthy = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 200 }),
		});
		try {
			const res = await booted.call("/api/settings/hindsight", {
				url: `http://127.0.0.1:${healthy.port}`,
				token: "key-two",
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				url: `http://127.0.0.1:${healthy.port}`,
				tokenSet: true,
				backend: "hindsight",
				memoryReason: null,
			});
		} finally {
			healthy.stop(true);
		}
	});
});

describe("turns' own host", () => {
	// A turn on a worker connects from the worker's own address, not loopback.
	let peer: Mock<typeof server.requestIP>;
	beforeAll(() => {
		peer = spyOn(server, "requestIP").mockReturnValue({
			address: "172.18.0.3",
			family: "IPv4",
			port: 1,
		});
	});
	afterAll(() => peer.mockRestore());
	const asTurn = (token: string | null, origin = "http://ottr:4852") => ({
		Host: "ottr:4852",
		Origin: origin,
		...(token === null ? {} : { "x-board-token": token }),
	});

	test("files a card only with the boot token, and opens nothing else", async () => {
		const card = { prompt: "found while reviewing" };
		const file = (headers: Record<string, string>) =>
			post("/api/projects/p1/tasks", card, headers);
		expect((await file(asTurn(null))).status).toBe(401);
		expect((await file(asTurn("guess"))).status).toBe(401);
		// The token authenticates; the request must still carry the host's own origin.
		expect(
			(await file(asTurn(BOARD_TOKEN, "http://evil.example"))).status,
		).toBe(403);
		const filed = await file(asTurn(BOARD_TOKEN));
		expect(filed.status).toBe(200);
		const b: unknown = await filed.json();
		const id =
			typeof b === "object" && b !== null && "id" in b ? String(b.id) : "";
		expect(store.getTask(id)?.prompt).toBe("found while reviewing");
		// Everything else on that host stays shut, even with the token.
		expect(
			(await post("/api/settings/api-key", {}, asTurn(BOARD_TOKEN))).status,
		).toBe(403);
		const state = await fetch(new URL("/api/state", server.url), {
			headers: asTurn(BOARD_TOKEN),
		});
		expect(state.status).toBe(403);
		// A board check runs in the server's own container: a worker's turn must not start one.
		const checkBefore = store.boardCheckId();
		expect(
			(await post("/api/projects/p1/board-check", {}, asTurn(BOARD_TOKEN)))
				.status,
		).toBe(403);
		expect(store.boardCheckId()).toBe(checkBefore);
	});
});

describe("readJson bounds untrusted bodies (R1-2)", () => {
	test("413 and cancel on an endless chunked body with no Content-Length", async () => {
		let canceled = false;
		const chunk = new Uint8Array(8192).fill(0x61); // never ends, never declares a length
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(chunk);
			},
			cancel() {
				canceled = true;
			},
		});
		const res = await fetch(new URL("/api/login", server.url), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
			},
			body,
			duplex: "half",
		} as RequestInit);
		expect(res.status).toBe(413);
		// readJson awaits reader.cancel() before returning the 413, and Bun.serve shares
		// this process: the source's cancel callback has run by the time headers arrive.
		expect(canceled).toBe(true);
	});

	test("a body within the limit still parses and reaches the handler", async () => {
		const res = await post("/api/projects", { name: "a/b" });
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe(
			"name must be a folder name without path separators",
		);
	});
});

describe("loopback Host from another machine or container", () => {
	// Compose publishes the port through the Docker gateway, and any container that reaches the
	// board can fake a loopback Host header: only the connection's own address tells them apart.
	const g = GlobalStore.open(join(root, "g-wall"));
	g.set("config", {
		admin: { name: "ada", passHash: hashPassword("correct horse") },
		apiKey: "wall-key",
		sessionSecret: "wall-secret",
	});
	const wall = createApp({
		gstore: g,
		defaultDir: root,
		projects: new Map(),
		...loopStubs(),
		schedule: () => {},
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared: {
			maxTotalRuns: 3,
			reviewCheck: true,
			workCheck: true,
			idleReviews: true,
			removedPaths: [],
			envValues: {},
			projectPaths: [],
			projectOrder: [],
		},
		serverRef: { current: undefined },
	});
	const srv = Bun.serve({ port: 0, ...wall.serveOptions });
	wall.serverRef.current = srv;
	afterAll(() => {
		srv.stop(true);
		g.close();
	});
	const call = (
		path: string,
		headers: Record<string, string> = {},
		body?: unknown,
	) =>
		fetch(new URL(path, srv.url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

	test("needs the login or the API key, like a public host; a loopback peer stays open", async () => {
		const gateway = spyOn(srv, "requestIP").mockReturnValue({
			address: "172.18.0.1",
			family: "IPv4",
			port: 1,
		});
		expect((await call("/api/state")).status).toBe(401);
		expect((await call("/api/ws")).status).toBe(401);
		expect((await call("/api/state", { "x-api-key": "wall-key" })).status).toBe(
			200,
		);
		const login = await call(
			"/api/login",
			{},
			{ name: "ada", password: "correct horse" },
		);
		expect(login.status).toBe(200);
		// Plain http on 127.0.0.1: the browser would never send a Secure cookie back.
		const cookie = login.headers.get("set-cookie") ?? "";
		expect(cookie).not.toContain("Secure");
		const session = { cookie: cookie.split(";")[0] ?? "" };
		expect((await call("/api/state", session)).status).toBe(200);
		// Past the guard: only the missing upgrade headers stop the handshake.
		expect((await call("/api/ws", session)).status).toBe(400);
		gateway.mockRestore();
		expect((await call("/api/state")).status).toBe(200);
		expect((await call("/api/ws")).status).toBe(400);
	});

	test("a loopback peer carrying proxy headers is remote too (R2-1)", async () => {
		// tailscale serve forwards from 127.0.0.1 with X-Forwarded-For/-Host set: the old
		// viaLoopback trusted the peer IP alone and let every tailnet client read the board.
		const proxied = spyOn(srv, "requestIP").mockReturnValue({
			address: "127.0.0.1",
			family: "IPv4",
			port: 1,
		});
		expect(
			(await call("/api/state", { "x-forwarded-for": "100.64.0.7" })).status,
		).toBe(401);
		expect(
			(
				await call("/api/state", {
					"x-forwarded-host": "board.tail-net.ts.net",
				})
			).status,
		).toBe(401);
		expect(
			(await call("/api/ws", { "x-forwarded-for": "100.64.0.7" })).status,
		).toBe(401);
		// Without the headers the same peer stays zero-auth loopback.
		expect((await call("/api/state")).status).toBe(200);
		proxied.mockRestore();
	});
});

describe("reply validation (R1-9)", () => {
	test("empty text is refused without consuming the task", async () => {
		const t = store.createTask("needs reply");
		store.updateTask(t.id, { state: "needs_you", needsReason: "?" });
		const empty = await post(`/api/projects/p1/tasks/${t.id}/reply`, {
			text: "   ",
		});
		expect(empty.status).toBe(400);
		// Old code queued the empty reply: runTurn then re-sent the whole task prompt.
		const row = store.getTask(t.id)!;
		expect(row.state).toBe("needs_you");
		expect(row.pendingPrompt).toBeNull();
	});

	test("oversized text is refused", async () => {
		const t = store.createTask("long reply");
		store.updateTask(t.id, { state: "needs_you", needsReason: "?" });
		const long = await post(`/api/projects/p1/tasks/${t.id}/reply`, {
			text: "x".repeat(20001),
		});
		expect(long.status).toBe(400);
		expect(store.getTask(t.id)!.state).toBe("needs_you");
	});
});

describe("merge anyway (OTTR-28)", () => {
	const blockersRun = () => ({
		at: 1,
		model: null,
		outcome: "blockers" as const,
		notes: [],
		durationMs: 5,
		blockers: [
			{ finding: "still open", quote: "q1" },
			{
				finding: "already fixed",
				quote: "q2",
				status: "fixed" as const,
				statusReason: "confirmed by the next check",
			},
		],
	});
	const inProgress = (log: unknown[]) => {
		const t = store.createTask("merge anyway card");
		store.updateTask(t.id, {
			stage: "in_progress",
			state: "idle",
			workCheckLog: log as Task["workCheckLog"],
		});
		return t;
	};

	test("overrides the open blockers and queues the merge", async () => {
		const t = inProgress([blockersRun()]);
		const before = calls;
		const ok = await post(`/api/projects/p1/tasks/${t.id}/merge-anyway`, {
			reason: "the finding does not apply to this release",
		});
		expect(ok.status).toBe(200);
		const row = store.getTask(t.id)!;
		expect(row.stage).toBe("merging");
		expect(row.state).toBe("queued");
		expect(row.pendingPrompt).toBeNull();
		const [b1, b2] = row.workCheckLog[0]!.blockers;
		expect(b1!.status).toBe("overridden");
		expect(b1!.statusReason).toBe("the finding does not apply to this release");
		// The already-fixed blocker keeps its own resolution.
		expect(b2!.status).toBe("fixed");
		expect(b2!.statusReason).toBe("confirmed by the next check");
		expect(calls).toBe(before + 1);
	});

	test("an empty or oversized reason is refused", async () => {
		const t = inProgress([blockersRun()]);
		const empty = await post(`/api/projects/p1/tasks/${t.id}/merge-anyway`, {
			reason: "   ",
		});
		expect(empty.status).toBe(400);
		expect(await errorOf(empty)).toBe("reason must be 1-2000 characters");
		const long = await post(`/api/projects/p1/tasks/${t.id}/merge-anyway`, {
			reason: "x".repeat(2001),
		});
		expect(long.status).toBe(400);
		expect(store.getTask(t.id)!.stage).toBe("in_progress");
	});

	test("no outstanding blockers is a 409", async () => {
		const t = inProgress([]);
		const res = await post(`/api/projects/p1/tasks/${t.id}/merge-anyway`, {
			reason: "why not",
		});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("no outstanding work-check blockers");
	});

	test("a running work turn is a 409", async () => {
		const t = inProgress([blockersRun()]);
		store.updateTask(t.id, { state: "running" });
		const res = await post(`/api/projects/p1/tasks/${t.id}/merge-anyway`, {
			reason: "why not",
		});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("the work turn is still running");
	});

	const parked = () => {
		const t = inProgress([blockersRun()]);
		store.updateTask(t.id, {
			state: "needs_you",
			needsReason: `${WORK_CHECK_THIRD_BLOCK}: 1. still open.`,
			asked: workCheckAsk([{ finding: "still open", quote: "q1" }]),
			workCheckSendbacks: 2,
		});
		return t;
	};

	test("the third block's Merge anyway answer overrides the blockers and queues the merge", async () => {
		const t = parked();
		const res = await post(`/api/projects/p1/tasks/${t.id}/reply`, {
			text: "Merge anyway",
		});
		expect(res.status).toBe(200);
		const row = store.getTask(t.id)!;
		expect(row.stage).toBe("merging");
		expect(row.state).toBe("queued");
		expect(row.asked).toBeNull();
		expect(row.pendingPrompt).toBeNull();
		expect(row.workCheckLog[0]!.blockers[0]!.status).toBe("overridden");
	});

	test("the third block's Send it back answer resends the open blockers to the agent", async () => {
		const t = parked();
		const res = await post(`/api/projects/p1/tasks/${t.id}/reply`, {
			text: "Send it back",
		});
		expect(res.status).toBe(200);
		const row = store.getTask(t.id)!;
		expect(row.stage).toBe("in_progress");
		expect(row.state).toBe("queued");
		expect(row.asked).toBeNull();
		expect(row.workCheckSendbacks).toBe(3);
		// A tracker send-back, so the next check does not count it as a human reply.
		expect(row.pendingPrompt).toStartWith(WORK_CHECK_SENDBACK_OPENING);
		expect(row.pendingPrompt).toContain("still open");
		expect(row.pendingPrompt).not.toContain("already fixed");
	});

	test("any other answer is a plain reply to the agent", async () => {
		const t = parked();
		await post(`/api/projects/p1/tasks/${t.id}/reply`, {
			text: "Merge anyway, but fix the README first",
		});
		const row = store.getTask(t.id)!;
		expect(row.stage).toBe("in_progress");
		expect(row.pendingPrompt).toBe("Merge anyway, but fix the README first");
		expect(row.workCheckLog[0]!.blockers[0]!.status).toBeUndefined();
	});
});

describe("project settings validation", () => {
	test("settings bounds table", async () => {
		const cases: Array<[string, number[], number[], string, number]> = [
			// field, bad values, good values, error fragment, final good value
			["maxParallel", [0, 1.5], [1, 9], "or null", 9],
			["keptWorktreeDays", [-1, 366], [0, 365], "between 0 and 365", 365],
		];
		for (const [field, bad, good, fragment, final] of cases) {
			for (const v of bad) {
				const res = await post("/api/projects/p1/settings", { [field]: v });
				expect(res.status).toBe(400);
				expect(await errorOf(res)).toContain(fragment);
			}
			for (const v of good) {
				const res = await post("/api/projects/p1/settings", { [field]: v });
				expect(res.status).toBe(200);
			}
			expect(
				store.getSettings()[field as "maxParallel" | "keptWorktreeDays"],
			).toBe(final);
		}
	});

	test("maxImages accepts any integer of at least 1 and persists", async () => {
		const bad = await post("/api/projects/p1/settings", { maxImages: 0 });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe(
			"maxImages must be an integer of at least 1",
		);
		const ok = await post("/api/projects/p1/settings", { maxImages: 25 });
		expect(ok.status).toBe(200);
		expect(store.getSettings().maxImages).toBe(25);
	});

	test("targetBranch accepts a bare branch name, trims it, empty clears to null, and rejects bad names", async () => {
		const error =
			"targetBranch must be a bare git branch name of at most 200 characters";
		for (const v of ["-x", "a b", "origin/x"]) {
			const res = await post("/api/projects/p1/settings", {
				targetBranch: v,
			});
			expect(res.status).toBe(400);
			expect(await errorOf(res)).toBe(error);
		}
		// A non-string gets the shape error, like the other string settings.
		const wrongType = await post("/api/projects/p1/settings", {
			targetBranch: 5,
		});
		expect(wrongType.status).toBe(400);
		expect(await errorOf(wrongType)).toBe(
			"targetBranch must be a string or null",
		);
		// The accepted saves run the route's resolve pre-check, so they need a real
		// repo whose origin holds the branch (p1's folder has no git at all).
		const dir = join(root, "target-shape-proj");
		const add = await post("/api/projects", { name: "target-shape-proj" });
		expect(add.status).toBe(200);
		const pe = projects.get("target-shape-proj")!;
		execSync("git update-ref refs/remotes/origin/develop HEAD", { cwd: dir });
		const ok = await post("/api/projects/target-shape-proj/settings", {
			targetBranch: "  develop  ",
		});
		expect(ok.status).toBe(200);
		expect(pe.store.getSettings().targetBranch).toBe("develop");
		// A patch without targetBranch leaves the stored value untouched.
		await post("/api/projects/target-shape-proj/settings", { maxImages: 3 });
		expect(pe.store.getSettings().targetBranch).toBe("develop");
		const clear = await post("/api/projects/target-shape-proj/settings", {
			targetBranch: "",
		});
		expect(clear.status).toBe(200);
		expect(pe.store.getSettings().targetBranch).toBeNull();
		projects.delete("target-shape-proj");
		pe.store.close();
	});

	test("saving targetBranch moves the board target at once", async () => {
		const dir = join(root, "target-save-proj");
		const add = await post("/api/projects", { name: "target-save-proj" });
		expect(add.status).toBe(200);
		const e = projects.get("target-save-proj")!;
		// A second branch on origin, different from the checked-out head: only a
		// targetBranch-aware resolution can land on it.
		const tree = execSync("git rev-parse HEAD^{tree}", { cwd: dir })
			.toString()
			.trim();
		const other = execSync(
			"git -c user.name=ott -c user.email=ott@example.invalid commit-tree " +
				`${tree} -m feature`,
			{ cwd: dir },
		)
			.toString()
			.trim();
		execSync(`git update-ref refs/remotes/origin/feature ${other}`, {
			cwd: dir,
		});
		e.target = "origin/main";
		const res = await post("/api/projects/target-save-proj/settings", {
			targetBranch: "feature",
		});
		expect(res.status).toBe(200);
		expect(e.target).toBe("origin/feature");
		// A save that does not touch the target leaves it alone.
		const other2 = await post("/api/projects/target-save-proj/settings", {
			maxImages: 5,
		});
		expect(other2.status).toBe(200);
		expect(e.target).toBe("origin/feature");
		projects.delete("target-save-proj");
		e.store.close();
	});

	test("saving an unresolvable targetBranch returns 409 and keeps the old target", async () => {
		const dir = join(root, "target-bad-proj");
		const add = await post("/api/projects", { name: "target-bad-proj" });
		expect(add.status).toBe(200);
		const e = projects.get("target-bad-proj")!;
		e.target = "origin/main";
		const res = await post("/api/projects/target-bad-proj/settings", {
			targetBranch: "nope",
		});
		// The branch does not exist on origin: the save is refused whole, with the
		// resolve error naming the typo, and nothing about the board changes.
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("cannot resolve origin/nope");
		expect(e.store.getSettings().targetBranch).toBeNull();
		expect(e.target).toBe("origin/main");
		// A resolvable branch still saves normally afterwards.
		execSync("git update-ref refs/remotes/origin/feature HEAD", { cwd: dir });
		const ok = await post("/api/projects/target-bad-proj/settings", {
			targetBranch: "feature",
		});
		expect(ok.status).toBe(200);
		expect(e.target).toBe("origin/feature");
		projects.delete("target-bad-proj");
		e.store.close();
	});
});

describe("push-main route (OTTR-531)", () => {
	// Real repos: a bare origin plus a clone whose main is one commit ahead. execSync
	// fixtures only, like the release-summary and behindMain describes.
	const run = (dir: string, cmd: string): string =>
		execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();

	const setup = (
		name: string,
	): {
		origin: string;
		dir: string;
		store: ProjectStore;
		entry: Entry;
		projects: Map<string, Entry>;
		cleanup: () => void;
	} => {
		const origin = join(root, `${name}-origin`);
		const dir = join(root, name);
		run(root, `git init -q --bare -b main ${origin}`);
		run(root, `git clone -q ${origin} ${dir}`);
		run(dir, "git config user.email t@t && git config user.name t");
		writeFileSync(join(dir, "seed.txt"), "x");
		run(dir, "git add seed.txt && git commit -qm seed");
		run(dir, "git push -q origin main");
		// The clone's main is ahead of origin: exactly what the endpoint is allowed to push.
		writeFileSync(join(dir, "ahead.txt"), "x");
		run(dir, "git add ahead.txt && git commit -qm ahead");
		const store = ProjectStore.open(dir);
		store.setSettings({ originUrl: origin });
		const entry: Entry = {
			path: dir,
			name,
			store,
			target: "origin/main",
			gitless: false,
			github: null,
			remote: null,
			dirty: false,
			mainUnpushed: true,
			mainBranch: "main",
			latestRelease: null,
			latestImage: null,
			archReview: null,
		};
		return {
			origin,
			dir,
			store,
			entry,
			projects: new Map([[name, entry]]),
			cleanup: () => {
				rmSync(dir, { recursive: true, force: true });
				rmSync(origin, { recursive: true, force: true });
			},
		};
	};

	test("an approved push moves origin to the local main and clears the flag", async () => {
		const s = setup("p-pushmain");
		try {
			const m = mount({ projects: s.projects });
			const res = await m.call("/api/projects/p-pushmain/push-main", {});
			expect(res.status).toBe(200);
			const b = (await res.json()) as { status: string };
			expect(b.status).toBe("pushed");
			// The bare origin's main ref now equals the clone's local main tip.
			expect(run(s.origin, "git rev-parse main")).toBe(
				run(s.dir, "git rev-parse refs/heads/main"),
			);
			// The hold lifts at once, without waiting for the scheduler tick.
			expect(s.entry.mainUnpushed).toBe(false);
		} finally {
			s.cleanup();
		}
	});

	test("unknown project is 404 and a null target is 409; nothing pushes", async () => {
		const s = setup("p-pushnull");
		try {
			// Null target: the route must refuse before any git call.
			s.entry.target = null;
			const m = mount({ projects: s.projects });
			const none = await m.call("/api/projects/nope/push-main", {});
			expect(none.status).toBe(404);
			expect(await errorOf(none)).toBe("unknown project");
			const res = await m.call("/api/projects/p-pushnull/push-main", {});
			expect(res.status).toBe(409);
			expect(await errorOf(res)).toBe("no resolved target");
			// Nothing pushed: the bare origin still sits at the seed commit.
			expect(run(s.origin, "git rev-parse main")).toBe(
				run(s.dir, "git rev-parse HEAD~1"),
			);
		} finally {
			s.cleanup();
		}
	});
});

describe("pushSyncCommits setting and ProjectView fields", () => {
	test("the settings route accepts the boolean and the view carries mainBranch/mainUnpushed", async () => {
		const res = await post("/api/projects/p1/settings", {
			pushSyncCommits: true,
		});
		expect(res.status).toBe(200);
		const b = (await res.json()) as {
			settings: { pushSyncCommits: boolean };
			mainBranch: string | null;
			mainUnpushed: boolean;
		};
		expect(b.settings.pushSyncCommits).toBe(true);
		expect(b.mainBranch).toBeNull();
		expect(b.mainUnpushed).toBe(false);
	});

	test("a non-boolean pushSyncCommits is 400", async () => {
		const res = await post("/api/projects/p1/settings", {
			pushSyncCommits: "yes",
		});
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("pushSyncCommits must be a boolean");
	});
});

describe("project icon", () => {
	// 1x1 transparent PNG, base64.
	const png = new Uint8Array(
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
			"base64",
		),
	);
	// sniffImage reads only the RIFF/WEBP magic, so 12 bytes are a valid test webp.
	const webp = new Uint8Array([
		0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
	]);
	const rawPost = (path: string, body: Uint8Array<ArrayBuffer>) =>
		fetch(new URL(path, server.url), {
			method: "POST",
			headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
			body: body,
		});

	test("GET returns 404 when no icon exists", async () => {
		const res = await get("/api/projects/p1/icon");
		expect(res.status).toBe(404);
		expect(await errorOf(res)).toBe("no icon");
	});

	test("POST stores a png and GET serves the same bytes", async () => {
		const up = await rawPost("/api/projects/p1/icon", png);
		expect(up.status).toBe(200);
		const view = (await up.json()) as { icon: number | null };
		expect(typeof view.icon).toBe("number");
		const res = await get("/api/projects/p1/icon");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
	});

	test("POST rejects non-image bytes", async () => {
		const res = await rawPost(
			"/api/projects/p1/icon",
			new TextEncoder().encode("nope"),
		);
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe(
			"icon must be a PNG, JPEG, GIF or WebP file",
		);
	});

	test("POST over the 10 MiB cap is 413 and stores nothing", async () => {
		const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
		big[0] = 0x89;
		const res = await rawPost("/api/projects/p1/icon", big);
		expect(res.status).toBe(413);
		expect(await errorOf(res)).toBe("body too large");
		// The rejected upload must not have replaced the icon the earlier test stored.
		const kept = await get("/api/projects/p1/icon");
		expect(new Uint8Array(await kept.arrayBuffer())).toEqual(png);
	});

	test("POST a webp replaces the png; one file remains", async () => {
		const up = await rawPost("/api/projects/p1/icon", webp);
		expect(up.status).toBe(200);
		const dir = store.tasksDir;
		expect(existsSync(join(dir, "icon.png"))).toBe(false);
		expect(existsSync(join(dir, "icon.webp"))).toBe(true);
		const res = await get("/api/projects/p1/icon");
		expect(res.headers.get("Content-Type")).toBe("image/webp");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(webp);
	});

	test("DELETE clears the icon", async () => {
		const del = await fetch(new URL("/api/projects/p1/icon", server.url), {
			method: "DELETE",
			headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
		});
		expect(del.status).toBe(200);
		const view = (await del.json()) as { icon: number | null };
		expect(view.icon).toBeNull();
		const gone = await get("/api/projects/p1/icon");
		expect(gone.status).toBe(404);
		for (const ext of ["png", "jpg", "gif", "webp"])
			expect(existsSync(join(store.tasksDir, `icon.${ext}`))).toBe(false);
	});

	test.skipIf(process.platform !== "linux")(
		"POST does not write through a symlinked icon file",
		async () => {
			const outDir = mkdtempSync(join(tmpdir(), "app-icon-out-"));
			try {
				const outside = join(outDir, "target");
				writeFileSync(outside, "keep me");
				symlinkSync(outside, join(store.tasksDir, "icon.png"));
				await rawPost("/api/projects/p1/icon", png);
				expect(readFileSync(outside, "utf8")).toBe("keep me");
			} finally {
				rmSync(outDir, { recursive: true, force: true });
				rmSync(join(store.tasksDir, "icon.png"), { force: true });
			}
		},
	);

	test("unknown project", async () => {
		const res = await get("/api/projects/nope/icon");
		expect(res.status).toBe(404);
		expect(await errorOf(res)).toBe("unknown project");
	});
});

describe("add-project folder-name collisions (R1-5)", () => {
	test("a taken basename is 409 before clone or init runs", async () => {
		const first = await post("/api/projects", { name: "dup" });
		expect(first.status).toBe(200);
		expect(projects.get("dup")!.path).toBe(join(root, "dup"));
		// A fresh repo has no remote, so the icon-adoption field ships null.
		expect(((await first.json()) as AddProjectResponse).project.remote).toBe(
			null,
		);

		// Same name again: the on-disk destination 400s before anything else.
		const again = await post("/api/projects", { name: "dup" });
		expect(again.status).toBe(400);
		expect(await errorOf(again)).toBe("path already exists");

		// Board entry whose folder is gone: the name branch must refuse before git init
		// creates a repo with no board entry.
		rmSync(join(root, "dup"), { recursive: true, force: true });
		const nameTaken = await post("/api/projects", { name: "dup" });
		expect(nameTaken.status).toBe(409);
		expect(await errorOf(nameTaken)).toBe(
			"another project already has that folder name",
		);
		expect(existsSync(join(root, "dup"))).toBe(false);

		// The url branch must refuse before the clone runs.
		makeFixture("dup");
		const urlTaken = await post("/api/projects", {
			url: "https://github.com/octo/dup.git",
		});
		expect(urlTaken.status).toBe(409);
		expect(existsSync(join(root, "dup"))).toBe(false);
	});
});

describe("GET /api/provider-login", () => {
	// Pin the board's store to a scratch dir: the machine's own omp store must not decide the result.
	let agent: string;
	let savedAgent: string | undefined;
	beforeEach(() => {
		agent = mkdtempSync(join(tmpdir(), "ottr-login-agent"));
		savedAgent = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
	});
	afterEach(() => {
		if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgent;
		rmSync(agent, { recursive: true, force: true });
	});

	test("a missing store reads as unreadable, not a 500", async () => {
		const res = await mount({}).call("/api/provider-login");
		expect(res.status).toBe(200);
		const b = (await res.json()) as { signIns: unknown; error: unknown };
		expect(b.signIns).toBeNull();
		expect(b.error).toBe(
			`cannot read omp's sign-ins: ${join(agent, "agent.db")} does not exist`,
		);
	});

	test("carries the provider list omp's /login offers, next to the stored sign-ins", async () => {
		const db = new Database(join(agent, "agent.db"));
		db.exec(`CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY,
			provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL,
			disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)`);
		db.close();
		const m = mount({});
		const res = await m.call("/api/provider-login");
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		expect(typeof b === "object" && b !== null && "providers" in b).toBe(true);
		if (typeof b !== "object" || b === null || !("providers" in b)) return;
		expect("signIns" in b && b.signIns).toEqual([]);
		expect("error" in b && b.error).toBeNull();
		expect("pending" in b).toBe(true);
		const providers = b.providers;
		// The machine's omp install decides the ids; the route only pins the shape.
		expect(Array.isArray(providers)).toBe(true);
		if (!Array.isArray(providers)) return;
		for (const p of providers) {
			expect(
				typeof p === "object" &&
					p !== null &&
					"id" in p &&
					typeof p.id === "string",
			).toBe(true);
			expect(
				typeof p === "object" &&
					p !== null &&
					"name" in p &&
					typeof p.name === "string",
			).toBe(true);
		}
	});
});

describe("GET /api/gh-status", () => {
	test("reports the authed user, the projects dir, and a free name", async () => {
		const gh: GhFn = async (args) =>
			args[0] === "api"
				? { code: 0, stdout: "octocat\n", stderr: "" }
				: {
						code: 1,
						stdout: "",
						stderr:
							"GraphQL: Could not resolve to a Repository with the name 'octocat/my-project'.",
					};
		const m = mount({ gh });
		const res = await m.call("/api/gh-status?name=my-project");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			authed: true,
			user: "octocat",
			free: true,
			dir: resolve(root),
			host: "github.com",
		});
	});

	test("an existing repo is taken", async () => {
		const gh: GhFn = async (args) =>
			args[0] === "api"
				? { code: 0, stdout: "octocat", stderr: "" }
				: { code: 0, stdout: "", stderr: "" };
		const m = mount({ gh });
		const s = (await (await m.call("/api/gh-status?name=x")).json()) as {
			free: boolean;
		};
		expect(s.free).toBe(false);
	});

	test("a gh failure that is not not-found leaves the name unknown", async () => {
		const gh: GhFn = async (args) =>
			args[0] === "api"
				? { code: 0, stdout: "octocat", stderr: "" }
				: {
						code: 1,
						stdout: "",
						stderr: "dial tcp: lookup api.github.com: no such host",
					};
		const m = mount({ gh });
		const s = (await (await m.call("/api/gh-status?name=x")).json()) as {
			free: boolean | null;
		};
		expect(s.free).toBeNull();
	});

	test("a name outside the repo charset is never sent to gh", async () => {
		const seen: string[][] = [];
		const gh: GhFn = async (args) => {
			seen.push(args);
			return { code: 0, stdout: "octocat", stderr: "" };
		};
		const m = mount({ gh });
		const s = (await (
			await m.call("/api/gh-status?name=my%20project")
		).json()) as { free: boolean | null };
		expect(s.free).toBeNull();
		expect(seen.some((a) => a[0] === "repo")).toBe(false);
	});

	test("no gh at all reports unauthenticated; the shape stays complete", async () => {
		const gh: GhFn = async () => {
			throw new Error(
				"GitHub CLI (gh) not found: install it and run gh auth login",
			);
		};
		const m = mount({ gh });
		const res = await m.call("/api/gh-status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			authed: false,
			user: null,
			free: null,
			dir: resolve(root),
			host: "github.com",
		});
	});
});

describe("arch-review duplicate guard (R1-8)", () => {
	test("two overlapping posts create exactly one card", async () => {
		const dir = join(root, "arch-proj");
		// initNewProject creates the repo with a commit; the fallback identity covers
		// the commit even without a global git identity.
		const add = await post("/api/projects", { name: "arch-proj" });
		expect(add.status).toBe(200);
		const e = projects.get("arch-proj")!;
		e.target = "main";
		// Old code awaited the git spawn between the guard and createTask: both requests
		// passed the check while the other was still inside archReviewDelta.
		const [x, y] = await Promise.all([
			post("/api/projects/arch-proj/arch-review", {}),
			post("/api/projects/arch-proj/arch-review", {}),
		]);
		expect([x.status, y.status].sort()).toEqual([200, 409]);
		const live = e.store
			.listTasks()
			.filter(
				(t) =>
					t.prompt.startsWith(ARCH_REVIEW_MARKER) &&
					t.cancelledAt === null &&
					t.stage !== "done",
			);
		expect(live).toHaveLength(1);
		// The review freezes the target head, like a release card, and reviews it read-only.
		const head = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
		expect(live[0]?.base).toBe(head);
		projects.delete("arch-proj");
		e.store.close();
	});

	test("arch-review freezes the configured target branch, not the checkout", async () => {
		const dir = join(root, "target-branch-proj");
		const add = await post("/api/projects", { name: "target-branch-proj" });
		expect(add.status).toBe(200);
		const e = projects.get("target-branch-proj")!;
		// A second branch on origin, different from the checked-out head: only the
		// configured target resolves to it.
		const tree = execSync("git rev-parse HEAD^{tree}", { cwd: dir })
			.toString()
			.trim();
		const other = execSync(
			"git -c user.name=ott -c user.email=ott@example.invalid commit-tree " +
				`${tree} -m feature`,
			{ cwd: dir },
		)
			.toString()
			.trim();
		execSync(`git update-ref refs/remotes/origin/feature ${other}`, {
			cwd: dir,
		});
		e.store.setSettings({ targetBranch: "feature" });
		e.target = "origin/feature";
		const res = await post("/api/projects/target-branch-proj/arch-review", {});
		expect(res.status).toBe(200);
		const live = e.store
			.listTasks()
			.filter(
				(t) =>
					t.prompt.startsWith(ARCH_REVIEW_MARKER) &&
					t.cancelledAt === null &&
					t.stage !== "done",
			);
		expect(live).toHaveLength(1);
		expect(live[0]?.prompt).toContain("origin/feature");
		expect(live[0]?.base).toBe(other);
		projects.delete("target-branch-proj");
		e.store.close();
	});
});

describe("triage route", () => {
	test("rejects an empty patch and a bad priority", async () => {
		const task = store.createTask("triage me");
		const empty = await post(`/api/projects/p1/tasks/${task.id}/triage`, {});
		expect(empty.status).toBe(400);
		const bad = await post(`/api/projects/p1/tasks/${task.id}/triage`, {
			priority: "P9",
		});
		expect(bad.status).toBe(400);
		const badReason = await post(`/api/projects/p1/tasks/${task.id}/triage`, {
			closeCandidate: "   ",
		});
		expect(badReason.status).toBe(400);
	});

	test("sets priority and closeCandidate and round-trips them", async () => {
		const task = store.createTask("triage me too");
		const res = await post(`/api/projects/p1/tasks/${task.id}/triage`, {
			priority: "P1",
			closeCandidate: "dup of OTTR-7",
		});
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		const view =
			typeof b === "object" && b !== null
				? (b as { priority?: string | null; closeCandidate?: string | null })
				: null;
		expect(view?.priority).toBe("P1");
		expect(view?.closeCandidate).toBe("dup of OTTR-7");
		// Clearing one field leaves the other alone.
		const clear = await post(`/api/projects/p1/tasks/${task.id}/triage`, {
			priority: null,
		});
		expect(clear.status).toBe(200);
		const cb: unknown = await clear.json();
		const cview =
			typeof cb === "object" && cb !== null
				? (cb as { priority?: string | null; closeCandidate?: string | null })
				: null;
		expect(cview?.priority).toBeNull();
		expect(cview?.closeCandidate).toBe("dup of OTTR-7");
	});
});

describe("how-it-works route", () => {
	test("serves docs/how-it-works.md as committed on the target, 404 without it", async () => {
		expect((await post("/api/projects", { name: "hiw-proj" })).status).toBe(
			200,
		);
		const e = projects.get("hiw-proj")!;
		e.target = "main";
		const url = "/api/projects/hiw-proj/how-it-works";
		expect((await get(url)).status).toBe(404);
		mkdirSync(join(e.path, "docs"));
		writeFileSync(join(e.path, "docs/how-it-works.md"), "committed");
		execSync(
			"git add docs && git -c user.name=t -c user.email=t@t commit -qm d",
			{ cwd: e.path },
		);
		// An uncommitted edit stays out: the board shows the target's version.
		writeFileSync(join(e.path, "docs/how-it-works.md"), "draft");
		const res = await get(url);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("committed");
		expect((await get("/api/projects/nope/how-it-works")).status).toBe(404);
		projects.delete("hiw-proj");
		e.store.close();
	});
});

describe("boot host wall (R2-11)", () => {
	test("/api/boot answers through api()'s Host allowlist", async () => {
		const evil = await fetch(new URL("/api/boot", server.url), {
			headers: { Host: "evil.test:0" },
		});
		expect(evil.status).toBe(403);
		const good = await fetch(new URL("/api/boot", server.url), {
			headers: { Host: "127.0.0.1:0" },
		});
		expect(good.status).toBe(200);
		const b = (await good.json()) as {
			onboarding?: boolean;
			version?: string;
		};
		expect(b.onboarding).toBe(true);
		expect(b.version).toBe("test");
	});
});

describe("origin wall in api() (R1-2)", () => {
	const g = GlobalStore.open(join(root, "g-origin"));
	g.set("config", {
		admin: { name: "ada", passHash: hashPassword("correct horse") },
		sessionSecret: "origin-secret",
		apiKey: "origin-key",
	});
	const m = mount({ gstore: g });
	afterAll(() => g.close());
	const postRaw = (path: string, headers: Record<string, string>) =>
		fetch(new URL(path, m.server.url), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Host: "127.0.0.1:0",
				...headers,
			},
			body: "{}",
		});

	test("bodyless POST routes refuse foreign and missing origins", async () => {
		// Old code checked Origin only in readJson, so /api/settings/api-key (no body) took
		// a cross-site no-cors POST and rotated the key.
		const evil = await postRaw("/api/settings/api-key", {
			Origin: "http://evil.example",
		});
		expect(evil.status).toBe(403);
		expect(await errorOf(evil)).toBe("forbidden origin");
		const noOrigin = await postRaw("/api/settings/api-key", {});
		expect(noOrigin.status).toBe(403);
		// The key never rotated.
		expect(await (await m.call("/api/settings/api-key")).json()).toEqual({
			apiKey: "origin-key",
		});
		// GETs never needed an Origin.
		expect((await m.call("/api/settings/api-key")).status).toBe(200);
	});
});

describe("setup race (R2-4)", () => {
	const savedGH = process.env.GH_TOKEN;
	afterAll(() => {
		if (savedGH === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = savedGH;
	});
	test("a setup that held its body loses to a completed setup", async () => {
		const g = GlobalStore.open(join(root, "g-setup-race"));
		const m = mount({ gstore: g });
		const gate = Promise.withResolvers<void>();
		const eve = JSON.stringify({
			name: "eve",
			password: "correct horse",
			githubToken: `ghp_${"e".repeat(36)}`,
		});
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				await gate.promise;
				controller.enqueue(new TextEncoder().encode(eve));
				controller.close();
			},
		});
		// Headers arrive at once; the handler parks inside readJson(req).
		const slow = fetch(new URL("/api/setup", m.server.url), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
			},
			body,
			duplex: "half",
		} as RequestInit).then(async (r) => ({
			status: r.status,
			error: await errorOf(r),
		}));
		// Real timers required: the handler parks inside the live server's readJson, and the
		// sleep only lets the headers arrive before the gate opens — the server exposes no
		// "handler parked" signal and fake timers do not reach its event loop.
		await Bun.sleep(100);
		const ada = await m.call("/api/setup", {
			name: "ada",
			password: "correct horse",
			githubToken: `ghp_${"a".repeat(36)}`,
		});
		expect(ada.status).toBe(200);
		gate.resolve();
		// Old code checked `admin !== null` before the body arrived and never again: eve
		// replaced ada one byte at a time.
		const lost = await slow;
		expect(lost.status).toBe(400);
		expect(lost.error).toBe("admin already exists");
		const login = await m.call("/api/login", {
			name: "ada",
			password: "correct horse",
		});
		expect(login.status).toBe(200);
		g.close();
	});
});

describe("login limiter (R2-5)", () => {
	test("X-Forwarded-For from a non-loopback peer mints no fresh buckets", async () => {
		const m = mount({ admin: { name: "ada", password: "correct horse" } });
		const wrongOnce = async (xff: string) =>
			(
				await m.call(
					"/api/login",
					{ name: "ada", password: "wrong" },
					{ "x-forwarded-for": xff },
				)
			).status;
		const peer = spyOn(m.server, "requestIP").mockReturnValue({
			address: "172.18.0.9",
			family: "IPv4",
			port: 2,
		});
		for (let i = 0; i < 10; i++) {
			expect(await wrongOnce(`100.64.0.${i}`)).toBe(401);
		}
		// Old code trusted each fresh XFF: the 11th attempt with correct credentials passed.
		const good = await m.call(
			"/api/login",
			{ name: "ada", password: "correct horse" },
			{ "x-forwarded-for": "100.64.0.200" },
		);
		expect(good.status).toBe(429);
		peer.mockRestore();
	});

	test("bodies held back cannot cash guesses past the gate", async () => {
		const m = mount({ admin: { name: "ada", password: "correct horse" } });
		const peer = spyOn(m.server, "requestIP").mockReturnValue({
			address: "172.18.0.9",
			family: "IPv4",
			port: 2,
		});
		const gate = Promise.withResolvers<void>();
		const attempt = () => {
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					await gate.promise;
					controller.enqueue(
						new TextEncoder().encode(
							JSON.stringify({ name: "ada", password: "nope" }),
						),
					);
					controller.close();
				},
			});
			return fetch(new URL("/api/login", m.server.url), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Host: "127.0.0.1:0",
					Origin: "http://127.0.0.1:0",
				},
				body,
				duplex: "half",
			} as RequestInit).then((r) => r.status);
		};
		const attempts = Array.from({ length: 12 }, attempt);
		// Real timers required: same as the setup race — the handlers park inside the live
		// server's readJson and there is no parked-signal to await.
		await Bun.sleep(100); // every handler parks inside readJson
		gate.resolve();
		const statuses = await Promise.all(attempts);
		// Old code ran `allowed()` before the body: all 12 passed the cap and got 401.
		expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
		expect(statuses.filter((s) => s === 401).length).toBeGreaterThanOrEqual(1);
		peer.mockRestore();
	});
});

describe("web push (R1-1, R2-3)", () => {
	const pushSub = {
		endpoint: "https://push.example/abc",
		keys: { p256dh: "k", auth: "a" },
		addedAt: 1,
	};

	test("push config heals a stored @localhost subject", async () => {
		const g = GlobalStore.open(join(root, "g-vapid"));
		g.set("config", {
			vapid: {
				publicKey: "stored-pub",
				privateKey: "stored-priv",
				subject: "mailto:ottr@localhost",
			},
		});
		const m = mount({ gstore: g });
		const res = await m.call("/api/push/config");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ publicKey: "stored-pub" });
		// ensureVapid stamps the constant https subject, not the stored mailto one:
		// Apple answers 403 BadJwtToken for @localhost.
		expect(vapidApplied).toEqual({
			subject: PUSH_SUBJECT,
			publicKey: "stored-pub",
			privateKey: "stored-priv",
		});
		g.close();
	});

	test("a needs-you transition pushes with zero open sockets", async () => {
		saveSubs(gstore, [pushSub]);
		const t = store.createTask("push me");
		app.publishState(); // baseline: prev = null is silent
		const sends = pushSends.length;
		store.updateTask(t.id, { state: "needs_you", needsReason: "?" });
		// Old code returned before the diff when sockets === 0, so with the board closed —
		// and always, in NODE_ENV=production — no push ever fired.
		expect(app.publishState()).toBe(true);
		expect(pushSends.length).toBe(sends + 1);
		expect(pushSends[pushSends.length - 1]!.endpoint).toBe(pushSub.endpoint);
	});

	test("a retro card never pushes; a brand-new needs_you card (a proposal) pushes once", async () => {
		saveSubs(gstore, [pushSub]);
		const retro = store.createTask(
			`${RETRO_MARKER}retro of quiet card`,
			null,
			"retro",
		);
		app.publishState(); // baseline
		const sends = pushSends.length;
		store.updateTask(retro.id, { state: "needs_you", needsReason: "?" });
		expect(app.publishState()).toBe(true);
		// Retro housekeeping is silent even on a real needs_you transition.
		expect(pushSends.length).toBe(sends);
		// A card absent from the previous frame alerts only in needs_you: retro proposals.
		const proposal = store.createTask("a held proposal");
		store.updateTask(proposal.id, {
			state: "needs_you",
			needsReason: "Proposed",
		});
		app.publishState();
		expect(pushSends.length).toBe(sends + 1);
	});

	test("/api/push/test answers 502 when a send fails", async () => {
		saveSubs(gstore, [pushSub]);
		pushFail = { statusCode: 403 };
		const res = await post("/api/push/test", {});
		expect(res.status).toBe(502);
		// Old code counted the failures as sent: `{ ok: true, sent: 1 }`.
		expect(await res.json()).toEqual({
			ok: false,
			sent: 0,
			failed: 1,
			status: 403,
		});
		pushFail = null;
	});
});

describe("retro cards on the board", () => {
	test("a done retro card never reports answered; a normal answered card does", async () => {
		const finish = (taskId: string) => {
			const turn = store.startTurn(taskId, "work", ".", null);
			store.finishTurn(turn.id, {
				outcome: "answered",
				endedAt: Date.now(),
				exitCode: 0,
			});
			store.updateTask(taskId, { stage: "done", state: "idle" });
		};
		const retro = store.createTask(`${RETRO_MARKER}the task`, null, "retro");
		finish(retro.id);
		const plain = store.createTask("a plain done task");
		finish(plain.id);
		const body = (await (await get("/api/state")).json()) as {
			tasks: Array<{ id: string; answered?: boolean }>;
		};
		const byId = new Map(body.tasks.map((t) => [t.id, t]));
		// Retro housekeeping must not fill the Unread block of the Done lane.
		expect(byId.get(retro.id)?.answered).toBe(false);
		expect(byId.get(plain.id)?.answered).toBe(true);
	});
});

describe("silent live turns", () => {
	test("a live card whose log stays silent past the limit warns until the log grows", async () => {
		const now = Date.now();
		/** Card log last written at `at`; whole seconds so the stored mtime reads back exactly. */
		const logAt = (id: string, ago: number): number => {
			const at = Math.floor((now - ago) / 1000) * 1000;
			const file = store.logPath(id);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "== work turn\n", { flag: "a" });
			utimesSync(file, new Date(at), new Date(at));
			return at;
		};
		const card = (state: Task["state"], ago: number) => {
			const t = store.createTask(`a ${state} card`);
			store.updateTask(t.id, { stage: "in_progress", state });
			return { id: t.id, at: logAt(t.id, ago) };
		};
		const silentOf = async (): Promise<Map<string, number | undefined>> => {
			const body = (await (await get("/api/state")).json()) as {
				tasks: Array<{ id: string; silentSince?: number }>;
			};
			return new Map(body.tasks.map((t) => [t.id, t.silentSince]));
		};
		setSystemTime(new Date(now));
		try {
			const hung = card("running", SILENT_LOG_MS + 60_000);
			const prep = card("preparing", SILENT_LOG_MS + 60_000);
			const fresh = card("running", SILENT_LOG_MS - 60_000);
			const parked = card("needs_you", SILENT_LOG_MS + 60_000);
			const first = await silentOf();
			expect(first.get(hung.id)).toBe(hung.at);
			expect(first.get(prep.id)).toBe(prep.at);
			expect(first.get(fresh.id)).toBeUndefined();
			// Only a live turn can hang; a parked card's quiet log is normal.
			expect(first.get(parked.id)).toBeUndefined();
			// New output (a real write stamps the file now) clears the warning.
			appendFileSync(store.logPath(hung.id), "tool output\n");
			const after = await silentOf();
			expect(after.get(hung.id)).toBeUndefined();
			expect(after.get(prep.id)).toBe(prep.at);
		} finally {
			setSystemTime();
		}
	});

	/** A running card whose real run sink wrote past the 2 MiB cap, its log then aged past the limit. */
	const cappedCard = () => {
		const t = store.createTask("a capped running card");
		store.updateTask(t.id, { stage: "in_progress", state: "running" });
		const logPath = store.logPath(t.id);
		const sink = createRunSink({ logPath, dataRoot: store.dataRoot });
		sink.logMark("x".repeat(2 * 1024 * 1024 + 1));
		sink.flush();
		expect(readFileSync(logPath, "utf8")).toContain("[log truncated at 2 MiB");
		const at = Math.floor((Date.now() - SILENT_LOG_MS - 60_000) / 1000) * 1000;
		utimesSync(logPath, new Date(at), new Date(at));
		return { id: t.id, at, sink };
	};
	const silentSinceOf = async (id: string): Promise<number | undefined> => {
		const body = (await (await get("/api/state")).json()) as {
			tasks: Array<{ id: string; silentSince?: number }>;
		};
		return body.tasks.find((t) => t.id === id)?.silentSince;
	};

	test("a capped log that stays silent past the limit still warns", async () => {
		const c = cappedCard();
		expect(await silentSinceOf(c.id)).toBe(c.at);
	});

	test("output after the cap clears the warning, though the log keeps no new bytes", async () => {
		const c = cappedCard();
		expect(await silentSinceOf(c.id)).toBe(c.at);
		const size = statSync(store.logPath(c.id)).size;
		c.sink.logMark("tool output\n");
		c.sink.flush();
		expect(statSync(store.logPath(c.id)).size).toBe(size);
		expect(await silentSinceOf(c.id)).toBeUndefined();
	});

	test("a moving meter suppresses the warning; a frozen meter past the limit warns (OTTR-448)", async () => {
		const now = Date.now();
		const t = store.createTask("a metered running card");
		store.updateTask(t.id, { stage: "in_progress", state: "running" });
		const logPath = store.logPath(t.id);
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, "== work turn\n", { flag: "a" });
		const wholeSecondsAgo = (ago: number): number =>
			Math.floor((now - ago) / 1000) * 1000;
		const logAt = wholeSecondsAgo(SILENT_LOG_MS + 120_000);
		utimesSync(logPath, new Date(logAt), new Date(logAt));
		const rowOf = async (): Promise<
			{ id: string; silentSince?: number; progress?: string } | undefined
		> => {
			const body = (await (await get("/api/state")).json()) as {
				tasks: Array<{
					id: string;
					silentSince?: number;
					progress?: string;
				}>;
			};
			return body.tasks.find((x) => x.id === t.id);
		};
		// The meter moved a minute ago: activity like a log write, no warning though the
		// log has been silent for 3 h.
		fakeProgress = {
			text: "Stryker 40% · 2600/6523",
			at: wholeSecondsAgo(60_000),
		};
		let row = await rowOf();
		expect(row?.silentSince).toBeUndefined();
		expect(row?.progress).toBe("Stryker 40% · 2600/6523");
		// A meter whose numbers froze past the limit: the warning dates from its last move,
		// not from the older log (ALAT-23).
		const movedAt = wholeSecondsAgo(SILENT_LOG_MS + 60_000);
		fakeProgress = { text: "Stryker 12% · 780/6523", at: movedAt };
		row = await rowOf();
		expect(row?.silentSince).toBe(movedAt);
		// No progress at all: today's log-only rule.
		fakeProgress = null;
		row = await rowOf();
		expect(row?.silentSince).toBe(logAt);
	});
});

describe("read marks (/api/seen)", () => {
	/** A done question-only card: one work turn answered, then Done. */
	const answer = (taskId: string) => {
		const turn = store.startTurn(taskId, "work", ".", null);
		store.finishTurn(turn.id, {
			outcome: "answered",
			endedAt: Date.now(),
			exitCode: 0,
		});
		store.updateTask(taskId, { stage: "done", state: "idle" });
	};
	const seenIn = async (): Promise<string[]> => {
		const body = (await (await get("/api/state")).json()) as {
			seenAnswers: string[];
		};
		return body.seenAnswers;
	};

	test("marks stick for answered cards and drop everything else", async () => {
		const read = store.createTask("a done question card");
		answer(read.id);
		const unanswered = store.createTask("a done card without an answer");
		store.updateTask(unanswered.id, { stage: "done", state: "idle" });
		const todo = store.createTask("still queued");
		const retro = store.createTask(
			`${RETRO_MARKER}a retro of it`,
			null,
			"retro",
		);
		answer(retro.id);
		const res = await post("/api/seen", {
			ids: [read.id, unanswered.id, todo.id, retro.id],
		});
		expect(res.status).toBe(200);
		const seen = await seenIn();
		expect(seen).toContain(read.id);
		expect(seen).not.toContain(unanswered.id);
		expect(seen).not.toContain(todo.id);
		expect(seen).not.toContain(retro.id);
	});

	test("a mark whose card left the answered state decays on the next write", async () => {
		const first = store.createTask("a question card that gets superseded");
		answer(first.id);
		await post("/api/seen", { ids: [first.id] });
		expect(await seenIn()).toContain(first.id);
		// A later work turn that is not an answer takes the card out of "answered";
		// the read mark must not survive it.
		const turn = store.startTurn(first.id, "work", ".", null);
		store.finishTurn(turn.id, {
			outcome: "ready",
			endedAt: Date.now(),
			exitCode: 0,
		});
		const second = store.createTask("the next question card");
		answer(second.id);
		await post("/api/seen", { ids: [second.id] });
		const seen = await seenIn();
		expect(seen).toContain(second.id);
		expect(seen).not.toContain(first.id);
		// The union across posts holds: the first test's mark was never re-posted here.
		const read = store
			.listTasks()
			.find((t) => t.title === "a done question card");
		expect(read && seen.includes(read.id)).toBe(true);
	});

	test("unreading removes a mark; the card can be read again after", async () => {
		const t = store.createTask("a read card that gets unread");
		answer(t.id);
		await post("/api/seen", { ids: [t.id] });
		expect(await seenIn()).toContain(t.id);
		const res = await post("/api/seen", { ids: [t.id], unread: true });
		expect(res.status).toBe(200);
		expect(await seenIn()).not.toContain(t.id);
		// The normal read path still works on the same card afterwards.
		await post("/api/seen", { ids: [t.id] });
		expect(await seenIn()).toContain(t.id);
		// Unreading a card that was never read changes nothing and still answers ok.
		const stranger = store.createTask("a card never marked read");
		const quiet = await post("/api/seen", { ids: [stranger.id], unread: true });
		expect(quiet.status).toBe(200);
		expect(await seenIn()).not.toContain(stranger.id);
	});

	test("a pr_review card keeps its read mark like an answered card", async () => {
		store.savePrReview({
			number: 4700,
			taskId: null,
			head: "cafe123",
			firstSeenAt: 0,
			reviewedHead: null,
			postedHead: null,
			postedUrl: null,
			postedLogin: null,
			state: "open",
			draft: false,
			title: "Fix it",
			postError: null,
		});
		const pr = store.savePrDraft({
			run: store.startPrRun(4700, "cafe123", Date.now()),
			number: 4700,
			head: "cafe123",
			draft: "the draft",
			prompt: "review",
		});
		// The watcher files the card done with the draft as its details.
		expect(pr.kind).toBe("pr_review");
		expect(pr.stage).toBe("done");
		const res = await post("/api/seen", { ids: [pr.id] });
		expect(res.status).toBe(200);
		expect(await seenIn()).toContain(pr.id);
		const unread = await post("/api/seen", { ids: [pr.id], unread: true });
		expect(unread.status).toBe(200);
		expect(await seenIn()).not.toContain(pr.id);
	});
});

describe("cancel keeps the worktree (R5-2)", () => {
	test("a cancelled kept card counts as held under the Cancel prefix", async () => {
		const t = store.createTask("cancel me");
		store.updateTask(t.id, {
			state: "needs_you",
			// The loop's cancel writes this prefix on a real tree (pinned in turn.test.ts);
			// old code reused keptReason(), whose "Kept the worktree: " prefix is what the
			// supervisor's auto-tend matches: it replied to a card the user had cancelled.
			needsReason: cancelKeptReason("uncommitted changes to scratch.txt"),
			keptFiles: ["scratch.txt"],
			worktree: join(root, "cancel-wt"),
		});
		expect(
			store.getTask(t.id)!.needsReason!.startsWith("Kept the worktree: "),
		).toBe(false);
		// finish-kept and the board's held count still cover it (isKeptReason).
		const state = await get("/api/state");
		const b = (await state.json()) as {
			keptWorktrees?: { held?: number; stale?: number };
		};
		expect(b.keptWorktrees?.held ?? 0).toBeGreaterThanOrEqual(1);
	});
});

describe("cancel and finish-kept routes", () => {
	const resetImpls = () => {
		cancelImpl = async () => ({ removed: true });
		finishKeptImpl = async () => ({ ok: true });
		stopTurnImpl = async () => ({ ok: true });
	};

	test("cancel kept returns the kept reason and ok false", async () => {
		const t = store.createTask("hold this");
		cancelImpl = async (_e, id, force) => {
			expect(id).toBe(t.id);
			expect(force).toBe(false);
			return { kept: "uncommitted changes to x" };
		};
		try {
			const res = await post(`/api/projects/p1/tasks/${t.id}/cancel`, {});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				ok: false,
				kept: "uncommitted changes to x",
			});
		} finally {
			resetImpls();
		}
	});

	test("cancel with default impl removes and returns ok true", async () => {
		const t = store.createTask("drop this");
		try {
			const res = await post(`/api/projects/p1/tasks/${t.id}/cancel`, {});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			resetImpls();
		}
	});

	test("cancel passes force through", async () => {
		const t = store.createTask("force this");
		cancelImpl = async (_e, _id, force) => {
			expect(force).toBe(true);
			return { removed: true };
		};
		try {
			const res = await post(`/api/projects/p1/tasks/${t.id}/cancel`, {
				force: true,
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			resetImpls();
		}
	});

	test("stop passes through to the loop and returns ok", async () => {
		const t = store.createTask("stop this");
		stopTurnImpl = async (_e, id) => {
			expect(id).toBe(t.id);
			return { ok: true };
		};
		try {
			const res = await post(`/api/projects/p1/tasks/${t.id}/stop`, {});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			resetImpls();
		}
	});

	test("stop returns the loop's error status", async () => {
		const t = store.createTask("stop nothing");
		stopTurnImpl = async () => ({
			error: "no turn is running",
			status: 409,
		});
		try {
			const res = await post(`/api/projects/p1/tasks/${t.id}/stop`, {});
			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({ error: "no turn is running" });
		} finally {
			resetImpls();
		}
	});

	test("finish-kept ok passes the choices through", async () => {
		const t = store.createTask("kept card");
		finishKeptImpl = async (_e, id, choices) => {
			expect(id).toBe(t.id);
			expect(choices).toEqual({ "a.txt": "move" });
			return { ok: true };
		};
		try {
			const res = await post(`/api/projects/p1/tasks/${t.id}/finish-kept`, {
				choices: { "a.txt": "move" },
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			resetImpls();
		}
	});

	test("finish-kept errors map the loop's status onto the response", async () => {
		const t = store.createTask("busy card");
		const other = store.createTask("bad card");
		try {
			finishKeptImpl = async () => ({
				error: "a turn is running",
				status: 409,
			});
			const busy = await post(`/api/projects/p1/tasks/${t.id}/finish-kept`, {
				choices: {},
			});
			expect(busy.status).toBe(409);
			expect(await errorOf(busy)).toBe("a turn is running");

			finishKeptImpl = async () => ({ error: "bad choices", status: 400 });
			const bad = await post(`/api/projects/p1/tasks/${other.id}/finish-kept`, {
				choices: {},
			});
			expect(bad.status).toBe(400);
			expect(await errorOf(bad)).toBe("bad choices");
		} finally {
			resetImpls();
		}
	});
});

describe("orphan scan failures", () => {
	let failScan = true;
	const failing = createApp({
		gstore,
		defaultDir: root,
		projects,
		...loopStubs(),
		schedule: () => {},
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared,
		serverRef: { current: undefined },
		listProcesses: () => {
			if (failScan) throw new Error("no ps in container");
			return [
				{
					pid: 4242,
					cmd: "omp -p --mode json --session-dir d1",
					// Past the 10-minute grace window, so the scan reports it.
					started: Date.now() - 660_000,
				},
			];
		},
	});
	// The orphan cache is per app instance, so no module reset is needed across tests.
	const failingServer = Bun.serve({ port: 0, ...failing.serveOptions });
	failing.serverRef.current = failingServer;
	mounted.push(failingServer);
	// Same guard headers as the top-level get(): api() matches Host and Origin on deps.port (0).
	const getFailing = async (path: string) =>
		fetch(new URL(path, failingServer.url), {
			headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
		});

	test("a throwing scan surfaces the error", async () => {
		const state = await (await getFailing("/api/state")).json();
		expect(state.orphansError).toBe("no ps in container");
		expect(state.orphans).toEqual([]);
		const orphans = await (await getFailing("/api/orphans")).json();
		expect(orphans.orphansError).toBe("no ps in container");
	});

	test("a later good scan clears it", async () => {
		failScan = false;
		const state = await (await getFailing("/api/state")).json();
		expect(state.orphansError).toBeNull();
		// OTTR-463: the advisory carries the resolved facts, not just pid and start time.
		expect(state.orphans).toEqual([
			{
				pid: 4242,
				started: expect.any(Number),
				cmd: "omp -p --mode json --session-dir d1",
				project: null,
				card: null,
				kind: null,
			},
		]);
	});
});

describe("orphan facts and stop (OTTR-463)", () => {
	const g = GlobalStore.open(join(root, "g-orphans"));
	const dir = join(root, "orph");
	const ostore = ProjectStore.open(dir);
	const projs = new Map<string, Entry>();
	projs.set("orph", {
		path: dir,
		name: "orph",
		store: ostore,
		target: null,
		gitless: false,
		github: null,
		remote: null,
		dirty: false,
		mainUnpushed: false,
		mainBranch: null,
		latestRelease: null,
		latestImage: null,
		archReview: null,
	});
	// ps reports the full argv; the state carries summarizeCmd of it. The stop route
	// compares shapes, so these tests post the summarized form, like the UI does.
	const psCmd =
		"OMP_PID=9 bun omp -p --mode json --session-dir " + ostore.sessionsDir;
	const cmd = summarizeCmd(psCmd);
	const pid = 4321;
	let listed: { pid: number; cmd: string; started: number }[] = [];
	let claimed: number[] = [];
	const killed: number[] = [];
	const appO = createApp({
		gstore: g,
		defaultDir: root,
		projects: projs,
		...loopStubs(),
		claimedPids: () => new Set(claimed),
		schedule: () => {},
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared,
		serverRef: { current: undefined },
		listProcesses: () => listed,
		killTree: (p) => killed.push(p),
	});
	const srvO = Bun.serve({ port: 0, ...appO.serveOptions });
	appO.serverRef.current = srvO;
	mounted.push(srvO);
	const call = (path: string, body?: unknown) =>
		fetch(new URL(path, srvO.url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

	test("state.orphans carries the enriched facts", async () => {
		listed = [{ pid, cmd: psCmd, started: Date.now() - 660_000 }];
		claimed = [];
		const state = await (await call("/api/state")).json();
		expect(state.orphans).toEqual([
			{
				pid,
				started: expect.any(Number),
				cmd: "bun omp -p --mode json --session-dir " + ostore.sessionsDir,
				project: "orph",
				card: null,
				kind: null,
			},
		]);
		const orphans = await (await call("/api/orphans")).json();
		expect(orphans.orphans).toEqual(state.orphans);
	});

	test("stop kills on an exact match", async () => {
		listed = [{ pid, cmd: psCmd, started: Date.now() - 660_000 }];
		claimed = [];
		const res = await call("/api/orphans/stop", {
			pid,
			started: listed[0]!.started,
			cmd,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(killed).toEqual([pid]);
	});

	test("stop kills when the posted summary is all the state kept of a long argv", async () => {
		// A real omp argv often passes 160 chars; the UI only holds the capped summary.
		const long = `${psCmd} --config ${"/opt/tracker/".repeat(8)}retro.yml`;
		expect(summarizeCmd(long).length).toBeGreaterThan(100);
		listed = [{ pid, cmd: long, started: Date.now() - 660_000 }];
		claimed = [];
		const killsBefore = killed.length;
		const res = await call("/api/orphans/stop", {
			pid,
			started: listed[0]!.started,
			cmd: summarizeCmd(long),
		});
		expect(res.status).toBe(200);
		expect(killed.length).toBe(killsBefore + 1);
	});

	test("stop refuses a gone pid", async () => {
		listed = [];
		const killsBefore = killed.length;
		const res = await call("/api/orphans/stop", { pid, started: 0, cmd });
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("process is gone");
		expect(killed.length).toBe(killsBefore);
	});

	test("stop refuses a changed command", async () => {
		listed = [
			{ pid, cmd: "bun omp -p --mode json --config /x/retro.yml", started: 0 },
		];
		const res = await call("/api/orphans/stop", { pid, started: 0, cmd });
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("command differs");
	});

	test("stop refuses a start time drift beyond 30 s", async () => {
		listed = [{ pid, cmd: psCmd, started: 100_000 }];
		const res = await call("/api/orphans/stop", {
			pid,
			started: 100_000 + 31_000,
			cmd,
		});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("start time drifted");
	});

	test("stop refuses a claimed pid", async () => {
		listed = [{ pid, cmd: psCmd, started: 0 }];
		claimed = [pid];
		const res = await call("/api/orphans/stop", { pid, started: 0, cmd });
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("a live turn claims this pid");
	});

	test("stop refuses the tracker's own pid", async () => {
		listed = [{ pid: process.pid, cmd: psCmd, started: 0 }];
		const res = await call("/api/orphans/stop", {
			pid: process.pid,
			started: 0,
			cmd,
		});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("refusing to stop the tracker itself");
	});

	test("stop rejects an invalid body", async () => {
		for (const body of [
			{ pid: 0, started: 0, cmd: "x" },
			{ pid: 1.5, started: 0, cmd: "x" },
			{ pid: 7, started: -1, cmd: "x" },
			{ pid: 7, started: 0, cmd: "" },
			{ pid: 7, started: "0", cmd: "x" },
		]) {
			const res = await call("/api/orphans/stop", body);
			expect(res.status).toBe(400);
		}
	});
});

describe("sign out everywhere", () => {
	// A real public host (Host header matches OMP_TRACKER_PUBLIC_HOSTS): every request
	// sits behind the auth wall, like tailscale serve in front of the board.
	const g = GlobalStore.open(join(root, "g-revoke"));
	g.set("config", {
		admin: { name: "ada", passHash: hashPassword("correct horse") },
		apiKey: "revoke-key",
		sessionSecret: "revoke-secret",
	});
	const app = createApp({
		gstore: g,
		projects: new Map(),
		defaultDir: root,
		cancel: async () => ({ removed: true }),
		stopTurn: async () => ({ ok: true }),
		finishKept: async () => ({ ok: true }),
		claimedPids: () => new Set<number>(),
		schedule: () => {},
		serverVersion: "test",
		port: 0,
		publicHosts: ["board.example"],
		shared: {
			maxTotalRuns: 3,
			reviewCheck: true,
			workCheck: true,
			idleReviews: true,
			removedPaths: [],
			envValues: {},
			projectPaths: [],
			projectOrder: [],
		},
		serverRef: { current: undefined },
	});
	const srv = Bun.serve({ port: 0, ...app.serveOptions });
	app.serverRef.current = srv;
	afterAll(() => {
		srv.stop(true);
		g.close();
	});
	const call = (
		path: string,
		headers: Record<string, string> = {},
		body?: unknown,
	) =>
		fetch(new URL(path, srv.url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				Host: "board.example",
				Origin: "https://board.example",
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

	test("logout drops the caller's session; rotating the secret kills every old cookie", async () => {
		const login = await call(
			"/api/login",
			{},
			{ name: "ada", password: "correct horse" },
		);
		expect(login.status).toBe(200);
		// Public host: the session cookie is Secure (HTTPS arrives via tailscale serve).
		const setCookie = login.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("ottr.session=");
		expect(setCookie).toContain("Secure");
		const session = { cookie: setCookie.split(";")[0] ?? "" };
		expect((await call("/api/state", session)).status).toBe(200);
		// Logout clears the cookie and drops the registry entry, so even a copied
		// cookie of the same session is dead afterwards.
		await call("/api/logout", session, {});
		expect((await call("/api/state", session)).status).toBe(401);
		// Sign out everywhere rotates the secret: a re-login's fresh cookie is dead
		// on every host after the rotation.
		const again = await call(
			"/api/login",
			{},
			{ name: "ada", password: "correct horse" },
		);
		expect(again.status).toBe(200);
		const live = {
			cookie: (again.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
		};
		expect((await call("/api/state", live)).status).toBe(200);
		expect((await call("/api/settings/session-secret", live, {})).status).toBe(
			200,
		);
		expect((await call("/api/state", live)).status).toBe(401);
		// Rotation persisted: the stored secret is no longer the one the cookie was signed with.
		const stored: unknown = g.get("config");
		expect(
			stored !== null &&
				typeof stored === "object" &&
				"sessionSecret" in stored &&
				stored.sessionSecret !== "revoke-secret",
		).toBe(true);
		// And the board still takes logins under the new secret.
		const fresh = await call(
			"/api/login",
			{},
			{ name: "ada", password: "correct horse" },
		);
		expect(fresh.status).toBe(200);
		const freshCookie =
			(fresh.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		expect((await call("/api/state", { cookie: freshCookie })).status).toBe(
			200,
		);
	});
});

describe("session registry (OTTR-387)", () => {
	// Boards opened inside tests register here; one describe-level hook cleans up.
	const opened: { srv: Server<undefined>; g: GlobalStore }[] = [];
	afterAll(() => {
		for (const o of opened) {
			o.srv.stop(true);
			o.g.close();
		}
	});
	// A real public host (Host header matches): every request sits behind the auth
	// wall, like tailscale serve in front of the board. Same shape as the revoke test.
	function openBoard(name: string, seed: Record<string, unknown> = {}) {
		const g = GlobalStore.open(join(root, name));
		g.set("config", {
			admin: { name: "ada", passHash: hashPassword("correct horse") },
			apiKey: `${name}-key`,
			sessionSecret: `${name}-secret`,
			...seed,
		});
		const app = createApp({
			gstore: g,
			projects: new Map(),
			defaultDir: root,
			cancel: async () => ({ removed: true }),
			stopTurn: async () => ({ ok: true }),
			finishKept: async () => ({ ok: true }),
			claimedPids: () => new Set<number>(),
			schedule: () => {},
			serverVersion: "test",
			port: 0,
			publicHosts: ["board.example"],
			shared: {
				maxTotalRuns: 3,
				reviewCheck: true,
				workCheck: true,
				idleReviews: true,
				removedPaths: [],
				envValues: {},
				projectPaths: [],
				projectOrder: [],
			},
			serverRef: { current: undefined },
		});
		const srv = Bun.serve({ port: 0, ...app.serveOptions });
		app.serverRef.current = srv;
		opened.push({ srv, g });
		const call = (
			path: string,
			headers: Record<string, string> = {},
			body?: unknown,
		) => {
			// An explicit headers.method (DELETE) wins; it is consumed, not sent as a header.
			const { method, ...rest } = headers;
			return fetch(new URL(path, srv.url), {
				method: method ?? (body === undefined ? "GET" : "POST"),
				headers: {
					"content-type": "application/json",
					Host: "board.example",
					Origin: "https://board.example",
					...rest,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		};
		const login = async (ua: string) => {
			const res = await call(
				"/api/login",
				{ "user-agent": ua },
				{ name: "ada", password: "correct horse" },
			);
			const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
			const parts = cookie.replace("ottr.session=", "").split(".");
			// token = name.id.exp.mac, so the id sits third from the END.
			return { res, cookie, id: parts[parts.length - 3] ?? "" };
		};
		return { g, srv, call, login };
	}

	test("two logins list two rows, newest first, exactly one current", async () => {
		const { call, login } = openBoard("g-sess-list");
		const a = await login("curl/8.4.0");
		expect(a.res.status).toBe(200);
		// The server stamps lastSeen from the real clock inside createApp, and no fake-timer
		// seam crosses the fetch boundary: this real 5ms wait buys a distinct lastSeen.
		await Bun.sleep(5);
		const b = await login(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
		);
		expect(b.res.status).toBe(200);
		const body = (await (
			await call("/api/settings/sessions", { cookie: b.cookie })
		).json()) as {
			sessions: {
				id: string;
				label: string;
				createdAt: number;
				lastSeen: number;
				current: boolean;
			}[];
		};
		expect(body.sessions.length).toBe(2);
		expect(body.sessions[0]?.id).toBe(b.id);
		expect(body.sessions[0]?.current).toBe(true);
		expect(body.sessions[0]?.label).toBe("Firefox on Windows");
		expect(body.sessions[1]?.id).toBe(a.id);
		expect(body.sessions[1]?.current).toBe(false);
		expect(body.sessions[1]?.label).toBe("curl on Unknown OS");
		expect(body.sessions[1]?.lastSeen).toBeLessThan(
			body.sessions[0]?.lastSeen ?? 0,
		);
	});

	test("revoking A ends A, keeps B; unknown id answers 404", async () => {
		const { call, login } = openBoard("g-sess-revoke");
		const a = await login("curl/8.4.0");
		const b = await login("curl/8.4.0");
		const del = await call(`/api/settings/sessions/${a.id}`, {
			method: "DELETE",
			cookie: b.cookie,
		});
		expect(del.status).toBe(200);
		expect(await del.json()).toEqual({ ok: true });
		expect((await call("/api/state", { cookie: a.cookie })).status).toBe(401);
		expect((await call("/api/state", { cookie: b.cookie })).status).toBe(200);
		const gone = await call("/api/settings/sessions/nope", {
			method: "DELETE",
			cookie: b.cookie,
		});
		expect(gone.status).toBe(404);
		expect(await gone.json()).toEqual({ error: "no such session" });
	});

	test("logout removes only the caller's own entry", async () => {
		const { call, login } = openBoard("g-sess-logout");
		const a = await login("curl/8.4.0");
		const b = await login("curl/8.4.0");
		await call("/api/logout", { cookie: a.cookie }, {});
		expect((await call("/api/state", { cookie: a.cookie })).status).toBe(401);
		const body = (await (
			await call("/api/settings/sessions", { cookie: b.cookie })
		).json()) as {
			sessions: { id: string }[];
		};
		expect(body.sessions.map((s) => s.id)).toEqual([b.id]);
	});

	test("a legacy three-part token works until rotation kills it", async () => {
		const { call } = openBoard("g-sess-legacy");
		const legacy = {
			cookie: `ottr.session=${signSession("g-sess-legacy-secret", "ada", 60_000)}`,
		};
		expect((await call("/api/state", legacy)).status).toBe(200);
		// Legacy tokens are not listed and cannot be revoked one by one.
		const body = (await (
			await call("/api/settings/sessions", legacy)
		).json()) as {
			sessions: unknown[];
		};
		expect(body.sessions).toEqual([]);
		expect(
			(await call("/api/settings/session-secret", legacy, {})).status,
		).toBe(200);
		expect((await call("/api/state", legacy)).status).toBe(401);
	});

	test("rotation empties the registry", async () => {
		const { call, login } = openBoard("g-sess-rotate");
		const a = await login("curl/8.4.0");
		expect(
			(await call("/api/settings/session-secret", { cookie: a.cookie }, {}))
				.status,
		).toBe(200);
		// The old cookie dies with the secret, so the check needs a fresh login.
		expect(
			(await call("/api/settings/sessions", { cookie: a.cookie })).status,
		).toBe(401);
		const b = await login("curl/8.4.0");
		const body = (await (
			await call("/api/settings/sessions", { cookie: b.cookie })
		).json()) as {
			sessions: { id: string }[];
		};
		// The old entries died with the rotation; b's own fresh login is the only row.
		expect(body.sessions.map((s) => s.id)).toEqual([b.id]);
	});

	test("the cap holds at 50 and drops the oldest lastSeen", async () => {
		const now = Date.now();
		const stale: {
			id: string;
			label: string;
			createdAt: number;
			lastSeen: number;
			exp: number;
		}[] = [];
		for (let i = 0; i < 50; i++) {
			stale.push({
				id: `stale${i}`,
				label: "seeded",
				createdAt: now,
				lastSeen: now + i,
				exp: now + 3_600_000,
			});
		}
		const { call, login } = openBoard("g-sess-cap", { sessions: stale });
		const fresh = await login("curl/8.4.0");
		expect(fresh.res.status).toBe(200);
		const body = (await (
			await call("/api/settings/sessions", { cookie: fresh.cookie })
		).json()) as {
			sessions: { id: string }[];
		};
		expect(body.sessions.length).toBe(50);
		expect(body.sessions.some((s) => s.id === "stale0")).toBe(false);
		expect(body.sessions.some((s) => s.id === fresh.id)).toBe(true);
	});

	test("guards: 401 without auth, 200 with the key but no current, 403 cross-origin", async () => {
		const { call, login, srv } = openBoard("g-sess-guard");
		const a = await login("curl/8.4.0");
		expect((await call("/api/settings/sessions")).status).toBe(401);
		const keyed = await call("/api/settings/sessions", {
			"x-api-key": "g-sess-guard-key",
		});
		expect(keyed.status).toBe(200);
		const keyBody = (await keyed.json()) as {
			sessions: { id: string; current: boolean }[];
		};
		expect(keyBody.sessions.length).toBe(1);
		expect(keyBody.sessions[0]?.current).toBe(false);
		expect(keyBody.sessions[0]?.id).toBe(a.id);
		const cross = await fetch(
			new URL(`/api/settings/sessions/${a.id}`, srv.url),
			{
				method: "DELETE",
				headers: {
					Host: "board.example",
					Origin: "http://evil.example",
					cookie: a.cookie,
				},
			},
		);
		expect(cross.status).toBe(403);
		expect(await cross.json()).toEqual({ error: "forbidden origin" });
	});
});

describe("drain route", () => {
	test("carries sanitized commit subjects in /api/state while the hold lasts", async () => {
		const res = await post("/api/drain", {
			commits: ["  fix the drain route  ", "", "add commits to the notice"],
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { drainUntil: number };
		const state = (await (await get("/api/state")).json()) as {
			drainUntil: number | null;
			drainCommits: string[] | null;
		};
		expect(state.drainCommits).toEqual([
			"fix the drain route",
			"add commits to the notice",
		]);
		expect(state.drainUntil).toBe(body.drainUntil);
	});

	test("a drain POST without commits resets the list for the held period", async () => {
		await post("/api/drain", { commits: ["one"] });
		await post("/api/drain", {});
		const state = (await (await get("/api/state")).json()) as {
			drainCommits: string[] | null;
		};
		expect(state.drainCommits).toEqual([]);
	});

	test("commits must be an array of strings", async () => {
		const bad = await post("/api/drain", { commits: "nope" });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe("commits must be an array of strings");
		const mixed = await post("/api/drain", { commits: ["ok", 42] });
		expect(mixed.status).toBe(400);
	});

	test("drops non-string-shape entries, control chars, caps length and count", async () => {
		const junk = await post("/api/drain", {
			commits: ["keep me", "bad\u0000line", "x".repeat(250)],
		});
		expect(junk.status).toBe(200);
		const state = (await (await get("/api/state")).json()) as {
			drainCommits: string[] | null;
		};
		expect(state.drainCommits).toEqual(["keep me", "x".repeat(200)]);
		const many = await post("/api/drain", {
			commits: Array.from({ length: 60 }, (_, i) => `c${i}`),
		});
		expect(many.status).toBe(200);
		const after = (await (await get("/api/state")).json()) as {
			drainCommits: string[];
		};
		expect(after.drainCommits).toHaveLength(50);
	});

	test("the response shape is unchanged: { drainUntil }", async () => {
		const res = await post("/api/drain", {});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body)).toEqual(["drainUntil"]);
		expect(typeof body.drainUntil).toBe("number");
	});

	test("DELETE ends the hold at once, so the scheduler starts new turns again", async () => {
		await post("/api/drain", { commits: ["one"] });
		expect(app.drained()).toBe(true);
		const res = await fetch(new URL("/api/drain", server.url), {
			method: "DELETE",
			headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
		});
		expect(res.status).toBe(200);
		expect(app.drained()).toBe(false);
		const state = (await (await get("/api/state")).json()) as {
			drainUntil: number | null;
			drainCommits: string[] | null;
		};
		expect(state.drainUntil).toBeNull();
		expect(state.drainCommits).toBeNull();
	});

	test("a local hold rides the runner branch on the fallback runner list", async () => {
		// The mount passes no runners, so the fallback list holds only "local".
		const res = await post("/api/drain", { runner: "local" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { until: number };
		expect(body.until).toBeGreaterThan(Date.now());
		expect(app.drainedRunner("local")).toBe(true);
		// The board-wide hold stays off.
		expect(app.drained()).toBe(false);
		const clear = await fetch(new URL("/api/drain?runner=local", server.url), {
			method: "DELETE",
			headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
		});
		expect(clear.status).toBe(200);
		expect(app.drainedRunner("local")).toBe(false);
	});
});

describe("per-runner drain routes (OTTR-454)", () => {
	// Own app so the tests can inject a worker list and live counts; same guard
	// headers as the main mount (port 0).
	const runnerApp = createApp({
		gstore,
		projects,
		defaultDir: root,
		cancel: async () => ({ removed: true }),
		stopTurn: async () => ({ ok: true }),
		finishKept: async () => ({ ok: true }),
		claimedPids: () => new Set<number>(),
		schedule: () => {},
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared,
		serverRef: { current: undefined },
		runners: [
			{ id: "worker-a", url: "http://worker-a:8787" },
			{ id: "worker-b", url: "http://worker-b:8787" },
			{ id: "local", url: null },
		],
		runnerTurns: () => ({
			local: 2,
			workers: { "worker-a": 1 },
			preparing: 3,
		}),
	});
	const runnerServer = Bun.serve({ port: 0, ...runnerApp.serveOptions });
	runnerApp.serverRef.current = runnerServer;
	afterAll(() => runnerServer.stop(true));
	const runnerCall = (path: string, body?: unknown, method?: string) =>
		fetch(new URL(path, runnerServer.url), {
			method: method ?? (body === undefined ? "GET" : "POST"),
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

	test("GET lists every runner with its url, hold and live turn counts", async () => {
		const res = await runnerCall("/api/drain");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			drainUntil: number | null;
			drainCommits: string[] | null;
			preparing: number;
			runners: {
				id: string;
				url: string | null;
				until: number | null;
				turns: number;
			}[];
		};
		expect(body.drainUntil).toBeNull();
		expect(body.drainCommits).toBeNull();
		expect(body.preparing).toBe(3);
		expect(body.runners).toEqual([
			{ id: "worker-a", url: "http://worker-a:8787", until: null, turns: 1 },
			{ id: "worker-b", url: "http://worker-b:8787", until: null, turns: 0 },
			{ id: "local", url: null, until: null, turns: 2 },
		]);
	});

	test("POST {runner} holds one runner for DRAIN_MS and leaves the board untouched", async () => {
		const before = Date.now();
		const res = await runnerCall("/api/drain", { runner: "worker-a" });
		expect(res.status).toBe(200);
		const { until } = (await res.json()) as { until: number };
		// One DRAIN_MS window from the request, not the board-wide hold length logic.
		expect(until).toBeGreaterThanOrEqual(before + 30 * 60_000);
		expect(until).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
		// Renewal moves the hold to the new request's window.
		const again = await runnerCall("/api/drain", { runner: "worker-a" });
		const renewed = (await again.json()) as { until: number };
		expect(renewed.until).toBeGreaterThanOrEqual(until);
		const get = await runnerCall("/api/drain");
		const body = (await get.json()) as {
			drainUntil: number | null;
			runners: { id: string; until: number | null }[];
		};
		const a = body.runners.find((r) => r.id === "worker-a")!;
		const b = body.runners.find((r) => r.id === "worker-b")!;
		expect(a.until).not.toBeNull();
		expect(b.until).toBeNull();
		expect(body.drainUntil).toBeNull();
		const state = (await (await runnerCall("/api/state")).json()) as {
			drainUntil: number | null;
			drainCommits: string[] | null;
		};
		expect(state.drainUntil).toBeNull();
		expect(state.drainCommits).toBeNull();
	});

	test("POST rejects an unknown or non-string runner", async () => {
		const unknown = await runnerCall("/api/drain", { runner: "worker-c" });
		expect(unknown.status).toBe(400);
		expect(await errorOf(unknown)).toContain("unknown runner");
		const junk = await runnerCall("/api/drain", { runner: 42 });
		expect(junk.status).toBe(400);
	});

	test("DELETE ?runner clears only that hold; the board-wide clear leaves runner holds", async () => {
		await runnerCall("/api/drain", { runner: "worker-a" });
		await runnerCall("/api/drain", { runner: "worker-b" });
		// Board-wide hold, so the two spaces cannot leak into each other.
		await runnerCall("/api/drain", { commits: ["one"] });
		const clearA = await runnerCall(
			"/api/drain?runner=worker-a",
			undefined,
			"DELETE",
		);
		expect(clearA.status).toBe(200);
		expect((await clearA.json()) as unknown).toEqual({ until: null });
		let body = (await (await runnerCall("/api/drain")).json()) as {
			drainUntil: number | null;
			runners: { id: string; until: number | null }[];
		};
		expect(body.runners.find((r) => r.id === "worker-a")!.until).toBeNull();
		expect(body.runners.find((r) => r.id === "worker-b")!.until).not.toBeNull();
		// The board-wide hold survives a per-runner clear.
		expect(body.drainUntil).not.toBeNull();
		const clearBoard = await runnerCall("/api/drain", undefined, "DELETE");
		expect((await clearBoard.json()) as unknown).toEqual({
			drainUntil: null,
		});
		body = (await (await runnerCall("/api/drain")).json()) as typeof body;
		expect(body.drainUntil).toBeNull();
		expect(body.runners.find((r) => r.id === "worker-b")!.until).not.toBeNull();
	});
});

describe("fork research routes", () => {
	test("fork proposal reason strings mirror the retro ones", async () => {
		expect(FORK_PROPOSED_REASON_PREFIX).toBe("Fork proposal from ");
		expect(forkProposedReason({ id: "t9" })).toBe(
			"Fork proposal from t9. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		);
	});

	test("project settings route accepts forkResearch and rejects non-boolean", async () => {
		const ok = await post("/api/projects/p1/settings", {
			forkResearch: true,
		});
		expect(ok.status).toBe(200);
		expect(store.getSettings().forkResearch).toBe(true);
		const bad = await post("/api/projects/p1/settings", { forkResearch: 1 });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe("forkResearch must be a boolean");
		await post("/api/projects/p1/settings", { forkResearch: false });
		expect(store.getSettings().forkResearch).toBe(false);
	});

	test("project settings route accepts setupChecklist and rejects non-boolean", async () => {
		const ok = await post("/api/projects/p1/settings", {
			setupChecklist: true,
		});
		expect(ok.status).toBe(200);
		expect(store.getSettings().setupChecklist).toBe(true);
		const bad = await post("/api/projects/p1/settings", {
			setupChecklist: "yes",
		});
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe("setupChecklist must be a boolean");
		await post("/api/projects/p1/settings", { setupChecklist: false });
		expect(store.getSettings().setupChecklist).toBe(false);
	});

	test("github route refuses a project without a GitHub remote", async () => {
		const res = await get("/api/projects/p1/github");
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("project has no GitHub remote");
		const unknown = await get("/api/projects/nope/github");
		expect(unknown.status).toBe(404);
	});

	test("forks/check refuses a project without a GitHub remote", async () => {
		const res = await post("/api/projects/p1/forks/check", {});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("project has no GitHub remote");
		const unknown = await post("/api/projects/nope/forks/check", {});
		expect(unknown.status).toBe(404);
	});

	test("a reply on a fork-held card approves the merge", async () => {
		const t = store.createTask("fork adopt");
		store.updateTask(t.id, {
			state: "needs_you",
			needsReason: FORK_HOLD_REASON,
			holdHead: "sha-parked",
		});
		const res = await post(`/api/projects/p1/tasks/${t.id}/reply`, {
			text: "approved",
		});
		expect(res.status).toBe(200);
		const after = store.getTask(t.id)!;
		// stage merging + state queued: the next turn is a merge turn.
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.forkMergeHead).toBe("sha-parked");
		expect(after.holdHead).toBeNull();
		expect(after.pendingPrompt).toBeNull();
	});
});

describe("PR review routes", () => {
	const H1 = "a".repeat(40);
	const H2 = "b".repeat(40);
	const prDir = join(root, "p-pr");
	mkdirSync(prDir, { recursive: true });
	const prStore = ProjectStore.open(prDir);
	afterAll(() => {
		prStore.close();
	});
	const prProjects = new Map<string, Entry>();
	prProjects.set("pg", {
		path: prDir,
		name: "pg",
		store: prStore,
		target: null,
		gitless: false,
		github: "acme/widget",
		remote: null,
		dirty: false,
		mainUnpushed: false,
		mainBranch: null,
		latestRelease: null,
		latestImage: null,
		archReview: null,
	});
	const ghCalls: string[][] = [];
	let ghResult = { code: 0, stdout: "{}", stderr: "" };
	/** Runs inside the fake gh call, after the route's checks: a race window for tests. */
	let ghHook: (() => Promise<void>) | null = null;
	/** GitHub App fetch stub, swappable per test; the mount closes over this indirection. */
	let appFetchImpl: (url: string, init?: RequestInit) => Promise<Response> =
		async () => new Response("{}", { status: 404 });
	const appCalls: Array<{ url: string; init?: RequestInit }> = [];
	const m = mount({
		projects: prProjects,
		gh: async (args) => {
			ghCalls.push(args);
			await ghHook?.();
			return ghResult;
		},
		githubAppFetch: async (url, init) => {
			appCalls.push({ url, init });
			return appFetchImpl(url, init);
		},
	});
	beforeEach(() => {
		ghCalls.length = 0;
		ghResult = { code: 0, stdout: "{}", stderr: "" };
		ghHook = null;
		appCalls.length = 0;
		appFetchImpl = async () => new Response("{}", { status: 404 });
	});
	const row = (n: number): PrReviewRow => {
		const r = prStore.getPrReview(n);
		if (r === null) throw new Error(`no pr_review row ${n}`);
		return r;
	};
	/** Saves a draft for PR `n` at `head` as the watcher does; `answered: false` leaves no draft. */
	const reviewed = (n: number, head: string, answered = true): Task => {
		const prev = prStore.getPrReview(n);
		prStore.savePrReview({
			number: n,
			taskId: prev?.taskId ?? null,
			head,
			firstSeenAt: 0,
			reviewedHead: prev?.reviewedHead ?? null,
			postedHead: prev?.postedHead ?? null,
			postedUrl: prev?.postedUrl ?? null,
			postedLogin: prev?.postedLogin ?? null,
			state: "open",
			draft: false,
			title: "Fix it",
			postError: null,
		});
		const t = prStore.savePrDraft({
			run: prStore.startPrRun(n, head, Date.now()),
			number: n,
			head,
			draft: "draft",
			prompt: "review",
		});
		if (!answered) prStore.updateTask(t.id, { details: null });
		return t;
	};
	/** Posts with the card's current reviewed head, as the drawer does, unless `body` names one. */
	const postReview = (id: string, body: Record<string, unknown>) =>
		m.call(`/api/projects/pg/tasks/${id}/pr-review/post`, {
			head: prStore.getPrReviewByTask(id)?.reviewedHead,
			...body,
		});
	const expectedArgv = (n: number, body: string, head: string) => [
		"api",
		`repos/acme/widget/pulls/${n}/reviews`,
		"-X",
		"POST",
		"-f",
		"event=COMMENT",
		"-f",
		`body=${body}${REVIEW_FOOTER}`,
		"-f",
		`commit_id=${head}`,
	];

	test("project settings route accepts prReviews and rejects non-boolean", async () => {
		const ok = await post("/api/projects/p1/settings", { prReviews: true });
		expect(ok.status).toBe(200);
		expect(store.getSettings().prReviews).toBe(true);
		const bad = await post("/api/projects/p1/settings", { prReviews: "yes" });
		expect(bad.status).toBe(400);
		expect(await errorOf(bad)).toBe("prReviews must be a boolean");
		await post("/api/projects/p1/settings", { prReviews: false });
		expect(store.getSettings().prReviews).toBe(false);
	});

	test("prs/check refuses an unknown project and one without a GitHub remote", async () => {
		const res = await post("/api/projects/p1/prs/check", {});
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("project has no GitHub remote");
		const unknown = await post("/api/projects/nope/prs/check", {});
		expect(unknown.status).toBe(404);
	});

	test("post appends the AI footer and keeps the whole body inside GitHub's 65536 characters", async () => {
		// Its own PR number: the routes share one store, and PR 1 is posted by the next test.
		const t = reviewed(41, H1);
		const tooLong = await postReview(t.id, {
			body: "x".repeat(REVIEW_BODY_MAX + 1),
		});
		expect(tooLong.status).toBe(400);
		expect(ghCalls).toEqual([]);
		const full = "x".repeat(REVIEW_BODY_MAX);
		expect((await postReview(t.id, { body: full })).status).toBe(200);
		const sent = ghCalls[0]!.find((a) => a.startsWith("body="))!.slice(5);
		expect(sent).toBe(full + REVIEW_FOOTER);
		expect(sent.length).toBe(65536);
		expect(REVIEW_FOOTER).toContain("Ottr");
	});

	test("post sends one COMMENT review at the reviewed head, then refuses the same head", async () => {
		const t = reviewed(1, H1);
		const res = await postReview(t.id, { body: "Looks good." });
		expect(res.status).toBe(200);
		expect(ghCalls).toEqual([expectedArgv(1, "Looks good.", H1)]);
		expect(row(1).postedHead).toBe(H1);
		// The default gh body is "{}": no parseable html_url, no link.
		expect(row(1).postedUrl).toBeNull();
		expect(row(1).postError).toBeNull();
		const again = await postReview(t.id, { body: "Looks good." });
		expect(again.status).toBe(409);
		expect(await errorOf(again)).toBe("already posted for this head");
		expect(ghCalls).toHaveLength(1);
	});

	test("a successful post stores the review's html_url, the view links it, and junk URLs stay null", async () => {
		const url = "https://github.com/acme/widget/pull/15#pullrequestreview-9";
		const t = reviewed(15, H1);
		ghResult = {
			code: 0,
			stdout: JSON.stringify({ html_url: url }),
			stderr: "",
		};
		expect((await postReview(t.id, { body: "x" })).status).toBe(200);
		expect(row(15).postedUrl).toBe(url);
		const view = (await (
			await m.call(`/api/projects/pg/tasks/${t.id}`)
		).json()) as { prReview?: { postedUrl?: unknown } };
		expect(view.prReview?.postedUrl).toBe(url);
		// GitHub's stdout is untrusted: only an https github URL becomes the drawer link.
		const t2 = reviewed(16, H1);
		ghResult = {
			code: 0,
			stdout: '{"html_url":"javascript:alert(1)"}',
			stderr: "",
		};
		expect((await postReview(t2.id, { body: "x" })).status).toBe(200);
		expect(row(16).postedUrl).toBeNull();
	});

	test("a new reviewed head opens post again", async () => {
		const t = reviewed(2, H1);
		expect((await postReview(t.id, { body: "first" })).status).toBe(200);
		expect(reviewed(2, H2).id).toBe(t.id);
		const res = await postReview(t.id, { body: "second" });
		expect(res.status).toBe(200);
		expect(ghCalls.at(-1)).toEqual(expectedArgv(2, "second", H2));
		expect(row(2).postedHead).toBe(H2);
	});

	test("post refuses a draft of an older head after a newer draft landed, then posts the new one", async () => {
		const t = reviewed(14, H1);
		reviewed(14, H2);
		for (const head of [H1, undefined, 7]) {
			const res = await postReview(t.id, { body: "edited A", head });
			expect(res.status).toBe(409);
			expect(await errorOf(res)).toBe("the draft changed");
		}
		expect(ghCalls).toHaveLength(0);
		expect(row(14).postedHead).toBeNull();
		expect((await postReview(t.id, { body: "B", head: H2 })).status).toBe(200);
		expect(ghCalls).toEqual([expectedArgv(14, "B", H2)]);
	});

	test("post refuses a closed PR", async () => {
		const t = reviewed(3, H1);
		prStore.savePrReview({ ...row(3), state: "closed" });
		const res = await postReview(t.id, { body: "late" });
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("PR is closed");
		expect(ghCalls).toHaveLength(0);
	});

	test("post rejects an empty, blank, non-string or oversized body", async () => {
		const t = reviewed(4, H1);
		for (const body of ["", "   ", 5, "x".repeat(65537)]) {
			const res = await postReview(t.id, { body });
			expect(res.status).toBe(400);
		}
		expect(ghCalls).toHaveLength(0);
	});

	test("post refuses a card without a draft and a card of another kind", async () => {
		const t = reviewed(5, H1, false);
		const res = await postReview(t.id, { body: "early" });
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("no draft to post");
		const work = prStore.createTask("plain card");
		expect((await postReview(work.id, { body: "x" })).status).toBe(409);
		expect(ghCalls).toHaveLength(0);
	});

	test("a gh failure returns 502, stores the error and keeps postedHead null", async () => {
		const t = reviewed(6, H1);
		ghResult = { code: 1, stdout: "", stderr: "  HTTP 422: nope\n" };
		const res = await postReview(t.id, { body: "fail" });
		expect(res.status).toBe(502);
		expect(await errorOf(res)).toBe("HTTP 422: nope");
		expect(row(6).postError).toBe("HTTP 422: nope");
		expect(row(6).postedHead).toBeNull();
		expect(row(6).postedUrl).toBeNull();
	});

	test("a gh spawn error frees the claim, stores the error, and allows a retry", async () => {
		const t = reviewed(13, H1);
		ghHook = async () => {
			throw new Error("gh: command not found");
		};
		const res = await postReview(t.id, { body: "x" });
		expect(res.status).toBe(502);
		expect(await errorOf(res)).toBe("gh: command not found");
		expect(row(13).postedHead).toBeNull();
		expect(row(13).postError).toBe("gh: command not found");
		ghHook = null;
		expect((await postReview(t.id, { body: "x" })).status).toBe(200);
		expect(row(13).postedHead).toBe(H1);
	});

	test("two concurrent posts of one head send one GitHub review", async () => {
		const t = reviewed(9, H1);
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		ghHook = () => {
			entered.resolve();
			return gate.promise;
		};
		const first = postReview(t.id, { body: "a" });
		await entered.promise;
		const second = await postReview(t.id, { body: "b" });
		gate.resolve();
		expect((await first).status).toBe(200);
		expect(second.status).toBe(409);
		expect(ghCalls).toHaveLength(1);
		expect(row(9).postedHead).toBe(H1);
	});

	test("a post keeps a PR state the watcher wrote during the gh call, on success and failure", async () => {
		for (const [n, code] of [
			[10, 0],
			[11, 1],
		] as const) {
			const t = reviewed(n, H1);
			ghResult = { code, stdout: "{}", stderr: code ? "HTTP 500" : "" };
			ghHook = async () => prStore.setPrState(n, "merged");
			const res = await postReview(t.id, { body: "x" });
			expect(res.status).toBe(code ? 502 : 200);
			expect(row(n).state).toBe("merged");
			expect(row(n).postedHead).toBe(code ? null : H1);
			expect(row(n).postError).toBe(code ? "HTTP 500" : null);
		}
	});

	test("the task view exposes prReview", async () => {
		const t = reviewed(8, H1);
		const view = (await (
			await m.call(`/api/projects/pg/tasks/${t.id}`)
		).json()) as { prReview?: unknown };
		expect(view.prReview).toEqual({
			number: 8,
			url: "https://github.com/acme/widget/pull/8",
			state: "open",
			reviewedHead: H1,
			postedHead: null,
			postedUrl: null,
			postedLogin: null,
			postError: null,
		});
	});

	// --- GitHub App posts (OTTR-340): old code always posted with the board token via gh,
	// and no route/view exposed the app, so every test below fails on that old behavior.
	const { privateKey: appKeyPair } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const APP_PEM = appKeyPair
		.export({ format: "pem", type: "pkcs8" })
		.toString();
	const APP_ID = "1234";
	const saveApp = () =>
		m.call("/api/git-hosts/github-app", { id: APP_ID, key: APP_PEM });
	const removeApp = () =>
		m.call("/api/git-hosts/github-app", undefined, { method: "DELETE" });
	/** App-path stub: installation 77, installation token INSTA, one review answer. */
	const appHappyPath = (review: unknown): void => {
		appFetchImpl = async (url) => {
			if (url.endsWith("/installation")) return Response.json({ id: 77 });
			if (url.includes("/access_tokens"))
				return Response.json({
					token: "INSTA",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				});
			if (url.endsWith("/reviews")) return Response.json(review);
			return Response.json({ message: "no route" }, { status: 404 });
		};
	};

	test("no app configured: the post falls back to gh and reports the person's login", async () => {
		await removeApp();
		const t = reviewed(20, H1);
		ghResult = {
			code: 0,
			stdout: JSON.stringify({
				html_url: "https://github.com/acme/widget/pull/20#pullrequestreview-1",
				user: { login: "octocat" },
			}),
			stderr: "",
		};
		const res = await postReview(t.id, { body: "Looks good." });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			login: "octocat",
			via: "token",
		});
		expect(ghCalls).toEqual([expectedArgv(20, "Looks good.", H1)]);
		expect(appCalls).toEqual([]);
		expect(row(20).postedLogin).toBe("octocat");
	});

	test("an app without an installation falls back to gh with via token", async () => {
		await saveApp();
		// Default appFetchImpl answers 404 for the installation lookup.
		const t = reviewed(21, H1);
		ghResult = {
			code: 0,
			stdout: JSON.stringify({
				html_url: "https://github.com/acme/widget/pull/21#pullrequestreview-1",
				user: { login: "octocat" },
			}),
			stderr: "",
		};
		const res = await postReview(t.id, { body: "Looks good." });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			login: "octocat",
			via: "token",
		});
		expect(appCalls.some((c) => c.url.endsWith("/installation"))).toBe(true);
		expect(ghCalls).toEqual([expectedArgv(21, "Looks good.", H1)]);
		await removeApp();
	});

	test("an app post carries the installation token and never runs gh", async () => {
		await saveApp();
		appHappyPath({
			html_url: "https://github.com/acme/widget/pull/22#review-1",
			user: { login: "ottr[bot]" },
		});
		const t = reviewed(22, H1);
		const res = await postReview(t.id, { body: "Ship it." });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			login: "ottr[bot]",
			via: "app",
		});
		expect(ghCalls).toEqual([]);
		const mint = appCalls.find((c) => c.url.endsWith("/installation"))!;
		expect(
			(mint.init!.headers as Record<string, string>).authorization,
		).toContain("eyJ");
		const postCall = appCalls.find((c) => c.url.endsWith("/reviews"))!;
		expect(postCall.url).toBe(
			"https://api.github.com/repos/acme/widget/pulls/22/reviews",
		);
		const headers = postCall.init!.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer INSTA");
		expect(JSON.parse(postCall.init!.body as string)).toEqual({
			event: "COMMENT",
			body: `Ship it.${REVIEW_FOOTER}`,
			commit_id: H1,
		});
		const view = (await (
			await m.call(`/api/projects/pg/tasks/${t.id}`)
		).json()) as {
			prReview: { postedLogin: string | null; postedUrl: string | null };
		};
		expect(view.prReview.postedLogin).toBe("ottr[bot]");
		expect(view.prReview.postedUrl).toBe(
			"https://github.com/acme/widget/pull/22#review-1",
		);
		await removeApp();
	});

	test("on another host the app mint and the review post sit on that host's API base", async () => {
		const savedHost = process.env.OTTR_GITHUB_HOST;
		process.env.OTTR_GITHUB_HOST = "acme.ghe.com";
		await saveApp();
		try {
			appHappyPath({
				html_url: "https://acme.ghe.com/acme/widget/pull/24#review-1",
				user: { login: "ottr[bot]" },
			});
			const t = reviewed(24, H1);
			const res = await postReview(t.id, { body: "Ship it." });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				ok: true,
				login: "ottr[bot]",
				via: "app",
			});
			const mint = appCalls.find((c) => c.url.endsWith("/installation"))!;
			expect(mint.url).toBe(
				"https://api.acme.ghe.com/repos/acme/widget/installation",
			);
			const tokenCall = appCalls.find((c) => c.url.includes("/access_tokens"))!;
			expect(tokenCall.url).toBe(
				"https://api.acme.ghe.com/app/installations/77/access_tokens",
			);
			const postCall = appCalls.find((c) => c.url.endsWith("/reviews"))!;
			expect(postCall.url).toBe(
				"https://api.acme.ghe.com/repos/acme/widget/pulls/24/reviews",
			);
			// The stored drawer link keeps the host's own html_url; a github.com-only
			// check would drop it and the card would lose its review link.
			const view = (await (
				await m.call(`/api/projects/pg/tasks/${t.id}`)
			).json()) as {
				prReview: { postedLogin: string | null; postedUrl: string | null };
			};
			expect(view.prReview.postedLogin).toBe("ottr[bot]");
			expect(view.prReview.postedUrl).toBe(
				"https://acme.ghe.com/acme/widget/pull/24#review-1",
			);
		} finally {
			if (savedHost === undefined) delete process.env.OTTR_GITHUB_HOST;
			else process.env.OTTR_GITHUB_HOST = savedHost;
			await removeApp();
		}
	});

	test("a failed token mint is a 502: the claim is released, post_error set, no key leaks", async () => {
		await saveApp();
		appFetchImpl = async (url) =>
			url.endsWith("/installation")
				? Response.json({ id: 77 })
				: Response.json({ message: "nope" }, { status: 500 });
		const t = reviewed(23, H1);
		const res = await postReview(t.id, { body: "x" });
		expect(res.status).toBe(502);
		const text = await res.text();
		expect(text).not.toContain(APP_PEM);
		// The claim is released: the task view shows the head as not posted.
		const view = (await (
			await m.call(`/api/projects/pg/tasks/${t.id}`)
		).json()) as {
			prReview: { postedHead: string | null; postError: string | null };
		};
		expect(view.prReview.postedHead).toBeNull();
		expect(view.prReview.postError).not.toBeNull();
		expect(view.prReview.postError).not.toContain(APP_PEM);
		expect(ghCalls).toEqual([]);
		await removeApp();
	});

	test("github-app settings save, view and errors never expose the key", async () => {
		await removeApp();
		const badId = await m.call("/api/git-hosts/github-app", {
			id: "abc",
			key: APP_PEM,
		});
		expect(badId.status).toBe(400);
		expect(await errorOf(badId)).toBe(
			"app id must be the numeric GitHub App ID",
		);
		const badKey = await m.call("/api/git-hosts/github-app", {
			id: APP_ID,
			key: "not a key",
		});
		expect(badKey.status).toBe(400);
		expect(await errorOf(badKey)).toBe(
			"the private key must be a PEM RSA private key",
		);
		const res = await saveApp();
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(APP_PEM);
		const view = JSON.parse(text) as {
			githubApp: { id: string; fingerprint: string } | null;
		};
		expect(view.githubApp).not.toBeNull();
		expect(view.githubApp!.id).toBe(APP_ID);
		expect(view.githubApp!.fingerprint.startsWith("SHA256:")).toBe(true);
		const hosts = await m.call("/api/git-hosts", undefined);
		expect(await hosts.text()).not.toContain(APP_PEM);
		const del = await removeApp();
		expect(((await del.json()) as { githubApp: unknown }).githubApp).toBeNull();
	});

	test("properties: random credentials never leak the key, and a throwing mint 502s without it", async () => {
		const creds = fc.record({
			id: fc.oneof(fc.string(), fc.constant(APP_ID)),
			key: fc.oneof(fc.string(), fc.constant(APP_PEM)),
		});
		await fc.assert(
			fc.asyncProperty(creds, fc.string(), async (body, message) => {
				const saved = await m.call("/api/git-hosts/github-app", body);
				expect([200, 400]).toContain(saved.status);
				expect(await saved.text()).not.toContain(APP_PEM);
				if (saved.status !== 200) return;
				const t = reviewed(24, H1);
				// Reopen the claim every run: the previous property run may have posted.
				const r = prStore.getPrReview(24)!;
				prStore.savePrReview({
					...r,
					postedHead: null,
					postError: null,
					postedLogin: null,
				});
				appFetchImpl = async () => {
					throw new Error(message.slice(0, 50));
				};
				const res = await postReview(t.id, { body: "x" });
				expect(res.status).toBe(502);
				expect(await res.text()).not.toContain(APP_PEM);
				const after = prStore.getPrReview(24)!;
				expect(after.postedHead).toBeNull();
				expect(after.postError).not.toContain(APP_PEM);
				await removeApp();
			}),
			// Gate: the shared fixed-seed helper; 100 runs here, below the 200 gate.
			{ numRuns: 100 },
		);
	});
});

describe("backlog routes", () => {
	test("grill queues an idle backlog task", async () => {
		const t = store.createTask("parked idea");
		store.updateTask(t.id, { stage: "backlog", state: "idle", queuedAt: null });
		const res = await post(`/api/projects/p1/tasks/${t.id}/grill`, {});
		expect(res.status).toBe(200);
		const row = store.getTask(t.id)!;
		expect(row.state).toBe("queued");
		expect(row.needsReason).toBeNull();
		expect(row.asked).toBeNull();
	});

	test("grill accepts a model pick and lands it on the card", async () => {
		const t = store.createTask("parked with model");
		store.updateTask(t.id, { stage: "backlog", state: "idle", queuedAt: null });
		const res = await post(`/api/projects/p1/tasks/${t.id}/grill`, {
			model: "openai/gpt-5",
		});
		expect(res.status).toBe(200);
		const row = store.getTask(t.id)!;
		expect(row.model).toBe("openai/gpt-5");
		expect(row.state).toBe("queued");
	});

	test("promote to todo accepts a model pick", async () => {
		const t = store.createTask("parked promote model");
		store.updateTask(t.id, { stage: "backlog", state: "idle", queuedAt: null });
		const res = await post(`/api/projects/p1/tasks/${t.id}/backlog`, {
			to: "todo",
			model: "openai/gpt-5",
		});
		expect(res.status).toBe(200);
		const row = store.getTask(t.id)!;
		expect(row.stage).toBe("todo");
		expect(row.model).toBe("openai/gpt-5");
	});

	test("grill refuses a non-string model", async () => {
		const t = store.createTask("parked bad model");
		store.updateTask(t.id, { stage: "backlog", state: "idle", queuedAt: null });
		const res = await post(`/api/projects/p1/tasks/${t.id}/grill`, {
			model: 42,
		});
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("model must be a string");
	});

	test("grill refuses a todo card and a running card", async () => {
		const todo = store.createTask("plain todo");
		const r1 = await post(`/api/projects/p1/tasks/${todo.id}/grill`, {});
		expect(r1.status).toBe(409);
		expect(await errorOf(r1)).toBe("only a backlog task can be grilled");
		const busy = store.createTask("parked busy");
		store.updateTask(busy.id, {
			stage: "backlog",
			state: "running",
			queuedAt: null,
		});
		const r2 = await post(`/api/projects/p1/tasks/${busy.id}/grill`, {});
		expect(r2.status).toBe(409);
		expect(await errorOf(r2)).toBe("the grill is already queued or running");
	});

	test("deepen returns the rewrite through the seam", async () => {
		const seen: Array<{ prompt: string; model: string | null }> = [];
		const prev = deepenImpl;
		deepenImpl = async (prompt, model) => {
			seen.push({ prompt, model });
			return "  deeper draft  ";
		};
		try {
			const res = await post("/api/projects/p1/deepen", {
				prompt: "  my draft  ",
				model: "openai/gpt-5",
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ deepened: "  deeper draft  " });
			// The seam sees the trimmed prompt and the model passthrough.
			expect(seen).toEqual([{ prompt: "my draft", model: "openai/gpt-5" }]);
			const noModel = await post("/api/projects/p1/deepen", {
				prompt: "my draft",
			});
			expect(noModel.status).toBe(200);
			expect(seen[1]).toEqual({ prompt: "my draft", model: null });
		} finally {
			deepenImpl = prev;
		}
	});

	test("deepen validates the prompt and the model", async () => {
		const nonString = await post("/api/projects/p1/deepen", { prompt: 7 });
		expect(nonString.status).toBe(400);
		expect(await errorOf(nonString)).toBe("prompt must be a string");
		const empty = await post("/api/projects/p1/deepen", { prompt: "   " });
		expect(empty.status).toBe(400);
		expect(await errorOf(empty)).toBe("prompt must be 1-20000 characters");
		const long = await post("/api/projects/p1/deepen", {
			prompt: "x".repeat(20001),
		});
		expect(long.status).toBe(400);
		expect(await errorOf(long)).toBe("prompt must be 1-20000 characters");
		const badModel = await post("/api/projects/p1/deepen", {
			prompt: "x",
			model: 42,
		});
		expect(badModel.status).toBe(400);
		expect(await errorOf(badModel)).toBe("model must be a string");
		const unknown = await post("/api/projects/ghost/deepen", {
			prompt: "x",
		});
		expect(unknown.status).toBe(404);
		expect(await errorOf(unknown)).toBe("unknown project");
	});

	test("deepen maps a throwing seam to 502 and keeps the draft's side effect-free path", async () => {
		const prev = deepenImpl;
		deepenImpl = async () => {
			throw new Error("gateway exploded");
		};
		try {
			const res = await post("/api/projects/p1/deepen", { prompt: "x" });
			expect(res.status).toBe(502);
			expect(await errorOf(res)).toBe(
				"the model call failed: gateway exploded",
			);
		} finally {
			deepenImpl = prev;
		}
		const prev2 = deepenImpl;
		deepenImpl = async () => {
			throw "not an error";
		};
		try {
			const res = await post("/api/projects/p1/deepen", { prompt: "x" });
			expect(res.status).toBe(502);
			expect(await errorOf(res)).toBe("the model call failed: unknown error");
		} finally {
			deepenImpl = prev2;
		}
	});

	test("backlog to-todo folds the latest grill report into the prompt", async () => {
		const t = store.createTask("half-baked");
		store.updateTask(t.id, { stage: "backlog", state: "idle", queuedAt: null });
		// Older qualifying turn plus an ignored one: the scan picks the LAST ready turn.
		const old = store.startTurn(t.id, "work", "grill", null);
		store.finishTurn(old.id, { outcome: "ready", details: "old draft" });
		const grill = store.startTurn(t.id, "work", "grill", null);
		store.finishTurn(grill.id, {
			outcome: "ready",
			details: "keep the API small",
		});
		const res = await post(`/api/projects/p1/tasks/${t.id}/backlog`, {
			to: "todo",
		});
		expect(res.status).toBe(200);
		const row = store.getTask(t.id)!;
		expect(row.stage).toBe("todo");
		expect(row.state).toBe("queued");
		expect(row.prompt).toContain("Definition of ready (grilled)");
		expect(row.prompt).toContain("keep the API small");
		expect(row.prompt).not.toContain("old draft");
	});

	test("backlog to-backlog parks a queued todo task", async () => {
		const t = store.createTask("wait a week");
		const res = await post(`/api/projects/p1/tasks/${t.id}/backlog`, {
			to: "backlog",
		});
		expect(res.status).toBe(200);
		const row = store.getTask(t.id)!;
		expect(row.stage).toBe("backlog");
		expect(row.state).toBe("idle");
		expect(row.queuedAt).toBeNull();
	});

	test("backlog refuses bad bodies and non-parkable cards", async () => {
		const t = store.createTask("no direction");
		const bad = await post(`/api/projects/p1/tasks/${t.id}/backlog`, {
			to: "done",
		});
		expect(bad.status).toBe(400);
		const busy = store.createTask("already running");
		store.updateTask(busy.id, { state: "running" });
		const r = await post(`/api/projects/p1/tasks/${busy.id}/backlog`, {
			to: "backlog",
		});
		expect(r.status).toBe(409);
		expect(await errorOf(r)).toBe(
			"a running, preparing, or needs-you task cannot be parked",
		);
	});

	test("create accepts backlog: true and lands in the backlog", async () => {
		const res = await post("/api/projects/p1/tasks", {
			prompt: "filed parked",
			backlog: true,
		});
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		const id = (b as { id: string }).id;
		const row = store.getTask(id)!;
		expect(row.stage).toBe("backlog");
		expect(row.state).toBe("idle");
		expect(row.queuedAt).toBeNull();
	});

	test("edit allows a backlog card but not a done card", async () => {
		const parked = store.createTask("edit me later");
		store.updateTask(parked.id, {
			stage: "backlog",
			state: "idle",
			queuedAt: null,
		});
		const ok = await post(`/api/projects/p1/tasks/${parked.id}/edit`, {
			prompt: "edited while parked",
		});
		expect(ok.status).toBe(200);
		expect(store.getTask(parked.id)?.prompt).toBe("edited while parked");
		const done = store.createTask("already merged");
		store.updateTask(done.id, { stage: "done", state: "idle", queuedAt: null });
		const no = await post(`/api/projects/p1/tasks/${done.id}/edit`, {
			prompt: "nope",
		});
		expect(no.status).toBe(409);
	});
});

// Documented git-hosts API envelopes; this suite has no runtime validator (same convention
// as AddProjectResponse), so tests read them through these named types.
type TrustBody = {
	error: string;
	needsTrust: boolean;
	host: string;
	fingerprints: string[];
};
type PendingBody = { id: string; publicKey: string; fingerprint: string };
type KeyBody = { publicKey: string; fingerprint: string };
type HostsView = {
	tokens: Array<{ host: string; username: string; tokenSet: boolean }>;
	globalKey: KeyBody | null;
	githubApp: { id: string; fingerprint: string } | null;
	githubHost: string | null;
	githubTokenSet: boolean;
};

describe("git-host urls on add project", () => {
	test("https forms on other hosts clone, and a nested path proposes its last segment", async () => {
		makeFixture("gl/nested-repo");
		const nested = await post("/api/projects", {
			url: "https://gitlab.com/g/sub/nested-repo",
		});
		expect(nested.status).toBe(200);
		const added = (await nested.json()) as AddProjectResponse;
		expect(added.project.path).toBe(join(root, "nested-repo"));
		makeFixture("ex/ported");
		const ported = await post("/api/projects", {
			url: "https://git.example.com:8443/a/b/c/ported",
		});
		expect(ported.status).toBe(200);
		expect(projects.get("ported")?.path).toBe(join(root, "ported"));
	});

	test("an explicit name override wins over the proposed one", async () => {
		makeFixture("gl/override-me");
		const res = await post("/api/projects", {
			url: "https://gitlab.com/g/sub/override-me",
			name: "custom-name",
		});
		expect(res.status).toBe(200);
		const added = (await res.json()) as AddProjectResponse;
		expect(added.project.path).toBe(join(root, "custom-name"));
	});

	test("a GitHub repo named -repo clones under its own name, as before git hosts", async () => {
		makeFixture("-dashed");
		const res = await post("/api/projects", {
			url: "https://github.com/octo/-dashed",
		});
		expect(res.status).toBe(200);
		const added = (await res.json()) as AddProjectResponse;
		expect(added.project.path).toBe(join(root, "-dashed"));
	});

	test("the New tab keeps its folder rule: dot- and dash-leading names are folders", async () => {
		for (const name of [".local-new", "-local-new"]) {
			const res = await post("/api/projects", { name });
			expect(res.status).toBe(200);
			const added = (await res.json()) as AddProjectResponse;
			expect(added.project.path).toBe(join(root, name));
		}
		for (const name of [".", "..", "a/b"]) {
			const res = await post("/api/projects", { name });
			expect(res.status).toBe(400);
		}
	});

	test("a taken name is 409 before the clone; an on-disk destination keeps the existing 400", async () => {
		const first = await post("/api/projects", { name: "dupname" });
		expect(first.status).toBe(200);
		makeFixture("gl/dupname");
		const taken = await post("/api/projects", {
			url: "https://gitlab.com/g/sub/dupname",
		});
		expect(taken.status).toBe(409);
		// A leftover folder with no board entry: the pre-existing clone-destination 400.
		const dest = join(root, "leftover-dir");
		mkdirSync(dest, { recursive: true });
		const exists = await post("/api/projects", {
			url: "https://gitlab.com/g/sub/leftover-dir",
		});
		expect(exists.status).toBe(400);
		expect(await errorOf(exists)).toBe(
			`clone destination already exists: ${dest}`,
		);
	});

	test("rejected url classes answer 400 with the git-url error", async () => {
		for (const bad of [
			"file:///tmp/repo",
			"git://gitlab.com/g/sub/repo",
			"http://gitlab.com/g/sub/repo",
			"https://user@gitlab.com/g/sub/repo",
			"gitlab.com/g/sub/repo",
			"-gitlab.com/g/sub/repo",
			"https://git lab.com/g/sub/repo",
			"https://gitlab.com/g/sub/.hidden",
			"https://gitlab.com:99999/g/sub/repo",
		]) {
			const res = await post("/api/projects", { url: bad });
			expect(res.status).toBe(400);
			expect(await errorOf(res)).toBe(GIT_URL_ERROR);
		}
	});
});

describe("git-host ssh clone urls", () => {
	test("an ssh url with no global key and no own key is a 400 before any network step", async () => {
		makeFixture("scp/no-key-repo");
		const f = sshFixture();
		let scans = 0;
		const m = mount({
			sshDir: f.dir,
			keyscan: async (h, p) => {
				scans++;
				return f.keyscan(h, p);
			},
		});
		const res = await m.call("/api/projects", {
			url: "git@git.example.com:a/no-key-repo",
		});
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toContain("no global SSH key");
		expect(scans).toBe(0);
		expect(existsSync(join(f.dir, "known_hosts"))).toBe(false);
		expect(existsSync(join(root, "no-key-repo"))).toBe(false);
		const test = await m.call("/api/git-hosts/ssh/test", {
			url: "git@git.example.com:a/no-key-repo",
			key: "global",
		});
		expect(test.status).toBe(400);
		expect(await errorOf(test)).toContain("no global SSH key");
	});

	test("an scp-style ssh url needs trust, then clones with the global key", async () => {
		makeFixture("scp/scp-repo");
		const f = sshFixture();
		seedGlobalKey(f.dir);
		const m = mount({ sshDir: f.dir, keyscan: f.keyscan });
		const need = await m.call("/api/projects", {
			url: "git@git.example.com:a/scp-repo",
		});
		expect(need.status).toBe(409);
		const trust = (await need.json()) as TrustBody;
		expect(trust.needsTrust).toBe(true);
		expect(trust.host).toBe("git.example.com");
		expect(trust.fingerprints.length).toBeGreaterThan(0);
		// The 409 must precede any clone: nothing landed on disk.
		expect(existsSync(join(root, "scp-repo"))).toBe(false);
		// sshKey defaults to "global", which exists here.
		const ok = await m.call("/api/projects", {
			url: "git@git.example.com:a/scp-repo",
			trust: trust.fingerprints,
		});
		expect(ok.status).toBe(200);
		const added = (await ok.json()) as AddProjectResponse;
		expect(added.project.path).toBe(join(root, "scp-repo"));
	});

	test("an ssh:// url with a port trusts under its host:port form", async () => {
		makeFixture("ssh2/sshlong");
		const f = sshFixture();
		seedGlobalKey(f.dir);
		const m = mount({ sshDir: f.dir, keyscan: f.keyscan });
		const url = "ssh://git@git.example.com:2222/a/sshlong";
		const need = await m.call("/api/projects", { url });
		expect(need.status).toBe(409);
		const trust = (await need.json()) as TrustBody;
		expect(trust.host).toBe("git.example.com:2222");
		const ok = await m.call("/api/projects", {
			url,
			trust: trust.fingerprints,
		});
		expect(ok.status).toBe(200);
		const added = (await ok.json()) as AddProjectResponse;
		expect(added.project.path).toBe(join(root, "sshlong"));
	});

	test("a promoted pending key serves the project worktrees through networkGitAuth", async () => {
		makeFixture("scp/promoted");
		const f = sshFixture();
		const m = mount({ sshDir: f.dir, keyscan: f.keyscan });
		const gen = await m.call("/api/git-hosts/ssh/pending", {});
		const pending = (await gen.json()) as PendingBody;
		const url = "git@git.example.com:a/promoted";
		const need = await m.call("/api/projects", {
			url,
			sshKey: `pending:${pending.id}`,
		});
		expect(need.status).toBe(409);
		const trust = (await need.json()) as TrustBody;
		const ok = await m.call("/api/projects", {
			url,
			sshKey: `pending:${pending.id}`,
			trust: trust.fingerprints,
		});
		expect(ok.status).toBe(200);
		// The pending key moved into the project slot on the server, outside every checkout.
		expect(existsSync(join(f.dir, "pending", pending.id))).toBe(false);
		const keyPath = join(f.dir, "projects", "promoted");
		expect(existsSync(keyPath)).toBe(true);
		// The project's worktrees get GIT_SSH_COMMAND with that key. An unrelated cwd gets no
		// Ottr identity, but keeps the strict host controls: a host is confirmed now.
		const env = networkGitAuth(join(root, "promoted", ".worktrees", "x"));
		expect(env.GIT_SSH_COMMAND).toContain(keyPath);
		const stray = networkGitAuth(join(root, "elsewhere", ".worktrees", "x"));
		expect(stray.GIT_SSH_COMMAND).not.toContain(" -i ");
		expect(stray.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
		// Removing the last key keeps the confirmed known_hosts in force: never ambient ssh.
		const del = await m.call("/api/projects/promoted/ssh-key", undefined, {
			method: "DELETE",
		});
		expect(del.status).toBe(200);
		const after = networkGitAuth(join(root, "promoted", ".worktrees", "x"));
		expect(after.GIT_SSH_COMMAND).not.toContain(keyPath);
		expect(after.GIT_SSH_COMMAND).toContain(
			`UserKnownHostsFile='${join(f.dir, "known_hosts")}'`,
		);
		expect(after.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
		// Network git output never shows a key path, even with no token stored.
		const out = await git(["ls-remote", "--", join(keyPath, "nope")], tmpdir());
		expect(out.stderr).not.toContain(f.dir);
		expect(out.stderr).toContain("[REDACTED]");
	});
});

describe("git-host ssh dir isolation", () => {
	test("a dev board's key DELETE and PUT leave the production key and known_hosts byte-identical", async () => {
		const saved = {
			state: process.env.OTTR_STATE_DIR,
			ssh: process.env.OTTR_SSH_DIR,
			xdg: process.env.XDG_DATA_HOME,
		};
		const base = mkdtempSync(join(tmpdir(), "ottr-iso-"));
		sshTempDirs.push(base);
		try {
			delete process.env.OTTR_SSH_DIR;
			process.env.XDG_DATA_HOME = join(base, "data");
			// Production: the native default, with a global key and a confirmed host.
			const prod = defaultSshDir();
			mkdirSync(prod, { recursive: true });
			seedGlobalKey(prod);
			writeFileSync(
				join(prod, "known_hosts"),
				"git.example.com ssh-ed25519 AAAAprod\n",
			);
			const snap = () =>
				["global", "global.pub", "known_hosts"].map((n) =>
					readFileSync(join(prod, n)).toString("base64"),
				);
			const before = snap();
			// A dev board: src/dev.ts sets OTTR_STATE_DIR; the app takes the default ssh dir.
			process.env.OTTR_STATE_DIR = join(base, "dev-state");
			makeFixture("scp/iso-repo");
			const f = sshFixture();
			const m = mount({ keyscan: f.keyscan });
			expect((await m.call("/api/git-hosts", undefined)).status).toBe(200);
			const del = await m.call("/api/git-hosts/ssh/global", undefined, {
				method: "DELETE",
			});
			expect(del.status).toBe(200);
			const gen = await m.call("/api/git-hosts/ssh/pending", {});
			const pending = (await gen.json()) as PendingBody;
			const sel = {
				pending: `pending:${pending.id}`,
				testUrl: "git@git.example.com:a/iso-repo",
			};
			const need = await m.call("/api/git-hosts/ssh/global", sel, {
				method: "PUT",
			});
			const trust = (await need.json()) as TrustBody;
			const put = await m.call(
				"/api/git-hosts/ssh/global",
				{ ...sel, trust: trust.fingerprints },
				{ method: "PUT" },
			);
			expect(put.status).toBe(200);
			// The dev board wrote its own key and known_hosts; production is untouched.
			const dev = join(base, "dev-state", "ssh");
			expect(existsSync(join(dev, "global"))).toBe(true);
			expect(existsSync(join(dev, "known_hosts"))).toBe(true);
			expect(snap()).toEqual(before);
		} finally {
			for (const [k, v] of [
				["OTTR_STATE_DIR", saved.state],
				["OTTR_SSH_DIR", saved.ssh],
				["XDG_DATA_HOME", saved.xdg],
			] as const)
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
		}
	});
});

describe("git-host tokens", () => {
	test("a token is tested on its own host, saved once tested, and never echoed", async () => {
		makeFixture("gl/tokened");
		const m = mount({ sshDir: join(root, "ssh-tokens") });
		const res = await m.call("/api/git-hosts/tokens", {
			host: "gitlab.com",
			token: "glpat-test-token-000",
			testUrl: "https://gitlab.com/g/sub/tokened",
		});
		expect(res.status).toBe(200);
		const saved = (await res.json()) as HostsView;
		expect(saved.tokens).toEqual([
			{ host: "gitlab.com", username: "oauth2", tokenSet: true },
		]);
		// Write-only: no view ever carries the token itself.
		expect(await (await m.call("/api/git-hosts")).text()).not.toContain(
			"glpat-test-token-000",
		);
		// A re-save replaces the host's entry.
		const again = await m.call("/api/git-hosts/tokens", {
			host: "gitlab.com",
			username: "deploy",
			token: "glpat-test-token-111",
			testUrl: "https://gitlab.com/g/sub/tokened",
		});
		expect(again.status).toBe(200);
		const replaced = (await again.json()) as HostsView;
		expect(replaced.tokens).toEqual([
			{ host: "gitlab.com", username: "deploy", tokenSet: true },
		]);
		const del = await m.call("/api/git-hosts/tokens/gitlab.com", undefined, {
			method: "DELETE",
		});
		expect(del.status).toBe(200);
		const after = (await del.json()) as HostsView;
		expect(after.tokens).toEqual([]);
	});

	test("a failed test, a wrong host, or a bad token saves nothing", async () => {
		const m = mount({ sshDir: join(root, "ssh-tokens2") });
		const fail = await m.call("/api/git-hosts/tokens", {
			host: "gitlab.com",
			token: "glpat-test-token-222",
			// insteadOf maps this onto a fixture path that does not exist.
			testUrl: "https://gitlab.com/g/sub/nope",
		});
		expect(fail.status).toBe(400);
		const view = (await (await m.call("/api/git-hosts")).json()) as HostsView;
		expect(view.tokens).toEqual([]);
		const wrongHost = await m.call("/api/git-hosts/tokens", {
			host: "gitlab.com",
			token: "glpat-test-token-333",
			testUrl: "https://git.example.com:8443/a/b/c/tokened",
		});
		expect(wrongHost.status).toBe(400);
		const badToken = await m.call("/api/git-hosts/tokens", {
			host: "gitlab.com",
			token: "two words",
			testUrl: "https://gitlab.com/g/sub/tokened",
		});
		expect(badToken.status).toBe(400);
	});
});

describe("git-hosts view github host", () => {
	test("the view names the configured host, the default, and null for an invalid value", async () => {
		const m = mount({ sshDir: join(root, "ssh-host-view") });
		const savedHost = process.env.OTTR_GITHUB_HOST;
		try {
			process.env.OTTR_GITHUB_HOST = "acme.ghe.com";
			const withHost = (await (
				await m.call("/api/git-hosts")
			).json()) as HostsView;
			expect(withHost.githubHost).toBe("acme.ghe.com");
			expect(withHost.githubTokenSet).toBe(false);
			delete process.env.OTTR_GITHUB_HOST;
			expect((await (await m.call("/api/git-hosts")).json()).githubHost).toBe(
				"github.com",
			);
			process.env.OTTR_GITHUB_HOST = "https://x";
			expect((await (await m.call("/api/git-hosts")).json()).githubHost).toBe(
				null,
			);
		} finally {
			if (savedHost === undefined) delete process.env.OTTR_GITHUB_HOST;
			else process.env.OTTR_GITHUB_HOST = savedHost;
		}
	});
});

describe("POST /api/git-hosts/github-token", () => {
	const savedHost = process.env.OTTR_GITHUB_HOST;
	const savedGhToken = process.env.GH_TOKEN;
	afterAll(() => {
		if (savedHost === undefined) delete process.env.OTTR_GITHUB_HOST;
		else process.env.OTTR_GITHUB_HOST = savedHost;
		if (savedGhToken === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = savedGhToken;
	});

	/** The token save probes api.github.com; the stub keeps the test off the network. */
	const withGithubFetch = async <T>(fn: () => Promise<T>): Promise<T> => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url === "https://api.github.com/repos/ottr-ai/ottr")
				return new Response(null, { status: 200 });
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			return await fn();
		} finally {
			globalThis.fetch = realFetch;
		}
	};

	test("stores the board token as x-access-token for the configured host", async () => {
		delete process.env.OTTR_GITHUB_HOST;
		// insteadOf keeps the remainder verbatim: the fixture is <root>/tokened.
		makeFixture("tokened");
		const m = mount({ sshDir: join(root, "ssh-gh-token") });
		await withGithubFetch(async () => {
			await m.call("/api/settings/github-token", {
				token: `ghp_${"c".repeat(36)}`,
			});
			const res = await m.call("/api/git-hosts/github-token", {
				testUrl: "https://github.com/octo/tokened",
			});
			expect(res.status).toBe(200);
			const view = (await res.json()) as HostsView;
			expect(view.tokens).toEqual([
				{ host: "github.com", username: "x-access-token", tokenSet: true },
			]);
		});
	});

	test("a configured enterprise host lands the entry there, also as x-access-token", async () => {
		process.env.OTTR_GITHUB_HOST = "acme.ghe.com";
		// A rewrite for the enterprise host, so the probe stays on the fixture too.
		writeFileSync(
			gitConfigGlobal,
			[
				`[url "file://${fixtureRepos}/ghe"]`,
				"\tinsteadOf = https://acme.ghe.com/octo",
				"",
			].join("\n"),
			{ flag: "a" },
		);
		makeFixture("ghe/tokened");
		const m = mount({ sshDir: join(root, "ssh-gh-token-ghe") });
		// A ghe.com probe hits api.<host>/user; the stub answers it.
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url === "https://api.acme.ghe.com/user")
				return new Response(null, { status: 200 });
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			await m.call("/api/settings/github-token", {
				token: `ghp_${"d".repeat(36)}`,
			});
			const res = await m.call("/api/git-hosts/github-token", {
				testUrl: "https://acme.ghe.com/octo/tokened",
			});
			expect(res.status).toBe(200);
			const view = (await res.json()) as HostsView;
			expect(view.tokens).toEqual([
				{ host: "acme.ghe.com", username: "x-access-token", tokenSet: true },
			]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("400 without a board token or with a testUrl off the host", async () => {
		delete process.env.OTTR_GITHUB_HOST;
		const m = mount({ sshDir: join(root, "ssh-gh-token-none") });
		const none = await m.call("/api/git-hosts/github-token", {
			testUrl: "https://github.com/octo/tokened",
		});
		expect(none.status).toBe(400);
		const noneBody = (await none.json()) as { error: string };
		expect(noneBody.error).toContain("no GitHub token");
		const m2 = mount({ sshDir: join(root, "ssh-gh-token-off") });
		await withGithubFetch(async () => {
			await m2.call("/api/settings/github-token", {
				token: `ghp_${"e".repeat(36)}`,
			});
			const missing = await m2.call("/api/git-hosts/github-token", {});
			expect(missing.status).toBe(400);
			const off = await m2.call("/api/git-hosts/github-token", {
				testUrl: "https://gitlab.com/octo/tokened",
			});
			expect(off.status).toBe(400);
			const offBody = (await off.json()) as { error: string };
			expect(offBody.error).toBe(
				"testUrl must be an https URL on the token's host",
			);
			const view = (await (
				await m2.call("/api/git-hosts")
			).json()) as HostsView;
			expect(view.tokens).toEqual([]);
		});
	});
});

describe("POST /api/settings/github-host", () => {
	const savedEnv = process.env.OTTR_GITHUB_HOST;
	afterAll(() => {
		if (savedEnv === undefined) delete process.env.OTTR_GITHUB_HOST;
		else process.env.OTTR_GITHUB_HOST = savedEnv;
	});

	test("a save names the host in the view, the env and the config row", async () => {
		delete process.env.OTTR_GITHUB_HOST;
		const m = mount({ sshDir: join(root, "ssh-host-save") });
		const res = await m.call("/api/settings/github-host", {
			host: "bmw.ghe.com",
		});
		expect(await res.json()).toEqual({ host: "bmw.ghe.com", expiresAt: null });
		expect((await (await m.call("/api/git-hosts")).json()).githubHost).toBe(
			"bmw.ghe.com",
		);
		expect(String(process.env.OTTR_GITHUB_HOST)).toBe("bmw.ghe.com");
		expect(m.g.get<{ githubHost?: unknown }>("config")?.githubHost).toBe(
			"bmw.ghe.com",
		);
	});

	test("a saved host survives a second boot on the same store", async () => {
		delete process.env.OTTR_GITHUB_HOST;
		const g = GlobalStore.open(
			join(root, "g-host-boot", Math.random().toString(36).slice(2)),
		);
		const m = mount({ gstore: g, sshDir: join(root, "ssh-host-boot") });
		await m.call("/api/settings/github-host", { host: "bmw.ghe.com" });
		const m2 = mount({ gstore: g, sshDir: join(root, "ssh-host-boot") });
		expect((await (await m2.call("/api/git-hosts")).json()).githubHost).toBe(
			"bmw.ghe.com",
		);
	});

	test("a saved host wins over the env; clearing falls back to env, then github.com", async () => {
		process.env.OTTR_GITHUB_HOST = "acme.ghe.com";
		const m = mount({ sshDir: join(root, "ssh-host-clear") });
		await m.call("/api/settings/github-host", { host: "bmw.ghe.com" });
		expect((await (await m.call("/api/git-hosts")).json()).githubHost).toBe(
			"bmw.ghe.com",
		);
		const cleared = (await (
			await m.call("/api/settings/github-host", { host: "  " })
		).json()) as { host: string | null };
		expect(cleared.host).toBe("acme.ghe.com");
		expect((await (await m.call("/api/git-hosts")).json()).githubHost).toBe(
			"acme.ghe.com",
		);
		delete process.env.OTTR_GITHUB_HOST;
		const m2 = mount({ sshDir: join(root, "ssh-host-clear2") });
		const bare = (await (
			await m2.call("/api/settings/github-host", { host: "" })
		).json()) as { host: string | null };
		expect(bare.host).toBe("github.com");
		expect(process.env.OTTR_GITHUB_HOST).toBeUndefined();
	});

	test("an invalid host answers 400 with the parse message and stores nothing", async () => {
		delete process.env.OTTR_GITHUB_HOST;
		const m = mount({ sshDir: join(root, "ssh-host-bad") });
		const res = await m.call("/api/settings/github-host", {
			host: "https://x",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(
			"OTTR_GITHUB_HOST: must hold only letters, digits, dots and hyphens (use a bare hostname, for example github.com or acme.ghe.com)",
		);
		expect((await (await m.call("/api/git-hosts")).json()).githubHost).toBe(
			"github.com",
		);
		expect(
			m.g.get<{ githubHost?: unknown }>("config")?.githubHost,
		).toBeUndefined();
	});

	test("the save's probe follows the new host; the default keeps the github.com URL", async () => {
		delete process.env.OTTR_GITHUB_HOST;
		const m = mount({ sshDir: join(root, "ssh-host-probe") });
		const urls: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input);
			urls.push(url);
			if (url === "https://api.bmw.ghe.com/user")
				return new Response(null, {
					status: 200,
					headers: { "github-authentication-token-expiration": "2027-01-01" },
				});
			if (url === "https://api.github.com/repos/ottr-ai/ottr")
				return new Response(null, {
					status: 200,
					headers: { "github-authentication-token-expiration": "2026-12-01" },
				});
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			await m.call("/api/settings/github-token", {
				token: `ghp_${"e".repeat(36)}`,
			});
			const saved = (await (
				await m.call("/api/settings/github-host", { host: "bmw.ghe.com" })
			).json()) as { host: string; expiresAt: string | null };
			expect(saved.host).toBe("bmw.ghe.com");
			expect(saved.expiresAt).toBe("2027-01-01T00:00:00.000Z");
			expect(urls).toContain("https://api.bmw.ghe.com/user");
			const cleared = (await (
				await m.call("/api/settings/github-host", { host: "" })
			).json()) as { host: string; expiresAt: string | null };
			expect(cleared.host).toBe("github.com");
			expect(cleared.expiresAt).toBe("2026-12-01T00:00:00.000Z");
			expect(urls).toContain("https://api.github.com/repos/ottr-ai/ottr");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("git-host ssh keys", () => {
	test("pending keys are generated server-side, 0600, and never echoed", async () => {
		const f = sshFixture();
		const m = mount({ sshDir: f.dir, keyscan: f.keyscan });
		const gen = await m.call("/api/git-hosts/ssh/pending", {});
		expect(gen.status).toBe(200);
		const g = (await gen.json()) as PendingBody;
		expect(g.id).toMatch(/^[0-9a-f]{32}$/);
		expect(g.publicKey).toContain("ssh-ed25519");
		expect(g.fingerprint).toMatch(/^SHA256:/);
		const file = join(f.dir, "pending", g.id);
		expect(existsSync(file)).toBe(true);
		expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
		expect(await (await m.call("/api/git-hosts")).text()).not.toContain(
			"PRIVATE KEY",
		);
		// A passphrase-protected paste is rejected.
		execSync(
			`ssh-keygen -t ed25519 -N "passphrase" -q -f ${join(f.dir, "locked")}`,
		);
		const bad = await m.call("/api/git-hosts/ssh/pending", {
			privateKey: readFileSync(join(f.dir, "locked"), "utf8"),
		});
		expect(bad.status).toBe(400);
	});

	test("ssh test answers 400 for a non-ssh url and for unknown keys", async () => {
		const m = mount({ sshDir: join(root, "ssh-test") });
		const https = await m.call("/api/git-hosts/ssh/test", {
			url: "https://gitlab.com/g/sub/tokened",
		});
		expect(https.status).toBe(400);
		const badId = await m.call("/api/git-hosts/ssh/test", {
			url: "git@git.example.com:a/scp-repo",
			key: "pending:zzzz",
		});
		expect(badId.status).toBe(400);
		expect(await errorOf(badId)).toBe("no such key");
		const missing = await m.call("/api/git-hosts/ssh/test", {
			url: "git@git.example.com:a/scp-repo",
			key: `pending:${"0".repeat(32)}`,
		});
		expect(missing.status).toBe(400);
		expect(await errorOf(missing)).toBe("no such key");
	});

	test("the global key saves only after a confirmed passing test", async () => {
		makeFixture("scp/globalled");
		const f = sshFixture();
		const m = mount({ sshDir: f.dir, keyscan: f.keyscan });
		const gen = await m.call("/api/git-hosts/ssh/pending", {});
		const pending = (await gen.json()) as PendingBody;
		const sel = {
			pending: `pending:${pending.id}`,
			testUrl: "git@git.example.com:a/globalled",
		};
		const need = await m.call("/api/git-hosts/ssh/global", sel, {
			method: "PUT",
		});
		expect(need.status).toBe(409);
		const trust = (await need.json()) as TrustBody;
		const ok = await m.call(
			"/api/git-hosts/ssh/global",
			{ ...sel, trust: trust.fingerprints },
			{ method: "PUT" },
		);
		expect(ok.status).toBe(200);
		const text = await ok.text();
		expect(text).not.toContain("PRIVATE KEY");
		const key = JSON.parse(text) as KeyBody;
		expect(key.fingerprint).toMatch(/^SHA256:/);
		const hosts = (await (await m.call("/api/git-hosts")).json()) as HostsView;
		expect(hosts.globalKey?.fingerprint).toBe(key.fingerprint);
		const del = await m.call("/api/git-hosts/ssh/global", undefined, {
			method: "DELETE",
		});
		expect(await del.json()).toEqual({ ok: true });
		const after = (await (await m.call("/api/git-hosts")).json()) as HostsView;
		expect(after.globalKey).toBeNull();
	});

	test("project keys answer on their own route and 404 for unknown projects", async () => {
		makeFixture("scp/keyed");
		const f = sshFixture();
		const m = mount({ sshDir: f.dir, keyscan: f.keyscan });
		const proj = await m.call("/api/projects", { name: "keyed" });
		expect(proj.status).toBe(200);
		const none = (await (
			await m.call("/api/projects/keyed/ssh-key")
		).json()) as { own: KeyBody | null };
		expect(none.own).toBeNull();
		const missing = await m.call("/api/projects/nope/ssh-key");
		expect(missing.status).toBe(404);
		const gen = await m.call("/api/git-hosts/ssh/pending", {});
		const pending = (await gen.json()) as PendingBody;
		const sel = {
			pending: `pending:${pending.id}`,
			testUrl: "git@git.example.com:a/keyed",
		};
		const need = await m.call("/api/projects/keyed/ssh-key", sel, {
			method: "PUT",
		});
		expect(need.status).toBe(409);
		const trust = (await need.json()) as TrustBody;
		const ok = await m.call(
			"/api/projects/keyed/ssh-key",
			{ ...sel, trust: trust.fingerprints },
			{ method: "PUT" },
		);
		expect(ok.status).toBe(200);
		const del = await m.call("/api/projects/keyed/ssh-key", undefined, {
			method: "DELETE",
		});
		expect(await del.json()).toEqual({ own: null });
		// Removal falls back to the global choice; no global key here, so no Ottr identity,
		// but the confirmed known_hosts stays strict (never ambient ssh trust).
		const env = networkGitAuth(join(root, "keyed", ".worktrees", "x"));
		expect(env.GIT_SSH_COMMAND).not.toContain(" -i ");
		expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
	});
});

describe("board warnings", () => {
	// omp's auth_credentials as a seeded sign-in writes it (src/login.test.ts builds the same).
	const SCHEMA = `CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY,
		provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL,
		disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)`;

	function credStore(path: string, list: Array<[string, string | null]>): void {
		// A fresh store each call: a later list must not keep an earlier row.
		rmSync(path, { force: true });
		mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path);
		db.exec(SCHEMA);
		const add = db.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, 'oauth', '{}', ?, 1, 1)",
		);
		for (const [provider, cause] of list) add.run(provider, cause);
		add.finalize(); // an unfinalized statement keeps the file open on Windows
		db.close();
	}

	function withAgentDir(
		body: (dir: string) => Promise<void> | void,
	): Promise<void> | void {
		const dir = mkdtempSync(join(tmpdir(), "ottr-warn-agent"));
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		const restore = () => {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
			rmSync(dir, { recursive: true, force: true });
		};
		return Promise.resolve(body(dir)).finally(restore);
	}

	const UNSEEDED =
		'The board\'s agent layer is not seeded: the board runs without rules and config.yml until a seed fills /etc/ottr/home (docs/WORKERS.md, "Seed the board config").';

	// What stateResponse passes: the store's sign-ins ([] when unreadable) and the configured roles.
	function warnings(dir: string, env: Record<string, string | undefined>) {
		let list: SignIn[] = [];
		try {
			list = signIns(join(dir, "agent.db"));
		} catch {
			// A missing store is no sign-in, as in stateResponse.
		}
		return boardWarnings(list, modelRoles(), env);
	}

	test("an empty agent dir warns unseeded, in boardWarnings and in the state payload", async () =>
		withAgentDir(async (dir) => {
			expect(warnings(dir, {})).toEqual([UNSEEDED]);
			const state = (await (await get("/api/state")).json()) as {
				warnings: string[];
			};
			expect(state.warnings).toEqual([UNSEEDED]);
		}));

	test("a seeded dir with a role but no sign-in warns for that provider; an active row silences it", async () =>
		withAgentDir(async (dir) => {
			writeFileSync(
				join(dir, "config.yml"),
				"modelRoles:\n  default: anthropic/claude-opus-5-5:high\n",
			);
			const expected = [
				"No active sign-in for anthropic (role default): sign in under Settings - Provider sign-in, or set its API key in the environment.",
			];
			// A fixed env: the host shell may export the provider's key.
			expect(warnings(dir, {})).toEqual(expected);
			credStore(join(dir, "agent.db"), [["anthropic", null]]);
			expect(warnings(dir, {})).toEqual([]);
			// A signed-out row counts as no active sign-in.
			credStore(join(dir, "agent.db"), [["anthropic", "replaced by"]]);
			expect(warnings(dir, {})).toEqual(expected);
		}));

	test("a disabled sign-in yields one advisory: the dead sign-in, not a board warning too", async () =>
		withAgentDir(async (dir) => {
			writeFileSync(
				join(dir, "config.yml"),
				"modelRoles:\n  default: anthropic/claude-opus-5-5:high\n  smol: zai/glm-5\n",
			);
			credStore(join(dir, "agent.db"), [
				["anthropic", "oauth refresh failed: invalid_grant"],
			]);
			const state = (await (await get("/api/state")).json()) as {
				warnings: string[];
				deadSignIns: Array<{ provider: string }>;
			};
			expect(state.deadSignIns.map((d) => d.provider)).toEqual(["anthropic"]);
			expect(state.warnings.some((w) => w.includes("anthropic"))).toBe(false);
			// The other provider still warns: the skip covers only the dead one.
			expect(warnings(dir, {})).toEqual([
				"No active sign-in for zai (role smol): sign in under Settings - Provider sign-in, or set its API key in the environment.",
			]);
		}));

	test("state names the merges an open release holds", async () => {
		// TaskPatch cannot write createdAt/doneAt, so the finding is marked done for real
		// (its doneAt lands after its createdAt) and the release stays open in merging.
		const finding = store.createTask("release finding");
		store.updateTask(finding.id, {
			followUpOf: null,
			stage: "done",
			state: "idle",
		});
		const release = store.createTask("release v0.3.0");
		store.updateTask(finding.id, { followUpOf: release.id });
		store.updateTask(release.id, {
			releaseVersion: "v0.3.0",
			stage: "merging",
			state: "needs_you",
		});
		const held = store.createTask("held merge");
		store.updateTask(held.id, { stage: "merging", state: "queued" });
		const state = (await (await get("/api/state")).json()) as {
			tasks: Array<{ id: string; heldMerges?: string[] }>;
		};
		const card = state.tasks.find((t) => t.id === release.id);
		// The module store holds queued cards from earlier tests too; this release holds them all.
		expect(card?.heldMerges).toContain(held.id);
		// A held merge is no release: it never carries the link itself.
		expect(
			state.tasks.find((t) => t.id === held.id)?.heldMerges,
		).toBeUndefined();
	});

	test("a release holding merges with every finding done warns past an hour only", async () =>
		withAgentDir(async (dir) => {
			writeFileSync(join(dir, "config.yml"), "modelRoles: {}\n");
			const now = 1_762_000_000_000;
			const card = (
				over: Partial<
					ReviewTask &
						Pick<
							Task,
							"state" | "project" | "stage" | "pushRetries" | "pendingBy"
						>
				>,
			): ReviewTask &
				Pick<
					Task,
					"state" | "project" | "stage" | "pushRetries" | "pendingBy"
				> => ({
				id: "x",
				kind: "work",
				releaseVersion: null,
				cancelledAt: null,
				stage: "todo",
				state: "queued",
				pushRetries: 0,
				pendingBy: null,
				project: "p",
				createdAt: now - 10_000,
				doneAt: null,
				dependsOn: [],
				followUpOf: null,
				...over,
			});
			// A shared shape: the release, its settled finding, and one queued merge.
			const make = (
				findingDoneAt: number | null,
				findingStage: Task["stage"],
			) => {
				const release = card({
					id: "release",
					releaseVersion: "v0.3.0",
					stage: "merging",
					state: "needs_you",
					doneAt: now - 3 * 3_600_000,
				});
				const finding = card({
					id: "finding",
					followUpOf: "release",
					// Filed while the review ran: reviewFindings only counts findings
					// created no later than the review's own doneAt.
					createdAt: now - 4 * 3_600_000,
					stage: findingStage,
					state: "idle",
					doneAt: findingDoneAt,
				});
				const merge = card({ id: "merge", stage: "merging" });
				return [release, finding, merge];
			};
			// Settled two hours ago: past the one-hour window, so the stall warns.
			const settled = boardWarnings(
				[],
				modelRoles(),
				{},
				undefined,
				make(now - 2 * 3_600_000, "done"),
				now,
			);
			expect(
				settled.filter(
					(w) =>
						w.includes("Release v0.3.0") &&
						w.includes("cancel the release card"),
				),
			).toHaveLength(1);
			// Settled half an hour ago: inside the window, no warning yet.
			expect(
				boardWarnings(
					[],
					modelRoles(),
					{},
					undefined,
					make(now - 30 * 60_000, "done"),
					now,
				),
			).toEqual([]);
			// A finding still open may file more work: no warning while it runs.
			const open = card({
				id: "release",
				releaseVersion: "v0.3.0",
				stage: "merging",
				state: "needs_you",
				doneAt: now - 3 * 3_600_000,
			});
			const openFinding = card({
				id: "finding",
				followUpOf: "release",
				createdAt: now - 4 * 3_600_000,
				stage: "todo",
				state: "queued",
			});
			expect(
				boardWarnings(
					[],
					modelRoles(),
					{},
					undefined,
					[open, openFinding, card({ id: "merge", stage: "merging" })],
					now,
				),
			).toEqual([]);
			// Two projects may run the same release version: each warning counts
			// only its own project's held merges, never the other project's.
			const twin = (
				project: string,
			): (ReviewTask &
				Pick<
					Task,
					"state" | "project" | "stage" | "pushRetries" | "pendingBy"
				>)[] => [
				card({
					id: `${project}-release`,
					project,
					releaseVersion: "v0.3.0",
					stage: "merging",
					state: "needs_you",
					doneAt: now - 3 * 3_600_000,
				}),
				card({
					id: `${project}-finding`,
					project,
					followUpOf: `${project}-release`,
					createdAt: now - 4 * 3_600_000,
					stage: "done",
					state: "idle",
					doneAt: now - 2 * 3_600_000,
				}),
				card({ id: `${project}-merge`, project, stage: "merging" }),
			];
			const twins = boardWarnings(
				[],
				modelRoles(),
				{},
				undefined,
				[...twin("a"), ...twin("b")],
				now,
			).filter((w) => w.includes("Release v0.3.0"));
			expect(twins).toHaveLength(2);
			for (const w of twins) expect(w).toContain("holds 1 merge");
		}));
});

describe("worker sign-in warnings", () => {
	// The report shape the tick caches; ids are worker hostnames only — "local" never appears.
	const report = (
		signIns: SignIn[] | null,
		error: string | null = null,
	): { signIns: SignIn[] | null; error: string | null; at: number } => ({
		signIns,
		error,
		at: 1_762_000_000_000,
	});
	const ZAI_ACTIVE: SignIn = {
		provider: "zai",
		kind: "oauth",
		active: true,
		cause: null,
		lent: false,
	};
	const roles = { default: "zai/glm-5:high" };
	const MISSING = (id: string, role = "default") =>
		`Worker ${id} has no active sign-in for zai (role ${role}): the workers' store (OTTR_AGENT_DB) lacks it, the board does not lend this provider, and no env key is set; seed the store from a host db that has the sign-in, or set its API key in the environment.`;
	const UNREADABLE = (id: string, error: string) =>
		`Worker ${id} has no readable credential store (${error}); worker turns keep their own credential, so sign-ins that the board does not lend are missing (OTTR_AGENT_DB; docs/WORKERS.md, Provider sign-in).`;

	test("a worker report without the role's provider warns, once per worker", () => {
		const reports = new Map([
			["worker-a", report([])],
			["worker-b", report([])],
		]);
		expect(workerSignInWarnings(reports, [], roles, {})).toEqual([
			MISSING("worker-a"),
			MISSING("worker-b"),
		]);
		// Two roles on one provider: the first role names it.
		expect(
			workerSignInWarnings(
				new Map([["worker-a", report([])]]),
				[],
				{ default: "zai/glm-5", smol: "zai/glm-4" },
				{},
			),
		).toEqual([MISSING("worker-a")]);
	});

	test("a board sign-in lent for the provider silences it: the lent env token covers worker turns", () => {
		const lentZai: SignIn = {
			provider: "zai",
			kind: "oauth",
			active: true,
			cause: null,
			lent: true,
		};
		expect(
			workerSignInWarnings(
				new Map([["worker-a", report([])]]),
				[lentZai],
				roles,
				{},
			),
		).toEqual([]);
	});

	test("the provider's env key silences it, openai-codex riding the OpenAI key", () => {
		expect(
			workerSignInWarnings(new Map([["worker-a", report([])]]), [], roles, {
				ZAI_API_KEY: "k",
			}),
		).toEqual([]);
		expect(
			workerSignInWarnings(
				new Map([["worker-a", report([])]]),
				[],
				{ default: "openai-codex/gpt-5:high" },
				{ OPENAI_API_KEY: "k" },
			),
		).toEqual([]);
	});

	test("an unreadable worker store gets one warning per worker, naming the error", () => {
		const error = "/mnt/data/agent.db: file is not a database";
		expect(
			workerSignInWarnings(
				new Map([["worker-a", report(null, error)]]),
				[],
				roles,
				{},
			),
		).toEqual([UNREADABLE("worker-a", error)]);
	});

	test("an unknown report (old worker, failed fetch) warns nothing", () => {
		expect(
			workerSignInWarnings(new Map([["worker-a", null]]), [], roles, {}),
		).toEqual([]);
		// No workers configured: an empty cache warns nothing.
		expect(workerSignInWarnings(new Map(), [], roles, {})).toEqual([]);
	});

	test("a worker whose own store has the provider active warns nothing", () => {
		expect(
			workerSignInWarnings(
				new Map([["worker-a", report([ZAI_ACTIVE])]]),
				[],
				roles,
				{},
			),
		).toEqual([]);
		// A disabled row is not active: the provider needs a new sign-in.
		const disabled: SignIn = {
			provider: "zai",
			kind: "oauth",
			active: false,
			cause: "oauth refresh failed: invalid_grant",
			lent: false,
		};
		expect(
			workerSignInWarnings(
				new Map([["worker-a", report([disabled])]]),
				[],
				roles,
				{},
			),
		).toEqual([MISSING("worker-a")]);
	});

	test("only worker runners appear in the map: local never warns, unknown ids stay graceful", () => {
		const out = workerSignInWarnings(
			new Map([["worker-a", report([])]]),
			[],
			roles,
			{},
		);
		expect(out).toEqual([MISSING("worker-a")]);
		expect(out.some((w) => w.includes("local"))).toBe(false);
		// An id no longer in the runner list (a removed worker) still warns as itself.
		expect(
			workerSignInWarnings(
				new Map([["worker-gone", report([])]]),
				[],
				roles,
				{},
			),
		).toEqual([MISSING("worker-gone")]);
		// A role selector without a provider prefix names no provider to check.
		expect(
			workerSignInWarnings(
				new Map([["worker-a", report([])]]),
				[],
				{ default: "claude-opus-5-5" },
				{},
			),
		).toEqual([]);
	});

	test("stateResponse ships the worker warning from the tick's cache", async () => {
		// A stand-in worker the tick can poll, flipping between a report and an unreadable store.
		let answer: { signIns: unknown; error?: string } = { signIns: [] };
		const fakeWorker = Bun.serve({
			port: 0,
			fetch: async (req) => {
				if (new URL(req.url).pathname !== "/signins")
					return new Response("not found", { status: 404 });
				if (req.headers.get("x-otwr-token") !== "tok")
					return new Response("unauthorized", { status: 401 });
				return Response.json(answer);
			},
		});
		// A seeded agent dir with one zai role: the board store stays silent for the worker
		// warnings to stand out, and no host env key can silence them.
		const agentTmp = mkdtempSync(join(tmpdir(), "ottr-worker-warn"));
		writeFileSync(
			join(agentTmp, "config.yml"),
			"modelRoles:\n  default: zai/glm-5:high\n",
		);
		const savedAgent = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentTmp;
		const savedKey = process.env.ZAI_API_KEY;
		delete process.env.ZAI_API_KEY;
		const workerApp = createApp({
			gstore,
			defaultDir: root,
			projects: new Map(),
			...loopStubs(),
			schedule: () => {},
			serverVersion: "test",
			port: 0,
			publicHosts: [],
			shared: {
				maxTotalRuns: 3,
				reviewCheck: true,
				workCheck: true,
				idleReviews: true,
				removedPaths: [],
				envValues: {},
				projectPaths: [],
				projectOrder: [],
			},
			serverRef: { current: undefined },
			workerTarget: {
				urls: [`http://127.0.0.1:${fakeWorker.port}`],
				token: "tok",
			},
		});
		const srv = Bun.serve({ port: 0, ...workerApp.serveOptions });
		workerApp.serverRef.current = srv;
		mounted.push(srv);
		const state = async () =>
			(await (
				await fetch(new URL("/api/state", srv.url), {
					headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
				})
			).json()) as { warnings: string[] };
		try {
			await workerApp.workerSignInTick();
			let warnings = (await state()).warnings;
			expect(warnings).toContain(MISSING("127.0.0.1"));
			// An unreadable store (the OTTR-548 symptom): the single store warning replaces
			// the per-provider one.
			const error = `${agentTmp}/agent.db: file is not a database`;
			answer = { signIns: null, error };
			await workerApp.workerSignInTick();
			warnings = (await state()).warnings;
			expect(warnings).toContain(UNREADABLE("127.0.0.1", error));
			expect(
				warnings.some((w) =>
					w.startsWith("Worker 127.0.0.1 has no active sign-in"),
				),
			).toBe(false);
		} finally {
			fakeWorker.stop(true);
			if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedAgent;
			if (savedKey === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = savedKey;
			rmSync(agentTmp, { recursive: true, force: true });
		}
	});
});

describe("token expiry reminders", () => {
	// Pinned board omp home: token-reminders.json and seed-token-expires land in home/.
	const home = mkdtempSync(join(tmpdir(), "ottr-expiry-"));
	const savedOmp = process.env.OTTR_BOARD_OMP_HOME;
	process.env.OTTR_BOARD_OMP_HOME = join(home, "omp-home");
	const remindersFile = join(home, "token-reminders.json");
	const seedFile = join(home, "seed-token-expires");
	// A seeded agent dir with no roles: warnings are exactly the token ones, never the
	// unseeded early return or provider noise from the host's real ~/.omp/agent.
	const agentTmp = join(home, "agent");
	mkdirSync(agentTmp, { recursive: true });
	writeFileSync(join(agentTmp, "config.yml"), "modelRoles: {}\n");
	const savedAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentTmp;

	const g = GlobalStore.open(join(root, "g-expiry"));
	const TOKEN = `ghp_${"c".repeat(36)}`;
	const EXP = "2026-10-31T00:00:00.000Z";
	let probeExpiry: string | null = null;
	let probeFail = false;
	const boot = () =>
		createApp({
			gstore: g,
			defaultDir: root,
			projects: new Map(),
			...loopStubs(),
			schedule: () => {},
			serverVersion: "test",
			port: 0,
			publicHosts: [],
			shared: {
				maxTotalRuns: 3,
				reviewCheck: true,
				workCheck: true,
				idleReviews: true,
				removedPaths: [],
				envValues: {},
				projectPaths: [],
				projectOrder: [],
			},
			serverRef: { current: undefined },
			githubTokenExpiry: async () => {
				if (probeFail) throw new Error("probe down");
				return probeExpiry;
			},
		});
	const served = boot();
	const srv = Bun.serve({ port: 0, ...served.serveOptions });
	served.serverRef.current = srv;
	mounted.push(srv);
	mountStores.push(g);
	const call = (path: string, body?: unknown) =>
		fetch(new URL(path, srv.url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const sub = {
		endpoint: "https://push.test/expiry",
		keys: { p256dh: "k", auth: "a" },
		addedAt: 0,
	};
	// Fake calendar: day n of October 2026, so daysLeft against Oct 31 is 31 - n.
	const dayAt = (n: number) => new Date(Date.UTC(2026, 9, n, 12));
	const BOARD_RENEW =
		"Renew it at https://github.com/settings/personal-access-tokens.";
	const tokenWarnings = (): string[] =>
		boardWarnings(
			[],
			{},
			{
				GH_TOKEN: TOKEN,
				OTTR_BOARD_OMP_HOME: join(home, "omp-home"),
			},
		).filter((w) => w.includes("GitHub token"));
	afterAll(() => {
		srv.stop(true);
		setSystemTime();
		delete process.env.GH_TOKEN;
		if (savedOmp === undefined) delete process.env.OTTR_BOARD_OMP_HOME;
		else process.env.OTTR_BOARD_OMP_HOME = savedOmp;
		if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgent;
		rmSync(home, { recursive: true, force: true });
	});

	test("POST probes at once and the GET answers the new shape; the 30-day push fires once per day", async () => {
		setSystemTime(dayAt(1));
		probeExpiry = EXP;
		const save = await call("/api/settings/github-token", { token: TOKEN });
		expect(save.status).toBe(200);
		expect(await save.json()).toEqual({ tokenSet: true, expiresAt: EXP });
		expect(await (await call("/api/settings/github-token")).json()).toEqual({
			tokenSet: true,
			expiresAt: EXP,
		});
		pushSends.length = 0;
		saveSubs(g, [sub]);
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(1);
		expect(JSON.parse(pushSends[0]!.payload)).toEqual({
			title: "Ottr",
			body: `The board's GitHub token expires on 2026-10-31 (in 30 days). ${BOARD_RENEW}`,
			tag: "token-expiry",
			url: "/",
		});
		// No second push on the same day.
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(1);
	});

	test("days 29..15 stay silent; 14 down to 0 push once per UTC day", async () => {
		const base = pushSends.length;
		for (let n = 2; n <= 16; n++) {
			setSystemTime(dayAt(n));
			await served.tokenReminderTick();
			expect(pushSends.length).toBe(base);
		}
		for (let n = 17; n <= 31; n++) {
			setSystemTime(dayAt(n));
			await served.tokenReminderTick();
			expect(pushSends.length).toBe(base + 1 + (n - 17));
		}
		// The last attempt is recorded, so the same day stays quiet.
		setSystemTime(dayAt(31));
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(base + 15);
	});

	test("a token with no expiry never pushes and never warns", async () => {
		setSystemTime(dayAt(20));
		probeExpiry = null;
		await call("/api/settings/github-token", { token: TOKEN });
		pushSends.length = 0;
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(0);
		expect(tokenWarnings().length).toBe(0);
	});

	test("a failed probe keeps the stored value", async () => {
		probeExpiry = EXP;
		await call("/api/settings/github-token", { token: TOKEN });
		probeFail = true;
		pushSends.length = 0;
		await served.tokenReminderTick();
		probeFail = false;
		expect(await (await call("/api/settings/github-token")).json()).toEqual({
			tokenSet: true,
			expiresAt: EXP,
		});
		const kept = JSON.parse(readFileSync(remindersFile, "utf8")) as {
			board: { expiresAt: string | null };
		};
		expect(kept.board.expiresAt).toBe(EXP);
	});

	test("the default probe keeps the stored value on a 401", async () => {
		writeFileSync(
			remindersFile,
			JSON.stringify({
				board: { expiresAt: EXP, lastPushDay: null },
				seed: { expiresAt: null, lastPushDay: null },
			}),
		);
		// mount() injects no githubTokenExpiry, so the POST runs the default probe;
		// an expired token makes GitHub answer 401 without the expiration header.
		const m = mount();
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url === "https://api.github.com/repos/ottr-ai/ottr")
				return new Response(null, { status: 401 });
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			const save = await m.call("/api/settings/github-token", { token: TOKEN });
			expect(await save.json()).toEqual({ tokenSet: true, expiresAt: EXP });
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(await (await m.call("/api/settings/github-token")).json()).toEqual({
			tokenSet: true,
			expiresAt: EXP,
		});
	});

	test("on another host the default probe calls <apiBase>/user, never api.github.com", async () => {
		const savedHost = process.env.OTTR_GITHUB_HOST;
		process.env.OTTR_GITHUB_HOST = "acme.ghe.com";
		writeFileSync(
			remindersFile,
			JSON.stringify({
				board: { expiresAt: EXP, lastPushDay: null },
				seed: { expiresAt: null, lastPushDay: null },
			}),
		);
		const m = mount();
		const urls: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input);
			urls.push(url);
			// Only the probe answers here; the board's own HTTP stays on the real fetch.
			if (url === "https://api.acme.ghe.com/user")
				return new Response(null, { status: 401 });
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			const save = await m.call("/api/settings/github-token", { token: TOKEN });
			expect(await save.json()).toEqual({ tokenSet: true, expiresAt: EXP });
		} finally {
			globalThis.fetch = realFetch;
			if (savedHost === undefined) delete process.env.OTTR_GITHUB_HOST;
			else process.env.OTTR_GITHUB_HOST = savedHost;
		}
		expect(urls).toContain("https://api.acme.ghe.com/user");
		expect(urls.some((u) => u.startsWith("https://api.github.com"))).toBe(
			false,
		);
	});

	test("an expired token warns with the effect text and no push", async () => {
		setSystemTime(dayAt(5));
		probeExpiry = "2026-09-01T00:00:00.000Z";
		await call("/api/settings/github-token", { token: TOKEN });
		pushSends.length = 0;
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(0);
		expect(tokenWarnings()).toEqual([
			`The board's GitHub token expired on 2026-09-01. GitHub calls from the board fail. ${BOARD_RENEW}`,
		]);
	});

	test("a renewed token stops the old reminders and starts a new schedule", async () => {
		setSystemTime(dayAt(20));
		probeExpiry = EXP;
		await served.tokenReminderTick(); // 11 days left: pushes once
		const afterOld = pushSends.length;
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(afterOld); // throttled for today
		// Renewal: the old date's reminders stop (stateless), and the new schedule runs
		// on the new date — quiet until its 30-day point, even though today pushed already.
		probeExpiry = "2027-01-30T00:00:00.000Z";
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(afterOld);
		expect(tokenWarnings()).toEqual([]);
		setSystemTime(new Date(Date.UTC(2026, 11, 31, 12))); // 30 days before 2027-01-30
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(afterOld + 1);
		expect(pushSends[pushSends.length - 1]!.payload).toContain(
			"expires on 2027-01-30 (in 30 days)",
		);
	});

	test("the seed token pushes and warns from seed-token-expires; 'none' means no expiry", async () => {
		// Quiet the board token for this test.
		probeExpiry = null;
		await call("/api/settings/github-token", { token: TOKEN });
		writeFileSync(seedFile, EXP);
		setSystemTime(dayAt(1));
		// A stored date differing from the fresh one resets the seed's day throttle.
		writeFileSync(
			remindersFile,
			JSON.stringify({
				board: { expiresAt: null, lastPushDay: "2026-10-01" },
				seed: { expiresAt: null, lastPushDay: "2026-10-01" },
			}),
		);
		pushSends.length = 0;
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(1);
		expect(JSON.parse(pushSends[0]!.payload)).toEqual({
			title: "Ottr",
			body: `The board seed token expires on 2026-10-31 (in 30 days). ${BOARD_RENEW}`,
			tag: "token-expiry",
			url: "/",
		});
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(1);
		// "none" refreshes to null: no push, no warning.
		writeFileSync(seedFile, "none");
		writeFileSync(
			remindersFile,
			JSON.stringify({
				board: JSON.parse(readFileSync(remindersFile, "utf8")).board,
				seed: { expiresAt: EXP, lastPushDay: null },
			}),
		);
		setSystemTime(dayAt(2));
		await served.tokenReminderTick();
		expect(pushSends.length).toBe(1);
	});

	test("seedView carries seed.expiresAt through /api/model-roles", async () => {
		// A minimal fake alate: /api/state answers the source, other paths answer
		// the config.yml file load that readConfigYml performs.
		const fake = Bun.serve({
			port: 0,
			fetch: (req) => {
				const u = new URL(req.url);
				if (u.pathname === "/api/state")
					return Response.json({
						source: {
							kind: "repo",
							name: "o/data",
							importedSha: "a".repeat(40),
						},
					});
				return Response.json({
					path: u.searchParams.get("path"),
					content: "modelRoles:\n  default: zai/glm-5.3-flash:max\n",
					hash: "h",
				});
			},
		});
		mounted.push(fake);
		mountStores.push(g);
		const linked = await call("/api/alate", { url: fake.url.origin, key: "k" });
		expect(linked.status).toBe(200);
		writeFileSync(seedFile, EXP);
		const withDate = (await (await call("/api/model-roles")).json()) as {
			seed: { expiresAt: string | null };
		};
		expect(withDate.seed.expiresAt).toBe(EXP);
		writeFileSync(seedFile, "none");
		const withNone = (await (await call("/api/model-roles")).json()) as {
			seed: { expiresAt: string | null };
		};
		expect(withNone.seed.expiresAt).toBeNull();
		fake.stop(true);
	});
});

describe("behindMain", () => {
	// Fixtures come from execSync here, never from the code under test.
	const run = (cmd: string, cwd: string) =>
		execSync(cmd, { cwd, stdio: "ignore" });
	const setup = () => {
		const origin = makeFixture(`behind-${Math.random().toString(36).slice(2)}`);
		const clone = mkdtempSync(join(tmpdir(), "ottr-behind-"));
		run(`git clone -q "${origin}" .`, clone);
		run('git commit -q --allow-empty -m "feat: newer"', origin);
		return clone;
	};
	const none = { behind: 0, commits: [] };

	test("a checkout on main sees the commits origin/main has", async () => {
		expect(await behindMain(setup())).toEqual({
			behind: 1,
			commits: ["feat: newer"],
		});
	});

	test("a release tag, another branch or a folder without git sees no update", async () => {
		const tag = setup();
		run("git checkout -q --detach", tag);
		const branch = setup();
		run("git switch -q -c feature", branch);
		expect(await behindMain(tag)).toEqual(none);
		expect(await behindMain(branch)).toEqual(none);
		expect(
			await behindMain(mkdtempSync(join(tmpdir(), "ottr-nogit-"))),
		).toEqual(none);
	});
});

describe("fixed-path view routes (OTTR-405)", () => {
	test("serve the same board HTML; /api keeps JSON; deeper unknown paths 404", async () => {
		const root = await get("/");
		expect(root.status).toBe(200);
		expect(root.headers.get("content-type")).toContain("text/html");
		const html = await root.text();
		for (const path of [
			"/projects/ottr",
			"/projects/ottr/tasks/OTTR-1",
			"/settings",
			"/settings/ottr",
		]) {
			const res = await get(path);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			expect(await res.text()).toBe(html);
		}
		// Static /api routes still win over the :param view routes.
		const api = await get("/api/boot");
		expect(api.status).toBe(200);
		expect(api.headers.get("content-type")).toContain("application/json");
		expect((await get("/api/projects/nope/how-it-works")).status).toBe(404);
		// One segment past a known view is still unknown.
		expect((await get("/projects/ottr/tasks/OTTR-1/extra")).status).toBe(404);
	});
});

describe("project order route", () => {
	// Own names: earlier describes add and delete "p2"/"p3" on the shared map, so
	// these tests register their own entries and clean them up after themselves.
	const orderDirs = ["ord-a", "ord-b", "ord-c"].map((name) => ({
		name,
		dir: join(root, name),
	}));
	beforeAll(() => {
		for (const { name, dir } of orderDirs)
			projects.set(name, {
				path: dir,
				name,
				store: ProjectStore.open(dir),
				target: null,
				gitless: false,
				github: null,
				remote: null,
				dirty: false,
				mainUnpushed: false,
				mainBranch: null,
				latestRelease: null,
				latestImage: null,
				archReview: null,
			});
	});
	afterAll(() => {
		for (const { name } of orderDirs) {
			projects.get(name)?.store.close();
			projects.delete(name);
		}
		shared.projectOrder = [];
	});
	const stateProjects = async (): Promise<string[]> => {
		const res = await get("/api/state");
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		if (typeof b !== "object" || b === null || !("projects" in b)) {
			throw new Error("state response without projects");
		}
		const projects = b.projects as { name: unknown }[];
		return projects.map((p) => String(p.name));
	};
	/** The named projects in state order: other describes leave entries on the shared map, so exact lists would be fragile. */
	const picked = async (...names: string[]): Promise<string[]> =>
		(await stateProjects()).filter((n) => names.includes(n));
	const four = ["p1", "ord-a", "ord-b", "ord-c"];

	test("a full order sorts /api/state projects", async () => {
		shared.projectOrder = [];
		const res = await post("/api/projects/order", {
			order: ["ord-c", "ord-a", "ord-b"],
		});
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		expect(b).toEqual({ ok: true });
		// "p1" stays registered at the module level and is not named in the order;
		// the merged order appends it last.
		expect(await picked(...four)).toEqual(["ord-c", "ord-a", "ord-b", "p1"]);
		expect(calls).toBeGreaterThan(0);
	});

	test("order must be an array of strings", async () => {
		const missing = await post("/api/projects/order", {});
		expect(missing.status).toBe(400);
		expect(await errorOf(missing)).toBe(
			"order must be an array of project names",
		);
		const notArray = await post("/api/projects/order", { order: "p1" });
		expect(notArray.status).toBe(400);
		expect(await errorOf(notArray)).toBe(
			"order must be an array of project names",
		);
		const notString = await post("/api/projects/order", {
			order: ["ord-a", 3],
		});
		expect(notString.status).toBe(400);
		expect(await errorOf(notString)).toBe(
			"order must be an array of project names",
		);
	});

	test("duplicate and unknown names are rejected", async () => {
		const dup = await post("/api/projects/order", {
			order: ["ord-a", "ord-a", "ord-b"],
		});
		expect(dup.status).toBe(400);
		expect(await errorOf(dup)).toBe("order has duplicate names");
		const unknown = await post("/api/projects/order", {
			order: ["ord-a", "nope"],
		});
		expect(unknown.status).toBe(400);
		expect(await errorOf(unknown)).toBe("unknown project: nope");
	});

	test("a partial order appends missing names in map order", async () => {
		const res = await post("/api/projects/order", { order: ["ord-b"] });
		expect(res.status).toBe(200);
		// Map order: p1 first (module level), then the three beforeAll entries.
		expect(await picked(...four)).toEqual(["ord-b", "p1", "ord-a", "ord-c"]);
	});

	test("the merged order persists in the config kv", async () => {
		await post("/api/projects/order", { order: ["ord-b", "ord-c"] });
		expect(
			storedProjectPaths(gstore).projectOrder.filter((n) => four.includes(n)),
		).toEqual(["ord-b", "ord-c", "p1", "ord-a"]);
	});
	// Permutations and the append rule are property-tested at the unit level
	// (src/projectOrder.test.ts); these HTTP examples pin the route wiring.
});

describe("git 401/403 GitHub hint", () => {
	// A TLS fake git server: every clone/ls-remote against it dies with git's bare
	// "returned error: 403", which the hint path must explain via GitHub's REST API.
	const tlsDir = mkdtempSync(join(tmpdir(), "app-tls-"));
	execSync(
		`openssl req -x509 -newkey rsa:2048 -keyout ${join(tlsDir, "key.pem")} -out ${join(tlsDir, "cert.pem")} -days 1 -nodes -subj "/CN=localhost"`,
	);
	const tls = Bun.serve({
		port: 0,
		tls: {
			cert: readFileSync(join(tlsDir, "cert.pem")),
			key: readFileSync(join(tlsDir, "key.pem")),
		},
		fetch: (req) =>
			new URL(req.url).pathname.endsWith("/info/refs")
				? new Response("blocked", { status: 403 })
				: new Response("nope", { status: 404 }),
	});
	const tlsPort = tls.port;
	const SAML_HINT =
		"Resource protected by organization SAML enforcement. You must grant your Personal Access token access to an organization that has SAML SSO enabled.";
	const DOCS = "https://docs.github.com/en/authentication/troubleshooting-saml";
	const url = `https://localhost:${tlsPort}/org/repo.git`;
	const saved = {
		GIT_SSL_NO_VERIFY: process.env.GIT_SSL_NO_VERIFY,
		OTTR_GITHUB_HOST: process.env.OTTR_GITHUB_HOST,
		GH_TOKEN: process.env.GH_TOKEN,
	};
	// beforeAll, never describe-body level: body-level writes run at file load and leak
	// into every sibling describe (their hosts and PR URLs come out on localhost), and a
	// sibling's afterAll restore would clobber them before these tests run.
	beforeAll(() => {
		process.env.GIT_SSL_NO_VERIFY = "1";
		process.env.OTTR_GITHUB_HOST = "localhost";
		process.env.GH_TOKEN = "ghs_hinttoken000000001";
	});
	afterAll(() => {
		tls.stop(true);
		if (saved.GIT_SSL_NO_VERIFY === undefined)
			delete process.env.GIT_SSL_NO_VERIFY;
		else process.env.GIT_SSL_NO_VERIFY = saved.GIT_SSL_NO_VERIFY;
		if (saved.OTTR_GITHUB_HOST === undefined)
			delete process.env.OTTR_GITHUB_HOST;
		else process.env.OTTR_GITHUB_HOST = saved.OTTR_GITHUB_HOST;
		if (saved.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = saved.GH_TOKEN;
		rmSync(tlsDir, { recursive: true, force: true });
	});

	/** One app per test: own global store and default dir, plus the probe seam. */
	const boot = (
		githubAuthProbe: Parameters<typeof createApp>[0]["githubAuthProbe"],
	) => {
		const i = mounted.length;
		const g = GlobalStore.open(join(root, `g-hint-${i}`));
		mountStores.push(g);
		const m = mount({
			gstore: g,
			defaultDir: join(root, `hint-dir-${i}`),
			githubAuthProbe,
		});
		mkdirSync(join(root, `hint-dir-${i}`), { recursive: true });
		return m;
	};

	test("a clone's bare 403 carries the SAML message from the REST probe", async () => {
		const probeCalls: { url: string; init?: RequestInit }[] = [];
		const m = boot({
			fetchImpl: async (u, init) => {
				probeCalls.push({ url: String(u), init });
				return new Response(
					JSON.stringify({ message: SAML_HINT, documentation_url: DOCS }),
					{ status: 403 },
				);
			},
		});
		const res = await m.call("/api/projects", { url });
		expect(res.status).toBe(400);
		const b = (await res.json()) as {
			error: string;
			needsToken?: string;
		};
		expect(b.error).toContain("git clone failed");
		expect(b.error).toContain("The requested URL returned error: 403");
		expect(b.error).toContain(SAML_HINT);
		expect(b.error).not.toContain("ghs_hinttoken000000001");
		expect(b.needsToken).toBe(`localhost:${tlsPort}`);
		expect(probeCalls).toHaveLength(1);
		expect(probeCalls[0]?.url).toContain("/repos/org/repo");
		expect(
			(probeCalls[0]?.init?.headers as Record<string, string>)?.Authorization,
		).toBe("Bearer ghs_hinttoken000000001");
	});

	test("a probe that cannot answer in time leaves the bare git error", async () => {
		const m = boot({
			fetchImpl: () => new Promise<Response>(() => {}),
			timeoutMs: 50,
		});
		const res = await m.call("/api/projects", { url });
		expect(res.status).toBe(400);
		const b = (await res.json()) as { error: string };
		expect(b.error).toContain("The requested URL returned error: 403");
		expect(b.error).not.toContain("GitHub:");
		expect(b.error).not.toContain("SAML");
	});

	test("the token test's bare 403 carries the SAML hint without echoing the token", async () => {
		const m = boot({
			fetchImpl: async () =>
				new Response(
					JSON.stringify({ message: SAML_HINT, documentation_url: DOCS }),
					{ status: 403 },
				),
		});
		const res = await m.call("/api/git-hosts/tokens", {
			host: `localhost:${tlsPort}`,
			username: "oauth2",
			token: "ghp_candtoken123456",
			testUrl: url,
		});
		expect(res.status).toBe(400);
		const b = (await res.json()) as { error: string };
		expect(b.error).toContain(SAML_HINT);
		expect(b.error).not.toContain("ghp_candtoken123456");
	});
});

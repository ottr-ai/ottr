import { Database } from "bun:sqlite";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	type Mock,
	mock,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { execSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import { boardWarnings, type Entry } from "./app.ts";
import { hashPassword } from "./auth.ts";
import type { GhFn } from "./forks.ts";
import { defaultSshDir, GIT_URL_ERROR, type Keyscan } from "./gitHosts.ts";
import { GlobalStore } from "./globalStore.ts";
import { MAX_IMAGE_BYTES } from "./images.ts";
import {
	ARCH_REVIEW_MARKER,
	BOARD_CHECK_PROMPT,
	FORK_PROPOSED_REASON_PREFIX,
	forkProposedReason,
	RETRO_MARKER,
	RULES_INTERVIEW_MARKER,
} from "./prompts.ts";
import { ProjectStore } from "./store.ts";
import {
	cancelKeptReason,
	FORK_HOLD_REASON,
	UPDATE_HOLD_REASON,
} from "./turn.ts";
import type { AddProjectResponse, Task } from "./types.ts";
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
const { createApp, SILENT_LOG_MS } = await import("./app.ts");

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
});

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
	removedPaths: [] as string[],
	projectPaths: [] as string[],
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
const app = createApp({
	gstore,
	defaultDir: root,
	// Server-only ssh state for the git-hosts routes; a root subdir, not a project checkout.
	sshDir: join(root, "ssh"),
	// env.txt name lists for the Settings env routes; a root subdir provisioned below.
	workersHome: root,
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
		sshDir?: string;
		keyscan?: Keyscan;
		models?: Parameters<typeof createApp>[0]["models"];
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
		schedule: () => {},
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared: {
			maxTotalRuns: 3,
			reviewCheck: true,
			workCheck: true,
			removedPaths: [],
			envValues: {},
			projectPaths: [],
		},
		defaultDir: input.defaultDir ?? root,
		gh: input.gh,
		sshDir: input.sshDir,
		keyscan: input.keyscan,
		models: input.models,
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

	test("drawer detail of a card whose worktree is gone lists no files", async () => {
		// A merged card keeps its worktree path after the merge turn removed the directory.
		const t = store.createTask("merged earlier");
		store.updateTask(t.id, {
			stage: "done",
			state: "idle",
			worktree: join(root, "removed-after-merge"),
		});
		const detail = await get(`/api/projects/p1/tasks/${t.id}`);
		expect(detail.status).toBe(200);
		const b = (await detail.json()) as { worktreeFiles?: string[] };
		expect(b.worktreeFiles).toEqual([]);
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

	test("state cards omit details and report", async () => {
		const t = store.createTask("card shape");
		store.updateTask(t.id, { details: "secret", report: "finding" });
		const res = await get("/api/state");
		const b: unknown = await res.json();
		if (typeof b !== "object" || b === null || !("tasks" in b)) {
			expect.unreachable("state response missing tasks");
		}
		const { tasks } = b as { tasks: unknown };
		const cards = Array.isArray(tasks) ? tasks : [];
		const card = cards.find(
			(c) => typeof c === "object" && c !== null && "id" in c && c.id === t.id,
		);
		if (typeof card !== "object" || card === null) {
			expect.unreachable("card for created task missing");
		}
		expect(card).not.toHaveProperty("details");
		expect(card).not.toHaveProperty("report");
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
		});
		expect(shared.reviewCheck).toBe(false);
	});

	test("empty settings body is a valid no-op", async () => {
		const before = {
			maxTotal: shared.maxTotalRuns,
			reviewCheck: shared.reviewCheck,
			workCheck: shared.workCheck,
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
		});
		expect(shared.workCheck).toBe(false);
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

		test("a reply on a parked update card approves the merge hold; other replies do not", async () => {
			const p1 = projects.get("p1")!;
			const held = p1.store.createTask("update pins");
			p1.store.updateTask(held.id, {
				updateIds: ["x@1"],
				needsReason: UPDATE_HOLD_REASON,
				state: "needs_you",
			});
			const res = await post(`/api/projects/p1/tasks/${held.id}/reply`, {
				text: "approved",
			});
			expect(res.status).toBe(200);
			expect(p1.store.getTask(held.id)!.updateMergeApproved).toBe(true);
			// Control: a needs_you card with any other reason keeps the column false.
			const control = p1.store.createTask("other question");
			p1.store.updateTask(control.id, {
				needsReason: "something else",
				state: "needs_you",
			});
			const cres = await post(`/api/projects/p1/tasks/${control.id}/reply`, {
				text: "answered",
			});
			expect(cres.status).toBe(200);
			expect(p1.store.getTask(control.id)!.updateMergeApproved).toBe(false);
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
});

describe("alate provision trigger (U9)", () => {
	// Fake provider: /health reports a mutable pending flag; /provision flips it like the
	// real server and can be told to fail.
	let pending = true;
	let running = false;
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
			return Response.json({ ok: true, pending, running });
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

	test("does not provision while a turn runs", async () => {
		pending = true; // a new import arrived
		const t = tickStore.createTask("busy");
		tickStore.updateTask(t.id, { state: "running" });
		await m.app.alateProvisionTick();
		expect(provisions).toBe(1);
		tickStore.updateTask(t.id, { state: "idle" });
	});

	test("a provision already running on alate defers the trigger", async () => {
		// alate single-flights provisions: a run still executing there (its board-side
		// wait may have timed out) must not be re-triggered into a 409 that would be
		// recorded as a failure.
		running = true;
		await m.app.alateProvisionTick();
		expect(provisions).toBe(1);
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
		expect(provisions).toBe(2);
	});

	test("waits an hour after a failure and shows the error", async () => {
		provisionStatus = 500;
		pending = true; // the timed-out attempt above consumed the earlier import
		await m.app.alateProvisionTick();
		expect(provisions).toBe(3);
		const v = (await (await m.call("/api/alate")).json()) as {
			lastProvisionError: string | null;
		};
		expect(v.lastProvisionError).toBe("nope");
		// Backoff: pending is still true and the board is idle, yet no retry happens.
		await m.app.alateProvisionTick();
		expect(provisions).toBe(3);
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
		const t = tickStore.createTask("busy again");
		tickStore.updateTask(t.id, { state: "running" });
		await m.app.alateProvisionTick();
		expect(provisions).toBe(4); // gated: no provision attempt
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
	// gh api calls; `pending` holds the tree content until the ref moves.
	let ghCalls: string[][] = [];
	let pending: { content: string; parent: string } | null = null;
	const reset = () => {
		head = snapshot = ORIGINAL;
		headSha = snapSha = BASE;
		afterImport = null;
		afterRefMove = null;
		alateReqs = [];
		ghCalls = [];
		pending = null;
	};
	const source = () => ({
		kind: "repo",
		spec: "o/data",
		name: "o/data",
		ref: "main",
		importedSha: snapSha,
	});
	const fake = Bun.serve({
		port: 0,
		fetch: (req) => {
			const u = new URL(req.url);
			alateReqs.push({
				method: req.method,
				url: u.pathname + u.search,
				auth: req.headers.get("authorization"),
			});
			if (u.pathname === "/health")
				return Response.json({ ok: true, running: false, repo: "o/data" });
			if (u.pathname === "/api/state")
				return Response.json({ source: source() });
			if (u.pathname === "/api/import") {
				snapshot = head;
				snapSha = headSha;
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
			signIns: unknown[];
			seed: { needed: boolean };
		};
		expect(b.base).toBe(BASE);
		expect(b.hash).toBe(sha(ORIGINAL));
		expect(Object.entries(b.roles)).toEqual([
			["default", "zai/glm-5.3-flash:max"],
			["slow", "anthropic/claude-opus-5-5:medium"],
		]);
		expect(Array.isArray(b.signIns)).toBe(true);
		expect(typeof b.seed.needed).toBe("boolean");
		expect(alateReqs.map((r) => `${r.method} ${r.url} ${r.auth}`)).toEqual([
			"GET /api/state Bearer roles_secret",
			"GET /api/file?path=user%2Fomp%2Fagent%2Fconfig.yml Bearer roles_secret",
		]);
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
				removedPaths: [],
				envValues: {},
				projectPaths: [],
			},
			serverRef: { current: undefined },
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
	// The backend flip edits ~/.omp/agent/config.yml: point HOME at a stand-in so the
	// tests never touch the developer's own omp config.
	const savedHome = process.env.HOME;
	const flipHome = mkdtempSync(join(tmpdir(), "ottr-hindsight-home"));
	mkdirSync(join(flipHome, ".omp", "agent"), { recursive: true });
	const flipCfg = join(flipHome, ".omp", "agent", "config.yml");
	beforeAll(() => {
		process.env.HOME = flipHome;
		writeFileSync(flipCfg, "memory:\n  backend: mnemopi\n");
	});
	afterAll(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
	});
	// A getter: after an assignment, TypeScript narrows a direct read for good.
	const token = (): string | undefined => process.env.HINDSIGHT_API_TOKEN;
	const set = (t: string) => post("/api/settings/hindsight", { token: t });
	// A restarted server: a fresh app on the same store.
	const boot = () =>
		createApp({
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
				removedPaths: [],
				envValues: {},
				projectPaths: [],
			},
			serverRef: { current: undefined },
		});

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
		});
		expect(token()).toBe("key-two");
		// A restarted server starts from the env file's seed again; the stored URL wins.
		process.env.HINDSIGHT_API_URL = otherUrl;
		boot();
		expect(envUrl()).toBe(firstUrl);
		expect(token()).toBe("key-two");
	});

	test("a saved URL alone switches omp's memory backend, like the env seed does at container start", async () => {
		const standIn = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 200 }),
		});
		const standInUrl = `http://127.0.0.1:${standIn.port}`;
		try {
			// A stack whose env seed is empty: only the store's saved URL is in effect.
			expect(
				(
					await post("/api/settings/hindsight", {
						url: standInUrl,
						token: "key-nine",
					})
				).status,
			).toBe(200);
			// Reset the flip target: the save above already switched it once.
			writeFileSync(flipCfg, "memory:\n  backend: mnemopi\n");
			delete process.env.HINDSIGHT_API_URL;
			boot();
			// The saved URL beats the (deleted) env seed and flips the shared config.
			expect(await (await get("/api/settings/hindsight")).json()).toEqual({
				url: standInUrl,
				tokenSet: true,
			});
			expect(readFileSync(flipCfg, "utf8")).toContain("backend: hindsight");
			// Idempotent: a boot with the backend already switched keeps it switched.
			boot();
			expect(readFileSync(flipCfg, "utf8")).toContain("backend: hindsight");
		} finally {
			standIn.stop(true);
		}
	});

	test("the flip reaches the board's pinned agent config too, not only the workers' shared one", async () => {
		const standIn = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 200 }),
		});
		// R5-1: compose runs the board's omp against a pinned agent dir; its config.yml is
		// a second file, and both copies must flip (workers read the shared one).
		const pinnedDir = mkdtempSync(join(tmpdir(), "ottr-hindsight-pinned"));
		const pinnedCfg = join(pinnedDir, "config.yml");
		const savedPin = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = pinnedDir;
		try {
			writeFileSync(pinnedCfg, "memory:\n  backend: mnemopi\n");
			writeFileSync(flipCfg, "memory:\n  backend: mnemopi\n");
			expect(
				(
					await post("/api/settings/hindsight", {
						url: `http://127.0.0.1:${standIn.port}`,
						token: "key-ten",
					})
				).status,
			).toBe(200);
			expect(readFileSync(pinnedCfg, "utf8")).toContain("backend: hindsight");
			expect(readFileSync(flipCfg, "utf8")).toContain("backend: hindsight");
		} finally {
			standIn.stop(true);
			if (savedPin === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedPin;
			rmSync(pinnedDir, { recursive: true, force: true });
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
			removedPaths: [],
			envValues: {},
			projectPaths: [],
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
	test("carries the provider list omp's /login offers, next to the stored sign-ins", async () => {
		const m = mount({});
		const res = await m.call("/api/provider-login");
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		expect(typeof b === "object" && b !== null && "providers" in b).toBe(true);
		if (typeof b !== "object" || b === null || !("providers" in b)) return;
		// The machine's stores decide the sign-ins; the route only pins that the board's store leads.
		expect("stores" in b && Array.isArray(b.stores)).toBe(true);
		if (!("stores" in b) || !Array.isArray(b.stores)) return;
		expect(b.stores[0]).toMatchObject({ store: "board" });
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
});

describe("learnings routes", () => {
	const del = async (path: string) =>
		fetch(new URL(path, server.url), {
			method: "DELETE",
			headers: { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" },
		});

	test("POST validates text and glob", async () => {
		const missing = await post("/api/projects/p1/learnings", {});
		expect(missing.status).toBe(400);
		const empty = await post("/api/projects/p1/learnings", { text: "   " });
		expect(empty.status).toBe(400);
		const long = await post("/api/projects/p1/learnings", {
			text: "x".repeat(501),
		});
		expect(long.status).toBe(400);
		const badGlob = await post("/api/projects/p1/learnings", {
			text: "ok",
			glob: "",
		});
		expect(badGlob.status).toBe(400);
		const longGlob = await post("/api/projects/p1/learnings", {
			text: "ok",
			glob: "x".repeat(201),
		});
		expect(longGlob.status).toBe(400);
	});

	test("POST trims, stores, and GET lists the learning", async () => {
		const res = await post("/api/projects/p1/learnings", {
			text: "  never edit generated files  ",
			glob: " src/**/*.ts ",
		});
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		const learning =
			typeof b === "object" && b !== null && "learning" in b
				? (b.learning as { id: number; text: string; glob: string | null })
				: null;
		expect(learning?.text).toBe("never edit generated files");
		expect(learning?.glob).toBe("src/**/*.ts");
		const list = await get("/api/projects/p1/learnings");
		expect(list.status).toBe(200);
		const lb: unknown = await list.json();
		const learnings =
			typeof lb === "object" && lb !== null && "learnings" in lb
				? (lb.learnings as { id: number }[])
				: [];
		expect(learnings.some((l) => l.id === learning?.id)).toBe(true);
		expect(
			(await del(`/api/projects/p1/learnings/${learning?.id}`)).status,
		).toBe(200);
		// Unknown ids still answer ok: deleteLearning is void.
		expect((await del("/api/projects/p1/learnings/99999")).status).toBe(200);
		expect((await del("/api/projects/p1/learnings/nope")).status).toBe(400);
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

describe("review prompt carries the project's learnings", () => {
	test("a Review card's prompt contains the learning text and bumps its usage count", async () => {
		const add = await post("/api/projects", { name: "learn-proj" });
		expect(add.status).toBe(200);
		const e = projects.get("learn-proj")!;
		e.target = "main";
		const learning = e.store.addLearning({ text: "flag dead config" });
		const res = await post("/api/projects/learn-proj/arch-review", {});
		expect(res.status).toBe(200);
		const b: unknown = await res.json();
		const id =
			typeof b === "object" && b !== null && "id" in b ? String(b.id) : "";
		const prompt = e.store.getTask(id)?.prompt ?? "";
		expect(prompt).toContain("flag dead config");
		const used = e.store
			.listLearnings()
			.find((l) => l.id === learning.id)?.usageCount;
		expect(used).toBe(1);
		projects.delete("learn-proj");
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
					started: Date.now() - 60_000,
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
		expect(state.orphans).toEqual([{ pid: 4242, started: expect.any(Number) }]);
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
			removedPaths: [],
			envValues: {},
			projectPaths: [],
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

	test("logout stays per-browser; rotating the secret kills every old cookie", async () => {
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
		// Logout clears only the calling browser's cookie: a copied one still works.
		await call("/api/logout", session, {});
		expect((await call("/api/state", session)).status).toBe(200);
		// Sign out everywhere rotates the secret: the old cookie is dead on every host.
		expect(
			(await call("/api/settings/session-secret", session, {})).status,
		).toBe(200);
		expect((await call("/api/state", session)).status).toBe(401);
		// Rotation persisted: the stored secret is no longer the one the cookie was signed with.
		const stored: unknown = g.get("config");
		expect(
			stored !== null &&
				typeof stored === "object" &&
				"sessionSecret" in stored &&
				stored.sessionSecret !== "revoke-secret",
		).toBe(true);
		// And the board still takes logins under the new secret.
		const again = await call(
			"/api/login",
			{},
			{ name: "ada", password: "correct horse" },
		);
		expect(again.status).toBe(200);
		const fresh = (again.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		expect((await call("/api/state", { cookie: fresh })).status).toBe(200);
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
});

describe("fork research routes", () => {
	test("fork proposal reason strings mirror the retro ones", async () => {
		expect(FORK_PROPOSED_REASON_PREFIX).toBe("Proposed by the fork research ");
		expect(forkProposedReason("card")).toBe(
			"Proposed by the fork research card. Accept to start it, edit the prompt first, or cancel to decline.",
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
		});
		const res = await post(`/api/projects/p1/tasks/${t.id}/reply`, {
			text: "approve",
		});
		expect(res.status).toBe(200);
		expect(store.getTask(t.id)?.forkMergeApproved).toBe(true);
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

	test("an empty agent dir warns unseeded, in boardWarnings and in the state payload", async () =>
		withAgentDir(async () => {
			expect(boardWarnings()).toEqual([UNSEEDED]);
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
			expect(boardWarnings({})).toEqual(expected);
			credStore(join(dir, "agent.db"), [["anthropic", null]]);
			expect(boardWarnings({})).toEqual([]);
			// A disabled row counts as no active sign-in.
			credStore(join(dir, "agent.db"), [["anthropic", "replaced by"]]);
			expect(boardWarnings({})).toEqual(expected);
		}));
});

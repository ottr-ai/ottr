import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp, type Entry } from "./app.ts";
import { GlobalStore } from "./globalStore.ts";
import type { JiraNet } from "./jira.ts";
import { loadSecretBox, type SecretBox } from "./secretBox.ts";
import { ProjectStore } from "./store.ts";
import type {
	JiraBoardImportResult,
	JiraBoardSearchResult,
	JiraConnectionView,
	JiraImportResult,
	JiraSearchResult,
} from "./types.ts";

/** Every field a Jira route answers with; each test reads only the fields its route sends. */
type Answer = JiraConnectionView &
	JiraSearchResult &
	JiraImportResult & { error: string; projects: string[]; ok: boolean };

const root = mkdtempSync(join(tmpdir(), "ottr-jira-routes-"));
const servers: Server<undefined>[] = [];
const gstore = GlobalStore.open(join(root, "g"));
const box = loadSecretBox({ dir: join(root, "g", ".tasks"), env: {} });
const otherBox = loadSecretBox({
	dir: root,
	env: { OTTR_SECRET_KEY: "ab".repeat(32) },
});

const CLOUD_TOKEN = "cloud-secret-token-9f3a";
const DC_TOKEN = "dc-secret-pat-77c1";

// --- Jira stub: five issues, a JQL "bad" answers 400 like Jira's syntax error,
// and any JQL naming GONE-1 answers 400 like Jira does for a deleted or hidden key. ---
interface Seen {
	method: string;
	path: string;
	auth: string | null;
	body: Record<string, unknown>;
}
const seen: Seen[] = [];
/** Raw Jira comment and link answers per key; the default is none of either. */
const commentsByKey = new Map<string, unknown[]>();
const linksByKey = new Map<string, unknown[]>();
const issues = [1, 2, 3, 4, 5].map((n) => ({
	key: `PROJ-${n}`,
	fields: {
		summary: `Summary ${n}`,
		issuetype: { name: "Task" },
		status: { name: "To Do" },
		priority: n === 5 ? null : { name: "High" },
		description: null,
	},
}));
/** Issues only a key query returns, so project searches still see five. */
const extraIssues = ["P-1", "P-2"].map((key) => ({
	key,
	fields: {
		summary: `Summary ${key}`,
		issuetype: { name: "Task" },
		status: { name: "To Do" },
		priority: null,
		description: null,
	},
}));
const jira = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;
		const body =
			req.method === "POST"
				? ((await req.json()) as Record<string, unknown>)
				: {};
		seen.push({
			method: req.method,
			path: path + url.search,
			auth: req.headers.get("authorization"),
			body,
		});
		const jql = String(body.jql ?? "");
		if (jql === "bad")
			return Response.json(
				{ errorMessages: ["Error in the JQL Query: bad"], errors: {} },
				{ status: 400 },
			);
		if (jql.includes("GONE-1"))
			return Response.json(
				{
					errorMessages: [
						"An issue with key 'GONE-1' does not exist for field 'key'.",
					],
					errors: {},
				},
				{ status: 400 },
			);
		// Comment and issue-link reads of the import: the comment list is paged with
		// startAt/maxResults, the link read fetches only the issuelinks field.
		const issueRead = /\/rest\/api\/(\d+)\/issue\/([^/]+)(\/comment)?$/.exec(
			path,
		);
		const stubKey = issueRead?.[2];
		if (stubKey !== undefined) {
			if (issueRead?.[3] === "/comment") {
				const all = commentsByKey.get(stubKey) ?? [];
				const startAt = Number(url.searchParams.get("startAt") ?? "0");
				const maxResults = Number(url.searchParams.get("maxResults") ?? "100");
				return Response.json({
					comments: all.slice(startAt, startAt + maxResults),
					startAt,
					maxResults,
					total: all.length,
				});
			}
			return Response.json({
				id: `10000-${stubKey}`,
				key: stubKey,
				fields: { issuelinks: linksByKey.get(stubKey) ?? [] },
			});
		}
		const inKeys = (
			/^key in \((.*)\)$/.exec(jql)?.[1] ?? /^key = (.*)$/.exec(jql)?.[1]
		)?.split(",");
		// BULK-n keys exist for any n, so a large import has something to file.
		const bulk = (key: string) => ({
			key,
			fields: { ...issues[0]?.fields, summary: `Summary ${key}` },
		});
		const hits = inKeys
			? [
					...[...issues, ...extraIssues].filter((i) => inKeys.includes(i.key)),
					...inKeys.filter((k) => /^BULK-\d+$/.test(k)).map(bulk),
				]
			: issues;
		if (path === "/rest/api/3/search/jql")
			return Response.json({ issues: hits, isLast: true });
		if (path.endsWith("/rest/api/2/search"))
			return Response.json({ issues: hits, startAt: 0, total: hits.length });
		return new Response("not found", { status: 404 });
	},
});
servers.push(jira);
const stubFetch = ((input: string | URL | Request, init?: RequestInit) =>
	fetch(
		String(input).replace("https://jira.test", `http://127.0.0.1:${jira.port}`),
		init,
	)) as typeof fetch;

// --- Two projects shared by every app below (the apps share one global store). ---
const projects = new Map<string, Entry>();
const stores: ProjectStore[] = [];
for (const name of ["p1", "p2"]) {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	const store = ProjectStore.open(path);
	stores.push(store);
	projects.set(name, {
		path,
		name,
		store,
		target: null,
		gitless: false,
		github: null,
		protectedTarget: false,
		remote: null,
		dirty: false,
		mainUnpushed: false,
		mainBranch: null,
		latestRelease: null,
		latestImage: null,
		archReview: null,
	});
}
const p1Entry = projects.get("p1");
if (p1Entry === undefined) throw new Error("p1 was not registered");
const p1Store = p1Entry.store;
if (!(p1Store instanceof ProjectStore))
	throw new Error("p1 store is not a ProjectStore");
const p1 = p1Store;
const p2Entry = projects.get("p2");
if (!(p2Entry?.store instanceof ProjectStore))
	throw new Error("p2 store is not a ProjectStore");
const p2 = p2Entry.store;

/** The first request the Jira stub saw since the test cleared `seen`. */
function firstSeen(): Seen {
	const s = seen[0];
	if (s === undefined) throw new Error("the Jira stub saw no request");
	return s;
}

let scheduled = 0;

function boot(o: { secretBox?: SecretBox; jiraNet?: Partial<JiraNet> }) {
	const app = createApp({
		gstore,
		defaultDir: root,
		projects,
		cancel: async () => ({ removed: true }),
		stopTurn: async () => ({ ok: true }),
		finishKept: async () => ({ ok: true }),
		claimedPids: () => new Set<number>(),
		schedule: () => {
			scheduled++;
		},
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared: {
			maxTotalRuns: 3,
			reviewCheck: true,
			workCheck: true,
			idleReviews: true,
			trendingScan: true,
			commitIdentity: null,
			removedPaths: [],
			projectPaths: [],
			projectOrder: [],
			envValues: {},
		},
		serverRef: { current: undefined },
		secretBox: o.secretBox,
		jiraNet: o.jiraNet,
	});
	const srv = Bun.serve({ port: 0, ...app.serveOptions });
	app.serverRef.current = srv;
	servers.push(srv);
	return async <T = Answer>(
		path: string,
		body?: unknown,
		method?: string,
	): Promise<{ status: number; text: string; json: T }> => {
		const res = await fetch(new URL(path, srv.url), {
			method: method ?? (body === undefined ? "GET" : "POST"),
			headers: {
				"content-type": "application/json",
				// deps.port is 0: api() matches Host and Origin on it.
				Host: "127.0.0.1:0",
				Origin: "http://127.0.0.1:0",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, text, json: text ? JSON.parse(text) : null };
	};
}

afterAll(() => {
	for (const s of servers) s.stop(true);
	for (const s of stores) s.close();
	gstore.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const call = boot({ secretBox: box, jiraNet: { fetch: stubFetch } });

const cloud = {
	name: "work",
	site: "https://jira.test/",
	type: "cloud",
	email: "me@example.com",
	token: CLOUD_TOKEN,
	customFields: ["customfield_10042"],
};
const dc = {
	name: "client dc",
	site: "https://jira.test/jira",
	type: "datacenter",
	token: DC_TOKEN,
};

describe("Jira connections", () => {
	test("cloud and data center save; no answer or DB value holds the token", async () => {
		const a = await call("/api/jira/connections", cloud);
		expect(a.status).toBe(200);
		expect(a.json).toMatchObject({
			name: "work",
			site: "https://jira.test",
			type: "cloud",
			email: "me@example.com",
			customFields: ["customfield_10042"],
			tokenSet: true,
			tokenReadable: true,
			usedBy: [],
		});
		const b = await call("/api/jira/connections", dc);
		expect(b.status).toBe(200);
		expect(b.json).toMatchObject({
			site: "https://jira.test/jira",
			type: "datacenter",
			email: null,
		});
		const list = await call<JiraConnectionView[]>("/api/jira/connections");
		expect(list.json.map((c) => c.name)).toEqual(["work", "client dc"]);
		for (const r of [a, b, list]) {
			expect(r.text).not.toContain(CLOUD_TOKEN);
			expect(r.text).not.toContain(DC_TOKEN);
		}
		const stored = JSON.stringify(gstore.get("jira-connections"));
		expect(stored).not.toContain(CLOUD_TOKEN);
		expect(stored).not.toContain(DC_TOKEN);
		expect(stored).toContain(`v1:${box.keyId}:`);
	});

	test("an empty token on save keeps the stored one", async () => {
		const r = await call("/api/jira/connections", { ...cloud, token: "" });
		expect(r.json.tokenReadable).toBe(true);
	});

	test("validation refuses bad sites, types, emails, fields and a new connection without a token", async () => {
		const bad: [Record<string, unknown>, string][] = [
			[{ ...cloud, site: "http://jira.test" }, "https://"],
			[{ ...cloud, site: "https://jira.test/?a=1" }, ""],
			[{ ...cloud, site: "https://u:p@jira.test" }, ""],
			[{ ...cloud, name: "bad/name" }, "name"],
			[{ ...cloud, name: "x".repeat(101) }, "name"],
			[{ ...cloud, type: "server" }, "type"],
			[{ ...cloud, email: "" }, "email"],
			[{ ...cloud, customFields: ["summary"] }, "customFields"],
			[
				{
					...cloud,
					customFields: Array.from(
						{ length: 21 },
						(_, i) => `customfield_${i}`,
					),
				},
				"customFields",
			],
			[{ ...cloud, token: "t".repeat(4001) }, "token"],
			[{ ...cloud, name: "fresh", token: undefined }, "needs a token"],
		];
		for (const [body, msg] of bad) {
			const r = await call("/api/jira/connections", body);
			expect(r.status).toBe(400);
			expect(r.json.error).toContain(msg);
		}
		expect(
			(await call<JiraConnectionView[]>("/api/jira/connections")).json.map(
				(c) => c.name,
			),
		).toEqual(["work", "client dc"]);
	});

	test("hosted mode refuses a site that resolves to a private address at save", async () => {
		const hosted = boot({
			secretBox: box,
			jiraNet: {
				fetch: stubFetch,
				hosted: true,
				lookup: async () => ["10.0.0.1"],
			},
		});
		const r = await hosted("/api/jira/connections", {
			...cloud,
			name: "inner",
		});
		expect(r.status).toBe(400);
		expect(
			gstore.get<{ name: string }[]>("jira-connections")?.map((c) => c.name),
		).not.toContain("inner");
	});

	test("no secret box: every Jira route answers 503", async () => {
		const off = boot({});
		const r = await off("/api/jira/connections");
		expect(r.status).toBe(503);
		expect(r.json.error).toBe("OTTR_SECRET_KEY is invalid");
	});
});

describe("project settings and delete", () => {
	test("settings refuse an unknown connection name", async () => {
		const r = await call("/api/projects/p1/settings", {
			jiraConnection: "nope",
		});
		expect(r.status).toBe(400);
		expect(r.json.error).toBe("unknown Jira connection");
		expect(p1.getSettings().jiraConnection).toBeNull();
	});

	test("settings take a known name; deleting it is refused and names the project", async () => {
		const set = await call("/api/projects/p1/settings", {
			jiraConnection: "work",
		});
		expect(set.status).toBe(200);
		expect(p1.getSettings().jiraConnection).toBe("work");
		const view = (
			await call<JiraConnectionView[]>("/api/jira/connections")
		).json.find((c) => c.name === "work");
		expect(view?.usedBy).toEqual(["p1"]);
		const del = await call("/api/jira/connections/work", undefined, "DELETE");
		expect(del.status).toBe(409);
		expect(del.json.error).toBe("in use by: p1");
		expect(del.json.projects).toEqual(["p1"]);
	});

	test("an unused connection deletes; an unknown one is 404", async () => {
		await call("/api/jira/connections", { ...cloud, name: "spare" });
		const del = await call("/api/jira/connections/spare", undefined, "DELETE");
		expect(del.json.ok).toBe(true);
		const again = await call(
			"/api/jira/connections/spare",
			undefined,
			"DELETE",
		);
		expect(again.status).toBe(404);
	});
});

describe("search and import", () => {
	const search = (jql: string, project = "p1") =>
		call(`/api/projects/${project}/jira/search`, { jql });
	const importKeys = (keys: unknown, stage = "backlog") =>
		call("/api/projects/p1/jira/import", { keys, stage });

	test("cloud search posts to search/jql with Basic auth, returns rows and saves the JQL", async () => {
		seen.length = 0;
		const r = await search("  project = PROJ  ");
		expect(r.status).toBe(200);
		expect(seen).toHaveLength(1);
		const req = firstSeen();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/rest/api/3/search/jql");
		expect(req.auth).toBe(
			`Basic ${Buffer.from(`me@example.com:${CLOUD_TOKEN}`).toString("base64")}`,
		);
		expect(r.json.next).toBeNull();
		expect(r.json.rows).toHaveLength(5);
		expect(r.json.rows[0]).toEqual({
			key: "PROJ-1",
			url: "https://jira.test/browse/PROJ-1",
			summary: "Summary 1",
			issueType: "Task",
			status: "To Do",
			priority: "High",
			importedCard: null,
		});
		expect(r.json.rows[4]?.priority).toBe("");
		expect(p1.getSettings().jiraLastJql).toBe("project = PROJ");
	});

	test("a Jira 400 answers 400 with Jira's message and keeps the last JQL", async () => {
		const r = await search("bad");
		expect(r.status).toBe(400);
		expect(r.json.error).toContain("Error in the JQL Query: bad");
		expect(r.text).not.toContain(CLOUD_TOKEN);
		expect(p1.getSettings().jiraLastJql).toBe("project = PROJ");
	});

	test("search refuses an empty or too long JQL and a project without a connection", async () => {
		expect((await search("   ")).status).toBe(400);
		expect((await search("x".repeat(2001))).status).toBe(400);
		const none = await search("project = PROJ", "p2");
		expect(none.status).toBe(409);
		expect(none.json.error).toBe("no Jira connection for this project");
		expect((await search("x", "nope")).status).toBe(404);
	});

	test("data center search posts to /rest/api/2/search with a Bearer token", async () => {
		await call("/api/projects/p2/settings", { jiraConnection: "client dc" });
		seen.length = 0;
		const r = await search("project = PROJ", "p2");
		expect(r.status).toBe(200);
		const req = firstSeen();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/jira/rest/api/2/search");
		expect(req.auth).toBe(`Bearer ${DC_TOKEN}`);
		expect(r.json.rows[0]?.url).toBe("https://jira.test/jira/browse/PROJ-1");
		expect(r.json.total).toBe(5);
	});

	test("a data center import reads comments and links over REST v2", async () => {
		commentsByKey.set("PROJ-1", [
			{
				author: { displayName: "Dan" },
				created: "2026-10-06T08:00:00.000+0000",
				body: "*done* quickly",
			},
		]);
		const r = await call("/api/projects/p2/jira/import", {
			keys: ["PROJ-1"],
			stage: "backlog",
		});
		expect(r.status).toBe(200);
		expect(r.json.filed).toHaveLength(1);
		const calls = seen.map((s) => `${s.method} ${s.path}`);
		expect(calls).toContain(
			"GET /jira/rest/api/2/issue/PROJ-1/comment?maxResults=100&startAt=0",
		);
		expect(calls).toContain(
			"GET /jira/rest/api/2/issue/PROJ-1?fields=issuelinks",
		);
		// The wiki body went through the converter: the author and date line is in the prompt.
		expect(p2.getTask(r.json.filed[0] ?? "")?.prompt).toContain(
			"COMMENTS\n<<<DATA\nDan (2026-10-06T08:00:00.000+0000):\n",
		);
		commentsByKey.clear();
	});

	test("import validates keys and stage", async () => {
		expect((await importKeys([])).status).toBe(400);
		expect((await importKeys(["proj-1"])).status).toBe(400);
		expect((await importKeys(["PROJ-1; drop"])).status).toBe(400);
		expect((await importKeys(["PROJ-1"], "done")).status).toBe(400);
	});

	test("an import of more than 1000 tickets files them all", async () => {
		const keys = Array.from({ length: 1001 }, (_, i) => `BULK-${i + 1}`);
		const r = await importKeys(keys);
		expect(r.status).toBe(200);
		expect(r.json.filed).toHaveLength(1001);
		expect(r.json.skipped).toEqual([]);
		expect(r.json.unavailable).toEqual([]);
	});

	test("import 3 of 5 into backlog, then search marks them, then a re-import skips them", async () => {
		seen.length = 0;
		const r = await importKeys(["PROJ-1", "PROJ-2", "PROJ-3"]);
		expect(r.status).toBe(200);
		expect(r.json.skipped).toEqual([]);
		expect(r.json.filed).toHaveLength(3);
		expect(firstSeen().body.jql).toBe("key in (PROJ-1,PROJ-2,PROJ-3)");
		expect(firstSeen().body.fields).toContain("description");
		const tasks = r.json.filed.map((id) => p1.getTask(id));
		expect(tasks.map((t) => t?.title)).toEqual([
			"PROJ-1: Summary 1",
			"PROJ-2: Summary 2",
			"PROJ-3: Summary 3",
		]);
		for (const t of tasks) expect(t?.stage).toBe("backlog");
		expect(tasks[0]?.prompt).toContain("https://jira.test/browse/PROJ-1");

		const s = await search("project = PROJ");
		expect(s.json.rows.map((row) => row.importedCard)).toEqual([
			...r.json.filed,
			null,
			null,
		]);

		const again = await importKeys(["PROJ-1", "PROJ-2", "PROJ-3"]);
		expect(again.json.filed).toEqual([]);
		expect(again.json.skipped).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
	});

	test("a key Jira does not return is unavailable, not already imported", async () => {
		const r = await importKeys(["PROJ-99"]);
		expect(r.json.filed).toEqual([]);
		expect(r.json.skipped).toEqual([]);
		expect(r.json.unavailable).toEqual(["PROJ-99"]);
	});

	test("the import reads all comments and the issue links into the prompt", async () => {
		const adfText = (text: string): unknown => ({
			type: "doc",
			version: 1,
			content: [{ type: "paragraph", content: [{ type: "text", text }] }],
		});
		commentsByKey.set("BULK-9001", [
			{
				author: { displayName: "Ada" },
				created: "2026-10-07T09:00:00.000+0000",
				body: adfText("Root cause found in the spike"),
			},
		]);
		// 130 comments: two pages of 100 at the COMMENT_PAGE size.
		commentsByKey.set(
			"BULK-9002",
			Array.from({ length: 130 }, (_, i) => ({
				author: { displayName: `Author ${i}` },
				created: "2026-10-01T10:00:00.000+0000",
				body: adfText(`body ${i}`),
			})),
		);
		linksByKey.set("BULK-9001", [
			{
				type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
				outwardIssue: {
					key: "CMIS-8343",
					fields: { summary: "the follow-up", status: { name: "Done" } },
				},
			},
		]);
		seen.length = 0;
		const r = await importKeys(["BULK-9001", "BULK-9002"]);
		expect(r.status).toBe(200);
		// The exact reads: one page for a fresh ticket, two pages past the page size.
		expect(seen).toContainEqual({
			method: "GET",
			path: "/rest/api/3/issue/BULK-9001/comment?maxResults=100&startAt=0",
			auth: expect.any(String),
			body: {},
		});
		expect(seen).toContainEqual({
			method: "GET",
			path: "/rest/api/3/issue/BULK-9002/comment?maxResults=100&startAt=0",
			auth: expect.any(String),
			body: {},
		});
		expect(seen).toContainEqual({
			method: "GET",
			path: "/rest/api/3/issue/BULK-9002/comment?maxResults=100&startAt=100",
			auth: expect.any(String),
			body: {},
		});
		expect(seen).toContainEqual({
			method: "GET",
			path: "/rest/api/3/issue/BULK-9001?fields=issuelinks",
			auth: expect.any(String),
			body: {},
		});
		const single = p1.getTask(r.json.filed[0] ?? "");
		expect(single?.prompt).toContain(
			"COMMENTS\n<<<DATA\nAda (2026-10-07T09:00:00.000+0000):\nRoot cause found in the spike\nDATA>>>",
		);
		expect(single?.prompt).toContain(
			"LINKS\n<<<DATA\nblocks: CMIS-8343: the follow-up (Done)\nDATA>>>",
		);
		// BULK-9002 keeps every one of its 130 comments, oldest first.
		const paged = p1.getTask(r.json.filed[1] ?? "");
		expect(paged?.prompt).toContain(
			"Author 0 (2026-10-01T10:00:00.000+0000):\nbody 0",
		);
		expect(paged?.prompt).toContain(
			"Author 129 (2026-10-01T10:00:00.000+0000):\nbody 129",
		);
		commentsByKey.clear();
		linksByKey.clear();
	});

	test("a key Jira rejects in the batch query is skipped and the others are filed", async () => {
		seen.length = 0;
		const r = await importKeys(["P-1", "GONE-1", "P-2"]);
		expect(r.status).toBe(200);
		expect(r.json.filed).toHaveLength(2);
		expect(r.json.skipped).toEqual([]);
		expect(r.json.unavailable).toEqual(["GONE-1"]);
		expect(seen.map((s) => s.body.jql)).toEqual([
			"key in (P-1,GONE-1,P-2)",
			"key = P-1",
			"key = GONE-1",
			"key = P-2",
		]);
	});

	test("todo import files todo cards and schedules", async () => {
		const before = scheduled;
		const r = await importKeys(["PROJ-4"], "todo");
		expect(r.json.filed).toHaveLength(1);
		expect(p1.getTask(r.json.filed[0] ?? "")?.stage).toBe("todo");
		expect(scheduled).toBeGreaterThan(before);
	});

	test("two parallel imports of one key file one card", async () => {
		const [a, b] = await Promise.all([
			importKeys(["PROJ-5"]),
			importKeys(["PROJ-5"]),
		]);
		expect(a.json.filed.length + b.json.filed.length).toBe(1);
		expect(a.json.skipped.length + b.json.skipped.length).toBe(1);
	});
});

describe("board-wide search and import", () => {
	const p2Entry = projects.get("p2");
	if (p2Entry === undefined) throw new Error("p2 was not registered");
	const p2Store = p2Entry.store;
	if (!(p2Store instanceof ProjectStore))
		throw new Error("p2 store is not a ProjectStore");
	const p2 = p2Store;
	const boardSearch = (jql: string, connection = "work") =>
		call<JiraBoardSearchResult>("/api/jira/search", { connection, jql });
	const boardImport = (assignments: unknown, stage = "backlog") =>
		call<JiraBoardImportResult>("/api/jira/import", {
			connection: "work",
			stage,
			assignments,
		});

	test("board search hits Jira live and writes no project settings", async () => {
		await call("/api/projects/p2/settings", { jiraConnection: "work" });
		const p1Jql = p1.getSettings().jiraLastJql;
		const p2Jql = p2.getSettings().jiraLastJql;
		seen.length = 0;
		const r = await boardSearch("project = PROJ");
		expect(r.status).toBe(200);
		const req = firstSeen();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/rest/api/3/search/jql");
		expect(req.auth).toBe(
			`Basic ${Buffer.from(`me@example.com:${CLOUD_TOKEN}`).toString("base64")}`,
		);
		const card = p1.jiraImported("https://jira.test", ["PROJ-1"]).get("PROJ-1");
		expect(r.json.rows[0]?.importedIn).toEqual(
			card === undefined ? [] : [{ project: "p1", task: card }],
		);
		expect(p1.getSettings().jiraLastJql).toBe(p1Jql);
		expect(p2.getSettings().jiraLastJql).toBe(p2Jql);
	});

	test("one key can be imported into two projects on purpose; a repeat skips", async () => {
		const first = await boardImport([{ key: "BULK-2001", project: "p1" }]);
		expect(first.status).toBe(200);
		const filed = first.json.filed;
		expect(filed).toEqual([
			{ project: "p1", key: "BULK-2001", task: filed[0]?.task ?? "" },
		]);
		expect(first.json.skipped).toEqual([]);
		expect(first.json.unavailable).toEqual([]);
		const task = p1.getTask(filed[0]?.task ?? "");
		expect(task?.title).toBe("BULK-2001: Summary BULK-2001");
		expect(task?.stage).toBe("backlog");

		const s1 = await boardSearch("key in (BULK-2001)");
		expect(s1.json.rows[0]?.importedIn).toEqual([
			{ project: "p1", task: filed[0]?.task ?? "" },
		]);

		const second = await boardImport([{ key: "BULK-2001", project: "p2" }]);
		expect(second.json.filed).toHaveLength(1);
		const p2Card = second.json.filed[0]?.task ?? "";
		expect(p2.getTask(p2Card)?.title).toBe("BULK-2001: Summary BULK-2001");

		const s2 = await boardSearch("key in (BULK-2001)");
		expect(s2.json.rows[0]?.importedIn).toEqual([
			{ project: "p1", task: filed[0]?.task ?? "" },
			{ project: "p2", task: p2Card },
		]);

		const repeat = await boardImport([{ key: "BULK-2001", project: "p1" }]);
		expect(repeat.status).toBe(200);
		expect(repeat.json.filed).toEqual([]);
		expect(repeat.json.skipped).toEqual([{ project: "p1", key: "BULK-2001" }]);
	});

	test("a board-wide import reads comments and links into the prompt too", async () => {
		commentsByKey.set("BULK-3001", [
			{
				author: { displayName: "Ada" },
				created: "2026-10-07T09:00:00.000+0000",
				body: {
					type: "doc",
					version: 1,
					content: [
						{
							type: "paragraph",
							content: [
								{ type: "text", text: "Root cause found in the spike" },
							],
						},
					],
				},
			},
		]);
		linksByKey.set("BULK-3001", [
			{
				type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
				outwardIssue: {
					key: "CMIS-8343",
					fields: { summary: "the follow-up", status: { name: "Done" } },
				},
			},
		]);
		seen.length = 0;
		const r = await boardImport([{ key: "BULK-3001", project: "p1" }]);
		expect(r.status).toBe(200);
		expect(r.json.filed).toHaveLength(1);
		const calls = seen.map((s) => `${s.method} ${s.path}`);
		expect(calls).toContain(
			"GET /rest/api/3/issue/BULK-3001/comment?maxResults=100&startAt=0",
		);
		expect(calls).toContain(
			"GET /rest/api/3/issue/BULK-3001?fields=issuelinks",
		);
		const task = p1.getTask(r.json.filed[0]?.task ?? "");
		expect(task?.prompt).toContain(
			"COMMENTS\n<<<DATA\nAda (2026-10-07T09:00:00.000+0000):\nRoot cause found in the spike\nDATA>>>",
		);
		expect(task?.prompt).toContain(
			"LINKS\n<<<DATA\nblocks: CMIS-8343: the follow-up (Done)\nDATA>>>",
		);
		commentsByKey.clear();
		linksByKey.clear();
	});

	test("one request can file the same key into two projects", async () => {
		const r = await boardImport([
			{ key: "BULK-2002", project: "p2" },
			{ key: "BULK-2002", project: "p1" },
		]);
		expect(r.status).toBe(200);
		expect(r.json.filed).toHaveLength(2);
		expect(r.json.skipped).toEqual([]);
		expect(p1.jiraImported("https://jira.test", ["BULK-2002"]).size).toBe(1);
		expect(p2.jiraImported("https://jira.test", ["BULK-2002"]).size).toBe(1);
	});

	test("a project without its own connection imports from the board connection", async () => {
		await call("/api/projects/p2/settings", { jiraConnection: null });
		const r = await boardImport([{ key: "BULK-2003", project: "p2" }]);
		expect(r.status).toBe(200);
		expect(r.json.filed).toEqual([
			{ project: "p2", key: "BULK-2003", task: r.json.filed[0]?.task ?? "" },
		]);
		const none = await call("/api/projects/p2/jira/search", { jql: "x" });
		expect(none.status).toBe(409);
		expect(none.json.error).toBe("no Jira connection for this project");
	});

	test("the whole request is validated before anything files", async () => {
		const bad = (body: Record<string, unknown>) =>
			call<JiraBoardImportResult>("/api/jira/import", body);
		const bulkP1 = { key: "BULK-2010", project: "p1" };
		expect(
			(await bad({ connection: 7, stage: "backlog", assignments: [bulkP1] }))
				.status,
		).toBe(400);
		expect(
			(
				await bad({
					connection: "nope",
					stage: "backlog",
					assignments: [bulkP1],
				})
			).status,
		).toBe(404);
		expect(
			(await bad({ connection: "work", stage: "done", assignments: [bulkP1] }))
				.status,
		).toBe(400);
		expect(
			(await bad({ connection: "work", stage: "backlog", assignments: [] }))
				.status,
		).toBe(400);
		expect(
			(
				await bad({
					connection: "work",
					stage: "backlog",
					assignments: [{ key: "proj-1", project: "p1" }],
				})
			).status,
		).toBe(400);
		const unknownProject = await call<
			JiraBoardImportResult & { error: string }
		>("/api/jira/import", {
			connection: "work",
			stage: "backlog",
			assignments: [{ key: "BULK-2010", project: "nope" }],
		});
		expect(unknownProject.status).toBe(400);
		expect(unknownProject.json.error).toBe("unknown project: nope");
		for (const store of [p1, p2])
			expect(store.jiraImported("https://jira.test", ["BULK-2010"]).size).toBe(
				0,
			);
		const ok = await boardImport([{ key: "BULK-2011", project: "p1" }]);
		expect(ok.status).toBe(200);
		expect(ok.json.filed).toHaveLength(1);
	});

	test("a key Jira does not return is unavailable", async () => {
		const r = await boardImport([{ key: "PROJ-99", project: "p1" }]);
		expect(r.status).toBe(200);
		expect(r.json.filed).toEqual([]);
		expect(r.json.skipped).toEqual([]);
		expect(r.json.unavailable).toEqual(["PROJ-99"]);
	});
});

describe("a changed key", () => {
	test("the connection shows token unreadable and search answers 409", async () => {
		const other = boot({ secretBox: otherBox, jiraNet: { fetch: stubFetch } });
		const view = (
			await other<JiraConnectionView[]>("/api/jira/connections")
		).json.find((c) => c.name === "work");
		expect(view).toMatchObject({ tokenSet: true, tokenReadable: false });
		seen.length = 0;
		const r = await other("/api/projects/p1/jira/search", {
			jql: "project = X",
		});
		expect(r.status).toBe(409);
		expect(r.json.error).toBe("token unreadable, enter it again");
		expect(seen).toHaveLength(0);
		expect(p1.getSettings().jiraLastJql).toBe("project = PROJ");
	});
});

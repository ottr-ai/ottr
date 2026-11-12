import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp, type Entry } from "./app.ts";
import {
	type IdentityRole,
	SESSION_COOKIE,
	SESSION_MS,
	signIdentity,
	signSession,
} from "./auth.ts";
import { GlobalStore } from "./globalStore.ts";
import type { Hosted } from "./hosted.ts";
import { loadSecretBox } from "./secretBox.ts";
import { ProjectStore } from "./store.ts";
import { turnEnv } from "./tokens.ts";
import { VmTokens } from "./vmTokens.ts";

// Hosted mode's request wall (docs/specs/hosted-mode.md section 3), against a real Bun.serve.
// Requests from this test arrive over direct loopback, which a self-hosted board leaves open.

const root = mkdtempSync(join(tmpdir(), "hosted-wall-"));
const SECRET = "hosted-secret-".repeat(4);
const TENANT = "acme";
const PUBLIC = "acme.ottr.cloud";
const BOOT = "boot-token-hosted";
const servers: Server<undefined>[] = [];
const stores: { close(): void }[] = [];
afterAll(() => {
	for (const s of servers) s.stop(true);
	for (const s of stores) s.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const shared = () => ({
	maxTotalRuns: 3,
	reviewCheck: true,
	workCheck: true,
	idleReviews: true,
	trendingScan: true,
	commitIdentity: null,
	removedPaths: [] as string[],
	envValues: {} as Record<string, string>,
	envPlain: {} as Record<string, string>,
	projectPaths: [] as string[],
	projectOrder: [] as string[],
});

/** One board on a random port; hosted undefined mounts a self-hosted board. */
function mount(
	name: string,
	hosted: Hosted | undefined,
	extra: Partial<Parameters<typeof createApp>[0]> = {},
	opts: {
		gh?: (
			args: string[],
			timeoutMs?: number,
		) => Promise<{ code: number; stdout: string; stderr: string }>;
		ciWatchTick?: (opts?: { manual?: string }) => Promise<void>;
		projects?: { name: string; github: string }[];
	} = {},
) {
	const g = GlobalStore.open(join(root, `g-${name}`));
	stores.push(g);
	// Every self-host credential is set, so a pass would show it still counts in hosted mode.
	// No admin: a self-hosted board would be in onboarding.
	g.set("config", { apiKey: "wall-key", sessionSecret: "wall-secret" });
	const projectDir = join(root, `p-${name}`);
	mkdirSync(projectDir, { recursive: true });
	const store = ProjectStore.open(projectDir);
	stores.push(store);
	const projects = new Map<string, Entry>();
	projects.set("p1", {
		path: projectDir,
		name: "p1",
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
	for (const p of opts.projects ?? []) {
		const dir = join(root, `p-${p.name}`);
		mkdirSync(dir, { recursive: true });
		const store = ProjectStore.open(dir);
		stores.push(store);
		projects.set(p.name, {
			path: dir,
			name: p.name,
			store,
			target: null,
			gitless: false,
			github: p.github,
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
	const stops: number[] = [];
	const releases: number[] = [];
	const app = createApp({
		gstore: g,
		secretBox: (() => {
			const dir = join(root, `boxes-${name}`);
			mkdirSync(dir, { recursive: true });
			return loadSecretBox({ dir, env: {} });
		})(),
		defaultDir: root,
		projects,
		cancel: async () => ({ removed: true }),
		finishKept: async () => ({ ok: true }),
		stopTurn: async () => ({ ok: true }),
		claimedPids: () => new Set<number>(),
		schedule: () => {},
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared: shared(),
		serverRef: { current: undefined },
		board: { url: "http://ottr:4852", token: BOOT },
		vmTokens: new VmTokens({ file: null }),
		hosted,
		...(opts.gh !== undefined && { gh: opts.gh }),
		...(opts.ciWatchTick !== undefined && { ciWatchTick: opts.ciWatchTick }),
		creditStop: async () => {
			stops.push(Date.now());
			return 2;
		},
		creditRelease: async () => {
			releases.push(Date.now());
			return 3;
		},
		...extra,
	});
	const srv = Bun.serve({ port: 0, ...app.serveOptions });
	app.serverRef.current = srv;
	servers.push(srv);
	const call = (
		path: string,
		opts: {
			method?: string;
			headers?: Record<string, string>;
			body?: unknown;
		} = {},
	) =>
		fetch(new URL(path, srv.url), {
			method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
			headers: { "content-type": "application/json", ...opts.headers },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		});
	return { call, g, store, stops, releases, app, projects };
}

const hosted: Hosted = {
	config: {
		tenant: TENANT,
		secret: SECRET,
		controlUrl: "http://127.0.0.1:9",
		wording: {
			workSuffix: "",
			mergeSuffix: "",
			resumeSuffix: "",
			creditReason: "out of credit",
		},
	},
	hooks: {
		reportUsage: () => {},
		creditOk: async () => true,
		gitToken: async () => null,
	},
};

/** What the proxy forwards: the tenant's public Host and Origin, plus a fresh signed header. */
const signed = (
	role: IdentityRole,
	header = signIdentity(SECRET, TENANT, role),
) => ({
	Host: PUBLIC,
	Origin: `https://${PUBLIC}`,
	"x-ottr-identity": header,
});
const loopback = { Host: "127.0.0.1:0", Origin: "http://127.0.0.1:0" };

describe("hosted mode request wall", () => {
	const board = mount("hosted", hosted);

	test("a signed owner header passes on a host and origin no allowlist covers", async () => {
		const res = await board.call("/api/state", { headers: signed("owner") });
		expect(res.status).toBe(200);
		// No admin is stored, yet hosted mode never opens setup.
		expect(await res.json()).toMatchObject({ hosted: true, onboarding: false });
		const post = await board.call("/api/projects/p1/tasks", {
			headers: signed("owner"),
			body: { prompt: "owner card" },
		});
		expect(post.status).toBe(200);
	});

	test("no header is 401, also from direct loopback", async () => {
		expect((await board.call("/api/state", { headers: loopback })).status).toBe(
			401,
		);
		expect((await board.call("/api/boot", { headers: loopback })).status).toBe(
			401,
		);
		const filed = await board.call("/api/projects/p1/tasks", {
			headers: loopback,
			body: { prompt: "anonymous" },
		});
		expect(filed.status).toBe(401);
		expect(board.store.listTasks().some((t) => t.prompt === "anonymous")).toBe(
			false,
		);
	});

	test("a forged, other-tenant, expired or replayed header is 401", async () => {
		const forged = signIdentity("f".repeat(40), TENANT, "owner");
		const otherTenant = signIdentity(SECRET, "other", "owner");
		const expired = signIdentity(SECRET, TENANT, "owner", Date.now() - 120_000);
		const ahead = signIdentity(SECRET, TENANT, "owner", Date.now() + 120_000);
		for (const header of [forged, otherTenant, expired, ahead, "garbage"])
			expect(
				(await board.call("/api/state", { headers: signed("owner", header) }))
					.status,
			).toBe(401);
		const once = signIdentity(SECRET, TENANT, "owner");
		expect(
			(await board.call("/api/state", { headers: signed("owner", once) }))
				.status,
		).toBe(200);
		expect(
			(await board.call("/api/state", { headers: signed("owner", once) }))
				.status,
		).toBe(401);
	});

	test("a session cookie or X-API-Key grants nothing", async () => {
		const cookie = `${SESSION_COOKIE}=${signSession("wall-secret", "ada", SESSION_MS)}`;
		for (const headers of [
			{ ...loopback, cookie },
			{ ...loopback, "x-api-key": "wall-key" },
			{ Host: PUBLIC, Origin: `https://${PUBLIC}`, "x-api-key": "wall-key" },
		]) {
			expect((await board.call("/api/state", { headers })).status).toBe(401);
			expect((await board.call("/api/ws", { headers })).status).toBe(401);
		}
	});

	test("the live socket needs the owner header too", async () => {
		// Past the wall, only the missing upgrade headers stop the handshake.
		expect(
			(await board.call("/api/ws", { headers: signed("owner") })).status,
		).toBe(400);
		expect((await board.call("/api/ws", { headers: loopback })).status).toBe(
			401,
		);
		expect(
			(await board.call("/api/ws", { headers: signed("control") })).status,
		).toBe(403);
	});

	test("POST /api/hosted/stop: control only, answers the stopped count", async () => {
		const before = board.stops.length;
		const owner = await board.call("/api/hosted/stop", {
			method: "POST",
			headers: signed("owner"),
		});
		expect(owner.status).toBe(403);
		const tenant = await board.call("/api/hosted/stop", {
			method: "POST",
			headers: signed("tenant"),
		});
		expect(tenant.status).toBe(403);
		const none = await board.call("/api/hosted/stop", {
			method: "POST",
			headers: loopback,
		});
		expect(none.status).toBe(401);
		expect(board.stops.length).toBe(before);
		const control = await board.call("/api/hosted/stop", {
			method: "POST",
			headers: signed("control"),
		});
		expect(control.status).toBe(200);
		expect(await control.json()).toEqual({ stopped: 2 });
		expect(board.stops.length).toBe(before + 1);
	});

	test("POST /api/hosted/release: control only, answers the released count", async () => {
		const before = board.releases.length;
		for (const role of ["owner", "tenant"] as const) {
			const res = await board.call("/api/hosted/release", {
				method: "POST",
				headers: signed(role),
			});
			expect(res.status).toBe(403);
		}
		const none = await board.call("/api/hosted/release", {
			method: "POST",
			headers: loopback,
		});
		expect(none.status).toBe(401);
		const forged = await board.call("/api/hosted/release", {
			method: "POST",
			headers: signed(
				"control",
				signIdentity("f".repeat(40), TENANT, "control"),
			),
		});
		expect(forged.status).toBe(401);
		expect(board.releases.length).toBe(before);
		const control = await board.call("/api/hosted/release", {
			method: "POST",
			headers: signed("control"),
		});
		expect(control.status).toBe(200);
		expect(await control.json()).toEqual({ released: 3 });
		expect(board.releases.length).toBe(before + 1);
	});

	test("control reaches no other route, tenant no route at all", async () => {
		expect(
			(await board.call("/api/state", { headers: signed("control") })).status,
		).toBe(403);
		expect(
			(await board.call("/api/state", { headers: signed("tenant") })).status,
		).toBe(403);
		const filed = await board.call("/api/projects/p1/tasks", {
			headers: signed("control"),
			body: { prompt: "from control" },
		});
		expect(filed.status).toBe(403);
	});

	test("sign-in, API key, session and provider sign-in routes are 404 with a valid header", async () => {
		const routes: [string, string][] = [
			["POST", "/api/setup"],
			["POST", "/api/login"],
			["POST", "/api/logout"],
			["GET", "/api/settings/api-key"],
			["POST", "/api/settings/api-key"],
			["POST", "/api/settings/session-secret"],
			["GET", "/api/settings/sessions"],
			["DELETE", "/api/settings/sessions/some-id"],
			["GET", "/api/provider-login"],
			["POST", "/api/provider-login"],
			["POST", "/api/provider-login/answer"],
			["POST", "/api/provider-login/cancel"],
			["POST", "/api/provider-login/logout"],
		];
		for (const [method, path] of routes) {
			const res = await board.call(path, {
				method,
				headers: signed("owner"),
				body:
					method === "POST"
						? { name: "ada", password: "long enough" }
						: undefined,
			});
			expect({ path, method, status: res.status }).toEqual({
				path,
				method,
				status: 404,
			});
			expect(await res.json()).toEqual({ error: "not found" });
		}
		// Neither the API key nor the session secret rotated, and no admin was created.
		// The row holds sealed values: under the mount's box (same key dir) they open
		// to the seeded credentials.
		const row = board.g.get<Record<string, unknown>>("config");
		const wallBox = loadSecretBox({
			dir: join(root, "boxes-hosted"),
			env: {},
		});
		expect(wallBox.open(row?.apiKey as string)).toBe("wall-key");
		expect(wallBox.open(row?.sessionSecret as string)).toBe("wall-secret");
		expect(row).not.toHaveProperty("admin");
	});

	test("the boot token still files a card, whatever the Host, and nothing else", async () => {
		const asTurn = (host: string, origin: string, token: string) => ({
			Host: host,
			Origin: origin,
			"x-board-token": token,
		});
		const turnsHost = asTurn("ottr:4852", "http://ottr:4852", BOOT);
		const filed = await board.call("/api/projects/p1/tasks", {
			headers: turnsHost,
			body: { prompt: "filed by a turn" },
		});
		expect(filed.status).toBe(200);
		const viaLoopback = await board.call("/api/projects/p1/tasks", {
			headers: asTurn("127.0.0.1:0", "http://127.0.0.1:0", BOOT),
			body: { prompt: "filed over loopback" },
		});
		expect(viaLoopback.status).toBe(200);
		const prompts = board.store.listTasks().map((t) => t.prompt);
		expect(prompts).toContain("filed by a turn");
		expect(prompts).toContain("filed over loopback");
		const guessed = await board.call("/api/projects/p1/tasks", {
			headers: asTurn("ottr:4852", "http://ottr:4852", "guess"),
			body: { prompt: "guessed" },
		});
		expect(guessed.status).toBe(401);
		expect(
			(await board.call("/api/state", { headers: turnsHost })).status,
		).toBe(403);
	});
});

// docs/specs/omp-stats-dashboard.md: the omp stats proxy would offer the loopback and cookie
// grants the hosted wall removes, so a hosted board never serves it.
test("hosted mode serves no omp stats dashboard proxy, also from direct loopback", async () => {
	let ensured = 0;
	const PROXY = 3848;
	const board = mount("hosted-omp-stats", hosted, {
		ompStats: {
			info: { port: PROXY, error: null },
			dashboard: {
				ensure: () => {
					ensured++;
					return { phase: "running", port: 9, error: null };
				},
				state: () => ({ phase: "stopped", port: null, error: null }),
				tick: async () => {},
				stop: () => {},
			},
		},
	});
	const proxy = Bun.serve({ port: 0, fetch: board.app.ompStatsFetch });
	servers.push(proxy);
	const res = await fetch(new URL("/", proxy.url), {
		headers: { Host: `127.0.0.1:${PROXY}` },
	});
	expect(res.status).toBe(404);
	expect(ensured).toBe(0);
	const info = await board.call("/api/settings/omp-stats/dashboard", {
		headers: signed("owner"),
	});
	expect(await info.json()).toEqual({
		port: null,
		error: "not available in hosted mode",
	});
});

describe("POST /api/hosted/github-event", () => {
	const ghCalls: string[][] = [];
	const kicks: (string | undefined)[] = [];
	const board = mount(
		"events",
		hosted,
		{
			gh: async (args) => {
				ghCalls.push(args);
				return { code: 0, stdout: "[]", stderr: "" };
			},
			ciWatchTick: async (opts) => {
				kicks.push(opts?.manual);
			},
		},
		{
			projects: [
				{ name: "w1", github: "https://github.com/acme/widget" },
				{ name: "w2", github: "https://github.com/acme/other" },
			],
		},
	);

	/** One webhook POST as the control plane forwards it. */
	const event = (
		id: string,
		name: string,
		body: unknown,
		role: IdentityRole | "forged" = "control",
	) =>
		board.call("/api/hosted/github-event", {
			method: "POST",
			headers: {
				...signed(
					role === "forged" ? "control" : role,
					role === "forged"
						? signIdentity("wrong-secret", TENANT, "control")
						: undefined,
				),
				"x-github-delivery": id,
				...(name !== "" && { "x-github-event": name }),
			},
			body,
		});

	test("a signed control push kicks the CI watch for the matching project", async () => {
		const res = await event("d1", "push", {
			repository: { full_name: "acme/widget" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(kicks).toEqual(["w1"]);
	});

	test("owner, tenant, missing and forged headers never kick", async () => {
		for (const role of ["owner", "tenant"] as const) {
			const res = await event(
				`d-o-${role}`,
				"push",
				{
					repository: { full_name: "acme/widget" },
				},
				role,
			);
			expect(res.status).toBe(403);
		}
		const anon = await board.call("/api/hosted/github-event", {
			method: "POST",
			headers: {
				Host: PUBLIC,
				Origin: `https://${PUBLIC}`,
				"x-github-delivery": "d-anon",
			},
			body: { repository: { full_name: "acme/widget" } },
		});
		expect(anon.status).toBe(401);
		const forged = await event(
			"d-forged",
			"push",
			{
				repository: { full_name: "acme/widget" },
			},
			"forged",
		);
		expect(forged.status).toBe(401);
		expect(kicks).toEqual(["w1"]);
	});

	test("a replayed identity header is 401 on its second use", async () => {
		const header = signIdentity(SECRET, TENANT, "control");
		const send = () =>
			board.call("/api/hosted/github-event", {
				method: "POST",
				headers: {
					...signed("control", header),
					"x-github-delivery": `d-replay-${ghCalls.length}`,
				},
				body: { repository: { full_name: "acme/widget" } },
			});
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(401);
		expect(kicks).toEqual(["w1"]);
	});

	test("a duplicate delivery id answers deduped without a second kick", async () => {
		const first = await event("d2", "push", {
			repository: { full_name: "acme/widget" },
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ ok: true });
		const kicksAfterFirst = kicks.length;
		// Different signed header (the proxy retries with fresh identity), same delivery id.
		const second = await event("d2", "push", {
			repository: { full_name: "acme/widget" },
		});
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ ok: true, deduped: true });
		expect(kicks.length).toBe(kicksAfterFirst);
	});

	test("a push for each repo kicks that project's CI watch once", async () => {
		const w1 = kicks.filter((k) => k === "w1").length;
		const res = await event("d3", "push", {
			repository: { full_name: "acme/other" },
		});
		expect(res.status).toBe(200);
		expect(kicks.filter((k) => k === "w1").length).toBe(w1);
		expect(kicks).toContain("w2");
	});

	test("a pull_request event runs the PR review watch for the matching project only", async () => {
		// The scan gates on the setting (src/prs.ts scan): enable it for both projects,
		// then only the repo the event names may reach the gh fake.
		for (const name of ["w1", "w2"])
			board.projects.get(name)!.store.setSettings({ prReviews: true });
		const callsBefore = ghCalls.length;
		const res = await event("d4", "pull_request", {
			repository: { full_name: "acme/widget" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		const calls = ghCalls.slice(callsBefore).map((args) => args.join(" "));
		expect(calls.some((a) => a.includes("acme/widget"))).toBe(true);
		expect(calls.some((a) => a.includes("acme/other"))).toBe(false);
		expect(kicks.filter((k) => k !== "w1" && k !== "w2")).toEqual([]);
	});

	test("an issues event runs the issue watch for the matching project only", async () => {
		// The issue scan gates on the setting and reads issueWatchSince as its mark
		// (src/issues.ts scanProject): set both, one shared mark per project is enough.
		for (const name of ["w1", "w2"])
			board.projects
				.get(name)!
				.store.setSettings({ issueWatch: true, issueWatchSince: 1 });
		const callsBefore = ghCalls.length;
		const res = await event("d5", "issues", {
			repository: { full_name: "acme/widget" },
		});
		expect(res.status).toBe(200);
		const calls = ghCalls.slice(callsBefore).map((args) => args.join(" "));
		expect(calls.some((a) => a.includes("acme/widget"))).toBe(true);
		expect(calls.some((a) => a.includes("acme/other"))).toBe(false);
	});

	test("an unknown repo or event is a no-op", async () => {
		const repoCalls = ghCalls.length;
		const kicksBefore = kicks.length;
		const unknownRepo = await event("d-unk-repo", "push", {
			repository: { full_name: "github.com/nobody/nowhere" },
		});
		expect(unknownRepo.status).toBe(200);
		expect(await unknownRepo.json()).toEqual({ ok: true });
		const unknownEvent = await event("d-unk-event", "fork", {
			repository: { full_name: "acme/widget" },
		});
		expect(unknownEvent.status).toBe(200);
		expect(await unknownEvent.json()).toEqual({ ok: true });
		expect(kicks.length).toBe(kicksBefore);
		expect(ghCalls.length).toBe(repoCalls);
	});

	test("a missing X-GitHub-Delivery header is 400", async () => {
		const res = await board.call("/api/hosted/github-event", {
			method: "POST",
			headers: signed("control"),
			body: { repository: { full_name: "acme/widget" } },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "x-github-delivery header required",
		});
	});
});

describe("self-hosted board (hosted mode off)", () => {
	const board = mount("self", undefined);

	test("/api/setup stays open and /api/hosted/stop and /release do not exist", async () => {
		const setup = await board.call("/api/setup", {
			headers: loopback,
			body: {},
		});
		expect(setup.status).toBe(400);
		const stop = await board.call("/api/hosted/stop", {
			method: "POST",
			headers: { ...loopback, ...signed("control") },
		});
		expect(stop.status).toBe(404);
		expect(board.stops).toEqual([]);
		const release = await board.call("/api/hosted/release", {
			method: "POST",
			headers: { ...loopback, ...signed("control") },
		});
		expect(release.status).toBe(404);
		expect(await release.json()).toEqual({ error: "not found" });
		expect(board.releases).toEqual([]);
		// The forwarded GitHub-event route joins stop behind the hosted flag.
		const ghEvent = await board.call("/api/hosted/github-event", {
			method: "POST",
			headers: { ...loopback, ...signed("control") },
			body: { repository: { full_name: "acme/widget" } },
		});
		expect(ghEvent.status).toBe(404);
		expect(await ghEvent.json()).toEqual({ error: "not found" });
		// Direct loopback stays zero-auth, and the identity header means nothing.
		expect(
			(
				await board.call("/api/state", {
					headers: { ...signed("owner"), ...loopback },
				})
			).status,
		).toBe(200);
	});
});

describe("turnEnv lending in hosted mode", () => {
	test("lend: false lends no provider token the board store holds", async () => {
		const agent = join(root, "agent");
		mkdirSync(agent, { recursive: true });
		const dbPath = join(agent, "agent.db");
		const db = new Database(dbPath);
		db.exec(
			"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)",
		);
		const now = Date.now();
		db.query(
			"INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES ('anthropic', 'oauth', ?, 'acct-1', 1, 1)",
		).run(
			JSON.stringify({
				access: "access-fake",
				refresh: "refresh-fake",
				expires: now + 8 * 3_600_000,
			}),
		);
		db.close();
		const home = join(root, "home");
		const opts = { dbPath, now, home };
		const model = "anthropic/claude-opus-5-5";
		const self = await turnEnv("p1", model, {}, opts);
		expect(self.env).toEqual({ ANTHROPIC_OAUTH_TOKEN: "access-fake" });
		const off = await turnEnv("p1", model, {}, { ...opts, lend: false });
		expect(off).toEqual({
			env: {},
			missing: [],
			credentialError: null,
			busy: undefined,
			secrets: [],
		});
	});
});

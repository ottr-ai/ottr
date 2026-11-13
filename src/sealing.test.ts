import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { type App, createApp } from "./app.ts";
import { GlobalStore } from "./globalStore.ts";
import { sealStoredConfigRow } from "./sealedConfig.ts";
import { isSealed, loadSecretBox, type SecretBox } from "./secretBox.ts";

// ADR-0011 app-level sealing: the config row's token/key fields are sealed at rest with the
// real SecretBox + GlobalStore, booted through createApp (loopback, so no auth wall).

const root = mkdtempSync(join(tmpdir(), "ottr-sealing-"));
const home = mkdtempSync(join(tmpdir(), "ottr-sealing-home-"));
// Pinned board omp home and agent dir: boot never touches the real ~/.omp.
process.env.OTTR_BOARD_OMP_HOME = join(home, "omp-home");
mkdirSync(join(home, "agent"), { recursive: true });
writeFileSync(join(home, "agent", "config.yml"), "modelRoles: {}\n");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
// One project env list naming HS_TOKEN, so the env route lists the stored spot.
const workersHome = join(root, "workers");
mkdirSync(join(workersHome, ".ottr", "workers", "w1"), { recursive: true });
writeFileSync(
	join(workersHome, ".ottr", "workers", "w1", "env.txt"),
	"HS_TOKEN\n",
);

const box = loadSecretBox({
	dir: join(root, "board"),
	env: { OTTR_SECRET_KEY: "ab".repeat(32) },
});
// A different board key: a boot with this box cannot open what the first one sealed.
const wrongBox = loadSecretBox({
	dir: join(root, "other"),
	env: { OTTR_SECRET_KEY: "ef".repeat(32) },
});

const API_KEY = "board-api-plain-9f3a";
const SESSION = "session-secret-plain-9f3a";
const GH_TOKEN = `ghp_${"a".repeat(36)}`;
const ALATE_KEY = "alate-key-plain-9f3a";
const GIT_TOKEN = "git-token-plain-9f3a";
const TURN_TOKEN = "turn-read-token-plain-9f3a";
const ENV_VALUE = "env-value-plain-9f3a";
const HS_TOKEN = "hindsight-plain-0000";

/** A fully populated plaintext config row. */
function plainRow(): Record<string, unknown> {
	return {
		maxTotal: 3,
		reviewCheck: true,
		workCheck: true,
		idleReviews: true,
		trendingScan: true,
		commitIdentity: null,
		removed: [],
		projects: [],
		projectOrder: [],
		admin: { name: "op", passHash: "scrypt-hash" },
		apiKey: API_KEY,
		sessionSecret: SESSION,
		sessions: [],
		vapid: null,
		alate: { url: "http://127.0.0.1:9", key: ALATE_KEY },
		githubToken: GH_TOKEN,
		githubHost: "github.com",
		gitTokens: [{ host: "github.com", username: "u", token: GIT_TOKEN }],
		turnReadTokens: [
			{
				host: "github.com",
				token: TURN_TOKEN,
				status: "ok",
				detail: "Turns can use this token",
				confirmed: false,
			},
		],
		githubApp: null,
		envValues: { HS_TOKEN: ENV_VALUE },
		hindsightToken: HS_TOKEN,
		hindsightUrl: "http://127.0.0.1:9",
	};
}

/** The row with every ADR-0011 spot sealed under the given box. */
function sealedRow(b: SecretBox): Record<string, unknown> {
	const r = plainRow();
	r.apiKey = b.seal(API_KEY);
	r.sessionSecret = b.seal(SESSION);
	r.githubToken = b.seal(GH_TOKEN);
	r.hindsightToken = b.seal(HS_TOKEN);
	r.alate = { url: "http://127.0.0.1:9", key: b.seal(ALATE_KEY) };
	r.gitTokens = [
		{ host: "github.com", username: "u", token: b.seal(GIT_TOKEN) },
	];
	r.turnReadTokens = [
		{
			host: "github.com",
			token: b.seal(TURN_TOKEN),
			status: "ok",
			detail: "Turns can use this token",
			confirmed: false,
		},
	];
	r.envValues = { HS_TOKEN: b.seal(ENV_VALUE) };
	return r;
}

async function storedRow(g: GlobalStore): Promise<Record<string, unknown>> {
	const row = await g.get<Record<string, unknown>>("config");
	if (typeof row !== "object" || row === null)
		throw new Error("no config row stored");
	return row;
}

const servers: Server<undefined>[] = [];
const apps: App[] = [];
const stores: GlobalStore[] = [];
const databases: Database[] = [];

interface Boot {
	call: (
		path: string,
		body?: unknown,
		method?: string,
	) => Promise<{
		status: number;
		text: string;
		json: Record<string, unknown>;
	}>;
}

async function boot(gstore: GlobalStore, secretBox?: SecretBox): Promise<Boot> {
	const app = await createApp({
		gstore,
		defaultDir: root,
		// Server-only ssh state and env.txt lists: root subdirs, never the real home.
		sshDir: join(root, "ssh"),
		workersHome,
		projects: new Map(),
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
			idleReviews: true,
			trendingScan: true,
			commitIdentity: null,
			removedPaths: [],
			projectPaths: [],
			projectOrder: [],
			envValues: {},
			envPlain: {},
		},
		serverRef: { current: undefined },
		secretBox,
		githubTokenExpiry: async () => null,
	});
	apps.push(app);
	const srv = Bun.serve({ port: 0, ...app.serveOptions });
	app.serverRef.current = srv;
	servers.push(srv);
	return {
		call: async (path, body, method) => {
			const res = await fetch(new URL(path, srv.url), {
				method: method ?? (body === undefined ? "GET" : "POST"),
				headers: {
					"content-type": "application/json",
					Host: "127.0.0.1:0",
					Origin: "http://127.0.0.1:0",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await res.text();
			return {
				status: res.status,
				text,
				json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
			};
		},
	};
}

/** A git token row's readable flag from the git-hosts view. */
function tokenRow(json: Record<string, unknown>): Record<string, unknown> {
	const tokens = json.tokens as Record<string, unknown>[];
	return tokens[0]!;
}

afterAll(async () => {
	for (const s of servers) s.stop(true);
	for (const app of apps) await app.close();
	for (const d of databases) d.close();
	for (const g of stores) await g.close();
	delete process.env.OTTR_BOARD_OMP_HOME;
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.GH_TOKEN;
	delete process.env.HINDSIGHT_API_URL;
	delete process.env.HINDSIGHT_API_TOKEN;
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

describe("ADR-0011 config row sealing", () => {
	test("a plaintext row is sealed in the store after a boxed boot", async () => {
		const g = await GlobalStore.open(join(root, "g-plain"));
		stores.push(g);
		await g.set("config", plainRow());
		await boot(g, box);
		const row = await storedRow(g);
		expect(isSealed(row.apiKey as string)).toBe(true);
		expect(isSealed(row.sessionSecret as string)).toBe(true);
		expect(isSealed(row.githubToken as string)).toBe(true);
		expect(isSealed(row.hindsightToken as string)).toBe(true);
		expect(isSealed((row.alate as Record<string, string>).key)).toBe(true);
		expect(row.vapid).toBeNull();
		for (const t of row.gitTokens as Record<string, string>[])
			expect(isSealed(t.token)).toBe(true);
		for (const t of row.turnReadTokens as Record<string, string>[])
			expect(isSealed(t.token)).toBe(true);
		for (const v of Object.values(row.envValues as Record<string, string>))
			expect(isSealed(v)).toBe(true);
		// The runtime opened the row: the stored values come back as plaintext.
		expect(box.open(row.apiKey as string)).toBe(API_KEY);
		expect(box.open((row.alate as Record<string, string>).key as string)).toBe(
			ALATE_KEY,
		);
		expect(
			box.open((row.gitTokens as Record<string, string>[])[0]!.token as string),
		).toBe(GIT_TOKEN);
		expect(
			box.open(
				(row.turnReadTokens as Record<string, string>[])[0]!.token as string,
			),
		).toBe(TURN_TOKEN);
	});

	test("the walker seals a turnReadTokens row's token and keeps an already-sealed one", () => {
		const plain = sealStoredConfigRow(
			{
				turnReadTokens: [
					{
						host: "github.com",
						token: TURN_TOKEN,
						status: "ok",
						detail: "d",
						confirmed: false,
					},
				],
			},
			box,
		);
		expect(plain.changed).toBe(true);
		const sealedToken = (
			(plain.row as Record<string, unknown>).turnReadTokens as Record<
				string,
				unknown
			>[]
		)[0]!.token as string;
		expect(isSealed(sealedToken)).toBe(true);
		expect(box.open(sealedToken)).toBe(TURN_TOKEN);
		// The other row fields pass through; a second walk is a no-op (idempotent).
		const again = sealStoredConfigRow(plain.row, box);
		expect(again.changed).toBe(false);
	});

	test("the stored apiKey is live at runtime after boot", async () => {
		const g = await GlobalStore.open(join(root, "g-apikey"));
		stores.push(g);
		await g.set("config", plainRow());
		const app = await boot(g, box);
		const res = await app.call("/api/settings/api-key");
		expect(res.status).toBe(200);
		expect(res.json.apiKey).toBe(API_KEY);
	});

	test("a wrong-key boot reports set+unreadable and regenerates apiKey", async () => {
		const g = await GlobalStore.open(join(root, "g-wrong"));
		stores.push(g);
		const seeded = sealedRow(box);
		await g.set("config", seeded);
		const app = await boot(g, wrongBox);

		// The board still starts: an open GET answers 200.
		expect((await app.call("/api/boot")).status).toBe(200);

		const gh = await app.call("/api/settings/github-token");
		expect(gh.json.tokenSet).toBe(true);
		expect(gh.json.tokenReadable).toBe(false);

		const hosts = await app.call("/api/git-hosts");
		expect(tokenRow(hosts.json).tokenSet).toBe(true);
		expect(tokenRow(hosts.json).tokenReadable).toBe(false);
		expect(hosts.json.githubTokenSet).toBe(true);
		expect(hosts.json.githubTokenReadable).toBe(false);

		const env = await app.call("/api/settings/env");
		const envRow = (env.json.names as Record<string, unknown>[]).find(
			(r) => r.name === "HS_TOKEN",
		);
		expect(envRow).toBeDefined();
		expect(envRow?.set).toBe(true);
		expect(envRow?.readable).toBe(false);

		const alate = await app.call("/api/alate");
		expect(alate.json.keySet).toBe(true);
		expect(alate.json.keyReadable).toBe(false);

		const hs = await app.call("/api/settings/hindsight");
		expect(hs.json.tokenSet).toBe(true);
		expect(hs.json.tokenReadable).toBe(false);

		const turn = await app.call("/api/settings/turn-github-token");
		const turnRow = (turn.json.tokens as Record<string, unknown>[])[0]!;
		expect(turnRow.tokenSet).toBe(true);
		expect(turnRow.tokenReadable).toBe(false);
		// An env-only token with the stored blob kept: set but unreadable —
		// entering the stored token restores persistence (ADR-0011).
		process.env.HINDSIGHT_API_TOKEN = "env-only-token";
		const hsEnv = await app.call("/api/settings/hindsight");
		delete process.env.HINDSIGHT_API_TOKEN;
		expect(hsEnv.json.tokenSet).toBe(true);
		expect(hsEnv.json.tokenReadable).toBe(false);

		// No settings response holds an operator-entered plaintext or a stored sealed blob.
		const blobs = [
			seeded.githubToken,
			seeded.hindsightToken,
			(seeded.alate as Record<string, string>).key,
			(seeded.gitTokens as Record<string, string>[])[0]!.token,
			(seeded.turnReadTokens as Record<string, string>[])[0]!.token,
			(seeded.envValues as Record<string, string>).HS_TOKEN,
		];
		for (const body of [
			gh.text,
			hosts.text,
			env.text,
			alate.text,
			hs.text,
			turn.text,
		]) {
			for (const secret of [
				GH_TOKEN,
				ALATE_KEY,
				GIT_TOKEN,
				TURN_TOKEN,
				ENV_VALUE,
				HS_TOKEN,
			])
				expect(body).not.toContain(secret);
			for (const blob of blobs) expect(body).not.toContain(blob as string);
		}

		// An unrelated save (general settings, a non-secret route) keeps every unreadable
		// blob; the guarded session-secret rotation would answer 503 under no box, but
		// this boot has a box, so the rotation itself is allowed and stays a valid probe.
		const rotation = await app.call("/api/settings/session-secret", {}, "POST");
		expect(rotation.status).toBe(200);
		const general = await app.call("/api/settings", {});
		expect(general.status).toBe(200);
		const row = await storedRow(g);
		expect(row.githubToken).toBe(seeded.githubToken);
		expect((row.alate as Record<string, string>).key).toBe(
			(seeded.alate as Record<string, string>).key,
		);
		expect((row.gitTokens as Record<string, string>[])[0]!.token).toBe(
			(seeded.gitTokens as Record<string, string>[])[0]!.token,
		);
		expect((row.turnReadTokens as Record<string, string>[])[0]!.token).toBe(
			(seeded.turnReadTokens as Record<string, string>[])[0]!.token,
		);
		expect((row.envValues as Record<string, string>).HS_TOKEN).toBe(
			(seeded.envValues as Record<string, string>).HS_TOKEN,
		);
		expect(row.hindsightToken).toBe(seeded.hindsightToken);
		// The board-generated apiKey was regenerated: it opens under the new key and
		// differs from the old plaintext.
		expect(isSealed(row.apiKey as string)).toBe(true);
		const fresh = wrongBox.open(row.apiKey as string);
		expect(fresh).not.toBeNull();
		expect(fresh).not.toBe(API_KEY);
	});

	test("re-entering the GitHub token replaces an unreadable one", async () => {
		const g = await GlobalStore.open(join(root, "g-reenter"));
		stores.push(g);
		await g.set("config", sealedRow(box));
		const app = await boot(g, wrongBox);
		const NEW = `ghp_${"b".repeat(36)}`;
		const save = await app.call("/api/settings/github-token", { token: NEW });
		expect(save.status).toBe(200);
		const gh = await app.call("/api/settings/github-token");
		expect(gh.json.tokenSet).toBe(true);
		expect(gh.json.tokenReadable).toBe(true);
		const blob = (await storedRow(g)).githubToken as string;
		expect(isSealed(blob)).toBe(true);
		expect(wrongBox.open(blob)).toBe(NEW);
	});

	test("backupTo keeps the snapshot sealed", async () => {
		const g = await GlobalStore.open(join(root, "g-backup"));
		stores.push(g);
		await g.set("config", sealedRow(box));
		await boot(g, box);
		const snapshot = join(root, "snapshot.db");
		await g.backupTo(snapshot);
		const db = new Database(snapshot);
		databases.push(db);
		const value = db
			.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?")
			.get("config")?.value;
		expect(value).toBeDefined();
		const row = JSON.parse(value as string) as Record<string, unknown>;
		expect(isSealed(row.githubToken as string)).toBe(true);
		expect(box.open(row.githubToken as string)).toBe(GH_TOKEN);
	});

	test("a no-box boot leaves sealed blobs and plaintext spots alone; a boxed boot seals", async () => {
		const g = await GlobalStore.open(join(root, "g-nobox"));
		stores.push(g);
		const seeded = plainRow();
		// Mixed row: githubToken, alate key and the env value sealed; the rest plaintext.
		seeded.githubToken = box.seal(GH_TOKEN);
		seeded.alate = { url: "http://127.0.0.1:9", key: box.seal(ALATE_KEY) };
		seeded.envValues = { HS_TOKEN: box.seal(ENV_VALUE) };
		await g.set("config", { ...seeded });

		// Legacy degraded boot: no box anywhere.
		const app = await boot(g, undefined);
		// Guarded credential writes answer 503; the general settings save is the
		// unrelated non-secret save.
		const rotation = await app.call("/api/settings/session-secret", {}, "POST");
		expect(rotation.status).toBe(503);
		expect(rotation.json.error).toBe("OTTR_SECRET_KEY is invalid");
		const general = await app.call("/api/settings", {});
		expect(general.status).toBe(200);
		let row = await storedRow(g);
		expect(row.githubToken).toBe(seeded.githubToken);
		expect((row.alate as Record<string, string>).key).toBe(
			(seeded.alate as Record<string, string>).key,
		);
		expect((row.envValues as Record<string, string>).HS_TOKEN).toBe(
			(seeded.envValues as Record<string, string>).HS_TOKEN,
		);
		// Plaintext spots stay plaintext in legacy mode; the stored-spots swap keeps
		// them byte-identical even though the runtime values changed nothing.
		expect(row.apiKey).toBe(API_KEY);
		expect(row.sessionSecret).toBe(SESSION);

		// The next good boot converges the row to sealed.
		await boot(g, box);
		row = await storedRow(g);
		expect(isSealed(row.apiKey as string)).toBe(true);
		expect(isSealed(row.sessionSecret as string)).toBe(true);
		expect(box.open(row.apiKey as string)).toBe(API_KEY);
		expect(row.githubToken).toBe(seeded.githubToken);
	});

	test("a no-box boot refuses credential writes with 503 and keeps every blob", async () => {
		const g = await GlobalStore.open(join(root, "g-nobox-guard"));
		stores.push(g);
		const seeded = sealedRow(box);
		await g.set("config", seeded);
		const app = await boot(g, undefined);

		const guarded: [string, unknown, string?][] = [
			["/api/setup", { name: "op", password: "longenough1" }],
			["/api/settings/github-token", { token: `ghp_${"c".repeat(36)}` }],
			["/api/git-hosts/tokens", { host: "example.com", token: "t" }],
			["/api/settings/env", { name: "HS_TOKEN", value: "v" }],
			["/api/settings/api-key", {}, "POST"],
			["/api/settings/session-secret", {}, "POST"],
			["/api/settings/hindsight", { url: "http://127.0.0.1:9", token: "k" }],
			["/api/alate", { url: "http://127.0.0.1:9", key: ALATE_KEY }],
		];
		for (const [path, body, method] of guarded) {
			const res = await app.call(path, body, method);
			expect(res.status).toBe(503);
			expect(res.json.error).toBe("OTTR_SECRET_KEY is invalid");
		}
		// The stored row kept every blob byte-identical.
		const row = await storedRow(g);
		expect(row.githubToken).toBe(seeded.githubToken);
		expect(row.apiKey).toBe(seeded.apiKey);
		expect(row.sessionSecret).toBe(seeded.sessionSecret);
		expect((row.alate as Record<string, string>).key).toBe(
			(seeded.alate as Record<string, string>).key,
		);
		expect((row.gitTokens as Record<string, unknown>[])[0]!.token).toBe(
			(seeded.gitTokens as Record<string, unknown>[])[0]!.token,
		);
		expect((row.envValues as Record<string, string>).HS_TOKEN).toBe(
			(seeded.envValues as Record<string, string>).HS_TOKEN,
		);
		expect(row.hindsightToken).toBe(seeded.hindsightToken);
	});

	test("a no-box boot regenerates apiKey in memory but never persists it; an explicit alate clear lands", async () => {
		const g = await GlobalStore.open(join(root, "g-nobox-regen"));
		stores.push(g);
		const seeded = sealedRow(box);
		await g.set("config", seeded);
		const app = await boot(g, undefined);
		// Board-generated secrets regenerate in memory; the general save keeps the
		// stored blobs byte-identical (blocker 1B), the regen is not persisted.
		const general = await app.call("/api/settings", {});
		expect(general.status).toBe(200);
		let row = await storedRow(g);
		expect(row.apiKey).toBe(seeded.apiKey);
		expect(row.sessionSecret).toBe(seeded.sessionSecret);
		// The explicit alate key clear is allowed and drops the kept blob (blocker 2).
		const clear = await app.call("/api/alate", { key: null });
		expect(clear.status).toBe(200);
		expect(clear.json.keySet).toBe(false);
		row = await storedRow(g);
		expect((row.alate as Record<string, unknown>).key).toBeNull();
		// The GitHub App delete clears the stored app too.
		const del = await app.call(
			"/api/git-hosts/github-app",
			undefined,
			"DELETE",
		);
		expect(del.status).toBe(200);
		expect((await storedRow(g)).githubApp).toBeNull();
	});

	test("a wrong-key boot lets an explicit alate clear win over the kept blob", async () => {
		const g = await GlobalStore.open(join(root, "g-wrong-clear"));
		stores.push(g);
		await g.set("config", sealedRow(box));
		const app = await boot(g, wrongBox);
		const view = await app.call("/api/alate");
		expect(view.json.keySet).toBe(true);
		expect(view.json.keyReadable).toBe(false);
		const clear = await app.call("/api/alate", { key: null });
		expect(clear.status).toBe(200);
		expect(clear.json.keySet).toBe(false);
		expect(
			((await storedRow(g)).alate as Record<string, unknown>).key,
		).toBeNull();
	});

	test("VAPID regeneration rebinds subs to the outgoing key and reports stale", async () => {
		const g = await GlobalStore.open(join(root, "g-vapid"));
		stores.push(g);
		const seeded = sealedRow(box);
		const OLD_PUBLIC = `old-public-key-B${"0".repeat(56)}`;
		seeded.vapid = {
			publicKey: OLD_PUBLIC,
			privateKey: box.seal("vapid-private-plain-9f3a"),
			subject: "https://github.com/ottr-ai/ottr",
		};
		const boundEndpoint = "https://push.example.com/bound";
		const legacyEndpoint = "https://push.example.com/legacy";
		await g.set("config", seeded);
		await g.set("push_vapid_key", OLD_PUBLIC);
		await g.set("push_subs", [
			{
				endpoint: boundEndpoint,
				keys: { p256dh: "p", auth: "a" },
				addedAt: 1,
				classes: { request: true, error: true, complete: true },
				vapidPublicKey: OLD_PUBLIC,
			},
			{
				// Legacy sub without a bound key: recovery rebinds it to the
				// outgoing key so the stale rule covers it too.
				endpoint: legacyEndpoint,
				keys: { p256dh: "p", auth: "a" },
				addedAt: 2,
				classes: { request: true, error: true, complete: true },
			},
		]);
		const app = await boot(g, wrongBox);
		// The first push path regenerates the pair and rebinds, never deletes:
		// both rows remain in the store.
		const config = await app.call("/api/push/config");
		expect(config.status).toBe(200);
		const subs = (await g.get<Record<string, unknown>[]>("push_subs")) ?? [];
		expect([...subs].map((s) => s.endpoint).sort()).toEqual(
			[boundEndpoint, legacyEndpoint].sort(),
		);
		// The bound sub keeps its own stamp; the legacy sub is rebound to the
		// outgoing key, the only key it could have been created under.
		const bound = subs.find((s) => s.endpoint === boundEndpoint)!;
		const legacy = subs.find((s) => s.endpoint === legacyEndpoint)!;
		expect(bound.vapidPublicKey).toBe(OLD_PUBLIC);
		expect(legacy.vapidPublicKey).toBe(OLD_PUBLIC);
		// Both now report stale, so a recovering device re-subscribes; an
		// unknown endpoint does not.
		const staleBound = await app.call(
			`/api/push/config?endpoint=${encodeURIComponent(boundEndpoint)}`,
		);
		expect(staleBound.json.stale).toBe(true);
		const staleLegacy = await app.call(
			`/api/push/config?endpoint=${encodeURIComponent(legacyEndpoint)}`,
		);
		expect(staleLegacy.json.stale).toBe(true);
		const unknown = await app.call("/api/push/config?endpoint=nope");
		expect(unknown.json.stale).toBe(false);
		// A new subscribe stamps the current public key.
		const sub = await app.call("/api/push/subscribe", {
			endpoint: "https://push.example.com/new",
			keys: { p256dh: "p", auth: "a" },
		});
		expect(sub.status).toBe(200);
		const stored = (await g.get<Record<string, unknown>[]>("push_subs")) ?? [];
		const fresh = stored.find(
			(s) => s.endpoint === "https://push.example.com/new",
		);
		expect(fresh?.vapidPublicKey).toBe(config.json.publicKey);
	});

	test("a restored board without the kv marker rebinds legacy subs to the stored public key", async () => {
		const g = await GlobalStore.open(join(root, "g-vapid-nokv"));
		stores.push(g);
		const seeded = sealedRow(box);
		const OLD_PUBLIC = `old-public-key-C${"1".repeat(56)}`;
		seeded.vapid = {
			publicKey: OLD_PUBLIC,
			// Sealed under key A: a wrong-key boot cannot read it, but the
			// outgoing public key is plaintext and still binds the subs.
			privateKey: box.seal("vapid-private-plain-4c7e"),
			subject: "https://github.com/ottr-ai/ottr",
		};
		const legacyEndpoint = "https://push.example.com/legacy-nokv";
		await g.set("config", seeded);
		await g.set("push_subs", [
			{
				endpoint: legacyEndpoint,
				keys: { p256dh: "p", auth: "a" },
				addedAt: 1,
				classes: { request: true, error: true, complete: true },
			},
		]);
		const app = await boot(g, wrongBox);
		const config = await app.call("/api/push/config");
		expect(config.status).toBe(200);
		const subs = (await g.get<Record<string, unknown>[]>("push_subs")) ?? [];
		const legacy = subs.find((s) => s.endpoint === legacyEndpoint)!;
		expect(legacy.vapidPublicKey).toBe(OLD_PUBLIC);
		const stale = await app.call(
			`/api/push/config?endpoint=${encodeURIComponent(legacyEndpoint)}`,
		);
		expect(stale.json.stale).toBe(true);
	});

	test("a wrong-key boot keeps the stored vapid row through a config save and rebinds after a restart", async () => {
		const g = await GlobalStore.open(join(root, "g-vapid-save"));
		stores.push(g);
		const seeded = sealedRow(box);
		const OLD_PUBLIC = "old-pub";
		const SEALED_PRIVATE = box.seal("vapid-private-plain-7b1d");
		seeded.vapid = {
			publicKey: OLD_PUBLIC,
			// Sealed under key A: a wrong-key boot cannot read it.
			privateKey: SEALED_PRIVATE,
			subject: "https://github.com/ottr-ai/ottr",
		};
		const legacyEndpoint = "https://push.example.com/legacy-save";
		await g.set("config", seeded);
		// NO push_vapid_key kv: recovery must capture the outgoing key itself.
		await g.set("push_subs", [
			{
				endpoint: legacyEndpoint,
				keys: { p256dh: "p", auth: "a" },
				addedAt: 1,
				classes: { request: true, error: true, complete: true },
			},
		]);
		const app = await boot(g, wrongBox);
		// Any config save must not erase the unreadable stored row: the outgoing
		// key is plaintext inside it and a later boot needs it to rebind subs.
		const saved = await app.call("/api/settings", {});
		expect(saved.status).toBe(200);
		const row = await storedRow(g);
		expect(row.vapid).toEqual({
			publicKey: OLD_PUBLIC,
			privateKey: SEALED_PRIVATE,
			subject: "https://github.com/ottr-ai/ottr",
		});
		// The marker was persisted at capture, before the save could drop the row.
		expect(await g.get<string | null>("push_vapid_key")).toBe(OLD_PUBLIC);
		// A restart on the same store (wrong key again) still rebinds: stale.
		const app2 = await boot(g, wrongBox);
		const stale = await app2.call(
			`/api/push/config?endpoint=${encodeURIComponent(legacyEndpoint)}`,
		);
		expect(stale.json.stale).toBe(true);
	});

	test("a no-box fresh board answers push config and never persists the generated pair", async () => {
		const g = await GlobalStore.open(join(root, "g-nobox-vapid"));
		stores.push(g);
		await g.set("config", plainRow());
		const app = await boot(g, undefined);
		const config = await app.call("/api/push/config");
		expect(config.status).toBe(200);
		expect(typeof config.json.publicKey).toBe("string");
		// The generated pair stays in memory only: no plaintext private key at
		// rest (the next good boot seals it).
		expect((await storedRow(g)).vapid).toBeNull();
	});

	test("an empty-string alate key normalizes to a real clear", async () => {
		for (const [name, appBox] of [
			["wrong-key", wrongBox],
			["no-box", undefined],
		] as const) {
			const g = await GlobalStore.open(join(root, `g-alate-empty-${name}`));
			stores.push(g);
			await g.set("config", sealedRow(box));
			const app = await boot(g, appBox);
			const view = await app.call("/api/alate");
			expect(view.json.keySet).toBe(true);
			const clear = await app.call("/api/alate", { key: "" });
			expect(clear.status).toBe(200);
			expect(clear.json.keySet).toBe(false);
			expect(
				((await storedRow(g)).alate as Record<string, unknown>).key,
			).toBeNull();
		}
	});
});

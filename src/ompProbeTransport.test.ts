import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	buildRedactedStore,
	createOmpProbeTransport,
	probeJobArgv,
	probePrepSpawn,
	probeSpawnEnv,
	probeWrapperSource,
} from "./ompProbeTransport.ts";
import { OMP_PACKAGE_URL } from "./ompWatch.ts";
import type { ProcSpawn } from "./sandboxRun.ts";

// Per-test real-fs scratch; everything a test builds dies with its dir.
const tmps: string[] = [];
const newTmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ottr-omp-probe-test-"));
	tmps.push(dir);
	return dir;
};
// The transport reads the board store through agentDir(), which resolves
// process.env.PI_CODING_AGENT_DIR directly (not through the env seam): each
// harness pins it and registers the restore, and afterAll unwinds them.
const envRestores: (() => void)[] = [];
const pinProcessEnv = (name: string, value: string | undefined): void => {
	const saved = process.env[name];
	process.env[name] = value;
	envRestores.push(() => {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	});
};
afterAll(() => {
	for (const dir of tmps) rmSync(dir, { recursive: true, force: true });
	for (const restore of envRestores) restore();
});

const ID = "ompprobe-test-1";
const PROJECT = "ottr";
const TOKEN = "tok-redact-me-42";
const TARBALL_URL = "https://registry.test/pkg/-/pkg-18.16.0.tgz";
const VERSION = "18.16.0";
// Arbitrary bytes: the fake spawn builds the tree, so the tar never unpacks
// here — only its sha512 travels through the integrity check.
const FAKE_TGZ = new TextEncoder().encode("fake candidate tarball bytes");
const FAKE_DIGEST = new Bun.CryptoHasher("sha512")
	.update(FAKE_TGZ)
	.digest("base64");
const CATALOG_JSON = '{"models":[{"provider":"zai","id":"glm-6.2"}]}';

const packument = (integrity: string): unknown => ({
	name: "@oh-my-pi/pi-coding-agent",
	versions: {
		[VERSION]: {
			version: VERSION,
			dist: { tarball: TARBALL_URL, integrity },
		},
	},
});

// A full ValidateResponse body around one job outcome; the transport reads
// only job, so limits/logTail stay filler.
const jobResponse = (job: unknown): Response =>
	new Response(
		JSON.stringify({
			id: ID,
			selfCheck: null,
			missingControl: null,
			job,
			artifacts: [],
			limits: {},
			bootMs: 12,
			totalMs: 34,
			logTail: "",
			resultSource: "guest",
		}),
		{ status: 200 },
	);

const okJob = (): Record<string, unknown> => ({
	argv: [],
	cwd: "/target",
	exitCode: 0,
	signal: null,
	timedOut: false,
	stdoutTail: CATALOG_JSON,
	stderrTail: "",
});

const okSpawn = () => ({ code: 0, stdout: new Uint8Array(), stderr: "" });

/** One harness per test: real fs, fixed id, controlled env, fake npm registry
 * and fake /validate. Every spawn is recorded and answered by shape. The
 * board store lives at PI_CODING_AGENT_DIR (the transport reads it through
 * `agentDir()`); a decoy store rides the old OTTR_PINNED_AGENT_DB name, so an
 * implementation that reads the wrong source fails the payload assertions. */
function makeHarness(opts: {
	/** Overrides or blanks env names (undefined blanks). */
	envOverride?: Record<string, string | undefined>;
	/** The bin entry both the source and the installed package.json carry. */
	bin?: unknown;
	/** Packument integrity override (default: the real digest of FAKE_TGZ). */
	integrity?: string;
	/** Overrides the board-store path the pinned PI_CODING_AGENT_DIR names. */
	boardDbPath?: string;
	/** False skips building the board fixture at boardDbPath: the pinned
	 * PI_CODING_AGENT_DIR then names a directory with no agent.db, and the
	 * redacted copy must degrade to empty. */
	buildBoardStore?: boolean;
	/** Answers POST /validate; default: 200 with a successful job. */
	respondValidate?: (
		url: string,
		body: unknown,
		signal: AbortSignal | null | undefined,
	) => Response | Promise<Response>;
}): {
	transport: (
		project: string,
		version: string,
		timeoutMs: number,
	) => Promise<{ code: number; stdout: string; stderr: string }>;
	runDir: string;
	spawns: string[][];
	validateUrls: string[];
	validateBodies: Record<string, unknown>[];
	validateTarExisted: boolean[];
	payloadProviders: string[][];
	env: NodeJS.ProcessEnv;
	boardDbPath: string;
	decoyDbPath: string;
} {
	const tmp = newTmp();
	const dataRoot = join(tmp, "data");
	const boardDbPath = opts.boardDbPath ?? join(tmp, "board-store", "agent.db");
	const decoyDbPath = join(tmp, "decoy-store", "agent.db");
	// The board store: one zai row with an identity_key (blocker 3's leak
	// witness) and a secret-shaped key. The decoy under the old env name
	// carries a different provider: reading it instead of the board store
	// fails the payload assertions below. Skipped when the test wants a
	// missing store at the pinned path.
	if (opts.buildBoardStore !== false)
		makePinnedDb(boardDbPath, [
			{
				provider: "zai",
				credential_type: "api_key",
				data: { key: "SECRET-KEY-VALUE", source: "user" },
				identity_key: "user@example.com",
			},
		]);
	makePinnedDb(decoyDbPath, [
		{
			provider: "llama.cpp",
			credential_type: "api_key",
			data: { key: "DECOY-KEY-VALUE", source: "decoy" },
		},
	]);
	const env: NodeJS.ProcessEnv = {
		OTTR_VM_RUNNER_URL: "http://runner.test/",
		OTTR_WORKER_TOKEN: TOKEN,
		// The old, wrong store source: the transport must ignore it.
		OTTR_PINNED_AGENT_DB: decoyDbPath,
		...opts.envOverride,
	};
	pinProcessEnv(
		"PI_CODING_AGENT_DIR",
		opts.boardDbPath ? join(boardDbPath, "..") : join(tmp, "board-store"),
	);
	const spawns: string[][] = [];
	const validateUrls: string[] = [];
	const validateBodies: Record<string, unknown>[] = [];
	const validateTarExisted: boolean[] = [];
	const payloadProviders: string[][] = [];
	const bin = opts.bin ?? { omp: "dist/cli.js" };
	// A minimal lockfile fixture: the candidate plus one dep, both with
	// checksums, exactly the shape the transport's payload builder reads.
	const LOCK_JSON = JSON.stringify({
		lockfileVersion: 1,
		packages: {
			"@oh-my-pi/pi-coding-agent@18.16.0": [
				"@oh-my-pi/pi-coding-agent@18.16.0",
				"",
				{},
				`sha512-${FAKE_DIGEST}`,
			],
			"string-width@7.2.0": [
				"string-width@7.2.0",
				"",
				{},
				`sha512-${FAKE_DIGEST}`,
			],
		},
	});
	const spawnImpl: ProcSpawn = async (argv) => {
		spawns.push([...argv]);
		if (
			argv[0] === "bun" &&
			argv[1] === "install" &&
			argv.includes("--lockfile-only")
		) {
			const dir = argv[argv.indexOf("--cwd") + 1]!;
			writeFileSync(join(dir, "bun.lock"), LOCK_JSON);
			return okSpawn();
		}
		if (argv[0] === "tar" && argv.includes("-xOzf")) {
			// Member-only manifest read: the stdout carries the package.json.
			return {
				code: 0,
				stdout: new TextEncoder().encode(
					JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", bin }),
				),
				stderr: "",
			};
		}
		if (argv[0] === "tar" && argv.includes("-cf")) {
			writeFileSync(argv[3]!, "payload tar bytes");
			return okSpawn();
		}
		return {
			code: 127,
			stdout: new Uint8Array(),
			stderr: `unexpected spawn: ${argv.join(" ")}`,
		};
	};
	const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === OMP_PACKAGE_URL)
			return Promise.resolve(
				new Response(
					JSON.stringify(packument(opts.integrity ?? `sha512-${FAKE_DIGEST}`)),
					{
						status: 200,
					},
				),
			);
		if (url === TARBALL_URL) return Promise.resolve(new Response(FAKE_TGZ));
		if (url === `${new URL(OMP_PACKAGE_URL).origin}/string-width`)
			return Promise.resolve(
				new Response(
					JSON.stringify({
						versions: {
							"7.2.0": {
								dist: {
									tarball:
										"https://registry.test/string-width/-/string-width-7.2.0.tgz",
									integrity: `sha512-${FAKE_DIGEST}`,
								},
							},
						},
					}),
					{ status: 200 },
				),
			);
		if (url === "https://registry.test/string-width/-/string-width-7.2.0.tgz")
			return Promise.resolve(new Response(FAKE_TGZ));
		if (url.endsWith("/validate")) {
			validateUrls.push(url);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			validateBodies.push(body);
			validateTarExisted.push(existsSync(String(body.targetTar)));
			// The payload store's providers, read at dispatch time: the copy
			// the candidate will see must hold the board's rows, never the
			// decoy's.
			const storeDb = join(
				body.targetTar as string,
				"..",
				"payload",
				"store",
				"agent.db",
			);
			const providers: string[] = [];
			try {
				const db = new Database(resolve(storeDb), { readonly: true });
				try {
					for (const row of db
						.query("SELECT provider FROM auth_credentials")
						.all() as { provider: string }[])
						providers.push(row.provider);
				} finally {
					db.close();
				}
			} catch {
				// A missing store records as empty.
			}
			payloadProviders.push(providers.sort());
			return Promise.resolve(
				opts.respondValidate
					? opts.respondValidate(url, validateBodies.at(-1), init?.signal)
					: jobResponse(okJob()),
			);
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	}) as typeof fetch;
	const transport = createOmpProbeTransport({
		env: () => env,
		fetchImpl,
		spawnImpl,
		dataRoot,
		idFactory: () => ID,
	});
	return {
		transport,
		runDir: join(dataRoot, PROJECT, "omp-probe-jobs", ID),
		spawns,
		validateUrls,
		validateBodies,
		validateTarExisted,
		payloadProviders,
		env,
		boardDbPath,
		decoyDbPath,
	};
}

/** A synthetic pinned store with the omp auth schema; `rows` carry the
 * secret-shaped data the redaction must erase. */
function makePinnedDb(
	path: string,
	rows: {
		provider: string;
		credential_type: string;
		data: unknown;
		identity_key?: string;
		disabled_cause?: string;
	}[],
	version = 8,
): void {
	mkdirSync(join(path, ".."), { recursive: true });
	rmSync(path, { force: true });
	const db = new Database(path);
	try {
		db.exec(
			"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)",
		);
		db.exec(
			"CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)",
		);
		db.exec(
			"CREATE TABLE auth_change_revision (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)",
		);
		db.run("INSERT INTO auth_schema_version (id, version) VALUES (1, ?)", [
			version,
		]);
		db.run("INSERT INTO auth_change_revision (id, revision) VALUES (1, 1)");
		for (const row of rows)
			db.run(
				"INSERT INTO auth_credentials (provider, credential_type, data, identity_key, disabled_cause) VALUES (?, ?, ?, ?, ?)",
				[
					row.provider,
					row.credential_type,
					JSON.stringify(row.data),
					row.identity_key ?? null,
					row.disabled_cause ?? null,
				],
			);
	} finally {
		db.close();
	}
}

describe("ompProbeTransport", () => {
	test("config: a missing env name or a non-x.y.z version throws before any effect", async () => {
		const { transport, env, spawns } = makeHarness({});
		for (const name of ["OTTR_VM_RUNNER_URL", "OTTR_WORKER_TOKEN"]) {
			const broken = makeHarness({
				envOverride: { [name]: undefined },
			});
			await expect(broken.transport(PROJECT, VERSION, 30_000)).rejects.toThrow(
				name,
			);
		}
		await expect(transport(PROJECT, "18.16.0-x", 30_000)).rejects.toThrow(
			"omp models probe: version is not x.y.z: 18.16.0-x",
		);
		await expect(transport(PROJECT, "x; rm -rf /", 30_000)).rejects.toThrow(
			"version is not x.y.z",
		);
		// Every config throw ran before the first spawn and left no run dir.
		expect(spawns).toEqual([]);
		expect(env.OTTR_VM_RUNNER_URL).toBe("http://runner.test/");
	}, 30_000);

	test("happy path: pack, dispatch /validate, map the job outcome", async () => {
		const h = makeHarness({});
		const res = await h.transport(PROJECT, VERSION, 30_000);
		expect(res).toEqual({ code: 0, stdout: CATALOG_JSON, stderr: "" });
		// The base strips its trailing slash; the POST lands on /validate.
		expect(h.validateUrls).toEqual(["http://runner.test/validate"]);
		const body = h.validateBodies[0]!;
		expect(body.id).toBe(ID);
		expect(body.project).toBe(PROJECT);
		expect(String(body.targetTar)).toMatch(
			/omp-probe-jobs\/ompprobe-test-1\/target\.tar$/,
		);
		// The tar exists while the call runs (the runner reads it from this path);
		// the handler records it at dispatch time, before the runDir cleanup.
		expect(h.validateTarExisted[0]).toBe(true);
		expect("lists" in body).toBe(false);
		expect("taskId" in body).toBe(false);
		expect("collect" in body).toBe(false);
		// Key type for a typeof-verified JSON body: the wire shape is the contract.
		const job = body.job as Record<string, unknown>;
		expect(Object.keys(job).every((k) => k === "argv" || k === "cwd")).toBe(
			true,
		);
		const argv = Array.isArray(job.argv) ? job.argv : [];
		// The job runs the payload's trusted wrapper, which installs the
		// payload offline inside the guest, stamps the redacted store into the
		// job HOME, and spawns the candidate under the three-name env
		// allowlist (probeWrapperSource, unit-tested below).
		expect(argv[0]).toBe("bun");
		expect(argv[1]).toBe("/target/pkg/probe-wrapper.mjs");
		expect(String(argv[2])).toContain(
			"/target/pkg/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
		);
		expect(job.cwd).toBe("/target");
		// Flow order: read the candidate's manifest from the tarball, resolve
		// the dependency graph metadata-only (no extract, no install on the
		// server), pack payload + registry + store.
		expect(h.spawns.length).toBe(3);
		expect(h.spawns[0]![0]).toBe("tar");
		expect(h.spawns[0]).toContain("-xOzf");
		expect(h.spawns[0]).toContain("package/package.json");
		expect(h.spawns[1]![0]).toBe("bun");
		expect(h.spawns[1]).toContain("--lockfile-only");
		expect(h.spawns[1]).toContain("--ignore-scripts");
		expect(h.spawns[2]![0]).toBe("tar");
		expect(h.spawns[2]).toContain("-cf");
		expect(h.spawns[2]).toContain("--hard-dereference");
		expect(h.spawns[2]).toContain("registry");
		// No install tree ever exists on the server: the payload ships
		// integrity-pinned tarballs and the lockfile's file: map only.
		expect(h.spawns.some((a) => a.includes("add"))).toBe(false);
		// The redacted copy carries the board store's rows (the transport
		// reads agentDir(), the same file signIns reads), never the decoy's.
		expect(h.payloadProviders[0]).toEqual(["zai"]);
		// The run dir (and everything under it) dies with the call.
		expect(existsSync(h.runDir)).toBe(false);
	}, 30_000);

	test("a non-200 answer redacts the wire token", async () => {
		const h = makeHarness({
			respondValidate: () =>
				new Response(`forbidden: token ${TOKEN} echoed back`, { status: 403 }),
		});
		const err: Error = await h.transport(PROJECT, VERSION, 30_000).then(
			() => {
				throw new Error("the call should have rejected");
			},
			(e) => e as Error,
		);
		expect(err.message).toContain("403:");
		expect(err.message).toContain("[REDACTED]");
		expect(err.message).not.toContain(TOKEN);
	});

	test("integrity mismatch: a tampered tarball never installs or dispatches", async () => {
		const h = makeHarness({ integrity: "sha512-WRONG" });
		await expect(h.transport(PROJECT, VERSION, 30_000)).rejects.toThrow(
			`candidate tarball integrity mismatch for ${VERSION}`,
		);
		expect(h.spawns).toEqual([]);
		expect(h.validateBodies.length).toBe(0);
		expect(existsSync(h.runDir)).toBe(false);
	});

	test("response mapping: null job, guest kill, signal death, non-zero exit", async () => {
		const nullJob = makeHarness({ respondValidate: () => jobResponse(null) });
		await expect(nullJob.transport(PROJECT, VERSION, 30_000)).rejects.toThrow(
			"no job result",
		);

		const killed = makeHarness({
			respondValidate: () => jobResponse({ ...okJob(), timedOut: true }),
		});
		await expect(killed.transport(PROJECT, VERSION, 30_000)).rejects.toThrow(
			"time cap",
		);

		const signalled = makeHarness({
			respondValidate: () =>
				jobResponse({ ...okJob(), exitCode: null, signal: "SIGKILL" }),
		});
		await expect(signalled.transport(PROJECT, VERSION, 30_000)).rejects.toThrow(
			"signal SIGKILL",
		);

		const exit1 = makeHarness({
			respondValidate: () =>
				jobResponse({
					...okJob(),
					exitCode: 1,
					stdoutTail: "",
					stderrTail: "boom",
				}),
		});
		await expect(exit1.transport(PROJECT, VERSION, 30_000)).resolves.toEqual({
			code: 1,
			stdout: "",
			stderr: "boom",
		});
	}, 30_000);

	test("deadline: the transport's abort becomes the timeout error", async () => {
		const h = makeHarness({
			respondValidate: (_url, _body, signal) => {
				const { promise, reject } = Promise.withResolvers<Response>();
				signal?.addEventListener(
					"abort",
					() => reject(new Error("the operation was aborted")),
					{ once: true },
				);
				return promise;
			},
		});
		await expect(h.transport(PROJECT, VERSION, 80)).rejects.toThrow(
			"omp models probe timed out after 80 ms",
		);
	});

	test("deadline: a stalled response body cannot outlive modelsTimeoutMs", async () => {
		// The runner answers 200 with headers first and a body that never
		// completes on its own: fetch resolves, res.text() blocks. The abort
		// must still end the call at the deadline, so the regression the
		// blocker names (clearing the timer before res.text()) fails here.
		const h = makeHarness({
			respondValidate: (_url, _body, signal) => {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("{"));
						signal?.addEventListener(
							"abort",
							() => controller.error(new Error("the operation was aborted")),
							{ once: true },
						);
					},
				});
				return new Response(body, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		await expect(h.transport(PROJECT, VERSION, 120)).rejects.toThrow(
			"omp models probe timed out after 120 ms",
		);
	}, 30_000);

	test("missing board store: the flow completes with an empty copy", async () => {
		const h = makeHarness({
			// agentDir() points at a directory with no agent.db: the copy
			// degrades to an empty store, and the flow still dispatches.
			boardDbPath: join(newTmp(), "missing", "agent.db"),
			buildBoardStore: false,
		});
		const res = await h.transport(PROJECT, VERSION, 30_000);
		expect(res.code).toBe(0);
		expect(h.validateTarExisted[0]).toBe(true);
		expect(h.payloadProviders[0]).toEqual([]);
	}, 30_000);

	test("buildRedactedStore: key shapes survive, values do not", () => {
		const tmp = newTmp();
		const pinned = join(tmp, "pinned", "agent.db");
		makePinnedDb(
			pinned,
			[
				{
					provider: "zai",
					credential_type: "api_key",
					data: { key: "SECRET-VALUE", source: "user" },
					identity_key: "user@example.com",
				},
				{
					provider: "openai-codex",
					credential_type: "oauth",
					data: {
						access: "SECRET-A",
						refresh: "SECRET-R",
						expires: 123,
						email: "x@y",
					},
				},
				{
					provider: "google",
					credential_type: "api_key",
					data: { key: "SECRET-G" },
					disabled_cause: "deleted by user",
				},
			],
			7,
		);
		const fixedNow = 1_800_000_000_000;
		const out = join(tmp, "out", "agent.db");
		const { providers } = buildRedactedStore(pinned, out, () => fixedNow);
		expect(existsSync(out)).toBe(true);
		expect(providers).toEqual(["openai-codex", "zai"]);
		// No secret value survives anywhere in the out file's raw bytes — and
		// neither does board identity data: identity_key carried an email.
		const raw = new TextDecoder("latin1").decode(readFileSync(out));
		expect(raw.includes("SECRET-VALUE")).toBe(false);
		expect(raw.includes("SECRET-A")).toBe(false);
		expect(raw.includes("SECRET-R")).toBe(false);
		expect(raw.includes("SECRET-G")).toBe(false);
		expect(raw.includes("user@example.com")).toBe(false);
		// Read the rows back and check shapes.
		const outDb = new Database(out, { readonly: true });
		let outRows: unknown[] = [];
		let schemaRows: unknown[] = [];
		let revisionRows: unknown[] = [];
		try {
			outRows = outDb
				.query(
					"SELECT provider, data, identity_key FROM auth_credentials ORDER BY provider",
				)
				.all();
			schemaRows = outDb.query("SELECT version FROM auth_schema_version").all();
			revisionRows = outDb
				.query("SELECT revision FROM auth_change_revision")
				.all();
		} finally {
			outDb.close();
		}
		const byProvider = new Map<string, unknown>();
		for (const row of outRows) {
			if (typeof row === "object" && row !== null)
				byProvider.set(
					String("provider" in row ? row.provider : null),
					"data" in row ? row.data : null,
				);
		}
		expect(JSON.parse(String(byProvider.get("zai")))).toEqual({
			key: "ottr-probe-redacted",
			source: "ottr-probe-redacted",
		});
		// The identity_key row: placeholder, never the board's identity data.
		let zaiIdentityKey: unknown;
		for (const row of outRows) {
			if (typeof row !== "object" || row === null) continue;
			const r = row as Record<string, unknown>; // key type for a typeof-verified object row
			if (r.provider === "zai") zaiIdentityKey = r.identity_key;
		}
		expect(zaiIdentityKey).toBe("ottr-probe-redacted");
		const oauth = JSON.parse(String(byProvider.get("openai-codex"))) as {
			access: string;
			refresh: string;
			expires: number;
			email: string;
		};
		expect(oauth.access).toBe("ottr-probe-redacted");
		expect(oauth.refresh).toBe("ottr-probe-redacted");
		expect(oauth.email).toBe("ottr-probe-redacted");
		expect(oauth.expires).toBe(fixedNow + 365 * 24 * 3600 * 1000);
		expect(oauth.expires).toBeGreaterThan(fixedNow + 300 * 86_400_000);
		expect(byProvider.has("google")).toBe(false);
		// The schema rows carry the pinned version (7) and a fresh revision.
		const schemaRow = schemaRows[0];
		expect(
			typeof schemaRow === "object" &&
				schemaRow !== null &&
				"version" in schemaRow
				? schemaRow.version
				: null,
		).toBe(7);
		const revisionRow = revisionRows[0];
		expect(
			typeof revisionRow === "object" &&
				revisionRow !== null &&
				"revision" in revisionRow
				? revisionRow.revision
				: null,
		).toBe(1);
	});

	test("probeJobArgv: the wrapper runs the bundled cli", () => {
		expect(probeJobArgv("dist/cli.js")).toEqual([
			"bun",
			"/target/pkg/probe-wrapper.mjs",
			"/target/pkg/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
		]);
	});

	test("probeSpawnEnv: an allowlist, never the daemon environment", () => {
		const out = probeSpawnEnv(
			{
				PATH: "/usr/local/bun/bin:/usr/bin:/bin",
				LANG: "C.UTF-8",
				// Names the candidate's dependency tree must never see:
				ZAI_API_KEY: "sk-secret",
				OTTR_WORKER_TOKEN: TOKEN,
				PI_CODING_AGENT_DIR: "/board/agent",
				OTTR_DATABASE_URL: "postgres://…",
				HINDSIGHT_API_TOKEN: "h-secret",
				HTTP_PROXY: "http://proxy:8080",
			},
			"/run/dir",
		);
		// The allowlist: build toggles, run-dir paths, locale and PATH only.
		expect(out).toEqual({
			PUPPETEER_SKIP_DOWNLOAD: "1",
			PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "1",
			BUN_INSTALL_CACHE_DIR: "/run/dir/bun-cache",
			HOME: "/run/dir/home",
			LANG: "C.UTF-8",
			PATH: "/usr/local/bun/bin:/usr/bin:/bin",
		});
		// Proxy variables are credentials-adjacent configuration: dropped.
		expect("HTTP_PROXY" in out).toBe(false);
		// A missing LANG degrades to the guest default.
		const minimal = probeSpawnEnv({}, "/run/dir2");
		expect(minimal.LANG).toBe("C.UTF-8");
		expect("PATH" in minimal).toBe(false);
	});

	test("probePrepSpawn: the deadline kills a stalled preparation subprocess", async () => {
		const runDir = newTmp();
		const controller = new AbortController();
		const spawn = probePrepSpawn(runDir, controller.signal, {
			PATH: process.env.PATH ?? "",
		});
		const started = Date.now();
		const pending = spawn(["sleep", "30"]);
		// Real clock, deliberately: the deadline must kill a real child
		// process, and fake timers cannot advance a sleeping `sleep`.
		setTimeout(() => controller.abort(), 150);
		// The kill lands well inside sleep's 30 s budget: the runner rejects
		// instead of waiting the child out, and it has awaited proc.exited
		// by then, so the child is reaped when this resolves.
		await expect(pending).rejects.toThrow("preparation killed at the deadline");
		expect(Date.now() - started).toBeLessThan(10_000);
		const probe = Bun.spawnSync(["pgrep", "-x", "sleep"]);
		expect(probe.exitCode).not.toBe(0);
	});

	test("the wrapper: the install runs offline, catalogs fit the guest tail", () => {
		const tmp = newTmp();
		const wrapper = join(tmp, "probe-wrapper.mjs");
		writeFileSync(wrapper, probeWrapperSource);
		const home = join(tmp, "home");
		mkdirSync(home, { recursive: true });
		const storeDb = join(tmp, "store", "agent.db");
		mkdirSync(dirname(storeDb), { recursive: true });
		writeFileSync(storeDb, "store bytes");
		// A stub candidate cli whose COMPACT catalog still exceeds the guest's
		// 64 KiB stdout tail: 1000 entries with 64-character ids — the exact
		// shape the parse's own entry cap allows.
		const longId = "m".repeat(64);
		const entries = Array.from({ length: 1000 }, (_, i) => ({
			provider: "zai",
			id: `${longId}-${i}`,
			kind: "chat",
			name: `Model ${i}`,
		}));
		const bigCatalog = JSON.stringify({ models: entries });
		const stubCli = join(tmp, "stub-cli.mjs");
		writeFileSync(
			stubCli,
			`process.stdout.write(${JSON.stringify(bigCatalog)});\n`,
		);
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: home,
			LANG: "C.UTF-8",
			OMP_PROBE_STORE: storeDb,
			OMP_PROBE_SKIP_INSTALL: "1",
		};
		const run = Bun.spawnSync(["bun", wrapper, stubCli], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(0);
		// Blocker 2: the wrapper's OWN stdout — the thing the guest's
		// TailBuffer cuts — must fit the 64 KiB tail with its head intact.
		expect(run.stdout.length).toBeLessThanOrEqual(64 * 1024);
		const catalog = JSON.parse(new TextDecoder().decode(run.stdout)) as {
			models: { provider: string; id: string }[];
		};
		expect(catalog.models.length).toBeGreaterThan(0);
		expect(catalog.models[0]!.id.startsWith(longId)).toBe(true);
		// The head survived: the first entries are the first ids.
		expect(catalog.models[0]!.id.endsWith("-0")).toBe(true);
		// A candidate that prints no catalog exits non-zero with no stdout.
		const junkCli = join(tmp, "junk-cli.mjs");
		writeFileSync(junkCli, "process.stdout.write('not a catalog');\n");
		const junk = Bun.spawnSync(["bun", wrapper, junkCli], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(junk.exitCode).not.toBe(0);
		expect(junk.stdout.length).toBe(0);
		// The candidate's env is the three-name allowlist: the wrapper spawns
		// it with PATH, HOME and LANG only, whatever the job env carries. The
		// stub carries the sorted env names in its provider field, so the
		// observation rides a valid catalog through the wrapper's parse.
		const envProbeCli = join(tmp, "env-probe.mjs");
		writeFileSync(
			envProbeCli,
			'process.stdout.write(JSON.stringify({ models: [{ provider: Object.keys(process.env).sort().join("."), id: "env" }] }));\n',
		);
		const leaky = Bun.spawnSync(["bun", wrapper, envProbeCli], {
			env: {
				...env,
				ZAI_API_KEY: "sk-secret",
				OTTR_WORKER_TOKEN: TOKEN,
				OMP_PROBE_STORE: storeDb,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(leaky.exitCode).toBe(0);
		const leakyCatalog = JSON.parse(new TextDecoder().decode(leaky.stdout)) as {
			models: { provider: string }[];
		};
		expect(leakyCatalog.models[0]!.provider).toBe("HOME.LANG.PATH");
	});

	test("the wrapper installs the payload offline inside the guest", () => {
		const tmp = newTmp();
		const wrapper = join(tmp, "probe-wrapper.mjs");
		writeFileSync(wrapper, probeWrapperSource);
		const home = join(tmp, "home");
		mkdirSync(home, { recursive: true });
		const pkgDir = join(tmp, "payload", "pkg");
		mkdirSync(join(pkgDir, "registry"), { recursive: true });
		// A real minimal dependency tarball, built here: the guest install
		// runs offline from the payload's file: tarballs alone.
		const stubSrc = join(tmp, "stub-src", "package");
		mkdirSync(stubSrc, { recursive: true });
		writeFileSync(
			join(stubSrc, "package.json"),
			JSON.stringify({ name: "stub-pkg", version: "1.0.0" }),
		);
		const stubTgz = join(pkgDir, "registry", "stub-pkg-1.0.0.tgz");
		const tarPack = Bun.spawnSync(
			["tar", "-czf", stubTgz, "-C", dirname(stubSrc), "package"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(tarPack.exitCode).toBe(0);
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "ottr-omp-probe",
				private: true,
				dependencies: { "stub-pkg": "file:registry/stub-pkg-1.0.0.tgz" },
			}),
		);
		// The candidate cli: proves the tree it runs in is the one the guest
		// install produced, by reading the installed dependency back.
		const cliDir = join(pkgDir, "node_modules", "candidate", "dist");
		mkdirSync(cliDir, { recursive: true });
		writeFileSync(
			join(cliDir, "cli.js"),
			'const { readFileSync } = require("node:fs");\nconst manifest = JSON.parse(readFileSync("node_modules/stub-pkg/package.json", "utf8"));\nprocess.stdout.write(JSON.stringify({ models: [{ provider: manifest.name, id: manifest.version }] }));\n',
		);
		const storeDb = join(tmp, "store", "agent.db");
		mkdirSync(dirname(storeDb), { recursive: true });
		writeFileSync(storeDb, "store bytes");
		const run = Bun.spawnSync(
			[process.execPath, wrapper, join(cliDir, "cli.js"), pkgDir],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					LANG: "C.UTF-8",
					OMP_PROBE_STORE: join(tmp, "store", "agent.db"),
				},
				stdout: "pipe",
				stderr: "pipe",
				cwd: pkgDir,
			},
		);
		expect(run.exitCode).toBe(0);
		// The offline install materialized the dependency in the guest tree.
		expect(
			existsSync(join(pkgDir, "node_modules", "stub-pkg", "package.json")),
		).toBe(true);
		const catalog = JSON.parse(new TextDecoder().decode(run.stdout)) as {
			models: { provider: string; id: string }[];
		};
		expect(catalog.models).toEqual([{ provider: "stub-pkg", id: "1.0.0" }]);
	});

	test("bin escape guard: a bin outside the package rejects the candidate", async () => {
		for (const bin of ["../outside.js", "/abs.js"]) {
			const h = makeHarness({ bin });
			await expect(h.transport(PROJECT, VERSION, 30_000)).rejects.toThrow(
				`candidate bin path escapes the package: ${bin}`,
			);
			expect(h.validateBodies.length).toBe(0);
			expect(existsSync(h.runDir)).toBe(false);
		}
	});

	// The blocker-3 witness: the secret-free store drives the real CLI's
	// catalog. Skipped where omp is not installed.
	test.skipIf(!Bun.which("omp"))(
		"real omp cli: the redacted store lists the pinned providers",
		() => {
			const tmp = newTmp();
			const pinned = join(tmp, "pinned", "agent.db");
			makePinnedDb(pinned, [
				{
					provider: "openai-codex",
					credential_type: "oauth",
					data: { access: "SECRET-A", refresh: "SECRET-R", expires: 123 },
				},
				{
					provider: "zai",
					credential_type: "api_key",
					data: { key: "SECRET-VALUE", source: "user" },
				},
			]);
			const agentDir = join(tmp, "agent");
			mkdirSync(agentDir, { recursive: true });
			const emptyAgentDir = join(tmp, "empty-agent");
			mkdirSync(emptyAgentDir, { recursive: true });
			const home = join(tmp, "home");
			mkdirSync(home, { recursive: true });
			const built = buildRedactedStore(pinned, join(agentDir, "agent.db"));
			expect(built.providers.sort()).toEqual(["openai-codex", "zai"]);
			const cliPath = realpathSync(Bun.which("omp")!);
			const run = (dir: string) =>
				Bun.spawnSync(["bun", cliPath, "models", "--json"], {
					env: {
						PATH: process.env.PATH ?? "",
						HOME: home,
						PI_CODING_AGENT_DIR: dir,
					},
					stdout: "pipe",
					stderr: "pipe",
				});
			const withStore = run(agentDir);
			expect(withStore.exitCode).toBe(0);
			const catalog = JSON.parse(
				new TextDecoder().decode(withStore.stdout),
			) as { models: { provider: string }[] };
			expect(Array.isArray(catalog.models)).toBe(true);
			expect(catalog.models.length).toBeGreaterThan(0);
			expect(catalog.models.some((m) => m.provider === "openai-codex")).toBe(
				true,
			);
			// Differential: no store, no providers.
			const withoutStore = run(emptyAgentDir);
			expect(withoutStore.exitCode).toBe(0);
			const empty = JSON.parse(
				new TextDecoder().decode(withoutStore.stdout),
			) as { models: unknown[] };
			expect(empty.models).toEqual([]);
		},
		60_000,
	);
});

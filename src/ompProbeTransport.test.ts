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
import { join } from "node:path";
import {
	buildRedactedStore,
	createOmpProbeTransport,
	probeJobArgv,
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
afterAll(() => {
	for (const dir of tmps) rmSync(dir, { recursive: true, force: true });
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
 * and fake /validate. Every spawn is recorded and answered by shape. */
function makeHarness(opts: {
	/** Overrides or blanks env names (undefined blanks). */
	envOverride?: Record<string, string | undefined>;
	/** The bin entry both the source and the installed package.json carry. */
	bin?: unknown;
	/** Packument integrity override (default: the real digest of FAKE_TGZ). */
	integrity?: string;
	/** Overrides the pinned-store path the env names. */
	pinnedDbPath?: string;
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
	env: NodeJS.ProcessEnv;
	pinnedDbPath: string;
} {
	const tmp = newTmp();
	const dataRoot = join(tmp, "data");
	const pinnedDbPath = opts.pinnedDbPath ?? join(tmp, "pinned", "agent.db");
	const env: NodeJS.ProcessEnv = {
		OTTR_VM_RUNNER_URL: "http://runner.test/",
		OTTR_WORKER_TOKEN: TOKEN,
		OTTR_PINNED_AGENT_DB: pinnedDbPath,
		...opts.envOverride,
	};
	const spawns: string[][] = [];
	const validateUrls: string[] = [];
	const validateBodies: Record<string, unknown>[] = [];
	const validateTarExisted: boolean[] = [];
	const bin = opts.bin ?? { omp: "dist/cli.js" };
	const spawnImpl: ProcSpawn = async (argv) => {
		spawns.push([...argv]);
		if (argv[0] === "tar" && argv.includes("-xzf")) {
			const dest = argv[4]!;
			mkdirSync(join(dest, "package"), { recursive: true });
			writeFileSync(
				join(dest, "package", "package.json"),
				JSON.stringify({
					name: "@oh-my-pi/pi-coding-agent",
					version: VERSION,
					bin,
				}),
			);
			return okSpawn();
		}
		if (argv[0] === "bun" && argv[1] === "add") {
			const pkgDir = argv[3]!;
			const installed = join(
				pkgDir,
				"node_modules",
				"@oh-my-pi",
				"pi-coding-agent",
			);
			mkdirSync(join(installed, "dist"), { recursive: true });
			writeFileSync(
				join(installed, "package.json"),
				JSON.stringify({
					name: "@oh-my-pi/pi-coding-agent",
					version: VERSION,
					bin,
				}),
			);
			writeFileSync(
				join(installed, "dist", "cli.js"),
				"// stub candidate cli\n",
			);
			return okSpawn();
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
		if (url.endsWith("/validate")) {
			validateUrls.push(url);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			validateBodies.push(body);
			validateTarExisted.push(existsSync(String(body.targetTar)));
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
		env,
		pinnedDbPath,
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
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?)",
				[
					row.provider,
					row.credential_type,
					JSON.stringify(row.data),
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
		for (const name of [
			"OTTR_VM_RUNNER_URL",
			"OTTR_WORKER_TOKEN",
			"OTTR_PINNED_AGENT_DB",
		]) {
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
	});

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
		expect(argv[0]).toBe("/bin/sh");
		const cmd = String(argv[2]);
		expect(cmd).toContain("cp /target/store/agent.db");
		expect(cmd).toContain("models --json");
		expect(cmd).toContain(
			"/target/pkg/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
		);
		expect(job.cwd).toBe("/target");
		// Flow order: extract the verified tarball, bun add from it, pack the payload.
		expect(h.spawns.length).toBe(3);
		expect(h.spawns[0]![0]).toBe("tar");
		expect(h.spawns[0]).toContain("-xzf");
		expect(h.spawns[0]).toContain(join(h.runDir, "candidate.tgz"));
		expect(h.spawns[1]![0]).toBe("bun");
		expect(h.spawns[1]).toContain("--cwd");
		expect(h.spawns[1]!.at(-1)).toBe(join(h.runDir, "candidate.tgz"));
		expect(h.spawns[2]![0]).toBe("tar");
		expect(h.spawns[2]).toContain("-cf");
		expect(h.spawns[2]).toContain("--hard-dereference");
		// The run dir (and everything under it) dies with the call.
		expect(existsSync(h.runDir)).toBe(false);
	});

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
	});

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

	test("missing pinned db: the flow completes with an empty store", async () => {
		let storeExistedDuringCall = false;
		const h = makeHarness({
			pinnedDbPath: join(newTmp(), "missing", "agent.db"),
			respondValidate: (_url, _body) => {
				storeExistedDuringCall = existsSync(
					join(h.runDir, "payload", "store", "agent.db"),
				);
				return jobResponse(okJob());
			},
		});
		const res = await h.transport(PROJECT, VERSION, 30_000);
		expect(res.code).toBe(0);
		expect(storeExistedDuringCall).toBe(true);
	});

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
		// No secret value survives anywhere in the out file's raw bytes.
		const raw = new TextDecoder("latin1").decode(readFileSync(out));
		expect(raw.includes("SECRET-VALUE")).toBe(false);
		expect(raw.includes("SECRET-A")).toBe(false);
		expect(raw.includes("SECRET-R")).toBe(false);
		expect(raw.includes("SECRET-G")).toBe(false);
		// Read the rows back and check shapes.
		const outDb = new Database(out, { readonly: true });
		let outRows: unknown[] = [];
		let schemaRows: unknown[] = [];
		let revisionRows: unknown[] = [];
		try {
			outRows = outDb
				.query("SELECT provider, data FROM auth_credentials ORDER BY provider")
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

	test("probeJobArgv: the exact sh command for the bundled cli", () => {
		expect(probeJobArgv("dist/cli.js")).toEqual([
			"/bin/sh",
			"-c",
			'mkdir -p "$HOME/.omp/agent" && cp /target/store/agent.db "$HOME/.omp/agent/agent.db" && exec bun /target/pkg/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js models --json',
		]);
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

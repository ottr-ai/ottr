import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	buildRedactedStore,
	createOmpProbeTransport,
	lockEntryForPlatform,
	payloadTarballName,
	probeJobArgv,
	probePrepSpawn,
	probeSpawnEnv,
	probeWrapperSource,
} from "./ompProbeTransport.ts";
import { OMP_PACKAGE_URL, OMP_WATCH_GATES, parseModelSet } from "./ompWatch.ts";
import type { ProcSpawn } from "./sandboxRun.ts";
import { VM_VALIDATE } from "./vmValidateShared.ts";

// Per-test real-fs scratch; everything a test builds dies with its dir.
const tmps: string[] = [];
const newTmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ottr-omp-probe-test-"));
	tmps.push(dir);
	return dir;
};
// The transport reads the board store through agentDir(), which resolves
// process.env.PI_CODING_AGENT_DIR directly (not through the env seam): each
// harness pins it. The pinner keeps each name's value from before its FIRST
// pin, so restore always returns the original, however many pins ran.
function envPinner(): {
	pin: (name: string, value: string | undefined) => void;
	restore: () => void;
} {
	const originals = new Map<string, string | undefined>();
	return {
		pin(name, value) {
			if (!originals.has(name)) originals.set(name, process.env[name]);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		},
		restore() {
			for (const [name, value] of originals) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			originals.clear();
		},
	};
}
const suiteEnv = envPinner();
const pinProcessEnv = suiteEnv.pin;
afterAll(() => {
	suiteEnv.restore();
	for (const dir of tmps) rmSync(dir, { recursive: true, force: true });
});

const ID = "ompprobe-test-1";
const PROJECT = "ottr";
const TOKEN = "tok-redact-me-42";
const TARBALL_URL = "https://registry.test/pkg/-/pkg-18.16.0.tgz";
const VERSION = "18.16.0";

/** A real gzipped tar (package/package.json), because the wrapper's offline
 * install in the guest extracts every payload tarball for real. Returns the
 * bytes, their sha512 integrity header, and the tar path. */
function makeTarball(
	dir: string,
	name: string,
	version: string,
): { bytes: Uint8Array<ArrayBuffer>; integrity: string; path: string } {
	const src = join(dir, "src", `${name}-${version}`, "package");
	mkdirSync(join(src, "dist"), { recursive: true });
	writeFileSync(
		join(src, "package.json"),
		JSON.stringify({ name, version, bin: { omp: "dist/cli.js" } }),
	);
	writeFileSync(join(src, "dist", "cli.js"), "// candidate cli\n");
	mkdirSync(join(dir, "tarballs"), { recursive: true });
	const path = join(
		dir,
		"tarballs",
		`${name.replace(/[^A-Za-z0-9._-]/g, "_")}-${version}.tgz`,
	);
	const packed = Bun.spawnSync(
		[
			"tar",
			"-czf",
			path,
			"-C",
			join(dir, "src", `${name}-${version}`),
			"package",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (packed.exitCode !== 0)
		throw new Error(`tar fixture failed: ${packed.stderr.toString()}`);
	const bytes = Uint8Array.from(readFileSync(path));
	const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
	return { bytes, integrity, path };
}

const TMP0 = mkdtempSync(join(tmpdir(), "ottr-omp-probe-fx-"));
const CAND_TGZ = makeTarball(TMP0, "@oh-my-pi/pi-coding-agent", VERSION);
const FAKE_TGZ = CAND_TGZ.bytes;
const FAKE_DIGEST = CAND_TGZ.integrity.slice("sha512-".length);
// Distinct real bytes for the second locked version: the payload must carry
// both, and the guest install extracts both.
const SW5_TGZ = makeTarball(TMP0, "string-width", "5.1.2");
const SW5_DIGEST = SW5_TGZ.integrity.slice("sha512-".length);
const SW7_TGZ = makeTarball(TMP0, "string-width", "7.2.0");
const SW7_DIGEST = SW7_TGZ.integrity.slice("sha512-".length);
afterAll(() => {
	rmSync(TMP0, { recursive: true, force: true });
});
const CATALOG_JSON = '{"models":[{"provider":"zai","id":"glm-6.2"}]}';
const CATALOG_B64 = Buffer.from(CATALOG_JSON, "utf8").toString("base64");

const packument = (integrity: string): unknown => ({
	name: "@oh-my-pi/pi-coding-agent",
	versions: {
		[VERSION]: {
			version: VERSION,
			dist: { tarball: TARBALL_URL, integrity },
		},
	},
});
const SW_REGISTRY = "https://registry.test/string-width";
const depPackument = (): unknown => ({
	name: "string-width",
	versions: {
		"7.2.0": {
			version: "7.2.0",
			dist: {
				tarball: `${SW_REGISTRY}-7.2.0.tgz`,
				integrity: `sha512-${SW7_DIGEST}`,
			},
		},
		"8.6.0": {
			version: "8.6.0",
			dist: {
				tarball: `${SW_REGISTRY}-8.6.0.tgz`,
				integrity: `sha512-${SW5_DIGEST}`,
			},
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
			artifacts: [
				{
					name: "home/catalog.json",
					size: CATALOG_B64.length,
					bytes: CATALOG_B64,
				},
			],
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
	stdoutTail: "",
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
	payloads: { lock: string; pkgFiles: string[]; registry: string[] }[];
	lockJson: string;
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
	const payloads: {
		lock: string;
		pkgFiles: string[];
		registry: string[];
	}[] = [];
	const bin = opts.bin ?? { omp: "dist/cli.js" };
	// A bun lockfile in its real shape: keys are install paths. Two locked
	// string-width versions (one nested under the candidate) and one package
	// for another platform, which never ships (bun never installs it).
	const LOCK_JSON = `${JSON.stringify(
		{
			lockfileVersion: 1,
			workspaces: {
				"": {
					name: "ottr-omp-probe",
					dependencies: { "@oh-my-pi/pi-coding-agent": VERSION },
				},
			},
			packages: {
				"@oh-my-pi/pi-coding-agent": [
					`@oh-my-pi/pi-coding-agent@${VERSION}`,
					"",
					{ dependencies: { "string-width": "^8.6.0" } },
					`sha512-${FAKE_DIGEST}`,
				],
				"string-width": ["string-width@7.2.0", "", {}, `sha512-${SW7_DIGEST}`],
				"@oh-my-pi/pi-coding-agent/string-width": [
					"string-width@8.6.0",
					"",
					{},
					`sha512-${SW5_DIGEST}`,
				],
				"native-other": [
					"native-other@1.0.0",
					"",
					{ os: `!${process.platform}` },
					"sha512-never-fetched",
				],
			},
		},
		null,
		2,
	)}\n`;
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
				new Response(JSON.stringify(depPackument()), { status: 200 }),
			);
		if (url === `${SW_REGISTRY}-7.2.0.tgz`)
			return Promise.resolve(new Response(SW7_TGZ.bytes));
		if (url === `${SW_REGISTRY}-8.6.0.tgz`)
			return Promise.resolve(new Response(SW5_TGZ.bytes));
		if (url.endsWith("/validate")) {
			validateUrls.push(url);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			validateBodies.push(body);
			validateTarExisted.push(existsSync(String(body.targetTar)));
			// The payload's pkg dir, read at dispatch time (the runDir dies
			// with the call): the lockfile it ships and the tarballs beside it.
			const payloadPkg = join(body.targetTar as string, "..", "payload", "pkg");
			payloads.push({
				lock: readFileSync(join(payloadPkg, "bun.lock"), "utf8"),
				pkgFiles: readdirSync(payloadPkg).sort(),
				registry: readdirSync(join(payloadPkg, "registry")).sort(),
			});
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
		payloads,
		lockJson: LOCK_JSON,
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

const CAND = "@oh-my-pi/pi-coding-agent";
/** One locked package of a wrapper fixture: its lockfile key (install path),
 * name, version and dependency ranges; `cli` makes it the candidate. */
type LockedPkg = {
	key: string;
	name: string;
	version: string;
	deps?: Record<string, string>;
	meta?: Record<string, unknown>;
	cli?: string;
	/** Ships no tarball (an entry the guest must skip). */
	noTarball?: boolean;
};
/** The candidate cli of the edge tests: walks every dependency edge through
 * the runtime's own require, from the candidate down, and reports each as a
 * `parent>dep@version` record. */
const EDGE_CLI = `const seen = [];
const walk = (from, req) => {
	const pj = req("./package.json");
	for (const dep of Object.keys(pj.dependencies ?? {})) {
		const depPj = req(dep + "/package.json");
		seen.push({ provider: "edge", id: pj.name + ">" + dep + "@" + depPj.version });
		walk(dep, require("node:module").createRequire(req.resolve(dep + "/package.json")));
	}
};
walk(null, require("node:module").createRequire(require("node:path").join(__dirname, "..", "package.json")));
process.stdout.write(JSON.stringify({ models: seen }));
`;
/** The install path segments a lockfile key names (test-side mirror). */
function installSegments(key: string): string[] {
	const segs = key.split("/");
	const out: string[] = [];
	for (let i = 0; i < segs.length; ) {
		const scoped = segs[i]!.startsWith("@");
		out.push("node_modules", scoped ? `${segs[i]}/${segs[i + 1]}` : segs[i]!);
		i += scoped ? 2 : 1;
	}
	return out;
}
/** A payload in the transport's layout (bun.lock + registry/<name@version>
 * tarballs + wrapper) under a read-only target dir, and a runner for the
 * trusted wrapper with the guest's three-name env. */
function lockedPayload(pkgs: LockedPkg[]) {
	const tmp = newTmp();
	const pkgDir = join(tmp, "payload", "pkg");
	const registry = join(pkgDir, "registry");
	mkdirSync(registry, { recursive: true });
	writeFileSync(join(pkgDir, "probe-wrapper.mjs"), probeWrapperSource);
	const packages: Record<string, unknown> = {};
	for (const p of pkgs) {
		packages[p.key] = [
			`${p.name}@${p.version}`,
			"",
			{ ...(p.deps ? { dependencies: p.deps } : {}), ...p.meta },
			"sha512-fixture",
		];
		if (p.noTarball) continue;
		const src = join(tmp, "src", encodeURIComponent(p.key), "package");
		mkdirSync(join(src, "dist"), { recursive: true });
		writeFileSync(
			join(src, "package.json"),
			JSON.stringify({
				name: p.name,
				version: p.version,
				dependencies: p.deps,
				bin: { omp: "dist/cli.js" },
			}),
		);
		writeFileSync(join(src, "dist", "cli.js"), p.cli ?? "// dependency\n");
		const packed = Bun.spawnSync(
			[
				"tar",
				"-czf",
				join(registry, payloadTarballName(`${p.name}@${p.version}`)),
				"-C",
				dirname(src),
				"package",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
	}
	writeFileSync(
		join(pkgDir, "bun.lock"),
		`${JSON.stringify({ lockfileVersion: 1, packages }, null, 2)}\n`,
	);
	// /target is a read-only mount in the guest (docker/ottr-vm-init).
	const targetPkg = join(tmp, "target", "pkg");
	mkdirSync(dirname(targetPkg), { recursive: true });
	cpSync(pkgDir, targetPkg, { recursive: true });
	const home = join(tmp, "home");
	mkdirSync(home, { recursive: true });
	const storeDb = join(tmp, "store", "agent.db");
	mkdirSync(dirname(storeDb), { recursive: true });
	writeFileSync(storeDb, "store bytes");
	let scratch = "";
	return {
		targetPkg,
		home,
		run() {
			const before = new Set(readdirSync("/tmp"));
			chmodSync(targetPkg, 0o555);
			chmodSync(join(targetPkg, "registry"), 0o555);
			try {
				return Bun.spawnSync(
					[
						"bun",
						join(targetPkg, "probe-wrapper.mjs"),
						"dist/cli.js",
						targetPkg,
					],
					{
						env: {
							PATH: process.env.PATH ?? "",
							HOME: home,
							LANG: "C.UTF-8",
							OMP_PROBE_STORE: storeDb,
						},
						stdout: "pipe",
						stderr: "pipe",
						cwd: tmp,
					},
				);
			} finally {
				chmodSync(targetPkg, 0o755);
				chmodSync(join(targetPkg, "registry"), 0o755);
				// The wrapper's scratch sits under the real /tmp (a fresh VM's
				// /tmp in production); this run's is the one new entry.
				const added = readdirSync("/tmp").filter(
					(d) => d.startsWith("ottr-probe-") && !before.has(d),
				);
				if (added.length === 1) {
					scratch = join("/tmp", added[0]!);
					tmps.push(scratch);
				}
			}
		},
		scratch: () => {
			expect(scratch).not.toBe("");
			return scratch;
		},
		catalogText: () => readFileSync(join(home, "catalog.json"), "utf8"),
		catalog: () =>
			(
				JSON.parse(readFileSync(join(home, "catalog.json"), "utf8")) as {
					models: { provider: string; id: string }[];
				}
			).models,
	};
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
		expect(
			Object.keys(job).every((k) => ["argv", "cwd", "collect"].includes(k)),
		).toBe(true);
		const argv = Array.isArray(job.argv) ? job.argv : [];
		// The job runs the payload's trusted wrapper, which installs the
		// payload offline inside the guest, stamps the redacted store into the
		// job HOME, and spawns the candidate under the three-name env
		// allowlist (probeWrapperSource, unit-tested below).
		expect(argv[0]).toBe("bun");
		expect(argv[1]).toBe("/target/pkg/probe-wrapper.mjs");
		// argv[2] is the candidate's bin relative path; the wrapper composes
		// the absolute cli path inside the /tmp scratch install tree.
		expect(String(argv[2])).toBe("dist/cli.js");
		expect(argv[3]).toBe("/target/pkg");
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
		expect(h.spawns[2]).toContain("pkg");
		expect(h.spawns[2]).toContain("store");
		// No install tree ever exists on the server: the payload ships
		// integrity-pinned tarballs and the lockfile's file: map only.
		expect(h.spawns.some((a) => a.includes("add"))).toBe(false);
		// The redacted copy carries the board store's rows (the transport
		// reads agentDir(), the same file signIns reads), never the decoy's.
		expect(h.payloadProviders[0]).toEqual(["zai"]);
		// The locked graph ships as resolved: bun's lockfile byte for byte, no
		// manifest rebuilt from it, and one verified tarball per locked
		// name@version for this platform — both string-width versions, never
		// the other-platform package (its tarball is never even fetched).
		const payload = h.payloads[0]!;
		expect(payload.lock).toBe(h.lockJson);
		expect(payload.pkgFiles).toEqual([
			"bun.lock",
			"probe-wrapper.mjs",
			"registry",
		]);
		expect(payload.registry).toEqual(
			[
				`@oh-my-pi/pi-coding-agent@${VERSION}`,
				"string-width@7.2.0",
				"string-width@8.6.0",
			]
				.map(payloadTarballName)
				.sort(),
		);
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
			stdout: CATALOG_JSON,
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

	test("probeJobArgv: the wrapper gets the bin path and the payload dir", () => {
		expect(probeJobArgv("dist/cli.js")).toEqual([
			"bun",
			"/target/pkg/probe-wrapper.mjs",
			"dist/cli.js",
			"/target/pkg",
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

	test("envPinner: two pins of one name restore its original value", () => {
		// Send-back 3 blocker 3: insertion-order restores left the name at the
		// FIRST pin's value, so later tests read a deleted fixture store.
		const name = "OTTR_PROBE_TEST_PIN";
		process.env[name] = "original";
		const pinner = envPinner();
		pinner.pin(name, "first-fixture");
		pinner.pin(name, "second-fixture");
		pinner.restore();
		expect(process.env[name]).toBe("original");
		const unset = envPinner();
		delete process.env[name];
		unset.pin(name, "a");
		unset.pin(name, "b");
		unset.restore();
		expect(name in process.env).toBe(false);
	});

	test("lockEntryForPlatform: bun's os/cpu install rule", () => {
		expect(lockEntryForPlatform({}, "linux", "x64")).toBe(true);
		expect(lockEntryForPlatform(undefined, "linux", "x64")).toBe(true);
		expect(
			lockEntryForPlatform({ os: "linux", cpu: "x64" }, "linux", "x64"),
		).toBe(true);
		expect(lockEntryForPlatform({ os: "darwin" }, "linux", "x64")).toBe(false);
		expect(lockEntryForPlatform({ cpu: ["arm64"] }, "linux", "x64")).toBe(
			false,
		);
		expect(lockEntryForPlatform({ os: ["!win32"] }, "linux", "x64")).toBe(true);
		expect(lockEntryForPlatform({ os: ["!linux"] }, "linux", "x64")).toBe(
			false,
		);
	});

	test("the wrapper: a transitive range the root version cannot satisfy resolves from the nested lock key", () => {
		// Send-back 3 blocker 2 (dependency-graph-loss): the root holds child@1
		// and parent asks for child@^2. bun's lockfile nests child@2 under
		// parent ("parent/child"); the guest tree must keep that edge.
		const w = lockedPayload([
			{
				key: CAND,
				name: CAND,
				version: "18.16.0",
				deps: { parent: "^1.0.0", child: "^1.0.0" },
				cli: EDGE_CLI,
			},
			{
				key: "parent",
				name: "parent",
				version: "1.0.0",
				deps: { child: "^2.0.0" },
			},
			{ key: "child", name: "child", version: "1.0.0" },
			{ key: "parent/child", name: "child", version: "2.0.0" },
		]);
		const run = w.run();
		expect(run.exitCode).toBe(0);
		const edges = w
			.catalog()
			.map((m) => m.id)
			.sort();
		expect(edges).toEqual([
			"@oh-my-pi/pi-coding-agent>child@1.0.0",
			"@oh-my-pi/pi-coding-agent>parent@1.0.0",
			"parent>child@2.0.0",
		]);
	}, 60_000);

	test("the wrapper: every locked edge of every key shape resolves to a version its range accepts", () => {
		// The class test: the guest tree IS the lockfile (key = install path),
		// so for any locked graph every declared dependency resolves, through
		// the runtime's own module resolution, to a version that satisfies
		// its range. Key shapes: scoped root, scoped nested under scoped,
		// plain nested under a nested scoped package, three versions of one
		// name, and a package for another platform that must not install.
		const pkgs: LockedPkg[] = [
			{
				key: CAND,
				name: CAND,
				version: "18.16.0",
				deps: { "@s/a": "^1.0.0", "@t/b": "^1.0.0", c: "^3.0.0" },
				cli: EDGE_CLI,
			},
			{
				key: "@s/a",
				name: "@s/a",
				version: "1.0.0",
				deps: { "@t/b": "^2.0.0", c: "^3.0.0" },
			},
			{ key: "@t/b", name: "@t/b", version: "1.0.0" },
			{
				key: "@s/a/@t/b",
				name: "@t/b",
				version: "2.0.0",
				deps: { c: "^1.0.0" },
			},
			{ key: "@s/a/@t/b/c", name: "c", version: "1.0.0" },
			{ key: "c", name: "c", version: "3.0.0" },
			{
				key: "other-platform",
				name: "other-platform",
				version: "1.0.0",
				meta: { os: `!${process.platform}` },
				noTarball: true,
			},
		];
		const w = lockedPayload(pkgs);
		const run = w.run();
		expect(run.exitCode).toBe(0);
		const tree = join(w.scratch(), "pkg");
		let checked = 0;
		for (const p of pkgs) {
			const dir = join(tree, ...installSegments(p.key));
			if (p.noTarball) {
				expect(existsSync(dir)).toBe(false);
				continue;
			}
			expect(
				JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version,
			).toBe(p.version);
			const req = createRequire(join(dir, "package.json"));
			for (const [dep, range] of Object.entries(p.deps ?? {})) {
				const found = JSON.parse(
					readFileSync(req.resolve(`${dep}/package.json`), "utf8"),
				) as { version: string };
				expect(Bun.semver.satisfies(found.version, range)).toBe(true);
				checked++;
			}
		}
		expect(checked).toBe(6);
	}, 60_000);

	test("the wrapper: a lock key outside the tree is refused before anything unpacks", () => {
		const w = lockedPayload([
			{ key: CAND, name: CAND, version: "18.16.0", cli: EDGE_CLI },
			{ key: "../escape", name: "escape", version: "1.0.0" },
		]);
		const run = w.run();
		expect(run.exitCode).toBe(1);
		expect(new TextDecoder().decode(run.stderr)).toContain(
			"not an install path",
		);
		expect(existsSync(join(w.scratch(), "escape"))).toBe(false);
		expect(existsSync(join(w.scratch(), "pkg", "node_modules"))).toBe(false);
	}, 60_000);

	test("the wrapper: read-only target, guest-only tree, complete catalog artifact past the stdout tail", () => {
		// The env probe, the stub dependency and 998 entries with 64-character
		// ids: a catalog far over the guest's 64 KiB stdout tail must reach the
		// promoted artifact whole.
		// Every id is exactly 64 characters, the parser's segment limit.
		const cli =
			'const stub = require("stub-pkg/package.json");\n' +
			'const envNames = Object.keys(process.env).sort().join("-").toLowerCase();\n' +
			'const records = [{ provider: "env", id: envNames }, { provider: "stub", id: stub.version }];\n' +
			'for (let i = 0; i < 998; i++) records.push({ provider: "zai", id: "m".repeat(60) + String(i).padStart(4, "0") });\n' +
			"process.stdout.write(JSON.stringify({ models: records }));\n";
		const w = lockedPayload([
			{
				key: CAND,
				name: CAND,
				version: "18.16.0",
				deps: { "stub-pkg": "^1.0.0" },
				cli,
			},
			{ key: "stub-pkg", name: "stub-pkg", version: "1.0.0" },
		]);
		const run = w.run();
		expect(run.exitCode).toBe(0);
		// The read-only target gained nothing; the tree exists in the scratch.
		expect(existsSync(join(w.targetPkg, "node_modules"))).toBe(false);
		expect(existsSync(join(w.scratch(), "pkg", "node_modules", CAND))).toBe(
			true,
		);
		const promoted = w.catalogText();
		expect(promoted.length).toBeGreaterThan(VM_VALIDATE.outputTailBytes);
		const models = (
			JSON.parse(promoted) as { models: { provider: string; id: string }[] }
		).models;
		expect(models.length).toBe(1000);
		// The env allowlist held: the candidate saw exactly HOME, LANG, PATH.
		expect(models[0]).toEqual({ provider: "env", id: "home-lang-path" });
		expect(models[1]).toEqual({ provider: "stub", id: "1.0.0" });
		expect(models.at(-1)!.id).toBe(`${"m".repeat(60)}0997`);
		// The full artifact is what the watch parses: all 1000 entries accepted.
		const parsed = parseModelSet(promoted, OMP_WATCH_GATES.modelsMaxEntries);
		expect("pairs" in parsed && parsed.pairs.length).toBe(1000);
		// The stdout copy stays a bounded diagnostic.
		expect(run.stdout.length).toBeLessThanOrEqual(48 * 1024);
		expect(existsSync(join(w.home, ".omp", "agent", "agent.db"))).toBe(true);
	}, 60_000);

	test("the wrapper: an over-cap catalog stays over the cap, never a truncated prefix", () => {
		const over = OMP_WATCH_GATES.modelsMaxEntries + 5;
		const models = Array.from({ length: over }, (_, i) => ({
			provider: "zai",
			id: `m-${i}`,
		}));
		const w = lockedPayload([
			{
				key: CAND,
				name: CAND,
				version: "18.16.0",
				cli: `process.stdout.write(${JSON.stringify(JSON.stringify({ models }))});\n`,
			},
		]);
		expect(w.run().exitCode).toBe(0);
		expect(
			parseModelSet(w.catalogText(), OMP_WATCH_GATES.modelsMaxEntries),
		).toEqual({
			error: expect.stringContaining("models"),
		});
	}, 60_000);

	test("the wrapper: junk candidate output exits non-zero with no catalog", () => {
		const w = lockedPayload([
			{
				key: CAND,
				name: CAND,
				version: "18.16.0",
				cli: "process.stdout.write('not a catalog');\n",
			},
		]);
		const junk = w.run();
		expect(junk.exitCode).toBe(3);
		expect(new TextDecoder().decode(junk.stderr)).toContain(
			"the candidate output is not a models catalog",
		);
		expect(junk.stdout.length).toBe(0);
		expect(existsSync(join(w.home, "catalog.json"))).toBe(false);
	}, 60_000);

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

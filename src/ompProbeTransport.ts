/**
 * The omp watch's candidate probe transport, over the vm-runner's POST
 * /validate channel (docs/specs/microvm-validation-mode.md): it packs one
 * exact npm release into a fresh microVM with NO board mounts, and runs the
 * candidate's bundled `omp models --json` there. The boundaries, and why each
 * exists:
 *
 * - No board mounts: the candidate is unapproved code (OTTR-1287 security
 *   review), so it never sees board data; the payload tar carries only the
 *   installed package and a store copy.
 * - Three-name env: the guest gives the job exactly PATH, HOME and LANG
 *   (VM_VALIDATE.envAllowlist), so no credential or identity env var can
 *   reach the candidate even by inheritance; the wrapper below spawns the
 *   candidate with that same allowlist, and the server-side preparation
 *   spawn runs on its own allowlist with --ignore-scripts, so no
 *   candidate-controlled lifecycle hook ever executes off the guest, and the
 *   hooks' inherited env is the allowlist, not the daemon's environment.
 * - Init-authored result drive: the guest's init writes the result JSON after
 *   the job exits, so the job cannot forge, truncate or suppress the outcome
 *   the runner hands back.
 * - Redacted store: the job's HOME gets a placeholder copy of the board's own
 *   agent store — read from `agentDir()` (src/login.ts), the same file
 *   `signIns()` reads; identity keys redacted like every other value — so the
 *   real CLI lists the signed-in providers' catalogs without carrying real
 *   tokens or board identity data.
 * - Compact catalog: the wrapper caps the candidate's stdout at 2 MiB and
 *   re-emits compact provider/id records, so the whole list the parse accepts
 *   survives the guest's 64 KiB stdout tail (VM_VALIDATE.outputTailBytes).
 *
 * A throw is a transport failure only: the caller warns and files normal
 * 7-day bump cards, never a lastError.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./login.ts";
import { OMP_PACKAGE_URL } from "./ompWatch.ts";
import type { ProcSpawn } from "./sandboxRun.ts";
import type { ValidateResponse } from "./vmValidateShared.ts";

/** The exact pin shape the argv guard needs: strict x.y.z only, so the
 * version can never inject shell metacharacters into the job argv. */
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** One year out from `now`, the placeholder shape for credential expiry
 * numbers: the candidate must read every credential as valid, so the real
 * CLI still lists the provider catalogs. */
const REDACT_TTL_MS = 365 * 24 * 3600 * 1000;

const REDACTED = "ottr-probe-redacted";

/** The keys whose number values are expiries (not counts or flags); matches
 * expires / expiresAt / valid_until / refreshed_at shapes. */
const EXPIRY_KEY = /expire|until|_at/i;

/** Depth cap of the recursive data placeholder: deeper values all collapse
 * to the placeholder string, so a hostile nested shape cannot make the
 * builder recurse forever. */
const REDACT_MAX_DEPTH = 4;

/**
 * Builds the secret-free credential copy the probe's job stamps into its
 * HOME: same provider rows and data key shapes as the pinned store, every
 * value a placeholder. Rows with a disabled_cause are dropped. A pinned store
 * that is missing or unreadable yields an empty store (providers: []): the
 * probe then lists no providers, exactly like a board with no sign-ins.
 */
export function buildRedactedStore(
	pinnedDbPath: string,
	outPath: string,
	now: () => number = Date.now,
): { providers: string[] } {
	const expiresAt = now() + REDACT_TTL_MS;
	// The pinned read and the whole write share one try/catch: any unreadable
	// or wrongly-shaped pinned store degrades to an empty copy, never throws.
	let pinnedVersion = 8;
	let rows: {
		provider: string;
		credential_type: string;
		data: string;
		identity_key: string | null;
		created_at: number | null;
		updated_at: number | null;
		disabled_cause: string | null;
	}[] = [];
	try {
		const pinned = new Database(pinnedDbPath, { readonly: true });
		try {
			// The pinned store is omp's own output, but it is still outside data:
			// narrow per row, and drop a row that lost its shape.
			const versionRow: unknown = pinned
				.query("SELECT version FROM auth_schema_version WHERE id = 1")
				.get();
			if (
				typeof versionRow === "object" &&
				versionRow !== null &&
				"version" in versionRow &&
				typeof versionRow.version === "number"
			)
				pinnedVersion = versionRow.version;
			const pinnedRows: unknown[] = pinned
				.query(
					"SELECT provider, credential_type, data, identity_key, created_at, updated_at, disabled_cause FROM auth_credentials",
				)
				.all();
			rows = pinnedRows.flatMap((row) => {
				if (typeof row !== "object" || row === null) return [];
				const r = row as Record<string, unknown>; // key type for a typeof-verified object row
				if (
					typeof r.provider !== "string" ||
					typeof r.credential_type !== "string" ||
					typeof r.data !== "string"
				)
					return [];
				return [
					{
						provider: r.provider,
						credential_type: r.credential_type,
						data: r.data,
						identity_key:
							typeof r.identity_key === "string" ? r.identity_key : null,
						created_at: typeof r.created_at === "number" ? r.created_at : null,
						updated_at: typeof r.updated_at === "number" ? r.updated_at : null,
						disabled_cause:
							typeof r.disabled_cause === "string" ? r.disabled_cause : null,
					},
				];
			});
		} finally {
			pinned.close();
		}
	} catch {
		rows = [];
	}

	rmSync(outPath, { force: true });
	mkdirSync(dirname(outPath), { recursive: true });
	const providers = new Set<string>();
	const out = new Database(outPath);
	try {
		out.exec(
			"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)",
		);
		out.exec(
			"CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)",
		);
		out.exec(
			"CREATE TABLE auth_change_revision (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)",
		);
		out.run("INSERT INTO auth_schema_version (id, version) VALUES (1, ?)", [
			pinnedVersion,
		]);
		out.run("INSERT INTO auth_change_revision (id, revision) VALUES (1, 1)");
		for (const row of rows) {
			// The pinned row carries its retirement reason: a disabled credential
			// must not resurrect as a valid provider identity in the guest.
			if (row.disabled_cause !== null && row.disabled_cause !== undefined)
				continue;
			providers.add(row.provider);
			// identity_key holds board identity data (emails, account and org
			// ids): placeholder it like every other value. Null stays null.
			out.run(
				"INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					row.provider,
					row.credential_type,
					JSON.stringify(redactData(parseJson(row.data), "data", 0, expiresAt)),
					row.identity_key === null ? null : REDACTED,
					row.created_at ?? null,
					row.updated_at ?? null,
				],
			);
		}
	} finally {
		// Close before returning: the copy is one single file (no -wal residue),
		// which is exactly what the payload tar packs.
		out.close();
	}
	return { providers: [...providers].sort() };
}

/** JSON.parse of the pinned data column; unparseable shapes degrade to the
 * placeholder string, because there are no data keys left to preserve. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return REDACTED;
	}
}

/** The per-key placeholder: same key, same JSON type, no original value. */
function redactData(
	value: unknown,
	key: string,
	depth: number,
	expiresAt: number,
): unknown {
	if (depth > REDACT_MAX_DEPTH) return REDACTED;
	if (value === null) return REDACTED;
	switch (typeof value) {
		case "string":
			return REDACTED;
		case "number":
			return EXPIRY_KEY.test(key) ? expiresAt : 1;
		case "boolean":
			return true;
		case "object": {
			if (Array.isArray(value))
				return value.map((item) => redactData(item, key, depth + 1, expiresAt));
			const out: Record<string, unknown> = {};
			for (const [childKey, child] of Object.entries(value))
				out[childKey] = redactData(child, childKey, depth + 1, expiresAt);
			return out;
		}
		default:
			return REDACTED;
	}
}

/** The trusted guest-side wrapper (written into the payload as
 * probe-wrapper.mjs): stamps the redacted copy into the job HOME, spawns the
 * candidate cli under the three-name env allowlist, caps the candidate's
 * stdout at 2 MiB, and re-emits compact provider/id records — the whole list
 * the parse accepts survives the guest's 64 KiB stdout tail. The candidate's
 * own stderr passes through to the job's stderr. Exit codes: the candidate's,
 * or 3 when the output is not a models catalog. `OMP_PROBE_STORE` overrides
 * the stamped store path for tests; the guest job env never carries that
 * name, so production always reads /target/store/agent.db. */
export const probeWrapperSource = `import { copyFileSync, mkdirSync } from "node:fs";
const cli = process.argv[2];
if (typeof cli !== "string" || cli === "") {
	console.error("probe wrapper: no candidate cli path");
	process.exit(3);
}
const home = process.env.HOME ?? "";
if (home === "") {
	console.error("probe wrapper: no HOME");
	process.exit(3);
}
mkdirSync(home + "/.omp/agent", { recursive: true });
copyFileSync(
	process.env.OMP_PROBE_STORE ?? "/target/store/agent.db",
	home + "/.omp/agent/agent.db",
);
const child = Bun.spawn([process.execPath, cli, "models", "--json"], {
	env: {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		LANG: process.env.LANG ?? "C.UTF-8",
	},
	stdin: "ignore",
	stdout: "pipe",
	stderr: "inherit",
});
const CAP = 2 * 1024 * 1024;
const chunks = [];
let size = 0;
const reader = child.stdout.getReader();
for (;;) {
	const { done, value } = await reader.read();
	if (done) break;
	if (size < CAP) chunks.push(value);
	size += value.byteLength;
	if (size >= CAP) {
		// Bounded: stop storing and stop the candidate; whatever the parse
		// makes of the partial text, the outcome is a non-fast-track run.
		child.kill();
		await reader.cancel().catch(() => {});
		break;
	}
}
const code = await child.exited;
const text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, CAP));
let out;
try {
	const parsed = JSON.parse(text);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Array.isArray(parsed.models)
	)
		throw new Error("no models array");
	const models = parsed.models.map((m) => ({
		provider: typeof m === "object" && m !== null ? m.provider : undefined,
		id: typeof m === "object" && m !== null ? m.id : undefined,
	}));
	out = JSON.stringify({ models });
} catch (err) {
	console.error(
		"probe wrapper: the candidate output is not a models catalog:",
		String(err),
	);
	process.exit(code === 0 || code === null ? 3 : code);
}
process.stdout.write(out);
process.exit(code ?? 3);
`;

/** The guest-side job argv: the payload's wrapper runs the candidate's
 * bundled cli. `binRel` must pass binRelError (the caller resolved it
 * against the installed package dir already). */
export function probeJobArgv(binRel: string): string[] {
	return [
		"bun",
		"/target/pkg/probe-wrapper.mjs",
		`/target/pkg/node_modules/@oh-my-pi/pi-coding-agent/${binRel}`,
	];
}

/** `omp-probe-<hex8>`: fits the ValidateRequest id rule and names the run dir. */
const defaultId = (): string => `omp-probe-${randomBytes(4).toString("hex")}`;

/** The package dir inside the payload tar, relative to payload/pkg: the job
 * command's bun entry path depends on it. */
const PKG_PACKAGE_DIR = join("node_modules", "@oh-my-pi", "pi-coding-agent");

/** binRel rule shared by both package.json reads: relative posix only, no
 * ".." and no leading "/", so the interpolated job command stays inside the
 * candidate's own package dir in the guest. */
function binRelError(binRel: string): string | null {
	if (
		binRel === "" ||
		binRel.startsWith("/") ||
		binRel.split("/").includes("..")
	)
		return `candidate bin path escapes the package: ${binRel}`;
	return null;
}

/** The package's bin entry (string, or {omp}) as a relative path, or the
 * exact reason it is unusable. */
function readBinRel(packageJsonPath: string): string {
	let raw: string;
	try {
		raw = readFileSync(packageJsonPath, "utf8");
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		throw new Error(
			`omp models probe: cannot read the candidate package.json at ${packageJsonPath} (${why})`,
		);
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(raw);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		throw new Error(
			`omp models probe: the candidate package.json is not valid JSON (${why})`,
		);
	}
	if (typeof manifest !== "object" || manifest === null)
		throw new Error(
			"omp models probe: the candidate package.json is not a JSON object",
		);
	const bin: unknown = "bin" in manifest ? manifest.bin : undefined;
	let binRel: unknown = bin;
	if (typeof bin === "object" && bin !== null && "omp" in bin) binRel = bin.omp;
	if (typeof binRel !== "string" || binRel === "")
		throw new Error(
			`omp models probe: the candidate package.json declares no bin (got ${JSON.stringify(bin ?? null)})`,
		);
	const escapeError = binRelError(binRel);
	if (escapeError !== null) throw new Error(escapeError);
	return binRel;
}

/** The preparation spawn's env: an allowlist, never the daemon environment.
 * The candidate's dependency tree is untrusted, so nothing it runs during
 * preparation may see provider keys, configuration pointers or the worker
 * token; the names below carry paths and build toggles only. PATH stays (the
 * runner must find bun and tar); it carries no secret by itself. */
export function probeSpawnEnv(
	source: NodeJS.ProcessEnv,
	runDir: string,
): Record<string, string> {
	const out: Record<string, string> = {
		PUPPETEER_SKIP_DOWNLOAD: "1",
		PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "1",
		BUN_INSTALL_CACHE_DIR: join(runDir, "bun-cache"),
		HOME: join(runDir, "home"),
		LANG: source.LANG ?? "C.UTF-8",
	};
	if (source.PATH !== undefined) out.PATH = source.PATH;
	return out;
}

/** The default preparation runner: runs argv on the allowlist env and kills
 * the child when `signal` aborts, so the transport's deadline bounds every
 * preparation subprocess. */
export function probePrepSpawn(
	runDir: string,
	signal: AbortSignal,
	source: NodeJS.ProcessEnv,
): ProcSpawn {
	return async (argv) => {
		mkdirSync(join(runDir, "home"), { recursive: true });
		mkdirSync(join(runDir, "bun-cache"), { recursive: true });
		const proc = Bun.spawn(argv, {
			env: probeSpawnEnv(source, runDir),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const kill = (): void => {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill();
		};
		signal.addEventListener("abort", kill);
		try {
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).arrayBuffer(),
				new Response(proc.stderr).text(),
			]);
			const code = await proc.exited;
			// A killed child reports the signal: fold it into a rejection so the
			// caller's aborted branch maps the run to its timeout error.
			if (signal.aborted)
				throw new Error("omp models probe: preparation killed at the deadline");
			return { code, stdout: new Uint8Array(stdout), stderr };
		} finally {
			signal.removeEventListener("abort", kill);
			kill();
		}
	};
}

export function createOmpProbeTransport(
	deps: {
		/** Defaults to process.env per call. */
		env?: () => NodeJS.ProcessEnv;
		/** Defaults to globalThis.fetch. */
		fetchImpl?: typeof fetch;
		/** Defaults to a Bun.spawn runner (sandboxRun's defaultSpawn shape). */
		spawnImpl?: ProcSpawn;
		/** Defaults to env OTTR_DATA_DIR or "/data". */
		dataRoot?: string;
		/** Defaults to `omp-probe-<hex8>` style ids. */
		idFactory?: () => string;
	} = {},
): (
	project: string,
	version: string,
	timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }> {
	return async (project, version, timeoutMs) => {
		const env = deps.env ?? (() => process.env);
		const source = env();
		const base = (source.OTTR_VM_RUNNER_URL ?? "").trim().replace(/\/+$/, "");
		if (base === "")
			throw new Error(
				"OTTR_VM_RUNNER_URL is not set; the probe needs the vm-runner /validate endpoint.",
			);
		const token = (source.OTTR_WORKER_TOKEN ?? "").trim();
		if (token === "")
			throw new Error(
				"OTTR_WORKER_TOKEN is not set; the runner rejects an unauthorized /validate call.",
			);
		if (!VERSION_RE.test(version))
			throw new Error(`omp models probe: version is not x.y.z: ${version}`);

		const id = (deps.idFactory ?? defaultId)();
		const dataRoot = deps.dataRoot ?? source.OTTR_DATA_DIR ?? "/data";
		const runDir = join(dataRoot, project, "omp-probe-jobs", id);
		const fetchImpl = deps.fetchImpl ?? fetch;
		mkdirSync(runDir, { recursive: true });
		// The deadline arms before any work: downloads, extraction, install,
		// packing, dispatch and the response body all share it, and the
		// preparation runner kills its subprocess on expiry.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const spawn =
			deps.spawnImpl ?? probePrepSpawn(runDir, controller.signal, source);
		try {
			// 1. Which exact release? The packument names its tarball and integrity.
			const packumentRes = await fetchImpl(OMP_PACKAGE_URL, {
				headers: { accept: "application/json", "user-agent": "ottr" },
				signal: controller.signal,
			});
			if (!packumentRes.ok)
				throw new Error(
					`candidate packument fetch failed: HTTP ${packumentRes.status}`,
				);
			const packument: unknown = await packumentRes.json();
			if (typeof packument !== "object" || packument === null)
				throw new Error(
					"omp models probe: the registry packument is not a JSON object",
				);
			if (!("versions" in packument))
				throw new Error(
					"omp models probe: the registry packument has no versions",
				);
			const versions: unknown = packument.versions;
			if (typeof versions !== "object" || versions === null)
				throw new Error(
					"omp models probe: the registry packument versions is not an object",
				);
			// Indexing needs the key type; the typeof check above proved an object.
			const versionMap = versions as Record<string, unknown>;
			const manifest: unknown = versionMap[version];
			if (manifest === undefined)
				throw new Error(
					`omp models probe: version ${version} is not in the registry packument`,
				);
			const dist: unknown =
				typeof manifest === "object" && manifest !== null && "dist" in manifest
					? manifest.dist
					: undefined;
			const tarballUrl: unknown =
				typeof dist === "object" && dist !== null && "tarball" in dist
					? dist.tarball
					: undefined;
			const integrity: unknown =
				typeof dist === "object" && dist !== null && "integrity" in dist
					? dist.integrity
					: undefined;
			if (typeof tarballUrl !== "string" || tarballUrl === "")
				throw new Error(
					`omp models probe: version ${version} declares no dist.tarball`,
				);
			if (
				typeof integrity !== "string" ||
				!integrity.startsWith("sha512-") ||
				integrity.length <= "sha512-".length
			)
				throw new Error(
					`omp models probe: version ${version} declares no sha512 dist.integrity`,
				);

			// 2. The tarball itself, verified against the packument before any
			// spawn touches it: a tampered mirror must never install.
			const tgzRes = await fetchImpl(tarballUrl, {
				signal: controller.signal,
			});
			if (!tgzRes.ok)
				throw new Error(
					`candidate tarball fetch failed: HTTP ${tgzRes.status}`,
				);
			const bytes = new Uint8Array(await tgzRes.arrayBuffer());
			if (bytes.length > 64 * 1024 * 1024)
				throw new Error("candidate tarball over 64 MiB");
			const digest = new Bun.CryptoHasher("sha512")
				.update(bytes)
				.digest("base64");
			if (digest !== integrity.slice("sha512-".length))
				throw new Error(`candidate tarball integrity mismatch for ${version}`);
			const candidateTgz = join(runDir, "candidate.tgz");
			writeFileSync(candidateTgz, bytes);

			// 3. What does the tarball itself say its bin is? Read before the
			// install, so a malformed candidate fails before bun touches it.
			const rawDir = join(runDir, "raw");
			mkdirSync(rawDir, { recursive: true });
			const extract = await spawn(["tar", "-xzf", candidateTgz, "-C", rawDir]);
			if (extract.code !== 0)
				throw new Error(
					`candidate tarball extraction failed (exit ${extract.code}): ${extract.stderr.trim().slice(-500)}`,
				);
			readBinRel(join(rawDir, "package", "package.json"));

			// 4. Install from the verified tarball: the guest gets a bun install
			// tree, so the job runs `bun <cli>` with no network at job time.
			const pkgDir = join(runDir, "payload", "pkg");
			mkdirSync(pkgDir, { recursive: true });
			// 4. Install from the verified tarball: the guest gets a bun install
			// tree, so the job runs `bun <cli>` with no network at job time.
			// --ignore-scripts: the candidate and its dependency tree are
			// untrusted, so no lifecycle hook of theirs ever executes on the
			// server, and the spawn's env is the probeSpawnEnv allowlist.
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "ottr-omp-probe",
					private: true,
					dependencies: { "@oh-my-pi/pi-coding-agent": version },
				}),
			);
			const add = await spawn([
				"bun",
				"add",
				"--ignore-scripts",
				"--cwd",
				pkgDir,
				candidateTgz,
			]);
			if (add.code !== 0)
				throw new Error(
					`candidate install failed: ${add.stderr.trim().slice(-500)}`,
				);
			// The trusted wrapper: stamps the store, caps and compacts the
			// candidate's stdout (probeJobArgv's bun entry runs it in the guest).
			writeFileSync(join(pkgDir, "probe-wrapper.mjs"), probeWrapperSource);

			// 5. Catalog context without secrets: the placeholder store drives the
			// real CLI's provider list. The source is the board's own agent store
			// — `agentDir()`, the same file `signIns()` reads (src/login.ts); a
			// store that is missing or unreadable degrades to an empty copy, and
			// the probe then lists no providers, like a board with no sign-ins.
			const storeDir = join(runDir, "payload", "store");
			mkdirSync(storeDir, { recursive: true });
			buildRedactedStore(
				join(agentDir(), "agent.db"),
				join(storeDir, "agent.db"),
			);

			// 6. Pack the payload: hard-dereference, because bun installs hard
			// links from its cache and the runner's tar reader skips hard-link
			// members.
			const targetTar = join(runDir, "target.tar");
			const pack = await spawn([
				"tar",
				"--hard-dereference",
				"-cf",
				targetTar,
				"--directory",
				join(runDir, "payload"),
				"pkg",
				"store",
			]);
			if (pack.code !== 0)
				throw new Error(
					`candidate payload tar failed (exit ${pack.code}): ${pack.stderr.trim().slice(-500)}`,
				);
			// The installed tree is what the guest will run: re-read its bin and
			// apply the same escape guard as the source read.
			const binRel = readBinRel(join(pkgDir, PKG_PACKAGE_DIR, "package.json"));

			// 7. Dispatch through /validate; the request carries no lists and no
			// taskId, so the job gets nothing but the payload it packs. The
			// deadline stays armed through the response body: fetch can return
			// headers while the body is still incomplete, and a stalled body
			// must not hold the watch past modelsTimeoutMs.
			const res = await fetchImpl(`${base}/validate`, {
				method: "POST",
				headers: {
					// The token rides the wire only; it never enters the request
					// body or any text this function returns.
					"x-otwr-token": token,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					id,
					project,
					targetTar,
					job: {
						argv: probeJobArgv(binRel),
						cwd: "/target",
					},
				}),
				signal: controller.signal,
			});
			const bodyText = await res.text();
			// Defense in depth: a misbehaving runner must not echo the wire token
			// into the error text the watch stores as its exact blocker.
			const safe = bodyText.replaceAll(token, "[REDACTED]");
			if (res.status !== 200)
				throw new Error(`${res.status}: ${safe.slice(0, 500)}`);
			const body = JSON.parse(bodyText) as ValidateResponse;
			const job = body.job;
			if (job === null || job === undefined)
				throw new Error(
					"omp models probe: the guest reported no job result (self-check failed or the result drive is absent)",
				);
			if (job.timedOut)
				throw new Error(
					"omp models probe: the guest killed the job at its time cap",
				);
			if (job.exitCode === null)
				throw new Error(
					`omp models probe ended without an exit code (signal ${job.signal})`,
				);
			return {
				code: job.exitCode,
				stdout: job.stdoutTail,
				stderr: job.stderrTail,
			};
		} catch (err) {
			// The deadline maps everything it killed to one timeout error: the
			// caller warns with it, and no other failure can masquerade as it.
			if (controller.signal.aborted)
				throw new Error(`omp models probe timed out after ${timeoutMs} ms`);
			throw err;
		} finally {
			clearTimeout(timer);
			rmSync(runDir, { recursive: true, force: true });
		}
	};
}

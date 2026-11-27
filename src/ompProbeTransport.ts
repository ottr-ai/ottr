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
 *   reach the candidate even by inheritance.
 * - Init-authored result drive: the guest's init writes the result JSON after
 *   the job exits, so the job cannot forge, truncate or suppress the outcome
 *   the runner hands back.
 * - Redacted store: the job's HOME gets a placeholder copy of the pinned
 *   agent store (same rows and key shapes, no secret values), so the real CLI
 *   lists the signed-in providers' catalogs without carrying real tokens.
 * - 64 KiB stdout tails (VM_VALIDATE.outputTailBytes) are the transport's
 *   real stdout bound: a models list is far smaller, so the tail bounds a
 *   runaway candidate's output, not a normal run.
 *
 * A throw is a transport failure only: the caller warns and files normal
 * 7-day bump cards, never a lastError.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { childDatabaseEnv } from "./childEnv.ts";
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
			out.run(
				"INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					row.provider,
					row.credential_type,
					JSON.stringify(redactData(parseJson(row.data), "data", 0, expiresAt)),
					row.identity_key ?? null,
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

/** The guest-side job command: stamps the redacted copy into the job HOME,
 * then execs the candidate's bundled cli (one process left for the kill).
 * `binRel` must be a relative posix path without ".." and without a leading
 * "/" (the caller resolved it against the installed package dir already). */
export function probeJobArgv(binRel: string): string[] {
	return [
		"/bin/sh",
		"-c",
		`mkdir -p "$HOME/.omp/agent" && cp /target/store/agent.db "$HOME/.omp/agent/agent.db" && exec bun /target/pkg/node_modules/@oh-my-pi/pi-coding-agent/${binRel} models --json`,
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

/** sandboxRun's defaultSpawn shape, with the install env the candidate's own
 * postinstall scripts need: no puppeteer download, and bun's cache plus HOME
 * under the run dir, so the install writes nothing outside it. */
const defaultSpawn =
	(runDir: string): ProcSpawn =>
	async (argv) => {
		const proc = Bun.spawn(argv, {
			env: {
				...childDatabaseEnv(),
				PUPPETEER_SKIP_DOWNLOAD: "1",
				PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "1",
				BUN_INSTALL_CACHE_DIR: join(runDir, "bun-cache"),
				HOME: join(runDir, "home"),
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).text(),
		]);
		return { code: await proc.exited, stdout: new Uint8Array(stdout), stderr };
	};

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
		const pinnedDb = (source.OTTR_PINNED_AGENT_DB ?? "").trim();
		if (pinnedDb === "")
			throw new Error(
				"OTTR_PINNED_AGENT_DB is not set; the probe stamps the guest's HOME from it.",
			);
		if (!VERSION_RE.test(version))
			throw new Error(`omp models probe: version is not x.y.z: ${version}`);

		const id = (deps.idFactory ?? defaultId)();
		const dataRoot = deps.dataRoot ?? source.OTTR_DATA_DIR ?? "/data";
		const runDir = join(dataRoot, project, "omp-probe-jobs", id);
		const spawn = deps.spawnImpl ?? defaultSpawn(runDir);
		const fetchImpl = deps.fetchImpl ?? fetch;
		mkdirSync(runDir, { recursive: true });
		try {
			// 1. Which exact release? The packument names its tarball and integrity.
			const packumentRes = await fetchImpl(OMP_PACKAGE_URL, {
				headers: { accept: "application/json", "user-agent": "ottr" },
				signal: AbortSignal.timeout(30_000),
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
				signal: AbortSignal.timeout(60_000),
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
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "ottr-omp-probe",
					private: true,
					dependencies: { "@oh-my-pi/pi-coding-agent": version },
				}),
			);
			const add = await spawn(["bun", "add", "--cwd", pkgDir, candidateTgz]);
			if (add.code !== 0)
				throw new Error(
					`candidate install failed: ${add.stderr.trim().slice(-500)}`,
				);

			// 5. Catalog context without secrets: the placeholder store drives the
			// real CLI's provider list (missing pinned store degrades to empty).
			const storeDir = join(runDir, "payload", "store");
			mkdirSync(storeDir, { recursive: true });
			buildRedactedStore(pinnedDb, join(storeDir, "agent.db"));

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
			// taskId, so the job gets nothing but the payload it packs.
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let res: Response;
			try {
				res = await fetchImpl(`${base}/validate`, {
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
			} catch (err) {
				if (controller.signal.aborted)
					throw new Error(`omp models probe timed out after ${timeoutMs} ms`);
				throw err;
			} finally {
				clearTimeout(timer);
			}
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
		} finally {
			rmSync(runDir, { recursive: true, force: true });
		}
	};
}

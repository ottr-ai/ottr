/**
 * Fails when bun.lock took a dependency version while its release line is
 * unsettled (OTTR-909): a newer stable release of the same major.minor line
 * is still younger than the 7-day release age gate, so the pin would be
 * replaced within days. Runs inside `bun run check` only when bun.lock
 * differs from origin/main; without a lock change it makes no network call.
 * The rule itself lives in src/releaseLine.ts (docs/specs/release-line-gate.md).
 */
import { readFileSync } from "node:fs";
import {
	lineCapReached,
	type RegistryRelease,
	unsettledBlocker,
} from "../src/releaseLine.ts";

const DAY_MS = 86_400_000;
const AGE_MS = 7 * DAY_MS;
const CAP_MS = 14 * DAY_MS;
const TIMEOUT_MS = 20_000;
/** "name@1.2.3" or "@scope/name@1.2.3-beta.1"; the last @ separates the version. */
const REGISTRY_ENTRY = /^(@?[^@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
/** Stable only: a prerelease pin never blocks and never gets checked. */
const STABLE = /^\d+\.\d+\.\d+$/;

/** Parses bun.lock's JSONC by walking strings first, then skipping comments
 * and dropping trailing commas before JSON.parse. Never a blind "//" strip —
 * integrity hashes contain "//" (e.g. rw@1.3.3 in the real lock). */
function parseJsonc(text: string): unknown {
	let out = "";
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const c = text[i];
		if (inString) {
			if (c === "\\") {
				out += text.slice(i, i + 2);
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			out += c;
			i++;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
			continue;
		}
		if (c === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j] ?? "")) j++;
			if (text[j] === "}" || text[j] === "]") {
				i++;
				continue;
			}
		}
		out += c;
		i++;
	}
	return JSON.parse(out);
}

/** git inside the repo root; stdin ignored so nothing can hang on a prompt. */
function git(...args: string[]): {
	code: number;
	stdout: string;
	stderr: string;
} {
	const r = Bun.spawnSync(["git", ...args], {
		cwd: process.cwd(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: r.exitCode ?? 1,
		stdout: r.stdout.toString(),
		stderr: r.stderr.toString(),
	};
}

/** name -> installed version for the registry packages of one lock text;
 * non-registry entries (workspace:, link:, git:, file:, tarballs) never match. */
function registryEntries(lockText: string): Map<string, string> {
	const entries = new Map<string, string>();
	const parsed = parseJsonc(lockText) as { packages?: unknown } | null;
	const packages = parsed?.packages;
	if (packages === null || typeof packages !== "object") return entries;
	for (const tuple of Object.values(packages as Record<string, unknown>)) {
		if (!Array.isArray(tuple)) continue;
		const entry: unknown = tuple[0];
		if (typeof entry !== "string") continue;
		const match = REGISTRY_ENTRY.exec(entry);
		if (match === null) continue;
		const name = match[1];
		const version = match[2];
		if (name === undefined || version === undefined) continue;
		entries.set(name, version);
	}
	return entries;
}

/** origin/main's bun.lock text; a base without the file is an empty base map. */
function baseLockText(): string {
	const shown = git("show", "origin/main:bun.lock");
	return shown.code === 0 ? shown.stdout : "";
}

/** Names the root package.json declares directly. */
function directNames(): Set<string> {
	const parsed = JSON.parse(readFileSync("package.json", "utf8")) as {
		dependencies?: Record<string, unknown>;
		devDependencies?: Record<string, unknown>;
		optionalDependencies?: Record<string, unknown>;
	};
	return new Set(
		Object.keys(parsed.dependencies ?? {})
			.concat(Object.keys(parsed.devDependencies ?? {}))
			.concat(Object.keys(parsed.optionalDependencies ?? {})),
	);
}

type Changed = { name: string; version: string; direct: boolean };

/** Changed registry packages, ascending by name: added or version-differing
 * against origin/main; installed prereleases are skipped. */
function changedPackages(): Changed[] {
	const base = registryEntries(baseLockText());
	const direct = directNames();
	const changed: Changed[] = [];
	for (const [name, version] of registryEntries(
		readFileSync("bun.lock", "utf8"),
	)) {
		if (base.get(name) === version) continue;
		if (!STABLE.test(version)) continue;
		changed.push({ name, version, direct: direct.has(name) });
	}
	changed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return changed;
}

type Packument = {
	versions?: Record<string, { deprecated?: unknown } | undefined>;
	time?: Record<string, unknown>;
};

/** Packument -> releases: the time entries of versions it still lists,
 * deprecated when the metadata marks it with a string (the ompWatch rule). */
function releasesOf(body: unknown): RegistryRelease[] {
	if (body === null || typeof body !== "object")
		throw new Error("packument is not an object");
	const packument = body as Packument;
	const versions = packument.versions;
	if (versions === null || typeof versions !== "object")
		throw new Error("packument has no versions map");
	const time = packument.time;
	if (time === null || typeof time !== "object")
		throw new Error("packument has no time map");
	const releases: RegistryRelease[] = [];
	for (const version of Object.keys(versions)) {
		const published = Date.parse(String(time[version] ?? ""));
		if (!Number.isFinite(published)) continue;
		releases.push({
			version,
			publishedAt: published,
			deprecated: typeof versions[version]?.deprecated === "string",
		});
	}
	return releases;
}

/** GET {registry}/{name} with "/" encoded as %2F and "@" kept (the
 * OMP_PACKAGE_URL style). */
async function fetchReleases(name: string): Promise<RegistryRelease[]> {
	const registry = (
		process.env.OTTR_NPM_REGISTRY ?? "https://registry.npmjs.org"
	).replace(/\/+$/, "");
	const response = await fetch(`${registry}/${name.replaceAll("/", "%2F")}`, {
		headers: { "user-agent": "ottr" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok)
		throw new Error(`registry returned HTTP ${response.status}`);
	return releasesOf(await response.json());
}

/** The scan: one registry call per changed package, ascending by name. A
 * registry error exits 1 immediately; direct failures collect to the end,
 * transitive ones warn inline and keep the exit 0. */
async function scan(): Promise<number> {
	const now = Date.now();
	const failures: string[] = [];
	for (const pkg of changedPackages()) {
		let releases: RegistryRelease[];
		try {
			releases = await fetchReleases(pkg.name);
		} catch (error) {
			console.error(
				`release line check failed: ${pkg.name}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return 1;
		}
		const blocker = unsettledBlocker(releases, pkg.version, now, AGE_MS);
		if (blocker === null) continue;
		if (lineCapReached(releases, pkg.version, now, AGE_MS, CAP_MS)) continue;
		const days = Math.floor((now - blocker.publishedAt) / DAY_MS);
		const line = `release line not settled: ${pkg.name} ${pkg.version}, ${blocker.version} is ${days} days old`;
		if (pkg.direct) failures.push(line);
		else console.error(`warning: ${line} (transitive)`);
	}
	for (const line of failures) console.error(line);
	return failures.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
	if (git("rev-parse", "--verify", "origin/main").code !== 0) {
		console.error(
			"release line check: cannot resolve origin/main; run git fetch origin",
		);
		return 1;
	}
	const diff = git("diff", "--quiet", "origin/main", "--", "bun.lock");
	if (diff.code === 0) return 0; // unchanged: silent exit, no network call
	if (diff.code !== 1) return 1; // any other git failure
	return scan();
}

if (import.meta.main) process.exit(await main());

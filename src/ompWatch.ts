/**
 * The omp watch (docs/specs/omp-watch.md): an hourly tick reads the omp pin in a project's
 * Dockerfile.worker, lists the newer omp releases on npm, has a model review each release's
 * notes, files a fail card that holds the pin, and files a "Bump omp to X" card when a
 * reviewed release is old enough — or at once, at P1, when it adds model access for a
 * provider the board is signed in to (OTTR-1287).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clean,
	defaultSpawn,
	runGatewayWithFallbacks,
	type SpawnFn,
} from "./forkAnalysis.ts";
import type { ForkProject } from "./forks.ts";
import { upstreamToken } from "./githubHost.ts";
import { withGithubRetry } from "./githubRetry.ts";
import { PROVIDER_ID } from "./login.ts";
import { modelFallbacks } from "./models.ts";
import {
	OMP_REVIEW_INSTRUCTIONS,
	ompBumpCardPrompt,
	ompFailCardPrompt,
} from "./prompts.ts";
import { compareVersions, releaseLineAccepts } from "./releaseLine.ts";
import { singleFlightTick } from "./singleFlight.ts";

export const OMP_WATCH_GATES = {
	/** Model reviews in one tick for one project. */
	reviewsPerTick: 5,
	/** npm release age a bump target needs. */
	ageDays: 7,
	/** The oldest a release line waits for a young release; past this the cap lifts the wait. */
	capDays: 14,
	/** A release without GitHub notes is retried for this long after its npm publish. */
	notesGraceMs: 86_400_000,
	/** Release notes are cut to this many characters for the model. */
	notesCap: 30_000,
	/** One `omp models --json` run waits at most this long (a cold bunx install included). */
	modelsTimeoutMs: 180_000,
	/** Model ids one models run may hold; more rejects the run. */
	modelsMaxEntries: 1000,
	/** Stdout characters one models run may hold; more rejects the run before the parse. */
	modelsMaxChars: 1_000_000,
	/** Model list runs per tick for one project (the pin's set and backfilled sets). */
	modelsPerTick: 5,
} as const;

export const OMP_PACKAGE_URL =
	"https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent";

const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 20_000;
const MODEL_TIMEOUT_MS = 90_000;
/** The board's prompt limit (the card routes refuse longer prompts). */
const PROMPT_LIMIT = 20_000;
const TRUNCATED = "\n… (truncated; read the full release notes on GitHub)";
const MAX_REASONS = 20;
const REASON_MAX = 500;

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PIN_RE = /^ARG OMP_VERSION=(\d+\.\d+\.\d+)[ \t]*\r?$/m;
/** One model id of a catalog entry; strict, because the models output is untrusted. Model
 * ids can name a compatible-provider prefix (Baseten serves `openai/gpt-oss-120b`), so 1 to
 * 3 non-empty segments join with `/`; each segment starts alphanumeric and continues with
 * `.`, `_`, `:`, `-` or alphanumerics, at most 64 characters. */
const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._:-]{0,63}";
const MODEL_ID_RE = new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,2}$`);
/** One stored `provider/model` pair; the provider part is omp's PROVIDER_ID (src/login.ts),
 * which holds no slash, so the first slash splits the pair. */
export const PAIR_RE = new RegExp(
	`^([a-z0-9][a-z0-9-]{0,63})/(${SEGMENT}(?:/${SEGMENT}){0,2})$`,
);

export type OmpVerdict = {
	verdict: "pass" | "fail";
	reasons: string[];
	cardId: string | null;
	at: number;
};

/** One version's model set, read under one credential context: the sorted providers the
 * board had an active sign-in for when omp listed the catalog. omp lists only the models
 * its current credentials make available, so sets from different contexts never compare. */
export type OmpModelSet = {
	providers: string[];
	pairs: string[];
};

export type OmpWatchState = {
	verdicts: Record<string, OmpVerdict>;
	/** One snapshot per version; a version without an entry never fast-tracks. */
	modelSets: Record<string, OmpModelSet>;
	bumpCard: { id: string; version: string } | null;
	lastError: { reason: string; at: number } | null;
};

const emptyState = (): OmpWatchState => ({
	verdicts: {},
	modelSets: {},
	bumpCard: null,
	lastError: null,
});

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const errText = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

/** The only inherited vars a candidate release sees in its probe: no identity, no
 * credentials, no board configuration (no agent.db pointer, no GitHub token, no SSH
 * agent). Proxy settings stay, so installs also work behind one. */
const PROBE_ENV_KEYS = [
	"PATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

/** The shared cache for probe installs: immutable package files of exact versions, never
 * execution state (that lives and dies in the probe's throwaway HOME). */
const modelsCacheDir = (): string => join(tmpdir(), "ottr-omp-models-cache");

/** The probe's env: the whitelist, a throwaway HOME, and the shared package cache. */
function probeEnv(home: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		HOME: home,
		BUN_INSTALL_CACHE_DIR: modelsCacheDir(),
	};
	for (const k of PROBE_ENV_KEYS) {
		const v = process.env[k];
		if (v !== undefined) env[k] = v;
	}
	return env;
}

/** The pinned omp version: the first `ARG OMP_VERSION=x.y.z` line, or null. */
export function parsePin(dockerfile: string): string | null {
	return PIN_RE.exec(dockerfile)?.[1] ?? null;
}

// Numeric x.y.z order lives in ./releaseLine.ts now; the export stays for existing imports.
export { compareVersions };

/** One verdict entry; null when it fails the shape checks. */
function parseVerdictEntry(v: unknown): OmpVerdict | null {
	if (!isObj(v)) return null;
	const { verdict, reasons, cardId, at } = v;
	if (verdict !== "pass" && verdict !== "fail") return null;
	if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === "string"))
		return null;
	if (cardId !== null && typeof cardId !== "string") return null;
	if (verdict === "fail" && cardId === null) return null;
	if (typeof at !== "number" || !Number.isFinite(at)) return null;
	return { verdict, reasons, cardId, at };
}

/** The verdict map; entries that fail the shape checks are dropped. */
function parseVerdicts(raw: unknown): Record<string, OmpVerdict> {
	const out: Record<string, OmpVerdict> = {};
	if (!isObj(raw)) return out;
	for (const [version, v] of Object.entries(raw)) {
		if (!VERSION_RE.test(version)) continue;
		const parsed = parseVerdictEntry(v);
		if (parsed !== null) out[version] = parsed;
	}
	return out;
}

/** The bump-card pointer; null unless id and version both parse. */
function parseBumpCard(raw: unknown): { id: string; version: string } | null {
	if (
		isObj(raw) &&
		typeof raw.id === "string" &&
		typeof raw.version === "string" &&
		VERSION_RE.test(raw.version)
	)
		return { id: raw.id, version: raw.version };
	return null;
}

/** The last tick's failure record; null unless the shape parses. */
function parseLastError(raw: unknown): { reason: string; at: number } | null {
	const e = raw;
	if (
		isObj(e) &&
		typeof e.reason === "string" &&
		typeof e.at === "number" &&
		Number.isFinite(e.at)
	)
		return { reason: e.reason, at: e.at };
	return null;
}

/** The stored model sets; entries that fail the shape checks are dropped (no fast track). */
function parseModelSets(raw: unknown): Record<string, OmpModelSet> {
	const out: Record<string, OmpModelSet> = {};
	if (!isObj(raw)) return out;
	for (const [version, v] of Object.entries(raw)) {
		if (!VERSION_RE.test(version) || !isObj(v)) continue;
		const { providers, pairs } = v;
		if (
			!Array.isArray(providers) ||
			providers.length > 100 ||
			!providers.every((p) => typeof p === "string" && PROVIDER_ID.test(p))
		)
			continue;
		if (
			!Array.isArray(pairs) ||
			pairs.length > OMP_WATCH_GATES.modelsMaxEntries ||
			!pairs.every((p) => typeof p === "string" && PAIR_RE.test(p))
		)
			continue;
		out[version] = { providers: [...providers], pairs: [...pairs] };
	}
	return out;
}

/** The parsed model set of one run, or why the run is unusable. */
export type ModelSetParse = { pairs: string[] } | { error: string };
/**
 * The model set of one `omp models --json` run (OTTR-1287). The output is untrusted data:
 * one entry without a valid provider or model id rejects the whole run, and so does a run
 * with more than `maxEntries` entries or `OMP_WATCH_GATES.modelsMaxChars` characters. The
 * set is the sorted unique `provider/model` ids.
 */
export function parseModelSet(
	stdout: string,
	maxEntries: number,
): ModelSetParse {
	if (stdout.length > OMP_WATCH_GATES.modelsMaxChars)
		return { error: `output is ${stdout.length} characters, over the cap` };
	let body: unknown;
	try {
		body = JSON.parse(stdout);
	} catch {
		return { error: "output is not JSON" };
	}
	if (!isObj(body) || !Array.isArray(body.models))
		return { error: "no models array" };
	if (body.models.length > maxEntries)
		return {
			error: `${body.models.length} models exceeds the cap of ${maxEntries}`,
		};
	const seen = new Set<string>();
	for (const [i, m] of body.models.entries()) {
		if (!isObj(m)) return { error: `models[${i}] is not an object` };
		const { provider, id } = m;
		if (typeof provider !== "string" || !PROVIDER_ID.test(provider))
			return { error: `models[${i}] has no valid provider` };
		if (typeof id !== "string" || !MODEL_ID_RE.test(id))
			return { error: `models[${i}] has no valid model id` };
		seen.add(`${provider}/${id}`);
	}
	return { pairs: [...seen].sort() };
}

/**
 * Stored state from the global store. npm and model data passed through it once, so every
 * field is checked: a malformed value loads as the empty state and a malformed verdict entry
 * is dropped (its version is reviewed again). A fail without a card is malformed too: no card
 * could ever clear it.
 */
export function parseOmpWatchState(raw: unknown): OmpWatchState {
	const out = emptyState();
	if (!isObj(raw)) return out;
	out.verdicts = parseVerdicts(raw.verdicts);
	out.modelSets = parseModelSets(raw.modelSets);
	out.bumpCard = parseBumpCard(raw.bumpCard);
	out.lastError = parseLastError(raw.lastError);
	return out;
}

/** omp lists only the models its current credentials make available, so a snapshot taken
 * under a different sign-in set says nothing about now: drop it. The backfill re-reads it
 * under the current context (OTTR-1287). */
function dropStaleSnapshots(
	state: OmpWatchState,
	providers: readonly string[],
): void {
	for (const [version, set] of Object.entries(state.modelSets)) {
		if (
			set.providers.length !== providers.length ||
			set.providers.some((p, i) => p !== providers[i])
		)
			delete state.modelSets[version];
	}
}

/** Drops model sets below the pin: the comparison baseline moves with the pin. */
function pruneModelSets(state: OmpWatchState, pin: string): void {
	for (const version of Object.keys(state.modelSets))
		if (compareVersions(version, pin) < 0) delete state.modelSets[version];
}

/** The filed bump card blocks its own version again; only a higher cleared target re-files. */
function bumpCardBlocks(
	state: OmpWatchState,
	target: string,
	cleared: ReadonlySet<string>,
): boolean {
	const card = state.bumpCard;
	if (card === null) return false;
	return !cleared.has(card.id) || compareVersions(target, card.version) <= 0;
}

/** The verdict records for every release through the target. */
function coveredVersions(
	releases: readonly OmpRelease[],
	target: string,
	verdicts: Record<string, OmpVerdict>,
): { version: string; verdict: "pass" | "fail"; cardId: string | null }[] {
	return releases.flatMap((r) => {
		if (compareVersions(r.version, target) > 0) return [];
		const v = verdicts[r.version];
		if (v === undefined) return [];
		return [{ version: r.version, verdict: v.verdict, cardId: v.cardId }];
	});
}

/** The card ids whose task is gone or done: their holds and pointers lifted. */
async function clearedCardIds(
	store: ForkProject["store"],
	state: OmpWatchState,
): Promise<Set<string>> {
	const cleared = new Set<string>();
	const ids = new Set(
		Object.values(state.verdicts).flatMap((v) =>
			v.cardId === null ? [] : [v.cardId],
		),
	);
	if (state.bumpCard !== null) ids.add(state.bumpCard.id);
	for (const id of ids) {
		const task = await store.getTask(id);
		if (task === null || task.stage === "done") cleared.add(id);
	}
	return cleared;
}

/**
 * The review reply: the first non-empty line is exactly PASS or FAIL. FAIL takes the next
 * non-empty lines as reasons, bullet markers stripped. Any other reply is null: never a pass
 * by default.
 */
export function parseVerdict(
	reply: string,
): { verdict: "pass" | "fail"; reasons: string[] } | null {
	const lines = reply
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "");
	const head = lines[0];
	if (head === "PASS") return { verdict: "pass", reasons: [] };
	if (head !== "FAIL") return null;
	const reasons = lines
		.slice(1)
		.map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s*/, "").trim())
		.filter((l) => l !== "")
		.slice(0, MAX_REASONS)
		.map((l) => l.slice(0, REASON_MAX));
	return {
		verdict: "fail",
		reasons: reasons.length > 0 ? reasons : ["the model gave no reason"],
	};
}

/** `owner/repo` of a GitHub repository field (string or `{ url }`), or null. */
export function parseRepo(repository: unknown): string | null {
	const url = isObj(repository) ? repository.url : repository;
	if (typeof url !== "string") return null;
	const m =
		/github\.com[/:]([^/\s]+\/[^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/.exec(url) ??
		/^github:([^/\s]+\/[^/\s#?]+)$/.exec(url);
	const repo = m?.[1] ?? null;
	return repo !== null && REPO_RE.test(repo) ? repo : null;
}

export type OmpRelease = {
	version: string;
	publishedAt: number;
	deprecated?: boolean;
};

/**
 * The npm packument's x.y.z versions newer than the pin, ascending, with their publish times
 * (a time entry without a versions entry is a removed version and drops out), the packument's
 * deprecated flag on each release, and the GitHub repo that holds the release notes (null
 * when the packument names none).
 */
export function parsePackument(
	body: unknown,
	pin: string,
): { releases: OmpRelease[]; repo: string | null } {
	if (!isObj(body) || !isObj(body.time))
		throw new Error("npm packument has no time map");
	const versions = isObj(body.versions) ? body.versions : {};
	const releases: OmpRelease[] = [];
	for (const [version, t] of Object.entries(body.time)) {
		if (!VERSION_RE.test(version) || typeof t !== "string") continue;
		const publishedAt = Date.parse(t);
		if (!Number.isFinite(publishedAt)) continue;
		if (compareVersions(version, pin) <= 0) continue;
		if (!(version in versions)) continue;
		const v = versions[version];
		releases.push({
			version,
			publishedAt,
			deprecated: isObj(v) && typeof v.deprecated === "string",
		});
	}
	releases.sort((a, b) => compareVersions(a.version, b.version));
	return { releases, repo: parseRepo(body.repository) };
}

/**
 * The highest version the pin may move to (spec "Bump target"): walk the releases above the
 * pin in ascending order, stop at the first one without a verdict or with a fail whose card
 * is not cleared. The target is the highest walked release that is counted (not deprecated)
 * and either fast-tracks (`addsSignedInModels`, a passed release that adds model access,
 * OTTR-1287) or is aged and accepted by the release line gate
 * (docs/specs/release-line-gate.md); acceptance is evaluated per release against the full
 * release list, so nothing above the walk — settled or cap-lifted — can bless a walked
 * release below it.
 */
export function bumpTarget(
	releases: OmpRelease[],
	verdicts: Record<string, OmpVerdict>,
	cleared: (cardId: string) => boolean,
	now: number,
	addsSignedInModels?: (version: string) => boolean,
): string | null {
	const ageMs = OMP_WATCH_GATES.ageDays * DAY_MS;
	const capMs = OMP_WATCH_GATES.capDays * DAY_MS;
	// A counted release is a candidate when it fast-tracks (a passed release that adds
	// model access) or passes the age and settled-line rules; deprecated never counts.
	const isCandidate = (r: OmpRelease, v: OmpVerdict): boolean => {
		if (r.deprecated === true) return false;
		if (v.verdict === "pass" && (addsSignedInModels?.(r.version) ?? false))
			return true;
		return (
			now - r.publishedAt >= ageMs &&
			releaseLineAccepts(releases, r.version, now, ageMs, capMs)
		);
	};
	let target: string | null = null;
	for (const r of releases) {
		const v = verdicts[r.version];
		if (v === undefined) break;
		if (v.verdict === "fail" && (v.cardId === null || !cleared(v.cardId)))
			break;
		if (!isCandidate(r, v)) continue;
		if (target === null || compareVersions(r.version, target) > 0)
			target = r.version;
	}
	return target;
}

/**
 * The user message of one review: the version and its release notes, cleaned (invisible
 * characters, secrets, DATA fence markers) and cut, as one DATA block. Throws when
 * redaction pauses.
 */
export function reviewMessage(o: {
	version: string;
	pin: string;
	notes: string;
}): string {
	const notes = clean(o.notes || "(empty)").slice(0, OMP_WATCH_GATES.notesCap);
	return `omp ${o.version} (Ottr pins ${o.pin}). Release notes:\n<<<DATA\n${notes}\nDATA>>>`;
}

/** The fail card prompt, with the notes cut so the whole prompt fits the board's limit. */
export function failCardPrompt(o: {
	version: string;
	pin: string;
	reasons: string[];
	notes: string;
}): string {
	const reasons = o.reasons.map((r) => clean(r).slice(0, REASON_MAX));
	const notes = clean(o.notes || "(none)").slice(0, OMP_WATCH_GATES.notesCap);
	const room =
		PROMPT_LIMIT - ompFailCardPrompt({ ...o, reasons, notes: "" }).length;
	const cut =
		notes.length > room
			? `${notes.slice(0, Math.max(0, room - TRUNCATED.length))}${TRUNCATED}`
			: notes;
	return ompFailCardPrompt({ ...o, reasons, notes: cut });
}

type Notes = { kind: "notes"; body: string } | { kind: "missing" };

/** omp's upstream releases live on public github.com, whatever host the board uses. */
export const UPSTREAM_API_BASE = "https://api.github.com";

export function createOmpWatcher(deps: {
	projects: () => Iterable<ForkProject>;
	load: (project: string) => Promise<unknown>;
	save: (project: string, state: OmpWatchState) => Promise<void>;
	log: (m: string) => void;
	schedule: () => void;
	fetch?: typeof fetch;
	spawn?: SpawnFn;
	now?: () => number;
	token?: () => string | undefined;
	/** Hosted credit hold: true pauses the release review's model call until the top-up. */
	creditHoldActive?: () => boolean;
	/** Test seam only; production uses UPSTREAM_API_BASE. */
	apiBase?: () => string;
	/** OTTR-1212: the retry.fallbackChains map keyed by role; tests pass {} to pin. */
	fallbacks?: Record<string, string[]>;
	/**
	 * The providers the board has an active sign-in for (production: `signIns()` in
	 * src/login.ts, active rows only). An unreadable credential store yields no providers:
	 * a version then never fast-tracks, and the age gate keeps its normal path.
	 */
	signIns?: () => string[];
}): { tick(): Promise<void> } {
	const doFetch = withGithubRetry(deps.fetch ?? fetch);
	const doSpawn = deps.spawn ?? defaultSpawn;
	const now = deps.now ?? Date.now;

	async function getJson(
		url: string,
		headers: Record<string, string>,
	): Promise<{ status: number; body: unknown }> {
		const res = await doFetch(url, {
			headers: { "user-agent": "ottr", ...headers },
			redirect: "manual",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return { status: res.status, body: null };
		return { status: res.status, body: await res.json() };
	}

	async function packument(): Promise<unknown> {
		const r = await getJson(OMP_PACKAGE_URL, { accept: "application/json" });
		if (r.body === null) throw new Error(`npm returned HTTP ${r.status}`);
		return r.body;
	}

	/** The GitHub release notes of `v<version>`; missing on 404, throws on other failures. */
	async function releaseNotes(repo: string, version: string): Promise<Notes> {
		const base = (deps.apiBase?.() ?? UPSTREAM_API_BASE).replace(/\/+$/, "");
		const headers: Record<string, string> = {
			accept: "application/vnd.github+json",
		};
		const token = (deps.token ?? upstreamToken)();
		if (token) headers.authorization = `Bearer ${token}`;
		const r = await getJson(
			`${base}/repos/${repo}/releases/tags/v${version}`,
			headers,
		);
		if (r.status === 404) return { kind: "missing" };
		if (r.body === null)
			throw new Error(`GitHub release v${version} returned HTTP ${r.status}`);
		const body = isObj(r.body) ? r.body.body : undefined;
		return { kind: "notes", body: typeof body === "string" ? body : "" };
	}

	/**
	 * One version's model set (OTTR-1287): `omp models --json` from an isolated install of
	 * that exact version. The reviewed version is unapproved code, so it runs in its own
	 * sandbox, not the review's env: a throwaway HOME doubles as the working directory, and
	 * the env is a whitelist that carries no identity, credential or board configuration
	 * (no agent.db, no OAuth state, no SSH agent, no GitHub token). Only the immutable
	 * package cache is shared across runs. Null (warned through `warn`) when the run fails
	 * or the output is unusable: the version keeps the age gate. A failed run is a warning,
	 * never a `lastError`: it cannot block or retry the review.
	 */
	async function modelSet(
		version: string,
		warn: (reason: string) => void,
	): Promise<string[] | null> {
		let res: { code: number; stdout: string; stderr: string };
		const home = mkdtempSync(join(tmpdir(), "ottr-omp-probe-"));
		mkdirSync(modelsCacheDir(), { recursive: true });
		try {
			res = await doSpawn(
				["bunx", `@oh-my-pi/pi-coding-agent@${version}`, "models", "--json"],
				{
					stdin: "",
					cwd: home,
					env: probeEnv(home),
					timeoutMs: OMP_WATCH_GATES.modelsTimeoutMs,
				},
			);
		} catch (e) {
			warn(`omp ${version}: models list not run: ${errText(e)}`);
			return null;
		} finally {
			// The probe's own scratch: its agent dir, its downloads. Nothing live lives here.
			rmSync(home, { recursive: true, force: true, maxRetries: 5 });
		}
		if (res.code !== 0) {
			warn(
				`omp ${version}: models list exited with code ${res.code}: ${res.stderr.slice(-200)}`,
			);
			return null;
		}
		const parsed = parseModelSet(res.stdout, OMP_WATCH_GATES.modelsMaxEntries);
		if ("error" in parsed) {
			warn(`omp ${version}: models list: ${parsed.error}`);
			return null;
		}
		return parsed.pairs;
	}

	/** The sorted active sign-in providers right now: the snapshot's credential context. */
	const signedInProviders = (): string[] =>
		[...new Set(deps.signIns?.() ?? [])].sort();

	/** Runs and records the version's model set when the state has none (OTTR-1287). */
	async function recordModelSet(
		state: OmpWatchState,
		version: string,
		warn: (reason: string) => void,
	): Promise<void> {
		if (state.modelSets[version] !== undefined) return;
		const pairs = await modelSet(version, warn);
		if (pairs !== null)
			state.modelSets[version] = { providers: signedInProviders(), pairs };
	}

	async function watchProject(project: ForkProject): Promise<void> {
		const store = project.store;
		const watching = async () => (await store.getSettings()).ompWatch === true;
		const tag = project.name;
		let pin: string | null = null;
		try {
			pin = parsePin(
				readFileSync(join(project.path, "Dockerfile.worker"), "utf8"),
			);
		} catch {
			// No Dockerfile.worker: logged below like a file without a pin.
		}
		if (pin === null) {
			deps.log(`${tag}: no ARG OMP_VERSION=x.y.z line in Dockerfile.worker`);
			return;
		}
		const state = parseOmpWatchState(await deps.load(project.name));
		// The tick's last failure becomes lastError; a tick without one clears it.
		const failures: string[] = [];
		const fail = (reason: string) => {
			failures.push(reason);
			deps.log(`${tag}: ${reason}`);
		};

		let pack: { releases: OmpRelease[]; repo: string | null };
		try {
			pack = parsePackument(await packument(), pin);
		} catch (e) {
			const reason = `npm: ${errText(e)}`;
			fail(reason);
			state.lastError = { reason, at: now() };
			await deps.save(project.name, state);
			return;
		}
		const { releases, repo } = pack;

		const unreviewed = releases.filter(
			(r) => state.verdicts[r.version] === undefined,
		);
		if (unreviewed.length > 0 && repo === null)
			fail("npm: the packument names no GitHub repository");
		let filed = 0;
		filed += await reviewReleases(
			project,
			state,
			unreviewed,
			repo,
			pin,
			fail,
			watching,
		);
		filed += await fileBumpCard(project, state, releases, pin, fail, watching);

		// Model sets below the pin are never compared again: the baseline moves with the pin.
		pruneModelSets(state, pin);

		const reason = failures.at(-1);
		state.lastError = reason === undefined ? null : { reason, at: now() };
		await deps.save(project.name, state);
		if (filed > 0) deps.schedule();
	}

	/** Reviews the unreviewed releases; returns how many fail cards it filed. */
	async function reviewReleases(
		project: ForkProject,
		state: OmpWatchState,
		unreviewed: OmpRelease[],
		repo: string | null,
		pin: string,
		fail: (reason: string) => void,
		watching: () => Promise<boolean>,
	): Promise<number> {
		const store = project.store;
		const tag = project.name;
		let filed = 0;
		for (const r of unreviewed.slice(0, OMP_WATCH_GATES.reviewsPerTick)) {
			if (repo === null || !(await watching())) break;
			const v = await review(r, repo, pin, fail, tag);
			if (v === null) continue;
			if (!(await watching())) {
				deps.log(`${tag}: watch turned off during the review of ${r.version}`);
				break;
			}
			const t = now();
			if (v.verdict === "pass") {
				state.verdicts[r.version] = {
					verdict: "pass",
					reasons: [],
					cardId: null,
					at: t,
				};
				deps.log(`${tag}: omp ${r.version} passed the review`);
				// The model set feeds the fast track; a failed run only loses it (OTTR-1287).
				await recordModelSet(state, r.version, (m) => deps.log(`${tag}: ${m}`));
				continue;
			}
			filed += await fileFailCard(store, state, r, pin, v, t, tag, fail);
		}
		return filed;
	}

	/** Files one review-fail card, records the verdict, and returns 1 on success. */
	async function fileFailCard(
		store: ForkProject["store"],
		state: OmpWatchState,
		r: OmpRelease,
		pin: string,
		v: { verdict: "pass" | "fail"; reasons: string[]; notes: string },
		t: number,
		tag: string,
		fail: (reason: string) => void,
	): Promise<number> {
		try {
			const prompt = failCardPrompt({
				version: r.version,
				pin,
				reasons: v.reasons,
				notes: v.notes,
			});
			const card = await store.transaction(async () => {
				if ((await store.getSettings()).ompWatch !== true) return null;
				const created = await store.createTask(prompt, null, "work");
				await store.updateTask(created.id, {
					title: `omp ${r.version}: compatibility review failed`,
					promptAuthor: "board",
					topic: "omp",
				});
				return created;
			});
			if (card === null) return 0;
			state.verdicts[r.version] = {
				verdict: "fail",
				reasons: v.reasons,
				cardId: card.id,
				at: t,
			};
			deps.log(`${tag}: omp ${r.version} failed the review; card ${card.id}`);
			return 1;
		} catch (e) {
			fail(`omp ${r.version}: fail card not filed: ${errText(e)}`);
			return 0;
		}
	}

	/** Files the bump card for a newer cleared target; returns 1 when it filed one. */
	async function fileBumpCard(
		project: ForkProject,
		state: OmpWatchState,
		releases: OmpRelease[],
		pin: string,
		fail: (reason: string) => void,
		watching: () => Promise<boolean>,
	): Promise<number> {
		const store = project.store;
		let attemptedTarget: string | null = null;
		// omp lists only the models its current credentials make available, so a snapshot
		// taken under a different sign-in set says nothing about now: drop it and re-read
		// under the current context (OTTR-1287; otherwise a sign-in added after the pin's
		// snapshot would fast-track an identical catalog as new models).
		const providers = signedInProviders();
		dropStaleSnapshots(state, providers);
		const signedIn = new Set(providers);
		// The fast track compares against the live baseline (the pin's set) and only counts
		// providers with an active sign-in (OTTR-1287). Both snapshots carry the same
		// context here: the sweep above dropped every set that does not.
		const addedModels = (version: string): string[] => {
			const live = state.modelSets[pin];
			const set = state.modelSets[version];
			if (live === undefined || set === undefined) return [];
			return set.pairs.filter(
				(p) =>
					!live.pairs.includes(p) && signedIn.has(p.slice(0, p.indexOf("/"))),
			);
		};
		// Reviews record the sets; this backfill covers a review that predates the feature
		// or a first run that failed. At most modelsPerTick runs per tick.
		const need = releases.flatMap((r) =>
			state.verdicts[r.version]?.verdict === "pass" &&
			state.modelSets[r.version] === undefined
				? [r.version]
				: [],
		);
		if (state.modelSets[pin] === undefined) need.unshift(pin);
		for (const version of need.slice(0, OMP_WATCH_GATES.modelsPerTick)) {
			if (!(await watching())) return 0;
			await recordModelSet(state, version, (m) =>
				deps.log(`${project.name}: ${m}`),
			);
		}
		try {
			const result = await store.transaction(async () => {
				if (!(await watching())) return null;
				const cleared = await clearedCardIds(store, state);
				const target = bumpTarget(
					releases,
					state.verdicts,
					(id) => cleared.has(id),
					now(),
					(version) => addedModels(version).length > 0,
				);
				if (target === null || bumpCardBlocks(state, target, cleared))
					return null;
				attemptedTarget = target;
				const added = addedModels(target);
				const card = await store.createTask(
					ompBumpCardPrompt({
						version: target,
						pin,
						covers: coveredVersions(releases, target, state.verdicts),
						addedModels: added,
					}),
					null,
					"work",
				);
				await store.updateTask(card.id, {
					title: `Bump omp to ${target}`,
					promptAuthor: "board",
					topic: "omp",
					// The fast-tracked card queues first; the normal card stays unrated.
					priority: added.length > 0 ? "P1" : null,
				});
				return { card, target };
			});
			if (result === null) return 0;
			const { card, target } = result;
			state.bumpCard = { id: card.id, version: target };
			deps.log(`${project.name}: filed bump card ${card.id} for omp ${target}`);
			return 1;
		} catch (e) {
			fail(`bump card for ${attemptedTarget} not filed: ${errText(e)}`);
			return 0;
		}
	}

	/**
	 * One release's review: null (logged through `fail`) when it must be retried on a later
	 * tick; a fail without a model call when the notes are missing past the grace period.
	 */
	async function review(
		r: OmpRelease,
		repo: string,
		pin: string,
		fail: (reason: string) => void,
		tag: string,
	): Promise<{
		verdict: "pass" | "fail";
		reasons: string[];
		notes: string;
	} | null> {
		let notes: Notes;
		try {
			notes = await releaseNotes(repo, r.version);
		} catch (e) {
			fail(`GitHub: omp ${r.version}: ${errText(e)}`);
			return null;
		}
		if (notes.kind === "missing") {
			if (now() - r.publishedAt < OMP_WATCH_GATES.notesGraceMs) return null;
			return {
				verdict: "fail",
				reasons: [`omp published no release notes for ${r.version}`],
				notes: "",
			};
		}
		// OTTR-942: reviewMessage never throws; credential-shaped notes redact.
		const message = reviewMessage({
			version: r.version,
			pin,
			notes: notes.body,
		});
		// Hosted credit hold (docs/specs/hosted-mode.md section 5): the compatibility
		// review's model call waits for the top-up; the next hourly tick retries it.
		if (deps.creditHoldActive?.() === true) {
			deps.log(
				`${tag}: omp ${r.version}: review paused: the board is out of credit`,
			);
			return null;
		}
		let reply: string;
		try {
			reply = await runGatewayWithFallbacks(
				[
					{ role: "system", content: OMP_REVIEW_INSTRUCTIONS },
					{ role: "user", content: message },
				],
				"@default",
				(deps.fallbacks ?? modelFallbacks()).default ?? [],
				deps.spawn,
				MODEL_TIMEOUT_MS,
			);
		} catch (e) {
			fail(`model: omp ${r.version}: ${errText(e)}`);
			return null;
		}
		const v = parseVerdict(reply);
		if (v === null) {
			fail(
				`model: omp ${r.version}: reply is not PASS or FAIL: ${JSON.stringify(reply.slice(0, 200))}`,
			);
			return null;
		}
		return { ...v, notes: notes.body };
	}

	async function scan(): Promise<void> {
		// Fresh iteration per tick: a one-shot iterator would be empty after the first tick.
		for (const project of deps.projects()) {
			if ((await project.store.getSettings()).ompWatch !== true) continue;
			try {
				await watchProject(project);
			} catch (e) {
				deps.log(`${project.name}: ${errText(e)}`);
			}
		}
	}

	return { tick: singleFlightTick(scan) };
}

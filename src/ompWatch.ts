/**
 * The omp watch (docs/specs/omp-watch.md): an hourly tick reads the omp pin in a project's
 * Dockerfile.worker, lists the newer omp releases on npm, has a model review each release's
 * notes, files a fail card that holds the pin, and files a "Bump omp to X" card when a
 * reviewed release is old enough.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clean, runGateway, type SpawnFn } from "./forkAnalysis.ts";
import type { ForkProject } from "./forks.ts";
import { upstreamToken } from "./githubHost.ts";
import { withGithubRetry } from "./githubRetry.ts";
import {
	OMP_REVIEW_INSTRUCTIONS,
	ompBumpCardPrompt,
	ompFailCardPrompt,
} from "./prompts.ts";
import { compareVersions, settledLineTarget } from "./releaseLine.ts";
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

export type OmpVerdict = {
	verdict: "pass" | "fail";
	reasons: string[];
	cardId: string | null;
	at: number;
};

export type OmpWatchState = {
	verdicts: Record<string, OmpVerdict>;
	bumpCard: { id: string; version: string } | null;
	lastError: { reason: string; at: number } | null;
};

const emptyState = (): OmpWatchState => ({
	verdicts: {},
	bumpCard: null,
	lastError: null,
});

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const errText = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

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
	out.bumpCard = parseBumpCard(raw.bumpCard);
	out.lastError = parseLastError(raw.lastError);
	return out;
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
 * is not cleared; the release line gate (docs/specs/release-line-gate.md) then picks from
 * the full release list with maxVersion at the highest walked version, so a settled pick
 * above the walk cannot bless a walked release from an unsettled line (settle state is
 * registry state, so an unreviewed young release still blocks its line). The target is the
 * highest walked release that is aged, not deprecated, and at or below the pick.
 */
export function bumpTarget(
	releases: OmpRelease[],
	verdicts: Record<string, OmpVerdict>,
	cleared: (cardId: string) => boolean,
	now: number,
): string | null {
	const walked: OmpRelease[] = [];
	for (const r of releases) {
		const v = verdicts[r.version];
		if (v === undefined) break;
		if (v.verdict === "fail" && (v.cardId === null || !cleared(v.cardId)))
			break;
		walked.push(r);
	}
	// The pick reads the full list, but maxVersion keeps it at or below the walk: a
	// settled pick above the walk must not bless a walked release from an unsettled line.
	const maxVersion = walked.at(-1)?.version;
	const pick = settledLineTarget(
		releases,
		now,
		OMP_WATCH_GATES.ageDays * DAY_MS,
		OMP_WATCH_GATES.capDays * DAY_MS,
		maxVersion,
	);
	if (pick === null) return null;
	let target: string | null = null;
	for (const r of walked) {
		// A deprecated release never counts, so it is never the target (check 16).
		if (r.deprecated === true) continue;
		if (now - r.publishedAt < OMP_WATCH_GATES.ageDays * DAY_MS) continue;
		if (compareVersions(r.version, pick) > 0) continue;
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
	const reasons = o.reasons.map((r) => safeText(r, REASON_MAX));
	const notes = safeText(o.notes || "(none)", OMP_WATCH_GATES.notesCap);
	const room =
		PROMPT_LIMIT - ompFailCardPrompt({ ...o, reasons, notes: "" }).length;
	const cut =
		notes.length > room
			? `${notes.slice(0, Math.max(0, room - TRUNCATED.length))}${TRUNCATED}`
			: notes;
	return ompFailCardPrompt({ ...o, reasons, notes: cut });
}

/** Untrusted text through clean(); a redaction pause withholds the text instead of failing. */
function safeText(raw: string, max: number): string {
	try {
		return clean(raw).slice(0, max);
	} catch (e) {
		return `(withheld: ${errText(e)})`;
	}
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
	/** Test seam only; production uses UPSTREAM_API_BASE. */
	apiBase?: () => string;
}): { tick(): Promise<void> } {
	const doFetch = withGithubRetry(deps.fetch ?? fetch);
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
			const v = await review(r, repo, pin, fail);
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
		try {
			const result = await store.transaction(async () => {
				if (!(await watching())) return null;
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
				const target = bumpTarget(
					releases,
					state.verdicts,
					(id) => cleared.has(id),
					now(),
				);
				if (
					target === null ||
					(state.bumpCard !== null &&
						(!cleared.has(state.bumpCard.id) ||
							compareVersions(target, state.bumpCard.version) <= 0))
				)
					return null;
				attemptedTarget = target;
				// Every release through the target has a verdict.
				const covers = releases.flatMap((r) => {
					if (compareVersions(r.version, target) > 0) return [];
					const v = state.verdicts[r.version];
					if (v === undefined) return [];
					return [{ version: r.version, verdict: v.verdict, cardId: v.cardId }];
				});
				const card = await store.createTask(
					ompBumpCardPrompt({ version: target, pin, covers }),
					null,
					"work",
				);
				await store.updateTask(card.id, {
					title: `Bump omp to ${target}`,
					promptAuthor: "board",
					topic: "omp",
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
		let message: string;
		try {
			message = reviewMessage({ version: r.version, pin, notes: notes.body });
		} catch (e) {
			// Redaction paused: the notes cannot go to the model, so a human must read them.
			return {
				verdict: "fail",
				reasons: [
					`the release notes of ${r.version} were withheld from the review (${errText(e)}): read them on GitHub`,
				],
				notes: "",
			};
		}
		let reply: string;
		try {
			reply = await runGateway(
				[
					{ role: "system", content: OMP_REVIEW_INSTRUCTIONS },
					{ role: "user", content: message },
				],
				deps.spawn,
				MODEL_TIMEOUT_MS,
				"@default",
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

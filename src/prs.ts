import { stripInvisible } from "./forkAnalysis.ts";
import type { ForkProject, GhFn } from "./forks.ts";
import { ownerRepo, runGh } from "./release.ts";

// Hard gates for the PR review watcher.
export const PR_GATES = {
	QUIET_MS: 30 * 60 * 1000,
	PROJECT_DAILY_RUNS: 5,
	DAY_MS: 24 * 60 * 60 * 1000,
} as const;

export interface PullInfo {
	number: number;
	head: string;
	draft: boolean;
	title: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export function prUrl(repo: string, n: number): string {
	return `https://github.com/${repo}/pull/${n}`;
}

/** GitHub data is untrusted: malformed entries are skipped, never thrown on. */
export function parsePullPage(body: unknown): PullInfo[] {
	if (!Array.isArray(body)) return [];
	const out: PullInfo[] = [];
	for (const e of body) {
		if (typeof e !== "object" || e === null) continue;
		const x = e as Record<string, unknown>;
		const head = x.head as Record<string, unknown> | null | undefined;
		const sha =
			typeof head === "object" && head !== null ? head.sha : undefined;
		if (
			typeof x.number !== "number" ||
			!Number.isInteger(x.number) ||
			x.number <= 0 ||
			typeof sha !== "string" ||
			!SHA_RE.test(sha) ||
			typeof x.draft !== "boolean" ||
			x.state !== "open"
		)
			continue;
		const title =
			typeof x.title === "string"
				? stripInvisible(x.title).text.trim().slice(0, 120)
				: "";
		out.push({ number: x.number, head: sha, draft: x.draft, title });
	}
	return out;
}

async function listPulls(repo: string, gh: GhFn): Promise<PullInfo[]> {
	const pulls: PullInfo[] = [];
	for (let page = 1; page <= 100; page++) {
		const r = await gh([
			"api",
			`repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
		]);
		if (r.code !== 0)
			throw new Error(`gh pulls failed (${r.code}): ${r.stderr.slice(0, 300)}`);
		const body: unknown = JSON.parse(r.stdout);
		if (!Array.isArray(body)) throw new Error("gh pulls: not a list");
		pulls.push(...parsePullPage(body));
		if (body.length < 100) break;
	}
	return pulls;
}

// One watcher at a time: a second concurrent tick shares the running one.
let inFlight: Promise<void> | null = null;

export function createPrWatcher(deps: {
	projects: () => Iterable<ForkProject>;
	log: (m: string) => void;
	gh?: GhFn;
	now?: () => number;
}): { tick(opts?: { manual?: string }): Promise<void> } {
	const gh = deps.gh ?? runGh;
	const now = deps.now ?? Date.now;

	async function scanProject(project: ForkProject): Promise<void> {
		const store = project.store;
		const repo =
			ownerRepo(`https://github.com/${project.github}.git`) ?? project.github!;
		if (!REPO_RE.test(repo)) throw new Error(`invalid repo id: ${repo}`);
		let pulls: PullInfo[];
		try {
			pulls = await listPulls(repo, gh);
		} catch (e) {
			deps.log(`prs: ${project.name}: ${(e as Error).message}`);
			return;
		}
		const t = now();
		const seen = new Set<number>();
		for (const p of pulls) {
			seen.add(p.number);
			const row = store.getPrReview(p.number);
			if (!row) {
				store.savePrReview({
					number: p.number,
					taskId: null,
					head: p.head,
					firstSeenAt: t,
					reviewedHead: null,
					postedHead: null,
					state: "open",
					draft: p.draft,
					title: p.title,
					postError: null,
				});
				continue;
			}
			const moved = row.head !== p.head;
			store.savePrReview({
				...row,
				head: p.head,
				firstSeenAt: moved ? t : row.firstSeenAt,
				draft: p.draft,
				title: p.title,
				state: "open",
			});
		}
		for (const row of store.listPrReviews()) {
			if (row.state !== "open" || seen.has(row.number)) continue;
			const r = await gh(["api", `repos/${repo}/pulls/${row.number}`]);
			if (r.code !== 0) {
				deps.log(
					`prs: ${project.name}: #${row.number} failed (${r.code}): ${r.stderr.slice(0, 300)}`,
				);
				continue;
			}
			let merged = false;
			try {
				const b = JSON.parse(r.stdout) as { merged_at?: unknown } | null;
				merged = typeof b?.merged_at === "string";
			} catch {
				deps.log(`prs: ${project.name}: #${row.number}: bad JSON`);
				continue;
			}
			// Only the state: a Post may have written the row during the await.
			store.setPrState(row.number, merged ? "merged" : "closed");
		}
		for (const row of store.listPrReviews()) {
			if (
				row.state !== "open" ||
				row.draft ||
				store.prHeadReviewed(row.number, row.head) ||
				row.firstSeenAt > t - PR_GATES.QUIET_MS
			)
				continue;
			const card = row.taskId ? store.getTask(row.taskId) : null;
			if (card) {
				// A cancelled card is the user's "never review this PR".
				if (card.cancelledAt !== null) continue;
				if (["queued", "preparing", "running"].includes(card.state)) continue;
			}
			if (
				store.prReviewRunsSince(t - PR_GATES.DAY_MS) >=
				PR_GATES.PROJECT_DAILY_RUNS
			) {
				deps.log(
					`prs: ${project.name}: daily cap of ${PR_GATES.PROJECT_DAILY_RUNS} reviews reached`,
				);
				return;
			}
			store.startPrReview({
				number: row.number,
				head: row.head,
				title: row.title,
				prompt: `Review pull request #${row.number} of ${repo} at head ${row.head.slice(0, 7)}: ${row.title}\n${prUrl(repo, row.number)}`,
				at: t,
			});
		}
	}

	async function scan(opts?: { manual?: string }): Promise<void> {
		// Fresh iteration per tick: a one-shot iterator would be empty after the first tick.
		for (const project of deps.projects()) {
			if (opts?.manual !== undefined && project.name !== opts.manual) continue;
			if (
				project.store.getSettings().prReviews !== true ||
				project.github === null
			)
				continue;
			try {
				await scanProject(project);
			} catch (e) {
				deps.log(`prs: ${project.name}: ${(e as Error).message}`);
			}
		}
	}

	return {
		tick(opts?: { manual?: string }): Promise<void> {
			if (inFlight !== null) return inFlight;
			inFlight = (async () => {
				try {
					await scan(opts);
				} finally {
					inFlight = null;
				}
			})();
			return inFlight;
		},
	};
}

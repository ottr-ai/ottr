import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhFn } from "./forks.ts";
import { createPrWatcher, PR_GATES, parsePullPage } from "./prs.ts";
import { ProjectStore } from "./store.ts";

let root: string;
let seq = 0;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ottr-prs-"));
});

const sha = (c: string) => c.repeat(40);
const pr = (number: number, head: string, draft = false, title = "t") => ({
	number,
	head: { sha: head },
	draft,
	state: "open",
	title,
});

function setup(opts: { on?: boolean; github?: string | null } = {}) {
	const dir = join(root, `p${++seq}`);
	mkdirSync(dir, { recursive: true });
	const store = ProjectStore.init(dir);
	store.setSettings({ prReviews: opts.on ?? true });
	let open: unknown[] = [];
	const closed = new Map<number, unknown>();
	const calls: string[] = [];
	let fail = false;
	const logs: string[] = [];
	let t = 1_000_000_000;
	const gh: GhFn = async (args) => {
		calls.push(args[1] ?? "");
		if (fail) return { code: 1, stdout: "", stderr: "HTTP 401" };
		const m = (args[1] ?? "").match(/pulls\/(\d+)$/);
		if (m)
			return {
				code: 0,
				stdout: JSON.stringify(closed.get(Number(m[1])) ?? {}),
				stderr: "",
			};
		return { code: 0, stdout: JSON.stringify(open), stderr: "" };
	};
	const watcher = createPrWatcher({
		projects: () => [
			{
				name: "p",
				path: dir,
				store,
				github: opts.github === undefined ? "o/r" : opts.github,
			},
		],
		log: (m) => logs.push(m),
		gh,
		now: () => t,
	});
	return {
		store,
		watcher,
		calls,
		logs,
		closed,
		setOpen: (v: unknown[]) => {
			open = v;
		},
		setFail: (v: boolean) => {
			fail = v;
		},
		advance: (ms: number) => {
			t += ms;
		},
		cards: () => store.listTasks().filter((x) => x.kind === "pr_review"),
	};
}

describe("parsePullPage", () => {
	test("skips malformed entries and cleans the title", () => {
		const good = pr(1, sha("a"), false, `  \u200bhi${"x".repeat(200)}`);
		const out = parsePullPage([
			good,
			{ ...good, number: 0 },
			{ ...good, number: 1.5 },
			{ ...good, number: "2" },
			{ ...good, head: { sha: "abc" } },
			{ ...good, head: { sha: sha("A") } },
			{ ...good, head: null },
			{ ...good, draft: "no" },
			{ ...good, state: "closed" },
			null,
			"x",
			{ ...good, number: 9, title: 5 },
		]);
		expect(out.map((p) => p.number)).toEqual([1, 9]);
		expect(out[0]!.title.startsWith("hix")).toBe(true);
		expect(out[0]!.title.length).toBe(120);
		expect(out[1]!.title).toBe("");
		expect(parsePullPage({})).toEqual([]);
	});
});

describe("createPrWatcher", () => {
	test("toggle off or no github makes no gh call", async () => {
		const a = setup({ on: false });
		await a.watcher.tick();
		const b = setup({ github: null });
		await b.watcher.tick();
		expect(a.calls.length + b.calls.length).toBe(0);
	});

	test("a new PR waits for the quiet gate, then files exactly one card", async () => {
		const s = setup();
		s.setOpen([pr(7, sha("a"))]);
		await s.watcher.tick();
		expect(s.cards().length).toBe(0);
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		await s.watcher.tick();
		expect(s.cards().length).toBe(1);
		expect(s.cards()[0]!.state).toBe("queued");
		expect(s.store.getPrReview(7)!.reviewedHead).toBe(sha("a"));
		expect(s.store.getPrReviewByTask(s.cards()[0]!.id)!.number).toBe(7);
	});

	test("a draft files nothing until it is ready", async () => {
		const s = setup();
		s.setOpen([pr(3, sha("b"), true)]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(s.cards().length).toBe(0);
		s.setOpen([pr(3, sha("b"), false)]);
		await s.watcher.tick();
		expect(s.cards().length).toBe(1);
	});

	test("a new head requeues the same card after the quiet gate", async () => {
		const s = setup();
		s.setOpen([pr(4, sha("a"))]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		const id = s.cards()[0]!.id;
		s.store.updateTask(id, { stage: "done", state: "idle" });
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(s.store.getTask(id)!.state).toBe("idle");
		s.setOpen([pr(4, sha("c"))]);
		await s.watcher.tick();
		expect(s.store.getTask(id)!.state).toBe("idle");
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(s.cards().length).toBe(1);
		expect(s.store.getTask(id)!.state).toBe("queued");
		expect(s.store.getPrReview(4)!.reviewedHead).toBe(sha("c"));
		expect(s.store.prReviewRunsSince(0)).toBe(2);
	});

	test("a head reviewed before is never reviewed again (A, B, then A)", async () => {
		const s = setup();
		const review = async (head: string) => {
			s.setOpen([pr(9, head)]);
			await s.watcher.tick();
			s.advance(PR_GATES.QUIET_MS);
			await s.watcher.tick();
			const card = s.cards()[0];
			if (card) s.store.updateTask(card.id, { stage: "done", state: "idle" });
		};
		await review(sha("a"));
		await review(sha("b"));
		expect(s.store.prReviewRunsSince(0)).toBe(2);
		await review(sha("a"));
		expect(s.store.prReviewRunsSince(0)).toBe(2);
		expect(s.store.getPrReview(9)!.reviewedHead).toBe(sha("b"));
	});

	test("a cancelled card never gets a new turn", async () => {
		const s = setup();
		s.setOpen([pr(5, sha("a"))]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		const id = s.cards()[0]!.id;
		s.store.updateTask(id, { stage: "done", state: "idle", cancelledAt: 1 });
		s.setOpen([pr(5, sha("d"))]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(s.store.prReviewRunsSince(0)).toBe(1);
	});

	test("the daily cap holds the 6th start for 24h", async () => {
		const s = setup();
		const pulls = [1, 2, 3, 4, 5, 6].map((n) => pr(n, sha("e")));
		s.setOpen(pulls);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(s.cards().length).toBe(PR_GATES.PROJECT_DAILY_RUNS);
		expect(s.logs.some((m) => m.includes("daily cap"))).toBe(true);
		s.advance(PR_GATES.DAY_MS);
		await s.watcher.tick();
		expect(s.cards().length).toBe(5);
		// A run counts for a full 24 h (>= since), so the slot frees 1 ms later.
		s.advance(1);
		await s.watcher.tick();
		expect(s.cards().length).toBe(6);
	});

	test("a vanished PR becomes merged or closed and gets no turn", async () => {
		const s = setup();
		s.setOpen([pr(8, sha("a")), pr(9, sha("a"))]);
		await s.watcher.tick();
		s.closed.set(8, { merged_at: "2026-01-01T00:00:00Z" });
		s.closed.set(9, { merged_at: null });
		s.setOpen([]);
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(s.store.getPrReview(8)!.state).toBe("merged");
		expect(s.store.getPrReview(9)!.state).toBe("closed");
		expect(s.cards().length).toBe(0);
	});

	test("a vanished-PR state write keeps a post made during its gh call", async () => {
		const s = setup();
		s.setOpen([pr(12, sha("a"))]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		s.closed.set(12, { merged_at: null });
		s.setOpen([]);
		const watcher = createPrWatcher({
			projects: () => [
				{ name: "p", path: s.store.serverDir, store: s.store, github: "o/r" },
			],
			log: () => {},
			gh: async (args) => {
				if (/pulls\/12$/.test(args[1] ?? "")) {
					// The Post route claims the head while the watcher waits on GitHub.
					expect(s.store.claimPrPost(12, sha("a"))).toBeNull();
					return { code: 0, stdout: "{}", stderr: "" };
				}
				return { code: 0, stdout: "[]", stderr: "" };
			},
		});
		await watcher.tick();
		const row = s.store.getPrReview(12)!;
		expect(row.state).toBe("closed");
		expect(row.postedHead).toBe(sha("a"));
	});

	test("a gh failure logs and changes nothing", async () => {
		const s = setup();
		s.setOpen([pr(1, sha("a"))]);
		await s.watcher.tick();
		const before = s.store.listPrReviews();
		s.setFail(true);
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(s.store.listPrReviews()).toEqual(before);
		expect(s.cards().length).toBe(0);
		expect(s.logs.some((m) => m.includes("HTTP 401"))).toBe(true);
	});

	test("two ticks share one run", async () => {
		const s = setup();
		s.setOpen([pr(1, sha("a"))]);
		await Promise.all([s.watcher.tick(), s.watcher.tick()]);
		expect(s.calls.length).toBe(1);
	});

	test("paging stops on a short page", async () => {
		const s = setup();
		s.setOpen(Array.from({ length: 100 }, (_, i) => pr(i + 1, sha("a"))));
		const pages: string[] = [];
		const watcher = createPrWatcher({
			projects: () => [
				{ name: "p", path: s.store.serverDir, store: s.store, github: "o/r" },
			],
			log: () => {},
			gh: async (args) => {
				pages.push(args[1]!);
				const page = Number(args[1]!.match(/&page=(\d+)$/)![1]);
				const n = page === 1 ? 100 : 3;
				return {
					code: 0,
					stdout: JSON.stringify(
						Array.from({ length: n }, (_, i) => pr(page * 1000 + i, sha("a"))),
					),
					stderr: "",
				};
			},
		});
		await watcher.tick();
		expect(pages.length).toBe(2);
		expect(s.store.listPrReviews().length).toBe(103);
	});
});

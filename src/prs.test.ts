import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn } from "./forkAnalysis.ts";
import type { GhFn } from "./forks.ts";
import {
	createPrWatcher,
	PR_GATES,
	parseDraft,
	parsePullPage,
	reviewUserMessage,
} from "./prs.ts";
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

function setup(
	opts: { on?: boolean; github?: string | null; spawn?: SpawnFn } = {},
) {
	const dir = join(root, `p${++seq}`);
	mkdirSync(dir, { recursive: true });
	const store = ProjectStore.init(dir);
	store.setSettings({ prReviews: opts.on ?? true });
	let open: { number: number; head: { sha: string } }[] = [];
	const closed = new Map<number, unknown>();
	const calls: string[] = [];
	let fail = false;
	let reviewFail = false;
	/** A PR whose head moves between the list call and the review's read. */
	let movedTo: string | null = null;
	/** Diff overrides by PR number; others get a small default diff. */
	const diffs = new Map<number, string>();
	const logs: string[] = [];
	const prompts: string[] = [];
	let t = 1_000_000_000;
	const gh: GhFn = async (args) => {
		const path = args.at(-1) ?? "";
		calls.push(path);
		if (fail) return { code: 1, stdout: "", stderr: "HTTP 401" };
		const m = path.match(/pulls\/(\d+)$/);
		if (m && args.includes("-H"))
			return {
				code: 0,
				stdout: diffs.get(Number(m[1])) ?? `diff --git a/x b/x\n+pr ${m[1]}\n`,
				stderr: "",
			};
		if (m) {
			const n = Number(m[1]);
			const live = open.find((p) => p.number === n);
			const body = live
				? {
						...live,
						head: { sha: movedTo ?? live.head.sha },
						body: "Please merge.",
					}
				: (closed.get(n) ?? {});
			return { code: 0, stdout: JSON.stringify(body), stderr: "" };
		}
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
		spawn: opts.spawn,
		review: opts.spawn
			? undefined
			: async (messages) => {
					prompts.push(messages.map((x) => x.content).join("\n"));
					if (reviewFail) throw new Error("gateway down");
					return `  ## Summary\nreview ${prompts.length}\n`;
				},
	});
	return {
		store,
		watcher,
		calls,
		logs,
		prompts,
		closed,
		diffs,
		setOpen: (v: { number: number; head: { sha: string } }[]) => {
			open = v;
		},
		setFail: (v: boolean) => {
			fail = v;
		},
		setReviewFail: (v: boolean) => {
			reviewFail = v;
		},
		setMovedTo: (v: string | null) => {
			movedTo = v;
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

describe("review prompt and draft", () => {
	const msg = (diff: string) =>
		reviewUserMessage({ repo: "o/r", number: 1, title: "t", body: "", diff });
	test("an oversized diff throws; invisible characters never reach the model", () => {
		expect(() => msg("x".repeat(400_001))).toThrow(RangeError);
		expect(msg("a\u200Bb")).toContain("DIFF\n<<<DATA\nab\nDATA>>>");
	});
	test("parseDraft trims, caps, and rejects an empty answer", () => {
		expect(() => parseDraft(" \u200B\n")).toThrow();
		expect(parseDraft("  ok \n")).toBe("ok");
		expect(parseDraft("x".repeat(70_000)).length).toBeLessThanOrEqual(65_536);
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

	test("a new PR waits for the quiet gate, then files exactly one done card with the draft", async () => {
		const s = setup();
		s.setOpen([pr(7, sha("a"), false, "Add export")]);
		await s.watcher.tick();
		expect(s.cards().length).toBe(0);
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		await s.watcher.tick();
		expect(s.cards().length).toBe(1);
		const card = s.cards()[0]!;
		expect(card.stage).toBe("done");
		expect(card.state).toBe("idle");
		expect(card.details).toBe("## Summary\nreview 1");
		expect(s.store.getPrReview(7)!.reviewedHead).toBe(sha("a"));
		expect(s.store.getPrReviewByTask(card.id)!.number).toBe(7);
		// One model call; the PR fields reach it only as DATA blocks after the fixed system prompt.
		expect(s.prompts).toHaveLength(1);
		expect(s.prompts[0]).toContain("untrusted text");
		expect(s.prompts[0]).toContain("TITLE\n<<<DATA\nAdd export\nDATA>>>");
		expect(s.prompts[0]).toContain("Please merge.");
		expect(s.prompts[0]).toContain("+pr 7");
	});

	test("the default review asks the gateway for the plan role", async () => {
		const models: string[] = [];
		const s = setup({
			spawn: async (_argv, o) => {
				models.push(JSON.parse(o.stdin).body.model);
				return {
					code: 0,
					stdout: [
						JSON.stringify({ ready: true }),
						JSON.stringify({
							id: 1,
							status: 200,
							body: { choices: [{ message: { content: "## Summary" } }] },
						}),
					].join("\n"),
					stderr: "",
				};
			},
		});
		s.setOpen([pr(8, sha("c"))]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(models).toEqual(["@plan"]);
		expect(s.cards()[0]!.details).toBe("## Summary");
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

	test("a new head updates the same card after the quiet gate", async () => {
		const s = setup();
		s.setOpen([pr(4, sha("a"))]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		const id = s.cards()[0]!.id;
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(s.prompts).toHaveLength(1);
		s.setOpen([pr(4, sha("c"))]);
		await s.watcher.tick();
		expect(s.prompts).toHaveLength(1);
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		expect(s.cards().length).toBe(1);
		expect(s.store.getTask(id)!.details).toBe("## Summary\nreview 2");
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
		};
		await review(sha("a"));
		await review(sha("b"));
		expect(s.prompts).toHaveLength(2);
		await review(sha("a"));
		expect(s.prompts).toHaveLength(2);
		expect(s.store.getPrReview(9)!.reviewedHead).toBe(sha("b"));
	});

	test("a failed model call counts for the cap and retries on a later tick", async () => {
		const s = setup();
		s.setOpen([pr(6, sha("a"))]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		s.setReviewFail(true);
		await s.watcher.tick();
		expect(s.cards().length).toBe(0);
		expect(s.store.prReviewRunsSince(0)).toBe(1);
		expect(s.logs.some((m) => m.includes("gateway down"))).toBe(true);
		s.setReviewFail(false);
		await s.watcher.tick();
		expect(s.cards().length).toBe(1);
		expect(s.store.prReviewRunsSince(0)).toBe(2);
	});

	test("an over-budget or secret-flagged PR takes no cap slot and never blocks a newer PR", async () => {
		const s = setup();
		s.setOpen([pr(1, sha("a")), pr(2, sha("a")), pr(3, sha("a"))]);
		s.diffs.set(1, "x".repeat(400_001));
		s.diffs.set(2, '+cfg.password = "abcdefghijklmnop"');
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		for (let i = 0; i <= PR_GATES.PROJECT_DAILY_RUNS; i++)
			await s.watcher.tick();
		expect(s.store.prReviewRunsSince(0)).toBe(1);
		expect(s.cards().length).toBe(1);
		expect(s.store.prHeadReviewed(3, sha("a"))).toBe(true);
		expect(
			s.logs.some((m) => m.includes("#1 review skipped: diff exceeds")),
		).toBe(true);
		expect(s.logs.some((m) => m.includes("#2 review skipped: DIFF"))).toBe(
			true,
		);
	});

	test("a head that moves during the review saves no draft", async () => {
		const s = setup();
		s.setOpen([pr(2, sha("a"))]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		s.setMovedTo(sha("f"));
		await s.watcher.tick();
		expect(s.prompts).toHaveLength(0);
		expect(s.cards().length).toBe(0);
		expect(s.store.getPrReview(2)!.reviewedHead).toBeNull();
	});

	test("a cancelled card never gets a new review", async () => {
		const s = setup();
		s.setOpen([pr(5, sha("a"))]);
		await s.watcher.tick();
		s.advance(PR_GATES.QUIET_MS);
		await s.watcher.tick();
		const id = s.cards()[0]!.id;
		s.store.updateTask(id, { cancelledAt: 1 });
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

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BoardState,
	type Card,
	type Facts,
	report,
	resolveMergeHold,
	SCHEDULER_CANDIDATES,
	verdict,
} from "../.agents/skills/check-ottr-board/scripts/board-report.ts";

const F: Facts = {
	now: 1_760_000_000_000,
	logAgeS: 10,
	hold: null,
	leadHold: null,
	depsOpen: [],
	drain: false,
	capFull: false,
	cards: [],
};

const card = (x: Partial<Card>): Card => ({
	id: "T-1",
	project: "p",
	title: "T",
	stage: "in_progress",
	state: "running",
	needsReason: null,
	asked: null,
	dependsOn: [],
	holdUntil: null,
	cancelledAt: null,
	followUpOf: null,
	updatedAt: F.now - 60_000,
	...x,
});

describe("verdict", () => {
	test("needs_you with asked is a question", () => {
		const v = verdict(
			card({
				state: "needs_you",
				asked: [
					{
						question: "Which base?",
						options: [{ label: "a" }, { label: "b" }],
						multi: false,
						recommended: 0,
					},
				],
			}),
			F,
		);
		expect(v.verdict).toBe("question");
		expect(v.note).toBe("");
	});

	test("needs_you with an update-card approval reason is a decision", () => {
		expect(
			verdict(
				card({
					state: "needs_you",
					needsReason:
						"Update card: read the summary, then reply to approve the merge.",
				}),
				F,
			).verdict,
		).toBe("decision");
	});

	test("needs_you with a fork-research approval reason is a decision", () => {
		expect(
			verdict(
				card({
					state: "needs_you",
					needsReason:
						"Fork-research-born task: the merge is held. Reply to approve the head.",
				}),
				F,
			).verdict,
		).toBe("decision");
	});

	test("needs_you with a held proposal ending is a decision", () => {
		expect(
			verdict(
				card({
					state: "needs_you",
					needsReason:
						"Retro proposal from T-9. Accept to start it, edit the prompt first, or cancel to decline.",
				}),
				F,
			).verdict,
		).toBe("decision");
	});

	test("needs_you with the retro sign-off ending is a decision", () => {
		expect(
			verdict(
				card({
					state: "needs_you",
					needsReason:
						"Retro proposal from T-9. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
				}),
				F,
			).verdict,
		).toBe("decision");
	});

	test("needs_you with a resume-after reason waits by design", () => {
		const v = verdict(
			card({
				state: "needs_you",
				needsReason:
					"Please resume this card after 2026-11-18 21:44 UTC (release line opens).",
			}),
			F,
		);
		expect(v.verdict).toBe("waits");
		expect(v.note).toContain("resumes on the condition");
	});

	test("needs_you with a resume-when reason waits by design", () => {
		const v = verdict(
			card({
				state: "needs_you",
				needsReason:
					"Please resume this card when an upstream picomatch release fixes GHSA-fc5q-39xc-vjpf.",
			}),
			F,
		);
		expect(v.verdict).toBe("waits");
		expect(v.note).toContain("resumes on the condition");
	});

	test("needs_you with a re-run-after reason waits by design", () => {
		expect(
			verdict(
				card({
					state: "needs_you",
					needsReason:
						"Re-run this card's integration turn after 2026-11-18 21:44 UTC (when the branch turns 7 days old).",
				}),
				F,
			).verdict,
		).toBe("waits");
	});

	test("needs_you with an early stop gets the sign hint", () => {
		const v = verdict(
			card({
				state: "needs_you",
				needsReason: "The agent finished without calling report_outcome.",
			}),
			F,
		);
		expect(v.verdict).toBe("stuck");
		expect(v.note.startsWith("early stop")).toBe(true);
	});

	test("needs_you with an unknown sign says diagnose", () => {
		const v = verdict(
			card({ state: "needs_you", needsReason: "Something opaque happened." }),
			F,
		);
		expect(v.verdict).toBe("stuck");
		expect(v.note).toBe("unknown sign: diagnose");
	});

	test("a running card with a log idle past the limit is stuck", () => {
		const v = verdict(card({}), { ...F, logAgeS: 22 * 60 + 5 });
		expect(v.verdict).toBe("stuck");
		expect(v.note).toBe("log idle 22 min");
	});

	test("a running card with a young log is OK", () => {
		const v = verdict(card({}), { ...F, logAgeS: 60 });
		expect(v.verdict).toBe("OK");
		expect(v.note).toBe("log 60s old");
	});

	test("a running card with no log yet is OK", () => {
		const v = verdict(card({ state: "preparing" }), { ...F, logAgeS: null });
		expect(v.verdict).toBe("OK");
		expect(v.note).toBe("no log yet");
	});

	test("a queued card with no hold found needs a check", () => {
		const v = verdict(card({ state: "queued" }), F);
		expect(v.verdict).toBe("check");
		expect(v.note).toBe("queued with no hold found");
	});

	test("a queued pending sandbox lead holds on its review's validation run", () => {
		const holdText =
			"Waits for a validation run of review T-9; a work turn has no sandbox_run.";
		// A store-row card: leadValidationHold reads the prompt tag.
		const fromPrompt = verdict(
			card({
				state: "queued",
				prompt:
					"Needs validation: retry\nBlocker: sandbox run: no network deny",
				validatedAt: null,
				followUpOf: "T-9",
			}),
			{ ...F, leadHold: holdText },
		);
		expect(fromPrompt.verdict).toBe("OK");
		expect(fromPrompt.note).toContain("validation run of review T-9");
		// A wire card (GET /api/state): no prompt, the sandboxLead stamp instead.
		const fromStamp = verdict(
			card({
				state: "queued",
				sandboxLead: true,
				validatedAt: null,
				followUpOf: "T-9",
			}),
			{ ...F, leadHold: holdText },
		);
		expect(fromStamp.verdict).toBe("OK");
		expect(fromStamp.note).toContain("validation run of review T-9");
	});

	test("a queued card behind an open dependency holds on it", () => {
		const v = verdict(card({ state: "queued" }), {
			...F,
			depsOpen: ["T-2", "T-3"],
		});
		expect(v.verdict).toBe("OK");
		expect(v.note).toBe("waits for T-2,T-3");
	});

	test("a queued card with a future holdUntil holds until it", () => {
		const v = verdict(card({ state: "queued", holdUntil: F.now + 2000 }), F);
		expect(v.verdict).toBe("OK");
		expect(v.note).toContain(new Date(F.now + 2000).toISOString());
	});

	test("a queued card with a past holdUntil does not hold", () => {
		const v = verdict(card({ state: "queued", holdUntil: F.now - 2000 }), F);
		expect(v.verdict).toBe("check");
	});

	test("a queued card during a drain holds on the drain", () => {
		const v = verdict(card({ state: "queued" }), { ...F, drain: true });
		expect(v.verdict).toBe("OK");
		expect(v.note).toContain("drain");
	});

	test("a queued card at a full cap holds on the cap", () => {
		const v = verdict(card({ state: "queued" }), { ...F, capFull: true });
		expect(v.verdict).toBe("OK");
		expect(v.note).toContain("cap full");
	});

	test("a queued merge behind the findings hold is OK with the hold text", () => {
		const v = verdict(card({ stage: "merging", state: "queued" }), {
			...F,
			hold: "waiting for the review's findings to be implemented",
		});
		expect(v.verdict).toBe("OK");
		expect(v.note).toContain("waiting for the review's findings");
	});

	test("a queued merge behind a running merge of the same project holds on it", () => {
		const v = verdict(card({ stage: "merging", state: "queued" }), {
			...F,
			cards: [
				card({ stage: "merging", state: "queued" }),
				card({ id: "T-8", stage: "merging", state: "running" }),
			],
		});
		expect(v.verdict).toBe("OK");
		expect(v.note).toBe("a merge runs: T-8");
	});

	test("a queued merge behind a preparing merge of the same project holds on it", () => {
		const v = verdict(card({ stage: "merging", state: "queued" }), {
			...F,
			cards: [card({ id: "T-8", stage: "merging", state: "preparing" })],
		});
		expect(v.verdict).toBe("OK");
		expect(v.note).toBe("a merge runs: T-8");
	});

	test("a queued merge with the running merge in another project still needs a check", () => {
		const v = verdict(card({ stage: "merging", state: "queued" }), {
			...F,
			cards: [
				card({ stage: "merging", state: "queued" }),
				card({
					id: "T-8",
					stage: "merging",
					state: "running",
					project: "velvarr",
				}),
			],
		});
		expect(v.verdict).toBe("check");
		expect(v.note).toBe("queued with no hold found");
	});

	test("a cancelled merging card of the same project holds nothing", () => {
		const v = verdict(card({ stage: "merging", state: "queued" }), {
			...F,
			cards: [
				card({ stage: "merging", state: "queued" }),
				card({ id: "T-8", stage: "merging", state: "running", cancelledAt: 5 }),
			],
		});
		expect(v.verdict).toBe("check");
		expect(v.note).toBe("queued with no hold found");
	});

	test("merging idle waiting for the review's findings is OK", () => {
		const v = verdict(card({ stage: "merging", state: "idle" }), {
			...F,
			hold: "waiting for the review's findings to be implemented",
		});
		expect(v.verdict).toBe("OK");
		expect(v.note).toBe("release waits for its findings");
	});

	test("merging idle with the reason text and no hold is OK", () => {
		const v = verdict(
			card({
				stage: "merging",
				state: "idle",
				needsReason: "waiting for the review's findings to be implemented",
			}),
			F,
		);
		expect(v.verdict).toBe("OK");
		expect(v.note).toBe("release waits for its findings");
	});

	test("merging idle without the findings text is stuck", () => {
		expect(verdict(card({ stage: "merging", state: "idle" }), F).verdict).toBe(
			"stuck",
		);
	});

	test("backlog idle is OK", () => {
		const v = verdict(card({ stage: "backlog", state: "idle" }), F);
		expect(v.verdict).toBe("OK");
		expect(v.note).toBe("backlog");
	});

	test("any other state is stuck", () => {
		const v = verdict(card({ stage: "in_progress", state: "idle" }), F);
		expect(v.verdict).toBe("stuck");
		expect(v.note).toBe("state in_progress/idle");
	});
});

describe("resolveMergeHold", () => {
	test("missing candidates give null and the collected errors", async () => {
		const r = await resolveMergeHold([
			"/nonexistent/one.ts",
			"/nonexistent/two.ts",
		]);
		expect(r.mergeHold).toBeNull();
		expect(r.error).toContain("/nonexistent/one.ts");
		expect(r.error).toContain("/nonexistent/two.ts");
	});

	test("the checkout-relative candidate loads the real mergeHold", async () => {
		// SCHEDULER_CANDIDATES[0] is the image path; [1] resolves the repo root
		// from the script's own location, so the checkout run finds the scheduler.
		expect(SCHEDULER_CANDIDATES[0]).toBe("/app/src/scheduler.ts");
		const rel = SCHEDULER_CANDIDATES[1];
		expect(rel).toBeString();
		const r = await resolveMergeHold([rel!]);
		expect(r.mergeHold).not.toBeNull();
		const tasks = [
			{
				id: "T-5",
				project: "p",
				kind: "review",
				releaseVersion: null,
				stage: "merging",
				state: "idle",
				cancelledAt: null,
				followUpOf: null,
				followUpOfProject: null,
				leadAtDone: null,
			},
		];
		// The live rule: a merge behind a review parked at merging waits for its findings.
		expect(
			r.mergeHold?.(tasks, { id: "T-7", stage: "merging", state: "queued" }),
		).toBe("waiting for the review's findings to be implemented");
		// OTTR-1247: the same import carries leadValidationHold for the report's lead hold.
		expect(r.leadHold).not.toBeNull();
		// A wire card (GET /api/state): no prompt, the sandboxLead stamp instead.
		expect(
			r.leadHold?.({
				id: "T-8",
				project: "p",
				stage: "todo",
				state: "queued",
				cancelledAt: null,
				validatedAt: null,
				followUpOf: "T-5",
				sandboxLead: true,
			}),
		).toBe(
			"Waits for a validation run of review T-5; a work turn has no sandbox_run.",
		);
	});
});

describe("report", () => {
	const tmp = mkdtempSync(join(tmpdir(), "board-report-"));
	const git = (args: string[], cwd: string) => {
		const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0)
			throw new Error(`${args.join(" ")} failed: ${r.stderr.toString()}`);
	};
	// The upstream repo for two clones: one ahead, one dirty, so the report's
	// git status walk sees a real [ahead 1] header and a real dirty file list.
	git(["git", "init", "-q", "-b", "main", join(tmp, "up")], tmp);
	git(
		[
			"git",
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"--allow-empty",
			"-q",
			"-m",
			"one",
		],
		join(tmp, "up"),
	);
	git(["git", "clone", "-q", join(tmp, "up"), join(tmp, "ahead")], tmp);
	git(["git", "clone", "-q", join(tmp, "up"), join(tmp, "dirty")], tmp);
	git(
		[
			"git",
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"--allow-empty",
			"-q",
			"-m",
			"two",
		],
		join(tmp, "ahead"),
	);
	mkdirSync(join(tmp, "dirty", "sub"), { recursive: true });
	writeFileSync(join(tmp, "dirty", "scratch.txt"), "leftover\n");

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// The shape copies a real GET /api/state answer: the envelope keys and the
	// TaskCard (src/types.ts TaskCard) and ProjectView (src/types.ts) field
	// names and nullability; wide TaskCard text fields are trimmed — the report
	// reads none of them. No BoardState annotation: the fixture carries the real
	// rows' unread fields, and assignability still checks what report() reads.
	const s = {
		tasks: [
			card({
				id: "T-1",
				state: "needs_you",
				asked: [
					{
						question: "Which base for the rebase?",
						options: [{ label: "origin/main" }, { label: "local main" }],
						multi: false,
						recommended: 1,
					},
				],
			}),
			card({
				id: "T-2",
				state: "needs_you",
				needsReason:
					"Update card: read the summary, then reply to approve the merge.",
			}),
			card({ id: "T-3", stage: "queued", state: "queued", dependsOn: ["T-9"] }),
			card({ id: "T-4" }),
			card({
				id: "T-5",
				stage: "merging",
				state: "queued",
				project: "br-fixt-a1",
				kind: "task",
				releaseVersion: null,
			}),
			card({
				id: "T-6",
				stage: "merging",
				state: "idle",
				needsReason: "waiting for the review's findings to be implemented",
				project: "br-fixt-a1",
				kind: "review",
				releaseVersion: null,
				createdAt: F.now - 3_600_000,
			}),
			card({
				id: "T-11",
				stage: "merging",
				state: "running",
				project: "br-fixt-a1",
				kind: "task",
				releaseVersion: null,
			}),
			card({ id: "T-7", stage: "in_progress", state: "idle" }),
			card({ id: "T-8", stage: "done", state: "idle" }),
			card({ id: "T-10", stage: "in_progress", state: "idle", cancelledAt: 5 }),
		],
		projects: [
			{
				name: "gp",
				icon: null,
				remote: null,
				path: join(tmp, "unused"),
				sessionsDir: join(tmp, "unused", ".tasks", "sessions"),
				hasRules: true,
				target: null,
				gitless: true,
				dirty: false,
				mainBranch: null,
				mainUnpushed: false,
				github: null,
			},
			{
				name: "ahead-proj",
				icon: null,
				remote: null,
				path: join(tmp, "ahead"),
				sessionsDir: join(tmp, "ahead", ".tasks", "sessions"),
				hasRules: true,
				target: "origin/main",
				gitless: false,
				dirty: false,
				mainBranch: "main",
				mainUnpushed: true,
				github: null,
			},
			{
				name: "dirty-proj",
				icon: null,
				remote: null,
				path: join(tmp, "dirty"),
				sessionsDir: join(tmp, "dirty", ".tasks", "sessions"),
				hasRules: true,
				target: "origin/main",
				gitless: false,
				dirty: true,
				mainBranch: "main",
				mainUnpushed: false,
				github: null,
			},
		],
		maxTotal: 3,
		drainUntil: null,
	};

	test("renders the table, the questions and the checkouts over a real-state shape", async () => {
		const out = await report(s, F.now);
		// Header with the open count (8 open: T-8 done and T-10 cancelled drop out).
		expect(out).toContain(
			"Board at 2025-10-09T08:53:20.000Z: 8 open, 2 running, maxTotal 3, drain none.",
		);
		// No warning: mergeHold resolved through the real scheduler.
		expect(out).not.toContain("WARNING:");
		// Stuck rows sort first; the question row follows the stuck one.
		expect(out.indexOf("p/T-7")).toBeLessThan(out.indexOf("p/T-1"));
		// The queued merge names both the review hold and the active merge slot.
		const mergeRow = out
			.split("\n")
			.find((row) => row.startsWith("| br-fixt-a1/T-5 T |"));
		expect(mergeRow).toContain("| merging/queued | OK |");
		expect(mergeRow).toContain("review T-6");
		expect(mergeRow).toContain("T-11");
		expect(out).toContain(
			"| br-fixt-a1/T-6 T | merging/idle | OK | release waits for its findings | waiting for the review's findings",
		);
		// Done and cancelled cards never render.
		expect(out).not.toContain("T-8 ");
		expect(out).not.toContain("T-10 ");
		// The question section lists the asked card with its options, recommended starred.
		expect(out).toContain("## Questions");
		expect(out).toContain("### p/T-1: T");
		expect(out).toContain(
			"1. Which base for the rebase? [origin/main | *local main]",
		);
		// Main checkouts: gitless, ahead flag, dirty file list.
		expect(out).toContain("- gp: gitless");
		expect(out).toContain(
			"**ahead: check for a failed server push (skill step 4)**",
		);
		expect(out).toContain("DIRTY: ?? scratch.txt");
	});

	test("a merge-hold import failure warns loudly and still renders", async () => {
		const original = [...SCHEDULER_CANDIDATES];
		try {
			SCHEDULER_CANDIDATES.splice(
				0,
				SCHEDULER_CANDIDATES.length,
				"/nonexistent/x.ts",
			);
			const out = await report(s, F.now);
			expect(out).toContain(
				"WARNING: scheduler holds unknown (scheduler import failed: /nonexistent/x.ts",
			);
			// The rest of the report still renders.
			expect(out).toContain("## Main checkouts");
		} finally {
			SCHEDULER_CANDIDATES.splice(0, SCHEDULER_CANDIDATES.length, ...original);
		}
	});

	test("the merge note names the holding review, the held time and the cap (OTTR-1253)", async () => {
		// Pin the checkout scheduler: candidates[0] is this container's /app image copy,
		// which predates OTTR-1253 and has no reviewHoldsFor. The server container's /app
		// copy is the one production should read.
		const original = [...SCHEDULER_CANDIDATES];
		try {
			SCHEDULER_CANDIDATES.splice(
				0,
				SCHEDULER_CANDIDATES.length,
				SCHEDULER_CANDIDATES[1]!,
			);
			const now = F.now;
			const review = card({
				id: "OTTR-1186",
				project: "br",
				title: "Architecture review",
				kind: "review",
				releaseVersion: null,
				stage: "in_progress",
				state: "needs_you",
				createdAt: now - 47 * 3_600_000,
			});
			const release = card({
				id: "OTTR-2",
				project: "br",
				kind: "task",
				releaseVersion: "v3.0.0",
				stage: "merging",
				state: "needs_you",
				createdAt: now - 3_600_000,
			});
			const merge = card({
				id: "T-9",
				project: "br",
				stage: "merging",
				state: "queued",
				kind: "task",
				releaseVersion: null,
			});
			const state: BoardState = {
				tasks: [review, release, merge],
				projects: [{ name: "br", path: "/tmp/unused-br", gitless: true }],
				maxTotal: 2,
				drainUntil: null,
			};
			const out = await report(state, now);
			// The running review's note names the review, the held time and the cap instant.
			expect(out).toContain(
				`waiting for the review to finish (review OTTR-1186, held 47.0h, cap frees at ${new Date(now + 3_600_000).toISOString()})`,
			);
			// The open reviews section counts each review's held merges.
			expect(out).toContain("## Open reviews holding merges");
			expect(out).toContain(
				`- br/OTTR-1186: holds 1 queued merge — "waiting for the review to finish" held 47.0h (cap: ${new Date(now + 3_600_000).toISOString()}).`,
			);

			// Without the running review, the release's uncapped hold names its review too.
			const out2 = await report({ ...state, tasks: [release, merge] }, now);
			expect(out2).toContain(
				`waiting for release v3.0.0 (review OTTR-2, held 1.0h, no cap)`,
			);
			expect(out2).toContain(
				`- br/OTTR-2: holds 1 queued merge — "waiting for release v3.0.0" held 1.0h (cap: no cap).`,
			);
		} finally {
			SCHEDULER_CANDIDATES.splice(0, SCHEDULER_CANDIDATES.length, ...original);
		}
	});
});

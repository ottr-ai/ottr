import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DUP_CANDIDATE_CAP,
	type DupCandidate,
	type DupVerdict,
	dupCandidate,
	dupCandidateTasks,
	dupCloseReason,
	duplicateCheck,
	dupMatchText,
	dupOverlapNote,
	parseDupTerms,
	parseDupVerdict,
	searchCode,
	staleDupMatches,
} from "./duplicateGate.ts";
import type { SpawnFn } from "./forkAnalysis.ts";
import { DUPLICATE_REASON } from "./prompts.ts";
import fc from "./test/properties.ts";
import type { Task } from "./types.ts";
import type { GitResult, git } from "./worktree.ts";

let seq = 0;
/** A task with the fields the gate reads; the gate never reads the rest of Task. */
function task(p: Partial<Task> = {}): Task {
	seq += 1;
	return {
		id: `T-${seq}`,
		title: `task ${seq}`,
		prompt: `prompt ${seq}`,
		kind: "work",
		sourcePrNumber: null,
		stage: "in_progress",
		research: false,
		cancelledAt: null,
		followUpOf: null,
		followUpOfProject: null,
		updatedAt: seq,
		summary: null,
		report: null,
		...p,
	} as Task;
}

describe("dupCandidateTasks", () => {
	test("selects in progress, merging and done research without a follow-up; excludes the rest", () => {
		const self = task({ id: "S", stage: "todo", followUpOf: "P" });
		const tasks = [
			self,
			task({ id: "P", stage: "in_progress" }),
			task({ id: "A", stage: "in_progress" }),
			task({ id: "B", stage: "merging" }),
			task({ id: "R", stage: "done", research: true }),
			task({ id: "R2", stage: "done", research: true }),
			task({ id: "C2", stage: "todo", followUpOf: "R2" }),
			task({ id: "R3", stage: "done", research: true }),
			task({
				id: "C3",
				stage: "in_progress",
				followUpOf: "R3",
				cancelledAt: 5,
			}),
			task({ id: "R4", stage: "done", research: true }),
			task({
				id: "C4",
				stage: "todo",
				followUpOf: "R4",
				followUpOfProject: "other",
			}),
			task({ id: "D", stage: "done" }),
			task({ id: "T", stage: "todo" }),
			task({ id: "BL", stage: "backlog" }),
			task({ id: "X", stage: "in_progress", cancelledAt: 9 }),
		];
		expect(new Set(dupCandidateTasks(self, tasks).map((t) => t.id))).toEqual(
			new Set(["A", "B", "R", "R3", "R4"]),
		);
	});

	test("PR-review, other-kind and source-PR cards are never candidates (outside text)", () => {
		// A PR-review card waits in_progress with the PR author's title in its prompt.
		const self = task({ id: "S", stage: "todo" });
		const tasks = [
			self,
			task({ id: "W", stage: "in_progress" }),
			task({ id: "PR", kind: "pr_review", stage: "in_progress" }),
			task({ id: "DB", stage: "in_progress", sourcePrNumber: 10 }),
			task({ id: "TR", kind: "trending", stage: "in_progress" }),
			task({ id: "RV", kind: "review", stage: "done", research: true }),
		];
		expect(dupCandidateTasks(self, tasks).map((t) => t.id)).toEqual(["W"]);
		// A match on such a card is stale at close time, too.
		expect(
			staleDupMatches(
				self,
				{
					verdict: "duplicate",
					matches: [{ kind: "task", ref: "PR" }],
					reason: "covered",
				},
				[],
				tasks,
			),
		).toEqual(["PR"]);
	});

	test("a parent on another project's board does not exclude the same id here", () => {
		const self = task({
			id: "S",
			stage: "todo",
			followUpOf: "A",
			followUpOfProject: "other",
		});
		const tasks = [self, task({ id: "A", stage: "in_progress" })];
		expect(dupCandidateTasks(self, tasks).map((t) => t.id)).toEqual(["A"]);
	});

	test("newest updatedAt first, at most DUP_CANDIDATE_CAP", () => {
		const self = task({ id: "S", stage: "todo" });
		const many = Array.from({ length: DUP_CANDIDATE_CAP + 5 }, (_, i) =>
			task({ id: `M-${i}`, updatedAt: 1_000 + i }),
		);
		const picked = dupCandidateTasks(self, [self, ...many]);
		expect(picked).toHaveLength(DUP_CANDIDATE_CAP);
		expect(picked[0]?.id).toBe(`M-${DUP_CANDIDATE_CAP + 4}`);
		expect(picked.at(-1)?.id).toBe("M-5");
		const times = picked.map((t) => t.updatedAt);
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});
});

describe("staleDupMatches", () => {
	const self = task({ id: "S", stage: "todo" });
	const seenAs = (
		id: string,
		status: DupCandidate["status"],
	): DupCandidate => ({
		id,
		status,
		title: id,
		prompt: id,
		summary: null,
		report: null,
	});
	const verdict = (...ids: string[]): DupVerdict => ({
		verdict: "duplicate",
		matches: [
			{ kind: "code", ref: "src/a.ts:1" },
			...ids.map((ref) => ({ kind: "task" as const, ref })),
		],
		reason: "covered",
	});

	test("a match that still holds with the status the model saw is not stale", () => {
		const a = task({ id: "A", stage: "merging" });
		const r = task({ id: "R", stage: "done", research: true });
		expect(
			staleDupMatches(
				self,
				verdict("A", "R"),
				[seenAs("A", "merging"), seenAs("R", "done research")],
				[self, a, r],
			),
		).toEqual([]);
	});

	test("gone, cancelled, status-changed and newly followed-up matches are stale", () => {
		const cancelled = task({ id: "C", cancelledAt: 5 });
		const moved = task({ id: "M", stage: "merging" });
		const done = task({ id: "D", stage: "done", research: false });
		const research = task({ id: "R", stage: "done", research: true });
		const child = task({ id: "K", stage: "todo", followUpOf: "R" });
		expect(
			staleDupMatches(
				self,
				verdict("G", "C", "M", "D", "R"),
				[
					seenAs("G", "in progress"),
					seenAs("C", "in progress"),
					seenAs("M", "in progress"),
					seenAs("D", "in progress"),
					seenAs("R", "done research"),
				],
				[self, cancelled, moved, done, research, child],
			),
		).toEqual(["G", "C", "M", "D", "R"]);
	});
});

describe("dupCandidate", () => {
	test("maps the status and caps the texts; report only for done research", () => {
		const long = "x".repeat(3_000);
		const research = dupCandidate(
			task({
				id: "R",
				title: "Research it",
				stage: "done",
				research: true,
				prompt: long,
				summary: long,
				report: long,
			}),
		);
		expect(research).toEqual({
			id: "R",
			status: "done research",
			title: "Research it",
			prompt: "x".repeat(1200),
			summary: "x".repeat(400),
			report: "x".repeat(1500),
		});
		const work = dupCandidate(task({ stage: "in_progress", report: long }));
		expect(work.status).toBe("in progress");
		expect(work.report).toBeNull();
		expect(work.summary).toBeNull();
		expect(dupCandidate(task({ stage: "merging" })).status).toBe("merging");
	});

	test("a stage outside the candidate rules throws RangeError", () => {
		expect(() => dupCandidate(task({ stage: "todo" }))).toThrow(RangeError);
		expect(() => dupCandidate(task({ stage: "done" }))).toThrow(RangeError);
	});
});

describe("parseDupTerms", () => {
	test("strips a fence, trims, drops short, long, non-string and duplicate terms", () => {
		const raw = `\`\`\`json\n${JSON.stringify({
			terms: [
				"ab",
				"  renderWidget  ",
				"RENDERWIDGET",
				5,
				"x".repeat(81),
				"abc",
			],
		})}\n\`\`\``;
		expect(parseDupTerms(raw)).toEqual(["renderWidget", "abc"]);
	});

	test("keeps at most 8 terms", () => {
		const terms = Array.from({ length: 10 }, (_, i) => `term${i}`);
		expect(parseDupTerms(JSON.stringify({ terms }))).toEqual(terms.slice(0, 8));
	});

	test("bad JSON, a non-object and a non-array terms throw RangeError", () => {
		expect(() => parseDupTerms("not json")).toThrow(RangeError);
		expect(() => parseDupTerms('["abc"]')).toThrow(RangeError);
		expect(() => parseDupTerms('{"terms":"abc"}')).toThrow(
			/"terms" is not an array/,
		);
	});
});

const taskIds: ReadonlySet<string> = new Set(["OTTR-1", "OTTR-2"]);
const paths: ReadonlySet<string> = new Set(["src/a.ts", "docs/b.md"]);
const known = { taskIds, paths };
const verdictRaw = (v: Record<string, unknown>): string =>
	JSON.stringify({ verdict: "duplicate", reason: "it exists", ...v });

describe("parseDupVerdict", () => {
	test("accepts task ids and hit paths, alone or with a line, inside a fence", () => {
		const raw = `\`\`\`\n${verdictRaw({
			matches: [
				{ kind: "code", ref: "src/a.ts:12" },
				{ kind: "code", ref: "docs/b.md" },
				{ kind: "task", ref: " OTTR-1 " },
			],
		})}\n\`\`\``;
		expect(parseDupVerdict(raw, known)).toEqual({
			verdict: "duplicate",
			matches: [
				{ kind: "code", ref: "src/a.ts:12" },
				{ kind: "code", ref: "docs/b.md" },
				{ kind: "task", ref: "OTTR-1" },
			],
			reason: "it exists",
		});
	});

	test("new with no matches passes", () => {
		expect(
			parseDupVerdict(verdictRaw({ verdict: "new", matches: [] }), known),
		).toEqual({ verdict: "new", matches: [], reason: "it exists" });
	});

	test("each violation throws a RangeError that names it", () => {
		const code = [{ kind: "code", ref: "src/a.ts" }];
		const cases: Array<[string, RegExp]> = [
			["{oops", /not valid JSON/],
			["[1]", /not a JSON object/],
			[verdictRaw({ verdict: "maybe", matches: [] }), /"verdict" must be/],
			[verdictRaw({ reason: " ", matches: code }), /"reason"/],
			[verdictRaw({ matches: "src/a.ts" }), /"matches" is not an array/],
			[verdictRaw({ matches: [null] }), /matches\[0\] is not an object/],
			[verdictRaw({ matches: [{ kind: "code" }] }), /ref is not a string/],
			[
				verdictRaw({ matches: [{ kind: "file", ref: "src/a.ts" }] }),
				/kind must be code or task/,
			],
			[
				verdictRaw({ matches: [{ kind: "task", ref: "OTTR-9" }] }),
				/unknown task id: OTTR-9/,
			],
			[
				verdictRaw({ matches: [{ kind: "code", ref: "src/c.ts:3" }] }),
				/outside the search hits: src\/c.ts:3/,
			],
			[
				verdictRaw({ matches: [{ kind: "code", ref: "src/a.ts:x" }] }),
				/outside the search hits/,
			],
			[
				verdictRaw({ matches: [{ kind: "task", ref: "src/a.ts" }] }),
				/unknown task id/,
			],
			[verdictRaw({ matches: [] }), /"duplicate" carries no match/],
			[
				verdictRaw({ verdict: "partial", matches: [] }),
				/"partial" carries no match/,
			],
			[verdictRaw({ verdict: "new", matches: code }), /"new" carries matches/],
		];
		for (const [raw, message] of cases) {
			expect(() => parseDupVerdict(raw, known)).toThrow(RangeError);
			expect(() => parseDupVerdict(raw, known)).toThrow(message);
		}
	});

	test("caps the reason at 500 and keeps at most 10 matches", () => {
		const matches = Array.from({ length: 12 }, (_, i) => ({
			kind: "code",
			ref: `src/a.ts:${i + 1}`,
		}));
		const v = parseDupVerdict(
			verdictRaw({ verdict: "partial", reason: "r".repeat(600), matches }),
			known,
		);
		expect(v.reason).toBe("r".repeat(500));
		expect(v.matches).toEqual(matches.slice(0, 10) as DupVerdict["matches"]);
	});

	test("property: only RangeError escapes, and an accepted verdict names only known ids and paths", () => {
		const ref = fc.oneof(
			fc.constantFrom(
				"OTTR-1",
				"OTTR-3",
				" OTTR-2 ",
				"src/a.ts",
				"src/a.ts:7",
				"src/a.ts:",
				"docs/b.md:x",
				"src/z.ts:1",
			),
			fc.string(),
		);
		const answer = fc
			.record(
				{
					verdict: fc.oneof(
						fc.constantFrom("duplicate", "partial", "new", "same"),
						fc.anything(),
					),
					matches: fc.oneof(
						fc.array(
							fc.oneof(
								fc.record(
									{
										kind: fc.oneof(
											fc.constantFrom("code", "task", "file"),
											fc.anything(),
										),
										ref: fc.oneof(ref, fc.anything()),
									},
									{ requiredKeys: [] },
								),
								fc.anything(),
							),
							{ maxLength: 12 },
						),
						fc.anything(),
					),
					reason: fc.oneof(fc.string(), fc.anything()),
				},
				{ requiredKeys: [] },
			)
			.map((o) => JSON.stringify(o));
		const raw = fc
			.tuple(fc.oneof(answer, fc.json(), fc.string()), fc.boolean())
			.map(([s, fence]) => (fence ? `\`\`\`json\n${s}\n\`\`\`` : s));
		fc.assert(
			fc.property(raw, (s) => {
				let v: DupVerdict;
				try {
					v = parseDupVerdict(s, known);
				} catch (err) {
					expect(err).toBeInstanceOf(RangeError);
					return;
				}
				expect(v.verdict === "new").toBe(v.matches.length === 0);
				for (const m of v.matches) {
					if (m.kind === "task") expect(taskIds.has(m.ref)).toBe(true);
					else
						expect(
							paths.has(m.ref) || paths.has(m.ref.replace(/:\d+$/, "")),
						).toBe(true);
				}
			}),
		);
	});
});

let root: string;
let repo: string;

/** The fixture's own git runner: the fixture never goes through the code under test. */
const sh = (cwd: string, ...args: string[]): string => {
	const r = Bun.spawnSync(["git", ...args], { cwd });
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	return r.stdout.toString().trim();
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ottr-dupgate-"));
	repo = join(root, "repo");
	sh(root, "init", "-q", "-b", "main", repo);
	mkdirSync(join(repo, "src"));
	mkdirSync(join(repo, "docs"));
	writeFileSync(
		join(repo, "src", "widget.ts"),
		"export function renderWidget() {}\n// second line\n",
	);
	writeFileSync(join(repo, "docs", "notes.md"), "Nothing here\nWidget docs\n");
	sh(repo, "add", ".");
	sh(
		repo,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"-m",
		"init",
	);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A git stand-in for the cap and error paths that a small real repo cannot reach. */
function fakeGit(grep: GitResult, files = ""): typeof git {
	return async (args) =>
		args[0] === "ls-tree" ? { code: 0, stdout: files, stderr: "" } : grep;
}

describe("searchCode", () => {
	test("a content hit carries its line number and no ref prefix", async () => {
		const hits = await searchCode({
			cwd: repo,
			ref: "main",
			terms: ["renderWidget"],
		});
		expect(hits).toEqual([
			{
				path: "src/widget.ts",
				line: 1,
				text: "export function renderWidget() {}",
			},
		]);
	});

	test("a path name hit has line null; the content search is case insensitive", async () => {
		const hits = await searchCode({
			cwd: repo,
			ref: "main",
			terms: ["widget"],
		});
		expect(hits).toContainEqual({
			path: "src/widget.ts",
			line: null,
			text: "",
		});
		expect(hits).toContainEqual({
			path: "docs/notes.md",
			line: 2,
			text: "Widget docs",
		});
		expect(hits.every((h) => !h.path.startsWith("main:"))).toBe(true);
	});

	test("a term with no match gives no hits", async () => {
		expect(
			await searchCode({ cwd: repo, ref: "main", terms: ["zzqqxx"] }),
		).toEqual([]);
	});

	test("a bad ref throws an Error", async () => {
		await expect(
			searchCode({ cwd: repo, ref: "no-such-ref", terms: ["widget"] }),
		).rejects.toThrow(/no-such-ref.*exit 128/);
	});

	test("a git grep failure throws an Error that names git's stderr", async () => {
		const git = fakeGit({ code: 2, stdout: "", stderr: "grep broke" });
		await expect(
			searchCode({ cwd: repo, ref: "main", terms: ["abc"], git }),
		).rejects.toThrow(/grep broke/);
	});

	test("no terms runs no git", async () => {
		const git = async (): Promise<GitResult> => {
			throw new Error("git ran");
		};
		expect(
			await searchCode({ cwd: repo, ref: "main", terms: [], git }),
		).toEqual([]);
	});

	test("caps: 20 grep hits and 10 path hits per term, 200 text chars, 120 hits in all, no duplicates", async () => {
		const lines = Array.from(
			{ length: 30 },
			(_, i) => `main:f${i}.ts:${i + 1}:${"y".repeat(300)}`,
		).join("\n");
		const files = Array.from({ length: 15 }, (_, i) => `abc${i}.ts`).join("\n");
		const git = fakeGit({ code: 0, stdout: lines, stderr: "" }, files);
		const one = await searchCode({
			cwd: repo,
			ref: "main",
			terms: ["abc"],
			git,
		});
		expect(one.filter((h) => h.line !== null)).toHaveLength(20);
		expect(one.filter((h) => h.line === null)).toHaveLength(10);
		expect(one[0]).toEqual({ path: "f0.ts", line: 1, text: "y".repeat(200) });
		const same = await searchCode({
			cwd: repo,
			ref: "main",
			terms: ["abc", "ABC2"],
			git,
		});
		expect(same).toHaveLength(30);
		const terms = Array.from({ length: 8 }, (_, i) => `t${i}`);
		const many = Array.from({ length: 8 }, (_, t) =>
			Array.from({ length: 20 }, (_, i) => `main:t${t}/f${i}.ts:1:x`).join(
				"\n",
			),
		);
		let call = 0;
		const wide = async (args: string[]): Promise<GitResult> =>
			args[0] === "ls-tree"
				? { code: 0, stdout: "", stderr: "" }
				: { code: 0, stdout: many[call++] ?? "", stderr: "" };
		expect(
			await searchCode({ cwd: repo, ref: "main", terms, git: wide }),
		).toHaveLength(120);
	});
});

/** Gateway stdout in the shape runGateway parses: a ready line and the id 1 response. */
function gatewayOut(content: string): string {
	return [
		JSON.stringify({ ready: true }),
		JSON.stringify({
			id: 1,
			status: 200,
			body: { choices: [{ message: { content } }] },
		}),
	].join("\n");
}

/** A fake gateway that answers in turn and records each request body. */
function fakeGateway(answers: string[]): {
	spawn: SpawnFn;
	requests: Array<{
		body: { model: string; messages: Array<{ content: string }> };
	}>;
} {
	const requests: Array<{
		body: { model: string; messages: Array<{ content: string }> };
	}> = [];
	const spawn: SpawnFn = async (_argv, o) => {
		requests.push(JSON.parse(o.stdin));
		return { code: 0, stdout: gatewayOut(answers.shift() ?? ""), stderr: "" };
	};
	return { spawn, requests };
}

const candidates: DupCandidate[] = [
	{
		id: "OTTR-7",
		status: "in progress",
		title: "Widget",
		prompt: "Build the widget",
		summary: null,
		report: null,
	},
];

describe("duplicateCheck", () => {
	test("asks for terms, searches the code and validates the verdict against the hits", async () => {
		const { spawn, requests } = fakeGateway([
			'{"terms":["renderWidget"]}',
			JSON.stringify({
				verdict: "duplicate",
				matches: [
					{ kind: "code", ref: "src/widget.ts:1" },
					{ kind: "task", ref: "OTTR-7" },
				],
				reason: "The widget exists.",
			}),
		]);
		const v = await duplicateCheck({
			prompt: "Add a widget",
			candidates,
			cwd: repo,
			ref: "main",
			spawn,
		});
		expect(v).toEqual({
			verdict: "duplicate",
			matches: [
				{ kind: "code", ref: "src/widget.ts:1" },
				{ kind: "task", ref: "OTTR-7" },
			],
			reason: "The widget exists.",
		});
		expect(requests).toHaveLength(2);
		expect(requests.map((r) => r.body.model)).toEqual(["@plan", "@plan"]);
		expect(requests[0]?.body.messages[1]?.content).toContain("Add a widget");
		const user = requests[1]?.body.messages[1]?.content ?? "";
		expect(user).toContain(
			"src/widget.ts:1: export function renderWidget() {}",
		);
		expect(user).toContain('"id":"OTTR-7"');
	});

	test("a path outside the hits throws RangeError", async () => {
		const { spawn } = fakeGateway([
			'{"terms":["renderWidget"]}',
			JSON.stringify({
				verdict: "duplicate",
				matches: [{ kind: "code", ref: "src/invented.ts:3" }],
				reason: "made up",
			}),
		]);
		await expect(
			duplicateCheck({
				prompt: "Add a widget",
				candidates,
				cwd: repo,
				ref: "main",
				spawn,
			}),
		).rejects.toThrow(RangeError);
	});

	test("zero terms skip the search and still ask the verdict", async () => {
		const { spawn, requests } = fakeGateway([
			'{"terms":[]}',
			'{"verdict":"new","matches":[],"reason":"nothing like it"}',
		]);
		const git = async (): Promise<GitResult> => {
			throw new Error("git ran");
		};
		const v = await duplicateCheck({
			prompt: "Add a widget",
			candidates,
			cwd: repo,
			ref: "main",
			spawn,
			git,
		});
		expect(v.verdict).toBe("new");
		expect(requests[1]?.body.messages[1]?.content).toContain("(no hits)");
	});
});

describe("outcome texts", () => {
	const v: DupVerdict = {
		verdict: "duplicate",
		matches: [
			{ kind: "task", ref: "OTTR-7" },
			{ kind: "code", ref: "src/widget.ts:1" },
		],
		reason: "The widget exists.",
	};

	test("the match text names a task with its status and code by its ref", () => {
		expect(dupMatchText(v, candidates)).toBe(
			"OTTR-7 (in progress), src/widget.ts:1",
		);
	});

	test("the close reason and the overlap note carry the reason and the matches", () => {
		expect(dupOverlapNote(v, candidates)).toBe(
			"The widget exists. Matches: OTTR-7 (in progress), src/widget.ts:1",
		);
		expect(dupCloseReason(v, candidates)).toBe(
			`${DUPLICATE_REASON}The widget exists. Matches: OTTR-7 (in progress), src/widget.ts:1`,
		);
	});
});

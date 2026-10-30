import { describe, expect, test } from "bun:test";
import {
	analyzeRange,
	buildUserMessage,
	parseAnalysis,
	proposalPrompt,
	redactSecrets,
	renderReport,
	runGateway,
	stripInvisible,
	systemPrompt,
} from "./forkAnalysis";
import { setGitSecrets } from "./gitHosts.ts";
import type { ForkAnalysisResult, ForkRange } from "./types";

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "c".repeat(40);

function range(over: Partial<ForkRange> = {}): ForkRange {
	return {
		fork: {
			id: 1,
			owner: "octo",
			name: "proj",
			defaultBranch: "main",
			pushedAt: null,
			sizeKb: null,
		},
		commits: [
			{
				sha: SHA1,
				subject: "add feature",
				files: 2,
				plus: 10,
				minus: 1,
				patch: "+code",
				branches: ["feat"],
			},
		],
		merges: [
			{
				sha: SHA2,
				subject: "Merge x",
				files: 1,
				plus: 5,
				minus: 0,
				patch: "-old+new",
				branches: ["feat"],
			},
		],
		upstreamCommits: [`${SHA3} fix upstream`],
		upstreamFiles: ["src/a.ts"],
		upstreamDocs: "# readme",
		heads: [{ branchHash: "0123456789abcdef", branch: "feat", head: SHA1 }],
		...over,
	};
}

const VALID_RESULT: ForkAnalysisResult = {
	commits: [SHA1],
	features: [
		{
			name: "Dark mode",
			commits: [SHA1],
			comparison: "genuinely missing upstream",
			feasibility: "src/a.ts holds the theme setup",
			value: "nicer UI",
			risk: "low",
			verdict: "propose",
			reason: "clear win",
			effort: "M",
		},
	],
	proposals: [],
	coverage: `saw 1 commit; could not verify runtime behavior. See ${SHA1}.`,
	deferred: [],
};

describe("stripInvisible", () => {
	test("removes and counts soft hyphen, zero-width space, variation selectors", () => {
		const r = stripInvisible("a\u00ADb\u200Bc\uFE0Fd\u{E0100}e");
		expect(r.text).toBe("abcde");
		expect(r.removed).toBe(4);
	});
	test("leaves normal text alone", () => {
		const r = stripInvisible("hello world");
		expect(r.text).toBe("hello world");
		expect(r.removed).toBe(0);
	});
});

describe("redactSecrets", () => {
	test("AWS access key", () => {
		const s = "key AKIAIOSFODNN7EXAMPLE here";
		const r = redactSecrets(s);
		expect(r.hits).toBe(1);
		expect(r.text).toBe("key [REDACTED] here");
	});
	test("AWS session key", () => {
		const r = redactSecrets("ASIAIOSFODNN7EXAMPLE");
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("GitHub token", () => {
		const r = redactSecrets("ghp_" + "x".repeat(36));
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("GitHub fine-grained PAT", () => {
		const r = redactSecrets("github_pat_" + "A".repeat(30));
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("Stripe live key", () => {
		const r = redactSecrets("sk_live_" + "y".repeat(20));
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("Google API key", () => {
		const r = redactSecrets("AIza" + "z".repeat(35));
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("a registered git-host token is redacted", () => {
		setGitSecrets(["glpat-" + "q".repeat(20)]);
		try {
			const token = "glpat-" + "q".repeat(20);
			const r = redactSecrets(`token ${token} in a log`);
			expect(r.hits).toBe(1);
			expect(r.text).toBe("token [REDACTED] in a log");
		} finally {
			setGitSecrets([]);
		}
	});
	test("short stored tokens are redacted, and a token 'REDACTED' does not loop", () => {
		setGitSecrets(["t0k", "REDACTED"]);
		try {
			const r = redactSecrets("a t0k and REDACTED and t0k");
			expect(r.hits).toBe(3);
			expect(r.text).toBe("a [REDACTED] and [REDACTED] and [REDACTED]");
		} finally {
			setGitSecrets([]);
		}
	});
	test("Slack token", () => {
		const r = redactSecrets("xoxb-123456789012-abcdefghij");
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("JWT", () => {
		const r = redactSecrets(
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4",
		);
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("private key block", () => {
		const block =
			"-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----";
		const r = redactSecrets(`before ${block} after`);
		expect(r.hits).toBe(1);
		expect(r.text).toBe("before [REDACTED] after");
	});
	test("URL with credentials", () => {
		const r = redactSecrets("postgres://admin:supersecret12@db.example.com/x");
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]db.example.com/x");
	});
	test("pauses on suspicious assignment", () => {
		const r = redactSecrets('cfg.password = "abcdefghijklmnop"');
		expect(r.paused).toBe("possible credential in fork content");
		expect(r.text).toBe('cfg.password = "abcdefghijklmnop"');
	});
	test("identifier copy does not pause", () => {
		const r = redactSecrets("apiKey = whisparr.apiKey;");
		expect(r.paused).toBeNull();
		expect(r.hits).toBe(0);
	});
	test("fixture-prefixed quoted value does not pause", () => {
		const r = redactSecrets('apiKey: "fixture-jellyfin-key",');
		expect(r.paused).toBeNull();
	});
	test("unquoted long value does not pause", () => {
		expect(
			redactSecrets("password = superlongunquotedvalue123").paused,
		).toBeNull();
	});
	test("known tokens do not trigger pause", () => {
		expect(redactSecrets("ghp_" + "x".repeat(36)).paused).toBeNull();
	});
});

describe("buildUserMessage", () => {
	test("contains all labelled blocks", () => {
		const msg = buildUserMessage(range(), {
			titles: ["T1"],
			declines: ["not worth it"],
		});
		for (const tag of [
			"FORK",
			"COMMITS",
			"MERGES",
			"UPSTREAM_COMMITS",
			"UPSTREAM_FILES",
			"UPSTREAM_DOCS",
			"PRIOR_PROPOSALS",
		]) {
			expect(msg).toContain(tag);
		}
		expect(msg).toContain("octo/proj");
		expect(msg).toContain("title: T1");
		expect(msg).toContain("declined: not worth it");
	});
	test("throws the paused error when a patch carries a suspicious assignment", () => {
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch: '+password = "abcdefghijklmnop"',
					branches: [],
				},
			],
			merges: [],
		});
		expect(() => buildUserMessage(r, { titles: [], declines: [] })).toThrow(
			"possible credential in fork content",
		);
	});
	test("throws RangeError when oversized patches bust the budget", () => {
		const big = "x".repeat(600_000);
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch: big,
					branches: [],
				},
			],
			merges: [],
		});
		expect(() => buildUserMessage(r, { titles: [], declines: [] })).toThrow(
			RangeError,
		);
		expect(() => buildUserMessage(r, { titles: [], declines: [] })).toThrow(
			/range exceeds prompt budget/,
		);
	});
});

describe("runGateway", () => {
	const okStdout = (statusBody: unknown) =>
		[
			JSON.stringify({ ready: true }),
			JSON.stringify({ id: 1, status: 200, body: statusBody }),
		].join("\n");

	test("happy path returns message content", async () => {
		let gotStdin = "";
		const out = await runGateway(
			[{ role: "user", content: "hi" }],
			async (_argv, o) => {
				gotStdin = o.stdin;
				return {
					code: 0,
					stdout: okStdout({ choices: [{ message: { content: "answer" } }] }),
					stderr: "",
				};
			},
		);
		expect(out).toBe("answer");
		const req = JSON.parse(gotStdin.trim()) as {
			id: number;
			path: string;
			body: { messages: unknown[] };
		};
		expect(req.id).toBe(1);
		expect(req.path).toBe("/v1/chat/completions");
		expect(req.body.messages).toHaveLength(1);
	});
	test("fork analysis asks the gateway for the default role", async () => {
		let model = "";
		await analyzeRange(
			range(),
			{ titles: [], declines: [] },
			{
				spawn: async (_argv, o) => {
					model = JSON.parse(o.stdin).body.model;
					return { code: 1, stdout: "", stderr: "stop" };
				},
			},
		).catch(() => {});
		expect(model).toBe("@default");
	});
	test("non-200 throws with the error message", async () => {
		const out = runGateway([{ role: "user", content: "hi" }], async () => ({
			code: 0,
			stdout: [
				JSON.stringify({ ready: true }),
				JSON.stringify({
					id: 1,
					status: 402,
					body: { error: { message: "no quota" } },
				}),
			].join("\n"),
			stderr: "",
		}));
		expect(out).rejects.toThrow("gateway status 402: no quota");
	});
	test("missing ready line throws", async () => {
		const out = runGateway([{ role: "user", content: "hi" }], async () => ({
			code: 0,
			stdout: JSON.stringify({
				id: 1,
				status: 200,
				body: { choices: [{ message: { content: "x" } }] },
			}),
			stderr: "",
		}));
		expect(out).rejects.toThrow("gateway did not report ready");
	});
});

describe("parseAnalysis", () => {
	test("accepts a valid sample and strips a json fence", () => {
		const fenced = "```json\n" + JSON.stringify(VALID_RESULT) + "\n```";
		const r = parseAnalysis(fenced, range());
		expect(r.commits).toEqual([SHA1]);
		expect(r.features[0]?.name).toBe("Dark mode");
		expect(r.deferred).toEqual([]);
	});
	test("rejects invalid JSON", () => {
		expect(() => parseAnalysis("not json", range())).toThrow("not valid JSON");
	});
	test("rejects unknown commit sha", () => {
		const bad = { ...VALID_RESULT, commits: ["d".repeat(40)] };
		expect(() => parseAnalysis(JSON.stringify(bad), range())).toThrow(
			/unknown commit sha/,
		);
	});
	test("rejects empty commits", () => {
		const bad = { ...VALID_RESULT, commits: ["e".repeat(40)] };
		expect(() => parseAnalysis(JSON.stringify(bad), range())).toThrow();
	});
	test("rejects bad verdict", () => {
		const bad = {
			...VALID_RESULT,
			features: [{ ...VALID_RESULT.features[0], verdict: "maybe" }],
		};
		expect(() => parseAnalysis(JSON.stringify(bad), range())).toThrow(
			/feature.verdict/,
		);
	});
	test("rejects missing effort", () => {
		const f = { ...VALID_RESULT.features[0] };
		const { effort: _e, ...rest } = f;
		const bad = { ...VALID_RESULT, features: [rest] };
		expect(() => parseAnalysis(JSON.stringify(bad), range())).toThrow(
			/feature.effort/,
		);
	});
	test("rejects 6 proposals", () => {
		const p = {
			title: "t",
			goal: "g",
			comparison: "c",
			change: "ch",
			checks: "ck",
			risk: "r",
			effort: "S",
			commits: [SHA1],
		};
		const bad = {
			...VALID_RESULT,
			proposals: Array.from({ length: 6 }, () => p),
		};
		expect(() => parseAnalysis(JSON.stringify(bad), range())).toThrow(
			/proposals exceeds 5/,
		);
	});
	test("rejects oversize string field", () => {
		const bad = { ...VALID_RESULT, coverage: "x".repeat(4001) };
		expect(() => parseAnalysis(JSON.stringify(bad), range())).toThrow(
			/coverage/,
		);
	});
	test("rejects unknown 40-hex sha in coverage", () => {
		const bad = {
			...VALID_RESULT,
			coverage: `looks like ${"9".repeat(40)} to me`,
		};
		expect(() => parseAnalysis(JSON.stringify(bad), range())).toThrow(
			/coverage mentions an unknown commit sha/,
		);
	});
});

describe("renderReport", () => {
	const report = renderReport(range(), VALID_RESULT);
	test("contains commit table row", () => {
		expect(report).toContain(`| ${SHA1.slice(0, 7)} | add feature | feat |`);
	});
	test("contains verdict header", () => {
		expect(report).toContain("## Dark mode — propose (effort M)");
	});
	test("contains coverage limits", () => {
		expect(report).toContain("no fork code executed");
		expect(report).toContain("human review and merge approval");
	});
	test("no raw 40-hex outside commit links", () => {
		const withoutLinks = report.replaceAll(
			`https://github.com/octo/proj/commit/${SHA1}`,
			"",
		);
		expect(withoutLinks).not.toContain(SHA1);
		expect(report).toContain(`https://github.com/octo/proj/commit/${SHA1}`);
	});
});

describe("proposalPrompt", () => {
	test("includes all six fixed sections and stays under the cap with 2000-char fields", () => {
		const big = (c: string) =>
			c.repeat(Math.ceil(2000 / c.length)).slice(0, 2000);
		const p = {
			title: "Dark mode",
			goal: big("g"),
			comparison: big("c"),
			change: big("h"),
			checks: big("k"),
			risk: big("r"),
			effort: "M" as const,
			commits: [SHA1],
		};
		const prompt = proposalPrompt("octo", "proj", p);
		expect(prompt.length).toBeLessThanOrEqual(19000);
		expect(prompt).toContain("Implement Dark mode (from fork research)");
		for (const label of [
			"Goal:",
			"Source:",
			"Comparison:",
			"Change:",
			"Checks:",
			"Risk:",
			"Effort:",
		]) {
			expect(prompt).toContain(label);
		}
		expect(prompt).toContain(`https://github.com/octo/proj/commit/${SHA1}`);
		expect(prompt).toContain("untrusted evidence");
		expect(prompt).toContain("re-check the current upstream");
		expect(prompt).toContain("Do not execute or copy fork code");
		expect(prompt).toContain("our own modules");
		expect(prompt).toContain("Merge needs approval");
	});
	test("first line works as a card title", () => {
		const p = {
			title: "X".repeat(90),
			goal: "g",
			comparison: "c",
			change: "ch",
			checks: "ck",
			risk: "r",
			effort: "S" as const,
			commits: [],
		};
		const firstLine = proposalPrompt("o", "n", p).split("\n")[0] ?? "";
		expect(firstLine.length).toBeLessThanOrEqual(80);
	});
});

describe("systemPrompt", () => {
	test("forbids instruction-following and fixes the output shape", () => {
		const s = systemPrompt();
		expect(s).toContain("untrusted");
		expect(s).toContain("STRICT JSON");
		expect(s).toContain('"propose"|"skip"|"unknown"');
		expect(s).toContain("max 5");
	});
});

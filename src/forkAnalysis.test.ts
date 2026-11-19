import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	analyzeRange,
	buildUserMessage,
	defaultSpawn,
	hasCredentialShape,
	isProviderError,
	PROMPT_CHAR_BUDGET,
	parseAnalysis,
	proposalPrompt,
	redactSecrets,
	renderReport,
	runGateway,
	runGatewayWithFallbacks,
	type SpawnFn,
	stripInvisible,
	systemPrompt,
} from "./forkAnalysis";
import { setGitSecrets } from "./gitHosts.ts";
import fc from "./test/properties.ts";
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
		const r = redactSecrets(`ghp_${"x".repeat(36)}`);
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("GitHub fine-grained PAT", () => {
		const r = redactSecrets(`github_pat_${"A".repeat(30)}`);
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("Stripe live key", () => {
		const r = redactSecrets(`sk_live_${"y".repeat(20)}`);
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("Google API key", () => {
		const r = redactSecrets(`AIza${"z".repeat(35)}`);
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]");
	});
	test("a registered git-host token is redacted", () => {
		setGitSecrets([`glpat-${"q".repeat(20)}`]);
		try {
			const token = `glpat-${"q".repeat(20)}`;
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
	test("JWT at the segment bounds still redacts", () => {
		const jwt = `eyJ${"h".repeat(118)}.${"a".repeat(2048)}.${"S".repeat(2048)}`;
		const r = redactSecrets(`x ${jwt} y`);
		expect(r.hits).toBe(1);
		expect(r.text).toBe("x [REDACTED] y");
	});
	test("JWT segment beyond the bound stays visible (OTTR-997)", () => {
		const jwt = `eyJ${"h".repeat(118)}.${"a".repeat(2049)}.SflKxwRJSMeKKF2QT4`;
		const r = redactSecrets(jwt);
		expect(r.hits).toBe(0);
		expect(r.text).toBe(jwt);
	});
	test("PEM gap beyond 8 KiB stays visible (OTTR-997)", () => {
		const block =
			`-----BEGIN RSA PRIVATE KEY-----\n${"a".repeat(8193)}\n` +
			"-----END RSA PRIVATE KEY-----";
		const r = redactSecrets(`before ${block} after`);
		expect(r.hits).toBe(0);
		expect(r.text).toBe(`before ${block} after`);
	});
	test("stays fast on attacker-shaped text that cannot match (OTTR-997)", () => {
		// Before the fix these two ran the old unbounded patterns for 81 s and 16 s.
		const t0 = performance.now();
		const jwtText = redactSecrets("eyJ".repeat(333_333));
		const jwtMs = performance.now() - t0;
		expect(jwtText.hits).toBe(0);
		expect(jwtMs).toBeLessThan(1000);
		const t1 = performance.now();
		const pemText = redactSecrets(
			"-----BEGIN PRIVATE KEY-----\n".repeat(40000),
		);
		const pemMs = performance.now() - t1;
		expect(pemText.hits).toBe(0);
		expect(pemMs).toBeLessThan(1000);
	});
	test("URL with credentials", () => {
		const r = redactSecrets("postgres://admin:supersecret12@db.example.com/x");
		expect(r.hits).toBe(1);
		expect(r.text).toBe("[REDACTED]db.example.com/x");
	});
	test("URL user part beyond the bound stays visible (OTTR-997)", () => {
		const s = `postgres://${"u".repeat(256)}:password123@db.example.com/x`;
		const r = redactSecrets(s);
		expect(r.hits).toBe(0);
		expect(r.text).toBe(s);
	});
	test("suspicious assignment redacts the quoted value", () => {
		const r = redactSecrets('cfg.password = "abcdefghijklmnop"');
		expect(r.hits).toBe(1);
		expect(r.text).toBe('cfg.password = "[REDACTED]"');
	});
	test("single-quoted suspicious value redacts with its quote style kept", () => {
		const r = redactSecrets("secret: 'aaaaaaaaaaaaaaaa'");
		expect(r.hits).toBe(1);
		expect(r.text).toBe("secret: '[REDACTED]'");
	});
	test("identifier copy stays visible", () => {
		const r = redactSecrets("apiKey = whisparr.apiKey;");
		expect(r.hits).toBe(0);
		expect(r.text).toBe("apiKey = whisparr.apiKey;");
	});
	test("fixture-prefixed quoted value stays visible", () => {
		const r = redactSecrets('apiKey: "fixture-jellyfin-key",');
		expect(r.hits).toBe(0);
		expect(r.text).toBe('apiKey: "fixture-jellyfin-key",');
	});
	test("the fixture check runs on the trimmed value", () => {
		const r = redactSecrets('apiKey: " test-jellyfin-key-1"');
		expect(r.hits).toBe(0);
		expect(r.text).toBe('apiKey: " test-jellyfin-key-1"');
	});
	test("a leading-space test value that is no fixture still redacts", () => {
		const r = redactSecrets('apiKey: " new-jellyfin-key-1"');
		expect(r.hits).toBe(1);
		expect(r.text).toBe('apiKey: "[REDACTED]"');
	});
	test("a prose value with a space redacts but never counts as a credential hit", () => {
		const r = redactSecrets(
			'apiKey: "A Whispa vial was lost because the settings never arrived."',
		);
		expect(r.hits).toBe(0);
		expect(r.text).toBe('apiKey: "[REDACTED]"');
	});
	test("unquoted long value stays visible", () => {
		const r = redactSecrets("password = superlongunquotedvalue123");
		expect(r.hits).toBe(0);
		expect(r.text).toBe("password = superlongunquotedvalue123");
	});
	test("quoted value at the 8 KiB bound redacts (OTTR-997)", () => {
		const r = redactSecrets(`password: "${"a".repeat(8192)}"`);
		expect(r.hits).toBe(1);
		expect(r.text).toBe('password: "[REDACTED]"');
	});
	test("quoted value beyond the 8 KiB bound stays visible (OTTR-997)", () => {
		const s = `password: "${"a".repeat(8193)}"`;
		const r = redactSecrets(s);
		expect(r.hits).toBe(0);
		expect(r.text).toBe(s);
	});
	test("property: no quoted suspicious value survives redaction", () => {
		const key = fc.constantFrom(
			"password",
			"passwd",
			"secret",
			"api_key",
			"apiKey",
			"access_token",
			"private-key",
		);
		const chunk = fc.constantFrom("aaaa", "bbbbbbbb", "1Z3", "x y z w");
		const value = fc
			.array(chunk, { minLength: 6, maxLength: 9 })
			.map((a) => a.join(""));
		// The pad ends with a non-word character (or is empty), so the keyword
		// keeps its \b boundary and the assignment matches.
		fc.assert(
			fc.property(
				key,
				value,
				fc.constantFrom('"', "'"),
				fc.constantFrom("", "x ", "-- ", "a\n"),
				(k, v, q, pad) => {
					const s = `${pad}${k}: ${q}${v}${q}`;
					const fixture =
						/^(?:fixture|test|example|sample|dummy|placeholder|changeme|redacted)[-_. ]/i;
					const r = redactSecrets(s);
					// The model never sees the value: every non-fixture quoted value
					// is gone after redaction, and redaction never throws.
					if (!fixture.test(v.trim())) expect(r.text).not.toContain(v);
				},
			),
		);
	});
	test("property: bounded token shapes never survive redaction (OTTR-997)", () => {
		const secret = fc.constantFrom(
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
			"postgres://admin:supersecret12@db.example.com/x",
			`ghp_${"x".repeat(36)}`,
		);
		// Fillers carry match prefixes without the required literals; the newline
		// keeps the \b boundary of the token prefixes intact.
		const filler = fc.constantFrom(
			"plain code",
			"eyJ",
			"-----BEGIN PRIVATE KEY-----",
			".",
			"a",
			"postgres://",
		);
		fc.assert(
			fc.property(
				fc.array(filler, { maxLength: 3 }),
				secret,
				fc.array(filler, { maxLength: 3 }),
				(pre, s, post) => {
					const text = `${pre.join("")}\n${s}\n${post.join("")}`;
					const r = redactSecrets(text);
					expect(r.text).not.toContain(s);
				},
			),
		);
	});
});

describe("hasCredentialShape", () => {
	test("true for a quoted non-fixture value, as the old pause refused", () => {
		expect(
			hasCredentialShape('api_key: "aaaa0000aaaa0000aaaa0000aaaa0000"'),
		).toBe(true);
		expect(hasCredentialShape('apiKey: "A Whispa vial was lost."')).toBe(true);
	});
	test("false for a fixture value, an identifier copy, and unquoted text", () => {
		expect(hasCredentialShape('apiKey: "fixture-jellyfin-key"')).toBe(false);
		expect(hasCredentialShape('apiKey: " test-jellyfin-key-1"')).toBe(false);
		expect(hasCredentialShape("apiKey = whisparr.apiKey;")).toBe(false);
		expect(hasCredentialShape("password = superlongunquotedvalue123")).toBe(
			false,
		);
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
	test("redacts a suspicious assignment inside a patch instead of throwing", () => {
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
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain('password = "[REDACTED]"');
		expect(msg).not.toContain("abcdefghijklmnop");
	});
	test("a token straddling the raw cut still redacts (OTTR-997)", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4";
		// Two commits -> cap 200_000, raw cut at 249_152. The patch goes over the
		// cut, the token sits well inside the cleaned region before the dropped
		// tail zone, and the marker beyond the raw cut goes with the tail.
		const patch = `${"a".repeat(190_000)}${jwt}${"b".repeat(70_000)}ZZTAILZZ`;
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch,
					branches: [],
				},
				{
					sha: SHA2,
					subject: "t",
					files: 1,
					plus: 1,
					minus: 0,
					patch: "+x",
					branches: [],
				},
			],
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("[REDACTED]");
		expect(msg).toContain("[patch truncated]");
		expect(msg).not.toContain("eyJ");
		expect(msg).not.toContain("ZZTAILZZ");
	});
	test("a PEM block straddling the old precap cut redacts in budget (OTTR-997)", () => {
		// Two commits -> per-patch cap 200_000. The block spans the position the
		// earlier 4 KiB slack pre-cut sat at; the range stays in budget, so
		// capPatches would never trim it and the raw body would reach the model.
		const patch1 =
			`${"a".repeat(204_000)}-----BEGIN RSA PRIVATE KEY-----\n` +
			`${"X".repeat(3000)}\n-----END RSA PRIVATE KEY-----${"b".repeat(1000)}`;
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch: patch1,
					branches: [],
				},
				{
					sha: SHA2,
					subject: "t",
					files: 1,
					plus: 1,
					minus: 0,
					patch: "+x",
					branches: [],
				},
			],
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("[REDACTED]");
		expect(msg).not.toContain("XXXXXXXXXX");
	});
	test("a 6 KiB PEM block straddling the cap redacts before the trim (OTTR-997)", () => {
		// The block is longer than the earlier 4 KiB slack: even when capPatches
		// trims, the pre-cut must sit far enough past the cap to cover it whole.
		const patch1 =
			`${"a".repeat(199_500)}-----BEGIN RSA PRIVATE KEY-----\n` +
			`${"X".repeat(6000)}\n-----END RSA PRIVATE KEY-----${"b".repeat(10_000)}`;
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch: patch1,
					branches: [],
				},
				{
					sha: SHA2,
					subject: "t",
					files: 1,
					plus: 1,
					minus: 0,
					patch: "a".repeat(199_000),
					branches: [],
				},
			],
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("[REDACTED]");
		expect(msg).not.toContain("XXXXXXXXXX");
	});
	test("a JWT straddling the old precap cut redacts in budget (OTTR-997)", () => {
		// The token spans the position the earlier 4 KiB slack pre-cut sat at;
		// a prefix of it must never reach the model unredacted.
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4";
		const patch1 = `${"a".repeat(204_060)}${jwt}${"b".repeat(2000)}`;
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch: patch1,
					branches: [],
				},
				{
					sha: SHA2,
					subject: "t",
					files: 1,
					plus: 1,
					minus: 0,
					patch: "+x",
					branches: [],
				},
			],
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("[REDACTED]");
		expect(msg).not.toContain("eyJ");
	});
	test("redaction shrink ahead of the cut cannot expose a cut token (OTTR-997)", () => {
		// Two commits -> cap 200_000, raw cut at 249_152. Three redacted blocks
		// shrink the cleaned text by ~18 KiB, so the emitted cut at 198_228 must
		// still sit before the last block, whose body straddles the raw cut.
		const block = (body: number) =>
			`-----BEGIN RSA PRIVATE KEY-----\n${"X".repeat(body)}\n-----END RSA PRIVATE KEY-----`;
		const patch1 =
			"a".repeat(1000) +
			block(6000).repeat(3) +
			"a".repeat(226_966) +
			block(6000) +
			"b".repeat(500);
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch: patch1,
					branches: [],
				},
				{
					sha: SHA2,
					subject: "t",
					files: 1,
					plus: 1,
					minus: 0,
					patch: "+x",
					branches: [],
				},
			],
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("[REDACTED]");
		expect(msg).toContain("[patch truncated]");
		expect(msg).not.toContain("XXXXXXXXXX");
		expect(msg).not.toContain("BEGIN RSA");
	});
	test("invisible-char shrink ahead of the cut cannot expose a cut token (OTTR-997)", () => {
		// 20 000 zero-width spaces shrink the cleaned text by 20 KiB; the raw cut
		// at 249_152 lands inside the last block's body and its prefix must stay
		// dropped.
		const patch1 =
			"\u200C".repeat(20_000) +
			"a".repeat(226_000) +
			"-----BEGIN RSA PRIVATE KEY-----\n" +
			`${"X".repeat(6000)}\n-----END RSA PRIVATE KEY-----${"b".repeat(500)}`;
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch: patch1,
					branches: [],
				},
				{
					sha: SHA2,
					subject: "t",
					files: 1,
					plus: 1,
					minus: 0,
					patch: "+x",
					branches: [],
				},
			],
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("[patch truncated]");
		expect(msg).not.toContain("XXXXXXXXXX");
		expect(msg).not.toContain("BEGIN RSA");
		expect(msg).toContain("aaaa");
	});
	test("cleaned text below the drop zone emits nothing, marked truncated (OTTR-997)", () => {
		// 25 commits -> cap 16_000, raw cut at 65_152. Nine redacted blocks shrink
		// the cleaned text to 10 684 chars, below the 32 KiB drop zone: the whole
		// cleaned text is tail zone, so nothing is emitted and the truncation is
		// marked instead of silently dropping the patch.
		const block = (body: number) =>
			`-----BEGIN RSA PRIVATE KEY-----\n${"X".repeat(body)}\n-----END RSA PRIVATE KEY-----`;
		const patch1 = `${"a".repeat(5_000)}${block(6000).repeat(10)}${"b".repeat(500)}`;
		const r = range({
			commits: Array.from({ length: 25 }, (_, i) => ({
				sha: `${"c".repeat(38)}${String(i).padStart(2, "0")}`,
				subject: "s",
				files: 1,
				plus: 1,
				minus: 0,
				patch: i === 0 ? patch1 : "+x",
				branches: [],
			})),
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("COMMITS");
		expect(msg).toContain("[patch truncated]");
		expect(msg).not.toContain("XXXXXXXXXX");
		expect(msg).not.toContain("BEGIN RSA");
	});
	test("a benign cut patch in a small-cap range keeps its cap (OTTR-997)", () => {
		// 25 commits -> cap 16_000, raw cut at 65_152. The patch holds no secret,
		// so the emitted text must reach the cap, carry the truncation marker,
		// and stop before a marker placed past the cap.
		const patch1 = `${"a".repeat(20_000)}ZZENDZZ${"a".repeat(46_000)}`;
		const r = range({
			commits: Array.from({ length: 25 }, (_, i) => ({
				sha: `${"c".repeat(38)}${String(i).padStart(2, "0")}`,
				subject: "s",
				files: 1,
				plus: 1,
				minus: 0,
				patch: i === 0 ? patch1 : "+x",
				branches: [],
			})),
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("a".repeat(100));
		expect(msg).toContain("[patch truncated]");
		expect(msg).not.toContain("ZZENDZZ");
	});
	test("a cut PEM on a small-cap range never emits its body (OTTR-997)", () => {
		// 25 commits -> cap 16_000, raw cut at 65_152 lands inside the body; the
		// emitted cap region ends long before the body starts.
		const patch1 =
			`${"a".repeat(60_000)}-----BEGIN RSA PRIVATE KEY-----\n` +
			`${"X".repeat(6000)}\n-----END RSA PRIVATE KEY-----${"b".repeat(5_000)}`;
		const r = range({
			commits: Array.from({ length: 25 }, (_, i) => ({
				sha: `${"c".repeat(38)}${String(i).padStart(2, "0")}`,
				subject: "s",
				files: 1,
				plus: 1,
				minus: 0,
				patch: i === 0 ? patch1 : "+x",
				branches: [],
			})),
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("[patch truncated]");
		expect(msg).not.toContain("XXXXXXXXXX");
		expect(msg).not.toContain("BEGIN RSA");
	});
	test("truncates a huge patch in budget instead of stalling (OTTR-997)", () => {
		// Before the fix this input cleaned the whole 1 MB patch for 81 s and
		// then threw; now the pre-cut and the tail drop bound it into budget.
		// Two commits -> cap 200_000, raw cut at 249_152, no shrinkage: the kept
		// text reaches the cap and the marker past it is dropped.
		const patch1 = `${"eyJ".repeat(83_333)}ZZENDZZ${"eyJ".repeat(16_666)}`;
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch: patch1,
					branches: [],
				},
				{
					sha: SHA2,
					subject: "t",
					files: 1,
					plus: 1,
					minus: 0,
					patch: "+x",
					branches: [],
				},
			],
			merges: [],
		});
		const t0 = performance.now();
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(performance.now() - t0).toBeLessThan(1000);
		expect(msg.length).toBeLessThan(PROMPT_CHAR_BUDGET);
		expect(msg).toContain("[patch truncated]");
		// The tail zone dropped at the raw cut removes the marker with it.
		expect(msg).not.toContain("ZZENDZZ");
		expect(msg).toContain("COMMITS");
	});
	test("throws RangeError when non-patch sections bust the budget", () => {
		const r = range({ upstreamDocs: "y".repeat(500_000) });
		expect(() => buildUserMessage(r, { titles: [], declines: [] })).toThrow(
			RangeError,
		);
		expect(() => buildUserMessage(r, { titles: [], declines: [] })).toThrow(
			/range exceeds prompt budget/,
		);
	});
	test("caps a single oversize commit to the budget instead of throwing", () => {
		const patch = `${"x".repeat(600_000)}OVERSIZE-TAIL`;
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch,
					branches: [],
				},
			],
			merges: [],
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		// Both bounds bite: cleanBlocks precaps the patch and capPatches trims the
		// rest to the room left by the other blocks — the note conveys the cut.
		expect(msg).toContain("patches truncated to");
		expect(msg).not.toContain("OVERSIZE-TAIL");
		expect(msg).toContain("[COMMIT 1]");
	});
	test("leaves room for the other blocks when capping patches", () => {
		const r = range({
			commits: [
				{
					sha: SHA1,
					subject: "s",
					files: 1,
					plus: 1,
					minus: 0,
					patch: "x".repeat(600_000),
					branches: [],
				},
			],
			merges: [],
			upstreamDocs: "y".repeat(20_000),
		});
		const msg = buildUserMessage(r, { titles: [], declines: [] });
		expect(msg).toContain("patches truncated to");
		expect(msg).toContain("UPSTREAM_DOCS");
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
				fallbacks: {},
				spawn: async (_argv, o) => {
					model = JSON.parse(o.stdin).body.model;
					return { code: 1, stdout: "", stderr: "stop" };
				},
			},
		).catch(() => {});
		expect(model).toBe("@default");
	});
	test("analyzeRange walks the default role's chain past a provider error", async () => {
		const attempts: string[] = [];
		const reply = JSON.stringify({
			commits: [SHA1],
			coverage: "n",
			features: [],
			proposals: [],
		});
		const out = await analyzeRange(
			range(),
			{ titles: [], declines: [] },
			{
				fallbacks: { default: ["c/d"] },
				spawn: async (_argv, o) => {
					const model = JSON.parse(o.stdin).body.model as string;
					attempts.push(model);
					if (model === "@default")
						return {
							code: 1,
							stdout: "",
							stderr: "gateway status 502: Codex is at capacity",
						};
					return {
						code: 0,
						stdout: [
							JSON.stringify({ ready: true }),
							JSON.stringify({
								id: 1,
								status: 200,
								body: { choices: [{ message: { content: reply } }] },
							}),
						].join("\n"),
						stderr: "",
					};
				},
			},
		);
		expect(attempts).toEqual(["@default", "c/d"]);
		expect(out.commits).toHaveLength(1);
	});
	test("analyzeRange reads the chain from the board config when deps omit fallbacks", async () => {
		// The fork watcher's production shape: createForkWatcher (src/forks.ts) calls
		// analyzeRange(range, prior) with no deps, so the chain must come from the
		// board's config read (modelFallbacks()), pinned here like models.test.ts.
		const pinned = join(tmpdir(), `ottr-forkchain-pin-${process.pid}`);
		mkdirSync(pinned, { recursive: true });
		writeFileSync(
			join(pinned, "config.yml"),
			"retry:\n  fallbackChains:\n    default:\n      - cfg/m\n",
		);
		const savedBoard = process.env.OTTR_BOARD_OMP_HOME;
		const savedPin = process.env.PI_CODING_AGENT_DIR;
		const home = join(pinned, "home");
		mkdirSync(home, { recursive: true });
		process.env.OTTR_BOARD_OMP_HOME = home;
		process.env.PI_CODING_AGENT_DIR = pinned;
		const attempts: string[] = [];
		const reply = JSON.stringify({
			commits: [SHA1],
			coverage: "n",
			features: [],
			proposals: [],
		});
		try {
			await analyzeRange(
				range(),
				{ titles: [], declines: [] },
				{
					spawn: async (_argv, o) => {
						const model = JSON.parse(o.stdin).body.model as string;
						attempts.push(model);
						if (model === "@default")
							return {
								code: 1,
								stdout: "",
								stderr: "gateway status 502: Codex is at capacity",
							};
						return {
							code: 0,
							stdout: [
								JSON.stringify({ ready: true }),
								JSON.stringify({
									id: 1,
									status: 200,
									body: { choices: [{ message: { content: reply } }] },
								}),
							].join("\n"),
							stderr: "",
						};
					},
				},
			);
		} finally {
			if (savedBoard === undefined) delete process.env.OTTR_BOARD_OMP_HOME;
			else process.env.OTTR_BOARD_OMP_HOME = savedBoard;
			if (savedPin === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedPin;
		}
		expect(attempts).toEqual(["@default", "cfg/m"]);
		rmSync(pinned, { recursive: true, force: true });
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

describe("isProviderError", () => {
	const cases: Array<[string, boolean]> = [
		["gateway status 502: bad upstream", true],
		["gateway status 429: too many requests", true],
		["gateway status 500: internal error", true],
		["gateway status 404: not found", false],
		["gateway exited with code 1", false],
		["gateway did not report ready", false],
		["gateway status 502: Codex is at capacity", true],
		["rate limit exceeded", true],
	];
	for (const [message, expected] of cases) {
		test(`${expected ? "covers" : "rejects"} ${JSON.stringify(message)}`, () => {
			expect(isProviderError(new Error(message))).toBe(expected);
		});
	}
});

describe("runGatewayWithFallbacks", () => {
	const spawnFor = (
		fail: (model: string) => string | null,
		reply = "answer",
	): { spawn: SpawnFn; attempts: string[] } => {
		const attempts: string[] = [];
		return {
			attempts,
			spawn: async (_argv, o) => {
				const model = JSON.parse(o.stdin).body.model as string;
				attempts.push(model);
				const err = fail(model);
				if (err !== null) return { code: 1, stdout: "", stderr: err };
				return {
					code: 0,
					stdout: [
						JSON.stringify({ ready: true }),
						JSON.stringify({
							id: 1,
							status: 200,
							body: { choices: [{ message: { content: reply } }] },
						}),
					].join("\n"),
					stderr: "",
				};
			},
		};
	};

	test("walks the chain past a provider error to the first success", async () => {
		const { spawn, attempts } = spawnFor((m) =>
			m === "a/b"
				? "gateway exited with code 1: gateway status 502: Codex is at capacity"
				: null,
		);
		const out = await runGatewayWithFallbacks(
			[{ role: "user", content: "hi" }],
			"a/b",
			["c/d"],
			spawn,
		);
		expect(out).toBe("answer");
		expect(attempts).toEqual(["a/b", "c/d"]);
	});

	test("a non-provider error on the first attempt does not try the chain", async () => {
		const { spawn, attempts } = spawnFor(
			() => "gateway exited with code 1: stop",
		);
		const out = runGatewayWithFallbacks(
			[{ role: "user", content: "hi" }],
			"a/b",
			["c/d"],
			spawn,
		);
		expect(out).rejects.toThrow("gateway exited with code 1: stop");
		await out.catch(() => {});
		expect(attempts).toEqual(["a/b"]);
	});

	test("an exhausted chain rethrows the last provider error", async () => {
		const { spawn, attempts } = spawnFor(
			() => "gateway exited with code 1: gateway status 429: rate limit",
		);
		const out = runGatewayWithFallbacks(
			[{ role: "user", content: "hi" }],
			"a/b",
			["c/d", "e/f"],
			spawn,
		);
		expect(out).rejects.toThrow("gateway status 429: rate limit");
		await out.catch(() => {});
		expect(attempts).toEqual(["a/b", "c/d", "e/f"]);
	});
});

describe("parseAnalysis", () => {
	test("accepts a valid sample and strips a json fence", () => {
		const fenced = `\`\`\`json\n${JSON.stringify(VALID_RESULT)}\n\`\`\``;
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

describe("commit links follow the configured host", () => {
	test("renders acme.ghe.com links when OTTR_GITHUB_HOST is set", () => {
		const saved = process.env.OTTR_GITHUB_HOST;
		try {
			process.env.OTTR_GITHUB_HOST = "acme.ghe.com";
			const hostReport = renderReport(range(), VALID_RESULT);
			expect(hostReport).toContain(
				`https://acme.ghe.com/octo/proj/commit/${SHA1}`,
			);
			expect(hostReport).not.toContain("https://github.com/octo/proj/commit/");
			const prompt = proposalPrompt("octo", "proj", {
				title: "Dark mode",
				goal: "g",
				comparison: "c",
				change: "h",
				checks: "k",
				risk: "r",
				effort: "M",
				commits: [SHA1],
			});
			expect(prompt).toContain(`https://acme.ghe.com/octo/proj/commit/${SHA1}`);
		} finally {
			if (saved === undefined) delete process.env.OTTR_GITHUB_HOST;
			else process.env.OTTR_GITHUB_HOST = saved;
		}
	});
});

describe("proposalPrompt", () => {
	test("includes the fixed sections, the rebuild steps and stays under the cap with 2000-char fields", () => {
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
		expect(prompt).toContain("never run it, never copy it verbatim");
		expect(prompt).toContain("State the problem this fork solves");
		expect(prompt).toContain("Review the fork's approach");
		expect(prompt).toContain("Re-create what the fork lacks");
		expect(prompt).toContain("what you took from the fork");
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
		expect(s).toContain("Never prescribe porting");
	});
});

// The fork analysis spawn and every gateway run ride this function: a real child
// process must land in the directory the caller passed, not the board's own.
describe("defaultSpawn cwd", () => {
	test("the spawned process runs in the given cwd", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-spawn-cwd-"));
		const res = await defaultSpawn(
			["bun", "-e", "process.stdout.write(process.cwd())"],
			{ stdin: "", env: process.env, timeoutMs: 30_000, cwd: dir },
		);
		expect(res.code).toBe(0);
		expect(resolve(res.stdout.trim())).toBe(resolve(dir));
	});

	test("no cwd leaves the child in the caller's working directory", async () => {
		const res = await defaultSpawn(
			["bun", "-e", "process.stdout.write(process.cwd())"],
			{ stdin: "", env: process.env, timeoutMs: 30_000 },
		);
		expect(res.code).toBe(0);
		expect(resolve(res.stdout.trim())).toBe(resolve(process.cwd()));
	});
});

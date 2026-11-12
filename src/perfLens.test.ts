import { describe, expect, test } from "bun:test";
import {
	changedDiffPaths,
	perfFindings,
	perfLensTriggered,
	renderPerfCandidates,
} from "./perfLens.ts";
import fc from "./test/properties.ts";

/** Sample 1 of the spec: one quadratic candidate on the `.includes` line. */
const QUAD_DIFF = [
	"diff --git a/src/db/users.ts b/src/db/users.ts",
	"--- a/src/db/users.ts",
	"+++ b/src/db/users.ts",
	"@@ -10,6 +10,11 @@",
	" const ranked: string[] = [];",
	"+for (const user of users) {",
	"+  if (ids.includes(user.id)) {",
	"+    ranked.push(user.name);",
	"+  }",
	"+}",
].join("\n");

/** Sample 2 of the spec: one n+1 candidate on the db.query line. Its path matches no
 * glob, so the test arms the lens with the `perf` label. */
const N_PLUS_ONE_DIFF = [
	"diff --git a/src/repo/orders.ts b/src/repo/orders.ts",
	"--- a/src/repo/orders.ts",
	"+++ b/src/repo/orders.ts",
	"@@ -3,7 +3,8 @@",
	" export async function totals(ids: number[]) {",
	"+  let total = 0;",
	"+  for (const id of ids) {",
	'+    const row = await db.query("SELECT total FROM orders WHERE id = ?", [id]);',
	"+    total += row.total;",
	"+  }",
	"+  return total;",
	" }",
].join("\n");

/** Sample 3 of the spec: a triggered diff whose changes are clean. */
const CLEAN_DIFF = [
	"diff --git a/src/db/config.ts b/src/db/config.ts",
	"--- a/src/db/config.ts",
	"+++ b/src/db/config.ts",
	"@@ -1,3 +1,4 @@",
	" // Database defaults.",
	"-MAX_RETRIES = 3",
	"+MAX_RETRIES = 5",
	"+// The ops runbook doubles this over call-out weekends.",
	"+export const POOL_SIZE = MAX_RETRIES * 4;",
].join("\n");

describe("perfLensTriggered", () => {
	test("triggers on a changed db path", () => {
		expect(perfLensTriggered(["src/db/users.ts"], [])).toBe(true);
		expect(perfLensTriggered(["src/db/config.ts"], [])).toBe(true);
	});

	test("triggers on a changed repository path", () => {
		expect(perfLensTriggered(["repo.ts"], [])).toBe(true);
		expect(perfLensTriggered(["src/repo.ts"], [])).toBe(true);
		// Glob matching is case-insensitive, so camelCase repository file names arm too.
		expect(perfLensTriggered(["src/userRepo.ts"], [])).toBe(true);
		expect(perfLensTriggered(["src/DB/orders.ts"], [])).toBe(true);
	});

	test("triggers on the exact perf label only", () => {
		expect(perfLensTriggered(["docs/readme.md"], ["perf"])).toBe(true);
		expect(perfLensTriggered(["docs/readme.md"], ["Perf", "perf-lint"])).toBe(
			false,
		);
	});

	test("does not trigger on other paths without the label", () => {
		expect(perfLensTriggered([], [])).toBe(false);
		expect(perfLensTriggered(["src/prs.ts", "docs/spec.md"], [])).toBe(false);
		expect(perfLensTriggered(["src/db.ts"], [])).toBe(false);
	});
});

describe("changedDiffPaths", () => {
	test("collects unique +++ b/ paths and skips /dev/null", () => {
		const diff = [
			"diff --git a/gone b/gone",
			"--- a/gone",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-gone();",
			"+++ b/kept.ts",
			"@@ -0,0 +1,2 @@",
			"+kept();",
			"+++ b/kept.ts",
			"+++ b/dev/null",
		].join("\n");
		expect(changedDiffPaths(diff)).toEqual(["kept.ts", "dev/null"]);
	});

	test("tolerates an empty or malformed diff", () => {
		expect(changedDiffPaths("")).toEqual([]);
		expect(changedDiffPaths("not a diff\nrandom text\n+++")).toEqual([]);
		expect(changedDiffPaths("+++ b/")).toEqual([]);
	});
});

describe("perfFindings", () => {
	test("sample 1: exactly one quadratic candidate on the .includes line", () => {
		expect(perfFindings(QUAD_DIFF, [])).toEqual([
			{
				kind: "quadratic",
				path: "src/db/users.ts",
				line: 12,
				snippet: "if (ids.includes(user.id)) {",
			},
		]);
	});

	test("sample 2: exactly one n+1 candidate on the db.query line", () => {
		expect(perfFindings(N_PLUS_ONE_DIFF, ["perf"])).toEqual([
			{
				kind: "n+1",
				path: "src/repo/orders.ts",
				line: 6,
				snippet:
					'const row = await db.query("SELECT total FROM orders WHERE id = ?", [id]);',
			},
		]);
	});

	test("sample 3: a triggered but clean diff finds nothing", () => {
		expect(perfFindings(CLEAN_DIFF, [])).toEqual([]);
	});

	test("an untriggered diff returns no findings without a scan", () => {
		// The n+1 diff's path matches no glob and no label arms the lens.
		expect(perfFindings(N_PLUS_ONE_DIFF, [])).toEqual([]);
		const docDiff = N_PLUS_ONE_DIFF.replaceAll(
			"src/repo/orders.ts",
			"docs/orders.md",
		);
		expect(perfFindings(docDiff, ["bug", "enhancement"])).toEqual([]);
	});

	test("a query or scan outside any loop is not a candidate", () => {
		const diff = [
			"+++ b/src/db/a.ts",
			"@@ -1,2 +1,3 @@",
			" a();",
			"+db.query(q);",
			"+xs.includes(x);",
			"+while (ready) {",
			"+  work();",
			"+}",
		].join("\n");
		expect(perfFindings(diff, [])).toEqual([]);
	});

	test("deleted and context lines never match", () => {
		const diff = [
			"diff --git a/src/db/a.ts b/src/db/a.ts",
			"--- a/src/db/a.ts",
			"+++ b/src/db/a.ts",
			"@@ -1,6 +1,5 @@",
			" for (const x of xs) {",
			"-  db.query(q);",
			"-  ids.includes(x);",
			"   log(x);",
			"+  log(x);",
			" }",
		].join("\n");
		expect(perfFindings(diff, [])).toEqual([]);
	});

	test("deleted lines do not advance the new-file line counter", () => {
		const diff = [
			"+++ b/src/db/a.ts",
			"@@ -1,5 +1,5 @@",
			" a();",
			"-b();",
			"+b2();",
			"-c();",
			"+for (const x of xs) {",
			"+  db.query(q);",
			"+}",
		].join("\n");
		expect(perfFindings(diff, [])).toEqual([
			{ kind: "n+1", path: "src/db/a.ts", line: 4, snippet: "db.query(q);" },
		]);
	});

	test("comment lines never match and never close a loop", () => {
		const diff = [
			"+++ b/src/db/a.ts",
			"@@ -1,7 +1,9 @@",
			"+// db.query(q); SELECT * FROM t",
			"+# SELECT nothing",
			"+/* db.query(q); */",
			"+ * .includes(x) in the doc block",
			"+<!-- .filter( ids ) -->",
			"+for (const x of xs) {",
			"+  // db.query(q);",
			"+}",
			"+db.query(q);",
		].join("\n");
		// The dedent of `db.query(q);` after the loop closes it: no candidate at all.
		expect(perfFindings(diff, [])).toEqual([]);
	});

	test("a line at the loop's indent or less closes the loop", () => {
		const diff = [
			"+++ b/src/db/a.ts",
			"@@",
			"+for (const x of xs) {",
			"+  work(x);",
			"+}",
			"+db.query(q);",
			"+while (ready) {",
			"+  db.query(q);",
			"+}",
		].join("\n");
		// Only the query inside the second loop is a candidate.
		expect(perfFindings(diff, [])).toEqual([
			{ kind: "n+1", path: "src/db/a.ts", line: 7, snippet: "db.query(q);" },
		]);
	});

	test("a loop opened inside a loop is a quadratic candidate", () => {
		const diff = [
			"+++ b/src/db/a.ts",
			"@@ -1 +1,5 @@",
			"+for (const x of xs) {",
			"+  for (const y of ys) {",
			"+    work(x, y);",
			"+  }",
			"+}",
		].join("\n");
		expect(perfFindings(diff, [])).toEqual([
			{
				kind: "quadratic",
				path: "src/db/a.ts",
				line: 2,
				snippet: "for (const y of ys) {",
			},
		]);
	});

	test("each hunk restarts the new-file line counter", () => {
		const diff = [
			"+++ b/src/db/a.ts",
			"@@ -1,2 +1,4 @@",
			" a();",
			"+for (const x of xs) {",
			"+  db.query(q);",
			"+}",
			"@@ -40,2 +42,3 @@",
			" b();",
			"+db.query(q);",
		].join("\n");
		// The second hunk's query sits outside any loop: only the first one counts.
		expect(perfFindings(diff, [])).toEqual([
			{ kind: "n+1", path: "src/db/a.ts", line: 3, snippet: "db.query(q);" },
		]);
	});

	test("a db receiver's method call and each query needle inside a loop match", () => {
		const body = [
			"const a = store.load(id);",
			"const b = conn.prepare(sql);",
			"const c = tx.execute(q);",
			"const d = trx.raw(sql);",
			"const e = prisma.findMany(w);",
			"const f = knex.findOne(w);",
			"const g = drizzle.fetchAll(w);",
			"const h = sql.batch(w);",
			'db.run("UPDATE t SET x = 1");',
			"repo.insert(row);",
		];
		const diff = [
			"+++ b/src/db/a.ts",
			"@@ -1 +1,31 @@",
			"+for (const x of xs) {",
			...body.map((l) => `+  ${l}`),
			"+}",
		].join("\n");
		const findings = perfFindings(diff, []);
		expect(findings).toHaveLength(body.length);
		expect(findings.every((f) => f.kind === "n+1")).toBe(true);
	});

	test("snippets are trimmed and capped at 120 characters", () => {
		const long = `db.query("${"x".repeat(200)}");`;
		const diff = [
			"+++ b/src/db/a.ts",
			"@@ -1 +1,3 @@",
			"+for (const x of xs) {",
			`+   ${long}  `,
			"+}",
		].join("\n");
		const findings = perfFindings(diff, []);
		expect(findings[0]!.snippet).toBe(long.slice(0, 120));
		expect(findings[0]!.snippet).toHaveLength(120);
	});

	test("the scan stops at 20 findings", () => {
		const lines = ["+++ b/src/db/a.ts", "@@ -1 +1,91 @@"];
		for (let i = 0; i < 30; i++) {
			lines.push("+for (const x of xs) {");
			lines.push("+  db.query(q);");
			lines.push("+}");
		}
		const findings = perfFindings(lines.join("\n"), []);
		expect(findings).toHaveLength(20);
		expect(findings.every((f) => f.kind === "n+1")).toBe(true);
	});

	test("deleted files and malformed diffs are tolerated", () => {
		expect(perfFindings("+++ /dev/null\n@@ -1 +0,0 @@\n-gone();", [])).toEqual(
			[],
		);
		expect(perfFindings("not a diff at all\nrandom text\n+++", [])).toEqual([]);
		expect(perfFindings("", [])).toEqual([]);
		expect(
			perfFindings(
				[
					"+++ b/x",
					"@@ bogus @@",
					"+for (const q of qs) {",
					"+  db.query(q);",
					"+}",
				].join("\n"),
				["perf"],
			),
		).toEqual([{ kind: "n+1", path: "x", line: 3, snippet: "db.query(q);" }]);
	});

	test("any string is tolerated: the scan never throws and stays capped", () => {
		const piece = fc.constantFrom(
			"diff --git a/f b/f",
			"+++ b/f",
			"+++ /dev/null",
			"@@ -1,1 +1,2 @@",
			"@@",
			"+for (const x of xs) {",
			"+}",
			"+  db.query(q);",
			"-  db.query(q);",
			"   ids.includes(x);",
			"// db.query(q);",
			"",
			"x",
		);
		const text = fc.array(piece, { maxLength: 60 }).map((a) => a.join("\n"));
		fc.assert(
			fc.property(text, (s) => {
				const findings = perfFindings(s, ["perf"]);
				expect(findings.length).toBeLessThanOrEqual(20);
				for (const f of findings) {
					expect(f.path).not.toBe("/dev/null");
					expect(f.snippet.length).toBeLessThanOrEqual(120);
				}
				const paths = changedDiffPaths(s);
				expect(new Set(paths).size).toBe(paths.length);
			}),
		);
	});
});

describe("renderPerfCandidates", () => {
	test("renders one line per finding in the diff's order", () => {
		expect(
			renderPerfCandidates([
				{ kind: "n+1", path: "src/db/a.ts", line: 12, snippet: "db.query(q);" },
				{
					kind: "quadratic",
					path: "src/db/b.ts",
					line: 3,
					snippet: "ids.includes(x);",
				},
			]),
		).toBe(
			"- src/db/a.ts:12 n+1: db.query(q);\n- src/db/b.ts:3 quadratic: ids.includes(x);",
		);
		expect(renderPerfCandidates([])).toBe("");
	});

	test("when the cap cut findings, a final line says how many were omitted", () => {
		const many = Array.from({ length: 25 }, (_, i) => ({
			kind: "n+1" as const,
			path: "src/db/a.ts",
			line: i + 1,
			snippet: "db.query(q);",
		}));
		const lines = renderPerfCandidates(many).split("\n");
		expect(lines).toHaveLength(21);
		expect(lines[19]).toBe("- src/db/a.ts:20 n+1: db.query(q);");
		expect(lines.at(-1)).toBe("5 more candidate(s) omitted");
	});
});

import { describe, expect, test } from "bun:test";
import type { GhFn } from "./forks.ts";
import { cleanText, githubAlertSummary } from "./githubAlerts.ts";

/** Fake gh: answers API paths from a map; records every call. */
function fakeGh(routes: Record<string, string | Error>): {
	gh: GhFn;
	calls: string[];
} {
	const calls: string[] = [];
	const gh: GhFn = async (args) => {
		calls.push(args.join(" "));
		const key = args[1] ?? "";
		const route = routes[key];
		if (route instanceof Error) throw route;
		if (route === undefined)
			return { code: 1, stdout: "", stderr: "not found" };
		if (route.startsWith("ERR:")) {
			return { code: 1, stdout: "", stderr: route.slice(4) };
		}
		return { code: 0, stdout: route, stderr: "" };
	};
	return { gh, calls };
}

const dep = (n: number, sev = "high") => ({
	number: n,
	html_url: `https://github.com/acme/widget/security/dependabot/${n}`,
	security_advisory: { severity: sev, summary: `advisory ${n}` },
	security_vulnerability: { vulnerable_version_range: "< 2.0" },
	dependency: { package: { name: `pkg-${n}` } },
});

const code = (n: number, sev = "medium") => ({
	number: n,
	html_url: `https://github.com/acme/widget/security/code-scanning/${n}`,
	rule: { id: `rule-${n}`, security_severity_level: sev },
});

const secret = (n: number, extra: Record<string, unknown> = {}) => ({
	number: n,
	html_url: `https://github.com/acme/widget/security/secret-scanning/${n}`,
	secret_type_display_name: "GitHub Personal Access Token",
	secret_type: "github_personal_access_token",
	validity: "active",
	...extra,
});

const baseRoutes = (overrides: Record<string, string | Error> = {}) => ({
	"repos/acme/widget/dependabot/alerts?state=open&per_page=100&page=1":
		JSON.stringify([dep(1, "critical"), dep(2, "low"), dep(3, "critical")]),
	"repos/acme/widget/code-scanning/alerts?state=open&per_page=100&page=1":
		JSON.stringify([code(1, "high"), code(2, "high"), code(3, "low")]),
	"repos/acme/widget/secret-scanning/alerts?state=open&per_page=100&page=1":
		JSON.stringify([secret(1), secret(2, { validity: "" })]),
	...overrides,
});

describe("githubAlertSummary", () => {
	test("happy path: counts, ordering, URLs, zero category", async () => {
		const { gh, calls } = fakeGh(
			baseRoutes({
				"repos/acme/widget/code-scanning/alerts?state=open&per_page=100&page=1":
					"[]",
			}),
		);
		const s = await githubAlertSummary({ repo: "acme/widget", gh, top: 2 });
		const lines = s.split("\n");
		expect(lines[0]).toBe("GitHub security alerts for acme/widget: 5 open.");
		expect(lines[1]).toBe("- Dependabot: 3 open (2 critical, 1 low)");
		expect(lines[2]).toBe(
			"  - pkg-1 < 2.0 (critical) https://github.com/acme/widget/security/dependabot/1",
		);
		expect(lines[3]).toBe(
			"  - pkg-3 < 2.0 (critical) https://github.com/acme/widget/security/dependabot/3",
		);
		expect(lines[4]).toBe("- Code scanning: 0 open");
		expect(lines[5]).toBe("- Secret scanning: 2 open");
		expect(lines).toHaveLength(8);
		expect(lines.at(-1)).toBe(
			"  - GitHub Personal Access Token https://github.com/acme/widget/security/secret-scanning/2",
		);
		expect(s).toContain("GitHub Personal Access Token (active)");
		// second secret has empty validity: no parens
		expect(s.match(/\(active\)/g)).toHaveLength(1);
		expect(calls).toHaveLength(3);
		// The real REST endpoints, hyphen-free: repos/<owner>/<repo>/<kind>/alerts.
		expect([...calls].sort()).toEqual(
			[
				"api repos/acme/widget/code-scanning/alerts?state=open&per_page=100&page=1",
				"api repos/acme/widget/dependabot/alerts?state=open&per_page=100&page=1",
				"api repos/acme/widget/secret-scanning/alerts?state=open&per_page=100&page=1",
			].sort(),
		);
	});

	test("dependabot endpoint fails -> unavailable with sanitized reason", async () => {
		const { gh } = fakeGh(
			baseRoutes({
				"repos/acme/widget/dependabot/alerts?state=open&per_page=100&page=1":
					"ERR:gh: Forbidden (HTTP 403)\nsecond line",
			}),
		);
		const s = await githubAlertSummary({ repo: "acme/widget", gh });
		expect(s.startsWith("alerts unavailable: ")).toBe(true);
		expect(s).toContain("403");
		expect(s).not.toContain("open (");
	});

	test("gh runner throws -> unavailable with the error message", async () => {
		const { gh } = fakeGh(
			baseRoutes({
				"repos/acme/widget/secret-scanning/alerts?state=open&per_page=100&page=1":
					new Error("gh binary missing"),
			}),
		);
		const s = await githubAlertSummary({ repo: "acme/widget", gh });
		expect(s).toBe("alerts unavailable: gh binary missing");
	});

	test("secret values never leak into the summary", async () => {
		const { gh } = fakeGh(
			baseRoutes({
				"repos/acme/widget/secret-scanning/alerts?state=open&per_page=100&page=1":
					JSON.stringify([secret(1, { secret: "ghp_SUPERSECRETVALUE123" })]),
			}),
		);
		const s = await githubAlertSummary({ repo: "acme/widget", gh });
		expect(s).toContain("GitHub Personal Access Token");
		expect(s).not.toContain("ghp_SUPERSECRETVALUE123");
	});

	test("non-JSON stdout -> parse reason naming the endpoint", async () => {
		const { gh } = fakeGh(
			baseRoutes({
				"repos/acme/widget/code-scanning/alerts?state=open&per_page=100&page=1":
					"not json",
			}),
		);
		const s = await githubAlertSummary({ repo: "acme/widget", gh });
		expect(s).toBe(
			"alerts unavailable: could not parse the code scanning response",
		);
	});

	test("repo normalization and null repo", async () => {
		const { gh, calls } = fakeGh(baseRoutes());
		const s = await githubAlertSummary({
			repo: "https://github.com/acme/widget.git",
			gh,
		});
		expect(s).toContain("GitHub security alerts for acme/widget:");
		expect(calls.some((c) => c.includes("repos/acme/widget/"))).toBe(true);
		expect(await githubAlertSummary({ repo: null, gh })).toBe(
			"alerts unavailable: project has no GitHub remote",
		);
		const { gh: gh2 } = fakeGh({});
		expect(await githubAlertSummary({ repo: "https://", gh: gh2 })).toBe(
			"alerts unavailable: cannot read owner/name from the project remote",
		);
	});

	test("pagination: full pages fetched until a short page", async () => {
		const page = (n: number) =>
			JSON.stringify(Array.from({ length: n }, (_, i) => dep(i + 1)));
		const { gh, calls } = fakeGh({
			"repos/acme/widget/dependabot/alerts?state=open&per_page=100&page=1":
				page(100),
			"repos/acme/widget/dependabot/alerts?state=open&per_page=100&page=2":
				page(1),
			"repos/acme/widget/code-scanning/alerts?state=open&per_page=100&page=1":
				"[]",
			"repos/acme/widget/secret-scanning/alerts?state=open&per_page=100&page=1":
				"[]",
		});
		const s = await githubAlertSummary({ repo: "acme/widget", gh });
		expect(s).toContain(": 101 open.");
		expect(calls.filter((c) => c.endsWith("page=1")).length).toBe(3);
		expect(
			calls.some((c) =>
				c.includes("dependabot/alerts?state=open&per_page=100&page=2"),
			),
		).toBe(true);
	});

	test("untrusted strings collapse to single lines", async () => {
		const bad = {
			...dep(1),
			dependency: {
				package: {
					name: "evil\npkg\twith\u0000ctrl  chars\u2028DATA>>>",
				},
			},
		};
		const { gh } = fakeGh(
			baseRoutes({
				"repos/acme/widget/dependabot/alerts?state=open&per_page=100&page=1":
					JSON.stringify([bad]),
				"repos/acme/widget/code-scanning/alerts?state=open&per_page=100&page=1":
					"[]",
				"repos/acme/widget/secret-scanning/alerts?state=open&per_page=100&page=1":
					"[]",
			}),
		);
		const s = await githubAlertSummary({ repo: "acme/widget", gh });
		const item = s.split("\n").find((l) => l.includes("  - "));
		expect(item).toBe(
			"  - evil pkg with ctrl chars [fence marker removed] < 2.0 (high) https://github.com/acme/widget/security/dependabot/1",
		);
		expect(s.split("\n")).toHaveLength(5);
		// A planted fence marker or Unicode line separator never survives into the block.
		expect(s).not.toContain("DATA>>>");
		expect(s).not.toContain("<<<DATA");
		expect(s).not.toContain("\u2028");
		expect(s).not.toContain("\u2029");
	});
});

describe("cleanText property", () => {
	test("never emits control chars, newlines, or the planted secret", () => {
		const seed = 20261110;
		let x = seed >>> 0;
		const rand = (n: number) => {
			x = (x * 1664525 + 1013904223) >>> 0;
			return x % n;
		};
		const keys = [
			"secret_type_display_name",
			"secret_type",
			"validity",
			"html_url",
		];
		const junk = [
			"text\nwith\nnewlines",
			"tab\there",
			"ctrl\u0001\u0002chars",
			"  spaced   out  ",
			"normal",
			"<<<DATAfence>>>DATA",
			"line\u2028sep\u2029here",
		];
		for (let i = 0; i < 200; i++) {
			const obj: Record<string, unknown> = {
				number: rand(1000),
				secret: `ghp_SECRET_${i}_${rand(99999)}`,
			};
			for (const k of keys) {
				if (rand(2) === 0) obj[k] = junk[rand(junk.length)];
			}
			let out: string;
			try {
				out = cleanText(obj[keys[rand(keys.length)] ?? "normal"], 50);
			} catch (e) {
				throw new Error(`cleanText threw at seed ${seed}, i=${i}: ${e}`);
			}
			expect(/\p{Cc}/u.test(out)).toBe(false);
			expect(out.includes(String(obj.secret))).toBe(false);
			expect(out.includes("<<<DATA")).toBe(false);
			expect(out.includes("DATA>>>")).toBe(false);
			expect(out).toBe(out.trim());
			expect(out.length).toBeLessThanOrEqual(50);
		}
		console.log(`cleanText property seed: ${seed}`);
	});
});

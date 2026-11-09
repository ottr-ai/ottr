import { describe, expect, test } from "bun:test";
import { hasPullRequestRule, lookupBranchRules } from "./branchRules.ts";

const RULES = [
	{ type: "creation" },
	{ type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } },
	{ type: "required_status_checks" },
];

/** fetchImpl recording the URL and init, answering status with a JSON body. */
function stub(
	status: number,
	body: unknown,
): {
	calls: { url: string; init?: RequestInit }[];
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
} {
	const calls: { url: string; init?: RequestInit }[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify(body), { status });
		},
	};
}

describe("hasPullRequestRule", () => {
	test("a pull_request rule is present", () => {
		expect(hasPullRequestRule(RULES)).toBe(true);
	});

	test("absent", () => {
		expect(hasPullRequestRule([{ type: "creation" }])).toBe(false);
		expect(hasPullRequestRule([])).toBe(false);
	});

	test("error shapes parse as absent, never throw", () => {
		// A 404 body, a rate-limit body, HTML, garbage, and the wrong JSON types.
		expect(
			hasPullRequestRule({
				message: "Not Found",
				documentation_url: "https://docs.github.com/x",
			}),
		).toBe(false);
		expect(hasPullRequestRule({ message: "API rate limit exceeded" })).toBe(
			false,
		);
		expect(hasPullRequestRule("<html></html>")).toBe(false);
		expect(hasPullRequestRule("unexpected end of JSON input")).toBe(false);
		expect(hasPullRequestRule(null)).toBe(false);
		expect(hasPullRequestRule(undefined)).toBe(false);
		expect(hasPullRequestRule(42)).toBe(false);
		expect(hasPullRequestRule([null, 7, "pull_request"])).toBe(false);
		expect(hasPullRequestRule([{ type: 5 }])).toBe(false);
		expect(hasPullRequestRule([{ rule: { type: "pull_request" } }])).toBe(
			false,
		);
	});
});

describe("lookupBranchRules", () => {
	const o = {
		apiBase: "https://api.github.com",
		owner: "acme",
		repo: "widget",
		branch: "main",
		token: "ghs_aaaa0000aaaa0000",
	};

	test("a pull_request rule reports true and sends the token", async () => {
		const s = stub(200, RULES);
		const r = await lookupBranchRules({ ...o, fetchImpl: s.fetch });
		expect(r).toEqual({ ok: true, pullRequest: true });
		expect(s.calls[0]!.url).toBe(
			"https://api.github.com/repos/acme/widget/rules/branches/main",
		);
		expect(s.calls[0]!.init?.headers).toEqual({
			Authorization: "Bearer ghs_aaaa0000aaaa0000",
			Accept: "application/vnd.github+json",
			"User-Agent": "ottr",
		});
	});

	test("rules without pull_request report false", async () => {
		const s = stub(200, [{ type: "creation" }]);
		const r = await lookupBranchRules({ ...o, fetchImpl: s.fetch });
		expect(r).toEqual({ ok: true, pullRequest: false });
	});

	test("a 404 reports no lookup, no throw", async () => {
		const s = stub(404, { message: "Not Found" });
		const r = await lookupBranchRules({ ...o, fetchImpl: s.fetch });
		expect(r).toEqual({ ok: false });
	});

	test("a transport throw reports no lookup, no throw", async () => {
		const r = await lookupBranchRules({
			...o,
			fetchImpl: () => Promise.reject(new Error("dns failure")),
		});
		expect(r).toEqual({ ok: false });
	});

	test("an unreadable body reports no lookup", async () => {
		const r = await lookupBranchRules({
			...o,
			fetchImpl: async () =>
				new Response("<html>gateway timeout</html>", { status: 200 }),
		});
		expect(r).toEqual({ ok: false });
	});

	test("a too-slow probe times out inside its ceiling", async () => {
		const r = await lookupBranchRules({
			...o,
			timeoutMs: 20,
			fetchImpl: (_url, init) => {
				const { promise, reject } = Promise.withResolvers<Response>();
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
				return promise;
			},
		});
		expect(r).toEqual({ ok: false });
	});
});

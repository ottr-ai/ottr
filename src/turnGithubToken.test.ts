import { describe, expect, test } from "bun:test";
import { checkTurnToken } from "./turnGithubToken.ts";

const API = "https://api.test";
const TOKEN = "tok-turn-read";

/** One recorded fetch call. */
type Call = { url: string; init?: RequestInit };

/** A stub fetch that records every call and answers from `respond`. */
function stubFetch(respond: (call: Call) => Response): {
	fetch: typeof fetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const call = { url: String(input), init };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return { fetch: f, calls };
}

/** One repos GET answer: status, optional JSON body and the classic-token scopes header. */
function repoRes(status: number, body?: unknown, scopes?: string): Response {
	const headers = new Headers();
	if (scopes !== undefined) headers.set("x-oauth-scopes", scopes);
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers,
	});
}

/** Answers by URL; a URL with no entry makes the stub throw. */
function byUrl(responses: Record<string, Response>): (call: Call) => Response {
	return ({ url }) => {
		const res = responses[url];
		if (!res) throw new Error(`unexpected fetch ${url}`);
		return res;
	};
}

describe("checkTurnToken", () => {
	test("one GET <apiBase>/repos/<owner>/<repo> with the pinned API headers", async () => {
		const { fetch, calls } = stubFetch(
			byUrl({
				[`${API}/repos/owner/repo`]: repoRes(200, {
					permissions: { push: false },
				}),
			}),
		);
		const r = await checkTurnToken({
			apiBase: API,
			token: TOKEN,
			repos: ["owner/repo"],
			fetch,
		});
		expect(calls).toEqual([
			{
				url: `${API}/repos/owner/repo`,
				init: {
					method: "GET",
					headers: {
						Authorization: `Bearer ${TOKEN}`,
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				},
			},
		]);
		expect(r.verdict).toBe("ok");
	});

	test("push false and no scopes header checks ok", async () => {
		const { fetch, calls } = stubFetch(
			byUrl({
				[`${API}/repos/o/r`]: repoRes(200, { permissions: { push: false } }),
			}),
		);
		const r = await checkTurnToken({
			apiBase: API,
			token: TOKEN,
			repos: ["o/r"],
			fetch,
		});
		expect(r.verdict).toBe("ok");
		expect(calls.length).toBe(1);
	});

	test("classic write scopes mark the token write-capable", async () => {
		for (const scopes of ["repo", "admin:org", "agents"]) {
			const { fetch } = stubFetch(
				byUrl({
					[`${API}/repos/o/r`]: repoRes(
						200,
						{ permissions: { push: false } },
						scopes,
					),
				}),
			);
			const r = await checkTurnToken({
				apiBase: API,
				token: TOKEN,
				repos: ["o/r"],
				fetch,
			});
			expect(r.verdict).toBe("write");
			expect(r.detail).toContain(scopes);
		}
	});

	test("read-only scopes keep the verdict ok", async () => {
		for (const scopes of [
			"read:org, user",
			"gist, notifications",
			"read:packages",
		]) {
			const { fetch } = stubFetch(
				byUrl({
					[`${API}/repos/o/r`]: repoRes(
						200,
						{ permissions: { push: false } },
						scopes,
					),
				}),
			);
			const r = await checkTurnToken({
				apiBase: API,
				token: TOKEN,
				repos: ["o/r"],
				fetch,
			});
			expect(r.verdict).toBe("ok");
		}
	});

	test("permissions.push true marks write and names the repo, never the token", async () => {
		const { fetch } = stubFetch(
			byUrl({
				[`${API}/repos/octo/infra`]: repoRes(200, {
					permissions: { push: true },
				}),
			}),
		);
		const r = await checkTurnToken({
			apiBase: API,
			token: TOKEN,
			repos: ["octo/infra"],
			fetch,
		});
		expect(r.verdict).toBe("write");
		expect(r.detail).toContain("octo/infra");
		expect(r.detail).not.toContain(TOKEN);
	});

	test("a repo the token cannot read (404) adds no signal", async () => {
		const { fetch, calls } = stubFetch(
			byUrl({
				[`${API}/repos/a/b`]: repoRes(404),
				[`${API}/repos/c/d`]: repoRes(200, { permissions: { push: false } }),
			}),
		);
		const r = await checkTurnToken({
			apiBase: API,
			token: TOKEN,
			repos: ["a/b", "c/d"],
			fetch,
		});
		expect(r.verdict).toBe("ok");
		expect(calls.length).toBe(2);
	});

	test("a rejected token (401/403) checks as error", async () => {
		for (const status of [401, 403]) {
			const { fetch } = stubFetch(
				byUrl({ [`${API}/repos/o/r`]: repoRes(status) }),
			);
			const r = await checkTurnToken({
				apiBase: API,
				token: TOKEN,
				repos: ["o/r"],
				fetch,
			});
			expect(r.verdict).toBe("error");
			expect(r.detail).toContain("rejected");
			expect(r.detail).toContain(String(status));
		}
	});

	test("a thrown fetch checks as error", async () => {
		const { fetch } = stubFetch(() => {
			throw new Error("conn reset");
		});
		const r = await checkTurnToken({
			apiBase: API,
			token: TOKEN,
			repos: ["o/r"],
			fetch,
		});
		expect(r.verdict).toBe("error");
		expect(r.detail).toContain("conn reset");
	});

	test("a malformed 200 body checks as error", async () => {
		const { fetch } = stubFetch(
			byUrl({
				[`${API}/repos/o/r`]: new Response("{not json", { status: 200 }),
			}),
		);
		const r = await checkTurnToken({
			apiBase: API,
			token: TOKEN,
			repos: ["o/r"],
			fetch,
		});
		expect(r.verdict).toBe("error");
		expect(r.detail).toContain("malformed");
	});

	test("an error beats a write signal from another repo", async () => {
		const { fetch } = stubFetch(
			byUrl({
				[`${API}/repos/bad/one`]: repoRes(500),
				[`${API}/repos/push/two`]: repoRes(200, {
					permissions: { push: true },
				}),
			}),
		);
		const r = await checkTurnToken({
			apiBase: API,
			token: TOKEN,
			repos: ["bad/one", "push/two"],
			fetch,
		});
		expect(r.verdict).toBe("error");
		expect(r.detail).toContain("bad/one");
	});

	test("a duplicated repo is fetched once", async () => {
		const { fetch, calls } = stubFetch(
			byUrl({
				[`${API}/repos/o/r`]: repoRes(200, { permissions: { push: false } }),
			}),
		);
		const r = await checkTurnToken({
			apiBase: API,
			token: TOKEN,
			repos: ["o/r", "o/r"],
			fetch,
		});
		expect(r.verdict).toBe("ok");
		expect(calls.length).toBe(1);
	});

	test("no project repositories checks ok without any fetch", async () => {
		const { fetch, calls } = stubFetch(byUrl({}));
		const r = await checkTurnToken({
			apiBase: API,
			token: TOKEN,
			repos: [],
			fetch,
		});
		expect(r.verdict).toBe("ok");
		expect(r.detail).toBe("no project repositories on this host");
		expect(calls.length).toBe(0);
	});
});

import { afterAll, describe, expect, test } from "bun:test";
import {
	alateApi,
	alateHealth,
	CONFIG_YML,
	commitConfigYml,
	ghApi,
	loadConfigYml,
	noRedirectFetch,
	readConfigYml,
} from "./alate.ts";

type Hit = {
	method: string;
	path: string;
	auth: string | null;
	type: string | null;
	body: string;
};
const hits: Hit[] = [];
let handler: (req: Request, url: URL) => Response | Promise<Response> = () =>
	Response.json({});
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		hits.push({
			method: req.method,
			path: url.pathname + url.search,
			auth: req.headers.get("authorization"),
			type: req.headers.get("content-type"),
			body: await req.text(),
		});
		return handler(req, url);
	},
});
afterAll(() => server.stop(true));
const alate = { url: `http://127.0.0.1:${server.port}`, key: "k1" };
function serve(fn: typeof handler) {
	hits.length = 0;
	handler = fn;
}

describe("alateApi", () => {
	test("url or key missing gives 400", async () => {
		expect(await alateApi({ url: null, key: "k" }, "/x", 1000)).toEqual({
			ok: false,
			status: 400,
			error: "alate server url is not configured",
		});
		expect(await alateApi({ url: alate.url, key: null }, "/x", 1000)).toEqual({
			ok: false,
			status: 400,
			error: "alate api key is not configured",
		});
	});
	test("GET sends the bearer, no body or content-type", async () => {
		serve(() => Response.json({ a: 1 }));
		expect(await alateApi(alate, "/api/state", 1000)).toEqual({
			ok: true,
			body: { a: 1 },
		});
		expect(hits).toEqual([
			{
				method: "GET",
				path: "/api/state",
				auth: "Bearer k1",
				type: null,
				body: "",
			},
		]);
	});
	test("init sends a JSON body", async () => {
		serve(() => Response.json({}));
		await alateApi(alate, "/api/import", 1000, {
			method: "POST",
			body: { x: 2 },
		});
		expect(hits[0]).toMatchObject({
			method: "POST",
			type: "application/json",
			body: '{"x":2}',
		});
	});
	test("404 and 409 keep status, others are 502", async () => {
		for (const [status, out] of [
			[404, 404],
			[409, 409],
			[500, 502],
			[400, 502],
		] as const) {
			serve(() => Response.json({ error: "boom" }, { status }));
			expect(await alateApi(alate, "/x", 1000)).toEqual({
				ok: false,
				status: out,
				error: "boom",
			});
		}
		serve(() => new Response("nope", { status: 503 }));
		expect(await alateApi(alate, "/x", 1000)).toEqual({
			ok: false,
			status: 502,
			error: "alate returned 503",
		});
	});
	test("non-object body is 502", async () => {
		for (const body of ["3", "null", "not json"]) {
			serve(() => new Response(body));
			expect(await alateApi(alate, "/x", 1000)).toEqual({
				ok: false,
				status: 502,
				error: "alate returned an invalid response",
			});
		}
	});
	test("timeout is 504 with the query stripped", async () => {
		// A response that never comes: only alateApi's AbortSignal ends the request.
		serve(() => new Promise<Response>(() => {}));
		expect(await alateApi(alate, "/api/file?path=x", 50)).toEqual({
			ok: false,
			status: 504,
			error: "alate did not answer /api/file within 0.05 s",
		});
	});
	test("connection refused is 502", async () => {
		const dead = Bun.serve({ port: 0, fetch: () => new Response() });
		const url = `http://127.0.0.1:${dead.port}`;
		dead.stop(true);
		const r = await alateApi({ url, key: "k" }, "/x", 1000);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.status).toBe(502);
		expect(r.error.startsWith("cannot reach alate server: ")).toBe(true);
	});
	test("a 3xx is not followed", async () => {
		serve((_req, url) =>
			url.pathname === "/x"
				? new Response(null, { status: 302, headers: { location: "/y" } })
				: Response.json({}),
		);
		expect(await alateApi(alate, "/x", 1000)).toEqual({
			ok: false,
			status: 502,
			error: `cannot reach alate server: ${alate.url}/x answered 302 (redirect not followed)`,
		});
		expect(hits.map((h) => h.path)).toEqual(["/x"]);
	});
});

describe("noRedirectFetch", () => {
	test("refuses exactly the 3xx range", async () => {
		for (const status of [299, 400]) {
			serve(() => new Response(null, { status }));
			expect((await noRedirectFetch(`${alate.url}/r`)).status).toBe(status);
		}
		for (const status of [300, 399]) {
			serve(() => new Response(null, { status }));
			await expect(noRedirectFetch(`${alate.url}/r`)).rejects.toThrow(
				`${alate.url}/r answered ${status} (redirect not followed)`,
			);
		}
	});
});

describe("alateHealth", () => {
	test("url null is 400", async () => {
		expect(await alateHealth({ url: null, key: "k" })).toEqual({
			ok: false,
			status: 400,
			error: "alate server url is not configured",
		});
	});
	test("GETs /health without the key", async () => {
		serve(() => Response.json({ repo: "o/r" }));
		expect(await alateHealth(alate)).toEqual({
			ok: true,
			body: { repo: "o/r" },
		});
		expect(hits).toEqual([
			{ method: "GET", path: "/health", auth: null, type: null, body: "" },
		]);
	});
	test("non-ok keeps its status", async () => {
		serve(() => Response.json({ error: "down" }, { status: 503 }));
		expect(await alateHealth(alate)).toEqual({
			ok: false,
			status: 503,
			error: "down",
		});
		for (const body of ['{"error":5}', "{}", "not json"]) {
			serve(() => new Response(body, { status: 404 }));
			expect(await alateHealth(alate)).toEqual({
				ok: false,
				status: 404,
				error: "alate returned 404",
			});
		}
	});
	test("non-object body is 502", async () => {
		for (const body of ["3", "null", "not json"]) {
			serve(() => new Response(body));
			expect(await alateHealth(alate)).toEqual({
				ok: false,
				status: 502,
				error: "alate returned an invalid health response",
			});
		}
	});
	test("connection refused is 502", async () => {
		const dead = Bun.serve({ port: 0, fetch: () => new Response() });
		const url = `http://127.0.0.1:${dead.port}`;
		dead.stop(true);
		const r = await alateHealth({ url, key: null });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.status).toBe(502);
		expect(r.error.startsWith("cannot reach alate server: ")).toBe(true);
	});
	test("the fetch carries a 5 s timeout", async () => {
		serve(() => Response.json({}));
		// Stub the timer factory: an already-aborted signal proves the signal reaches fetch
		// without a real 5 s wait.
		const real = AbortSignal.timeout;
		const seen: number[] = [];
		AbortSignal.timeout = (ms: number) => {
			seen.push(ms);
			return AbortSignal.abort(new Error("timed out"));
		};
		const r = await alateHealth(alate).finally(() => {
			AbortSignal.timeout = real;
		});
		expect(seen).toEqual([5000]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.status).toBe(502);
		expect(r.error.startsWith("cannot reach alate server: ")).toBe(true);
	});
});

describe("readConfigYml", () => {
	test("reads the encoded path", async () => {
		serve(() => Response.json({ content: "a: 1", hash: "h" }));
		expect(await readConfigYml(alate)).toEqual({
			ok: true,
			body: { content: "a: 1", hash: "h" },
		});
		expect(hits[0]?.path).toBe(
			`/api/file?path=${encodeURIComponent(CONFIG_YML)}`,
		);
		expect(CONFIG_YML).toBe("user/omp/agent/config.yml");
	});
	test("bad hash is 502, bad content is 422", async () => {
		serve(() => Response.json({ content: "a", hash: 1 }));
		expect(await readConfigYml(alate)).toEqual({
			ok: false,
			status: 502,
			error: "alate returned an invalid file response",
		});
		serve(() => Response.json({ content: null, hash: "h" }));
		expect(await readConfigYml(alate)).toEqual({
			ok: false,
			status: 422,
			error: "user/omp/agent/config.yml in the data repo is not UTF-8 text",
		});
	});
	test("an alate failure passes through", async () => {
		serve(() => Response.json({ error: "gone" }, { status: 404 }));
		expect(await readConfigYml(alate)).toEqual({
			ok: false,
			status: 404,
			error: "gone",
		});
	});
});

const SHA40 = "a".repeat(40);
function stateWith(source: unknown) {
	serve((_req, url) =>
		url.pathname === "/api/file"
			? Response.json({ content: "c", hash: "h" })
			: Response.json({ source }),
	);
}

describe("loadConfigYml", () => {
	test("keeps a valid sha and repo", async () => {
		stateWith({ kind: "repo", name: "o/r", ref: "main", importedSha: SHA40 });
		expect(await loadConfigYml(alate, false)).toEqual({
			ok: true,
			body: {
				content: "c",
				hash: "h",
				base: SHA40,
				repo: { name: "o/r", ref: "main" },
			},
		});
		expect(hits.map((h) => h.path)).toEqual([
			"/api/state",
			`/api/file?path=${encodeURIComponent(CONFIG_YML)}`,
		]);
	});
	test("ref defaults to empty", async () => {
		stateWith({ kind: "repo", name: "my-org/a_b.c-d", importedSha: SHA40 });
		const r = await loadConfigYml(alate, false);
		expect(r.ok && r.body.repo).toEqual({ name: "my-org/a_b.c-d", ref: "" });
	});
	test("rejects bad sha, kind and names", async () => {
		for (const sha of [
			"A".repeat(40),
			"a".repeat(39),
			`g${SHA40}`,
			`${SHA40}g`,
			5,
			[SHA40],
		]) {
			stateWith({ kind: "repo", name: "o/r", importedSha: sha });
			const r = await loadConfigYml(alate, false);
			expect(r.ok && r.body.base).toBeNull();
		}
		for (const src of [
			{ kind: "path", name: "o/r" },
			{ kind: "repo", name: "a/b/c" },
			{ kind: "repo", name: "../x" },
			{ kind: "repo", name: "o/.." },
			{ kind: "repo", name: "o/." },
			{ kind: "repo", name: "o r/x" },
			{ kind: "repo", name: 3 },
			{ kind: "repo", name: ["o/r"] },
			{ kind: "repo", name: " o/r" },
			{ kind: "repo", name: "o/r\n" },
		]) {
			stateWith(src);
			const r = await loadConfigYml(alate, false);
			expect(r.ok && r.body.repo).toBeNull();
		}
	});
	test("a repo name may start with a dot", async () => {
		stateWith({ kind: "repo", name: "o/.github" });
		const r = await loadConfigYml(alate, false);
		expect(r.ok && r.body.repo).toEqual({ name: "o/.github", ref: "" });
	});
	test("refresh imports the repo before the path and reads state.source", async () => {
		serve((_req, url) =>
			url.pathname === "/health"
				? Response.json({ repo: "o/r", path: "/p" })
				: url.pathname === "/api/import"
					? Response.json({
							state: {
								source: { kind: "repo", name: "o/r", importedSha: SHA40 },
							},
						})
					: Response.json({ content: "c", hash: "h" }),
		);
		const r = await loadConfigYml(alate, true);
		expect(r.ok && r.body.repo).toEqual({ name: "o/r", ref: "" });
		expect(r.ok && r.body.base).toBe(SHA40);
		const imp = hits.find((h) => h.path === "/api/import");
		expect(imp?.method).toBe("POST");
		expect(JSON.parse(imp?.body ?? "")).toEqual({
			source: "o/r",
			kind: "repo",
		});
		serve((_req, url) =>
			url.pathname === "/health"
				? Response.json({ repo: "", path: "/p" })
				: Response.json({ state: {} }),
		);
		await loadConfigYml(alate, true);
		expect(JSON.parse(hits[1]?.body ?? "")).toEqual({
			source: "/p",
			kind: "path",
		});
	});
	test("no source is 502", async () => {
		serve(() => Response.json({ repo: "", path: "" }));
		expect(await loadConfigYml(alate, true)).toEqual({
			ok: false,
			status: 502,
			error: "alate has no data source",
		});
	});
	test("refresh picks the kind from string, non-empty fields", async () => {
		for (const [health, sent] of [
			[
				{ repo: 5, path: "/p" },
				{ source: "/p", kind: "path" },
			],
			[{ path: "/p" }, { source: "/p", kind: "path" }],
		] as const) {
			serve((_req, url) =>
				url.pathname === "/health"
					? Response.json(health)
					: Response.json({ content: "c", hash: "h" }),
			);
			await loadConfigYml(alate, true);
			expect(JSON.parse(hits[1]?.body ?? "")).toEqual(sent);
		}
		serve(() => Response.json({ repo: "", path: 5 }));
		expect(await loadConfigYml(alate, true)).toEqual({
			ok: false,
			status: 502,
			error: "alate has no data source",
		});
		expect(hits.map((h) => h.path)).toEqual(["/health"]);
	});
	test("an import without state gives no base and no repo", async () => {
		serve((_req, url) =>
			url.pathname === "/health"
				? Response.json({ repo: "o/r" })
				: Response.json({ content: "c", hash: "h" }),
		);
		expect(await loadConfigYml(alate, true)).toEqual({
			ok: true,
			body: { content: "c", hash: "h", base: null, repo: null },
		});
	});
	test("health, state and file failures pass through", async () => {
		serve(() => Response.json({ error: "down" }, { status: 503 }));
		expect(await loadConfigYml(alate, true)).toEqual({
			ok: false,
			status: 503,
			error: "down",
		});
		expect(hits.map((h) => h.path)).toEqual(["/health"]);
		serve(() => Response.json({ error: "busy" }, { status: 409 }));
		expect(await loadConfigYml(alate, false)).toEqual({
			ok: false,
			status: 409,
			error: "busy",
		});
		expect(hits.map((h) => h.path)).toEqual(["/api/state"]);
		serve((_req, url) =>
			url.pathname === "/api/file"
				? Response.json({ error: "no file" }, { status: 404 })
				: Response.json({ source: { kind: "repo", name: "o/r" } }),
		);
		expect(await loadConfigYml(alate, false)).toEqual({
			ok: false,
			status: 404,
			error: "no file",
		});
	});
});

type R = { code: number; stdout: string; stderr: string };
const ok = (body: unknown): R => ({
	code: 0,
	stdout: JSON.stringify(body),
	stderr: "",
});

describe("ghApi", () => {
	test("prefixes api and parses the body", async () => {
		const calls: string[][] = [];
		expect(
			await ghApi(
				async (a) => {
					calls.push(a);
					return ok({ x: 1 });
				},
				["repos/o/r"],
			),
		).toEqual({ ok: true, body: { x: 1 } });
		expect(calls).toEqual([["api", "repos/o/r"]]);
	});
	test("thrown gh is 502", async () => {
		expect(
			await ghApi(async () => {
				throw new Error("no gh");
			}, []),
		).toEqual({ ok: false, status: 502, error: "no gh" });
	});
	test("failure messages and statuses", async () => {
		const run = (r: R) => ghApi(async () => r, []);
		expect(
			await run({ code: 1, stdout: '{"message":"Bad"}', stderr: "err" }),
		).toEqual({
			ok: false,
			status: 502,
			error: "GitHub: Bad",
		});
		expect(await run({ code: 1, stdout: "", stderr: " err \n" })).toEqual({
			ok: false,
			status: 502,
			error: "GitHub: err",
		});
		expect(await run({ code: 3, stdout: "", stderr: "" })).toEqual({
			ok: false,
			status: 502,
			error: "GitHub: gh exited 3",
		});
		expect(
			await run({
				code: 1,
				stdout: '{"message":"Update is not a fast forward"}',
				stderr: "",
			}),
		).toEqual({
			ok: false,
			status: 409,
			error: "GitHub: Update is not a fast forward",
		});
		expect(
			(await run({
				code: 1,
				stdout: '{"message":"x"}',
				stderr: "not a fast-forward",
			})) as unknown,
		).toEqual({
			ok: false,
			status: 409,
			error: "GitHub: x",
		});
	});
	test("non-object stdout on success is 502", async () => {
		for (const stdout of ["", "3", "null"])
			expect(
				await ghApi(async () => ({ code: 0, stdout, stderr: "" }), []),
			).toEqual({
				ok: false,
				status: 502,
				error: "GitHub returned an invalid response",
			});
	});
});

describe("commitConfigYml", () => {
	const B = "b".repeat(40);
	function fake(answers: Record<string, R>) {
		const calls: string[][] = [];
		const gh = async (a: string[]) => {
			calls.push(a);
			const key = a.find((x) => x.startsWith("repos/")) ?? "";
			return answers[key] ?? ok({});
		};
		return { gh, calls };
	}
	const happy = {
		"repos/o/r": ok({ default_branch: "dev" }),
		[`repos/o/r/git/commits/${B}`]: ok({ tree: { sha: "T0" } }),
		"repos/o/r/git/trees": ok({ sha: "T1" }),
		"repos/o/r/git/commits": ok({ sha: "C1" }),
		"repos/o/r/git/refs/heads/main": ok({}),
		"repos/o/r/git/refs/heads/dev": ok({}),
	};
	test("happy path argv", async () => {
		const { gh, calls } = fake(happy);
		expect(
			await commitConfigYml(gh, { name: "o/r", ref: "main" }, B, "x: 1", "msg"),
		).toEqual({
			ok: true,
			body: { commit: "C1" },
		});
		expect(calls).toEqual([
			["api", `repos/o/r/git/commits/${B}`],
			[
				"api",
				"-X",
				"POST",
				"repos/o/r/git/trees",
				"-f",
				"base_tree=T0",
				"-f",
				"tree[][path]=user/omp/agent/config.yml",
				"-f",
				"tree[][mode]=100644",
				"-f",
				"tree[][type]=blob",
				"-f",
				"tree[][content]=x: 1",
			],
			[
				"api",
				"-X",
				"POST",
				"repos/o/r/git/commits",
				"-f",
				"message=msg",
				"-f",
				"tree=T1",
				"-f",
				`parents[]=${B}`,
			],
			[
				"api",
				"-X",
				"PATCH",
				"repos/o/r/git/refs/heads/main",
				"-f",
				"sha=C1",
				"-F",
				"force=false",
			],
		]);
	});
	test("empty ref reads default_branch", async () => {
		const { gh, calls } = fake(happy);
		expect(
			(await commitConfigYml(gh, { name: "o/r", ref: "" }, B, "c", "m")).ok,
		).toBe(true);
		expect(calls[0]).toEqual(["api", "repos/o/r"]);
		expect(calls[4]?.[3]).toBe("repos/o/r/git/refs/heads/dev");
	});
	test("invalid branch stops before any commit call", async () => {
		for (const ref of ["a..b", "feat/a..b", "x y", "~main", "main~"]) {
			const { gh, calls } = fake(happy);
			expect(
				await commitConfigYml(gh, { name: "o/r", ref }, B, "c", "m"),
			).toEqual({
				ok: false,
				status: 502,
				error: `invalid data repo branch: ${ref}`,
			});
			expect(calls).toEqual([]);
		}
		const { gh, calls } = fake({ ...happy, "repos/o/r": ok({}) });
		expect(
			await commitConfigYml(gh, { name: "o/r", ref: "" }, B, "c", "m"),
		).toEqual({
			ok: false,
			status: 502,
			error: "invalid data repo branch: ",
		});
		expect(calls.length).toBe(1);
		const long = `x y${"z".repeat(200)}`;
		const g = fake(happy);
		expect(
			await commitConfigYml(g.gh, { name: "o/r", ref: long }, B, "c", "m"),
		).toEqual({
			ok: false,
			status: 502,
			error: `invalid data repo branch: x y${"z".repeat(97)}`,
		});
		expect(g.calls).toEqual([]);
	});
	const bad = {
		ok: false,
		status: 502,
		error: "GitHub returned an invalid response",
	} as const;
	test("missing tree or commit sha is 502", async () => {
		for (const patch of [
			{ [`repos/o/r/git/commits/${B}`]: ok({}) },
			{ [`repos/o/r/git/commits/${B}`]: ok({ tree: {} }) },
			{ "repos/o/r/git/trees": ok({}) },
			{ "repos/o/r/git/commits": ok({ sha: 1 }) },
		]) {
			const { gh } = fake({ ...happy, ...patch });
			expect(
				await commitConfigYml(gh, { name: "o/r", ref: "main" }, B, "c", "m"),
			).toEqual(bad);
		}
	});
	test("a failed gh call stops the commit with its error", async () => {
		const fail: R = { code: 1, stdout: '{"message":"nope"}', stderr: "" };
		for (const [key, ref, count] of [
			["repos/o/r", "", 1],
			[`repos/o/r/git/commits/${B}`, "main", 1],
			["repos/o/r/git/trees", "main", 2],
			["repos/o/r/git/commits", "main", 3],
		] as const) {
			const { gh, calls } = fake({ ...happy, [key]: fail });
			expect(
				await commitConfigYml(gh, { name: "o/r", ref }, B, "c", "m"),
			).toEqual({ ok: false, status: 502, error: "GitHub: nope" });
			expect(calls.length).toBe(count);
		}
	});
	test("409 on the ref PATCH propagates", async () => {
		const { gh } = fake({
			...happy,
			"repos/o/r/git/refs/heads/main": {
				code: 1,
				stdout: '{"message":"Update is not a fast forward"}',
				stderr: "",
			},
		});
		expect(
			await commitConfigYml(gh, { name: "o/r", ref: "main" }, B, "c", "m"),
		).toEqual({
			ok: false,
			status: 409,
			error: "GitHub: Update is not a fast forward",
		});
	});
});

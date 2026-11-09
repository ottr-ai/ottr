import { afterAll, describe, expect, test } from "bun:test";
import {
	alateApi,
	alateHealth,
	alateRotateKey,
	CONFIG_YML,
	commitConfigYml,
	ghApi,
	loadConfigYml,
	noRedirectFetch,
	readConfigYml,
	readOnlyMountError,
	refreshAlateSnapshot,
	saveConfigYml,
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
			error:
				"the alate api call failed (unavailable): check that the alate server is up, then try again",
		});
		// A caller's label names the request in the fallback (the Error-Says-Fix rule).
		expect(
			await alateApi(alate, "/x", 1000, null, "the config.yml read"),
		).toEqual({
			ok: false,
			status: 502,
			error:
				"the config.yml read failed (unavailable): check that the alate server is up, then try again",
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
	test("a cross-host 3xx with proxyHint names the proxy", async () => {
		serve(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "http://www.example.com/y" },
				}),
		);
		await expect(
			noRedirectFetch(`${alate.url}/r`, {}, { proxyHint: true }),
		).rejects.toThrow(
			`${alate.url}/r answered 302 (redirect not followed; a proxy may intercept this call: check NO_PROXY)`,
		);
	});
	test("a same-host 3xx with proxyHint adds no hint", async () => {
		serve(
			() => new Response(null, { status: 302, headers: { location: "/y" } }),
		);
		await expect(
			noRedirectFetch(`${alate.url}/r`, {}, { proxyHint: true }),
		).rejects.toThrow(`${alate.url}/r answered 302 (redirect not followed)`);
	});
	test("a cross-host 3xx without the opts adds no hint", async () => {
		serve(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "http://www.example.com/y" },
				}),
		);
		await expect(noRedirectFetch(`${alate.url}/r`)).rejects.toThrow(
			`${alate.url}/r answered 302 (redirect not followed)`,
		);
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
				error: `the alate health check of ${alate.url}/health failed (not found): check that the alate server is running`,
			});
		}
	});
	test("cross-host redirect is 502 with NO_PROXY hint", async () => {
		serve(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "http://www.example.com/health" },
				}),
		);
		expect(await alateHealth(alate)).toEqual({
			ok: false,
			status: 502,
			error: `cannot reach alate server: ${alate.url}/health answered 302 (redirect not followed; a proxy may intercept this call: check NO_PROXY)`,
		});
	});
	test("same-host redirect is 502 without the hint", async () => {
		serve(
			() =>
				new Response(null, { status: 302, headers: { location: "/health" } }),
		);
		expect(await alateHealth(alate)).toEqual({
			ok: false,
			status: 502,
			error: `cannot reach alate server: ${alate.url}/health answered 302 (redirect not followed)`,
		});
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

describe("status-only fallbacks name the request", () => {
	// The Error-Says-Fix rule: each caller's label, the status in words and the next
	// step, one line. A body without an error string takes the fallback.
	test("each call's label reaches its fallback", async () => {
		serve(() => new Response("nope", { status: 503 }));
		expect(await readConfigYml(alate)).toEqual({
			ok: false,
			status: 502,
			error:
				"the config.yml read failed (unavailable): check that the alate server is up, then try again",
		});
		expect(await saveConfigYml(alate, "c", "h1", "m")).toEqual({
			ok: false,
			status: 502,
			error:
				"the config.yml save failed (unavailable): check that the alate server is up, then try again",
		});
		expect(await loadConfigYml(alate, false)).toEqual({
			ok: false,
			status: 502,
			error:
				"the alate state read failed (unavailable): check that the alate server is up, then try again",
		});
		// The refresh path answers /health first: the health check passes, then the import fails.
		serve((_req, url) =>
			url.pathname === "/health"
				? Response.json({ repo: "o/r" })
				: new Response("nope", { status: 503 }),
		);
		expect(await refreshAlateSnapshot(alate)).toEqual({
			ok: false,
			status: 502,
			error:
				"the snapshot import failed (unavailable): check that the alate server is up, then try again",
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
				path: null,
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
			// A path source keeps its folder name; anything else keeps path null.
			expect(r.ok && r.body.path).toBe(src.kind === "path" ? "o/r" : null);
		}
		for (const src of [
			{ kind: "path", name: "" },
			{ kind: "path", name: 5 },
			{ kind: "path" },
		]) {
			stateWith(src);
			const r = await loadConfigYml(alate, false);
			expect(r.ok && r.body.repo).toBeNull();
			expect(r.ok && r.body.path).toBeNull();
		}
	});
	test("a repo name may start with a dot", async () => {
		stateWith({ kind: "repo", name: "o/.github" });
		const r = await loadConfigYml(alate, false);
		expect(r.ok && r.body.repo).toEqual({ name: "o/.github", ref: "" });
	});
	test("a path source keeps its folder and no repo", async () => {
		stateWith({ kind: "path", name: "/data", ref: "", importedSha: "" });
		const r = await loadConfigYml(alate, false);
		expect(r.ok && r.body.path).toBe("/data");
		expect(r.ok && r.body.repo).toBeNull();
		expect(r.ok && r.body.base).toBeNull();
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
			body: { content: "c", hash: "h", base: null, repo: null, path: null },
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

describe("readOnlyMountError", () => {
	test("matches alate's raw filesystem refusal codes, nothing else", () => {
		expect(
			readOnlyMountError(
				"EROFS: read-only file system, open '/data/user/omp/agent/config.yml'",
			),
		).toBe(true);
		expect(
			readOnlyMountError(
				"EACCES: permission denied, open '/data/user/omp/agent/config.yml'",
			),
		).toBe(true);
		expect(readOnlyMountError("EROFS")).toBe(true);
		expect(readOnlyMountError("read-only: folder source")).toBe(false);
		expect(
			readOnlyMountError("cannot reach alate server: connect ECONNREFUSED"),
		).toBe(false);
		expect(readOnlyMountError("NEROFS: not a real code")).toBe(false);
		expect(readOnlyMountError("alate returned 500")).toBe(false);
	});
});

describe("saveConfigYml", () => {
	test("PUTs the file with the exact body and bearer auth", async () => {
		serve(() => Response.json({ ok: true, commit: SHA40, pushed: false }));
		expect(
			await saveConfigYml(alate, "c", "h1", "chore: set the roles"),
		).toEqual({ ok: true, body: { commit: SHA40, pushed: false } });
		expect(hits).toEqual([
			{
				method: "PUT",
				path: "/api/file",
				auth: "Bearer k1",
				type: "application/json",
				body: JSON.stringify({
					path: CONFIG_YML,
					content: "c",
					base: "h1",
					message: "chore: set the roles",
				}),
			},
		]);
	});
	test("a conflict passes through with its status", async () => {
		serve(() =>
			Response.json(
				{ error: "user/omp/agent/config.yml changed since it was loaded" },
				{ status: 409 },
			),
		);
		expect(await saveConfigYml(alate, "c", "h1", "m")).toEqual({
			ok: false,
			status: 409,
			error: "user/omp/agent/config.yml changed since it was loaded",
		});
	});
	test("a 2xx body without commit or pushed is 502", async () => {
		serve(() => Response.json({ ok: true, pushed: false }));
		expect(await saveConfigYml(alate, "c", "h1", "m")).toEqual({
			ok: false,
			status: 502,
			error: "alate returned an invalid file response",
		});
		serve(() => Response.json({ ok: true, commit: 5, pushed: true }));
		expect(await saveConfigYml(alate, "c", "h1", "m")).toEqual({
			ok: false,
			status: 502,
			error: "alate returned an invalid file response",
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

describe("alateRotateKey", () => {
	test("posts bearer auth to /api/key with no body and returns the key", async () => {
		serve(() => Response.json({ key: "rotated" }));
		expect(await alateRotateKey(alate)).toEqual({
			ok: true,
			body: { key: "rotated" },
		});
		expect(hits).toEqual([
			{
				method: "POST",
				path: "/api/key",
				auth: "Bearer k1",
				type: null,
				body: "",
			},
		]);
	});
	test("alate error status and message are kept", async () => {
		serve(() => Response.json({ error: "nope" }, { status: 401 }));
		expect(await alateRotateKey(alate)).toEqual({
			ok: false,
			status: 401,
			error: "nope",
		});
	});
	test("a body without a key is 502", async () => {
		serve(() => Response.json({}));
		expect(await alateRotateKey(alate)).toEqual({
			ok: false,
			status: 502,
			error: "alate returned an invalid key response",
		});
	});
	test("a non-JSON body is 502", async () => {
		serve(() => new Response("not json"));
		expect(await alateRotateKey(alate)).toEqual({
			ok: false,
			status: 502,
			error: "alate returned an invalid response",
		});
	});
	test("url or key missing gives 400", async () => {
		expect(await alateRotateKey({ url: null, key: "k" })).toEqual({
			ok: false,
			status: 400,
			error: "alate server url is not configured",
		});
		expect(await alateRotateKey({ url: alate.url, key: null })).toEqual({
			ok: false,
			status: 400,
			error: "alate api key is not configured",
		});
	});
	test("an unreachable server is 502", async () => {
		expect(
			await alateRotateKey({ url: "http://127.0.0.1:9", key: "k" }),
		).toEqual({
			ok: false,
			status: 502,
			error: expect.stringContaining("cannot reach alate server"),
		});
	});
	// The 10 s timeout case is skipped: it would wait the real 10 s.
});

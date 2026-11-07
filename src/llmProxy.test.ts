import { afterAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { handleHindsight, handleLlm } from "./llmProxy.ts";
import { VmTokens } from "./vmTokens.ts";

const tokens = new VmTokens({ file: null });
const grant = {
	project: "alpha",
	taskId: "ALP-1",
	branch: "ott/alp-1",
	repoPath: "/w/alpha",
	worktree: "/w/alpha/.worktrees/ALP-1",
};

/** Releases the upstream's second SSE event; the test opens it only after reading the first. */
let release: () => void = () => {};
const seen: { path: string; headers: Record<string, string>; body: string }[] =
	[];

const upstream: Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const u = new URL(req.url);
		seen.push({
			path: `${u.pathname}${u.search}`,
			headers: Object.fromEntries(req.headers),
			body: await req.text(),
		});
		if (u.pathname.endsWith("/stream")) {
			const { promise: gate, resolve } = Promise.withResolvers<void>();
			release = resolve;
			const enc = new TextEncoder();
			return new Response(
				new ReadableStream({
					async start(c) {
						c.enqueue(enc.encode("data: one\n\n"));
						await gate;
						c.enqueue(enc.encode("data: two\n\n"));
						c.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		return Response.json({ ok: true }, { status: 201 });
	},
});

let gateway: { url: string; token: string } | null = {
	url: `http://127.0.0.1:${upstream.port}/`,
	token: "gw-secret",
};
let hindsightUrl: string | undefined = `http://127.0.0.1:${upstream.port}/hs`;

const board: Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path.startsWith("/llm/")) return handleLlm(req, { tokens, gateway });
		return handleHindsight(req, {
			tokens,
			url: hindsightUrl,
			token: "hs-secret",
		});
	},
});
afterAll(() => {
	board.stop(true);
	upstream.stop(true);
});
const at = (p: string) => `http://127.0.0.1:${board.port}${p}`;

describe("handleLlm", () => {
	test("streams an SSE answer chunk by chunk, never buffering it", async () => {
		const token = tokens.issue(grant);
		const res = await fetch(at("/llm/v1/pi/stream"), {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ model: "x" }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const dec = new TextDecoder();
		// The upstream holds its second event until this first read returns: a proxy that
		// buffered the whole body would never deliver it, and the read would time out.
		let first = "";
		while (!first.includes("\n\n"))
			first += dec.decode((await reader.read()).value);
		expect(first).toBe("data: one\n\n");
		release();
		let rest = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			rest += dec.decode(value);
		}
		expect(rest).toBe("data: two\n\n");
	}, 10_000);

	test("forwards method, path, query and body with the gateway bearer, never the caller's credentials", async () => {
		const token = tokens.issue(grant);
		seen.length = 0;
		const res = await fetch(at("/llm/v1/models?x=1&y=2"), {
			method: "PUT",
			headers: {
				authorization: `Bearer ${token}`,
				"x-board-token": "boot-secret",
				"x-api-key": token,
				cookie: "ottr_session=abc",
				"x-omp-app": "omp",
			},
			body: "payload",
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ ok: true });
		const [hit] = seen;
		expect(hit?.path).toBe("/v1/models?x=1&y=2");
		expect(hit?.body).toBe("payload");
		expect(hit?.headers.authorization).toBe("Bearer gw-secret");
		expect(hit?.headers["x-board-token"]).toBeUndefined();
		expect(hit?.headers["x-api-key"]).toBeUndefined();
		expect(hit?.headers.cookie).toBeUndefined();
		expect(hit?.headers["x-omp-app"]).toBe("omp");
		expect(JSON.stringify(hit?.headers)).not.toContain(token);
	});

	test("no token, an unknown or a revoked token gets 401 and never reaches the gateway", async () => {
		const token = tokens.issue(grant);
		tokens.revoke(token);
		seen.length = 0;
		for (const headers of [
			{} as Record<string, string>,
			{ authorization: `Bearer ${token}` },
			{ authorization: `Bearer ${"f".repeat(64)}` },
			// The gateway's own token is not a VM token.
			{ authorization: "Bearer gw-secret" },
		]) {
			const res = await fetch(at("/llm/v1/models"), { headers });
			expect(res.status).toBe(401);
		}
		expect(seen).toEqual([]);
	});

	test("503 while the gateway is not running, for a live token only", async () => {
		const token = tokens.issue(grant);
		const saved = gateway;
		gateway = null;
		try {
			const res = await fetch(at("/llm/v1/models"), {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(res.status).toBe(503);
			expect((await fetch(at("/llm/v1/models"))).status).toBe(401);
		} finally {
			gateway = saved;
		}
	});
});

describe("handleHindsight", () => {
	test("forwards under the Hindsight URL's own path with the board's Hindsight token", async () => {
		const token = tokens.issue(grant);
		seen.length = 0;
		const res = await fetch(at("/hindsight/v1/banks/alpha/memories?limit=3"), {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(201);
		expect(seen[0]?.path).toBe("/hs/v1/banks/alpha/memories?limit=3");
		expect(seen[0]?.headers.authorization).toBe("Bearer hs-secret");
	});

	test("401 for a revoked token, 503 when Hindsight is not configured", async () => {
		const revoked = tokens.issue(grant);
		tokens.revokeTask("alpha", "ALP-1");
		const live = tokens.issue({ ...grant, taskId: "ALP-2" });
		expect(
			(
				await fetch(at("/hindsight/v1/x"), {
					headers: { authorization: `Bearer ${revoked}` },
				})
			).status,
		).toBe(401);
		const saved = hindsightUrl;
		hindsightUrl = undefined;
		try {
			const res = await fetch(at("/hindsight/v1/x"), {
				headers: { authorization: `Bearer ${live}` },
			});
			expect(res.status).toBe(503);
		} finally {
			hindsightUrl = saved;
		}
	});
});

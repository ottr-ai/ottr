import { describe, expect, test } from "bun:test";
import {
	type GithubFetch,
	type GithubRetryOpts,
	parseRetryWait,
	withGithubRetry,
} from "./githubRetry.ts";
import fc from "./test/properties.ts";

type Call = { url: string | URL; init?: RequestInit };

/** A fetch that answers from a script; records every call and every injected wait. */
function scripted(responses: (Response | Error)[]): {
	fetch: GithubFetch;
	calls: Call[];
	sleeps: number[];
	wrap: (opts?: GithubRetryOpts) => GithubFetch;
} {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const fetch: GithubFetch = async (input, init) => {
		calls.push({ url: input, init });
		const next = responses.shift();
		if (next === undefined) throw new Error("script exhausted");
		if (next instanceof Error) throw next;
		return next;
	};
	return {
		fetch,
		calls,
		sleeps,
		wrap: (opts?: GithubRetryOpts) =>
			withGithubRetry(fetch, {
				// Deterministic defaults: mid jitter, fixed clock. Tests override.
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				random: () => 0.5,
				now: () => 1_700_000_000_000,
				...opts,
			}),
	};
}

const res = (status: number, headers?: Record<string, string>): Response =>
	new Response(null, { status, headers });

describe("withGithubRetry", () => {
	test("a 503 then 200 gives the result", async () => {
		const s = scripted([res(503), res(200)]);
		const out = await s.wrap()("https://api.github.com/repos/acme/widget");
		expect(out.status).toBe(200);
		expect(s.calls).toHaveLength(2);
		expect(s.sleeps).toEqual([400]);
	});

	test("a 429 with Retry-After: 2 waits 2 s through the injected sleep", async () => {
		const s = scripted([res(429, { "retry-after": "2" }), res(200)]);
		const out = await s.wrap()("https://api.github.com/repos/acme/widget");
		expect(out.status).toBe(200);
		expect(s.sleeps).toEqual([2000]);
		expect(s.calls).toHaveLength(2);
	});

	test("a wait above the cap stops and returns the error answer", async () => {
		const s = scripted([res(429, { "retry-after": "9999" })]);
		const out = await s.wrap({ capMs: 1000 })(
			"https://api.github.com/repos/acme/widget",
		);
		expect(out.status).toBe(429);
		expect(s.calls).toHaveLength(1);
		expect(s.sleeps).toEqual([]);
	});

	test("a 404 is not retried", async () => {
		const s = scripted([res(404)]);
		const out = await s.wrap()("https://api.github.com/repos/acme/widget");
		expect(out.status).toBe(404);
		expect(s.calls).toHaveLength(1);
		expect(s.sleeps).toEqual([]);
	});

	test("a POST is not retried even on a 503", async () => {
		const s = scripted([res(503)]);
		const out = await s.wrap()("https://api.github.com/Reviews", {
			method: "POST",
		});
		expect(out.status).toBe(503);
		expect(s.calls).toHaveLength(1);
		expect(s.sleeps).toEqual([]);
	});

	test("a HEAD retries like a GET; a transport throw never retries", async () => {
		const s1 = scripted([res(503), res(200)]);
		await s1.wrap()("https://api.github.com/repos/acme/widget", {
			method: "HEAD",
		});
		expect(s1.calls).toHaveLength(2);
		const s2 = scripted([new Error("network down")]);
		await expect(
			s2.wrap()("https://api.github.com/repos/acme/widget"),
		).rejects.toThrow("network down");
		expect(s2.calls).toHaveLength(1);
	});

	test("the number of attempts has a limit", async () => {
		const s = scripted([res(503), res(503), res(503), res(503), res(503)]);
		const out = await s.wrap()("https://api.github.com/repos/acme/widget");
		expect(out.status).toBe(503);
		expect(s.calls).toHaveLength(3);
		expect(s.sleeps).toEqual([400, 800]);
	});

	test("the delays have jitter inside the stated bounds", async () => {
		const s = scripted([res(503), res(503), res(503), res(503)]);
		await s.wrap({
			attempts: 4,
			baseMs: 100,
			capMs: 10_000,
			random: () => 0.999_999,
		})("https://api.github.com/repos/acme/widget");
		const raws = [100, 200, 400];
		for (const [i, delay] of s.sleeps.entries()) {
			const raw = raws[i]!;
			expect(delay).toBeGreaterThanOrEqual(0.8 * raw);
			expect(delay).toBeLessThanOrEqual(1.2 * raw);
		}
		const floor = scripted([res(503), res(503), res(503), res(503)]);
		await floor.wrap({
			attempts: 4,
			baseMs: 100,
			capMs: 10_000,
			random: () => 0,
		})("https://api.github.com/repos/acme/widget");
		expect(floor.sleeps).toEqual(raws.map((raw) => Math.round(0.8 * raw)));
	});

	test("the per-wait cap also bounds the backoff", async () => {
		const s = scripted([res(503), res(503), res(503)]);
		await s.wrap({ baseMs: 500, capMs: 300 })(
			"https://api.github.com/repos/acme/widget",
		);
		// The raw backoff clamps to the cap (300) before jitter, so no wait exceeds it.
		expect(s.sleeps).toEqual([300, 300]);
	});

	test("a 403 retries only with a rate-limit signal", async () => {
		const plain = scripted([res(403)]);
		const out = await plain.wrap()("https://api.github.com/repos/acme/widget");
		expect(out.status).toBe(403);
		expect(plain.calls).toHaveLength(1);

		const remaining = scripted([
			res(403, { "x-ratelimit-remaining": "0" }),
			res(200),
		]);
		await remaining.wrap()("https://api.github.com/repos/acme/widget");
		expect(remaining.calls).toHaveLength(2);
		expect(remaining.sleeps).toEqual([400]);

		const after = scripted([res(403, { "retry-after": "1" }), res(200)]);
		await after.wrap()("https://api.github.com/repos/acme/widget");
		expect(after.sleeps).toEqual([1000]);
	});

	test("x-ratelimit-reset names the wait; above the cap it stops", async () => {
		// Fixed clock is 1_700_000_000_000; reset 2 s ahead waits exactly 2 s. A 429
		// is retryable on its own; a 403 would additionally need Retry-After or
		// x-ratelimit-remaining: 0 (covered above).
		const s = scripted([
			res(429, { "x-ratelimit-reset": "1700000002" }),
			res(200),
		]);
		await s.wrap()("https://api.github.com/repos/acme/widget");
		expect(s.sleeps).toEqual([2000]);

		const far = scripted([res(429, { "x-ratelimit-reset": "1700000010" })]);
		const out = await far.wrap({ capMs: 1000 })(
			"https://api.github.com/repos/acme/widget",
		);
		expect(out.status).toBe(429);
		expect(far.calls).toHaveLength(1);
		expect(far.sleeps).toEqual([]);
	});

	test("Retry-After as an HTTP-date waits until it; a reset in the past waits 0", async () => {
		const at = new Date(1_700_000_001_000).toUTCString();
		const s = scripted([res(429, { "retry-after": at }), res(200)]);
		await s.wrap()("https://api.github.com/repos/acme/widget");
		expect(s.sleeps).toEqual([1000]);

		const past = parseRetryWait(
			new Headers({ "retry-after": new Date(0).toUTCString() }),
			1_700_000_000_000,
			4000,
		);
		expect(past).toEqual({ waitMs: 0 });
	});

	test("every retry re-issues the exact method and request URL", async () => {
		const s = scripted([res(503), res(200)]);
		const url = "https://api.github.com/repos/acme/widget/rules/branches/main";
		const init = { headers: { authorization: "Bearer t" } };
		await s.wrap()(url, init);
		expect(s.calls.length).toBeGreaterThan(1);
		for (const call of s.calls) {
			expect(call.url).toBe(url);
			expect(call.init?.method ?? "GET").toBe("GET");
			expect(call.init?.headers).toBe(init.headers);
		}
	});
});

describe("parseRetryWait", () => {
	test("garbage headers give null; a valid reset wins when Retry-After is garbage", () => {
		expect(parseRetryWait(new Headers(), 1_000, 4_000)).toBeNull();
		expect(
			parseRetryWait(new Headers({ "retry-after": "soon" }), 1_000, 4_000),
		).toBeNull();
		expect(
			parseRetryWait(
				new Headers({ "retry-after": "soon", "x-ratelimit-reset": "2" }),
				1_000,
				4_000,
			),
		).toEqual({ waitMs: 1000 });
	});

	test("arbitrary header text never throws and never leaves [0, cap]", () => {
		// Header values a Response can carry: printable ASCII only (a Response
		// itself rejects the rest, so the parser never sees it).
		const headerText = fc.string().map((v) => v.replace(/[^\x20-\x7e]/g, "a"));
		fc.assert(
			fc.property(
				fc.option(headerText, { nil: undefined }),
				fc.option(headerText, { nil: undefined }),
				fc.integer({ min: 0, max: 2 ** 40 }),
				fc.integer({ min: 1, max: 60_000 }),
				(retryAfter, reset, now, capMs) => {
					const h = new Headers();
					if (retryAfter !== undefined) h.set("retry-after", retryAfter);
					if (reset !== undefined) h.set("x-ratelimit-reset", reset);
					const w = parseRetryWait(h, now, capMs);
					if (w === null || "stop" in w) return;
					expect(w.waitMs).toBeGreaterThanOrEqual(0);
					expect(w.waitMs).toBeLessThanOrEqual(capMs);
				},
			),
		);
	});
});

/**
 * Bounded retry for the server's GitHub REST fetches (OTTR-792). A `429`, a
 * `502`/`503`/`504`, or a `403` that carries a rate-limit signal (`Retry-After`,
 * or `x-ratelimit-remaining: 0`) is retried with jittered exponential backoff that
 * obeys `Retry-After` and `x-ratelimit-reset` up to a per-wait cap. Any other status,
 * any POST-like method, and any transport throw (timeout, network error) pass
 * through untouched: the caller's error path or its next poll handles them. A wait
 * above the cap stops the retry, so a scheduler tick never blocks for minutes; each
 * call path keeps its own total deadline because the original per-request signal
 * stays in the reused `init`.
 */

/** The fetch shape every wrapped call site already uses. */
export type GithubFetch = (
	url: string,
	init?: RequestInit,
) => Promise<Response>;

export type GithubRetryOpts = {
	/** Total attempts including the first; default 3. */
	attempts?: number;
	/** First backoff wait in ms; the next doubles, each capped; default 400. */
	baseMs?: number;
	/** Ceiling for one wait, header-given or backoff; default 4000. */
	capMs?: number;
	/** Wait seam; tests inject so no test waits. Default Bun.sleep. */
	sleep?: (ms: number) => Promise<void>;
	/** Random source for the jitter; tests inject. Default Math.random. */
	random?: () => number;
	/** Clock for HTTP-date and reset math; tests inject. Default Date.now. */
	now?: () => number;
};

/**
 * Wraps a fetch with the bounded GitHub retry; a drop-in for the `deps.fetch ?? fetch`
 * seams. The returned fetch re-issues the same `url`/`init`, so redirects-refused,
 * tokens, and per-call timeout signals behave exactly as before.
 */
export function withGithubRetry(
	doFetch: GithubFetch,
	opts: GithubRetryOpts = {},
): GithubFetch {
	const attempts = opts.attempts ?? 3;
	const baseMs = opts.baseMs ?? 400;
	const capMs = opts.capMs ?? 4000;
	const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
	const random = opts.random ?? Math.random;
	const now = opts.now ?? Date.now;
	return async (input, init) => {
		const method = (init?.method ?? "GET").toUpperCase();
		// Only requests that are safe to repeat retry; a POST that creates something
		// (a review, a comment, a release, an installation token) never retries.
		const repeatable =
			method === "GET" || method === "HEAD" || method === "OPTIONS";
		let res = await doFetch(input, init);
		for (let attempt = 1; repeatable && attempt < attempts; attempt++) {
			if (!retryableStatus(res)) return res;
			const wait = parseRetryWait(res.headers, now(), capMs);
			if (wait !== null && "stop" in wait) return res;
			await sleep(
				wait !== null
					? wait.waitMs
					: backoffMs(attempt, baseMs, capMs, random()),
			);
			res = await doFetch(input, init);
		}
		return res;
	};
}

/** True when the answer is the transient kind this helper retries. */
function retryableStatus(res: Response): boolean {
	if (
		res.status === 429 ||
		res.status === 502 ||
		res.status === 503 ||
		res.status === 504
	)
		return true;
	// A plain 403 is a permanent answer (private repo, SAML, abuse block). Retry it
	// only when it carries a rate-limit signal.
	return (
		res.status === 403 &&
		(res.headers.get("retry-after") !== null ||
			res.headers.get("x-ratelimit-remaining") === "0")
	);
}

/** The wait one answer asks for, or `null` when no header names one. */
export type RetryWait = { waitMs: number } | { stop: true } | null;

/**
 * Reads the wait a GitHub answer asks for: `Retry-After` (delay-seconds or an
 * HTTP-date), else `x-ratelimit-reset` (epoch seconds). Unparseable or absent
 * headers give `null` (the caller falls back to backoff). A wait above `capMs`
 * gives `{ stop }` — the caller returns the error and its next poll handles it.
 * Never throws and never returns a negative or over-cap wait.
 */
export function parseRetryWait(
	headers: Headers,
	now: number,
	capMs: number,
): RetryWait {
	const retryAfter = headers.get("retry-after");
	if (retryAfter !== null) {
		const ms = retryAfterMs(retryAfter, now);
		if (ms !== null) return bounded(ms, capMs);
	}
	const reset = headers.get("x-ratelimit-reset");
	if (reset !== null) {
		const secs = Number(reset.trim());
		if (reset.trim() !== "" && Number.isFinite(secs) && secs > 0)
			return bounded(Math.max(0, secs * 1000 - now), capMs);
	}
	return null;
}

/** Retry-After: delay-seconds or an HTTP-date; `null` when the value is neither. */
function retryAfterMs(value: string, now: number): number | null {
	const raw = value.trim();
	const secs = Number(raw);
	if (raw !== "" && Number.isFinite(secs)) return Math.max(0, secs * 1000);
	const at = Date.parse(raw);
	if (Number.isNaN(at)) return null;
	return Math.max(0, at - now);
}

/** Clamps a parsed wait into `[0, capMs]`; above the cap is a stop, not a wait. */
function bounded(waitMs: number, capMs: number): RetryWait {
	if (waitMs > capMs) return { stop: true };
	return { waitMs: Math.min(Math.max(0, Math.round(waitMs)), capMs) };
}

/** Jittered exponential backoff: `baseMs * 2^(attempt-1)` capped, then ±20%. */
function backoffMs(
	attempt: number,
	baseMs: number,
	capMs: number,
	random: number,
): number {
	const raw = Math.min(baseMs * 2 ** (attempt - 1), capMs);
	const jittered = Math.round(raw * (0.8 + 0.4 * random));
	return Math.min(Math.max(0, jittered), capMs);
}

import type { KeyObject } from "node:crypto";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as cryptoSign,
} from "node:crypto";
import { noRedirectFetch } from "./alate.ts";
import { githubHost } from "./githubHost.ts";
import type { AppCheck } from "./types.ts";

/** Ceiling for every GitHub API call below; a stalled server must never hang a check. */
const APP_FETCH_TIMEOUT_MS = 20_000;

/** Text for a caught error: clear words for a fetch timeout, the message otherwise. */
function errText(e: unknown, ms: number): string {
	if (e instanceof Error)
		return e.name === "TimeoutError" || e.name === "AbortError"
			? `timed out after ${ms / 1000}s`
			: e.message;
	return String(e);
}

export type ParsedAppKey = { keyObject: KeyObject; fingerprint: string };

/** Parse a PEM private key and fingerprint its public half (SPKI, SHA-256, unpadded base64). */
export function parseAppPem(pem: string): ParsedAppKey | null {
	let keyObject: KeyObject;
	try {
		keyObject = createPrivateKey(pem.trim());
	} catch {
		return null;
	}
	if (keyObject.asymmetricKeyType !== "rsa") return null;
	const publicKey = createPublicKey(keyObject);
	const der = publicKey.export({ format: "der", type: "spki" });
	const fingerprint =
		"SHA256:" +
		createHash("sha256").update(der).digest("base64").replace(/=+$/, "");
	return { keyObject, fingerprint };
}

export type ValidAppCredentials = {
	id: string;
	key: string;
	fingerprint: string;
};

/** Validate a GitHub App id + PEM key pair; returns the pair or the reason it is invalid. */
export function validateAppCredentials(
	input: unknown,
): ValidAppCredentials | { error: string } {
	if (typeof input !== "object" || input === null) {
		return { error: "the GitHub App credentials must be an object" };
	}
	const { id, key } = input as { id?: unknown; key?: unknown };
	if (typeof id !== "string" || !/^\d{1,32}$/.test(id)) {
		return { error: "app id must be the numeric GitHub App ID" };
	}
	if (typeof key !== "string" || key.length < 1 || key.length > 20000) {
		return { error: "the private key must be a PEM RSA private key" };
	}
	const parsed = parseAppPem(key);
	if (parsed === null) {
		return { error: "the private key must be a PEM RSA private key" };
	}
	return { id, key, fingerprint: parsed.fingerprint };
}

export function signAppJwt(
	appId: string,
	keyObject: KeyObject,
	now: number,
): { jwt: string; iat: number; exp: number } {
	// JWT NumericDate claims are seconds; callers pass epoch milliseconds.
	const sec = Math.floor(now / 1000);
	const iat = sec - 60;
	const exp = iat + 600;
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ iat, exp, iss: appId }),
	).toString("base64url");
	const signature = cryptoSign(
		"RSA-SHA256",
		Buffer.from(`${header}.${payload}`),
		keyObject,
	).toString("base64url");
	return { jwt: `${header}.${payload}.${signature}`, iat, exp };
}

type CacheEntry = { token: string; until: number };

/**
 * Mints short-lived installation tokens for a configured GitHub App.
 * Cache lives in memory only; entries expire 5 minutes before the token does.
 */
export class AppTokenSource {
	private readonly appId: string;
	private readonly keyObject: KeyObject;
	private readonly fetchImpl: (
		url: string,
		init?: RequestInit,
	) => Promise<Response>;
	private readonly now: () => number;
	private readonly apiBase: string | undefined;
	/** Ceiling for each of the two calls a token mint makes. */
	private readonly timeoutMs: number;
	/** One token per "owner/repo": each mint is scoped to one repo of one installation. */
	private readonly cached = new Map<string, CacheEntry>();

	constructor(deps: {
		appId: string;
		keyObject: KeyObject;
		apiBase?: string;
		/** Ceiling in ms for each outbound call; defaults to APP_FETCH_TIMEOUT_MS. */
		timeoutMs?: number;
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
		now?: () => number;
	}) {
		this.appId = deps.appId;
		this.keyObject = deps.keyObject;
		this.apiBase = deps.apiBase;
		this.timeoutMs = deps.timeoutMs ?? APP_FETCH_TIMEOUT_MS;
		// No retry wrap here: the caller owns the policy. app.ts passes a fetch already
		// wrapped by withGithubRetry, and wrapping again would multiply the attempts.
		this.fetchImpl = deps.fetchImpl ?? noRedirectFetch;
		this.now = deps.now ?? (() => Date.now());
	}

	async tokenFor(owner: string, repo: string): Promise<string | null> {
		const base = this.apiBase ?? githubHost().apiBase;
		const now = this.now();
		const key = `${owner}/${repo}`;
		const hit = this.cached.get(key);
		if (hit !== undefined && now < hit.until) return hit.token;
		const { jwt } = signAppJwt(this.appId, this.keyObject, now);
		let lookup: Response;
		try {
			lookup = await this.fetchImpl(
				`${base}/repos/${owner}/${repo}/installation`,
				{
					signal: AbortSignal.timeout(this.timeoutMs),
					headers: {
						authorization: `Bearer ${jwt}`,
						accept: "application/vnd.github+json",
						"user-agent": "Ottr",
					},
				},
			);
		} catch (e) {
			throw new Error(`github app: ${errText(e, this.timeoutMs)}`);
		}
		if (lookup.status === 404) return null;
		if (!lookup.ok) {
			throw new Error(
				`github app: installation lookup answered ${lookup.status}`,
			);
		}
		const installation = (await lookup.json()) as { id?: unknown };
		if (typeof installation.id !== "number") {
			throw new Error("github app: installation lookup gave no id");
		}
		const fresh = signAppJwt(this.appId, this.keyObject, this.now());
		let created: Response;
		try {
			created = await this.fetchImpl(
				`${base}/app/installations/${installation.id}/access_tokens`,
				{
					method: "POST",
					signal: AbortSignal.timeout(this.timeoutMs),
					headers: {
						authorization: `Bearer ${fresh.jwt}`,
						accept: "application/vnd.github+json",
						"content-type": "application/json",
						"user-agent": "Ottr",
					},
					body: JSON.stringify({
						repositories: [repo],
						permissions: { pull_requests: "write" },
					}),
				},
			);
		} catch (e) {
			throw new Error(`github app: ${errText(e, this.timeoutMs)}`);
		}
		if (!created.ok) {
			throw new Error(`github app: access token answered ${created.status}`);
		}
		const body = (await created.json()) as {
			token?: unknown;
			expires_at?: unknown;
		};
		const token = typeof body.token === "string" ? body.token : "";
		if (token === "") {
			throw new Error("github app: access token gave no token");
		}
		if (typeof body.expires_at !== "string") return token;
		const until = Date.parse(body.expires_at) - 5 * 60_000;
		if (Number.isFinite(until) && until > this.now()) {
			this.cached.set(key, { token, until });
		}
		return token;
	}
}

/** The auth + accept headers every app-JWT lookup carries. */
function appHeaders(jwt: string): Record<string, string> {
	return {
		authorization: `Bearer ${jwt}`,
		accept: "application/vnd.github+json",
		"user-agent": "Ottr",
	};
}

/** Reads GET /app into name/url; a failed lookup (status or transport) sets error and ends the check. */
async function lookupApp(
	get: (path: string) => Promise<Response>,
	out: AppCheck,
	timeoutMs: number,
): Promise<boolean> {
	try {
		const app = await get("/app");
		if (!app.ok) {
			out.error = `app lookup answered ${app.status}`;
			return false;
		}
		const body = (await app.json()) as { name?: unknown; html_url?: unknown };
		out.name = typeof body.name === "string" ? body.name : null;
		out.url =
			typeof body.html_url === "string" && /^https:\/\//.test(body.html_url)
				? body.html_url
				: null;
	} catch (err) {
		// Network failures only; the key never reaches an error text from here.
		out.error = errText(err, timeoutMs);
		return false;
	}
	return true;
}

// A repo the app cannot see is private or gone; those get no outside PRs, so no
// warning names them. The probe sends no authorization header: the app JWT is only
// valid on /app and installation lookups, and a repo endpoint called with it answers
// 401. Unauthenticated, a public repo is 200 and a private or gone one 404 — exactly
// what the probe must tell apart.
async function probeMissingRepo(
	repo: string,
	base: string,
	out: AppCheck,
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	timeoutMs: number,
): Promise<void> {
	const probe = await fetchImpl(`${base}/repos/${repo}`, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "Ottr",
		},
	});
	if (probe.status === 404) {
		out.private.push(repo);
		return;
	}
	if (!probe.ok) {
		out.failed.push({
			repo,
			detail: `repo lookup answered ${probe.status}`,
		});
		return;
	}
	const probeBody = (await probe.json()) as { private?: unknown };
	if (probeBody.private === true) {
		out.private.push(repo);
		return;
	}
	out.missing.push(repo);
}

/**
 * One repo's verdict: installed, missing, private, or failed. A status other than 200
 * or 404, or a network error, lands in `failed`; one repo's failure never stops the rest.
 */
async function checkRepo(
	repo: string,
	get: (path: string) => Promise<Response>,
	base: string,
	out: AppCheck,
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	timeoutMs: number,
): Promise<void> {
	try {
		const res = await get(`/repos/${repo}/installation`);
		if (res.status === 404) {
			await probeMissingRepo(repo, base, out, fetchImpl, timeoutMs);
		} else if (!res.ok) {
			out.failed.push({
				repo,
				detail: `installation lookup answered ${res.status}`,
			});
		}
	} catch (err) {
		// One repo's network failure must not stop the other repos; the message
		// holds no key.
		out.failed.push({
			repo,
			detail: errText(err, timeoutMs),
		});
	}
}

/**
 * Reads the app's name (GET /app) and looks up its installation on each repo. A 404 marks the
 * repo missing, and the visibility probe for it goes out unauthenticated: GitHub answers 401
 * to a repo endpoint called with the app JWT. Every per-repo failure — a status other than
 * 200 or 404, or a network error — is recorded for that repo and the check goes on; only a
 * failed app lookup (status or transport) sets error and ends the check.
 */
export async function checkAppInstalls(deps: {
	appId: string;
	keyObject: KeyObject;
	repos: string[];
	apiBase?: string;
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	now?: () => number;
	/** Ceiling in ms for each outbound call; defaults to APP_FETCH_TIMEOUT_MS. */
	timeoutMs?: number;
}): Promise<AppCheck> {
	const base = deps.apiBase ?? githubHost().apiBase;
	// No retry wrap here either: the caller (app.ts) passes a fetch already wrapped
	// by withGithubRetry; wrapping again would multiply the attempts.
	const fetchImpl = deps.fetchImpl ?? noRedirectFetch;
	const now = deps.now ?? (() => Date.now());
	const timeoutMs = deps.timeoutMs ?? APP_FETCH_TIMEOUT_MS;
	const out: AppCheck = {
		at: now(),
		name: null,
		url: null,
		repos: deps.repos,
		missing: [],
		private: [],
		failed: [],
		error: null,
	};
	const get = (path: string) =>
		fetchImpl(`${base}${path}`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: appHeaders(signAppJwt(deps.appId, deps.keyObject, now()).jwt),
		});
	if (!(await lookupApp(get, out, timeoutMs))) return out;
	for (const repo of deps.repos) {
		await checkRepo(repo, get, base, out, fetchImpl, timeoutMs);
	}
	return out;
}

/** The board warning for a check, or null when the app sees every board repo and every lookup answered. Pure. */
export function appCheckWarning(check: AppCheck | null): string | null {
	if (check === null) return null;
	if (check.error !== null)
		return `The GitHub App check failed (${check.error}). PR reviews can post under your own identity: check the App ID and key under Settings - Git hosts.`;
	const parts: string[] = [];
	if (check.missing.length > 0) {
		const app = check.name ?? "The GitHub App";
		const install =
			check.url === null
				? "Install it from the app's page on GitHub."
				: `Install it at ${check.url}/installations/new.`;
		parts.push(
			`${app} is not installed on ${check.missing.join(", ")}. PR reviews there post under your own identity. ${install}`,
		);
	}
	if (check.failed.length > 0)
		parts.push(
			`The check failed for ${check.failed
				.map((f) => `${f.repo} (${f.detail})`)
				.join(", ")}.`,
		);
	return parts.length === 0 ? null : parts.join(" ");
}

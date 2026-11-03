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
	/** One token per "owner/repo": each mint is scoped to one repo of one installation. */
	private readonly cached = new Map<string, CacheEntry>();

	constructor(deps: {
		appId: string;
		keyObject: KeyObject;
		apiBase?: string;
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
		now?: () => number;
	}) {
		this.appId = deps.appId;
		this.keyObject = deps.keyObject;
		this.apiBase = deps.apiBase;
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
		const lookup = await this.fetchImpl(
			`${base}/repos/${owner}/${repo}/installation`,
			{
				headers: {
					authorization: `Bearer ${jwt}`,
					accept: "application/vnd.github+json",
					"user-agent": "Ottr",
				},
			},
		);
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
		const created = await this.fetchImpl(
			`${base}/app/installations/${installation.id}/access_tokens`,
			{
				method: "POST",
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

/**
 * Reads the app's name (GET /app) and looks up its installation on each repo. A 404 marks the
 * repo missing. Any other answer stops the check with an error that holds only the status.
 */
export async function checkAppInstalls(deps: {
	appId: string;
	keyObject: KeyObject;
	repos: string[];
	apiBase?: string;
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	now?: () => number;
}): Promise<AppCheck> {
	const base = deps.apiBase ?? githubHost().apiBase;
	const fetchImpl = deps.fetchImpl ?? noRedirectFetch;
	const now = deps.now ?? (() => Date.now());
	const out: AppCheck = {
		at: now(),
		name: null,
		url: null,
		repos: deps.repos,
		missing: [],
		private: [],
		error: null,
	};
	const get = (path: string) =>
		fetchImpl(`${base}${path}`, {
			headers: {
				authorization: `Bearer ${signAppJwt(deps.appId, deps.keyObject, now()).jwt}`,
				accept: "application/vnd.github+json",
				"user-agent": "Ottr",
			},
		});
	try {
		const app = await get("/app");
		if (!app.ok) {
			out.error = `app lookup answered ${app.status}`;
			return out;
		}
		const body = (await app.json()) as { name?: unknown; html_url?: unknown };
		out.name = typeof body.name === "string" ? body.name : null;
		out.url =
			typeof body.html_url === "string" && /^https:\/\//.test(body.html_url)
				? body.html_url
				: null;
		for (const repo of deps.repos) {
			const res = await get(`/repos/${repo}/installation`);
			if (res.status === 404) {
				// A repo the app cannot see is private or gone; those get no
				// outside PRs, so no warning names them.
				const probe = await get(`/repos/${repo}`);
				if (probe.status === 404) {
					out.private.push(repo);
					continue;
				}
				if (!probe.ok) {
					out.error = `repo lookup for ${repo} answered ${probe.status}`;
					return out;
				}
				const probeBody = (await probe.json()) as { private?: unknown };
				if (probeBody.private === true) {
					out.private.push(repo);
					continue;
				}
				out.missing.push(repo);
			} else if (!res.ok) {
				out.error = `installation lookup for ${repo} answered ${res.status}`;
				return out;
			}
		}
	} catch (err) {
		// Network failures only; the key never reaches an error text from here.
		out.error = err instanceof Error ? err.message : String(err);
	}
	return out;
}

/** The board warning for a check, or null when the app sees every board repo. Pure. */
export function appCheckWarning(check: AppCheck | null): string | null {
	if (check === null) return null;
	if (check.error !== null)
		return `The GitHub App check failed (${check.error}). PR reviews can post under your own identity: check the App ID and key under Settings - Git hosts.`;
	if (check.missing.length === 0) return null;
	const app = check.name ?? "The GitHub App";
	const install =
		check.url === null
			? "Install it from the app's page on GitHub."
			: `Install it at ${check.url}/installations/new.`;
	return `${app} is not installed on ${check.missing.join(", ")}. PR reviews there post under your own identity. ${install}`;
}

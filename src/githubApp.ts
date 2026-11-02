import type { KeyObject } from "node:crypto";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as cryptoSign,
} from "node:crypto";
import { noRedirectFetch } from "./alate.ts";

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
	const iat = now - 60;
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
	private cached: CacheEntry | null = null;

	constructor(deps: {
		appId: string;
		keyObject: KeyObject;
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
		now?: () => number;
	}) {
		this.appId = deps.appId;
		this.keyObject = deps.keyObject;
		this.fetchImpl = deps.fetchImpl ?? noRedirectFetch;
		this.now = deps.now ?? (() => Date.now());
	}

	async tokenFor(owner: string, repo: string): Promise<string | null> {
		const now = this.now();
		if (this.cached !== null && now < this.cached.until)
			return this.cached.token;
		const { jwt } = signAppJwt(this.appId, this.keyObject, now);
		const lookup = await this.fetchImpl(
			`https://api.github.com/repos/${owner}/${repo}/installation`,
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
			`https://api.github.com/app/installations/${installation.id}/access_tokens`,
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
			this.cached = { token, until };
		}
		return token;
	}
}

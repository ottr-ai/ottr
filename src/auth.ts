// *arr-style single-admin auth: scrypt password hashing and HMAC session tokens.
// Only public-host requests consult this (see server.ts); loopback stays zero-auth.

import {
	createHmac,
	randomBytes,
	scryptSync,
	timingSafeEqual,
} from "node:crypto";

export const SESSION_COOKIE = "ottr.session";
/** 30 days, in the seconds the cookie's Max-Age wants and the ms signSession wants. */
export const SESSION_MAX_AGE = 2592000;
export const SESSION_MS = SESSION_MAX_AGE * 1000;

/** scrypt hash stored as `salt:hash` hex (16B salt, 64B key). */
export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	return `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [saltHex, hashHex] = stored.split(":");
	if (saltHex === undefined || hashHex === undefined) return false;
	try {
		const expected = Buffer.from(hashHex, "hex");
		if (expected.length !== 64) return false;
		return timingSafeEqual(
			scryptSync(password, Buffer.from(saltHex, "hex"), 64),
			expected,
		);
	} catch {
		return false; // malformed stored hash
	}
}

/** 32 random bytes hex; the shape of sessionSecret and apiKey. */
export function newSecret(): string {
	return randomBytes(32).toString("hex");
}

/**
 * /api/login's name+password check. Unknown names burn one full-cost scrypt before
 * returning, so response time cannot reveal whether the admin name was guessed.
 */
export function verifyAdminLogin(
	name: string,
	password: string,
	admin: { name: string; passHash: string },
): boolean {
	if (name !== admin.name) {
		scryptSync(password, "burn", 64);
		return false;
	}
	return verifyPassword(password, admin.passHash);
}

/** Sliding-window login attempt limit: per source and global, so rotating addresses still stalls. */
export class LoginLimiter {
	#attempts: { at: number; source: string }[] = [];

	constructor(
		private readonly windowMs: number,
		private readonly maxPerSource: number,
		private readonly maxGlobal: number,
	) {}

	/** True when `source` may attempt a login now; prunes attempts that left the window. */
	allowed(source: string, now = Date.now()): boolean {
		const live = this.#attempts.filter((a) => now - a.at < this.windowMs);
		this.#attempts = live;
		return (
			live.length < this.maxGlobal &&
			live.filter((a) => a.source === source).length < this.maxPerSource
		);
	}

	recordFailed(source: string, now = Date.now()): void {
		this.#attempts.push({ at: now, source });
	}
}

function mac(secret: string, base: string): string {
	return createHmac("sha256", secret).update(base).digest("base64url");
}

/** Constant-time string compare; HMACing both sides makes lengths equal first. */
export function secretsEqual(a: string, b: string): boolean {
	return timingSafeEqual(
		Buffer.from(mac("cmp", a)),
		Buffer.from(mac("cmp", b)),
	);
}

/**
 * `encodedName.exp.hmac` token. The name is percent-encoded so a ';' or space in it cannot
 * truncate the cookie value or the token shape; base64url HMACs never contain dots, so the
 * split from the END, twice, is unambiguous.
 */
export function signSession(
	secret: string,
	name: string,
	expMs: number,
): string {
	const base = `${encodeURIComponent(name)}.${Date.now() + expMs}`;
	return `${base}.${mac(secret, base)}`;
}

/** Returns the session's admin name, or null for tampered/expired/garbled tokens. */
export function verifySession(secret: string, token: string): string | null {
	const m = token.lastIndexOf(".");
	const b = token.lastIndexOf(".", m - 1);
	if (m < 0 || b < 0) return null;
	const expected = mac(secret, token.slice(0, m));
	const got = token.slice(m + 1);
	if (
		got.length !== expected.length ||
		!timingSafeEqual(Buffer.from(got), Buffer.from(expected))
	)
		return null;
	const exp = Number(token.slice(b + 1, m));
	if (!Number.isInteger(exp) || Date.now() > exp) return null;
	try {
		return decodeURIComponent(token.slice(0, b));
	} catch {
		return null;
	}
}

export function parseCookies(header: string | null): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	if (header === null) return out;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return out;
}

/** `Secure` only on public hosts: loopback is plain http, HTTPS arrives via tailscale serve. remember=false emits a session cookie (no Max-Age); it dies with the browser session. */
export function sessionCookie(
	token: string,
	secure: boolean,
	remember = true,
): string {
	const parts = [
		`${SESSION_COOKIE}=${token}`,
		"HttpOnly",
		"Path=/",
		"SameSite=Lax",
	];
	if (remember) parts.push(`Max-Age=${SESSION_MAX_AGE}`);
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
	return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

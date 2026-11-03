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

export interface SessionEntry {
	id: string;
	label: string;
	createdAt: number;
	lastSeen: number;
	exp: number;
}

/** Maximum registry entries; the least recently active is dropped first. */
export const SESSIONS_CAP = 50;

/** 12 random bytes hex; the shape of a registry entry id. */
export function newSessionId(): string {
	return randomBytes(12).toString("hex");
}

/**
 * `<browser> on <OS>` label from a User-Agent. Edge/Opera win over Chrome, Chrome wins over
 * Safari; anything unrecognized is named honestly or as Unknown. The raw UA is never stored.
 */
export function sessionLabel(ua: string | null): string {
	if (ua === null || ua.trim() === "") return "Unknown browser on Unknown OS";
	const s = (needle: string) => ua.includes(needle);
	let browser = "Unknown browser";
	if (s("Edg/")) browser = "Edge";
	else if (s("OPR/")) browser = "Opera";
	else if (s("Chromium")) browser = "Chromium";
	else if (s("Chrome")) browser = "Chrome";
	else if (s("Firefox")) browser = "Firefox";
	else if (s("Safari")) browser = "Safari";
	else if (/^[A-Za-z][A-Za-z0-9._-]*\/\S/.test(ua)) {
		const name = /^([A-Za-z][A-Za-z0-9._-]*)\//.exec(ua)?.[1];
		if (name !== undefined) browser = name;
	}
	let os = "Unknown OS";
	if (s("Windows")) os = "Windows";
	// iPhone/iPad UAs contain "Mac OS X", so iOS must win over macOS.
	else if (s("Android")) os = "Android";
	else if (s("iPhone") || s("iPad")) os = "iOS";
	else if (s("Mac OS X")) os = "macOS";
	else if (s("CrOS")) os = "ChromeOS";
	else if (s("Linux")) os = "Linux";
	return `${browser} on ${os}`;
}

/**
 * Adds one entry to the registry: drops expired entries, replaces an entry with the same id,
 * then caps the list by dropping the entry with the oldest lastSeen. Returns a new array.
 */
export function addSession(
	list: SessionEntry[],
	entry: SessionEntry,
): SessionEntry[] {
	const now = Date.now();
	const out = list.filter((s) => s.exp > now && s.id !== entry.id);
	out.push(entry);
	// Newest first, then truncate: the 50 most recently active survive, so the
	// cap never evicts a live session ahead of a stale one.
	if (out.length > SESSIONS_CAP) {
		out.sort((a, b) => b.lastSeen - a.lastSeen);
		out.length = SESSIONS_CAP;
	}
	return out;
}

/** Returns the list without the entry with the given id. */
export function dropSession(list: SessionEntry[], id: string): SessionEntry[] {
	return list.filter((s) => s.id !== id);
}

/**
 * `encodedName[.id].exp.hmac` token. The name is percent-encoded so a ';' or space in it cannot
 * truncate the cookie value or the token shape; base64url HMACs never contain dots, so the
 * split from the END, twice, is unambiguous. An id signs a fourth part; legacy tokens keep
 * the three-part shape.
 */
export function signSession(
	secret: string,
	name: string,
	expMs: number,
	id?: string,
): string {
	const idPart = id === undefined ? "" : `.${id}`;
	const base = `${encodeURIComponent(name)}${idPart}.${Date.now() + expMs}`;
	return `${base}.${mac(secret, base)}`;
}

/** Returns the session's name and id, or null for tampered/expired/garbled tokens. Legacy three-part tokens carry id null. */
export function verifySession(
	secret: string,
	token: string,
): { name: string; id: string | null } | null {
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
	let id: string | null = null;
	let head = token.slice(0, b);
	const i = token.lastIndexOf(".", b - 1);
	// A middle segment is the session id only when it has the exact shape
	// newSessionId mints (24 lowercase hex): a legacy name that contains dots
	// must not lose its tail to the wider parse. A wrong guess fails closed —
	// the registry lookup rejects an id no login ever minted.
	const maybe = i >= 0 ? token.slice(i + 1, b) : "";
	if (/^[0-9a-f]{24}$/.test(maybe)) {
		id = maybe;
		head = token.slice(0, i);
	}
	try {
		return { name: decodeURIComponent(head), id };
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

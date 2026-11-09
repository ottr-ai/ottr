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
 * Hosted mode (docs/specs/hosted-mode.md): the control-plane proxy signs every request it forwards
 * with `X-Ottr-Identity: v1.<tenant>.<role>.<ts>.<nonce>.<sig>`, sig = base64url
 * HMAC-SHA256(secret, `ottr-identity.v1.<tenant>.<role>.<ts>.<nonce>`). No part can hold a
 * dot, so the split is exact. `owner` is a browser request the proxy authenticated; `control`
 * is the control plane itself (credit stop); `tenant` signs this board's own calls out.
 */
export const IDENTITY_HEADER = "x-ottr-identity";
export const IDENTITY_ROLES = ["owner", "control", "tenant"] as const;
export type IdentityRole = (typeof IDENTITY_ROLES)[number];
/** Seconds a signed header stays valid on either side of the board's clock. */
export const IDENTITY_WINDOW_S = 60;
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function validTenantId(id: string): boolean {
	return TENANT_RE.test(id);
}

function identityBase(
	tenant: string,
	role: IdentityRole,
	ts: number,
	nonce: string,
): string {
	return `ottr-identity.v1.${tenant}.${role}.${ts}.${nonce}`;
}

/** Mints one header value; nonce defaults to 18 random bytes. */
export function signIdentity(
	secret: string,
	tenant: string,
	role: IdentityRole,
	nowMs = Date.now(),
	nonce = randomBytes(18).toString("base64url"),
): string {
	const ts = Math.floor(nowMs / 1000);
	const sig = mac(secret, identityBase(tenant, role, ts, nonce));
	return `v1.${tenant}.${role}.${ts}.${nonce}.${sig}`;
}

/**
 * Remembers every accepted nonce until its header could no longer pass the window, so a
 * captured header replays never. Bounded: when `max` live nonces are held, new headers are
 * refused (fail closed) instead of evicting a live entry a replay could then reuse.
 */
export class NonceCache {
	#seen = new Map<string, number>();
	constructor(readonly max = 100_000) {}

	/** True and remembers the nonce when it is new; false for a replay or a full cache. */
	claim(nonce: string, expiresAtMs: number, nowMs = Date.now()): boolean {
		if (this.#seen.has(nonce)) {
			if ((this.#seen.get(nonce) ?? 0) > nowMs) return false;
			this.#seen.delete(nonce);
		}
		if (this.#seen.size >= this.max) this.#sweep(nowMs);
		if (this.#seen.size >= this.max) return false;
		this.#seen.set(nonce, expiresAtMs);
		return true;
	}

	get size(): number {
		return this.#seen.size;
	}

	#sweep(nowMs: number): void {
		for (const [n, exp] of this.#seen) if (exp <= nowMs) this.#seen.delete(n);
	}
}

export type IdentityCheck =
	| { ok: true; role: IdentityRole }
	| { ok: false; reason: string };

/**
 * Verifies one header value for this tenant: shape, tenant, HMAC (constant time), timestamp
 * window, then the nonce (claimed only after the signature passed, so forged headers cannot
 * fill the cache).
 */
export function verifyIdentity(
	header: string | null,
	opts: { secret: string; tenant: string; nonces: NonceCache },
	nowMs = Date.now(),
): IdentityCheck {
	if (header === null || header === "") return { ok: false, reason: "missing" };
	const parts = header.split(".");
	if (parts.length !== 6 || parts[0] !== "v1")
		return { ok: false, reason: "malformed" };
	const [, tenant = "", role = "", tsText = "", nonce = "", sig = ""] = parts;
	if (
		!TENANT_RE.test(tenant) ||
		!(IDENTITY_ROLES as readonly string[]).includes(role) ||
		!/^[0-9]{1,12}$/.test(tsText) ||
		!NONCE_RE.test(nonce)
	)
		return { ok: false, reason: "malformed" };
	const ts = Number(tsText);
	const expected = mac(
		opts.secret,
		identityBase(tenant, role as IdentityRole, ts, nonce),
	);
	if (!secretsEqual(sig, expected)) return { ok: false, reason: "signature" };
	if (!secretsEqual(tenant, opts.tenant))
		return { ok: false, reason: "tenant" };
	const nowS = nowMs / 1000;
	if (Math.abs(nowS - ts) > IDENTITY_WINDOW_S)
		return { ok: false, reason: "expired" };
	if (!opts.nonces.claim(nonce, (ts + IDENTITY_WINDOW_S + 1) * 1000, nowMs))
		return { ok: false, reason: "replay" };
	return { ok: true, role: role as IdentityRole };
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

/** Name of the first matching browser in the UA, or an honest token-name fallback. */
function detectBrowser(ua: string): string {
	const s = (needle: string) => ua.includes(needle);
	if (s("Edg/")) return "Edge";
	if (s("OPR/")) return "Opera";
	if (s("Chromium")) return "Chromium";
	if (s("Chrome")) return "Chrome";
	if (s("Firefox")) return "Firefox";
	if (s("Safari")) return "Safari";
	if (/^[A-Za-z][A-Za-z0-9._-]*\/\S/.test(ua)) {
		const name = /^([A-Za-z][A-Za-z0-9._-]*)\//.exec(ua)?.[1];
		if (name !== undefined) return name;
	}
	return "Unknown browser";
}

/** Name of the first matching OS in the UA; iPhone/iPad UAs contain "Mac OS X", so iOS wins. */
function detectOs(ua: string): string {
	const s = (needle: string) => ua.includes(needle);
	if (s("Windows")) return "Windows";
	if (s("Android")) return "Android";
	if (s("iPhone") || s("iPad")) return "iOS";
	if (s("Mac OS X")) return "macOS";
	if (s("CrOS")) return "ChromeOS";
	if (s("Linux")) return "Linux";
	return "Unknown OS";
}

/**
 * `<browser> on <OS>` label from a User-Agent. Edge/Opera win over Chrome, Chrome wins over
 * Safari; anything unrecognized is named honestly or as Unknown. The raw UA is never stored.
 */
export function sessionLabel(ua: string | null): string {
	if (ua === null || ua.trim() === "") return "Unknown browser on Unknown OS";
	return `${detectBrowser(ua)} on ${detectOs(ua)}`;
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

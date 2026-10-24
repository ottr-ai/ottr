import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	clearSessionCookie,
	hashPassword,
	LoginLimiter,
	newSecret,
	parseCookies,
	SESSION_COOKIE,
	SESSION_MAX_AGE,
	secretsEqual,
	sessionCookie,
	signSession,
	verifyAdminLogin,
	verifyPassword,
	verifySession,
} from "./auth.ts";
import fc from "./test/properties.ts";

describe("hashPassword / verifyPassword", () => {
	test("round-trips the right password, rejects the wrong one", () => {
		const stored = hashPassword("correct horse battery staple");
		expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
		expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
		expect(verifyPassword("wrong", stored)).toBe(false);
	});
	test("salt is random: two hashes of one password differ", () => {
		expect(hashPassword("x8chars")).not.toBe(hashPassword("x8chars"));
	});
	test("malformed stored hashes fail closed", () => {
		expect(verifyPassword("pw", "no-separator")).toBe(false);
		expect(verifyPassword("pw", "zz:zz")).toBe(false);
		expect(verifyPassword("pw", "")).toBe(false);
	});
});

describe("signSession / verifySession", () => {
	const secret = newSecret();
	test("round-trips the name", () => {
		expect(verifySession(secret, signSession(secret, "ada", 60_000))).toBe(
			"ada",
		);
	});
	test("a name with dots survives (token splits from the END)", () => {
		expect(verifySession(secret, signSession(secret, "a.b.c", 60_000))).toBe(
			"a.b.c",
		);
	});
	test("a ';' in the name survives browser cookie truncation", () => {
		const token = signSession(secret, "a;b", 60_000);
		expect(token).not.toContain(";");
		expect(verifySession(secret, token)).toBe("a;b");
		// A browser keeps only the value up to the first ';' (RFC 6265). The value the
		// browser stores must still verify: old code put the raw ';' in the cookie and
		// truncated to 'a', so every later request got 401.
		expect(verifySession(secret, token.split(";")[0] ?? "")).toBe("a;b");
	});
	test("expired tokens are rejected", () => {
		const token = signSession(secret, "ada", -1000);
		expect(verifySession(secret, token)).toBe(null);
	});
	test("tampering with any part is rejected", () => {
		const token = signSession(secret, "ada", 60_000);
		const [name, exp, mac] = token.split(".");
		if (exp === undefined || mac === undefined)
			throw new Error("bad fixture token");
		expect(verifySession(secret, `eve.${exp}.${mac}`)).toBe(null);
		expect(
			verifySession(secret, `${name}.${exp}.${"A".repeat(mac.length)}`),
		).toBe(null);
		const flipped = `${name}.${Number(exp) + 1}.${mac}`;
		expect(verifySession(secret, flipped)).toBe(null);
	});
	test("the wrong secret is rejected, and garbage does not throw", () => {
		expect(verifySession(newSecret(), signSession(secret, "ada", 60_000))).toBe(
			null,
		);
		expect(verifySession(secret, "ada")).toBe(null);
		expect(verifySession(secret, "")).toBe(null);
	});
});

describe("secretsEqual", () => {
	test("matches equal secrets only, at any length", () => {
		expect(secretsEqual("abc", "abc")).toBe(true);
		expect(secretsEqual("abc", "abd")).toBe(false);
		expect(secretsEqual("abc", "abcd")).toBe(false);
	});
});

describe("cookies", () => {
	test("parseCookies reads pairs and tolerates junk", () => {
		expect(parseCookies(`${SESSION_COOKIE}=a.b.c`)[SESSION_COOKIE]).toBe(
			"a.b.c",
		);
		expect(parseCookies("other=x; ottr.session=n.e.m")["ottr.session"]).toBe(
			"n.e.m",
		);
		expect(parseCookies("nonsense")).toEqual({});
		expect(parseCookies(null)).toEqual({});
	});
	test("cookie attributes: HttpOnly, Lax, 30d, Secure only on public hosts", () => {
		const c = sessionCookie("tok", true);
		expect(c).toContain(`${SESSION_COOKIE}=tok`);
		expect(c).toContain("HttpOnly");
		expect(c).toContain("SameSite=Lax");
		expect(c).toContain("Max-Age=2592000");
		expect(c).toContain("Secure");
		expect(sessionCookie("tok", true)).toBe(
			`${SESSION_COOKIE}=tok; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}; Secure`,
		);
		expect(sessionCookie("tok", false)).toBe(
			`${SESSION_COOKIE}=tok; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
		);
		expect(sessionCookie("tok", false)).not.toContain("Secure");
		const session = sessionCookie("tok", true, false);
		expect(session).toContain("HttpOnly");
		expect(session).toContain("SameSite=Lax");
		expect(session).toContain("Secure");
		expect(session).not.toContain("Max-Age");
		const cleared = clearSessionCookie(true);
		expect(cleared).toContain("Max-Age=0");
		expect(cleared).toContain("Secure");
	});
});

describe("verifyAdminLogin", () => {
	const admin = { name: "ada", passHash: hashPassword("correct horse") };
	test("accepts the right name and password", () => {
		expect(verifyAdminLogin("ada", "correct horse", admin)).toBe(true);
	});
	test("rejects a wrong password for the right name", () => {
		expect(verifyAdminLogin("ada", "wrong", admin)).toBe(false);
	});
	test("an unknown name pays the same scrypt cost as a known one", () => {
		// The known-name path runs a full scryptSync inside verifyPassword; the
		// unknown-name path must burn one too, or response time leaks the name.
		const timed = (fn: () => boolean): number => {
			const t = performance.now();
			fn();
			return performance.now() - t;
		};
		const known = timed(() => verifyAdminLogin("ada", "wrong", admin));
		const unknown = timed(() => verifyAdminLogin("nobody", "wrong", admin));
		expect(unknown).toBeGreaterThan(known / 3);
	});
});

describe("LoginLimiter", () => {
	test("caps failures per source, leaving other sources free", () => {
		const l = new LoginLimiter(60_000, 3, 100);
		for (let i = 0; i < 3; i++) {
			expect(l.allowed("a", 0)).toBe(true);
			l.recordFailed("a", 0);
		}
		expect(l.allowed("a", 1)).toBe(false);
		expect(l.allowed("b", 1)).toBe(true);
	});
	test("caps failures globally across sources", () => {
		const l = new LoginLimiter(60_000, 100, 5);
		for (let i = 0; i < 5; i++) l.recordFailed(`s${i}`, 0);
		expect(l.allowed("new", 1)).toBe(false);
	});
	test("old attempts leave the window", () => {
		const l = new LoginLimiter(60_000, 2, 100);
		l.recordFailed("a", 0);
		l.recordFailed("a", 0);
		expect(l.allowed("a", 59_999)).toBe(false);
		expect(l.allowed("a", 60_000)).toBe(true);
	});
});

describe("arch-review changed-line coverage", () => {
	const secret = newSecret();
	test("names with spaces and semicolons round-trip and keep the token shape", () => {
		const token = signSession(secret, "ada lovelace; ok", 60_000);
		expect(token.split(".")).toHaveLength(3);
		expect(verifySession(secret, token)).toBe("ada lovelace; ok");
	});
	test("a name part that is not valid percent-encoding is rejected", () => {
		// "%" alone is a malformed escape: decodeURIComponent throws, and the
		// catch must swallow it into null instead of leaking the raw string.
		const base = `%.${Date.now() + 60_000}`;
		const mac = createHmac("sha256", secret).update(base).digest("base64url");
		expect(verifySession(secret, `${base}.${mac}`)).toBe(null);
	});
});

describe("parseCookies properties", () => {
	const tokenChar = fc.constantFrom(
		..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~%",
	);

	test("never throws on any header string", () => {
		fc.assert(
			fc.property(fc.string(), (header) => {
				expect(() => parseCookies(header)).not.toThrow();
			}),
			// pinned: "__proto__=a" must land as an own key, not hit the Object setter
			{ examples: [["__proto__=a"]] },
		);
		const poisoned = parseCookies("__proto__=a");
		expect(Object.hasOwn(poisoned, "__proto__")).toBe(true);
		expect(Reflect.get(poisoned, "__proto__")).toBe("a");
	});

	test("token-safe name/value pairs round-trip", () => {
		const pair = fc
			.record({ n: tokenChar, v: tokenChar })
			.filter((p) => p.n.length > 0);
		fc.assert(
			fc.property(fc.array(pair, { maxLength: 20 }), (pairs) => {
				fc.pre(new Set(pairs.map((p) => p.n)).size === pairs.length);
				const header = pairs.map((p) => `${p.n}=${p.v}`).join("; ");
				const out = parseCookies(header);
				for (const { n, v } of pairs) {
					expect(Object.hasOwn(out, n)).toBe(true);
					expect(out[n]).toBe(v);
				}
			}),
		);
	});
});

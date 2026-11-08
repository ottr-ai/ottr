import { describe, expect, test } from "bun:test";
import { NonceCache, signIdentity, verifyIdentity } from "./auth.ts";
import fc from "./test/properties.ts";

// Hosted mode's identity header (docs/specs/hosted-mode.md section 2).
const SECRET = "s".repeat(40);
const TENANT = "acme";
const NOW = 1_800_000_000_000;

const check = (
	header: string | null,
	opts: { secret?: string; nonces?: NonceCache; now?: number } = {},
) =>
	verifyIdentity(
		header,
		{
			secret: opts.secret ?? SECRET,
			tenant: TENANT,
			nonces: opts.nonces ?? new NonceCache(),
		},
		opts.now ?? NOW,
	);

const nonce = (n: number) => `nonce-${String(n).padStart(12, "0")}`;

describe("signIdentity / verifyIdentity", () => {
	test("a signed header verifies with its role", () => {
		for (const role of ["owner", "control", "tenant"] as const)
			expect(check(signIdentity(SECRET, TENANT, role, NOW))).toEqual({
				ok: true,
				role,
			});
	});

	test("another secret fails the signature", () => {
		const header = signIdentity("x".repeat(40), TENANT, "owner", NOW);
		expect(check(header)).toEqual({ ok: false, reason: "signature" });
	});

	test("a header signed for another tenant is refused", () => {
		const header = signIdentity(SECRET, "other", "owner", NOW);
		expect(check(header)).toEqual({ ok: false, reason: "tenant" });
	});

	test("a timestamp more than 60 s from now, on either side, is expired", () => {
		for (const skew of [-61_000, 61_000])
			expect(check(signIdentity(SECRET, TENANT, "owner", NOW + skew))).toEqual({
				ok: false,
				reason: "expired",
			});
		for (const skew of [-60_000, 60_000])
			expect(check(signIdentity(SECRET, TENANT, "owner", NOW + skew)).ok).toBe(
				true,
			);
	});

	test("the same header passes once, then is a replay", () => {
		const nonces = new NonceCache();
		const header = signIdentity(SECRET, TENANT, "owner", NOW);
		expect(check(header, { nonces }).ok).toBe(true);
		expect(check(header, { nonces, now: NOW + 30_000 })).toEqual({
			ok: false,
			reason: "replay",
		});
	});

	test("malformed shapes are refused before the signature", () => {
		const good = signIdentity(SECRET, TENANT, "owner", NOW, nonce(1));
		const parts = good.split(".");
		const ts = parts[3] ?? "";
		const sig = parts[5] ?? "";
		const bad = [
			parts.slice(0, 5).join("."),
			`${good}.extra`,
			`v2.${parts.slice(1).join(".")}`,
			`v1.${TENANT}.admin.${ts}.${nonce(1)}.${sig}`,
			`v1.${TENANT}.owner.${ts}.short-nonce.${sig}`,
			`v1.${TENANT}.owner.${ts}.${"n".repeat(129)}.${sig}`,
			`v1.${TENANT}.owner.${ts}.nonce+with/slash.${sig}`,
			`v1.${TENANT}.owner.12a4.${nonce(1)}.${sig}`,
			`v1.${TENANT}.owner.-1.${nonce(1)}.${sig}`,
			`v1.Acme.owner.${ts}.${nonce(1)}.${sig}`,
		];
		for (const header of bad)
			expect(check(header)).toEqual({ ok: false, reason: "malformed" });
		// A dotted nonce changes the part count, so it is malformed too.
		expect(
			check(`v1.${TENANT}.owner.${ts}.nonce-part.two-part.${sig}`),
		).toEqual({ ok: false, reason: "malformed" });
		expect(check(null)).toEqual({ ok: false, reason: "missing" });
		expect(check("")).toEqual({ ok: false, reason: "missing" });
	});

	test("a full nonce cache refuses new headers until entries expire", () => {
		const nonces = new NonceCache(2);
		const sign = (n: number, at: number) =>
			signIdentity(SECRET, TENANT, "owner", at, nonce(n));
		expect(check(sign(1, NOW), { nonces }).ok).toBe(true);
		expect(check(sign(2, NOW), { nonces }).ok).toBe(true);
		// Fail closed: a fresh, valid header is refused while the cache holds 2 live nonces.
		expect(check(sign(3, NOW), { nonces })).toEqual({
			ok: false,
			reason: "replay",
		});
		expect(nonces.size).toBe(2);
		// Past the window of the first two headers their entries are swept: room again.
		const later = NOW + 62_000;
		expect(check(sign(3, later), { nonces, now: later }).ok).toBe(true);
		expect(check(sign(4, later), { nonces, now: later }).ok).toBe(true);
		expect(nonces.size).toBe(2);
	});

	test("NonceCache.claim refuses a live nonce and reuses an expired one", () => {
		const nonces = new NonceCache(1);
		expect(nonces.claim("a", NOW + 1000, NOW)).toBe(true);
		expect(nonces.claim("a", NOW + 1000, NOW + 500)).toBe(false);
		expect(nonces.claim("b", NOW + 2000, NOW + 500)).toBe(false);
		expect(nonces.claim("b", NOW + 3000, NOW + 1000)).toBe(true);
		expect(nonces.claim("a", NOW + 3000, NOW + 1000)).toBe(false);
	});

	test("property: changing any one character of a valid header is refused", () => {
		const alphabet =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.";
		fc.assert(
			fc.property(
				fc.nat(),
				fc.integer({ min: 0, max: alphabet.length - 1 }),
				(at, pick) => {
					const header = signIdentity(SECRET, TENANT, "owner", NOW);
					const i = at % header.length;
					let c = alphabet[pick] ?? "A";
					if (c === header[i])
						c = alphabet[(pick + 1) % alphabet.length] ?? "A";
					const mutated = header.slice(0, i) + c + header.slice(i + 1);
					expect(check(mutated).ok).toBe(false);
				},
			),
		);
	});
});

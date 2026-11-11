import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { migrateSealedConfig, sealStoredConfigRow } from "./sealedConfig.ts";
import { isSealed, loadSecretBox } from "./secretBox.ts";

const box = loadSecretBox({
	dir: "/tmp/ottr-sealed-config-test",
	env: { OTTR_SECRET_KEY: "cd".repeat(32) },
});

/** A row carrying every ADR-0011 spot as plaintext. */
function fullRow(): Record<string, unknown> {
	return {
		maxTotal: 3,
		admin: { name: "op", passHash: "scrypt-hash" },
		apiKey: "api-plain",
		sessionSecret: "session-plain",
		sessions: [{ id: "s1", label: "l", createdAt: 1, lastSeen: 1, exp: 2 }],
		vapid: {
			publicKey: "pub",
			privateKey: "vapid-priv-plain",
			subject: "mailto:ottr@localhost",
		},
		alate: { url: "http://alate:8080", key: "alate-plain" },
		githubToken: "ghp_plain",
		githubHost: "github.com",
		gitTokens: [
			{ host: "github.com", username: "u", token: "git-token-plain" },
			{ host: "git.example.com:8443", username: "v", token: "second-plain" },
		],
		githubApp: { id: "1234", key: "-----BEGIN RSA PRIVATE KEY-----" },
		envValues: { HINDSIGHT_API_TOKEN: "env-plain", OTHER: "env-two" },
		hindsightToken: "hs-plain",
		hindsightUrl: "http://hs",
	};
}

describe("sealStoredConfigRow", () => {
	test("seals every ADR-0011 spot and leaves the rest untouched", () => {
		const row = fullRow();
		const out = sealStoredConfigRow(row, box) as {
			row: Record<string, unknown>;
			changed: boolean;
		};
		expect(out.changed).toBe(true);
		const r = out.row as Record<string, unknown>;
		expect(isSealed(r.apiKey)).toBe(true);
		expect(isSealed(r.sessionSecret)).toBe(true);
		expect(isSealed(r.githubToken)).toBe(true);
		expect(isSealed(r.hindsightToken)).toBe(true);
		expect(isSealed((r.alate as Record<string, string>).key)).toBe(true);
		expect(isSealed((r.githubApp as Record<string, string>).key)).toBe(true);
		expect(isSealed((r.vapid as Record<string, string>).privateKey)).toBe(true);
		for (const v of Object.values(r.envValues as Record<string, string>))
			expect(isSealed(v)).toBe(true);
		for (const t of r.gitTokens as Record<string, string>[])
			expect(isSealed(t.token)).toBe(true);
		// Unsealed spots keep their values; the box opens every blob back to the plaintext.
		expect(box.open(r.apiKey as string)).toBe("api-plain");
		expect(box.open((r.alate as Record<string, string>).key as string)).toBe(
			"alate-plain",
		);
		expect(
			box.open((r.vapid as Record<string, string>).privateKey as string),
		).toBe("vapid-priv-plain");
		expect(
			box.open((r.gitTokens as Record<string, string>[])[1]!.token as string),
		).toBe("second-plain");
		expect(
			box.open((r.envValues as Record<string, string>).OTHER as string),
		).toBe("env-two");
		expect(r.admin).toEqual({ name: "op", passHash: "scrypt-hash" });
		expect(r.sessions).toEqual(fullRow().sessions);
		expect((r.vapid as Record<string, string>).publicKey).toBe("pub");
		expect((r.githubApp as Record<string, string>).id).toBe("1234");
		expect(r.githubHost).toBe("github.com");
		expect(r.hindsightUrl).toBe("http://hs");
		// The input row is never mutated.
		expect(row.apiKey).toBe("api-plain");
	});

	test("is idempotent: a second run changes nothing", () => {
		const once = sealStoredConfigRow(fullRow(), box).row;
		const twice = sealStoredConfigRow(once, box);
		expect(twice.changed).toBe(false);
		expect(twice.row).toEqual(once);
	});

	test("empty strings and non-strings pass through unsealed", () => {
		const out = sealStoredConfigRow(
			{ apiKey: "", sessionSecret: 5, alate: { url: "u", key: "" } },
			box,
		);
		expect(out.changed).toBe(false);
		expect(out.row).toEqual({
			apiKey: "",
			sessionSecret: 5,
			alate: { url: "u", key: "" },
		});
	});

	test("a non-object row passes through", () => {
		expect(sealStoredConfigRow(null, box)).toEqual({
			row: null,
			changed: false,
		});
	});

	test("migrateSealedConfig seals in place and writes only on change", () => {
		let stored: unknown = fullRow();
		let writes = 0;
		const gstore = {
			get<T>(): T | null {
				return stored as T;
			},
			set(_key: string, value: unknown): void {
				stored = value;
				writes++;
			},
		};
		migrateSealedConfig(gstore, box);
		expect(writes).toBe(1);
		expect(isSealed((stored as Record<string, unknown>).apiKey as string)).toBe(
			true,
		);
		migrateSealedConfig(gstore, box);
		expect(writes).toBe(1);
		// Without the box the migration is a no-op.
		migrateSealedConfig(gstore, undefined);
		expect(writes).toBe(1);
	});

	test("property: re-sealing an already sealed row is a no-op and seals open back", () => {
		const printable = fc
			.string({
				unit: fc.constantFrom(
					..."abcdefghijklmnopqrstuvwxyz0123456789-_.@".split(""),
				),
				minLength: 1,
			})
			.filter((s) => !isSealed(s));
		const prop = fc.property(
			printable,
			printable,
			printable,
			(api, token, envVal) => {
				const row = {
					apiKey: api,
					githubToken: token,
					envValues: { K: envVal },
					gitTokens: [{ host: "h", username: "u", token }],
					admin: { passHash: "hash" },
				};
				const once = sealStoredConfigRow(row, box);
				expect(once.changed).toBe(true);
				const twice = sealStoredConfigRow(once.row, box);
				expect(twice.changed).toBe(false);
				expect(twice.row).toEqual(once.row);
				const r = once.row as Record<string, unknown>;
				expect(box.open(r.apiKey as string)).toBe(api);
				expect(isSealed(box.seal(envVal))).toBe(true);
			},
		);
		fc.assert(prop, { seed: 42, numRuns: 150 });
	});
});

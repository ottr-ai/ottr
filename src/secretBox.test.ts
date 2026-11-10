import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { loadSecretBox } from "./secretBox";

const tmp = () => mkdtempSync(join(tmpdir(), "ottr-secretbox-"));
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

describe("loadSecretBox", () => {
	test("seal/open round trip hides plaintext and uses a random IV", () => {
		const box = loadSecretBox({ dir: tmp(), env: {} });
		const a = box.seal("my-api-token");
		const b = box.seal("my-api-token");
		expect(box.open(a)).toBe("my-api-token");
		expect(a).not.toContain("my-api-token");
		expect(a).not.toBe(b);
		expect(a.startsWith(`v1:${box.keyId}:`)).toBe(true);
		expect(box.keyId).toMatch(/^[0-9a-f]{16}$/);
	});

	test("without env creates secret.key 0600 and reuses it across loads", () => {
		const dir = tmp();
		const first = loadSecretBox({ dir, env: {} });
		const path = join(dir, "secret.key");
		if (process.platform !== "win32")
			expect(statSync(path).mode & 0o777).toBe(0o600);
		const sealed = first.seal("x");
		const second = loadSecretBox({ dir, env: {} });
		expect(second.keyId).toBe(first.keyId);
		expect(second.open(sealed)).toBe("x");
	});

	test("env key accepts hex and base64 of the same bytes", () => {
		const hex = loadSecretBox({ dir: tmp(), env: { OTTR_SECRET_KEY: HEX_A } });
		const b64 = loadSecretBox({
			dir: tmp(),
			env: { OTTR_SECRET_KEY: Buffer.from(HEX_A, "hex").toString("base64") },
		});
		expect(b64.open(hex.seal("same"))).toBe("same");
	});

	test("changed key, tampering and garbage open to null", () => {
		const dir = tmp();
		const a = loadSecretBox({ dir, env: { OTTR_SECRET_KEY: HEX_A } });
		const b = loadSecretBox({ dir, env: { OTTR_SECRET_KEY: HEX_B } });
		const sealed = a.seal("secret");
		expect(b.open(sealed)).toBeNull();
		// Same keyId forged onto another key's ciphertext still fails auth.
		const forged = sealed.replace(a.keyId, b.keyId);
		expect(b.open(forged)).toBeNull();
		const [v, kid, iv, tag, ct] = sealed.split(":") as [
			string,
			string,
			string,
			string,
			string,
		];
		const flip = (s: string) => {
			const buf = Buffer.from(s, "base64");
			buf[0] = (buf[0] ?? 0) ^ 1;
			return buf.toString("base64");
		};
		expect(a.open([v, kid, iv, flip(tag), ct].join(":"))).toBeNull();
		expect(a.open([v, kid, iv, tag, flip(ct)].join(":"))).toBeNull();
		for (const g of [
			"",
			"garbage",
			"v1:::",
			"v2:x:y:z:w",
			`v1:${a.keyId}:!!:??:**`,
		])
			expect(a.open(g)).toBeNull();
	});

	test("malformed env key throws without echoing it", () => {
		for (const bad of [
			"not-a-key-zzz",
			"abcd",
			"a".repeat(63),
			Buffer.alloc(31).toString("base64"),
		]) {
			let msg = "";
			try {
				loadSecretBox({ dir: tmp(), env: { OTTR_SECRET_KEY: bad } });
			} catch (e) {
				msg = (e as Error).message;
			}
			expect(msg).toBe("OTTR_SECRET_KEY must be 32 bytes as hex or base64");
			expect(msg).not.toContain(bad);
		}
	});

	test("malformed key file throws with its path", () => {
		const dir = tmp();
		writeFileSync(join(dir, "secret.key"), "nope");
		expect(() => loadSecretBox({ dir, env: {} })).toThrow(
			join(dir, "secret.key"),
		);
	});

	test("property: open(seal(s)) === s", () => {
		const box = loadSecretBox({ dir: tmp(), env: { OTTR_SECRET_KEY: HEX_A } });
		fc.assert(
			fc.property(
				fc.string({ unit: "grapheme" }),
				(s) => box.open(box.seal(s)) === s,
			),
			{ seed: 4242, numRuns: 100 },
		);
	});
});

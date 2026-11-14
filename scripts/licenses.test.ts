// Fixtures for the license gate: pure license-key mappings, plus one live run
// of the script against this tree's real `bun pm licenses` output.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import fc from "fast-check";
import { ALLOWED, checkLicenses } from "./licenses.ts";

describe("checkLicenses", () => {
	test("the real tree passes through the live script", () => {
		const proc = Bun.spawnSync([process.execPath, "scripts/licenses.ts"], {
			cwd: join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(proc.exitCode).toBe(0);
	});

	test("every allowlisted key passes", () => {
		for (const key of Object.keys(ALLOWED))
			expect(checkLicenses({ [key]: [{ name: "pkg" }] }).ok).toBe(true);
	});

	test("a package with a license outside the list fails, and the problem names it", () => {
		const r = checkLicenses({ "GPL-3.0-only": [{ name: "left-pad" }] });
		expect(r.ok).toBe(false);
		expect(r.problems.join("\n")).toContain("GPL-3.0-only: left-pad");
	});

	test("the script enforces the exact recorded list: a removed key fails", () => {
		// The old gate script admitted the bare EPL-2.0 key with no package behind it.
		expect(checkLicenses({ "EPL-2.0": [{ name: "some-pkg" }] }).ok).toBe(false);
	});

	test("khroma is the only recorded Unknown; another Unknown package fails", () => {
		expect(checkLicenses({ Unknown: [{ name: "khroma" }] }).ok).toBe(true);
		const two = checkLicenses({
			Unknown: [{ name: "khroma" }, { name: "mystery" }],
		});
		expect(two.ok).toBe(false);
		expect(two.problems.join("\n")).toContain("mystery");
	});

	test("an empty group never fails", () => {
		expect(checkLicenses({ "GPL-3.0-only": [] }).ok).toBe(true);
	});

	// Gate: 200 runs, fixed seed. fast-check prints the seed and path on failure.
	test("property: ok exactly when every non-empty group is allowed or the recorded Unknown", () => {
		const key = fc.string({ minLength: 1, maxLength: 20 });
		const name = fc.string({ minLength: 1, maxLength: 15 });
		const groups = fc.array(fc.tuple(key, fc.array(name, { maxLength: 3 })), {
			maxLength: 6,
		});
		const oracle = (names: Record<string, string[]>): boolean =>
			Object.entries(names).every(
				([k, ns]) =>
					ns.length === 0 ||
					ALLOWED[k] === true ||
					(k === "Unknown" && ns.every((n) => n === "khroma")),
			);
		fc.assert(
			fc.property(groups, (gs) => {
				const names: Record<string, string[]> = {};
				for (const [k, ns] of gs) names[k] = ns;
				const licenses = Object.fromEntries(
					Object.entries(names).map(([k, ns]) => [
						k,
						ns.map((n) => ({ name: n })),
					]),
				);
				expect(checkLicenses(licenses).ok).toBe(oracle(names));
			}),
			{ seed: 944, numRuns: 200 },
		);
	});
});

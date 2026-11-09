import { describe, expect, test } from "bun:test";
import fc from "../test/properties.ts";
import { fmtNum } from "./numbers.ts";

describe("fmtNum", () => {
	test("groups thousands and leaves short counts alone", () => {
		expect(fmtNum(0)).toBe("0");
		expect(fmtNum(12)).toBe("12");
		expect(fmtNum(999)).toBe("999");
		expect(fmtNum(6523)).toBe("6,523");
		expect(fmtNum(1_891_234)).toBe("1,891,234");
	});

	test("property: the grouped value parses back to the same integer", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => {
				const shown = fmtNum(n);
				expect(shown).toMatch(/^\d{1,3}(,\d{3})*$/);
				expect(Number(shown.replaceAll(",", ""))).toBe(n);
			}),
		);
	});
});

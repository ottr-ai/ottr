import { describe, expect, test } from "bun:test";
import { errmsg } from "./errmsg.ts";

describe("errmsg", () => {
	test("Error message, String fallback", () => {
		expect(errmsg(new Error("x"))).toBe("x");
		expect(errmsg(new TypeError("typed"))).toBe("typed");
		expect(errmsg("plain")).toBe("plain");
		expect(errmsg(42)).toBe("42");
		expect(errmsg(null)).toBe("null");
	});
});

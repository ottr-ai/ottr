import { describe, expect, test } from "bun:test";
import { errmsg, requestFailed, statusWords } from "./errmsg.ts";

describe("errmsg", () => {
	test("Error message, String fallback", () => {
		expect(errmsg(new Error("x"))).toBe("x");
		expect(errmsg(new TypeError("typed"))).toBe("typed");
		expect(errmsg("plain")).toBe("plain");
		expect(errmsg(42)).toBe("42");
		expect(errmsg(null)).toBe("null");
	});
});

describe("statusWords", () => {
	test("the shared status table in words", () => {
		expect(statusWords(400)).toBe("invalid request");
		expect(statusWords(401)).toBe("not signed in");
		expect(statusWords(403)).toBe("refused");
		expect(statusWords(404)).toBe("not found");
		expect(statusWords(409)).toBe("conflict");
		expect(statusWords(413)).toBe("too large");
		expect(statusWords(429)).toBe("too many requests");
		expect(statusWords(500)).toBe("server error");
		expect(statusWords(502)).toBe("bad gateway");
		expect(statusWords(503)).toBe("unavailable");
		expect(statusWords(504)).toBe("gateway timeout");
	});

	test("an unknown status keeps its number", () => {
		expect(statusWords(418)).toBe("status 418");
	});
});

describe("requestFailed", () => {
	// DESIGN.md, the Error-Says-Fix Rule: the line names the request, the status
	// in words and the next step.
	test("composes what, status in words and next step on one line", () => {
		expect(
			requestFailed(
				"The alate provision request",
				503,
				"check that the alate server is up, then run Provision again",
			),
		).toBe(
			"The alate provision request failed (unavailable): check that the alate server is up, then run Provision again",
		);
		expect(
			requestFailed(
				"the updates pull",
				429,
				"the board keeps the last good list",
			),
		).toBe(
			"the updates pull failed (too many requests): the board keeps the last good list",
		);
	});
});

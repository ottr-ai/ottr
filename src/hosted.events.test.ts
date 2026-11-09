// Hosted forwarded GitHub events (docs/specs/hosted-mode.md section 8): event -> watch mapping, payload repository extraction and delivery dedupe.
import { describe, expect, test } from "bun:test";
import { DeliveryCache, eventRepository, githubEventWatch } from "./hosted.ts";

describe("githubEventWatch", () => {
	test("maps CI events to ci", () => {
		expect(githubEventWatch("push")).toBe("ci");
		expect(githubEventWatch("check_suite")).toBe("ci");
		expect(githubEventWatch("workflow_run")).toBe("ci");
	});

	test("maps pull request events to prReviews", () => {
		expect(githubEventWatch("pull_request")).toBe("prReviews");
		expect(githubEventWatch("pull_request_review")).toBe("prReviews");
	});

	test("maps issue events to issueWatch", () => {
		expect(githubEventWatch("issues")).toBe("issueWatch");
		expect(githubEventWatch("issue_comment")).toBe("issueWatch");
	});

	test("answers null for unknown events", () => {
		expect(githubEventWatch("fork")).toBeNull();
		expect(githubEventWatch("")).toBeNull();
		expect(githubEventWatch("delivery")).toBeNull();
	});

	test("answers null for a missing header", () => {
		expect(githubEventWatch(null)).toBeNull();
	});
});

describe("eventRepository", () => {
	test("extracts owner/repo from a well-formed payload", () => {
		expect(eventRepository({ repository: { full_name: "acme/widget" } })).toBe(
			"acme/widget",
		);
	});

	test("answers null for other shapes", () => {
		expect(eventRepository("nope")).toBeNull();
		expect(eventRepository(null)).toBeNull();
		expect(eventRepository([1, 2])).toBeNull();
		expect(eventRepository({})).toBeNull();
		expect(eventRepository({ repository: null })).toBeNull();
		expect(eventRepository({ repository: {} })).toBeNull();
		expect(eventRepository({ repository: { full_name: 42 } })).toBeNull();
		expect(eventRepository({ repository: { full_name: "" } })).toBeNull();
	});
});

describe("DeliveryCache", () => {
	test("dedupes the same id", () => {
		const cache = new DeliveryCache();
		expect(cache.add("d1")).toBe(true);
		expect(cache.add("d1")).toBe(false);
		expect(cache.add("d2")).toBe(true);
		expect(cache.add("d2")).toBe(false);
	});

	test("evicts the oldest id when full", () => {
		const cache = new DeliveryCache(2);
		expect(cache.add("a")).toBe(true);
		expect(cache.add("b")).toBe(true);
		expect(cache.add("c")).toBe(true);
		expect(cache.add("b")).toBe(false);
		expect(cache.add("a")).toBe(true);
		expect(cache.add("c")).toBe(false);
	});

	test("never double-counts an id it still holds", () => {
		const cache = new DeliveryCache(2);
		expect(cache.add("x")).toBe(true);
		expect(cache.add("y")).toBe(true);
		expect(cache.add("x")).toBe(false);
		expect(cache.add("x")).toBe(false);
	});

	test("stays bounded", () => {
		const cache = new DeliveryCache(2);
		for (const id of ["a", "b", "c", "d", "e"]) cache.add(id);
		expect(cache.add("d")).toBe(false);
		expect(cache.add("e")).toBe(false);
		expect(cache.add("c")).toBe(true);
	});
});

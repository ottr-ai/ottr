import { expect, test } from "bun:test";
import { decideReload } from "./version.ts";

// [seen, next, idle, guard, expected]
const CASES: [
	string | null,
	string,
	boolean,
	string | null,
	"reload" | "wait" | "done",
][] = [
	[null, "v1", true, null, "done"], // first sight: remember, never act
	[null, "v1", false, "v0", "done"], // first sight, stale guard left over: still done
	["v1", "v1", true, null, "done"], // same server
	["v1", "v1", false, null, "done"],
	["v1", "v2", true, null, "reload"], // restart while idle
	["v1", "v2", false, null, "wait"], // half-typed reply: retry on the next poll
	["v1", "v2", false, "v2", "wait"], // busy beats the guard: must not mark done either
	["v1", "v2", true, "v2", "done"], // already reloaded for v2: never loop
	["v2", "v3", true, "v2", "reload"], // second restart: the old guard does not cover v3
];

test("decideReload", () => {
	for (const [seen, next, idle, guard, want] of CASES) {
		expect(decideReload(seen, next, idle, guard)).toBe(want);
	}
});

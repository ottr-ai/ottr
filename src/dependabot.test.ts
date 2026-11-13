import { describe, expect, test } from "bun:test";
import { dependabotAlertsState, dependabotStateOf } from "./dependabot.ts";
import type { GhFn } from "./forks.ts";
import fc from "./test/properties.ts";

/** Fake gh that records every call and answers with one fixed result or throws. */
function fakeGh(res: { code: number; stdout: string; stderr: string } | Error) {
	const calls: string[][] = [];
	const gh: GhFn = async (args) => {
		calls.push(args);
		if (res instanceof Error) throw res;
		return res;
	};
	return { gh, calls };
}

describe("dependabotStateOf", () => {
	test("exit 0 reads enabled, whatever stderr holds", () => {
		expect(dependabotStateOf(0, "")).toBe("enabled");
		expect(dependabotStateOf(0, "gh: Not Found (HTTP 404)")).toBe("enabled");
	});

	test("gh's HTTP 404 line reads disabled", () => {
		expect(dependabotStateOf(1, "gh: Not Found (HTTP 404)\nsecond")).toBe(
			"disabled",
		);
	});

	test("a 403, another status, or no status reads unknown", () => {
		expect(dependabotStateOf(1, "gh: Forbidden (HTTP 403)")).toBe("unknown");
		expect(dependabotStateOf(1, "gh: Bad credentials (HTTP 401)")).toBe(
			"unknown",
		);
		expect(dependabotStateOf(1, "gh: Server Error (HTTP 500)")).toBe("unknown");
		expect(dependabotStateOf(1, "")).toBe("unknown");
	});

	test("property: only a first line ending in (HTTP 404) disables", () => {
		fc.assert(
			fc.property(fc.string(), (stderr: string) => {
				const first = stderr.split("\n")[0] ?? "";
				expect(dependabotStateOf(1, stderr)).toBe(
					first.endsWith("(HTTP 404)") ? "disabled" : "unknown",
				);
			}),
		);
	});
});

describe("dependabotAlertsState", () => {
	test("204 reads enabled and sends the exact GET", async () => {
		const { gh, calls } = fakeGh({ code: 0, stdout: "", stderr: "" });
		expect(await dependabotAlertsState(gh, "acme/widget")).toBe("enabled");
		expect(calls).toEqual([["api", "repos/acme/widget/vulnerability-alerts"]]);
	});

	test("404 reads disabled with the same exact request", async () => {
		const { gh, calls } = fakeGh({
			code: 1,
			stdout: "",
			stderr: "gh: Not Found (HTTP 404)",
		});
		expect(await dependabotAlertsState(gh, "acme/widget")).toBe("disabled");
		expect(calls).toEqual([["api", "repos/acme/widget/vulnerability-alerts"]]);
	});

	test("403 reads unknown, never throws", async () => {
		const { gh } = fakeGh({
			code: 1,
			stdout: "",
			stderr: "gh: Forbidden (HTTP 403)",
		});
		expect(await dependabotAlertsState(gh, "acme/widget")).toBe("unknown");
	});

	test("a transport failure reads unknown", async () => {
		const { gh } = fakeGh(new Error("gh: Could not resolve host"));
		expect(await dependabotAlertsState(gh, "acme/widget")).toBe("unknown");
	});

	test("a repo id outside owner/name sends nothing", async () => {
		for (const id of [
			"octo",
			"a/b/c",
			"../evil",
			"./repo",
			"octo/.",
			"octo/..",
			".",
			"..",
			"",
			"octo/repo/extra",
		]) {
			const { gh, calls } = fakeGh({ code: 0, stdout: "", stderr: "" });
			expect(await dependabotAlertsState(gh, id)).toBe("unknown");
			expect(calls).toEqual([]);
		}
	});
});

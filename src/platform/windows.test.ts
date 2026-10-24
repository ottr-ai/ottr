// windows.ts against direct fakes passed through its spawn/spawnSync seams. No
// mock.module("node:child_process") here: it leaks into every other file bun runs concurrently
// in the same process (CI incident 2026-10-05: fake children reached the runner suites).
import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { windows } from "./windows.ts";

type Call = { command: string; args: string[]; options?: object };

const asSpawnSync = (
	fn: (command: string, args: string[], options?: object) => unknown,
) => fn as unknown as typeof spawnSync;

function last<T>(items: T[]): T {
	const item = items[items.length - 1];
	if (item === undefined) throw new Error("expected at least one item");
	return item;
}

describe("windows platform", () => {
	test("killTree calls taskkill /PID <pid> /T /F for pid > 0", () => {
		const calls: Call[] = [];
		windows.killTree(
			4242,
			asSpawnSync((command, args, options) => {
				calls.push({ command, args, options });
				return { status: 0 };
			}),
		);
		expect(calls.length).toBe(1);
		const call = last(calls);
		expect(call.command).toBe("taskkill");
		expect(call.args).toEqual(["/PID", "4242", "/T", "/F"]);
		expect(call.options).toMatchObject({
			stdio: "ignore",
			windowsHide: true,
		});
	});

	test("killTree records no spawnSync call for pid <= 0", () => {
		const calls: Call[] = [];
		const run = asSpawnSync((command) => {
			calls.push({ command, args: [] });
			return {};
		});
		windows.killTree(0, run);
		windows.killTree(-5, run);
		expect(calls).toEqual([]);
	});

	test("killTree never throws when spawnSync throws", () => {
		expect(() =>
			windows.killTree(
				1234,
				asSpawnSync(() => {
					throw new Error("taskkill missing");
				}),
			),
		).not.toThrow();
	});

	test("samePath compares case-insensitively", () => {
		expect(windows.samePath("C:/Repos/Ottr", "c:/repos/ottr")).toBe(true);
		expect(windows.samePath("C:/Repos/Ottr", "C:/Repos/Other")).toBe(false);
	});

	test("listProcesses throws when the powershell scan fails", () => {
		const fail = asSpawnSync((command) => {
			if (command !== "powershell") throw new Error(`unexpected ${command}`);
			return { status: 1, stdout: "" };
		});
		expect(() => windows.listProcesses(fail)).toThrow(
			/process scan failed: exit 1/,
		);
	});

	test("listProcesses throws when powershell is missing", () => {
		const err = new Error("spawn powershell ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		const missing = asSpawnSync(() => ({
			status: null,
			stdout: "",
			error: err,
		}));
		expect(() => windows.listProcesses(missing)).toThrow(
			/process scan failed: .*ENOENT/,
		);
	});

	test("listProcesses parses a single JSON object", () => {
		const ok = asSpawnSync((command) => {
			if (command !== "powershell") throw new Error(`unexpected ${command}`);
			return {
				status: 0,
				stdout: JSON.stringify({
					ProcessId: 42,
					CommandLine: "node server.js",
					Started: "2026-10-11T10:00:00.000Z",
				}),
			};
		});
		expect(windows.listProcesses(ok)).toEqual([
			{
				pid: 42,
				cmd: "node server.js",
				started: Date.parse("2026-10-11T10:00:00.000Z"),
			},
		]);
	});

	test("listProcesses passes 64 MiB maxBuffer, utf8 encoding and windowsHide to powershell", () => {
		const calls: Call[] = [];
		const ok = asSpawnSync((command, args, options) => {
			calls.push({ command, args, options });
			return { status: 0, stdout: "[]" };
		});
		expect(windows.listProcesses(ok)).toEqual([]);
		expect(calls.length).toBe(1);
		expect(last(calls).command).toBe("powershell");
		expect(last(calls).options).toEqual({
			windowsHide: true,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
	});
});

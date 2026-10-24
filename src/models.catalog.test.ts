// modelList catalog mapping (contextWindow). The fake child goes through modelList's spawnFn
// seam: a mock.module("node:child_process") in any test file leaks into every other file bun
// runs concurrently in the same process (CI incident 2026-10-05: fake children reached the
// platform and runner suites).
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { modelList } from "./models.ts";

const catalog = JSON.stringify({
	models: [
		{
			kind: "chat",
			id: "m1",
			selector: "zai/glm-5.3-flash",
			name: "GLM",
			contextWindow: 204800,
		},
		{
			kind: "chat",
			id: "m2",
			selector: "a/b",
			name: "Bad",
			contextWindow: "big",
		},
		{ kind: "chat", id: "m3", selector: "c/d", name: "None" },
		{ kind: "chat", id: "m4", selector: "e/f", name: "Zero", contextWindow: 0 },
	],
});

describe("modelList contextWindow", () => {
	// Runs first: a successful modelList caches for the process, and only a failure clears it.
	test("a hung child is killed, resolves [], and the next call spawns again", async () => {
		let spawned = 0;
		const hung = () => {
			spawned++;
			const child = new EventEmitter() as EventEmitter & {
				stdout: { on: (event: string, fn: (chunk: unknown) => void) => void };
				kill: () => boolean;
			};
			child.stdout = { on: () => {} };
			child.kill = () => {
				queueMicrotask(() => child.emit("close", null, "SIGTERM"));
				return true;
			};
			return child;
		};
		expect(await modelList(hung as never, 10)).toEqual([]);
		expect(await modelList(hung as never, 10)).toEqual([]);
		expect(spawned).toBe(2);
	});

	// Runs before the numeric test: modelsCache is process-global and a successful
	// spawn fills it permanently (only a failed spawn clears it), so this error-path
	// test must run while the cache is still null.
	test("a child 'error' resolves [], clears the cache, and pins the spawn args", async () => {
		const spawnArgs: unknown[] = [];
		let spawned = 0;
		const failing = (...args: never[]) => {
			spawned++;
			spawnArgs.push(args[0], args[1]);
			const child = new EventEmitter() as EventEmitter & {
				stdout: { on: (event: string, fn: (chunk: unknown) => void) => void };
			};
			child.stdout = { on: () => {} };
			// models.ts registers its error handler in the same tick; emit after that.
			queueMicrotask(() => child.emit("error", new Error("boom")));
			return child;
		};
		expect(await modelList(failing as never)).toEqual([]);
		// The error path must clear modelsCache, or this second call would not spawn.
		expect(await modelList(failing as never)).toEqual([]);
		expect(spawned).toBe(2);
		expect(spawnArgs).toEqual([
			"omp",
			["models", "--json"],
			"omp",
			["models", "--json"],
		]);
	});

	test("numeric maps through; non-numeric, absent, and non-positive become null", async () => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: { on: (event: string, fn: (chunk: unknown) => void) => void };
		};
		child.stdout = {
			on: (_event: string, fn: (chunk: unknown) => void) =>
				fn(Buffer.from(catalog)),
		};
		// models.ts registers its close handler in the same tick; emit after that.
		queueMicrotask(() => child.emit("close", 0));
		const list = await modelList(() => child as never);
		expect(list.map((m) => [m.id, m.contextWindow])).toEqual([
			["m1", 204800],
			["m2", null],
			["m3", null],
			["m4", null],
		]);
	});
});

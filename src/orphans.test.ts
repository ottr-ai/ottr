import { expect, test } from "bun:test";
import { matchAgentLauncher, orphanCache, orphanPids } from "./orphans.ts";

const proc = (pid: number, cmd: string) => ({ pid, cmd, started: 0 });

test("a tracker turn under a bun shebang is reported", () => {
	// omp is a bun script: argv[0] is the runtime, the omp binary is argv[1] (R5-6).
	const ps = [
		proc(
			9,
			"bun /usr/local/bin/omp -p --mode json --session-dir /data/.sessions",
		),
	];
	expect(orphanPids(ps, new Set(), 1)).toEqual(ps);
});

test("a tracker turn run by the omp binary directly is reported", () => {
	const ps = [proc(42, '"C:\\tools\\omp.EXE" -p --mode json --session-dir d1')];
	expect(orphanPids(ps, new Set(), 1)).toEqual(ps);
});

test("a claimed turn is not reported", () => {
	expect(
		orphanPids(
			[proc(42, "omp -p --mode json --session-dir d1")],
			new Set([42]),
			1,
		),
	).toEqual([]);
});

test("the tracker's own pid is never reported", () => {
	expect(orphanPids([proc(7, "omp -p --mode json")], new Set(), 7)).toEqual([]);
});

test("the omp daemon is not a turn", () => {
	expect(matchAgentLauncher("omp daemon brok")).toBe(false);
});

test("omp usage output is not a turn", () => {
	expect(matchAgentLauncher("omp usage --json")).toBe(false);
});

test("bun running tests or the server is not reported", () => {
	expect(matchAgentLauncher("bun test src/turn.test.ts")).toBe(false);
	expect(matchAgentLauncher("bun src/server.ts")).toBe(false);
});

test("a plain node script is not reported", () => {
	expect(matchAgentLauncher("node app.js")).toBe(false);
});

test("pid 0 and negative pids are dropped", () => {
	const ps = [proc(0, "omp -p --mode json"), proc(-3, "omp -p --mode json")];
	expect(orphanPids(ps, new Set(), 1)).toEqual([]);
});

test("orphanCache calls list at most once per TTL and does not cache failures", () => {
	let calls = 0;
	const list = () => {
		calls++;
		return [proc(5, "omp -p --mode json")];
	};
	const claimed = () => new Set<number>();
	const orphans = orphanCache();
	const first = orphans(list, claimed, 1000);
	const second = orphans(list, claimed, 1000 + 60_000); // fresh: cached
	expect(calls).toBe(1);
	expect(second).toEqual(first);

	let throwing = true;
	const failing = () => {
		if (throwing) throw new Error("boom");
		return [proc(6, "omp -p --mode json")];
	};
	const t = 1000 + 400_000; // past the 300_000 default TTL
	expect(orphans(failing, claimed, t)).toEqual({
		orphans: [],
		error: "boom",
	}); // failure not cached
	throwing = false;
	expect(orphans(failing, claimed, t)).toEqual({
		orphans: [proc(6, "omp -p --mode json")],
		error: null,
	});
});

test("a throwing scan yields the error and a later good scan clears it", () => {
	let throwing = true;
	const list = () => {
		if (throwing) throw new Error("ps died");
		return [proc(7, "omp -p --mode json")];
	};
	const claimed = () => new Set<number>();
	const orphans = orphanCache();
	expect(orphans(list, claimed, 1000)).toEqual({
		orphans: [],
		error: "ps died",
	});
	throwing = false;
	// Same timestamp: the failure was not cached, so the retry sees the good scan.
	expect(orphans(list, claimed, 1000)).toEqual({
		orphans: [proc(7, "omp -p --mode json")],
		error: null,
	});
	expect(orphans(list, claimed, 2000)).toEqual({
		orphans: [proc(7, "omp -p --mode json")],
		error: null,
	}); // success cached with a null error
});

// Regression for the old module-level snapshot: it leaked across apps.
test("two instances cache independently", () => {
	let n = 0;
	const list = () => [proc(++n, "omp -p --mode json")];
	const claimed = () => new Set<number>();
	const a = orphanCache();
	const b = orphanCache();
	const ra = a(list, claimed, 1000);
	const rb = b(list, claimed, 1000); // must scan again, not reuse a's snapshot
	expect(rb).not.toBe(ra);
	// Each keeps its own entry warm: a's list is not re-called inside its TTL.
	expect(a(list, claimed, 2000)).toEqual(ra);
	expect(b(list, claimed, 2000)).toEqual(rb);
});

test("a custom ttlMs narrows the cache window", () => {
	let calls = 0;
	const list = () => {
		calls++;
		return [proc(5, "omp -p --mode json")];
	};
	const orphans = orphanCache(1_000);
	orphans(list, () => new Set(), 1000);
	orphans(list, () => new Set(), 1500); // inside TTL: cached
	expect(calls).toBe(1);
	orphans(list, () => new Set(), 2500); // past TTL: rescans
	expect(calls).toBe(2);
});

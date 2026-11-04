import { describe, expect, test } from "bun:test";
import { singleFlightTick } from "./singleFlight.ts";

/** A scan that records each call and finishes only when the test settles it. */
function gatedScan() {
	const calls: (string | undefined)[] = [];
	const runs: PromiseWithResolvers<void>[] = [];
	let called = Promise.withResolvers<void>();
	const scan = (opts?: { manual?: string }) => {
		calls.push(opts?.manual);
		const run = Promise.withResolvers<void>();
		runs.push(run);
		called.resolve();
		called = Promise.withResolvers<void>();
		return run.promise;
	};
	/** Resolves at the next scan call. */
	const nextCall = () => called.promise;
	return { calls, runs, scan, nextCall };
}

describe("singleFlightTick", () => {
	test("a second call while an unscoped scan runs joins it", async () => {
		const { calls, runs, scan } = gatedScan();
		const tick = singleFlightTick(scan);
		const a = tick();
		const b = tick({ manual: "p" });
		runs[0]!.resolve();
		await Promise.all([a, b]);
		expect(calls).toEqual([undefined]);
	});

	test("a call for the running manual project joins it", async () => {
		const { calls, runs, scan } = gatedScan();
		const tick = singleFlightTick(scan);
		const a = tick({ manual: "p" });
		const b = tick({ manual: "p" });
		runs[0]!.resolve();
		await Promise.all([a, b]);
		expect(calls).toEqual(["p"]);
	});

	test("a call for another project waits, then scans after a failed scan too", async () => {
		const { calls, runs, scan, nextCall } = gatedScan();
		const tick = singleFlightTick(scan);
		const a = tick({ manual: "p" });
		const b = tick({ manual: "q" });
		expect(calls).toEqual(["p"]);
		const second = nextCall();
		runs[0]!.reject(new Error("boom"));
		await expect(a).rejects.toThrow("boom");
		await second;
		expect(calls).toEqual(["p", "q"]);
		runs[1]!.resolve();
		await b;
	});

	test("a finished scan frees the slot for the next call", async () => {
		const { calls, runs, scan } = gatedScan();
		const tick = singleFlightTick(scan);
		const a = tick();
		runs[0]!.resolve();
		await a;
		const b = tick();
		expect(calls).toEqual([undefined, undefined]);
		runs[1]!.resolve();
		await b;
	});
});

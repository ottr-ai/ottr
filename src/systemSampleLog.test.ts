import { describe, expect, test } from "bun:test";
import {
	createSystemSampleLog,
	SAMPLE_LOG_INTERVAL_MS,
} from "./systemSampleLog.ts";

const ERR = new Error("cgroup read boom");

/** Fixed-clock harness: every fail()/pass() advances the clock one 30 s tick. */
function harness() {
	let now = 1_000;
	const lines: string[] = [];
	const sampler = createSystemSampleLog(
		() => now,
		(line) => lines.push(line),
	);
	return {
		lines,
		fail(): void {
			now += 30_000;
			sampler.failure(ERR);
		},
		pass(): void {
			now += 30_000;
			sampler.success();
		},
		jump(ms: number): void {
			now += ms;
		},
	};
}

describe("createSystemSampleLog (OTTR-793)", () => {
	test("the first failure logs at once, naming the sampler and the error", () => {
		const h = harness();
		h.fail();
		expect(h.lines).toEqual(["system sampler failed: cgroup read boom"]);
	});

	test("failures inside the interval stay silent", () => {
		const h = harness();
		h.fail();
		h.fail();
		h.fail();
		expect(h.lines).toHaveLength(1);
	});

	test("the next line after the interval carries the failed-tick count", () => {
		const h = harness();
		h.fail(); // logged: the first failure.
		h.fail();
		h.fail();
		h.fail();
		h.jump(SAMPLE_LOG_INTERVAL_MS);
		h.fail(); // 4 failed ticks since the last line.
		expect(h.lines).toHaveLength(2);
		expect(h.lines[1]).toBe(
			"system sampler failed 4 times since the last line: cgroup read boom",
		);
	});

	test("the count resets after each logged line", () => {
		const h = harness();
		h.fail(); // logged.
		h.fail();
		h.jump(SAMPLE_LOG_INTERVAL_MS);
		h.fail(); // logged: 2 since the last line.
		h.fail(); // 1 since the new line, silent.
		h.jump(SAMPLE_LOG_INTERVAL_MS);
		h.fail(); // logged: 2 since the last line again.
		expect(h.lines).toHaveLength(3);
		expect(h.lines[2]).toBe(
			"system sampler failed 2 times since the last line: cgroup read boom",
		);
	});

	test("recovery after a failure logs one line with the failed-tick count", () => {
		const h = harness();
		h.fail();
		h.fail();
		h.pass();
		expect(h.lines).toEqual([
			"system sampler failed: cgroup read boom",
			"system sampler recovered after 2 failed samples",
		]);
	});

	test("a pass with no earlier failure logs nothing", () => {
		const h = harness();
		h.pass();
		h.pass();
		expect(h.lines).toEqual([]);
	});

	test("a non-Error rejection still renders a message", () => {
		let now = 0;
		const lines: string[] = [];
		const sampler = createSystemSampleLog(
			() => now,
			(line) => lines.push(line),
		);
		sampler.failure("string rejection");
		expect(lines).toEqual(["system sampler failed: string rejection"]);
	});
});

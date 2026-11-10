import { describe, expect, test } from "bun:test";
import fc from "./test/properties.ts";
import {
	isUpdateCommit,
	parseUpdateHostHeartbeat,
	parseUpdateHostReply,
	UPDATE_HOST_LEASE_MS,
	UpdateCycleController,
	type UpdateHostHeartbeat,
} from "./updateCycle.ts";

const at = 1_800_000_000_000;
const idle = (
	patch: Partial<UpdateHostHeartbeat> = {},
): UpdateHostHeartbeat => ({
	controller: "host-1",
	nextCycleAt: at + 3_600_000,
	phase: "idle",
	requestId: null,
	error: null,
	available: {
		behind: 2,
		commits: ["Fix update control", "Add host schedule"],
	},
	...patch,
});

function requested(control: UpdateCycleController, now = at): string {
	expect(control.heartbeat(idle(), now)).toEqual({ requestId: null });
	const result = control.request(now, true);
	if ("error" in result) throw new Error(result.error);
	return result.requestId;
}

describe("update cycle controller", () => {
	test("unknown, busy and scheduled-running hosts cannot start a manual cycle", () => {
		const control = new UpdateCycleController();
		expect(control.view(at, true)).toBeNull();
		expect(control.request(at, true)).toHaveProperty("error");
		control.heartbeat(idle(), at);
		expect(control.view(at, false)?.canStart).toBe(false);
		expect(control.request(at, false)).toHaveProperty("error");
		control.heartbeat(idle({ phase: "running" }), at);
		expect(control.view(at, true)?.phase).toBe("running");
		expect(control.request(at, true)).toHaveProperty("error");
		// A scheduled cycle retains the updater's own drains, not a manual lease hold.
		expect(control.holdUntil(at)).toBe(0);
	});

	test("idle polls retain one request until its explicit running acknowledgement", () => {
		const control = new UpdateCycleController();
		const requestId = requested(control);
		expect(requestId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
		expect(control.request(at, true)).toHaveProperty("error");
		expect(control.view(at, true)).toEqual({
			nextCycleAt: at + 3_600_000,
			phase: "requested",
			canStart: false,
			error: null,
		});
		for (let i = 1; i <= 3; i++) {
			expect(control.heartbeat(idle(), at + i * 5_000)).toEqual({ requestId });
			expect(control.view(at + i * 5_000, true)?.phase).toBe("requested");
		}
		expect(
			control.heartbeat(
				idle({ phase: "running", requestId: "wrong" }),
				at + 16_000,
			),
		).toHaveProperty("error");
		expect(control.heartbeat(idle({ phase: "running" }), at + 16_000)).toEqual({
			requestId,
		});
		expect(control.view(at + 16_000, true)?.phase).toBe("requested");
		const running = idle({ phase: "running", requestId });
		expect(control.heartbeat(running, at + 20_000)).toEqual({ requestId });
		expect(control.heartbeat(running, at + 25_000)).toEqual({ requestId });
		expect(control.view(at + 25_000, true)?.phase).toBe("running");
		expect(control.holdUntil(at + 25_000)).toBe(
			at + 25_000 + UPDATE_HOST_LEASE_MS,
		);
		expect(control.request(at + 25_000, true)).toHaveProperty("error");
	});

	test("completion and failure clear only the acknowledged request", () => {
		const control = new UpdateCycleController();
		const requestId = requested(control);
		control.heartbeat(idle({ phase: "running", requestId }), at);
		expect(
			control.heartbeat(idle({ error: "The update failed." }), at + 5_000),
		).toEqual({ requestId: null });
		expect(control.holdUntil(at + 5_000)).toBe(0);
		expect(control.view(at + 5_000, true)).toEqual({
			nextCycleAt: at + 3_600_000,
			phase: "idle",
			canStart: true,
			error: "The update failed.",
		});
		expect(
			control.heartbeat(idle({ error: "The update failed." }), at + 6_000),
		).toEqual({ requestId: null });
		expect(
			control.heartbeat(idle({ phase: "running", requestId }), at + 7_000),
		).toHaveProperty("error");
		expect(control.holdUntil(at + 7_000)).toBe(0);
		const next = control.request(at + 7_000, true);
		expect(next).not.toEqual({ requestId });
		expect(next).not.toHaveProperty("error");
	});

	test("expiry releases the manual hold and hides stale availability at the exact boundary", () => {
		const control = new UpdateCycleController();
		requested(control);
		expect(control.holdUntil(at + UPDATE_HOST_LEASE_MS - 1)).toBe(
			at + UPDATE_HOST_LEASE_MS,
		);
		expect(control.available(at + UPDATE_HOST_LEASE_MS - 1)?.behind).toBe(2);
		expect(control.holdUntil(at + UPDATE_HOST_LEASE_MS)).toBe(0);
		expect(control.view(at + UPDATE_HOST_LEASE_MS, true)).toBeNull();
		expect(control.available(at + UPDATE_HOST_LEASE_MS)).toBeNull();
		expect(control.request(at + UPDATE_HOST_LEASE_MS, true)).toHaveProperty(
			"error",
		);
		control.heartbeat(idle(), at + UPDATE_HOST_LEASE_MS);
		expect(control.view(at + UPDATE_HOST_LEASE_MS, true)?.canStart).toBe(true);
	});

	test("a foreign live controller cannot replace, complete or renew the manual hold", () => {
		const control = new UpdateCycleController();
		const requestId = requested(control);
		for (const phase of ["idle", "running"] as const)
			expect(
				control.heartbeat(
					idle({
						controller: "host-2",
						phase,
						requestId: phase === "running" ? requestId : null,
					}),
					at + 20_000,
				),
			).toHaveProperty("error");
		expect(control.holdUntil(at)).toBe(at + UPDATE_HOST_LEASE_MS);
		expect(control.view(at, true)?.phase).toBe("requested");
		expect(
			control.heartbeat(
				idle({ controller: "host-2" }),
				at + UPDATE_HOST_LEASE_MS,
			),
		).toEqual({ requestId: null });
		expect(control.holdUntil(at + UPDATE_HOST_LEASE_MS)).toBe(0);
	});

	test("running heartbeat restores a hold after server restart and after lease loss", () => {
		const control = new UpdateCycleController();
		const running = idle({ phase: "running", requestId: "saved-request" });
		expect(control.heartbeat(running, at)).toEqual({
			requestId: "saved-request",
		});
		expect(control.view(at, true)?.phase).toBe("running");
		expect(control.holdUntil(at)).toBe(at + UPDATE_HOST_LEASE_MS);
		expect(control.holdUntil(at + UPDATE_HOST_LEASE_MS)).toBe(0);
		expect(control.heartbeat(running, at + UPDATE_HOST_LEASE_MS + 1)).toEqual({
			requestId: "saved-request",
		});
		expect(control.holdUntil(at + UPDATE_HOST_LEASE_MS + 1)).toBe(
			at + UPDATE_HOST_LEASE_MS * 2 + 1,
		);
		expect(control.heartbeat(idle(), at + UPDATE_HOST_LEASE_MS + 2)).toEqual({
			requestId: null,
		});
		expect(control.holdUntil(at + UPDATE_HOST_LEASE_MS + 2)).toBe(0);
	});
});

describe("update host validators", () => {
	test("round trips the complete protocol without aliases to input arrays", () => {
		const input = idle();
		const parsed = parseUpdateHostHeartbeat(input);
		expect(parsed).toEqual(input);
		input.available?.commits.push("Later change");
		expect(parsed?.available?.commits).toHaveLength(2);
		expect(
			parseUpdateHostHeartbeat(
				idle({ phase: "running", requestId: "request-1", available: null }),
			),
		).not.toBeNull();
		expect(
			parseUpdateHostReply({
				requestId: "request-1",
				runningCommit: "a".repeat(40),
			}),
		).toEqual({ requestId: "request-1", runningCommit: "a".repeat(40) });
		expect(
			parseUpdateHostReply({ requestId: null, runningCommit: null }),
		).toEqual({ requestId: null, runningCommit: null });
	});

	test("rejects invalid shape, unknown fields, controls and unbounded metadata", () => {
		const bad: unknown[] = [null, [], {}, { ...idle(), command: "update" }];
		for (const patch of [
			{ controller: "" },
			{ controller: "host with spaces" },
			{ controller: "x".repeat(129) },
			{ nextCycleAt: -1 },
			{ nextCycleAt: 0 },
			{ nextCycleAt: 1.5 },
			{ nextCycleAt: Number.MAX_SAFE_INTEGER + 1 },
			{ nextCycleAt: "later" },
			{ phase: "requested" },
			{ requestId: "request-1" },
			{ phase: "running", requestId: "bad/request" },
			{ error: "" },
			{ error: " padded " },
			{ error: "bad\nline" },
			{ error: "bad\u202eline" },
			{ error: "x".repeat(1_201) },
			{ available: {} },
			{ available: { behind: -1, commits: [] } },
			{ available: { behind: 1.5, commits: [] } },
			{ available: { behind: 1, commits: [42] } },
			{ available: { behind: 1, commits: [""] } },
			{ available: { behind: 1, commits: [" padded "] } },
			{ available: { behind: 1, commits: ["bad\u0000line"] } },
			{ available: { behind: 1, commits: ["x".repeat(201)] } },
			{ available: { behind: 1, commits: Array(51).fill("subject") } },
			{ available: { behind: 1, commits: [], extra: true } },
		])
			bad.push({ ...idle(), ...patch });
		const missing = { ...idle() } as Record<string, unknown>;
		delete missing.error;
		bad.push(missing);
		for (const value of bad) expect(parseUpdateHostHeartbeat(value)).toBeNull();
		for (const value of [
			null,
			{},
			{ requestId: "bad/id", runningCommit: null },
			{ requestId: null, runningCommit: "v1.0.0" },
			{ requestId: null, runningCommit: "abcdefg", extra: true },
		])
			expect(parseUpdateHostReply(value)).toBeNull();
		for (const value of [
			"v1.0.0",
			"a".repeat(6),
			"a".repeat(41),
			"ABCDEF0",
			null,
		])
			expect(isUpdateCommit(value)).toBe(false);
		expect(isUpdateCommit("abcdef0")).toBe(true);
	});

	test("accepted external messages stay bounded and survive a JSON round trip", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (input) => {
				const parsed = parseUpdateHostHeartbeat(input);
				if (parsed === null) return;
				expect(
					parseUpdateHostHeartbeat(JSON.parse(JSON.stringify(parsed))),
				).toEqual(parsed);
				expect(parsed.controller).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
				expect(Number.isSafeInteger(parsed.nextCycleAt)).toBe(true);
				expect(parsed.nextCycleAt).toBeGreaterThan(0);
				expect(parsed.error?.length ?? 0).toBeLessThanOrEqual(1_200);
				for (const subject of parsed.available?.commits ?? []) {
					expect(subject.length).toBeLessThanOrEqual(200);
					expect(subject).not.toMatch(/[\p{Cc}\p{Cf}]/u);
				}
			}),
		);
	});

	test("valid external messages preserve their values and cannot exceed the text bounds", () => {
		const word = fc.stringMatching(/^[A-Za-z0-9_-]{1,60}$/);
		fc.assert(
			fc.property(
				word,
				fc.integer({ min: 1, max: 2_000_000_000_000 }),
				fc.boolean(),
				fc.option(word, { nil: null }),
				fc.nat({ max: 1_000_000 }),
				fc.array(word, { maxLength: 50 }),
				(controller, nextCycleAt, running, requestId, behind, commits) => {
					const input = idle({
						controller,
						nextCycleAt,
						phase: running ? "running" : "idle",
						requestId: running ? requestId : null,
						error: requestId,
						available: { behind, commits },
					});
					expect(parseUpdateHostHeartbeat(input)).toEqual(input);
					expect(
						parseUpdateHostHeartbeat(JSON.parse(JSON.stringify(input))),
					).toEqual(input);
				},
			),
		);
	});

	test("reply validation preserves generated ids and commits and rejects extra fields", () => {
		fc.assert(
			fc.property(
				fc.option(fc.stringMatching(/^[A-Za-z0-9_-]{1,128}$/), { nil: null }),
				fc.option(fc.stringMatching(/^[0-9a-f]{7,40}$/), { nil: null }),
				(requestId, runningCommit) => {
					const reply = { requestId, runningCommit };
					expect(parseUpdateHostReply(reply)).toEqual(reply);
					expect(
						parseUpdateHostReply({ ...reply, command: "update" }),
					).toBeNull();
					expect(parseUpdateHostReply({ requestId })).toBeNull();
				},
			),
		);
	});

	test("invalid external fields cannot renew or alter a pending request", () => {
		fc.assert(
			fc.property(fc.string(), fc.jsonValue(), (name, value) => {
				const control = new UpdateCycleController();
				const requestId = requested(control);
				const input = { ...idle(), [`extra_${name}`]: value };
				const parsed = parseUpdateHostHeartbeat(input);
				expect(parsed).toBeNull();
				expect(control.view(at + 20_000, true)?.phase).toBe("requested");
				expect(control.holdUntil(at + 20_000)).toBe(at + UPDATE_HOST_LEASE_MS);
				expect(control.heartbeat(idle(), at + 20_000)).toEqual({ requestId });
			}),
		);
	});

	test("repeated valid polls preserve the same request and release at lease expiry", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 1, max: 5_000 }), {
					minLength: 1,
					maxLength: 30,
				}),
				(gaps) => {
					const control = new UpdateCycleController();
					const requestId = requested(control);
					let time = at;
					for (const gap of gaps) {
						time += gap;
						expect(control.heartbeat(idle(), time)).toEqual({ requestId });
						expect(control.request(time, true)).toHaveProperty("error");
					}
					expect(control.holdUntil(time + UPDATE_HOST_LEASE_MS - 1)).toBe(
						time + UPDATE_HOST_LEASE_MS,
					);
					expect(control.holdUntil(time + UPDATE_HOST_LEASE_MS)).toBe(0);
				},
			),
		);
	});
});

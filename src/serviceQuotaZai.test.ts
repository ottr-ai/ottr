import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { builtInServiceQuotaAdapters } from "./serviceQuotaRegistry.ts";
import { createZaiQuotaAdapter } from "./serviceQuotaZai.ts";
import type { ServiceQuotaMetric, ServiceQuotaReader } from "./types.ts";

const limitEndpoint = "https://api.z.ai/api/monitor/usage/quota/limit";
const resetEndpoint =
	"https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL";
const signal = () => new AbortController().signal;

// Epochs from the operator capture's nextResetTime fields (milliseconds).
const FIVE_HOUR_RESET = 1_795_467_218_287;
const WEEKLY_RESET = 1_795_974_608_999;

// Operator capture, 2026-11-23: real response bodies (no reset grants currently held).
const limitFixture: {
	code: number;
	msg: string;
	success: boolean;
	data: { level: string; limits: Array<Record<string, unknown>> };
} = {
	code: 200,
	msg: "Operation successful",
	success: true,
	data: {
		level: "max",
		limits: [
			{
				type: "CREDIT_LIMIT",
				unit: 3,
				number: 5,
				usage: 28000,
				currentValue: 265,
				remaining: 27734,
				percentage: 1,
				nextResetTime: FIVE_HOUR_RESET,
			},
			{
				type: "CREDIT_LIMIT",
				unit: 6,
				number: 1,
				usage: 140000,
				currentValue: 46505,
				remaining: 93494,
				percentage: 33,
				nextResetTime: WEEKLY_RESET,
			},
		],
	},
};
const resetsFixture: {
	code: number;
	msg: string;
	success: boolean;
	data: Record<string, unknown>;
} = {
	code: 200,
	msg: "Operation successful",
	success: true,
	data: {
		// Captured as a JSON number beyond Number precision; the decoder ignores the field.
		customerId: "83311787860279802",
		targetType: "PERSONAL",
		organizationId: null,
		projectId: null,
		lastFiveHourResetTime: null,
		lastWeekResetTime: "2026-11-23 01:50:09",
		fiveHourResets: [],
		weekResets: [],
	},
};

function metrics(
	fiveHourResetsAt: number | null,
	weeklyResetsAt: number | null,
	fiveHourRemaining = 0,
	weeklyRemaining = 0,
): ServiceQuotaMetric[] {
	return [
		{
			id: "five-hour-window",
			label: "5-hour window",
			kind: "balance",
			unit: { kind: "count", name: "unused reset grants" },
			remaining: fiveHourRemaining,
			reportedTotal: null,
			resetsAt: fiveHourResetsAt,
			providerStatus: null,
			plan: null,
		},
		{
			id: "weekly-window",
			label: "Weekly window",
			kind: "balance",
			unit: { kind: "count", name: "unused reset grants" },
			remaining: weeklyRemaining,
			reportedTotal: null,
			resetsAt: weeklyResetsAt,
			providerStatus: null,
			plan: null,
		},
	];
}

function changedLimit(change: (body: typeof limitFixture) => void): string {
	const body = structuredClone(limitFixture);
	change(body);
	return JSON.stringify(body);
}
function changedResets(change: (body: typeof resetsFixture) => void): string {
	const body = structuredClone(resetsFixture);
	change(body);
	return JSON.stringify(body);
}

function transport(
	request: (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => Promise<Response>,
): typeof fetch {
	return Object.assign(request, { preconnect: globalThis.fetch.preconnect });
}

async function endpointServer() {
	let received = 0;
	let respond: (response: ServerResponse) => void = (response) =>
		response.end("");
	const server = createServer(
		(_request: IncomingMessage, response: ServerResponse) => {
			received++;
			respond(response);
		},
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing test port");
	return {
		get received() {
			return received;
		},
		url: `http://127.0.0.1:${address.port}/`,
		serve(value: (response: ServerResponse) => void) {
			respond = value;
		},
		async close() {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.close((failure) => (failure ? reject(failure) : resolve()));
			await promise;
		},
	};
}

interface Harness {
	credential: string;
	counts: { limit: number; resets: number };
	reader: ServiceQuotaReader;
	close(): Promise<void>;
}

async function harness(routes: {
	limit: () => { status: number; body: string };
	resets: () => { status: number; body: string };
	now?: () => number;
}): Promise<Harness> {
	const limit = await endpointServer();
	const resets = await endpointServer();
	limit.serve((response) => {
		const route = routes.limit();
		response.statusCode = route.status;
		response.end(route.body);
	});
	resets.serve((response) => {
		const route = routes.resets();
		response.statusCode = route.status;
		response.end(route.body);
	});
	const credential = randomUUID();
	const counts = { limit: 0, resets: 0 };
	const fetchFn = transport(async (input, init) => {
		// Route only after the real reader supplies the exact production request.
		expect(init?.method).toBe("GET");
		expect(init?.body).toBeUndefined();
		expect(init?.redirect).toBe("manual");
		expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			`Bearer ${credential}`,
		);
		if (input === limitEndpoint) {
			counts.limit++;
			return globalThis.fetch(limit.url, init);
		}
		expect(input).toBe(resetEndpoint);
		counts.resets++;
		return globalThis.fetch(resets.url, init);
	});
	const reader = createZaiQuotaAdapter({
		fetch: fetchFn,
		now: routes.now,
	}).createReader({
		credential,
	});
	return {
		credential,
		counts,
		reader,
		async close() {
			await limit.close();
			await resets.close();
		},
	};
}

const fresh = () => ({
	limit: () => ({ status: 200, body: JSON.stringify(limitFixture) }),
	resets: () => ({ status: 200, body: JSON.stringify(resetsFixture) }),
});

describe("Z.AI coding plan quota adapter", () => {
	test("reads the captured snapshot with two fixed authenticated GETs", async () => {
		const server = await harness(fresh());
		try {
			// The capture holds no grants today: this is also the empty-grants acceptance case.
			expect(await server.reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(FIVE_HOUR_RESET, WEEKLY_RESET),
			});
			expect(server.counts).toEqual({ limit: 1, resets: 1 });
		} finally {
			await server.close();
		}
	});

	test("still matches TOKENS_LIMIT entries documented by public clients", async () => {
		const server = await harness({
			limit: () => ({
				status: 200,
				body: changedLimit((body) => {
					body.data.limits[0]!.type = "TOKENS_LIMIT";
					body.data.limits[1]!.type = "TOKENS_LIMIT";
				}),
			}),
			resets: fresh().resets,
		});
		try {
			expect(await server.reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(FIVE_HOUR_RESET, WEEKLY_RESET),
			});
		} finally {
			await server.close();
		}
	});

	test("falls back to the last weekly stamp when the limit entries lack nextResetTime", async () => {
		const server = await harness({
			limit: () =>
				// No unit 6 entry: the weekly row must still fall back.
				({
					status: 200,
					body: changedLimit((body) => {
						delete body.data.limits[0]?.nextResetTime;
						body.data.limits.splice(1, 1);
					}),
				}),
			resets: fresh().resets,
			now: () => Date.parse("2026-11-23T01:50:09+08:00") + 60_000,
		});
		try {
			// The capture's lastFiveHourResetTime is null: the five-hour row has no fallback.
			expect(await server.reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(
					null,
					Date.parse("2026-11-23T01:50:09+08:00") + 7 * 86_400_000,
				),
			});
		} finally {
			await server.close();
		}
	});

	test("drops a derived reset stamp that is already in the past", async () => {
		const server = await harness({
			limit: () => ({
				status: 200,
				body: changedLimit((body) => {
					delete body.data.limits[0]?.nextResetTime;
					body.data.limits.splice(1, 1);
				}),
			}),
			resets: fresh().resets,
			now: () => Date.parse("2026-12-05T00:00:00+08:00"),
		});
		try {
			expect(await server.reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(null, null),
			});
		} finally {
			await server.close();
		}
	});

	test("shows no reset time when neither endpoint reports one", async () => {
		const server = await harness({
			limit: () => ({
				status: 200,
				body: changedLimit((body) => {
					body.data.limits = [];
				}),
			}),
			resets: () => ({
				status: 200,
				body: changedResets((body) => {
					body.data.lastFiveHourResetTime = null;
					body.data.lastWeekResetTime = null;
				}),
			}),
		});
		try {
			expect(await server.reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(null, null),
			});
		} finally {
			await server.close();
		}
	});

	test("counts an available weekly grant and rejects malformed reset entries", async () => {
		// Documented mutation of the capture: the card screenshot's one available weekly grant.
		const granted = await harness({
			...fresh(),
			resets: () => ({
				status: 200,
				body: changedResets((body) => {
					body.data.weekResets = [
						{
							recordId: 920001,
							expireTime: "2026-12-07 23:59:59",
							available: true,
						},
					];
				}),
			}),
		});
		try {
			const read = await granted.reader.read({ signal: signal() });
			expect(read.ok, "the granted snapshot must stay valid").toBe(true);
			if (read.ok)
				expect(read.metrics).toEqual(
					metrics(FIVE_HOUR_RESET, WEEKLY_RESET, 0, 1),
				);
		} finally {
			await granted.close();
		}
		for (const change of [
			(body: typeof resetsFixture) => {
				body.data.weekResets = [
					{ recordId: 920004, expireTime: "soon", available: true },
				];
			},
			(body: typeof resetsFixture) => {
				body.data.weekResets = [
					{ recordId: 920005, expireTime: "2026-12-07 23:59:59", available: 1 },
				];
			},
		]) {
			const server = await harness({
				...fresh(),
				resets: () => ({ status: 200, body: changedResets(change) }),
			});
			try {
				expect(await server.reader.read({ signal: signal() })).toEqual({
					ok: false,
					error: {
						code: "invalid_response",
						httpStatus: 200,
						retryAfterAt: null,
					},
				});
			} finally {
				await server.close();
			}
		}
	});

	test("rejects invalid envelopes on either endpoint", async () => {
		const cases: { name: string; route: "limit" | "resets"; body: string }[] = [
			{
				name: "limit business failure under HTTP 200",
				route: "limit",
				body: changedLimit((body) => {
					body.success = false;
				}),
			},
			{
				name: "limit data.limits missing",
				route: "limit",
				body: JSON.stringify({
					success: true,
					data: { level: "max" },
				}),
			},
			{
				name: "limit nextResetTime not a stamp",
				route: "limit",
				body: JSON.stringify({
					success: true,
					data: {
						limits: [{ type: "CREDIT_LIMIT", unit: 3, nextResetTime: "soon" }],
					},
				}),
			},
			{
				name: "reset targetType not PERSONAL",
				route: "resets",
				body: changedResets((body) => {
					body.data.targetType = "TEAM";
				}),
			},
			{
				name: "reset lastWeekResetTime key missing",
				route: "resets",
				body: JSON.stringify({
					success: true,
					data: {
						targetType: "PERSONAL",
						lastFiveHourResetTime: "2026-11-23 01:50:09",
						fiveHourResets: [],
						weekResets: [],
					},
				}),
			},
			{
				name: "reset lastFiveHourResetTime unparseable",
				route: "resets",
				body: changedResets((body) => {
					body.data.lastFiveHourResetTime = "soon";
				}),
			},
		];
		for (const { name, route, body } of cases) {
			const server = await harness({
				limit: () =>
					route === "limit"
						? { status: 200, body }
						: { status: 200, body: JSON.stringify(limitFixture) },
				resets: () =>
					route === "resets"
						? { status: 200, body }
						: { status: 200, body: JSON.stringify(resetsFixture) },
			});
			try {
				expect(await server.reader.read({ signal: signal() }), name).toEqual({
					ok: false,
					error: {
						code: "invalid_response",
						httpStatus: 200,
						retryAfterAt: null,
					},
				});
			} finally {
				await server.close();
			}
		}
	});

	test("propagates the first failing endpoint without requesting the second", async () => {
		const limitFailure = await harness({
			limit: () => ({ status: 500, body: '{"error":"down"}' }),
			resets: fresh().resets,
		});
		try {
			expect(await limitFailure.reader.read({ signal: signal() })).toEqual({
				ok: false,
				error: { code: "http", httpStatus: 500, retryAfterAt: null },
			});
			expect(limitFailure.counts.resets).toBe(0);
		} finally {
			await limitFailure.close();
		}
		const resetFailure = await harness({
			limit: fresh().limit,
			resets: () => ({ status: 401, body: '{"error":"unauthorized"}' }),
		});
		try {
			expect(await resetFailure.reader.read({ signal: signal() })).toEqual({
				ok: false,
				error: { code: "authentication", httpStatus: 401, retryAfterAt: null },
			});
		} finally {
			await resetFailure.close();
		}
	});

	test("an already-aborted signal makes no requests", async () => {
		const server = await harness(fresh());
		try {
			const controller = new AbortController();
			controller.abort();
			expect(await server.reader.read({ signal: controller.signal })).toEqual({
				ok: false,
				error: { code: "network", httpStatus: null, retryAfterAt: null },
			});
			expect(server.counts).toEqual({ limit: 0, resets: 0 });
		} finally {
			await server.close();
		}
	});

	test("the registry exposes the built-in z.ai adapter", () => {
		const adapter = builtInServiceQuotaAdapters.get("zai-coding-plan");
		expect(adapter?.id).toBe("zai-coding-plan");
		expect(typeof adapter?.createReader).toBe("function");
	});

	test("uses the first matching limit entry", async () => {
		const later = FIVE_HOUR_RESET + 3_600_000;
		const server = await harness({
			limit: () => ({
				status: 200,
				body: changedLimit((body) => {
					// Duplicate CREDIT_LIMIT unit 3 entry: the first must win.
					body.data.limits.unshift({
						type: "CREDIT_LIMIT",
						unit: 3,
						number: 5,
						usage: 28000,
						currentValue: 265,
						remaining: 27734,
						percentage: 1,
						nextResetTime: later,
					});
				}),
			}),
			resets: fresh().resets,
		});
		try {
			const read = await server.reader.read({ signal: signal() });
			expect(read.ok).toBe(true);
			if (read.ok) expect(read.metrics[0]?.resetsAt).toBe(later);
		} finally {
			await server.close();
		}
	});
});

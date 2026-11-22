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

// Epochs for the schema fixture's nextResetTime fields (milliseconds).
const FIVE_HOUR_RESET = 1_764_578_800_000;
const WEEKLY_RESET = 1_765_000_000_000;

// Schema fixture: invented values with the documented envelope shapes; extra fields stay and must be ignored.
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
		level: "PRO",
		limits: [
			{
				type: "TOKENS_LIMIT",
				unit: 3,
				percentage: 100,
				nextResetTime: FIVE_HOUR_RESET,
			},
			{
				type: "TOKENS_LIMIT",
				unit: 6,
				percentage: 8,
				nextResetTime: WEEKLY_RESET,
			},
			{
				type: "TIME_LIMIT",
				unit: 5,
				percentage: 45,
				currentValue: 1828,
				usage: 4000,
				usageDetails: [],
			},
		],
	},
};
const resetsFixture: {
	code: number;
	success: boolean;
	data: Record<string, unknown>;
} = {
	code: 200,
	success: true,
	data: {
		customerId: 41002358991004410,
		targetType: "PERSONAL",
		organizationId: null,
		projectId: null,
		lastFiveHourResetTime: "2026-11-22 10:00:00",
		lastWeekResetTime: "2026-11-19 17:54:00",
		fiveHourResets: [],
		weekResets: [
			{ recordId: 920001, expireTime: "2026-12-07 23:59:59", available: true },
		],
	},
};

function metrics(
	fiveHourResetsAt: number | null,
	weeklyResetsAt: number | null,
	fiveHourRemaining = 0,
	weeklyRemaining = 1,
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
	test("reads the documented snapshot with two fixed authenticated GETs", async () => {
		const server = await harness(fresh());
		try {
			expect(await server.reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(FIVE_HOUR_RESET, WEEKLY_RESET),
			});
			expect(server.counts).toEqual({ limit: 1, resets: 1 });
		} finally {
			await server.close();
		}
	});

	test("falls back to the last reset stamps when the limit entries lack nextResetTime", async () => {
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
			now: () => Date.parse("2026-11-22T10:00:00+08:00") + 60_000,
		});
		try {
			expect(await server.reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(
					Date.parse("2026-11-22T10:00:00+08:00") + 5 * 3_600_000,
					Date.parse("2026-11-19T17:54:00+08:00") + 7 * 86_400_000,
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
			now: () => Date.parse("2026-11-27T10:00:00+08:00"),
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

	test("counts only available grants and rejects malformed reset entries", async () => {
		const mixed = await harness({
			...fresh(),
			resets: () => ({
				status: 200,
				body: changedResets((body) => {
					body.data.weekResets = [
						{
							recordId: 920002,
							expireTime: "2026-12-01 00:00:00",
							available: false,
						},
						{
							recordId: 920003,
							expireTime: "2026-12-07 23:59:59",
							available: true,
						},
					];
				}),
			}),
		});
		try {
			const read = await mixed.reader.read({ signal: signal() });
			expect(read.ok, "the mixed-grants snapshot must stay valid").toBe(true);
			if (read.ok)
				expect(read.metrics).toEqual(metrics(FIVE_HOUR_RESET, WEEKLY_RESET));
		} finally {
			await mixed.close();
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
					data: { level: "PRO" },
				}),
			},
			{
				name: "limit nextResetTime not a stamp",
				route: "limit",
				body: JSON.stringify({
					success: true,
					data: {
						limits: [{ type: "TOKENS_LIMIT", unit: 3, nextResetTime: "soon" }],
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
						lastFiveHourResetTime: "2026-11-22 10:00:00",
						fiveHourResets: [],
						weekResets: [],
					},
				}),
			},
			{
				name: "reset lastFiveHourResetTime unparseable",
				route: "resets",
				body: changedResets((body) => {
					body.data.lastFiveHourResetTime = "yesterday";
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
					body.data.limits.unshift({
						type: "TOKENS_LIMIT",
						unit: 3,
						percentage: 100,
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

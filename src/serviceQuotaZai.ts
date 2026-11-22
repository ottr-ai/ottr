import {
	createServiceQuotaHttpReader,
	type ServiceQuotaHttpReaderOptions,
} from "./serviceQuotaHttp.ts";
import type {
	ServiceQuotaAdapterDefinition,
	ServiceQuotaReader,
} from "./types.ts";

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const limitEndpoint = "https://api.z.ai/api/monitor/usage/quota/limit";
const resetEndpoint =
	"https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL";

interface ResetStamp {
	expireTime: number;
	available: boolean;
}

interface LimitStash {
	fiveHour: number | null;
	weekly: number | null;
}

interface ResetStash {
	fiveHourGrants: number;
	weekGrants: number;
	lastFiveHourReset: number | null;
	lastWeekReset: number | null;
}

// Z.ai stamps are UTC+8 wall-clock strings, not epoch millis or HTTP dates.
function parseStamp(value: unknown): number | null {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
	)
		return null;
	const stamp = Date.parse(`${value.replace(" ", "T")}+08:00`);
	return Number.isFinite(stamp) && stamp > 0 ? stamp : null;
}

function decodeLimit(body: unknown): LimitStash | null {
	if (!record(body) || body.success !== true || !record(body.data)) return null;
	const limits = body.data.limits;
	if (!Array.isArray(limits)) return null;
	const window = (unit: number): number | null | undefined => {
		const entry = limits.find(
			(candidate) =>
				record(candidate) &&
				candidate.type === "TOKENS_LIMIT" &&
				candidate.unit === unit,
		);
		if (!record(entry)) return null;
		if (entry.nextResetTime === undefined) return null;
		// A malformed present stamp rejects the whole response.
		if (
			typeof entry.nextResetTime !== "number" ||
			!Number.isSafeInteger(entry.nextResetTime) ||
			entry.nextResetTime <= 0
		)
			return undefined;
		return entry.nextResetTime;
	};
	const fiveHour = window(3);
	const weekly = window(6);
	if (fiveHour === undefined || weekly === undefined) return null;
	return { fiveHour, weekly };
}

function decodeResets(body: unknown): ResetStash | null {
	if (!record(body) || body.success !== true || !record(body.data)) return null;
	const data = body.data;
	if (data.targetType !== "PERSONAL") return null;
	if (!Array.isArray(data.fiveHourResets) || !Array.isArray(data.weekResets))
		return null;
	if (
		!("lastFiveHourResetTime" in data) ||
		!("lastWeekResetTime" in data) ||
		(data.lastFiveHourResetTime !== null &&
			typeof data.lastFiveHourResetTime !== "string") ||
		(data.lastWeekResetTime !== null &&
			typeof data.lastWeekResetTime !== "string")
	)
		return null;
	const lastFiveHourReset =
		data.lastFiveHourResetTime === null
			? null
			: parseStamp(data.lastFiveHourResetTime);
	const lastWeekReset =
		data.lastWeekResetTime === null ? null : parseStamp(data.lastWeekResetTime);
	// A present but unparseable stamp rejects the whole response.
	if (
		(data.lastFiveHourResetTime !== null && lastFiveHourReset === null) ||
		(data.lastWeekResetTime !== null && lastWeekReset === null)
	)
		return null;
	const grants = (entries: unknown[]): ResetStamp[] | null => {
		const stamps: ResetStamp[] = [];
		for (const entry of entries) {
			if (!record(entry)) return null;
			const expireTime = parseStamp(entry.expireTime);
			if (expireTime === null || typeof entry.available !== "boolean")
				return null;
			stamps.push({ expireTime, available: entry.available });
		}
		return stamps;
	};
	const fiveHourGrants = grants(data.fiveHourResets);
	const weekGrants = grants(data.weekResets);
	if (fiveHourGrants === null || weekGrants === null) return null;
	return {
		fiveHourGrants: fiveHourGrants.filter((grant) => grant.available).length,
		weekGrants: weekGrants.filter((grant) => grant.available).length,
		lastFiveHourReset,
		lastWeekReset,
	};
}

export function createZaiQuotaAdapter(
	options: Pick<ServiceQuotaHttpReaderOptions, "fetch" | "now"> = {},
): ServiceQuotaAdapterDefinition {
	const now = options.now ?? Date.now;
	return {
		id: "zai-coding-plan",
		createReader({ credential }): ServiceQuotaReader {
			let limit: LimitStash | undefined;
			let resets: ResetStash | undefined;
			const limitsReader = createServiceQuotaHttpReader({
				endpoint: limitEndpoint,
				credential,
				decode(body): unknown {
					const stash = decodeLimit(body);
					if (stash === null) return null;
					limit = stash;
					return [];
				},
				fetch: options.fetch,
				now: options.now,
			});
			const resetsReader = createServiceQuotaHttpReader({
				endpoint: resetEndpoint,
				credential,
				decode(body): unknown {
					const stash = decodeResets(body);
					if (stash === null) return null;
					resets = stash;
					return [];
				},
				fetch: options.fetch,
				now: options.now,
			});
			return {
				async read({ signal }) {
					const first = await limitsReader.read({ signal });
					if (!first.ok) return first;
					const second = await resetsReader.read({ signal });
					if (!second.ok) return second;
					if (limit === undefined || resets === undefined)
						return {
							ok: false,
							error: {
								code: "invalid_response",
								httpStatus: 200,
								retryAfterAt: null,
							},
						};
					// A derived fallback older than now is stale, not a reset date.
					const future = (stamp: number | null): number | null =>
						stamp !== null && stamp > now() ? stamp : null;
					const fiveHourFallback =
						resets.lastFiveHourReset === null
							? null
							: resets.lastFiveHourReset + 5 * 3_600_000;
					const weeklyFallback =
						resets.lastWeekReset === null
							? null
							: resets.lastWeekReset + 7 * 86_400_000;
					return {
						ok: true,
						metrics: [
							{
								id: "five-hour-window",
								label: "5-hour window",
								kind: "balance",
								unit: { kind: "count", name: "unused reset grants" },
								remaining: resets.fiveHourGrants,
								reportedTotal: null,
								resetsAt: limit.fiveHour ?? future(fiveHourFallback),
								providerStatus: null,
								plan: null,
							},
							{
								id: "weekly-window",
								label: "Weekly window",
								kind: "balance",
								unit: { kind: "count", name: "unused reset grants" },
								remaining: resets.weekGrants,
								reportedTotal: null,
								resetsAt: limit.weekly ?? future(weeklyFallback),
								providerStatus: null,
								plan: null,
							},
						],
					};
				},
			};
		},
	};
}

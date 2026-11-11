// Web Push: VAPID subject, subscription store (with per-device alert classes), fan-out. Event
// diffing and payloads live in notifications.ts. Network I/O is injected (`send`) so tests never
// hit a push service; server.ts passes web-push's sendNotification.
import type { GlobalStore } from "./globalStore.ts";
import {
	ALERT_CLASSES,
	ALL_CLASSES_ON,
	type ClassPrefs,
} from "./notifications.ts";

// Apple's push service answers 403 BadJwtToken for an @localhost subject; a real https URL it accepts.
export const PUSH_SUBJECT = "https://github.com/ottr-ai/ottr";

export interface PushSub {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	addedAt: number;
	/** Alert classes this device receives; legacy subs without the field read as all on. */
	classes: ClassPrefs;
	/** Public VAPID key this subscription was created under; absent on legacy subs.
	 * A sub bound to a different key than the current one can never receive (ADR-0011 recovery). */
	vapidPublicKey?: string;
}

/** Subs whose bound VAPID key differs from the current one; legacy subs without a bound key stay. */
export function staleSubs(subs: PushSub[], publicKey: string): PushSub[] {
	return subs.filter(
		(s) => s.vapidPublicKey !== undefined && s.vapidPublicKey !== publicKey,
	);
}

/** One stored sub entry; null when the shape is unusable. */
function parseSub(s: unknown): PushSub | null {
	if (typeof s !== "object" || s === null) return null;
	if (!("endpoint" in s) || typeof s.endpoint !== "string") return null;
	if (!("keys" in s) || typeof s.keys !== "object" || s.keys === null)
		return null;
	if (!("p256dh" in s.keys) || typeof s.keys.p256dh !== "string") return null;
	if (!("auth" in s.keys) || typeof s.keys.auth !== "string") return null;
	const out: PushSub = {
		endpoint: s.endpoint,
		keys: { p256dh: s.keys.p256dh, auth: s.keys.auth },
		addedAt: "addedAt" in s && typeof s.addedAt === "number" ? s.addedAt : 0,
		classes: parseClasses("classes" in s ? s.classes : undefined),
	};
	if ("vapidPublicKey" in s && typeof s.vapidPublicKey === "string")
		out.vapidPublicKey = s.vapidPublicKey;
	return out;
}

export function loadSubs(store: GlobalStore): PushSub[] {
	const parsed: unknown = store.get<unknown[]>("push_subs");
	if (!Array.isArray(parsed)) return [];
	const subs: PushSub[] = [];
	for (const s of parsed) {
		const sub = parseSub(s);
		if (sub !== null) subs.push(sub);
	}
	return subs;
}

/** A stored classes field counts only when every class is a boolean; anything else is legacy/corrupt and reads as all on. */
function parseClasses(raw: unknown): ClassPrefs {
	if (typeof raw !== "object" || raw === null) return { ...ALL_CLASSES_ON };
	const rec = raw as Record<string, unknown>;
	if (!ALERT_CLASSES.every((c) => typeof rec[c] === "boolean"))
		return { ...ALL_CLASSES_ON };
	return {
		request: rec.request as boolean,
		error: rec.error as boolean,
		complete: rec.complete as boolean,
	};
}

/** One subscription per endpoint: a re-subscribe replaces the older entry. */
export function saveSubs(store: GlobalStore, subs: PushSub[]): void {
	const seen = new Set<string>();
	const deduped: PushSub[] = [];
	for (const s of subs) {
		if (seen.has(s.endpoint)) continue;
		seen.add(s.endpoint);
		deduped.push(s);
	}
	store.set("push_subs", deduped);
}

/**
 * What one sendAll pass did. `gone` holds unsubscribed endpoints (404/410) for pruneSubs;
 * `failed` counts kept subs whose send did not deliver (403 auth, 5xx, network) — never a success.
 */
export interface SendReport {
	/** Deliveries the push service accepted. */
	sent: number;
	/** Kept subs that did not get the push; they stay subscribed. */
	failed: number;
	/** HTTP status of the first failure, for the caller's error body; undefined = network error. */
	status: number | undefined;
	/** Endpoints that answered 404/410; pass to pruneSubs. */
	gone: Set<string>;
}

/** One send must answer within this bound: web-push sets no timeout, and one hung push
 * endpoint would otherwise stall the fan-out and hold the test-push route open. */
const SEND_TIMEOUT_MS = 10_000;

/** Races one send against a deadline. `Promise.race` attaches handlers to both promises,
 * so a late rejection after the deadline won is swallowed, never unhandled. */
function boundedSend(
	send: Promise<unknown>,
	timeoutMs: number,
): Promise<unknown> {
	const deadline = AbortSignal.timeout(timeoutMs);
	const { promise, reject } = Promise.withResolvers<never>();
	deadline.addEventListener("abort", () => reject(deadline.reason), {
		once: true,
	});
	return Promise.race([send, promise]);
}

/**
 * Sends to every sub; never throws. 404/410 endpoints are gone (unsubscribed device) and land in
 * `gone`. Every other error counts in `failed` and keeps the sub — a 403 (e.g. a rejected VAPID
 * subject) is not a successful send. Each send is bounded by `SEND_TIMEOUT_MS`: a hung push
 * endpoint counts as failed (no status) instead of stalling the loop.
 */
/** The push service's HTTP status on an error response; undefined on a network error. */
function statusOf(err: unknown): number | undefined {
	if (typeof err === "object" && err !== null && "statusCode" in err) {
		const raw: unknown = err.statusCode;
		if (typeof raw === "number") return raw;
	}
	return undefined;
}

/** Records one failed send: 404/410 expires the subscription, anything else keeps it. */
function reportFailure(
	report: SendReport,
	endpoint: string,
	err: unknown,
): void {
	const status = statusOf(err);
	if (status === 404 || status === 410)
		report.gone.add(endpoint); // subscription expired
	else {
		report.failed++;
		report.status ??= status;
		console.error(
			`push send failed${status === undefined ? "" : ` (${status})`}:`,
			err,
		);
	}
}

/**
 * Sends to every sub; never throws. 404/410 endpoints are gone (unsubscribed device) and land in
 * `gone`. Every other error counts in `failed` and keeps the sub — a 403 (e.g. a rejected VAPID
 * subject) is not a successful send. Each send is bounded by `SEND_TIMEOUT_MS`: a hung push
 * endpoint counts as failed (no status) instead of stalling the loop.
 */
export async function sendAll(
	subs: PushSub[],
	payload: string,
	send: (sub: PushSub, payload: string) => Promise<unknown>,
	// web-push has no signal option, so the deadline is a race; injectable for tests.
	timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<SendReport> {
	const report: SendReport = {
		sent: 0,
		failed: 0,
		status: undefined,
		gone: new Set(),
	};
	for (const sub of subs) {
		try {
			await boundedSend(send(sub, payload), timeoutMs);
			report.sent++;
		} catch (err) {
			reportFailure(report, sub.endpoint, err);
		}
	}
	return report;
}

/** Drops gone endpoints against a fresh read, so subscriptions added or removed during the sends survive. */
export function pruneSubs(store: GlobalStore, gone: Set<string>): void {
	if (gone.size === 0) return;
	saveSubs(
		store,
		loadSubs(store).filter((s) => !gone.has(s.endpoint)),
	);
}

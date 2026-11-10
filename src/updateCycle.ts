export const UPDATE_HOST_POLL_MS = 5_000;
export const UPDATE_HOST_LEASE_MS = 45_000;
export const UPDATE_CYCLE_MS = 3_600_000;

export interface UpdateCycleView {
	nextCycleAt: number;
	phase: "idle" | "requested" | "running";
	canStart: boolean;
	error: string | null;
}

export interface UpdateHostHeartbeat {
	controller: string;
	nextCycleAt: number;
	phase: "idle" | "running";
	requestId: string | null;
	error: string | null;
	available: { behind: number; commits: string[] } | null;
}

export interface UpdateHostReply {
	requestId: string | null;
	runningCommit: string | null;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL = /[\p{Cc}\p{Cf}]/u;

export function isUpdateCommit(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, names: string[]): boolean {
	const keys = Object.keys(value);
	return (
		keys.length === names.length && keys.every((key) => names.includes(key))
	);
}

function plain(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		value.trim() === value &&
		!CONTROL.test(value)
	);
}

/** Validate the complete message before any controller state changes. */
export function parseUpdateHostHeartbeat(
	value: unknown,
): UpdateHostHeartbeat | null {
	if (
		!record(value) ||
		!fields(value, [
			"controller",
			"nextCycleAt",
			"phase",
			"requestId",
			"error",
			"available",
		]) ||
		typeof value.controller !== "string" ||
		!ID.test(value.controller) ||
		!Number.isSafeInteger(value.nextCycleAt) ||
		(value.nextCycleAt as number) <= 0 ||
		(value.phase !== "idle" && value.phase !== "running") ||
		(value.requestId !== null &&
			(typeof value.requestId !== "string" || !ID.test(value.requestId))) ||
		(value.phase === "idle" && value.requestId !== null) ||
		(value.error !== null && !plain(value.error, 1_200))
	)
		return null;
	let available: UpdateHostHeartbeat["available"] = null;
	if (value.available !== null) {
		const a = value.available;
		if (
			!record(a) ||
			!fields(a, ["behind", "commits"]) ||
			!Number.isSafeInteger(a.behind) ||
			(a.behind as number) < 0 ||
			!Array.isArray(a.commits) ||
			a.commits.length > 50 ||
			!a.commits.every((subject) => plain(subject, 200))
		)
			return null;
		available = { behind: a.behind as number, commits: [...a.commits] };
	}
	return {
		controller: value.controller,
		nextCycleAt: value.nextCycleAt as number,
		phase: value.phase,
		requestId: value.requestId as string | null,
		error: value.error as string | null,
		available,
	};
}

export function parseUpdateHostReply(value: unknown): UpdateHostReply | null {
	if (
		!record(value) ||
		!fields(value, ["requestId", "runningCommit"]) ||
		(value.requestId !== null &&
			(typeof value.requestId !== "string" || !ID.test(value.requestId))) ||
		(value.runningCommit !== null && !isUpdateCommit(value.runningCommit))
	)
		return null;
	return {
		requestId: value.requestId as string | null,
		runningCommit: value.runningCommit,
	};
}

/** The manual hold is separate from deployment drains and expires with the host lease. */
export class UpdateCycleController {
	private host: UpdateHostHeartbeat | null = null;
	private leaseUntil = 0;
	private requestId: string | null = null;
	private acknowledged = false;
	private completedId: string | null = null;

	private expire(now: number): void {
		if (now < this.leaseUntil) return;
		this.host = null;
		this.requestId = null;
		this.acknowledged = false;
	}

	view(now: number, idle: boolean): UpdateCycleView | null {
		this.expire(now);
		if (this.host === null) return null;
		const phase =
			this.requestId !== null && !this.acknowledged
				? "requested"
				: this.host.phase;
		return {
			nextCycleAt: this.host.nextCycleAt,
			phase,
			canStart: idle && phase === "idle",
			error: this.host.error,
		};
	}

	available(now: number): UpdateHostHeartbeat["available"] {
		this.expire(now);
		return this.host?.available ?? null;
	}

	holdUntil(now: number): number {
		this.expire(now);
		return this.requestId === null ? 0 : this.leaseUntil;
	}

	request(
		now: number,
		idle: boolean,
	): { requestId: string } | { error: string } {
		const view = this.view(now, idle);
		if (view === null) return { error: "Update host is unavailable." };
		if (view.phase !== "idle")
			return { error: "An update cycle is already in progress." };
		if (!idle)
			return { error: "The board is busy or its idle state is unavailable." };
		this.requestId = crypto.randomUUID();
		this.acknowledged = false;
		return { requestId: this.requestId };
	}

	heartbeat(
		heartbeat: UpdateHostHeartbeat,
		now: number,
	): { requestId: string | null } | { error: string } {
		this.expire(now);
		if (this.host !== null && this.host.controller !== heartbeat.controller)
			return { error: "Another update host holds the live lease." };
		// A manual request can arrive after the last idle poll, before a scheduled start.
		if (
			heartbeat.phase === "running" &&
			heartbeat.requestId === null &&
			this.requestId !== null &&
			!this.acknowledged
		) {
			this.host = { ...heartbeat, phase: "idle" };
			this.leaseUntil = now + UPDATE_HOST_LEASE_MS;
			return { requestId: this.requestId };
		}
		if (heartbeat.phase === "running") {
			if (this.requestId !== null && heartbeat.requestId !== this.requestId)
				return { error: "The update request acknowledgement does not match." };
			if (
				heartbeat.requestId !== null &&
				heartbeat.requestId === this.completedId
			)
				return { error: "The update request is complete." };
			// A restarted board has no request in memory. The host restores its acknowledged id.
			this.requestId = heartbeat.requestId;
			this.acknowledged = heartbeat.requestId !== null;
		} else if (this.acknowledged) {
			this.completedId = this.requestId;
			this.requestId = null;
			this.acknowledged = false;
		}
		this.host = heartbeat;
		this.leaseUntil = now + UPDATE_HOST_LEASE_MS;
		return { requestId: this.requestId };
	}
}

#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { openLocked } from "../src/dblock.ts";
import type { SQLiteDatabase } from "../src/sqliteDriver.ts";
import {
	isUpdateCommit,
	parseUpdateHostReply,
	UPDATE_CYCLE_MS,
	UPDATE_HOST_LEASE_MS,
	UPDATE_HOST_POLL_MS,
	type UpdateHostHeartbeat,
	type UpdateHostReply,
} from "../src/updateCycle.ts";
import { git, spawnPiped } from "../src/worktree.ts";
import { dropBunDotenv, envFileValues } from "./update-image.ts";

const COMMAND_TIMEOUT_MS = 12_000;
const GIT_REFRESH_MS = 5 * 60_000;
const BOARD_UNAVAILABLE =
	"The board update control is unavailable. The host will retry.";
type Available = UpdateHostHeartbeat["available"];
type HostCycle = {
	requestId: string | null;
	phase: "pending" | "running" | "finished";
	acknowledged: boolean;
};

export class UpdateHostConflictError extends Error {
	constructor() {
		super(
			"Another live update controller owns the board. Stop the duplicate host command.",
		);
	}
}

/** Canonical paths make a checkout and its symlink share one OS-owned SQLite lock. */
export async function lockUpdateHost(
	repo: string,
	directory = join(tmpdir(), "ottr-update-host"),
): Promise<SQLiteDatabase> {
	let canonical = realpathSync(repo);
	if (process.platform === "win32") canonical = canonical.toLowerCase();
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const name = createHash("sha256").update(canonical).digest("hex");
	const file = join(realpathSync(directory), `${name}.db`);
	const rel = relative(canonical, file);
	if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
		throw new Error(
			"The update controller lock must stay outside the checkout.",
		);
	return await openLocked(file);
}

/** Reject extra fields and malformed replies before they can authorize a host cycle. */
export function parseHostReply(text: string): UpdateHostReply {
	if (text.length > 4096) throw new Error("Invalid update controller reply.");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Invalid update controller reply.");
	}
	const reply = parseUpdateHostReply(value);
	if (reply === null) throw new Error("Invalid update controller reply.");
	return reply;
}

/** Only the double-encoded JSON literal varies. No host data becomes JavaScript or shell code. */
export async function postHostHeartbeat(
	repo: string,
	compose: string[],
	heartbeat: UpdateHostHeartbeat,
	docker: string[] = ["docker"],
): Promise<UpdateHostReply> {
	const script =
		`const body = ${JSON.stringify(JSON.stringify(heartbeat))};` +
		"const u = 'http://127.0.0.1:' + process.env.PORT;" +
		"const r = await fetch(u + '/api/update/host', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { origin: u, 'content-type': 'application/json' }, body });" +
		"console.log(JSON.stringify({ status: r.status, reply: r.ok ? await r.json() : null }));";
	const result = await spawnPiped(
		[
			...docker,
			"compose",
			...compose,
			"exec",
			"-T",
			"server",
			"bun",
			"-e",
			script,
		],
		repo,
		COMMAND_TIMEOUT_MS,
	);
	if (result.code !== 0 || result.stdout.length > 4096)
		throw new Error("The board update control is unavailable.");
	let envelope: unknown;
	try {
		envelope = JSON.parse(result.stdout);
	} catch {
		throw new Error("Invalid update controller reply.");
	}
	if (
		envelope === null ||
		typeof envelope !== "object" ||
		Array.isArray(envelope)
	)
		throw new Error("Invalid update controller reply.");
	const record = envelope as Record<string, unknown>;
	if (Object.keys(record).length !== 2 || !("reply" in record))
		throw new Error("Invalid update controller reply.");
	if (record.status === 409 && record.reply === null)
		throw new UpdateHostConflictError();
	if (record.status !== 200)
		throw new Error("The board update control is unavailable.");
	return parseHostReply(JSON.stringify(record.reply));
}

export function hostCommitSubjects(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.slice(0, 200).replace(/\p{C}/gu, "").trim())
		.filter(Boolean)
		.slice(0, 50);
}

/** A failed fetch invalidates the result, even when an older origin/main still exists. */
export function hostGitAvailability(repo: string) {
	let fetchedAt = -Infinity;
	let fetched = false;
	return async (runningCommit: string, now: number): Promise<Available> => {
		if (!isUpdateCommit(runningCommit)) return null;
		try {
			if (now - fetchedAt >= GIT_REFRESH_MS) {
				fetchedAt = now;
				fetched = false;
				const result = await git(["fetch", "origin", "main"], repo, 30_000);
				fetched = result.code === 0;
			}
			if (!fetched) return null;
			const range = `${runningCommit}..origin/main`;
			const count = await git(
				["rev-list", "--count", range],
				repo,
				COMMAND_TIMEOUT_MS,
			);
			const raw = count.stdout.trim();
			if (count.code !== 0 || !/^(0|[1-9]\d*)$/.test(raw)) return null;
			const behind = Number(raw);
			if (!Number.isSafeInteger(behind)) return null;
			const log = await git(
				["log", "--format=%s", "-n", "50", range],
				repo,
				COMMAND_TIMEOUT_MS,
			);
			if (log.code !== 0) return null;
			return { behind, commits: hostCommitSubjects(log.stdout) };
		} catch {
			// Git errors can contain credentials. Null means unknown, never zero commits.
			return null;
		}
	};
}

/** A new child reads the current updater source after each deploy. */
export async function runUpdateCycle(
	repo: string,
	compose: string[],
): Promise<number> {
	const child = Bun.spawn(
		[process.execPath, resolve(repo, "scripts/update-image.ts"), ...compose],
		{
			cwd: repo,
			env: process.env,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			windowsHide: true,
		},
	);
	return await child.exited;
}

export interface HostDeps {
	now: () => number;
	post: (heartbeat: UpdateHostHeartbeat) => Promise<UpdateHostReply>;
	run: () => Promise<number>;
	available: (runningCommit: string, now: number) => Promise<Available>;
}

export class UpdateHostController {
	readonly controller: string;
	nextCycleAt: number;
	error: string | null = null;
	private cycle: HostCycle | null = null;
	private registered = false;
	private startupConflictAt: number | null = null;
	private child: Promise<void> | null = null;
	private readonly completed = new Set<string>();
	private runningCommit: string | null = null;
	private available: Available = null;
	private readAt = -Infinity;
	private reading: Promise<void> | null = null;
	private readonly deps: HostDeps;

	constructor(deps: HostDeps, controller: string = randomUUID()) {
		this.deps = deps;
		this.controller = controller;
		this.nextCycleAt = deps.now() + UPDATE_CYCLE_MS;
	}

	private launch(): void {
		const cycle = this.cycle;
		if (cycle?.phase !== "pending") return;
		cycle.phase = "running";
		this.advanceSchedule(this.deps.now());
		if (cycle.requestId !== null) this.completed.add(cycle.requestId);
		this.error = null;
		this.child = Promise.resolve()
			.then(() => this.deps.run())
			.then(
				(code) => {
					if (code !== 0)
						this.error = `The update cycle failed with exit code ${code}. Check the host update log.`;
				},
				() => {
					this.error =
						"The update cycle could not start. Check the host update log.";
				},
			)
			.then(() => {
				cycle.phase = "finished";
				this.child = null;
				this.advanceSchedule(this.deps.now());
			});
	}

	private advanceSchedule(now: number): void {
		if (now >= this.nextCycleAt)
			this.nextCycleAt +=
				(Math.floor((now - this.nextCycleAt) / UPDATE_CYCLE_MS) + 1) *
				UPDATE_CYCLE_MS;
	}

	private refresh(commit: string | null): void {
		if (commit !== this.runningCommit) {
			this.runningCommit = commit;
			this.available = null;
			this.readAt = -Infinity;
		}
		if (
			commit === null ||
			this.reading ||
			this.deps.now() - this.readAt < GIT_REFRESH_MS
		)
			return;
		this.readAt = this.deps.now();
		this.reading = this.deps
			.available(commit, this.readAt)
			.then(
				(value) => {
					if (this.runningCommit === commit) this.available = value;
				},
				() => {
					this.available = null;
				},
			)
			.finally(() => {
				this.reading = null;
			});
	}

	private retryStartupConflict(): boolean {
		if (this.registered) return false;
		this.startupConflictAt ??= this.deps.now();
		return this.deps.now() - this.startupConflictAt < UPDATE_HOST_LEASE_MS;
	}

	private acceptReply(
		reply: UpdateHostReply,
		allowStart: boolean,
		cycle: HostCycle | null,
		heartbeat: UpdateHostHeartbeat,
	): void {
		this.registered = true;
		this.startupConflictAt = null;
		if (this.error === BOARD_UNAVAILABLE) this.error = null;
		this.refresh(reply.runningCommit);
		if (cycle === null) {
			this.cycle = this.startCycle(reply, allowStart);
			return;
		}
		if (!allowStart && cycle.phase === "pending") return;
		this.settleCycle(reply, allowStart, cycle, heartbeat);
	}

	/** A reply starts a cycle only when starting is allowed and its request is new. */
	private startCycle(
		reply: UpdateHostReply,
		allowStart: boolean,
	): HostCycle | null {
		if (
			!allowStart ||
			reply.requestId === null ||
			this.completed.has(reply.requestId)
		)
			return null;
		return {
			requestId: reply.requestId,
			phase: "pending",
			acknowledged: false,
		};
	}

	/** Settle a live cycle: drop it, adopt a request, acknowledge it, or rearm it. */
	private settleCycle(
		reply: UpdateHostReply,
		allowStart: boolean,
		cycle: HostCycle,
		heartbeat: UpdateHostHeartbeat,
	): void {
		if (heartbeat.phase === "idle" && reply.requestId === null) {
			this.cycle = null;
		} else if (cycle.requestId === null && reply.requestId !== null) {
			this.adoptRequest(cycle, reply.requestId);
		} else if (
			heartbeat.phase === "running" &&
			heartbeat.requestId === cycle.requestId &&
			reply.requestId === heartbeat.requestId
		) {
			cycle.acknowledged = true;
			if (allowStart) this.launch();
		} else if (
			heartbeat.phase === "idle" &&
			reply.requestId === cycle.requestId
		) {
			cycle.acknowledged = false;
		}
	}

	/** A pending cycle drops a completed request; a running one records the id. */
	private adoptRequest(cycle: HostCycle, requestId: string): void {
		if (this.completed.has(requestId)) {
			if (cycle.phase === "pending") this.cycle = null;
			return;
		}
		cycle.requestId = requestId;
		cycle.acknowledged = false;
		if (cycle.phase !== "pending") this.completed.add(requestId);
	}

	/** The loop calls this serially. A child and git refresh never block a heartbeat. */
	async poll(allowStart = true): Promise<void> {
		if (this.cycle?.phase === "running") this.advanceSchedule(this.deps.now());
		const scheduled = this.startDue(allowStart);
		if (scheduled)
			this.cycle = {
				requestId: null,
				phase: "pending",
				acknowledged: false,
			};
		// Attribute an awaited reply to its cycle, even if the child exits first.
		const cycle = this.cycle;
		const heartbeat = this.heartbeat(cycle);
		let reply: UpdateHostReply | null = null;
		try {
			reply = await this.deps.post(heartbeat);
		} catch (error) {
			if (this.conflictRetry(error)) return;
			// Do not expose Docker output or exception text in board status.
			if (this.error === null) this.error = BOARD_UNAVAILABLE;
		}
		if (reply !== null) this.acceptReply(reply, allowStart, cycle, heartbeat);
		// An explicit conflict blocks fallback until the board accepts this controller.
		if (scheduled && reply === null && this.startupConflictAt === null)
			this.launch();
	}

	/** A cycle may start only when starting is allowed, the schedule is due, and none runs. */
	private startDue(allowStart: boolean): boolean {
		return (
			allowStart && this.deps.now() >= this.nextCycleAt && this.cycle === null
		);
	}

	/** The heartbeat reports a finished, fully acknowledged cycle as idle. */
	private heartbeat(cycle: HostCycle | null): UpdateHostHeartbeat {
		const completing =
			cycle?.phase === "finished" &&
			(cycle.requestId === null || cycle.acknowledged);
		const phase = cycle === null || completing ? "idle" : "running";
		const requestId = phase === "running" ? (cycle?.requestId ?? null) : null;
		return {
			controller: this.controller,
			nextCycleAt: this.nextCycleAt,
			phase,
			requestId,
			error: this.error,
			available: this.available,
		};
	}

	/** A startup conflict inside its retry window ends the poll; past the window it rethrows. */
	private conflictRetry(error: unknown): boolean {
		if (!(error instanceof UpdateHostConflictError)) return false;
		if (!this.retryStartupConflict()) throw error;
		return true;
	}

	get running(): boolean {
		return this.child !== null;
	}

	async finish(): Promise<void> {
		await this.child;
		await this.reading;
	}
}

if (import.meta.main) {
	const repo = resolve(import.meta.dir, "..");
	const compose = process.argv.slice(2);
	let stop = false;
	const signal = () => {
		stop = true;
	};
	process.on("SIGINT", signal);
	process.on("SIGTERM", signal);
	let lock: SQLiteDatabase | null = null;
	let host: UpdateHostController | null = null;
	try {
		lock = await lockUpdateHost(repo);
		dropBunDotenv(compose);
		for (const [key, value] of Object.entries(envFileValues(compose))) {
			if (process.env[key] === undefined) process.env[key] = value;
		}
		host = new UpdateHostController({
			now: Date.now,
			post: (heartbeat) => postHostHeartbeat(repo, compose, heartbeat),
			run: () => runUpdateCycle(repo, compose),
			available: hostGitAvailability(repo),
		});
		while (!stop || host.running) {
			const started = Date.now();
			await host.poll(!stop);
			await Bun.sleep(
				Math.max(0, UPDATE_HOST_POLL_MS - (Date.now() - started)),
			);
		}
	} catch (error) {
		console.error(
			error instanceof UpdateHostConflictError
				? error.message
				: "The host update command failed. Check the checkout, Docker, and the exclusive host lock.",
		);
		process.exitCode = 1;
	} finally {
		// Keep the lock while an existing child finishes. Never terminate its deploy.
		await host?.finish();
		await lock?.close();
		process.off("SIGINT", signal);
		process.off("SIGTERM", signal);
	}
}

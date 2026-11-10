import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreLockedError } from "../src/dblock.ts";
import fc from "../src/test/properties.ts";
import {
	UPDATE_CYCLE_MS,
	UPDATE_HOST_LEASE_MS,
	UPDATE_HOST_POLL_MS,
	UpdateCycleController,
	type UpdateHostHeartbeat,
	type UpdateHostReply,
} from "../src/updateCycle.ts";
import { gitExe } from "../src/worktree.ts";
import {
	type HostDeps,
	hostCommitSubjects,
	hostGitAvailability,
	lockUpdateHost,
	parseHostReply,
	postHostHeartbeat,
	runUpdateCycle,
	UpdateHostConflictError,
	UpdateHostController,
} from "./update-host.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-update-host-test-"));
let sequence = 0;
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
const fixture = () => {
	const dir = join(root, String(sequence++));
	mkdirSync(dir);
	return dir;
};
const commit = "a".repeat(40);
const response = (requestId: string | null = null): UpdateHostReply => ({
	requestId,
	runningCommit: commit,
});
const heartbeat = (): UpdateHostHeartbeat => ({
	controller: "controller-1",
	nextCycleAt: UPDATE_CYCLE_MS,
	phase: "idle",
	requestId: null,
	error: null,
	available: null,
});

function harness(
	overrides: Partial<HostDeps> = {},
	controller = "test-controller",
) {
	let now = 1000;
	let launches = 0;
	let pending: string | null = null;
	let acknowledged: string | null = null;
	let release: (code: number) => void = () => {
		throw new Error("No child exists.");
	};
	const sent: UpdateHostHeartbeat[] = [];
	const deps: HostDeps = {
		now: () => now,
		post: async (body) => {
			sent.push(structuredClone(body));
			if (body.phase === "idle" && acknowledged !== null) {
				pending = null;
				acknowledged = null;
			} else if (body.phase === "running" && body.requestId === pending) {
				acknowledged = pending;
			}
			return response(pending);
		},
		run: () => {
			launches++;
			const deferred = Promise.withResolvers<number>();
			release = deferred.resolve;
			return deferred.promise;
		},
		available: async () => ({ behind: 2, commits: ["two", "one"] }),
		...overrides,
	};
	const host = new UpdateHostController(deps, controller);
	return {
		host,
		sent,
		get launches() {
			return launches;
		},
		setTime: (value: number) => {
			now = value;
		},
		request: (id: string | null) => {
			pending = id;
		},
		complete: async (code = 0) => {
			release(code);
			await host.finish();
		},
	};
}

function brokerPost(
	broker: UpdateCycleController,
	now: () => number,
): HostDeps["post"] {
	return async (body) => {
		const reply = broker.heartbeat(body, now());
		if ("error" in reply) throw new UpdateHostConflictError();
		return { ...reply, runningCommit: commit };
	};
}

describe("persistent host cycle", () => {
	test("a manual request needs a matching running acknowledgement and launches one full child", async () => {
		const dir = fixture();
		mkdirSync(join(dir, "scripts"));
		const output = join(dir, "cycles.jsonl");
		const args = [
			"-f",
			"file with spaces.yml",
			"--env-file",
			"quoted'\";$(literal).env",
		];
		writeFileSync(
			join(dir, "scripts", "update-image.ts"),
			`import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(output)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');`,
		);
		const f = harness({ run: () => runUpdateCycle(dir, args) });
		const next = f.host.nextCycleAt;
		f.request("manual-1");
		await f.host.poll();
		expect(f.sent.at(-1)?.phase).toBe("idle");
		expect(f.host.running).toBe(false);
		await f.host.poll();
		await f.host.finish();
		await f.host.poll();
		await f.host.poll();
		expect(
			f.sent.some(
				(body) => body.phase === "running" && body.requestId === "manual-1",
			),
		).toBe(true);
		expect(f.host.nextCycleAt).toBe(next);
		const cycles = readFileSync(output, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(cycles).toEqual([{ cwd: dir, args }]);
	});

	test("each cycle reads the current updater source and preserves Compose argv", async () => {
		const dir = fixture();
		mkdirSync(join(dir, "scripts"));
		const script = join(dir, "scripts", "update-image.ts");
		const out = join(dir, "source.txt");
		writeFileSync(script, `await Bun.write(${JSON.stringify(out)}, 'first');`);
		expect(
			await runUpdateCycle(dir, ["--project-name", "literal ; name"]),
		).toBe(0);
		expect(readFileSync(out, "utf8")).toBe("first");
		writeFileSync(script, `await Bun.write(${JSON.stringify(out)}, 'second');`);
		expect(await runUpdateCycle(dir, [])).toBe(0);
		expect(readFileSync(out, "utf8")).toBe("second");
	});

	test("manual cycles leave the hourly slot unchanged and long cycles skip slots without overlap", async () => {
		const f = harness();
		const first = f.host.nextCycleAt;
		f.request("manual-long");
		await f.host.poll();
		await f.host.poll();
		expect(f.launches).toBe(1);
		expect(f.host.nextCycleAt).toBe(first);
		f.setTime(first + UPDATE_CYCLE_MS * 2 + 100);
		await f.host.poll();
		await f.host.poll();
		expect(f.launches).toBe(1);
		expect(f.host.nextCycleAt).toBe(first + UPDATE_CYCLE_MS * 3);
		await f.complete();
		f.request(null);
		await f.host.poll();
		expect(f.launches).toBe(1);
		f.setTime(first + UPDATE_CYCLE_MS * 3);
		await f.host.poll();
		expect(f.launches).toBe(2);
		await f.complete();
	});

	test("a manual request at the due slot needs its own running acknowledgement", async () => {
		const f = harness();
		f.setTime(f.host.nextCycleAt);
		f.request("due-slot");
		await f.host.poll();
		expect(f.sent.at(-1)).toMatchObject({ phase: "running", requestId: null });
		expect(f.launches).toBe(0);
		await f.host.poll();
		expect(f.sent.at(-1)).toMatchObject({
			phase: "running",
			requestId: "due-slot",
		});
		expect(f.launches).toBe(1);
		await f.host.poll();
		expect(f.launches).toBe(1);
		await f.complete();
		f.request(null);
		await f.host.poll();
		expect(f.launches).toBe(1);
	});

	test("a restarted host waits for the old broker lease and then starts its due cycle", async () => {
		let now = 1000;
		const broker = new UpdateCycleController();
		const deps = { now: () => now, post: brokerPost(broker, () => now) };
		const old = harness(deps, "previous-controller");
		await old.host.poll();
		const restarted = harness(deps);
		restarted.host.nextCycleAt = now;
		const initial = now;
		for (
			let elapsed = 0;
			elapsed < UPDATE_HOST_LEASE_MS;
			elapsed += UPDATE_HOST_POLL_MS
		) {
			now = initial + elapsed;
			await restarted.host.poll();
			expect(restarted.launches).toBe(0);
			expect(broker.view(now, true)?.phase).toBe("idle");
		}
		now = initial + UPDATE_HOST_LEASE_MS;
		await restarted.host.poll();
		expect(restarted.launches).toBe(1);
		expect(broker.view(now, true)?.phase).toBe("running");
		expect(old.launches).toBe(0);
		await restarted.complete();
		await restarted.host.poll();
		expect(broker.view(now, true)?.phase).toBe("idle");
	});

	test("a renewed broker lease refuses a duplicate after one startup grace period", async () => {
		let now = 1000;
		const broker = new UpdateCycleController();
		const deps = { now: () => now, post: brokerPost(broker, () => now) };
		const active = harness(deps, "active-controller");
		const duplicate = harness(deps);
		duplicate.host.nextCycleAt = now;
		const initial = now;
		for (
			let elapsed = 0;
			elapsed < UPDATE_HOST_LEASE_MS;
			elapsed += UPDATE_HOST_POLL_MS
		) {
			now = initial + elapsed;
			await active.host.poll();
			await duplicate.host.poll();
			expect(duplicate.launches).toBe(0);
		}
		now = initial + UPDATE_HOST_LEASE_MS;
		await active.host.poll();
		await expect(duplicate.host.poll()).rejects.toBeInstanceOf(
			UpdateHostConflictError,
		);
		expect(duplicate.launches).toBe(0);
		expect(active.launches).toBe(0);
		expect(broker.view(now, true)?.phase).toBe("idle");
	});

	test("an explicit startup conflict prevents a later unavailable-board fallback", async () => {
		let now = 1000;
		let unavailable = false;
		const broker = new UpdateCycleController();
		const post = brokerPost(broker, () => now);
		const active = harness({ now: () => now, post }, "active-controller");
		await active.host.poll();
		const duplicate = harness({
			now: () => now,
			post: async (body) => {
				if (unavailable) throw new Error("private transport failure");
				return await post(body);
			},
		});
		await duplicate.host.poll();
		now += UPDATE_HOST_POLL_MS;
		duplicate.host.nextCycleAt = now;
		unavailable = true;
		await duplicate.host.poll();
		expect(duplicate.launches).toBe(0);
		expect(duplicate.host.error).not.toContain("private transport failure");
		unavailable = false;
		now = 1000 + UPDATE_HOST_LEASE_MS;
		await duplicate.host.poll();
		expect(duplicate.launches).toBe(1);
		await duplicate.complete();
	});

	test("a due scheduled cycle recovers a stopped board but a controller conflict never deploys", async () => {
		const f = harness({
			post: async () => {
				throw new Error("server stopped");
			},
		});
		f.setTime(f.host.nextCycleAt);
		await f.host.poll();
		expect(f.launches).toBe(1);
		await f.complete();
		let conflict = false;
		const duplicate = harness({
			post: async () => {
				if (conflict) throw new UpdateHostConflictError();
				return response();
			},
		});
		await duplicate.host.poll();
		conflict = true;
		duplicate.setTime(duplicate.host.nextCycleAt);
		await expect(duplicate.host.poll()).rejects.toBeInstanceOf(
			UpdateHostConflictError,
		);
		expect(duplicate.launches).toBe(0);
	});

	test("lost running replies retry the same id and a restart restores registration during the child", async () => {
		let pending: string | null = "lost-reply";
		let failNext = false;
		const registration: { controller: string | null } = { controller: null };
		let acknowledged: string | null = null;
		const sent: UpdateHostHeartbeat[] = [];
		const f = harness({
			post: async (body) => {
				sent.push(structuredClone(body));
				registration.controller = body.controller;
				if (failNext) {
					failNext = false;
					throw new Error("lost response with private data");
				}
				if (body.phase === "idle" && acknowledged !== null) {
					acknowledged = null;
					return response();
				}
				if (body.phase === "running") acknowledged = body.requestId;
				return response(body.phase === "running" ? body.requestId : pending);
			},
		});
		await f.host.poll();
		failNext = true;
		await f.host.poll();
		expect(f.launches).toBe(0);
		await f.host.poll();
		expect(f.launches).toBe(1);
		registration.controller = null;
		pending = null;
		await f.host.poll();
		expect(registration).toEqual({ controller: "test-controller" });
		expect(sent.at(-1)).toMatchObject({
			phase: "running",
			requestId: "lost-reply",
		});
		expect(f.launches).toBe(1);
		await f.complete();
		// Completion returns null. The next idle reply deliberately replays the old id.
		pending = "lost-reply";
		await f.host.poll();
		await f.host.poll();
		expect(f.launches).toBe(1);
		expect(sent.at(-1)).toMatchObject({ phase: "idle", requestId: null });
		expect(sent.map((body) => body.error).join(" ")).not.toContain(
			"private data",
		);
	});

	test("a scheduled fallback adopts a pending broker request without a second child", async () => {
		let now = 1000;
		let loseNext = false;
		const broker = new UpdateCycleController();
		const post = brokerPost(broker, () => now);
		const f = harness({
			now: () => now,
			post: async (body) => {
				if (loseNext) {
					loseNext = false;
					throw new Error("lost scheduled heartbeat");
				}
				return await post(body);
			},
		});
		now = f.host.nextCycleAt;
		await post({ ...heartbeat(), controller: f.host.controller });
		expect(broker.request(now, true)).toHaveProperty("requestId");
		loseNext = true;
		await f.host.poll();
		expect(f.launches).toBe(1);
		expect(broker.view(now, true)?.phase).toBe("requested");
		await f.host.poll();
		expect(f.launches).toBe(1);
		expect(broker.view(now, true)?.phase).toBe("requested");
		await f.host.poll();
		expect(f.launches).toBe(1);
		expect(broker.view(now, true)?.phase).toBe("running");
		expect(broker.holdUntil(now)).toBe(now + UPDATE_HOST_LEASE_MS);
		await f.complete();
		await f.host.poll();
		await f.host.poll();
		expect(f.launches).toBe(1);
		expect(broker.view(now, true)?.phase).toBe("idle");
		expect(broker.holdUntil(now)).toBe(0);
	});

	test.each(["manual", "adoption"])(
		"a %s child completes its board hold before the next due cycle",
		async (kind) => {
			let now = 1000;
			let loseNext = false;
			const sent: UpdateHostHeartbeat[] = [];
			const broker = new UpdateCycleController();
			const post = brokerPost(broker, () => now);
			const f = harness({
				now: () => now,
				post: async (body) => {
					sent.push(structuredClone(body));
					if (loseNext) {
						loseNext = false;
						throw new Error("lost scheduled heartbeat");
					}
					return await post(body);
				},
			});
			now = f.host.nextCycleAt - 10_000;
			await f.host.poll();
			const request = broker.request(now, true);
			expect(request).toHaveProperty("requestId");
			if (kind === "adoption") {
				now = f.host.nextCycleAt;
				loseNext = true;
				await f.host.poll();
			}
			await f.host.poll();
			await f.host.poll();
			expect(f.launches).toBe(1);
			expect(broker.view(now, true)?.phase).toBe("running");
			const due = f.host.nextCycleAt;
			while (now + UPDATE_HOST_POLL_MS < due - 3000) {
				now += UPDATE_HOST_POLL_MS;
				await f.host.poll();
			}
			now = due - 3000;
			await f.host.poll();
			now = due - 2000;
			await f.complete();
			expect(f.host.nextCycleAt).toBe(due);
			expect(broker.holdUntil(now)).toBeGreaterThan(now);
			now = due + 3000;
			await f.host.poll();
			expect(sent.at(-1)).toMatchObject({
				phase: "idle",
				requestId: null,
				nextCycleAt: due,
			});
			expect(broker.view(now, true)?.phase).toBe("idle");
			expect(broker.holdUntil(now)).toBe(0);
			expect(f.launches).toBe(1);
			expect(f.host.nextCycleAt).toBe(due);
			await f.host.poll();
			expect(f.launches).toBe(2);
			expect(f.host.nextCycleAt).toBe(due + UPDATE_CYCLE_MS);
			expect(broker.view(now, true)?.phase).toBe("running");
			await f.host.poll();
			expect(f.launches).toBe(2);
			await f.complete();
			await f.host.poll();
			expect(broker.view(now, true)?.phase).toBe("idle");
			expect(broker.holdUntil(now)).toBe(0);
		},
	);

	test.each(["before", "after"])(
		"an idle completion lost %s broker acceptance retries before the due cycle",
		async (loss) => {
			let now = 1000;
			let loseNext = false;
			const sent: UpdateHostHeartbeat[] = [];
			const broker = new UpdateCycleController();
			const post = brokerPost(broker, () => now);
			const f = harness({
				now: () => now,
				post: async (body) => {
					sent.push(structuredClone(body));
					if (loseNext && loss === "before") {
						loseNext = false;
						throw new Error("lost idle completion");
					}
					const reply = await post(body);
					if (loseNext) {
						loseNext = false;
						throw new Error("lost idle completion reply");
					}
					return reply;
				},
			});
			const due = f.host.nextCycleAt;
			now = due - 10_000;
			await f.host.poll();
			expect(broker.request(now, true)).toHaveProperty("requestId");
			await f.host.poll();
			await f.host.poll();
			expect(f.launches).toBe(1);
			now = due - 3000;
			await f.host.poll();
			now = due - 2000;
			await f.complete();
			now = due + 3000;
			loseNext = true;
			await f.host.poll();
			expect(f.launches).toBe(1);
			expect(f.host.nextCycleAt).toBe(due);
			expect(sent.at(-1)?.phase).toBe("idle");
			expect(broker.view(now, true)?.phase).toBe(
				loss === "before" ? "running" : "idle",
			);
			now += UPDATE_HOST_POLL_MS;
			await f.host.poll();
			expect(f.launches).toBe(1);
			expect(f.host.nextCycleAt).toBe(due);
			expect(sent.at(-1)?.phase).toBe("idle");
			expect(broker.view(now, true)?.phase).toBe("idle");
			expect(broker.holdUntil(now)).toBe(0);
			await f.host.poll();
			await f.host.poll();
			expect(f.launches).toBe(2);
			expect(f.host.nextCycleAt).toBe(due + UPDATE_CYCLE_MS);
			await f.complete();
			await f.host.poll();
		},
	);

	test.each([
		["offer", false],
		["offer", true],
		["acknowledgement", false],
		["acknowledgement", true],
	] as const)(
		"a fallback completes during the pending request %s reply (lost: %s) without a second child",
		async (stage, loseReply) => {
			let now = 1000;
			let loseNext = false;
			let delayNext = false;
			const delayed = Promise.withResolvers<UpdateHostReply>();
			const posted = Promise.withResolvers<UpdateHostReply>();
			const broker = new UpdateCycleController();
			const post = brokerPost(broker, () => now);
			const f = harness({
				now: () => now,
				post: async (body) => {
					if (loseNext) {
						loseNext = false;
						throw new Error("lost scheduled heartbeat");
					}
					const reply = await post(body);
					if (delayNext) {
						delayNext = false;
						posted.resolve(reply);
						const received = await delayed.promise;
						if (loseReply) throw new Error("lost pending request reply");
						return received;
					}
					return reply;
				},
			});
			now = f.host.nextCycleAt;
			await post({ ...heartbeat(), controller: f.host.controller });
			expect(broker.request(now, true)).toHaveProperty("requestId");
			loseNext = true;
			await f.host.poll();
			expect(f.launches).toBe(1);
			if (stage === "acknowledgement") await f.host.poll();
			delayNext = true;
			const polling = f.host.poll();
			const reply = await posted.promise;
			await f.complete();
			expect(f.host.running).toBe(false);
			delayed.resolve(reply);
			await polling;
			await f.host.poll();
			await f.host.poll();
			await f.host.poll();
			expect(f.launches).toBe(1);
			expect(broker.view(now, true)?.phase).toBe("idle");
			expect(broker.holdUntil(now)).toBe(0);
			const due = f.host.nextCycleAt;
			now = due;
			await f.host.poll();
			await f.host.poll();
			expect(f.launches).toBe(2);
			expect(f.host.nextCycleAt).toBe(due + UPDATE_CYCLE_MS);
			await f.complete();
			await f.host.poll();
		},
	);

	test("completion retries retain one due slot without duplicate children", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.boolean(), { maxLength: 6 }),
				fc.integer({ min: 1, max: UPDATE_CYCLE_MS * 3 }),
				async (losses, delay) => {
					let now = 1000;
					let loss: boolean | null = null;
					const broker = new UpdateCycleController();
					const post = brokerPost(broker, () => now);
					const f = harness({
						now: () => now,
						post: async (body) => {
							if (loss === false) throw new Error("lost completion");
							const reply = await post(body);
							if (loss === true) throw new Error("lost completion reply");
							return reply;
						},
					});
					const due = f.host.nextCycleAt;
					now = due - 10_000;
					await f.host.poll();
					expect(broker.request(now, true)).toHaveProperty("requestId");
					await f.host.poll();
					await f.host.poll();
					expect(f.launches).toBe(1);
					now = due - 2000;
					await f.complete();
					now = due + delay;
					for (const lostAfterAcceptance of losses) {
						loss = lostAfterAcceptance;
						await f.host.poll();
						expect(f.launches).toBe(1);
						expect(f.host.nextCycleAt).toBe(due);
						now += UPDATE_HOST_POLL_MS;
					}
					loss = null;
					await f.host.poll();
					expect(broker.view(now, true)?.phase).toBe("idle");
					expect(broker.holdUntil(now)).toBe(0);
					expect(f.launches).toBe(1);
					expect(f.host.nextCycleAt).toBe(due);
					await f.host.poll();
					await f.host.poll();
					expect(f.launches).toBe(2);
					expect(f.host.nextCycleAt).toBe(
						due +
							(Math.floor((now - due) / UPDATE_CYCLE_MS) + 1) * UPDATE_CYCLE_MS,
					);
					await f.complete();
					await f.host.poll();
					expect(broker.view(now, true)?.phase).toBe("idle");
				},
			),
		);
	});

	test("a completed request replay cannot duplicate a child or consume the due slot", async () => {
		const f = harness();
		f.request("completed-request");
		await f.host.poll();
		await f.host.poll();
		await f.complete();
		await f.host.poll();
		const due = f.host.nextCycleAt;
		f.setTime(due);
		f.request("completed-request");
		await f.host.poll();
		expect(f.launches).toBe(1);
		expect(f.host.nextCycleAt).toBe(due);
		f.request(null);
		await f.host.poll();
		await f.host.poll();
		expect(f.launches).toBe(2);
		expect(f.host.nextCycleAt).toBe(due + UPDATE_CYCLE_MS);
		await f.complete();
		await f.host.poll();
	});

	test("a missing acknowledgement never launches a manual cycle", async () => {
		let reply = response("wanted");
		const f = harness({ post: async () => reply });
		await f.host.poll();
		reply = response("wrong-id");
		await f.host.poll();
		reply = response();
		await f.host.poll();
		expect(f.launches).toBe(0);
		reply = response("wanted");
		await f.host.poll();
		expect(f.launches).toBe(1);
		await f.complete();
	});

	test("failed children report failure and the next successful cycle clears it", async () => {
		const f = harness();
		f.request("failed");
		await f.host.poll();
		await f.host.poll();
		await f.complete(7);
		f.request(null);
		await f.host.poll();
		expect(f.sent.at(-1)?.error).toContain("exit code 7");
		expect(f.sent.at(-1)?.phase).toBe("idle");
		f.request("retry");
		await f.host.poll();
		await f.host.poll();
		await f.complete();
		f.request(null);
		await f.host.poll();
		expect(f.sent.at(-1)?.error).toBeNull();
	});

	test("spawn errors disclose no exception text", async () => {
		const f = harness({
			run: async () => {
				throw new Error("private child exception");
			},
		});
		f.request("spawn-failed");
		await f.host.poll();
		await f.host.poll();
		await f.host.finish();
		expect(f.host.error).toBe(
			"The update cycle could not start. Check the host update log.",
		);
	});

	test("slow git refreshes never delay heartbeats and a changed running commit invalidates old metadata", async () => {
		let resolveRead: (value: UpdateHostHeartbeat["available"]) => void =
			() => {};
		let reads = 0;
		let current = commit;
		const sent: UpdateHostHeartbeat[] = [];
		const f = harness({
			post: async (body) => {
				sent.push(structuredClone(body));
				return { requestId: null, runningCommit: current };
			},
			available: async () => {
				reads++;
				const deferred =
					Promise.withResolvers<UpdateHostHeartbeat["available"]>();
				resolveRead = deferred.resolve;
				return await deferred.promise;
			},
		});
		await f.host.poll();
		await f.host.poll();
		expect(sent).toHaveLength(2);
		expect(reads).toBe(1);
		resolveRead({ behind: 2, commits: ["new"] });
		await f.host.finish();
		await f.host.poll();
		expect(sent.at(-1)?.available?.behind).toBe(2);
		current = "b".repeat(40);
		await f.host.poll();
		await f.host.poll();
		expect(sent.at(-1)?.available).toBeNull();
		expect(reads).toBe(2);
		resolveRead(null);
		await f.host.finish();
	});
});

describe("host transport and external input", () => {
	test("the real Docker argv transport executes its fixed script against a local HTTP bridge", async () => {
		const dir = fixture();
		const record = join(dir, "argv.json");
		const requests: { origin: string | null; path: string; body: unknown }[] =
			[];
		let status = 200;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				requests.push({
					origin: request.headers.get("origin"),
					path: new URL(request.url).pathname,
					body: await request.json(),
				});
				return Response.json(
					status === 200
						? response("manual-http")
						: { error: "private response text" },
					{ status },
				);
			},
		});
		const docker = join(dir, "docker.ts");
		writeFileSync(
			docker,
			`await Bun.write(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));` +
				`const a = process.argv.slice(2); const i = a.indexOf('exec');` +
				`if (a[0] !== 'compose' || a.slice(i, i + 5).join('|') !== 'exec|-T|server|bun|-e') process.exit(10);` +
				`const child = Bun.spawn([process.execPath, '-e', a.at(-1)], { env: { ...process.env, PORT: ${JSON.stringify(String(server.port))} }, stdout: 'inherit', stderr: 'inherit' }); process.exitCode = await child.exited;`,
		);
		const compose = [
			"-f",
			"override with spaces.yml",
			"--env-file",
			"literal'\";$(not-code).env",
		];
		const body = heartbeat();
		body.available = {
			behind: 1,
			commits: ["subject '\" \\ ); globalThis.hostCodeRan = true; //"],
		};
		try {
			expect(
				await postHostHeartbeat(dir, compose, body, [process.execPath, docker]),
			).toEqual(response("manual-http"));
			const argv = JSON.parse(readFileSync(record, "utf8")) as string[];
			expect(argv.slice(0, -1)).toEqual([
				"compose",
				...compose,
				"exec",
				"-T",
				"server",
				"bun",
				"-e",
			]);
			expect(requests).toEqual([
				{
					origin: `http://127.0.0.1:${server.port}`,
					path: "/api/update/host",
					body,
				},
			]);
			status = 409;
			await expect(
				postHostHeartbeat(dir, compose, body, [process.execPath, docker]),
			).rejects.toBeInstanceOf(UpdateHostConflictError);
			status = 500;
			await expect(
				postHostHeartbeat(dir, compose, body, [process.execPath, docker]),
			).rejects.toThrow("The board update control is unavailable.");
		} finally {
			await server.stop(true);
		}
	});

	test("malformed transport output never authorizes a request", async () => {
		const dir = fixture();
		const docker = join(dir, "invalid-docker.ts");
		for (const text of [
			"warning\n{}",
			'{"status":200,"reply":{"requestId":"x"}}',
			'{"status":200,"reply":null}',
			'{"status":409,"reply":null,"extra":true}',
		]) {
			writeFileSync(docker, `console.log(${JSON.stringify(text)});`);
			await expect(
				postHostHeartbeat(dir, [], heartbeat(), [process.execPath, docker]),
			).rejects.toThrow();
		}
		writeFileSync(
			docker,
			"console.error('private Docker error'); process.exit(1);",
		);
		await expect(
			postHostHeartbeat(dir, [], heartbeat(), [process.execPath, docker]),
		).rejects.toThrow("The board update control is unavailable.");
	});

	test("strict reply parsing rejects arbitrary invalid JSON values without input in errors", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				let valid = false;
				if (
					value !== null &&
					typeof value === "object" &&
					!Array.isArray(value)
				) {
					const item = value as Record<string, unknown>;
					valid =
						Object.keys(item).length === 2 &&
						(item.requestId === null ||
							(typeof item.requestId === "string" &&
								/^[A-Za-z0-9_-]{1,128}$/.test(item.requestId))) &&
						(item.runningCommit === null ||
							(typeof item.runningCommit === "string" &&
								/^[a-f0-9]{7,40}$/.test(item.runningCommit)));
				}
				const text = JSON.stringify(value);
				if (valid) expect<unknown>(parseHostReply(text)).toEqual(value);
				else
					expect(() => parseHostReply(text)).toThrow(
						"Invalid update controller reply.",
					);
			}),
		);
		expect(() => parseHostReply("private malformed JSON")).toThrow(
			"Invalid update controller reply.",
		);
		expect(() => parseHostReply(" ".repeat(4097))).toThrow(
			"Invalid update controller reply.",
		);
	});

	test("reply fields enforce their character bounds", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (requestId, runningCommit) => {
				const valid =
					/^[A-Za-z0-9_-]{1,128}$/.test(requestId) &&
					/^[a-f0-9]{7,40}$/.test(runningCommit);
				const value = { requestId, runningCommit };
				if (valid) expect(parseHostReply(JSON.stringify(value))).toEqual(value);
				else
					expect(() => parseHostReply(JSON.stringify(value))).toThrow(
						"Invalid update controller reply.",
					);
			}),
		);
		for (const value of [
			{ requestId: "", runningCommit: commit },
			{ requestId: "x".repeat(129), runningCommit: commit },
			{ requestId: "x", runningCommit: commit.toUpperCase() },
			{ ...response(), extra: true },
		])
			expect(() => parseHostReply(JSON.stringify(value))).toThrow();
	});

	test("commit subjects remain bounded, plain, trimmed, and idempotent", () => {
		const text = fc
			.array(fc.integer({ min: 0, max: 0x10ffff }), { maxLength: 500 })
			.map((points) => String.fromCodePoint(...points));
		fc.assert(
			fc.property(text, (input) => {
				const subjects = hostCommitSubjects(input);
				expect(subjects.length).toBeLessThanOrEqual(50);
				for (const subject of subjects) {
					expect(subject.length).toBeGreaterThan(0);
					expect(subject.length).toBeLessThanOrEqual(200);
					expect(subject).toBe(subject.trim());
					expect(subject).not.toMatch(/\p{C}/u);
				}
				expect(hostCommitSubjects(subjects.join("\n"))).toEqual(subjects);
			}),
		);
		expect(hostCommitSubjects(`${"x".repeat(199)} 🙂`)).toEqual([
			"x".repeat(199),
		]);
		expect(hostCommitSubjects(`${"x".repeat(199)}🙂`)).toEqual([
			"x".repeat(199),
		]);
		expect(
			hostCommitSubjects(
				Array.from({ length: 60 }, (_, n) => `line ${n}`).join("\n"),
			),
		).toHaveLength(50);
	});

	test("valid reply identifiers round trip", () => {
		const id = fc.stringMatching(/^[A-Za-z0-9_-]{1,128}$/);
		const sha = fc.stringMatching(/^[a-f0-9]{7,40}$/);
		fc.assert(
			fc.property(
				fc.option(id, { nil: null }),
				fc.option(sha, { nil: null }),
				(requestId, runningCommit) => {
					const value = { requestId, runningCommit };
					expect(parseHostReply(JSON.stringify(value))).toEqual(value);
				},
			),
		);
	});
});

describe("live host readers", () => {
	test("the SQLite lock refuses duplicate canonical checkouts and releases on close", () => {
		const dir = fixture();
		const checkout = join(dir, "checkout");
		const alias = join(dir, "alias");
		mkdirSync(checkout);
		symlinkSync(
			checkout,
			alias,
			process.platform === "win32" ? "junction" : "dir",
		);
		const lockDir = join(dir, "locks");
		const first = lockUpdateHost(checkout, lockDir);
		try {
			expect(() => lockUpdateHost(alias, lockDir)).toThrow(StoreLockedError);
		} finally {
			first.close();
		}
		const second = lockUpdateHost(alias, lockDir);
		second.close();
		expect(() => lockUpdateHost(checkout, join(checkout, "..nested"))).toThrow(
			"outside the checkout",
		);
	});

	test("real git reports commits after the running image and fetches at most once in five minutes", async () => {
		const dir = fixture();
		const origin = join(dir, "origin.git");
		const main = join(dir, "main");
		const git = (cwd: string, ...args: string[]) => {
			const result = Bun.spawnSync(
				[
					gitExe(),
					"-c",
					"user.name=fixture",
					"-c",
					"user.email=fixture@example.invalid",
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		git(dir, "init", "--bare", "-b", "main", origin);
		git(dir, "clone", origin, main);
		git(main, "commit", "--allow-empty", "-m", "base");
		const base = git(main, "rev-parse", "HEAD");
		git(main, "commit", "--allow-empty", "-m", "first subject");
		git(main, "commit", "--allow-empty", "-m", `second ${"x".repeat(220)}`);
		git(main, "push", "origin", "HEAD:main");
		const read = hostGitAvailability(main);
		expect(await read(base, 0)).toEqual({
			behind: 2,
			commits: [`second ${"x".repeat(193)}`, "first subject"],
		});
		expect(await read(git(main, "rev-parse", "HEAD"), 1)).toEqual({
			behind: 0,
			commits: [],
		});
		git(main, "commit", "--allow-empty", "-m", "third subject");
		git(main, "push", "origin", "HEAD:main");
		// Push updates the local tracking ref too. A second checkout must advance origin instead.
		const ci = join(dir, "ci");
		git(dir, "clone", origin, ci);
		git(ci, "commit", "--allow-empty", "-m", "fourth subject");
		git(ci, "push", "origin", "HEAD:main");
		expect((await read(base, 299_999))?.behind).toBe(3);
		expect((await read(base, 300_000))?.behind).toBe(4);
		expect(await read("f".repeat(40), 300_001)).toBeNull();
		git(main, "remote", "set-url", "origin", join(dir, "missing-origin.git"));
		expect(await read(base, 600_000)).toBeNull();
		expect(await read(base, 600_001)).toBeNull();
	}, 30_000);
});

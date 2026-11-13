import { expect, test } from "bun:test";
import { StoreQueue } from "./storeQueue.ts";

function deferred() {
	return Promise.withResolvers<void>();
}

function fixture() {
	const statements: string[] = [];
	const queue = new StoreQueue({
		begin: async () => {
			statements.push("BEGIN");
		},
		commit: async () => {
			statements.push("COMMIT");
		},
		rollback: async () => {
			statements.push("ROLLBACK");
		},
	});
	return { queue, statements };
}

test("a yielded transaction excludes ordinary operations and commits nested work once", async () => {
	const { queue, statements } = fixture();
	const entered = deferred();
	const release = deferred();
	const first = queue.transaction(async () => {
		statements.push("first");
		entered.resolve();
		await release.promise;
		await queue.transaction(async () => {
			await queue.run(() => {
				statements.push("nested");
			});
		});
	});
	await entered.promise;
	const second = queue.run(() => {
		statements.push("second");
	});
	await Promise.resolve();
	expect(statements).toEqual(["BEGIN", "first"]);
	release.resolve();
	await Promise.all([first, second]);
	expect(statements).toEqual(["BEGIN", "first", "nested", "COMMIT", "second"]);
});

test("a transaction can start inside a queued ordinary operation", async () => {
	const { queue, statements } = fixture();
	await queue.run(async () => {
		await queue.transaction(async () => {
			statements.push("write");
		});
	});
	expect(statements).toEqual(["BEGIN", "write", "COMMIT"]);
});

test("a caught nested error rolls back the outer transaction and the queue recovers", async () => {
	const { queue, statements } = fixture();
	const failure = new Error("nested failure");
	const result = queue.transaction(async () => {
		try {
			await queue.transaction(() => {
				throw failure;
			});
		} catch {}
		statements.push("caught");
	});
	await expect(result).rejects.toBe(failure);
	await queue.transaction(() => {
		statements.push("recovered");
	});
	expect(statements).toEqual([
		"BEGIN",
		"caught",
		"ROLLBACK",
		"BEGIN",
		"recovered",
		"COMMIT",
	]);
});

test("ordinary nested failures also prevent commit", async () => {
	const { queue, statements } = fixture();
	const failure = new Error("write failure");
	await expect(
		queue.transaction(async () => {
			try {
				await queue.run(() => {
					throw failure;
				});
			} catch {}
		}),
	).rejects.toBe(failure);
	expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
});

test("an expired async context must enter the queue again", async () => {
	const { queue, statements } = fixture();
	const detached = deferred();
	let later!: Promise<void>;
	await queue.transaction(() => {
		later = detached.promise.then(() =>
			queue.run(() => {
				statements.push("detached");
			}),
		);
	});
	const entered = deferred();
	const release = deferred();
	const held = queue.transaction(async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	detached.resolve();
	await Promise.resolve();
	expect(statements).toEqual(["BEGIN", "COMMIT", "BEGIN"]);
	release.resolve();
	await Promise.all([held, later]);
	expect(statements).toEqual([
		"BEGIN",
		"COMMIT",
		"BEGIN",
		"COMMIT",
		"detached",
	]);
});

test("close stops admission and drains accepted operations before one close callback", async () => {
	const { queue, statements } = fixture();
	const entered = deferred();
	const release = deferred();
	const first = queue.transaction(async () => {
		entered.resolve();
		await release.promise;
		await queue.run(() => {
			statements.push("accepted nested");
		});
	});
	await entered.promise;
	const accepted = queue.run(() => {
		statements.push("accepted");
	});
	const close = queue.close(() => {
		statements.push("CLOSE");
	});
	await expect(
		queue.run(() => {
			statements.push("rejected");
		}),
	).rejects.toThrow("closed");
	release.resolve();
	await Promise.all([first, accepted, close]);
	await queue.close(() => {
		statements.push("second close");
	});
	expect(statements).toEqual([
		"BEGIN",
		"accepted nested",
		"COMMIT",
		"accepted",
		"CLOSE",
	]);
});

test("rollback failure prevents later access", async () => {
	const failure = new Error("rollback failed");
	const queue = new StoreQueue({
		begin: () => {},
		commit: () => {},
		rollback: () => {
			throw failure;
		},
	});
	await expect(
		queue.transaction(() => {
			throw new Error("application failed");
		}),
	).rejects.toBe(failure);
	await expect(queue.run(() => 1)).rejects.toBe(failure);
});

test("transaction awaits begin and commit before it releases the next operation", async () => {
	const begun = deferred();
	const begin = deferred();
	const committing = deferred();
	const commit = deferred();
	const statements: string[] = [];
	const queue = new StoreQueue({
		begin: async () => {
			begun.resolve();
			await begin.promise;
		},
		commit: async () => {
			committing.resolve();
			await commit.promise;
		},
		rollback: () => {
			statements.push("rollback");
		},
	});
	const first = queue.transaction(() => {
		statements.push("work");
	});
	await begun.promise;
	const second = queue.run(() => {
		statements.push("next");
	});
	expect(statements).toEqual([]);
	begin.resolve();
	await committing.promise;
	expect(statements).toEqual(["work"]);
	commit.resolve();
	await Promise.all([first, second]);
	expect(statements).toEqual(["work", "next"]);
});

test("ordinary operation failure does not reject a later accepted operation", async () => {
	const { queue, statements } = fixture();
	const failure = new Error("read failed");
	const first = queue.run(() => {
		throw failure;
	});
	const second = queue.run(() => {
		statements.push("next");
	});
	await expect(first).rejects.toBe(failure);
	await second;
	expect(statements).toEqual(["next"]);
});

test("detached work cannot reuse a transaction while commit awaits", async () => {
	const committing = deferred();
	const commit = deferred();
	const detached = deferred();
	const statements: string[] = [];
	const queue = new StoreQueue({
		begin: () => {
			statements.push("begin");
		},
		commit: async () => {
			committing.resolve();
			await commit.promise;
			statements.push("commit");
		},
		rollback: () => {
			statements.push("rollback");
		},
	});
	let later!: Promise<void>;
	const first = queue.transaction(() => {
		later = detached.promise.then(() =>
			queue.run(() => {
				statements.push("detached");
			}),
		);
	});
	await committing.promise;
	detached.resolve();
	await Promise.resolve();
	expect(statements).toEqual(["begin"]);
	commit.resolve();
	await Promise.all([first, later]);
	expect(statements).toEqual(["begin", "commit", "detached"]);
});

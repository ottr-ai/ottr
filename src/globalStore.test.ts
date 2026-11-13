import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { GlobalStore } from "./globalStore.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ottr-gstore-"));
	dirs.push(root);
	return root;
}

describe("GlobalStore", () => {
	test("set/get object roundtrip", async () => {
		const root = tempRoot();
		const store = await GlobalStore.open(root);
		await store.set("k", { a: 1, b: ["x"] });
		expect(await store.get<{ a: number; b: string[] }>("k")).toEqual({
			a: 1,
			b: ["x"],
		});
		await store.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
	test("missing key returns null", async () => {
		const root = tempRoot();
		const store = await GlobalStore.open(root);
		expect(await store.get("nope")).toBeNull();
		await store.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
	test("corrupt row returns null", async () => {
		const root = tempRoot();
		const store = await GlobalStore.open(root);
		await store.set("k", { a: 1 });
		await store.close(); // exclusive mode: the raw fixup below needs the file free
		const raw = new Database(join(root, ".tasks", "tracker.db"));
		raw.query("UPDATE kv SET value = 'not json' WHERE key = 'k'").run();
		raw.close();
		const reopened = await GlobalStore.open(root);
		expect(await reopened.get("k")).toBeNull();
		await reopened.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
	test("writes .tasks/.gitignore on a bare root", async () => {
		const root = tempRoot();
		await (await GlobalStore.open(root)).close();
		expect(readFileSync(join(root, ".tasks", ".gitignore"), "utf8")).toBe(
			"*\n",
		);
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
});

describe("queued global operations", () => {
	test("JSON values round-trip through real SQLite", async () => {
		const store = await GlobalStore.open(tempRoot());
		try {
			await fc.assert(
				fc.asyncProperty(fc.jsonValue(), async (value) => {
					await store.set("json", value);
					expect(await store.get("json")).toEqual(value);
				}),
				{ seed: 894, numRuns: 100 },
			);
		} finally {
			await store.close();
		}
	});

	test("concurrent list and config updates retain both changes", async () => {
		const store = await GlobalStore.open(tempRoot());
		try {
			const lists = await Promise.all([
				store.update<string[]>("projects", (current) => [
					...(current ?? []),
					"first",
				]),
				store.update<string[]>("projects", (current) => [
					...(current ?? []),
					"second",
				]),
			]);
			expect(lists).toEqual([["first"], ["first", "second"]]);
			expect(await store.get("projects")).toEqual(["first", "second"]);
			await Promise.all([
				store.update<Record<string, string>>("config", (current) => ({
					...current,
					language: "en",
				})),
				store.update<Record<string, string>>("config", (current) => ({
					...current,
					theme: "dark",
				})),
			]);
			expect(await store.get("config")).toEqual({
				language: "en",
				theme: "dark",
			});
		} finally {
			await store.close();
		}
	});

	test("a yielded transaction isolates reads and writes and permits nested work", async () => {
		const store = await GlobalStore.open(tempRoot());
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const order: string[] = [];
		try {
			const transaction = store.transaction(async () => {
				await store.set("phase", "draft");
				entered.resolve();
				await resume.promise;
				expect(await store.get("outside")).toBeNull();
				await store.transaction(async () => {
					await store.update<string[]>("nested", (current) => [
						...(current ?? []),
						"inner",
					]);
					await store.set("phase", "committed");
				});
				order.push("transaction");
			});
			await entered.promise;
			const read = store.get("phase").then((value) => {
				order.push("read");
				return value;
			});
			const write = store
				.set("outside", "queued")
				.then(() => order.push("write"));
			await Promise.resolve();
			expect(order).toEqual([]);
			resume.resolve();
			await transaction;
			expect(await read).toBe("committed");
			await write;
			expect(order).toEqual(["transaction", "read", "write"]);
			expect(await store.get("nested")).toEqual(["inner"]);
			expect(await store.get("outside")).toBe("queued");
		} finally {
			resume.resolve();
			await store.close();
		}
	});

	test("nested failure rolls back the whole transaction and the queue recovers", async () => {
		const store = await GlobalStore.open(tempRoot());
		try {
			await store.set("value", "original");
			await expect(
				store.transaction(async () => {
					await store.set("value", "outer");
					await store.transaction(async () => {
						await store.set("nested", "discard");
						throw new Error("nested failure");
					});
				}),
			).rejects.toThrow("nested failure");
			expect(await store.get("value")).toBe("original");
			expect(await store.get("nested")).toBeNull();
			await store.update<string>("value", (current) => `${current}-recovered`);
			expect(await store.get("value")).toBe("original-recovered");
		} finally {
			await store.close();
		}
	});

	test("a caught nested failure cannot commit partial writes", async () => {
		const store = await GlobalStore.open(tempRoot());
		try {
			await expect(
				store.transaction(async () => {
					await store.set("outer", true);
					try {
						await store.transaction(async () => {
							await store.set("inner", true);
							throw new Error("caught nested failure");
						});
					} catch (error) {
						expect(error).toBeInstanceOf(Error);
					}
					await store.set("after", true);
				}),
			).rejects.toThrow();
			expect(await store.get("outer")).toBeNull();
			expect(await store.get("inner")).toBeNull();
			expect(await store.get("after")).toBeNull();
			await store.set("recovered", true);
			expect(await store.get("recovered")).toBe(true);
		} finally {
			await store.close();
		}
	});

	test("a failed update preserves the old value and later updates succeed", async () => {
		const store = await GlobalStore.open(tempRoot());
		try {
			await store.set("list", ["keep"]);
			await expect(
				store.update<string[]>("list", () => {
					throw new Error("modify failed");
				}),
			).rejects.toThrow("modify failed");
			expect(await store.get("list")).toEqual(["keep"]);
			await store.update<string[]>("list", (current) => [
				...(current ?? []),
				"next",
			]);
			expect(await store.get("list")).toEqual(["keep", "next"]);
		} finally {
			await store.close();
		}
	});

	test("database read failures reject instead of returning null", async () => {
		const root = tempRoot();
		await (await GlobalStore.open(root)).close();
		const raw = new Database(join(root, ".tasks", "tracker.db"));
		raw.exec("ALTER TABLE kv RENAME COLUMN value TO broken");
		raw.close();
		const store = await GlobalStore.open(root);
		try {
			await expect(store.get("key")).rejects.toThrow();
			await expect(store.set("key", "value")).rejects.toThrow();
		} finally {
			await store.close();
		}
	});

	test("backup waits for a transaction and copies its committed state", async () => {
		const root = tempRoot();
		const store = await GlobalStore.open(root);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const destination = join(root, "snapshot.db");
		try {
			const transaction = store.transaction(async () => {
				await store.set("snapshot", "before");
				entered.resolve();
				await resume.promise;
				await store.set("snapshot", "committed");
			});
			await entered.promise;
			const backup = store.backupTo(destination);
			resume.resolve();
			await transaction;
			await backup;
			const snapshot = new Database(destination, { readonly: true });
			try {
				expect(
					snapshot
						.query<{ value: string }, []>(
							"SELECT value FROM kv WHERE key = 'snapshot'",
						)
						.get()?.value,
				).toBe(JSON.stringify("committed"));
			} finally {
				snapshot.close();
			}
		} finally {
			resume.resolve();
			await store.close();
		}
	});

	test("close drains accepted work, refuses new work, and remains idempotent", async () => {
		const root = tempRoot();
		const store = await GlobalStore.open(root);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const transaction = store.transaction(async () => {
			entered.resolve();
			await resume.promise;
			await store.set("saved", true);
		});
		await entered.promise;
		const close = store.close();
		await expect(store.get("saved")).rejects.toThrow();
		resume.resolve();
		await transaction;
		await close;
		await store.close();
		const reopened = await GlobalStore.open(root);
		try {
			expect(await reopened.get("saved")).toBe(true);
		} finally {
			await reopened.close();
		}
	});
});

describe("instance lock", () => {
	test("a child calling process.exit(0) frees the tracker lock for the next boot", async () => {
		const root = tempRoot();
		// The child exits itself; the OS drops the exclusive lock with its fds.
		// Stdio stays inherited so a boot failure prints itself.
		const child = Bun.spawn({
			cmd: [
				"bun",
				"-e",
				`import { GlobalStore } from ${JSON.stringify(join(import.meta.dir, "globalStore.ts"))};
				 await GlobalStore.open(process.env.LOCK_DIR);
				 process.exit(0);`,
			],
			env: { ...process.env, LOCK_DIR: root },
		});
		const code = await child.exited;
		expect(code).toBe(0);
		// The next boot must open cleanly: nothing held the file after the exit.
		const again = await GlobalStore.open(root);
		expect(await again.get("config")).toBeNull();
		await again.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
});

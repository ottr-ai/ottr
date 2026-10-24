import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalStore } from "./globalStore.ts";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "ottr-gstore-"));
}

describe("GlobalStore", () => {
	test("set/get object roundtrip", () => {
		const root = tempRoot();
		const store = GlobalStore.open(root);
		store.set("k", { a: 1, b: ["x"] });
		expect(store.get<{ a: number; b: string[] }>("k")).toEqual({
			a: 1,
			b: ["x"],
		});
		store.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
	test("missing key returns null", () => {
		const root = tempRoot();
		const store = GlobalStore.open(root);
		expect(store.get("nope")).toBeNull();
		store.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
	test("corrupt row returns null", () => {
		const root = tempRoot();
		const store = GlobalStore.open(root);
		store.set("k", { a: 1 });
		store.close(); // exclusive mode: the raw fixup below needs the file free
		const raw = new Database(join(root, ".tasks", "tracker.db"));
		raw.query("UPDATE kv SET value = 'not json' WHERE key = 'k'").run();
		raw.close();
		const reopened = GlobalStore.open(root);
		expect(reopened.get("k")).toBeNull();
		reopened.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
	test("writes .tasks/.gitignore on a bare root", () => {
		const root = tempRoot();
		GlobalStore.open(root).close();
		expect(readFileSync(join(root, ".tasks", ".gitignore"), "utf8")).toBe(
			"*\n",
		);
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
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
				 GlobalStore.open(process.env.LOCK_DIR);
				 process.exit(0);`,
			],
			env: { ...process.env, LOCK_DIR: root },
		});
		const code = await child.exited;
		expect(code).toBe(0);
		// The next boot must open cleanly: nothing held the file after the exit.
		const again = GlobalStore.open(root);
		expect(again.get("config")).toBeNull();
		again.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	checkGuardFolders,
	checkGuardYaml,
	ensureCheckGuardOverlay,
} from "./checkGuard.ts";

describe("checkGuardFolders", () => {
	const saved: [string, string | undefined][] = [];
	const pinEnv = (pairs: Record<string, string | undefined>): void => {
		for (const [k, v] of Object.entries(pairs)) {
			saved.push([k, process.env[k]]);
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};

	afterEach(() => {
		for (const [k, v] of saved.reverse()) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		saved.length = 0;
	});

	test("lists the board state dir, the board omp home, and the project server dir", () => {
		const base = mkdtempSync(join(tmpdir(), "ottr-guard-"));
		pinEnv({
			OTTR_STATE_DIR: join(base, "state"),
			OTTR_BOARD_OMP_HOME: join(base, "board-home"),
			OTTR_SSH_DIR: undefined,
			OTTR_BACKUP_DIR: undefined,
		});
		const folders = checkGuardFolders(
			process.env,
			join(base, "state", ".tasks", "projects", "proj"),
		);
		expect(folders).toContain(join(base, "state", ".tasks"));
		expect(folders).toContain(join(base, "board-home"));
		// Nested under the state dir: collapsed, not listed twice.
		expect(folders).not.toContain(
			join(base, "state", ".tasks", "projects", "proj"),
		);
		expect(folders).toHaveLength(2);
	});

	test("adds the ssh dir and the backup mount when set, and resolves relative paths", () => {
		const base = mkdtempSync(join(tmpdir(), "ottr-guard-"));
		pinEnv({
			OTTR_STATE_DIR: join(base, "state"),
			OTTR_BOARD_OMP_HOME: join(base, "board-home"),
			OTTR_SSH_DIR: join(base, "elsewhere", "ssh"),
			OTTR_BACKUP_DIR: join(base, "backup"),
		});
		const folders = checkGuardFolders(process.env, "relative-server-dir");
		expect(folders).toContain(join(base, "elsewhere", "ssh"));
		expect(folders).toContain(join(base, "backup"));
		expect(folders.some((f) => f.endsWith("relative-server-dir"))).toBe(true);
	});

	test("the yaml quotes every folder and the overlay lands in the server dir", () => {
		const base = mkdtempSync(join(tmpdir(), "ottr-guard-"));
		const serverDir = join(base, "server", "proj");
		mkdirSync(serverDir, { recursive: true });
		pinEnv({
			OTTR_STATE_DIR: join(base, "state"),
			OTTR_BOARD_OMP_HOME: join(base, "home"),
		});
		const path = ensureCheckGuardOverlay(serverDir, process.env);
		expect(path).toBe(join(serverDir, "check-guard.yml"));
		const text = readFileSync(path, "utf8");
		expect(text).toContain("restrictedFolders:");
		expect(text).toContain(
			`    - ${JSON.stringify(join(base, "state", ".tasks"))}`,
		);
		// A path with a space stays one quoted scalar.
		expect(checkGuardYaml(["/a b/c"])).toContain('    - "/a b/c"');
		// Idempotent: a second call keeps the file as written.
		const before = existsSync(path) ? readFileSync(path, "utf8") : "";
		expect(ensureCheckGuardOverlay(serverDir, process.env)).toBe(path);
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});

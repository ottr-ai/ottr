import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { boardOmpHome } from "./login.ts";

/**
 * Guard overlay for board-side check runs (OTTR-985). A check runs in the server container
 * with an unconfined read tool and a worker-controlled worktree: a committed symlink (say
 * REVIEW.md -> /app/.tasks/tracker.db) made the read render server-only state into the model,
 * the transcript, and the run log. `tools.restrictedFolders` asks in every approval mode, and
 * a headless `-p` run refuses the call instead — pinned here for the server's own state roots.
 *
 * The overlay lives under the project's server-only dir (serverDirFor), never on the
 * worker-shared data volume: a worker-planted edit could drop the restriction lines before
 * the spawn reads it.
 */

/** The server-only state roots one check run must not read: the board's state dir (tracker.db,
 * secret.key, ssh keys, the per-project server dirs and the default backups dir below it), the
 * board's omp home (provider auth), the backup mount (OTTR_BACKUP_DIR; compose: /backup), and
 * the project's own server dir. Nested entries collapse into their topmost parent; unset env
 * roots drop out. */
export function checkGuardFolders(
	env: Record<string, string | undefined>,
	serverDir: string,
): string[] {
	const stateDir = env.OTTR_STATE_DIR?.trim() || resolve(import.meta.dir, "..");
	const candidates = [
		join(resolve(stateDir), ".tasks"),
		boardOmpHome(),
		serverDir,
		env.OTTR_SSH_DIR,
		// The mount point resolveBackup snapshots to (OTTR_BACKUP_DIR), not the host-side
		// volume name OTTR_BACKUP_MOUNT, which never reaches the container env. Unset: the
		// default dir sits under the state .tasks root pinned above.
		env.OTTR_BACKUP_DIR,
	];
	const folders: string[] = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || candidate.trim() === "") continue;
		const dir = resolve(candidate);
		// A kept parent already covers this dir; a nested candidate adds nothing.
		if (folders.some((kept) => dir === kept || dir.startsWith(`${kept}/`)))
			continue;
		folders.push(dir);
	}
	return folders;
}

/** The overlay's YAML: one double-quoted path per line (JSON scalars are valid YAML). */
export function checkGuardYaml(folders: string[]): string {
	return `# Server-only read guard for board-side check runs (OTTR-985): the check's cwd is a
# worker-controlled worktree, so a committed symlink must never render server-only state.
# tools.restrictedFolders asks in every approval mode; a headless run refuses the call.
tools:
  restrictedFolders:
${folders.map((f) => `    - ${JSON.stringify(f)}`).join("\n")}
`;
}

/** Writes `check-guard.yml` under the server-only dir when its content differs; returns the
 * path. A write failure throws, failing the check run loudly instead of spawning unguarded. */
export function ensureCheckGuardOverlay(
	serverDir: string,
	env: Record<string, string | undefined> = process.env,
): string {
	const path = join(serverDir, "check-guard.yml");
	const content = checkGuardYaml(checkGuardFolders(env, serverDir));
	try {
		if (readIfExists(path) === content) return path;
	} catch {
		// unreadable or planted: fall through to the overwrite
	}
	writeFileSync(path, content);
	return path;
}

function readIfExists(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

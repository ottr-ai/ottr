// The restore tool for the board's database snapshots (docs/specs/db-backup.md, Restore):
// `bun src/restore.ts` lists the snapshots, `bun src/restore.ts latest|<stamp>` restores one.
// Stop the board first: the tool refuses while a live board holds a target.

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
	listSnapshots,
	readManifest,
	resolveBackup,
	restoreSnapshot,
	SNAPSHOT_MANIFEST,
} from "./backup.ts";
import { StoreLockedError } from "./dblock.ts";
import { ADOPTED_MARKER } from "./store.ts";

type RestoreRun = { code: number; out: string[]; err: string[] };

const USAGE = "usage: bun src/restore.ts [latest|<stamp>]";

/** The note of a list line for a snapshot that does not hold each database; empty when it does. */
function incompleteNote(dir: string, stamp: string): string {
	const manifest = readManifest(dir, stamp);
	if (manifest === null) return `; incomplete: no valid ${SNAPSHOT_MANIFEST}`;
	if (manifest.failed.length === 0) return "";
	return `; incomplete: ${manifest.failed.map((f) => `${f.file} failed`).join(", ")}`;
}

/** One list line: the stamp and each file with its size, `tracker.db` before the project files. */
function snapshotLine(dir: string, stamp: string): string {
	const root = join(dir, stamp);
	const files = readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const path = join(entry.parentPath, entry.name);
			return {
				name: relative(root, path).split(sep).join("/"),
				size: statSync(path).size,
			};
		})
		.filter((f) => f.name !== SNAPSHOT_MANIFEST)
		.sort(
			(a, b) =>
				a.name.split("/").length - b.name.split("/").length ||
				(a.name < b.name ? -1 : 1),
		);
	const list = files.map((f) => `${f.name} (${f.size} bytes)`).join(", ");
	return `${stamp}  ${list}${incompleteNote(dir, stamp)}`;
}

async function restore(
	dir: string,
	stamp: string,
	stateDir: string,
	env: Record<string, string | undefined>,
): Promise<RestoreRun> {
	const serverData = env.OTTR_SERVER_DATA_DIR;
	const projectRoot = serverData || env.OTTR_DATA_DIR;
	const result = await restoreSnapshot({
		dir,
		stamp,
		now: new Date(),
		trackerDb: join(resolve(stateDir), ".tasks", "tracker.db"),
		projectDbFor: (name) =>
			projectRoot ? join(resolve(projectRoot), name, "tasks.db") : null,
		adoptedMarker: serverData
			? join(resolve(serverData), ADOPTED_MARKER)
			: null,
	});
	return {
		code: result.failed.length === 0 ? 0 : 1,
		out: [
			...result.restored.map((r) => `restored ${r.file} -> ${r.to}`),
			...result.movedAside.map((path) => `kept the old file as ${path}`),
			...result.manual.map(
				(m) => `copy by hand: ${m.from} -> <checkout>/.tasks/tasks.db`,
			),
		],
		err: result.failed.map((f) => `${f.file} failed: ${f.error}`),
	};
}

export async function runRestore(
	args: string[],
	env: Record<string, string | undefined>,
): Promise<RestoreRun> {
	const arg = args[0];
	if (args.length > 1 || arg?.startsWith("-"))
		return { code: 1, out: [], err: [USAGE] };
	// The same rule as STATE_DIR in src/server.ts.
	const stateDir = env.OTTR_STATE_DIR ?? resolve(import.meta.dir, "..");
	const dir = resolveBackup(env, stateDir, []).dir;
	try {
		const stamps = listSnapshots(dir);
		if (arg === undefined) {
			const lines = stamps.map((stamp) => snapshotLine(dir, stamp));
			const out = lines.length > 0 ? lines : [`no snapshots in ${dir}`];
			return { code: 0, out, err: [] };
		}
		const stamp = arg === "latest" ? stamps[0] : stamps.find((s) => s === arg);
		if (stamp === undefined) {
			const what = arg === "latest" ? "no snapshots" : `no snapshot ${arg}`;
			return { code: 1, out: [], err: [`${what} in ${dir}`] };
		}
		return await restore(dir, stamp, stateDir, env);
	} catch (err) {
		const text = err instanceof Error ? err.message : String(err);
		const line =
			err instanceof StoreLockedError
				? `${text}: stop the board first, then run the restore again (no database was replaced)`
				: `restore failed: ${text}`;
		return { code: 1, out: [], err: [line] };
	}
}

if (import.meta.main) {
	const run = await runRestore(process.argv.slice(2), process.env);
	for (const line of run.out) console.log(line);
	for (const line of run.err) console.error(line);
	process.exitCode = run.code;
}

import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixed prefixes: only names the tests (and Stryker sandboxes) actually use.
// Never delete unprefixed entries — /tmp may hold anything.
const PREFIXES = ["turn-", "ottr-", "ott-", "confine-", "http400-"];
const AGE_MS = 24 * 60 * 60 * 1000;

export function sweepTmpDirs(root: string = tmpdir()): number {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of entries) {
		if (!PREFIXES.some((p) => name.startsWith(p))) continue;
		try {
			if (Date.now() - statSync(join(root, name)).mtimeMs < AGE_MS) continue;
			rmSync(join(root, name), { recursive: true, force: true });
			removed++;
		} catch {
			// Busy or vanished entry: leave it for the next sweep.
		}
	}
	return removed;
}

import { chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

/** Cross-uid fixtures must not inherit a private ancestor from TMPDIR. */
export function uidFixtureDir(prefix: string): string {
	const dir = mkdtempSync(join("/tmp", prefix));
	chmodSync(dir, 0o711);
	return dir;
}

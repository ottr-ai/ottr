/**
 * Fails when the pinned omp stops minting `js-`-prefixed tool call ids for the
 * eval kernel's nested `tool.<name>` calls. extension/tracker.ts refuses those
 * nested calls for the board's event-riding tools (propose_task, report_outcome,
 * ask), because the runner reads board tools only from direct tool_execution
 * events (OTTR-863). The `js-` prefix is the only caller signal that reaches the
 * tool's execute, and it is omp-internal: without this gate an omp bump could
 * silently restore the false success. Runs where `bun run check` runs without an
 * installed omp skip instead of failing.
 */
import { readFileSync, realpathSync } from "node:fs";

/** The eval bridge's nested call id template: `js-<tool>-<uuid>`. */
export const EVAL_BRIDGE_ID_PATTERN =
	/`js-\$\{[^}]+\}-\$\{crypto\.randomUUID\(\)\}`/;

/** The contract breach message, or null when the bundle still mints the ids. */
export function checkBundle(source: string): string | null {
	return EVAL_BRIDGE_ID_PATTERN.test(source)
		? null
		: "the omp bundle no longer mints `js-<tool>-<uuid>` eval-bridge call ids; " +
				"extension/tracker.ts evalBridgeRefusal can no longer detect nested calls";
}

const bin = process.env.OMP_BIN?.trim() || Bun.which("omp") || "";
if (import.meta.main) {
	if (bin === "") {
		console.log("eval-bridge-contract: skip (no omp on PATH)");
	} else {
		let cli: string;
		try {
			// omp is a symlink into its global install; resolve to the real bundle.
			cli = realpathSync(bin);
		} catch {
			console.error(`eval-bridge-contract: omp at ${bin} does not resolve`);
			process.exit(1);
		}
		const breach = checkBundle(readFileSync(cli, "utf8"));
		if (breach !== null) {
			console.error(`eval-bridge-contract: ${cli}: ${breach}`);
			process.exit(1);
		}
		console.log(`eval-bridge-contract: ok (${cli})`);
	}
}

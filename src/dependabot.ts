// One probe of a repo's Dependabot-alerts status (docs/specs/dependabot-warning.md):
// GitHub answers 2xx when the feature is on for the repo and 404 when it is off. The
// board runs the call through gh like every other GitHub feature, so host and tokens
// follow the configured GitHub host. Everything else — a forbidden token, another
// status, a transport failure — reads as "unknown", and the project page warns nothing.
import type { GhFn } from "./forks.ts";

/** GitHub owner/name with GitHub's name charset; a crafted remote must never reach the gh path. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** True for exactly owner/name, refusing the "." and ".." path segments. */
function safeRepoId(id: string): boolean {
	const [owner = "", name = "", ...rest] = id.split("/");
	return (
		rest.length === 0 &&
		REPO_RE.test(id) &&
		owner !== "." &&
		owner !== ".." &&
		name !== "." &&
		name !== ".."
	);
}

/** gh names the HTTP status on a failed call: "gh: Not Found (HTTP 404)". */
const GH_STATUS_RE = /\(HTTP (\d{3})\)\s*$/;

/** Dependabot-alerts state of one repo; "unknown" never warns. */
export type DependabotState = "enabled" | "disabled" | "unknown";

/** One gh answer's state: exit 0 means enabled, gh's HTTP 404 line means disabled. */
export function dependabotStateOf(
	code: number,
	stderr: string,
): DependabotState {
	if (code === 0) return "enabled";
	const line = stderr.split("\n")[0] ?? "";
	return GH_STATUS_RE.exec(line)?.[1] === "404" ? "disabled" : "unknown";
}

/**
 * Asks GitHub whether Dependabot alerts are on for owner/name. One GET, no paging:
 * the status endpoint answers 204 with an empty body. Total: every failure path
 * returns "unknown", never throws.
 */
export async function dependabotAlertsState(
	gh: GhFn,
	id: string,
): Promise<DependabotState> {
	if (!safeRepoId(id)) return "unknown";
	try {
		const res = await gh(["api", `repos/${id}/vulnerability-alerts`], 30_000);
		return dependabotStateOf(res.code, res.stderr);
	} catch {
		return "unknown";
	}
}

import { createHash, randomBytes } from "node:crypto";

/** What one per-run board credential opens: the run's own card in its own project. */
export interface RunGrant {
	project: string;
	taskId: string;
}

/** Both a raw token (32 bytes hex) and its sha256 digest are 64 lowercase hex chars. */
const HEX64 = /^[0-9a-f]{64}$/;

function digest(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

/**
 * Per-run board credentials for the sandbox endpoint (OTTR-1197). One boot token
 * per boot sits in every classic run's env, so it cannot bind a sandbox request
 * to the calling run's card: any run could name any qualifying card in any
 * project. Each classic run therefore also carries a token issued at dispatch
 * and bound to its project and task id (like a VM token, OTTR-532); the sandbox
 * endpoint checks it against the request body before it touches the store. In
 * memory only: a run's env dies with the run, and a board restart rotates the
 * boot token with it, so there is no file to re-load.
 */
export class RunTokens {
	private readonly grants = new Map<string, RunGrant>();

	/** A fresh raw token (32 random bytes, hex) for `grant`. */
	issue(grant: RunGrant): string {
		if (grant.project.trim() === "" || grant.taskId.trim() === "")
			throw new Error("a run grant needs a project and a task id");
		const raw = randomBytes(32).toString("hex");
		this.grants.set(digest(raw), Object.freeze({ ...grant }));
		return raw;
	}

	/** The grant of a live token; null for a missing, malformed or unknown one. */
	check(raw: string | null | undefined): RunGrant | null {
		// Malformed input never reaches the hash: only an issued token's shape can match.
		if (typeof raw !== "string" || !HEX64.test(raw)) return null;
		return this.grants.get(digest(raw)) ?? null;
	}
}

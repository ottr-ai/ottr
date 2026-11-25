/** Apply this filter after all child environment merges. The database URL stays on the server, and the SecretBox master key unseals the whole sealed credential store: no child of the server (gate, release command, git helper, tool install) ever needs it. */
export function childDatabaseEnv(
	base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	const env = { ...base };
	delete env.OTTR_DATABASE_URL;
	delete env.OTTR_SECRET_KEY;
	return env;
}

/**
 * Deletes, in place, every credential and state-pointer name a local child must
 * never inherit. runner.ts childEnv strips this list for agent turns; the merge
 * gates (worktree.ts runMergeGates) strip it too, because they run repository
 * code in the worker-writable main checkout. One list, so both callers can
 * never drift apart.
 */
export function stripServerChildEnv(
	env: Record<string, string | undefined>,
): void {
	delete env.OTTR_DATA_DIR;
	delete env.OTTR_SERVER_DATA_DIR;
	delete env.OTTR_BACKUP_DIR;
	// Database access stays on the server; the isolated test variables still pass.
	delete env.OTTR_DATABASE_URL;
	delete env.OTTR_WORKER_URLS;
	delete env.OTTR_WORKER_TOKEN;
	// The alate bearer key drives provisioning of the agent layer every turn executes;
	// no turn ever calls alate (only the board's server-side client does), so a turn
	// that held it could rewrite the fleet's rules, skills and plugins (R5-1 class).
	delete env.ALATE_API_KEY;
	// The hosted identity-signing key: a holder forges owner/control/tenant headers.
	delete env.OTTR_HOSTED_SECRET;
	// The SecretBox master key unseals the whole sealed credential store
	// (docs/configuration.md); no turn ever needs it, and a holder could decrypt
	// the stored tokens offline.
	delete env.OTTR_SECRET_KEY;
	// Fleet memory credentials: no turn inherits the board's Hindsight tenant key or
	// URL. A hindsight deployment re-binds memory per run (memoryBinding): the child
	// gets the board's /hindsight proxy URL and a per-run token that opens only its
	// own project's bank (docs/specs/hindsight-bank-binding.md).
	for (const k of Object.keys(env))
		if (k.startsWith("HINDSIGHT_")) delete env[k];
}

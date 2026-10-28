// Lends a model provider's access token from the board store into a turn's env. Only the board
// store holds a credential; workers get the short-lived access token through the env, never the
// refresh token. Ottr has no OAuth refresh code: when the token runs low, omp refreshes it
// (docs/specs/provider-credentials.md, "Token lending").
import { dirname, join } from "node:path";
import { stripANSI } from "bun";
import { agentDir, boardOmpEnv, currentCredential, LENT_ENV } from "./login.ts";

export const TOKEN_REFRESH_MARGIN_MS = 30 * 60_000;
const REFRESH_TIMEOUT_MS = 60_000;

interface Token {
	access: string;
	expires: number;
}

/**
 * The access token of the provider's current credential (its newest login), when that is OAuth;
 * null when it is an API key, missing, or junk. An older OAuth row next to a newer API key is
 * never lent.
 */
function readToken(dbPath: string, provider: string): Token | null {
	let cred: unknown;
	try {
		const row = currentCredential(dbPath, provider);
		if (row?.credential_type !== "oauth") return null;
		cred = JSON.parse(row.data);
	} catch {
		return null; // Not an omp store, or a JSON parse error.
	}
	// omp writes an object; junk from a damaged store must degrade, not throw.
	if (cred === null || typeof cred !== "object") return null;
	const { access, expires } = cred as { access?: unknown; expires?: unknown };
	if (typeof access !== "string") return null;
	return {
		access,
		// No finite expiry (zai's sentinel included) counts as never expiring.
		expires:
			typeof expires === "number" && Number.isFinite(expires)
				? expires
				: Number.POSITIVE_INFINITY,
	};
}

/**
 * Makes omp re-mint the provider's token in the board store: `omp token <provider>
 * --force-refresh` is one call to the provider's token endpoint and no model request. omp runs
 * against the board agent dir only (R5-1). stdout holds the token and is ignored: the caller reads
 * the store. Returns null on exit 0, else the cause.
 */
async function ompRefresh(
	provider: string,
	dir: string,
	command: string[],
): Promise<string | null> {
	try {
		const child = Bun.spawn([...command, provider, "--force-refresh"], {
			env: { ...boardOmpEnv(), PI_CODING_AGENT_DIR: dir },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			timeout: REFRESH_TIMEOUT_MS,
			windowsHide: true,
		});
		const [code, err] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		if (code === 0) return null;
		const last = stripANSI(err).trim().split("\n").at(-1)?.trim();
		return child.signalCode !== null
			? `omp token did not finish in ${REFRESH_TIMEOUT_MS / 1000} s`
			: (last || `omp token exited with code ${code}`).slice(0, 300);
	} catch (err) {
		return `cannot run omp token: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/**
 * What a turn gets: the lent env, and `error` when the board holds the provider's OAuth sign-in
 * but cannot lend a usable token (omp did not refresh it). A turn with an error must not start.
 * A provider the board does not lend, or holds no OAuth sign-in for, gets neither: the worker
 * uses its own credential.
 */
export interface Lent {
	env: Record<string, string>;
	error: string | null;
}

/** The lent env for the model's provider; `env` is empty when nothing can be lent this turn. */
export async function lentProviderEnv(
	model: string | null | undefined,
	opts: {
		dbPath?: string;
		now?: number;
		marginMs?: number;
		/** Only for tests: the command that gets `<provider> --force-refresh` appended. */
		command?: string[];
	} = {},
): Promise<Lent> {
	const provider = model?.split("/", 1)[0];
	const name =
		provider !== undefined && Object.hasOwn(LENT_ENV, provider)
			? LENT_ENV[provider]
			: undefined;
	if (provider === undefined || name === undefined)
		return { env: {}, error: null };
	const now = opts.now ?? Date.now();
	const marginMs = opts.marginMs ?? TOKEN_REFRESH_MARGIN_MS;
	const dbPath = opts.dbPath ?? join(agentDir(), "agent.db");
	const fresh = (t: Token | null): t is Token =>
		t !== null && t.expires - now > marginMs;

	const before = readToken(dbPath, provider);
	// No board sign-in: the turn resolves its own credential, as without lending.
	if (before === null) return { env: {}, error: null };
	if (fresh(before)) return { env: { [name]: before.access }, error: null };

	const cause = await ompRefresh(
		provider,
		dirname(dbPath),
		opts.command ?? ["omp", "token"],
	);
	const after = readToken(dbPath, provider);
	if (fresh(after)) return { env: { [name]: after.access }, error: null };
	return {
		env: {},
		error: `omp did not refresh the board's ${provider} sign-in: ${cause ?? "the token is still near its expiry after omp ran"}`,
	};
}

// Lends a model provider's access token from the board store into a turn's env. Only the board
// store holds a credential; workers get the short-lived access token through the env, never the
// refresh token. Ottr has no OAuth refresh code: when the token runs low, omp refreshes it
// (docs/specs/provider-credentials.md, "Token lending"). Lending fails closed: for a provider
// the board lends, anything short of a usable token is an error that stops the worker turn.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripANSI } from "bun";
import { agentDir, boardOmpEnv, currentCredential, LENT_ENV } from "./login.ts";

export const TOKEN_REFRESH_MARGIN_MS = 30 * 60_000;
const REFRESH_TIMEOUT_MS = 60_000;
/** omp's "never" for a zai token (`expires "never"` in zai-coding-plan.kdl): the largest Date. */
const ZAI_NO_EXPIRY = 8_640_000_000_000_000;

/** What the board store holds for a provider: a lendable token, an API key (never lent), or why neither. */
type Read =
	| { kind: "token"; access: string; expires: number }
	| { kind: "api_key" }
	| { kind: "error"; cause: string };

const errmsg = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

/** Why the provider has no active credential: never signed in, or omp disabled its row. */
function noCredential(dbPath: string, provider: string): string {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.query(
				"SELECT disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id DESC LIMIT 1",
			)
			.get(provider) as { disabled_cause: string | null } | null;
		return row === null
			? `the board has no ${provider} sign-in`
			: `the board's ${provider} sign-in is disabled (${row.disabled_cause ?? "no cause"})`;
	} finally {
		db.close();
	}
}

/**
 * The provider's current credential (its newest login) in the board store. An OAuth row must hold
 * a non-empty access token and a finite expiry; only zai's "never" sentinel means no expiry. An
 * API key is reported as such: the board never lends one. Everything else is an error with its
 * cause: a missing or unreadable store, no sign-in, a disabled sign-in, or a damaged row.
 */
function readToken(dbPath: string, provider: string): Read {
	// A readonly open of a missing path fails with a message that names no file (login.ts).
	if (!existsSync(dbPath))
		return { kind: "error", cause: `the board store ${dbPath} does not exist` };
	let data: string;
	try {
		const row = currentCredential(dbPath, provider);
		if (row === null)
			return { kind: "error", cause: noCredential(dbPath, provider) };
		if (row.credential_type !== "oauth") return { kind: "api_key" };
		data = row.data;
	} catch (err) {
		return {
			kind: "error",
			cause: `cannot read the board store ${dbPath}: ${errmsg(err)}`,
		};
	}
	const damaged = (what: string): Read => ({
		kind: "error",
		cause: `the board's ${provider} sign-in ${what}`,
	});
	let cred: unknown;
	try {
		cred = JSON.parse(data);
	} catch {
		return damaged("holds unreadable data");
	}
	if (cred === null || typeof cred !== "object")
		return damaged("holds unreadable data");
	const access = "access" in cred ? cred.access : undefined;
	const expires = "expires" in cred ? cred.expires : undefined;
	if (typeof access !== "string" || access.trim() === "")
		return damaged("has no access token");
	if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0)
		return damaged("has no valid expiry");
	return {
		kind: "token",
		access,
		expires:
			provider === "zai" && expires === ZAI_NO_EXPIRY
				? Number.POSITIVE_INFINITY
				: expires,
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
		return `cannot run omp token: ${errmsg(err)}`;
	}
}

/** Refreshes in flight, by store dir and provider: concurrent turns share one omp run. */
const inFlight = new Map<string, Promise<string | null>>();

function sharedRefresh(
	provider: string,
	dir: string,
	command: string[],
): Promise<string | null> {
	const key = `${dir}\0${provider}`;
	let run = inFlight.get(key);
	if (run === undefined) {
		run = ompRefresh(provider, dir, command).finally(() =>
			inFlight.delete(key),
		);
		inFlight.set(key, run);
	}
	return run;
}

/**
 * What a turn gets: the lent env, and `error` when nothing usable can be lent for a provider the
 * board lends (or for a model that names no provider). A turn with an error must not start. A
 * provider outside LENT_ENV, and a provider whose current board credential is an API key, get
 * neither: the worker uses its own credential.
 */
export interface Lent {
	env: Record<string, string>;
	error: string | null;
}

/** The lent env for the model's provider; a null model (a local run) lends nothing. */
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
	if (model === null || model === undefined || model.trim() === "")
		return { env: {}, error: null };
	const slash = model.indexOf("/");
	if (slash <= 0)
		return {
			env: {},
			error: `the model ${model} names no provider (expected provider/model)`,
		};
	const provider = model.slice(0, slash);
	const name = Object.hasOwn(LENT_ENV, provider)
		? LENT_ENV[provider]
		: undefined;
	if (name === undefined) return { env: {}, error: null };
	const now = opts.now ?? Date.now();
	const marginMs = opts.marginMs ?? TOKEN_REFRESH_MARGIN_MS;
	const dbPath = opts.dbPath ?? join(agentDir(), "agent.db");

	const before = readToken(dbPath, provider);
	if (before.kind === "api_key") return { env: {}, error: null };
	if (before.kind === "error") return { env: {}, error: before.cause };
	if (before.expires - now > marginMs)
		return { env: { [name]: before.access }, error: null };

	const cause = await sharedRefresh(
		provider,
		dirname(dbPath),
		opts.command ?? ["omp", "token"],
	);
	const after = readToken(dbPath, provider);
	if (after.kind === "token" && after.expires - now > marginMs)
		return { env: { [name]: after.access }, error: null };
	const why =
		cause ??
		(after.kind === "error"
			? after.cause
			: after.kind === "api_key"
				? "its newest login is now an API key"
				: "the token is still near its expiry after omp ran");
	return {
		env: {},
		error: `omp did not refresh the board's ${provider} sign-in: ${why}`,
	};
}

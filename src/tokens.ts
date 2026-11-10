// Lends a model provider's access token from the board store into a turn's env. Only the board
// store holds a credential; workers get the short-lived access token through the env, never the
// refresh token. Ottr has no OAuth refresh code: when the token runs low, omp refreshes it
// (docs/specs/provider-credentials.md, "Token lending"). Lending fails closed: for a provider
// the board lends, anything short of a usable token is an error that stops the worker turn.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripANSI } from "bun";
import { errmsg } from "./errmsg.ts";
import {
	agentDir,
	boardOmpEnv,
	currentCredential,
	LENT_ENV,
	openStoreReadOnly,
	STORE_BUSY_TIMEOUT_MS,
} from "./login.ts";
import { turnEnvValues } from "./tools.ts";

const TOKEN_REFRESH_MARGIN_MS = 30 * 60_000;
const REFRESH_TIMEOUT_MS = 60_000;
/** omp's "never" for a zai token (`expires "never"` in zai-coding-plan.kdl): the largest Date. */
const ZAI_NO_EXPIRY = 8_640_000_000_000_000;

/** What the board store holds for a provider: a lendable token, an API key (never lent), or why neither. */
type Read =
	| { kind: "token"; access: string; expires: number }
	| { kind: "api_key" }
	/** `busy`: the store was still locked after the busy timeout (a concurrent omp write). */
	| { kind: "error"; cause: string; busy?: true };

/** Why the provider has no active credential: never signed in, or omp disabled its row. */
function noCredential(
	dbPath: string,
	provider: string,
	timeoutMs = STORE_BUSY_TIMEOUT_MS,
): string {
	const db = openStoreReadOnly(dbPath, timeoutMs);
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
function readToken(
	dbPath: string,
	provider: string,
	timeoutMs = STORE_BUSY_TIMEOUT_MS,
): Read {
	// A readonly open of a missing path fails with a message that names no file (login.ts).
	if (!existsSync(dbPath))
		return { kind: "error", cause: `the board store ${dbPath} does not exist` };
	let data: string;
	try {
		const row = currentCredential(dbPath, provider, timeoutMs);
		if (row === null)
			return {
				kind: "error",
				cause: noCredential(dbPath, provider, timeoutMs),
			};
		if (row.credential_type !== "oauth") return { kind: "api_key" };
		data = row.data;
	} catch (err) {
		// Still locked after the busy timeout: omp held the store (a token refresh).
		if (errmsg(err).includes("database is locked"))
			return {
				kind: "error",
				busy: true,
				cause: `the board store ${dbPath} is busy (a write did not end within ${timeoutMs / 1000} s)`,
			};
		return {
			kind: "error",
			cause: `cannot read the board store ${dbPath}: ${errmsg(err)}`,
		};
	}
	return parseCredential(data, provider);
}

/** Parses the OAuth row's JSON payload into a lendable token, or why the row is damaged. */
function parseCredential(data: string, provider: string): Read {
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
interface Lent {
	env: Record<string, string>;
	error: string | null;
	/** The error was a busy store: a reply retries, a new sign-in does not help. */
	busy?: boolean;
}

/** The lent env for the model's provider; a null model (a local run) lends nothing. */
export async function lentProviderEnv(
	model: string | null | undefined,
	opts: {
		dbPath?: string;
		now?: number;
		/** Only for tests: the command that gets `<provider> --force-refresh` appended. */
		command?: string[];
		/** Only for tests: how long a store read waits out a concurrent write. */
		busyTimeoutMs?: number;
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
	const dbPath = opts.dbPath ?? join(agentDir(), "agent.db");

	const before = readToken(dbPath, provider, opts.busyTimeoutMs);
	if (before.kind === "api_key") return { env: {}, error: null };
	if (before.kind === "error")
		return { env: {}, error: before.cause, busy: before.busy };
	if (before.expires - now > TOKEN_REFRESH_MARGIN_MS)
		return { env: { [name]: before.access }, error: null };
	return refreshedLent(name, provider, dbPath, now, opts);
}

/** Re-reads the store after omp re-minted the token; fails closed with the refresh's cause. */
async function refreshedLent(
	name: string,
	provider: string,
	dbPath: string,
	now: number,
	opts: { busyTimeoutMs?: number; command?: string[] },
): Promise<Lent> {
	const cause = await sharedRefresh(
		provider,
		dirname(dbPath),
		opts.command ?? ["omp", "token"],
	);
	const after = readToken(dbPath, provider, opts.busyTimeoutMs);
	// A login during the refresh made an API key current: as before the refresh, lend nothing.
	if (after.kind === "api_key") return { env: {}, error: null };
	if (after.kind === "token" && after.expires - now > TOKEN_REFRESH_MARGIN_MS)
		return { env: { [name]: after.access }, error: null };
	const why =
		cause ??
		(after.kind === "error"
			? after.cause
			: "the token is still near its expiry after omp ran");
	return {
		env: {},
		error: `omp did not refresh the board's ${provider} sign-in: ${why}`,
		busy: cause === null && after.kind === "error" ? after.busy : undefined,
	};
}

/**
 * A turn's env: the Settings values the project lists, then the lent token on top (a lent name
 * wins over a Settings value of the same name). A lending error stops the turn (fail closed).
 * `secrets` holds the lent values, which the run redacts from its log. `lend: false` (hosted
 * mode, docs/specs/hosted-mode.md section 3) lends no provider token: model access uses API keys.
 */
export async function turnEnv(
	project: string,
	model: string | null | undefined,
	envValues: Record<string, string>,
	opts: Parameters<typeof lentProviderEnv>[1] & {
		home?: string;
		lend?: boolean;
	} = {},
): Promise<{
	env: Record<string, string>;
	missing: string[];
	credentialError: string | null;
	/** The error was a busy board store: a reply retries, no new sign-in. */
	busy?: boolean;
	secrets: string[];
}> {
	const base = turnEnvValues(project, envValues, opts.home);
	const lent: Lent =
		opts.lend === false
			? { env: {}, error: null }
			: await lentProviderEnv(model, opts);
	return {
		env: { ...base.env, ...lent.env },
		missing: base.missing,
		credentialError: lent.error,
		busy: lent.busy,
		secrets: Object.values(lent.env),
	};
}

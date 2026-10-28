// Model-provider sign-in from the Settings page. Runs `omp login <provider>` on the machine that
// runs the board, against the board's own credential store, shows omp's own output - the sign-in
// URL and its prompt - and pipes the user's answer to omp's stdin. When the provider's redirect
// to localhost reaches the board (compose publishes those ports), the board hands that address to
// omp itself and sends the browser back to Settings; from a phone, the user pastes the same
// address into the Settings field. The board holds the one credential and lends its access token
// to each turn; a successful sign-in marks the workers' old rows superseded
// (docs/specs/provider-credentials.md).
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Subprocess, stripANSI } from "bun";

interface LoginView {
	provider: string;
	/** omp's stdout and stderr in arrival order, without terminal escapes. */
	output: string;
	/** Null while omp runs; whether the sign-in succeeded once omp exited. */
	ok: boolean | null;
	/** The board origin that started the sign-in: where the callback sends the browser. */
	returnTo?: string;
}

/** Where a sign-in writes: the board's agent dir, and the workers' store when it is another file. */
export interface LoginStores {
	/** The board's own agent dir (config.yml, agent.db): omp login runs against it. */
	boardDir: string;
	/**
	 * The workers' store and the home it lies in; null when the board's agent.db is that file.
	 * No sign-in runs against it: a successful sign-in only marks its rows superseded.
	 */
	worker: { db: string; home: string } | null;
}

/** omp's provider ids (`omp login --help`): lowercase words joined by hyphens. */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One provider omp's `/login` picker offers. */
export interface LoginProvider {
	/** The id `omp login <id>` accepts. */
	id: string;
	/** omp's display name for the picker. */
	name: string;
}

let loginProviderCache: { path: string; list: LoginProvider[] } | null = null;

/**
 * Every provider omp's `/login` offers, in omp's display order, read from the installed omp's
 * compiled auth catalog (pi-catalog's rules.json — the data `/login` is built from, sitting in
 * the same global install as the `omp` binary this board spawns). Reading the JSON keeps omp's
 * code out of this process. Empty when no omp install is found or its layout changed; the
 * provider field then takes typed ids as before.
 */
export function loginProviders(
	ompPath: string = Bun.which("omp") ?? "",
): LoginProvider[] {
	if (loginProviderCache?.path === ompPath) return loginProviderCache.list;
	// The omp binary is a symlink into its global install; pi-catalog lives in the same
	// node_modules tree, and the package's own exports map absorbs path moves.
	let list: LoginProvider[] = [];
	try {
		const catalog = dirname(
			Bun.resolveSync(
				"@oh-my-pi/pi-catalog/compat/auth",
				dirname(realpathSync(ompPath)),
			),
		);
		const rules: unknown = JSON.parse(
			readFileSync(join(catalog, "rules.json"), "utf8"),
		);
		let providers: unknown[] = [];
		if (typeof rules === "object" && rules !== null && "auth" in rules) {
			const auth: unknown = rules.auth;
			if (
				typeof auth === "object" &&
				auth !== null &&
				"providers" in auth &&
				Array.isArray(auth.providers)
			)
				providers = auth.providers;
		}
		// omp's own filter (pi-ai registry): a login flow, and not hidden from the picker.
		list = providers.flatMap((p): LoginProvider[] => {
			if (typeof p !== "object" || p === null || !("id" in p) || !("name" in p))
				return [];
			const { id, name } = p;
			const login = "login" in p ? p.login : undefined;
			const hidden = "showInLoginList" in p ? p.showInLoginList : undefined;
			return typeof id === "string" &&
				typeof name === "string" &&
				login &&
				hidden !== false
				? [{ id, name }]
				: [];
		});
	} catch {
		// No omp on PATH, or an unexpected catalog: stay empty rather than half-guessing.
	}
	loginProviderCache = { path: ompPath, list };
	return list;
}

const OUTPUT_CAP = 32_000;

interface Step {
	raw: string;
	lastOutputAt: number;
	child: Subprocess<"pipe", "pipe", "pipe">;
	/** omp's exit code; null while it runs. */
	code: number | null;
}

interface Login {
	provider: string;
	/** The running omp. */
	step: Step;
	ok: boolean | null;
	/** Set by cancel or the ttl: no further step starts. */
	stopped: boolean;
	ttl: Timer;
	/** The board origin that started the sign-in: where the provider's callback sends the browser. */
	returnTo: string;
}

const errmsg = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

/** The loopback address the provider's page sends the browser back to, read from omp's sign-in URL. */
export function redirectUri(output: string): URL | null {
	const page = output.match(/https:\/\/\S+/)?.[0];
	if (page === undefined) return null;
	try {
		const back = new URL(new URL(page).searchParams.get("redirect_uri") ?? "");
		const loopback =
			back.hostname === "localhost" || back.hostname === "127.0.0.1";
		return back.protocol === "http:" && loopback ? back : null;
	} catch {
		return null; // not a URL: this provider has no loopback callback
	}
}

export function providerLogin({
	command = ["omp", "login"],
	quietMs = 1000,
	startMs = 20_000,
	answerMs = 90_000,
	ttlMs = 600_000,
	stores = loginStores,
}: {
	/** Only for tests: the command that gets the provider id appended. */
	command?: string[];
	/** Output that stays quiet this long means omp waits for the user. */
	quietMs?: number;
	startMs?: number;
	answerMs?: number;
	/** An unfinished sign-in is killed after this long. */
	ttlMs?: number;
	/** Only for tests: the stores a sign-in writes. */
	stores?: () => LoginStores;
} = {}) {
	// ponytail: one sign-in at a time for the whole board; a new start replaces the pending one.
	let current: Login | null = null;

	// Carriage returns come from redrawn lines; the escapes from colours and cursor moves.
	const clean = (s: Step) => stripANSI(s.raw).replaceAll("\r", "");

	const view = (l: Login): LoginView => ({
		provider: l.provider,
		output: clean(l.step),
		ok: l.ok,
		returnTo: l.returnTo,
	});

	async function pump(s: Step, stream: ReadableStream<Uint8Array>) {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			s.raw = (s.raw + decoder.decode(chunk, { stream: true })).slice(
				-OUTPUT_CAP,
			);
			s.lastOutputAt = Date.now();
		}
	}

	/** Waits until the step's omp exits, `settled()` holds, or `ms` pass. */
	async function wait(s: Step, ms: number, settled: () => boolean) {
		const end = Date.now() + ms;
		while (s.code === null && Date.now() < end && !settled())
			await Bun.sleep(50);
	}

	const quiet = (s: Step) => Date.now() - s.lastOutputAt >= quietMs;

	/**
	 * Runs `omp login <provider>` against the board's agent dir, with the board's own HOME (R5-1:
	 * never a worker-writable dir). `onExit` runs once omp exited and both streams ended, in the
	 * same tick that sets the exit code, so a waiter that sees the code also sees the verdict.
	 */
	function launch(
		provider: string,
		dir: string,
		onExit: (code: number) => void,
	): Step {
		const child = Bun.spawn([...command, provider], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...boardOmpEnv(), PI_CODING_AGENT_DIR: dir },
			windowsHide: true,
		});
		const s: Step = { raw: "", lastOutputAt: 0, child, code: null };
		void Promise.all([
			pump(s, child.stdout).catch(() => {}),
			pump(s, child.stderr).catch(() => {}),
			child.exited,
		]).then(([, , code]) => {
			s.code = code;
			onExit(code);
		});
		return s;
	}

	/** Ends the sign-in; a message lands in the output. */
	function finish(l: Login, ok: boolean, message?: string): void {
		if (message !== undefined) l.step.raw += `\n${message}\n`;
		l.ok = ok;
		clearTimeout(l.ttl);
	}

	/**
	 * After a sign-in: what the workers get follows the credential this login wrote (each active
	 * row of the board store whose login moment is at or after `startedAt`; omp inserts a new row or
	 * updates the same account's row in place). A lent one (OAuth, LENT_ENV provider) marks the
	 * workers' active rows of that provider superseded, so omp on a worker resolves the lent env
	 * token instead of its stale store row (any active row would beat it). Any other credential
	 * leaves the worker store alone: the workers keep their own. The board writes only the cause
	 * string and reads nothing from the worker store; a failure cannot fail the sign-in.
	 */
	function supersedeWorkers(
		l: Login,
		boardDb: string,
		startedAt: number,
		worker: LoginStores["worker"],
	): void {
		if (worker === null) return;
		try {
			for (const r of activeCredentials(boardDb)) {
				if (r.loginAt < startedAt) continue;
				if (!lendable(r))
					l.step.raw += `\nWorker turns do not get ${r.provider} from the board: they keep their own sign-in, or set its env key under Settings, Env.\n`;
				else if (existsSync(worker.db))
					signOut(r.provider, worker.db, "replaced by newer credential");
			}
		} catch (err) {
			l.step.raw += `\nCannot mark the workers' rows replaced in ${worker.db}: ${errmsg(err)}\n`;
		}
	}

	async function start(provider: string, returnTo: string): Promise<LoginView> {
		cancel();
		const { boardDir, worker } = stores();
		const boardDb = join(boardDir, "agent.db");
		const startedAt = Date.now();
		const l: Login = {
			provider,
			step: launch(provider, boardDir, (code) => {
				if (code !== 0 || l.stopped) finish(l, false);
				else {
					finish(l, true);
					supersedeWorkers(l, boardDb, startedAt, worker);
				}
			}),
			ok: null,
			stopped: false,
			ttl: setTimeout(() => stop(l), ttlMs),
			returnTo,
		};
		current = l;
		// omp prints the sign-in URL and its prompt at once, then waits.
		const s = l.step;
		await wait(s, startMs, () => s.raw !== "" && quiet(s));
		return view(l);
	}

	/** Sends one line (none when empty) and waits for omp to exit or to ask something new. */
	async function answer(line: string): Promise<LoginView | null> {
		const l = current;
		if (l === null) return null;
		const s = l.step;
		// Stamped before the write: omp may answer while the flush is still awaited.
		const sent = Date.now();
		if (s.code === null && line !== "") {
			s.child.stdin.write(`${line}\n`);
			await s.child.stdin.flush();
		}
		await wait(
			s,
			answerMs,
			() => s.lastOutputAt >= sent && quiet(s) && /[:?]\s*$/.test(clean(s)),
		);
		return view(l);
	}

	function stop(l: Login): void {
		l.stopped = true;
		if (l.step.code === null) l.step.child.kill();
	}

	function cancel(): void {
		if (current !== null) stop(current);
		current = null;
	}

	/** The latest sign-in, finished or not, until the next start or cancel. */
	const pending = (): LoginView | null =>
		current === null ? null : view(current);

	/**
	 * The provider's redirect to the address in omp's sign-in URL: hands it to the waiting omp,
	 * then sends the browser back to Settings. Null for every other request.
	 */
	async function callback(req: Request): Promise<Response | null> {
		const l = current;
		if (l === null || l.ok !== null) return null;
		const back = redirectUri(clean(l.step));
		const url = new URL(req.url);
		if (
			back === null ||
			req.headers.get("host")?.toLowerCase() !== back.host ||
			url.pathname !== back.pathname
		)
			return null;
		await answer(`${back.origin}${url.pathname}${url.search}`);
		return Response.redirect(`${l.returnTo}/#settings`, 303);
	}

	/** The latest sign-in's running or last omp child: its exit and signal prove a kill. */
	const child = (): Subprocess | null => current?.step.child ?? null;

	return { start, answer, cancel, pending, callback, child };
}

/**
 * HOME for the board's own omp spawns. omp resolves its plugins dir ($HOME/.omp/plugins) and the
 * user-level skills and context files (~/.agents, ~/.claude, …) from HOME, never from
 * PI_CODING_AGENT_DIR. R5-1: compose sets OTTR_BOARD_OMP_HOME to a server-only directory, so a
 * plugin or skill a turn plants in the worker-writable shared home never loads into the board's
 * privileged turns. Unset (a direct install): the process's own home.
 */
export const boardOmpHome = (): string => {
	const set = process.env.OTTR_BOARD_OMP_HOME?.trim();
	return set ? resolve(set) : homedir();
};

/**
 * Env for every omp the board spawns for itself (merge, release review and release turns,
 * `omp models`, `omp usage`, `omp login`, the fork-analysis gateway): `base` with HOME moved to
 * boardOmpHome(). Worker turns and their local fallback keep the shared home.
 */
export const boardOmpEnv = (
	base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> => ({ ...base, HOME: boardOmpHome() });

/**
 * The board's own omp agent dir: config.yml, agent.db, skills, extensions. omp resolves it from
 * PI_CODING_AGENT_DIR and falls back to ~/.omp/agent under the HOME it runs with — boardOmpHome()
 * (R5-1: compose pins the board's copy to a directory no worker mounts).
 */
export const agentDir = (): string =>
	process.env.PI_CODING_AGENT_DIR ?? join(boardOmpHome(), ".omp", "agent");

const agentDb = (): string => join(agentDir(), "agent.db");

/**
 * The board's own store, and the workers' store when it is another file. The workers read the
 * default home location, even when the pin above moves the board's own copy elsewhere: one file
 * for the stack, mounted read-write into every container (docs/WORKERS.md). Without a pin both
 * are one file. A sign-in runs against the board's store only; the worker field serves the
 * supersede and sign-out sweeps.
 */
export function loginStores(): LoginStores {
	const boardDir = agentDir();
	const home = process.env.HOME ?? homedir();
	const db = join(home, ".omp", "agent", "agent.db");
	return {
		boardDir,
		worker: resolve(boardDir, "agent.db") === resolve(db) ? null : { db, home },
	};
}

/**
 * Marks the provider's rows signed out everywhere: the board store, and the workers' store when
 * it is another file and exists. A missing worker store counts as none.
 */
export function signOutEverywhere(
	provider: string,
	s: LoginStores = loginStores(),
): { board: number; workers?: number } {
	const removed: { board: number; workers?: number } = {
		board: signOut(provider, join(s.boardDir, "agent.db")),
	};
	if (s.worker !== null)
		removed.workers = existsSync(s.worker.db)
			? signOut(provider, s.worker.db)
			: 0;
	return removed;
}

/**
 * The env name omp reads each provider's OAuth access token from (pi-catalog provider rules), for
 * the providers the board lends to worker turns. Keys are omp's stored provider ids:
 * `openai-codex-device` stores as `openai-codex`, `zai-coding-plan` as `zai`.
 */
export const LENT_ENV: Readonly<Record<string, string>> = {
	anthropic: "ANTHROPIC_OAUTH_TOKEN",
	"openai-codex": "OPENAI_CODEX_OAUTH_TOKEN",
	// The zai OAuth token never expires; the provider's bearer slot takes it.
	zai: "ZAI_API_KEY",
};

export interface SignIn {
	provider: string;
	/** omp's credential type: "oauth" for a sign-in, "api_key" for a stored key. */
	kind: string;
	/** False when omp disabled it, e.g. after a refresh failed: the provider needs a new sign-in. */
	active: boolean;
	/** omp's own disabled_cause of the kept row; null when the sign-in is active. */
	cause: string | null;
	/** Worker turns get this sign-in as a lent env token: the provider's current credential is OAuth and the provider is in LENT_ENV. */
	lent: boolean;
}

// The causes omp itself hides (pi-coding-agent usage-cli): a logout or a newer login of the account.
const GONE = /^(replaced by|deleted by user)/i;

/** omp's stored sign-ins, one per provider: its current credential (see currentCredential); a failed one only when none is active. */
export function signIns(dbPath = agentDb()): SignIn[] {
	const db = new Database(dbPath, { readonly: true });
	const by = new Map<string, SignIn>();
	try {
		const failed = db
			.query(
				"SELECT provider, credential_type, disabled_cause FROM auth_credentials WHERE disabled_cause IS NOT NULL ORDER BY id",
			)
			.all() as Array<{
			provider: string;
			credential_type: string;
			disabled_cause: string;
		}>;
		for (const r of failed) {
			if (GONE.test(r.disabled_cause)) continue;
			by.set(r.provider, {
				provider: r.provider,
				kind: r.credential_type,
				active: false,
				cause: r.disabled_cause,
				lent: false,
			});
		}
	} finally {
		db.close();
	}
	for (const r of currentCredentials(dbPath).values())
		by.set(r.provider, {
			provider: r.provider,
			kind: r.credential_type,
			active: true,
			cause: null,
			lent: lendable(r),
		});
	return [...by.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** An active auth_credentials row and the moment the user signed it in. */
export interface ActiveCredential {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
	/**
	 * When the user signed it in, in ms. omp stamps an OAuth login with `authorizedAt` in the data,
	 * and a refresh keeps it (pi-ai auth/oauth.ts, auth/refresh.ts). An API-key row changes only on
	 * a login, so its `updated_at` is that moment. ponytail: `updated_at` has whole seconds, so an
	 * API key counts as the end of its second; two logins inside one second can tie wrong.
	 */
	loginAt: number;
}

/** The store's active rows with their login moments; empty when the store or its table is missing. */
function activeCredentials(dbPath: string): ActiveCredential[] {
	// A readonly open of a missing path fails with a message that names no file.
	if (!existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.query(
				"SELECT id, provider, credential_type, data, created_at, updated_at FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id",
			)
			.all() as Array<{
			id: number;
			provider: string;
			credential_type: string;
			data: string;
			created_at: number | null;
			updated_at: number | null;
		}>;
		return rows.map((r) => {
			let authorizedAt: unknown;
			try {
				authorizedAt = (JSON.parse(r.data) as { authorizedAt?: unknown } | null)
					?.authorizedAt;
			} catch {
				authorizedAt = undefined; // junk data: fall back to the row's own time
			}
			const loginAt =
				r.credential_type === "oauth"
					? typeof authorizedAt === "number" && Number.isFinite(authorizedAt)
						? authorizedAt
						: (r.created_at ?? 0) * 1000
					: (r.updated_at ?? 0) * 1000 + 999;
			return {
				id: r.id,
				provider: r.provider,
				credential_type: r.credential_type,
				data: r.data,
				loginAt,
			};
		});
	} catch (err) {
		// No auth_credentials table: not an omp store. Anything else (a locked store) surfaces.
		if (errmsg(err).includes("no such table")) return [];
		throw err;
	} finally {
		db.close();
	}
}

/** Each provider's current credential: the active row of its newest login (ties: the higher id). */
function currentCredentials(dbPath: string): Map<string, ActiveCredential> {
	const by = new Map<string, ActiveCredential>();
	for (const r of activeCredentials(dbPath)) {
		const prev = by.get(r.provider);
		if (prev === undefined || r.loginAt >= prev.loginAt) by.set(r.provider, r);
	}
	return by;
}

/**
 * The provider's current credential in the store, or null. An API key that the user signed in
 * after an OAuth login is current even while the OAuth row stays active, so the board lends
 * nothing for it.
 */
export const currentCredential = (
	dbPath: string,
	provider: string,
): ActiveCredential | null => currentCredentials(dbPath).get(provider) ?? null;

/** The board lends this credential to worker turns: OAuth, of a LENT_ENV provider. */
const lendable = (r: ActiveCredential): boolean =>
	r.credential_type === "oauth" && Object.hasOwn(LENT_ENV, r.provider);

export interface DeadSignIn {
	provider: string;
	/** omp's own disabled_cause message; the advisory prints it verbatim. */
	cause: string;
	roles: string[];
}

/**
 * Providers a configured model role uses whose only stored sign-in omp disabled: one entry per
 * provider, in the input order. The cause is omp's own message; no credential data (tokens, keys)
 * is included — only the provider id, the cause, and the role names.
 */
export function deadSignIns(
	list: readonly SignIn[],
	roles: Readonly<Record<string, string>>,
): DeadSignIn[] {
	return list
		.filter((s) => !s.active && s.cause !== null && s.cause !== "")
		.map((s) => ({
			provider: s.provider,
			cause: s.cause as string,
			roles: Object.entries(roles)
				.filter(([, model]) => model.startsWith(`${s.provider}/`))
				.map(([role]) => role),
		}))
		.filter((d) => d.roles.length > 0);
}

/**
 * Marks a provider's rows signed out the way omp's own logout does (pi-ai
 * sqlite-credential-store): the rows get `cause` (omp's "deleted by user", or "replaced by newer
 * credential" when a newer sign-in supersedes them), and the store's triggers tell running omp
 * processes. Failed rows go too, so the provider leaves the list. Returns how many rows changed.
 */
export function signOut(
	provider: string,
	dbPath = agentDb(),
	cause = "deleted by user",
): number {
	const db = new Database(dbPath);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		return db
			.query(
				`UPDATE auth_credentials SET disabled_cause = ?,
				updated_at = CAST(strftime('%s','now') AS INTEGER)
				WHERE provider = ? AND (disabled_cause IS NULL
					OR NOT (disabled_cause LIKE 'deleted by user%' OR disabled_cause LIKE 'replaced by%'))`,
			)
			.run(cause, provider).changes;
	} finally {
		db.close();
	}
}

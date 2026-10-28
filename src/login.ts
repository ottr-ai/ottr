// Model-provider sign-in from the Settings page. Runs `omp login <provider>` on the machine that
// runs the board, shows omp's own output - the sign-in URL and its prompt - and pipes the user's
// answer to omp's stdin. When the provider's redirect to localhost reaches the board (compose
// publishes those ports), the board hands that address to omp itself and sends the browser on.
// The board and the workers keep separate credential stores; a sign-in runs one omp login for
// each, so each store holds its own refresh token (docs/specs/provider-credentials.md).
import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type Subprocess, stripANSI } from "bun";

/** omp's credential stores a sign-in writes: the board's own, and the one the workers read. */
export type StoreName = "board" | "workers";

interface LoginView {
	provider: string;
	/** The store the current (or the last) omp login of this sign-in writes. */
	store: StoreName;
	/** 1-based step of the sign-in; `steps` is 2 when the board and the workers have separate stores. */
	step: number;
	steps: number;
	/** The step's omp stdout and stderr in arrival order, without terminal escapes. */
	output: string;
	/** Null while a step runs; whether every step succeeded once one failed or all finished. */
	ok: boolean | null;
}

/** Where a sign-in writes: the board's agent dir, and the workers' store when it is another file. */
export interface LoginStores {
	/** The board's own agent dir (config.yml, agent.db): step 1 runs omp against it. */
	boardDir: string;
	/** The workers' store and the home it lies in; null when the board's agent.db is that file. */
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
				!!login &&
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
	store: StoreName;
	raw: string;
	lastOutputAt: number;
	child: Subprocess<"pipe", "pipe", "pipe">;
	/** omp's exit code; null while it runs. */
	code: number | null;
}

interface Login {
	provider: string;
	stores: LoginStores;
	/** The running step, or the last one. */
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

/** The provider's sign-in page: the first https URL omp prints; later ones are its local shortcuts. */
function signInPage(output: string): string | null {
	const page = output.match(/https:\/\/\S+/)?.[0];
	if (page === undefined) return null;
	try {
		return new URL(page).href;
	} catch {
		return null;
	}
}

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
		store: l.step.store,
		step: l.step.store === "board" ? 1 : 2,
		steps: l.stores.worker === null ? 1 : 2,
		output: clean(l.step),
		ok: l.ok,
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
	 * Runs `omp login <provider>` against one agent dir, with the board's own HOME (R5-1: never
	 * a worker-writable dir). `onExit` runs once omp exited and both streams ended, in the same
	 * tick that sets the step's code, so a waiter that sees the code also sees the next step.
	 */
	function launch(
		provider: string,
		store: StoreName,
		dir: string,
		onExit: (code: number) => void,
	): Step {
		const env: Record<string, string | undefined> = {
			...boardOmpEnv(),
			PI_CODING_AGENT_DIR: dir,
		};
		// omp moves agent.db under an existing XDG data dir; the scratch store must hold it.
		if (store === "workers") for (const k of XDG_DIRS) delete env[k];
		const child = Bun.spawn([...command, provider], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
			windowsHide: true,
		});
		const s: Step = { store, raw: "", lastOutputAt: 0, child, code: null };
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

	/** Ends the sign-in; a message lands in the output of the last step. */
	function finish(l: Login, ok: boolean, message?: string): void {
		if (message !== undefined) l.step.raw += `\n${message}\n`;
		l.ok = ok;
		clearTimeout(l.ttl);
	}

	/**
	 * Step 2: a separate omp login whose credential gets its own refresh token. omp runs against
	 * a fresh board-only scratch dir, never the worker store's dir; the board then writes the new
	 * row into the worker store and removes the scratch dir, whatever the outcome.
	 */
	function startWorkers(
		l: Login,
		worker: NonNullable<LoginStores["worker"]>,
	): void {
		let scratch: string;
		try {
			if (!existsSync(worker.db))
				throw new Error(
					`the worker store ${worker.db} does not exist; run omp once on a worker to create it`,
				);
			scratch = scratchAgentDir(l.stores.boardDir, worker.home);
		} catch (err) {
			finish(l, false, `The workers are not signed in: ${errmsg(err)}`);
			return;
		}
		const removeScratch = () => {
			try {
				rmSync(scratch, { recursive: true, force: true });
			} catch (err) {
				l.step.raw += `\nCannot remove the sign-in dir ${scratch}: ${errmsg(err)}\n`;
			}
		};
		try {
			l.step = launch(l.provider, "workers", scratch, (code) => {
				try {
					if (code === 0 && !l.stopped) {
						adoptSignIn(join(scratch, "agent.db"), worker.db);
						finish(l, true, `Signed the workers in: ${worker.db}`);
					} else finish(l, false);
				} catch (err) {
					finish(l, false, `The workers are not signed in: ${errmsg(err)}`);
				} finally {
					removeScratch();
				}
			});
		} catch (err) {
			// omp did not start: no exit will come to clean up.
			finish(l, false, `The workers are not signed in: ${errmsg(err)}`);
			removeScratch();
		}
	}

	async function start(provider: string, returnTo: string): Promise<LoginView> {
		cancel();
		const where = stores();
		const l: Login = {
			provider,
			stores: where,
			step: launch(provider, "board", where.boardDir, (code) => {
				if (code !== 0 || l.stopped) finish(l, false);
				else if (where.worker === null) finish(l, true);
				else startWorkers(l, where.worker);
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
		// Step 1 ended and step 2 runs: return once step 2 printed its sign-in URL and prompt.
		const next = l.step;
		if (next !== s && l.ok === null)
			await wait(next, startMs, () => next.raw !== "" && quiet(next));
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
	 * then sends the browser to the next step's sign-in page, or back to Settings. Null for every
	 * other request.
	 */
	async function callback(req: Request): Promise<Response | null> {
		const l = current;
		if (l === null || l.ok !== null) return null;
		const s = l.step;
		const back = redirectUri(clean(s));
		const url = new URL(req.url);
		if (
			back === null ||
			req.headers.get("host")?.toLowerCase() !== back.host ||
			url.pathname !== back.pathname
		)
			return null;
		await answer(`${back.origin}${url.pathname}${url.search}`);
		const next = l.step;
		const page =
			l.ok === null && next !== s && next.code === null
				? signInPage(clean(next))
				: null;
		return Response.redirect(page ?? `${l.returnTo}/#settings`, 303);
	}

	/** The latest sign-in's running or last omp child: its exit and signal prove a kill. */
	const child = (): Subprocess | null => current?.step.child ?? null;

	return { start, answer, cancel, pending, callback, child };
}

const XDG_DIRS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

/** `p` is `dir` or lies below it; symlinks resolved where the path exists. */
function within(p: string, dir: string): boolean {
	const [a, b] = [p, dir].map((x) =>
		existsSync(x) ? realpathSync(x) : resolve(x),
	) as [string, string];
	return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * A new board-only agent dir for one worker-store login: mode 0700, next to the board's own agent
 * dir (compose: the board-config volume), never inside the worker home (R5-1: omp loads config and
 * extensions from its agent dir). The caller removes it.
 */
function scratchAgentDir(boardDir: string, workerHome: string): string {
	const parent = dirname(resolve(boardDir));
	const refusal = `the board agent dir ${boardDir} lies in the worker home ${workerHome}; set PI_CODING_AGENT_DIR outside it`;
	if (within(parent, workerHome)) throw new Error(refusal);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const dir = mkdtempSync(join(parent, ".ottr-login-"));
	chmodSync(dir, 0o700);
	if (within(dir, workerHome)) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(refusal);
	}
	return dir;
}

const NOW = "CAST(strftime('%s','now') AS INTEGER)";

/** The columns of omp's auth_credentials a worker-store login carries over. */
interface CredentialRow {
	provider: string;
	credential_type: string;
	data: string;
	identity_key: string | null;
}

/**
 * Writes the credential of a worker-store login into the worker store; the scratch store holds
 * only that login's rows. Each row goes in as one INSERT of bound values. The rows it replaces -
 * the same provider and account, and the provider's API keys under a new OAuth sign-in, as omp's
 * own login does - get omp's "replaced by newer credential" cause. Nothing is read from the worker
 * store: the board never resolves a key a worker could plant. Returns the rows written; throws on
 * any failure.
 */
export function adoptSignIn(scratchDb: string, workerDb: string): number {
	if (!existsSync(scratchDb)) throw new Error("omp stored no credential");
	// Opening a missing path would create an empty database file.
	if (!existsSync(workerDb))
		throw new Error(`the worker store ${workerDb} does not exist`);
	const src = new Database(scratchDb, { readonly: true });
	let rows: CredentialRow[];
	try {
		rows = src
			.query(
				"SELECT provider, credential_type, data, identity_key FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id",
			)
			.all() as CredentialRow[];
	} finally {
		src.close();
	}
	if (rows.length === 0) throw new Error("omp stored no credential");
	const db = new Database(workerDb);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const replaced = db.query(
			`UPDATE auth_credentials SET disabled_cause = 'replaced by newer credential', updated_at = ${NOW}
			WHERE provider = ?1 AND (identity_key IS ?2 OR (?3 = 'oauth' AND credential_type = 'api_key'))
				AND (disabled_cause IS NULL
					OR NOT (disabled_cause LIKE 'deleted by user%' OR disabled_cause LIKE 'replaced by%'))`,
		);
		const insert = db.query(
			`INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at)
			VALUES (?, ?, ?, ?, ${NOW}, ${NOW})`,
		);
		db.transaction(() => {
			for (const r of rows) {
				replaced.run(r.provider, r.identity_key, r.credential_type);
				insert.run(r.provider, r.credential_type, r.data, r.identity_key);
			}
		})();
		return rows.length;
	} finally {
		db.close();
	}
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
 * The stores a sign-in writes. The workers read the default home location, even when the pin
 * above moves the board's own copy elsewhere: one file for the stack, mounted read-write into
 * every container (docs/WORKERS.md). Without a pin both are one file, and a sign-in runs once.
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

/** One store's sign-ins for Settings; `error` when the store cannot be read. */
export interface StoreSignIns {
	store: StoreName;
	signIns: SignIn[] | null;
	error: string | null;
}

/** The sign-ins of each store a sign-in writes: the board's, then the workers' when separate. */
export function storeSignIns(s: LoginStores = loginStores()): StoreSignIns[] {
	const read = (store: StoreName, db: string): StoreSignIns => {
		try {
			// A readonly open of a missing path fails with a message that names no file.
			if (!existsSync(db)) throw new Error(`${db} does not exist`);
			return { store, signIns: signIns(db), error: null };
		} catch (err) {
			return {
				store,
				signIns: null,
				error: `cannot read omp's sign-ins: ${errmsg(err)}`,
			};
		}
	};
	const list = [read("board", join(s.boardDir, "agent.db"))];
	if (s.worker !== null) list.push(read("workers", s.worker.db));
	return list;
}

/** Signs the provider out of each store a sign-in writes; a missing worker store counts as none. */
export function signOutStores(
	provider: string,
	s: LoginStores = loginStores(),
): Partial<Record<StoreName, number>> {
	const removed: Partial<Record<StoreName, number>> = {
		board: signOut(provider, join(s.boardDir, "agent.db")),
	};
	if (s.worker !== null)
		removed.workers = existsSync(s.worker.db)
			? signOut(provider, s.worker.db)
			: 0;
	return removed;
}

export interface SignIn {
	provider: string;
	/** omp's credential type: "oauth" for a sign-in, "api_key" for a stored key. */
	kind: string;
	/** False when omp disabled it, e.g. after a refresh failed: the provider needs a new sign-in. */
	active: boolean;
	/** omp's own disabled_cause of the kept row; null when the sign-in is active. */
	cause: string | null;
}

// The causes omp itself hides (pi-coding-agent usage-cli): a logout or a newer login of the account.
const GONE = /^(replaced by|deleted by user)/i;

/** omp's stored sign-ins, one per provider; an active one wins over a failed one. */
export function signIns(dbPath = agentDb()): SignIn[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.query(
				"SELECT provider, credential_type, disabled_cause FROM auth_credentials ORDER BY id",
			)
			.all() as Array<{
			provider: string;
			credential_type: string;
			disabled_cause: string | null;
		}>;
		const by = new Map<string, SignIn>();
		for (const r of rows) {
			if (r.disabled_cause !== null && GONE.test(r.disabled_cause)) continue;
			const s = {
				provider: r.provider,
				kind: r.credential_type,
				active: r.disabled_cause === null,
				cause: r.disabled_cause,
			};
			if (!by.get(r.provider)?.active) by.set(r.provider, s);
		}
		return [...by.values()].sort((a, b) =>
			a.provider.localeCompare(b.provider),
		);
	} finally {
		db.close();
	}
}

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
 * Signs a provider out the way omp's own logout does (pi-ai sqlite-credential-store): the rows get
 * the cause "deleted by user", and the store's triggers tell running omp processes. Failed rows go
 * too, so the provider leaves the list. Returns how many rows changed.
 */
export function signOut(provider: string, dbPath = agentDb()): number {
	const db = new Database(dbPath);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		return db
			.query(
				`UPDATE auth_credentials SET disabled_cause = 'deleted by user',
				updated_at = CAST(strftime('%s','now') AS INTEGER)
				WHERE provider = ? AND (disabled_cause IS NULL
					OR NOT (disabled_cause LIKE 'deleted by user%' OR disabled_cause LIKE 'replaced by%'))`,
			)
			.run(provider).changes;
	} finally {
		db.close();
	}
}

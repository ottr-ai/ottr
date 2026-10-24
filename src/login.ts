// Model-provider sign-in from the Settings page. Runs `omp login <provider>` on the machine that
// runs the board (in compose: the server container, whose agent.db the workers share), shows omp's
// own output - the sign-in URL and its prompt - and pipes the user's answer to omp's stdin. When
// the provider's redirect to localhost reaches the board (compose publishes those ports), the board
// hands that address to omp itself and sends the browser back to Settings.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Subprocess, stripANSI } from "bun";

interface LoginView {
	provider: string;
	/** omp's stdout and stderr in arrival order, without terminal escapes. */
	output: string;
	/** Null while omp runs; whether it exited 0 once it has. */
	ok: boolean | null;
	/** Non-null when the finished sign-in failed to reach the shared worker store. */
	syncError: string | null;
}

/** omp's provider ids (`omp login --help`): lowercase words joined by hyphens. */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const OUTPUT_CAP = 32_000;

interface Login {
	provider: string;
	raw: string;
	ok: boolean | null;
	lastOutputAt: number;
	child: Subprocess<"pipe", "pipe", "pipe">;
	/** The board origin that started the sign-in: where the provider's callback sends the browser. */
	returnTo: string;
	/** Set once the sign-in succeeded but the copy to the shared worker store failed. */
	syncError?: string;
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
}: {
	/** Only for tests: the command that gets the provider id appended. */
	command?: string[];
	/** Output that stays quiet this long means omp waits for the user. */
	quietMs?: number;
	startMs?: number;
	answerMs?: number;
	/** An unfinished sign-in is killed after this long. */
	ttlMs?: number;
} = {}) {
	// ponytail: one sign-in at a time for the whole board; a new start replaces the pending one.
	let current: Login | null = null;

	const view = (l: Login): LoginView => ({
		provider: l.provider,
		// Carriage returns come from redrawn lines; the escapes from colours and cursor moves.
		output: stripANSI(l.raw).replaceAll("\r", ""),
		ok: l.ok,
		syncError: l.syncError ?? null,
	});

	async function pump(l: Login, stream: ReadableStream<Uint8Array>) {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			l.raw = (l.raw + decoder.decode(chunk, { stream: true })).slice(
				-OUTPUT_CAP,
			);
			l.lastOutputAt = Date.now();
		}
	}

	/** Waits until omp exits, `settled()` holds, or `ms` pass. */
	async function wait(l: Login, ms: number, settled: () => boolean) {
		const end = Date.now() + ms;
		while (l.ok === null && Date.now() < end && !settled()) await Bun.sleep(50);
	}

	const quiet = (l: Login) => Date.now() - l.lastOutputAt >= quietMs;

	async function start(provider: string, returnTo: string): Promise<LoginView> {
		cancel();
		const child = Bun.spawn([...command, provider], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const l: Login = {
			provider,
			raw: "",
			ok: null,
			lastOutputAt: 0,
			child,
			returnTo,
		};
		current = l;
		const ttl = setTimeout(() => child.kill(), ttlMs);
		// The verdict waits for both streams, so the final output is complete when `ok` is set.
		void Promise.all([
			pump(l, child.stdout).catch(() => {}),
			pump(l, child.stderr).catch(() => {}),
			child.exited,
		]).then(([, , code]) => {
			clearTimeout(ttl);
			l.ok = code === 0;
			// R5-1: the sign-in landed in the board's own store; workers read the shared
			// one, so the new credential only reaches a turn after the copy succeeds.
			if (code === 0)
				l.syncError = shareProviderCredentials(provider) ?? undefined;
		});
		// omp prints the sign-in URL and its prompt at once, then waits.
		await wait(l, startMs, () => l.raw !== "" && quiet(l));
		return view(l);
	}

	/** Sends one line (none when empty) and waits for omp to exit or to ask something new. */
	async function answer(line: string): Promise<LoginView | null> {
		const l = current;
		if (l === null) return null;
		// Stamped before the write: omp may answer while the flush is still awaited.
		const sent = Date.now();
		if (l.ok === null && line !== "") {
			l.child.stdin.write(`${line}\n`);
			await l.child.stdin.flush();
		}
		await wait(
			l,
			answerMs,
			() =>
				l.lastOutputAt >= sent && quiet(l) && /[:?]\s*$/.test(view(l).output),
		);
		return view(l);
	}

	function cancel(): void {
		if (current?.ok === null) current.child.kill();
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
		const back = redirectUri(view(l).output);
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

	return { start, answer, cancel, pending, callback };
}

/**
 * The board's own omp agent dir: config.yml, agent.db, skills, extensions, plugins. omp resolves
 * it from PI_CODING_AGENT_DIR and falls back to ~/.omp/agent (R5-1: compose pins the board's
 * copy to the container filesystem, which no worker mounts).
 */
export const agentDir = (): string =>
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");

const agentDb = (): string => join(agentDir(), "agent.db");

/**
 * The shared store the workers read: always the default home location, even when the pin above
 * moves the board's own copy elsewhere. One file for the stack, mounted read-write into every
 * container (docs/WORKERS.md).
 */
export const sharedAgentDb = (): string =>
	join(process.env.HOME ?? homedir(), ".omp", "agent", "agent.db");

/**
 * Copies one provider's credential rows from the board's own store into the shared worker store
 * (R5-1 write-through): Settings sign-in and sign-out change only the pinned copy, and worker
 * turns authenticate against the shared one. Attaching both files keeps omp's schema private —
 * rows move whole, whatever columns the installed omp version uses. Returns null on success or
 * when both paths are one file (a direct install, no pin), else the error message.
 */
export function shareProviderCredentials(
	provider: string,
	fromDb: string = agentDb(),
	toDb: string = sharedAgentDb(),
): string | null {
	if (fromDb === toDb) return null;
	// Both stores must exist: opening a missing path would create an empty database file.
	if (!existsSync(fromDb))
		return `the board's own store ${fromDb} is missing; nothing to copy`;
	if (!existsSync(toDb))
		return `the shared worker store ${toDb} is missing; workers cannot see this sign-in`;
	// Read-write despite the read-only selects: a read-only connection cannot write to
	// the attached shared store either.
	const db = new Database(fromDb);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const { n } = db
			.query("SELECT count(*) AS n FROM auth_credentials WHERE provider = ?")
			.get(provider) as { n: number };
		if (n === 0) return null;
		db.exec(`ATTACH DATABASE '${toDb.replaceAll("'", "''")}' AS shared_store`);
		db.query(
			`INSERT OR REPLACE INTO shared_store.auth_credentials
			SELECT * FROM main.auth_credentials WHERE provider = ?`,
		).run(provider);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	} finally {
		db.close();
	}
}

export interface SignIn {
	provider: string;
	/** omp's credential type: "oauth" for a sign-in, "api_key" for a stored key. */
	kind: string;
	/** False when omp disabled it, e.g. after a refresh failed: the provider needs a new sign-in. */
	active: boolean;
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

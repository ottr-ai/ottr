// OTTR-693: the commit identity a turn or a board git call falls back to, and the
// per-turn env that applies it. Workers share a home volume that ships no gitconfig
// (docs/WORKERS.md, "Topology"), so the first git commit in such a turn died with
// "no author identity". The ident env vars beat every config scope, so the env is
// set only for the fields the turn's git config leaves empty: a configured identity
// (a user ~/.gitconfig, the board's pinned /etc/ottr/gitconfig) keeps winning.
import { spawnSync } from "node:child_process";

/** The identity the entry script seeds the board's pinned git config with (docker/ottr-entry.sh). */
export const DEFAULT_COMMIT_NAME = "Ottr";
export const DEFAULT_COMMIT_EMAIL = "ottr@localhost";

export interface CommitIdentity {
	name: string;
	email: string;
}

/**
 * `-c` args that pin an identity on one board git call (app.ts git-init, worktree.ts
 * rebase). `identity === null` keeps the built-in Ottr identity.
 */
export function identityArgs(identity: CommitIdentity | null): string[] {
	const id = identity ?? {
		name: DEFAULT_COMMIT_NAME,
		email: DEFAULT_COMMIT_EMAIL,
	};
	return ["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`];
}

export type ParsedField =
	| { ok: true; value: string | null | undefined }
	| { ok: false; error: string };

/** One git ident value: no control characters, no `<`/`>`, no line breaks, 1–100 chars. */
const OK_NAME = /^(?!.*[\p{Cc}<>])[\P{Cc}]{1,100}$/u;
/** One git email: one `@`, no whitespace or control characters, no `<`/`>`, 1–200 chars. */
const OK_EMAIL = /^(?=.{1,200}$)[^\p{Cc}\s@<>]+@[^\p{Cc}\s@<>]+$/u;

/**
 * Validates one Settings "Commit identity" field. `undefined` = not sent (keep the saved
 * value), `null` = reset to the built-in default. An invalid value returns its 400 text.
 */
export function parseCommitField(
	v: unknown,
	field: "commitName" | "commitEmail",
): ParsedField {
	if (v === undefined || v === null) return { ok: true, value: v as null };
	if (typeof v !== "string")
		return { ok: false, error: `${field} must be a string or null` };
	const t = v.trim();
	if (t === "") return { ok: true, value: null };
	const shape = field === "commitName" ? OK_NAME : OK_EMAIL;
	if (!shape.test(t))
		return {
			ok: false,
			error:
				field === "commitName"
					? "commitName must be 1-100 characters without control characters or < >"
					: "commitEmail must look like name@host without whitespace or control characters",
		};
	return { ok: true, value: t };
}

/**
 * The ident env for one turn: a var pair per probe field that git config leaves empty.
 * `probe.name`/`probe.email` say whether the turn's git already resolves that field.
 */
export function commitIdentityEnv(
	identity: CommitIdentity,
	probe: { name: boolean; email: boolean },
): Record<string, string> {
	const env: Record<string, string> = {};
	if (!probe.name) {
		env.GIT_AUTHOR_NAME = identity.name;
		env.GIT_COMMITTER_NAME = identity.name;
	}
	if (!probe.email) {
		env.GIT_AUTHOR_EMAIL = identity.email;
		env.GIT_COMMITTER_EMAIL = identity.email;
	}
	return env;
}

/**
 * Env names the turn's own env never carries (withoutGitAuth strips GIT_CONFIG_COUNT and
 * friends), so the probe must not let them steer its reads either. GIT_CONFIG_GLOBAL and
 * GIT_CONFIG_SYSTEM are NOT stripped: the turn's git honors them, so the probe must too.
 */
const PROBE_STRIP = /^(GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/;

export interface IdentProbeEnv {
	/** The turn's worktree: `git config` resolves repo-local config and includeIf rules here. */
	cwd: string;
	/** The HOME the turn's git sees (the layer pin moves it); null keeps the caller's. */
	home: string | null;
	/**
	 * The GIT_CONFIG_GLOBAL value the turn's git sees, or null when the dispatch strips it
	 * (a worker container mounts no board-config, so the pointer would name a missing file
	 * and hide the shared home's ~/.gitconfig).
	 */
	gitConfigGlobal: string | null;
	/**
	 * The env the turn inherits before the ident env. A GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL
	 * or GIT_COMMITTER_* value in it beats every config scope, so the probe reports that
	 * field as configured.
	 */
	baseEnv: Record<string, string | undefined>;
}

/**
 * What the turn's git resolves for the ident — the same cwd, the same global scope and
 * the same inherited env, so the ident env is set exactly when git would otherwise find
 * nothing. A spawn failure (git missing) counts as unset, so the default still applies.
 */
export function probeGitIdent(o: IdentProbeEnv): {
	name: boolean;
	email: boolean;
} {
	const get = (key: string): boolean => {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(o.baseEnv))
			if (v !== undefined && !PROBE_STRIP.test(k)) env[k] = v;
		if (o.home !== null) env.HOME = o.home;
		// The parameter is authoritative: it mirrors the pointer the turn's git sees,
		// whether the base env carries it (local dispatch) or the dispatch strips it.
		if (o.gitConfigGlobal === null) delete env.GIT_CONFIG_GLOBAL;
		else env.GIT_CONFIG_GLOBAL = o.gitConfigGlobal;
		try {
			const r = spawnSync("git", ["config", "--get", key], {
				cwd: o.cwd,
				env,
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
			return r.status === 0 && r.stdout.toString("utf8").trim() !== "";
		} catch {
			return false;
		}
	};
	const envNamed = (suffix: "NAME" | "EMAIL"): boolean =>
		o.baseEnv[`GIT_AUTHOR_${suffix}`] !== undefined ||
		o.baseEnv[`GIT_COMMITTER_${suffix}`] !== undefined;
	return {
		name: envNamed("NAME") || get("user.name"),
		email: envNamed("EMAIL") || get("user.email"),
	};
}

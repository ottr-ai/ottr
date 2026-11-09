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

/** Config-steering env names that must not reach the probe: it reads the turn's home files only. */
const PROBE_STRIP = /^(GIT_CONFIG|GIT_AUTHOR_|GIT_COMMITTER_)/;

/**
 * What git resolves for the ident from system + global config under `home` (repo-local
 * config stays out: the probe never runs inside a checkout). A spawn failure (git
 * missing) counts as unset, so the default still applies.
 */
export function probeGitIdent(home: string | null): {
	name: boolean;
	email: boolean;
} {
	const get = (key: string): boolean => {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env))
			if (v !== undefined && !PROBE_STRIP.test(k)) env[k] = v;
		if (home !== null) env.HOME = home;
		// Without a home the probe has no cwd it owns: read the global scope only.
		const args = [
			"config",
			...(home === null ? ["--global"] : []),
			"--get",
			key,
		];
		try {
			const r = spawnSync("git", args, {
				cwd: home ?? undefined,
				env,
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
			return r.status === 0 && r.stdout.toString("utf8").trim() !== "";
		} catch {
			return false;
		}
	};
	return { name: get("user.name"), email: get("user.email") };
}

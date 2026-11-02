// One GitHub host per board: OTTR_GITHUB_HOST (default github.com) and the values derived
// from it — the REST API base, the web base and the gh env. Every caller that builds a
// github.com URL or spawns gh reads them here, so the GitHub features follow the host:
// github.com unchanged, <tenant>.ghe.com is Enterprise Cloud with data residency (API at
// api.<host>), any other host is Enterprise Server (API at <host>/api/v3).

export const GITHUB_HOST_ENV = "OTTR_GITHUB_HOST";
export const DEFAULT_GITHUB_HOST = "github.com";

export type GithubHost = {
	/** Lowercase host without scheme, path or port, for example acme.ghe.com. */
	host: string;
	/** True only for github.com: those calls keep their github.com shape and GH_TOKEN. */
	isDefault: boolean;
	/** REST API base without a trailing slash, for example https://api.acme.ghe.com. */
	apiBase: string;
	/** Web base without a trailing slash, for example https://acme.ghe.com. */
	webBase: string;
};

// One label: never empty, never starts or ends with a hyphen. The dots are split off first.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The trust boundary for the host setting: total, never throws, one shared error. A scheme,
 * path, port, whitespace, userinfo, query or fragment cannot survive the charset check, so a
 * derived URL can never leave the configured host.
 */
export function parseGithubHost(raw: unknown): GithubHost | { error: string } {
	const error = (why: string): { error: string } => ({
		error: `${GITHUB_HOST_ENV}: ${why} (use a bare hostname, for example ${DEFAULT_GITHUB_HOST} or acme.ghe.com)`,
	});
	if (typeof raw !== "string") return error("must be a string");
	if (raw === "") return error("must not be empty");
	if (/[^a-zA-Z0-9.-]/.test(raw))
		return error("must hold only letters, digits, dots and hyphens");
	if (raw.length > 253) return error("is longer than 253 characters");
	const host = raw.toLowerCase();
	if (!host.split(".").every((label) => LABEL_RE.test(label)))
		return error("has an empty or misplaced label");
	const isDefault = host === DEFAULT_GITHUB_HOST;
	// A *.ghe.com tenant serves its REST API on its own api.<host> name; Enterprise Server
	// keeps the classic /api/v3 path.
	const apiBase = isDefault
		? `https://api.${DEFAULT_GITHUB_HOST}`
		: host.endsWith(".ghe.com")
			? `https://api.${host}`
			: `https://${host}/api/v3`;
	return { host, isDefault, apiBase, webBase: `https://${host}` };
}

function defaultHost(): GithubHost {
	const parsed = parseGithubHost(DEFAULT_GITHUB_HOST);
	if ("error" in parsed) throw new Error(parsed.error); // unreachable: a constant
	return parsed;
}

/** The host of the running board: the default when the setting is unset or empty. */
export function githubHost(
	env: Record<string, string | undefined> = process.env,
): GithubHost {
	const raw = env[GITHUB_HOST_ENV];
	if (raw === undefined || raw.trim() === "") return defaultHost();
	const parsed = parseGithubHost(raw);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
}

/**
 * Env additions for one gh call. On the default host the token stays the inherited GH_TOKEN
 * (no names added when there is none, so ambient gh auth keeps working). On another host
 * GH_TOKEN only authenticates github.com: gh needs GH_HOST plus GH_ENTERPRISE_TOKEN.
 */
export function ghEnvFor(
	h: GithubHost,
	token: string | undefined,
): Record<string, string> {
	if (h.isDefault) return token ? { GH_TOKEN: token } : {};
	return token
		? { GH_HOST: h.host, GH_ENTERPRISE_TOKEN: token }
		: { GH_HOST: h.host };
}

/**
 * Case-insensitive matcher for the configured host at a URL authority boundary. The
 * lookbehind keeps a suffix from matching ("ghe.com" inside "acme.ghe.com"), so only a
 * remote on the host itself counts.
 */
export function hostMatcher(host: string): RegExp {
	const esc = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w.-])${esc}[:/]`, "i");
}

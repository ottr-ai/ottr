// When a git clone/fetch/push against a GitHub host fails with HTTP 401/403, git prints
// only the bare status. GitHub's REST API names the real cause (SAML enforcement, an IP
// allow list, a token policy) on the same repository with the same token, so this probe
// appends that message one line under git's error. It never prints the token, and every
// failure path returns null: the git error then stands alone.
import { type GitToken, parseGitUrl, redact } from "./gitHosts.ts";
import { isGithubRepoHost, parseGithubHost } from "./githubHost.ts";

/** git's stderr/response marker for an HTTP 401/403 from the remote ("... returned error: 403"). */
export const GIT_HTTP_AUTH_STATUS = / 401| 403/;

export type GithubAuthHintOpts = {
	/** The board's configured GitHub host (githubHost().host). */
	configuredHost: string;
	tokens: readonly GitToken[];
	/** GH_TOKEN when set; counts only for the configured host (mirror of pushAuthKind in gitHosts.ts). */
	envToken: string | null;
	/** Redaction list for the message; must hold every secret the message could echo. */
	secrets: readonly string[];
	/** Fetch seam; default fetch. Tests inject. */
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Probe ceiling in ms; default 5000. */
	timeoutMs?: number;
};

export async function githubAuthHint(
	url: string,
	o: GithubAuthHintOpts,
): Promise<string | null> {
	try {
		const remote = parseGitUrl(url);
		if ("error" in remote || remote.scheme !== "https") return null;
		if (!isGithubRepoHost(remote.host, o.configuredHost)) return null;
		// Repo path: everything after the authority, one trailing "/" or ".git" stripped;
		// exactly owner/repo, nothing else (a three-segment path is not a REST repo).
		const at = url.indexOf("/", "https://".length);
		if (at === -1) return null;
		const path = url
			.slice(at + 1)
			.replace(/\/$/, "")
			.replace(/\.git$/, "");
		const segments = path.split("/").filter((s) => s !== "");
		if (segments.length !== 2) return null;
		const [owner, repo] = segments;
		const token =
			o.tokens.find((t) => t.host === remote.hostKey)?.token ??
			(remote.host === o.configuredHost ? o.envToken : null);
		if (token === null || token === "") return null;
		const parsed = parseGithubHost(remote.host);
		if ("error" in parsed) return null;
		const ac = new AbortController();
		// The ceiling must hold even when a transport ignores the abort signal, so the
		// await races the fetch against the timer; the loser's late rejection is already
		// answered — swallow it.
		const gate = Promise.withResolvers<never>();
		const pending = (o.fetchImpl ?? fetch)(
			`${parsed.apiBase}/repos/${owner}/${repo}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"User-Agent": "ottr",
				},
				signal: ac.signal,
			},
		);
		void pending.catch(() => {});
		const timer = setTimeout(() => {
			ac.abort();
			gate.reject(new Error("github api probe timed out"));
		}, o.timeoutMs ?? 5000);
		let res: Response;
		try {
			res = await Promise.race([pending, gate.promise]);
		} finally {
			clearTimeout(timer);
		}
		if (res.status !== 401 && res.status !== 403) return null;
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			return null;
		}
		if (typeof body !== "object" || body === null) return null;
		const message =
			"message" in body && typeof body.message === "string"
				? body.message.trim()
				: "";
		if (message === "") return null;
		const docs =
			"documentation_url" in body && typeof body.documentation_url === "string"
				? body.documentation_url.trim()
				: "";
		let out = `\nGitHub: ${redact(message.slice(0, 300), o.secrets)}`;
		if (docs !== "") out += `\nDocs: ${docs}`;
		return out;
	} catch {
		return null;
	}
}

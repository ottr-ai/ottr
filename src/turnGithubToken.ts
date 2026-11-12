// One read-only GitHub token per host, checked before the board serves it to turns.
// checkTurnToken() asks GET /repos/<owner>/<repo> once per distinct project repo on the
// host and reads the two write signals the GitHub API offers: `permissions.push` in the
// body (fine-grained tokens, which send no scopes header) and the `x-oauth-scopes`
// response header (classic tokens, where any scope outside the read-only set grants
// write). The check fails closed: an unknown scope counts write-capable, a rejected or
// unreachable check counts as error, and any error outranks every write signal.

const READ_ONLY_SCOPE = /^(read:|user(:|$)|gist|notifications)/;

/** What the board does with the token: serve it to turns, warn and wait, or hold it back. */
export type TurnTokenVerdict = "ok" | "write" | "error";

/** One check result: the verdict and its short human-readable reason. */
export interface TurnTokenCheck {
	verdict: TurnTokenVerdict;
	/** Short human-readable reason; never contains the token. */
	detail: string;
}

/** The signal one repo's response contributes to the whole check. */
type RepoSignal =
	| { kind: "write"; detail: string }
	| { kind: "error"; detail: string }
	| { kind: "none" };

/**
 * The write-capable scopes of one x-oauth-scopes value, or an empty list. A scope counts
 * read-only only in the read-only set; every other name, known or unknown, grants write
 * somewhere, so it counts write-capable (fail closed).
 */
function writeScopes(header: string | null): string[] {
	if (header === null || header === "") return [];
	return header
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "" && !READ_ONLY_SCOPE.test(s));
}

/** One GET /repos/<owner>/<repo>: classify the response into one signal. */
async function checkRepo(
	fetchFn: typeof fetch,
	url: string,
	repo: string,
	token: string,
): Promise<RepoSignal> {
	let res: Response;
	try {
		// Headers: bearer auth plus the pinned REST API version.
		res = await fetchFn(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (e) {
		return {
			kind: "error",
			detail: `${repo}: request failed (${e instanceof Error ? e.message : String(e)})`,
		};
	}
	if (res.status === 401 || res.status === 403) {
		return {
			kind: "error",
			detail: `${repo}: token rejected (HTTP ${res.status})`,
		};
	}
	// The token cannot read the repo: it proves nothing about write access either.
	if (res.status === 404) return { kind: "none" };
	if (res.status !== 200) {
		return { kind: "error", detail: `${repo}: unexpected HTTP ${res.status}` };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: "error", detail: `${repo}: malformed response body` };
	}
	const push =
		(body as { permissions?: { push?: unknown } } | null)?.permissions?.push ===
		true;
	const bad = writeScopes(res.headers.get("x-oauth-scopes"));
	if (push) {
		return { kind: "write", detail: `${repo}: token has push permission` };
	}
	if (bad.length > 0) {
		return {
			kind: "write",
			detail: `${repo}: write-capable scopes (${bad.join(", ")})`,
		};
	}
	return { kind: "none" };
}

/**
 * The read-only verdict for one token against the project repos of its host. One GET per
 * distinct repo, in first-seen order; the whole check answers error when any repo errored,
 * else write when any repo showed a write signal, else ok. The token never appears in the
 * detail.
 */
export async function checkTurnToken(o: {
	apiBase: string;
	token: string;
	repos: readonly string[]; // "owner/repo"
	fetch?: typeof fetch;
}): Promise<TurnTokenCheck> {
	const fetchFn = o.fetch ?? fetch;
	const repos = [...new Set(o.repos)];
	if (repos.length === 0) {
		return { verdict: "ok", detail: "no project repositories on this host" };
	}
	let error: string | undefined;
	let write: string | undefined;
	for (const repo of repos) {
		const sig = await checkRepo(
			fetchFn,
			`${o.apiBase}/repos/${repo}`,
			repo,
			o.token,
		);
		if (sig.kind === "error") error ??= sig.detail;
		else if (sig.kind === "write") write ??= sig.detail;
	}
	if (error !== undefined) return { verdict: "error", detail: error };
	if (write !== undefined) return { verdict: "write", detail: write };
	const n = repos.length;
	return {
		verdict: "ok",
		detail: `read-only across ${n} repositor${n === 1 ? "y" : "ies"}`,
	};
}

// OTTR-675: where a project's GitHub remote resolves (add, init, settings save), the board
// probes GET <apiBase>/repos/{o}/{r}/rules/branches/{branch} with the board's GitHub token
// for that host. A pull_request rule on the target branch is the fact PR mode exists for
// (ADR 0008): merge turns would fail on push. The probe is advisory only — every failure
// reports { ok: false } and the board shows nothing.

import { withGithubRetry } from "./githubRetry.ts";

/** True when `body` — a `GET /repos/{o}/{r}/rules/branches/{branch}` response body — holds
 * a rule whose `type` is "pull_request". Untrusted JSON: false on anything else, never
 * throws. */
export function hasPullRequestRule(body: unknown): boolean {
	if (!Array.isArray(body)) return false;
	return body.some((rule) => {
		if (typeof rule !== "object" || rule === null || !("type" in rule))
			return false;
		return rule.type === "pull_request";
	});
}

/** The lookup's total result: `ok: false` on any failure (non-200, timeout, unreadable
 * body, transport throw) — the caller never surfaces a probe error. */
export type BranchRuleLookup =
	| { ok: true; pullRequest: boolean }
	| { ok: false };

export interface BranchRulesOpts {
	/** The REST API base of the remote's GitHub host (githubHost().apiBase shape). */
	apiBase: string;
	owner: string;
	repo: string;
	/** The branch name without its origin/ prefix. */
	branch: string;
	token: string;
	/** Fetch seam; default fetch. Tests inject. */
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Probe ceiling in ms; default 5000. */
	timeoutMs?: number;
}

/** The rules of the target branch, with the token. Total: `{ ok: false }` on every failure
 * path, so the caller needs no error handling. */
export async function lookupBranchRules(
	o: BranchRulesOpts,
): Promise<BranchRuleLookup> {
	try {
		const ac = new AbortController();
		// The ceiling must hold even when a transport ignores the abort signal, so the
		// await races the fetch against the timer; the loser's late rejection is already
		// answered — swallow it.
		const gate = Promise.withResolvers<never>();
		const pending = withGithubRetry(o.fetchImpl ?? fetch)(
			`${o.apiBase}/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}/rules/branches/${encodeURIComponent(o.branch)}`,
			{
				headers: {
					Authorization: `Bearer ${o.token}`,
					Accept: "application/vnd.github+json",
					"User-Agent": "ottr",
				},
				signal: ac.signal,
			},
		);
		void pending.catch(() => {});
		const timer = setTimeout(() => {
			ac.abort();
			gate.reject(new Error("branch rules probe timed out"));
		}, o.timeoutMs ?? 5000);
		let res: Response;
		try {
			res = await Promise.race([pending, gate.promise]);
		} finally {
			clearTimeout(timer);
		}
		if (res.status !== 200) return { ok: false };
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			return { ok: false };
		}
		return { ok: true, pullRequest: hasPullRequestRule(body) };
	} catch {
		return { ok: false };
	}
}

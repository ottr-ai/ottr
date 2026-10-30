// Alate's file editor API and the GitHub commit path for the data repo's omp config.yml.
import type { GhFn } from "./forks.ts";

type Alate = { url: string | null; key: string | null };

/**
 * Fetch that never follows a redirect: fetch keeps the Authorization header on a
 * redirect chain, so a redirecting endpoint could bounce the bearer off-host.
 * A 3xx answer is an error with a clear message, never a hop.
 */
export async function noRedirectFetch(
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const res = await fetch(url, { ...init, redirect: "manual" });
	if (res.status >= 300 && res.status < 400)
		throw new Error(`${url} answered ${res.status} (redirect not followed)`);
	return res;
}

/** GET <alate.url>/health shared by the proxy route and the U9 trigger. */
export async function alateHealth(
	alate: Alate,
): Promise<
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; status: number; error: string }
> {
	if (alate.url === null)
		return {
			ok: false,
			status: 400,
			error: "alate server url is not configured",
		};
	let res: Response;
	try {
		res = await fetch(alate.url + "/health", {
			signal: AbortSignal.timeout(5000),
		});
	} catch (err) {
		return {
			ok: false,
			status: 502,
			error: `cannot reach alate server: ${(err as Error).message}`,
		};
	}
	const body = (await res.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!res.ok) {
		const msg =
			typeof body?.error === "string"
				? body.error
				: `alate returned ${res.status}`;
		return { ok: false, status: res.status, error: msg };
	}
	if (body === null || typeof body !== "object")
		return {
			ok: false,
			status: 502,
			error: "alate returned an invalid health response",
		};
	return { ok: true, body };
}

export type AlateOut<T> =
	| { ok: true; body: T }
	| { ok: false; status: number; error: string };
/** One bearer call to alate's file editor API. 404 and 409 keep their status; any other
 *  alate failure is 502 (docs/specs/model-roles-editor.md). */
export async function alateApi(
	alate: Alate,
	path: string,
	timeoutMs: number,
	init: { method: string; body: unknown } | null = null,
): Promise<AlateOut<Record<string, unknown>>> {
	if (alate.url === null)
		return {
			ok: false,
			status: 400,
			error: "alate server url is not configured",
		};
	if (alate.key === null)
		return {
			ok: false,
			status: 400,
			error: "alate api key is not configured",
		};
	let res: Response;
	try {
		res = await noRedirectFetch(alate.url + path, {
			method: init?.method ?? "GET",
			headers: {
				authorization: "Bearer " + alate.key,
				...(init ? { "content-type": "application/json" } : {}),
			},
			...(init ? { body: JSON.stringify(init.body) } : {}),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		// A timed-out write may still land on alate: say so instead of "cannot reach".
		if ((err as Error).name === "TimeoutError")
			return {
				ok: false,
				status: 504,
				error: `alate did not answer ${path.split("?")[0]} within ${timeoutMs / 1000} s`,
			};
		return {
			ok: false,
			status: 502,
			error: `cannot reach alate server: ${(err as Error).message}`,
		};
	}
	const body = (await res.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!res.ok)
		return {
			ok: false,
			status: res.status === 404 || res.status === 409 ? res.status : 502,
			error:
				typeof body?.error === "string"
					? body.error
					: `alate returned ${res.status}`,
		};
	if (body === null || typeof body !== "object")
		return {
			ok: false,
			status: 502,
			error: "alate returned an invalid response",
		};
	return { ok: true, body };
}
export const CONFIG_YML = "user/omp/agent/config.yml";
// Alate's source fields reach gh api paths: only plain names, hex commits and safe branches.
// GitHub owners hold no dots, and a repo is never "." or "..": no segment can climb the path.
const REPO_NAME = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]+$/;
/** The data repo's omp config.yml from alate's last import. */
export async function readConfigYml(
	alate: Alate,
): Promise<AlateOut<{ content: string; hash: string }>> {
	const r = await alateApi(
		alate,
		`/api/file?path=${encodeURIComponent(CONFIG_YML)}`,
		10_000,
	);
	if (!r.ok) return r;
	const { content, hash } = r.body;
	if (typeof hash !== "string")
		return {
			ok: false,
			status: 502,
			error: "alate returned an invalid file response",
		};
	if (typeof content !== "string")
		return {
			ok: false,
			status: 422,
			error: `${CONFIG_YML} in the data repo is not UTF-8 text`,
		};
	return { ok: true, body: { content, hash } };
}
/** Re-imports alate's current data source, so its snapshot sits on the repo head. */
export async function refreshAlateSnapshot(
	alate: Alate,
): Promise<AlateOut<Record<string, unknown>>> {
	const h = await alateHealth(alate);
	if (!h.ok) return h;
	const kind =
		typeof h.body.repo === "string" && h.body.repo !== ""
			? "repo"
			: typeof h.body.path === "string" && h.body.path !== ""
				? "path"
				: null;
	if (kind === null)
		return { ok: false, status: 502, error: "alate has no data source" };
	return alateApi(alate, "/api/import", 110_000, {
		method: "POST",
		body: { source: h.body[kind], kind },
	});
}
/** config.yml plus `base`, the data repo commit of alate's snapshot, and `repo`, its GitHub
 *  source (both null for a path source). `refresh` re-imports first, so `base` is the head. */
export async function loadConfigYml(
	alate: Alate,
	refresh: boolean,
): Promise<
	AlateOut<{
		content: string;
		hash: string;
		base: string | null;
		repo: { name: string; ref: string } | null;
	}>
> {
	const s = refresh
		? await refreshAlateSnapshot(alate)
		: await alateApi(alate, "/api/state", 10_000);
	if (!s.ok) return s;
	const src = (
		(refresh ? s.body.state : s.body) as {
			source?: Record<string, unknown>;
		} | null
	)?.source;
	const sha = src?.importedSha;
	const base = typeof sha === "string" && SHA.test(sha) ? sha : null;
	const repo =
		src?.kind === "repo" &&
		typeof src.name === "string" &&
		REPO_NAME.test(src.name)
			? { name: src.name, ref: typeof src.ref === "string" ? src.ref : "" }
			: null;
	const f = await readConfigYml(alate);
	if (!f.ok) return f;
	return { ok: true, body: { ...f.body, base, repo } };
}
/** One `gh api` call with the board's GitHub token: the parsed JSON body or the error.
 *  GitHub's "not a fast forward" maps to 409. */
export async function ghApi(
	gh: GhFn,
	args: string[],
): Promise<AlateOut<Record<string, unknown>>> {
	let r: { code: number; stdout: string; stderr: string };
	try {
		r = await gh(["api", ...args]);
	} catch (err) {
		return { ok: false, status: 502, error: (err as Error).message };
	}
	let body: unknown = null;
	try {
		body = JSON.parse(r.stdout);
	} catch {
		// gh prints nothing on some failures; the stderr below names them.
	}
	if (r.code !== 0) {
		const msg = (body as { message?: unknown } | null)?.message;
		const text =
			typeof msg === "string" ? msg : r.stderr.trim() || `gh exited ${r.code}`;
		return {
			ok: false,
			status: /not a fast.forward/i.test(`${text} ${r.stderr}`) ? 409 : 502,
			error: `GitHub: ${text}`,
		};
	}
	return body !== null && typeof body === "object"
		? { ok: true, body: body as Record<string, unknown> }
		: {
				ok: false,
				status: 502,
				error: "GitHub returned an invalid response",
			};
}
/** Commits config.yml with `base` as its parent and moves the branch only as a fast-forward
 *  (`force: false`): a branch that moved since `base` gives 409, never a force push. */
export async function commitConfigYml(
	gh: GhFn,
	repo: { name: string; ref: string },
	base: string,
	content: string,
	message: string,
): Promise<AlateOut<{ commit: string }>> {
	const bad = {
		ok: false,
		status: 502,
		error: "GitHub returned an invalid response",
	} as const;
	let branch = repo.ref;
	if (branch === "") {
		const info = await ghApi(gh, [`repos/${repo.name}`]);
		if (!info.ok) return info;
		branch =
			typeof info.body.default_branch === "string"
				? info.body.default_branch
				: "";
	}
	if (!BRANCH.test(branch))
		return {
			ok: false,
			status: 502,
			error: `invalid data repo branch: ${branch.slice(0, 100)}`,
		};
	const parent = await ghApi(gh, [`repos/${repo.name}/git/commits/${base}`]);
	if (!parent.ok) return parent;
	const baseTree = (parent.body.tree as { sha?: unknown } | undefined)?.sha;
	if (typeof baseTree !== "string") return bad;
	// ponytail: the content rides one argv string (Linux caps it at 128 KiB); config.yml is ~2 KiB.
	const tree = await ghApi(gh, [
		"-X",
		"POST",
		`repos/${repo.name}/git/trees`,
		"-f",
		`base_tree=${baseTree}`,
		"-f",
		`tree[][path]=${CONFIG_YML}`,
		"-f",
		"tree[][mode]=100644",
		"-f",
		"tree[][type]=blob",
		"-f",
		`tree[][content]=${content}`,
	]);
	if (!tree.ok) return tree;
	if (typeof tree.body.sha !== "string") return bad;
	const commit = await ghApi(gh, [
		"-X",
		"POST",
		`repos/${repo.name}/git/commits`,
		"-f",
		`message=${message}`,
		"-f",
		`tree=${tree.body.sha}`,
		"-f",
		`parents[]=${base}`,
	]);
	if (!commit.ok) return commit;
	if (typeof commit.body.sha !== "string") return bad;
	const ref = await ghApi(gh, [
		"-X",
		"PATCH",
		`repos/${repo.name}/git/refs/heads/${branch}`,
		"-f",
		`sha=${commit.body.sha}`,
		"-F",
		"force=false",
	]);
	if (!ref.ok) return ref;
	return { ok: true, body: { commit: commit.body.sha } };
}

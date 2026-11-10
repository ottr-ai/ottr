// Jira import routes (docs/specs/jira-import.md): board-level connections, the project search
// and the import. createApp mounts these handlers through api(); this module only answers.

import type { GlobalStore } from "./globalStore.ts";
import {
	assertAllowedHost,
	detectType,
	type JiraConn,
	JiraError,
	type JiraNet,
	normalizeSiteUrl,
	searchIssues,
	testConnection,
} from "./jira.ts";
import { type JiraIssue, jiraCardPrompt, jiraCardTitle } from "./jiraCards.ts";
import type { SecretBox } from "./secretBox.ts";
import type { ProjectStore } from "./store.ts";
import type {
	JiraConnectionView,
	JiraImportResult,
	JiraRow,
	JiraSearchResult,
	JiraType,
} from "./types.ts";

/** GlobalStore key of the connection list; tokens inside are sealed by the SecretBox. */
export const JIRA_CONNECTIONS_KEY = "jira-connections";

interface StoredConnection {
	name: string;
	site: string;
	type: JiraType;
	email: string | null;
	customFields: string[];
	/** Sealed with the board's SecretBox; null = no token yet. */
	token: string | null;
}

export interface JiraRouteDeps {
	gstore: GlobalStore;
	projects: Map<string, { store: ProjectStore }>;
	/** Undefined when the key failed to load at boot: every Jira route answers 503. */
	box: SecretBox | undefined;
	net: JiraNet;
	schedule: () => void;
	now: () => number;
	json: (v: unknown, status?: number) => Response;
}

const NAME = /^[A-Za-z0-9 _.-]{1,100}$/;
const CUSTOM_FIELD = /^customfield_\d+$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const MAX_CUSTOM_FIELDS = 20;
const MAX_TOKEN = 4000;
const MAX_EMAIL = 254;
const MAX_JQL = 2000;
/** Keys per `key in (...)` query, and the page size of each. */
const IMPORT_CHUNK = 50;

const TOKEN_UNREADABLE = "token unreadable, enter it again";

function isStored(v: unknown): v is StoredConnection {
	if (typeof v !== "object" || v === null) return false;
	const c = v as Record<string, unknown>;
	return (
		typeof c.name === "string" &&
		typeof c.site === "string" &&
		(c.type === "cloud" || c.type === "datacenter") &&
		(c.email === null || typeof c.email === "string") &&
		Array.isArray(c.customFields) &&
		c.customFields.every((f) => typeof f === "string") &&
		(c.token === null || typeof c.token === "string")
	);
}

/** A connection body with the plain token ("" = keep the stored one). */
type ConnectionFields = Omit<StoredConnection, "token"> & { token: string };

/** Cloud's email; Data Center keeps none. */
function parseEmail(
	type: JiraType,
	v: unknown,
): string | null | { error: string } {
	if (type === "datacenter") return null;
	const raw = typeof v === "string" ? v.trim() : "";
	return raw === "" || raw.length > MAX_EMAIL || /[\p{Cc}\s]/u.test(raw)
		? { error: "a Cloud connection needs an email" }
		: raw;
}

function parseCustomFields(v: unknown): string[] | null {
	const fields = v ?? [];
	if (
		!Array.isArray(fields) ||
		fields.length > MAX_CUSTOM_FIELDS ||
		fields.some((f) => typeof f !== "string" || !CUSTOM_FIELD.test(f))
	)
		return null;
	return [...new Set(fields as string[])];
}

/** Every connection body field checked; a string is the 400 message of the first bad one. */
function parseConnection(
	body: Record<string, unknown>,
): ConnectionFields | string {
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!NAME.test(name))
		return "name must be 1-100 characters: letters, digits, space, _ . or -";
	if (typeof body.site !== "string") return "site must be a string";
	const site = normalizeSiteUrl(body.site);
	if ("error" in site) return site.error;
	const type = body.type;
	if (type !== "cloud" && type !== "datacenter")
		return 'type must be "cloud" or "datacenter"';
	const email = parseEmail(type, body.email);
	if (typeof email === "object" && email !== null) return email.error;
	const customFields = parseCustomFields(body.customFields);
	if (customFields === null)
		return `customFields must be at most ${MAX_CUSTOM_FIELDS} ids like customfield_10042`;
	const token = body.token ?? "";
	if (typeof token !== "string" || token.length > MAX_TOKEN)
		return `token must be a string of at most ${MAX_TOKEN} characters`;
	return {
		name,
		site: site.site,
		type,
		email,
		customFields,
		token: token.trim(),
	};
}

/** The search body; a string is the 400 message. */
function parseSearch(
	body: Record<string, unknown>,
): { jql: string; cursor: string | null } | string {
	const jql = typeof body.jql === "string" ? body.jql.trim() : "";
	if (jql === "" || jql.length > MAX_JQL)
		return `jql must be a non-empty string of at most ${MAX_JQL} characters`;
	const cursor = body.cursor ?? null;
	if (cursor === null) return { jql, cursor };
	return typeof cursor === "string" && cursor !== "" && cursor.length <= MAX_JQL
		? { jql, cursor }
		: "cursor must be a string or null";
}

export function createJiraRoutes(d: JiraRouteDeps) {
	const { json } = d;

	function load(): StoredConnection[] {
		const raw = d.gstore.get<unknown>(JIRA_CONNECTIONS_KEY);
		return Array.isArray(raw) ? raw.filter(isStored) : [];
	}

	function usedBy(name: string): string[] {
		const out: string[] = [];
		for (const [project, e] of d.projects)
			if (e.store.getSettings().jiraConnection === name) out.push(project);
		return out.sort();
	}

	function view(c: StoredConnection, box: SecretBox): JiraConnectionView {
		return {
			name: c.name,
			site: c.site,
			type: c.type,
			email: c.email,
			customFields: c.customFields,
			tokenSet: c.token !== null,
			tokenReadable: c.token !== null && box.open(c.token) !== null,
			usedBy: usedBy(c.name),
		};
	}

	function noBox(): Response {
		return json({ error: "OTTR_SECRET_KEY is invalid" }, 503);
	}

	/** The connection with its token opened, or the refusal (404 unknown, 409 unreadable). */
	function openConnection(name: string, box: SecretBox): JiraConn | Response {
		const c = load().find((x) => x.name === name);
		if (c === undefined)
			return json({ error: `unknown Jira connection: ${name}` }, 404);
		const token = c.token === null ? null : box.open(c.token);
		if (token === null) return json({ error: TOKEN_UNREADABLE }, 409);
		return {
			site: c.site,
			type: c.type,
			email: c.email,
			token,
			customFields: c.customFields,
		};
	}

	/** A Jira failure as the contract's status; other errors go on to api()'s 500. */
	function jiraFailure(label: string, err: unknown): Response {
		if (!(err instanceof JiraError)) throw err;
		console.warn(`jira: ${label}: ${err.message}`);
		if (err.kind === "jql") return json({ error: err.message }, 400);
		if (err.kind === "auth")
			return json({ error: "check the connection's credentials" }, 502);
		return json({ error: err.message }, 502);
	}

	/** The project's connection for search and import, or the refusal. */
	function projectConnection(
		project: string,
		box: SecretBox,
	): { store: ProjectStore; conn: JiraConn } | Response {
		const e = d.projects.get(project);
		if (e === undefined) return json({ error: "unknown project" }, 404);
		const name = e.store.getSettings().jiraConnection;
		if (name === null)
			return json({ error: "no Jira connection for this project" }, 409);
		const conn = openConnection(name, box);
		if (conn instanceof Response)
			return conn.status === 404
				? json({ error: `Jira connection "${name}" no longer exists` }, 409)
				: conn;
		return { store: e.store, conn };
	}

	/** The site check hosted mode runs at save; null = allowed. */
	async function hostRefusal(site: string): Promise<Response | null> {
		try {
			await assertAllowedHost(site, d.net);
			return null;
		} catch (err) {
			if (!(err instanceof JiraError)) throw err;
			return json({ error: err.message }, 400);
		}
	}

	async function list(): Promise<Response> {
		const box = d.box;
		if (box === undefined) return noBox();
		return json(load().map((c) => view(c, box)));
	}

	/** Upsert by name (renames are a new connection); an empty token keeps the stored one. */
	async function save(body: Record<string, unknown>): Promise<Response> {
		const box = d.box;
		if (box === undefined) return noBox();
		const f = parseConnection(body);
		if (typeof f === "string") return json({ error: f }, 400);
		const refused = await hostRefusal(f.site);
		if (refused !== null) return refused;
		// Load after the await: a save that raced this one must not be lost.
		const all = load();
		const old = all.find((c) => c.name === f.name);
		const token = f.token !== "" ? box.seal(f.token) : (old?.token ?? null);
		if (token === null)
			return json({ error: "a new connection needs a token" }, 400);
		const next: StoredConnection = { ...f, token };
		d.gstore.set(
			JIRA_CONNECTIONS_KEY,
			old === undefined
				? [...all, next]
				: all.map((c) => (c === old ? next : c)),
		);
		return json(view(next, box));
	}

	async function remove(name: string): Promise<Response> {
		if (d.box === undefined) return noBox();
		const all = load();
		if (!all.some((c) => c.name === name))
			return json({ error: `unknown Jira connection: ${name}` }, 404);
		const users = usedBy(name);
		if (users.length > 0)
			return json(
				{ error: `in use by: ${users.join(", ")}`, projects: users },
				409,
			);
		d.gstore.set(
			JIRA_CONNECTIONS_KEY,
			all.filter((c) => c.name !== name),
		);
		return json({ ok: true });
	}

	async function detect(body: Record<string, unknown>): Promise<Response> {
		if (d.box === undefined) return noBox();
		if (typeof body.site !== "string")
			return json({ error: "site must be a string" }, 400);
		const site = normalizeSiteUrl(body.site);
		if ("error" in site) return json({ error: site.error }, 400);
		return json(await detectType(site.site, d.net));
	}

	async function test(name: string): Promise<Response> {
		const box = d.box;
		if (box === undefined) return noBox();
		const conn = openConnection(name, box);
		if (conn instanceof Response) return conn;
		try {
			return json(await testConnection(conn, d.net));
		} catch (err) {
			return jiraFailure(name, err);
		}
	}

	async function search(
		project: string,
		body: Record<string, unknown>,
	): Promise<Response> {
		const box = d.box;
		if (box === undefined) return noBox();
		const q = parseSearch(body);
		if (typeof q === "string") return json({ error: q }, 400);
		const { jql, cursor } = q;
		const p = projectConnection(project, box);
		if (p instanceof Response) return p;
		const page = await searchIssues(p.conn, jql, cursor, d.net).catch((err) =>
			jiraFailure(project, err),
		);
		if (page instanceof Response) return page;
		const imported = p.store.jiraImported(
			p.conn.site,
			page.issues.map((i) => i.key),
		);
		const rows: JiraRow[] = page.issues.map((i) => ({
			key: i.key,
			url: `${p.conn.site}/browse/${i.key}`,
			summary: i.summary,
			issueType: i.issueType,
			status: i.status,
			priority: i.priority,
			importedCard: imported.get(i.key) ?? null,
		}));
		p.store.setSettings({ jiraLastJql: jql });
		return json({
			rows,
			next: page.next,
			total: page.total,
		} satisfies JiraSearchResult);
	}

	/**
	 * Every issue Jira returns for keys, fetched with full fields in chunks of IMPORT_CHUNK.
	 * Jira rejects a whole `key in (...)` query when one key is gone or hidden, so a chunk
	 * that fails with a JQL error is retried one key at a time; keys that still fail are left out.
	 */
	async function fetchIssues(
		conn: JiraConn,
		keys: string[],
	): Promise<Map<string, JiraIssue>> {
		const found = new Map<string, JiraIssue>();
		const fetchAll = async (jql: string): Promise<void> => {
			let cursor: string | null = null;
			do {
				const page = await searchIssues(conn, jql, cursor, d.net, {
					full: true,
					pageSize: IMPORT_CHUNK,
				});
				for (const issue of page.issues) found.set(issue.key, issue);
				cursor = page.next;
			} while (cursor !== null);
		};
		for (let i = 0; i < keys.length; i += IMPORT_CHUNK) {
			const chunk = keys.slice(i, i + IMPORT_CHUNK);
			try {
				await fetchAll(`key in (${chunk.join(",")})`);
			} catch (err) {
				if (!(err instanceof JiraError && err.kind === "jql")) throw err;
				for (const key of chunk) {
					await fetchAll(`key = ${key}`).catch((e) => {
						if (!(e instanceof JiraError && e.kind === "jql")) throw e;
					});
				}
			}
		}
		return found;
	}

	async function importIssues(
		project: string,
		body: Record<string, unknown>,
	): Promise<Response> {
		const box = d.box;
		if (box === undefined) return noBox();
		const raw = body.keys;
		if (
			!Array.isArray(raw) ||
			raw.length === 0 ||
			raw.some((k) => typeof k !== "string" || !ISSUE_KEY.test(k))
		)
			return json(
				{ error: "keys must be one or more Jira issue keys like PROJ-123" },
				400,
			);
		const stage = body.stage;
		if (stage !== "backlog" && stage !== "todo")
			return json({ error: 'stage must be "backlog" or "todo"' }, 400);
		const p = projectConnection(project, box);
		if (p instanceof Response) return p;
		const keys = [...new Set(raw as string[])];
		const issues = await fetchIssues(p.conn, keys).catch((err) =>
			jiraFailure(project, err),
		);
		if (issues instanceof Response) return issues;
		const missing = keys.filter((k) => !issues.has(k));
		const items = keys.flatMap((k) => {
			const issue = issues.get(k);
			return issue === undefined
				? []
				: [
						{
							key: k,
							title: jiraCardTitle(k, issue.summary),
							prompt: jiraCardPrompt(p.conn.site, issue),
						},
					];
		});
		// The store re-checks inside its transaction: a parallel import of one key files one card.
		const filed = p.store.fileJiraCards({
			site: p.conn.site,
			stage,
			items,
			now: d.now(),
		});
		if (stage === "todo" && filed.filed.length > 0) d.schedule();
		return json({
			filed: filed.filed.map((t) => t.id),
			skipped: filed.skipped,
			unavailable: missing,
		} satisfies JiraImportResult);
	}

	/** Settings POST: a jiraConnection string must name a stored connection. */
	function settingsRefusal(name: string | null | undefined): Response | null {
		if (typeof name !== "string") return null;
		return load().some((c) => c.name === name)
			? null
			: json({ error: "unknown Jira connection" }, 400);
	}

	return {
		list,
		save,
		remove,
		detect,
		test,
		search,
		importIssues,
		settingsRefusal,
	};
}

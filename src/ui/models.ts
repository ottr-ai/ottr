import { useEffect, useState } from "react";
import { splitLevel } from "../levels.ts";
import type { ModelOption } from "../models.ts";

export type ModelCatalog = {
	models: ModelOption[];
	defaultModel: string | null;
	/** omp role→model selectors (from ~/.omp/agent/config.yml); null when unknown. */
	roles: Record<string, string> | null;
};

/** Reviews and releases run with the plan role's model, else slow; null when neither is assigned. */
export function reviewModel(
	catalog: ModelCatalog | null,
): { role: string; model: string } | null {
	const roles = catalog?.roles;
	if (roles?.plan !== undefined) return { role: "plan", model: roles.plan };
	if (roles?.slow !== undefined) return { role: "slow", model: roles.slow };
	return null;
}

/** A role's field error from the save's 400 body: own keys only, so a role named "__proto__" or
    "constructor" never reads an inherited Object member as its message. */
export function ownField(
	fields: Readonly<Record<string, string>>,
	role: string,
): string | undefined {
	return Object.hasOwn(fields, role) ? fields[role] : undefined;
}

/** The warning for a role selector whose provider (the text before "/") has no active sign-in on
    the board; `active` is null when the board cannot read its store, which warns about nothing. */
export function roleWarnings(
	selector: string,
	active: readonly string[] | null,
): string[] {
	const i = selector.indexOf("/");
	if (i <= 0 || active === null) return [];
	const provider = selector.slice(0, i);
	return active.includes(provider)
		? []
		: [`No active sign-in for ${provider} on the board`];
}

/** The check roles missing from the edited role names: critic checks Anthropic models,
    adversary checks the rest. A missing role runs its checks on the default model, which is
    often the model they check — the editor flags the gap so the fallback is a decision. */
export function missingCheckRoles(roles: readonly string[]): string[] {
	const have = new Set(roles);
	return ["critic", "adversary"].filter((role) => !have.has(role));
}

/** Board seed state after a save: "copy" when the board reads the provisioned copy (no seed),
    "done" when the board copy holds the saved roles, "replaced" when a seed ran after the save
    (its commit differs from `seedAtSave`) and left other roles, else "wait". Roles alone cannot
    tell: two saves before one seed leave the board with the roles of neither. */
export function seedStep(
	seed: {
		needed: boolean;
		commit: string | null;
		roles: Record<string, string> | null;
	},
	seedAtSave: string | null,
	after: Record<string, string>,
): "copy" | "done" | "wait" | "replaced" {
	if (!seed.needed) return "copy";
	const board = seed.roles;
	const done =
		board !== null &&
		Object.keys(after).length === Object.keys(board).length &&
		Object.entries(after).every(([r, v]) => board[r] === v);
	if (done) return "done";
	return seed.commit === seedAtSave ? "wait" : "replaced";
}

/** GET /api/model-roles: omp's modelRoles in the data repo, the sign-ins, and the board seed state. */
export type RolesState = {
	/** The data repo commit the roles come from; a save sends it back as its base. */
	base: string | null;
	hash: string;
	roles: Record<string, string>;
	/** The providers with an active sign-in on the board; null when the board cannot read its store. */
	signIns: string[] | null;
	/** `roles`: the board copy's roles, which tell whether the seed holds a save. */
	seed: {
		needed: boolean;
		commit: string | null;
		roles: Record<string, string> | null;
		expiresAt: string | null;
	};
};

/** True when the edited rows differ from the saved roles, order included. */
export function rolesDirty(
	rows: readonly (readonly [string, string])[],
	roles: Record<string, string>,
): boolean {
	return JSON.stringify(rows) !== JSON.stringify(Object.entries(roles));
}

/** Why a new role (trimmed `name`, model `first`) can not be added, or null when it can. */
export function addRoleError(
	name: string,
	rows: readonly (readonly [string, string])[],
	first: string | undefined,
): string | null {
	if (name === "") return "Type a role name.";
	if (rows.some(([n]) => n === name)) return `The ${name} role exists already.`;
	if (first === undefined)
		return "The model list is empty, so a new role has no model.";
	return null;
}

/** The result of POST /api/model-roles. */
export type RolesSave =
	| {
			kind: "saved";
			commit: string;
			base: string | null;
			hash: string;
			roles: Record<string, string>;
			seed: RolesState["seed"];
	  }
	| {
			kind: "readonly";
			path: string;
	  }
	| {
			kind: "conflict";
			base: string | null;
			hash: string;
			roles: Record<string, string>;
			error: string;
	  }
	| { kind: "failed"; error: string; fields: Record<string, string> };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Classifies the save response; `body` is untrusted JSON, so only own, well-typed fields count.
    A saved answer's `base` is the new commit for GitHub-repo sources, and null for Alate's data
    folder, which is not a git repo; a 400 with exactly the read-only error locks the editor. */
export function classifyRolesSave(
	ok: boolean,
	status: number,
	body: unknown,
): RolesSave {
	const b: Obj = isObj(body) ? body : {};
	const own = (k: string) => (Object.hasOwn(b, k) ? b[k] : undefined);
	const str = (k: string) => {
		const v = own(k);
		return typeof v === "string" ? v : undefined;
	};
	const obj = (k: string) => {
		const v = own(k);
		return isObj(v) ? v : undefined;
	};
	const commit = str("commit");
	const base = own("base");
	const baseOrNull = typeof base === "string" ? base : null;
	const hash = str("hash");
	const roles = obj("roles") as Record<string, string> | undefined;
	const seed = obj("seed") as RolesState["seed"] | undefined;
	const error = str("error");
	const path = str("path");
	if (
		status === 400 &&
		error === "read-only: folder source" &&
		path !== undefined
	)
		return { kind: "readonly", path };
	if (ok && commit && hash && roles && seed)
		return { kind: "saved", commit, base: baseOrNull, hash, roles, seed };
	if (status === 409 && hash && roles)
		return {
			kind: "conflict",
			base: str("base") ?? null,
			hash,
			roles,
			error: `${error ?? "The model roles changed in the data repo."} The rows now show the current values. Make your change again.`,
		};
	const fields: Record<string, string> = {};
	for (const [k, v] of Object.entries(obj("fields") ?? {}))
		if (typeof v === "string") fields[k] = v;
	return { kind: "failed", error: error ?? `HTTP ${status}`, fields };
}

/** Case-insensitive quick search over the selector and the display name. */
export function modelMatches(m: ModelOption, query: string): boolean {
	const q = query.trim().toLowerCase();
	return q === "" || `${m.selector} ${m.name}`.toLowerCase().includes(q);
}

/** omp's display name of a selector's model (e.g. "Opus 5.5" for "anthropic/claude-opus-5-5"),
    or null when the catalog does not list it. The thinking level is ignored. */
export function modelName(
	models: readonly ModelOption[],
	selector: string,
): string | null {
	const [base] = splitLevel(selector);
	return models.find((m) => m.selector === base)?.name ?? null;
}

/** A selector as people read it: omp's display name plus the level ("Claude Opus 5.5 medium");
    a model the catalog does not list keeps its selector without the provider ("glm-5.3-flash:max"). */
export function displayModel(
	models: readonly ModelOption[],
	selector: string,
): string {
	const name = modelName(models, selector);
	if (name === null) return selector.slice(selector.indexOf("/") + 1);
	const [, level] = splitLevel(selector);
	return level === "" ? name : `${name} ${level}`;
}

/** A role row's model: the display name plus the level ("Opus 5.5 medium"), else the selector. */
function roleModelLabel(
	models: readonly ModelOption[],
	selector: string,
): string {
	const name = modelName(models, selector);
	if (name === null) return selector;
	const [, level] = splitLevel(selector);
	return level === "" ? name : `${name} ${level}`;
}

export type ModelRow = {
	key: string;
	label: string;
	selector: string;
	pressed: boolean;
	divider?: boolean;
	/** Provider heading shown above this row; set on the first row of each provider group. */
	heading?: string;
};

/** Picker list data: the models omp roles use first, model first with its roles in braces
    (e.g. "zai/glm-5.3-flash (plan, smol)"), one row per model even when several roles share it;
    a divider; then the catalog grouped under provider headings — groups alphabetical, models
    alphabetical inside each group. The first row runs on omp's default model
    (empty selector, so the task follows a later default change); roles that share the default
    model join that row. Catalog rows are NOT query-filtered here — the caller pre-filters with
    modelMatches. */
export function modelRows(
	models: readonly ModelOption[],
	roles: Record<string, string> | null,
	selected: string,
	query: string,
): ModelRow[] {
	const q = query.trim().toLowerCase();
	const [selBase] = splitLevel(selected);
	const bySelector = new Map<string, string[]>();
	for (const [r, s] of Object.entries(roles ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	))
		bySelector.set(s, [...(bySelector.get(s) ?? []), r]);
	const def = roles?.default;
	const defRoles =
		def === undefined
			? []
			: [
					"default",
					...(bySelector.get(def) ?? []).filter((r) => r !== "default"),
				];
	const roleRows = [...bySelector]
		.filter(
			([s, rs]) =>
				s !== def &&
				(q === "" || `${s} ${rs.join(" ")}`.toLowerCase().includes(q)),
		)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(
			([s, rs]): ModelRow => ({
				key: `role-${s}`,
				label: `${roleModelLabel(models, s)} (${rs.join(", ")})`,
				selector: s,
				// Suffix-insensitive: a task model "z/slow:high" marks both the "z/slow:low" role
				// row and the "z/slow" catalog row, so both rewrite the same base.
				pressed: splitLevel(s)[0] === selBase,
			}),
		);
	// Catalog grouped by provider (the selector part before "/", the whole selector as
	// the fallback for a selector without a slash): groups alphabetical, models
	// alphabetical inside each group, the first row of each group carries the provider
	// heading, and the section's first row keeps the roles divider.
	const grouped = new Map<string, ModelRow[]>();
	for (const m of [...models].sort((a, b) => a.name.localeCompare(b.name))) {
		const slash = m.selector.indexOf("/");
		const provider = slash === -1 ? m.selector : m.selector.slice(0, slash);
		grouped.set(provider, [
			...(grouped.get(provider) ?? []),
			{
				key: m.selector,
				label: `${m.name} (${m.id})`,
				selector: m.selector,
				pressed: splitLevel(m.selector)[0] === selBase,
			},
		]);
	}
	const catalog: ModelRow[] = [];
	let first = true;
	for (const [provider, rows] of [...grouped].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		for (const [i, row] of rows.entries()) {
			const head = i === 0;
			catalog.push({
				...row,
				...(head ? { heading: provider } : {}),
				...(head && first ? { divider: true } : {}),
			});
		}
		first = false;
	}
	return [
		{
			key: "role-default",
			label:
				def === undefined
					? "Default"
					: `${roleModelLabel(models, def)} (${defRoles.join(", ")})`,
			selector: "",
			pressed: selected === "",
		},
		...roleRows,
		...catalog,
	];
}

/** The focused row after an ArrowDown/ArrowUp in the picker list: clamped at both ends,
    -1 (no row focused, e.g. the search box) enters at the first row, an empty list stays -1. */
export function stepIndex(count: number, index: number, down: boolean): number {
	if (count === 0) return -1;
	return down ? Math.min(index + 1, count - 1) : Math.max(index - 1, 0);
}

// --- Catalog loader: one shared request serves every picker. ---

let modelsCache: ModelCatalog | null = null;
let inflight: Promise<ModelCatalog> | null = null;

/** Tests: clears the shared cache and in-flight request. */
export function resetCatalogCache(): void {
	modelsCache = null;
	inflight = null;
}

/** Fetch and parse /api/models; a missing or malformed body yields the empty catalog, which the caller does not cache. */
export async function fetchCatalog(
	fetchFn: typeof fetch = fetch,
): Promise<ModelCatalog> {
	const r = await fetchFn("/api/models");
	const data = (r.ok ? await r.json().catch(() => null) : null) as {
		models?: ModelOption[];
		roles?: Record<string, unknown>;
	} | null;
	const roles =
		data?.roles && typeof data.roles === "object"
			? Object.fromEntries(
					Object.entries(data.roles).filter(
						(e): e is [string, string] =>
							typeof e[1] === "string" && e[1] !== "",
					),
				)
			: null;
	return {
		models: data?.models ?? [],
		defaultModel: roles?.default ?? null,
		roles,
	};
}

/** One shared request: concurrent callers await the same fetch and a landing catalog serves every later picker.
    Dropped on failure or an empty list, so the next mount retries instead of freezing an empty catalog. */
export function loadCatalog(
	fetchFn: typeof fetch = fetch,
): Promise<ModelCatalog> {
	if (modelsCache !== null) return Promise.resolve(modelsCache);
	inflight ??= fetchCatalog(fetchFn).then(
		(c) => {
			if (c.models.length === 0) inflight = null;
			else modelsCache = c;
			return c;
		},
		(e) => {
			inflight = null;
			throw e;
		},
	);
	return inflight;
}

/** One per tab: every New task dialog shows the same catalog; null until it lands. */
export function useModels(): ModelCatalog | null {
	const [catalog, setCatalog] = useState<ModelCatalog | null>(modelsCache);
	useEffect(() => {
		if (modelsCache !== null) return;
		let alive = true;
		void loadCatalog()
			.then((c) => {
				if (alive) setCatalog(c);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	return catalog;
}

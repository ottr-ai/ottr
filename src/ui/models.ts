import { useEffect, useState } from "react";
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

/** omp model-selector thinking levels (selector suffix `:level`, same enum as omp's --thinking flag). */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"auto",
] as const;

/** Splits a trailing `:level` suffix off a model selector: [base, level], level "" when absent.
    The suffix only counts when it is a known thinking level, so ids like "openrouter/x:exacto" stay intact. */
export function splitLevel(selector: string): [string, string] {
	const i = selector.lastIndexOf(":");
	const lvl = selector.slice(i + 1);
	if (i !== -1 && (THINKING_LEVELS as readonly string[]).includes(lvl))
		return [selector.slice(0, i), lvl];
	return [selector, ""];
}

/** Appends `:level` to a selector, replacing any existing suffix; "" level keeps the bare base. */
export function joinLevel(base: string, level: string): string {
	const [clean] = splitLevel(base);
	return level === "" || clean === "" ? clean : `${clean}:${level}`;
}

/** One omp store's active sign-ins from /api/model-roles; `active` is null when the store cannot be read. */
export type StoreActive = {
	store: "board" | "workers";
	active: string[] | null;
};

/** Warnings for a role selector whose provider (the text before "/") has no active sign-in in a readable store. */
export function roleWarnings(
	selector: string,
	signIns: readonly StoreActive[],
): string[] {
	const i = selector.indexOf("/");
	if (i <= 0) return [];
	const provider = selector.slice(0, i);
	return signIns
		.filter((s) => s.active !== null && !s.active.includes(provider))
		.map(
			(s) =>
				`No active sign-in for ${provider} ${s.store === "board" ? "on the board" : "on the workers"}`,
		);
}

/** Case-insensitive quick search over the selector and the display name. */
export function modelMatches(m: ModelOption, query: string): boolean {
	const q = query.trim().toLowerCase();
	return q === "" || `${m.selector} ${m.name}`.toLowerCase().includes(q);
}

export type ModelRow = {
	key: string;
	label: string;
	selector: string;
	pressed: boolean;
	divider?: boolean;
};

/** Picker list data: omp roles first (their model as info, e.g. "Smol (zai/glm-5.3-flash)"), a divider,
    then the whole catalog alphabetically. "Default" (no explicit model) is the default role row.
    Catalog rows are NOT query-filtered here — the caller pre-filters with modelMatches. */
export function modelRows(
	models: readonly ModelOption[],
	roles: Record<string, string> | null,
	selected: string,
	query: string,
): ModelRow[] {
	const q = query.trim().toLowerCase();
	const [selBase] = splitLevel(selected);
	const roleRows = Object.entries(roles ?? {})
		.filter(
			([r, s]) =>
				r !== "default" && (q === "" || `${r} ${s}`.toLowerCase().includes(q)),
		)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([r, s]): ModelRow => {
			const label = `${r.charAt(0).toUpperCase()}${r.slice(1)} (${s})`;
			// Suffix-insensitive: a task model "z/slow:high" marks both the "z/slow:low" role
			// row and the "z/slow" catalog row, so both rewrite the same base.
			return {
				key: `role-${r}`,
				label,
				selector: s,
				pressed: splitLevel(s)[0] === selBase,
			};
		});
	const catalog = [...models]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(
			(m, i): ModelRow => ({
				key: m.selector,
				label: `${m.name} (${m.id})`,
				selector: m.selector,
				pressed: splitLevel(m.selector)[0] === selBase,
				divider: i === 0,
			}),
		);
	return [
		{
			key: "role-default",
			label: `Default${roles?.default ? ` (${roles.default})` : ""}`,
			selector: "",
			pressed: selected === "",
		},
		...roleRows,
		...catalog,
	];
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

import { expect, test } from "bun:test";
import type { ModelOption } from "../models.ts";
import {
	fetchCatalog,
	joinLevel,
	loadCatalog,
	modelMatches,
	modelRows,
	resetCatalogCache,
	reviewModel,
	roleWarnings,
	seedStep,
	splitLevel,
} from "./models.ts";

/** id doubles as the selector for these fixtures. */
const m = (id: string, name: string): ModelOption => ({
	id,
	selector: id,
	name,
	contextWindow: null,
});

/** A fetch double answering `body` as JSON with `status`, counting its calls. */
const fetchDouble = (
	body: string,
	status = 200,
): { fetch: typeof fetch; calls: () => number } => {
	let calls = 0;
	const f = (): Promise<Response> => {
		calls += 1;
		return Promise.resolve(new Response(body, { status }));
	};
	return { fetch: f as unknown as typeof fetch, calls: () => calls };
};

test("reviewModel prefers plan over slow", () => {
	expect(
		reviewModel({
			models: [],
			defaultModel: null,
			roles: { plan: "p", slow: "s" },
		}),
	).toEqual({ role: "plan", model: "p" });
});

test("reviewModel falls back to slow", () => {
	expect(
		reviewModel({ models: [], defaultModel: null, roles: { slow: "s" } }),
	).toEqual({ role: "slow", model: "s" });
});

test("reviewModel returns null when roles are unknown", () => {
	expect(reviewModel(null)).toBeNull();
	expect(
		reviewModel({ models: [], defaultModel: null, roles: null }),
	).toBeNull();
});

test("reviewModel returns null when neither role is assigned", () => {
	expect(
		reviewModel({ models: [], defaultModel: null, roles: { fast: "f" } }),
	).toBeNull();
});

test("modelMatches empty query matches everything", () => {
	expect(modelMatches(m("a", "A"), "")).toBe(true);
	expect(modelMatches(m("a", "A"), "  ")).toBe(true);
});

test("modelMatches is case-insensitive over selector and name", () => {
	expect(modelMatches(m("zai/glm", "Smol"), "ZAI")).toBe(true);
	expect(modelMatches(m("zai/glm", "Smol"), "smol")).toBe(true);
	expect(modelMatches(m("zai/glm", "Smol"), "nope")).toBe(false);
});

const models = [m("z/fast", "Fast"), m("a/smol", "Smol")];
const roles = { default: "a/smol", slow: "z/slow", plan: "a/plan" };

test("modelRows puts Default first with roles.default in the label", () => {
	expect(modelRows([], roles, "", "")[0]).toEqual({
		key: "role-default",
		label: "Default (a/smol)",
		selector: "",
		pressed: true,
	});
});

test("modelRows Default label is bare without roles.default", () => {
	expect(modelRows([], { slow: "s" }, "s", "")).toEqual([
		{ key: "role-default", label: "Default", selector: "", pressed: false },
		{ key: "role-slow", label: "Slow (s)", selector: "s", pressed: true },
	]);
});

test("modelRows excludes default from role rows and sorts by role name", () => {
	const rows = modelRows([], roles, "", "");
	expect(rows.map((r) => r.key)).toEqual([
		"role-default",
		"role-plan",
		"role-slow",
	]);
	expect(rows.map((r) => r.label)).toEqual([
		"Default (a/smol)",
		"Plan (a/plan)",
		"Slow (z/slow)",
	]);
});

test("modelRows marks pressed via shared selector across role and catalog rows", () => {
	const rows = modelRows(
		[m("z/slow", "Slow")],
		{ slow: "z/slow" },
		"z/slow",
		"",
	);
	expect(rows.find((r) => r.key === "role-slow")?.pressed).toBe(true);
	expect(rows.find((r) => r.key === "z/slow")?.pressed).toBe(true);
	expect(rows.find((r) => r.key === "role-default")?.pressed).toBe(false);
});

test("modelRows sorts catalog by name with Name (id) labels", () => {
	const rows = modelRows(
		[m("z/fast", "Fast"), m("a/smol", "Smol")],
		null,
		"",
		"",
	).filter((r) => r.key !== "role-default");
	expect(rows.map((r) => r.label)).toEqual(["Fast (z/fast)", "Smol (a/smol)"]);
});

test("modelRows sets divider only on the first catalog row", () => {
	const rows = modelRows(
		[m("c/three", "Three"), m("a/one", "One"), m("b/two", "Two")],
		null,
		"",
		"",
	);
	const dividers = rows.filter((r) => r.divider === true);
	expect(dividers.length).toBe(1);
	expect(dividers[0]?.key).toBe("a/one");
});

test("modelRows sets no divider when models is empty", () => {
	expect(modelRows([], { slow: "s" }, "", "").every((r) => !r.divider)).toBe(
		true,
	);
});

test("modelRows query filters role rows case-insensitively but not catalog rows", () => {
	const rows = modelRows(models, { slow: "Z/SLOW" }, "", "slow");
	expect(rows.map((r) => r.key)).toEqual([
		"role-default",
		"role-slow",
		"z/fast",
		"a/smol",
	]);
});

test("splitLevel splits only the trailing :level suffix", () => {
	expect(splitLevel("z/slow:low")).toEqual(["z/slow", "low"]);
	expect(splitLevel("z/slow")).toEqual(["z/slow", ""]);
	expect(splitLevel(":max")).toEqual(["", "max"]);
	expect(splitLevel("a/b:x:max")).toEqual(["a/b:x", "max"]);
	// Unknown suffixes are part of the model id, not a thinking level.
	expect(splitLevel("openrouter/x:exacto")).toEqual([
		"openrouter/x:exacto",
		"",
	]);
	expect(splitLevel("model:custom")).toEqual(["model:custom", ""]);
});

test("joinLevel replaces an existing suffix and guards an empty base", () => {
	expect(joinLevel("z/slow", "low")).toBe("z/slow:low");
	expect(joinLevel("z/slow:low", "high")).toBe("z/slow:high");
	expect(joinLevel("z/slow", "")).toBe("z/slow");
	expect(joinLevel("", "max")).toBe("");
});

test("modelRows pressed ignores the level suffix while role labels keep it", () => {
	const rows = modelRows(
		[m("z/slow", "Slow")],
		{ slow: "z/slow:low" },
		"z/slow:high",
		"",
	);
	const role = rows.find((r) => r.key === "role-slow");
	expect(role?.label).toBe("Slow (z/slow:low)");
	expect(role?.pressed).toBe(true);
	expect(rows.find((r) => r.key === "z/slow")?.pressed).toBe(true);
	expect(rows.find((r) => r.key === "role-default")?.pressed).toBe(false);
});

test("fetchCatalog parses models and filters roles to non-empty strings", async () => {
	const { fetch } = fetchDouble(
		JSON.stringify({
			models: [m("z/a", "A")],
			roles: { default: "z/a", plan: "z/a", slow: "", broken: 3 },
		}),
	);
	const catalog = await fetchCatalog(fetch);
	expect(catalog.models).toEqual([m("z/a", "A")]);
	expect(catalog.roles).toEqual({ default: "z/a", plan: "z/a" });
	expect(catalog.defaultModel).toBe("z/a");
});

test("fetchCatalog yields the empty catalog for a missing or malformed body", async () => {
	const notOk = fetchDouble("{}", 503);
	expect(await fetchCatalog(notOk.fetch)).toEqual({
		models: [],
		defaultModel: null,
		roles: null,
	});
	const bad = fetchDouble("not json");
	expect(await fetchCatalog(bad.fetch)).toEqual({
		models: [],
		defaultModel: null,
		roles: null,
	});
});

test("loadCatalog shares one request across concurrent callers and caches the landing", async () => {
	resetCatalogCache();
	const { fetch, calls } = fetchDouble(
		JSON.stringify({ models: [m("z/a", "A")], roles: {} }),
	);
	const [x, y] = await Promise.all([loadCatalog(fetch), loadCatalog(fetch)]);
	expect(calls()).toBe(1);
	expect(x).toBe(y);
	// The cached catalog serves every later picker without a new request.
	const again = await loadCatalog(fetch);
	expect(calls()).toBe(1);
	expect(again).toBe(x);
});

test("loadCatalog retries after a failed request", async () => {
	resetCatalogCache();
	const down = fetchDouble("{}", 503);
	await loadCatalog(down.fetch).catch(() => {}); // the hook swallows the rejection
	expect(down.calls()).toBe(1);
	const { fetch, calls } = fetchDouble(
		JSON.stringify({ models: [], roles: null }),
	);
	const catalog = await loadCatalog(fetch);
	expect(down.calls()).toBe(1);
	expect(calls()).toBe(1);
	expect(catalog.models).toEqual([]);
	resetCatalogCache();
});

test("an empty catalog is not cached: the next mount retries", async () => {
	resetCatalogCache();
	const empty = fetchDouble(JSON.stringify({ models: [], roles: null }));
	const [a, b] = await Promise.all([
		loadCatalog(empty.fetch),
		loadCatalog(empty.fetch),
	]);
	expect(empty.calls()).toBe(1);
	expect(a.models).toEqual([]);
	expect(b).toBe(a);
	const good = fetchDouble(
		JSON.stringify({ models: [m("z/a", "A")], roles: {} }),
	);
	// The empty landing did not stick; the next load fetches and that one sticks.
	const c = await loadCatalog(good.fetch);
	expect(empty.calls()).toBe(1);
	expect(good.calls()).toBe(1);
	expect(c.models).toEqual([m("z/a", "A")]);
	const again = await loadCatalog(good.fetch);
	expect(good.calls()).toBe(1);
	expect(again).toBe(c);
	resetCatalogCache();
});

test("roleWarnings names each readable store without an active sign-in for the provider", () => {
	const signIns = [
		{ store: "board" as const, active: ["anthropic"] },
		{ store: "workers" as const, active: ["zai"] },
	];
	expect(roleWarnings("zai/glm-5.3-flash:max", signIns)).toEqual([
		"No active sign-in for zai on the board",
	]);
	expect(roleWarnings("anthropic/claude-opus-5-5", signIns)).toEqual([
		"No active sign-in for anthropic on the workers",
	]);
	// An unreadable store and a selector without a provider give no warning.
	expect(
		roleWarnings("openai/gpt", [{ store: "board", active: null }]),
	).toEqual([]);
	expect(roleWarnings("bare-model", signIns)).toEqual([]);
});

test("seedStep: a later seed that holds the save ends the wait; a replaced save is not stuck", () => {
	const before = { default: "a/b" };
	const after = { default: "c/d:max" };
	const seed = (roles: Record<string, string> | null) => ({
		needed: true,
		roles,
	});
	expect(seedStep({ needed: false, roles: null }, before, after)).toBe("copy");
	expect(seedStep(seed({}), before, after)).toBe("wait");
	expect(seedStep(seed({ ...before }), before, after)).toBe("wait");
	expect(seedStep(seed({ ...after }), before, after)).toBe("done");
	expect(seedStep(seed({ default: "e/f" }), before, after)).toBe("replaced");
	expect(seedStep(seed({ ...after, plan: "e/f" }), before, after)).toBe(
		"replaced",
	);
});

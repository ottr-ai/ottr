import { expect, test } from "bun:test";
import { joinLevel, splitLevel } from "../levels.ts";
import type { ModelOption } from "../models.ts";
import fc from "../test/properties.ts";
import {
	addRoleError,
	classifyRolesSave,
	displayModel,
	fallbacksDirty,
	fetchCatalog,
	loadCatalog,
	missingCheckRoles,
	modelMatches,
	modelRows,
	ownField,
	resetCatalogCache,
	reviewModel,
	rolesDirty,
	roleWarnings,
	rowChains,
	seedStep,
	stepIndex,
} from "./models.ts";

test("missingCheckRoles lists the check roles the edited roles lack", () => {
	expect(missingCheckRoles(["default", "slow"])).toEqual([
		"critic",
		"adversary",
	]);
	expect(missingCheckRoles(["adversary"])).toEqual(["critic"]);
	expect(missingCheckRoles(["critic", "adversary", "default"])).toEqual([]);
});

test("rolesDirty compares rows with the roles in order", () => {
	const roles = { default: "a/x", slow: "b/y" };
	expect(
		rolesDirty(
			[
				["default", "a/x"],
				["slow", "b/y"],
			],
			roles,
		),
	).toBe(false);
	expect(
		rolesDirty(
			[
				["default", "a/x"],
				["slow", "b/z"],
			],
			roles,
		),
	).toBe(true);
	expect(
		rolesDirty(
			[
				["slow", "b/y"],
				["default", "a/x"],
			],
			roles,
		),
	).toBe(true);
	expect(
		rolesDirty(
			[
				["default", "a/x"],
				["slow", "b/y"],
				["new", "a/x"],
			],
			roles,
		),
	).toBe(true);
});

test("fallbacksDirty compares each row's chain with its loaded chain, presence included", () => {
	const names = ["plan", "slow"];
	const loaded = { plan: ["a/x", "b/y"], judge: ["c/z"], "a/x": ["d/w"] };
	const dirty = (chains: Record<string, string[]>) =>
		fallbacksDirty(names, chains, loaded);
	// Keys outside the rows (another role, a model-selector key) do not count.
	expect(dirty({ plan: ["a/x", "b/y"] })).toBe(false);
	expect(dirty({ plan: ["b/y", "a/x"] })).toBe(true);
	expect(dirty({ plan: ["a/x"] })).toBe(true);
	expect(dirty({ plan: ["a/x", "b/y", "c/z"] })).toBe(true);
	expect(dirty({ plan: ["a/x", "b/z"] })).toBe(true);
	expect(dirty({})).toBe(true);
	// An explicit empty chain differs from no chain, both ways.
	expect(dirty({ plan: ["a/x", "b/y"], slow: [] })).toBe(true);
	expect(fallbacksDirty(["slow"], {}, { slow: [] })).toBe(true);
	expect(fallbacksDirty(["slow"], { slow: [] }, { slow: [] })).toBe(false);
	// A role named "constructor" never reads an inherited member as its chain.
	expect(fallbacksDirty(["constructor"], {}, {})).toBe(false);
});

test("rowChains keeps the named roles' chains as copies; a role without one gets no key", () => {
	const fallbacks = { plan: ["a/x"], judge: [], "a/x": ["b/y"] };
	const chains = rowChains(["plan", "judge", "slow", "constructor"], fallbacks);
	expect(chains).toEqual({ plan: ["a/x"], judge: [] });
	expect(Object.hasOwn(chains, "slow")).toBe(false);
	expect(Object.hasOwn(chains, "constructor")).toBe(false);
	// Edits on a row's chain never touch the loaded chain.
	expect(chains.plan).not.toBe(fallbacks.plan);
});

test("addRoleError gives the first failing reason, or null", () => {
	const rows = [["default", "a/x"]] as const;
	expect(addRoleError("", rows, undefined)).toBe("Type a role name.");
	expect(addRoleError("default", rows, undefined)).toBe(
		"The default role exists already.",
	);
	expect(addRoleError("new", rows, undefined)).toBe(
		"The model list is empty, so a new role has no model.",
	);
	expect(addRoleError("new", rows, "a/x")).toBeNull();
});

const seed = {
	needed: true,
	commit: null,
	roles: null,
	fallbacks: null,
	expiresAt: null,
};
const tail = " The rows now show the current values. Make your change again.";

test("classifyRolesSave: saved needs commit, hash, roles and seed", () => {
	const body = {
		commit: "c1",
		base: null,
		hash: "h1",
		roles: { a: "b/c" },
		seed,
	};
	// An answer without fallbacks holds no chains.
	expect(classifyRolesSave(true, 200, body)).toEqual({
		kind: "saved",
		...body,
		fallbacks: {},
	});
	const { seed: _, ...noSeed } = body;
	expect(classifyRolesSave(true, 200, noSeed)).toEqual({
		kind: "failed",
		error: "HTTP 200",
		fields: {},
		fallbackFields: {},
	});
});

test("classifyRolesSave: saved and conflict keep only string-list chains", () => {
	const fallbacks = {
		plan: ["openai-codex/gpt-6.1-sol"],
		judge: [],
		"openai-codex/gpt-6.1-sol": ["zai/glm-5.3:max"],
		bad: ["a/b", 3],
		text: "a/b",
		none: null,
	};
	const kept = {
		plan: ["openai-codex/gpt-6.1-sol"],
		judge: [],
		"openai-codex/gpt-6.1-sol": ["zai/glm-5.3:max"],
	};
	const body = { commit: "c1", hash: "h1", roles: {}, fallbacks, seed };
	const saved = classifyRolesSave(true, 200, body);
	expect(saved.kind === "saved" && saved.fallbacks).toEqual(kept);
	const conflict = classifyRolesSave(false, 409, {
		hash: "h",
		roles: {},
		fallbacks,
	});
	expect(conflict.kind === "conflict" && conflict.fallbacks).toEqual(kept);
	for (const junk of [null, [["a/b"]], "a/b", 7]) {
		const r = classifyRolesSave(false, 409, {
			hash: "h",
			roles: {},
			fallbacks: junk,
		});
		expect(r.kind === "conflict" && r.fallbacks).toEqual({});
	}
});

test("classifyRolesSave: a 400 keeps the string fallbackFields", () => {
	expect(
		classifyRolesSave(false, 400, {
			error: "Bad roles.",
			fields: {},
			fallbackFields: { plan: "fallback 2: unknown model x/y", slow: 4 },
		}),
	).toEqual({
		kind: "failed",
		error: "Bad roles.",
		fields: {},
		fallbackFields: { plan: "fallback 2: unknown model x/y" },
	});
	// JSON.parse makes "__proto__" an own key; the parse keeps it as a message.
	const r = classifyRolesSave(
		false,
		400,
		JSON.parse('{"fallbackFields":{"__proto__":"bad"}}'),
	);
	expect(
		r.kind === "failed" && Object.hasOwn(r.fallbackFields, "__proto__"),
	).toBe(true);
});

test("classifyRolesSave: saved needs ok and every part", () => {
	const body = {
		commit: "c1",
		base: "b9",
		hash: "h1",
		roles: { a: "b/c" },
		seed,
	};
	const failed = (status: number) => ({
		kind: "failed" as const,
		error: `HTTP ${status}`,
		fields: {},
		fallbackFields: {},
	});
	expect(classifyRolesSave(false, 500, body)).toEqual(failed(500));
	expect(classifyRolesSave(true, 200, { ...body, commit: "" })).toEqual(
		failed(200),
	);
	expect(classifyRolesSave(true, 200, { ...body, hash: undefined })).toEqual(
		failed(200),
	);
	expect(classifyRolesSave(true, 200, { ...body, roles: [] })).toEqual(
		failed(200),
	);
});

test("classifyRolesSave: 400 read-only: folder source with a path is readonly", () => {
	expect(
		classifyRolesSave(false, 400, {
			error: "read-only: folder source",
			path: "/data",
		}),
	).toEqual({ kind: "readonly", path: "/data" });
	expect(
		classifyRolesSave(false, 400, { error: "read-only: folder source" }),
	).toEqual({
		kind: "failed",
		error: "read-only: folder source",
		fields: {},
		fallbackFields: {},
	});
	expect(
		classifyRolesSave(false, 400, {
			error: "read-only: folder source",
			path: 7,
		}),
	).toEqual({
		kind: "failed",
		error: "read-only: folder source",
		fields: {},
		fallbackFields: {},
	});
	expect(
		classifyRolesSave(false, 400, {
			error: "Bad roles.",
			fields: { a: "Unknown model." },
		}),
	).toEqual({
		kind: "failed",
		error: "Bad roles.",
		fields: { a: "Unknown model." },
		fallbackFields: {},
	});
});

test("classifyRolesSave: 409 with hash and roles is a conflict", () => {
	expect(classifyRolesSave(false, 409, { hash: "h", roles: {} })).toEqual({
		kind: "conflict",
		base: null,
		hash: "h",
		roles: {},
		fallbacks: {},
		error: `The model roles changed in the data repo.${tail}`,
	});
	expect(
		classifyRolesSave(false, 409, {
			hash: "h",
			roles: {},
			base: "b1",
			error: "Moved.",
		}),
	).toMatchObject({ kind: "conflict", base: "b1", error: `Moved.${tail}` });
	expect(classifyRolesSave(false, 409, { hash: "h", error: "x" })).toEqual({
		kind: "failed",
		error: "x",
		fields: {},
		fallbackFields: {},
	});
});

test("classifyRolesSave: failures keep string fields and the error", () => {
	expect(
		classifyRolesSave(false, 400, {
			error: "Bad roles.",
			fields: { a: "Unknown model.", b: 3 },
		}),
	).toEqual({
		kind: "failed",
		error: "Bad roles.",
		fields: { a: "Unknown model." },
		fallbackFields: {},
	});
	for (const body of [null, [1], 7, "x"])
		expect(classifyRolesSave(false, 500, body)).toEqual({
			kind: "failed",
			error: "HTTP 500",
			fields: {},
			fallbackFields: {},
		});
	expect(classifyRolesSave(false, 502, { error: 5 })).toMatchObject({
		error: "HTTP 502",
	});
});

test("classifyRolesSave never throws; saved needs ok, conflict needs 409", () => {
	fc.assert(
		fc.property(
			fc.jsonValue(),
			fc.boolean(),
			fc.integer(),
			(body, ok, status) => {
				const r = classifyRolesSave(ok, status, body);
				if (r.kind === "saved") expect(ok).toBe(true);
				if (r.kind === "conflict") expect(status).toBe(409);
			},
		),
	);
});

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

test("modelRows puts the default model first, model first with its role in braces", () => {
	expect(modelRows([], roles, "", "")[0]).toEqual({
		key: "role-default",
		label: "a/smol (default)",
		selector: "",
		pressed: true,
	});
});

test("modelRows Default label is bare without roles.default", () => {
	expect(modelRows([], { slow: "s" }, "s", "")).toEqual([
		{ key: "role-default", label: "Default", selector: "", pressed: false },
		{ key: "role-s", label: "s (slow)", selector: "s", pressed: true },
	]);
});

test("modelRows lists each role model once after the default row, sorted by model", () => {
	const rows = modelRows([], roles, "", "");
	expect(rows.map((r) => r.key)).toEqual([
		"role-default",
		"role-a/plan",
		"role-z/slow",
	]);
	expect(rows.map((r) => r.label)).toEqual([
		"a/smol (default)",
		"a/plan (plan)",
		"z/slow (slow)",
	]);
});

test("displayModel shows the display name and level, else the selector without its provider", () => {
	const ms = [m("anthropic/claude-opus-5-5", "Claude Opus 5.5")];
	expect(displayModel(ms, "anthropic/claude-opus-5-5:medium")).toBe(
		"Claude Opus 5.5 medium",
	);
	expect(displayModel(ms, "anthropic/claude-opus-5-5")).toBe("Claude Opus 5.5");
	expect(displayModel(ms, "zai/glm-5.3-flash:max")).toBe("glm-5.3-flash:max");
	expect(displayModel(ms, "default")).toBe("default");
});

test("modelRows names role models by omp's display name, level kept, selector as fallback", () => {
	const rows = modelRows(
		[m("anthropic/opus", "Opus 5.5")],
		{
			default: "anthropic/opus:medium",
			plan: "anthropic/opus:medium",
			task: "x/unlisted",
		},
		"",
		"",
	);
	expect(rows.map((r) => r.label)).toEqual([
		"Opus 5.5 medium (default, plan)",
		"x/unlisted (task)",
		"Opus 5.5 (anthropic/opus)",
	]);
});

test("modelRows merges roles that share a model into one row", () => {
	const rows = modelRows(
		[],
		{ task: "b", default: "a", smol: "a", plan: "b" },
		"b",
		"",
	);
	expect(rows).toEqual([
		{
			key: "role-default",
			label: "a (default, smol)",
			selector: "",
			pressed: false,
		},
		{ key: "role-b", label: "b (plan, task)", selector: "b", pressed: true },
	]);
});

test("modelRows marks pressed via shared selector across role and catalog rows", () => {
	const rows = modelRows(
		[m("z/slow", "Slow")],
		{ slow: "z/slow" },
		"z/slow",
		"",
	);
	expect(rows.find((r) => r.key === "role-z/slow")?.pressed).toBe(true);
	expect(rows.find((r) => r.key === "z/slow")?.pressed).toBe(true);
	expect(rows.find((r) => r.key === "role-default")?.pressed).toBe(false);
});

test("modelRows groups catalog by provider, groups alphabetical, names inside", () => {
	const rows = modelRows(
		[m("z/fast", "Fast"), m("a/smol", "Smol")],
		null,
		"",
		"",
	).filter((r) => r.key !== "role-default");
	expect(rows.map((r) => [r.label, r.heading])).toEqual([
		["Smol (a/smol)", "a"],
		["Fast (z/fast)", "z"],
	]);
});

test("modelRows orders provider groups alphabetically with one heading per group", () => {
	const rows = modelRows(
		[
			m("b/two", "Two"),
			m("a/nine", "Nine"),
			m("c/three", "Three"),
			m("a/alpha", "Alpha"),
		],
		null,
		"",
		"",
	).filter((r) => r.key !== "role-default");
	expect(rows.map((r) => r.key)).toEqual([
		"a/alpha",
		"a/nine",
		"b/two",
		"c/three",
	]);
	expect(rows.map((r) => r.heading)).toEqual(["a", undefined, "b", "c"]);
	expect(rows.filter((r) => r.divider).map((r) => r.key)).toEqual(["a/alpha"]);
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

test("modelRows query filters role rows and catalog rows case-insensitively", () => {
	const rows = modelRows(models, { slow: "Z/SLOW" }, "", "slow");
	expect(rows.map((r) => r.key)).toEqual(["role-default", "role-Z/SLOW"]);
});

test("modelRows resolves role labels against the full catalog while the query filters the catalog section", () => {
	const rows = modelRows(
		[m("zai/glm-5.3-flash", "GLM-5.3-Flash"), m("x/fast", "Fast")],
		{ default: "zai/glm-5.3-flash:max" },
		"",
		"fa",
	);
	// "fa" matches only the Fast catalog row, yet the default row keeps its display name.
	expect(rows.map((r) => r.label)).toEqual([
		"GLM-5.3-Flash max (default)",
		"Fast (x/fast)",
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
	const role = rows.find((r) => r.key === "role-z/slow:low");
	expect(role?.label).toBe("Slow low (slow)");
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

test("roleWarnings warns when the board has no active sign-in for the provider", () => {
	const active = ["anthropic"];
	expect(roleWarnings("zai/glm-5.3-flash:max", active)).toEqual([
		"No active sign-in for zai on the board",
	]);
	expect(roleWarnings("anthropic/claude-opus-5-5", active)).toEqual([]);
	// An unreadable store and a selector without a provider give no warning.
	expect(roleWarnings("openai/gpt", null)).toEqual([]);
	expect(roleWarnings("bare-model", active)).toEqual([]);
	expect(roleWarnings("/model", [])).toEqual([]);
});

/** A needed seed state: the board copy holds `roles` and `fallbacks`. */
const seedOf = (
	commit: string | null,
	roles: Record<string, string> | null,
	fallbacks: Record<string, string[]> | null = {},
) => ({ needed: true, commit, roles, fallbacks });

test("seedStep: a later seed that holds the save ends the wait; a replaced save is not stuck", () => {
	const after = { default: "c/d:max" };
	expect(
		seedStep(
			{ needed: false, commit: null, roles: null, fallbacks: null },
			null,
			after,
			{},
		),
	).toBe("copy");
	expect(seedStep(seedOf(null, {}), null, after, {})).toBe("wait");
	expect(seedStep(seedOf("s1", { default: "a/b" }), "s1", after, {})).toBe(
		"wait",
	);
	expect(seedStep(seedOf("s2", { ...after }), "s1", after, {})).toBe("done");
	expect(seedStep(seedOf("s2", { default: "e/f" }), "s1", after, {})).toBe(
		"replaced",
	);
	expect(seedStep(seedOf("s1", {}), null, after, {})).toBe("replaced");
	expect(
		seedStep(seedOf("s2", { ...after, plan: "e/f" }), "s1", after, {}),
	).toBe("replaced");
});

test("seedStep: two saves before one seed wait, the board holds neither save's roles", () => {
	// Save 1 A→B, save 2 B→C, the hourly seed has not run: the board still holds A.
	const board = { default: "a/a" };
	const c = { default: "c/c" };
	expect(seedStep(seedOf("s1", board), "s1", c, {})).toBe("wait");
});

test("seedStep: the board copy holds the save only with the saved roles' chains", () => {
	const after = { plan: "a/x", slow: "b/y" };
	// The saved file: plan has a chain, slow has none, a model-selector key has one too.
	const saved = { plan: ["c/z", "d/w:max"], "a/x": ["e/v"] };
	const done = (board: Record<string, string[]> | null) =>
		seedStep(seedOf("s2", { ...after }, board), "s1", after, saved);
	expect(done({ plan: ["c/z", "d/w:max"] })).toBe("done");
	// Keys outside the saved roles do not count, on either side.
	expect(done({ plan: ["c/z", "d/w:max"], "f/u": ["g/t"] })).toBe("done");
	// A missing, reordered, shorter or extra chain is not the save.
	expect(done({})).toBe("replaced");
	expect(done({ plan: ["d/w:max", "c/z"] })).toBe("replaced");
	expect(done({ plan: ["c/z"] })).toBe("replaced");
	expect(done({ plan: ["c/z", "d/w:max"], slow: ["c/z"] })).toBe("replaced");
	// An explicit empty chain differs from no chain.
	expect(done({ plan: ["c/z", "d/w:max"], slow: [] })).toBe("replaced");
	expect(
		seedStep(seedOf("s2", { ...after }, { plan: [] }), "s1", after, {
			plan: [],
		}),
	).toBe("done");
	// A board copy without chains (null) holds a save without chains.
	expect(seedStep(seedOf("s2", { ...after }, null), "s1", after, {})).toBe(
		"done",
	);
	// Before the next seed, the old chains keep the line waiting.
	expect(
		seedStep(seedOf("s1", { ...after }, { plan: ["c/z"] }), "s1", after, saved),
	).toBe("wait");
	// A role named "constructor" never reads an inherited member as its chain.
	expect(
		seedStep(
			seedOf("s2", { constructor: "a/x" }),
			"s1",
			{ constructor: "a/x" },
			{},
		),
	).toBe("done");
});

test("ownField reads only own keys: __proto__ and constructor never get an inherited message", () => {
	const none: Record<string, string> = {};
	expect(ownField(none, "constructor")).toBeUndefined();
	expect(ownField(none, "__proto__")).toBeUndefined();
	expect(ownField(none, "toString")).toBeUndefined();
	// A 400 body names the bad role: JSON.parse makes "__proto__" an own key.
	const sent = JSON.parse('{"__proto__":"bad name"}') as Record<string, string>;
	expect(ownField(sent, "__proto__")).toBe("bad name");
});

test("stepIndex walks the picker rows with the arrow keys", () => {
	// Entering from the search box (no row focused, -1) lands on the first row either way.
	expect(stepIndex(5, -1, true)).toBe(0);
	expect(stepIndex(5, -1, false)).toBe(0);
	expect(stepIndex(5, 1, true)).toBe(2);
	expect(stepIndex(5, 2, false)).toBe(1);
	// Clamped: no wrap past the ends.
	expect(stepIndex(5, 4, true)).toBe(4);
	expect(stepIndex(5, 0, false)).toBe(0);
	// An empty list has nothing to focus.
	expect(stepIndex(0, -1, true)).toBe(-1);
	expect(stepIndex(0, -1, false)).toBe(-1);
});

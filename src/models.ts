// Model catalog (`omp models`) and role assignments (the board's omp agent config.yml —
// the board home's current agent layer when one resolves, else PI_CODING_AGENT_DIR when
// pinned, else ~/.omp/agent under the board home).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentLayer } from "./layers.ts";
import { agentDir, boardOmpEnv, boardOmpHome } from "./login.ts";
import { selectorError } from "./modelRoles.ts";

export interface ModelOption {
	id: string;
	selector: string;
	name: string;
	/** Context window in tokens from the omp catalog; null when absent or not a positive finite number. */
	contextWindow: number | null;
}
let modelsCache: Promise<ModelOption[]> | null = null;
/** `omp models --json` chat catalog, cached for the process; a failed call retries on the next request. */
export function modelList(
	spawnFn: typeof spawn = spawn,
	timeoutMs = 30_000,
): Promise<ModelOption[]> {
	if (modelsCache) return modelsCache;
	const { promise, resolve } = Promise.withResolvers<ModelOption[]>();
	modelsCache = promise;
	const child = spawnFn("omp", ["models", "--json"], {
		stdio: ["ignore", "pipe", "ignore"],
		env: boardOmpEnv(),
		windowsHide: true,
	});
	let out = "";
	child.stdout.on("data", (c: Buffer) => (out += c));
	// A hung child must end the wait: kill it so `close` fires and the cache clears.
	const timer = setTimeout(() => child.kill(), timeoutMs);
	child.on("error", () => {
		clearTimeout(timer);
		modelsCache = null;
		resolve([]);
	});
	child.on("close", () => {
		clearTimeout(timer);
		try {
			const parsed = JSON.parse(out) as {
				models?: {
					id?: unknown;
					selector?: unknown;
					name?: unknown;
					kind?: unknown;
					contextWindow?: unknown;
				}[];
			};
			const list = (parsed.models ?? [])
				.filter(
					(m) =>
						m.kind === "chat" &&
						typeof m.selector === "string" &&
						m.selector.includes("/") &&
						m.selector !== "" &&
						typeof m.id === "string",
				)
				.map((m) => ({
					id: m.id as string,
					selector: m.selector as string,
					name:
						typeof m.name === "string" && m.name !== ""
							? m.name
							: (m.selector as string),
					contextWindow:
						typeof m.contextWindow === "number" &&
						Number.isFinite(m.contextWindow) &&
						m.contextWindow > 0
							? m.contextWindow
							: null,
				}));
			resolve(list);
		} catch {
			modelsCache = null; // omp missing or junk output: Default-only picker, retry next request
			resolve([]);
		}
	});
	return promise;
}

/**
 * The board's omp agent config.yml a roles read targets: the current agent layer's copy when
 * the board home resolves one, else the flat agent dir
 * (docs/specs/agent-layer-switch.md, "Layer-following reads"). Read-only: a roles read never
 * prepares or pins. Without a layer the fallback is agentDir(): the PI_CODING_AGENT_DIR pin
 * wins over the board home's flat dir — the precedence src/login.ts documents for the agent
 * dir (R5-1).
 */
function defaultRolesPath(): string {
	const layer = resolveAgentLayer(boardOmpHome());
	return layer === null
		? join(agentDir(), "config.yml")
		: join(layer.dir, ".omp", "agent", "config.yml");
}

/** Role→model selectors from the board's omp agent config.yml (`modelRoles`, any `:level` thinking
 * suffix kept — omp selectors are `provider/model:level`); nonempty string values only; {} when
 * unreadable. The default path follows the board home's current agent layer when one resolves,
 * else the flat agent dir as today.
 */
export function modelRoles(
	configPath: string = defaultRolesPath(),
): Record<string, string> {
	try {
		const roles = (
			Bun.YAML.parse(readFileSync(configPath, "utf8")) as {
				modelRoles?: unknown;
			} | null
		)?.modelRoles;
		const out: Record<string, string> = {};
		if (typeof roles === "object" && roles !== null) {
			for (const [name, model] of Object.entries(roles)) {
				// "zai/glm-5.3-flash:max" stays whole — the UI defaults its thinking picker to the role's level.
				if (typeof model === "string" && model !== "") out[name] = model;
			}
		}
		return out;
	} catch {
		return {}; // no config: unmarked list
	}
}

/** Fallback chains from the same config.yml (`retry.fallbackChains`): keys whose value is a list of
 * strings only; {} when unreadable. Same default path as modelRoles(). */
export function modelFallbacks(
	configPath: string = defaultRolesPath(),
): Record<string, string[]> {
	try {
		const chains = (
			Bun.YAML.parse(readFileSync(configPath, "utf8")) as {
				retry?: { fallbackChains?: unknown } | null;
			} | null
		)?.retry?.fallbackChains;
		const out: Record<string, string[]> = {};
		if (typeof chains === "object" && chains !== null) {
			for (const [key, list] of Object.entries(chains)) {
				if (Array.isArray(list) && list.every((m) => typeof m === "string"))
					out[key] = list;
			}
		}
		return out;
	} catch {
		return {}; // no config: no chains
	}
}

/** The reason `selector` cannot be a filed card's model, or null when it can. The shape rule is
 *  the turn-start rule (src/tokens.ts: a selector with no provider part would park the card's
 *  first turn), the catalog rule is the model-roles editor's selector rule against the board's
 *  `omp models --json` selectors. A role name ("plan", "@plan") is refused: the board never
 *  resolves role names in a card's model, it stores the selector. An empty catalog (omp missing
 *  or junk output, the Default-only picker state) checks the shape only, so a broken omp never
 *  blocks card filing. Pure. */
export function cardModelError(
	selector: string,
	catalog: ReadonlySet<string>,
): string | null {
	if (selector.indexOf("/") <= 0)
		return `${selector} is not a model; omit model to use the board default, or pass provider/model such as anthropic/claude-opus-5-5`;
	if (catalog.size === 0) return null;
	const why = selectorError(selector, catalog);
	return why === null
		? null
		: `model ${selector}: ${why}. Omit model to use the board default, or pick provider/model from the New task model list`;
}

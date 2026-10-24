// Model catalog (`omp models`) and role assignments (the board's omp agent config.yml —
// PI_CODING_AGENT_DIR when pinned, else ~/.omp/agent).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { agentDir } from "./login.ts";

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

/** Role→model selectors from the board's omp agent config.yml (`modelRoles`, any `:level` thinking
 * suffix kept — omp selectors are `provider/model:level`); nonempty string values only; {} when
 * unreadable. */
export function modelRoles(
	configPath: string = join(agentDir(), "config.yml"),
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

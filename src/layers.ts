import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** One installed agent layer under `<home>/.alate/layers/<id>` (OTTR-451). */
export type AgentLayer = { id: string; dir: string };

export type LayerPin =
	| { ok: true; layer: AgentLayer; agentDir: string }
	| { ok: false; reason: "none" | "broken" | "prepare" };

const currentLink = (home: string): string => join(home, ".alate", "current");

/** Shared-state entries linked inside every pinned layer, even before the flat target exists. */
const LINK_ALWAYS = [
	".omp/agent/agent.db",
	".omp/agent/sessions",
	".omp/oauth",
	".omp/logs",
	".cache",
];

/** Layer content linked back to the flat home only when the flat home has it. */
const LINK_IF_SOURCE_EXISTS = [
	".gitconfig",
	".config/git",
	".config/gh",
	".ssh",
	".claude",
	".npm",
	".bun",
	".local",
];

/**
 * The layer `<home>/.alate/current` resolves to, or null (no link, or a link that does not
 * resolve — alate repairs the switch on its next provision).
 */
export function resolveAgentLayer(home: string): AgentLayer | null {
	const pin = pinTarget(home);
	return pin ? { id: basename(pin), dir: pin } : null;
}

/** Realpath of the current link, or null when it does not resolve. */
function pinTarget(home: string): string | null {
	try {
		return realpathSync(currentLink(home));
	} catch {
		return null;
	}
}

/**
 * Pin the current layer for one run: resolve it once, prepare the shared-state links, and
 * return the paths the run's env carries. A miss falls back to the flat home; a broken link
 * or a failed prepare does too (reason says which). The links are idempotent and safe under
 * concurrent pins. `memory.backend` in the layer's config.yml is not layer content (the
 * deployment picks the backend, OTTR-453): the pin never rewrites config.yml.
 */
export function pinnedAgentLayer(home: string): LayerPin {
	// A dangling link still lstats: only the lstat absence means "no layer".
	try {
		lstatSync(currentLink(home));
	} catch {
		return { ok: false, reason: "none" };
	}
	const dir = pinTarget(home);
	if (dir === null) return { ok: false, reason: "broken" };
	const layer = { id: basename(dir), dir };
	try {
		prepareLayer(home, layer);
	} catch {
		return { ok: false, reason: "prepare" };
	}
	return { ok: true, layer, agentDir: join(dir, ".omp", "agent") };
}

/** Symlink `linkPath` -> `target`; an entry already in the layer wins, an EEXIST race is fine. */
function linkOne(linkPath: string, target: string): void {
	mkdirSync(dirname(linkPath), { recursive: true });
	try {
		symlinkSync(target, linkPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
}

/**
 * Link the layer's shared state back to the flat home. Safe to call twice; never mutates an
 * entry that already exists in the layer, and never touches the layer's config.yml.
 */
function prepareLayer(home: string, layer: AgentLayer): void {
	for (const rel of LINK_ALWAYS) linkOne(join(layer.dir, rel), join(home, rel));
	for (const rel of LINK_IF_SOURCE_EXISTS) {
		const source = join(home, rel);
		// Missing target stays missing, as today: omp creates it in the layer, where it dies
		// with the layer at clean-up.
		if (existsSync(source)) linkOne(join(layer.dir, rel), source);
	}
}

// --- In-use registry -------------------------------------------------------
// `<home>/.alate/in-use.json`: which layers live runs pinned. The board is the only
// writer; alate reads it for clean-up. Every operation is best-effort: a corrupt or
// unwritable registry never fails a run, it only degrades clean-up (alate still keeps
// the last two layers).

type UseEntry = { id: string; since: number };

const inUsePath = (home: string): string => join(home, ".alate", "in-use.json");

function readRegistry(home: string): UseEntry[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(inUsePath(home), "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("layers" in parsed))
			return [];
		const layers = parsed.layers;
		if (!Array.isArray(layers)) return [];
		const valid: UseEntry[] = [];
		for (const entry of layers) {
			if (
				typeof entry !== "object" ||
				entry === null ||
				!("id" in entry) ||
				!("since" in entry)
			)
				continue;
			const { id, since } = entry;
			if (typeof id === "string" && typeof since === "number")
				valid.push({ id, since });
		}
		return valid;
	} catch {
		return [];
	}
}

function writeRegistry(home: string, entries: UseEntry[]): void {
	const path = inUsePath(home);
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const fd = openSync(tmp, "w");
		try {
			writeSync(fd, JSON.stringify({ layers: entries }));
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* nothing to clean */
		}
		console.warn(`! agent layer registry write failed: ${String(err)}`);
	}
}

/** Layers currently pinned by live runs, best-effort ([] when the registry is unreadable). */
export function readLayerUse(home: string): { id: string; since: number }[] {
	return readRegistry(home);
}

/** Record that a live run pinned `id`; refreshes `since` when the id is already listed. */
export function addLayerUse(home: string, id: string, since?: number): void {
	const entries = readRegistry(home).filter((e) => e.id !== id);
	try {
		entries.push({ id, since: since ?? Date.now() });
		writeRegistry(home, entries);
	} catch (err) {
		console.warn(`! agent layer registry update failed: ${String(err)}`);
	}
}

/** Drop every entry for `id`: the run settled. */
export function removeLayerUse(home: string, id: string): void {
	const kept = readRegistry(home).filter((e) => e.id !== id);
	try {
		writeRegistry(home, kept);
	} catch (err) {
		console.warn(`! agent layer registry update failed: ${String(err)}`);
	}
}

/** Replace the list with exactly `ids` (since = now), in order: the boot-time rebuild. */
export function rebuildLayerUse(home: string, ids: string[]): void {
	const now = Date.now();
	try {
		writeRegistry(
			home,
			ids.map((id) => ({ id, since: now })),
		);
	} catch (err) {
		console.warn(`! agent layer registry rebuild failed: ${String(err)}`);
	}
}

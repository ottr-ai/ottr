#!/usr/bin/env bun
// Exactly-once check for the Stryker area configs: every universe file is owned by
// exactly one area config, and no area config owns a file outside the universe
// (docs/specs/stryker-area-configs.md, "Exactly-once check"). Exit 0 the partition is
// exact; 1 findings exist, each printed. A config load failure throws.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { owns } from "./mutation-delta.ts";

/** One area config: its areaName string, its config file name, its mutate patterns. */
export interface AreaConfig {
	name: string;
	file: string;
	mutate: string[];
	/** The config's thresholds.break, or undefined when it ships no break. */
	break?: number | null;
}

/**
 * The recorded basis for each area config's break threshold. Every area needs one:
 * a threshold with no recorded basis is a guess (OTTR-1275 work-check blockers 2-11).
 * Each area's break is Math.min(90, Math.floor(score)) — AGENTS.md's measured-score
 * rule — and the area-threshold test enforces the pair against the real configs.
 * Today every entry carries the user-approved floor: the base config's measured full
 * score (76.48, 2026-10-31 at 16b3326, recorded in scripts/stryker-base.mjs),
 * approved for all ten areas on 2026-11-26 so no threshold drops. The full run after
 * the merge queue drains measures each area and replaces its entry with
 * { kind: "measured", score } and the config's break with its own measured score.
 */
export interface ThresholdBasis {
	kind: "measured" | "approved";
	/** The score the break derives from. */
	score: number;
}

export const THRESHOLD_BASIS: Record<string, ThresholdBasis> = {
	git: { kind: "approved", score: 76.48 },
	insights: { kind: "approved", score: 76.48 },
	integrations: { kind: "approved", score: 76.48 },
	ops: { kind: "approved", score: 76.48 },
	rest: { kind: "approved", score: 76.48 },
	store: { kind: "approved", score: 76.48 },
	supervisor: { kind: "approved", score: 76.48 },
	ui: { kind: "approved", score: 76.48 },
	vm: { kind: "approved", score: 76.48 },
	workers: { kind: "approved", score: 76.48 },
};

// The universe's patterns: the mutate array of the base config, read live so this check
// can never drift from it. A plain import takes no lock and wipes no sandbox: both are
// gated on isStrykerRun() in scripts/stryker-base.mjs. Dynamic import because the base
// config is an untyped .mjs and this card's target list cannot add the .d.mts a static
// import needs (same pattern as loadConfigs in scripts/mutation-delta.ts).
const basePath = join(import.meta.dir, "..", "stryker.config.mjs");
const baseModule = (await import(basePath)) as {
	default?: { mutate?: unknown };
};
const baseMutate = baseModule.default?.mutate;
if (!Array.isArray(baseMutate))
	throw new Error("stryker.config.mjs: default export has no mutate array");
const UNIVERSE_MUTATE: string[] = baseMutate.map(String);

/** The findings for the walked files against the area configs, sorted by message:
 * a universe file owned by no config or by 2+ configs, an area config owning a
 * non-universe file, an area config owning nothing. `universeFiles` is the walked
 * file list; universe membership comes from the base config's mutate array. */
export function collectFindings(
	universeFiles: string[],
	areas: AreaConfig[],
): string[] {
	const findings: string[] = [];
	for (const file of universeFiles) {
		const owners = areas.filter((area) => owns(area.mutate, file));
		if (!owns(UNIVERSE_MUTATE, file)) {
			for (const owner of owners) {
				findings.push(`${owner.name}: owns non-universe file ${file}`);
			}
		} else if (owners.length >= 2) {
			const names = owners
				.map((owner) => owner.name)
				.sort()
				.join(", ");
			findings.push(`${file}: owned by ${names}`);
		} else if (owners.length === 0) {
			findings.push(`${file}: owned by no area config`);
		}
	}
	for (const area of areas) {
		if (!universeFiles.some((file) => owns(area.mutate, file)))
			findings.push(`${area.name}: owns no file`);
	}
	return findings.sort();
}

/** One loaded config file: its file name and the default-export pieces the check reads. */
interface ConfigModule {
	name: string;
	mutate: unknown;
	areaName: unknown;
	break: unknown;
}

async function readConfigModule(
	repoRoot: string,
	name: string,
): Promise<ConfigModule> {
	const path = join(repoRoot, name);
	// Dynamic import: the config files exist only after readdirSync, so a static
	// import cannot name them at author time (runtime registry exception).
	const mod = (await import(path)) as {
		default?: { mutate?: unknown; thresholds?: { break?: unknown } };
		areaName?: unknown;
	};
	return {
		name,
		mutate: mod.default?.mutate,
		areaName: mod.areaName,
		break: mod.default?.thresholds?.break,
	};
}

/** Classifies one module as an area config: registers it (throwing on a duplicate
 * areaName) and returns it, or returns null when the module has no string areaName. */
function areaFromModule(
	mod: ConfigModule,
	byName: Map<string, AreaConfig>,
): AreaConfig | null {
	if (typeof mod.areaName !== "string") return null;
	const area: AreaConfig = {
		name: mod.areaName,
		file: mod.name,
		mutate: Array.isArray(mod.mutate) ? mod.mutate.map(String) : [],
		break: typeof mod.break === "number" ? mod.break : null,
	};
	const dup = byName.get(area.name);
	if (dup)
		throw new Error(
			`${dup.file} and ${mod.name}: duplicate areaName "${area.name}"`,
		);
	byName.set(area.name, area);
	return area;
}

/** The universe mutate patterns from the base config module, or null for any other
 * module. Throws when the base config ships no mutate array. */
function universeFromModule(mod: ConfigModule): string[] | null {
	if (mod.name !== "stryker.config.mjs") return null;
	if (!Array.isArray(mod.mutate))
		throw new Error(`${mod.name}: default export has no mutate array`);
	return mod.mutate.map(String);
}

/** Reads every stryker*.config.mjs at the repo root. A module exporting a string
 * areaName is an area config; stryker.config.mjs is the universe source. Throws on a
 * duplicate areaName and when the universe source is missing or ships no mutate array. */
export async function loadConfigs(repoRoot: string): Promise<{
	universe: string[];
	areas: AreaConfig[];
}> {
	const names = readdirSync(repoRoot)
		.filter((f) => /^stryker.*\.config\.mjs$/.test(f))
		.sort();
	const areas: AreaConfig[] = [];
	const byName = new Map<string, AreaConfig>();
	let universe: string[] | null = null;
	for (const name of names) {
		const mod = await readConfigModule(repoRoot, name);
		const area = areaFromModule(mod, byName);
		if (area) {
			areas.push(area);
			continue;
		}
		const moduleUniverse = universeFromModule(mod);
		if (moduleUniverse) universe = moduleUniverse;
		// The other areaName-less configs (release, turn, worktree, update-image) are
		// module configs; the delta gate reads them, not this check.
	}
	if (!universe)
		throw new Error(
			"stryker.config.mjs: no universe source config at the repo root",
		);
	return { universe, areas };
}

/** Every .ts and .js file under <repoRoot>/src and <repoRoot>/extension, POSIX-relative
 * and sorted. Only those two kinds appear in the universe patterns, so assets (.tsx,
 * .css, images) stay out of the partition's domain. */
export function walkSourceFiles(repoRoot: string): string[] {
	const files: string[] = [];
	const walk = (root: string, prefix: string) => {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const rel = `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(join(root, entry.name), rel);
			else if (/\.(ts|js)$/.test(entry.name)) files.push(rel);
		}
	};
	walk(join(repoRoot, "src"), "src");
	walk(join(repoRoot, "extension"), "extension");
	return files.sort();
}

export async function main(): Promise<number> {
	const repoRoot = join(import.meta.dir, "..");
	const { universe, areas } = await loadConfigs(repoRoot);
	const walked = walkSourceFiles(repoRoot);
	const findings = collectFindings(walked, areas);
	if (findings.length > 0) {
		for (const finding of findings) console.error(finding);
		return 1;
	}
	const universeCount = walked.filter((file) => owns(universe, file)).length;
	console.log(
		`stryker-areas: ${universeCount} universe files across ${areas.length} area configs`,
	);
	return 0;
}

if (import.meta.main) process.exit(await main());

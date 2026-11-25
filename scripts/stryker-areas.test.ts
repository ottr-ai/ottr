// Tests for the exactly-once check of the Stryker area configs: hermetic fixtures for
// collectFindings, plus one test over the real configs and the real tree
// (docs/specs/stryker-area-configs.md, "Exactly-once check").
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type AreaConfig,
	collectFindings,
	loadConfigs,
	walkSourceFiles,
} from "./stryker-areas.ts";

describe("collectFindings", () => {
	test("reports a file claimed by two configs and a universe file claimed by none", () => {
		const areas: AreaConfig[] = [
			{
				name: "store",
				file: "stryker.store.config.mjs",
				mutate: ["src/shared.ts"],
			},
			{
				name: "vm",
				file: "stryker.vm.config.mjs",
				mutate: ["src/shared.ts"],
			},
		];
		expect(collectFindings(["src/shared.ts", "src/orphan.ts"], areas)).toEqual([
			"src/orphan.ts: owned by no area config",
			"src/shared.ts: owned by store, vm",
		]);
	});

	test("reports an area config owning a file the universe negates", () => {
		const areas: AreaConfig[] = [
			{
				name: "vm",
				file: "stryker.vm.config.mjs",
				mutate: ["src/**"],
			},
		];
		expect(collectFindings(["src/app.ts"], areas)).toEqual([
			"vm: owns non-universe file src/app.ts",
		]);
	});

	test("reports an area config owning nothing", () => {
		const areas: AreaConfig[] = [
			{
				name: "empty",
				file: "stryker.empty.config.mjs",
				mutate: ["src/nowhere/**"],
			},
		];
		expect(collectFindings([], areas)).toEqual(["empty: owns no file"]);
	});

	test("reports nothing on an exact partition", () => {
		const areas: AreaConfig[] = [
			{
				name: "store",
				file: "stryker.store.config.mjs",
				mutate: ["src/store*.ts", "!**/*.test.ts", "!src/app.ts"],
			},
			{
				name: "git",
				file: "stryker.git.config.mjs",
				mutate: ["src/git*.ts", "!**/*.test.ts", "!src/app.ts"],
			},
		];
		const files = [
			"src/app.ts",
			"src/gitHttp.ts",
			"src/store.test.ts",
			"src/storeSqlite.ts",
		];
		expect(collectFindings(files, areas)).toEqual([]);
	});
});

describe("loadConfigs and walkSourceFiles on the real tree", () => {
	test("the real area configs partition the real universe", async () => {
		const repoRoot = join(import.meta.dir, "..");
		const { universe, areas } = await loadConfigs(repoRoot);
		expect(areas.map((area) => area.name).sort()).toEqual([
			"git",
			"insights",
			"integrations",
			"ops",
			"rest",
			"store",
			"supervisor",
			"ui",
			"vm",
			"workers",
		]);
		expect(universe.length).toBeGreaterThan(0);
		expect(collectFindings(walkSourceFiles(repoRoot), areas)).toEqual([]);
	});
});

import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

// dev.ts is entry-only side effects behind an exported bootstrap(): it seeds the scratch
// root, points the tracker env at it, then imports the server. Mock the seed and the
// server so the bootstrap stays pure enough to assert on.
describe("dev board bootstrap", () => {
	test("seeds the .dev root, points the env at it, and loads the server", async () => {
		const seeded: string[] = [];
		const serverLoads: number[] = [];
		mock.module("../scripts/demo-data.ts", () => ({
			seedDemo: (root: string) => {
				seeded.push(root);
			},
		}));
		mock.module("./server.ts", () => {
			serverLoads.push(1);
			return {};
		});

		const prev: Record<string, string | undefined> = { ...process.env };
		try {
			// Dynamic import is the point: the module itself is import-safe (its entry
			// behavior lives in bootstrap(), called below), and the mocks must be
			// registered before bootstrap runs — an unmocked import would start the
			// real server before this test can intercept.
			const { bootstrap } = await import("./dev.ts");
			await bootstrap();
			const root = resolve(import.meta.dir, "..", ".dev");
			expect(seeded).toEqual([root]);
			expect(process.env.OMP_TRACKER_ROOTS).toBe(root);
			expect(process.env.OTTR_STATE_DIR).toBe(
				prev.OTTR_STATE_DIR ?? resolve(root, "state"),
			);
			expect(process.env.OMP_TRACKER_MAX_TOTAL).toBe("none");
			// The sweeps must leave the fabricated running/preparing cards alone.
			expect(process.env.OTTR_DEMO).toBe("1");
			expect(serverLoads).toHaveLength(1);
		} finally {
			// Exact restore: snapshot keys keep (or lose) their old value; keys the
			// bootstrap ADDED must be deleted, or later test files in this process
			// inherit them (a leaked OTTR_DEMO silenced the sweeps in turn.test.ts).
			for (const key of Object.keys(process.env)) {
				if (!Object.hasOwn(prev, key)) delete process.env[key];
			}
			for (const [key, value] of Object.entries(prev)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("the bootstrap leaks no added env keys into later test files", () => {
		// dev.ts sets these unconditionally; the restore must remove them again or the
		// leaked OTTR_DEMO silences the sweeps under turn.test.ts (CI run 38825437929).
		expect(process.env.OTTR_DEMO).toBeUndefined();
		expect(process.env.OMP_TRACKER_MAX_TOTAL).toBeUndefined();
	});
});

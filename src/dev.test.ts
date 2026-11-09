import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// dev.ts is entry-only side effects behind an exported bootstrap(): it seeds the scratch
// root, points the tracker env at it, then imports the server. Mock the seed and the
// server so the bootstrap stays pure enough to assert on.
describe("dev board bootstrap", () => {
	const seeded: string[] = [];
	const serverLoads: number[] = [];
	let held: string | null = null;
	mock.module("../scripts/demo-data.ts", () => ({
		heldDb: () => held,
		seedDemo: (root: string) => {
			seeded.push(root);
		},
	}));
	mock.module("./server.ts", () => {
		serverLoads.push(1);
		return {};
	});

	/** Run bootstrap with the env restored exactly afterwards: snapshot keys keep (or lose)
	 * their old value; keys the bootstrap ADDED must be deleted, or later test files in this
	 * process inherit them (a leaked OTTR_DEMO silenced the sweeps in turn.test.ts). */
	async function boot(
		env: Record<string, string>,
		check: (prev: Record<string, string | undefined>) => void,
	): Promise<void> {
		const prev: Record<string, string | undefined> = { ...process.env };
		try {
			delete process.env.OTTR_STATE_DIR;
			delete process.env.PORT;
			Object.assign(process.env, env);
			// Dynamic import is the point: the module itself is import-safe (its entry
			// behavior lives in bootstrap(), called here), and the mocks must be
			// registered before bootstrap runs — an unmocked import would start the
			// real server before this test can intercept.
			const { bootstrap } = await import("./dev.ts");
			await bootstrap();
			check(prev);
		} finally {
			for (const key of Object.keys(process.env)) {
				if (!Object.hasOwn(prev, key)) delete process.env[key];
			}
			for (const [key, value] of Object.entries(prev)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	test("seeds a fresh root under .dev, points the env at it, and loads the server", async () => {
		await boot({}, () => {
			const dev = resolve(import.meta.dir, "..", ".dev");
			expect(seeded).toHaveLength(1);
			expect(seeded[0]!.startsWith(resolve(dev, "board-"))).toBe(true);
			expect(seeded[0]).not.toBe(dev);
			expect(process.env.OMP_TRACKER_ROOTS).toBe(seeded[0]);
			expect(process.env.OTTR_STATE_DIR).toBe(resolve(seeded[0]!, "state"));
			expect(process.env.PORT).toBe("5747");
			expect(process.env.OMP_TRACKER_MAX_TOTAL).toBe("none");
			// The sweeps must leave the fabricated running/preparing cards alone.
			expect(process.env.OTTR_DEMO).toBe("1");
			expect(serverLoads).toHaveLength(1);
		});
	});

	test("a .dev root held by another board seeds a root of its own per port", async () => {
		held = "/x/.dev/lumen/.tasks/tasks.db";
		seeded.length = 0;
		try {
			// The workers home is set so the env fixture is written to a temp dir, not to
			// a .dev-5801 folder in the checkout.
			const home = mkdtempSync(join(tmpdir(), "dev-board-"));
			await boot({ PORT: "5801", OTTR_WORKERS_HOME: home }, () => {
				const root = resolve(import.meta.dir, "..", ".dev-5801");
				expect(seeded).toEqual([root]);
				expect(process.env.OMP_TRACKER_ROOTS).toBe(root);
				expect(process.env.OTTR_STATE_DIR).toBe(resolve(root, "state"));
			});
		} finally {
			held = null;
		}
	});

	test("seeds a pinned OTTR_DEV_ROOT instead of a fresh one", async () => {
		seeded.length = 0;
		const pinned = join(tmpdir(), "ottr-dev-root-pin-test");
		await boot({ OTTR_DEV_ROOT: pinned }, () => {
			expect(seeded).toEqual([pinned]);
			expect(process.env.OMP_TRACKER_ROOTS).toBe(pinned);
		});
	});

	test("the bootstrap leaks no added env keys into later test files", () => {
		// dev.ts sets these unconditionally; the restore must remove them again or the
		// leaked OTTR_DEMO silences the sweeps under turn.test.ts (CI run 38825437929).
		expect(process.env.OTTR_DEMO).toBeUndefined();
		expect(process.env.OMP_TRACKER_MAX_TOTAL).toBeUndefined();
	});
});

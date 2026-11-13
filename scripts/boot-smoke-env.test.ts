import { afterEach, describe, expect, test } from "bun:test";
import fc from "../src/test/properties.ts";
import { INHERITED, smokeEnv } from "./boot-smoke-env.ts";

// ALLOWED[key] is true for every key the booted server may inherit.
const ALLOWED: Record<string, true> = Object.fromEntries(
	INHERITED.map((key) => [key, true as const]),
);

// Keys the tests stage; afterEach restores the caller's exact env.
const TOUCHED: string[] = [
	...INHERITED,
	"OTTR_VM_RUNNER_URL",
	"OTTR_WORKER_TOKEN",
	"OTTR_BOARD_URL",
	"OTTR_BOARD_TOKEN",
];

const saved = new Map<string, string | undefined>();
afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
});

/** stage() writes through the real process.env, so smokeEnv reads the same
 * source the boot smoke's spawn reads — no stubbed env record. */
function stage(patch: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(patch)) {
		if (!TOUCHED.includes(key)) TOUCHED.push(key);
		if (!saved.has(key)) saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

describe("smokeEnv", () => {
	test("host runtime plumbing never reaches the booted server (OTTR-891)", () => {
		stage({
			PATH: "/usr/bin:/bin",
			HOME: "/home/smoke",
			NODE_ENV: undefined,
			TMPDIR: undefined,
			OTTR_VM_RUNNER_URL: "http://vm-runner:8787",
			OTTR_WORKER_TOKEN: undefined,
			OTTR_BOARD_URL: "http://ottr:4852",
			OTTR_BOARD_TOKEN: "board-token",
		});
		const env = smokeEnv({
			PORT: "4999",
			OMP_TRACKER_ROOTS: "/tmp/roots",
			OTTR_STATE_DIR: "/tmp/roots/state",
		});
		expect(env.OTTR_VM_RUNNER_URL).toBeUndefined();
		expect(env.OTTR_WORKER_TOKEN).toBeUndefined();
		expect(env.OTTR_BOARD_URL).toBeUndefined();
		expect(env.OTTR_BOARD_TOKEN).toBeUndefined();
		expect(env.PORT).toBe("4999");
		expect(env.OMP_TRACKER_ROOTS).toBe("/tmp/roots");
		expect(env.OTTR_STATE_DIR).toBe("/tmp/roots/state");
		expect(env.PATH).toBe("/usr/bin:/bin");
		expect(env.HOME).toBe("/home/smoke");
		expect(env.NODE_ENV).toBeUndefined();
	});

	test("a smoke case that needs a runner sets both keys explicitly", () => {
		stage({
			OTTR_VM_RUNNER_URL: "http://vm-runner:8787",
			OTTR_WORKER_TOKEN: undefined,
		});
		const env = smokeEnv({
			OTTR_VM_RUNNER_URL: "http://127.0.0.1:8787",
			OTTR_WORKER_TOKEN: "case-token",
		});
		expect(env.OTTR_VM_RUNNER_URL).toBe("http://127.0.0.1:8787");
		expect(env.OTTR_WORKER_TOKEN).toBe("case-token");
	});

	test("property: only allowlisted keys survive, overrides always win", () => {
		stage({ PATH: "/usr/bin:/bin", HOME: "/home/smoke" });
		const foreignKey = fc
			.stringMatching(/^[A-Z][A-Z0-9_]{0,23}$/)
			.filter((key) => !(key in ALLOWED) && key !== "PORT");
		const property = fc.property(
			fc.uniqueArray(foreignKey, { minLength: 1, maxLength: 8 }),
			(keys) => {
				const patch: Record<string, string> = {};
				for (const key of keys) patch[key] = "host-value";
				stage(patch);
				const env = smokeEnv({ PORT: "1" });
				for (const key of keys) expect(env[key]).toBeUndefined();
				expect(env.PORT).toBe("1");
				expect(env.PATH).toBe("/usr/bin:/bin");
				expect(env.HOME).toBe("/home/smoke");
			},
		);
		fc.assert(property);
	});
});

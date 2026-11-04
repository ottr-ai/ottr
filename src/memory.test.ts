import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkMemoryHealth,
	ensureMemoryOverlay,
	memoryBackendFromEnv,
	memoryOverlayYaml,
	overlayPathFor,
} from "./memory.ts";
import fc from "./test/properties.ts";

describe("memoryBackendFromEnv", () => {
	test("a set URL picks hindsight with the trimmed, slash-stripped URL and the token", () => {
		expect(
			memoryBackendFromEnv({
				HINDSIGHT_API_URL: " http://hindsight:8888/ ",
				HINDSIGHT_API_TOKEN: "k",
			}),
		).toEqual({
			backend: "hindsight",
			url: "http://hindsight:8888",
			token: "k",
		});
	});

	test("an unset URL picks mnemopi (spec acceptance: unset -> mnemopi)", () => {
		expect(memoryBackendFromEnv({})).toEqual({ backend: "mnemopi" });
	});

	test("an empty or whitespace URL picks mnemopi; the token defaults to empty", () => {
		expect(memoryBackendFromEnv({ HINDSIGHT_API_URL: "" })).toEqual({
			backend: "mnemopi",
		});
		expect(memoryBackendFromEnv({ HINDSIGHT_API_URL: "   " })).toEqual({
			backend: "mnemopi",
		});
		expect(memoryBackendFromEnv({ HINDSIGHT_API_URL: "http://h:1" })).toEqual({
			backend: "hindsight",
			url: "http://h:1",
			token: "",
		});
	});
});

describe("overlay", () => {
	test("the yaml names exactly the chosen backend", () => {
		expect(memoryOverlayYaml({ backend: "mnemopi" })).toBe(
			"memory:\n  backend: mnemopi\n",
		);
		expect(
			memoryOverlayYaml({ backend: "hindsight", url: "http://h:1", token: "" }),
		).toBe("memory:\n  backend: hindsight\n");
	});

	test("overlayPathFor honors OTTR_DATA_DIR and falls back to tmpdir", () => {
		expect(overlayPathFor({ OTTR_DATA_DIR: "/data" })).toBe(
			join("/data", "omp-memory.yml"),
		);
		expect(overlayPathFor({ OTTR_DATA_DIR: "" })).toBe(
			join(tmpdir(), "ottr-omp-memory.yml"),
		);
		expect(overlayPathFor({})).toBe(join(tmpdir(), "ottr-omp-memory.yml"));
	});
});

describe("ensureMemoryOverlay", () => {
	test("creates the file when missing and converges stale content", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-memory-"));
		try {
			const path = ensureMemoryOverlay({ OTTR_DATA_DIR: dir });
			expect(readFileSync(path, "utf8")).toBe("memory:\n  backend: mnemopi\n");

			// A volume that once got hindsight converges back when the deployment drops the URL.
			writeFileSync(path, "memory:\n  backend: hindsight\n");
			expect(ensureMemoryOverlay({ OTTR_DATA_DIR: dir })).toBe(path);
			expect(readFileSync(path, "utf8")).toBe("memory:\n  backend: mnemopi\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an already-correct file is left byte-identical (no rewrite needed)", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-memory-"));
		try {
			const path = join(dir, "omp-memory.yml");
			writeFileSync(path, "memory:\n  backend: mnemopi\n");
			const before = readFileSync(path, "utf8");
			ensureMemoryOverlay({ OTTR_DATA_DIR: dir });
			expect(readFileSync(path, "utf8")).toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("creates the data dir when missing and throws when its parent is a file", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-memory-"));
		try {
			const nested = join(dir, "data");
			const path = ensureMemoryOverlay({ OTTR_DATA_DIR: nested });
			expect(readFileSync(path, "utf8")).toBe("memory:\n  backend: mnemopi\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}

		const dir2 = mkdtempSync(join(tmpdir(), "ottr-memory-"));
		try {
			// The target dir's parent is a plain file, so the mkdir below it fails loudly.
			const blocker = join(dir2, "blocker");
			writeFileSync(blocker, "x");
			expect(() =>
				ensureMemoryOverlay({ OTTR_DATA_DIR: join(blocker, "data") }),
			).toThrow();
		} finally {
			rmSync(dir2, { recursive: true, force: true });
		}
	});
});

describe("checkMemoryHealth", () => {
	const at = new Date(1_700_000_000_000).toISOString();
	// Fixed clock seam: checkedAt must come from the injected now, not the wall.
	const now = () => 1_700_000_000_000;

	test("hindsight 200 is ok (spec acceptance: URL set -> hindsight)", async () => {
		const seen: { url: string; init?: RequestInit }[] = [];
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			seen.push({ url: String(url), init });
			return new Response("[]", { status: 200 });
		}) as unknown as typeof fetch;
		const h = await checkMemoryHealth(
			{ backend: "hindsight", url: "http://h:8888", token: "secret" },
			{ fetchImpl, now },
		);
		expect(h).toEqual({
			backend: "hindsight",
			ok: true,
			reason: null,
			checkedAt: at,
		});
		expect(seen[0]?.url).toBe("http://h:8888/v1/default/banks");
		expect(seen[0]?.init?.headers).toEqual({
			authorization: "Bearer secret",
		});
	});

	test("hindsight 401 and 500 produce the spec reasons; the token never appears", async () => {
		for (const status of [401, 500]) {
			const fetchImpl = (async () =>
				new Response("nope", { status })) as unknown as typeof fetch;
			const h = await checkMemoryHealth(
				{ backend: "hindsight", url: "http://h:8888", token: "sekret" },
				{ fetchImpl, now },
			);
			expect(h.ok).toBe(false);
			if (status === 401)
				expect(h.reason).toBe(
					"Hindsight at http://h:8888 rejected the key (HTTP 401)",
				);
			else
				expect(h.reason).toBe("Hindsight at http://h:8888 answered HTTP 500");
			expect(h.reason).not.toContain("sekret");
		}
	});

	test("a transport error produces the did-not-answer reason (spec acceptance: unreachable -> warning)", async () => {
		const fetchImpl = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const h = await checkMemoryHealth(
			{ backend: "hindsight", url: "http://h:8888", token: "" },
			{ fetchImpl, now },
		);
		expect(h.ok).toBe(false);
		expect(h.reason).toBe(
			"Hindsight at http://h:8888 did not answer: ECONNREFUSED",
		);
	});

	test("a writable mnemopi store is ok for the home and a different board home", async () => {
		const home = mkdtempSync(join(tmpdir(), "ottr-memory-home-"));
		const board = mkdtempSync(join(tmpdir(), "ottr-memory-board-"));
		try {
			const h = await checkMemoryHealth(
				{ backend: "mnemopi" },
				{ home, boardHome: board, now },
			);
			expect(h).toEqual({
				backend: "mnemopi",
				ok: true,
				reason: null,
				checkedAt: at,
			});
			// Both stores exist (mkdir -p ran) and the probe file is gone after the check.
			for (const base of [home, board])
				expect(() =>
					readFileSync(
						join(
							base,
							".omp",
							"agent",
							"memories",
							"mnemopi",
							"ottr-memory-health-probe",
						),
					),
				).toThrow();
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(board, { recursive: true, force: true });
		}
	});

	test("an unwritable mnemopi store names the failing path", async () => {
		// home is fine, the board home sits under a plain file: mkdir fails there
		// even for root, and the reason names that store path.
		const home = mkdtempSync(join(tmpdir(), "ottr-memory-home-"));
		const board = mkdtempSync(join(tmpdir(), "ottr-memory-board-"));
		try {
			const blocker = join(board, "file");
			writeFileSync(blocker, "x");
			const h = await checkMemoryHealth(
				{ backend: "mnemopi" },
				{ home, boardHome: blocker, now },
			);
			expect(h.ok).toBe(false);
			expect(h.reason).toBe(
				`mnemopi store not writable: ${join(blocker, ".omp", "agent", "memories", "mnemopi")}`,
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(board, { recursive: true, force: true });
		}
	});
});

describe("properties", () => {
	const envValue = fc.oneof(
		fc.constant(undefined),
		fc.stringMatching(/^[ -~]{0,40}$/),
	);
	const envRecord = fc.record({
		HINDSIGHT_API_URL: envValue,
		HINDSIGHT_API_TOKEN: envValue,
		OTTR_DATA_DIR: fc.option(fc.stringMatching(/^[ -~]{1,40}$/), {
			nil: undefined,
		}),
	});

	test("hindsight iff the trimmed URL is non-empty; the overlay names exactly that backend", () => {
		fc.assert(
			fc.property(envRecord, (env) => {
				const choice = memoryBackendFromEnv(env);
				const url = env.HINDSIGHT_API_URL?.trim();
				expect(choice.backend === "hindsight").toBe(!!url);
				const yaml = memoryOverlayYaml(choice);
				const lines = yaml.split("\n").filter((l) => l.includes("backend:"));
				expect(lines).toEqual([`  backend: ${choice.backend}`]);
				expect(yaml.startsWith("memory:\n")).toBe(true);
			}),
		);
	});
});

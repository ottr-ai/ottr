import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	acquireLayerUse,
	isLayerId,
	type LayerLedger,
	ledgerText,
	parseLayerLedger,
	pinnedAgentLayer,
	readLayerUse,
	rebuildLayerUse,
	resolveAgentLayer,
} from "./layers.ts";
import fc from "./test/properties.ts";

const HINDSIGHT = "https://hindsight.example/api";

/** A minimal installed layer: the allowlist content alate's install writes. */
function makeLayer(home: string, id: string): string {
	const dir = join(home, ".alate", "layers", id);
	mkdirSync(join(dir, ".omp", "agent"), { recursive: true });
	mkdirSync(join(dir, ".omp", "plugins"), { recursive: true });
	mkdirSync(join(dir, ".agents"), { recursive: true });
	writeFileSync(
		join(dir, ".omp", "agent", "config.yml"),
		"model: x\n  backend: mnemopi\n",
	);
	writeFileSync(join(dir, ".omp", "plugins", "p.yml"), "plugins: []\n");
	writeFileSync(join(dir, ".agents", "skills.md"), "# skills\n");
	return dir;
}

/** Switch `.alate/current` atomically, the way alate does: temp symlink + rename. */
function switchCurrent(home: string, id: string): void {
	const tmp = join(home, ".alate", `current.${process.pid}.tmp`);
	symlinkSync(join("layers", id), tmp);
	renameSync(tmp, join(home, ".alate", "current"));
}

const dirs: string[] = [];
const tempHome = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ottr-layers-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs)
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("resolveAgentLayer", () => {
	test("no layer -> null", () => {
		expect(resolveAgentLayer(tempHome())).toBeNull();
	});

	test("current -> the layer dir with id = basename", () => {
		const home = tempHome();
		const dir = makeLayer(home, "abc1");
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(resolveAgentLayer(home)).toEqual({
			id: "abc1",
			dir: realpathSync(dir),
		});
	});

	test("a broken link (dangling symlink) -> null", () => {
		const home = tempHome();
		mkdirSync(join(home, ".alate"), { recursive: true });
		symlinkSync(join("layers", "gone"), join(home, ".alate", "current"));
		expect(resolveAgentLayer(home)).toBeNull();
	});
});

describe("pinnedAgentLayer", () => {
	test("no link -> reason none", () => {
		expect(pinnedAgentLayer(tempHome())).toEqual({
			ok: false,
			reason: "none",
		});
	});

	test("broken link -> reason broken", () => {
		const home = tempHome();
		mkdirSync(join(home, ".alate"), { recursive: true });
		symlinkSync(join("layers", "gone"), join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home)).toEqual({
			ok: false,
			reason: "broken",
		});
	});

	test("unwritable layer -> reason prepare", () => {
		const home = tempHome();
		const dir = join(home, ".alate", "layers", "ro1");
		mkdirSync(dirname(dir), { recursive: true });
		// `.omp/agent` as a regular file: creating the agent.db link's parent fails, so the
		// prepare throws and the pin falls back. Deterministic even when tests run as root.
		mkdirSync(join(dir, ".omp"), { recursive: true });
		writeFileSync(join(dir, ".omp", "agent"), "not a dir\n");
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home)).toEqual({
			ok: false,
			reason: "prepare",
		});
	});

	test("success returns the layer and the agent dir; config.yml ships as installed", () => {
		const home = tempHome();
		const dir = makeLayer(home, "ok1");
		symlinkSync(dir, join(home, ".alate", "current"));
		const pin = pinnedAgentLayer(home);
		if (!pin.ok)
			throw new Error(`expected a pinned layer: ${JSON.stringify(pin)}`);
		expect(pin.layer.id).toBe("ok1");
		expect(pin.layer.dir).toBe(realpathSync(dir));
		expect(pin.agentDir).toBe(join(realpathSync(dir), ".omp", "agent"));
		// memory.backend is not layer content (OTTR-453): the pin never rewrites config.yml,
		// not even when the deployment env names a Hindsight URL.
		const saved = process.env.HINDSIGHT_API_URL;
		process.env.HINDSIGHT_API_URL = HINDSIGHT;
		try {
			expect(pinnedAgentLayer(home).ok).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.HINDSIGHT_API_URL;
			else process.env.HINDSIGHT_API_URL = saved;
		}
		expect(readFileSync(join(dir, ".omp", "agent", "config.yml"), "utf8")).toBe(
			"model: x\n  backend: mnemopi\n",
		);
	});
});

describe("layer prepare", () => {
	test("ALWAYS links exist even when the flat target does not exist yet", () => {
		const home = tempHome();
		const dir = makeLayer(home, "link1");
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home).ok).toBe(true);
		const expectLink = (rel: string): void => {
			const link = join(dir, rel);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readlinkSync(link)).toBe(join(home, rel)); // absolute target into the flat home
			expect(existsSync(link)).toBe(false); // the flat target is still absent
		};
		expectLink(".omp/agent/agent.db");
		expectLink(".omp/agent/sessions");
		expectLink(".omp/oauth");
		expectLink(".omp/logs");
		expectLink(".cache");
		// IF-EXIST sources absent: the layer stays without them.
		expect(existsSync(join(dir, ".gitconfig"))).toBe(false);
		expect(existsSync(join(dir, ".ssh"))).toBe(false);
	});

	test("IF-EXIST list is linked only when the source exists", () => {
		const home = tempHome();
		const dir = makeLayer(home, "link2");
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = t\n");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home).ok).toBe(true);
		expect(readlinkSync(join(dir, ".gitconfig"))).toBe(
			join(home, ".gitconfig"),
		);
		expect(readlinkSync(join(dir, ".ssh"))).toBe(join(home, ".ssh"));
		expect(existsSync(join(dir, ".config/gh"))).toBe(false);
		expect(existsSync(join(dir, ".npm"))).toBe(false);
	});

	test("an existing layer entry is untouched and the second call is idempotent", () => {
		const home = tempHome();
		const dir = makeLayer(home, "link3");
		// The layer already carries its own .cache content: the pin must not replace it.
		mkdirSync(join(dir, ".cache"), { recursive: true });
		writeFileSync(join(dir, ".cache", "keep.txt"), "layer content\n");
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home).ok).toBe(true);
		expect(pinnedAgentLayer(home).ok).toBe(true);
		expect(readFileSync(join(dir, ".cache", "keep.txt"), "utf8")).toBe(
			"layer content\n",
		);
		expect(lstatSync(join(dir, ".cache")).isSymbolicLink()).toBe(false);
		// No temp leftovers from the pin.
		expect(readdirSync(join(dir, ".omp", "agent")).sort()).toEqual([
			"agent.db",
			"config.yml",
			"sessions",
		]);
	});
});

describe("memory backend is not layer content", () => {
	test("the pin never rewrites the layer's config.yml, env or not", () => {
		const home = tempHome();
		const dir = makeLayer(home, "keep");
		writeFileSync(
			join(dir, ".omp", "agent", "config.yml"),
			"keep: a  backend: mnemopi\n  backend: mnemopi # keep\n",
		);
		symlinkSync(dir, join(home, ".alate", "current"));
		const saved = process.env.HINDSIGHT_API_URL;
		process.env.HINDSIGHT_API_URL = HINDSIGHT;
		try {
			expect(pinnedAgentLayer(home).ok).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.HINDSIGHT_API_URL;
			else process.env.HINDSIGHT_API_URL = saved;
		}
		expect(readFileSync(join(dir, ".omp", "agent", "config.yml"), "utf8")).toBe(
			"keep: a  backend: mnemopi\n  backend: mnemopi # keep\n",
		);
	});

	test("a layer that already ships hindsight stays byte-identical", () => {
		const home = tempHome();
		const dir = makeLayer(home, "keep2");
		const text = "model: x\n  backend: hindsight\n";
		writeFileSync(join(dir, ".omp", "agent", "config.yml"), text);
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home).ok).toBe(true);
		expect(readFileSync(join(dir, ".omp", "agent", "config.yml"), "utf8")).toBe(
			text,
		);
	});

	test("missing config file -> no-op, the pin still succeeds", () => {
		const home = tempHome();
		const dir = join(home, ".alate", "layers", "flip");
		mkdirSync(dir, { recursive: true });
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home).ok).toBe(true);
		expect(existsSync(join(dir, ".omp", "agent", "config.yml"))).toBe(false);
	});
});
describe("in-use registry", () => {
	test("one entry per id with the earliest since; each release frees one lease", () => {
		const home = tempHome();
		const a1 = acquireLayerUse(home, "a", 9);
		const a2 = acquireLayerUse(home, "a", 5);
		const b = acquireLayerUse(home, "b", 7);
		expect(readLayerUse(home)).toEqual([
			{ id: "a", since: 5 },
			{ id: "b", since: 7 },
		]);
		a2();
		expect(readLayerUse(home)).toEqual([
			{ id: "a", since: 9 },
			{ id: "b", since: 7 },
		]);
		a1();
		a1(); // a repeated release is a no-op
		expect(readLayerUse(home)).toEqual([{ id: "b", since: 7 }]);
		b();
		expect(readLayerUse(home)).toEqual([]);
	});

	test("rebuild replaces the recovery rows in order with since = now", () => {
		const home = tempHome();
		rebuildLayerUse(home, ["old"]);
		const before = Date.now();
		rebuildLayerUse(home, ["x", "y", "x"]);
		const entries = readLayerUse(home);
		expect(entries.map((e) => e.id)).toEqual(["x", "y"]);
		for (const e of entries) expect(e.since).toBeGreaterThanOrEqual(before);
	});

	test("an unreadable public registry without a ledger fails closed: its holders are unknown", () => {
		// OTTR-1132: before, the corrupt file read as [] and the next add replaced it, which
		// dropped every legacy holder it might list. Now the acquisition fails, the rebuild
		// warns, and the bytes stay for alate's clean-up to refuse.
		for (const text of [
			"{not json",
			'{"layers":"nope"}',
			'{"layers":[{"id":"a"}]}',
			'{"layers":[{"id":"..","since":1}]}',
			'{"layers":[],"extra":1}',
		]) {
			const home = tempHome();
			mkdirSync(join(home, ".alate"), { recursive: true });
			writeFileSync(join(home, ".alate", "in-use.json"), text);
			expect(() => acquireLayerUse(home, "rec")).toThrow(
				"unreadable agent layer registry",
			);
			const warns: string[] = [];
			const original = console.warn;
			console.warn = (...parts: unknown[]) => warns.push(parts.join(" "));
			try {
				rebuildLayerUse(home, ["rec"]);
			} finally {
				console.warn = original;
			}
			expect(warns.join("\n")).toContain("unreadable agent layer registry");
			expect(readFileSync(join(home, ".alate", "in-use.json"), "utf8")).toBe(
				text,
			);
			expect(existsSync(join(home, ".alate", "in-use.owners.json"))).toBe(
				false,
			);
		}
	});

	test("an empty public registry without a ledger holds no entry", () => {
		const home = tempHome();
		mkdirSync(join(home, ".alate"), { recursive: true });
		writeFileSync(join(home, ".alate", "in-use.json"), "");
		const release = acquireLayerUse(home, "rec", 2);
		expect(readLayerUse(home)).toEqual([{ id: "rec", since: 2 }]);
		release();
		expect(readLayerUse(home)).toEqual([]);
	});

	test("a missing registry reads as [] and a rebuild never throws", () => {
		const home = tempHome();
		expect(readLayerUse(home)).toEqual([]);
		expect(rebuildLayerUse(home, [])).toBeUndefined();
		expect(readLayerUse(home)).toEqual([]);
	});

	test("public entries from before the private ledger stay until the boot rebuild", () => {
		const home = tempHome();
		mkdirSync(join(home, ".alate"), { recursive: true });
		writeFileSync(
			join(home, ".alate", "in-use.json"),
			JSON.stringify({ layers: [{ id: "legacy", since: 3 }] }),
		);
		const release = acquireLayerUse(home, "new", 4);
		release();
		expect(readLayerUse(home)).toEqual([{ id: "legacy", since: 3 }]);
		rebuildLayerUse(home, []);
		expect(readLayerUse(home)).toEqual([]);
	});

	test("an invalid layer id fails the acquisition", () => {
		const home = tempHome();
		for (const id of ["", ".", "..", "a/b", "a\\b", "a\u0000b"])
			expect(() => acquireLayerUse(home, id)).toThrow("invalid agent layer id");
		expect(readLayerUse(home)).toEqual([]);
	});
});

describe("clean-up contract (board-side rule)", () => {
	/** The reader alate applies: keep current, keep previous, delete only ids absent from in-use. */
	function layersDeletable(home: string, previousId: string | null): string[] {
		const currentId = resolveAgentLayer(home)?.id ?? null;
		const inUse = new Set(readLayerUse(home).map((e) => e.id));
		const deletable: string[] = [];
		for (const name of readdirSync(join(home, ".alate", "layers"))) {
			if (name === currentId || name === previousId || inUse.has(name))
				continue;
			deletable.push(name);
		}
		return deletable;
	}

	test("a live run's layer is never deleted", () => {
		const home = tempHome();
		makeLayer(home, "A");
		makeLayer(home, "B");
		symlinkSync(
			join(home, ".alate", "layers", "A"),
			join(home, ".alate", "current"),
		);
		const release = acquireLayerUse(home, "A"); // run pinned A
		switchCurrent(home, "B"); // provision switches to B while the run lives
		// A: previous + in-use; B: current.
		expect(layersDeletable(home, "A")).toEqual([]);
		release();
	});

	test("after settle, A survives as the previous layer; a third layer is deleted", () => {
		const home = tempHome();
		makeLayer(home, "A");
		makeLayer(home, "B");
		symlinkSync(
			join(home, ".alate", "layers", "A"),
			join(home, ".alate", "current"),
		);
		const release = acquireLayerUse(home, "A");
		switchCurrent(home, "B");
		release(); // the run settled
		expect(layersDeletable(home, "A")).toEqual([]); // B current, A previous
		makeLayer(home, "C"); // a third layer arrives with the next provision
		switchCurrent(home, "C"); // another switch: B becomes previous, A falls out
		expect(layersDeletable(home, "B")).toEqual(["A"]);
	});

	test("a live lease outlasts three newer layers and another holder's release (OTTR-1132)", () => {
		const home = tempHome();
		for (const id of ["A", "B", "C", "D", "E"]) makeLayer(home, id);
		switchCurrent(home, "A");
		const run1 = acquireLayerUse(home, "A"); // run 1 pins A
		const run2 = acquireLayerUse(home, "A"); // run 2 pins A too
		for (const id of ["B", "C", "D", "E"]) switchCurrent(home, id);
		run1(); // run 1 settles; run 2 still reads A
		// E current, D previous: A is two layers past the previous one and only its lease keeps it.
		expect(layersDeletable(home, "D").sort()).toEqual(["B", "C"]);
		expect(
			readFileSync(
				join(home, ".alate", "layers", "A", ".agents", "skills.md"),
				"utf8",
			),
		).toBe("# skills\n");
		run2(); // run 2 settles: now A is a candidate (never deleted here)
		expect(layersDeletable(home, "D").sort()).toEqual(["A", "B", "C"]);
	});
});

describe("pin hardening", () => {
	/** A flat home that holds every if-exist source as a real file or directory. */
	function flatWithSources(home: string): void {
		writeFileSync(join(home, ".gitconfig"), "[user]\n");
		mkdirSync(join(home, ".config", "git"), { recursive: true });
		mkdirSync(join(home, ".config", "gh"), { recursive: true });
		mkdirSync(join(home, ".ssh"), { recursive: true });
		writeFileSync(join(home, ".claude"), "ctx\n");
		mkdirSync(join(home, ".npm"), { recursive: true });
		mkdirSync(join(home, ".bun"), { recursive: true });
		mkdirSync(join(home, ".local"), { recursive: true });
	}

	const IF_EXIST = [
		".gitconfig",
		".config/git",
		".config/gh",
		".ssh",
		".claude",
		".npm",
		".bun",
		".local",
	];

	test("every if-exist source present in the flat home is linked into the layer", () => {
		const home = tempHome();
		flatWithSources(home);
		const dir = makeLayer(home, "links");
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home).ok).toBe(true);
		for (const rel of IF_EXIST)
			expect(readlinkSync(join(dir, rel))).toBe(join(home, rel));
	});

	test("an absent if-exist source stays absent in the layer (no dangling link)", () => {
		const home = tempHome();
		const dir = makeLayer(home, "links");
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home).ok).toBe(true);
		for (const rel of IF_EXIST) {
			expect(existsSync(join(home, rel))).toBe(false);
			let inLayer = true;
			try {
				lstatSync(join(dir, rel));
			} catch {
				inLayer = false;
			}
			expect(inLayer).toBe(false);
		}
	});

	test("a planted intermediate symlink fails the pin and writes nothing outside the layer", () => {
		const home = tempHome();
		const dir = makeLayer(home, "plant1");
		const outside = tempHome();
		rmSync(join(dir, ".omp"), { recursive: true });
		symlinkSync(outside, join(dir, ".omp"));
		switchCurrent(home, "plant1");
		expect(pinnedAgentLayer(home)).toEqual({ ok: false, reason: "prepare" });
		// Every `.omp` link would have been redirected into `outside` (OTTR-1016):
		// the pin must not create any entry there.
		expect(readdirSync(outside)).toEqual([]);
	});
});

describe("in-use registry hardening", () => {
	function writeRaw(home: string, text: string): void {
		mkdirSync(join(home, ".alate"), { recursive: true });
		writeFileSync(join(home, ".alate", "in-use.json"), text);
	}

	test("a registry whose layers value is not an array reads as empty", () => {
		const home = tempHome();
		writeRaw(home, '{"layers":"nope"}');
		expect(readLayerUse(home)).toEqual([]);
	});

	test("invalid entries are skipped, valid ones kept", () => {
		const home = tempHome();
		writeRaw(
			home,
			JSON.stringify({
				layers: [
					null,
					5,
					{ since: 1 },
					{ id: "a" },
					{ id: "b", since: "x" },
					{ id: "ok", since: 7 },
				],
			}),
		);
		expect(readLayerUse(home)).toEqual([{ id: "ok", since: 7 }]);
	});
});

describe("registry write failures", () => {
	test("a failed publish fails the acquisition, the rebuild warns, no tmp file stays", () => {
		const home = tempHome();
		acquireLayerUse(home, "first")(); // the private ledger exists from here on
		const ledger = join(home, ".alate", "in-use.owners.json");
		const ledgerBefore = readFileSync(ledger, "utf8");
		// The registry path becomes a directory: the publish rename fails (EISDIR/ENOTDIR/…).
		renameSync(
			join(home, ".alate", "in-use.json"),
			join(home, ".alate", "in-use.json.moved"),
		);
		mkdirSync(join(home, ".alate", "in-use.json"));
		const warns: string[] = [];
		const original = console.warn;
		console.warn = (...parts: unknown[]) => warns.push(parts.join(" "));
		try {
			expect(() => acquireLayerUse(home, "a")).toThrow();
			rebuildLayerUse(home, ["a"]);
		} finally {
			console.warn = original;
		}
		expect(
			warns.filter((w) => w.includes("! agent layer registry rebuild failed")),
		).toHaveLength(1);
		const left = readdirSync(join(home, ".alate")).filter((f) =>
			f.endsWith(".tmp"),
		);
		expect(left).toEqual([]);
		// The failed acquisition recorded no lease.
		expect(readFileSync(ledger, "utf8")).toBe(ledgerBefore);
		expect(readdirSync(join(home, ".alate", "leases"))).toEqual([]);
		expect(readLayerUse(home)).toEqual([]);
	});

	test("a failed release warns, keeps the layer protected, and a later call retries", () => {
		const home = tempHome();
		const release = acquireLayerUse(home, "a", 1);
		const ledger = join(home, ".alate", "in-use.owners.json");
		const good = readFileSync(ledger, "utf8");
		writeFileSync(ledger, "{broken");
		const warns: string[] = [];
		const original = console.warn;
		console.warn = (...parts: unknown[]) => warns.push(parts.join(" "));
		try {
			release();
			// The holder still holds its lock: a rebuild cannot prove that it ended.
			writeFileSync(ledger, good);
			rebuildLayerUse(home, []);
			expect(readLayerUse(home)).toEqual([{ id: "a", since: 1 }]);
			release();
		} finally {
			console.warn = original;
		}
		expect(
			warns.filter((w) => w.includes("! agent layer lease release failed")),
		).toHaveLength(1);
		expect(readLayerUse(home)).toEqual([]);
	});
});

describe("layer containment and registry hardening", () => {
	test("a current link pointing outside .alate/layers resolves to nothing", () => {
		const home = tempHome();
		const foreign = mkdtempSync(join(tmpdir(), "ottr-layer-foreign-"));
		mkdirSync(join(home, ".alate"), { recursive: true });
		symlinkSync(foreign, join(home, ".alate", "current"));
		// The home is worker-writable (R5-1), so a planted `current` must not redirect
		// the pin (or the layer-following list reads) into paths outside the layers tree.
		expect(resolveAgentLayer(home)).toBeNull();
		expect(pinnedAgentLayer(home)).toEqual({ ok: false, reason: "broken" });
		rmSync(foreign, { recursive: true, force: true, maxRetries: 5 });
	});

	test("a planted in-use.json symlink without a ledger fails closed, its victim stays intact", () => {
		const home = tempHome();
		const victim = join(home, "victim-server-only.db");
		const victimBytes = "SQLite format 3\x00do not touch";
		writeFileSync(victim, victimBytes);
		mkdirSync(join(home, ".alate"), { recursive: true });
		symlinkSync(victim, join(home, ".alate", "in-use.json"));
		// No ledger: the public registry is the only record of legacy holders, and a
		// symlink there is never followed, so the acquisition refuses.
		expect(() => acquireLayerUse(home, "a")).toThrow();
		expect(readFileSync(victim, "utf8")).toBe(victimBytes);
		expect(
			lstatSync(join(home, ".alate", "in-use.json")).isSymbolicLink(),
		).toBe(true);
	});

	test("a planted in-use.json symlink next to a ledger is replaced, its victim stays intact", () => {
		const home = tempHome();
		const victim = join(home, "victim-server-only.db");
		const victimBytes = "SQLite format 3\x00do not touch";
		writeFileSync(victim, victimBytes);
		acquireLayerUse(home, "first")(); // the private ledger exists from here on
		renameSync(
			join(home, ".alate", "in-use.json"),
			join(home, ".alate", "in-use.json.moved"),
		);
		symlinkSync(victim, join(home, ".alate", "in-use.json"));
		const release = acquireLayerUse(home, "a");
		// The rename replaced the symlink instead of truncating the server-only target.
		expect(readFileSync(victim, "utf8")).toBe(victimBytes);
		expect(readLayerUse(home).map((e) => e.id)).toEqual(["a"]);
		release();
	});

	test("planted tmp symlinks never take the registry write", () => {
		const home = tempHome();
		const victims = ["a.db", "b.cfg"].map((n) => {
			const p = join(home, n);
			writeFileSync(p, n);
			return p;
		});
		mkdirSync(join(home, ".alate"), { recursive: true });
		for (const [i, victim] of victims.entries())
			symlinkSync(victim, join(home, ".alate", `in-use.json.${i}.tmp`));
		const release = acquireLayerUse(home, "a");
		for (const victim of victims)
			expect(readFileSync(victim, "utf8")).toBe(basename(victim));
		expect(readLayerUse(home).map((e) => e.id)).toEqual(["a"]);
		release();
	});
});

describe("in-use lease lifetime (OTTR-1132)", () => {
	const ids = (home: string): string[] =>
		readLayerUse(home)
			.map((e) => e.id)
			.sort();

	test("the same id held twice: the first release keeps the layer, the last clears it", () => {
		const home = tempHome();
		const first = acquireLayerUse(home, "A");
		const second = acquireLayerUse(home, "A");
		first();
		expect(ids(home)).toEqual(["A"]);
		second();
		expect(ids(home)).toEqual([]);
	});

	test("different ids stay independent and a repeated release touches no other holder", () => {
		const home = tempHome();
		const holder1 = acquireLayerUse(home, "A");
		const holder2 = acquireLayerUse(home, "A");
		const b = acquireLayerUse(home, "B");
		holder1();
		holder1(); // holder 1 releases again
		expect(ids(home)).toEqual(["A", "B"]);
		b();
		expect(ids(home)).toEqual(["A"]);
		holder2();
		expect(ids(home)).toEqual([]);
	});

	test("a live in-process holder survives the boot rebuild", () => {
		const home = tempHome();
		const release = acquireLayerUse(home, "A", 5);
		rebuildLayerUse(home, ["R"]);
		expect(ids(home)).toEqual(["A", "R"]);
		expect(readLayerUse(home).find((e) => e.id === "A")?.since).toBe(5);
		release();
		expect(ids(home)).toEqual(["R"]);
	});

	test("the public registry carries exactly {layers:[{id,since}]}", () => {
		const home = tempHome();
		acquireLayerUse(home, "A", 5);
		acquireLayerUse(home, "A", 6);
		acquireLayerUse(home, "B", 7);
		const raw: unknown = JSON.parse(
			readFileSync(join(home, ".alate", "in-use.json"), "utf8"),
		);
		expect(Object.keys(raw as object)).toEqual(["layers"]);
		const layers = (raw as { layers: object[] }).layers;
		for (const entry of layers)
			expect(Object.keys(entry).sort()).toEqual(["id", "since"]);
		expect(layers.map((e) => (e as { id: string }).id).sort()).toEqual([
			"A",
			"B",
		]);
	});
});

describe("in-use leases across independent processes (OTTR-1132)", () => {
	const LAYERS = join(import.meta.dir, "layers.ts");
	// One holder process: takes `count` leases on `id`, signals `<gate>.ready`, then either
	// exits at once with its leases unreleased ("exit") or waits for `<gate>.release`,
	// releases them and exits ("hold"). Every exit is natural: the tests kill nothing, and a
	// holder whose release file never comes gives up after 30 s on its own.
	const HOLDER = `
const [layers, home, id, count, mode, gate] = process.argv.slice(2);
const m = await import(layers);
const releases = [];
for (let i = 0; i < Number(count); i++) releases.push(m.acquireLayerUse(home, id));
await Bun.write(gate + ".ready", "");
if (mode === "hold") {
	const giveUp = Date.now() + 30_000;
	while (!(await Bun.file(gate + ".release").exists()) && Date.now() < giveUp)
		await Bun.sleep(10);
	for (const release of releases) release();
}
`;
	type Holder = {
		gate: string;
		exited: Promise<number>;
		exitCode: () => number | null;
	};

	/** Runs `body` with a holder starter; every started holder gets its release file and is awaited. */
	async function withHolders(
		body: (
			start: (id: string, count: number, mode: "hold" | "exit") => Holder,
			home: string,
		) => Promise<void>,
	): Promise<void> {
		const home = tempHome();
		const gates = tempHome();
		const script = join(gates, "holder.ts");
		writeFileSync(script, HOLDER);
		const started: Holder[] = [];
		const start = (
			id: string,
			count: number,
			mode: "hold" | "exit",
		): Holder => {
			const gate = join(gates, `${id}.${mode}`);
			const proc = Bun.spawn(
				[process.execPath, script, LAYERS, home, id, String(count), mode, gate],
				{ stdin: "ignore", stdout: "ignore", stderr: Bun.file(`${gate}.err`) },
			);
			const holder = {
				gate,
				exited: proc.exited,
				exitCode: () => proc.exitCode,
			};
			started.push(holder);
			return holder;
		};
		try {
			await body(start, home);
		} finally {
			for (const h of started) writeFileSync(`${h.gate}.release`, "");
			await Promise.all(started.map((h) => h.exited));
		}
	}

	const stderrOf = (h: Holder): string => {
		try {
			return readFileSync(`${h.gate}.err`, "utf8");
		} catch (err) {
			return `(stderr unreadable: ${String(err)})`;
		}
	};

	async function ready(holders: Holder[]): Promise<void> {
		const deadline = Date.now() + 15_000;
		for (const h of holders)
			while (!existsSync(`${h.gate}.ready`)) {
				const code = h.exitCode();
				// Re-check: a holder writes its ready file before it exits.
				if (code !== null && !existsSync(`${h.gate}.ready`))
					throw new Error(`holder ${h.gate} exited ${code}: ${stderrOf(h)}`);
				if (Date.now() > deadline)
					throw new Error(`holder ${h.gate} never got ready: ${stderrOf(h)}`);
				await Bun.sleep(10);
			}
	}

	async function release(holders: Holder[]): Promise<void> {
		for (const h of holders) writeFileSync(`${h.gate}.release`, "");
		const codes = await Promise.all(holders.map((h) => h.exited));
		for (const [i, h] of holders.entries())
			if (codes[i] !== 0)
				throw new Error(`holder ${h.gate} exited ${codes[i]}: ${stderrOf(h)}`);
	}

	const ids = (home: string): string[] =>
		readLayerUse(home)
			.map((e) => e.id)
			.sort();

	test("concurrent holders in separate processes never overwrite each other", async () => {
		await withHolders(async (start, home) => {
			const names = ["p0", "p1", "p2", "p3", "p4", "p5"];
			const holders = names.map((id) => start(id, 20, "hold"));
			await ready(holders);
			expect(ids(home)).toEqual(names);
			await release(holders.slice(0, 3));
			expect(ids(home)).toEqual(names.slice(3));
			await release(holders.slice(3));
			expect(ids(home)).toEqual([]);
		});
	}, 60_000);

	test("boot rebuild keeps live holders and drops holders whose process ended unreleased", async () => {
		await withHolders(async (start, home) => {
			const local = acquireLayerUse(home, "L"); // a live holder in this process
			const live = start("W", 1, "hold"); // a live holder in another process
			const ended = start("E", 1, "exit"); // exits naturally, never releases
			await ready([live, ended]);
			expect(await ended.exited).toBe(0);
			expect(ids(home)).toEqual(["E", "L", "W"]);
			rebuildLayerUse(home, ["R"]);
			expect(ids(home)).toEqual(["L", "R", "W"]);
			await release([live]);
			expect(ids(home)).toEqual(["L", "R"]);
			local();
			expect(ids(home)).toEqual(["R"]);
		});
	}, 60_000);
});

describe("private lease stores fail closed (OTTR-1132)", () => {
	const TOKEN = randomUUID();
	const OTHER = randomUUID();

	function alate(home: string): string {
		const dir = join(home, ".alate");
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	test("a corrupt ledger fails the acquisition and the rebuild, both stores stay byte-identical", () => {
		const home = tempHome();
		const publicText = JSON.stringify({ layers: [{ id: "K", since: 1 }] });
		writeFileSync(join(alate(home), "in-use.json"), publicText);
		writeFileSync(join(alate(home), "in-use.owners.json"), "{broken");
		expect(() => acquireLayerUse(home, "A")).toThrow(
			"corrupt agent layer ledger",
		);
		const warns: string[] = [];
		const original = console.warn;
		console.warn = (...parts: unknown[]) => warns.push(parts.join(" "));
		try {
			rebuildLayerUse(home, ["R"]);
		} finally {
			console.warn = original;
		}
		expect(warns.join("\n")).toContain("corrupt agent layer ledger");
		expect(readFileSync(join(home, ".alate", "in-use.json"), "utf8")).toBe(
			publicText,
		);
		expect(
			readFileSync(join(home, ".alate", "in-use.owners.json"), "utf8"),
		).toBe("{broken");
		expect(readdirSync(join(home, ".alate", "leases"))).toEqual([]);
	});

	test("a publish failure after the ledger write takes back only its own row and frees its lock", () => {
		const home = tempHome();
		const first = acquireLayerUse(home, "A");
		const ledger = join(home, ".alate", "in-use.owners.json");
		const before = readFileSync(ledger, "utf8");
		// A non-empty directory at the public path: the ledger write passes, the publish
		// fails (the second "A" adds no public entry, so nothing is published first).
		renameSync(
			join(home, ".alate", "in-use.json"),
			join(home, ".alate", "in-use.json.moved"),
		);
		mkdirSync(join(home, ".alate", "in-use.json", "x"), { recursive: true });
		const original = console.warn;
		console.warn = () => {};
		try {
			expect(() => acquireLayerUse(home, "A")).toThrow();
		} finally {
			console.warn = original;
		}
		expect(readFileSync(ledger, "utf8")).toBe(before);
		expect(readdirSync(join(home, ".alate", "leases"))).toHaveLength(1);
		renameSync(
			join(home, ".alate", "in-use.json"),
			join(home, ".alate", "in-use.json.dir"),
		);
		first();
		expect(readLayerUse(home)).toEqual([]);
	});

	test("a ledger or registry over the read bound is never written", () => {
		const home = tempHome();
		const max = 1 << 20;
		const big: LayerLedger = { leases: [], recovery: [] };
		const long = "x".repeat(200);
		// Grow the ledger as far as it stays readable: the next ~230-byte row would pass the bound.
		let size = ledgerText(big).length;
		for (;;) {
			const row = { id: `${long}${big.recovery.length}`, since: 1 };
			// Each row adds its JSON text plus one comma after the first row.
			const grown =
				size + JSON.stringify(row).length + (big.recovery.length > 0 ? 1 : 0);
			if (grown > max) break;
			big.recovery.push(row);
			size = grown;
		}
		// Pad ids (255 chars at most) up to exactly the bound, so the public registry with one
		// more 200-char id passes the bound too and the acquisition writes nothing at all.
		for (let i = big.recovery.length - 1; size < max; i--) {
			const row = big.recovery[i] as { id: string; since: number };
			const add = Math.min(max - size, 255 - row.id.length);
			row.id += "z".repeat(add);
			size += add;
		}
		const text = ledgerText(big);
		expect(text.length).toBe(max);
		writeFileSync(join(alate(home), "in-use.owners.json"), text);
		expect(() => acquireLayerUse(home, "y".repeat(200))).toThrow(
			"would exceed",
		);
		expect(
			readFileSync(join(home, ".alate", "in-use.owners.json"), "utf8"),
		).toBe(text);
		expect(existsSync(join(home, ".alate", "in-use.json"))).toBe(false);
		expect(readdirSync(join(home, ".alate", "leases"))).toEqual([]);
	});

	test("planted symlinks at the private paths fail the acquisition and leave their victims intact", () => {
		for (const name of ["in-use.owners.json", "in-use.lock", "leases"]) {
			const home = tempHome();
			const victim = join(home, `victim-${name}`);
			if (name === "leases") mkdirSync(victim);
			else writeFileSync(victim, "SQLite format 3\x00do not touch");
			symlinkSync(victim, join(alate(home), name));
			expect(() => acquireLayerUse(home, "A")).toThrow();
			if (name === "leases") expect(readdirSync(victim)).toEqual([]);
			else
				expect(readFileSync(victim, "utf8")).toBe(
					"SQLite format 3\x00do not touch",
				);
			expect(readLayerUse(home)).toEqual([]);
		}
	});

	test("a planted .alate symlink fails the acquisition and leaves its victim intact", () => {
		const home = tempHome();
		const victim = join(home, "victim-dir");
		mkdirSync(victim);
		symlinkSync(victim, join(home, ".alate"));
		expect(() => acquireLayerUse(home, "A")).toThrow();
		expect(readdirSync(victim)).toEqual([]);
	});

	test("the rebuild keeps a lease whose lock is a symlink or missing: neither proves an end", () => {
		const home = tempHome();
		const victim = join(home, "victim.db");
		writeFileSync(victim, "keep");
		mkdirSync(join(alate(home), "leases"));
		symlinkSync(victim, join(home, ".alate", "leases", `${TOKEN}.lock`));
		const ledger: LayerLedger = {
			leases: [
				{ token: TOKEN, id: "S", since: 1 },
				{ token: OTHER, id: "M", since: 2 },
			],
			recovery: [],
		};
		writeFileSync(
			join(home, ".alate", "in-use.owners.json"),
			ledgerText(ledger),
		);
		rebuildLayerUse(home, []);
		expect(readLayerUse(home)).toEqual([
			{ id: "S", since: 1 },
			{ id: "M", since: 2 },
		]);
		expect(readFileSync(victim, "utf8")).toBe("keep");
		expect(
			lstatSync(
				join(home, ".alate", "leases", `${TOKEN}.lock`),
			).isSymbolicLink(),
		).toBe(true);
	});
});

describe("ledger and id validation properties (OTTR-1132)", () => {
	const layerId = fc
		.string({ minLength: 1, maxLength: 40 })
		.filter((s) => isLayerId(s));
	const since = fc.nat({ max: Number.MAX_SAFE_INTEGER });
	const ledger: fc.Arbitrary<LayerLedger> = fc.record({
		leases: fc.uniqueArray(
			fc.record({ token: fc.uuid({ version: 4 }), id: layerId, since }),
			{ selector: (l) => l.token, maxLength: 6 },
		),
		recovery: fc.array(fc.record({ id: layerId, since }), { maxLength: 6 }),
	});

	test("an accepted id is one path segment", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 300 }), (id) => {
				if (!isLayerId(id)) return;
				expect(basename(id)).toBe(id);
				expect(id).not.toBe(".");
				expect(id).not.toBe("..");
				expect(id.includes("\0")).toBe(false);
				expect(id.includes("\\")).toBe(false);
			}),
			{ examples: [["."], [".."], ["a/b"], ["a\0"]] },
		);
	});

	test("a valid ledger round-trips through its text", () => {
		fc.assert(
			fc.property(ledger, (l) => {
				expect(parseLayerLedger(ledgerText(l))).toEqual(l);
			}),
		);
	});

	test("any other input either fails closed or parses to valid rows only", () => {
		const input = fc.oneof(
			fc.string(),
			fc.jsonValue().map((v) => JSON.stringify(v)),
			ledger.map((l) => {
				const raw = JSON.parse(ledgerText(l));
				raw.leases.push({ token: "not-a-uuid", id: "a", since: 1 });
				return JSON.stringify(raw);
			}),
			ledger.map((l) => ledgerText(l).replace('"version":1', '"version":2')),
		);
		fc.assert(
			fc.property(input, (text) => {
				let parsed: LayerLedger;
				try {
					parsed = parseLayerLedger(text);
				} catch (err) {
					expect(String(err)).toContain("corrupt agent layer ledger");
					return;
				}
				for (const row of [...parsed.leases, ...parsed.recovery]) {
					expect(isLayerId(row.id)).toBe(true);
					expect(Number.isSafeInteger(row.since) && row.since >= 0).toBe(true);
				}
				expect(new Set(parsed.leases.map((l) => l.token)).size).toBe(
					parsed.leases.length,
				);
				expect(parseLayerLedger(ledgerText(parsed))).toEqual(parsed);
			}),
			{
				examples: [
					['{"version":1,"leases":[],"recovery":[],"extra":1}'],
					['{"version":1,"leases":[],"recovery":[{"id":"..","since":1}]}'],
				],
			},
		);
	});
});

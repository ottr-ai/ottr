import { afterAll, describe, expect, test } from "bun:test";
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
import { dirname, join } from "node:path";
import {
	addLayerUse,
	pinnedAgentLayer,
	readLayerUse,
	rebuildLayerUse,
	removeLayerUse,
	resolveAgentLayer,
} from "./layers.ts";

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
		expect(pinnedAgentLayer(tempHome(), undefined)).toEqual({
			ok: false,
			reason: "none",
		});
	});

	test("broken link -> reason broken", () => {
		const home = tempHome();
		mkdirSync(join(home, ".alate"), { recursive: true });
		symlinkSync(join("layers", "gone"), join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home, HINDSIGHT)).toEqual({
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
		expect(pinnedAgentLayer(home, HINDSIGHT)).toEqual({
			ok: false,
			reason: "prepare",
		});
	});

	test("success returns the layer and the agent dir; the flip applied", () => {
		const home = tempHome();
		const dir = makeLayer(home, "ok1");
		symlinkSync(dir, join(home, ".alate", "current"));
		const pin = pinnedAgentLayer(home, HINDSIGHT);
		if (!pin.ok)
			throw new Error(`expected a pinned layer: ${JSON.stringify(pin)}`);
		expect(pin.layer.id).toBe("ok1");
		expect(pin.layer.dir).toBe(realpathSync(dir));
		expect(pin.agentDir).toBe(join(realpathSync(dir), ".omp", "agent"));
		expect(
			readFileSync(join(dir, ".omp", "agent", "config.yml"), "utf8"),
		).toContain("  backend: hindsight");
	});
});

describe("layer prepare", () => {
	test("ALWAYS links exist even when the flat target does not exist yet", () => {
		const home = tempHome();
		const dir = makeLayer(home, "link1");
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home, undefined).ok).toBe(true);
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
		expect(pinnedAgentLayer(home, undefined).ok).toBe(true);
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
		expect(pinnedAgentLayer(home, undefined).ok).toBe(true);
		expect(pinnedAgentLayer(home, undefined).ok).toBe(true);
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

describe("backend flip", () => {
	function pinConfig(
		config: string,
		url: string | undefined,
	): { text: () => string } {
		const home = tempHome();
		const dir = makeLayer(home, "flip");
		writeFileSync(join(dir, ".omp", "agent", "config.yml"), config);
		symlinkSync(dir, join(home, ".alate", "current"));
		pinnedAgentLayer(home, url);
		return {
			text: () =>
				readFileSync(join(dir, ".omp", "agent", "config.yml"), "utf8"),
		};
	}

	test("mnemopi + URL -> flipped", () => {
		const c = pinConfig("model: x\n  backend: mnemopi\n", HINDSIGHT);
		expect(c.text()).toContain("  backend: hindsight");
		expect(c.text()).not.toContain("mnemopi");
	});

	test("mnemopi without URL -> untouched", () => {
		const c = pinConfig("model: x\n  backend: mnemopi\n", undefined);
		expect(c.text()).toContain("  backend: mnemopi");
	});

	test("already hindsight -> untouched", () => {
		const text = "model: x\n  backend: hindsight\n";
		expect(pinConfig(text, HINDSIGHT).text()).toBe(text);
	});

	test("missing config file -> no-op, the pin still succeeds", () => {
		const home = tempHome();
		const dir = join(home, ".alate", "layers", "flip");
		mkdirSync(dir, { recursive: true });
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home, HINDSIGHT).ok).toBe(true);
		expect(existsSync(join(dir, ".omp", "agent", "config.yml"))).toBe(false);
	});
});

describe("in-use registry", () => {
	test("add dedups and stamps since; remove drops every entry for the id", () => {
		const home = tempHome();
		addLayerUse(home, "a");
		addLayerUse(home, "a", 5);
		addLayerUse(home, "b", 7);
		expect(readLayerUse(home)).toEqual([
			{ id: "a", since: 5 },
			{ id: "b", since: 7 },
		]);
		removeLayerUse(home, "a");
		expect(readLayerUse(home)).toEqual([{ id: "b", since: 7 }]);
		// Removing an unknown id is a no-op.
		removeLayerUse(home, "zzz");
		expect(readLayerUse(home)).toEqual([{ id: "b", since: 7 }]);
	});

	test("rebuild replaces the list in order with since = now", () => {
		const home = tempHome();
		addLayerUse(home, "old");
		const before = Date.now();
		rebuildLayerUse(home, ["x", "y"]);
		const entries = readLayerUse(home);
		expect(entries.map((e) => e.id)).toEqual(["x", "y"]);
		for (const e of entries) expect(e.since).toBeGreaterThanOrEqual(before);
	});

	test("corrupt JSON -> [] and a later add still works", () => {
		const home = tempHome();
		mkdirSync(join(home, ".alate"), { recursive: true });
		writeFileSync(join(home, ".alate", "in-use.json"), "{not json");
		expect(readLayerUse(home)).toEqual([]);
		addLayerUse(home, "rec");
		expect(readLayerUse(home)).toEqual([
			{ id: "rec", since: expect.any(Number) },
		]);
	});

	test("a missing registry reads as [] and remove never throws", () => {
		const home = tempHome();
		expect(readLayerUse(home)).toEqual([]);
		expect(removeLayerUse(home, "a")).toBeUndefined();
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
		addLayerUse(home, "A"); // run pinned A
		switchCurrent(home, "B"); // provision switches to B while the run lives
		// A: previous + in-use; B: current.
		expect(layersDeletable(home, "A")).toEqual([]);
	});

	test("after settle, A survives as the previous layer; a third layer is deleted", () => {
		const home = tempHome();
		makeLayer(home, "A");
		makeLayer(home, "B");
		symlinkSync(
			join(home, ".alate", "layers", "A"),
			join(home, ".alate", "current"),
		);
		addLayerUse(home, "A");
		switchCurrent(home, "B");
		removeLayerUse(home, "A"); // the run settled
		expect(layersDeletable(home, "A")).toEqual([]); // B current, A previous
		makeLayer(home, "C"); // a third layer arrives with the next provision
		switchCurrent(home, "C"); // another switch: B becomes previous, A falls out
		expect(layersDeletable(home, "B")).toEqual(["A"]);
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
		expect(pinnedAgentLayer(home, undefined).ok).toBe(true);
		for (const rel of IF_EXIST)
			expect(readlinkSync(join(dir, rel))).toBe(join(home, rel));
	});

	test("an absent if-exist source stays absent in the layer (no dangling link)", () => {
		const home = tempHome();
		const dir = makeLayer(home, "links");
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home, undefined).ok).toBe(true);
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

	test("a line that only contains the pattern is not flipped", () => {
		const home = tempHome();
		const dir = makeLayer(home, "flip-edge");
		writeFileSync(
			join(dir, ".omp", "agent", "config.yml"),
			"keep: a  backend: mnemopi\n",
		);
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home, HINDSIGHT).ok).toBe(true);
		expect(readFileSync(join(dir, ".omp", "agent", "config.yml"), "utf8")).toBe(
			"keep: a  backend: mnemopi\n",
		);
	});

	test("trailing content on the line is not flipped", () => {
		const home = tempHome();
		const dir = makeLayer(home, "flip-edge2");
		writeFileSync(
			join(dir, ".omp", "agent", "config.yml"),
			"  backend: mnemopi # keep\n",
		);
		symlinkSync(dir, join(home, ".alate", "current"));
		expect(pinnedAgentLayer(home, HINDSIGHT).ok).toBe(true);
		expect(readFileSync(join(dir, ".omp", "agent", "config.yml"), "utf8")).toBe(
			"  backend: mnemopi # keep\n",
		);
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

describe("registry write failures are best-effort", () => {
	test("a failed write warns, leaves no tmp file, and reads empty", () => {
		const home = tempHome();
		// The registry path is a directory: the final rename fails (EISDIR/ENOTDIR/…),
		// so writeRegistry takes its catch path: warn, unlink the tmp file, stay [].
		mkdirSync(join(home, ".alate", "in-use.json"), { recursive: true });
		const warns: string[] = [];
		const original = console.warn;
		console.warn = (...parts: unknown[]) => warns.push(parts.join(" "));
		try {
			addLayerUse(home, "a");
			removeLayerUse(home, "a");
			rebuildLayerUse(home, ["a"]);
		} finally {
			console.warn = original;
		}
		expect(
			warns.filter((w) => w.includes("! agent layer registry")).length,
		).toBeGreaterThanOrEqual(3);
		const left = readdirSync(join(home, ".alate")).filter((f) =>
			f.endsWith(".tmp"),
		);
		expect(left).toEqual([]);
		expect(readLayerUse(home)).toEqual([]);
	});
});

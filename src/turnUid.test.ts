import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	chownSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { holdLock } from "./layerLeaseLock.ts";
import {
	applyTurnGitEnv,
	applyTurnHomeEnv,
	assertProjectSegment,
	bootTurnIsolation,
	chownTree,
	chownTreeFd,
	closeProjectDir,
	ensureForkCapacity,
	ensureLayerCopy,
	ensureProjectIdentity,
	ensureTurnStoreAccess,
	isolationEnabled,
	newLayerToken,
	openPinned,
	prepareRunWorkspace,
	prepareTurnHome,
	projectTurnUid,
	releaseLayerCopyUse,
	resolvePinnedLayer,
	retargetCacheLinks,
	STORE_MOUNT_BLOCKED,
	type TurnHome,
	type TurnIdentity,
	uidCollisionNote,
} from "./turnUid.ts";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
// chown and uid-drop need root; the pure property and env tests run everywhere.
const rootTest = isRoot ? test : test.skip;

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function freshDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), `ottr-turnuid-${prefix}-`));
	dirs.push(d);
	return d;
}

/** A real turn home under a fresh homes root. */
function freshTurnHome(project: string): TurnHome {
	return prepareTurnHome(freshDir("homes"), project, projectTurnUid(project));
}

/** A turn home this uid can create and chown, so the layer tests run on
 * every gate: chown-to-self needs no privilege. */
function selfTurnHome(project: string): TurnHome {
	return prepareTurnHome(freshDir("homes"), project, selfIds());
}

/**
 * The current uid/gid as a TurnIdentity: chown-to-self needs no privilege, so
 * the prune tests below run on every gate. The prune's decisions never read
 * the ids; they only ride the copy calls' chowns.
 */
function selfIds(): TurnIdentity {
	return {
		uid: typeof process.getuid === "function" ? process.getuid() : 0,
		gid: typeof process.getgid === "function" ? process.getgid() : 0,
	};
}

describe("projectTurnUid", () => {
	test("is deterministic, in range, and gid-equals-uid", () => {
		for (const name of ["ottr", "agent-data", "a", "project with spaces"]) {
			const a = projectTurnUid(name);
			const b = projectTurnUid(name);
			expect(b).toEqual(a);
			expect(a.uid).toBeGreaterThanOrEqual(65536);
			expect(a.uid).toBeLessThan(65536 + (1 << 24));
			expect(a.gid).toBe(a.uid);
		}
	});

	test("fixed distinct names get distinct uids", () => {
		const names = ["ottr", "agent-data", "alate", "clipshelf", "hindsight"];
		const uids = names.map((n) => projectTurnUid(n).uid);
		expect(new Set(uids).size).toBe(names.length);
	});

	test("property: in range and deterministic for arbitrary names", () => {
		const nameArb = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-._"), {
				minLength: 1,
				maxLength: 64,
			})
			.map((chars) => chars.join(""));
		fc.assert(
			fc.property(nameArb, (name) => {
				const a = projectTurnUid(name);
				const b = projectTurnUid(name);
				return (
					a.uid === b.uid &&
					a.gid === a.uid &&
					a.uid >= 65536 &&
					a.uid < 65536 + (1 << 24)
				);
			}),
			{ numRuns: 200 },
		);
	});
});

describe("uidCollisionNote", () => {
	test("first claim is silent, a second name on the uid gets a note", () => {
		const ids = projectTurnUid("collision-proj-a");
		const other: typeof ids = { uid: ids.uid, gid: ids.uid };
		expect(uidCollisionNote("collision-proj-a", ids)).toBeNull();
		expect(uidCollisionNote("collision-proj-a", ids)).toBeNull();
		const note = uidCollisionNote("collision-proj-b", other);
		expect(note).toContain("collision-proj-a");
		expect(note).toContain("collision-proj-b");
	});
});

describe("assertProjectSegment", () => {
	test("rejects traversal, separators, empties and field breaks", () => {
		for (const bad of [
			"",
			".",
			"..",
			"a/b",
			"../x",
			"/abs",
			"a\\b",
			"a\0b",
			"a\nb",
			"a\rb",
			"a:b",
		])
			expect(() => assertProjectSegment(bad)).toThrow();
		assertProjectSegment("ottr");
		assertProjectSegment("my-project.v2");
	});
});

describe("resolvePinnedLayer", () => {
	const workerHome = "/fake-home";
	test("null for a non-layer HOME", () => {
		expect(resolvePinnedLayer(workerHome, undefined)).toBeNull();
		expect(resolvePinnedLayer(workerHome, "/root")).toBeNull();
		expect(resolvePinnedLayer(workerHome, "/root/.alate/layers")).toBeNull();
	});
	test("escapes and missing layers refuse or throw", () => {
		expect(
			resolvePinnedLayer(workerHome, "/fake-home/.alate/layers/../escape"),
		).toBeNull();
		expect(() =>
			resolvePinnedLayer(workerHome, "/fake-home/.alate/layers/gone"),
		).toThrow(/vanished/);
	});
});

describe("applyTurnHomeEnv", () => {
	const workerHome = "/fake-home";
	const layerDir = `${workerHome}/.alate/layers/l1`;
	const ids = projectTurnUid("env-proj");
	const turnHome: TurnHome = {
		root: "/turn-homes/env-proj",
		home: "/turn-homes/env-proj/home",
		layers: "/turn-homes/env-proj/layers",
		provision: "/turn-homes/env-proj/ottr",
	};
	const copyLayer = (dir: string) =>
		`${turnHome.layers}/${dir.split("/").pop()}`;
	// Pure stand-in for resolvePinnedLayer: same prefix and single-segment rules,
	// no fs (the fake workerHome does not exist), so these tests run as any user.
	const resolveLayer = (home: unknown): string | null => {
		if (typeof home !== "string") return null;
		const prefix = `${workerHome}/.alate/layers/`;
		if (!home.startsWith(prefix)) return null;
		const rest = home.slice(prefix.length);
		if (rest === "" || rest.includes("/") || rest === "." || rest === "..")
			return null;
		return home;
	};

	test("pinned HOME moves to the layer copy with the agent dir following", () => {
		const env: Record<string, string | undefined> = {
			HOME: layerDir,
			PI_CODING_AGENT_DIR: `${layerDir}/.omp/agent`,
		};
		const out = applyTurnHomeEnv(env, {
			workerHome,
			turnHome,
			ids,
			copyLayer,
			resolveLayer,
		});
		expect(out).toEqual({ pinned: true, home: copyLayer(layerDir) });
		expect(env.HOME).toBe(copyLayer(layerDir));
		expect(env.PI_CODING_AGENT_DIR).toBe(`${copyLayer(layerDir)}/.omp/agent`);
	});

	test("a foreign PI_CODING_AGENT_DIR falls to the copy's agent dir", () => {
		const env: Record<string, string | undefined> = {
			HOME: layerDir,
			PI_CODING_AGENT_DIR: "/etc/ottr/home/.omp/agent",
		};
		applyTurnHomeEnv(env, {
			workerHome,
			turnHome,
			ids,
			copyLayer,
			resolveLayer,
		});
		expect(env.PI_CODING_AGENT_DIR).toBe(`${copyLayer(layerDir)}/.omp/agent`);
	});

	test("unpinned and escaped HOMEs land on the turn home's writable home", () => {
		for (const home of [
			"/root",
			undefined,
			`${workerHome}/.alate/layers/../x`,
		]) {
			const env: Record<string, string | undefined> = { HOME: home };
			const out = applyTurnHomeEnv(env, {
				workerHome,
				turnHome,
				ids,
				copyLayer,
				resolveLayer,
			});
			expect(out).toEqual({ pinned: false, home: turnHome.home });
			expect(env.HOME).toBe(turnHome.home);
		}
	});

	test("property: no pinned HOME means no copyLayer call", () => {
		let calls = 0;
		fc.assert(
			fc.property(
				fc.option(fc.constantFrom("/root", "/home/x", "/tmp"), {
					nil: undefined,
				}),
				(home) => {
					calls = 0;
					const env: Record<string, string | undefined> = { HOME: home };
					applyTurnHomeEnv(env, {
						workerHome,
						turnHome,
						ids,
						copyLayer: () => {
							calls += 1;
							return "/copied";
						},
						resolveLayer,
					});
					return calls === 0 && env.HOME === turnHome.home;
				},
			),
			{ numRuns: 100 },
		);
	});
});

rootTest("prepareTurnHome builds the root-owned shell and the uid home", () => {
	const homesRoot = freshDir("home-root");
	const ids = projectTurnUid("home-proj");
	const turnHome = prepareTurnHome(homesRoot, "home-proj", ids);
	// The project level and the daemon dirs stay root-owned: the uid can never
	// rename or swap anything the daemon chowns or copies beneath them.
	const shell = statSync(turnHome.root);
	expect(shell.uid).toBe(0);
	expect(shell.mode & 0o777).toBe(0o755);
	expect(statSync(turnHome.layers).uid).toBe(0);
	expect(statSync(turnHome.provision).uid).toBe(0);
	const homeStat = statSync(turnHome.home);
	expect(homeStat.uid).toBe(ids.uid);
	expect(homeStat.mode & 0o777).toBe(0o700);
	expect(() => prepareTurnHome(homesRoot, "../escape", ids)).toThrow();
});

rootTest(
	"layer copy keeps state links and retargets cache links lazily",
	() => {
		const workerHome = freshDir("worker-home");
		const turnHome = freshTurnHome("copy-proj");
		const ids = projectTurnUid("copy-proj");
		const layerDir = join(workerHome, ".alate", "layers", "l1");
		mkdirSync(join(layerDir, ".omp", "agent"), { recursive: true });
		mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
		mkdirSync(join(workerHome, ".cache"), { recursive: true });
		writeFileSync(join(workerHome, ".omp", "agent", "agent.db"), "store");
		const dbTarget = join(workerHome, ".omp", "agent", "agent.db");
		symlinkSync(dbTarget, join(layerDir, ".omp", "agent", "agent.db"));
		symlinkSync(join(workerHome, ".cache"), join(layerDir, ".cache"));

		const copy = ensureLayerCopy(layerDir, turnHome, workerHome, ids);
		expect(copy).toBe(join(turnHome.layers, "l1"));
		// State link survives the copy with its flat target and still resolves.
		expect(readlinkSync(join(copy, ".omp", "agent", "agent.db"))).toBe(
			dbTarget,
		);
		expect(existsSync(join(copy, ".omp", "agent", "agent.db"))).toBe(true);
		// Cache link retargeted into the uid-owned home; the cache DIR itself is
		// created by the turn through the link (root never writes below home).
		expect(readlinkSync(join(copy, ".cache"))).toBe(
			join(turnHome.home, ".cache"),
		);
		expect(statOf(join(turnHome.home, ".cache"))).toBeNull();
		// The copy is owned by the project uid; its top dir is closed.
		expect(statSync(copy).uid).toBe(ids.uid);
		expect(statSync(copy).mode & 0o777).toBe(0o700);
		// The store itself was never touched by the retarget.
		expect(readFileSync(dbTarget, "utf8")).toBe("store");

		// A second call reuses the copy; a pre-existing final dir wins over a new copy.
		expect(ensureLayerCopy(layerDir, turnHome, workerHome, ids)).toBe(copy);
	},
);

rootTest("a stale copy whose source layer is gone is pruned", () => {
	const workerHome = freshDir("worker-home3");
	const turnHome = freshTurnHome("prune-proj");
	const ids = projectTurnUid("prune-proj");
	const layersShared = join(workerHome, ".alate", "layers");
	mkdirSync(layersShared, { recursive: true });
	const layerDir = join(layersShared, "keep");
	mkdirSync(layerDir, { recursive: true });
	writeFileSync(join(layerDir, "config.yml"), "model: x\n");
	// A copy of a layer alate already deleted, and one fresh temp dir.
	const goneCopy = join(turnHome.layers, "gone");
	mkdirSync(goneCopy, { recursive: true });
	const staleTmp = join(turnHome.layers, ".tmp-old");
	mkdirSync(staleTmp, { recursive: true });
	// Slide both mtimes back past the stale cutoff.
	const past = Date.now() - 25 * 60 * 60 * 1000;
	for (const p of [goneCopy, staleTmp]) touchMtime(p, past);

	const copy = ensureLayerCopy(layerDir, turnHome, workerHome, ids);
	expect(copy).toBe(join(turnHome.layers, "keep"));
	expect(existsSync(goneCopy)).toBe(false);
	expect(existsSync(staleTmp)).toBe(false);
	expect(existsSync(copy)).toBe(true);
});

test("OTTR-1179: a started turn's pinned copy survives another turn's prune from a disjoint worker home", () => {
	const workerA = freshDir("worker-live");
	const ids = selfIds();
	const turnHome = prepareTurnHome(freshDir("homes"), "prune-live", ids);
	const layerX = join(workerA, ".alate", "layers", "693b38b5b400-127");
	mkdirSync(join(layerX, ".omp", "agent"), { recursive: true });
	const seed = new Database(join(layerX, ".omp", "agent", "agent.db"));
	seed.run("CREATE TABLE memories (id TEXT PRIMARY KEY, body TEXT)");
	seed.run("INSERT INTO memories VALUES ('m1', 'seed')");
	seed.close();

	// Turn 1 starts pinned to X: HOME moves to the shared copy.
	const env1: Record<string, string | undefined> = { HOME: layerX };
	const first = applyTurnHomeEnv(env1, {
		workerHome: workerA,
		turnHome,
		ids,
	});
	const copyX = join(turnHome.layers, "693b38b5b400-127");
	expect(first).toEqual({ pinned: true, home: copyX });

	// A fresh in-use marker may also precede its copy (a concurrent start
	// between the mark and the rename); the prune must keep it.
	const freshGhost = join(turnHome.layers, "693b38b5b400-132.inuse");
	writeFileSync(freshGhost, "in-use\n");

	// Turn 2 starts on the same project from a worker whose alate home
	// never held X (the 2026-11-21 wave shape). An unmarked victim copy
	// rides along to prove the prune still deletes what no live turn uses.
	const victim = join(turnHome.layers, "693b38b5b400-130");
	mkdirSync(victim, { recursive: true });
	const workerB = freshDir("worker-wave");
	const layerY = join(workerB, ".alate", "layers", "693b38b5b400-134");
	mkdirSync(layerY, { recursive: true });
	const env2: Record<string, string | undefined> = { HOME: layerY };
	const second = applyTurnHomeEnv(env2, {
		workerHome: workerB,
		turnHome,
		ids,
	});
	expect(second).toEqual({
		pinned: true,
		home: join(turnHome.layers, "693b38b5b400-134"),
	});

	// Turn 1's copy and its omp state link still resolve mid-run, the
	// fresh ghost keeps waiting for its rename, and the prune did its job
	// on the unprotected victim.
	expect(existsSync(copyX)).toBe(true);
	// The running turn's store stays writable mid-run, through the copy's
	// state link: a memory written now lands in the flat home database.
	const store = new Database(join(copyX, ".omp", "agent", "agent.db"));
	store.run("INSERT INTO memories VALUES ('m2', 'written mid-run')");
	expect(
		store.query("SELECT body FROM memories WHERE id = 'm2'").get(),
	).toEqual({ body: "written mid-run" });
	store.close();
	expect(existsSync(freshGhost)).toBe(true);
	expect(existsSync(victim)).toBe(false);
});

test("OTTR-1179: an aged-out in-use marker stops protecting the copy", () => {
	const workerA = freshDir("worker-live2");
	const ids = selfIds();
	const turnHome = prepareTurnHome(freshDir("homes"), "prune-aged", ids);
	const layerX = join(workerA, ".alate", "layers", "693b38b5b400-128");
	mkdirSync(join(layerX, ".omp", "agent"), { recursive: true });
	writeFileSync(join(layerX, ".omp", "agent", "agent.db"), "store");
	const env: Record<string, string | undefined> = { HOME: layerX };
	applyTurnHomeEnv(env, { workerHome: workerA, turnHome, ids });
	const copyX = join(turnHome.layers, "693b38b5b400-128");
	const markerX = join(turnHome.layers, "693b38b5b400-128.inuse");
	expect(existsSync(markerX)).toBe(true);

	// The turn ends; a day passes. A ghost marker whose copy is long gone
	// rides along at the same age. The next copy for the project from a
	// disjoint home reclaims the copy, its marker and the ghost, so the
	// volume still stays bounded.
	const past = Date.now() - 25 * 60 * 60 * 1000;
	touchMtime(markerX, past);
	const ghost = join(turnHome.layers, "693b38b5b400-126.inuse");
	writeFileSync(ghost, "in-use\n");
	touchMtime(ghost, past);
	const workerB = freshDir("worker-aged");
	const layerY = join(workerB, ".alate", "layers", "693b38b5b400-133");
	mkdirSync(layerY, { recursive: true });
	const env2: Record<string, string | undefined> = { HOME: layerY };
	applyTurnHomeEnv(env2, { workerHome: workerB, turnHome, ids });

	expect(existsSync(copyX)).toBe(false);
	expect(existsSync(markerX)).toBe(false);
	expect(existsSync(ghost)).toBe(false);
	// The wave's own copy landed.
	expect(existsSync(join(turnHome.layers, "693b38b5b400-133"))).toBe(true);
});

test("OTTR-1179: a pinned copy survives concurrent ensures with disjoint worker homes", () => {
	const ids = selfIds();
	const turnHome = prepareTurnHome(freshDir("homes"), "prune-concurrent", ids);
	const workerA = freshDir("worker-pin");
	const layerX = join(workerA, ".alate", "layers", "693b38b5b400-127");
	mkdirSync(join(layerX, ".omp", "agent"), { recursive: true });
	writeFileSync(join(layerX, ".omp", "agent", "agent.db"), "store");
	// Turn 1 runs on the shared copy of X.
	expect(ensureLayerCopy(layerX, turnHome, workerA, ids)).toBe(
		join(turnHome.layers, "693b38b5b400-127"),
	);

	// A wave of turns starts on the same project, each from its own worker
	// home whose alate set never held X (disjoint homes).
	for (const [i, id] of [
		"693b38b5b400-129",
		"693b38b5b400-130",
		"693b38b5b400-131",
	].entries()) {
		const workerHome = freshDir(`worker-wave-${i}`);
		const layerDir = join(workerHome, ".alate", "layers", id);
		mkdirSync(layerDir, { recursive: true });
		expect(ensureLayerCopy(layerDir, turnHome, workerHome, ids)).toBe(
			join(turnHome.layers, id),
		);
	}

	// Turn 1's copy and its omp store survive the whole wave.
	const copyX = join(turnHome.layers, "693b38b5b400-127");
	expect(existsSync(copyX)).toBe(true);
	expect(readFileSync(join(copyX, ".omp", "agent", "agent.db"), "utf8")).toBe(
		"store",
	);
});

test("OTTR-1179: a turn start fails closed when the marker cannot be written", () => {
	const workerA = freshDir("worker-fail");
	const ids = selfIds();
	const turnHome = prepareTurnHome(freshDir("homes"), "prune-failclosed", ids);
	const layerX = join(workerA, ".alate", "layers", "693b38b5b400-127");
	mkdirSync(join(layerX, ".omp", "agent"), { recursive: true });
	writeFileSync(join(layerX, ".omp", "agent", "agent.db"), "store");
	applyTurnHomeEnv({ HOME: layerX }, { workerHome: workerA, turnHome, ids });
	const copyX = join(turnHome.layers, "693b38b5b400-127");
	// An unprotected victim rides along: a running prune would delete it.
	const victim = join(turnHome.layers, "693b38b5b400-130");
	mkdirSync(victim, { recursive: true });
	// The next start's marker write cannot land (as on a full volume): the
	// marker path is a directory. The start must fail, not run unprotected.
	const workerB = freshDir("worker-fail2");
	const layerY = join(workerB, ".alate", "layers", "693b38b5b400-131");
	mkdirSync(layerY, { recursive: true });
	mkdirSync(join(turnHome.layers, "693b38b5b400-131.inuse"), {
		recursive: true,
	});
	expect(() => ensureLayerCopy(layerY, turnHome, workerB, ids, 50)).toThrow();
	// The failed start deleted nothing: its prune never ran.
	expect(existsSync(copyX)).toBe(true);
	expect(existsSync(victim)).toBe(true);
	// With the marker writable again, the start succeeds and the healthy
	// prune reclaims the unprotected victim while the fresh marker keeps X.
	rmSync(join(turnHome.layers, "693b38b5b400-131.inuse"), {
		recursive: true,
		force: true,
	});
	expect(ensureLayerCopy(layerY, turnHome, workerB, ids, 50)).toBe(
		join(turnHome.layers, "693b38b5b400-131"),
	);
	expect(existsSync(victim)).toBe(false);
	expect(existsSync(copyX)).toBe(true);
});

test("OTTR-1179: a prune decision waits for the layers lock and re-reads state under it", () => {
	const workerA = freshDir("worker-locka");
	const ids = selfIds();
	const turnHome = prepareTurnHome(freshDir("homes"), "prune-lock", ids);
	const layerX = join(workerA, ".alate", "layers", "693b38b5b400-127");
	mkdirSync(join(layerX, ".omp", "agent"), { recursive: true });
	writeFileSync(join(layerX, ".omp", "agent", "agent.db"), "store");
	ensureLayerCopy(layerX, turnHome, workerA, ids, 50);
	const copyX = join(turnHome.layers, "693b38b5b400-127");
	// Age the marker: the next decision would delete the copy and the marker.
	touchMtime(
		join(turnHome.layers, "693b38b5b400-127.inuse"),
		Date.now() - 25 * 60 * 60 * 1000,
	);
	// Worker B holds the decision lock mid-section. A disjoint-home start
	// must fail closed on its wait budget rather than run its decision, so
	// nothing is deleted and no refreshed marker is dropped behind B's back.
	const held = holdLock(join(turnHome.layers, "in-use.lock"), 0);
	try {
		const workerB = freshDir("worker-lockb");
		const layerY = join(workerB, ".alate", "layers", "693b38b5b400-134");
		mkdirSync(layerY, { recursive: true });
		expect(() => ensureLayerCopy(layerY, turnHome, workerB, ids, 30)).toThrow();
		expect(existsSync(copyX)).toBe(true);
	} finally {
		held.release();
	}
	// With the lock free, the decision runs and re-reads the CURRENT state:
	// the aged marker's copy and marker go, the wave's own copy lands.
	const workerB = freshDir("worker-lockb2");
	const layerY = join(workerB, ".alate", "layers", "693b38b5b400-134");
	mkdirSync(layerY, { recursive: true });
	expect(ensureLayerCopy(layerY, turnHome, workerB, ids, 50)).toBe(
		join(turnHome.layers, "693b38b5b400-134"),
	);
	expect(existsSync(copyX)).toBe(false);
	expect(existsSync(join(turnHome.layers, "693b38b5b400-134.inuse"))).toBe(
		true,
	);
});

/**
 * OTTR-1210: a provision's protection ends with its run. Ten provisions in a
 * row, each run finished before the next starts, leave one copy per project —
 * whatever alate still holds in the shared home, and however fresh the
 * previous provisions were.
 */
test("ten provisions with no turn in flight end with one copy", () => {
	const ids = selfIds();
	const workerHome = freshDir("worker-bound");
	const shared = join(workerHome, ".alate", "layers");
	mkdirSync(shared, { recursive: true });
	const provision = (turnHome: TurnHome, id: string): void => {
		const layerDir = join(shared, id);
		mkdirSync(join(layerDir, ".omp", "agent"), { recursive: true });
		writeFileSync(join(layerDir, ".omp", "agent", "agent.db"), "store");
		const token = newLayerToken();
		// The run starts: the copy lands and the marker gains its line.
		expect(
			ensureLayerCopy(layerDir, turnHome, workerHome, ids, 50, token),
		).toBe(join(turnHome.layers, id));
		// The run ends before the next provision starts.
		releaseLayerCopyUse(turnHome.layers, id, token);
	};
	const homes: [TurnHome, string][] = [
		[selfTurnHome("bound-a"), "693b38b5b400-20"],
		[selfTurnHome("bound-b"), "693b38b5b400-30"],
	];
	// Ten provisions per project; every source layer stays in the shared
	// home, so retention cannot ride on it.
	for (const [turnHome, base] of homes) {
		for (let i = 0; i < 10; i++) provision(turnHome, `${base}${i}`);
	}
	// One final copy per project: the last pin. Its released marker is gone.
	for (const [turnHome, base] of homes) {
		const names = readdirSync(turnHome.layers).filter(
			(n) => n !== "in-use.lock",
		);
		expect(names).toEqual([`${base}9`]);
	}
});

/**
 * OTTR-1210: a live turn's marker keeps its copy whatever the copy's age and
 * whatever alate did to the source layer; the moment the run releases, the
 * next provision for the project reclaims the copy.
 */
test("a live in-use marker keeps its copy, a released one goes", () => {
	const ids = selfIds();
	const turnHome = selfTurnHome("bound-live");
	const workerHome = freshDir("worker-bound-live");
	const shared = join(workerHome, ".alate", "layers");
	mkdirSync(shared, { recursive: true });
	const makeLayer = (id: string): string => {
		const layerDir = join(shared, id);
		mkdirSync(join(layerDir, ".omp", "agent"), { recursive: true });
		writeFileSync(join(layerDir, ".omp", "agent", "agent.db"), "store");
		return layerDir;
	};
	// Turn 1 starts on X and stays live.
	const tokenX = newLayerToken();
	expect(
		ensureLayerCopy(
			makeLayer("693b38b5b400-141"),
			turnHome,
			workerHome,
			ids,
			50,
			tokenX,
		),
	).toBe(join(turnHome.layers, "693b38b5b400-141"));
	const copyX = join(turnHome.layers, "693b38b5b400-141");
	// Alate deletes the source layer and the copy itself ages past a day;
	// the live marker must keep the copy all the same.
	rmSync(join(shared, "693b38b5b400-141"), { recursive: true, force: true });
	touchMtime(copyX, Date.now() - 25 * 60 * 60 * 1000);
	// A finished provision for the same project lands its own copy.
	const tokenY = newLayerToken();
	ensureLayerCopy(
		makeLayer("693b38b5b400-142"),
		turnHome,
		workerHome,
		ids,
		50,
		tokenY,
	);
	releaseLayerCopyUse(turnHome.layers, "693b38b5b400-142", tokenY);
	// The live turn's copy survives the finished provision's decision; the
	// finished provision's own copy goes at the next provision's prune.
	expect(existsSync(copyX)).toBe(true);
	// Turn 1 ends; the next provision reclaims X and the finished copy too.
	releaseLayerCopyUse(turnHome.layers, "693b38b5b400-141", tokenX);
	const tokenZ = newLayerToken();
	ensureLayerCopy(
		makeLayer("693b38b5b400-143"),
		turnHome,
		workerHome,
		ids,
		50,
		tokenZ,
	);
	expect(existsSync(copyX)).toBe(false);
	expect(existsSync(join(turnHome.layers, "693b38b5b400-142"))).toBe(false);
	expect(existsSync(join(turnHome.layers, "693b38b5b400-143"))).toBe(true);
});

function statOf(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

function touchMtime(path: string, pastMs: number): void {
	const st = statOf(path);
	if (st === null) return;
	const seconds = pastMs / 1000;
	utimesSync(path, seconds, seconds);
}

rootTest("retargetCacheLinks skips foreign and relative links", () => {
	const workerHome = freshDir("worker-home2");
	const turnHome = freshTurnHome("ret-proj");
	const copyDir = freshDir("copy-dir");
	mkdirSync(join(workerHome, ".cache"), { recursive: true });
	symlinkSync(join(workerHome, ".cache"), join(copyDir, ".cache"));
	symlinkSync("../../elsewhere", join(copyDir, ".npm"));
	writeFileSync(join(copyDir, ".bun"), "a plain file");

	retargetCacheLinks(copyDir, turnHome.home, workerHome);
	expect(readlinkSync(join(copyDir, ".cache"))).toBe(
		join(turnHome.home, ".cache"),
	);
	// Relative link: untouched (stays layer content as shipped).
	expect(readlinkSync(join(copyDir, ".npm"))).toBe("../../elsewhere");
	// A plain file is never replaced.
	expect(lstatSync(join(copyDir, ".bun")).isSymbolicLink()).toBe(false);
});

rootTest("prepareRunWorkspace chowns cwd and the project git dir", () => {
	const ws = freshDir("ws");
	const ids = projectTurnUid("ws-proj");
	const main = join(ws, "main");
	mkdirSync(main, { recursive: true });
	const git = (...argv: string[]) => {
		const r = Bun.spawnSync(["git", "-C", main, ...argv], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
		});
		if (r.exitCode !== 0)
			throw new Error(`git ${argv.join(" ")} failed: ${r.stderr.toString()}`);
	};
	git("init", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(main, "f.txt"), "x\n");
	git("add", ".");
	git("commit", "-m", "init", "--no-gpg-sign");
	git("worktree", "add", join(main, ".worktrees", "card-1"));

	const cwd = join(main, ".worktrees", "card-1");
	prepareRunWorkspace(cwd, ids, ws);
	expect(statSync(cwd).uid).toBe(ids.uid);
	expect(statSync(cwd).mode & 0o777).toBe(0o700);
	// The project dir (the git dir's parent) is closed for other projects.
	expect(statSync(main).mode & 0o777).toBe(0o700);
	expect(statSync(main).uid).toBe(ids.uid);
	// The uid owns the git dir it must write into, worktree gitdir included.
	expect(statSync(join(main, ".git")).uid).toBe(ids.uid);
	const wtGitDir = readFileSync(join(cwd, ".git"), "utf8")
		.replace("gitdir: ", "")
		.trim();
	expect(statSync(wtGitDir).uid).toBe(ids.uid);
	// A planted `.git` pointer is never followed: the common dir comes from the
	// board layout (<workspace>/<project>/.git), so this stays uid-owned only.
	expect(existsSync(join(main, ".git", "planted-marker"))).toBe(false);

	// A cwd outside the workspace root fails the run (fail closed).
	expect(() =>
		prepareRunWorkspace(join(freshDir("elsewhere"), "main"), ids, ws),
	).toThrow(/not under/);
	// A project dir without a git dir fails too.
	const noGit = join(ws, "no-git-proj");
	mkdirSync(join(noGit, "wt"), { recursive: true });
	expect(() => prepareRunWorkspace(join(noGit, "wt"), ids, ws)).toThrow(
		/missing workspace entry/,
	);
});

rootTest(
	"a planted .worktrees symlink fails the run and is never chowned",
	() => {
		const ws = freshDir("plant-ws");
		const ids = projectTurnUid("plant-proj");
		// The project tree after a first takeover: uid-owned project dir and
		// worktree; a victim tree outside the project stays root-owned.
		const main = join(ws, "main");
		const wt = join(main, ".worktrees", "card-1");
		mkdirSync(join(main, ".git"), { recursive: true });
		mkdirSync(wt, { recursive: true });
		chownTree(ws, ids);
		chmodSync(main, 0o700);
		const outside = freshDir("plant-outside");
		const victim = join(outside, "victim.txt");
		writeFileSync(victim, "v\n");
		chmodSync(victim, 0o644);
		// The uid swaps `.worktrees` for a symlink into a world-traversable dir.
		renameSync(join(main, ".worktrees"), join(main, ".worktrees-real"));
		mkdirSync(join(main, ".worktrees-real", "card-1", "deeper"), {
			recursive: true,
		});
		symlinkSync(outside, join(main, ".worktrees"));

		// The run fails closed before any chown.
		expect(() =>
			prepareRunWorkspace(
				join(main, ".worktrees", "card-1", "deeper"),
				ids,
				ws,
			),
		).toThrow(/planted entry/);
		// The victim outside the project was never touched.
		expect(statSync(victim).uid).not.toBe(ids.uid);
		// A planted `.git` symlink is refused the same way.
		renameSync(join(main, ".git"), join(main, ".git-real"));
		symlinkSync(outside, join(main, ".git"));
		expect(() => prepareRunWorkspace(main, ids, ws)).toThrow(/planted entry/);
		expect(statSync(victim).uid).not.toBe(ids.uid);
	},
);

rootTest("chownTree leaves symlink targets untouched", () => {
	const tree = freshDir("chown-tree");
	const target = freshDir("chown-outside");
	const ids = projectTurnUid("chown-proj");
	mkdirSync(join(tree, "sub"), { recursive: true });
	writeFileSync(join(tree, "sub", "f.txt"), "x\n");
	const outside = join(target, "victim.txt");
	writeFileSync(outside, "v\n");
	symlinkSync(outside, join(tree, "sub", "link"));

	chownTree(tree, ids);
	// Every real entry is the uid's; the link target is not.
	expect(statSync(join(tree, "sub", "f.txt")).uid).toBe(ids.uid);
	expect(statSync(outside).uid).not.toBe(ids.uid);
	expect(lstatSync(join(tree, "sub", "link")).uid).toBe(ids.uid);
	// A symlink as the walked root fails the run (fail closed).
	expect(() => chownTree(join(tree, "sub", "link"), ids)).toThrow(/symlink/);
});

rootTest(
	"renames after the pin cannot redirect the walk into impostors",
	() => {
		const ws = freshDir("rename-ws");
		const ids = projectTurnUid("rename-proj");
		const root = join(ws, "root");
		mkdirSync(join(root, "sub"), { recursive: true });
		writeFileSync(join(root, "sub", "mine.txt"), "x\n");

		// The daemon pins the root BEFORE any attacker action: the open is the
		// race window's entry.
		const fd = openPinned(root);
		try {
			// Mid-walk swaps, after the pin: the uid renames the walked dir twice
			// and plants an impostor at every path a resolving walk could land on.
			// A chownTreeFd that resolves the fd back to its path (readlinkSync)
			// or follows any path under the old root would chown an impostor's
			// file; the anchored walk must chown the pinned inode's children.
			renameSync(root, `${root}-a`);
			mkdirSync(join(root, "steal-a"), { recursive: true });
			const victimA = join(root, "steal-a", "victim.txt");
			writeFileSync(victimA, "v\n");
			chmodSync(victimA, 0o644);
			renameSync(`${root}-a`, `${root}-b`);
			mkdirSync(join(`${root}-a`, "steal-b"), { recursive: true });
			const victimB = join(`${root}-a`, "steal-b", "victim.txt");
			writeFileSync(victimB, "v\n");
			chmodSync(victimB, 0o644);

			chownTreeFd(fd, ids);

			// The walk followed the pinned inode (now named root-b): its children
			// are the uid's, and both impostors stayed root-owned.
			expect(statSync(join(`${root}-b`, "sub")).uid).toBe(ids.uid);
			expect(statSync(join(`${root}-b`, "sub", "mine.txt")).uid).toBe(ids.uid);
			expect(statSync(victimA).uid).not.toBe(ids.uid);
			expect(statSync(victimB).uid).not.toBe(ids.uid);
			expect(statSync(join(root, "steal-a")).uid).not.toBe(ids.uid);
			expect(statSync(join(`${root}-a`, "steal-b")).uid).not.toBe(ids.uid);
		} finally {
			closeSync(fd);
		}
	},
);

rootTest("closeProjectDir chowns the whole project data tree", () => {
	const root = freshDir("close-root");
	const ids = projectTurnUid("close-proj");
	const dir = join(root, "close-proj");
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(join(dir, "sessions", "s1.jsonl"), "x\n");
	chmodSync(join(dir, "sessions", "s1.jsonl"), 0o644);
	// The server (root) wrote the files; the close hands the tree to the uid.
	closeProjectDir(dir, ids);
	expect(statSync(dir).uid).toBe(ids.uid);
	expect(statSync(join(dir, "sessions")).uid).toBe(ids.uid);
	expect(statSync(join(dir, "sessions", "s1.jsonl")).uid).toBe(ids.uid);
	expect(statSync(dir).mode & 0o777).toBe(0o700);
	// Missing and non-dir entries are no-ops.
	closeProjectDir(join(root, "missing"), ids);
	writeFileSync(join(root, "afile"), "x");
	closeProjectDir(join(root, "afile"), ids);
	expect(lstatSync(join(root, "afile")).isDirectory()).toBe(false);
});

rootTest("bootTurnIsolation hardens the shared home and closes roots", () => {
	const workerHome = freshDir("boot-home");
	const rootA = freshDir("boot-root-a");
	const rootB = freshDir("boot-root-b");
	mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
	writeFileSync(join(workerHome, ".omp", "agent", "agent.db"), "store");
	chmodSync(join(workerHome, ".omp", "agent", "agent.db"), 0o600);
	for (const [name, mode] of [
		["proj-a", 0o755],
		["proj-b", 0o755],
	] as const) {
		mkdirSync(join(rootA, name), { recursive: true });
		chmodSync(join(rootA, name), mode);
	}
	mkdirSync(join(rootB, "proj-a"), { recursive: true });

	const notes = bootTurnIsolation(workerHome, [rootA, rootB]);
	expect(notes).toEqual([]);
	const idsA = projectTurnUid("proj-a");
	const idsB = projectTurnUid("proj-b");
	// Shared home: traversable, not listable, for turn uids (0711).
	const homeMode = statSync(workerHome).mode & 0o777;
	expect(homeMode & 0o004).toBe(0);
	expect(homeMode & 0o001).toBe(0o001);
	expect(
		statSync(join(workerHome, ".omp", "agent", "agent.db")).mode & 0o777,
	).toBe(0o666);
	// The store's dir is sticky-writable (sqlite journals); sessions and logs
	// are sticky write-only-for-others (each uid keeps its entries private).
	expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o777).toBe(0o777);
	expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o1000).toBe(
		0o1000,
	);
	const sessions = statSync(join(workerHome, ".omp", "agent", "sessions"));
	expect(sessions.mode & 0o777).toBe(0o733);
	expect(sessions.mode & 0o1000).toBe(0o1000);
	// Project dirs under each root carry their project uid and are closed.
	expect(statSync(join(rootA, "proj-a")).uid).toBe(idsA.uid);
	expect(statSync(join(rootA, "proj-a")).mode & 0o777).toBe(0o700);
	expect(statSync(join(rootA, "proj-b")).uid).toBe(idsB.uid);
	expect(statSync(join(rootB, "proj-a")).uid).toBe(idsA.uid);
});

rootTest("bootTurnIsolation skips the chmod on a mounted store", () => {
	const workerHome = freshDir("boot-home-mounted");
	mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
	const db = join(workerHome, ".omp", "agent", "agent.db");
	writeFileSync(db, "store");
	chmodSync(db, 0o600);
	const notes = bootTurnIsolation(workerHome, [], {
		isMounted: (p) => p === db,
	});
	expect(statSync(db).mode & 0o777).toBe(0o600);
	expect(notes.some((n) => n.includes("mount"))).toBe(true);
});

rootTest("bootTurnIsolation leaves a planted store sibling untouched", () => {
	// The store dir is sticky-writable: a turn can plant agent.db-wal as a
	// symlink. Boot refuses the non-plain entry with a note and never chmods
	// through it, so the link's target keeps its mode.
	const workerHome = freshDir("boot-home-wal");
	const agentDir = join(workerHome, ".omp", "agent");
	mkdirSync(agentDir, { recursive: true });
	const foreign = join(freshDir("boot-wal-foreign"), "victim");
	writeFileSync(foreign, "secret");
	chmodSync(foreign, 0o600);
	symlinkSync(foreign, join(agentDir, "agent.db-wal"));
	const db = join(agentDir, "agent.db");
	writeFileSync(db, "store");
	chmodSync(db, 0o600);
	const notes = bootTurnIsolation(workerHome, []);
	expect(notes.some((n) => n.includes("not a plain file"))).toBe(true);
	expect(statSync(foreign).mode & 0o777).toBe(0o600);
	expect(statSync(db).mode & 0o777).toBe(0o666);
});

test("isolationEnabled matches the process uid", () => {
	expect(isolationEnabled()).toBe(
		typeof process.getuid === "function" && process.getuid() === 0,
	);
});

// Per-turn store access (OTTR-1291): stats and chmods only files the test
// owns, so every case runs on every gate, root or not.
describe("ensureTurnStoreAccess", () => {
	/** A layer-copy-shaped store: the copy's agent dir holds a db link into
	 * the flat shared home, like ensureLayerCopy builds for a pinned turn. */
	function freshStore(): {
		workerHome: string;
		storePath: string;
		dbTarget: string;
	} {
		const workerHome = freshDir("store-flat");
		const copyHome = freshDir("store-copy");
		mkdirSync(join(copyHome, ".omp", "agent"), { recursive: true });
		mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
		const dbTarget = join(workerHome, ".omp", "agent", "agent.db");
		writeFileSync(dbTarget, "store");
		const storePath = join(copyHome, ".omp", "agent", "agent.db");
		symlinkSync(dbTarget, storePath);
		return { workerHome, storePath, dbTarget };
	}

	/** The healthy boot state: home 0711, agent dir 01777, store 0666. */
	function healthy(workerHome: string, dbTarget: string): void {
		chmodSync(workerHome, 0o711);
		chmodSync(join(workerHome, ".omp", "agent"), 0o1777);
		chmodSync(dbTarget, 0o666);
	}

	test("a clean tree returns null and leaves the modes untouched", () => {
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		const ids = projectTurnUid("store-clean-proj");
		expect(ensureTurnStoreAccess(workerHome, storePath, ids)).toBeNull();
		expect(statSync(workerHome).mode & 0o777).toBe(0o711);
		expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o7777).toBe(
			0o1777,
		);
		expect(statSync(dbTarget).mode & 0o777).toBe(0o666);
	});

	test("drift through the copy's link restores the flat home and names each entry", () => {
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		writeFileSync(`${dbTarget}-wal`, "wal");
		// The root omp reset between turns: dir 0700, db and wal 0600.
		chmodSync(join(workerHome, ".omp", "agent"), 0o700);
		chmodSync(dbTarget, 0o600);
		chmodSync(`${dbTarget}-wal`, 0o600);
		const ids = projectTurnUid("store-drift-proj");
		expect(ensureTurnStoreAccess(workerHome, storePath, ids)).toBe(
			`turn-uid: shared store modes drifted for uid ${ids.uid}; restored .omp/agent 700->1777, agent.db 600->666, agent.db-wal 600->666`,
		);
		expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o7777).toBe(
			0o1777,
		);
		expect(statSync(dbTarget).mode & 0o777).toBe(0o666);
		expect(statSync(`${dbTarget}-wal`).mode & 0o777).toBe(0o666);
	});

	test("a store at 0644 lacks the others' write bit and restores to 0666", () => {
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		chmodSync(dbTarget, 0o644);
		const ids = projectTurnUid("store-644-proj");
		expect(ensureTurnStoreAccess(workerHome, storePath, ids)).toBe(
			`turn-uid: shared store modes drifted for uid ${ids.uid}; restored agent.db 644->666`,
		);
		expect(statSync(dbTarget).mode & 0o777).toBe(0o666);
	});

	test("an agent dir at 0755 lacks the others' write bit and restores to 01777", () => {
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		chmodSync(join(workerHome, ".omp", "agent"), 0o755);
		const ids = projectTurnUid("store-755-proj");
		expect(ensureTurnStoreAccess(workerHome, storePath, ids)).toBe(
			`turn-uid: shared store modes drifted for uid ${ids.uid}; restored .omp/agent 755->1777`,
		);
		expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o7777).toBe(
			0o1777,
		);
	});

	test("a worker home at 0700 blocks traversal and restores to 0711", () => {
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		chmodSync(workerHome, 0o700);
		const ids = projectTurnUid("store-home-proj");
		expect(ensureTurnStoreAccess(workerHome, storePath, ids)).toBe(
			`turn-uid: shared store modes drifted for uid ${ids.uid}; restored . 700->711`,
		);
		expect(statSync(workerHome).mode & 0o777).toBe(0o711);
	});

	test("a mounted drifted store refuses and changes no mode", () => {
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		chmodSync(workerHome, 0o700);
		chmodSync(join(workerHome, ".omp", "agent"), 0o700);
		chmodSync(dbTarget, 0o600);
		const ids = projectTurnUid("store-mounted-proj");
		let err: Error | null = null;
		try {
			ensureTurnStoreAccess(workerHome, storePath, ids, {
				isMounted: (p) => p === dbTarget,
			});
		} catch (caught) {
			err = caught as Error;
		}
		expect(err).not.toBeNull();
		expect(err!.message).toContain(STORE_MOUNT_BLOCKED);
		expect(err!.message).toContain(dbTarget);
		expect(err!.message).toContain("(mode 600)");
		expect(err!.message).toContain("host");
		// The refusal throws before any chmod: nothing was restored.
		expect(statSync(workerHome).mode & 0o777).toBe(0o700);
		expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o7777).toBe(
			0o700,
		);
		expect(statSync(dbTarget).mode & 0o777).toBe(0o600);
	});

	test("a mounted store with healthy modes does not throw and returns null", () => {
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		const ids = projectTurnUid("store-mounted-ok-proj");
		expect(
			ensureTurnStoreAccess(workerHome, storePath, ids, {
				isMounted: () => true,
			}),
		).toBeNull();
	});

	test("a dangling link naming the trusted store checks the trusted dir only", () => {
		// The db link dangles (the flat db is gone) but names the trusted
		// store: the check verifies the trusted chain, never the uid-owned
		// copy's dirs — root must not chmod a dir the turn can rewrite.
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		const copyAgentDir = dirname(storePath);
		chmodSync(copyAgentDir, 0o755);
		rmSync(dbTarget);
		chmodSync(join(workerHome, ".omp", "agent"), 0o700);
		const ids = projectTurnUid("store-dangling-proj");
		expect(ensureTurnStoreAccess(workerHome, storePath, ids)).toBe(
			`turn-uid: shared store modes drifted for uid ${ids.uid}; restored .omp/agent 700->1777`,
		);
		expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o7777).toBe(
			0o1777,
		);
		// The copy's own agent dir keeps its uid-owned mode.
		expect(statSync(copyAgentDir).mode & 0o7777).toBe(0o755);
		expect(existsSync(dbTarget)).toBe(false);

		// A missing store dir chain fails closed: boot creates `.omp/agent`
		// before any turn, so a missing dir at turn time is a plant, not a
		// fresh deployment.
		const emptyHome = freshDir("store-empty");
		expect(() =>
			ensureTurnStoreAccess(
				emptyHome,
				join(emptyHome, ".omp", "agent", "agent.db"),
				ids,
			),
		).toThrow(/refusing planted store dir/);
	});

	test("a retargeted store link refuses the run and leaves every mode", () => {
		// The copy's agent.db link is uid-owned content: a turn can point it
		// anywhere. The check resolves it and refuses before any chmod, so
		// root's chmod never lands on the foreign target.
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		const foreign = join(freshDir("store-foreign"), "shadow");
		writeFileSync(foreign, "secret");
		chmodSync(foreign, 0o640);
		rmSync(storePath);
		symlinkSync(foreign, storePath);
		const ids = projectTurnUid("store-retarget-proj");
		expect(() => ensureTurnStoreAccess(workerHome, storePath, ids)).toThrow(
			/refusing planted store link .* -> .*shadow/,
		);
		expect(statSync(foreign).mode & 0o777).toBe(0o640);
		expect(statSync(dbTarget).mode & 0o777).toBe(0o666);
	});

	test("a dangling link to a foreign target refuses the run", () => {
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		rmSync(storePath);
		symlinkSync(join(freshDir("store-gone"), "gone"), storePath);
		const ids = projectTurnUid("store-dangling-foreign");
		expect(() => ensureTurnStoreAccess(workerHome, storePath, ids)).toThrow(
			/refusing planted store link/,
		);
		expect(statSync(dbTarget).mode & 0o777).toBe(0o666);
	});

	test("a planted journal symlink refuses the run and keeps the target's mode", () => {
		// The store dir is sticky-writable for every uid: a turn can plant its
		// own agent.db-wal entry as a symlink. The check refuses the entry, so
		// root's chmod never reaches the link's target.
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		const foreign = join(freshDir("store-wal-foreign"), "victim");
		writeFileSync(foreign, "secret");
		chmodSync(foreign, 0o600);
		symlinkSync(foreign, `${dbTarget}-wal`);
		const ids = projectTurnUid("store-wal-proj");
		expect(() => ensureTurnStoreAccess(workerHome, storePath, ids)).toThrow(
			/refusing planted store entry .*agent\.db-wal .*a symlink/,
		);
		expect(statSync(foreign).mode & 0o777).toBe(0o600);
		// The db itself was never reached: the refusal threw before any chmod.
		expect(statSync(dbTarget).mode & 0o777).toBe(0o666);
	});

	test("a planted non-plain store entry refuses the run", () => {
		const { workerHome, storePath, dbTarget } = freshStore();
		healthy(workerHome, dbTarget);
		rmSync(dbTarget);
		mkdirSync(dbTarget); // A directory where the store file belongs.
		const ids = projectTurnUid("store-dir-proj");
		expect(() => ensureTurnStoreAccess(workerHome, storePath, ids)).toThrow(
			/refusing planted store entry .*not a plain file/,
		);
	});
});

rootTest("a cwd naming another project fails the run", () => {
	const ws = freshDir("mismatch-ws");
	const ids = projectTurnUid("mismatch-proj");
	const main = join(ws, "main");
	mkdirSync(join(main, ".git"), { recursive: true });
	mkdirSync(join(main, ".worktrees", "card-1"), { recursive: true });
	expect(() =>
		prepareRunWorkspace(
			join(main, ".worktrees", "card-1"),
			ids,
			ws,
			"other-project",
		),
	).toThrow(/does not belong to project/);
});

// ---------------------------------------------------------------------------
// Project identity provisioning (OTTR-1184)
// ---------------------------------------------------------------------------

// The container's real /etc/passwd at authoring time; the fixture starts every
// provisioning test from real-world data instead of a toy file.
const PASSWD_SNAPSHOT = `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
bin:x:2:2:bin:/bin:/usr/sbin/nologin
sys:x:3:3:sys:/usr/sbin:/usr/sbin/nologin
sync:x:4:65534:sync:/bin:/bin/sync
games:x:5:60:games:/usr/games:/usr/sbin/nologin
man:x:6:12:man:/var/cache/man:/usr/sbin/nologin
lp:x:7:7:lp:/var/spool/lpd:/usr/sbin/nologin
mail:x:8:8:mail:/var/mail:/usr/sbin/nologin
news:x:9:9:news:/var/spool/news:/usr/sbin/nologin
uucp:x:10:10:uucp:/var/spool/uucp:/usr/sbin/nologin
proxy:x:13:13:proxy:/bin:/usr/sbin/nologin
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
backup:x:34:34:backup:/var/backups:/usr/sbin/nologin
list:x:38:38:Mailing List Manager:/var/list:/usr/sbin/nologin
irc:x:39:39:ircd:/run/ircd:/usr/sbin/nologin
_apt:x:42:65534::/nonexistent:/usr/sbin/nologin
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
bun:x:1000:1000::/home/bun:/bin/sh
`;

const GROUP_SNAPSHOT = `root:x:0:
daemon:x:1:
bin:x:2:
sys:x:3:
adm:x:4:
tty:x:5:
disk:x:6:
lp:x:7:
mail:x:8:
news:x:9:
uucp:x:10:
man:x:12:
proxy:x:13:
kmem:x:15:
dialout:x:20:
fax:x:21:
voice:x:22:
cdrom:x:24:
floppy:x:25:
tape:x:26:
sudo:x:27:
audio:x:29:
dip:x:30:
www-data:x:33:
backup:x:34:
operator:x:37:
list:x:38:
irc:x:39:
src:x:40:
shadow:x:42:
utmp:x:43:
video:x:44:
sasl:x:45:
plugdev:x:46:
staff:x:50:
games:x:60:
users:x:100:
nogroup:x:65534:
bun:x:1000:
_ssh:x:101:
`;

/** A turn home layout without the root-only chown: plain temp dirs. */
function fakeTurnHome(project: string): TurnHome {
	const root = freshDir(`fake-home-${project}`);
	const home = join(root, "home");
	const provision = join(root, "ottr");
	mkdirSync(home, { recursive: true });
	mkdirSync(provision, { recursive: true });
	return { root, home, layers: join(root, "layers"), provision };
}

/** A temp passwd/group pair seeded from the real snapshots. */
function freshIdentityFiles(): { passwd: string; group: string } {
	const dir = freshDir("identity");
	const passwd = join(dir, "passwd");
	const group = join(dir, "group");
	writeFileSync(passwd, PASSWD_SNAPSHOT);
	writeFileSync(group, GROUP_SNAPSHOT);
	return { passwd, group };
}

describe("ensureProjectIdentity", () => {
	test("adds one passwd and one group line over the real snapshot", () => {
		const paths = freshIdentityFiles();
		const project = "provision-proj";
		const ids = projectTurnUid(project);
		const turnHome = fakeTurnHome(project);
		ensureProjectIdentity(project, ids, turnHome, paths);

		const passwd = readFileSync(paths.passwd, "utf8");
		const group = readFileSync(paths.group, "utf8");
		const addedPasswd = passwd
			.slice(PASSWD_SNAPSHOT.length)
			.split("\n")
			.filter((line) => line !== "");
		const addedGroup = group
			.slice(GROUP_SNAPSHOT.length)
			.split("\n")
			.filter((line) => line !== "");
		expect(addedPasswd).toHaveLength(1);
		expect(addedGroup).toHaveLength(1);
		const name = `ottr-${ids.uid}`;
		expect(addedPasswd[0]).toBe(
			`${name}:x:${ids.uid}:${ids.gid}:Ottr turn uid for ${project}:${turnHome.home}:/bin/false`,
		);
		expect(addedGroup[0]).toBe(`${name}:x:${ids.gid}:`);

		const before = [passwd, group];
		ensureProjectIdentity(project, ids, turnHome, paths);
		expect([
			readFileSync(paths.passwd, "utf8"),
			readFileSync(paths.group, "utf8"),
		]).toEqual(before);
	});

	test("a name bound to another uid falls back to -r2", () => {
		const paths = freshIdentityFiles();
		const project = "provision-conflict";
		const ids = projectTurnUid(project);
		const turnHome = fakeTurnHome(project);
		writeFileSync(
			paths.passwd,
			`${PASSWD_SNAPSHOT}ottr-${ids.uid}:x:1:1::/:/bin/false\n`,
		);
		ensureProjectIdentity(project, ids, turnHome, paths);
		const line = readFileSync(paths.passwd, "utf8")
			.split("\n")
			.find((l) => l.startsWith(`ottr-${ids.uid}-r2:`));
		expect(line).toBeDefined();
		expect(line?.split(":")[2]).toBe(String(ids.uid));
	});

	test("an unrelated account at the hashed uid fails the run", () => {
		const paths = freshIdentityFiles();
		const project = "provision-id-collision";
		const ids = projectTurnUid(project);
		const turnHome = fakeTurnHome(project);
		writeFileSync(
			paths.passwd,
			`${PASSWD_SNAPSHOT}svc-ldap:x:${ids.uid}:${ids.gid}::/srv/ldap:/bin/false\n`,
		);
		const before = readFileSync(paths.passwd, "utf8");
		expect(() => ensureProjectIdentity(project, ids, turnHome, paths)).toThrow(
			/unrelated/,
		);
		expect(readFileSync(paths.passwd, "utf8")).toBe(before);
	});

	test("an unrelated group at the hashed gid fails the run", () => {
		const paths = freshIdentityFiles();
		const project = "provision-gid-collision";
		const ids = projectTurnUid(project);
		const turnHome = fakeTurnHome(project);
		writeFileSync(paths.group, `${GROUP_SNAPSHOT}svc-ldap:x:${ids.gid}:\n`);
		const beforeGroup = readFileSync(paths.group, "utf8");
		expect(() => ensureProjectIdentity(project, ids, turnHome, paths)).toThrow(
			/unrelated/,
		);
		// The group check runs first: neither file gains an entry.
		expect(readFileSync(paths.group, "utf8")).toBe(beforeGroup);
		expect(readFileSync(paths.passwd, "utf8")).toBe(PASSWD_SNAPSHOT);
	});

	test("our name and id over a foreign home fails the run", () => {
		const paths = freshIdentityFiles();
		const project = "provision-home-collision";
		const ids = projectTurnUid(project);
		const turnHome = fakeTurnHome(project);
		writeFileSync(
			paths.passwd,
			`${PASSWD_SNAPSHOT}ottr-${ids.uid}:x:${ids.uid}:${ids.gid}::/elsewhere:/bin/false\n`,
		);
		expect(() => ensureProjectIdentity(project, ids, turnHome, paths)).toThrow(
			/unrelated/,
		);
	});

	test("an unwritable passwd file fails the run", () => {
		const paths = freshIdentityFiles();
		const project = "provision-readonly";
		const ids = projectTurnUid(project);
		const turnHome = fakeTurnHome(project);
		// A directory in place of the file fails the append for root and
		// non-root alike (root overrides plain file modes): the run fails
		// closed either way.
		paths.passwd = join(dirname(paths.passwd), "passwd-dir");
		mkdirSync(paths.passwd);
		expect(() =>
			ensureProjectIdentity(project, ids, turnHome, paths),
		).toThrow();
	});

	test("property: one line per file, ids match, repeat is a no-op", () => {
		const nameArb = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-._ "), {
				minLength: 1,
				maxLength: 40,
			})
			.map((chars) => chars.join("").replace(/^[.\- ]+/, "") || "p");
		fc.assert(
			fc.property(nameArb, (project) => {
				const dir = mkdtempSync(join(tmpdir(), "ottr-turnuid-prop-"));
				try {
					const paths = { passwd: join(dir, "p"), group: join(dir, "g") };
					writeFileSync(paths.passwd, "");
					writeFileSync(paths.group, "");
					const ids = projectTurnUid(project);
					const turnHome = fakeTurnHome(project);
					ensureProjectIdentity(project, ids, turnHome, paths);
					const passwdLines = readFileSync(paths.passwd, "utf8")
						.split("\n")
						.filter((l) => l !== "");
					const groupLines = readFileSync(paths.group, "utf8")
						.split("\n")
						.filter((l) => l !== "");
					if (passwdLines.length !== 1 || groupLines.length !== 1) return false;
					const passwdFields = passwdLines[0]?.split(":");
					const groupFields = groupLines[0]?.split(":");
					if (passwdFields?.[2] !== String(ids.uid)) return false;
					if (passwdFields?.[3] !== String(ids.gid)) return false;
					if (groupFields?.[2] !== String(ids.gid)) return false;
					const before = [
						readFileSync(paths.passwd, "utf8"),
						readFileSync(paths.group, "utf8"),
					];
					ensureProjectIdentity(project, ids, turnHome, paths);
					return (
						readFileSync(paths.passwd, "utf8") === before[0] &&
						readFileSync(paths.group, "utf8") === before[1]
					);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}),
			{ numRuns: 100 },
		);
	});
});

describe("applyTurnGitEnv", () => {
	test("strips ident vars and pins the project identity", () => {
		const project = "project with spaces";
		const turnHome = fakeTurnHome(project);
		const env: Record<string, string | undefined> = {
			HOME: "/env-home",
			GIT_AUTHOR_NAME: "junk",
			GIT_AUTHOR_EMAIL: "junk@junk",
			GIT_COMMITTER_NAME: "junk",
			GIT_COMMITTER_EMAIL: "junk@junk",
			GIT_CONFIG_SYSTEM: "/keep-me",
		};
		applyTurnGitEnv(env, project, turnHome);
		expect(env.GIT_AUTHOR_NAME).toBeUndefined();
		expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
		expect(env.GIT_COMMITTER_NAME).toBeUndefined();
		expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
		expect(env.GIT_CONFIG_SYSTEM).toBe("/keep-me");
		const gitconfig = join(turnHome.provision, "gitconfig");
		expect(env.GIT_CONFIG_GLOBAL).toBe(gitconfig);
		const content = readFileSync(gitconfig, "utf8");
		expect(content).toContain("[include]");
		expect(content).toContain("path = /env-home/.gitconfig");
		expect(content).toContain("[user]");
		expect(content).toContain("name = project with spaces turn");
		expect(content).toContain("email = ottr+project-with-spaces@localhost");
		// OTTR-693: the include sits after [user], so a configured turn-home
		// identity keeps winning over the project fallback.
		expect(content.indexOf("[user]")).toBeLessThan(
			content.indexOf("[include]"),
		);
	});

	test("without env.HOME the include points at the turn home", () => {
		const project = "no-home-proj";
		const turnHome = fakeTurnHome(project);
		const env: Record<string, string | undefined> = {
			HOME: undefined,
			GIT_AUTHOR_NAME: "junk",
			GIT_AUTHOR_EMAIL: "junk@junk",
			GIT_COMMITTER_NAME: "junk",
			GIT_COMMITTER_EMAIL: "junk@junk",
		};
		applyTurnGitEnv(env, project, turnHome);
		const content = readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8");
		expect(content).toContain("[include]");
		expect(content).toContain(`path = ${turnHome.home}/.gitconfig`);
	});
});

describe("ensureForkCapacity", () => {
	function limits(soft: string, hard: string): string {
		return `Max cpu time            unlimited            unlimited   seconds
Max processes            ${soft}            ${hard}   processes
Max open files            1024              524288   files
`;
	}

	test("unlimited soft needs no raise", () => {
		const dir = freshDir("forkcap");
		const p = join(dir, "limits");
		writeFileSync(p, limits("unlimited", "unlimited"));
		expect(ensureForkCapacity({ limitsPath: p })).toBeNull();
	});

	test("soft below the floor raises to the floor, hard passes through", () => {
		const dir = freshDir("forkcap");
		const p = join(dir, "limits");
		writeFileSync(p, limits("128", "unlimited"));
		let called: [bigint, bigint] | undefined;
		const note = ensureForkCapacity({
			limitsPath: p,
			setLimit: (soft, hard) => {
				called = [soft, hard];
			},
		});
		expect(called ?? null).toEqual([4096n, 18446744073709551615n]);
		expect(note).toBe("fork capacity: max processes soft 128 -> 4096");
	});

	test("soft at the floor needs no raise", () => {
		const dir = freshDir("forkcap");
		const p = join(dir, "limits");
		writeFileSync(p, limits("5000", "5000"));
		expect(ensureForkCapacity({ limitsPath: p })).toBeNull();
	});

	test("a hard cap below the floor caps the target", () => {
		const dir = freshDir("forkcap");
		const p = join(dir, "limits");
		writeFileSync(p, limits("128", "1024"));
		let called: [bigint, bigint] | undefined;
		ensureForkCapacity({
			limitsPath: p,
			floor: 4096,
			setLimit: (soft, hard) => {
				called = [soft, hard];
			},
		});
		expect(called ?? null).toEqual([1024n, 1024n]);
	});

	test("a missing Max processes line returns the non-fatal note", () => {
		const dir = freshDir("forkcap");
		const p = join(dir, "limits");
		writeFileSync(p, "Max open files            1024   files\n");
		expect(ensureForkCapacity({ limitsPath: p })).toBe(
			`fork capacity: could not read max processes from ${p}`,
		);
	});

	test("a throwing setter becomes the raise-failed note", () => {
		const dir = freshDir("forkcap");
		const p = join(dir, "limits");
		writeFileSync(p, limits("128", "unlimited"));
		const note = ensureForkCapacity({
			limitsPath: p,
			setLimit: () => {
				throw new Error("EPERM");
			},
		});
		expect(note?.startsWith("fork capacity: raise failed:")).toBe(true);
	});
});

rootTest("ensureProjectIdentity appends a parseable passwd entry", () => {
	const project = "provision-root";
	const ids = projectTurnUid(project);
	const turnHome = fakeTurnHome(project);
	const paths = freshIdentityFiles();
	ensureProjectIdentity(project, ids, turnHome, paths);
	const fields = readFileSync(paths.passwd, "utf8")
		.split("\n")
		.find((l) => l.split(":")[2] === String(ids.uid))
		?.split(":");
	expect(fields).toBeDefined();
	expect(fields![0]).toBe(`ottr-${ids.uid}`);
	expect(fields![1]).toBe("x");
	expect(fields![2]).toBe(String(ids.uid));
	expect(fields![3]).toBe(String(ids.gid));
	expect(fields![4]).toBe(`Ottr turn uid for ${project}`);
	expect(fields![5]).toBe(turnHome.home);
	expect(fields![6]).toBe("/bin/false");
});

rootTest(
	"a turn's git identity comes from the project config, not inherited env",
	() => {
		const project = "git-identity-regression";
		const ids = projectTurnUid(project);
		// The dropped uid reads the pinned gitconfig and its include through
		// this chain: mkdtemp dirs are root-0700, so the homes root opens up,
		// and prepareTurnHome gives the uid its own 0700 home (the production
		// shape its HOME points at).
		const homesRoot = freshDir("gitid-homes");
		chmodSync(homesRoot, 0o755);
		const turnHome = prepareTurnHome(homesRoot, project, ids);
		const base = freshDir("gitid-repos");
		chmodSync(base, 0o755);
		const rootEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
		const gitAsRoot = (repo: string, ...argv: string[]): void => {
			const r = Bun.spawnSync(["git", "-C", repo, ...argv], {
				stdout: "pipe",
				stderr: "pipe",
				env: rootEnv,
			});
			if (r.exitCode !== 0)
				throw new Error(`git ${argv.join(" ")} failed: ${r.stderr.toString()}`);
		};
		const configless = join(base, "configless");
		mkdirSync(configless, { recursive: true });
		gitAsRoot(configless, "init", "-b", "main");
		chownTree(configless, ids);
		const fixture = join(base, "fixture");
		mkdirSync(fixture, { recursive: true });
		gitAsRoot(fixture, "init", "-b", "main");
		gitAsRoot(fixture, "config", "user.name", "fixture-user");
		gitAsRoot(fixture, "config", "user.email", "fixture@localhost");
		chownTree(fixture, ids);

		const childEnv: Record<string, string | undefined> = {
			...rootEnv,
			HOME: turnHome.home,
			GIT_AUTHOR_NAME: "junk",
			GIT_AUTHOR_EMAIL: "junk@junk",
			GIT_COMMITTER_NAME: "junk",
			GIT_COMMITTER_EMAIL: "junk@junk",
		};
		applyTurnGitEnv(childEnv, project, turnHome);
		expect(childEnv.GIT_AUTHOR_NAME).toBeUndefined();
		expect(childEnv.GIT_AUTHOR_EMAIL).toBeUndefined();
		expect(childEnv.GIT_COMMITTER_NAME).toBeUndefined();
		expect(childEnv.GIT_COMMITTER_EMAIL).toBeUndefined();

		const expectedName = "git-identity-regression turn";
		const expectedEmail = `ottr+${project}@localhost`;
		const drop = (repo: string, cmd: string): string => {
			const r = Bun.spawnSync(
				[
					"setpriv",
					"--reuid",
					String(ids.uid),
					"--regid",
					String(ids.gid),
					"--clear-groups",
					"sh",
					"-c",
					cmd,
				],
				{
					cwd: repo,
					stdout: "pipe",
					stderr: "pipe",
					env: childEnv as Record<string, string>,
				},
			);
			expect(r.exitCode).toBe(0);
			return r.stdout.toString();
		};

		// A configless repo picks up the project identity from the pinned
		// config file, and no inherited env var reaches the ident.
		const ident = drop(configless, "git var GIT_AUTHOR_IDENT");
		expect(ident).toContain(expectedName);
		expect(ident).toContain(expectedEmail);
		expect(ident).not.toContain("junk");

		// A repo-local fixture identity still wins: git precedence puts local
		// config above GIT_CONFIG_GLOBAL, and no env override rides the turn
		// env any more.
		expect(drop(fixture, "git var GIT_AUTHOR_IDENT")).toContain("fixture-user");
		expect(drop(fixture, "git config user.name").trim()).toBe("fixture-user");

		// OTTR-693: a configured turn-home gitconfig keeps winning over the
		// project fallback — the pinned file's include sits after its [user].
		const homeConfig = join(turnHome.home, ".gitconfig");
		writeFileSync(
			homeConfig,
			"[user]\n\tname = home-user\n\temail = home@localhost\n",
		);
		chownSync(homeConfig, ids.uid, ids.gid);
		const homeIdent = drop(configless, "git var GIT_AUTHOR_IDENT");
		expect(homeIdent).toContain("home-user");
		expect(homeIdent).not.toContain(expectedName);
	},
);

rootTest("a turn uid can fork twelve parallel children", () => {
	ensureForkCapacity();
	const ids = projectTurnUid("fork-capacity-probe");
	const probe = Bun.spawnSync(
		[
			"setpriv",
			"--reuid",
			String(ids.uid),
			"--regid",
			String(ids.gid),
			"--clear-groups",
			"sh",
			"-c",
			"i=0; while [ $i -lt 12 ]; do sleep 0.2 & i=$((i+1)); done; wait",
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		},
	);
	expect(probe.stderr.toString()).not.toContain("Cannot fork");
	expect(probe.exitCode).toBe(0);
});

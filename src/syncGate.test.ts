import { afterAll, describe, expect, test } from "bun:test";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	chownSync,
	constants,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixtureGitEnv } from "./gitRepoEnv.ts";
import {
	appendSyncGateRun,
	checkCleanWorktree,
	GATE_OUTPUT_CAP,
	runSyncGate,
	runSyncGateQueued,
	SYNC_GATE_LOG_CAP,
	syncGateFilesError,
	workspaceRootFor,
} from "./syncGate.ts";
import { projectTurnUid } from "./turnUid.ts";
import type { SyncGateRun } from "./types.ts";

const REAL_SYNC = "/workspace/alate/sync.mjs";

const realReadable = (() => {
	try {
		accessSync(REAL_SYNC, constants.R_OK);
		return true;
	} catch {
		return false;
	}
})();

/** Copies the real sync.mjs into a fixture alate dir, together with its support
 *  tree (the deployed script imports ./lib/data.mjs beside itself, so a
 *  sync.mjs-only copy would die on the missing import before any sync runs).
 *  ALATE_HOME (the fixture dir) and every install target stay isolated temp
 *  dirs the test owns. */
function useRealSync(fixtureAlateDir: string): void {
	mkdirSync(fixtureAlateDir, { recursive: true });
	writeFileSync(join(fixtureAlateDir, "sync.mjs"), readFileSync(REAL_SYNC));
	const lib = join(dirname(REAL_SYNC), "lib");
	if (existsSync(lib)) {
		cpSync(lib, join(fixtureAlateDir, "lib"), { recursive: true });
	}
}

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), `ottr-syncgate-${prefix}-`));
	dirs.push(d);
	return d;
}

const sh = (cmd: string, cwd: string): void => {
	execSync(cmd, { cwd, stdio: "ignore", env: fixtureGitEnv() });
};

const shaOf = (content: string): string =>
	createHash("sha256").update(content).digest("hex");

/** A committed card worktree whose HEAD carries the three install roots the
 *  agent-data contract maps: a projects/ context file, a root rule, a user file.
 *  The card branch changes all three. Returns the base sha. */
function seedWorktree(dir: string): string {
	mkdirSync(join(dir, "projects/ottr"), { recursive: true });
	mkdirSync(join(dir, "user/.omp/agent"), { recursive: true });
	writeFileSync(join(dir, "projects/ottr/AGENTS.md"), "base agents\n");
	writeFileSync(join(dir, "guard.md"), "base rule\n");
	writeFileSync(join(dir, "user/.omp/agent/config.yml"), "base user\n");
	writeFileSync(join(dir, ".gitignore"), "scratch-*\n");
	writeFileSync(join(dir, "README.md"), "readme\n");
	sh("git init -q -b main", dir);
	sh("git config user.email t@t && git config user.name t", dir);
	sh("git add -A && git commit -qm base", dir);
	const base = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
	sh("git checkout -q -b ott/card", dir);
	writeFileSync(join(dir, "projects/ottr/AGENTS.md"), "card agents\n");
	writeFileSync(join(dir, "guard.md"), "card rule\n");
	writeFileSync(join(dir, "user/.omp/agent/config.yml"), "card user\n");
	sh("git add -A && git commit -qm card", dir);
	return base;
}

/** The mechanics probe: a transparent stand-in for runner-mechanics tests only.
 *  It enforces the argv contract (exit 2 without --data, so a launcher that
 *  drops the flag fails every mechanics test), echoes its argv, and prints the
 *  sha256 of one data file it was handed — it installs nothing, so no test can
 *  mistake its behavior for the real sync's. Sync-behavior acceptance runs
 *  against the real script via useRealSync below. */
function seedProbe(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "sync.mjs"),
		[
			`import { createHash } from "node:crypto";`,
			`import { readFileSync } from "node:fs";`,
			`import { join, relative, resolve } from "node:path";`,
			`console.log("argv " + JSON.stringify(process.argv));`,
			`const flag = process.argv.indexOf("--data");`,
			`const data = flag === -1 ? null : process.argv[flag + 1];`,
			`if (data === undefined || data === null) { console.error("probe: no --data path"); process.exit(2); }`,
			`const root = resolve(data);`,
			`const probe = join(root, "projects", "ottr", "AGENTS.md");`,
			`try {`,
			`  const bytes = readFileSync(probe);`,
			`  console.log("probe sha256 " + relative(root, probe) + " " + createHash("sha256").update(bytes).digest("hex"));`,
			`} catch {`,
			`  console.log("probe sha256 projects/ottr/AGENTS.md absent");`,
			`}`,
			`console.log("probe done");`,
			"",
		].join("\n"),
	);
}

/** A committed data dir carrying two root rules — one with the frontmatter the
 *  deployed sync.mjs requires, one without — for the real-script acceptance
 *  runs. Returns the base sha. */
function seedRuleData(dir: string): string {
	writeFileSync(
		join(dir, "rule-ok.md"),
		"---\nname: sync-gate-probe\ndescription: probe rule\n---\n\n# probe rule body\n",
	);
	writeFileSync(join(dir, "rule-bad.md"), "# no frontmatter here\n");
	sh("git init -q -b main", dir);
	sh("git config user.email t@t && git config user.name t", dir);
	sh("git add -A && git commit -qm base", dir);
	const base = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
	sh("git checkout -q -b ott/card", dir);
	writeFileSync(
		join(dir, "rule-ok.md"),
		"---\nname: sync-gate-probe\ndescription: probe rule\n---\n\n# changed probe rule body\n",
	);
	// Both rules change on the branch, so both enter the diff-based hash set and
	// the acceptance can pin each one's outcome against the deployed script.
	writeFileSync(join(dir, "rule-bad.md"), "# still no frontmatter here\n");
	sh("git add -A && git commit -qm card", dir);
	return base;
}

function targetFor(opts: {
	root: string;
	worktree?: string;
	base?: string | null;
	project?: string;
	alateDir?: string;
	home?: string;
	extraFiles?: string[];
}): Parameters<typeof runSyncGate>[0] {
	return {
		project: opts.project ?? "agent-data",
		worktree: opts.worktree ?? join(opts.root, "wt"),
		alateDir: opts.alateDir ?? join(opts.root, "alate"),
		workspaceRoot: workspaceRootFor(join(opts.root, "agent-data")),
		home: opts.home ?? join(opts.root, "home"),
		base: opts.base === undefined ? null : opts.base,
		...(opts.extraFiles !== undefined ? { extraFiles: opts.extraFiles } : {}),
	};
}

describe("appendSyncGateRun", () => {
	test("keeps the newest records only", () => {
		const run = (at: number): SyncGateRun => ({
			at,
			code: 0,
			output: "",
			truncated: false,
			files: [],
			durationMs: 0,
		});
		let kept: SyncGateRun[] = [];
		for (let i = 0; i < SYNC_GATE_LOG_CAP + 5; i++)
			kept = appendSyncGateRun(kept, run(i));
		expect(kept.length).toBe(SYNC_GATE_LOG_CAP);
		expect(kept[0]?.at).toBe(5);
		expect(kept.at(-1)?.at).toBe(SYNC_GATE_LOG_CAP + 4);
	});
});

describe("checkCleanWorktree", () => {
	test("a committed tree passes", async () => {
		const root = freshDir("clean");
		seedWorktree(root);
		expect(
			await checkCleanWorktree(root, join(root, "alate"), join(root, "home")),
		).toEqual({ ok: true });
	});

	test("a dirty tree names the status lines", async () => {
		const root = freshDir("dirty");
		seedWorktree(root);
		writeFileSync(join(root, "projects/ottr/AGENTS.md"), "uncommitted\n");
		writeFileSync(join(root, "untracked.txt"), "x");
		const guard = await checkCleanWorktree(
			root,
			join(root, "alate"),
			join(root, "home"),
		);
		expect(guard.ok).toBe(false);
		if (!guard.ok) expect(guard.status).toContain("AGENTS.md");
	});

	test("a non-git dir refuses", async () => {
		const root = freshDir("nogit");
		mkdirSync(root, { recursive: true });
		const guard = await checkCleanWorktree(
			root,
			join(root, "alate"),
			join(root, "home"),
		);
		expect(guard).toEqual({ ok: false, error: "not a git worktree" });
	});
});

describe("syncGateFilesError", () => {
	test("accepts mapped paths and rejects traversal and unmapped names", () => {
		expect(syncGateFilesError(undefined)).toBe(null);
		expect(syncGateFilesError(["projects/ottr/AGENTS.md"])).toBe(null);
		expect(syncGateFilesError(["user/.omp/agent/config.yml"])).toBe(null);
		expect(syncGateFilesError(["guard.md"])).toBe(null);
		expect(syncGateFilesError("nope")).toContain("must be a list");
		expect(syncGateFilesError(["../evil"])).toContain("must not traverse");
		expect(syncGateFilesError(["projects/../../x"])).toContain(
			"must not traverse",
		);
		expect(syncGateFilesError(["/abs/path"])).toContain("must not traverse");
		expect(syncGateFilesError(["docs/readme.md"])).toContain(
			"maps to no installed location",
		);
		expect(
			syncGateFilesError(Array.from({ length: 17 }, () => "guard.md")),
		).toContain("at most 16");
	});
});

describe("runSyncGate", () => {
	test("spawns the documented command inside the HEAD snapshot and records it", async () => {
		const root = freshDir("happy");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const base = seedWorktree(wt);
		const alateDir = join(root, "alate");
		const home = join(root, "home");
		seedProbe(alateDir);
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, base, alateDir, home }),
		);
		// The command contract: `node <sync.mjs> --data .` exactly — the probe
		// echoes its argv, so a launcher that drops the flag fails here.
		const argvLine = record.output
			.split("\n")
			.find((l) => l.startsWith("argv "));
		expect(argvLine).toBeDefined();
		const argv = JSON.parse(argvLine!.slice("argv ".length)) as string[];
		expect(argv.slice(-2)).toEqual(["--data", "."]);
		expect(argv[1]).toBe(join(alateDir, "sync.mjs"));
		// The run pins the commit it installed.
		expect(record.head).toBe(
			execSync("git rev-parse HEAD", { cwd: wt }).toString().trim(),
		);
		expect(record.code).toBe(0);
		expect(record.truncated).toBe(false);
		expect(record.output).toContain("probe done");
		// The child saw the snapshot's HEAD bytes for its data root, not the
		// worktree's disk.
		const shaLine = record.output
			.split("\n")
			.find((l) => l.startsWith("probe sha256 "));
		expect(shaLine).toBeDefined();
		const observedSha = shaLine!.trim().split(" ").at(-1);
		expect(observedSha).toBe(shaOf("card agents\n"));
		expect(record.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("an assume-unchanged edit and an ignored rule never reach the child", async () => {
		const root = freshDir("bypass");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const base = seedWorktree(wt);
		const alateDir = join(root, "alate");
		const home = join(root, "home");
		seedProbe(alateDir);
		// The drilled bypass: disk bytes that git status --porcelain cannot see.
		writeFileSync(join(wt, "projects/ottr/AGENTS.md"), "PLANTED-BYTES\n");
		sh("git update-index --assume-unchanged projects/ottr/AGENTS.md", wt);
		writeFileSync(join(wt, "scratch-rule.md"), "IGNORED-BYTES\n");
		// Precondition: the guard alone is blind to both.
		const status = execSync("git status --porcelain", { cwd: wt }).toString();
		expect(status).toBe("");
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, base, alateDir, home }),
		);
		expect(record.code).toBe(0);
		// The probe read the snapshot's HEAD bytes; the planted bytes never reached
		// the child's data root, and the ignored file is not in the archive at all.
		const shaLine = record.output
			.split("\n")
			.find((l) => l.startsWith("probe sha256 "));
		expect(shaLine?.endsWith(shaOf("card agents\n"))).toBe(true);
		expect(record.output).not.toContain("PLANTED-BYTES");
		expect(record.output).not.toContain("IGNORED-BYTES");
	});

	test("a worktree with no branch changes hashes only the requested extras", async () => {
		const root = freshDir("extras");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		seedWorktree(wt);
		// Back on main: the branch changed nothing, so the changed set is empty.
		sh("git checkout -q main", wt);
		const alateDir = join(root, "alate");
		const home = join(root, "home");
		seedProbe(alateDir);
		// Hashing-logic fixture: the test plants the installed twin itself, so the
		// assertion covers the gate's twin resolution and comparison, not any
		// installer's behavior.
		mkdirSync(join(home, ".omp/agent/rules"), { recursive: true });
		writeFileSync(join(home, ".omp/agent/rules/guard.md"), "base rule\n");
		const record = await runSyncGate(
			targetFor({
				root,
				worktree: wt,
				base: null,
				alateDir,
				home,
				extraFiles: ["guard.md"],
			}),
		);
		expect(record.code).toBe(0);
		expect(record.files.map((f) => f.path)).toEqual(["guard.md"]);
		// HEAD's rule bytes are what main carries.
		expect(record.files[0]?.sourceSha256).toBe(shaOf("base rule\n"));
		expect(record.files[0]?.match).toBe(true);
	});

	test("a stale installed twin records match false for the requested file", async () => {
		const root = freshDir("drift");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		seedWorktree(wt);
		sh("git checkout -q main", wt);
		const alateDir = join(root, "alate");
		const home = join(root, "home");
		seedProbe(alateDir);
		mkdirSync(join(home, ".omp/agent/rules"), { recursive: true });
		writeFileSync(join(home, ".omp/agent/rules/guard.md"), "stale install\n");
		const record = await runSyncGate(
			targetFor({
				root,
				worktree: wt,
				base: null,
				alateDir,
				home,
				extraFiles: ["guard.md"],
			}),
		);
		expect(record.files[0]?.match).toBe(false);
		expect(record.files[0]?.sourceSha256).toBe(shaOf("base rule\n"));
		expect(record.files[0]?.installedSha256).toBe(shaOf("stale install\n"));
	});

	test("a missing sync.mjs records the refusal", async () => {
		const root = freshDir("nosync");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		seedWorktree(wt);
		mkdirSync(join(root, "alate"), { recursive: true });
		const record = await runSyncGate(targetFor({ root, worktree: wt }));
		expect(record.code).toBe(null);
		expect(record.error).toContain("no sync.mjs");
	});

	test("a dirty worktree records the refusal with the status lines", async () => {
		const root = freshDir("guard");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		seedWorktree(wt);
		writeFileSync(join(wt, "dirty.txt"), "x");
		const alateDir = join(root, "alate");
		const home = join(root, "home");
		seedProbe(alateDir);
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, alateDir, home }),
		);
		expect(record.code).toBe(null);
		expect(record.error).toContain("worktree not committed");
		expect(record.error).toContain("dirty.txt");
	});

	test("a foreign project records the refusal", async () => {
		const root = freshDir("foreign");
		const record = await runSyncGate(targetFor({ root, project: "ottr" }));
		expect(record.code).toBe(null);
		expect(record.error).toContain("agent-data");
	});

	test("a missing node binary records the spawn error", async () => {
		const root = freshDir("nonode");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		seedWorktree(wt);
		const alateDir = join(root, "alate");
		const home = join(root, "home");
		seedProbe(alateDir);
		// The gate env pins PATH, so a PATH without node must fail the spawn into
		// an error record instead of a fake pass.
		const saved = process.env.PATH;
		process.env.PATH = "/nonexistent-bin";
		try {
			const record = await runSyncGate(
				targetFor({ root, worktree: wt, alateDir, home }),
			);
			expect(record.code).toBe(null);
			expect(record.error).toBeTruthy();
		} finally {
			process.env.PATH = saved;
		}
	});

	test("output past the cap truncates with the flag", async () => {
		const root = freshDir("cap");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		seedWorktree(wt);
		const alateDir = join(root, "alate");
		mkdirSync(alateDir, { recursive: true });
		writeFileSync(
			join(alateDir, "sync.mjs"),
			[
				"for (let i = 0; i < 4000; i++) console.log('x'.repeat(30));",
				"console.log('tail');",
				"",
			].join("\n"),
		);
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, alateDir, home: join(root, "home") }),
		);
		expect(record.code).toBe(0);
		expect(record.truncated).toBe(true);
		expect(record.output.length).toBe(GATE_OUTPUT_CAP);
		expect(record.output).not.toContain("tail");
	});
});

// Acceptance against the deployed installer: the real /workspace/alate/sync.mjs
// runs (copied into an isolated ALATE_HOME fixture, with isolated install
// targets), so the tests prove the gate's integration with the actual script's
// contract — it processes only root rules and rejects files without frontmatter
// — and never a replacement's behavior. Where the alate checkout is not
// readable, they skip visibly with that reason instead of passing vacuously.

describe("real sync.mjs acceptance", () => {
	test.skipIf(!realReadable)(
		"the gate runs the deployed script: root rules install, frontmatter-less files do not (skips where /workspace/alate is unreadable)",
		async () => {
			if (!realReadable)
				console.warn(
					`skip: the real ${REAL_SYNC} is not readable from this uid (${typeof process.getuid === "function" ? process.getuid() : "?"}); the acceptance run needs the board's root-side check environment`,
				);
			const root = freshDir("real");
			const wt = join(root, "wt");
			mkdirSync(wt, { recursive: true });
			const base = seedRuleData(wt);
			const alateDir = join(root, "alate");
			const home = join(root, "home");
			// Isolated ALATE_HOME (the fixture dir carries the real script) and an
			// isolated install home; the workspace root is a temp dir too.
			useRealSync(alateDir);
			const record = await runSyncGate(
				targetFor({ root, worktree: wt, base, alateDir, home }),
			);
			// A real spawn happened and was recorded against the pinned commit.
			expect(record.code).not.toBe(null);
			expect(record.head).toBe(
				execSync("git rev-parse HEAD", { cwd: wt }).toString().trim(),
			);
			expect(record.output).not.toBe("");
			// Both rule paths are contract-mapped, so the record hashes their
			// snapshot sources.
			const byPath = new Map(record.files.map((f) => [f.path, f]));
			expect(byPath.get("rule-ok.md")?.sourceSha256).toBe(
				shaOf(
					"---\nname: sync-gate-probe\ndescription: probe rule\n---\n\n# changed probe rule body\n",
				),
			);
			expect(byPath.get("rule-bad.md")?.sourceSha256).toBe(
				shaOf("# still no frontmatter here\n"),
			);
			// The deployed script rejects frontmatter-less files: nothing installs to
			// the rule twin location for rule-bad.md.
			expect(existsSync(join(home, ".omp/agent/rules/rule-bad.md"))).toBe(
				false,
			);
			// The deployed script processes root rules with frontmatter: the valid
			// rule's twin exists, carries the committed bytes, and the record's
			// hash comparison says so — unconditionally, so a regression in the
			// launcher, the snapshot, or the hashing cannot pass vacuously.
			const ok = byPath.get("rule-ok.md");
			expect(ok?.installedSha256).not.toBeNull();
			expect(ok?.match).toBe(true);
			expect(
				readFileSync(join(home, ".omp/agent/rules/rule-ok.md"), "utf8"),
			).toBe(
				"---\nname: sync-gate-probe\ndescription: probe rule\n---\n\n# changed probe rule body\n",
			);
		},
	);
});

describe("runSyncGateQueued", () => {
	test("two runs for one project serialize in call order", async () => {
		const root = freshDir("queue");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		seedWorktree(wt);
		const alateDir = join(root, "alate");
		mkdirSync(alateDir, { recursive: true });
		const marker = join(root, "order.txt");
		writeFileSync(
			join(alateDir, "sync.mjs"),
			[
				`import { appendFileSync } from "node:fs";`,
				`const marker = ${JSON.stringify(marker)};`,
				`const tag = process.pid;`,
				// The script sleeps between its own markers, so a second run that
				// starts inside the window would interleave its lines if the queue
				// did not serialize. The pid tags each run: the gate env is an
				// allowlist, so no test-set variable can ride in.
				`appendFileSync(marker, "start " + tag + "\\n");`,
				`await new Promise((r) => setTimeout(r, 300));`,
				`appendFileSync(marker, "end " + tag + "\\n");`,
				`console.log(String(tag));`,
				"",
			].join("\n"),
		);
		// Deterministic overlap attempt without a guessed wait: poll the marker
		// file for the first run's start line (the subprocess exposes no event
		// channel), then fire the second call. A broken queue interleaves the
		// lines and fails the pairing asserts below; the queue keeps them apart.
		const until = async (text: string): Promise<void> => {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				if (existsSync(marker) && readFileSync(marker, "utf8").includes(text))
					return;
				await new Promise((r) => setTimeout(r, 5));
			}
			throw new Error(`marker never reached ${text}`);
		};
		const first = runSyncGateQueued(
			targetFor({ root, worktree: wt, alateDir, home: join(root, "home") }),
		);
		await until("start ");
		const second = runSyncGateQueued(
			targetFor({ root, worktree: wt, alateDir, home: join(root, "home") }),
		);
		const [r1, r2] = await Promise.all([first, second]);
		expect(r1.code).toBe(0);
		expect(r2.code).toBe(0);
		const lines = readFileSync(marker, "utf8").trim().split("\n");
		// Two tagged runs, never interleaved: the second run's start marker can
		// only land after the first run's end marker when the queue serializes.
		expect(lines.length).toBe(4);
		const tagOf = (line: string, word: string): string =>
			line.startsWith(`${word} `) ? line.slice(word.length + 1) : "";
		const a = tagOf(lines[0]!, "start");
		expect(a).not.toBe("");
		expect(tagOf(lines[1]!, "end")).toBe(a);
		const b = tagOf(lines[2]!, "start");
		expect(b).not.toBe("");
		expect(b).not.toBe(a);
		expect(tagOf(lines[3]!, "end")).toBe(b);
	});
});

describe("agent-data uid cannot write the alate checkout", () => {
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	const rootTest = isRoot ? test : test.skip;

	test("the two projects derive different turn uids", () => {
		expect(projectTurnUid("agent-data").uid).not.toBe(
			projectTurnUid("alate").uid,
		);
	});

	rootTest(
		"a traversable workspace keeps the mode-700 alate dir closed to the agent-data uid",
		async () => {
			const root = freshDir("uid");
			// The workspace root mirrors the live layout: traversable, so the
			// boundary under test is the alate dir's own permissions, never the
			// parent's.
			chmodSync(root, 0o755);
			const alateDir = join(root, "alate");
			mkdirSync(alateDir, { recursive: true });
			const alateIds = projectTurnUid("alate");
			const agentIds = projectTurnUid("agent-data");
			expect(agentIds.uid).not.toBe(alateIds.uid);
			chownSync(alateDir, alateIds.uid, alateIds.gid);
			chmodSync(alateDir, 0o700);
			const script = `require("node:fs").writeFileSync(${JSON.stringify(join(alateDir, "x"))}, "x");`;
			const runChild = (uid?: number, gid?: number): Promise<number> => {
				const { promise, resolve } = Promise.withResolvers<number>();
				const child = spawn(process.execPath, ["-e", script], {
					...(uid !== undefined ? { uid, gid } : {}),
					stdio: ["ignore", "ignore", "ignore"],
				});
				child.on("error", () => resolve(-1));
				child.on("close", (code) => resolve(code ?? -1));
				return promise;
			};
			// The agent-data uid traverses the workspace but cannot create the file:
			// the gate gives a turn no rights on another project's checkout.
			expect(await runChild(agentIds.uid, agentIds.gid)).not.toBe(0);
			expect(existsSync(join(alateDir, "x"))).toBe(false);
			// Positive control under the alate uid: the same write succeeds for the
			// dir's owner, so the denial is permission-shaped, not a broken fixture.
			expect(await runChild(alateIds.uid, alateIds.gid)).toBe(0);
			expect(existsSync(join(alateDir, "x"))).toBe(true);
		},
	);
});

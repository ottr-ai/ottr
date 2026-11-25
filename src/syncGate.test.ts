import { afterAll, describe, expect, test } from "bun:test";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** The fixture alate checkout: sync.mjs under the documented agent-data contract.
 *  It requires `--data <dir>` and uses that value as the data root (never cwd, so
 *  a launcher that drops the flag fails every test), reads the projects root from
 *  its ALATE_HOME config, installs root *.md rules into the home's
 *  .omp/agent/rules, user/ files below the home, and projects/ files into the
 *  projects root, and echoes its argv so tests can pin the spawned command. */
function seedAlate(
	dir: string,
	projectsRoot: string,
	skips: string[] = [],
): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "sync.mjs"),
		[
			`import { readdirSync, readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";`,
			`import { join, dirname, relative } from "node:path";`,
			`const skip = ${JSON.stringify(skips)};`,
			`console.log("argv " + JSON.stringify(process.argv));`,
			`const flag = process.argv.indexOf("--data");`,
			`const data = flag === -1 ? null : process.argv[flag + 1];`,
			`if (data === undefined || data === null) { console.error("sync: no --data path"); process.exit(2); }`,
			`const alate = process.env.ALATE_HOME;`,
			`if (alate === undefined) { console.error("sync: ALATE_HOME is unset"); process.exit(1); }`,
			`const rootFile = join(alate, "projects-root.txt");`,
			`if (!existsSync(rootFile)) { console.error("sync: no projects root config"); process.exit(2); }`,
			`const home = process.env.HOME;`,
			`if (home === undefined) { console.error("sync: HOME is unset"); process.exit(1); }`,
			`const projectsRoot = readFileSync(rootFile, "utf8").trim();`,
			`const walk = (dir) => {`,
			`  for (const e of readdirSync(dir, { withFileTypes: true })) {`,
			`    const p = join(dir, e.name);`,
			`    if (e.isDirectory()) walk(p);`,
			`    else {`,
			`      const rel = relative(data, p);`,
			`      if (skip.includes(rel)) { console.log("sync: skipped " + rel); continue; }`,
			`      let out = null;`,
			`      if (rel.startsWith("projects/")) out = join(projectsRoot, rel.slice("projects/".length));`,
			`      else if (rel.startsWith("user/")) out = join(home, rel.slice("user/".length));`,
			`      else if (/^[^/]+\\.md$/.test(rel)) out = join(home, ".omp", "agent", "rules", rel);`,
			`      if (out !== null) {`,
			`        mkdirSync(dirname(out), { recursive: true });`,
			`        copyFileSync(p, out);`,
			`        console.log("sync: installed " + rel);`,
			`      }`,
			`    }`,
			`  }`,
			`};`,
			`walk(data);`,
			`console.log("sync: done");`,
			"",
		].join("\n"),
	);
	writeFileSync(join(dir, "projects-root.txt"), projectsRoot);
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
	test("spawns the documented command against an immutable HEAD archive and records it", async () => {
		const root = freshDir("happy");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const base = seedWorktree(wt);
		const alateDir = join(root, "alate");
		const home = join(root, "home");
		mkdirSync(join(root, "agent-data"), { recursive: true });
		seedAlate(alateDir, root);
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, base, alateDir, home }),
		);
		// The command contract: `node <sync.mjs> --data .` exactly — the fixture
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
		expect(record.output).toContain("sync: installed projects/ottr/AGENTS.md");
		expect(record.output).toContain("sync: installed guard.md");
		expect(record.output).toContain(
			"sync: installed user/.omp/agent/config.yml",
		);
		expect(record.output).toContain("sync: done");
		// All three install roots hashed against their twins, matching HEAD bytes.
		const byPath = new Map(record.files.map((f) => [f.path, f]));
		expect(byPath.get("projects/ottr/AGENTS.md")?.match).toBe(true);
		expect(byPath.get("guard.md")?.match).toBe(true);
		expect(byPath.get("user/.omp/agent/config.yml")?.match).toBe(true);
		// The installed twins carry the HEAD bytes at the contract locations.
		expect(readFileSync(join(root, "ottr/AGENTS.md"), "utf8")).toBe(
			"card agents\n",
		);
		expect(readFileSync(join(home, ".omp/agent/rules/guard.md"), "utf8")).toBe(
			"card rule\n",
		);
		expect(readFileSync(join(home, ".omp/agent/config.yml"), "utf8")).toBe(
			"card user\n",
		);
		expect(record.durationMs).toBeGreaterThanOrEqual(0);
		// The install target is the workspace root, not the data checkout.
		expect(existsSync(join(root, "agent-data/ottr/AGENTS.md"))).toBe(false);
	});

	test("an assume-unchanged edit and an ignored rule never reach the install", async () => {
		const root = freshDir("bypass");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const base = seedWorktree(wt);
		void base;
		const alateDir = join(root, "alate");
		const home = join(root, "home");
		seedAlate(alateDir, root);
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
		// The install carries the HEAD bytes, never the planted disk bytes.
		expect(readFileSync(join(root, "ottr/AGENTS.md"), "utf8")).toBe(
			"card agents\n",
		);
		expect(existsSync(join(home, ".omp/agent/rules/scratch-rule.md"))).toBe(
			false,
		);
		const byPath = new Map(record.files.map((f) => [f.path, f]));
		expect(byPath.get("projects/ottr/AGENTS.md")?.sourceSha256).toBe(
			shaOf("card agents\n"),
		);
		expect(byPath.get("projects/ottr/AGENTS.md")?.match).toBe(true);
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
		seedAlate(alateDir, root);
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

	test("an installed twin that drifts from the commit records match false", async () => {
		const root = freshDir("drift");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const base = seedWorktree(wt);
		const alateDir = join(root, "alate");
		const home = join(root, "home");
		// The card's file is not manifest-covered: sync skips it and a stale twin
		// stays behind — exactly the drift the hashes exist to catch.
		seedAlate(alateDir, root, ["projects/ottr/AGENTS.md"]);
		mkdirSync(join(root, "ottr"), { recursive: true });
		writeFileSync(join(root, "ottr/AGENTS.md"), "stale install\n");
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, base, alateDir, home }),
		);
		expect(record.code).toBe(0);
		expect(record.output).toContain("sync: skipped projects/ottr/AGENTS.md");
		const byPath = new Map(record.files.map((f) => [f.path, f]));
		const projectsEntry = byPath.get("projects/ottr/AGENTS.md");
		expect(projectsEntry?.match).toBe(false);
		expect(projectsEntry?.sourceSha256).toBe(shaOf("card agents\n"));
		expect(projectsEntry?.installedSha256).toBe(shaOf("stale install\n"));
		// Once the install covers the file again, the same gate records match.
		seedAlate(alateDir, root);
		const second = await runSyncGate(
			targetFor({ root, worktree: wt, base, alateDir, home }),
		);
		expect(second.files[0]?.match).toBe(true);
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
		seedAlate(alateDir, root);
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, alateDir, home }),
		);
		expect(record.code).toBe(null);
		expect(record.error).toContain("worktree not committed");
		expect(record.error).toContain("dirty.txt");
		// The gate never ran, so no twin was installed.
		expect(existsSync(join(root, "ottr"))).toBe(false);
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
		seedAlate(alateDir, root);
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

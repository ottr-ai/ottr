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

/** A committed card worktree: main holds the base commit, the card branch changes
 *  one projects/ file and adds a second commit. Returns the base sha. */
function seedWorktree(dir: string): string {
	mkdirSync(join(dir, "projects/ottr"), { recursive: true });
	writeFileSync(join(dir, "projects/ottr/AGENTS.md"), "base agents\n");
	writeFileSync(join(dir, "README.md"), "readme\n");
	sh("git init -q -b main", dir);
	sh("git config user.email t@t && git config user.name t", dir);
	sh("git add -A && git commit -qm base", dir);
	const base = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
	sh("git checkout -q -b ott/card", dir);
	writeFileSync(join(dir, "projects/ottr/AGENTS.md"), "card agents\n");
	sh("git add -A && git commit -qm card", dir);
	return base;
}

/** The fixture alate checkout: sync.mjs mirrors the real script's contract — it
 *  reads the data repo at cwd, reads the projects root from its ALATE_HOME config,
 *  and installs every manifest-covered projects/ file there. `skips` lists the
 *  data-repo-relative paths the install passes over (a stale twin stays behind). */
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
			`import { join, dirname } from "node:path";`,
			`const skip = ${JSON.stringify(skips)};`,
			`const alate = process.env.ALATE_HOME;`,
			`if (alate === undefined) { console.error("sync: ALATE_HOME is unset"); process.exit(1); }`,
			`const rootFile = join(alate, "projects-root.txt");`,
			`if (!existsSync(rootFile)) { console.error("sync: no projects root config"); process.exit(2); }`,
			`const projectsRoot = readFileSync(rootFile, "utf8").trim();`,
			`const data = process.cwd();`,
			`const walk = (dir) => {`,
			`  for (const e of readdirSync(dir, { withFileTypes: true })) {`,
			`    const p = join(dir, e.name);`,
			`    if (e.isDirectory()) walk(p);`,
			`    else if (e.name.endsWith(".md")) {`,
			`      const rel = p.slice(data.length + 1);`,
			`      if (skip.includes(rel)) { console.log("sync: skipped " + rel); continue; }`,
			`      const rest = rel.slice("projects/".length);`,
			`      const out = join(projectsRoot, rest);`,
			`      mkdirSync(dirname(out), { recursive: true });`,
			`      copyFileSync(p, out);`,
			`      console.log("sync: installed " + rest);`,
			`    }`,
			`  }`,
			`};`,
			`walk(join(data, "projects"));`,
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
}): Parameters<typeof runSyncGate>[0] {
	return {
		project: opts.project ?? "agent-data",
		worktree: opts.worktree ?? join(opts.root, "wt"),
		alateDir: opts.alateDir ?? join(opts.root, "alate"),
		workspaceRoot: workspaceRootFor(join(opts.root, "agent-data")),
		base: opts.base === undefined ? null : opts.base,
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
		expect(await checkCleanWorktree(root)).toEqual({ ok: true });
	});

	test("a dirty tree names the status lines", async () => {
		const root = freshDir("dirty");
		seedWorktree(root);
		writeFileSync(join(root, "projects/ottr/AGENTS.md"), "uncommitted\n");
		writeFileSync(join(root, "untracked.txt"), "x");
		const guard = await checkCleanWorktree(root);
		expect(guard.ok).toBe(false);
		if (!guard.ok) expect(guard.status).toContain("AGENTS.md");
	});

	test("a non-git dir refuses", async () => {
		const root = freshDir("nogit");
		mkdirSync(root, { recursive: true });
		const guard = await checkCleanWorktree(root);
		expect(guard).toEqual({ ok: false, error: "not a git worktree" });
	});
});

describe("runSyncGate", () => {
	test("a work run receives the real exit code and output of sync.mjs and the installed hash", async () => {
		const root = freshDir("happy");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const base = seedWorktree(wt);
		const alateDir = join(root, "alate");
		const agentCheckout = join(root, "agent-data");
		mkdirSync(agentCheckout, { recursive: true });
		seedAlate(alateDir, root);
		// The twin the fixture sync installs: the worktree's committed content, so
		// the hashes match like a real install.
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, base, alateDir }),
		);
		expect(record.code).toBe(0);
		expect(record.truncated).toBe(false);
		expect(record.output).toContain("sync: installed ottr/AGENTS.md");
		expect(record.output).toContain("sync: done");
		expect(record.files.length).toBe(1);
		const hash = record.files[0]!;
		expect(hash.path).toBe("projects/ottr/AGENTS.md");
		expect(hash.match).toBe(true);
		const sha = createHash("sha256").update("card agents\n").digest("hex");
		expect(hash.sourceSha256).toBe(sha);
		expect(hash.installedSha256).toBe(sha);
		expect(record.durationMs).toBeGreaterThanOrEqual(0);
		// The installed twin really exists at the workspace root, not the checkout.
		expect(existsSync(join(root, "ottr/AGENTS.md"))).toBe(true);
		expect(existsSync(join(agentCheckout, "ottr/AGENTS.md"))).toBe(false);
	});

	test("a changed non-projects file hashes nothing", async () => {
		const root = freshDir("noprefix");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		seedWorktree(wt);
		sh("git checkout -q main", wt);
		writeFileSync(join(wt, "README.md"), "changed outside projects\n");
		sh("git add -A && git commit -qm outside", wt);
		sh("git checkout -q ott/card", wt);
		const alateDir = join(root, "alate");
		seedAlate(alateDir, root);
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, base: null, alateDir }),
		);
		expect(record.code).toBe(0);
		expect(record.files).toEqual([]);
	});

	test("an installed twin that drifts from the worktree records match false", async () => {
		const root = freshDir("drift");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const base = seedWorktree(wt);
		const alateDir = join(root, "alate");
		// The card's file is not manifest-covered: sync skips it and a stale twin
		// stays behind — exactly the drift the hashes exist to catch.
		seedAlate(alateDir, root, ["projects/ottr/AGENTS.md"]);
		mkdirSync(join(root, "ottr"), { recursive: true });
		writeFileSync(join(root, "ottr/AGENTS.md"), "stale install\n");
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, base, alateDir }),
		);
		expect(record.code).toBe(0);
		expect(record.output).toContain("sync: skipped projects/ottr/AGENTS.md");
		expect(record.files[0]?.match).toBe(false);
		expect(record.files[0]?.sourceSha256).toBe(
			createHash("sha256").update("card agents\n").digest("hex"),
		);
		expect(record.files[0]?.installedSha256).toBe(
			createHash("sha256").update("stale install\n").digest("hex"),
		);
		// Once the install covers the file again, the same gate records match.
		seedAlate(alateDir, root);
		const second = await runSyncGate(
			targetFor({ root, worktree: wt, base, alateDir }),
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
		seedAlate(alateDir, root);
		const record = await runSyncGate(
			targetFor({ root, worktree: wt, alateDir }),
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
		seedAlate(alateDir, root);
		// The gate env pins PATH, so a PATH without node must fail the spawn into
		// an error record instead of a fake pass.
		const saved = process.env.PATH;
		process.env.PATH = "/nonexistent-bin";
		try {
			const record = await runSyncGate(
				targetFor({ root, worktree: wt, alateDir }),
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
			targetFor({ root, worktree: wt, alateDir }),
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
			targetFor({ root, worktree: wt, alateDir }),
		);
		await until("start ");
		const second = runSyncGateQueued(
			targetFor({ root, worktree: wt, alateDir }),
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

	rootTest("a mode-700 alate-uid dir denies the agent-data uid", async () => {
		const root = freshDir("uid");
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
		// The agent-data uid cannot create the file: the gate gives a turn no
		// rights on another project's checkout.
		expect(await runChild(agentIds.uid, agentIds.gid)).not.toBe(0);
		expect(existsSync(join(alateDir, "x"))).toBe(false);
		// Positive control: the board's own uid (root here) writes the same dir.
		expect(await runChild()).toBe(0);
	});
});

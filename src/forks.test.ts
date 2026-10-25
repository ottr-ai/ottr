import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	branchHash,
	collectRange,
	createForkWatcher,
	ensureCache,
	FORK_GATES,
	type ForkProject,
	fetchFork,
	forkSummary,
	forkUrl,
	type GhFn,
	type GitFn,
	listBranchHeads,
	listForks,
	parseForkPage,
	rangeCommits,
} from "./forks.ts";
import { ProjectStore } from "./store.ts";
import { git, gitExe, spawnPiped } from "./worktree.ts";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ottr-forks-"));
});

function run(allArgs: string[], cwd: string, env?: Record<string, string>) {
	// Fixtures pass the repo dir as the last arg and as cwd; git only needs one.
	const args =
		allArgs[allArgs.length - 1] === cwd ? allArgs.slice(0, -1) : allArgs;
	// spawnPiped (not git()) so fixtures can pin GIT_COMMITTER_DATE for rewrites.
	const fullEnv: Record<string, string | undefined> = { ...process.env };
	if (env?.date) fullEnv.GIT_COMMITTER_DATE = env.date;
	return spawnPiped(
		[gitExe(), "-c", "user.email=t@t", "-c", "user.name=t", ...args],
		cwd,
		60_000,
		fullEnv,
	).then((r) => {
		if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.trim();
	});
}

function mkRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function initUpstream(name: string): Promise<string> {
	const dir = mkRepo(name);
	await run(["init", "-q", "-b", "main", dir], dir);
	await run(["commit", "--allow-empty", "-m", "base", dir], dir);
	return dir;
}

async function shaOf(dir: string, ref = "HEAD"): Promise<string> {
	return run(["rev-parse", ref], dir);
}

/** Real git with the GitHub fork URL remapped to a local fixture path. */
function localGit(forkPath: string): GitFn {
	return (args, cwd, timeoutMs) =>
		git(
			args.map((a) => (a === "https://github.com/o/r.git" ? forkPath : a)),
			cwd,
			timeoutMs,
		);
}

/** localGit plus file transport: the fixture fork is a local path, not github.com. */
function localFileGit(forkPath: string): GitFn {
	return async (args, cwd, timeoutMs) => {
		const at = args.indexOf("fetch");
		if (at >= 0)
			args = [
				...args.slice(0, at),
				"-c",
				"protocol.file.allow=always",
				...args.slice(at),
			];
		return localGit(forkPath)(args, cwd, timeoutMs);
	};
}

function forkPageEntry(id: number, size = 100) {
	return {
		id,
		owner: { login: "o" },
		name: "r",
		default_branch: "main",
		pushed_at: "2026-01-01T00:00:00Z",
		size,
	};
}

describe("parseForkPage", () => {
	test("keeps valid entries and drops invalid ones", () => {
		const forks = parseForkPage([
			forkPageEntry(1),
			{ id: 0, owner: { login: "o" }, name: "r" },
			{ id: 2, owner: { login: "o" }, name: ".hidden" },
			{ id: 3, owner: { login: "bad login" }, name: "r" },
			{ id: "x", owner: { login: "o" }, name: "r" },
			{ id: 4, owner: "o", name: "r" },
			{ id: 5, owner: { login: "o" }, name: "r", pushed_at: "not a date" },
			null,
			"nope",
		]);
		expect(forks.length).toBe(2);
		expect(forks[0]).toEqual({
			id: 1,
			owner: "o",
			name: "r",
			defaultBranch: "main",
			pushedAt: Date.parse("2026-01-01T00:00:00Z"),
			sizeKb: 100,
		});
		expect(forks[1]!.id).toBe(5);
		expect(forks[1]!.pushedAt).toBeNull();
		expect(forks[1]!.sizeKb).toBeNull();
	});
	test("non-array body yields empty", () => {
		expect(parseForkPage({ message: "no" })).toEqual([]);
	});
});

describe("forkUrl", () => {
	test("builds the URL from validated fields only", () => {
		expect(forkUrl(parseForkPage([forkPageEntry(9)])[0]!)).toBe(
			"https://github.com/o/r.git",
		);
	});
});

describe("branchHash", () => {
	test("is the first 16 hex of sha256", () => {
		expect(branchHash("main")).toMatch(/^[0-9a-f]{16}$/);
		expect(branchHash("main")).toBe(branchHash("main"));
		expect(branchHash("main")).not.toBe(branchHash("dev"));
	});
});

describe("forkSummary", () => {
	const DAY = 24 * 60 * 60 * 1000;
	const now = 1_800_000_000_000;
	const fork = (owner: string, name: string, pushedAt: number | null) => ({
		id: 1,
		owner,
		name,
		defaultBranch: null,
		pushedAt,
		sizeKb: null,
	});

	test("active counts only forks pushed within 90 days, with boundary values", () => {
		const inside = fork("a", "edge-in", now - 90 * DAY + 1);
		const outside = fork("b", "edge-out", now - 90 * DAY - 1);
		const exactly = fork("c", "edge-at", now - 90 * DAY);
		const s = forkSummary([inside, outside, exactly], now);
		// "within 90 days" includes the cutoff itself, excludes anything older.
		expect(s.active).toBe(2);
	});

	test("null pushedAt is never active and never in recent", () => {
		const s = forkSummary([fork("a", "ghost", null)], now);
		expect(s.forks).toBe(1);
		expect(s.active).toBe(0);
		expect(s.recent).toEqual([]);
	});

	test("recent is capped at five and sorted newest first", () => {
		const forks = [
			fork("o", "old", now - 50 * DAY),
			fork("o", "newest", now - DAY),
			fork("o", "no-date", null),
			fork("o", "second", now - 2 * DAY),
			fork("o", "fourth", now - 4 * DAY),
			fork("o", "fifth", now - 5 * DAY),
			fork("o", "third", now - 3 * DAY),
		];
		const s = forkSummary(forks, now);
		expect(s.recent.map((f) => f.name)).toEqual([
			"newest",
			"second",
			"third",
			"fourth",
			"fifth",
		]);
	});
});

describe("listForks", () => {
	test("paginates until a short page", async () => {
		const pages: number[] = [];
		const gh: GhFn = async (args) => {
			const url = args[1] ?? "";
			const page = Number(url.match(/&page=(\d+)$/)![1]);
			pages.push(page);
			const n = page === 1 ? 100 : 3;
			return {
				code: 0,
				stdout: JSON.stringify(
					Array.from({ length: n }, (_, i) => forkPageEntry(page * 1000 + i)),
				),
				stderr: "",
			};
		};
		const forks = await listForks("o/r", gh);
		expect(pages).toEqual([1, 2]);
		expect(forks.length).toBe(103);
	});

	test("surfaces auth failure as a thrown error, never an empty list", async () => {
		const gh: GhFn = async () => ({
			code: 1,
			stdout: "",
			stderr: "gh: HTTP 401: Bad credentials",
		});
		await expect(listForks("o/r", gh)).rejects.toThrow(/401/);
	});

	test("rejects a malformed repo id", async () => {
		await expect(
			listForks("not a repo", async () => ({
				code: 0,
				stdout: "[]",
				stderr: "",
			})),
		).rejects.toThrow(/invalid repo/);
	});
});

describe("listBranchHeads", () => {
	test("skips branch names git refuses via check-ref-format", async () => {
		const dir = await initUpstream("refheads");
		const g: GitFn = async (args, cwd, t) => {
			if (args[0] === "ls-remote")
				return {
					code: 0,
					stdout: `${"a".repeat(40)}\trefs/heads/valid\n${"b".repeat(
						40,
					)}\trefs/heads/--upload-pack=x\nnot-a-sha\tgarbage\n`,
					stderr: "",
				};
			return git(args, cwd, t);
		};
		const { heads, skipped } = await listBranchHeads(
			"https://github.com/o/r.git",
			dir,
			g,
		);
		expect(skipped).toBe(1);
		expect([...heads.keys()]).toEqual(["valid"]);
	});
});

/** An empty commit amends to itself; fixtures touch a file so rewrites change the sha. */
function touch(path: string, n: number) {
	Bun.write(path, `data ${n}\n`);
}

describe("rangeCommits", () => {
	test("a pure rewrite of an analyzed commit yields 0 shas", async () => {
		const up = await initUpstream("rc-rewrite");
		const fork = mkRepo("rc-rewrite-fork");
		await run(["clone", "-q", up, fork], root);
		touch(join(fork, "f.txt"), 1);
		await run(["add", "f.txt", fork], fork);
		await run(["commit", "-q", "-m", "feature", fork], fork);
		const analyzed = await shaOf(fork);
		// Rewrite: new sha (new message), same patch — cherry-pick equivalence must drop it.
		await run(["commit", "-q", "--amend", "-m", "feature v2", fork], fork);
		const newHead = await shaOf(fork);
		const upstreamHead = await shaOf(up);
		const r = await rangeCommits(fork, analyzed, newHead, upstreamHead, git);
		expect(r.shas).toEqual([]);
	});

	test("rewrite plus one new feature yields exactly the new sha", async () => {
		const up = await initUpstream("rc-mixed");
		const fork = mkRepo("rc-mixed-fork");
		await run(["clone", "-q", up, fork], root);
		touch(join(fork, "f.txt"), 1);
		await run(["add", "f.txt", fork], fork);
		await run(["commit", "-q", "-m", "v1", fork], fork);
		const analyzed = await shaOf(fork);
		await run(["commit", "-q", "--amend", "-m", "v1 rewritten", fork], fork);
		touch(join(fork, "g.txt"), 1);
		await run(["add", "g.txt", fork], fork);
		await run(["commit", "-q", "-m", "new feature", fork], fork);
		const newHead = await shaOf(fork);
		const r = await rangeCommits(fork, analyzed, newHead, await shaOf(up), git);
		expect(r.shas.length).toBe(1);
		expect(r.merges).toEqual([]);
	});

	test("merge-only new work yields merges 1, shas 0", async () => {
		const up = await initUpstream("rc-merge");
		const fork = mkRepo("rc-merge-fork");
		await run(["clone", "-q", up, fork], root);
		const analyzed = await shaOf(fork);
		// Upstream gains two commits; the fork merges them. The merge is the only work
		// the analysis base lacks: the cherry-pick intersection against upstream is empty.
		touch(join(up, "u.txt"), 1);
		await run(["add", "u.txt", up], up);
		await run(["commit", "-q", "-m", "upstream change 1", up], up);
		touch(join(up, "u.txt"), 2);
		await run(["add", "u.txt", up], up);
		await run(["commit", "-q", "-m", "upstream change 2", up], up);
		await run(["fetch", "-q", "origin"], fork);
		const before = await shaOf(fork);
		await run(["merge", "-q", "--no-ff", "origin/main", fork], fork);
		const newHead = await shaOf(fork);
		expect(newHead).not.toBe(before);
		const r = await rangeCommits(fork, analyzed, newHead, await shaOf(up), git);
		expect(r.shas).toEqual([]);
		expect(r.merges.length).toBe(1);
	});
});

describe("collectRange", () => {
	test("fetches upstream, dedups commits, lists upstream context", async () => {
		const main = await initUpstream("cr-main");
		const fork = mkRepo("cr-fork");
		await run(["clone", "-q", main, fork], root);
		await run(["checkout", "-q", "-b", "feat", fork], fork);
		touch(join(fork, "a.txt"), 1);
		await run(["add", "a.txt", fork], fork);
		await run(["commit", "-q", "-m", "fork feature", fork], fork);
		touch(join(fork, "b.txt"), 1);
		await run(["add", "b.txt", fork], fork);
		await run(["commit", "-q", "-m", "fork feature 2", fork], fork);
		await run(["commit", "--allow-empty", "-m", "shared change", main], main);
		touch(join(main, "README.md"), 1);
		await run(["add", "README.md", main], main);
		await run(["commit", "-q", "-m", "docs: readme", main], main);
		const head = await shaOf(fork);
		const cachePath = join(root, "cr-cache.git");
		await run(["init", "-q", "--bare", cachePath], root);
		// The watcher fetches the fork before collectRange; mirror that here.
		await fetchFork(
			cachePath,
			"https://github.com/o/r.git",
			[`+refs/heads/feat:refs/heads/${branchHash("feat")}`],
			localFileGit(fork),
		);
		const range = await collectRange({
			cachePath,
			mainPath: main,
			fork: forkPageEntry(1) as never,
			branches: [
				{
					branchHash: branchHash("feat"),
					branch: "feat",
					head,
					analyzedHead: null,
				},
			],
			git,
		});
		expect(range.commits.length).toBe(2);
		// rev-list order: newest first.
		expect(range.commits[0]!.subject).toBe("fork feature 2");
		expect(range.commits[1]!.subject).toBe("fork feature");
		expect(range.heads[0]!.head).toBe(head);
		// Upstream side: what upstream has that the fork branch lacks.
		expect(range.upstreamCommits.some((l) => l.includes("docs: readme"))).toBe(
			true,
		);
		expect(range.upstreamCommits.some((l) => l.includes("fork feature"))).toBe(
			false,
		);
		expect(range.upstreamFiles).toContain("README.md");
	});
});

describe("watcher", () => {
	async function setup(
		name: string,
		analyzeImpl: (r: unknown) => Promise<unknown>,
	) {
		const main = await initUpstream(name);
		const store = ProjectStore.init(main);
		store.setSettings({ forkResearch: true });
		const gh: GhFn = async () => ({
			code: 0,
			stdout: JSON.stringify([forkPageEntry(1)]),
			stderr: "",
		});
		let analyzeCalls = 0;
		const logs: string[] = [];
		const watcher = createForkWatcher({
			projects: () => [
				{ name, path: main, store, github: "o/main" } satisfies ForkProject,
			],
			log: (m) => logs.push(m),
			gh,
			git: localFileGit(join(root, `${name}-fork`)),
			analyze: (range, prior) => {
				analyzeCalls++;
				return analyzeImpl({ range, prior }) as Promise<never>;
			},
			now: () => Date.now(),
		});
		return { main, store, watcher, calls: () => analyzeCalls, logs };
	}

	async function makeFork(name: string, main: string) {
		const fork = mkRepo(name);
		await run(["clone", "-q", main, fork], root);
		await run(["checkout", "-q", "-b", "feat", fork], fork);
		await run(["commit", "--allow-empty", "-m", "fork feature", fork], fork);
		return fork;
	}

	test("eligible range creates card, held proposal, advances cursor; no duplicates on second tick", async () => {
		const { main, store, watcher, calls } = await setup(
			"watch-ok",
			async () =>
				({
					features: [],
					proposals: [
						{
							title: "t",
							goal: "g",
							comparison: "c",
							change: "ch",
							checks: "ck",
							risk: "r",
							effort: "S",
							commits: [],
						},
					],
					coverage: "",
					commits: [],
					deferred: [],
				}) as never,
		);
		await makeFork("watch-ok-fork", main);
		await watcher.tick();
		expect(calls()).toBe(1);
		const card = store
			.listTasks()
			.find((t) => t.topic === "fork research" && t.followUpOf === null);
		expect(card).toBeDefined();
		expect(card!.research).toBe(true);
		expect(card!.stage).toBe("done");
		expect(card!.title).toContain("Fork research: o/r");
		const proposal = store.listTasks().find((t) => t.followUpOf === card!.id);
		expect(proposal).toBeDefined();
		expect(proposal!.state).toBe("needs_you");
		expect(
			(proposal!.needsReason ?? "").startsWith(
				"Proposed by the fork research ",
			),
		).toBe(true);
		const row = store.listAllForkBranches()[0]!;
		expect(row.analyzedHead).toBe(row.head);
		expect(row.firstPendingAt).toBeNull();
		// Second tick: cursor advanced, nothing pending, no duplicate card.
		await watcher.tick();
		expect(calls()).toBe(1);
		expect(
			store.listTasks().filter((t) => t.topic === "fork research").length,
		).toBe(1);
	});

	test("fork cache and ls-remote cwd live in the server-only dir, not OTTR_DATA_DIR", async () => {
		const saved = {
			OTTR_DATA_DIR: process.env.OTTR_DATA_DIR,
			OTTR_SERVER_DATA_DIR: process.env.OTTR_SERVER_DATA_DIR,
		};
		const shared = mkdtempSync(join(tmpdir(), "ottr-forks-shared-"));
		const server = mkdtempSync(join(tmpdir(), "ottr-forks-server-"));
		process.env.OTTR_DATA_DIR = shared;
		process.env.OTTR_SERVER_DATA_DIR = server;
		try {
			const name = "watch-serverdir";
			const main = await initUpstream(name);
			const store = ProjectStore.init(main);
			store.setSettings({ forkResearch: true });
			await makeFork(`${name}-fork`, main);
			const calls: { args: string[]; cwd: string }[] = [];
			const inner = localFileGit(join(root, `${name}-fork`));
			const watcher = createForkWatcher({
				projects: () => [
					{ name, path: main, store, github: "o/main" } satisfies ForkProject,
				],
				log: () => {},
				gh: async () => ({
					code: 0,
					stdout: JSON.stringify([forkPageEntry(1)]),
					stderr: "",
				}),
				git: (args, cwd, timeoutMs) => {
					calls.push({ args: [...args], cwd });
					return inner(args, cwd, timeoutMs);
				},
				analyze: async () =>
					({
						features: [],
						proposals: [],
						coverage: "",
						commits: [],
						deferred: [],
					}) as never,
				now: () => Date.now(),
			});
			await watcher.tick();
			const below = (p: string, dir: string) => p.startsWith(`${dir}/`);
			expect(below(store.serverDir, server)).toBe(true);
			const lsRemote = calls.find((c) => c.args.includes("ls-remote"));
			expect(lsRemote).toBeDefined();
			expect(lsRemote!.cwd).toBe(store.serverDir);
			expect(below(lsRemote!.cwd, shared)).toBe(false);
			const init = calls.find(
				(c) => c.args.includes("init") && c.args.includes("--bare"),
			);
			expect(init).toBeDefined();
			const cachePath = init!.args[init!.args.length - 1]!;
			expect(below(cachePath, store.serverDir)).toBe(true);
			expect(below(cachePath, shared)).toBe(false);
			expect(existsSync(cachePath)).toBe(true);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	test("analyze failure bumps retries and files no card", async () => {
		const { main, store, watcher, calls } = await setup(
			"watch-fail",
			async () => {
				throw new Error("model offline");
			},
		);
		await makeFork("watch-fail-fork", main);
		await watcher.tick();
		expect(calls()).toBe(1);
		const row = store.listAllForkBranches()[0]!;
		expect(row.retries).toBe(1);
		expect(row.lastError).toContain("model offline");
		expect(row.analyzedHead).toBeNull();
		expect(store.listTasks().length).toBe(0);
	});

	test("daily cap blocks the fourth run in 24h", async () => {
		const { main, store, watcher, calls } = await setup(
			"watch-cap",
			async () => {
				throw new Error("never reached");
			},
		);
		await makeFork("watch-cap-fork", main);
		const now = Date.now();
		for (let i = 0; i < FORK_GATES.PROJECT_DAILY_RUNS; i++)
			store.recordForkRun(1, now - i * 1000);
		await watcher.tick();
		expect(calls()).toBe(0);
	});

	test("empty fork list never calls analyze", async () => {
		const main = mkRepo("watch-empty");
		const store = ProjectStore.init(main);
		store.setSettings({ forkResearch: true });
		let analyzeCalls = 0;
		const watcher = createForkWatcher({
			projects: () => [{ name: "p", path: main, store, github: "o/main" }],
			log: () => {},
			gh: async () => ({ code: 0, stdout: "[]", stderr: "" }),
			git: localGit(main),
			analyze: (async () => {
				analyzeCalls++;
				throw new Error("must not run");
			}) as never,
			now: () => Date.now(),
		});
		await watcher.tick();
		expect(analyzeCalls).toBe(0);
	});

	test("a one-shot projects iterator is re-iterable across ticks", async () => {
		const main = mkRepo("watch-oneshot");
		const store = ProjectStore.init(main);
		store.setSettings({ forkResearch: true });
		let ghCalls = 0;
		// The exact shape app.ts passes: a live Map's values() is a one-shot iterator.
		const projects = new Map([
			[
				"p",
				{
					name: "p",
					path: main,
					store,
					github: "o/main",
				} satisfies ForkProject,
			],
		]);
		const watcher = createForkWatcher({
			projects: () => projects.values(),
			log: () => {},
			gh: (async () => {
				ghCalls++;
				return { code: 0, stdout: "[]", stderr: "" };
			}) as never,
			git: localGit(main),
			now: () => Date.now(),
		});
		await watcher.tick();
		await watcher.tick();
		expect(ghCalls).toBe(2);
	});
});

describe("ensureCache", () => {
	test("creates a bare repo once and reuses it", async () => {
		const dir = await initUpstream("cache");
		const fork = forkPageEntry(77) as never;
		const p1 = await ensureCache(dir, fork, git);
		expect(existsSync(join(p1, "HEAD"))).toBe(true);
		const p2 = await ensureCache(dir, fork, git);
		expect(p2).toBe(p1);
	});
});

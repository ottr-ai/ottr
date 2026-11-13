import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GuestOptions, serveGuest } from "./vmGuest.ts";
import { type VmOutcome, WORKER_DONE } from "./workers.ts";

const dir = mkdtempSync(join(tmpdir(), "ottr-vmguest-"));
const TOKEN = "guest-sekrit";
const AUTH = { "x-ottr-guest-token": TOKEN };

// The suite's own git must act on its temp repos even when a git hook runs the tests.
const cleanEnv = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
);
const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, env: cleanEnv, encoding: "utf8" }).trim();

// Fake omp: commits work.txt and prints the sha. With [bare, branch] arguments it then waits
// until that sha is on the bare repo's branch and prints {"type":"seen"}: only the periodic
// push can land it there before omp exits.
const commitPath = join(dir, "commit-omp.js");
writeFileSync(
	commitPath,
	`const { spawnSync } = require("node:child_process");
const git = (...a) => {
	const r = spawnSync("git", a, { encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
};
require("node:fs").writeFileSync("work.txt", "done\\n");
git("add", "work.txt");
git("commit", "-q", "-m", "work");
const sha = git("rev-parse", "HEAD");
process.stdout.write(JSON.stringify({ type: "committed", sha }) + "\\n");
const [bare, branch] = process.argv.slice(2);
if (bare) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		const r = spawnSync("git", ["--git-dir", bare, "rev-parse", "refs/heads/" + branch], { encoding: "utf8" });
		if (r.stdout.trim() === sha) {
			process.stdout.write('{"type":"seen"}\\n');
			break;
		}
		Bun.sleepSync(50);
	}
}`,
);

// Fake omp: leaves an untracked file and commits nothing.
const untrackedPath = join(dir, "untracked-omp.js");
writeFileSync(
	untrackedPath,
	`require("node:fs").writeFileSync("notes.txt", "scratch\\n");
process.stdout.write('{"type":"wrote"}\\n');`,
);

// Fake omp: leaves a research report, a screenshot, and an unrelated untracked file.
const boardFilesPath = join(dir, "board-files-omp.js");
writeFileSync(
	boardFilesPath,
	`const fs = require("node:fs");
fs.writeFileSync("research-report.md", "# Findings\\n");
fs.mkdirSync("shots");
fs.writeFileSync("shots/a.png", Buffer.from([137, 80, 78, 71]));
fs.writeFileSync("notes.txt", "scratch\\n");`,
);

// Fake omp: prints its whole env as one JSON line.
const envPath = join(dir, "env-omp.js");
writeFileSync(
	envPath,
	`process.stdout.write(JSON.stringify(process.env) + "\\n");`,
);

// Fake omp: one event, then alive until killed.
const sleepPath = join(dir, "sleep-omp.js");
writeFileSync(
	sleepPath,
	`process.stdout.write('{"type":"tick"}\\n');
setTimeout(() => process.exit(0), 60000);`,
);

// Every /run below clones with real git and boots a real bun child; child boot is unbounded
// under concurrent machine load, so those tests carry a 30 s budget.

const servers: Bun.Server<never>[] = [];
afterAll(() => {
	for (const s of servers) s.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

function start(opts: Partial<GuestOptions> = {}): string {
	const server = serveGuest({
		port: 0,
		token: TOKEN,
		ompPath: process.execPath,
		...opts,
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

let n = 0;
const fresh = (name: string): string => join(dir, `${name}-${n++}`);

/** A bare repo with `main` and `branch` at one seed commit: the board's git endpoint stand-in. */
function makeRemote(branch: string): string {
	const root = fresh("remote");
	const bare = join(root, "origin.git");
	const seed = join(root, "seed");
	mkdirSync(seed, { recursive: true });
	git(root, "init", "-q", "--bare", "-b", "main", bare);
	git(seed, "init", "-q", "-b", "main");
	writeFileSync(join(seed, "README.md"), "seed\n");
	git(seed, "add", "README.md");
	git(
		seed,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-q",
		"-m",
		"seed",
	);
	git(seed, "push", "-q", bare, "main", `main:refs/heads/${branch}`);
	return bare;
}

interface Done {
	exitCode: number | null;
	stderrTail: string;
	vm: VmOutcome;
}

interface RunOpts {
	gitUrl: string;
	branch: string;
	argv: string[];
	env?: Record<string, string>;
	providers?: string[];
	hindsight?: boolean;
	boardUrl?: string;
}

function runBody(o: RunOpts): string {
	return JSON.stringify({
		argv: o.argv,
		// The clone target's parents do not exist yet, like /workspace in a fresh VM.
		cwd: join(fresh("ws"), "proj", ".worktrees", "T-1"),
		env: o.env ?? {},
		stdin: "",
		vm: {
			gitUrl: o.gitUrl,
			branch: o.branch,
			base: "main",
			token: "vm-turn-token",
			boardUrl: o.boardUrl ?? "http://ottr:8080",
			providers: o.providers ?? [],
			hindsight: o.hindsight ?? false,
		},
	});
}

async function runTurn(
	url: string,
	o: RunOpts,
): Promise<{ lines: string[]; done: Done; cwd: string }> {
	const body = runBody(o);
	const res = await fetch(`${url}/run`, {
		method: "POST",
		headers: { ...AUTH, "content-type": "application/json" },
		body,
	});
	expect(res.status).toBe(200);
	const lines = (await res.text()).split("\n").filter((l) => l !== "");
	const last = JSON.parse(lines.at(-1) ?? "{}") as Record<string, Done>;
	expect(last[WORKER_DONE]).toBeDefined();
	return {
		lines: lines.slice(0, -1),
		done: last[WORKER_DONE] as Done,
		cwd: (JSON.parse(body) as { cwd: string }).cwd,
	};
}

describe("guest auth", () => {
	test("every route but /healthz answers 401 without the guest token", async () => {
		const url = start();
		expect(await (await fetch(`${url}/healthz`)).text()).toBe("ok");
		const calls: [string, string][] = [
			["POST", "/run"],
			["POST", "/bake"],
			["POST", "/kill"],
			["POST", "/shutdown"],
			["PUT", "/files"],
			["GET", "/files?path=/tmp&since=0"],
		];
		for (const [method, path] of calls) {
			for (const headers of [
				{} as Record<string, string>,
				{ "x-ottr-guest-token": "wrong" },
			]) {
				const res = await fetch(`${url}${path}`, {
					method,
					headers,
					body: method === "GET" ? undefined : "{}",
				});
				expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 401`);
			}
		}
	});
});

describe("POST /run", () => {
	test("a commit reaches the board branch by the periodic push; head is that sha", async () => {
		const branch = "ott/t-1";
		const bare = makeRemote(branch);
		const url = start({ pushIntervalMs: 100 });
		const { lines, done, cwd } = await runTurn(url, {
			gitUrl: bare,
			branch,
			argv: [commitPath, bare, branch],
		});
		const committed = JSON.parse(lines[0] ?? "{}") as { sha?: string };
		expect(committed.sha).toMatch(/^[0-9a-f]{40}$/);
		// omp saw its own commit on the board before it exited: the interval push ran.
		expect(lines).toContain('{"type":"seen"}');
		expect(done.exitCode).toBe(0);
		expect(done.vm).toEqual({
			head: committed.sha ?? "",
			pushError: null,
			dirty: [],
		});
		expect(
			git(dir, "--git-dir", bare, "rev-parse", `refs/heads/${branch}`),
		).toBe(committed.sha ?? "");
		// main stays where it was: the push targets the task branch only.
		expect(
			git(dir, "--git-dir", bare, "rev-parse", "refs/heads/main"),
		).not.toBe(committed.sha ?? "");
		// Later pushes and fetches authenticate: the header lives in the clone, scoped to the URL.
		expect(git(cwd, "config", "--get", `http.${bare}.extraHeader`)).toBe(
			"Authorization: Bearer vm-turn-token",
		);
	}, 30_000);

	test("the exit push lands a commit the interval never saw; untouched HEAD never pushes", async () => {
		const branch = "ott/t-2";
		const bare = makeRemote(branch);
		const url = start(); // 60 s interval: only the exit push can run
		const { lines, done } = await runTurn(url, {
			gitUrl: bare,
			branch,
			argv: [commitPath],
		});
		const sha = (JSON.parse(lines[0] ?? "{}") as { sha?: string }).sha;
		expect(done.vm.head).toBe(sha ?? "");
		expect(
			git(dir, "--git-dir", bare, "rev-parse", `refs/heads/${branch}`),
		).toBe(sha ?? "");

		const seed = git(dir, "--git-dir", bare, "rev-parse", "refs/heads/main");
		const other = "ott/t-3";
		git(dir, "--git-dir", bare, "branch", other, seed);
		const idle = await runTurn(url, {
			gitUrl: bare,
			branch: other,
			argv: [untrackedPath],
		});
		// Nothing committed: nothing was pushed, so head reports "never pushed".
		expect(idle.done.vm.head).toBeNull();
		expect(idle.done.vm.pushError).toBeNull();
	}, 30_000);

	test("an untracked file the turn left lands in dirty", async () => {
		const branch = "ott/t-4";
		const bare = makeRemote(branch);
		const agentDir = fresh("agent");
		const url = start();
		const { lines, done } = await runTurn(url, {
			gitUrl: bare,
			branch,
			argv: [untrackedPath],
			// No providers: models.yml is not written even with an agent dir set.
			env: { PI_CODING_AGENT_DIR: agentDir },
		});
		expect(lines).toEqual(['{"type":"wrote"}']);
		expect(done.exitCode).toBe(0);
		expect(done.vm.dirty).toEqual(["?? notes.txt"]);
		expect(existsSync(join(agentDir, "models.yml"))).toBe(false);
	}, 30_000);

	test("research-report.md and shots/ ride vm.files; other untracked files do not", async () => {
		const branch = "ott/t-files";
		const bare = makeRemote(branch);
		const url = start();
		const { done } = await runTurn(url, {
			gitUrl: bare,
			branch,
			argv: [boardFilesPath],
		});
		expect(done.exitCode).toBe(0);
		expect(done.vm.files).toEqual([
			{
				path: "research-report.md",
				b64: Buffer.from("# Findings\n").toString("base64"),
			},
			{
				path: "shots/a.png",
				b64: Buffer.from([137, 80, 78, 71]).toString("base64"),
			},
		]);
	}, 30_000);

	test("a missing branch ends with exit 1, the git error, and no omp", async () => {
		const bare = makeRemote("ott/t-5");
		const url = start();
		const { lines, done } = await runTurn(url, {
			gitUrl: bare,
			branch: "ott/nope",
			argv: [untrackedPath],
		});
		expect(lines).toEqual([]);
		expect(done.exitCode).toBe(1);
		expect(done.vm.head).toBeNull();
		expect(done.vm.dirty).toBeNull();
		expect(done.vm.pushError).toContain("ott/nope");
		expect(done.stderrTail).toContain("ott/nope");
	}, 30_000);

	test("a refused push is reported as pushError with head still null", async () => {
		const branch = "ott/t-6";
		const bare = makeRemote(branch);
		const hook = join(bare, "hooks", "pre-receive");
		writeFileSync(hook, "#!/bin/sh\necho 'board says no' >&2\nexit 1\n");
		chmodSync(hook, 0o755);
		const url = start();
		const { done } = await runTurn(url, {
			gitUrl: bare,
			branch,
			argv: [commitPath],
		});
		expect(done.exitCode).toBe(0);
		expect(done.vm.head).toBeNull();
		expect(done.vm.pushError).toContain("board says no");
		expect(done.vm.dirty).toEqual([]);
	}, 30_000);

	test("models.yml keeps unrelated keys and routes the turn's providers through /llm", async () => {
		const branch = "ott/t-7";
		const bare = makeRemote(branch);
		const agentDir = fresh("agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.yml"),
			`theme: dark
providers:
  other:
    baseUrl: https://example.invalid/v1
    apiKey: OTHER_KEY
  anthropic:
    models:
      - id: claude-x
`,
		);
		const url = start();
		process.env.OTTR_VMGUEST_TEST_SECRET = "leak";
		let lines: string[];
		try {
			({ lines } = await runTurn(url, {
				gitUrl: bare,
				branch,
				argv: [envPath],
				env: { PI_CODING_AGENT_DIR: agentDir, FOO: "bar" },
				providers: ["anthropic", "openai"],
				hindsight: true,
				boardUrl: "http://ottr:8080/",
			}));
		} finally {
			delete process.env.OTTR_VMGUEST_TEST_SECRET;
		}
		const route = {
			baseUrl: "http://ottr:8080/llm",
			apiKey: "OTTR_VM_TOKEN",
			transport: "pi-native",
		};
		expect(
			Bun.YAML.parse(readFileSync(join(agentDir, "models.yml"), "utf8")),
		).toEqual({
			theme: "dark",
			providers: {
				other: { baseUrl: "https://example.invalid/v1", apiKey: "OTHER_KEY" },
				anthropic: { models: [{ id: "claude-x" }], ...route },
				openai: route,
			},
		});
		const env = JSON.parse(lines[0] ?? "{}") as Record<string, string>;
		expect(env.OTTR_VM_TOKEN).toBe("vm-turn-token");
		expect(env.HINDSIGHT_API_URL).toBe("http://ottr:8080/hindsight");
		expect(env.HINDSIGHT_API_TOKEN).toBe("vm-turn-token");
		expect(env.FOO).toBe("bar");
		// The turn keeps the guest's home, nothing else of its env.
		expect(env.HOME).toBe(process.env.HOME ?? "");
		// The guest's own env never reaches the turn.
		expect(env.OTTR_VMGUEST_TEST_SECRET).toBeUndefined();
	}, 30_000);

	test("POST /kill ends the turn; a second /run is refused while it runs", async () => {
		const branch = "ott/t-8";
		const bare = makeRemote(branch);
		const url = start();
		const res = await fetch(`${url}/run`, {
			method: "POST",
			headers: { ...AUTH, "content-type": "application/json" },
			body: runBody({ gitUrl: bare, branch, argv: [sleepPath] }),
		});
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let text = "";
		while (!text.includes("\n")) {
			const { value, done } = await reader.read();
			if (done) break;
			text += dec.decode(value);
		}
		expect(text).toBe('{"type":"tick"}\n');

		const busy = await fetch(`${url}/run`, {
			method: "POST",
			headers: { ...AUTH, "content-type": "application/json" },
			body: runBody({ gitUrl: bare, branch, argv: [sleepPath] }),
		});
		expect(busy.status).toBe(409);

		const t0 = Date.now();
		const kill = await fetch(`${url}/kill`, { method: "POST", headers: AUTH });
		expect(await kill.json()).toEqual({ killed: true });
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			text += dec.decode(value);
		}
		expect(Date.now() - t0).toBeLessThan(20_000);
		const last = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<
			string,
			Done
		>;
		expect(last[WORKER_DONE]?.exitCode).toBeNull();
		expect(last[WORKER_DONE]?.vm.dirty).toEqual([]);
		// The run is over: nothing left to kill.
		const again = await fetch(`${url}/kill`, { method: "POST", headers: AUTH });
		expect(await again.json()).toEqual({ killed: false });
	}, 30_000);
});

describe("/files", () => {
	const listTar = (bytes: ArrayBuffer): string[] => {
		const file = join(fresh("tar"), "out.tar");
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, Buffer.from(bytes));
		return execFileSync("tar", ["-tf", file], { encoding: "utf8" })
			.split("\n")
			.filter((l) => l !== "")
			.sort();
	};

	test("GET returns only regular files newer than since, named relative to /", async () => {
		const root = fresh("out");
		mkdirSync(join(root, "sub"), { recursive: true });
		writeFileSync(join(root, "old.txt"), "old");
		const past = new Date(Date.now() - 3_600_000);
		utimesSync(join(root, "old.txt"), past, past);
		writeFileSync(join(root, "sub", "new.txt"), "new");
		const url = start();
		const get = async (path: string, since: number): Promise<string[]> => {
			const res = await fetch(
				`${url}/files?path=${encodeURIComponent(path)}&since=${since}`,
				{ headers: AUTH },
			);
			expect(res.status).toBe(200);
			return listTar(await res.arrayBuffer());
		};
		const rel = root.slice(1);
		expect(await get(root, Date.now() - 60_000)).toEqual([
			`${rel}/sub/new.txt`,
		]);
		expect(await get(root, 0)).toEqual([
			`${rel}/old.txt`,
			`${rel}/sub/new.txt`,
		]);
		// Nothing changed since: a valid empty tar, never an error.
		expect(await get(root, Date.now() + 60_000)).toEqual([]);
		expect(await get(join(root, "missing"), 0)).toEqual([]);
		const relative = await fetch(`${url}/files?path=tmp&since=0`, {
			headers: AUTH,
		});
		expect(relative.status).toBe(400);
	});

	test("PUT extracts at / and refuses a tar with a .. or absolute member", async () => {
		const src = fresh("src");
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, "a.txt"), "alpha");
		const dest = fresh("dest");
		const destRel = dest.slice(1);
		const url = start();
		const put = async (args: string[]): Promise<Response> => {
			const file = join(fresh("in"), "in.tar");
			mkdirSync(join(file, ".."), { recursive: true });
			execFileSync("tar", ["-cf", file, "-C", src, ...args, "a.txt"], {
				stdio: "ignore",
			});
			return fetch(`${url}/files`, {
				method: "PUT",
				headers: AUTH,
				body: readFileSync(file),
			});
		};

		const ok = await put(["--transform", `s,^,${destRel}/,`]);
		expect(ok.status).toBe(200);
		expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("alpha");

		// -P keeps the member names exactly as transformed; GNU tar would strip them otherwise.
		const dotdot = await put(["-P", "--transform", `s,^,${destRel}/x/../y/,`]);
		expect(dotdot.status).toBe(400);
		expect(await dotdot.text()).toContain("..");
		expect(existsSync(join(dest, "y"))).toBe(false);
		expect(existsSync(join(dest, "x"))).toBe(false);

		const absolute = await put(["-P", "--transform", `s,^,/${destRel}/z/,`]);
		expect(absolute.status).toBe(400);
		expect(existsSync(join(dest, "z"))).toBe(false);
	});
});

describe("POST /bake", () => {
	test("streams each install's lines, then a clean sentinel; home is /root", async () => {
		const calls: string[] = [];
		const url = start({
			ensure: {
				packages: async (p, home) => {
					calls.push(`apt ${p} ${home}`);
					return ["apt: installed libnss3"];
				},
				tools: async (p, home) => {
					calls.push(`tools ${p} ${home}`);
					return ["tools: installed ruff"];
				},
				python: async (p, home) => {
					calls.push(`pip ${p} ${home}`);
					return [];
				},
			},
		});
		const res = await fetch(`${url}/bake`, {
			method: "POST",
			headers: AUTH,
			body: JSON.stringify({ project: "proj" }),
		});
		expect(res.status).toBe(200);
		expect((await res.text()).split("\n").filter((l) => l !== "")).toEqual([
			"apt: installed libnss3",
			"tools: installed ruff",
			JSON.stringify({ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } }),
		]);
		expect(calls).toEqual([
			"apt proj /root",
			"tools proj /root",
			"pip proj /root",
		]);
	});

	test("a failing install ends with exit 1 and its error; later installs never run", async () => {
		let pipRan = false;
		const url = start({
			ensure: {
				packages: async () => [],
				tools: async () => {
					throw new Error("tools: pip install failed (exit 1): nope");
				},
				python: async () => {
					pipRan = true;
					return [];
				},
			},
		});
		const res = await fetch(`${url}/bake`, {
			method: "POST",
			headers: AUTH,
			body: JSON.stringify({ project: "proj" }),
		});
		const lines = (await res.text()).split("\n").filter((l) => l !== "");
		expect(lines).toEqual([
			JSON.stringify({
				[WORKER_DONE]: {
					exitCode: 1,
					stderrTail: "tools: pip install failed (exit 1): nope\n",
				},
			}),
		]);
		expect(pipRan).toBe(false);
		const bad = await fetch(`${url}/bake`, {
			method: "POST",
			headers: AUTH,
			body: JSON.stringify({ project: "../etc" }),
		});
		expect(bad.status).toBe(400);
	});
});

describe("POST /shutdown", () => {
	test("the token ends the agent so PID 1 unmounts; the exit seam fires once", async () => {
		let exits = 0;
		const { promise: exited, resolve: exitFired } =
			Promise.withResolvers<void>();
		const url = start({
			exit: () => {
				exits++;
				exitFired();
			},
		});
		const res = await fetch(`${url}/shutdown`, {
			method: "POST",
			headers: AUTH,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ shuttingDown: true });
		// The agent defers the exit so the response flushes first: await the seam.
		await exited;
		// Only this test drives requests, so one POST can fire the seam once.
		expect(exits).toBe(1);
	});
});

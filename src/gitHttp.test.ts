import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
	handleGit,
	parseReceiveCommands,
	pushRefusal,
	syncWorktreeTo,
} from "./gitHttp.ts";
import { VmTokens } from "./vmTokens.ts";
import { gitExe } from "./worktree.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs)
		rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
function dir(): string {
	const d = mkdtempSync(join(tmpdir(), "ottr-githttp-"));
	dirs.push(d);
	return d;
}

/**
 * Fixture git, async: the endpoint under test runs in this process, so a sync spawn would block
 * the server it talks to. Throwaway identity, no prompts, no global config.
 */
async function run(
	cwd: string,
	...args: string[]
): Promise<{ code: number; out: string; err: string }> {
	const p = Bun.spawn(
		[
			gitExe(),
			"-c",
			"user.name=ott",
			"-c",
			"user.email=ott@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"protocol.version=2",
			...args,
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH ?? "",
				GIT_CONFIG_GLOBAL: "/dev/null",
				HOME: tmpdir(),
				GIT_TERMINAL_PROMPT: "0",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	return { code: await p.exited, out: out.trim(), err };
}
async function must(cwd: string, ...args: string[]): Promise<string> {
	const r = await run(cwd, ...args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
	return r.out;
}

const BRANCH = "ott/alp-1-x";
const tokens = new VmTokens({ file: null });
const logs: string[] = [];
let server: Server<undefined>;
let main = "";
let worktree = "";
let token = "";
let base = "";

beforeAll(async () => {
	const root = dir();
	main = join(root, "alpha");
	await must(root, "init", "-q", "-b", "main", main);
	writeFileSync(join(main, "a.txt"), "one\n");
	await must(main, "add", ".");
	await must(main, "commit", "-q", "-m", "init");
	base = await must(main, "rev-parse", "HEAD");
	await must(main, "branch", "secret");
	worktree = join(main, ".worktrees", "ALP-1");
	await must(main, "worktree", "add", "-q", "-b", BRANCH, worktree);
	token = tokens.issue({
		project: "alpha",
		taskId: "ALP-1",
		branch: BRANCH,
		repoPath: main,
		worktree,
	});
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => handleGit(req, { tokens, log: (l) => logs.push(l) }),
	});
}, 60_000);
afterAll(() => server?.stop(true));

const url = () => `http://127.0.0.1:${server.port}/git/alpha.git`;
const auth = (t: string) => [
	"-c",
	`http.extraHeader=Authorization: Bearer ${t}`,
];

/** A clone of the card branch over the endpoint, with one new commit on top. */
async function cloneWithCommit(file: string, text: string): Promise<string> {
	const clone = join(dir(), "vm");
	await must(dir(), ...auth(token), "clone", "-q", "-b", BRANCH, url(), clone);
	writeFileSync(join(clone, file), text);
	await must(clone, "add", ".");
	await must(clone, "commit", "-q", "-m", `add ${file}`);
	return clone;
}

describe("handleGit over real git", () => {
	test("a push to the card branch moves the ref and resets the server worktree to it", async () => {
		const clone = await cloneWithCommit("b.txt", "pushed\n");
		const sha = await must(clone, "rev-parse", "HEAD");
		await must(
			clone,
			...auth(token),
			"push",
			"-q",
			"origin",
			`HEAD:refs/heads/${BRANCH}`,
		);
		expect(await must(main, "rev-parse", `refs/heads/${BRANCH}`)).toBe(sha);
		expect(await must(worktree, "rev-parse", "HEAD")).toBe(sha);
		expect(readFileSync(join(worktree, "b.txt"), "utf8")).toBe("pushed\n");
		// Index and files both follow: the worktree reads clean, not as a reverted change.
		expect(await must(worktree, "status", "--porcelain")).toBe("");
		// The main checkout's branch and files stay put.
		expect(await must(main, "rev-parse", "HEAD")).toBe(base);
	}, 60_000);

	test("a push to another branch is refused and leaves every ref alone", async () => {
		const clone = await cloneWithCommit("c.txt", "nope\n");
		const before = await must(main, "rev-parse", "refs/heads/main");
		const branchBefore = await must(main, "rev-parse", `refs/heads/${BRANCH}`);
		const r = await run(
			clone,
			...auth(token),
			"push",
			"origin",
			"HEAD:refs/heads/main",
		);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("403");
		expect(await must(main, "rev-parse", "refs/heads/main")).toBe(before);
		// One command for the card branch next to a foreign one: the whole push is refused.
		const both = await run(
			clone,
			...auth(token),
			"push",
			"origin",
			`HEAD:refs/heads/${BRANCH}`,
			"HEAD:refs/heads/other",
		);
		expect(both.code).not.toBe(0);
		expect(await must(main, "rev-parse", `refs/heads/${BRANCH}`)).toBe(
			branchBefore,
		);
		expect(
			(await run(main, "rev-parse", "--verify", "-q", "refs/heads/other")).code,
		).not.toBe(0);
	}, 60_000);

	test("deleting the card branch is refused", async () => {
		const clone = await cloneWithCommit("d.txt", "x\n");
		const before = await must(main, "rev-parse", `refs/heads/${BRANCH}`);
		const r = await run(
			clone,
			...auth(token),
			"push",
			"origin",
			`:refs/heads/${BRANCH}`,
		);
		expect(r.code).not.toBe(0);
		expect(await must(main, "rev-parse", `refs/heads/${BRANCH}`)).toBe(before);
	}, 60_000);

	test("a revoked token gets 401; a token of another project gets 403", async () => {
		const extra = tokens.issue({
			project: "alpha",
			taskId: "ALP-9",
			branch: "ott/alp-9",
			repoPath: main,
			worktree,
		});
		const refs = (project: string, t: string) =>
			fetch(
				`http://127.0.0.1:${server.port}/git/${project}.git/info/refs?service=git-upload-pack`,
				{ headers: { authorization: `Bearer ${t}` } },
			);
		expect((await refs("alpha", extra)).status).toBe(200);
		tokens.revoke(extra);
		expect((await refs("alpha", extra)).status).toBe(401);
		// git sends the token as a Basic password too.
		const basic = Buffer.from(`x:${token}`).toString("base64");
		const viaBasic = await fetch(`${url()}/info/refs?service=git-upload-pack`, {
			headers: { authorization: `Basic ${basic}` },
		});
		expect(viaBasic.status).toBe(200);
		expect(viaBasic.headers.get("content-type")).toBe(
			"application/x-git-upload-pack-advertisement",
		);
		expect((await refs("beta", token)).status).toBe(403);
		// Dumb HTTP (no service) and an unknown path are not served.
		const dumb = await fetch(`${url()}/info/refs`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(dumb.status).toBe(403);
		const head = await fetch(`${url()}/HEAD`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(head.status).toBe(404);
	}, 60_000);

	test("a gzip-encoded receive-pack body is refused before it is inflated", async () => {
		const sha = await must(main, "rev-parse", "refs/heads/main");
		const line = `${sha} ${"1".repeat(40)} refs/heads/${BRANCH}\0report-status\n`;
		const pkt = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
		const res = await fetch(`${url()}/git-receive-pack`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/x-git-receive-pack-request",
				"content-encoding": "gzip",
			},
			body: Bun.gzipSync(new TextEncoder().encode(pkt)),
		});
		expect(res.status).toBe(415);
	}, 60_000);

	test("only the card branch is advertised and fetchable; a base ref is unhidden too", async () => {
		const remote = await must(dir(), ...auth(token), "ls-remote", url());
		const refs = remote
			.split("\n")
			.map((l) => l.split("\t")[1])
			.filter(Boolean);
		expect(refs).toEqual([`refs/heads/${BRANCH}`]);
		const r = await run(
			dir(),
			...auth(token),
			"fetch",
			url(),
			"refs/heads/secret",
		);
		expect(r.code).not.toBe(0);
		const clone = join(dir(), "vm");
		await must(
			dir(),
			...auth(token),
			"clone",
			"-q",
			"--branch",
			BRANCH,
			"--no-single-branch",
			url(),
			clone,
		);
		expect(await must(clone, "rev-parse", "HEAD")).toBe(
			await must(main, "rev-parse", `refs/heads/${BRANCH}`),
		);

		const withBase = (b: string) =>
			tokens.issue({
				project: "alpha",
				taskId: "ALP-1",
				branch: BRANCH,
				repoPath: main,
				worktree,
				base: b,
			});
		for (const b of ["main", "refs/heads/main"]) {
			const t = withBase(b);
			const listed = (await must(dir(), ...auth(t), "ls-remote", url()))
				.split("\n")
				.map((l) => l.split("\t")[1])
				.sort();
			expect(listed).toEqual(["refs/heads/main", `refs/heads/${BRANCH}`]);
			tokens.revoke(t);
		}
		const shaTok = withBase(base);
		const listed = (await must(dir(), ...auth(shaTok), "ls-remote", url()))
			.split("\n")
			.map((l) => l.split("\t")[1]);
		expect(listed).toEqual([`refs/heads/${BRANCH}`]);
		tokens.revoke(shaTok);
	}, 60_000);
});

describe("parseReceiveCommands", () => {
	const pkt = (s: string) =>
		`${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
	const enc = (s: string) => new TextEncoder().encode(s);
	const a = "a".repeat(40);
	const b = "b".repeat(40);

	test("reads every command up to the flush, capabilities stripped, shallow lines skipped", () => {
		const body = enc(
			pkt(`shallow ${a}\n`) +
				pkt(`${a} ${b} refs/heads/x\0report-status side-band-64k\n`) +
				pkt(`${b} ${a} refs/heads/y\n`) +
				"0000PACK....",
		);
		expect(parseReceiveCommands(body)).toEqual({
			commands: [
				{ old: a, new: b, ref: "refs/heads/x" },
				{ old: b, new: a, ref: "refs/heads/y" },
			],
		});
	});

	test("a push certificate, a garbled line or a missing flush is an error", () => {
		expect(
			"error" in
				parseReceiveCommands(enc(`${pkt("push-cert\0report-status\n")}0000`)),
		).toBe(true);
		expect(
			"error" in parseReceiveCommands(enc(`${pkt(`${a} ${b}\n`)}0000`)),
		).toBe(true);
		expect(
			"error" in
				parseReceiveCommands(enc(`${pkt(`${a} ${b} refs/heads/x y\n`)}0000`)),
		).toBe(true);
		expect(
			"error" in parseReceiveCommands(enc(pkt(`${a} ${b} refs/heads/x\n`))),
		).toBe(true);
		expect("error" in parseReceiveCommands(enc("00"))).toBe(true);
		expect("error" in parseReceiveCommands(enc("0003"))).toBe(true);
		expect("error" in parseReceiveCommands(enc("zzzz"))).toBe(true);
		// A length running past the body is not trusted.
		expect("error" in parseReceiveCommands(enc("00ff1234"))).toBe(true);
	});

	test("pushRefusal allows only updates of the card branch", () => {
		const own = { old: a, new: b, ref: "refs/heads/ott/x" };
		expect(pushRefusal([own], "ott/x")).toBeNull();
		expect(pushRefusal([], "ott/x")).toBeNull();
		expect(
			pushRefusal([own, { ...own, ref: "refs/heads/ott/x2" }], "ott/x"),
		).toContain("refs/heads/ott/x2");
		expect(
			pushRefusal([{ ...own, ref: "refs/tags/ott/x" }], "ott/x"),
		).not.toBeNull();
		expect(pushRefusal([{ ...own, new: "0".repeat(40) }], "ott/x")).toContain(
			"deleting",
		);
		expect(pushRefusal([{ ...own, new: "0".repeat(64) }], "ott/x")).toContain(
			"deleting",
		);
	});
});

describe("syncWorktreeTo", () => {
	test("refuses a value that is not a sha before running git", async () => {
		await expect(syncWorktreeTo(dir(), "HEAD~1")).rejects.toThrow(
			"not a commit sha",
		);
		await expect(
			syncWorktreeTo(dir(), `${"a".repeat(40)} --x`),
		).rejects.toThrow("not a commit sha");
	});
});

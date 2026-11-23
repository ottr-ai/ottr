import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Server } from "bun";
import {
	handleGit,
	packSupplyRefusal,
	pushRefusal,
	receiveCommands,
	syncWorktreeTo,
	type PushCommand,
} from "./gitHttp.ts";
import { fixtureGitEnv } from "./gitRepoEnv.ts";
import { type VmGrant, VmTokens } from "./vmTokens.ts";
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
				...fixtureGitEnv(),
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
let secretSha = "";

beforeAll(async () => {
	const root = dir();
	main = join(root, "alpha");
	await must(root, "init", "-q", "-b", "main", main);
	writeFileSync(join(main, "a.txt"), "one\n");
	await must(main, "add", ".");
	await must(main, "commit", "-q", "-m", "init");
	base = await must(main, "rev-parse", "HEAD");
	await must(main, "branch", "secret");
	// A hidden branch with its own commit and blob: nothing the grant sees reaches it
	// (OTTR-1031). The checkout returns to main, so the main checkout keeps base's files.
	await must(main, "checkout", "-q", "secret");
	writeFileSync(join(main, "secret.txt"), "TOPSECRET-MARKER\n");
	await must(main, "add", "secret.txt");
	await must(main, "commit", "-q", "-m", "hidden commit");
	secretSha = await must(main, "rev-parse", "refs/heads/secret");
	await must(main, "checkout", "-q", "main");
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
		fetch: (req) =>
			handleGit(req, {
				tokens,
				log: (l) => logs.push(l),
				originUrl: async () => null,
			}),
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

/** A zero-object packfile: the 12-byte header plus its own sha1 trailer. */
async function emptyPack(): Promise<Uint8Array> {
	const header = new TextEncoder().encode(
		"PACK\x00\x00\x00\x02\x00\x00\x00\x00",
	);
	const sum = new Uint8Array(await crypto.subtle.digest("SHA-1", header));
	const out = new Uint8Array(header.length + sum.length);
	out.set(header);
	out.set(sum, header.length);
	return out;
}

/** A pack of the given revs (`sha`, `^sha` lines) read from the fixture repository. */
async function packOf(revs: string): Promise<Uint8Array> {
	const p = Bun.spawn([gitExe(), "pack-objects", "--revs", "--stdout"], {
		cwd: main,
		env: {
			...fixtureGitEnv(),
			PATH: process.env.PATH ?? "",
			GIT_CONFIG_GLOBAL: "/dev/null",
			HOME: tmpdir(),
			GIT_TERMINAL_PROMPT: "0",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	p.stdin.write(revs);
	p.stdin.end();
	const [out, err] = await Promise.all([
		new Response(p.stdout).arrayBuffer(),
		new Response(p.stderr).text(),
	]);
	const code = await p.exited;
	if (code !== 0) throw new Error(`pack-objects: ${err}`);
	return new Uint8Array(out);
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

	test("a malformed chunked push is refused before its body finishes (OTTR-1003)", async () => {
		// A raw socket, not fetch: the client writes the first body chunk and then stalls
		// mid-body, so a refusal that lands before the last byte proves the board never
		// buffered the whole body before the command check. The wall-clock races here are
		// the behavior under test: fake timers cannot drive a live Bun.serve connection
		// that is waiting on a deliberately stalled socket.
		const chunks: string[] = [];
		const decoder = new TextDecoder();
		const { promise: answered, resolve: gotAnswer } =
			Promise.withResolvers<void>();
		const socket = await Bun.connect({
			hostname: "127.0.0.1",
			// Bun.serve with port 0 always fills the bound port in.
			port: server.port!,
			socket: {
				data(_s, chunk) {
					chunks.push(decoder.decode(chunk));
					gotAnswer();
				},
			},
		});
		try {
			socket.write(
				`POST /git/alpha.git/git-receive-pack HTTP/1.1\r\n` +
					`Host: 127.0.0.1:${server.port}\r\n` +
					`Authorization: Bearer ${token}\r\n` +
					`Content-Type: application/x-git-receive-pack-request\r\n` +
					`Transfer-Encoding: chunked\r\n\r\n4\r\nzzzz\r\n`,
			);
			const beforeEnd = await Promise.race([
				answered.then(() => true),
				new Promise<false>((r) => setTimeout(() => r(false), 4000)),
			]);
			if (!beforeEnd) {
				// The board is still buffering the body: end it and collect the late refusal.
				socket.write("0\r\n\r\n");
				await Promise.race([
					answered,
					new Promise<void>((r) => setTimeout(r, 4000)),
				]);
			}
			const answer = chunks.join("");
			expect(answer).toContain("403");
			expect(answer).toContain("malformed pkt-line");
			expect(beforeEnd).toBe(true);
		} finally {
			try {
				socket.end();
			} catch {
				// The board closed the connection when it refused mid-body; that is expected.
			}
		}
	}, 30_000);

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

	test("protocol v2 cannot fetch a hidden object by sha", async () => {
		// run() pins protocol.version=2 on the client; the server must answer v0 or v1, where
		// the uploadpack.allow*SHA1InWant=false pins hold (OTTR-1031).
		const scratch = dir();
		await must(scratch, "init", "-q");
		const r = await run(scratch, ...auth(token), "fetch", url(), secretSha);
		expect(r.code).not.toBe(0);
		expect(r.err).toMatch(/unadvertised/i);
		expect((await run(scratch, "cat-file", "-e", secretSha)).code).not.toBe(0);
		// Even the advertisement must not negotiate v2: v2 ignores the pins for hidden refs.
		const res = await fetch(`${url()}/info/refs?service=git-upload-pack`, {
			headers: {
				authorization: `Bearer ${token}`,
				"git-protocol": "version=2",
			},
		});
		expect(await res.text()).not.toContain("version 2");
	}, 60_000);

	test("repointing the card branch at a hidden sha is refused, pack or no pack", async () => {
		const old = await must(main, "rev-parse", `refs/heads/${BRANCH}`);
		const line = `${old} ${secretSha} refs/heads/${BRANCH}\0report-status side-band-64k\n`;
		const pkt = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
		const empty = await emptyPack();
		const body = new Uint8Array(pkt.length + empty.length);
		body.set(new TextEncoder().encode(pkt));
		body.set(empty, pkt.length);
		const res = await fetch(`${url()}/git-receive-pack`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/x-git-receive-pack-request",
			},
			body,
		});
		expect(res.status).toBe(403);
		expect(await must(main, "rev-parse", `refs/heads/${BRANCH}`)).toBe(old);
	}, 60_000);
});

describe("receiveCommands", () => {
	const pkt = (s: string) =>
		`${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
	const enc = (s: string) => new TextEncoder().encode(s);
	const streamBody = (...parts: string[]) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const part of parts) c.enqueue(enc(part));
				c.close();
			},
		});
	const commands = async (
		body: string | ReadableStream<Uint8Array>,
		cap?: number,
	) => {
		const r = await receiveCommands(
			new Request("http://board.invalid/git/alpha.git/git-receive-pack", {
				method: "POST",
				body,
			}),
			cap ?? 1024 * 1024,
		);
		if ("error" in r) throw new Error(r.error);
		await r.stdin.cancel();
		return r.commands;
	};
	const refused = async (
		body: string | ReadableStream<Uint8Array>,
		cap?: number,
	) => {
		const r = await receiveCommands(
			new Request("http://board.invalid/git/alpha.git/git-receive-pack", {
				method: "POST",
				body,
			}),
			cap ?? 1024 * 1024,
		);
		return "error" in r ? r.error : null;
	};
	const a = "a".repeat(40);
	const b = "b".repeat(40);

	test("reads every command up to the flush, capabilities stripped, shallow lines skipped", async () => {
		expect(
			await commands(
				pkt(`shallow ${a}\n`) +
					pkt(`${a} ${b} refs/heads/x\0report-status side-band-64k\n`) +
					pkt(`${b} ${a} refs/heads/y\n`) +
					"0000PACK....",
			),
		).toEqual([
			{ old: a, new: b, ref: "refs/heads/x" },
			{ old: b, new: a, ref: "refs/heads/y" },
		]);
	});

	test("a section split across stream chunks keeps every command byte for the backend", async () => {
		// The command section arrives in two chunks with the boundary between the commands:
		// the stdin handed to http-backend must carry both commands and the flush byte for
		// byte, or a valid fragmented push would lose its ref updates.
		const first = pkt(`${a} ${b} refs/heads/x\n`);
		const rest = pkt(`${b} ${a} refs/heads/y\n`) + "0000PACK....";
		const r = await receiveCommands(
			new Request("http://board.invalid/git/alpha.git/git-receive-pack", {
				method: "POST",
				body: streamBody(first, rest),
			}),
			1024 * 1024,
		);
		if (!("stdin" in r)) throw new Error(r.error);
		expect(r.commands).toEqual([
			{ old: a, new: b, ref: "refs/heads/x" },
			{ old: b, new: a, ref: "refs/heads/y" },
		]);
		expect(new Uint8Array(await new Response(r.stdin).arrayBuffer())).toEqual(
			enc(first + rest),
		);
	});

	test("a push certificate, a garbled line or a missing flush is an error", async () => {
		expect(
			await refused(`${pkt("push-cert\0report-status\n")}0000`),
		).not.toBeNull();
		expect(await refused(`${pkt(`${a} ${b}\n`)}0000`)).not.toBeNull();
		expect(
			await refused(`${pkt(`${a} ${b} refs/heads/x y\n`)}0000`),
		).not.toBeNull();
		// A missing flush is a truncated section, not a refusal of the lines before it.
		expect(await refused(pkt(`${a} ${b} refs/heads/x\n`))).not.toBeNull();
		expect(await refused("")).not.toBeNull();
		expect(await refused("00")).not.toBeNull();
		expect(await refused("0003")).not.toBeNull();
		expect(await refused("zzzz")).toBe("malformed pkt-line");
		// A length running past the body is not trusted.
		expect(await refused("00ff1234")).not.toBeNull();
	});

	test("a command section with no flush is refused at the cap instead of being buffered", async () => {
		const line = pkt(`${a} ${b} refs/heads/x\n`);
		expect(await refused(line.repeat(10), 512)).toContain("over");
		// Small chunks do not reset the count: consumed bytes stay counted against the cap.
		expect(await refused(streamBody(...Array(200).fill(line)), 512)).toContain(
			"over",
		);
		const flood = line.repeat(Math.ceil((1024 * 1024 * 1.2) / line.length));
		expect(await refused(flood)).toContain("over");
		// The cap also holds when the section finally flushes: every byte before the flush
		// counts, whatever chunk it arrived in.
		const lines = Math.ceil((1024 * 1024 * 1.2) / line.length);
		expect(await refused(`${line.repeat(lines)}0000PACK...`)).toContain("over");
		// A section under the cap that flushes is read normally; the packfile tail is not buffered.
		expect((await commands(`${line.repeat(5000)}0000PACK...`)).length).toBe(
			5000,
		);
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

describe("packSupplyRefusal", () => {
	const grant = (base?: string): VmGrant => ({
		project: "alpha",
		taskId: "ALP-1",
		branch: BRANCH,
		repoPath: main,
		worktree,
		...(base === undefined ? {} : { base }),
	});
	const cmd = (newSha: string): PushCommand => ({
		old: "0".repeat(40),
		new: newSha,
		ref: `refs/heads/${BRANCH}`,
	});

	test("an empty pack cannot repoint the branch at a hidden sha", async () => {
		const r = await packSupplyRefusal(
			[cmd(secretSha)],
			grant(),
			await emptyPack(),
		);
		expect(r).toContain(secretSha);
		expect(r).toContain("not supplied");
	}, 60_000);

	test("a pack that carries the hidden chain may re-send it", async () => {
		const branchTip = await must(main, "rev-parse", `refs/heads/${BRANCH}`);
		const pack = await packOf(`${secretSha}\n^${branchTip}\n`);
		expect(pack.length).toBeGreaterThan(0);
		const r = await packSupplyRefusal([cmd(secretSha)], grant("main"), pack);
		expect(r).toBeNull();
	}, 60_000);

	test("repointing at a visible tip needs no pack objects", async () => {
		const r = await packSupplyRefusal(
			[cmd(base)],
			grant("main"),
			await emptyPack(),
		);
		expect(r).toBeNull();
	}, 60_000);

	test("a delete command needs no pack", async () => {
		const r = await packSupplyRefusal(
			[{ ...cmd(secretSha), new: "0".repeat(40) }],
			grant(),
			await emptyPack(),
		);
		expect(r).toBeNull();
	}, 60_000);

	// Crafted pack plumbing: the guest builds raw pack entries, so a delta can name a base
	// whose bytes it never sends.

	/** The type and size varints of one pack entry header. */
	function entryHead(type: number, size: number): Uint8Array {
		const head: number[] = [(type << 4) | (size & 0x0f)];
		for (let rest = size >> 4; rest > 0; rest >>= 7) {
			const last = head.length - 1;
			head[last] = (head[last] ?? 0) | 0x80;
			head.push(rest & 0x7f);
		}
		return Uint8Array.from(head);
	}

	/** One pack entry: a type header, a size varint, and the deflated payload. */
	function packEntry(type: number, payload: Uint8Array): Uint8Array {
		const body = deflateSync(payload);
		const out = new Uint8Array(
			entryHead(type, payload.length).length + body.length,
		);
		out.set(entryHead(type, payload.length));
		out.set(body, entryHead(type, payload.length).length);
		return out;
	}

	/** A REF_DELTA entry: the 20-byte base oid rides uncompressed in front of the compressed delta. */
	function refDeltaEntry(baseOid: string, delta: Uint8Array): Uint8Array {
		const head = entryHead(7, delta.length);
		const oid = Buffer.from(baseOid, "hex");
		const body = deflateSync(delta);
		const out = new Uint8Array(head.length + 20 + body.length);
		out.set(head);
		out.set(oid, head.length);
		out.set(body, head.length + 20);
		return out;
	}

	/** A literal-only delta body: base size, result size, one literal run. */
	function literalDelta(baseSize: number, text: string): Uint8Array {
		const size = (n: number): number[] => {
			const out: number[] = [n & 0x7f];
			for (n >>= 7; n > 0; n >>= 7) {
				const last = out.length - 1;
				out[last] = (out[last] ?? 0) | 0x80;
				out.push(n & 0x7f);
			}
			return out;
		};
		return Uint8Array.from([
			...size(baseSize),
			...size(text.length),
			text.length,
			...new TextEncoder().encode(text),
		]);
	}

	/** A tree object naming one blob by its oid. */
	function treeBytes(blobOid: string, name: string): Uint8Array {
		const head = new TextEncoder().encode(`100644 ${name}\0`);
		const out = new Uint8Array(head.length + 20);
		out.set(head);
		out.set(Buffer.from(blobOid, "hex"), head.length);
		return out;
	}

	/** A commit object over the given tree and parent. */
	function commitBytes(treeOid: string, parent: string): Uint8Array {
		return new TextEncoder().encode(
			`tree ${treeOid}\nparent ${parent}\nauthor ott <ott@example.invalid> 0 +0000\ncommitter ott <ott@example.invalid> 0 +0000\n\ncrafted\n`,
		);
	}

	/** The store sha of one object body. */
	async function objectSha(type: string, body: Uint8Array): Promise<string> {
		const head = new TextEncoder().encode(`${type} ${body.length}\0`);
		const all = new Uint8Array(head.length + body.length);
		all.set(head);
		all.set(body, head.length);
		return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	/** A packfile over the entries, with the object count and the sha1 trailer. */
	async function assemblePack(entries: Uint8Array[]): Promise<Uint8Array> {
		const parts: Uint8Array[] = [
			new TextEncoder().encode("PACK"),
			new Uint8Array(new DataView(new ArrayBuffer(8)).buffer),
			...entries,
		];
		new DataView(parts[1]!.buffer).setUint32(0, 2);
		new DataView(parts[1]!.buffer).setUint32(4, entries.length);
		const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			body.set(p, at);
			at += p.length;
		}
		const out = new Uint8Array(body.length + 20);
		out.set(body);
		out.set(
			new Uint8Array(await crypto.subtle.digest("SHA-1", body)),
			body.length,
		);
		return out;
	}

	test("a thin delta cannot smuggle a hidden base the guest never carried", async () => {
		// The blocker's case: the guest knows the hidden blob's oid and size, sends a
		// literal-only REF_DELTA naming it as base, and a commit and tree that reference the
		// blob. --fix-thin appends the hidden base's bytes to the repaired pack, so the
		// index alone would count store bytes as guest-supplied.
		const branchTip = await must(main, "rev-parse", `refs/heads/${BRANCH}`);
		const secretBlob = await must(main, "rev-parse", `${secretSha}:secret.txt`);
		const blobSize = Number(await must(main, "cat-file", "-s", secretBlob));
		const tree = treeBytes(secretBlob, "secret.txt");
		const commit = commitBytes(await objectSha("tree", tree), branchTip);
		const commitSha = await objectSha("commit", commit);
		const pack = await assemblePack([
			packEntry(1, commit),
			packEntry(2, tree),
			refDeltaEntry(secretBlob, literalDelta(blobSize, "abc")),
		]);
		const r = await packSupplyRefusal(
			[{ old: branchTip, new: commitSha, ref: `refs/heads/${BRANCH}` }],
			grant("main"),
			pack,
		);
		expect(r).toContain(secretBlob);
		expect(r).toContain("not supplied");
	}, 60_000);

	test("a thin delta against a visible base stays allowed", async () => {
		const branchTip = await must(main, "rev-parse", `refs/heads/${BRANCH}`);
		const visibleBlob = await must(main, "rev-parse", "refs/heads/main:a.txt");
		const blobSize = Number(await must(main, "cat-file", "-s", visibleBlob));
		const tree = treeBytes(visibleBlob, "a.txt");
		const commit = commitBytes(await objectSha("tree", tree), branchTip);
		const commitSha = await objectSha("commit", commit);
		const pack = await assemblePack([
			packEntry(1, commit),
			packEntry(2, tree),
			refDeltaEntry(visibleBlob, literalDelta(blobSize, "abc")),
		]);
		const r = await packSupplyRefusal(
			[{ old: branchTip, new: commitSha, ref: `refs/heads/${BRANCH}` }],
			grant("main"),
			pack,
		);
		expect(r).toBeNull();
	}, 60_000);
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

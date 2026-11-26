import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	lfsEndpointPin,
	lfsPointerOids,
	pushBranch,
	pushLfsObjects,
	serverMergePush,
	setHostedGitAuth,
	setNetworkGitAuth,
} from "./worktree.ts";

/**
 * The LFS half of the server-side pushes (OTTR-1058). The board's git pins
 * core.hooksPath=/dev/null, so git-lfs's pre-push hook never runs and a merge that adds
 * an LFS file fails the remote's unknown-object rejection (GH008 on GitHub). These
 * fixtures run real git and real git-lfs against a local smart-HTTP git server whose
 * pre-receive hook rejects a push whose new commits reference an LFS object the local
 * LFS server has not stored — the GH008 check, faithfully.
 */

const id = ["-c", "user.name=t", "-c", "user.email=t@t"];

/** A fixture's own git spawn; the code under test goes through git(), never this.
 * Async on purpose: a sync spawn would block this process's event loop and starve the
 * in-process fixture server the spawned git talks to. */
const run = async (cwd: string, ...args: string[]): Promise<string> => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
	return out.trim();
};

/** The oid of the LFS object a committed pointer file names. */
const pointerOid = async (repo: string, path: string): Promise<string> => {
	const pointer = await run(repo, "cat-file", "-p", `HEAD:${path}`);
	const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1];
	if (oid === undefined) throw new Error(`no LFS oid in ${path}: ${pointer}`);
	return oid;
};

/**
 * A local server that answers the git smart-HTTP protocol (clone and push, with hooks)
 * and the Git LFS batch/PUT protocol on one port. Every uploaded object's oid lands in
 * `storeFile` (what the pre-receive hook reads) and its bytes in `dir/lfs-store/`.
 * `batchStatus` lets a test break the LFS upload: a failing batch endpoint answers the
 * error immediately, where a failing upload would run git-lfs's retry backoff.
 */
function serveGitLfs(
	dir: string,
	bare: string,
	batchStatus = 200,
	requireAuth = false,
): {
	url: string;
	storeFile: string;
	/** Every LFS API request as "<method> <path>", in arrival order. */
	requests: string[];
	/** The Authorization header of every batch request, in arrival order. */
	authHeaders: string[];
	close: () => void;
} {
	const storeFile = join(dir, "lfs-store.txt");
	writeFileSync(storeFile, "");
	const storeDir = join(dir, "lfs-store");
	mkdirSync(storeDir);
	const requests: string[] = [];
	const authHeaders: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const p = url.pathname;
			if (req.method === "GET" && p.endsWith("/info/refs")) {
				const svc = url.searchParams.get("service") ?? "git-upload-pack";
				const bin = svc === "git-receive-pack" ? "receive-pack" : "upload-pack";
				const adv = spawnSync(
					["git", bin, "--stateless-rpc", "--advertise-refs", bare].join(" "),
					{ shell: true, encoding: "buffer" },
				);
				const head = `# service=${svc}\n`;
				const headPkt = Buffer.from(
					(head.length + 4).toString(16).padStart(4, "0") + head,
				);
				const body = Buffer.concat([headPkt, Buffer.from("0000"), adv.stdout]);
				return new Response(body, {
					headers: { "Content-Type": `application/x-${svc}-advertisement` },
				});
			}
			const svc = p.endsWith("/git-upload-pack")
				? "upload-pack"
				: p.endsWith("/git-receive-pack")
					? "receive-pack"
					: null;
			if (req.method === "POST" && svc !== null) {
				const buf = Buffer.from(await req.arrayBuffer());
				const body =
					buf[0] === 0x1f && buf[1] === 0x8b ? Bun.gunzipSync(buf) : buf;
				const proc = Bun.spawn(["git", svc, "--stateless-rpc", bare], {
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
				proc.stdin.write(body);
				proc.stdin.end();
				const out = await new Response(proc.stdout).arrayBuffer();
				await proc.exited;
				return new Response(out, {
					headers: { "Content-Type": `application/x-git-${svc}-result` },
				});
			}
			// OTTR-1109: a locking endpoint that answers like GitHub answers a token it
			// will not process (422). With the lock-check pin git-lfs never calls it;
			// `requests` is the proof.
			if (req.method === "POST" && p.endsWith("/info/lfs/locks/verify")) {
				requests.push(`POST ${p}`);
				return new Response("no locking here", { status: 422 });
			}
			if (req.method === "POST" && p.endsWith("/info/lfs/objects/batch")) {
				requests.push(`POST ${p}`);
				authHeaders.push(req.headers.get("authorization") ?? "");
				// GitHub answers an unauthenticated batch with a 401 challenge, and
				// git-lfs authenticates only after one; requireAuth models that, so the
				// helper-driven Authorization retry is observable.
				if (requireAuth && authHeaders[authHeaders.length - 1] === "")
					return new Response("", {
						status: 401,
						headers: { "WWW-Authenticate": `Basic realm="git-lfs"` },
					});
				if (batchStatus !== 200)
					return new Response("broken", { status: batchStatus });
				const { objects } = (await req.json()) as {
					objects: { oid: string; size: number }[];
				};
				const out: {
					transfer: string;
					objects: {
						oid: string;
						size: number;
						actions?: { upload: { href: string } };
					}[];
				} = {
					transfer: "basic",
					objects: objects.map((o) =>
						existsSync(join(storeDir, o.oid))
							? { oid: o.oid, size: o.size }
							: {
									oid: o.oid,
									size: o.size,
									actions: {
										upload: {
											href: `http://127.0.0.1:${server.port}/storage/${o.oid}`,
										},
									},
								},
					),
				};
				return new Response(JSON.stringify(out), {
					headers: { "Content-Type": "application/vnd.git-lfs+json" },
				});
			}
			if (req.method === "PUT" && p.startsWith("/storage/")) {
				const oid = p.slice("/storage/".length);
				const bytes = Buffer.from(await req.arrayBuffer());
				writeFileSync(join(storeDir, oid), bytes);
				appendFileSync(
					join(dir, "hook.log"),
					`stored ${oid} ${bytes.length}\n`,
				);
				appendFileSync(storeFile, `${oid}\n`);
				return new Response(null, { status: 200 });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/origin.git`,
		storeFile,
		requests,
		authHeaders,
		close: () => server.stop(true),
	};
}

/** The bare origin's GH008: a pre-receive hook that rejects pushed commits referencing an LFS object the LFS server has not stored. */
function writeLfsPreReceive(bare: string, storeFile: string): void {
	writeFileSync(
		join(bare, "hooks", "pre-receive"),
		`#!/bin/sh
while read old new ref; do
	[ "$new" = "0000000000000000000000000000000000000000" ] && continue
	for obj in $(git rev-list --objects "$new" --not --all 2>/dev/null | cut -d' ' -f1); do
		[ "$(git cat-file -t "$obj" 2>/dev/null)" = "blob" ] || continue
		[ "$(git cat-file -p "$obj" | head -c 43)" = "version https://git-lfs.github.com/spec/v1" ] || continue
		oid=$(git cat-file -p "$obj" | sed -n 's/^oid sha256://p')
		grep -qx "$oid" "${storeFile}" || {
			echo "GH008: unknown Git LFS object $oid" >&2
			exit 1
		}
	done
done
exit 0
`,
	);
	chmodSync(join(bare, "hooks", "pre-receive"), 0o755);
}

/** An LFS sprite committed on the worktree branch and merged into local main. */
async function commitSprite(main: string, wt: string): Promise<string> {
	await run(wt, "lfs", "track", "*.png");
	const props = join(wt, "assets", "art", "props", "tree_oak");
	mkdirSync(props, { recursive: true });
	writeFileSync(join(props, "oak.png"), "sprite-bytes-for-the-fixture");
	await run(wt, "add", "assets/art/props/tree_oak/oak.png", ".gitattributes");
	await run(wt, ...id, "commit", "-q", "-m", "sprites");
	await run(main, "merge", "-q", "--ff-only", "ott/x");
	return await pointerOid(main, "assets/art/props/tree_oak/oak.png");
}

/** A clone of a smart-HTTP origin whose local main holds the worktree branch's LFS sprite commit. */
async function fixture(
	o: {
		lfs?: boolean;
		batchStatus?: number;
		origin?: string;
		requireAuth?: boolean;
	} = {},
): Promise<{
	dir: string;
	bare: string;
	main: string;
	wt: string;
	url: string;
	storeFile: string;
	/** The sprite pointer's LFS oid; "" when the fixture has no LFS file. */
	oid: string;
	/** Every LFS API request as "<method> <path>", in arrival order. */
	requests: string[];
	/** The Authorization header of every batch request, in arrival order. */
	authHeaders: string[];
	close: () => void;
}> {
	const dir = mkdtempSync(join(tmpdir(), "ottr-lfs-"));
	const bare = join(dir, "origin.git");
	await run(dir, "init", "-q", "--bare", "-b", "main", bare);
	const git = serveGitLfs(dir, bare, o.batchStatus, o.requireAuth === true);
	// The origin name is the URL's last path segment: "origin.git" (a normal clone
	// URL) or a name without the .git suffix, for the endpoint-derivation test.
	const origin = o.origin ?? "origin.git";
	const url = git.url.replace(/\/origin\.git$/, `/${origin}`);
	writeLfsPreReceive(bare, git.storeFile);
	const main = join(dir, "main");
	await run(dir, "-c", "init.defaultBranch=main", "clone", "-q", url, main);
	await run(main, ...id, "commit", "-q", "--allow-empty", "-m", "base");
	await run(main, "push", "-q", "origin", "main");
	const wt = join(dir, "wt");
	await run(main, "worktree", "add", "-q", "-b", "ott/x", wt);
	if (o.lfs !== false) {
		await commitSprite(main, wt);
	} else {
		// A plain commit, so the merge push has something to push.
		writeFileSync(join(wt, "notes.txt"), "plain text\n");
		await run(wt, "add", "notes.txt");
		await run(wt, ...id, "commit", "-q", "-m", "notes");
		await run(main, "merge", "-q", "--ff-only", "ott/x");
	}
	return {
		dir,
		bare,
		main,
		wt,
		url,
		storeFile: git.storeFile,
		oid:
			o.lfs !== false
				? await pointerOid(main, "assets/art/props/tree_oak/oak.png")
				: "",
		requests: git.requests,
		authHeaders: git.authHeaders,
		close: git.close,
	};
}

/**
 * The plain git() state the other push fixtures assume: no app resolver, no hosted
 * auth. Importing a test file that booted the app (its resolver pins transports to
 * https/ssh/file) would otherwise block this file's http:// fixture origins.
 */
beforeAll(() => {
	setNetworkGitAuth(() => ({}));
	setHostedGitAuth(null);
});
afterAll(() => {
	setNetworkGitAuth(() => ({}));
	setHostedGitAuth(null);
});

const cleanup = (dir: string, close: () => void): void => {
	close();
	rmSync(dir, { recursive: true, force: true });
};

describe("serverMergePush with Git LFS", () => {
	test("uploads the LFS objects of the pushed range before the push (GH008)", async () => {
		const f = await fixture({ lfs: true });
		try {
			const local = await run(f.main, "rev-parse", "refs/heads/main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.url,
			);
			expect(r.status).toBe("pushed");
			// The object reached the LFS server before the pre-receive check ran.
			const stored = readFileSync(f.storeFile, "utf8").trim().split("\n");
			expect(stored).toContain(f.oid);
			const bytes = readFileSync(join(f.dir, "lfs-store", f.oid));
			expect(bytes.toString()).toBe("sprite-bytes-for-the-fixture");
			expect(await run(f.bare, "rev-parse", "main")).toBe(local);
		} finally {
			cleanup(f.dir, f.close);
		}
	});

	test("a broken LFS upload stops the push and surfaces the git-lfs error", async () => {
		// The batch endpoint answers an error: git-lfs retries a failing upload with
		// backoff, so the batch is the fast way to break the upload.
		const f = await fixture({ lfs: true, batchStatus: 500 });
		try {
			const before = await run(f.bare, "rev-parse", "main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.url,
			);
			if (r.status !== "failed")
				throw new Error(`expected failed, got ${r.status}`);
			// git-lfs's own error, not a generic git message.
			expect(r.error).toMatch(/batch response:|proper access/);
			expect(await run(f.bare, "rev-parse", "main")).toBe(before);
		} finally {
			cleanup(f.dir, f.close);
		}
	});

	test("an operator-set lfs.url wins: the push follows the repo config endpoint", async () => {
		// OTTR-1283 (operator decision): on a GitHub-host origin, lfs.url holding a value
		// skips the command-line pin, so the upload resolves the config's endpoint — here
		// a bare LFS-only server that receives the object while the origin's own LFS API
		// sees no batch at all. The board stores nothing either way. The origin argument
		// names github.com (the skip rule's scope); only lfs.url is reachable. A repo
		// insteadOf entry keeps git-lfs's own ref read of that URL on the local fixture
		// server, so the test stays off the network.
		const f = await fixture({ lfs: true });
		const f2dir = mkdtempSync(join(tmpdir(), "ottr-lfs-mirror-"));
		const f2bare = join(f2dir, "bare.git");
		await run(f2dir, "init", "-q", "--bare", "-b", "main", f2bare);
		const f2 = serveGitLfs(f2dir, f2bare);
		try {
			await run(
				f.main,
				"config",
				`url.${f.url}.insteadOf`,
				"https://github.com/octo",
			);
			await run(f.main, "config", "lfs.url", `${f2.url}/info/lfs`);
			const tip = await run(f.main, "rev-parse", "refs/heads/main");
			const base = await run(f.main, "rev-parse", "origin/main");
			const oids = await lfsPointerOids(f.main, tip, base);
			expect(oids.length).toBe(1);
			expect(
				await pushLfsObjects(
					f.main,
					"https://github.com/octo/repo",
					"main",
					tip,
					base,
				),
			).toBeNull();
			expect(readFileSync(f2.storeFile, "utf8")).toContain(f.oid);
			expect(f.requests.filter((p) => p.includes("/objects/batch"))).toEqual(
				[],
			);
		} finally {
			cleanup(f.dir, f.close);
			cleanup(f2dir, f2.close);
		}
	}, 20_000);

	test("pins the endpoint with git-lfs's own derivation for an origin URL without .git (OTTR-1109)", async () => {
		// OTTR-1058 pinned <originUrl>/info/lfs verbatim; git-lfs's own derivation
		// appends .git to a URL that lacks the suffix (lfsapi/endpoint_finder.go
		// NewEndpointFromCloneURL). GitHub answers the bare form 422 on the locking
		// and batch routes alike (MYST-34), so the pin must name the .git form.
		const f = await fixture({ lfs: true, origin: "origin" });
		try {
			const local = await run(f.main, "rev-parse", "refs/heads/main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.url,
			);
			expect(r.status).toBe("pushed");
			expect(readFileSync(f.storeFile, "utf8")).toContain(f.oid);
			// The exact request list: one batch, at the .git endpoint git-lfs itself
			// would derive, and the locking API stays silent.
			expect(f.requests).toEqual(["POST /origin.git/info/lfs/objects/batch"]);
			expect(await run(f.bare, "rev-parse", "main")).toBe(local);
		} finally {
			cleanup(f.dir, f.close);
		}
	});

	test("a 422 locking endpoint never runs: no locks/verify call, one batch call (OTTR-1109)", async () => {
		// MYST-34: on github hosts git-lfs verifies locks by default, and the board
		// token's locks/verify call answered 422, failing the whole upload before the
		// batch. The push pins lfs.<endpoint>.locksverify=false, so a locking endpoint
		// that answers 422 must never see a request and the upload must still land.
		const f = await fixture({ lfs: true });
		try {
			const local = await run(f.main, "rev-parse", "refs/heads/main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.url,
			);
			expect(r.status).toBe("pushed");
			expect(readFileSync(f.storeFile, "utf8")).toContain(f.oid);
			expect(f.requests.filter((p) => p.includes("/locks/verify"))).toEqual([]);
			expect(
				f.requests.filter((p) => p.includes("/objects/batch")),
			).toHaveLength(1);
			expect(await run(f.bare, "rev-parse", "main")).toBe(local);
		} finally {
			cleanup(f.dir, f.close);
		}
	});
});

describe("pushLfsObjects authentication", () => {
	test("the upload authenticates exactly as the board's credential helper answers (OTTR-1109)", async () => {
		// gitAuthEnv (gitHosts.ts) plants the per-host helper the board's pushes run
		// with: an empty-helper reset, then a printf of the env-fed username/password
		// pair. The default username for a github host is x-access-token (githubHost.ts,
		// Dockerfile.worker's system helper), so git-lfs must send exactly Basic
		// base64("x-access-token:<token>") to the LFS API — the Authorization form this
		// test pins against the same helper body.
		const f = await fixture({ lfs: true, requireAuth: true });
		try {
			const host = new URL(f.url).host;
			const token = "board-lfs-token-1234567890";
			const authEnv: Record<string, string> = {
				GIT_TERMINAL_PROMPT: "0",
				GIT_ASKPASS: "",
				GIT_CONFIG_COUNT: "2",
				GIT_CONFIG_KEY_0: "credential.helper",
				GIT_CONFIG_VALUE_0: "",
				GIT_CONFIG_KEY_1: `credential.http://${host}.helper`,
				GIT_CONFIG_VALUE_1: `!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$OTTR_GIT_USER_0" "$OTTR_GIT_TOKEN_0"; }; f`,
				OTTR_GIT_USER_0: "x-access-token",
				OTTR_GIT_TOKEN_0: token,
			};
			const base = await run(f.bare, "rev-parse", "main");
			const tip = await run(f.main, "rev-parse", "refs/heads/main");
			expect(
				await pushLfsObjects(f.main, f.url, "main", tip, base, authEnv),
			).toBeNull();
			// git-lfs sends the first batch unauthenticated, retries it after the
			// server's 401 challenge with the helper's answer.
			expect(f.requests).toEqual([
				"POST /origin.git/info/lfs/objects/batch",
				"POST /origin.git/info/lfs/objects/batch",
			]);
			expect(f.authHeaders).toEqual([
				"",
				`Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
			]);
		} finally {
			cleanup(f.dir, f.close);
		}
	});
});

describe("pushBranch with Git LFS", () => {
	test("uploads the LFS objects of the pushed range before the push (PR mode)", async () => {
		const f = await fixture({ lfs: true });
		try {
			const r = await pushBranch(f.main, "main", f.url);
			expect(r.status).toBe("pushed");
			expect(readFileSync(f.storeFile, "utf8")).toContain(f.oid);
		} finally {
			cleanup(f.dir, f.close);
		}
	});
});

describe("no LFS, no git-lfs command", () => {
	test("a repo without LFS runs no git lfs command", async () => {
		const f = await fixture({ lfs: false });
		const shim = join(f.dir, "shim");
		mkdirSync(shim);
		const marker = join(f.dir, "lfs-invocations.log");
		writeFileSync(
			join(shim, "git-lfs"),
			`#!/bin/sh
echo "git-lfs $*" >> "${marker}"
exit 1
`,
		);
		chmodSync(join(shim, "git-lfs"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${shim}:${path}`;
		try {
			const local = await run(f.main, "rev-parse", "refs/heads/main");
			expect(
				(
					await serverMergePush(
						f.main,
						f.wt,
						"origin/main",
						"ott/x",
						null,
						f.url,
					)
				).status,
			).toBe("pushed");
			expect(
				await pushBranch(f.main, "main", f.url).then((r) => r.status),
			).toBe("pushed");
			expect(existsSync(marker)).toBe(false);
			expect(await run(f.bare, "rev-parse", "main")).toBe(local);
		} finally {
			process.env.PATH = path;
			cleanup(f.dir, f.close);
		}
	});
});

describe("a file:// pinned origin stores LFS objects in the bare repo", () => {
	test("uploads via the standalone file transfer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-lfs-file-"));
		const bare = join(dir, "origin.git");
		await run(dir, "init", "-q", "--bare", "-b", "main", bare);
		const main = join(dir, "main");
		await run(dir, "-c", "init.defaultBranch=main", "clone", "-q", bare, main);
		await run(main, ...id, "commit", "-q", "--allow-empty", "-m", "base");
		await run(main, "push", "-q", "origin", "main");
		const wt = join(dir, "wt");
		await run(main, "worktree", "add", "-q", "-b", "ott/x", wt);
		const lfsOid = await commitSprite(main, wt);
		try {
			const r = await serverMergePush(
				main,
				wt,
				"origin/main",
				"ott/x",
				null,
				bare,
			);
			expect(r.status).toBe("pushed");
			const shard = join(
				bare,
				"lfs",
				"objects",
				lfsOid.slice(0, 2),
				lfsOid.slice(2, 4),
				lfsOid,
			);
			expect(readFileSync(shard).toString()).toBe(
				"sprite-bytes-for-the-fixture",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("lfsPointerOids", () => {
	/** A repo whose main goes base < steps, each step a commit. */
	const repoWith = async (
		steps: ("add" | "delete" | "text" | "big")[],
	): Promise<{ dir: string; repo: string; base: string; tip: string }> => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-lfs-scan-"));
		const repo = join(dir, "repo");
		await run(dir, "init", "-q", "-b", "main", repo);
		await run(repo, ...id, "commit", "-q", "--allow-empty", "-m", "base");
		const base = await run(repo, "rev-parse", "HEAD");
		for (const step of steps) {
			if (step === "add") {
				await run(repo, "lfs", "track", "*.png");
				writeFileSync(join(repo, "oak.png"), "scan-bytes");
				await run(repo, "add", "oak.png", ".gitattributes");
			} else if (step === "text") {
				// A text file that starts like a pointer but names no oid.
				writeFileSync(
					join(repo, "readme.md"),
					"version https://git-lfs.github.com/spec/v1\nbut no oid line\n",
				);
				await run(repo, "add", "readme.md");
			} else if (step === "big") {
				// A plain blob over the pointer size cap that looks like a pointer: the
				// size gate must keep it out of the content pass, so its fake oid never
				// surfaces.
				const fakeOid = "a".repeat(64);
				writeFileSync(
					join(repo, "large.log"),
					`version https://git-lfs.github.com/spec/v1\noid sha256:${fakeOid}\nsize 1\n${"x".repeat(4096)}\n`,
				);
				await run(repo, "add", "large.log");
			} else {
				await run(repo, "rm", "-q", "oak.png");
			}
			await run(repo, ...id, "commit", "-q", "-m", step);
		}
		return { dir, repo, base, tip: await run(repo, "rev-parse", "HEAD") };
	};

	test("finds pointer oids in the pushed range, including one added and deleted mid-range", async () => {
		const r = await repoWith(["add", "delete"]);
		try {
			expect(await lfsPointerOids(r.repo, r.tip, r.base)).toHaveLength(1);
		} finally {
			rmSync(r.dir, { recursive: true, force: true });
		}
	});

	test("finds no oid without LFS, and a pointer-like text file is no pointer", async () => {
		const r = await repoWith(["text"]);
		try {
			expect(await lfsPointerOids(r.repo, r.tip, r.base)).toEqual([]);
		} finally {
			rmSync(r.dir, { recursive: true, force: true });
		}
	});

	test("a blob over the pointer size cap never enters the content pass", async () => {
		// The big blob carries a syntactically valid pointer: only the size gate keeps
		// its fake oid out. This is the unbounded-memory fix made observable (send-back
		// on OTTR-1058): the content pass reads nothing over LFS_POINTER_MAX_BYTES.
		const r = await repoWith(["big"]);
		try {
			expect(await lfsPointerOids(r.repo, r.tip, r.base)).toEqual([]);
		} finally {
			rmSync(r.dir, { recursive: true, force: true });
		}
	});

	test("the size gate does not lose a real pointer next to a big blob, with base null too", async () => {
		const r = await repoWith(["big", "add"]);
		try {
			const oids = await lfsPointerOids(r.repo, r.tip, null);
			expect(oids).toHaveLength(1);
			// The fake oid of the oversized pointer-lookalike must not appear.
			expect(oids[0]).not.toMatch(/^a+$/);
		} finally {
			rmSync(r.dir, { recursive: true, force: true });
		}
	});
});

describe("pushLfsObjects origin schemes", () => {
	/** A repo whose main adds one LFS pointer on top of base. */
	const repoWithPointer = async (): Promise<{
		dir: string;
		repo: string;
		base: string;
		tip: string;
	}> => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-lfs-scheme-"));
		const repo = join(dir, "repo");
		await run(dir, "init", "-q", "-b", "main", repo);
		await run(repo, ...id, "commit", "-q", "--allow-empty", "-m", "base");
		const base = await run(repo, "rev-parse", "HEAD");
		await run(repo, "lfs", "track", "*.png");
		writeFileSync(join(repo, "oak.png"), "scheme-bytes");
		await run(repo, "add", "oak.png", ".gitattributes");
		await run(repo, ...id, "commit", "-q", "-m", "sprites");
		return { dir, repo, base, tip: await run(repo, "rev-parse", "HEAD") };
	};

	test("no git lfs command runs for an ssh origin: the upload cannot be pinned there", async () => {
		// Security review on OTTR-1058: for a non-http(s) origin no command-line pin
		// exists, so a planted lfs.url or .lfsconfig would move the endpoint to a
		// hostile server whose batch response can name a planted custom transfer
		// adapter. The LFS step must not run at all; the push keeps the pre-1058
		// behavior (the remote's unknown-object rejection lands on the card).
		const r = await repoWithPointer();
		const shim = join(r.dir, "shim");
		mkdirSync(shim);
		const marker = join(r.dir, "lfs-invocations.log");
		writeFileSync(
			join(shim, "git-lfs"),
			`#!/bin/sh
echo "git-lfs $*" >> "${marker}"
exit 1
`,
		);
		chmodSync(join(shim, "git-lfs"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${shim}:${path}`;
		try {
			expect(
				await pushLfsObjects(
					r.repo,
					"ssh://git@github.com/octo/repo",
					"main",
					r.tip,
					r.base,
				),
			).toBeNull();
			expect(existsSync(marker)).toBe(false);
		} finally {
			process.env.PATH = path;
			rmSync(r.dir, { recursive: true, force: true });
		}
	});
});

describe("lfsEndpointPin (OTTR-1283, store nothing)", () => {
	/** A plain repo whose origin names `originUrl` (no clone: the pin reads git config). */
	const repoAt = async (originUrl: string): Promise<string> => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-lfs-pin-"));
		const repo = join(dir, "repo");
		await run(dir, "init", "-q", "-b", "main", repo);
		await run(repo, "remote", "add", "origin", originUrl);
		return repo;
	};
	/** The endpoint git-lfs resolves with the push command's own pins on the line. */
	const pushEnvEndpoint = async (
		repo: string,
		pins: readonly string[],
	): Promise<string> => {
		const proc = Bun.spawn(["git", ...pins, "lfs", "env"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, code] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error("git lfs env failed");
		return /^Endpoint=(.*)$/m.exec(out)?.[1] ?? "(none)";
	};
	/** The repo's persisted lfs.url, null when unset. */
	const lfsUrlConfig = async (repo: string): Promise<string | null> => {
		const proc = Bun.spawn(["git", "config", "lfs.url"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, code] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		return code === 0 ? out.trim() : null;
	};

	test("a bare origin pins the .git endpoint for the push and stores nothing", async () => {
		const repo = await repoAt("https://github.com/octo/repo");
		try {
			const pins = await lfsEndpointPin(repo, "https://github.com/octo/repo");
			expect(await pushEnvEndpoint(repo, pins)).toBe(
				"https://github.com/octo/repo.git/info/lfs (auth=none)",
			);
			expect(await lfsUrlConfig(repo)).toBeNull();
		} finally {
			rmSync(join(repo, ".."), { recursive: true, force: true });
		}
	});

	test("a .git origin pins the derived /info/lfs endpoint for the push", async () => {
		const repo = await repoAt("https://github.com/octo/repo.git");
		try {
			const pins = await lfsEndpointPin(
				repo,
				"https://github.com/octo/repo.git",
			);
			expect(await pushEnvEndpoint(repo, pins)).toBe(
				"https://github.com/octo/repo.git/info/lfs (auth=none)",
			);
		} finally {
			rmSync(join(repo, ".."), { recursive: true, force: true });
		}
	});

	test("an origin change between two pushes re-derives from the current origin", async () => {
		// Store nothing: the second push's pin comes from the origin as it is now, so
		// the endpoint can never go stale behind a stored value.
		const repo = await repoAt("https://github.com/octo/repo");
		try {
			const first = await lfsEndpointPin(repo, "https://github.com/octo/repo");
			expect(await pushEnvEndpoint(repo, first)).toBe(
				"https://github.com/octo/repo.git/info/lfs (auth=none)",
			);
			await run(
				repo,
				"remote",
				"set-url",
				"origin",
				"https://github.com/octo/other",
			);
			const second = await lfsEndpointPin(
				repo,
				"https://github.com/octo/other",
			);
			expect(await pushEnvEndpoint(repo, second)).toBe(
				"https://github.com/octo/other.git/info/lfs (auth=none)",
			);
			expect(await lfsUrlConfig(repo)).toBeNull();
		} finally {
			rmSync(join(repo, ".."), { recursive: true, force: true });
		}
	});

	test("an operator-set lfs.url skips the pins, and git-lfs follows it", async () => {
		const repo = await repoAt("https://github.com/octo/repo");
		try {
			await run(repo, "config", "lfs.url", "https://lfs.example.com/api/octo");
			const pins = await lfsEndpointPin(repo, "https://github.com/octo/repo");
			expect(pins).toEqual([]);
			expect(await pushEnvEndpoint(repo, pins)).toBe(
				"https://lfs.example.com/api/octo (auth=none)",
			);
		} finally {
			rmSync(join(repo, ".."), { recursive: true, force: true });
		}
	});

	test("an operator-set remote.origin.lfsurl skips the pins too (the mixed-key case)", async () => {
		// git-lfs 3.6.1 resolves lfs.url above remote.<remote>.lfsurl, so with both set
		// the push follows lfs.url: no pins at all, whatever they would have said.
		const repo = await repoAt("https://github.com/octo/repo");
		try {
			await run(
				repo,
				"config",
				"remote.origin.lfsurl",
				"https://github.com/octo/repo.git/info/lfs",
			);
			await run(
				repo,
				"config",
				"lfs.url",
				"https://github.com/octo/repo/info/lfs",
			);
			const pins = await lfsEndpointPin(repo, "https://github.com/octo/repo");
			expect(pins).toEqual([]);
			expect(await pushEnvEndpoint(repo, pins)).toBe(
				"https://github.com/octo/repo/info/lfs (auth=none)",
			);
		} finally {
			rmSync(join(repo, ".."), { recursive: true, force: true });
		}
	});

	test("a remote-scoped lfsurl without lfs.url is pinned for the call", async () => {
		// A URL-based git lfs push (the upload's first argument is the pinned URL, not
		// the remote name) ignores remote.<remote>.lfsurl entirely, so skipping the
		// pins for a remote-only value would leave the upload on the derived endpoint.
		// The board therefore carries the operator's remote-scoped value on the
		// command line for that call and stores nothing.
		const repo = await repoAt("https://github.com/octo/repo");
		try {
			await run(
				repo,
				"config",
				"remote.origin.lfsurl",
				"https://lfs.example.com/api/octo/repo",
			);
			const pins = await lfsEndpointPin(repo, "https://github.com/octo/repo");
			expect(pins).toEqual([
				"-c",
				"lfs.url=https://lfs.example.com/api/octo/repo",
				"-c",
				"lfs.https://lfs.example.com/api/octo/repo.locksverify=false",
			]);
			expect(await pushEnvEndpoint(repo, pins)).toBe(
				"https://lfs.example.com/api/octo/repo (auth=none)",
			);
		} finally {
			rmSync(join(repo, ".."), { recursive: true, force: true });
		}
	});

	test("a non-GitHub host keeps the unconditional pin: today's behavior", async () => {
		const repo = await repoAt("https://gitlab.com/g/sub");
		try {
			await run(repo, "config", "lfs.url", "https://lfs.example.com/api/g/sub");
			const pins = await lfsEndpointPin(repo, "https://gitlab.com/g/sub");
			expect(pins).not.toEqual([]);
			expect(await pushEnvEndpoint(repo, pins)).toBe(
				"https://gitlab.com/g/sub.git/info/lfs (auth=none)",
			);
		} finally {
			rmSync(join(repo, ".."), { recursive: true, force: true });
		}
	});

	test("an ssh origin gets no pins", async () => {
		const repo = await repoAt("git@github.com:octo/repo");
		try {
			expect(
				await lfsEndpointPin(repo, "ssh://git@github.com/octo/repo"),
			).toEqual([]);
		} finally {
			rmSync(join(repo, ".."), { recursive: true, force: true });
		}
	});

	test("the upload follows an origin change between two pushes, with nothing stored", async () => {
		const f = await fixture({ lfs: true, origin: "origin" });
		try {
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.url,
			);
			expect(r.status).toBe("pushed");
			// A second sprite so the second push's range carries a pointer again.
			const props = join(f.wt, "assets", "art", "props", "tree_oak");
			writeFileSync(join(props, "oak2.png"), "sprite-two-bytes");
			await run(f.wt, "add", "assets/art/props/tree_oak/oak2.png");
			await run(f.wt, ...id, "commit", "-q", "-m", "sprite two");
			await run(f.main, "merge", "-q", "--ff-only", "ott/x");
			// The fixture origin has no .git suffix ("origin"), so the second origin is
			// a sibling path on the same path-agnostic server; each push derives its
			// pin from the origin it is given.
			const otherUrl = `${f.url}-other`;
			await run(f.main, "remote", "set-url", "origin", otherUrl);
			const r2 = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				otherUrl,
			);
			expect(r2.status).toBe("pushed");
			expect(f.requests.filter((p) => p.includes("/objects/batch"))).toEqual([
				"POST /origin.git/info/lfs/objects/batch",
				"POST /origin-other.git/info/lfs/objects/batch",
			]);
			expect(await run(f.main, "config", "lfs.url").catch(() => "unset")).toBe(
				"unset",
			);
			expect(await run(f.bare, "rev-parse", "main")).toBe(
				await run(f.main, "rev-parse", "refs/heads/main"),
			);
		} finally {
			cleanup(f.dir, f.close);
		}
	}, 20_000);

	test("a remote-scoped lfsurl wins a URL-arg push without any stored config", async () => {
		// The blocker's probe, as a regression: a push whose first argument is the
		// pinned URL ignores remote.<remote>.lfsurl entirely and contacted the derived
		// <originUrl>.git/info/lfs instead of the mirror. The board therefore carries
		// the remote-scoped value on the upload's command line: the mirror receives the
		// object, the origin's own LFS API sees no batch, and nothing is stored. The
		// repo insteadOf entry keeps git-lfs's ref read of the github URL on the local
		// fixture, and the URL-scoped dead proxy turns a pre-fix batch to the real
		// github.com into an instant local refusal instead of a network contact.
		const f = await fixture({ lfs: true });
		const f2dir = mkdtempSync(join(tmpdir(), "ottr-lfs-mirror2-"));
		const f2bare = join(f2dir, "bare.git");
		await run(f2dir, "init", "-q", "--bare", "-b", "main", f2bare);
		const f2 = serveGitLfs(f2dir, f2bare);
		const dead = Bun.serve({ port: 0, fetch: () => new Response(null) });
		const deadPort = dead.port;
		dead.stop(true);
		try {
			await run(
				f.main,
				"config",
				`url.${f.url}.insteadOf`,
				"https://github.com/octo",
			);
			await run(f.main, "config", "remote.origin.lfsurl", `${f2.url}/info/lfs`);
			await run(
				f.main,
				"config",
				"http.https://github.com/.proxy",
				`http://127.0.0.1:${deadPort}`,
			);
			const tip = await run(f.main, "rev-parse", "refs/heads/main");
			const base = await run(f.main, "rev-parse", "origin/main");
			expect(
				await pushLfsObjects(
					f.main,
					"https://github.com/octo/repo",
					"main",
					tip,
					base,
				),
			).toBeNull();
			expect(readFileSync(f2.storeFile, "utf8")).toContain(f.oid);
			expect(f.requests.filter((p) => p.includes("/objects/batch"))).toEqual(
				[],
			);
			expect(await run(f.main, "config", "lfs.url").catch(() => "unset")).toBe(
				"unset",
			);
		} finally {
			cleanup(f.dir, f.close);
			cleanup(f2dir, f2.close);
		}
	}, 20_000);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { GIT_AUTH_ENV_RE, gitAuthEnv } from "./gitHosts.ts";
import { archReviewDue } from "./scheduler.ts";
import fc from "./test/properties.ts";
import {
	archReviewDelta,
	branchMergedOrGone,
	changedFiles,
	createWorktree,
	describeVersion,
	diffStat,
	diffText,
	fetchOriginBranch,
	GIT_AUTH_ENV_NAME,
	git,
	gitEnv,
	gitExe,
	githubRepoName,
	githubUrl,
	headVersion,
	httpsRemote,
	ignoreInMain,
	isClean,
	isIntegrated,
	mergeHoldMismatch,
	originRemoteUrl,
	parseKeptChoices,
	parseNumstat,
	planKeptFinish,
	quarantineUntracked,
	redact,
	redactingWriter,
	redactUrlCredentials,
	remoteUrl,
	removeWorktree,
	resetBranchTo,
	resolveTarget,
	serverMergePush,
	setGitSecrets,
	setNetworkGitAuth,
	setWorkerRoots,
	slugify,
	spawnPiped,
	statusFiles,
	statusRows,
	targetCommits,
	trackedFiles,
	unsavedWork,
	validateCopyPath,
	worktreeHusk,
	worktreeLinked,
} from "./worktree.ts";

describe("gitExe", () => {
	test("resolves scoop shims and wrapper installs to the native binary", () => {
		if (process.platform !== "win32") return;
		const root = mkdtempSync(join(tmpdir(), "ott-gitexe-"));
		try {
			const native = join(root, "v1", "mingw64", "bin", "git.exe");
			mkdirSync(join(root, "v1", "mingw64", "bin"), { recursive: true });
			mkdirSync(join(root, "v1", "bin"), { recursive: true });
			mkdirSync(join(root, "v1", "cmd"), { recursive: true });
			writeFileSync(native, "");
			writeFileSync(join(root, "v1", "cmd", "git.exe"), "");
			writeFileSync(join(root, "v1", "bin", "git.exe"), "");
			// scoop's `current` is a junction to the versioned install; resolve through it.
			symlinkSync(join(root, "v1"), join(root, "current"), "junction");
			writeFileSync(
				join(root, "git.shim"),
				`path = ${join(root, "current", "cmd", "git.exe")}\nexe = git.exe\n`,
			);
			// shim -> current\cmd\git.exe -> the versioned install's mingw64\bin\git.exe.
			// Compare canonically: gitExe resolves junctions/short paths, and the fixture
			// root may itself be reached through a junction or 8.3 short TEMP (CI).
			expect(gitExe(join(root, "git.exe"))).toBe(realpathSync(native));
			// Already at the native binary: stays there.
			expect(gitExe(native)).toBe(realpathSync(native));
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("leaves unknown layouts untouched and falls back to PATH lookup", () => {
		expect(gitExe(null)).toBe("git");
		if (process.platform !== "win32") return;
		expect(gitExe("Q:\\nowhere\\git.exe")).toBe("Q:\\nowhere\\git.exe");
	});
});

describe("git output redaction", () => {
	test("network git output hides stored tokens; local git output stays raw", async () => {
		const secret = "glpat-echoed-secret-000";
		setGitSecrets([secret]);
		try {
			// git echoes the missing remote path, token included, on stderr.
			const net = await git(
				["ls-remote", "--", `/nonexistent/${secret}`],
				tmpdir(),
			);
			expect(net.code).not.toBe(0);
			expect(net.stderr).not.toContain(secret);
			expect(net.stderr).toContain("[REDACTED]");
			const local = await git(
				["-C", `/nonexistent/${secret}`, "status"],
				tmpdir(),
			);
			expect(local.stderr).toContain(secret);
		} finally {
			setGitSecrets([]);
		}
	});
});

describe("git output redaction lifetime", () => {
	test("a token rotated or removed while the call runs stays redacted in its output", async () => {
		const secret = "glpat-in-flight-0000";
		setGitSecrets([secret]);
		try {
			const call = git(["ls-remote", "--", `/nonexistent/${secret}`], tmpdir());
			setGitSecrets(["glpat-replacement-000"]);
			const r = await call;
			expect(r.stderr).not.toContain(secret);
			expect(r.stderr).toContain("[REDACTED]");
		} finally {
			setGitSecrets([]);
		}
	});

	test("a token the call carries is redacted even when it is not stored", async () => {
		const secret = "glpat-carried-only-00";
		const r = await git(
			["ls-remote", "--", `/nonexistent/${secret}`],
			tmpdir(),
			30_000,
			{ OTTR_GIT_TOKEN_0: secret },
		);
		expect(r.stderr).not.toContain(secret);
		expect(r.stderr).toContain("[REDACTED]");
	});
});

describe("redactUrlCredentials", () => {
	test("URL userinfo becomes [REDACTED]; hosts without userinfo stay", () => {
		expect(
			redactUrlCredentials(
				"fatal: unable to access 'https://user:tok@github.com/o/r.git/': The requested URL returned error: 403",
			),
		).toBe(
			"fatal: unable to access 'https://[REDACTED]@github.com/o/r.git/': The requested URL returned error: 403",
		);
		expect(
			redactUrlCredentials(
				"error: failed to push some refs to 'https://github.com/o/r.git'",
			),
		).toBe("error: failed to push some refs to 'https://github.com/o/r.git'");
		// A username is userinfo too: redacting it cannot leak, so the safe side wins.
		expect(redactUrlCredentials("ssh://git@host.example/o/r.git")).toBe(
			"ssh://[REDACTED]@host.example/o/r.git",
		);
	});
});

describe("serverMergePush", () => {
	// Fixtures use their own spawn, never git() under test.
	const run = (cwd: string, ...args: string[]): string => {
		const r = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.toString().trim();
	};
	/** A bare origin (a non-GitHub file remote), a clone of it, and a worktree whose branch the
	 * clone merged into its local main. */
	const fixture = (mergeIt = true) => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-smp-"));
		const bare = join(dir, "origin.git");
		run(dir, "init", "-q", "--bare", "-b", "main", bare);
		const main = join(dir, "main");
		run(dir, "clone", "-q", bare, main);
		const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
		run(main, ...id, "commit", "-q", "--allow-empty", "-m", "base");
		run(main, "push", "-q", "origin", "main");
		const wt = join(dir, "wt");
		run(main, "worktree", "add", "-q", "-b", "ott/x", wt);
		run(wt, ...id, "commit", "-q", "--allow-empty", "-m", "work");
		if (mergeIt) run(main, "merge", "-q", "--ff-only", "ott/x");
		return { dir, bare, main, wt };
	};

	test("pushes the local main (refs/heads, not the origin/main alias) of a normal clone", async () => {
		const f = fixture();
		try {
			const local = run(f.main, "rev-parse", "refs/heads/main");
			expect(run(f.bare, "rev-parse", "main")).not.toBe(local);
			expect(
				(
					await serverMergePush(
						f.main,
						f.wt,
						"origin/main",
						"ott/x",
						null,
						f.bare,
					)
				).status,
			).toBe("pushed");
			expect(run(f.bare, "rev-parse", "main")).toBe(local);
			// Already on origin: a second call has nothing to do.
			expect(
				await serverMergePush(
					f.main,
					f.wt,
					"origin/main",
					"ott/x",
					null,
					f.bare,
				),
			).toEqual({
				status: "skipped",
			});
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("pushes to origin only, whatever other remotes (a GitHub upstream) exist", async () => {
		const f = fixture();
		try {
			const up = join(f.dir, "upstream.git");
			run(f.dir, "init", "-q", "--bare", "-b", "main", up);
			run(f.main, "remote", "add", "upstream", up);
			expect(
				(
					await serverMergePush(
						f.main,
						f.wt,
						"origin/main",
						"ott/x",
						null,
						f.bare,
					)
				).status,
			).toBe("pushed");
			expect(run(f.bare, "rev-parse", "main")).toBe(
				run(f.main, "rev-parse", "refs/heads/main"),
			);
			expect(
				Bun.spawnSync(["git", "rev-parse", "--verify", "main"], { cwd: up })
					.exitCode,
			).not.toBe(0);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("no push without proof of the local merge", async () => {
		const f = fixture(false);
		try {
			const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
			run(f.main, ...id, "commit", "-q", "--allow-empty", "-m", "other");
			const before = run(f.bare, "rev-parse", "main");
			expect(
				await serverMergePush(
					f.main,
					f.wt,
					"origin/main",
					"ott/x",
					null,
					f.bare,
				),
			).toEqual({
				status: "skipped",
			});
			expect(run(f.bare, "rev-parse", "main")).toBe(before);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a push origin moved during the merge is rejected, and fetchOriginBranch catches up", async () => {
		const f = fixture();
		try {
			// Another writer lands a commit on origin while the merge turn runs: the local
			// tracking ref still names the old tip, so the push is a rejected non-fast-forward.
			const twin = join(f.dir, "twin");
			run(f.dir, "clone", "-q", f.bare, twin);
			const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
			run(twin, ...id, "commit", "-q", "--allow-empty", "-m", "another writer");
			run(twin, "push", "-q", "origin", "main");
			const moved = run(f.bare, "rev-parse", "main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.bare,
			);
			if (r.status === "rejected") {
				// OTTR-465: needsReason keeps the reason lines; the fast-forward hint lives in
				// the full output the card log keeps.
				expect(r.error).toContain("! [rejected]");
				expect(r.error).toContain("(fetch first)");
				expect(r.error).toContain("failed to push some refs");
				expect(r.output).toContain("Note about fast-forwards");
			} else throw new Error(`expected a rejected push, got ${r.status}`);
			// The board fetches origin with its own credentials; the tracking ref catches up,
			// so the queued rebase turn rebases onto the moved tip.
			expect(await fetchOriginBranch(f.main, "main", f.bare)).toBeNull();
			expect(run(f.main, "rev-parse", "refs/remotes/origin/main")).toBe(moved);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a hold-approved push whose lease no longer matches classifies as rejected too", async () => {
		const f = fixture();
		try {
			const twin = join(f.dir, "twin");
			run(f.dir, "clone", "-q", f.bare, twin);
			const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
			run(twin, ...id, "commit", "-q", "--allow-empty", "-m", "another writer");
			run(twin, "push", "-q", "origin", "main");
			// The audited tip the hold gate fetched: origin's tip at approval time (the
			// tracking ref, which only the board's own fetches and pushes move).
			const leaseTip = run(f.main, "rev-parse", "refs/remotes/origin/main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				leaseTip,
				f.bare,
			);
			// The remote rejected the lease; the turn refuses to retry a held push.
			if (r.status === "rejected")
				expect(r.error).toContain("failed to push some refs");
			else throw new Error(`expected a rejected lease push, got ${r.status}`);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a removed worktree proves the merge by its branch, and a removed branch by main ahead of origin", async () => {
		const f = fixture();
		try {
			run(f.main, "worktree", "remove", f.wt);
			expect(
				(
					await serverMergePush(
						f.main,
						f.wt,
						"origin/main",
						"ott/x",
						null,
						f.bare,
					)
				).status,
			).toBe("pushed");
			const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
			run(f.main, ...id, "commit", "-q", "--allow-empty", "-m", "next");
			run(f.main, "branch", "-q", "-D", "ott/x");
			expect(
				(
					await serverMergePush(
						f.main,
						f.wt,
						"origin/main",
						"ott/x",
						null,
						f.bare,
					)
				).status,
			).toBe("pushed");
			expect(run(f.bare, "rev-parse", "main")).toBe(
				run(f.main, "rev-parse", "refs/heads/main"),
			);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a removed worktree whose kept branch is not merged gets no push", async () => {
		const f = fixture(false);
		try {
			const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
			run(f.main, ...id, "commit", "-q", "--allow-empty", "-m", "other");
			run(f.main, "worktree", "remove", f.wt);
			const before = run(f.bare, "rev-parse", "main");
			expect(
				await serverMergePush(
					f.main,
					f.wt,
					"origin/main",
					"ott/x",
					null,
					f.bare,
				),
			).toEqual({
				status: "skipped",
			});
			expect(run(f.bare, "rev-parse", "main")).toBe(before);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a failed push reports git's last stderr line", async () => {
		const f = fixture();
		try {
			// The pin itself is broken (a gone path): the planted origin config is ignored,
			// so the failure must come from the pinned push, not from a name lookup.
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				join(f.dir, "gone.git"),
			);
			expect(r.status).toBe("failed");
			expect("error" in r && r.error.length > 0).toBe(true);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a failed push keeps every reason line and git's full output", async () => {
		const f = fixture();
		try {
			// A pre-receive hook stands in for the remote's refusal: its stderr reaches the
			// client as "remote:" lines, and git adds the rejected line and the error line.
			writeFileSync(
				join(f.bare, "hooks", "pre-receive"),
				"#!/bin/sh\necho 'remote: Permission to Skare69/agent-data.git denied to ottr-board.'\necho 'remote: no App installation covers this repo.'\nexit 1\n",
				{ mode: 0o755 },
			);
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.bare,
			);
			if (r.status !== "failed")
				throw new Error(`expected a failed push, got ${r.status}`);
			expect(r.error).toContain(
				"remote: Permission to Skare69/agent-data.git denied to ottr-board.",
			);
			expect(r.error).toContain("error: failed to push some refs");
			expect(r.error).not.toContain("hint:");
			expect(r.output).toContain(
				"remote: no App installation covers this repo.",
			);
			expect(r.output).toContain("error: failed to push some refs");
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a hold-audited push pins the remote to the audited tip", async () => {
		const f = fixture();
		try {
			const tip = run(f.bare, "rev-parse", "main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				tip,
				f.bare,
			);
			expect(r.status).toBe("pushed");
			expect(run(f.bare, "rev-parse", "main")).toBe(
				run(f.main, "rev-parse", "refs/heads/main"),
			);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a push whose lease does not match the remote is rejected", async () => {
		const f = fixture();
		try {
			const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
			const stale = run(f.bare, "rev-parse", "main");
			// Move the real remote past the audited tip without moving the local target.
			run(f.main, "checkout", "-q", "--detach", "origin/main");
			run(f.main, ...id, "commit", "-q", "--allow-empty", "-m", "later");
			run(f.main, "push", "-q", "origin", "HEAD:main");
			run(f.main, "checkout", "-q", "main");
			const before = run(f.bare, "rev-parse", "main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				stale,
				f.bare,
			);
			// OTTR-394: the lease rejection classifies as rejected, so the turn can tell it
			// from other failures — and refuses to retry a held push by the hold tip.
			expect(r.status).toBe("rejected");
			expect(run(f.bare, "rev-parse", "main")).toBe(before);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a push whose lease tip is not contained in the local target fails", async () => {
		const f = fixture();
		try {
			const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
			writeFileSync(join(f.wt, "late.txt"), "late");
			run(f.wt, ...id, "add", ".");
			run(f.wt, ...id, "commit", "-qm", "late");
			const before = run(f.bare, "rev-parse", "main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				run(f.wt, "rev-parse", "HEAD"),
				f.bare,
			);
			expect(r.status).toBe("failed");
			expect(r.status === "failed" && r.error.includes("not contained")).toBe(
				true,
			);
			expect(run(f.bare, "rev-parse", "main")).toBe(before);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("mergeHoldMismatch", () => {
	// Fixtures use their own spawn, never git() under test.
	const run = (cwd: string, ...args: string[]): string => {
		const r = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.toString().trim();
	};
	const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
	const mismatch = async (
		f: { main: string; base: string; approvedHead: string; bare: string },
		approvedHead = f.approvedHead,
	) => mergeHoldMismatch(f.main, "origin/main", f.base, approvedHead, f.bare);
	/** Origin (bare), a clone, and a worktree whose branch ott/x holds two file commits on top of
	 * base. approvedHead is the branch tip the admin approved; origin then moves one commit (O1,
	 * which rewrites o.txt — a file the branch never touches, so rebases stay clean), so a merge
	 * turn must rebase onto a moved target. */
	const fixture = () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-mhm-"));
		const bare = join(dir, "origin.git");
		run(dir, "init", "-q", "--bare", "-b", "main", bare);
		const main = join(dir, "main");
		run(dir, "clone", "-q", bare, main);
		writeFileSync(join(main, "o.txt"), "o");
		run(main, ...id, "add", ".");
		run(main, ...id, "commit", "-qm", "base");
		run(main, "push", "-q", "origin", "main");
		const wt = join(dir, "wt");
		run(main, "worktree", "add", "-q", "-b", "ott/x", wt);
		for (const [name, text] of [
			["p1.txt", "1"],
			["p2.txt", "2"],
		] as const) {
			writeFileSync(join(wt, name), text);
			run(wt, ...id, "add", ".");
			run(wt, ...id, "commit", "-qm", name);
		}
		const base = run(main, "rev-parse", "refs/heads/main");
		const approvedHead = run(wt, "rev-parse", "HEAD");
		writeFileSync(join(main, "o.txt"), "O1");
		run(main, ...id, "commit", "-qam", "O1");
		run(main, "push", "-q", "origin", "main");
		return { dir, bare, main, wt, base, approvedHead };
	};

	test("a rebase of exactly the approved changes still pushes (no mismatch)", async () => {
		const f = fixture();
		try {
			run(f.wt, ...id, "rebase", "-q", "origin/main");
			run(f.main, "merge", "-q", "--ff-only", "ott/x");
			const r = await mismatch(f);
			expect(r.mismatch).toBe(false);
			// The reviewer sees the push set the gate measured.
			expect(r.pushDiff).toContain("p1.txt");
			expect(r.pushDiff).not.toContain("evil");
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a clean no-ff merge of exactly the approved changes pushes (no mismatch)", async () => {
		const f = fixture();
		try {
			run(f.wt, ...id, "rebase", "-q", "origin/main");
			run(f.main, ...id, "merge", "-q", "--no-ff", "--no-edit", "ott/x");
			expect((await mismatch(f)).mismatch).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a merge turn that adds a commit beyond the approved head mismatches", async () => {
		const f = fixture();
		try {
			run(f.wt, ...id, "rebase", "-q", "origin/main");
			writeFileSync(join(f.wt, "evil.txt"), "x");
			run(f.wt, ...id, "add", ".");
			run(f.wt, ...id, "commit", "-qm", "EVIL");
			run(f.main, "merge", "-q", "--ff-only", "ott/x");
			const r = await mismatch(f);
			expect(r.mismatch).toBe(true);
			expect(r.pushDiff).toContain("evil.txt");
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a change smuggled inside a merge commit mismatches", async () => {
		const f = fixture();
		try {
			run(f.wt, ...id, "rebase", "-q", "origin/main");
			run(f.main, ...id, "merge", "-q", "--no-ff", "--no-edit", "ott/x");
			writeFileSync(join(f.main, "smuggle.txt"), "x");
			run(f.main, ...id, "add", ".");
			run(f.main, ...id, "commit", "-q", "--amend", "--no-edit");
			expect((await mismatch(f)).mismatch).toBe(true);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a merge that keeps the branch's stale copy of a file origin changed mismatches", async () => {
		const f = fixture();
		try {
			// No rebase: the agent merges the stale branch and revives the branch's pre-O1 copy
			// of o.txt inside the merge commit. The merge's combined diff is empty there (the
			// result equals one parent), so only the tree diff against the target sees the
			// reverted origin change.
			run(f.main, ...id, "merge", "--no-ff", "--no-commit", "ott/x");
			run(f.main, "checkout", "ott/x", "--", "o.txt");
			run(f.main, ...id, "commit", "-qm", "merge");
			const r = await mismatch(f);
			expect(r.mismatch).toBe(true);
			expect(r.pushDiff).toContain("o.txt");
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a rigged remote-tracking ref cannot hide smuggled content", async () => {
		const f = fixture();
		try {
			// The merge agent runs git in the main checkout and can rewrite any local ref.
			// It parents the smuggled tree on the real origin tip (a fast-forward for the
			// push) and aims the remote-tracking ref at a synthetic commit that carries the
			// smuggled file but lacks the approved paths, so a ref-to-ref diff would read
			// exactly like the approval. The gate must re-fetch from origin instead.
			run(f.main, "checkout", "-q", "--detach", "origin/main");
			writeFileSync(join(f.main, "p1.txt"), "1");
			writeFileSync(join(f.main, "p2.txt"), "2");
			writeFileSync(join(f.main, "evil.txt"), "EVIL");
			run(f.main, ...id, "add", ".");
			run(f.main, ...id, "commit", "-qm", "evil merge");
			run(f.main, ...id, "rm", "-q", "p1.txt", "p2.txt");
			run(f.main, ...id, "commit", "-qm", "anchor");
			run(
				f.main,
				"update-ref",
				"refs/remotes/origin/main",
				run(f.main, "rev-parse", "HEAD"),
			);
			run(
				f.main,
				"update-ref",
				"refs/heads/main",
				run(f.main, "rev-parse", "HEAD~1"),
			);
			const r = await mismatch(f);
			expect(r.mismatch).toBe(true);
			expect(r.pushDiff).toContain("evil.txt");
			// The gate audited the real tip and hands it to the push as the lease anchor.
			expect(r.auditedTip).toBe(run(f.bare, "rev-parse", "main"));
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a rigged fetch refspec cannot hide smuggled content", async () => {
		const f = fixture();
		try {
			// The tampered config is the fetch refspec this time: the fetch the gate runs is
			// redirected into a namespace it plants, while refs/remotes/origin/main keeps a
			// rigged anchor. The gate-owned refspec must ignore the configured one, and the
			// audited tip it returns pins the push to the real remote.
			run(f.main, "checkout", "-q", "--detach", "origin/main");
			writeFileSync(join(f.main, "p1.txt"), "1");
			writeFileSync(join(f.main, "p2.txt"), "2");
			writeFileSync(join(f.main, "evil.txt"), "EVIL");
			run(f.main, ...id, "add", ".");
			run(f.main, ...id, "commit", "-qm", "evil merge");
			run(f.main, ...id, "rm", "-q", "p1.txt", "p2.txt");
			run(f.main, ...id, "commit", "-qm", "anchor");
			// HEAD is the anchor; the smuggled tree sits one commit below.
			run(
				f.main,
				"update-ref",
				"refs/remotes/origin/main",
				run(f.main, "rev-parse", "HEAD"),
			);
			run(
				f.main,
				"update-ref",
				"refs/heads/main",
				run(f.main, "rev-parse", "HEAD~1"),
			);
			run(
				f.main,
				"config",
				"remote.origin.fetch",
				"+refs/heads/*:refs/remotes/rigged/*",
			);
			const r = await mismatch(f);
			expect(r.mismatch).toBe(true);
			expect(r.pushDiff).toContain("evil.txt");
			expect(r.auditedTip).toBe(run(f.bare, "rev-parse", "main"));
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("an unresolvable approved head fails closed", async () => {
		const f = fixture();
		try {
			run(f.wt, ...id, "rebase", "-q", "origin/main");
			run(f.main, "merge", "-q", "--ff-only", "ott/x");
			expect((await mismatch(f, "0".repeat(40))).mismatch).toBe(true);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a gitlink bump hidden by planted diff.ignoreSubmodules mismatches", async () => {
		const f = fixture();
		try {
			// The merge agent can rewrite the repo's config: with diff.ignoreSubmodules=all the
			// porcelain effect diff drops committed gitlink changes, so a submodule bump beyond
			// the approval would otherwise leave both texts equal. The gate's diff must pin
			// --ignore-submodules=none, which overrides that config key.
			run(f.wt, "config", "diff.ignoreSubmodules", "all");
			run(f.wt, ...id, "rebase", "-q", "origin/main");
			const sub = join(f.dir, "sub");
			run(f.dir, "init", "-q", sub);
			writeFileSync(join(sub, "s.txt"), "1");
			run(sub, ...id, "add", ".");
			run(sub, ...id, "commit", "-qm", "s1");
			const bump = run(sub, "rev-parse", "HEAD");
			run(f.wt, "update-index", "--add", "--cacheinfo", `160000,${bump},sub`);
			run(f.wt, ...id, "commit", "-qm", "bump sub");
			run(f.main, "merge", "-q", "--ff-only", "ott/x");
			const r = await mismatch(f);
			expect(r.mismatch).toBe(true);
			expect(r.pushDiff).toContain("sub");
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("pinned origin URL (OTTR-348)", () => {
	// Fixtures use their own spawn, never git() under test.
	const run = (cwd: string, ...args: string[]): string => {
		const r = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.toString().trim();
	};
	const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
	/** A bare origin with base+work merged on main, a clone, a merged worktree branch — and
	 * an evil bare whose pre-receive hook writes a marker when it runs, with the clone's
	 * origin name re-aimed at it (url and pushurl), the work-turn plant of the audit. */
	const fixture = () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-pin-"));
		const bare = join(dir, "origin.git");
		run(dir, "init", "-q", "--bare", "-b", "main", bare);
		const evil = join(dir, "evil.git");
		run(dir, "init", "-q", "--bare", "-b", "main", evil);
		const marker = join(dir, "planted.pre-receive");
		writeFileSync(
			join(evil, "hooks", "pre-receive"),
			`#!/bin/sh\ntouch '${marker}'\n`,
		);
		chmodSync(join(evil, "hooks", "pre-receive"), 0o755);
		const main = join(dir, "main");
		run(dir, "clone", "-q", bare, main);
		run(main, ...id, "commit", "-q", "--allow-empty", "-m", "base");
		run(main, "push", "-q", "origin", "main");
		const wt = join(dir, "wt");
		run(main, "worktree", "add", "-q", "-b", "ott/x", wt);
		run(wt, ...id, "commit", "-q", "--allow-empty", "-m", "work");
		run(main, "merge", "-q", "--ff-only", "ott/x");
		run(main, "remote", "set-url", "origin", `file://${evil}`);
		run(main, "config", "remote.origin.pushurl", `file://${evil}`);
		return { dir, bare, evil, marker, main, wt };
	};

	test("originRemoteUrl reads the planted origin verbatim for the pin", async () => {
		const f = fixture();
		try {
			expect(await originRemoteUrl(f.main)).toBe(`file://${f.evil}`);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a merge push without a pin fails closed instead of pushing by remote name", async () => {
		const f = fixture();
		try {
			const r = await serverMergePush(f.main, f.wt, "origin/main", "ott/x");
			expect(r.status).toBe("failed");
			expect(r.status === "failed" && r.error.includes("pinned")).toBe(true);
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a planted file:// origin never receives the merge push; the pinned bare does", async () => {
		const f = fixture();
		try {
			// Control: the plant is live — plain git runs the evil pre-receive.
			run(f.main, "push", "-q", "origin", "main:planted");
			expect(existsSync(f.marker)).toBe(true);
			rmSync(f.marker);
			const local = run(f.main, "rev-parse", "refs/heads/main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.bare,
			);
			expect(r.status).toBe("pushed");
			expect(run(f.bare, "rev-parse", "main")).toBe(local);
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("the gate fetch audits the pinned bare, not a planted file:// origin", async () => {
		const f = fixture();
		try {
			const base = run(f.main, "rev-parse", "main~1");
			const approvedHead = run(f.main, "rev-parse", "refs/heads/ott/x");
			const m = await mergeHoldMismatch(
				f.main,
				"origin/main",
				base,
				approvedHead,
				f.bare,
			);
			expect(m.mismatch).toBe(false);
			expect(m.auditedTip).toBe(run(f.bare, "rev-parse", "main"));
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("an url.<…>.insteadOf entry matching the pin fails the push and the gate closed", async () => {
		const f = fixture();
		try {
			// The rewrite turns the pinned bare into the evil repo; the guard must refuse
			// before git runs, so the hook never fires.
			run(f.main, "config", `url.${f.evil}.insteadOf`, f.bare);
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.bare,
			);
			expect(r.status).toBe("failed");
			expect(r.status === "failed" && r.error.includes("insteadOf")).toBe(true);
			const base = run(f.main, "rev-parse", "main~1");
			const approvedHead = run(f.main, "rev-parse", "refs/heads/ott/x");
			const m = await mergeHoldMismatch(
				f.main,
				"origin/main",
				base,
				approvedHead,
				f.bare,
			);
			expect(m.mismatch).toBe(true);
			expect(m.auditedTip).toBeNull();
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("an url.<…>.pushInsteadOf entry matching the pin fails the push closed", async () => {
		const f = fixture();
		try {
			// pushInsteadOf bends pushes only, so an insteadOf-only scan misses it: the
			// rewrite turns the pinned bare into the evil repo at push time.
			run(f.main, "config", `url.${f.evil}.pushInsteadOf`, f.bare);
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.bare,
			);
			expect(r.status).toBe("failed");
			expect(r.status === "failed" && r.error.includes("insteadOf")).toBe(true);
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a pin that is a git option, not a URL, fails closed", async () => {
		const f = fixture();
		try {
			// A leading `-` would parse as a git option and could drop the repository
			// argument, falling back to the planted default remote.
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				"--upload-pack=evil:x",
			);
			expect(r.status).toBe("failed");
			expect(r.status === "failed" && r.error.includes("not a URL")).toBe(true);
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a local pin under a worker-writable root fails closed; without roots it works", async () => {
		const f = fixture();
		try {
			setWorkerRoots([f.dir]);
			try {
				const r = await serverMergePush(
					f.main,
					f.wt,
					"origin/main",
					"ott/x",
					null,
					f.bare,
				);
				expect(r.status).toBe("failed");
				expect(
					r.status === "failed" && r.error.includes("worker-writable"),
				).toBe(true);
				expect(existsSync(f.marker)).toBe(false);
			} finally {
				setWorkerRoots([]);
			}
			const ok = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.bare,
			);
			expect(ok.status).toBe("pushed");
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a relative local pin with a slash before its colon gets the root check", async () => {
		const f = fixture();
		try {
			// git reads ./x:y.git as a local path (first slash before the first colon),
			// so the guard must too: under a worker root it is refused before git runs.
			setWorkerRoots([f.dir]);
			try {
				const r = await serverMergePush(
					f.main,
					f.wt,
					"origin/main",
					"ott/x",
					null,
					"./x:y.git",
				);
				expect(r.status).toBe("failed");
				expect(
					r.status === "failed" && r.error.includes("worker-writable"),
				).toBe(true);
				expect(existsSync(f.marker)).toBe(false);
			} finally {
				setWorkerRoots([]);
			}
			// The same reading without a boundary: a relative local pin resolves against
			// the repo (the cwd git runs in) and pushes the bare next to it.
			const ok = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				"../origin.git",
			);
			expect(ok.status).toBe("pushed");
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("every file:// authority form gets the worker-root check", async () => {
		const f = fixture();
		try {
			// Current git ignores a file:// URL's authority and serves the path after the
			// first slash locally, so each of these names f.evil once resolved.
			setWorkerRoots([f.dir]);
			try {
				for (const pin of [
					`file://${f.evil}`,
					`file://nowhere${f.evil}`,
					`file://localhost:9${f.evil}`,
					// No raw slash: git url-decodes the whole remainder as the path.
					`file://${encodeURIComponent(f.evil)}`,
				]) {
					const r = await serverMergePush(
						f.main,
						f.wt,
						"origin/main",
						"ott/x",
						null,
						pin,
					);
					expect(r.status).toBe("failed");
					expect(
						r.status === "failed" && r.error.includes("worker-writable"),
					).toBe(true);
				}
				expect(existsSync(f.marker)).toBe(false);
			} finally {
				setWorkerRoots([]);
			}
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("an upstream the pin does not cover skips the fetch instead of a name fetch", async () => {
		const f = fixture();
		try {
			// A planted fork remote whose url names the evil bare: a name fetch would run
			// its upload-pack in the server's git, so the board skips with a warning.
			const evil = join(f.dir, "fork-evil.git");
			// A clone may carry origin/HEAD → main (git ≥ 2.48 sets it even for an unborn
			// remote HEAD), which would win the default-branch ladder and mask the fork
			// upstream; drop it when present so the fork path stays reachable. Older git
			// leaves none for a clone of an empty bare.
			try {
				run(f.main, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
			} catch {
				// no origin/HEAD to drop
			}
			run(f.main, "remote", "add", "fork", `file://${evil}`);
			run(f.main, "config", "branch.main.remote", "fork");
			run(f.main, "config", "branch.main.merge", "refs/heads/main");
			// A stale tracking ref resolves, so the call returns the skip warning instead of
			// the missing-upstream error.
			run(
				f.main,
				"update-ref",
				"refs/remotes/fork/main",
				run(f.main, "rev-parse", "main"),
			);
			const r = await resolveTarget(f.main, true, f.bare);
			expect(r.target).toBe("fork/main");
			expect(r.warning).toContain("the board fetches only the pinned origin");
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("the pinned target fetch ignores a planted origin URL and rigged refspecs", async () => {
		const f = fixture();
		try {
			// The real bare's main moves on without the clone knowing.
			const b = run(
				f.bare,
				...id,
				"commit-tree",
				"-p",
				"main",
				"-m",
				"b",
				"main^{tree}",
			);
			run(f.bare, "update-ref", "refs/heads/main", b);
			// A name fetch would follow this rigged refspec; the pinned fetch must not.
			run(
				f.main,
				"config",
				"remote.origin.fetch",
				"+refs/heads/*:refs/remotes/rigged/*",
			);
			expect(await resolveTarget(f.main, true, f.bare)).toEqual({
				target: "origin/main",
				sha: b,
				warning: null,
			});
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("resetBranchTo", () => {
	// Fixtures use their own spawn, never git() under test.
	const run = (cwd: string, ...args: string[]): string => {
		const r = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.toString().trim();
	};
	const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
	/** A clone whose pushed main holds a.txt/b.txt; tip rewrites a.txt and adds p1.txt
	 * unpushed. The fixture leaves main reset back at the pushed commit, as a park's
	 * pre-reset state. */
	const fixture = () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-rbt-"));
		const bare = join(dir, "origin.git");
		run(dir, "init", "-q", "--bare", "-b", "main", bare);
		const main = join(dir, "main");
		run(dir, "clone", "-q", bare, main);
		writeFileSync(join(main, "a.txt"), "a");
		writeFileSync(join(main, "b.txt"), "b");
		run(main, ...id, "add", ".");
		run(main, ...id, "commit", "-qm", "pushed");
		run(main, "push", "-q", "origin", "main");
		writeFileSync(join(main, "p1.txt"), "p1");
		writeFileSync(join(main, "a.txt"), "A");
		run(main, ...id, "add", ".");
		run(main, ...id, "commit", "-qm", "held");
		const tip = run(main, "rev-parse", "main");
		run(main, "reset", "-q", "--hard", "origin/main");
		return { dir, main, tip };
	};

	test("moves the checked-out branch back to the given tip", async () => {
		const f = fixture();
		try {
			expect(run(f.main, "rev-parse", "refs/heads/main")).not.toBe(f.tip);
			expect(await resetBranchTo(f.main, "main", f.tip)).toBe(true);
			expect(run(f.main, "rev-parse", "refs/heads/main")).toBe(f.tip);
			expect(run(f.main, "status", "--porcelain")).toBe("");
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("keeps uncommitted edits to files the move does not touch", async () => {
		const f = fixture();
		try {
			writeFileSync(join(f.main, "b.txt"), "edited");
			expect(await resetBranchTo(f.main, "main", f.tip)).toBe(true);
			expect(readFileSync(join(f.main, "b.txt"), "utf8")).toBe("edited");
			expect(run(f.main, "rev-parse", "refs/heads/main")).toBe(f.tip);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("refuses when the move would overwrite an uncommitted edit", async () => {
		const f = fixture();
		try {
			expect(await resetBranchTo(f.main, "main", f.tip)).toBe(true);
			// a.txt differs between the two tips, so the dirty edit blocks the move back.
			writeFileSync(join(f.main, "a.txt"), "hacked");
			const pushed = run(f.main, "rev-parse", "origin/main");
			expect(await resetBranchTo(f.main, "main", pushed)).toBe(false);
			expect(run(f.main, "rev-parse", "refs/heads/main")).toBe(f.tip);
			expect(readFileSync(join(f.main, "a.txt"), "utf8")).toBe("hacked");
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("another checked-out branch refuses the move", async () => {
		const f = fixture();
		try {
			run(f.main, "checkout", "-q", "-b", "side");
			expect(await resetBranchTo(f.main, "main", f.tip)).toBe(false);
			expect(run(f.main, "rev-parse", "refs/heads/main")).not.toBe(f.tip);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("redactingWriter", () => {
	test("property: any split of the input gives the same output as one redact()", () => {
		const alpha = fc.constantFrom("a", "b", "R", "E", "D", "[", "]", "-");
		const word = fc
			.array(alpha, { minLength: 1, maxLength: 6 })
			.map((a) => a.join(""));
		fc.assert(
			fc.property(
				fc.array(word, { minLength: 1, maxLength: 3 }),
				fc.array(word, { maxLength: 12 }),
				(secrets, chunks) => {
					let out = "";
					const w = redactingWriter(
						(s) => {
							out += s;
						},
						() => secrets,
					);
					for (const c of chunks) w.write(c);
					w.flush();
					expect(out).toBe(redact(chunks.join(""), secrets));
				},
			),
		);
	});

	test("a token split across two writes is held back, then redacted whole", () => {
		const secret = "glpat-held-0000";
		let out = "";
		const w = redactingWriter(
			(s) => {
				out += s;
			},
			() => [secret],
		);
		w.write(`x ${secret.slice(0, 6)}`);
		expect(out).not.toContain("glpat-");
		w.write(`${secret.slice(6)} y`);
		w.flush();
		expect(out).toBe("x [REDACTED] y");
	});
});

describe("validateCopyPath", () => {
	test("accepts relative repo paths", () => {
		for (const p of [
			"AGENTS.md",
			"scripts/release.mjs",
			".omp/hooks/pre/guard.js",
			"./scripts/x.mjs",
		]) {
			expect(validateCopyPath(p)).toBeNull();
		}
	});

	test("rejects empty, traversal, absolute, git, env, NUL", () => {
		for (const p of [
			"",
			"   ",
			"../x",
			"a/../../b",
			"C:/x",
			"C:\\x",
			"/etc/passwd",
			"\\\\server\\share",
			".env",
			".env.local",
			"config/.ENV.production",
			".git/config",
			"a\u0000b",
		]) {
			expect(typeof validateCopyPath(p)).toBe("string");
		}
	});
});

describe("slugify", () => {
	test("basic", () => {
		expect(slugify("Fix the Login bug!")).toBe("fix-the-login-bug");
	});

	test("cuts to 32 chars without trailing dash", () => {
		const long =
			"This is quite a long sentence that goes on and on and on and on and on indeed";
		const s = slugify(long);
		expect(s.length).toBeLessThanOrEqual(32);
		expect(s.endsWith("-")).toBe(false);
	});

	test("fallback", () => {
		expect(slugify("!!!")).toBe("task");
	});
});

describe("slugify properties", () => {
	test("output is a bounded idempotent slug", () => {
		fc.assert(
			fc.property(fc.string(), (x) => {
				const s = slugify(x);
				expect(s).toMatch(/^[a-z0-9-]*$/);
				expect(s.startsWith("-")).toBe(false);
				expect(s.endsWith("-")).toBe(false);
				expect(s.length).toBeLessThanOrEqual(32);
				expect(slugify(s)).toBe(s);
			}),
		);
	});
});

describe("validateCopyPath properties", () => {
	// Segments drawn from chars that keep most generated paths acceptable; "." and ".." and
	// ".git"-like segments appear too so rejected shapes are exercised, not avoided.
	const seg = fc
		.string({ minLength: 1, maxLength: 8 })
		.filter((s) => /^[\w.\- ]+$/.test(s));
	const relPath = fc
		.array(seg, { minLength: 1, maxLength: 5 })
		.map((xs) => xs.join("/"));

	test("pinned counterexamples: root path and case-variant .git are rejected", () => {
		expect(validateCopyPath(".")).toBe("path must be inside the worktree");
		expect(validateCopyPath("./")).toBe("path must be inside the worktree");
		expect(validateCopyPath(".GIT")).toBe("path must not contain '.git'");
		expect(validateCopyPath(".Git")).toBe("path must not contain '.git'");
		expect(validateCopyPath("a/.GIT/config")).toBe(
			"path must not contain '.git'",
		);
		// Windows drops trailing dots/spaces per component: ".. " names the parent.
		expect(validateCopyPath(".. / ")).toBe("path must not contain '..'");
		expect(validateCopyPath("a/.. ")).toBe("path must not contain '..'");
		expect(validateCopyPath(".git.")).toBe("path must not contain '.git'");
	});

	test("accepted paths resolve strictly below the worktree root", () => {
		fc.assert(
			fc.property(relPath, (p) => {
				fc.pre(validateCopyPath(p) === null);
				const root = "/fake/root";
				const rel = relative(root, join(root, p));
				expect(rel).not.toBe("");
				// A climb is exactly ".." or a "../" prefix; "..0" is a normal child name.
				expect(rel === ".." || rel.startsWith("../")).toBe(false);
			}),
			{ examples: [["."], [".. / "]] },
		);
	});

	test("accepted paths never contain a .git segment, any case", () => {
		fc.assert(
			fc.property(relPath, (p) => {
				fc.pre(validateCopyPath(p) === null);
				for (const s of p.split("/")) expect(s.toLowerCase()).not.toBe(".git");
			}),
			{ examples: [[".GIT"], [".Git"], ["a/.git/config"]] },
		);
	});
});

describe("githubRepoName", () => {
	test.each([
		["https://github.com/owner/repo", "repo"],
		["https://github.com/owner/repo.git", "repo"],
		["https://github.com/owner/repo/", "repo"],
		["git@github.com:owner/repo.git", "repo"],
		["  https://github.com/owner/my.repo-1  ", "my.repo-1"],
	])("parses %s to %s", (raw, want) => {
		expect(githubRepoName(raw)).toBe(want);
	});

	test.each([
		// dot-leading names could escape the workspace via path traversal
		"https://github.com/owner/.git",
		"https://github.com/owner/.hidden",
		"git@github.com:owner/.hidden.git",
		// non-GitHub hosts have no guard on their names
		"https://gitlab.com/owner/repo",
		"https://github.com.evil.test/owner/repo",
		"not a url",
	])("rejects %s", (raw) => {
		expect(githubRepoName(raw)).toBeNull();
	});
});

/**
 * git for fixtures, with a throwaway identity and no signing. Deliberately not the git() under test: a
 * mutant that drops git()'s cwd would otherwise run these commits and pushes in whatever repo holds the
 * process's working directory.
 */
async function must(cwd: string, ...args: string[]): Promise<string> {
	const id = [
		"-c",
		"user.name=ott",
		"-c",
		"user.email=ott@example.invalid",
		"-c",
		"commit.gpgsign=false",
	];
	const r = Bun.spawnSync([gitExe(), ...id, ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	if (r.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

/**
 * Windows 8.3 spelling of p (== p where short names are disabled). PowerShell's FSO because
 * neither git- nor fs-derived paths expose the alias, and bun's realpath does not expand it.
 */
const shortPath = (p: string): string => {
	if (process.platform !== "win32") return p;
	const r = Bun.spawnSync([
		"powershell",
		"-NoProfile",
		"-Command",
		`(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replaceAll("'", "''")}').ShortPath`,
	]);
	return r.stdout.toString().trim() || p;
};

describe("against real repos", () => {
	// Each must() spawns real git; ~4 s a run alone (see stryker.worktree.config.mjs), so bun's 5 s
	// default times hooks out under load. The per-test 60 s below matches the mutation config's ceiling.
	// A bare "origin" and a main checkout whose main tracks origin/main at commit a.
	let root = "";
	let origin = "";
	let main = "";
	let a = "";
	// Hook timeouts are separate from per-test timeouts in bun:test; git under load needs the same ceiling.
	beforeAll(async () => {
		// bun test --bail exits before afterAll, so a killed Stryker mutant leaves the fixture dir
		// behind; sweep hours-old litter (same helper as release.test.ts).
		sweepStaleFixtures("ott-worktree-test-");
		root = mkdtempSync(join(tmpdir(), "ott-worktree-test-"));
		origin = join(root, "origin.git");
		main = join(root, "main");
		await must(root, "init", "-q", "--bare", "-b", "main", origin);
		await must(root, "init", "-q", "-b", "main", main);
		await must(main, "commit", "-q", "--allow-empty", "-m", "a");
		await must(main, "remote", "add", "origin", origin);
		await must(main, "push", "-q", "-u", "origin", "main");
		a = await must(main, "rev-parse", "HEAD");
	}, 60_000);
	afterAll(
		() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
		60_000,
	);

	test("createWorktree reuses leftovers from a crashed attempt instead of failing", async () => {
		const branch = "ott/f36f4b73-reuse-test";
		const wt = join(root, "wt-reuse");
		const opts = {
			mainPath: main,
			worktreePath: wt,
			branch,
			base: a,
			copyExtra: [],
			log: () => {},
		};
		await createWorktree(opts);
		// Registered worktree + existing branch (the crashed-attempt state): reuse, not fail.
		await createWorktree(opts);
		expect(await must(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);

		// Branch exists but the worktree is gone: checkout the branch, no -b.
		await must(main, "worktree", "remove", "--force", wt);
		await createWorktree(opts);
		expect(await must(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);

		// Unregistered scratch dir from an interrupted add: removed, then created fresh.
		await must(main, "worktree", "remove", "--force", wt);
		await mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, "junk.txt"), "leftover");
		await createWorktree(opts);
		expect(existsSync(join(wt, "junk.txt"))).toBe(false);
		expect(await must(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
		await must(main, "worktree", "remove", "--force", wt);
	}, 60_000);

	test("createWorktree copies local-only rules whatever hides them from git", async () => {
		const checkout = repo();
		await must(checkout, "init", "-q", "-b", "main");
		// Local-only two ways: .git/info/exclude (the AGENTS.md convention) and a committed .gitignore.
		writeFileSync(join(checkout, ".gitignore"), ".omp/\n");
		await must(checkout, "add", ".gitignore");
		await must(checkout, "commit", "-q", "-m", "init");
		mkdirSync(join(checkout, ".git", "info"), { recursive: true });
		appendFileSync(join(checkout, ".git", "info", "exclude"), "/AGENTS.md\n");
		const files = {
			"AGENTS.md": "rules\n",
			".omp/hooks/pre/guard.js": "guard\n",
			"scripts/release.mjs": "release\n",
		};
		mkdirSync(join(checkout, ".omp", "hooks", "pre"), { recursive: true });
		mkdirSync(join(checkout, "scripts"));
		for (const [rel, text] of Object.entries(files))
			writeFileSync(join(checkout, rel), text);
		const base = await must(checkout, "rev-parse", "HEAD");
		const wts = repo();
		// The first copy adds /scripts/release.mjs to .git/info/exclude; the second must still copy it.
		for (const id of ["one", "two"]) {
			const wt = join(wts, id);
			await createWorktree({
				mainPath: checkout,
				worktreePath: wt,
				branch: `ott/${id}`,
				base,
				copyExtra: ["scripts/release.mjs"],
				log: () => {},
			});
			for (const [rel, text] of Object.entries(files))
				expect(readFileSync(join(wt, rel), "utf8")).toBe(text);
			expect(
				await must(wt, "status", "--porcelain", "--untracked-files=all"),
			).toBe("");
		}
	}, 60_000);

	test("resolveTarget fetches the upstream only when asked (before a new worktree)", async () => {
		// origin moves on without the main checkout knowing
		const b = await must(
			origin,
			"commit-tree",
			"-p",
			"main",
			"-m",
			"b",
			"main^{tree}",
		);
		await must(origin, "update-ref", "refs/heads/main", b);
		expect(await resolveTarget(main)).toEqual({
			target: "origin/main",
			sha: a,
			warning: null,
		});
		expect(await resolveTarget(main, true, origin)).toEqual({
			target: "origin/main",
			sha: b,
			warning: null,
		});
	}, 60_000);

	test("resolveTarget stops on an upstream missing from origin instead of using the local branch", async () => {
		await must(main, "config", "branch.main.merge", "refs/heads/gone");
		try {
			await expect(resolveTarget(main, true, origin)).rejects.toThrow(
				"upstream origin/gone of main not found",
			);
		} finally {
			await must(main, "config", "branch.main.merge", "refs/heads/main");
		}
	}, 60_000);

	test("resolveTarget keeps the last fetched upstream when the fetch fails, with a warning", async () => {
		const last = await must(main, "rev-parse", "origin/main");
		await must(main, "remote", "set-url", "origin", join(root, "missing.git"));
		try {
			const r = await resolveTarget(main, true, join(root, "missing.git"));
			expect(r).toMatchObject({ target: "origin/main", sha: last });
			expect(r.warning).toBeTruthy();
		} finally {
			await must(main, "remote", "set-url", "origin", origin);
		}
	}, 60_000);

	test("resolveTarget skips a fetch with a warning while the origin URL is not pinned", async () => {
		const last = await must(main, "rev-parse", "origin/main");
		const b = await must(
			origin,
			"commit-tree",
			"-p",
			"main",
			"-m",
			"b2",
			"main^{tree}",
		);
		await must(origin, "update-ref", "refs/heads/main", b);
		try {
			const r = await resolveTarget(main, true);
			expect(r).toMatchObject({ target: "origin/main", sha: last });
			expect(r.warning).toContain("not pinned");
		} finally {
			await must(origin, "update-ref", "refs/heads/main", last);
		}
	}, 60_000);

	test("resolveTarget prefers origin/HEAD over a parked branch without upstream, and refuses a detached HEAD", async () => {
		// The fixture clone has no origin/HEAD (built with init + push, not clone);
		// set-head plants one naming the default branch.
		await must(main, "remote", "set-head", "origin", "main");
		await must(main, "checkout", "-q", "-b", "solo");
		try {
			// origin/HEAD wins: even a checked-out branch without upstream parks below it.
			const headSha = await must(main, "rev-parse", "origin/main");
			expect(await resolveTarget(main, true, origin)).toEqual({
				target: "origin/main",
				sha: headSha,
				warning: null,
			});
			// Without origin/HEAD (a solo repo, a stripped clone) the old derivation holds:
			// the upstreamless checked-out branch is the target.
			await must(main, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
			expect(await resolveTarget(main, true)).toEqual({
				target: "solo",
				sha: a,
				warning: null,
			});
			await must(main, "checkout", "-q", "--detach");
			await expect(resolveTarget(main)).rejects.toThrow("detached HEAD");
		} finally {
			await must(main, "checkout", "-q", "main");
		}
	}, 60_000);

	test("resolveTarget resolves a configured target branch through the pinned origin", async () => {
		// origin gains refs/heads/feature; the clone knows nothing of it yet, and there is
		// no origin/HEAD in this fixture to fall back to.
		const f1 = await must(
			origin,
			"commit-tree",
			"-p",
			"main",
			"-m",
			"f1",
			"main^{tree}",
		);
		await must(origin, "update-ref", "refs/heads/feature", f1);
		// An absent origin/<branch> fails loudly; it never falls back to the checkout.
		await expect(resolveTarget(main, false, origin, "feature")).rejects.toThrow(
			"cannot resolve origin/feature",
		);
		// The fetch refreshes origin/feature through the pinned origin URL.
		expect(await resolveTarget(main, true, origin, "feature")).toEqual({
			target: "origin/feature",
			sha: f1,
			warning: null,
		});
		// origin moves on; the next pinned fetch follows.
		const f2 = await must(
			origin,
			"commit-tree",
			"-p",
			f1,
			"-m",
			"f2",
			`${f1}^{tree}`,
		);
		await must(origin, "update-ref", "refs/heads/feature", f2);
		expect(await resolveTarget(main, true, origin, "feature")).toEqual({
			target: "origin/feature",
			sha: f2,
			warning: null,
		});
	}, 60_000);

	test("a configured target ignores the main checkout's branch and its upstream", async () => {
		const mainSha = await must(main, "rev-parse", "origin/main");
		await must(main, "checkout", "-q", "-b", "parked");
		try {
			expect(await resolveTarget(main, false, origin, "main")).toEqual({
				target: "origin/main",
				sha: mainSha,
				warning: null,
			});
		} finally {
			await must(main, "checkout", "-q", "main");
		}
	}, 60_000);

	// Git canonicalizes registrations and rev-parse output to the long path; fs-derived inputs
	// can be 8.3 short names (C:\Users\RUNNER~1\... on CI runners). Regressed b114d92's windows
	// CI: worktreeLinked went false, and createWorktree treated a live worktree as scratch.
	test("8.3-spelled paths still link, reuse, and prune stale registrations", async () => {
		const short = shortPath(main);
		if (
			short.replaceAll("\\", "/").toLowerCase() ===
			main.replaceAll("\\", "/").toLowerCase()
		)
			return; // volume has 8.3 names disabled: the spellings already match
		const wt = join(short, "wt-8dot3");
		await must(main, "worktree", "add", "-q", "-b", "ott/8dot3-reuse-test", wt); // registered under the long form
		expect(await worktreeLinked(short)).toBe(true); // rev-parse prints the long form
		rmSync(wt, { recursive: true, force: true }); // crashed attempt: dir gone, entry registered
		await createWorktree({
			mainPath: main,
			worktreePath: wt,
			branch: "ott/8dot3-reuse-test",
			base: a,
			copyExtra: [],
			log: () => {},
		}); // mismatched spelling + missing dir must prune and re-add, not fail "already registered"
		expect(await must(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
			"ott/8dot3-reuse-test",
		);
		expect(await worktreeLinked(wt)).toBe(true);
	}, 60_000);

	test("unsavedWork names what deleting a worktree would lose until it is merged", async () => {
		const wt = join(root, "wt");
		await must(main, "worktree", "add", "-q", "-b", "task", wt, "origin/main");
		writeFileSync(join(wt, "f.txt"), "x");
		expect(await unsavedWork(wt, "origin/main")).toBe("uncommitted changes");
		await must(wt, "add", "f.txt");
		await must(wt, "commit", "-q", "-m", "c");
		expect(await unsavedWork(wt, "origin/main")).toBe(
			"1 commit not on origin/main",
		);
		await must(wt, "push", "-q", "origin", "HEAD:main");
		expect(await unsavedWork(wt, "origin/main")).toBeNull();
		// A check that can't run must still name a reason: callers keep the worktree only on a truthy one.
		// A missing or empty dir is a husk with nothing to lose (null); an unlinked dir holding
		// files stays suspect until a human looks.
		const stray = join(root, "stray");
		mkdirSync(stray, { recursive: true });
		writeFileSync(join(stray, "x.txt"), "x");
		expect(await unsavedWork(stray, "origin/main")).toBeTruthy();
	}, 60_000);

	test("githubUrl normalizes the GitHub remote (origin preferred), null without one", async () => {
		// The fixture's origin is a local path, not GitHub.
		expect(await githubUrl(main)).toBeNull();
		await must(main, "remote", "add", "gh", "git@github.com:octo/demo-app.git");
		try {
			expect(await githubUrl(main)).toBe("https://github.com/octo/demo-app");
			// origin becomes a GitHub remote: it wins over the first-inserted one.
			const old = await must(main, "remote", "get-url", "origin");
			await must(
				main,
				"remote",
				"set-url",
				"origin",
				"https://github.com/octo/tracker.git",
			);
			try {
				expect(await githubUrl(main)).toBe("https://github.com/octo/tracker");
			} finally {
				await must(main, "remote", "set-url", "origin", old);
			}
		} finally {
			await must(main, "remote", "remove", "gh");
		}
	}, 60_000);

	test("githubUrl follows OTTR_GITHUB_HOST and ignores other hosts", async () => {
		const savedHost = process.env.OTTR_GITHUB_HOST;
		process.env.OTTR_GITHUB_HOST = "acme.ghe.com";
		try {
			await must(main, "remote", "add", "gh", "git@acme.ghe.com:o/r.git");
			await must(
				main,
				"remote",
				"add",
				"other",
				"https://github.com/octo/demo-app.git",
			);
			expect(await githubUrl(main)).toBe("https://acme.ghe.com/o/r");
			await must(main, "remote", "remove", "gh");
			expect(await githubUrl(main)).toBeNull();
		} finally {
			await must(main, "remote", "remove", "other");
			if (savedHost === undefined) delete process.env.OTTR_GITHUB_HOST;
			else process.env.OTTR_GITHUB_HOST = savedHost;
		}
		// Without the setting, only github.com counts.
		await must(main, "remote", "add", "ghe", "git@ghe.example.com:o/r.git");
		try {
			expect(await githubUrl(main)).toBeNull();
		} finally {
			await must(main, "remote", "remove", "ghe");
		}
	}, 60_000);

	test("remoteUrl returns the https origin on any host, null for local paths", async () => {
		// The fixture's origin is a local path: no host, no icon source.
		expect(await remoteUrl(main)).toBeNull();
		await must(main, "remote", "add", "gh", "git@gitlab.com:octo/repo.git");
		try {
			expect(await remoteUrl(main)).toBe("https://gitlab.com/octo/repo");
			const old = await must(main, "remote", "get-url", "origin");
			await must(
				main,
				"remote",
				"set-url",
				"origin",
				"ssh://git@git.example.com/octo/self.git",
			);
			try {
				// origin wins over the first-inserted one, host irrelevant.
				expect(await remoteUrl(main)).toBe("https://git.example.com/octo/self");
			} finally {
				await must(main, "remote", "set-url", "origin", old);
			}
		} finally {
			await must(main, "remote", "remove", "gh");
		}
	}, 60_000);
});

describe("httpsRemote", () => {
	test("normalizes https, ssh and scp-like remotes; strips .git", () => {
		expect(httpsRemote("https://gitlab.com/octo/repo.git")).toBe(
			"https://gitlab.com/octo/repo",
		);
		expect(httpsRemote("git@gitlab.com:octo/repo.git")).toBe(
			"https://gitlab.com/octo/repo",
		);
		expect(httpsRemote("ssh://git@git.example.com/octo/repo")).toBe(
			"https://git.example.com/octo/repo",
		);
		expect(httpsRemote("http://git.example.com/octo/repo")).toBe(
			"https://git.example.com/octo/repo",
		);
	});
	test("embedded userinfo (a token in the clone URL) never reaches the URL", () => {
		expect(
			httpsRemote("https://x-access-token:ghp_ABC@github.com/octo/repo.git"),
		).toBe("https://github.com/octo/repo");
		expect(httpsRemote("https://@gitlab.com/octo/repo")).toBe(
			"https://gitlab.com/octo/repo",
		);
	});
	test("local and file paths are not hosts: null", () => {
		expect(httpsRemote("/srv/git/repo")).toBeNull();
		expect(httpsRemote("file:///srv/git/repo")).toBeNull();
		expect(httpsRemote("")).toBeNull();
	});
});

describe("headVersion", () => {
	test("returns HEAD sha, tracks new commits (a restart), and falls back to a timestamp without commits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-head-"));
		try {
			await must(dir, "init", "-q", "-b", "main");
			expect(await headVersion(dir)).toMatch(/^\d+$/); // no commits yet: boot-time fallback
			writeFileSync(join(dir, "f"), "x");
			await must(dir, "add", ".");
			await must(dir, "commit", "-q", "-m", "a");
			const v1 = await headVersion(dir);
			await must(dir, "commit", "-q", "--allow-empty", "-m", "b");
			const v2 = await headVersion(dir);
			expect(await headVersion(dir)).toBe(v2); // stable across polls
			expect(v2).not.toBe(v1); // changes only when HEAD changes
			expect(v1).toBe(await must(dir, "rev-parse", "HEAD~"));
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 60_000);
});

describe("describeVersion", () => {
	test("release tag at HEAD, tag-plus-commits form past it, short sha on dev, timestamp without commits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-desc-"));
		try {
			await must(dir, "init", "-q", "-b", "main");
			expect(await describeVersion(dir)).toMatch(/^\d+$/); // no commits yet: boot-time fallback
			await must(dir, "commit", "-q", "--allow-empty", "-m", "a");
			const dev = await describeVersion(dir);
			expect(dev).toMatch(/^[0-9a-f]{7}$/); // no release: short HEAD sha
			expect(dev).toBe(await must(dir, "rev-parse", "--short", "HEAD"));
			await must(dir, "tag", "-a", "v1.2.3", "-m", "v1.2.3");
			expect(await describeVersion(dir)).toBe("v1.2.3"); // exactly at the release
			await must(dir, "commit", "-q", "--allow-empty", "-m", "b");
			const past = await describeVersion(dir);
			expect(past).toMatch(/^v1\.2\.3-1-g[0-9a-f]{7}$/); // past the release: tag plus count plus sha
			await must(dir, "tag", "notarelease");
			expect(await describeVersion(dir)).toBe(past); // non-release tags are ignored
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 60_000);

	test("the image stamp OTTR_VERSION wins over git; an empty stamp behaves as unset", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-stamp-"));
		const old = process.env.OTTR_VERSION;
		process.env.OTTR_VERSION = " v9.9.9 ";
		try {
			await must(dir, "init", "-q", "-b", "main");
			await must(dir, "commit", "-q", "--allow-empty", "-m", "a");
			await must(dir, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
			expect(await describeVersion(dir)).toBe("v9.9.9"); // trims, and beats the repo's tag
			process.env.OTTR_VERSION = ""; // the image build leaves the arg empty
			expect(await describeVersion(dir)).toBe("v1.0.0"); // falls through to git
		} finally {
			if (old === undefined) delete process.env.OTTR_VERSION;
			else process.env.OTTR_VERSION = old;
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 60_000);

	test("a directory without .git falls back to the boot-time stamp (the image shape)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-nogit-"));
		try {
			expect(await describeVersion(dir)).toMatch(/^\d+$/);
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 60_000);
});

describe("archReviewDelta", () => {
	// Committer times decide which watermark is newer; fixed ones keep that order deterministic.
	const commitAt = (dir: string, message: string, at: number) => {
		const r = Bun.spawnSync(
			[
				gitExe(),
				"-c",
				"user.name=ott",
				"-c",
				"user.email=ott@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				message,
			],
			{
				cwd: dir,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				env: {
					...process.env,
					GIT_AUTHOR_DATE: `@${at} +0000`,
					GIT_COMMITTER_DATE: `@${at} +0000`,
				},
			},
		);
		if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	};

	test("counts from the newest docs(arch-review): anchor, else the whole history", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-arch-"));
		try {
			await must(dir, "init", "-q", "-b", "main");
			await must(dir, "commit", "-q", "--allow-empty", "-m", "one");
			await must(dir, "commit", "-q", "--allow-empty", "-m", "two");
			expect(await archReviewDelta(dir, "main", null)).toEqual({
				delta: 2,
				reviewed: false,
				anchor: "",
			}); // no anchor: the whole history counts, the project is un-reviewed
			await must(
				dir,
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"docs(arch-review): pass",
			);
			const docs = await must(dir, "rev-parse", "HEAD");
			expect(await archReviewDelta(dir, "main", null)).toEqual({
				delta: 0,
				reviewed: true,
				anchor: docs,
			}); // anchor is HEAD
			await must(dir, "commit", "-q", "--allow-empty", "-m", "feat a");
			await must(dir, "commit", "-q", "--allow-empty", "-m", "feat b");
			expect(await archReviewDelta(dir, "main", null)).toEqual({
				delta: 2,
				reviewed: true,
				anchor: docs,
			}); // only commits after the anchor
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 60_000);

	test("the last review's base anchors when it is newer; a marker tag no longer counts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-arch-"));
		try {
			await must(dir, "init", "-q", "-b", "main");
			commitAt(dir, "docs(arch-review): pass", 1_700_000_100);
			commitAt(dir, "one", 1_700_000_200);
			const base = await must(dir, "rev-parse", "HEAD");
			commitAt(dir, "fix from a finding", 1_700_000_300);
			// A release tag on a later commit: the commits between the base and the tag were not reviewed.
			await must(dir, "tag", "-a", "v0.1.0", "-m", "v0.1.0\n\narch-review: 1");
			commitAt(dir, "feat a", 1_700_000_400);
			expect(await archReviewDelta(dir, "main", base)).toEqual({
				delta: 2,
				reviewed: true,
				anchor: base,
			});
			// A newer docs(arch-review): commit (an old-style review) still wins.
			commitAt(dir, "docs(arch-review): later", 1_700_000_500);
			const docs = await must(dir, "rev-parse", "HEAD");
			commitAt(dir, "feat b", 1_700_000_600);
			expect(await archReviewDelta(dir, "main", base)).toEqual({
				delta: 1,
				reviewed: true,
				anchor: docs,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 60_000);

	test("a review base this clone does not have is skipped", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-arch-"));
		try {
			await must(dir, "init", "-q", "-b", "main");
			await must(dir, "commit", "-q", "--allow-empty", "-m", "one");
			await must(dir, "commit", "-q", "--allow-empty", "-m", "two");
			expect(await archReviewDelta(dir, "main", "0".repeat(40))).toEqual({
				delta: 2,
				reviewed: false,
				anchor: "",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 60_000);
});

describe("archReviewDue", () => {
	test("a review is due once the delta reaches the cap; an un-reviewed project is always due", () => {
		expect(archReviewDue(0, 150, true)).toBe(false);
		expect(archReviewDue(149, 150, true)).toBe(false);
		expect(archReviewDue(150, 150, true)).toBe(true);
		expect(archReviewDue(151, 150, true)).toBe(true);
		expect(archReviewDue(0, 150, false)).toBe(true); // no watermark yet: whatever the history, a review is due
		expect(archReviewDue(2, 150, false)).toBe(true);
	});
});
const repos: string[] = [];
afterAll(() => {
	for (const r of repos)
		rmSync(r, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

/**
 * `bun test --bail` exits before afterAll runs, so a killed Stryker mutant leaves its fixture dir
 * behind. Each run sweeps that litter, but only dirs hours old: a fresh dir belongs to one of the
 * concurrent sandbox runners this process shares %TEMP% with.
 */
function sweepStaleFixtures(prefix: string) {
	for (const d of readdirSync(tmpdir(), { withFileTypes: true })) {
		if (!d.name.startsWith(prefix)) continue;
		const p = join(tmpdir(), d.name);
		try {
			if (Date.now() - statSync(p).mtimeMs > 6 * 3_600_000)
				rmSync(p, { recursive: true, force: true, maxRetries: 5 });
		} catch {
			// vanished or locked by a live run — not ours to remove
		}
	}
}

/** Fresh throwaway directory; callers git-init it. Deleted in afterAll. */
function repo(): string {
	const r = mkdtempSync(join(tmpdir(), "ott-kept-"));
	repos.push(r);
	return r;
}

describe("changedFiles", () => {
	test("lists committed and uncommitted changes from base, [] on a bad base", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "base.txt"), "b");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		const base = (await must(main, "rev-parse", "HEAD")).trim();

		expect(await changedFiles(main, base, base)).toEqual([]);

		mkdirSync(join(main, "src", "ui"), { recursive: true });
		writeFileSync(join(main, "src", "ui", "app.tsx"), "x");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "ui");
		// Committed branch work plus an uncommitted edit, forward slashes.
		writeFileSync(join(main, "base.txt"), "dirty");
		expect(await changedFiles(main, base, base)).toEqual([
			"base.txt",
			"src/ui/app.tsx",
		]);

		// A target git cannot resolve falls back to base.
		expect(await changedFiles(main, base, "nonsense")).toEqual([
			"base.txt",
			"src/ui/app.tsx",
		]);
		// A base git cannot resolve reads as "no changes", never throws.
		expect(await changedFiles(main, "nonsense", "nonsense")).toEqual([]);
	}, 60_000);

	// Card 0d119309 (2026-10-13): a rebase pulled another card's UI commits in, and the UI-shot
	// guard asked an auth fix for a screenshot.
	test("after a rebase onto a newer target, lists only the branch's own changes", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "base.txt"), "b");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		const base = (await must(main, "rev-parse", "HEAD")).trim();
		await must(main, "checkout", "-q", "-b", "card");
		writeFileSync(join(main, "auth.ts"), "fix");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "card work");
		await must(main, "checkout", "-q", "main");
		mkdirSync(join(main, "src", "ui"), { recursive: true });
		writeFileSync(join(main, "src", "ui", "app.tsx"), "x");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "another card's ui");
		await must(main, "checkout", "-q", "card");
		await must(main, "rebase", "-q", "main");
		expect(await changedFiles(main, base, "main")).toEqual(["auth.ts"]);
	}, 60_000);

	// diff --name-only without -z octal-quotes this name under the default core.quotePath.
	test("non-ASCII names come back unquoted", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "\u00fc.txt"), "1");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		const base = (await must(main, "rev-parse", "HEAD")).trim();
		writeFileSync(join(main, "\u00fc.txt"), "2");
		expect(await changedFiles(main, base, base)).toEqual(["\u00fc.txt"]);
	}, 60_000);
});

describe("diffStat and diffText", () => {
	test("per-file +/- counts and the raw diff for the branch's own changes", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "base.txt"), "b\n");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		const base = (await must(main, "rev-parse", "HEAD")).trim();
		await must(main, "checkout", "-q", "-b", "card");
		writeFileSync(join(main, "new.txt"), "one\ntwo\n");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "add");
		writeFileSync(join(main, "base.txt"), "b\nb2\nb3\n");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "grow");

		const stat = await diffStat(main, base, "main");
		expect(stat).toEqual([
			{ file: "base.txt", plus: 2, minus: 0 },
			{ file: "new.txt", plus: 2, minus: 0 },
		]);
		const text = (await diffText(main, base, "main")) ?? "";
		expect(text).toContain("diff --git a/base.txt b/base.txt");
		expect(text).toContain("+b2");

		// Up to date: the branch has nothing of its own left to show.
		expect(await diffStat(main, base, "card")).toEqual([]);
	}, 60_000);

	test("counts uncommitted edits, [] and null when git fails", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a\n");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		const base = (await must(main, "rev-parse", "HEAD")).trim();
		writeFileSync(join(main, "a.txt"), "a\na2\n");
		expect(await diffStat(main, base, base)).toEqual([
			{ file: "a.txt", plus: 1, minus: 0 },
		]);
		// An unreadable base makes git diff fail: no stat, no text, no throw.
		expect(await diffStat(main, "nonsense", "nonsense")).toEqual([]);
		expect(await diffText(main, "nonsense", "nonsense")).toBeNull();
	}, 60_000);
});

describe("parseNumstat", () => {
	test("counts, binary dashes, renames, blank lines", () => {
		expect(
			parseNumstat(
				"3\t1\t webpack.config.js\n-\t-\tlogo.png\n10\t0\told => new\n",
			),
		).toEqual([
			{ file: " webpack.config.js", plus: 3, minus: 1 },
			{ file: "logo.png", plus: null, minus: null },
			{ file: "old => new", plus: 10, minus: 0 },
		]);
		expect(parseNumstat("")).toEqual([]);
	});
});

describe("targetCommits", () => {
	test("counts the target's commits; null for no target or an unknown ref", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "one");
		await must(main, "commit", "-q", "--allow-empty", "-m", "two");
		await must(main, "commit", "-q", "--allow-empty", "-m", "three");
		expect(await targetCommits(main, "main")).toBe(3);
		expect(await targetCommits(main, null)).toBeNull();
		expect(await targetCommits(main, "ott/nope")).toBeNull();
	}, 60_000);
});

describe("statusRows", () => {
	test("[] only when proven clean; raw XY records otherwise", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		expect(await statusRows(main)).toEqual([]);
		writeFileSync(join(main, "a.txt"), "changed");
		expect(await statusRows(main)).toEqual([" M a.txt"]);
	}, 60_000);

	test("throws when git status exits nonzero — unknown status is never []", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		// rev-parse still resolves (worktreeLinked stays true), so this isolates the
		// nonzero-status case: a corrupt index must throw, not read as a fake clean [].
		writeFileSync(join(main, ".git", "index"), "garbage");
		await expect(statusRows(main)).rejects.toThrow("git status failed");
	}, 60_000);

	test("throws for a dir that is not a linked checkout", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		// A sibling dir with no .git link: git would climb out and speak for main.
		const plain = join(main, "plain");
		mkdirSync(plain, { recursive: true });
		await expect(statusRows(plain)).rejects.toThrow(
			"not a linked git worktree",
		);
	}, 60_000);
});

describe("statusFiles", () => {
	test("lists untracked paths and [] when clean", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		expect(await statusFiles(main)).toEqual([]);

		writeFileSync(join(main, "a.txt"), "changed");
		mkdirSync(join(main, "nested"), { recursive: true });
		writeFileSync(join(main, "nested", "new.txt"), "n");
		expect(await statusFiles(main)).toEqual(["a.txt", "nested/new.txt"]);

		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "c");
		expect(await statusFiles(main)).toEqual([]);
	}, 60_000);

	test("a staged rename maps to repo-relative paths without the XY prefix", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "old.txt"), "x");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		mkdirSync(join(main, "sub"), { recursive: true });
		await must(main, "mv", "old.txt", "sub/new.txt");
		for (const f of await statusFiles(main)) {
			expect(f).not.toMatch(/^[ARD?U]/); // no XY prefix survives the parse
			expect(existsSync(join(main, f))).toBe(true); // whatever git emits resolves to a real path
		}
	}, 60_000);

	// -z output is never quoted: core.quotePath's default mangles every one of these on
	// newline-separated output, so the old parse returned octal-escaped garbage.
	// NTFS forbids quotes, tabs and newlines in file names: this test and the next are POSIX-only.
	test.skipIf(process.platform === "win32")(
		"byte-exact paths: non-ASCII, quotes, tabs, newlines",
		async () => {
			const main = repo();
			await must(main, "init", "-q", "-b", "main");
			writeFileSync(join(main, "a.txt"), "a");
			await must(main, "add", ".");
			await must(main, "commit", "-q", "-m", "init");
			const weird = [
				"\u00fc.txt",
				'we"ird.txt',
				"tab\tname.txt",
				"new\nline.txt",
			];
			for (const f of weird) writeFileSync(join(main, f), "x");
			expect((await statusFiles(main)).sort()).toEqual([...weird].sort());
		},
		60_000,
	);

	test.skipIf(process.platform === "win32")(
		"a staged rename reports exactly the destination, quotes and all",
		async () => {
			const main = repo();
			await must(main, "init", "-q", "-b", "main");
			writeFileSync(join(main, "old.txt"), "x");
			await must(main, "add", ".");
			await must(main, "commit", "-q", "-m", "init");
			mkdirSync(join(main, 'sub "dir"'), { recursive: true });
			await must(main, "mv", "old.txt", 'sub "dir"/moved.txt');
			expect(await statusFiles(main)).toEqual(['sub "dir"/moved.txt']);
		},
		60_000,
	);
});

describe("quarantineUntracked", () => {
	/** Init a repo with one tracked commit, like an agent worktree mid-task. */
	async function seeded(): Promise<string> {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "tracked.txt"), "tracked");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		return main;
	}

	test("moves untracked scratch out, preserving layout and reporting forward-slash rel paths", async () => {
		const main = await seeded();
		// production shape: .tasks/.gitignore (committed, "*") keeps quarantined files invisible to status
		mkdirSync(join(main, ".tasks"), { recursive: true });
		writeFileSync(join(main, ".tasks", ".gitignore"), "*\n");
		await must(main, "add", "-f", ".tasks/.gitignore");
		await must(main, "commit", "-q", "-m", "quarantine ignore");
		const q = join(main, ".tasks", "quarantine", "t1");
		// agent left verification screenshots and scratch notes, root and nested
		writeFileSync(join(main, ".smoke-22.png"), "png");
		writeFileSync(join(main, "file0"), "f");
		writeFileSync(join(main, "todo-task.md"), "t");
		mkdirSync(join(main, "sub", "dir"), { recursive: true });
		writeFileSync(join(main, "sub", "dir", "x.txt"), "x");

		const moved = await quarantineUntracked(main, q, main);
		expect(moved.sort()).toEqual([
			".smoke-22.png",
			"file0",
			"sub/dir/x.txt",
			"todo-task.md",
		]);
		for (const rel of moved) {
			expect(existsSync(join(main, rel))).toBe(false);
		}
		expect(readFileSync(join(q, ".smoke-22.png"), "utf8")).toBe("png");
		expect(readFileSync(join(q, "file0"), "utf8")).toBe("f");
		expect(readFileSync(join(q, "todo-task.md"), "utf8")).toBe("t");
		expect(readFileSync(join(q, "sub", "dir", "x.txt"), "utf8")).toBe("x");
		expect(await statusFiles(main)).toEqual([]);
	}, 60_000);

	test("leaves gitignored files in place", async () => {
		const main = await seeded();
		writeFileSync(join(main, ".gitignore"), "ignored.log\n");
		writeFileSync(join(main, "ignored.log"), "i");
		await must(main, "add", ".gitignore");
		await must(main, "commit", "-q", "-m", "gitignore");
		const q = join(main, ".tasks", "quarantine", "t2");
		expect(await quarantineUntracked(main, q, main)).toEqual([]);
		expect(existsSync(join(main, "ignored.log"))).toBe(true);
		expect(existsSync(q)).toBe(false);
	}, 60_000);

	test("does not move a modified tracked file; it still shows in git status", async () => {
		const main = await seeded();
		writeFileSync(join(main, "tracked.txt"), "dirty");
		const q = join(main, ".tasks", "quarantine", "t3");
		expect(await quarantineUntracked(main, q, main)).toEqual([]);
		expect(readFileSync(join(main, "tracked.txt"), "utf8")).toBe("dirty");
		expect(await statusFiles(main)).toEqual(["tracked.txt"]);
	}, 60_000);

	test("clean worktree: [] and no quarantine dir created", async () => {
		const main = await seeded();
		const q = join(main, ".tasks", "quarantine", "t4");
		expect(await quarantineUntracked(main, q, main)).toEqual([]);
		expect(existsSync(q)).toBe(false);
	}, 60_000);

	test("tracked files stay byte-for-byte identical", async () => {
		const main = await seeded();
		writeFileSync(join(main, "tracked.txt"), "same");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "c2");
		const before = readFileSync(join(main, "tracked.txt"));
		writeFileSync(join(main, "scratch.md"), "s");
		const q = join(main, ".tasks", "quarantine", "t5");
		await quarantineUntracked(main, q, main);
		expect(readFileSync(join(main, "tracked.txt")).equals(before)).toBe(true);
	}, 60_000);

	test.skipIf(process.platform !== "linux")(
		"refuses a quarantine dir planted as a symlink; outside dir stays empty",
		async () => {
			const main = await seeded();
			const outside = mkdtempSync(join(tmpdir(), "ottr-q-out-"));
			repos.push(outside);
			mkdirSync(join(main, ".tasks"), { recursive: true });
			symlinkSync(outside, join(main, ".tasks", "quarantine"));
			writeFileSync(join(main, "scratch.md"), "s");
			const q = join(main, ".tasks", "quarantine", "t6");
			await expect(quarantineUntracked(main, q, main)).rejects.toThrow(
				/refusing/,
			);
			expect(readdirSync(outside)).toEqual([]);
			expect(readFileSync(join(main, "scratch.md"), "utf8")).toBe("s");
		},
		60_000,
	);

	test.skipIf(process.platform !== "linux")(
		"moves an untracked symlink as a link; its target stays untouched",
		async () => {
			const main = await seeded();
			const outside = join(mkdtempSync(join(tmpdir(), "ottr-q-tgt-")), "f");
			repos.push(dirname(outside));
			writeFileSync(outside, "keep");
			symlinkSync(outside, join(main, "link"));
			const q = join(main, ".tasks", "quarantine", "t7");
			expect(await quarantineUntracked(main, q, main)).toEqual(["link"]);
			expect(lstatSync(join(q, "link")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(q, "link"))).toBe(outside);
			expect(readFileSync(outside, "utf8")).toBe("keep");
			expect(() => lstatSync(join(main, "link"))).toThrow();
		},
		60_000,
	);

	const crossMount =
		existsSync("/dev/shm") &&
		statSync("/dev/shm").dev !== statSync(tmpdir()).dev;
	test.skipIf(!crossMount)(
		"copies across mounts into the data root and removes the sources",
		async () => {
			const main = await seeded();
			const root = mkdtempSync(join("/dev/shm", "ottr-q-"));
			try {
				writeFileSync(join(main, "a.txt"), "a");
				mkdirSync(join(main, "sub"));
				writeFileSync(join(main, "sub", "b.txt"), "b");
				const q = join(root, "quarantine", "t8");
				const moved = await quarantineUntracked(main, q, root);
				expect(moved.sort()).toEqual(["a.txt", "sub/b.txt"]);
				expect(readFileSync(join(q, "a.txt"), "utf8")).toBe("a");
				expect(readFileSync(join(q, "sub", "b.txt"), "utf8")).toBe("b");
				expect(existsSync(join(main, "a.txt"))).toBe(false);
				expect(existsSync(join(main, "sub", "b.txt"))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		60_000,
	);
});

describe("trackedFiles", () => {
	test("lists tracked paths under the dir, not untracked ones, and [] when git fails", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		mkdirSync(join(main, "shots"));
		writeFileSync(join(main, "shots", "committed.png"), "c");
		writeFileSync(join(main, "root.txt"), "r");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		writeFileSync(join(main, "shots", "fresh.png"), "f");
		expect(await trackedFiles(main, "shots")).toEqual(["shots/committed.png"]);
		// A dir with nothing tracked: [], not an error.
		expect(await trackedFiles(main, "docs")).toEqual([]);
		// Not a git repo: [] (fails open; adoption cannot tell committed from fresh).
		expect(await trackedFiles(repo(), "shots")).toEqual([]);
	}, 60_000);
});

describe("unlinked worktree guards", () => {
	test("unlinked dirs with climbing git are husks, with or without leftover files", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		// A sibling dir of the checkout with no .git link: git would climb to main from here.
		const plain = join(main, "emptied-worktree");
		mkdirSync(plain, { recursive: true });
		expect(await worktreeLinked(plain)).toBe(false);
		expect(await unsavedWork(plain, "main")).toBeNull(); // husk: nothing to lose
		expect(await isIntegrated(plain, "main")).toBe(false);
		// A display list never borrows the main checkout's status (statusRows throws here).
		expect(await statusFiles(plain)).toEqual([]);
		const leftovers = join(main, "leftovers");
		mkdirSync(leftovers, { recursive: true });
		writeFileSync(join(leftovers, "x.txt"), "x");
		// The dir cannot speak for a branch (git climbs out), so its contents do not keep it
		// suspect: the husk proof comes from the main repo (branchMergedOrGone), not the files.
		expect(await worktreeHusk(leftovers)).toBe(true);
		expect(await unsavedWork(leftovers, "main")).toBeNull();
	}, 60_000);

	test("a real worktree and the checkout itself are linked", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		expect(await worktreeLinked(main)).toBe(true);
		const wt = join(main, "wt");
		await must(main, "worktree", "add", "-q", wt, "-b", "ott/linked-test");
		expect(await worktreeLinked(wt)).toBe(true);
		expect(await unsavedWork(wt, "main")).toBeNull();
	}, 60_000);

	test("a missing or empty unlinked dir is a husk; so is one whose git climbs out", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		const missing = join(main, "gone");
		expect(await worktreeHusk(missing)).toBe(true);
		const empty = join(main, "husk");
		mkdirSync(empty, { recursive: true });
		expect(await worktreeHusk(empty)).toBe(true);
		const full = join(main, "leftovers");
		mkdirSync(full, { recursive: true });
		writeFileSync(join(full, "x.txt"), "x");
		// Link-less with climbing git: git here would speak for main's checkout, never for a branch.
		expect(await worktreeHusk(full)).toBe(true);
	}, 60_000);

	test("a deregistered but undeleted worktree is a husk: dangling .git, nothing recoverable", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		await must(main, "worktree", "add", "-b", "side", join(main, "wt"));
		// Simulate the half removal (Windows: a process held the dir while `git worktree
		// remove` ran): git pruned the registration, the locked checkout dir stayed.
		// The admin dir is named after the checkout's basename, not the branch.
		rmSync(join(main, ".git", "worktrees", "wt"), {
			recursive: true,
			force: true,
		});
		const wt = join(main, "wt");
		expect(await worktreeLinked(wt)).toBe(false);
		expect(readdirSync(wt).length).toBeGreaterThan(0);
		expect(await worktreeHusk(wt)).toBe(true);
	}, 60_000);

	test("a deregistered worktree that lost its .git file is a husk variant; the branch decides", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		const wt = join(main, "wt");
		await must(main, "worktree", "add", "-b", "side", wt);
		writeFileSync(join(wt, "b.txt"), "b");
		await must(wt, "add", ".");
		await must(wt, "commit", "-q", "-m", "side work");
		// The link is gone entirely (no .git file), but the checkout files stayed: git here
		// climbs out to main, so it cannot speak for `side` any more.
		rmSync(join(wt, ".git"), { force: true });
		expect(existsSync(join(wt, ".git"))).toBe(false);
		expect(await worktreeLinked(wt)).toBe(false);
		expect(readdirSync(wt).length).toBeGreaterThan(0);
		expect(await worktreeHusk(wt)).toBe(true);
		// The husk's integration proof lives in the main repo, not the dir.
		expect(await branchMergedOrGone(main, "side", "main")).toBe(false);
		await must(main, "merge", "-q", "side");
		expect(await branchMergedOrGone(main, "side", "main")).toBe(true);
	}, 60_000);

	test("a healthy worktree whose git read fails is not a husk; the dead gitdir still is", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		const wt = join(main, "wt");
		await must(main, "worktree", "add", "-b", "side", wt);
		writeFileSync(join(wt, "b.txt"), "b");
		// A transient git failure inside the dir (an index lock, dubious ownership): the .git
		// file's gitdir is alive, so the worktree is not a husk (OTTR-349 — a husk verdict
		// here let the pre-dispatch guard settle a zero-commit card done on a vacuous proof).
		const previous = process.env.GIT_DIR;
		process.env.GIT_DIR = join(main, "no-such-gitdir");
		try {
			expect(await worktreeLinked(wt)).toBe(false);
			expect(await worktreeHusk(wt)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = previous;
		}
		expect(await worktreeHusk(wt)).toBe(false);
		// The deregistered shape keeps its husk verdict: the gitdir is gone.
		rmSync(join(main, ".git", "worktrees", "wt"), {
			recursive: true,
			force: true,
		});
		expect(await worktreeHusk(wt)).toBe(true);
	}, 60_000);

	test("branchMergedOrGone: gone or contained counts as merged, diverged does not", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		expect(await branchMergedOrGone(main, "ott/never-existed", "main")).toBe(
			true,
		);
		await must(main, "branch", "ott/merged", "main");
		expect(await branchMergedOrGone(main, "ott/merged", "main")).toBe(true);
		const dw = join(main, "dw");
		await must(main, "worktree", "add", "-q", dw, "-b", "ott/diverged");
		writeFileSync(join(dw, "b.txt"), "b");
		await must(dw, "add", ".");
		await must(dw, "commit", "-q", "-m", "ahead");
		expect(await branchMergedOrGone(main, "ott/diverged", "main")).toBe(false);
	}, 60_000);
});

describe("parseKeptChoices", () => {
	const kept = ["a.txt", "b.txt"];
	const bad =
		"choices must be an object of file path -> move, ignore, or delete";

	test("rejects non-objects, unknown keys, and bad values", () => {
		expect(parseKeptChoices(null, kept)).toEqual({ error: bad });
		expect(parseKeptChoices([], kept)).toEqual({ error: bad });
		expect(parseKeptChoices("x", kept)).toEqual({ error: bad });
		expect(parseKeptChoices({ "nope.txt": "move" }, kept)).toEqual({
			error: "unknown kept file: nope.txt",
		});
		expect(parseKeptChoices({ "a.txt": "keep" }, kept)).toEqual({
			error: "choice for a.txt must be move, ignore, or delete",
		});
	});

	test("fills missing keys with move and preserves the given ones", () => {
		const r = parseKeptChoices({ "b.txt": "delete" }, kept);
		expect(r).toEqual({ choices: { "a.txt": "move", "b.txt": "delete" } });
		expect(parseKeptChoices({}, kept)).toEqual({
			choices: { "a.txt": "move", "b.txt": "move" },
		});
	});
});

describe("planKeptFinish", () => {
	const exists = (rel: string) => rel === "taken.txt";

	test("first conflicting move wins", () => {
		const r = planKeptFinish(["taken.txt", "taken.txt"], {}, exists);
		expect(r).toEqual({ conflict: "taken.txt" });
	});

	test("partitions by choice with move as default", () => {
		const r = planKeptFinish(
			["a.txt", "b.txt", "c.txt"],
			{ "b.txt": "ignore", "c.txt": "delete" },
			exists,
		);
		expect(r).toEqual({
			moves: ["a.txt"],
			ignores: ["b.txt"],
			deletes: ["c.txt"],
		});
	});
});

describe("ignoreInMain", () => {
	test("creates .git/info/exclude, does not duplicate, skips already-ignored paths", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		const excludePath = join(main, ".git", "info", "exclude");

		await ignoreInMain(main, "reports/out.md");
		expect(
			readFileSync(excludePath, "utf8")
				.split("\n")
				.filter((l) => l === "/reports/out.md"),
		).toHaveLength(1);

		await ignoreInMain(main, "reports/out.md");
		expect(
			readFileSync(excludePath, "utf8")
				.split("\n")
				.filter((l) => l === "/reports/out.md"),
		).toHaveLength(1);

		// A path an existing rule already ignores is not appended again.
		appendFileSync(excludePath, "*.log\n");
		await ignoreInMain(main, "debug.log");
		expect(
			readFileSync(excludePath, "utf8")
				.split("\n")
				.filter((l) => l === "/debug.log"),
		).toHaveLength(0);
	}, 60_000);
});

describe("server writes never follow planted symlinks", () => {
	/** A main checkout with one commit; returns it and its HEAD. */
	async function checkout(): Promise<{ main: string; base: string }> {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		await must(main, "commit", "-q", "--allow-empty", "-m", "init");
		return { main, base: await must(main, "rev-parse", "HEAD") };
	}

	test("ignoreInMain adds a newline before /rel when exclude lacks a trailing one", async () => {
		const { main } = await checkout();
		const excludePath = join(main, ".git", "info", "exclude");
		mkdirSync(join(main, ".git", "info"), { recursive: true });
		writeFileSync(excludePath, "*.tmp");
		await ignoreInMain(main, "out/report.md");
		expect(readFileSync(excludePath, "utf8")).toBe("*.tmp\n/out/report.md\n");
	}, 60_000);

	test.skipIf(process.platform !== "linux")(
		"ignoreInMain refuses a .git/info symlinked outside the checkout",
		async () => {
			const { main } = await checkout();
			const outside = repo();
			rmSync(join(main, ".git", "info"), { recursive: true, force: true });
			symlinkSync(outside, join(main, ".git", "info"));
			await expect(ignoreInMain(main, "debug.out")).rejects.toThrow(/refusing/);
			expect(readdirSync(outside)).toEqual([]);
		},
		60_000,
	);

	test.skipIf(process.platform !== "linux")(
		"createWorktree copies a symlinked AGENTS.md as a link, never the target's content",
		async () => {
			const { main, base } = await checkout();
			const secret = join(repo(), "secret.txt");
			writeFileSync(secret, "top secret\n");
			symlinkSync(secret, join(main, "AGENTS.md"));
			const wt = join(repo(), "wt");
			await createWorktree({
				mainPath: main,
				worktreePath: wt,
				branch: "ott/link",
				base,
				copyExtra: [],
				log: () => {},
			});
			const copy = lstatSync(join(wt, "AGENTS.md"));
			expect(copy.isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(wt, "AGENTS.md"))).toBe(secret);
			expect(readFileSync(secret, "utf8")).toBe("top secret\n");
		},
		60_000,
	);

	test.skipIf(process.platform !== "linux")(
		"createWorktree refuses a symlinked .git/info/exclude and rolls back",
		async () => {
			const { main, base } = await checkout();
			const outside = join(repo(), "exclude");
			writeFileSync(outside, "# outside\n");
			const excludePath = join(main, ".git", "info", "exclude");
			mkdirSync(join(main, ".git", "info"), { recursive: true });
			rmSync(excludePath, { force: true });
			symlinkSync(outside, excludePath);
			writeFileSync(join(main, "AGENTS.md"), "rules\n");
			const wt = join(repo(), "wt");
			await expect(
				createWorktree({
					mainPath: main,
					worktreePath: wt,
					branch: "ott/excl",
					base,
					copyExtra: [],
					log: () => {},
				}),
			).rejects.toThrow(/refusing/);
			expect(readFileSync(outside, "utf8")).toBe("# outside\n");
			expect(existsSync(wt)).toBe(false);
		},
		60_000,
	);

	test.skipIf(process.platform !== "linux")(
		"removeWorktree refuses a .worktrees dir symlinked outside the checkout",
		async () => {
			const { main } = await checkout();
			const outside = repo();
			mkdirSync(join(outside, "OTTR-1"));
			writeFileSync(join(outside, "OTTR-1", "keep.txt"), "keep\n");
			symlinkSync(outside, join(main, ".worktrees"));
			await expect(
				removeWorktree({
					mainPath: main,
					worktreePath: join(main, ".worktrees", "OTTR-1"),
					branch: null,
				}),
			).rejects.toThrow(/refusing/);
			expect(readFileSync(join(outside, "OTTR-1", "keep.txt"), "utf8")).toBe(
				"keep\n",
			);
		},
		60_000,
	);

	test.skipIf(process.platform !== "linux")(
		"removeWorktree unlinks a symlink inside the worktree without emptying its target",
		async () => {
			const { main } = await checkout();
			const outside = repo();
			writeFileSync(join(outside, "keep.txt"), "keep\n");
			// An unregistered dir, so git's own remove fails and removeBelow does the work.
			const wt = join(main, ".worktrees", "OTTR-2");
			mkdirSync(wt, { recursive: true });
			writeFileSync(join(wt, "file.txt"), "x");
			symlinkSync(outside, join(wt, "escape"));
			await removeWorktree({ mainPath: main, worktreePath: wt, branch: null });
			expect(existsSync(wt)).toBe(false);
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
		},
		60_000,
	);

	// git worktree prune (and remove) recurse through a symlinked .git/worktrees/<id> when they
	// delete a stale admin entry: a planted link would empty /app/.tasks as root.
	test.skipIf(process.platform !== "linux")(
		"createWorktree and removeWorktree leave a symlinked admin entry's target intact",
		async () => {
			const { main, base } = await checkout();
			const outside = repo();
			writeFileSync(join(outside, "keep.txt"), "keep\n");
			const admin = join(main, ".git", "worktrees");
			const wt = join(main, ".worktrees", "OTTR-3");
			const plant = () => {
				mkdirSync(admin, { recursive: true });
				symlinkSync(outside, join(admin, "evil"));
				symlinkSync(outside, join(admin, "OTTR-3")); // the card's own entry name
			};
			plant();
			const opts = {
				mainPath: main,
				worktreePath: wt,
				branch: "ott/admin-link",
				base,
				copyExtra: [],
				log: () => {},
			};
			await createWorktree(opts);
			expect(await worktreeLinked(wt)).toBe(true);
			expect(lstatSync(join(admin, "evil"), { throwIfNoEntry: false })).toBe(
				undefined,
			);
			expect(readdirSync(outside)).toEqual(["keep.txt"]);
			symlinkSync(outside, join(admin, "evil"));
			await removeWorktree({ mainPath: main, worktreePath: wt, branch: null });
			expect(existsSync(wt)).toBe(false);
			expect(existsSync(admin) ? readdirSync(admin) : []).toEqual([]);
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
			// A crashed attempt: the dir is gone, the planted links wait for the retry.
			plant();
			await createWorktree(opts);
			expect(await worktreeLinked(wt)).toBe(true);
			expect(readdirSync(outside)).toEqual(["keep.txt"]);
		},
		60_000,
	);

	test.skipIf(process.platform !== "linux")(
		"a symlinked .git/worktrees dir is unlinked, its target stays intact",
		async () => {
			const { main, base } = await checkout();
			const outside = repo();
			mkdirSync(join(outside, "stale"));
			writeFileSync(join(outside, "stale", "keep.txt"), "keep\n");
			symlinkSync(outside, join(main, ".git", "worktrees"));
			const wt = join(main, ".worktrees", "OTTR-4");
			await createWorktree({
				mainPath: main,
				worktreePath: wt,
				branch: "ott/admin-dir-link",
				base,
				copyExtra: [],
				log: () => {},
			});
			expect(await worktreeLinked(wt)).toBe(true);
			expect(lstatSync(join(main, ".git", "worktrees")).isDirectory()).toBe(
				true,
			);
			expect(readFileSync(join(outside, "stale", "keep.txt"), "utf8")).toBe(
				"keep\n",
			);
		},
		60_000,
	);

	test("createWorktree keeps a locked admin entry whose checkout is gone, as git's prune does", async () => {
		const { main, base } = await checkout();
		const wt = join(main, ".worktrees", "OTTR-5");
		await must(main, "worktree", "add", "-q", "-b", "ott/locked", wt);
		await must(main, "worktree", "lock", wt);
		rmSync(wt, { recursive: true, force: true }); // e.g. an unmounted disk
		const entry = join(main, ".git", "worktrees", "OTTR-5");
		await expect(
			createWorktree({
				mainPath: main,
				worktreePath: wt,
				branch: "ott/locked",
				base,
				copyExtra: [],
				log: () => {},
			}),
		).rejects.toThrow(/locked/);
		expect(existsSync(join(entry, "locked"))).toBe(true);
		expect(existsSync(join(entry, "index"))).toBe(true);
	}, 60_000);

	test("ignoreInMain refuses a git dir outside the checkout; that exclude stays unchanged", async () => {
		const main = repo();
		const gitDir = join(repo(), "g");
		await must(
			main,
			"init",
			"-q",
			"-b",
			"main",
			`--separate-git-dir=${gitDir}`,
		);
		const excludePath = join(gitDir, "info", "exclude");
		const before = readFileSync(excludePath, "utf8");
		await expect(ignoreInMain(main, "debug.out")).rejects.toThrow(
			/refusing .*outside/,
		);
		expect(readFileSync(excludePath, "utf8")).toBe(before);
	}, 60_000);

	test.skipIf(process.platform !== "linux")(
		"a project checkout swapped for a symlink below OMP_TRACKER_ROOTS is refused",
		async () => {
			const { main } = await checkout();
			const root = repo();
			const project = join(root, "p");
			symlinkSync(main, project);
			const excludePath = join(main, ".git", "info", "exclude");
			const before = readFileSync(excludePath, "utf8");
			const saved = process.env.OMP_TRACKER_ROOTS;
			process.env.OMP_TRACKER_ROOTS = root;
			try {
				await expect(ignoreInMain(project, "debug.out")).rejects.toThrow(
					/refusing/,
				);
			} finally {
				if (saved === undefined) delete process.env.OMP_TRACKER_ROOTS;
				else process.env.OMP_TRACKER_ROOTS = saved;
			}
			expect(readFileSync(excludePath, "utf8")).toBe(before);
			await ignoreInMain(main, "debug.out");
			expect(readFileSync(excludePath, "utf8")).toContain("/debug.out\n");
		},
		60_000,
	);
});

describe("arch-review survivor kills", () => {
	test("githubRepoName is case-insensitive on scheme, host, and path", () => {
		expect(githubRepoName("HTTPS://GITHUB.COM/Owner/Repo")).toBe("Repo");
		expect(githubRepoName("Git@GitHub.com:owner/repo")).toBe("repo");
		expect(githubRepoName("HTTPS://GITHUB.COM/owner/repo.GIT/")).toBe("repo");
	});

	test("git status failure message carries stderr without trailing whitespace", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "a.txt"), "a");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		writeFileSync(join(main, ".git", "index"), "garbage");
		const err = await statusRows(main).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		const msg = (err as Error).message;
		// stderr prefix varies (error:/fatal:); the message must carry it verbatim.
		expect(msg.startsWith("git status failed: ")).toBe(true);
		expect(msg).toContain("index file smaller than expected");
		// stderr arrives newline-terminated; the reported message must not.
		expect(msg).toBe(msg.trim());
	}, 60_000);

	test("staged renames and staged copies skip the original-path record", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "base.txt"), "x");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		// Copy detection in status is opt-in: without it the second entry reads as an add. Board
		// status ignores repo config (sealedGit), so the opt-in goes into the global config.
		const globalCfg = join(main, ".git", "test-global.gitconfig");
		writeFileSync(globalCfg, "[diff]\n\trenames = copies\n");
		const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = globalCfg;
		await must(main, "mv", "base.txt", "renamed.txt");
		writeFileSync(
			join(main, "copied.txt"),
			readFileSync(join(main, "renamed.txt")),
		);
		await must(main, "add", "copied.txt");

		try {
			const rows = await statusRows(main);
			const rc = rows.filter((r) => /^[RC]/.test(r));
			expect(rc).toHaveLength(2); // one rename, one copy, detected
			// The original-path record of each R/C pair never leaks into the path list.
			expect(await statusFiles(main)).toEqual(["copied.txt", "renamed.txt"]);
		} finally {
			if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
		}
	}, 60_000);

	test("changedFiles: success parses names, failure reads as no changes", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "one.txt"), "1");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "init");
		const base = await must(main, "rev-parse", "HEAD");
		writeFileSync(join(main, "two.txt"), "2");
		await must(main, "add", ".");
		expect(await changedFiles(main, base, "main")).toEqual(["two.txt"]);
		// Broken base and target fail the merge-base and the diff: fail closed to no changes.
		expect(await changedFiles(main, "no-such-ref", "no-such-also")).toEqual([]);
	}, 60_000);

	test("targetCommits: unknown ref and a broken cwd read as null", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main"); // no commits: the ref is unborn
		// rev-list fails on an unborn ref: unreadable, so fail closed to null.
		expect(await targetCommits(main, "main")).toBeNull();
		// git cannot spawn in a nonexistent cwd: the failure path is a real null.
		expect(await targetCommits(join(main, "missing"), "main")).toBeNull();
		expect(await targetCommits(main, "")).toBeNull();
	}, 60_000);
});

describe("git", () => {
	test("sees env set after boot, but never the credential names (D6 strips them from local git)", async () => {
		const keys = [
			"GIT_TRACE",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
		];
		const saved = keys.map((k) => process.env[k]);
		// GIT_TRACE proves runtime env still reaches the child; GIT_CONFIG_* is the
		// credential-helper channel now, so a local call must run without it.
		process.env.GIT_TRACE = "1";
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = "ottr.probe";
		process.env.GIT_CONFIG_VALUE_0 = "runtime";
		try {
			const r = await git(["config", "--get", "ottr.probe"], tmpdir());
			expect(r.stdout.trim()).toBe("");
			expect(r.stderr).toContain("trace: built-in");
		} finally {
			keys.forEach((k, i) => {
				const v = saved[i];
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			});
		}
	});

	// A fake git that hangs forever: the timeout must kill it (exited resolves non-zero fast)
	// and reap it (exec replaces sh with sleep, so the killed pid is the whole process tree).
	// spawnPiped directly: gitExe() resolves through Bun.which at call time, which does not
	// follow a runtime PATH swap, so routing the fake through git() is nondeterministic.
	test("a hung git call is killed at the timeout and leaves no orphan", async () => {
		if (process.platform === "win32") return; // the fake is a sh script
		const bin = mkdtempSync(join(tmpdir(), "ott-fakegit-"));
		const script = join(bin, "git");
		writeFileSync(script, '#!/bin/sh\necho $$ > "$0.pid"\nexec sleep 30\n');
		chmodSync(script, 0o755);
		try {
			const t0 = Date.now();
			const r = await spawnPiped([script], tmpdir(), 200);
			expect(Date.now() - t0).toBeLessThan(5_000);
			expect(r.code).not.toBe(0); // killed, so a failure — never a silent success
			const pid = Number(readFileSync(`${script}.pid`, "utf8"));
			// exited resolving means Bun reaped the killed child; signal 0 would throw ESRCH
			// for a reaped pid but succeed for a live or undead one.
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			rmSync(bin, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("never runs a work-turn-planted core.fsmonitor command (R5-1)", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "f.txt"), "x");
		const script = join(main, "fsmonitor.sh");
		writeFileSync(script, "#!/bin/sh\ntouch planted.fsmonitor\n");
		chmodSync(script, 0o755);
		await must(main, "config", "core.fsmonitor", script);
		const marker = join(main, "planted.fsmonitor");
		// Control: the plant is live — plain git runs the command from status.
		await must(main, "status", "--porcelain");
		expect(existsSync(marker)).toBe(true);
		rmSync(marker);
		// Board git overrides the config on the command line: the planted command cannot run.
		await git(["status", "--porcelain"], main);
		expect(existsSync(marker)).toBe(false);
	}, 60_000);

	test("never runs a work-turn-planted core.hooksPath hook (R5-1)", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		await must(main, "config", "user.name", "ott");
		await must(main, "config", "user.email", "ott@example.invalid");
		const hooks = join(main, "planted-hooks");
		mkdirSync(hooks);
		writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\ntouch planted.hook\n");
		chmodSync(join(hooks, "pre-commit"), 0o755);
		await must(main, "config", "core.hooksPath", hooks);
		const marker = join(main, "planted.hook");
		// Control: the plant is live — plain git runs the planted pre-commit.
		await must(main, "commit", "--allow-empty", "-m", "control");
		expect(existsSync(marker)).toBe(true);
		rmSync(marker);
		// Board git overrides hooksPath on the command line: the planted hook cannot run,
		// and the commit itself still succeeds.
		const r = await git(["commit", "--allow-empty", "-m", "board"], main);
		expect(r.code).toBe(0);
		expect(existsSync(marker)).toBe(false);
	}, 60_000);

	test("never runs a work-turn-planted core.gitProxy for a git:// remote (R5-1)", async () => {
		if (process.platform === "win32") return; // the plant is a sh script
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		const script = join(main, "gitproxy.sh");
		writeFileSync(script, "#!/bin/sh\ntouch planted.gitproxy\n");
		chmodSync(script, 0o755);
		await must(main, "config", "remote.origin.url", "git://127.0.0.1:9/x");
		await must(main, "config", "core.gitProxy", script);
		const marker = join(main, "planted.gitproxy");
		// Control: the plant is live — plain git runs the proxy command for the git://
		// transport. The fetch itself fails (the fake proxy speaks no git protocol).
		Bun.spawnSync([gitExe(), "fetch", "--quiet", "origin"], {
			cwd: main,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(existsSync(marker)).toBe(true);
		rmSync(marker);
		// Board git with the auth env: the git:// transport is not allowed, no proxy command
		// runs, and the fetch fails closed — the tokens never reach a planted program.
		const auth = gitAuthEnv({
			tokens: [],
			key: null,
			knownHosts: "/nonexistent",
		});
		const r = await git(["fetch", "origin"], main, 30_000, auth);
		expect(r.code).not.toBe(0);
		expect(existsSync(marker)).toBe(false);
	}, 60_000);

	test("never runs planted filter, merge or gpg drivers (R5-1)", async () => {
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		await must(main, "config", "user.name", "ott");
		await must(main, "config", "user.email", "ott@example.invalid");
		writeFileSync(join(main, "f.txt"), "one\ntwo\n");
		writeFileSync(
			join(main, ".gitattributes"),
			"* filter=evil merge=evil diff=evil\n",
		);
		// Commit before any driver exists, so plain git runs nothing here.
		await must(main, "add", "-A");
		await must(main, "commit", "-q", "-m", "init");
		const marker = (kind: string) => join(main, `planted.${kind}`);
		const plant = (kind: string, body: string) => {
			const script = join(main, `${kind}.sh`);
			writeFileSync(script, `#!/bin/sh\ntouch '${marker(kind)}'\n${body}`);
			chmodSync(script, 0o755);
			return script;
		};
		const filter = plant("filter", "cat\n");
		const merge = plant("merge", "exit 0\n");
		const gpg = plant("gpg", "exit 1\n");
		for (const [k, v] of [
			["filter.evil.clean", filter],
			["filter.evil.smudge", filter],
			["filter.evil.process", filter],
			["merge.evil.driver", merge],
			["merge.default", "evil"],
			["commit.gpgSign", "true"],
			["tag.gpgSign", "true"],
			["log.showSignature", "true"],
			["gpg.program", gpg],
			["gpg.ssh.program", gpg],
			["gpg.x509.program", gpg],
		] as const)
			await must(main, "config", k, v);
		writeFileSync(
			join(main, ".git", "info", "attributes"),
			"* filter=evil merge=evil\n",
		);
		const attrs = join(main, "planted-attributes");
		writeFileSync(attrs, "* filter=evil merge=evil\n");
		await must(main, "config", "core.attributesFile", attrs);
		const old = new Date(2000, 0, 1);
		// Controls: the plants are live under plain git.
		utimesSync(join(main, "f.txt"), old, old);
		await must(main, "status", "--porcelain");
		expect(existsSync(marker("filter"))).toBe(true);
		rmSync(marker("filter"));
		Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "c"], { cwd: main });
		expect(existsSync(marker("gpg"))).toBe(true);
		// The control commit may also re-run the planted clean filter: clear every marker.
		for (const kind of ["filter", "merge", "gpg"])
			rmSync(marker(kind), { force: true });
		// Board paths: checkout (smudge), status and diff (clean), tag, commit, log (gpg).
		const wt = join(main, ".worktrees", "x");
		await createWorktree({
			mainPath: main,
			worktreePath: wt,
			branch: "ott/x",
			base: "main",
			copyExtra: [],
			log: () => {},
		});
		utimesSync(join(wt, "f.txt"), old, old);
		writeFileSync(join(wt, "f.txt"), "one\nedited\n");
		utimesSync(join(wt, ".gitattributes"), old, old);
		expect(await isClean(wt)).toBe(false);
		await statusRows(wt);
		expect(await changedFiles(wt, "main", "main")).toContain("f.txt");
		await diffStat(wt, "main", "main");
		expect(await diffText(wt, "main", "main")).toContain("+edited");
		expect((await git(["tag", "-a", "v1", "-m", "t"], main)).code).toBe(0);
		// The board commits only in a repo it just made (gitInitWithCommit): an empty index, so
		// no clean filter applies there; the planted signing still must not run.
		const fresh = repo();
		await must(fresh, "init", "-q", "-b", "main");
		await must(fresh, "config", "commit.gpgSign", "true");
		await must(fresh, "config", "gpg.program", gpg);
		const c = [
			"-c",
			"user.name=o",
			"-c",
			"user.email=o@o",
			"commit",
			"--allow-empty",
			"-m",
			"b",
		];
		expect((await git(c, fresh)).code).toBe(0);
		// A signed commit makes a planted log.showSignature verify it with gpg.program.
		const tree = (await must(fresh, "rev-parse", "HEAD^{tree}")).trim();
		const raw = join(fresh, "signed-commit");
		writeFileSync(
			raw,
			`tree ${tree}\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n x\n -----END PGP SIGNATURE-----\n\ns\n`,
		);
		const signed = (
			await must(fresh, "hash-object", "-t", "commit", "-w", raw)
		).trim();
		await must(fresh, "update-ref", "refs/heads/main", signed);
		await must(fresh, "config", "log.showSignature", "true");
		expect((await git(["log", "-1", "--format=%s"], fresh)).code).toBe(0);
		expect((await git(["log", "-1", "--format=%s"], main)).code).toBe(0);
		for (const kind of ["filter", "merge", "gpg"])
			expect(existsSync(marker(kind))).toBe(false);
	}, 60_000);

	test("sees uncommitted submodule edits without running the submodule's planted filter (R5-1)", async () => {
		const sub = repo();
		await must(sub, "init", "-q", "-b", "main");
		writeFileSync(join(sub, "x.txt"), "one\n");
		writeFileSync(join(sub, "y.txt"), "same\n");
		await must(sub, "add", ".");
		await must(sub, "commit", "-q", "-m", "sub");
		const main = repo();
		await must(main, "init", "-q", "-b", "main");
		await must(
			main,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"-q",
			"add",
			sub,
			"sub",
		);
		await must(main, "commit", "-q", "-m", "add sub");
		const base = await must(main, "rev-parse", "HEAD");
		const wt = join(main, ".worktrees", "s");
		await createWorktree({
			mainPath: main,
			worktreePath: wt,
			branch: "ott/s",
			base: "main",
			copyExtra: [],
			log: () => {},
		});
		await must(
			wt,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"-q",
			"update",
			"--init",
		);
		expect(await isClean(wt)).toBe(true);
		// Plant a clean filter in the submodule's own gitdir, then edit a file there.
		const marker = join(main, "planted.subfilter");
		const script = join(main, "subfilter.sh");
		writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
		chmodSync(script, 0o755);
		const subGit = join(wt, "sub");
		await must(subGit, "config", "filter.evil.clean", script);
		const subGitDir = await must(subGit, "rev-parse", "--absolute-git-dir");
		writeFileSync(join(subGitDir, "info", "attributes"), "* filter=evil\n");
		writeFileSync(join(subGit, "x.txt"), "one\ntwo\n");
		// Same size, new mtime: git must hash y.txt, which runs the clean filter in plain git.
		const old = new Date(2000, 0, 1);
		utimesSync(join(subGit, "y.txt"), old, old);
		expect(await isClean(wt)).toBe(false);
		expect(await statusRows(wt)).toEqual([" M sub"]);
		expect(await changedFiles(wt, base, "main")).toEqual(["sub"]);
		expect(await diffStat(wt, base, "main")).toEqual([
			{ file: "sub", plus: 0, minus: 0 },
		]);
		expect(await diffText(wt, base, "main")).toContain("-dirty\n");
		expect(existsSync(marker)).toBe(false);
	}, 60_000);

	test("a blob:none partial clone checks out and diffs through the sealed gitdir", async () => {
		const up = repo();
		await must(up, "init", "-q", "-b", "main");
		await must(up, "config", "uploadpack.allowFilter", "true");
		writeFileSync(join(up, "f.txt"), "old\n");
		await must(up, "add", ".");
		await must(up, "commit", "-q", "-m", "one");
		const base = await must(up, "rev-parse", "HEAD");
		writeFileSync(join(up, "f.txt"), "new\n");
		await must(up, "commit", "-q", "-am", "two");
		const main = join(repo(), "clone");
		await must(
			tmpdir(),
			"clone",
			"-q",
			"--no-checkout",
			"--filter=blob:none",
			`file://${up}`,
			main,
		);
		// The board pins the sealed fetch's ssh (`ssh -F /dev/null`); a fake ssh on PATH
		// answers the git ssh protocol, so the lazy fetches run over the pinned command.
		await must(
			main,
			"config",
			"remote.origin.url",
			`ssh://ottr-fixture.invalid/${up}`,
		);
		const bin = join(main, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "ssh"),
			`#!/bin/sh\nfor a in "$@"; do case "$a" in git-upload-pack*) exec sh -c "git upload-pack \${a#git-upload-pack}";; esac; done\nexit 255\n`,
		);
		chmodSync(join(bin, "ssh"), 0o755);
		const prevPath = process.env.PATH;
		process.env.PATH = `${bin}:${prevPath ?? ""}`;
		try {
			const wt = join(main, ".worktrees", "p");
			// Both the checkout and the diff need blobs the clone has not fetched yet.
			await createWorktree({
				mainPath: main,
				worktreePath: wt,
				branch: "ott/p",
				base: "origin/main",
				copyExtra: [],
				log: () => {},
			});
			expect(readFileSync(join(wt, "f.txt"), "utf8")).toBe("new\n");
			expect(await diffStat(wt, base, base)).toEqual([
				{ file: "f.txt", plus: 1, minus: 1 },
			]);
			expect(await diffText(wt, base, base)).toContain("-old\n+new\n");
		} finally {
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
		}
	}, 60_000);

	test("a lazy promisor fetch runs pinned ssh, never a planted sshCommand (R5-1)", async () => {
		const up = repo();
		await must(up, "init", "-q", "-b", "main");
		await must(up, "config", "uploadpack.allowFilter", "true");
		writeFileSync(join(up, "f.txt"), "old\n");
		await must(up, "add", ".");
		await must(up, "commit", "-q", "-m", "one");
		const base = await must(up, "rev-parse", "HEAD");
		writeFileSync(join(up, "f.txt"), "new\n");
		await must(up, "commit", "-q", "-am", "two");
		const main = join(repo(), "clone");
		await must(
			tmpdir(),
			"clone",
			"-q",
			"--no-checkout",
			"--filter=blob:none",
			`file://${up}`,
			main,
		);
		// The worker's plants: the promisor url points at ssh (the stub copies it) and a
		// global core.sshCommand. On the board ssh also reads ~/.ssh/config from the passwd
		// home, which the shared home volume makes worker-writable; -F /dev/null closes it.
		await must(
			main,
			"config",
			"remote.origin.url",
			`ssh://ottr-fixture.invalid/${up}`,
		);
		const marker = join(main, "planted.sshCommand");
		const script = join(main, "sshCommand.sh");
		writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
		chmodSync(script, 0o755);
		const globalCfg = join(main, ".git", "planted-global.gitconfig");
		writeFileSync(globalCfg, `[core]\n\tsshCommand = ${script}\n`);
		// A fake ssh on PATH logs how the fetch calls it and answers the git ssh protocol,
		// so the pinned command still fetches (no network, no real ssh config read).
		const log = join(main, "ssh-invocation.log");
		const bin = join(main, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "ssh"),
			`#!/bin/sh\n{ echo "$@"; env; } >> '${log}'\nfor a in "$@"; do case "$a" in git-upload-pack*) exec sh -c "git upload-pack \${a#git-upload-pack}";; esac; done\nexit 255\n`,
		);
		chmodSync(join(bin, "ssh"), 0o755);
		const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
		const prevPath = process.env.PATH;
		process.env.GIT_CONFIG_GLOBAL = globalCfg;
		process.env.PATH = `${bin}:${prevPath ?? ""}`;
		try {
			// Control: without the pin, plain git runs the planted sshCommand.
			const plain = { ...process.env } as Record<string, string>;
			delete plain.GIT_SSH_COMMAND;
			const ctl = Bun.spawnSync(
				[gitExe(), "ls-remote", `ssh://ottr-fixture.invalid/${up}`],
				{
					cwd: main,
					env: plain,
					stdout: "ignore",
					stderr: "ignore",
					windowsHide: true,
				},
			);
			expect(ctl.exitCode).not.toBe(0);
			expect(existsSync(marker)).toBe(true);
			rmSync(marker);
			// Board path: the checkout and the diff lazy-fetch blobs through the pinned ssh,
			// and the planted sshCommand never runs.
			const wt = join(main, ".worktrees", "p");
			await createWorktree({
				mainPath: main,
				worktreePath: wt,
				branch: "ott/p",
				base: "origin/main",
				copyExtra: [],
				log: () => {},
			});
			expect(readFileSync(join(wt, "f.txt"), "utf8")).toBe("new\n");
			expect(await diffStat(wt, base, base)).toEqual([
				{ file: "f.txt", plus: 1, minus: 1 },
			]);
			expect(await diffText(wt, base, base)).toContain("-old\n+new\n");
			expect(existsSync(marker)).toBe(false);
			const lines = readFileSync(log, "utf8").split("\n");
			expect(lines[0]?.startsWith("-F /dev/null -o BatchMode=yes")).toBe(true);
			expect(lines).toContain("GIT_ALLOW_PROTOCOL=https:ssh");
		} finally {
			if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
		}
	}, 60_000);

	test("never runs planted diff.external, textconv, uploadpack or receivepack (R5-1)", async () => {
		const main = repo();
		const origin = repo();
		await must(origin, "init", "-q", "--bare", "-b", "main");
		await must(main, "init", "-q", "-b", "main");
		await must(main, "config", "user.name", "ott");
		await must(main, "config", "user.email", "ott@example.invalid");
		writeFileSync(join(main, ".gitattributes"), "f.txt diff=planted\n");
		writeFileSync(join(main, "f.txt"), "a\n");
		await must(main, "add", ".");
		await must(main, "commit", "-q", "-m", "a");
		writeFileSync(join(main, "f.txt"), "b\n");
		const plant = (key: string, name: string) => {
			const script = join(main, `${name}.sh`);
			writeFileSync(
				script,
				`#!/bin/sh\ntouch '${join(main, `planted.${name}`)}'\nexit 1\n`,
			);
			chmodSync(script, 0o755);
			return must(main, "config", key, script);
		};
		await plant("diff.external", "external");
		await plant("diff.planted.textconv", "textconv");
		await must(main, "remote", "add", "origin", origin);
		await plant("remote.origin.uploadpack", "uploadpack");
		await plant("remote.origin.receivepack", "receivepack");
		const planted = () =>
			["external", "textconv", "uploadpack", "receivepack"].filter((n) =>
				existsSync(join(main, `planted.${n}`)),
			);
		// Control: the plants are live — plain git runs them (and fails, as each plant exits 1).
		const plain = (...a: string[]) =>
			Bun.spawnSync([gitExe(), ...a], {
				cwd: main,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
		plain("diff", "HEAD", "--");
		plain("-c", "diff.external=", "diff", "--no-ext-diff", "HEAD", "--");
		plain("fetch", "-q", "origin");
		plain("push", "-q", "origin", "main");
		expect(planted()).toEqual([
			"external",
			"textconv",
			"uploadpack",
			"receivepack",
		]);
		for (const n of planted()) rmSync(join(main, `planted.${n}`));
		// Board git: diffs still render, network calls still work, and no plant runs.
		const d = await git(["diff", "HEAD", "--"], main);
		expect(d.code).toBe(0);
		expect(d.stdout).toContain("+b");
		expect((await git(["log", "-p", "-1", "--"], main)).code).toBe(0);
		expect((await git(["show", "HEAD", "--"], main)).code).toBe(0);
		expect((await git(["push", "-q", "origin", "main"], main)).code).toBe(0);
		expect((await git(["fetch", "-q", "origin"], main)).code).toBe(0);
		expect((await git(["ls-remote", "origin"], main)).code).toBe(0);
		expect(planted()).toEqual([]);
	}, 60_000);

	test("never recurses into a submodule whose config names a command (R5-1)", async () => {
		const subOrigin = repo();
		const origin = repo();
		const main = repo();
		const marker = join(main, "planted.sub");
		const script = join(origin, "plant.sh");
		writeFileSync(script, `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`);
		chmodSync(script, 0o755);
		await must(subOrigin, "init", "-q", "-b", "main");
		writeFileSync(join(subOrigin, "s"), "1\n");
		await must(subOrigin, "add", ".");
		await must(subOrigin, "commit", "-q", "-m", "s");
		await must(origin, "init", "-q", "--bare", "-b", "main");
		await must(main, "init", "-q", "-b", "main");
		await must(main, "remote", "add", "origin", origin);
		const fileOk = ["-c", "protocol.file.allow=always"];
		await must(main, ...fileOk, "submodule", "add", "-q", subOrigin, "sub");
		await must(main, "commit", "-q", "-m", "m");
		await must(main, "push", "-q", "origin", "main");
		// The plants: the submodule's own config names the command, the parent turns recursion on.
		const sub = join(main, "sub");
		await must(sub, "config", "protocol.file.allow", "always");
		await must(sub, "config", "diff.external", script);
		await must(sub, "config", "remote.origin.uploadpack", script);
		await must(sub, "config", "remote.origin.receivepack", script);
		await must(main, "config", "diff.submodule", "diff");
		await must(main, "config", "fetch.recurseSubmodules", "yes");
		await must(main, "config", "push.recurseSubmodules", "on-demand");
		// An unpublished submodule commit makes an on-demand push recurse.
		writeFileSync(join(sub, "s"), "2\n");
		await must(sub, "commit", "-q", "-a", "-m", "s2");
		await must(main, "add", "sub");
		await must(main, "commit", "-q", "-m", "bump");
		const board = [
			["diff", "HEAD~1", "--"],
			["log", "-p", "-1", "--"],
			["show", "HEAD", "--"],
			["fetch", "-q", "origin"],
			["pull", "-q", "--ff-only", "origin", "main"],
			["push", "-q", "origin", "main"],
		];
		// Control: plain git recurses and runs each plant (diff, fetch and push).
		for (const a of [board[0], board[3], board[5]]) {
			Bun.spawnSync(
				[gitExe(), "-c", "core.hooksPath=/dev/null", ...(a as string[])],
				{
					cwd: main,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				},
			);
		}
		const ran = readFileSync(marker, "utf8");
		expect(ran).toContain(subOrigin); // the planted uploadpack and receivepack
		expect(ran.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
		rmSync(marker);
		// Board git: every call succeeds and no plant runs.
		for (const a of board) expect((await git(a, main)).code).toBe(0);
		expect(existsSync(marker)).toBe(false);
	}, 60_000);
});

describe("gitEnv", () => {
	test("network subcommands keep GH_TOKEN, local ones run without it", () => {
		const saved = process.env.GH_TOKEN;
		process.env.GH_TOKEN = "ghp_probe";
		try {
			// clone/fetch/ls-remote/push contact remotes; the credential helper reads the token
			// from the env. A -c global pair is not the subcommand.
			for (const args of [
				["clone", "https://github.com/x/y", "dest"],
				["fetch", "--quiet", "origin"],
				["ls-remote", "--tags", "origin"],
				["push", "origin", "main"],
				["-c", "a=b", "fetch", "origin"],
			]) {
				expect(gitEnv(args).GH_TOKEN).toBe("ghp_probe");
			}
			// Local subcommands must not carry the token where planted config could reach it.
			for (const args of [
				["status", "--porcelain"],
				["rev-parse", "HEAD"],
				["worktree", "prune"],
				["remote", "-v"],
				["config", "--get", "core.fsmonitor"],
			]) {
				expect(gitEnv(args)).not.toHaveProperty("GH_TOKEN");
			}
		} finally {
			if (saved === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = saved;
		}
	});

	test("gitEnv merges its auth env for a fetch; local subcommands get none of it", () => {
		// git() resolves the resolver and passes it here; gitEnv only merges what it gets.
		const env = gitEnv(["fetch", "origin"], {
			GIT_SSH_COMMAND: "ssh -i /resolver-key",
			GIT_CONFIG_COUNT: "1",
		});
		expect(env.GIT_SSH_COMMAND).toBe("ssh -i /resolver-key");
		expect(env.GIT_CONFIG_COUNT).toBe("1");
		// An explicit authEnv replaces the resolver output wholesale: no bleed-through.
		const explicit = gitEnv(["fetch", "origin"], {
			GIT_SSH_COMMAND: "ssh -i /explicit-key",
		});
		expect(explicit.GIT_SSH_COMMAND).toBe("ssh -i /explicit-key");
		expect(explicit).not.toHaveProperty("GIT_CONFIG_COUNT");
	});

	test("gitEnv for local subcommands strips every credential name even from the boot env", () => {
		const names = [
			"GIT_SSH_COMMAND",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
			"OTTR_GIT_TOKEN_0",
			"OTTR_GIT_USER_0",
		];
		const saved: Record<string, string | undefined> = {};
		for (const n of names) {
			saved[n] = process.env[n];
			process.env[n] = `leak-${n}`;
		}
		try {
			for (const args of [["status"], ["commit", "-m", "x"], ["add", "."]]) {
				const env = gitEnv(args);
				for (const n of names) expect(env).not.toHaveProperty(n);
			}
		} finally {
			for (const n of names) {
				if (saved[n] === undefined) delete process.env[n];
				else process.env[n] = saved[n];
			}
		}
	});

	test("git(fetch) passes the resolver env to the git child", async () => {
		const r = repo();
		await must(r, "init", "-q", "-b", "main");
		const record = join(r, "ssh-env.txt");
		const script = join(r, "fake-ssh.sh");
		writeFileSync(script, `#!/bin/sh\nenv > '${record}'\n`, { mode: 0o755 });
		setNetworkGitAuth(() => ({ GIT_SSH_COMMAND: `${script} marker` }));
		try {
			// git runs GIT_SSH_COMMAND for an ssh remote, so the script proves the env reached the child.
			await git(["fetch", "--", "fake-host.example:o/r.git"], r, 30_000);
			expect(readFileSync(record, "utf8")).toContain("GIT_SSH_COMMAND=");
		} finally {
			setNetworkGitAuth(() => ({}));
		}
	}, 60_000);

	test("the strip regex stays in lockstep with gitHosts' auth regex", () => {
		expect(GIT_AUTH_ENV_NAME.source).toBe(GIT_AUTH_ENV_RE.source);
	});
});

// Threshold-60 coverage (2026-10-13): behavior matrices over the exported pure helpers.
// Exact-output assertions so literal/regex/branch mutants in these helpers fail.
describe("worktree helper matrices", () => {
	test("validateCopyPath accepts relative safe paths and rejects each unsafe shape", () => {
		expect(validateCopyPath("")).toBe("path is empty");
		expect(validateCopyPath("   ")).toBe("path is empty");
		expect(validateCopyPath("a\0b")).toBe("path contains NUL");
		expect(validateCopyPath("/etc/ottr")).toBe("path must be relative");
		expect(validateCopyPath("\\\\server\\share")).toBe("path must be relative");
		expect(validateCopyPath("C:\\tools\\x")).toBe("path must be relative");
		expect(validateCopyPath("d:/tools/x")).toBe("path must be relative");
		expect(validateCopyPath("a/../b")).toBe("path must not contain '..'");
		expect(validateCopyPath("..")).toBe("path must not contain '..'");
		expect(validateCopyPath("a/.git/config")).toBe(
			"path must not contain '.git'",
		);
		expect(validateCopyPath(".env")).toBe("env files cannot be copied");
		expect(validateCopyPath("sub/.ENV.local")).toBe(
			"env files cannot be copied",
		);
		expect(validateCopyPath(".envrc")).toBe("env files cannot be copied");
		expect(validateCopyPath("docs/readme.md")).toBeNull();
		expect(validateCopyPath("./a/./b.txt")).toBeNull();
		expect(validateCopyPath("a/")).toBeNull();
	});

	test("slugify lowercases, collapses separators, trims to 32 and falls back to task", () => {
		expect(slugify("Hello World, fix: the thing!")).toBe(
			"hello-world-fix-the-thing",
		);
		expect(slugify("  MixED-Case_Name.go  ")).toBe("mixed-case-name-go");
		expect(slugify("a".repeat(40))).toBe("a".repeat(32));
		expect(slugify("ab".repeat(20) + "-tail")).toBe("ab".repeat(16));
		expect(slugify("????")).toBe("task");
		expect(slugify("")).toBe("task");
		expect(slugify("- already-dashed -")).toBe("already-dashed");
	});

	test("githubRepoName parses https and ssh urls and rejects the rest", () => {
		expect(githubRepoName("https://github.com/o/r")).toBe("r");
		expect(githubRepoName("https://github.com/o/r.git")).toBe("r");
		expect(githubRepoName("https://github.com/o/r/")).toBe("r");
		expect(githubRepoName("git@github.com:o/r.git")).toBe("r");
		expect(githubRepoName("  git@github.com:o2/r-name  ")).toBe("r-name");
		expect(githubRepoName("https://github.com/o/.hidden")).toBeNull();
		expect(githubRepoName("https://gitlab.com/o/r")).toBeNull();
		expect(githubRepoName("https://github.com/o/r/extra")).toBeNull();
		expect(githubRepoName("not a url")).toBeNull();
		expect(githubRepoName("https://github.com/o")).toBeNull();
	});
});

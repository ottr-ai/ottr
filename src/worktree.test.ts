import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { GIT_AUTH_ENV_RE } from "./gitHosts.ts";
import fc from "./test/properties.ts";
import {
	archReviewDelta,
	archReviewDue,
	branchMergedOrGone,
	changedFiles,
	createWorktree,
	diffStat,
	diffText,
	GIT_AUTH_ENV_NAME,
	git,
	gitEnv,
	gitExe,
	githubRepoName,
	githubUrl,
	headVersion,
	httpsRemote,
	ignoreInMain,
	isIntegrated,
	parseKeptChoices,
	parseNumstat,
	planKeptFinish,
	quarantineUntracked,
	redact,
	redactingWriter,
	remoteUrl,
	resolveTarget,
	serverMergePush,
	setGitSecrets,
	setNetworkGitAuth,
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
				(await serverMergePush(f.main, f.wt, "origin/main", "ott/x")).status,
			).toBe("pushed");
			expect(run(f.bare, "rev-parse", "main")).toBe(local);
			// Already on origin: a second call has nothing to do.
			expect(
				await serverMergePush(f.main, f.wt, "origin/main", "ott/x"),
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
				(await serverMergePush(f.main, f.wt, "origin/main", "ott/x")).status,
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
				await serverMergePush(f.main, f.wt, "origin/main", "ott/x"),
			).toEqual({
				status: "skipped",
			});
			expect(run(f.bare, "rev-parse", "main")).toBe(before);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a removed worktree proves the merge by its branch, and a removed branch by main ahead of origin", async () => {
		const f = fixture();
		try {
			run(f.main, "worktree", "remove", f.wt);
			expect(
				(await serverMergePush(f.main, f.wt, "origin/main", "ott/x")).status,
			).toBe("pushed");
			const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
			run(f.main, ...id, "commit", "-q", "--allow-empty", "-m", "next");
			run(f.main, "branch", "-q", "-D", "ott/x");
			expect(
				(await serverMergePush(f.main, f.wt, "origin/main", "ott/x")).status,
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
				await serverMergePush(f.main, f.wt, "origin/main", "ott/x"),
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
			run(
				f.main,
				"remote",
				"set-url",
				"--push",
				"origin",
				join(f.dir, "gone.git"),
			);
			const r = await serverMergePush(f.main, f.wt, "origin/main", "ott/x");
			expect(r.status).toBe("failed");
			expect("error" in r && r.error.length > 0).toBe(true);
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
		expect(await resolveTarget(main, true)).toEqual({
			target: "origin/main",
			sha: b,
			warning: null,
		});
	}, 60_000);

	test("resolveTarget stops on an upstream missing from origin instead of using the local branch", async () => {
		await must(main, "config", "branch.main.merge", "refs/heads/gone");
		try {
			await expect(resolveTarget(main, true)).rejects.toThrow(
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
			const r = await resolveTarget(main, true);
			expect(r).toMatchObject({ target: "origin/main", sha: last });
			expect(r.warning).toBeTruthy();
		} finally {
			await must(main, "remote", "set-url", "origin", origin);
		}
	}, 60_000);

	test("resolveTarget uses a branch without upstream as is and refuses a detached HEAD", async () => {
		await must(main, "checkout", "-q", "-b", "solo");
		try {
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

		const moved = await quarantineUntracked(main, q);
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
		expect(await quarantineUntracked(main, q)).toEqual([]);
		expect(existsSync(join(main, "ignored.log"))).toBe(true);
		expect(existsSync(q)).toBe(false);
	}, 60_000);

	test("does not move a modified tracked file; it still shows in git status", async () => {
		const main = await seeded();
		writeFileSync(join(main, "tracked.txt"), "dirty");
		const q = join(main, ".tasks", "quarantine", "t3");
		expect(await quarantineUntracked(main, q)).toEqual([]);
		expect(readFileSync(join(main, "tracked.txt"), "utf8")).toBe("dirty");
		expect(await statusFiles(main)).toEqual(["tracked.txt"]);
	}, 60_000);

	test("clean worktree: [] and no quarantine dir created", async () => {
		const main = await seeded();
		const q = join(main, ".tasks", "quarantine", "t4");
		expect(await quarantineUntracked(main, q)).toEqual([]);
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
		await quarantineUntracked(main, q);
		expect(readFileSync(join(main, "tracked.txt")).equals(before)).toBe(true);
	}, 60_000);
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
		// Copy detection in status is opt-in: without it the second entry reads as an add.
		await must(main, "config", "diff.renames", "copies");
		await must(main, "mv", "base.txt", "renamed.txt");
		writeFileSync(
			join(main, "copied.txt"),
			readFileSync(join(main, "renamed.txt")),
		);
		await must(main, "add", "copied.txt");

		const rows = await statusRows(main);
		const rc = rows.filter((r) => /^[RC]/.test(r));
		expect(rc).toHaveLength(2); // one rename, one copy, detected
		// The original-path record of each R/C pair never leaks into the path list.
		expect(await statusFiles(main)).toEqual(["copied.txt", "renamed.txt"]);
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

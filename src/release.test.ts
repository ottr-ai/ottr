import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeRelease,
	highestTag,
	includedTasks,
	latestImage,
	ownerRepo,
	parseCommit,
	planRelease,
	publishRelease,
	releaseBlocked,
	runGh,
	runReleaseCommand,
} from "./release.ts";
import fc from "./test/properties.ts";
import { gitExe } from "./worktree.ts";

describe("releaseBlocked", () => {
	type Card = Parameters<typeof releaseBlocked>[0][number];
	let n = 0;
	const card = (p: Partial<Card> = {}): Card => ({
		id: `c${++n}`,
		kind: "work",
		cancelledAt: null,
		releaseVersion: null,
		stage: "todo",
		state: "queued",
		createdAt: 1,
		doneAt: null,
		dependsOn: [],
		followUpOf: null,
		...p,
	});

	test("an unfinished release card blocks a new release", () => {
		expect(
			releaseBlocked(
				[card({ releaseVersion: "v1.2.3", stage: "in_progress" })],
				null,
			),
		).toBe("A release is already in progress.");
	});

	test("an open Review-button review blocks a release: one review at a time", () => {
		expect(
			releaseBlocked(
				[
					card({
						kind: "review",
						stage: "in_progress",
					}),
				],
				null,
			),
		).toBe("A review is already in progress.");
	});

	test("a done or cancelled release card does not block", () => {
		expect(
			releaseBlocked(
				[card({ releaseVersion: "v1.2.3", stage: "done", state: "idle" })],
				null,
			),
		).toBeNull();
		expect(
			releaseBlocked(
				[card({ releaseVersion: "v1.2.3", cancelledAt: 5 })],
				null,
			),
		).toBeNull();
	});

	test("a running merge blocks only when a releaseCommand is set", () => {
		const merging = card({ stage: "merging", state: "running" });
		expect(releaseBlocked([merging], null)).toBeNull();
		expect(releaseBlocked([merging], "npm publish")).toBe(
			"A merge is running. Start the release when it is done.",
		);
	});
	test("releaseBlocked guard edges: partial matches, states, cancelled cards", () => {
		// Only one of two live tasks is a running merge: some (not every) must block.
		expect(
			releaseBlocked(
				[card({ stage: "merging", state: "running" }), card()],
				"npm publish",
			),
		).toBe("A merge is running. Start the release when it is done.");
		// preparing counts as actively merging.
		expect(
			releaseBlocked(
				[card({ stage: "merging", state: "preparing" })],
				"npm publish",
			),
		).toBe("A merge is running. Start the release when it is done.");
		// A finished merge, a non-merging stage, and a cancelled card never block.
		expect(
			releaseBlocked(
				[card({ stage: "merging", state: "idle" })],
				"npm publish",
			),
		).toBeNull();
		expect(
			releaseBlocked(
				[card({ stage: "in_progress", state: "running" })],
				"npm publish",
			),
		).toBeNull();
		expect(
			releaseBlocked(
				[card({ stage: "merging", state: "running", cancelledAt: 9 })],
				"npm publish",
			),
		).toBeNull();
		// A live card without a release version is no in-progress release.
		expect(releaseBlocked([card()], null)).toBeNull();
	});
});

describe("ownerRepo", () => {
	test("owner/name from remote URL shapes", () => {
		expect(ownerRepo("https://github.com/o/r.git")).toBe("o/r");
		expect(ownerRepo("https://github.com/o/r/")).toBe("o/r");
		expect(ownerRepo("https://github.com/o/r")).toBe("o/r");
		expect(ownerRepo("https://gitlab.com/o/r")).toBe("o/r");
		// Real regex behavior: a one-segment path still matches host/segment.
		expect(ownerRepo("https://github.com/o")).toBe("github.com/o");
	});
});

describe("parseCommit", () => {
	test("feat, fix with scope, feat!, BREAKING CHANGE footer, upper-case type", () => {
		expect(parseCommit("feat: add export", "")).toEqual({
			type: "feat",
			scope: null,
			breaking: false,
			description: "add export",
		});
		expect(parseCommit("fix(api): handle null", "")).toEqual({
			type: "fix",
			scope: "api",
			breaking: false,
			description: "handle null",
		});
		expect(parseCommit("feat!: new wire format", "")).toMatchObject({
			type: "feat",
			breaking: true,
		});
		expect(
			parseCommit(
				"feat: new wire format",
				"motivation\nBREAKING CHANGE: wire format changed",
			),
		).toMatchObject({
			breaking: true,
		});
		expect(
			parseCommit(
				"feat: new wire format",
				"BREAKING-CHANGE: wire format changed",
			),
		).toMatchObject({
			breaking: true,
		});
		expect(parseCommit("FEAT: loud", "")).toEqual({
			type: "feat",
			scope: null,
			breaking: false,
			description: "loud",
		});
	});

	test("non-conventional subjects return null", () => {
		expect(parseCommit("Updated the readme", "")).toBeNull();
		expect(parseCommit("fix:", "")).toBeNull();
		expect(parseCommit("fix: ", "")).toBeNull();
		expect(parseCommit("feat(x", "")).toBeNull();
	});
});

describe("highestTag", () => {
	test("highest strictly-semantic vX.Y.Z tag; other lines ignored", () => {
		expect(
			highestTag([
				"v0.9.0",
				"v0.10.0",
				"v1.0",
				"v1.0.0-rc1",
				"1.2.3",
				"notatag",
				"",
			]),
		).toBe("v0.10.0");
		expect(highestTag([])).toBeNull();
	});

	test("property: never throws for arbitrary subject/body; matches are well-formed", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (subject, body) => {
				const c = parseCommit(subject, body);
				if (c === null) return;
				fc.pre(/^[a-zA-Z]/.test(subject));
				expect(c.type).toBe(
					subject.replace(/^([a-zA-Z]+).*/, "$1").toLowerCase(),
				);
				expect(c.description.length).toBeGreaterThan(0);
				expect(c.scope === null || c.scope.length > 0).toBe(true);
			}),
			{
				examples: [
					["fix:", ""],
					["feat(x", ""],
					["Updated the readme", ""],
				],
			},
		);
	});
});

describe("highestTag", () => {
	const tag = fc
		.tuple(fc.nat(50), fc.nat(50), fc.nat(50))
		.map(([a, b, c]) => `v${a}.${b}.${c}`);
	const junk = fc.string().filter((s) => !/^v\d+\.\d+\.\d+$/.test(s.trim()));

	test("property: result is null or a maximal parseable input tag", () => {
		fc.assert(
			fc.property(fc.array(fc.oneof(tag, junk, tag)), (lines) => {
				// Mirror of the implementation's parse: trimmed, strictly vX.Y.Z.
				const parsed: [string, [number, number, number]][] = [];
				for (const line of lines) {
					const m = line.trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);
					if (m)
						parsed.push([
							line.trim(),
							m.slice(1).map(Number) as [number, number, number],
						]);
				}
				const best = highestTag(lines);
				if (parsed.length === 0) {
					expect(best).toBeNull();
					return;
				}
				const geq = (
					a: readonly [number, number, number],
					b: readonly [number, number, number],
				) =>
					a[0] !== b[0]
						? a[0] > b[0]
						: a[1] !== b[1]
							? a[1] > b[1]
							: a[2] >= b[2];
				const max = parsed.reduce((a, b) =>
					geq(b[1], a[1]) && !geq(a[1], b[1]) ? b : a,
				);
				expect(best).toBe(max[0]);
				expect(parsed.every(([, n]) => geq(max[1], n))).toBe(true);
			}),
		);
	});
});

describe("computeRelease", () => {
	const one = (subject: string, body = "") => [{ subject, body }];

	test("version rules", () => {
		expect(computeRelease(null, one("a"))).toMatchObject({
			version: "v0.1.0",
			releasable: true,
		});
		expect(computeRelease("v1.2.3", one("fix: b")).version).toBe("v1.2.4");
		expect(computeRelease("v1.2.3", one("feat: b")).version).toBe("v1.3.0");
		expect(computeRelease("v0.4.0", one("feat!: b")).version).toBe("v0.5.0");
		expect(
			computeRelease("v1.2.3", one("feat: b", "BREAKING CHANGE: c")).version,
		).toBe("v2.0.0");
		// Only unlisted types: a version is still computed, but nothing is releasable.
		expect(computeRelease("v1.0.0", one("docs: d"))).toMatchObject({
			version: "v1.0.1",
			releasable: false,
		});
		expect(computeRelease("v1.0.0", one("chore: d")).releasable).toBe(false);
	});

	test("notes format", () => {
		expect(computeRelease(null, one("a")).notes).toBe("First release.");
		// Section order and scope prefix, capital first letter.
		expect(
			computeRelease("v1.0.0", [
				...one("fix(ui): render bug"),
				...one("feat: add export"),
			]).notes,
		).toBe(
			"## New features\n\n- Add export\n\n## Bug fixes\n\n- ui: Render bug",
		);
		// Only non-empty sections.
		expect(computeRelease("v1.0.0", one("fix: b")).notes).toBe(
			"## Bug fixes\n\n- B",
		);
		// Non-conventional and other listed types land under Changes; unlisted breaking too.
		expect(
			computeRelease("v1.0.0", [
				...one("perf: speed"),
				...one("Updated deps"),
				...one("chore!: drop node 16"),
			]).notes,
		).toBe(
			"## Changes\n\n- Speed\n- Updated deps\n- **Breaking:** Drop node 16",
		);
		// Breaking listed commits keep their section and gain the prefix.
		expect(computeRelease("v1.0.0", one("feat!: new api")).notes).toBe(
			"## New features\n\n- **Breaking:** New api",
		);
		// Identical bullets appear once.
		expect(
			computeRelease("v1.0.0", [...one("fix: same"), ...one("fix: same")])
				.notes,
		).toBe("## Bug fixes\n\n- Same");
	});
});

describe("includedTasks", () => {
	// Rows in creation order with a growing target-commits counter; a no-op card repeats the count.
	const t = (
		id: string,
		commits: number | null,
		doneAt: number,
		extra: Partial<Parameters<typeof includedTasks>[0][number]> = {},
	) => ({
		id,
		title: `task ${id}`,
		stage: "done" as const,
		cancelledAt: null,
		releaseVersion: null,
		doneAt,
		commits,
		...extra,
	});

	test("window, order and no-op drop", () => {
		// v0.3.0's tagged commit landed at 100; card a merged before it (out), cards b..d after.
		const rows = [
			t("a", 10, 90),
			t("b", 13, 110), // 3 commits of its own
			t("q", 13, 120), // question-only: moved the target by zero
			t("c", null, 130), // unmeasured counter: kept rather than hidden
			t("d", 16, 140),
			t("r", 5, 150, { releaseVersion: "v0.4.0" }), // release card itself
			t("x", 17, 160, { cancelledAt: 1 }), // cancelled
			t("y", 99, 170, { stage: "in_progress" as const }), // not done
		];
		expect(includedTasks(rows, 100)).toEqual([
			{ id: "b", title: "task b" },
			{ id: "c", title: "task c" },
			{ id: "d", title: "task d" },
		]);
	});

	test("baseline is the target count at the last release, not zero", () => {
		// b repeats the pre-release count: a card merged between b's branch and the tag
		// would carry its own work, so a zero delta still means "nothing of its own".
		const rows = [t("old", 12, 50), t("b", 12, 110), t("c", 14, 120)];
		expect(includedTasks(rows, 100)).toEqual([{ id: "c", title: "task c" }]);
	});

	test("first release (since 0): leading no-op dropped, the rest kept", () => {
		const rows = [t("q", 0, 10), t("b", 3, 20)];
		expect(includedTasks(rows, 0)).toEqual([{ id: "b", title: "task b" }]);
	});
});

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

/** git for fixtures with a throwaway identity — never the git() under test (see release.test.ts). */
function must(cwd: string, ...args: string[]): string {
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

describe("against real repos", () => {
	// A bare "origin" and a main checkout whose main tracks origin/main. Real git spawns are slow
	// (see worktree.test.ts), hence the 60 s ceilings.
	let root = "";
	let origin = "";
	let main = "";
	let a = "";
	let feat = "";
	let head = "";
	let side = "";
	beforeAll(async () => {
		sweepStaleFixtures("ott-release-test-");
		root = mkdtempSync(join(tmpdir(), "ott-release-test-"));
		origin = join(root, "origin.git");
		main = join(root, "main");
		await must(root, "init", "-q", "--bare", "-b", "main", origin);
		await must(root, "init", "-q", "-b", "main", main);
		// publishRelease runs its own `git tag -a`, which needs a committer identity the
		// fixture's -c flags don't cover; CI runners have no global git identity.
		await must(main, "config", "user.name", "ott");
		await must(main, "config", "user.email", "ott@example.invalid");
		await must(main, "commit", "-q", "--allow-empty", "-m", "a");
		await must(main, "remote", "add", "origin", origin);
		await must(main, "push", "-q", "-u", "origin", "main");
		a = await must(main, "rev-parse", "HEAD");
	}, 60_000);
	afterAll(
		() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
		60_000,
	);

	test("planRelease without tags: the first release", async () => {
		const plan = await planRelease({
			mainPath: main,
			target: "origin/main",
			sha: a,
		});
		expect(plan).toEqual({
			sha: a,
			from: null,
			version: "v0.1.0",
			notes: "First release.",
			commits: 1,
			blocked: null,
		});
	}, 60_000);

	test("after v0.1.0, feat and fix give v0.2.0 with both bullets", async () => {
		await must(main, "tag", "-a", "v0.1.0", "-m", "v0.1.0", a);
		await must(main, "push", "-q", "origin", "refs/tags/v0.1.0");
		await must(main, "commit", "-q", "--allow-empty", "-m", "feat: x");
		feat = await must(main, "rev-parse", "HEAD");
		await must(main, "commit", "-q", "--allow-empty", "-m", "fix: y");
		head = await must(main, "rev-parse", "HEAD");
		await must(main, "push", "-q", "origin", "main");
		const plan = await planRelease({
			mainPath: main,
			target: "origin/main",
			sha: head,
		});
		expect(plan).toEqual({
			sha: head,
			from: "v0.1.0",
			version: "v0.2.0",
			notes: "## New features\n\n- X\n\n## Bug fixes\n\n- Y",
			commits: 2,
			blocked: null,
		});
	}, 60_000);

	test("an explicit sha behind the head keeps that sha and drops the later commit", async () => {
		const plan = await planRelease({
			mainPath: main,
			target: "origin/main",
			sha: feat,
		});
		expect(plan.sha).toBe(feat);
		expect(plan).toMatchObject({
			version: "v0.2.0",
			notes: "## New features\n\n- X",
			commits: 1,
			blocked: null,
		});
	}, 60_000);

	test("a sha not on the target is blocked", async () => {
		await must(main, "switch", "-q", "-c", "side");
		await must(main, "commit", "-q", "--allow-empty", "-m", "side work");
		side = await must(main, "rev-parse", "HEAD");
		await must(main, "switch", "-q", "main");
		const plan = await planRelease({
			mainPath: main,
			target: "origin/main",
			sha: side,
		});
		expect(plan.blocked).toBe(
			`Commit ${side.slice(0, 7)} is not on origin/main.`,
		);
	}, 60_000);

	test("a computed version whose tag already exists on an unmerged commit is blocked", async () => {
		// Not at the head: a tag merged into the head would become `from` instead.
		await must(main, "tag", "-a", "v0.2.0", "-m", "v0.2.0", side);
		const plan = await planRelease({
			mainPath: main,
			target: "origin/main",
			sha: head,
		});
		expect(plan.blocked).toBe("Tag v0.2.0 already exists.");
	}, 60_000);

	test("an invalid sha is blocked with the given text and kept as plan.sha", async () => {
		const bad = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		const plan = await planRelease({
			mainPath: main,
			target: "origin/main",
			sha: bad,
		});
		expect(plan.sha).toBe(bad);
		expect(plan.blocked).toBe(
			`Commit ${bad.slice(0, 7)} is not on origin/main.`,
		);
	}, 60_000);

	test("publishRelease tags the given sha, pushes it, and is idempotent", async () => {
		const log = await publishRelease({
			mainPath: main,
			reviewed: feat,
			sha: feat,
			version: "v0.9.0",
			notes: "n",
			github: null,
		});
		expect(log).toBe(`tagged v0.9.0 at ${feat.slice(0, 7)}, pushed`);
		// Annotated tag, message = version, pointing at the given sha even though the head moved on.
		expect(await must(main, "cat-file", "-t", "refs/tags/v0.9.0")).toBe("tag");
		expect(
			await must(
				main,
				"for-each-ref",
				"--format=%(contents:subject)",
				"refs/tags/v0.9.0",
			),
		).toBe("v0.9.0");
		expect(await must(main, "rev-parse", "refs/tags/v0.9.0^{commit}")).toBe(
			feat,
		);
		expect(await must(main, "ls-remote", "--tags", origin)).toContain(
			"refs/tags/v0.9.0",
		);

		// A second identical call succeeds and changes nothing.
		await publishRelease({
			mainPath: main,
			reviewed: feat,
			sha: feat,
			version: "v0.9.0",
			notes: "n",
			github: null,
		});
		expect(await must(main, "rev-parse", "refs/tags/v0.9.0^{commit}")).toBe(
			feat,
		);
	}, 60_000);

	test("publishRelease rejects a version that already points at another commit", async () => {
		await expect(
			publishRelease({
				mainPath: main,
				reviewed: feat,
				sha: head,
				version: "v0.9.0",
				notes: "n",
				github: null,
			}),
		).rejects.toThrow(/already exists/);
		expect(await must(main, "rev-parse", "refs/tags/v0.9.0^{commit}")).toBe(
			feat,
		);
	}, 60_000);

	test("publishRelease tags a head past the reviewed commit and lists the later commits as late fixes", async () => {
		// The fake gh is a sh script: off Windows it also records the notes the release gets.
		const sh = process.platform !== "win32";
		const bin = mkdtempSync(join(tmpdir(), "ott-fakegh-"));
		const script = join(bin, "gh");
		writeFileSync(
			script,
			'#!/bin/sh\n[ "$2" = view ] && exit 1\nwhile [ $# -gt 0 ]; do [ "$1" = --notes ] && printf %s "$2" > "$0.notes"; shift; done\n',
		);
		chmodSync(script, 0o755);
		const saved = process.env.PATH;
		if (sh) process.env.PATH = `${bin}:${saved}`;
		try {
			const log = await publishRelease({
				mainPath: main,
				reviewed: feat,
				sha: head,
				version: "v0.9.1",
				notes: "## New features\n\n- X",
				github: sh ? "https://github.com/o/r" : null,
			});
			expect(log).toStartWith(
				`tagged v0.9.1 at ${head.slice(0, 7)} (late fixes: 1), pushed`,
			);
			expect(await must(main, "rev-parse", "refs/tags/v0.9.1^{commit}")).toBe(
				head,
			);
			if (sh)
				expect(readFileSync(`${script}.notes`, "utf8")).toBe(
					"## New features\n\n- X\n\n## Late fixes\n\n- fix: y",
				);
		} finally {
			process.env.PATH = saved;
			rmSync(bin, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 60_000);

	test("publishRelease refuses a head without the reviewed commit and tags nothing", async () => {
		await expect(
			publishRelease({
				mainPath: main,
				reviewed: side,
				sha: head,
				version: "v0.9.2",
				notes: "n",
				github: null,
			}),
		).rejects.toThrow(
			`${head.slice(0, 7)} does not contain the reviewed commit ${side.slice(0, 7)}`,
		);
		expect(await must(main, "tag", "--list", "v0.9.2")).toBe("");
	}, 60_000);
});

/** Stand-in release command: records what it got, then does what the mode says. Runs with bun. */
const FAKE_COMMAND = `
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [mode, record] = process.argv.slice(2);
const { OTTR_RELEASE_VERSION: v, OTTR_RELEASE_COMMIT: c, OTTR_RELEASE_NOTES_FILE: n, OTTR_ARCH_REVIEW: a } = process.env;
const git = (...args) => {
  const id = ["-c", "user.name=ott", "-c", "user.email=ott@example.invalid", "-c", "commit.gpgsign=false"];
  const r = spawnSync(process.env.OTT_GIT_EXE || "git", [...id, ...args], { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr); process.exit(9); }
  return r.stdout.trim();
};
writeFileSync(record, JSON.stringify({ v, c, notes: readFileSync(n, "utf8"), head: git("rev-parse", "HEAD"), a }));
// stdout and stderr are read concurrently, so the failing mode prints to one stream only.
if (mode === "fail") { console.error("boom"); process.exit(3); }
console.log("releasing " + v);
if (mode === "sidetag") { git("tag", v, c + "~1"); git("push", "-q", "origin", "refs/tags/" + v); }
if (mode === "ok" || mode === "offmain" || mode === "local") {
  git("commit", "-q", "--allow-empty", "-m", "chore(release): " + v);
  git("tag", v);
  if (mode === "ok") git("push", "-q", "--atomic", "origin", "HEAD:refs/heads/main", "refs/tags/" + v);
  if (mode === "offmain") git("push", "-q", "origin", "refs/tags/" + v);
  if (mode === "local") git("update-ref", "refs/heads/main", "HEAD");
}
`;

describe("runReleaseCommand against real repos", () => {
	let root = "";
	let main = "";
	let fake = "";
	let record = "";
	let notesFile = "";
	let seq = 0;
	beforeAll(() => {
		// FAKE_COMMAND runs as a separate process and cannot import gitExe; inherit it via env.
		process.env.OTT_GIT_EXE = gitExe();
		sweepStaleFixtures("ott-release-command-test-");
		root = mkdtempSync(join(tmpdir(), "ott-release-command-test-"));
		main = join(root, "main");
		must(root, "init", "-q", "--bare", "-b", "main", join(root, "origin.git"));
		must(root, "init", "-q", "-b", "main", main);
		must(main, "commit", "-q", "--allow-empty", "-m", "a");
		must(main, "remote", "add", "origin", join(root, "origin.git"));
		must(main, "push", "-q", "-u", "origin", "main");
		fake = join(root, "fake-release.mjs");
		writeFileSync(fake, FAKE_COMMAND);
		record = join(root, "record.json");
		notesFile = join(root, "notes.md");
		writeFileSync(notesFile, "## New features\n\n- N");
	}, 60_000);
	afterAll(() => {
		delete process.env.OTT_GIT_EXE;
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}, 60_000);

	/** A new reviewed commit on origin/main, checked out in its own worktree like a release card's. */
	function reviewed(repo = main, push = true): { sha: string; wt: string } {
		if (push) {
			must(repo, "fetch", "-q", "origin");
			must(repo, "reset", "-q", "--hard", "origin/main");
		}
		must(repo, "commit", "-q", "--allow-empty", "-m", `feat: n${++seq}`);
		if (push) must(repo, "push", "-q", "origin", "main");
		const sha = must(repo, "rev-parse", "HEAD");
		const wt = join(root, `wt${seq}`);
		must(repo, "worktree", "add", "-q", "--detach", wt, sha);
		return { sha, wt };
	}
	const run = (
		mode: string,
		sha: string,
		wt: string,
		version: string,
		extra: {
			mainPath?: string;
			target?: string;
			log?: (l: string) => void;
			archReview?: { delta: number } | null;
		} = {},
	) =>
		runReleaseCommand({
			command: `"${process.execPath}" "${fake}" ${mode} "${record}"`,
			cwd: wt,
			mainPath: extra.mainPath ?? main,
			target: extra.target ?? "origin/main",
			sha,
			version,
			notesFile,
			archReview: extra.archReview,
			log: extra.log ?? (() => {}),
		});

	test("runs in the worktree with the release env; a pushed tag on the target that holds the commit passes", async () => {
		const { sha, wt } = reviewed();
		const lines: string[] = [];
		const out = await run("ok", sha, wt, "v1.0.0", {
			log: (l) => lines.push(l),
		});
		const tagged = must(main, "rev-parse", "refs/tags/v1.0.0^{commit}");
		expect(out).toBe(
			`release command published v1.0.0 at ${tagged.slice(0, 7)}`,
		);
		expect(must(main, "rev-parse", `${tagged}^`)).toBe(sha);
		expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
			v: "v1.0.0",
			c: sha,
			notes: "## New features\n\n- N",
			head: sha,
		});
		expect(lines).toContain("releasing v1.0.0");
	}, 60_000);

	test("hands the arch-review delta to the command env", async () => {
		const { sha, wt } = reviewed();
		await run("ok", sha, wt, "v1.9.9", { archReview: { delta: 9 } });
		expect(JSON.parse(readFileSync(record, "utf8")).a).toBe("9");
	}, 60_000);

	test("a failing command fails with its exit code and last output line", async () => {
		const { sha, wt } = reviewed();
		await expect(run("fail", sha, wt, "v1.0.1")).rejects.toThrow(
			"release command exited with code 3: boom",
		);
	}, 60_000);

	test("a command that is not on PATH fails with a readable reason", async () => {
		const { sha, wt } = reviewed();
		const missing = runReleaseCommand({
			command: "ott-no-such-release-command --ottr",
			cwd: wt,
			mainPath: main,
			target: "origin/main",
			sha,
			version: "v1.0.2",
			notesFile,
			log: () => {},
		});
		await expect(missing).rejects.toThrow(
			"release command not found: ott-no-such-release-command",
		);
	}, 60_000);

	test("exit 0 without a pushed tag fails", async () => {
		const { sha, wt } = reviewed();
		await expect(run("notag", sha, wt, "v1.0.3")).rejects.toThrow(
			"the release command did not push tag v1.0.3",
		);
	}, 60_000);

	test("a tag that lacks the reviewed commit fails", async () => {
		const { sha, wt } = reviewed();
		await expect(run("sidetag", sha, wt, "v1.0.4")).rejects.toThrow(
			/does not contain the reviewed commit/,
		);
	}, 60_000);

	test("a tag that is not on the target fails", async () => {
		const { sha, wt } = reviewed();
		await expect(run("offmain", sha, wt, "v1.0.5")).rejects.toThrow(
			/is not on origin\/main/,
		);
	}, 60_000);

	test("without an origin, a local tag on the local target passes", async () => {
		const solo = join(root, "solo");
		must(root, "init", "-q", "-b", "main", solo);
		must(solo, "commit", "-q", "--allow-empty", "-m", "a");
		const { sha, wt } = reviewed(solo, false);
		const out = await run("local", sha, wt, "v2.0.0", {
			mainPath: solo,
			target: "main",
		});
		expect(out).toMatch(/^release command published v2\.0\.0 at /);
	}, 60_000);
});

describe("latestImage", () => {
	/** Stub global fetch; routes is a URL-substring → JSON-body-or-status map. Returns calls + restore. */
	function stubFetch(routes: Record<string, unknown>): {
		calls: string[];
		restore: () => void;
	} {
		const calls: string[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			for (const [match, res] of Object.entries(routes))
				if (url.includes(match))
					return new Response(
						typeof res === "number" ? "" : JSON.stringify(res),
						{ status: typeof res === "number" ? res : 200 },
					);
			return new Response("", { status: 404 });
		}) as typeof fetch;
		return {
			calls,
			restore: () => {
				globalThis.fetch = real;
			},
		};
	}

	test("public image: highest v-tag, lowercase registry scope, package page URL", async () => {
		const { calls, restore } = stubFetch({
			"ghcr.io/token": { token: "t" },
			"/tags/list": { tags: ["0.3.0", "latest", "v0.2.0", "v0.10.0"] },
		});
		try {
			expect(await latestImage("Owner/Repo")).toEqual({
				tag: "v0.10.0",
				url: "https://github.com/Owner/Repo/pkgs/container/repo",
			});
			expect(calls[0]).toContain("scope=repository:owner/repo:pull");
			// n=1000: ghcr pages at 100 tags oldest-first without it, hiding the newest.
			expect(calls[1]).toContain("/v2/owner/repo/tags/list?n=1000");
		} finally {
			restore();
		}
	});

	test("no public image: null, no throw", async () => {
		const { restore } = stubFetch({
			"ghcr.io/token": { token: "t" },
			"/tags/list": 404,
		});
		try {
			expect(await latestImage("o/r")).toBeNull();
		} finally {
			restore();
		}
	});

	test("token endpoint failure: null, no throw", async () => {
		const { restore } = stubFetch({ "ghcr.io/token": 401 });
		try {
			expect(await latestImage("o/r")).toBeNull();
		} finally {
			restore();
		}
	});
});

// A fake gh that hangs forever: the timeout must kill it (exited resolves non-zero fast)
// and reap it (exec replaces sh with sleep, so the killed pid is the whole process tree).
describe("runGh timeout", () => {
	test("a hung gh call is killed at the timeout and leaves no orphan", async () => {
		if (process.platform === "win32") return; // the fake is a sh script
		const bin = mkdtempSync(join(tmpdir(), "ott-fakegh-"));
		const script = join(bin, "gh");
		writeFileSync(script, '#!/bin/sh\necho $$ > "$0.pid"\nexec sleep 30\n');
		chmodSync(script, 0o755);
		const saved = process.env.PATH;
		process.env.PATH = `${bin}:${saved}`;
		try {
			const t0 = Date.now();
			const r = await runGh(["api", "x"], 200);
			expect(Date.now() - t0).toBeLessThan(5_000);
			expect(r.code).not.toBe(0); // killed, so a failure — never a silent success
			const pid = Number(readFileSync(`${script}.pid`, "utf8"));
			// exited resolving means Bun reaped the killed child; signal 0 would throw ESRCH
			// for a reaped pid but succeed for a live or undead one.
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			process.env.PATH = saved;
			rmSync(bin, { recursive: true, force: true, maxRetries: 5 });
		}
	});
});

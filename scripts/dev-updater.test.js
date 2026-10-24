// Regression test for the dev-updater restart guard (R8-11): a checkout whose
// main cannot fast-forward to origin/main must never stop or restart the board.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExe } from "../src/worktree.ts";
import { check } from "./dev-updater.mjs";

const root = mkdtempSync(join(tmpdir(), "ottr-dev-updater-"));
afterAll(
	() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
	60_000,
);

/** git with a throwaway identity for fixtures — never the git dep under test. */
function must(cwd, ...args) {
	const r = spawnSync(
		gitExe(),
		[
			"-c",
			"user.name=ott",
			"-c",
			"user.email=ott@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"init.defaultBranch=main",
			...args,
		],
		{ cwd, encoding: "utf8" },
	);
	if (r.status !== 0)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

const rev = (cwd, ref) => must(cwd, "rev-parse", ref);

/** A bare origin plus a clone on main, both inside the temp root. */
function checkout(name) {
	const origin = join(root, `${name}-origin`);
	const work = join(root, name);
	must(root, "init", "--bare", "--initial-branch=main", origin);
	must(root, "clone", origin, work);
	must(work, "commit", "--allow-empty", "-m", "base");
	must(work, "push", "origin", "main");
	return { origin, work };
}

/** check() deps: real git in `work`, a stale served version, recorded effects. */
function deps(work) {
	const calls = { stop: 0, start: 0 };
	return {
		calls,
		// Same shape as the real git dep: one array of arguments.
		git: (args) => spawnSync(gitExe(), args, { cwd: work, encoding: "utf8" }),
		// The real board serves the checked-out build once restarted.
		served: async () =>
			calls.start > 0 ? rev(work, "HEAD") : "stale-served-version",
		idle: async () => true,
		stop: async () => {
			calls.stop += 1;
		},
		start: () => {
			calls.start += 1;
			return {};
		},
		install: () => ({ status: 0 }),
	};
}

describe("dev-updater check guard", () => {
	test("ahead, diverged and detached checkouts never restart the board", async () => {
		// Local main has an unpushed commit: not a fast-forward to origin/main.
		const ahead = checkout("ahead");
		must(ahead.work, "commit", "--allow-empty", "-m", "unpushed");

		// Local main and origin/main both moved: diverged.
		const diverged = checkout("diverged");
		const other = join(root, "diverged-other");
		must(root, "clone", diverged.origin, other);
		must(diverged.work, "commit", "--allow-empty", "-m", "local-only");
		must(other, "commit", "--allow-empty", "-m", "remote-only");
		must(other, "push", "origin", "main");

		// Detached HEAD: not on any branch.
		const detached = checkout("detached");
		must(detached.work, "checkout", "--detach");

		// Each state leaves the board and checkout alone.
		for (const { work } of [ahead, diverged, detached]) {
			const before = rev(work, "HEAD");
			const d = deps(work);
			await check(d);
			expect(d.calls.stop).toBe(0);
			expect(d.calls.start).toBe(0);
			expect(rev(work, "HEAD")).toBe(before);
		}
	});

	// Regression: after the board's own merge or a manual update, HEAD can already be
	// origin/main while the board still serves the older build. It must restart once,
	// then hold steady on the next check.
	test("HEAD already at origin/main with a stale served build restarts exactly once", async () => {
		// HEAD === origin/main from the start; only the served version is stale.
		const up = checkout("uptodate");
		const d = deps(up.work);

		await check(d);
		expect(d.calls.stop).toBe(1);
		expect(d.calls.start).toBe(1);
		expect(rev(up.work, "HEAD")).toBe(rev(up.origin, "main"));

		await check(d);
		expect(d.calls.stop).toBe(1);
		expect(d.calls.start).toBe(1);
	});

	// Control: the seam must see a restart when one is due, so the guard test
	// above cannot pass vacuously.
	test("a fast-forwardable origin/main still stops, merges and starts once", async () => {
		const ff = checkout("ff");
		const stale = rev(ff.work, "HEAD");
		const other = join(root, "ff-other");
		must(root, "clone", ff.origin, other);
		must(other, "commit", "--allow-empty", "-m", "next");
		must(other, "push", "origin", "main");

		const d = { ...deps(ff.work), served: async () => stale };
		await check(d);
		expect(d.calls.stop).toBe(1);
		expect(d.calls.start).toBe(1);
		expect(rev(ff.work, "HEAD")).toBe(rev(ff.origin, "main"));
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedGh, publishRelease, runReleaseCommand } from "./release.ts";
import { setHostedGitAuth } from "./worktree.ts";

// Fake gh and a sh release command: POSIX only, like the release.test.ts notes checks.
const posix = process.platform !== "win32";
const REMOTE = "https://github.com/o/r";

let root: string;
let repo: string;
let sha: string;
let bin: string;
let record: string;

const sh = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", ...args], { cwd });
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	return r.stdout.toString().trim();
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ott-hosted-release-"));
	repo = join(root, "repo");
	sh(root, "init", "-q", "-b", "main", repo);
	sh(repo, "config", "user.name", "t");
	sh(repo, "config", "user.email", "t@example.com");
	sh(repo, "commit", "-q", "--allow-empty", "-m", "feat: x");
	sha = sh(repo, "rev-parse", "HEAD");
	bin = join(root, "bin");
	mkdirSync(bin);
	record = join(root, "gh.log");
	// Records the token and the subcommand of every call; `release view` misses so create runs.
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/sh\nprintf '%s %s %s\\n' "\${GH_TOKEN:-none}" "$1" "$2" >> "${record}"\n[ "$2" = view ] && exit 1\nexit 0\n`,
	);
	chmodSync(join(bin, "gh"), 0o755);
});

afterAll(() => {
	setHostedGitAuth(null);
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function withEnv<T>(
	vars: Record<string, string>,
	fn: () => Promise<T>,
): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		saved[k] = process.env[k];
		process.env[k] = vars[k];
	}
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

describe.skipIf(!posix)("hosted release boundary", () => {
	test("the release command never receives OTTR_HOSTED_SECRET", async () => {
		const out = join(root, "secret.out");
		await withEnv({ OTTR_HOSTED_SECRET: "signing-key" }, async () => {
			// The command records the env and pushes no tag, so the run fails after it.
			await expect(
				runReleaseCommand({
					command: `sh -c "printf %s \${OTTR_HOSTED_SECRET:-absent} > ${out}"`,
					cwd: repo,
					mainPath: repo,
					originUrl: null,
					target: "main",
					sha,
					version: "v0.0.1",
					notesFile: join(root, "notes.md"),
					log: () => {},
				}),
			).rejects.toThrow();
		});
		expect(readFileSync(out, "utf8")).toBe("absent");
	}, 60_000);

	test("hosted publishRelease runs every gh call with the minted token, never GH_TOKEN", async () => {
		writeFileSync(record, "");
		const asked: string[] = [];
		setHostedGitAuth({
			network: async () => {
				throw new Error("no network git in this test");
			},
			ghToken: async (cwd, remote) => {
				asked.push(`${cwd} ${remote}`);
				return "minted-project";
			},
		});
		try {
			await withEnv(
				{ GH_TOKEN: "global-board", PATH: `${bin}:${process.env.PATH}` },
				async () => {
					const line = await publishRelease({
						mainPath: repo,
						reviewed: sha,
						sha,
						version: "v1.0.0",
						notes: "n",
						github: REMOTE,
						originUrl: null,
						gh: await hostedGh(repo, REMOTE),
					});
					expect(line).toContain("GitHub release");
				},
			);
		} finally {
			setHostedGitAuth(null);
		}
		expect(asked).toEqual([`${repo} ${REMOTE}`]);
		expect(readFileSync(record, "utf8")).toBe(
			"minted-project release view\nminted-project release create\n",
		);
	}, 60_000);

	test("flag off: publishRelease keeps the board GH_TOKEN", async () => {
		writeFileSync(record, "");
		await withEnv(
			{ GH_TOKEN: "global-board", PATH: `${bin}:${process.env.PATH}` },
			() =>
				publishRelease({
					mainPath: repo,
					reviewed: sha,
					sha,
					version: "v1.0.1",
					notes: "n",
					github: REMOTE,
					originUrl: null,
				}),
		);
		expect(readFileSync(record, "utf8")).toBe(
			"global-board release view\nglobal-board release create\n",
		);
	}, 60_000);
});

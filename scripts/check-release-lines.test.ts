// Live spawn tests for the bun.lock release line check (spec
// docs/specs/release-line-gate.md, checks 11-15): every case builds a
// throwaway git repo under tmpdir with its own git helper, serves a local
// packument listener on the localhost. host form, and spawns the real
// script. Fixture lock entries copy the real bun.lock tuple shapes.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "check-release-lines.ts");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const root = mkdtempSync(join(tmpdir(), "ottr-release-lines-"));
afterAll(() => {
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** git for fixtures with a throwaway identity — never a gate spawn. */
function must(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

const PACKAGE_JSON = `${JSON.stringify(
	{
		name: "release-line-fixture",
		private: true,
		dependencies: { mermaid: "12.2.0" },
	},
	null,
	"\t",
)}\n`;

/** Real bun.lock tuple shapes with the version edited per case: mermaid is
 * a direct dependency, @babel/code-frame is transitive only. */
function lockfile(mermaidVersion: string, babelVersion: string): string {
	return JSON.stringify({
		lockfileVersion: 1,
		workspaces: {
			"": {
				name: "release-line-fixture",
				dependencies: { mermaid: "12.2.0" },
			},
		},
		packages: {
			"@babel/code-frame": [
				`@babel/code-frame@${babelVersion}`,
				"",
				{
					dependencies: {
						"@babel/helper-validator-identifier": "^8.0.6",
						"js-tokens": "^10.0.0",
					},
				},
				"sha512-uMHhvmDmwFiLuiozaoRYTZHqMFuu3fem/X9JY78lohAuLoh8LSGGC8JqUzo2cVuBsBxkjMZNk56CE7ock8Xxkw==",
			],
			mermaid: [
				`mermaid@${mermaidVersion}`,
				"",
				{
					dependencies: {
						"@braintree/sanitize-url": "^7.1.2",
						"@mermaid-js/parser": "^2.0.1",
						cytoscape: "^3.34.0",
						d3: "^7.9.0",
						dompurify: "^3.4.12",
						katex: "^0.18.0",
						marked: "^16.3.0",
					},
				},
				"sha512-w7nr/SFrLO7BaVTs3dQTvYSV6nYSBj0Yy9DjBhsIJtAcHqRzXSq4Pg32ujHZ/AdWsAMNEvvhbm5dt9E2tOiHzw==",
			],
		},
	});
}

let fixtures = 0;

/** Scratch git repo: base lock committed and pushed to origin/main, then the
 * worktree lock rewritten (uncommitted) so the diff is non-empty. */
function fixture(
	base: { mermaid: string; babel: string },
	work: { mermaid: string; babel: string },
): string {
	const dir = join(root, `case-${fixtures++}`);
	const repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(repo, "package.json"), PACKAGE_JSON);
	writeFileSync(join(repo, "bun.lock"), lockfile(base.mermaid, base.babel));
	must(repo, "init", "-b", "main");
	must(repo, "add", ".");
	must(
		repo,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-m",
		"base",
	);
	must(repo, "init", "--bare", join(dir, "origin.git"));
	must(repo, "remote", "add", "origin", join(dir, "origin.git"));
	must(repo, "push", "origin", "main");
	writeFileSync(join(repo, "bun.lock"), lockfile(work.mermaid, work.babel));
	return repo;
}

type Request = { method: string; url: string };

/** Local registry listener: records every request, serves packuments by
 * decoded package name, answers a fixed status for the error case. */
function listener(packuments: Record<string, unknown>, status = 200) {
	const requests: Request[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			requests.push({ method: req.method, url: req.url });
			if (status !== 200) return new Response("down", { status });
			const name = decodeURIComponent(new URL(req.url).pathname.slice(1));
			const body = packuments[name];
			if (body === undefined)
				return new Response("no fixture", { status: 404 });
			return Response.json(body);
		},
	});
	return {
		requests,
		base: `http://localhost.:${server.port}`,
		stop: () => server.stop(true),
	};
}

/** Packument with exact ages: each version is `days` days plus one hour old,
 * so the floored day count stays stable against script-start drift. */
function packument(versions: Array<[string, number]>): unknown {
	const time: Record<string, string> = { created: "2026-01-01T00:00:00.000Z" };
	const versionMap: Record<string, object> = {};
	for (const [version, days] of versions) {
		versionMap[version] = {};
		time[version] = new Date(
			Date.now() - days * DAY_MS - HOUR_MS,
		).toISOString();
	}
	return { versions: versionMap, time };
}

/** Spawns the script itself, bounded, with the registry base seeded to the
 * localhost. host form (spec check 14). */
async function runScript(
	repo: string,
	base: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const proc = Bun.spawn({
		cmd: ["bun", SCRIPT],
		cwd: repo,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, OTTR_NPM_REGISTRY: base },
		timeout: 60_000,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

describe("check-release-lines (live spawns)", () => {
	test("unsettled direct dependency: exact failure line, exact GET", async () => {
		const repo = fixture(
			{ mermaid: "12.1.0", babel: "8.0.6" },
			{ mermaid: "12.2.0", babel: "8.0.6" },
		);
		const reg = listener({
			mermaid: packument([
				["12.2.0", 10],
				["12.2.1", 2],
			]),
		});
		try {
			const { stderr, code } = await runScript(repo, reg.base);
			expect(code).toBe(1);
			const lines = stderr.split("\n").filter((line) => line !== "");
			expect(lines).toContain(
				"release line not settled: mermaid 12.2.0, 12.2.1 is 2 days old",
			);
			// spec check 15: method and exact path, not a substring.
			expect(reg.requests).toEqual([
				{ method: "GET", url: `${reg.base}/mermaid` },
			]);
		} finally {
			reg.stop();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("unsettled transitive package: exact warning, exit stays 0", async () => {
		const repo = fixture(
			{ mermaid: "12.2.0", babel: "8.0.5" },
			{ mermaid: "12.2.0", babel: "8.0.6" },
		);
		const reg = listener({
			"@babel/code-frame": packument([
				["8.0.6", 10],
				["8.0.7", 2],
			]),
		});
		try {
			const { stderr, code } = await runScript(repo, reg.base);
			expect(code).toBe(0);
			const lines = stderr.split("\n").filter((line) => line !== "");
			expect(lines).toContain(
				"warning: release line not settled: @babel/code-frame 8.0.6, 8.0.7 is 2 days old (transitive)",
			);
			expect(
				lines.some((line) => line.startsWith("release line not settled:")),
			).toBe(false);
		} finally {
			reg.stop();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("registry error: immediate exit 1 with the error line", async () => {
		const repo = fixture(
			{ mermaid: "12.1.0", babel: "8.0.6" },
			{ mermaid: "12.2.0", babel: "8.0.6" },
		);
		const reg = listener({ mermaid: packument([["12.2.0", 10]]) }, 500);
		try {
			const { stderr, code } = await runScript(repo, reg.base);
			expect(code).toBe(1);
			const lines = stderr.split("\n").filter((line) => line !== "");
			expect(
				lines.some((line) =>
					line.startsWith("release line check failed: mermaid: "),
				),
			).toBe(true);
		} finally {
			reg.stop();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("no lock change: exit 0, no output, no registry call", async () => {
		const repo = fixture(
			{ mermaid: "12.2.0", babel: "8.0.6" },
			{ mermaid: "12.2.0", babel: "8.0.6" },
		);
		const reg = listener({});
		try {
			const { stdout, stderr, code } = await runScript(repo, reg.base);
			expect(code).toBe(0);
			expect(stdout).toBe("");
			expect(stderr).toBe("");
			expect(reg.requests).toEqual([]);
		} finally {
			reg.stop();
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

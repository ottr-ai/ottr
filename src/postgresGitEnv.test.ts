import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gitExe } from "./worktree.ts";

type Observation = {
	kind: string;
	args: string[];
	production: boolean;
	testUrl: boolean;
	requireTests: boolean;
	hosted: boolean;
	github: boolean;
};

// Only synthetic markers enter the fixture server or its children. Reports contain booleans, not URLs.
const productionMarker = "synthetic-production-marker";
const testMarker = "synthetic-test-marker";
const observationSource = `
import { appendFileSync } from "node:fs";
const observe = (kind, args = []) => appendFileSync(process.env.PROBE_LOG, JSON.stringify({
  kind, args,
  production: Object.hasOwn(process.env, "OTTR_DATABASE_URL"),
  testUrl: process.env.OTTR_TEST_PG_URL === ${JSON.stringify(testMarker)},
  requireTests: process.env.OTTR_REQUIRE_PG_TESTS === "1",
  hosted: Object.hasOwn(process.env, "OTTR_HOSTED_SECRET"),
  github: Object.hasOwn(process.env, "GH_TOKEN"),
}) + "\\n");
`;
const fakeToolSource = `#!${process.execPath}
${observationSource}
import { basename } from "node:path";
const kind = basename(process.argv[1]);
const args = process.argv.slice(2);
observe(kind, args);
const sha = "a".repeat(40);
const pointer = "version https://git-lfs.github.com/spec/v1\\noid sha256:" + "b".repeat(64) + "\\nsize 1\\n";
if (kind === "ssh-keyscan") console.log("example.invalid ssh-ed25519 synthetic-public-key");
else if (kind === "ssh-keygen") {
  if (args.includes("-l")) {
    await Bun.stdin.text();
    console.log("256 SHA256:synthetic public-key (ED25519)");
  } else console.log("ssh-ed25519 synthetic-public-key");
} else if (args.includes("config")) console.log("credential.helper synthetic-helper");
else if (args.includes("rev-list")) console.log(sha + " pointer");
else if (args.includes("--batch-check")) {
  await Bun.stdin.text();
  console.log(sha + " blob " + Buffer.byteLength(pointer));
} else if (args.includes("--batch")) {
  await Bun.stdin.text();
  process.stdout.write(sha + " blob " + Buffer.byteLength(pointer) + "\\n" + pointer + "\\n");
} else if (args.includes("rev-parse")) console.log(sha);
else if (args.includes("ls-tree")) console.log("bun.lock");
else if (args.includes("cat-file")) console.log('{"packages":{}}');
else if (!args.includes("status") && !args.includes("fetch")) process.exit(93);
`;

async function fixture(
	body: string,
	files: Record<string, string> = {},
): Promise<{ result: unknown; observations: Observation[] }> {
	const root = mkdtempSync(join(tmpdir(), "ottr-pg-git-env-"));
	try {
		const bin = join(root, "bin");
		mkdirSync(bin);
		for (const name of ["git", "ssh-keygen", "ssh-keyscan"])
			writeFileSync(join(bin, name), fakeToolSource, { mode: 0o755 });
		writeFileSync(
			join(root, "probe.ts"),
			`${observationSource}\nobserve("probe");`,
		);
		for (const [name, source] of Object.entries(files))
			writeFileSync(join(root, name), source);
		const moduleUrl = (name: string) =>
			JSON.stringify(pathToFileURL(join(import.meta.dir, name)).href);
		const source = `
const root = ${JSON.stringify(root)};
const probe = ${JSON.stringify(join(root, "probe.ts"))};
// Bun retains this synthetic boot value even after process.env drops it.
delete process.env.OTTR_DATABASE_URL;
// Dynamic imports exercise module initialization after the fixture drops its boot URL.
const worktree = await import(${moduleUrl("worktree.ts")});
const hosts = await import(${moduleUrl("gitHosts.ts")});
const release = await import(${moduleUrl("release.ts")});
const scan = await import(${moduleUrl("releaseLineScan.ts")});
const result = await (async () => { ${body} })();
console.log(JSON.stringify(result));
`;
		const log = join(root, "observations.jsonl");
		writeFileSync(log, "");
		const proc = Bun.spawn([process.execPath, "--eval", source], {
			cwd: root,
			env: {
				PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
				HOME: root,
				TMPDIR: tmpdir(),
				PROBE_LOG: log,
				OTTR_DATABASE_URL: productionMarker,
				OTTR_TEST_PG_URL: testMarker,
				OTTR_REQUIRE_PG_TESTS: "1",
				OTTR_HOSTED_SECRET: "synthetic-hosted-marker",
				GH_TOKEN: "synthetic-github-marker",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		const observations = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Observation);
		return { result: JSON.parse(stdout.trim()), observations };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function expectFiltered(observations: Observation[], count: number): void {
	expect(observations).toHaveLength(count);
	for (const child of observations) {
		expect(child.production).toBe(false);
		expect(child.testUrl).toBe(true);
		expect(child.requireTests).toBe(true);
	}
}

describe.skipIf(process.platform === "win32")(
	"PostgreSQL Git child environments",
	() => {
		test("spawnPiped filters an explicit override without changing its record", async () => {
			const { result, observations } = await fixture(`
const env = { ...process.env, OTTR_DATABASE_URL: ${JSON.stringify(productionMarker)} };
const child = await worktree.spawnPiped([process.execPath, probe], root, 5000, env);
return { code: child.code, originalRetained: env.OTTR_DATABASE_URL === ${JSON.stringify(productionMarker)} };
`);
			expect(result).toEqual({ code: 0, originalRetained: true });
			expectFiltered(observations, 1);
		});

		test("spawnPiped excludes Bun's cached server boot URL", async () => {
			const { result, observations } = await fixture(`
return (await worktree.spawnPiped([process.execPath, probe], root, 5000)).code;
`);
			expect(result).toBe(0);
			expectFiltered(observations, 1);
		});

		test("gitEnv filters after network auth merge and preserves token scoping", async () => {
			const { result, observations } = await fixture(`
const codes = [];
for (const args of [["status"], ["fetch"]]) {
  const env = worktree.gitEnv(args, { OTTR_DATABASE_URL: ${JSON.stringify(productionMarker)}, GH_TOKEN: "synthetic-network-marker" });
  const child = Bun.spawn([process.execPath, probe], { env, stdout: "pipe", stderr: "pipe" });
  await new Response(child.stdout).text();
  await new Response(child.stderr).text();
  codes.push(await child.exited);
}
return codes;
`);
			expect(result).toEqual([0, 0]);
			expectFiltered(observations, 2);
			expect(observations.map((child) => child.github)).toEqual([false, true]);
		});

		test("git filters its final per-call override", async () => {
			const { result, observations } = await fixture(`
return (await worktree.git(["status"], root, 5000, undefined, { OTTR_DATABASE_URL: ${JSON.stringify(productionMarker)} })).code;
`);
			expect(result).toBe(0);
			expectFiltered(observations, 1);
			expect(observations[0]?.github).toBe(false);
		});

		test("LFS content reads filter the raw cat-file child", async () => {
			const { result, observations } = await fixture(`
process.env.OTTR_DATABASE_URL = ${JSON.stringify(productionMarker)};
return await worktree.lfsPointerOids(root, "main", null);
`);
			expect(result).toEqual(["b".repeat(64)]);
			expectFiltered(observations, 3);
			// OTTR-1176: the raw child keeps its bare subcommand and carries the same
			// safe.directory pin every board git spawn carries.
			expect(observations[2]?.args).toEqual([
				"-c",
				"safe.directory=*",
				"cat-file",
				"--batch",
			]);
		});

		test("Git helper discovery and SSH probes use explicit filtered environments", async () => {
			const { result, observations } = await fixture(`
const helpers = hosts.readAmbientHelpers();
const keys = await hosts.realKeyscan("example.invalid", null);
const key = await hosts.keyInfo(probe);
return { helpers, keys, fingerprint: key?.fingerprint };
`);
			expect(result).toEqual({
				helpers: [
					["credential.helper", "synthetic-helper"],
					["credential.helper", "synthetic-helper"],
				],
				keys: ["example.invalid ssh-ed25519 synthetic-public-key"],
				fingerprint: "SHA256:synthetic",
			});
			expectFiltered(observations, 5);
			expect(observations.map((child) => child.kind)).toEqual([
				"git",
				"git",
				"ssh-keyscan",
				"ssh-keygen",
				"ssh-keygen",
			]);
		});

		test("release commands exclude server secrets after release facts merge", async () => {
			const commandTemplate = `${observationSource}
observe("release");
console.log(JSON.stringify({
  version: process.env.OTTR_RELEASE_VERSION === "v1.2.3",
  commit: process.env.OTTR_RELEASE_COMMIT === "__SHA__",
  notes: process.env.OTTR_RELEASE_NOTES_FILE === "synthetic-notes",
  review: process.env.OTTR_ARCH_REVIEW === "3",
}));
process.exit(17);
`;
			const { result, observations } = await fixture(
				`
process.env.OTTR_DATABASE_URL = ${JSON.stringify(productionMarker)};
const lines = [];
// The release guard executes only the board's own clean linked worktree at the
// reviewed commit, so plant one with the real git before the command runs. The
// real git replaces the fixture's fake git binary: the guard must talk to a real
// repository, and Bun.which caches its PATH scan, so a PATH prepend cannot
// reroute it after module init. node:fs is imported dynamically because this
// body runs inside generated bun --eval source, which cannot carry a static
// import statement.
const { chmodSync, copyFileSync } = await import("node:fs");
const realGit = ${JSON.stringify(gitExe())};
copyFileSync(realGit, root + "/bin/git");
chmodSync(root + "/bin/git", 0o755);
const git = (args, cwd) => {
	const r = Bun.spawnSync([root + "/bin/git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error("git " + args[0] + " failed: " + r.stderr.toString().trim());
};
const repo = root + "/repo";
git(["init", "-q", "-b", "main", repo], root);
git(["config", "user.name", "t"], repo);
git(["config", "user.email", "t@example.com"], repo);
git(["commit", "-q", "--allow-empty", "-m", "one"], repo);
const sha = new TextDecoder().decode(Bun.spawnSync([root + "/bin/git", "rev-parse", "HEAD"], { cwd: repo }).stdout).trim();
const wt = root + "/wt";
git(["worktree", "add", "-q", "--detach", wt, sha], repo);
await Bun.write(root + "/command.ts", ${JSON.stringify(commandTemplate)}.replaceAll("__SHA__", sha));
try {
  await release.runReleaseCommand({
    command: '"' + process.execPath + '" "' + root + '/command.ts"',
    cwd: wt, mainPath: repo, originUrl: null, target: "main",
    sha, version: "v1.2.3", notesFile: "synthetic-notes",
    archReview: { delta: 3 }, allowEnv: "PROBE_LOG", log: (line) => lines.push(line),
  });
} catch (error) {
  return { failedAsExpected: error.message.startsWith("release command exited with code 17"), facts: JSON.parse(lines[0]) };
}
throw new Error("the fixture command must exit 17");
`,
				{},
			);
			expect(result).toEqual({
				failedAsExpected: true,
				facts: { version: true, commit: true, notes: true, review: true },
			});
			expectFiltered(observations, 1);
			expect(observations[0]?.hosted).toBe(false);
		});

		test("both merge gate children exclude server secrets", async () => {
			const { result, observations } = await fixture(
				`
process.env.OTTR_DATABASE_URL = ${JSON.stringify(productionMarker)};
return await worktree.runMergeGates(root);
`,
				{
					"package.json": JSON.stringify({
						scripts: { check: '"' + process.execPath + '" probe.ts' },
					}),
					"gate.test.ts": `${observationSource}\nimport { test } from "bun:test";\ntest("environment probe", () => observe("test"));`,
				},
			);
			expect(result).toEqual({ ok: true, output: "" });
			expectFiltered(observations, 2);
			expect(observations.map((child) => child.kind)).toEqual([
				"probe",
				"test",
			]);
			expect(observations.every((child) => !child.hosted)).toBe(true);
		});

		test("release line scans filter all three synchronous Git children", async () => {
			const { result, observations } = await fixture(
				`return await scan.releaseLineBlocked(root);`,
				{
					"bun.lock": '{"packages":{}}',
					"package.json": '{"dependencies":{}}',
				},
			);
			expect(result).toEqual([]);
			expectFiltered(observations, 3);
			expect(observations.map((child) => child.args[0])).toEqual([
				"rev-parse",
				"ls-tree",
				"cat-file",
			]);
		});
	},
);

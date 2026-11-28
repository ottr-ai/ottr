import { Database } from "bun:sqlite";
import { describe, expect, jest, test } from "bun:test";
import {
	type ChildProcess,
	execFileSync,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fixtureGitEnv } from "./gitRepoEnv.ts";
import { readLayerUse } from "./layers.ts";
import { configOverlayPaths, startRun } from "./runner.ts";
import fc from "./test/properties.ts";
import { runMarkerPath } from "./tmpsweep.ts";
import { projectTurnUid } from "./turnUid.ts";

const project = "ottr";
const ids = projectTurnUid(project);
const uid = process.getuid?.();
const gid = process.getgid?.();
const canUseProjectUid =
	process.platform === "linux" &&
	(uid === 0 || (uid === ids.uid && gid === ids.gid));
const identityTest = canUseProjectUid ? test : test.skip;
const rootTest = process.platform === "linux" && uid === 0 ? test : test.skip;

function fixture() {
	// A private TMPDIR ancestor must not hide a cross-uid fixture.
	const root = mkdtempSync("/tmp/ottr-merge-uid-test-");
	chmodSync(root, 0o755);
	const workspaceRoot = join(root, "workspace");
	const cwd = join(workspaceRoot, project);
	const dataRoot = join(root, "data");
	const sessionDir = join(dataRoot, project, "sessions");
	const workerHome = join(root, "shared");
	const boardHome = join(root, "board");
	const homesRoot = join(root, "turn-homes");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
	mkdirSync(homesRoot);
	for (const path of [
		workspaceRoot,
		dataRoot,
		workerHome,
		join(workerHome, ".omp"),
		homesRoot,
	])
		chmodSync(path, 0o755);
	mkdirSync(boardHome, { mode: 0o700 });
	mkdirSync(join(boardHome, ".omp", "agent"), { recursive: true });
	const store = join(boardHome, ".omp", "agent", "agent.db");
	const db = new Database(store, { create: true });
	db.exec(
		"PRAGMA journal_mode=WAL; CREATE TABLE merge_fixture(value TEXT); INSERT INTO merge_fixture VALUES ('trusted board store')",
	);
	db.exec(
		"CREATE TABLE auth_credentials(id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)",
	);
	db.query(
		"INSERT INTO auth_credentials(provider, credential_type, identity_key, data, created_at, updated_at) VALUES (?, 'oauth', ?, ?, 1, 1)",
	).run(
		"fixture-provider",
		"fixture-account",
		JSON.stringify({
			access: "synthetic-access",
			refresh: "synthetic-refresh",
			expires: 1,
			accountId: "fixture-account",
		}),
	);
	writeFileSync(
		join(boardHome, ".omp", "auth-broker.token"),
		"synthetic-private-broker-file",
		{ mode: 0o600 },
	);
	chmodSync(store, 0o600);
	const privateStore = join(boardHome, "agent.db");
	writeFileSync(privateStore, "private fixture store", { mode: 0o600 });
	const gitconfig = join(boardHome, "gitconfig");
	writeFileSync(
		gitconfig,
		"[user]\n name = Configured Merge\n email = configured@example.invalid\n",
	);
	const provisionPaths = {
		passwd: join(root, "passwd"),
		group: join(root, "group"),
	};
	writeFileSync(provisionPaths.passwd, "");
	writeFileSync(provisionPaths.group, "");
	execFileSync("git", ["init", "-q", cwd], { env: fixtureGitEnv() });
	const previousEnv = new Map(
		[
			"OTTR_BOARD_OMP_HOME",
			"OTTR_SERVER_DATA_DIR",
			"OTTR_TURN_CACHE_ROOT",
			"TMPDIR",
			"GIT_AUTHOR_NAME",
			"GIT_AUTHOR_EMAIL",
			"GIT_COMMITTER_NAME",
			"GIT_COMMITTER_EMAIL",
			"OMP_AUTH_BROKER_URL",
			"OMP_AUTH_BROKER_TOKEN",
		].map((key) => [key, process.env[key]]),
	);
	process.env.OTTR_BOARD_OMP_HOME = boardHome;
	process.env.OTTR_SERVER_DATA_DIR = join(root, "overlays");
	process.env.OTTR_TURN_CACHE_ROOT = join(root, "server-cache");
	const privateTmp = join(root, "board-tmp");
	mkdirSync(privateTmp, { mode: 0o700 });
	process.env.TMPDIR = privateTmp;
	process.env.OMP_AUTH_BROKER_URL = "http://ambient.invalid";
	process.env.OMP_AUTH_BROKER_TOKEN = "synthetic-ambient-poison";
	for (const key of [
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
	])
		delete process.env[key];
	// A same-uid host can exercise prep and real spawn without CAP_SETUID.
	// The real child still reports its own kernel uid; this does not fake its result.
	const rootView =
		uid === 0 ? null : jest.spyOn(process, "getuid").mockReturnValue(0);
	return {
		root,
		cwd,
		sessionDir,
		workerHome,
		boardHome,
		privateStore,
		store,
		db,
		homesRoot,
		options: {
			cwd,
			project,
			prompt: "probe",
			sessionDir,
			resumeId: null,
			extensionPath: null,
			dataRoot,
			logPath: join(dataRoot, project, "run.log"),
			localMerge: { workspaceRoot, homesRoot, provisionPaths },
			authBroker: {
				url: "http://127.0.0.1:1",
				token: "synthetic-merge-broker-grant",
			},
			env: { ...fixtureGitEnv(), GIT_CONFIG_GLOBAL: gitconfig },
		},
		cleanup: () => {
			db.close();
			rootView?.mockRestore();
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function fakeChild() {
	return Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	}) as unknown as ChildProcess;
}

identityTest(
	"sequential preparations exclude provider credentials and pin the explicit broker grant",
	async () => {
		const f = fixture();
		const before = f.db.query("SELECT * FROM auth_credentials").all();
		const mode = statSync(f.store).mode;
		try {
			for (let run = 0; run < 2; run++) {
				const child = fakeChild();
				const handle = await startRun({
					...f.options,
					env: {
						...f.options.env,
						OMP_AUTH_BROKER_URL: "http://project.invalid",
						OMP_AUTH_BROKER_TOKEN: "synthetic-project-poison",
					},
					launcher: (_command, _args, options) => {
						expect(options.env?.OMP_AUTH_BROKER_URL).toBe(
							f.options.authBroker.url,
						);
						expect(options.env?.OMP_AUTH_BROKER_TOKEN).toBe(
							f.options.authBroker.token,
						);
						const home = String(options.env?.HOME);
						expect(existsSync(join(home, ".omp", "auth-broker.token"))).toBe(
							false,
						);
						const snapshot = new Database(
							join(home, ".omp", "agent", "agent.db"),
						);
						try {
							expect(
								snapshot.query("SELECT * FROM auth_credentials").all(),
							).toEqual([]);
							expect(
								snapshot.query("SELECT value FROM merge_fixture").all(),
							).toEqual([{ value: "trusted board store" }]);
							snapshot
								.query(
									"INSERT INTO auth_credentials(provider, credential_type, identity_key, data) VALUES (?, 'oauth', ?, ?)",
								)
								.run(
									"fixture-provider",
									"fixture-account",
									'{"refresh":"synthetic-child-refresh"}',
								);
						} finally {
							snapshot.close();
						}
						return child;
					},
				});
				child.stderr?.emit("data", Buffer.from(f.options.authBroker.token));
				child.emit("close", 0);
				await handle.done;
				expect(f.db.query("SELECT * FROM auth_credentials").all()).toEqual(
					before,
				);
				expect(readFileSync(f.options.logPath, "utf8")).not.toContain(
					f.options.authBroker.token,
				);
				expect(statSync(f.store).mode).toBe(mode);
			}
		} finally {
			f.cleanup();
		}
	},
);

identityTest("a missing explicit broker refuses spawn", async () => {
	const f = fixture();
	let launches = 0;
	const layer = join(f.boardHome, ".alate", "layers", "missing-broker");
	mkdirSync(join(layer, ".omp", "agent"), { recursive: true });
	symlinkSync("layers/missing-broker", join(f.boardHome, ".alate", "current"));
	try {
		await expect(
			startRun({
				...f.options,
				authBroker: null,
				launcher: () => {
					launches++;
					return fakeChild();
				},
			}),
		).rejects.toThrow("requires an explicit auth broker");
		expect(launches).toBe(0);
		expect(existsSync(join(f.homesRoot, project, "home"))).toBe(false);
		expect(readLayerUse(f.boardHome)).toEqual([]);
		expect(statSync(f.boardHome).mode & 0o777).toBe(0o700);
		expect(statSync(f.store).mode & 0o777).toBe(0o600);
	} finally {
		f.cleanup();
	}
});

describe("local merge project identity", () => {
	identityTest.each([0o022, 0o077])(
		"real local child uses the project uid, protected config, writable state, scratch, cache and sessions under umask %i",
		async (umask) => {
			const f = fixture();
			const previousUmask = process.umask(umask);
			let launched: SpawnOptions | undefined;
			let scratch = "";
			let runtime = "";
			try {
				const skill = join(f.boardHome, ".claude", "skills", "fixture");
				mkdirSync(skill, { recursive: true });
				writeFileSync(join(skill, "SKILL.md"), "# Trusted fixture\n");
				const handle = await startRun({
					...f.options,
					commitIdentity: {
						name: "Settings fallback",
						email: "fallback@example.invalid",
					},
					launcher: (_command, args, options) => {
						launched = options;
						const home = String(options.env?.HOME);
						for (const path of [
							"",
							".omp",
							".omp/agent",
							".claude",
							".claude/skills",
							".claude/skills/fixture",
							".config",
							".config/gh",
							".config/git",
						]) {
							const mode = statSync(join(home, path)).mode;
							expect(mode & 0o055).toBe(0o055);
							expect(mode & 0o022).toBe(0);
						}
						for (const path of [".gitconfig", ".omp/agent/config.yml"])
							expect(statSync(join(home, path)).mode & 0o444).toBe(0o444);
						scratch = String(options.env?.TMPDIR);
						const overlays = configOverlayPaths(args).filter((path) =>
							path.startsWith(dirname(String(options.env?.HOME))),
						);
						expect(overlays.length).toBeGreaterThan(0);
						runtime = dirname(overlays[0]!);
						expect(existsSync(runMarkerPath(scratch))).toBe(true);
						expect(existsSync(runMarkerPath(runtime))).toBe(true);
						return spawn(
							"/bin/sh",
							[
								"-c",
								`
set -eu
	test -r "$HOME/.omp/agent/config.yml"
	test -r "$HOME/.claude/skills/fixture/SKILL.md"
printf probe > "$TMPDIR/merge-probe"
printf probe > "$XDG_CACHE_HOME/merge-probe"
printf probe > "$MERGE_TEST_SESSIONS/merge-probe"
	"$MERGE_TEST_BUN" -e '
import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
const path = process.env.PI_CODING_AGENT_DIR + "/agent.db";
const db = new Database(path);
if (db.query("SELECT value FROM merge_fixture").get().value !== "trusted board store") throw new Error("trusted snapshot missing");
db.exec("PRAGMA journal_mode=WAL");
db.query("INSERT INTO merge_fixture VALUES (?)").run("child write");
if (!existsSync(realpathSync(path) + "-wal")) throw new Error("state WAL missing");
if (existsSync(path + "-wal")) throw new Error("WAL crossed config boundary");
db.close();
'
test -w "$OTTR_TMP_ROOT"
for config in "$@"; do test -r "$config"; done
printf '{"type":"agent_end","isTerminal":true,"messages":[{"role":"assistant","content":[{"type":"text","text":"uid=%s gid=%s name=%s email=%s"}]}]}\\n' "$(id -u)" "$(id -g)" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL"
`,
								"merge-probe",
								...overlays,
							],
							{
								...options,
								env: {
									...options.env,
									MERGE_TEST_SESSIONS: f.sessionDir,
									MERGE_TEST_BUN: process.execPath,
								},
							},
						);
					},
				});
				const result = await handle.done;
				expect(result.exitCode).toBe(0);
				expect(launched?.uid).toBe(ids.uid);
				expect(launched?.gid).toBe(ids.gid);
				expect(launched?.uid).not.toBe(0);
				expect(result.finalText).toBe(
					`uid=${ids.uid} gid=${ids.gid} name=Configured Merge email=configured@example.invalid`,
				);
				expect(launched?.env?.HOME).toBe(join(runtime, "home"));
				expect(launched?.env?.OTTR_TMP_ROOT).toBe("/tmp");
				expect(statSync(join(f.cwd, ".git")).uid).toBe(ids.uid);
				expect(readFileSync(join(f.sessionDir, "merge-probe"), "utf8")).toBe(
					"probe",
				);
				expect(existsSync(scratch)).toBe(false);
				expect(existsSync(runtime)).toBe(false);
				expect(existsSync(runMarkerPath(scratch))).toBe(false);
				expect(existsSync(runMarkerPath(runtime))).toBe(false);
				expect(statSync(f.boardHome).mode & 0o777).toBe(0o700);
				expect(statSync(f.privateStore).mode & 0o777).toBe(0o600);
			} finally {
				process.umask(previousUmask);
				f.cleanup();
			}
		},
	);

	identityTest(
		"an already-project-owned checkout keeps its configured Git identity",
		async () => {
			const f = fixture();
			chownSync(f.cwd, ids.uid, ids.gid);
			chownSync(join(f.cwd, ".git"), ids.uid, ids.gid);
			const child = fakeChild();
			let launch: SpawnOptions | undefined;
			try {
				const handle = await startRun({
					...f.options,
					launcher: (_command, _args, options) => {
						launch = options;
						return child;
					},
				});
				expect(launch?.env?.GIT_AUTHOR_NAME).toBe("Configured Merge");
				expect(launch?.env?.GIT_AUTHOR_EMAIL).toBe(
					"configured@example.invalid",
				);
				expect(launch?.env?.GIT_CONFIG_GLOBAL).toBeUndefined();
				child.emit("close", 0);
				await handle.done;
			} finally {
				f.cleanup();
			}
		},
	);

	identityTest(
		"configured Git identity values survive the merge boundary",
		async () => {
			const f = fixture();
			const text = fc
				.array(fc.constantFrom("a", "Z", "0", "-", "_", "."), {
					minLength: 1,
					maxLength: 24,
				})
				.map((letters) => letters.join(""));
			try {
				await fc.assert(
					fc.asyncProperty(text, text, async (name, address) => {
						const expectedName = `Merge ${name}`;
						const expectedEmail = `${address}@example.invalid`;
						for (const [key, value] of [
							["user.name", expectedName],
							["user.email", expectedEmail],
						] as const) {
							execFileSync(
								"git",
								[
									"config",
									"--file",
									f.options.env.GIT_CONFIG_GLOBAL,
									key,
									value,
								],
								{
									env: fixtureGitEnv(),
								},
							);
						}
						const child = fakeChild();
						let launch: SpawnOptions | undefined;
						const handle = await startRun({
							...f.options,
							launcher: (_command, _args, options) => {
								launch = options;
								return child;
							},
						});
						try {
							expect(launch?.env?.GIT_AUTHOR_NAME).toBe(expectedName);
							expect(launch?.env?.GIT_COMMITTER_NAME).toBe(expectedName);
							expect(launch?.env?.GIT_AUTHOR_EMAIL).toBe(expectedEmail);
							expect(launch?.env?.GIT_COMMITTER_EMAIL).toBe(expectedEmail);
							expect(launch?.env?.GIT_CONFIG_GLOBAL).toBeUndefined();
						} finally {
							child.emit("close", 0);
							await handle.done;
						}
					}),
				);
			} finally {
				f.cleanup();
			}
		},
		120_000,
	);

	identityTest(
		"planted Git metadata refuses prep and launches no child",
		async () => {
			const f = fixture();
			const outside = join(f.root, "outside");
			mkdirSync(outside, { mode: 0o700 });
			execFileSync("git", ["init", "-q", outside], { env: fixtureGitEnv() });
			const outsideGit = join(outside, ".git");
			const before = statSync(outsideGit);
			rmSync(join(f.cwd, ".git"), { recursive: true });
			symlinkSync(outsideGit, join(f.cwd, ".git"));
			let launches = 0;
			try {
				await expect(
					startRun({
						...f.options,
						launcher: () => {
							launches++;
							return fakeChild();
						},
					}),
				).rejects.toThrow("refusing planted entry");
				expect(launches).toBe(0);
				expect(statSync(outsideGit).uid).toBe(before.uid);
				expect(statSync(outsideGit).mode).toBe(before.mode);
			} finally {
				f.cleanup();
			}
		},
	);

	identityTest(
		"failed cache prep names its root and launches no child",
		async () => {
			const f = fixture();
			const layer = join(f.boardHome, ".alate", "layers", "merge-cache-fault");
			mkdirSync(join(layer, ".omp", "agent"), { recursive: true });
			writeFileSync(
				join(layer, ".omp", "agent", "config.yml"),
				"model: fixture\n",
			);
			symlinkSync(layer, join(f.boardHome, ".alate", "current"));
			const cache = join(f.homesRoot, project, "cache");
			mkdirSync(dirname(cache), { recursive: true });
			writeFileSync(cache, "not a cache directory");
			let launches = 0;
			try {
				await expect(
					startRun({
						...f.options,
						launcher: () => {
							launches++;
							return fakeChild();
						},
					}),
				).rejects.toThrow(`merge turn cache preparation failed: ${cache}`);
				expect(launches).toBe(0);
				expect(readLayerUse(f.boardHome)).toEqual([]);
				expect(
					existsSync(
						join(f.homesRoot, project, "layers", "merge-cache-fault.inuse"),
					),
				).toBe(false);
			} finally {
				f.cleanup();
			}
		},
	);

	identityTest(
		"a pinned merge holds the private board layer and fresh config until settle",
		async () => {
			const f = fixture();
			const layer = join(f.boardHome, ".alate", "layers", "merge-A");
			mkdirSync(join(layer, ".omp", "agent"), { recursive: true });
			writeFileSync(
				join(layer, ".omp", "agent", "config.yml"),
				"model: fixture\n",
			);
			symlinkSync(layer, join(f.boardHome, ".alate", "current"));
			const child = fakeChild();
			let launch: SpawnOptions | undefined;
			try {
				const handle = await startRun({
					...f.options,
					launcher: (_command, _args, options) => {
						launch = options;
						return child;
					},
				});
				const copy = String(launch?.env?.HOME);
				const copyMarker = runMarkerPath(dirname(copy));
				expect(launch?.uid).toBe(ids.uid);
				expect(copy).toContain("run-merge-config-");
				expect(copy).not.toBe(join(f.homesRoot, project, "layers", "merge-A"));
				expect(launch?.env?.PI_CODING_AGENT_DIR).toBe(
					join(copy, ".omp", "agent"),
				);
				expect(readLayerUse(f.boardHome)).toEqual([
					{ id: "merge-A", since: expect.any(Number) },
				]);
				expect(existsSync(copyMarker)).toBe(true);
				child.emit("close", 0);
				await handle.done;
				expect(readLayerUse(f.boardHome)).toEqual([]);
				expect(existsSync(copyMarker)).toBe(false);
			} finally {
				f.cleanup();
			}
		},
	);

	identityTest(
		"a private board alias remains a trusted configuration source",
		async () => {
			const f = fixture();
			const alias = join(f.root, "board-alias");
			symlinkSync(f.boardHome, alias);
			process.env.OTTR_BOARD_OMP_HOME = alias;
			const child = fakeChild();
			try {
				const handle = await startRun({
					...f.options,
					launcher: () => child,
				});
				expect(statSync(f.boardHome).mode & 0o777).toBe(0o700);
				expect(statSync(f.privateStore).mode & 0o777).toBe(0o600);
				child.emit("close", 0);
				await handle.done;
			} finally {
				f.cleanup();
			}
		},
	);

	for (const control of ["other local kind", "non-root merge"] as const) {
		test.skipIf(process.platform !== "linux")(
			`${control} retains the local process identity`,
			async () => {
				const f = fixture();
				const nonRoot =
					control === "non-root merge"
						? jest.spyOn(process, "getuid").mockReturnValue(1000)
						: null;
				const child = fakeChild();
				let launch: SpawnOptions | undefined;
				try {
					const handle = await startRun({
						...f.options,
						localMerge:
							control === "non-root merge" ? f.options.localMerge : undefined,
						memoryConfigPath: null,
						launcher: (_command, _args, options) => {
							launch = options;
							return child;
						},
					});
					expect(launch?.uid).toBeUndefined();
					expect(launch?.gid).toBeUndefined();
					expect(launch?.env?.HOME).toBe(f.boardHome);
					expect(
						readFileSync(f.options.localMerge.provisionPaths.passwd, "utf8"),
					).toBe("");
					child.emit("close", 0);
					await handle.done;
				} finally {
					nonRoot?.mockRestore();
					f.cleanup();
				}
			},
		);
	}

	identityTest(
		"a spawn throw removes scratch and runtime configs",
		async () => {
			const f = fixture();
			let scratch = "";
			let runtime = "";
			for (const name of [".env", ".env.local"])
				writeFileSync(join(f.cwd, name), "PI_CONFIG_FILES=project-plant.yml\n");
			try {
				await expect(
					startRun({
						...f.options,
						launcher: (_command, args, options) => {
							for (const name of [".env", ".env.local"])
								expect(existsSync(join(f.cwd, name))).toBe(false);
							scratch = String(options.env?.TMPDIR);
							runtime = dirname(
								configOverlayPaths(args).find((path) =>
									path.startsWith(dirname(String(options.env?.HOME))),
								)!,
							);
							throw new Error("fixture spawn failure");
						},
					}),
				).rejects.toThrow("fixture spawn failure");
				expect(scratch).not.toBe("");
				expect(runtime).not.toBe("");
				expect(existsSync(scratch)).toBe(false);
				expect(existsSync(runtime)).toBe(false);
				expect(existsSync(runMarkerPath(scratch))).toBe(false);
				for (const name of [".env", ".env.local"])
					expect(readFileSync(join(f.cwd, name), "utf8")).toBe(
						"PI_CONFIG_FILES=project-plant.yml\n",
					);
			} finally {
				f.cleanup();
			}
		},
	);

	rootTest(
		"the real dropped child cannot read the private board store",
		async () => {
			const f = fixture();
			try {
				// Root proves the file exists and is readable before the child tests denial.
				expect(readFileSync(f.privateStore, "utf8")).toBe(
					"private fixture store",
				);
				const handle = await startRun({
					...f.options,
					launcher: (_command, _args, options) =>
						spawn(
							"/bin/sh",
							[
								"-c",
								`
set -eu
	test -r "$PI_CODING_AGENT_DIR/agent.db"
	if printf plant > "$HOME/plant" 2>/dev/null; then exit 92; fi
	if printf plant > "$PI_CODING_AGENT_DIR/config.yml" 2>/dev/null; then exit 93; fi
if cat "$MERGE_PRIVATE_STORE" >/dev/null 2>&1; then exit 91; fi
printf '{"type":"agent_end","isTerminal":true,"messages":[{"role":"assistant","content":[{"type":"text","text":"private store denied"}]}]}\\n'
`,
							],
							{
								...options,
								env: { ...options.env, MERGE_PRIVATE_STORE: f.privateStore },
							},
						),
				});
				const result = await handle.done;
				expect(result.exitCode).toBe(0);
				expect(result.finalText).toBe("private store denied");
			} finally {
				f.cleanup();
			}
		},
	);
});

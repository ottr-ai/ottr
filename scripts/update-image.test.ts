import { afterAll, describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worktree from "../src/worktree.ts";

// Snapshots before any mock.module: a live namespace's bindings follow the mock, a plain
// object spread does not.
const realGit = worktree.git;
const realWorktree = { ...worktree };
const { gitExe } = worktree;

import {
	type Deps,
	dropBunDotenv,
	envFileValues,
	updateImage,
} from "./update-image.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-update-image-"));
afterAll(
	() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
	60_000,
);

/** git for fixtures with a throwaway identity — never the git() under test. */
function must(cwd: string, ...args: string[]): string {
	const id = ["-c", "user.name=ott", "-c", "user.email=ott@example.invalid"];
	const r = Bun.spawnSync(
		[gitExe(), ...id, "-c", "commit.gpgsign=false", ...args],
		{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	if (r.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

const dockerfile = (omp: string) =>
	`FROM x\r\nARG OMP_VERSION=${omp}\r\nRUN true\r\n`; // CRLF, as on Windows

let fixtures = 0;
/** A bare origin, the host's main checkout, and a second clone that plays CI. */
function checkout(): { origin: string; main: string; ci: string } {
	const dir = join(root, String(fixtures++));
	const origin = join(dir, "origin.git");
	const main = join(dir, "main");
	const ci = join(dir, "ci");
	must(root, "init", "-q", "--bare", "-b", "main", origin);
	must(root, "init", "-q", "-b", "main", main);
	writeFileSync(join(main, "Dockerfile.worker"), dockerfile("1.0.0"));
	must(main, "add", ".");
	must(main, "commit", "-q", "-m", "a");
	must(main, "remote", "add", "origin", origin);
	must(main, "push", "-q", "-u", "origin", "main");
	must(root, "clone", "-q", origin, ci);
	return { origin, main, ci };
}

/** CI's bump: a commit on origin that the host does not have yet. */
function bump(ci: string, omp: string): void {
	writeFileSync(join(ci, "Dockerfile.worker"), dockerfile(omp));
	must(ci, "commit", "-q", "-am", `chore: bump omp to ${omp}`);
	must(ci, "push", "-q", "origin", "HEAD:main");
}

/** Fake docker; `calls` records each call with the exec'd script shortened to <count>, <hold> or <free>. */
function fakes(
	o: {
		build?: number;
		/** Turn counts the board answers, in order; the last one repeats. */
		turns?: string | string[];
		/** Services `ps --services --status running` lists, "\n"-separated. */
		running?: string;
		/** Exit code of the ps (an error like a dead daemon). */
		psCode?: number;
		/** The build gave the server a new image. */
		newImage?: boolean;
		/** A host-only override service built from another local git checkout. */
		sidecar?: { name: string; dir: string };
		/** The sidecar's build gives it a new image. */
		sidecarNewImage?: boolean;
		/** Exit code of the sidecar's build. */
		sidecarBuild?: number;
		/** Exit code of the sidecar's own restart (`up --no-deps`). */
		sidecarUp?: number;
		/** Exit code of `compose images` (the image comparison's first step). */
		imagesCode?: number;
		/** The seed commit the server volume records (the `cat` exec's output). */
		seedRecord?: string;
		/** Exit code of the board-seed run. */
		seedCode?: number;
		/** Output of `compose ps -q alate` (a container id when the project's alate runs). */
		alatePs?: string;
		/** The image the project's alate container runs (`inspect .Config.Image`). */
		alateInspect?: string;
		/** Running containers that `docker ps --filter name=<regex>` filters like docker does. */
		containers?: { name: string; image: string }[];
		/** The containerd store's platform manifests: the one the server runs, the build's. */
		manifest?: {
			runs: string;
			built: string;
			platform?: { os: string; architecture: string; variant?: string };
		};
		/** Exit codes of the holds in call order, the last one repeating (an older board lacks
		 *  POST /api/drain). */
		hold?: number | number[];
		/** Exit code of the hold's early end (a board older than DELETE /api/drain). */
		free?: number | number[];
		up?: number;
		/** Output of a failing `up` (its error text). */
		upOut?: string;
		/** Exit code and output of `up -d --no-deps --wait <service>`, per service. */
		upBy?: Record<string, { code?: number; out?: string }>;
		/** The board's answers to GET /api/drain, in order; the last one repeats. Without
		 *  them the board answers 404 (one version older) and the run keeps the legacy
		 *  whole-board flow. */
		gets?: string[];
		/** Exit codes of the worker healthz probes in call order, the last one repeating. */
		health?: number | number[];
		/** Runs after each poll wait: work that lands in the checkout mid-hold. */
		onWait?: () => void;
	} = {},
): FakeRun {
	const calls: string[] = [];
	const drains: string[] = [];
	const seedRuns: string[] = [];
	const seedImages: (string | undefined)[] = [];
	const seedWrites: string[] = [];
	const logs: string[] = [];
	const waits: number[] = [];
	const built: FakeRun["built"] = [];
	const turns = typeof o.turns === "string" ? [o.turns] : (o.turns ?? ["0"]);
	const holds = typeof o.hold === "number" ? [o.hold] : (o.hold ?? [0]);
	const healths = typeof o.health === "number" ? [o.health] : (o.health ?? [0]);
	const frees = typeof o.free === "number" ? [o.free] : (o.free ?? [0]);
	const gets = o.gets;
	let counted = 0;
	let holdCalls = 0;
	let getCalls = 0;
	let healthCalls = 0;
	let freeCalls = 0;
	// A real epoch, not 0: the hold limit must measure the time since the hold, not the clock.
	let clock = Date.UTC(2026, 9, 16);
	const deps: Deps = {
		docker: async (...raw) => {
			// The sidecar build's extra compose file gets a fresh temp name each run.
			const extra = raw.find((a) => /ottr-deploy-.*\.yml$/.test(a));
			const args = raw.map((a) => (a === extra ? "<tree>.yml" : a));
			const line = args.join(" ");
			const drain = line.includes("/api/drain");
			const free = drain && line.includes("'DELETE'");
			const get = drain && !free && !line.includes("'POST'");
			const health = line.includes("/healthz");
			if (drain) drains.push(line);
			if (args.includes("board-seed")) {
				seedRuns.push(line);
				seedImages.push(process.env.ALATE_IMAGE);
				calls.push(line);
				return {
					code: o.seedCode ?? 0,
					out: o.seedCode ? "the seed step failed\n" : "",
				};
			}
			if (line.includes("seed-commit") || line.includes("seed-token-expires")) {
				// The read is the `cat` exec, the write is the `printf` exec.
				calls.push(line);
				if (line.includes("cat "))
					return { code: 0, out: `${o.seedRecord ?? ""}\n` };
				seedWrites.push(line);
				return { code: 0, out: "" };
			}
			if (line.startsWith("ps --filter name=")) {
				// Docker's name filter: an unanchored regex against the name, with or without "/".
				calls.push(line);
				const re = new RegExp(line.split(" ")[2]?.slice(5) ?? "");
				const out = (o.containers ?? [])
					.filter((c) => re.test(c.name) || re.test(`/${c.name}`))
					.map((c) => `${c.image}\n`)
					.join("");
				return { code: 0, out };
			}
			calls.push(
				line.replace(
					/ -e .*/s,
					free
						? " -e <free>"
						: get
							? " -e <get>"
							: drain
								? " -e <hold>"
								: health
									? " -e <health>"
									: " -e <count>",
				),
			);
			if (args.includes("build")) {
				// What the sidecar's build context holds while the build runs.
				if (extra !== undefined) {
					const m = /context: (".*")/.exec(readFileSync(extra, "utf8"));
					const tree = JSON.parse(m?.[1] ?? '""') as string;
					built.push({
						tree,
						files: readdirSync(tree)
							.filter((n) => n !== ".git")
							.sort(),
						dockerfile: readFileSync(join(tree, "Dockerfile.worker"), "utf8"),
					});
				}
				return {
					code:
						args.at(-1) === o.sidecar?.name
							? (o.sidecarBuild ?? 0)
							: (o.build ?? 0),
					out: "",
				};
			}
			if (args.includes("ps"))
				return o.psCode
					? { code: o.psCode, out: "Cannot connect to the Docker daemon" }
					: {
							code: 0,
							out: args.includes("--services")
								? `${o.running ?? "server"}\n`
								: args.at(-1) === "alate"
									? `${o.alatePs ?? ""}\n`
									: `${args.at(-1)}\n`,
						};
			if (args.includes("images"))
				return o.imagesCode
					? { code: o.imagesCode, out: "no such service" }
					: { code: 0, out: "0ld\n" };
			if (args.includes("--format"))
				return {
					code: 0,
					out: JSON.stringify({
						services: {
							server: { build: { context: "." } },
							...(o.sidecar
								? {
										[o.sidecar.name]: {
											build: { context: o.sidecar.dir },
										},
									}
								: {}),
						},
					}),
				};
			if (args.includes("config"))
				return {
					code: 0,
					out: `${args.at(-1) === o.sidecar?.name ? `${o.sidecar?.name}:local` : "ottr-worker:local"}\n`,
				};
			// The classic store reports no descriptor: docker prints null.
			if (line.includes("ImageManifestDescriptor"))
				return {
					code: 0,
					out: o.manifest
						? `${JSON.stringify({
								mediaType: "application/vnd.oci.image.manifest.v1+json",
								digest: o.manifest.runs,
								platform: o.manifest.platform ?? {
									architecture: "amd64",
									os: "linux",
								},
							})}\n`
						: "null\n",
				};
			if (args.includes("--platform"))
				return { code: 0, out: `${o.manifest?.built ?? ""}\n` };
			if (line.includes("Config.Image"))
				return { code: 0, out: `${o.alateInspect ?? ""}\n` };
			if (args.includes("inspect")) {
				const fresh = o.newImage ? "sha256:new\n" : "sha256:0ld\n";
				return {
					code: 0,
					out:
						args.at(-1) === `${o.sidecar?.name}:local` && o.sidecarNewImage
							? "sha256:new\n"
							: fresh,
				};
			}
			if (health) {
				const code = healths[Math.min(healthCalls++, healths.length - 1)] ?? 0;
				return code
					? { code, out: "HTTP 500\n" }
					: { code: 0, out: '{"ok":true}\n' };
			}
			if (get) {
				// No answer at all is the mixed-version fallback: a board one version
				// older has no GET /api/drain, and the run keeps the whole-board flow.
				if (gets === undefined) return { code: 1, out: "HTTP 404\n" };
				const g = gets[Math.min(getCalls++, gets.length - 1)] ?? "{}";
				return { code: 0, out: `${g}\n` };
			}
			if (free) {
				const code = frees[Math.min(freeCalls++, frees.length - 1)] ?? 0;
				return code ? { code, out: "HTTP 404\n" } : { code: 0, out: "" };
			}
			if (drain) {
				const code = holds[Math.min(holdCalls++, holds.length - 1)] ?? 0;
				return code ? { code, out: "HTTP 404\n" } : { code: 0, out: "" };
			}
			if (args.includes("exec"))
				return {
					code: 0,
					out: turns[Math.min(counted++, turns.length - 1)] ?? "0",
				};
			if (args.includes("up")) {
				const svc = args.at(-1)!;
				const by = o.upBy?.[svc];
				if (by)
					return {
						code: by.code ?? 0,
						out: by.out ?? (by.code ? `container ${svc} is unhealthy` : ""),
					};
				return args.at(-1) === o.sidecar?.name
					? {
							code: o.sidecarUp ?? 0,
							out: o.sidecarUp ? "container sidecar exited (1)" : "",
						}
					: { code: o.up ?? 0, out: o.upOut ?? "" };
			}
			return { code: 0, out: "" };
		},
		log: (line) => logs.push(line),
		// The harness default never reaches the network: an injected githubApi replaces it.
		githubApi: async () => {
			throw new Error("githubApi not faked");
		},
		wait: async (ms) => {
			clock += ms;
			waits.push(ms);
			o.onWait?.();
		},
		now: () => clock,
	};
	return {
		deps,
		calls,
		drains,
		logs,
		waits,
		built,
		seedRuns,
		seedImages,
		seedWrites,
	};
}

const BUILD = "compose -f c.yml build server";
const COUNT = "compose -f c.yml exec -T server bun -e <count>";
const HOLD = "compose -f c.yml exec -T server bun -e <hold>";
const FREE = "compose -f c.yml exec -T server bun -e <free>";
const PS = "compose -f c.yml ps --services --status running";
const SERVER = "compose -f c.yml ps -q server";
const MANIFEST = "inspect -f {{json .ImageManifestDescriptor}} server";
const CONFIG = "compose -f c.yml config --images server";
const COMPARE = [
	SERVER,
	MANIFEST,
	"compose -f c.yml images -q server",
	CONFIG,
	"image inspect -f {{.Id}} ottr-worker:local",
];
const CFGJSON = "compose -f c.yml config --format json";
const SIDE_BUILD = "compose -f c.yml -f <tree>.yml build sidecar";
const SIDE_UP = "compose -f c.yml up -d --no-deps --wait sidecar";
/** Exactly one sidecar build, from origin/main after the 2.0.0 bump. */
const BUILT_BUMP = [
	expect.objectContaining({
		dockerfile: expect.stringContaining("ARG OMP_VERSION=2.0.0"),
	}),
];
const SIDE_COMPARE = [
	"compose -f c.yml ps -q sidecar",
	"inspect -f {{json .ImageManifestDescriptor}} sidecar",
	"compose -f c.yml images -q sidecar",
	"compose -f c.yml config --images sidecar",
	"image inspect -f {{.Id}} sidecar:local",
];
const UP = "compose -f c.yml up -d --wait";
const PRUNE = "image prune --force --filter label=ottr.image=worker";
const GET = "compose -f c.yml exec -T server bun -e <get>";
const HEALTH = "compose -f c.yml exec -T server bun -e <health>";
const RUNNING3 = "server\nworker-a\nworker-b";
const UP_SVC = (s: string) => `compose -f c.yml up -d --no-deps --wait ${s}`;
const RESTART = "compose -f c.yml restart server";
const COMPARE_SVC = (s: string) => [
	`compose -f c.yml ps -q ${s}`,
	`inspect -f {{json .ImageManifestDescriptor}} ${s}`,
	`compose -f c.yml images -q ${s}`,
	`compose -f c.yml config --images ${s}`,
	`image inspect -f {{.Id}} ottr-worker:local`,
];
/** A GET /api/drain answer: worker-a and worker-b turn counts, `preparing` total. */
const st = (a: number, b: number, preparing = 0) =>
	JSON.stringify({
		drainUntil: null,
		drainCommits: null,
		preparing,
		runners: [
			{ id: "worker-a", url: "http://worker-a:8787", until: null, turns: a },
			{ id: "worker-b", url: "http://worker-b:8787", until: null, turns: b },
			{ id: "local", url: null, until: null, turns: 0 },
		],
	});
/** The JSON body of the n-th POST to /api/drain, parsed out of the bun -e code. */
function postBody(f: FakeRun, n: number): unknown {
	const posts = f.drains.filter((l) => l.includes("'POST'"));
	const m = /body: (".*?") \}\);/.exec(posts[n] ?? "");
	expect(m).toBeTruthy();
	return JSON.parse(JSON.parse(m![1]!));
}

/** What fakes hands back: the fake docker dep plus everything the tests assert on. */
interface FakeRun {
	deps: Deps;
	calls: string[];
	drains: string[];
	logs: string[];
	waits: number[];
	/** The sidecar build contexts: the tree, its files (no .git), its Dockerfile.worker. */
	built: { tree: string; files: string[]; dockerfile: string }[];
	/** The board-seed run call lines, in order. */
	seedRuns: string[];
	/** The ALATE_IMAGE each board-seed run saw, in order. */
	seedImages: (string | undefined)[];
	/** The record writes (`printf %s <sha> > /etc/ottr/seed-commit`), in order. */
	seedWrites: string[];
}

/** The JSON body of the first hold's POST, parsed out of the embedded bun -e code. */
function drainBody(f: FakeRun): unknown {
	const hold = f.drains.find((l) => l.includes("body: "));
	const m = /body: (".*?") \}\);/.exec(hold ?? "");
	expect(m).toBeTruthy();
	return JSON.parse(JSON.parse(m![1]!));
}

describe("updateImage", () => {
	test("CI's bump holds new turns, reaches the stack once the running ones finish, and the host pushes nothing", async () => {
		const { origin, main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ newImage: true, turns: ["2", "1", "0"] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(must(main, "rev-parse", "HEAD")).toBe(
			must(origin, "rev-parse", "main"),
		);
		// The hold comes before the first count, so no turn starts between the last count and up;
		// each poll renews it.
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			HOLD,
			COUNT,
			HOLD,
			COUNT,
			HOLD,
			COUNT,
			UP,
			PRUNE,
		]);
		expect(f.logs.at(-1)).toEndWith("with omp 1.1.0");
		expect(must(origin, "log", "--format=%s", "main")).toBe(
			"chore: bump omp to 1.1.0\na",
		);
	}, 60_000);

	test("a commit that lands in the checkout during the hold does not rename the success line", async () => {
		const { main } = checkout();
		let built = "";
		const f = fakes({
			newImage: true,
			turns: ["1", "0"],
			// The hold can last an hour, and main can move in the host checkout meanwhile:
			// the success line must still name the commit and pin the image was built from.
			onWait: () => {
				built = must(main, "rev-parse", "HEAD");
				writeFileSync(join(main, "Dockerfile.worker"), dockerfile("2.0.0"));
				must(main, "commit", "-q", "-am", "chore: bump omp to 2.0.0");
			},
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		const short = must(main, "log", "-1", "--format=%h", built);
		expect(f.logs.at(-1)).toEndWith(
			`the stack runs main at ${short} with omp 1.0.0`,
		);
	}, 60_000);

	test("a current image holds no turns, and its restart waits for an idle hour", async () => {
		const { main } = checkout();
		const f = fakes({ turns: "2" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, GET, ...COMPARE, COUNT]);
		expect(f.logs.join("\n")).toContain(
			"2 turns run: the restart waits for a later run",
		);
	}, 60_000);

	test("a rebuild that keeps the server's platform manifest holds no turns, though its image id is new", async () => {
		const { main } = checkout();
		const f = fakes({
			newImage: true,
			manifest: { runs: "sha256:m1", built: "sha256:m1" },
			turns: "2",
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			SERVER,
			MANIFEST,
			CONFIG,
			"image inspect --platform linux/amd64 -f {{.Id}} ottr-worker:local",
			COUNT,
		]);
		expect(f.logs.join("\n")).toContain(
			"2 turns run: the restart waits for a later run",
		);
	}, 60_000);

	test("a new platform manifest holds new turns until the restart", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({
			manifest: {
				runs: "sha256:m1",
				built: "sha256:m2",
				platform: { os: "linux", architecture: "arm64", variant: "v8" },
			},
			turns: ["1", "0"],
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			SERVER,
			MANIFEST,
			CONFIG,
			"image inspect --platform linux/arm64/v8 -f {{.Id}} ottr-worker:local",
			HOLD,
			COUNT,
			HOLD,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("a hold waits past the old 40-minute window and restarts once the last turn ends", async () => {
		const { main } = checkout();
		// 81 counts was the old cap: that run ended with the hold still on an idle board.
		const f = fakes({
			newImage: true,
			turns: [...Array<string>(81).fill("1"), "0"],
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.waits).toHaveLength(81);
		expect(f.calls.slice(-2)).toEqual([UP, PRUNE]);
		expect(f.logs.join("\n")).not.toContain("waits for a later run");
	}, 60_000);

	test("a hold that reaches 1 h ends, so the queue moves, and the restart waits for a later run", async () => {
		const { main } = checkout();
		const f = fakes({ newImage: true, turns: "2" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		// 120 polls of 30 s fill the hour; one more would end past it.
		expect(f.waits).toHaveLength(120);
		expect(f.calls.slice(-3)).toEqual([HOLD, COUNT, FREE]);
		expect(f.calls).not.toContain(UP);
		expect(f.logs.join("\n")).toContain(
			"2 turns run after 60 min of hold: the hold ends, and the restart waits for a later run",
		);
	}, 60_000);

	test("a board that cannot end the hold early leaves it to lapse", async () => {
		const { main } = checkout();
		const f = fakes({ newImage: true, turns: "1", free: 1 });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls.at(-1)).toBe(FREE);
		expect(f.logs.join("\n")).toContain(
			"1 turns run after 60 min of hold, and the board cannot end the hold (HTTP 404): it lapses 30 min after the last renewal",
		);
	}, 60_000);

	test("a renewal the board refuses ends the wait, and the restart waits for a later run", async () => {
		const { main } = checkout();
		const f = fakes({ newImage: true, hold: [0, 1], turns: "1" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			HOLD,
			COUNT,
			HOLD,
			COUNT,
		]);
		const log = f.logs.join("\n");
		expect(log).toContain("the board cannot hold new turns: HTTP 404");
		expect(log).toContain("1 turns run: the restart waits for a later run");
	}, 60_000);

	test("a board older than the hold keeps the restart for an idle hour", async () => {
		const { main } = checkout();
		const f = fakes({ newImage: true, hold: 1, turns: "2" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, GET, ...COMPARE, HOLD, COUNT]);
		const log = f.logs.join("\n");
		expect(log).toContain("the board cannot hold new turns: HTTP 404");
		expect(log).toContain("2 turns run: the restart waits for a later run");
	}, 60_000);

	test("an image comparison that fails stops before any hold or restart", async () => {
		const { main } = checkout();
		const f = fakes({ imagesCode: 1 });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		// The runner probe runs first; no board answers it (404), so the legacy flow
		// compares the server and stops before any hold or restart.
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, GET, ...COMPARE]);
		expect(f.logs.join("\n")).toContain("cannot be compared with the build");
	}, 60_000);

	test("a failed build keeps the running containers", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ build: 1 });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).toEqual([BUILD]);
	}, 60_000);

	test("work someone left in the checkout stops the run before any build", async () => {
		const { origin, main, ci } = checkout();
		bump(ci, "1.1.0");
		const run = async () => {
			const f = fakes();
			expect(await updateImage(main, [], f.deps)).toBe(1);
			expect(f.calls).toEqual([]);
			return f.logs.join("\n");
		};
		writeFileSync(join(main, "notes.txt"), "draft");
		expect(await run()).toContain("uncommitted changes");
		rmSync(join(main, "notes.txt"));
		must(main, "commit", "-q", "--allow-empty", "-m", "unpushed");
		expect(await run()).toContain("commits that origin/main lacks");
		must(main, "switch", "-q", "-c", "feature");
		expect(await run()).toContain("not on main");
		expect(readFileSync(join(main, "Dockerfile.worker"), "utf8")).toContain(
			"OMP_VERSION=1.0.0",
		);
		expect(must(origin, "log", "--format=%s", "main")).toBe(
			"chore: bump omp to 1.1.0\na",
		);
	}, 60_000);

	test("a turn count it cannot read never restarts the stack", async () => {
		const { main } = checkout();
		const f = fakes({ turns: "" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, GET, ...COMPARE, COUNT]);
	}, 60_000);

	test("a compose warning ahead of a two-digit count still holds the restart", async () => {
		const { main } = checkout();
		// The real docker dep puts stderr first: compose warnings, then the count and its newline.
		const f = fakes({
			turns:
				"WARN[0000] Found orphan containers ([ottr-old-1]) for this project.\n10\n",
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, GET, ...COMPARE, COUNT]);
		expect(f.logs.join("\n")).toContain("10 turns run");
	}, 60_000);

	test("no running board deploys without counting turns", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ running: "" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, UP, PRUNE]);
		expect(f.logs.join("\n")).toContain("no running board");
	}, 60_000);

	test("a failed up --wait never logs success", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ up: 1 });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, GET, ...COMPARE, COUNT, UP]);
		expect(f.logs.join("\n")).toContain("up --wait failed");
		expect(f.logs.join("\n")).not.toContain("the stack runs main");
	}, 60_000);

	test("a failed ps stops the run instead of reading its error as a running board", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ psCode: 1 });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).toEqual([BUILD, CFGJSON, PS]);
		expect(f.logs.join("\n")).toContain("docker compose ps failed");
	}, 60_000);

	test("the hold carries the new commits' subjects, sent once and reused per renewal", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ newImage: true, turns: ["1", "0"] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			HOLD,
			COUNT,
			HOLD,
			COUNT,
			UP,
			PRUNE,
		]);
		expect(drainBody(f)).toEqual({ commits: ["chore: bump omp to 1.1.0"] });
		// The list is computed once: both renewals embed the same body.
		const posts = f.drains.filter((l) => l.includes("'POST'"));
		expect(posts[1]).toBe(posts[0]);
	}, 60_000);

	test("no new commits sends an empty list, and the hold still works", async () => {
		const { main } = checkout();
		const f = fakes({ newImage: true, turns: ["1", "0"] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(drainBody(f)).toEqual({ commits: [] });
		expect(f.calls).toContain(HOLD);
	}, 60_000);

	test("a huge commit list is capped at 50 subjects", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		for (let i = 0; i < 55; i++) {
			writeFileSync(join(ci, `f${i}.txt`), `${i}`);
			must(ci, "add", ".");
			must(ci, "commit", "-q", "-m", `c${i}`);
		}
		must(ci, "push", "-q", "origin", "HEAD:main");
		const f = fakes({ newImage: true, turns: ["1", "0"] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		const body = drainBody(f) as { commits: string[] };
		expect(body.commits).toHaveLength(50);
		expect(body.commits[0]).toBe("c54");
		// The cap keeps the 50 newest: c5 is the last kept subject, the bump commit below it is not.
		expect(body.commits.at(-1)).toBe("c5");
		expect(body.commits).not.toContain("chore: bump omp to 1.1.0");
	}, 60_000);

	test("a failed pre-merge rev-parse still deploys, with no commits sent", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		// stdout carries a valid sha (the pre-merge HEAD): a failed read must ignore it.
		const stale = must(main, "rev-parse", "HEAD");
		const broken = {
			...realWorktree,
			git: (args: string[], cwd: string, timeoutMs?: number) =>
				args[0] === "rev-parse" && args[1] === "HEAD"
					? Promise.resolve({ code: 1, stdout: `${stale}\n`, stderr: "fatal" })
					: realGit(args, cwd, timeoutMs),
		};
		mock.module("../src/worktree.ts", () => broken);
		try {
			const f = fakes({ newImage: true, turns: ["1", "0"] });
			expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
			expect(drainBody(f)).toEqual({ commits: [] });
			expect(f.calls.slice(-2)).toEqual([UP, PRUNE]);
		} finally {
			mock.module("../src/worktree.ts", () => ({ ...realWorktree }));
		}
	}, 60_000);

	test("the hold script targets the board over loopback and fails closed", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ newImage: true, turns: ["1", "0"] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		const hold = f.drains.find((l) => l.includes("'POST'")) ?? "";
		// The board is reached on its own container port only, and a refused hold must
		// end the wait instead of idling the board until the hold lapses.
		expect(hold).toContain("'http://127.0.0.1:' + process.env.PORT");
		expect(hold).toContain("process.exit(1)");
		expect(hold).toContain("'content-type': 'application/json'");
	}, 60_000);

	test("a subject longer than 200 characters is capped", async () => {
		const { main, ci } = checkout();
		const long = `c: ${"x".repeat(250)}`;
		writeFileSync(join(ci, "long.txt"), "long");
		must(ci, "add", ".");
		must(ci, "commit", "-q", "-m", long);
		must(ci, "push", "-q", "origin", "HEAD:main");
		const f = fakes({ newImage: true, turns: ["1", "0"] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		const body = drainBody(f) as { commits: string[] };
		expect(body.commits).toEqual([long.slice(0, 200)]);
	}, 60_000);

	test("a new commit in another checkout builds there from origin/main and restarts its service", async () => {
		const { main } = checkout();
		const side = checkout();
		bump(side.ci, "2.0.0");
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
			sidecarNewImage: true,
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		const head = must(side.origin, "rev-parse", "main");
		expect(must(side.main, "rev-parse", "HEAD")).toBe(head);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			SIDE_BUILD,
			...SIDE_COMPARE,
			SIDE_UP,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
		expect(f.built).toEqual(BUILT_BUMP);
		const log = f.logs.join("\n");
		expect(log).toContain("sidecar: the build changes the running image");
		expect(log).toContain(
			`sidecar: the stack runs origin/main at ${head.slice(0, 12)}`,
		);
		// The worktree is gone again, from the disk and from the checkout's list.
		expect(f.built.map((b) => existsSync(b.tree))).toEqual([false]);
		expect(must(side.main, "worktree", "list").split("\n")).toHaveLength(1);
	}, 60_000);

	test("a commit made in the checkout itself deploys, though no fast-forward moves its HEAD", async () => {
		const { main } = checkout();
		const side = checkout();
		bump(side.main, "2.0.0"); // committed and pushed there: HEAD is origin/main already
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
			sidecarNewImage: true,
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.built).toEqual(BUILT_BUMP);
		expect(f.calls).toContain(SIDE_UP);
	}, 60_000);

	test("an unchanged checkout rebuilds from the cache and restarts nothing", async () => {
		const { main } = checkout();
		const side = checkout();
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			SIDE_BUILD,
			...SIDE_COMPARE,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("a dirty checkout stays as it is, and none of its files reach the build", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const side = checkout();
		const start = must(side.main, "rev-parse", "HEAD");
		bump(side.ci, "2.0.0");
		writeFileSync(join(side.main, "notes.txt"), "draft");
		writeFileSync(join(side.main, "Dockerfile.worker"), "FROM local-edit\n");
		const f = fakes({
			newImage: true,
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
			sidecarNewImage: true,
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.join("\n")).toContain(
			"has uncommitted changes, so it stays as it is",
		);
		expect(must(side.main, "rev-parse", "HEAD")).toBe(start);
		expect(readFileSync(join(side.main, "notes.txt"), "utf8")).toBe("draft");
		expect(readFileSync(join(side.main, "Dockerfile.worker"), "utf8")).toBe(
			"FROM local-edit\n",
		);
		expect(f.built).toEqual([
			expect.objectContaining({
				files: ["Dockerfile.worker"],
				dockerfile: expect.stringContaining("ARG OMP_VERSION=2.0.0"),
			}),
		]);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			SIDE_BUILD,
			...SIDE_COMPARE,
			SIDE_UP,
			PS,
			GET,
			...COMPARE,
			HOLD,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("a checkout whose origin cannot be fetched skips its service", async () => {
		const { main } = checkout();
		const side = checkout();
		rmSync(side.origin, { recursive: true, force: true });
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.join("\n")).toContain(
			"skipping sidecar: git fetch origin main failed in",
		);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("a failed restart of the service logs docker's text, and the server deploy goes on", async () => {
		const { main } = checkout();
		const side = checkout();
		bump(side.ci, "2.0.0");
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
			sidecarNewImage: true,
			sidecarUp: 1,
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		const log = f.logs.join("\n");
		expect(log).toContain(
			"sidecar: docker compose up --wait failed: container sidecar exited (1)",
		);
		expect(log).not.toContain("sidecar: the stack runs");
		expect(f.calls.slice(-2)).toEqual([UP, PRUNE]);
	}, 60_000);

	test("a compose config without another checkout deploys exactly the server", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ newImage: true, turns: "0" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		const log = f.logs.join("\n");
		expect(log).not.toContain("skipping");
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			HOLD,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("a build context in this repo or outside a git checkout is no sidecar", async () => {
		const { main } = checkout();
		const f1 = fakes({
			turns: "0",
			sidecar: { name: "self", dir: main }, // the repo's own context
		});
		expect(await updateImage(main, ["-f", "c.yml"], f1.deps)).toBe(0);
		expect(f1.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
		const f2 = fakes({
			turns: "0",
			sidecar: { name: "plain", dir: join(root, "no-git") }, // no .git
		});
		expect(await updateImage(main, ["-f", "c.yml"], f2.deps)).toBe(0);
		expect(f2.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
		expect(f2.logs.join("\n")).not.toContain("skipping");
	}, 60_000);

	test("a checkout that cannot fast-forward keeps its commit, and the build uses origin/main", async () => {
		const { main } = checkout();
		const side = checkout();
		must(side.main, "commit", "-q", "--allow-empty", "-m", "local work");
		const local = must(side.main, "rev-parse", "HEAD");
		bump(side.ci, "2.0.0"); // the checkout and its origin diverge
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.join("\n")).toContain(
			"does not fast-forward to origin/main, so it stays as it is",
		);
		expect(must(side.main, "rev-parse", "HEAD")).toBe(local);
		expect(f.built).toEqual(BUILT_BUMP);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			SIDE_BUILD,
			...SIDE_COMPARE,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("a checkout off main stays on its branch, and the build uses origin/main", async () => {
		const { main } = checkout();
		const side = checkout();
		bump(side.ci, "2.0.0");
		must(side.main, "switch", "-q", "-c", "feature");
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.join("\n")).toContain("is not on main, so it stays as it is");
		expect(must(side.main, "branch", "--show-current")).toBe("feature");
		expect(f.built).toEqual(BUILT_BUMP);
	}, 60_000);

	test("a build that fails there removes its worktree and keeps the server deploy going", async () => {
		const { main } = checkout();
		const side = checkout();
		bump(side.ci, "2.0.0");
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
			sidecarBuild: 1,
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.join("\n")).toContain(
			"skipping sidecar: the image does not build; the stack keeps the old one",
		);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			SIDE_BUILD,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
		expect(f.built.map((b) => existsSync(b.tree))).toEqual([false]);
		expect(must(side.main, "worktree", "list").split("\n")).toHaveLength(1);
	}, 60_000);

	test("a comparison that fails there skips the service and still stops like the server does", async () => {
		const { main } = checkout();
		const side = checkout();
		bump(side.ci, "2.0.0");
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
			imagesCode: 1,
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		const log = f.logs.join("\n");
		expect(log).toContain(
			"skipping sidecar: its image cannot be compared with the build: no such service",
		);
		expect(log).toContain(
			"the server's image cannot be compared with the build: no such service",
		);
	}, 60_000);

	test("a rebuild there that keeps the image logs no change", async () => {
		const { main } = checkout();
		const side = checkout();
		bump(side.ci, "2.0.0");
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.join("\n")).toContain(
			"sidecar: the rebuild matches the running image",
		);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			SIDE_BUILD,
			...SIDE_COMPARE,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	// Survivors left in the commit-list code, each unable to change observable behavior:
	// - `deployed === ""` -> false and -> "Stryker was here!": every unusable deployed sha
	//   makes `git log <deployed>..HEAD` fail, and a failed log yields the same empty list
	//   the real code produces.
	// - the "" fallback -> "Stryker was here!": the fallback only applies on failure, and
	//   the sentinel is never a valid revision, so the range fails either way.
	// - `.trim()` dropped: git strips a subject's outer whitespace itself, so %s never
	//   prints a padded line for the trim to matter; the /api/drain route re-trims anyway.
});

describe("rolling restart", () => {
	/** Runs a bun -e script with PORT on a local fake board: its exit code and stdout. */
	async function runOnBoard(
		script: string,
		board: (req: Request) => Response,
	): Promise<{ code: number; out: string }> {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: board });
		try {
			// A healthz probe names the worker's own url; point it at the fake board.
			const src = script.replace(
				"http://worker-a:8787",
				`http://127.0.0.1:${server.port}`,
			);
			const p = Bun.spawn([process.execPath, "-e", src], {
				env: { ...process.env, PORT: String(server.port) },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, code] = await Promise.all([
				new Response(p.stdout).text(),
				p.exited,
			]);
			return { code, out: out.trim() };
		} finally {
			server.stop(true);
		}
	}

	test("the roll drains, recreates, probes and releases one worker at a time, and the server rolls last", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		// worker-a runs one turn at probe time; it drains over one poll.
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(1, 0), st(0, 0)],
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE_SVC("worker-a"),
			HOLD,
			GET,
			// The wait renews the runner hold: one POST holds 30 min, the wait may
			// reach 1 h, and a lapsed hold would take turns again before the recreate.
			HOLD,
			UP_SVC("worker-a"),
			HEALTH,
			FREE,
			...COMPARE_SVC("worker-b"),
			HOLD,
			UP_SVC("worker-b"),
			HEALTH,
			FREE,
			...COMPARE_SVC("server"),
			HOLD,
			COUNT,
			UP_SVC("server"),
			UP,
			PRUNE,
		]);
		// Each hold names only its own runner, and the renewal re-holds worker-a;
		// the server step holds the whole board with the commit subjects.
		expect(postBody(f, 0)).toEqual({ runner: "worker-a" });
		expect(postBody(f, 1)).toEqual({ runner: "worker-a" });
		expect(postBody(f, 2)).toEqual({ runner: "worker-b" });
		expect(postBody(f, 3)).toEqual({ commits: ["chore: bump omp to 1.1.0"] });
		const deletes = f.drains.filter((l) => l.includes("'DELETE'"));
		expect(deletes.some((l) => l.includes("worker-a"))).toBe(true);
		expect(deletes.some((l) => l.includes("worker-b"))).toBe(true);
	}, 60_000);

	test("a stuck runner is released, the roll goes on, and the server step waits for a later run", async () => {
		const { main } = checkout();
		const data = checkout();
		const unrecorded = "0".repeat(40);
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(2, 0)],
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
		});
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		// 120 polls of 30 s fill worker-a's hour; then the runner is released.
		expect(f.waits).toHaveLength(120);
		expect(f.calls).not.toContain(UP_SVC("server"));
		expect(f.calls).not.toContain(RESTART);
		// The roll still finishes the idle worker. The whole-stack up must not run: it
		// would recreate the stuck worker and the server, and that kills the stuck turn.
		expect(f.calls).toContain(UP_SVC("worker-b"));
		expect(f.calls).not.toContain(UP);
		expect(f.calls.slice(-2)).toEqual([FREE, PRUNE]);
		expect(f.logs.join("\n")).toContain(
			"worker-a keeps a turn after 60 min: its hold ends, and its restart waits for a later run",
		);
		expect(f.logs.join("\n")).toContain(
			"the server restart waits for a later run",
		);
		// The stuck runner is undrained, and the seed record waits for the restart.
		const deletes = f.drains.filter((l) => l.includes("'DELETE'"));
		expect(deletes.some((l) => l.includes("worker-a"))).toBe(true);
		expect(f.seedWrites).toEqual([]);
	}, 60_000);

	test("a refused renewal ends the wait: the runner is released and the roll stops", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(1, 0)], // worker-a keeps its turn at every read
			hold: [0, 1], // the initial hold is accepted, the renewal is refused
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		// The refused renewal ends worker-a's wait at the first poll, not at the hour;
		// a lapsed hold would let the worker take turns again before its recreate.
		expect(f.waits).toHaveLength(1);
		expect(f.calls).not.toContain(UP_SVC("worker-a"));
		expect(f.logs.join("\n")).toContain(
			"worker-a keeps a turn after 60 min: its hold ends, and its restart waits for a later run",
		);
	}, 60_000);

	test("a failed recreate of a worker stops the roll, and no other container gets a call", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(0, 0)],
			upBy: { "worker-a": { code: 1, out: "container worker-a exited (1)" } },
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE_SVC("worker-a"),
			HOLD,
			UP_SVC("worker-a"),
		]);
		expect(f.logs.join("\n")).toContain(
			"stopped: docker compose up --wait worker-a failed: container worker-a exited (1)",
		);
		// The failed worker keeps no hold (it lapses on its own), and no undrain ran.
		expect(f.drains.some((l) => l.includes("'DELETE'"))).toBe(false);
	}, 60_000);

	test("a worker that never answers its healthz stops the roll like a failed health check", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(0, 0)],
			health: 1,
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		// 10 waits of 30 s fill the 5 min connected limit; the 11th probe stops the run.
		expect(f.waits).toHaveLength(10);
		expect(f.calls.slice(-11)).toEqual(Array(11).fill(HEALTH));
		expect(f.calls).not.toContain(UP);
		expect(f.calls).not.toContain(UP_SVC("worker-b"));
		expect(f.logs.join("\n")).toContain(
			"stopped: worker-a never answers http://worker-a:8787/healthz: HTTP 500",
		);
		expect(f.drains.some((l) => l.includes("'DELETE'"))).toBe(false);
	}, 60_000);

	test("a board one version older keeps the whole-board flow", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ newImage: true, turns: ["1", "0"] }); // GET /api/drain answers 404
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		// The probe ran, but no runner hold: the whole-board flow holds and restarts all.
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			HOLD,
			COUNT,
			HOLD,
			COUNT,
			UP,
			PRUNE,
		]);
		expect(postBody(f, 0)).toEqual({ commits: ["chore: bump omp to 1.1.0"] });
	}, 60_000);

	test("a worker hostname no runner lists recreates without a hold", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const onlyA = JSON.stringify({
			drainUntil: null,
			drainCommits: null,
			preparing: 0,
			runners: [
				{
					id: "worker-a",
					url: "http://worker-a:8787",
					until: null,
					turns: 0,
				},
			],
		});
		const f = fakes({ newImage: true, running: RUNNING3, gets: [onlyA] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE_SVC("worker-a"),
			HOLD,
			UP_SVC("worker-a"),
			HEALTH,
			FREE,
			...COMPARE_SVC("worker-b"),
			UP_SVC("worker-b"),
			...COMPARE_SVC("server"),
			HOLD,
			COUNT,
			UP_SVC("server"),
			UP,
			PRUNE,
		]);
		expect(f.logs.join("\n")).toContain(
			"worker-b is no runner on the board: it recreates without a hold",
		);
		expect(f.drains.join("\n")).not.toContain("worker-b");
	}, 60_000);

	test("unchanged worker images roll nothing", async () => {
		const { main } = checkout();
		const f = fakes({ running: RUNNING3, gets: [st(0, 0)] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE_SVC("worker-a"),
			...COMPARE_SVC("worker-b"),
			...COMPARE_SVC("server"),
			UP,
			PRUNE,
		]);
		expect(f.drains.filter((l) => l.includes("'POST'"))).toEqual([]);
	}, 60_000);

	test("a fresh seed with unchanged images restarts only the server after the workers", async () => {
		const { main } = checkout();
		const data = checkout();
		const head = must(data.main, "rev-parse", "HEAD");
		const unrecorded = "0".repeat(40);
		const seedRun = `compose -f c.yml run --rm --no-deps -v ${data.main}:/data:ro board-seed --data /data`;
		const write = `compose -f c.yml exec -T server sh -c printf %s '${head}' > /etc/ottr/seed-commit`;
		const f = fakes({
			running: RUNNING3,
			gets: [st(0, 0)],
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
		});
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			`compose -f c.yml exec -T server sh -c cat /etc/ottr/seed-commit`,
			"compose -f c.yml ps -q alate",
			"inspect -f {{.Config.Image}} alate123",
			seedRun,
			GET,
			...COMPARE_SVC("worker-a"),
			...COMPARE_SVC("worker-b"),
			...COMPARE_SVC("server"),
			HOLD,
			COUNT,
			RESTART,
			UP,
			write,
			PRUNE,
		]);
		expect(postBody(f, 0)).toEqual({
			commits: [`board agent layer seed ${head.slice(0, 12)}`],
		});
		expect(f.seedWrites).toEqual([write]);
	}, 60_000);

	test("a preparing turn holds every runner idle until it starts", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		// preparing is not attributable to one runner: the roll waits one poll for it.
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(0, 0, 1), st(0, 0)],
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toContain(GET);
		expect(f.waits).toHaveLength(1);
		expect(f.calls).toContain(UP_SVC("worker-a"));
	}, 60_000);

	test("a refused runner hold stops the roll before that worker rolls", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(0, 0)],
			hold: [0, 1], // worker-a's hold is accepted, worker-b's is refused
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE_SVC("worker-a"),
			HOLD,
			UP_SVC("worker-a"),
			HEALTH,
			FREE,
			...COMPARE_SVC("worker-b"),
			HOLD,
		]);
		expect(f.logs.join("\n")).toContain(
			"stopped: the board cannot hold worker-b: HTTP 404",
		);
	}, 60_000);

	test("a failed undrain after a successful roll logs and the run goes on", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(0, 0)],
			free: [0, 1], // worker-a releases, worker-b's undrain fails
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.join("\n")).toContain(
			"the board cannot end worker-b's hold (HTTP 404): it lapses 30 min after the last renewal",
		);
		// The failed undrain does not stop the roll: the server still rolls last.
		expect(f.calls).toContain(UP_SVC("server"));
	}, 60_000);

	test("a runner state that cannot be read mid-hold stops the roll", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ newImage: true, running: RUNNING3, gets: [st(1, 0)] });
		let gets = 0;
		const docker: Deps["docker"] = async (...a) => {
			const line = a.join(" ");
			if (line.includes("'/api/drain'") && !line.includes("method")) {
				if (++gets === 2) return { code: 1, out: "HTTP 500\n" };
			}
			return f.deps.docker(...a);
		};
		expect(
			await updateImage(main, ["-f", "c.yml"], { ...f.deps, docker }),
		).toBe(1);
		expect(f.logs.join("\n")).toContain(
			"stopped: the board's runners cannot be read: the hold on worker-a lapses 30 min after the last renewal",
		);
		expect(f.calls).not.toContain(UP_SVC("worker-a"));
	}, 60_000);

	test("a stuck runner the board cannot release leaves the hold to lapse", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(2, 0)],
			free: 1,
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.join("\n")).toContain(
			"worker-a keeps a turn after 60 min, and the board cannot end its hold (HTTP 404): it lapses 30 min after the last renewal",
		);
		expect(f.calls).not.toContain(UP_SVC("server"));
	}, 60_000);

	test("the runner scripts read, hold, probe and release from the server, with its own origin", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({
			newImage: true,
			running: RUNNING3,
			gets: [st(1, 0), st(0, 0)],
		});
		const scripts = new Set<string>();
		const docker: Deps["docker"] = (...a) => {
			if (a.at(-2) === "-e") scripts.add(a.at(-1)!);
			return f.deps.docker(...a);
		};
		expect(
			await updateImage(main, ["-f", "c.yml"], { ...f.deps, docker }),
		).toBe(0);
		const byKind = (kind: (s: string) => boolean): string[] =>
			[...scripts].filter(kind);
		const get = byKind(
			(s) => s.includes("'/api/drain'") && !s.includes("method"),
		)[0]!;
		const hold = byKind(
			(s) => s.includes("worker-a") && s.includes("'POST'"),
		)[0]!;
		const free = byKind((s) => s.includes("'DELETE'"))[0]!;
		const health = byKind((s) => s.includes("/healthz"))[0]!;
		const seen: string[] = [];
		const probe = await runOnBoard(health, (req) => {
			seen.push(req.url);
			return new Response("ok"); // the real worker answers /healthz with plain ok
		});
		expect(seen[0]).toEndWith("/healthz");
		// The probe prints nothing on success; a non-ok answer prints the HTTP status.
		expect(probe).toEqual({ code: 0, out: "" });
		const read = await runOnBoard(
			get,
			() => new Response(JSON.stringify({ preparing: 0, runners: [] })),
		);
		expect(read).toEqual({
			code: 0,
			out: JSON.stringify({ preparing: 0, runners: [] }),
		});
		expect(
			await runOnBoard(get, () => new Response("", { status: 404 })),
		).toEqual({ code: 1, out: "HTTP 404" });
		const held: string[] = [];
		const holdRes = await runOnBoard(hold, (req) => {
			held.push(
				`${req.method} ${new URL(req.url).pathname} ${req.headers.get("origin")}`,
			);
			return Response.json({ until: 1 });
		});
		// The hold and free scripts print nothing on success; a non-ok answer prints
		// the HTTP status, and the run fails closed on it.
		expect(holdRes).toEqual({ code: 0, out: "" });
		expect(held[0]).toMatch(/^POST \/api\/drain http:\/\/127\.0\.0\.1:\d+$/);
		expect(hold).toContain("worker-a");
		const freed: string[] = [];
		const freeRes = await runOnBoard(free, (req) => {
			const u = new URL(req.url);
			freed.push(
				`${req.method} ${u.pathname}${u.search} ${req.headers.get("origin")}`,
			);
			return Response.json({ until: null });
		});
		expect(freed[0]).toMatch(
			/^DELETE \/api\/drain\?runner=worker-a http:\/\/127\.0\.0\.1:\d+$/,
		);
		expect(freeRes).toEqual({ code: 0, out: "" });
	}, 60_000);
});

describe("arch-review survivor kills", () => {
	test("a failed ps reports docker's own error text", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ psCode: 1 });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.logs.join("\n")).toContain(
			"docker compose ps failed: Cannot connect to the Docker daemon",
		);
	}, 60_000);

	test("a listed server is counted before the restart", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ running: "worker\nserver" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			SERVER,
			MANIFEST,
			"compose -f c.yml images -q server",
			"compose -f c.yml config --images server",
			"image inspect -f {{.Id}} ottr-worker:local",
			COUNT,
			UP,
			"image prune --force --filter label=ottr.image=worker",
		]);
		expect(f.logs.join("\n")).not.toContain("no running board");
	}, 60_000);

	test("a failed up --wait reports docker's own error text", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ up: 1, upOut: "dependency failed to start" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.logs.join("\n")).toContain(
			"docker compose up --wait failed: dependency failed to start",
		);
	}, 60_000);
});

describe("board seed", () => {
	const DATA_READ =
		"compose -f c.yml exec -T server sh -c cat /etc/ottr/seed-commit";
	const ALATE_PS = "compose -f c.yml ps -q alate";
	const ALATE_INSPECT = "inspect -f {{.Config.Image}} alate123";
	const DOCKER_PS = "ps --filter name=^/?alate$ --format {{.Image}}";
	const RESTART = "compose -f c.yml restart server";
	const unrecorded = "0".repeat(40);

	test("an unrecorded data-repo head seeds the agent layer once and records the commit", async () => {
		const { main } = checkout();
		const data = checkout();
		const head = must(data.main, "rev-parse", "HEAD");
		const write = `compose -f c.yml exec -T server sh -c printf %s '${head}' > /etc/ottr/seed-commit`;
		const f = fakes({
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
		});
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		const seedRun = `compose -f c.yml run --rm --no-deps -v ${data.main}:/data:ro board-seed --data /data`;
		expect(f.seedRuns).toEqual([seedRun]);
		expect(f.seedWrites).toEqual([write]);
		// A seeded layer joins the image change as a restart reason: the hold happens, and
		// a server that keeps its image restarts after up.
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			DATA_READ,
			ALATE_PS,
			ALATE_INSPECT,
			seedRun,
			GET,
			...COMPARE,
			HOLD,
			COUNT,
			UP,
			RESTART,
			// The record lands after the restart: a run that ends early leaves it
			// unwritten, so the next run seeds again and retries.
			write,
			PRUNE,
		]);
		expect(f.logs.join("\n")).toContain(
			`board agent layer seeded at ${head.slice(0, 12)}`,
		);
		expect(drainBody(f)).toEqual({
			commits: [`board agent layer seed ${head.slice(0, 12)}`],
		});
		// The discovered image reached only the compose child, not the run's environment.
		expect(process.env.ALATE_IMAGE).toBeUndefined();
	}, 60_000);

	test("a recorded head the data repo already has seeds nothing", async () => {
		const { main } = checkout();
		const data = checkout();
		const head = must(data.main, "rev-parse", "HEAD");
		const f = fakes({ seedRecord: head });
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		expect(f.seedRuns).toEqual([]);
		expect(f.seedWrites).toEqual([]);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			DATA_READ,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
		expect(f.logs.join("\n")).toContain(
			`board agent layer current at ${head.slice(0, 12)}`,
		);
	}, 60_000);

	test("a failed seed run writes no record, but the deploy itself still completes", async () => {
		const { main } = checkout();
		const data = checkout();
		const f = fakes({
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
			seedCode: 1,
		});
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(1);
		expect(f.seedWrites).toEqual([]);
		const log = f.logs.join("\n");
		expect(log).toContain("board seed failed: the seed step failed");
		expect(log).toContain("the stack runs main at");
		expect(f.calls.slice(-2)).toEqual([UP, PRUNE]);
	}, 60_000);

	test("a failed seed exits 1 even when running turns hold the restart", async () => {
		const { main } = checkout();
		const data = checkout();
		const f = fakes({
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
			seedCode: 1,
			turns: "2",
		});
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(1);
		const log = f.logs.join("\n");
		expect(log).toContain("board seed failed: the seed step failed");
		expect(log).toContain("2 turns run: the restart waits for a later run");
		expect(f.calls).not.toContain(UP);
	}, 60_000);

	test("a seed with no alate image anywhere fails and names the env file", async () => {
		const { main } = checkout();
		const data = checkout();
		const f = fakes({ seedRecord: unrecorded });
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(1);
		expect(f.seedRuns).toEqual([]);
		expect(f.seedWrites).toEqual([]);
		expect(f.logs.join("\n")).toContain("set ALATE_IMAGE in the env file");
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			DATA_READ,
			ALATE_PS,
			DOCKER_PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("the docker ps fallback takes only the container named exactly alate", async () => {
		const { main } = checkout();
		const data = checkout();
		// Docker lists newer containers first: the substring matches come before alate.
		const others = [
			{ name: "translate-api", image: "evil:1" },
			{ name: "my-alate-test", image: "evil:2" },
		];
		const f = fakes({
			seedRecord: unrecorded,
			containers: [...others, { name: "alate", image: "alate:good" }],
		});
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		expect(f.seedImages).toEqual(["alate:good"]);

		// Only substring matches: no image, and the seed never runs.
		const none = fakes({ seedRecord: unrecorded, containers: others });
		expect(
			await updateImage(main, ["-f", "c.yml"], none.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(1);
		expect(none.seedRuns).toEqual([]);
		expect(none.logs.join("\n")).toContain("set ALATE_IMAGE in the env file");
	}, 60_000);

	test("a seed with a changed server image holds, and the recreate restarts it without another restart call", async () => {
		const { main } = checkout();
		const data = checkout();
		const head = must(data.main, "rev-parse", "HEAD");
		const f = fakes({
			newImage: true,
			turns: ["1", "0"],
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
		});
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		expect(f.calls).not.toContain(RESTART);
		expect(f.calls).toContain(HOLD);
		// The recreate counts as the board taking the seed, so the record follows up.
		expect(f.calls.slice(-2)).toEqual([
			`compose -f c.yml exec -T server sh -c printf %s '${head}' > /etc/ottr/seed-commit`,
			PRUNE,
		]);
	}, 60_000);

	test("a seed whose restart waits for a later run seeds and restarts on the next run", async () => {
		const { main } = checkout();
		const data = checkout();
		const head = must(data.main, "rev-parse", "HEAD");
		// Run 1: the board never goes idle, so the hold lapses and the restart waits.
		const busy = fakes({
			turns: ["1"],
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
		});
		expect(
			await updateImage(main, ["-f", "c.yml"], busy.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		expect(busy.seedRuns).toHaveLength(1);
		// The record stays unwritten: the next run must seed again and restart then.
		expect(busy.seedWrites).toEqual([]);
		expect(busy.calls).not.toContain(UP);
		expect(busy.calls).not.toContain(RESTART);
		// Run 2: an idle board — the retry seeds, restarts, and records the commit.
		const idle = fakes({
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
		});
		expect(
			await updateImage(main, ["-f", "c.yml"], idle.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		expect(idle.seedRuns).toHaveLength(1);
		expect(idle.seedWrites).toEqual([
			`compose -f c.yml exec -T server sh -c printf %s '${head}' > /etc/ottr/seed-commit`,
		]);
		expect(idle.calls).toContain(RESTART);
	}, 60_000);

	test("an environment without a data source skips the seed entirely", async () => {
		const { main } = checkout();
		const f = fakes();
		expect(await updateImage(main, ["-f", "c.yml"], f.deps, {})).toBe(0);
		expect(f.seedRuns).toEqual([]);
		expect(f.seedWrites).toEqual([]);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
		expect(f.logs.join("\n")).toContain(
			"no ALATE_DATA or ALATE_DATA_REPO in the environment",
		);
	}, 60_000);

	test("ALATE_DATA wins over ALATE_DATA_REPO, and the repo is never read", async () => {
		const { main } = checkout();
		const data = checkout();
		const head = must(data.main, "rev-parse", "HEAD");
		const f = fakes({ seedRecord: head });
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
				ALATE_DATA_REPO: "example/repo",
			}),
		).toBe(0);
		expect(f.seedRuns).toEqual([]);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			DATA_READ,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
		expect(f.logs.join("\n")).toContain("ALATE_DATA wins over ALATE_DATA_REPO");
	}, 60_000);

	/** Runs `run` with GitHub served from `dir`: real git, with each `https://github.com/<name>`
	 *  rewritten to `<dir>/<name>` (url.insteadOf). Returns the argv of each ls-remote. */
	async function fromLocalGitHub(
		dir: string,
		run: () => Promise<void>,
	): Promise<string[][]> {
		const remotes: string[][] = [];
		mock.module("../src/worktree.ts", () => ({
			...realWorktree,
			git: (args: string[], cwd: string, timeoutMs?: number) => {
				if (args.includes("ls-remote")) remotes.push(args);
				return realGit(
					["-c", `url.${dir}/.insteadOf=https://github.com/`, ...args],
					cwd,
					timeoutMs,
				);
			},
		}));
		try {
			await run();
		} finally {
			mock.module("../src/worktree.ts", () => ({ ...realWorktree }));
		}
		return remotes;
	}

	test("ALATE_DATA_REPO seeds the head of its GitHub branch, with the token only in the env", async () => {
		const { main } = checkout();
		const data = checkout();
		const github = join(root, String(fixtures++));
		must(
			root,
			"clone",
			"-q",
			"--bare",
			data.origin,
			join(github, "example", "data"),
		);
		const head = must(data.main, "rev-parse", "HEAD");
		// A second branch whose head differs from main's: the @ref picks it.
		must(data.main, "commit", "-q", "--allow-empty", "-m", "b");
		const other = must(data.main, "rev-parse", "HEAD");
		must(
			data.main,
			"push",
			"-q",
			join(github, "example", "data"),
			"HEAD:refs/heads/seed",
		);
		const token = "tok-never-in-argv";
		const f = fakes({
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
		});
		const g = fakes({
			seedRecord: unrecorded,
			alatePs: "alate123",
			alateInspect: "alate:current",
		});
		const remotes = await fromLocalGitHub(github, async () => {
			expect(
				await updateImage(main, ["-f", "c.yml"], f.deps, {
					ALATE_DATA_REPO: "example/data",
					GH_TOKEN: token,
				}),
			).toBe(0);
			expect(
				await updateImage(main, ["-f", "c.yml"], g.deps, {
					ALATE_DATA_REPO: "example/data@seed",
				}),
			).toBe(0);
		});
		expect(remotes).toEqual([
			[
				"-c",
				"credential.helper=!f(){ echo username=x-access-token; echo password=$GH_TOKEN; };f",
				"ls-remote",
				"https://github.com/example/data",
				"refs/heads/main",
			],
			["ls-remote", "https://github.com/example/data", "refs/heads/seed"],
		]);
		expect(remotes.flat().join(" ")).not.toContain(token);
		// No ref means main; the board-seed gets the repo value as written.
		expect(f.seedRuns).toEqual([
			"compose -f c.yml run --rm --no-deps board-seed --repo example/data",
		]);
		expect(f.seedWrites).toEqual([
			`compose -f c.yml exec -T server sh -c printf %s '${head}' > /etc/ottr/seed-commit`,
		]);
		expect(g.seedRuns).toEqual([
			"compose -f c.yml run --rm --no-deps board-seed --repo example/data@seed",
		]);
		expect(g.seedWrites).toEqual([
			`compose -f c.yml exec -T server sh -c printf %s '${other}' > /etc/ottr/seed-commit`,
		]);
	}, 60_000);

	test("an ALATE_DATA_REPO that ls-remote cannot read fails the seed, but the deploy completes", async () => {
		const { main } = checkout();
		const data = checkout();
		const github = join(root, String(fixtures++));
		must(
			root,
			"clone",
			"-q",
			"--bare",
			data.origin,
			join(github, "example", "data"),
		);
		// A missing branch: ls-remote exits 0 with no line. A missing repo: ls-remote exits non-zero.
		const runs = ["example/data@nope", "example/gone"].map((repo) => ({
			repo,
			f: fakes({ seedRecord: unrecorded, alatePs: "alate123" }),
		}));
		await fromLocalGitHub(github, async () => {
			for (const { repo, f } of runs)
				expect(
					await updateImage(main, ["-f", "c.yml"], f.deps, {
						ALATE_DATA_REPO: repo,
					}),
				).toBe(1);
		});
		for (const { repo, f } of runs) {
			expect(f.seedRuns).toEqual([]);
			expect(f.seedWrites).toEqual([]);
			expect(f.calls).toEqual([
				BUILD,
				CFGJSON,
				PS,
				GET,
				...COMPARE,
				COUNT,
				UP,
				PRUNE,
			]);
			expect(f.logs.join("\n")).toContain(
				`board seed failed: git ls-remote ${repo.split("@")[0]} failed`,
			);
		}
	}, 60_000);

	test("the seed token probe writes the expiry (or none) to seed-token-expires, and never logs the token", async () => {
		const { main } = checkout();
		const data = checkout();
		const github = join(root, String(fixtures++));
		must(
			root,
			"clone",
			"-q",
			"--bare",
			data.origin,
			join(github, "example", "data"),
		);
		const token = "tok-never-in-argv";
		const head = must(data.main, "rev-parse", "HEAD");
		const iso = "2027-10-30T00:00:00.000Z";
		const expiryRun = (
			githubApi: Deps["githubApi"],
			o?: Parameters<typeof fakes>[0],
		) => {
			const f = fakes({
				seedRecord: unrecorded,
				alatePs: "alate123",
				alateInspect: "alate:current",
				...o,
			});
			f.deps.githubApi = githubApi;
			return f;
		};
		const header = (h: string) => async () =>
			new Response("{}", {
				status: 200,
				headers: { "github-authentication-token-expiration": h },
			});
		const dated = expiryRun(header("2027-10-30 00:00:00 UTC"));
		const undated = expiryRun(async () => new Response("{}", { status: 200 }));
		const badDate = expiryRun(header("not a date"));
		const refused = expiryRun(async () => new Response("{}", { status: 403 }));
		const thrown = expiryRun(async () => {
			throw new Error("offline");
		});
		await fromLocalGitHub(github, async () => {
			for (const f of [dated, undated, badDate, refused, thrown])
				expect(
					await updateImage(main, ["-f", "c.yml"], f.deps, {
						ALATE_DATA_REPO: "example/data",
						GH_TOKEN: token,
					}),
				).toBe(0);
		});
		expect(dated.seedWrites).toEqual([
			`compose -f c.yml exec -T server sh -c printf %s '${head}' > /etc/ottr/seed-commit`,
			`compose -f c.yml exec -T server sh -c printf %s '${iso}' > /etc/ottr/seed-token-expires`,
		]);
		expect(dated.logs.join("\n")).toContain(`board seed token expires ${iso}`);
		expect(undated.seedWrites.at(-1)).toBe(
			"compose -f c.yml exec -T server sh -c printf %s 'none' > /etc/ottr/seed-token-expires",
		);
		expect(undated.logs.join("\n")).toContain("board seed token expires none");
		for (const f of [badDate, refused, thrown]) {
			expect(f.seedWrites.at(-1)).not.toContain("seed-token-expires");
			expect(f.logs.join("\n")).toContain(
				"board seed token expiry check failed",
			);
		}
		for (const f of [dated, undated, badDate, refused, thrown])
			expect(f.logs.join("\n")).not.toContain(token);
	}, 60_000);
});

describe("envFileValues", () => {
	const inDir = (files: Record<string, string>, run: (dir: string) => void) => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-env-"));
		for (const [name, text] of Object.entries(files))
			writeFileSync(join(dir, name), text);
		const prev = process.cwd();
		process.chdir(dir);
		try {
			run(dir);
		} finally {
			process.chdir(prev);
			rmSync(dir, { recursive: true, force: true });
		}
	};

	test("reads the script's keys from --env-file flags, later files win, .env is ignored", () => {
		inDir(
			{
				"a.env":
					"# comment\n\nALATE_IMAGE=a\nGH_TOKEN=t=1\nOTTR_PORT=8080\nBAD\n=none\n",
				"b.env": "ALATE_IMAGE=b\n",
				".env": "ALATE_DATA=/root\n",
			},
			(dir) =>
				expect(
					envFileValues([
						"--env-file",
						join(dir, "a.env"),
						`--env-file=${join(dir, "b.env")}`,
					]),
				).toEqual({ ALATE_IMAGE: "b", GH_TOKEN: "t=1" }),
		);
	});

	test("reads the root .env without --env-file", () => {
		inDir({ ".env": "ALATE_DATA=/root\n" }, () =>
			expect(envFileValues([])).toEqual({ ALATE_DATA: "/root" }),
		);
	});

	test("strips quotes and inline comments like compose", () => {
		inDir(
			{
				"s.env": [
					'ALATE_DATA="/home/u/agent data" # the checkout',
					"ALATE_DATA_REPO='o/r@main'",
					"ALATE_IMAGE=alate:1 # pinned",
					"GH_TOKEN=a#b",
				].join("\n"),
			},
			(dir) =>
				expect(envFileValues(["--env-file", join(dir, "s.env")])).toEqual({
					ALATE_DATA: "/home/u/agent data",
					ALATE_DATA_REPO: "o/r@main",
					ALATE_IMAGE: "alate:1",
					GH_TOKEN: "a#b",
				}),
		);
	});

	test("with --env-file, the values Bun loads from .env go, a shell value stays", () => {
		const script = join(import.meta.dir, "update-image.ts");
		inDir(
			{
				".env": "ALATE_IMAGE=root-image\nOTTR_PORT=9000\n",
				"probe.ts": `import { dropBunDotenv } from ${JSON.stringify(script)};\ndropBunDotenv(process.argv.slice(2));\nconsole.log(JSON.stringify({ i: process.env.ALATE_IMAGE ?? null, p: process.env.OTTR_PORT ?? null }));\n`,
			},
			(dir) => {
				const probe = (...args: string[]) => {
					const env: Record<string, string> = { OTTR_PORT: "1" };
					for (const k of ["PATH", "SYSTEMROOT"])
						if (process.env[k] !== undefined) env[k] = process.env[k];
					const r = Bun.spawnSync(
						[process.execPath, join(dir, "probe.ts"), ...args],
						{ cwd: dir, env, stdout: "pipe", stderr: "pipe" },
					);
					expect(r.stderr.toString()).toBe("");
					return JSON.parse(r.stdout.toString());
				};
				expect(probe("--env-file", "stack.env")).toEqual({ i: null, p: "1" });
				// Without --env-file compose reads .env itself, so Bun's copy may stay.
				expect(probe()).toEqual({ i: "root-image", p: "1" });
			},
		);
	});

	test("dropBunDotenv does nothing without --env-file", () => {
		const env = { ALATE_IMAGE: "x" };
		dropBunDotenv(["-f", "docker-compose.yml"], env);
		expect(env).toEqual({ ALATE_IMAGE: "x" });
	});

	test("dropBunDotenv keeps the OS variables a bare child gets (Windows USERPROFILE, PATH)", () => {
		// A Windows child holds the OS user variables even with an empty env, so the fix
		// asks a second child in tmpdir, which has them without .env. The mock fakes the
		// two children: cwd child with the .env key, tmpdir child without it.
		const real = Bun.spawnSync;
		try {
			Bun.spawnSync = ((_cmd: string[], opts?: { cwd?: string }) => ({
				exitCode: 0,
				stdout: Buffer.from(
					JSON.stringify(
						opts?.cwd === undefined
							? { PATH: "/win", USERPROFILE: "C:\\u", ALATE_IMAGE: "img" }
							: { PATH: "/win", USERPROFILE: "C:\\u" },
					),
				),
				stderr: Buffer.from(""),
			})) as typeof Bun.spawnSync;
			const env: Record<string, string> = {
				PATH: "/win",
				USERPROFILE: "C:\\u",
				ALATE_IMAGE: "img",
			};
			dropBunDotenv(["--env-file", "stack.env"], env);
			expect(env).toEqual({ PATH: "/win", USERPROFILE: "C:\\u" });
		} finally {
			Bun.spawnSync = real;
		}
	});
});

describe("helpers survivor kills", () => {
	/** The bun -e scripts a legacy run (probe, hold, count, free) runs in the server. */
	async function boardScripts(): Promise<string[]> {
		const { main } = checkout();
		const f = fakes({ newImage: true, turns: "1" });
		const scripts = new Set<string>();
		const docker: Deps["docker"] = (...a) => {
			if (a.at(-2) === "-e") scripts.add(a.at(-1)!);
			return f.deps.docker(...a);
		};
		expect(
			await updateImage(main, ["-f", "c.yml"], { ...f.deps, docker }),
		).toBe(0);
		return [...scripts];
	}

	/** Runs a board script with PORT on a local fake board: its exit code and stdout. */
	async function runOnBoard(
		script: string,
		board: (req: Request) => Response,
	): Promise<{ code: number; out: string }> {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: board });
		try {
			const p = Bun.spawn([process.execPath, "-e", script], {
				env: { ...process.env, PORT: String(server.port) },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, code] = await Promise.all([
				new Response(p.stdout).text(),
				p.exited,
			]);
			return { code, out: out.trim() };
		} finally {
			server.stop(true);
		}
	}

	test("the board scripts count running turns and end the hold from the board's own origin", async () => {
		const scripts = await boardScripts();
		expect(scripts).toHaveLength(4);
		const [, , count, free] = scripts as [string, string, string, string];
		const state = {
			tasks: ["running", "preparing", "done", "queued"].map((state) => ({
				state,
			})),
		};
		expect(
			await runOnBoard(count, (req) =>
				new URL(req.url).pathname === "/api/state"
					? Response.json(state)
					: new Response("", { status: 404 }),
			),
		).toEqual({ code: 0, out: "2" });
		const seen: string[] = [];
		const freed = await runOnBoard(free, (req) => {
			seen.push(
				`${req.method} ${new URL(req.url).pathname} ${req.headers.get("origin")}`,
			);
			return new Response("");
		});
		expect(freed).toEqual({ code: 0, out: "" });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/^DELETE \/api\/drain http:\/\/127\.0\.0\.1:\d+$/);
		// A board older than DELETE /api/drain refuses: the script fails closed with the status.
		expect(
			await runOnBoard(free, () => new Response("", { status: 404 })),
		).toEqual({ code: 1, out: "HTTP 404" });
	}, 60_000);

	test("envFileValues trims keys, values and indented comments, and reads only named files", () => {
		const dir = mkdtempSync(join(root, "env-"));
		writeFileSync(join(dir, "a.env"), "  # ALATE_IMAGE=x\nALATE_DATA = v \n");
		writeFileSync(join(dir, "x.env"), "ALATE_DATA_REPO=read\n");
		const prev = process.cwd();
		process.chdir(dir);
		try {
			expect(
				envFileValues([
					"--env-file",
					"a.env",
					"--env-file",
					"gone.env",
					"--env_file=x.env",
				]),
			).toEqual({ ALATE_DATA: "v" });
		} finally {
			process.chdir(prev);
		}
	});

	test("an indented count after a compose warning still reads as the count", async () => {
		const { main } = checkout();
		const f = fakes({ turns: "WARN[0000] a warning\n 0\n" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("a manifest descriptor without a digest compares the image ids", async () => {
		const { main } = checkout();
		const f = fakes({ manifest: { runs: "", built: "sha256:m" } });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE,
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("a server ps -q that fails reads no manifest and compares the image ids", async () => {
		const { main } = checkout();
		const f = fakes({ manifest: { runs: "sha256:m", built: "sha256:m" } });
		const docker: Deps["docker"] = async (...a) =>
			a.join(" ") === SERVER
				? { code: 1, out: "no such service" }
				: f.deps.docker(...a);
		expect(
			await updateImage(main, ["-f", "c.yml"], { ...f.deps, docker }),
		).toBe(0);
		expect(f.calls).toEqual([
			BUILD,
			CFGJSON,
			PS,
			GET,
			...COMPARE.slice(2),
			COUNT,
			UP,
			PRUNE,
		]);
	}, 60_000);

	test("a failed image comparison logs docker's error text trimmed", async () => {
		const { main } = checkout();
		const f = fakes();
		const docker: Deps["docker"] = async (...a) =>
			a.join(" ") === COMPARE[2]
				? { code: 1, out: "\nno such service\n" }
				: f.deps.docker(...a);
		expect(
			await updateImage(main, ["-f", "c.yml"], { ...f.deps, docker }),
		).toBe(1);
		expect(f.logs).toContain(
			"stopped: the server's image cannot be compared with the build: no such service",
		);
	}, 60_000);
});

describe("deploy flow survivor kills", () => {
	/** Answers the docker calls that `pick` matches; the rest reach the fake. */
	const overriding = (
		f: FakeRun,
		pick: (line: string) => { code: number; out: string } | undefined,
	): FakeRun => {
		const inner = f.deps.docker;
		f.deps.docker = (...a) => {
			const r = pick(a.join(" "));
			return r ? Promise.resolve(r) : inner(...a);
		};
		return f;
	};
	const seedFakes = (o: Parameters<typeof fakes>[0] = {}) =>
		fakes({
			seedRecord: "0".repeat(40),
			alatePs: "alate123",
			alateInspect: "alate:current",
			...o,
		});
	const DATA_READ =
		"compose -f c.yml exec -T server sh -c cat /etc/ottr/seed-commit";
	/** Runs `body` with the shell's ALATE_IMAGE set to `value`, then restores it. */
	const withShellImage = async (
		value: string | undefined,
		body: () => Promise<void>,
	) => {
		const prev = process.env.ALATE_IMAGE;
		if (value === undefined) delete process.env.ALATE_IMAGE;
		else process.env.ALATE_IMAGE = value;
		try {
			await body();
		} finally {
			if (prev === undefined) delete process.env.ALATE_IMAGE;
			else process.env.ALATE_IMAGE = prev;
		}
	};
	const push = (ci: string, content: string, ...msg: string[]) => {
		writeFileSync(join(ci, "Dockerfile.worker"), content);
		must(ci, "commit", "-q", "-a", ...msg);
		must(ci, "push", "-q", "origin", "HEAD:main");
	};

	test("a hold logs the running turns once, and an accepted hold logs no refusal", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		const f = fakes({ newImage: true, turns: ["2", "1", "0"] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.filter((l) => l.includes("holds new turns"))).toEqual([
			"2 turns run: the board holds new turns, and the restart follows when they finish",
		]);
		expect(f.logs.join("\n")).not.toContain("cannot hold new turns");
	}, 60_000);

	test("a count whose exec fails stops, though its output ends in a number", async () => {
		const { main } = checkout();
		const f = overriding(fakes(), (line) =>
			line.startsWith("compose -f c.yml exec -T server bun -e") &&
			!line.includes("/api/drain")
				? { code: 137, out: "3\n" }
				: undefined,
		);
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).not.toContain(UP);
	}, 60_000);

	test("a count with text after the number stops and logs docker's trimmed output", async () => {
		const { main } = checkout();
		const f = fakes({ turns: "10a\n" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.logs).toContain(
			"stopped: the board's turns cannot be counted: 10a",
		);
		expect(f.calls).not.toContain(UP);
	}, 60_000);

	test("a count with text before the number stops", async () => {
		const { main } = checkout();
		const f = fakes({ turns: "a10" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).not.toContain(UP);
	}, 60_000);

	test("a main that cannot fast-forward stops before the build and says so", async () => {
		const { main, ci } = checkout();
		bump(ci, "1.1.0");
		// A held index lock: the checkout is clean and behind, but the merge cannot run.
		writeFileSync(join(main, ".git", "index.lock"), "");
		const f = fakes();
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).toEqual([]);
		expect(f.logs).toContain(
			"stopped: main does not fast-forward to origin/main",
		);
	}, 60_000);

	test("the success line takes the OMP_VERSION pin at a line start, not one in a comment", async () => {
		const { main, ci } = checkout();
		push(
			ci,
			"FROM x\n# was ARG OMP_VERSION=0.9.0\nARG OMP_VERSION=1.2.0\n",
			"-m",
			"pin",
		);
		const f = fakes();
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.at(-1)).toEndWith("with omp 1.2.0");
	}, 60_000);

	test("a Dockerfile without an OMP_VERSION pin deploys with omp unknown", async () => {
		const { main, ci } = checkout();
		push(ci, "FROM x\n", "-m", "unpin");
		const f = fakes();
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.logs.at(-1)).toEndWith("with omp unknown");
	}, 60_000);

	test("the hold sends commit subjects without their leading spaces", async () => {
		const { main, ci } = checkout();
		push(ci, dockerfile("1.1.0"), "--cleanup=verbatim", "-m", "  padded");
		const f = fakes({ newImage: true, turns: ["1", "0"] });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(drainBody(f)).toEqual({ commits: ["padded"] });
	}, 60_000);

	test("a failed build logs the last 10 lines of docker's trimmed output", async () => {
		const { main } = checkout();
		const lines = Array.from({ length: 12 }, (_, i) => `step ${i + 1}`);
		const f = overriding(fakes(), (line) =>
			line === BUILD ? { code: 1, out: `\n${lines.join("\n")}\n` } : undefined,
		);
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.logs).toEqual([
			lines.slice(-10).join("\n"),
			"stopped: the image does not build; the stack keeps the old one",
		]);
	}, 60_000);

	test("a failed ps logs docker's trimmed error", async () => {
		const { main } = checkout();
		const f = overriding(fakes(), (line) =>
			line === PS ? { code: 1, out: "daemon down\n" } : undefined,
		);
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.logs).toContain("stopped: docker compose ps failed: daemon down");
	}, 60_000);

	test("a CRLF ps listing still counts the server as running", async () => {
		const { main } = checkout();
		const f = fakes({ running: "worker\r\nserver\r", turns: "2" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toContain(COUNT);
		expect(f.calls).not.toContain(UP);
	}, 60_000);

	test("a failed up --wait logs docker's trimmed error", async () => {
		const { main } = checkout();
		const f = fakes({ up: 1, upOut: "dependency failed to start\n" });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.logs).toContain(
			"stopped: docker compose up --wait failed: dependency failed to start",
		);
	}, 60_000);

	test("a board that is down seeds without reading the record", async () => {
		const { main } = checkout();
		const data = checkout();
		const head = must(data.main, "rev-parse", "HEAD");
		const f = seedFakes({ running: "", seedRecord: head });
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		expect(f.calls).not.toContain(DATA_READ);
		expect(f.seedRuns).toHaveLength(1);
		expect(f.logs).toContain(
			`board agent layer seeded at ${head.slice(0, 12)}`,
		);
	}, 60_000);

	test("a record read that fails seeds again, whatever the exec printed", async () => {
		const { main } = checkout();
		const data = checkout();
		const head = must(data.main, "rev-parse", "HEAD");
		const f = overriding(seedFakes(), (line) =>
			line === DATA_READ ? { code: 1, out: head } : undefined,
		);
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		expect(f.seedRuns).toHaveLength(1);
	}, 60_000);

	test("a current agent layer logs the short commit", async () => {
		const { main } = checkout();
		const data = checkout();
		const head = must(data.main, "rev-parse", "HEAD");
		const f = fakes({ seedRecord: head });
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(0);
		expect(f.logs).toContain(
			`board agent layer current at ${head.slice(0, 12)}`,
		);
	}, 60_000);

	test("an ALATE_IMAGE the caller passes is never copied into the process env", async () => {
		const { main } = checkout();
		const data = checkout();
		await withShellImage(undefined, async () => {
			const f = seedFakes();
			expect(
				await updateImage(main, ["-f", "c.yml"], f.deps, {
					ALATE_DATA: data.main,
					ALATE_IMAGE: "alate:env",
				}),
			).toBe(0);
			expect(f.seedImages).toEqual([undefined]);
			expect(process.env.ALATE_IMAGE).toBeUndefined();
		});
	}, 60_000);

	test("a discovered image reaches the seed, and the shell's own ALATE_IMAGE comes back after", async () => {
		const { main } = checkout();
		const data = checkout();
		await withShellImage("alate:shell", async () => {
			const f = seedFakes();
			expect(
				await updateImage(main, ["-f", "c.yml"], f.deps, {
					ALATE_DATA: data.main,
				}),
			).toBe(0);
			expect(f.seedImages).toEqual(["alate:current"]);
			expect(process.env.ALATE_IMAGE).toBe("alate:shell");
		});
	}, 60_000);

	test("a failed seed run logs the last 3 lines of docker's trimmed output", async () => {
		const { main } = checkout();
		const data = checkout();
		const f = overriding(seedFakes(), (line) =>
			line.includes("board-seed")
				? { code: 1, out: "l1\nl2\nl3\nl4\n" }
				: undefined,
		);
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(1);
		expect(f.logs).toContain("board seed failed: l2\nl3\nl4");
	}, 60_000);

	test("a failed restart after a seed stops with docker's trimmed error and records nothing", async () => {
		const { main } = checkout();
		const data = checkout();
		const f = overriding(seedFakes(), (line) =>
			line === "compose -f c.yml restart server"
				? { code: 1, out: "restart boom\n" }
				: undefined,
		);
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(1);
		expect(f.logs).toContain(
			"stopped: docker compose restart server failed: restart boom",
		);
		expect(f.seedWrites).toEqual([]);
		expect(f.calls).not.toContain(PRUNE);
	}, 60_000);

	test("a seed record that cannot be written exits 1 after the deploy completes", async () => {
		const { main } = checkout();
		const data = checkout();
		const f = overriding(seedFakes(), (line) =>
			line.includes("printf %s")
				? { code: 1, out: "read-only file system\n" }
				: undefined,
		);
		expect(
			await updateImage(main, ["-f", "c.yml"], f.deps, {
				ALATE_DATA: data.main,
			}),
		).toBe(1);
		expect(f.logs).toContain(
			"board seed failed: the seed commit cannot be recorded; the next run seeds again",
		);
		expect(f.logs.at(-1)).toStartWith("the stack runs main at");
	}, 60_000);
});

describe("sidecar and seed survivor kills", () => {
	type Out = { code: number; out: string };
	/** f's fake docker, with `pick` answering a call first when it returns a result. */
	const over = (f: FakeRun, pick: (line: string) => Out | undefined): Deps => ({
		...f.deps,
		docker: async (...a) => pick(a.join(" ")) ?? f.deps.docker(...a),
	});
	/** Runs `run` with `fake` answering a git call first when it returns a result; real git
	 *  answers the rest. Returns the args of every git call. */
	async function withGit(
		fake: (
			args: string[],
			cwd: string,
		) => Promise<worktree.GitResult> | undefined,
		run: () => Promise<void>,
	): Promise<string[][]> {
		const seen: string[][] = [];
		mock.module("../src/worktree.ts", () => ({
			...realWorktree,
			git: (args: string[], cwd: string, timeoutMs?: number) => {
				seen.push(args);
				return fake(args, cwd) ?? realGit(args, cwd, timeoutMs);
			},
		}));
		try {
			await run();
		} finally {
			mock.module("../src/worktree.ts", () => ({ ...realWorktree }));
		}
		return seen;
	}
	const NO_SIDECAR = [BUILD, CFGJSON, PS, GET, ...COMPARE, COUNT, UP, PRUNE];
	const WITH_SIDECAR = [
		BUILD,
		CFGJSON,
		SIDE_BUILD,
		...SIDE_COMPARE,
		PS,
		GET,
		...COMPARE,
		COUNT,
		UP,
		PRUNE,
	];
	const services = (s: Record<string, unknown>) =>
		JSON.stringify({ services: s });

	test("compose warnings ahead of the config JSON still find the sidecar", async () => {
		const { main } = checkout();
		const side = checkout();
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		const json = services({ sidecar: { build: { context: side.main } } });
		const deps = over(f, (l) =>
			l === CFGJSON
				? {
						code: 0,
						out: `WARN the attribute \`version\` is obsolete\n${json}`,
					}
				: undefined,
		);
		expect(await updateImage(main, ["-f", "c.yml"], deps)).toBe(0);
		expect(f.calls).toEqual(WITH_SIDECAR.filter((c) => c !== CFGJSON));
		expect(f.logs.join("\n")).not.toContain("stays as it is");
	}, 60_000);

	test("a failed or JSON-less compose config logs docker's text and deploys no sidecar", async () => {
		const { main } = checkout();
		const side = checkout();
		for (const [cfg, line] of [
			[
				{
					code: 1,
					out: `services.sidecar Additional property {bad} is not allowed\n`,
				},
				"compose config failed: services.sidecar Additional property {bad} is not allowed",
			],
			// Valid JSON on a failed exit is still a failure.
			[
				{
					code: 1,
					out: services({ sidecar: { build: { context: side.main } } }),
				},
				"compose config failed: ",
			],
			[
				{ code: 0, out: "no configuration file provided: not found\n" },
				"compose config failed: no configuration file provided: not found",
			],
		] as const) {
			const f = fakes({ turns: "0" });
			const deps = over(f, (l) => (l === CFGJSON ? cfg : undefined));
			expect(await updateImage(main, ["-f", "c.yml"], deps)).toBe(0);
			expect(f.calls).toEqual(NO_SIDECAR.filter((c) => c !== CFGJSON));
			expect(f.logs.some((l) => l.startsWith(line))).toBe(true);
			expect(f.logs.join("\n")).not.toContain("not JSON");
			expect(f.logs.join("\n")).not.toContain("skipping");
		}
	}, 60_000);

	test("a compose config without a services map deploys no sidecar and says so", async () => {
		const { main } = checkout();
		for (const out of ["{not json\n", "{}\n", '{"services": 5}\n']) {
			const f = fakes({ turns: "0" });
			const deps = over(f, (l) =>
				l === CFGJSON ? { code: 0, out } : undefined,
			);
			expect(await updateImage(main, ["-f", "c.yml"], deps)).toBe(0);
			expect(f.calls).toEqual(NO_SIDECAR.filter((c) => c !== CFGJSON));
			expect(f.logs).toContain(
				"compose config is not JSON: deploying no foreign checkouts",
			);
			expect(f.logs.join("\n")).not.toContain("skipping");
		}
	}, 60_000);

	test("services without a build context, or with a plain directory, are no sidecar", async () => {
		const { main } = checkout();
		const side = checkout();
		const plain = mkdtempSync(join(root, "plain-")); // exists, but no .git
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		const json = services({
			server: { build: { context: "." } },
			redis: { image: "redis:7" },
			cache: { build: {} },
			plain: { build: { context: plain } },
			sidecar: { build: { context: side.main } },
		});
		const deps = over(f, (l) =>
			l === CFGJSON ? { code: 0, out: json } : undefined,
		);
		expect(await updateImage(main, ["-f", "c.yml"], deps)).toBe(0);
		expect(f.calls).toEqual(WITH_SIDECAR.filter((c) => c !== CFGJSON));
		const log = f.logs.join("\n");
		expect(log).not.toContain("skipping");
		// A clean checkout on main fast-forwards: nothing to report about it.
		expect(log).not.toContain("stays as it is");
	}, 60_000);

	test("a sidecar build that fails logs the last 10 lines of docker's output", async () => {
		const { main } = checkout();
		const side = checkout();
		const lines = Array.from({ length: 12 }, (_, i) => `#${i} step ${i}`);
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		const deps = over(f, (l) =>
			l.endsWith(" build sidecar")
				? { code: 1, out: `\n${lines.join("\n")}\n` }
				: undefined,
		);
		expect(await updateImage(main, ["-f", "c.yml"], deps)).toBe(0);
		expect(f.logs).toContain(lines.slice(-10).join("\n"));
	}, 60_000);

	test("a failed restart of the sidecar logs docker's text without its padding", async () => {
		const { main } = checkout();
		const side = checkout();
		bump(side.ci, "2.0.0");
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
			sidecarNewImage: true,
		});
		const deps = over(f, (l) =>
			l === SIDE_UP
				? { code: 1, out: "\ncontainer sidecar is unhealthy\n" }
				: undefined,
		);
		expect(await updateImage(main, ["-f", "c.yml"], deps)).toBe(0);
		expect(f.logs).toContain(
			"sidecar: docker compose up --wait failed: container sidecar is unhealthy",
		);
	}, 60_000);

	test("a sidecar worktree that cannot be made skips the service and leaves no temp files", async () => {
		const { main } = checkout();
		const side = checkout();
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		const trees: string[] = [];
		await withGit(
			(args, cwd) => {
				if (args[0] !== "worktree" || args[1] !== "add") return undefined;
				trees.push(args[4]!);
				return realGit([...args.slice(0, -1), "refs/heads/no-such"], cwd);
			},
			async () => {
				expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
			},
		);
		expect(f.logs).toContain(
			`skipping sidecar: no worktree of origin/main from ${side.main}`,
		);
		expect(f.calls).toEqual(NO_SIDECAR);
		expect(trees).toHaveLength(1);
		expect(existsSync(trees[0]!)).toBe(false);
		expect(existsSync(`${trees[0]}.yml`)).toBe(false);
	}, 60_000);

	test("an origin/main that cannot be read there makes no worktree", async () => {
		const { main } = checkout();
		const side = checkout();
		const f = fakes({
			turns: "0",
			sidecar: { name: "sidecar", dir: side.main },
		});
		const seen = await withGit(
			(args) =>
				args[0] === "rev-parse" && args.includes("origin/main")
					? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: bad rev" })
					: undefined,
			async () => {
				expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
			},
		);
		expect(f.logs).toContain(
			`skipping sidecar: no worktree of origin/main from ${side.main}`,
		);
		expect(seen.filter((a) => a[0] === "worktree")).toEqual([]);
		expect(f.calls).toEqual(NO_SIDECAR);
	}, 60_000);

	test("an origin that cannot be fetched stops the run before any build", async () => {
		const { origin, main } = checkout();
		rmSync(origin, { recursive: true, force: true });
		const f = fakes();
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.logs).toEqual(["stopped: git fetch origin main failed"]);
		expect(f.calls).toEqual([]);
	}, 60_000);

	describe("seed source and alate image", () => {
		const DATA_READ =
			"compose -f c.yml exec -T server sh -c cat /etc/ottr/seed-commit";
		const ALATE_PS = "compose -f c.yml ps -q alate";
		const ALATE_INSPECT = "inspect -f {{.Config.Image}} alate123";
		const DOCKER_PS = "ps --filter name=^/?alate$ --format {{.Image}}";
		const RESTART = "compose -f c.yml restart server";
		const unrecorded = "0".repeat(40);

		test("ALATE_DATA alone logs no precedence over ALATE_DATA_REPO", async () => {
			const { main } = checkout();
			const data = checkout();
			const f = fakes({ seedRecord: must(data.main, "rev-parse", "HEAD") });
			expect(
				await updateImage(main, ["-f", "c.yml"], f.deps, {
					ALATE_DATA: data.main,
				}),
			).toBe(0);
			expect(f.logs.join("\n")).not.toContain("wins over");
		}, 60_000);

		test("an ALATE_DATA without a commit fails the seed, but the deploy completes", async () => {
			const { main } = checkout();
			const empty = join(root, String(fixtures++));
			must(root, "init", "-q", empty); // rev-parse HEAD prints "HEAD" and exits 128
			const f = fakes({ seedRecord: unrecorded, alatePs: "alate123" });
			expect(
				await updateImage(main, ["-f", "c.yml"], f.deps, { ALATE_DATA: empty }),
			).toBe(1);
			expect(f.seedRuns).toEqual([]);
			expect(f.calls).toEqual(NO_SIDECAR);
			expect(f.logs).toContain(
				`board seed failed: git rev-parse HEAD failed in ${empty}`,
			);
		}, 60_000);

		test("an ls-remote that fails after it printed a head fails the seed", async () => {
			const { main } = checkout();
			const f = fakes({ seedRecord: unrecorded, alatePs: "alate123" });
			await withGit(
				(args) =>
					args.includes("ls-remote")
						? Promise.resolve({
								code: 128,
								stdout: `${"a".repeat(40)}\trefs/heads/main\n`,
								stderr: "fatal: the remote end hung up unexpectedly",
							})
						: undefined,
				async () => {
					expect(
						await updateImage(main, ["-f", "c.yml"], f.deps, {
							ALATE_DATA_REPO: "example/data",
						}),
					).toBe(1);
				},
			);
			expect(f.seedRuns).toEqual([]);
			expect(f.calls).toEqual(NO_SIDECAR);
			expect(f.logs).toContain(
				"board seed failed: git ls-remote example/data failed",
			);
		}, 60_000);

		test("an ALATE_IMAGE in the environment seeds without discovery or an env change", async () => {
			const { main } = checkout();
			const data = checkout();
			const f = fakes({ seedRecord: unrecorded });
			expect(
				await updateImage(main, ["-f", "c.yml"], f.deps, {
					ALATE_DATA: data.main,
					ALATE_IMAGE: "alate:pinned",
				}),
			).toBe(0);
			expect(f.calls).not.toContain(ALATE_PS);
			expect(f.calls).not.toContain(DOCKER_PS);
			expect(f.seedRuns).toHaveLength(1);
			// The env file already gives the compose child ALATE_IMAGE: the run sets nothing.
			expect(f.seedImages).toEqual([process.env.ALATE_IMAGE]);
		}, 60_000);

		test("the seed runs in the image its discovery reads", async () => {
			const { main } = checkout();
			const data = checkout();
			const seedRun = `compose -f c.yml run --rm --no-deps -v ${data.main}:/data:ro board-seed --data /data`;
			const write = `compose -f c.yml exec -T server sh -c printf %s '${must(data.main, "rev-parse", "HEAD")}' > /etc/ottr/seed-commit`;
			const alate = [{ name: "alate", image: "alate:ps" }];
			const cases: {
				o: Parameters<typeof fakes>[0];
				pick?: (l: string) => Out | undefined;
				image: string;
				calls?: string[];
			}[] = [
				// The project's alate runs: its image.
				{
					o: { alatePs: "alate123", alateInspect: "alate:current" },
					image: "alate:current",
				},
				// No project alate: no inspect, the docker ps fallback.
				{
					o: { containers: alate },
					image: "alate:ps",
					calls: [
						BUILD,
						CFGJSON,
						PS,
						DATA_READ,
						ALATE_PS,
						DOCKER_PS,
						seedRun,
						GET,
						...COMPARE,
						HOLD,
						COUNT,
						UP,
						RESTART,
						write,
						PRUNE,
					],
				},
				// An inspect with no image, or one that fails: the fallback.
				{ o: { alatePs: "alate123", containers: alate }, image: "alate:ps" },
				{
					o: { alatePs: "alate123", containers: alate },
					pick: (l) =>
						l === ALATE_INSPECT
							? { code: 1, out: "Error: No such object: alate123\n" }
							: undefined,
					image: "alate:ps",
				},
				// docker on Windows ends its lines with CRLF.
				{
					o: {},
					pick: (l) =>
						l === DOCKER_PS ? { code: 0, out: "alate:win\r\n" } : undefined,
					image: "alate:win",
				},
			];
			for (const c of cases) {
				const f = fakes({ seedRecord: unrecorded, ...c.o });
				const deps = c.pick ? over(f, c.pick) : f.deps;
				expect(
					await updateImage(main, ["-f", "c.yml"], deps, {
						ALATE_DATA: data.main,
					}),
				).toBe(0);
				expect(f.seedImages).toEqual([c.image]);
				if (c.calls) expect(f.calls).toEqual(c.calls);
			}
		}, 60_000);
	});
});

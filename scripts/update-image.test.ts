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

import { type Deps, envFileValues, updateImage } from "./update-image.ts";

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
		free?: number;
		up?: number;
		/** Output of a failing `up` (its error text). */
		upOut?: string;
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
	let counted = 0;
	let holdCalls = 0;
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
			if (line.includes("seed-commit")) {
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
					free ? " -e <free>" : drain ? " -e <hold>" : " -e <count>",
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
			if (free)
				return o.free
					? { code: o.free, out: "HTTP 404\n" }
					: { code: 0, out: "" };
			if (drain) {
				const code = holds[Math.min(holdCalls++, holds.length - 1)] ?? 0;
				return code ? { code, out: "HTTP 404\n" } : { code: 0, out: "" };
			}
			if (args.includes("exec"))
				return {
					code: 0,
					out: turns[Math.min(counted++, turns.length - 1)] ?? "0",
				};
			if (args.includes("up"))
				return args.at(-1) === o.sidecar?.name
					? {
							code: o.sidecarUp ?? 0,
							out: o.sidecarUp ? "container sidecar exited (1)" : "",
						}
					: { code: o.up ?? 0, out: o.upOut ?? "" };
			return { code: 0, out: "" };
		},
		log: (line) => logs.push(line),
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
	const first = f.drains[0] ?? "";
	const m = first.match(/body: (".*?") \}\);/s);
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
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, ...COMPARE, COUNT]);
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
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, ...COMPARE, HOLD, COUNT]);
		const log = f.logs.join("\n");
		expect(log).toContain("the board cannot hold new turns: HTTP 404");
		expect(log).toContain("2 turns run: the restart waits for a later run");
	}, 60_000);

	test("an image comparison that fails stops before any hold or restart", async () => {
		const { main } = checkout();
		const f = fakes({ imagesCode: 1 });
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(1);
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, ...COMPARE]);
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
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, ...COMPARE, COUNT]);
	}, 60_000);

	test("a compose warning ahead of a two-digit count still holds the restart", async () => {
		const { main } = checkout();
		// The real docker dep puts stderr first: compose warnings, then the count and its newline.
		const f = fakes({
			turns:
				"WARN[0000] Found orphan containers ([ottr-old-1]) for this project.\n10\n",
		});
		expect(await updateImage(main, ["-f", "c.yml"], f.deps)).toBe(0);
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, ...COMPARE, COUNT]);
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
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, ...COMPARE, COUNT, UP]);
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
		expect(f.drains[1]).toBe(f.drains[0]);
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
		const hold = f.drains[0] ?? "";
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
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, ...COMPARE, COUNT, UP, PRUNE]);
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
		expect(f.calls).toEqual([BUILD, CFGJSON, PS, ...COMPARE, COUNT, UP, PRUNE]);
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
});

describe("envFileValues", () => {
	test("reads --env-file flags and the root .env, later files win", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-env-"));
		writeFileSync(
			join(dir, "a.env"),
			"# comment\n\nKEY=a\nURL=http://x/?y=1\nBAD\n=none\n",
		);
		writeFileSync(join(dir, "b.env"), "KEY=b\n");
		writeFileSync(join(dir, ".env"), "ROOT=yes\n");
		const prev = process.cwd();
		process.chdir(dir);
		try {
			expect(
				envFileValues([
					"--env-file",
					join(dir, "a.env"),
					`--env-file=${join(dir, "b.env")}`,
				]),
			).toEqual({ KEY: "b", URL: "http://x/?y=1", ROOT: "yes" });
		} finally {
			process.chdir(prev);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

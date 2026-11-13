// Gate check: boot the real server from the file set the deployed image ships (the
// Dockerfile.worker COPY list, node_modules linked) on a scratch port and prove the
// home page bundles. Catches what tsc/biome/bun test cannot: an import of a file the
// image does not ship (boot crash), and a broken index.html asset graph
// (500 "Build Failed").
import { Database } from "bun:sqlite";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";

import { smokeEnv } from "./boot-smoke-env.ts";

// ponytail: bind-0-then-close leaves a race window; fine for a dev gate, parse the
// server's "Ottr on http://127.0.0.1:<port>" log line if a collision ever bites.
const port = await new Promise<number>((resolvePort, reject) => {
	const probe = net.createServer();
	probe.listen(0, "127.0.0.1", () => {
		const addr = probe.address();
		if (addr === null || typeof addr === "string")
			return reject(new Error("no port"));
		probe.close(() => resolvePort(addr.port));
	});
});

/** One Dockerfile.worker COPY line's context sources and their WORKDIR-relative
 * destination, or null when the destination sits outside the app WORKDIR (the entry
 * script: not a module path for src/server.ts). Throws on an unparsable line — the
 * image build would fail too. `--from=` copies move files between build stages and
 * contribute no context file, so they return null. */
function parseCopy(
	tokens: string[],
	workdir: string,
): { srcs: string[]; dest: string } | null {
	if (tokens.some((t) => t.startsWith("--from="))) return null;
	const args = tokens.slice(1).filter((t) => !t.startsWith("--"));
	const dest = args.at(-1);
	if (dest === undefined || args.length < 2)
		throw new Error(
			`boot-smoke: unparsable COPY in Dockerfile.worker: ${tokens.join(" ")}`,
		);
	const outside =
		dest.startsWith("/") && dest !== workdir && !dest.startsWith(`${workdir}/`);
	if (outside) return null;
	const rel =
		dest === workdir
			? ""
			: dest.startsWith("/")
				? dest.slice(workdir.length + 1)
				: dest;
	return { srcs: args.slice(0, -1), dest: posix.normalize(rel) };
}

/** The build-context files Dockerfile.worker COPYs under the app WORKDIR — its COPY
 * list, so a new COPY line ships in this smoke with no edit here. */
function imageShippedFiles(
	dockerfile: string,
): { src: string; dest: string }[] {
	const text = dockerfile.replace(/\\\r?\n/g, " "); // join line continuations
	let workdir = "/";
	const shipped: { src: string; dest: string }[] = [];
	for (const line of text.split("\n")) {
		const tokens = line.trim().split(/\s+/);
		const instr = tokens[0]?.toUpperCase() ?? "";
		if (instr === "WORKDIR" && tokens[1] !== undefined) {
			workdir = tokens[1];
			continue;
		}
		if (instr !== "COPY") continue;
		const parsed = parseCopy(tokens, workdir);
		if (parsed === null) continue;
		for (const src of parsed.srcs) shipped.push({ src, dest: parsed.dest });
	}
	return shipped;
}

const roots = mkdtempSync(join(tmpdir(), "ottr-boot-"));
const repoRoot = resolve(import.meta.dir, "..");

// Boot from a copy holding only what the image ships, not the checkout: fd1c133's
// static scripts/demo-data.ts import booted fine here (scripts/ exists in the
// checkout) and crashed every deployed image at boot, because Dockerfile.worker
// copies only src/, extension/ and the package files.
const imageDir = mkdtempSync(join(tmpdir(), "ottr-boot-image-"));
for (const { src, dest } of imageShippedFiles(
	readFileSync(join(repoRoot, "Dockerfile.worker"), "utf8"),
)) {
	const from = join(repoRoot, src);
	if (!existsSync(from))
		throw new Error(
			`boot-smoke: Dockerfile.worker COPY source missing in the checkout: ${src}`,
		);
	// Docker COPY: a directory source's contents land in dest; a file lands as dest
	// itself, or dest/basename(src) when dest is a directory ("." or trailing "/").
	const isDir = statSync(from).isDirectory();
	const target =
		isDir || dest === "." || dest.endsWith("/")
			? isDir
				? join(imageDir, dest)
				: join(imageDir, dest, basename(src))
			: join(imageDir, dest);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(from, target, { recursive: true });
}
// The image installs production deps after the COPYs (bun install
// --frozen-lockfile --production); the linked checkout node_modules stands in for it,
// so the smoke runs no install and stays fast.
symlinkSync(
	join(repoRoot, "node_modules"),
	join(imageDir, "node_modules"),
	"junction",
);

const spawnServer = () =>
	Bun.spawn(["bun", "src/server.ts"], {
		cwd: imageDir,
		env: smokeEnv({
			PORT: String(port),
			OMP_TRACKER_ROOTS: roots,
			// Scratch state: the smoke server must never lock the checkout's live tracker.db.
			OTTR_STATE_DIR: join(roots, "state"),
		}),
		stdout: "ignore",
		stderr: "pipe",
	});

async function settle(
	path: string,
	headers?: HeadersInit,
): Promise<Response | null> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
			if (res.status !== 502 && res.status !== 503) return res;
		} catch {
			// not listening yet
		}
		await Bun.sleep(250);
	}
	return null;
}

let failed = false;

// Early-signal scenario: SIGTERM while the server is still booting — signal
// handlers registered, turn loop not yet built — must exit 143 promptly and
// release every lock it opened (ott TDZ regression: the pre-loop handler threw,
// trapCrashes kept the process up, the tracker lock stayed held). The
// window is deterministic via a PATH-shimmed git: the server's first boot await
// is a git spawn (headVersion), so the shim's signal file proves exactly
// "handlers up, loop not yet assigned". Runs before the main boot below: the
// two servers share the scratch state dir, so this child must be dead and
// unlocked before the next one opens it.
const realGit = Bun.which("git");
if (process.platform !== "win32" && realGit !== null) {
	const shimDir = join(roots, "git-shim");
	const signal = join(shimDir, "signal");
	const release = join(shimDir, "release");
	mkdirSync(shimDir, { recursive: true });
	// The first git call parks the boot inside its await until released (10 s
	// cap bounds a crashed harness); later git calls pass straight through.
	await Bun.write(
		join(shimDir, "git"),
		`#!/bin/sh
[ -f "${signal}" ] || {
	touch "${signal}"
	i=0
	while [ ! -f "${release}" ] && [ "$i" -lt 100 ]; do
		sleep 0.1
		i=$((i + 1))
	done
}
exec "${realGit}" "$@"
`,
	);
	chmodSync(join(shimDir, "git"), 0o755);
	const early = Bun.spawn(["bun", "src/server.ts"], {
		cwd: imageDir,
		env: smokeEnv({
			PORT: String(port),
			OMP_TRACKER_ROOTS: roots,
			OTTR_STATE_DIR: join(roots, "state"),
			// Shim dir first: gitExe() resolves git through PATH on every spawn.
			PATH: `${shimDir}:${process.env.PATH ?? ""}`,
		}),
		stdout: "ignore",
		stderr: "pipe",
	});
	try {
		let parked = false;
		const deadline = Date.now() + 20_000;
		while (!parked && Date.now() < deadline) {
			parked = existsSync(signal);
			if (parked) break;
			// A child that exits before the first git spawn died at module load (e.g.
			// an import of a file the image does not ship): fail fast, the stderr
			// below names it.
			if (
				await Promise.race([
					early.exited.then(() => true),
					Bun.sleep(25).then(() => false),
				])
			)
				throw new Error(
					"early-signal: server exited before its first boot await",
				);
		}
		if (!parked)
			throw new Error(
				"early-signal: no git shim signal — server never reached its first boot await",
			);
		early.kill(); // SIGTERM, the same signal the post-boot stop below delivers
		const exited = await Promise.race([
			early.exited.then(() => true),
			Bun.sleep(10_000).then(() => false),
		]);
		if (!exited)
			throw new Error(
				"SIGTERM during boot: server still running after 10s (pre-loop handler crash keeps it alive via trapCrashes)",
			);
		const code = await early.exited;
		if (code !== 143)
			throw new Error(
				`SIGTERM during boot exited ${code ?? "?"}, expected 143`,
			);
		await Bun.write(release, ""); // free the parked shim; nothing outlives the smoke
		// Exclusive-lock probe: the tripwire write succeeds only if no live holder
		// still owns the tracker (the R8-1 leak detector, now mechanism-free).
		const probe = new Database(join(roots, "state", ".tasks", "tracker.db"));
		probe.exec("PRAGMA busy_timeout = 200");
		probe.exec("PRAGMA locking_mode = EXCLUSIVE");
		probe.exec("PRAGMA journal_mode = WAL");
		probe.close();
		console.log(
			"boot-smoke: SIGTERM during boot exited 143, tracker lock released",
		);
	} catch (err) {
		failed = true;
		console.error(
			`boot-smoke: FAIL — ${err instanceof Error ? err.message : err}`,
		);
		await Bun.write(release, ""); // free the parked shim, whoever still runs
		const gone = await Promise.race([
			early.exited.then(() => true),
			Bun.sleep(2_000).then(() => false),
		]);
		if (!gone) {
			// No kill, no main smoke against the still-locked state dir: leave the
			// process and its locks for operator cleanup and fail the gate now.
			console.error(
				"boot-smoke: early-signal server still running after SIGTERM — left untouched for operator cleanup",
			);
			process.exit(1);
		}
		const stderr = await new Response(early.stderr).text();
		if (stderr) console.error(stderr.slice(0, 2000));
	}
}

const child = spawnServer();
// One shared read of the child's stderr: a second Response over the stream throws
// "disturbed or locked". The pipe only EOFs once the child dies, so the success path
// never awaits it and leaves the (few) stderr lines unread — as before.
const stderrText = new Response(child.stderr).text();
try {
	// A module the image does not ship crashes the child before any port listens;
	// race the exit so the gate fails fast with the child's stderr instead of
	// riding settle's 20 s deadline.
	const settled = await Promise.race([
		settle("/api/boot").then((up) => ({ up })),
		child.exited.then(async (code) => ({
			exit: { code, stderr: await stderrText },
		})),
	]);
	if ("exit" in settled)
		throw new Error(
			`server exited ${settled.exit.code ?? "?"} before /api/boot answered`,
		);
	const boot = settled.up;
	if (boot?.status !== 200)
		throw new Error(`/api/boot -> ${boot?.status ?? "no answer"}`);
	const home = await settle("/");
	const html = home === null ? "" : await home.text();
	if (home?.status !== 200)
		throw new Error(`/ -> ${home?.status ?? "no answer"}`);
	if (html.includes("Build Failed"))
		throw new Error("/ served Bun's Build Failed page");
	if (!html.includes('id="root"')) throw new Error("/ served unexpected HTML");
	// Regression (ott/c2f38b12): Bun's HTML dev server answered 403 "Blocked: Host header
	// does not match the dev server" to every non-loopback Host, breaking the README's
	// tailscale serve + OMP_TRACKER_PUBLIC_HOSTS recipe. Guard: under NODE_ENV=development
	// that dev server legitimately blocks foreign hosts.
	if (process.env.NODE_ENV !== "development") {
		const remote = await settle("/", { host: "ottr.tail-net.ts.net" });
		if (remote?.status !== 200)
			throw new Error(
				`/ with a public Host header -> ${remote?.status ?? "no answer"}`,
			);
	}
	console.log(`boot-smoke: / and /api/boot ok on :${port}`);
	child.kill();
	await child.exited;
	// Regression (R8-1): SIGTERM (child.kill's default) must release the
	// tracker's exclusive lock, or the next boot refuses to start. The probe is
	// the same tripwire openLocked uses; the OS owns the release, so it holds on
	// every platform (Windows TerminateProcess included, where the old row
	// check was unreachable).
	const probe = new Database(join(roots, "state", ".tasks", "tracker.db"));
	probe.exec("PRAGMA busy_timeout = 200");
	probe.exec("PRAGMA locking_mode = EXCLUSIVE");
	probe.exec("PRAGMA journal_mode = WAL");
	probe.close();
	console.log("boot-smoke: tracker lock released on graceful stop");
} catch (err) {
	failed = true;
	console.error(
		`boot-smoke: FAIL — ${err instanceof Error ? err.message : err}`,
	);
	// Kill and reap before draining stderr: the pipe only EOFs once the child dies,
	// so reading first would block until the (still-running) server exits.
	child.kill();
	await child.exited;
	const stderr = await stderrText;
	if (stderr) console.error(stderr.slice(0, 2000));
} finally {
	child.kill();
	await child.exited;
	rmSync(roots, { recursive: true, force: true });
	rmSync(imageDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

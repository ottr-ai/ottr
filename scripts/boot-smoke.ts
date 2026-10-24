// Gate check: boot the real server on a scratch port and prove the home page bundles.
// Catches what tsc/biome/bun test cannot: a broken index.html asset graph (500 "Build Failed").
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const roots = mkdtempSync(join(tmpdir(), "ottr-boot-"));
const spawnServer = () =>
	Bun.spawn(["bun", "src/server.ts"], {
		env: {
			...process.env,
			PORT: String(port),
			OMP_TRACKER_ROOTS: roots,
			// Scratch state: the smoke server must never lock the checkout's live tracker.db.
			OTTR_STATE_DIR: join(roots, "state"),
		},
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
		env: {
			...process.env,
			PORT: String(port),
			OMP_TRACKER_ROOTS: roots,
			OTTR_STATE_DIR: join(roots, "state"),
			// Shim dir first: gitExe() resolves git through PATH on every spawn.
			PATH: `${shimDir}:${process.env.PATH ?? ""}`,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	try {
		let parked = false;
		const deadline = Date.now() + 20_000;
		while (!parked && Date.now() < deadline) {
			parked = existsSync(signal);
			if (!parked) await Bun.sleep(25);
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
try {
	const boot = await settle("/api/boot");
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
	const stderr = await new Response(child.stderr).text();
	if (stderr) console.error(stderr.slice(0, 2000));
} finally {
	child.kill();
	await child.exited;
	rmSync(roots, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

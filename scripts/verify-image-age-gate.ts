/**
 * Host-runnable acceptance for the worker image's global-install age gate
 * (OTTR-1013). The container has no docker engine, so the gates run the
 * `--grep` mode only; the full build runs on a host with docker.
 *
 * No argument: builds Dockerfile.worker with --progress=plain; the image's
 * RUN steps print omp/toon/tsc/pyright --version into the build log, so a
 * green build is the acceptance proof.
 *
 * --grep: repository-side gate only. Every `bun install -g` line in
 * Dockerfile.worker must carry --minimum-release-age 604800, matching
 * bunfig.toml's G21 setting that the .dockerignore allowlist keeps out of
 * the build context.
 */
const AGE_FLAG = "--minimum-release-age 604800";
const mode = process.argv[2];

if (mode === "--grep") {
	const file = await Bun.file("Dockerfile.worker").text();
	const lines = file.split("\n").filter((l) => l.includes("bun install -g"));
	const ungated = lines.filter((l) => !l.includes(AGE_FLAG));
	if (lines.length === 0 || ungated.length > 0) {
		console.error(
			`FAIL: ${ungated.length} of ${lines.length} 'bun install -g' lines lack ${AGE_FLAG}`,
		);
		for (const l of ungated) console.error(" ", l.trim());
		process.exit(1);
	}
	console.log(
		`age-gate: ok (${lines.length} 'bun install -g' lines all carry ${AGE_FLAG})`,
	);
	process.exit(0);
}

let engineUp = false;
try {
	engineUp =
		Bun.spawnSync({
			cmd: ["docker", "version", "--format", "{{.Server.Version}}"],
			stdout: "pipe",
			stderr: "pipe",
		}).exitCode === 0;
} catch {
	// spawnSync throws ENOENT when the docker CLI is not on PATH.
}
if (!engineUp) {
	console.error(
		"no docker engine here; run `bun run scripts/verify-image-age-gate.ts --grep` locally, or run the full build on a host with docker",
	);
	process.exit(2);
}
let build;
try {
	build = Bun.spawnSync({
		cmd: [
			"docker",
			"build",
			"--progress=plain",
			"-f",
			"Dockerfile.worker",
			"-t",
			"ottr-age-gate-check",
			".",
		],
		stdout: "inherit",
		stderr: "inherit",
	});
} catch (err) {
	console.error(`docker build failed to start: ${err}`);
	process.exit(2);
}
process.exit(build.exitCode ?? 1);

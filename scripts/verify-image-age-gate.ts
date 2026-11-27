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
 * the build context — except an install line covered by the live waiver
 * below.
 */
import { readFileSync } from "node:fs";

const AGE_FLAG = "--minimum-release-age 604800";

/**
 * Time-boxed operator waiver (OTTR-1286, 2026-11-27): omp 19.1.1 shipped
 * before the 7-day floor cleared, so the omp install line drops the flag.
 * The waiver covers exactly pin `pin` on the exact install line below — a
 * moved pin, an appended install target, or a changed line shape falls back
 * under the flag requirement. The waiver dies at `until`: the gate then
 * fails until the flag is restored, which is safe again once the pinned
 * version is at least 7 days old.
 */
export const WAIVER = {
	pin: "19.1.1",
	until: "2026-12-31",
};

const WAIVED_LINE =
	'RUN bun install -g --ignore-scripts "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" \\';

export function grepGate(
	file: string,
	now: Date = new Date(),
): { ok: boolean; output: string } {
	const lines = file.split("\n").filter((l) => l.includes("bun install -g"));
	const waiverLive = now.getTime() <= Date.parse(`${WAIVER.until}T23:59:59Z`);
	const pin = file.match(/^ARG OMP_VERSION=(\S+)$/m)?.[1] ?? null;
	const pinMatches = pin === WAIVER.pin;
	const waiverApplies = waiverLive && pinMatches;
	const ungated: string[] = [];
	let waived = 0;
	for (const line of lines) {
		if (line.includes(AGE_FLAG)) continue;
		if (waiverApplies && line === WAIVED_LINE) {
			waived += 1;
			continue;
		}
		ungated.push(line);
	}
	if (lines.length === 0 || ungated.length > 0) {
		let output = `FAIL: ${ungated.length} of ${lines.length} 'bun install -g' lines lack ${AGE_FLAG}`;
		if (!waiverLive && pinMatches && lines.some((l) => l === WAIVED_LINE))
			output += ` (the ${WAIVER.pin} waiver expired ${WAIVER.until}; restore ${AGE_FLAG})`;
		for (const l of ungated) output += `\n  ${l.trim()}`;
		return { ok: false, output };
	}
	const note =
		waived > 0
			? ` (${waived} line(s) under the omp ${WAIVER.pin} waiver expiring ${WAIVER.until})`
			: "";
	return {
		ok: true,
		output: `age-gate: ok (${lines.length} 'bun install -g' lines all carry ${AGE_FLAG})${note}`,
	};
}

function main(): number {
	const mode = process.argv[2];
	if (mode === "--grep") {
		const result = grepGate(readFileSync("Dockerfile.worker", "utf8"));
		if (result.ok) console.log(result.output);
		else console.error(result.output);
		return result.ok ? 0 : 1;
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
		return 2;
	}
	try {
		const run = Bun.spawnSync({
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
		return run.exitCode ?? 1;
	} catch (err) {
		console.error(`docker build failed to start: ${err}`);
		return 2;
	}
}

// Imported by tests for grepGate/WAIVER: side effects only when run directly.
if (import.meta.main) process.exit(main());

// Measures the memory-sized Stryker concurrency in a bounded container, as the OTTR-886
// acceptance asks: docker run -m 8g --memory-swap 8g (no swap), a bun ballast process that
// holds a 4 GiB buffer and touches every page, then the scoped base-config run (mutate
// src/app.ts:1800-2100, testFiles src/app.test.ts). Prints the run-start slot line, the
// verdict table, the cgroup peak, the oom_kill counter and the elapsed time.
//
// Run it on a docker host, in an ottr checkout with node_modules installed:
//
//   bun scripts/measure-stryker-concurrency.ts [<image-tag>]
//
// The image tag defaults to the worker image from docker-compose.yml (ottr-worker:local).
// The checkout mounts read-only at /workspace/ottr, so the run cannot dirty it; the
// measurement config and the incremental cache live in a temp dir inside the container.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The worker image default from docker-compose.yml, e.g. "ottr-worker:local". */
function workerImageFromCompose(): string {
	const compose = readFileSync("docker-compose.yml", "utf8");
	const image = /\$\{OTTR_IMAGE:-([^}]+)\}/.exec(compose)?.[1];
	if (!image) throw new Error("docker-compose.yml has no OTTR_IMAGE default");
	return image;
}

/** The scoped measurement config: the base config's sizing, the baseline's mutate range. */
function writeMeasureConfig(dir: string): void {
	writeFileSync(
		join(dir, "measure.config.mjs"),
		`// OTTR-886 acceptance measurement: the base config's memory-sized concurrency with the
// baseline's mutate range and test file. Lives outside the repo; the checkout mounts
// read-only, so the run must write nothing here (the cache below goes to /tmp).
import base from "/workspace/ottr/stryker.config.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
	...base,
	mutate: ["src/app.ts:1800-2100"],
	bun: { ...base.bun, testFiles: ["src/app.test.ts"] },
	incrementalFile: "/tmp/ott-measure-incremental.json",
	// Measurement run: a low score must not fail the process.
	thresholds: { ...base.thresholds, break: 0 },
};
`,
	);
}

/** The container-side script: 4 GiB ballast, then the scoped run, then the cgroup numbers. */
function writeInnerScript(dir: string): void {
	writeFileSync(
		join(dir, "inner.sh"),
		`# OTTR-886 acceptance measurement inside the bounded container.
set -eu
target=4294967296  # 4 GiB, the ballast buffer size
echo "ballast: holding a 4 GiB buffer and touching every page"
bun -e 'const b = Buffer.alloc(4 * 2 ** 30, 1); let s = 0; for (let i = 0; i < b.length; i += 4096) s += b[i]; console.log("ballast resident, checksum", s); setTimeout(() => {}, 7200000);' &
resident=0
for i in $(seq 1 120); do
	if [ "$(cat /sys/fs/cgroup/memory.current)" -ge "$target" ]; then
		resident=1
		break
	fi
	sleep 1
done
cur=$(cat /sys/fs/cgroup/memory.current)
if [ "$resident" -ne 1 ]; then
	echo "ERROR: the ballast did not reach 4 GiB in 120 s (memory.current=$cur); refusing to measure without it"
	exit 1
fi
echo "ballast-resident memory.current=$cur"
start=$(date +%s)
rc=0
./node_modules/.bin/stryker run /measure/measure.config.mjs || rc=$?
end=$(date +%s)
echo "STRYKER_RC=$rc"
echo "ELAPSED_SECONDS=$((end - start))"
echo "CGROUP_PEAK_BYTES=$(cat /sys/fs/cgroup/memory.peak)"
echo "CGROUP_MEMORY_EVENTS:"
cat /sys/fs/cgroup/memory.events
exit "$rc"
`,
	);
}

function main(): number {
	const repo = process.cwd();
	if (!existsSync(join(repo, "node_modules", ".bin", "stryker"))) {
		console.error(
			"node_modules/.bin/stryker is missing; run bun install --frozen-lockfile first",
		);
		return 1;
	}
	const image = process.argv[2] ?? workerImageFromCompose();
	const dir = mkdtempSync(join(tmpdir(), "ott-886-measure-"));
	writeMeasureConfig(dir);
	writeInnerScript(dir);
	const args = [
		"run",
		"--rm",
		"--memory",
		"8g",
		"--memory-swap",
		"8g",
		"--entrypoint",
		"sh",
		"-v",
		`${repo}:/workspace/ottr:ro`,
		"-v",
		`${dir}:/measure:ro`,
		"-w",
		"/workspace/ottr",
		image,
		"/measure/inner.sh",
	];
	console.log(`docker ${args.join(" ")}`);
	const result = spawnSync("docker", args, { stdio: "inherit" });
	if (result.error) {
		console.error(`docker failed to start: ${result.error.message}`);
		return 1;
	}
	return result.status ?? 1;
}

if (import.meta.main) process.exit(main());

// The license allowlist of this repo: `bun run check` fails on any other key. A change to it is a
// policy decision. `bun pm licenses` does not parse SPDX expressions, so each expression is one key.
const ALLOWED: Record<string, true> = {
	"0BSD": true,
	"Apache-2.0": true,
	"BlueOak-1.0.0": true,
	"BSD-3-Clause": true,
	"CC-BY-4.0": true,
	ISC: true,
	MIT: true,
	"MIT OR Apache-2.0": true,
	"MPL-2.0": true,
	"(MPL-2.0 OR Apache-2.0)": true,
	Unlicense: true,
};
// Packages whose package.json names no license, checked by hand. khroma (a mermaid dependency)
// ships an MIT license file. Any other "Unknown" package still fails.
const UNKNOWN_OK: Record<string, true> = { khroma: true };

const proc = Bun.spawnSync([process.execPath, "pm", "licenses", "--json"]);
if (proc.exitCode !== 0) {
	console.error(
		`bun pm licenses failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`,
	);
	process.exit(1);
}
// License key -> packages. Another shape throws here or lands outside the allowlist: both fail.
const licenses: Record<string, { name: string }[]> = JSON.parse(
	proc.stdout.toString(),
);
// `=== true`, not `in`: a key such as "constructor" must not match the object prototype.
const bad = Object.entries(licenses)
	.map(([key, packages]): [string, { name: string }[]] => [
		key,
		key === "Unknown"
			? packages.filter((p) => UNKNOWN_OK[p.name] !== true)
			: packages,
	])
	.filter(([key, packages]) => packages.length > 0 && ALLOWED[key] !== true);
for (const [key, packages] of bad)
	console.error(
		`license outside the allowlist: ${key}: ${packages.map((p) => p.name).join(", ")}`,
	);
if (bad.length > 0) process.exit(1);

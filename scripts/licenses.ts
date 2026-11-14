// The license allowlist of this repo: `bun run check` fails on any other key.
// A change to it is a policy decision recorded in a superseding ADR
// (docs/adr/0014-dependency-license-allowlist-extension.md), and AGENTS.md
// (Review section) holds the same list. `bun pm licenses` does not parse SPDX
// expressions, so each expression is one key.
export const ALLOWED: Record<string, true> = {
	"0BSD": true,
	"Apache-2.0": true,
	"BlueOak-1.0.0": true,
	"BSD-2-Clause": true,
	"BSD-3-Clause": true,
	"CC-BY-4.0": true,
	"EPL-2.0 OR GPL-3.0-or-later": true,
	ISC: true,
	MIT: true,
	"MIT OR Apache-2.0": true,
	"(MPL-2.0 OR Apache-2.0)": true,
	"MPL-2.0": true,
	Unlicense: true,
};
// khroma 2.1.0 (a mermaid dependency) names no license in its package.json and
// ships an MIT license file, so `bun pm licenses` reports it as "Unknown"
// (ADR-0014). Any other "Unknown" package still fails.
const UNKNOWN_OK: Record<string, true> = { khroma: true };

export interface LicensesCheck {
	ok: boolean;
	problems: string[];
}

/** Checks one `bun pm licenses --json` mapping: license key -> packages. */
export function checkLicenses(
	licenses: Record<string, { name: string }[]>,
): LicensesCheck {
	// `=== true`, not `in`: a key such as "constructor" must not match the object prototype.
	const bad = Object.entries(licenses)
		.map(([key, packages]): [string, { name: string }[]] => [
			key,
			key === "Unknown"
				? packages.filter((p) => UNKNOWN_OK[p.name] !== true)
				: packages,
		])
		.filter(([key, packages]) => packages.length > 0 && ALLOWED[key] !== true);
	return {
		ok: bad.length === 0,
		problems: bad.map(
			([key, packages]) =>
				`license outside the allowlist: ${key}: ${packages
					.map((p) => p.name)
					.join(", ")}`,
		),
	};
}

function main(): number {
	const proc = Bun.spawnSync([process.execPath, "pm", "licenses", "--json"]);
	if (proc.exitCode !== 0) {
		console.error(
			`bun pm licenses failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`,
		);
		return 1;
	}
	// License key -> packages. Another shape throws here: that fails the gate.
	const check = checkLicenses(JSON.parse(proc.stdout.toString()));
	for (const problem of check.problems) console.error(problem);
	return check.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main());

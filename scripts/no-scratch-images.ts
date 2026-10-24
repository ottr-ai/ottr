/**
 * Fails when a scratch shot is tracked. Turn screenshots live in .tasks; the
 * repo keeps only the intentional images under .github/assets (and the small
 * workflow SVGs in src/ui). Gitignore cannot untrack a file that a force-add
 * landed, so the gate checks the tree itself.
 */
const out = Bun.spawnSync({
	cmd: [
		"git",
		"ls-files",
		"--",
		"shots/",
		"*.png",
		"*.jpg",
		"*.jpeg",
		"*.gif",
		"*.webp",
	],
	stdout: "pipe",
});
const tracked = out.stdout.toString().trim().split("\n").filter(Boolean);
const allowed = /^(\.github\/assets\/|src\/ui\/)/;
const bad = tracked.filter((f) => !allowed.test(f));
if (bad.length > 0) {
	console.error("tracked scratch images (remove them; see .gitignore):");
	for (const f of bad) console.error(" ", f);
	process.exit(1);
}
console.log(
	`no-scratch: ok (${tracked.length} tracked images, all allowed paths)`,
);

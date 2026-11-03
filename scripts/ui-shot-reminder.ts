// Non-blocking reminder for a src/ui change that left the README screenshot alone.
// `bun run check` runs it last; it always exits 0, because behaviour-only or
// off-screen UI changes legitimately keep .github/assets/screenshot.png as it is.
const proc = Bun.spawnSync(
	["git", "diff", "--merge-base", "origin/main", "--name-only"],
	{ stdout: "pipe", stderr: "pipe" },
);
// No origin/main to diff against (fresh clone, CI on the target branch): stay silent.
if (proc.exitCode !== 0) process.exit(0);
const files = proc.stdout
	.toString()
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);
const ui = files.filter((file) => file.startsWith("src/ui/"));
if (ui.length > 0 && !files.includes(".github/assets/screenshot.png")) {
	console.warn(
		`ui-shot: ${ui.length} file(s) under src/ui changed, but ` +
			".github/assets/screenshot.png did not. If the change alters what the board " +
			"shows, run `bun run readme-screenshot` and commit the new image; " +
			"behaviour-only or off-screen changes can ignore this reminder.",
	);
}
process.exit(0);

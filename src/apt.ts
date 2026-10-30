// System packages a project's turns need (e.g. the shared libraries Chrome needs for omp's
// browser tool). The list lives in the data repo as workers/<project>/apt.txt; alate provisions
// it into the shared home volume. A worker installs every list when it starts, and the
// container that runs a turn installs what it still lacks.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Debian package names (policy 5.6.1): a list entry can never turn into an apt-get option.
const PACKAGE = /^[a-z0-9][a-z0-9+.-]+$/;
// One path segment that cannot climb out of the workers dir; mirrors the New tab, which
// rejects only separators and the dot names, so any other folder name is legal here.
export const PROJECT = /^(?!\.\.?$)[^/\\]+$/;

/** The projects alate provisioned under ~/.ottr/workers, sorted; unsafe names are skipped. */
export function workerProjects(home = homedir()): string[] {
	const dir = join(home, ".ottr", "workers");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.sort()
		.filter((p) => PROJECT.test(p));
}

/** Where alate provisions a project's package list. */
export function aptListPath(project: string, home = homedir()): string {
	if (!PROJECT.test(project))
		throw new Error(`apt: unsafe project name ${JSON.stringify(project)}`);
	return join(home, ".ottr", "workers", project, "apt.txt");
}

/** apt.txt: one Debian package per line; `#` comments and blank lines are ignored. */
export function parseAptTxt(text: string): string[] {
	const names = text
		.split("\n")
		.map((l) => l.replace(/#.*/, "").trim())
		.filter((l) => l !== "");
	const bad = names.filter((n) => !PACKAGE.test(n));
	if (bad.length > 0)
		throw new Error(`apt: not a Debian package name: ${bad.join(", ")}`);
	return [...new Set(names)];
}

/** The names `dpkg-query --status` output does not show as installed. */
export function missingFrom(names: string[], status: string): string[] {
	const installed = new Set<string>();
	for (const block of status.split(/\n\s*\n/)) {
		const name = /^Package: (\S+)/m.exec(block)?.[1];
		if (name && /^Status: .* installed$/m.test(block)) installed.add(name);
	}
	return names.filter((n) => !installed.has(n));
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Installs the listed packages this machine lacks, before a turn runs here. Returns lines for
 * the turn log (none when nothing was missing); throws apt's own error, so the turn stops.
 */
export async function ensureProjectPackages(
	project: string,
	home = homedir(),
): Promise<string[]> {
	const file = aptListPath(project, home);
	if (!existsSync(file)) return [];
	const names = parseAptTxt(readFileSync(file, "utf8"));
	if (names.length === 0) return [];
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		!Bun.which("apt-get")
	)
		return [
			`apt: ${file} lists ${names.length} package(s), but only root on Debian or Ubuntu installs them here: install them yourself`,
		];
	// ponytail: one install at a time per process (each container runs one ottr process);
	// apt's lock timeout covers other callers, e.g. an agent running apt-get itself.
	const run = queue.then(() => install(names, file));
	queue = run.catch(() => {});
	return run;
}

/**
 * Every provisioned list, when a worker starts, so a project's first turn there does not wait
 * for its packages. A list that fails adds its error line, and the other lists still install.
 */
export async function ensureAllPackages(home = homedir()): Promise<string[]> {
	const lines: string[] = [];
	for (const project of workerProjects(home)) {
		try {
			lines.push(...(await ensureProjectPackages(project, home)));
		} catch (err) {
			lines.push(`${project}: ${err instanceof Error ? err.message : err}`);
		}
	}
	return lines;
}

/** The packages `dpkg --audit` names: each sits on a line `" <name>[:arch]  <summary>"`. */
export function auditedPackages(audit: string): string[] {
	const names = audit
		.split("\n")
		.map((line) => /^ (\S+)/.exec(line)?.[1]?.split(":")[0] ?? "")
		.filter((name) => PACKAGE.test(name));
	return [...new Set(names)];
}

type Exec = (argv: string[], check?: boolean) => Promise<string>;

/** Exported for tests, which inject `run` in place of the real commands. */
export async function install(
	names: string[],
	file: string,
	run: Exec = exec,
): Promise<string[]> {
	const status = await run(["dpkg-query", "--status", ...names], false);
	const missing = missingFrom(names, status);
	if (missing.length === 0) return [];
	// A container stopped during apt-get leaves dpkg interrupted, and every later apt-get
	// install then fails (OTTR-221). dpkg has no lock timeout: when another apt run holds the
	// lock, this fails, and apt-get install below waits for the lock and reports instead.
	await run(["dpkg", "--configure", "-a"], false);
	const broken = auditedPackages(await run(["dpkg", "--audit"], false));
	await run(["apt-get", "update", "-qq"]);
	if (broken.length > 0) {
		await run([
			"apt-get",
			"install",
			"-y",
			"-qq",
			"--reinstall",
			"-o",
			"DPkg::Lock::Timeout=120",
			...broken,
		]);
		const audit = (await run(["dpkg", "--audit"], false)).trim();
		if (audit) throw new Error(`apt: dpkg --audit after repair: ${audit}`);
	}
	await run([
		"apt-get",
		"install",
		"-y",
		"-qq",
		"--no-install-recommends",
		"-o",
		"DPkg::Lock::Timeout=120",
		...missing,
	]);
	return [`apt: installed ${missing.join(" ")} (${file})`];
}

/** stdout; throws with the stderr tail on a non-zero exit when `check` is set. */
async function exec(argv: string[], check = true): Promise<string> {
	const p = Bun.spawn(argv, {
		env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	if (check && code !== 0)
		throw new Error(
			`apt: ${argv.slice(0, 2).join(" ")} failed (exit ${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`,
		);
	return stdout;
}

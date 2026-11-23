// Python packages a project's turns need (numpy, Pillow, hypothesis, ruff, ...). The list lives
// in the data repo as workers/<project>/requirements.txt (workers/_all/requirements.txt for the
// fleet); alate provisions it beside apt.txt and tools.json, and the board seed copies it into
// the board home. The board sends the trusted list texts on every worker turn request, and a
// worker builds from that request only, never from the shared home copies
// (docs/specs/worker-list-isolation.md). Every line is pinned and hashed
// (`name==version --hash=sha256:...`, transitive
// deps included), so pip installs with --require-hashes and nothing unpinned slips in, in either
// home. Each installing home builds its own venv under <home>/.ottr/pip/<sha256 of the merged
// list>/, so the server never reads or runs anything from the worker-writable shared home (R5-1).
// A server-side turn (merge turn, or a work turn with no worker) puts the venv's bin dir on its
// PATH; a worker work turn keeps its own ad-hoc install flow
// (docs/specs/merge-turn-packages.md).
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROJECT } from "./apt.ts";
import { childDatabaseEnv } from "./childEnv.ts";
import { resolveAgentLayer } from "./layers.ts";

// One line per package: a pinned name==version plus at least one sha256 hash. No options, no
// extras, no URL or VCS requirements: an injected `--index-url` here would redirect the pip run
// of the server (R5-1 surface) to an attacker's index, so the grammar refuses everything else.
const LINE =
	/^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==([A-Za-z0-9][A-Za-z0-9.+_!-]*)((?: --hash=sha256:[0-9a-f]{64})+)$/;

export interface RequirementLine {
	name: string;
	version: string;
	hashes: string[];
}

/** Where alate provisions a project's requirements list, resolved for a read: under the
 *  home's current agent layer when one exists, else the flat home (the other `.ottr/workers`
 *  lists resolve the same way). */
export function requirementsListPath(
	project: string,
	home = homedir(),
): string {
	if (!PROJECT.test(project))
		throw new Error(`pip: unsafe project name ${JSON.stringify(project)}`);
	const layer = resolveAgentLayer(home)?.dir ?? home;
	return join(layer, ".ottr", "workers", project, "requirements.txt");
}

/** requirements.txt: one pinned, hashed line per package; `#` comments and blank lines are ignored. */
export function parseRequirements(text: string): RequirementLine[] {
	const lines: RequirementLine[] = [];
	const seen = new Set<string>();
	for (const raw of text.split("\n")) {
		const line = raw.replace(/#.*/, "").trim();
		if (line === "") continue;
		const m = LINE.exec(line);
		if (!m)
			throw new Error(
				`pip: not a pinned, hashed requirement line: ${JSON.stringify(raw)}`,
			);
		const [, name, version, hashPart] = m;
		if (name === undefined || version === undefined || hashPart === undefined)
			throw new Error(
				`pip: not a pinned, hashed requirement line: ${JSON.stringify(raw)}`,
			);
		const key = name.toLowerCase();
		if (seen.has(key)) throw new Error(`pip: duplicate package: ${name}`);
		seen.add(key);
		lines.push({
			name,
			version,
			hashes: hashPart.split(" --hash=sha256:").filter(Boolean),
		});
	}
	return lines;
}

/** The exact text pip installs: the lines back in file form, so the hash pins this content. */
function canonical(lines: RequirementLine[]): string {
	return `${lines
		.map(
			(l) =>
				`${l.name}==${l.version} --hash=sha256:${l.hashes.join(" --hash=sha256:")}`,
		)
		.join("\n")}\n`;
}

/**
 * The project's lines first, then the fleet's unseen ones: the project wins on a name clash
 * (case-insensitive, pip names fold case). Both the server wrapper and the worker path merge
 * through this helper, so one list always means one venv key.
 */
export function mergeRequirements(
	project: RequirementLine[],
	all: RequirementLine[],
): RequirementLine[] {
	const byName = new Map<string, RequirementLine>();
	for (const line of [...project, ...all]) {
		const key = line.name.toLowerCase();
		if (!byName.has(key)) byName.set(key, line);
	}
	return [...byName.values()];
}

/** One project's requirements.txt (requirementsListPath resolves the layer); a missing file lists nothing. */
function readRequirementsFile(
	project: string,
	home: string,
): RequirementLine[] {
	const file = requirementsListPath(project, home);
	if (!existsSync(file)) return [];
	return parseRequirements(readFileSync(file, "utf8"));
}

/** Content-addressed venv key: one list, one venv, and a rerun against the same list is a no-op. */
export function requirementsKey(lines: RequirementLine[]): string {
	return new Bun.CryptoHasher("sha256").update(canonical(lines)).digest("hex");
}

/** The venv a home builds for a merged list; the bin dir inside it is what a turn PATH gets. */
export function pipVenvDir(key: string, home = homedir()): string {
	return join(home, ".ottr", "pip", key);
}

/**
 * The venv bin dir for a merged list, or "" when the list is empty or the venv is not built
 * yet; callers run ensurePython first. It never installs anything.
 */
export function pythonPathFor(
	lines: RequirementLine[],
	home = homedir(),
): string {
	if (lines.length === 0) return "";
	const dir = join(pipVenvDir(requirementsKey(lines), home), "bin");
	return existsSync(dir) ? dir : "";
}

/** The server-local wrapper: the merged list's venv bin dir for a project's turn PATH. */
export function pythonPathDir(project: string, home = homedir()): string {
	return pythonPathFor(
		mergeRequirements(
			readRequirementsFile(project, home),
			readRequirementsFile("_all", home),
		),
		home,
	);
}

type Exec = (argv: string[], home: string) => Promise<string>;

/** stdout; throws with the stderr tail on a non-zero exit. */
async function exec(argv: string[], home: string): Promise<string> {
	// The server container mounts the worker-shared home volume at /root (docker-compose), so
	// the inherited HOME is worker-writable and any .pth file planted there would execute at
	// every interpreter startup. Pin HOME to the building home and keep the base interpreter
	// isolated (-I implies -s: no user site, and -E: no PYTHON* env vars reach startup);
	// PYTHONNOUSERSITE=1 covers the venv's pip run too, whose shebang interpreter takes no -I.
	const env = { ...childDatabaseEnv(), HOME: home, PYTHONNOUSERSITE: "1" };
	const isolated =
		argv[0] === "python3" ? [argv[0], "-I", ...argv.slice(1)] : argv;
	const p = Bun.spawn(isolated, {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	if (code !== 0)
		throw new Error(
			`pip: ${argv.slice(0, 2).join(" ")} failed (exit ${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`,
		);
	return stdout;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Builds the venv for the given merged lines under this home when the machine still lacks it,
 * before a turn runs here; a worker passes the request's merged list (the project's lines win
 * over the fleet's, mergeRequirements). Returns lines for the turn log (none when nothing was
 * missing); throws on the first failure, so the turn stops: missing declared packages are the
 * ASSE-6 failure mode.
 */
export async function ensurePython(
	lines: RequirementLine[],
	home = homedir(),
	run: Exec = exec,
): Promise<string[]> {
	if (lines.length === 0) return [];
	const key = requirementsKey(lines);
	const target = pipVenvDir(key, home);
	if (existsSync(target)) return [];
	if (!Bun.which("python3"))
		throw new Error(
			"pip: no python3 on PATH; the turn image needs python3-venv (Dockerfile.worker)",
		);
	// ponytail: one build at a time per process (each container runs one ottr process); the
	// sha256-keyed target dir makes a rerun a no-op anyway.
	const build = queue.then(() => buildVenv(lines, key, target, home, run));
	queue = build.catch(() => {});
	return build;
}

/** The server-local wrapper: read both files, merge (the project's lines win), build. */
export async function ensureProjectPython(
	project: string,
	home = homedir(),
	run: Exec = exec,
): Promise<string[]> {
	return ensurePython(
		mergeRequirements(
			readRequirementsFile(project, home),
			readRequirementsFile("_all", home),
		),
		home,
		run,
	);
}

async function buildVenv(
	lines: RequirementLine[],
	key: string,
	target: string,
	home: string,
	run: Exec,
): Promise<string[]> {
	const root = join(home, ".ottr", "pip");
	mkdirSync(root, { recursive: true });
	// Same filesystem as the target, so the final move is one rename and a half-built venv
	// never lands under the key a turn would reuse.
	const tmp = mkdtempSync(join(root, "build-"));
	try {
		// The staged copy freezes the merged list: the file alate provisions could change
		// mid-install, and the key must stay the hash of what pip actually installed.
		const staged = join(tmp, "requirements.txt");
		writeFileSync(staged, canonical(lines));
		const venv = join(tmp, "venv");
		await run(["python3", "-m", "venv", venv], home);
		await run(
			[
				join(venv, "bin", "pip"),
				"install",
				"--no-cache-dir",
				"--disable-pip-version-check",
				"--require-hashes",
				"-r",
				staged,
			],
			home,
		);
		try {
			renameSync(venv, target);
		} catch (err) {
			// Two containers build the same list at once: the winner's folder is complete
			// (one rename), so the loser reuses it instead of failing the turn.
			if (!existsSync(target)) throw err;
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	return [
		`pip: installed ${lines.length} package(s) into the project venv (${key.slice(0, 12)})`,
	];
}

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { requirementsListPath } from "./python.ts";
import { type ToolEntry, toolsListPath } from "./tools.ts";
import { prepareTurnPackages } from "./turnPackages.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		chmodSync(join(root, "trusted"), 0o700);
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture() {
	// A uid-drop child must not depend on a runner's private TMPDIR ancestors.
	const root = mkdtempSync("/tmp/ottr-turn-packages-");
	roots.push(root);
	chmodSync(root, 0o755);
	const trusted = join(root, "trusted");
	const destination = join(root, "destination");
	mkdirSync(trusted, { mode: 0o700 });
	mkdirSync(destination, { mode: 0o755 });
	return { root, trusted, destination };
}

function provision(home: string, project: string, file: string, text: string) {
	mkdirSync(join(home, ".ottr", "workers", project), { recursive: true });
	writeFileSync(join(home, ".ottr", "workers", project, file), text);
}

function seed(home: string, output: string): ToolEntry {
	const bytes = `#!/bin/sh\nprintf '%s\\n' '${output}'\n`;
	const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const entry: ToolEntry = {
		name: "fixture-tool",
		url: "https://example.invalid/fixture-tool",
		sha256,
		unpack: "none",
	};
	const dir = join(home, ".ottr", "tools", sha256);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, entry.name), bytes, { mode: 0o755 });
	return entry;
}

test("trusted real lists select destination tools and project precedence despite a private source", async () => {
	const { trusted, destination } = fixture();
	const project = seed(destination, "project");
	const fleet = seed(destination, "fleet");
	provision(trusted, "p", "tools.json", JSON.stringify([project]));
	provision(trusted, "_all", "tools.json", JSON.stringify([fleet]));
	provision(destination, "p", "tools.json", "invalid planted list");
	provision(
		destination,
		"p",
		"requirements.txt",
		"invalid planted requirements",
	);
	const prepared = await prepareTurnPackages("p", trusted, destination);
	expect(prepared.pathDir).toStartWith(join(destination, ".ottr", "tools"));
	expect(prepared.pathDir).not.toContain(trusted);
	expect(existsSync(join(trusted, ".ottr", "tools"))).toBe(false);
	const root = process.getuid?.() === 0;
	// Root retains list authority, but the agent uid cannot read the list.
	chmodSync(trusted, root ? 0o700 : 0o000);
	const child = spawnSync(
		"/bin/sh",
		[
			"-c",
			'test ! -r "$1" || exit 91; fixture-tool',
			"fixture",
			toolsListPath("p", trusted),
		],
		{
			env: { PATH: `${prepared.pathDir}:/usr/bin:/bin` },
			...(root ? { uid: 65534, gid: 65534 } : {}),
			encoding: "utf8",
		},
	);
	expect(child.error).toBeUndefined();
	expect(child.status).toBe(0);
	expect(child.stdout).toBe("project\n");
});

test("Python reads trusted lists and builds directly in the destination with project precedence", async () => {
	const { trusted, destination } = fixture();
	const pin = "a".repeat(64);
	const project = `idna==3.10 --hash=sha256:${pin}\n`;
	const fleet = `idna==3.9 --hash=sha256:${pin}\nnumpy==2.0 --hash=sha256:${pin}\n`;
	provision(trusted, "p", "requirements.txt", project);
	provision(trusted, "_all", "requirements.txt", fleet);
	provision(destination, "p", "requirements.txt", "--index-url planted");
	const calls: string[][] = [];
	let staged = "";
	const prepared = await prepareTurnPackages(
		"p",
		trusted,
		destination,
		async (argv, home) => {
			expect(home).toBe(destination);
			calls.push(argv);
			if (argv[0] === "python3")
				mkdirSync(join(argv[3]!, "bin"), { recursive: true });
			else staged = readFileSync(argv[argv.indexOf("-r") + 1]!, "utf8");
			return "";
		},
	);
	expect(calls).toHaveLength(2);
	expect(calls[0]![3]).toStartWith(join(destination, ".ottr", "pip"));
	expect(calls[1]).toContain("--require-hashes");
	expect(staged).toBe(`${project}numpy==2.0 --hash=sha256:${pin}\n`);
	expect(prepared.pathDir).toStartWith(join(destination, ".ottr", "pip"));
	expect(prepared.pathDir).not.toContain(trusted);
	expect(existsSync(join(trusted, ".ottr", "pip"))).toBe(false);
});

test("missing trusted lists ignore destination plants", async () => {
	const { trusted, destination } = fixture();
	provision(destination, "_all", "tools.json", "bad");
	provision(destination, "p", "requirements.txt", "bad");
	expect(await prepareTurnPackages("p", trusted, destination)).toEqual({
		lines: [],
		pathDir: null,
	});
});

test("legacy preparation installs and executes from the trusted home", async () => {
	const { trusted } = fixture();
	const entry = seed(trusted, "legacy");
	provision(trusted, "p", "tools.json", JSON.stringify([entry]));
	const prepared = await prepareTurnPackages("p", trusted);
	expect(prepared.pathDir).toStartWith(join(trusted, ".ottr", "tools"));
	const child = spawnSync("/bin/sh", ["-c", "fixture-tool"], {
		env: { PATH: `${prepared.pathDir}:/usr/bin:/bin` },
		encoding: "utf8",
	});
	expect(child.status).toBe(0);
	expect(child.stdout).toBe("legacy\n");
});

test("invalid trusted lists and failed Python installs fail the caller", async () => {
	const { trusted, destination } = fixture();
	provision(trusted, "p", "tools.json", "bad");
	await expect(
		prepareTurnPackages("p", trusted, destination),
	).rejects.toThrow();
	writeFileSync(toolsListPath("p", trusted), "[]");
	provision(trusted, "p", "requirements.txt", "--index-url forbidden");
	await expect(
		prepareTurnPackages("p", trusted, destination),
	).rejects.toThrow();
	writeFileSync(
		requirementsListPath("p", trusted),
		`idna==3.10 --hash=sha256:${"a".repeat(64)}\n`,
	);
	await expect(
		prepareTurnPackages("p", trusted, destination, async () => {
			throw new Error("fixture Python install failure");
		}),
	).rejects.toThrow("fixture Python install failure");
});

test("a corrupt pinned tool fails rather than using a planted destination list", async () => {
	const { trusted, destination } = fixture();
	const entry = seed(destination, "trusted");
	provision(trusted, "p", "tools.json", JSON.stringify([entry]));
	writeFileSync(
		join(destination, ".ottr", "tools", entry.sha256, entry.name),
		"corrupt",
	);
	await expect(prepareTurnPackages("p", trusted, destination)).rejects.toThrow(
		"installed binary does not match its sha256",
	);
});

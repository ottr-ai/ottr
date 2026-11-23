import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { childDatabaseEnv } from "./childEnv.ts";
import {
	ensureProjectPython,
	ensurePython,
	mergeRequirements,
	parseRequirements,
	pipVenvDir,
	pythonPathDir,
	pythonPathFor,
	type RequirementLine,
	requirementsKey,
	requirementsListPath,
} from "./python.ts";

const home = mkdtempSync(join(tmpdir(), "ottr-pip-"));
const homes: string[] = [home];

afterEach(() => {
	for (const h of homes.splice(1)) rmSync(h, { recursive: true, force: true });
});

const freshHome = (): string => {
	const h = mkdtempSync(join(tmpdir(), "ottr-pip-"));
	homes.push(h);
	return h;
};

const provision = (project: string, text: string, h = home): void => {
	mkdirSync(join(h, ".ottr", "workers", project), { recursive: true });
	writeFileSync(requirementsListPath(project, h), text);
};

/** This interpreter's user site under this HOME — the path a child with this HOME reads; creates it. */
const pythonUserSite = (home: string): string => {
	const p = Bun.spawnSync(
		["python3", "-c", "import site; print(site.getusersitepackages())"],
		{
			env: { ...childDatabaseEnv(), HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (p.exitCode !== 0)
		throw new Error(`python3 site probe failed: ${p.stderr.toString().trim()}`);
	const dir = p.stdout.toString().trim();
	if (dir === "")
		throw new Error("python3 site probe printed no user site path");
	mkdirSync(dir, { recursive: true });
	return dir;
};

const A64 = "a".repeat(64);
const B64 = "b".repeat(64);
const C64 = "c".repeat(64);
/** A fake command run: records argv, creates the venv dir like the real command, returns "".
 *  The staged requirements content is captured at call time: buildVenv removes its temp dir. */
const recorder = (): {
	calls: string[][];
	readonly stagedText: string;
	run: (argv: string[]) => Promise<string>;
} => {
	const calls: string[][] = [];
	let staged = "";
	return {
		calls,
		get stagedText() {
			return staged;
		},
		run: async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "python3" && argv[1] === "-m" && argv[2] === "venv")
				mkdirSync(argv[3]!, { recursive: true });
			if (argv.includes("-r"))
				staged = readFileSync(argv[argv.indexOf("-r") + 1]!, "utf8");
			return "";
		},
	};
};

describe("requirementsListPath", () => {
	test("joins the provisioned workers dir and refuses unsafe project names", () => {
		expect(requirementsListPath("velvarr", "/h")).toBe(
			join("/h", ".ottr", "workers", "velvarr", "requirements.txt"),
		);
		for (const bad of ["..", "../x", "a/b", "a\\b", ""])
			expect(() => requirementsListPath(bad, "/h")).toThrow(
				"unsafe project name",
			);
	});
});

describe("parseRequirements", () => {
	test("accepts pinned, hashed lines with comments and blanks", () => {
		const text = [
			"# pinned by pip-compile",
			"",
			`numpy==1.26.4 --hash=sha256:${A64} --hash=sha256:${B64}`,
			`ruff==0.6.9 --hash=sha256:${C64}`,
			"",
		].join("\n");
		expect(parseRequirements(text)).toEqual([
			{ name: "numpy", version: "1.26.4", hashes: [A64, B64] },
			{ name: "ruff", version: "0.6.9", hashes: [C64] },
		]);
	});

	test("rejects unpinned lines, options, extras, bad hashes and duplicates", () => {
		const good = (s: string): string => `x==1.0 --hash=sha256:${A64}${s}`;
		for (const bad of [
			"numpy",
			"numpy>=1.26.4",
			"numpy==1.26.4",
			`numpy==1.26.4 --hash=sha256:${"zz".repeat(32)}`,
			"-r other.txt",
			"--index-url https://example.com/simple",
			`numpy[extra]==1.26.4 --hash=sha256:${A64}`,
			`numpy == 1.26.4 --hash=sha256:${A64}`,
			good(" --extra-index-url https://evil.example"),
			good(" ; python_version<'3.13'"),
			`idna==3.6 --hash=sha256:${A64}\nidna==3.7 --hash=sha256:${B64}`,
		])
			expect(() => parseRequirements(bad)).toThrow();
	});

	test("a rejected line's error names the raw line", () => {
		expect(() => parseRequirements("numpy>=2\n")).toThrow('"numpy>=2"');
	});
});

describe("requirementsKey", () => {
	test("one content, one key", () => {
		const line: RequirementLine = {
			name: "idna",
			version: "3.10",
			hashes: [A64],
		};
		expect(requirementsKey([line])).toBe(requirementsKey([line]));
		expect(requirementsKey([line])).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("ensureProjectPython", () => {
	test("builds one venv from the merged list, the project's line winning, with --require-hashes", async () => {
		const h = freshHome();
		provision("p", `numpy==1.26.4 --hash=sha256:${A64}\n`, h);
		provision(
			"_all",
			`numpy==2.0.0 --hash=sha256:${B64}\nidna==3.10 --hash=sha256:${C64}\n`,
			h,
		);
		const rec = recorder();
		const lines = await ensureProjectPython("p", h, rec.run);
		expect(lines).toEqual([
			expect.stringMatching(
				/^pip: installed 2 package\(s\) into the project venv \([0-9a-f]{12}\)$/,
			),
		]);
		expect(rec.calls).toHaveLength(2);
		const [venvArgv, pipArgv] = rec.calls;
		expect(venvArgv!.slice(0, 3)).toEqual(["python3", "-m", "venv"]);
		expect(venvArgv![3]!.endsWith("/venv")).toBe(true);
		expect(pipArgv![0]!.endsWith("/bin/pip")).toBe(true);
		expect(pipArgv).toContain("--require-hashes");
		expect(pipArgv).toContain("--no-cache-dir");
		// The project's numpy line wins over _all's; _all's unseen idna joins.
		expect(rec.stagedText).toBe(
			`numpy==1.26.4 --hash=sha256:${A64}\nidna==3.10 --hash=sha256:${C64}\n`,
		);
	});

	test("an existing venv is a no-op: no commands, no lines", async () => {
		const h = freshHome();
		const text = `idna==3.10 --hash=sha256:${A64}\n`;
		provision("p", text, h);
		mkdirSync(pipVenvDir(requirementsKey(parseRequirements(text)), h), {
			recursive: true,
		});
		const { calls, run } = recorder();
		expect(await ensureProjectPython("p", h, run)).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("a missing list is a no-op", async () => {
		const h = freshHome();
		const { calls, run } = recorder();
		expect(await ensureProjectPython("p", h, run)).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("a failed command fails the turn", async () => {
		const h = freshHome();
		provision("p", `idna==3.10 --hash=sha256:${A64}\n`, h);
		const run = async (): Promise<string> => {
			throw new Error("pip: python3 -m venv failed (exit 1): nope");
		};
		await expect(ensureProjectPython("p", h, run)).rejects.toThrow(
			"pip: python3 -m venv failed (exit 1)",
		);
	});
});

describe("mergeRequirements", () => {
	const line = (name: string, version: string): RequirementLine => ({
		name,
		version,
		hashes: [A64],
	});

	test("the project's line wins, and the fleet's unseen names join", () => {
		expect(
			mergeRequirements(
				[line("numpy", "1.26.4")],
				[line("numpy", "2.0.0"), line("idna", "3.10")],
			),
		).toEqual([line("numpy", "1.26.4"), line("idna", "3.10")]);
	});

	test("a name clash folds case: the project's spelling wins", () => {
		expect(
			mergeRequirements([line("NumPy", "1.9")], [line("numpy", "2.0")]),
		).toEqual([line("NumPy", "1.9")]);
	});
});

describe("ensurePython", () => {
	test("builds one venv from the given lines with --require-hashes", async () => {
		const h = freshHome();
		const reqs = parseRequirements(`idna==3.10 --hash=sha256:${A64}\n`);
		const rec = recorder();
		const built = await ensurePython(reqs, h, rec.run);
		expect(built).toEqual([
			expect.stringMatching(
				/^pip: installed 1 package\(s\) into the project venv \([0-9a-f]{12}\)$/,
			),
		]);
		expect(rec.calls).toHaveLength(2);
		expect(rec.calls[1]).toContain("--require-hashes");
		expect(rec.stagedText).toBe(`idna==3.10 --hash=sha256:${A64}\n`);
		// The venv lands under the key of exactly these lines.
		expect(existsSync(pipVenvDir(requirementsKey(reqs), h))).toBe(true);
	});

	test("no lines is a no-op", async () => {
		const h = freshHome();
		const { calls, run } = recorder();
		expect(await ensurePython([], h, run)).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("an existing venv is a no-op: no commands, no lines", async () => {
		const h = freshHome();
		const reqs = parseRequirements(`idna==3.10 --hash=sha256:${A64}\n`);
		mkdirSync(pipVenvDir(requirementsKey(reqs), h), { recursive: true });
		const { calls, run } = recorder();
		expect(await ensurePython(reqs, h, run)).toEqual([]);
		expect(calls).toEqual([]);
	});

	// The one stub-free case: the real python3 build proves the live path. A .pth file in
	// the shared home's user site must never execute while the venv builds (OTTR-1023).
	test("a build never reads the HOME user site", async () => {
		const h = freshHome();
		const shared = freshHome();
		const canary = join(shared, "canary-was-here");
		writeFileSync(
			join(pythonUserSite(shared), "zz-marker.pth"),
			`import os; os.path.exists(${JSON.stringify(canary)}) or open(${JSON.stringify(canary)}, "w").write("ran")\n`,
		);
		// Control: the pre-fix env shape (HOME at the shared home, plain python3) runs the
		// marker. If this fails, the sink itself is gone and the drill proves nothing.
		const control = Bun.spawnSync(["python3", "-c", "pass"], {
			env: { ...childDatabaseEnv(), HOME: shared },
			stdout: "ignore",
			stderr: "pipe",
		});
		expect(control.exitCode).toBe(0);
		expect(existsSync(canary)).toBe(true);
		rmSync(canary);
		// The build inherits HOME=<shared> through the process env, yet exec pins HOME to
		// the board home and runs python3 isolated, so the marker never runs. The fake
		// hash pins pip's failure to after the venv step, offline and online alike.
		const real = process.env.HOME;
		process.env.HOME = shared;
		let err: Error | null = null;
		try {
			await ensurePython(
				parseRequirements(`idna==3.10 --hash=sha256:${A64}\n`),
				h,
			);
		} catch (e) {
			err = e as Error;
		} finally {
			process.env.HOME = real;
		}
		expect(err?.message).toContain("pip install");
		expect(existsSync(canary)).toBe(false);
	}, 60_000);
});

describe("pythonPathFor", () => {
	test("empty without lines or before the build; the bin dir after it", () => {
		const h = freshHome();
		expect(pythonPathFor([], h)).toBe("");
		const reqs = parseRequirements(`idna==3.10 --hash=sha256:${A64}\n`);
		expect(pythonPathFor(reqs, h)).toBe("");
		const bin = join(pipVenvDir(requirementsKey(reqs), h), "bin");
		mkdirSync(bin, { recursive: true });
		expect(pythonPathFor(reqs, h)).toBe(bin);
	});
});

describe("pythonPathDir", () => {
	test("empty without a list or before the build; the bin dir after it", () => {
		const h = freshHome();
		expect(pythonPathDir("p", h)).toBe("");
		const text = `idna==3.10 --hash=sha256:${A64}\n`;
		provision("p", text, h);
		expect(pythonPathDir("p", h)).toBe("");
		const bin = join(
			pipVenvDir(requirementsKey(parseRequirements(text)), h),
			"bin",
		);
		mkdirSync(bin, { recursive: true });
		expect(pythonPathDir("p", h)).toBe(bin);
	});
});

describe("parseRequirements property", () => {
	// Gate: 200 runs, fixed seed (src/test/properties.ts), so the mutation runs see the same inputs.
	const nameArb = fc
		.array(fc.constantFrom(..."aZ09._-".split("")), {
			minLength: 1,
			maxLength: 12,
		})
		.map((cs) => `n${cs.join("")}x`);
	const versionArb = fc
		.array(fc.constantFrom(..."09.+_!b".split("")), {
			minLength: 1,
			maxLength: 10,
		})
		.map((cs) => `1${cs.join("")}`);
	const hashesArb = fc
		.array(fc.stringMatching(/^[0-9a-f]{64}$/), {
			minLength: 1,
			maxLength: 3,
		})
		.map((hs) => [...new Set(hs)]);

	test("valid lines round-trip through parse and canonical form", () => {
		const prop = fc.property(
			nameArb,
			versionArb,
			hashesArb,
			(name, version, hashes) => {
				const line = `# pin\n${name}==${version} --hash=sha256:${hashes.join(" --hash=sha256:")}\n`;
				const parsed = parseRequirements(line);
				expect(parsed).toEqual([{ name, version, hashes }]);
				// The canonical re-render parses to the same entry, so the venv key pins
				// exactly the text pip installs.
				expect(
					parseRequirements(
						`${parsed[0]!.name}==${parsed[0]!.version} --hash=sha256:${parsed[0]!.hashes.join(" --hash=sha256:")}\n`,
					),
				).toEqual(parsed);
			},
		);
		fc.assert(prop, { seed: 42, numRuns: 200 });
	});

	test("every malformed mutation throws", () => {
		const prop = fc.property(
			nameArb,
			versionArb,
			fc.stringMatching(/^[0-9a-f]{64}$/),
			fc.constantFrom(
				(s: string) => s.replace(/(--hash=.*)$/, ""),
				(s: string) => s.replace("==", ">="),
				(s: string) => s.replace("==", " == "),
				(s: string) => s.replace("==", "<="),
				(s: string) => `${s} --index-url https://evil.example\n`,
				(s: string) => `-r other.txt\n${s}\n`,
				(s: string) => s.replace(/^n/, "n[cpu]"),
				(s: string) => `${s} --hash=sha1:${"a".repeat(40)}`,
			),
			(name, version, hash, mutate) => {
				const line = `${name}==${version} --hash=sha256:${hash}`;
				expect(() => parseRequirements(mutate(line))).toThrow();
			},
		);
		fc.assert(prop, { seed: 42, numRuns: 200 });
	});
});

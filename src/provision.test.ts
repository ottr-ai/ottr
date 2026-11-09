import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
	auditProvisioned,
	provisionFingerprint,
	rulesDirEntries,
} from "./provision.ts";

let home: string;

afterEach(() => {
	if (home) rmSync(home, { recursive: true, force: true });
});

const setup = (): string => {
	home = mkdtempSync(join(os.tmpdir(), "provision-audit-"));
	mkdirSync(join(home, ".alate"));
	return home;
};

// Provisions one tracked rel: writes the file and records its fingerprint through the
// real formula, so every manifest fixture pins the production rules. `record` overrides
// the bytes the manifest fingerprints, matching alate, which records config.yml without
// its deployment blocks.
const provision = (rel: string, content: string, record?: string): void => {
	const p = join(home, `.${rel}`);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
	const manifestPath = join(home, ".alate", "installed.json");
	let manifest: Record<string, string> = {};
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		// first provision: the manifest does not exist yet
	}
	manifest[rel] = provisionFingerprint(rel, Buffer.from(record ?? content));
	writeFileSync(manifestPath, JSON.stringify(manifest));
};

const write = (rel: string, content: string): void => {
	const p = join(home, `.${rel}`);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
};

// Provisions one rule through sync.mjs's own record: writes the file into the rules
// dir and records its fingerprint in `.alate-installed.json`, the record the audit
// reads for rules (the install-user manifest holds no rule keys).
const provisionRule = (name: string, content: string): void => {
	const p = join(home, ".omp", "agent", "rules", name);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
	const recordPath = join(
		home,
		".omp",
		"agent",
		"rules",
		".alate-installed.json",
	);
	let record: Record<string, string> = {};
	try {
		record = JSON.parse(readFileSync(recordPath, "utf8"));
	} catch {
		// first provision: the record does not exist yet
	}
	record[name] = provisionFingerprint(name, Buffer.from(content));
	writeFileSync(recordPath, JSON.stringify(record, null, 2));
};

describe("provisionFingerprint", () => {
	test("normalizes CRLF to LF", () => {
		expect(provisionFingerprint("x/f.md", Buffer.from("a\r\nb\r\n"))).toBe(
			provisionFingerprint("x/f.md", Buffer.from("a\nb\n")),
		);
	});

	test("drops updatedAt keys in marketplaces.json only", () => {
		expect(
			provisionFingerprint(
				"omp/marketplaces.json",
				Buffer.from(JSON.stringify({ m: { url: "u", updatedAt: 42 } })),
			),
		).toBe(
			provisionFingerprint(
				"omp/marketplaces.json",
				Buffer.from(JSON.stringify({ m: { url: "u" } })),
			),
		);
		expect(
			provisionFingerprint(
				"x/other.json",
				Buffer.from(JSON.stringify({ updatedAt: 1 })),
			),
		).not.toBe(provisionFingerprint("x/other.json", Buffer.from("{}")));
	});

	test("unparsable marketplaces.json compares as raw text", () => {
		expect(
			provisionFingerprint("omp/marketplaces.json", Buffer.from("{oops")),
		).toBe(provisionFingerprint("omp/marketplaces.json", Buffer.from("{oops")));
		expect(
			provisionFingerprint("omp/marketplaces.json", Buffer.from("{oops")),
		).not.toBe(
			provisionFingerprint("omp/marketplaces.json", Buffer.from("{}")),
		);
	});
});

describe("auditProvisioned", () => {
	test("clean home -> []", () => {
		setup();
		provision("omp/agent/skills/x/SKILL.md", "# hi\n");
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("changed bytes -> changed", () => {
		setup();
		provision("omp/agent/skills/x/SKILL.md", "# hi\n");
		write("omp/agent/skills/x/SKILL.md", "# bye\n");
		expect(auditProvisioned(home)).toEqual([
			".omp/agent/skills/x/SKILL.md changed",
		]);
	});

	test("deleted file -> missing", () => {
		setup();
		provision("omp/agent/skills/x/SKILL.md", "# hi\n");
		rmSync(join(home, ".omp/agent/skills/x/SKILL.md"));
		expect(auditProvisioned(home)).toEqual([
			".omp/agent/skills/x/SKILL.md missing",
		]);
	});

	test("tracked rel pointing at a directory -> unreadable (EISDIR)", () => {
		setup();
		provision("omp/agent/skills/x/SKILL.md", "# hi\n");
		rmSync(join(home, ".omp/agent/skills/x/SKILL.md"));
		mkdirSync(join(home, ".omp/agent/skills/x/SKILL.md"));
		expect(auditProvisioned(home)).toEqual([
			".omp/agent/skills/x/SKILL.md unreadable",
		]);
	});

	test("machine state beside fully matching tracked files -> []", () => {
		setup();
		provision("omp/agent/config.yml", "model: x\n");
		provision("omp/agent/rules/a.md", "r\n");
		provision("agents/.skill-lock.json", "{}\n");
		write("agent.db", "state");
		write("agent.db-wal", "wal");
		mkdirSync(join(home, "sessions"));
		write("sessions/s1.json", "{}");
		mkdirSync(join(home, ".omp/agent/rules"), { recursive: true });
		write("omp/agent/rules/local-only.md", "local\n");
		write("omp/plugins/node_modules/pkg/index.js", "m");
		mkdirSync(join(home, ".cache"));
		write("cache/thing", "c");
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("config.yml with appended deployment blocks -> no drift; other change -> changed", () => {
		setup();
		provision(
			"omp/agent/config.yml",
			"model: x\nhindsight:\n  url: secret\n",
			"model: x\n",
		);
		expect(auditProvisioned(home)).toEqual([]);
		write("omp/agent/config.yml", "model: y\nhindsight:\n  url: secret\n");
		expect(auditProvisioned(home)).toEqual([".omp/agent/config.yml changed"]);
	});

	test("marketplaces.json with updatedAt stamped -> no drift", () => {
		setup();
		provision("omp/marketplaces.json", JSON.stringify({ m: { url: "u" } }));
		write(
			"omp/marketplaces.json",
			JSON.stringify({ m: { url: "u", updatedAt: 7 } }),
		);
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("CRLF file matching an LF-recorded fingerprint -> no drift", () => {
		setup();
		provision("omp/agent/skills/x/SKILL.md", "# hi\n");
		write("omp/agent/skills/x/SKILL.md", "# hi\r\n");
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("no manifest -> []", () => {
		setup();
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("corrupt manifest JSON -> []", () => {
		setup();
		writeFileSync(join(home, ".alate", "installed.json"), "{not json");
		expect(auditProvisioned(home)).toEqual([]);
	});

	test(".alate/current as plain file -> []", () => {
		setup();
		writeFileSync(join(home, ".alate", "current"), "layer");
		provision("omp/agent/skills/x/SKILL.md", "# hi\n");
		write("omp/agent/skills/x/SKILL.md", "# drift\n");
		expect(auditProvisioned(home)).toEqual([]);
	});

	test(".alate/current as dangling symlink -> []", () => {
		setup();
		symlinkSync(
			join(home, ".alate", "layers", "gone"),
			join(home, ".alate", "current"),
		);
		provision("omp/agent/skills/x/SKILL.md", "# hi\n");
		write("omp/agent/skills/x/SKILL.md", "# drift\n");
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("manifest mtime newer than sinceMs -> [], older -> findings", () => {
		setup();
		provision("omp/agent/skills/x/SKILL.md", "# hi\n");
		write("omp/agent/skills/x/SKILL.md", "# drift\n");
		utimesSync(
			join(home, ".alate", "installed.json"),
			new Date(3e15),
			new Date(3e15),
		);
		expect(auditProvisioned(home, 1e12)).toEqual([]);
		expect(auditProvisioned(home, 4e15)).toEqual([
			".omp/agent/skills/x/SKILL.md changed",
		]);
	});

	test("unsafe rel in manifest reads nothing outside home", () => {
		setup();
		const outside = join(home, "escape.txt");
		writeFileSync(outside, "secret\n");
		writeFileSync(
			join(home, ".alate", "installed.json"),
			JSON.stringify({
				"../escape.txt": provisionFingerprint(
					"../escape.txt",
					Buffer.from("secret\n"),
				),
			}),
		);
		expect(auditProvisioned(home)).toEqual([]);
		expect(readFileSync(outside, "utf8")).toBe("secret\n");
	});

	test("45 findings -> 41 lines ending with the more line", () => {
		setup();
		const expected: string[] = [];
		for (let i = 0; i < 45; i++) {
			const rel = `d${Math.floor(i / 10)}/f${i}.md`;
			provision(rel, "v1\n");
			write(rel, "v2\n");
			expected.push(`.${rel} changed`);
		}
		expect(auditProvisioned(home)).toEqual([
			...expected.slice(0, 40),
			"… +5 more",
		]);
	});

	test("multi-entry home keeps manifest order for tracked lines", () => {
		setup();
		provision("b/second.md", "1\n");
		provision("a/first.md", "1\n");
		write("b/second.md", "x\n");
		write("a/first.md", "x\n");
		expect(auditProvisioned(home)).toEqual([
			".b/second.md changed",
			".a/first.md changed",
		]);
	});

	test("a matching rules record audits clean", () => {
		setup();
		provisionRule("GUARDRAILS.md", "# rules\n");
		provisionRule("asd-ste100.md", "# ste\n");
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("an edited rule flags changed, a deleted one missing", () => {
		setup();
		provisionRule("guard.md", "# v1\n");
		provisionRule("gone.md", "# v1\n");
		write("omp/agent/rules/guard.md", "# v2\n");
		rmSync(join(home, ".omp", "agent", "rules", "gone.md"));
		expect(auditProvisioned(home)).toEqual([
			".omp/agent/rules/guard.md changed",
			".omp/agent/rules/gone.md missing",
		]);
	});

	test("a rule entry the run added flags untracked, sorted", () => {
		setup();
		provisionRule("real.md", "# real\n");
		const atStart = rulesDirEntries(home);
		write("omp/agent/rules/planted.md", "# planted\n");
		write("omp/agent/rules/sub/nested.md", "# nested\n");
		expect(auditProvisioned(home, undefined, atStart)).toEqual([
			".omp/agent/rules/planted.md untracked",
			".omp/agent/rules/sub untracked",
		]);
	});

	test("pre-existing unrecorded rules make no finding", () => {
		setup();
		provisionRule("real.md", "# real\n");
		// An older alate's leftovers: sync keeps them by design ("Not from the
		// data repo, left in place"), so they are deployment state, not drift.
		write("omp/agent/rules/demo-rules.md", "# demo\n");
		write("omp/agent/rules/example-rule.md", "# example\n");
		// Without a run-start capture the scan stays off, like the manifest audit.
		expect(auditProvisioned(home)).toEqual([]);
		// With one, the files predate the capture, so the run added nothing.
		const atStart = rulesDirEntries(home);
		expect(auditProvisioned(home, undefined, atStart)).toEqual([]);
	});

	test("a corrupt rules record skips the rules audit", () => {
		setup();
		write("omp/agent/rules/planted.md", "x\n");
		writeFileSync(
			join(home, ".omp", "agent", "rules", ".alate-installed.json"),
			"{oops",
		);
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("no rules record skips the rules audit", () => {
		setup();
		write("omp/agent/rules/plain.md", "# no record\n");
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("a rules record rewritten inside the run window skips rules findings", () => {
		setup();
		provisionRule("guard.md", "# v1\n");
		write("omp/agent/rules/guard.md", "# v2\n");
		utimesSync(
			join(home, ".omp", "agent", "rules", ".alate-installed.json"),
			new Date(3e15),
			new Date(3e15),
		);
		expect(auditProvisioned(home, 1e12)).toEqual([]);
		expect(auditProvisioned(home, 4e15)).toEqual([
			".omp/agent/rules/guard.md changed",
		]);
	});

	test("layer mode stays silent with a rules record present", () => {
		setup();
		provisionRule("guard.md", "# v1\n");
		write("omp/agent/rules/guard.md", "# drift\n");
		writeFileSync(join(home, ".alate", "current"), "layer");
		expect(auditProvisioned(home)).toEqual([]);
	});

	test("rules findings follow the manifest findings", () => {
		setup();
		provision("omp/agent/skills/x/SKILL.md", "# hi\n");
		provisionRule("guard.md", "# v1\n");
		write("omp/agent/skills/x/SKILL.md", "# drift\n");
		write("omp/agent/rules/guard.md", "# drift\n");
		expect(auditProvisioned(home)).toEqual([
			".omp/agent/skills/x/SKILL.md changed",
			".omp/agent/rules/guard.md changed",
		]);
	});
});

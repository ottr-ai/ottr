import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "ottr-entry.sh");

const root = mkdtempSync(join(tmpdir(), "ottr-entry-"));
afterAll(
	() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
	60_000,
);

/** Run the entry script with throwaway credential paths; `cmd` is the exec target. */
function run(env: Record<string, string>, cmd = "true") {
	return Bun.spawnSync(["sh", entry, cmd], {
		env: { PATH: process.env.PATH!, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("ottr-entry credential mounts", () => {
	test("a directory at OTTR_AGENT_DB refuses", () => {
		const dir = join(root, "db-dir");
		mkdirSync(dir);
		const r = run({ OTTR_AGENT_DB: dir });
		expect(r.exitCode).toBe(1);
		const err = r.stderr.toString();
		expect(err).toContain("OTTR_AGENT_DB");
		expect(err).toContain("Podman");
		expect(err).toContain("Troubleshooting");
	});

	test("an empty OTTR_OAUTH_DIR warns and boots", () => {
		const oauth = join(root, "oauth-empty");
		mkdirSync(oauth);
		writeFileSync(join(root, "agent.db"), "x");
		const r = run({ OTTR_AGENT_DB: join(root, "agent.db"), OTTR_OAUTH_DIR: oauth });
		expect(r.exitCode).toBe(0);
		const err = r.stderr.toString();
		expect(err).toContain("OTTR_OAUTH_DIR");
		expect(err).toContain(".keep");
	});

	test("a missing OTTR_OAUTH_DIR refuses", () => {
		writeFileSync(join(root, "agent.db"), "x");
		const r = run({
			OTTR_AGENT_DB: join(root, "agent.db"),
			OTTR_OAUTH_DIR: join(root, "oauth-missing"),
		});
		expect(r.exitCode).toBe(1);
		const err = r.stderr.toString();
		expect(err).toContain("OTTR_OAUTH_DIR");
		expect(err).toContain("refusing to start");
	});

	test("a real agent.db and a non-empty oauth dir boot", () => {
		const oauth = join(root, "oauth-ok");
		mkdirSync(oauth);
		writeFileSync(join(oauth, "creds.json"), "{}");
		const r = run({ OTTR_AGENT_DB: join(root, "agent.db"), OTTR_OAUTH_DIR: oauth });
		expect(r.exitCode).toBe(0);
		expect(r.stderr.toString()).toBe("");
	});
});

describe("ottr-entry pinned boot report", () => {
	test("logs the pinned values on a healthy boot", () => {
		const oauth = join(root, "pinned-ok");
		mkdirSync(oauth);
		writeFileSync(join(oauth, "creds.json"), "{}");
		writeFileSync(join(root, "pinned.db"), "x");
		const r = run({
			OTTR_PINNED_IMAGE: "ghcr.io/ottr-ai/ottr:v0.3.0",
			OTTR_PINNED_OAUTH_DIR: "/mnt/c/Users/me/.omp/oauth",
			OTTR_PINNED_AGENT_DB: "/mnt/c/Users/me/.omp/ottr-agent.db",
			OTTR_AGENT_DB: join(root, "pinned.db"),
			OTTR_OAUTH_DIR: oauth,
		});
		expect(r.exitCode).toBe(0);
		expect(r.stderr.toString()).toContain(
			"pinned: image=ghcr.io/ottr-ai/ottr:v0.3.0, oauth dir=/mnt/c/Users/me/.omp/oauth, agent db=/mnt/c/Users/me/.omp/ottr-agent.db",
		);
	});

	test("logs the pinned values before the agent.db refusal", () => {
		const dir = join(root, "pinned-refused");
		mkdirSync(dir);
		const r = run({
			OTTR_PINNED_IMAGE: "ghcr.io/ottr-ai/ottr:v0.3.0",
			OTTR_PINNED_OAUTH_DIR: "/mnt/c/Users/me/.omp/oauth",
			OTTR_PINNED_AGENT_DB: "/mnt/c/Users/me/.omp/ottr-agent.db",
			OTTR_AGENT_DB: dir,
		});
		expect(r.exitCode).toBe(1);
		const err = r.stderr.toString();
		const pinned = err.indexOf("pinned:");
		const refusal = err.indexOf("is not a regular file");
		expect(pinned).toBeGreaterThanOrEqual(0);
		expect(refusal).toBeGreaterThan(pinned);
	});

	test("no pinned values, no pinned line", () => {
		const oauth = join(root, "unpinned-ok");
		mkdirSync(oauth);
		writeFileSync(join(oauth, "creds.json"), "{}");
		writeFileSync(join(root, "unpinned.db"), "x");
		const r = run({
			OTTR_AGENT_DB: join(root, "unpinned.db"),
			OTTR_OAUTH_DIR: oauth,
		});
		expect(r.exitCode).toBe(0);
		expect(r.stderr.toString()).not.toContain("pinned:");
	});
});

describe("ottr-entry repair-agent-db", () => {
	test("removes an empty directory", () => {
		const dir = join(root, "repair-empty");
		mkdirSync(dir);
		const r = run({ OTTR_AGENT_DB: dir }, "repair-agent-db");
		expect(r.exitCode).toBe(0);
		expect(existsSync(dir)).toBe(false);
	});

	test("refuses a non-empty directory untouched", () => {
		const dir = join(root, "repair-nonempty");
		mkdirSync(dir);
		const inner = join(dir, "keep");
		writeFileSync(inner, "x");
		const r = run({ OTTR_AGENT_DB: dir }, "repair-agent-db");
		expect(r.exitCode).toBe(1);
		expect(existsSync(inner)).toBe(true);
	});

	test("leaves a regular file alone", () => {
		const file = join(root, "repair-file");
		writeFileSync(file, "db");
		const r = run({ OTTR_AGENT_DB: file }, "repair-agent-db");
		expect(r.exitCode).toBe(0);
		expect(existsSync(file)).toBe(true);
	});

	test("a missing path is nothing to do", () => {
		const missing = join(root, "repair-missing");
		const r = run({ OTTR_AGENT_DB: missing }, "repair-agent-db");
		expect(r.exitCode).toBe(0);
		expect(existsSync(missing)).toBe(false);
	});
});

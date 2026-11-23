import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./runner.ts";
import { runMergeGates } from "./worktree.ts";

const SECRET = "leak-".repeat(8);
const MASTER_KEY = "ab".repeat(32);

async function withSecret<T>(fn: () => Promise<T> | T): Promise<T> {
	const prev = process.env.OTTR_HOSTED_SECRET;
	const prevMaster = process.env.OTTR_SECRET_KEY;
	process.env.OTTR_HOSTED_SECRET = SECRET;
	process.env.OTTR_SECRET_KEY = MASTER_KEY;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.OTTR_HOSTED_SECRET;
		else process.env.OTTR_HOSTED_SECRET = prev;
		if (prevMaster === undefined) delete process.env.OTTR_SECRET_KEY;
		else process.env.OTTR_SECRET_KEY = prevMaster;
	}
}

function fixture(check: string, testBody: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ottr-secret-gates-"));
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "secret-fixture",
			type: "module",
			scripts: { check },
		}),
	);
	writeFileSync(
		join(dir, "probe.test.ts"),
		`import { test } from "bun:test";\ntest("probe", () => { ${testBody} });\n`,
	);
	return dir;
}

describe("server secrets never reach a child process", () => {
	test("childEnv (local agent and classic worker env) drops them from process.env", async () => {
		const env = await withSecret(() =>
			childEnv({
				board: {
					url: "http://127.0.0.1:1",
					token: "t",
					project: "p",
					taskId: "x",
				},
			}),
		);
		expect(env.OTTR_HOSTED_SECRET).toBeUndefined();
		expect(env.OTTR_SECRET_KEY).toBeUndefined();
		expect(env.OTTR_BOARD_TOKEN).toBe("t");
	});

	test("childEnv drops them from an explicit base env", () => {
		expect(
			childEnv({
				base: {
					PATH: "/bin",
					OTTR_HOSTED_SECRET: SECRET,
					OTTR_SECRET_KEY: MASTER_KEY,
				},
			}),
		).toEqual({ PATH: "/bin" });
	});

	test("the check gate does not see it", async () => {
		const dir = fixture(
			'echo "secret=$' + '{OTTR_HOSTED_SECRET:-absent}"; exit 1',
			"",
		);
		try {
			const r = await withSecret(() => runMergeGates(dir));
			expect(r.ok).toBe(false);
			expect(r.output).toContain("secret=absent");
			expect(r.output).not.toContain(SECRET);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the test gate does not see it", async () => {
		const dir = fixture(
			"exit 0",
			'throw new Error("secret=" + (process.env.OTTR_HOSTED_SECRET ?? "absent"));',
		);
		try {
			const r = await withSecret(() => runMergeGates(dir));
			expect(r.ok).toBe(false);
			expect(r.output).toContain("secret=absent");
			expect(r.output).not.toContain(SECRET);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const STRIPPED = [
		"OTTR_BOARD_URL",
		"OTTR_BOARD_TOKEN",
		"OTTR_PROJECT",
		"OTTR_TASK_ID",
		"OTTR_DATA_DIR",
		"OTTR_SERVER_DATA_DIR",
		"OTTR_BACKUP_DIR",
		"OTTR_DATABASE_URL",
		"OTTR_WORKER_URLS",
		"OTTR_WORKER_TOKEN",
		"ALATE_API_KEY",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GH_ENTERPRISE_TOKEN",
		"GITHUB_ENTERPRISE_TOKEN",
		"GIT_ASKPASS",
		"OTTR_GIT_TOKEN_1",
	];
	const PROXY_WITH_CREDS =
		"http://proxy-user:proxy-pass@corp-proxy.invalid:8080";

	test("the gates strip every server credential name", async () => {
		const prev = new Map<string, string | undefined>();
		const markers = new Map<string, string>();
		for (const name of STRIPPED) {
			prev.set(name, process.env[name]);
			const value = `leak-${name}`;
			markers.set(name, value);
			process.env[name] = value;
		}
		prev.set("HTTPS_PROXY", process.env.HTTPS_PROXY);
		process.env.HTTPS_PROXY = PROXY_WITH_CREDS;
		const echoes = [...STRIPPED, "HTTPS_PROXY"]
			.map((name) => `echo "${name}=\${${name}:-unset}"`)
			.join("; ");
		const dir = fixture(`${echoes}; exit 1`, "");
		try {
			const r = await withSecret(() => runMergeGates(dir));
			expect(r.ok).toBe(false);
			for (const name of STRIPPED) expect(r.output).toContain(`${name}=unset`);
			// The proxy URL keeps its host and loses its userinfo.
			expect(r.output).toContain("HTTPS_PROXY=http://corp-proxy.invalid:8080");
			for (const [, value] of markers) expect(r.output).not.toContain(value);
			expect(r.output).not.toContain(SECRET);
			expect(r.output).not.toContain(MASTER_KEY);
			expect(r.output).not.toContain("proxy-user:proxy-pass");
		} finally {
			for (const [name, value] of prev) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

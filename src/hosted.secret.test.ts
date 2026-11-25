import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
			'echo "secret=$' +
				"{OTTR_HOSTED_SECRET:-absent} master=$" +
				'{OTTR_SECRET_KEY:-absent}"; exit 1',
			"",
		);
		try {
			const r = await withSecret(() => runMergeGates(dir));
			expect(r.ok).toBe(false);
			expect(r.output).toContain("secret=absent master=absent");
			expect(r.output).not.toContain(SECRET);
			expect(r.output).not.toContain(MASTER_KEY);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the test gate does not see it", async () => {
		const dir = fixture(
			"exit 0",
			'throw new Error("secret=" + (process.env.OTTR_HOSTED_SECRET ?? "absent") + " master=" + (process.env.OTTR_SECRET_KEY ?? "absent"));',
		);
		try {
			const r = await withSecret(() => runMergeGates(dir));
			expect(r.ok).toBe(false);
			expect(r.output).toContain("secret=absent");
			expect(r.output).toContain("master=absent");
			expect(r.output).not.toContain(SECRET);
			expect(r.output).not.toContain(MASTER_KEY);
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
		"HINDSIGHT_TENANT_KEY",
	];
	const PROXY_WITH_CREDS =
		"http://proxy-user:proxy-pass@corp-proxy.invalid:8080";

	/** Sets a leak marker for every stripped name plus the proxy, then restores. */
	async function withGateMarkers<T>(fn: () => Promise<T>): Promise<T> {
		const prev = new Map<string, string | undefined>();
		for (const name of STRIPPED) {
			prev.set(name, process.env[name]);
			process.env[name] = `leak-${name}`;
		}
		prev.set("HTTPS_PROXY", process.env.HTTPS_PROXY);
		process.env.HTTPS_PROXY = PROXY_WITH_CREDS;
		try {
			return await fn();
		} finally {
			for (const [name, value] of prev) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}

	/** No leak marker value may appear anywhere in the child's output. */
	function expectNoMarkers(output: string): void {
		for (const name of STRIPPED) expect(output).not.toContain(`leak-${name}`);
		expect(output).not.toContain(SECRET);
		expect(output).not.toContain(MASTER_KEY);
		expect(output).not.toContain("proxy-user:proxy-pass");
	}

	test("the check gate strips every server credential name", async () => {
		const echoes = [...STRIPPED, "HTTPS_PROXY"]
			.map((name) => `echo "${name}=\${${name}:-unset}"`)
			.join("; ");
		const dir = fixture(`${echoes}; exit 1`, "");
		try {
			const r = await withGateMarkers(() =>
				withSecret(() => runMergeGates(dir)),
			);
			expect(r.ok).toBe(false);
			for (const name of STRIPPED) expect(r.output).toContain(`${name}=unset`);
			// The proxy URL keeps its host and loses its userinfo.
			expect(r.output).toContain("HTTPS_PROXY=http://corp-proxy.invalid:8080");
			expectNoMarkers(r.output);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the test gate strips every server credential name", async () => {
		const picks = [...STRIPPED, "HTTPS_PROXY"]
			.map((name) => `${name}: process.env.${name} ?? null`)
			.join(", ");
		const dir = fixture(
			"exit 0",
			`throw new Error("probe=" + JSON.stringify({ ${picks} }));`,
		);
		try {
			const r = await withGateMarkers(() =>
				withSecret(() => runMergeGates(dir)),
			);
			// The probe test always throws, so the ordered gate reaches bun test
			// and reports each name's set or unset state in the failure output.
			expect(r.ok).toBe(false);
			const m = r.output.match(/probe=(\{.*\})/);
			const seen = JSON.parse(m?.[1] ?? "null") as Record<
				string,
				string | null
			> | null;
			expect(seen).not.toBeNull();
			for (const name of STRIPPED) expect(seen?.[name]).toBeNull();
			expect(seen?.HTTPS_PROXY).toBe("http://corp-proxy.invalid:8080");
			expectNoMarkers(r.output);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.skipIf(process.platform !== "linux")(
		"the boot read: a child process cannot read the master key from /proc/<server>/environ",
		() => {
			const mod = new URL("./secretBox.ts", import.meta.url).pathname;
			const dir = mkdtempSync(join(tmpdir(), "ottr-master-key-boot-"));
			// The "server" loads its box, then a child (a repository check) reads the
			// server's startup env block, as any same-user process can.
			const script = `
				const { loadSecretBox } = await import(${JSON.stringify(mod)});
				const box = loadSecretBox({ dir: ${JSON.stringify(dir)} });
				const r = Bun.spawnSync(["cat", "/proc/" + process.pid + "/environ"]);
				const leaked = r.stdout.toString().includes(${JSON.stringify(MASTER_KEY)});
				console.log(JSON.stringify({ keyId: box.keyId, leaked, inEnv: "OTTR_SECRET_KEY" in process.env }));
			`;
			try {
				const r = Bun.spawnSync(["bun", "-e", script], {
					env: { ...process.env, OTTR_SECRET_KEY: MASTER_KEY },
				});
				expect(r.stderr.toString()).toBe("");
				expect(JSON.parse(r.stdout.toString())).toEqual({
					keyId: createHash("sha256")
						.update(Buffer.from(MASTER_KEY, "hex"))
						.digest("hex")
						.slice(0, 16),
					leaked: false,
					inEnv: false,
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

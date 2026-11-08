import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./runner.ts";
import { runMergeGates } from "./worktree.ts";

const SECRET = "leak-".repeat(8);

async function withSecret<T>(fn: () => Promise<T> | T): Promise<T> {
	const prev = process.env.OTTR_HOSTED_SECRET;
	process.env.OTTR_HOSTED_SECRET = SECRET;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.OTTR_HOSTED_SECRET;
		else process.env.OTTR_HOSTED_SECRET = prev;
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

describe("hosted secret never reaches a child process", () => {
	test("childEnv (local agent and classic worker env) drops it from process.env", async () => {
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
		expect(env.OTTR_BOARD_TOKEN).toBe("t");
	});

	test("childEnv drops it from an explicit base env", () => {
		expect(
			childEnv({ base: { PATH: "/bin", OTTR_HOSTED_SECRET: SECRET } }),
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
});

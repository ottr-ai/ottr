import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { Scenario, Trace } from "./readme-screenshot.fixture.ts";

const repo = join(import.meta.dir, "..");
const asset = join(repo, ".github", "assets", "screenshot.png");
const timeoutError =
	"readme-screenshot: the demo board did not become ready within 30 s\n";

type Result = {
	code: number;
	stdout: string;
	stderr: string;
	events: Trace[];
	root: string;
	inheritedRoot: string;
	inheritedState: string;
	output: string;
	boards: Extract<Trace, { kind: "board-spawn" }>[];
};

/** Roots run() created; the afterAll removes them after the tests have read their capture files. */
const roots: string[] = [];
afterAll(() => {
	for (const root of roots) {
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
});

async function run(
	scenario: Scenario,
	inheritedEnv: Record<string, string> = {},
): Promise<Result> {
	const root = mkdtempSync(join(tmpdir(), "readme-screenshot-test-"));
	roots.push(root);
	const inheritedRoot = join(root, "inherited-demo");
	const inheritedState = join(root, "inherited-state");
	const child = Bun.spawn(
		[
			process.execPath,
			"--preload",
			join(import.meta.dir, "readme-screenshot.fixture.ts"),
			join(import.meta.dir, "readme-screenshot.ts"),
		],
		{
			cwd: repo,
			env: {
				PATH: process.env.PATH,
				TMPDIR: root,
				OTTR_SCREENSHOT_CHROME: "fixture-chrome",
				OTTR_DEV_ROOT: inheritedRoot,
				OTTR_STATE_DIR: inheritedState,
				README_SHOT_FIXTURE_ROOT: root,
				README_SHOT_SCENARIO: JSON.stringify(scenario),
				...inheritedEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const events = readFileSync(join(root, "trace.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Trace);
	return {
		code,
		stdout,
		stderr,
		events,
		root,
		inheritedRoot,
		inheritedState,
		output: join(root, "capture.png"),
		boards: events.filter((event) => event.kind === "board-spawn"),
	};
}

function expectCapture(result: Result, port: string): void {
	expect(result.code).toBe(0);
	expect(result.stderr).toBe("");
	expect(
		result.events.filter(
			(event) => event.kind === "cdp" && event.method === "Page.navigate",
		),
	).toEqual([
		expect.objectContaining({ url: `http://127.0.0.1:${port}/#lumen` }),
	]);
	expect(
		result.events.filter(
			(event) =>
				event.kind === "cdp" && event.method === "Page.captureScreenshot",
		),
	).toHaveLength(1);
	expect(readFileSync(result.output)).toEqual(readFileSync(asset));
	expect(result.stdout).toContain("readme-screenshot: wrote");
}

function expectNoCapture(result: Result): void {
	expect(
		result.events.filter(
			(event) =>
				event.kind === "cdp" &&
				["Page.navigate", "Page.captureScreenshot"].includes(event.method),
		),
	).toEqual([]);
	expect(existsSync(result.output)).toBe(false);
	expect(result.stdout).not.toContain("readme-screenshot: wrote");
}

describe("readme screenshot board readiness", () => {
	test("a ready first board captures without a replacement", async () => {
		const result = await run({ readyAttempt: 1, failure: "reject" });
		expect(result.boards).toHaveLength(1);
		expectCapture(result, result.boards[0]!.port);
	});

	test("a host VM runner URL without a token cannot block either demo attempt", async () => {
		const result = await run(
			{ readyAttempt: 2, failure: "reject" },
			{ OTTR_VM_RUNNER_URL: "http://vm-runner.invalid:8787" },
		);
		expect(result.boards).toHaveLength(2);
		expectCapture(result, result.boards[1]!.port);
	});

	test("one timeout stops only the first board before a fresh replacement captures", async () => {
		const result = await run({ readyAttempt: 2, failure: "reject" });
		expect(result.code).toBe(0);
		expect(result.boards).toHaveLength(2);
		const [first, second] = result.boards;
		if (!first || !second) throw new Error("missing board attempts");
		const replacementIndex = result.events.indexOf(second);
		expect(
			result.events
				.slice(0, replacementIndex)
				.filter((event) => event.kind === "stop"),
		).toEqual([expect.objectContaining({ child: "board", attempt: 1 })]);
		expect(first.port).not.toBe(second.port);
		const paths = [
			first.devRoot,
			first.stateDir,
			second.devRoot,
			second.stateDir,
		];
		expect(first.devRoot).not.toBe(second.devRoot);
		expect(first.stateDir).not.toBe(second.stateDir);
		for (const path of paths) {
			expect(typeof path).toBe("string");
			if (!path) throw new Error("missing isolated board directory");
			expect(isAbsolute(path)).toBe(true);
			expect(relative(result.root, path).startsWith("..")).toBe(false);
			expect(path).not.toBe(result.inheritedRoot);
			expect(path).not.toBe(result.inheritedState);
		}
		expectCapture(result, second.port);
		const stops = result.events.filter((event) => event.kind === "stop");
		expect(stops).toHaveLength(3);
		expect(stops).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ child: "board", attempt: 1 }),
				expect.objectContaining({ child: "chrome" }),
				expect.objectContaining({ child: "board", attempt: 2 }),
			]),
		);
	});

	for (const failure of ["reject", "non-2xx", "slow-body"] as const) {
		test(`${failure} request time counts toward both 30 s readiness budgets`, async () => {
			const result = await run({ readyAttempt: null, failure });
			expect(result.code).toBe(1);
			expect(result.stderr).toBe(timeoutError);
			expect(result.boards).toHaveLength(2);
			for (const board of result.boards) {
				const stop = result.events.find(
					(event) =>
						event.kind === "stop" &&
						event.child === "board" &&
						event.attempt === board.attempt,
				);
				expect(stop).toBeDefined();
				const duration = (stop?.at ?? 0) - board.at;
				expect(duration).toBe(30_000);
			}
			expectNoCapture(result);
		});
	}

	test("an early board exit fails without a replacement", async () => {
		const result = await run({
			readyAttempt: null,
			failure: "reject",
			earlyExit: true,
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toBe(
			"readme-screenshot: the demo board exited early\n",
		);
		expect(result.boards).toHaveLength(1);
		expectNoCapture(result);
	});
});

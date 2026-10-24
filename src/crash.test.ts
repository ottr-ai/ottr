import { expect, test } from "bun:test";
import { logError } from "./crash.ts";

// The net's observable behavior is process survival: these run it in real child processes,
// because registering it in this test process would swallow bun test's own crash reporting.
// Runtime-selected specifier (path passed to the child via env): a static import cannot
// target the parent's file URL from inside `bun -e`.
const mod = new URL("./crash.ts", import.meta.url).href;
const run = (script: string) =>
	Bun.spawnSync([process.execPath, "-e", script], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, TRAP_MOD: mod },
	});

// Real timers on purpose: fake timers cannot drive a child process, and the behavior under test
// is that Bun re-fires an interval on the platform clock after a tick threw under the net.
test("a timer that throws logs and the process keeps running", () => {
	const p = run(`
		const { trapCrashes } = await import(process.env.TRAP_MOD);
		trapCrashes();
		trapCrashes(); // repeat call must not double-register
		let n = 0;
		const t = setInterval(() => {
			n++;
			if (n === 1) throw new Error("boom");
			if (n >= 3) { console.log("SURVIVED " + n); clearInterval(t); }
		}, 50);
	`);
	expect(p.exitCode).toBe(0);
	expect(p.stdout.toString()).toContain("SURVIVED 3");
	expect(p.stderr.toString().split("uncaught").length - 1).toBe(1);
	expect(p.stderr.toString()).toContain("boom");
});

test("an unhandled rejection logs and the process keeps running", () => {
	const p = run(`
		const { trapCrashes } = await import(process.env.TRAP_MOD);
		trapCrashes();
		Promise.reject(new Error("boom2"));
		queueMicrotask(() => console.log("SURVIVED"));
	`);
	expect(p.exitCode).toBe(0);
	expect(p.stdout.toString()).toContain("SURVIVED");
	expect(p.stderr.toString()).toContain("unhandled rejection");
	expect(p.stderr.toString()).toContain("boom2");
});

test("logError includes scope, message and stack; passes through non-Errors", () => {
	const seen: unknown[][] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => seen.push(args);
	try {
		logError("api GET /x", new Error("e1"));
		logError("push", "plain");
	} finally {
		console.error = orig;
	}
	const [scope1, err1] = seen[0] as [string, string];
	expect(scope1).toContain("api GET /x");
	expect(scope1).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
	expect(err1).toContain("e1");
	expect(err1).toContain("\n"); // stack frames, not just the one-line message
	const [scope2, err2] = seen[1] as [string, string];
	expect(scope2).toContain("push");
	expect(err2).toBe("plain");
});

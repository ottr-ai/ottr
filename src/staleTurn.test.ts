import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUSY_MIN_TICKS,
	busyDescendant,
	cardNumOf,
	diagnoseStale,
	extractInlinePids,
	extractLockPaths,
	extractPidPaths,
	extractPorts,
	isStaleAskReason,
	type KillExpect,
	type LastTool,
	type LockFact,
	lastToolCall,
	lockFacts,
	lockPathAllowed,
	newestSessionAt,
	normalizeCmd,
	type ProcSample,
	parseLockPid,
	parsePidFile,
	pidFileFacts,
	portListeners,
	readTree,
	STALE_ASK_MARKER,
	STALE_FIX_PENDING_STEER,
	STALE_IDLE_MS,
	STALE_OPTIONS,
	STALE_REASK_MS,
	type StaleProbe,
	staleAnswerKind,
	staleAskQuestion,
	staleAskReason,
	staleKillLocal,
	staleSteerText,
	staleUnlockLocal,
	tickMap,
} from "./staleTurn.ts";
import fc from "./test/properties.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-stale-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

// ---- fixtures ----------------------------------------------------------------

/** Realistic /proc/<pid>/stat: pid (comm) state ppid pgrp session tty tpgid flags
 * minflt cminflt majflt cmajflt utime stime cutime cstime <padding to ~50 fields>. */
function statText(
	pid: number,
	ppid: number,
	t: [number, number, number, number],
	comm: string,
): string {
	const head = [
		String(pid),
		comm,
		"S",
		String(ppid),
		String(pid),
		String(pid),
		"0",
		"-1",
		"4194304",
		"0",
		"0",
		"0",
		"0",
	];
	const tail = Array.from({ length: 34 }, () => "0");
	return [
		...head,
		String(t[0]),
		String(t[1]),
		String(t[2]),
		String(t[3]),
		...tail,
	].join(" ");
}

// Fake proc tree: 1 ← 329 ← {5229 ← 6000, 800, 900}; 555 and 601 exited (no/garbage
// stat), 77 sits outside the 329 tree, 329's comm holds parens like a real omp argv.
const procDir = join(root, "proc");
function fakeProc(
	pid: number,
	opts: {
		ppid: number;
		ticks: [number, number, number, number];
		comm?: string;
		cmdline?: string;
	},
): void {
	const dir = join(procDir, String(pid));
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "stat"),
		statText(pid, opts.ppid, opts.ticks, opts.comm ?? `(p${pid})`),
	);
	if (opts.cmdline !== undefined)
		writeFileSync(join(dir, "cmdline"), opts.cmdline);
}
fakeProc(1, { ppid: 0, ticks: [1, 2, 3, 4] });
fakeProc(329, {
	ppid: 1,
	ticks: [10, 20, 30, 40],
	comm: "(omp (worker))",
	cmdline: "node\0omp.ts\0",
});
fakeProc(5229, {
	ppid: 329,
	ticks: [0, 5, 0, 0],
	cmdline: "bun\0stryker.ts\0--watch",
});
fakeProc(800, { ppid: 329, ticks: [7, 0, 0, 0] }); // no cmdline file → ""
fakeProc(6000, { ppid: 5229, ticks: [7, 0, 0, 0], cmdline: "sleep\x00600" });
fakeProc(900, {
	ppid: 329,
	ticks: [0, 0, 0, 0],
	cmdline: `x\0${"a".repeat(400)}`,
});
fakeProc(77, { ppid: 1, ticks: [9, 9, 9, 9] }); // outside the 329 tree
mkdirSync(join(procDir, "555"), { recursive: true }); // exited: no stat at all
mkdirSync(join(procDir, "601"), { recursive: true }); // exited: garbage stat
writeFileSync(join(procDir, "601", "stat"), "601 (bad) S");
mkdirSync(join(procDir, "acpi"), { recursive: true }); // non-pid dir name

// OTTR-1191 shape: omp 329 alive, shell 5300 looping on a lock that names dead 5229.
const wt = "/srv/board/OTTR-1191";
const lockPath = "/var/tmp/gate-1191/tmp/ott-stryker.lock";
const loopCmd =
	"while [ ! -f /var/tmp/gate-1191/tmp/ott-stryker.lock ]; do sleep 600; done";
const procs1191: ProcSample[] = [
	{ pid: 329, ppid: 1, ticks: 100, command: "node omp.ts" },
	{
		pid: 5300,
		ppid: 329,
		ticks: 3,
		command: `bash -c ${loopCmd}`,
	},
];
const prev1191 = new Map([
	[329, 100],
	[5300, 3],
]);

// The same fake tree also carries /proc/net tables in the kernel's hex layout:
// 0x1F90 = 8080, 0x0016 = 22. tcp holds one LISTEN 8080, one ESTABLISHED (state 01)
// 8080, and one LISTEN 22; tcp6 holds one LISTEN 8080 — so the kill path can re-check
// a port dependency against the same procRoot it walks for the process tree.
mkdirSync(join(procDir, "net"), { recursive: true });
const NET_HEADER =
	"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const TCP_TABLE = [
	NET_HEADER,
	"   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 ffff8800abc 100 0 0 10 0",
	"   1: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 12346 2 ffff8800abc 100 0 0 10 0",
	"   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12347 1 ffff8800abc 100 0 0 10 0",
	"",
].join("\n");
const TCP6_TABLE = [
	NET_HEADER,
	"   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12348 1 ffff8800abc 100 0 0 10 0",
	"",
].join("\n");
writeFileSync(join(procDir, "net", "tcp"), TCP_TABLE);
writeFileSync(join(procDir, "net", "tcp6"), TCP6_TABLE);

const probe1191 = (
	locks: LockFact[],
	lastTool: StaleProbe["lastTool"],
	more: Partial<StaleProbe> = {},
): StaleProbe => ({
	pid: 329,
	alive: true,
	procs: procs1191,
	sessionAt: 1000,
	lastTool,
	locks,
	pidFiles: [],
	pids: [],
	ports: [],
	...more,
});

// ---- constants ----------------------------------------------------------------

test("named constants hold the spec values", () => {
	expect(STALE_IDLE_MS).toBe(30 * 60_000);
	expect(BUSY_MIN_TICKS).toBe(5);
	expect(STALE_REASK_MS).toBe(4 * 60 * 60_000);
	expect(STALE_ASK_MARKER).toBe("Stuck turn:");
	expect(STALE_OPTIONS).toEqual([
		"Apply the fix",
		"Stop the turn and restart",
		"Wait",
	]);
	expect(STALE_FIX_PENDING_STEER).toBe(
		"Supervisor: the card owner approved the stale-turn fix. The next supervisor tick re-diagnoses the card and applies the allowlisted fix (stale lock removal or hung child stop) with the facts in a follow-up steer.",
	);
});

// ---- parseLockPid ----------------------------------------------------------------

describe("parseLockPid", () => {
	test("accepts the lock shape and tolerates extra keys", () => {
		expect(parseLockPid('{"pid":5229}')).toBe(5229);
		expect(parseLockPid('{"pid":5229,"host":"worker-b"}')).toBe(5229);
		expect(parseLockPid('{"pid":1}')).toBe(1);
	});

	test("refuses everything that is not a positive safe integer pid", () => {
		expect(parseLockPid('{"pid":0}')).toBeNull();
		expect(parseLockPid('{"pid":-5}')).toBeNull();
		expect(parseLockPid('{"pid":1.5}')).toBeNull();
		expect(parseLockPid('{"pid":"5"}')).toBeNull();
		expect(parseLockPid('{"pid":null}')).toBeNull();
		expect(parseLockPid('{"pid":9007199254740992}')).toBeNull(); // 2^53, unsafe
		expect(parseLockPid("not json")).toBeNull();
		expect(parseLockPid("")).toBeNull();
		expect(parseLockPid("null")).toBeNull();
		expect(parseLockPid("[]")).toBeNull();
		expect(parseLockPid('"5"')).toBeNull();
		expect(parseLockPid('{"pid":5')).toBeNull(); // truncated write
	});

	test("property: never throws, result is null or the embedded positive safe integer", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (n) => {
				expect(parseLockPid(JSON.stringify({ pid: n }))).toBe(n);
			}),
		);
		fc.assert(
			fc.property(fc.string(), (s) => {
				const r = parseLockPid(s);
				if (r !== null) expect(r > 0 && Number.isSafeInteger(r)).toBe(true);
			}),
		);
	});
});

// ---- cardNumOf ----------------------------------------------------------------

describe("cardNumOf", () => {
	test("trailing digit run of the basename", () => {
		expect(cardNumOf("OTTR-1191")).toBe("1191");
		expect(cardNumOf("1234")).toBe("1234");
		expect(cardNumOf("gate-1191")).toBe("1191");
		expect(cardNumOf("main")).toBeNull();
		expect(cardNumOf("1191a")).toBeNull();
		expect(cardNumOf("x9y")).toBeNull();
		expect(cardNumOf("")).toBeNull();
	});
});

// ---- lockPathAllowed ----------------------------------------------------------------

describe("lockPathAllowed", () => {
	const wt = "/srv/board/OTTR-1191";
	test("the card's own worktree needs no card number", () => {
		expect(lockPathAllowed(wt, wt, null)).toBe(true);
		expect(lockPathAllowed(`${wt}/a.lock`, wt, null)).toBe(true);
		expect(lockPathAllowed(`${wt}-2/a.lock`, wt, "1191")).toBe(false); // prefix + "/"
		expect(lockPathAllowed("/srv/board/OTTR-1192/a.lock", wt, "1191")).toBe(
			false,
		);
	});

	test("temp roots need the card number as a segment token", () => {
		expect(
			lockPathAllowed("/tmp/gate-1191/tmp/ott-stryker.lock", wt, "1191"),
		).toBe(true);
		expect(
			lockPathAllowed("/var/tmp/gate-1191/tmp/ott-stryker.lock", wt, "1191"),
		).toBe(true);
		expect(lockPathAllowed("/var/tmp/gate_1191/x.lock", wt, "1191")).toBe(true);
		expect(lockPathAllowed("/var/tmp/1191.lock", wt, "1191")).toBe(true);
	});

	test("near-miss segments never match", () => {
		expect(lockPathAllowed("/var/tmp/gate-11912/x.lock", wt, "1191")).toBe(
			false,
		);
		expect(lockPathAllowed("/var/tmp/gate-1244/x.lock", wt, "1191")).toBe(
			false,
		);
		expect(lockPathAllowed("/var/tmp/1191x/x.lock", wt, "1191")).toBe(false);
		expect(lockPathAllowed("/var/tmp/x1191/x.lock", wt, "1191")).toBe(false);
	});

	test("no card number, wrong roots, and relative paths refuse", () => {
		expect(lockPathAllowed("/tmp/gate-1191/x.lock", wt, null)).toBe(false);
		expect(lockPathAllowed("./x.lock", wt, "1191")).toBe(false);
		expect(lockPathAllowed("/tmpx/gate-1191/x.lock", wt, "1191")).toBe(false);
		expect(lockPathAllowed("/var/tmp/gate-1191/x.lock", wt, null)).toBe(false); // card number is required for the temp-root branch
		expect(lockPathAllowed("/etc/keeper.lock", wt, "1191")).toBe(false);
	});
});

// ---- extractLockPaths ----------------------------------------------------------------

describe("extractLockPaths", () => {
	test("dedupes, preserves order, ignores non-lock paths", () => {
		expect(
			extractLockPaths("flock /a/b.lock && cat /a/b.lock ./c.lock"),
		).toEqual(["/a/b.lock", "./c.lock"]);
		expect(
			extractLockPaths("/var/log/x.txt ./partial.locky dir/named.lock"),
		).toEqual([]);
		expect(extractLockPaths("")).toEqual([]);
	});

	test("shell punctuation never glues onto the path", () => {
		expect(extractLockPaths(`[ ! -f ${lockPath} ]`)).toEqual([lockPath]);
		expect(extractLockPaths('"${DIR}/q.lock"')).toEqual(["/q.lock"]);
	});

	test("caps at 5 paths, each at 300 chars", () => {
		const seven = [1, 2, 3, 4, 5, 6, 7].map((i) => `/t/f${i}.lock`).join(" ");
		expect(extractLockPaths(seven)).toHaveLength(5);
		const exact = `./${"a".repeat(293)}.lock`; // 300 chars, ends .lock
		expect(extractLockPaths(exact)).toEqual([exact]);
		const over = `./${"a".repeat(294)}.lock`; // 301 chars, cap cuts the .lock tail
		expect(extractLockPaths(over)).toEqual([]);
	});

	test("property: candidates are deduped, capped, path-shaped lock names", () => {
		fc.assert(
			fc.property(fc.string(), (s) => {
				const paths = extractLockPaths(s);
				expect(paths.length).toBeLessThanOrEqual(5);
				expect(new Set(paths).size).toBe(paths.length);
				for (const p of paths) {
					expect(p.length).toBeLessThanOrEqual(300);
					expect(p.startsWith("/") || p.startsWith("./")).toBe(true);
					expect(p.slice(p.lastIndexOf("/") + 1).endsWith(".lock")).toBe(true);
				}
			}),
		);
	});
});

// ---- parsePidFile ----------------------------------------------------------------

describe("parsePidFile", () => {
	test("accepts the JSON lock form and a bare trimmed integer line", () => {
		expect(parsePidFile('{"pid":5229}')).toBe(5229);
		expect(parsePidFile("5229")).toBe(5229);
		expect(parsePidFile("5229\n")).toBe(5229);
		expect(parsePidFile("  8080  ")).toBe(8080);
	});

	test("refuses junk and non-pid integers", () => {
		expect(parsePidFile("pid: 5229")).toBeNull();
		expect(parsePidFile("")).toBeNull();
		expect(parsePidFile("0")).toBeNull();
		expect(parsePidFile("-5")).toBeNull();
		expect(parsePidFile("12.5")).toBeNull();
		expect(parsePidFile("abc")).toBeNull();
	});
});

// ---- extractPidPaths ----------------------------------------------------------------

describe("extractPidPaths", () => {
	test("path-like .pid tokens in order, deduped, non-pid ignored", () => {
		expect(
			extractPidPaths(
				"tail -f /var/run/app.pid && cat /var/run/app.pid ./y.pid",
			),
		).toEqual(["/var/run/app.pid", "./y.pid"]);
		expect(extractPidPaths("x.pids /a/b.pidtxt dir/named.pidfile")).toEqual([]);
		expect(extractPidPaths("")).toEqual([]);
	});

	test("caps at 5 paths, each at 300 chars", () => {
		const seven = [1, 2, 3, 4, 5, 6, 7].map((i) => `/t/f${i}.pid`).join(" ");
		expect(extractPidPaths(seven)).toHaveLength(5);
	});
});

// ---- extractInlinePids ----------------------------------------------------------------

describe("extractInlinePids", () => {
	test("each reference shape", () => {
		expect(extractInlinePids("--pid 123")).toEqual([{ pid: 123 }]);
		expect(extractInlinePids("--pid=123")).toEqual([{ pid: 123 }]);
		expect(extractInlinePids("kill 123")).toEqual([{ pid: 123 }]);
		expect(extractInlinePids("kill -0 123")).toEqual([{ pid: 123 }]);
		expect(extractInlinePids("wait 123")).toEqual([{ pid: 123 }]);
	});

	test("dedupes across patterns and never a watcher loop's sleep seconds", () => {
		expect(extractInlinePids("kill 123 --pid 123")).toEqual([{ pid: 123 }]);
		expect(extractInlinePids("while kill -0 5229; do sleep 600; done")).toEqual(
			[{ pid: 5229 }],
		);
	});

	test("pid 1 excluded, >7 digits unmatched, cap 5", () => {
		expect(extractInlinePids("kill 1")).toEqual([]);
		expect(extractInlinePids("--pid 12345678")).toEqual([]);
		const eight = [11, 22, 33, 44, 55, 66, 77, 88]
			.map((p) => `kill ${p}`)
			.join("; ");
		expect(extractInlinePids(eight)).toHaveLength(5);
	});
});

// ---- extractPorts ----------------------------------------------------------------

describe("extractPorts", () => {
	test("each reference shape", () => {
		for (const text of [
			"--port 3000",
			"--port=3000",
			"nc -z host 3000",
			"curl localhost:3000",
			"curl 127.0.0.1:3000",
			"curl 0.0.0.0:3000",
			"PORT=3000 ./serve",
		])
			expect(extractPorts(text)).toEqual([{ port: 3000 }]);
	});

	test("range filter, dedupe across patterns, cap 5", () => {
		expect(extractPorts("--port 0")).toEqual([]);
		expect(extractPorts("--port 99999")).toEqual([]);
		expect(extractPorts("--port 65535")).toEqual([{ port: 65535 }]);
		expect(extractPorts("--port 3000 curl localhost:3000")).toEqual([
			{ port: 3000 },
		]);
		const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9]
			.map((p) => `--port ${p}`)
			.join(" ");
		expect(extractPorts(nine)).toHaveLength(5);
	});
});

// ---- normalizeCmd ----------------------------------------------------------------

describe("normalizeCmd", () => {
	test("collapses whitespace runs and trims, caps at 300", () => {
		expect(normalizeCmd("  a   b\nc\t ")).toBe("a b c");
		expect(normalizeCmd(`x ${"a".repeat(400)}`)).toHaveLength(300);
	});
});

// ---- portListeners ----------------------------------------------------------------

describe("portListeners", () => {
	test("counts LISTEN entries for the port across tcp and tcp6", () => {
		expect(portListeners(8080, procDir)).toBe(2); // tcp LISTEN + tcp6 LISTEN
		expect(portListeners(22, procDir)).toBe(1); // the ESTABLISHED 8080 line never counts
		expect(portListeners(9999, procDir)).toBe(0);
		expect(portListeners(4444, procDir)).toBe(0);
	});

	test("an unreadable table is never a zero", () => {
		expect(portListeners(8080, join(root, "no-proc-root"))).toBeNull();
	});
});

// ---- lastToolCall ----------------------------------------------------------------

describe("lastToolCall", () => {
	test("last tool_execution_start wins, bad lines are skipped", () => {
		const session = [
			'{"type":"system","x":1}',
			"not json at all {",
			'{"type":"tool_execution_start","toolName":"read","arguments":{"command":"cat f.txt","timeout":5000}}',
			"",
			'{"type":"tool_execution_start","toolName":"bash","arguments":{"command":"sleep 600","timeout":0}}',
			'{"type":"tool_execution_end"}',
		].join("\n");
		expect(lastToolCall(session)).toEqual({
			tool: "bash",
			command: "sleep 600",
			timeout: 0,
		});
	});

	test("alternate arg and tool key spellings", () => {
		expect(
			lastToolCall(
				'{"type":"tool_execution_start","tool":"grep","args":{"command":"grep -r x","timeout":30}}',
			),
		).toEqual({ tool: "grep", command: "grep -r x", timeout: 30 });
		expect(
			lastToolCall(
				'{"type":"tool_execution_start","toolName":"bash","input":{"Command":"ls"}}',
			),
		).toEqual({ tool: "bash", command: "ls", timeout: null });
		expect(
			lastToolCall(
				'{"type":"tool_execution_start","toolName":"bash","arguments":"garbage"}',
			),
		).toEqual({ tool: "bash", command: "", timeout: null });
	});

	test("no match, empty text", () => {
		expect(lastToolCall('{"type":"system"}')).toBeNull();
		expect(lastToolCall("")).toBeNull();
	});
});

// ---- tickMap / busyDescendant ----------------------------------------------------------------

describe("tickMap and busyDescendant", () => {
	const procs: ProcSample[] = [
		{ pid: 10, ppid: 1, ticks: 100, command: "omp" },
		{ pid: 20, ppid: 10, ticks: 105, command: "bash -c loop" },
		{ pid: 30, ppid: 10, ticks: 102, command: "sleep" },
		{ pid: 40, ppid: 20, ticks: 130, command: "grand" },
	];
	const prev = new Map([
		[10, 100],
		[20, 100],
		[30, 102],
		[40, 20],
	]);

	test("tickMap is pid → ticks", () => {
		expect(tickMap(procs)).toEqual(
			new Map([
				[10, 100],
				[20, 105],
				[30, 102],
				[40, 130],
			]),
		);
	});

	test("shallowest busy descendant wins, root never counts", () => {
		expect(busyDescendant(prev, procs, 10)).toBe(20);
		expect(busyDescendant(prev, procs, 20)).toBe(40);
		const rootOnly: ProcSample[] = [
			{ pid: 10, ppid: 1, ticks: 200, command: "omp" },
		];
		expect(busyDescendant(new Map([[10, 100]]), rootOnly, 10)).toBeNull();
	});

	test("delta threshold and unknown baselines read as idle", () => {
		const slow = new Map([
			[10, 100],
			[20, 101], // delta 4 < 5
			[30, 102],
			[40, 130], // delta 0
		]);
		expect(busyDescendant(slow, procs, 10)).toBeNull();
		expect(busyDescendant(new Map([[10, 100]]), procs, 10)).toBeNull(); // pids absent from baseline
		expect(busyDescendant(null, procs, 10)).toBeNull(); // first probe
		expect(busyDescendant(prev, procs, null)).toBeNull(); // dead run pid
		expect(busyDescendant(prev, [], 10)).toBeNull();
	});
});

// ---- diagnoseStale ----------------------------------------------------------------

describe("diagnoseStale", () => {
	const pidPath = "/var/tmp/gate-1191/tmp/ott-stryker.pid";
	test("OTTR-1191: one allowed dead-pid lock → stale-lock", () => {
		const fix = diagnoseStale({
			probe: probe1191(
				[{ path: lockPath, exists: true, pid: 5229, alive: false }],
				{ tool: "bash", command: loopCmd, timeout: 0 },
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix).toEqual({
			kind: "stale-lock",
			path: lockPath,
			pid: 5229,
			expect: { sessionCommand: loopCmd },
		});
	});

	test("live pid in the lock → unsure, no fix", () => {
		const fix = diagnoseStale({
			probe: probe1191(
				[{ path: lockPath, exists: true, pid: 5300, alive: true }],
				{ tool: "bash", command: loopCmd, timeout: 0 },
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix.kind).toBe("unsure");
		if (fix.kind === "unsure")
			expect(fix.reason).toContain("names live pid 5300");
	});

	test("another card's lock or a path outside the dirs → unsure, confinement", () => {
		for (const path of [
			"/var/tmp/gate-1244/tmp/ott-stryker.lock", // injection: names another card
			"/opt/keeper.lock",
		]) {
			const fix = diagnoseStale({
				probe: probe1191([{ path, exists: true, pid: 5229, alive: false }], {
					tool: "bash",
					command: loopCmd,
					timeout: 0,
				}),
				worktree: wt,
				prevTicks: prev1191,
			});
			expect(fix.kind).toBe("unsure");
			if (fix.kind === "unsure")
				expect(fix.reason).toBe(
					`waits on ${path} naming dead pid 5229 outside the card's own dirs`,
				);
		}
	});

	test("blocker 4: a foreign dead lock never falls through to the kill", () => {
		const foreign = "/var/tmp/gate-1244/tmp/ott-stryker.lock";
		const fix = diagnoseStale({
			probe: probe1191(
				[{ path: foreign, exists: true, pid: 5229, alive: false }],
				{
					tool: "bash",
					command: loopCmd,
					timeout: 0,
				},
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		// The matching idle timeout-0 child exists, but the ask wins, not the kill.
		expect(fix.kind).toBe("unsure");
		if (fix.kind === "unsure")
			expect(fix.reason).toContain("outside the card's own dirs");
	});

	test("several allowed dead locks → unsure, refuses to guess", () => {
		const fix = diagnoseStale({
			probe: probe1191(
				[
					{ path: lockPath, exists: true, pid: 5229, alive: false },
					{
						path: "/tmp/gate-1191/other.lock",
						exists: true,
						pid: 5228,
						alive: false,
					},
				],
				{ tool: "bash", command: loopCmd, timeout: 0 },
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix.kind).toBe("unsure");
		if (fix.kind === "unsure")
			expect(fix.reason).toContain("several stale lock candidates");
	});

	test("exactly one allowed dead lock wins even when another lock is live", () => {
		const fix = diagnoseStale({
			probe: probe1191(
				[
					{ path: lockPath, exists: true, pid: 5229, alive: false },
					{
						path: "/tmp/gate-1191/second.lock",
						exists: true,
						pid: 5300,
						alive: true,
					},
				],
				{ tool: "bash", command: loopCmd, timeout: 0 },
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix).toEqual({
			kind: "stale-lock",
			path: lockPath,
			pid: 5229,
			expect: { sessionCommand: loopCmd },
		});
	});

	test("hung child: allowed dead pid file + matching idle shell → pidfile dep", () => {
		const fix = diagnoseStale({
			probe: probe1191(
				[],
				{ tool: "bash", command: loopCmd, timeout: 0 },
				{
					pidFiles: [{ path: pidPath, exists: true, pid: 5229, alive: false }],
				},
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix).toEqual({
			kind: "hung-child",
			pid: 5300,
			command: `bash -c ${loopCmd}`,
			expect: {
				sessionCommand: loopCmd,
				ticks: 3,
				dep: { kind: "pidfile", path: pidPath, pid: 5229 },
			},
		});
	});

	test("blocker 3: idle timeout-0 sleep with no dependency asks, never kills", () => {
		const fix = diagnoseStale({
			probe: probe1191(
				[],
				{ tool: "bash", command: "sleep 30", timeout: 0 },
				{
					procs: [
						{ pid: 329, ppid: 1, ticks: 100, command: "node omp.ts" },
						{ pid: 5300, ppid: 329, ticks: 3, command: "sleep 30" },
					],
				},
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix.kind).toBe("unsure");
		if (fix.kind === "unsure")
			expect(fix.reason).toBe(
				"idle timeout-0 child 5300 (sleep 30) has no dead dependency; approving a stop needs the owner",
			);
	});

	test("dead inline pid → hung-child with inline dep", () => {
		const inlineCmd = "while kill -0 5229; do sleep 600; done";
		const fix = diagnoseStale({
			probe: probe1191(
				[],
				{ tool: "bash", command: inlineCmd, timeout: 0 },
				{
					procs: [
						{ pid: 329, ppid: 1, ticks: 100, command: "node omp.ts" },
						{ pid: 5300, ppid: 329, ticks: 3, command: `bash -c ${inlineCmd}` },
					],
					pids: [{ pid: 5229, alive: false }],
				},
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix).toEqual({
			kind: "hung-child",
			pid: 5300,
			command: `bash -c ${inlineCmd}`,
			expect: {
				sessionCommand: inlineCmd,
				ticks: 3,
				dep: { kind: "inline", pid: 5229 },
			},
		});
	});

	test("port named with zero listeners → hung-child with port dep", () => {
		const portCmd = "while ! nc -z localhost 8080; do sleep 600; done";
		const fix = diagnoseStale({
			probe: probe1191(
				[],
				{ tool: "bash", command: portCmd, timeout: 0 },
				{
					procs: [
						{ pid: 329, ppid: 1, ticks: 100, command: "node omp.ts" },
						{ pid: 5300, ppid: 329, ticks: 3, command: `bash -c ${portCmd}` },
					],
					ports: [{ port: 8080, listeners: 0 }],
				},
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix).toEqual({
			kind: "hung-child",
			pid: 5300,
			command: `bash -c ${portCmd}`,
			expect: {
				sessionCommand: portCmd,
				ticks: 3,
				dep: { kind: "port", port: 8080 },
			},
		});
	});

	test("a port that still has listeners is not a dead dependency → unsure", () => {
		const portCmd = "while ! nc -z localhost 8080; do sleep 600; done";
		const fix = diagnoseStale({
			probe: probe1191(
				[],
				{ tool: "bash", command: portCmd, timeout: 0 },
				{
					procs: [
						{ pid: 329, ppid: 1, ticks: 100, command: "node omp.ts" },
						{ pid: 5300, ppid: 329, ticks: 3, command: `bash -c ${portCmd}` },
					],
					ports: [{ port: 8080, listeners: 2 }],
				},
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix.kind).toBe("unsure");
		if (fix.kind === "unsure")
			expect(fix.reason).toContain("no dead dependency");
	});

	test("a live pid file → unsure, no fix", () => {
		const fix = diagnoseStale({
			probe: probe1191(
				[],
				{ tool: "bash", command: loopCmd, timeout: 0 },
				{
					pidFiles: [{ path: pidPath, exists: true, pid: 5300, alive: true }],
				},
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix.kind).toBe("unsure");
		if (fix.kind === "unsure")
			expect(fix.reason).toBe(`lock ${pidPath} names live pid 5300`);
	});

	test("whitespace runs in argv normalize away before matching", () => {
		const fix = diagnoseStale({
			probe: probe1191(
				[],
				{
					tool: "bash",
					command: `while   [ ! -f /var/tmp/gate-1191/tmp/ott-stryker.lock ];  do sleep 600; done`,
					timeout: 0,
				},
				{
					pidFiles: [{ path: pidPath, exists: true, pid: 5229, alive: false }],
				},
			),
			worktree: wt,
			prevTicks: prev1191,
		});
		expect(fix.kind).toBe("hung-child");
	});

	test("busy child means the caller never reaches diagnose (supervisor gate)", () => {
		const busy: ProcSample[] = [
			{ pid: 329, ppid: 1, ticks: 100, command: "node omp.ts" },
			{ pid: 5300, ppid: 329, ticks: 13, command: `bash -c ${loopCmd}` }, // delta 10
		];
		const prev = new Map([
			[329, 100],
			[5300, 3],
		]);
		// Detection gate: a busy child marks the card not-a-suspect before diagnosis.
		expect(busyDescendant(prev, busy, 329)).toBe(5300);
		// Defense in depth: diagnosis alone still refuses to kill a spinning child.
		const fix = diagnoseStale({
			probe: {
				...probe1191([], { tool: "bash", command: loopCmd, timeout: 0 }),
				procs: busy,
			},
			worktree: wt,
			prevTicks: prev,
		});
		expect(fix.kind).toBe("unsure");
		if (fix.kind === "unsure")
			expect(fix.reason).toContain("no idle child of pid 329");
	});

	test("unsure reasons name the precondition that failed", () => {
		const diag = (probe: StaleProbe, prevTicks: Map<number, number> | null) =>
			diagnoseStale({ probe, worktree: wt, prevTicks });
		expect(diag(probe1191([], null), prev1191)).toEqual({
			kind: "unsure",
			reason:
				"idle window reached, no busy child, last tool none found: no last tool call found",
		});
		expect(
			diag(
				probe1191([], { tool: "bash", command: "tail -f x", timeout: 30 }),
				prev1191,
			),
		).toEqual({
			kind: "unsure",
			reason:
				"idle window reached, no busy child, last tool bash (tail -f x, timeout 30): last tool bash ran with timeout 30, not 0",
		});
		expect(
			diag(probe1191([], { tool: "bash", command: loopCmd, timeout: 0 }), null),
		).toEqual({
			kind: "unsure",
			reason:
				"idle window reached, no busy child, last tool bash (while [ ! -f /var/tmp/gate-1191/tmp/ott-stryker.lock ]; do sleep 600; done, timeout 0): no tick baseline (first probe)",
		});
		expect(
			diag(
				{
					...probe1191([], { tool: "bash", command: loopCmd, timeout: 0 }),
					pid: null,
				},
				prev1191,
			),
		).toEqual({
			kind: "unsure",
			reason:
				"idle window reached, no busy child, last tool bash (while [ ! -f /var/tmp/gate-1191/tmp/ott-stryker.lock ]; do sleep 600; done, timeout 0): run pid unknown",
		});
	});
});

// ---- steer and ask wording ----------------------------------------------------------------

describe("steer and ask wording", () => {
	test("stale-lock steer carries the facts and the direction", () => {
		const steer = staleSteerText({
			kind: "stale-lock",
			path: lockPath,
			pid: 5229,
		});
		expect(
			steer.startsWith(
				"Supervisor: your last tool call was waiting on state that could not change, and the supervisor applied a fix. This note rides your next turn.\n",
			),
		).toBe(true);
		expect(steer).toContain("This note rides your next turn.");
		expect(steer).toContain(
			`The lock file ${lockPath} named pid 5229, and that pid is dead on the worker. The lock could never clear. The supervisor is removing the lock file now.`,
		);
		expect(steer).toContain(
			"Re-run the step in the foreground with a bounded timeout, and do not start watcher loops with timeout 0.",
		);
	});

	test("hung-child steer carries the pid and command", () => {
		const steer = staleSteerText({
			kind: "hung-child",
			pid: 5300,
			command: "bash -c while [ ! -f x.lock ]; do sleep 600; done",
		});
		expect(steer).toContain(
			"The child process 5300 (bash -c while [ ! -f x.lock ]; do sleep 600; done) belongs to that tool call and has sat idle for the whole check window. The supervisor is stopping that child so the tool call can end.",
		);
	});

	test("ask reason, question, marker", () => {
		expect(staleAskReason("idle 360 min, lock never clears")).toBe(
			`Stuck turn: idle 360 min, lock never clears Reply "Apply the fix", "Stop the turn and restart", or "Wait".`,
		);
		const q = staleAskQuestion();
		expect(q.options).toEqual([...STALE_OPTIONS]);
		expect(q.question.length).toBeGreaterThan(0);
		expect(isStaleAskReason(staleAskReason("x"))).toBe(true);
		expect(isStaleAskReason("Stuck turn: x")).toBe(true);
		expect(isStaleAskReason("stuck turn: x")).toBe(false); // marker is case-sensitive
		expect(isStaleAskReason("Stuckish turn")).toBe(false);
		expect(isStaleAskReason("")).toBe(false);
		expect(isStaleAskReason(null)).toBe(false);
	});
});

// ---- staleAnswerKind ----------------------------------------------------------------

describe("staleAnswerKind", () => {
	const question = staleAskQuestion().question;
	test("wire line form from the drawer ask panel", () => {
		expect(staleAnswerKind(`For "${question}": Apply the fix`)).toBe("fix");
		expect(
			staleAnswerKind(`For "${question}": Stop the turn and restart`),
		).toBe("stop");
		expect(staleAnswerKind(`For "${question}": wait`)).toBe("wait");
	});

	test("bare text, case and trailing period ignored", () => {
		expect(staleAnswerKind("Apply the fix.")).toBe("fix");
		expect(staleAnswerKind("  STOP THE TURN AND RESTART  ")).toBe("stop");
		expect(staleAnswerKind("Wait.")).toBe("wait");
	});

	test("a question holding its own separator still splits on the last one", () => {
		expect(staleAnswerKind('For "note ": x": Wait')).toBe("wait");
	});

	test("junk answers refuse", () => {
		expect(staleAnswerKind("maybe")).toBeNull();
		expect(staleAnswerKind("")).toBeNull();
		expect(staleAnswerKind(`For "${question}": not an option`)).toBeNull();
	});
});

// ---- readTree ----------------------------------------------------------------

describe("readTree", () => {
	test("root plus descendants in BFS order, with ticks and argv", () => {
		const tree = readTree(329, procDir);
		expect(tree).not.toBeNull();
		expect(tree?.map((p) => p.pid)).toEqual([329, 800, 900, 5229, 6000]);
		const by = new Map((tree ?? []).map((p) => [p.pid, p] as const));
		expect(by.get(329)?.ppid).toBe(1);
		expect(by.get(329)?.ticks).toBe(100); // utime+stime+cutime+cstime
		expect(by.get(329)?.command).toBe("node omp.ts");
		expect(by.get(5229)?.ticks).toBe(5);
		expect(by.get(5229)?.command).toBe("bun stryker.ts --watch");
		expect(by.get(6000)?.command).toBe("sleep 600"); // grandchild proves recursion
		expect(by.get(800)?.command).toBe(""); // no cmdline file
		expect(by.get(900)?.command).toHaveLength(300); // argv capped
	});

	test("excludes parents, siblings, and exited pids", () => {
		const tree = readTree(329, procDir);
		const pids = new Set(tree?.map((p) => p.pid) ?? []);
		expect(pids.has(1)).toBe(false);
		expect(pids.has(77)).toBe(false);
		expect(pids.has(555)).toBe(false); // no stat
		expect(pids.has(601)).toBe(false); // garbage stat
	});

	test("dead root and unreadable proc root → null", () => {
		expect(readTree(424242, procDir)).toBeNull();
		expect(readTree(555, procDir)).toBeNull(); // exited: no stat
		expect(readTree(329, join(root, "missing-proc"))).toBeNull();
	});
});

// ---- newestSessionAt ----------------------------------------------------------------

describe("newestSessionAt", () => {
	const sessDir = join(root, "sessions");
	mkdirSync(sessDir, { recursive: true });
	const a = join(sessDir, "a.jsonl");
	const b = join(sessDir, "b.jsonl");
	writeFileSync(a, "{}\n");
	writeFileSync(b, "{}\n");
	writeFileSync(join(sessDir, "c.txt"), "x\n"); // wrong extension, ignored
	const t1 = Date.now() - 10_000;
	const t2 = Date.now() - 5_000;
	utimesSync(a, new Date(t1), new Date(t1));
	utimesSync(b, new Date(t2), new Date(t2));

	test("newest jsonl mtime at or after the run start", () => {
		expect(newestSessionAt(sessDir, t1 - 1)).toBe(t2);
		expect(newestSessionAt(sessDir, t2)).toBe(t2); // boundary is inclusive
	});

	test("nothing new enough, or dir unreadable → null", () => {
		expect(newestSessionAt(sessDir, t2 + 1)).toBeNull();
		expect(newestSessionAt(join(root, "nope"), 0)).toBeNull();
	});
});

// ---- lockFacts ----------------------------------------------------------------

describe("lockFacts", () => {
	const wtDir = join(root, "OTTR-1191");
	const disDir = join(root, "dis");
	mkdirSync(wtDir, { recursive: true });
	mkdirSync(disDir, { recursive: true });

	// A child that already exited: its pid is proven dead on this host.
	const deadChild = Bun.spawnSync([process.execPath, "-e", ""]);
	const deadPid = deadChild.pid;

	writeFileSync(join(wtDir, "run.lock"), `{"pid":${deadPid}}`);
	// The runner's own pid: kill(pid, 0) only reads liveness, never signals it.
	writeFileSync(join(wtDir, "live.lock"), `{"pid":${process.pid}}`);
	writeFileSync(join(wtDir, "junk.lock"), "not json");
	symlinkSync(join(wtDir, "run.lock"), join(wtDir, "link.lock")); // planted symlink
	symlinkSync(join(wtDir, "missing-target.lock"), join(wtDir, "dangling.lock"));
	writeFileSync(join(disDir, "x.lock"), `{"pid":${deadPid}}`); // exists, but outside dirs
	writeFileSync(join(root, "gate-1191"), "f"); // a FILE named like the scratch dir

	const paths = [
		join(wtDir, "run.lock"),
		join(wtDir, "live.lock"),
		join(wtDir, "junk.lock"),
		join(wtDir, "link.lock"),
		join(wtDir, "dangling.lock"),
		join(wtDir, "gone.lock"),
		join(disDir, "x.lock"),
		join(root, "gate-1191", "x.lock"), // allowed shape, ENOTDIR: no such file
	];
	const facts = lockFacts(paths);

	test("dead pid in an allowed lock reads alive: false", () => {
		expect(facts[0]).toEqual({
			path: join(wtDir, "run.lock"),
			exists: true,
			pid: deadPid,
			alive: false,
		});
	});

	test("live pid reads alive: true (kill(pid, 0) only, never signaled)", () => {
		expect(facts[1]).toEqual({
			path: join(wtDir, "live.lock"),
			exists: true,
			pid: process.pid,
			alive: true,
		});
	});

	test("unreadable or unparseable locks read present but unusable", () => {
		expect(facts[2]).toEqual({
			path: join(wtDir, "junk.lock"),
			exists: true,
			pid: null,
			alive: null,
		});
		expect(facts[3]).toEqual({
			path: join(wtDir, "link.lock"),
			exists: true,
			pid: null,
			alive: null,
		}); // final symlink refused, not followed
		expect(facts[4]).toEqual({
			path: join(wtDir, "dangling.lock"),
			exists: true,
			pid: null,
			alive: null,
		});
	});

	test("a foreign path is read and reported, never hidden as missing", () => {
		expect(facts[6]).toEqual({
			path: join(disDir, "x.lock"),
			exists: true,
			pid: deadPid,
			alive: false,
		}); // the read feeds the diagnosis and the ask; confinement decides only fixes
	});

	test("missing paths read exists: false without a fact", () => {
		expect(facts[5]).toEqual({
			path: join(wtDir, "gone.lock"),
			exists: false,
			pid: null,
			alive: null,
		});
		expect(facts[7]).toEqual({
			path: join(root, "gate-1191", "x.lock"),
			exists: false,
			pid: null,
			alive: null,
		}); // ENOTDIR grades as missing
	});
});

// ---- pidFileFacts ----------------------------------------------------------------

describe("pidFileFacts", () => {
	// A child that already exited: its pid is proven dead on this host.
	const deadChild = Bun.spawnSync([process.execPath, "-e", ""]);
	const deadPid = deadChild.pid;
	const pidDir = join(root, "pids");
	mkdirSync(pidDir, { recursive: true });
	const jsonPath = join(pidDir, "app.pid");
	const barePath = join(pidDir, "bare.pid");
	const junkPath = join(pidDir, "junk.pid");
	writeFileSync(jsonPath, `{"pid":${deadPid},"host":"worker-b"}\n`);
	writeFileSync(barePath, `${deadPid}\n`);
	writeFileSync(junkPath, "pid: 5229");

	const facts = pidFileFacts([
		jsonPath,
		barePath,
		junkPath,
		join(pidDir, "gone.pid"),
	]);

	test("JSON form and bare integer both parse", () => {
		expect(facts[0]).toEqual({
			path: jsonPath,
			exists: true,
			pid: deadPid,
			alive: false,
		});
		expect(facts[1]).toEqual({
			path: barePath,
			exists: true,
			pid: deadPid,
			alive: false,
		});
	});

	test("junk reads present but unusable; missing reads missing", () => {
		expect(facts[2]).toEqual({
			path: junkPath,
			exists: true,
			pid: null,
			alive: null,
		});
		expect(facts[3]).toEqual({
			path: join(pidDir, "gone.pid"),
			exists: false,
			pid: null,
			alive: null,
		});
	});
});

// ---- staleUnlockLocal / staleKillLocal (the server-local fix paths) ------------

describe("staleUnlockLocal", () => {
	// A child that already exited: its pid is proven dead on this host.
	const deadChild = Bun.spawnSync([process.execPath, "-e", ""]);
	const deadPid = deadChild.pid;
	const wt = join(root, "unlock-wt");
	beforeAll(() => mkdirSync(wt, { recursive: true }));
	const stillWaiting = (naming: string): LastTool => ({
		tool: "bash",
		command: `cat ${naming}`,
		timeout: 0,
	});

	test("the turn moved on: no re-read, empty command, or a different wait", () => {
		const lock = join(wt, "moved.lock");
		writeFileSync(lock, `{"pid":${deadPid}}`);
		expect(
			staleUnlockLocal(wt, lock, { sessionCommand: `cat ${lock}` }, null)
				.reason,
		).toContain(`the turn moved on: ${lock} is no longer the wait`);
		expect(
			staleUnlockLocal(
				wt,
				lock,
				{ sessionCommand: `cat ${lock}` },
				{ tool: "bash", command: "   ", timeout: 0 },
			).reason,
		).toContain("no longer the wait");
		expect(
			staleUnlockLocal(
				wt,
				lock,
				{ sessionCommand: `cat ${lock}` },
				stillWaiting("/other/place.lock"),
			).reason,
		).toContain("no longer the wait");
		expect(existsSync(lock)).toBe(true);
	});

	test("removes a worktree lock that names a dead pid", () => {
		const lock = join(wt, "run.lock");
		writeFileSync(lock, `{"pid":${deadPid}}`);
		expect(
			staleUnlockLocal(
				wt,
				lock,
				{ sessionCommand: `cat ${lock}` },
				stillWaiting(lock),
			),
		).toEqual({ ok: true });
		expect(existsSync(lock)).toBe(false);
	});

	test("removes a lock in the card-number scratch dir", () => {
		const scratch = join(root, "gate-1261");
		mkdirSync(scratch, { recursive: true });
		const fakeWt = join(root, "OTTR-1261");
		mkdirSync(fakeWt, { recursive: true });
		const lock = join(scratch, "ott-stryker.lock");
		writeFileSync(lock, `{"pid":${deadPid}}`);
		expect(
			staleUnlockLocal(
				fakeWt,
				lock,
				{ sessionCommand: `cat ${lock}` },
				stillWaiting(lock),
			),
		).toEqual({ ok: true });
		expect(existsSync(lock)).toBe(false);
	});

	test("refuses a live pid and keeps the file", () => {
		const lock = join(wt, "live.lock");
		writeFileSync(lock, `{"pid":${process.pid}}`);
		const res = staleUnlockLocal(
			wt,
			lock,
			{ sessionCommand: `cat ${lock}` },
			stillWaiting(lock),
		);
		expect(res.ok).toBe(false);
		expect(res.reason).toContain(`pid ${process.pid} is alive`);
		expect(existsSync(lock)).toBe(true);
	});

	test("refuses another card's scratch dir and keeps the file", () => {
		const scratch = join(root, "gate-1244");
		mkdirSync(scratch, { recursive: true });
		const fakeWt = join(root, "OTTR-1261");
		mkdirSync(fakeWt, { recursive: true });
		const lock = join(scratch, "ott-stryker.lock");
		writeFileSync(lock, `{"pid":${deadPid}}`);
		const res = staleUnlockLocal(
			fakeWt,
			lock,
			{ sessionCommand: `cat ${lock}` },
			stillWaiting(lock),
		);
		expect(res.ok).toBe(false);
		expect(res.reason).toContain("outside the card's own dirs");
		expect(existsSync(lock)).toBe(true);
	});

	test("refuses a symlink escape and keeps the victim", () => {
		const victim = join(root, "victim.lock");
		writeFileSync(victim, `{"pid":${deadPid}}`);
		const link = join(wt, "escape.lock");
		symlinkSync(victim, link);
		const res = staleUnlockLocal(
			wt,
			link,
			{ sessionCommand: `cat ${link}` },
			stillWaiting(link),
		);
		expect(res.ok).toBe(false);
		expect(existsSync(victim)).toBe(true);
	});

	test("refuses an oversize and a pid-1 file", () => {
		const big = join(wt, "big.lock");
		writeFileSync(big, `{"pid":${deadPid}}${"x".repeat(5000)}`);
		expect(
			staleUnlockLocal(
				wt,
				big,
				{ sessionCommand: `cat ${big}` },
				stillWaiting(big),
			).ok,
		).toBe(false);
		const one = join(wt, "one.lock");
		writeFileSync(one, '{"pid":1}');
		expect(
			staleUnlockLocal(
				wt,
				one,
				{ sessionCommand: `cat ${one}` },
				stillWaiting(one),
			).ok,
		).toBe(false);
		expect(existsSync(big)).toBe(true);
		expect(existsSync(one)).toBe(true);
	});
});

describe("staleKillLocal", () => {
	// A child that already exited: its pid is proven dead on this host.
	const deadChild = Bun.spawnSync([process.execPath, "-e", ""]);
	const deadPid = deadChild.pid;
	const fixDir = join(root, "killfix");
	mkdirSync(fixDir, { recursive: true });
	const noKill = (): void => {
		throw new Error("must not signal");
	};
	const expectFor = (over: Partial<KillExpect> = {}): KillExpect => ({
		sessionCommand: "bun stryker.ts --watch",
		ticks: 5,
		dep: { kind: "inline", pid: deadPid },
		...over,
	});
	const lastToolNow = (over: Partial<LastTool> = {}): LastTool => ({
		tool: "bash",
		command: "bun stryker.ts --watch",
		timeout: 0,
		...over,
	});
	// procDir: 329 ← {5229 (bun stryker.ts --watch, 5 ticks) ← 6000, 800 (no argv), 900}; 77 outside.
	const opts = (
		over: {
			procRoot?: string;
			currentLastTool?: LastTool | null;
			kill?: typeof process.kill;
		} = {},
	) => ({
		procRoot: procDir,
		kill: noKill,
		currentLastTool: lastToolNow(),
		...over,
	});

	test("the never-a-target refusals fire before any read", () => {
		expect(
			staleKillLocal(process.pid, 1, expectFor(), opts()).reason,
		).toContain("pid 1");
		expect(
			staleKillLocal(process.pid, process.pid, expectFor(), opts()).reason,
		).toContain("server's own pid");
		expect(staleKillLocal(329, 329, expectFor(), opts()).reason).toContain(
			"run's own pid",
		);
	});

	test("tree refusals: gone run pid, pid outside the tree", () => {
		expect(staleKillLocal(424242, 5229, expectFor(), opts()).reason).toBe(
			"the run pid is gone",
		);
		expect(staleKillLocal(329, 77, expectFor(), opts()).reason).toBe(
			"pid 77 is not in the turn's process tree",
		);
	});

	test("blocker 5: an empty session command refuses without a signal", () => {
		expect(
			staleKillLocal(329, 5229, expectFor({ sessionCommand: "" }), opts())
				.reason,
		).toBe("no session command to re-check");
	});

	test("blocker 5: a child whose argv no longer matches refuses", () => {
		expect(staleKillLocal(329, 6000, expectFor(), opts()).reason).toBe(
			"the child's command changed",
		);
		expect(staleKillLocal(329, 800, expectFor(), opts()).reason).toBe(
			"the child's command changed",
		); // no argv at all
	});

	test("blocker 5: a session that moved on refuses", () => {
		const moved = "the session's last tool call changed";
		expect(
			staleKillLocal(329, 5229, expectFor(), opts({ currentLastTool: null }))
				.reason,
		).toBe(moved);
		expect(
			staleKillLocal(
				329,
				5229,
				expectFor(),
				opts({ currentLastTool: lastToolNow({ command: "tail -f x" }) }),
			).reason,
		).toBe(moved);
		expect(
			staleKillLocal(
				329,
				5229,
				expectFor(),
				opts({ currentLastTool: lastToolNow({ timeout: 30 }) }),
			).reason,
		).toBe(moved);
	});

	test("blocker 5: a resumed child refuses", () => {
		expect(
			staleKillLocal(329, 5229, expectFor({ ticks: 0 }), opts()).reason,
		).toBe("the child resumed: 5 ticks gained");
	});

	test("blocker 5: a dependency that cleared refuses", () => {
		const cleared = "the dependency cleared";
		// inline: the pid came back (the runner's own pid is alive).
		expect(
			staleKillLocal(
				329,
				5229,
				expectFor({ dep: { kind: "inline", pid: process.pid } }),
				opts(),
			).reason,
		).toBe(cleared);
		// lockfile: the file now names a different, live pid — and a gone file refuses too.
		const nowLive = join(fixDir, "now-live.lock");
		writeFileSync(nowLive, `{"pid":${process.pid}}`);
		expect(
			staleKillLocal(
				329,
				5229,
				expectFor({ dep: { kind: "lockfile", path: nowLive, pid: deadPid } }),
				opts(),
			).reason,
		).toBe(cleared);
		expect(
			staleKillLocal(
				329,
				5229,
				expectFor({
					dep: {
						kind: "lockfile",
						path: join(fixDir, "gone.lock"),
						pid: deadPid,
					},
				}),
				opts(),
			).reason,
		).toBe(cleared);
		// pidfile: bare-integer content that now names a live pid.
		const nowLivePid = join(fixDir, "now-live.pid");
		writeFileSync(nowLivePid, `${process.pid}\n`);
		expect(
			staleKillLocal(
				329,
				5229,
				expectFor({ dep: { kind: "pidfile", path: nowLivePid, pid: deadPid } }),
				opts(),
			).reason,
		).toBe(cleared);
		// port: a listener appeared in the tables.
		expect(
			staleKillLocal(
				329,
				5229,
				expectFor({ dep: { kind: "port", port: 8080 } }),
				opts(),
			).reason,
		).toBe(cleared);
	});

	test("the happy path signals only after every recheck passes (fake tree)", () => {
		const signaled: { pid: number; signal: string }[] = [];
		const kill = (pid: number, signal?: string | number | undefined) => {
			signaled.push({ pid, signal: String(signal) });
		};
		// Port dep with zero listeners in the tables: the last gate before TERM.
		expect(
			staleKillLocal(
				329,
				5229,
				expectFor({ dep: { kind: "port", port: 4444 } }),
				{ ...opts(), kill },
			),
		).toEqual({ ok: true });
		expect(signaled).toEqual([{ pid: 5229, signal: "SIGTERM" }]);
	});

	test("the real /proc walk signals a real child on the happy path", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		try {
			const sample = readTree(process.pid)?.find((p) => p.pid === child.pid);
			if (sample === undefined)
				throw new Error("child missing from the real tree sample");
			const res = staleKillLocal(
				process.pid,
				child.pid,
				{
					sessionCommand: "sleep 30",
					ticks: sample.ticks,
					dep: { kind: "inline", pid: deadPid },
				},
				{ currentLastTool: { tool: "bash", command: "sleep 30", timeout: 0 } },
			);
			expect(res).toEqual({ ok: true });
			// Primary wait is the real exit event; the sleep only bounds a child that
			// ignores SIGTERM, which fake timers cannot surface.
			await Promise.race([child.exited, Bun.sleep(2000)]);
			expect(child.signalCode).toBe("SIGTERM");
		} finally {
			if (child.signalCode === null) child.kill();
		}
	});

	test("refusals never signal (seam sanity over the real /proc)", () => {
		// A run pid that does not exist: the real /proc walk returns null before the
		// signal seam is ever reached.
		const res = staleKillLocal(
			4000000,
			4194303,
			{ sessionCommand: "x", ticks: 0, dep: { kind: "inline", pid: deadPid } },
			{ currentLastTool: lastToolNow({ command: "x" }) },
		);
		expect(res).toEqual({ ok: false, reason: "the run pid is gone" });
	});
});

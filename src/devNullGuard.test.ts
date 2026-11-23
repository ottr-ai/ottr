import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import fc from "fast-check";
import {
	createDevNullGuard,
	DEV_NULL_RDEV,
	type DevNullGuard,
	type DevNullGuardOps,
	majorOf,
	makedev,
	minorOf,
} from "./devNullGuard.ts";

type Shape = {
	kind: "char" | "regular" | "dir";
	rdev?: number;
	size?: number;
};

/** A Stats stand-in for one injected probe shape. */
function fakeStats(shape: Shape): Stats {
	return {
		isCharacterDevice: () => shape.kind === "char",
		isFile: () => shape.kind === "regular",
		isDirectory: () => shape.kind === "dir",
		isSymbolicLink: () => false,
		isBlockDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
		rdev: shape.rdev ?? 0,
		size: shape.size ?? 0,
	} as unknown as Stats;
}

const KEEP_ASIDE = "/dev/null.broken-2026-11-22T19:06:52Z";
const NOW = Date.parse("2026-11-22T19:06:52Z");

/**
 * A guard over an in-memory filesystem: `files` maps paths to probe shapes, a
 * successful exec recreates the device (what mknod does), and every repair step
 * lands in `events` for the assertions.
 */
function statefulGuard(
	files: Map<string, Shape>,
	exec: { ok: boolean; detail: string | null } = { ok: true, detail: null },
): { guard: DevNullGuard; events: string[] } {
	const events: string[] = [];
	const ops: Partial<DevNullGuardOps> = {
		path: "/dev/null",
		rdev: DEV_NULL_RDEV,
		stat: (p) => {
			const shape = files.get(p);
			return shape === undefined ? null : fakeStats(shape);
		},
		rename: (from, to) => {
			events.push(`mv ${from} ${to}`);
			const shape = files.get(from);
			files.delete(from);
			if (shape !== undefined) files.set(to, shape);
		},
		chmod: (p, mode) => events.push(`chmod ${mode.toString(8)} ${p}`),
		exec: (argv) => {
			events.push(argv.join(" "));
			if (exec.ok)
				files.set("/dev/null", { kind: "char", rdev: DEV_NULL_RDEV });
			return exec;
		},
		readHead: () => null,
		now: () => NOW,
	};
	return { guard: createDevNullGuard(ops), events };
}

const GIT_STDERR_HEAD =
	"fatal: not a git repository (or any of the parent directories): .git";

describe("probeDevNull via check", () => {
	test("a healthy device is not broken and posts nothing", () => {
		const { guard } = statefulGuard(
			new Map([["/dev/null", { kind: "char", rdev: DEV_NULL_RDEV }]]),
		);
		const r = guard.check();
		expect(r.broken).toBe(false);
		expect(r.repaired).toBe(false);
		expect(r.notice).toBeNull();
		expect(r.first).toBe(false);
		expect(guard.notices()).toEqual([]);
	});

	test("OTTR-1215: a regular file is kept aside, mknod'ed back, and noticed once", () => {
		const files = new Map<string, Shape>([
			["/dev/null", { kind: "regular", size: 871 }],
		]);
		const { guard, events } = statefulGuard(files);
		const r = guard.check();
		expect(r.broken).toBe(true);
		expect(r.repaired).toBe(true);
		expect(r.keptAs).toBe(KEEP_ASIDE);
		expect(events).toEqual([
			`mv /dev/null ${KEEP_ASIDE}`,
			"mknod /dev/null c 1 3",
			"chmod 666 /dev/null",
		]);
		expect(r.notice ?? "").toContain("a regular file (871 bytes)");
		expect(r.notice ?? "").toContain(`kept aside as ${KEEP_ASIDE}`);
		expect(r.notice ?? "").toContain("recreated as char 1:3 mode 0666");
		expect(r.first).toBe(true);
		expect(guard.notices()).toEqual([r.notice ?? ""]);
		// The repaired device holds: later checks repair nothing and post nothing.
		const again = guard.check();
		expect(again.broken).toBe(false);
		expect(guard.notices().length).toBe(1);
	});

	test("the notice carries the bad file's head as evidence", () => {
		const guard = createDevNullGuard({
			path: "/dev/null",
			rdev: DEV_NULL_RDEV,
			stat: (p) =>
				p === "/dev/null" ? fakeStats({ kind: "regular", size: 259 }) : null,
			rename: () => {},
			chmod: () => {},
			exec: () => ({ ok: true, detail: null }),
			readHead: () => GIT_STDERR_HEAD,
			now: () => NOW,
		});
		const r = guard.check();
		expect(r.notice ?? "").toContain(`"${GIT_STDERR_HEAD}"`);
	});

	test("a device with wrong numbers is named in the notice", () => {
		const { guard } = statefulGuard(
			new Map([["/dev/null", { kind: "char", rdev: makedev(240, 0) }]]),
		);
		const r = guard.check();
		expect(r.broken).toBe(true);
		expect(r.repaired).toBe(true);
		expect(r.notice ?? "").toContain("a character device 240:0 instead of 1:3");
	});

	test("a missing device is mknod'ed back with nothing kept aside", () => {
		const { guard, events } = statefulGuard(new Map());
		const r = guard.check();
		expect(r.broken).toBe(true);
		expect(r.repaired).toBe(true);
		expect(r.keptAs).toBeNull();
		expect(events).toEqual(["mknod /dev/null c 1 3", "chmod 666 /dev/null"]);
	});

	test("a repair that cannot run notices once per day and names the step", () => {
		const files = new Map<string, Shape>([
			["/dev/null", { kind: "regular", size: 5 }],
		]);
		const { guard, events } = statefulGuard(files, {
			ok: false,
			detail: "mknod exited 1: Operation not permitted",
		});
		const r = guard.check();
		expect(r.broken).toBe(true);
		expect(r.repaired).toBe(false);
		expect(r.keptAs).toBe(KEEP_ASIDE);
		expect(events).toContain(`mv /dev/null ${KEEP_ASIDE}`);
		expect(r.notice ?? "").toContain(
			"repair failed at mknod (mknod exited 1: Operation not permitted)",
		);
		expect(r.first).toBe(true);
		// Same day: the unrepairable state posts no second notice.
		const again = guard.check();
		expect(again.first).toBe(false);
		expect(guard.notices().length).toBe(1);
	});

	test("a taken keep-aside name gets a numeric suffix", () => {
		const files = new Map<string, Shape>([
			["/dev/null", { kind: "regular", size: 3 }],
			[KEEP_ASIDE, { kind: "regular", size: 99 }],
		]);
		const { guard } = statefulGuard(files);
		const r = guard.check();
		expect(r.keptAs).toBe(`${KEEP_ASIDE}-0`);
		// The earlier keep-aside file stays untouched.
		expect(files.get(KEEP_ASIDE)?.size).toBe(99);
	});
});

describe("dev_t number decomposition", () => {
	test("the null device numbers read back", () => {
		expect(majorOf(makedev(1, 3))).toBe(1);
		expect(minorOf(makedev(1, 3))).toBe(3);
		expect(makedev(1, 3)).toBe((1 << 8) | 3);
	});

	test("makedev round-trips through majorOf and minorOf", () => {
		fc.assert(
			fc.property(
				fc.nat({ max: 2 ** 20 - 1 }),
				fc.nat({ max: 2 ** 20 - 1 }),
				(major, minor) => {
					const dev = makedev(major, minor);
					return majorOf(dev) === major && minorOf(dev) === minor;
				},
			),
		);
	});
});

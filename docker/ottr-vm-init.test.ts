import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ottr-vm-init is PID 1: it mounts kernel filesystems and ends with kill -TERM -1, so a
// test never runs the whole script (OTTR-517: no test signals processes it did not
// create). Two blocks are extracted between stable comments and driven by the test:
// the cmdline guards (pure case logic over the parsed values) and the mount section
// (everything under the script's m= directory, with mount, umount and chmod shimmed).

const init = readFileSync(join(import.meta.dir, "ottr-vm-init"), "utf8");

const root = mkdtempSync(join(tmpdir(), "ottr-vm-init-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

/* ------------------------------------------------------------------------------------ */
/* cmdline guards                                                                        */
/* ------------------------------------------------------------------------------------ */

const guardStart = init.indexOf("# The values land in /etc/hosts");
const guardEnd = init.indexOf("# The token never reaches the log.");
const guardBlock = guardStart >= 0 && guardEnd > guardStart ? init.slice(guardStart, guardEnd) : "";

/** Runs the shipped guard block with the given cmdline values; `die` marks and stops. */
function runGuards(
	mode: string,
	token: string,
	board: string,
	boardhost: string,
): { exitCode: number; out: string } {
	const harness = [
		"die() {",
		'\techo "DIE: $*" >&2',
		"exit 1",
		"}",
		'mode="$1" token="$2" board="$3" boardhost="$4"',
		guardBlock,
		'echo "GUARDS-PASSED"',
	].join("\n");
	const r = Bun.spawnSync(["sh", "-c", harness, "sh", mode, token, board, boardhost], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: r.exitCode,
		out: `${r.stdout.toString()}${r.stderr.toString()}`,
	};
}

describe("ottr-vm-init cmdline guards", () => {
	test("the shipped guard block is present", () => {
		expect(guardBlock).toContain("ottr.mode must be run, bake or validate");
		expect(guardBlock).toContain("ottr.token");
		expect(guardBlock).toContain("ottr.board");
		expect(guardBlock).toContain("ottr.boardhost");
	});

	test("validate mode accepts the empty token, board and boardhost", () => {
		const r = runGuards("validate", "", "", "");
		expect(r.exitCode).toBe(0);
		expect(r.out).toContain("GUARDS-PASSED");
		expect(r.out).not.toContain("DIE:");
	});

	test("validate mode still refuses a non-hex token", () => {
		const r = runGuards("validate", "XYZ", "", "");
		expect(r.exitCode).toBe(1);
		expect(r.out).toContain("DIE:");
		expect(r.out).toContain("ottr.token");
	});

	test("validate mode still refuses a non-IPv4 board and a bad host name", () => {
		for (const [board, boardhost] of [
			["ottr", ""],
			["", "-x"],
		] as const) {
			const r = runGuards("validate", "", board, boardhost);
			expect(r.exitCode).toBe(1);
			expect(r.out).toContain("DIE:");
		}
	});

	test("run and bake modes still refuse an empty value", () => {
		for (const mode of ["run", "bake"]) {
			for (const [label, t, b, h] of [
				["ottr.token", "", "10.231.0.1", "ottr"],
				["ottr.board", "abc123", "", "ottr"],
				["ottr.boardhost", "abc123", "10.231.0.1", ""],
			] as const) {
				const r = runGuards(mode, t, b, h);
				expect(r.exitCode).toBe(1);
				expect(r.out).toContain("DIE:");
				expect(r.out).toContain(label);
			}
		}
	});

	test("run mode accepts plain values", () => {
		const r = runGuards("run", "abc123", "10.231.0.1", "ottr");
		expect(r.exitCode).toBe(0);
		expect(r.out).toContain("GUARDS-PASSED");
	});
});

/* ------------------------------------------------------------------------------------ */
/* mount walk                                                                            */
/* ------------------------------------------------------------------------------------ */

const walkStart = init.indexOf("m=/tmp");
const walkEnd = init.indexOf("# The kernel's ip= autoconfig");
const rawMountBody = walkStart >= 0 && walkEnd > walkStart ? init.slice(walkStart, walkEnd) : "";

interface WalkResult {
	exitCode: number;
	out: string;
	mounts: string;
	/** The m= directory the walk ran in: the test's own temp dir. */
	mRoot: string;
}

/**
 * Walks the shipped mount section in the test's own temp dir. The script's `m=/tmp` is
 * rewritten to the temp dir (the one text change; every other line ships as is), so the
 * walk never touches shared /tmp paths. mount and umount are shimmed: the mount shim
 * enforces what the kernel enforces on mounts it can check without a kernel module —
 * every overlay lowerdir, upperdir and workdir must exist, a bind source must exist and
 * a bind target must exist — and answers non-zero like the kernel's ENOENT otherwise.
 * chmod is shimmed to log and never touch /dev, so no host device node changes.
 */
function walk(
	mode: string,
	board: string,
	boardhost: string,
): WalkResult {
	const mRoot = mkdtempSync(join(root, "walk-"));
	rmSync(join(mRoot, "mounts.log"), { force: true });
	const shim = join(mRoot, "shim");
	mkdirSync(shim, { recursive: true });
	const log = join(mRoot, "mounts.log");
	// Built without shell quoting puzzles: the temp path has no metacharacters, and the
	// only `${` sequences below are escaped for the template literal, not for sh.
	const mountShim = [
		"#!/bin/sh",
		`log='${log}'`,
		'last=""',
		'for a in "$@"; do last="$a"; done',
		'if [ "$1" = "-t" ] && [ "$2" = "overlay" ]; then',
		'\topts="$5"',
		'\told="$IFS"; IFS=","',
		"\tfor kv in $opts; do",
		'\t\tkey="${kv%%=*}"; val="${kv#*=}"',
		'\t\tcase "$key" in',
		"\t\tlowerdir|upperdir|workdir)",
		'\t\t\toifs="$IFS"; IFS=":"',
		"\t\t\tfor d in $val; do",
		'\t\t\t\tif [ -n "$d" ] && [ ! -d "$d" ]; then',
		'\t\t\t\t\techo "mount: overlay $key dir missing: $d" >> "$log"',
		'\t\t\t\t\tIFS="$oifs"',
		"\t\t\t\t\texit 1",
		"\t\t\t\tfi",
		"\t\t\tdone",
		'\t\t\tIFS="$oifs"',
		"\t\t;;",
		"\t\tesac",
		"\tdone",
		'\tIFS="$old"',
		"fi",
		'if [ "$1" = "--bind" ]; then',
		'\tif [ ! -e "$2" ]; then echo "mount: bind source missing: $2" >> "$log"; exit 1; fi',
		'\tif [ ! -d "$3" ]; then echo "mount: bind target missing: $3" >> "$log"; exit 1; fi',
		"fi",
		'case "$last" in',
		`"${mRoot}/root")`,
		`mkdir -p "${mRoot}/root/etc" "${mRoot}/root/tmp" "${mRoot}/root/home" "${mRoot}/root/proc" "${mRoot}/root/sys" "${mRoot}/root/dev" "${mRoot}/root/run"`,
		";;",
		// The guest kernel's sysfs always carries /sys/fs/cgroup for the cgroup2
		// mount; the walk's plain temp dir does not, so the shim creates it.
		`"${mRoot}/root/sys/fs/cgroup")`,
		`mkdir -p "${mRoot}/root/sys/fs/cgroup"`,
		";;",
		"esac",
		`echo "mount $*" >> '${log}'`,
		"exit 0",
	].join("\n");
	const umountShim = `#!/bin/sh\necho "umount $*" >> '${log}'\nexit 0\n`;
	// chmod never reaches a host device node: the /dev path is logged and skipped.
	const chmodShim = `#!/bin/sh\necho "chmod $*" >> '${log}'\nif [ "$2" = "/dev/vdd" ]; then exit 0; fi\nexec /bin/chmod "$@"\n`;
	for (const [name, body] of [
		["mount", mountShim],
		["umount", umountShim],
		["chmod", chmodShim],
	] as const) {
		writeFileSync(join(shim, name), body);
		chmodSync(join(shim, name), 0o755);
	}
	// The one rewrite: the script's fixed m=/tmp becomes the walk's own temp dir.
	const mountBody = rawMountBody.replace("m=/tmp", `m="${mRoot}"`);
	const harness = [
		"power_off() { exit 1; }",
		'die() { echo "DIE: $*" >&2; exit 1; }',
		'mode="$1" token="" board="$2" boardhost="$3"',
		mountBody,
	].join("\n");
	const r = Bun.spawnSync(["sh", "-c", harness, "sh", mode, board, boardhost], {
		cwd: mRoot,
		env: { PATH: `${shim}:${process.env.PATH ?? ""}` },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = `${r.stdout.toString()}${r.stderr.toString()}`;
	const mounts = existsSync(log) ? readFileSync(log, "utf8") : "";
	return { exitCode: r.exitCode, out, mounts, mRoot };
}

describe("ottr-vm-init mount walk", () => {
	test("the mount section is present", () => {
		expect(rawMountBody).toContain("m=/tmp");
		expect(rawMountBody).toContain("cannot mount the overlay root");
	});

	test("validate builds the skeleton in the setup overlay before the read-only root", () => {
		const w = walk("validate", "", "");
		expect(w.exitCode, w.out).toBe(0);
		expect(w.out).not.toContain("DIE:");
		// The setup overlay mounts, unmounts, then the final root mounts with the setup
		// upper as its lowest layer.
		const setup = w.mounts.indexOf("upperdir=");
		const unmounted = w.mounts.indexOf(`umount ${w.mRoot}/root`);
		const final = w.mounts.indexOf(
			`lowerdir=${w.mRoot}/scratch/setup-upper:${w.mRoot}/base`,
		);
		expect(setup).toBeGreaterThan(-1);
		expect(unmounted).toBeGreaterThan(setup);
		expect(final).toBeGreaterThan(unmounted);
		// The setup overlay's own dirs exist on the scratch: the kernel refuses the mount
		// without them, so their absence is exactly the bug this walk must catch.
		expect(existsSync(`${w.mRoot}/scratch/setup-upper`)).toBe(true);
		expect(existsSync(`${w.mRoot}/scratch/setup-work`)).toBe(true);
		// The job's whole writable world is bound from the scratch; the target is bound
		// read-only from its own disk.
		for (const bind of [
			`mount --bind ${w.mRoot}/target ${w.mRoot}/root/target`,
			`mount --bind ${w.mRoot}/scratch/tmp ${w.mRoot}/root/tmp`,
			`mount --bind ${w.mRoot}/scratch/home ${w.mRoot}/root/home`,
			`mount --bind ${w.mRoot}/scratch/work ${w.mRoot}/root/work`,
			`mount --bind ${w.mRoot}/scratch/job ${w.mRoot}/root/job`,
		])
			expect(w.mounts).toContain(bind);
		// The job cgroup exists: cgroup2 mounted at the root's /sys/fs/cgroup, the
		// pids controller enabled on the subtree, the job cgroup created (OTTR-1225).
		expect(w.mounts).toContain(
			`mount -t cgroup2 none ${w.mRoot}/root/sys/fs/cgroup`,
		);
		expect(
			readFileSync(`${w.mRoot}/root/sys/fs/cgroup/cgroup.subtree_control`, "utf8"),
		).toBe("+pids\n");
		expect(existsSync(`${w.mRoot}/root/sys/fs/cgroup/job`)).toBe(true);
		// The skeleton writes happened for real, at the paths the binds need.
		expect(readFileSync(`${w.mRoot}/root/etc/hosts`, "utf8")).toBe(
			"127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n",
		);
		expect(readFileSync(`${w.mRoot}/root/etc/resolv.conf`, "utf8")).toBe("");
		// The walk never left its own temp dir and never touched a host device node.
		expect(w.mounts).not.toContain("/tmp/base");
		expect(w.mounts).not.toContain("/tmp/scratch");
		expect(w.mounts).toContain("chmod 600 /dev/vdd");
	});

	test("run mode keeps its writable overlay and board hosts", () => {
		const w = walk("run", "10.231.0.1", "ottr");
		expect(w.exitCode, w.out).toBe(0);
		expect(w.out).not.toContain("DIE:");
		expect(w.mounts).toContain(
			`upperdir=${w.mRoot}/scratch/upper,workdir=${w.mRoot}/scratch/work`,
		);
		expect(w.mounts).not.toContain("setup-upper");
		// The job cgroup is a validate-mode control only.
		expect(w.mounts).not.toContain("cgroup2");
		expect(readFileSync(`${w.mRoot}/root/etc/hosts`, "utf8")).toContain("10.231.0.1\tottr");
		expect(readFileSync(`${w.mRoot}/root/etc/resolv.conf`, "utf8")).toContain("nameserver");
	});
});

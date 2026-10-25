import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
	mkdirBelow,
	moveBelow,
	openDir,
	renameBelow,
	unlinkBelow,
	type WriteMode,
	writeBelow,
} from "./confine.ts";
import fc from "./test/properties.ts";

const linux = process.platform === "linux";
const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fresh root with an `anchor` dir and an `outside` dir next to it. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "confine-"));
	roots.push(root);
	const anchor = join(root, "anchor");
	const outside = join(root, "outside");
	mkdirSync(anchor);
	mkdirSync(outside);
	return { root, anchor, outside };
}

const modes: WriteMode[] = ["truncate", "exclusive", "append"];

function code(fn: () => void): string | undefined {
	try {
		fn();
	} catch (err) {
		return (err as NodeJS.ErrnoException).code;
	}
	return undefined;
}

describe("writeBelow", () => {
	test("creates missing parents and honors each mode", () => {
		const { anchor } = fixture();
		const f = join(anchor, "x", "y", "f.txt");
		writeBelow(anchor, f, "one");
		expect(readFileSync(f, "utf8")).toBe("one");
		writeBelow(anchor, f, "two", "truncate");
		expect(readFileSync(f, "utf8")).toBe("two");
		writeBelow(anchor, f, "+3", "append");
		expect(readFileSync(f, "utf8")).toBe("two+3");
		expect(code(() => writeBelow(anchor, f, "z", "exclusive"))).toBe("EEXIST");
		expect(readFileSync(f, "utf8")).toBe("two+3");
		const g = join(anchor, "x", "g.txt");
		writeBelow(anchor, g, "new", "exclusive");
		expect(readFileSync(g, "utf8")).toBe("new");
	});

	test.skipIf(!linux)("refuses a symlinked parent dir", () => {
		const { anchor, outside } = fixture();
		symlinkSync(outside, join(anchor, "a"));
		for (const mode of modes)
			expect(() =>
				writeBelow(anchor, join(anchor, "a", "f"), "x", mode),
			).toThrow(/refusing/);
		expect(() => writeBelow(anchor, join(anchor, "a", "d", "f"), "x")).toThrow(
			/refusing/,
		);
		expect(() => mkdirBelow(anchor, join(anchor, "a", "sub"))).toThrow(
			/refusing/,
		);
		expect(readdirSync(outside)).toEqual([]);
	});

	test.skipIf(!linux)("refuses a symlink at the file itself", () => {
		const { anchor, outside } = fixture();
		const target = join(outside, "secret");
		writeFileSync(target, "orig");
		symlinkSync(target, join(anchor, "f"));
		const dangling = join(outside, "absent");
		symlinkSync(dangling, join(anchor, "g"));
		for (const mode of modes) {
			for (const name of ["f", "g"]) {
				const write = () => writeBelow(anchor, join(anchor, name), "x", mode);
				if (mode === "exclusive")
					expect(write).toThrow(expect.objectContaining({ code: "EEXIST" }));
				else expect(write).toThrow(/refusing/);
			}
			expect(readFileSync(target, "utf8")).toBe("orig");
			expect(existsSync(dangling)).toBe(false);
		}
	});

	test("rejects a path outside the anchor", () => {
		const { root, anchor } = fixture();
		expect(() => writeBelow(anchor, join(anchor, "..", "x"), "x")).toThrow(
			/outside/,
		);
		expect(existsSync(join(root, "x"))).toBe(false);
	});
});

describe("openDir", () => {
	test("at() rejects bad names, list() returns entries", () => {
		const { anchor } = fixture();
		writeFileSync(join(anchor, "one"), "");
		mkdirSync(join(anchor, "two"));
		const d = openDir(anchor, anchor);
		try {
			for (const bad of ["..", "", "a/b"]) expect(() => d.at(bad)).toThrow();
			expect(d.list().sort()).toEqual(["one", "two"]);
		} finally {
			d.close();
		}
	});
});

describe("unlinkBelow", () => {
	test.skipIf(!linux)("removes a symlink, not its target", () => {
		const { anchor, outside } = fixture();
		const target = join(outside, "t");
		writeFileSync(target, "keep");
		symlinkSync(target, join(anchor, "ln"));
		unlinkBelow(anchor, join(anchor, "ln"));
		expect(existsSync(join(anchor, "ln"))).toBe(false);
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	test("throws ENOENT on a missing file", () => {
		const { anchor } = fixture();
		expect(code(() => unlinkBelow(anchor, join(anchor, "nope")))).toBe(
			"ENOENT",
		);
	});
});

describe("renameBelow", () => {
	test("moves a file into a new nested dir", () => {
		const { anchor } = fixture();
		const from = join(anchor, "f");
		writeFileSync(from, "data");
		const to = join(anchor, "n", "m", "g");
		renameBelow(anchor, from, to);
		expect(existsSync(from)).toBe(false);
		expect(readFileSync(to, "utf8")).toBe("data");
	});

	test.skipIf(!linux)("refuses a symlinked destination parent", () => {
		const { anchor, outside } = fixture();
		const from = join(anchor, "f");
		writeFileSync(from, "data");
		symlinkSync(outside, join(anchor, "dst"));
		expect(() => renameBelow(anchor, from, join(anchor, "dst", "g"))).toThrow(
			/refusing/,
		);
		expect(readFileSync(from, "utf8")).toBe("data");
		expect(readdirSync(outside)).toEqual([]);
	});
});

describe("moveBelow", () => {
	test("same mount: moves a file", () => {
		const { root, anchor } = fixture();
		const other = join(root, "other");
		mkdirSync(other);
		const from = join(anchor, "f");
		writeFileSync(from, "data");
		const to = join(other, "d", "f");
		moveBelow({ anchor, file: from }, { anchor: other, file: to });
		expect(existsSync(from)).toBe(false);
		expect(readFileSync(to, "utf8")).toBe("data");
	});

	test.skipIf(!linux)("same mount: moves a symlink as a link", () => {
		const { root, anchor, outside } = fixture();
		const other = join(root, "other");
		mkdirSync(other);
		const target = join(outside, "t");
		writeFileSync(target, "keep");
		const from = join(anchor, "ln");
		symlinkSync(target, from);
		const to = join(other, "ln");
		moveBelow({ anchor, file: from }, { anchor: other, file: to });
		expect(existsSync(from)).toBe(false);
		expect(lstatSync(to).isSymbolicLink()).toBe(true);
		expect(readlinkSync(to)).toBe(target);
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	const shm = "/dev/shm";
	const crossMount =
		linux && existsSync(shm) && statSync(shm).dev !== statSync(tmpdir()).dev;
	const hasMkfifo =
		crossMount && spawnSync("sh", ["-c", "command -v mkfifo"]).status === 0;

	function shmDir(): string {
		return mkdtempSync(join(shm, "confine-"));
	}

	test.skipIf(!crossMount)("across mounts: copies a file, keeps mode", () => {
		const { anchor } = fixture();
		const dst = shmDir();
		try {
			const from = join(anchor, "f");
			writeFileSync(from, "data");
			chmodSync(from, 0o755);
			const to = join(dst, "d", "f");
			moveBelow({ anchor, file: from }, { anchor: dst, file: to });
			expect(existsSync(from)).toBe(false);
			expect(readFileSync(to, "utf8")).toBe("data");
			expect(statSync(to).mode & 0o777).toBe(0o755);
		} finally {
			rmSync(dst, { recursive: true, force: true });
		}
	});

	test.skipIf(!crossMount)(
		"across mounts: recreates a symlink as a link",
		() => {
			const { anchor, outside } = fixture();
			const dst = shmDir();
			try {
				const target = join(outside, "t");
				writeFileSync(target, "keep");
				const from = join(anchor, "ln");
				symlinkSync(target, from);
				const to = join(dst, "ln");
				moveBelow({ anchor, file: from }, { anchor: dst, file: to });
				expect(existsSync(from)).toBe(false);
				expect(lstatSync(to).isSymbolicLink()).toBe(true);
				expect(readlinkSync(to)).toBe(target);
				expect(readFileSync(target, "utf8")).toBe("keep");
			} finally {
				rmSync(dst, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!crossMount)("across mounts: replaces an existing file", () => {
		const { anchor } = fixture();
		const dst = shmDir();
		try {
			const from = join(anchor, "f");
			writeFileSync(from, "new");
			const to = join(dst, "f");
			writeFileSync(to, "old");
			moveBelow({ anchor, file: from }, { anchor: dst, file: to });
			expect(readFileSync(to, "utf8")).toBe("new");
			expect(existsSync(from)).toBe(false);
		} finally {
			rmSync(dst, { recursive: true, force: true });
		}
	});

	test.skipIf(!hasMkfifo)(
		"across mounts: refuses a FIFO without hanging",
		() => {
			const { anchor } = fixture();
			const dst = shmDir();
			try {
				const from = join(anchor, "fifo");
				expect(spawnSync("mkfifo", [from]).status).toBe(0);
				expect(() =>
					moveBelow(
						{ anchor, file: from },
						{ anchor: dst, file: join(dst, "fifo") },
					),
				).toThrow(/not a regular file/);
				expect(lstatSync(from).isFIFO()).toBe(true);
			} finally {
				rmSync(dst, { recursive: true, force: true });
			}
		},
	);
});

describe("writeBelow property", () => {
	test.skipIf(!linux)("never writes outside the anchor", () => {
		const { anchor, outside } = fixture();
		symlinkSync(outside, join(anchor, "ln"));
		const realAnchor = realpathSync(anchor);
		const seg = fc.constantFrom("..", ".", "a", "b", "ln");
		fc.assert(
			fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), (segs) => {
				const file = join(anchor, ...segs);
				try {
					writeBelow(anchor, file, "x");
				} catch {
					return;
				}
				const rel = relative(realAnchor, realpathSync(file));
				expect(rel === "" || rel === ".." || rel.startsWith(`..${sep}`)).toBe(
					false,
				);
			}),
		);
		expect(readdirSync(outside)).toEqual([]);
	});
});

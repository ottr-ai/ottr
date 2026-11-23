import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, sep } from "node:path";
import {
	appendLineBelow,
	copyBelow,
	type Dir,
	isSizeRefusal,
	mkdirBelow,
	moveBelow,
	openBelow,
	openDir,
	readBelow,
	readBoundedFile,
	readRegular,
	readTailBounded,
	removeBelow,
	renameBelow,
	renameProven,
	scanDir,
	touchBelow,
	trustedAnchor,
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

describe("openBelow", () => {
	test.skipIf(!linux)(
		"descends two levels and reads through the held dir",
		() => {
			const { anchor } = fixture();
			mkdirSync(join(anchor, "a", "b"), { recursive: true });
			writeFileSync(join(anchor, "a", "b", "leaf"), "leaf");
			const parent = openDir(anchor, join(anchor, "a"));
			try {
				const child = openBelow(parent, "b");
				try {
					expect(child.list()).toEqual(["leaf"]);
					expect(readFileSync(child.at("leaf"), "utf8")).toBe("leaf");
				} finally {
					child.close();
				}
			} finally {
				parent.close();
			}
		},
	);

	test.skipIf(!linux)("refuses a symlink child in the held dir", () => {
		const { anchor, outside } = fixture();
		mkdirSync(join(anchor, "a"));
		symlinkSync(outside, join(anchor, "a", "ln"));
		const parent = openDir(anchor, join(anchor, "a"));
		try {
			expect(() => openBelow(parent, "ln")).toThrow(/refusing/);
			expect(lstatSync(join(anchor, "a", "ln")).isSymbolicLink()).toBe(true);
		} finally {
			parent.close();
		}
	});

	test.skipIf(!linux)("refuses a plain-file child", () => {
		const { anchor } = fixture();
		mkdirSync(join(anchor, "a"));
		writeFileSync(join(anchor, "a", "f"), "x");
		const parent = openDir(anchor, join(anchor, "a"));
		try {
			expect(() => openBelow(parent, "f")).toThrow(/refusing/);
		} finally {
			parent.close();
		}
	});

	test.skipIf(!linux)(
		"close releases the child descriptor, the parent stays open",
		() => {
			const { anchor } = fixture();
			mkdirSync(join(anchor, "a", "b"), { recursive: true });
			writeFileSync(join(anchor, "a", "f"), "p");
			const parent = openDir(anchor, join(anchor, "a"));
			try {
				const child = openBelow(parent, "b");
				const fdPath = `/proc/self/fd/${child.fd}`;
				expect(child.list()).toEqual([]);
				child.close();
				expect(() => readdirSync(fdPath)).toThrow();
				expect(parent.list().sort()).toEqual(["b", "f"]);
			} finally {
				parent.close();
			}
		},
	);

	test.skipIf(!linux)("descends to depth 10 one open per level", () => {
		const { anchor } = fixture();
		let deep = anchor;
		for (let i = 0; i < 10; i++) deep = join(deep, `d${i}`);
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(deep, "leaf"), "leaf");
		let cur: Dir = openDir(anchor, anchor);
		const held: Dir[] = [cur];
		try {
			for (let i = 0; i < 10; i++) {
				cur = openBelow(cur, `d${i}`);
				held.push(cur);
			}
			expect(cur.list()).toEqual(["leaf"]);
			expect(readFileSync(cur.at("leaf"), "utf8")).toBe("leaf");
		} finally {
			while (held.length > 0) held.pop()?.close();
		}
	});
});

describe("scanDir", () => {
	test.skipIf(!linux)("yields every entry name of a held dir", () => {
		const { anchor } = fixture();
		mkdirSync(join(anchor, "a", "sub"), { recursive: true });
		writeFileSync(join(anchor, "a", "f1"), "1");
		writeFileSync(join(anchor, "a", "f2"), "2");
		const d = openDir(anchor, join(anchor, "a"));
		try {
			const scan = scanDir(d);
			const names: string[] = [];
			try {
				for (;;) {
					const n = scan.next();
					if (n === null) break;
					names.push(n);
				}
			} finally {
				scan.close();
			}
			expect(names.sort()).toEqual(readdirSync(join(anchor, "a")).sort());
		} finally {
			d.close();
		}
	});

	test.skipIf(!linux)(
		"stops yielding null only after all 500 entries; early close leaves the parent usable",
		() => {
			const { anchor } = fixture();
			mkdirSync(join(anchor, "big"));
			for (let i = 0; i < 500; i++)
				writeFileSync(join(anchor, "big", `f${i}`), "x");
			const parent = openDir(anchor, join(anchor, "big"));
			try {
				const scan = scanDir(parent);
				let count = 0;
				try {
					while (scan.next() !== null) count++;
				} finally {
					scan.close();
				}
				expect(count).toBe(500);
				const early = scanDir(parent);
				for (let i = 0; i < 3; i++) expect(early.next()).not.toBeNull();
				early.close();
				expect(parent.list()).toHaveLength(500);
			} finally {
				parent.close();
			}
		},
	);

	test.skipIf(!linux)("next throws after close", () => {
		const { anchor } = fixture();
		mkdirSync(join(anchor, "a"));
		writeFileSync(join(anchor, "a", "f"), "x");
		const d = openDir(anchor, join(anchor, "a"));
		try {
			const scan = scanDir(d);
			scan.close();
			expect(() => scan.next()).toThrow();
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

describe("renameProven", () => {
	test("renames inside the held dir; a parent swapped for a symlink after the walk receives nothing", () => {
		const { root, anchor } = fixture();
		const held = join(anchor, "held");
		mkdirSync(held);
		const from = join(held, "from");
		writeFileSync(from, "data");
		const server = join(root, "server");
		mkdirSync(server);
		writeFileSync(join(server, "tasks.db"), "keep");
		const fd = openSync(from, constants.O_RDONLY);
		const d = openDir(anchor, held, {});
		try {
			// A worker renames the walked dir away and plants a symlink at its name.
			renameSync(held, join(anchor, "held.moved"));
			symlinkSync(server, join(anchor, "held"));
			renameProven(d, "from", "to", fd);
			// The rename landed in the held dir (now "held.moved"), never through the link.
			expect(readFileSync(join(anchor, "held.moved", "to"), "utf8")).toBe(
				"data",
			);
			expect(existsSync(join(server, "to"))).toBe(false);
			expect(readFileSync(join(server, "tasks.db"), "utf8")).toBe("keep");
		} finally {
			closeSync(fd);
			d.close();
		}
	});

	test("an entry swapped for a symlink fails the proof and is never followed", () => {
		const { anchor, outside } = fixture();
		writeFileSync(join(outside, "keep"), "keep");
		const held = join(anchor, "held");
		mkdirSync(held);
		const fd = openSync(
			join(held, "from"),
			constants.O_CREAT | constants.O_WRONLY,
		);
		const d = openDir(anchor, held, {});
		try {
			// A worker unlinks the entry and plants a symlink to a sentinel under its name.
			unlinkSync(join(held, "from"));
			symlinkSync(join(outside, "keep"), join(held, "from"));
			expect(() => renameProven(d, "from", "to", fd)).toThrow(/refusing/);
			expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep");
			expect(lstatSync(join(held, "from")).isSymbolicLink()).toBe(true);
			expect(existsSync(join(held, "to"))).toBe(false);
		} finally {
			closeSync(fd);
			d.close();
		}
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

describe("copyBelow", () => {
	test("copies a regular file into new nested dirs and keeps its mode", () => {
		const { anchor, outside } = fixture();
		const from = join(anchor, "f");
		writeFileSync(from, "data");
		chmodSync(from, 0o750);
		const to = join(outside, "x", "y", "f");
		copyBelow({ anchor, file: from }, { anchor: outside, file: to });
		expect(readFileSync(to, "utf8")).toBe("data");
		expect(statSync(to).mode & 0o777).toBe(0o750);
		expect(readFileSync(from, "utf8")).toBe("data");
	});

	test.skipIf(!linux)("copies a source symlink as a link", () => {
		const { root, anchor, outside } = fixture();
		const target = join(outside, "t");
		writeFileSync(target, "keep");
		const from = join(anchor, "ln");
		symlinkSync(target, from);
		const dst = join(root, "dst");
		mkdirSync(dst);
		const to = join(dst, "ln");
		writeFileSync(to, "old");
		copyBelow({ anchor, file: from }, { anchor: dst, file: to });
		expect(lstatSync(to).isSymbolicLink()).toBe(true);
		expect(readlinkSync(to)).toBe(target);
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	test.skipIf(!linux)(
		"with a source tree, rewrites only relative link targets that leave the tree",
		() => {
			// The source tree is anchor/src; the copy lands at the same relative path in anchor/dst/wt.
			const { anchor } = fixture();
			const tree = join(anchor, "src");
			const copy = join(anchor, "dst", "wt");
			mkdirSync(join(tree, "a"), { recursive: true });
			writeFileSync(join(anchor, "shared.md"), "shared");
			writeFileSync(join(tree, "a", "run-3"), "run");
			symlinkSync(join("..", "..", "shared.md"), join(tree, "a", "out"));
			symlinkSync("run-3", join(tree, "a", "in"));
			for (const name of ["out", "in"])
				copyBelow(
					{ anchor, file: join(tree, "a", name) },
					{ anchor, file: join(copy, "a", name) },
					tree,
				);
			expect(readlinkSync(join(copy, "a", "in"))).toBe("run-3");
			expect(readlinkSync(join(copy, "a", "out"))).toBe(
				join("..", "..", "..", "shared.md"),
			);
			expect(realpathSync(join(copy, "a", "out"))).toBe(
				realpathSync(join(anchor, "shared.md")),
			);
			expect(readlinkSync(join(tree, "a", "out"))).toBe(
				join("..", "..", "shared.md"),
			);
		},
	);

	test.skipIf(!linux)("refuses a symlinked destination parent", () => {
		const { root, anchor, outside } = fixture();
		const from = join(root, "src");
		writeFileSync(from, "data");
		symlinkSync(outside, join(anchor, "ln"));
		expect(() =>
			copyBelow(
				{ anchor: root, file: from },
				{ anchor, file: join(anchor, "ln", "f") },
			),
		).toThrow(/refusing/);
		expect(readdirSync(outside)).toEqual([]);
	});

	test.skipIf(!linux)("refuses a symlinked source parent", () => {
		const { root, anchor, outside } = fixture();
		writeFileSync(join(outside, "secret"), "s");
		symlinkSync(outside, join(anchor, "ln"));
		const dst = join(root, "dst");
		mkdirSync(dst);
		expect(() =>
			copyBelow(
				{ anchor, file: join(anchor, "ln", "secret") },
				{ anchor: dst, file: join(dst, "secret") },
			),
		).toThrow(/refusing/);
		expect(existsSync(join(dst, "secret"))).toBe(false);
	});
});

describe("appendLineBelow", () => {
	const fifoOk =
		linux && spawnSync("sh", ["-c", "command -v mkfifo"]).status === 0;

	test("creates the file and its parents", () => {
		const { anchor } = fixture();
		const f = join(anchor, "a", "b", "f");
		appendLineBelow(anchor, f, "one");
		appendLineBelow(anchor, f, "two");
		expect(readFileSync(f, "utf8")).toBe("one\ntwo\n");
	});

	test("adds a separator when the file lacks a trailing newline", () => {
		const { anchor } = fixture();
		const f = join(anchor, "f");
		writeFileSync(f, "a");
		appendLineBelow(anchor, f, "b");
		expect(readFileSync(f, "utf8")).toBe("a\nb\n");
	});

	test.skipIf(!linux)("refuses a symlink at the file", () => {
		const { anchor, outside } = fixture();
		const target = join(outside, "t");
		writeFileSync(target, "keep");
		const f = join(anchor, "f");
		symlinkSync(target, f);
		expect(() => appendLineBelow(anchor, f, "x")).toThrow(/refusing/);
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	test.skipIf(!linux)("refuses a symlinked parent dir", () => {
		const { anchor, outside } = fixture();
		const target = join(outside, "f");
		writeFileSync(target, "keep");
		symlinkSync(outside, join(anchor, "ln"));
		expect(() => appendLineBelow(anchor, join(anchor, "ln", "f"), "x")).toThrow(
			/refusing/,
		);
		expect(readFileSync(target, "utf8")).toBe("keep");
		expect(readdirSync(outside)).toEqual(["f"]);
	});

	test.skipIf(!fifoOk)("refuses a FIFO without hanging", () => {
		const { anchor } = fixture();
		const f = join(anchor, "fifo");
		expect(spawnSync("mkfifo", [f]).status).toBe(0);
		expect(() => appendLineBelow(anchor, f, "x")).toThrow(/not a regular file/);
		expect(lstatSync(f).isFIFO()).toBe(true);
	});
});

describe("a FIFO in place of the task log", () => {
	const fifoOk =
		linux && spawnSync("sh", ["-c", "command -v mkfifo"]).status === 0;

	function fifoLog(): { anchor: string; log: string } {
		const { anchor } = fixture();
		const log = join(anchor, "logs", "t.log");
		mkdirSync(join(anchor, "logs"));
		expect(spawnSync("mkfifo", [log]).status).toBe(0);
		return { anchor, log };
	}

	test.skipIf(!fifoOk)("appends and touches refuse it without hanging", () => {
		const { anchor, log } = fifoLog();
		expect(() => writeBelow(anchor, log, "x", "append")).toThrow(
			/refusing .*: a FIFO/,
		);
		expect(() => touchBelow(anchor, log)).toThrow(/refusing .*: a FIFO/);
		expect(lstatSync(log).isFIFO()).toBe(true);
	});

	test.skipIf(!fifoOk)("an append refuses it while a reader holds it", () => {
		const { anchor, log } = fifoLog();
		const reader = openSync(log, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			expect(() => writeBelow(anchor, log, "x", "append")).toThrow(
				/not a regular file/,
			);
		} finally {
			closeSync(reader);
		}
	});

	test.skipIf(!fifoOk)("readRegular refuses it without hanging", () => {
		const { log } = fifoLog();
		expect(() => readRegular(log, 1024 * 1024)).toThrow(/not a regular file/);
	});

	test("readRegular reads a regular file", () => {
		const { anchor } = fixture();
		const f = join(anchor, "f");
		writeFileSync(f, "bytes");
		expect(readRegular(f, 1024 * 1024).toString()).toBe("bytes");
	});

	test("readRegular enforces the cap before reading", () => {
		const { anchor } = fixture();
		const f = join(anchor, "f");
		writeFileSync(f, "1234");
		expect(() => readRegular(f, 3)).toThrow(/larger than 3 bytes/);
		expect(readRegular(f, 4).toString()).toBe("1234");
	});

	test.skipIf(!linux)("readRegular refuses a sparse oversized file", () => {
		const { anchor } = fixture();
		const f = join(anchor, "sparse");
		const fd = openSync(f, "w");
		ftruncateSync(fd, 64 * 1024 * 1024);
		closeSync(fd);
		// fstat before read: the refusal never allocates the 64 MiB.
		expect(() => readRegular(f, 1024 * 1024)).toThrow(
			/larger than 1048576 bytes/,
		);
		try {
			readRegular(f, 1024 * 1024);
			expect.unreachable();
		} catch (err) {
			expect(isSizeRefusal(err)).toBe(true);
		}
	});

	test.skipIf(!linux)(
		"readRegular property: a cap at or above the size reads exactly",
		() => {
			const { anchor } = fixture();
			const f = join(anchor, "f");
			fc.assert(
				fc.property(
					fc.uint8Array({ minLength: 0, maxLength: 64 }),
					fc.integer({ min: -2, max: 2 }),
					(bytes, slack) => {
						const cap = bytes.length + slack;
						writeFileSync(f, bytes);
						if (cap < bytes.length) {
							expect(() => readRegular(f, cap)).toThrow(/larger than/);
						} else {
							expect(readRegular(f, cap)).toEqual(Buffer.from(bytes));
						}
					},
				),
			);
		},
	);
});

describe("readBoundedFile", () => {
	test("reads a regular file back", async () => {
		const { anchor } = fixture();
		const f = join(anchor, "f");
		writeFileSync(f, "bytes");
		expect((await readBoundedFile(f, 1024 * 1024)).toString()).toBe("bytes");
	});

	test("refuses an over-cap file with a size refusal; a missing file is not one", async () => {
		const { anchor } = fixture();
		const f = join(anchor, "f");
		writeFileSync(f, "1234");
		try {
			await readBoundedFile(f, 3);
			expect.unreachable();
		} catch (err) {
			expect(String(err)).toMatch(/larger than 3 bytes/);
			expect(isSizeRefusal(err)).toBe(true);
		}
		try {
			await readBoundedFile(join(anchor, "absent"), 1024);
			expect.unreachable();
		} catch (err) {
			expect(err).toMatchObject({ code: "ENOENT" });
			expect(isSizeRefusal(err)).toBe(false);
		}
	});

	test.skipIf(!linux)("refuses a symlink", async () => {
		const { anchor } = fixture();
		const real = join(anchor, "real");
		writeFileSync(real, "bytes");
		const link = join(anchor, "link");
		symlinkSync(real, link);
		await expect(readBoundedFile(link, 1024)).rejects.toThrow(/a symlink/);
	});
});

describe("readTailBounded", () => {
	test("reads [from, size) back", async () => {
		const { anchor } = fixture();
		const f = join(anchor, "f");
		writeFileSync(f, "abcdefgh");
		expect((await readTailBounded(f, 3, 1024)).toString()).toBe("defgh");
	});

	test("answers empty when the file ends at or before from", async () => {
		const { anchor } = fixture();
		const f = join(anchor, "f");
		writeFileSync(f, "abc");
		expect((await readTailBounded(f, 3, 1024)).length).toBe(0);
		expect((await readTailBounded(f, 10, 1024)).length).toBe(0);
	});

	test("refuses an over-cap tail with a size refusal", async () => {
		const { anchor } = fixture();
		const f = join(anchor, "f");
		writeFileSync(f, "abcdefgh");
		try {
			await readTailBounded(f, 2, 3);
			expect.unreachable();
		} catch (err) {
			expect(String(err)).toMatch(/larger than 3 bytes/);
			expect(isSizeRefusal(err)).toBe(true);
		}
	});

	test.skipIf(!linux)("refuses a symlink", async () => {
		const { anchor } = fixture();
		const real = join(anchor, "real");
		writeFileSync(real, "bytes");
		const link = join(anchor, "link");
		symlinkSync(real, link);
		await expect(readTailBounded(link, 0, 1024)).rejects.toThrow(/a symlink/);
	});
});

describe("readBelow", () => {
	test("reads a file up to the cap; null when it or a parent is missing", () => {
		const { anchor } = fixture();
		const f = join(anchor, "a", "f");
		mkdirSync(join(anchor, "a"));
		writeFileSync(f, "four");
		expect(readBelow(anchor, f, 4)?.toString()).toBe("four");
		expect(() => readBelow(anchor, f, 3)).toThrow(/larger than 3 bytes/);
		expect(readBelow(anchor, join(anchor, "a", "none"), 4)).toBeNull();
		expect(readBelow(anchor, join(anchor, "b", "f"), 4)).toBeNull();
	});

	test.skipIf(!linux)("refuses a symlink at the file or a parent", () => {
		const { anchor, outside } = fixture();
		writeFileSync(join(outside, "secret"), "s");
		symlinkSync(join(outside, "secret"), join(anchor, "f"));
		symlinkSync(outside, join(anchor, "ln"));
		expect(() => readBelow(anchor, join(anchor, "f"), 100)).toThrow(
			/refusing .*: a symlink/,
		);
		expect(() => readBelow(anchor, join(anchor, "ln", "secret"), 100)).toThrow(
			/refusing/,
		);
	});

	test("refuses a directory", () => {
		const { anchor } = fixture();
		mkdirSync(join(anchor, "d"));
		expect(() => readBelow(anchor, join(anchor, "d"), 100)).toThrow(
			/not a regular file/,
		);
	});
});

describe("removeBelow", () => {
	/** An outside dir holding `f` with "keep". */
	function sentinel(outside: string): string {
		const f = join(outside, "f");
		writeFileSync(f, "keep");
		return f;
	}

	test("removes a nested tree", () => {
		const { anchor } = fixture();
		const t = join(anchor, "t");
		mkdirSync(join(t, "a", "b"), { recursive: true });
		writeFileSync(join(t, "a", "b", "f"), "x");
		writeFileSync(join(t, "g"), "y");
		writeFileSync(join(anchor, "other"), "z");
		removeBelow(anchor, t);
		expect(existsSync(t)).toBe(false);
		expect(readdirSync(anchor)).toEqual(["other"]);
	});

	test("treats a missing target as no error", () => {
		const { anchor } = fixture();
		removeBelow(anchor, join(anchor, "nope", "deeper"));
		expect(readdirSync(anchor)).toEqual([]);
	});

	test("refuses to remove the anchor itself", () => {
		const { anchor } = fixture();
		writeFileSync(join(anchor, "f"), "x");
		expect(() => removeBelow(anchor, anchor)).toThrow(/refusing/);
		expect(readdirSync(anchor)).toEqual(["f"]);
	});

	test.skipIf(!linux)(
		"unlinks a symlink inside the tree, not its target",
		() => {
			const { anchor, outside } = fixture();
			const f = sentinel(outside);
			const t = join(anchor, "t");
			mkdirSync(join(t, "sub"), { recursive: true });
			symlinkSync(outside, join(t, "sub", "ln"));
			removeBelow(anchor, t);
			expect(existsSync(t)).toBe(false);
			expect(readFileSync(f, "utf8")).toBe("keep");
			expect(readdirSync(outside)).toEqual(["f"]);
		},
	);

	test.skipIf(!linux)(
		"refuses a symlinked parent between anchor and target",
		() => {
			const { anchor, outside } = fixture();
			const f = sentinel(outside);
			mkdirSync(join(outside, "t"));
			writeFileSync(join(outside, "t", "g"), "keep");
			symlinkSync(outside, join(anchor, "ln"));
			expect(() => removeBelow(anchor, join(anchor, "ln", "t"))).toThrow(
				/refusing/,
			);
			expect(readFileSync(f, "utf8")).toBe("keep");
			expect(readFileSync(join(outside, "t", "g"), "utf8")).toBe("keep");
		},
	);

	test.skipIf(!linux)("removes a symlink target as the link only", () => {
		const { anchor, outside } = fixture();
		const f = sentinel(outside);
		const ln = join(anchor, "ln");
		symlinkSync(outside, ln);
		removeBelow(anchor, ln);
		expect(lstatSync(ln, { throwIfNoEntry: false })).toBeUndefined();
		expect(readFileSync(f, "utf8")).toBe("keep");
		expect(readdirSync(outside)).toEqual(["f"]);
	});
});

describe("removeBelow property", () => {
	test.skipIf(!linux)("never removes anything outside the anchor", () => {
		const { root, anchor, outside } = fixture();
		mkdirSync(join(outside, "d"));
		writeFileSync(join(outside, "d", "f"), "keep");
		writeFileSync(join(root, "beside"), "keep");
		// "d" and "f" name real entries behind the links: ln/d/f is outside/d/f
		const seg = fc.constantFrom("..", ".", "a", "b", "ln", "d", "f");
		fc.assert(
			fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), (segs) => {
				// rebuild the tree each run; rmSync does not follow symlinks
				rmSync(anchor, { recursive: true, force: true });
				mkdirSync(join(anchor, "a", "b"), { recursive: true });
				writeFileSync(join(anchor, "a", "b", "f"), "x");
				symlinkSync(outside, join(anchor, "ln"));
				symlinkSync(outside, join(anchor, "a", "ln"));
				symlinkSync(join(outside, "d"), join(anchor, "a", "b", "ln"));
				try {
					removeBelow(anchor, join(anchor, ...segs));
				} catch {
					// refusals are fine; the check below is what matters
				}
				expect(readFileSync(join(outside, "d", "f"), "utf8")).toBe("keep");
				expect(readFileSync(join(root, "beside"), "utf8")).toBe("keep");
				expect(existsSync(anchor)).toBe(true);
			}),
			{
				examples: [
					[["ln", "d"]],
					[["ln", "d", "f"]],
					[["a", "ln", "d"]],
					[["a", "b", "ln", "f"]],
				],
			},
		);
	});
});

describe("trustedAnchor", () => {
	test("returns the OMP_TRACKER_ROOTS entry that holds the path, else the path", () => {
		const saved = process.env.OMP_TRACKER_ROOTS;
		const { root, anchor, outside } = fixture();
		const other = mkdtempSync(join(tmpdir(), "confine-other-"));
		roots.push(other);
		process.env.OMP_TRACKER_ROOTS = ` ${other} ${delimiter}${root}`;
		try {
			expect(trustedAnchor(join(anchor, "p"))).toBe(root);
			expect(trustedAnchor(root)).toBe(root);
			expect(trustedAnchor(`${root}-sibling`)).toBe(`${root}-sibling`);
			delete process.env.OMP_TRACKER_ROOTS;
			expect(trustedAnchor(outside)).toBe(outside);
		} finally {
			if (saved === undefined) delete process.env.OMP_TRACKER_ROOTS;
			else process.env.OMP_TRACKER_ROOTS = saved;
		}
	});
});

/**
 * vm-runner (docs/adr/0009-microvm-workers.md): speaks the worker protocol of
 * serveWorker (src/workers.ts) but runs each /run in its own Firecracker microVM. Per run:
 * a tap slot with the board allow rule, the base rootfs and the project's package layer
 * (src/vmRootfs.ts), a scratch disk, then the guest agent (src/vmGuest.ts) gets the agent
 * layer and copy-in files, runs omp and pushes the task branch to the board itself. The
 * guest's NDJSON is relayed; after its sentinel the copy-out dirs sync back and the VM is
 * torn down. Everything process-related is injected so the tests run without KVM.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	unlinkSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import {
	type BoardAddr,
	boardPort,
	defaultExec,
	type Exec,
	resolveIpv4,
	type Slot,
	slotDown,
	slotFor,
	slotUp,
} from "./vmNet.ts";
import {
	type BakeResult,
	type LayerResult,
	sparseFile,
	workerListPaths,
} from "./vmRootfs.ts";
import {
	type DetachedRun,
	type VmOutcome,
	type VmSpec,
	WORKER_DONE,
	type WorkerRequest,
} from "./workers.ts";
import { stripGitAuthEnv, stripProxyCredentials } from "./worktree.ts";

/* ------------------------------------------------------------------------------------ */
/* tar: the guest's /files format. Written and read here, so the host never runs tar on  */
/* a guest-made archive and never follows a link out of /data/<project>.                 */
/* ------------------------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();
const BLOCK = 512;
/** Largest size an 11-digit octal field holds; bigger files carry a pax size record. */
const OCTAL_MAX = 0o77777777777;

function putString(b: Uint8Array, off: number, len: number, s: string): void {
	b.set(enc.encode(s).subarray(0, len), off);
}

function putOctal(b: Uint8Array, off: number, len: number, n: number): void {
	putString(b, off, len - 1, n.toString(8).padStart(len - 1, "0"));
}

function ustarHeader(
	name: string,
	type: string,
	size: number,
	mode: number,
	mtime: number,
	linkname: string,
): Uint8Array {
	const b = new Uint8Array(BLOCK);
	putString(b, 0, 100, name);
	putOctal(b, 100, 8, mode & 0o7777);
	putOctal(b, 108, 8, 0);
	putOctal(b, 116, 8, 0);
	putOctal(b, 124, 12, Math.min(size, OCTAL_MAX));
	putOctal(b, 136, 12, Math.max(0, Math.floor(mtime)));
	b[156] = type.charCodeAt(0);
	putString(b, 157, 100, linkname);
	putString(b, 257, 6, "ustar\0");
	putString(b, 263, 2, "00");
	b.fill(0x20, 148, 156);
	let sum = 0;
	for (const x of b) sum += x;
	putString(b, 148, 6, sum.toString(8).padStart(6, "0"));
	b[154] = 0;
	return b;
}

/** "<len> key=value\n", where len counts its own digits. */
function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	const bodyLen = enc.encode(body).length;
	// One more digit when adding the digits themselves crosses a power of ten (e.g. 98 → 101).
	let digits = String(bodyLen).length;
	if (String(bodyLen + digits).length > digits) digits++;
	return `${bodyLen + digits}${body}`;
}

const padding = (size: number): Uint8Array =>
	new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** Header blocks of one member: a pax header first when a field outgrows ustar. */
function memberHeader(
	name: string,
	type: string,
	size: number,
	mode: number,
	mtime: number,
	linkname = "",
): Uint8Array[] {
	let pax = "";
	if (enc.encode(name).length > 100) pax += paxRecord("path", name);
	if (enc.encode(linkname).length > 100) pax += paxRecord("linkpath", linkname);
	if (size > OCTAL_MAX) pax += paxRecord("size", String(size));
	const out: Uint8Array[] = [];
	if (pax) {
		const data = enc.encode(pax);
		out.push(
			ustarHeader("PaxHeader", "x", data.length, 0o644, mtime, ""),
			data,
			padding(data.length),
		);
	}
	out.push(ustarHeader(name, type, size, mode, mtime, linkname));
	return out;
}

/**
 * Members of `abs` and everything under it, names relative to / (the guest extracts at /).
 * Symlinks are stored as links, never followed; sockets, fifos and devices are skipped.
 * The path of every regular file sent is added to `sent` when given.
 */
function* walkTar(
	abs: string,
	skip: (abs: string) => boolean,
	sent: Set<string> | undefined,
): Generator<Uint8Array> {
	if (skip(abs)) return;
	let st: Stats;
	try {
		st = lstatSync(abs);
	} catch {
		return; // gone since the listing: nothing to copy
	}
	const name = abs.replace(/^\/+/, "");
	const mtime = st.mtimeMs / 1000;
	if (st.isSymbolicLink()) {
		yield* memberHeader(name, "2", 0, st.mode, mtime, readlinkSync(abs));
	} else if (st.isDirectory()) {
		yield* memberHeader(`${name}/`, "5", 0, st.mode, mtime);
		for (const child of readdirSync(abs).sort())
			yield* walkTar(join(abs, child), skip, sent);
	} else if (st.isFile()) {
		// O_NOFOLLOW: a file swapped for a link after the lstat is refused, not read.
		const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
		let data: Buffer;
		try {
			data = readFileSync(fd);
		} finally {
			closeSync(fd);
		}
		yield* memberHeader(name, "0", data.length, st.mode, mtime);
		sent?.add(posix.normalize(abs));
		yield data;
		yield padding(data.length);
	}
}

/**
 * A tar stream of `roots` (absolute paths), produced lazily one member at a time. A root's
 * `sent` set collects the regular files streamed from it.
 */
export function tarStream(
	roots: {
		path: string;
		skip?: (abs: string) => boolean;
		sent?: Set<string>;
	}[],
): ReadableStream<Uint8Array> {
	function* all(): Generator<Uint8Array> {
		for (const r of roots)
			yield* walkTar(r.path, r.skip ?? (() => false), r.sent);
		yield new Uint8Array(BLOCK * 2);
	}
	const it = all();
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			try {
				const n = it.next();
				if (n.done) controller.close();
				else controller.enqueue(n.value);
			} catch (err) {
				controller.error(err);
			}
		},
	});
}

export interface TarMember {
	/** Path as stored (relative to / for the guest's archives). */
	name: string;
	/** "0" regular file, "5" dir, "2" symlink, ... */
	type: string;
	size: number;
	mode: number;
	/** Seconds since the epoch. */
	mtime: number;
	linkname: string;
}

/** Exact-length reads over a byte stream. */
class ByteQueue {
	private chunks: Uint8Array[] = [];
	private length = 0;
	private ended = false;
	constructor(
		private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
	) {}

	/** Exactly n bytes; null when the stream ended cleanly before the first one. */
	async take(n: number): Promise<Uint8Array | null> {
		while (this.length < n && !this.ended) {
			const r = await this.reader.read();
			if (r.done) this.ended = true;
			else if (r.value.length > 0) {
				this.chunks.push(r.value);
				this.length += r.value.length;
			}
		}
		if (this.length === 0 && n > 0) return null;
		if (this.length < n) throw new Error("tar stream truncated");
		const out = new Uint8Array(n);
		let off = 0;
		while (off < n) {
			const c = this.chunks[0];
			if (c === undefined) throw new Error("tar stream truncated");
			const want = n - off;
			if (c.length <= want) {
				out.set(c, off);
				off += c.length;
				this.chunks.shift();
			} else {
				out.set(c.subarray(0, want), off);
				this.chunks[0] = c.subarray(want);
				off += want;
			}
		}
		this.length -= n;
		return out;
	}
}

function cString(b: Uint8Array, off: number, len: number): string {
	const field = b.subarray(off, off + len);
	const nul = field.indexOf(0);
	return dec.decode(nul === -1 ? field : field.subarray(0, nul));
}

function numeric(b: Uint8Array, off: number, len: number): number {
	const first = b[off];
	if (first === undefined) return 0; // a short block: the octal field reads as empty
	// GNU base-256: the high bit of the first byte marks a binary big-endian number.
	if ((first & 0x80) !== 0) {
		let n = first & 0x7f;
		for (let i = 1; i < len; i++) n = n * 256 + (b[off + i] ?? 0);
		return n;
	}
	const s = cString(b, off, len).trim();
	return s === "" ? 0 : Number.parseInt(s, 8);
}

function parsePax(data: Uint8Array): Map<string, string> {
	const out = new Map<string, string>();
	const text = dec.decode(data);
	let i = 0;
	while (i < text.length) {
		const sp = text.indexOf(" ", i);
		if (sp === -1) break;
		const len = Number(text.slice(i, sp));
		if (!Number.isInteger(len) || len <= 0) break;
		// len counts bytes; the records the guest's tar writes are ASCII paths in practice,
		// and a non-ASCII one only ends the pax parse here, never a wrong offset write.
		const rec = text.slice(sp + 1, i + len - 1);
		const eq = rec.indexOf("=");
		if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
		i += len;
	}
	return out;
}

/** The header's checksum as its stored check field expects it (check field itself blanked). */
function headerChecksum(h: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) {
		const byte = h[i] ?? 0;
		sum += i >= 148 && i < 156 ? 0x20 : byte;
	}
	return sum;
}

/** The names and records the meta headers before a member contribute to it. */
interface TarMeta {
	longName: string | null;
	longLink: string | null;
	pax: Map<string, string>;
}

/**
 * Applies a GNU long-name or pax meta header to `meta`: it carries no member body. False
 * for a real member header.
 */
async function applyMetaHeader(
	type: string,
	size: number,
	readAll: (size: number) => Promise<Uint8Array>,
	meta: TarMeta,
): Promise<boolean> {
	if (type === "L" || type === "K") {
		const v = cString(await readAll(size), 0, size);
		if (type === "L") meta.longName = v;
		else meta.longLink = v;
		return true;
	}
	if (type === "x" || type === "g") {
		const records = parsePax(await readAll(size));
		if (type === "x") meta.pax = records;
		return true;
	}
	return false;
}

/** A member's names and mtime, with the ustar prefix and pax records merged in. */
function memberFields(
	h: Uint8Array,
	meta: TarMeta,
): { name: string; linkname: string; mtime: number } {
	const magic = cString(h, 257, 6);
	const prefix = magic === "ustar" ? cString(h, 345, 155) : "";
	const raw = cString(h, 0, 100);
	const name =
		meta.pax.get("path") ??
		meta.longName ??
		(prefix ? `${prefix}/${raw}` : raw);
	const linkname =
		meta.pax.get("linkpath") ?? meta.longLink ?? cString(h, 157, 100);
	return {
		name,
		linkname,
		mtime: Number(meta.pax.get("mtime") ?? numeric(h, 136, 12)),
	};
}

/** Skips the body the member callback left unread, then the padding of the whole body. */
async function skipBody(
	q: ByteQueue,
	body: number,
	left: number,
): Promise<void> {
	let rest = left;
	while (rest > 0) {
		const n = Math.min(rest, 1024 * 1024);
		await q.take(n);
		rest -= n;
	}
	await q.take(padding(body).length);
}

/** True for the member types whose header never carries a body. */
function bodylessType(type: string): boolean {
	return type === "5" || type === "2" || type === "1";
}

/**
 * The body chunks of one member. `state.left` is shared with the caller: it tracks what
 * the callback left unread, so the skip after it resumes at the right byte.
 */
async function* memberBody(
	q: ByteQueue,
	state: { left: number },
): AsyncGenerator<Uint8Array> {
	while (state.left > 0) {
		const chunk = await q.take(Math.min(state.left, 1024 * 1024));
		if (chunk === null) throw new Error("tar stream truncated");
		state.left -= chunk.length;
		yield chunk;
	}
}

/**
 * Reads a tar stream (ustar, pax, GNU long names) and calls `onMember` for each real member
 * with its data; the data `onMember` leaves unread is skipped.
 */
export async function readTar(
	stream: ReadableStream<Uint8Array>,
	onMember: (m: TarMember, data: AsyncGenerator<Uint8Array>) => Promise<void>,
): Promise<void> {
	const q = new ByteQueue(stream.getReader());
	const meta: TarMeta = { longName: null, longLink: null, pax: new Map() };
	const readAll = async (size: number): Promise<Uint8Array> => {
		const data = await q.take(size);
		if (data === null) throw new Error("tar stream truncated");
		await q.take(padding(size).length);
		return data;
	};
	for (;;) {
		const h = await q.take(BLOCK);
		if (h === null || h.every((x) => x === 0)) return;
		if (headerChecksum(h) !== numeric(h, 148, 8))
			throw new Error("tar header checksum mismatch");
		const typeByte = h[156] ?? 0;
		const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
		const size = numeric(h, 124, 12);
		if (await applyMetaHeader(type, size, readAll, meta)) continue;
		const { name, linkname, mtime } = memberFields(h, meta);
		const paxSize = meta.pax.get("size");
		const stored = paxSize === undefined ? size : Number(paxSize);
		meta.pax = new Map();
		meta.longName = null;
		meta.longLink = null;
		// `state.left` is shared with memberBody: it tracks what the callback left unread.
		const state = { left: bodylessType(type) ? 0 : stored };
		const body = state.left;
		await onMember(
			{ name, type, size: stored, mode: numeric(h, 100, 8), mtime, linkname },
			memberBody(q, state),
		);
		await skipBody(q, body, state.left);
	}
}

/** The absolute host path of a copy-out member, or null when it names a path outside `scope`. */
function copyOutTarget(
	m: TarMember,
	root: string,
	scope: string,
): string | null {
	const parts = m.name.split("/");
	const abs = posix.normalize(`/${m.name}`);
	if (
		m.name.startsWith("/") ||
		parts.includes("..") ||
		!abs.startsWith(`${root}/`) ||
		!abs.startsWith(`${scope}/`)
	)
		return null;
	return abs;
}

/** True when the member may replace an existing file: only one this run copied in. */
function replaceableCopyOut(
	abs: string,
	copiedIn: ReadonlySet<string>,
): boolean {
	try {
		const st = lstatSync(abs);
		return !st.isDirectory() && copiedIn.has(abs);
	} catch {
		return true; // missing: a new file
	}
}

/** Writes one copy-out member through a temp file and rename. */
async function writeCopyOutMember(
	m: TarMember,
	abs: string,
	data: AsyncGenerator<Uint8Array>,
	written: string[],
): Promise<void> {
	const parent = dirname(abs);
	const tmp = join(
		parent,
		`.${posix.basename(abs)}.ottr-copyout-${randomBytes(4).toString("hex")}`,
	);
	const fd = openSync(
		tmp,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		m.mode & 0o777,
	);
	try {
		for await (const chunk of data) {
			let off = 0;
			while (off < chunk.length) off += writeSync(fd, chunk, off);
		}
	} catch (err) {
		closeSync(fd);
		unlinkSync(tmp);
		throw err;
	}
	closeSync(fd);
	utimesSync(tmp, m.mtime, m.mtime);
	renameSync(tmp, abs);
	written.push(abs);
}

/**
 * Extracts the regular files of a guest's copy-out tar for the requested copy-out `dir`,
 * under `root` (/data/<project>). A member outside `dir`, with a ".." component or an
 * absolute name is refused; so is one whose path on the host crosses a symlink or a
 * non-directory, and one whose target already exists unless it is a file this run copied
 * in (`copiedIn`): a VM creates new files and updates its own, never others. Files land
 * through a temp file and rename, which replaces a link at the target instead of writing
 * through it.
 */
export async function extractCopyOut(
	stream: ReadableStream<Uint8Array>,
	root: string,
	dir: string,
	copiedIn: ReadonlySet<string>,
): Promise<{ written: string[]; refused: string[] }> {
	const written: string[] = [];
	const refused: string[] = [];
	const scope = posix.normalize(dir).replace(/\/+$/, "");
	await readTar(stream, async (m, data) => {
		if (m.type !== "0") return;
		const abs = copyOutTarget(m, root, scope);
		if (
			abs === null ||
			!realDirChain(root, dirname(abs)) ||
			!replaceableCopyOut(abs, copiedIn)
		) {
			refused.push(m.name);
			return;
		}
		await writeCopyOutMember(m, abs, data, written);
	});
	return { written, refused };
}

/** True when every component from root to dir is a real directory (created when missing). */
function realDirChain(root: string, dir: string): boolean {
	let cur = root;
	const rest = relative(root, dir);
	for (const part of ["", ...(rest === "" ? [] : rest.split("/"))]) {
		if (part) cur = join(cur, part);
		try {
			const st = lstatSync(cur);
			if (!st.isDirectory()) return false; // a symlink or a file: never crossed
		} catch {
			if (cur === root) return false; // the project's data dir itself must exist
			mkdirSync(cur, { mode: 0o755 });
		}
	}
	return true;
}

/* ------------------------------------------------------------------------------------ */
/* VM launch                                                                             */
/* ------------------------------------------------------------------------------------ */

const GUEST_PORT = 7070;
const GUEST_TOKEN_HEADER = "x-ottr-guest-token";

export interface VmDrive {
	id: "vda" | "vdb" | "vdc";
	path: string;
	readOnly: boolean;
}

export interface VmLaunchSpec {
	/** Per-VM scratch dir: config file, logs. */
	runDir: string;
	mode: "run" | "bake";
	slot: Slot;
	vcpus: number;
	memMiB: number;
	kernel: string;
	drives: VmDrive[];
	bootArgs: string;
}

export interface VmHandle {
	pid: number | null;
	/** Base URL of the guest agent, e.g. http://10.231.0.2:7070. */
	guestUrl: string;
	/** Resolves when the VM process is gone (powered off, crashed or killed). */
	exited: Promise<void>;
	kill(): void;
	/** Last serial console / firecracker output, for the error a dead boot reports. */
	logTail(): string;
}

export type VmLauncher = (spec: VmLaunchSpec) => Promise<VmHandle>;

function bootArgs(a: {
	mode: "run" | "bake";
	slot: Slot;
	token: string;
	boardIp: string;
	boardHost: string;
}): string {
	return [
		"console=ttyS0",
		"reboot=k",
		"panic=1",
		"pci=off",
		"root=/dev/vda",
		"ro",
		"init=/usr/local/bin/ottr-vm-init",
		`ip=${a.slot.guestIp}::${a.slot.hostIp}:255.255.255.252::eth0:off`,
		`ottr.mode=${a.mode}`,
		`ottr.token=${a.token}`,
		`ottr.board=${a.boardIp}`,
		`ottr.boardhost=${a.boardHost}`,
	].join(" ");
}

/** Firecracker's --config-file document for one VM. */
export function firecrackerConfig(spec: VmLaunchSpec): Record<string, unknown> {
	return {
		"boot-source": {
			kernel_image_path: spec.kernel,
			boot_args: spec.bootArgs,
		},
		// No root device flag: root=/dev/vda is on the cmdline already, and the flag would
		// reorder the drives (vda/vdb/vdc follow this list).
		drives: spec.drives.map((d) => ({
			drive_id: d.id,
			path_on_host: d.path,
			is_root_device: false,
			is_read_only: d.readOnly,
		})),
		"machine-config": {
			vcpu_count: spec.vcpus,
			mem_size_mib: spec.memMiB,
			smt: false,
		},
		"network-interfaces": [
			{
				iface_id: "eth0",
				guest_mac: spec.slot.mac,
				host_dev_name: spec.slot.tap,
			},
		],
	};
}

/** The real launcher: one `firecracker --no-api --config-file` process per VM. */
export function firecrackerLauncher(binary: string): VmLauncher {
	return async (spec) => {
		mkdirSync(spec.runDir, { recursive: true });
		const config = join(spec.runDir, `firecracker-${spec.mode}.json`);
		writeFileSync(config, JSON.stringify(firecrackerConfig(spec)));
		const p = Bun.spawn([binary, "--no-api", "--config-file", config], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		let tail = "";
		const keep = async (s: ReadableStream<Uint8Array>): Promise<void> => {
			const d = new TextDecoder();
			for await (const chunk of s)
				tail = `${tail}${d.decode(chunk, { stream: true })}`.slice(-4000);
		};
		keep(p.stdout).catch(() => {});
		keep(p.stderr).catch(() => {});
		return {
			pid: p.pid,
			guestUrl: `http://${spec.slot.guestIp}:${GUEST_PORT}`,
			exited: p.exited.then(() => {}),
			kill: () => {
				if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
			},
			logTail: () => tail,
		};
	};
}

/* ------------------------------------------------------------------------------------ */
/* Request checks                                                                        */
/* ------------------------------------------------------------------------------------ */

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `p` is an absolute path strictly inside `root`, with no ".." component. */
function inside(p: string, root: string): boolean {
	return (
		isAbsolute(p) && !p.split("/").includes("..") && p.startsWith(`${root}/`)
	);
}

/** True when the real location of `p`'s parent is still under `root`'s real location. */
function realParentInside(p: string, root: string): boolean {
	let parent: string;
	let realRoot: string;
	try {
		parent = realpathSync(dirname(p));
		realRoot = realpathSync(root);
	} catch {
		return true; // nothing there yet: the copy skips a missing path anyway
	}
	return parent === realRoot || parent.startsWith(`${realRoot}/`);
}

const isStrings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string");

/** The 400 reason for the spec's scalar fields, null when they are well-formed. */
function checkVmFields(s: Record<string, unknown>): string | null {
	for (const k of ["taskId", "branch", "base", "token"] as const)
		if (typeof s[k] !== "string" || s[k] === "") return `vm.${k} is missing`;
	if (typeof s.boardUrl !== "string" || !/^https?:\/\/[^/]/.test(s.boardUrl))
		return "vm.boardUrl is not an http(s) URL";
	if (!isStrings(s.providers)) return "vm.providers is not a string list";
	if (typeof s.hindsight !== "boolean") return "vm.hindsight is not a boolean";
	return null;
}

/** The 400 reason for vm.layerDir, null when it names a dir under homeRoot. */
function checkLayerDir(
	s: Record<string, unknown>,
	homeRoot: string,
): string | null {
	if (s.layerDir === null) return null;
	if (typeof s.layerDir !== "string" || !inside(s.layerDir, homeRoot))
		return `vm.layerDir must be a dir under ${homeRoot}/`;
	if (!realParentInside(s.layerDir, homeRoot))
		return `vm.layerDir ${s.layerDir} leaves ${homeRoot}/ through a link`;
	return null;
}

/** The 400 reason for the copy lists, null when every path stays in the project's data. */
function checkCopyPaths(
	paths: readonly string[],
	projectRoot: string,
): string | null {
	// The board's own files are only ever this project's: anything else stays on the host.
	for (const p of paths) {
		if (!inside(p, projectRoot))
			return `${p} is outside ${projectRoot}/: refused`;
		if (!realParentInside(p, projectRoot))
			return `${p} leaves ${projectRoot}/ through a link: refused`;
	}
	return null;
}

/** Null when `vm` is a well-formed spec this runner may act on, else the 400 reason. */
function checkVmSpec(
	vm: unknown,
	o: { dataRoot: string; homeRoot: string },
): string | null {
	if (typeof vm !== "object" || vm === null)
		return "vm-runner needs the vm spec (only microVM dispatches go here)";
	const s = vm as Record<string, unknown>;
	const project = s.project;
	if (typeof project !== "string" || !PROJECT_NAME.test(project))
		return "vm.project is not a project name";
	const fields = checkVmFields(s);
	if (fields !== null) return fields;
	if (!isStrings(s.copyIn) || !isStrings(s.copyOut))
		return "vm.copyIn/copyOut are not string lists";
	return (
		checkLayerDir(s, o.homeRoot) ??
		checkCopyPaths([...s.copyIn, ...s.copyOut], join(o.dataRoot, project))
	);
}

/** Paths under the agent layer that never enter a VM: credentials and the board store. */
const LAYER_SKIP = [".omp/oauth", ".ssh", ".config/gh"];

function skipLayerPath(layerDir: string, abs: string): boolean {
	const rel = relative(layerDir, abs);
	if (rel === ".omp/agent/agent.db" || rel.startsWith(".omp/agent/agent.db-"))
		return true; // the store and its -wal/-shm companions
	return LAYER_SKIP.some((s) => rel === s || rel.startsWith(`${s}/`));
}

/** Request env minus anything a VM must not hold (same strips as serveWorker). */
function guestEnv(env: Record<string, string>): Record<string, string> {
	const out: Record<string, string | undefined> = { ...env };
	stripGitAuthEnv(out);
	stripProxyCredentials(out);
	delete out.OTTR_WORKER_TOKEN;
	delete out.ALATE_API_KEY;
	const clean: Record<string, string> = {};
	for (const [k, v] of Object.entries(out)) if (v !== undefined) clean[k] = v;
	return clean;
}

/* ------------------------------------------------------------------------------------ */
/* Server                                                                                */
/* ------------------------------------------------------------------------------------ */

export interface VmRunnerOptions {
	port?: number;
	token?: string | null;
	/** OTTR_VM_MAX: concurrent VMs; /run answers busy at this count. */
	max: number;
	vcpus: number;
	memMiB: number;
	/** OTTR_VM_DISK: apparent size of each run's scratch disk. */
	diskBytes: number;
	stateDir: string;
	kernel: string;
	firecracker: string;
	/** OTTR_VM_BOARD_HOST: the name resolved to the board ip the VMs may reach. */
	boardHost: string;
	/** Startup network setup failure (vmNet.netStartup), null when it succeeded. */
	netError: string | null;
	launcher: VmLauncher;
	rootfs: {
		base(): Promise<{ key: string; path: string }>;
		layer(
			project: string,
			bake: (image: string) => Promise<BakeResult>,
		): Promise<LayerResult>;
	};
	/** ip/iptables/mkfs; the real one spawns. */
	exec?: Exec;
	/** Calls to the guest agents. */
	fetch?: typeof fetch;
	resolveHost?: (host: string) => Promise<string>;
	exists?: (path: string) => boolean;
	now?: () => number;
	/** "/data": copy-in/out roots are <dataRoot>/<project>. */
	dataRoot?: string;
	/** "/root": the read-only shared home (agent layers, package lists). */
	homeRoot?: string;
	/** Guest /healthz wait after boot; 60 s. */
	bootTimeoutMs?: number;
	/** Expiry of /detached entries; 24 h. */
	detachedTtlMs?: number;
}

/** Null when this host can run VMs, else the one-line reason /healthz answers. */
function vmRunnerHealth(
	o: Pick<VmRunnerOptions, "kernel" | "firecracker" | "netError">,
	exists: (path: string) => boolean,
): string | null {
	if (!exists("/dev/kvm"))
		return "/dev/kvm is missing: the vm-runner host needs KVM (nested virtualization on a VM host)";
	if (!exists(o.kernel)) return `the guest kernel ${o.kernel} is missing`;
	if (!exists(o.firecracker))
		return `the firecracker binary ${o.firecracker} is missing`;
	if (o.netError) return `network setup failed: ${o.netError}`;
	return null;
}

interface VmRun extends DetachedRun {
	detached: boolean;
	closeStream(): void;
	/** Stops the run: kills the current VM (bake or run), skips every later step. */
	stop(): void;
}

interface GuestDone {
	exitCode: number | null;
	stderrTail: string;
	vm?: VmOutcome;
}

function parseGuestDone(line: string): GuestDone | null {
	if (!line.includes(WORKER_DONE)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null; // an omp line that mentions the key
	}
	if (typeof parsed !== "object" || parsed === null || !(WORKER_DONE in parsed))
		return null;
	const done: unknown = parsed[WORKER_DONE];
	if (
		typeof done !== "object" ||
		done === null ||
		!("exitCode" in done) ||
		!("stderrTail" in done) ||
		typeof done.stderrTail !== "string"
	)
		return null;
	if (!("vm" in done) || typeof done.vm !== "object" || done.vm === null)
		return {
			exitCode: typeof done.exitCode === "number" ? done.exitCode : null,
			stderrTail: done.stderrTail,
		};
	// Passed through as the guest sent it: the board's sentinel parser (isVmOutcome in
	// src/workers.ts) validates the shape before it trusts a field.
	const vm = done.vm as VmOutcome;
	return {
		exitCode: typeof done.exitCode === "number" ? done.exitCode : null,
		stderrTail: done.stderrTail,
		vm,
	};
}

/** Relays a guest NDJSON body line by line; returns the guest's sentinel, null without one. */
async function relayLines(
	body: ReadableStream<Uint8Array>,
	push: (line: string) => void,
): Promise<GuestDone | null> {
	const d = new TextDecoder();
	let partial = "";
	let done: GuestDone | null = null;
	const line = (l: string): void => {
		const s = parseGuestDone(l);
		if (s) done = s;
		else push(`${l}\n`);
	};
	for await (const chunk of body) {
		partial += d.decode(chunk, { stream: true });
		let idx = partial.indexOf("\n");
		while (idx >= 0) {
			line(partial.slice(0, idx));
			partial = partial.slice(idx + 1);
			idx = partial.indexOf("\n");
		}
	}
	partial += d.decode();
	if (partial.length > 0) line(partial);
	return done;
}

const errText = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

/** Removes a finished run's dir; the next vm-runner start wipes runs/ anyway. */
function removeRunDir(runDir: string): void {
	try {
		rmSync(runDir, { recursive: true, force: true });
	} catch {
		// a throw here would skip the slot release and strand the run's stream
	}
}

export function serveVmRunner(opts: VmRunnerOptions): Bun.Server<never> {
	const exec = opts.exec ?? defaultExec;
	const guestFetch = opts.fetch ?? fetch;
	const resolveHost = opts.resolveHost ?? resolveIpv4;
	const exists = opts.exists ?? existsSync;
	const now = opts.now ?? Date.now;
	const dataRoot = opts.dataRoot ?? "/data";
	const homeRoot = opts.homeRoot ?? "/root";
	const host = hostname();
	// Slot indexes in use, reserved when /run is accepted and freed after teardown: the
	// busy answer counts these, so a VM still booting or tearing down holds its place.
	const slots = new Set<number>();
	const active = new Map<string, VmRun>();
	const detached = new Map<string, VmRun>();
	const pruneDetached = (): void => {
		const ttl = opts.detachedTtlMs ?? 24 * 60 * 60 * 1000;
		const t = now();
		for (const [id, e] of detached)
			if (t - e.startedAt > ttl) detached.delete(id);
	};
	const authorized = (request: Request): boolean =>
		!opts.token || request.headers.get("x-otwr-token") === opts.token;

	/** True once the guest agent answered /healthz with a 200. */
	async function guestHealthy(
		vm: VmHandle,
		signal: AbortSignal,
	): Promise<boolean> {
		try {
			const r = await guestFetch(`${vm.guestUrl}/healthz`, {
				signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
			});
			return r.ok;
		} catch {
			return false; // not up yet
		}
	}

	/** Waits until the guest agent answers /healthz; throws with the boot log otherwise. */
	async function waitGuest(vm: VmHandle, signal: AbortSignal): Promise<void> {
		let gone = false;
		void vm.exited.then(() => {
			gone = true;
		});
		const deadline = now() + (opts.bootTimeoutMs ?? 60_000);
		while (now() < deadline) {
			if (signal.aborted) throw new Error("stopped");
			if (gone)
				throw new Error(
					`the microVM exited during boot: ${vm.logTail().trim().slice(-1500)}`,
				);
			if (await guestHealthy(vm, signal)) return;
			await Bun.sleep(200);
		}
		throw new Error(
			`the microVM did not answer within ${Math.round((opts.bootTimeoutMs ?? 60_000) / 1000)} s: ${vm.logTail().trim().slice(-1500)}`,
		);
	}

	async function putFiles(
		vm: VmHandle,
		token: string,
		roots: {
			path: string;
			skip?: (abs: string) => boolean;
			sent?: Set<string>;
		}[],
		signal: AbortSignal,
	): Promise<void> {
		const present = roots.filter((r) => {
			try {
				lstatSync(r.path);
				return true;
			} catch {
				return false;
			}
		});
		if (present.length === 0) return;
		const r = await guestFetch(`${vm.guestUrl}/files`, {
			method: "PUT",
			headers: { [GUEST_TOKEN_HEADER]: token },
			body: tarStream(present),
			signal,
		});
		if (!r.ok)
			throw new Error(
				`the guest refused the files: ${r.status} ${(await r.text()).slice(0, 500)}`,
			);
	}

	function startRun(
		body: WorkerRequest,
		spec: VmSpec,
		index: number,
	): Response {
		const slot = slotFor(index);
		const runDir = join(
			opts.stateDir,
			"runs",
			`${index}-${randomBytes(4).toString("hex")}`,
		);
		const stopper = new AbortController();
		let current: VmHandle | null = null;
		const entry: VmRun = {
			id: body.id,
			cwd: body.cwd,
			pid: null,
			running: true,
			startedAt: now(),
			detached: false,
			closeStream: () => {},
			stop: () => {
				stopper.abort();
				current?.kill();
			},
		};
		active.set(entry.id, entry);
		const stopIfAttached = (): void => {
			// Detach releases the client on purpose: nothing on the dead request may kill
			// the VM afterwards.
			if (!entry.detached) entry.stop();
		};

		const boot = async (
			mode: "run" | "bake",
			drives: VmDrive[],
			board: BoardAddr,
			boardName: string,
			guestToken: string,
		): Promise<VmHandle> => {
			const vm = await opts.launcher({
				runDir: join(runDir, mode),
				mode,
				slot,
				vcpus: opts.vcpus,
				memMiB: opts.memMiB,
				kernel: opts.kernel,
				drives,
				bootArgs: bootArgs({
					mode,
					slot,
					token: guestToken,
					boardIp: board.ip,
					boardHost: boardName,
				}),
			});
			current = vm;
			entry.pid = vm.pid;
			// A stop that raced the launch: the VM must not outlive it.
			if (stopper.signal.aborted) vm.kill();
			return vm;
		};
		const halt = async (vm: VmHandle): Promise<void> => {
			vm.kill();
			await vm.exited;
			if (current === vm) current = null;
		};
		/** Aborts when the run stops or the VM dies mid-flight. */
		const guestSignal = (vm: VmHandle): AbortSignal => {
			const gone = new AbortController();
			void vm.exited.then(() => gone.abort());
			return AbortSignal.any([stopper.signal, gone.signal]);
		};

		/** Asks the booted bake VM to install the project's packages into its layer. */
		const bakeTurn = async (
			push: (text: string) => void,
			vm: VmHandle,
			token: string,
			signal: AbortSignal,
		): Promise<BakeResult> => {
			const r = await guestFetch(`${vm.guestUrl}/bake`, {
				method: "POST",
				headers: {
					[GUEST_TOKEN_HEADER]: token,
					"content-type": "application/json",
				},
				body: JSON.stringify({ project: spec.project }),
				signal,
			});
			if (!r.ok || !r.body)
				return {
					exitCode: 1,
					stderrTail: `the bake guest answered ${r.status}: ${(await r.text()).slice(0, 500)}\n`,
				};
			// The bake's install notes lead the stream as plain lines, as the
			// apt notes of a classic worker do.
			const done = await relayLines(r.body, push).catch(() => null);
			return (
				done ?? {
					exitCode: 1,
					stderrTail: `the bake microVM died: ${vm.logTail().trim().slice(-1500)}\n`,
				}
			);
		};

		const bake =
			(
				base: string,
				board: BoardAddr,
				boardName: string,
				push: (text: string) => void,
			) =>
			async (image: string): Promise<BakeResult> => {
				const token = randomBytes(16).toString("hex");
				let vm: VmHandle | null = null;
				try {
					vm = await boot(
						"bake",
						[
							{ id: "vda", path: base, readOnly: true },
							{ id: "vdb", path: image, readOnly: false },
						],
						board,
						boardName,
						token,
					);
					const signal = guestSignal(vm);
					await waitGuest(vm, signal);
					await putFiles(
						vm,
						token,
						workerListPaths(homeRoot, spec.project).map((path) => ({
							path,
						})),
						signal,
					);
					return await bakeTurn(push, vm, token, signal);
				} catch (err) {
					return { exitCode: 1, stderrTail: `${errText(err)}\n` };
				} finally {
					if (vm) await halt(vm);
				}
			};

		/** The per-run scratch disk, formatted fresh; throws when mkfs.ext4 fails. */
		const newScratch = async (): Promise<string> => {
			const scratch = join(runDir, "scratch.ext4");
			sparseFile(scratch, opts.diskBytes);
			const mkfs = await exec(["mkfs.ext4", "-F", "-q", scratch]);
			if (mkfs.code !== 0)
				throw new Error(`mkfs.ext4 scratch: ${mkfs.stderr.trim()}`);
			return scratch;
		};

		/** The copy-in roots: the project's package layer, then the request's files. */
		const copyInRoots = (copiedIn: Set<string>) => [
			...(spec.layerDir
				? [
						{
							path: spec.layerDir,
							skip: (abs: string) =>
								skipLayerPath(spec.layerDir as string, abs),
						},
					]
				: []),
			...spec.copyIn.map((path) => ({ path, sent: copiedIn })),
		];

		/** Pulls one copy-out dir back into the project's data root; throws on failure. */
		const copyOutDir = async (
			push: (text: string) => void,
			vm: VmHandle,
			token: string,
			runStart: number,
			signal: AbortSignal,
			dir: string,
			copiedIn: Set<string>,
		): Promise<void> => {
			const files = await guestFetch(
				`${vm.guestUrl}/files?path=${encodeURIComponent(dir)}&since=${runStart}`,
				{ headers: { [GUEST_TOKEN_HEADER]: token }, signal },
			);
			if (!files.ok || !files.body)
				throw new Error(`guest answered ${files.status}`);
			const out = await extractCopyOut(
				files.body,
				join(dataRoot, spec.project),
				dir,
				copiedIn,
			);
			for (const name of out.refused)
				push(`vm-runner: refused copy-out of ${name}\n`);
		};

		/** Syncs the copy-out dirs back; a failed dir notes it and keeps the turn's result. */
		const copyOutDirs = async (
			push: (text: string) => void,
			vm: VmHandle,
			token: string,
			runStart: number,
			signal: AbortSignal,
			copiedIn: Set<string>,
		): Promise<void> => {
			for (const dir of spec.copyOut) {
				try {
					await copyOutDir(push, vm, token, runStart, signal, dir, copiedIn);
				} catch (err) {
					// The turn's own result stands; the note says what stayed behind.
					push(`vm-runner: copy-out of ${dir} failed: ${errText(err)}\n`);
				}
			}
		};

		/** The turn in a booted VM: run omp, relay its NDJSON, then copy out. */
		const runTurn = async (
			push: (text: string) => void,
			vm: VmHandle,
			token: string,
			runStart: number,
		): Promise<GuestDone | null> => {
			const signal = guestSignal(vm);
			await waitGuest(vm, signal);
			// The regular files this run copied in: the only existing files
			// copy-out may replace.
			const copiedIn = new Set<string>();
			await putFiles(vm, token, copyInRoots(copiedIn), signal);
			const r = await guestFetch(`${vm.guestUrl}/run`, {
				method: "POST",
				headers: {
					[GUEST_TOKEN_HEADER]: token,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					argv: body.argv,
					cwd: body.cwd,
					// The delivered read-only GitHub token merges after the strip
					// (docs/specs/turn-read-token.md): it survives it and overrides
					// any ambient name.
					env: {
						...guestEnv(body.env ?? {}),
						...(body.githubReadEnv ?? {}),
					},
					stdin: body.stdin,
					vm: {
						gitUrl: `${spec.boardUrl.replace(/\/+$/, "")}/git/${spec.project}.git`,
						branch: spec.branch,
						base: spec.base,
						token: spec.token,
						boardUrl: spec.boardUrl,
						providers: spec.providers,
						hindsight: spec.hindsight,
					},
				}),
				signal,
			});
			if (!r.ok || !r.body)
				throw new Error(
					`the guest refused the run: ${r.status} ${(await r.text()).slice(0, 500)}`,
				);
			// A VM that dies mid-run ends without a sentinel: the board settles
			// the turn as lost, as for a dead worker.
			const done = await relayLines(r.body, push).catch(() => null);
			if (!done || stopper.signal.aborted) return null;
			await copyOutDirs(push, vm, token, runStart, signal, copiedIn);
			return done;
		};

		/** Builds the base and layer disks, then runs one turn in a fresh VM. */
		const runDrive = async (
			push: (text: string) => void,
			board: BoardAddr,
			boardName: string,
		): Promise<GuestDone | null> => {
			mkdirSync(runDir, { recursive: true });
			const base = await opts.rootfs.base();
			if (stopper.signal.aborted) return null;
			const layer = await opts.rootfs.layer(
				spec.project,
				bake(base.path, board, boardName, push),
			);
			if (stopper.signal.aborted) return null;
			// Like a failed apt install on a classic worker: the turn ends with
			// the install's error.
			if (!layer.ok) return { exitCode: 1, stderrTail: layer.stderrTail };
			const scratch = await newScratch();
			const runStart = now();
			const token = randomBytes(16).toString("hex");
			const vm = await boot(
				"run",
				[
					{ id: "vda", path: base.path, readOnly: true },
					{ id: "vdb", path: layer.path, readOnly: true },
					{ id: "vdc", path: scratch, readOnly: false },
				],
				board,
				boardName,
				token,
			);
			try {
				return await runTurn(push, vm, token, runStart);
			} finally {
				await halt(vm);
			}
		};

		const drive = async (
			push: (text: string) => void,
		): Promise<GuestDone | null> => {
			const resolved = await resolveHost(opts.boardHost);
			const board: BoardAddr = {
				ip: resolved,
				port: boardPort(spec.boardUrl),
			};
			// The guest's /etc/hosts maps the boardUrl's own host name to the board ip.
			const boardName = new URL(spec.boardUrl).hostname;
			await slotUp(exec, slot, board);
			try {
				return await runDrive(push, board, boardName);
			} finally {
				await slotDown(exec, slot, board);
			}
		};

		// No client listens any more: the result waits in /detached.
		const settleDetached = (done: GuestDone | null): void => {
			if (done && !entry.killed)
				entry.result = {
					exitCode: done.exitCode,
					stderrTail: done.stderrTail,
					...(done.vm ? { vm: done.vm } : {}),
				};
		};

		const pushDone = (push: (text: string) => void, done: GuestDone): void => {
			push(
				`${JSON.stringify({
					[WORKER_DONE]: {
						exitCode: done.exitCode,
						stderrTail: done.stderrTail,
						host,
						...(done.vm ? { vm: done.vm } : {}),
					},
				})}\n`,
			);
		};

		const finish = (
			push: (text: string) => void,
			done: GuestDone | null,
		): void => {
			removeRunDir(runDir);
			slots.delete(index);
			if (active.get(entry.id) === entry) active.delete(entry.id);
			entry.running = false;
			if (entry.detached) {
				settleDetached(done);
				return;
			}
			if (done && !stopper.signal.aborted) pushDone(push, done);
			entry.closeStream();
		};

		let closed = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				entry.closeStream = (): void => {
					if (closed) return;
					closed = true;
					try {
						controller.close();
					} catch {
						// already gone
					}
				};
				const push = (text: string): void => {
					if (closed) return;
					try {
						controller.enqueue(enc.encode(text));
					} catch {
						closed = true; // the stream ended without cancel(): nobody reads now
						stopIfAttached();
					}
				};

				drive(push).then(
					(done) => finish(push, done),
					(err) => {
						// A setup failure (tap, disks, boot) is the runner's, not omp's: it ends
						// the turn like a failed install, unless a stop caused it.
						finish(
							push,
							stopper.signal.aborted
								? null
								: { exitCode: 1, stderrTail: `vm-runner: ${errText(err)}\n` },
						);
					},
				);
			},
			cancel() {
				closed = true;
				stopIfAttached();
			},
		});
		return new Response(stream, {
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}

	/** Releases every active run's stream: the board restart drops them, but keeps the VMs. */
	const detachAll = (): Response => {
		// The board restart drops every /run stream: release them all, keep the VMs.
		let n = 0;
		for (const [id, e] of active) {
			e.detached = true;
			e.closeStream();
			detached.set(id, e);
			active.delete(id);
			n++;
		}
		return Response.json({ detached: n });
	};

	const listDetached = (): Response => {
		pruneDetached();
		return Response.json(
			[...detached.values()].map(
				({ closeStream: _c, detached: _d, stop: _s, ...entry }) => entry,
			),
		);
	};

	const killDetached = async (request: Request): Promise<Response> => {
		pruneDetached();
		let body: { id?: string };
		try {
			body = (await request.json()) as { id?: string };
		} catch {
			return new Response("bad json", { status: 400 });
		}
		const e = typeof body.id === "string" ? detached.get(body.id) : undefined;
		if (!e) return new Response("not found", { status: 404 });
		if (e.running) e.stop();
		e.killed = true;
		e.running = false;
		return Response.json({ killed: true });
	};

	/** The detach API's answer, or null when it is not one of its routes and method pairs. */
	const handleDetach = async (
		request: Request,
		url: URL,
	): Promise<Response | null> => {
		if (
			url.pathname !== "/detach" &&
			url.pathname !== "/detached" &&
			url.pathname !== "/detach/kill"
		)
			return null;
		if (!authorized(request))
			return new Response("unauthorized", { status: 401 });
		if (request.method === "POST" && url.pathname === "/detach")
			return detachAll();
		if (request.method === "GET" && url.pathname === "/detached")
			return listDetached();
		if (request.method === "POST" && url.pathname === "/detach/kill")
			return killDetached(request);
		return null; // the request falls through to the /run checks below
	};

	/** A free slot index, -1 when every one of opts.max is taken. */
	const freeSlot = (): number => {
		for (let i = 0; i < opts.max; i++) if (!slots.has(i)) return i;
		return -1;
	};

	/** The 400 reason the /run body gives, null when the request is well-formed. */
	function checkRunBody(body: WorkerRequest): string | null {
		if (
			typeof body.id !== "string" ||
			!Array.isArray(body.argv) ||
			!body.argv.every((a) => typeof a === "string") ||
			typeof body.cwd !== "string" ||
			!isAbsolute(body.cwd) ||
			typeof body.stdin !== "string"
		)
			return "bad request";
		return null;
	}

	/** The POST /run endpoint: validates the request, then boots the VM and answers its stream. */
	async function runEndpoint(request: Request): Promise<Response> {
		let body: WorkerRequest;
		try {
			body = (await request.json()) as WorkerRequest;
		} catch {
			return new Response("bad json", { status: 400 });
		}
		if (checkRunBody(body) !== null)
			return new Response("bad request", { status: 400 });
		const refusal = checkVmSpec(body.vm, { dataRoot, homeRoot });
		if (refusal !== null) return new Response(refusal, { status: 400 });
		const spec = body.vm as VmSpec;
		// Not the busy answer: a host that cannot boot VMs is down, which the board's
		// health probe already shows.
		const health = vmRunnerHealth(opts, exists);
		if (health !== null) return new Response(health, { status: 503 });
		const index = freeSlot();
		if (index === -1)
			return new Response(`all ${opts.max} microVMs are taken`, {
				status: 503,
				headers: { "x-ottr-busy": "1" },
			});
		slots.add(index);
		const response = startRun(body, spec, index);
		request.signal.addEventListener("abort", () => {
			const e = active.get(body.id);
			if (e && !e.detached) e.stop();
		});
		return response;
	}

	return Bun.serve({
		port: opts.port ?? 8787,
		hostname: "0.0.0.0",
		// Long silent turns must not be cut by an idle timeout.
		idleTimeout: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/healthz") {
				const reason = vmRunnerHealth(opts, exists);
				return reason === null
					? new Response("ok")
					: new Response(reason, { status: 503 });
			}
			const answered = await handleDetach(request, url);
			if (answered !== null) return answered;
			// /sweep and /signins are classic-worker concerns: a VM leaves no process behind
			// and holds no omp store.
			if (request.method !== "POST" || url.pathname !== "/run")
				return new Response("not found", { status: 404 });
			if (!authorized(request))
				return new Response("unauthorized", { status: 401 });
			return runEndpoint(request);
		},
	});
}

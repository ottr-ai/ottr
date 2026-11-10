import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { withDir, writeBelow } from "./confine.ts";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type ImageExt = "png" | "jpg" | "gif" | "webp";

export interface DecodedImage {
	bytes: Buffer;
	ext: ImageExt;
}

/** Type from the first bytes only; null for anything else. */
export function sniffImage(bytes: Uint8Array): ImageExt | null {
	const b = bytes;
	const ascii = (off: number, s: string): boolean =>
		s.split("").every((c, i) => b[off + i] === c.charCodeAt(0));
	if (ascii(0, "\x89PNG\r\n\x1a\n")) return "png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
	return null;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validates a request body's `images` field. undefined -> { images: [] }. */
export function decodeImages(
	input: unknown,
	max: number,
): { images: DecodedImage[] } | { error: string } {
	if (input === undefined) return { images: [] };
	if (!Array.isArray(input) || input.some((e) => typeof e !== "string")) {
		return { error: "images must be an array of base64 strings" };
	}
	const strs = input as string[];
	if (strs.length > max) return { error: `at most ${max} images per message` };
	const images: DecodedImage[] = [];
	for (const [i, s] of strs.entries()) {
		const n = i + 1;
		if (!BASE64_RE.test(s) || s.length % 4 !== 0) {
			return { error: `image ${n} is not valid base64` };
		}
		// ponytail: size from length before decoding (length/4*3 minus padding), no partial buffer
		const size = (s.length / 4) * 3 - (s.match(/=/g)?.length ?? 0);
		if (size > MAX_IMAGE_BYTES)
			return { error: `image ${n} is larger than 10 MiB` };
		const bytes = Buffer.from(s, "base64");
		const ext = sniffImage(bytes);
		if (ext === null)
			return { error: `image ${n} is not a PNG, JPEG, GIF or WebP file` };
		images.push({ bytes, ext });
	}
	return { images };
}

/** Sync. Writes images into dir as <n>.<ext>, continuing after the highest existing number; creates dir; returns the file names in order.
 * root is the trusted anchor: a symlink at or below it refuses the write (see src/confine.ts). */
export function saveImages(
	root: string,
	dir: string,
	images: DecodedImage[],
): string[] {
	if (images.length === 0) return [];
	const existing = withDir(root, dir, { create: true }, (d) => d.list());
	let n = 0;
	for (const name of existing) {
		const m = /^(\d+)\.(png|jpg|gif|webp)$/.exec(name);
		if (m) n = Math.max(n, Number(m[1]));
	}
	const names: string[] = [];
	for (const img of images) {
		n += 1;
		const name = `${n}.${img.ext}`;
		writeBelow(root, join(dir, name), img.bytes, "exclusive");
		names.push(name);
	}
	return names;
}

const INFLATE_PIXEL_CAP = 64_000_000;

export type Rgba = { w: number; h: number; rgba: Uint8Array };

/** Reads one byte with an explicit presence check: TS cannot relate the index to the length. */
function byteAt(b: Uint8Array, i: number): number {
	const v = b[i];
	return v ?? 0;
}

function u32be(b: Uint8Array, off: number): number {
	return (
		((byteAt(b, off) << 24) |
			(byteAt(b, off + 1) << 16) |
			(byteAt(b, off + 2) << 8) |
			byteAt(b, off + 3)) >>>
		0
	);
}

/**
 * Decodes the PNG subset that screenshot tools write: 8-bit gray, gray+alpha,
 * RGB or RGBA, non-interlaced. Anything else (palette, 16-bit, interlaced,
 * truncated, or not a PNG at all) returns null; the caller falls back to
 * byte-level equality. Alpha composites over black.
 */
type PngHeader = { w: number; h: number; channels: number };
type PngBody = PngHeader & { raw: Buffer };

/** Channels for the supported 8-bit color types; 0 for the unsupported ones. */
function colorChannels(colorType: number): number {
	switch (colorType) {
		case 0:
			return 1;
		case 2:
			return 3;
		case 4:
			return 2;
		case 6:
			return 4;
		default:
			return 0;
	}
}

/** Parses the IHDR payload; null when unsupported or the pixel count exceeds the inflate cap. */
function parseIhdr(bytes: Uint8Array, dataStart: number): PngHeader | null {
	const w = u32be(bytes, dataStart);
	const h = u32be(bytes, dataStart + 4);
	const colorType = byteAt(bytes, dataStart + 9);
	const ok =
		byteAt(bytes, dataStart + 8) === 8 && // bit depth
		byteAt(bytes, dataStart + 10) === 0 && // compression
		byteAt(bytes, dataStart + 11) === 0 && // filter method
		byteAt(bytes, dataStart + 12) === 0; // interlace
	const channels = colorChannels(colorType);
	if (!ok || channels === 0) return null;
	if (w === 0 || h === 0 || w * h > INFLATE_PIXEL_CAP) return null;
	return { w, h, channels };
}

/** Consumes one IHDR or IDAT chunk and returns the running header, or null when the chunk is invalid in sequence. */
function readDataChunk(
	type: string,
	len: number,
	bytes: Uint8Array,
	dataStart: number,
	header: PngHeader | null,
	idat: Buffer[],
): PngHeader | null {
	if (type === "IHDR") {
		if (len !== 13 || header !== null) return null;
		return parseIhdr(bytes, dataStart);
	}
	if (type === "IDAT") {
		if (header === null) return null;
		idat.push(Buffer.from(bytes.subarray(dataStart, dataStart + len)));
	}
	return header;
}

/** Walks the chunk stream and inflates the concatenated IDAT payload; null on structural problems. */
function parsePngChunks(bytes: Uint8Array): PngBody | null {
	const idat: Buffer[] = [];
	let header: PngHeader | null = null;
	let sawEnd = false;
	let off = 8;
	while (off + 12 <= bytes.length) {
		const len = u32be(bytes, off);
		const dataStart = off + 8;
		const dataEnd = dataStart + len;
		if (dataEnd + 4 > bytes.length) return null; // truncated chunk
		const type = String.fromCharCode(
			byteAt(bytes, off + 4),
			byteAt(bytes, off + 5),
			byteAt(bytes, off + 6),
			byteAt(bytes, off + 7),
		);
		if (type === "IEND") {
			sawEnd = true;
			break;
		}
		if (type === "IHDR" || type === "IDAT") {
			const next = readDataChunk(type, len, bytes, dataStart, header, idat);
			if (next === null) return null;
			header = next;
		}
		off = dataEnd + 4; // CRC
	}
	if (header === null || !sawEnd || idat.length === 0) return null;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = header.w * header.channels;
	if (raw.length < header.h * (stride + 1)) return null;
	return { w: header.w, h: header.h, channels: header.channels, raw };
}

/** Paeth predictor for filter type 4. */
function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses one row's filter into cur; a, b and c are the Paeth neighbors. */
function unfilterRow(
	raw: Buffer,
	row: number,
	cur: Uint8Array,
	prev: Uint8Array,
	stride: number,
	channels: number,
	filter: number,
): void {
	for (let x = 0; x < stride; x++) {
		const a = x >= channels ? byteAt(cur, x - channels) : 0;
		const b = byteAt(prev, x);
		const c = x >= channels ? byteAt(prev, x - channels) : 0;
		let v = byteAt(raw, row + 1 + x);
		if (filter === 1) v = (v + a) & 0xff;
		else if (filter === 2) v = (v + b) & 0xff;
		else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
		else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
		cur[x] = v;
	}
}

/** Writes one unfiltered row into rgba as 8-bit RGBA; alpha composites over black. */
function writeRow(
	rgba: Uint8Array,
	cur: Uint8Array,
	y: number,
	w: number,
	channels: number,
): void {
	for (let x = 0; x < w; x++) {
		const o = (y * w + x) * 4;
		if (channels === 1) {
			rgba[o] = rgba[o + 1] = rgba[o + 2] = byteAt(cur, x);
			rgba[o + 3] = 255;
		} else if (channels === 2) {
			rgba[o] = rgba[o + 1] = rgba[o + 2] = byteAt(cur, x * 2);
			rgba[o + 3] = byteAt(cur, x * 2 + 1);
		} else if (channels === 3) {
			rgba[o] = byteAt(cur, x * 3);
			rgba[o + 1] = byteAt(cur, x * 3 + 1);
			rgba[o + 2] = byteAt(cur, x * 3 + 2);
			rgba[o + 3] = 255;
		} else {
			rgba[o] = byteAt(cur, x * 4);
			rgba[o + 1] = byteAt(cur, x * 4 + 1);
			rgba[o + 2] = byteAt(cur, x * 4 + 2);
			rgba[o + 3] = byteAt(cur, x * 4 + 3);
		}
	}
}

/** Unfilters all rows into an RGBA buffer; null when a row uses an unsupported filter byte. */
function unfilterRgba(
	raw: Buffer,
	w: number,
	h: number,
	channels: number,
): Uint8Array | null {
	const stride = w * channels;
	const rgba = new Uint8Array(w * h * 4);
	let prev = new Uint8Array(stride);
	let cur = new Uint8Array(stride);
	for (let y = 0; y < h; y++) {
		const row = y * (stride + 1);
		const filter = byteAt(raw, row);
		if (filter > 4) return null;
		unfilterRow(raw, row, cur, prev, stride, channels, filter);
		writeRow(rgba, cur, y, w, channels);
		[prev, cur] = [cur, prev]; // cur is fully rewritten each row
	}
	return rgba;
}

/**
 * Decodes the PNG subset that screenshot tools write: 8-bit gray, gray+alpha,
 * RGB or RGBA, non-interlaced. Anything else (palette, 16-bit, interlaced,
 * truncated, or not a PNG at all) returns null; the caller falls back to
 * byte-level equality. Alpha composites over black.
 */
export function decodePng(bytes: Uint8Array): Rgba | null {
	try {
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		if (bytes.length < 8 || sig.some((c, i) => bytes[i] !== c)) return null;
		const body = parsePngChunks(bytes);
		if (body === null) return null;
		const rgba = unfilterRgba(body.raw, body.w, body.h, body.channels);
		if (rgba === null) return null;
		return { w: body.w, h: body.h, rgba };
	} catch {
		return null; // bad zlib stream or any structural surprise
	}
}

/** 16×16 grayscale downsample, row-major, one byte per cell. */
export function gray16(pixels: Rgba): Uint8Array {
	const cells = new Uint8Array(256);
	for (let gy = 0; gy < 16; gy++) {
		const y0 = Math.floor((gy * pixels.h) / 16);
		const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * pixels.h) / 16));
		for (let gx = 0; gx < 16; gx++) {
			const x0 = Math.floor((gx * pixels.w) / 16);
			const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * pixels.w) / 16));
			let sum = 0;
			let n = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const o = (y * pixels.w + x) * 4;
					const alpha = byteAt(pixels.rgba, o + 3) / 255;
					sum +=
						(0.299 * byteAt(pixels.rgba, o) +
							0.587 * byteAt(pixels.rgba, o + 1) +
							0.114 * byteAt(pixels.rgba, o + 2)) *
						alpha;
					n++;
				}
			}
			cells[gy * 16 + gx] = n === 0 ? 0 : Math.min(255, Math.round(sum / n));
		}
	}
	return cells;
}

/** decodePng + gray16 in one step; null when the bytes are not a decodable PNG. */
export function pngGray16(bytes: Uint8Array): Uint8Array | null {
	const pixels = decodePng(bytes);
	return pixels === null ? null : gray16(pixels);
}

const CELL_NOISE = 8; // gray levels per cell that count as capture noise
const CELL_NOISE_MAX = 8; // cells that may exceed the noise band (of 256)

/**
 * True when two gray16 vectors show the same screen: a re-capture of an
 * unchanged display (fresh compression, antialias jitter) matches, while a
 * layout or content change shifts too many cells. Undecodable formats never
 * reach this; their dedup stays byte-exact.
 */
export function visuallyIdentical(a: Uint8Array, b: Uint8Array): boolean {
	let differing = 0;
	for (let i = 0; i < 256; i++) {
		if (
			Math.abs(byteAt(a, i) - byteAt(b, i)) > CELL_NOISE &&
			++differing > CELL_NOISE_MAX
		)
			return false;
	}
	return true;
}

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

function u32be(b: Uint8Array, off: number): number {
	return (
		((b[off]! << 24) |
			(b[off + 1]! << 16) |
			(b[off + 2]! << 8) |
			b[off + 3]!) >>>
		0
	);
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
		let w = 0;
		let h = 0;
		let channels = 0;
		const idat: Buffer[] = [];
		let sawHeader = false;
		let sawEnd = false;
		let off = 8;
		while (off + 12 <= bytes.length) {
			const len = u32be(bytes, off);
			const dataStart = off + 8;
			const dataEnd = dataStart + len;
			if (dataEnd + 4 > bytes.length) return null; // truncated chunk
			const type = String.fromCharCode(
				bytes[off + 4]!,
				bytes[off + 5]!,
				bytes[off + 6]!,
				bytes[off + 7]!,
			);
			if (type === "IHDR") {
				if (len !== 13 || sawHeader) return null;
				w = u32be(bytes, dataStart);
				h = u32be(bytes, dataStart + 4);
				const colorType = bytes[dataStart + 9];
				const ok =
					bytes[dataStart + 8] === 8 && // bit depth
					bytes[dataStart + 10] === 0 && // compression
					bytes[dataStart + 11] === 0 && // filter method
					bytes[dataStart + 12] === 0; // interlace
				channels =
					colorType === 0
						? 1
						: colorType === 2
							? 3
							: colorType === 4
								? 2
								: colorType === 6
									? 4
									: 0;
				if (!ok || channels === 0) return null;
				if (w === 0 || h === 0 || w * h > INFLATE_PIXEL_CAP) return null;
				sawHeader = true;
			} else if (type === "IDAT") {
				if (!sawHeader) return null;
				idat.push(Buffer.from(bytes.subarray(dataStart, dataEnd)));
			} else if (type === "IEND") {
				sawEnd = true;
				break;
			}
			off = dataEnd + 4; // CRC
		}
		if (!sawHeader || !sawEnd || idat.length === 0) return null;
		const raw = inflateSync(Buffer.concat(idat));
		const stride = w * channels;
		if (raw.length < h * (stride + 1)) return null;
		const rgba = new Uint8Array(w * h * 4);
		let prev = new Uint8Array(stride);
		let cur = new Uint8Array(stride);
		for (let y = 0; y < h; y++) {
			const row = y * (stride + 1);
			const filter = raw[row]!;
			if (filter > 4) return null;
			for (let x = 0; x < stride; x++) {
				const a = x >= channels ? cur[x - channels]! : 0;
				const b = prev[x]!;
				const c = x >= channels ? prev[x - channels]! : 0;
				let v = raw[row + 1 + x]!;
				if (filter === 1) v = (v + a) & 0xff;
				else if (filter === 2) v = (v + b) & 0xff;
				else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
				else if (filter === 4) {
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
				}
				cur[x] = v;
			}
			for (let x = 0; x < w; x++) {
				const o = (y * w + x) * 4;
				if (channels === 1) {
					rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[x]!;
					rgba[o + 3] = 255;
				} else if (channels === 2) {
					rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[x * 2]!;
					rgba[o + 3] = cur[x * 2 + 1]!;
				} else if (channels === 3) {
					rgba[o] = cur[x * 3]!;
					rgba[o + 1] = cur[x * 3 + 1]!;
					rgba[o + 2] = cur[x * 3 + 2]!;
					rgba[o + 3] = 255;
				} else {
					rgba[o] = cur[x * 4]!;
					rgba[o + 1] = cur[x * 4 + 1]!;
					rgba[o + 2] = cur[x * 4 + 2]!;
					rgba[o + 3] = cur[x * 4 + 3]!;
				}
			}
			[prev, cur] = [cur, prev]; // cur is fully rewritten each row
		}
		return { w, h, rgba };
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
					const alpha = pixels.rgba[o + 3]! / 255;
					sum +=
						(0.299 * pixels.rgba[o]! +
							0.587 * pixels.rgba[o + 1]! +
							0.114 * pixels.rgba[o + 2]!) *
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
		if (Math.abs(a[i]! - b[i]!) > CELL_NOISE && ++differing > CELL_NOISE_MAX)
			return false;
	}
	return true;
}

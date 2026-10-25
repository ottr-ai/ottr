import { join } from "node:path";
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

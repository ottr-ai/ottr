import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { DecodedImage } from "./images.ts";
import {
	decodeImages,
	MAX_IMAGE_BYTES,
	saveImages,
	sniffImage,
} from "./images.ts";
import fc from "./test/properties.ts";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const b64 = (...bufs: Buffer[]) => Buffer.concat(bufs).toString("base64");

/** decodeImages(input) and unwrap the error string; throws when validation unexpectedly passes. */
const err = (input: unknown) => {
	const r = decodeImages(input, 8);
	if (!("error" in r))
		throw new Error(`expected error, got ${r.images.length} images`);
	return r.error;
};

describe("sniffImage", () => {
	test("png", () => {
		expect(sniffImage(Buffer.concat([PNG_SIG, Buffer.alloc(4)]))).toBe("png");
	});

	test("jpg", () => {
		expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("jpg");
	});

	test("gif87a and gif89a", () => {
		expect(sniffImage(Buffer.from("GIF87a\0\0\0\0\0\0"))).toBe("gif");
		expect(sniffImage(Buffer.from("GIF89a\0\0\0\0\0\0"))).toBe("gif");
	});

	test("webp", () => {
		expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
	});

	test("rejects short input, text and pdf", () => {
		expect(sniffImage(PNG_SIG.subarray(0, 7))).toBe(null);
		expect(sniffImage(Buffer.from("%PDF-1.7 fake"))).toBe(null);
		expect(sniffImage(Buffer.from("hello world"))).toBe(null);
	});
});

describe("decodeImages", () => {
	test("undefined and empty", () => {
		expect(decodeImages(undefined, 8)).toEqual({ images: [] });
		expect(decodeImages([], 8)).toEqual({ images: [] });
	});

	test("honours the per-project image limit", () => {
		const img = b64(PNG_SIG, Buffer.alloc(4));
		if (!("images" in decodeImages([img, img], 2)))
			throw new Error("two images should pass a limit of 2");
		const over = decodeImages([img, img, img], 2);
		if (!("error" in over))
			throw new Error("three images should fail a limit of 2");
		expect(over.error).toBe("at most 2 images per message");
	});

	test("accepts one of each format in order", () => {
		const inputs = [
			b64(PNG_SIG, Buffer.alloc(4)),
			b64(Buffer.from([0xff, 0xd8, 0xff, 0x00])),
			b64(Buffer.from("GIF89a\0\0\0\0\0\0")),
			b64(Buffer.from("RIFF\0\0\0\0WEBP")),
		];
		const r = decodeImages(inputs, 8);
		if (!("images" in r)) throw new Error(`unexpected error: ${r.error}`);
		expect(r.images.map((i) => i.ext)).toEqual(["png", "jpg", "gif", "webp"]);
		expect(r.images.map((i) => i.bytes)).toEqual(
			inputs.map((s) => Buffer.from(s, "base64")),
		);
	});

	test("rejects non-array and non-string entries", () => {
		expect(err("x")).toContain("array of base64 strings");
		expect(err({})).toContain("array of base64 strings");
		expect(err(123)).toContain("array of base64 strings");
	});

	test("rejects more than 8 images", () => {
		const good = b64(PNG_SIG, Buffer.alloc(4));
		expect(err(Array.from({ length: 9 }, () => good))).toContain("at most 8");
	});

	test("rejects invalid base64 and empty string, with index", () => {
		expect(err(["not base64!"])).toContain("image 1 is not valid base64");
		expect(err(["abc"])).toContain("image 1 is not valid base64");
		expect(err([""])).toContain("image 1 is not valid base64");
		expect(err([b64(PNG_SIG, Buffer.alloc(4)), "abc"])).toContain(
			"image 2 is not valid base64",
		);
	});

	test("rejects non-image bytes with index", () => {
		expect(err([Buffer.from("hello world").toString("base64")])).toContain(
			"image 1 is not a PNG, JPEG, GIF or WebP file",
		);
		expect(
			err([Buffer.from("%PDF-1.7 fake pdf").toString("base64")]),
		).toContain("image 1 is not a PNG");
		expect(
			err([
				b64(PNG_SIG, Buffer.alloc(4)),
				Buffer.from("hello").toString("base64"),
			]),
		).toContain("image 2 is not a PNG");
	});

	test("size limit from string length before decoding", () => {
		const tooBig = Buffer.concat([
			PNG_SIG,
			Buffer.alloc(MAX_IMAGE_BYTES + 1 - PNG_SIG.length),
		]).toString("base64");
		expect(err([tooBig])).toContain("image 1 is larger than 10 MiB");
		const exact = Buffer.concat([
			PNG_SIG,
			Buffer.alloc(MAX_IMAGE_BYTES - PNG_SIG.length),
		]).toString("base64");
		const ok = decodeImages([exact], 8);
		expect("images" in ok && ok.images.length === 1).toBe(true);
	});
});

describe("saveImages", () => {
	const dir = mkdtempSync(join(tmpdir(), "ott-images-test-"));
	const png: DecodedImage = {
		bytes: Buffer.concat([PNG_SIG, Buffer.alloc(4)]),
		ext: "png",
	};
	const jpg: DecodedImage = {
		bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
		ext: "jpg",
	};
	const gif: DecodedImage = {
		bytes: Buffer.from("GIF89a\0\0\0\0\0\0"),
		ext: "gif",
	};

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	});

	test("continues numbering and returns names only", () => {
		expect(saveImages(dir, [png, jpg])).toEqual(["1.png", "2.jpg"]);
		expect(saveImages(dir, [gif])).toEqual(["3.gif"]);
		expect(readFileSync(join(dir, "1.png")).equals(png.bytes)).toBe(true);
		expect(readFileSync(join(dir, "2.jpg")).equals(jpg.bytes)).toBe(true);
		expect(readFileSync(join(dir, "3.gif")).equals(gif.bytes)).toBe(true);
	});

	test("ignores non-image files", () => {
		writeFileSync(join(dir, "notes.txt"), "ignore me");
		expect(saveImages(dir, [png])).toEqual(["4.png"]);
		expect(readFileSync(join(dir, "4.png")).equals(png.bytes)).toBe(true);
	});

	test("empty list touches nothing", () => {
		expect(saveImages(dir, [])).toEqual([]);
	});
});

describe("arch-review changed-line coverage", () => {
	// 10 MiB = 10485760 bytes. Base64 size is computed from length before
	// decoding: len/4*3 minus '=' padding, so 13981016 chars with 2 pad chars
	// decodes to exactly 10485760 bytes and with 1 pad char to 10485761.
	const OVER_LEN = 13_981_016;
	test("exactly 10 MiB passes the size check", () => {
		// 10485760 decoded bytes -> base64 length 13981016 with two '=' pads.
		const body = Buffer.concat([
			PNG_SIG,
			Buffer.alloc(MAX_IMAGE_BYTES - PNG_SIG.length, 0x41),
		]);
		const exact = body.toString("base64");
		expect(exact.length).toBe(13_981_016);
		const r = decodeImages([exact], 8);
		if ("error" in r) throw new Error(r.error);
		expect(r.images).toHaveLength(1);
		expect(r.images[0]?.ext).toBe("png");
	});
	test("one byte over 10 MiB is rejected with the exact message", () => {
		const s = `${"A".repeat(OVER_LEN - 1)}=`;
		const r = decodeImages([s], 8);
		if (!("error" in r)) throw new Error("expected error");
		expect(r.error).toBe("image 1 is larger than 10 MiB");
	});
	test("a partial PNG magic is not a PNG", () => {
		expect(sniffImage(Buffer.from("\x89PN"))).toBe(null);
	});
});

describe("decodeImages properties", () => {
	// Table-free CRC32 (IEEE, reflected) for PNG chunk checksums.
	const crc32 = (buf: Buffer): number => {
		let c = ~0;
		for (const byte of buf) {
			c ^= byte;
			for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
		}
		return ~c >>> 0;
	};

	const chunk = (type: string, data: Buffer): Buffer => {
		const head = Buffer.alloc(4);
		head.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([head, body, crc]);
	};

	/** Minimal valid 8-bit grayscale PNG built fully in memory. */
	const buildPng = (w: number, h: number): Buffer => {
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(w, 0);
		ihdr.writeUInt32BE(h, 4);
		ihdr[8] = 8; // bit depth; colortype/compression/filter/interlace stay 0
		const raw = Buffer.alloc(h * (w + 1)); // each row: filter byte 0 + w gray bytes
		return Buffer.concat([
			PNG_SIG,
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(raw)),
			chunk("IEND", Buffer.alloc(0)),
		]);
	};

	test("property: never throws and returns images or a string error", () => {
		const input = fc.oneof(
			fc.constant(undefined),
			fc.string(),
			fc.uint8Array({ maxLength: 64 }),
			fc.array(fc.string(), { maxLength: 8 }),
			fc.array(
				fc
					.uint8Array({ maxLength: 64 })
					.map((b) => Buffer.from(b).toString("base64")),
				{ maxLength: 8 },
			),
		);
		fc.assert(
			fc.property(input, fc.nat({ max: 8 }), (value, max) => {
				const r = decodeImages(value, max);
				if ("error" in r) {
					expect(typeof r.error).toBe("string");
					return;
				}
				for (const img of r.images) {
					expect(["png", "jpg", "gif", "webp"]).toContain(img.ext);
				}
			}),
		);
	});

	test("property: a generated PNG round trips to itself with ext png", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 64 }),
				fc.integer({ min: 1, max: 64 }),
				(w, h) => {
					const png = buildPng(w, h);
					const r = decodeImages([png.toString("base64")], 8);
					if (!("images" in r)) throw new Error(`unexpected error: ${r.error}`);
					expect(r.images).toEqual([{ bytes: png, ext: "png" }]);
				},
			),
			{
				examples: [
					[1, 1],
					[64, 1],
					[1, 64],
				],
			},
		);
	});
});

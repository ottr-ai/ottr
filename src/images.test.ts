import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { DecodedImage, Rgba } from "./images.ts";
import {
	decodeImages,
	decodePng,
	gray16,
	MAX_IMAGE_BYTES,
	saveImages,
	sniffImage,
	visuallyIdentical,
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
	const root = mkdtempSync(join(tmpdir(), "ott-images-test-"));
	const dir = join(root, "tasks", "images");
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
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});

	test("continues numbering and returns names only", () => {
		expect(saveImages(root, dir, [png, jpg])).toEqual(["1.png", "2.jpg"]);
		expect(saveImages(root, dir, [gif])).toEqual(["3.gif"]);
		expect(readFileSync(join(dir, "1.png")).equals(png.bytes)).toBe(true);
		expect(readFileSync(join(dir, "2.jpg")).equals(jpg.bytes)).toBe(true);
		expect(readFileSync(join(dir, "3.gif")).equals(gif.bytes)).toBe(true);
	});

	test("ignores non-image files", () => {
		writeFileSync(join(dir, "notes.txt"), "ignore me");
		expect(saveImages(root, dir, [png])).toEqual(["4.png"]);
		expect(readFileSync(join(dir, "4.png")).equals(png.bytes)).toBe(true);
	});

	test("empty list touches nothing", () => {
		expect(saveImages(root, dir, [])).toEqual([]);
	});

	for (const [label, link] of [
		["images dir", ["linked", "images"]],
		["parent dir", ["linked"]],
	] as const) {
		test.skipIf(process.platform !== "linux")(
			`refuses a symlinked ${label} and leaves the target empty`,
			() => {
				const outside = join(root, "outside", label.replace(" ", "-"));
				mkdirSync(outside, { recursive: true });
				const base = join(root, "data", label.replace(" ", "-"));
				mkdirSync(join(base, ...link.slice(0, -1)), { recursive: true });
				symlinkSync(outside, join(base, ...link));
				expect(() =>
					saveImages(base, join(base, "linked", "images"), [png]),
				).toThrow(/refusing/);
				expect(readdirSync(outside)).toEqual([]);
			},
		);
	}
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

describe("decodePng, gray16 and visuallyIdentical", () => {
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

	const ihdrFor = (
		w: number,
		h: number,
		channels: number,
		overrides: { depth?: number; colorType?: number; interlace?: number } = {},
	): Buffer => {
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(w, 0);
		ihdr.writeUInt32BE(h, 4);
		ihdr[8] = overrides.depth ?? 8;
		ihdr[9] =
			overrides.colorType ??
			(channels === 1 ? 0 : channels === 2 ? 4 : channels === 3 ? 2 : 6);
		ihdr[12] = overrides.interlace ?? 0;
		return ihdr;
	};

	const paeth = (a: number, b: number, c: number): number => {
		const p = a + b - c;
		const pa = Math.abs(p - a);
		const pb = Math.abs(p - b);
		const pc = Math.abs(p - c);
		return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
	};

	/** Encodes `pixels` (w*h*channels bytes, row-major) as a PNG with the given per-row filter type. */
	const buildPngPixels = (
		w: number,
		h: number,
		channels: number,
		pixels: Uint8Array,
		filterFor: (y: number) => number = () => 0,
	): Buffer => {
		const stride = w * channels;
		const raw = Buffer.alloc(h * (stride + 1));
		const at = (y: number, x: number): number =>
			x < 0 || y < 0 ? 0 : pixels[y * stride + x]!;
		for (let y = 0; y < h; y++) {
			const filter = filterFor(y);
			raw[y * (stride + 1)] = filter;
			for (let x = 0; x < stride; x++) {
				const cur = pixels[y * stride + x]!;
				const left = x >= channels ? at(y, x - channels) : 0;
				const above = at(y - 1, x);
				const aboveLeft = x >= channels ? at(y - 1, x - channels) : 0;
				let v = cur;
				if (filter === 1) v = cur - left;
				else if (filter === 2) v = cur - above;
				else if (filter === 3) v = cur - ((left + above) >> 1);
				else if (filter === 4) v = cur - paeth(left, above, aboveLeft);
				raw[y * (stride + 1) + 1 + x] = v & 0xff;
			}
		}
		return Buffer.concat([
			PNG_SIG,
			chunk("IHDR", ihdrFor(w, h, channels)),
			chunk("IDAT", deflateSync(raw)),
			chunk("IEND", Buffer.alloc(0)),
		]);
	};

	/** The RGBA expansion decodePng must produce for `pixels`. */
	const expectRgba = (
		w: number,
		h: number,
		channels: number,
		pixels: Uint8Array,
		decoded: Rgba | null,
	) => {
		expect(decoded).not.toBe(null);
		const d = decoded!;
		expect(d.w).toBe(w);
		expect(d.h).toBe(h);
		expect(d.rgba).toHaveLength(w * h * 4);
		for (let i = 0; i < w * h; i++) {
			const o = i * 4;
			if (channels === 1) {
				expect([
					d.rgba[o],
					d.rgba[o + 1],
					d.rgba[o + 2],
					d.rgba[o + 3],
				]).toEqual([pixels[i], pixels[i], pixels[i], 255]);
			} else if (channels === 2) {
				expect([
					d.rgba[o],
					d.rgba[o + 1],
					d.rgba[o + 2],
					d.rgba[o + 3],
				]).toEqual([
					pixels[i * 2],
					pixels[i * 2],
					pixels[i * 2],
					pixels[i * 2 + 1],
				]);
			} else if (channels === 3) {
				expect([
					d.rgba[o],
					d.rgba[o + 1],
					d.rgba[o + 2],
					d.rgba[o + 3],
				]).toEqual([pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2], 255]);
			} else {
				expect([
					d.rgba[o],
					d.rgba[o + 1],
					d.rgba[o + 2],
					d.rgba[o + 3],
				]).toEqual([
					pixels[i * 4],
					pixels[i * 4 + 1],
					pixels[i * 4 + 2],
					pixels[i * 4 + 3],
				]);
			}
		}
	};

	test("decodes all five filter types exactly", () => {
		const w = 7;
		const h = 6;
		const pixels = Uint8Array.from(
			{ length: w * h * 4 },
			(_, i) => (i * 37 + 11) & 0xff,
		);
		for (const filter of [0, 1, 2, 3, 4]) {
			const png = buildPngPixels(w, h, 4, pixels, () => filter);
			expectRgba(w, h, 4, pixels, decodePng(png));
		}
	});

	test("decodes gray, gray+alpha and rgb color types", () => {
		const w = 5;
		const h = 3;
		const gray = Uint8Array.from({ length: w * h }, (_, i) => (i * 23) & 0xff);
		expectRgba(w, h, 1, gray, decodePng(buildPngPixels(w, h, 1, gray)));
		const ga = Uint8Array.from(
			{ length: w * h * 2 },
			(_, i) => (i * 13) & 0xff,
		);
		expectRgba(w, h, 2, ga, decodePng(buildPngPixels(w, h, 2, ga)));
		const rgb = Uint8Array.from(
			{ length: w * h * 3 },
			(_, i) => (i * 29) & 0xff,
		);
		expectRgba(w, h, 3, rgb, decodePng(buildPngPixels(w, h, 3, rgb)));
	});

	test("rejects palette, 16-bit, interlaced, zero-sized and truncated PNGs", () => {
		const pixels = Uint8Array.from({ length: 4 * 4 }, () => 7);
		const good = buildPngPixels(4, 4, 1, pixels);
		expect(decodePng(good)).not.toBe(null);

		const ihdrPalette = ihdrFor(4, 4, 1, { colorType: 3 });
		const palette = Buffer.concat([
			PNG_SIG,
			chunk("IHDR", ihdrPalette),
			chunk("IEND", Buffer.alloc(0)),
		]);
		expect(decodePng(palette)).toBe(null);

		const ihdr16 = ihdrFor(4, 4, 1, { depth: 16 });
		const deep = Buffer.concat([
			PNG_SIG,
			chunk("IHDR", ihdr16),
			chunk("IEND", Buffer.alloc(0)),
		]);
		expect(decodePng(deep)).toBe(null);

		const ihdrAdam7 = ihdrFor(4, 4, 1, { interlace: 1 });
		const adam7 = Buffer.concat([
			PNG_SIG,
			chunk("IHDR", ihdrAdam7),
			chunk("IEND", Buffer.alloc(0)),
		]);
		expect(decodePng(adam7)).toBe(null);

		const ihdrZero = ihdrFor(0, 4, 1);
		const zero = Buffer.concat([
			PNG_SIG,
			chunk("IHDR", ihdrZero),
			chunk("IEND", Buffer.alloc(0)),
		]);
		expect(decodePng(zero)).toBe(null);

		expect(decodePng(good.subarray(0, good.length - 6))).toBe(null); // truncated IEND
		expect(decodePng(good.subarray(0, 20))).toBe(null); // truncated IDAT
		expect(
			decodePng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		).toBe(null);
		expect(decodePng(Buffer.from("hello, not a png"))).toBe(null);
	});

	test("a broken zlib stream returns null instead of throwing", () => {
		const ihdr = ihdrFor(4, 4, 1);
		const badIdat = chunk("IDAT", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
		const png = Buffer.concat([
			PNG_SIG,
			chunk("IHDR", ihdr),
			badIdat,
			chunk("IEND", Buffer.alloc(0)),
		]);
		expect(decodePng(png)).toBe(null);
	});

	test("tolerates trailing bytes after IEND", () => {
		const pixels = Uint8Array.from({ length: 4 * 4 }, (_, i) => i & 0xff);
		const png = buildPngPixels(4, 4, 1, pixels);
		expectRgba(
			4,
			4,
			1,
			pixels,
			decodePng(Buffer.concat([png, Buffer.from([1])])),
		);
	});

	test("gray16 downsamples uniform blocks to exact cell values", () => {
		// 16×16 with one distinct value per cell.
		const cells = Uint8Array.from(
			{ length: 16 * 16 },
			(_, i) => (i * 3) & 0xff,
		);
		const g = gray16({
			w: 16,
			h: 16,
			rgba: Uint8Array.from([...cells].flatMap((v) => [v, v, v, 255])),
		});
		expect([...g]).toEqual([...cells]);

		// 32×32 of uniform 2×2 blocks: cell k averages exactly its block.
		const blockValue = (i: number): number =>
			((Math.floor(i / 64) * 16 + Math.floor((i % 32) / 2)) * 5) & 0xff;
		const blocks = Uint8Array.from({ length: 32 * 32 }, (_, i) =>
			blockValue(i),
		);
		const g2 = gray16({
			w: 32,
			h: 32,
			rgba: Uint8Array.from([...blocks].flatMap((v) => [v, v, v, 255])),
		});
		for (let c = 0; c < 256; c++) {
			const y = Math.floor(c / 16);
			const x = c % 16;
			const v = blocks[y * 2 * 32 + x * 2]!;
			expect(g2[c]).toBe(v);
		}
	});

	test("visuallyIdentical allows noise, rejects real changes", () => {
		const base = new Uint8Array(256).fill(100);
		expect(visuallyIdentical(base, Uint8Array.from(base))).toBe(true);
		// One cell within the noise band, and one beyond it: both stay inside the
		// eight-cell budget, so a lone hot cell is still the same screen.
		const near = Uint8Array.from(base);
		near[10] = 108;
		expect(visuallyIdentical(base, near)).toBe(true);
		const hot = Uint8Array.from(base);
		hot[10] = 109;
		expect(visuallyIdentical(base, hot)).toBe(true);
		// Eight cells beyond the band exhaust the budget exactly; a ninth fails.
		const eight = Uint8Array.from(base);
		for (let i = 0; i < 8; i++) eight[i] = 0;
		expect(visuallyIdentical(base, eight)).toBe(true);
		const nine = Uint8Array.from(eight);
		nine[8] = 0;
		expect(visuallyIdentical(base, nine)).toBe(false);
	});

	test("property: decodePng never throws on arbitrary bytes", () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
				const d = decodePng(bytes);
				if (d !== null) {
					expect(d.w).toBeGreaterThan(0);
					expect(d.h).toBeGreaterThan(0);
					expect(d.rgba).toHaveLength(d.w * d.h * 4);
				}
			}),
		);
	});

	test("property: encode/decode round trips random images through every filter", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 24 }),
				fc.integer({ min: 1, max: 24 }),
				fc.integer({ min: 0, max: 4 }),
				fc.uint8Array({ minLength: 16 * 16, maxLength: 16 * 16 }),
				(w, h, filter, noise) => {
					const pixels = Uint8Array.from(
						{ length: w * h },
						(_, i) => noise[i % noise.length]!,
					);
					expectRgba(
						w,
						h,
						1,
						pixels,
						decodePng(buildPngPixels(w, h, 1, pixels, () => filter)),
					);
				},
			),
			{ examples: [[1, 1, 4, new Uint8Array(256).fill(9)]] },
		);
	});
});

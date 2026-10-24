import { expect, test } from "bun:test";
import { readPicks } from "./attach.ts";

/** FileReader stub: reads any file, but errors for files named "broken.*". */
class FakeReader {
	result = "";
	error: unknown = null;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readAsDataURL(file: File): void {
		if (file.name.startsWith("broken")) {
			this.error = new Error("The source file could not be read");
			queueMicrotask(() => this.onerror?.());
			return;
		}
		this.result = `data:${file.type};base64,QUJD`;
		queueMicrotask(() => this.onload?.());
	}
}
// @ts-expect-error test stub replaces the DOM constructor
globalThis.FileReader = FakeReader;

const img = (name = "ok.png"): File =>
	new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

test("readPicks keeps every readable file with its base64 payload, in pick order", async () => {
	const { ok, failed } = await readPicks([img("b.png"), img("a.png")]);
	expect(failed).toBeNull();
	expect(ok.map((i) => i.file.name)).toEqual(["b.png", "a.png"]);
	expect(ok.every((i) => i.data === "QUJD")).toBe(true);
});

test("readPicks refuses an unreadable file and names it with the browser's error", async () => {
	const { ok, failed } = await readPicks([img("broken.png")]);
	expect(ok).toEqual([]);
	expect(failed).toContain('"broken.png"');
	expect(failed).toContain("The source file could not be read");
});

test("readPicks attaches the readable part of a mixed batch", async () => {
	const { ok, failed } = await readPicks([
		img("a.png"),
		img("broken.png"),
		img("c.png"),
	]);
	expect(ok.map((i) => i.file.name)).toEqual(["a.png", "c.png"]);
	expect(failed).toContain('"broken.png"');
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	aptListPath,
	ensureAllPackages,
	ensureProjectPackages,
	missingFrom,
	parseAptTxt,
} from "./apt.ts";

const home = mkdtempSync(join(tmpdir(), "ottr-apt-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function list(project: string, text: string, h = home): void {
	mkdirSync(join(h, ".ottr", "workers", project), { recursive: true });
	writeFileSync(join(h, ".ottr", "workers", project, "apt.txt"), text);
}

const rootApt =
	process.platform === "linux" &&
	process.getuid?.() === 0 &&
	Bun.which("apt-get") !== null;

describe("parseAptTxt", () => {
	test("one package per line; comments, blank lines, CRLF and repeats drop out", () => {
		expect(
			parseAptTxt("# chrome\nlibnss3\r\n\nfonts-liberation # fonts\nlibnss3\n"),
		).toEqual(["libnss3", "fonts-liberation"]);
	});

	test("refuses anything that is not a package name, so no line becomes an apt-get option", () => {
		for (const bad of [
			"-o APT::Update::Pre-Invoke::=touch /tmp/x",
			"--allow-unauthenticated",
			"libnss3; rm -rf /",
			"LibNSS3",
		])
			expect(() => parseAptTxt(`libnss3\n${bad}\n`)).toThrow(
				"not a Debian package name",
			);
	});
});

describe("missingFrom", () => {
	test("only a package dpkg reports as installed counts as present", () => {
		const status = [
			"Package: libnss3\nStatus: install ok installed\nVersion: 2",
			"Package: libgbm1\nStatus: deinstall ok config-files",
		].join("\n\n");
		expect(
			missingFrom(["libnss3", "libgbm1", "fonts-liberation"], status),
		).toEqual(["libgbm1", "fonts-liberation"]);
	});
});

describe("aptListPath", () => {
	test("a project name stays one segment under the workers dir", () => {
		expect(aptListPath("velvarr", "/h")).toBe(
			join("/h", ".ottr", "workers", "velvarr", "apt.txt"),
		);
		for (const bad of ["..", "../x", "a/b", "a\\b", ""])
			expect(() => aptListPath(bad, "/h")).toThrow("unsafe project name");
	});

	test("any other legal folder name is accepted, spaces and leading dots included", () => {
		for (const name of ["My Game", "spiel-ü", ".hidden"])
			expect(aptListPath(name, "/h")).toBe(
				join("/h", ".ottr", "workers", name, "apt.txt"),
			);
	});
});

describe("ensureProjectPackages", () => {
	test("a project without a list installs nothing", async () => {
		expect(await ensureProjectPackages("nolist", home)).toEqual([]);
	});

	test("a legal spaced name without a list installs nothing", async () => {
		expect(await ensureProjectPackages("Mein Spiel", home)).toEqual([]);
	});

	test("a bad list fails before apt runs", async () => {
		list("bad", "--allow-unauthenticated\n");
		await expect(ensureProjectPackages("bad", home)).rejects.toThrow(
			"not a Debian package name",
		);
	});

	test.skipIf(rootApt)(
		"where it cannot install, it names the list instead of failing the turn",
		async () => {
			list("ui", "libnss3\n");
			const lines = await ensureProjectPackages("ui", home);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("install them yourself");
		},
	);
});

describe("ensureAllPackages", () => {
	test("a home without provisioned lists installs nothing", async () => {
		expect(await ensureAllPackages(mkdtempSync(join(home, "none-")))).toEqual(
			[],
		);
	});

	test.skipIf(rootApt)(
		"every list gets its turn, and a bad list does not stop the ones after it",
		async () => {
			const h = mkdtempSync(join(home, "all-"));
			list("a-ui", "libnss3\n", h);
			list("b-bad", "--allow-unauthenticated\n", h);
			list("c-ui", "libgbm1\n", h);
			mkdirSync(join(h, ".ottr", "workers", "d-nolist"));
			const lines = await ensureAllPackages(h);
			expect(lines).toHaveLength(3);
			expect(lines[0]).toContain(join("a-ui", "apt.txt"));
			expect(lines[1]).toBe(
				"b-bad: apt: not a Debian package name: --allow-unauthenticated",
			);
			expect(lines[2]).toContain(join("c-ui", "apt.txt"));
		},
	);
});

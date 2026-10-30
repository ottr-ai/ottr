import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
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
import { join } from "node:path";
import {
	buildToolsPath,
	ensureAllTools,
	ensureProjectTools,
	envListPath,
	listedEnvNames,
	parseEnvTxt,
	parseToolsJson,
	type ToolEntry,
	toolsListPath,
	turnEnvValues,
} from "./tools.ts";

const home = mkdtempSync(join(tmpdir(), "ottr-tools-"));

const sha256 = (bytes: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

// A fetch shim instead of a local server: parseToolsJson accepts https:// urls only, and a
// local https server would need a certificate the runtime fetch trusts. The shim maps the
// fixture host to in-memory bodies and records hits, so a reuse test can assert that a
// second ensure run downloaded nothing; everything past the fetch (hash, unpack, rename) is real.
const hits: Record<string, number> = {};
const bodies: Record<string, Uint8Array> = {};
const HOST = "https://fixtures.ottr.test";
const realFetch = globalThis.fetch;
beforeAll(() => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.startsWith(`${HOST}/`)) return realFetch(input, init);
		const path = url.slice(HOST.length);
		const body = bodies[path];
		hits[path] = (hits[path] ?? 0) + 1;
		return new Response(body === undefined ? null : (body as BodyInit), {
			status: body === undefined ? 404 : 200,
		});
	}) as typeof fetch;
});
afterAll(() => {
	globalThis.fetch = realFetch;
	rmSync(home, { recursive: true, force: true });
});

let fixtureN = 0;
function serveFile(body: Uint8Array): string {
	const path = `/fixture-${fixtureN++}`;
	bodies[path] = body;
	return `${HOST}${path}`;
}

/** Builds a real tar.gz with the system tar: one file at `name` inside the archive. */
function tarGz(name: string, content: string): Uint8Array {
	const dir = mkdtempSync(join(tmpdir(), "ottr-tar-"));
	try {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
		const out = join(dir, "out.tar.gz");
		const p = Bun.spawnSync(["tar", "-czf", out, "-C", dir, name]);
		if (p.exitCode !== 0) throw new Error(`tar failed: ${p.stderr.toString()}`);
		return new Uint8Array(readFileSync(out));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Builds a real zip with python's zipfile: one file at `name` inside the archive. */
function zip(name: string, content: string): Uint8Array {
	const dir = mkdtempSync(join(tmpdir(), "ottr-zip-"));
	try {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
		const out = join(dir, "out.zip");
		const p = Bun.spawnSync([
			"python3",
			"-c",
			`import zipfile,sys; zipfile.ZipFile(sys.argv[1],"w").write(sys.argv[2], sys.argv[3])`,
			out,
			join(dir, name),
			name,
		]);
		if (p.exitCode !== 0) throw new Error(`zip failed: ${p.stderr.toString()}`);
		return new Uint8Array(readFileSync(out));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Writes a provisioned tools.json / env.txt pair for a project. */
function provision(
	project: string,
	tools: unknown,
	env: string[] = [],
	h = home,
): void {
	const dir = join(h, ".ottr", "workers", project);
	mkdirSync(dir, { recursive: true });
	if (tools !== null)
		writeFileSync(join(dir, "tools.json"), JSON.stringify(tools));
	if (env.length > 0)
		writeFileSync(join(dir, "env.txt"), env.join("\n") + "\n");
}

const entry = (over: Record<string, unknown>): ToolEntry => ({
	name: "hello",
	url: "https://example.com/hello",
	sha256: "a".repeat(64),
	unpack: "none",
	...over,
});

describe("parseToolsJson", () => {
	test("a valid entry round-trips", () => {
		expect(
			parseToolsJson(
				JSON.stringify([entry({ bin: "bin/hello", unpack: "zip" })]),
			),
		).toEqual([{ ...entry({ bin: "bin/hello", unpack: "zip" }) }]);
	});

	test("every broken rule throws", () => {
		const cases: [string, unknown][] = [
			["not a tool name", [entry({ name: "-bad" })]],
			["not a tool name", [entry({ name: "Hello" })]],
			["not an https:// url", [entry({ url: "http://example.com/x" })]],
			["not a sha256", [entry({ sha256: "a".repeat(63) })]],
			["not a sha256", [entry({ sha256: "A".repeat(64) })]],
			['unpack must be "zip", "tar.gz" or "none"', [entry({ unpack: "rar" })]],
			["takes no bin", [entry({ bin: "hello" })]],
			[
				"bin must be a relative path",
				[entry({ unpack: "zip", sha256: "b".repeat(64) })],
			],
			[
				"bin must be a relative path",
				[entry({ unpack: "zip", sha256: "b".repeat(64), bin: "../x" })],
			],
			[
				"bin must be a relative path",
				[entry({ unpack: "zip", sha256: "b".repeat(64), bin: "/abs" })],
			],
			["duplicate tool name", [entry({}), entry({})]],
			["not a JSON array", entry({})],
			["entry is not an object", ["hello"]],
			["unknown key", [entry({ extra: 1 })]],
		];
		for (const [why, bad] of cases)
			expect(() => parseToolsJson(JSON.stringify(bad)), why).toThrow(why);
	});
});

describe("parseEnvTxt", () => {
	test("comments, blank lines and repeats drop out", () => {
		expect(
			parseEnvTxt("# tools\nOTTR_TOKEN\r\n\n OTTR_HOME # home\nOTTR_TOKEN\n"),
		).toEqual(["OTTR_TOKEN", "OTTR_HOME"]);
	});

	test("refuses anything that is not an env var name", () => {
		for (const bad of ["lower", "1START", "HAS-DASH", "HAS SPACE"])
			expect(() => parseEnvTxt(bad)).toThrow("not an env var name");
	});
});

describe("paths", () => {
	test("lists stay one segment under the workers dir", () => {
		expect(toolsListPath("velvarr", "/h")).toBe(
			join("/h", ".ottr", "workers", "velvarr", "tools.json"),
		);
		expect(envListPath("velvarr", "/h")).toBe(
			join("/h", ".ottr", "workers", "velvarr", "env.txt"),
		);
		for (const bad of ["..", "../x", "a/b", ""])
			expect(() => toolsListPath(bad, "/h")).toThrow("unsafe project name");
	});

	test("env names union across every provisioned folder, sorted", () => {
		const h = mkdtempSync(join(home, "names-"));
		provision("b-proj", null, ["B_ONE", "SHARED"], h);
		provision("a-proj", null, ["A_ONE", "SHARED"], h);
		mkdirSync(join(h, ".ottr", "workers", "not a list"));
		expect(listedEnvNames(h)).toEqual([
			{ name: "A_ONE", projects: ["a-proj"] },
			{ name: "B_ONE", projects: ["b-proj"] },
			{ name: "SHARED", projects: ["a-proj", "b-proj"] },
		]);
	});

	test("a malformed env.txt skips only its own project", () => {
		const h = mkdtempSync(join(home, "bad-env-"));
		provision("good", null, ["GOOD_ONE"], h);
		provision("bad", null, ["OK_NAME", "my-key"], h);
		expect(listedEnvNames(h)).toEqual([
			{ name: "GOOD_ONE", projects: ["good"] },
		]);
	});

	test("a missing env.txt lists nothing", () => {
		expect(listedEnvNames(mkdtempSync(join(home, "empty-")))).toEqual([]);
	});
});

describe("ensureProjectTools", () => {
	test("installs a tar.gz tool: executable bin keyed by sha256, no archive inside", async () => {
		const body = tarGz("bin/hello.sh", "#!/bin/sh\necho hi\n");
		const url = serveFile(body);
		provision("targz", [
			{
				name: "hello",
				url,
				sha256: sha256(body),
				unpack: "tar.gz",
				bin: "bin/hello.sh",
			},
		]);
		const lines = await ensureProjectTools("targz", home);
		expect(lines).toEqual([
			`tools: installed hello (${sha256(body).slice(0, 12)})`,
		]);
		const bin = join(home, ".ottr", "tools", sha256(body), "bin", "hello.sh");
		expect(statSync(bin).mode & 0o755).toBe(0o755);
		expect(existsSync(bin)).toBe(true);
		expect(readFileSync(bin, "utf8")).toContain("echo hi");
		expect(readdirSync(join(home, ".ottr", "tools", sha256(body)))).toEqual([
			"bin",
		]);
	});

	test("installs a zip tool the same way", async () => {
		const body = zip("run/ziptool", "#!/bin/sh\necho zip\n");
		const url = serveFile(body);
		provision("zipproj", [
			{
				name: "ziptool",
				url,
				sha256: sha256(body),
				unpack: "zip",
				bin: "run/ziptool",
			},
		]);
		const lines = await ensureProjectTools("zipproj", home);
		expect(lines).toEqual([
			`tools: installed ziptool (${sha256(body).slice(0, 12)})`,
		]);
		const bin = join(home, ".ottr", "tools", sha256(body), "run", "ziptool");
		expect(statSync(bin).isFile()).toBe(true);
	});

	test("unpack none: the download itself becomes the executable", async () => {
		const body = new TextEncoder().encode("#!/bin/sh\necho plain\n");
		const url = serveFile(body);
		provision("plain", [
			{ name: "plain", url, sha256: sha256(body), unpack: "none" },
		]);
		const lines = await ensureProjectTools("plain", home);
		expect(lines).toEqual([
			`tools: installed plain (${sha256(body).slice(0, 12)})`,
		]);
		const bin = join(home, ".ottr", "tools", sha256(body), "plain");
		expect(statSync(bin).isFile()).toBe(true);
	});

	test("a second run reuses the installed dir: no download, no log line", async () => {
		const body = new TextEncoder().encode("#!/bin/sh\necho reuse\n");
		const url = serveFile(body);
		provision("reuse", [
			{ name: "reuse", url, sha256: sha256(body), unpack: "none" },
		]);
		await ensureProjectTools("reuse", home);
		expect(await ensureProjectTools("reuse", home)).toEqual([]);
		expect(hits[new URL(url).pathname]).toBe(1);
	});

	test("a hash mismatch throws and leaves no folder behind", async () => {
		const body = new TextEncoder().encode("#!/bin/sh\necho evil\n");
		const url = serveFile(body);
		provision("badhash", [
			{ name: "badhash", url, sha256: "c".repeat(64), unpack: "none" },
		]);
		await expect(ensureProjectTools("badhash", home)).rejects.toThrow(
			"sha256 mismatch",
		);
		expect(existsSync(join(home, ".ottr", "tools", "c".repeat(64)))).toBe(
			false,
		);
	});

	test("installs the _all list first, then the project's own", async () => {
		const all = new TextEncoder().encode("all\n");
		const own = new TextEncoder().encode("own\n");
		provision("_all", [
			{
				name: "all-tool",
				url: serveFile(all),
				sha256: sha256(all),
				unpack: "none",
			},
		]);
		provision("layered", [
			{
				name: "own-tool",
				url: serveFile(own),
				sha256: sha256(own),
				unpack: "none",
			},
		]);
		const lines = await ensureProjectTools("layered", home);
		expect(lines).toEqual([
			`tools: installed all-tool (${sha256(all).slice(0, 12)})`,
			`tools: installed own-tool (${sha256(own).slice(0, 12)})`,
		]);
	});

	test("a tar member that climbs out is rejected and leaves no folder", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-slip-"));
		try {
			writeFileSync(join(dir, "f"), "x\n");
			const out = join(dir, "slip.tar.gz");
			// GNU tar sanitizes a literal "../f" argv, so bend it in with --transform.
			const p = Bun.spawnSync([
				"tar",
				"-czf",
				out,
				"--transform",
				"s,^f,../f,",
				"-C",
				dir,
				"f",
			]);
			if (p.exitCode !== 0)
				throw new Error(`tar failed: ${p.stderr.toString()}`);
			const body = new Uint8Array(readFileSync(out));
			provision("slip", [
				{
					name: "slip",
					url: serveFile(body),
					sha256: sha256(body),
					unpack: "tar.gz",
					bin: "f",
				},
			]);
			await expect(ensureProjectTools("slip", home)).rejects.toThrow(
				/tar|climbs out/,
			);
			expect(existsSync(join(home, ".ottr", "tools", sha256(body)))).toBe(
				false,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a symlink out of the archive is rejected and leaves no folder", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-link-"));
		try {
			writeFileSync(join(dir, "outside"), "x\n");
			symlinkSync(join(dir, "outside"), join(dir, "link"));
			const out = join(dir, "link.tar.gz");
			const p = Bun.spawnSync(["tar", "-czf", out, "-C", dir, "link"]);
			if (p.exitCode !== 0)
				throw new Error(`tar failed: ${p.stderr.toString()}`);
			const body = new Uint8Array(readFileSync(out));
			provision("escaper", [
				{
					name: "escaper",
					url: serveFile(body),
					sha256: sha256(body),
					unpack: "tar.gz",
					bin: "link",
				},
			]);
			await expect(ensureProjectTools("escaper", home)).rejects.toThrow(
				"escapes the dir",
			);
			expect(existsSync(join(home, ".ottr", "tools", sha256(body)))).toBe(
				false,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a broken list fails before anything downloads", async () => {
		provision("brokenlist", [
			{
				name: "BAD NAME",
				url: "https://x/y",
				sha256: "d".repeat(64),
				unpack: "none",
			},
		]);
		await expect(ensureProjectTools("brokenlist", home)).rejects.toThrow(
			"not a tool name",
		);
	});
});

describe("ensureAllTools", () => {
	test("a bad folder adds an error line, the good one still installs", async () => {
		const h = mkdtempSync(join(home, "all-"));
		const body = new TextEncoder().encode("good\n");
		provision(
			"a-good",
			[
				{
					name: "good",
					url: serveFile(body),
					sha256: sha256(body),
					unpack: "none",
				},
			],
			[],
			h,
		);
		provision(
			"b-bad",
			[
				{
					name: "BAD",
					url: "https://x/y",
					sha256: "e".repeat(64),
					unpack: "none",
				},
			],
			[],
			h,
		);
		const lines = await ensureAllTools(h);
		expect(lines).toEqual([
			`tools: installed good (${sha256(body).slice(0, 12)})`,
			'tools: b-bad: tools: not a tool name: "BAD"',
		]);
		expect(existsSync(join(h, ".ottr", "tools", sha256(body)))).toBe(true);
	});

	test("a home without workers installs nothing", async () => {
		expect(await ensureAllTools(mkdtempSync(join(home, "none-")))).toEqual([]);
	});
});

describe("buildToolsPath", () => {
	test("the project's entry wins over _all, and _all-only names link too", () => {
		const h = mkdtempSync(join(home, "path-"));
		const proj = new TextEncoder().encode("proj\n");
		const all = new TextEncoder().encode("all\n");
		const shared = new TextEncoder().encode("shared-all\n");
		const projSha = sha256(proj);
		const allSha = sha256(all);
		const sharedSha = sha256(shared);
		for (const [bytes, sha, name] of [
			[proj, projSha, "shared"],
			[all, allSha, "all-only"],
			[shared, sharedSha, "shared"],
		] as const) {
			mkdirSync(join(h, ".ottr", "tools", sha), { recursive: true });
			writeFileSync(join(h, ".ottr", "tools", sha, name), bytes);
		}
		provision(
			"_all",
			[
				{
					name: "shared",
					url: "https://x/s",
					sha256: sharedSha,
					unpack: "none",
				},
				{
					name: "all-only",
					url: "https://x/a",
					sha256: allSha,
					unpack: "none",
				},
			],
			[],
			h,
		);
		provision(
			"picker",
			[{ name: "shared", url: "https://x/p", sha256: projSha, unpack: "none" }],
			[],
			h,
		);
		const dir = buildToolsPath("picker", h);
		expect(readlinkSync(join(dir, "shared"))).toBe(
			join(h, ".ottr", "tools", projSha, "shared"),
		);
		expect(readFileSync(realpathSync(join(dir, "shared")), "utf8")).toBe(
			"proj\n",
		);
		expect(readFileSync(realpathSync(join(dir, "all-only")), "utf8")).toBe(
			"all\n",
		);
	});

	test("a name missing from the tools store throws", () => {
		const h = mkdtempSync(join(home, "missing-"));
		provision(
			"ghost",
			[
				{
					name: "ghost",
					url: "https://x/g",
					sha256: "f".repeat(64),
					unpack: "none",
				},
			],
			[],
			h,
		);
		expect(() => buildToolsPath("ghost", h)).toThrow("missing from");
	});

	test("godot gets --headless only when no display is set", async () => {
		const h = mkdtempSync(join(home, "godot-"));
		const body = new TextEncoder().encode('#!/bin/sh\necho "$@"\n');
		const sha = sha256(body);
		const bin = "it's godot"; // a quote in the path must survive the shell
		mkdirSync(join(h, ".ottr", "tools", sha), { recursive: true });
		writeFileSync(join(h, ".ottr", "tools", sha, bin), body, { mode: 0o755 });
		provision(
			"game",
			[{ name: "godot", url: "https://x/g", sha256: sha, unpack: "zip", bin }],
			[],
			h,
		);
		const godot = join(buildToolsPath("game", h), "godot");
		const run = async (env: Record<string, string>) => {
			const p = Bun.spawn([godot, "--path", "a b"], {
				env: { PATH: process.env.PATH ?? "", ...env },
				stdout: "pipe",
			});
			return (await new Response(p.stdout).text()).trim();
		};
		expect(await run({})).toBe("--headless --path a b");
		expect(await run({ DISPLAY: ":0" })).toBe("--path a b");
		expect(await run({ WAYLAND_DISPLAY: "wayland-0" })).toBe("--path a b");
	});
});

describe("turnEnvValues", () => {
	test("only listed names pass, missing ones come back sorted", () => {
		const h = mkdtempSync(join(home, "env-"));
		provision("_all", null, ["SHARED"], h);
		provision("turn", null, ["B_TWO", "A_ONE"], h);
		expect(
			turnEnvValues("turn", { SHARED: "s", A_ONE: "1", UNLISTED: "no" }, h),
		).toEqual({ env: { SHARED: "s", A_ONE: "1" }, missing: ["B_TWO"] });
	});

	test("no lists at all means no env and nothing missing", () => {
		const h = mkdtempSync(join(home, "envnone-"));
		expect(turnEnvValues("x", { ANY: "v" }, h)).toEqual({
			env: {},
			missing: [],
		});
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
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
import { missingByUse } from "./requiredSkills.ts";
import {
	buildToolsPath,
	ensureProjectTools,
	envListPath,
	envValuesByKind,
	installTools,
	listedEnvNames,
	parseEnvTxt,
	parseToolsJson,
	readToolsList,
	readUserLayer,
	skillCatalog,
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
		writeFileSync(join(dir, "env.txt"), `${env.join("\n")}\n`);
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
		).toEqual([
			{ name: "OTTR_TOKEN", plain: false },
			{ name: "OTTR_HOME", plain: false },
		]);
	});

	test("refuses anything that is not an env var name or the plain mark", () => {
		for (const bad of [
			"lower",
			"1START",
			"HAS-DASH",
			"HAS SPACE",
			"HOST secret",
			"HOST plain extra",
		])
			expect(() => parseEnvTxt(bad)).toThrow("not an env var name");
	});

	test("a trailing plain marks a non-secret value; a secret listing of the same name wins", () => {
		expect(parseEnvTxt("MQTT_HOST plain\nTOKEN\nPORT  plain # x\n")).toEqual([
			{ name: "MQTT_HOST", plain: true },
			{ name: "TOKEN", plain: false },
			{ name: "PORT", plain: true },
		]);
		expect(parseEnvTxt("HOST plain\nHOST\n")).toEqual([
			{ name: "HOST", plain: false },
		]);
	});
});

describe("envValuesByKind", () => {
	test("a plain name takes its plain value, a secret name keeps its secret", () => {
		const listed = [
			{ name: "HOST", plain: true },
			{ name: "TOKEN", plain: false },
			{ name: "MOVED", plain: true },
		];
		expect(
			envValuesByKind(
				{ TOKEN: "t", MOVED: "old-secret", UNLISTED: "u" },
				{ HOST: "h", TOKEN: "ignored" },
				listed,
			),
		).toEqual({ TOKEN: "t", HOST: "h", UNLISTED: "u" });
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

	test("env names union across every provisioned folder, sorted", async () => {
		const h = mkdtempSync(join(home, "names-"));
		provision("b-proj", null, ["B_ONE", "SHARED"], h);
		provision("a-proj", null, ["A_ONE", "SHARED"], h);
		mkdirSync(join(h, ".ottr", "workers", "not a list"));
		expect(await listedEnvNames(h)).toEqual([
			{ name: "A_ONE", projects: ["a-proj"], plain: false },
			{ name: "B_ONE", projects: ["b-proj"], plain: false },
			{ name: "SHARED", projects: ["a-proj", "b-proj"], plain: false },
		]);
	});

	test("a name is plain only when every project lists it as plain", async () => {
		const h = mkdtempSync(join(home, "kinds-"));
		provision("a-proj", null, ["HOST plain", "MIXED plain"], h);
		provision("b-proj", null, ["HOST plain", "MIXED"], h);
		expect(await listedEnvNames(h)).toEqual([
			{ name: "HOST", projects: ["a-proj", "b-proj"], plain: true },
			{ name: "MIXED", projects: ["a-proj", "b-proj"], plain: false },
		]);
	});

	test("a malformed env.txt skips only its own project", async () => {
		const h = mkdtempSync(join(home, "bad-env-"));
		provision("good", null, ["GOOD_ONE"], h);
		provision("bad", null, ["OK_NAME", "my-key"], h);
		expect(await listedEnvNames(h)).toEqual([
			{ name: "GOOD_ONE", projects: ["good"], plain: false },
		]);
	});

	test("a missing env.txt lists nothing", async () => {
		expect(await listedEnvNames(mkdtempSync(join(home, "empty-")))).toEqual([]);
	});

	test("list reads follow the home's current agent layer", async () => {
		// Alate installs the .ottr/workers lists into every layer and may prune the flat
		// ones, so a read resolves <home>/.alate/current first
		// (docs/specs/agent-layer-switch.md, "Layer-following reads").
		const h = mkdtempSync(join(home, "layered-"));
		const layer = join(h, ".alate", "layers", "lay1");
		mkdirSync(layer, { recursive: true });
		symlinkSync(join("layers", "lay1"), join(h, ".alate", "current"));
		provision("p", [], ["LAYER_ONLY"], layer);
		// The flat home holds different lists: the layer wins, the flat ones are unread.
		provision("p", [], ["FLAT_ONLY"], h);
		expect(toolsListPath("p", h)).toBe(
			join(layer, ".ottr", "workers", "p", "tools.json"),
		);
		expect(envListPath("p", h)).toBe(
			join(layer, ".ottr", "workers", "p", "env.txt"),
		);
		expect(await listedEnvNames(h)).toEqual([
			{ name: "LAYER_ONLY", projects: ["p"], plain: false },
		]);
		expect(turnEnvValues("p", { LAYER_ONLY: "v", FLAT_ONLY: "x" }, h)).toEqual({
			env: { LAYER_ONLY: "v" },
			missing: [],
		});
	});

	test("a missing or dangling current link reads the flat home", async () => {
		const h = mkdtempSync(join(home, "dangling-"));
		mkdirSync(join(h, ".alate", "layers", "gone"), { recursive: true });
		symlinkSync(join("layers", "gone"), join(h, ".alate", "current"));
		rmSync(join(h, ".alate", "layers", "gone"), { recursive: true });
		provision("p", [], ["FLAT_ONLY"], h);
		expect(await listedEnvNames(h)).toEqual([
			{ name: "FLAT_ONLY", projects: ["p"], plain: false },
		]);
		expect(toolsListPath("p", h)).toBe(
			join(h, ".ottr", "workers", "p", "tools.json"),
		);
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

	// OTTR-953: the home is shared with turns, so an installed archive tree is not trusted.
	test("a tampered archive entry fails provisioning instead of linking", async () => {
		const h = mkdtempSync(join(home, "tamper-"));
		const body = tarGz("bin/hello.sh", "#!/bin/sh\necho real\n");
		const url = serveFile(body);
		provision(
			"victim",
			[
				{
					name: "hello",
					url,
					sha256: sha256(body),
					unpack: "tar.gz",
					bin: "bin/hello.sh",
				},
			],
			[],
			h,
		);
		await ensureProjectTools("victim", h);
		const dir = join(h, ".ottr", "tools", sha256(body));
		// An intact tree passes, checked against the kept archive: no second download.
		expect(await ensureProjectTools("victim", h)).toEqual([]);
		expect(hits[new URL(url).pathname]).toBe(1);
		writeFileSync(join(dir, "bin", "hello.sh"), "#!/bin/sh\necho MARKER\n");
		await expect(ensureProjectTools("victim", h)).rejects.toThrow(
			"hello: installed files do not match its sha256 (bin/hello.sh differs)",
		);
		writeFileSync(join(dir, "bin", "hello.sh"), "#!/bin/sh\necho real\n");
		expect(await ensureProjectTools("victim", h)).toEqual([]);
		// An added name beside the bin is a change too.
		writeFileSync(join(dir, "bin", "git"), "#!/bin/sh\necho MARKER\n");
		await expect(ensureProjectTools("victim", h)).rejects.toThrow(
			"(bin differs)",
		);
	});

	test("a missing or tampered kept archive is downloaded again and still checks the tree", async () => {
		const h = mkdtempSync(join(home, "kept-"));
		const body = zip("run/tool", "#!/bin/sh\necho zip\n");
		const url = serveFile(body);
		provision(
			"keeper",
			[
				{
					name: "tool",
					url,
					sha256: sha256(body),
					unpack: "zip",
					bin: "run/tool",
				},
			],
			[],
			h,
		);
		await ensureProjectTools("keeper", h);
		const kept = join(h, ".ottr", "tools", `${sha256(body)}.zip`);
		expect(readFileSync(kept)).toEqual(Buffer.from(body));
		// An install from before the kept copy existed.
		rmSync(kept);
		expect(await ensureProjectTools("keeper", h)).toEqual([]);
		expect(hits[new URL(url).pathname]).toBe(2);
		writeFileSync(kept, "not the archive");
		expect(await ensureProjectTools("keeper", h)).toEqual([]);
		expect(hits[new URL(url).pathname]).toBe(3);
		expect(readFileSync(kept)).toEqual(Buffer.from(body));
		// A planted kept archive cannot vouch for a planted tree: its hash fails the pin.
		writeFileSync(join(h, ".ottr", "tools", sha256(body), "run", "tool"), "x");
		writeFileSync(kept, zip("run/tool", "x"));
		await expect(ensureProjectTools("keeper", h)).rejects.toThrow(
			"(run/tool differs)",
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
			// tar itself refuses the "../" member; the exec error names it.
			await expect(ensureProjectTools("slip", home)).rejects.toThrow(/tar/);
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

describe("installTools", () => {
	test("installs the entries in the order given, and a rerun downloads nothing", async () => {
		const h = mkdtempSync(join(home, "core-"));
		const first = new TextEncoder().encode("first\n");
		const second = new TextEncoder().encode("second\n");
		const lines = await installTools(
			[
				{
					name: "first",
					url: serveFile(first),
					sha256: sha256(first),
					unpack: "none",
				},
				{
					name: "second",
					url: serveFile(second),
					sha256: sha256(second),
					unpack: "none",
				},
			],
			h,
		);
		expect(lines).toEqual([
			`tools: installed first (${sha256(first).slice(0, 12)})`,
			`tools: installed second (${sha256(second).slice(0, 12)})`,
		]);
		expect(
			await installTools(
				[
					{
						name: "first",
						url: serveFile(first),
						sha256: sha256(first),
						unpack: "none",
					},
				],
				h,
			),
		).toEqual([]);
	});

	test("no entries installs nothing", async () => {
		expect(await installTools([], mkdtempSync(join(home, "empty-")))).toEqual(
			[],
		);
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
		// Link priority: the project's list first, then the fleet's.
		const entries = [
			...readToolsList("picker", h),
			...readToolsList("_all", h),
		];
		const dir = buildToolsPath(entries, h);
		expect(readlinkSync(join(dir, "shared"))).toBe(
			join(h, ".ottr", "tools", projSha, "shared"),
		);
		expect(readFileSync(realpathSync(join(dir, "shared")), "utf8")).toBe(
			"proj\n",
		);
		expect(readFileSync(realpathSync(join(dir, "all-only")), "utf8")).toBe(
			"all\n",
		);
		// Same tool set, same dir: repeated turns add no new link dir and leave no build dir.
		expect(buildToolsPath(entries, h)).toBe(dir);
		expect(buildToolsPath(readToolsList("_all", h), h)).not.toBe(dir);
		expect(
			readdirSync(join(h, ".ottr", "tools")).filter((n) =>
				n.startsWith("path-"),
			),
		).toHaveLength(2);
	});

	test("the link dir stays traversable for other uids, a reused 0700 dir included", () => {
		const h = mkdtempSync(join(home, "mode-"));
		const bytes = new TextEncoder().encode("tool\n");
		const sha = sha256(bytes);
		mkdirSync(join(h, ".ottr", "tools", sha), { recursive: true });
		writeFileSync(join(h, ".ottr", "tools", sha, "mode-tool"), bytes);
		provision(
			"moder",
			[{ name: "mode-tool", url: "https://x/m", sha256: sha, unpack: "none" }],
			[],
			h,
		);
		const entries = readToolsList("moder", h);
		const dir = buildToolsPath(entries, h);
		// The project uid owns nothing here: read and search must be open to everyone.
		expect(statSync(dir).mode & 0o555).toBe(0o555);
		// A dir that an older build left at 0700 is repaired on the next turn.
		chmodSync(dir, 0o700);
		expect(buildToolsPath(entries, h)).toBe(dir);
		expect(statSync(dir).mode & 0o555).toBe(0o555);
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
		expect(() => buildToolsPath(readToolsList("ghost", h), h)).toThrow(
			"missing from",
		);
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
		const godot = join(buildToolsPath(readToolsList("game", h), h), "godot");
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

	test("a pre-existing sha dir whose binary differs from the pin is refused", async () => {
		const h = mkdtempSync(join(home, "planted-"));
		const sha = sha256(new TextEncoder().encode("real\n"));
		mkdirSync(join(h, ".ottr", "tools", sha), { recursive: true });
		writeFileSync(join(h, ".ottr", "tools", sha, "git"), "planted\n");
		provision(
			"victim",
			[{ name: "git", url: "https://x/g", sha256: sha, unpack: "none" }],
			[],
			h,
		);
		// install trusts the existing dir; the link step must not.
		expect(await ensureProjectTools("victim", h)).toEqual([]);
		expect(() => buildToolsPath(readToolsList("victim", h), h)).toThrow(
			"installed binary does not match its sha256",
		);
	});

	test("a reused link dir with a planted name or a swapped link is refused", () => {
		const h = mkdtempSync(join(home, "linkdir-"));
		const body = new TextEncoder().encode("real\n");
		const sha = sha256(body);
		mkdirSync(join(h, ".ottr", "tools", sha), { recursive: true });
		writeFileSync(join(h, ".ottr", "tools", sha, "tool"), body);
		provision(
			"linker",
			[{ name: "tool", url: "https://x/t", sha256: sha, unpack: "none" }],
			[],
			h,
		);
		const dir = buildToolsPath(readToolsList("linker", h), h);
		writeFileSync(join(dir, "git"), "#!/bin/sh\necho MARKER\n");
		expect(() => buildToolsPath(readToolsList("linker", h), h)).toThrow(
			"link dir does not match the tool set (. differs)",
		);
		rmSync(join(dir, "git"));
		expect(buildToolsPath(readToolsList("linker", h), h)).toBe(dir);
		rmSync(join(dir, "tool"));
		writeFileSync(join(dir, "tool"), "#!/bin/sh\necho MARKER\n");
		expect(() => buildToolsPath(readToolsList("linker", h), h)).toThrow(
			"(tool differs)",
		);
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

	test("a list in the shared home grants nothing; only the board home's lists count (R5-1)", async () => {
		// The shared home a turn can write lists a secret for every project and for B.
		const shared = mkdtempSync(join(home, "envshared-"));
		provision("_all", null, ["A_SECRET"], shared);
		provision("b", null, ["A_SECRET"], shared);
		const board = mkdtempSync(join(home, "envboard-"));
		provision("a", null, ["A_SECRET"], board);
		const saved = process.env.OTTR_BOARD_OMP_HOME;
		process.env.OTTR_BOARD_OMP_HOME = board;
		try {
			const values = { A_SECRET: "s" };
			expect(turnEnvValues("b", values)).toEqual({ env: {}, missing: [] });
			expect(turnEnvValues("a", values).env).toEqual({ A_SECRET: "s" });
			expect(await listedEnvNames()).toEqual([
				{ name: "A_SECRET", projects: ["a"], plain: false },
			]);
		} finally {
			if (saved === undefined) delete process.env.OTTR_BOARD_OMP_HOME;
			else process.env.OTTR_BOARD_OMP_HOME = saved;
		}
	});
});

describe("readUserLayer", () => {
	test("the rules read returns the sorted .md names and keeps the other lists", () => {
		const h = mkdtempSync(join(home, "rules-"));
		const rules = join(h, ".omp", "agent", "rules");
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "codeguard-1-input-validation.md"), "x\n");
		writeFileSync(join(rules, "lang-typescript.md"), "x\n");
		// Not a rule: wrong extension; dot-prefixed files stay out too.
		writeFileSync(join(rules, "notes.txt"), "x\n");
		writeFileSync(join(rules, ".secret.md"), "x\n");
		expect(readUserLayer(h)).toEqual({
			skills: [],
			plugins: [],
			mcp: [],
			rules: ["codeguard-1-input-validation.md", "lang-typescript.md"],
		});
	});

	test("a home without a rules dir reads fail-soft as an empty rules list", () => {
		const h = mkdtempSync(join(home, "norules-"));
		mkdirSync(join(h, ".omp", "agent", "skills", "correct"), {
			recursive: true,
		});
		writeFileSync(
			join(h, ".omp", "agent", "skills", "correct", "SKILL.md"),
			"x\n",
		);
		expect(readUserLayer(h)).toEqual({
			skills: ["correct"],
			plugins: [],
			mcp: [],
			rules: [],
		});
	});

	test("an enabled plugin's pi.skills skills count as installed skills", () => {
		const h = mkdtempSync(join(home, "plugyes-"));
		const pkgDir = join(
			h,
			".omp",
			"plugins",
			"node_modules",
			"@dietrichgebert",
			"ponytail",
		);
		mkdirSync(join(pkgDir, "skills", "ponytail-audit"), { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "@dietrichgebert/ponytail",
				pi: { skills: ["./skills"] },
			}),
		);
		writeFileSync(join(pkgDir, "skills", "ponytail-audit", "SKILL.md"), "x\n");
		mkdirSync(join(h, ".omp", "plugins"), { recursive: true });
		writeFileSync(
			join(h, ".omp", "plugins", "omp-plugins.lock.json"),
			JSON.stringify({
				plugins: {
					"@dietrichgebert/ponytail": {
						version: "5.3.3",
						enabledFeatures: null,
						enabled: true,
					},
				},
			}),
		);
		const layer = readUserLayer(h);
		expect(layer.skills).toContain("ponytail-audit");
		expect(missingByUse(layer).review).not.toContain("ponytail-audit");
	});

	test("a disabled plugin adds no skills", () => {
		const h = mkdtempSync(join(home, "plugno-"));
		const pkgDir = join(
			h,
			".omp",
			"plugins",
			"node_modules",
			"@dietrichgebert",
			"ponytail",
		);
		mkdirSync(join(pkgDir, "skills", "ponytail-audit"), { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "@dietrichgebert/ponytail",
				pi: { skills: ["./skills"] },
			}),
		);
		writeFileSync(join(pkgDir, "skills", "ponytail-audit", "SKILL.md"), "x\n");
		mkdirSync(join(h, ".omp", "plugins"), { recursive: true });
		writeFileSync(
			join(h, ".omp", "plugins", "omp-plugins.lock.json"),
			JSON.stringify({
				plugins: {
					"@dietrichgebert/ponytail": {
						version: "5.3.3",
						enabledFeatures: null,
						enabled: false,
					},
				},
			}),
		);
		const layer = readUserLayer(h);
		expect(layer.skills).toEqual([]);
		// The plugin itself still lists; only its skills stay out.
		expect(layer.plugins).toEqual(["@dietrichgebert/ponytail"]);
	});

	test("a pi.skills path that leaves the plugin folder adds no skills", () => {
		const h = mkdtempSync(join(home, "plugesc-"));
		// The escape target exists and holds a SKILL.md folder; containment must skip it.
		mkdirSync(
			join(h, ".omp", "plugins", "node_modules", "elsewhere", "skills", "evil"),
			{ recursive: true },
		);
		writeFileSync(
			join(
				h,
				".omp",
				"plugins",
				"node_modules",
				"elsewhere",
				"skills",
				"evil",
				"SKILL.md",
			),
			"x\n",
		);
		const pkgDir = join(
			h,
			".omp",
			"plugins",
			"node_modules",
			"@dietrichgebert",
			"ponytail",
		);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "@dietrichgebert/ponytail",
				pi: { skills: ["../../elsewhere/skills"] },
			}),
		);
		mkdirSync(join(h, ".omp", "plugins"), { recursive: true });
		writeFileSync(
			join(h, ".omp", "plugins", "omp-plugins.lock.json"),
			JSON.stringify({
				plugins: {
					"@dietrichgebert/ponytail": {
						version: "5.3.3",
						enabledFeatures: null,
						enabled: true,
					},
				},
			}),
		);
		expect(readUserLayer(h).skills).toEqual([]);
	});
});

describe("skillCatalog", () => {
	test("reads each skill's frontmatter description; a missing or unreadable one lists the name alone", () => {
		const h = mkdtempSync(join(home, "catalog-"));
		mkdirSync(join(h, ".omp", "agent", "skills", "tiktok"), {
			recursive: true,
		});
		writeFileSync(
			join(h, ".omp", "agent", "skills", "tiktok", "SKILL.md"),
			"---\nname: tiktok\ndescription: Use for TikTok video, captions, or photo slides.\n---\nbody\n",
		);
		mkdirSync(join(h, ".agents", "skills", "watch"), { recursive: true });
		writeFileSync(
			join(h, ".agents", "skills", "watch", "SKILL.md"),
			"# none\n",
		);
		mkdirSync(join(h, ".omp", "agent", "managed-skills", "correct"), {
			recursive: true,
		});
		writeFileSync(
			join(h, ".omp", "agent", "managed-skills", "correct", "SKILL.md"),
			'---\nname: correct\ndescription: "quoted text"\n---\n',
		);
		// A YAML block scalar parses as no description, never garbage.
		mkdirSync(join(h, ".omp", "agent", "skills", "blocky"), {
			recursive: true,
		});
		writeFileSync(
			join(h, ".omp", "agent", "skills", "blocky", "SKILL.md"),
			"---\ndescription: |\n  line one\n---\n",
		);
		// A SKILL.md that is a directory reads as no description, never a throw.
		mkdirSync(join(h, ".omp", "agent", "skills", "broken", "SKILL.md"), {
			recursive: true,
		});
		// Dot-prefixed and not-a-skill dirs stay out; a name in two bridge dirs lists once.
		mkdirSync(join(h, ".omp", "agent", "skills", ".hidden", "SKILL.md"), {
			recursive: true,
		});
		mkdirSync(join(h, ".omp", "agent", "skills", "not-a-skill"), {
			recursive: true,
		});
		mkdirSync(join(h, ".agents", "skills", "tiktok"), { recursive: true });
		expect(skillCatalog(h)).toEqual([
			{ name: "blocky", description: "" },
			{ name: "broken", description: "" },
			{ name: "correct", description: "quoted text" },
			{
				name: "tiktok",
				description: "Use for TikTok video, captions, or photo slides.",
			},
			{ name: "watch", description: "" },
		]);
	});

	test("the default home follows OTTR_WORKERS_HOME, the Missing-on-workers source", () => {
		const h = mkdtempSync(join(home, "cataloghome-"));
		mkdirSync(join(h, ".omp", "agent", "skills", "tiktok"), {
			recursive: true,
		});
		writeFileSync(
			join(h, ".omp", "agent", "skills", "tiktok", "SKILL.md"),
			"---\ndescription: d\n---\n",
		);
		const saved = process.env.OTTR_WORKERS_HOME;
		process.env.OTTR_WORKERS_HOME = h;
		try {
			expect(skillCatalog().map((s) => s.name)).toContain("tiktok");
		} finally {
			if (saved === undefined) delete process.env.OTTR_WORKERS_HOME;
			else process.env.OTTR_WORKERS_HOME = saved;
		}
	});
});

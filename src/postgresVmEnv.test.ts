import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATABASE_MARKER = "synthetic-server-database-marker";
const TEST_DATABASE_MARKER = "synthetic-test-database-marker";
const guestModule = new URL("./vmGuest.ts", import.meta.url).href;
const netModule = new URL("./vmNet.ts", import.meta.url).href;
const unixModule = new URL("./platform/unix.ts", import.meta.url).href;
const probe = `({
	urlAbsent: process.env.OTTR_DATABASE_URL === undefined,
	testUrlPreserved: process.env.OTTR_TEST_PG_URL === ${JSON.stringify(TEST_DATABASE_MARKER)},
	requirePreserved: process.env.OTTR_REQUIRE_PG_TESTS === "1"
})`;

// Separate Bun processes exercise both the live env and Bun's cached boot env.
async function launchProbe(kind: "net" | "unix" | "guest", scrub: boolean) {
	const root = mkdtempSync(join(tmpdir(), "ottr-postgres-vm-env-"));
	const capture = join(root, "captures.jsonl");
	const executable = `#!${process.execPath}
import { appendFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
	tool, args, ...${probe},
	gitRedirectAbsent: process.env.GIT_DIR === undefined,
	promptDisabled: process.env.GIT_TERMINAL_PROMPT === "0"
}) + "\\n");
if (tool === "git") {
	if (args.includes("clone")) mkdirSync(args.at(-1), { recursive: true });
	if (args[0] === "rev-parse") console.log("synthetic-head");
} else if (tool === "tar" && args.includes("-c")) {
	process.stdin.resume();
	process.stdout.write("archive-output");
} else if (tool === "ps") {
	console.log(args.includes("-A") ? "42 41\\n43 42" : "42 10 synthetic-process");
}
`;
	for (const tool of ["git", "tar", "sync", "ps"]) {
		const path = join(root, tool);
		writeFileSync(path, executable);
		chmodSync(path, 0o755);
	}
	const omp = join(root, "omp-probe.ts");
	writeFileSync(
		omp,
		`console.log(JSON.stringify({ ...${probe},
			guestTokenAbsent: process.env.OTTR_VM_GUEST_TOKEN === undefined,
			requestPreserved: process.env.REQUEST_MARKER === "synthetic-request-marker",
			hindsightPreserved: process.env.HINDSIGHT_API_TOKEN === "synthetic-turn-token",
			hindsightBank: process.env.HINDSIGHT_BANK_ID === "ottr-synthetic-project",
			hindsightScoping: process.env.HINDSIGHT_SCOPING === "global"
		}));`,
	);
	const script = join(root, "launch.ts");
	writeFileSync(
		script,
		`import { readFileSync, writeFileSync } from "node:fs";
import { serveGuest } from ${JSON.stringify(guestModule)};
import { defaultExec } from ${JSON.stringify(netModule)};
import { descendants, unix } from ${JSON.stringify(unixModule)};
${scrub ? "delete process.env.OTTR_DATABASE_URL;" : ""}
const kind = ${JSON.stringify(kind)};
if (kind === "net") {
	const result = await defaultExec([process.execPath, "-e", ${JSON.stringify(`console.log(JSON.stringify(${probe}));`)}]);
	if (result.code !== 0) throw new Error("net probe child failed");
	console.log(result.stdout.trim());
} else if (kind === "unix") {
	const list = unix.listProcesses();
	const tree = descendants(41);
	const captures = readFileSync(${JSON.stringify(capture)}, "utf8").trim().split("\\n").map(JSON.parse);
	console.log(JSON.stringify({
		urlAbsent: captures.length === 2 && captures.every(c => c.urlAbsent),
		testUrlPreserved: captures.every(c => c.testUrlPreserved),
		requirePreserved: captures.every(c => c.requirePreserved),
		listPreserved: list.length === 1 && list[0].pid === 42 && list[0].cmd === "synthetic-process",
		treePreserved: JSON.stringify(tree) === "[42,43]"
	}));
} else {
	const server = serveGuest({
		port: 0, token: "synthetic-guest-token", ompPath: process.execPath,
		ensure: { packages: async () => [], tools: async () => [], python: async () => [] },
		home: ${JSON.stringify(root)}
	});
	try {
		const url = "http://127.0.0.1:" + server.port;
		const headers = { "x-ottr-guest-token": "synthetic-guest-token" };
		const file = ${JSON.stringify(join(root, "copy.txt"))};
		writeFileSync(file, "copy marker");
		const archive = await fetch(url + "/files?path=" + encodeURIComponent(file), { headers });
		if (archive.status !== 200 || await archive.text() !== "archive-output") throw new Error("archive probe failed");
		const copy = await fetch(url + "/files", { method: "PUT", headers, body: new Uint8Array(1024) });
		if (copy.status !== 200 || await copy.text() !== "ok") throw new Error("copy probe failed");
		const bake = await fetch(url + "/bake", {
			method: "POST", headers, body: JSON.stringify({ project: "synthetic-project" })
		});
		const baked = await bake.text();
		if (bake.status !== 200 || !baked.includes('"exitCode":0')) throw new Error("bake probe failed");
		const run = await fetch(url + "/run", { method: "POST", headers, body: JSON.stringify({
			argv: [${JSON.stringify(omp)}], cwd: ${JSON.stringify(join(root, "clone"))}, stdin: "",
			env: {
				PATH: process.env.PATH,
				OTTR_DATABASE_URL: "synthetic-request-database-marker",
				OTTR_TEST_PG_URL: ${JSON.stringify(TEST_DATABASE_MARKER)},
				OTTR_REQUIRE_PG_TESTS: "1", REQUEST_MARKER: "synthetic-request-marker"
			},
			vm: {
				gitUrl: "synthetic-remote", branch: "synthetic-branch", base: "main",
				token: "synthetic-turn-token", boardUrl: "http://127.0.0.1:1",
				providers: [], hindsight: true, project: "synthetic-project"
			}
		}) });
		const lines = (await run.text()).trim().split("\\n").map(JSON.parse);
		if (run.status !== 200 || !lines.some(line => line.xdevWorkerDone?.exitCode === 0)) {
			throw new Error("guest turn probe failed");
		}
		const omp = lines.find(line => "urlAbsent" in line);
		if (!omp) throw new Error("omp probe output missing");
		const captures = readFileSync(${JSON.stringify(capture)}, "utf8").trim().split("\\n").map(JSON.parse);
		console.log(JSON.stringify({
			urlAbsent: captures.every(c => c.urlAbsent) && omp.urlAbsent,
			testUrlPreserved: captures.every(c => c.testUrlPreserved) && omp.testUrlPreserved,
			requirePreserved: captures.every(c => c.requirePreserved) && omp.requirePreserved,
			guestTokenAbsent: omp.guestTokenAbsent,
			requestPreserved: omp.requestPreserved,
			hindsightPreserved: omp.hindsightPreserved,
			hindsightBank: omp.hindsightBank,
			hindsightScoping: omp.hindsightScoping,
			gitGuardsPreserved: captures.filter(c => c.tool === "git").every(c => c.gitRedirectAbsent && c.promptDisabled),
			toolsCovered: ["git", "sync"].every(tool => captures.some(c => c.tool === tool)),
			archivesCovered: ["-c", "-t", "-x"].every(arg => captures.some(c => c.tool === "tar" && c.args.includes(arg)))
		}));
	} finally {
		server.stop();
	}
}
`,
	);
	const child = Bun.spawn([process.execPath, script], {
		env: {
			...process.env,
			PATH: root,
			OTTR_DATABASE_URL: DATABASE_MARKER,
			OTTR_TEST_PG_URL: TEST_DATABASE_MARKER,
			OTTR_REQUIRE_PG_TESTS: "1",
			OTTR_VM_GUEST_TOKEN: "synthetic-parent-guest-token",
			GIT_DIR: "synthetic-parent-git-dir",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	return JSON.parse(stdout.trim()) as Record<string, boolean>;
}

for (const scrub of [false, true]) {
	const source = scrub ? "cached boot env" : "live env";
	test(`vmNet defaultExec excludes the server URL from ${source}`, async () => {
		expect(await launchProbe("net", scrub)).toEqual({
			urlAbsent: true,
			testUrlPreserved: true,
			requirePreserved: true,
		});
	}, 30_000);

	test(`Unix process snapshots exclude the server URL from ${source}`, async () => {
		expect(await launchProbe("unix", scrub)).toEqual({
			urlAbsent: true,
			testUrlPreserved: true,
			requirePreserved: true,
			listPreserved: true,
			treePreserved: true,
		});
	}, 30_000);

	test(`guest tools, archives and omp exclude the server URL from ${source}`, async () => {
		expect(await launchProbe("guest", scrub)).toEqual({
			urlAbsent: true,
			testUrlPreserved: true,
			requirePreserved: true,
			guestTokenAbsent: true,
			requestPreserved: true,
			hindsightPreserved: true,
			hindsightBank: true,
			hindsightScoping: true,
			gitGuardsPreserved: true,
			toolsCovered: true,
			archivesCovered: true,
		});
	}, 30_000);
}

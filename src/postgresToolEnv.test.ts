import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each harness starts with a synthetic server URL. The scrubbed case also
// checks Bun's cached boot environment, not only the current process.env.
const fakeCommand = `#!${process.execPath}
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.OTTR_ENV_PROBE_LOG, JSON.stringify({
  command,
  productionPresent: process.env.OTTR_DATABASE_URL !== undefined,
  testUrlPreserved: process.env.OTTR_TEST_PG_URL === "synthetic-test-database",
  requiredPreserved: process.env.OTTR_REQUIRE_PG_TESTS === "1",
  noninteractive: process.env.DEBIAN_FRONTEND === "noninteractive",
}) + "\\n");
if (command === "python3") {
  const bin = join(args[args.indexOf("venv") + 1], "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.argv[1], join(bin, "pip"));
  chmodSync(join(bin, "pip"), 0o755);
} else if (command === "tar" || command === "unzip") {
  const dir = args[args.indexOf(command === "tar" ? "-C" : "-d") + 1];
  writeFileSync(join(dir, "probe-tool"), "synthetic executable");
} else if (command === "git") {
  process.stdout.write("synthetic archive");
}
`;

const harness = `
import { install } from ${JSON.stringify(new URL("./apt.ts", import.meta.url).href)};
import { ensurePython } from ${JSON.stringify(new URL("./python.ts", import.meta.url).href)};
import { installTools } from ${JSON.stringify(new URL("./tools.ts", import.meta.url).href)};
import { runSandboxJob } from ${JSON.stringify(new URL("./sandboxRun.ts", import.meta.url).href)};
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [mode, home, scrub] = process.argv.slice(2);
if (scrub === "true") delete process.env.OTTR_DATABASE_URL;
// No request can reach the network, even if a cache regression occurs.
globalThis.fetch = async () => { throw new Error("unexpected network request"); };
let result;
if (mode === "apt") {
  result = await install(["probe-package"], "synthetic list");
} else if (mode === "python") {
  result = await ensurePython([{ name: "probe-package", version: "1.0", hashes: ["a".repeat(64)] }], home);
} else if (mode === "zip" || mode === "tar.gz") {
  const bytes = Buffer.from("synthetic cached archive " + mode);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const root = join(home, ".ottr", "tools");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, sha256 + "." + mode), bytes);
  const entries = [{ name: "probe-tool", url: "https://fixture.invalid/tool", sha256, unpack: mode, bin: "probe-tool" }];
  result = await installTools(entries, home);
  // Verification of an installed tree must use the same safe child env.
  const repeat = await installTools(entries, home);
  if (repeat.length !== 0) throw new Error("installed tree was not reused");
} else if (mode === "sandbox") {
  result = await runSandboxJob({
    project: "env-probe",
    argv: ["true"],
    checkout: home,
    dataRoot: home,
    idFactory: () => "val-1234567890-aabbccdd",
    env: { OTTR_VM_RUNNER_URL: "http://fixture.invalid", OTTR_WORKER_TOKEN: "synthetic-worker-marker" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (readFileSync(request.targetTar, "utf8") !== "synthetic archive") {
        throw new Error("archive bytes changed");
      }
      return Response.json({ id: request.id });
    },
  });
} else {
  throw new Error("unknown probe mode");
}
console.log(JSON.stringify(result));
`;

interface ChildProbe {
	command: string;
	productionPresent: boolean;
	testUrlPreserved: boolean;
	requiredPreserved: boolean;
	noninteractive: boolean;
}

const commands: Record<string, string[]> = {
	apt: ["dpkg-query", "dpkg", "dpkg", "apt-get", "apt-get"],
	python: ["python3", "pip"],
	zip: ["unzip", "unzip"],
	"tar.gz": ["tar", "tar"],
	sandbox: ["git"],
};

for (const scrub of [false, true]) {
	for (const [mode, expectedCommands] of Object.entries(commands)) {
		test(`${mode} filters child env (scrub=${scrub})`, async () => {
			const home = mkdtempSync(join(tmpdir(), "ottr-tool-env-"));
			try {
				const bin = join(home, "bin");
				mkdirSync(bin);
				for (const command of [
					"dpkg-query",
					"dpkg",
					"apt-get",
					"python3",
					"tar",
					"unzip",
					"git",
				]) {
					const path = join(bin, command);
					writeFileSync(path, fakeCommand);
					chmodSync(path, 0o755);
				}
				const script = join(home, "harness.ts");
				const log = join(home, "children.jsonl");
				writeFileSync(script, harness);
				const child = Bun.spawn(
					[process.execPath, script, mode, home, String(scrub)],
					{
						env: {
							...process.env,
							PATH: bin,
							HOME: home,
							OTTR_DATABASE_URL: "synthetic-server-database",
							OTTR_TEST_PG_URL: "synthetic-test-database",
							OTTR_REQUIRE_PG_TESTS: "1",
							OTTR_ENV_PROBE_LOG: log,
						},
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [stdout, stderr, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(stderr).toBe("");
				expect(code).toBe(0);
				const result = JSON.parse(stdout);
				if (mode === "sandbox") expect(result.ok).toBe(true);
				else expect(result).toHaveLength(1);
				const probes = readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as ChildProbe);
				expect(probes.map((probe) => probe.command)).toEqual(expectedCommands);
				for (const probe of probes) {
					expect(probe.productionPresent).toBe(false);
					expect(probe.testUrlPreserved).toBe(true);
					expect(probe.requiredPreserved).toBe(true);
					if (mode === "apt") expect(probe.noninteractive).toBe(true);
				}
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
}

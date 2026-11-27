import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CgroupReading, SystemVm, VmStateDisk } from "./types.ts";
import { probeVmRunner } from "./vmHealth.ts";
import {
	type Exec,
	netStartup,
	parseTaps,
	slotDownCommands,
	slotFor,
	slotUpCommands,
	startupCommands,
} from "./vmNet.ts";
import {
	type BakeResult,
	layerKey,
	listFiles,
	sparseFile,
	VmRootfs,
} from "./vmRootfs.ts";
import {
	COPY_OUT_MAX_FILE_BYTES,
	COPY_OUT_MAX_TOTAL_BYTES,
	extractCopyOut,
	firecrackerConfig,
	readTar,
	serveVmRunner,
	type TarMember,
	tarStream,
	type VmLauncher,
	type VmLaunchSpec,
	type VmRunnerOptions,
	vmStateDiskUsage,
} from "./vmRunner.ts";
import { parseSize, readVmRunnerEnv } from "./vmRunnerMain.ts";
import { vmState } from "./vmState.ts";
import {
	type ValidateJobSpec,
	type ValidateRequest,
	type ValidateResponse,
	type ValidateResult,
	VM_VALIDATE,
} from "./vmValidateShared.ts";
import {
	type ProvisionLists,
	type VmSpec,
	WORKER_DONE,
	type WorkerRequest,
} from "./workers.ts";

// Nothing here needs KVM: the launcher is a fake that starts a fake guest agent (Bun.serve on
// port 0) per "VM", and ip/iptables/mkfs go through a recording exec.

const root = mkdtempSync(join(tmpdir(), "ottr-vmrunner-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const linux = process.platform === "linux";

const stoppers: (() => void)[] = [];
afterEach(() => {
	for (const s of stoppers.splice(0)) s();
});

const enc = new TextEncoder();

async function until(
	f: () => boolean | Promise<boolean>,
	what: string,
	ms = 5000,
): Promise<void> {
	const end = Date.now() + ms;
	// Polling, not a guessed wait: the runner's teardown and the fake guest's sockets live in
	// other event-loop turns with no promise a test could await.
	while (Date.now() < end) {
		if (await f()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

function gate(): { wait: Promise<void>; open: () => void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { wait: promise, open: () => resolve() };
}

/** A hand-made GNU-style tar, independent of the runner's own writer. */
function rawTar(
	members: {
		name: string;
		content?: string;
		type?: string;
		mtime?: number;
		/** Stored link target for a "2" (symlink) member. */
		link?: string;
	}[],
): Uint8Array {
	const blocks: Uint8Array[] = [];
	const header = (
		name: string,
		type: string,
		size: number,
		mtime: number,
		link = "",
	): Uint8Array => {
		const b = new Uint8Array(512);
		const put = (off: number, s: string): void => b.set(enc.encode(s), off);
		put(0, name.slice(0, 100));
		put(100, "0000644\0");
		put(108, "0000000\0");
		put(116, "0000000\0");
		put(124, `${size.toString(8).padStart(11, "0")}\0`);
		put(136, `${mtime.toString(8).padStart(11, "0")}\0`);
		b.fill(0x20, 148, 156);
		b[156] = type.charCodeAt(0);
		put(157, link.slice(0, 100));
		put(257, "ustar  \0");
		let sum = 0;
		for (const x of b) sum += x;
		put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
		return b;
	};
	const pad = (n: number): Uint8Array =>
		new Uint8Array((512 - (n % 512)) % 512);
	for (const m of members) {
		const data = enc.encode(m.content ?? "");
		const mtime = m.mtime ?? 1_700_000_000;
		if (m.name.length > 100) {
			const long = enc.encode(`${m.name}\0`);
			blocks.push(header("././@LongLink", "L", long.length, 0), long);
			blocks.push(pad(long.length));
		}
		blocks.push(
			header(m.name, m.type ?? "0", data.length, mtime, m.link ?? ""),
			data,
		);
		blocks.push(pad(data.length));
	}
	blocks.push(new Uint8Array(1024));
	const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
	let off = 0;
	for (const b of blocks) {
		out.set(b, off);
		off += b.length;
	}
	return out;
}

const bodyOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
	new Response(bytes as Uint8Array<ArrayBuffer>)
		.body as ReadableStream<Uint8Array>;

async function members(
	bytes: Uint8Array,
): Promise<{ m: TarMember; content: string }[]> {
	const out: { m: TarMember; content: string }[] = [];
	await readTar(bodyOf(bytes), async (m, data) => {
		let content = "";
		for await (const c of data) content += new TextDecoder().decode(c);
		out.push({ m, content });
	});
	return out;
}

/** Writes a ValidateResult to a raw drive the way the guest does: an 8-byte little-endian
 * length, then the UTF-8 JSON. */
function writeResultDrive(path: string, result: ValidateResult): void {
	const payload = Buffer.from(JSON.stringify(result), "utf8");
	const head = Buffer.alloc(8);
	head.writeBigUInt64LE(BigInt(payload.length));
	writeFileSync(path, Buffer.concat([head, payload]));
}

interface GuestRec {
	spec: VmLaunchSpec;
	token: string;
	killed: boolean;
	puts: Uint8Array[];
	runBody: Record<string, unknown> | null;
	/** The POST /bake body, when the bake reached the guest. */
	bakeBody: Record<string, unknown> | null;
	fileQueries: URLSearchParams[];
	/** The VM process dies on its own: the guest vanishes, no sentinel. */
	crash: () => void;
}

interface GuestScript {
	run?: (rec: GuestRec) => Response;
	bake?: (rec: GuestRec) => Response;
	shutdown?: (rec: GuestRec) => Response;
	files?: (q: URLSearchParams) => Uint8Array;
	healthz?: (rec: GuestRec) => Response;
	/** A ValidateResult the fake guest writes to the vdd drive before it powers off. */
	validateResult?: ValidateResult;
}

const DONE_OK = {
	exitCode: 0,
	stderrTail: "",
	vm: { head: "abc123", pushError: null, dirty: [] },
};

const ndjson = (...lines: string[]): Response =>
	new Response(lines.map((l) => `${l}\n`).join(""));

/** A guest /run that sends one event, then holds until `release` sends the sentinel. */
function heldGuest(): {
	run: (rec: GuestRec) => Response;
	release: () => void;
} {
	const g = gate();
	return {
		release: g.open,
		run: () =>
			new Response(
				new ReadableStream<Uint8Array>({
					async start(c) {
						c.enqueue(enc.encode('{"type":"tick"}\n'));
						await g.wait;
						try {
							c.enqueue(
								enc.encode(`${JSON.stringify({ [WORKER_DONE]: DONE_OK })}\n`),
							);
							c.close();
						} catch {
							// the VM was killed meanwhile
						}
					},
				}),
			),
	};
}

/** One /run of the fake guest agent: records the body, answers the scripted stream. */
async function fakeGuestRun(
	script: GuestScript,
	rec: GuestRec,
	req: Request,
): Promise<Response> {
	rec.runBody = await req.json();
	return (
		script.run?.(rec) ??
		ndjson('{"type":"tick"}', JSON.stringify({ [WORKER_DONE]: DONE_OK }))
	);
}

/** One GET /files of the fake guest agent: records the query, answers the scripted tar. */
function fakeGuestFiles(script: GuestScript, rec: GuestRec, u: URL): Response {
	rec.fileQueries.push(u.searchParams);
	return new Response(
		(script.files?.(u.searchParams) ?? rawTar([])) as Uint8Array<ArrayBuffer>,
	);
}

/** The fake guest agent's HTTP routes, shared by every VM a launcher run boots. */
async function guestRoute(
	script: GuestScript,
	rec: GuestRec,
	token: string,
	req: Request,
): Promise<Response> {
	const u = new URL(req.url);
	if (u.pathname === "/healthz")
		return script.healthz?.(rec) ?? new Response("ok");
	if (req.headers.get("x-ottr-guest-token") !== token)
		return new Response("unauthorized", { status: 401 });
	if (req.method === "PUT" && u.pathname === "/files") {
		rec.puts.push(new Uint8Array(await req.arrayBuffer()));
		return new Response("ok");
	}
	if (req.method === "GET" && u.pathname === "/files")
		return fakeGuestFiles(script, rec, u);
	if (req.method === "POST" && u.pathname === "/run")
		return fakeGuestRun(script, rec, req);
	if (req.method === "POST" && u.pathname === "/bake") {
		rec.bakeBody = (await req.json()) as Record<string, unknown>;
		return (
			script.bake?.(rec) ??
			ndjson(JSON.stringify({ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } }))
		);
	}
	if (req.method === "POST" && u.pathname === "/shutdown")
		return script.shutdown?.(rec) ?? new Response("ok");
	return new Response("not found", { status: 404 });
}

function fakeLauncher(script: GuestScript): {
	launcher: VmLauncher;
	recs: GuestRec[];
} {
	const recs: GuestRec[] = [];
	const launcher: VmLauncher = async (spec) => {
		const token = /ottr\.token=(\S+)/.exec(spec.bootArgs)?.[1] ?? "";
		const { promise: exited, resolve: exit } = Promise.withResolvers<void>();
		const rec: GuestRec = {
			spec,
			token,
			killed: false,
			puts: [],
			runBody: null,
			bakeBody: null,
			fileQueries: [],
			crash: () => {},
		};
		// Validate mode has no guest HTTP (no interface): the fake guest writes the result
		// drive when scripted to and powers off at once.
		if (spec.mode === "validate") {
			const vdd = spec.drives.find((d) => d.id === "vdd");
			if (script.validateResult && vdd)
				writeResultDrive(vdd.path, script.validateResult);
			recs.push(rec);
			exit();
			return {
				pid: 4242,
				guestUrl: "http://127.0.0.1:9",
				exited,
				kill: () => exit(),
				logTail: () => "fake console\n",
			};
		}
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			idleTimeout: 0,
			fetch: (req) => guestRoute(script, rec, token, req),
		});
		stoppers.push(() => server.stop(true));
		const die = (): void => {
			if (rec.killed) return;
			rec.killed = true;
			server.stop(true);
			exit();
		};
		rec.crash = die;
		recs.push(rec);
		return {
			pid: 4242,
			guestUrl: `http://127.0.0.1:${server.port}`,
			exited,
			kill: die,
			logTail: () => "fake console\n",
		};
	};
	return { launcher, recs };
}

const fakeRootfs = {
	base: async () => ({ key: "base", path: "/state/base.ext4" }),
	layer: async () => ({ ok: true as const, path: "/state/layer.ext4" }),
};

/** What startRunner hands each test: the server URL, the fake VMs' records, the recorded
 * exec commands, and the three temp roots. */
interface TestRunner {
	url: string;
	recs: GuestRec[];
	execs: string[][];
	stateDir: string;
	dataRoot: string;
	homeRoot: string;
}

function startRunner(
	o: {
		script?: GuestScript;
		max?: number;
		exists?: (p: string) => boolean;
		netError?: string | null;
		detachedTtlMs?: number;
		now?: () => number;
		rootfs?: VmRunnerOptions["rootfs"];
		execHook?: (
			argv: string[],
		) => { code: number | null; stdout: string; stderr: string } | null;
		/** Extra exec behavior on top of the recording: snapshot at mkfs time, etc. */
		exec?: Exec;
	} = {},
): TestRunner {
	const stateDir = mkdtempSync(join(root, "state-"));
	const dataRoot = mkdtempSync(join(root, "data-"));
	const homeRoot = mkdtempSync(join(root, "home-"));
	mkdirSync(join(dataRoot, "proj"));
	const execs: string[][] = [];
	const exec: Exec = async (argv) => {
		execs.push(argv);
		return (
			o.execHook?.(argv) ??
			(o.exec ? o.exec(argv) : { code: 0, stdout: "", stderr: "" })
		);
	};
	const { launcher, recs } = fakeLauncher(o.script ?? {});
	const server = serveVmRunner({
		port: 0,
		token: "tok",
		max: o.max ?? 2,
		vcpus: 2,
		memMiB: 512,
		diskBytes: 1024 * 1024,
		stateDir,
		kernel: "/opt/ottr-vm/vmlinux",
		firecracker: "/usr/local/bin/firecracker",
		boardHost: "ottr",
		netError: o.netError ?? null,
		detachedTtlMs: o.detachedTtlMs,
		now: o.now,
		launcher,
		rootfs: o.rootfs ?? fakeRootfs,
		exec,
		resolveHost: async () => "172.18.0.5",
		exists: o.exists ?? (() => true),
		dataRoot,
		homeRoot,
		bootTimeoutMs: 5000,
	});
	stoppers.push(() => server.stop(true));
	return {
		url: `http://127.0.0.1:${server.port}`,
		recs,
		execs,
		stateDir,
		dataRoot,
		homeRoot,
	};
}

let seq = 0;
function request(over: Partial<VmSpec> = {}): WorkerRequest {
	return {
		id: `run-${++seq}`,
		argv: ["-p", "go"],
		cwd: "/workspace/proj/.worktrees/P-1",
		stdin: "prompt",
		env: { OTTR_PROJECT: "proj", GH_TOKEN: "ghp_secret", FOO: "bar" },
		vm: {
			project: "proj",
			taskId: "P-1",
			branch: "ott/p-1",
			base: "main",
			boardUrl: "http://ottr:8080",
			token: "vmtoken",
			providers: ["anthropic"],
			hindsight: false,
			layerDir: null,
			copyIn: [],
			copyOut: [],
			...over,
		},
	};
}

const post = (
	url: string,
	path: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<Response> =>
	fetch(`${url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-otwr-token": "tok" },
		body: JSON.stringify(body),
		signal,
	});

const sentinelOf = (text: string): Record<string, unknown> | null => {
	for (const line of text.split("\n")) {
		if (!line.includes(WORKER_DONE)) continue;
		const parsed: Record<string, Record<string, unknown>> = JSON.parse(line);
		return parsed[WORKER_DONE] ?? null;
	}
	return null;
};

const detachedList = async (url: string): Promise<Record<string, unknown>[]> =>
	(await (
		await fetch(`${url}/detached`, { headers: { "x-otwr-token": "tok" } })
	).json()) as Record<string, unknown>[];

describe("vm-runner /run", () => {
	test("relays the guest's lines and its sentinel with the vm outcome plus host, then tears the VM down", async () => {
		const r = startRunner();
		const res = await post(r.url, "/run", request());
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text.split("\n")[0]).toBe('{"type":"tick"}');
		const done = sentinelOf(text);
		expect(done?.exitCode).toBe(0);
		expect(done?.vm).toEqual(DONE_OK.vm);
		expect(typeof done?.host).toBe("string");
		expect(done?.host).not.toBe("");
		const vm = r.recs[0]!;
		// The guest got the board-side git URL and no git host token from the request env.
		const body = vm.runBody as {
			cwd: string;
			env: Record<string, string>;
			vm: Record<string, unknown>;
		};
		expect(body.cwd).toBe("/workspace/proj/.worktrees/P-1");
		expect(body.vm.gitUrl).toBe("http://ottr:8080/git/proj.git");
		expect(body.vm.token).toBe("vmtoken");
		expect(body.env.GH_TOKEN).toBeUndefined();
		expect(body.env.FOO).toBe("bar");
		// Boot contract: run mode, base and layer read-only, scratch rw, board ip + host name.
		expect(vm.spec.mode).toBe("run");
		expect(vm.spec.drives.map((d) => [d.id, d.readOnly])).toEqual([
			["vda", true],
			["vdb", true],
			["vdc", false],
		]);
		expect(vm.spec.bootArgs).toContain("ottr.mode=run");
		expect(vm.spec.bootArgs).toContain("ottr.board=172.18.0.5");
		expect(vm.spec.bootArgs).toContain("ottr.boardhost=ottr");
		expect(vm.spec.bootArgs).toContain(
			"ip=10.231.0.2::10.231.0.1:255.255.255.252::eth0:off",
		);
		// Teardown: VM killed, the board allow rule and the tap removed, the run dir gone.
		await until(() => vm.killed, "vm kill");
		expect(r.execs).toContainEqual(["ip", "link", "del", "ovm0"]);
		expect(
			r.execs.some(
				(a) => a.includes("-D") && a.includes("--dport") && a.includes("8080"),
			),
		).toBe(true);
		await until(
			() =>
				!existsSync(join(r.stateDir, "runs")) ||
				readdirSync(join(r.stateDir, "runs")).length === 0,
			"run dir cleanup",
		);
	});

	test("the delivered githubReadEnv reaches the guest env after the strip; ambient names do not", async () => {
		const r = startRunner();
		const res = await post(r.url, "/run", {
			...request(),
			// All four names ambient in the request env, plus the delivered read-only
			// token on its dedicated field.
			env: {
				OTTR_PROJECT: "proj",
				GH_TOKEN: "ghp_secret",
				GITHUB_TOKEN: "ghp_secret2",
				GH_ENTERPRISE_TOKEN: "ghp_ent",
				GITHUB_ENTERPRISE_TOKEN: "ghp_ent2",
				FOO: "bar",
			},
			githubReadEnv: {
				GH_HOST: "acme.ghe.com",
				GH_ENTERPRISE_TOKEN: "tok-ent",
			},
		});
		await res.text();
		const body = r.recs[0]!.runBody as {
			env: Record<string, string>;
		};
		// The delivered read-only token lands after the strip...
		expect(body.env).toHaveProperty("GH_HOST", "acme.ghe.com");
		expect(body.env).toHaveProperty("GH_ENTERPRISE_TOKEN", "tok-ent");
		// ...and every ambient GitHub token name is gone.
		expect(body.env.GH_TOKEN).toBeUndefined();
		expect(body.env.GITHUB_TOKEN).toBeUndefined();
		expect(body.env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
		expect(body.env.FOO).toBe("bar");
	});

	test.each(["request", "githubReadEnv", "both"])(
		"excludes OTTR_DATABASE_URL from the guest env when supplied through %s",
		async (source) => {
			const r = startRunner();
			const body = request();
			const res = await post(r.url, "/run", {
				...body,
				env: {
					...body.env,
					...(source !== "githubReadEnv"
						? { OTTR_DATABASE_URL: "request-database-marker" }
						: {}),
				},
				githubReadEnv: {
					GH_HOST: "acme.ghe.com",
					...(source !== "request"
						? { OTTR_DATABASE_URL: "overlay-database-marker" }
						: {}),
				},
			});
			expect(res.status).toBe(200);
			await res.text();
			const guest = r.recs[0]!.runBody as {
				env: Record<string, string>;
			};
			expect(guest.env).not.toHaveProperty("OTTR_DATABASE_URL");
			expect(guest.env).toEqual({
				OTTR_PROJECT: "proj",
				FOO: "bar",
				GH_HOST: "acme.ghe.com",
			});
		},
	);

	test("answers 400 without a vm spec", async () => {
		const r = startRunner();
		const { vm: _vm, ...classic } = request();
		const res = await post(r.url, "/run", classic);
		expect(res.status).toBe(400);
		expect(r.recs).toHaveLength(0);
	});

	test("refuses a vm.lists that is not an object of strings", async () => {
		const r = startRunner();
		for (const lists of ["tools.json", 5, { tools: 7 }, { apt: null }]) {
			const res = await post(r.url, "/run", request({ lists: lists as never }));
			expect(res.status).toBe(400);
			expect(await res.text()).toContain("vm.lists");
			expect(r.recs).toHaveLength(0);
		}
	});

	test("refuses copyIn paths outside /data/<project>, also through a link", async () => {
		const r = startRunner();
		const other = join(r.dataRoot, "other");
		mkdirSync(other);
		writeFileSync(join(other, "secret"), "x");
		for (const p of [
			join(other, "secret"),
			// Not join(): it would normalize the ".." away before the runner sees it.
			`${r.dataRoot}/proj/../other/secret`,
			"/etc/passwd",
			join(r.dataRoot, "proj"),
		]) {
			const res = await post(r.url, "/run", request({ copyIn: [p] }));
			expect(res.status).toBe(400);
		}
		symlinkSync(other, join(r.dataRoot, "proj", "link"));
		const res = await post(
			r.url,
			"/run",
			request({ copyIn: [join(r.dataRoot, "proj", "link", "secret")] }),
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("through a link");
		expect(r.recs).toHaveLength(0);
	});

	test("forwards cloneFiles unchanged into the guest body's vm object", async () => {
		const r = startRunner();
		const cloneFiles = [
			{
				path: "/workspace/proj/.worktrees/P-1/code-scan-alerts.md",
				text: "alert list",
			},
		];
		const res = await post(r.url, "/run", request({ cloneFiles }));
		expect(res.status).toBe(200);
		await res.text();
		const body = r.recs[0]!.runBody as { vm: Record<string, unknown> };
		expect(body.vm.cloneFiles).toEqual(cloneFiles);
	});

	test("a clone file path outside the cwd answers 400 before any VM boots", async () => {
		const r = startRunner();
		for (const p of [
			"/workspace/other/x.md",
			// Strictly inside means not the cwd itself.
			"/workspace/proj/.worktrees/P-1",
			// Not join()/resolve(): the ".." must stay visible to the check.
			"/workspace/proj/.worktrees/P-1/../other/x.md",
		]) {
			const res = await post(
				r.url,
				"/run",
				request({ cloneFiles: [{ path: p, text: "x" }] }),
			);
			expect(res.status).toBe(400);
			expect(await res.text()).toContain(p.replace(/\/\.\.\/.*/, ""));
		}
		expect(r.recs).toHaveLength(0);
	});

	test("a cloneFiles shape violation answers 400", async () => {
		const r = startRunner();
		const res = await post(
			r.url,
			"/run",
			request({ cloneFiles: "nope" as never }),
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("vm.cloneFiles");
		expect(r.recs).toHaveLength(0);
	});

	test("an oversized clone file answers 400", async () => {
		const r = startRunner();
		const res = await post(
			r.url,
			"/run",
			request({
				cloneFiles: [
					{
						path: "/workspace/proj/.worktrees/P-1/code-scan-alerts.md",
						text: "x".repeat(4_000_001),
					},
				],
			}),
		);
		expect(res.status).toBe(400);
		expect(r.recs).toHaveLength(0);
	});

	test("a multibyte clone file within the byte cap is forwarded", async () => {
		const r = startRunner();
		// 1,500,000 two-byte characters hold 3,000,000 bytes: inside the byte cap
		// the old one-million-character cap refused.
		const cloneFiles = [
			{
				path: "/workspace/proj/.worktrees/P-1/code-scan-alerts.md",
				text: "é".repeat(1_500_000),
			},
		];
		const res = await post(r.url, "/run", request({ cloneFiles }));
		expect(res.status).toBe(200);
		await res.text();
		const body = r.recs[0]!.runBody as { vm: Record<string, unknown> };
		expect(body.vm.cloneFiles).toEqual(cloneFiles);
	});

	test("sends the agent layer without credentials, links as links, and the copyIn files", async () => {
		const r = startRunner();
		const layer = join(r.homeRoot, ".alate", "layers", "L1");
		const files: Record<string, string> = {
			"a.txt": "a",
			".omp/agent/models.yml": "m",
			".omp/agent/agent.db": "db",
			".omp/agent/agent.db-wal": "wal",
			".omp/oauth/token": "t",
			".ssh/id_ed25519": "k",
			".config/gh/hosts.yml": "h",
		};
		for (const [rel, content] of Object.entries(files)) {
			mkdirSync(join(layer, rel, ".."), { recursive: true });
			writeFileSync(join(layer, rel), content);
		}
		symlinkSync("/etc/passwd", join(layer, "link"));
		const session = join(r.dataRoot, "proj", "sessions", "s.jsonl");
		mkdirSync(join(session, ".."), { recursive: true });
		writeFileSync(session, "session");
		const res = await post(
			r.url,
			"/run",
			request({ layerDir: layer, copyIn: [session] }),
		);
		await res.text();
		const sent = await members(r.recs[0]!.puts[0]!);
		const byName = new Map(sent.map((s) => [s.m.name, s]));
		const rel = (p: string): string => p.slice(1);
		expect(byName.get(rel(join(layer, "a.txt")))?.content).toBe("a");
		expect(byName.has(rel(join(layer, ".omp/agent/models.yml")))).toBe(true);
		for (const secret of [
			".omp/agent/agent.db",
			".omp/agent/agent.db-wal",
			".omp/oauth/token",
			".ssh/id_ed25519",
			".config/gh/hosts.yml",
		])
			expect(byName.has(rel(join(layer, secret)))).toBe(false);
		const link = byName.get(rel(join(layer, "link")));
		expect(link?.m.type).toBe("2");
		expect(link?.m.linkname).toBe("/etc/passwd");
		expect(link?.content).toBe("");
		expect(byName.get(rel(session))?.content).toBe("session");
	});

	test("copies back only regular files under /data/<project>, refusing traversal", async () => {
		const outDir = (dataRoot: string): string =>
			join(dataRoot, "proj", "sessions");
		let dataRootSeen = "";
		const r = startRunner({
			script: {
				files: () => {
					const base = outDir(dataRootSeen).slice(1);
					return rawTar([
						{ name: `${base}/new.jsonl`, content: "fresh" },
						{ name: `${base}/../../evil.txt`, content: "evil" },
						{ name: `/${base}/abs.txt`, content: "abs" },
						{ name: `${dataRootSeen.slice(1)}/other/x.txt`, content: "x" },
						{ name: `${base}/${"d".repeat(120)}/long.txt`, content: "long" },
					]);
				},
			},
		});
		dataRootSeen = r.dataRoot;
		const before = Date.now();
		const res = await post(
			r.url,
			"/run",
			request({ copyOut: [outDir(r.dataRoot)] }),
		);
		const text = await res.text();
		expect(readFileSync(join(outDir(r.dataRoot), "new.jsonl"), "utf8")).toBe(
			"fresh",
		);
		expect(
			readFileSync(
				join(outDir(r.dataRoot), "d".repeat(120), "long.txt"),
				"utf8",
			),
		).toBe("long");
		expect(existsSync(join(r.dataRoot, "evil.txt"))).toBe(false);
		expect(existsSync(join(r.dataRoot, "other", "x.txt"))).toBe(false);
		expect(text).toContain("vm-runner: refused copy-out of ");
		const q = r.recs[0]!.fileQueries[0]!;
		expect(q.get("path")).toBe(outDir(r.dataRoot));
		expect(Number(q.get("since"))).toBeGreaterThanOrEqual(before);
		// Copy-out lands before the sentinel the board settles on.
		expect(sentinelOf(text)?.exitCode).toBe(0);
	});

	test("copy-out stays in the requested dir and replaces only the files the run copied in", async () => {
		let proj = "";
		const r = startRunner({
			script: {
				files: () => {
					const p = proj.slice(1);
					return rawTar([
						{ name: `${p}/handoffs/h.md`, content: "planted" },
						{ name: `${p}/sessions/other.jsonl`, content: "clobbered" },
						{ name: `${p}/sessions/mine.jsonl`, content: "updated" },
						{ name: `${p}/sessions/fresh.jsonl`, content: "new" },
					]);
				},
			},
		});
		proj = join(r.dataRoot, "proj");
		const sessions = join(proj, "sessions");
		mkdirSync(sessions);
		writeFileSync(join(sessions, "mine.jsonl"), "old");
		writeFileSync(join(sessions, "other.jsonl"), "keep");
		const res = await post(
			r.url,
			"/run",
			request({
				copyIn: [join(sessions, "mine.jsonl")],
				copyOut: [sessions],
			}),
		);
		const text = await res.text();
		expect(existsSync(join(proj, "handoffs", "h.md"))).toBe(false);
		expect(text).toContain(
			`vm-runner: refused copy-out of ${proj.slice(1)}/handoffs/h.md\n`,
		);
		expect(readFileSync(join(sessions, "other.jsonl"), "utf8")).toBe("keep");
		expect(text).toContain(
			`vm-runner: refused copy-out of ${proj.slice(1)}/sessions/other.jsonl\n`,
		);
		expect(readFileSync(join(sessions, "mine.jsonl"), "utf8")).toBe("updated");
		expect(readFileSync(join(sessions, "fresh.jsonl"), "utf8")).toBe("new");
		expect(sentinelOf(text)?.exitCode).toBe(0);
	});

	test("answers busy at OTTR_VM_MAX and takes a run again once a slot frees", async () => {
		const held = heldGuest();
		const r = startRunner({ max: 1, script: { run: held.run } });
		const first = await post(r.url, "/run", request());
		const reader = first.body!.getReader();
		await reader.read(); // the guest's first event: the VM holds the slot
		const busy = await post(r.url, "/run", request());
		expect(busy.status).toBe(503);
		expect(busy.headers.get("x-ottr-busy")).toBe("1");
		held.release();
		while (!(await reader.read()).done) {
			// drain to the end of the first run
		}
		await until(async () => {
			const again = await post(r.url, "/run", request());
			if (again.status === 503) return false;
			expect(again.status).toBe(200);
			await again.text();
			return true;
		}, "free slot");
	});

	test("a failed bake ends the run with exit 1 and the bake's stderr tail", async () => {
		const bakeRootfs = {
			base: async () => ({ key: "base", path: "/state/base.ext4" }),
			layer: async (
				_p: string,
				_lists: ProvisionLists,
				bake: (image: string) => Promise<BakeResult>,
			) => {
				const b = await bake("/state/layer.tmp");
				return b.exitCode === 0
					? { ok: true as const, path: "/state/layer.tmp" }
					: { ok: false as const, stderrTail: b.stderrTail };
			},
		};
		const r = startRunner({
			rootfs: bakeRootfs,
			script: {
				bake: () =>
					ndjson(
						"apt: installing nope",
						JSON.stringify({
							[WORKER_DONE]: {
								exitCode: 100,
								stderrTail: "E: Unable to locate package nope\n",
							},
						}),
					),
			},
		});
		// A planted shared-home list is inert on this path: only the dispatch's
		// lists ride the copy-in.
		const planted = join(r.homeRoot, ".ottr", "workers", "proj");
		mkdirSync(planted, { recursive: true });
		writeFileSync(join(planted, "apt.txt"), "planted\n");
		const text = await (
			await post(r.url, "/run", request({ lists: { apt: "nope\n" } }))
		).text();
		expect(text).toContain("apt: installing nope\n");
		const done = sentinelOf(text);
		expect(done?.exitCode).toBe(1);
		expect(done?.stderrTail).toContain("Unable to locate package nope");
		// Only the bake VM booted, with the layer writable, and it got the list.
		expect(r.recs).toHaveLength(1);
		const bakeVm = r.recs[0]!;
		expect(bakeVm.spec.mode).toBe("bake");
		expect(bakeVm.spec.drives.find((d) => d.id === "vdb")?.readOnly).toBe(
			false,
		);
		const sent = await members(bakeVm.puts[0]!);
		expect(
			sent.find((s) => s.m.name === "root/.ottr/workers/proj/apt.txt")?.content,
		).toBe("nope\n");
		expect(bakeVm.bakeBody).toEqual({
			project: "proj",
			lists: { apt: "nope\n" },
		});
		expect(bakeVm.killed).toBe(true);
	});

	// The bake rootfs both new tests share: the layer() callback runs the bake and
	// publishes only on exitCode 0, like the failed-bake test above.
	const shutdownBakeRootfs = {
		base: async () => ({ key: "base", path: "/state/base.ext4" }),
		layer: async (
			_p: string,
			_lists: ProvisionLists,
			bake: (image: string) => Promise<BakeResult>,
		) => {
			const b = await bake("/state/layer.tmp");
			return b.exitCode === 0
				? { ok: true as const, path: "/state/layer.tmp" }
				: { ok: false as const, stderrTail: b.stderrTail };
		},
	};
	// The agent answers /shutdown, then the VM powers off; the delay models the real
	// agent's deferred exit after the response flushes (real clock, can't fake the socket).
	const shutdownScript = (): GuestScript => ({
		bake: () =>
			ndjson(
				JSON.stringify({ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } }),
			),
		shutdown: (rec) => {
			setTimeout(() => rec.crash(), 20);
			return new Response("ok");
		},
	});

	test("a clean bake shutdown powers the VM off and reads the bake status", async () => {
		const r = startRunner({
			rootfs: shutdownBakeRootfs,
			script: shutdownScript(),
		});
		const text = await (await post(r.url, "/run", request())).text();
		expect(sentinelOf(text)?.exitCode).toBe(0);
		// PID 1 reports the shutdown outcome on the bake-status disk (vdc), which
		// vm-runner reads with debugfs: exactly one call, at the bake VM's vdc path.
		const debugfs = r.execs.filter((a) => a[0] === "debugfs");
		expect(debugfs).toHaveLength(1);
		const vdc = r.recs[0]!.spec.drives.find((d) => d.id === "vdc")!;
		expect(debugfs[0]).toEqual(["debugfs", "-R", "cat /bake-status", vdc.path]);
		// The bake VM boots with the status disk writable beside the layer.
		expect(r.recs[0]!.spec.drives).toHaveLength(3);
		expect(vdc.readOnly).toBe(false);
	});

	test("a failed layer unmount fails the bake", async () => {
		const r = startRunner({
			rootfs: shutdownBakeRootfs,
			script: shutdownScript(),
			execHook: (argv) =>
				argv[0] === "debugfs"
					? { code: 0, stdout: "layer-unmount-failed\n", stderr: "" }
					: null,
		});
		const text = await (await post(r.url, "/run", request())).text();
		const done = sentinelOf(text);
		expect(done?.exitCode).toBe(1);
		expect(done?.stderrTail).toContain("could not unmount the project layer");
	});

	test("a bake pushes only the dispatch's trusted lists, never the planted shared-home files", async () => {
		// A local listener serves the trusted tool bytes; the trusted texts name it.
		// The fetch itself is the guest test's proof; here the pushed tar bytes and
		// the /bake body are.
		const served = "trusted-tool-bytes";
		const listener = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(served),
		});
		stoppers.push(() => listener.stop(true));
		const base = `http://127.0.0.1:${listener.port}`;
		const servedSha = new Bun.CryptoHasher("sha256")
			.update(served)
			.digest("hex");
		const trusted: ProvisionLists = {
			tools: JSON.stringify([
				{ name: "trusted-tool", url: `${base}/t.tar.gz`, sha256: servedSha },
			]),
			toolsAll: JSON.stringify([
				{ name: "fleet-tool", url: `${base}/f.tar.gz`, sha256: servedSha },
			]),
			apt: "jq\nripgrep\n",
			requirements: `r==1 --hash=sha256:${"a".repeat(64)}\n`,
			requirementsAll: `q==2 --hash=sha256:${"b".repeat(64)}\n`,
		};
		const r = startRunner({
			rootfs: shutdownBakeRootfs,
			script: shutdownScript(),
		});
		// The victim project's lists sit planted in the shared home this runner
		// mounts read-only; none of them may reach the bake.
		const workers = join(r.homeRoot, ".ottr", "workers");
		for (const [dir, file, text] of [
			["proj", "tools.json", '[{"name":"planted-tool"}]'],
			["proj", "apt.txt", "planted-pkg\n"],
			[
				"proj",
				"requirements.txt",
				`planted==9 --hash=sha256:${"c".repeat(64)}\n`,
			],
			["_all", "tools.json", '[{"name":"planted-fleet"}]'],
			[
				"_all",
				"requirements.txt",
				`planted-all==9 --hash=sha256:${"d".repeat(64)}\n`,
			],
		] as const) {
			mkdirSync(join(workers, dir), { recursive: true });
			writeFileSync(join(workers, dir, file), text);
		}
		const first = await (
			await post(r.url, "/run", request({ lists: trusted }))
		).text();
		expect(sentinelOf(first)?.exitCode).toBe(0);
		const bakeVm = r.recs[0]!;
		expect(bakeVm.spec.mode).toBe("bake");
		// The copy-in tar holds exactly the request-borne members with the trusted
		// bytes, at the guest paths the ensure wrappers read; the planted names are
		// absent.
		const sent = await members(bakeVm.puts[0]!);
		const guestRoot = "root/.ottr/workers";
		expect(sent.map((s) => s.m.name).sort()).toEqual(
			[
				`${guestRoot}/proj/apt.txt`,
				`${guestRoot}/proj/tools.json`,
				`${guestRoot}/_all/tools.json`,
				`${guestRoot}/proj/requirements.txt`,
				`${guestRoot}/_all/requirements.txt`,
			].sort(),
		);
		const byName = new Map(sent.map((s) => [s.m.name, s.content]));
		expect(byName.get(`${guestRoot}/proj/tools.json`)).toBe(trusted.tools);
		expect(byName.get(`${guestRoot}/_all/tools.json`)).toBe(trusted.toolsAll);
		expect(byName.get(`${guestRoot}/proj/apt.txt`)).toBe(trusted.apt);
		expect(byName.get(`${guestRoot}/proj/requirements.txt`)).toBe(
			trusted.requirements,
		);
		expect(byName.get(`${guestRoot}/_all/requirements.txt`)).toBe(
			trusted.requirementsAll,
		);
		for (const s of sent) expect(s.content).not.toContain("planted");
		// The /bake body carries the trusted texts.
		expect(bakeVm.bakeBody).toEqual({ project: "proj", lists: trusted });

		// The same dispatch with no lists: no list members are pushed and the /bake
		// body names none — no shared-home fallback.
		const second = await (await post(r.url, "/run", request())).text();
		expect(sentinelOf(second)?.exitCode).toBe(0);
		const bake2 = r.recs[2]!;
		expect(bake2.spec.mode).toBe("bake");
		expect(bake2.puts).toHaveLength(0);
		expect(bake2.bakeBody).toEqual({ project: "proj" });
	});

	test("a VM that dies mid-run ends the stream without a sentinel", async () => {
		const held = heldGuest();
		const r = startRunner({ script: { run: held.run } });
		const res = await post(r.url, "/run", request());
		const reader = res.body!.getReader();
		await reader.read();
		r.recs[0]!.crash();
		let rest = "";
		for (;;) {
			const c = await reader.read();
			if (c.done) break;
			rest += new TextDecoder().decode(c.value);
		}
		expect(sentinelOf(rest)).toBeNull();
	});

	test("a VM that exits during boot reports its boot log, not stopped", async () => {
		const r = startRunner({
			script: {
				healthz: (rec) => {
					rec.crash();
					return new Response("died", { status: 503 });
				},
			},
		});
		const text = await (await post(r.url, "/run", request())).text();
		expect(text).toContain("the microVM exited during boot");
		expect(text).toContain("fake console");
		expect(text).not.toContain("vm-runner: stopped");
		expect(sentinelOf(text)?.exitCode).toBe(1);
	});

	test("a client abort kills the VM and frees the slot", async () => {
		const held = heldGuest();
		const r = startRunner({ max: 1, script: { run: held.run } });
		const ac = new AbortController();
		const res = await post(r.url, "/run", request(), ac.signal);
		await res.body!.getReader().read();
		ac.abort();
		await until(() => r.recs[0]!.killed, "vm kill on abort");
		await until(async () => {
			const again = await post(r.url, "/run", request());
			if (again.status === 503) return false;
			await again.body?.cancel();
			return true;
		}, "slot release");
	});
});

describe("vm-runner detach", () => {
	test("a detached run keeps its VM, reports cwd while running and the result with the vm outcome after", async () => {
		const held = heldGuest();
		const r = startRunner({ script: { run: held.run } });
		const req = request();
		const res = await post(r.url, "/run", req);
		const reader = res.body!.getReader();
		await reader.read();
		const d = await post(r.url, "/detach", {});
		const detachAnswer: { detached: number } = await d.json();
		expect(detachAnswer.detached).toBe(1);
		// The stream ends for the gone board; the VM keeps running.
		while (!(await reader.read()).done) {
			// drain
		}
		let entry = (await detachedList(r.url))[0];
		expect(entry?.id).toBe(req.id);
		expect(entry?.cwd).toBe(req.cwd);
		expect(entry?.running).toBe(true);
		expect(entry?.pid).toBe(4242);
		expect(entry?.result).toBeUndefined();
		expect(r.recs[0]!.killed).toBe(false);
		held.release();
		await until(
			async () => (await detachedList(r.url))[0]?.running === false,
			"detached run end",
		);
		entry = (await detachedList(r.url))[0];
		expect(entry?.result).toEqual({
			exitCode: 0,
			stderrTail: "",
			vm: DONE_OK.vm,
		});
		expect(entry?.killed).toBeUndefined();
	});

	test("/detach/kill stops the detached VM and records no result", async () => {
		const held = heldGuest();
		const r = startRunner({ script: { run: held.run } });
		const req = request();
		const res = await post(r.url, "/run", req);
		const reader = res.body!.getReader();
		await reader.read();
		await post(r.url, "/detach", {});
		while (!(await reader.read()).done) {
			// drain
		}
		expect((await post(r.url, "/detach/kill", { id: "nope" })).status).toBe(
			404,
		);
		const k = await post(r.url, "/detach/kill", { id: req.id });
		expect(k.status).toBe(200);
		await until(() => r.recs[0]!.killed, "vm kill");
		// Teardown of the killed VM ran: the entry is final.
		await until(
			() => r.execs.some((a) => a.join(" ") === "ip link del ovm0"),
			"teardown",
		);
		const entry = (await detachedList(r.url))[0];
		expect(entry?.killed).toBe(true);
		expect(entry?.running).toBe(false);
		expect(entry?.result).toBeUndefined();
	});

	test("an expired running entry stays killable: the sweep keeps it, kill stops the VM and frees the slot", async () => {
		const held = heldGuest();
		const clock = { t: Date.now() };
		const r = startRunner({
			max: 1,
			script: { run: held.run },
			detachedTtlMs: 30,
			now: () => clock.t,
		});
		const req = request();
		const res = await post(r.url, "/run", req);
		const reader = res.body!.getReader();
		await reader.read();
		await post(r.url, "/detach", {});
		while (!(await reader.read()).done) {
			// drain
		}
		// Past the ttl the VM still runs: the sweep must keep the entry killable.
		// The injected clock ages the entry deterministically.
		clock.t += 31;
		const entry = (await detachedList(r.url))[0];
		expect(entry?.id).toBe(req.id);
		expect(entry?.running).toBe(true);
		const k = await post(r.url, "/detach/kill", { id: req.id });
		expect(k.status).toBe(200);
		await until(() => r.recs[0]!.killed, "vm kill");
		await until(async () => {
			const again = await post(r.url, "/run", request());
			if (again.status === 503) return false;
			await again.body?.cancel();
			return true;
		}, "slot release");
		// Reaped and expired: the entry is gone, and a later kill names the expiry.
		await detachedList(r.url);
		const late = await post(r.url, "/detach/kill", { id: req.id });
		expect(late.status).toBe(410);
		expect(await late.text()).toContain("expired");
	});
});

describe("vm-runner health and refusals", () => {
	test("/healthz answers 503 with the reason until KVM, kernel, firecracker and the network are there", async () => {
		const noKvm = startRunner({ exists: (p) => p !== "/dev/kvm" });
		let h = await fetch(`${noKvm.url}/healthz`);
		expect(h.status).toBe(503);
		expect(await h.text()).toContain("/dev/kvm");
		// A /run on a host that cannot boot is not the busy answer.
		const run = await post(noKvm.url, "/run", request());
		expect(run.status).toBe(503);
		expect(run.headers.get("x-ottr-busy")).toBeNull();

		const noKernel = startRunner({
			exists: (p) => p !== "/opt/ottr-vm/vmlinux",
		});
		h = await fetch(`${noKernel.url}/healthz`);
		expect(h.status).toBe(503);
		expect(await h.text()).toContain("/opt/ottr-vm/vmlinux");

		const noNet = startRunner({ netError: "iptables: no chain" });
		h = await fetch(`${noNet.url}/healthz`);
		expect(h.status).toBe(503);
		expect(await h.text()).toBe("network setup failed: iptables: no chain");

		const ok = startRunner();
		h = await fetch(`${ok.url}/healthz`);
		expect(h.status).toBe(200);
		expect(await h.text()).toBe("ok");
	});

	test("/sweep and /signins do not exist, and /run needs the worker token", async () => {
		const r = startRunner();
		expect((await post(r.url, "/sweep", {})).status).toBe(404);
		expect((await fetch(`${r.url}/signins`)).status).toBe(404);
		const res = await fetch(`${r.url}/run`, {
			method: "POST",
			headers: { "x-otwr-token": "wrong" },
			body: JSON.stringify(request()),
		});
		expect(res.status).toBe(401);
	});
});

/* ------------------------------------------------------------------------------------ */
/* /validate: one synchronous job in one network-less VM                                  */
/* ------------------------------------------------------------------------------------ */

const VALID_RESULT: ValidateResult = {
	schema: 1,
	id: "val-1",
	selfCheck: {
		ok: true,
		checks: [
			{ name: "interfaces", ok: true, detail: "/sys/class/net holds only lo" },
		],
	},
	missingControl: null,
	job: {
		argv: ["bun", "test", "src/parse.ts"],
		cwd: "/target",
		exitCode: 0,
		signal: null,
		timedOut: false,
		stdoutTail: "1 pass\n",
		stderrTail: "",
	},
	artifacts: [],
	endedAt: 1_700_000_000,
};

/** Seeds the target tar a /validate request names, under the project's data root. */
function seedTarget(r: TestRunner, id: string): string {
	const dir = join(r.dataRoot, "proj", "validate-jobs", id);
	mkdirSync(dir, { recursive: true });
	const tar = join(dir, "target.tar");
	writeFileSync(
		tar,
		rawTar([
			{ name: "docs", type: "5" },
			{ name: "README.md", content: "hello" },
			{ name: "src/parse.ts", content: "export const one = 1;\n" },
		]),
	);
	return tar;
}

function validateBody(
	targetTar: string,
	over: Partial<ValidateRequest> = {},
): ValidateRequest {
	return {
		id: "val-1",
		project: "proj",
		targetTar,
		job: {
			argv: ["bun", "test", "src/parse.ts"],
			cwd: "/target",
			collect: ["work/poc.txt"],
		},
		...over,
	};
}

describe("vm-runner /validate", () => {
	test("acceptance: builds a network-less VM at the fixed limits and answers the guest's result", async () => {
		const result = { ...VALID_RESULT, id: "val-acc" };
		const r = startRunner({ script: { validateResult: result } });
		const res = await post(
			r.url,
			"/validate",
			validateBody(seedTarget(r, "val-acc"), { id: "val-acc" }),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as ValidateResponse;
		expect(body.id).toBe("val-acc");
		expect(body.limits).toEqual(VM_VALIDATE);
		expect(body.resultSource).toBe("guest");
		expect(body.selfCheck).toEqual(result.selfCheck);
		expect(body.missingControl).toBeNull();
		expect(body.job).toEqual(result.job);
		expect(body.artifacts).toEqual([]);
		expect(body.bootMs).toBeNull();
		expect(typeof body.totalMs).toBe("number");
		// One validate boot, no bake: no tap command and no iptables rule ran.
		expect(r.recs).toHaveLength(1);
		const vm = r.recs[0]!;
		expect(vm.spec.mode).toBe("validate");
		const cfg = firecrackerConfig(vm.spec);
		expect("network-interfaces" in cfg).toBe(false);
		expect(cfg["machine-config"]).toEqual({
			vcpu_count: 1,
			mem_size_mib: VM_VALIDATE.memMiB,
			smt: false,
		});
		const drives = cfg.drives as {
			drive_id: string;
			is_read_only: boolean;
		}[];
		expect(drives.map((d) => [d.drive_id, d.is_read_only])).toEqual([
			["vda", true],
			["vdb", true],
			["vdc", false],
			["vdd", false],
			["vde", true],
		]);
		// No ip=, no token, no board on the cmdline: only the mode flag.
		expect(vm.spec.bootArgs).toBe(
			"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/usr/local/bin/ottr-vm-init ottr.mode=validate",
		);
		expect(r.execs.some((a) => a[0] === "iptables" || a[0] === "ip")).toBe(
			false,
		);
		// The result record landed parent-owned under the project's data root, identical
		// to the answer.
		const record = JSON.parse(
			readFileSync(
				join(r.dataRoot, "proj", "validate-jobs", "val-acc", "result.json"),
				"utf8",
			),
		) as ValidateResponse;
		expect(record).toEqual(body);
		// Teardown: the run dir is gone and the slot takes a new job again.
		await until(
			() =>
				!existsSync(join(r.stateDir, "runs")) ||
				readdirSync(join(r.stateDir, "runs")).length === 0,
			"run dir cleanup",
		);
		const again = await post(
			r.url,
			"/validate",
			validateBody(seedTarget(r, "val-next"), { id: "val-next" }),
		);
		expect(again.status).toBe(200);
		await again.text();
	});

	test("answers absent with the serial tail when the VM wrote no result", async () => {
		const r = startRunner();
		const res = await post(
			r.url,
			"/validate",
			validateBody(seedTarget(r, "val-absent")),
		);
		// The job failed, not the runner: still a 200 JSON answer.
		expect(res.status).toBe(200);
		const body = (await res.json()) as ValidateResponse;
		expect(body.resultSource).toBe("absent");
		expect(body.error).toContain("the guest wrote no result");
		expect(body.logTail).toContain("fake console");
		expect(body.selfCheck).toBeNull();
		expect(body.job).toBeNull();
		expect(body.artifacts).toEqual([]);
	});

	test("refuses malformed requests with a one-line reason and needs the token", async () => {
		const r = startRunner();
		const good = validateBody(seedTarget(r, "val-bad"));
		const cases: unknown[] = [
			{ ...good, id: "bad id!" },
			{ ...good, id: "" },
			{ ...good, project: "no/slashes" },
			{ ...good, targetTar: join(r.dataRoot, "elsewhere", "target.tar") },
			{ ...good, job: { argv: [], cwd: "/target" } },
			{ ...good, job: { argv: ["true"], cwd: "/tmp" } },
			{ ...good, job: { argv: ["true"], cwd: "/target/../x" } },
			{ ...good, job: { argv: ["true"], cwd: "/target/x/" } },
			{
				...good,
				job: {
					argv: ["true"],
					cwd: "/target",
					collect: Array.from({ length: 17 }, (_, i) => `f${i}`),
				},
			},
			{
				...good,
				job: { argv: ["true"], cwd: "/target", collect: ["../escape"] },
			},
			{ ...good, job: { argv: ["true"], cwd: "/target", collect: ["/abs"] } },
			{ ...good, lists: "tools.json" },
			{ ...good, lists: { apt: 3 } },
		];
		for (const body of cases) {
			const res = await post(r.url, "/validate", body);
			expect(res.status).toBe(400);
			expect((await res.text()).length).toBeGreaterThan(0);
		}
		// A link that leaves the project's data root is refused like a copy-in path.
		mkdirSync(join(r.dataRoot, "elsewhere"), { recursive: true });
		writeFileSync(join(r.dataRoot, "elsewhere", "secret.tar"), "x");
		symlinkSync(
			join(r.dataRoot, "elsewhere"),
			join(r.dataRoot, "proj", "link"),
		);
		const linkRes = await post(
			r.url,
			"/validate",
			validateBody(join(r.dataRoot, "proj", "link", "secret.tar")),
		);
		expect(linkRes.status).toBe(400);
		expect(await linkRes.text()).toContain("through a link");
		expect(r.recs).toHaveLength(0);
		// The endpoint shares /run's token gate.
		const unauth = await fetch(`${r.url}/validate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-otwr-token": "wrong",
			},
			body: JSON.stringify(good),
		});
		expect(unauth.status).toBe(401);
	});

	test("answers busy with x-ottr-busy when the shared slot pool is full", async () => {
		const held = heldGuest();
		const r = startRunner({ max: 1, script: { run: held.run } });
		const body = validateBody(seedTarget(r, "val-busy"), { id: "val-busy" });
		const first = await post(r.url, "/run", request());
		const reader = first.body!.getReader();
		await reader.read(); // the guest's first event: the VM holds the slot
		const busy = await post(r.url, "/validate", body);
		expect(busy.status).toBe(503);
		expect(busy.headers.get("x-ottr-busy")).toBe("1");
		held.release();
		while (!(await reader.read()).done) {
			// drain to the end of the first run
		}
		await until(async () => {
			const again = await post(r.url, "/validate", body);
			if (again.status === 503) return false;
			expect(again.status).toBe(200);
			await again.text();
			return true;
		}, "free slot");
	});

	test("healthz reports the pool usage the board's probe reads (OTTR-1142)", async () => {
		const held = heldGuest();
		const r = startRunner({ max: 2, script: { run: held.run } });
		const free = await fetch(`${r.url}/healthz`);
		expect(free.status).toBe(200);
		expect(free.headers.get("x-ottr-vms-max")).toBe("2");
		expect(free.headers.get("x-ottr-vms-busy")).toBe("0");
		const first = await post(r.url, "/run", request());
		const reader = first.body!.getReader();
		await reader.read(); // the guest's first event: the VM holds the slot
		const full = await fetch(`${r.url}/healthz`);
		expect(full.status).toBe(200);
		expect(full.headers.get("x-ottr-vms-busy")).toBe("1");
		// The board's probe writes both counts into the pool state its start gate reads.
		const savedPool = vmState.pool;
		const savedHealth = vmState.health;
		try {
			await probeVmRunner({ urls: [r.url], token: "tok" });
			expect(vmState.health.ok).toBe(true);
			expect(vmState.pool).toEqual({ busy: 1, max: 2 });
		} finally {
			vmState.pool = savedPool;
			vmState.health = savedHealth;
		}
		held.release();
		while (!(await reader.read()).done) {
			// drain to the end of the run
		}
	});

	test("builds both disks with mkfs.ext4 -d and stages the job input before the scratch mkfs", async () => {
		const mkfs: {
			argv: string[];
			imageSize: number;
			jobJson: string | null;
		}[] = [];
		const r = startRunner({
			script: { validateResult: { ...VALID_RESULT, id: "val-mkfs" } },
			exec: async (argv) => {
				if (argv[0] !== "mkfs.ext4") return { code: 0, stdout: "", stderr: "" };
				const staging = argv[argv.indexOf("-d") + 1]!;
				const image = argv[argv.length - 1]!;
				const jobPath = join(staging, "job", "job.json");
				mkfs.push({
					argv: [...argv],
					imageSize: statSync(image).size,
					jobJson: existsSync(jobPath) ? readFileSync(jobPath, "utf8") : null,
				});
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		const res = await post(
			r.url,
			"/validate",
			validateBody(seedTarget(r, "val-mkfs"), { id: "val-mkfs" }),
		);
		expect(res.status).toBe(200);
		await res.text();
		expect(mkfs).toHaveLength(2);
		const target = mkfs[0]!;
		const scratch = mkfs[1]!;
		// Both disks are populated from their own staging tree with mkfs.ext4 -d.
		expect(target.argv.slice(0, 2)).toEqual(["mkfs.ext4", "-d"]);
		expect(target.argv[2]).toContain("staging-target");
		expect(target.argv.slice(3, 5)).toEqual(["-F", "-q"]);
		expect(target.argv[5]).toContain("target.ext4");
		expect(scratch.argv[2]).toContain("staging-scratch");
		expect(scratch.argv[5]).toContain("scratch.ext4");
		// The disks exist at their planned sizes: the scratch exactly the fixed 1 GiB,
		// the target at the 64 MiB floor for this small checkout.
		expect(scratch.imageSize).toBe(VM_VALIDATE.diskBytes);
		expect(target.imageSize).toBe(64 * 1024 * 1024);
		// The scratch staging held the job input when its mkfs ran; the target's held none.
		expect(target.jobJson).toBeNull();
		expect(scratch.jobJson).not.toBeNull();
		const job = JSON.parse(scratch.jobJson!) as ValidateJobSpec;
		expect(job).toEqual({
			schema: 1,
			id: "val-mkfs",
			argv: ["bun", "test", "src/parse.ts"],
			cwd: "/target",
			collect: ["work/poc.txt"],
		});
	});

	test("a cache miss bakes through the networked bake VM while the validate boot stays network-less", async () => {
		const bakeRootfs = {
			base: async () => ({ key: "base", path: "/state/base.ext4" }),
			layer: async (
				_p: string,
				_lists: ProvisionLists,
				bake: (image: string) => Promise<BakeResult>,
			) => {
				const b = await bake("/state/layer.tmp");
				return b.exitCode === 0
					? { ok: true as const, path: "/state/layer.tmp" }
					: { ok: false as const, stderrTail: b.stderrTail };
			},
		};
		const r = startRunner({
			rootfs: bakeRootfs,
			script: { validateResult: { ...VALID_RESULT, id: "val-bake" } },
		});
		const res = await post(
			r.url,
			"/validate",
			validateBody(seedTarget(r, "val-bake"), { id: "val-bake" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ValidateResponse;
		expect(body.resultSource).toBe("guest");
		expect(body.error).toBeUndefined();
		// Two boots: the bake VM first, then the validate VM on the baked layer.
		expect(r.recs).toHaveLength(2);
		const bakeVm = r.recs[0]!;
		const validateVm = r.recs[1]!;
		expect(bakeVm.spec.mode).toBe("bake");
		expect("network-interfaces" in firecrackerConfig(bakeVm.spec)).toBe(true);
		expect(bakeVm.spec.bootArgs).toContain("ottr.mode=bake");
		expect(bakeVm.spec.bootArgs).toContain("ottr.board=172.18.0.5");
		expect(bakeVm.spec.bootArgs).toContain("ottr.boardhost=ottr");
		expect(bakeVm.spec.drives.map((d) => [d.id, d.readOnly])).toEqual([
			["vda", true],
			["vdb", false],
		]);
		expect(validateVm.spec.mode).toBe("validate");
		expect("network-interfaces" in firecrackerConfig(validateVm.spec)).toBe(
			false,
		);
		expect(validateVm.spec.drives.find((d) => d.id === "vdb")?.path).toBe(
			"/state/layer.tmp",
		);
		// The bake brought the slot's tap and board rule up on the default port, then down.
		const board = { ip: "172.18.0.5", port: 8080 };
		for (const argv of slotUpCommands(slotFor(0), board))
			expect(r.execs).toContainEqual(argv);
		for (const argv of slotDownCommands(slotFor(0), board))
			expect(r.execs).toContainEqual(argv);
		await until(() => bakeVm.killed, "bake vm kill");
	});

	test("the validate bake pushes only the dispatch's trusted lists, never the planted shared-home files", async () => {
		const served = "trusted-tool-bytes";
		const listener = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(served),
		});
		stoppers.push(() => listener.stop(true));
		const base = `http://127.0.0.1:${listener.port}`;
		const servedSha = new Bun.CryptoHasher("sha256")
			.update(served)
			.digest("hex");
		const trusted: ProvisionLists = {
			tools: JSON.stringify([
				{ name: "trusted-tool", url: `${base}/t.tar.gz`, sha256: servedSha },
			]),
			apt: "jq\n",
			requirementsAll: `q==2 --hash=sha256:${"b".repeat(64)}\n`,
		};
		const bakeRootfs = {
			base: async () => ({ key: "base", path: "/state/base.ext4" }),
			layer: async (
				_p: string,
				_lists: ProvisionLists,
				bake: (image: string) => Promise<BakeResult>,
			) => {
				const b = await bake("/state/layer.tmp");
				return b.exitCode === 0
					? { ok: true as const, path: "/state/layer.tmp" }
					: { ok: false as const, stderrTail: b.stderrTail };
			},
		};
		const r = startRunner({
			rootfs: bakeRootfs,
			script: { validateResult: { ...VALID_RESULT, id: "val-lists" } },
		});
		const workers = join(r.homeRoot, ".ottr", "workers");
		for (const [dir, file, text] of [
			["proj", "tools.json", '[{"name":"planted-tool"}]'],
			["proj", "apt.txt", "planted-pkg\n"],
			["_all", "requirements.txt", "planted-all\n"],
		] as const) {
			mkdirSync(join(workers, dir), { recursive: true });
			writeFileSync(join(workers, dir, file), text);
		}
		const res = await post(
			r.url,
			"/validate",
			validateBody(seedTarget(r, "val-lists"), {
				id: "val-lists",
				lists: trusted,
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ValidateResponse;
		expect(body.resultSource).toBe("guest");
		// Same assertions as the run path: the copy-in tar holds exactly the
		// request-borne members with the trusted bytes, and the /bake body carries
		// the trusted texts.
		const bakeVm = r.recs[0]!;
		expect(bakeVm.spec.mode).toBe("bake");
		const sent = await members(bakeVm.puts[0]!);
		const guestRoot = "root/.ottr/workers";
		expect(sent.map((s) => s.m.name).sort()).toEqual(
			[
				`${guestRoot}/proj/apt.txt`,
				`${guestRoot}/proj/tools.json`,
				`${guestRoot}/_all/requirements.txt`,
			].sort(),
		);
		const byName = new Map(sent.map((s) => [s.m.name, s.content]));
		expect(byName.get(`${guestRoot}/proj/tools.json`)).toBe(trusted.tools);
		expect(byName.get(`${guestRoot}/proj/apt.txt`)).toBe(trusted.apt);
		expect(byName.get(`${guestRoot}/_all/requirements.txt`)).toBe(
			trusted.requirementsAll,
		);
		for (const s of sent) expect(s.content).not.toContain("planted");
		expect(bakeVm.bakeBody).toEqual({ project: "proj", lists: trusted });

		// No lists on the dispatch: no list members are pushed, the /bake body
		// names none, and the planted files stay unread.
		const res2 = await post(
			r.url,
			"/validate",
			validateBody(seedTarget(r, "val-nolists"), { id: "val-nolists" }),
		);
		expect(res2.status).toBe(200);
		expect(((await res2.json()) as ValidateResponse).resultSource).toBe(
			"guest",
		);
		const bake2 = r.recs[2]!;
		expect(bake2.spec.mode).toBe("bake");
		expect(bake2.puts).toHaveLength(0);
		expect(bake2.bakeBody).toEqual({ project: "proj" });
	});
});

/** GET /stats's body: the worker stats spread plus the vm-runner fields. */
type StatsBody = CgroupReading & {
	vms: SystemVm[];
	max: number;
	disk: VmStateDisk;
};

describe("vm-runner /stats", () => {
	const getStats = (url: string, token?: string): Promise<Response> =>
		fetch(`${url}/stats`, {
			headers: token === undefined ? {} : { "x-otwr-token": token },
		});

	test("needs the worker token and answers the stats spread when idle", async () => {
		const r = startRunner();
		const none = await getStats(r.url);
		expect(none.status).toBe(401);
		const wrong = await getStats(r.url, "wrong");
		expect(wrong.status).toBe(401);
		const ok = await getStats(r.url, "tok");
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as StatsBody;
		expect(body.vms).toEqual([]);
		expect(body.max).toBe(2);
		// A fresh state dir holds no disks yet: every part reads zero, no throw.
		expect(body.disk).toEqual({ base: 0, layers: 0, runs: 0 });
	});

	test("lists one live turn VM with its allocated scratch size, then none after it ends", async () => {
		const held = heldGuest();
		// Real bytes into the sparse scratch at mkfs time, so its allocated size
		// is deterministic: 4096 allocated while the file's apparent size stays
		// the configured 1 MiB.
		const r = startRunner({
			script: { run: held.run },
			execHook: (argv) => {
				if (argv[0] === "mkfs.ext4") {
					const fd = openSync(argv[argv.length - 1]!, "r+");
					try {
						writeSync(fd, Buffer.alloc(4096, 1));
					} finally {
						closeSync(fd);
					}
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		const body = request();
		const first = await post(r.url, "/run", body);
		const reader = first.body!.getReader();
		await reader.read(); // the guest's first event: the VM is live
		const stats = await getStats(r.url, "tok");
		expect(stats.status).toBe(200);
		const s = (await stats.json()) as StatsBody;
		expect(s.vms).toHaveLength(1);
		const vm = s.vms[0]!;
		expect(vm.id).toBe(body.id);
		expect(vm.project).toBe("proj");
		expect(vm.cardId).toBe("P-1");
		expect(vm.mode).toBe("turn");
		expect(vm.vcpus).toBe(2);
		expect(vm.memMiB).toBe(512);
		expect(typeof vm.startedAt).toBe("number");
		// Allocated, not apparent: the scratch holds 4096 real bytes inside its
		// 1 MiB sparse file.
		expect(vm.scratchBytes).toBe(4096);
		const runDir = join(
			r.stateDir,
			"runs",
			readdirSync(join(r.stateDir, "runs"))[0]!,
		);
		expect(statSync(join(runDir, "scratch.ext4")).size).toBe(1024 * 1024);
		// The worker stats spread rides along; runs lists the live pids (this
		// fake pid exists under no /proc, so the usage list stays empty).
		expect("at" in s).toBe(true);
		expect("cpuUsageUsec" in s).toBe(true);
		expect("memoryCurrent" in s).toBe(true);
		expect("lock" in s).toBe(true);
		expect(Array.isArray(s.runs)).toBe(true);
		expect(s.max).toBe(2);
		held.release();
		while (!(await reader.read()).done) {
			// drain to the end of the run
		}
		await until(async () => {
			const after = (await (await getStats(r.url, "tok")).json()) as StatsBody;
			return after.vms.length === 0;
		}, "the ended run to leave /stats");
	});

	test("lists one live validate VM with the sandbox job's card id and fixed limits", async () => {
		const held = gate();
		const r = startRunner({
			max: 1,
			script: { validateResult: { ...VALID_RESULT, id: "val-stats" } },
			// Hold the scratch mkfs: the job is mid-flight with its scratch disk
			// created. A job gated earlier than that is hard to time, so the
			// scratchBytes-null case relies on the code path (scratchPath starts null).
			exec: async (argv) => {
				if (
					argv[0] === "mkfs.ext4" &&
					argv[argv.length - 1]!.endsWith("scratch.ext4")
				)
					await held.wait;
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		const pending = post(
			r.url,
			"/validate",
			validateBody(seedTarget(r, "val-stats"), {
				id: "val-stats",
				taskId: "R-9",
			}),
		);
		await until(async () => {
			const s = (await (await getStats(r.url, "tok")).json()) as StatsBody;
			return s.vms.length === 1;
		}, "the validate job to appear in /stats");
		const s = (await (await getStats(r.url, "tok")).json()) as StatsBody;
		const vm = s.vms[0]!;
		expect(vm.id).toBe("val-stats");
		expect(vm.mode).toBe("validate");
		expect(vm.project).toBe("proj");
		expect(vm.cardId).toBe("R-9");
		expect(vm.vcpus).toBe(VM_VALIDATE.vcpus);
		expect(vm.memMiB).toBe(VM_VALIDATE.memMiB);
		held.open();
		const res = await pending;
		expect(res.status).toBe(200);
		await res.text();
		await until(async () => {
			const after = (await (await getStats(r.url, "tok")).json()) as StatsBody;
			return after.vms.length === 0;
		}, "the finished job to leave /stats");
	});

	test("the validate guest RAM stays at or above the browser floor (OTTR-1167)", () => {
		// 512 MiB could not start Chrome's renderer: V8 process OOM reserving the
		// CodeRange, then every CDP command timed out (VELV-245's block). A later
		// edit that drops the constant below the floor re-blocks every browser
		// lead, so the floor is a test, not a comment.
		expect(VM_VALIDATE.memMiB).toBeGreaterThanOrEqual(2048);
	});

	test("vmStateDiskUsage reports allocated bytes per part and never throws on a missing tree", () => {
		const stateDir = mkdtempSync(join(root, "diskusage-"));
		mkdirSync(join(stateDir, "base"), { recursive: true });
		mkdirSync(join(stateDir, "layers", "proj"), { recursive: true });
		mkdirSync(join(stateDir, "runs", "0-aa"), { recursive: true });
		const sparse = (path: string, bytes: number): void => {
			sparseFile(path, bytes);
			const fd = openSync(path, "r+");
			try {
				writeSync(fd, Buffer.alloc(4096, 1));
			} finally {
				closeSync(fd);
			}
		};
		const base = join(stateDir, "base", "base.ext4");
		const layer = join(stateDir, "layers", "proj", "layer.ext4");
		const scratch = join(stateDir, "runs", "0-aa", "scratch.ext4");
		sparse(base, 65536);
		sparse(layer, 1024 * 1024);
		sparse(scratch, 1024 * 1024);
		// An extra subdir outside the three parts and a link inside one: neither
		// may add a byte.
		mkdirSync(join(stateDir, "extra"), { recursive: true });
		sparse(join(stateDir, "extra", "big.ext4"), 1024 * 1024);
		symlinkSync(base, join(stateDir, "layers", "proj", "link.ext4"));
		const alloc = (p: string): number => statSync(p).blocks * 512;
		const usage = vmStateDiskUsage(stateDir);
		expect(usage.base).toBe(alloc(base));
		expect(usage.base).toBeLessThan(statSync(base).size);
		expect(usage.layers).toBe(alloc(layer));
		expect(usage.layers).toBeLessThan(statSync(layer).size);
		expect(usage.runs).toBe(alloc(scratch));
		expect(usage.runs).toBeLessThan(statSync(scratch).size);
		expect(vmStateDiskUsage(join(stateDir, "missing"))).toEqual({
			base: 0,
			layers: 0,
			runs: 0,
		});
	});
});

describe("firecracker config", () => {
	test("drives keep vda/vdb/vdc order with their read-only flags and no root-device flag", () => {
		const slot = slotFor(1);
		const cfg = firecrackerConfig({
			runDir: "/state/runs/1-x/run",
			mode: "run",
			slot,
			vcpus: 4,
			memMiB: 8192,
			kernel: "/opt/ottr-vm/vmlinux",
			drives: [
				{ id: "vda", path: "/b.ext4", readOnly: true },
				{ id: "vdb", path: "/l.ext4", readOnly: true },
				{ id: "vdc", path: "/s.ext4", readOnly: false },
			],
			bootArgs: "console=ttyS0 root=/dev/vda ro",
		});
		expect(cfg).toEqual({
			"boot-source": {
				kernel_image_path: "/opt/ottr-vm/vmlinux",
				boot_args: "console=ttyS0 root=/dev/vda ro",
			},
			drives: [
				{
					drive_id: "vda",
					path_on_host: "/b.ext4",
					is_root_device: false,
					is_read_only: true,
				},
				{
					drive_id: "vdb",
					path_on_host: "/l.ext4",
					is_root_device: false,
					is_read_only: true,
				},
				{
					drive_id: "vdc",
					path_on_host: "/s.ext4",
					is_root_device: false,
					is_read_only: false,
				},
			],
			"machine-config": { vcpu_count: 4, mem_size_mib: 8192, smt: false },
			"network-interfaces": [
				{ iface_id: "eth0", guest_mac: slot.mac, host_dev_name: "ovm1" },
			],
		});
	});
});

/** A tar with one pax header carrying `record`, then one ordinary file member. */
function paxTar(record: string): Uint8Array {
	const header = (name: string, type: string, size: number): Uint8Array => {
		const b = new Uint8Array(512);
		const put = (off: number, s: string): void => b.set(enc.encode(s), off);
		put(0, name);
		put(124, `${size.toString(8).padStart(11, "0")}\0`);
		b.fill(0x20, 148, 156);
		b[156] = type.charCodeAt(0);
		put(257, "ustar  \0");
		let sum = 0;
		for (const x of b) sum += x;
		put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
		return b;
	};
	const payload = enc.encode(record);
	const pad = (n: number): Uint8Array =>
		new Uint8Array((512 - (n % 512)) % 512);
	const member = enc.encode("ok");
	const blocks = [
		header("././@PaxHeader", "x", payload.length),
		payload,
		pad(payload.length),
		header("data/f.txt", "0", member.length),
		member,
		pad(member.length),
		new Uint8Array(1024),
	];
	const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
	let off = 0;
	for (const b of blocks) {
		out.set(b, off);
		off += b.length;
	}
	return out;
}

describe("tar", () => {
	test("round-trips long names and symlinks through pax headers", async () => {
		const dir = mkdtempSync(join(root, "tar-"));
		const deep = join(dir, "x".repeat(90), "y".repeat(90));
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(deep, "file.txt"), "deep");
		symlinkSync(`/${"z".repeat(150)}`, join(deep, "ln"));
		const bytes = new Uint8Array(
			await new Response(tarStream([{ path: dir }])).arrayBuffer(),
		);
		const got = await members(bytes);
		const file = got.find((g) => g.m.name === join(deep, "file.txt").slice(1));
		expect(file?.content).toBe("deep");
		const ln = got.find((g) => g.m.name === join(deep, "ln").slice(1));
		expect(ln?.m.type).toBe("2");
		expect(ln?.m.linkname).toBe(`/${"z".repeat(150)}`);
	});

	// The symlink guard (src/confine.ts) needs /proc/self/fd: Linux only, like the VM runner.
	test.skipIf(!linux)(
		"copy-out never writes through a symlinked dir under the project root",
		async () => {
			const dataRoot = mkdtempSync(join(root, "co-"));
			const proj = join(dataRoot, "proj");
			const outside = join(dataRoot, "outside");
			mkdirSync(proj);
			mkdirSync(outside);
			symlinkSync(outside, join(proj, "sessions"));
			const out = await extractCopyOut(
				bodyOf(
					rawTar([
						{ name: `${proj.slice(1)}/sessions/x.txt`, content: "x" },
						{ name: `${proj.slice(1)}/ok/y.txt`, content: "y" },
					]),
				),
				proj,
				proj,
				new Set(),
			);
			expect(existsSync(join(outside, "x.txt"))).toBe(false);
			expect(out.refused).toEqual([`${proj.slice(1)}/sessions/x.txt`]);
			expect(readFileSync(join(proj, "ok", "y.txt"), "utf8")).toBe("y");
			// A link at the target itself (a file the run copied in) is replaced, not written
			// through.
			writeFileSync(join(outside, "target"), "keep");
			symlinkSync(join(outside, "target"), join(proj, "ok", "z.txt"));
			await extractCopyOut(
				bodyOf(rawTar([{ name: `${proj.slice(1)}/ok/z.txt`, content: "new" }])),
				proj,
				proj,
				new Set([join(proj, "ok", "z.txt")]),
			);
			expect(readFileSync(join(outside, "target"), "utf8")).toBe("keep");
			expect(readFileSync(join(proj, "ok", "z.txt"), "utf8")).toBe("new");
		},
	);

	// OTTR-954: a worker shares the data volume and can swap a parent dir for a symlink
	// after the walk checked it. The write must stay in the dir the walk opened.
	test.skipIf(!linux)(
		"copy-out stays in the held parent when a worker swaps it for a symlink mid-write",
		async () => {
			const dataRoot = mkdtempSync(join(root, "co-swap-"));
			const proj = join(dataRoot, "proj");
			const outside = join(dataRoot, "outside");
			mkdirSync(join(proj, "sub"), { recursive: true });
			mkdirSync(outside);
			let atSwap: string[] = [];
			// The swap runs from the extract path's own seam: the temp file is open in the
			// held parent and the member body is unwritten, with no chunk-boundary timing
			// to hold on a loaded box.
			const out = await extractCopyOut(
				bodyOf(rawTar([{ name: `${proj.slice(1)}/sub/x.txt`, content: "x" }])),
				proj,
				proj,
				new Set(),
				undefined,
				async () => {
					atSwap = readdirSync(join(proj, "sub"));
					renameSync(join(proj, "sub"), join(proj, "held"));
					symlinkSync(outside, join(proj, "sub"));
				},
			);
			expect(atSwap).toHaveLength(1);
			expect(out.written).toEqual([join(proj, "sub", "x.txt")]);
			expect(readdirSync(outside)).toEqual([]);
			expect(readdirSync(join(proj, "held"))).toEqual(["x.txt"]);
			expect(readFileSync(join(proj, "held", "x.txt"), "utf8")).toBe("x");
		},
	);

	test("a corrupt header is an error, not a silent partial extract", async () => {
		const bytes = rawTar([{ name: "data/p/a.txt", content: "a" }]);
		bytes[0] = bytes[0]! ^ 0xff;
		await expect(members(bytes)).rejects.toThrow("checksum");
	});

	test("readTar refuses a pax payload above the metadata cap before buffering it", async () => {
		// A pax header whose declared payload is 150 MiB, served by the stream in
		// 1 MiB chunks on demand like the guest's response body: the cap must throw
		// long before those bytes exist on the host.
		const size = 150 * 1024 * 1024;
		const h = new Uint8Array(512);
		const put = (off: number, s: string): void => h.set(enc.encode(s), off);
		put(0, "12 path=big\x0A"); // a well-formed pax record for the member
		put(124, `${size.toString(8).padStart(11, "0")}\0`);
		h.fill(0x20, 148, 156);
		h[156] = "x".charCodeAt(0);
		put(257, "ustar  \0");
		let sum = 0;
		for (const x of h) sum += x;
		put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
		let served = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				if (served === 0) {
					c.enqueue(h);
					served += h.length;
				} else if (served < size + h.length) {
					const n = Math.min(1024 * 1024, size + h.length - served);
					c.enqueue(new Uint8Array(n));
					served += n;
				} else c.close();
			},
		});
		const before = process.memoryUsage.rss();
		await expect(readTar(stream, async () => {})).rejects.toThrow(
			"tar metadata payload too large",
		);
		// The declared payload never flowed, and the host did not buffer it whole.
		expect(served).toBeLessThan(8 * 1024 * 1024);
		expect(process.memoryUsage.rss() - before).toBeLessThan(16 * 1024 * 1024);
	});

	test("an ordinary file above the metadata cap still reads whole", async () => {
		// The 1 MiB metadata cap binds only pax and GNU long-name payloads; a plain
		// file member is bound by the copy-out budgets, not the cap.
		const size = 1024 * 1024 + 4096;
		const got = await members(
			rawTar([{ name: "data/big.bin", content: "x".repeat(size) }]),
		);
		expect(got).toHaveLength(1);
		expect(got[0]!.content.length).toBe(size);
	});

	test("a pax size record that is not a whole non-negative number is an error", async () => {
		// "15 size=banana\n": NaN would disable every later aggregate check.
		await expect(members(paxTar("15 size=banana\n"))).rejects.toThrow(
			"invalid member size",
		);
		// "11 size=-5\n": a negative size would reduce the copy-out total.
		await expect(members(paxTar("11 size=-5\n"))).rejects.toThrow(
			"invalid member size",
		);
	});

	test.skipIf(!linux)(
		"copy-out honors the per-file and total byte budgets",
		async () => {
			const dataRoot = mkdtempSync(join(root, "budget-"));
			const proj = join(dataRoot, "proj");
			mkdirSync(proj);
			const name = (n: string): string => `${proj.slice(1)}/${n}`;
			// Per file: the member above maxFileBytes is refused and writes nothing;
			// the small member behind it still lands.
			const out = await extractCopyOut(
				bodyOf(
					rawTar([
						{ name: name("big.bin"), content: "x".repeat(2048) },
						{ name: name("small.txt"), content: "ok" },
					]),
				),
				proj,
				proj,
				new Set(),
				{ maxFileBytes: 1024, maxTotalBytes: 1024 ** 3 },
			);
			expect(out.refused).toEqual([name("big.bin")]);
			expect(existsSync(join(proj, "big.bin"))).toBe(false);
			expect(readFileSync(join(proj, "small.txt"), "utf8")).toBe("ok");
			// Total: both members fit maxFileBytes but cross maxTotalBytes; the
			// member that would cross the budget throws and never lands.
			await expect(
				extractCopyOut(
					bodyOf(
						rawTar([
							{ name: name("a.txt"), content: "a".repeat(600) },
							{ name: name("b.txt"), content: "b".repeat(600) },
						]),
					),
					proj,
					proj,
					new Set(),
					{ maxFileBytes: 1024, maxTotalBytes: 1024 },
				),
			).rejects.toThrow("total byte budget exceeded");
			expect(existsSync(join(proj, "b.txt"))).toBe(false);
		},
	);
});

describe("sizes and env", () => {
	test("parseSize reads binary units and refuses everything else", () => {
		expect(parseSize("8g")).toBe(8 * 1024 ** 3);
		expect(parseSize("8192m")).toBe(8 * 1024 ** 3);
		expect(parseSize("8G")).toBe(8 * 1024 ** 3);
		expect(parseSize("1")).toBe(1);
		expect(parseSize("1k")).toBe(1024);
		expect(parseSize("20g")).toBe(20 * 1024 ** 3);
		expect(parseSize("0")).toBeNull();
		expect(parseSize("0g")).toBeNull();
		expect(parseSize("")).toBeNull();
		expect(parseSize("8gb")).toBeNull();
		expect(parseSize("1.5g")).toBeNull();
		expect(parseSize("-1g")).toBeNull();
		expect(parseSize("g")).toBeNull();
		expect(parseSize("99999999999t")).toBeNull();
	});

	test("readVmRunnerEnv applies the documented defaults and refuses bad values", () => {
		// The in-code fallbacks and the env defaults must name the same sizes.
		expect(COPY_OUT_MAX_FILE_BYTES).toBe(256 * 1024 ** 2);
		expect(COPY_OUT_MAX_TOTAL_BYTES).toBe(1024 ** 3);
		const cfg = readVmRunnerEnv({});
		expect(cfg).toEqual({
			port: 8787,
			max: 10,
			vcpus: 2,
			memMiB: 8192,
			diskBytes: 20 * 1024 ** 3,
			copyOutMaxFileBytes: 256 * 1024 ** 2,
			copyOutMaxTotalBytes: 1024 ** 3,
			stateDir: "/var/lib/ottr-vm",
			kernel: "/opt/ottr-vm/vmlinux",
			firecracker: "/usr/local/bin/firecracker",
			boardHost: "ottr",
		});
		expect(readVmRunnerEnv({ OTTR_VM_MEM: "128m" }).memMiB).toBe(128);
		expect(() => readVmRunnerEnv({ OTTR_VM_MEM: "127m" })).toThrow(
			"below 128m",
		);
		expect(() => readVmRunnerEnv({ OTTR_VM_MAX: "0" })).toThrow("OTTR_VM_MAX");
		expect(() => readVmRunnerEnv({ OTTR_VM_DISK: "lots" })).toThrow(
			"OTTR_VM_DISK",
		);
		expect(() =>
			readVmRunnerEnv({ OTTR_VM_COPY_OUT_MAX_TOTAL: "big" }),
		).toThrow("OTTR_VM_COPY_OUT_MAX_TOTAL");
	});
});

describe("vmNet", () => {
	test("startup drops VM traffic to every private range and between taps, and masquerades only off-tap", () => {
		const cmds = startupCommands().map((a) => a.join(" "));
		for (const range of [
			"10.0.0.0/8",
			"172.16.0.0/12",
			"192.168.0.0/16",
			"169.254.0.0/16",
			"100.64.0.0/10",
			"0.0.0.0/8",
			"192.0.0.0/24",
			"198.18.0.0/15",
		])
			expect(cmds).toContain(
				`iptables -w -A OTTR-VM -i ovm+ -d ${range} -j DROP`,
			);
		expect(cmds).toContain("iptables -w -A OTTR-VM -i ovm+ -o ovm+ -j DROP");
		expect(cmds).toContain("iptables -w -A OTTR-VM-IN -i ovm+ -j DROP");
		expect(cmds).toContain(
			"iptables -w -t nat -A OTTR-VM-NAT -s 10.231.0.0/16 ! -o ovm+ -j MASQUERADE",
		);
		// The conntrack accept comes before every drop: replies to allowed flows pass.
		const accept = cmds.findIndex((c) => c.includes("ESTABLISHED,RELATED"));
		const firstDrop = cmds.findIndex((c) => c.endsWith("-j DROP"));
		expect(accept).toBeGreaterThan(-1);
		expect(accept).toBeLessThan(firstDrop);
	});

	test("a slot's board allow rule sits right after the conntrack accept and its delete matches it", () => {
		const slot = slotFor(3);
		const up = slotUpCommands(slot, { ip: "172.18.0.5", port: 8080 }).map((a) =>
			a.join(" "),
		);
		const allow =
			"-i ovm3 -s 10.231.0.14 -d 172.18.0.5/32 -p tcp --dport 8080 -j ACCEPT";
		expect(up).toContain(`iptables -w -I OTTR-VM 2 ${allow}`);
		expect(up).toContain("ip addr add 10.231.0.13/30 dev ovm3");
		const down = slotDownCommands(slot, { ip: "172.18.0.5", port: 8080 }).map(
			(a) => a.join(" "),
		);
		expect(down).toContain(`iptables -w -D OTTR-VM ${allow}`);
		expect(down).toContain("ip link del ovm3");
	});

	test("slots are /30 blocks of 10.231.0.0/16 and stop at the last one", () => {
		expect(slotFor(0)).toMatchObject({
			tap: "ovm0",
			hostIp: "10.231.0.1",
			guestIp: "10.231.0.2",
		});
		expect(slotFor(64)).toMatchObject({
			hostIp: "10.231.1.1",
			guestIp: "10.231.1.2",
			mac: "06:00:0a:e7:01:02",
		});
		expect(slotFor(16383)).toMatchObject({
			hostIp: "10.231.255.253",
			guestIp: "10.231.255.254",
		});
		expect(() => slotFor(16384)).toThrow();
		expect(() => slotFor(-1)).toThrow();
	});

	test("startup removes leftover taps and accepts an ip_forward compose already set", async () => {
		const ran: string[] = [];
		const exec: Exec = async (argv) => {
			ran.push(argv.join(" "));
			if (argv[0] === "ip" && argv[1] === "-o")
				return {
					code: 0,
					stdout:
						"1: lo: <LOOPBACK,UP> mtu 65536\n7: ovm3: <BROADCAST> mtu 1500\n9: eth0@if10: <UP> mtu 1500\n",
					stderr: "",
				};
			if (argv[0] === "sysctl")
				return { code: 255, stdout: "", stderr: "read-only file system" };
			return { code: 0, stdout: "", stderr: "" };
		};
		expect(await netStartup({ exec, readIpForward: () => "1\n" })).toBeNull();
		expect(ran).toContain("ip link del ovm3");
		expect(ran).not.toContain("ip link del eth0");
		expect(await netStartup({ exec, readIpForward: () => "0\n" })).toContain(
			"net.ipv4.ip_forward",
		);
		expect(parseTaps("12: ovm10@NONE: <UP>\n13: tap0: <UP>")).toEqual([
			"ovm10",
		]);
	});
});

describe("vmRootfs", () => {
	test("the layer key is a function of the base and the five list texts", () => {
		const k1 = layerKey("base", { apt: "jq\n" });
		expect(layerKey("base", { apt: "jq\n" })).toBe(k1);
		// The base is an input.
		expect(layerKey("base2", { apt: "jq\n" })).not.toBe(k1);
		// A change in any one field moves the key.
		const changed: ProvisionLists[] = [
			{ apt: "jq\nripgrep\n" },
			{ apt: "jq\n", tools: "[]" },
			{ apt: "jq\n", toolsAll: "[]" },
			{ apt: "jq\n", requirements: "r==1 --hash=sha256:" + "a".repeat(64) },
			{ apt: "jq\n", requirementsAll: "q==2 --hash=sha256:" + "b".repeat(64) },
		];
		for (const lists of changed) expect(layerKey("base", lists)).not.toBe(k1);
		// A field gained or lost moves the key: absent is not "".
		expect(layerKey("base", { apt: "jq\n", tools: "" })).not.toBe(k1);
		expect(layerKey("base", {})).not.toBe(k1);
		// The key order the caller uses is fixed, so the object's own order is not one.
		expect(layerKey("base", { tools: "[]", apt: "jq\n" })).toBe(
			layerKey("base", { apt: "jq\n", tools: "[]" }),
		);
	});

	test("listFiles emits one entry per present field, at the guest paths the wrappers read", () => {
		expect(listFiles("proj", {})).toEqual([]);
		expect(
			listFiles("proj", {
				apt: "jq\n",
				tools: "t",
				toolsAll: "ta",
				requirements: "r\n",
				requirementsAll: "ra\n",
			}),
		).toEqual([
			{ path: "/root/.ottr/workers/proj/apt.txt", text: "jq\n" },
			{ path: "/root/.ottr/workers/proj/tools.json", text: "t" },
			{ path: "/root/.ottr/workers/_all/tools.json", text: "ta" },
			{ path: "/root/.ottr/workers/proj/requirements.txt", text: "r\n" },
			{ path: "/root/.ottr/workers/_all/requirements.txt", text: "ra\n" },
		]);
		// A partial lists omits exactly its absent fields.
		expect(listFiles("proj", { toolsAll: "ta" })).toEqual([
			{ path: "/root/.ottr/workers/_all/tools.json", text: "ta" },
		]);
	});

	/** A tiny stand-in for the vm-runner image root: the guest trees the base key hashes. */
	function srcRoot(): string {
		const dir = mkdtempSync(join(root, "rsrc-"));
		for (const d of [
			"app",
			"etc",
			"usr/local/bin",
			"usr/local/bun/bin",
			"opt/ottr-vm",
			"var/lib/dpkg",
		])
			mkdirSync(join(dir, d), { recursive: true });
		writeFileSync(join(dir, "app/package.json"), "{}");
		writeFileSync(join(dir, "usr/local/bin/ottr-vm-init"), "#!/bin/sh\n");
		writeFileSync(join(dir, "opt/ottr-vm/vmlinux"), "kernel\n");
		writeFileSync(join(dir, "usr/local/bun/bin/bun"), "bun\n");
		writeFileSync(join(dir, "var/lib/dpkg/status"), "Package: git\n");
		// Written by the image build, owned by no package; the base copies it.
		writeFileSync(join(dir, "etc/gitconfig"), "[credential]\n");
		// The container runtime rewrites these on every start.
		writeFileSync(join(dir, "etc/hosts"), "127.0.0.1 localhost\n");
		// A root-level script the image build copies.
		writeFileSync(join(dir, "no-proxy.sh"), "# no proxy\n");
		// The state dir the tar excludes, nested like the compose volume pins it.
		mkdirSync(join(dir, "var/lib/ottr-vm/base"), { recursive: true });
		writeFileSync(join(dir, "var/lib/ottr-vm/base/first.ext4"), "x");
		// Debian's merged /usr: symlinks at the root.
		symlinkSync("usr/bin", join(dir, "bin"));
		return dir;
	}

	function rootfs(
		home: string,
		e2fsckCode: number | null = 0,
	): {
		fs: VmRootfs;
		stateDir: string;
		srcRoot: string;
		/** Every exec's argv, in order: the tests filter it for mkfs.ext4. */
		argvs: string[][];
		e2fsckArgv: string[][];
		/** One more VmRootfs over the same stateDir: a fresh base key computation. */
		make: () => VmRootfs;
	} {
		const stateDir = mkdtempSync(join(root, "rfs-"));
		const src = srcRoot();
		const argvs: string[][] = [];
		const e2fsckArgv: string[][] = [];
		const exec: Exec = async (argv) => {
			argvs.push(argv);
			if (argv[0] === "omp")
				return { code: 0, stdout: "omp 1.0\n", stderr: "" };
			if (argv[0] === "du")
				return { code: 0, stdout: "1000\t/x\n", stderr: "" };
			if (argv[0] === "e2fsck") {
				e2fsckArgv.push(argv);
				return {
					code: e2fsckCode,
					stdout: e2fsckCode === 0 ? "" : "unrepairable\n",
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const make = (): VmRootfs =>
			new VmRootfs({
				stateDir,
				homeRoot: home,
				exec,
				ottrVersion: "1.2.3",
				sourceRoot: src,
				layerBytes: 1024 * 1024,
			});
		return { stateDir, srcRoot: src, argvs, e2fsckArgv, fs: make(), make };
	}

	test("a changed guest file gets a new base key and rebuilds instead of reusing the ext4", async () => {
		const home = mkdtempSync(join(root, "rb-"));
		const { stateDir, srcRoot, argvs, make } = rootfs(home);
		const first = await make().base();
		const baseDir = join(stateDir, "base");
		expect(readdirSync(baseDir)).toEqual([`${first.key}.ext4`]);
		// Same omp version and the same /app tree; only the guest init's content changed.
		writeFileSync(
			join(srcRoot, "usr/local/bin/ottr-vm-init"),
			"#!/bin/sh\necho second\n",
		);
		const second = await make().base();
		expect(second.key).not.toBe(first.key);
		expect(second.path).not.toBe(first.path);
		// The second build ran mkfs again: the first ext4 was not reused.
		expect(argvs.filter((a) => a[0] === "mkfs.ext4")).toHaveLength(2);
		// keepOnly removed the old base.
		expect(readdirSync(baseDir)).toEqual([`${second.key}.ext4`]);
		expect(existsSync(first.path)).toBe(false);
	});

	test("files the image writes outside packages also key the base, but per-container /etc files do not", async () => {
		const home = mkdtempSync(join(root, "rb2-"));
		const { srcRoot, make } = rootfs(home);
		const first = await make().base();
		// /etc/gitconfig comes from the image build's `git config --system`; no package owns it.
		writeFileSync(join(srcRoot, "etc/gitconfig"), "# changed\n");
		const second = await make().base();
		expect(second.key).not.toBe(first.key);
		// The root-level scripts are copied into the base too.
		writeFileSync(join(srcRoot, "no-proxy.sh"), "# changed\n");
		const third = await make().base();
		expect(third.key).not.toBe(second.key);
		// A restart rewrites /etc/hosts; that must never churn the key or rebuild the base.
		writeFileSync(join(srcRoot, "etc/hosts"), "10.0.0.1 ottr\n");
		const fourth = await make().base();
		expect(fourth.key).toBe(third.key);
		expect(fourth.path).toBe(third.path);
		// The state dir the tar excludes must not key the base either: a new base or
		// layer lands there, and that must not force the next rebuild.
		writeFileSync(join(srcRoot, "var/lib/ottr-vm/base/second.ext4"), "y");
		const fifth = await make().base();
		expect(fifth.key).toBe(fourth.key);
		// A symlink hashes by its target, and a retarget moves the key.
		expect(readlinkSync(join(srcRoot, "bin"))).toBe("usr/bin");
		rmSync(join(srcRoot, "bin"));
		symlinkSync("usr/local", join(srcRoot, "bin"));
		const sixth = await make().base();
		expect(sixth.key).not.toBe(fifth.key);
	});

	test("a state dir outside the excluded roots is skipped like the tar skips it", async () => {
		const src = srcRoot();
		// An operator's OTTR_VM_STATE_DIR inside the copied root, like /srv/ottr-vm.
		const stateDir = join(src, "srv/ottr-vm");
		mkdirSync(join(stateDir, "base"), { recursive: true });
		const home = mkdtempSync(join(root, "rb3-"));
		const argvs: string[][] = [];
		const exec: Exec = async (argv) => {
			argvs.push(argv);
			if (argv[0] === "omp")
				return { code: 0, stdout: "omp 1.0\n", stderr: "" };
			if (argv[0] === "du")
				return { code: 0, stdout: "1000\t/x\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		};
		const make = (): VmRootfs =>
			new VmRootfs({
				stateDir,
				homeRoot: home,
				exec,
				ottrVersion: "1.2.3",
				sourceRoot: src,
				layerBytes: 1024 * 1024,
			});
		const first = await make().base();
		// The base build lands a new ext4 in the state dir; the key must not move,
		// or every start would rebuild the base and every layer forever.
		writeFileSync(join(stateDir, "base", "first.ext4"), "x");
		const second = await make().base();
		expect(second.key).toBe(first.key);
		expect(second.path).toBe(first.path);
		expect(argvs.filter((a) => a[0] === "mkfs.ext4")).toHaveLength(1);
	});

	test("two turns of one project bake once; a changed list re-bakes and drops the old layer", async () => {
		const home = mkdtempSync(join(root, "rh-"));
		const { fs, stateDir } = rootfs(home);
		let bakes = 0;
		const bake = async (): Promise<BakeResult> => {
			bakes++;
			return { exitCode: 0, stderrTail: "" };
		};
		const [a, b] = await Promise.all([
			fs.layer("proj", { apt: "jq\n" }, bake),
			fs.layer("proj", { apt: "jq\n" }, bake),
		]);
		expect(bakes).toBe(1);
		expect(a).toEqual(b);
		expect(a.ok && existsSync(a.path)).toBe(true);
		const c = await fs.layer("proj", { apt: "jq\nripgrep\n" }, bake);
		expect(bakes).toBe(2);
		expect(c.ok && c.path !== (a.ok ? a.path : "")).toBe(true);
		expect(readdirSync(join(stateDir, "layers", "proj"))).toHaveLength(1);
	});

	test("a failed bake keeps no layer and reports the bake's tail", async () => {
		const home = mkdtempSync(join(root, "rf-"));
		const { fs, stateDir } = rootfs(home);
		const r = await fs.layer("proj", {}, async () => ({
			exitCode: 100,
			stderrTail: "E: Unable to locate package nope\n",
		}));
		expect(r).toEqual({
			ok: false,
			stderrTail: "E: Unable to locate package nope\n",
		});
		expect(readdirSync(join(stateDir, "layers", "proj"))).toEqual([]);
	});

	test("an e2fsck exit of 1 still publishes the layer", async () => {
		const home = mkdtempSync(join(root, "rh1-"));
		const { fs, stateDir } = rootfs(home, 1);
		const r = await fs.layer("proj", {}, async () => ({
			exitCode: 0,
			stderrTail: "",
		}));
		expect(r.ok).toBe(true);
		expect(r.ok && existsSync(r.path)).toBe(true);
		expect(readdirSync(join(stateDir, "layers", "proj"))).toHaveLength(1);
	});

	test("a layer image that fails its post-bake check is not published", async () => {
		const home = mkdtempSync(join(root, "rh4-"));
		const { fs, stateDir, e2fsckArgv } = rootfs(home, 4);
		const r = await fs.layer("proj", {}, async () => ({
			exitCode: 0,
			stderrTail: "",
		}));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.stderrTail).toContain("e2fsck");
			expect(r.stderrTail).toContain("unrepairable");
		}
		expect(readdirSync(join(stateDir, "layers", "proj"))).toEqual([]);
		expect(e2fsckArgv).toHaveLength(1);
		expect(e2fsckArgv[0]!.slice(0, 2)).toEqual(["e2fsck", "-fy"]);
		// The nonce suffix is random, so only the shape of the path is knowable.
		expect(e2fsckArgv[0]![2]).toMatch(/\.ext4\.tmp-/);
	});
});

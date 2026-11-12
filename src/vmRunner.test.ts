import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
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
import {
	type Exec,
	netStartup,
	parseTaps,
	slotDownCommands,
	slotFor,
	slotUpCommands,
	startupCommands,
} from "./vmNet.ts";
import { type BakeResult, layerKey, VmRootfs } from "./vmRootfs.ts";
import {
	extractCopyOut,
	firecrackerConfig,
	readTar,
	serveVmRunner,
	type TarMember,
	tarStream,
	type VmLauncher,
	type VmLaunchSpec,
	type VmRunnerOptions,
} from "./vmRunner.ts";
import { parseSize, readVmRunnerEnv } from "./vmRunnerMain.ts";
import { type VmSpec, WORKER_DONE, type WorkerRequest } from "./workers.ts";

// Nothing here needs KVM: the launcher is a fake that starts a fake guest agent (Bun.serve on
// port 0) per "VM", and ip/iptables/mkfs go through a recording exec.

const root = mkdtempSync(join(tmpdir(), "ottr-vmrunner-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
	members: { name: string; content?: string; type?: string; mtime?: number }[],
): Uint8Array {
	const blocks: Uint8Array[] = [];
	const header = (
		name: string,
		type: string,
		size: number,
		mtime: number,
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
		blocks.push(header(m.name, m.type ?? "0", data.length, mtime), data);
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

interface GuestRec {
	spec: VmLaunchSpec;
	token: string;
	killed: boolean;
	puts: Uint8Array[];
	runBody: Record<string, unknown> | null;
	fileQueries: URLSearchParams[];
	/** The VM process dies on its own: the guest vanishes, no sentinel. */
	crash: () => void;
}

interface GuestScript {
	run?: (rec: GuestRec) => Response;
	bake?: (rec: GuestRec) => Response;
	files?: (q: URLSearchParams) => Uint8Array;
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
	if (u.pathname === "/healthz") return new Response("ok");
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
	if (req.method === "POST" && u.pathname === "/bake")
		return (
			script.bake?.(rec) ??
			ndjson(JSON.stringify({ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } }))
		);
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
			fileQueries: [],
			crash: () => {},
		};
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

function startRunner(
	o: {
		script?: GuestScript;
		max?: number;
		exists?: (p: string) => boolean;
		netError?: string | null;
		rootfs?: VmRunnerOptions["rootfs"];
	} = {},
) {
	const stateDir = mkdtempSync(join(root, "state-"));
	const dataRoot = mkdtempSync(join(root, "data-"));
	const homeRoot = mkdtempSync(join(root, "home-"));
	mkdirSync(join(dataRoot, "proj"));
	const execs: string[][] = [];
	const exec: Exec = async (argv) => {
		execs.push(argv);
		return { code: 0, stdout: "", stderr: "" };
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

	test("answers 400 without a vm spec", async () => {
		const r = startRunner();
		const { vm: _vm, ...classic } = request();
		const res = await post(r.url, "/run", classic);
		expect(res.status).toBe(400);
		expect(r.recs).toHaveLength(0);
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
		const lists = join(r.homeRoot, ".ottr", "workers", "proj");
		mkdirSync(lists, { recursive: true });
		writeFileSync(join(lists, "apt.txt"), "nope\n");
		const text = await (await post(r.url, "/run", request())).text();
		expect(text).toContain("apt: installing nope\n");
		const done = sentinelOf(text);
		expect(done?.exitCode).toBe(1);
		expect(done?.stderrTail).toContain("Unable to locate package nope");
		// Only the bake VM booted, with the layer writable, and it got the package list.
		expect(r.recs).toHaveLength(1);
		const bakeVm = r.recs[0]!;
		expect(bakeVm.spec.mode).toBe("bake");
		expect(bakeVm.spec.drives.find((d) => d.id === "vdb")?.readOnly).toBe(
			false,
		);
		const sent = await members(bakeVm.puts[0]!);
		expect(
			sent.find((s) => s.m.name === join(lists, "apt.txt").slice(1))?.content,
		).toBe("nope\n");
		expect(bakeVm.killed).toBe(true);
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

	test("copy-out never writes through a symlinked dir under the project root", async () => {
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
	});

	test("a corrupt header is an error, not a silent partial extract", async () => {
		const bytes = rawTar([{ name: "data/p/a.txt", content: "a" }]);
		bytes[0] = bytes[0]! ^ 0xff;
		await expect(members(bytes)).rejects.toThrow("checksum");
	});
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
		const cfg = readVmRunnerEnv({});
		expect(cfg).toEqual({
			port: 8787,
			max: 10,
			vcpus: 2,
			memMiB: 8192,
			diskBytes: 20 * 1024 ** 3,
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
	test("the layer key changes when a package list changes, and not otherwise", () => {
		const home = mkdtempSync(join(root, "lk-"));
		const dir = join(home, ".ottr", "workers", "proj");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "apt.txt"), "jq\n");
		const k1 = layerKey("base", home, "proj");
		expect(layerKey("base", home, "proj")).toBe(k1);
		// Files a bake does not install from leave the key alone.
		writeFileSync(join(dir, "notes.md"), "whatever");
		expect(layerKey("base", home, "proj")).toBe(k1);
		writeFileSync(join(dir, "apt.txt"), "jq\nripgrep\n");
		const k2 = layerKey("base", home, "proj");
		expect(k2).not.toBe(k1);
		const all = join(home, ".ottr", "workers", "_all");
		mkdirSync(all, { recursive: true });
		writeFileSync(join(all, "requirements.txt"), "requests\n");
		expect(layerKey("base", home, "proj")).not.toBe(k2);
		expect(layerKey("base2", home, "proj")).not.toBe(
			layerKey("base", home, "proj"),
		);
	});

	function rootfs(home: string): {
		fs: VmRootfs;
		stateDir: string;
	} {
		const stateDir = mkdtempSync(join(root, "rfs-"));
		const pkg = join(stateDir, "package.json");
		writeFileSync(pkg, "{}");
		const exec: Exec = async (argv) => {
			if (argv[0] === "omp")
				return { code: 0, stdout: "omp 1.0\n", stderr: "" };
			if (argv[0] === "du")
				return { code: 0, stdout: "1000\t/x\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		};
		return {
			stateDir,
			fs: new VmRootfs({
				stateDir,
				homeRoot: home,
				exec,
				ottrVersion: "1.2.3",
				packageJsonPath: pkg,
				layerBytes: 1024 * 1024,
			}),
		};
	}

	test("two turns of one project bake once; a changed list re-bakes and drops the old layer", async () => {
		const home = mkdtempSync(join(root, "rh-"));
		const lists = join(home, ".ottr", "workers", "proj");
		mkdirSync(lists, { recursive: true });
		writeFileSync(join(lists, "apt.txt"), "jq\n");
		const { fs, stateDir } = rootfs(home);
		let bakes = 0;
		const bake = async (): Promise<BakeResult> => {
			bakes++;
			return { exitCode: 0, stderrTail: "" };
		};
		const [a, b] = await Promise.all([
			fs.layer("proj", bake),
			fs.layer("proj", bake),
		]);
		expect(bakes).toBe(1);
		expect(a).toEqual(b);
		expect(a.ok && existsSync(a.path)).toBe(true);
		writeFileSync(join(lists, "apt.txt"), "jq\nripgrep\n");
		const c = await fs.layer("proj", bake);
		expect(bakes).toBe(2);
		expect(c.ok && c.path !== (a.ok ? a.path : "")).toBe(true);
		expect(readdirSync(join(stateDir, "layers", "proj"))).toHaveLength(1);
	});

	test("a failed bake keeps no layer and reports the bake's tail", async () => {
		const home = mkdtempSync(join(root, "rf-"));
		const { fs, stateDir } = rootfs(home);
		const r = await fs.layer("proj", async () => ({
			exitCode: 100,
			stderrTail: "E: Unable to locate package nope\n",
		}));
		expect(r).toEqual({
			ok: false,
			stderrTail: "E: Unable to locate package nope\n",
		});
		expect(readdirSync(join(stateDir, "layers", "proj"))).toEqual([]);
	});
});

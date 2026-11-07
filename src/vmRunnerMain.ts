import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultExec, netStartup } from "./vmNet.ts";
import { VmRootfs } from "./vmRootfs.ts";
import { firecrackerLauncher, serveVmRunner } from "./vmRunner.ts";

const UNITS: Record<string, number> = {
	"": 1,
	k: 1024,
	m: 1024 ** 2,
	g: 1024 ** 3,
	t: 1024 ** 4,
};

/** "8g", "8192m", "512k" or plain bytes (binary units) to bytes; null when unreadable or 0. */
export function parseSize(text: string): number | null {
	const m = /^\s*(\d+)\s*([kmgt]?)\s*$/i.exec(text);
	if (!m) return null;
	const n = Number(m[1]) * UNITS[m[2]!.toLowerCase()]!;
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface VmRunnerEnv {
	port: number;
	max: number;
	vcpus: number;
	memMiB: number;
	diskBytes: number;
	stateDir: string;
	kernel: string;
	firecracker: string;
	boardHost: string;
}

/** The vm-runner settings from its env; throws naming the first bad variable. */
export function readVmRunnerEnv(
	env: Record<string, string | undefined>,
): VmRunnerEnv {
	const count = (name: string, fallback: number): number => {
		const raw = env[name];
		if (raw === undefined || raw === "") return fallback;
		const n = Number(raw);
		if (!Number.isInteger(n) || n < 1)
			throw new Error(`${name}=${raw} is not a positive whole number`);
		return n;
	};
	const size = (name: string, fallback: string): number => {
		const raw = env[name] || fallback;
		const n = parseSize(raw);
		if (n === null)
			throw new Error(`${name}=${raw} is not a size (e.g. 8g, 8192m, bytes)`);
		return n;
	};
	const memBytes = size("OTTR_VM_MEM", "8g");
	// Firecracker takes whole MiB; below 128 MiB nothing that runs omp boots.
	if (memBytes < 128 * 1024 ** 2)
		throw new Error(`OTTR_VM_MEM=${env.OTTR_VM_MEM} is below 128m`);
	return {
		port: count("WORKER_PORT", 8787),
		max: count("OTTR_VM_MAX", 2),
		vcpus: count("OTTR_VM_VCPUS", 2),
		memMiB: Math.floor(memBytes / 1024 ** 2),
		diskBytes: size("OTTR_VM_DISK", "20g"),
		stateDir: env.OTTR_VM_STATE_DIR || "/var/lib/ottr-vm",
		kernel: env.OTTR_VM_KERNEL || "/opt/ottr-vm/vmlinux",
		firecracker: env.OTTR_VM_FIRECRACKER || "/usr/local/bin/firecracker",
		boardHost: env.OTTR_VM_BOARD_HOST || "ottr",
	};
}

// Import-safe like src/worker.ts: the tests import parseSize and readVmRunnerEnv.
if (import.meta.main) {
	// Fail closed: without the token the 0.0.0.0 /run endpoint lets any client boot VMs.
	const token = process.env.OTTR_WORKER_TOKEN;
	if (!token) {
		console.error("OTTR_WORKER_TOKEN is required");
		process.exit(1);
	}
	let cfg: VmRunnerEnv;
	try {
		cfg = readVmRunnerEnv(process.env);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	// vm-runner only talks to its guests (10.231.x.y) and local tools; a proxy the container
	// runtime injects would swallow the guest calls, whose addresses NO_PROXY cannot list.
	for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
		delete process.env[k];

	const netError = await netStartup({
		exec: defaultExec,
		readIpForward: () => {
			try {
				return readFileSync("/proc/sys/net/ipv4/ip_forward", "utf8");
			} catch {
				return null;
			}
		},
	});
	if (netError) console.error(`network setup failed: ${netError}`);
	// A restart killed every VM of the previous process (by design): its scratch disks,
	// configs and logs are garbage now.
	rmSync(join(cfg.stateDir, "runs"), { recursive: true, force: true });
	const rootfs = new VmRootfs({
		stateDir: cfg.stateDir,
		homeRoot: "/root",
		exec: defaultExec,
		ottrVersion: process.env.OTTR_VERSION ?? "",
		packageJsonPath: "/app/package.json",
		layerBytes: cfg.diskBytes,
	});
	const server = serveVmRunner({
		...cfg,
		token,
		netError,
		launcher: firecrackerLauncher(cfg.firecracker),
		rootfs,
	});
	console.log(`vm-runner listening on ${cfg.port}`);
	// Serving starts at once; the first /run awaits the same base build.
	rootfs.base().then(
		(b) => console.log(`base rootfs ${b.path}`),
		(err) =>
			console.error(
				`base rootfs: ${err instanceof Error ? err.message : String(err)}`,
			),
	);

	const stop = (): void => {
		server.stop(true);
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

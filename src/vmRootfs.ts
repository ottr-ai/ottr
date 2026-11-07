/**
 * vm-runner disk images (docs/adr/0009-microvm-workers.md):
 * - base rootfs: an ext4 copy of this container's own root (the vm-runner image ships the
 *   same bun, omp and /app as a worker), read-only vda of every VM. Keyed by OTTR_VERSION,
 *   `omp --version` and /app/package.json, so an image update rebuilds it once.
 * - project layer: an ext4 holding the overlay `upper/` and `work/` dirs a bake VM fills with
 *   the project's apt/tools/pip installs (the worker's per-turn installs, done once). Keyed
 *   by the base key plus the project's and `_all`'s package lists, so a changed apt.txt
 *   re-bakes and nothing else does.
 * Only the current base and the current layer per project stay on disk; a VM still running
 * on an older image keeps its open inode.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import type { Exec } from "./vmNet.ts";

/** The per-project package lists a bake installs (src/apt.ts, src/tools.ts, src/python.ts). */
const LAYER_INPUTS = ["apt.txt", "tools.json", "requirements.txt"] as const;

/** Paths the base rootfs never copies: kernel filesystems, mounts, per-host state. */
const BASE_EXCLUDES = [
	"/proc",
	"/sys",
	"/dev",
	"/run",
	"/tmp",
	"/data",
	"/root",
	"/var/lib/ottr-vm",
] as const;

/** Mount points the guest init needs in the copy, which the excludes dropped. */
const MOUNT_POINTS = ["proc", "sys", "dev", "run", "tmp", "data", "root"];

export interface BakeResult {
	exitCode: number | null;
	stderrTail: string;
}

export type LayerResult =
	| { ok: true; path: string }
	| { ok: false; stderrTail: string };

function baseKey(i: {
	ottrVersion: string;
	ompVersion: string;
	packageJson: string;
}): string {
	// JSON keeps the parts unambiguous: "a"+"bc" and "ab"+"c" must not collide.
	return createHash("sha256")
		.update(JSON.stringify([i.ottrVersion, i.ompVersion, i.packageJson]))
		.digest("hex");
}

/** The list files a bake of `project` installs, project first, then `_all`. */
export function workerListPaths(homeRoot: string, project: string): string[] {
	return [project, "_all"].flatMap((dir) =>
		LAYER_INPUTS.map((f) => join(homeRoot, ".ottr", "workers", dir, f)),
	);
}

const readOrNull = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

export function layerKey(
	base: string,
	homeRoot: string,
	project: string,
	read: (path: string) => string | null = readOrNull,
): string {
	// A missing list (null) and an empty one ("") install the same, but keeping them apart
	// costs one extra bake at most and never reuses a wrong layer.
	const lists = workerListPaths(homeRoot, project).map((p) => [p, read(p)]);
	return createHash("sha256")
		.update(JSON.stringify([base, lists]))
		.digest("hex");
}

/** A sparse file of `bytes`: mkfs.ext4 then only writes its metadata. */
export function sparseFile(path: string, bytes: number): void {
	const fd = openSync(path, "w");
	try {
		ftruncateSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}

async function run(exec: Exec, argv: string[], okCodes = [0]): Promise<string> {
	const r = await exec(argv);
	if (r.code === null || !okCodes.includes(r.code))
		throw new Error(
			`${argv[0]} failed: ${(r.stderr || r.stdout).trim().slice(-2000) || `exit ${r.code}`}`,
		);
	return r.stdout;
}

/** Removes every entry of `dir` but `keep` (best effort). */
function keepOnly(dir: string, keep: string): void {
	for (const name of readdirSync(dir))
		if (name !== keep)
			rmSync(join(dir, name), { recursive: true, force: true });
}

const MIB = 1024 * 1024;

export class VmRootfs {
	private basePromise: Promise<{ key: string; path: string }> | null = null;
	/** Per project: the tail of its bake chain, so two turns never bake one layer twice. */
	private readonly chains = new Map<string, Promise<unknown>>();

	constructor(
		private readonly o: {
			stateDir: string;
			homeRoot: string;
			exec: Exec;
			ottrVersion: string;
			packageJsonPath: string;
			/** Apparent size of a fresh layer image (sparse). */
			layerBytes: number;
			/** The root the base copies; "/" outside tests. */
			sourceRoot?: string;
		},
	) {}

	/** The current base rootfs; built on first use. A failed build retries on the next call. */
	base(): Promise<{ key: string; path: string }> {
		if (!this.basePromise) {
			this.basePromise = this.buildBase();
			this.basePromise.catch(() => {
				this.basePromise = null;
			});
		}
		return this.basePromise;
	}

	private async buildBase(): Promise<{ key: string; path: string }> {
		const { exec, stateDir } = this.o;
		const key = baseKey({
			ottrVersion: this.o.ottrVersion,
			ompVersion: (await run(exec, ["omp", "--version"])).trim(),
			packageJson: readOrNull(this.o.packageJsonPath) ?? "",
		});
		const dir = join(stateDir, "base");
		const path = join(dir, `${key}.ext4`);
		mkdirSync(dir, { recursive: true });
		if (existsSync(path)) {
			keepOnly(dir, `${key}.ext4`);
			return { key, path };
		}
		const staging = join(stateDir, "base-staging");
		const tarFile = join(stateDir, "base-staging.tar");
		rmSync(staging, { recursive: true, force: true });
		rmSync(tarFile, { force: true });
		try {
			const excludes = [...BASE_EXCLUDES, stateDir].map(
				(p) => `--exclude=.${p}`,
			);
			// --one-file-system also skips the bind-mounted /etc/hosts and resolv.conf; the
			// guest init writes its own. Exit 1 is "a file changed while read", harmless here.
			await run(
				exec,
				[
					"tar",
					"--one-file-system",
					"-C",
					this.o.sourceRoot ?? "/",
					"-cpf",
					tarFile,
					"--anchored",
					...excludes,
					".",
				],
				[0, 1],
			);
			mkdirSync(staging, { recursive: true });
			await run(exec, ["tar", "-C", staging, "-xpf", tarFile]);
			rmSync(tarFile, { force: true });
			for (const m of MOUNT_POINTS)
				mkdirSync(join(staging, m), { recursive: true });
			chmodSync(join(staging, "tmp"), 0o1777);
			const bytes = Number(
				(await run(exec, ["du", "-sb", staging])).split(/\s/)[0],
			);
			const inodes = Number(
				(await run(exec, ["du", "-s", "--inodes", staging])).split(/\s/)[0],
			);
			if (!Number.isFinite(bytes) || !Number.isFinite(inodes))
				throw new Error(`du could not size ${staging}`);
			// ext4 metadata and the journal need headroom; 4 MiB alignment keeps mkfs happy.
			const size =
				Math.ceil((bytes + Math.max(bytes / 4, 512 * MIB)) / (4 * MIB)) *
				4 *
				MIB;
			const tmp = `${path}.tmp`;
			sparseFile(tmp, size);
			await run(exec, [
				"mkfs.ext4",
				"-F",
				"-q",
				"-L",
				"ottr-base",
				"-N",
				String(Math.ceil(inodes * 1.25) + 16384),
				"-d",
				staging,
				tmp,
			]);
			renameSync(tmp, path);
			keepOnly(dir, `${key}.ext4`);
			return { key, path };
		} finally {
			rmSync(staging, { recursive: true, force: true });
			rmSync(tarFile, { force: true });
		}
	}

	/**
	 * The project's current layer image, baked through `bake` (a bake-mode VM with the image
	 * as rw vdb) when its key changed. Bakes of one project run one at a time: the second
	 * turn waits and then finds the first one's layer.
	 */
	layer(
		project: string,
		bake: (image: string) => Promise<BakeResult>,
	): Promise<LayerResult> {
		const prev = this.chains.get(project) ?? Promise.resolve();
		const next = prev.then(() => this.layerNow(project, bake));
		const tail = next.catch(() => {});
		this.chains.set(project, tail);
		tail.then(() => {
			if (this.chains.get(project) === tail) this.chains.delete(project);
		});
		return next;
	}

	private async layerNow(
		project: string,
		bake: (image: string) => Promise<BakeResult>,
	): Promise<LayerResult> {
		const base = await this.base();
		const key = layerKey(base.key, this.o.homeRoot, project);
		const dir = join(this.o.stateDir, "layers", project);
		const path = join(dir, `${key}.ext4`);
		if (existsSync(path)) return { ok: true, path };
		mkdirSync(dir, { recursive: true });
		const nonce = randomBytes(4).toString("hex");
		const tmp = join(dir, `${key}.ext4.tmp-${nonce}`);
		const staging = join(dir, `staging-${nonce}`);
		try {
			mkdirSync(join(staging, "upper"), { recursive: true });
			mkdirSync(join(staging, "work"), { recursive: true });
			sparseFile(tmp, this.o.layerBytes);
			await run(this.o.exec, [
				"mkfs.ext4",
				"-F",
				"-q",
				"-L",
				"ottr-layer",
				"-d",
				staging,
				tmp,
			]);
			rmSync(staging, { recursive: true, force: true });
			const r = await bake(tmp);
			if (r.exitCode !== 0)
				return {
					ok: false,
					stderrTail:
						r.stderrTail || `the package bake exited ${r.exitCode ?? "killed"}`,
				};
			renameSync(tmp, path);
			keepOnly(dir, `${key}.ext4`);
			return { ok: true, path };
		} finally {
			rmSync(staging, { recursive: true, force: true });
			rmSync(tmp, { force: true });
		}
	}
}

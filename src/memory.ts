import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirBelow, readBelow, unlinkBelow, writeBelow } from "./confine.ts";

export type MemoryBackendName = "hindsight" | "mnemopi";

export type MemoryChoice =
	| { backend: "hindsight"; url: string; token: string }
	| { backend: "mnemopi" };

/** The deployment picks the backend; omp gets it as a `--config` overlay, so config.yml stops being the switch. */
export function memoryBackendFromEnv(
	env: Record<string, string | undefined>,
): MemoryChoice {
	const url = env.HINDSIGHT_API_URL?.trim();
	if (url)
		return {
			backend: "hindsight",
			url: url.replace(/\/+$/, ""),
			token: env.HINDSIGHT_API_TOKEN ?? "",
		};
	return { backend: "mnemopi" };
}

export function memoryOverlayYaml(choice: MemoryChoice): string {
	return `memory:\n  backend: ${choice.backend}\n`;
}

/** The trusted anchor the overlay lives under: the data volume (a mount point) or a per-install temp dir. */
export function overlayDirFor(env: Record<string, string | undefined>): string {
	return env.OTTR_DATA_DIR
		? resolve(env.OTTR_DATA_DIR)
		: join(tmpdir(), "ottr-omp-memory");
}

export function overlayPathFor(
	env: Record<string, string | undefined>,
): string {
	return join(overlayDirFor(env), "omp-memory.yml");
}

/** Writes the overlay only when its content differs: cheap to re-run per spawn, and a write failure fails the run loudly. */
export function ensureMemoryOverlay(
	env: Record<string, string | undefined> = process.env,
): string {
	const anchor = overlayDirFor(env);
	// The tmp fallback dir is the board's own (0700); the data dir is a mount point.
	if (!env.OTTR_DATA_DIR) mkdirSync(anchor, { recursive: true, mode: 0o700 });
	const path = overlayPathFor(env);
	const content = memoryOverlayYaml(memoryBackendFromEnv(env));
	try {
		const cur = readBelow(anchor, path, 4096);
		if (cur !== null && cur.toString("utf8") === content) return path;
	} catch {
		// a worker-planted symlink: fall through to the write, which refuses it too
	}
	// R5-1: the data dir and the home volume are worker-writable, so this write must
	// follow no symlink — a plant at the leaf or a parent fails the spawn instead.
	writeBelow(anchor, path, content);
	return path;
}

export type MemoryHealth = {
	backend: MemoryBackendName;
	ok: boolean;
	reason: string | null;
	checkedAt: string;
};

/** Probe file for the mnemopi store; deleted right after a successful write. */
const MNEMOPI_PROBE = "ottr-memory-health-probe";

export async function checkMemoryHealth(
	choice: MemoryChoice,
	opts?: {
		home?: string;
		boardHome?: string | null;
		fetchImpl?: typeof fetch;
		now?: () => number;
	},
): Promise<MemoryHealth> {
	const checkedAt = new Date((opts?.now ?? Date.now)()).toISOString();
	if (choice.backend === "hindsight") {
		const doFetch = opts?.fetchImpl ?? fetch;
		try {
			const res = await doFetch(`${choice.url}/v1/default/banks`, {
				headers: { authorization: `Bearer ${choice.token}` },
				// A hung Hindsight must not hold the health tick forever.
				signal: AbortSignal.timeout(5000),
			});
			if (res.ok)
				return { backend: choice.backend, ok: true, reason: null, checkedAt };
			// Never name the token in a reason: the reason lands in the state frame's warnings.
			const reason =
				res.status === 401 || res.status === 403
					? `Hindsight at ${choice.url} rejected the key (HTTP ${res.status})`
					: `Hindsight at ${choice.url} answered HTTP ${res.status}`;
			return { backend: choice.backend, ok: false, reason, checkedAt };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				backend: choice.backend,
				ok: false,
				reason: `Hindsight at ${choice.url} did not answer: ${message}`,
				checkedAt,
			};
		}
	}
	const homes = [opts?.home ?? process.env.HOME ?? homedir()];
	// The production tick passes no opts: the board home comes from the env then
	// (docs/specs/memory-backend.md). null opts out explicitly.
	const boardHome =
		opts?.boardHome === undefined
			? process.env.OTTR_BOARD_OMP_HOME
			: opts.boardHome;
	if (boardHome && !homes.includes(boardHome)) homes.push(boardHome);
	for (const home of homes) {
		const store = join(home, ".omp", "agent", "memories", "mnemopi");
		const probe = join(store, MNEMOPI_PROBE);
		try {
			// R5-1: the shared home is worker-writable, so the walk below it must
			// follow no symlink; a plant anywhere on the path reports, never writes.
			mkdirBelow(home, store);
			writeBelow(home, probe, "probe");
			unlinkBelow(home, probe);
		} catch {
			return {
				backend: choice.backend,
				ok: false,
				reason: `mnemopi store not writable: ${store}`,
				checkedAt,
			};
		}
	}
	return { backend: choice.backend, ok: true, reason: null, checkedAt };
}

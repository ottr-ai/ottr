import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

export function overlayPathFor(
	env: Record<string, string | undefined>,
): string {
	return env.OTTR_DATA_DIR
		? join(env.OTTR_DATA_DIR, "omp-memory.yml")
		: join(tmpdir(), "ottr-omp-memory.yml");
}

/** Writes the overlay only when its content differs: cheap to re-run per spawn, and a write failure fails the run loudly. */
export function ensureMemoryOverlay(
	env: Record<string, string | undefined> = process.env,
): string {
	const path = overlayPathFor(env);
	const content = memoryOverlayYaml(memoryBackendFromEnv(env));
	try {
		if (readFileSync(path, "utf8") === content) return path;
	} catch {
		// missing or unreadable: fall through to the write
	}
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
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
	if (opts?.boardHome && !homes.includes(opts.boardHome))
		homes.push(opts.boardHome);
	for (const home of homes) {
		const store = join(home, ".omp", "agent", "memories", "mnemopi");
		try {
			mkdirSync(store, { recursive: true });
			writeFileSync(join(store, MNEMOPI_PROBE), "probe", "utf8");
			rmSync(join(store, MNEMOPI_PROBE));
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

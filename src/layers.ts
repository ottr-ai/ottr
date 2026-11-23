import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	mkdirBelow,
	readBelow,
	renameBelow,
	unlinkBelow,
	withDir,
	writeBelow,
} from "./confine.ts";
import { type HeldLock, holdLock, probeLock } from "./layerLeaseLock.ts";

/** One installed agent layer under `<home>/.alate/layers/<id>` (OTTR-451). */
export type AgentLayer = { id: string; dir: string };

export type LayerPin =
	| { ok: true; layer: AgentLayer; agentDir: string }
	| { ok: false; reason: "none" | "broken" | "prepare" };

const currentLink = (home: string): string => join(home, ".alate", "current");

/** Shared-state entries linked inside every pinned layer, even before the flat target exists. */
const LINK_ALWAYS = [
	".omp/agent/agent.db",
	".omp/agent/sessions",
	".omp/oauth",
	".omp/logs",
	".cache",
];

/** Layer content linked back to the flat home only when the flat home has it. */
const LINK_IF_SOURCE_EXISTS = [
	".gitconfig",
	".config/git",
	".config/gh",
	".ssh",
	".claude",
	".npm",
	".bun",
	".local",
];

/**
 * The layer `<home>/.alate/current` resolves to, or null (no link, a link that does not
 * resolve, or a link pointing outside `<home>/.alate/layers` — alate never installs
 * there, so anything else is a plant; the callers fall back to the flat home).
 */
export function resolveAgentLayer(home: string): AgentLayer | null {
	const pin = pinTarget(home);
	return pin ? { id: basename(pin), dir: pin } : null;
}

/** Realpath of the current link, or null when it does not resolve or escapes the layers tree. */
function pinTarget(home: string): string | null {
	let dir: string;
	try {
		dir = realpathSync(currentLink(home));
	} catch {
		return null;
	}
	// The home is worker-writable (R5-1), so `current` itself can be planted: refuse any
	// target that is not `<home>/.alate/layers/<one segment>` — the only shape alate
	// creates. basename() is the layer id; a deeper or sibling path is a plant.
	const layersRoot = join(home, ".alate", "layers");
	if (dirname(dir) !== layersRoot) return null;
	return dir;
}

/**
 * Pin the current layer for one run: resolve it once, prepare the shared-state links, and
 * return the paths the run's env carries. A miss falls back to the flat home; a broken link
 * or a failed prepare does too (reason says which). The links are idempotent and safe under
 * concurrent pins. `memory.backend` in the layer's config.yml is not layer content (the
 * deployment picks the backend, OTTR-453): the pin never rewrites config.yml.
 */
export function pinnedAgentLayer(home: string): LayerPin {
	// A dangling link still lstats: only the lstat absence means "no layer".
	try {
		lstatSync(currentLink(home));
	} catch {
		return { ok: false, reason: "none" };
	}
	const dir = pinTarget(home);
	if (dir === null) return { ok: false, reason: "broken" };
	const layer = { id: basename(dir), dir };
	try {
		prepareLayer(home, layer);
	} catch {
		return { ok: false, reason: "prepare" };
	}
	return { ok: true, layer, agentDir: join(dir, ".omp", "agent") };
}

/** Symlink `rel` -> `target` inside the layer; an entry already in the layer wins, an EEXIST race is fine. */
function linkOne(anchor: string, rel: string, target: string): void {
	// The parent components below the layer must be real directories: openDir creates
	// missing components without following a symlink, so a planted intermediate link
	// (the home is worker-writable, R5-1) fails the pin closed instead of redirecting
	// the write into storage outside the layer (OTTR-1016).
	withDir(anchor, join(anchor, dirname(rel)), { create: true }, (d) => {
		try {
			symlinkSync(target, d.at(basename(rel)));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	});
}

/**
 * Link the layer's shared state back to the flat home. Safe to call twice; never mutates an
 * entry that already exists in the layer, and never touches the layer's config.yml.
 */
function prepareLayer(home: string, layer: AgentLayer): void {
	for (const rel of LINK_ALWAYS) linkOne(layer.dir, rel, join(home, rel));
	for (const rel of LINK_IF_SOURCE_EXISTS) {
		const source = join(home, rel);
		// Missing target stays missing, as today: omp creates it in the layer, where it dies
		// with the layer at clean-up.
		if (existsSync(source)) linkOne(layer.dir, rel, source);
	}
}

// --- In-use registry -------------------------------------------------------
// `<home>/.alate/in-use.json` is the public aggregate alate reads for clean-up:
// `{"layers":[{"id","since"}]}`, one entry per leased layer id. Ottr processes write it.
// Ownership lives in private files next to it (docs/specs/agent-layer-switch.md, "Record"):
//   in-use.owners.json  the durable ledger: one row per lease (random token, id, since), plus
//                       the boot recovery rows of open turns;
//   leases/<token>.lock the lease's liveness lock, held by its holder process until release;
//   in-use.lock         the mutation lock: every read-modify-write of the ledger runs under it.
// The home is worker-writable (R5-1): the JSON files go through the confine helpers, and the
// lock files open with SQLITE_OPEN_NOFOLLOW below the realpath'd home.

type UseEntry = { id: string; since: number };
type Lease = { token: string; id: string; since: number };
export type LayerLedger = { leases: Lease[]; recovery: UseEntry[] };

const MAX_META_BYTES = 1 << 20;
/** How long a mutation waits for another process's mutation lock before it fails. */
const MUTATION_WAIT_MS = 10_000;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const alateDir = (home: string): string => join(home, ".alate");
const inUsePath = (home: string): string => join(home, ".alate", "in-use.json");
const ledgerPath = (home: string): string =>
	join(home, ".alate", "in-use.owners.json");
const leasesDir = (home: string): string => join(home, ".alate", "leases");
const leaseLockPath = (realHome: string, token: string): string =>
	join(realHome, ".alate", "leases", `${token}.lock`);

/** A layer id is one directory name below `.alate/layers`. */
export function isLayerId(id: unknown): id is string {
	return (
		typeof id === "string" &&
		id.length > 0 &&
		id.length <= 255 &&
		id !== "." &&
		id !== ".." &&
		!/[/\\\0]/.test(id)
	);
}

const isSince = (v: unknown): v is number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function hasExactKeys(
	v: unknown,
	keys: readonly string[],
): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const own = Object.keys(v);
	return own.length === keys.length && keys.every((k) => own.includes(k));
}

/** Parses the private ledger; any deviation throws, so a corrupt ledger fails closed. */
export function parseLayerLedger(text: string): LayerLedger {
	const corrupt = (why: string) =>
		new Error(`corrupt agent layer ledger: ${why}`);
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		throw corrupt("not JSON");
	}
	if (!hasExactKeys(v, ["version", "leases", "recovery"]) || v.version !== 1)
		throw corrupt("bad shape");
	const leaseRows: unknown = v.leases;
	const recoveryRows: unknown = v.recovery;
	if (!Array.isArray(leaseRows) || !Array.isArray(recoveryRows))
		throw corrupt("bad shape");
	const tokens = new Set<string>();
	const leases = leaseRows.map((e: unknown): Lease => {
		if (
			!hasExactKeys(e, ["token", "id", "since"]) ||
			typeof e.token !== "string" ||
			!UUID.test(e.token) ||
			tokens.has(e.token) ||
			!isLayerId(e.id) ||
			!isSince(e.since)
		)
			throw corrupt("bad lease row");
		tokens.add(e.token);
		return { token: e.token, id: e.id, since: e.since };
	});
	const recovery = recoveryRows.map((e: unknown): UseEntry => {
		if (
			!hasExactKeys(e, ["id", "since"]) ||
			!isLayerId(e.id) ||
			!isSince(e.since)
		)
			throw corrupt("bad recovery row");
		return { id: e.id, since: e.since };
	});
	return { leases, recovery };
}

export function ledgerText(ledger: LayerLedger): string {
	return JSON.stringify({
		version: 1,
		leases: ledger.leases,
		recovery: ledger.recovery,
	});
}

/** The public registry as written, lenient: invalid entries are skipped. Throws when unreadable. */
function readPublic(home: string): UseEntry[] {
	const raw = readBelow(home, inUsePath(home), MAX_META_BYTES);
	if (raw === null) return [];
	const parsed: unknown = JSON.parse(raw.toString("utf8"));
	if (typeof parsed !== "object" || parsed === null || !("layers" in parsed))
		return [];
	const layers = parsed.layers;
	if (!Array.isArray(layers)) return [];
	const valid: UseEntry[] = [];
	for (const entry of layers) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("id" in entry) ||
			!("since" in entry)
		)
			continue;
		const { id, since } = entry;
		if (typeof id === "string" && typeof since === "number")
			valid.push({ id, since });
	}
	return valid;
}

/**
 * The public registry from before the private ledger, strict: a missing or empty file holds
 * no entry, anything else must be a valid registry. Its holders are unknown, so a registry
 * this cannot read fails closed instead of losing them.
 */
function readLegacy(home: string): UseEntry[] {
	const corrupt = () =>
		new Error("unreadable agent layer registry without a private ledger");
	const raw = readBelow(home, inUsePath(home), MAX_META_BYTES);
	if (raw === null || raw.length === 0) return [];
	let v: unknown;
	try {
		v = JSON.parse(raw.toString("utf8"));
	} catch {
		throw corrupt();
	}
	if (!hasExactKeys(v, ["layers"])) throw corrupt();
	const layers: unknown = v.layers;
	if (!Array.isArray(layers)) throw corrupt();
	return layers.map((e: unknown): UseEntry => {
		if (
			!hasExactKeys(e, ["id", "since"]) ||
			!isLayerId(e.id) ||
			!isSince(e.since)
		)
			throw corrupt();
		return { id: e.id, since: e.since };
	});
}

/**
 * The private ledger. A missing ledger (the first lease after the OTTR-1132 upgrade) takes
 * the public entries as recovery rows, so the upgrade never drops a protection; the next
 * boot rebuild replaces them. A corrupt or planted ledger, or a missing ledger next to an
 * unreadable public registry, throws.
 */
function readLedger(home: string): LayerLedger {
	const raw = readBelow(home, ledgerPath(home), MAX_META_BYTES);
	if (raw !== null) return parseLayerLedger(raw.toString("utf8"));
	return { leases: [], recovery: readLegacy(home) };
}

/** One public entry per id, in first-seen order; `since` is the earliest holder's. */
function aggregate(rows: readonly UseEntry[]): UseEntry[] {
	const since = new Map<string, number>();
	for (const r of rows) {
		const s = since.get(r.id);
		since.set(r.id, s === undefined ? r.since : Math.min(s, r.since));
	}
	return [...since].map(([id, s]) => ({ id, since: s }));
}

const ledgerRows = (l: LayerLedger): UseEntry[] => [...l.recovery, ...l.leases];

/** Writes `name` below `.alate` atomically: a random tmp file, then a rename over the target. */
function writeAtomic(home: string, name: string, text: string): void {
	// A random tmp suffix keeps a planted tmp name from predicting the write; the rename
	// replaces a planted symlink at the target instead of following it.
	const tmp = join(
		alateDir(home),
		`${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
	);
	// A file over the read bound could never be read back: refuse it before it replaces one.
	if (Buffer.byteLength(text) > MAX_META_BYTES)
		throw new Error(`agent layer ${name} would exceed ${MAX_META_BYTES} bytes`);
	try {
		writeBelow(home, tmp, text, "exclusive");
		renameBelow(home, tmp, join(alateDir(home), name));
	} catch (err) {
		try {
			unlinkBelow(home, tmp);
		} catch {
			/* the write failure is the one that matters */
		}
		throw err;
	}
}

const publish = (home: string, entries: UseEntry[]): void =>
	writeAtomic(home, "in-use.json", JSON.stringify({ layers: entries }));

/**
 * Moves the stores from `old` to `next` so that a failure at any step leaves the public
 * registry a superset of the ledger: first the union when `next` adds a row, then the
 * ledger, then `next` (unless the union already was `next`). `onLedger` runs once the
 * ledger holds `next`.
 */
function commit(
	home: string,
	old: LayerLedger,
	next: LayerLedger,
	onLedger: () => void = () => {},
): void {
	const key = (rows: UseEntry[]) => JSON.stringify(aggregate(rows));
	const wide = [...ledgerRows(old), ...ledgerRows(next)];
	const widened = key(wide) !== key(ledgerRows(old));
	if (widened) publish(home, aggregate(wide));
	writeAtomic(home, "in-use.owners.json", ledgerText(next));
	onLedger();
	if (!widened || key(wide) !== key(ledgerRows(next)))
		publish(home, aggregate(ledgerRows(next)));
}

/** Runs `fn` under the shared mutation lock; throws when the lock stays busy. */
function withMutation<T>(home: string, fn: () => T): T {
	mkdirBelow(home, alateDir(home));
	const lock = holdLock(
		join(realpathSync(home), ".alate", "in-use.lock"),
		MUTATION_WAIT_MS,
	);
	try {
		return fn();
	} finally {
		lock.release();
	}
}

/** Liveness locks of the leases this process holds; the map keeps each lock's handle alive. */
const heldLeases = new Map<string, HeldLock>();

function dropLeaseFile(home: string, token: string): void {
	try {
		unlinkBelow(home, join(leasesDir(home), `${token}.lock`));
	} catch {
		/* a leftover zero-byte lock file protects nothing and blocks nothing */
	}
}

/** Layers with live holders, best-effort ([] when the registry is unreadable). */
export function readLayerUse(home: string): { id: string; since: number }[] {
	try {
		return readPublic(home);
	} catch {
		return [];
	}
}

/**
 * Takes one lease on layer `id` for a live run and returns its release. The lease holds a
 * liveness lock until release, so the boot rebuild never drops it while this process lives.
 * Throws when the lease cannot be recorded: the caller must not spawn on the layer then.
 * The release frees only this lease, never throws, and does nothing once it succeeded; a
 * failed release warns and keeps the lease (and the layer's protection) for a later call.
 */
export function acquireLayerUse(
	home: string,
	id: string,
	since: number = Date.now(),
): () => void {
	if (!isLayerId(id))
		throw new Error(`invalid agent layer id: ${JSON.stringify(id)}`);
	if (!isSince(since))
		throw new Error(`invalid agent layer lease time: ${String(since)}`);
	const token = randomUUID();
	mkdirBelow(home, leasesDir(home));
	const lease = holdLock(leaseLockPath(realpathSync(home), token), 0);
	let recorded = false; // the ledger names this lease
	try {
		withMutation(home, () => {
			const old = readLedger(home);
			const next = {
				leases: [...old.leases, { token, id, since }],
				recovery: old.recovery,
			};
			try {
				commit(home, old, next, () => {
					recorded = true;
				});
			} catch (err) {
				// A failure after the ledger write: take back only this row, under the same lock.
				if (recorded)
					try {
						commit(home, next, old, () => {
							recorded = false;
						});
					} catch (undo) {
						console.warn(
							`! agent layer lease rollback incomplete: ${String(undo)}`,
						);
					}
				throw err;
			}
		});
	} catch (err) {
		if (recorded) {
			// The ledger still names the lease: hold its lock until this process ends, so no
			// rebuild drops the row early and a later rebuild can prove the end.
			heldLeases.set(token, lease);
		} else {
			lease.release();
			dropLeaseFile(home, token);
		}
		throw err;
	}
	heldLeases.set(token, lease);
	let released = false;
	return () => {
		if (released) return;
		try {
			withMutation(home, () => {
				const old = readLedger(home);
				const next = {
					leases: old.leases.filter((l) => l.token !== token),
					recovery: old.recovery,
				};
				commit(home, old, next, () => {
					released = true;
				});
			});
		} catch (err) {
			if (!released) {
				console.warn(
					`! agent layer lease release failed, the layer stays protected: ${String(err)}`,
				);
				return;
			}
			console.warn(`! agent layer registry update failed: ${String(err)}`);
		}
		released = true;
		heldLeases.delete(token);
		lease.release();
		dropLeaseFile(home, token);
	};
}

/**
 * The boot rebuild: keeps every lease whose holder may live (its lock is held, or the probe
 * is uncertain), drops the leases whose lock proves that the holder ended, and replaces the
 * recovery rows with `ids` (since = now), the layers that open turns still pin. Never
 * throws: a failure warns and retains conservative protection (the public registry still
 * lists at least the ledger's ids).
 */
export function rebuildLayerUse(home: string, ids: string[]): void {
	const now = Date.now();
	const ended: string[] = [];
	try {
		withMutation(home, () => {
			const old = readLedger(home);
			const realHome = realpathSync(home);
			const leases = old.leases.filter((l) => {
				if (heldLeases.has(l.token)) return true;
				if (probeLock(leaseLockPath(realHome, l.token)) !== "free") return true;
				ended.push(l.token);
				return false;
			});
			const recovery = [...new Set(ids.filter(isLayerId))].map((id) => ({
				id,
				since: now,
			}));
			commit(home, old, { leases, recovery });
		});
	} catch (err) {
		console.warn(`! agent layer registry rebuild failed: ${String(err)}`);
		return;
	}
	for (const token of ended) dropLeaseFile(home, token);
}

// ADR-0011: the `config` row's token/key fields are sealed at rest with the SecretBox.
// This module owns the two seal points: the boot migration (seal every plaintext spot of the
// stored row) and the walker saveConfig runs the row through before it writes. The walker is
// the only place that produces sealed strings for the config row.

import { isSealed, type SecretBox } from "./secretBox.ts";

/** The store surface the migration needs (GlobalStore satisfies it). */
export interface SealedConfigStore {
	get<T>(key: string): T | null;
	set(key: string, value: unknown): void;
}

/** Seal one scalar spot: empty and already-sealed values pass through unchanged. */
function sealSpot(
	v: unknown,
	box: SecretBox,
): { v: unknown; changed: boolean } {
	if (typeof v !== "string" || v === "" || isSealed(v))
		return { v, changed: false };
	return { v: box.seal(v), changed: true };
}

/** Seal one named field of an object spot (alate/githubApp hold `key`, git token rows hold `token`); a non-object passes through. */
function sealKeySpot(
	v: unknown,
	field: string,
	box: SecretBox,
): { v: unknown; changed: boolean } {
	if (typeof v !== "object" || v === null) return { v, changed: false };
	const o = v as Record<string, unknown>;
	const out = sealSpot(o[field], box);
	if (!out.changed) return { v, changed: false };
	return { v: { ...o, [field]: out.v }, changed: true };
}

/**
 * Seals every token/key spot of a stored config row (ADR-0011 scope list): apiKey,
 * sessionSecret, githubToken, hindsightToken, alate.key, githubApp.key, gitTokens[].token,
 * every envValues value, vapid.privateKey. admin.passHash, sessions and everything else pass
 * through untouched; already-sealed blobs stay sealed (idempotent). Shallow copy: the input
 * row is never mutated.
 */
export function sealStoredConfigRow(
	row: unknown,
	box: SecretBox,
): { row: unknown; changed: boolean } {
	if (typeof row !== "object" || row === null) return { row, changed: false };
	const r = { ...(row as Record<string, unknown>) };
	let changed = false;
	const spot = (k: string): void => {
		const out = sealSpot(r[k], box);
		if (out.changed) {
			r[k] = out.v;
			changed = true;
		}
	};
	for (const k of ["apiKey", "sessionSecret", "githubToken", "hindsightToken"])
		spot(k);
	{
		const out = sealKeySpot(r.alate, "key", box);
		if (out.changed) {
			r.alate = out.v;
			changed = true;
		}
	}
	{
		const out = sealKeySpot(r.githubApp, "key", box);
		if (out.changed) {
			r.githubApp = out.v;
			changed = true;
		}
	}
	if (Array.isArray(r.gitTokens)) {
		let touched = false;
		const next = (r.gitTokens as unknown[]).map((t) => {
			const out = sealKeySpot(t, "token", box);
			if (!out.changed) return t;
			touched = true;
			return out.v;
		});
		if (touched) {
			r.gitTokens = next;
			changed = true;
		}
	}
	if (
		typeof r.envValues === "object" &&
		r.envValues !== null &&
		!Array.isArray(r.envValues)
	) {
		const vals = r.envValues as Record<string, unknown>;
		const next: Record<string, unknown> = {};
		let touched = false;
		for (const [name, value] of Object.entries(vals)) {
			const out = sealSpot(value, box);
			if (out.changed) touched = true;
			next[name] = out.v;
		}
		if (touched) {
			r.envValues = next;
			changed = true;
		}
	}
	if (
		typeof r.vapid === "object" &&
		r.vapid !== null &&
		!Array.isArray(r.vapid)
	) {
		const v = { ...(r.vapid as Record<string, unknown>) };
		const out = sealSpot(v.privateKey, box);
		if (out.changed) {
			r.vapid = { ...v, privateKey: out.v };
			changed = true;
		}
	}
	return { row: r, changed };
}

/**
 * Boot migration: seals every plaintext spot of the stored `config` row in place and writes
 * the row back only when something changed. Converge, never destructive: a row without the
 * box (legacy degraded mode) stays as it is, and a second boot with everything already
 * sealed writes nothing.
 */
export function migrateSealedConfig(
	gstore: SealedConfigStore,
	box: SecretBox | undefined,
): void {
	if (box === undefined) return;
	const out = sealStoredConfigRow(gstore.get<unknown>("config"), box);
	if (out.changed) gstore.set("config", out.row);
}

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Alate's content fingerprint for one provisioned file: sha256 over CRLF-normalized
 * latin1 text; `omp/marketplaces.json` compares as parsed JSON without `updatedAt` keys
 * (omp stamps that on every catalog refresh), unparsable bytes compare as raw text.
 * Must stay byte-compatible with alate's install-user.mjs record check
 * (docs/specs/turn-provision-guard.md). */
export function provisionFingerprint(rel: string, bytes: Buffer): string {
	let text = bytes.toString("latin1").replaceAll("\r\n", "\n");
	if (rel === "omp/marketplaces.json") {
		try {
			text = JSON.stringify(JSON.parse(bytes.toString("utf8")), (k, v) =>
				k === "updatedAt" ? undefined : v,
			);
		} catch {
			// unparsable: its raw text is the content, so it differs from any parsable registry
		}
	}
	return createHash("sha256").update(text).digest("hex");
}

// The top-level `hindsight:`/`alate:` blocks of config.yml are target-local deployment
// settings (endpoints, credentials): alate records and compares the config without them,
// so a stamped block must not read as drift. Ported byte-for-byte from alate's
// lib/data.mjs to keep the audit's verdict identical to the install plan's.
function splitDeploymentBlocks(text: string): {
	kept: string[];
	tail: boolean;
} {
	let excluded = false;
	const kept: string[] = [];
	for (const line of text.replace(/^\uFEFF/, "").split("\n")) {
		if (/^\S/.test(line) && !line.startsWith("#"))
			excluded =
				/^(?:hindsight|alate|"(?:hindsight|alate)"|'(?:hindsight|alate)')[ \t]*:/.test(
					line,
				);
		if (!excluded) kept.push(line);
	}
	return { kept, tail: excluded };
}

function withoutDeploymentBlocks(text: string): string {
	const { kept, tail } = splitDeploymentBlocks(text);
	const base = kept.join("\n");
	return base && tail ? `${base}\n` : base;
}

/** Drift of the provisioned agent layer in `home`, one line per finding, [] when clean.
 * Lines: `<.rel> changed` | `<.rel> missing` | `<.rel> unreadable`,
 * then a final `… +N more` line when more than 40 findings. Never throws.
 * Files the manifest never recorded are machine state or unrecorded extras — they make
 * no finding, because an added file neither changes what alate provisions nor makes the
 * next provision refuse. */
export function auditProvisioned(home: string, sinceMs?: number): string[] {
	try {
		// Layer mode: a pinned turn writes its own layer by design, and alate no longer
		// maintains the flat trees, so there is nothing here to prove.
		if (lstatSync(join(home, ".alate", "current"), { throwIfNoEntry: false }))
			return [];

		const manifestPath = join(home, ".alate", "installed.json");
		let manifest: Record<string, string>;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch {
			return [];
		}
		// A manual provision rewrote the home inside the run's window; its writes are not
		// this run's drift.
		if (sinceMs !== undefined && statSync(manifestPath).mtimeMs > sinceMs)
			return [];

		// A hostile manifest must never send the walk outside home.
		const valid: string[] = [];
		for (const rel of Object.keys(manifest)) {
			if (rel.startsWith("/")) continue;
			const segs = rel.split("/");
			if (segs.some((s) => s === "" || s === ".." || s.includes("\\")))
				continue;
			valid.push(rel);
		}

		const tracked: string[] = [];
		for (const rel of valid) {
			const p = join(home, `.${rel}`);
			try {
				lstatSync(p);
			} catch {
				tracked.push(`.${rel} missing`);
				continue;
			}
			let bytes: Buffer;
			try {
				bytes = readFileSync(p);
			} catch {
				tracked.push(`.${rel} unreadable`);
				continue;
			}
			// config.yml's deployment blocks are target-local; alate records and compares
			// the config without them, so the audit must strip the same blocks.
			if (rel === "omp/agent/config.yml")
				bytes = Buffer.from(
					withoutDeploymentBlocks(bytes.toString("utf8")),
					"utf8",
				);
			if (provisionFingerprint(rel, bytes) !== manifest[rel])
				tracked.push(`.${rel} changed`);
		}

		// Everything the manifest never recorded is machine state (agent.db, sessions,
		// caches) that alate itself creates, or an unrecorded extra: neither changes what
		// alate provisions nor makes the next provision refuse, so neither is a finding.

		if (tracked.length > 40)
			tracked.splice(40, tracked.length, `… +${tracked.length - 40} more`);
		return tracked;
	} catch {
		// The audit gives up cleanly: an unexpected fs error yields no findings, never a throw.
		return [];
	}
}

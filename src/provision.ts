import { createHash } from "node:crypto";
import {
	type Dirent,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
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
 * Lines: `<.rel> changed` | `<.rel> missing` | `<.rel> unreadable` | `<.rel> untracked`
 * (untracked only for rule files planted in the rules dir), then a final `… +N more` line
 * when more than 40 findings. Never throws.
 * Files the manifest never recorded are machine state or unrecorded extras — they make
 * no finding, because an added file neither changes what alate provisions nor makes the
 * next provision refuse. Rules audit through their own record, the rules dir's
 * `.alate-installed.json` (sync.mjs rewrites it from the snapshot every provision). */
export function auditProvisioned(home: string, sinceMs?: number): string[] {
	try {
		// Layer mode: a pinned turn writes its own layer by design, and alate no longer
		// maintains the flat trees, so there is nothing here to prove.
		if (lstatSync(join(home, ".alate", "current"), { throwIfNoEntry: false }))
			return [];

		const manifestPath = join(home, ".alate", "installed.json");
		let manifest: Record<string, string> | null = null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			)
				manifest = parsed as Record<string, string>;
		} catch {
			// No manifest or an unreadable one: no install-user baseline for those
			// files; the rules record below still audits on its own.
		}
		if (
			manifest !== null &&
			sinceMs !== undefined &&
			statSync(manifestPath).mtimeMs > sinceMs
		) {
			// A manual provision rewrote the home inside the run's window; its writes
			// are not this run's drift.
			manifest = null;
		}

		const tracked: string[] = [];
		if (manifest !== null) {
			// A hostile manifest must never send the walk outside home.
			const valid: string[] = [];
			for (const rel of Object.keys(manifest)) {
				if (rel.startsWith("/")) continue;
				const segs = rel.split("/");
				if (segs.some((s) => s === "" || s === ".." || s.includes("\\")))
					continue;
				valid.push(rel);
			}
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
		}

		// Everything the manifest never recorded is machine state (agent.db, sessions,
		// caches) that alate itself creates, or an unrecorded extra: neither changes what
		// alate provisions nor makes the next provision refuse, so neither is a finding.

		// Rules install through sync.mjs, whose own record (.alate-installed.json in the
		// rules dir) is their manifest — the install-user manifest holds no rule keys. The
		// record maps a flat rule name to the same alate fingerprint; the next provision
		// overwrites snapshot-covered rules, keeps an edited dropped rule, and rewrites
		// this record from the snapshot every run.
		const rulesRecordPath = join(
			home,
			".omp",
			"agent",
			"rules",
			".alate-installed.json",
		);
		let recorded: Record<string, string> | null = null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(rulesRecordPath, "utf8"));
			if (typeof parsed === "object" && parsed !== null) {
				recorded = {};
				for (const [k, v] of Object.entries(parsed))
					if (typeof v === "string") recorded[k] = v;
			}
		} catch {
			// No record or an unreadable one: no rules baseline, no rules findings.
		}
		// The same run-window rule as the manifest: a mid-run sync rewrote the record,
		// and its writes are not this run's drift.
		let fresh = true;
		try {
			fresh = statSync(rulesRecordPath).mtimeMs <= (sinceMs ?? Infinity);
		} catch {
			fresh = false; // the record vanished between the read and the stat
		}
		if (recorded !== null && fresh) {
			const rulesDir = join(home, ".omp", "agent", "rules");
			for (const [name, sha] of Object.entries(recorded)) {
				if (
					name.startsWith("/") ||
					name
						.split("/")
						.some((s) => s === "" || s === ".." || s.includes("\\"))
				)
					continue;
				const p = join(rulesDir, name);
				try {
					lstatSync(p);
				} catch {
					tracked.push(`.omp/agent/rules/${name} missing`);
					continue;
				}
				let bytes: Buffer;
				try {
					bytes = readFileSync(p);
				} catch {
					tracked.push(`.omp/agent/rules/${name} unreadable`);
					continue;
				}
				if (provisionFingerprint(name, bytes) !== sha)
					tracked.push(`.omp/agent/rules/${name} changed`);
			}
			// The rules dir holds exactly the record and the snapshot's rules — a flat,
			// sync-managed dir with no machine state — so an unrecorded entry is a
			// planted rule: the one place an add is a finding.
			let entries: Dirent[];
			try {
				entries = readdirSync(rulesDir, { withFileTypes: true });
			} catch {
				entries = [];
			}
			for (const e of [...entries].sort((a, b) =>
				a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
			)) {
				if (
					e.name === ".alate-installed.json" ||
					recorded[e.name] !== undefined
				)
					continue;
				tracked.push(`.omp/agent/rules/${e.name} untracked`);
			}
		}

		if (tracked.length > 40)
			tracked.splice(40, tracked.length, `… +${tracked.length - 40} more`);
		return tracked;
	} catch {
		// The audit gives up cleanly: an unexpected fs error yields no findings, never a throw.
		return [];
	}
}

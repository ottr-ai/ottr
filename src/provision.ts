import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** Sorted entry names of the home's rules dir, [] when it is missing or unreadable.
 * Captured when a run starts, so the audit can flag only the entries that run added. */
export function rulesDirEntries(home: string): string[] {
	try {
		return readdirSync(join(home, ".omp", "agent", "rules"), {
			withFileTypes: true,
		})
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

/** Drift of the provisioned agent layer in `home`, one line per finding, [] when clean.
 * Lines: `<.rel> changed` | `<.rel> missing` | `<.rel> unreadable` | `<.rel> untracked`
 * (untracked only for rule entries the run added: pass `rulesAtStart`, the rulesDirEntries
 * capture from spawn time — without it the scan stays off, like the manifest audit, which
 * never flags an added file), then a final `… +N more` line when more than 40 findings.
 * Never throws.
 * Files the manifest never recorded are machine state or unrecorded extras — they make
 * no finding, because an added file neither changes what alate provisions nor makes the
 * next provision refuse; pre-existing unrecorded rules are deployment state that sync
 * keeps by design. Rules audit through their own record, the rules dir's
 * `.alate-installed.json` (sync.mjs rewrites it from the snapshot every provision). */
/** A record name that stays inside its root: not absolute, no empty/`..` segment, no backslash. */
function isSafeName(name: string): boolean {
	return (
		!name.startsWith("/") &&
		!name.split("/").some((s) => s === "" || s === ".." || s.includes("\\"))
	);
}

/** The install-user manifest, or null when absent, unreadable, or not a plain object. */
function readManifest(path: string): Record<string, string> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			return parsed as Record<string, string>;
	} catch {
		// No manifest or an unreadable one: no install-user baseline for those
		// files; the rules record below still audits on its own.
	}
	return null;
}

/** The rules record: every own entry whose value is a string, from any JSON object. */
function readRulesRecord(path: string): Record<string, string> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsed))
				if (typeof v === "string") out[k] = v;
			return out;
		}
	} catch {
		// No record or an unreadable one: no rules baseline, no rules findings.
	}
	return null;
}

/** One recorded file's drift line, or null when its fingerprint matches `sha`. */
function recordedDrift(
	path: string,
	name: string,
	sha: string,
	prefix: string,
	stripConfigBlocks: boolean,
): string | null {
	try {
		lstatSync(path);
	} catch {
		return `${prefix} missing`;
	}
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch {
		return `${prefix} unreadable`;
	}
	// config.yml's deployment blocks are target-local; alate records and compares
	// the config without them, so the audit must strip the same blocks.
	if (stripConfigBlocks && name === "omp/agent/config.yml")
		bytes = Buffer.from(
			withoutDeploymentBlocks(bytes.toString("utf8")),
			"utf8",
		);
	return provisionFingerprint(name, bytes) !== sha ? `${prefix} changed` : null;
}

/** Drift lines for the manifest's safe entries, in manifest key order. */
function auditManifestFiles(
	home: string,
	manifest: Record<string, string>,
): string[] {
	const findings: string[] = [];
	for (const rel of Object.keys(manifest)) {
		// A hostile manifest must never send the walk outside home.
		if (!isSafeName(rel)) continue;
		const line = recordedDrift(
			join(home, `.${rel}`),
			rel,
			manifest[rel] ?? "",
			`.${rel}`,
			true,
		);
		if (line !== null) findings.push(line);
	}
	return findings;
}

/** Drift lines for the rules record's safe entries, in record key order. */
function auditRulesRecord(
	rulesDir: string,
	recorded: Record<string, string>,
): string[] {
	const findings: string[] = [];
	for (const [name, sha] of Object.entries(recorded)) {
		if (!isSafeName(name)) continue;
		const line = recordedDrift(
			join(rulesDir, name),
			name,
			sha,
			`.omp/agent/rules/${name}`,
			false,
		);
		if (line !== null) findings.push(line);
	}
	return findings;
}

/** Untracked-rule lines: entries the run itself added (the planted-rule class). */
function untrackedRuleLines(
	home: string,
	recorded: Record<string, string>,
	rulesAtStart: readonly string[],
): string[] {
	const atStart = new Set(rulesAtStart);
	const added = rulesDirEntries(home).filter((name) => !atStart.has(name));
	const lines: string[] = [];
	for (const name of added) {
		if (name === ".alate-installed.json" || recorded[name] !== undefined)
			continue;
		lines.push(`.omp/agent/rules/${name} untracked`);
	}
	return lines;
}

export function auditProvisioned(
	home: string,
	sinceMs?: number,
	rulesAtStart?: readonly string[],
): string[] {
	try {
		// Layer mode: a pinned turn writes its own layer by design, and alate no longer
		// maintains the flat trees, so there is nothing here to prove.
		if (lstatSync(join(home, ".alate", "current"), { throwIfNoEntry: false }))
			return [];

		const manifestPath = join(home, ".alate", "installed.json");
		const manifest = readManifest(manifestPath);
		// A manual provision rewrote the home inside the run's window; its writes
		// are not this run's drift.
		const staleManifest =
			manifest !== null &&
			sinceMs !== undefined &&
			statSync(manifestPath).mtimeMs > sinceMs;

		const tracked: string[] =
			manifest === null || staleManifest
				? []
				: auditManifestFiles(home, manifest);

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
		const recorded = readRulesRecord(rulesRecordPath);
		// The same run-window rule as the manifest: a mid-run sync rewrote the record,
		// and its writes are not this run's drift.
		let fresh = true;
		try {
			fresh = statSync(rulesRecordPath).mtimeMs <= (sinceMs ?? Infinity);
		} catch {
			fresh = false; // the record vanished between the read and the stat
		}
		if (recorded !== null && fresh) {
			tracked.push(
				...auditRulesRecord(join(home, ".omp", "agent", "rules"), recorded),
			);
			// The rules dir holds exactly the record and the snapshot's rules, but it can
			// also hold unrecorded rules an older alate installed: sync keeps those by
			// design ("Not from the data repo, left in place"). Only an entry the run
			// itself added is a finding — the planted-rule class — so the scan compares
			// against the spawn-time capture and stays off without one.
			if (rulesAtStart !== undefined)
				tracked.push(...untrackedRuleLines(home, recorded, rulesAtStart));
		}

		if (tracked.length > 40)
			tracked.splice(40, tracked.length, `… +${tracked.length - 40} more`);
		return tracked;
	} catch {
		// The audit gives up cleanly: an unexpected fs error yields no findings, never a throw.
		return [];
	}
}

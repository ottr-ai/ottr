import { createHash, randomBytes } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** What one per-turn microVM token opens: the card's own branch, project and worktree. */
export interface VmGrant {
	project: string;
	taskId: string;
	branch: string;
	/** Project main checkout (Entry.path): the repo the board's git endpoint serves. */
	repoPath: string;
	/** Server worktree (task.worktree): reset to every pushed head. */
	worktree: string;
	/** Task base as given at dispatch (a ref like `main`, or a sha); its ref stays fetchable. */
	base?: string;
}

/** Both a raw token (32 bytes hex) and its sha256 digest are 64 lowercase hex chars. */
const HEX64 = /^[0-9a-f]{64}$/;
const GRANT_KEYS = [
	"project",
	"taskId",
	"branch",
	"repoPath",
	"worktree",
] as const;

function digest(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

function parseGrant(v: unknown): VmGrant | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v as Record<string, unknown>;
	const g: Partial<Record<(typeof GRANT_KEYS)[number], string>> = {};
	for (const k of GRANT_KEYS) {
		const s = o[k];
		if (typeof s !== "string" || s === "") return null;
		g[k] = s;
	}
	const base = o.base;
	if (base !== undefined) {
		if (typeof base !== "string" || base === "") return null;
		(g as Record<string, string>).base = base;
	}
	return Object.freeze(g as VmGrant);
}

/**
 * The VM token of a request: `Authorization: Bearer <token>`, or Basic with the token as the
 * password (git's credential path). Anything else reads as no token.
 */
export function vmTokenOf(req: Request): string | null {
	const h = req.headers.get("authorization");
	if (h === null) return null;
	const bearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(h);
	if (bearer) return bearer[1] ?? null;
	const basic = /^Basic[ \t]+([A-Za-z0-9+/=]+)[ \t]*$/i.exec(h);
	if (!basic) return null;
	const pair = Buffer.from(basic[1] ?? "", "base64").toString("utf8");
	const colon = pair.indexOf(":");
	return colon < 0 ? null : pair.slice(colon + 1);
}

/**
 * Per-turn microVM tokens (OTTR-532). Only sha256(token) is kept, in memory and in `file`, so
 * neither a heap dump nor the file hands out a live token. The file lets a VM turn the board
 * re-binds after a restart keep pushing; the turn's settle revokes its tokens. `file: null`
 * keeps them in memory only (tests, a board without OTTR_SERVER_DATA_DIR).
 */
export class VmTokens {
	private readonly file: string | null;
	private readonly grants = new Map<string, VmGrant>();

	constructor(opts: { file: string | null }) {
		this.file = opts.file;
		if (this.file !== null) this.load(this.file);
	}

	/** A fresh raw token (32 random bytes, hex) for `grant`. */
	issue(grant: VmGrant): string {
		const raw = randomBytes(32).toString("hex");
		const copy = parseGrant(grant);
		if (copy === null) throw new Error("a VM grant needs every field");
		this.grants.set(digest(raw), copy);
		this.save();
		return raw;
	}

	/** The grant of a live token; null for a missing, malformed, unknown or revoked one. */
	check(raw: string | null | undefined): VmGrant | null {
		// Malformed input never reaches the hash: only an issued token's shape can match.
		if (typeof raw !== "string" || !HEX64.test(raw)) return null;
		return this.grants.get(digest(raw)) ?? null;
	}

	revoke(raw: string): void {
		if (this.grants.delete(digest(raw))) this.save();
	}

	/** Revokes every token of the card, however many turns issued one. */
	revokeTask(project: string, taskId: string): void {
		let changed = false;
		for (const [k, g] of this.grants) {
			if (g.project === project && g.taskId === taskId) {
				this.grants.delete(k);
				changed = true;
			}
		}
		if (changed) this.save();
	}

	private load(file: string): void {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			console.warn(`! VM token file unreadable (${file}): ${String(err)}`);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// A torn file cannot happen (atomic rename); a corrupt one starts empty: the VM turns
			// it named fail their next push with 401 instead of the board failing to boot.
			console.warn(`! VM token file is not JSON (${file}); starting empty`);
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		for (const [k, v] of Object.entries(parsed)) {
			const g = parseGrant(v);
			if (HEX64.test(k) && g !== null) this.grants.set(k, g);
		}
	}

	/**
	 * Best effort, never throws: memory is authoritative for this process, and a failed write
	 * only costs the tokens a board restart would keep. A throw here would fail a turn's settle.
	 * Temp file + rename, so a crash mid-write never leaves a torn file; mode 0600 from create.
	 */
	private save(): void {
		const file = this.file;
		if (file === null) return;
		const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.grants)), {
				mode: 0o600,
			});
			renameSync(tmp, file);
		} catch (err) {
			rmSync(tmp, { force: true });
			console.warn(`! VM token file write failed (${file}): ${String(err)}`);
		}
	}
}

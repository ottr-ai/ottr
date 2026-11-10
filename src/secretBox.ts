import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SecretBox {
	seal(plain: string): string;
	open(sealed: string): string | null;
	keyId: string;
}

const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function parseKey(raw: string): Buffer | null {
	const s = raw.trim();
	if (HEX_KEY.test(s)) return Buffer.from(s, "hex");
	if (B64.test(s)) {
		const b = Buffer.from(s, "base64");
		if (b.length === 32) return b;
	}
	return null;
}

function fileKey(dir: string): Buffer {
	const path = join(dir, "secret.key");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		const hex = randomBytes(32).toString("hex");
		try {
			writeFileSync(path, hex, { mode: 0o600, flag: "wx" });
			text = hex;
		} catch (w) {
			if ((w as NodeJS.ErrnoException).code !== "EEXIST") throw w;
			text = readFileSync(path, "utf8");
		}
	}
	const t = text.trim();
	if (!HEX_KEY.test(t))
		throw new Error(`malformed key file ${path}: expected 64 hex chars`);
	return Buffer.from(t, "hex");
}

/** Key: env OTTR_SECRET_KEY (32 bytes as 64 hex chars or base64) else `<dir>/secret.key` (created once, 32 random bytes, hex, mode 0o600). Throws on a malformed OTTR_SECRET_KEY. */
export function loadSecretBox(o: {
	dir: string;
	env?: Record<string, string | undefined>;
}): SecretBox {
	const envKey = (o.env ?? process.env).OTTR_SECRET_KEY;
	let key: Buffer;
	if (envKey) {
		const k = parseKey(envKey);
		if (!k)
			throw new Error("OTTR_SECRET_KEY must be 32 bytes as hex or base64");
		key = k;
	} else {
		key = fileKey(o.dir);
	}
	const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
	return {
		keyId,
		seal(plain) {
			const iv = randomBytes(12);
			const c = createCipheriv("aes-256-gcm", key, iv);
			const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
			return `v1:${keyId}:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
		},
		open(sealed) {
			try {
				const [v, kid, ivB64, tagB64, ctB64] =
					typeof sealed === "string" ? sealed.split(":") : [];
				if (v !== "v1" || kid !== keyId || ctB64 === undefined) return null;
				if (ivB64 === undefined || tagB64 === undefined) return null;
				if (sealed.split(":").length !== 5) return null;
				const iv = Buffer.from(ivB64, "base64");
				const tag = Buffer.from(tagB64, "base64");
				if (iv.length !== 12 || tag.length !== 16) return null;
				const d = createDecipheriv("aes-256-gcm", key, iv);
				d.setAuthTag(tag);
				return Buffer.concat([
					d.update(Buffer.from(ctB64, "base64")),
					d.final(),
				]).toString("utf8");
			} catch {
				return null;
			}
		},
	};
}

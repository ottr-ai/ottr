// Lends a model provider's access token from the board store into a turn's env. Only the board
// store holds a credential; workers get the short-lived access token through the env, never the
// refresh token (docs/specs/provider-credentials.md, "Token lending").
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./login.ts";

export const TOKEN_REFRESH_MARGIN_MS = 30 * 60_000;

const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-594fedd48592";
const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

interface ProviderSpec {
	env: string;
	/** The refresh endpoint, absent when the provider's tokens never expire. */
	refresh?: string;
	/** Seconds subtracted from the refreshed expiry, so we refresh before omp does. */
	skew?: number;
}

const PROVIDERS: Record<string, ProviderSpec> = {
	anthropic: {
		env: "ANTHROPIC_OAUTH_TOKEN",
		refresh: "https://api.anthropic.com/v1/oauth/token",
		skew: 300_000,
	},
	"openai-codex": {
		env: "OPENAI_CODEX_OAUTH_TOKEN",
		refresh: "https://auth.openai.com/oauth/token",
	},
	zai: { env: "ZAI_API_KEY" },
};

interface Credential {
	access?: unknown;
	refresh?: unknown;
	expires?: unknown;
}

interface RefreshResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
}

interface RefreshedToken {
	access: string;
	refresh?: string;
	expiresIn: number;
}

async function postRefresh(
	spec: ProviderSpec,
	refreshToken: string,
	fetchImpl: typeof fetch,
): Promise<RefreshedToken | null> {
	const anthropic = spec.refresh === "https://api.anthropic.com/v1/oauth/token";
	const res = await fetchImpl(
		spec.refresh!,
		anthropic
			? {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"anthropic-beta": "oauth-2025-04-20",
						"user-agent": "anthropic-sdk-typescript/2.30.0 userOAuthProvider",
					},
					body: JSON.stringify({
						grant_type: "refresh_token",
						client_id: ANTHROPIC_OAUTH_CLIENT_ID,
						refresh_token: refreshToken,
					}),
				}
			: {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "refresh_token",
						refresh_token: refreshToken,
						client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
					}),
				},
	);
	if (!res.ok) return null;
	const body: RefreshResponse = await res.json();
	if (
		typeof body.access_token !== "string" ||
		typeof body.expires_in !== "number"
	)
		return null;
	return {
		access: body.access_token,
		refresh:
			typeof body.refresh_token === "string" ? body.refresh_token : undefined,
		expiresIn: body.expires_in,
	};
}

const ACTIVE_ROW =
	"SELECT id, data FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth' AND disabled_cause IS NULL ORDER BY id DESC LIMIT 1";

function freshEnough(cred: Credential, now: number, marginMs: number): boolean {
	return (
		typeof cred.expires !== "number" ||
		!Number.isFinite(cred.expires) ||
		cred.expires - now > marginMs
	);
}

/** The env for the model's provider, or `{}` when nothing can be lent this turn. */
export async function lentProviderEnv(
	model: string | null | undefined,
	opts: {
		dbPath?: string;
		now?: number;
		fetchImpl?: typeof fetch;
		marginMs?: number;
	} = {},
): Promise<Record<string, string>> {
	const provider = model?.split("/", 1)[0];
	if (provider === undefined) return {};
	const spec = PROVIDERS[provider];
	if (!spec) return {};
	const now = opts.now ?? Date.now();
	const marginMs = opts.marginMs ?? TOKEN_REFRESH_MARGIN_MS;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const dbPath = opts.dbPath ?? join(agentDir(), "agent.db");
	if (!existsSync(dbPath)) return {};

	let db: Database;
	try {
		// A readonly open of a missing path fails with a message that names no file (login.ts).
		db = new Database(dbPath, { readonly: true });
	} catch {
		return {};
	}
	try {
		let row: { id: number; data: string } | null;
		try {
			row =
				(db.query(ACTIVE_ROW).get(provider) as {
					id: number;
					data: string;
				} | null) ?? null;
		} catch {
			return {}; // No auth_credentials table: the store is not an omp one.
		}
		if (!row) return {};
		let cred: Credential;
		try {
			cred = JSON.parse(row.data);
		} catch {
			return {};
		}
		// omp writes an object; junk from a damaged store must degrade, not throw.
		if (cred === null || typeof cred !== "object") return {};
		if (typeof cred.access !== "string") return {};
		if (freshEnough(cred, now, marginMs)) return { [spec.env]: cred.access };
		if (!spec.refresh || typeof cred.refresh !== "string") return {};

		// ponytail: the lease is best-effort — a missing table means no other refresher to
		// coordinate with, so refresh without it.
		const wdb = new Database(dbPath);
		try {
			const hasLeases = wdb
				.query(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_credential_refresh_leases'",
				)
				.get();
			if (hasLeases) {
				// omp's rule: take over an expired lease, never a live one.
				const taken = wdb
					.query(
						"INSERT INTO auth_credential_refresh_leases (credential_id, owner, expires_at_ms, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(credential_id) DO UPDATE SET owner = excluded.owner, expires_at_ms = excluded.expires_at_ms, updated_at = excluded.updated_at WHERE auth_credential_refresh_leases.expires_at_ms <= ?",
					)
					.run(
						row.id,
						`ottr-board:${process.pid}`,
						now + marginMs,
						Math.floor(now / 1000),
						now,
					);
				if (Number(taken.changes) === 0) {
					// Someone else is refreshing: lend the row only when it is fresh already.
					const again = wdb
						.query("SELECT data FROM auth_credentials WHERE id = ?")
						.get(row.id);
					if (
						again &&
						typeof again === "object" &&
						"data" in again &&
						typeof again.data === "string"
					) {
						const newer = JSON.parse(again.data) as Credential;
						if (
							freshEnough(newer, now, marginMs) &&
							typeof newer.access === "string"
						)
							return { [spec.env]: newer.access };
					}
					return {};
				}
			}
			let got: RefreshedToken | null;
			try {
				got = await postRefresh(spec, cred.refresh, fetchImpl);
			} catch {
				got = null;
			}
			if (!got) return {}; // The row stays untouched; the next turn retries.
			wdb
				.query(
					"UPDATE auth_credentials SET data = ?, updated_at = ? WHERE id = ?",
				)
				.run(
					JSON.stringify({
						...cred,
						access: got.access,
						refresh: got.refresh ?? cred.refresh,
						expires: now + got.expiresIn * 1000 - (spec.skew ?? 0),
					}),
					Math.floor(now / 1000),
					row.id,
				);
			if (hasLeases)
				wdb
					.query(
						"DELETE FROM auth_credential_refresh_leases WHERE credential_id = ?",
					)
					.run(row.id);
			return { [spec.env]: got.access };
		} finally {
			wdb.close();
		}
	} finally {
		db.close();
	}
}

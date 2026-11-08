// Hosted mode (docs/specs/hosted-mode.md): one env flag read once at boot. Off (the default and
// every self-hosted board), nothing here is constructed and every hook stays a no-op.

import { type IdentityRole, signIdentity, validTenantId } from "./auth.ts";

/** Hosted text the control plane injects; ottr's checked-in prompts never change. */
export interface HostedWording {
	/** Appended to work-turn prompts; "" appends nothing. */
	workSuffix: string;
	/** Appended to merge-turn prompts; "" appends nothing. */
	mergeSuffix: string;
	/** Appended to resume prompts (reply/Resume after a stop); "" appends nothing. */
	resumeSuffix: string;
	/** needsReason of a card parked at zero credit. */
	creditReason: string;
}

export interface HostedConfig {
	tenant: string;
	/** Per-tenant HMAC secret shared with the control plane only. */
	secret: string;
	/** Control-plane base URL (no trailing slash) for metering, credit and git-token calls. */
	controlUrl: string;
	wording: HostedWording;
}

export const DEFAULT_CREDIT_REASON =
	"This board is out of credit. The turn stopped and your work is kept in its worktree. After topping up, reply Resume to continue the same session, or cancel the card.";

/**
 * Parses the hosted env. Unset/""/"0" OTTR_HOSTED: null (self-host). "1": a full config, or a
 * throw that stops the boot, since a half-configured hosted board would serve unauthenticated.
 */
export function readHostedConfig(
	env: Record<string, string | undefined> = process.env,
): HostedConfig | null {
	const flag = env.OTTR_HOSTED ?? "";
	if (flag === "" || flag === "0") return null;
	if (flag !== "1")
		throw new Error(`OTTR_HOSTED must be "1" or unset, got "${flag}"`);
	const tenant = env.OTTR_HOSTED_TENANT ?? "";
	if (!validTenantId(tenant))
		throw new Error(
			"OTTR_HOSTED_TENANT must be 1-63 chars of a-z, 0-9 and '-', starting with a letter or digit",
		);
	const secret = env.OTTR_HOSTED_SECRET ?? "";
	if (secret.length < 32)
		throw new Error("OTTR_HOSTED_SECRET must hold at least 32 characters");
	return {
		tenant,
		secret,
		controlUrl: controlUrl(env.OTTR_HOSTED_CONTROL_URL ?? ""),
		wording: {
			workSuffix: env.OTTR_HOSTED_WORK_SUFFIX ?? "",
			mergeSuffix: env.OTTR_HOSTED_MERGE_SUFFIX ?? "",
			resumeSuffix: env.OTTR_HOSTED_RESUME_SUFFIX ?? "",
			creditReason: env.OTTR_HOSTED_CREDIT_REASON || DEFAULT_CREDIT_REASON,
		},
	};
}

/** https only, except plain http to a loopback host (tests, a same-machine control plane). */
function controlUrl(raw: string): string {
	if (raw === "") throw new Error("OTTR_HOSTED_CONTROL_URL must be set");
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new Error(`OTTR_HOSTED_CONTROL_URL is not a URL: ${raw}`);
	}
	const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
	if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
		throw new Error("OTTR_HOSTED_CONTROL_URL must use https");
	if (
		u.username !== "" ||
		u.password !== "" ||
		u.search !== "" ||
		u.hash !== ""
	)
		throw new Error(
			"OTTR_HOSTED_CONTROL_URL must not carry credentials, a query or a fragment",
		);
	return u.href.replace(/\/+$/, "");
}

/** Token counts of one run, summed over its assistant messages; cost in USD as omp reports it. */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** One metering event: one agent run (work/merge run or check run) of one turn. */
export interface MeteringRecord {
	tenant: string;
	project: string;
	/** The card id: a `PREFIX-n` speaking key or a legacy 8-hex id. */
	taskId: string;
	turnId: number;
	/** The turn's kind (work, merge, ...). */
	kind: string;
	/** The model role the run resolved its model from (default, critic, adversary). */
	role: string;
	/** provider/model the run used; null when omp never named it. */
	model: string | null;
	usage: TokenUsage;
}

export interface GitToken {
	token: string;
	/** ms epoch */
	expiresAt: number;
}

/** Everything hosted mode asks the control plane. Tests inject fakes. */
export interface HostedHooks {
	/** Fire-and-forget: never throws, never blocks the caller. */
	reportUsage(record: MeteringRecord): void;
	/** True while the tenant may start turns; throws when the control plane cannot answer. */
	creditOk(): Promise<boolean>;
	/** A short-lived push/fetch token for one project's remote; null: the project has none. */
	gitToken(project: string, remote: string): Promise<GitToken | null>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The HTTP client for HostedHooks (endpoints in docs/specs/hosted-mode.md). */
export function controlPlaneHooks(
	cfg: HostedConfig,
	opts: { fetch?: Fetch; log?: (msg: string) => void } = {},
): HostedHooks {
	const doFetch: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
	const log = opts.log ?? ((msg) => console.error(msg));
	const base = cfg.controlUrl;
	const call = (
		method: string,
		path: string,
		body?: unknown,
	): Promise<Response> => {
		const role: IdentityRole = "tenant";
		const headers: Record<string, string> = {
			"x-ottr-identity": signIdentity(cfg.secret, cfg.tenant, role),
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		return doFetch(`${base}/v1/tenants/${cfg.tenant}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
	};
	return {
		reportUsage(record) {
			call("POST", "/metering", record)
				.then((res) => {
					if (!res.ok) log(`hosted: metering report got HTTP ${res.status}`);
				})
				.catch((err: unknown) =>
					log(`hosted: metering report failed: ${String(err)}`),
				);
		},
		async creditOk() {
			const res = await call("GET", "/credit");
			if (!res.ok) throw new Error(`credit check got HTTP ${res.status}`);
			const body = (await res.json()) as { ok?: unknown };
			if (typeof body.ok !== "boolean")
				throw new Error("credit check answered without a boolean ok");
			return body.ok;
		},
		async gitToken(project, remote) {
			const res = await call("POST", "/git-token", { project, remote });
			if (res.status === 404) return null;
			if (!res.ok) throw new Error(`git-token got HTTP ${res.status}`);
			const body = (await res.json()) as {
				token?: unknown;
				expiresAt?: unknown;
			};
			const exp =
				typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
			if (
				typeof body.token !== "string" ||
				body.token === "" ||
				!Number.isFinite(exp)
			)
				throw new Error("git-token answered without token and expiresAt");
			return { token: body.token, expiresAt: exp };
		},
	};
}

/** What createApp and createTurnLoop receive; undefined (self-host) disables every hook. */
export interface Hosted {
	config: HostedConfig;
	hooks: HostedHooks;
}

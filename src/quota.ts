// Provider usage limits (5 h, 7 d, monthly, ...) as reported by `omp usage --json`.
import type { QuotaLimit, QuotaState } from "./types.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
	typeof v === "object" && v !== null ? (v as Obj) : {};
const num = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

/** Every limit with a usable fraction, in omp's order; throws on output that is not a usage report. */
export function parseUsage(text: string): QuotaLimit[] {
	const reports = obj(JSON.parse(text)).reports;
	if (!Array.isArray(reports))
		throw new Error("omp usage: no reports in output");
	const out: QuotaLimit[] = [];
	for (const r of reports) {
		const provider = obj(r).provider;
		const limits = obj(r).limits;
		if (typeof provider !== "string" || !Array.isArray(limits)) continue;
		out.push(...reportLimits(r, provider, limits));
	}
	return out;
}

// ponytail: two accounts of one provider show as two same-named rows; add the account label if that ever happens.
/** One account's limits, in omp's order, deduplicated by shared window group. */
function reportLimits(
	r: unknown,
	provider: string,
	limits: unknown[],
): QuotaLimit[] {
	const planType = obj(obj(r).metadata).planType;
	const plan =
		typeof planType === "string" && planType !== "" ? planType : null;
	const shared = new Set<string>(); // one pool reported per model family (e.g. Antigravity "Claude & GPT"): show it once
	const rows: QuotaLimit[] = [];
	for (const l of limits) {
		const group = obj(obj(l).scope).sharedGroup;
		if (typeof group === "string") {
			if (shared.has(group)) continue;
			shared.add(group);
		}
		const row = limitRow(l, provider, plan);
		if (row !== null) rows.push(row);
	}
	return rows;
}

/** One limit row, or null when it has no usable fraction. */
function limitRow(
	l: unknown,
	provider: string,
	plan: string | null,
): QuotaLimit | null {
	const a = obj(obj(l).amount);
	const used = num(a.used);
	const cap = num(a.limit);
	const fraction =
		num(a.usedFraction) ??
		(used !== null && cap !== null && cap > 0 ? used / cap : null);
	if (fraction === null) return null;
	const label = obj(l).label;
	const win = obj(obj(l).window);
	return {
		provider,
		label:
			typeof label === "string" && label !== ""
				? label
				: String(win.label ?? "limit"),
		window: typeof win.id === "string" ? win.id : null,
		windowLabel:
			typeof win.label === "string" && win.label !== "" ? win.label : null,
		plan,
		usedPct: Math.round(fraction * 1000) / 10,
		resetsAt: num(win.resetsAt),
	};
}

/** omp provider id of a model selector, e.g. "zai" for "zai/glm-5.3-flash"; null without a slash. */
const providerOf = (model: string | null): string | null =>
	model?.includes("/") ? model.slice(0, model.indexOf("/")) : null;

/** One sign-in provider's windows; a prefix matches families like google -> google-antigravity. */
export const forProvider = (
	limits: QuotaLimit[],
	provider: string,
): QuotaLimit[] =>
	limits.filter(
		(l) => l.provider === provider || l.provider.startsWith(`${provider}-`),
	);

export const tightest = (limits: QuotaLimit[]): QuotaLimit | null =>
	limits.reduce<QuotaLimit | null>(
		(w, l) => (w === null || l.usedPct > w.usedPct ? l : w),
		null,
	);

/** The bar shows the default model provider's tightest window — the one that stops agents first.
 *  Other providers count only when the default is unknown or reports no limits. */
export function tightestFor(
	limits: QuotaLimit[],
	model: string | null,
): QuotaLimit | null {
	const prefix = providerOf(model);
	const mine = prefix === null ? [] : forProvider(limits, prefix);
	return tightest(mine.length > 0 ? mine : limits);
}

/** This model's provider's windows, one row per window id ("5h", "7d", …) with the highest use
 *  kept — it binds first; rows without a window id keep their own row, after the named ones.
 *  Empty when the model has no provider prefix or that provider reports no limits (no fallback
 *  to other providers: it would misread as this model's budget). */
export function forModel(
	limits: QuotaLimit[],
	model: string | null,
): QuotaLimit[] {
	const prefix = providerOf(model);
	const mine = prefix === null ? [] : forProvider(limits, prefix);
	const best = new Map<string, QuotaLimit>();
	const solo: QuotaLimit[] = [];
	for (const l of mine) {
		if (l.window === null) solo.push(l);
		else {
			const kept = best.get(l.window);
			if (kept === undefined || l.usedPct > kept.usedPct) best.set(l.window, l);
		}
	}
	return [...best.values(), ...solo];
}

/** When this model's provider can run again: over its exhausted windows (100% used) with a
 *  future reset, the latest reset (every full window must reset). `window` is that binding
 *  window's id, null when omp names no window. Null when none is known. */
export function usageReset(
	limits: QuotaLimit[],
	model: string | null,
	now: number,
): { provider: string; resetsAt: number; window: string | null } | null {
	let best: {
		provider: string;
		resetsAt: number;
		window: string | null;
	} | null = null;
	for (const l of forModel(limits, model))
		if (
			l.usedPct >= 100 &&
			l.resetsAt !== null &&
			l.resetsAt > now &&
			(best === null || l.resetsAt > best.resetsAt)
		)
			best = { provider: l.provider, resetsAt: l.resetsAt, window: l.window };
	return best;
}

/** The provider's binding exhausted window: 100% used with a future reset, the latest reset
 *  wins. Null when the provider reports no blocking window — every window below 100%, or a
 *  full window whose reset has passed. Pure; the quota refresh uses this to release holds
 *  early (OTTR-688). */
export function providerBlocked(
	limits: QuotaLimit[],
	provider: string,
	now: number,
): QuotaLimit | null {
	let best: { limit: QuotaLimit; resetsAt: number } | null = null;
	for (const l of forProvider(limits, provider))
		if (
			l.usedPct >= 100 &&
			l.resetsAt !== null &&
			l.resetsAt > now &&
			(best === null || l.resetsAt > best.resetsAt)
		)
			best = { limit: l, resetsAt: l.resetsAt };
	return best?.limit ?? null;
}

/** Runs `omp usage --json` with `env` (the board's own omp env, login.ts boardOmpEnv: this
 * module stays free of server imports, the UI bundles it); a failure is a value (error set,
 * no limits), never a throw. */
export async function fetchQuota(
	env: Record<string, string | undefined>,
): Promise<QuotaState> {
	const at = Date.now();
	try {
		// omp caches each account's report for 5 min, so this rarely hits the providers.
		const p = Bun.spawn(["omp", "usage", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
			env,
			windowsHide: true,
			timeout: 30_000,
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (code !== 0)
			return {
				limits: [],
				error: err.trim().split("\n").at(-1) || `omp usage exited with ${code}`,
				at,
			};
		return { limits: parseUsage(out), error: null, at };
	} catch (e) {
		return {
			limits: [],
			error: e instanceof Error ? e.message : String(e),
			at,
		};
	}
}

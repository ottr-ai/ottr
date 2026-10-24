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
	// ponytail: two accounts of one provider show as two same-named rows; add the account label if that ever happens.
	for (const r of reports) {
		const provider = obj(r).provider;
		const limits = obj(r).limits;
		if (typeof provider !== "string" || !Array.isArray(limits)) continue;
		const planType = obj(obj(r).metadata).planType;
		const plan =
			typeof planType === "string" && planType !== "" ? planType : null;
		const shared = new Set<string>(); // one pool reported per model family (e.g. Antigravity "Claude & GPT"): show it once
		for (const l of limits) {
			const group = obj(obj(l).scope).sharedGroup;
			if (typeof group === "string") {
				if (shared.has(group)) continue;
				shared.add(group);
			}
			const a = obj(obj(l).amount);
			const used = num(a.used);
			const cap = num(a.limit);
			const fraction =
				num(a.usedFraction) ??
				(used !== null && cap !== null && cap > 0 ? used / cap : null);
			if (fraction === null) continue;
			const label = obj(l).label;
			const win = obj(obj(l).window);
			out.push({
				provider,
				label:
					typeof label === "string" && label !== ""
						? label
						: String(win.label ?? "limit"),
				window: typeof win.id === "string" ? win.id : null,
				plan,
				usedPct: Math.round(fraction * 1000) / 10,
				resetsAt: num(win.resetsAt),
			});
		}
	}
	return out;
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

/** Runs `omp usage --json`; a failure is a value (error set, no limits), never a throw. */
export async function fetchQuota(): Promise<QuotaState> {
	const at = Date.now();
	try {
		// omp caches each account's report for 5 min, so this rarely hits the providers.
		const p = Bun.spawn(["omp", "usage", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
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

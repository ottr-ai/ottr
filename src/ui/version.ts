/** sessionStorage keys for the stale-tab version handshake (per tab, survive a reload). */
export const SEEN_VERSION_KEY = "ottr.serverVersion";
export const RELOAD_GUARD_KEY = "ottr.reloadedFor";

type ReloadDecision = "reload" | "wait" | "done";

/**
 * Stale-tab handshake: every pushed state frame reports the server's version; when it changes under a
 * running tab, the tab must reload once to pick up the fresh bundle. "wait" retries on the next state
 * push or when the busy UI closes, so a half-typed reply is never lost. `guard` carries the version we
 * already reloaded for (sessionStorage), so the reload can never loop even if the reload lands on a
 * cached old bundle.
 */
export function decideReload(
	seen: string | null,
	next: string,
	idle: boolean,
	guard: string | null,
): ReloadDecision {
	if (seen === null || seen === next) return "done";
	if (!idle) return "wait";
	return guard === next ? "done" : "reload";
}

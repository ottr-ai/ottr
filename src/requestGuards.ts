/**
 * Extra Host values the server answers over HTTPS (e.g. `pc.tail-net.ts.net` via `tailscale serve`).
 * From OMP_TRACKER_PUBLIC_HOSTS, comma/semicolon separated; empty/undefined means no public hosts.
 */
export function publicHosts(): string[] {
	return (process.env.OMP_TRACKER_PUBLIC_HOSTS ?? "")
		.split(/[,;]/)
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

/** Case-insensitive match, accepting the bare and `:443` forms (HTTPS arrives via tailscale serve). */
export function hostMatches(
	host: string,
	candidates: readonly string[],
): boolean {
	const h = host.toLowerCase();
	return candidates.some((c) => h === c || h === `${c}:443`);
}

/** Host header allowlist: loopback plus any configured public host. */
export function hostRefusal(
	host: string | null,
	port: number,
	publics: readonly string[],
): string | null {
	if (host === null) return "forbidden host";
	if (hostMatches(host, [`127.0.0.1:${port}`, `localhost:${port}`, ...publics]))
		return null;
	return "forbidden host";
}

/** Origin allowlist matching hostRefusal: local http origins, https only for public hosts. */
export function originRefusal(
	origin: string | null,
	port: number,
	publics: readonly string[],
): string | null {
	if (origin === null) return "forbidden origin";
	const lowered = origin.toLowerCase();
	if (
		hostMatches(lowered, [
			`http://127.0.0.1:${port}`,
			`http://localhost:${port}`,
		]) ||
		publics.some((p) => lowered === `https://${p}`)
	)
		return null;
	return "forbidden origin";
}

/** Loopback peer addresses only: `::1`, IPv4 loopback, and the IPv4-mapped form. */
export const loopbackIp = (ip: string | undefined) =>
	ip === "::1" ||
	(ip !== undefined && (ip.startsWith("127.") || ip.startsWith("::ffff:127.")));

/**
 * A direct loopback peer: loopback IP and NO proxy headers. tailscale serve forwards from
 * 127.0.0.1 with X-Forwarded-For/-Host set, so those headers mark an external client even
 * when the TCP peer is loopback — the auth wall must treat it as remote.
 */
export function directLoopback(
	ip: string | undefined,
	headers: Headers,
): boolean {
	return (
		loopbackIp(ip) &&
		!headers.has("x-forwarded-for") &&
		!headers.has("x-forwarded-host") &&
		!headers.has("forwarded")
	);
}

/**
 * `upgradeRefusal`: null accepts the WebSocket handshake, otherwise the refusal reason (403; 401
 * for a missing session). A missing Origin is refused: browsers always send it on a WebSocket
 * handshake, and browsers do NOT apply the same-origin policy to WebSockets — this check is the
 * only thing stopping any website from opening ws://127.0.0.1:4747 and reading the whole board
 * (prompts, paths, reports). `authed` is the caller's wall decision: true when the request is
 * either NOT walled (direct loopback with a loopback Host) or carries a valid session. False
 * refuses the handshake (401) before Origin is even checked.
 */
export function upgradeRefusal(
	host: string | null,
	origin: string | null,
	port: number,
	publics: readonly string[],
	authed: boolean,
): string | null {
	const hostR = hostRefusal(host, port, publics);
	if (hostR !== null) return hostR;
	if (!authed) return "unauthorized";
	return originRefusal(origin, port, publics);
}

/** Trailing throttle per key: at most one `fn(latestArg)` per `ms` window per key. */
export function keyedThrottle<A>(
	ms: number,
	fn: (arg: A) => void,
): (key: string, arg: A) => void {
	const pending = new Map<string, A>();
	return (key: string, arg: A): void => {
		if (pending.has(key)) {
			pending.set(key, arg);
			return;
		}
		pending.set(key, arg);
		setTimeout(() => {
			const latest = pending.get(key);
			pending.delete(key);
			if (latest !== undefined) fn(latest);
		}, ms);
	};
}

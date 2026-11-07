import { type VmTokens, vmTokenOf } from "./vmTokens.ts";

/**
 * Request headers that never cross the proxy: hop-by-hop ones (RFC 9110 §7.6.1), the board's
 * own host, and every credential the caller holds (its VM token, a board token, a cookie);
 * the proxy sets the upstream's bearer itself.
 */
const DROP_REQUEST: Record<string, true> = {
	connection: true,
	"keep-alive": true,
	"proxy-authenticate": true,
	"proxy-authorization": true,
	te: true,
	trailer: true,
	"transfer-encoding": true,
	upgrade: true,
	host: true,
	"content-length": true,
	authorization: true,
	"x-board-token": true,
	"x-api-key": true,
	cookie: true,
};

/** Response headers that describe the upstream hop, not the body this proxy streams on. */
const DROP_RESPONSE: Record<string, true> = {
	connection: true,
	"keep-alive": true,
	"proxy-authenticate": true,
	te: true,
	trailer: true,
	"transfer-encoding": true,
	upgrade: true,
	"content-length": true,
	"content-encoding": true,
	"set-cookie": true,
};

function filtered(
	from: Headers,
	drop: Record<string, true>,
	extra: Headers | null,
): Headers {
	// Connection may name further per-hop headers.
	const named = (from.get("connection") ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase());
	const out = new Headers();
	for (const [name, value] of from) {
		if (drop[name] !== true && !named.includes(name)) out.append(name, value);
	}
	if (extra !== null) for (const [name, value] of extra) out.set(name, value);
	return out;
}

const text = (body: string, status: number) =>
	new Response(`${body}\n`, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});

/**
 * Forwards `req` to `upstream` + the path after `prefix` + the query, streaming the body both
 * ways (an SSE answer reaches the caller chunk by chunk). `bearer` replaces the caller's
 * credentials; "" sends none (an upstream without auth).
 */
export async function proxyTo(
	req: Request,
	o: { upstream: string; bearer: string; prefix: string },
): Promise<Response> {
	const url = new URL(req.url);
	if (!url.pathname.startsWith(o.prefix)) return text("not found", 404);
	const rest = url.pathname.slice(o.prefix.length);
	if (rest !== "" && !rest.startsWith("/")) return text("not found", 404);
	const target = `${o.upstream.replace(/\/+$/, "")}${rest}${url.search}`;
	const set = new Headers();
	if (o.bearer !== "") set.set("authorization", `Bearer ${o.bearer}`);
	// Identity: fetch would inflate a compressed answer, and the caller must not inflate it twice.
	set.set("accept-encoding", "identity");
	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	let res: Response;
	try {
		res = await fetch(target, {
			method: req.method,
			headers: filtered(req.headers, DROP_REQUEST, set),
			body: hasBody ? req.body : undefined,
			// Streams the request body instead of buffering it first.
			duplex: "half",
			redirect: "manual",
			// The caller hanging up cancels the upstream call (and its model spend).
			signal: req.signal,
		} as RequestInit);
	} catch (err) {
		if (req.signal.aborted) return text("client closed the request", 499);
		return text(`upstream unreachable: ${String(err)}`, 502);
	}
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: filtered(res.headers, DROP_RESPONSE, null),
	});
}

/** VM provider traffic: `/llm/*` → the board's local auth-gateway, which holds the credentials. */
export function handleLlm(
	req: Request,
	o: { tokens: VmTokens; gateway: { url: string; token: string } | null },
): Promise<Response> {
	if (o.tokens.check(vmTokenOf(req)) === null)
		return Promise.resolve(text("unauthorized", 401));
	if (o.gateway === null)
		return Promise.resolve(text("the board's LLM gateway is not running", 503));
	return proxyTo(req, {
		upstream: o.gateway.url,
		bearer: o.gateway.token,
		prefix: "/llm",
	});
}

/** VM memory traffic: `/hindsight/*` → HINDSIGHT_API_URL with the board's Hindsight token. */
export function handleHindsight(
	req: Request,
	o: { tokens: VmTokens; url: string | undefined; token: string | undefined },
): Promise<Response> {
	if (o.tokens.check(vmTokenOf(req)) === null)
		return Promise.resolve(text("unauthorized", 401));
	if (!o.url)
		return Promise.resolve(
			text("Hindsight is not configured on the board", 503),
		);
	return proxyTo(req, {
		upstream: o.url,
		bearer: o.token ?? "",
		prefix: "/hindsight",
	});
}

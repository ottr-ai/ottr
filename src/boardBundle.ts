// Board UI bundle, built once per process and served from memory with
// precompressed brotli/gzip variants (docs/specs/compressed-serving.md).
// Replaces Bun's HTML-import route in production; dev keeps Bun's HTML dev
// server and never calls into this module.
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** One servable output: bytes per encoding variant, content type, per-variant ETags. */
export interface BundleAsset {
	contentType: string;
	cacheControl: string;
	identity: Uint8Array<ArrayBuffer>;
	/** Precompressed bytes; null for outputs that are never compressed (binaries). */
	gzip: Uint8Array<ArrayBuffer> | null;
	br: Uint8Array<ArrayBuffer> | null;
	// gzip/br and their ETags are null together (binary outputs never vary).
	etags: { identity: string; gzip: string | null; br: string | null };
}

export interface BoardBundle {
	html: BundleAsset;
	/** Hashed outputs by URL path ("/chunk-….js"). */
	assets: Map<string, BundleAsset>;
}

let memo: BoardBundle | null = null;
let building: Promise<BoardBundle> | null = null;

/** The memoized bundle; concurrent callers share one build. A failed build resets, so a later request retries. */
export function boardBundle(): Promise<BoardBundle> {
	if (memo !== null) return Promise.resolve(memo);
	building ??= buildBoard().catch((err) => {
		building = null;
		throw err;
	});
	return building;
}

async function buildBoard(): Promise<BoardBundle> {
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, "ui", "index.html")],
		minify: true,
	});
	if (!built.success)
		throw new Error(`ui bundle failed: ${built.logs.map(String).join("; ")}`);
	const assets = new Map<string, BundleAsset>();
	let html: BundleAsset | null = null;
	for (const out of built.outputs) {
		// Bun.build emits relative names ("./chunk-x.js"); serve at the root so the
		// nested client routes resolve them (rewriteBundleHtml does the HTML side).
		const name = out.path.replace(/^\.\//, "");
		if (name.includes("/") || name.includes("\\"))
			throw new Error(`ui bundle emitted a nested path: ${out.path}`);
		const bytes = new Uint8Array(await out.arrayBuffer());
		// The board serves the HTML at /projects/p/tasks/i and friends, so the built
		// refs must be absolute before any variant of it is compressed.
		const identity =
			name === "index.html"
				? textEncoder.encode(rewriteBundleHtml(textDecoder.decode(bytes)))
				: bytes;
		const compressible = /\.(html|js|css)$/.test(name);
		// Variant suffixes stay inside the quotes: an ETag must be one opaque tag.
		const hex = Bun.hash(identity).toString(16).padStart(16, "0");
		const asset: BundleAsset = {
			contentType: out.type ?? "application/octet-stream",
			cacheControl: name === "index.html" ? NO_CACHE : IMMUTABLE_CACHE,
			identity,
			gzip: compressible
				? (gzipSync(identity) as Uint8Array<ArrayBuffer>)
				: null,
			br: compressible
				? (brotliCompressSync(identity) as Uint8Array<ArrayBuffer>)
				: null,
			etags: {
				identity: `"${hex}"`,
				gzip: compressible ? `"${hex}-gzip"` : null,
				br: compressible ? `"${hex}-br"` : null,
			},
		};
		if (name === "index.html") {
			html = asset;
			continue; // The html serves by route; the fallback map holds hashed outputs only.
		}
		assets.set(`/${name}`, asset);
	}
	if (html === null) throw new Error("ui bundle produced no index.html");
	memo = { html, assets };
	return memo;
}

/** `./x` refs to `/x`: the board serves at /projects/p/tasks/i and friends too. */
export function rewriteBundleHtml(html: string): string {
	return html.replace(/((?:src|href)=")\.\//g, "$1/");
}

/** One parsed Accept-Encoding member. */
interface AcceptedEncoding {
	name: string;
	q: number;
}

/** Parse an Accept-Encoding header into members; a missing q means 1, an unparsable or negative one excludes. */
export function parseAcceptEncoding(
	header: string | null | undefined,
): AcceptedEncoding[] {
	if (header === null || header === undefined) return [];
	const out: AcceptedEncoding[] = [];
	for (const part of header.split(",")) {
		const [rawName, ...params] = part.trim().split(";");
		const name = (rawName ?? "").trim().toLowerCase();
		if (name === "") continue;
		let q = 1;
		for (const param of params) {
			const m = /^\s*q=\s*(\S+)\s*$/i.exec(param);
			if (m === null) continue;
			const v = Number.parseFloat(m[1] ?? "");
			q = Number.isFinite(v) && v >= 0 ? Math.min(v, 1) : 0;
		}
		out.push({ name, q });
	}
	return out;
}

// The acceptance test is shared between encodingFor (bundle responses) and
// acceptsGzip (json responses) on purpose: the spec's negotiation rule must stay
// in lockstep across both paths.
function accepts(
	header: string | null | undefined,
	name: "gzip" | "br",
): boolean {
	return parseAcceptEncoding(header).some((a) => a.name === name && a.q > 0);
}

/** The coding to send for a compressed asset: brotli first, then gzip, else identity. `*` never selects. */
export function encodingFor(
	header: string | null | undefined,
): "br" | "gzip" | "identity" {
	if (accepts(header, "br")) return "br";
	if (accepts(header, "gzip")) return "gzip";
	return "identity";
}

/** Does the client accept gzip for json()? */
export function acceptsGzip(header: string | null | undefined): boolean {
	return accepts(header, "gzip");
}

/** The matched ETag for an If-None-Match list, or null: any variant's etag revalidates, `*` falls back to the selected one. */
function revalidated(
	inm: string,
	asset: BundleAsset,
	fallback: string,
): string | null {
	const variants = [asset.etags.identity, asset.etags.gzip, asset.etags.br];
	for (const candidate of inm.split(",")) {
		const c = candidate.trim().replace(/^W\//i, "");
		if (c === "*") return fallback;
		const hit = variants.find(
			(t) => t !== null && t.replace(/^W\//i, "") === c,
		);
		if (hit !== undefined) return hit;
	}
	return null;
}

/** One bundle response: encoding negotiation, 304 on If-None-Match, per-variant ETag. */
export function bundleResponse(asset: BundleAsset, req: Request): Response {
	const { gzip, br, etags } = asset;
	if (
		gzip === null ||
		br === null ||
		etags.gzip === null ||
		etags.br === null
	) {
		// Binary output: identity only, never varies by encoding.
		return servedAsset(
			asset,
			"identity",
			asset.identity,
			etags.identity,
			{},
			req,
		);
	}
	const vary = { Vary: "Accept-Encoding" };
	const enc = encodingFor(req.headers.get("accept-encoding"));
	if (enc === "br") return servedAsset(asset, "br", br, etags.br, vary, req);
	if (enc === "gzip")
		return servedAsset(asset, "gzip", gzip, etags.gzip, vary, req);
	return servedAsset(
		asset,
		"identity",
		asset.identity,
		etags.identity,
		vary,
		req,
	);
}

/** One decided variant: body bytes, its ETag, 304 on a matching If-None-Match. */
function servedAsset(
	asset: BundleAsset,
	enc: "br" | "gzip" | "identity",
	body: Uint8Array<ArrayBuffer>,
	etag: string,
	vary: Record<string, string>,
	req: Request,
): Response {
	const headers: Record<string, string> = {
		"Content-Type": asset.contentType,
		"Cache-Control": asset.cacheControl,
		ETag: etag,
		...vary,
	};
	const inm = req.headers.get("if-none-match");
	const hit = inm !== null ? revalidated(inm, asset, etag) : null;
	if (hit !== null) {
		return new Response(null, {
			status: 304,
			headers: { ...headers, ETag: hit },
		});
	}
	if (enc !== "identity") headers["Content-Encoding"] = enc;
	return new Response(body, { headers });
}

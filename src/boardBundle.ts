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

/** One servable output plus its URL-keyed name. */
interface BuiltAsset {
	name: string;
	asset: BundleAsset;
}

/** One staged output: the bundler's bytes and name, plus the text outputs'
 * rewrite in progress. `served` starts at the bundler name and moves to a
 * content-derived name when the rewrites change the bytes. */
interface Staged {
	name: string;
	served: string;
	/** Text outputs (html, js, css): the rewritten stage string. Binary: null. */
	text: string | null;
	/** The bundler's own bytes, before any rewrite. */
	raw: Uint8Array<ArrayBuffer>;
	contentType: string;
}

/** The URL name of one output: Bun.build emits relative paths ("./chunk-x.js"); a
 * nested path cannot serve from the root asset map. */
function outputName(outPath: string): string {
	const name = outPath.replace(/^\.\//, "");
	if (name.includes("/") || name.includes("\\"))
		throw new Error(`ui bundle emitted a nested path: ${outPath}`);
	return name;
}

/** Relative refs the bundler emits inside js/css for code imports
 * ("./icon-192-<hash>.png"): the browser would resolve them against the page
 * URL, and the board serves nested client routes, so every emitted asset name
 * must appear root-absolute (rewriteBundleHtml does the html side; OTTR-756). */
function absolutizeAssetRefs(text: string, names: string[]): string {
	let out = text;
	for (const name of names) {
		out = out
			.split(`"./${name}"`)
			.join(`"/${name}"`)
			.split(`'./${name}'`)
			.join(`'/${name}'`)
			.split(`(./${name})`)
			.join(`(/${name})`);
	}
	return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** A content-derived URL name for one output: when the rewrites change an
 * output's bytes, Bun's pre-rewrite hash in the bundler name no longer
 * describes the content, and the old copy lives on in `immutable` browser
 * caches forever. The new name carries the hash of the final bytes (the ETag
 * hex), so a deploy that changes the bytes changes the URL and stale caches
 * re-fetch (OTTR-756). */
function contentName(name: string, bytes: Uint8Array): string {
	const dot = name.lastIndexOf(".");
	const hex = Bun.hash(bytes).toString(16).padStart(16, "0");
	return `${name.slice(0, dot)}-${hex}${name.slice(dot)}`;
}

/** Refs to one output inside text outputs: the quoted root-absolute forms
 * rewriteBundleHtml and absolutizeAssetRefs produce, plus css url(). */
function replaceNameRefs(text: string, from: string, to: string): string {
	return text
		.split(`"${from}"`)
		.join(`"${to}"`)
		.split(`'${from}'`)
		.join(`'${to}'`)
		.split(`(${from})`)
		.join(`(${to})`);
}

/** Convert one staged output into a servable asset under its served name. */
function stagedAsset(s: Staged): BuiltAsset {
	const identity = s.text === null ? s.raw : textEncoder.encode(s.text);
	const compressible = /\.(html|js|css)$/.test(s.served);
	// Variant suffixes stay inside the quotes: an ETag must be one opaque tag.
	const hex = Bun.hash(identity).toString(16).padStart(16, "0");
	const asset: BundleAsset = {
		contentType: s.contentType,
		cacheControl: s.name === "index.html" ? NO_CACHE : IMMUTABLE_CACHE,
		identity,
		gzip: compressible ? (gzipSync(identity) as Uint8Array<ArrayBuffer>) : null,
		br: compressible
			? (brotliCompressSync(identity) as Uint8Array<ArrayBuffer>)
			: null,
		etags: {
			identity: `"${hex}"`,
			gzip: compressible ? `"${hex}-gzip"` : null,
			br: compressible ? `"${hex}-br"` : null,
		},
	};
	return { name: s.served, asset };
}

async function buildBoard(): Promise<BoardBundle> {
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, "ui", "index.html")],
		minify: true,
	});
	if (!built.success)
		throw new Error(`ui bundle failed: ${built.logs.map(String).join("; ")}`);
	const names = built.outputs.map((out) => outputName(out.path));
	// Stage 1: the bundler's bytes plus the first rewrites. The board serves the
	// HTML at /projects/p/tasks/i and friends, so all built refs must be
	// absolute before any variant is compressed.
	const staged: Staged[] = [];
	for (const out of built.outputs) {
		const name = outputName(out.path);
		const raw = new Uint8Array(await out.arrayBuffer());
		const text =
			name === "index.html"
				? rewriteBundleHtml(textDecoder.decode(raw))
				: /\.(js|css)$/.test(name)
					? absolutizeAssetRefs(textDecoder.decode(raw), names)
					: null;
		staged.push({
			name,
			served: name,
			text,
			raw,
			contentType: out.type ?? "application/octet-stream",
		});
	}
	// Stage 2: an output whose bytes the rewrites changed gets a content-derived
	// name, and every text output's refs move to it. Names are recomputed until
	// they match the bytes — a rename changes the referencing outputs' bytes too
	// — and the rounds bound a pathological rename cascade.
	for (let round = 0; round < 4; round++) {
		const renames: [string, string][] = [];
		for (const s of staged) {
			// The html serves by route with no-cache, so its bytes never need a name.
			if (s.text === null || s.name === "index.html") continue;
			const bytes = textEncoder.encode(s.text);
			if (bytesEqual(bytes, s.raw)) continue;
			const renamed = contentName(s.name, bytes);
			if (renamed !== s.served) renames.push([s.served, renamed]);
			s.served = renamed;
		}
		if (renames.length === 0) break;
		for (const s of staged) {
			if (s.text === null) continue;
			for (const [from, to] of renames)
				s.text = replaceNameRefs(s.text, `/${from}`, `/${to}`);
		}
	}
	const assets = new Map<string, BundleAsset>();
	let html: BundleAsset | null = null;
	for (const s of staged) {
		const { name, asset } = stagedAsset(s);
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

/** The q from one member's `;` params: a missing q means 1, an unparsable or negative one means 0. */
function qValue(params: string[]): number {
	let q = 1;
	for (const param of params) {
		const m = /^\s*q=\s*(\S+)\s*$/i.exec(param);
		if (m === null) continue;
		const v = Number.parseFloat(m[1] ?? "");
		q = Number.isFinite(v) && v >= 0 ? Math.min(v, 1) : 0;
	}
	return q;
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
		out.push({ name, q: qValue(params) });
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

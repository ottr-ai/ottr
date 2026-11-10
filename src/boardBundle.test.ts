// docs/specs/compressed-serving.md: the boot-built bundle serves identically from
// br, gzip and identity, with the pre-change cache headers plus the encoding headers.
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
	acceptsGzip,
	type BoardBundle,
	boardBundle,
	bundleResponse,
	encodingFor,
	parseAcceptEncoding,
	rewriteBundleHtml,
} from "./boardBundle.ts";
import fc from "./test/properties.ts";

const bundle: BoardBundle = await boardBundle();

/** Asset URL for the hashed output with the given extension; asserts exactly one exists. */
function assetPath(ext: string): string {
	const hits = [...bundle.assets.keys()].filter((p) => p.endsWith(`.${ext}`));
	expect(hits.length, `one .${ext} output`).toBe(1);
	return hits[0]!;
}

const srv = Bun.serve({
	port: 0,
	routes: { "/": (req: Request) => bundleResponse(bundle.html, req) },
	fetch: (req: Request) => {
		const a = bundle.assets.get(new URL(req.url).pathname);
		if (a === undefined) return new Response("nf", { status: 404 });
		return bundleResponse(a, req);
	},
});
const url = (path: string) => new URL(path, srv.url).href;

/** The fetch client auto-decompresses, so the body arrives as identity bytes; the precompressed variants' own bytes are checked in the round-trip test below. */
async function decoded(res: Response): Promise<Uint8Array> {
	return new Uint8Array(await res.arrayBuffer());
}

describe("board bundle", () => {
	const html = new TextDecoder().decode(bundle.html.identity);

	test("html refs are absolute, so nested client routes resolve assets", () => {
		expect(html).not.toContain('="./');
		expect(html).toMatch(/(?:src|href)="\/(chunk|manifest|icon)-/);
	});

	test("code-imported asset refs in the js/css outputs are root-absolute too", () => {
		// The bundler emits a code import ("import logo from './icon-192.png'") as a
		// relative string ("./icon-192-<hash>.png") inside the js chunk; the browser
		// would resolve it against the page URL, which breaks every nested route
		// (OTTR-756). No emitted asset name may appear in a relative ref form.
		const names = [...bundle.assets.keys()].map((p) => p.slice(1));
		for (const [path, asset] of bundle.assets) {
			if (!/\.(js|css)$/.test(path)) continue;
			const text = new TextDecoder().decode(asset.identity);
			for (const name of names) {
				expect(text.includes(`"./${name}"`), `${path} holds "./${name}"`).toBe(
					false,
				);
				expect(text.includes(`'./${name}'`), `${path} holds './${name}'`).toBe(
					false,
				);
				expect(text.includes(`(./${name})`), `${path} holds (./${name})`).toBe(
					false,
				);
			}
		}
	});

	test("assets hold the hashed js, css and binaries; the html serves by route only", () => {
		expect([...bundle.assets.keys()].some((p) => /chunk-.*\.js$/.test(p))).toBe(
			true,
		);
		expect(
			[...bundle.assets.keys()].some((p) => /chunk-.*\.css$/.test(p)),
		).toBe(true);
		expect(bundle.assets.has("/index.html")).toBe(false);
	});

	test("the html asset carries the no-cache headers the import route sent", () => {
		expect(bundle.html.cacheControl).toBe("no-cache");
		expect(bundle.html.contentType).toBe("text/html;charset=utf-8");
	});

	describe("decode equality across encodings", () => {
		const cases: [string, string, string][] = [
			["/", "text/html;charset=utf-8", "no-cache"],
			[
				assetPath("js"),
				"text/javascript;charset=utf-8",
				"public, max-age=31536000, immutable",
			],
			[
				assetPath("css"),
				"text/css;charset=utf-8",
				"public, max-age=31536000, immutable",
			],
		];
		for (const [path, contentType, cacheControl] of cases) {
			for (const [accept, expectedCe] of [
				["identity", null],
				["gzip", "gzip"],
				["br", "br"],
				["br, gzip", "br"],
				["deflate", null],
				["*", null],
				["gzip;q=0, br", "br"],
				["br;q=0, gzip", "gzip"],
			] as const) {
				test(`${path} Accept-Encoding: ${accept}`, async () => {
					const res = await fetch(url(path), {
						headers: { "Accept-Encoding": accept },
					});
					expect(res.status).toBe(200);
					const body = await decoded(res);
					expect(res.headers.get("content-encoding")).toBe(expectedCe);
					expect(res.headers.get("content-type")).toBe(contentType);
					expect(res.headers.get("cache-control")).toBe(cacheControl);
					expect(res.headers.get("vary")).toBe("Accept-Encoding");
					expect(res.headers.get("etag")).toMatch(
						/^"(?:[0-9a-f]{16})(?:-gzip|-br)?"$/,
					);
					// The client's decoded view is byte-identical to the built output.
					const expected =
						path === "/"
							? bundle.html.identity
							: bundle.assets.get(path)!.identity;
					expect([...body]).toEqual([...expected]);
				});
			}
		}
	});

	test("the precompressed variants decode to the identity bytes", () => {
		const all = [bundle.html, ...bundle.assets.values()];
		for (const asset of all) {
			if (asset.gzip === null) {
				expect(asset.br).toBeNull();
				continue;
			}
			expect([...gunzipSync(asset.gzip)]).toEqual([...asset.identity]);
			expect([...brotliDecompressSync(asset.br!)]).toEqual([...asset.identity]);
		}
		// The big outputs compress for real (a pass-through would defeat the card).
		expect(bundle.assets.get(assetPath("js"))!.gzip!.length).toBeLessThan(
			bundle.assets.get(assetPath("js"))!.identity.length,
		);
	});

	test("binary assets never compress: identity under every Accept-Encoding", async () => {
		const png = assetPath("png");
		const asset = bundle.assets.get(png)!;
		expect(asset.gzip).toBeNull();
		for (const accept of ["br, gzip", "gzip", "identity"]) {
			const res = await fetch(url(png), {
				headers: { "Accept-Encoding": accept },
			});
			expect(res.headers.get("content-encoding")).toBeNull();
			expect(res.headers.get("vary")).toBeNull();
			const bytes = new Uint8Array(await res.arrayBuffer());
			expect([...bytes]).toEqual([...asset.identity]);
		}
	});

	describe("304 revalidation", () => {
		for (const path of ["/", assetPath("js")]) {
			test(`${path}: matching etag answers 304, wrong etag serves 200`, async () => {
				const first = await fetch(url(path), {
					headers: { "Accept-Encoding": "br, gzip" },
				});
				const etag = first.headers.get("etag")!;
				await first.body?.cancel();
				const revalidate = await fetch(url(path), {
					headers: {
						"Accept-Encoding": "br, gzip",
						"If-None-Match": etag,
					},
				});
				expect(revalidate.status).toBe(304);
				expect(await revalidate.text()).toBe("");
				expect(revalidate.headers.get("etag")).toBe(etag);
				expect(revalidate.headers.get("content-encoding")).toBeNull();
				const fresh = await fetch(url(path), {
					headers: {
						"Accept-Encoding": "br, gzip",
						"If-None-Match": '"0000000000000000"',
					},
				});
				expect(fresh.status).toBe(200);
				await fresh.body?.cancel();
			});

			test(`${path}: list, weak prefix and * all revalidate`, async () => {
				const first = await fetch(url(path), {
					headers: { "Accept-Encoding": "gzip" },
				});
				const etag = first.headers.get("etag")!;
				await first.body?.cancel();
				for (const inm of [`"other", ${etag}`, `W/${etag}`, "*"]) {
					const res = await fetch(url(path), {
						headers: { "Accept-Encoding": "gzip", "If-None-Match": inm },
					});
					expect(res.status, `If-None-Match: ${inm}`).toBe(304);
					await res.body?.cancel();
				}
			});
		}

		test("the gzip variant carries its own etag and revalidates separately", async () => {
			const identity = await fetch(url("/"), {
				headers: { "Accept-Encoding": "identity" },
			});
			const identityEtag = identity.headers.get("etag")!;
			await identity.body?.cancel();
			const gzip = await fetch(url("/"), {
				headers: { "Accept-Encoding": "gzip" },
			});
			const gzipEtag = gzip.headers.get("etag")!;
			await gzip.body?.cancel();
			expect(gzipEtag).toBe(`"${identityEtag.slice(1, -1)}-gzip"`);
			const again = await fetch(url("/"), {
				headers: { "Accept-Encoding": "gzip", "If-None-Match": gzipEtag },
			});
			expect(again.status).toBe(304);
			await again.body?.cancel();
		});
	});
});

describe("accept-encoding parsing", () => {
	test("explicit cases", () => {
		expect(encodingFor(null)).toBe("identity");
		expect(encodingFor(undefined)).toBe("identity");
		expect(encodingFor("")).toBe("identity");
		expect(encodingFor("deflate")).toBe("identity");
		expect(encodingFor("*")).toBe("identity");
		expect(encodingFor("br")).toBe("br");
		expect(encodingFor("gzip")).toBe("gzip");
		// "BRAIN" is not "br": unknown tokens are ignored, gzip answers.
		expect(encodingFor("BRAIN; q=0.1, GZIP")).toBe("gzip");
		expect(encodingFor("gzip;q=0, br")).toBe("br");
		expect(encodingFor("br;q=0, gzip")).toBe("gzip");
		expect(encodingFor("br ; q=0.001 , gzip ; q=0.5")).toBe("br");
		expect(encodingFor("br;q=0, gzip;q=0")).toBe("identity");
		expect(encodingFor("gzip;q=oops")).toBe("identity");
		expect(encodingFor("gzip;q=-1")).toBe("identity");
		expect(encodingFor("gzip;q=2")).toBe("gzip");
		expect(acceptsGzip("br")).toBe(false);
		expect(acceptsGzip("gzip;q=0")).toBe(false);
		expect(acceptsGzip("br, gzip")).toBe(true);
		expect(parseAcceptEncoding(", ;q=1, br")).toEqual([{ name: "br", q: 1 }]);
	});

	// Gate: 200 runs, fixed seed. The reference parses independently so the two
	// implementations must agree on arbitrary header text.
	test("properties: negotiation agrees with an independent reference", async () => {
		const tokens = [
			"br",
			"gzip",
			"deflate",
			"zstd",
			"*",
			"",
			"br;q=0",
			"gzip; Q=0.4",
			"br;q=1.0",
			" gzip ",
			"Brotli",
			"gzip;q=nonsense",
			"gzip;q=0.9999",
			"br;;q=0",
		];
		await fc.assert(
			fc.property(
				fc.array(fc.constantFrom(...tokens), { maxLength: 8 }),
				(parts) => {
					const header = parts.join(",");
					const accepted = (name: string) =>
						header.split(",").some((part) => {
							const [n, ...params] = part.trim().split(";");
							if ((n ?? "").trim().toLowerCase() !== name) return false;
							const qParam = params.find((p) => /^\s*q\s*=/i.test(p));
							if (qParam === undefined) return true;
							const v = Number.parseFloat(
								qParam.slice(qParam.indexOf("=") + 1),
							);
							return Number.isFinite(v) && v > 0;
						});
					const expected = accepted("br")
						? "br"
						: accepted("gzip")
							? "gzip"
							: "identity";
					expect(encodingFor(header)).toBe(expected);
					expect(acceptsGzip(header)).toBe(accepted("gzip"));
				},
			),
		);
	});

	test("properties: arbitrary header text never throws", async () => {
		await fc.assert(
			fc.property(fc.string(), fc.string(), (header, mut) => {
				const enc = encodingFor(
					mut.length % 3 === 0 ? header : `${header};q=1`,
				);
				expect(["br", "gzip", "identity"]).toContain(enc);
				expect(
					parseAcceptEncoding(header).every((a) => a.q >= 0 && a.q <= 1),
				).toBe(true);
			}),
		);
	});
});

describe("rewriteBundleHtml", () => {
	test("rewrites relative src/href only", () => {
		const rewritten = rewriteBundleHtml(
			'<script src="./a.js"></script><link href="./b.css"><img src="/keep.png" href="./x">',
		);
		expect(rewritten).toBe(
			'<script src="/a.js"></script><link href="/b.css"><img src="/keep.png" href="/x">',
		);
	});
});

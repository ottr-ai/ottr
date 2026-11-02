import { describe, expect, test } from "bun:test";
import {
	createHash,
	createPublicKey,
	verify as cryptoVerify,
	generateKeyPairSync,
} from "node:crypto";
import {
	AppTokenSource,
	appCheckWarning,
	checkAppInstalls,
	parseAppPem,
	signAppJwt,
	validateAppCredentials,
} from "./githubApp.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
const privatePem = privateKey
	.export({ format: "pem", type: "pkcs8" })
	.toString();

const { privateKey: edKey } = generateKeyPairSync("ed25519");
const edPem = edKey.export({ format: "pem", type: "pkcs8" }).toString();

const spkiDer = createPublicKey(privateKey).export({
	format: "der",
	type: "spki",
});
const expectedFingerprint =
	"SHA256:" +
	createHash("sha256").update(spkiDer).digest("base64").replace(/=+$/, "");

function b64json(part: string): unknown {
	return JSON.parse(Buffer.from(part, "base64url").toString());
}

function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

describe("signAppJwt", () => {
	test("header, claims and signature follow the JWT shape", () => {
		const now = 1_700_000_000_000;
		const { jwt, iat, exp } = signAppJwt("1234", privateKey, now);
		const [h, p, s] = jwt.split(".");
		expect(b64json(h!)).toEqual({ alg: "RS256", typ: "JWT" });
		expect(b64json(p!)).toEqual({ iat, exp, iss: "1234" });
		expect(iat).toBe(1_700_000_000 - 60);
		expect(exp).toBe(iat + 600);
		expect(exp - iat).toBeLessThanOrEqual(600);
		expect(exp).toBeLessThan(Date.now() / 1000 + 660);
		const signed = Buffer.from(`${h}.${p}`);
		const sig = Buffer.from(s!, "base64url");
		expect(
			cryptoVerify("RSA-SHA256", signed, createPublicKey(publicPem), sig),
		).toBe(true);
	});

	test("a tampered payload fails verification", () => {
		const { jwt } = signAppJwt("1234", privateKey, 1_700_000_000_000);
		const parts = jwt.split(".");
		const forged = Buffer.from(
			JSON.stringify({ iat: 1, exp: 2, iss: "999" }),
		).toString("base64url");
		const sig = Buffer.from(parts[2]!, "base64url");
		const ok = cryptoVerify(
			"RSA-SHA256",
			Buffer.from(`${parts[0]}.${forged}`),
			createPublicKey(publicPem),
			sig,
		);
		expect(ok).toBe(false);
	});
});

describe("parseAppPem", () => {
	test("returns a deterministic unpadded SHA256 fingerprint", () => {
		const a = parseAppPem(privatePem)!;
		const b = parseAppPem(`  ${privatePem}  `)!;
		expect(a.fingerprint.startsWith("SHA256:")).toBe(true);
		expect(a.fingerprint).not.toContain("=");
		expect(a.fingerprint).toBe(b.fingerprint);
		expect(a.fingerprint).toBe(expectedFingerprint);
	});

	test("garbage input gives null", () => {
		expect(parseAppPem("not a key")).toBeNull();
		expect(
			parseAppPem(
				"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
			),
		).toBeNull();
	});

	test("an Ed25519 key gives null", () => {
		expect(parseAppPem(edPem)).toBeNull();
	});
});

describe("validateAppCredentials", () => {
	test("accepts a good pair", () => {
		const r = validateAppCredentials({ id: "1234", key: privatePem });
		expect(r).toEqual({
			id: "1234",
			key: privatePem,
			fingerprint: expectedFingerprint,
		});
	});

	test("rejects a bad or non-string id with the exact error", () => {
		const err = { error: "app id must be the numeric GitHub App ID" };
		expect(validateAppCredentials({ id: "12a", key: privatePem })).toEqual(err);
		expect(validateAppCredentials({ id: 1234, key: privatePem })).toEqual(err);
	});

	test("rejects a garbage key with the exact error", () => {
		expect(validateAppCredentials({ id: "1234", key: "garbage" })).toEqual({
			error: "the private key must be a PEM RSA private key",
		});
	});
});

type Call = { url: string; init?: RequestInit };

/** Fetch seam that records each call and answers from a scripted list. */
function recordingFetch(responses: Array<Response | { status: number }>) {
	const calls: Call[] = [];
	let i = 0;
	const fetchImpl = async (
		url: string,
		init?: RequestInit,
	): Promise<Response> => {
		calls.push({ url, init });
		const scripted = responses[i++]!;
		if (scripted instanceof Response) return scripted;
		return new Response("{}", { status: scripted.status });
	};
	return { calls, fetchImpl };
}

function makeSource(
	responses: Array<Response | { status: number }>,
	now: () => number = () => NOW,
	apiBase?: string,
) {
	const { calls, fetchImpl } = recordingFetch(responses);
	const source = new AppTokenSource({
		appId: APP_ID,
		keyObject: privateKey,
		apiBase,
		fetchImpl,
		now,
	});
	return { calls, source };
}

function headerOf(call: Call | undefined): Record<string, string> {
	return call?.init?.headers as Record<string, string>;
}

const APP_ID = "1234";
const OWNER = "octo";
const REPO = "widget";
const INSTALL_URL = `https://api.github.com/repos/${OWNER}/${REPO}/installation`;
const TOKEN_URL = "https://api.github.com/app/installations/777/access_tokens";
const INSTALLATION = { id: 777 };
const NOW = 1_700_000_000_000;

describe("AppTokenSource", () => {
	test("happy path: exact URLs, headers and body, returns the token", async () => {
		const token = "ghs_installation_token";
		const { calls, source } = makeSource([
			okResponse(INSTALLATION),
			okResponse({
				token,
				expires_at: new Date(NOW + 50 * 60_000).toISOString(),
			}),
		]);
		expect(await source.tokenFor(OWNER, REPO)).toBe(token);
		expect(calls.length).toBe(2);
		expect(calls[0]!.url).toBe(INSTALL_URL);
		expect(headerOf(calls[0]!).authorization).toMatch(/^Bearer /);
		expect(calls[1]!.url).toBe(TOKEN_URL);
		expect(calls[1]!.init?.method).toBe("POST");
		expect(headerOf(calls[1]!).authorization).toMatch(/^Bearer /);
		expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
			repositories: [REPO],
			permissions: { pull_requests: "write" },
		});
	});

	test("an injected apiBase puts both URLs on that base", async () => {
		const { calls, source } = makeSource(
			[
				okResponse(INSTALLATION),
				okResponse({
					token: "t1",
					expires_at: new Date(NOW + 50 * 60_000).toISOString(),
				}),
			],
			undefined,
			"https://api.acme.ghe.com",
		);
		await source.tokenFor(OWNER, REPO);
		expect(calls[0]!.url).toBe(
			`https://api.acme.ghe.com/repos/${OWNER}/${REPO}/installation`,
		);
		expect(calls[1]!.url).toBe(
			"https://api.acme.ghe.com/app/installations/777/access_tokens",
		);
	});

	test("a cached token serves the second lookup without fetches", async () => {
		const { calls, source } = makeSource([
			okResponse(INSTALLATION),
			okResponse({
				token: "t1",
				expires_at: new Date(NOW + 50 * 60_000).toISOString(),
			}),
		]);
		await source.tokenFor(OWNER, REPO);
		await source.tokenFor(OWNER, REPO);
		expect(calls.length).toBe(2);
	});

	test("a cached token never serves another repo", async () => {
		const fresh = (token: string) =>
			okResponse({
				token,
				expires_at: new Date(NOW + 50 * 60_000).toISOString(),
			});
		const { calls, source } = makeSource([
			okResponse(INSTALLATION),
			fresh("t-widget"),
			okResponse({ id: 888 }),
			fresh("t-gadget"),
		]);
		expect(await source.tokenFor(OWNER, REPO)).toBe("t-widget");
		expect(await source.tokenFor("other", "gadget")).toBe("t-gadget");
		expect(await source.tokenFor(OWNER, REPO)).toBe("t-widget");
		expect(calls.length).toBe(4);
		expect(calls[3]!.url).toBe(
			"https://api.github.com/app/installations/888/access_tokens",
		);
	});

	test("a token expiring within 5 minutes is not cached", async () => {
		let now = NOW;
		const { calls, source } = makeSource(
			[
				okResponse(INSTALLATION),
				okResponse({
					token: "t1",
					expires_at: new Date(NOW + 4 * 60_000).toISOString(),
				}),
				okResponse(INSTALLATION),
				okResponse({
					token: "t2",
					expires_at: new Date(NOW + 50 * 60_000).toISOString(),
				}),
			],
			() => now,
		);
		expect(await source.tokenFor(OWNER, REPO)).toBe("t1");
		now += 1000;
		expect(await source.tokenFor(OWNER, REPO)).toBe("t2");
		expect(calls.length).toBe(4);
	});

	test("a 404 installation resolves null", async () => {
		const { source } = makeSource([{ status: 404 }]);
		expect(await source.tokenFor(OWNER, REPO)).toBeNull();
	});

	test("a 500 installation lookup rejects without leaking the key", async () => {
		const { source } = makeSource([{ status: 500 }]);
		try {
			await source.tokenFor(OWNER, REPO);
			expect.unreachable();
		} catch (e) {
			const message = (e as Error).message;
			expect(message).toContain("500");
			expect(message).not.toContain(privatePem);
		}
	});

	test("a 500 access token call rejects with the status", async () => {
		const { source } = makeSource([okResponse(INSTALLATION), { status: 500 }]);
		try {
			await source.tokenFor(OWNER, REPO);
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).toContain("500");
		}
	});
});

describe("checkAppInstalls", () => {
	const run = (responses: Array<Response | { status: number }>) => {
		const { calls, fetchImpl } = recordingFetch(responses);
		return {
			calls,
			check: checkAppInstalls({
				appId: APP_ID,
				keyObject: privateKey,
				repos: ["octo/a", "octo/b", "skare/c"],
				fetchImpl,
				now: () => NOW,
			}),
		};
	};
	const APP = { name: "ottr-ai", html_url: "https://github.com/apps/ottr-ai" };

	test("reads the name and lists each 404 repo as missing", async () => {
		const { calls, check } = run([
			okResponse(APP),
			okResponse(INSTALLATION),
			{ status: 404 },
			{ status: 404 },
		]);
		expect(await check).toEqual({
			at: NOW,
			name: "ottr-ai",
			url: "https://github.com/apps/ottr-ai",
			repos: ["octo/a", "octo/b", "skare/c"],
			missing: ["octo/b", "skare/c"],
			error: null,
		});
		expect(calls.map((c) => c.url)).toEqual([
			"https://api.github.com/app",
			"https://api.github.com/repos/octo/a/installation",
			"https://api.github.com/repos/octo/b/installation",
			"https://api.github.com/repos/skare/c/installation",
		]);
		expect(headerOf(calls[0]).authorization).toMatch(/^Bearer /);
	});

	test("a failed app lookup stops before the repos", async () => {
		const { calls, check } = run([{ status: 401 }]);
		const c = await check;
		expect(c.error).toBe("app lookup answered 401");
		expect(c.missing).toEqual([]);
		expect(calls.length).toBe(1);
	});

	test("a non-404 repo failure stops with an error and no key", async () => {
		const { check } = run([okResponse(APP), { status: 500 }]);
		const c = await check;
		expect(c.error).toBe("installation lookup for octo/a answered 500");
		expect(JSON.stringify(c)).not.toContain("PRIVATE KEY");
	});

	test("a non-https html_url is dropped", async () => {
		const { check } = run([
			okResponse({ name: "x", html_url: "javascript:alert(1)" }),
			okResponse(INSTALLATION),
			okResponse(INSTALLATION),
			okResponse(INSTALLATION),
		]);
		expect((await check).url).toBeNull();
	});
});

describe("appCheckWarning", () => {
	const base = {
		at: NOW,
		name: "ottr-ai",
		url: "https://github.com/apps/ottr-ai",
		repos: ["octo/a", "octo/b"],
		missing: [] as string[],
		error: null,
	};
	test("no check or no missing repo gives no warning", () => {
		expect(appCheckWarning(null)).toBeNull();
		expect(appCheckWarning(base)).toBeNull();
	});
	test("missing repos name the app, the repos and the install link", () => {
		expect(appCheckWarning({ ...base, missing: ["octo/b"] })).toBe(
			"ottr-ai is not installed on octo/b. PR reviews there post under your own identity. Install it at https://github.com/apps/ottr-ai/installations/new.",
		);
	});
	test("an error wins over missing repos", () => {
		expect(
			appCheckWarning({
				...base,
				missing: ["octo/b"],
				error: "app lookup answered 401",
			}),
		).toContain("The GitHub App check failed (app lookup answered 401)");
	});
});

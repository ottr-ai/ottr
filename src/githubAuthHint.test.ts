import { describe, expect, test } from "bun:test";
import { githubAuthHint } from "./githubAuthHint.ts";

const SAML =
	"Resource protected by organization SAML enforcement. You must grant your Personal Access token access to an organization that has SAML SSO enabled.";
const DOCS = "https://docs.github.com/en/authentication/troubleshooting-saml";

const TOKEN = { host: "acme.ghe.com", username: "x", token: "ghs_tkn123456" };

/** fetchImpl recording the URL and init, answering status with a JSON body. */
function stub(
	status: number,
	body: unknown,
): {
	calls: { url: string; init?: RequestInit }[];
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
} {
	const calls: { url: string; init?: RequestInit }[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify(body), { status });
		},
	};
}

describe("githubAuthHint", () => {
	test("a ghe.com tenant probes api.<host> with the board token and appends the SAML hint", async () => {
		const s = stub(403, { message: SAML, documentation_url: DOCS });
		const hint = await githubAuthHint("https://acme.ghe.com/o/r.git", {
			configuredHost: "acme.ghe.com",
			tokens: [TOKEN],
			envToken: null,
			secrets: [TOKEN.token],
			fetchImpl: s.fetch,
		});
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0]?.url).toBe("https://api.acme.ghe.com/repos/o/r");
		expect(s.calls[0]?.init?.method).toBeUndefined(); // GET is the default
		expect(
			(s.calls[0]?.init?.headers as Record<string, string>)?.Authorization,
		).toBe("Bearer ghs_tkn123456");
		expect((s.calls[0]?.init?.headers as Record<string, string>)?.Accept).toBe(
			"application/vnd.github+json",
		);
		expect(
			(s.calls[0]?.init?.headers as Record<string, string>)?.["User-Agent"],
		).toBe("ottr");
		expect(hint?.startsWith("\nGitHub: Resource protected")).toBe(true);
		expect(hint).toContain(SAML);
		expect(hint).toContain(`\nDocs: ${DOCS}`);
	});

	test("github.com with an empty token list uses GH_TOKEN as the env token", async () => {
		const s = stub(403, { message: SAML });
		const hint = await githubAuthHint("https://github.com/o/r", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: ["ghp_env12345678"],
			fetchImpl: s.fetch,
		});
		expect(s.calls[0]?.url).toBe("https://api.github.com/repos/o/r");
		expect(hint).toContain("SAML");
		expect(hint).not.toContain("Docs:");
	});

	test("an Enterprise Server host probes <host>/api/v3", async () => {
		const s = stub(401, { message: "Bad credentials" });
		const hint = await githubAuthHint("https://git.acme.corp/o/r", {
			configuredHost: "git.acme.corp",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: ["ghp_env12345678"],
			fetchImpl: s.fetch,
		});
		expect(s.calls[0]?.url).toBe("https://git.acme.corp/api/v3/repos/o/r");
		expect(hint).toContain("Bad credentials");
	});

	test("a board token for the remote's host wins over GH_TOKEN", async () => {
		const s = stub(403, { message: SAML });
		await githubAuthHint("https://acme.ghe.com/o/r.git", {
			configuredHost: "github.com",
			tokens: [TOKEN],
			envToken: "ghp_env12345678",
			secrets: [TOKEN.token, "ghp_env12345678"],
			fetchImpl: s.fetch,
		});
		expect(
			(s.calls[0]?.init?.headers as Record<string, string>)?.Authorization,
		).toBe("Bearer ghs_tkn123456");
	});

	test("a non-GitHub host returns null and never fetches", async () => {
		const s = stub(403, { message: SAML });
		const hint = await githubAuthHint("https://gitlab.com/o/r.git", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: [],
			fetchImpl: s.fetch,
		});
		expect(hint).toBeNull();
		expect(s.calls).toHaveLength(0);
	});

	test("an ssh URL returns null", async () => {
		const s = stub(403, { message: SAML });
		const hint = await githubAuthHint("ssh://github.com/o/r.git", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: [],
			fetchImpl: s.fetch,
		});
		expect(hint).toBeNull();
		expect(s.calls).toHaveLength(0);
	});

	test("a three-segment repo path returns null", async () => {
		const s = stub(403, { message: SAML });
		const hint = await githubAuthHint("https://github.com/o/r/extra", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: [],
			fetchImpl: s.fetch,
		});
		expect(hint).toBeNull();
		expect(s.calls).toHaveLength(0);
	});

	test("no token anywhere returns null and never fetches", async () => {
		const s = stub(403, { message: SAML });
		const hint = await githubAuthHint("https://github.com/o/r.git", {
			configuredHost: "github.com",
			tokens: [],
			envToken: null,
			secrets: [],
			fetchImpl: s.fetch,
		});
		expect(hint).toBeNull();
		expect(s.calls).toHaveLength(0);
	});

	test("a 200 answer returns null", async () => {
		const s = stub(200, { message: "ok" });
		const hint = await githubAuthHint("https://github.com/o/r", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: [],
			fetchImpl: s.fetch,
		});
		expect(hint).toBeNull();
	});

	test("a 404 answer returns null", async () => {
		const s = stub(404, { message: "Not Found" });
		const hint = await githubAuthHint("https://github.com/o/r", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: [],
			fetchImpl: s.fetch,
		});
		expect(hint).toBeNull();
	});

	test("a 403 with no usable message returns null", async () => {
		const s = stub(403, { message: "   " });
		const hint = await githubAuthHint("https://github.com/o/r", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: [],
			fetchImpl: s.fetch,
		});
		expect(hint).toBeNull();
	});

	test("a 403 with a non-JSON body returns null", async () => {
		const hint = await githubAuthHint("https://github.com/o/r", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: [],
			fetchImpl: async () => new Response("<html>nope</html>", { status: 403 }),
		});
		expect(hint).toBeNull();
	});

	test("a timeout aborts the probe and returns null", async () => {
		let captured: AbortSignal | undefined;
		const hint = await githubAuthHint("https://github.com/o/r", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: [],
			timeoutMs: 20,
			fetchImpl: (_url, init) => {
				captured = init?.signal ?? undefined;
				return new Promise<Response>(() => {});
			},
		});
		expect(hint).toBeNull();
		expect(captured?.aborted).toBe(true);
	});

	test("a token echoed in GitHub's message comes back redacted", async () => {
		const s = stub(403, {
			message: `Bad credentials: ghp_env12345678 is invalid. ${SAML}`,
		});
		const hint = await githubAuthHint("https://github.com/o/r", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: ["ghp_env12345678"],
			fetchImpl: s.fetch,
		});
		expect(hint).not.toContain("ghp_env12345678");
		expect(hint).toContain("[REDACTED]");
	});

	test("a message longer than 300 characters is capped", async () => {
		const long = "x".repeat(500);
		const s = stub(403, { message: long });
		const hint = await githubAuthHint("https://github.com/o/r", {
			configuredHost: "github.com",
			tokens: [],
			envToken: "ghp_env12345678",
			secrets: [],
			fetchImpl: s.fetch,
		});
		const line = hint?.split("\n").find((l) => l.startsWith("GitHub: "));
		expect(line?.length).toBeLessThanOrEqual("GitHub: ".length + 300);
		expect(hint).not.toContain("x".repeat(301));
	});
});

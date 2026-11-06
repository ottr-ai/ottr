import { afterAll, describe, expect, test } from "bun:test";
import {
	configuredGithubHostname,
	DEFAULT_GITHUB_HOST,
	defaultGitUsername,
	GITHUB_HOST_ENV,
	type GithubHost,
	ghEnvFor,
	githubHost,
	hostMatcher,
	parseGithubHost,
} from "./githubHost.ts";
import fc from "./test/properties.ts";

const host = (raw: string): GithubHost => {
	const parsed = parseGithubHost(raw);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
};

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";

describe("defaultGitUsername", () => {
	const saved = process.env.OTTR_GITHUB_HOST;
	const restore = () => {
		if (saved === undefined) delete process.env.OTTR_GITHUB_HOST;
		else process.env.OTTR_GITHUB_HOST = saved;
	};

	test("github.com uses x-access-token, gitlab.com keeps oauth2", () => {
		try {
			delete process.env.OTTR_GITHUB_HOST;
			expect(defaultGitUsername("github.com", null)).toBe("x-access-token");
			expect(defaultGitUsername("gitlab.com", null)).toBe("oauth2");
			expect(defaultGitUsername("acme.ghe.com", null)).toBe("x-access-token");
			expect(defaultGitUsername("", null)).toBe("oauth2");
		} finally {
			restore();
		}
	});

	test("a host with a port compares by its hostname part", () => {
		expect(defaultGitUsername("github.com:8443", null)).toBe("x-access-token");
	});

	test("case-insensitive on both sides", () => {
		expect(defaultGitUsername("GITHUB.COM", null)).toBe("x-access-token");
		expect(defaultGitUsername("ACME.GHE.COM", null)).toBe("x-access-token");
	});

	test("bare ghe.com and lookalike hosts are not GitHub hosts", () => {
		expect(defaultGitUsername("ghe.com", null)).toBe("oauth2");
		expect(defaultGitUsername("evil-ghe.com", null)).toBe("oauth2");
	});

	test("the configured enterprise host counts as a GitHub host", () => {
		expect(defaultGitUsername("git.acme.com", "git.acme.com")).toBe(
			"x-access-token",
		);
		expect(defaultGitUsername("git.acme.com", null)).toBe("oauth2");
		expect(defaultGitUsername("git.acme.com:8443", "git.acme.com")).toBe(
			"x-access-token",
		);
	});
});

describe("configuredGithubHostname", () => {
	const saved = process.env.OTTR_GITHUB_HOST;

	test("unset or blank means the default, invalid means null", () => {
		const prev = process.env.OTTR_GITHUB_HOST;
		try {
			delete process.env.OTTR_GITHUB_HOST;
			expect(configuredGithubHostname()).toBe("github.com");
			process.env.OTTR_GITHUB_HOST = "  ";
			expect(configuredGithubHostname()).toBe("github.com");
			process.env.OTTR_GITHUB_HOST = "acme.ghe.com";
			expect(configuredGithubHostname()).toBe("acme.ghe.com");
			process.env.OTTR_GITHUB_HOST = "https://x";
			expect(configuredGithubHostname()).toBe(null);
		} finally {
			if (prev === undefined) delete process.env.OTTR_GITHUB_HOST;
			else process.env.OTTR_GITHUB_HOST = prev;
		}
	});

	afterAll(() => {
		if (saved === undefined) delete process.env.OTTR_GITHUB_HOST;
		else process.env.OTTR_GITHUB_HOST = saved;
	});
});

describe("githubHost", () => {
	test("github.com keeps the default shape and GH_TOKEN", () => {
		const h = host(DEFAULT_GITHUB_HOST);
		expect(h).toEqual({
			host: "github.com",
			isDefault: true,
			apiBase: "https://api.github.com",
			webBase: "https://github.com",
		});
		expect(ghEnvFor(h, "t")).toEqual({ GH_TOKEN: "t" });
		expect(ghEnvFor(h, undefined)).toEqual({});
	});

	test("an Enterprise Cloud tenant serves its API on api.<host>", () => {
		const h = host("acme.ghe.com");
		expect(h).toEqual({
			host: "acme.ghe.com",
			isDefault: false,
			apiBase: "https://api.acme.ghe.com",
			webBase: "https://acme.ghe.com",
		});
		expect(ghEnvFor(h, "t")).toEqual({
			GH_HOST: "acme.ghe.com",
			GH_ENTERPRISE_TOKEN: "t",
		});
		expect(ghEnvFor(h, undefined)).toEqual({ GH_HOST: "acme.ghe.com" });
	});

	test("an Enterprise Server host keeps the /api/v3 path", () => {
		expect(host("ghe.example.com")).toEqual({
			host: "ghe.example.com",
			isDefault: false,
			apiBase: "https://ghe.example.com/api/v3",
			webBase: "https://ghe.example.com",
		});
	});

	test("uppercase input is lowercased", () => {
		expect(host("ACME.GHE.Com").host).toBe("acme.ghe.com");
	});

	test("githubHost reads the env; unset or empty means the default", () => {
		expect(githubHost({})).toEqual(host(DEFAULT_GITHUB_HOST));
		expect(githubHost({ [GITHUB_HOST_ENV]: "" })).toEqual(
			host(DEFAULT_GITHUB_HOST),
		);
		expect(githubHost({ [GITHUB_HOST_ENV]: "acme.ghe.com" }).apiBase).toBe(
			"https://api.acme.ghe.com",
		);
		expect(() =>
			githubHost({ [GITHUB_HOST_ENV]: "https://acme.ghe.com" }),
		).toThrow(/OTTR_GITHUB_HOST/);
	});

	test("a scheme, path, port, userinfo, query or whitespace is refused", () => {
		for (const bad of [
			"https://acme.ghe.com",
			"acme.ghe.com/api",
			"acme.ghe.com:8443",
			"git@acme.ghe.com",
			"acme.ghe.com?x=1",
			"acme.ghe.com#f",
			"acme.ghe.com ",
			" acme.ghe.com",
			"acme .ghe.com",
			"",
			"acme..ghe.com",
			".acme.ghe.com",
			"acme.ghe.com.",
			"-acme.ghe.com",
			"acme-.ghe.com",
			"a".repeat(254),
			"acme_ghe.com",
			42,
			null,
			undefined,
		] as unknown[]) {
			expect(parseGithubHost(bad)).toHaveProperty("error");
		}
	});

	test("hostMatcher matches the host at an authority boundary only", () => {
		const m = hostMatcher("acme.ghe.com");
		expect(m.test("git@acme.ghe.com:o/r.git")).toBeTrue();
		expect(m.test("https://acme.ghe.com/o/r")).toBeTrue();
		expect(m.test("ssh://git@acme.ghe.com/o/r")).toBeTrue();
		expect(m.test("https://myacme.ghe.com/o/r")).toBeFalse();
		expect(m.test("https://acme.ghe.com.evil.test/o/r")).toBeFalse();
		expect(m.test("https://github.com/o/r")).toBeFalse();
	});

	describe("properties", () => {
		// Labels of [a-z0-9] with one letter and inner hyphens, 1-4 labels: every host the
		// module can accept. All-digit labels stay out: the URL parser would read them as
		// IPv4 and change the hostname, which is not the module's doing.
		const char = fc.nat(ALPHA.length - 1).map((i) => ALPHA[i]!);
		const label = fc
			.array(char, { minLength: 1, maxLength: 8 })
			.map((chars) => chars.join(""))
			.filter((s) => /[a-z]/.test(s) && !s.startsWith("-") && !s.endsWith("-"));
		const hostStr = fc
			.array(label, { minLength: 1, maxLength: 4 })
			.map((labels) => labels.join("."));

		test("every accepted host keeps its derived URLs on that host", () => {
			fc.assert(
				fc.property(hostStr, (raw) => {
					const h = host(raw);
					expect(new URL(h.webBase).hostname).toBe(h.host);
					const apiHost = new URL(h.apiBase).hostname;
					if (h.isDefault) expect(apiHost).toBe("api.github.com");
					else if (h.host.endsWith(".ghe.com"))
						expect(apiHost).toBe(`api.${h.host}`);
					else expect(apiHost).toBe(h.host);
				}),
			);
		});

		test("one foreign character anywhere in a host is refused", () => {
			const evil = fc.constantFrom(":", "/", " ", "@", "?", "#", "\t", "\\");
			fc.assert(
				fc.property(hostStr, evil, fc.nat(20), (raw, ch, at) => {
					const i = at % (raw.length + 1);
					const bad = raw.slice(0, i) + ch + raw.slice(i);
					expect(parseGithubHost(bad)).toHaveProperty("error");
				}),
			);
		});
	});
});

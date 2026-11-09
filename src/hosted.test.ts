import { describe, expect, test } from "bun:test";
import { NonceCache, verifyIdentity } from "./auth.ts";
import {
	controlPlaneHooks,
	DEFAULT_CREDIT_REASON,
	type HostedConfig,
	readHostedConfig,
	takeHostedConfig,
} from "./hosted.ts";

const SECRET = "s".repeat(32);
const BASE = {
	OTTR_HOSTED: "1",
	OTTR_HOSTED_TENANT: "t-1",
	OTTR_HOSTED_SECRET: SECRET,
	OTTR_HOSTED_CONTROL_URL: "https://cp.example/",
};

describe("readHostedConfig", () => {
	test("off when unset, empty or 0", () => {
		expect(readHostedConfig({})).toBeNull();
		expect(readHostedConfig({ OTTR_HOSTED: "" })).toBeNull();
		expect(readHostedConfig({ OTTR_HOSTED: "0" })).toBeNull();
	});

	test("a full env yields the config, trailing slash trimmed, default credit reason", () => {
		const cfg = readHostedConfig({ ...BASE, OTTR_HOSTED_WORK_SUFFIX: "W" });
		expect(cfg).toEqual({
			tenant: "t-1",
			secret: SECRET,
			controlUrl: "https://cp.example",
			wording: {
				workSuffix: "W",
				mergeSuffix: "",
				resumeSuffix: "",
				creditReason: DEFAULT_CREDIT_REASON,
			},
		});
	});

	test.each([
		[{ OTTR_HOSTED: "true" }, "OTTR_HOSTED"],
		[{ OTTR_HOSTED_TENANT: "" }, "OTTR_HOSTED_TENANT"],
		[{ OTTR_HOSTED_TENANT: "Upper" }, "OTTR_HOSTED_TENANT"],
		[{ OTTR_HOSTED_TENANT: "-lead" }, "OTTR_HOSTED_TENANT"],
		[{ OTTR_HOSTED_SECRET: "s".repeat(31) }, "OTTR_HOSTED_SECRET"],
		[{ OTTR_HOSTED_CONTROL_URL: "" }, "OTTR_HOSTED_CONTROL_URL"],
		[{ OTTR_HOSTED_CONTROL_URL: "http://cp.example" }, "https"],
		[{ OTTR_HOSTED_CONTROL_URL: "https://u:p@cp.example" }, "credentials"],
		[{ OTTR_HOSTED_CONTROL_URL: "https://cp.example/?a=1" }, "query"],
	])("a broken hosted env stops the boot (%o)", (patch, message) => {
		expect(() => readHostedConfig({ ...BASE, ...patch })).toThrow(message);
	});

	test("plain http is allowed to a loopback control plane", () => {
		const cfg = readHostedConfig({
			...BASE,
			OTTR_HOSTED_CONTROL_URL: "http://127.0.0.1:9000",
		});
		expect(cfg?.controlUrl).toBe("http://127.0.0.1:9000");
	});
});

describe("controlPlaneHooks", () => {
	const cfg = readHostedConfig(BASE) as HostedConfig;
	type Call = { url: string; init: RequestInit };

	function fake(answer: (call: Call) => Response) {
		const calls: Call[] = [];
		const hooks = controlPlaneHooks(cfg, {
			fetch: async (url, init) => {
				const call = { url, init };
				calls.push(call);
				return answer(call);
			},
		});
		return { hooks, calls };
	}

	test("calls carry a tenant-role identity the control plane can verify", async () => {
		const { hooks, calls } = fake(() => Response.json({ ok: true }));
		expect(await hooks.creditOk()).toBe(true);
		expect(calls[0]?.url).toBe("https://cp.example/v1/tenants/t-1/credit");
		const header = new Headers(calls[0]?.init.headers).get("x-ottr-identity");
		const check = verifyIdentity(header, {
			secret: SECRET,
			tenant: "t-1",
			nonces: new NonceCache(),
		});
		expect(check).toEqual({ ok: true, role: "tenant" });
	});

	test("creditOk throws on a non-2xx or a non-boolean answer", async () => {
		await expect(
			fake(() => new Response("no", { status: 502 })).hooks.creditOk(),
		).rejects.toThrow("502");
		await expect(
			fake(() => Response.json({ ok: "yes" })).hooks.creditOk(),
		).rejects.toThrow("boolean");
		expect(
			await fake(() => Response.json({ ok: false })).hooks.creditOk(),
		).toBe(false);
	});

	test("reportUsage posts the record; failures log and never throw", async () => {
		const record = {
			tenant: "t-1",
			project: "app",
			taskId: "APP-1",
			turnId: 2,
			kind: "work",
			role: "default",
			model: "a/b",
			run: 1,
			final: false,
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
		};
		const sent = fake(() => new Response(null, { status: 204 }));
		sent.hooks.reportUsage(record);
		expect(sent.calls[0]?.url).toBe(
			"https://cp.example/v1/tenants/t-1/metering",
		);
		expect(JSON.parse(String(sent.calls[0]?.init.body))).toEqual(record);

		for (const fetch of [
			() => Promise.reject(new Error("ECONNREFUSED")),
			async () => new Response(null, { status: 503 }),
		]) {
			const logged = Promise.withResolvers<string>();
			const hooks = controlPlaneHooks(cfg, { fetch, log: logged.resolve });
			expect(() => hooks.reportUsage(record)).not.toThrow();
			expect(await logged.promise).toMatch(/ECONNREFUSED|503/);
		}
	});

	test("gitToken: token with parsed expiry, null on 404, throw on a bad answer", async () => {
		const at = "2026-11-08T12:00:00.000Z";
		const got = fake(() => Response.json({ token: "ghs_x", expiresAt: at }));
		expect(
			await got.hooks.gitToken("app", "https://github.com/o/r.git"),
		).toEqual({ token: "ghs_x", expiresAt: Date.parse(at) });
		expect(JSON.parse(String(got.calls[0]?.init.body))).toEqual({
			project: "app",
			remote: "https://github.com/o/r.git",
		});
		expect(
			await fake(() => new Response(null, { status: 404 })).hooks.gitToken(
				"app",
				"r",
			),
		).toBeNull();
		await expect(
			fake(() => Response.json({ token: "" })).hooks.gitToken("app", "r"),
		).rejects.toThrow("token");
	});
});

describe("takeHostedConfig", () => {
	test("returns the config and removes the secret from env", () => {
		const env: Record<string, string | undefined> = { ...BASE };
		expect(takeHostedConfig(env)?.secret).toBe(SECRET);
		expect("OTTR_HOSTED_SECRET" in env).toBe(false);
		expect(env.OTTR_HOSTED_TENANT).toBe("t-1");
	});

	test("flag off: returns null and still removes a stray secret", () => {
		const env: Record<string, string | undefined> = {
			OTTR_HOSTED_SECRET: SECRET,
		};
		expect(takeHostedConfig(env)).toBeNull();
		expect("OTTR_HOSTED_SECRET" in env).toBe(false);
	});

	test("invalid env: throws and still removes the secret", () => {
		const env: Record<string, string | undefined> = {
			...BASE,
			OTTR_HOSTED_CONTROL_URL: "",
		};
		expect(() => takeHostedConfig(env)).toThrow("OTTR_HOSTED_CONTROL_URL");
		expect("OTTR_HOSTED_SECRET" in env).toBe(false);
	});

	test.skipIf(process.platform !== "linux")(
		"the real env: a child process cannot read the key from /proc/<server>/environ",
		() => {
			const mod = new URL("./hosted.ts", import.meta.url).pathname;
			// The "server" takes its config, then a child (a repository check) reads the
			// server's startup env block, as any same-user process can.
			const script = `
				const { takeHostedConfig } = await import(${JSON.stringify(mod)});
				const cfg = takeHostedConfig();
				const r = Bun.spawnSync(["cat", "/proc/" + process.pid + "/environ"]);
				const leaked = r.stdout.toString().includes(${JSON.stringify(SECRET)});
				console.log(JSON.stringify({ secret: cfg?.secret, leaked, inEnv: "OTTR_HOSTED_SECRET" in process.env }));
			`;
			const r = Bun.spawnSync(["bun", "-e", script], {
				env: { ...process.env, ...BASE },
			});
			expect(r.stderr.toString()).toBe("");
			expect(JSON.parse(r.stdout.toString())).toEqual({
				secret: SECRET,
				leaked: false,
				inEnv: false,
			});
		},
	);
});

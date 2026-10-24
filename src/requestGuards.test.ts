import { describe, expect, test } from "bun:test";
import {
	directLoopback,
	hostRefusal,
	keyedThrottle,
	loopbackIp,
	publicHosts,
	upgradeRefusal,
} from "./requestGuards.ts";

describe("directLoopback / loopbackIp", () => {
	test("direct loopback peer is accepted", () => {
		expect(directLoopback("127.0.0.1", new Headers())).toBe(true);
		expect(directLoopback("::1", new Headers())).toBe(true);
		expect(directLoopback("::ffff:127.0.0.1", new Headers())).toBe(true);
		expect(loopbackIp("::ffff:127.0.0.1")).toBe(true);
	});
	test("loopback peer carrying proxy headers is treated as remote", () => {
		expect(
			directLoopback(
				"127.0.0.1",
				new Headers({ "x-forwarded-for": "100.64.0.7" }),
			),
		).toBe(false);
		expect(
			directLoopback("::1", new Headers({ "x-forwarded-host": "pc.x.ts.net" })),
		).toBe(false);
		expect(
			directLoopback("127.0.0.1", new Headers({ forwarded: "for=100.64.0.7" })),
		).toBe(false);
	});
	test("remote and unknown peers are never loopback", () => {
		expect(directLoopback("172.18.0.1", new Headers())).toBe(false);
		expect(directLoopback(undefined, new Headers())).toBe(false);
		expect(loopbackIp(undefined)).toBe(false);
		expect(loopbackIp("")).toBe(false);
		expect(loopbackIp("100.64.0.7")).toBe(false);
	});
});

describe("upgradeRefusal", () => {
	const port = 4747;
	const pub = ["pc.x.ts.net"];
	const cases: [string | null, string | null, string | null][] = [
		["127.0.0.1:4747", "http://127.0.0.1:4747", null], // own origin: accept
		["localhost:4747", "http://localhost:4747", null],
		["localhost:4747", "http://127.0.0.1:4747", null], // mixed allowlisted pair: accept
		["127.0.0.1:4747", "http://localhost:4747", null],
		["evil.test:4747", "http://evil.test:4747", "forbidden host"], // DNS rebinding
		["127.0.0.1:4747", "https://evil.example", "forbidden origin"],
		["127.0.0.1:4747", null, "forbidden origin"], // browsers always send Origin on a handshake
		[null, "http://127.0.0.1:4747", "forbidden host"],
		["127.0.0.1:4747", "http://127.0.0.1:1234", "forbidden origin"],
		["127.0.0.1:4747", "null", "forbidden origin"], // sandboxed iframe
		["127.0.0.1:4747", "https://127.0.0.1:4747", "forbidden origin"], // wrong scheme
	];
	for (const [host, origin, refusal] of cases) {
		test(`${host} + ${origin} -> ${refusal ?? "accept"}`, () => {
			expect(upgradeRefusal(host, origin, port, [], true)).toBe(refusal);
		});
	}

	test("no wall decision (false) gives 401 before Origin is checked", () => {
		expect(
			upgradeRefusal(
				"127.0.0.1:4747",
				"http://127.0.0.1:4747",
				port,
				[],
				false,
			),
		).toBe("unauthorized");
		expect(upgradeRefusal("pc.x.ts.net", null, port, pub, false)).toBe(
			"unauthorized",
		);
	});

	/** Same host list the api() guard composes from. */
	describe("host half agrees", () => {
		for (const [host, , refusal] of cases) {
			test(`${host} -> ${refusal === "forbidden host" ? "forbidden host" : "accept"}`, () => {
				expect(hostRefusal(host, port, [])).toBe(
					refusal === "forbidden host" ? refusal : null,
				);
			});
		}
	});

	describe("public hosts", () => {
		test("public host with matching https origin: accept", () => {
			expect(
				upgradeRefusal("pc.x.ts.net", "https://pc.x.ts.net", port, pub, true),
			).toBe(null);
		});
		test(":443 host suffix and https origin: accept", () => {
			expect(
				upgradeRefusal(
					"PC.X.TS.NET:443",
					"https://pc.x.ts.net",
					port,
					pub,
					true,
				),
			).toBe(null);
		});
		test("plain-http origin on a public host: refuse (credentials must not cross clear text)", () => {
			expect(
				upgradeRefusal(
					"PC.X.TS.NET:443",
					"http://pc.x.ts.net",
					port,
					pub,
					true,
				),
			).toBe("forbidden origin");
		});
		test("public host with foreign origin: refuse", () => {
			expect(
				upgradeRefusal("pc.x.ts.net", "https://evil.example", port, pub, true),
			).toBe("forbidden origin");
		});
		test("public host stays refused without the list (default localhost-only)", () => {
			expect(
				upgradeRefusal("pc.x.ts.net", "https://pc.x.ts.net", port, [], true),
			).toBe("forbidden host");
		});
		test("no session on a public host: 401 before Origin is checked", () => {
			expect(upgradeRefusal("pc.x.ts.net", null, port, pub, false)).toBe(
				"unauthorized",
			);
		});
		test("a live session lets the handshake through to the Origin check", () => {
			expect(
				upgradeRefusal("pc.x.ts.net", "https://pc.x.ts.net", port, pub, true),
			).toBe(null);
			expect(
				upgradeRefusal("pc.x.ts.net", "https://evil.example", port, pub, true),
			).toBe("forbidden origin");
		});
		test("loopback with a wall pass never demands a session (caller decides)", () => {
			expect(
				upgradeRefusal(
					"127.0.0.1:4747",
					"http://127.0.0.1:4747",
					port,
					pub,
					true, // caller passes `!walled(req) || sessionValid(req)`
				),
			).toBe(null);
		});
	});

	describe("publicHosts parsing", () => {
		test("comma/semicolon lists, trimmed, empty entries dropped, lowercased", () => {
			process.env.OMP_TRACKER_PUBLIC_HOSTS = " PC.x.ts.net , ; ;second.io ";
			expect(publicHosts()).toEqual(["pc.x.ts.net", "second.io"]);
			delete process.env.OMP_TRACKER_PUBLIC_HOSTS;
			expect(publicHosts()).toEqual([]);
		});
	});
});

describe("keyedThrottle", () => {
	test("burst on one key fires once with the last arg, after the window", async () => {
		let calls = 0;
		let last = null as string | null;
		const push = keyedThrottle(20, (arg: string) => {
			calls++;
			last = arg;
		});
		for (const arg of ["1", "2", "3", "4", "5"]) push("a", arg);
		expect(calls).toBe(0);
		await Bun.sleep(60);
		expect(calls).toBe(1);
		expect(last).toBe("5");
	});

	test("keys are independent", async () => {
		const seen: string[] = [];
		const push = keyedThrottle(20, (arg: string) => seen.push(arg));
		push("a", "a1");
		push("b", "b1");
		await Bun.sleep(60);
		expect(seen).toEqual(["a1", "b1"]);
	});

	test("a call after the window fires again", async () => {
		let calls = 0;
		const push = keyedThrottle(20, () => calls++);
		push("a", 1);
		await Bun.sleep(60);
		push("a", 2);
		await Bun.sleep(60);
		expect(calls).toBe(2);
	});
});

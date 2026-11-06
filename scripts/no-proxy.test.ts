// Podman injects the host proxy env (HTTP_PROXY/HTTPS_PROXY/NO_PROXY) into every container;
// its NO_PROXY names no compose services, so internal calls bounce off the corporate proxy.
// Coverage test for docker/no-proxy.sh: the sourced merge must keep the injected host list
// first, append the service names, absorb OTTR_WORKER_URLS hosts, and stay idempotent.
import { describe, expect, test } from "bun:test";

const scriptPath = new URL("../docker/no-proxy.sh", import.meta.url).pathname;

function mergeNoProxy(env: Record<string, string>): {
	noProxy: string;
	lower: string;
} {
	const proc = Bun.spawnSync({
		cmd: [
			"sh",
			"-c",
			`. ${scriptPath} && printf '%s\\n%s' "$NO_PROXY" "$no_proxy"`,
		],
		env,
	});
	const [noProxy = "", lower = ""] = new TextDecoder()
		.decode(proc.stdout)
		.split("\n");
	return { noProxy, lower };
}

const FIXED =
	"localhost,127.0.0.1,alate,server,ottr,ottr-server,worker-a,worker-b";

describe("docker/no-proxy.sh", () => {
	test("keeps the injected NO_PROXY host list first, appends the service names", () => {
		const { noProxy, lower } = mergeNoProxy({
			NO_PROXY: "corp.example,10.0.0.0/8",
		});
		expect(noProxy).toBe(`corp.example,10.0.0.0/8,${FIXED}`);
		expect(lower).toBe(noProxy);
	});

	test("sets both vars even with no proxy vars at all", () => {
		const { noProxy, lower } = mergeNoProxy({});
		expect(noProxy).toBe(FIXED);
		expect(lower).toBe(noProxy);
	});

	test("falls back to lowercase no_proxy when NO_PROXY is unset", () => {
		const { noProxy, lower } = mergeNoProxy({ no_proxy: "internal.corp" });
		expect(noProxy).toBe(`internal.corp,${FIXED}`);
		expect(lower).toBe(noProxy);
	});

	test("does not duplicate an entry already present in the list", () => {
		const { noProxy, lower } = mergeNoProxy({ NO_PROXY: "localhost" });
		expect(noProxy).toBe(FIXED);
		expect(lower).toBe(noProxy);
	});

	test("absorbs OTTR_WORKER_URLS hosts without duplicating known workers", () => {
		const { noProxy, lower } = mergeNoProxy({
			NO_PROXY: "corp.example",
			OTTR_WORKER_URLS: "http://worker-a:8787,http://worker-c:8787",
		});
		expect(noProxy).toBe(`corp.example,${FIXED},worker-c`);
		expect(lower).toBe(noProxy);
	});
});

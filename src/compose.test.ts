// Pins the BuildKit sidecar compose shape (OTTR-785, docs/specs/turn-image-builds.md):
// profile gating, no privileged/docker.sock/ports, network isolation, cert separation,
// mTLS daemon flags, digest pin, limits, and the client-side buildctl + docs pins.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// biome-ignore lint/suspicious/noExplicitAny: compose YAML has no schema in this repo
type Service = Record<string, any>;

const composePath = new URL("../docker-compose.yml", import.meta.url);
const composeText = readFileSync(composePath, "utf8");
// biome-ignore lint/suspicious/noExplicitAny: see Service
const compose = Bun.YAML.parse(composeText) as Record<string, any>;
const services = compose.services as Record<string, Service>;
const workerA = svc("worker-a");
const xWorker = compose["x-worker"] as Service;
const buildkit = svc("buildkit");
const buildkitCerts = svc("buildkit-certs");
const server = svc("server");

/** A compose service that must exist: a missing sidecar service fails the pin loudly. */
function svc(name: string): Service {
	const s = compose.services[name];
	if (s === undefined) throw new Error(`compose service missing: ${name}`);
	return s;
}

const workerDockerfile = readFileSync(
	new URL("../Dockerfile.worker", import.meta.url),
	"utf8",
);
const workersDoc = readFileSync(
	new URL("../docs/WORKERS.md", import.meta.url),
	"utf8",
);

describe("the buildkit sidecar compose shape", () => {
	test("both sidecar services sit behind the build profile", () => {
		expect(buildkit.profiles).toContain("build");
		expect(buildkitCerts.profiles).toContain("build");
	});

	test("no service runs privileged", () => {
		for (const [name, service] of Object.entries(services)) {
			expect(service.privileged, `service ${name}`).toBeUndefined();
		}
	});

	test("the compose file never names docker.sock", () => {
		expect(composeText.includes("docker.sock")).toBe(false);
	});

	test("the sidecar publishes no port", () => {
		expect(buildkit.ports).toBeUndefined();
		expect(buildkitCerts.ports).toBeUndefined();
	});

	test("network isolation: workers reach buildkit, the server never does", () => {
		expect(buildkit.networks).toEqual(["buildkit"]);
		expect(Object.keys(server.networks)).toEqual(["default"]);
		expect(workerA.networks).toContain("default");
		expect(workerA.networks).toContain("buildkit");
		expect(Object.keys(compose.networks)).toContain("buildkit");
		expect(compose.networks.buildkit.internal).toBeUndefined();
	});

	test("cert separation: workers hold only the client cert and CA, read-only", () => {
		const daemonMounts = ["buildkit-daemon-certs", "buildkit-config"];
		const workerVolumes = workerA.volumes as string[];
		expect(workerVolumes).toContain(
			"buildkit-client-certs:/certs/buildkit/client:ro",
		);
		expect(workerVolumes).toContain("buildkit-ca:/certs/buildkit/ca:ro");
		for (const volume of workerVolumes) {
			for (const forbidden of daemonMounts) {
				expect(
					volume.includes(forbidden),
					`${volume} mounts ${forbidden}`,
				).toBe(false);
			}
		}
		const buildkitVolumes = buildkit.volumes as string[];
		expect(buildkitVolumes).toContain("buildkit-daemon-certs:/certs/daemon:ro");
		expect(buildkitVolumes).toContain("buildkit-ca:/certs/ca:ro");
		expect(buildkitVolumes).toContain("buildkit-config:/config:ro");
		expect(buildkitVolumes.some((v) => v.startsWith("buildkit-state:"))).toBe(
			true,
		);
		const env = xWorker.environment as Record<string, string>;
		for (const key of [
			"BUILDKIT_HOST",
			"BUILDKIT_TLS_CA",
			"BUILDKIT_TLS_CERT",
			"BUILDKIT_TLS_KEY",
		]) {
			expect(env[key]).toMatch(/^\$\{[^:}]+:-\}$/);
		}
	});

	test("the daemon answers mTLS on tcp 1234 with the docs' container mode", () => {
		const command = buildkit.command as string[];
		for (const flag of [
			"--tlscacert",
			"--tlscert",
			"--tlskey",
			"tcp://0.0.0.0:1234",
			"/config/buildkitd.toml",
		]) {
			expect(command).toContain(flag);
		}
		expect(command.join(" ")).not.toContain("--oci-worker-no-process-sandbox");
		expect(buildkit.security_opt).toEqual([
			"seccomp=unconfined",
			"apparmor=unconfined",
			"systempaths=unconfined",
		]);
	});

	test("the daemon image is digest-pinned", () => {
		expect(buildkit.image).toMatch(
			/^moby\/buildkit:v0\.\d+\.\d+-rootless@sha256:[0-9a-f]{64}$/,
		);
	});

	test("the daemon runs under memory and cpu limits with a cache cap", () => {
		expect(typeof buildkit.mem_limit).toBe("string");
		expect((buildkit.mem_limit as string).length).toBeGreaterThan(0);
		expect(typeof buildkit.cpus).toBe("string");
		expect((buildkit.cpus as string).length).toBeGreaterThan(0);
		expect(composeText).toContain(
			'maxUsedSpace = "${OTTR_BUILDKIT_CACHE_CAP:-20GB}"',
		);
		expect(composeText).toContain("gcpolicy");
		expect(composeText).toContain("gc = true");
	});

	test("the worker image installs a pinned, checksummed buildctl", () => {
		for (const line of [
			"ARG BUILDKIT_VERSION=",
			"ARG BUILDKIT_SHA256=",
			"buildkit-v${BUILDKIT_VERSION}.linux-amd64.tar.gz",
			"sha256sum -c -",
			"buildctl --version",
			"ARG OPENSSL_VERSION=3.5.7-1~deb13u3",
		]) {
			expect(workerDockerfile).toContain(line);
		}
		expect(workerDockerfile).toContain('"openssl=${OPENSSL_VERSION}" \\');
	});

	test("docs/WORKERS.md documents image builds in turns", () => {
		for (const text of [
			"## Image builds in turns",
			"COMPOSE_PROFILES=build",
			"buildctl --tlscacert",
			"cannot run containers",
			"podman inside the Firecracker VM",
		]) {
			expect(workersDoc).toContain(text);
		}
	});
});

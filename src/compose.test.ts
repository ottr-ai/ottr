// Pins compose and CI infrastructure shape: BuildKit isolation and disposable
// PostgreSQL tests. These checks do not prove container or database behavior.
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
const postgresTest = svc("postgres-test");
const alate = svc("alate");
const postgresTestImage =
	"docker.io/library/postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636";
const ci = Bun.YAML.parse(
	readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: { check: Service } };
const ciCheck = ci.jobs.check;

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
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal buildkitd config line, not a TS template
			'maxUsedSpace = "${OTTR_BUILDKIT_CACHE_CAP:-20GB}"',
		);
		expect(composeText).toContain("gcpolicy");
		expect(composeText).toContain("gc = true");
		// gcpolicy is an ARRAY of tables in buildkitd's config (upstream
		// docs/buildkitd.toml.md); the single-table form is not the documented shape.
		expect(composeText).toContain("[[worker.oci.gcpolicy]]");
		// The daemon reads the config as uid 1000; a 0600 root file would stop it
		// with "failed to load config from /config/buildkitd.toml".
		expect(composeText).toContain("chmod 0444 /config/buildkitd.toml");
	});

	test("the worker image installs a pinned, checksummed buildctl", () => {
		for (const line of [
			"ARG BUILDKIT_VERSION=",
			"ARG BUILDKIT_SHA256_AMD64=",
			"ARG BUILDKIT_SHA256_ARM64=",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Dockerfile ARG expansion, not a TS template
			"buildkit-v${BUILDKIT_VERSION}.linux-${BUILDKIT_ARCH}.tar.gz",
			"sha256sum -c -",
			"buildctl --version",
			"ARG OPENSSL_VERSION=3.5.7-1~deb13u3",
		]) {
			expect(workerDockerfile).toContain(line);
		}
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Dockerfile ARG expansion, not a TS template
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

describe("the PostgreSQL test infrastructure shape", () => {
	test("compose gates disposable data behind pgtest without a host port", () => {
		expect(postgresTest.profiles).toEqual(["pgtest"]);
		expect(postgresTest.tmpfs).toEqual(["/var/lib/postgresql"]);
		expect(postgresTest.volumes).toBeUndefined();
		expect(postgresTest.ports).toBeUndefined();
		expect(postgresTest.network_mode).toBeUndefined();
		expect(postgresTest.networks).toEqual(["default"]);
		expect(Object.keys(server.networks)).toContain("default");
		for (const name of ["worker-a", "worker-b"]) {
			expect(svc(name).networks).toContain("default");
		}
	});

	test("compose uses trust only for the isolated test database", () => {
		expect(postgresTest.environment).toEqual({
			POSTGRES_HOST_AUTH_METHOD: "trust",
			POSTGRES_DB: "postgres",
		});
		expect(postgresTest.healthcheck).toEqual({
			test: ["CMD", "pg_isready", "-U", "postgres", "-d", "postgres"],
			interval: "5s",
			timeout: "5s",
			retries: 12,
			start_period: "10s",
		});
	});

	test("server and worker environments pass both optional test variables", () => {
		for (const service of [server, xWorker, svc("worker-a"), svc("worker-b")]) {
			expect(service.environment.OTTR_TEST_PG_URL).toBe(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose env default, not a TS template
				"${OTTR_TEST_PG_URL:-}",
			);
			expect(service.environment.OTTR_REQUIRE_PG_TESTS).toBe(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose env default, not a TS template
				"${OTTR_REQUIRE_PG_TESTS:-}",
			);
		}
		for (const service of [xWorker, svc("worker-a"), svc("worker-b")]) {
			expect(service.environment.OTTR_DATABASE_URL).toBeUndefined();
		}
	});

	test("compose and CI use the exact same PostgreSQL 18 image digest", () => {
		expect(postgresTest.image).toBe(postgresTestImage);
		expect(ciCheck.services["postgres-test"].image).toBe(postgresTestImage);
	});

	test("the host CI job uses a reachable ephemeral service port", () => {
		const service = ciCheck.services["postgres-test"] as Service;
		expect(ciCheck["runs-on"]).toBe("ubuntu-latest");
		expect(ciCheck.container).toBeUndefined();
		expect(service.ports).toEqual([5432]);
		expect(service.env).toEqual({
			POSTGRES_HOST_AUTH_METHOD: "trust",
			POSTGRES_DB: "postgres",
		});
		for (const option of [
			'--health-cmd "pg_isready -U postgres -d postgres"',
			"--health-interval 5s",
			"--health-timeout 5s",
			"--health-retries 12",
			"--tmpfs /var/lib/postgresql",
		]) {
			expect(service.options).toContain(option);
		}
		// Job-level env with the `job` context makes GitHub reject the whole workflow
		// at trigger time (OTTR-937): the URL expression may only live on a step env.
		expect(ciCheck.env).toBeUndefined();
		const steps = ciCheck.steps as Service[];
		const testStep = steps.find(
			(step) => step.run === "bun test --timeout 20000",
		);
		expect(testStep).toBeDefined();
		expect(testStep?.env).toEqual({
			OTTR_TEST_PG_URL:
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression, not a TS template
				"postgres://postgres@127.0.0.1:${{ job.services.postgres-test.ports[5432] }}/postgres",
			OTTR_REQUIRE_PG_TESTS: "1",
		});
		for (const step of steps) {
			if (step === testStep) continue;
			expect(step.env?.OTTR_TEST_PG_URL).toBeUndefined();
			expect(step.env?.OTTR_REQUIRE_PG_TESTS).toBeUndefined();
		}
	});
});

describe("the bundled alate service shape", () => {
	test("the alate service mounts the workspace volume at /workspace", () => {
		// The same named volume the board and the workers mount: install-projects.mjs
		// writes the projects.json files into the shared project checkouts there.
		// Without the mount /workspace does not exist in the container, alate refuses
		// a projectsRoot of /workspace, and the provision prints
		// "install-projects: no --root; project files not provisioned".
		expect(alate.volumes).toContain("workspace:/workspace");
	});

	test("docs/WORKERS.md documents the alate workspace mount and projectsRoot", () => {
		expect(workersDoc).toContain("workspace:/workspace");
		expect(workersDoc).toContain("projectsRoot");
	});
});

# Image builds in turns (rootless BuildKit sidecar)

Status: accepted (OTTR-785).

## Problem

A work turn cannot build or test a Dockerfile change. The worker containers
carry no docker, podman or buildctl (OTTR-698 parked on this: "This worker
has no reachable builder"). The host Docker socket is not an option: it is
root on the host, and it reads `compose.env`. The Firecracker runner
(compose profile `vm`) needs `/dev/kvm`, which this host (Docker Desktop on
Windows) does not expose.

## Decision

A rootless BuildKit daemon runs as the compose service `buildkit` behind the
`build` profile. The daemon holds no credentials, publishes no port, and
sits only on the `buildkit` compose network, which the workers share and the
server never joins.

buildctl and buildkitd talk mutual TLS. The `buildkit-certs` one-off (same
profile) generates a CA, a server certificate and one client certificate
into five named volumes (`buildkit-ca`, `buildkit-daemon-certs`,
`buildkit-client-certs`, `buildkit-config`, `buildkit-state`). The CA
private key never lands in a volume: the one-off signs in `/tmp` and
discards it, so a turn cannot mint more certificates. The workers mount only
the client certificate and the CA, read-only. The daemon listens on
`tcp://0.0.0.0:1234` with the server certificate, and its private key stays
in `buildkit-daemon-certs`, which no worker mounts.

### Security mode

The BuildKit rootless docs' container mode: `seccomp=unconfined`,
`apparmor=unconfined`, `systempaths=unconfined`. Not
`--oci-worker-no-process-sandbox`. The docs discourage that flag: it cannot
kill build steps that fail to exit, and it lets a build step kill or ptrace
daemon processes. This daemon runs untrusted build steps from agent turns.
The three unconfined settings weaken only this sidecar: it runs as uid 1000,
holds no credentials, and only workers reach it over mTLS. Podman has no
`systempaths=unconfined`, so the profile is Docker-only.

### Network

The `buildkit` network is not compose-`internal`: every build pulls base
images from docker.io, and an internal network has no egress, so the
acceptance build would fail. The isolation that matters still holds: the
server joins only `default`, and Docker isolates bridge networks from each
other, so the server has no route to buildkit.

### Limits

`mem_limit` (default 8g) and `cpus` (default 4) on the service. Build steps
run inside the daemon container's cgroup, so one build cannot starve turns.
The cache cap sits in `/config/buildkitd.toml`, which the one-off writes
into `buildkit-config`: `gc = true`, `reservedSpace = "4GB"`,
`maxUsedSpace = "${OTTR_BUILDKIT_CACHE_CAP:-20GB}"`, `minFreeSpace = "5GB"`,
`keepDuration = 172800`. No registry credentials exist in the daemon, so a
push fails at the registry; builds export nothing by default (no `--output`)
or a local tar (`--output type=docker,dest=<file>.tar`).

### Worker wiring

`buildctl` installs into the worker image from the official BuildKit release
tarball, pinned and SHA-256-checked like the other binaries. The x-worker
anchor joins the `buildkit` network, mounts `buildkit-client-certs` and
`buildkit-ca` read-only, and passes `BUILDKIT_HOST`, `BUILDKIT_TLS_CA`,
`BUILDKIT_TLS_CERT`, `BUILDKIT_TLS_KEY` through with empty defaults. The
env file sets them together with `COMPOSE_PROFILES=build`, so the values
exist only when the profile is on (the `OTTR_VM_RUNNER_URL` pattern).

## Pins

- `moby/buildkit:v0.34.2-rootless@sha256:c8252268760e1baba80780d63d738ef9f260fb7c7c0973c78494cb9ddd99eda1`
  (multiarch index digest, checked 2026-11-10).
- `buildkit-v0.34.2.linux-amd64.tar.gz`, sha256
  `b9f18b8e37eb450e9e5df03117045237cdd12d3c4a0034ffeeaa857852a15e13`. The
  release publishes no checksums file; the SHA-256 was computed when pinned,
  like the Chrome pin. The release carries sigstore and provenance
  attestations for a deeper check.
- `openssl 3.5.7-1~deb13u3` (trixie stable-security, 2026-11). New explicit
  pin in `Dockerfile.worker`: the cert one-off runs openssl, and the image
  only had it as a transitive dependency of `ca-certificates`.

## Behavior

- `docker compose --profile build up -d buildkit` starts the one-off, then
  the daemon. The one-off is idempotent: with all six outputs present (CA,
  server cert and key, client cert and key, config), it chowns the state
  volume for uid 1000 and exits 0. `depends_on` with
  `service_completed_successfully` orders them.
- A turn builds with:

      buildctl --tlscacert "$BUILDKIT_TLS_CA" --tlscert "$BUILDKIT_TLS_CERT" \
        --tlskey "$BUILDKIT_TLS_KEY" build --frontend dockerfile.v0 \
        --local context=. --local dockerfile=. \
        --opt filename=Dockerfile.worker --opt target=<stage>

  `buildctl` reads the address from `BUILDKIT_HOST`; the TLS paths are flags
  with no env form. A build step that fails exits non-zero.

## Error cases

- A client without the client certificate is refused in the TLS handshake.
- Certificate rotation invalidates workers and daemon together: remove the
  four cert volumes (`buildkit-ca`, `buildkit-daemon-certs`,
  `buildkit-client-certs`, `buildkit-config`), recreate `buildkit` and the
  workers with `--force-recreate`, and let `up` rerun the one-off.
- A kernel older than 5.11 (no unprivileged overlayfs) gets the native
  snapshotter: slower builds, still correct. Docker Desktop qualifies.
- Daemon down: buildctl exits non-zero with a connection error; the turn
  keeps working for non-build work.
- The cache cap bounds only buildkit's own state volume; the Docker VM disk
  stays shared with images and other containers (documented residual).

## Non-goals

- No docker or podman run in turns, no compose stacks in turns, and no
  `/var/run/docker.sock` mount.
- No registry push: no credentials reach the daemon; exports stay local.
- No microVM support: vm-runner turns get no `BUILDKIT_*` env and no
  `buildkit` network.
- No Podman host support for this profile; the upgrade path is podman inside
  the Firecracker VM on a host with KVM (docs/WORKERS.md).
- No per-project cache: one fleet-wide cache sits behind the cap.

## Acceptance checks

- `src/compose.test.ts` pins the compose shape: both services behind the
  `build` profile; no `privileged` on any service; no docker.sock anywhere
  in the file; no ports on `buildkit` or `buildkit-certs`; `buildkit` only
  on the `buildkit` network and the server never joins it; the daemon cert
  volume mounts only into `buildkit`; the workers mount only the client
  certificate and CA, read-only; the digest pin; the `security_opt` trio
  with no `--oci-worker-no-process-sandbox` flag; `mem_limit`, `cpus` and
  the cache cap; the `Dockerfile.worker` buildctl pin and its SHA-256; the
  WORKERS.md section.
- `bun run check` and `bun test` pass.
- On a stack with the profile on (needs a Docker host; the commands live in
  docs/WORKERS.md "Image builds in turns"): the documented buildctl build
  over `Dockerfile.worker` exits 0; a build step that fails exits non-zero;
  a client without the client certificate is refused; the server container
  has no route to buildkit.

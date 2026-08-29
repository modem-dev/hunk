# Optional Firecracker install compatibility suite

This suite tests Hunk's Linux x64 npm, pnpm, legacy Bun-fallback, offline, and curl installation behavior in fresh Firecracker microVMs. It is completely opt-in: `bun install`, normal tests, typechecking, builds, and packaging do not check for Docker/KVM or download VM assets.

## Run

Requirements:

- Linux x86_64 with at least 6 GiB free;
- Docker daemon access without `sudo`;
- readable/writable `/dev/kvm` and `/dev/net/tun`.

```sh
bun run test:install-vm -- --list
bun run test:install-vm -- --scenario pnpm-global-upgrade
bun run test:install-vm
```

Use `--reuse-fixtures` to reuse package fixtures only when their checkout identity and every tarball checksum still match; stale or altered fixtures are rebuilt. Automation that intentionally permits unsupported hosts may pass `--allow-skip`; a requested local run otherwise fails with an actionable preflight report. In GitHub Actions, an allowed skip emits a workflow warning and a prominent step summary in addition to a structured skipped result—it is not VM success.

The first run lazily builds the controller image and downloads checksum-pinned Firecracker, kernel, rootfs, and Node inputs. They live under `tmp/install-vm/cache`; generated package fixtures and structured runs live under `tmp/install-vm/fixtures` and `tmp/install-vm/runs`. Remove only those harness-owned artifacts with:

```sh
bun run test:install-vm:clean
```

The runner deliberately does not reclaim a stale `tmp/install-vm/.lock`, because deleting a lock
owned by a racing process is unsafe. After an interrupted host dies, confirm no suite is running and
remove that lock directory manually before retrying.

Every scenario gets a sparse/reflink clone of the verified immutable base image, an ephemeral run-only SSH public key injected into that clone, and isolated HOME, PATH, npm prefix, pnpm global directory, and pnpm store. Hunk's generated fixture packages are checksum-pinned and published to the local registry. Verdaccio currently proxies uncached transitive dependencies, so first-run package installation still depends on npm availability; the historical corruption oracle also deliberately uses the live npm registry while consuming the validated exact Hunk, Bun, and pnpm pins from `pins.json`. Results include `result.json`, `junit.xml`, structured commands and observations, guest command logs, assertions, and Firecracker console output. Writable disks, SSH keys, sockets, cache identities, locks, and registry credentials are excluded from result artifacts.

## Security boundary

The controller container receives only `/dev/kvm`, `/dev/net/tun`, `NET_ADMIN`, `CHOWN`, and `DAC_OVERRIDE`. The last two let it traverse the owner-only validated cache/result binds while running, then return their ownership to the invoking user; the directories are never made world-writable. The container drops all other capabilities, enables `no-new-privileges`, uses a read-only container root, and never mounts the repository or Docker socket. TAP and NAT changes stay in its Docker network namespace and are removed on exit. Third-party package lifecycle scripts run as root only inside disposable guests with no repository, host credentials, or host-writable package cache.

This is development/test isolation, not a production Firecracker jail. Run repository-controlled KVM jobs only on trusted disposable hosts. The dedicated workflow is manual and never runs for pull requests.

## Coverage boundaries

Firecracker runs Linux guests on the host CPU. It cannot validate macOS or Windows, emulate Apple Silicon, or reproduce the final native macOS ARM64 exit behavior from issue #866. Native Apple Silicon coverage remains tracked by `TODO-1994d3d9`.

The Node-resolvable npm Bun fallback remains a best-effort legacy path. A standalone `bun` on PATH is deliberately different and is not used by the launcher. The suite observes an older fallback package but does not declare a supported minimum Bun version.

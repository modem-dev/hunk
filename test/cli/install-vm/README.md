# Optional Firecracker install compatibility suite

This suite tests Hunk's Linux x64 npm and pnpm installs/upgrades, authenticated daemon upgrades, legacy Bun fallback, offline execution, and curl install/upgrade behavior in fresh Firecracker microVMs. It is completely opt-in: `bun install`, normal tests, typechecking, builds, and packaging do not check for Docker/KVM or download VM assets.

## Run

Requirements:

- Linux x86_64 with at least 6 GiB free;
- Docker daemon access without `sudo`;
- readable/writable `/dev/kvm` and `/dev/net/tun`.

```sh
bun run test:install-vm -- --list
bun run test:install-vm -- --scenario pnpm-global-upgrade
bun run test:install-vm -- --scenario authenticated-daemon-upgrade
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

Every scenario gets a sparse/reflink clone of the verified immutable base image, an ephemeral run-only SSH public key injected into that clone, and isolated HOME, PATH, npm prefix, pnpm global directory, and pnpm store. Hunk's generated fixture packages are checksum-pinned and published to the local registry. Fixture preparation also compiles two full Hunk binaries from isolated copies of the exact checkout and reflink-capable dependency snapshots: the current authenticated daemon revision and the immediately preceding incompatible revision. The checkout `sourceIdentity` remains source-only; a separate `daemonUpgradeBuildInputIdentity` frames and hashes the ignored `node_modules` snapshot bytes and contained symlink targets plus the Bun executable bytes/version used by the builder. External dependency symlinks are rejected, and an isolated PATH entry forces nested build commands to use that attested Bun executable. The fixture manifest binds both compiled binary SHA-256 digests, which the guest compares with the live A/B daemon executables. Temporary source, dependency, and package staging trees are removed before fixtures become visible. The daemon-upgrade scenario therefore adds two compilation passes and about one production idle timeout to a targeted run. Verdaccio currently proxies uncached transitive dependencies, so first-run package installation still depends on npm availability; the historical corruption oracle also deliberately uses the live npm registry while consuming the validated exact Hunk, Bun, and pnpm pins from `pins.json`. Results include `result.json`, `junit.xml`, structured commands and observations, guest command logs, assertions, Firecracker console output, and the fixture source identity. Scenario-specific required-evidence contracts bind required command IDs to exact expectation semantics and make missing daemon lifecycle proof fail aggregation and release validation. The daemon scenario stops one exact test-owned upgraded client across incumbent retirement, waits for the other original client to register on the successor, then resumes and verifies the delayed PID/start-token registers without restart; it never signals a daemon. Release validation rejects symlinked or escaping evidence and reads the referenced health, metadata, executable, fixture-manifest, warning, command-log, and session-list artifacts from the run directory instead of trusting result labels alone. It also requires the locally reusable fixture set to pass checkout, build-input, and package checksum verification, then extracts and hashes the actual A/B package binaries as an independent digest trust input; missing or stale local fixtures fail validation. Writable disks, SSH keys, sockets, cache identities, locks, and registry credentials are excluded from result artifacts. Release evidence can be checked against the current checkout and complete scenario manifest with `bun run ./test/cli/install-vm/validate-release-result.ts <result.json>`. A targeted development run can be checked with `--scenario <id>`; that explicit subset check is not complete release evidence.

## Security boundary

The controller container receives only `/dev/kvm`, `/dev/net/tun`, `NET_ADMIN`, `CHOWN`, and `DAC_OVERRIDE`. The last two let it traverse the owner-only validated cache/result binds while running, then return their ownership to the invoking user; the directories are never made world-writable. The container drops all other capabilities, enables `no-new-privileges`, uses a read-only container root, and never mounts the repository or Docker socket. TAP and NAT changes stay in its Docker network namespace and are removed on exit. Third-party package lifecycle scripts run as root only inside disposable guests with no repository, host credentials, or host-writable package cache.

This is development/test isolation, not a production Firecracker jail. Run repository-controlled KVM jobs only on trusted disposable hosts. The dedicated workflow is manual and never runs for pull requests.

## Coverage boundaries

Firecracker runs Linux guests on the host CPU. It cannot validate macOS or Windows, emulate Apple Silicon, or reproduce the final native macOS ARM64 exit behavior from issue #866. Native Apple Silicon coverage remains tracked by `TODO-1994d3d9`.

The Node-resolvable npm Bun fallback remains a best-effort legacy path. A standalone `bun` on PATH is deliberately different and is not used by the launcher. The suite observes an older fallback package but does not declare a supported minimum Bun version.

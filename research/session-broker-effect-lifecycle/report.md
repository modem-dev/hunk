# Session broker Effect lifecycle experiment results

Status: Phase 1 treatment collected; **discard Phase 1 and do not begin Phase 2**.

## Control

The control is fresh `origin/main` at
`42d2b9dd2f3144e33080f159f4cc9c2824ad1708`. The experiment plan, characterization tests,
fixtures, and harness form a separate experiment-support patch. Every candidate production file,
package manifest, and lockfile remained byte-identical to the control commit during collection.

Control evidence is stored under `tmp/session-lifecycle-effect/control/`. The treatment verified all
49 control-manifest entries against external attestation-file SHA-256
`d284decdee198773a3bff2e9ae6bca6164ef6b23286f8a1fd74db26636361fe7` before using them.

The recollected control established:

- focused lifecycle/broker/source-boundary validation: 379 passed and 0 failed;
- real Node adapter/producer validation: 4 passed and 0 failed;
- PTY integration: 139 passed, 1 skipped, and 0 failed;
- typecheck, lint, dependency boundaries, declaration emission, Bun/Node process-exit modes, and
  the bounded canary scan passed;
- minified standalone broker builds were deterministic at 90,116 bytes for Bun and 90,118 bytes
  for Node;
- compiled Hunk was deterministic at 177,268,864 bytes;
- process-to-lifecycle-ready median/p95 was 12.093/13.041 ms;
- synchronous connection-stop median/p95 was 0.000911/0.009067 ms.

Authenticated-registration latency remains `not-measured`: the signed runtime fixtures prove the
complete hello/register behavior but do not expose one stable isolated timestamp in both arms. Hunk
startup polling also remains `not-measured` because it has no honest portable real-Node equivalent.
Listener acquisition and daemon ordered stop are unchanged transport context. CPU and RSS remain
coarse, non-isolated observations and support no strong conclusion.

## Treatment

Phase 1 pins `effect@3.22.1` only in `packages/session-broker`. One process lifecycle created by
`runInteractiveApp` owns one `ManagedRuntime`, one unref-aware Clock, one client startup supervisor,
and one connection-generation supervisor. The security and domain core, daemon, Node/Bun adapters,
authentication, validation, budgets, browser review, and native transport controls remain
Effect-free and unchanged.

### Ownership result

The treatment mechanically removes these independent producer-side owners:

- connection reconnect timeout;
- connection heartbeat interval;
- per-socket handshake timeout `WeakMap`;
- connection reconnect-preparation timer callback chain;
- Hunk client reconnect timeout;
- Hunk client `startupPromise` field;
- launcher `Bun.sleep` polling ownership on the production Hunk path.

They are replaced by exactly one `connectionSupervisor` property and one `startupSupervisor`
property. The frozen AST analysis reports no native timing in connection/client, no launcher
`Bun.sleep`, no delay-owner properties, no Promise-owner property, no lifecycle task registry, no
per-delay class, and exactly one each of `ManagedRuntime.make`, `createUnrefClock()`,
`Schedule.fixed`, delayed heartbeat `Effect.sleep`, and the UI factory call. Registration, snapshot,
producer hello state, command queues, executing work, and resource budgets remain outside Effect.

This removes the native timing owners from the connection and client rather than merely renaming
them there. However, the private lifecycle implementation now owns substantial manual state for
first-attempt Promise projection, manual retry wakeup, native callback-to-Promise bridging, terminal
fences, and one fiber handle per supervisor. The AST gate rejects duplicate owners on the integration
classes and collection-style task registries, but it does not claim those supervisor-local handles
vanished. The ownership graph is narrower, but it is not materially simpler for a reviewer unfamiliar
with Effect.

### Behavior and validation

The frozen treatment harness completed successfully:

- focused validation: 385 passed, 0 failed;
- real Node validation: 4 passed, 0 failed;
- full unit command: exit 0;
- PTY integration: 139 passed, 1 skipped, 0 failed;
- typecheck, lint, dependency boundaries, and public declaration emission: exit 0;
- Bun and Node signed registration plus pending handshake, heartbeat, and reconnect process-exit
  modes: passed;
- Bun build graph rejected a direct `ws` probe and reached no `ws` import from the fixture;
- public declarations contain no Effect, runtime, Scope, Fiber, Cause, Schedule, Duration, Layer, or
  Clock type;
- the bounded defect canary emitted exactly the fixed redacted message and no captured secret;
- existing control test names remained ordered, no assertion count decreased, and no
  skip/todo/only mode was added.

Effect 3.22.1's generic service provision does not replace the default Clock used by
`Effect.sleep`. The treatment therefore uses the dedicated `Effect.withClock(customClock)` around
production supervisor and startup-timing programs. Real Node and Bun subprocesses prove that the
handshake, heartbeat, and reconnect sleeps are unref-aware after that correction. TestContext and TestClock exercise delayed fixed heartbeat catch-up, handshake expiry, reconnect,
one startup retry/manual-wake sequence, stop during foreign settlement, repeated stop/root close,
and defect redaction. Independent review found important startup and closure interleavings that this
coverage missed; those failures are recorded below.

The existing first socket is still constructed synchronously. Public `start()`/`stop()` gates are
still synchronous and terminal, while `settled` separately describes eventual closure. Native
health, credentials, crypto, filesystem, WebSocket, and spawn Promises are not described as
cancelled; terminal gates reject their late commits.

Intentional treatment differences remain:

- delayed `Schedule.fixed` catch-up may differ from native `setInterval` under overrun;
- unexpected lifecycle defects use only `Session broker lifecycle failed unexpectedly.` rather
  than the control's mixed uncaught exception/unhandled rejection channels.

### Independent behavior review

Fresh reviewers reproduced several behavior defects that the frozen characterization corpus did not
cover:

- after a successful startup program finishes, a later `start()` returns a manual-attempt Promise
  with no live program to consume or resolve it;
- when an explicit start wakes a retry wait, recursive waiting races the already-resolved original
  wake signal, so the retained automatic retry can run immediately instead of at its original
  deadline;
- if the client's first synchronous socket construction throws, it has already stored the failed
  connection, so later startup attempts can incorrectly stop at the existing-connection guard. This
  assignment ordering already existed in the control and is a production-relevant bug exposed by the
  experiment rather than a treatment regression;
- closing the process lifecycle directly does not settle an unstarted supervisor and does not set a
  started supervisor's terminal fence, allowing a foreign startup rejection to call `onFailure`
  after lifecycle settlement. The current UI mitigates this path by stopping the client before
  closing the process lifecycle;
- a connection supervisor cannot start again after natural completion, although the outer
  connection API still appears restartable until terminal stop.

These are behavior-gate failures, not merely missing performance evidence. They strengthen the null
result. The experiment stops here rather than repairing them because the independently decisive
footprint, startup, auditability, and ownership-complexity gates have already failed; further fixes
would add machinery without changing the adoption decision.

### Cost

The fixed Effect/runtime cost remains large:

| Measurement                   |       Control |     Treatment |               Change |
| ----------------------------- | ------------: | ------------: | -------------------: |
| minified Bun broker           |      90,116 B |     331,670 B | +241,554 B / +268.0% |
| minified Node broker          |      90,118 B |     331,672 B | +241,554 B / +268.0% |
| compiled Hunk                 | 177,268,864 B | 177,891,456 B |  +622,592 B / +0.35% |
| lifecycle-ready median        |     12.093 ms |     37.875 ms |              +213.2% |
| synchronous stop median       |   0.000911 ms |   0.002795 ms |              +206.8% |
| in-memory registration median |   0.006532 ms |   0.076784 ms |            +1,075.5% |
| command round-trip median     |   0.022964 ms |   0.087214 ms |              +279.8% |
| reconnect generation median   |   1.011449 ms |   1.128991 ms |               +11.6% |

These microbenchmarks are not end-user latency claims, but their direction and the deterministic
bundle/build deltas do not justify the added lifecycle machinery. Treatment RSS was lower in this
single coarse non-isolated observation; the harness explicitly forbids drawing a conclusion from
that sample.

Treatment evidence is stored under `tmp/session-lifecycle-effect/treatment/`:

- `result.json` and `source-identity.json`;
- `ownership-inventory.json` and `semantics.json`;
- `complete-experiment.patch` (SHA-256
  `2227069a83141c9d8a22b91e778f6c7c9a233ae8aff114b3d0db8d141b7d79cb`);
- validation transcripts and `validation/manifest.json`;
- `MANIFEST.sha256` (file SHA-256
  `0c31e4128daef210dcbcd4e0d49d4187ea44cbd98e8fe1c5f137faec8080e22c`);
- `MANIFEST.attestation.sha256` (file SHA-256
  `b6b16e108dcaf23ac66c2feb38e069694f3f49695479830d4d165e2a6ea8b451`).

The Bun 1.3.14 isolated workspace linker placed Effect only under
`packages/session-broker/node_modules`; the frozen `bun:test`-hosted `Bun.build` gate resolved it
only after an ignored root `node_modules/effect` link to the same lockfile store entry was present.
Direct root `Bun.build`, package tests, and real Node resolve the package correctly. This generated
layout dependency is not a production source change, but it weakens clean-install reproducibility
of that one frozen build gate and is an additional reason not to propose adoption.

## Verdict

**Discard Phase 1.** The broader treatment removes the targeted native owners across package
connection timing, Hunk startup/retry, and launcher polling without moving authentication or
resource policy into Effect. It nevertheless fails the behavior gate under independent review, keeps
substantial supervisor-local ownership machinery, remains harder to audit, carries large
deterministic bundle and cold-start costs, and regresses every isolated producer microbenchmark
retained by the harness. The clean-install Bun build-gate resolver caveat further weakens
reproducibility.

Do not begin daemon/adapters Phase 2, production migration, commit, push, PR, merge, or publish.
Independent review should verify this null-result report and the retained artifacts before the
experiment worktree is retired.

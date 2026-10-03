# Session broker Effect lifecycle experiment

Status: Phase 0 control frozen; Phase 1 treatment not started.

## Question

The first experiment replaced only the generic connection's three native timers. It paid Effect's
fixed runtime and audit cost without removing lifecycle ownership. This follow-up asks a narrower,
falsifiable question:

> Can one process-owned Effect lifecycle supervise Hunk's complete producer startup and connection
> path while deleting independent retry/timer ownership across both the generic connection and the
> Hunk client?

This is a disposable experiment, not production migration approval.

## Identities

- Control source: `42d2b9dd2f3144e33080f159f4cc9c2824ad1708`
- Control source description: `fix(ui): restore review stream responsiveness (#942)`
- Required treatment dependency: exactly `effect@3.22.1`, only in
  `packages/session-broker/package.json`
- Required Bun: `1.3.14`
- First experiment patch SHA-256:
  `f02a469527d49034beb5172929b74aa4ad1f7106e5d66cb1cb259fb410f39e56`
- First experiment remains untouched in `/home/bentlegen/Projects/hunk-effect-experiment`.

The control harness records the system Node version, Bun's embedded Node version, OS, kernel,
architecture, lockfile, fixtures, all changed-file identities, and fresh command transcripts. It
creates a complete reconstructable binary patch through a temporary Git index so untracked support
files are included. The first-experiment patch path is optional; when unavailable, evidence records
only its frozen expected hash. Raw evidence lives under ignored `tmp/session-lifecycle-effect/`.

## Scope

Phase 1 may change only the producer lifecycle path:

```text
ensure daemon
-> signed hello/connect
-> register
-> heartbeat/reconnect
-> terminal stop
```

Candidate production modules are:

- `packages/session-broker/src/connection.ts`
- a new private Effect-backed lifecycle module in `packages/session-broker/src/`
- `src/session/broker/brokerClient.ts`
- polling mechanics only in `src/session/broker/brokerLauncher.ts`
- the interactive-process composition root in `src/ui/runInteractiveApp.tsx`

Phase 1 must not change the daemon engine, Node adapter, Bun adapter, authentication,
cryptography, exact validation, broker state, resource budgets, ownership policy, delivery
semantics, browser-review authority, or public Effect-free API style. Phase 2 is forbidden without a
new decision after the Phase 1 gate.

## Frozen control semantics

The treatment must preserve these observations unless this document names an explicit difference:

1. `SessionBrokerConnection.start()` constructs its first socket synchronously, so a construction
   throw escapes synchronously.
2. Heartbeat uses delayed fixed-rate native `setInterval`: activation arms one interval, no heartbeat
   is sent before its first callback, and the runtime owns cadence/catch-up behavior.
3. Producer handshake timeout starts with socket creation and is cleared by activation, close, or
   terminal stop.
4. Reconnect preparation is not cancellable. Stop may win while preparation is pending; the foreign
   Promise still settles, but no new socket may be created afterward.
5. Connection stop is synchronous and terminal. It closes the current socket and refuses future
   starts, but it does not await crypto, reconnect preparation, or app bridge work.
6. Concurrent first `SessionBrokerClient.start()` calls return the same active attempt Promise.
7. A first startup failure is warned once, resolves the public first-attempt Promise, and schedules a
   complete retry. An explicit `start()` while that retry timer is waiting starts an immediate new
   attempt; the existing retry timer remains owned until stop or callback.
8. Client stop is synchronous and terminal. It does not cancel already-started health, credential,
   crypto, filesystem, or detached-spawn work, but late settlement cannot connect, warn, or schedule
   another retry.
9. Launcher lock owners receive a fresh full health-poll timeout after the outer deadline was
   established. This can exceed the nominal startup timeout. Lock release remains in `finally`.
10. Fetch abort timers and TCP socket timeouts are native transport controls, not lifecycle-loop
    ownership targeted by Phase 1.
11. One generic connection object retains registration, snapshot, bridge queue, command budgets,
    and reconnect ownership across socket generations.

## Explicit treatment decisions

These are decisions, not parity claims:

- **Heartbeat:** use a delayed first tick followed by Effect `Schedule.fixed`. Any observable
  catch-up difference from native `setInterval` is reported as a treatment difference.
- **Defects:** `createSessionBrokerProcessLifecycle` accepts the ordinary TypeScript option
  `{ onDefect?: (message: string) => void }`. Unexpected lifecycle defects call it only with the
  fixed text `Session broker lifecycle failed unexpectedly.` This is an intentional replacement for
  today's mixture of uncaught timer exceptions and unhandled Promise rejections. Raw Effect Causes,
  URLs, credentials, payloads, callback values, and defect objects must never reach this hook or the
  console.
- **Shutdown:** public `start()`/`stop()` gates remain synchronous and terminal. A separate internal
  settlement Promise describes eventual scope closure; synchronous stop never claims that async
  finalization has completed.
- **Cancellation:** Effect interruption does not prove cancellation of foreign Promises or detached
  processes. Phase 1 does not add `AbortSignal` to health, credential, crypto, filesystem, TCP, or
  spawn operations. Synchronous terminal/epoch gates prevent late commits while native work settles.
- **Runtime ownership:** `runInteractiveApp` constructs exactly one process lifecycle, runtime, and
  unref-aware Clock and injects it through an ordinary TypeScript façade. There is no package-global
  singleton, fallback runtime, runtime per connection, or Effect import outside the private package
  lifecycle implementation.

## Frozen treatment source shape

The disposable treatment uses these exact mechanical names so Phase 1 evidence is falsifiable:

- implementation classes: `EffectSessionBrokerProcessLifecycle`,
  `EffectSessionBrokerStartupSupervisor`, and `EffectSessionBrokerConnectionSupervisor`;
- `SessionBrokerConnection` owns exactly one
  `connectionSupervisor: SessionBrokerConnectionSupervisor` property. Its complete treatment
  property set is frozen as `socket`, `activeSocket`, `bridge`, `limits`, `queuedMessages`,
  `executingMessages`, `queuedCommandCountBudget`, `queuedCommandByteBudget`, `draining`, `stopped`,
  `registration`, `snapshot`, `producerHellos`, `options`, and `connectionSupervisor`;
- `SessionBrokerClient` owns exactly one
  `startupSupervisor: SessionBrokerStartupSupervisor` property and retains its terminal `stopped`
  commit gate. Its complete treatment property set is frozen as `connection`, `bridge`, `stopped`,
  `lastConnectionWarning`, `credentials`, `waitingForIncumbentExit`, `incumbentLaunchFingerprint`,
  `registration`, `snapshot`, `timing`, and `startupSupervisor`;
- `createUnrefClock()` is the only lexical region allowed to call raw `setTimeout` or
  `clearTimeout`; the process lifecycle calls it at exactly one construction site;
- `runDelayedFixedHeartbeat()` performs the initial `Effect.sleep` and contains the only
  `Schedule.fixed` call;
- `ManagedRuntime.make` occurs exactly once in `processLifecycle.ts`;
- `createSessionBrokerProcessLifecycle()` is called in production exactly once, from
  `src/ui/runInteractiveApp.tsx`.

Conditional AST gates reject native timing calls in converted connection/client paths, `Bun.sleep`
in the launcher, any property outside those exact domain sets, Promise/timer/task/fiber/handle
owners, task registries, per-delay classes, additional runtime/Clock construction, or factory calls
elsewhere. Existing connection queues and `producerHellos` remain allowed only by exact name. These
named mechanical gates do
not prove scheduling, interruption, shutdown, authentication, or resource semantics; independent
review remains mandatory.

## Mechanical ownership inventory

The control owns these independent lifecycle mechanisms:

| Owner              | Mechanism                                   | Phase 1 disposition                   |
| ------------------ | ------------------------------------------- | ------------------------------------- |
| generic connection | reconnect timeout handle                    | delete into one generation supervisor |
| generic connection | heartbeat interval handle                   | delete into one generation supervisor |
| generic connection | handshake timeout WeakMap                   | delete into one generation supervisor |
| Hunk client        | outer reconnect timeout handle              | delete into one startup supervisor    |
| Hunk client        | active startup Promise field                | delete into one startup supervisor    |
| Hunk client        | terminal `stopped` gate                     | retain as public commit fence         |
| launcher           | health deadline/poll loop and `Bun.sleep`   | route through supervised attempt time |
| launcher           | launch-lock ownership and `finally` release | retain as cross-process authority     |
| launcher           | fetch abort and TCP socket timeout          | retain as native transport controls   |

Renaming native timer fields to task/fiber fields, adding equivalent task Sets/maps, or retaining
parallel native scheduling is not ownership reduction.

## Phase 1 gate

Phase 1 is promising only if all of the following hold:

1. The connection's reconnect, heartbeat, and handshake timer ownership becomes one whole-generation
   supervisor with no per-delay task handles or task registry.
2. The client's outer retry timer and startup Promise owner become one startup supervisor.
3. The reduction spans both modules and deletes at least three independent native ownership
   mechanisms.
4. Exactly one runtime and one custom Clock are constructed at the interactive process root.
5. Security/domain state stays explicit and byte-for-byte protocol behavior remains unchanged.
6. Every frozen control characterization remains green, or a difference listed above is measured
   and reported honestly.
7. Bun and real Node authenticate/register where supported and exit with handshake, heartbeat, and
   reconnect maintenance pending. Hunk startup timing is a Bun product path; absence of a stable
   real-Node Hunk startup fixture is recorded rather than simulated.
8. No Effect type appears in public declarations; core and `src/**` do not import Effect; Bun never
   imports or executes `ws`.
9. The bounded reconnect-close-policy canary reaches the fixed defect hook in treatment, its random
   marker appears in no generated text evidence, and the hook/console contain only the fixed message.
   This canary does not claim coverage of credentials, application payloads, finalizers, diagnostics,
   snapshots, or rendered Effect Causes.
10. Independent reviewers can find stop gates, retries, authority rechecks, and releases without
    relying on Effect expertise.
11. Bundle, startup, registration, command, reconnect, stop, CPU, and RSS evidence is recorded. A
    greater-than-25% standalone broker increase requires a material, independently reviewed
    ownership win; the coarse 1 MiB ceiling alone is insufficient.

Failure of any hard boundary, ownership, security, process-exit, or auditability item ends the
experiment as a null result. Phase 2 never starts automatically.

## Evidence protocol

One unchanged harness, `scripts/session-broker-effect-lifecycle-experiment.ts`, collects both arms.
It stores full command transcripts and hashes rather than truncated output. Each arm contains:

- `result.json`
- `source-identity.json`
- `ownership-inventory.json`
- `semantics.json`
- `validation/manifest.json`
- three retained Bun broker bundles and three retained Node broker bundles
- identities and timings for three compiled Hunk builds whose binaries remain in `dist/` and are not
  retained as arm artifacts
- raw warmups/samples for stable local fixtures
- process-exit results
- dependency/declaration/canary evidence
- `MANIFEST.sha256` and `MANIFEST.attestation.sha256`

Every invocation clears the complete arm output first, then itself runs focused tests, the real Node
suite, typecheck, lint, dependency boundaries, the full unit suite, and PTY integration. Non-zero
exit fails the arm; counts are recorded only when a stable Bun/TAP summary can be parsed. A requested
metric without a stable fixture is recorded as `not-measured` with a reason. It is never replaced
with test-command duration or synthetic evidence. Listener acquisition and daemon ordered stop are
unchanged transport context, not producer lifecycle startup/stop. Cold Bun subprocess lifecycle
readiness and synchronous connection stop are the lifecycle measurements. CPU and RSS are coarse,
non-isolated observations from which no strong performance or security conclusion may be drawn.

Treatment invocation additionally requires
`--control-attestation-sha256 <sha256>`. The harness first verifies that external hash against
`control/MANIFEST.attestation.sha256`, verifies the attested `MANIFEST.sha256`, and then verifies
every manifest entry before trusting control identities. It freezes every existing control
experiment-support input hash except the results report, raw evidence, and exactly
`packages/session-broker/src/connection.test.ts` plus `src/session/broker/brokerClient.test.ts`.
Those two tests may change only to inject the process lifecycle: AST evidence requires every ordered
control test name to remain, each matching body to retain at least its control assertion-call count,
and no treatment test to use skip/todo/only. New treatment tests may be added. The plan, harness,
analyzer, source-boundary test, launcher tests, fixtures, and runners remain exact-frozen. This is
mechanical anti-weakening evidence plus independent review, not proof. The parent must anchor the final attestation-file hash outside the arm before
Phase 1. This is local integrity and reproducibility evidence, not a cryptographic signer or trusted
timestamp.

The treatment production change set is exact: `bun.lock`, `packages/session-broker/package.json`,
`packages/session-broker/src/{index,processLifecycle,connection}.ts`,
`src/session/broker/{brokerClient,brokerLauncher}.ts`, and `src/ui/runInteractiveApp.tsx` are the only
allowed production changes. Every item except the optional launcher change is required. Daemon,
adapters, authentication, crypto, validation, core, budgets, and browser-review production files
remain forbidden. The Bun fixture is bundled by `Bun.build` through a `ws`/`ws/*` rejecting
`onResolve` plugin using a package-bundling target, a direct `ws` import probe must fail under that
plugin, and only the produced bundle is executed by Bun. AST specifier checks remain an independent
backstop. Production modules may not import/re-export/require/dynamically import `.test.ts`, `test/`,
`docs/`, `scripts/`, or any experiment-support module. Effect specifier scans include every tracked
or untracked TypeScript source in the repository;
only `processLifecycle.ts` and its unreachable dedicated `processLifecycle.test.ts` may import it.

## Operating constraints

- Use one writer and fresh independent reviewers.
- Do not edit or delete the first experiment.
- Do not commit, push, open a PR, merge, publish, or begin production migration.
- Do not begin daemon/adapters Phase 2 without separate approval.
- A well-attested null result is a successful experiment outcome.

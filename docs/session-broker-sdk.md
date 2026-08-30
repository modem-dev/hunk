# Session broker SDK contract

This document defines the implementation and migration contract for Hunk's reusable local session
broker SDK. **Must**, **must not**, **should**, and **may** are normative. Current code does not yet
meet every requirement; security and compatibility requirements are release gates.

## Product contract

One daemon serves all live sessions/windows for exactly one immutable application identity. The
daemon owns transport, authentication, runtime validation, routing, correlation, reconnect state,
resource bounds, lifecycle, and diagnostics. The application owns payload schemas, command
semantics, authorization/approval policy, and semantic results. `{appId, sessionId}` is the durable
routing namespace; the daemon must never become a cross-application hub.

### Supported environments

The first public release is ESM-only built JavaScript with declarations and supports Node 22+, Bun
1.3.14+, and non-PTY behavior on macOS, Linux, and Windows. Server processes require WHATWG
`Request`, `Response`, streams, and browser-like WebSocket clients. Browser, edge, Deno,
service-worker, and CommonJS builds are unsupported; runtime entries must not expose TypeScript
source.

The export map orders `types`, `bun`, `node`, then `default`, selecting Bun before its Node-compatible
conditions. `default` throws a clear unsupported-runtime error when neither runtime condition is
asserted. Selected entries validate
their minimum version at startup because export conditions neither enforce versions nor prove
runtime identity.

### Non-goals

The first contract excludes remote operation, TLS/proxy trust, cross-machine discovery, service
installation or a system-wide privileged broker, generic UI dispatch/control discovery or an
approval UI, exactly-once execution, and a generic resource protocol without a second non-Hunk
consumer. Hunk retains review documents,
intents, comments, highlights, navigation, reload, resources/SSE, browser-review capabilities, and
all associated UI semantics.

## Ownership and package topology

Publish one package, `@hunk/session-broker`, with protocol/state, daemon/connection, managed-host,
and Node/Bun adapter boundaries kept as internal modules. Its only first-release entry point exports
the shared primitives, broker APIs, supervision, managed producer API, and an automatically selected
`serveSessionBrokerDaemon`. Hunk composes the package; the package never imports `src/*`.

Publication requires verified npm `@hunk` scope ownership and trusted publishing. An approved
replacement name must not alter `appId`, wire identity, or runtime namespaces.

### Portable server API

Both conditional entries re-export the same declarations and implement this narrower-than-native
contract:

```ts
interface SessionBrokerDaemonAddress {
  hostname: string;
  port: number;
}
interface RunningSessionBrokerDaemon {
  readonly stopped: Promise<void>;
  address(): SessionBrokerDaemonAddress;
  stop(options?: { force?: boolean; drainTimeoutMs?: number }): Promise<void>;
}
interface ServeSessionBrokerDaemonOptions<Daemon> {
  daemon: Daemon;
  hostname: string;
  port: number;
  handleRequest?: (request: Request) => Response | Promise<Response | undefined> | undefined;
  notFound?: (request: Request) => Response | Promise<Response>;
  formatServeError?: (error: unknown, address: SessionBrokerDaemonAddress) => Error;
}
declare function serveSessionBrokerDaemon<Daemon>(
  options: ServeSessionBrokerDaemonOptions<Daemon>,
): Promise<RunningSessionBrokerDaemon>;
```

Both implementations resolve only after binding, return a non-null portable address, hide native
handles, and make concurrent `stop()` calls share one idempotent completion. Request hooks receive
only a WHATWG `Request`. The same consumer source must typecheck and pass lifecycle tests unchanged
under Node and Bun. Resolution uses export conditions, not a post-import `typeof Bun` branch. The
single-package convenience tradeoff permits Bun installations to contain `ws`, but Bun must never
import or execute it.

Process discovery/launch remains internally separate from protocol/state and the daemon engine.
Applications inject launch commands, environment, compatibility copy, and approval policy.

### Build and release model

The package ships ESM in `dist/` with declarations, conditional exports, README, license, and no
workspace-only imports. It starts at `0.1.0` and reaches `1.0.0` only after all release gates and use
by Hunk plus one clean external reference consumer. During `0.x`, public API breaks require a minor;
after `1.0.0`, a major.

Package semver governs JavaScript/TypeScript APIs. Broker protocol integers govern generic wire
compatibility, and application protocol integers govern app payload/command compatibility. Wire
changes always update explicit ranges and fixtures regardless of package semver.

## Identity model

### Application and session identity

`appId` is immutable at daemon startup, namespaces runtime state, credentials, principals, logs,
negotiation, and sessions, and is never inferred from package, executable, port, path, cwd, or label.
It is 1–128 lowercase ASCII characters:

```text
[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?
```

Reverse-DNS form such as `dev.hunk` is recommended. Every producer, caller, discovery record,
reconnect proof, and capability must match the configured `appId`.

`sessionId` is opaque, unique within `appId`, cryptographically random by default, and stable across
socket reconnects/content reloads. It is 1–128 ASCII bytes:

```text
[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,126}[A-Za-z0-9])?
```

It is never an index, PID, path, or connection ID. Reusing a retired ID requires a new authenticated
registration and cannot revive commands, reconnect capabilities, or idempotency state.

### Connection identity and reconnect rotation

After authentication/negotiation, the daemon issues a `connectionId` binding one socket to an
immutable producer principal and, after registration, `{appId, sessionId}`. Snapshots, heartbeats,
unregisters, cancellation, and results derive authority from that connection. Message-carried IDs
are consistency assertions only and never confer mutation/result authority.

Replacing a connection requires its reconnect capability and follows this idempotent state machine:

1. The producer proves the same app/session authority, creating a new `connectionId`; this atomically
   supersedes the old socket, invalidates its later messages, and resolves old work by the delivery
   matrix unless already terminal.
2. Before register or reconnect, the producer generates and durably stores a replacement private
   key, then sends
   only its public key and a rotation ID.
3. Signed `registered` commits the transport and records the candidate verifier as pending while the
   previous verifier remains valid.
4. Candidate-signed `registration-ack` promotes it and starts a 60-second dual-key overlap. Signed
   `registration-committed` binds the rotation ID and both verifier IDs.
5. After durably recording that response, the producer sends candidate-signed
   `registration-confirmed`; the daemon then revokes the prior verifier.
6. If confirmation never arrives, overlap expiry revokes the old verifier. Recovery tries candidate,
   then old while valid, then audited producer-bootstrap recovery. Bootstrap creates a new transport,
   rejects uncertain work, and cannot silently replay it.

All messages are idempotent for one rotation ID; during overlap, either key returns the same signed
commit state. Only one pending rotation per session is allowed, and an ID can never name a different
candidate.

### Generic registration and snapshot

The generic app registration envelope requires only `sessionId`, app-validated metadata, and an
app-validated initial snapshot; broker-owned reconnect proof/rotation travels outside that envelope.
Snapshot contains display/ordering timestamp `updatedAt` plus app-validated `state`; timestamps grant
no authority. Validation uses the selected application protocol and precedes commit.

PID, cwd, repository root, launch time, terminal/window/pane IDs, and display labels are optional,
untrusted, size-bounded metadata conventions. They never confer authority. Hunk's adapter continues
to require and project its current fields.

## Protocol and compatibility

### Version and feature negotiation

The initial generic broker protocol is revision `1`. Peers advertise inclusive integer `{min, max}`
broker and application ranges. The daemon selects
the highest overlap; invalid/no overlap returns structured `incompatible-protocol` and a
non-retrying policy close without secrets or stacks. Package versions are not wire revisions.

A producer selects one application revision/features during hello; that remains its session
contract until reconnect. A caller records an application range/features without selecting one
globally. For each target request, intersect caller and daemon support with the target session's
selected singleton revision/features and the exact command descriptor/version; use that exact
contract or fail for that target. Target-independent operations use only the selected broker
revision and report each session's application contract. One daemon may host different compatible
session revisions.

Feature IDs are bounded namespaced strings such as `broker.command-cancel.v1`. Only acknowledged
intersection features may affect behavior. Unknown proposals remain unselected. Safely ignorable
additions may be optional; changes to interpretation, authority, delivery, or required state need a
new revision or negotiated feature.

### Authenticated hello and request flow

Producer ordering is:

```text
hello-init -> hello-challenge -> hello-proof -> hello-ack
          -> register -> registered -> registration-ack
caller request -> command -> command-accepted -> command-result -> caller response
```

Authentication and negotiation precede registration. The producer challenge transcript binds the
endpoint, `appId`, daemon generation, full hello proposal, and fresh initiator/responder nonces. The
producer verifies the daemon signature against owner-private discovery state before signing the
same transcript. Signed `hello-ack` additionally binds selected revisions/features and
`connectionId`; registration cannot repeat mutable negotiation claims. Challenges/incomplete
handshakes are single-use, short-lived, rate-limited, and globally bounded.

HTTP callers use the same nonce/challenge/proof/ack exchange on the control route. The signed ack
returns a short-lived generation-bound `callerSessionId`, selected broker contract, recorded caller
application proposal, and initial sequence; it does not preselect a target revision. WebSocket
caller adapters are equivalent.

Each request carries caller session, caller request ID, and a canonical uint64 decimal sequence:
`(?:0|[1-9][0-9]{0,19})`, at most `18446744073709551615`, parsed with integer/BigInt rather than JSON
number. The signature binds generation, caller session, grant/key ID, hello transcript hash, HTTP
method, canonical path and sorted/encoded query, canonical body digest, request ID, and sequence.
Responses bind the same caller session, request ID, and sequence so signatures cannot cross caller
sessions. Authorization precedes execution and cache lookup. Signed target command envelopes and
signed responses repeat the exact selected application revision/features; producers reject mismatches
before parsing input. Target incompatibility returns a structured error without mutating the caller
session.

Sequence `"0"` is reserved and rejected. Caller sessions initialize `highest = 0` with a zero bitmap,
start allocation at `"1"`, and support 32 concurrent out-of-order requests. A 64-bit bitmap bit `d`
records whether `highest - d` was accepted for `0 <= d <= 63`. For a sequence at or
below `highest`, require that range and an unset bit, then set it. For a sequence above `highest`,
require a delta of at most 64, shift the bitmap by that delta (clearing it at 64), discard expired
history, set the new `highest`, and mark bit 0. Thus accepted candidates span `highest - 63` through
`highest + 64`, while the bitmap stores only the 64 replay-relevant accepted values. Reject
duplicates, older values, and larger jumps. Compare before subtracting rather than computing an
overflowing `highest + 64`; clear rather than shift by 64. The check and bitmap/highest update are one
atomic admission transition per caller session. Libraries allocate monotonically before dispatch,
never reuse a sequence after transport failure, and open a new authenticated caller session before
uint64 exhaustion rather than wrapping.

Responses bind broker revision, target application contract when applicable, generation, request
ID, and structured result/error. Callers renegotiate after daemon restart, not per lower-revision
target. Replayed, expired, wrong-generation, or out-of-window requests fail.

No reusable private capability is transmitted. Private keys or signatures may not appear in URLs,
fragments, argv, health/capability responses, logs, or errors. Raw list/get/dispatch remains disabled by default and requires both authentication and
authorization; `exposeHttpApi: true` alone is insufficient.

### Command descriptors

```ts
interface CommandDescriptor {
  name: string;
  version: number;
  title: string;
  description?: string;
  effect: "read" | "write" | "execute";
  idempotency: "none" | "keyed";
  cancellation?: "none" | "best-effort";
  concurrencyGroup?: string;
  requiredFeatures?: readonly string[];
  inputSchemaId?: string;
  resultSchemaId?: string;
  requiredScopes: readonly string[];
}
interface CommandConcurrencyGroup {
  name: string;
  maxActivePerSession: number;
}
```

Each application revision registers descriptors, parsers, and concurrency groups. Group names use
the feature grammar, references must resolve, and capacity is an integer 1–16. `broker.*` is
reserved; omitted group means immutable capacity-one `broker.session-serial`. Per-group queues start
FIFO; different groups have no relative order and cannot bypass session/daemon limits.

Command identity is exact name/version. `title`/`description` are mutable discovery text. Schema IDs
are metadata, not validators. Input/result parsers are keyed by application revision, canonical
feature set, and command/version. Required features must be selected before parsing. Effect informs
but never replaces authorization, approval, or audit policy.

### Rolling compatibility

Binary/package mismatch alone cannot kill a daemon. Compatible peers attach when ranges, required
features, and authentication overlap. Replacement requires an authenticated identity probe,
incompatible required contract, app authorization, exact generation-safe shutdown, and explicit
degradation/reconnect behavior for affected sessions. A PID from health/stale metadata is never enough; compatible
instances remain even across executable versions.

Implementations should retain the prior broker revision for at least one minor compatibility window
when safe. Removal requires golden migration tests and release notes.

## Runtime validation

Every external boundary receives `unknown`; TypeScript generics and schema IDs are not validators.
Authoritative parsers cover discovery/coordinator/identity responses, every hello/envelope,
credentials and capability claims, registration/snapshot, selectors/deadlines/idempotency, command
input/result for the exact contract, and cross-process health/capabilities. App validator registries are keyed by app and command
revision.

Failures return stable codes without stacks/parser internals, commit no partial mutation or result,
and close producers when stale assumptions would remain. Reject binary WebSocket frames with `1003`
and malformed discriminants, numbers, and versions rather than casting them. Native per-message caps
reject oversized frames before application decoding: Node's `ws` reports `1009`, while Bun 1.3 may
surface its non-configurable abnormal `1006` because it does not invoke the application callback.

## Local security contract

### Threat model and credentials

Supported defenses cover other OS users, DNS rebinding/cross-origin browsers, accidental
non-loopback exposure, local processes without capabilities, and one producer attacking another.
They do not sandbox malware already able to read the same user's files/memory.

The host creates a private per-user/per-`appId` runtime directory: Unix directory `0700`, credential
files `0600`; Windows owner-only ACLs with unsafe ownership/reparse states rejected. Validation fails
closed.

The supervisor creates independent Ed25519 key pairs for coordinator discovery, producer bootstrap,
trusted caller bootstrap, and daemon identity. Private keys stay in owner-only material/authorized
memory. Discovery publishes only key IDs/public verifiers; the daemon stores verifiers and immutable
grants, never replayable secrets.

A grant fixes `appId`, principal ID, key ID/algorithm, optional `sessionId`, allowed operations and
command names/versions, issue/expiry times, revocation ID, and whether narrower delegation is
allowed.
Capabilities require proof of possession. Through a generation-bound signed caller session, a
`capability:issue` holder may submit a locally generated subject public key and requested subset;
the app authorizer must approve it. The daemon never returns the subject private key, which the app
delivers through owner-private storage, inherited descriptor, or app channel. Delegation cannot
broaden scope, lifetime, or session authority.

Bootstrap grants are installed at startup and invalidated by rotation/generation replacement.
Session retirement invalidates reconnect/session grants. Revocation precedes authorization and
cached-result lookup. Nonces, sessions, signatures, grants, and replay windows are bounded/expiring.

Every Ed25519 signature covers a domain-separated RFC 8785 canonical JSON transcript containing the
protocol domain, `appId`, generation, key/grant ID, endpoint or canonical HTTP target, challenge
nonces or caller session/sequence, request ID, negotiated transcript hash/revisions/features, and
SHA-256 body digest as applicable. Golden fixtures define exact transcripts; ambiguous concatenated
strings are forbidden.

### Principals and authorization

```ts
interface ProducerPrincipal {
  appId: string;
  principalId: string;
  scopes: readonly string[];
}
interface CallerPrincipal {
  appId: string;
  principalId: string;
  sessionId?: string;
  operations: readonly string[];
  commands?: readonly string[];
}
```

Authentication proves a grant key; authorization separately decides operation/session/command
access and defaults to deny. Scopes distinguish registration/reconnect, list, snapshot read,
dispatch, command families, diagnostics, and shutdown. `write`/`execute` need explicit scope and app
authorization; apps may add interactive approval. The SDK supplies hooks/cancellation context, not UI.

Audit hooks receive redacted principal/verifier ID, app/session, operation, command/version, request
ID, decision, timestamps, and outcome—not capabilities or full payloads by default.

### Loopback, Host, Origin, and browser review

Adapters refuse non-loopback binds and hostnames resolving to any non-loopback address. One shared
IPv4/IPv6 parser derives exact `(scheme, normalized host, port)` authorities from listeners and
trusted same-origin aliases. Reject missing, malformed, duplicate/comma-joined, ambiguous, or
non-allowlisted `Host` on HTTP and upgrades. Native clients may omit `Origin`; reject `null`,
multiple, non-HTTP(S), or non-allowlisted origins. Emit no permissive CORS by default.

Minimal unauthenticated health exposes liveness only—no PID, counts, paths, snapshots, useful
versions, or capabilities. Detailed diagnostics require admin scope. Generic remote mode and unsafe
remote options are forbidden pending authenticated encryption, certificate/key lifecycle, proxy and
deployment policy, discovery design, and new security review. Hunk may temporarily isolate its
unsupported `HUNK_MCP_UNSAFE_ALLOW_REMOTE` escape hatch.

Hunk browser review keeps independent per-session/per-review capabilities and same-origin/no-CORS
policy. Daemon producer/caller authority must not grant review access.

## Command delivery and backpressure

### Delivery guarantee

The broker makes at most one automatic delivery attempt and never promises exactly-once execution.
Request state is monotonic: `received -> authorized -> queued -> written -> accepted -> completed`,
with rejection/terminal exits. The first terminal transition wins.

| State at terminal cause                       | Outcome                          |
| --------------------------------------------- | -------------------------------- |
| `received`, `authorized`, `queued`            | cause `status` + `not-delivered` |
| `written`, before validated acceptance/result | cause `status` + `unknown`       |
| `accepted`, before terminal result            | cause `status` + `delivered`     |
| validated producer rejection                  | `rejected` + `delivered`         |
| validated success result                      | `completed` + `delivered`        |

Every response separates `status` (`completed`, `rejected`, `timed-out`, `cancelled`,
`disconnected`, or `shutdown`) from `deliveryCertainty` (`not-delivered`, `delivered`, or `unknown`). `delivered` means producer admission, not
side effects. Once writing may have occurred, missing acceptance does not prove non-delivery.
Disconnect, replacement, timeout, cancellation, forced stop, and drain expiry never replay work.
Graceful stop reports queued as `shutdown/not-delivered`, written-unaccepted as `shutdown/unknown`,
and accepted as `shutdown/delivered`.

### Ordering, limits, and accounting

Default scheduling is capacity-one per-session FIFO through `broker.session-serial`; opt-in groups
follow their descriptor capacities and per-group FIFO.

| Resource               | Initial default                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions and commands  | 256 sessions/daemon; 64 queued+in-flight/session; 1,024/daemon; 32 queued+executing through one producer bridge; one active/session by default                                           |
| Handshakes             | Per daemon: 64 unauthenticated/challenged sockets, 128 incomplete records, 4 MiB incomplete bytes; 64 KiB/proposal                                                                       |
| Callers and HTTP       | Per daemon: 256 caller sessions at 8 KiB each/2 MiB total, 32 concurrent controls, 64 MiB in-flight body bytes; 4 MiB maximum decoded request; 8 MiB maximum decoded/aggregated response |
| WebSocket              | 8 MiB native inbound message cap; 64 MiB broker-owned delivered-message processing/daemon; 64 socket admissions; buffered outbound: 8 MiB/peer and 64 MiB/daemon                         |
| Retained session state | 4 MiB metadata+snapshot/session; 256 MiB/daemon                                                                                                                                          |
| Command data/time      | 1 MiB validated input/entry; 64 MiB queued-command bytes/daemon; 15 s default timeout; 5 min caller maximum                                                                              |
| Idempotency            | 1,024 entries/session; 65,536 entries/daemon; 10 min TTL; 1 MiB result/entry; 64 MiB/daemon                                                                                              |

Hosts may lower limits. Raising a public network/body/frame/buffer ceiling requires explicit
unsafe-limits configuration and is outside supported defaults. App validators add tighter
collection, string, nesting, state, and command limits.

Overflow returns structured `busy`, `queue-full`, or `capacity-exceeded`. Native WebSocket frame
assembly and runtime-owned queues are outside broker byte accounting; adapters bound them per message
with the native cap and bound peer count at socket admission. Once a message is delivered, reserve its
bytes before broker decode/parse/handling and release in `finally`. Unavailable socket-count admission
returns `503`; unavailable delivered-message capacity or slow-peer outbound overflow closes with
retryable `1013`. Unwritten work is `not-delivered`; written work follows the delivery matrix. Reserve
outbound serialized bytes per peer/daemon until flush/close. HTTP readers reserve the permitted source
maximum before the first pull, resize to actual bytes, and require aggregate capacity for the
source-plus-copy peak before retaining the merged body; unavailable capacity returns `503`.
Unauthenticated overload allocates no handshake state. Response overflow fails before unbounded
aggregation. New-session failure never evicts existing state.

Registration/snapshot replacement and queue/ledger insertion reserve aggregate bytes before commit,
leaving prior state on failure. Byte accounting uses retained UTF-8 bytes plus fixed overhead. The ledger
stores canonical input digests, not bodies; oversized keyed results fail `result-too-large`.
Reclamation may remove expired/terminal LRU entries, never in-flight entries. Full bridge queues fail
the new request when possible rather than retaining it. No overflow silently drops work or grows
memory.

Disconnected sessions lose live registration/snapshot and retain only separately bounded reconnect
authority. Managed producers retain current registration/latest snapshot, coalescing intermediates;
commands are never queued across disconnection.

### Idempotency

`keyed` commands require a key; `none` rejects one as `unexpected-idempotency-key`. Keys use the
session-ID grammar, 1–128 bytes, and scope to `{appId, sessionId, callerPrincipalId,
selectedAppProtocolRevision, selectedFeaturesHash, commandName, commandVersion, key}`. Feature hash
is SHA-256 over sorted selected IDs; content digest is SHA-256 over RFC 8785 canonical validated
input.

Authorization/approval precedes ledger lookup. Same scope/key/digest returns a terminal result or
joins in-flight work; another digest is `idempotency-conflict`. Only the originating caller
principal or an explicit administrative capability may cancel joined work. The daemon owns one bounded in-memory TTL ledger; host libraries own key/retry policy,
not cached results. Restarts lose dedupe evidence, so retries remain app-owned with unknown delivery
unless durable app evidence exists.

### Cancellation and timeout

Cancellation is negotiated, best effort, and limited to the originating caller principal or an
explicit administrative capability. Advertised commands get
`AbortSignal` and may receive wire `cancel`; broker cancellation does not prove rollback. Late results
are audited/ignored and never resolve newer requests. Runtime-validated deadlines are bounded; local
scheduling uses an injected monotonic clock where possible, while wire deadlines remain explicit
timestamps with documented skew limits.

## Session and daemon lifecycle

### Heartbeats, idle, and stop

Heartbeat interval is 10 seconds, stale TTL 45 seconds, and sweep interval 15 seconds. A maintenance
gap beyond stale TTL indicates suspension: set `recoveryUntil = now + staleSessionTtlMs`; no health,
manual, or scheduled pruning may occur before it, and later observations cannot shorten it. Sessions
must heartbeat during recovery or may be removed on the first eligible sweep. Removal rejects
pending commands with an explicit stale/disconnected outcome and follows reconnect-retirement policy.

Default idle timeout is 60 seconds and may be disabled. Idle starts only with no sessions, queued or
pending commands, authenticated requests still being handled, active streams, or configured grace
work. Minimal
health does not reset idle; authorized control may. The daemon publishes `stopping` before teardown.

Graceful stop atomically refuses new work; resolves queued/unwritten as `shutdown/not-delivered`;
asks producers to close/reconnect when negotiated; drains in-flight work for five seconds by default;
then resolves it by the delivery matrix, closes WebSockets/listener, releases generation-owned
state, and resolves `stopped` once. Forced stop skips drain, immediately rejects work, and closes
active transports. Repeated/concurrent stops share the same completion across Node/Bun.

## Discovery, singleton launch, and ownership

The target uses an owner-private per-application coordinator and random broker endpoint. Because
this changes Hunk's fixed default port, Phase 4 must stop for explicit approval; denial requires a
revised fixed-endpoint contract with collision/foreign-listener tradeoffs.

### Election and takeover

Runtime paths derive from encoded/digested stable `appId`, never display name, port, executable, or
package. A candidate daemon—not its launching app—owns election and retains the winning coordinator
socket:

1. Bind a random loopback coordinator port; create generation ID, daemon key, PID+start-token
   fingerprint, and initialization deadline.
2. Atomically create-if-absent a complete owner-private `initializing` record naming that bound
   candidate/public key. Use complete temp inode plus no-replace (or equivalent Windows primitive)
   and directory sync where supported.
3. A loser closes and exits; hosts reread/wait for authenticated readiness.
4. A winner starts the random broker endpoint, verifies the record still names its exact generation,
   publishes `ready` atomically, and retains the coordinator bind.

The record is rendezvous metadata; retained exclusive bind plus authenticated challenge proves live
authority. PID/endpoint metadata alone never authorizes signaling.

Takeover requires the elapsed initialization deadline (or ready-endpoint failure window equal to the
startup timeout), no authenticated coordinator response, and proof the recorded PID+start token is
dead/reused. Live, hung, sleeping, inaccessible,
or indeterminate owners are conflicts. A contender takes an owner-private exclusive lock, rereads,
and requires unchanged generation/content digest before atomically retiring the record and
publishing a new generation. Losers close/release
and reread. Old candidates revalidate generation before ready and every handshake; after ownership
change they exit without touching new state. Cleanup requires the lock and matching generation/digest.

Coordinator discovery returns `appId`, generation, broker endpoint, broker range/discovery features,
and ready/stopping state—never private keys. Clients verify fresh identity/generation before an
authenticated session; generation/transcript-bound signatures prevent stale/foreign credential
collection. Foreign listeners, unsafe ownership, malformed records, wrong app, or failed challenge
produce fail-closed conflicts, never termination.

### Launch and shutdown ownership

The host injects app identity, runtime base, executable/args, environment allowlist, identity and
compatibility probes, clock/sleep/spawn/PID effects, deadlines, and app error formatting. Concurrent
hosts may spawn candidates, but all use the authenticated winner. Cleanup/termination must prove
exact `appId` and generation; PID is diagnostic only. Endpoint overrides remain in the same
coordinator namespace and cannot create a second daemon.

## Selectors and metadata

`SessionSelector` has optional `sessionId`. The default resolver selects it exactly; omission succeeds
only with one session, otherwise returns no-session/ambiguity. Apps may inject a validated,
deterministic, non-mutating resolver over read-only session views, returning one ID or structured
no-match/ambiguity.

The optional developer-tools plugin preserves precedence `sessionId`, `sessionPath` matching exact
live `cwd`,
nearest containing `repoRoot` respecting optional `repoBoundary`, then sole-session fallback.
Project-boundary/VCS discovery remains app-owned; the SDK knows no `.git`, `.hunk`, provider, or
extension semantics. Selector metadata remains untrusted, bounded, and non-authoritative.

## Hunk composition and migration

Hunk owns its session schemas/projections/errors; review documents/publication generations,
resources/cache/assembly, comments/highlights/navigation/reload/intents; HTTP actions lowering to
`createHunkSessionBridge`; browser routes/SSE/capabilities/digest verification; VCS boundary
discovery; and executable launch/upgrade copy. Generic state removes Hunk-shaped projections; Hunk
builds them from read-only generic entries/events, and the package never imports Hunk types.

| Existing contract                                    | Migration requirement                                                                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUNK_MCP_HOST`, `HUNK_MCP_PORT`, `HUNK_MCP_DISABLE` | Preserve in Hunk adapter for at least one documented minor window.                                                                                                    |
| `HUNK_MCP_UNSAFE_ALLOW_REMOTE`                       | Temporary unsupported Hunk-only escape hatch; never generic.                                                                                                          |
| runtime directory `hunk-mcp`                         | Preserve or dual-read so old/new binaries cannot race separate namespaces.                                                                                            |
| default `127.0.0.1:47657`                            | Winning candidate reserves/retains it as guard before coordinator publication; explicit port reserves that endpoint in the same namespace.                            |
| `/session`, `/session-api`                           | Preserve CLI semantics but require new authentication; old clients get actionable upgrade refusal.                                                                    |
| `/mcp` returns `410`                                 | Retain until separately deprecated.                                                                                                                                   |
| incompatible daemon                                  | Never signal from unverifiable PID. Interactive Hunk waits and retries until the incumbent exits while idle; forced replacement requires an authenticated generation. |
| missing `repoBoundary`                               | Preserve containment fallback; new clients may provide VCS-aware boundary.                                                                                            |

Security outranks wire compatibility: no migration accepts unauthenticated control/registration.
An interactive Hunk window keeps reviewing locally while an incompatible or pre-authentication
incumbent owns the endpoint. After the first signed-handshake refusal it polls only minimal health,
so repeated WebSocket closes cannot postpone the incumbent's idle timeout; once health disappears,
the same bounded connection object reruns discovery, signed negotiation, and registration. One-shot
session commands fail promptly with instructions instead
of becoming a second restart owner. Daemons too old to retire while idle, or hung incumbents, still
require manual termination. Preservation means paths, selectors, outputs, and automatic credential
discovery for upgraded clients—not interoperability with pre-authentication binaries.

Hunk's fixed-endpoint Phase-1 credential store uses a home-local `.hunk` parent when
`XDG_RUNTIME_DIR` is unavailable, rather than a predictable name in a shared temporary directory.
It inherits the current user's ACL when it creates the `hunk-mcp/security-v1` directory
on Windows and rejects symbolic-link redirection. Node does not
provide a portable owner/DACL or general reparse-point inspection API, so this integration cannot
detect a pre-existing custom permissive DACL or every non-symlink reparse point; completing native
Windows ACL validation remains a release-gate item before the reusable package is published.

The fixed-endpoint integration authenticates bootstrap reconnects, distinguishes `register` from
`reconnect` scope, atomically retires the previous socket, and rejects its uncertain work. Retained
producer authority is rechecked before inbound mutations and before any queued command bytes leave
the daemon. It does
not yet claim the durable candidate-key `registered`/`registration-ack` rotation sequence above;
that sequence remains a publication gate rather than an unauthenticated compatibility fallback.

Before publishing even `initializing`, a Hunk candidate binds and retains the legacy guard endpoint;
only its holder may enter coordinator election. A contender unable to bind waits a bounded startup
interval for authenticated coordinator publication, then reports an unverifiable listener and launches
nothing. The winner rolls back/exits if guard retention fails and cannot become ready without it.
The guard provides upgrade/auth refusal and routes supported upgraded traffic. Explicit
`HUNK_MCP_PORT` becomes the actual reserved endpoint, not a second random endpoint. Unverifiable
incumbents are never signaled. Generic discovery never publishes the browser-review secret. Before
changing defaults, Phase 4 tests concurrent candidates, guard-before-publication, rollback, explicit
ports, and mixed old/new failures.

## Release gates

No public release may proceed while any gate fails; unresolved critical/high security findings block.

### Security gate

- Independent review covers ownership, capabilities, Host/Origin, discovery permissions, shutdown,
  and leakage. Adversarial tests prove socket B cannot supersede, snapshot, heartbeat, unregister,
  cancel, or answer for socket A without authenticated reconnect, and superseded sockets cannot
  mutate or resolve later work.
- Missing, malformed, wrong, expired, rotated, and revoked credentials fail without leaks; list, get,
  dispatch, command, and admin scopes are isolated; raw HTTP requires authentication+authorization.
- Browser-review authority remains narrow; secrets never enter URLs, logs, health/capabilities,
  errors, bodies, argv, or non-credential metadata.
- Node/Bun share parser fuzz/property and binary/frame/body/queue/buffer limits.
- Owner permissions, symlink/reparse handling, and atomic publication pass Linux, macOS, and real
  Windows; supported configuration refuses remote binds.

### Compatibility gate

- Hand-authored old/new producer/daemon/caller matrices and golden fixtures cover highest overlap,
  structured no-overlap, every revision/feature transition, and descriptor/validator agreement;
  unknown or unselected features cannot change behavior.
- Hunk env/path/guard/selectors/routes, old-client refusal, and mixed-version fail-closed flows remain
  tested.
- Replacement proves app identity/exact generation; documentation separates wire and package versions.

### Runtime and packaging gate

- The tarball contains built ESM, declarations, README, license, and intended exports only—no source,
  tests, credentials, runtime artifacts, local files, or unresolved `workspace:*`.
- Fresh external projects install that tarball and complete
  register/list/get/dispatch/result/reconnect/shutdown on Node 22 and Bun 1.3.14; Node tests use no
  Bun globals or `bun:test`.
- NodeNext and bundler consumers compile without repo aliases. Conditional entries share public API,
  lifecycle, and transport suites; Bun selects its entry and never loads `ws`.
- Changesets/publish dry-run succeeds; npm scope ownership, provenance, and trusted publishing are verified.

## Phased implementation

| Phase | Required outcome                                                                                                                                                                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Fix connection ownership, signed producer/caller authentication, fixed Hunk `appId`, broker revision `1`, current Hunk app revision as a singleton, empty generic features, authorization, validation, and bounds without an unauthenticated transition. |
| 2     | Achieve Node/Bun frame, size, shutdown, and machine-sleep parity.                                                                                                                                                                                        |
| 3     | Generalize identity/ranges/features/descriptors/registration/selectors while preserving Hunk's developer-tools plugin; prove Phase 1 is its one-element wire case.                                                                                       |
| 4     | After explicit approval, implement private-credential coordinator discovery, guard migration, supervision, and generation-safe ownership.                                                                                                                |
| 5     | Compose supervision, negotiation, connection, reconnect/rediscovery, registration/snapshots, warnings, and ordered shutdown into managed host API.                                                                                                       |
| 6     | Build, pack, install, test, and verify npm scope/trusted publication; do not publish without explicit approval.                                                                                                                                          |
| 7     | Adopt in Hunk, remove obsolete paths, preserve semantics, run end-to-end flows, reconcile historical TODOs, and complete independent review.                                                                                                             |

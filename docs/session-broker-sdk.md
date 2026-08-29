# Session broker SDK contract

This document defines the implementation contract and phased migration boundary for Hunk's reusable
local session broker SDK.

The normative words **must**, **must not**, **should**, and **may** describe requirements for the public SDK. Current code does not yet satisfy every requirement. Security and compatibility requirements below are release gates, not optional follow-up work.

## Product contract

The SDK lets one application identity run one shared local daemon for all of its live sessions or windows:

```text
one application identity
        |
        +-- one local daemon generation
                |
                +-- session/window A
                +-- session/window B
                +-- session/window C
```

The daemon owns transport, authentication, runtime validation, target routing, command correlation, reconnect bookkeeping, resource bounds, lifecycle, and diagnostics. The application owns registration and snapshot schemas, command meaning, authorization and approval policy, and semantic results.

A daemon is configured for exactly one immutable `appId`. It must not become a universal hub for unrelated applications. `{appId, sessionId}` is the durable routing namespace even though `appId` is constant inside one daemon.

### Supported environments

The first public release supports:

- ESM-only built JavaScript and `.d.ts` declarations;
- Node.js 22 or newer through the package's Node conditional export;
- Bun 1.3.14 or newer through the package's Bun conditional export;
- macOS, Linux, and Windows for non-PTY behavior;
- server processes with WHATWG `Request`, `Response`, streams, and browser-like WebSocket clients.

“Runtime-neutral” means server-capable Node and Bun. It does not mean browser, edge-worker, Deno, or service-worker compatible. Package builds target the declared minimum runtimes and must not expose TypeScript source as the runtime entry point.

The one package declares both runtimes after clean consumers pass on both. Its export map selects
the Bun implementation before the Node implementation because Bun may expose Node-compatible
conditions too. The `default` entry applies only when neither `bun` nor `node` is asserted and
throws a clear unsupported-runtime error. Each selected runtime entry separately validates its
minimum runtime version at startup; conditional exports alone do not enforce version floors or
prove runtime identity.

### Non-goals

The first public contract does not include:

- one system-wide daemon shared by unrelated applications;
- remote daemon operation, TLS termination, reverse-proxy trust, or cross-machine discovery;
- browser, edge, Deno, or CommonJS builds;
- generic UI dispatch, UI-control discovery, or an approval user interface;
- Hunk's review document, `ReviewIntent`, comments, highlights, navigation, reload semantics, resources, SSE protocol, or browser-review capability;
- exactly-once command execution;
- a generic resource publication protocol before a second non-Hunk consumer demonstrates one;
- service installation or a system-wide privileged broker.

## Ownership and package topology

Publish one package: `@hunk/session-broker`. Keep the existing core, daemon, host, and runtime
adapter boundaries as internal modules, not independently versioned npm products.

The package root is the normal and only first-release entry point. It exports low-level protocol and
state primitives, the broker/connection APIs, process supervision, the managed producer session,
and one `serveSessionBrokerDaemon` API whose implementation resolves automatically for the current
runtime. Consumers do not install or import a Node- or Bun-specific package or subpath.

The `@hunk` scope is the selected naming contract, but publication is blocked until a repository
owner verifies npm scope control and trusted-publisher configuration. If the scope is unavailable,
the replacement must be approved before the first publication. Renaming the package must never
alter `appId`, wire identity, or runtime namespaces.

### Package and internal dependency diagram

```text
@hunk/session-broker
  public conditional root
        |
        +-- shared protocol, parsers, selectors, limits, state
        +-- broker daemon + producer/caller connections
        +-- endpoint supervision + managed producer session
        +-- serveSessionBrokerDaemon
              |
              +-- "bun" condition  -> Bun.serve adapter
              +-- "node" condition -> node:http + ws adapter
              +-- default           -> unsupported-runtime error

Hunk src/session and src/app compose the package.
The package never imports src/*.
```

The export map orders `types`, `bun`, `node`, then `default`. Bun and Node runtime entry files
re-export the same shared public surface. Runtime choice does not change application source or
declarations. The common server contract is deliberately narrower than either native server:

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

Both implementations are async at the public boundary, resolve only after binding, return a
non-null portable address, and hide Bun/Node native handles. Custom request hooks receive only a
WHATWG `Request`; runtime-specific server objects are not public. `stop()` is idempotent and shares
one completion across concurrent calls. The same clean consumer source must typecheck and complete
the lifecycle suite unchanged against both conditional entries. Resolution uses package
conditions, not `typeof Bun` branches after loading incompatible modules. The Node entry may load
`ws`; accepting a small unused dependency in Bun installations is the explicit convenience
tradeoff of one automatically resolving package, but the Bun runtime must never import or execute
it.

Process discovery and launch policy remains internally separate from protocol/state and the daemon
engine. Application-specific launch commands, environment variables, compatibility copy, and
approval policy are injected into the supervisor/managed-host module.

### Build and release model

Today the four existing workspaces are private `0.0.0` packages, export TypeScript from `src/`, use
`workspace:*` dependency ranges, and claim unverified Node 18/Bun 1.0 engine floors. The managed
host module does not exist yet. Those are internal implementation facts, not the public support
contract. Extraction consolidates those workspaces into one publishable package while preserving
their useful module boundaries in source.

The public package ships ESM in `dist/` with declarations, a conditional export map, README,
license, source maps when enabled consistently, and no workspace-only imports. Its first public
version will be `0.1.0`; it may reach `1.0.0` only after the release gates in this document pass and
the API has been exercised by Hunk plus at least one clean external reference consumer.

Package semver and wire versions are independent:

- package semver governs JavaScript and TypeScript API compatibility;
- broker protocol integers govern generic wire compatibility;
- application protocol integers govern app-owned payload and command compatibility.

During `0.x`, a breaking public API change requires a minor version. After `1.0.0`, it requires a major version. A wire change always updates its explicit range and fixtures regardless of the package bump.

## Identity model

### Application identity

`appId` is a stable, globally meaningful application identifier. It:

- is configured when the daemon starts and is immutable for that daemon;
- is not supplied as a routing choice after startup;
- namespaces runtime files, credentials, protocol negotiation, principals, logs, and sessions;
- is never inferred from a package name, executable path, port, working directory, or display label.

The initial grammar is 1–128 lowercase ASCII characters:

```text
[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?
```

Reverse-DNS identifiers are recommended, for example `dev.hunk`. A daemon rejects a producer, caller, discovery record, reconnect proof, or capability whose `appId` differs from its configured identity.

### Session identity

`sessionId` is the universal target identifier. It is:

- opaque and unique within one `appId`;
- 1–128 ASCII bytes matching
  `[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,126}[A-Za-z0-9])?`;
- generated with cryptographic randomness by default;
- stable for one logical live session across socket reconnects and content reloads;
- never a runtime array index, list position, PID, path, or connection identifier.

The ASCII grammar makes byte and character length identical and rejects whitespace, control
characters, path separators, and leading or trailing punctuation. UUIDs are recommended but not
required. Reusing a retired `sessionId` requires a new authenticated registration and must not resurrect old pending commands, reconnect capabilities, or idempotency state.

### Connection identity

After authentication and negotiation, the daemon issues a `connectionId` for one transport incarnation. It binds the socket to an immutable producer principal and, after registration, to `{appId, sessionId}`.

Snapshots, heartbeats, unregisters, cancellations, and command results derive ownership from that connection. A message-carried `sessionId` is removed where possible; if retained for diagnostics, it is only a consistency assertion. A message-carried `requestId` never grants authority to resolve that request.

Replacing a session connection requires the session reconnect capability. A successful reconnect:

1. authenticates the producer and proves the same `{appId, sessionId}` authority;
2. creates a new `connectionId` and presents a producer-generated reconnect public key;
3. atomically supersedes the old connection;
4. resolves old in-flight commands using the delivery state/certainty matrix below unless they
   already reached a terminal result;
5. makes every later mutation or result from the old connection invalid.

Reconnect-key rotation uses an idempotent three-message commit. Before register/reconnect, the
producer generates the replacement key pair and durably stores its private key, then presents only
the public key and a rotation ID. The signed `registered` response commits the new transport and
records the candidate verifier as pending while the previous verifier remains valid.
`registration-ack`, signed by the candidate key, promotes the candidate but starts a 60-second
dual-key overlap instead of immediately revoking the previous verifier. The daemon replies with a
signed `registration-committed` binding the rotation ID and both verifier IDs. The producer durably
records that confirmation and sends `registration-confirmed` with the candidate key; only then does
the daemon revoke the previous verifier.

All messages are idempotent for one rotation ID. During overlap, either key returns the same signed
commit state. If the final confirmation never arrives, the daemon revokes the old verifier when the
bounded overlap expires; a producer that missed the commit tries the candidate first, then the old
key while overlap remains, and finally uses the audited bootstrap-recovery path. The daemon permits
at most one pending rotation per session and never accepts a different candidate under the same
rotation ID. The producer bootstrap credential can recover a session whose
rotation cannot be completed, but recovery creates a new transport incarnation, rejects uncertain
work, and is audited.

### Generic registration and snapshot

The new generic registration envelope requires only:

- `sessionId`;
- app-owned `metadata`, validated for the selected application protocol;
- an initial app-owned snapshot, validated before registration commits.

The snapshot envelope requires:

- `updatedAt`, a valid timestamp used for display/ordering rather than authority;
- app-owned `state`, validated for the selected application protocol.

Process and developer-tool facts become optional metadata conventions:

- PID;
- working directory;
- repository root;
- launch timestamp;
- terminal/window/pane identifiers;
- display title or label.

They are not universal arbitrary-application requirements and never confer authority. Hunk's migration adapter continues to require and project its current fields.

## Protocol and compatibility

### Version ranges

The initial negotiated generic broker protocol is revision `1`. Peers advertise inclusive integer ranges:

```ts
interface ProtocolRange {
  min: number;
  max: number;
}
```

The daemon selects the highest mutually supported revision. Invalid ranges or no overlap produce a structured `incompatible-protocol` response followed by a non-retrying policy close. The error may include supported ranges and required feature names, but no secrets or internal stack traces.

Application protocol uses the same range mechanism and is configured by the app. It versions registration metadata, snapshots, command inputs, and command results. Broker and application ranges are negotiated independently; package versions are not sent as substitutes for either.

A daemon may simultaneously host sessions using different selected revisions within its configured
support range. A producer connection selects exactly one application revision and feature set at
hello; that singleton remains the session's application contract until reconnect renegotiates it.
Caller hello records the caller's application range but does not select one globally. Each
target-dependent request intersects the caller range and daemon range with the target session's
already-selected singleton revision. It either uses that exact revision or fails incompatibly; the
exact command/version and required features must also exist in the target session's selected set.
List and other target-independent broker operations use only the selected broker revision and
return each session's selected application revision/features.

### Feature discovery

Feature identifiers are bounded, namespaced strings such as `broker.command-cancel.v1`. Negotiated features are the intersection allowed by the selected broker and app revisions. Unknown features are ignored only as unselected proposals; a peer must not silently use one that was not acknowledged.

Additive data that an older peer can safely ignore may remain optional in an existing revision. Behavior that changes interpretation, authority, delivery, or required state needs a new revision or an explicitly negotiated feature.

### Producer hello and registration flow

```text
producer session              one-app daemon                 caller / agent
      |                              |                              |
      |-- hello-init --------------->|                              |
      |   appId, ranges, features,   |                              |
      |   key id, initiator nonce    |                              |
      |<-- hello-challenge ----------|                              |
      |   responder nonce, generation|                              |
      |   signed daemon transcript   |                              |
      |-- hello-proof -------------->|                              |
      |   signed full transcript     |                              |
      |<-- hello-ack ----------------|                              |
      |   signed selected revisions, |                              |
      |   features, connectionId     |                              |
      |-- register ----------------->|                              |
      |   sessionId, reconnect       |                              |
      |   proof if replacing,        |                              |
      |   metadata + snapshot        |                              |
      |<-- registered ---------------|                              |
      |   pending reconnect rotation |                              |
      |-- registration-ack --------->|                              |
      |                              |<-- caller hello/proof --------|
      |                              |--> selected revisions/session |
      |                              |<-- signed request ------------|
      |                              |   selector, operation or      |
      |                              |   command/version/input       |
      |<-- command ------------------|                              |
      |   exact app revision/features|                              |
      |-- command-accepted --------->|                              |
      |-- command-result ----------->|                              |
      |                              |-- structured response ------>|
```

Authentication and negotiation finish before registration. `hello-init` carries a fresh initiator
nonce. The producer verifies the daemon's challenge signature over endpoint, `appId`, generation,
hello proposal, initiator nonce, and responder nonce against the public key in owner-private
discovery state before signing the same transcript. The authoritative `hello-ack` is signed by the
daemon and additionally binds the selected revisions/features and `connectionId` to that complete
transcript. Registration must not repeat mutable negotiation claims. Challenges and incomplete
handshakes are short-lived, single-use, rate-limited, and globally bounded.

### Caller flow

HTTP callers perform an authenticated caller hello on the control route. It uses the same
initiator-nonce, signed-challenge, signed-proof, and signed-ack exchange. Caller hello advertises
broker range, application range, and feature proposals. The daemon returns a short-lived,
generation-bound `callerSessionId`, the selected broker revision/features, the recorded caller
application range/features, and an initial request sequence; it does not preselect one application
revision before a target exists.

Each later request carries `callerSessionId`, a caller-generated request ID, and a canonical
unsigned-64-bit decimal sequence string. The wire form matches `(?:0|[1-9][0-9]{0,19})`, must not
exceed `18446744073709551615`, and is parsed with integer/BigInt arithmetic rather than a JSON
number. Its signature covers the daemon generation, caller session, grant/key ID, negotiated
hello transcript hash, method, canonical path plus sorted/encoded query, canonical body digest,
request ID, and sequence. After validating and authorizing the selector, a target-dependent request
intersects the recorded caller range and daemon support with the target session's already-selected
singleton application revision and feature set, constrained by the exact command
descriptor/version. The command envelope and its signature name that exact application
revision/features, and the producer rejects any mismatch with its connection contract before
parsing the input. A signed response repeats them. No overlap is a structured incompatibility for
that target; it does not mutate the caller session. Target-independent list operations select no
application revision and return each session's selected application revision/features. The daemon
authorizes before executing or consulting cached results. Replayed, expired, wrong-generation, or
out-of-window requests fail.

Caller sessions start at sequence string `"1"` and use a 64-sequence sliding replay window so up
to 32 concurrent HTTP requests may arrive out of order. The daemon tracks the highest accepted
uint64 value plus a 64-bit seen bitmap. It
accepts an unseen sequence from `highest - 63` through `highest + 64`, advances and shifts the
window for a new high value, and rejects duplicates, older values, or larger forward jumps. Caller
libraries allocate sequences monotonically before dispatch; a rejected transport attempt never
reuses one.

Responses repeat the selected broker revision, per-request application revision when applicable,
features, daemon generation, request ID, and structured result or error so validation is bound to
the negotiated caller session and target. A caller renegotiates after daemon restart, not merely
to target a lower-revision session. WebSocket caller adapters use the equivalent exchange.

No reusable private capability is transmitted. Private keys and signatures must not appear in
URLs, query strings, fragments, process arguments, health/capability responses, logs, or errors.

The raw list/get/dispatch API remains disabled by default. Enabling it requires both an
authenticator and an authorizer; `exposeHttpApi: true` alone must no longer be sufficient.

### Command descriptors

Applications register descriptors for commands available at each application protocol revision:

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

Every application revision registers its concurrency groups. Names use the feature-identifier
grammar, descriptor references must resolve, and `maxActivePerSession` is an integer from 1 through 16. The `broker.*` namespace is SDK-reserved: applications cannot register or override
`broker.session-serial`. Omitted `concurrencyGroup` means that built-in group with immutable
capacity one.
Scheduling is per session and per group: admitted commands enter that group's FIFO, and a slot
starts the oldest command in that FIFO. Commands in different groups have no relative start or
completion order. Group capacity never bypasses per-session or daemon pending-command/byte limits.

`name` is the stable machine identifier. `title` and `description` are human-facing discovery text
for CLI, MCP, and agent adapters; they may be localized or revised without changing command
identity. Names and schema IDs are metadata, not validators. Dispatch names an exact command name
and version. The app supplies runtime input and result parsers keyed by selected app revision,
canonical selected feature set, and command/version. `requiredFeatures` must be a subset of that
selected set before input parsing. Descriptor effect classification informs default authorization,
approval, and audit policy but never replaces it.

### Rolling compatibility

A binary-version mismatch alone must not kill a daemon. A newer producer or caller attaches when broker range, app range, authentication, and required features overlap.

A supervisor may replace a daemon only when:

- the identity probe proves it is the expected application daemon;
- required broker features or ranges do not overlap;
- application replacement policy authorizes replacement;
- generation-safe shutdown targets the exact discovered instance;
- active incompatible sessions receive explicit degradation/reconnect behavior.

It must never signal a PID based only on an unauthenticated health response or stale metadata. A compatible daemon stays running even if its package or executable version differs.

Protocol implementations should retain the prior broker revision for at least one package minor compatibility window when safe. Removing a revision requires golden migration tests and a documented package release note.

## Runtime validation

TypeScript generics are compile-time guidance only. Every external boundary receives `unknown` and must run an authoritative parser before state changes.

Required parser coverage includes:

- discovery/coordinator records and authenticated identity responses;
- producer hello and daemon acknowledgement;
- every client and server envelope member;
- credentials and capability claims;
- registration metadata and snapshots;
- caller requests, selectors, deadlines, timeouts, and idempotency keys;
- command input and success result for the exact name/version;
- health and capability payloads read from another process.

App-owned validator registries are keyed by app protocol and command version. Schema IDs may help tooling but do not satisfy runtime validation.

Parser failures:

- return stable structured error codes;
- do not expose stack traces or parser internals;
- do not partially register, update, reconnect, authorize, or resolve a command;
- close an incompatible producer connection when continuing would retain stale assumptions;
- use the same behavior under Node and Bun.

Binary WebSocket frames are rejected with close code `1003` unless a future negotiated protocol defines them. Oversized frames use `1009`. JSON values with malformed discriminants, invalid numbers, or unsupported versions are rejected rather than cast to TypeScript types.

## Local security contract

### Threat model

The supported security boundary protects against:

- other OS users;
- browser DNS rebinding and cross-origin requests;
- accidental exposure on non-loopback interfaces;
- unrelated or buggy local processes that do not possess an application capability;
- one authenticated producer socket attempting to mutate or answer for another session.

It does not protect against malware or arbitrary code already running as the same OS user that can read that user's private files or process memory. Owner-only storage is still required, but documentation must not claim it creates a sandbox within a compromised account.

### Private runtime state and credentials

The host layer creates a private per-user, per-`appId` runtime directory. On Unix the directory is mode `0700` and credential files are `0600`. On Windows it uses owner-only ACLs and rejects unsafe reparse-point or ownership states. Permission or ownership validation fails closed.

The supervisor creates independent Ed25519 proof-of-possession key pairs for coordinator
discovery, producer bootstrap, trusted local caller bootstrap, and daemon identity. Private keys
remain in owner-only credential material and authorized process memory. Discovery records expose
only key identifiers and public verifiers. The daemon stores public verifiers plus immutable grant
records; it never needs a replayable caller or producer secret.

Each grant contains immutable:

- `appId` and principal identifier;
- public-key identifier and algorithm;
- optional `sessionId`;
- allowed operations and command names/versions;
- issuance and expiry times;
- revocation identifier;
- whether it may issue narrower grants.

Capabilities are opaque proof-of-possession grants, not self-authorizing bearer data. To mint a
narrow grant, a trusted application issuer generates the subject key pair locally and submits only
the subject public key plus requested grant through a generation-bound signed caller session. The
issuer must hold `capability:issue`, the app authorizer must approve the subset, and the daemon
stores the resulting immutable grant. The daemon never returns or delivers the subject private
key; the application delivers it out of band through owner-private storage, an inherited file
descriptor, or another app-owned channel. A grant cannot delegate scopes, lifetime, or session
authority broader than its issuer.

Bootstrap grants are installed by the supervisor at daemon startup. Rotation or daemon-generation
replacement invalidates old bootstrap grants. Session retirement invalidates its reconnect and
session-scoped grants. Revocation is keyed by grant ID and takes effect before subsequent
authorization or cached-result lookup. Challenge nonces, caller sessions, signatures, and replay
windows are bounded and expire.

Every signature uses Ed25519 over a domain-separated RFC 8785 canonical JSON transcript. The
transcript includes the protocol domain, `appId`, daemon generation, key/grant ID, selected
endpoint or full canonical HTTP request target as applicable, both challenge nonces or caller
session ID and sequence, request ID, negotiated hello transcript hash and revisions/features, and
the SHA-256 digest of any validated body. Exact transcript fixtures are
part of the broker protocol; concatenated ambiguous strings are forbidden.

### Principals and authorization

The SDK exposes producer and caller principals to app hooks:

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

Authentication proves possession of the private key for an installed grant. Authorization
separately answers whether that principal may perform the requested operation on the selected
session and command.

Scopes distinguish at least:

- session registration/reconnect;
- list;
- get/read snapshot;
- dispatch;
- each command or command family;
- administrative diagnostics and shutdown.

Authorization defaults to deny. `write` and `execute` descriptors require explicit capability scope and pass through the app's authorization hook. The app may require interactive approval. The SDK provides hooks and cancellation context but does not define an approval UI.

Audit hooks receive redacted facts: principal ID or verifier ID, `appId`, optional `sessionId`, operation, command/version, request ID, decision, timestamps, and terminal outcome. They do not receive clear capabilities and should not receive full payloads by default.

### Loopback, Host, and Origin

Supported adapters must:

- refuse a non-loopback bind before listening and require hostname resolution to return only
  loopback addresses;
- accept loopback IPv4 and IPv6 according to one shared parser;
- derive a canonical allowlist of exact `(scheme, normalized host, port)` authorities from the
  configured listeners and explicitly trusted same-origin aliases;
- reject missing, malformed, duplicated, comma-joined, ambiguous, or non-allowlisted `Host` values;
- apply the same authority check to WebSocket upgrades;
- allow an absent `Origin` for native clients;
- reject `Origin: null`, multiple origins, non-HTTP(S) schemes, and every origin not in the exact
  canonical allowlist;
- emit no permissive CORS headers by default.

Authentication complements Host/Origin validation; it does not replace it. The minimal unauthenticated health response is limited to liveness and must not reveal PID, session counts, paths, snapshots, versions useful for targeting, or capabilities. Detailed health and diagnostics require an administrative capability.

Remote mode is unsupported. The generic SDK exposes no “unsafe allow remote” option. Supporting remote use later requires authenticated encryption, key/certificate lifecycle, proxy trust, deployment/discovery policy, and a separate security review.

Hunk may temporarily retain `HUNK_MCP_UNSAFE_ALLOW_REMOTE` as a clearly unsupported legacy application escape hatch, isolated in Hunk composition. It must not become a generic default or weaken browser-review capability rules.

### Browser review capability isolation

Hunk's browser-review secret/digest design remains Hunk-owned. A daemon-wide producer or caller token must not grant browser-review access. Browser review retains its narrower per-session, per-review capability and same-origin/no-CORS policy.

## Command delivery and backpressure

### Guarantee

The broker makes at most one automatic delivery attempt for each accepted caller request. It does not promise exactly-once execution.

The broker tracks a monotonic request state:

```text
received -> authorized -> queued -> written -> accepted -> completed
                         \-> rejected
```

Every terminal response separates `status` from `deliveryCertainty`:

- `status`: `completed`, `rejected`, `timed-out`, `cancelled`, `disconnected`, or `shutdown`;
- `deliveryCertainty`: `not-delivered`, `delivered`, or `unknown`.

The outcome matrix is authoritative:

| State when terminal cause occurs              | Result                                    |
| --------------------------------------------- | ----------------------------------------- |
| `received`, `authorized`, or `queued`         | cause-specific `status` + `not-delivered` |
| `written`, before validated acceptance/result | cause-specific `status` + `unknown`       |
| `accepted`, before terminal result            | cause-specific `status` + `delivered`     |
| validated producer rejection                  | `rejected` + `delivered`                  |
| validated success result                      | `completed` + `delivered`                 |

`delivered` proves producer admission, not successful side effects. The first terminal transition
wins. Once a frame may have been written, absence of `command-accepted` is not proof of
non-delivery. Disconnect, reconnect replacement, timeout, cancellation, forced stop, or drain
expiry must not silently replay the command. Graceful shutdown reports queued work as
`shutdown/not-delivered`, unresolved written-but-unaccepted work as `shutdown/unknown`, and
unresolved accepted work as `shutdown/delivered`.

### Ordering and concurrency

Default command concurrency is one per session through `broker.session-serial`. Applications may
define the bounded per-session concurrency groups above. FIFO start order applies within one group;
commands across groups and all completion order are unspecified.

The initial defaults are:

- 256 registered sessions per daemon;
- 64 queued plus in-flight commands per session;
- 1,024 queued plus in-flight commands per daemon;
- 32 producer commands waiting for a not-yet-installed bridge;
- one active command per session unless a descriptor opts into a bounded group;
- 64 unauthenticated/challenged sockets and 128 incomplete handshake records per daemon;
- 64 KiB per handshake proposal and 4 MiB total incomplete-handshake bytes;
- 256 authenticated caller sessions, 8 KiB each and 2 MiB total, per daemon;
- 32 concurrently parsed/handled HTTP control requests and 64 MiB total in-flight HTTP body bytes
  per daemon;
- 64 MiB total decoded/in-flight WebSocket message bytes per daemon;
- 4 MiB combined registration metadata/snapshot per session and 256 MiB retained across sessions;
- 1 MiB validated command input per entry and 64 MiB queued-command bytes per daemon;
- 15-second default command timeout;
- five-minute maximum caller-selectable timeout;
- 4 MiB maximum decoded HTTP request body;
- 8 MiB maximum decoded HTTP response or aggregated response body;
- 8 MiB maximum inbound WebSocket message;
- 8 MiB maximum buffered outbound bytes per peer and 64 MiB buffered across all peers;
- 1,024 idempotency-ledger entries per session, 65,536 per daemon, with a ten-minute default TTL;
- 1 MiB cached result per keyed entry and 64 MiB total idempotency-ledger bytes per daemon.

Hosts may lower limits. Raising a public network/body/frame/buffer ceiling above the SDK's documented safe maximum requires an explicit unsafe-limits configuration and is outside the supported default posture. App validators must add tighter collection, string, nesting, registration, snapshot, and command-specific limits.

Limit overflow returns structured `busy`, `queue-full`, or `capacity-exceeded` errors. Adapters
reserve daemon-wide inbound bytes before decoding/parsing and release them in `finally`; a peer
whose frame cannot reserve capacity closes with retryable overload code `1013`. Outbound sends
reserve serialized bytes against both peer and daemon budgets until the runtime reports flush or
the peer closes. A slow peer that exceeds its budget closes with `1013`; work not yet written is
reported `not-delivered`, while already written work follows the delivery matrix. HTTP body
readers reserve declared or incrementally read chunks and return `503` when aggregate capacity is
unavailable. An unauthenticated transport over capacity is closed without allocating handshake
state. A new
session over capacity is rejected without evicting an existing session. Response overflow fails
before an unbounded aggregation. It never silently drops commands or grows memory without bound.
If the producer bridge queue is full, the connection sends a failed result for the new request
when possible rather than retaining it indefinitely. Byte accounting uses retained UTF-8 payload
bytes plus fixed entry overhead. The ledger retains only canonical input digests, never full input
bodies. A keyed result above the per-entry cache limit fails as `result-too-large` rather than
silently losing dedupe guarantees. Capacity reclamation may remove expired or terminal least-recent
ledger entries, but never an in-flight entry. Registration/snapshot replacement and queue/ledger
insertion reserve aggregate bytes before commit; failure preserves the prior valid state.

The daemon removes disconnected live-session registration/snapshot state; reconnect authority is a
separate bounded grant. The managed producer retains only its current registration and latest
snapshot required to reconnect, coalescing intermediate snapshots. Commands are not queued across
a disconnected transport.

### Idempotency

Commands declare `none` or `keyed` idempotency. A `keyed` dispatch must carry a valid key; a
`none` dispatch carrying one is rejected as `unexpected-idempotency-key`. A key is 1–128 ASCII
bytes using the `sessionId` character grammar and is scoped by `{appId, sessionId, callerPrincipalId,
selectedAppProtocolRevision, selectedFeaturesHash, commandName, commandVersion, key}`. The canonical
feature hash is SHA-256 over the sorted selected feature identifiers. The canonical content digest
is SHA-256 over RFC 8785 JSON Canonicalization
Scheme output for the validated command input.

Authorization and approval run before any ledger lookup. For the same scope, key, and digest, a
terminal entry returns the prior terminal result and an in-flight entry joins the same result; a
different digest is rejected as `idempotency-conflict`. Only the originating principal or an
administrative capability may cancel joined work.

`@hunk/session-broker` owns the daemon-wide bounded TTL in-memory ledger described above so all
callers observe one dedupe state. The managed-host module manages caller keys and retry policy but
does not own correlation or cached results. The first public
contract does not promise crash-persistent deduplication. A daemon or producer restart loses
in-memory evidence, so a retry after restart remains application-owned with
`deliveryCertainty: "unknown"` unless the app has stronger durable evidence.

### Cancellation and timeout

Cancellation is best effort and feature-negotiated. A command that advertises cancellation
receives an `AbortSignal` and may receive a wire `cancel` message. Only the originating caller
principal or an explicit administrative capability can request it. Cancellation of broker waiting
does not prove application rollback. Late results after a terminal broker outcome are ignored and
audited; they must never resolve a newer request.

Timeout/deadline values are runtime-validated and bounded. Local scheduling uses an injected monotonic clock where possible; wire deadlines remain explicit timestamps with documented skew limits.

## Session and daemon lifecycle

### Heartbeats, staleness, and machine sleep

Heartbeat ownership derives from the connection. The initial heartbeat interval is 10 seconds, stale TTL 45 seconds, and sweep interval 15 seconds.

A gap greater than the configured stale TTL between maintenance observations is treated as
probable process suspension or machine sleep. The detecting observation sets
`recoveryUntil = now + staleSessionTtlMs`. Every pruning trigger, including health and manual
maintenance, is prohibited before `recoveryUntil`. A live session must heartbeat during that
window or it may be removed by the first eligible sweep after it. A second observation cannot
shorten the existing deadline.

Stale removal rejects pending commands with an explicit disconnected/stale outcome and revokes reconnect material according to the configured retirement policy.

### Idle shutdown

The default idle timeout is 60 seconds and may be disabled explicitly. Idle time starts only when there are no:

- registered producer sessions;
- pending or queued commands;
- authenticated requests still being handled;
- active streams or configured shutdown-grace work.

Minimal health probes do not reset idle time. Authorized control work may reset it. The daemon publishes a stopping state before transport teardown so discovery will not route new work to it.

### Graceful and forced stop

Graceful stop:

1. atomically enters `stopping` and refuses new work;
2. resolves queued/unwritten work as `shutdown/not-delivered`;
3. asks producers to close/reconnect when the feature is negotiated;
4. permits a bounded in-flight drain, initially five seconds;
5. resolves remaining written/accepted work according to the delivery matrix and closes all
   WebSockets;
6. closes the HTTP listener;
7. releases generation-owned discovery/coordinator state;
8. resolves `stopped` exactly once.

Forced stop skips the drain and immediately rejects work and closes active transports. The Node
and Bun conditional implementations expose the same `stop({ force?, drainTimeoutMs? })` and
`stopped` semantics. Repeated or concurrent stop calls are idempotent and share one completion.

## Discovery, singleton launch, and ownership

The selected target architecture uses a private per-application coordinator and a random broker endpoint. This is a user-visible change from Hunk's current fixed default port and therefore requires explicit product approval before Phase 4 implements it.

### Runtime namespace

The host layer derives an owner-private runtime directory from stable `appId`, not a display name, port, executable path, or package name. Runtime paths include an encoded `appId` plus a digest to avoid collisions and unsafe filenames.

The supervisor may race with another application process by spawning a candidate daemon, but the
candidate daemon itself performs election and retains the winning coordinator socket for its
lifetime; the launching application process never owns or transfers that bind. Each candidate:

1. binds a random loopback coordinator port;
2. creates a generation ID, daemon key pair, process fingerprint (PID plus process-start token), and
   initialization deadline;
3. attempts owner-private atomic create-if-absent publication of a complete `initializing` record
   naming that bound candidate and public identity key;
4. if publication loses, closes its bind and exits without starting the broker;
5. if publication wins, starts the random broker endpoint, revalidates that the record still names
   its exact generation, atomically publishes `ready`, and continues holding the coordinator bind.

Publication uses a complete temporary inode plus a no-replace operation (or an equally strong
Windows primitive), with directory sync where supported. Contending host processes reread the
winning record and wait for its authenticated readiness instead of owning election state.

The record selects the common rendezvous address; the retained exclusive bind plus authenticated
challenge proves live authority. Filesystem PID or endpoint metadata alone is advisory and never
sufficient authority to signal a process.

Stale takeover is exact and fail-closed. A contender may attempt it only after the published
initialization deadline (or a ready endpoint failure window equal to the startup timeout), no
authenticated coordinator response, and proof that the recorded process fingerprint is dead or
reused. A live, hung, sleeping, inaccessible, or indeterminate owner is a conflict, not takeover.
The contender acquires an owner-private create-exclusive takeover lock, rereads the record, and
requires the same generation and content digest before atomically retiring it and publishing a new
candidate generation. Losers close their binds, release any lock they own, and reread the winner.
The old candidate revalidates generation before `ready` and before every handshake; if ownership
changed it closes listeners and exits without rewriting or deleting the new record. Cleanup removes
state only while holding the takeover lock and only when generation/content still match.

The actual broker HTTP/WebSocket listener uses a random loopback port per daemon generation. Authenticated coordinator discovery returns:

- `appId`;
- daemon generation/instance identifier;
- current broker endpoint;
- supported broker range and discovery features;
- stopping/ready state.

It never returns producer/caller private keys. A producer or caller verifies a fresh daemon
identity challenge and generation before opening its authenticated session; request signatures are
generation- and transcript-bound, so an unrelated or stale endpoint cannot collect reusable
credentials. A foreign listener, invalid owner/permission state, malformed record, wrong `appId`,
or failed authenticated challenge causes a fail-closed conflict diagnostic rather than process
termination.

### Launch and shutdown ownership

Concurrent application processes may spawn candidate daemons; one candidate wins the
bind-then-atomic-publish election, while losing candidates exit and every host waits for the
published coordinator's authenticated readiness. The host injects:

- application identity;
- runtime base directory;
- executable command and arguments;
- environment allowlist;
- health/identity and compatibility checks;
- clock, sleep, spawn, and PID probe effects;
- startup and shutdown deadlines;
- product-specific error formatting.

Generation identifiers and authenticated coordinator state make shutdown exact. Cleanup or termination must prove it owns the same `appId` and generation. PID metadata is diagnostic only.

An explicit endpoint override still belongs to the same coordinator/application namespace. It selects the broker listener endpoint; it must not create a second daemon namespace.

### Approval gate for this choice

Phase 4 must stop for approval before replacing Hunk's current fixed-port/lock implementation with the coordinator/random-endpoint design. If approval is denied, Phase 4 must return to the product owner with a revised fixed-endpoint contract and its collision/foreign-listener tradeoffs rather than quietly implementing a different discovery model.

## Selectors and metadata

The universal selector is:

```ts
interface SessionSelector {
  sessionId?: string;
}
```

The default resolver:

- selects an exact `sessionId` when supplied;
- permits an omitted selector only when exactly one session exists;
- returns structured no-session and ambiguity errors otherwise.

Applications may inject a runtime-validated target resolver over app-specific selector data and read-only session views. A resolver returns one exact `sessionId` or a structured no-match/ambiguity error. It must be deterministic and must not mutate broker state.

The SDK offers an optional developer-tools selector plugin preserving the existing conventions:

- exact live `cwd` through `sessionPath`;
- nearest containing `repoRoot`;
- optional `repoBoundary` exclusion;
- precedence `sessionId`, `sessionPath`, `repoRoot`, sole-session fallback.

Project-boundary discovery remains application-owned. Hunk uses its VCS catalog to discover a boundary before calling the generic resolver. The SDK never learns `.git`, `.hunk`, bundled VCS providers, or extension semantics.

Terminal, repository, cwd, PID, and display metadata are optional conventions. Metadata is untrusted, app-validated, size-bounded JSON and is never used as authentication.

## Hunk composition and migration

Hunk remains the reference adapter. It owns:

- `HunkSessionInfo`, `HunkSessionState`, strict wire schemas, projections, and error copy;
- review documents/publications, generations, resources, cache/assembly, comments, highlights, navigation, reload, and review intents;
- Hunk session HTTP actions and lowering to `createHunkSessionBridge`;
- browser-review routes, SSE, capabilities, digest verification, and same-origin policy;
- VCS-aware project-boundary discovery;
- Hunk executable launch command and upgrade messaging.

Generic state must shed Hunk-shaped projection obligations such as selected review context and comments. Hunk composes those projections over a read-only generic selected-entry seam or generic lifecycle events; no package imports Hunk types.

### Compatibility ledger

| Existing Hunk contract                               | Migration policy                                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUNK_MCP_HOST`, `HUNK_MCP_PORT`, `HUNK_MCP_DISABLE` | Preserve through SDK adoption and at least one documented Hunk minor compatibility window. Map them in the Hunk adapter only.                                                      |
| `HUNK_MCP_UNSAFE_ALLOW_REMOTE`                       | May remain temporarily as unsupported Hunk-only behavior; never expose it as generic SDK support.                                                                                  |
| runtime directory name `hunk-mcp`                    | Preserve or dual-read during migration so old and new binaries do not race as separate namespaces. Never rename in one step.                                                       |
| default `127.0.0.1:47657`                            | The winning Hunk candidate reserves and retains it as the guard before coordinator publication; explicit `HUNK_MCP_PORT` reserves the selected endpoint in the same namespace.     |
| WebSocket `/session` and HTTP `/session-api`         | Preserve paths and current CLI semantics, but require the new authentication handshake after cutover. Pre-authentication binaries receive an actionable upgrade refusal.           |
| `/mcp` returns `410`                                 | Keep the actionable tombstone until a separate deprecation decision removes it.                                                                                                    |
| exact Hunk API/daemon version restart                | Remove automatic PID signaling. An unverifiable legacy daemon causes an actionable manual stop/restart conflict; only an authenticated generation may be stopped programmatically. |
| missing `repoBoundary`                               | Continue legacy containment fallback; new clients may supply the VCS-aware boundary.                                                                                               |

Security takes precedence over operational compatibility: no migration mode accepts unauthenticated
registration or control requests, and an old binary cannot operate against the authenticated new
daemon. “Preserve Hunk behavior” means current command paths, selectors, outputs, and automatic
credential discovery for upgraded clients, not wire compatibility with pre-authentication
binaries.

Coordinator migration must prevent two simultaneous Hunk daemon namespaces without a probe-to-bind
window. Before publishing even an `initializing` coordinator record, a Hunk candidate exclusively
binds the legacy guard endpoint and retains that listener for the daemon generation. Only the
candidate holding the guard may enter the coordinator election. A contender that cannot bind first
waits a bounded startup interval for an authenticated coordinator record, because another new
candidate may hold the guard while publishing; if none appears, it reports the unverifiable
listener and launches nothing. The winner rolls back coordinator state and exits if the guard bind
or retention fails, and it never becomes `ready` without the guard.

The guard alias returns upgrade/authentication refusal to pre-authentication traffic and routes
supported upgraded traffic according to the migration adapter. With explicit `HUNK_MCP_PORT`, the
candidate reserves that exact actual endpoint before publication and uses it for the same daemon
namespace; it does not also launch a random actual endpoint. An unverifiable incumbent, including a
plausible old Hunk daemon, is never signaled automatically. Phase 4 must test concurrent candidates,
guard acquisition before publication, rollback, explicit-port reservation, and mixed old/new
startup failures before changing defaults.

Hunk's browser-review capability remains independent: daemon authentication must not broaden it, and generic discovery must never publish the review secret.

## Release gates

No package may become public while a gate below fails.

### Security gate

- Independent review covers connection ownership, capability storage, Host/Origin checks, discovery permissions, shutdown ownership, and secret leakage.
- Adversarial tests prove socket B cannot supersede, snapshot, heartbeat, unregister, cancel, or answer for socket A without the authenticated reconnect contract.
- Old superseded sockets cannot mutate or resolve later work.
- Missing, malformed, wrong, expired, rotated, and revoked credentials fail without identity or secret leaks.
- List, get, dispatch, command-specific, and administrative scopes are tested separately.
- Raw HTTP control cannot start without explicit authentication and authorization.
- Browser-review authority is not widened by daemon credentials.
- Binary/frame/body/queue/outbound limits have Node/Bun parity and parser fuzz/property coverage.
- Secrets are absent from URLs, logs, health, capabilities, errors, response bodies, argv, and non-credential metadata.
- Owner-only permissions, symlink/reparse handling, and atomic publication run on Linux, macOS, and a real Windows runner.
- Supported mode refuses remote bind configuration.

Any unresolved critical or high security finding blocks publication.

### Compatibility gate

- Hand-authored old/new producer, daemon, and caller matrices prove highest-overlap selection and structured no-overlap behavior.
- Golden fixtures cover every wire revision and feature transition.
- Unknown or unselected features cannot change behavior.
- App command descriptors and validator registries agree for every supported revision.
- Hunk legacy env, runtime path, fixed-endpoint guard, selector, CLI route, actionable old-binary
  refusal, and mixed-version fail-closed flows remain tested.
- Daemon replacement proves application identity and exact generation.
- Package documentation states supported wire ranges separately from package versions.

### Runtime and packaging gate

- The tarball contains built ESM, declarations, README, license, and only intended exports.
- It contains no `src`, tests, credentials, runtime files, local artifacts, or unresolved
  `workspace:*` ranges.
- Fresh external projects install that tarball and complete
  register/list/get/dispatch/result/reconnect/shutdown under Node 22 and Bun 1.3.14.
- Node tests execute under Node without Bun globals or `bun:test`.
- Type consumers compile with NodeNext and bundler resolution without repository path aliases.
- Node/Bun conditional entries share one lifecycle, API-surface, and transport conformance suite.
- The package root selects Bun before Node under Bun, and the Bun runtime never imports or executes
  `ws`.
- Changesets output and the single-package publish dry-run are coherent.
- npm `@hunk` scope ownership, provenance, and trusted publishing are verified.

## Baseline evidence

Captured before Phase 0 documentation changes on 2026-08-29 at commit
`b2fc6fccc24cf2fc3da8e4b55e58e3a9836e2fb1`:

| Environment       | Value                       |
| ----------------- | --------------------------- |
| OS / architecture | Linux 7.1.8-arch1-3, x86_64 |
| Bun               | 1.3.10                      |
| Node              | 24.14.1                     |

| Check                                                                                                                    | Result                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `bun test packages/session-broker-core packages/session-broker packages/session-broker-bun packages/session-broker-node` | 44 passed, 0 failed                                       |
| Focused Hunk config/launcher/client/server/capabilities/HTTP tests                                                       | 74 passed, 0 failed                                       |
| `bun run typecheck`                                                                                                      | passed                                                    |
| `bun run deps:check`                                                                                                     | passed; 360 modules and 1,454 dependencies, no violations |
| `git status --short`                                                                                                     | clean                                                     |

The focused Hunk command was:

```sh
bun test \
  src/session/broker/brokerConfig.test.ts \
  src/session/broker/brokerLauncher.test.ts \
  src/session/broker/brokerClient.test.ts \
  src/session/broker/brokerServer.helpers.test.ts \
  src/session/broker/brokerServer.test.ts \
  src/session/client/capabilities.test.ts \
  src/session/client/daemonHttp.test.ts
```

These results are a regression baseline, not evidence that the future security and compatibility
gates already pass. This machine's Bun is below the selected 1.3.14 public floor; an attempt to run
Bun 1.3.14 through `bunx` failed because that package's installer does not support this package
manager path. The repository CI pins 1.3.14, and Phase 6 must run clean packaged consumers on that
exact floor rather than treating this baseline as runtime attestation.

## Current gaps mapped to later phases

Phase 1 must repair connection ownership, producer/caller authentication, runtime validation, raw
API authorization, and queue/resource bounds. It introduces the minimum signed hello substrate with
a configured fixed Hunk `appId`, broker protocol revision 1, Hunk's current application revision as
a singleton, and an empty generic feature set. Those fixed values are still signed, so Phase 1 does
not ship an unauthenticated transitional path. In particular, current snapshots, heartbeats, and
command results trust message-carried identifiers after the daemon drops the socket identity.

Phase 2 must make Node and Bun reject the same frame types and sizes and implement the same
graceful/forced shutdown. It must also make machine-sleep grace robust against health-triggered
pruning.

Phase 3 generalizes Phase 1's fixed identity/singleton handshake into public configurable `appId`,
broker and application ranges, selected feature/descriptor discovery, generic registration
metadata, and injectable target resolution while preserving Hunk's developer-tool plugin. Golden
fixtures must prove the fixed Phase 1 handshake is the one-element case of the ranged protocol, not
a parallel wire path.

Phase 4 must implement the approved discovery/supervision design with private credentials and generation-safe ownership. It must obtain the explicit coordinator migration approval named above.

Phase 5 must compose supervision, negotiation, connection management, registration/snapshot updates, reconnect/rediscovery, warnings, and ordered shutdown into one managed host API.

Phase 6 must build, pack, install, and test public artifacts and verify the selected npm scope.

Phase 7 must remove obsolete Hunk paths, preserve product semantics, run full end-to-end flows, reconcile historical TODOs, and complete independent review.

## Decision record

| Decision             | Contract                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Daemon scope         | One daemon per immutable `appId`, many sessions; never a universal cross-app hub.                                      |
| Package topology     | One `@hunk/session-broker` package with internal modules and automatic Bun/Node conditional resolution.                |
| Public name          | `@hunk/session-broker`; publication waits for verified scope ownership.                                                |
| Runtime support      | ESM; Node 22+ and Bun 1.3.14+; no browser/edge/Deno/CommonJS.                                                          |
| Package version      | One package, first public version `0.1.0`; wire versions remain independent.                                           |
| Application identity | Stable validated `appId`, never inferred from path/port/package.                                                       |
| Session baseline     | Opaque app-scoped `sessionId`; connection-bound ownership.                                                             |
| Compatibility        | Highest overlapping broker and app integer ranges plus explicit features/descriptors.                                  |
| Validation           | Runtime parsers at every external boundary; TypeScript types alone are insufficient.                                   |
| Security             | Authenticated capabilities, default-deny authorization, loopback + Host/Origin defenses, no supported remote mode.     |
| Delivery             | At most one automatic attempt; no replay after uncertainty; exactly once is not promised.                              |
| Concurrency          | Per-session FIFO, concurrency 1 by default; bounded opt-in groups.                                                     |
| Selectors            | Universal `sessionId` plus injectable resolver; developer paths are an optional plugin.                                |
| Discovery target     | Private per-app coordinator and random generation endpoint, pending explicit migration approval before implementation. |
| Hunk semantics       | Stay in `src/`; browser review keeps its narrower capability/protocol.                                                 |
| Release posture      | Security, compatibility, runtime parity, and clean-package gates are blocking.                                         |

# @hunk/session-broker

Runtime-neutral session broker daemon and connection helpers.

The implementation and release contract for turning these internal workspaces into a supported
per-application SDK lives in
[`docs/session-broker-sdk.md`](https://github.com/modem-dev/hunk/blob/main/docs/session-broker-sdk.md).
Current package APIs predate that contract and do not yet satisfy every security, compatibility,
supervision, or packaging gate it defines. The package now provides signed producer/caller hello,
short-lived caller sessions, replay admission, and default-deny raw HTTP authorization primitives.
**Hunk credential discovery and automatic producer/caller activation intentionally remain deferred
to the later Hunk runtime-adapter change (PR 5 of this stack).** Until that composition lands, the
legacy Hunk WebSocket and custom session routes remain internal-only; no bearer fallback is
available. Hunk's separate browser-review capabilities remain independent.

This is the **main broker package** in the workspace. It owns the reusable broker behavior without committing to Bun or Node server APIs.

Use this package when you want to:

- track live sessions
- register and update session snapshots
- route commands to one live session
- expose broker health and optional raw list/get/dispatch APIs
- manage session-side websocket connection state

## Current workspace roles

The source tree is currently split into four private workspaces:

- `@hunk/session-broker-core` — low-level shared primitives and envelope parsing
- `@hunk/session-broker` — **main runtime-neutral broker API**
- `@hunk/session-broker-bun` — Bun HTTP/websocket adapter
- `@hunk/session-broker-node` — Node HTTP/websocket adapter

The public SDK contract consolidates these into one `@hunk/session-broker` package whose root
selects Node or Bun automatically. Until that migration lands, these names and examples describe
internal workspace usage only.

## What this package owns

- `SessionBroker` raw session registry
- `SessionBrokerDaemon` runtime-neutral daemon engine
- `SessionBrokerConnection` runtime-neutral session-side websocket helper
- raw broker HTTP request types
- health handling and optional capabilities API handling
- stale-session pruning and idle shutdown

## What this package does not own

- Bun `Bun.serve(...)`
- Node `http` / `ws` listener setup
- app-specific command semantics
- app-specific projections like Hunk review exports, comments, or selected hunks
- daemon process launch policy

## Current internal quick start

### 1. Create a broker

```ts
import {
  SessionBroker,
  brokerWireParsers,
  createSessionBrokerProtocolParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
} from "@hunk/session-broker";

interface SessionInfo {
  title: string;
}

interface SessionState {
  selectedIndex: number;
}

function parseInfo(value: unknown): SessionInfo | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const title = brokerWireParsers.parseRequiredString(record.title);
  return title === null ? null : { title };
}

function parseState(value: unknown): SessionState | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const selectedIndex = brokerWireParsers.parseNonNegativeInt(record.selectedIndex);
  return selectedIndex === null ? null : { selectedIndex };
}

const protocolParsers = createSessionBrokerProtocolParsers({
  appRevision: 1,
  features: [],
  parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
  parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseState),
  commands: [
    {
      command: "select",
      version: 1,
      parseInput: (value) => (brokerWireParsers.parseNonNegativeInt(value) === null ? null : value),
      parseResult: (value) => (value === true ? true : null),
    },
  ],
});

const broker = new SessionBroker({ protocolParsers });
```

### 2. Create a daemon engine

```ts
import { createSessionBrokerDaemon } from "@hunk/session-broker";

const daemon = createSessionBrokerDaemon({
  broker,
  capabilities: {
    version: 1,
    name: "example-broker",
  },
});
```

At this point the daemon can:

- handle health requests
- process websocket register/snapshot/heartbeat/result messages
- prune stale sessions and request idle shutdown

The raw HTTP broker API is opt-in and fails closed: `exposeHttpApi: true` exposes no control route
unless an explicit immutable `appId`, a singleton `appRevision`, a `callerAuthenticator`, and an app
`authorizer` are supplied. The included
`SessionBrokerAuthenticator` implements Ed25519 challenge/proof and signed requests; applications
inject app-scoped grants, public verifiers, daemon signing identity, revocation policy, and their
own default-deny authorization hook. It performs no filesystem, environment, coordinator, or Hunk
credential discovery.

### 3. Serve it through a runtime adapter

#### Bun

```ts
import { serveSessionBrokerDaemon } from "@hunk/session-broker-bun";

const server = serveSessionBrokerDaemon({
  daemon,
  hostname: "127.0.0.1",
  port: 47657,
});
```

#### Node

```ts
import { serveSessionBrokerDaemon } from "@hunk/session-broker-node";

const server = await serveSessionBrokerDaemon({
  daemon,
  hostname: "127.0.0.1",
  port: 47657,
});
```

## Session-side connection helper

Use `SessionBrokerConnection` when an app window or live process needs to stay registered with the broker.

```ts
import {
  createNativeSessionBrokerLifecycleClock,
  createSessionBrokerConnection,
} from "@hunk/session-broker";

const lifecycleClock = createNativeSessionBrokerLifecycleClock();
const connection = createSessionBrokerConnection({
  url: "ws://127.0.0.1:47657/session",
  createSocket: (url) => new WebSocket(url),
  registration,
  snapshot,
  protocolParsers,
  lifecycleClock,
  bridge: {
    dispatchCommand: async (message) => {
      if (message.command !== "select") throw new Error("Unsupported command.");
      selectFile(message.input);
      return true;
    },
  },
});

connection.start();
```

`lifecycleClock` may be supplied in the connection options when an application needs to share
lifecycle timing with its launcher or make producer scheduling deterministic. The ordinary
`SessionBrokerLifecycleClock` contract provides current time, one-shot scheduling, delayed-first
fixed-rate interval scheduling, and awaitable delay. Scheduled callbacks return idempotent
disposers. `createNativeSessionBrokerLifecycleClock()` uses unref'd native timers so pending
handshake, heartbeat, reconnect, and polling work does not retain the process.

`createSocket` must return a fresh socket object for every generation because the helper installs
property callbacks that cannot distinguish queued events after object reuse. Reconnect and close
callbacks receive a frozen opaque generation token; after foreign work settles, use
`connection.isGenerationCurrent(token)` before committing app-owned state. These checks fence
commits only: they do not cancel foreign promises, cryptography, probes, or other work already in
progress.

Unexpected defects in connection-owned native callbacks, scheduled work, or fire-and-forget work
terminally retire that connection. Applications may supply `onDefect` to observe the event. The
callback receives only `SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE`; thrown values and lifecycle data
are never forwarded, the callback runs at most once, and callback failures are contained. This
runtime-neutral package does not write defect reports to process output.

The helper owns:

- initial `register`
- later `snapshot` updates
- heartbeats
- `command-result` replies
- queued broker commands until the bridge is ready
- reconnect scheduling

## Raw broker API

The daemon always serves `GET /health`. Its raw capability/control API is intentionally small and
disabled by default. When `exposeHttpApi: true` is set together with an explicit `appId`, singleton
`appRevision`, caller authenticator, and authorizer, it additionally serves:

- `GET /broker/capabilities`
- `POST /broker`

Request body shapes:

```ts
{ action: "list" }
{ action: "get", selector: { sessionId: "..." } }
{ action: "dispatch", selector: { sessionId: "..." }, command: "...", commandVersion: 1, input: {...} }
```

An omitted `commandVersion` is validated and deliberately defaults to revision `1` for current
internal callers. Authentication covers the exact bounded HTTP body bytes before strict UTF-8 and
JSON decoding. Authenticated responses use `{ body, authentication }`; the signed authentication
record binds daemon generation, broker revision, target application contract when applicable,
request ID, HTTP status, and the canonical structured-body digest.

## Hunk-specific layering

Hunk uses this package for the generic broker lifecycle, then layers product-specific behavior on top:

- Hunk-specific daemon routes stay in `packages/hunk/src/session/broker/brokerServer.ts`
- Hunk-specific CLI commands stay in `packages/hunk/src/session/`
- Hunk-specific review projections stay in `packages/hunk/src/session/broker/`

That split is intentional: this package owns generic broker behavior, while Hunk owns what the session data means.

## License

MIT

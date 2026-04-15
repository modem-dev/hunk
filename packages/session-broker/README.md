# @hunk/session-broker

Runtime-neutral session broker daemon and connection helpers.

This is the **main broker package** in the workspace. It owns the reusable broker behavior without committing to Bun or Node server APIs.

Use this package when you want to:

- track live sessions
- register and update session snapshots
- route commands to one live session
- expose broker health and raw list/get/dispatch APIs
- manage session-side websocket connection state

## Package roles

This workspace is split into layers:

- `@hunk/session-broker-core` — low-level shared primitives and envelope parsing
- `@hunk/session-broker` — **main runtime-neutral broker API**
- `@hunk/session-broker-bun` — Bun HTTP/websocket adapter
- `@hunk/session-broker-node` — Node HTTP/websocket adapter

If you are choosing one package to build against, start here.

## What this package owns

- `SessionBroker` raw session registry
- `SessionBrokerDaemon` runtime-neutral daemon engine
- `SessionBrokerConnection` runtime-neutral session-side websocket helper
- raw broker HTTP request types
- health and capabilities handling
- stale-session pruning and idle shutdown

## What this package does not own

- Bun `Bun.serve(...)`
- Node `http` / `ws` listener setup
- app-specific command semantics
- app-specific projections like Hunk review exports, comments, or selected hunks
- daemon process launch policy

## Quick start

### 1. Create a broker

```ts
import {
  SessionBroker,
  brokerWireParsers,
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

const broker = new SessionBroker({
  parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
  parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseState),
});
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
- handle capabilities requests
- handle raw `list` / `get` / `dispatch` broker API requests
- process websocket register/snapshot/heartbeat/result messages
- prune stale sessions and request idle shutdown

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
import { createSessionBrokerConnection } from "@hunk/session-broker";

const connection = createSessionBrokerConnection({
  url: "ws://127.0.0.1:47657/session",
  createSocket: (url) => new WebSocket(url),
  registration,
  snapshot,
  bridge: {
    dispatchCommand: async (message) => {
      return handleCommand(message);
    },
  },
});

connection.start();
```

The helper owns:

- initial `register`
- later `snapshot` updates
- heartbeats
- `command-result` replies
- queued broker commands until the bridge is ready
- reconnect scheduling

## Raw broker API

The daemon's runtime-neutral HTTP API is intentionally small:

- `GET /health`
- `GET /broker/capabilities`
- `POST /broker`

Request body shapes:

```ts
{ action: "list" }
{ action: "get", selector: { sessionId: "..." } }
{ action: "dispatch", selector: { sessionId: "..." }, command: "...", input: {...} }
```

Responses return raw session records or command results.

## Hunk-specific layering

Hunk uses this package for the generic broker lifecycle, then layers product-specific behavior on top:

- Hunk-specific daemon routes stay in `src/session-broker/brokerServer.ts`
- Hunk-specific CLI commands stay in `src/session/`
- Hunk-specific review projections stay in `src/hunk-session/`

That split is intentional: this package owns generic broker behavior, while Hunk owns what the session data means.

## License

MIT

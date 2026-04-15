# @hunk/session-broker-core

Runtime-agnostic primitives for brokering live app sessions over any transport.

This package is the clean boundary between Hunk's app-specific session features and the generic mechanics needed to:

- register live sessions
- keep snapshots up to date
- select a target session
- dispatch commands to one session
- resolve async command results

It works in both Node and Bun because the core package does **not** depend on `Bun.*`, HTTP, WebSocket, process launching, or Hunk's review model.

## What this package includes

- shared session envelope types
- registration and snapshot wire parsing helpers
- an in-memory `SessionBrokerState`
- selector helpers for `sessionId`, `sessionPath`, and `repoRoot`
- generic terminal metadata capture

## What this package does not include

Deliberately **out of scope**:

- HTTP or WebSocket servers
- client reconnect / heartbeat timers
- daemon launch and restart policy
- CLI formatting and command parsing
- capability negotiation
- app-specific registration info, snapshot state, review projections, or commands

Those pieces stay in the host app. In Hunk, they live under:

- [`../../src/session-broker/`](../../src/session-broker)
- [`../../src/hunk-session/`](../../src/hunk-session)
- [`../../src/session/`](../../src/session)

## Package boundary

The intended split is:

- **`@hunk/session-broker-core`** owns generic broker state and types
- **your app** owns payload schemas, transport wiring, commands, and projections

The most important seam is `SessionBrokerViewAdapter`: the core never interprets your `info` or `state` payloads directly. Your app teaches it how to:

- parse registrations
- parse snapshots
- build listed-session views
- build selected-session context
- build review/export views
- list comment-like annotations

That keeps the package reusable without forcing Hunk's model on other consumers.

## Install

This is currently an internal workspace package in the Hunk repo.

```json
{
  "devDependencies": {
    "@hunk/session-broker-core": "workspace:*"
  }
}
```

## Quick start

A typical integration has four steps:

1. define your app's session `info`, `state`, command, and result types
2. implement a `SessionBrokerViewAdapter`
3. create a `SessionBrokerState`
4. wire your transport so incoming messages call `registerSession`, `updateSnapshot`, `markSessionSeen`, and `handleCommandResult`

## Core concepts

### Registration

A registration identifies one live session and carries app-owned metadata.

```ts
import type { SessionRegistration } from "@hunk/session-broker-core";

interface MySessionInfo {
  title: string;
  files: string[];
}

type MyRegistration = SessionRegistration<MySessionInfo>;
```

### Snapshot

A snapshot is the current live state for one registered session.

```ts
import type { SessionSnapshot } from "@hunk/session-broker-core";

interface MySessionState {
  selectedIndex: number;
  noteCount: number;
}

type MySnapshot = SessionSnapshot<MySessionState>;
```

### Server message

Commands sent from the broker to a live session are app-defined.

```ts
import type { SessionServerMessage } from "@hunk/session-broker-core";

type MyServerMessage =
  | SessionServerMessage<"annotate", { filePath: string; summary: string }>
  | SessionServerMessage<"reload_view", { ref: string }>;
```

## Minimal adapter example

`SessionBrokerState` needs an adapter so the core can stay generic.

```ts
import {
  SessionBrokerState,
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
  type SessionBrokerViewAdapter,
  type SessionBrokerListedSession,
  type SessionRegistration,
  type SessionSnapshot,
} from "@hunk/session-broker-core";

interface MySessionInfo {
  title: string;
  files: string[];
}

interface MySessionState {
  selectedIndex: number;
  noteCount: number;
}

type MyRegistration = SessionRegistration<MySessionInfo>;
type MySnapshot = SessionSnapshot<MySessionState>;

interface MyListedSession extends SessionBrokerListedSession {
  fileCount: number;
  snapshot: MySnapshot;
}

interface MySelectedContext {
  sessionId: string;
  selectedIndex: number;
}

interface MySessionReview {
  sessionId: string;
  title: string;
  fileCount: number;
}

interface MyCommentSummary {
  id: string;
}

function parseInfo(value: unknown): MySessionInfo | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record || !Array.isArray(record.files)) {
    return null;
  }

  const title = brokerWireParsers.parseRequiredString(record.title);
  const files = record.files.filter((entry): entry is string => typeof entry === "string");
  if (title === null || files.length !== record.files.length) {
    return null;
  }

  return { title, files };
}

function parseState(value: unknown): MySessionState | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const selectedIndex = brokerWireParsers.parseNonNegativeInt(record.selectedIndex);
  const noteCount = brokerWireParsers.parseNonNegativeInt(record.noteCount);
  if (selectedIndex === null || noteCount === null) {
    return null;
  }

  return { selectedIndex, noteCount };
}

const adapter: SessionBrokerViewAdapter<
  MySessionInfo,
  MySessionState,
  MyListedSession,
  MySelectedContext,
  MySessionReview,
  MyCommentSummary
> = {
  parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
  parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseState),
  buildListedSession: (entry) => ({
    sessionId: entry.registration.sessionId,
    cwd: entry.registration.cwd,
    repoRoot: entry.registration.repoRoot,
    title: entry.registration.info.title,
    fileCount: entry.registration.info.files.length,
    snapshot: entry.snapshot,
  }),
  buildSelectedContext: (session) => ({
    sessionId: session.sessionId,
    selectedIndex: session.snapshot.state.selectedIndex,
  }),
  buildSessionReview: (entry) => ({
    sessionId: entry.registration.sessionId,
    title: entry.registration.info.title,
    fileCount: entry.registration.info.files.length,
  }),
  listComments: () => [],
};

const broker = new SessionBrokerState(adapter);
```

## Wiring a transport

The core package does not care whether you use WebSocket, TCP, IPC, or tests with in-memory sockets. It only expects a socket-like object with:

```ts
{ send(data: string): unknown }
```

A typical server-side message loop looks like this:

```ts
const socket = {
  send(data: string) {
    realTransport.send(data);
  },
};

function handleIncomingMessage(message: any) {
  switch (message.type) {
    case "register":
      broker.registerSession(socket, message.registration, message.snapshot);
      break;
    case "snapshot":
      broker.updateSnapshot(message.sessionId, message.snapshot);
      break;
    case "heartbeat":
      broker.markSessionSeen(message.sessionId);
      break;
    case "command-result":
      broker.handleCommandResult(message);
      break;
  }
}

function handleDisconnect() {
  broker.unregisterSocket(socket);
}
```

## Dispatching commands

Once sessions are registered, you can target one session and wait for its async result.

```ts
const result = await broker.dispatchCommand<{ kind: "reloaded"; ref: string }, "reload_view">({
  selector: { sessionId: "session-1" },
  command: "reload_view",
  input: { ref: "HEAD" },
  timeoutMessage: "Timed out waiting for the session to reload.",
});
```

Selectors support:

- `sessionId`
- `sessionPath` — matched against `registration.cwd`
- `repoRoot`

Useful helpers:

- `matchesSessionSelector()`
- `normalizeSessionSelector()`
- `describeSessionSelector()`
- `resolveSessionTarget()`

## Session lifecycle on the app side

A live session typically sends these messages:

```ts
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  type SessionClientMessage,
} from "@hunk/session-broker-core";

const registration = {
  registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
  sessionId: "session-1",
  pid: process.pid,
  cwd: process.cwd(),
  launchedAt: new Date().toISOString(),
  info: {
    title: "repo working tree",
    files: ["src/example.ts"],
  },
};

const snapshot = {
  updatedAt: new Date().toISOString(),
  state: {
    selectedIndex: 0,
    noteCount: 0,
  },
};

const registerMessage: SessionClientMessage = {
  type: "register",
  registration,
  snapshot,
};
```

Then later:

- send `type: "snapshot"` when the view changes
- send `type: "heartbeat"` to keep the session fresh
- send `type: "command-result"` after handling a broker command

## Registration and snapshot parsing

The core package provides envelope parsers, but your app owns schema validation for `info` and `state`.

Use:

- `parseSessionRegistrationEnvelope()`
- `parseSessionSnapshotEnvelope()`
- `brokerWireParsers`

That split is intentional: the broker validates the shared outer envelope, while your app validates the inner payloads.

## Terminal metadata

If your app wants to attach terminal identity to a registration, use `resolveSessionTerminalMetadata()`.

```ts
import { resolveSessionTerminalMetadata } from "@hunk/session-broker-core";

const terminal = resolveSessionTerminalMetadata({
  env: process.env,
  tty: "/dev/ttys003",
});
```

It captures generic metadata for:

- tty paths
- tmux panes
- iTerm2 session ids
- `TERM_SESSION_ID`-style terminal session ids

The shape is generic on purpose so apps do not need terminal-specific top-level fields.

## API overview

### Types

- `SessionTargetInput`
- `SessionTerminalLocation`
- `SessionTerminalMetadata`
- `SessionRegistration<Info>`
- `SessionSnapshot<State>`
- `SessionClientMessage<Info, State, Result>`
- `SessionServerMessage<CommandName, Input>`
- `SessionBrokerEntry<Info, State>`
- `SessionBrokerListedSession`
- `SessionBrokerViewAdapter<...>`

### Functions and constants

- `SESSION_BROKER_REGISTRATION_VERSION`
- `parseSessionRegistrationEnvelope()`
- `parseSessionSnapshotEnvelope()`
- `brokerWireParsers`
- `matchesSessionSelector()`
- `normalizeSessionSelector()`
- `describeSessionSelector()`
- `resolveSessionTarget()`
- `resolveSessionTerminalMetadata()`

### State container

- `SessionBrokerState`
  - `listSessions()`
  - `getSession()`
  - `getSessionReview()`
  - `getSelectedContext()`
  - `listComments()`
  - `registerSession()`
  - `updateSnapshot()`
  - `markSessionSeen()`
  - `unregisterSocket()`
  - `pruneStaleSessions()`
  - `dispatchCommand()`
  - `handleCommandResult()`
  - `shutdown()`

## How Hunk uses this package

Hunk keeps the generic pieces here and layers app-specific behavior on top:

- the core broker state and shared envelopes live in this package
- Hunk-specific wire parsing lives in [`../../src/hunk-session/wire.ts`](../../src/hunk-session/wire.ts)
- Hunk-specific projections live in [`../../src/hunk-session/brokerAdapter.ts`](../../src/hunk-session/brokerAdapter.ts)
- Hunk's websocket client and daemon runtime stay in [`../../src/session-broker/`](../../src/session-broker)
- Hunk's HTTP API and session CLI stay in [`../../src/session/`](../../src/session)

That split is the intended architecture: this package is the reusable core, while Hunk owns the policy and product behavior around it.

## License

MIT

# @hunk/session-broker-node

Private Node HTTP and websocket adapter for `@hunk/session-broker`.

Use this workspace to serve the broker daemon under Node instead of Bun. It is not a published,
versioned SDK package. See the main broker README for current internal API construction and the
[session broker SDK contract](../../docs/session-broker-sdk.md) for the future public package.

## What it does

- serves a runtime-neutral `SessionBrokerDaemon` through Node HTTP
- upgrades websocket requests with `ws`
- forwards websocket messages and close events into the daemon
- exposes async startup and shutdown helpers
- keeps the runtime-specific listener code out of `@hunk/session-broker`

## Usage

Create the daemon with steps 1–2 in
[`@hunk/session-broker`](../session-broker/README.md), then bind it to Node:

```ts
import type { SessionBrokerDaemon } from "@hunk/session-broker";
import { serveSessionBrokerDaemon } from "@hunk/session-broker-node";

declare const daemon: SessionBrokerDaemon;

const server = await serveSessionBrokerDaemon({
  daemon,
  hostname: "127.0.0.1",
  port: 47657,
});
```

## Why this package exists

This package runs the shared broker API against Node listener and websocket primitives.

If the Node adapter needs an abstraction the shared package does not provide, the fix should happen in `@hunk/session-broker`, not as Node-only glue.

## License

MIT

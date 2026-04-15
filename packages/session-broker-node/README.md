# @hunk/session-broker-node

Node HTTP and websocket adapter for `@hunk/session-broker`.

Use this package when you want to prove or use the broker daemon under Node instead of Bun.

## What it does

- serves a runtime-neutral `SessionBrokerDaemon` through Node HTTP
- upgrades websocket requests with `ws`
- forwards websocket messages and close events into the daemon
- exposes async startup and shutdown helpers
- keeps the runtime-specific listener code out of `@hunk/session-broker`

## Usage

```ts
import { SessionBroker, createSessionBrokerDaemon } from "@hunk/session-broker";
import { serveSessionBrokerDaemon } from "@hunk/session-broker-node";

const broker = new SessionBroker({
  parseRegistration,
  parseSnapshot,
});

const daemon = createSessionBrokerDaemon({
  broker,
  capabilities: { version: 1, name: "example-broker" },
});

const server = await serveSessionBrokerDaemon({
  daemon,
  hostname: "127.0.0.1",
  port: 47657,
});
```

## Why this package exists

This package validates that the shared broker API is genuinely runtime-neutral.

If the Node adapter needs an abstraction the shared package does not provide, the fix should happen in `@hunk/session-broker`, not as Node-only glue.

## License

MIT

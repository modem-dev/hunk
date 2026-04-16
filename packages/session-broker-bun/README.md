# @hunk/session-broker-bun

Bun HTTP and websocket adapter for `@hunk/session-broker`.

Use this package when you want to serve a runtime-neutral `SessionBrokerDaemon` through `Bun.serve(...)`.

## What it does

- binds a broker daemon to a Bun HTTP server
- upgrades websocket requests on the daemon socket path
- forwards websocket messages and close events into the daemon
- exposes a `stopped` promise compatible with Hunk's daemon lifecycle
- lets callers override or add custom HTTP routes before the generic broker routes

## Usage

```ts
import { SessionBroker, createSessionBrokerDaemon } from "@hunk/session-broker";
import { serveSessionBrokerDaemon } from "@hunk/session-broker-bun";

const broker = new SessionBroker({
  parseRegistration,
  parseSnapshot,
});

const daemon = createSessionBrokerDaemon({
  broker,
  capabilities: { version: 1, name: "example-broker" },
});

const server = serveSessionBrokerDaemon({
  daemon,
  hostname: "127.0.0.1",
  port: 47657,
});
```

## Custom routes

You can override or extend request handling with `handleRequest`.

```ts
const server = serveSessionBrokerDaemon({
  daemon,
  hostname: "127.0.0.1",
  port: 47657,
  handleRequest: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, overridden: true });
    }

    return undefined;
  },
});
```

Return `undefined` to fall through to the generic broker routes.

## License

MIT

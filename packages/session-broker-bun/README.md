# @hunk/session-broker-bun

Private Bun HTTP and websocket adapter for `@hunk/session-broker`.

Use this workspace to serve a runtime-neutral `SessionBrokerDaemon` through `Bun.serve(...)`.
It is not a published, versioned SDK package. See the main broker README for current internal API
construction and the [session broker SDK contract](../../docs/session-broker-sdk.md) for the future
public package.

## What it does

- binds a broker daemon to a Bun HTTP server
- upgrades websocket requests on the daemon socket path
- forwards websocket messages and close events into the daemon
- exposes a `stopped` promise compatible with Hunk's daemon lifecycle
- lets callers override or add custom HTTP routes before the daemon's built-in routes

## Usage

Create the daemon with steps 1–2 in
[`@hunk/session-broker`](../session-broker/README.md), then bind it to Bun:

```ts
import type { SessionBrokerDaemon } from "@hunk/session-broker";
import { serveSessionBrokerDaemon } from "@hunk/session-broker-bun";

declare const daemon: SessionBrokerDaemon;

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

Return `undefined` to fall through to the daemon's built-in routes. The raw `/broker` HTTP API is available only when the daemon was created with `exposeHttpApi: true`.

## License

MIT

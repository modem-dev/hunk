# @hunk/session-broker-core

Low-level shared primitives for the session broker packages.

This package is an **internal foundation layer**, not the main entrypoint you should build against in most cases.

## Use this package when

- you are working on broker internals
- you need the shared envelope types and parsers directly
- you are implementing a higher-level broker package on top of it

## Prefer these packages for normal use

- `@hunk/session-broker` — main runtime-neutral broker API
- `@hunk/session-broker-bun` — Bun runtime adapter
- `@hunk/session-broker-node` — Node runtime adapter

## What this package includes

- shared session envelope types
- registration and snapshot wire parsing helpers
- low-level in-memory `SessionBrokerState`
- selector helpers for `sessionId`, `sessionPath`, and `repoRoot`
- generic terminal metadata capture

## What this package does not include

- daemon behavior
- session-side websocket lifecycle helpers
- Bun or Node listener setup
- app-specific command semantics or projections

Those higher-level concerns live in the packages above.

## Package boundary

The intended split is:

- **`@hunk/session-broker-core`** — low-level primitives
- **`@hunk/session-broker`** — main broker API
- **runtime adapters** — Bun and Node listener bindings

## Quick example

```ts
import {
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
  SessionBrokerState,
} from "@hunk/session-broker-core";
```

If you find yourself reaching for this package directly in app code, double-check whether `@hunk/session-broker` would be the better fit.

## License

MIT

---
---

Add unit coverage for the session-broker and session-command layers: brokerServer's Host/Origin DNS-rebinding validators, host:port parsing, serve-error formatting, and the session-API dispatcher, plus the CLI's daemon-availability resolution and text output. brokerServer's pure helpers are now exported for direct testing. Test-only; no user-visible change.

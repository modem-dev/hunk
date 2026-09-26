---
"hunkdiff": minor
---

Make a session daemon left over from a previous Hunk build visible and replaceable.

A window the daemon refuses now shows a sticky status-bar notice naming which side is older and
what to do: run `hunk daemon restart` when the daemon is the older build, or relaunch the window
when it is the newer one. A window whose registration the daemon rejects after the handshake gets
its own notice instead of silently reconnecting.

`hunk session` commands fail with a structured `daemon-build-mismatch` error that says which side
is older, counts the attached windows, and recommends an action; under `--json` it is returned
in-band with the build details.

New `hunk daemon status` reports the daemon's version, uptime, and attached windows, and new
`hunk daemon restart` replaces the daemon with one from the current build after confirming how
many windows that disconnects. Under `HUNK_DEBUG=1` the daemon logs which parser rejected a
registration.

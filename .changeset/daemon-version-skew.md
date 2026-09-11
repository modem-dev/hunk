---
"hunkdiff": minor
---

Make a session daemon left over from a previous Hunk build visible and replaceable. A window that
the daemon refuses now shows a sticky status-bar notice saying which side is old and what to do
(`Run \`hunk daemon restart\``when the window is newer; relaunch when it is older), and a window
whose registration the daemon rejects after the hello gets its own notice instead of silently
reconnecting.`hunk session`commands fail with a structured`daemon-build-mismatch`error that
names both builds, counts the attached windows, and recommends an action; under`--json`it is
returned in-band. New`hunk daemon status`reports the daemon's build, uptime, and attached windows,
and`hunk daemon restart`replaces the daemon with one from the current build after confirmation.
Under`HUNK_DEBUG=1` the daemon logs which parser rejected a registration.

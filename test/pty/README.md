# Serial PTY integration performance

Run the complete suite with `bun run test:integration`. CI uses the same command on one
Ubuntu runner. Do not shard the suite or add concurrent PTYs to shorten the job.

## Wait for the operation, not another idle timeout

Tuistory's `waitIdle()` can take its full 500ms default timeout when an operation produces
no new output. Calling it after `press()` has already waited for idle doubles readiness
work; calling it after a filesystem acknowledgement waits for an event that may never occur.

Shell completion fixtures now print a unique `HUNK_COMPLETION_DONE_<count>` marker **after**
closing the captured-arguments file. Tests send input, Tab, and Enter in Readline order and
wait for that command's marker before reading its arguments. This retains all Bash/Zsh,
quoting, option-boundary, Unicode, standalone/helper/autoload assertions. No command is
retried, and the marker counter prevents an earlier command's screen text acknowledging a
later one. The marker acknowledges the fixture function, not Hunk's review rendering.

Intermediate mouse positions likewise need ordered delivery, not a 500ms wait when no hover
state changes. The threaded-note test sends those moves without an idle barrier and waits
for the actual hover controls, selected note, or saved-card state. Composer/paging tests wait
for rendered code, keyboard readiness, and the complete composer footer instead of fixed
300–500ms waits or 100ms sleeps. Existing assertions remain in place.

General review snapshot waits keep their existing settling behavior: a broader event-only
rewrite was rejected after exposing a multi-frame resize/reveal race. Do not treat any raw
PTY chunk, or even one synchronized-output frame, as proof that a viewport transition has
finished. Keep predicates specific to the committed destination.

## Existing flake fixes

The PTY hunks from coordinator commit `0d16237f` are carried forward unchanged where possible.
Although #1274 landed, its merged head did not include that commit. These hunks isolate
file-pair launches from checkout-local config, wait for committed mouse/scroll/menu/composer
states, and prove keyboard readiness before opening feedback.

The dialog performance check retains its absolute cold (150ms idle / 200ms first-frame) and
warm (150ms) budgets. It replaces the cold-minus-warm differential check: a very fast warm
reopen must not make an otherwise in-budget cold open fail. This is the coordinator's
justified assertion-policy change, not a larger timeout. The Windows metadata stdin fix is
outside this PTY change's scope.

## Measurements and rejected alternatives

Local Linux/Bun 1.3.14 baseline on the refreshed 0.25.0 source base: **290 pass, 1 platform
skip, 391.19s**. Profiling wrapped Tuistory's `waitIdle()` without changing behavior. The
four shell-completion tests cost 50.90s; the threaded-note interaction cost about 7.9s, with
nine idle waits exceeding 450ms. Targeted after runs retained all 76 shell assertions and
15 threaded-note assertions: **3.94s** and **4.08s**, respectively.

A shared compiled binary was measured and rejected: notes/navigation/file-view tests took
64.38s compiled versus about 62.23s from source in the local baseline (noise, not a win).
Default terminal-query acknowledgements likewise showed no startup improvement. Keep source
launch coverage rather than add a build/artifact dependency without a measured benefit.

The deliberate 62-second suspended-session check remains intact: it verifies elapsed-time
behavior, not readiness. Fixed mouse-event cadence and negative/stability checks remain
where timing is part of the behavior under test. No platform or integration test is removed.

Real CI before/after job timings and exact run ids are recorded in the pull request. Compare
`completed_at - started_at` from `gh api repos/modem-dev/hunk/actions/runs/<id>/jobs`, including
setup/cleanup, rather than timing only a local test command. Runner speed varies; report
untouched Windows/Linux job durations alongside PTY and do not attribute their variance to
these test changes.

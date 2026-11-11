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
15 threaded-note assertions: **3.94s** and **4.08s**, respectively. The complete optimized
serial suite passed **290 tests, 1 unchanged platform skip, 1,252 assertions in 339.57s**
(391.19s → 339.57s, 13.2% less time locally).

The fresh single-runner CI control is
[43053286536](https://github.com/modem-dev/hunk/actions/runs/43053286536), `b720f828`, on
`62064bcf` plus the coordinator's PTY fixes, before the three-file optimization. Its PTY
job `130636063061` passed in **7m23s**, including setup/cleanup. The before and after
implementations use the same base, stabilization fixes, job definition, and full test set.

A shared compiled binary was measured and rejected: notes/navigation/file-view tests took
64.38s compiled versus about 62.23s from source in the local baseline (noise, not a win).
Default terminal-query acknowledgements likewise showed no startup improvement. Keep source
launch coverage rather than add a build/artifact dependency without a measured benefit.

The deliberate 62-second suspended-session check remains intact: it verifies elapsed-time
behavior, not readiness. Fixed mouse-event cadence and negative/stability checks remain
where timing is part of the behavior under test. No platform or integration test is removed.

The first optimized CI run is
[43054778196](https://github.com/modem-dev/hunk/actions/runs/43054778196), `1575d0c1`.
The serial PTY job fell **7m23s → 6m11s** (443s → 371s, 16.3% observed). Both runs
executed all **291 tests across 41 files: 287 pass, 4 identical environment skips, 1,214
assertions**. CI's missing zsh/Neovim explain the difference from local counts.

| Measured file    | Before |  After |
| ---------------- | -----: | -----: |
| Shell completion | 26.98s |  2.42s |
| Notes            | 46.34s | 36.91s |

About 34 seconds disappeared directly from the modified files; other file durations also
varied, so do not promise the entire 72-second job reduction on every runner. Untouched
Linux/Windows jobs took 3m31s / 5m27s before and 3m50s / 6m03s after. The overall PR workflow
fell 7m52s → 6m29s in this sample. PTY and Windows are now close, but PTY remains the
critical path. The PR records any subsequent confirmation runs.

Compare `completed_at - started_at` from
`gh api repos/modem-dev/hunk/actions/runs/<id>/jobs`, including setup/cleanup, rather than
timing only a local test command. Report untouched job durations alongside PTY and do not
attribute their variance to these test changes.

# Watch Mode Benchmark: Evented vs Polling

Benchmark comparing the old 250ms polling watch implementation (npm `hunkdiff@0.17.0`) against the evented Chokidar-based hybrid observer (`elucid/file-watch` PR #531).

## Setup

- **Repo:** `modem/modem` (large production monorepo)
- **Branch state:** dirty working tree with untracked files
- **OLD binary:** `/Users/justin/.npm-global/bin/hunk` (npm release 0.17.0, 250ms `setInterval` polling)
- **NEW binary:** `/Users/justin/.local/bin/hunk` (PR build from `elucid/file-watch`, Chokidar + 10s safety poll)
- **Command:** `hunk diff --watch`

## Method

### Git subprocess counting

A wrapper script was placed ahead of real `git` on PATH. It logs every invocation with a timestamp to a per-version log file, then `exec`s the real git binary:

```bash
#!/bin/bash
printf '%s %s\n' "$(date +%s.%N)" "$*" >> "${HUNK_BENCH_GIT_LOG}"
exec /nix/store/.../git "$@"
```

Both versions were launched in separate herdr panes with `HUNK_BENCH_GIT_LOG` and `PATH` set via `--env` on `herdr pane split`. After both rendered their initial diff, the log files were zeroed and CPU times recorded. The benchmark then sampled every 10 seconds for 60 seconds using `ps -p $PID -o cputime=` and `wc -l` on the log files.

### Startup time

Both versions were launched sequentially in herdr panes on the same repo. A polling loop read each pane's visible content via `herdr pane read` at ~20ms intervals, looking for hunk's menu bar (`File  View`). The elapsed time from `herdr pane run` to first detection was recorded. Each version was quit (`q`) and relaunched between trials. Five trials were run per version.

## Results

### Idle overhead (60 seconds, no file changes)

Sampled at 10-second intervals:

```
t=10s  OLD cpu=0:02.68  git= 199  |  NEW cpu=0:01.61  git=   6
t=20s  OLD cpu=0:02.93  git= 319  |  NEW cpu=0:01.63  git=   9
t=30s  OLD cpu=0:03.14  git= 439  |  NEW cpu=0:01.65  git=  12
t=40s  OLD cpu=0:03.35  git= 559  |  NEW cpu=0:01.67  git=  15
t=50s  OLD cpu=0:03.55  git= 679  |  NEW cpu=0:01.69  git=  18
t=60s  OLD cpu=0:03.76  git= 799  |  NEW cpu=0:01.71  git=  21
```

| Metric                           | OLD (polling) | NEW (evented) | Improvement   |
| -------------------------------- | ------------- | ------------- | ------------- |
| Git invocations in 60s           | 799           | 21            | **38× fewer** |
| Git calls/second                 | ~13.3/s       | ~0.35/s       | —             |
| CPU time consumed (idle portion) | ~1.50s        | ~0.13s        | **~12× less** |

The old version fires multiple git commands per 250ms poll cycle (~13/s). The new version fires a small batch every ~10 seconds (safety poll only).

### Startup time (5 trials)

| Trial    | OLD        | NEW        |
| -------- | ---------- | ---------- |
| 1        | 1708ms     | 1674ms     |
| 2        | 1669ms     | 1703ms     |
| 3        | 1671ms     | 1670ms     |
| 4        | 1662ms     | 1756ms     |
| 5        | 1684ms     | 1691ms     |
| **Mean** | **1679ms** | **1699ms** |

Startup time is identical within noise (~1.7s). Both versions are dominated by the initial `git diff` load cost on this repo. The PR's improvement is entirely in the idle steady-state after the diff is rendered.

### Refresh latency (evented PR, separate E2E test repo)

| Scenario                    | Latency |
| --------------------------- | ------- |
| Simple tracked-file write   | ~340ms  |
| Atomic temp-file + rename   | ~418ms  |
| Large 241-line diff update  | ~406ms  |
| New untracked file creation | ~682ms  |

All refreshes were passive — no keyboard or mouse input was sent to hunk.

## Conclusion

The evented observer eliminates virtually all idle CPU and subprocess overhead while maintaining identical startup performance and sub-second passive refresh latency. The improvement scales with the number of open `--watch` sessions: each idle tab drops from ~13 git calls/second to ~0.35.

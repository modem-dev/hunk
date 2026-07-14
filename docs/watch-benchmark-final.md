# Final watch-mode benchmark report

> **Reviewed final report.** This report supersedes the headline claims in the [preliminary watch benchmark](watch-benchmark.md), which remains available as preliminary, non-comparable evidence.

Campaign: `watch-20260714T185115Z-b04ed2b0b-h4f35a0ef` (`watch-v1`)

Frozen: 2026-07-14 18:51:15 UTC

## 1. Executive summary

PR #531 replaces the legacy 250 ms Git-backed watch loop with event hints plus an authoritative Git signature and a 10-second safety check. On the two hosts that could run the complete frozen TUI protocol, the candidate cut one session's cumulative 120-second idle main-process CPU by **1.8–6.4×** and Git invocations by **35–36×**. Mean launch-to-`File  View` remained close to the base: **+21 to +61 ms** across the four host/fixture cells. Every one of the 120 refresh trials was correct; the candidate's deliberate debounce made refreshes slower than the polling base, but candidate p95 remained below 610 ms in these cells.

Headline values are means over five startup trials or two uninstrumented 120-second idle trials, plus one separate 120-second Git cohort. Each row identifies the actual fixture `totalSubdirectoryCount`.

| Platform      | Fixture     | Actual subdirectories | Startup mean, base → candidate | Idle CPU at 120 s, base → candidate | Reduction | Git calls at 120 s, base → candidate | Reduction |
| ------------- | ----------- | --------------------: | -----------------------------: | ----------------------------------: | --------: | -----------------------------------: | --------: |
| macOS arm64   | little repo |                 1,260 |                   528 → 554 ms |                      5,025 → 780 ms |      6.4× |                           1,416 → 40 |       35× |
| macOS arm64   | big repo    |                25,223 |                   560 → 621 ms |                      3,235 → 740 ms |      4.4× |                           1,425 → 40 |       36× |
| Linux x64     | little repo |                 1,260 |                   648 → 669 ms |                      3,615 → 675 ms |      5.4× |                           1,434 → 40 |       36× |
| Linux x64     | big repo    |                25,223 |                   726 → 750 ms |                    3,205 → 1,765 ms |      1.8× |                           1,434 → 40 |       36× |
| Windows ARM64 | little repo |                 1,260 |             N/A — TUI deferred |                                 N/A |       N/A |                                  N/A |       N/A |
| Windows ARM64 | big repo    |                25,223 |             N/A — TUI deferred |                                 N/A |       N/A |                                  N/A |       N/A |

The evidence supports the candidate's backend policy:

- **macOS:** native recursive observation reached ready in 151 ms on little repo and 236 ms on big repo without per-directory registration.
- **Linux:** Git-pruned Chokidar reached ready in 259 ms and 858 ms while limiting traversal to relevant roots. This avoids the roughly 24,000 inotify registrations per session observed in the supplemental native-recursive probe, which approached the host's 61,504-watch limit after only a few sessions.
- **Windows:** native recursion remains the intended policy because correctness probes reached ready and it avoids Chokidar's per-directory resource model. Windows performance is **not** inferred from macOS: full Windows TUI measurements are deferred because of Bun ARM64 FFI and headless ConPTY lifecycle blockers.

## 2. Frozen provenance and campaign manifest

| Input                          | Frozen SHA / checksum                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| Base source                    | `04ed2b0bd51aae633ab94b3a6d157d5d5e568dd0`                         |
| Candidate source               | `4f35a0ef67f9d8094b4b3ff5bd74c3b74940dd57`                         |
| Harness source                 | `bcfb232b4e83e3c8a07834c5e114e7f0f364e8d5`                         |
| Big-repo source                | `85caaceeff750eeceb2e26a7336c8aef1d8372f5`                         |
| Campaign manifest SHA256       | `e4bf360c9a31ecf84ca70f5075b5adb89e0694bac395ece5094d68d19511b4e1` |
| Input index SHA256             | `b0703c2896034363200edb0087650d1ef44284c36fdc4fb1bb53634ce1f6a4b7` |
| Complete artifact index SHA256 | `6f5ed0e16c0363f100dab38547f808375d5ba357074ed0ce9d043f7d18892712` |

The candidate is a clean descendant of the base. The campaign was built from `inputs/hunk.bundle`; no result used an npm package or a PATH-resolved Hunk binary. Each host built both exact revisions with Bun 1.3.14 and `bun install --frozen-lockfile`, then invoked the absolute compiled binary recorded in provenance. The provenance includes source SHA, executable SHA256, file/process architecture, exact Bun path, build command, logs, and a successful absolute-path `--help` smoke check.

| Host         | Revision  | Binary SHA256                                                      | Format / architecture |
| ------------ | --------- | ------------------------------------------------------------------ | --------------------- |
| aarmstrong   | base      | `cd7b70e70bcbc6c7665cd7e6811ebeae9e78e7b286ed25e1b9b7eaef2bc311e6` | Mach-O arm64          |
| aarmstrong   | candidate | `9c9f511d5a8440e00310962594c2e9c2fd2004bb521aeb4d0042fd02c2a316e3` | Mach-O arm64          |
| sentry-agent | base      | `89b20bfe7af596e3f0ff3fb344917dbc765c2fa9baf6e4886fd219830c94d42c` | ELF x86-64            |
| sentry-agent | candidate | `20e33edcd67268c85f5857c58f087abe557bd6fa386f16bfa2f99932c80d4b2f` | ELF x86-64            |

### Raw artifact index

The checksum-verified campaign archive is retained outside the Git worktree at:

```text
/Users/justin/DEV/hunk-watch-campaigns/campaigns/
  watch-20260714T185115Z-b04ed2b0b-h4f35a0ef/
```

`campaign-artifacts.sha256` inventories 771 files (the index excludes itself): canonical raw JSON and terminal bytes under `raw/`, host provenance and failure evidence under `hosts/`, frozen bundles/manifests under `inputs/`, generated summaries, and recovery evidence. The archive occupies approximately 482 MiB; canonical raw results are approximately 5.6 MiB. `shasum -a 256 -c campaign-artifacts.sha256` and the nested input index both passed before publication. The canonical raw set contains 104/104 valid records for each measured host.

## 3. Host and environment matrix

| Role                 | Host                         | Environment                                                                                  | Filesystem / resource notes                                                    | Status                                                  |
| -------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Primary macOS        | `macos-arm64-aarmstrong`     | macOS 15.7.4, Apple M1 Max, 10 cores, 64 GiB, Bun 1.3.14, Git 2.53.0                         | APFS SSD; AC power, battery 100%, power mode 0; no thermal/performance warning | Complete, 104/104                                       |
| Primary Linux        | `linux-x64-sentry-agent`     | Ubuntu 24.04.4, Linux 6.8.0-134, KVM, 4 vCPU Intel i7-6770HQ, 8.3 GB, Bun 1.3.14, Git 2.43.0 | ext4; inotify watches 61,504, instances 128, queue 16,384                      | Complete after disclosed recovery, 104/104              |
| Primary Windows      | `windows-arm64-hunk-windows` | Windows ARM64 VM, native Bun 1.3.14                                                          | ARM64 OpenTUI FFI cannot initialize (`TinyCC is disabled`)                     | Correctness/probe only; TUI metrics deferred            |
| Supplemental Windows | `windows-x64-gha`            | GitHub-hosted `windows-latest` x64                                                           | Headless ConPTY child survived forced process-tree teardown                    | Correctness/build/provenance only; TUI metrics deferred |
| Supplemental macOS   | `macos-arm64-currie`         | Not staged for this campaign                                                                 | Canonical archive/aggregation host only                                        | Excluded from measurements                              |

The report does not combine architectures or average hosts. Windows ARM64 and x64 are separately disclosed rather than averaged.

## 4. Fixture definitions and exact directory counts

Both portable fixtures are sanitized Git bundles plus deterministic ignored-tree manifests. Reconstruction sets `core.autocrlf=false` and `core.symlinks=false`; source symlinks are materialized as plain files. Before each run group, the harness restores one standardized dirty tracked file and one existing untracked file.

| Fixture     | Source / manifest SHA256                                                              | Actual total subdirectories | Ignored | Relevant | Tracked files | Initial untracked | Maximum depth |
| ----------- | ------------------------------------------------------------------------------------- | --------------------------: | ------: | -------: | ------------: | ----------------: | ------------: |
| little repo | candidate source / `c0e646dc219f12ba378030fb01a5f1028e722177d4a8be3fccfcb12e3077e06f` |                       1,260 |   1,176 |       84 |           444 |                 1 |            11 |
| big repo    | modem fixture / `697436aff9ba09f6211f8915f15b001faf50106ce48284132be3476017c7ee29`    |                      25,223 |  24,095 |    1,128 |         6,346 |                 1 |            15 |

Manifest hashes, reconstructed counts, and the counts repeated in every raw record agree on both measured operating systems.

## Methodology

The fixed terminal was 120×30. Base and candidate never ran concurrently. Each fixture/revision cell contains one supplemental `cold-ish` first launch, one excluded warmup, five warm launches in a deterministic balanced ABBA-style sequence, one observer record, two uninstrumented 120-second idle runs sampled at t=0,10,…,120 seconds, one separate 120-second Trace2 Git cohort, and five refresh trials for each of three scenarios. The base observer record is an explicit N/A because the legacy implementation polls.

Median and p95 below use the five warm trials; with n=5, nearest-rank p95 is the maximum observed trial. Idle values are means of two cumulative per-process deltas, not sampled CPU percentages. Git counts come from the separate instrumentation cohort so Trace2 does not contaminate headline CPU/RSS. No run was labeled truly cold, and the campaign defines no pass/fail performance threshold.

## 5. Startup: launch to `File  View`

| Platform | Fixture     | Actual subdirectories | Revision  | Trials |      Mean |    Median |       p95 | Supplemental cold-ish |
| -------- | ----------- | --------------------: | --------- | -----: | --------: | --------: | --------: | --------------------: |
| macOS    | little repo |                 1,260 | base      |      5 | 527.60 ms | 531.37 ms | 538.06 ms |             577.84 ms |
| macOS    | little repo |                 1,260 | candidate |      5 | 554.47 ms | 557.47 ms | 561.53 ms |             604.44 ms |
| macOS    | big repo    |                25,223 | base      |      5 | 560.27 ms | 567.16 ms | 572.37 ms |             753.26 ms |
| macOS    | big repo    |                25,223 | candidate |      5 | 621.10 ms | 617.75 ms | 631.26 ms |             718.04 ms |
| Linux    | little repo |                 1,260 | base      |      5 | 647.53 ms | 643.08 ms | 660.70 ms |             690.49 ms |
| Linux    | little repo |                 1,260 | candidate |      5 | 669.02 ms | 669.14 ms | 684.70 ms |             732.39 ms |
| Linux    | big repo    |                25,223 | base      |      5 | 726.35 ms | 714.31 ms | 761.60 ms |             720.24 ms |
| Linux    | big repo    |                25,223 | candidate |      5 | 750.16 ms | 751.35 ms | 754.64 ms |             752.63 ms |

The candidate adds 24–61 ms to the means, while the balanced warm trials remain in the same sub-second range. “Startup parity” here means no order-of-magnitude regression, not statistical equivalence; five trials are too few for such a claim.

## 6. Candidate observer-ready metric

Observer ready is measured from probe-process launch, not as an isolated CPU measurement. `plan` is Git-aware plan derivation; `construction` is backend construction to ready. The remaining launch time includes process/bootstrap work.

| Platform      | Fixture     | Actual subdirectories | Backend             |                               Launch → ready |     Plan | Construction → ready | Base                 |
| ------------- | ----------- | --------------------: | ------------------- | -------------------------------------------: | -------: | -------------------: | -------------------- |
| macOS         | little repo |                 1,260 | native recursive    |                                    150.86 ms | 27.09 ms |             26.02 ms | N/A — legacy polling |
| macOS         | big repo    |                25,223 | native recursive    |                                    236.47 ms | 44.35 ms |             62.52 ms | N/A — legacy polling |
| Linux         | little repo |                 1,260 | Git-pruned Chokidar |                                    259.22 ms | 11.11 ms |            107.54 ms | N/A — legacy polling |
| Linux         | big repo    |                25,223 | Git-pruned Chokidar |                                    857.70 ms | 31.87 ms |            656.88 ms | N/A — legacy polling |
| Windows ARM64 | little repo |                 1,260 | native intended     | Ready in correctness probe; final timing N/A |      N/A |                  N/A | N/A — legacy polling |
| Windows ARM64 | big repo    |                25,223 | native intended     |                    TUI/probe matrix deferred |      N/A |                  N/A | N/A — legacy polling |

No measured candidate cell selected the degraded 2-second fallback.

## 7. Idle CPU and RSS

Each CPU cell is the mean cumulative delta from the t=0 sample. The 60-second column uses the exact t=60 sample; the 120-second column uses t=120. RSS at 60 seconds is the mean exact slice, and peak is the maximum observed sample across both runs.

| Platform | Fixture     | Actual subdirectories | Revision  | Runs | CPU at 60 s | CPU at 120 s | RSS at 60 s |   Peak RSS |
| -------- | ----------- | --------------------: | --------- | ---: | ----------: | -----------: | ----------: | ---------: |
| macOS    | little repo |                 1,260 | base      |    2 |    2,565 ms |     5,025 ms |  189.91 MiB | 190.66 MiB |
| macOS    | little repo |                 1,260 | candidate |    2 |      435 ms |       780 ms |  190.72 MiB | 192.33 MiB |
| macOS    | big repo    |                25,223 | base      |    2 |    1,665 ms |     3,235 ms |  190.43 MiB | 192.59 MiB |
| macOS    | big repo    |                25,223 | candidate |    2 |      420 ms |       740 ms |  189.71 MiB | 190.13 MiB |
| Linux    | little repo |                 1,260 | base      |    2 |    1,900 ms |     3,615 ms |  110.88 MiB | 143.61 MiB |
| Linux    | little repo |                 1,260 | candidate |    2 |      475 ms |       675 ms |  119.43 MiB | 144.52 MiB |
| Linux    | big repo    |                25,223 | base      |    2 |    1,685 ms |     3,205 ms |  110.98 MiB | 143.84 MiB |
| Linux    | big repo    |                25,223 | candidate |    2 |    1,570 ms |     1,765 ms |  191.54 MiB | 206.09 MiB |

Linux big repo shows the tradeoff most clearly: pruned Chokidar concentrated setup/memory work early, yet the candidate still used 1.8× less main-process CPU over 120 seconds. macOS native recursion did not show a comparable RSS increase.

## 8. Git invocations and families

These are measured totals from one separate 120-second Trace2 cohort per cell. Child Git CPU was intentionally **not available** in this low-distortion instrumentation mode and is not estimated.

| Platform | Fixture     | Actual subdirectories | Revision  | Total | Command families                                     |
| -------- | ----------- | --------------------: | --------- | ----: | ---------------------------------------------------- |
| macOS    | little repo |                 1,260 | base      | 1,416 | `diff` 472; `rev-parse` 472; `status` 472            |
| macOS    | little repo |                 1,260 | candidate |    40 | `rev-parse` 15; `ls-files` 1; `diff` 12; `status` 12 |
| macOS    | big repo    |                25,223 | base      | 1,425 | `diff` 475; `rev-parse` 475; `status` 475            |
| macOS    | big repo    |                25,223 | candidate |    40 | `rev-parse` 15; `ls-files` 1; `diff` 12; `status` 12 |
| Linux    | little repo |                 1,260 | base      | 1,434 | `diff` 478; `rev-parse` 478; `status` 478            |
| Linux    | little repo |                 1,260 | candidate |    40 | `rev-parse` 15; `ls-files` 1; `diff` 12; `status` 12 |
| Linux    | big repo    |                25,223 | base      | 1,434 | `diff` 478; `rev-parse` 478; `status` 478            |
| Linux    | big repo    |                25,223 | candidate |    40 | `rev-parse` 15; `ls-files` 1; `diff` 12; `status` 12 |

The candidate performs one ignored-root planning query and then roughly one authoritative signature family per 10-second safety interval. The base continuously performs the three-command signature at the legacy polling cadence.

## 9. Refresh latency and correctness

All rows contain 5/5 correct visible refreshes. Values are median / nearest-rank p95.

| Platform | Fixture     | Actual subdirectories | Revision  |      Tracked write |      Atomic rename | Relevant untracked creation |
| -------- | ----------- | --------------------: | --------- | -----------------: | -----------------: | --------------------------: |
| macOS    | little repo |                 1,260 | base      | 371.37 / 378.92 ms | 368.60 / 389.76 ms |            78.17 / 82.61 ms |
| macOS    | little repo |                 1,260 | candidate | 409.69 / 413.91 ms | 407.01 / 409.59 ms |          364.08 / 367.94 ms |
| macOS    | big repo    |                25,223 | base      | 191.38 / 203.68 ms | 196.91 / 199.21 ms |          159.65 / 161.61 ms |
| macOS    | big repo    |                25,223 | candidate | 528.17 / 542.71 ms | 538.68 / 543.68 ms |          444.55 / 453.19 ms |
| Linux    | little repo |                 1,260 | base      |   76.84 / 80.15 ms |   76.82 / 79.66 ms |            69.81 / 71.80 ms |
| Linux    | little repo |                 1,260 | candidate | 273.63 / 277.30 ms | 278.68 / 284.70 ms |          262.50 / 267.64 ms |
| Linux    | big repo    |                25,223 | base      | 192.34 / 200.22 ms | 191.42 / 202.97 ms |          150.13 / 168.78 ms |
| Linux    | big repo    |                25,223 | candidate | 411.02 / 591.75 ms | 439.15 / 503.86 ms |          477.66 / 602.37 ms |

The base can notice an edit on its next 250 ms poll. The candidate intentionally waits for a 200 ms quiet debounce before checking the authoritative signature, trading some latency for much lower continuous work. Correctness covered ordinary writes, atomic replacement, and untracked creation without user input.

## 10. Setup / steady-state break-even

The harness did not isolate observer CPU, so this analysis does **not** mislabel observer-ready wall time as setup CPU. Instead it uses the measured median end-to-end startup difference as a conservative one-time cost proxy and divides it by the measured one-session 120-second main-process CPU saving rate.

| Platform | Fixture     | Candidate median startup difference | Idle CPU saved per wall second | Approximate break-even |
| -------- | ----------- | ----------------------------------: | -----------------------------: | ---------------------: |
| macOS    | little repo |                           +26.10 ms |                     35.38 ms/s |                 0.74 s |
| macOS    | big repo    |                           +50.60 ms |                     20.79 ms/s |                 2.43 s |
| Linux    | little repo |                           +26.06 ms |                     24.50 ms/s |                 1.06 s |
| Linux    | big repo    |                           +37.05 ms |                     12.00 ms/s |                 3.09 s |

This is descriptive amortization, not a user-interactivity threshold. Concentrated setup can still affect the first interaction even when its CPU-equivalent cost is recovered within seconds. Linux big repo's 858 ms observer-ready wall time and 206 MiB peak RSS are therefore important alongside its three-second CPU break-even.

## 11. Measured one-session values and projections

The one-session 120-second CPU/Git values are measured in sections 7–8. The values below are renderer-style **projections** from those rates; no 3- or 5-session process matrix was run. CPU is projected main-process CPU milliseconds per wall minute; Git is projected invocations per wall minute.

| Platform | Fixture     | Revision  | 1 session projected CPU / Git | 3 sessions projected CPU / Git | 5 sessions projected CPU / Git |
| -------- | ----------- | --------- | ----------------------------: | -----------------------------: | -----------------------------: |
| macOS    | little repo | base      |              2,512.5 ms / 708 |             7,537.5 ms / 2,124 |            12,562.5 ms / 3,540 |
| macOS    | little repo | candidate |                   390 ms / 20 |                  1,170 ms / 60 |                 1,950 ms / 100 |
| macOS    | big repo    | base      |            1,617.5 ms / 712.5 |           4,852.5 ms / 2,137.5 |           8,087.5 ms / 3,562.5 |
| macOS    | big repo    | candidate |                   370 ms / 20 |                  1,110 ms / 60 |                 1,850 ms / 100 |
| Linux    | little repo | base      |              1,807.5 ms / 717 |             5,422.5 ms / 2,151 |             9,037.5 ms / 3,585 |
| Linux    | little repo | candidate |                 337.5 ms / 20 |                1,012.5 ms / 60 |               1,687.5 ms / 100 |
| Linux    | big repo    | base      |              1,602.5 ms / 717 |             4,807.5 ms / 2,151 |             8,012.5 ms / 3,585 |
| Linux    | big repo    | candidate |                 882.5 ms / 20 |                2,647.5 ms / 60 |               4,412.5 ms / 100 |

Linear projections do not model cache sharing, scheduler contention, filesystem contention, or watch-limit exhaustion.

## 12. Backend strategy rationale

### macOS: native recursive

The frozen candidate selected `native-recursive` in every macOS record. It registered the worktree as one recursive native target and filtered event paths against Git-derived ignored roots. Ready time grew from 151 to 236 ms across a 20× directory-count increase, peak RSS remained near 190–192 MiB, and 120-second CPU fell 4.4–6.4×. This is direct evidence for retaining native recursion on macOS.

### Linux: Git-pruned Chokidar

The frozen candidate selected `chokidar-portable`, never degraded, and traversed Git-relevant roots rather than all 25,223 directories. It reached ready in 259 ms on little repo and 858 ms on big repo. Frozen-campaign steady-state CPU and Git work still fell substantially, although big-repo setup reached 206 MiB peak RSS.

A separate preliminary backend probe on this same Linux class measured unpruned Chokidar at 2.65 s / 24,554 directories / about 286 MiB, Git-pruned Chokidar at 0.47 s / 1,129 directories / about 122 MiB, and native recursive `fs.watch` at 0.33 s / about 46 MiB but roughly 24,000 inotify registrations per process. With `max_user_watches=61,504`, native recursion exhausted the shared limit at roughly three sessions. Those supplemental measurements are not mixed into the frozen headline table, but they explain why the somewhat slower pruned backend is the safer multi-session Linux policy.

### Windows: native recursive, performance pending

On the ARM64 VM, 103 focused watch tests passed and forced native and Chokidar observer probes both reached ready. The native policy avoids per-directory Chokidar registrations and matches Windows' recursive `fs.watch` capability. However, Bun 1.3.14 ARM64 could not load OpenTUI's FFI library; x64 emulation also failed to load the Ghostty addon. On GitHub's x64 runner, focused tests/build/provenance completed, but the headless ConPTY child survived forced teardown and correctly tripped leak detection. Therefore the backend choice is supported by correctness probes and measured resource behavior on the other backend implementations, but this report makes **no Windows startup, idle, memory, or latency claim**. Full Windows TUI measurements remain follow-up work.

## 13. Failures, retries, and degraded states

- **macOS:** 104/104 canonical records valid; no failed attempts or retries. Transfer-created AppleDouble metadata was removed from the campaign destination without changing measured artifacts.
- **Linux attempt 1:** reached 103/104 valid cells, then Bun/OpenTUI extraction left 201 temporary `.so` files totaling 2,707,790,272 bytes in `/tmp`, exhausting disk before the final big-repo candidate untracked-creation record could be written. Evidence and the zero-byte record are retained under `failed-attempt-enospc-20260714T2011Z/`.
- **Linux containment retry:** moving temporary extraction to campaign-owned `/dev/shm` caused OpenTUI initialization to fail. Both failures are retained under `failed-attempt-tmpdir-20260714T2012Z/`.
- **Approved Linux recovery:** all 103 valid original records were retained. Only `big-repo-candidate-refresh-15-attempt-1` was recovered using the frozen candidate binary and committed fixture, PTY, mutation, schema, and report modules. Its 412.76 ms correct refresh is included in the five-trial scenario. Final canonical validation is 104/104.
- **Windows:** failures are platform-blocker evidence, not excluded benchmark outliers. No Windows TUI record appears in headline conclusions.
- **Degraded fallback:** no canonical candidate measurement entered degraded mode. Base observer status is explicitly `not-applicable-legacy-polling`.

No performance outlier was removed from a completed trial set.

## 14. Preliminary report comparison

The [preliminary report](watch-benchmark.md) compared npm `hunkdiff@0.17.0` against a mutable PR source build on a dirty production modem checkout. It reported 799 → 21 Git calls over 60 seconds, about 1.50 → 0.13 seconds of idle CPU, and 1,679 → 1,699 ms mean startup. It used a PATH wrapper, Herdr pane capture, a different fixture, and an incompletely frozen host/source environment.

Those values are useful for discovering the problem and agree directionally with the frozen campaign. They are **not numerically comparable** with this report: npm versus source differs from exact base versus candidate source SHAs; the production checkout differs from both portable fixtures; its 60-second instrumentation differs from the separated 120-second CPU and Trace2 cohorts; and its cache/provenance controls differ. Final claims in PR #531 should cite this document, not transplant preliminary ratios.

## 15. Limitations

- Two complete performance hosts are not a population; hardware, filesystem, background work, and Git versions differ.
- Five startup and five scenario trials make p95 equal to the maximum; the label is descriptive, not a stable tail estimate.
- `cold-ish` means first launch after fixture reconstruction, not a dropped OS page cache or true cold-cache run.
- Main-process CPU excludes child Git CPU. Child CPU was unavailable in the separate low-distortion Trace2 cohort.
- Idle CPU is cumulative process CPU sampled at 10-second resolution; short bursts inside an interval are not localized.
- Observer-ready is wall time and does not isolate setup CPU.
- RSS sampling does not identify allocator ownership or shared-memory accounting.
- Refresh timing includes debounce, signature verification, reload, render, and terminal marker detection; it is user-visible pipeline latency, not raw filesystem event latency.
- The session projections are linear calculations, not measured concurrent runs.
- Windows provides correctness/probe evidence only, so no cross-architecture Windows average or performance conclusion is presented.
- The frozen fixtures preserve geometry, not private source contents or every behavior of the original repositories.

## Infrastructure and change accounting

### Candidate branch (`04ed2b0` → `4f35a0e`)

Fourteen commits implement the production change:

- `34df732` anchor reload signatures to source context
- `f0b517d`, `f640c7d`, `80de321` add backend-neutral plans, Git-derived plans, and the deterministic hybrid controller
- `dc37a0d`, `0336d76` add Chokidar observation and wire lifecycle into the UI
- `8ae9c69`, `e22e333` add passive PTY coverage and continuous-watch documentation
- `c152100`, `0659a30`, `d36c33f`, `fd00dd6` add resource fallback, Git ignored-root pruning, native recursive selection, and a bounded readiness deadline
- `f6165bd`, `4f35a0e` stabilize cross-platform and sidecar watch coverage

Production implementation/seams are in `src/core/watch.ts`, `watchPlan.ts`, `watchController.ts`, `watchObserver.ts`, `src/core/vcs/*`, `src/core/git.ts`, loader/type plumbing, `src/ui/hooks/useWatchedInput.ts`, and the App/AppHost integration. Matching unit, filesystem, AppHost, helper, and PTY coverage lives beside those files and in `test/helpers/watchTest.ts` and `test/pty/watch.test.ts`. CI and PR CI add a compiled-binary watch PTY check. README documents continuous observation with fallback.

The only new runtime dependency is `chokidar@^4.0.3` (and transitive `readdirp@4.1.2`), recorded in `package.json`, `bun.lock`, and `nix/bun.lock.nix`. The two user-visible patch changesets are `.changeset/calm-files-watch.md` and `.changeset/native-recursive-watch.md`. Existing benchmark fixture imports received small type/data updates, but no benchmark runner is a production runtime dependency.

**Recommendation:** keep the production watch implementation, runtime dependency, packaging lock updates, documentation, compiled-binary CI checks, tests, and the two release changesets in PR #531.

### Harness-only branch (`4f35a0e` → `bcfb232`)

Twenty commits created and hardened campaign infrastructure: `d60a77f`, `2d9ad55`, `74eef02`, `22bf81c`, `c88a6ff`, `7011eeb`, `7d27741`, `799de5e`, `716c4a2`, `45a79e5`, `2b1ea62`, `8903535`, `eb23e5e`, `f63ce7d`, `8457e8e`, `8fcb9df`, `362e71a`, `e3818cf`, `e76197c`, and `bcfb232`.

Complete harness file inventory:

- **Protocol/fixture/schema/runner/report:** `benchmarks/watch/README.md`, `fixture.ts`, `campaign.ts`, `schema.ts`, `run.ts`, `report.ts`, and their `fixture.test.ts`, `campaign.test.ts`, `schema.test.ts`, and `run.test.ts`.
- **Terminal, ConPTY, sampling, and Git instrumentation:** `terminal.ts`, `sampler.ts`, `git-log.ts`, `observer-probe.ts`, `artifacts.ts`, with `terminal.test.ts`, `sampler.test.ts`, `git-log.test.ts`, and `observer-probe.test.ts`.
- **Freeze, provenance, transfer, build, and preflight:** `freeze.ts`, `stage.ts`, `build-host.ts`, `host-identity.ts`, `host-preflight.ts`, `prepare-preflight.ts`, with `stage.test.ts`, `build-host.test.ts`, `host-identity.test.ts`, `host-preflight.test.ts`, and shared `test-helpers.ts`.
- **Package/build integration:** seven `bench:watch*` scripts in `package.json`; dev-only `@xterm/headless@5.5.0` and `ghostty-opentui@1.4.10` plus `bun.lock`; `scripts/build-bin.ts` reuses `process.execPath` to prevent ambient-Bun builds.
- **Benchmark-only production seams:** `src/core/watchObserver.ts` and `.test.ts` accept an injected `auto|native|chokidar` backend for forced probes; production remains `auto`.
- **Workflow:** `.github/workflows/benchmarks.yml` contains the Windows adapter.
- **Maintenance changesets:** `.changeset/watch-benchmark-harness.md` and `.changeset/witty-schools-sit.md` are empty/non-release changesets.

No harness-only commit is part of frozen PR #531 candidate `4f35a0e`; the campaign bundle records the separate harness SHA. The 7,070-line harness delta must not be presented as product code in the PR.

### GitHub Actions workflow accounting

The existing `Benchmarks` workflow still runs its normal Ubuntu benchmark job on non-documentation pushes to `main`. The harness branch adds an opt-in `windows-watch` job gated by `workflow_dispatch && run-windows-watch`. Dispatch inputs choose provisional refs or a frozen artifact, preflight/final mode, and forced observer probes. Provisional refs are preflight-only; final mode requires frozen campaign inputs.

The Windows job pins Bun 1.3.14 and Node 22, disables CRLF conversion, validates all refs/artifact inputs, installs frozen dependencies, runs focused tests, captures host/build/binary provenance, executes the common bounded campaign command, runs forced backend probes, and uploads evidence even on failure. Artifacts retain raw JSON, terminal bytes, probes, build logs, and provenance for 30 days. Actions are SHA-pinned. The workflow declares no elevated `permissions:` block and adds no tunnel, remote desktop, service, or release permission; it uses the repository token only for checkout/artifact download/upload. It is informational and manual, not a required check or performance gate.

Multiple failed Windows workflow runs are themselves retained diagnostic evidence; the final adapter reached tests/build/provenance but not trustworthy TUI teardown.

**Recommendation:** do not merge the large workflow adapter through PR #531. If Windows benchmarking will recur, move a simplified manual job plus the minimal harness into a dedicated follow-up after ConPTY teardown is solved. Otherwise remove the harness-branch workflow changes; never enable the large matrix on every push.

### Windows VM and runner assumptions

The ARM64 VM uses native ARM64 Bun 1.3.14 and builds/checksums a native PE. Because the compiled Bun runtime cannot load OpenTUI FFI, the preflight adapter can run the frozen source through the same absolute native Bun for correctness/probe plumbing only; such source-adapter values must never enter compiled performance rows. The x64 path assumes GitHub's headless `windows-latest` ConPTY, PowerShell 7 checksum handling, `core.autocrlf=false`, Windows-safe fixture names, and explicit process-tree cleanup/leak detection. No VM image mutation or sysctl-like resource change is part of the campaign.

**Recommendation:** retain the blocker notes and correctness tests. Remove source-adapter/performance scaffolding when Bun ARM64 FFI is fixed, then rerun compiled ARM64 and x64 TUI cells separately. Keep strict leak detection rather than accepting a surviving ConPTY child as success.

### Staging, cleanup, and maintenance ownership

- Canonical aggregation/archive: `/Users/justin/DEV/hunk-watch-campaigns/campaigns/<campaign-id>` on currie.
- macOS staging: `/Users/justin/hunk-watch-campaigns/campaigns/<campaign-id>` on aarmstrong; Bun is isolated at `/Users/justin/.hunk-watch-tools/bun-1.3.14/bin/bun`.
- Linux staging: `/home/justin/hunk-watch-campaigns/campaigns/<campaign-id>` on sentry-agent; existing `/home/justin/perf` was inspection-only and untouched.
- Windows GHA staging: runner-local `campaigns/<campaign-id>` plus uploaded 30-day artifacts.

Campaign-owned worktrees, binaries, fixture reconstructions, terminal logs, and temporary libraries are cleanup-owned by the campaign operator. Linux recovery inventoried and removed only campaign-created extraction files; unrelated paths were not touched. Remote copies may be deleted after archive/checksum acceptance, but the canonical frozen bundle, raw JSON, terminal evidence, failure records, manifests, provenance, summaries, and checksum index should be retained together.

The reusable fixture/freeze/schema/report pieces have value for a future benchmark, but maintaining the full harness means owning ConPTY adapters, two terminal parsers, OS samplers, workflow behavior, and cross-platform tests. **Recommended disposition:** retain the canonical campaign archive and this report; keep PR #531 free of harness-only code; preserve or extract the reusable core in a focused benchmark follow-up only if another campaign is planned; otherwise delete the temporary harness branch, manual workflow additions, dev-only terminal dependencies, empty changesets, forced-backend seam, and recovery script after the archive is secured. The exact-Bun `scripts/build-bin.ts` fix is independently useful but should be proposed separately if retained.

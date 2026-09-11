# Workspace status

`hunk status --static` prints a compact current-worktree snapshot followed by sibling worktrees.
`hunk status --json` prints the same normalized facts as a JSON object with `schemaVersion: 1`,
without color or paging. Redirects automatically select static output; `--static` pages only
when the snapshot exceeds terminal height, using the ordinary Hunk pager policy.

In a terminal, `hunk status` opens one live workspace compass. Select rows with ↑/↓ (or J/K),
press Enter to open a path in its full comparison or inspect a sibling, U for working-tree changes,
S for staged changes, and L for the existing Log. F10 opens the normal menus, T selects a theme,
R refreshes, and W expands/collapses the bounded worktree list. Menu actions and clickable review
labels provide the same actions with a mouse; double-click a path or sibling to open it.

Q returns from diff to its caller, from Log to status, or from an inspected sibling to its origin;
at the root it quits. Escape/Backspace also return from sibling inspection. Pending preparation
can be cancelled with Q; failures leave the caller usable. Cleanup failures while returning from
Log are reported on status without requiring a second Q or blocking shutdown. Ctrl-C and OS shutdown signals end the
whole session. These journeys share one renderer, the ordinary Pierre-backed multi-file review
stream and the existing Log, not nested terminal applications. Selection and scrolling survive
returns and refresh. Narrow terminals stack path facts rather than adding a file inspector;
arrow/page keys and the mouse wheel scroll within a row taller than the viewport before moving
to another row, keeping all wrapped facts reachable.

Status uses normal config, theme/custom-theme, extension enablement and trust resolution. Its
bootstrap retains one ExtensionSession, launch options, keybindings, session initialization and
view-preference baseline. Inspecting another worktree changes only the provider's explicit target;
it does not load or auto-trust that sibling's extensions or change the shell cwd. Custom palettes,
keybindings and experimental launch opt-ins remain owned by the launch session, including during
review reloads. The resolved transparent-background preference also spans status, Log and diff
through the shared surface-theme derivation. Theme and review preference changes seed later reviews opened directly or through
Log, and the root status surface owns the normal save-preferences prompt. Only a mounted review
registers with the session broker; its source and cwd refer to the inspected target.

## Facts and failures

Git is the initial provider. Native JJ/Sapling detection remains authoritative: unsupported
providers exit nonzero, rather than silently using Git. Explicit `--vcs git` selects Git when
that is the intended comparison model. Outside-repository and bare/no-worktree invocations exit
nonzero with a diagnostic on stderr (including with `--json`). Partial sibling failures remain
in the snapshot and do not fail a readable current worktree.

Paths appear in two counted groups: **Tracked changes** and **Untracked files**. Indented rows
initially follow provider order; live updates retain surviving paths in place within each group and
append new paths. Each group independently shows up to ten files (not wrapped lines). When more
exist, select **and N more files** and press Enter or Space, or click it, to expand that group;
**Show fewer** collapses it again. Exactly ten files need no toggle. Expansion stays local to the
status presentation and survives refresh, Log/diff visits, and sibling inspection/back. Expanding
does not open a file or move focus. Collapsing a group with a now-hidden selected file moves focus
to the group's toggle and brings it into view. Static output keeps the groups and indentation but
prints every file; JSON remains the complete, unchanged fact snapshot.

Tracked paths use readable Git-familiar facts such as `modified (staged)`, `new file (staged)`,
`deleted (unstaged)`, and `renamed (staged)`. Mixed staging displays both sides explicitly, counting
the path only once. There are no XY markers, leading unchanged dots, or marker legends; ordinary
untracked rows need only their filename under **Untracked files**. Staged facts use the active theme's
positive (green-family) sign color; unstaged/untracked facts use its negative (red-family) sign color,
regardless of change type. Custom sign-color overrides are honored. Single-state filenames share
that color; mixed filenames stay neutral with both facts colored independently. Text stays meaningful
without color. Conflicts retain an explicit label and attention color. Rename origins, type changes,
submodule facts and unavailable/error states remain visible, with hanging indentation on wrapped file
rows. A spaced, ruled Other worktrees heading separates the sections in the scrollable stream;
sibling branch identity is emphasized over muted location and facts. No selected-file inspector or
line-count aggregate duplicates the existing diff view. The primary action strip offers the existing
review actions and, only while inspecting a sibling, Back. Log and Quit remain available through
their existing keys and menus rather than occupying that strip.
Snapshot tokens revalidate identity/status when planning reviews, not immutable file contents;
opening a live diff reads the actual working tree through the existing review loader. An explicit
untracked-row open includes untracked files in that full comparison even when launch config sets
`exclude_untracked = true`; its refreshes keep that effective input. Aggregate review actions
and later independent opens still honor launch config. Ignore rules and source safety limits
remain unchanged.

Upstream text omits zero counters: `3 ahead · 1 behind origin/main`. Aligned, absent, deleted
upstream, detached HEAD and unborn branches have distinct facts. Human output omits fetch age:
the current Git provenance records only the inspected worktree's local `FETCH_HEAD` mtime,
which may refer to another remote or have been manually changed. Structured facts retain that
timestamp and `local-fetch-head-mtime` provenance, or explicit unknown/error states when metadata
is missing/unreadable. The approved suffix `(last fetched 18m ago)` requires provenance that
supports that claim; local file mtime does not. Observation time is never used as fetch time,
and no network fetch runs.

## Bounds and refresh seam

Current status loads first; sibling enumeration is a separate cancellable call. Git queries are
shell-free with optional index locking disabled, a 5-second timeout, and an 8 MiB combined output
limit per subprocess. Current paths are capped at 20,000 (exceeding the cap is an error, not a
truncated clean snapshot); sibling scans return at most 100 rows with four concurrent reads and
an explicit truncation flag. Invalid/truncated porcelain and non-UTF-8 paths fail explicitly.
All counts represent unique destination paths, not overlapping staged/unstaged totals.

Linked worktree metadata is resolved separately from the common Git directory. Locked but
accessible worktrees remain inspectable read-only; bare, prunable, missing and inaccessible
worktrees remain distinguishable. Failure to read operation metadata is not reported as idle.

`StatusBootstrap.load`, `loadSiblings`, `planReview` and `watchPlan` accept route cancellation.
`close()` cancels and drains active provider reads; the session host separately shuts down its
ExtensionSession exactly once. Watch plans cover the current tree plus shared/per-worktree Git
metadata and prune object storage and Git-ignored directories. The controller coalesces event bursts,
serializes current reads, and polls every five seconds while watching (more frequently if watching fails).
Current facts appear before sibling summaries. Current refreshes do not wait for a secondary
scan, and same-target safety polls let that scan finish even when it spans multiple poll intervals.
Secondary results update only sibling facts, never newer current observations; the next refresh
after completion starts another scan. Suspending or changing targets cancels and drains the scan. Refreshing/stale/error states stay explicit; prior
sibling rows remain visible during refresh rather than vanishing under the cursor. Target changes
cancel and drain reads/watchers. Observations suspend during Log/diff and resume on return without
resetting navigation. Static CLI never starts a status watcher.

The renderer-free public API is documented in [extensions](extensions.md#workspace-status-capability).

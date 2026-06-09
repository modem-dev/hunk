# Changelog

All notable user-visible changes to Hunk are documented in this file.

## [Unreleased]

### Added

### Changed

### Fixed

- Updated OpenTUI so light and dark theme backgrounds render without the native renderer's color shift.
- Prevented Git watch polling from taking optional index locks while discovering untracked files.

## [0.15.1] - 2026-06-09

### Fixed

- Restored the `e` keyboard shortcut and menu hint for opening the selected file in `$EDITOR`.

## [0.15.0] - 2026-06-08

### Added

- Show the newly selected theme in the footer status bar when switching themes.
- Added Catppuccin Frappé and Macchiato as built-in themes, completing the four official Catppuccin flavors.
- Added a Zenburn built-in theme (`theme = "zenburn"`), a warm low-contrast dark palette inspired by Jani Nurminen's original Zenburn. It also works as a custom-theme `base`.
- Added a `--transparent-bg` flag and `transparent_background` config option for translucent terminal setups.
- Added Sapling VCS backend support for `hunk diff` and `hunk show`.

### Changed

### Fixed

- Preserved split diff alignment when horizontal scrolling starts inside a wide CJK or emoji character.
- Made diff syntax highlighting follow the active theme: keyword, function, number, and variable token colors now resolve to the configured theme's palette (including custom themes) in both light and dark, instead of passing through Pierre's built-in syntax colors.
- Expanded the diff window during rapid scrolling bursts so large reviews keep real rows mounted instead of falling back to blank placeholder regions.

## [0.14.1] - 2026-06-01

### Added

- Added local performance benchmarks for Hunk startup, loading, rendering, highlighting, navigation, memory, and optional competitor comparisons.

### Changed

### Fixed

- Fixed npm installs by pinning `@pierre/diffs` to the version Hunk is tested with instead of allowing the broken `1.2.6` release.

## [0.14.0] - 2026-05-26

### Added

- Added Catppuccin Latte and Mocha as built-in themes.
- Added mouse-drag text selection in diff views that copies selected rows to the system clipboard via OSC 52. A `View > Copy decorations` toggle (or `copy_decorations` config) controls whether the clipboard includes diff rails, gutters, and file headers or only the changed code.
- Added inline expansion for collapsed unchanged file content. Click an unchanged-context row (`▾ N unchanged lines` when expandable, otherwise the static `··· N unchanged lines ···` form) or press `e` while a hunk is selected to reveal surrounding and trailing file lines without leaving the review. The affordance is shown only for input modes that have reachable source content (`hunk diff`, `show`, `stash show`, file-pair `diff` and `difftool`, untracked files); raw `hunk patch` input still renders as before. Failed and in-flight loads surface a one-line status ("Loading…", "Could not load N unchanged lines") on the gap row. Expanded context rows use the same syntax highlighting as the surrounding diff.
- Surfaced the agent author name in inline notes and the matching agent popover so multi-agent reviews are readable at a glance, with a fallback title when an annotation has no author.

### Changed

### Fixed

- Preserved Git log ANSI colors when `hunk pager` falls back to a plain-text terminal pager for non-diff output.
- Capped inline context expansion source reads so huge files cannot freeze or exhaust memory when expanding unchanged lines.
- Hardened plain-text pager startup so `PAGER` and `HUNK_TEXT_PAGER` shell metacharacters are passed as arguments instead of being evaluated implicitly.
- Hardened terminal rendering against control-sequence injection from diffs, file paths, notes, expanded context, copied selections, and pager fallback output.
- Fixed custom theme configuration so Catppuccin Latte and Mocha can be used as base themes.
- Fixed inline note draft shortcuts so copy chords such as Ctrl-C and Ctrl-Shift-C no longer trigger note actions.
- Fixed split diff alignment for wide CJK and emoji characters by measuring rendered text in terminal cells.
- Fixed Ctrl-S saving for inline notes when tmux sends CSI-u keyboard input.
- Stabilized hover backgrounds on wrapped diff rows so add-note affordances do not shift row layout.
- Restricted session reloads so daemon commands cannot read files outside the initial Hunk session root.
- Fixed static pager output so captured pager hosts honor configured custom themes.
- Made `hunk pager` pass non-diff text through in captured pager and dumb-terminal contexts instead of spawning `less`.
- Fixed the `e` editor shortcut when Hunk is launched from a repo subdirectory.
- Fixed VCS auto-detection so a Git repository nested under a parent Jujutsu workspace still uses Git mode by default.

## [0.13.1] - 2026-05-19

### Fixed

- Hid the inline add-note affordance while scrolling and only show it after deliberate pointer movement, so it no longer flickers during review navigation.
- Hardened the local session daemon against browser-originated requests by validating Host and Origin headers and requiring JSON content types for API posts.
- Disabled the generic broker HTTP API by default so Hunk's supported session API is the only app-daemon command surface.
- Bounded session daemon memory by capping HTTP request body and websocket message sizes and rejecting session registrations with oversized file, hunk, patch, comment, or note payloads.

## [0.13.0] - 2026-05-18

### Added

- Added an `e` shortcut to open the selected diff file in `$EDITOR`.
- Added `g` and `G` keyboard aliases for jump-to-top and jump-to-bottom review navigation.
- Added session-persistent user-authored inline notes with `c` to draft/save notes.
- Added `hunk session comment list --type <live|all|ai|agent|user>` so agents can read human-authored notes through the comment workflow.

### Changed

- Clarified inline note draft actions by labeling buttons as `Save (^S)` and `Cancel (Esc)`.

### Fixed

- Fixed draft note focus handling so app shortcuts resume after the note textarea blurs without discarding the draft.
- Preserved the resolved auto theme across `--watch` refreshes instead of falling back to the default dark theme.
- Fixed standalone release archive generation so staged npm package directories are not accidentally packaged as GitHub release assets.

## [0.12.1] - 2026-05-14

### Fixed

- Included the bundled Hunk review skill in standalone prebuilt release archives so `hunk skill path` works after extracting a tarball or installing via Homebrew.

## [0.12.0] - 2026-05-12

### Added

- Added Homebrew tap release automation and Homebrew-aware startup update notices.
- Added lower-level `hunkdiff/opentui` primitives for embedding Hunk diff bodies, file headers, file navigation, and multi-file review streams in custom OpenTUI apps.
- Added row windowing for large single-file reviews to keep huge diffs responsive.
- Added Windows x64 prebuilt artifact publishing to the release workflow.
- Added native Windows support in the README, contributor guide, and local build/install scripts.
- Added Nix flake app outputs for `nix run`, a named `hunk` package output, and package validation.
- Added automatic light/dark theme detection from the terminal background when `theme = "auto"` is enabled.

### Changed

- Ported `build:npm`, `build:bin`, and `install:bin` from bash scripts to cross-platform Bun-runnable TypeScript so native Windows contributors no longer need Git Bash to build or install Hunk locally.

### Fixed

- Fixed the prebuilt npm package so the `hunkdiff/opentui` export and bundled type declarations are included.
- Fixed the npm package so `npx hunkdiff` and other package-name executable lookups resolve to the Hunk CLI.
- Made `hunk pager` emit static highlighted diff output for captured pager contexts like LazyGit, and pass diff input through unchanged when stdout is non-interactive.
- Fixed Ctrl-Z job-control suspend support so Hunk can suspend and resume cleanly from a terminal.
- Fixed Windows compatibility issues across paths, packaging, and tests.
- Fixed Ctrl-C in the live TUI so it exits through Hunk's full shutdown path instead of only destroying the renderer.

## [0.11.1] - 2026-05-10

### Added

### Changed

- Auto-detect Jujutsu checkouts for `hunk diff` and `hunk show`, while keeping explicit `vcs` config overrides.

### Fixed

- Fixed large tracked and untracked file handling so very large diffs render as skipped placeholders instead of slowing startup or overflowing the JavaScript call stack.
- Fixed Git patch parsing for `diff.noprefix=true` input so Hunk restores parser-safe `a/` and `b/` prefixes without mangling real paths.
- Fixed `hunk pager` parsing for Git diffs emitted with `diff.mnemonicPrefix=true` so file paths do not keep `i/`, `w/`, `c/`, `1/`, or `2/` side prefixes.
- Fixed review scrolling so viewport updates are coalesced and no longer risk a render loop.
- Fixed agent comment hunk ranges so context lines from hunk headers remain part of the target range.
- Fixed untracked-file reviews in repositories with external diff tools configured by passing `--no-ext-diff`.
- Fixed diff geometry for hunks with multiple agent notes so offscreen notes no longer skew scrolling measurements.

## [0.11.0] - 2026-05-09

### Added

- Added `vcs = "jj"` support, enabling `hunk diff [revset]` and `hunk show [revset]`.
- Added a pager-mode sidebar file tree that can be revealed with the existing `s` shortcut while keeping pager chrome hidden by default.

### Changed

### Fixed

- Fixed `git log -p` and multi-commit `git show -p` inputs so patch parsing ignores commit metadata instead of emitting Pierre parser warnings.
- Fixed cross-file hunk navigation so near-boundary jumps keep the selected file pinned and backward jumps reveal the target hunk instead of the file top.
- Fixed the View menu sidebar checkmark so it follows whether the responsive layout is actually rendering the sidebar.

## [0.10.0] - 2026-04-21

### Added

- Added agent comment counts in the sidebar so review-heavy files stand out at a glance.
- Added `hunk daemon serve` as the standard daemon entrypoint and published reusable session-broker packages plus an OpenTUI diff component for integrators.

### Changed

- Included untracked files when `hunk diff <ref>` still compares against the live working tree, while keeping explicit revset diffs commit-to-commit only.

### Fixed

- Enabled mouse scrolling in pager mode.
- Balanced Pierre word-level highlights so split-view inline changes stay visible without overpowering the surrounding diff row.
- Smoothed mouse-wheel review scrolling so small diffs stay precise while sustained wheel gestures still speed up.
- Fixed Shift+mouse-wheel horizontal scrolling so it no longer leaks a one-line vertical scroll in some terminals.

## [0.9.5] - 2026-04-21

### Added

- Added a Modem sponsor block to the README.

### Changed

### Fixed

## [0.9.4] - 2026-04-14

### Added

- Added `hunk skill path` to print the bundled Hunk review skill path for direct loading or symlinking in coding agents.

### Changed

- Show a one-time startup notice after version changes that points users with copied agent skills to `hunk skill path`.

### Fixed

- Restored execute permissions for packaged prebuilt binaries so `npm install -g hunkdiff` works on root-owned installs without `spawnSync … EACCES` failures.

## [0.9.3] - 2026-04-13

### Fixed

- Normalized rename-only diff paths so pure renames keep one clean `old/path -> new/path` header in the review UI ([#194](https://github.com/modem-dev/hunk/pull/194)).
- Stripped Pierre's empty-line newline placeholder spans so blank additions and deletions keep stable line numbers and diff row backgrounds ([#201](https://github.com/modem-dev/hunk/pull/201)).

## [0.9.2] - 2026-04-11

### Fixed

- Fixed a bottom-edge scrolling regression where short last files could snap back and make upward navigation feel stuck near the end of the review stream ([#196](https://github.com/modem-dev/hunk/pull/196)).

## [0.9.1] - 2026-04-10

### Fixed

- Preserved viewport position when switching layouts ([#185](https://github.com/modem-dev/hunk/pull/185)).
- Skipped binary file contents in reviews while keeping binary files visible in the review stream with a `Binary file skipped` placeholder ([#187](https://github.com/modem-dev/hunk/pull/187)).

## [0.9.0] - 2026-04-08

### Added

- Added `hunk session review --json` for full live-session exports ([#160](https://github.com/modem-dev/hunk/pull/160)).
- Added horizontal code-column scrolling in review mode ([#171](https://github.com/modem-dev/hunk/pull/171)).
- Added batch apply support for live session comments in agent review flows ([#179](https://github.com/modem-dev/hunk/pull/179)).

### Changed

- Pinned the current file header while scrolling the review pane ([#141](https://github.com/modem-dev/hunk/pull/141)).
- Made session comment focus opt-in instead of forcing comment focus by default ([#163](https://github.com/modem-dev/hunk/pull/163)).
- Synced active hunks to mouse scrolling and prefetched diff highlighting for smoother navigation ([#172](https://github.com/modem-dev/hunk/pull/172)).
- Hid zero-value sidebar file stats to reduce visual noise ([#174](https://github.com/modem-dev/hunk/pull/174)).
- Updated in-app controls help ([#175](https://github.com/modem-dev/hunk/pull/175)).
- Sped up syntax-highlight row building in large diffs ([#177](https://github.com/modem-dev/hunk/pull/177)).

### Fixed

- Reported the packaged version correctly in installed builds ([#153](https://github.com/modem-dev/hunk/pull/153)).
- Fixed stale syntax highlights after reloads ([#146](https://github.com/modem-dev/hunk/pull/146)).
- Fixed diff pane header popping while scrolling ([#159](https://github.com/modem-dev/hunk/pull/159)).
- Avoided failures on untracked directory symlinks ([#169](https://github.com/modem-dev/hunk/pull/169)).
- Aligned top-menu dropdowns correctly ([#176](https://github.com/modem-dev/hunk/pull/176)).
- Restored live escape handling in PTY flows ([#173](https://github.com/modem-dev/hunk/pull/173)).
- Kept viewport-follow selection from jumping unexpectedly ([#181](https://github.com/modem-dev/hunk/pull/181)).
- Refreshed stale daemons after upgrades ([#178](https://github.com/modem-dev/hunk/pull/178)).
- Rejected incompatible live session registrations more clearly ([#180](https://github.com/modem-dev/hunk/pull/180)).
- Versioned daemon compatibility separately from other MCP behavior ([#183](https://github.com/modem-dev/hunk/pull/183)).

## [0.8.1] - 2026-03-30

### Fixed

- Enabled `j` and `k` step scrolling in normal mode ([#131](https://github.com/modem-dev/hunk/pull/131)).
- Aligned inline note rendering more cleanly beside diffs ([#137](https://github.com/modem-dev/hunk/pull/137)).

## [0.8.0] - 2026-03-29

### Added

- Added file state indicators to the sidebar ([#128](https://github.com/modem-dev/hunk/pull/128)).
- Added comment-to-comment navigation in review mode ([#126](https://github.com/modem-dev/hunk/pull/126)).
- Included TTY and tmux pane metadata in session lists ([#90](https://github.com/modem-dev/hunk/pull/90)).
- Added worktree-based session path targeting for session workflows ([#118](https://github.com/modem-dev/hunk/pull/118)).

### Changed

- Included untracked files in working-tree diff reviews by default ([#123](https://github.com/modem-dev/hunk/pull/123)).
- Surfaced a transient startup update notice ([#127](https://github.com/modem-dev/hunk/pull/127)).
- Refined top-level CLI help text and files/filter focus copy ([#129](https://github.com/modem-dev/hunk/pull/129), [#121](https://github.com/modem-dev/hunk/pull/121)).

### Fixed

- Fixed keyboard help dialog row overlap ([#122](https://github.com/modem-dev/hunk/pull/122)).
- Fixed scrollbar click-drag behavior on large diffs ([#120](https://github.com/modem-dev/hunk/pull/120)).

## [0.7.0] - 2026-03-25

### Added

- Grouped sidebar files by folder for easier navigation in large reviews ([#99](https://github.com/modem-dev/hunk/pull/99)).
- Added `Ctrl+D`, `Ctrl+U`, and `Shift+Space` navigation shortcuts ([#102](https://github.com/modem-dev/hunk/pull/102)).
- Added an auto-hiding vertical scrollbar to the diff pane ([#93](https://github.com/modem-dev/hunk/pull/93)).
- Added Linux arm64 prebuilt package release support ([#107](https://github.com/modem-dev/hunk/pull/107)).

### Fixed

- Prevented scroll snapback when using `Space`, `PageUp`, and `PageDown` ([#105](https://github.com/modem-dev/hunk/pull/105)).
- Normalized Git patch prefixes for parser compatibility ([#106](https://github.com/modem-dev/hunk/pull/106)).
- Kept selected hunks fully visible when they fit in the viewport ([#108](https://github.com/modem-dev/hunk/pull/108)).
- Fixed wrap-toggle redraws while preserving the viewport anchor ([#110](https://github.com/modem-dev/hunk/pull/110)).

## [0.6.1] - 2026-03-24

### Added

- Added watch mode for reloadable reviews ([#91](https://github.com/modem-dev/hunk/pull/91)).

### Changed

- Fit menu dropdowns to their contents ([#92](https://github.com/modem-dev/hunk/pull/92)).

### Fixed

- Shut down idle session daemons more reliably ([#96](https://github.com/modem-dev/hunk/pull/96)).
- Coordinated singleton daemon launches to avoid duplicate background processes ([#97](https://github.com/modem-dev/hunk/pull/97)).
- Exited the daemon process cleanly after shutdown ([#98](https://github.com/modem-dev/hunk/pull/98)).

## [0.6.0] - 2026-03-23

### Added

- Added a reload shortcut for the current diff ([#83](https://github.com/modem-dev/hunk/pull/83)).

### Changed

- Optimized large split review streams for faster rendering on big changesets ([#76](https://github.com/modem-dev/hunk/pull/76)).
- Replaced footer hints with a keyboard help modal ([#88](https://github.com/modem-dev/hunk/pull/88)).

### Fixed

- Restored daemon autostart for prebuilt npm binaries ([#84](https://github.com/modem-dev/hunk/pull/84)).
- Detected `$bunfs` virtual paths correctly when autostarting daemons from Bun binaries ([#86](https://github.com/modem-dev/hunk/pull/86)).
- Published prerelease tags to npm under the `beta` dist-tag ([#87](https://github.com/modem-dev/hunk/pull/87)).

## [0.5.1] - 2026-03-23

### Fixed

- Improved friendly Git command errors during CLI failures ([#75](https://github.com/modem-dev/hunk/pull/75)).

## [0.5.0] - 2026-03-22

### Added

- Added inline agent notes across the review stream, including side-aware range guides ([#69](https://github.com/modem-dev/hunk/pull/69), [#62](https://github.com/modem-dev/hunk/pull/62)).
- Added a session control CLI and a session reload command for live review workflows ([#50](https://github.com/modem-dev/hunk/pull/50), [#63](https://github.com/modem-dev/hunk/pull/63)).
- Added live session comment lifecycle support and expanded the MCP tool surface ([#53](https://github.com/modem-dev/hunk/pull/53), [#39](https://github.com/modem-dev/hunk/pull/39)).
- Added curated Hunk demo examples ([#34](https://github.com/modem-dev/hunk/pull/34)).

### Changed

- Made Graphite the default theme ([#57](https://github.com/modem-dev/hunk/pull/57)).
- Switched review rendering and scroll math to an explicit review row plan for more consistent navigation ([#64](https://github.com/modem-dev/hunk/pull/64), [#67](https://github.com/modem-dev/hunk/pull/67)).

### Fixed

- Hardened MCP daemon lifecycle handling and kept the daemon loopback-only by default ([#36](https://github.com/modem-dev/hunk/pull/36), [#46](https://github.com/modem-dev/hunk/pull/46)).
- Refreshed stale MCP daemons when using the session CLI ([#55](https://github.com/modem-dev/hunk/pull/55)).
- Let the sidebar shortcut force the files pane open ([#56](https://github.com/modem-dev/hunk/pull/56)).

## [0.4.0] - 2026-03-22

### Added

- Auto-started the MCP daemon when needed for live sessions ([#29](https://github.com/modem-dev/hunk/pull/29)).
- Added arrow-key line-by-line scrolling ([#30](https://github.com/modem-dev/hunk/pull/30)).

## [0.3.0] - 2026-03-22

### Added

- Added prebuilt npm binary packaging and automated npm releases, including beta tag support ([#12](https://github.com/modem-dev/hunk/pull/12), [#14](https://github.com/modem-dev/hunk/pull/14), [#15](https://github.com/modem-dev/hunk/pull/15)).
- Added a top-level `hunk --version` command ([#19](https://github.com/modem-dev/hunk/pull/19)).
- Added the experimental MCP daemon for live Hunk sessions ([#22](https://github.com/modem-dev/hunk/pull/22)).

### Changed

- Always showed the diff rail while dimming inactive hunks ([#16](https://github.com/modem-dev/hunk/pull/16)).
- Decoupled sidebar visibility from layout toggles ([#18](https://github.com/modem-dev/hunk/pull/18)).
- Stopped auto-saving view preferences to config files ([#13](https://github.com/modem-dev/hunk/pull/13)).

### Fixed

- Used a supported Intel macOS runner for prebuilt release builds ([#17](https://github.com/modem-dev/hunk/pull/17)).
- Preserved executable permissions for prebuilt binaries after installation.

## [0.2.0] - 2026-03-20

### Fixed

- Fixed npm installs by bundling Bun in published packages ([#11](https://github.com/modem-dev/hunk/pull/11)).

## [0.1.0] - 2026-03-20

### Added

- Initial Hunk release with split and stack terminal diff views built around a single multi-file review stream.
- Added git-style `diff` and `show` commands plus a general Git pager wrapper for drop-in review workflows.
- Added persistent Hunk view preferences across sessions ([#7](https://github.com/modem-dev/hunk/pull/7)).
- Added agent-note anchored review flows, responsive layouts, and display toggles for line numbers, wrapping, and hunk metadata.

### Changed

- Simplified the review chrome around a menu bar, lighter borders, and diff-focused headers.
- Improved startup and large-review performance with windowed diff sections and deferred syntax highlighting.

### Fixed

- Stabilized diff repainting, active-hunk scrolling, syntax highlighting, pager stdin patch handling, and terminal cleanup on exit.

[Unreleased]: https://github.com/modem-dev/hunk/compare/v0.15.1...HEAD
[0.15.1]: https://github.com/modem-dev/hunk/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/modem-dev/hunk/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/modem-dev/hunk/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/modem-dev/hunk/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/modem-dev/hunk/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/modem-dev/hunk/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/modem-dev/hunk/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/modem-dev/hunk/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/modem-dev/hunk/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/modem-dev/hunk/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/modem-dev/hunk/compare/v0.9.5...v0.10.0
[0.9.5]: https://github.com/modem-dev/hunk/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/modem-dev/hunk/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/modem-dev/hunk/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/modem-dev/hunk/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/modem-dev/hunk/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/modem-dev/hunk/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/modem-dev/hunk/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/modem-dev/hunk/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/modem-dev/hunk/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/modem-dev/hunk/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/modem-dev/hunk/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/modem-dev/hunk/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/modem-dev/hunk/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/modem-dev/hunk/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/modem-dev/hunk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/modem-dev/hunk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/modem-dev/hunk/tree/v0.1.0

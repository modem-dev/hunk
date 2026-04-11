# Changelog

All notable user-visible changes to Hunk are documented in this file.

## [Unreleased]

### Added

- Added `hunk skill path` to print the bundled Hunk review skill path for direct loading or symlinking in coding agents.

### Changed

- Show a one-time startup notice after version changes that points users with copied agent skills to `hunk skill path`.

### Fixed

- Fixed a bottom-edge scroll trap that could snap the review pane back when the last short file or hunk was selected near the end of the stream.

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

[Unreleased]: https://github.com/modem-dev/hunk/compare/v0.9.1...HEAD
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

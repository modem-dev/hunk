# Changelog

All notable user-visible changes to Hunk are documented in this file.

## [Unreleased]

### Added

### Changed

### Fixed

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

[Unreleased]: https://github.com/modem-dev/hunk/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/modem-dev/hunk/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/modem-dev/hunk/compare/v0.8.1...v0.9.0

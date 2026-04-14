# Changelog

## [Unreleased]

### Added

### Changed

### Fixed

## [0.9.5] - 2026-04-14

### Fixed

- Restore execute permissions for packaged prebuilt binaries so `npm install -g hunkdiff` no longer fails with `spawnSync … EACCES` on root-owned installs.

## [0.9.4-beta.0] - 2026-04-14

### Fixed

- Restore execute permissions for packaged prebuilt binaries so `npm install -g hunkdiff` no longer fails with `spawnSync … EACCES` on root-owned installs.

## [0.9.3] - 2026-04-13

### Fixed

- Normalize rename-only diff paths so pure renames keep one clean `old/path -> new/path` header in the review UI.
- Strip Pierre's empty-line newline placeholder spans so blank additions and deletions keep stable line numbers and diff row backgrounds.

## [0.9.2] - 2026-04-11

### Fixed

- Fix a bottom-edge scrolling regression where short last files could snap back and make upward navigation feel stuck near the end of the review stream.

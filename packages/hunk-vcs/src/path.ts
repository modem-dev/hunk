import fs from "node:fs";
import { basename, dirname, resolve } from "node:path";

/**
 * Canonicalize one filesystem path, resolving through existing ancestors.
 *
 * This is the single normalizer for paths Hunk compares or persists as keys.
 * The same directory can be spelled several ways on one machine — through a
 * symlinked ancestor (`/tmp` on macOS, a symlinked home on Linux), through an
 * 8.3 short name or a differently cased drive letter on Windows — and plain
 * `resolve` preserves every one of those spellings, so two layers that both
 * "resolve" a path can still disagree about whether they mean the same
 * directory. `realpathSync.native` collapses all of them to the form the OS
 * itself reports, which is also the form Git's `--show-toplevel` prints.
 *
 * A path whose leaf does not exist yet is resolved through its nearest existing
 * ancestor instead, so a missing file still cannot hide behind an intermediate
 * symlink.
 */
export function resolveCanonicalPath(path: string) {
  const absolutePath = resolve(path);
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    // Continue below so non-existent leaves still get their ancestors resolved.
  }

  const missingSegments: string[] = [];
  let current = absolutePath;

  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      return absolutePath;
    }

    missingSegments.unshift(basename(current));
    current = parent;

    try {
      return resolve(fs.realpathSync.native(current), ...missingSegments);
    } catch {
      // Keep walking until we find an existing ancestor or hit the filesystem root.
    }
  }
}

/** Normalize compatibility-layer paths into native paths for the current OS. */
export function normalizePathForOS(path: string, platform = process.platform) {
  switch (platform) {
    case "win32":
      return normalizeWindowsCompatibilityPath(path);
    default:
      return path;
  }
}

/** Convert Unix-style Windows paths to native paths usable as Bun cwd. */
function normalizeWindowsCompatibilityPath(path: string) {
  const normalized = path
    // Some Windows tools can report slash-prefixed drive paths as `/C:/...`.
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    // Keep specific compatibility-layer prefixes before the generic `/c/...` form.
    // Cygwin commonly reports drive paths as `/cygdrive/c/...`.
    .replace(/^\/cygdrive\/([a-zA-Z])(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    // WSL-style paths are commonly reported as `/mnt/c/...`.
    .replace(/^\/mnt\/([a-zA-Z])(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    // Git Bash/MSYS2 commonly reports drive paths as `/c/...`.
    .replace(/^\/([a-zA-Z])(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`);

  return normalized === path ? path : normalized.replaceAll("/", "\\");
}

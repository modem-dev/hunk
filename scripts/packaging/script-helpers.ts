#!/usr/bin/env bun

/**
 * Shared cross-platform helpers for Bun-driven repo scripts.
 *
 * On Windows, Node ships `npm` (a shell-script shim) alongside `npm.cmd`. Bun
 * (and Node `child_process` without `shell: true`) cannot execute the shim
 * directly, so we must spawn the `.cmd` wrapper instead. The helpers below
 * give scripts one place to resolve those names.
 */

/** Command name to invoke `npm` from Bun.spawn on the current platform. */
export const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Build a child-process env that overrides PATH cleanly on every platform.
 *
 * Windows environment variables are case-insensitive, but `{ ...process.env }`
 * preserves whatever case Bun reported (often `Path`). Setting `PATH: ...` on
 * top of that produces an env object with both `Path` (the original system
 * value) and `PATH` (the sanitized value); the child inherits both, and
 * Windows resolves lookups against the un-normalized union, defeating any
 * attempt to scope PATH. We strip every case-variant first, then set PATH.
 */
export function envWithPath(
  path: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.toLowerCase() !== "path") {
      next[key] = value;
    }
  }
  next.PATH = path;
  return next;
}

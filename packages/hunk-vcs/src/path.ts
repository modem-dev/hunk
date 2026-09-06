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

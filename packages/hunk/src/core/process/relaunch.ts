const SCRIPT_ENTRYPOINT_PATTERN = /[\\/]|\.(?:[cm]?js|tsx?)$/;
const BUNFS_PREFIX = "/$bunfs/";
const BUNFS_WINDOWS_PREFIX = "b:/~bun/";

export interface HunkLaunchCommand {
  command: string;
  args: string[];
}

/** Return whether an entrypoint is Bun's virtual compiled-executable path. */
function isBunfsEntrypoint(entrypoint: string) {
  return (
    entrypoint.startsWith(BUNFS_PREFIX) ||
    entrypoint.replaceAll("\\", "/").toLowerCase().startsWith(BUNFS_WINDOWS_PREFIX)
  );
}

/** Resolve the executable and stable prefix needed to launch this Hunk installation again. */
export function resolveCurrentHunkCommand(
  argv = process.argv,
  execPath = process.execPath,
): HunkLaunchCommand {
  const entrypoint = argv[1];
  if (entrypoint && isBunfsEntrypoint(entrypoint)) {
    return { command: execPath, args: [] };
  }
  if (entrypoint && !entrypoint.startsWith("-") && SCRIPT_ENTRYPOINT_PATTERN.test(entrypoint)) {
    return { command: execPath, args: [entrypoint] };
  }
  return { command: execPath, args: [] };
}

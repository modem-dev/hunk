/** Names every built-in top-level CLI command and alias Hunk reserves. */
export const BUILT_IN_CLI_COMMAND_NAMES = new Set([
  "diff",
  "show",
  "log",
  "patch",
  "pager",
  "difftool",
  "stash",
  "session",
  "markup",
  "skill",
  "extension",
  "ext",
  "update",
  "daemon",
  "mcp",
  "help",
  "version",
]);

/** Return whether a token selects a built-in top-level command or alias. */
export function isBuiltInCliCommandName(name: string) {
  return BUILT_IN_CLI_COMMAND_NAMES.has(name);
}

/** Return whether a token can be claimed as an extension top-level command. */
export function isValidExtensionCliCommandName(name: string) {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

/** Return whether an extension CLI command name belongs to Hunk itself. */
export function isReservedExtensionCliCommandName(name: string) {
  return isBuiltInCliCommandName(name);
}

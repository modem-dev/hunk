/**
 * Strip ANSI escape sequences (DCS, OSC, CSI, single-byte controls) from terminal output.
 *
 * Shared between the pager sniffer and the patch normalizer so colored Git output parses
 * the same way regardless of which entrypoint receives it.
 */
export function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

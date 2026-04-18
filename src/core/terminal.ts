import fs from "node:fs";
import tty from "node:tty";
import type { CliInput } from "./types";

export interface AppMouseOptions {
  stdinIsTTY?: boolean;
  hasControllingTerminal?: boolean;
}

/** Detect the stdin-pipe patch workflow used by `git diff` pagers. */
export function usesPipedPatchInput(input: CliInput, stdinIsTTY = Boolean(process.stdin.isTTY)) {
  return input.kind === "patch" && (!input.file || input.file === "-") && !stdinIsTTY;
}

/** Enable pager-style chrome automatically when Hunk is consuming a piped patch. */
export function shouldUsePagerMode(input: CliInput, stdinIsTTY = Boolean(process.stdin.isTTY)) {
  return Boolean(input.options.pager) || usesPipedPatchInput(input, stdinIsTTY);
}

/** Apply runtime CLI defaults that depend on whether stdin is an interactive terminal. */
export function resolveRuntimeCliInput(
  input: CliInput,
  stdinIsTTY = Boolean(process.stdin.isTTY),
): CliInput {
  return {
    ...input,
    options: {
      ...input.options,
      pager: shouldUsePagerMode(input, stdinIsTTY),
    },
  } as CliInput;
}

/** Keep mouse support tied to terminal interactivity instead of pager chrome mode. */
export function shouldUseMouseForApp({
  stdinIsTTY = Boolean(process.stdin.isTTY),
  hasControllingTerminal = false,
}: AppMouseOptions = {}) {
  return stdinIsTTY || hasControllingTerminal;
}

export interface ControllingTerminal {
  stdin: tty.ReadStream;
  close: () => void;
}

/** Minimal terminal construction hooks so tests can cover `/dev/tty` attach behavior. */
export interface ControllingTerminalDeps {
  openSync: typeof fs.openSync;
  createReadStream: (fd: number) => tty.ReadStream;
}

/**
 * Open the controlling terminal for input so the UI can stay interactive while stdin carries patch
 * data. Rendering can continue through the existing stdout stream.
 */
export function openControllingTerminal(
  deps: ControllingTerminalDeps = {
    openSync: fs.openSync,
    createReadStream: (fd) => new tty.ReadStream(fd),
  },
): ControllingTerminal | null {
  try {
    const stdinFd = deps.openSync("/dev/tty", "r");
    const stdin = deps.createReadStream(stdinFd);

    return {
      stdin,
      close: () => {
        stdin.destroy();
      },
    };
  } catch {
    return null;
  }
}

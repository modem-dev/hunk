import fs from "node:fs";
import tty from "node:tty";
import type { CliInput } from "../run/commandInputs";

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

type TerminalDisconnectEvent = "close" | "end" | "error";

export interface TerminalInputEvents {
  isTTY?: boolean;
  destroyed?: boolean;
  readableEnded?: boolean;
  on: (event: TerminalDisconnectEvent, listener: (...args: unknown[]) => void) => unknown;
  off: (event: TerminalDisconnectEvent, listener: (...args: unknown[]) => void) => unknown;
}

export interface TerminalDisconnectSupport {
  dispose: () => void;
}

/** Shut the app down when its renderer input is closed or revoked by the terminal host. */
export function installTerminalDisconnectSupport(
  input: TerminalInputEvents,
  onDisconnect: () => void,
): TerminalDisconnectSupport {
  if (input.isTTY !== true) {
    return { dispose: () => undefined };
  }

  const events: TerminalDisconnectEvent[] = ["close", "end", "error"];
  let disposed = false;

  const disconnect = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    onDisconnect();
  };

  for (const event of events) {
    input.on(event, disconnect);
  }

  // Stream ended before listeners handle disconnect
  if (input.destroyed || input.readableEnded) {
    queueMicrotask(disconnect);
  }

  return {
    dispose: () => {
      disposed = true;
      for (const event of events) {
        input.off(event, disconnect);
      }
    },
  };
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

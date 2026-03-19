import fs from "node:fs";
import tty from "node:tty";
import type { CliInput } from "./types";

/** Detect the stdin-pipe patch workflow used by `git diff` pagers. */
export function usesPipedPatchInput(input: CliInput, stdinIsTTY = Boolean(process.stdin.isTTY)) {
  return input.kind === "patch" && (!input.file || input.file === "-") && !stdinIsTTY;
}

/** Enable pager-style chrome automatically when Hunk is consuming a piped patch. */
export function shouldUsePagerMode(input: CliInput, stdinIsTTY = Boolean(process.stdin.isTTY)) {
  return Boolean(input.options.pager) || usesPipedPatchInput(input, stdinIsTTY);
}

/** Apply runtime CLI defaults that depend on whether stdin is an interactive terminal. */
export function resolveRuntimeCliInput(input: CliInput, stdinIsTTY = Boolean(process.stdin.isTTY)): CliInput {
  return {
    ...input,
    options: {
      ...input.options,
      pager: shouldUsePagerMode(input, stdinIsTTY),
    },
  } as CliInput;
}

export interface ControllingTerminal {
  stdin: tty.ReadStream;
  stdout: tty.WriteStream;
  close: () => void;
}

/** Open the controlling terminal so the UI can stay interactive while stdin carries patch data. */
export function openControllingTerminal(): ControllingTerminal | null {
  try {
    const stdinFd = fs.openSync("/dev/tty", "r");
    const stdoutFd = fs.openSync("/dev/tty", "w");
    const stdin = new tty.ReadStream(stdinFd);
    const stdout = new tty.WriteStream(stdoutFd);

    return {
      stdin,
      stdout,
      close: () => {
        stdin.destroy();
        stdout.destroy();
      },
    };
  } catch {
    return null;
  }
}

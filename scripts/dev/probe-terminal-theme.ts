#!/usr/bin/env bun

import fs from "node:fs";
import tty from "node:tty";
import {
  detectTerminalColors,
  themeModeForTerminalColors,
} from "../../packages/hunk/src/core/theme/detection";

const inputFd = fs.openSync("/dev/tty", "r");
const input = new tty.ReadStream(inputFd);
const output = process.stdout.isTTY
  ? process.stdout
  : new tty.WriteStream(fs.openSync("/dev/tty", "w"));

let raw = "";
input.on("data", (chunk) => {
  raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
});

try {
  const colors = await detectTerminalColors({ input, output, timeoutMs: 500 });
  const mode = themeModeForTerminalColors(colors) ?? null;

  process.stderr.write(
    JSON.stringify(
      {
        mode,
        colors,
        raw: raw.replaceAll("\x1b", "\\e"),
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        stdinIsTTY: Boolean(process.stdin.isTTY),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  input.destroy();
  if (output !== process.stdout) {
    output.destroy();
  }
}

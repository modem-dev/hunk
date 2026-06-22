#!/usr/bin/env bun

import fs from "node:fs";
import tty from "node:tty";
import {
  detectTerminalThemeModeFromBackground,
  parseOsc11BackgroundColor,
  themeModeForBackgroundColor,
} from "../src/core/themeDetection";

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
  const mode = await detectTerminalThemeModeFromBackground({ input, output, timeoutMs: 500 });
  const color = parseOsc11BackgroundColor(raw);
  const classified = color ? themeModeForBackgroundColor(color) : null;

  process.stderr.write(
    JSON.stringify(
      {
        mode,
        color,
        classified,
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

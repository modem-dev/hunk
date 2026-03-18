#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { parseCli } from "./core/cli";
import { loadAppBootstrap } from "./core/loaders";
import { shutdownSession } from "./core/shutdown";
import { App } from "./ui/App";

const cliInput = await parseCli(process.argv);
const bootstrap = await loadAppBootstrap(cliInput);

const renderer = await createCliRenderer({
  useMouse: !cliInput.options.pager,
  useAlternateScreen: true,
  exitOnCtrlC: true,
  openConsoleOnError: true,
});

const root = createRoot(renderer);
let shuttingDown = false;

/** Tear down the renderer before exit so the primary terminal screen comes back cleanly. */
function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  shutdownSession({ root, renderer });
}

// The app owns the full alternate screen session from this point on.
root.render(<App bootstrap={bootstrap} onQuit={shutdown} />);

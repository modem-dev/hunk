#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { parseCli } from "./core/cli";
import { loadAppBootstrap } from "./core/loaders";
import { App } from "./ui/App";

const cliInput = await parseCli(process.argv);
const bootstrap = await loadAppBootstrap(cliInput);

const renderer = await createCliRenderer({
  useMouse: true,
  useAlternateScreen: true,
  exitOnCtrlC: true,
  openConsoleOnError: true,
});

createRoot(renderer).render(<App bootstrap={bootstrap} />);

#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { pagePlainText } from "./core/pager";
import { shutdownSession } from "./core/shutdown";
import { prepareStartupPlan } from "./core/startup";
import { App } from "./ui/App";
import { HunkHostClient } from "./mcp/client";
import { serveHunkMcpServer } from "./mcp/server";
import { createInitialSessionSnapshot, createSessionRegistration } from "./mcp/sessionRegistration";
import { runSessionCommand } from "./session/commands";

const startupPlan = await prepareStartupPlan();

if (startupPlan.kind === "help") {
  process.stdout.write(startupPlan.text);
  process.exit(0);
}

if (startupPlan.kind === "mcp-serve") {
  serveHunkMcpServer();
  await new Promise<never>(() => {});
}

if (startupPlan.kind === "session-command") {
  process.stdout.write(await runSessionCommand(startupPlan.input));
  process.exit(0);
}

if (startupPlan.kind === "plain-text-pager") {
  await pagePlainText(startupPlan.text);
  process.exit(0);
}

if (startupPlan.kind !== "app") {
  throw new Error("Unreachable startup plan.");
}

const { bootstrap, cliInput, controllingTerminal } = startupPlan;
const hostClient = new HunkHostClient(
  createSessionRegistration(bootstrap),
  createInitialSessionSnapshot(bootstrap),
);
hostClient.start();

const renderer = await createCliRenderer({
  stdin: controllingTerminal?.stdin,
  stdout: controllingTerminal?.stdout,
  useMouse: !cliInput.options.pager,
  useAlternateScreen: true,
  exitOnCtrlC: true,
  openConsoleOnError: true,
  onDestroy: () => controllingTerminal?.close(),
});

const root = createRoot(renderer);
let shuttingDown = false;

/** Tear down the renderer before exit so the primary terminal screen comes back cleanly. */
function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  hostClient.stop();
  shutdownSession({ root, renderer });
}

// The app owns the full alternate screen session from this point on.
root.render(<App bootstrap={bootstrap} hostClient={hostClient} onQuit={shutdown} />);

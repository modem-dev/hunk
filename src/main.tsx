#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { parseCli } from "./core/cli";
import { resolveConfiguredCliInput } from "./core/config";
import { loadAppBootstrap } from "./core/loaders";
import { looksLikePatchInput, pagePlainText } from "./core/pager";
import { shutdownSession } from "./core/shutdown";
import { openControllingTerminal, resolveRuntimeCliInput, usesPipedPatchInput } from "./core/terminal";
import { App } from "./ui/App";
import { HunkHostClient } from "./mcp/client";
import { serveHunkMcpServer } from "./mcp/server";
import { createInitialSessionSnapshot, createSessionRegistration } from "./mcp/sessionRegistration";

let parsedCliInput = await parseCli(process.argv);

if (parsedCliInput.kind === "help") {
  process.stdout.write(parsedCliInput.text);
  process.exit(0);
}

if (parsedCliInput.kind === "mcp-serve") {
  serveHunkMcpServer();
  await new Promise<never>(() => {});
}

if (parsedCliInput.kind === "mcp-serve") {
  throw new Error("Unreachable MCP daemon branch.");
}

if (parsedCliInput.kind === "pager") {
  const stdinText = await new Response(Bun.stdin.stream()).text();

  if (!looksLikePatchInput(stdinText)) {
    await pagePlainText(stdinText);
    process.exit(0);
  }

  parsedCliInput = {
    kind: "patch",
    file: "-",
    text: stdinText,
    options: {
      ...parsedCliInput.options,
      pager: true,
    },
  };
}

const runtimeCliInput = resolveRuntimeCliInput(parsedCliInput);
const configured = resolveConfiguredCliInput(runtimeCliInput);
const cliInput = configured.input;
const bootstrap = await loadAppBootstrap(cliInput);
const controllingTerminal = usesPipedPatchInput(cliInput) ? openControllingTerminal() : null;
const hostClient = new HunkHostClient(createSessionRegistration(bootstrap), createInitialSessionSnapshot(bootstrap));
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
root.render(
  <App
    bootstrap={bootstrap}
    hostClient={hostClient}
    onQuit={shutdown}
  />,
);

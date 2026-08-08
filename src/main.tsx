#!/usr/bin/env bun

import { formatCliError } from "./core/errors";
import { pagePlainText } from "./core/pager";
import { prepareStartupPlan } from "./app/startup";
import { sanitizeTerminalText } from "./lib/terminalText";
import { serveSessionBrokerDaemon } from "./session/broker/brokerServer";
import { runSessionCommand } from "./session/agent/commands";
import { sweepStaleTmpArtifacts } from "./core/tmpArtifactSweep";

async function main() {
  // Start the best-effort sweep of stale Bun-extracted tmp artifacts up front so
  // even the shortest-lived commands can await it right before exiting.
  const sweep = sweepStaleTmpArtifacts();

  /** Await the best-effort tmp sweep before exiting, since process.exit drops pending work. */
  async function exitAfterSweep(code: number): Promise<never> {
    await sweep;
    process.exit(code);
  }

  const startupPlan = await prepareStartupPlan();

  if (startupPlan.kind === "help") {
    process.stdout.write(startupPlan.text);
    await exitAfterSweep(0);
  }

  if (startupPlan.kind === "daemon-serve") {
    const server = serveSessionBrokerDaemon();
    await server.stopped;
    return;
  }

  if (startupPlan.kind === "session-command") {
    process.stdout.write(await runSessionCommand(startupPlan.input));
    await exitAfterSweep(0);
  }

  if (startupPlan.kind === "markup-guide") {
    const { runMarkupGuideCommand } = await import("./ui/lib/stml/cli");
    await exitAfterSweep(runMarkupGuideCommand({ stdout: (text) => process.stdout.write(text) }));
  }

  if (startupPlan.kind === "markup-render") {
    const { runMarkupRenderCommand } = await import("./ui/lib/stml/cli");
    await exitAfterSweep(
      await runMarkupRenderCommand(startupPlan.input, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        readStdinText: () => new Response(Bun.stdin.stream()).text(),
      }),
    );
  }

  if (startupPlan.kind === "plain-text-pager") {
    await pagePlainText(startupPlan.text);
    await exitAfterSweep(0);
  }

  if (startupPlan.kind === "passthrough") {
    process.stdout.write(sanitizeTerminalText(startupPlan.text));
    await exitAfterSweep(0);
  }

  if (startupPlan.kind === "static-diff-pager") {
    const { renderStaticDiffPager } = await import("./ui/staticDiffPager");
    process.stdout.write(
      await renderStaticDiffPager(startupPlan.text, startupPlan.options, {
        customThemes: startupPlan.customThemes,
        stderr: process.stderr,
      }),
    );
    await exitAfterSweep(0);
  }

  if (startupPlan.kind !== "app") {
    throw new Error("Unreachable startup plan.");
  }

  // OpenTUI stays behind the interactive plan so headless commands never
  // materialize its embedded native library.
  const { runInteractiveApp } = await import("./ui/runInteractiveApp");
  await runInteractiveApp(startupPlan);
}

await main().catch((error) => {
  process.stderr.write(formatCliError(error));
  process.exit(1);
});

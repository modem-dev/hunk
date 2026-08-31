#!/usr/bin/env bun

import { formatCliError } from "./core/run/errors";
import { pagePlainText } from "./core/process/pager";
import { prepareStartupPlan } from "./app/startup";
import { sanitizeTerminalText } from "./lib/terminalText";
import { serveSessionBrokerDaemon } from "./session/broker/brokerServer";
import { runSessionCommand } from "./session/agent/commands";

async function main() {
  const startupPlan = await prepareStartupPlan();

  if (startupPlan.kind === "help") {
    process.stdout.write(startupPlan.text);
    process.exit(0);
  }

  if (startupPlan.kind === "extension-cli-exit") {
    process.exitCode = startupPlan.exitCode;
    return;
  }

  if (startupPlan.kind === "daemon-serve") {
    const server = await serveSessionBrokerDaemon();
    await server.stopped;
    return;
  }

  if (startupPlan.kind === "session-command") {
    process.stdout.write(await runSessionCommand(startupPlan.input));
    process.exit(0);
  }

  if (startupPlan.kind === "extension-manage") {
    const [{ runExtensionManageCommand }, readline] = await Promise.all([
      import("./extensions/manage/cli"),
      import("node:readline/promises"),
    ]);
    // A confirmation needs a real terminal on both sides; piped runs use --yes.
    const canConfirm = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    process.exit(
      await runExtensionManageCommand(startupPlan.input, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        confirm: canConfirm
          ? async (question) => {
              const prompt = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              try {
                const answer = await prompt.question(question);
                return ["y", "yes"].includes(answer.trim().toLowerCase());
              } finally {
                prompt.close();
              }
            }
          : undefined,
      }),
    );
  }

  if (startupPlan.kind === "self-update") {
    const { runSelfUpdateCommand } = await import("./core/install/selfUpdate");
    process.exit(
      await runSelfUpdateCommand(startupPlan.input, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      }),
    );
  }

  if (startupPlan.kind === "markup-guide") {
    const { runMarkupGuideCommand } = await import("./ui/lib/stml/cli");
    process.exit(runMarkupGuideCommand({ stdout: (text) => process.stdout.write(text) }));
  }

  if (startupPlan.kind === "markup-render") {
    const { runMarkupRenderCommand } = await import("./ui/lib/stml/cli");
    process.exit(
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
    process.exit(0);
  }

  if (startupPlan.kind === "passthrough") {
    process.stdout.write(
      sanitizeTerminalText(startupPlan.text, { preserveAnsiStyle: startupPlan.preserveColor }),
    );
    process.exit(0);
  }

  if (startupPlan.kind === "static-diff-pager") {
    const { renderStaticDiffPager } = await import("./ui/staticDiffPager");
    process.stdout.write(
      await renderStaticDiffPager(startupPlan.text, startupPlan.options, {
        customThemes: startupPlan.customThemes,
        stderr: process.stderr,
      }),
    );
    process.exit(0);
  }

  if (startupPlan.kind !== "app") {
    throw new Error("Unreachable startup plan.");
  }

  // OpenTUI stays behind the interactive plan so headless commands never materialize its embedded
  // native library. The highlighting client starts the compiled worker only when an opted-in,
  // eligible diff needs it, so normal sessions do not pay its startup cost. The interactive
  // app owns that worker's disposal: this call returns once the app is mounted, not once it exits.
  try {
    const { runInteractiveApp } = await import("./ui/runInteractiveApp");
    await runInteractiveApp(startupPlan);
  } catch (error) {
    startupPlan.controllingTerminal?.close();
    await (
      await import("./extensions/events")
    ).retireExtensionLoadResult(startupPlan.bootstrap.extensions);
    throw error;
  }
}

await main().catch((error) => {
  process.stderr.write(formatCliError(error));
  process.exit(1);
});

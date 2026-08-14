#!/usr/bin/env bun

import { formatCliError } from "./core/errors";
import { pagePlainText } from "./core/pager";
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

  if (startupPlan.kind === "daemon-serve") {
    const server = serveSessionBrokerDaemon();
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

  if (startupPlan.kind === "color-only") {
    const { renderColorOnlyDiff } = await import("./ui/colorOnlyFilter");
    process.stdout.write(
      await renderColorOnlyDiff(startupPlan.text, startupPlan.options, {
        customThemes: startupPlan.customThemes,
        stderr: process.stderr,
      }),
    );
    process.exit(0);
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

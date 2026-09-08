#!/usr/bin/env bun

import { formatCliError } from "./core/run/errors";
import { pagePlainText } from "./core/process/pager";
import { writeStdout } from "./core/process/stdout";
import { prepareStartupPlan } from "./app/startup";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./lib/terminalText";
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
    writeStdout(startupPlan.text);
    await exitAfterSweep(0);
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
    writeStdout(await runSessionCommand(startupPlan.input));
    await exitAfterSweep(0);
  }

  if (startupPlan.kind === "extension-manage") {
    const [{ runExtensionManageCommand }, readline] = await Promise.all([
      import("./extensions/manage/cli"),
      import("node:readline/promises"),
    ]);
    // A confirmation needs a real terminal on both sides; piped runs use --yes.
    const canConfirm = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    await exitAfterSweep(
      await runExtensionManageCommand(startupPlan.input, {
        stdout: (text) => writeStdout(text),
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
    await exitAfterSweep(
      await runSelfUpdateCommand(startupPlan.input, {
        stdout: (text) => writeStdout(text),
        stderr: (text) => process.stderr.write(text),
      }),
    );
  }

  if (startupPlan.kind === "markup-guide") {
    const { runMarkupGuideCommand } = await import("./ui/lib/stml/cli");
    await exitAfterSweep(runMarkupGuideCommand({ stdout: (text) => writeStdout(text) }));
  }

  if (startupPlan.kind === "markup-render") {
    const { runMarkupRenderCommand } = await import("./ui/lib/stml/cli");
    await exitAfterSweep(
      await runMarkupRenderCommand(startupPlan.input, {
        stdout: (text) => writeStdout(text),
        stderr: (text) => process.stderr.write(text),
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        readStdinText: () => new Response(Bun.stdin.stream()).text(),
      }),
    );
  }

  if (startupPlan.kind === "history-static") {
    const { runStaticHistory } = await import("./ui/history/runStaticHistory");
    await runStaticHistory(startupPlan.bootstrap);
    return;
  }

  if (startupPlan.kind === "history-interactive") {
    const { runInteractiveHistory } = await import("./ui/history/runInteractiveHistory");
    await runInteractiveHistory(startupPlan.bootstrap);
    return;
  }

  if (startupPlan.kind === "plain-text-pager") {
    await pagePlainText(startupPlan.text);
    await exitAfterSweep(0);
  }

  if (startupPlan.kind === "passthrough") {
    writeStdout(
      sanitizeTerminalText(startupPlan.text, { preserveAnsiStyle: startupPlan.preserveColor }),
    );
    await exitAfterSweep(0);
  }

  if (startupPlan.kind === "static-diff-pager") {
    const { renderStaticDiffPager } = await import("./ui/staticDiffPager");
    writeStdout(
      await renderStaticDiffPager(startupPlan.text, startupPlan.options, {
        customThemes: startupPlan.customThemes,
        stderr: process.stderr,
      }),
    );
    await exitAfterSweep(0);
  }

  if (startupPlan.kind === "static-diff") {
    const [{ renderStaticDiff }, { retireExtensionLoadResult }] = await Promise.all([
      import("./ui/staticDiffPager"),
      import("./extensions/events"),
    ]);
    try {
      for (const notice of startupPlan.bootstrap.startupNotices ?? []) {
        process.stderr.write(`hunk: warning: ${sanitizeTerminalLine(notice.message)}\n`);
      }
      writeStdout(
        await renderStaticDiff(
          startupPlan.bootstrap.changeset,
          startupPlan.bootstrap.input.options,
          {
            customThemes: startupPlan.bootstrap.customThemes,
            color: false,
            preserveFullLines: true,
          },
        ),
      );
    } finally {
      await retireExtensionLoadResult(startupPlan.bootstrap.extensions);
    }
    process.exit(0);
  }

  if (startupPlan.kind !== "app") {
    throw new Error("Unreachable startup plan.");
  }

  // OpenTUI stays behind the interactive plan so headless commands never materialize its embedded
  // native library. The shared interactive runner owns the highlighting worker and terminal until
  // the mounted surface acknowledges graceful shutdown.
  const { runInteractiveApp } = await import("./ui/runInteractiveApp");
  await runInteractiveApp(startupPlan);
}

await main().catch((error) => {
  process.stderr.write(formatCliError(error));
  process.exitCode = 1;
});

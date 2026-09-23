#!/usr/bin/env bun

import { formatCliError } from "./core/run/errors";
import { pagePlainText } from "./core/process/pager";
import { writeStdout } from "./core/process/stdout";
import { prepareStartupPlan } from "./app/startup";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./lib/terminalText";
import { serveSessionBrokerDaemon } from "./session/broker/brokerServer";
import { runSessionCommand } from "./session/agent/commands";
import { DaemonBuildMismatchError } from "./session/agent/errors";
import { stringifyJson } from "./session/agent/cliClient";

/**
 * Build a yes/no prompt for commands that must confirm destructive work. A confirmation needs a
 * real terminal on both sides; piped runs pass `--yes` instead and get no prompt function.
 */
async function createTerminalConfirm() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const readline = await import("node:readline/promises");
  return async (question: string) => {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await prompt.question(question);
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    } finally {
      prompt.close();
    }
  };
}

async function main() {
  const startupPlan = await prepareStartupPlan();

  if (startupPlan.kind === "help") {
    writeStdout(startupPlan.text);
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

  if (startupPlan.kind === "daemon-control") {
    const { runDaemonControlCommand } = await import("./session/agent/daemonCommands");
    process.exit(
      await runDaemonControlCommand(startupPlan.input, {
        stdout: (text) => writeStdout(text),
        stderr: (text) => process.stderr.write(text),
        confirm: await createTerminalConfirm(),
      }),
    );
  }

  if (startupPlan.kind === "session-command") {
    try {
      writeStdout(await runSessionCommand(startupPlan.input));
    } catch (error) {
      // Agents parse `--json` output; a build mismatch is a decision point for them, so it is
      // returned in-band as a structured error rather than only as text on stderr.
      if (startupPlan.input.output === "json" && error instanceof DaemonBuildMismatchError) {
        writeStdout(stringifyJson({ error }));
        process.exit(1);
      }
      throw error;
    }
    process.exit(0);
  }

  if (startupPlan.kind === "extension-manage") {
    const { runExtensionManageCommand } = await import("./extensions/manage/cli");
    process.exit(
      await runExtensionManageCommand(startupPlan.input, {
        stdout: (text) => writeStdout(text),
        stderr: (text) => process.stderr.write(text),
        confirm: await createTerminalConfirm(),
      }),
    );
  }

  if (startupPlan.kind === "self-update") {
    const { runSelfUpdateCommand } = await import("./core/install/selfUpdate");
    process.exit(
      await runSelfUpdateCommand(startupPlan.input, {
        stdout: (text) => writeStdout(text),
        stderr: (text) => process.stderr.write(text),
      }),
    );
  }

  if (startupPlan.kind === "markup-guide") {
    const { runMarkupGuideCommand } = await import("./ui/lib/stml/cli");
    process.exit(runMarkupGuideCommand({ stdout: (text) => writeStdout(text) }));
  }

  if (startupPlan.kind === "markup-render") {
    const { runMarkupRenderCommand } = await import("./ui/lib/stml/cli");
    process.exit(
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
    process.exit(0);
  }

  if (startupPlan.kind === "passthrough") {
    writeStdout(
      sanitizeTerminalText(startupPlan.text, { preserveAnsiStyle: startupPlan.preserveColor }),
    );
    process.exit(0);
  }

  if (startupPlan.kind === "static-diff-pager") {
    const { renderStaticDiffPager } = await import("./ui/staticDiffPager");
    writeStdout(
      await renderStaticDiffPager(startupPlan.text, startupPlan.options, {
        customThemes: startupPlan.customThemes,
        stderr: process.stderr,
      }),
    );
    process.exit(0);
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

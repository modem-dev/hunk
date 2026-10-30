import type { StatusCommandInput } from "../../core/run/commandInputs";
import type { InteractiveSessionInitialization } from "../../core/session/initialization";
import type { ExtensionVcsStatusSnapshot } from "../../extension-api/types";
import { pagePlainText } from "../../core/process/pager";
import { writeStdout } from "../../core/process/stdout";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { resolveTheme } from "../themes";
import { resolveHistoryColor } from "../history/staticProjection";
import { projectStaticStatus } from "./staticProjection";

/** Describe only the snapshot, launch theme and cleanup operations static output consumes. */
export interface StaticStatusRuntime {
  input: StatusCommandInput;
  initialization: InteractiveSessionInitialization;
  snapshot: ExtensionVcsStatusSnapshot;
  notices: readonly string[];
  loadSiblings(snapshot: ExtensionVcsStatusSnapshot): Promise<ExtensionVcsStatusSnapshot>;
  close(): Promise<void>;
  extensionSession: { shutdown(): Promise<void> };
}

/** Print one complete bounded snapshot, using ordinary paging and retiring all owned resources. */
export async function runStaticStatus(
  bootstrap: StaticStatusRuntime,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    write = writeStdout,
    pageText = pagePlainText,
  }: {
    stdout?: Pick<NodeJS.WriteStream, "isTTY" | "rows">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    env?: NodeJS.ProcessEnv;
    write?: (text: string) => void;
    pageText?: typeof pagePlainText;
  } = {},
) {
  try {
    for (const notice of bootstrap.notices)
      stderr.write(`hunk: warning: ${sanitizeTerminalLine(notice)}\n`);
    const snapshot = await bootstrap.loadSiblings(bootstrap.snapshot);
    if (bootstrap.input.json) {
      write(`${JSON.stringify(snapshot, null, 2)}\n`);
      return;
    }
    const theme = resolveTheme(
      bootstrap.initialization.theme.initialTheme,
      bootstrap.initialization.theme.initialThemeMode ?? null,
      bootstrap.initialization.theme.customThemes,
    );
    const text = projectStaticStatus(snapshot, {
      theme,
      color: resolveHistoryColor({
        mode: bootstrap.input.color,
        stdoutIsTTY: Boolean(stdout.isTTY),
        env,
      }),
    });
    if (stdout.isTTY && text.split("\n").length - 1 > Math.max(1, (stdout.rows || 24) - 1))
      await pageText(text, env);
    else write(text);
  } finally {
    try {
      await bootstrap.close();
    } finally {
      await bootstrap.extensionSession.shutdown();
    }
  }
}

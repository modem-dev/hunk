import { createHistoryLaneCheckpoint, planHistoryPage } from "../../core/history/lanePlanner";
import {
  openPlainTextPager,
  pagePlainText,
  type PlainTextPagerWriter,
} from "../../core/process/pager";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import {
  projectHistoryConvergence,
  projectHistoryRecord,
  projectHistoryRow,
  resolveHistoryColor,
  resolveHistoryTheme,
} from "./staticProjection";
import type { HistoryRuntime } from "./types";

export interface StaticHistoryDeps {
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "columns" | "rows" | "write"> &
    Partial<Pick<NodeJS.WriteStream, "once" | "on" | "off">>;
  stderr: Pick<NodeJS.WriteStream, "write">;
  env: NodeJS.ProcessEnv;
  pageText: (text: string, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Production opens a streaming pager; tests may omit it to exercise the legacy seam. */
  openPager?: (env: NodeJS.ProcessEnv) => PlainTextPagerWriter;
}

/** Consume history incrementally and print safe normal-screen records. */
export async function runStaticHistory(
  bootstrap: HistoryRuntime,
  deps: StaticHistoryDeps = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    pageText: pagePlainText,
    openPager: (env) => openPlainTextPager(env),
  },
) {
  const { input } = bootstrap;
  for (const notice of bootstrap.notices) {
    deps.stderr.write(`hunk: warning: ${sanitizeTerminalLine(notice)}\n`);
  }

  let outputClosed = false;
  let outputFailure: unknown;
  let releaseDrain: (() => void) | undefined;
  const onOutputError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") outputClosed = true;
    else outputFailure = error;
    releaseDrain?.();
  };
  deps.stdout.on?.("error", onOutputError);
  const writeOutput = async (text: string) => {
    if (outputFailure) throw outputFailure;
    if (outputClosed) return false;
    const accepted = deps.stdout.write(text);
    if (!accepted && deps.stdout.once) {
      await new Promise<void>((resolve) => {
        releaseDrain = resolve;
        deps.stdout.once!("drain", resolve);
      });
      releaseDrain = undefined;
    }
    if (outputFailure) throw outputFailure;
    return !outputClosed;
  };
  const stdoutIsTTY = Boolean(deps.stdout.isTTY);
  const ascii = input.ascii || deps.env.TERM === "dumb";
  const color = resolveHistoryColor({ mode: input.color, stdoutIsTTY, env: deps.env });
  const theme = resolveHistoryTheme(input.theme, bootstrap.customThemes);
  const terminalColumns = deps.stdout.columns;
  const width = stdoutIsTTY
    ? terminalColumns && terminalColumns > 0
      ? terminalColumns
      : 80
    : undefined;
  const bufferedLines: string[] = [];
  const terminalRows = deps.stdout.rows;
  const availableRows = Math.max(1, (terminalRows && terminalRows > 0 ? terminalRows : 24) - 1);
  let pager: PlainTextPagerWriter | undefined;
  let checkpoint = createHistoryLaneCheckpoint();
  let done = false;
  let commitCount = 0;
  try {
    while (!done) {
      const page = await bootstrap.source.read({ limit: 256 });
      const planned = planHistoryPage(page.commits, checkpoint);
      checkpoint = planned.checkpoint;
      const lines = planned.rows.flatMap((row) =>
        input.format === "compact"
          ? [
              projectHistoryRow(row, { ascii, color, theme, width }),
              projectHistoryConvergence(row, { ascii, color, theme, width }),
            ].filter(Boolean)
          : projectHistoryRecord(row, { ascii, color, theme, width }),
      );
      commitCount += planned.rows.length;
      if (stdoutIsTTY) {
        if (pager) {
          if ((await pager.write(`${lines.join("\n")}\n`)) === false) return;
        } else {
          bufferedLines.push(...lines);
          if (deps.openPager && bufferedLines.length > availableRows) {
            pager = deps.openPager(deps.env);
            if ((await pager.write(`${bufferedLines.join("\n")}\n`)) === false) return;
            bufferedLines.length = 0;
          }
        }
      } else if (lines.length > 0 && !(await writeOutput(`${lines.join("\n")}\n`))) {
        return;
      }
      done = page.done;
      if (page.commits.length === 0 && !done) {
        throw new Error("VCS history returned an empty page before the end of history.");
      }
    }

    if (commitCount === 0) {
      if (stdoutIsTTY && input.maxCount !== 0) await writeOutput("No commits found.\n");
      return;
    }
    if (!stdoutIsTTY) return;
    if (pager) {
      await pager.close();
      pager = undefined;
      return;
    }

    const text = `${bufferedLines.join("\n")}\n`;
    if (bufferedLines.length > availableRows) await deps.pageText(text, deps.env);
    else await writeOutput(text);
  } finally {
    try {
      await pager?.close();
    } finally {
      deps.stdout.off?.("error", onOutputError);
      await bootstrap.close();
    }
  }
}

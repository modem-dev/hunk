import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createHistoryLaneCheckpoint, planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryGraphRow, HistoryLaneCheckpoint } from "../../core/history/types";
import { resolveCurrentHunkCommand } from "../../core/process/relaunch";
import { HunkUserError } from "../../core/run/errors";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { fitText } from "../lib/text";
import {
  background,
  foreground,
  getHistoryCommitIdBounds,
  projectHistoryRow,
  resolveHistoryColor,
  resolveHistoryTheme,
} from "./staticProjection";
import { TerminalInputReader } from "./terminalInput";
import type { ExtensionVcsHistoryReviewAction } from "../../extension-api/types";
import type { HistoryRuntime } from "./types";

const ENTER_ALT = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h";
const LEAVE_ALT = "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";

/** Convert a provider-owned review declaration into one child Hunk invocation. */
export function historyReviewArgs(action: ExtensionVcsHistoryReviewAction) {
  const payload = Buffer.from(JSON.stringify(action), "utf8").toString("base64url");
  return [action.kind === "revision-range" ? "diff" : "show", "--history-review", payload];
}

/** Run one provider-planned child Hunk review after yielding terminal ownership. */
async function openCommitReview(
  bootstrap: HistoryRuntime,
  action: ExtensionVcsHistoryReviewAction,
) {
  const current = resolveCurrentHunkCommand();
  const extensionArgs = bootstrap.input.extensionPaths.flatMap((path) => [
    "--extension",
    resolve(path),
  ]);
  const reviewArgs = historyReviewArgs(action);
  const args = [
    ...current.args,
    ...reviewArgs,
    "--vcs",
    bootstrap.providerId,
    ...(bootstrap.input.extensionsEnabled ? extensionArgs : ["--no-extensions"]),
  ];
  const child = spawn(current.command, args, {
    cwd: bootstrap.repoRoot,
    env: { ...process.env, HUNK_RETURN_TO_HISTORY: "1" },
    stdio: "inherit",
  });
  return await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
  });
}

/** Browse history as one minimal graph list and open immutable commits in ordinary Hunk review. */
export async function runInteractiveHistory(
  bootstrap: HistoryRuntime,
  {
    stdin = process.stdin,
    stdout = process.stdout,
  }: {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
  } = {},
) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    await bootstrap.close();
    throw new HunkUserError("`hunk log --interactive` requires a terminal.", [
      "Use plain `hunk log` for pipes and redirected output.",
    ]);
  }

  const input = new TerminalInputReader(stdin);
  const abort = new AbortController();
  const rows: HistoryGraphRow[] = [];
  let checkpoint: HistoryLaneCheckpoint = createHistoryLaneCheckpoint();
  let historyDone = false;
  let selected = 0;
  let top = 0;
  let search = "";
  let notice = bootstrap.notices[0] ? sanitizeTerminalLine(bootstrap.notices[0]) : "";
  let lastClick = { index: -1, at: 0 };
  let active = false;
  let stopped = false;
  let loading = false;
  const theme = resolveHistoryTheme(bootstrap.input.theme, bootstrap.customThemes);

  /** Read one page while letting quit interrupt an exhaustive traversal. */
  const readInterruptibly = async () => {
    const pending = bootstrap.source.read({ limit: 256, signal: abort.signal });
    const settled = pending.then(
      (page) => ({ kind: "page" as const, page }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const deferredKeys: string[] = [];
    for (;;) {
      const keyWait = new AbortController();
      // Put input first so a queued `q` wins when a fast provider page and
      // coalesced `Gq` input are both already ready.
      const result = await Promise.race([
        input.next(keyWait.signal).then((key) => ({ kind: "key" as const, key })),
        settled,
      ]);
      if (result.kind === "page") {
        keyWait.abort();
        input.prepend(deferredKeys);
        return result.page;
      }
      if (result.kind === "error") {
        keyWait.abort();
        input.prepend(deferredKeys);
        throw result.error;
      }
      if (result.key === "q" || result.key === "\x03") {
        cleanup();
        await settled;
        return undefined;
      }
      deferredKeys.push(result.key);
    }
  };

  /** Fetch one bounded continuation page and preserve graph state across it. */
  const loadMore = async (interruptible = false) => {
    if (historyDone || loading || stopped) return;
    loading = true;
    try {
      const page = interruptible
        ? await readInterruptibly()
        : await bootstrap.source.read({ limit: 256, signal: abort.signal });
      if (!page) return;
      if (!page.done && page.commits.length === 0)
        throw new Error("VCS history returned an empty page before EOF.");
      const planned = planHistoryPage(page.commits, checkpoint);
      rows.push(...planned.rows);
      checkpoint = planned.checkpoint;
      historyDone = page.done;
      if (rows.length === 0 && historyDone) notice = "No commits found.";
    } finally {
      loading = false;
    }
  };
  const loadAll = async () => {
    while (!historyDone && !stopped) await loadMore(true);
  };

  const terminalWidth = () => (stdout.columns && stdout.columns > 0 ? stdout.columns : 80);
  const terminalHeight = () => (stdout.rows && stdout.rows > 0 ? stdout.rows : 24);
  const enterTerminal = () => {
    stdin.setRawMode?.(true);
    input.resume();
    stdout.write(ENTER_ALT);
    active = true;
  };
  const leaveTerminal = () => {
    if (!active) return;
    active = false;
    input.pause();
    stdout.write(LEAVE_ALT);
    stdin.setRawMode?.(false);
  };
  const clampViewport = () => {
    selected = Math.max(0, Math.min(Math.max(0, rows.length - 1), selected));
    const height = Math.max(1, terminalHeight() - 1);
    if (selected < top) top = selected;
    if (selected >= top + height) top = selected - height + 1;
    top = Math.max(0, Math.min(top, Math.max(0, rows.length - height)));
  };
  const render = () => {
    if (!active) return;
    clampViewport();
    const width = Math.max(1, terminalWidth());
    const height = Math.max(1, terminalHeight() - 1);
    const visible = rows.slice(top, top + height);
    const color = resolveHistoryColor({
      mode: bootstrap.input.color,
      stdoutIsTTY: true,
      env: process.env,
    });
    const lines = visible.map((row, offset) => {
      const isSelected = top + offset === selected;
      const text = projectHistoryRow(row, {
        ascii: bootstrap.input.ascii || process.env.TERM === "dumb",
        color: color && !isSelected,
        theme,
        width,
      });
      return isSelected && color
        ? `${background(theme.selectedHunk)}${foreground(theme.text)}${text}\x1b[0m`
        : isSelected
          ? `\x1b[7m${text}\x1b[0m`
          : text;
    });
    while (lines.length < height) lines.push("");
    const footer = search
      ? `/${search}`
      : notice ||
        `↑↓/jk move  / search  n/N match  y copy  enter open  q quit${historyDone ? "" : "  ↓ load more"}`;
    const footerText = fitText(footer, width, "…");
    const styledFooter = color
      ? `${background(theme.panelAlt)}${foreground(theme.muted)}${footerText}\x1b[0m`
      : `\x1b[7m${footerText}\x1b[0m`;
    stdout.write(`\x1b[H\x1b[2J${lines.join("\n")}\n${styledFooter}`);
  };
  const findMatch = async (direction: 1 | -1) => {
    if (!search || rows.length === 0) return;
    await loadAll();
    const needle = search.toLocaleLowerCase();
    for (let step = 1; step <= rows.length; step += 1) {
      const index = (selected + direction * step + rows.length) % rows.length;
      const commit = rows[index]!.commit;
      const haystack = [
        commit.revisionId,
        commit.displayId,
        commit.subject,
        commit.body ?? "",
        commit.authorName,
        commit.authorEmail ?? "",
        ...commit.decorations.map((entry) => entry.label),
      ]
        .join(" ")
        .toLocaleLowerCase();
      if (haystack.includes(needle)) {
        selected = index;
        notice = "";
        return;
      }
    }
    notice = `No match for ${sanitizeTerminalLine(search)}`;
  };
  const editSearch = async () => {
    let draft = search;
    for (;;) {
      search = draft;
      render();
      const key = await input.next();
      if (key === "\r" || key === "\n") {
        search = draft;
        await findMatch(1);
        return;
      }
      if (key === "\x1b") return;
      if (key === "\x03") {
        cleanup();
        return;
      }
      if (key === "\x7f") draft = Array.from(draft).slice(0, -1).join("");
      else if (/^[^\x00-\x1f\x7f]+$/u.test(key)) draft += key;
    }
  };
  /** Open one provider-planned review while yielding terminal ownership. */
  const openRowReview = async (row: HistoryGraphRow) => {
    const reviewAction = await bootstrap.planReview(row.commit);
    input.discardPending();
    leaveTerminal();
    const code = await openCommitReview(bootstrap, reviewAction);
    if (!stopped) enterTerminal();
    notice = code === 0 ? "" : `Could not open ${row.commit.displayId}`;
  };
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    abort.abort(new Error("History browser stopped."));
    leaveTerminal();
  };
  const onResize = () => {
    if (active) render();
  };
  const stopForSignal = (exitCode: number) => {
    cleanup();
    process.exitCode = exitCode;
    input.close();
  };
  const onInterrupt = () => stopForSignal(130);
  const onHangup = () => stopForSignal(129);
  const onTerminate = () => stopForSignal(143);

  process.once("SIGINT", onInterrupt);
  process.once("SIGHUP", onHangup);
  process.once("SIGTERM", onTerminate);
  stdout.on("resize", onResize);
  try {
    await loadMore();
    if (stopped) return;
    enterTerminal();
    render();
    while (!stopped) {
      const key = await input.next();
      const height = Math.max(1, terminalHeight() - 1);
      if (key === "q" || key === "\x03") break;
      if (key === "\x1b[B" || key === "j") {
        if (selected + 1 >= rows.length && !historyDone) await loadMore();
        selected += 1;
      } else if (key === "\x1b[A" || key === "k") selected -= 1;
      else if (key === "\x1b[6~") {
        while (selected + height >= rows.length && !historyDone) await loadMore();
        selected += height;
      } else if (key === "\x1b[5~") selected -= height;
      else if (["\x1b[H", "\x1b[1~", "\x1bOH", "g"].includes(key)) selected = 0;
      else if (["\x1b[F", "\x1b[4~", "\x1bOF", "G"].includes(key)) {
        await loadAll();
        selected = rows.length - 1;
      } else if (key === "/") await editSearch();
      else if (key === "n") await findMatch(1);
      else if (key === "N") await findMatch(-1);
      else if (key === "y" && rows[selected]) {
        stdout.write(
          `\x1b]52;c;${Buffer.from(rows[selected]!.commit.revisionId).toString("base64")}\x07`,
        );
        notice = `Copied ${rows[selected]!.commit.displayId}`;
      } else if ((key === "\r" || key === "\n") && rows[selected]) {
        await openRowReview(rows[selected]!);
        if (stopped) break;
      } else {
        const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
        if (mouse) {
          const button = Number(mouse[1]);
          const screenColumn = Number(mouse[2]) - 1;
          const screenRow = Number(mouse[3]) - 1;
          const visibleCount = Math.min(height, rows.length - top);
          if (button === 64) selected -= 3;
          else if (button === 65) {
            if (selected + 3 >= rows.length && !historyDone) await loadMore();
            selected += 3;
          } else if (
            button === 0 &&
            mouse[4] === "M" &&
            screenRow >= 0 &&
            screenRow < visibleCount
          ) {
            const index = top + screenRow;
            const row = rows[index]!;
            selected = index;
            const idBounds = getHistoryCommitIdBounds(
              row,
              bootstrap.input.ascii || process.env.TERM === "dumb",
            );
            const clickedCommitId = screenColumn >= idBounds.start && screenColumn < idBounds.end;
            const now = Date.now();
            if (clickedCommitId || (lastClick.index === index && now - lastClick.at < 400)) {
              await openRowReview(row);
            }
            lastClick = { index, at: now };
          }
        }
      }
      render();
    }
  } catch (error) {
    if (!stopped) throw error;
  } finally {
    cleanup();
    input.close();
    stdout.off("resize", onResize);
    process.off("SIGINT", onInterrupt);
    process.off("SIGHUP", onHangup);
    process.off("SIGTERM", onTerminate);
    await bootstrap.close();
  }
}

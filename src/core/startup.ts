import { resolveConfiguredCliInput } from "./config";
import { HunkUserError } from "./errors";
import { loadAppBootstrap } from "./loaders";
import { createChangesetStream } from "./streaming/changesetStream";
import { chainLines, drainLines, looksLikeCommitLog, sniffPatch } from "./streaming/patchSniffer";
import { stdinLines, type LineSource } from "./streaming/stdinLines";
import {
  openControllingTerminal,
  resolveRuntimeCliInput,
  usesPipedPatchInput,
  type ControllingTerminal,
} from "./terminal";
import type { AppBootstrap, CliInput, ParsedCliInput, SessionCommandInput } from "./types";
import { canReloadInput } from "./watch";
import { parseCli } from "./cli";

export type StartupPlan =
  | {
      kind: "help";
      text: string;
    }
  | {
      kind: "daemon-serve";
    }
  | {
      kind: "session-command";
      input: SessionCommandInput;
    }
  | {
      kind: "plain-text-pager";
      text: string;
    }
  | {
      kind: "app";
      bootstrap: AppBootstrap;
      cliInput: CliInput;
      controllingTerminal: ControllingTerminal | null;
    };

export interface StartupDeps {
  parseCliImpl?: (argv: string[]) => Promise<ParsedCliInput>;
  readStdinLines?: () => LineSource;
  resolveRuntimeCliInputImpl?: typeof resolveRuntimeCliInput;
  resolveConfiguredCliInputImpl?: typeof resolveConfiguredCliInput;
  loadAppBootstrapImpl?: typeof loadAppBootstrap;
  usesPipedPatchInputImpl?: typeof usesPipedPatchInput;
  openControllingTerminalImpl?: typeof openControllingTerminal;
}

/** Normalize startup work so help, pager, and app-bootstrap paths can be tested directly. */
export async function prepareStartupPlan(
  argv: string[] = process.argv,
  deps: StartupDeps = {},
): Promise<StartupPlan> {
  const parseCliImpl = deps.parseCliImpl ?? parseCli;
  const readStdinLines = deps.readStdinLines ?? (() => stdinLines());
  const resolveRuntimeCliInputImpl = deps.resolveRuntimeCliInputImpl ?? resolveRuntimeCliInput;
  const resolveConfiguredCliInputImpl =
    deps.resolveConfiguredCliInputImpl ?? resolveConfiguredCliInput;
  const loadAppBootstrapImpl = deps.loadAppBootstrapImpl ?? loadAppBootstrap;
  const usesPipedPatchInputImpl = deps.usesPipedPatchInputImpl ?? usesPipedPatchInput;
  const openControllingTerminalImpl = deps.openControllingTerminalImpl ?? openControllingTerminal;

  let parsedCliInput = await parseCliImpl(argv);

  if (parsedCliInput.kind === "help") {
    return {
      kind: "help",
      text: parsedCliInput.text,
    };
  }

  if (parsedCliInput.kind === "daemon-serve") {
    return {
      kind: "daemon-serve",
    };
  }

  if (parsedCliInput.kind === "session") {
    return {
      kind: "session-command",
      input: parsedCliInput,
    };
  }

  if (parsedCliInput.kind === "pager") {
    const lines = readStdinLines();
    const sniff = await sniffPatch(lines);

    if (sniff.kind === "plain") {
      return {
        kind: "plain-text-pager",
        text: await drainLines(sniff.prefixLines, sniff.rest),
      };
    }

    // Resolve the review-vs-no-review decision. Explicit flags win; otherwise auto-detect
    // log-style input (presence of `commit <sha>` headers in the sniff prefix). Streaming
    // is only used in no-review mode — review mode keeps the legacy buffered path so the
    // daemon registration and agent surface stay consistent with what they always were.
    const explicitNoReview = parsedCliInput.options.noReview === true;
    const explicitReview = parsedCliInput.options.noReview === false;
    const autoDetected = !explicitReview && looksLikeCommitLog(sniff.prefixLines);
    const noReview = explicitNoReview || autoDetected;

    // Kill switch: HUNK_PAGER_STREAM=0 forces the legacy buffered path even in no-review
    // mode. Useful as an escape hatch if the streaming path turns out wrong for someone.
    const streamingEnabled = noReview && process.env.HUNK_PAGER_STREAM !== "0";

    if (!streamingEnabled) {
      const stdinText = await drainLines(sniff.prefixLines, sniff.rest);
      parsedCliInput = {
        kind: "patch",
        file: "-",
        text: stdinText,
        options: {
          ...parsedCliInput.options,
          pager: true,
          noReview: noReview ? true : undefined,
        },
      };
    } else {
      // Streaming + no-review path: build a CliInput for option resolution, then attach a
      // live ChangesetStream to the bootstrap. The initial changeset starts empty; AppHost
      // appends files as the chunker emits them. Daemon registration is skipped in
      // main.tsx based on cliInput.options.noReview.
      const synthInput: CliInput = {
        kind: "patch",
        file: "-",
        // text is unused when bootstrap.stream is set — the stream is the source of truth.
        text: "",
        options: {
          ...parsedCliInput.options,
          pager: true,
          noReview: true,
        },
      };

      const runtimeCliInput = resolveRuntimeCliInputImpl(synthInput);
      const configured = resolveConfiguredCliInputImpl(runtimeCliInput);
      const cliInput = configured.input;

      if (cliInput.options.watch) {
        throw new HunkUserError("`--watch` is not supported for pager input.", [
          "Pager input is one-shot stdin and cannot be reopened. Drop `--watch` or use a file-backed source.",
        ]);
      }

      const source = chainLines(sniff.prefixLines, sniff.rest);
      const stream = createChangesetStream({
        source,
        sourceLabel: "git pager",
        title: "Pager input",
      });

      const bootstrap: AppBootstrap = {
        input: cliInput,
        changeset: stream.initialChangeset,
        initialMode: cliInput.options.mode ?? "auto",
        initialTheme: cliInput.options.theme,
        initialShowLineNumbers: cliInput.options.lineNumbers ?? true,
        initialWrapLines: cliInput.options.wrapLines ?? false,
        initialShowHunkHeaders: cliInput.options.hunkHeaders ?? true,
        initialShowAgentNotes: cliInput.options.agentNotes ?? false,
        stream,
      };

      const controllingTerminal = usesPipedPatchInputImpl(cliInput)
        ? openControllingTerminalImpl()
        : null;

      return { kind: "app", bootstrap, cliInput, controllingTerminal };
    }
  }

  const runtimeCliInput = resolveRuntimeCliInputImpl(parsedCliInput);
  const configured = resolveConfiguredCliInputImpl(runtimeCliInput);
  const cliInput = configured.input;

  if (cliInput.options.watch && !canReloadInput(cliInput)) {
    throw new HunkUserError(
      "`--watch` requires a file- or Git-backed input that Hunk can reopen.",
      [
        "Use a patch file path instead of stdin, and avoid `--agent-context -` for watched sessions.",
      ],
    );
  }

  const bootstrap = await loadAppBootstrapImpl(cliInput);
  const controllingTerminal = usesPipedPatchInputImpl(cliInput)
    ? openControllingTerminalImpl()
    : null;

  return {
    kind: "app",
    bootstrap,
    cliInput,
    controllingTerminal,
  };
}

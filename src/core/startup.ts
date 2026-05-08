import { resolveConfiguredCliInput } from "./config";
import { HunkUserError } from "./errors";
import { loadAppBootstrap } from "./loaders";
import { createChangesetStream } from "./streaming/changesetStream";
import { createCommitReviewStream } from "./streaming/commitReviewStream";
import { chainLines, drainLines, looksLikeCommitLog, sniffPatch } from "./streaming/patchSniffer";
import { stdinLines, type LineSource } from "./streaming/stdinLines";
import {
  openControllingTerminal,
  resolveRuntimeCliInput,
  usesPipedPatchInput,
  type ControllingTerminal,
} from "./terminal";
import type {
  AppBootstrap,
  Changeset,
  CliInput,
  ParsedCliInput,
  SessionCommandInput,
} from "./types";
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

/** Build the empty changeset shown while a streaming pager input is still loading. */
function emptyStreamingChangeset(): Changeset {
  return {
    id: `changeset:streaming:${Date.now()}`,
    sourceLabel: "git pager",
    title: "Awaiting first commit…",
    files: [],
    isStreaming: true,
  };
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

    // Three pager paths:
    //   1. log-style input + no explicit override → commit-review streaming (review mode,
    //      daemon connected, navigates one commit at a time).
    //   2. --no-review flag → flat-streaming, no daemon, no agent surface.
    //   3. --review flag or non-log input → legacy buffered path with full review surface.
    const explicitNoReview = parsedCliInput.options.noReview === true;
    const explicitReview = parsedCliInput.options.noReview === false;
    const isLogStyle = looksLikeCommitLog(sniff.prefixLines);
    const useCommitReview = !explicitNoReview && !explicitReview && isLogStyle;
    const useFlatStreaming = explicitNoReview;
    const noReview = useFlatStreaming;

    // Kill switch: HUNK_PAGER_STREAM=0 forces the legacy buffered path even when streaming
    // would otherwise be selected. Useful escape hatch.
    const streamingDisabled = process.env.HUNK_PAGER_STREAM === "0";

    if ((useCommitReview || useFlatStreaming) && !streamingDisabled) {
      const synthInput: CliInput = {
        kind: "patch",
        file: "-",
        // text is unused when a stream is attached — the stream is the source of truth.
        text: "",
        options: {
          ...parsedCliInput.options,
          pager: true,
          noReview: useFlatStreaming ? true : undefined,
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

      let bootstrap: AppBootstrap;
      if (useCommitReview) {
        const commitReviewStream = createCommitReviewStream({
          source,
          sourceLabel: "git log",
          title: "Awaiting first commit…",
        });
        bootstrap = {
          input: cliInput,
          changeset: emptyStreamingChangeset(),
          initialMode: cliInput.options.mode ?? "auto",
          initialTheme: cliInput.options.theme,
          initialShowLineNumbers: cliInput.options.lineNumbers ?? true,
          initialWrapLines: cliInput.options.wrapLines ?? false,
          initialShowHunkHeaders: cliInput.options.hunkHeaders ?? true,
          initialShowAgentNotes: cliInput.options.agentNotes ?? false,
          initialCommitDetailsMode: cliInput.options.commitDetailsMode ?? "full",
          commitReviewStream,
        };
      } else {
        const stream = createChangesetStream({
          source,
          sourceLabel: "git pager",
          title: "Pager input",
        });
        bootstrap = {
          input: cliInput,
          changeset: stream.initialChangeset,
          initialMode: cliInput.options.mode ?? "auto",
          initialTheme: cliInput.options.theme,
          initialShowLineNumbers: cliInput.options.lineNumbers ?? true,
          initialWrapLines: cliInput.options.wrapLines ?? false,
          initialShowHunkHeaders: cliInput.options.hunkHeaders ?? true,
          initialShowAgentNotes: cliInput.options.agentNotes ?? false,
          initialCommitDetailsMode: cliInput.options.commitDetailsMode ?? "full",
          stream,
        };
      }

      const controllingTerminal = usesPipedPatchInputImpl(cliInput)
        ? openControllingTerminalImpl()
        : null;

      return { kind: "app", bootstrap, cliInput, controllingTerminal };
    }

    // Legacy buffered path: review mode, daemon-registered, single-shot parsing.
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

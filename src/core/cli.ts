import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import type {
  CliInput,
  CommonOptions,
  HelpCommandInput,
  LayoutMode,
  PagerCommandInput,
  ParsedCliInput,
} from "./types";
import { resolveCliVersion } from "./version";

/** Validate one requested layout mode from CLI input. */
function parseLayoutMode(value: string): LayoutMode {
  if (value === "auto" || value === "split" || value === "stack") {
    return value;
  }

  throw new Error(`Invalid layout mode: ${value}`);
}

/** Parse one required positive integer CLI value. */
function parsePositiveInt(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }

  return parsed;
}

/** Read one paired positive/negative boolean flag directly from raw argv. */
function resolveBooleanFlag(argv: string[], enabledFlag: string, disabledFlag: string) {
  let resolved: boolean | undefined;

  for (const arg of argv) {
    if (arg === enabledFlag) {
      resolved = true;
      continue;
    }

    if (arg === disabledFlag) {
      resolved = false;
    }
  }

  return resolved;
}

/** Normalize the flags shared by every input mode. */
function buildCommonOptions(
  options: {
    mode?: LayoutMode;
    theme?: string;
    agentContext?: string;
    pager?: boolean;
    watch?: boolean;
  },
  argv: string[],
): CommonOptions {
  return {
    mode: options.mode,
    theme: options.theme,
    agentContext: options.agentContext,
    pager: options.pager ? true : undefined,
    watch: options.watch ? true : undefined,
    excludeUntracked: resolveBooleanFlag(argv, "--exclude-untracked", "--no-exclude-untracked"),
    lineNumbers: resolveBooleanFlag(argv, "--line-numbers", "--no-line-numbers"),
    wrapLines: resolveBooleanFlag(argv, "--wrap", "--no-wrap"),
    hunkHeaders: resolveBooleanFlag(argv, "--hunk-headers", "--no-hunk-headers"),
    agentNotes: resolveBooleanFlag(argv, "--agent-notes", "--no-agent-notes"),
  };
}

/** Attach the shared view flags to a subcommand parser. */
function applyCommonOptions(command: Command) {
  return command
    .option("--mode <mode>", "layout mode: auto, split, stack", parseLayoutMode)
    .option("--theme <theme>", "named theme override")
    .option("--agent-context <path>", "JSON sidecar with agent rationale")
    .option("--pager", "use pager-style chrome and controls")
    .option("--line-numbers", "show line numbers")
    .option("--no-line-numbers", "hide line numbers")
    .option("--wrap", "wrap long diff lines")
    .option("--no-wrap", "truncate long diff lines to one row")
    .option("--hunk-headers", "show hunk metadata rows")
    .option("--no-hunk-headers", "hide hunk metadata rows")
    .option("--agent-notes", "show agent notes by default")
    .option("--no-agent-notes", "hide agent notes by default");
}

/** Attach auto-refresh support to review commands that can reopen their source input. */
function applyWatchOption(command: Command) {
  return command.option("--watch", "auto-reload when the current diff input changes");
}

/** Render plain-text version output for `hunk --version`. */
function renderCliVersion() {
  return `${resolveCliVersion()}\n`;
}

/** Build the top-level help text shown by bare `hunk` and `hunk --help`. */
function renderCliHelp() {
  return [
    "Usage: hunk <command> [options]",
    "",
    "Desktop-inspired terminal diff viewer for agent-authored changesets.",
    "",
    "Commands:",
    "  hunk diff [ref] [-- <pathspec...>]      review working tree changes or compare against a ref",
    "  hunk diff --staged [-- <pathspec...>]   review staged changes",
    "  hunk diff <left> <right>                compare two concrete files",
    "  hunk show [ref] [-- <pathspec...>]      review the last commit or a given ref",
    "  hunk stash show [ref]                   review a stash entry",
    "  hunk patch [file]                       review a patch file or stdin",
    "  hunk pager                              general Git pager wrapper with diff detection",
    "  hunk difftool <left> <right> [path]     review Git difftool file pairs",
    "  hunk session <subcommand>               inspect or control a live Hunk session",
    "  hunk mcp serve                          run the local Hunk session daemon",
    "",
    "Global options:",
    "  -h, --help                              show help",
    "  -v, --version                           show version",
    "",
    "Common review options:",
    "  --mode <mode>                           layout mode: auto, split, stack",
    "  --watch                                 auto-reload when the current diff input changes",
    "  --agent-context <path>                  JSON sidecar with agent rationale",
    "  --pager                                 use pager-style chrome and controls",
    "  --line-numbers / --no-line-numbers      show or hide line numbers",
    "  --wrap / --no-wrap                      wrap or truncate long diff lines",
    "  --hunk-headers / --no-hunk-headers      show or hide hunk metadata rows",
    "  --agent-notes / --no-agent-notes        show or hide agent notes by default",
    "  --theme <theme>                         named theme override",
    "",
    "Git diff options:",
    "  --staged, --cached                      review staged changes",
    "  --exclude-untracked                     hide untracked files in working tree reviews",
    "",
    "Notes:",
    "  Run `hunk <command> --help` for command-specific syntax and options.",
    "",
  ].join("\n");
}

/** Split raw arguments into command tokens and optional pathspecs after `--`. */
function splitPathspecArgs(tokens: string[]) {
  const separatorIndex = tokens.indexOf("--");
  if (separatorIndex === -1) {
    return { commandTokens: tokens, pathspecs: [] as string[] };
  }

  return {
    commandTokens: tokens.slice(0, separatorIndex),
    pathspecs: tokens.slice(separatorIndex + 1),
  };
}

/** Return whether both diff operands are concrete files on disk. */
function areExistingFiles(left: string, right: string) {
  return [left, right].every((path) => existsSync(path) && statSync(path).isFile());
}

/** Parse one standalone command while letting us capture `--help` as plain text. */
async function parseStandaloneCommand(command: Command, tokens: string[]) {
  command.exitOverride();

  try {
    await command.parseAsync(["bun", "hunk", ...tokens]);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "commander.helpDisplayed"
    ) {
      return;
    }

    throw error;
  }
}

/** Build one command parser with the shared Hunk options attached. */
function createCommand(name: string, description: string) {
  return applyCommonOptions(new Command(name).description(description));
}

/** Resolve whether one nested CLI command requested JSON output. */
function resolveJsonOutput(options: { json?: boolean }) {
  return options.json ? "json" : "text";
}

/** Normalize one explicit session selector from either session id or repo root. */
function resolveExplicitSessionSelector(
  sessionId: string | undefined,
  repoRoot: string | undefined,
) {
  if (sessionId && repoRoot) {
    throw new Error("Specify either <session-id> or --repo <path>, not both.");
  }

  if (!sessionId && !repoRoot) {
    throw new Error("Specify one live Hunk session with <session-id> or --repo <path>.");
  }

  return sessionId ? { sessionId } : { repoRoot: resolve(repoRoot!) };
}

function resolveReloadSelector(
  sessionId: string | undefined,
  sessionPath: string | undefined,
  repoRoot: string | undefined,
  sourcePath: string | undefined,
) {
  if (sessionPath && repoRoot) {
    throw new Error(
      "Specify either --session-path <path> or --repo <path> as the target, not both.",
    );
  }

  if (sessionId && sessionPath) {
    throw new Error("Specify either <session-id> or --session-path <path>, not both.");
  }

  if (sessionId && repoRoot) {
    throw new Error("Specify either <session-id> or --repo <path>, not both.");
  }

  const resolvedSource = sourcePath ? resolve(sourcePath) : undefined;
  if (sessionId) {
    return {
      selector: { sessionId },
      sourcePath: resolvedSource,
    };
  }

  if (sessionPath) {
    return {
      selector: { sessionPath: resolve(sessionPath) },
      sourcePath: resolvedSource,
    };
  }

  if (repoRoot) {
    return {
      selector: { repoRoot: resolve(repoRoot) },
      sourcePath: resolvedSource,
    };
  }

  throw new Error(
    "Specify one live Hunk session with <session-id> or --repo <path> (or --session-path <path>).",
  );
}

/** Parse the overloaded `hunk diff` command. */
async function parseDiffCommand(tokens: string[], argv: string[]): Promise<ParsedCliInput> {
  const { commandTokens, pathspecs } = splitPathspecArgs(tokens);
  const command = applyWatchOption(
    createCommand("diff", "review Git diffs or compare two concrete files"),
  )
    .option("--staged", "show staged changes instead of the working tree")
    .option("--cached", "alias for --staged")
    .option("--exclude-untracked", "exclude untracked files from working tree reviews")
    .addOption(
      new Option(
        "--no-exclude-untracked",
        "include untracked files in working tree reviews",
      ).hideHelp(),
    )
    .argument("[targets...]");

  let parsedTargets: string[] = [];
  let parsedOptions: Record<string, unknown> = {};

  command.action((targets: string[], options: Record<string, unknown>) => {
    parsedTargets = targets;
    parsedOptions = options;
  });

  if (commandTokens.includes("--help") || commandTokens.includes("-h")) {
    return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
  }

  await parseStandaloneCommand(command, commandTokens);

  const staged = Boolean(parsedOptions.staged) || Boolean(parsedOptions.cached);
  const options = buildCommonOptions(parsedOptions, argv);
  const normalizedPathspecs = pathspecs.length > 0 ? pathspecs : undefined;

  if (parsedTargets.length === 0) {
    return {
      kind: "git",
      staged,
      pathspecs: normalizedPathspecs,
      options,
    };
  }

  if (parsedTargets.length === 1) {
    return {
      kind: "git",
      range: parsedTargets[0],
      staged,
      pathspecs: normalizedPathspecs,
      options,
    };
  }

  if (
    parsedTargets.length === 2 &&
    !staged &&
    !normalizedPathspecs &&
    areExistingFiles(parsedTargets[0]!, parsedTargets[1]!)
  ) {
    return {
      kind: "diff",
      left: parsedTargets[0]!,
      right: parsedTargets[1]!,
      options,
    };
  }

  throw new Error(
    "Use `hunk diff <ref>`, `hunk diff <ref1>..<ref2>`, or `hunk diff <left> <right>` for file comparison.",
  );
}

/** Parse the Git-style `hunk show` command. */
async function parseShowCommand(tokens: string[], argv: string[]): Promise<ParsedCliInput> {
  const { commandTokens, pathspecs } = splitPathspecArgs(tokens);
  const command = applyWatchOption(
    createCommand("show", "review the last commit or a given ref"),
  ).argument("[ref]");

  let parsedRef: string | undefined;
  let parsedOptions: Record<string, unknown> = {};

  command.action((ref: string | undefined, options: Record<string, unknown>) => {
    parsedRef = ref;
    parsedOptions = options;
  });

  if (commandTokens.includes("--help") || commandTokens.includes("-h")) {
    return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
  }

  await parseStandaloneCommand(command, commandTokens);

  return {
    kind: "show",
    ref: parsedRef,
    pathspecs: pathspecs.length > 0 ? pathspecs : undefined,
    options: buildCommonOptions(parsedOptions, argv),
  };
}

/** Parse the patch-file / stdin patch entrypoint. */
async function parsePatchCommand(tokens: string[], argv: string[]): Promise<ParsedCliInput> {
  const command = applyWatchOption(
    createCommand("patch", "review a patch file, or read a patch from stdin"),
  ).argument("[file]");

  let parsedFile: string | undefined;
  let parsedOptions: Record<string, unknown> = {};

  command.action((file: string | undefined, options: Record<string, unknown>) => {
    parsedFile = file;
    parsedOptions = options;
  });

  if (tokens.includes("--help") || tokens.includes("-h")) {
    return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
  }

  await parseStandaloneCommand(command, tokens);

  return {
    kind: "patch",
    file: parsedFile,
    options: buildCommonOptions(parsedOptions, argv),
  };
}

/** Parse the general pager wrapper command used from Git `core.pager`. */
async function parsePagerCommand(
  tokens: string[],
  argv: string[],
): Promise<PagerCommandInput | HelpCommandInput> {
  const command = createCommand("pager", "general Git pager wrapper with diff detection");
  let parsedOptions: Record<string, unknown> = {};

  command.action((options: Record<string, unknown>) => {
    parsedOptions = options;
  });

  if (tokens.includes("--help") || tokens.includes("-h")) {
    return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
  }

  await parseStandaloneCommand(command, tokens);

  return {
    kind: "pager",
    options: buildCommonOptions(parsedOptions, argv),
  };
}

/** Parse Git difftool-style two-file review commands. */
async function parseDifftoolCommand(tokens: string[], argv: string[]): Promise<ParsedCliInput> {
  const command = applyWatchOption(createCommand("difftool", "review Git difftool file pairs"))
    .argument("<left>")
    .argument("<right>")
    .argument("[path]");

  let parsedLeft = "";
  let parsedRight = "";
  let parsedPath: string | undefined;
  let parsedOptions: Record<string, unknown> = {};

  command.action(
    (left: string, right: string, path: string | undefined, options: Record<string, unknown>) => {
      parsedLeft = left;
      parsedRight = right;
      parsedPath = path;
      parsedOptions = options;
    },
  );

  if (tokens.includes("--help") || tokens.includes("-h")) {
    return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
  }

  await parseStandaloneCommand(command, tokens);

  return {
    kind: "difftool",
    left: parsedLeft,
    right: parsedRight,
    path: parsedPath,
    options: buildCommonOptions(parsedOptions, argv),
  };
}

function requireReloadableCliInput(input: ParsedCliInput): CliInput {
  if (input.kind === "help" || input.kind === "pager" || input.kind === "mcp-serve") {
    throw new Error(
      "Session reload requires a Hunk review command after --, such as `diff` or `show`.",
    );
  }

  if (input.kind === "session") {
    throw new Error("Session reload cannot invoke another session command.");
  }

  if (input.kind === "patch" && (!input.file || input.file === "-")) {
    throw new Error("Session reload does not support `patch -` or stdin-backed patch input.");
  }

  return input;
}

/** Parse `hunk session ...` as live-session daemon-backed commands. */
async function parseSessionCommand(tokens: string[]): Promise<ParsedCliInput> {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return {
      kind: "help",
      text:
        [
          "Usage: hunk session <subcommand> [options]",
          "",
          "Inspect and control live Hunk review sessions through the local daemon.",
          "",
          "Commands:",
          "  hunk session list",
          "  hunk session get <session-id>",
          "  hunk session get --repo <path>",
          "  hunk session context <session-id>",
          "  hunk session context --repo <path>",
          "  hunk session navigate (<session-id> | --repo <path>) --file <path> (--hunk <n> | --old-line <n> | --new-line <n>)",
          "  hunk session navigate (<session-id> | --repo <path>) (--next-comment | --prev-comment)",
          "  hunk session reload (<session-id> | --repo <path> | --session-path <path>) [--source <path>] -- diff [ref] [-- <pathspec...>]",
          "  hunk session reload (<session-id> | --repo <path> | --session-path <path>) [--source <path>] -- show [ref] [-- <pathspec...>]",
          "  hunk session comment add (<session-id> | --repo <path>) --file <path> (--old-line <n> | --new-line <n>) --summary <text> [--focus]",
          "  hunk session comment list (<session-id> | --repo <path>)",
          "  hunk session comment rm (<session-id> | --repo <path>) <comment-id>",
          "  hunk session comment clear (<session-id> | --repo <path>) --yes",
        ].join("\n") + "\n",
    };
  }

  if (subcommand === "list") {
    const command = new Command("session list")
      .description("list live Hunk sessions")
      .option("--json", "emit structured JSON");
    let parsedOptions: { json?: boolean } = {};

    command.action((options: { json?: boolean }) => {
      parsedOptions = options;
    });

    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
    }

    await parseStandaloneCommand(command, rest);
    return {
      kind: "session",
      action: "list",
      output: resolveJsonOutput(parsedOptions),
    };
  }

  if (subcommand === "get" || subcommand === "context") {
    const command = new Command(`session ${subcommand}`)
      .description(
        subcommand === "get"
          ? "show one live Hunk session"
          : "show the selected file and hunk for one live Hunk session",
      )
      .argument("[sessionId]")
      .option("--repo <path>", "target the live session whose repo root matches this path")
      .option("--json", "emit structured JSON");

    let parsedSessionId: string | undefined;
    let parsedOptions: { repo?: string; json?: boolean } = {};

    command.action((sessionId: string | undefined, options: { repo?: string; json?: boolean }) => {
      parsedSessionId = sessionId;
      parsedOptions = options;
    });

    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
    }

    await parseStandaloneCommand(command, rest);
    return {
      kind: "session",
      action: subcommand,
      output: resolveJsonOutput(parsedOptions),
      selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
    };
  }

  if (subcommand === "navigate") {
    const command = new Command("session navigate")
      .description("move a live Hunk session to one diff hunk")
      .argument("[sessionId]")
      .option("--file <path>", "diff file path as shown by Hunk")
      .option("--repo <path>", "target the live session whose repo root matches this path")
      .option("--hunk <n>", "1-based hunk number within the file", parsePositiveInt)
      .option("--old-line <n>", "1-based line number on the old side", parsePositiveInt)
      .option("--new-line <n>", "1-based line number on the new side", parsePositiveInt)
      .option("--next-comment", "jump to the next annotated hunk")
      .option("--prev-comment", "jump to the previous annotated hunk")
      .option("--json", "emit structured JSON");

    let parsedSessionId: string | undefined;
    let parsedOptions: {
      repo?: string;
      file?: string;
      hunk?: number;
      oldLine?: number;
      newLine?: number;
      nextComment?: boolean;
      prevComment?: boolean;
      json?: boolean;
    } = {};

    command.action(
      (
        sessionId: string | undefined,
        options: {
          repo?: string;
          file?: string;
          hunk?: number;
          oldLine?: number;
          newLine?: number;
          nextComment?: boolean;
          prevComment?: boolean;
          json?: boolean;
        },
      ) => {
        parsedSessionId = sessionId;
        parsedOptions = options;
      },
    );

    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
    }

    await parseStandaloneCommand(command, rest);

    /** Relative comment navigation mode. */
    if (parsedOptions.nextComment || parsedOptions.prevComment) {
      if (parsedOptions.nextComment && parsedOptions.prevComment) {
        throw new Error("Specify either --next-comment or --prev-comment, not both.");
      }

      return {
        kind: "session",
        action: "navigate",
        output: resolveJsonOutput(parsedOptions),
        selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
        commentDirection: parsedOptions.nextComment ? "next" : "prev",
      } as const;
    }

    /** Absolute navigation mode requires --file and a target. */
    if (!parsedOptions.file) {
      throw new Error(
        "Specify --file <path> with a navigation target, or use --next-comment / --prev-comment.",
      );
    }

    const selectors = [
      parsedOptions.hunk !== undefined,
      parsedOptions.oldLine !== undefined,
      parsedOptions.newLine !== undefined,
    ].filter(Boolean);
    if (selectors.length !== 1) {
      throw new Error(
        "Specify exactly one navigation target: --hunk <n>, --old-line <n>, or --new-line <n>.",
      );
    }

    return {
      kind: "session",
      action: "navigate",
      output: resolveJsonOutput(parsedOptions),
      selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
      filePath: parsedOptions.file,
      hunkNumber: parsedOptions.hunk,
      side:
        parsedOptions.oldLine !== undefined
          ? "old"
          : parsedOptions.newLine !== undefined
            ? "new"
            : undefined,
      line: parsedOptions.oldLine ?? parsedOptions.newLine,
    };
  }

  if (subcommand === "reload") {
    const separatorIndex = rest.indexOf("--");
    const outerTokens = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex);

    const command = new Command("session reload")
      .description("replace the contents of one live Hunk session")
      .argument("[sessionId]")
      .option("--repo <path>", "target the live session whose repo root matches this path")
      .option("--session-path <path>", "target a live session rooted at a different path")
      .option("--source <path>", "load the diff from this directory instead of the session's own")
      .option("--json", "emit structured JSON");

    let parsedSessionId: string | undefined;
    let parsedOptions: { sessionPath?: string; repo?: string; source?: string; json?: boolean } =
      {};

    command.action(
      (
        sessionId: string | undefined,
        options: { sessionPath?: string; repo?: string; source?: string; json?: boolean },
      ) => {
        parsedSessionId = sessionId;
        parsedOptions = options;
      },
    );

    if (outerTokens.includes("--help") || outerTokens.includes("-h")) {
      return {
        kind: "help",
        text:
          `${command.helpInformation().trimEnd()}\n\n` +
          [
            "Examples:",
            "  hunk session reload --repo . -- diff",
            "  hunk session reload --repo . -- diff main...feature -- src/ui",
            "  hunk session reload --repo . -- show HEAD~1 -- README.md",
            "  hunk session reload --session-path /path/to/session --source /path/to/repo -- diff",
          ].join("\n") +
          "\n",
      };
    }

    if (separatorIndex === -1) {
      throw new Error(
        "Pass the replacement Hunk command after `--`, for example `hunk session reload <session-id> -- diff`.",
      );
    }

    const nestedTokens = rest.slice(separatorIndex + 1);
    if (nestedTokens.length === 0) {
      throw new Error(
        "Pass the replacement Hunk command after `--`, for example `hunk session reload <session-id> -- diff`.",
      );
    }

    await parseStandaloneCommand(command, outerTokens);
    const nextInput = requireReloadableCliInput(await parseCli(["bun", "hunk", ...nestedTokens]));
    const resolvedReload = resolveReloadSelector(
      parsedSessionId,
      parsedOptions.sessionPath,
      parsedOptions.repo,
      parsedOptions.source,
    );

    return {
      kind: "session",
      action: "reload",
      output: resolveJsonOutput(parsedOptions),
      selector: resolvedReload.selector,
      sourcePath: resolvedReload.sourcePath,
      nextInput,
    };
  }

  if (subcommand === "comment") {
    const [commentSubcommand, ...commentRest] = rest;
    if (!commentSubcommand || commentSubcommand === "--help" || commentSubcommand === "-h") {
      return {
        kind: "help",
        text:
          [
            "Usage:",
            "  hunk session comment add (<session-id> | --repo <path>) --file <path> (--old-line <n> | --new-line <n>) --summary <text> [--focus]",
            "  hunk session comment list (<session-id> | --repo <path>) [--file <path>]",
            "  hunk session comment rm (<session-id> | --repo <path>) <comment-id>",
            "  hunk session comment clear (<session-id> | --repo <path>) [--file <path>] --yes",
          ].join("\n") + "\n",
      };
    }

    if (commentSubcommand === "add") {
      const command = new Command("session comment add")
        .description("attach one live inline review note")
        .argument("[sessionId]")
        .requiredOption("--file <path>", "diff file path as shown by Hunk")
        .requiredOption("--summary <text>", "short review note")
        .option("--repo <path>", "target the live session whose repo root matches this path")
        .option("--old-line <n>", "1-based line number on the old side", parsePositiveInt)
        .option("--new-line <n>", "1-based line number on the new side", parsePositiveInt)
        .option("--rationale <text>", "optional longer explanation")
        .option("--author <name>", "optional author label")
        .option("--focus", "add the note and focus the viewport on it")
        .option("--json", "emit structured JSON");

      let parsedSessionId: string | undefined;
      let parsedOptions: {
        repo?: string;
        file: string;
        summary: string;
        oldLine?: number;
        newLine?: number;
        rationale?: string;
        author?: string;
        focus?: boolean;
        json?: boolean;
      } = {
        file: "",
        summary: "",
      };

      command.action(
        (
          sessionId: string | undefined,
          options: {
            repo?: string;
            file: string;
            summary: string;
            oldLine?: number;
            newLine?: number;
            rationale?: string;
            author?: string;
            focus?: boolean;
            json?: boolean;
          },
        ) => {
          parsedSessionId = sessionId;
          parsedOptions = options;
        },
      );

      if (commentRest.includes("--help") || commentRest.includes("-h")) {
        return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
      }

      await parseStandaloneCommand(command, commentRest);

      const selectors = [
        parsedOptions.oldLine !== undefined,
        parsedOptions.newLine !== undefined,
      ].filter(Boolean);
      if (selectors.length !== 1) {
        throw new Error("Specify exactly one comment target: --old-line <n> or --new-line <n>.");
      }

      return {
        kind: "session",
        action: "comment-add",
        output: resolveJsonOutput(parsedOptions),
        selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
        filePath: parsedOptions.file,
        side: parsedOptions.oldLine !== undefined ? "old" : "new",
        line: parsedOptions.oldLine ?? parsedOptions.newLine ?? 0,
        summary: parsedOptions.summary,
        rationale: parsedOptions.rationale,
        author: parsedOptions.author,
        reveal: parsedOptions.focus ?? false,
      };
    }

    if (commentSubcommand === "list") {
      const command = new Command("session comment list")
        .description("list live inline review notes")
        .argument("[sessionId]")
        .option("--repo <path>", "target the live session whose repo root matches this path")
        .option("--file <path>", "filter comments to one diff file")
        .option("--json", "emit structured JSON");

      let parsedSessionId: string | undefined;
      let parsedOptions: { repo?: string; file?: string; json?: boolean } = {};

      command.action(
        (
          sessionId: string | undefined,
          options: { repo?: string; file?: string; json?: boolean },
        ) => {
          parsedSessionId = sessionId;
          parsedOptions = options;
        },
      );

      if (commentRest.includes("--help") || commentRest.includes("-h")) {
        return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
      }

      await parseStandaloneCommand(command, commentRest);

      return {
        kind: "session",
        action: "comment-list",
        output: resolveJsonOutput(parsedOptions),
        selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
        filePath: parsedOptions.file,
      };
    }

    if (commentSubcommand === "rm") {
      const command = new Command("session comment rm")
        .description("remove one live inline review note")
        .argument("[sessionId]")
        .argument("<commentId>")
        .option("--repo <path>", "target the live session whose repo root matches this path")
        .option("--json", "emit structured JSON");

      let parsedSessionId: string | undefined;
      let parsedCommentId = "";
      let parsedOptions: { repo?: string; json?: boolean } = {};

      command.action(
        (
          sessionId: string | undefined,
          commentId: string,
          options: { repo?: string; json?: boolean },
        ) => {
          parsedSessionId = sessionId;
          parsedCommentId = commentId;
          parsedOptions = options;
        },
      );

      if (commentRest.includes("--help") || commentRest.includes("-h")) {
        return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
      }

      await parseStandaloneCommand(command, commentRest);

      return {
        kind: "session",
        action: "comment-rm",
        output: resolveJsonOutput(parsedOptions),
        selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
        commentId: parsedCommentId,
      };
    }

    if (commentSubcommand === "clear") {
      const command = new Command("session comment clear")
        .description("clear live inline review notes")
        .argument("[sessionId]")
        .option("--repo <path>", "target the live session whose repo root matches this path")
        .option("--file <path>", "clear only one diff file's comments")
        .option("--yes", "confirm destructive live comment clearing")
        .option("--json", "emit structured JSON");

      let parsedSessionId: string | undefined;
      let parsedOptions: {
        repo?: string;
        file?: string;
        yes?: boolean;
        json?: boolean;
      } = {};

      command.action(
        (
          sessionId: string | undefined,
          options: {
            repo?: string;
            file?: string;
            yes?: boolean;
            json?: boolean;
          },
        ) => {
          parsedSessionId = sessionId;
          parsedOptions = options;
        },
      );

      if (commentRest.includes("--help") || commentRest.includes("-h")) {
        return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
      }

      await parseStandaloneCommand(command, commentRest);
      if (!parsedOptions.yes) {
        throw new Error("Pass --yes to clear live comments.");
      }

      return {
        kind: "session",
        action: "comment-clear",
        output: resolveJsonOutput(parsedOptions),
        selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
        filePath: parsedOptions.file,
        confirmed: true,
      };
    }

    throw new Error("Supported comment subcommands are add, list, rm, and clear.");
  }

  throw new Error(`Unknown session command: ${subcommand}`);
}

/** Parse `hunk mcp serve` as the local daemon entrypoint. */
async function parseMcpCommand(tokens: string[]): Promise<ParsedCliInput> {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return {
      kind: "help",
      text:
        [
          "Usage: hunk mcp serve",
          "",
          "Run the local Hunk session daemon and websocket session broker.",
          "",
          "Environment:",
          "  HUNK_MCP_HOST                  bind host (default 127.0.0.1; loopback only unless explicitly overridden)",
          "  HUNK_MCP_PORT                  bind port (default 47657)",
          "  HUNK_MCP_UNSAFE_ALLOW_REMOTE   set to 1 to allow non-loopback binding (unsafe)",
        ].join("\n") + "\n",
    };
  }

  if (subcommand !== "serve") {
    throw new Error("Only `hunk mcp serve` is supported.");
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    return {
      kind: "help",
      text:
        [
          "Usage: hunk mcp serve",
          "",
          "Run the local Hunk session daemon and websocket session broker.",
        ].join("\n") + "\n",
    };
  }

  return {
    kind: "mcp-serve",
  };
}

/** Parse `hunk stash show` as a full-UI stash review command. */
async function parseStashCommand(tokens: string[], argv: string[]): Promise<ParsedCliInput> {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return {
      kind: "help",
      text:
        [
          "Usage: hunk stash show [ref] [options]",
          "",
          "Review a stash entry as a full Hunk changeset.",
          "",
          "Examples:",
          "  hunk stash show",
          "  hunk stash show stash@{1}",
        ].join("\n") + "\n",
    };
  }

  if (subcommand !== "show") {
    throw new Error("Only `hunk stash show` is supported.");
  }

  const command = applyWatchOption(
    createCommand("stash show", "review a stash entry as a full Hunk changeset"),
  ).argument("[ref]");

  let parsedRef: string | undefined;
  let parsedOptions: Record<string, unknown> = {};

  command.action((ref: string | undefined, options: Record<string, unknown>) => {
    parsedRef = ref;
    parsedOptions = options;
  });

  if (rest.includes("--help") || rest.includes("-h")) {
    return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
  }

  await parseStandaloneCommand(command, rest);

  return {
    kind: "stash-show",
    ref: parsedRef,
    options: buildCommonOptions(parsedOptions, argv),
  };
}

/** Parse CLI arguments into one normalized input shape for the app loader layer. */
export async function parseCli(argv: string[]): Promise<ParsedCliInput> {
  const args = argv.slice(2);
  const [commandName, ...rest] = args;

  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    return { kind: "help", text: renderCliHelp() };
  }

  if (commandName === "--version" || commandName === "-v" || commandName === "version") {
    return { kind: "help", text: renderCliVersion() };
  }

  switch (commandName) {
    case "diff":
      return parseDiffCommand(rest, argv);
    case "show":
      return parseShowCommand(rest, argv);
    case "patch":
      return parsePatchCommand(rest, argv);
    case "pager":
      return parsePagerCommand(rest, argv);
    case "difftool":
      return parseDifftoolCommand(rest, argv);
    case "stash":
      return parseStashCommand(rest, argv);
    case "session":
      return parseSessionCommand(rest);
    case "mcp":
      return parseMcpCommand(rest);
    default:
      throw new Error(`Unknown command: ${commandName}`);
  }
}

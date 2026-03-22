import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import type { CommonOptions, HelpCommandInput, LayoutMode, PagerCommandInput, ParsedCliInput } from "./types";

/** Validate one requested layout mode from CLI input. */
function parseLayoutMode(value: string): LayoutMode {
  if (value === "auto" || value === "split" || value === "stack") {
    return value;
  }

  throw new Error(`Invalid layout mode: ${value}`);
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
  },
  argv: string[],
): CommonOptions {
  return {
    mode: options.mode,
    theme: options.theme,
    agentContext: options.agentContext,
    pager: options.pager ? true : undefined,
    lineNumbers: resolveBooleanFlag(argv, "--line-numbers", "--no-line-numbers"),
    wrapLines: resolveBooleanFlag(argv, "--wrap", "--no-wrap"),
    hunkHeaders: resolveBooleanFlag(argv, "--hunk-headers", "--no-hunk-headers"),
    agentNotes: resolveBooleanFlag(argv, "--agent-notes", "--no-agent-notes"),
  };
}

/** Attach the shared mode/theme/agent-context flags to a subcommand parser. */
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

/** Resolve the CLI version from the nearest shipped package manifest. */
function resolveCliVersion() {
  const candidatePaths = [
    resolve(import.meta.dir, "..", "..", "package.json"),
    resolve(dirname(process.execPath), "..", "package.json"),
    resolve(dirname(process.execPath), "..", "..", "package.json"),
  ];

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(candidatePath, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      continue;
    }
  }

  return "0.0.0-unknown";
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
    "",
    "Options:",
    "  -h, --help                              show help",
    "  -v, --version                           show version",
    "",
    "Examples:",
    "  hunk diff",
    "  hunk diff main",
    "  hunk diff main...feature",
    "  hunk diff --staged -- src/ui/App.tsx",
    "  hunk show",
    "  hunk show HEAD~1",
    "  hunk show abc123 -- README.md",
    "  hunk patch -",
    "  hunk pager",
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
    if (error && typeof error === "object" && "code" in error && error.code === "commander.helpDisplayed") {
      return;
    }

    throw error;
  }
}

/** Build one command parser with the shared Hunk options attached. */
function createCommand(name: string, description: string) {
  return applyCommonOptions(new Command(name).description(description));
}

/** Parse the overloaded `hunk diff` command. */
async function parseDiffCommand(tokens: string[], argv: string[]): Promise<ParsedCliInput> {
  const { commandTokens, pathspecs } = splitPathspecArgs(tokens);
  const command = createCommand("diff", "review Git diffs or compare two concrete files")
    .option("--staged", "show staged changes instead of the working tree")
    .option("--cached", "alias for --staged")
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

  if (parsedTargets.length === 2 && !staged && !normalizedPathspecs && areExistingFiles(parsedTargets[0]!, parsedTargets[1]!)) {
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
  const command = createCommand("show", "review the last commit or a given ref").argument("[ref]");

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
  const command = createCommand("patch", "review a patch file, or read a patch from stdin").argument("[file]");

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
async function parsePagerCommand(tokens: string[], argv: string[]): Promise<PagerCommandInput | HelpCommandInput> {
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
  const command = createCommand("difftool", "review Git difftool file pairs")
    .argument("<left>")
    .argument("<right>")
    .argument("[path]");

  let parsedLeft = "";
  let parsedRight = "";
  let parsedPath: string | undefined;
  let parsedOptions: Record<string, unknown> = {};

  command.action((left: string, right: string, path: string | undefined, options: Record<string, unknown>) => {
    parsedLeft = left;
    parsedRight = right;
    parsedPath = path;
    parsedOptions = options;
  });

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

/** Parse `hunk stash show` as a full-UI stash review command. */
async function parseStashCommand(tokens: string[], argv: string[]): Promise<ParsedCliInput> {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return {
      kind: "help",
      text: [
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

  const command = createCommand("stash show", "review a stash entry as a full Hunk changeset").argument("[ref]");

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
    default:
      throw new Error(`Unknown command: ${commandName}`);
  }
}

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import type {
  CliInput,
  CommonOptions,
  CursorLine,
  ExtensionManageCommandInput,
  HelpCommandInput,
  LayoutMode,
  PagerCommandInput,
  ParsedCliInput,
  SelfUpdateCommandInput,
  SessionCommentListType,
  SessionCommentApplyItemInput,
} from "../core/run/commandInputs";
import {
  isBuiltInCliCommandName,
  isValidExtensionCliCommandName,
} from "../core/run/cliCommandNames";
import {
  parseUpdateMethod,
  parseUpdateVersion,
  UPDATE_METHOD_VALUES,
} from "../core/install/selfUpdate";
import {
  BUNDLED_SKILL_NAMES,
  resolveBundledSkillName,
  resolveBundledSkillPath,
  type BundledSkillName,
} from "../core/run/paths";
import {
  type AgentCommandConstraint,
  type AgentCommandSpec,
  AUXILIARY_AGENT_OPTIONS,
  type SessionCommandOptions,
  COMMENT_DIRECTION_CONSTRAINT,
  COMMENT_TARGET_CONSTRAINT,
  HIGHLIGHT_TARGET_CONSTRAINT,
  HIGHLIGHT_TONES,
  isHighlightTone,
  NAVIGATE_TARGET_CONSTRAINT,
  optionKeyFromFlag,
  SESSION_AGENT_COMMANDS,
  SESSION_AGENT_COMMAND_LIST,
  SESSION_COMMENT_COMMAND_LIST,
  SESSION_HIGHLIGHT_COMMAND_LIST,
} from "../session/agent/surface";
import {
  COMMENT_APPLY_STDIN_MESSAGE,
  constraintViolationMessage,
  HIGHLIGHT_RANGE_MESSAGE,
  RELOAD_SEPARATOR_MESSAGE,
} from "../session/agent/errors";
import { DEFAULT_FILE_GAP, DEFAULT_HUNK_GAP, parseReviewGap } from "../core/run/reviewGap";
import { DEFAULT_TAB_WIDTH, parseTabWidth } from "../core/run/tabWidth";
import { resolveCliVersion } from "../core/run/version";

/** Structured option metadata shared by Commander registration and generated CLI docs. */
export interface CliReferenceOption {
  readonly flag: string;
  readonly description: string;
  readonly parse?:
    | "layout"
    | "cursorLine"
    | "positiveInt"
    | "tabWidth"
    | "fileGap"
    | "hunkGap"
    | "collect";
  readonly defaultValue?: string;
  /** Default applied directly by Commander (as opposed to a config-resolved default). */
  readonly commanderDefault?: string;
  readonly hidden?: boolean;
}

/** Structured command metadata used by runtime parsers and generated CLI docs. */
export interface CliReferenceCommand {
  readonly path: string;
  readonly summary: string;
  readonly synopsis: readonly string[];
  readonly aliases?: readonly string[];
  /** Additional prose rendered after this command's generated usage block. */
  readonly details?: readonly string[];
  readonly options?: readonly CliReferenceOption[];
  readonly commonReviewOptions?: boolean;
  readonly watch?: boolean;
}

/** Review flags registered on every full-screen review command. */
export const COMMON_REVIEW_OPTIONS = [
  { flag: "--mode <mode>", description: "layout mode: auto, split, stack", parse: "layout" },
  {
    flag: "--cursor-line <style>",
    description: "current-line marker: row, number, off",
    parse: "cursorLine",
  },
  { flag: "--theme <theme>", description: "named theme override" },
  AUXILIARY_AGENT_OPTIONS.agentContext,
  { flag: "--pager", description: "use pager-style chrome" },
  AUXILIARY_AGENT_OPTIONS.experimental,
  {
    flag: "--fast",
    description: "experimentally offload eligible syntax highlighting",
  },
  { flag: "--line-numbers", description: "show line numbers" },
  { flag: "--no-line-numbers", description: "hide line numbers" },
  {
    flag: "-x, --tab-width <columns>",
    description: "tab stop width: 1-16",
    parse: "tabWidth",
    defaultValue: String(DEFAULT_TAB_WIDTH),
  },
  {
    flag: "--file-gap <rows>",
    description: "file separator rows, including the ─ rule: 0-8",
    parse: "fileGap",
    defaultValue: String(DEFAULT_FILE_GAP),
  },
  {
    flag: "--hunk-gap <rows>",
    description: "blank rows before each later hunk: 0-8",
    parse: "hunkGap",
    defaultValue: String(DEFAULT_HUNK_GAP),
  },
  { flag: "--wrap", description: "wrap long diff lines" },
  { flag: "--no-wrap", description: "truncate long diff lines to one row" },
  { flag: "--hunk-headers", description: "show hunk metadata rows" },
  { flag: "--no-hunk-headers", description: "hide hunk metadata rows" },
  { flag: "--sidebar", description: "show files pane" },
  { flag: "--no-sidebar", description: "hide files pane" },
  { flag: "--agent-notes", description: "show agent notes by default" },
  { flag: "--no-agent-notes", description: "hide agent notes by default" },
  { flag: "--transparent-bg", description: "let terminal background show through Hunk surfaces" },
  { flag: "--no-transparent-bg", description: "paint Hunk surfaces with the active theme" },
  {
    flag: "--extension <path>",
    description: "load an extension entry file or directory (repeatable)",
    parse: "collect",
  },
  { flag: "--no-extensions", description: "disable user extensions for this run" },
] as const satisfies readonly CliReferenceOption[];

/** Auto-refresh flag shared by review commands whose inputs can be reopened. */
export const WATCH_OPTION = {
  flag: "--watch",
  description: "auto-reload when the current diff input changes",
} as const satisfies CliReferenceOption;

const DIFF_OPTIONS = [
  {
    flag: "--files <paths...>",
    description: "compare exactly two concrete files: --files <left> <right>",
  },
  { flag: "--staged", description: "show staged changes instead of the working tree" },
  { flag: "--cached", description: "alias for --staged" },
  AUXILIARY_AGENT_OPTIONS.excludeUntracked,
  {
    flag: `--no-${AUXILIARY_AGENT_OPTIONS.excludeUntracked.flag.slice(2)}`,
    description: "include untracked files in working tree reviews",
    hidden: true,
  },
] as const satisfies readonly CliReferenceOption[];

/** Non-session command tree consumed by the parser and generated reference. */
export const CLI_REFERENCE_COMMANDS = {
  diff: {
    path: "diff",
    summary: "review diffs or compare two concrete files",
    synopsis: [
      "hunk diff [target] [-- <pathspec...>]",
      "hunk diff <from> <to> [-- <pathspec...>]",
      "hunk diff --staged [-- <pathspec...>]",
      "hunk diff --files <left> <right>",
    ],
    details: [
      "Two positional arguments always name revision endpoints, even when matching files exist on disk.",
      "Use `--files <left> <right>` for concrete-file comparison; this replaces the former filesystem-existence disambiguation.",
    ],
    options: DIFF_OPTIONS,
    commonReviewOptions: true,
    watch: true,
  },
  show: {
    path: "show",
    summary: "review the last commit or a given ref",
    synopsis: ["hunk show [target] [-- <pathspec...>]"],
    commonReviewOptions: true,
    watch: true,
  },
  "stash-show": {
    path: "stash show",
    summary: "review a stash entry as a full Hunk changeset",
    synopsis: ["hunk stash show [ref]"],
    commonReviewOptions: true,
    watch: true,
  },
  patch: {
    path: "patch",
    summary: "review a patch file, or read a patch from stdin",
    synopsis: ["hunk patch [file]"],
    commonReviewOptions: true,
    watch: true,
  },
  pager: {
    path: "pager",
    summary: "general Git pager wrapper with diff detection",
    synopsis: ["hunk pager"],
    commonReviewOptions: true,
  },
  difftool: {
    path: "difftool",
    summary: "review Git difftool file pairs",
    synopsis: ["hunk difftool <left> <right> [path]"],
    commonReviewOptions: true,
    watch: true,
  },
  "markup-render": {
    path: "markup render",
    summary: "preview experimental STML markup as terminal text",
    synopsis: ["hunk markup render (<file> | -) [options]"],
    options: [
      { ...AUXILIARY_AGENT_OPTIONS.markupWidth, parse: "positiveInt", defaultValue: "56" },
      {
        flag: "--color <mode>",
        description: "auto, always, or never",
        defaultValue: "auto",
        commanderDefault: "auto",
      },
      { flag: "--theme <id>", description: "hunk theme used to resolve colors" },
      { flag: "--json", description: "emit structured JSON" },
    ],
  },
  "markup-guide": {
    path: "markup guide",
    summary: "print the experimental STML authoring guide",
    synopsis: ["hunk markup guide"],
  },
  "skill-path": {
    path: "skill path",
    summary: "print a bundled Hunk skill path",
    synopsis: ["hunk skill path [name]"],
  },
  "extension-install": {
    path: "extension install",
    summary: "install a shared extension from a git repository",
    synopsis: [
      "hunk extension install <owner>/<repo>[@ref]",
      "hunk extension install git:<host>/<path>[@ref]",
      "hunk extension install <git-url or local path>[@ref]",
    ],
    aliases: ["hunk ext install"],
    options: [
      {
        flag: "--yes",
        description: "skip the confirmation prompt (required without a TTY)",
      },
    ],
  },
  "extension-list": {
    path: "extension list",
    summary: "list extensions installed with `hunk extension install`",
    synopsis: ["hunk extension list"],
    aliases: ["hunk ext list"],
  },
  "extension-update": {
    path: "extension update",
    summary: "re-clone managed extension installs from their recorded sources",
    synopsis: ["hunk extension update [name]"],
    aliases: ["hunk ext update"],
  },
  "extension-remove": {
    path: "extension remove",
    summary: "remove one managed extension install",
    synopsis: ["hunk extension remove <name>"],
    aliases: ["hunk ext remove"],
  },
  update: {
    path: "update",
    summary: "update Hunk with the package manager that installed it",
    synopsis: [
      "hunk update [version]",
      "hunk update --check",
      "hunk update --method <npm|brew|curl>",
    ],
    options: [
      {
        flag: "--method <method>",
        description: `install method instead of the detected one: ${UPDATE_METHOD_VALUES.join(", ")}`,
      },
      {
        flag: "--check",
        description: "report the installed and available versions without installing",
      },
    ],
  },
  "daemon-serve": {
    path: "daemon serve",
    summary: "run the local Hunk session daemon and websocket session broker",
    synopsis: ["hunk daemon serve"],
    aliases: ["hunk mcp serve"],
  },
} as const satisfies Record<string, CliReferenceCommand>;

/** Validate one requested layout mode from CLI input. */
function parseLayoutMode(value: string): LayoutMode {
  if (value === "auto" || value === "split" || value === "stack") {
    return value;
  }

  throw new Error(`Invalid layout mode: ${value}`);
}

/** Validate one requested current-line style from CLI input. */
function parseCursorLine(value: string): CursorLine {
  if (value === "row" || value === "number" || value === "off") {
    return value;
  }

  throw new Error(`Invalid cursor line style: ${value}`);
}

/** Parse one required positive integer CLI value. */
function parsePositiveInt(value: string) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid positive integer: ${value}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid positive integer: ${value}`);
  }

  return parsed;
}

/** Parse one required non-negative integer CLI value, accepting 0. */
function parseNonNegativeInt(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }

  return parsed;
}

/** Read one paired boolean flag before the pathspec separator in raw argv. */
function resolveBooleanFlag(argv: string[], enabledFlag: string, disabledFlag: string) {
  let resolved: boolean | undefined;

  for (const arg of argv) {
    if (arg === "--") break;

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

/** Collect one repeatable CLI value into an array. */
function collectRepeatedValue(value: string, previous: string[] = []) {
  return [...previous, value];
}

/** Normalize the flags shared by every input mode. */
function buildCommonOptions(
  options: {
    mode?: LayoutMode;
    cursorLine?: CursorLine;
    theme?: string;
    agentContext?: string;
    pager?: boolean;
    watch?: boolean;
    experimental?: boolean;
    fast?: boolean;
    transparentBackground?: boolean;
    tabWidth?: number;
    fileGap?: number;
    hunkGap?: number;
    extension?: string[];
  },
  argv: string[],
): CommonOptions {
  return {
    mode: options.mode,
    cursorLine: options.cursorLine,
    theme: options.theme,
    agentContext: options.agentContext,
    pager: options.pager ? true : undefined,
    watch: options.watch ? true : undefined,
    experimental:
      options.experimental || hasPrefixedReviewFlag(argv, AUXILIARY_AGENT_OPTIONS.experimental.flag)
        ? true
        : undefined,
    fast: options.fast || hasPrefixedReviewFlag(argv, "--fast") ? true : undefined,
    excludeUntracked: resolveBooleanFlag(
      argv,
      AUXILIARY_AGENT_OPTIONS.excludeUntracked.flag,
      `--no-${AUXILIARY_AGENT_OPTIONS.excludeUntracked.flag.slice(2)}`,
    ),
    lineNumbers: resolveBooleanFlag(argv, "--line-numbers", "--no-line-numbers"),
    tabWidth: options.tabWidth,
    fileGap: options.fileGap,
    hunkGap: options.hunkGap,
    wrapLines: resolveBooleanFlag(argv, "--wrap", "--no-wrap"),
    hunkHeaders: resolveBooleanFlag(argv, "--hunk-headers", "--no-hunk-headers"),
    sidebar: resolveBooleanFlag(argv, "--sidebar", "--no-sidebar"),
    agentNotes: resolveBooleanFlag(argv, "--agent-notes", "--no-agent-notes"),
    transparentBackground: resolveBooleanFlag(argv, "--transparent-bg", "--no-transparent-bg"),
    // Read straight from argv so the absence of the flag stays undefined rather than
    // becoming Commander's implicit `true` default for a negatable option.
    extensions: resolveBooleanFlag(argv, "--extensions", "--no-extensions"),
    extensionPaths:
      options.extension && options.extension.length > 0 ? options.extension : undefined,
  };
}

/** Register one structured option with Commander. */
function applyReferenceOption(command: Command, option: CliReferenceOption) {
  const commanderOption = new Option(option.flag, option.description);
  if (option.parse === "layout") {
    commanderOption.argParser(parseLayoutMode);
  } else if (option.parse === "cursorLine") {
    commanderOption.argParser(parseCursorLine);
  } else if (option.parse === "positiveInt") {
    commanderOption.argParser(parsePositiveInt);
  } else if (option.parse === "tabWidth") {
    commanderOption.argParser(parseTabWidth);
  } else if (option.parse === "fileGap") {
    commanderOption.argParser((value: string) => parseReviewGap(value, "file gap"));
  } else if (option.parse === "hunkGap") {
    commanderOption.argParser((value: string) => parseReviewGap(value, "hunk gap"));
  } else if (option.parse === "collect") {
    commanderOption.argParser(collectRepeatedValue);
  }
  if (option.commanderDefault !== undefined) {
    commanderOption.default(option.commanderDefault);
  }
  if (option.hidden) {
    commanderOption.hideHelp();
  }
  command.addOption(commanderOption);
  return command;
}

/** Build one Commander parser directly from the shared command reference metadata. */
export function createCliReferenceCommand(key: keyof typeof CLI_REFERENCE_COMMANDS): Command {
  const spec: CliReferenceCommand = CLI_REFERENCE_COMMANDS[key];
  const command = new Command(spec.path).description(spec.summary);

  if (spec.commonReviewOptions) {
    for (const option of COMMON_REVIEW_OPTIONS) {
      applyReferenceOption(command, option);
    }
  }
  if (spec.watch) {
    applyReferenceOption(command, WATCH_OPTION);
  }
  for (const option of spec.options ?? []) {
    applyReferenceOption(command, option);
  }

  return command;
}

/** Render plain-text version output for `hunk --version`. */
function renderCliVersion() {
  return `${resolveCliVersion()}\n`;
}

/** Render one bundled skill path for shell usage. */
function renderBundledSkillPath(name?: BundledSkillName) {
  return `${resolveBundledSkillPath(name)}\n`;
}

/** Build the `hunk skill` help text. */
function renderSkillHelp() {
  return [
    "Usage: hunk skill path [name]",
    "",
    "Print a bundled Hunk skill path.",
    "Load or symlink that file in your coding agent to keep it in sync across Hunk upgrades.",
    "",
    "Skills:",
    `  hunk-review (default, "review")   review a live Hunk session with \`hunk session\` commands`,
    `  hunk-extensions ("extensions")    build extensions against the hunkdiff/extension API`,
    "",
  ].join("\n");
}

/** Build the top-level help text shown by bare `hunk` and `hunk --help`. */
function renderCliHelp() {
  return [
    "Usage: hunk <command> [options]",
    "",
    "Desktop-inspired terminal diff viewer for agent-authored changesets.",
    "",
    "Commands:",
    "  hunk diff [target] [-- <pathspec...>]   review working tree changes or compare against a target",
    "  hunk diff <from> <to>                   compare two revisions",
    "  hunk diff --staged [-- <pathspec...>]   review staged changes",
    "  hunk diff --files <left> <right>        compare two concrete files",
    "  hunk show [target] [-- <pathspec...>]   review the last commit or a given target",
    "  hunk stash show [ref]                   review a stash entry (git only)",
    "  hunk patch [file]                       review a patch file or stdin",
    "  hunk pager                              general Git pager wrapper with diff detection",
    "  hunk difftool <left> <right> [path]     review Git difftool file pairs",
    "  hunk session <subcommand>               inspect or control a live Hunk session",
    "  hunk markup render (<file> | -)         preview experimental STML note markup",
    "  hunk markup guide                       print the experimental STML authoring guide",
    "  hunk skill path [name]                  print a bundled Hunk skill path",
    "  hunk extension <subcommand>             install and manage shared extensions",
    "  hunk update [version]                   update Hunk with the package manager that installed it",
    "  hunk daemon serve                       run the local Hunk session daemon",
    "",
    "Global options:",
    "  -h, --help                              show help",
    "  -v, --version                           show version",
    "  --experimental                          enable experimental review features (currently STML)",
    "  --fast                                  review working tree with experimental fast highlighting",
    "",
    "Common review options:",
    "  --mode <mode>                           layout mode: auto, split, stack",
    "  --watch                                 auto-reload when the current diff input changes",
    "  --agent-context <path>                  JSON sidecar with agent rationale",
    "  --pager                                 use pager-style chrome",
    "  --line-numbers / --no-line-numbers      show or hide line numbers",
    "  -x, --tab-width <columns>                tab stop width: 1-16 (default: 4)",
    "  --file-gap <rows>                       file separator rows, including ─: 0-8 (default: 1)",
    "  --hunk-gap <rows>                       blank rows before later hunks: 0-8 (default: 0)",
    "  --wrap / --no-wrap                      wrap or truncate long diff lines",
    "  --hunk-headers / --no-hunk-headers      show or hide hunk metadata rows",
    "  --sidebar / --no-sidebar                show or hide files pane by default",
    "  --agent-notes / --no-agent-notes        show or hide agent notes by default",
    "  --transparent-bg / --no-transparent-bg  let terminal background show through Hunk surfaces",
    "  --theme <theme>                         named theme override",
    "  --extension <path>                      load an extension entry file or directory (repeatable)",
    "  --no-extensions                         disable user extensions for this run",
    "",
    "Git diff options:",
    "  --staged, --cached                      review staged changes",
    "  --exclude-untracked                     hide untracked files in working tree reviews",
    "",
    "Notes:",
    "  Run `hunk <command> --help` for command-specific syntax and options.",
    '  "target" refers to a generic set of changes; it can be a ref (git) or revset (jj)',
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

/** Resolve whether one nested CLI command requested JSON output. */
function resolveJsonOutput(options: { json?: boolean }) {
  return options.json ? "json" : "text";
}

function parsePositiveJsonInt(
  value: unknown,
  { field, itemNumber }: { field: string; itemNumber: number },
) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Comment ${itemNumber} field \`${field}\` must be a positive integer.`);
  }

  return value;
}

/** Parse one stdin JSON payload for `session comment apply`. */
function parseSessionCommentApplyPayload(raw: string): SessionCommentApplyItemInput[] {
  if (raw.trim().length === 0) {
    throw new Error("Session comment apply expected one JSON object on stdin.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Session comment apply expected valid JSON on stdin.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Session comment apply expected one JSON object with a comments array.");
  }

  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value.comments)) {
    throw new Error("Session comment apply expected a top-level `comments` array.");
  }

  if (value.comments.length === 0) {
    throw new Error("Session comment apply expected at least one comment.");
  }

  return value.comments.map((comment, index) => {
    const itemNumber = index + 1;
    if (!comment || typeof comment !== "object") {
      throw new Error(`Comment ${itemNumber} must be a JSON object.`);
    }

    const item = comment as Record<string, unknown>;
    const filePath = item.filePath;
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error(`Comment ${itemNumber} requires a non-empty \`filePath\`.`);
    }

    const summary = item.summary;
    if (typeof summary !== "string" || summary.length === 0) {
      throw new Error(`Comment ${itemNumber} requires a non-empty \`summary\`.`);
    }

    const hunk = parsePositiveJsonInt(item.hunk, { field: "hunk", itemNumber });
    const hunkNumber = parsePositiveJsonInt(item.hunkNumber, { field: "hunkNumber", itemNumber });
    if (hunk !== undefined && hunkNumber !== undefined) {
      throw new Error(`Comment ${itemNumber} must not specify both \`hunk\` and \`hunkNumber\`.`);
    }

    const oldLine = parsePositiveJsonInt(item.oldLine, { field: "oldLine", itemNumber });
    const newLine = parsePositiveJsonInt(item.newLine, { field: "newLine", itemNumber });
    const resolvedHunkNumber = hunk ?? hunkNumber;

    const selectors = [
      resolvedHunkNumber !== undefined,
      oldLine !== undefined,
      newLine !== undefined,
    ].filter(Boolean);
    if (selectors.length !== 1) {
      throw new Error(
        `Comment ${itemNumber} must specify exactly one of \`hunk\`, \`hunkNumber\`, \`oldLine\`, or \`newLine\`.`,
      );
    }

    return {
      filePath,
      hunkNumber: resolvedHunkNumber,
      side: oldLine !== undefined ? "old" : newLine !== undefined ? "new" : undefined,
      line: oldLine ?? newLine,
      summary,
      rationale: typeof item.rationale === "string" ? item.rationale : undefined,
      markup: typeof item.markup === "string" && item.markup.length > 0 ? item.markup : undefined,
      author: typeof item.author === "string" ? item.author : undefined,
    };
  });
}

/** Canonicalize a `--repo` path without assuming which VCS owns it. */
function resolveRepoSelectorRoot(repoPath: string): string {
  const resolved = resolve(repoPath);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
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

  return sessionId ? { sessionId } : { repoRoot: resolveRepoSelectorRoot(repoRoot!) };
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
      selector: { repoRoot: resolveRepoSelectorRoot(repoRoot) },
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
  const command = createCliReferenceCommand("diff").argument("[targets...]");

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
  const files = Array.isArray(parsedOptions.files)
    ? parsedOptions.files.filter((value): value is string => typeof value === "string")
    : undefined;

  if (files) {
    if (files.length !== 2 || parsedTargets.length > 0 || staged || normalizedPathspecs) {
      throw new Error(
        "Use `hunk diff --files <left> <right>` with exactly two file paths and no revision, staged, or pathspec arguments.",
      );
    }
    return { kind: "diff", left: files[0]!, right: files[1]!, options };
  }

  if (parsedTargets.length === 0) {
    return {
      kind: "vcs",
      staged,
      pathspecs: normalizedPathspecs,
      options,
    };
  }

  if (parsedTargets.length === 1) {
    return {
      kind: "vcs",
      range: parsedTargets[0],
      staged,
      pathspecs: normalizedPathspecs,
      options,
    };
  }

  if (!staged && parsedTargets.length === 2) {
    const left = parsedTargets[0]!;
    const right = parsedTargets[1]!;

    // Two positionals always name revisions. Paths use `--`, while concrete file comparison uses
    // `--files`, so parsing never depends on the current filesystem or backend syntax.
    return {
      kind: "vcs",
      rangeEndpoints: { from: left, to: right },
      staged,
      pathspecs: normalizedPathspecs,
      options,
    };
  }

  if (!staged && !normalizedPathspecs) {
    return {
      kind: "vcs",
      range: parsedTargets[0]!,
      staged,
      pathspecs: parsedTargets.slice(1),
      options,
    };
  }

  throw new Error(
    "Use `hunk diff [target] [-- pathspec...]`, `hunk diff <from> <to>`, or `hunk diff --files <left> <right>` for file comparison.",
  );
}

/** Parse the Git-style `hunk show` command. */
async function parseShowCommand(tokens: string[], argv: string[]): Promise<ParsedCliInput> {
  const { commandTokens, pathspecs } = splitPathspecArgs(tokens);
  const command = createCliReferenceCommand("show").argument("[ref]");

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
  const command = createCliReferenceCommand("patch").argument("[file]");

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
  const command = createCliReferenceCommand("pager");
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
  const command = createCliReferenceCommand("difftool")
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
  if (
    input.kind === "help" ||
    input.kind === "pager" ||
    input.kind === "daemon-serve" ||
    input.kind === "markup-render" ||
    input.kind === "markup-guide" ||
    input.kind === "extension-manage" ||
    input.kind === "extension-cli" ||
    input.kind === "update"
  ) {
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

/** Build one Commander command from its declarative agent-surface spec. */
function buildSessionCommand(spec: AgentCommandSpec) {
  const command = new Command(spec.name).description(spec.summary);

  for (const positional of spec.positionals) {
    if (positional.description) {
      command.argument(positional.token, positional.description);
    } else {
      command.argument(positional.token);
    }
  }

  for (const option of spec.options) {
    const register = option.required
      ? command.requiredOption.bind(command)
      : command.option.bind(command);
    if (option.parse === "positiveInt") {
      register(option.flag, option.description, parsePositiveInt);
    } else if (option.parse === "nonNegativeInt") {
      register(option.flag, option.description, parseNonNegativeInt);
    } else {
      register(option.flag, option.description);
    }
  }

  return command;
}

/** Render `--help` output for one session command, appending spec examples and extras. */
function sessionCommandHelpText(command: Command, spec: AgentCommandSpec): HelpCommandInput {
  const sections = [command.helpInformation().trimEnd()];

  if (spec.examples && spec.examples.length > 0) {
    sections.push(["Examples:", ...spec.examples.map((example) => `  ${example}`)].join("\n"));
  }

  if (spec.helpExtra && spec.helpExtra.length > 0) {
    sections.push(spec.helpExtra.join("\n"));
  }

  return { kind: "help", text: `${sections.join("\n\n")}\n` };
}

/** Throw the shared catalog message when a declared flag-group constraint is violated. */
function enforceConstraint(constraint: AgentCommandConstraint, options: Record<string, unknown>) {
  const provided = constraint.flags.filter(
    (flag) => options[optionKeyFromFlag(flag)] !== undefined,
  ).length;
  const violated = constraint.kind === "exactly-one" ? provided !== 1 : provided > 1;
  if (violated) {
    throw new Error(constraintViolationMessage(constraint));
  }
}

/** Render usage lines for a list of session commands as one indented help block. */
function sessionUsageLines(specs: readonly AgentCommandSpec[]) {
  return specs.flatMap((spec) => spec.synopsis.map((line) => `  ${line}`));
}

/** Return whether one session command token list requests help. */
function hasSessionHelpFlag(tokens: readonly string[]) {
  return tokens.includes("--help") || tokens.includes("-h");
}

/** Render the top-level session command overview. */
function sessionOverviewHelp(): HelpCommandInput {
  return {
    kind: "help",
    text:
      [
        "Usage: hunk session <subcommand> [options]",
        "",
        "Inspect and control live Hunk review sessions through the local daemon.",
        "",
        "Commands:",
        ...sessionUsageLines(SESSION_AGENT_COMMAND_LIST),
      ].join("\n") + "\n",
  };
}

/** Parse `hunk session list`. */
async function parseSessionListCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS.list;
  const command = buildSessionCommand(spec);
  let parsedOptions: SessionCommandOptions<"list"> = {};

  command.action((options: SessionCommandOptions<"list">) => {
    parsedOptions = options;
  });

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  return {
    kind: "session",
    action: "list",
    output: resolveJsonOutput(parsedOptions),
  };
}

/** Options shared by the get and context read-command parser. */
type SessionReadCommandOptions = SessionCommandOptions<"get"> | SessionCommandOptions<"context">;

/** Parse a session get or context command with their shared selector shape. */
async function parseSessionReadCommand(
  action: "get" | "context",
  tokens: string[],
): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS[action];
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionReadCommandOptions = {};

  command.action((sessionId: string | undefined, options: SessionReadCommandOptions) => {
    parsedSessionId = sessionId;
    parsedOptions = options;
  });

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  return {
    kind: "session",
    action,
    output: resolveJsonOutput(parsedOptions),
    selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
  };
}

/** Parse `hunk session review`. */
async function parseSessionReviewCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS.review;
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionCommandOptions<"review"> = {};

  command.action((sessionId: string | undefined, options: SessionCommandOptions<"review">) => {
    parsedSessionId = sessionId;
    parsedOptions = options;
  });

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  return {
    kind: "session",
    action: "review",
    output: resolveJsonOutput(parsedOptions),
    selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
    includePatch: parsedOptions.includePatch ?? false,
    includeNotes: parsedOptions.includeNotes ?? false,
  };
}

/** Parse `hunk session navigate`. */
async function parseSessionNavigateCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS.navigate;
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionCommandOptions<"navigate"> = {};

  command.action((sessionId: string | undefined, options: SessionCommandOptions<"navigate">) => {
    parsedSessionId = sessionId;
    parsedOptions = options;
  });

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);

  // A comment id is resolved by the daemon and must not silently discard another selector.
  const commentHasConflictingSelector =
    parsedOptions.comment !== undefined &&
    (parsedOptions.file !== undefined ||
      parsedOptions.hunk !== undefined ||
      parsedOptions.oldLine !== undefined ||
      parsedOptions.newLine !== undefined ||
      parsedOptions.nextComment === true ||
      parsedOptions.prevComment === true);
  if (commentHasConflictingSelector) {
    throw new Error(
      "Specify exactly one navigation selector: --comment, --next-comment / --prev-comment, or --file with a navigation target.",
    );
  }

  if (parsedOptions.comment !== undefined) {
    return {
      kind: "session",
      action: "navigate",
      output: resolveJsonOutput(parsedOptions),
      selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
      commentId: parsedOptions.comment,
    } as const;
  }

  if (parsedOptions.nextComment || parsedOptions.prevComment) {
    enforceConstraint(COMMENT_DIRECTION_CONSTRAINT, parsedOptions);
    return {
      kind: "session",
      action: "navigate",
      output: resolveJsonOutput(parsedOptions),
      selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
      commentDirection: parsedOptions.nextComment ? "next" : "prev",
    } as const;
  }

  if (!parsedOptions.file) {
    throw new Error(
      "Specify --comment <id>, --next-comment / --prev-comment, or --file <path> with a navigation target.",
    );
  }

  enforceConstraint(NAVIGATE_TARGET_CONSTRAINT, parsedOptions);
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

/** Parse `hunk session reload`, keeping nested command tokens isolated after `--`. */
async function parseSessionReloadCommand(tokens: string[]): Promise<ParsedCliInput> {
  const separatorIndex = tokens.indexOf("--");
  const outerTokens = separatorIndex === -1 ? tokens : tokens.slice(0, separatorIndex);
  const spec = SESSION_AGENT_COMMANDS.reload;
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionCommandOptions<"reload"> = {};

  command.action((sessionId: string | undefined, options: SessionCommandOptions<"reload">) => {
    parsedSessionId = sessionId;
    parsedOptions = options;
  });

  if (hasSessionHelpFlag(outerTokens)) {
    return sessionCommandHelpText(command, spec);
  }

  if (separatorIndex === -1) {
    throw new Error(RELOAD_SEPARATOR_MESSAGE);
  }

  const nestedTokens = tokens.slice(separatorIndex + 1);
  if (nestedTokens.length === 0) {
    throw new Error(RELOAD_SEPARATOR_MESSAGE);
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

/** Parse `hunk session comment add`. */
async function parseSessionCommentAddCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS["comment-add"];
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionCommandOptions<"comment-add"> = {
    file: "",
    summary: "",
  };

  command.action((sessionId: string | undefined, options: SessionCommandOptions<"comment-add">) => {
    parsedSessionId = sessionId;
    parsedOptions = options;
  });

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  enforceConstraint(COMMENT_TARGET_CONSTRAINT, parsedOptions);

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
    markup: parsedOptions.markup,
    author: parsedOptions.author,
    reveal: parsedOptions.focus ?? false,
  };
}

/** Parse `hunk session comment apply`, reading stdin only after option validation. */
async function parseSessionCommentApplyCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS["comment-apply"];
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionCommandOptions<"comment-apply"> = {};

  command.action(
    (sessionId: string | undefined, options: SessionCommandOptions<"comment-apply">) => {
      parsedSessionId = sessionId;
      parsedOptions = options;
    },
  );

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  if (!parsedOptions.stdin) {
    throw new Error(COMMENT_APPLY_STDIN_MESSAGE);
  }

  const comments = parseSessionCommentApplyPayload(await new Response(Bun.stdin.stream()).text());
  return {
    kind: "session",
    action: "comment-apply",
    output: resolveJsonOutput(parsedOptions),
    selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
    comments,
    revealMode: parsedOptions.focus ? "first" : "none",
  };
}

/** Parse `hunk session comment list`. */
async function parseSessionCommentListCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS["comment-list"];
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionCommandOptions<"comment-list"> = {};

  command.action(
    (sessionId: string | undefined, options: SessionCommandOptions<"comment-list">) => {
      parsedSessionId = sessionId;
      parsedOptions = options;
    },
  );

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  if (
    parsedOptions.type !== undefined &&
    parsedOptions.type !== "live" &&
    parsedOptions.type !== "all" &&
    parsedOptions.type !== "ai" &&
    parsedOptions.type !== "agent" &&
    parsedOptions.type !== "user"
  ) {
    throw new Error("Comment type must be one of live, all, ai, agent, or user.");
  }

  return {
    kind: "session",
    action: "comment-list",
    output: resolveJsonOutput(parsedOptions),
    selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
    filePath: parsedOptions.file,
    ...(parsedOptions.type ? { type: parsedOptions.type as SessionCommentListType } : {}),
  };
}

/** Parse `hunk session comment rm`. */
async function parseSessionCommentRmCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS["comment-rm"];
  const command = buildSessionCommand(spec);
  let parsedTargets: string[] = [];
  let parsedOptions: SessionCommandOptions<"comment-rm"> = {};

  command.action((targets: string[], options: SessionCommandOptions<"comment-rm">) => {
    parsedTargets = targets;
    parsedOptions = options;
  });

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  const expectedTargetCount = parsedOptions.repo ? 1 : 2;
  if (parsedTargets.length !== expectedTargetCount) {
    throw new Error(
      parsedOptions.repo
        ? "Specify exactly one comment id with --repo <path>."
        : "Specify a session id and comment id, or pass --repo <path> with one comment id.",
    );
  }

  const parsedSessionId = parsedOptions.repo ? undefined : parsedTargets[0];
  const parsedCommentId = parsedOptions.repo ? parsedTargets[0] : parsedTargets[1];
  return {
    kind: "session",
    action: "comment-rm",
    output: resolveJsonOutput(parsedOptions),
    selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
    commentId: parsedCommentId ?? "",
  };
}

/** Parse `hunk session comment clear`. */
async function parseSessionCommentClearCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS["comment-clear"];
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionCommandOptions<"comment-clear"> = {};

  command.action(
    (sessionId: string | undefined, options: SessionCommandOptions<"comment-clear">) => {
      parsedSessionId = sessionId;
      parsedOptions = options;
    },
  );

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  if (!parsedOptions.yes) {
    throw new Error("Pass --yes to clear comments.");
  }

  return {
    kind: "session",
    action: "comment-clear",
    output: resolveJsonOutput(parsedOptions),
    selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
    filePath: parsedOptions.file,
    ...(parsedOptions.includeUser || parsedOptions.all ? { includeUser: true } : {}),
    confirmed: true,
  };
}

/** Dispatch one command under the session comment namespace. */
function parseSessionCommentCommand(tokens: string[]): Promise<ParsedCliInput> | ParsedCliInput {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return {
      kind: "help",
      text: ["Usage:", ...sessionUsageLines(SESSION_COMMENT_COMMAND_LIST)].join("\n") + "\n",
    };
  }

  switch (subcommand) {
    case "add":
      return parseSessionCommentAddCommand(rest);
    case "apply":
      return parseSessionCommentApplyCommand(rest);
    case "list":
      return parseSessionCommentListCommand(rest);
    case "rm":
      return parseSessionCommentRmCommand(rest);
    case "clear":
      return parseSessionCommentClearCommand(rest);
    default:
      throw new Error("Supported comment subcommands are add, apply, list, rm, and clear.");
  }
}

/** Parse `hunk session highlight add`. */
async function parseSessionHighlightAddCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS["highlight-add"];
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionCommandOptions<"highlight-add"> = {
    file: "",
    start: 0,
    end: 0,
  };

  command.action(
    (sessionId: string | undefined, options: SessionCommandOptions<"highlight-add">) => {
      parsedSessionId = sessionId;
      parsedOptions = options;
    },
  );

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  enforceConstraint(HIGHLIGHT_TARGET_CONSTRAINT, parsedOptions);
  if (parsedOptions.end <= parsedOptions.start) {
    throw new Error(HIGHLIGHT_RANGE_MESSAGE);
  }

  const tone = parsedOptions.tone;
  if (tone !== undefined && !isHighlightTone(tone)) {
    throw new Error(`Highlight tone must be one of ${HIGHLIGHT_TONES.join(", ")}.`);
  }

  return {
    kind: "session",
    action: "highlight-add",
    output: resolveJsonOutput(parsedOptions),
    selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
    filePath: parsedOptions.file,
    side: parsedOptions.oldLine !== undefined ? "old" : "new",
    line: parsedOptions.oldLine ?? parsedOptions.newLine ?? 0,
    start: parsedOptions.start,
    end: parsedOptions.end,
    ...(tone !== undefined && isHighlightTone(tone) ? { tone } : {}),
    reveal: parsedOptions.focus ?? false,
  };
}

/** Parse `hunk session highlight clear`. */
async function parseSessionHighlightClearCommand(tokens: string[]): Promise<ParsedCliInput> {
  const spec = SESSION_AGENT_COMMANDS["highlight-clear"];
  const command = buildSessionCommand(spec);
  let parsedSessionId: string | undefined;
  let parsedOptions: SessionCommandOptions<"highlight-clear"> = {};

  command.action(
    (sessionId: string | undefined, options: SessionCommandOptions<"highlight-clear">) => {
      parsedSessionId = sessionId;
      parsedOptions = options;
    },
  );

  if (hasSessionHelpFlag(tokens)) {
    return sessionCommandHelpText(command, spec);
  }

  await parseStandaloneCommand(command, tokens);
  return {
    kind: "session",
    action: "highlight-clear",
    output: resolveJsonOutput(parsedOptions),
    selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
    filePath: parsedOptions.file,
  };
}

/** Dispatch one command under the session highlight namespace. */
function parseSessionHighlightCommand(tokens: string[]): Promise<ParsedCliInput> | ParsedCliInput {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return {
      kind: "help",
      text: ["Usage:", ...sessionUsageLines(SESSION_HIGHLIGHT_COMMAND_LIST)].join("\n") + "\n",
    };
  }

  switch (subcommand) {
    case "add":
      return parseSessionHighlightAddCommand(rest);
    case "clear":
      return parseSessionHighlightClearCommand(rest);
    default:
      throw new Error("Supported highlight subcommands are add and clear.");
  }
}

/** Dispatch `hunk session ...` to one focused live-session command parser. */
function parseSessionCommand(tokens: string[]): Promise<ParsedCliInput> | ParsedCliInput {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return sessionOverviewHelp();
  }

  switch (subcommand) {
    case "list":
      return parseSessionListCommand(rest);
    case "get":
    case "context":
      return parseSessionReadCommand(subcommand, rest);
    case "review":
      return parseSessionReviewCommand(rest);
    case "navigate":
      return parseSessionNavigateCommand(rest);
    case "reload":
      return parseSessionReloadCommand(rest);
    case "comment":
      return parseSessionCommentCommand(rest);
    case "highlight":
      return parseSessionHighlightCommand(rest);
    default:
      throw new Error(`Unknown session command: ${subcommand}`);
  }
}

const MARKUP_HELP = [
  "Usage:",
  "  hunk markup render (<file> | -) [--width <n>] [--color <auto|always|never>] [--theme <id>] [--json]",
  "  hunk markup guide",
  "",
  "Experimental STML authoring tools.",
  "",
  "render   preview STML markup as terminal text without launching the TUI;",
  "         render notes (unknown tags, layout degradations) go to stderr",
  "  --width <n>   layout width in columns (default 56, the note reference width)",
  "  --color       auto (default: color when stdout is a TTY), always, or never",
  "  --theme <id>  hunk theme used to resolve colors (default github-dark-default)",
  "  --json        emit { width, lines, notes } instead of text",
  "guide    print the STML authoring guide with copy-paste patterns",
  "",
].join("\n");

/** Parse `hunk markup ...` for STML preview and guide commands. */
async function parseMarkupCommand(tokens: string[]): Promise<ParsedCliInput> {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return { kind: "help", text: MARKUP_HELP };
  }

  if (subcommand === "guide") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", text: MARKUP_HELP };
    }
    if (rest.length > 0) {
      throw new Error("`hunk markup guide` does not accept additional arguments.");
    }
    return { kind: "markup-guide" };
  }

  if (subcommand === "render") {
    const command = createCliReferenceCommand("markup-render").argument(
      "[file]",
      "markup file path, or - for stdin",
      "-",
    );

    let parsedFile = "-";
    let parsedOptions: { width?: number; color: string; theme?: string; json?: boolean } = {
      color: "auto",
    };
    command.action(
      (
        file: string,
        options: { width?: number; color: string; theme?: string; json?: boolean },
      ) => {
        parsedFile = file;
        parsedOptions = options;
      },
    );

    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
    }

    await parseStandaloneCommand(command, rest);

    if (!["auto", "always", "never"].includes(parsedOptions.color)) {
      throw new Error("--color must be auto, always, or never.");
    }

    return {
      kind: "markup-render",
      file: parsedFile,
      width: parsedOptions.width ?? 56,
      color: parsedOptions.color as "auto" | "always" | "never",
      theme: parsedOptions.theme,
      json: parsedOptions.json ?? false,
    };
  }

  throw new Error("Supported markup subcommands are render and guide.");
}

/** Parse `hunk skill ...` for bundled skill discovery commands. */
async function parseSkillCommand(tokens: string[]): Promise<HelpCommandInput> {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return {
      kind: "help",
      text: renderSkillHelp(),
    };
  }

  if (subcommand !== "path") {
    throw new Error("Only `hunk skill path` is supported.");
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    return {
      kind: "help",
      text: renderSkillHelp(),
    };
  }

  if (rest.length > 1) {
    throw new Error("`hunk skill path` accepts at most one skill name.");
  }

  const [requestedName] = rest;
  if (requestedName === undefined) {
    return { kind: "help", text: renderBundledSkillPath() };
  }

  const name = resolveBundledSkillName(requestedName);
  if (!name) {
    throw new Error(
      `Unknown skill "${requestedName}". Bundled skills are ${BUNDLED_SKILL_NAMES.join(" and ")}.`,
    );
  }

  return {
    kind: "help",
    text: renderBundledSkillPath(name),
  };
}

const EXTENSION_MANAGE_HELP = [
  "Usage:",
  "  hunk extension install <source> [--yes]",
  "  hunk extension list",
  "  hunk extension update [name]",
  "  hunk extension remove <name>",
  "",
  "Install and manage shared extensions. `hunk ext` is an alias for `hunk extension`.",
  "",
  "install  clone an extension repository into Hunk's managed install directory;",
  "         sources are <owner>/<repo>[@ref], git:<host>/<path>[@ref], a git URL,",
  "         or a local path. Installed extensions run with your full user",
  "         permissions — only install repositories you trust.",
  "list     show every managed install with its version, commit, and source",
  "update   re-clone one managed install (or all of them) from its source",
  "remove   delete one managed install and its record",
  "",
  "Find community extensions by browsing the hunk-extension topic on GitHub:",
  "https://github.com/topics/hunk-extension",
  "",
].join("\n");

/** Parse `hunk extension ...` managed-install commands. */
async function parseExtensionCommand(
  tokens: string[],
): Promise<ExtensionManageCommandInput | HelpCommandInput> {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return { kind: "help", text: EXTENSION_MANAGE_HELP };
  }

  if (subcommand === "install") {
    const command = createCliReferenceCommand("extension-install").argument(
      "<source>",
      "owner/repo[@ref], git:host/path[@ref], a git URL, or a local path",
    );

    let parsedSource = "";
    let parsedOptions: { yes?: boolean } = {};
    command.action((source: string, options: { yes?: boolean }) => {
      parsedSource = source;
      parsedOptions = options;
    });

    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
    }

    await parseStandaloneCommand(command, rest);
    return {
      kind: "extension-manage",
      action: "install",
      source: parsedSource,
      yes: parsedOptions.yes ?? false,
    };
  }

  if (subcommand === "list") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", text: EXTENSION_MANAGE_HELP };
    }
    if (rest.length > 0) {
      throw new Error("`hunk extension list` does not accept additional arguments.");
    }
    return { kind: "extension-manage", action: "list" };
  }

  if (subcommand === "update") {
    const command = createCliReferenceCommand("extension-update").argument("[name]");

    let parsedName: string | undefined;
    command.action((name: string | undefined) => {
      parsedName = name;
    });

    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
    }

    await parseStandaloneCommand(command, rest);
    return { kind: "extension-manage", action: "update", name: parsedName };
  }

  if (subcommand === "remove" || subcommand === "rm" || subcommand === "uninstall") {
    const command = createCliReferenceCommand("extension-remove").argument("<name>");

    let parsedName = "";
    command.action((name: string) => {
      parsedName = name;
    });

    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
    }

    await parseStandaloneCommand(command, rest);
    return { kind: "extension-manage", action: "remove", name: parsedName };
  }

  throw new Error("Supported extension subcommands are install, list, update, and remove.");
}

/** Parse `hunk update` as the standalone self-update command. */
async function parseUpdateCommand(
  tokens: string[],
): Promise<SelfUpdateCommandInput | HelpCommandInput> {
  const command = createCliReferenceCommand("update").argument(
    "[version]",
    "version to install; the newest release when omitted",
  );

  let parsedVersion: string | undefined;
  let parsedOptions: { method?: string; check?: boolean } = {};

  command.action((version: string | undefined, options: { method?: string; check?: boolean }) => {
    parsedVersion = version;
    parsedOptions = options;
  });

  if (tokens.includes("--help") || tokens.includes("-h")) {
    return {
      kind: "help",
      text:
        [
          command.helpInformation().trimEnd(),
          "",
          "Hunk updates itself only for installs it owns: npm (or bun/pnpm global installs),",
          "Homebrew, and installs from https://hunk.dev/install.sh. Nix, mise, and local source",
          "builds print the command that updates them.",
          "",
          "Examples:",
          "  hunk update",
          "  hunk update 1.2.3",
          "  hunk update --check",
          "  hunk update --method brew",
          "  hunk update --method curl",
        ].join("\n") + "\n",
    };
  }

  await parseStandaloneCommand(command, tokens);

  // Validate the flag before the positional argument, so a typo in `--method` is reported as
  // itself rather than shadowed by whatever version it was paired with.
  const method = parsedOptions.method ? parseUpdateMethod(parsedOptions.method) : undefined;

  return {
    kind: "update",
    version: parsedVersion === undefined ? undefined : parseUpdateVersion(parsedVersion),
    method,
    check: parsedOptions.check ?? false,
  };
}

/** Parse `hunk daemon serve` as the canonical local daemon entrypoint. */
async function parseDaemonCommand(tokens: string[]): Promise<ParsedCliInput> {
  const [subcommand, ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return {
      kind: "help",
      text:
        [
          "Usage: hunk daemon serve",
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
    throw new Error("Only `hunk daemon serve` is supported.");
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    return {
      kind: "help",
      text:
        [
          "Usage: hunk daemon serve",
          "",
          "Run the local Hunk session daemon and websocket session broker.",
        ].join("\n") + "\n",
    };
  }

  return {
    kind: "daemon-serve",
  };
}

/** Parse `hunk stash show` as a full-UI stash review command. */
async function parseStashCommand(
  tokens: string[],
  argv: string[],
  leadingOptionTokens: readonly string[] = [],
): Promise<ParsedCliInput> {
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

  const command = createCliReferenceCommand("stash-show").argument("[ref]");

  let parsedRef: string | undefined;
  let parsedOptions: Record<string, unknown> = {};

  command.action((ref: string | undefined, options: Record<string, unknown>) => {
    parsedRef = ref;
    parsedOptions = options;
  });

  const commandTokens = [...leadingOptionTokens, ...rest];
  if (commandTokens.includes("--help") || commandTokens.includes("-h")) {
    return { kind: "help", text: `${command.helpInformation().trimEnd()}\n` };
  }

  await parseStandaloneCommand(command, commandTokens);

  return {
    kind: "stash-show",
    ref: parsedRef,
    options: buildCommonOptions(parsedOptions, argv),
  };
}

const REVIEW_COMMAND_NAMES = new Set(["diff", "show", "patch", "pager", "difftool", "stash"]);

interface LeadingCliFlags {
  args: string[];
  extensionPaths: string[];
  extensionsEnabled: boolean;
  extensionFlagTokens: string[];
  prefixedReviewFlags: string[];
}

/** Return whether a token is another host flag rather than an extension path value. */
function isLeadingHostFlag(token: string) {
  return (
    token === "--fast" ||
    token === AUXILIARY_AGENT_OPTIONS.experimental.flag ||
    token === "--no-extensions" ||
    token === "--extension" ||
    token.startsWith("--extension=")
  );
}

/** Split host-owned leading flags from the command token without touching its subtree. */
function parseLeadingCliFlags(rawArgs: string[]): LeadingCliFlags {
  const extensionPaths: string[] = [];
  const extensionFlagTokens: string[] = [];
  const prefixedReviewFlags: string[] = [];
  let extensionsEnabled = true;
  let index = 0;

  while (index < rawArgs.length) {
    const token = rawArgs[index];
    if (token === "--fast" || token === AUXILIARY_AGENT_OPTIONS.experimental.flag) {
      prefixedReviewFlags.push(token);
      index += 1;
      continue;
    }
    if (token === "--no-extensions") {
      extensionsEnabled = false;
      extensionFlagTokens.push(token);
      index += 1;
      continue;
    }
    if (token === "--extension") {
      const path = rawArgs[index + 1];
      if (path === undefined || isLeadingHostFlag(path)) {
        throw new Error(
          "`--extension` requires an extension entry path; use `--extension=<path>` for a path beginning with `-`.",
        );
      }
      extensionPaths.push(path);
      extensionFlagTokens.push(token, path);
      index += 2;
      continue;
    }
    if (token?.startsWith("--extension=")) {
      const path = token.slice("--extension=".length);
      if (path.length === 0) {
        throw new Error("`--extension` requires an extension entry path.");
      }
      extensionPaths.push(path);
      extensionFlagTokens.push("--extension", path);
      index += 1;
      continue;
    }
    break;
  }

  return {
    args: rawArgs.slice(index),
    extensionPaths,
    extensionsEnabled,
    extensionFlagTokens,
    prefixedReviewFlags,
  };
}

/** Return whether one review flag appears among the parsed leading host flags. */
function hasPrefixedReviewFlag(argv: string[], flag: string) {
  return parseLeadingCliFlags(argv.slice(2)).prefixedReviewFlags.includes(flag);
}

/** Parse CLI arguments into one normalized input shape for the app loader layer. */
export async function parseCli(argv: string[]): Promise<ParsedCliInput> {
  const rawArgs = argv.slice(2);
  const leading = parseLeadingCliFlags(rawArgs);
  const { args, extensionPaths, extensionsEnabled, extensionFlagTokens, prefixedReviewFlags } =
    leading;
  const prefixedFast = prefixedReviewFlags.includes("--fast");
  const [explicitCommandName, ...rest] = args;
  const commandName = explicitCommandName ?? (prefixedFast ? "diff" : undefined);

  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    return { kind: "help", text: renderCliHelp() };
  }

  if (commandName === "--version" || commandName === "-v" || commandName === "version") {
    return { kind: "help", text: renderCliVersion() };
  }

  // `hunk --fast` is shorthand for `hunk diff --fast`, so options and targets following the
  // launch flag belong to the diff parser unless they explicitly name another Hunk command.
  if (prefixedFast && explicitCommandName && !isBuiltInCliCommandName(explicitCommandName)) {
    return parseDiffCommand([...extensionFlagTokens, ...args], argv);
  }

  if (prefixedReviewFlags.length > 0 && !REVIEW_COMMAND_NAMES.has(commandName)) {
    throw new Error(`\`${prefixedReviewFlags[0]}\` must be used with a Hunk review command.`);
  }

  // Only review commands and extension CLI commands consume the leading bootstrap flags. The
  // remaining built-ins never load extensions, so accepting the flags there would silently
  // discard them; refuse the invocation the way a misplaced `--fast` is refused.
  if (
    extensionFlagTokens.length > 0 &&
    isBuiltInCliCommandName(commandName) &&
    !REVIEW_COMMAND_NAMES.has(commandName)
  ) {
    throw new Error(
      `\`${extensionFlagTokens[0]}\` must be used with a Hunk review command or an ` +
        `extension CLI command, not \`${commandName}\`.`,
    );
  }

  // Host bootstrap options must stay before a review command's `--` pathspec separator.
  const reviewRest = [...extensionFlagTokens, ...rest];
  switch (commandName) {
    case "diff":
      return parseDiffCommand(reviewRest, argv);
    case "show":
      return parseShowCommand(reviewRest, argv);
    case "patch":
      return parsePatchCommand(reviewRest, argv);
    case "pager":
      return parsePagerCommand(reviewRest, argv);
    case "difftool":
      return parseDifftoolCommand(reviewRest, argv);
    case "stash":
      // `show` is Hunk's stash subcommand, so keep it ahead of reconstructed host options.
      return parseStashCommand(rest, argv, extensionFlagTokens);
    case "session":
      return parseSessionCommand(rest);
    case "markup":
      return parseMarkupCommand(rest);
    case "skill":
      return parseSkillCommand(rest);
    case "extension":
    case "ext":
      return parseExtensionCommand(rest);
    case "update":
      return parseUpdateCommand(rest);
    case "daemon":
    case "mcp":
      return parseDaemonCommand(rest);
    default:
      if (!isValidExtensionCliCommandName(commandName)) {
        throw new Error(`Unknown command: ${commandName}`);
      }
      return {
        kind: "extension-cli",
        commandName,
        args: rest,
        extensionPaths,
        extensionsEnabled,
      };
  }
}

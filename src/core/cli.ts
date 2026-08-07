import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import type {
  CliInput,
  CommonOptions,
  CursorLine,
  HelpCommandInput,
  LayoutMode,
  PagerCommandInput,
  ParsedCliInput,
  SessionCommentListType,
  SessionCommentApplyItemInput,
} from "./types";
import { resolveBundledHunkReviewSkillPath } from "./paths";
import {
  type AgentCommandConstraint,
  type AgentCommandSpec,
  AUXILIARY_AGENT_OPTIONS,
  type SessionCommandOptions,
  COMMENT_DIRECTION_CONSTRAINT,
  COMMENT_TARGET_CONSTRAINT,
  NAVIGATE_TARGET_CONSTRAINT,
  optionKeyFromFlag,
  SESSION_AGENT_COMMANDS,
  SESSION_AGENT_COMMAND_LIST,
  SESSION_COMMENT_COMMAND_LIST,
} from "../session/agent/surface";
import {
  COMMENT_APPLY_STDIN_MESSAGE,
  constraintViolationMessage,
  RELOAD_SEPARATOR_MESSAGE,
} from "../session/agent/errors";
import { detectVcs } from "./vcs";
import { DEFAULT_TAB_WIDTH, parseTabWidth } from "./tabWidth";
import { resolveCliVersion } from "./version";

/** Structured option metadata shared by Commander registration and generated CLI docs. */
export interface CliReferenceOption {
  readonly flag: string;
  readonly description: string;
  readonly parse?: "layout" | "cursorLine" | "positiveInt" | "tabWidth" | "collect";
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
  { flag: "--line-numbers", description: "show line numbers" },
  { flag: "--no-line-numbers", description: "hide line numbers" },
  {
    flag: "-x, --tab-width <columns>",
    description: "tab stop width: 1-16",
    parse: "tabWidth",
    defaultValue: String(DEFAULT_TAB_WIDTH),
  },
  { flag: "--wrap", description: "wrap long diff lines" },
  { flag: "--no-wrap", description: "truncate long diff lines to one row" },
  { flag: "--hunk-headers", description: "show hunk metadata rows" },
  { flag: "--no-hunk-headers", description: "hide hunk metadata rows" },
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
      "hunk diff --staged [-- <pathspec...>]",
      "hunk diff <left> <right>",
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
    summary: "print the bundled Hunk review skill path",
    synopsis: ["hunk skill path"],
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
    transparentBackground?: boolean;
    tabWidth?: number;
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
      options.experimental || argv[2] === AUXILIARY_AGENT_OPTIONS.experimental.flag
        ? true
        : undefined,
    excludeUntracked: resolveBooleanFlag(
      argv,
      AUXILIARY_AGENT_OPTIONS.excludeUntracked.flag,
      `--no-${AUXILIARY_AGENT_OPTIONS.excludeUntracked.flag.slice(2)}`,
    ),
    lineNumbers: resolveBooleanFlag(argv, "--line-numbers", "--no-line-numbers"),
    tabWidth: options.tabWidth,
    wrapLines: resolveBooleanFlag(argv, "--wrap", "--no-wrap"),
    hunkHeaders: resolveBooleanFlag(argv, "--hunk-headers", "--no-hunk-headers"),
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

/** Render the bundled Hunk review skill path for shell usage. */
function renderHunkReviewSkillPath() {
  return `${resolveBundledHunkReviewSkillPath()}\n`;
}

/** Build the `hunk skill` help text. */
function renderSkillHelp() {
  return [
    "Usage: hunk skill path",
    "",
    "Print the bundled Hunk review skill path.",
    "Load or symlink that file in your coding agent to keep it in sync across Hunk upgrades.",
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
    "  hunk diff --staged [-- <pathspec...>]   review staged changes",
    "  hunk diff <left> <right>                compare two concrete files",
    "  hunk show [target] [-- <pathspec...>]   review the last commit or a given target",
    "  hunk stash show [ref]                   review a stash entry (git only)",
    "  hunk patch [file]                       review a patch file or stdin",
    "  hunk pager                              general Git pager wrapper with diff detection",
    "  hunk difftool <left> <right> [path]     review Git difftool file pairs",
    "  hunk session <subcommand>               inspect or control a live Hunk session",
    "  hunk markup render (<file> | -)         preview experimental STML note markup",
    "  hunk markup guide                       print the experimental STML authoring guide",
    "  hunk skill path                         print the bundled Hunk review skill path",
    "  hunk daemon serve                       run the local Hunk session daemon",
    "",
    "Global options:",
    "  -h, --help                              show help",
    "  -v, --version                           show version",
    "  --experimental                          enable experimental review features (currently STML)",
    "",
    "Common review options:",
    "  --mode <mode>                           layout mode: auto, split, stack",
    "  --watch                                 auto-reload when the current diff input changes",
    "  --agent-context <path>                  JSON sidecar with agent rationale",
    "  --pager                                 use pager-style chrome",
    "  --line-numbers / --no-line-numbers      show or hide line numbers",
    "  -x, --tab-width <columns>                tab stop width: 1-16 (default: 4)",
    "  --wrap / --no-wrap                      wrap or truncate long diff lines",
    "  --hunk-headers / --no-hunk-headers      show or hide hunk metadata rows",
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

/**
 * Resolve a `--repo <path>` selector to the containing VCS toplevel.
 *
 * Sessions register under their repo root, so the selector must walk up from the
 * given path to that root; otherwise a query run from a subdirectory would never
 * match. The detected root is canonicalized through symlinks to mirror the
 * session's registered repoRoot (git's `--show-toplevel` is realpath-canonical),
 * so matching also holds under a symlinked ancestor like macOS `/tmp`. Falls back
 * to the resolved path when it is not inside a known checkout.
 */
function resolveRepoSelectorRoot(repoPath: string): string {
  const resolved = resolve(repoPath);
  const repoRoot = detectVcs(resolved)?.repoRoot;
  // The detected root always exists on disk, so realpath cannot throw here.
  return repoRoot ? realpathSync.native(repoRoot) : resolved;
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

  if (!staged && !normalizedPathspecs) {
    if (parsedTargets.length === 2 && areExistingFiles(parsedTargets[0]!, parsedTargets[1]!)) {
      return {
        kind: "diff",
        left: parsedTargets[0]!,
        right: parsedTargets[1]!,
        options,
      };
    }

    return {
      kind: "vcs",
      range: parsedTargets[0]!,
      staged,
      pathspecs: parsedTargets.slice(1),
      options,
    };
  }

  throw new Error(
    "Use `hunk diff [target] [-- pathspec...]`, `hunk diff <left> <right>` for file comparison.",
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
    input.kind === "markup-guide"
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
          ...sessionUsageLines(SESSION_AGENT_COMMAND_LIST),
        ].join("\n") + "\n",
    };
  }

  if (subcommand === "list") {
    const command = buildSessionCommand(SESSION_AGENT_COMMANDS.list);
    let parsedOptions: SessionCommandOptions<"list"> = {};

    command.action((options: SessionCommandOptions<"list">) => {
      parsedOptions = options;
    });

    if (rest.includes("--help") || rest.includes("-h")) {
      return sessionCommandHelpText(command, SESSION_AGENT_COMMANDS.list);
    }

    await parseStandaloneCommand(command, rest);
    return {
      kind: "session",
      action: "list",
      output: resolveJsonOutput(parsedOptions),
    };
  }

  if (subcommand === "get" || subcommand === "context" || subcommand === "review") {
    const spec = SESSION_AGENT_COMMANDS[subcommand];
    const command = buildSessionCommand(spec);

    let parsedSessionId: string | undefined;
    // Review's parsed shape is a strict superset of get/context, so it types the shared branch.
    let parsedOptions: SessionCommandOptions<"review"> = {};

    command.action((sessionId: string | undefined, options: SessionCommandOptions<"review">) => {
      parsedSessionId = sessionId;
      parsedOptions = options;
    });

    if (rest.includes("--help") || rest.includes("-h")) {
      return sessionCommandHelpText(command, spec);
    }

    await parseStandaloneCommand(command, rest);
    if (subcommand === "review") {
      return {
        kind: "session",
        action: "review",
        output: resolveJsonOutput(parsedOptions),
        selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
        includePatch: parsedOptions.includePatch ?? false,
        includeNotes: parsedOptions.includeNotes ?? false,
      };
    }

    return {
      kind: "session",
      action: subcommand,
      output: resolveJsonOutput(parsedOptions),
      selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
    };
  }

  if (subcommand === "navigate") {
    const command = buildSessionCommand(SESSION_AGENT_COMMANDS.navigate);

    let parsedSessionId: string | undefined;
    let parsedOptions: SessionCommandOptions<"navigate"> = {};

    command.action((sessionId: string | undefined, options: SessionCommandOptions<"navigate">) => {
      parsedSessionId = sessionId;
      parsedOptions = options;
    });

    if (rest.includes("--help") || rest.includes("-h")) {
      return sessionCommandHelpText(command, SESSION_AGENT_COMMANDS.navigate);
    }

    await parseStandaloneCommand(command, rest);

    /** Relative comment navigation mode. */
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

    /** Absolute navigation mode requires --file and a target. */
    if (!parsedOptions.file) {
      throw new Error(
        "Specify --file <path> with a navigation target, or use --next-comment / --prev-comment.",
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

  if (subcommand === "reload") {
    const separatorIndex = rest.indexOf("--");
    const outerTokens = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex);

    const command = buildSessionCommand(SESSION_AGENT_COMMANDS.reload);

    let parsedSessionId: string | undefined;
    let parsedOptions: SessionCommandOptions<"reload"> = {};

    command.action((sessionId: string | undefined, options: SessionCommandOptions<"reload">) => {
      parsedSessionId = sessionId;
      parsedOptions = options;
    });

    if (outerTokens.includes("--help") || outerTokens.includes("-h")) {
      return sessionCommandHelpText(command, SESSION_AGENT_COMMANDS.reload);
    }

    if (separatorIndex === -1) {
      throw new Error(RELOAD_SEPARATOR_MESSAGE);
    }

    const nestedTokens = rest.slice(separatorIndex + 1);
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

  if (subcommand === "comment") {
    const [commentSubcommand, ...commentRest] = rest;
    if (!commentSubcommand || commentSubcommand === "--help" || commentSubcommand === "-h") {
      return {
        kind: "help",
        text: ["Usage:", ...sessionUsageLines(SESSION_COMMENT_COMMAND_LIST)].join("\n") + "\n",
      };
    }

    if (commentSubcommand === "add") {
      const command = buildSessionCommand(SESSION_AGENT_COMMANDS["comment-add"]);

      let parsedSessionId: string | undefined;
      let parsedOptions: SessionCommandOptions<"comment-add"> = {
        file: "",
        summary: "",
      };

      command.action(
        (sessionId: string | undefined, options: SessionCommandOptions<"comment-add">) => {
          parsedSessionId = sessionId;
          parsedOptions = options;
        },
      );

      if (commentRest.includes("--help") || commentRest.includes("-h")) {
        return sessionCommandHelpText(command, SESSION_AGENT_COMMANDS["comment-add"]);
      }

      await parseStandaloneCommand(command, commentRest);

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

    if (commentSubcommand === "apply") {
      const command = buildSessionCommand(SESSION_AGENT_COMMANDS["comment-apply"]);

      let parsedSessionId: string | undefined;
      let parsedOptions: SessionCommandOptions<"comment-apply"> = {};

      command.action(
        (sessionId: string | undefined, options: SessionCommandOptions<"comment-apply">) => {
          parsedSessionId = sessionId;
          parsedOptions = options;
        },
      );

      if (commentRest.includes("--help") || commentRest.includes("-h")) {
        return sessionCommandHelpText(command, SESSION_AGENT_COMMANDS["comment-apply"]);
      }

      await parseStandaloneCommand(command, commentRest);
      if (!parsedOptions.stdin) {
        throw new Error(COMMENT_APPLY_STDIN_MESSAGE);
      }

      const comments = parseSessionCommentApplyPayload(
        await new Response(Bun.stdin.stream()).text(),
      );

      return {
        kind: "session",
        action: "comment-apply",
        output: resolveJsonOutput(parsedOptions),
        selector: resolveExplicitSessionSelector(parsedSessionId, parsedOptions.repo),
        comments,
        revealMode: parsedOptions.focus ? "first" : "none",
      };
    }

    if (commentSubcommand === "list") {
      const command = buildSessionCommand(SESSION_AGENT_COMMANDS["comment-list"]);

      let parsedSessionId: string | undefined;
      let parsedOptions: SessionCommandOptions<"comment-list"> = {};

      command.action(
        (sessionId: string | undefined, options: SessionCommandOptions<"comment-list">) => {
          parsedSessionId = sessionId;
          parsedOptions = options;
        },
      );

      if (commentRest.includes("--help") || commentRest.includes("-h")) {
        return sessionCommandHelpText(command, SESSION_AGENT_COMMANDS["comment-list"]);
      }

      await parseStandaloneCommand(command, commentRest);
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

    if (commentSubcommand === "rm") {
      const command = buildSessionCommand(SESSION_AGENT_COMMANDS["comment-rm"]);

      let parsedTargets: string[] = [];
      let parsedOptions: SessionCommandOptions<"comment-rm"> = {};

      command.action((targets: string[], options: SessionCommandOptions<"comment-rm">) => {
        parsedTargets = targets;
        parsedOptions = options;
      });

      if (commentRest.includes("--help") || commentRest.includes("-h")) {
        return sessionCommandHelpText(command, SESSION_AGENT_COMMANDS["comment-rm"]);
      }

      await parseStandaloneCommand(command, commentRest);

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

    if (commentSubcommand === "clear") {
      const command = buildSessionCommand(SESSION_AGENT_COMMANDS["comment-clear"]);

      let parsedSessionId: string | undefined;
      let parsedOptions: SessionCommandOptions<"comment-clear"> = {};

      command.action(
        (sessionId: string | undefined, options: SessionCommandOptions<"comment-clear">) => {
          parsedSessionId = sessionId;
          parsedOptions = options;
        },
      );

      if (commentRest.includes("--help") || commentRest.includes("-h")) {
        return sessionCommandHelpText(command, SESSION_AGENT_COMMANDS["comment-clear"]);
      }

      await parseStandaloneCommand(command, commentRest);
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

    throw new Error("Supported comment subcommands are add, apply, list, rm, and clear.");
  }

  throw new Error(`Unknown session command: ${subcommand}`);
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

  if (rest.length > 0) {
    throw new Error("`hunk skill path` does not accept additional arguments.");
  }

  return {
    kind: "help",
    text: renderHunkReviewSkillPath(),
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

  const command = createCliReferenceCommand("stash-show").argument("[ref]");

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
  const rawArgs = argv.slice(2);
  const prefixedExperimental = rawArgs[0] === AUXILIARY_AGENT_OPTIONS.experimental.flag;
  const args = prefixedExperimental ? rawArgs.slice(1) : rawArgs;
  const [commandName, ...rest] = args;

  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    return { kind: "help", text: renderCliHelp() };
  }

  if (commandName === "--version" || commandName === "-v" || commandName === "version") {
    return { kind: "help", text: renderCliVersion() };
  }

  if (
    prefixedExperimental &&
    !["diff", "show", "patch", "pager", "difftool", "stash"].includes(commandName)
  ) {
    throw new Error("`--experimental` must be used with a Hunk review command.");
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
    case "markup":
      return parseMarkupCommand(rest);
    case "skill":
      return parseSkillCommand(rest);
    case "daemon":
    case "mcp":
      return parseDaemonCommand(rest);
    default:
      throw new Error(`Unknown command: ${commandName}`);
  }
}

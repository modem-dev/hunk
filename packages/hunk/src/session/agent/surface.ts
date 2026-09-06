import type { SessionDaemonAction } from "../protocol";

/**
 * Declarative description of the agent-facing `hunk session` command surface.
 *
 * This module is the single source of truth for what agents can invoke: the Commander commands in
 * `packages/hunk/src/app/cli.ts`, the `hunk session --help` usage text, and the generated
 * `packages/hunk/skills/hunk-review/SKILL.md` reference sections are all derived from these specs, so the parser
 * and the docs cannot drift apart. Keep it pure data with no runtime dependencies.
 */

/** One agent-facing CLI option on a `hunk session` command. */
export interface AgentCommandOption {
  /** Commander flag definition, e.g. `--repo <path>`. */
  readonly flag: string;
  /** Description shared by `--help` output and generated docs. */
  readonly description: string;
  /** Parse the option value as a 1-based positive or 0-based non-negative integer. */
  readonly parse?: "positiveInt" | "nonNegativeInt";
  /** Register with Commander as a required option. */
  readonly required?: boolean;
}

/** One positional argument on a `hunk session` command. */
export interface AgentCommandPositional {
  /** Commander argument token, e.g. `[sessionId]` or `[targets...]`. */
  readonly token: string;
  readonly description?: string;
}

/** Declarative spec for one agent-facing `hunk session` command. */
export interface AgentCommandSpec {
  /** Commander command path without the binary name, e.g. `session comment add`. */
  readonly name: string;
  /** One-line description used by Commander help. */
  readonly summary: string;
  readonly positionals: readonly AgentCommandPositional[];
  readonly options: readonly AgentCommandOption[];
  /** Canonical usage lines shared by `hunk session --help` and the generated skill. */
  readonly synopsis: readonly string[];
  /** Flag-group rules the parser enforces; also rendered into synopsis fragments. */
  readonly constraints?: readonly AgentCommandConstraint[];
  /** Copy-paste invocations appended to `--help` output and reused in the generated skill. */
  readonly examples?: readonly string[];
  /** Extra literal help lines (e.g. a stdin payload shape) appended after examples. */
  readonly helpExtra?: readonly string[];
}

/** Kebab-case flag body converted to the camelCase key Commander stores parsed values under. */
type CamelCase<Text extends string> = Text extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : Text;

/** Flag name without the leading dashes or value token, e.g. `--old-line <n>` -> `old-line`. */
type FlagBody<Flag extends string> = Flag extends `--${infer Name} ${string}`
  ? Name
  : Flag extends `--${infer Name}`
    ? Name
    : never;

/** The parsed value Commander produces for one option: boolean flag, string value, or number. */
type OptionValue<Option extends AgentCommandOption> = Option["flag"] extends `${string} <${string}>`
  ? Option extends { readonly parse: "positiveInt" | "nonNegativeInt" }
    ? number
    : string
  : boolean;

/**
 * The parsed-options shape one spec produces. Deriving this from the manifest means adding or
 * renaming an option automatically updates the action handler's type in `packages/hunk/src/app/cli.ts` —
 * hand-written option interfaces could silently drift from the declared surface.
 */
export type ParsedCommandOptions<Spec extends AgentCommandSpec> = {
  [Option in Spec["options"][number] as Option extends { readonly required: true }
    ? CamelCase<FlagBody<Option["flag"]>>
    : never]: OptionValue<Option>;
} & {
  [Option in Spec["options"][number] as Option extends { readonly required: true }
    ? never
    : CamelCase<FlagBody<Option["flag"]>>]?: OptionValue<Option>;
};

/** Parsed-options shape for one daemon action's CLI command. */
export type SessionCommandOptions<Action extends SessionDaemonAction> = ParsedCommandOptions<
  (typeof SESSION_AGENT_COMMANDS)[Action]
>;

/**
 * One declared flag-group rule on a command. The same object drives three surfaces: the
 * `(--a | --b)` synopsis fragment, the CLI validator, and the error message agents see — so a
 * flag rename or group change propagates everywhere from this one declaration.
 */
export type AgentCommandConstraint =
  | {
      readonly kind: "exactly-one";
      /** Names the choice in the error message, e.g. "navigation target". */
      readonly label: string;
      /** Optional context shown in generated docs when this rule applies to one command mode. */
      readonly documentationScope?: string;
      readonly flags: readonly string[];
    }
  | {
      readonly kind: "at-most-one";
      /** Optional context shown in generated docs when this rule applies to one command mode. */
      readonly documentationScope?: string;
      readonly flags: readonly string[];
    };

/** Render one constraint as its synopsis fragment, e.g. `(--hunk <n> | --old-line <n>)`. */
export function constraintSynopsis(constraint: AgentCommandConstraint) {
  return `(${constraint.flags.join(" | ")})`;
}

/** Camelize one flag definition into the key Commander stores its parsed value under. */
export function optionKeyFromFlag(flag: string) {
  const body = flag.split(" ")[0]!.replace(/^--/, "");
  return body.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Options owned by non-session commands (`hunk diff`, `hunk markup render`, shared review flags)
 * that agent-facing docs also reference. `packages/hunk/src/app/cli.ts` registers them from these constants,
 * so the docs' flag-consistency tests verify real parser flags instead of a hand-kept allowlist.
 */
export const AUXILIARY_AGENT_OPTIONS = {
  agentContext: {
    flag: "--agent-context <path>",
    description: "JSON sidecar with agent rationale",
  },
  excludeUntracked: {
    flag: "--exclude-untracked",
    description: "exclude untracked files from working tree reviews",
  },
  experimental: {
    flag: "--experimental",
    description: "enable experimental features (currently STML agent-note markup)",
  },
  markupWidth: {
    flag: "--width <n>",
    description: "layout width in columns",
  },
} as const satisfies Record<string, AgentCommandOption>;

/** Selector notation shared by every synopsis line that targets one live session. */
export const SESSION_SELECTOR_SYNOPSIS = "(<session-id> | --repo <path>)";

/** Reload additionally accepts `--session-path` as a selector. */
export const RELOAD_SELECTOR_SYNOPSIS = "(<session-id> | --repo <path> | --session-path <path>)";

/** Absolute navigation targets: callers must pass exactly one. */
export const NAVIGATE_TARGET_CONSTRAINT = {
  kind: "exactly-one",
  label: "navigation target",
  documentationScope: "for `--file` navigation",
  flags: ["--hunk <n>", "--old-line <n>", "--new-line <n>"],
} as const satisfies AgentCommandConstraint;

/** Comment anchoring targets: callers must pass exactly one. */
export const COMMENT_TARGET_CONSTRAINT = {
  kind: "exactly-one",
  label: "comment target",
  flags: ["--old-line <n>", "--new-line <n>"],
} as const satisfies AgentCommandConstraint;

/** Highlight anchoring targets: callers must pass exactly one. */
export const HIGHLIGHT_TARGET_CONSTRAINT = {
  kind: "exactly-one",
  label: "highlight target",
  flags: ["--old-line <n>", "--new-line <n>"],
} as const satisfies AgentCommandConstraint;

/** The six-tone vocabulary highlight marks share with extension line highlighters. */
export const HIGHLIGHT_TONES = ["match", "current", "info", "warning", "error", "dim"] as const;

export type HighlightTone = (typeof HIGHLIGHT_TONES)[number];

/** Check one CLI-provided tone value against the shared six-tone vocabulary. */
export function isHighlightTone(value: string): value is HighlightTone {
  return (HIGHLIGHT_TONES as readonly string[]).includes(value);
}

/** Relative comment navigation directions: callers may pass at most one. */
export const COMMENT_DIRECTION_CONSTRAINT = {
  kind: "at-most-one",
  flags: ["--next-comment", "--prev-comment"],
} as const satisfies AgentCommandConstraint;

const repoOption = {
  flag: "--repo <path>",
  description: "target the live session whose repo root matches this path",
} as const satisfies AgentCommandOption;

const jsonOption = {
  flag: "--json",
  description: "emit structured JSON",
} as const satisfies AgentCommandOption;

const diffFileOption = {
  flag: "--file <path>",
  description: "diff file path as shown by Hunk",
} as const satisfies AgentCommandOption;

const oldLineOption = {
  flag: "--old-line <n>",
  description: "1-based line number on the old side",
  parse: "positiveInt",
} as const satisfies AgentCommandOption;

const newLineOption = {
  flag: "--new-line <n>",
  description: "1-based line number on the new side",
  parse: "positiveInt",
} as const satisfies AgentCommandOption;

/**
 * Every live-session daemon action, described as one CLI command. `satisfies` keeps this map in
 * lockstep with the daemon protocol: adding a `SessionDaemonAction` without describing its CLI
 * surface here is a compile error, so the generated docs always cover the full surface.
 */
export const SESSION_AGENT_COMMANDS = {
  list: {
    name: "session list",
    summary: "list live Hunk sessions",
    positionals: [],
    options: [jsonOption],
    synopsis: ["hunk session list [--json]"],
  },
  get: {
    name: "session get",
    summary: "show one live Hunk session",
    positionals: [{ token: "[sessionId]" }],
    options: [repoOption, jsonOption],
    synopsis: [`hunk session get ${SESSION_SELECTOR_SYNOPSIS} [--json]`],
  },
  context: {
    name: "session context",
    summary: "show the selected file and hunk for one live Hunk session",
    positionals: [{ token: "[sessionId]" }],
    options: [repoOption, jsonOption],
    synopsis: [`hunk session context ${SESSION_SELECTOR_SYNOPSIS} [--json]`],
  },
  review: {
    name: "session review",
    summary: "export the live review model for one Hunk session",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      {
        flag: "--include-patch",
        description: "include raw unified diff text for each file in review output",
      },
      {
        flag: "--include-notes",
        description: "include live review notes in review output",
      },
      jsonOption,
    ],
    synopsis: [
      `hunk session review ${SESSION_SELECTOR_SYNOPSIS} [--include-patch] [--include-notes] [--json]`,
    ],
  },
  navigate: {
    name: "session navigate",
    summary: "move a live Hunk session to one diff hunk",
    positionals: [{ token: "[sessionId]" }],
    options: [
      diffFileOption,
      repoOption,
      {
        flag: "--hunk <n>",
        description: "1-based hunk number within the file",
        parse: "positiveInt",
      },
      oldLineOption,
      newLineOption,
      { flag: "--comment <id>", description: "jump to the live comment with this id" },
      { flag: "--next-comment", description: "jump to the next annotated hunk" },
      { flag: "--prev-comment", description: "jump to the previous annotated hunk" },
      jsonOption,
    ],
    constraints: [NAVIGATE_TARGET_CONSTRAINT, COMMENT_DIRECTION_CONSTRAINT],
    synopsis: [
      `hunk session navigate ${SESSION_SELECTOR_SYNOPSIS} --file <path> ${constraintSynopsis(NAVIGATE_TARGET_CONSTRAINT)} [--json]`,
      `hunk session navigate ${SESSION_SELECTOR_SYNOPSIS} --comment <id> [--json]`,
      `hunk session navigate ${SESSION_SELECTOR_SYNOPSIS} ${constraintSynopsis(COMMENT_DIRECTION_CONSTRAINT)} [--json]`,
    ],
    examples: [
      "hunk session navigate --repo . --file src/App.tsx --hunk 2",
      "hunk session navigate --repo . --file src/App.tsx --new-line 372",
      "hunk session navigate --repo . --file src/App.tsx --old-line 355",
      "hunk session navigate --repo . --comment comment-1",
      "hunk session navigate --repo . --next-comment",
      "hunk session navigate --repo . --prev-comment",
    ],
  },
  reload: {
    name: "session reload",
    summary: "replace the contents of one live Hunk session",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      {
        flag: "--session-path <path>",
        description: "target a live session rooted at a different path",
      },
      {
        flag: "--source <path>",
        description: "load the diff from this directory instead of the session's own",
      },
      jsonOption,
    ],
    synopsis: [
      `hunk session reload ${RELOAD_SELECTOR_SYNOPSIS} [--source <path>] [--json] -- diff [ref] [-- <pathspec...>]`,
      `hunk session reload ${RELOAD_SELECTOR_SYNOPSIS} [--source <path>] [--json] -- show [ref] [-- <pathspec...>]`,
    ],
    examples: [
      "hunk session reload --repo . -- diff",
      "hunk session reload --repo . -- diff main...feature -- src/ui",
      "hunk session reload --repo . -- show HEAD~1",
      "hunk session reload --repo . -- show HEAD~1 -- README.md",
      "hunk session reload --repo /path/to/worktree -- diff",
      "hunk session reload --session-path /path/to/live-window --source /path/to/other-checkout -- diff",
    ],
  },
  "comment-add": {
    name: "session comment add",
    summary: "attach one live inline review note",
    positionals: [{ token: "[sessionId]" }],
    options: [
      { ...diffFileOption, required: true },
      { flag: "--summary <text>", description: "short review note", required: true },
      repoOption,
      oldLineOption,
      newLineOption,
      { flag: "--rationale <text>", description: "optional longer explanation" },
      {
        flag: "--markup <stml>",
        description: "experimental STML body (target session must opt in)",
      },
      { flag: "--author <name>", description: "optional author label" },
      { flag: "--focus", description: "add the note and focus the viewport on it" },
      jsonOption,
    ],
    constraints: [COMMENT_TARGET_CONSTRAINT],
    synopsis: [
      `hunk session comment add ${SESSION_SELECTOR_SYNOPSIS} --file <path> ${constraintSynopsis(COMMENT_TARGET_CONSTRAINT)} --summary <text> [--rationale <text>] [--author <name>] [--markup <stml>] [--focus] [--json]`,
    ],
    examples: [
      'hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording"',
    ],
  },
  "comment-apply": {
    name: "session comment apply",
    summary: "apply many live inline review notes from stdin JSON",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      { flag: "--stdin", description: "read the comment batch from stdin as JSON" },
      { flag: "--focus", description: "apply the batch and focus the first note" },
      jsonOption,
    ],
    synopsis: [
      `hunk session comment apply ${SESSION_SELECTOR_SYNOPSIS} --stdin [--focus] [--json]`,
    ],
    examples: [
      `printf '%s\\n' '{"comments":[{"filePath":"README.md","newLine":103,"summary":"Tighten this wording"}]}' | hunk session comment apply --repo . --stdin`,
    ],
    helpExtra: [
      "Stdin JSON shape:",
      "  {",
      '    "comments": [',
      "      {",
      '        "filePath": "README.md",',
      '        "hunk": 2,',
      '        "summary": "Explain this hunk",',
      '        "rationale": "Optional detail",',
      '        "author": "Pi"',
      "      }",
      "    ]",
      "  }",
    ],
  },
  "comment-list": {
    name: "session comment list",
    summary: "list live inline review notes",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      { flag: "--file <path>", description: "filter comments to one diff file" },
      { flag: "--type <type>", description: "filter to live, all, ai, agent, or user comments" },
      jsonOption,
    ],
    synopsis: [
      `hunk session comment list ${SESSION_SELECTOR_SYNOPSIS} [--file <path>] [--type <live|all|ai|agent|user>] [--json]`,
    ],
  },
  "comment-rm": {
    name: "session comment rm",
    summary: "remove one inline review note",
    positionals: [
      {
        token: "[targets...]",
        description: "<session-id> <comment-id>, or <comment-id> with --repo",
      },
    ],
    options: [repoOption, jsonOption],
    synopsis: [`hunk session comment rm ${SESSION_SELECTOR_SYNOPSIS} <comment-id> [--json]`],
  },
  "comment-clear": {
    name: "session comment clear",
    summary: "clear inline review notes",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      { flag: "--file <path>", description: "clear only one diff file's comments" },
      {
        flag: "--include-user",
        description: "also clear human notes created with the TUI `c` action",
      },
      { flag: "--all", description: "clear both live agent comments and human user notes" },
      { flag: "--yes", description: "confirm destructive comment clearing" },
      jsonOption,
    ],
    synopsis: [
      `hunk session comment clear ${SESSION_SELECTOR_SYNOPSIS} [--file <path>] [--include-user|--all] --yes [--json]`,
    ],
  },
  "highlight-add": {
    name: "session highlight add",
    summary: "paint one attention mark inside a diff line",
    positionals: [{ token: "[sessionId]" }],
    options: [
      { ...diffFileOption, required: true },
      {
        flag: "--start <n>",
        description: "0-based inclusive start offset into the line's text (UTF-16 code units)",
        parse: "nonNegativeInt",
        required: true,
      },
      {
        flag: "--end <n>",
        description: "exclusive end offset; must be greater than --start",
        parse: "positiveInt",
        required: true,
      },
      repoOption,
      oldLineOption,
      newLineOption,
      {
        flag: "--tone <tone>",
        description: `mark tone: ${HIGHLIGHT_TONES.join(", ")} (default match)`,
      },
      { flag: "--focus", description: "add the mark and land the viewport on its line" },
      jsonOption,
    ],
    constraints: [HIGHLIGHT_TARGET_CONSTRAINT],
    synopsis: [
      `hunk session highlight add ${SESSION_SELECTOR_SYNOPSIS} --file <path> ${constraintSynopsis(HIGHLIGHT_TARGET_CONSTRAINT)} --start <n> --end <n> [--tone <tone>] [--focus] [--json]`,
    ],
    examples: [
      "hunk session highlight add --repo . --file src/App.tsx --new-line 42 --start 6 --end 19",
      "hunk session highlight add --repo . --file src/App.tsx --new-line 42 --start 6 --end 19 --tone warning --focus",
    ],
  },
  "highlight-clear": {
    name: "session highlight clear",
    summary: "clear agent attention marks",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      { flag: "--file <path>", description: "clear only one diff file's marks" },
      jsonOption,
    ],
    synopsis: [
      `hunk session highlight clear ${SESSION_SELECTOR_SYNOPSIS} [--file <path>] [--json]`,
    ],
    examples: ["hunk session highlight clear --repo ."],
  },
} as const satisfies Record<SessionDaemonAction, AgentCommandSpec>;

/** Specs in display order for help text and generated docs. */
export const SESSION_AGENT_COMMAND_LIST: readonly AgentCommandSpec[] =
  Object.values(SESSION_AGENT_COMMANDS);

/** Specs for the `hunk session comment` subcommand family, in display order. */
export const SESSION_COMMENT_COMMAND_LIST = SESSION_AGENT_COMMAND_LIST.filter((spec) =>
  spec.name.startsWith("session comment "),
);

/** Specs for the `hunk session highlight` subcommand family, in display order. */
export const SESSION_HIGHLIGHT_COMMAND_LIST = SESSION_AGENT_COMMAND_LIST.filter((spec) =>
  spec.name.startsWith("session highlight "),
);

/** Extract the flag name (e.g. `--old-line`) from a Commander flag definition. */
export function agentOptionFlagName(option: AgentCommandOption) {
  return option.flag.split(" ")[0]!;
}

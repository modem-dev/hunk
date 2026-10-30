/**
 * Describes the `hunk gh` command surface as structured metadata and renders its `--help` text.
 * The command registration, every `--help` screen, and the generated website CLI reference read
 * this metadata, so a new form or option is documented everywhere by adding it once here.
 */

/** One accepted argument spelling for a GitHub subcommand. */
export interface GitHubCliForm {
  /** Arguments after `hunk gh <command>`; empty when the target is omitted entirely. */
  readonly args: string;
  /** Omitted for long spellings such as URLs whose meaning is self-evident. */
  readonly description?: string;
}

/** One `hunk gh` subcommand. */
export interface GitHubCliSubcommand {
  readonly name: "pr" | "commit" | "compare";
  /** Positional grammar between the subcommand name and the shared options. */
  readonly arguments: string;
  /** One-line summary shown in the `hunk gh --help` overview. */
  readonly summary: string;
  /** Lead sentence for the subcommand's own help and reference section. */
  readonly description: string;
  readonly formsHeading: string;
  readonly forms: readonly GitHubCliForm[];
  readonly notes?: readonly string[];
}

/** One option shared by every GitHub subcommand. */
export interface GitHubCliOption {
  readonly flag: string;
  readonly description: string;
}

/** Complete `hunk gh` command metadata. */
export interface GitHubCliReference {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly options: readonly GitHubCliOption[];
  readonly authentication: {
    /** Environment variables in lookup order. */
    readonly variables: readonly string[];
    readonly description: string;
  };
  readonly subcommands: readonly GitHubCliSubcommand[];
}

/** Describes `hunk gh` for its registration, `--help` screens, and the website CLI reference. */
export const GITHUB_CLI_REFERENCE: GitHubCliReference = {
  name: "gh",
  summary: "Review GitHub pull requests, commits, and comparisons",
  usage: "<pr|commit|compare> <target> [--repo <owner/repo>]",
  options: [
    {
      flag: "--repo <owner/repo>",
      description: "use an explicit repository instead of the local origin",
    },
    {
      flag: "-- <patch-options...>",
      description: "pass the remaining options to the `hunk patch` review",
    },
  ],
  authentication: {
    variables: ["GH_TOKEN", "GITHUB_TOKEN"],
    description: "optional for public repositories",
  },
  subcommands: [
    {
      name: "pr",
      arguments: "[pull-request]",
      summary: "Review a GitHub pull request; infer it from the current branch when omitted.",
      description: "Review a GitHub pull request without requiring the gh CLI.",
      formsHeading: "Pull request forms",
      forms: [
        { args: "", description: "find the open PR for the current branch" },
        { args: "123", description: "infer owner/repo from the local origin" },
        { args: "123 --repo modem-dev/hunk", description: "use an explicit repository" },
        { args: "'modem-dev/hunk#123'", description: "name the repository and pull request" },
        { args: "https://github.com/modem-dev/hunk/pull/123" },
      ],
    },
    {
      name: "commit",
      arguments: "<commit>",
      summary: "Review a GitHub commit without requiring the gh CLI.",
      description: "Review a GitHub commit without requiring the gh CLI.",
      formsHeading: "Commit forms",
      forms: [
        { args: "abcdef1", description: "infer owner/repo from the local origin" },
        { args: "abcdef1 --repo modem-dev/hunk", description: "use an explicit repository" },
        { args: "modem-dev/hunk@abcdef1", description: "name the repository and commit" },
        { args: "https://github.com/modem-dev/hunk/commit/abcdef1" },
      ],
    },
    {
      name: "compare",
      arguments: "<base>...<head>",
      summary: "Review the changes between two GitHub refs.",
      description: "Review the changes between two GitHub branches, tags, or commits.",
      formsHeading: "Compare forms",
      forms: [
        { args: "main...feature", description: "infer owner/repo from the local origin" },
        { args: "v0.20.0...v0.21.0 --repo modem-dev/hunk" },
      ],
      notes: ["Use three dots exactly. Pass Hunk patch options after `--`."],
    },
  ],
};

const HELP_TERM_WIDTH = 37;
const HELP_OPTION_WIDTH = 24;

/** Render one indented help row, aligning descriptions after short terms. */
function helpRow(term: string, description?: string, width = HELP_TERM_WIDTH) {
  if (!description) return `  ${term}`;
  return `  ${term.padEnd(width - 1)} ${description}`;
}

/** Render the shared GitHub authentication row. */
function authenticationHelp(reference: GitHubCliReference) {
  return [
    "Authentication:",
    helpRow(
      reference.authentication.variables.join(", then "),
      reference.authentication.description,
    ),
  ];
}

/** Format one subcommand's usage after `hunk gh`, including the shared options. */
export function formatGitHubSubcommandUsage(subcommand: GitHubCliSubcommand) {
  const options = GITHUB_CLI_REFERENCE.options.map((option) => `[${option.flag}]`);
  return [subcommand.name, subcommand.arguments, ...options].join(" ");
}

/** Render the `hunk gh --help` overview. */
function renderGitHubHelp(reference: GitHubCliReference) {
  return [
    "Usage: hunk gh <command>",
    "",
    "GitHub commands:",
    ...reference.subcommands.flatMap((subcommand) => [
      `  ${formatGitHubSubcommandUsage(subcommand)}`,
      `      ${subcommand.summary}`,
    ]),
    "",
    "Options:",
    ...reference.options.map((option) =>
      helpRow(option.flag, option.description, HELP_OPTION_WIDTH),
    ),
    "",
    ...authenticationHelp(reference),
    "",
    "Run `hunk gh <command> --help` for command-specific help.",
    "",
  ].join("\n");
}

/** Render `hunk gh <command> --help` for one subcommand. */
function renderGitHubSubcommandHelp(
  subcommand: GitHubCliSubcommand,
  reference: GitHubCliReference,
) {
  return [
    `Usage: hunk gh ${formatGitHubSubcommandUsage(subcommand)}`,
    "",
    subcommand.description,
    "",
    `${subcommand.formsHeading}:`,
    ...subcommand.forms.map((form) => helpRow(form.args || "(omitted)", form.description)),
    ...(subcommand.notes ? ["", ...subcommand.notes] : []),
    "",
    ...authenticationHelp(reference),
    "",
  ].join("\n");
}

/** Render one subcommand's help by name. */
function renderGitHubSubcommandHelpByName(name: GitHubCliSubcommand["name"]) {
  const subcommand = GITHUB_CLI_REFERENCE.subcommands.find((entry) => entry.name === name)!;
  return renderGitHubSubcommandHelp(subcommand, GITHUB_CLI_REFERENCE);
}

export const GITHUB_HELP = renderGitHubHelp(GITHUB_CLI_REFERENCE);
export const GITHUB_PR_HELP = renderGitHubSubcommandHelpByName("pr");
export const GITHUB_COMMIT_HELP = renderGitHubSubcommandHelpByName("commit");
export const GITHUB_COMPARE_HELP = renderGitHubSubcommandHelpByName("compare");

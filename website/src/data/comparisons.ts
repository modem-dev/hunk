import { BUNDLED_SHIKI_THEME_IDS } from "../../../packages/hunk/src/core/theme/catalog";
import { SITE_ORIGIN } from "../lib/site";

/**
 * Hand-authored comparisons between Hunk and the diff tools people already run.
 *
 * These pages answer a question a reader arrives with ("hunk vs delta"), so every
 * claim about another project has to survive that project's own documentation:
 * capability rows are marked from published behavior, notes carry the caveat when
 * a bare mark would mislead, and each page ends with the sources it was checked
 * against. Overstating a rival is the fastest way to lose the reader we came for.
 *
 * The HTML page, the `.md` variant agents read, and the hub's index all render
 * from these entries, so they stay plain data: prose is unformatted strings,
 * code samples are structured, and nothing here knows about markup.
 */

/** How completely a tool covers one capability. */
export type Support = "yes" | "partial" | "no";

/** One row of a head-to-head capability table. */
export interface CapabilityRow {
  capability: string;
  hunk: Support;
  rival: Support;
  /** One clause of context, required whenever a bare mark would mislead. */
  note?: string;
}

/** A prose section, optionally ending in a copyable command block. */
export interface ComparisonSection {
  heading: string;
  body: string[];
  code?: { caption?: string; lines: string[] };
}

export interface ComparisonFaq {
  question: string;
  answer: string;
}

export interface Comparison {
  /** URL segment under `/compare/`, written the way the query is typed. */
  slug: string;
  rival: {
    name: string;
    /** Short appositive used in prose, e.g. "a syntax-highlighting pager". */
    kind: string;
    url: string;
    language: string;
    license: string;
  };
  /** Page `<h1>`. */
  headline: string;
  /** `<title>`, which search results show instead of the h1. */
  title: string;
  description: string;
  keywords: string[];
  /** Card copy on the hub, and the list-item description in its ItemList schema. */
  summary: string;
  /**
   * The extractable answer. Answer engines quote the first paragraph under an
   * h1, so this has to stand alone: no "as shown above", no unresolved pronouns.
   */
  answer: string;
  pick: { hunk: string[]; rival: string[] };
  capabilities: CapabilityRow[];
  sections: ComparisonSection[];
  faqs: ComparisonFaq[];
  sources: { label: string; url: string }[];
}

/** The date these pages first went up. Publication dates do not move when claims are re-checked. */
export const COMPARISONS_PUBLISHED_ON = "2026-09-01";

/** The date the rival claims on these pages were last checked against their own docs. */
export const COMPARISONS_REVIEWED_ON = "2026-09-01";

/** Month and year of the last check, for the line every page shows above the fold. */
export function reviewedOnLabel(): string {
  return new Date(`${COMPARISONS_REVIEWED_ON}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Hunk's own side of the header sentence each table opens with.
 *
 * It is a claim about Hunk, so it belongs beside the rival facts in the catalog
 * rather than typed once per renderer.
 */
export const HUNK_FACTS = {
  language: "TypeScript",
  license: "MIT",
  platforms: "macOS, Linux, and Windows",
} as const;

/** Year the titles advertise, derived so it cannot go stale against the check date. */
const REVIEW_YEAR = COMPARISONS_REVIEWED_ON.slice(0, 4);

const THEME_COUNT = BUNDLED_SHIKI_THEME_IDS.length;

const HUNK_INSTALL = "curl -fsSL https://hunk.dev/install.sh | sh";

export const COMPARISONS: Comparison[] = [
  {
    slug: "hunk-vs-delta",
    rival: {
      name: "delta",
      kind: "a syntax-highlighting pager for Git",
      url: "https://github.com/dandavison/delta",
      language: "Rust",
      license: "MIT",
    },
    headline: "Hunk vs delta",
    title: `Hunk vs delta: pager or review UI? (${REVIEW_YEAR})`,
    description:
      "Hunk vs delta. delta restyles git diff output in your pager. Hunk turns the same changeset into a review UI. Capability table, setup for running both, and how to choose.",
    keywords: [
      "hunk vs delta",
      "delta alternative",
      "git delta",
      "terminal diff viewer",
      "git diff side by side",
    ],
    summary:
      "delta restyles the text Git already printed. Hunk turns the same changeset into a review UI. Most people keep both.",
    answer:
      "delta is a pager. It restyles the text `git diff` already printed and hands it to `less`. Hunk is a review UI. It turns the same changeset into one scrollable stream with a file sidebar, split and stack layouts, mouse support, watch mode, and agent notes beside the hunks they explain. Keep delta for everyday diffs. Open Hunk when you sit down to review.",
    pick: {
      hunk: [
        "You review whole changesets and want a sidebar and per-hunk navigation.",
        "You want to change layout, wrapping, or theme while reading, not in `.gitconfig`.",
        "You want more context around a hunk without re-running the diff.",
        "An agent wrote the change and you want its reasoning next to the code.",
        "You want the diff to reload as the working tree changes.",
      ],
      rival: [
        "You want every diff you print to look better, with no change to how you work.",
        "You want `git blame`, `git grep`, and `git log` styled too, not just diffs.",
        "You want the lowest startup cost on a diff you will glance at and close.",
        "You already tuned delta and you like reading in a pager.",
      ],
    },
    capabilities: [
      { capability: "Syntax highlighting", hunk: "yes", rival: "yes" },
      {
        capability: "Themes",
        hunk: "yes",
        rival: "yes",
        note: `Hunk ships ${THEME_COUNT} bundled themes and takes custom ones. delta pairs bat syntax themes with its own collection, browsable via \`delta --show-themes\`.`,
      },
      {
        capability: "Side-by-side / split view",
        hunk: "yes",
        rival: "yes",
        note: "delta opts in with `--side-by-side`. Hunk's `auto` layout picks split on wide terminals and stack on narrow ones.",
      },
      { capability: "Word-level highlighting inside a changed line", hunk: "yes", rival: "yes" },
      {
        capability: "Moved-line detection",
        hunk: "yes",
        rival: "yes",
        note: "Both build on Git's `--color-moved`. Hunk honors `diff.colorMoved` from your Git config.",
      },
      {
        capability: "File sidebar you can jump from",
        hunk: "yes",
        rival: "no",
        note: "delta emits a linear stream, so navigation is whatever your pager offers.",
      },
      {
        capability: "Hunk-by-hunk navigation across the whole changeset",
        hunk: "yes",
        rival: "partial",
        note: "With `delta.navigate` enabled, `n`/`N` jump the pager between files, and between commits in `log -p`. Hunk tracks a selected hunk that the rest of the UI reacts to.",
      },
      {
        capability: "Mouse: click, wheel, scrollbar, menus",
        hunk: "yes",
        rival: "partial",
        note: "delta leaves scrolling to your pager, which has no file list or clickable chrome.",
      },
      {
        capability: "Change layout, wrapping, and theme mid-review",
        hunk: "yes",
        rival: "no",
        note: "delta's options are fixed for the invocation, set in `.gitconfig` or on the command line.",
      },
      {
        capability: "Expand unchanged context in place",
        hunk: "yes",
        rival: "no",
        note: "More context around a delta hunk means re-running the diff with a larger `-U`.",
      },
      { capability: "Watch mode that reloads the review", hunk: "yes", rival: "no" },
      { capability: "Inline agent and human annotations on a hunk", hunk: "yes", rival: "no" },
      {
        capability: "Programmatic session control for coding agents",
        hunk: "yes",
        rival: "no",
        note: "`hunk session` lets an agent read and navigate the review you have open.",
      },
      { capability: "Works as a Git pager (`core.pager`)", hunk: "yes", rival: "yes" },
      { capability: "Works as a Git difftool", hunk: "yes", rival: "yes" },
      {
        capability: "Styles `git blame` and `git grep` output",
        hunk: "no",
        rival: "yes",
        note: "Hunk's pager mode opens the review UI for patches and falls back to a plain-text pager for everything else.",
      },
      {
        capability: "Native Jujutsu and Sapling support",
        hunk: "yes",
        rival: "partial",
        note: "delta works wherever a VCS lets you set a pager. Hunk detects jj and Sapling workspaces and takes native revsets.",
      },
      { capability: "TypeScript extension API", hunk: "yes", rival: "no" },
    ],
    sections: [
      {
        heading: "What delta is",
        body: [
          "delta is a pager. Git prints a unified diff and pipes it to whatever `core.pager` points at. delta sits in that pipe and rewrites the text on the way through. Two lines of `.gitconfig` and every diff you print looks better, including the ones inside `git add -p`, `git log -p`, and `git show`.",
          "It does the job well. Syntax highlighting with bat syntax themes plus its own theme collection, word-level highlighting inside changed lines, an opt-in side-by-side view with wrapping, line numbers, opt-in `n`/`N` navigation between files, hyperlinked commit hashes, and styled `git blame` and `git grep`. Written in Rust, MIT-licensed, with a `--help` that runs to about 110 options.",
          "What it does not do is hold a model of your changeset. It sees a stream of text and emits a prettier one. No file list, no selected hunk, no state that survives from one line to the next.",
        ],
      },
      {
        heading: "What Hunk does differently",
        body: [
          "Hunk parses the changeset into a document, then draws a UI over it. Every visible file becomes one continuous review stream, and the sidebar indexes that stream instead of hiding the rest of the change. `[` and `]` walk hunks across the whole changeset, `,` and `.` walk files, and the selection is real state that the sidebar, note cards, and context expansion all follow.",
          "Holding the model in memory makes things easy that a pager cannot do at all. Press `z` to expand unchanged context around a hunk without re-running the diff. Press `1`, `2`, or `0` for split, stack, or responsive layout. Press `w` for wrapping or `t` for another theme, mid-review. `hunk diff --watch` reloads as you keep editing.",
          "The part with no delta equivalent is agent context. An agent that wrote the change can attach its reasoning to specific hunks through `hunk session`, and Hunk renders those notes inline, next to the code, instead of in a pane you correlate by hand.",
        ],
      },
      {
        heading: "Use both",
        body: [
          "There is no conflict. delta is a good default pager, Hunk is a good review session. Leave delta configured and reach for Hunk deliberately.",
          "If you would rather have Git open Hunk for diffs too, point `core.pager` at `hunk pager`. Non-patch output still falls through to your normal text pager. Either way `hunk diff` is the native entry point, and it is the only one that can pull untracked files into the review.",
        ],
        code: {
          caption: "Keep delta as the pager, add Hunk as the review step",
          lines: [
            HUNK_INSTALL,
            "",
            "# delta stays exactly as you configured it",
            'git config --global core.pager "delta"',
            "",
            "# Hunk is what you open to review",
            "hunk diff          # working tree, including untracked files",
            "hunk show HEAD     # the last commit",
            "hunk diff --watch  # reload as you keep editing",
          ],
        },
      },
    ],
    faqs: [
      {
        question: "Can I use Hunk and delta at the same time?",
        answer:
          "Yes. They sit in different slots. delta goes in `core.pager` and styles everything Git prints. Hunk is a command you run, `hunk diff` or `hunk show`, when you want to review. Nothing has to be uninstalled.",
      },
      {
        question: "Is Hunk a drop-in replacement for delta?",
        answer:
          "Not quite. `hunk pager` covers the diff half: set it as `core.pager` and patch-like output opens in the review UI, while everything else falls through to your plain-text pager. Hunk does not style `git blame` or `git grep`, so keep delta if that output matters to you.",
      },
      {
        question: "Does Hunk support side-by-side diffs like `delta --side-by-side`?",
        answer:
          "Yes, and it is the default on wide terminals. Hunk's `auto` layout picks split on wide terminals and stack on narrow ones. `1` forces split and `2` forces stack, at any point in the review.",
      },
      {
        question: "Which is faster, Hunk or delta?",
        answer:
          "delta starts faster, and that is structural: it is a Rust stream filter doing one pass over text. Hunk builds a review model and mounts a terminal UI, which costs more up front and buys navigation, state, and annotations. The experimental `hunk --fast` offloads eligible syntax highlighting to cut that cost.",
      },
      {
        question: "Does Hunk need configuration to be useful?",
        answer:
          "No. `hunk diff` works with no config file. You can save preferences on quit, and a repository can carry its own `.hunk/config.toml`, but none of that is required to start.",
      },
    ],
    sources: [
      { label: "delta, GitHub repository", url: "https://github.com/dandavison/delta" },
      {
        label: "delta manual: side-by-side view",
        url: "https://dandavison.github.io/delta/side-by-side-view.html",
      },
      { label: "Hunk: Git pager and difftool", url: "/docs/workflows/git-pager-and-difftool/" },
      { label: "Hunk: keyboard and mouse", url: "/docs/start/keyboard-and-mouse/" },
    ],
  },
  {
    slug: "hunk-vs-difftastic",
    rival: {
      name: "difftastic",
      kind: "a structural diff tool",
      url: "https://github.com/Wilfred/difftastic",
      language: "Rust",
      license: "MIT",
    },
    headline: "Hunk vs difftastic",
    title: `Hunk vs difftastic: structural diff or review UI? (${REVIEW_YEAR})`,
    description:
      "Hunk vs difftastic. difftastic changes what the diff says by parsing your code with tree-sitter. Hunk changes how you read a changeset. What each is for, and why they do not compose.",
    keywords: [
      "hunk vs difftastic",
      "difftastic alternative",
      "structural diff",
      "AST diff git",
      "difft",
    ],
    summary:
      "difftastic changes what the diff says. Hunk changes how you read the changeset. Different problems, both worth solving.",
    answer:
      "difftastic changes what the diff says. It parses both versions with tree-sitter and reports syntactic changes, so a reindent or a wrapped block stops reading as a rewrite. Hunk changes how you read a changeset: one multi-file stream, a file sidebar, split layouts, expandable context, agent notes. Hunk is line-based and does no AST diffing. difftastic has no review UI. They do not pipe into each other, so most people run difftastic as an external diff and review in Hunk.",
    pick: {
      hunk: [
        "You review changesets that span many files and want navigation, not a longer scroll.",
        "You want a diff you can drive with the mouse and reconfigure while reading it.",
        "An agent wrote the change and you want its notes anchored to hunks.",
        "You need patch input. `hunk patch -` reviews any unified diff from stdin.",
      ],
      rival: [
        "The change is a refactor and the line diff is lying about what moved.",
        "You want reformatting and wrapped blocks reported structurally.",
        "You work in one file at a time and a pager is enough.",
        "Your languages are among difftastic's tree-sitter parsers.",
      ],
    },
    capabilities: [
      {
        capability: "Structural / AST-aware diffing",
        hunk: "no",
        rival: "yes",
        note: "difftastic's whole reason to exist. Hunk is line-based with word-level highlighting inside changed lines.",
      },
      {
        capability: "Line-oriented unified diff",
        hunk: "yes",
        rival: "partial",
        note: "difftastic falls back to line-oriented diffing with word highlighting for files it cannot parse.",
      },
      {
        capability: "Interactive review UI",
        hunk: "yes",
        rival: "no",
        note: "difftastic prints to the terminal, so scrolling is your pager's job.",
      },
      { capability: "Multi-file review stream with a sidebar", hunk: "yes", rival: "no" },
      { capability: "Split and stack layouts switchable mid-review", hunk: "yes", rival: "no" },
      {
        capability: "Themes",
        hunk: "yes",
        rival: "partial",
        note: `Hunk ships ${THEME_COUNT} bundled themes and takes custom ones. difftastic has a light or dark background setting rather than a theme catalog.`,
      },
      { capability: "Mouse-driven navigation", hunk: "yes", rival: "no" },
      { capability: "Expand unchanged context in place", hunk: "yes", rival: "no" },
      { capability: "Watch mode that reloads the review", hunk: "yes", rival: "no" },
      { capability: "Inline agent and human annotations on a hunk", hunk: "yes", rival: "no" },
      {
        capability: "Reads a unified diff or patch from stdin",
        hunk: "yes",
        rival: "no",
        note: "`hunk patch -` reviews any patch. difftastic reads the two files, not a patch.",
      },
      {
        capability: "Output usable as a patch",
        hunk: "no",
        rival: "no",
        note: "Producing applicable patches is a stated difftastic non-goal, and Hunk is a viewer.",
      },
      {
        capability: "Insensitive to reordered elements",
        hunk: "no",
        rival: "no",
        note: "difftastic lists this as a non-goal. Reordering still shows as a change in both tools.",
      },
      {
        capability: "Git integration",
        hunk: "yes",
        rival: "yes",
        note: "difftastic goes in `GIT_EXTERNAL_DIFF` or `diff.external`. Hunk runs natively, as a pager, or as a difftool.",
      },
      {
        capability: "Native Jujutsu and Sapling support",
        hunk: "yes",
        rival: "partial",
        note: "difftastic works wherever a VCS accepts an external diff command. Hunk detects jj and Sapling workspaces and takes native revsets.",
      },
      { capability: "TypeScript extension API", hunk: "yes", rival: "no" },
    ],
    sections: [
      {
        heading: "What difftastic is",
        body: [
          "difftastic parses both versions of a file with tree-sitter and diffs the trees instead of the lines. The payoff shows up where line diffs are worst. Wrap a block in an `if`, reindent a function, move a closing brace, and difftastic reports the actual change instead of a wall of red and green.",
          "Its manual lists more than fifty programming languages plus ten structured text formats, and `difft --list-languages` prints what your build supports. It falls back to line-oriented diffing with word highlighting when it cannot parse a file, and it is written in Rust and usually wired in as Git's external diff.",
          "Its docs are clear about the limits. Producing applicable patches, merging, and ignoring reordered elements are stated non-goals, and the README lists under Known Issues that difftastic scales relatively poorly on files with a large number of changes and can use a lot of memory.",
        ],
        code: {
          caption: "The usual difftastic wiring",
          lines: [
            "# one command",
            "GIT_EXTERNAL_DIFF=difft git diff",
            "",
            "# or make it the default external diff",
            "git config --global diff.external difft",
            "# other subcommands then need --ext-diff:",
            "git show --ext-diff",
          ],
        },
      },
      {
        heading: "What Hunk is",
        body: [
          "Hunk is line-based and is not competing on diff algorithms. It changes the reading. Every visible file is one continuous review stream, the sidebar indexes that stream, `[` and `]` walk hunks across the whole changeset, and `z` expands unchanged context around the hunk you are on without re-running anything.",
          "It is a real terminal UI, not printed output, so layout, wrapping, line numbers, and theme all change while you read, the mouse works, and `hunk diff --watch` keeps the review current. If an agent produced the change, it can attach reasoning to specific hunks through `hunk session`, and those notes render inline beside the code.",
        ],
      },
      {
        heading: "They do not compose, and that is fine",
        body: [
          "You cannot pipe difftastic into Hunk. difftastic emits its own rendered output, or JSON with `--display json`, but never a unified diff, and Hunk's review stream is built from unified diffs. Setting `GIT_EXTERNAL_DIFF=difft` and then opening `hunk diff` does not stack the two. Hunk reads Git's own patch output.",
          "Not much is lost, because you reach for them at different moments. When one file's diff looks nonsensical after a reformat, run difftastic on that file. When you are reviewing a change across a dozen files, open Hunk.",
        ],
        code: {
          caption: "Both, at the moments each is good",
          lines: [
            HUNK_INSTALL,
            "",
            "# structure, for one confusing file",
            "GIT_EXTERNAL_DIFF=difft git diff -- src/parser.ts",
            "",
            "# review, for the whole changeset",
            "hunk diff",
          ],
        },
      },
    ],
    faqs: [
      {
        question: "Can I use difftastic as Hunk's diff engine?",
        answer:
          "No. Hunk builds its review stream from unified diffs, and difftastic's output is its own rendered display, or JSON, rather than a patch. Configure difftastic as a Git external diff for the files where structure matters, and use `hunk diff` to review the changeset.",
      },
      {
        question: "Does Hunk do structural or AST diffing?",
        answer:
          "No. Hunk highlights changes at word level within a line and honors Git's `--color-moved` for moved blocks, but it does not parse code into a syntax tree. If you need AST-level diffing, difftastic is the right tool.",
      },
      {
        question: "Which one handles a big refactor better?",
        answer:
          "Depends on the shape of it. For one file that was reformatted or rewrapped, difftastic tells you the truth faster. For a refactor spread across many files, Hunk's review stream plus `--color-moved` is the more workable read, because the problem is tracking thirty files rather than understanding one.",
      },
      {
        question: "Is difftastic slower than Hunk?",
        answer:
          "Hard to compare directly, since one is a diff algorithm and the other is a UI. What is documented is that difftastic's tree diffing gets expensive on files with many changes. Hunk's cost scales with rendering the changeset instead, and the experimental `hunk --fast` offloads eligible syntax highlighting.",
      },
    ],
    sources: [
      { label: "difftastic, GitHub repository", url: "https://github.com/Wilfred/difftastic" },
      { label: "Difftastic manual", url: "https://difftastic.wilfred.me.uk/" },
      { label: "Hunk: files and patches", url: "/docs/workflows/files-and-patches/" },
      { label: "Hunk: quick start", url: "/docs/start/quick-start/" },
    ],
  },
  {
    slug: "hunk-vs-diff-so-fancy",
    rival: {
      name: "diff-so-fancy",
      kind: "a Git diff prettifier",
      url: "https://github.com/so-fancy/diff-so-fancy",
      language: "Perl",
      license: "MIT",
    },
    headline: "Hunk vs diff-so-fancy",
    title: `Hunk vs diff-so-fancy: what switching gets you (${REVIEW_YEAR})`,
    description:
      "Hunk vs diff-so-fancy. diff-so-fancy tidies git diff headers and markers in your pager. Hunk is a review UI with a file sidebar, split layouts, and agent notes. Compared honestly.",
    keywords: [
      "hunk vs diff-so-fancy",
      "diff-so-fancy alternative",
      "diff so fancy",
      "better git diff output",
      "git diff readable",
    ],
    summary:
      "diff-so-fancy tidies Git's diff output. Hunk replaces the reading experience. The gap is bigger than it looks.",
    answer:
      "diff-so-fancy is a Perl script that tidies Git's diff output before your pager shows it: simpler file headers, `+` and `-` out of the gutter, colored empty lines, rulers between files. It adds no syntax highlighting and has no side-by-side view. Hunk is a review UI rather than a filter: a multi-file stream with a file sidebar, split and stack layouts, syntax highlighting, mouse support, watch mode, and inline agent annotations.",
    pick: {
      hunk: [
        "You want syntax highlighting, which diff-so-fancy does not do.",
        "You want a side-by-side view, which diff-so-fancy does not do.",
        "You review multi-file changesets and want a sidebar and hunk navigation.",
        "You want the diff to reload as you edit, or agent notes attached to hunks.",
      ],
      rival: [
        "You want minimal, familiar output and nothing more.",
        "You want a Perl script and its `lib/` in `$PATH`, with no binary to install.",
        "Your habits are built around `less` and you do not want a UI.",
      ],
    },
    capabilities: [
      {
        capability: "Syntax highlighting",
        hunk: "yes",
        rival: "no",
        note: "diff-so-fancy restyles diff structure. It does not color code by language.",
      },
      { capability: "Side-by-side / split view", hunk: "yes", rival: "no" },
      {
        capability: "Word-level highlighting inside a changed line",
        hunk: "yes",
        rival: "partial",
        note: "diff-so-fancy computes character-level emphasis with a bundled copy of Git's contrib/diff-highlight, colored through `color.diff-highlight.*`, rather than a token-level word diff.",
      },
      {
        capability: "Themes",
        hunk: "yes",
        rival: "partial",
        note: `Hunk ships ${THEME_COUNT} bundled themes and takes custom ones. diff-so-fancy takes its colors from your Git color settings.`,
      },
      { capability: "Cleaned-up file headers and gutter", hunk: "yes", rival: "yes" },
      { capability: "File sidebar you can jump from", hunk: "yes", rival: "no" },
      { capability: "Hunk-by-hunk navigation across the changeset", hunk: "yes", rival: "no" },
      { capability: "Mouse: click, wheel, scrollbar, menus", hunk: "yes", rival: "no" },
      { capability: "Change layout, wrapping, and theme mid-review", hunk: "yes", rival: "no" },
      { capability: "Expand unchanged context in place", hunk: "yes", rival: "no" },
      { capability: "Watch mode that reloads the review", hunk: "yes", rival: "no" },
      { capability: "Inline agent and human annotations on a hunk", hunk: "yes", rival: "no" },
      { capability: "Works as a Git pager (`core.pager`)", hunk: "yes", rival: "yes" },
      {
        capability: "Works in `git add -p`",
        hunk: "no",
        rival: "yes",
        note: "diff-so-fancy sets `interactive.diffFilter`. Hunk is a review viewer and does not filter interactive staging.",
      },
      {
        capability: "Runs with no language runtime installed",
        hunk: "partial",
        rival: "no",
        note: "diff-so-fancy needs Perl 5.14+. Hunk's script, Homebrew, mise, and Nix installs are standalone binaries; only the npm install needs Node.js 22+.",
      },
      {
        capability: "Native Jujutsu and Sapling support",
        hunk: "yes",
        rival: "partial",
        note: "diff-so-fancy works wherever a VCS lets you set a pager, and its docs show a Mercurial recipe. Hunk detects jj and Sapling workspaces and takes native revsets.",
      },
      { capability: "TypeScript extension API", hunk: "yes", rival: "no" },
    ],
    sections: [
      {
        heading: "What diff-so-fancy is",
        body: [
          "diff-so-fancy is a Perl script you drop in `$PATH`, alongside its `lib/` directory, and put in front of your pager. It takes Git's diff output and makes it more human. File headers collapse to a readable line, the leading `+` and `-` come out of the gutter so copied code stays copyable, empty lines get colored so added and removed blanks are visible, and a ruler separates files.",
          "It is deliberately small. No syntax highlighting, no side-by-side, no state. It is a text filter, and it has been one since 2015. It also covers `git add -p` through `interactive.diffFilter`, which Hunk does not replicate.",
        ],
        code: {
          caption: "The standard diff-so-fancy setup",
          lines: [
            'git config --global core.pager "diff-so-fancy | less --tabs=4 -RF"',
            'git config --global interactive.diffFilter "diff-so-fancy --patch"',
          ],
        },
      },
      {
        heading: "What you get by moving to Hunk",
        body: [
          "The two usual reasons people leave are the two things diff-so-fancy does not do: syntax highlighting and side-by-side. Hunk has both, with a responsive `auto` layout that picks split on wide terminals and stack on narrow ones, plus theme selection you change from inside the review.",
          "Past that it is a different category of tool. Every visible file forms one review stream with a sidebar indexing it, `[` and `]` walk hunks across the whole changeset, `z` expands unchanged context without re-running the diff, and the mouse works for scrolling, menus, and jumping to a file. `hunk diff --watch` keeps the review current while you edit, and agent notes render inline beside the hunks they explain.",
          "The trade is real. Hunk is a bigger program than a Perl script, and it takes over the screen instead of printing into your scrollback. If tidy output in `less` is what you want, diff-so-fancy is still fine.",
        ],
        code: {
          caption: "Try it without changing your Git config",
          lines: [
            HUNK_INSTALL,
            "",
            "hunk diff        # working tree, including untracked files",
            "hunk show HEAD   # the last commit",
          ],
        },
      },
    ],
    faqs: [
      {
        question: "Does diff-so-fancy have syntax highlighting?",
        answer:
          "No. It restyles the structure of Git's diff output, meaning headers, markers, empty lines, and rulers, but it does not color code by language. That is a common reason people move to a tool that does.",
      },
      {
        question: "Does diff-so-fancy have a side-by-side view?",
        answer:
          "No. Its output is a single column. Hunk's split layout is side-by-side and is the default on wide terminals.",
      },
      {
        question: "Is diff-so-fancy still maintained?",
        answer:
          "Yes. Commits continue through 2026, though tagged releases are infrequent: the last was v1.4.12 in August 2024. It is a mature script doing a fixed job, which is part of why it is still in so many dotfiles.",
      },
      {
        question: "Can I keep diff-so-fancy and add Hunk?",
        answer:
          "Yes. Leave `core.pager` pointed at diff-so-fancy and run `hunk diff` when you want to review. If you would rather have Git open Hunk for diff output, set `core.pager` to `hunk pager` instead. Non-patch output still falls through to your plain-text pager.",
      },
    ],
    sources: [
      {
        label: "diff-so-fancy, GitHub repository",
        url: "https://github.com/so-fancy/diff-so-fancy",
      },
      { label: "Hunk: Git pager and difftool", url: "/docs/workflows/git-pager-and-difftool/" },
      { label: "Hunk: layout and display", url: "/docs/configure/layout-and-display/" },
    ],
  },
  {
    slug: "hunk-vs-git-diff",
    rival: {
      name: "git diff",
      kind: "Git's built-in diff command",
      url: "https://git-scm.com/docs/git-diff",
      language: "C",
      license: "GPL-2.0",
    },
    headline: "Hunk vs git diff",
    title: `Hunk vs git diff: a better way to read a changeset (${REVIEW_YEAR})`,
    description:
      "Hunk vs git diff. git diff prints a unified patch. Hunk renders the same data as a navigable review UI with a file sidebar, split view, and agent notes. What changes, and what does not.",
    keywords: [
      "hunk vs git diff",
      "better git diff",
      "git diff side by side terminal",
      "git diff tool",
      "how to read git diff",
    ],
    summary:
      "git diff prints the patch. Hunk renders the same patch as something you can navigate. Git stays the source of truth.",
    answer:
      "`git diff` prints a unified patch to standard output. One long stream, one file after another, with no navigation past your pager's search. Hunk reads the same data and draws a review UI: one multi-file stream, a file sidebar, split or stacked layouts, syntax highlighting, mouse support, expandable context, watch mode, and agent annotations on hunks. Git still computes the diff. Hunk replaces the reading. Run `hunk diff` where you would run `git diff`, or point `core.pager` at `hunk pager`.",
    pick: {
      hunk: [
        "The changeset spans more than a couple of files and scrolling stopped working as navigation.",
        "You want side-by-side, syntax highlighting, and a file list without configuring anything.",
        "You want more context around one hunk without re-running the command with `-U`.",
        "An agent wrote the change and you want its reasoning beside the code.",
      ],
      rival: [
        "You are scripting, piping, or generating a patch to apply somewhere else.",
        "You want the exact bytes Git produces, with no renderer in between.",
        "You are on a machine where installing anything is not an option.",
        "The change is two lines and you already know what they are.",
      ],
    },
    capabilities: [
      {
        capability: "Produces the diff",
        hunk: "no",
        rival: "yes",
        note: "Hunk runs Git underneath. Git is still the thing that computes the changeset.",
      },
      {
        capability: "Output usable as a patch",
        hunk: "no",
        rival: "yes",
        note: "`git diff` is what you pipe into `git apply`. Hunk is a viewer.",
      },
      { capability: "Syntax highlighting", hunk: "yes", rival: "no" },
      {
        capability: "Side-by-side / split view",
        hunk: "yes",
        rival: "no",
        note: "`git diff` has no split view. `git difftool` shells out to another program for one.",
      },
      {
        capability: "Themes",
        hunk: "yes",
        rival: "partial",
        note: `Hunk ships ${THEME_COUNT} bundled themes and takes custom ones. Git has \`color.diff.*\` settings rather than themes.`,
      },
      {
        capability: "Word-level highlighting inside a changed line",
        hunk: "yes",
        rival: "partial",
        note: "Git has `--word-diff` and `--color-words`, opt-in per invocation. Hunk highlights word-level changes by default.",
      },
      { capability: "File sidebar you can jump from", hunk: "yes", rival: "no" },
      { capability: "Hunk-by-hunk navigation across the changeset", hunk: "yes", rival: "no" },
      { capability: "Mouse: click, wheel, scrollbar, menus", hunk: "yes", rival: "no" },
      { capability: "Change layout, wrapping, and theme mid-review", hunk: "yes", rival: "no" },
      {
        capability: "Expand unchanged context in place",
        hunk: "yes",
        rival: "no",
        note: "In Git, more context means re-running with a larger `-U`.",
      },
      {
        capability: "Shows untracked files in the review",
        hunk: "yes",
        rival: "no",
        note: "`hunk diff` pulls untracked files into the changeset. `git diff` omits them.",
      },
      { capability: "Watch mode that reloads the review", hunk: "yes", rival: "no" },
      { capability: "Inline agent and human annotations on a hunk", hunk: "yes", rival: "no" },
      {
        capability: "Moved-line detection",
        hunk: "yes",
        rival: "yes",
        note: "Both use Git's `--color-moved`. Hunk honors `diff.colorMoved` from your Git config.",
      },
      {
        capability: "Scriptable, pipeable output",
        hunk: "partial",
        rival: "yes",
        note: "Hunk is interactive. `hunk session review --json` is its machine-readable surface, aimed at agents rather than shell pipelines.",
      },
      { capability: "Available everywhere with no install", hunk: "no", rival: "yes" },
      { capability: "Native Jujutsu and Sapling support", hunk: "yes", rival: "no" },
    ],
    sections: [
      {
        heading: "What `git diff` gives you",
        body: [
          "`git diff` is not a bad tool. It is a precise one aimed at a different job. It computes a changeset and writes a unified patch to standard output, and that output is the interchange format of the whole ecosystem. `git apply` consumes it, review systems parse it, and every diff viewer including Hunk is ultimately rendering it.",
          "It does not try to be a reading interface. No syntax highlighting, no side-by-side, no file list, no sense of where you are. Once a changeset gets past a few files your only navigation is your pager's search, and the usual workaround is re-running the command with narrower paths until the output fits on a screen.",
        ],
      },
      {
        heading: "What Hunk changes",
        body: [
          "Hunk runs Git underneath and renders the result as a UI. Every visible file becomes one continuous review stream and the sidebar indexes it, so selecting a file jumps you there without hiding the rest of the change. `[` and `]` move hunk by hunk across the changeset, `,` and `.` move file by file, and `z` expands unchanged context without re-running anything.",
          "Layout, line numbers, wrapping, and theme all change while you read. The mouse works: click a file, use the wheel or scrollbar, open menus. `hunk diff` also includes untracked files, which `git diff` leaves out and which is a routine source of confusion about files you know you wrote.",
          "The rest is agents. When one produced the change, it can attach reasoning to specific hunks via `hunk session`, and Hunk renders those notes inline beside the code instead of in a chat window you read separately.",
        ],
        code: {
          caption: "Three ways to reach it",
          lines: [
            HUNK_INSTALL,
            "",
            "# 1. directly, where you would have typed git diff",
            "hunk diff",
            "hunk show HEAD~1",
            "",
            "# 2. as an opt-in Git alias",
            "git config --global alias.hdiff '-c core.pager=\"hunk pager\" diff'",
            "git hdiff",
            "",
            "# 3. from any patch at all",
            "git diff --no-color | hunk patch -",
          ],
        },
      },
      {
        heading: "What stays the same",
        body: [
          "Git is still the source of truth. Hunk does not reimplement diffing, does not change what counts as a change, and does not modify your files or Git state. It reads what Git reports and draws it. Rename detection, `--color-moved`, and path filtering all still come from Git, and `hunk show HEAD~1 -- src/ui README.md` filters the way you would expect.",
          "It also takes nothing away. `git diff` keeps working, scripts that parse it keep working, and an alias gives you Hunk only when you want it, without changing your default pager.",
        ],
      },
    ],
    faqs: [
      {
        question: "Does Hunk replace git diff?",
        answer:
          "No. Hunk runs Git underneath and renders its output. `git diff` works exactly as before, and it is still the right tool for scripting, piping, and generating patches to apply.",
      },
      {
        question: "How do I get a side-by-side git diff in the terminal?",
        answer:
          "`git diff` has no side-by-side mode. Run `hunk diff` instead, where split view is the default on wide terminals, or configure a difftool. Press `1` for split, `2` for stack, and `0` for the responsive layout at any point.",
      },
      {
        question: "Can I make `git diff` itself open Hunk?",
        answer:
          "Yes. Set `core.pager` to `hunk pager` and patch-like output opens in the review UI, while everything else falls through to your plain-text pager. To keep your current pager, add an alias instead: `git config --global alias.hdiff '-c core.pager=\"hunk pager\" diff'`.",
      },
      {
        question: "Why does `hunk diff` show files that `git diff` does not?",
        answer:
          "It includes untracked files by default, which is usually what you want when reviewing your own work in progress. Pass `--exclude-untracked` to match Git's behavior.",
      },
      {
        question: "What about GNU diff, the one that is not part of Git?",
        answer:
          "GNU `diff` compares two files or directories outside version control. The closest Hunk equivalent is `hunk diff --files before.ts after.ts`, which opens the same review UI on a pair of files and can watch both for changes.",
      },
    ],
    sources: [
      { label: "git-diff, Git documentation", url: "https://git-scm.com/docs/git-diff" },
      {
        label: "Hunk: working trees and commits",
        url: "/docs/workflows/working-trees-and-commits/",
      },
      { label: "Hunk: Git pager and difftool", url: "/docs/workflows/git-pager-and-difftool/" },
    ],
  },
  {
    slug: "hunk-vs-plannotator",
    rival: {
      name: "Plannotator",
      kind: "a browser-based review surface for coding agents",
      url: "https://github.com/backnotprop/plannotator",
      language: "TypeScript",
      license: "Apache-2.0 or MIT",
    },
    headline: "Hunk vs Plannotator",
    title: `Hunk vs Plannotator: terminal or browser review (${REVIEW_YEAR})`,
    description:
      "Hunk vs Plannotator. Two review surfaces built for coding-agent output. Plannotator reviews plans and diffs in your browser. Hunk keeps the review in the terminal. Where each fits.",
    keywords: [
      "hunk vs plannotator",
      "plannotator alternative",
      "review AI generated code",
      "claude code diff review",
      "coding agent code review tool",
    ],
    summary:
      "Both exist because agents write more code than you can read. Plannotator reviews it in the browser and covers plans. Hunk stays in the terminal.",
    answer:
      "Both tools exist because a coding agent writes more code than you can comfortably read, and they answer it in different places. Plannotator runs a local server and opens the review in your browser. It also covers agent plans before any code exists, plus GitHub pull requests and GitLab merge requests by URL. Hunk keeps the review in the terminal next to the agent that wrote the change, with its reasoning rendered beside the hunks it explains. Pick by where you want to be reading.",
    pick: {
      hunk: [
        "You want to stay in the terminal, including over SSH or in a remote tmux with no browser.",
        "You want the agent's reasoning rendered in the diff, attached to specific hunks.",
        "You want the agent to read and navigate the review session you have open.",
        "You also want a general diff viewer for ordinary Git work, pager and difftool included.",
      ],
      rival: [
        "You want to review the agent's plan before it writes any code.",
        "You prefer a browser UI, with wider text, images, and rendered Markdown.",
        "You want to review a GitHub PR or GitLab MR by pasting its URL.",
        "You want AI reviews built into the tool, posting comments on the diff for you.",
        "You work in Perforce or GitButler.",
      ],
    },
    capabilities: [
      {
        capability: "Reviews agent plans before implementation",
        hunk: "no",
        rival: "yes",
        note: "Plan review is what Plannotator leads with. Hunk starts once there is a diff.",
      },
      { capability: "Reviews local code changes as a diff", hunk: "yes", rival: "yes" },
      {
        capability: "Terminal-native UI",
        hunk: "yes",
        rival: "partial",
        note: "Plannotator is browser-first. A separate terminal annotator ships as a Herdr plugin and as a standalone TUI, for documents rather than diffs.",
      },
      {
        capability: "Browser UI",
        hunk: "no",
        rival: "yes",
        note: "Hunk's review surface is a terminal UI.",
      },
      {
        capability: "Works with no browser available",
        hunk: "yes",
        rival: "no",
        note: "Plannotator opens a local server and a browser tab to reach it.",
      },
      { capability: "Line-level comments returned to the agent", hunk: "yes", rival: "yes" },
      {
        capability: "Built-in AI review that posts its own comments",
        hunk: "no",
        rival: "yes",
        note: "Plannotator can launch AI reviews that comment on the diff and answer questions about it. Hunk relies on the agent you already have.",
      },
      {
        capability: "Agent can read and drive the live review session",
        hunk: "yes",
        rival: "partial",
        note: "Plannotator exposes WebMCP tools on its plan and annotate surfaces to a WebMCP-capable browser, not on its diff review. Hunk's `hunk session` works from any shell against the diff review itself.",
      },
      {
        capability: "Reviews a GitHub PR or GitLab MR by URL",
        hunk: "no",
        rival: "yes",
        note: "Hunk reviews local working trees, commits, patches, and file pairs.",
      },
      { capability: "Git", hunk: "yes", rival: "yes" },
      { capability: "Jujutsu", hunk: "yes", rival: "yes" },
      { capability: "Sapling", hunk: "yes", rival: "no" },
      { capability: "Perforce and GitButler", hunk: "no", rival: "yes" },
      {
        capability: "General-purpose Git pager and difftool",
        hunk: "yes",
        rival: "no",
        note: "Hunk also stands in for `core.pager` and `git difftool` on ordinary, non-agent work.",
      },
      {
        capability: "Watch mode that reloads the review",
        hunk: "yes",
        rival: "partial",
        note: "Plannotator polls the repo while a review is open and offers a Refresh when the working tree moves. Hunk's `--watch` reloads the review itself.",
      },
      {
        capability: "Split and unified layouts switchable mid-review",
        hunk: "yes",
        rival: "yes",
        note: "Plannotator toggles Split and Unified from its settings panel. Hunk adds a responsive auto layout and switches from the keyboard.",
      },
      {
        capability: "Themes",
        hunk: "yes",
        rival: "yes",
        note: `Hunk ships ${THEME_COUNT} bundled themes and takes custom ones. Plannotator ships its own set, chosen in its settings panel.`,
      },
      {
        capability: "Third-party extension API",
        hunk: "yes",
        rival: "no",
        note: "Meaning third-party code that extends the review UI itself. Plannotator has agent integrations, editor extensions, and custom review skills, but no such API.",
      },
      {
        capability: "Data stays on your machine",
        hunk: "yes",
        rival: "yes",
        note: "Plannotator is local by default and is building a separate hosted product, Workspaces, for team sharing. Hunk has no hosted component.",
      },
    ],
    sections: [
      {
        heading: "The problem they share",
        body: [
          "When you wrote the code, reading the diff was a formality. When an agent wrote it, the diff is the only place you find out what actually happened, and the volume went up at the moment your context went down.",
          "Both tools answer with a review surface that talks back to the agent. You mark something up and your feedback returns to the agent session as structured input instead of a message you retype. The difference is where the reading happens and how early in the loop it starts.",
        ],
      },
      {
        heading: "What Plannotator does",
        body: [
          "Plannotator runs a local binary that starts a temporary server and opens the session in your browser. What it leads with is plan review. When an agent proposes a plan, that plan opens for annotation before any code is written, and you can comment, redline, mark up, and label inline, then approve or send structured feedback back to the agent.",
          "Its code review surface handles local changes across Git, Jujutsu, Perforce, and GitButler, and it can open a GitHub pull request or GitLab merge request from a URL. It has AI review built in, so it can answer questions about what you are reading and launch reviews that post their own comments on the diff. It integrates with a long list of agents through host-specific hooks and commands, and it is dual-licensed under Apache 2.0 or MIT. Plans, diffs, and annotations stay local by default.",
          "If reviewing plans before implementation is part of how you work, or you want hosted PRs and built-in AI review in the same tool, those are real capabilities Hunk does not have.",
        ],
      },
      {
        heading: "What Hunk does",
        body: [
          "Hunk stays in the terminal. Run `hunk diff` in a second pane and it renders every visible file as one continuous review stream with a sidebar, split or stacked layouts, syntax highlighting, mouse support, and `--watch` to reload as the agent keeps working.",
          "The agent-facing part runs the other direction from a comment box. Each session registers with a local loopback daemon, and the agent uses non-interactive `hunk session` commands to inspect the review you are looking at, navigate it, and leave notes. `hunk session review --json` gives it the structure of the changeset without pushing the whole patch into its context. Its reasoning then renders inline as note cards on specific hunks, so the explanation sits next to the code instead of in a separate transcript.",
          "Hunk is also an ordinary diff viewer. The same binary is your Git pager, difftool, patch reader, and two-file comparison tool, which matters if you would rather not install a second thing for non-agent work.",
        ],
        code: {
          caption: "The Hunk agent loop",
          lines: [
            HUNK_INSTALL,
            "",
            "# terminal 1: your review, stays open",
            "hunk diff --watch",
            "",
            "# terminal 2: point the agent at the review skill",
            "hunk skill path",
          ],
        },
      },
      {
        heading: "Choosing",
        body: [
          "Take Plannotator if the plan is where you most want to catch problems, if you would rather read in a browser, or if you need Perforce, GitButler, hosted PR review, or built-in AI review in the same tool.",
          "Take Hunk if the diff is what you review, if you want the agent's reasoning rendered in the diff rather than alongside it, if the agent should be able to read and drive the session you have open, or if you want one terminal tool that is also your everyday Git pager and difftool.",
          "They are not exclusive. They hook into agents at different points, so nothing stops you annotating a plan in one and reviewing the resulting diff in the other.",
        ],
      },
    ],
    faqs: [
      {
        question: "Does Hunk review agent plans like Plannotator does?",
        answer:
          "No. Hunk's review starts once there is a diff: a working tree, a commit, a patch, or a file pair. Plan review before implementation is Plannotator's territory.",
      },
      {
        question: "Can Hunk review a GitHub pull request?",
        answer:
          "Not from a URL. Hunk reviews local input: working trees, commits and revsets, patches on stdin, and file pairs. You can check out the PR branch and run `hunk diff main...HEAD`, but there is no PR-by-URL mode.",
      },
      {
        question: "Which works better over SSH?",
        answer:
          "Hunk, because it never needs a browser. It is a terminal UI, so a remote shell or a tmux session on a server is a normal place to run it. Plannotator documents SSH and devcontainer setups, auto-detecting SSH and switching to a fixed port you forward, but the reading still happens in a browser on some machine.",
      },
      {
        question: "Do both send my code anywhere?",
        answer:
          "Neither, by default. Hunk runs locally with a loopback daemon for session control and has no hosted component. Plannotator keeps plans, diffs, and annotations local by default, and is separately building a hosted product, Workspaces, for team sharing.",
      },
      {
        question: "Which agents does each support?",
        answer:
          "Plannotator ships host-specific hooks and commands for a long list of agents, including Claude Code, Codex, Copilot CLI, Gemini CLI, and OpenCode. Hunk is agent-neutral: any agent that can run shell commands can use the `hunk session` surface and load the skill returned by `hunk skill path`.",
      },
    ],
    sources: [
      {
        label: "Plannotator, GitHub repository",
        url: "https://github.com/backnotprop/plannotator",
      },
      { label: "Plannotator, project site", url: "https://plannotator.ai/" },
      { label: "Hunk: review with an agent", url: "/docs/agents/review-with-an-agent/" },
      { label: "Hunk: live session control", url: "/docs/agents/live-session-control/" },
    ],
  },
];

/** Absolute URL for a comparison page, for canonical links and structured data. */
export function comparisonUrl(comparison: Comparison): string {
  return `${SITE_ORIGIN}/compare/${comparison.slug}/`;
}

/** Symbol and screen-reader label for one support mark. */
export const SUPPORT_MARKS: Record<Support, { symbol: string; label: string }> = {
  yes: { symbol: "●", label: "Yes" },
  partial: { symbol: "◐", label: "Partly" },
  no: { symbol: "○", label: "No" },
};

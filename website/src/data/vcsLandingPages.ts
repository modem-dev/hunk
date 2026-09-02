export interface VcsLandingPage {
  slug: "git" | "jujutsu" | "sapling";
  name: string;
  command: string;
  title: string;
  description: string;
  keywords: string[];
  answer: string;
  quickStart: string[];
  setup?: { heading: string; lines: string[] };
  workflows: { heading: string; body: string }[];
  limitations: string;
  docsHref: string;
}

/** Search-focused VCS guides rendered as both HTML and Markdown. */
export const VCS_LANDING_PAGES: VcsLandingPage[] = [
  {
    slug: "git",
    name: "Git",
    command: "git",
    title: "Terminal Git diff viewer for reviewing changesets | Hunk",
    description:
      "Use Hunk as a terminal Git diff viewer for working trees, staged changes, commits, stashes, pager output, and difftool workflows.",
    keywords: [
      "git diff viewer",
      "terminal git diff",
      "git difftool",
      "git pager",
      "review git changes",
    ],
    answer:
      "Hunk turns Git changes into one review-first terminal UI: a multi-file stream, file navigation, split or stack layouts, expandable context, watch mode, and inline agent notes. Run Hunk directly for a complete changeset, or connect it to Git as a pager or difftool.",
    quickStart: ["hunk diff", "hunk diff --staged", "hunk show HEAD~1", "hunk stash show"],
    setup: {
      heading: "Use Hunk from Git commands",
      lines: [
        'git config --global core.pager "hunk pager"',
        'git config --global difftool.hunk.cmd \'hunk difftool "$LOCAL" "$REMOTE" "$MERGED"\'',
        "git config --global difftool.prompt false",
      ],
    },
    workflows: [
      {
        heading: "Review the whole working tree",
        body: "`hunk diff` includes tracked changes and untracked files in one ordered review stream. Add `--exclude-untracked` when you only want files Git already knows about.",
      },
      {
        heading: "Review staged work, commits, and stashes",
        body: "Use `hunk diff --staged`, `hunk show <ref>`, or `hunk stash show [stash]`. Pathspecs after `--` narrow the input without changing Hunk's review navigation.",
      },
      {
        heading: "Pager or difftool",
        body: "Pager mode lets `git diff` and `git show` open in Hunk. Git difftool integration is pair-oriented because Git invokes it once per file; use `hunk diff` for Hunk's native full-changeset stream.",
      },
    ],
    limitations:
      "Git controls the input in pager mode, so untracked files are not synthesized there. Use `hunk diff` when you want Hunk to assemble the complete working-tree review.",
    docsHref: "/docs/workflows/git-pager-and-difftool/",
  },
  {
    slug: "jujutsu",
    name: "Jujutsu",
    command: "jj",
    title: "Terminal diff viewer for Jujutsu (jj) | Hunk",
    description:
      "Review Jujutsu working copies and changes in Hunk with native jj revsets, pager integration, multi-file navigation, and agent annotations.",
    keywords: [
      "jujutsu diff viewer",
      "jj diff tui",
      "jj pager",
      "terminal diff viewer",
      "review jj changes",
    ],
    answer:
      "Hunk detects Jujutsu repositories and passes native jj revsets to its Jujutsu backend. Review a working copy or change in the same multi-file terminal UI Hunk provides for Git, without translating your workflow into Git refs.",
    quickStart: ["hunk diff", "hunk diff @-", "hunk show @"],
    setup: {
      heading: "Use Hunk as the jj pager",
      lines: [
        "# jj config edit --user",
        "[ui]",
        'pager = ["hunk", "pager"]',
        'diff-formatter = ":git"',
      ],
    },
    workflows: [
      {
        heading: "Review the working copy",
        body: "Run `hunk diff` inside a Jujutsu workspace. Hunk detects jj and builds one navigable review stream from the current working-copy changes.",
      },
      {
        heading: "Use native revsets",
        body: "Targets such as `@`, `@-`, and larger revset expressions stay in Jujutsu syntax. Use `hunk diff <target>` to compare and `hunk show <target>` to inspect one change.",
      },
      {
        heading: "Keep Hunk in the jj workflow",
        body: "Configure jj to emit Git-format diffs through `hunk pager`, so pager-driven commands can open the same review UI while ordinary text still falls back to a text pager.",
      },
    ],
    limitations:
      "Jujutsu has no Git staging area or stash workflow. Hunk's jj watch mode currently polls rather than observing repository files directly.",
    docsHref: "/docs/workflows/jujutsu-and-sapling/",
  },
  {
    slug: "sapling",
    name: "Sapling",
    command: "sl",
    title: "Terminal diff viewer for Sapling SCM | Hunk",
    description:
      "Review Sapling working copies and commits in Hunk with native revsets, pager integration, multi-file navigation, and untracked-file support.",
    keywords: [
      "sapling diff viewer",
      "sl diff tui",
      "sapling pager",
      "terminal diff viewer",
      "review sapling changes",
    ],
    answer:
      "Hunk detects Sapling repositories and accepts Sapling's own revision syntax. It turns working-copy and committed changes into a multi-file terminal review with fast navigation, split or stack layouts, expandable context, and inline agent notes.",
    quickStart: ["hunk diff", "hunk diff .^", "hunk show ."],
    setup: {
      heading: "Use Hunk as the Sapling pager",
      lines: ["# sl config -u", "[pager]", "pager = hunk pager"],
    },
    workflows: [
      {
        heading: "Review tracked and unknown files",
        body: "`hunk diff` includes Sapling working-copy changes and unknown files by default. Add `--exclude-untracked` when the review should contain tracked files only.",
      },
      {
        heading: "Use Sapling revisions",
        body: "Pass native targets such as `.^` and `.` directly to `hunk diff` or `hunk show`. Hunk sends them to the detected Sapling backend rather than treating them as Git refs.",
      },
      {
        heading: "Open pager output in Hunk",
        body: "Set Sapling's pager to `hunk pager` to route patch-like command output into the review UI. Non-diff output continues through Hunk's plain-text fallback.",
      },
    ],
    limitations:
      "Sapling has no Git staging-area or stash commands in Hunk. Its watch mode currently polls rather than observing repository files directly.",
    docsHref: "/docs/workflows/jujutsu-and-sapling/",
  },
];

/** Returns the canonical public URL for one VCS guide. */
export function vcsLandingUrl(page: VcsLandingPage): string {
  return `https://hunk.dev/${page.slug}/`;
}

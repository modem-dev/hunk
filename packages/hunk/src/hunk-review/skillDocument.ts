import { AGENT_ERROR_DOCS } from "../session/agent/errors";
import { SESSION_AGENT_COMMANDS, type AgentCommandSpec } from "../session/agent/surface";

/**
 * Deterministic renderer for `packages/hunk/skills/hunk-review/SKILL.md`.
 *
 * The command reference blocks and the "Common errors" section are derived from
 * `agentSurface.ts` and `agentErrors.ts` so the skill can never disagree with the parser or the
 * messages the CLI actually throws. The narrative prose lives here as authored strings, next to
 * the specs it explains. Regenerate with `bun run generate:skill`; never hand-edit the output —
 * `skillDocument.test.ts` fails CI when the checked-in file drifts from this renderer.
 */

/** Render one bash-highlighted code fence. */
function bashFence(lines: readonly string[]) {
  return ["```bash", ...lines, "```"];
}

/** Canonical synopsis lines for one or more session commands, in the given order. */
function synopsisLines(...specs: AgentCommandSpec[]) {
  return specs.flatMap((spec) => spec.synopsis);
}

const commands = SESSION_AGENT_COMMANDS;

/** Group navigation examples by their selector mode. */
function navigateExamples(kind: "absolute" | "comment" | "relative") {
  const examples = commands.navigate.examples ?? [];
  return examples.filter((example) => {
    if (kind === "absolute") {
      return example.includes("--file");
    }
    if (kind === "comment") {
      return example.includes("--comment ");
    }
    return example.includes("--next-comment") || example.includes("--prev-comment");
  });
}

const FRONTMATTER = [
  "---",
  "name: hunk-review",
  "description: Interacts with live Hunk diff review sessions via CLI. Inspects review focus, navigates files, hunks, and exact lines, reloads session contents, adds inline review comments, and paints attention marks on character ranges. Use when the user has a Hunk session running or wants to review diffs interactively.",
  "---",
];

const INTRO = [
  "# Hunk Review",
  "",
  "Hunk is an interactive terminal diff viewer. The TUI is for the user -- do NOT run `hunk diff`, `hunk show`, or other interactive commands directly. Use `hunk session *` CLI commands to inspect and control live sessions through the local daemon.",
  "",
  "If no session exists, ask the user to launch Hunk in their terminal first.",
];

const WORKFLOW = [
  "## Workflow",
  "",
  "```text",
  "1. hunk session list                                    # find live sessions",
  "2. hunk session get --repo .                            # inspect path / repo / source",
  "3. hunk session review --repo . --json                  # inspect file/hunk structure first",
  "4. hunk session review --repo . --include-patch --json  # opt into raw diff text only when needed",
  "5. hunk session context --repo .                        # check current focus when needed",
  "6. hunk session navigate ...                            # move to the right place",
  "7. hunk session reload -- <command>                     # swap contents if needed",
  "8. hunk session comment add ...                         # leave one review note",
  "9. hunk session comment apply ...                       # apply many agent notes in one stdin batch",
  "10. hunk session highlight add ...                      # light up the exact range you are explaining",
  "```",
];

const SESSION_SELECTION = [
  "## Session selection",
  "",
  "Most session commands accept:",
  "",
  "- `--repo <path>` -- match the live session by its current loaded repo root (most common)",
  "- `<session-id>` -- match by exact ID (use when multiple sessions share a repo)",
  "- If only one session exists, it auto-resolves",
  "",
  "`reload` also supports:",
  "",
  "- `--session-path <path>` -- match the live Hunk window by its current working directory",
  "- `--source <path>` -- load the replacement `diff` / `show` command from a different directory",
  "",
  "Use `--source` only for advanced reloads where the live session you want to control is not already associated with the checkout you want to load next. For a normal worktree session, prefer selecting it directly with `--repo /path/to/worktree`.",
];

const INSPECT_SECTION = [
  "### Inspect",
  "",
  ...bashFence(synopsisLines(commands.list, commands.get, commands.context, commands.review)),
  "",
  "- `get` shows the session `Path`, `Repo`, and `Source`, which helps when choosing between `--repo` and `--session-path`",
  "- `Repo` is what `--repo` matches; `Path` is what `--session-path` matches",
  "- `review --json` returns file and hunk structure by default; add `--include-patch` only when a caller truly needs raw unified diff text",
  "- `review --include-notes` also returns the live review notes alongside the file and hunk structure",
];

const NAVIGATE_SECTION = [
  "### Navigate",
  "",
  ...bashFence(synopsisLines(commands.navigate)),
  "",
  "Absolute navigation requires `--file` and exactly one of `--hunk`, `--new-line`, or `--old-line`:",
  "",
  ...bashFence(navigateExamples("absolute")),
  "",
  "Exact comment navigation uses the `commentId` returned by `hunk session comment list --json` and does not require `--file`:",
  "",
  ...bashFence(navigateExamples("comment")),
  "",
  "Relative comment navigation jumps between annotated hunks and does not require `--file`:",
  "",
  ...bashFence(navigateExamples("relative")),
  "",
  "- `--hunk <n>` is 1-based",
  "- `--new-line` / `--old-line` are 1-based line numbers on that diff side",
  "- A line target lands the user's viewport on that exact line (falling back to its hunk when the line is inside a collapsed region); `--hunk` lands on the hunk",
  "- Use either `--next-comment` or `--prev-comment`, not both",
];

const RELOAD_SECTION = [
  "### Reload",
  "",
  "Swaps the live session's contents. Pass a Hunk review command after `--`:",
  "",
  ...bashFence(synopsisLines(commands.reload)),
  "",
  "Examples:",
  "",
  ...bashFence(commands.reload.examples ?? []),
  "",
  "- Always include `--` before the nested Hunk command",
  "- `--repo` or `<session-id>` usually selects the session you want",
  "- `--source` is advanced: it does not select the session; it only changes where the replacement review command runs",
  "- If the live session is already showing the target worktree, prefer `hunk session reload --repo /path/to/worktree -- diff`",
  "- `--session-path` targets the live window when you need to keep session selection separate from reload source",
];

const COMMENTS_SECTION = [
  "### Comments",
  "",
  ...bashFence(
    synopsisLines(
      commands["comment-add"],
      commands["comment-apply"],
      commands["comment-list"],
      commands["comment-rm"],
      commands["comment-clear"],
    ),
  ),
  "",
  "Examples:",
  "",
  ...bashFence([
    ...(commands["comment-add"].examples ?? []),
    ...(commands["comment-apply"].examples ?? []),
  ]),
  "",
  "- `comment list --type user` shows human-authored inline notes; without `--type`, `comment list` preserves the legacy live-agent-comment view",
  "- `comment add` is best for one note; `comment apply` is best when an agent already has several notes ready",
  "- `comment add` requires `--file`, `--summary`, and exactly one of `--old-line` or `--new-line`",
  "- `comment apply` payload items require `filePath`, `summary`, and exactly one target such as `hunk`, `hunkNumber`, `oldLine`, or `newLine`",
  "- `comment apply` reads a JSON batch from stdin and validates the full batch before mutating the live session",
  "- Pass `--focus` when you want to jump to the new note or the first note in a batch",
  "- `comment list` and `comment clear` accept optional `--file`",
  "- Quote `--summary` and `--rationale` defensively in the shell",
];

const HIGHLIGHTS_SECTION = [
  "### Attention marks",
  "",
  "Highlights paint character ranges inside the diff lines the user is looking at — use them to light up the exact expression you are explaining while you narrate.",
  "",
  ...bashFence(synopsisLines(commands["highlight-add"], commands["highlight-clear"])),
  "",
  "Examples:",
  "",
  ...bashFence([
    ...(commands["highlight-add"].examples ?? []),
    ...(commands["highlight-clear"].examples ?? []),
  ]),
  "",
  "- `highlight add` requires `--file`, exactly one of `--old-line` or `--new-line`, and the `--start` / `--end` offsets",
  "- `--start` is a 0-based inclusive offset into the line's text and `--end` is exclusive, counted in UTF-16 code units — the same `[start, end)` range extensions use",
  "- Tones: `match` (default), `info`, `warning`, `error`, `dim`; `current` renders as reverse video and is best reserved for the one range under discussion",
  "- Pass `--focus` to also land the viewport on the marked line",
  "- Marks survive scrolling, navigation, and reloads that leave the marked file's content unchanged; a reload that changes that file drops its marks, and `highlight clear` removes them explicitly (optionally per `--file`)",
  "- Marks are visual only — pair them with a `comment add` when the explanation should persist as a note",
];

const STML_SECTION = [
  "### Experimental rich markup notes (STML)",
  "",
  "Only use STML when `hunk session context --json` lists `stml` in `experimentalFeatures`. The user opts into that experience by launching the review with `--experimental`; do not ask a normal session to render markup.",
  "",
  "For an opted-in session, `--markup` (or a `markup` field on apply items) renders the note body as STML — a small HTML-like markup for terminal UI (boxes, rows, gauges, badges, lists, code). Keep `--summary` a real sentence: it is the fallback and the `comment list` text.",
  "",
  "Before writing markup, run `hunk markup guide` once — it has copy-paste patterns and the width rules. The session context also reports `noteMarkupWidth` (the live render width); preview with `hunk markup render - --width <that>`. Comment responses echo `markupWidth` and return `markupNotes` when markup degraded — fix what they flag.",
];

const NEW_FILES_SECTION = [
  "## New files in working-tree reviews",
  "",
  "`hunk diff` includes untracked files by default. If the user wants tracked changes only, reload with `--exclude-untracked`:",
  "",
  ...bashFence(["hunk session reload --repo . -- diff --exclude-untracked"]),
];

const GUIDING_SECTION = [
  "## Guiding a review",
  "",
  "The user may ask you to walk them through a changeset or review code using Hunk. Start with `hunk session review --json` to understand the file/hunk structure without inflating agent context, then use `--include-patch` only for the files you truly need to read in raw diff form. Use `context` and `navigate` to line up the user's current view before adding comments.",
  "",
  "Your role is to narrate: steer the user's view to what matters and leave comments that explain what they're looking at.",
  "",
  "Typical flow:",
  "",
  "1. Load the right content (`reload` if needed)",
  "2. Navigate to the first interesting file / hunk",
  "3. Add a comment explaining what's happening and why",
  "4. If you already have several notes ready, prefer one `comment apply` batch over many separate shell invocations",
  "5. Summarize when done",
  "",
  "Guidelines:",
  "",
  "- Work in the order that tells the clearest story, not necessarily file order",
  "- Navigate before commenting so the user sees the code you're discussing",
  "- Use `highlight add --focus` to steer the user's eyes to the exact expression while you explain it, and `highlight clear` before moving to the next topic",
  "- Use `comment apply` for agent-generated batches and `comment add` for one-off notes",
  "- Use `--focus` sparingly when the note itself should actively steer the review",
  "- Keep comments focused: intent, structure, risks, or follow-ups",
  "- Don't comment on every hunk -- highlight what the user wouldn't spot themselves",
];

/** Render the "Common errors" section from the shared agent error catalog. */
function commonErrorsSection() {
  return [
    "## Common errors",
    "",
    ...AGENT_ERROR_DOCS.map((doc) => `- **"${doc.quote}"** -- ${doc.remedy}`),
  ];
}

/** Render the complete hunk-review SKILL.md content. */
export function renderHunkReviewSkill() {
  const sections = [
    [...FRONTMATTER, "", ...INTRO],
    WORKFLOW,
    SESSION_SELECTION,
    ["## Commands"],
    INSPECT_SECTION,
    NAVIGATE_SECTION,
    RELOAD_SECTION,
    COMMENTS_SECTION,
    HIGHLIGHTS_SECTION,
    STML_SECTION,
    NEW_FILES_SECTION,
    GUIDING_SECTION,
    commonErrorsSection(),
  ];

  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}

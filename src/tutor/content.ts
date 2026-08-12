import { createTwoFilesPatch } from "diff";

/** One before/after document used to build the bundled tutor's synthetic changeset. */
interface TutorDocument {
  path: string;
  before: string;
  after: string;
}

/** Join source lines with the final newline real documents normally carry. */
function lines(...source: string[]) {
  return `${source.join("\n")}\n`;
}

/** Build numbered instructional rows that make page-sized movement visible. */
function scrollingRows(prefix: string, count: number) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix} ${String(index + 1).padStart(2, "0")}`,
  );
}

const NAVIGATION_BRIDGE = [
  "Tip 01 — highlight = your place.",
  "Tip 02 — movement never edits.",
  "Tip 03 — files form one stream.",
  "Tip 04 — context frames changes.",
  "Tip 05 — sidebar is an index.",
  "Tip 06 — pane shows your keys.",
  "Tip 07 — mouse shares this state.",
  "Tip 08 — selection anchors jumps.",
  "Tip 09 — big reviews reward jumps.",
  "Tip 10 — next change is below.",
];

const HIDDEN_CONTEXT = [
  "Hidden 01 — long context folds.",
  "Hidden 02 — changes stay central.",
  "Hidden 03 — setup can be evidence.",
  "Hidden 04 — expand it in Hunk.",
  "Hidden 05 — toggle to collapse.",
  "YOU REVEALED THE FOLDED GUIDE.",
  "Hidden 07 — inspect dependencies.",
  "Hidden 08 — the ellipsis is a clue.",
  "Hidden 09 — expansion is local.",
  "Hidden 10 — context can matter.",
];

const beforeScrollRows = scrollingRows("Practice row", 42);
const afterScrollRows = beforeScrollRows.map((_, index) => {
  const row = index + 1;
  if (row === 1) return "START — row steps are precise.";
  if (row === 10) return "CHECKPOINT A — pages move fast.";
  if (row === 20) return "PAGE CHECKPOINT — page-down works.";
  if (row === 27) return "HALF-PAGE CHECKPOINT — less jump.";
  if (row === 34) return "SCAN TIP — page, then row.";
  if (row === 42) return "END — page-up returns.";
  return `Row ${String(row).padStart(2, "0")} — distance made visible.`;
});

const PAN_REVEAL =
  "PAN RIGHT → this sentence keeps going beyond the viewport ................................................................................ horizontal panning reveals columns that do not fit on screen.  ◆ YOU FOUND IT ◆";

/** The curated files are themselves the guide, in the order shortcuts reveal them. */
const TUTOR_DOCUMENTS: readonly TutorDocument[] = [
  {
    path: "00-start-here.md",
    before: lines("# Hunk Tutor", "", "This is a practice review."),
    after: lines(
      "# Hunk Tutor",
      "",
      "This diff is the tutorial.",
      "You are not editing a project.",
      "Changed lines teach Hunk.",
      "Each shortcut has a purpose.",
      "",
      "Keep the Tutor pane open.",
      "It shows one configured key.",
      "Navigate, then read the reveal.",
      "",
      "> Lost? Open controls help.",
      "> Restart from Extensions.",
    ),
  },
  {
    path: "01-moving-through-a-review.md",
    before: lines(
      "# Lesson 1 — Move through a review",
      "",
      "## Nearby rows",
      "The highlight marks your place.",
      "Move around the document.",
      "",
      ...NAVIGATION_BRIDGE,
      "",
      "## Changed blocks and files",
      "A hunk groups nearby changed lines.",
      "Move between changes and files.",
    ),
    after: lines(
      "# Lesson 1 — Move through a review",
      "",
      "## Nearby rows",
      "Open controls help for your keymap.",
      "The highlight marks your place.",
      "Move down once, then back up.",
      "Watch the highlight follow.",
      "",
      ...NAVIGATION_BRIDGE,
      "",
      "## Changed blocks and files",
      "A hunk groups nearby changes.",
      "Hunk jumps skip between groups.",
      "Next-file reaches Lesson 2.",
      "Previous-file returns here.",
      "Top reveals Start Here.",
      "Bottom previews the final page.",
    ),
  },
  {
    path: "02-scrolling-and-panning.md",
    before: lines(
      "# Lesson 2 — Cover distance",
      "",
      "One line below is extra wide.",
      "Pan across this placeholder.",
      "",
      ...beforeScrollRows,
      "",
      ...HIDDEN_CONTEXT,
      "",
      "## Folded context",
      "Expand context when setup matters.",
    ),
    after: lines(
      "# Lesson 2 — Cover distance",
      "",
      "One line below is extra wide.",
      "Keep wrapping off for this hunt.",
      PAN_REVEAL,
      "",
      ...afterScrollRows,
      "",
      ...HIDDEN_CONTEXT,
      "",
      "## Folded context",
      "The collapsed section hides a guide.",
      "Expand it to reveal the message.",
      "Pages expose distant rows.",
      "Panning exposes distant columns.",
      "Expansion exposes folded context.",
    ),
  },
  {
    path: "03-shaping-the-view.md",
    before: lines(
      "# Lesson 3 — View settings",
      "",
      "Choose a presentation.",
      "Show useful chrome.",
      "Try a color theme.",
    ),
    after: lines(
      "# Lesson 3 — Shape the view",
      "",
      "Split: old and new side by side.",
      "Stack: old above new.",
      "Auto: adapts to terminal width.",
      "",
      "Line numbers locate source rows.",
      "WRAP THIS LONG EXPLANATION → line wrapping trades horizontal scanning for extra vertical rows, which is useful when prose or code extends beyond the available pane width.",
      "Hunk headers show source ranges.",
      "",
      "Themes change presentation only.",
      "Added and removed stay distinct.",
      "The menu makes features findable.",
      "F10 works while the bar is hidden.",
      "Hide Tutor to give the diff room.",
      "It reopens after this lesson.",
    ),
  },
  {
    path: "04-find-a-file/haystack-a.md",
    before: lines("# Filtering", "", "Many files can share one review."),
    after: lines(
      "# Filtering: haystack A",
      "",
      "This file vanishes for `needle`.",
      "Filtering narrows the review.",
      "It does not alter the changeset.",
    ),
  },
  {
    path: "04-find-a-file/needle.md",
    before: lines("# Filtering", "", "Find one file."),
    after: lines(
      "# Lesson 4 — Find the signal",
      "",
      "Focus the filter. Type `needle`.",
      "This becomes the only visible file.",
      "The review now contains one match.",
      "Press Escape to clear the query.",
      "The complete tutorial returns.",
      "",
      "Focus switches files and filter.",
      "It does not change selection.",
      "Refresh reloads a real source.",
      "This safe tutorial stays the same.",
      "Editor handoff opens `$EDITOR`.",
      "This tutorial has no file to edit.",
    ),
  },
  {
    path: "04-find-a-file/haystack-b.md",
    before: lines("# Filtering", "", "Many files can share one review."),
    after: lines(
      "# Filtering: haystack B",
      "",
      "This also vanishes for `needle`.",
      "It returns when the query clears.",
      "File order remains stable.",
    ),
  },
  {
    path: "05-context-and-notes.md",
    before: lines(
      "# Lesson 5 — Context and notes",
      "",
      "## Agent explanations",
      "A changed hunk can have rationale.",
      "Read the change alone.",
      "",
      ...NAVIGATION_BRIDGE,
      "",
      "## Human review notes",
      "A reviewer can ask a question.",
      "Keep the question elsewhere.",
    ),
    after: lines(
      "# Lesson 5 — Review with context",
      "",
      "## Agent explanations",
      "Agent notes explain why.",
      "They sit beside exact lines.",
      "Toggle them, then jump between.",
      "You land on explained changes.",
      "",
      ...NAVIGATION_BRIDGE,
      "",
      "## Human review notes",
      "Start a note on this hunk.",
      "Type a real review thought.",
      "Save it beside the target code.",
      "The composer owns the keyboard.",
      "Save or cancel to return.",
    ),
  },
  {
    path: "06-how-the-tutor-works.md",
    before: lines("# Lesson 6 — Extensions", "", "Extensions add behavior."),
    after: lines(
      "# Lesson 6 — How the tutor works",
      "",
      "Tutor is a bundled extension.",
      "It uses Hunk's public API.",
      "It adds this sidebar and theme.",
      "It adds commands and event handlers.",
      "It transforms the guide changeset.",
      "",
      "Tutor listens for command names.",
      "It does not hard-code keys.",
      "Steps follow live `[keybindings]`.",
      "Other extensions use these APIs.",
      "They can add views and dialogs.",
      "They can add review tools.",
      "",
      "Use Finish when you are ready.",
      "It also lives in Extensions.",
    ),
  },
  {
    path: "07-finish-and-next-steps.md",
    before: lines("# Next", "", "Open a review."),
    after: lines(
      "# Finish — use Hunk on a real change",
      "",
      "You can move through a review.",
      "You can shape and filter it.",
      "You can add review context.",
      "Shortcuts serve one question:",
      "what changed, and why?",
      "",
      "Try one after leaving Tutor:",
      "",
      "- working tree: `hunk diff`",
      "- staged: `hunk diff --staged`",
      "- commit: `hunk show HEAD~1`",
      "- stash: `hunk stash show`",
      "- patch: `hunk patch change.diff`",
      "- rationale: `--agent-context`",
      "- live reload: `hunk diff --watch`",
      "",
      "Use the mouse when it is natural.",
      "Primary actions keep key parity.",
      "Open controls for a reminder.",
      "Quit when the diff is understood.",
    ),
  },
];

/** Return one complete synthetic tutorial document side for context expansion. */
export function getTutorDocumentText(path: string, side: "old" | "new") {
  const document = TUTOR_DOCUMENTS.find((candidate) => candidate.path === path);
  return document?.[side === "old" ? "before" : "after"] ?? null;
}

/** Paths in the exact narrative order Hunk should render and navigate. */
export const TUTOR_PATHS = TUTOR_DOCUMENTS.map((document) => document.path);

/** A deterministic multi-file patch that can be loaded without touching the user's repository. */
export const TUTOR_PATCH = TUTOR_DOCUMENTS.map((document) =>
  createTwoFilesPatch(
    document.path,
    document.path,
    document.before,
    document.after,
    "before",
    "after",
    { context: 3 },
  ),
).join("\n");

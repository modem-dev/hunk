// Hunk's current video storyboard: its shot list, cards, and captions,
// composited by @hunk/term-video.
//
//   node scripts/launch-video/compose.mjs <workDir>
//
// <workDir> is the capture output dir (contains frames/) and must have a
// node_modules with playwright-core matching the Chromium build (see
// skills/hunk-launch-video/SKILL.md). Composited frames land in <workDir>/out.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeStoryboard } from "@hunk/term-video/compose";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const workDir = resolve(process.argv[2] ?? join(repoRoot, ".video-work"));

/** Inline one of the brand page's paper-colored logo exports at a fixed width. */
function brandLogo(id, width) {
  const svg = readFileSync(
    join(repoRoot, "website/public/brand/downloads", `${id}-paper.svg`),
    "utf8",
  ).trim();
  return svg.replace("<svg ", `<svg style="width: ${width}px; height: auto; display: block" `);
}

const FULL_FRAME = { x: 0.5, y: 0.5, scale: 1 };
const OPEN_TITLE = "hunk open — taskboard";
const DOCUMENT_CAMERA = { x: 0.62, y: 0.4, scale: 1.25 };
const LAYOUT_TITLE = "hunk diff — auto layout";
const CONFLICT_TITLE = "hunk diff — merge in progress";
const SCROLL_TITLE = "hunk diff — taskboard";
const SCROLL_CAMERA = { x: 0, y: 1, scale: 1.3 };
const SHELL_TITLE = "shell — taskboard";
const COMPLETION_CAMERA = { x: 0, y: 0, scale: 1.3 };

const OPEN_CARD = `
  ${brandLogo("logo-lockup", 640)}
  <div class="sub" style="margin-top: 22px">version <span class="hl">0.24</span> · made for review</div>
`;

const BROWSE_CARD = `
  <div class="badge">NEW</div>
  <h2>Browse any file or folder</h2>
  <div class="cmds">
    <div class="cmd"><span class="p">❯</span> hunk open</div>
  </div>
  <div class="foot">full syntax-highlighted files · lazy directory tree · live refresh</div>
`;

const LAYOUT_CARD = `
  <div class="badge">NEW</div>
  <h2>Pane-aware auto layout</h2>
  <div class="sub">split when there's room · unified when there isn't</div>
  <div class="foot">tunable with <span style="color: #e0af68">auto_split_min_width</span></div>
`;

const CONFLICT_CARD = `
  <div class="badge">NEW</div>
  <h2>Review merge conflicts</h2>
  <div class="cmds">
    <div class="cmd"><span class="p">❯</span> hunk diff</div>
  </div>
  <div class="foot">conflict diffs during paused merges and rebases</div>
`;

const SCROLL_OFF_CARD = `
  <div class="badge">NEW</div>
  <h2>Scroll-off context</h2>
  <div class="sub">the cursor never hugs the edge of the screen</div>
  <div class="foot">5 rows by default · <span style="color: #e0af68">scroll_off = 0</span> restores edge scrolling</div>
`;

const COMPLETION_CARD = `
  <div class="badge">NEW</div>
  <h2>Shell completions</h2>
  <div class="cmds">
    <div class="cmd"><span class="p">❯</span> source &lt;(hunk completion bash)</div>
  </div>
  <div class="foot">bash and zsh · commands, flags, and flag values</div>
`;

const ALSO_ITEMS = [
  ["npm extensions", "hunk extension install @scope/pkg"],
  ["faster first keypress", "syntax highlighting moved to a worker"],
  ["lighter --watch", "long-running sessions no longer leak memory"],
  ["remappable save", "hunk.review.saveNote for the note composer"],
  ["extension APIs", "independent side panes and review filters"],
];

const ALSO_CARD = `
  <h2>Also in 0.24</h2>
  <div style="display: grid; grid-template-columns: auto auto; gap: 18px 40px; text-align: left; font-size: 36px; margin-top: 10px">
    ${ALSO_ITEMS.map(
      ([name, detail]) =>
        `<div style="color: #e0af68; font-weight: 700">${name}</div><div style="color: #c3cadf">${detail}</div>`,
    ).join("\n    ")}
  </div>
  <div class="foot">plus 50+ fixes and polish · full notes at hunk.dev/changelog</div>
`;

const OUTRO_CARD = `
  ${brandLogo("logo-lockup", 420)}
  <div class="cmds" style="margin-top: 18px">
    <div class="cmd" style="font-size: 38px"><span class="p">❯</span> curl -fsSL https://hunk.dev/install.sh | sh</div>
    <div class="cmd" style="font-size: 38px"><span class="p">❯</span> npm i -g hunkdiff</div>
  </div>
  <div class="foot">already installed? <span style="color: #e0af68">hunk update</span> · hunk.dev</div>
`;

// One entry per storyboard shot; timing/caption semantics are documented in
// @hunk/term-video/plan.
const SHOTS = [
  { kind: "card", html: OPEN_CARD, dur: 3.0, enter: true },

  // hunk open: tree walk, then the complete document.
  { kind: "card", html: BROWSE_CARD, dur: 2.8, enter: true },
  {
    kind: "term",
    img: "open-overview",
    title: OPEN_TITLE,
    dur: 1.8,
    enter: true,
    camera: FULL_FRAME,
    capKey: "open-tree",
    caption: `<span class="badge">NEW</span> browse a project — no diff required`,
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    kind: "term",
    img: `open-tree-${i}`,
    title: OPEN_TITLE,
    dur: i === 5 ? 1.2 : 0.32,
    camera: FULL_FRAME,
    highlight: { x: 0.004, y: 0.03, width: 0.236, height: 0.395, label: "Git-aware tree" },
    highlightKey: "open-tree",
    capKey: "open-tree",
  })),
  {
    kind: "term",
    img: "open-document",
    title: OPEN_TITLE,
    dur: 3.0,
    camera: DOCUMENT_CAMERA,
    cameraKey: "open-document",
    motion: 0.85,
    capKey: "open-document",
    caption: `<span class="hl">Enter</span> opens the complete, highlighted file`,
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    kind: "term",
    img: `open-scroll-${i}`,
    title: OPEN_TITLE,
    dur: i === 5 ? 1.4 : 0.4,
    camera: DOCUMENT_CAMERA,
    cameraKey: "open-document",
    capKey: "open-scroll",
    caption: `scroll it like any review — keyboard or mouse`,
  })),

  // Pane-aware auto layout: the files pane toggles split ⇄ unified.
  { kind: "card", html: LAYOUT_CARD, dur: 2.6, enter: true },
  {
    kind: "term",
    img: "layout-split",
    title: LAYOUT_TITLE,
    dur: 2.4,
    enter: true,
    capKey: "layout-split",
    caption: `plenty of width — <span class="hl">split</span> view`,
  },
  {
    kind: "term",
    img: "layout-unified",
    title: LAYOUT_TITLE,
    dur: 2.8,
    highlight: { x: 0.004, y: 0.068, width: 0.162, height: 0.256, label: "files pane" },
    capKey: "layout-unified",
    caption: `open the files pane — it switches to <span class="hl">unified</span>`,
  },
  {
    kind: "term",
    img: "layout-split-again",
    title: LAYOUT_TITLE,
    dur: 2.0,
    capKey: "layout-split-again",
    caption: `close it — back to split`,
  },

  // Conflict diffs during a paused merge.
  { kind: "card", html: CONFLICT_CARD, dur: 2.6, enter: true },
  {
    kind: "term",
    img: "conflict-review",
    title: CONFLICT_TITLE,
    dur: 2.4,
    enter: true,
    camera: FULL_FRAME,
    cameraKey: "conflict",
    capKey: "conflict",
    caption: `mid-merge? the conflicts are <span class="hl">the review</span>`,
  },
  {
    kind: "term",
    img: "conflict-review",
    title: CONFLICT_TITLE,
    dur: 3.2,
    camera: { x: 0.35, y: 0.78, scale: 1.4 },
    cameraKey: "conflict",
    highlight: { x: 0.008, y: 0.6875, width: 0.6, height: 0.156 },
    motion: 0.85,
    capKey: "conflict-sides",
    caption: `both sides, between the markers, in context`,
  },

  // scroll_off: the cursor walks down, then the view scrolls ahead of it.
  { kind: "card", html: SCROLL_OFF_CARD, dur: 2.6, enter: true },
  ...Array.from({ length: 10 }, (_, i) => ({
    kind: "term",
    img: `scrolloff-step-${String(i + 10).padStart(2, "0")}`,
    title: SCROLL_TITLE,
    dur: i === 0 ? 1.2 : 0.18,
    enter: i === 0,
    camera: SCROLL_CAMERA,
    cameraKey: "scrolloff",
    capKey: "scrolloff-step",
    caption: `step through a diff with <span class="hl">j</span>`,
  })),
  ...Array.from({ length: 14 }, (_, i) => ({
    kind: "term",
    img: `scrolloff-step-${String(i + 20).padStart(2, "0")}`,
    title: SCROLL_TITLE,
    dur: i === 13 ? 1.6 : 0.26,
    camera: SCROLL_CAMERA,
    cameraKey: "scrolloff",
    highlight: { x: 0.004, y: 0.812, width: 0.76, height: 0.158 },
    highlightKey: "scrolloff",
    capKey: "scrolloff-context",
    caption: `the view scrolls early — <span class="hl">5 rows</span> stay ahead`,
  })),

  // Shell completions.
  { kind: "card", html: COMPLETION_CARD, dur: 2.6, enter: true },
  {
    kind: "term",
    img: "completion-commands",
    title: SHELL_TITLE,
    dur: 2.6,
    enter: true,
    camera: COMPLETION_CAMERA,
    capKey: "completion-commands",
    caption: `<span class="hl">Tab</span> completes every command`,
  },
  {
    kind: "term",
    img: "completion-mode-typed",
    title: SHELL_TITLE,
    dur: 0.6,
    camera: COMPLETION_CAMERA,
    capKey: "completion-modes",
    caption: `…and flag values`,
  },
  {
    kind: "term",
    img: "completion-modes",
    title: SHELL_TITLE,
    dur: 2.4,
    camera: COMPLETION_CAMERA,
    capKey: "completion-modes",
  },

  { kind: "card", html: ALSO_CARD, dur: 5.0, enter: true },
  { kind: "card", html: OUTRO_CARD, dur: 4.2, enter: true },
];

const result = await composeStoryboard({ shots: SHOTS, workDir, rootDir: repoRoot });
console.log(
  `${result.uniqueFrames} unique frames, ${result.totalSeconds.toFixed(1)}s total -> ${result.concatPath}`,
);

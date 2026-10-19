// Hunk's current video storyboard: its shot list, cards, and captions,
// composited by @hunk/term-video.
//
//   node scripts/launch-video/compose.mjs <workDir>
//
// <workDir> is the capture output dir (contains frames/) and must have a
// node_modules with playwright-core matching the Chromium build (see
// skills/hunk-launch-video/SKILL.md). Composited frames land in <workDir>/out.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeStoryboard } from "@hunk/term-video/compose";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const workDir = resolve(process.argv[2] ?? join(repoRoot, ".video-work"));

const HISTORY_TITLE = "hunk log - Git history";
const REVIEW_TITLE = "hunk diff - precise review";
const FULL_FRAME = { x: 0.5, y: 0.5, scale: 1 };
const HISTORY_CAMERA = FULL_FRAME;
const RANGE_CAMERA = FULL_FRAME;
const RANGE_HEIGHTS = [0.12, 0.27, 0.425, 0.515];
const HISTORY_ROWS = {
  x: 0.01,
  y: 0.02,
  width: 0.96,
  height: 0.925,
  label: "day-grouped history",
};

const OPEN_CARD = `
  <div class="badge">HUNK 0.22</div>
  <h1>Git history in Hunk</h1>
  <div class="sub">browse commits · select a range · <span class="hl">stay in the flow</span></div>
`;

const HISTORY_CARD = `
  <div class="badge">NEW</div>
  <h2>Interactive history browser</h2>
  <div class="cmds">
    <div class="cmd"><span class="p">❯</span> hunk log</div>
  </div>
  <div class="foot">Git and Jujutsu · automatic interactive mode in a TTY</div>
`;

const STATIC_CARD = `
  <div class="badge">TERMINAL-NATIVE</div>
  <h2>Static history output</h2>
  <div class="cmds">
    <div class="cmd"><span class="p">❯</span> hunk log --static --max-count 5</div>
  </div>
  <div class="foot">clean output for pipes, scripts, and captured logs</div>
`;

const SELECTION_CARD = `
  <div class="badge">PRECISE REVIEW</div>
  <h2>Multiline selections</h2>
  <div class="sub"><span class="hl">v</span> starts a persistent range · then comment, copy, or clear</div>
`;

const THREAD_CARD = `
  <div class="badge">KEYBOARD-FIRST</div>
  <h2>Keyboard note navigation</h2>
  <div class="sub"><span class="hl">n / N</span> moves between notes · R reply · E edit · D delete</div>
`;

const POLISH_CARD = `
  <div class="badge">QUALITY OF LIFE</div>
  <h2>Review shortcuts</h2>
  <div class="sub"><span class="hl">1</span> unified · <span class="hl">2</span> split · responsive files pane</div>
`;

const FINISH_CARD = `
  <div class="badge">HUNK 0.22</div>
  <h2>Quality-of-life improvements</h2>
  <div class="sub">view and theme preferences persist · panes move smoothly · suspended jobs resume intact</div>
  <div class="foot">faster wrapped diffs · lower idle CPU · direct reviews show revision context</div>
`;

const OUTRO_CARD = `
  <div class="badge">AVAILABLE NOW</div>
  <h1>hunk 0.22</h1>
  <div class="sub">history browsing · range reviews · precise comments</div>
  <div class="foot">hunk.dev · github.com/modem-dev/hunk</div>
`;

// One entry per storyboard shot; timing/caption semantics are documented in
// @hunk/term-video/plan.
const SHOTS = [
  { kind: "card", html: OPEN_CARD, dur: 2.8, enter: true },
  { kind: "card", html: HISTORY_CARD, dur: 2.5, enter: true },
  {
    kind: "term",
    img: "history-overview",
    title: HISTORY_TITLE,
    dur: 2,
    enter: true,
    camera: FULL_FRAME,
    cameraKey: "history",
    capKey: "history-overview",
    caption: `<span class="badge">NEW</span> browse real commits, grouped by day`,
  },
  {
    kind: "term",
    img: "history-overview",
    title: HISTORY_TITLE,
    dur: 2.7,
    camera: HISTORY_CAMERA,
    cameraKey: "history",
    highlight: HISTORY_ROWS,
    highlightKey: "history",
    motion: 0.9,
    capKey: "history-browse",
    caption: `<span class="hl">j/k</span> moves through a responsive timeline`,
  },
  {
    kind: "term",
    img: "history-graph",
    title: HISTORY_TITLE,
    dur: 2.6,
    camera: HISTORY_CAMERA,
    capKey: "history-graph",
    caption: `switch from day groups to the optional <span class="hl">commit graph</span>`,
  },
  ...Array.from({ length: 3 }, (_, i) => ({
    kind: "term",
    img: `history-walk-${i + 1}`,
    title: HISTORY_TITLE,
    dur: i === 2 ? 0.65 : 0.25,
    camera: HISTORY_CAMERA,
    cameraKey: "history",
    highlight: HISTORY_ROWS,
    highlightKey: "history",
    capKey: "history-browse",
  })),
  {
    kind: "term",
    img: "history-range-1",
    title: HISTORY_TITLE,
    dur: 2,
    camera: RANGE_CAMERA,
    cameraKey: "history",
    highlight: {
      x: 0.01,
      y: 0.435,
      width: 0.96,
      height: RANGE_HEIGHTS[0],
      label: "visual range",
    },
    highlightKey: "history",
    motion: 0.65,
    capKey: "history-range",
    caption: `press <span class="hl">v</span> to start a commit range`,
  },
  ...Array.from({ length: 3 }, (_, i) => ({
    kind: "term",
    img: `history-range-${i + 2}`,
    title: HISTORY_TITLE,
    dur: i === 2 ? 0.9 : 0.35,
    camera: RANGE_CAMERA,
    cameraKey: "history",
    highlight: {
      x: 0.01,
      y: 0.435,
      width: 0.96,
      height: RANGE_HEIGHTS[i + 1],
      label: `${i + 2} commits selected`,
    },
    highlightKey: "history",
    motion: 0.28,
    capKey: "history-range",
  })),
  {
    kind: "term",
    img: "history-comparison",
    title: "hunk diff — selected commit range",
    dur: 2,
    camera: FULL_FRAME,
    motion: 0.8,
    capKey: "history-open",
    caption: `press <span class="hl">Enter</span> - review the selected comparison`,
  },
  {
    kind: "term",
    img: "history-comparison",
    title: "hunk diff — selected commit range",
    dur: 2.8,
    camera: FULL_FRAME,
    highlight: {
      x: 0.01,
      y: 0.025,
      width: 0.98,
      height: 0.29,
      label: "comparison context",
    },
    motion: 0.9,
    capKey: "history-context",
    caption: `commit context and revision IDs stay <span class="hl">beside the code</span>`,
  },
  { kind: "card", html: STATIC_CARD, dur: 2.3, enter: true },
  ...["static-history-typing-1", "static-history-typing-2", "static-history-typed"].map(
    (img, index) => ({
      kind: "term",
      img,
      title: "shell - history output",
      dur: index === 2 ? 0.7 : 0.3,
      camera: { x: 0.32, y: 0.22, scale: 1.35 },
      cameraKey: "static-history",
      capKey: "static-history-command",
      caption: `the same command has a compact <span class="hl">plain-text path</span>`,
      enter: index === 0,
    }),
  ),
  {
    kind: "term",
    img: "static-history-output",
    title: "shell - history output",
    dur: 2.8,
    camera: { x: 0.39, y: 0.3, scale: 1.25 },
    capKey: "static-history-output",
    caption: `use it in a pipe without launching the TUI`,
  },
  { kind: "card", html: SELECTION_CARD, dur: 2.4, enter: true },
  {
    kind: "term",
    img: "review-overview",
    title: REVIEW_TITLE,
    dur: 1.5,
    enter: true,
    camera: FULL_FRAME,
    cameraKey: "review",
    capKey: "selection-start",
    caption: `review still starts with the code`,
  },
  ...Array.from({ length: 4 }, (_, i) => ({
    kind: "term",
    img: `review-selection-${i + 1}`,
    title: REVIEW_TITLE,
    dur: i === 3 ? 1.8 : 0.35,
    camera: FULL_FRAME,
    cameraKey: "review",
    capKey: "selection-grow",
    caption:
      i === 0 ? `press <span class="hl">v</span>, then move - the selection persists` : undefined,
  })),
  {
    kind: "term",
    img: "review-draft",
    title: REVIEW_TITLE,
    dur: 1.3,
    camera: FULL_FRAME,
    cameraKey: "review",
    capKey: "selection-comment",
    caption: `comment on the whole range with <span class="hl">c</span>`,
  },
  {
    kind: "term",
    img: "review-typed",
    title: REVIEW_TITLE,
    dur: 1.5,
    camera: FULL_FRAME,
    cameraKey: "review",
    capKey: "selection-comment",
  },
  {
    kind: "term",
    img: "review-note-root",
    title: REVIEW_TITLE,
    dur: 2.5,
    camera: FULL_FRAME,
    cameraKey: "review",
    capKey: "selection-saved",
    caption: `the multiline anchor remains visible after saving`,
  },
  { kind: "card", html: THREAD_CARD, dur: 2.2, enter: true },
  {
    kind: "term",
    img: "review-reply-draft",
    title: REVIEW_TITLE,
    dur: 1.4,
    enter: true,
    camera: FULL_FRAME,
    cameraKey: "notes",
    capKey: "thread-reply",
    caption: `reply inline without leaving the review`,
  },
  {
    kind: "term",
    img: "review-reply-saved",
    title: REVIEW_TITLE,
    dur: 2.1,
    camera: FULL_FRAME,
    cameraKey: "notes",
    capKey: "thread-saved",
    caption: `threads keep their inherited code anchor`,
  },
  {
    kind: "term",
    img: "review-note-previous",
    title: REVIEW_TITLE,
    dur: 1.1,
    camera: FULL_FRAME,
    cameraKey: "notes",
    capKey: "thread-navigation",
    caption: `<span class="hl">N / n</span> moves the active note through the thread`,
  },
  {
    kind: "term",
    img: "review-note-next",
    title: REVIEW_TITLE,
    dur: 1.1,
    camera: FULL_FRAME,
    cameraKey: "notes",
    capKey: "thread-navigation",
  },
  { kind: "card", html: POLISH_CARD, dur: 2.3, enter: true },
  {
    kind: "term",
    img: "polish-unified",
    title: "hunk diff - unified",
    dur: 1.6,
    enter: true,
    camera: FULL_FRAME,
    cameraKey: "polish",
    capKey: "layout",
    caption: `<span class="hl">1</span> picks a unified review`,
  },
  {
    kind: "term",
    img: "polish-split",
    title: "hunk diff - split",
    dur: 2,
    camera: FULL_FRAME,
    cameraKey: "polish",
    capKey: "layout-split",
    caption: `<span class="hl">2</span> switches to side-by-side`,
  },
  {
    kind: "term",
    img: "polish-unified-return",
    title: "hunk diff - unified",
    dur: 0.8,
    camera: FULL_FRAME,
    cameraKey: "polish",
    capKey: "layout-return",
    caption: `the current review position stays put`,
  },
  {
    kind: "term",
    img: "polish-sidebar",
    title: "hunk diff - files",
    dur: 1.2,
    camera: FULL_FRAME,
    cameraKey: "polish",
    capKey: "sidebar",
    caption: `the files pane adapts to the terminal`,
  },
  {
    kind: "term",
    img: "polish-sidebar-tree",
    title: "hunk diff - files",
    dur: 1.4,
    camera: FULL_FRAME,
    cameraKey: "polish",
    capKey: "sidebar-tree",
    caption: `make it wider for a full folder tree`,
  },
  {
    kind: "term",
    img: "polish-sidebar-collapsed",
    title: "hunk diff - files",
    dur: 2,
    camera: FULL_FRAME,
    cameraKey: "polish",
    capKey: "sidebar-collapse",
    caption: `collapse folders with the mouse - navigation reveals hidden files`,
  },
  { kind: "card", html: FINISH_CARD, dur: 3.4, enter: true },
  { kind: "card", html: OUTRO_CARD, dur: 3.8, enter: true },
];

const result = await composeStoryboard({ shots: SHOTS, workDir, rootDir: repoRoot });
console.log(
  `${result.uniqueFrames} unique frames, ${result.totalSeconds.toFixed(1)}s total -> ${result.concatPath}`,
);

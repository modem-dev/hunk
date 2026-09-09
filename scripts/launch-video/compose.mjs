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

const HISTORY_TITLE = "hunk log — Git history";
const FULL_FRAME = { x: 0.5, y: 0.5, scale: 1 };
const HISTORY_CAMERA = { x: 0.39, y: 0.43, scale: 1.05 };
const RANGE_CAMERA = { x: 0.4, y: 0.65, scale: 1.1 };
const RANGE_HEIGHTS = [0.12, 0.27, 0.425, 0.515];
const HISTORY_ROWS = {
  x: 0.01,
  y: 0.02,
  width: 0.93,
  height: 0.925,
  label: "day-grouped history",
};

const OPEN_CARD = `
  <div class="badge">WHAT'S NEW</div>
  <h1>hunk</h1>
  <div class="sub">history is now a <span class="hl">review surface</span></div>
`;

const HISTORY_CARD = `
  <div class="badge">NEW</div>
  <h2>Review Git history</h2>
  <div class="cmds">
    <div class="cmd"><span class="p">❯</span> hunk log</div>
  </div>
  <div class="foot">real commits · one terminal · no context switching</div>
`;

const OUTRO_CARD = `
  <div class="badge">NEXT</div>
  <h2>From commits to comparisons</h2>
  <div class="sub">select a range · press Enter · <span class="hl">review the whole story</span></div>
  <div class="foot">github.com/modem-dev/hunk</div>
`;

// One entry per storyboard shot; timing/caption semantics are documented in
// @hunk/term-video/plan.
const SHOTS = [
  { kind: "card", html: OPEN_CARD, dur: 2.6, enter: true },
  { kind: "card", html: HISTORY_CARD, dur: 2.8, enter: true },
  {
    kind: "term",
    img: "history-overview",
    title: HISTORY_TITLE,
    dur: 2.4,
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
    dur: 3.2,
    camera: HISTORY_CAMERA,
    cameraKey: "history",
    highlight: HISTORY_ROWS,
    highlightKey: "history",
    motion: 0.9,
    capKey: "history-browse",
    caption: `<span class="hl">j/k</span> moves through a responsive timeline`,
  },
  ...Array.from({ length: 3 }, (_, i) => ({
    kind: "term",
    img: `history-walk-${i + 1}`,
    title: HISTORY_TITLE,
    dur: i === 2 ? 0.7 : 0.28,
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
    dur: 2.5,
    camera: RANGE_CAMERA,
    cameraKey: "history",
    highlight: {
      x: 0.01,
      y: 0.435,
      width: 0.88,
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
    dur: i === 2 ? 1.1 : 0.4,
    camera: RANGE_CAMERA,
    cameraKey: "history",
    highlight: {
      x: 0.01,
      y: 0.435,
      width: 0.88,
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
    dur: 2.5,
    camera: FULL_FRAME,
    motion: 0.8,
    capKey: "history-open",
    caption: `press <span class="hl">Enter</span> — review the selected comparison`,
  },
  {
    kind: "term",
    img: "history-comparison",
    title: "hunk diff — selected commit range",
    dur: 3.4,
    camera: { x: 0.35, y: 0.24, scale: 1.2 },
    highlight: {
      x: 0.01,
      y: 0.025,
      width: 0.82,
      height: 0.29,
      label: "comparison context",
    },
    motion: 0.9,
    capKey: "history-context",
    caption: `commit context stays <span class="hl">beside the code</span>`,
  },
  { kind: "card", html: OUTRO_CARD, dur: 3.6, enter: true },
];

const result = await composeStoryboard({ shots: SHOTS, workDir, rootDir: repoRoot });
console.log(
  `${result.uniqueFrames} unique frames, ${result.totalSeconds.toFixed(1)}s total -> ${result.concatPath}`,
);

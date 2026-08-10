// Hunk's current video storyboard: its shot list, cards, and captions,
// composited by @hunk/term-video.
//
//   node scripts/launch-video/compose.mjs <workDir>
//
// <workDir> is the capture output dir (contains frames/) and must have a
// node_modules with playwright-core matching the Chromium build (see
// skills/launch-video/SKILL.md). Composited frames land in <workDir>/out.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeStoryboard } from "@hunk/term-video/compose";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const workDir = resolve(process.argv[2] ?? join(repoRoot, ".video-work"));

const REVIEW_TITLE = "hunk diff — line-level review";
const STML_TITLE = "hunk patch — agent review";
// Shell scenes actually run bash; keep titles generic rather than naming a
// shell the capture doesn't launch.
const CLI_TITLE = "shell — authoring a note";
const PAGER_TITLE = "shell — git diff | hunk pager";
const TRIAGE_TITLE = "hunk diff — review-triage extension";
const GALLERY_TITLE = "hunk diff — file-view gallery extension";

const OPEN_CARD = `
  <div class="badge">v0.18.0</div>
  <h1>hunk</h1>
  <div class="sub">review agent changesets — <span class="hl">in your terminal</span></div>
`;

const EXTENSIONS_CARD = `
  <div class="badge">NEW</div>
  <h2>Extensions</h2>
  <div class="sub">one TypeScript file · <span class="hl">no build step</span></div>
  <div class="foot">sidebars · file views · commands · dialogs · themes · VCS backends</div>
`;

const OUTRO_CARD = `
  <h2>hunk 0.18 — out now</h2>
  <div class="cmds">
    <div class="cmd"><span class="p">❯</span> npm i -g hunkdiff</div>
    <div class="cmd"><span class="p">❯</span> brew install hunk</div>
  </div>
  <div class="foot">STML notes: --experimental &nbsp;·&nbsp; extensions: docs/extensions.md &nbsp;·&nbsp; github.com/modem-dev/hunk</div>
`;

// One entry per storyboard shot; timing/caption semantics are documented in
// @hunk/term-video/plan.
const SHOTS = [
  { kind: "card", html: OPEN_CARD, dur: 3.0, enter: true },
  {
    kind: "term",
    img: "review-walk-00",
    title: REVIEW_TITLE,
    dur: 1.0,
    enter: true,
    capKey: "cursor",
    caption: `<span class="badge">NEW</span> line-level review — <span class="hl">j/k</span> moves a real cursor`,
  },
  // The captured j/k walk plays back step by step: 9 more frames down the
  // diff (pausing at the bottom), then 4 back up to the line we comment on.
  ...Array.from({ length: 9 }, (_, i) => ({
    kind: "term",
    img: `review-walk-${String(i + 1).padStart(2, "0")}`,
    title: REVIEW_TITLE,
    dur: i === 8 ? 0.55 : 0.22,
    capKey: "cursor",
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    kind: "term",
    img: `review-walk-${10 + i}`,
    title: REVIEW_TITLE,
    dur: i === 3 ? 0.8 : 0.22,
    capKey: "cursor",
  })),
  {
    kind: "term",
    img: "review-draft",
    title: REVIEW_TITLE,
    dur: 1.4,
    capKey: "comment",
    caption: `press <span class="hl">c</span> — comment exactly where you're looking`,
  },
  { kind: "term", img: "review-typed", title: REVIEW_TITLE, dur: 2.0, capKey: "comment" },
  {
    kind: "term",
    img: "review-note",
    title: REVIEW_TITLE,
    dur: 2.6,
    capKey: "note",
    caption: `saved inline — right beside the change`,
  },
  {
    kind: "term",
    img: "stml-review",
    title: STML_TITLE,
    dur: 2.6,
    capKey: "notes",
    caption: `Agent notes ride along with <span class="hl">every diff</span>`,
  },
  {
    kind: "term",
    img: "stml-notes",
    title: STML_TITLE,
    dur: 4.2,
    capKey: "stml",
    caption: `<span class="badge">NEW</span> STML — notes are <span class="hl">markup</span>, rendered as terminal UI`,
  },
  { kind: "term", img: "stml-scroll-4", title: STML_TITLE, dur: 0.25, capKey: "stml" },
  { kind: "term", img: "stml-scroll-9", title: STML_TITLE, dur: 0.25, capKey: "stml" },
  {
    kind: "term",
    img: "stml-note-2",
    title: STML_TITLE,
    dur: 3.4,
    capKey: "vocab",
    caption: `badges · flow boxes · gauges · <span class="hl">code blocks</span>`,
  },
  {
    kind: "term",
    img: "cli-typing-10",
    title: CLI_TITLE,
    dur: 0.4,
    capKey: "cli",
    caption: `write it <span class="dim">→</span> preview it, straight from the CLI`,
  },
  { kind: "term", img: "cli-typing-22", title: CLI_TITLE, dur: 0.3, capKey: "cli" },
  { kind: "term", img: "cli-typing-34", title: CLI_TITLE, dur: 0.3, capKey: "cli" },
  { kind: "term", img: "cli-typed", title: CLI_TITLE, dur: 0.6, capKey: "cli" },
  {
    kind: "term",
    img: "cli-rendered",
    title: CLI_TITLE,
    dur: 3.0,
    capKey: "cli-out",
    caption: `<span class="hl">hunk markup render</span> — the exact output your reviewer sees`,
  },
  {
    kind: "term",
    img: "pager-typing-9",
    title: PAGER_TITLE,
    dur: 0.5,
    capKey: "pipe",
    caption: `<span class="badge">NEW</span> pipe anything — <span class="hl">git diff | hunk pager</span>`,
  },
  { kind: "term", img: "pager-typed", title: PAGER_TITLE, dur: 0.6, capKey: "pipe" },
  { kind: "term", img: "pager-review", title: PAGER_TITLE, dur: 2.2, capKey: "pipe" },
  {
    kind: "term",
    img: "pager-sidebar",
    title: PAGER_TITLE,
    dur: 2.6,
    capKey: "pipe-full",
    caption: `a <span class="hl">full review</span> from any pipe — sidebar, layouts, navigation`,
  },
  { kind: "card", html: EXTENSIONS_CARD, dur: 2.8, enter: true },
  {
    kind: "term",
    img: "triage-sidebar",
    title: TRIAGE_TITLE,
    dur: 3.4,
    capKey: "sidebar",
    caption: `<span class="badge">NEW</span> build <span class="hl">custom sidebars</span>`,
  },
  {
    kind: "term",
    img: "triage-select",
    title: TRIAGE_TITLE,
    dur: 2.8,
    capKey: "dialogs",
    caption: `register <span class="hl">commands & dialogs</span> on your own keys`,
  },
  { kind: "term", img: "triage-rationale", title: TRIAGE_TITLE, dur: 2.0, capKey: "dialogs" },
  {
    kind: "term",
    img: "triage-board",
    title: TRIAGE_TITLE,
    dur: 3.4,
    capKey: "board",
    caption: `<span class="dim">example:</span> a live triage board — <span class="hl">state, events, theme</span> in one API`,
  },
  {
    kind: "term",
    img: "fileview-palette-raw",
    title: GALLERY_TITLE,
    dur: 2.6,
    capKey: "fileview",
    caption: `<span class="badge">NEW</span> replace any diff with a <span class="hl">custom file view</span>`,
  },
  {
    kind: "term",
    img: "fileview-palette-rendered",
    title: GALLERY_TITLE,
    dur: 3.6,
    capKey: "swatches",
    caption: `<span class="dim">example:</span> press <span class="hl">F8</span> — a CSS palette becomes swatches`,
  },
  {
    kind: "term",
    img: "fileview-deps-rendered",
    title: GALLERY_TITLE,
    dur: 3.2,
    capKey: "semver",
    caption: `<span class="dim">example:</span> dependency bumps, highlighted by <span class="hl">semver</span>`,
  },
  { kind: "card", html: OUTRO_CARD, dur: 4.8, enter: true },
];

const result = await composeStoryboard({ shots: SHOTS, workDir, rootDir: repoRoot });
console.log(
  `${result.uniqueFrames} unique frames, ${result.totalSeconds.toFixed(1)}s total -> ${result.concatPath}`,
);

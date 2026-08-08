// Composites captured terminal keyframes into the launch-video frame sequence.
//
// Renders scripts/launch-video/stage.html in headless Chromium, drives it
// through the storyboard below, screenshots each unique frame, and writes an
// ffmpeg concat list with per-frame durations.
//
//   node scripts/launch-video/compose.mjs <workDir>
//
// <workDir> is the capture output dir (contains frames/ + manifest.json) and
// must have a node_modules with playwright-core@1.56.x installed (matching the
// preinstalled Chromium build). Composited frames land in <workDir>/out.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workDir = resolve(process.argv[2] ?? join(scriptDir, "../../.video-work"));
const framesDir = join(workDir, "frames");
const outDir = join(workDir, "out");
mkdirSync(outDir, { recursive: true });

const require = createRequire(join(workDir, "package.json"));
const { chromium } = require("playwright-core");

const FPS = 30;
const CAPTION_ANIM_SECONDS = 0.45;

// JetBrains Mono ships inside ghostty-opentui; its on-disk location depends on
// the package layout (bun isolated linker vs. hoisted node_modules).
const FONT_CANDIDATES = [
  "node_modules/.bun/node_modules/ghostty-opentui/public/jetbrains-mono-nerd.ttf",
  "node_modules/ghostty-opentui/public/jetbrains-mono-nerd.ttf",
].map((candidate) => resolve(scriptDir, "../..", candidate));
const FONT_PATH = FONT_CANDIDATES.find(existsSync);

/** file:// URL for a captured terminal keyframe. */
const frame = (name) => pathToFileURL(join(framesDir, `${name}.png`)).href;

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

// One entry per storyboard shot. `capKey` identifies caption identity so a
// caption only animates in when it actually changes between shots; `enter`
// animates the whole surface (cards, and the first terminal reveal).
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
  {
    kind: "term",
    img: "stml-scroll-4",
    title: STML_TITLE,
    dur: 0.25,
    capKey: "stml",
    captionFrom: "stml",
  },
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

async function main() {
  // Every terminal shot needs its keyframe on disk before we start a long
  // composite run; fail fast with the frame names instead of an opaque
  // img.decode error hundreds of frames in.
  const missing = SHOTS.filter(
    (shot) => shot.kind === "term" && !existsSync(join(framesDir, `${shot.img}.png`)),
  );
  if (missing.length > 0) {
    throw new Error(
      `missing keyframes in ${framesDir}:\n${missing.map((shot) => `  ${shot.img}`).join("\n")}\n` +
        `run capture.ts first (optionally SCENES=<scene> for a partial recapture)`,
    );
  }

  // Bake the caption font into a work-dir copy of the stage.
  const stageSource = readFileSync(join(scriptDir, "stage.html"), "utf8");
  if (!FONT_PATH) {
    throw new Error(`caption font not found; searched:\n${FONT_CANDIDATES.join("\n")}`);
  }
  const stagePath = join(workDir, "stage-built.html");
  writeFileSync(
    stageSource ? stagePath : stagePath,
    stageSource.replace("FONT_URL", pathToFileURL(FONT_PATH).href),
  );

  // Prefer an explicit override, then the sandbox's preinstalled Chromium,
  // then whatever playwright-core resolves on its own (e.g. after
  // `bunx playwright install chromium`).
  const executablePath =
    process.env.CHROMIUM_PATH ??
    (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    // Frame images load via file:// and get sampled through a canvas.
    args: ["--allow-file-access-from-files"],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(stagePath).href);

  const entries = [];
  let frameIndex = 0;

  async function emit(state, duration) {
    await page.evaluate((s) => window.renderShot(s), state);
    const file = `f${String(frameIndex).padStart(4, "0")}.png`;
    await page.screenshot({ path: join(outDir, file) });
    entries.push({ file, duration });
    frameIndex += 1;
  }

  let previousCapKey = null;
  let previousCaption = null;
  for (const shot of SHOTS) {
    // Continuation shots (same capKey, no caption of their own) keep the
    // caption their sequence opened with instead of blanking it.
    const caption =
      shot.caption ?? (shot.capKey && shot.capKey === previousCapKey ? previousCaption : null);
    const base =
      shot.kind === "card"
        ? { kind: "card", html: shot.html }
        : { kind: "term", img: frame(shot.img), title: shot.title, caption };
    const captionChanges = shot.kind === "term" && shot.caption && shot.capKey !== previousCapKey;
    const animSeconds =
      shot.enter || captionChanges ? Math.min(CAPTION_ANIM_SECONDS, shot.dur * 0.6) : 0;
    const animFrames = Math.round(animSeconds * FPS);

    for (let k = 0; k < animFrames; k += 1) {
      const t = (k + 1) / animFrames;
      await emit({ ...base, shotT: shot.enter ? t : 1, capT: captionChanges ? t : 1 }, 1 / FPS);
    }
    await emit({ ...base, shotT: 1, capT: 1 }, Math.max(shot.dur - animFrames / FPS, 1 / FPS));

    if (shot.kind === "term" && shot.caption) {
      previousCapKey = shot.capKey;
      previousCaption = shot.caption;
    } else if (shot.kind === "card") {
      previousCapKey = null;
      previousCaption = null;
    }
    console.log(`shot ${shot.kind === "term" ? shot.img : "card"} -> ${frameIndex} frames total`);
  }

  await browser.close();

  // ffmpeg concat demuxer input; the last file is repeated per the format spec.
  const lines = ["ffconcat version 1.0"];
  for (const entry of entries) {
    lines.push(`file '${join(outDir, entry.file)}'`);
    lines.push(`duration ${entry.duration.toFixed(5)}`);
  }
  lines.push(`file '${join(outDir, entries[entries.length - 1].file)}'`);
  writeFileSync(join(workDir, "concat.txt"), `${lines.join("\n")}\n`);

  const total = entries.reduce((sum, entry) => sum + entry.duration, 0);
  console.log(
    `${entries.length} unique frames, ${total.toFixed(1)}s total -> ${join(workDir, "concat.txt")}`,
  );
}

await main();

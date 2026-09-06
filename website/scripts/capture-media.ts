/**
 * Capture the landing page's feature media from the real Hunk TUI.
 *
 * Drives `bun run packages/hunk/src/main.tsx` inside a PTY (tuistory), renders styled
 * terminal frames to retina images (ghostty-opentui), and assembles the
 * animated captures into looping mp4 + webm clips with ffmpeg.
 *
 * This is an optional, Unix-oriented maintainer task like the other asset
 * refresh rituals in website/MEDIA.md; website builds and tests never run it.
 *
 * Usage, from the repository root:
 *   bun run website/scripts/capture-media.ts [stream|agent|mouse|layout|themes|shots]...
 *
 * With no arguments every asset is rebuilt. Video assets need an ffmpeg with
 * libx264 + libvpx-vp9; point FFMPEG at one if it is not on PATH.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTerminal, type Session } from "tuistory";

// ghostty-opentui is tuistory's own dependency; resolve it from tuistory's
// real location in the package store so this script needs no extra deps.
const tuistoryEntry = createRequire(import.meta.url).resolve("tuistory");
const ghosttyImageEntry = createRequire(tuistoryEntry).resolve("ghostty-opentui/image");
const { renderTerminalToImage } = await import(ghosttyImageEntry);

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "../..");
const publicDir = join(scriptsDir, "../public");
const pointerImage = join(scriptsDir, "assets/pointer.png");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";

/** Rendered pixels per terminal cell; must mirror ghostty-opentui's image math. */
const FONT_SIZE = 14;
const LINE_HEIGHT = 1.4;
const DPR = 2;
const CELL_W = FONT_SIZE * 0.6;
const CELL_H = Math.round(FONT_SIZE * LINE_HEIGHT);

const FPS = 30;

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function run(command: string, args: string[]) {
  const proc = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (proc.status !== 0) {
    const stderrTail = (proc.stderr ?? "").split("\n").slice(-12).join("\n");
    throw new Error(`${command} ${args.slice(0, 4).join(" ")}… failed:\n${stderrTail}`);
  }
}

/** Launch Hunk from source in an isolated PTY sized for capture. */
async function launchHunkForCapture(options: { args: string[]; cols: number; rows: number }) {
  const configHome = mkdtempSync(join(tmpdir(), "hunk-capture-config-"));
  const session = await launchTerminal({
    command: process.execPath,
    args: ["run", join(repoRoot, "packages/hunk/src/main.tsx"), "--", ...options.args],
    cwd: repoRoot,
    cols: options.cols,
    rows: options.rows,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      HUNK_MCP_DISABLE: "1",
      HUNK_DISABLE_UPDATE_NOTICE: "1",
    },
  });
  return {
    session,
    cleanup: () => {
      session.close();
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

interface PointerAt {
  col: number;
  row: number;
}

interface StoryFrame {
  /** Index into the deduplicated base-state PNG list. */
  stateIndex: number;
  holdMs: number;
  pointer?: PointerAt;
}

/**
 * Records a storyboard: deduplicated terminal states plus a timeline of
 * frames that reference them, so pointer glides reuse one rendered state.
 */
class Storyboard {
  private states: Buffer[] = [];
  private frames: StoryFrame[] = [];
  private lastPointer: PointerAt | undefined;

  constructor(private session: Session) {}

  private async captureState() {
    const png: Buffer = await renderTerminalToImage(this.session.getTerminalData(), {
      format: "png",
      devicePixelRatio: DPR,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
    });
    const previous = this.states.at(-1);
    if (previous && previous.equals(png)) {
      return this.states.length - 1;
    }
    this.states.push(png);
    return this.states.length - 1;
  }

  /** Capture the current terminal state and hold it. */
  async hold(holdMs: number, pointer?: PointerAt) {
    const stateIndex = await this.captureState();
    if (pointer) {
      this.lastPointer = pointer;
    }
    this.frames.push({ stateIndex, holdMs, pointer: this.lastPointer });
  }

  /** Send SGR mouse motion so the app reacts to hover while the pointer glides. */
  moveMouse(col: number, row: number) {
    this.session.writeRaw(`\x1b[<35;${col + 1};${row + 1}M`);
  }

  /** Glide the pointer between cells, re-capturing so hover reactions show. */
  async glide(from: PointerAt, to: PointerAt, durationMs: number) {
    const steps = Math.max(2, Math.round(durationMs / (1000 / FPS)));
    for (let step = 0; step <= steps; step += 1) {
      const col = from.col + ((to.col - from.col) * step) / steps;
      const row = from.row + ((to.row - from.row) * step) / steps;
      this.moveMouse(Math.round(col), Math.round(row));
      await sleep(12);
      const stateIndex = await this.captureState();
      this.lastPointer = { col, row };
      this.frames.push({ stateIndex, holdMs: durationMs / steps, pointer: this.lastPointer });
    }
  }

  /** Left-click at the pointer's current cell. */
  async click() {
    const pointer = this.lastPointer;
    if (!pointer) {
      throw new Error("click() needs a prior pointer position");
    }
    const col = Math.round(pointer.col) + 1;
    const row = Math.round(pointer.row) + 1;
    this.session.writeRaw(`\x1b[<0;${col};${row}M`);
    await sleep(30);
    this.session.writeRaw(`\x1b[<0;${col};${row}m`);
    await sleep(120);
  }

  /**
   * Assemble the timeline into looping mp4 + webm clips.
   *
   * Base states render once; pointer-bearing frames get the cursor composited
   * at the cell's pixel position before encoding.
   */
  async writeVideos(baseName: string) {
    const workDir = mkdtempSync(join(tmpdir(), `hunk-capture-${baseName}-`));
    try {
      await this.encodeTimeline(baseName, workDir);
    } finally {
      // A missing ffmpeg or failed encode must not strand retina frames in /tmp.
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async encodeTimeline(baseName: string, workDir: string) {
    const statePaths = this.states.map((buffer, index) => {
      const statePath = join(workDir, `state-${index}.png`);
      writeFileSync(statePath, buffer);
      return statePath;
    });

    // Composite each unique (state, rounded pointer position) pair only once.
    const compositeCache = new Map<string, string>();
    let compositeCount = 0;
    const frameForOutput = (frame: StoryFrame) => {
      if (!frame.pointer) {
        return statePaths[frame.stateIndex];
      }
      const x = Math.round(frame.pointer.col * CELL_W * DPR);
      const y = Math.round(frame.pointer.row * CELL_H * DPR);
      const cacheKey = `${frame.stateIndex}:${x}:${y}`;
      const cached = compositeCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const outPath = join(workDir, `composite-${compositeCount++}.png`);
      run(ffmpeg, [
        "-y",
        "-i",
        statePaths[frame.stateIndex],
        "-i",
        pointerImage,
        "-filter_complex",
        `overlay=${x}:${y}`,
        outPath,
      ]);
      compositeCache.set(cacheKey, outPath);
      return outPath;
    };

    const concatLines: string[] = ["ffconcat version 1.0"];
    for (const frame of this.frames) {
      const framePath = frameForOutput(frame);
      concatLines.push(`file '${framePath}'`);
      concatLines.push(`duration ${(frame.holdMs / 1000).toFixed(4)}`);
    }
    // The concat demuxer needs the last file repeated to honor its duration.
    const lastPath = frameForOutput(this.frames.at(-1)!);
    concatLines.push(`file '${lastPath}'`);
    const concatPath = join(workDir, "timeline.ffconcat");
    writeFileSync(concatPath, `${concatLines.join("\n")}\n`);

    const evenScale = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    run(ffmpeg, [
      "-y",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-vf",
      `fps=${FPS},${evenScale}`,
      "-c:v",
      "libx264",
      "-crf",
      "21",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      join(publicDir, `${baseName}.mp4`),
    ]);
    run(ffmpeg, [
      "-y",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-vf",
      `fps=${FPS},${evenScale}`,
      "-c:v",
      "libvpx-vp9",
      "-crf",
      "34",
      "-b:v",
      "0",
      "-pix_fmt",
      "yuv420p",
      join(publicDir, `${baseName}.webm`),
    ]);

    console.log(`${baseName}: ${this.frames.length} frames, ${this.states.length} states`);
  }
}

/** Wait for first paint plus the app settling into its initial layout. */
async function waitForReview(session: Session, pattern: RegExp) {
  await session.waitForText(pattern, { timeout: 30_000 });
  await sleep(1_200);
}

/** Still: the multi-file review stream with the sidebar, zoomed for the page. */
async function captureStream() {
  const { session, cleanup } = await launchHunkForCapture({
    args: ["patch", "examples/2-mini-app-refactor/change.patch"],
    cols: 124,
    rows: 32,
  });
  try {
    await waitForReview(session, /format\.ts/);
    await session.press("s");
    await sleep(600);
    const webp: Buffer = await renderTerminalToImage(session.getTerminalData(), {
      format: "webp",
      quality: 90,
      devicePixelRatio: DPR,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
    });
    writeFileSync(join(publicDir, "feature-stream.webp"), webp);
    console.log("feature-stream.webp written");
  } finally {
    cleanup();
  }
}

/** Video: mouse support — click a sidebar file, wheel-scroll, hover the note badge. */
async function captureMouse() {
  // Narrow columns keep glyphs readable when the clip renders at page width.
  const { session, cleanup } = await launchHunkForCapture({
    args: ["patch", "examples/2-mini-app-refactor/change.patch"],
    cols: 118,
    rows: 30,
  });
  try {
    await waitForReview(session, /format\.ts/);
    await session.press("s");
    await sleep(600);

    // Locate the sidebar row for the test file on the raw terminal grid —
    // session.text() is cleaned output whose line indexes can drift from
    // real rows, which would land the click on a group header.
    const grid = session.getTerminalData();
    const sidebarRow = grid.lines.findIndex((line: { spans: { text: string }[] }) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes("main.demo.ts"),
    );
    if (sidebarRow < 0) {
      throw new Error("Sidebar row for main.demo.ts not found");
    }

    const story = new Storyboard(session);
    await story.hold(900, { col: 60, row: 20 });

    // Glide to the sidebar and click a file: the stream jumps to it.
    await story.glide({ col: 60, row: 20 }, { col: 10, row: sidebarRow }, 900);
    await story.hold(350);
    await story.click();
    await sleep(250);
    await story.hold(1_300);

    // Glide back over the code and wheel-scroll the review stream.
    await story.glide({ col: 10, row: sidebarRow }, { col: 62, row: 14 }, 800);
    for (let i = 0; i < 5; i += 1) {
      session.writeRaw(`\x1b[<65;63;15M`);
      await sleep(60);
      await story.hold(220);
    }
    await story.hold(700);

    // Hover a changed row until the add-note affordance appears.
    await story.glide({ col: 62, row: 14 }, { col: 56, row: 11 }, 700);
    await sleep(250);
    await story.hold(1_600);

    await story.writeVideos("feature-mouse");
  } finally {
    cleanup();
  }
}

/** Video: agent notes rendered inline, following [ / ] hunk navigation. */
async function captureAgent() {
  const { session, cleanup } = await launchHunkForCapture({
    args: [
      "patch",
      "examples/3-agent-review-demo/change.patch",
      "--agent-context",
      "examples/3-agent-review-demo/agent-context.json",
    ],
    // Tighter than the other clips on purpose: the note card is the story,
    // and a small terminal renders it large even at the showcase column width.
    cols: 88,
    rows: 24,
  });
  try {
    await waitForReview(session, /normalize\.ts/);
    await session.press("a");
    await sleep(500);

    const story = new Storyboard(session);
    await story.hold(2_300);

    // Jump to the next hunk, then step down until its note card — which
    // renders below the hunk start — is fully inside the short viewport.
    await session.press("]");
    await sleep(400);
    await story.hold(700);
    for (let i = 0; i < 7; i += 1) {
      await session.press("down");
      await sleep(40);
      await story.hold(140);
    }
    await story.hold(2_600);

    await story.writeVideos("feature-agent");
  } finally {
    cleanup();
  }
}

/** Video: one diff flipping between split and stack layouts. */
async function captureLayout() {
  // No sidebar and a single pretty file: the layout change is the whole story,
  // and fewer columns keep both split panes readable at page width.
  const { session, cleanup } = await launchHunkForCapture({
    args: ["diff", "examples/4-ui-polish/before.tsx", "examples/4-ui-polish/after.tsx"],
    cols: 108,
    rows: 30,
  });
  try {
    await waitForReview(session, /after\.tsx/);

    const story = new Storyboard(session);
    await session.press("1");
    await sleep(400);
    await story.hold(1_900);
    await session.press("2");
    await sleep(400);
    await story.hold(1_900);
    await session.press("1");
    await sleep(400);
    await story.hold(1_900);

    await story.writeVideos("feature-layout");
  } finally {
    cleanup();
  }
}

/**
 * The themes the landing page's picker shows, in pill order.
 *
 * A spread of the bundled catalog rather than all of it: one neutral default,
 * the popular community palettes, a warm one, and a light one, so the picker
 * shows range at a glance. `ThemeShot.astro` names the rest beside them. Ids
 * are real bundled theme ids — check `BUNDLED_SHIKI_THEME_IDS` before editing,
 * because a renamed theme silently falls back instead of failing.
 */
const HERO_SHOT_THEMES = [
  { id: "github-dark-default", slug: "github-dark" },
  { id: "tokyo-night", slug: "tokyo-night" },
  { id: "catppuccin-mocha", slug: "catppuccin-mocha" },
  { id: "gruvbox-dark-medium", slug: "gruvbox" },
  { id: "nord", slug: "nord" },
  { id: "github-light-default", slug: "github-light" },
];

/** Stills: one split-view review per themed pill in the hero picker. */
async function captureShots() {
  for (const theme of HERO_SHOT_THEMES) {
    const { session, cleanup } = await launchHunkForCapture({
      args: [
        "patch",
        "examples/6-readme-screenshot/change.patch",
        "--agent-context",
        "examples/6-readme-screenshot/agent-context.json",
        "--mode",
        "split",
        "--theme",
        theme.id,
      ],
      // Wide and tall enough to hold the sidebar, both diff columns, and a
      // note card at once, which is the whole point of the hero frame.
      cols: 131,
      rows: 35,
    });
    try {
      await waitForReview(session, /ReviewSummaryCard/);
      // Sidebar and agent notes on, then hold at the first hunk: its note card
      // renders in place, so every theme is photographed with the same
      // furniture. Advancing a hunk scrolls that card out of frame.
      //
      // `s` reveals the sidebar rather than hiding it: the responsive default
      // only shows it on a "full" viewport, which starts at 220 columns (see
      // resolveResponsiveLayout), and this frame is 131.
      await session.press("s");
      await sleep(400);
      await session.press("a");
      await sleep(700);

      const webp: Buffer = await renderTerminalToImage(session.getTerminalData(), {
        format: "webp",
        quality: 90,
        devicePixelRatio: DPR,
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
      });
      writeFileSync(join(publicDir, `shot-${theme.slug}.webp`), webp);
      console.log(`shots: captured ${theme.id} -> shot-${theme.slug}.webp`);
    } finally {
      cleanup();
    }
  }
}

const MONTAGE_THEMES = [
  "midnight",
  "dracula",
  "catppuccin-mocha",
  "gruvbox-dark-medium",
  "github-light-default",
  "everforest-light",
  "zenburn",
  "ember",
];

/** Video: the same split diff crossfading across bundled themes. */
async function captureThemes() {
  const workDir = mkdtempSync(join(tmpdir(), "hunk-capture-themes-"));
  try {
    await captureThemeMontage(workDir);
  } finally {
    // A missing ffmpeg or failed encode must not strand retina stills in /tmp.
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function captureThemeMontage(workDir: string) {
  const stills: string[] = [];

  for (const theme of MONTAGE_THEMES) {
    const { session, cleanup } = await launchHunkForCapture({
      args: [
        "diff",
        "examples/4-ui-polish/before.tsx",
        "examples/4-ui-polish/after.tsx",
        "--mode",
        "split",
        "--theme",
        theme,
      ],
      cols: 108,
      rows: 30,
    });
    try {
      await waitForReview(session, /after\.tsx|ui-polish|Diff/i);
      const png: Buffer = await renderTerminalToImage(session.getTerminalData(), {
        format: "png",
        devicePixelRatio: DPR,
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
      });
      const stillPath = join(workDir, `${theme}.png`);
      writeFileSync(stillPath, png);
      stills.push(stillPath);
      console.log(`themes: captured ${theme}`);
    } finally {
      cleanup();
    }
  }

  // Crossfade the stills in a loop-friendly chain: hold each ~1.3s, fade 0.4s.
  const hold = 1.3;
  const fade = 0.4;
  const inputs = stills.flatMap((still) => ["-loop", "1", "-t", String(hold + fade), "-i", still]);
  const filters: string[] = [];
  let previousLabel = "[0:v]";
  for (let i = 1; i < stills.length; i += 1) {
    const outLabel = i === stills.length - 1 ? "[vout]" : `[x${i}]`;
    const offset = (hold * i).toFixed(3);
    filters.push(
      `${previousLabel}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${outLabel}`,
    );
    previousLabel = outLabel;
  }
  const filterGraph = filters.join(";");
  const evenScale = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

  run(ffmpeg, [
    "-y",
    ...inputs,
    "-filter_complex",
    `${filterGraph};[vout]fps=${FPS},${evenScale}[venc]`,
    "-map",
    "[venc]",
    "-c:v",
    "libx264",
    "-crf",
    "21",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    join(publicDir, "feature-themes.mp4"),
  ]);
  run(ffmpeg, [
    "-y",
    ...inputs,
    "-filter_complex",
    `${filterGraph};[vout]fps=${FPS},${evenScale}[venc]`,
    "-map",
    "[venc]",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "34",
    "-b:v",
    "0",
    "-pix_fmt",
    "yuv420p",
    join(publicDir, "feature-themes.webm"),
  ]);

  console.log("feature-themes videos written");
}

const ASSETS: Record<string, () => Promise<void>> = {
  stream: captureStream,
  agent: captureAgent,
  mouse: captureMouse,
  layout: captureLayout,
  themes: captureThemes,
  shots: captureShots,
};

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const names = requested.length > 0 ? requested : Object.keys(ASSETS);
mkdirSync(publicDir, { recursive: true });

for (const name of names) {
  const capture = ASSETS[name];
  if (!capture) {
    throw new Error(`Unknown asset "${name}". Valid: ${Object.keys(ASSETS).join(", ")}`);
  }
  await capture();
}

process.exit(0);

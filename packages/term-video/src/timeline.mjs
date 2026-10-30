// Timeline renderer: steps a motion page frame by frame in headless Chromium
// and encodes the frames with ffmpeg.
//
// Where compose.mjs plans discrete storyboard states for the shared stage,
// a timeline page owns all of its motion. The page contract is three globals:
//
//   window.timelineReady      promise that settles once fonts and images load
//   window.TIMELINE_DURATION  total length in seconds
//   window.renderAt(t)        async; paints the frame at t seconds
//
// renderAt must be a pure function of t so any frame renders on its own,
// which is what makes review stills and partial re-renders possible.
// playwright-core resolves from the caller's work directory, as in compose.mjs.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveChromium } from "./compose.mjs";

/** Frame timestamps for a duration, sampled from t = 0 at a fixed rate. */
export function frameTimes(duration, fps) {
  const total = Math.round(duration * fps);
  return Array.from({ length: total }, (_, frame) => frame / fps);
}

/** ffmpeg arguments that encode a numbered PNG sequence to a social-ready H.264 mp4. */
export function encodeArgs({ framesPattern, fps, output }) {
  return [
    "-y",
    "-loglevel",
    "error",
    "-framerate",
    String(fps),
    "-i",
    framesPattern,
    "-vf",
    "format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "18",
    "-movflags",
    "+faststart",
    output,
  ];
}

/**
 * Render a timeline page to stills or to an encoded mp4.
 *
 * @param {{
 *   pagePath: string,
 *   workDir: string,
 *   output?: string,
 *   stills?: number[],
 *   stillsDir?: string,
 *   fps?: number,
 *   viewport?: {width: number, height: number},
 *   chromiumPath?: string,
 *   log?: (message: string) => void,
 * }} options
 */
export async function renderTimeline(options) {
  const {
    pagePath,
    workDir,
    output = join(workDir, "timeline.mp4"),
    stills,
    stillsDir = join(workDir, "stills"),
    fps = 30,
    viewport = { width: 1920, height: 1080 },
    log = console.log,
  } = options;

  const require = createRequire(join(workDir, "package.json"));
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({
    executablePath: resolveChromium(options.chromiumPath),
    headless: true,
    // Pages load captured frames and images over file:// and sample them through canvases.
    args: ["--allow-file-access-from-files"],
  });

  try {
    const page = await browser.newPage({ viewport });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(pathToFileURL(pagePath).href);
    await page.evaluate(() => window.timelineReady);
    if (pageErrors.length > 0) {
      throw new Error(`timeline page failed to load:\n${pageErrors.join("\n")}`);
    }
    const duration = await page.evaluate(() => window.TIMELINE_DURATION);

    if (stills) {
      mkdirSync(stillsDir, { recursive: true });
      for (const t of stills) {
        await page.evaluate((time) => window.renderAt(time), t);
        await page.screenshot({ path: join(stillsDir, `t${t.toFixed(2)}.png`) });
      }
      log(`rendered ${stills.length} stills (duration ${duration.toFixed(2)}s) -> ${stillsDir}`);
      return { duration, stillsDir };
    }

    const framesDir = join(workDir, "timeline-frames");
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
    const times = frameTimes(duration, fps);
    for (const [frame, t] of times.entries()) {
      await page.evaluate((time) => window.renderAt(time), t);
      await page.screenshot({ path: join(framesDir, `f${String(frame).padStart(5, "0")}.png`) });
      if (frame % 60 === 0 || frame === times.length - 1) {
        log(`frame ${frame + 1}/${times.length}`);
      }
    }
    if (pageErrors.length > 0) {
      throw new Error(`timeline page errors while rendering:\n${pageErrors.join("\n")}`);
    }

    const ffmpeg = spawnSync(
      "ffmpeg",
      encodeArgs({ framesPattern: join(framesDir, "f%05d.png"), fps, output }),
      { stdio: "inherit" },
    );
    if (ffmpeg.status !== 0) {
      throw new Error("ffmpeg failed; check that it is on PATH with libx264");
    }
    log(`${times.length} frames, ${duration.toFixed(2)}s -> ${output}`);
    return { duration, frames: times.length, output };
  } finally {
    await browser.close();
  }
}

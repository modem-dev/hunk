// Storyboard compositor: renders planned frame states in headless Chromium
// against a stage template and writes PNG frames plus an ffmpeg concat list.
//
// Runs under plain Node (>=18). playwright-core is deliberately NOT a
// dependency of this package — it must match the Chromium build it drives, so
// the caller provides a work directory whose own node_modules carries the
// right version, and it is resolved from there at run time.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planFrames, requiredKeyframes } from "./plan.mjs";

const packageDir = dirname(fileURLToPath(import.meta.url));

/** Default stage template shipped with the package. */
export const DEFAULT_STAGE_PATH = join(packageDir, "stage.html");

/**
 * Locate the JetBrains Mono ttf that ships inside ghostty-opentui, whose
 * on-disk location depends on the package layout (bun isolated linker vs.
 * hoisted node_modules).
 */
export function findCaptionFont(rootDir) {
  const candidates = [
    "node_modules/.bun/node_modules/ghostty-opentui/public/jetbrains-mono-nerd.ttf",
    "node_modules/ghostty-opentui/public/jetbrains-mono-nerd.ttf",
  ].map((candidate) => resolve(rootDir, candidate));
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(`caption font not found; searched:\n${candidates.join("\n")}`);
  }
  return found;
}

/**
 * Pick the Chromium executable: an explicit override, then $CHROMIUM_PATH,
 * then the sandbox's preinstalled build, then playwright-core's own
 * resolution (undefined).
 */
export function resolveChromium(explicitPath) {
  return (
    explicitPath ??
    process.env.CHROMIUM_PATH ??
    (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined)
  );
}

/**
 * Composite a storyboard into <workDir>/out frames and <workDir>/concat.txt.
 *
 * @param {{
 *   shots: Array<object>,
 *   workDir: string,
 *   rootDir: string,
 *   framesDir?: string,
 *   stagePath?: string,
 *   fontPath?: string,
 *   chromiumPath?: string,
 *   fps?: number,
 *   captionAnimSeconds?: number,
 *   viewport?: {width: number, height: number},
 *   log?: (message: string) => void,
 * }} options
 */
export async function composeStoryboard(options) {
  const {
    shots,
    workDir,
    rootDir,
    framesDir = join(workDir, "frames"),
    stagePath = DEFAULT_STAGE_PATH,
    fps = 30,
    captionAnimSeconds = 0.45,
    viewport = { width: 1920, height: 1080 },
    log = console.log,
  } = options;
  const outDir = join(workDir, "out");
  mkdirSync(outDir, { recursive: true });

  // Fail fast with the missing frame names instead of an opaque img.decode
  // error hundreds of frames into a long composite run.
  const missing = requiredKeyframes(shots).filter(
    (name) => !existsSync(join(framesDir, `${name}.png`)),
  );
  if (missing.length > 0) {
    throw new Error(
      `missing keyframes in ${framesDir}:\n${missing.map((name) => `  ${name}`).join("\n")}\n` +
        `run the capture script first (optionally SCENES=<scene> for a partial recapture)`,
    );
  }

  const require = createRequire(join(workDir, "package.json"));
  const { chromium } = require("playwright-core");

  // Bake the caption font into a work-dir copy of the stage.
  const fontPath = options.fontPath ?? findCaptionFont(rootDir);
  const stageSource = readFileSync(stagePath, "utf8");
  const builtStagePath = join(workDir, "stage-built.html");
  writeFileSync(builtStagePath, stageSource.replace("FONT_URL", pathToFileURL(fontPath).href));

  const browser = await chromium.launch({
    executablePath: resolveChromium(options.chromiumPath),
    headless: true,
    // Frame images load via file:// and get sampled through a canvas.
    args: ["--allow-file-access-from-files"],
  });
  const page = await browser.newPage({ viewport });
  await page.goto(pathToFileURL(builtStagePath).href);

  const { frames, totalSeconds } = planFrames(shots, { fps, captionAnimSeconds });
  const entries = [];
  for (const [index, frame] of frames.entries()) {
    const state = { ...frame.state };
    if (state.kind === "term") {
      state.img = pathToFileURL(join(framesDir, `${state.img}.png`)).href;
    }
    await page.evaluate((s) => window.renderShot(s), state);
    const file = `f${String(index).padStart(4, "0")}.png`;
    await page.screenshot({ path: join(outDir, file) });
    entries.push({ file, duration: frame.duration });
    if (index % 25 === 0 || index === frames.length - 1) {
      log(`frame ${index + 1}/${frames.length}`);
    }
  }

  await browser.close();

  // ffmpeg concat demuxer input; the last file is repeated per the format spec.
  const lines = ["ffconcat version 1.0"];
  for (const entry of entries) {
    lines.push(`file '${join(outDir, entry.file)}'`);
    lines.push(`duration ${entry.duration.toFixed(5)}`);
  }
  lines.push(`file '${join(outDir, entries[entries.length - 1].file)}'`);
  const concatPath = join(workDir, "concat.txt");
  writeFileSync(concatPath, `${lines.join("\n")}\n`);

  return { uniqueFrames: entries.length, totalSeconds, concatPath, outDir };
}

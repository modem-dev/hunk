// Renders a release's social promo in Hunk's promo style.
//
//   node scripts/launch-video/promo/render.mjs <workDir> [--storyboard <file>]
//     [--stills 1.5,8.2] [--fps 30] [--out <file.mp4>]
//
// The storyboard (default: the newest in storyboards/) supplies the release
// content; engine.js supplies the style. <workDir> is the capture output dir:
// frames/ from capture.ts, contributors.json and avatars/ from
// contributors.mjs (optional; the credits scene is skipped without them), and
// a node_modules with playwright-core plus @fontsource-variable/jetbrains-mono.
// Output: <workDir>/promo-<version>.mp4, or review stills in <workDir>/stills/.
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findCaptionFont } from "@hunk/term-video/compose";
import { renderTimeline } from "@hunk/term-video/timeline";
import {
  loadStoryboard,
  parseArgs,
  promoDir,
  repoRoot,
  storyboardProblems,
} from "./storyboard.mjs";

const args = parseArgs(process.argv.slice(2));
const workDir = resolve(args.positional[0] ?? join(repoRoot, ".video-work"));
const { storyboard, path } = await loadStoryboard(args.flags.storyboard);
const framesDir = join(workDir, "frames");

const problems = storyboardProblems(storyboard);
if (problems.length > 0) {
  throw new Error(
    `${path} is not a valid storyboard:\n${problems.map((p) => `  ${p}`).join("\n")}`,
  );
}

// Fail fast on keyframes the storyboard names but capture.ts has not produced.
const missing = storyboard.chapters
  .flatMap((chapter) => chapter.frames.map((frame) => frame.img))
  .filter((name) => !existsSync(join(framesDir, `${name}.png`)));
if (missing.length > 0) {
  throw new Error(
    `missing keyframes in ${framesDir}:\n${[...new Set(missing)].map((name) => `  ${name}`).join("\n")}\n` +
      "run scripts/launch-video/capture.ts first (SCENES=<scene,...> for a partial capture)",
  );
}

const contributorsPath = join(workDir, "contributors.json");
const contributors = existsSync(contributorsPath)
  ? JSON.parse(readFileSync(contributorsPath, "utf8"))
  : [];
if (contributors.length === 0) {
  console.warn("no contributors.json in the work dir; skipping the credits scene");
}

const require = createRequire(join(workDir, "package.json"));
const fontPath =
  require.resolve("@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2");
const promo = {
  storyboard,
  contributors,
  framesUrl: pathToFileURL(framesDir).href,
  avatarsUrl: pathToFileURL(join(workDir, "avatars")).href,
};
const pagePath = join(workDir, "promo-built.html");
writeFileSync(
  pagePath,
  readFileSync(join(promoDir, "stage.html"), "utf8")
    .replace("FONT_URL", pathToFileURL(fontPath).href)
    .replace("NERD_FONT_URL", pathToFileURL(findCaptionFont(repoRoot)).href)
    .replace("ENGINE_URL", pathToFileURL(join(promoDir, "engine.js")).href)
    // Escape "<" so storyboard HTML strings cannot close the inline script.
    .replace("PROMO_JSON", JSON.stringify(promo).replaceAll("<", "\\u003c")),
);

console.log(`storyboard ${path}`);
await renderTimeline({
  pagePath,
  workDir,
  fps: Number(args.flags.fps ?? 30),
  stills: args.flags.stills?.split(",").map(Number),
  output: resolve(args.flags.out ?? join(workDir, `promo-${storyboard.version}.mp4`)),
});

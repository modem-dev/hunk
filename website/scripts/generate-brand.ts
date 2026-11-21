/** Exports transparent and solid-background logo downloads from the canonical SVGs; requires librsvg and zip. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { brandColors, brandDownloadPath, brandFormats, brandLogos } from "../src/data/brand";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const brandDir = join(publicDir, "brand");
const downloads = join(brandDir, "downloads");
await mkdir(downloads, { recursive: true });

/** Runs an export tool and fails rather than leaving silently missing downloads. */
async function run(command: string[], cwd = brandDir): Promise<void> {
  // A fixed epoch keeps PDF creation dates stable, so unchanged logos regenerate byte-for-byte.
  const env = { ...process.env, SOURCE_DATE_EPOCH: "0" };
  const result = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if ((await result.exited) !== 0) throw new Error(`Failed: ${command.join(" ")}`);
}

const files: string[] = [];
for (const logo of brandLogos) {
  const source = await readFile(join(brandDir, `${logo.id}.svg`), "utf8");
  for (const color of brandColors) {
    const svgPath = join(publicDir, brandDownloadPath(logo.id, color.id, "svg").slice(1));
    if (color.id !== "ink") {
      // Logos are plain filled paths, so recoloring the ink fill recolors the whole mark.
      await writeFile(svgPath, source.replaceAll("#16140f", color.value));
    }
    files.push(svgPath);
    for (const format of brandFormats) {
      if (format.id === "svg") continue;
      const output = join(publicDir, brandDownloadPath(logo.id, color.id, format.id).slice(1));
      const background = format.id === "solid-png" ? ["--background-color", color.background] : [];
      await run([
        "rsvg-convert",
        "--format",
        format.extension,
        "--width",
        "2048",
        ...background,
        "--output",
        output,
        svgPath,
      ]);
      files.push(output);
    }
  }
}

const guide = join(downloads, "README.txt");
await writeFile(
  guide,
  "Hunk brand assets — https://hunk.dev/brand/\n\nSVG: scalable originals. PNG: transparent, 2048px wide. Solid PNG: 2048px wide on the matching background. PDF: vector export.\nInk: for light backgrounds. Paper: for dark backgrounds.\nUse the flat mark below 40px. Keep proportions and leave clear space around the logo.\nDo not stretch, rotate, add effects, or imply endorsement by Hunk.\n",
);
await rm(join(brandDir, "hunk-brand.zip"), { force: true });
await run(["zip", "-j", "-X", "hunk-brand.zip", ...files, guide]);

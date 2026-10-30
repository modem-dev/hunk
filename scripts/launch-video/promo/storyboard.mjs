// Shared CLI plumbing for the promo scripts: argument parsing and storyboard loading.
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const promoDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(promoDir, "../../..");
export const storyboardsDir = join(promoDir, "storyboards");

/** Split argv into positional arguments and `--name value` flags. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

/** Compare release storyboard file names like 0.9.0.mjs < 0.24.0.mjs numerically. */
export function compareVersions(a, b) {
  const parts = (name) =>
    name
      .replace(/\.mjs$/, "")
      .split(/[.-]/)
      .map((part) => Number(part));
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Load a storyboard by path, defaulting to the newest release in storyboards/. */
export async function loadStoryboard(path) {
  const resolved = path
    ? resolve(path)
    : join(
        storyboardsDir,
        readdirSync(storyboardsDir)
          .filter((name) => name.endsWith(".mjs"))
          .sort(compareVersions)
          .at(-1),
      );
  const module = await import(pathToFileURL(resolved).href);
  return { storyboard: module.default, path: resolved };
}

/** Return the problems in a storyboard's shape; an empty list means it can render. */
export function storyboardProblems(storyboard) {
  const problems = [];
  if (typeof storyboard?.version !== "string" || !storyboard.version) {
    problems.push('version must be a non-empty string such as "0.25"');
  }
  if (!Array.isArray(storyboard?.chapters) || storyboard.chapters.length === 0) {
    problems.push("chapters must list at least one chapter");
    return problems;
  }
  for (const [index, chapter] of storyboard.chapters.entries()) {
    const at = `chapters[${index}]${chapter?.label ? ` (${chapter.label})` : ""}`;
    for (const field of ["label", "sub", "cmd", "winTitle"]) {
      if (typeof chapter[field] !== "string") problems.push(`${at}.${field} must be a string`);
    }
    if (!Array.isArray(chapter.title) || chapter.title.length === 0) {
      problems.push(`${at}.title must be a list of lines`);
    }
    if (!Array.isArray(chapter.frames) || chapter.frames.length === 0) {
      problems.push(`${at}.frames must list captured keyframes`);
    } else {
      for (const [frameIndex, frame] of chapter.frames.entries()) {
        if (typeof frame.img !== "string" || !(frame.dur > 0)) {
          problems.push(`${at}.frames[${frameIndex}] needs an img name and a positive dur`);
        }
      }
    }
    if (!Array.isArray(chapter.cameras) || chapter.cameras[0]?.[0] !== 0) {
      problems.push(`${at}.cameras must start with a camera at time 0`);
    }
    if (!Array.isArray(chapter.captions)) problems.push(`${at}.captions must be a list`);
  }
  return problems;
}

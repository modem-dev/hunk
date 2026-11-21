/**
 * Writes git repositories whose staged changes exercise every file shape the browser page
 * draws, for a real `hunk diff --staged --web` session to review.
 *
 * The rich review stages a multi-hunk file with expandable gaps, a renamed-and-edited file,
 * new, deleted, pure-rename, and binary files (one with a non-ASCII path), a file too large to
 * render, and forty small files so the sidebar and stream scroll. An agent-context sidecar
 * lists the files in the order the tests read them, which is the review's order (sidecar order
 * is intentional review order). `writeRichReviewGeneration` changes one file so a reload has
 * something to show. The many-file review stages `count` one-line edits across nested
 * directories, for windowing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Run one git command in a test repository with a fixed identity and no user config. */
function git(repo: string, ...args: string[]) {
  execFileSync(
    "git",
    ["-c", "user.name=Hunk Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: repo, stdio: "ignore" },
  );
}

/** Write one file, creating its directories. */
function writeTestFile(repo: string, path: string, contents: string | Uint8Array) {
  const target = join(repo, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** Start an empty repository with one base commit made from `files`. */
function commitBase(repo: string, files: Record<string, string | Uint8Array>) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  for (const [path, contents] of Object.entries(files)) writeTestFile(repo, path, contents);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
}

/**
 * Write the sidecar that fixes the review order to `paths`.
 *
 * It lives inside the repository, so a reload may name it (reloads refuse paths outside the
 * session's root), but under `.git/`, so no staged review ever includes it.
 */
function writeOrderSidecar(
  repo: string,
  paths: readonly string[],
  context: Readonly<Record<string, TestSidecarFileContext>> = {},
) {
  writeFileSync(
    reviewOrderSidecarPath(repo),
    JSON.stringify({ version: 1, files: paths.map((path) => ({ path, ...context[path] })) }),
  );
}

/** Agent context one test adds to a file of the sidecar: a summary and annotations. */
export interface TestSidecarFileContext {
  summary?: string;
  annotations?: ReadonlyArray<Record<string, unknown>>;
}

/** The sidecar path `writeOrderSidecar` wrote for one repository. */
export function reviewOrderSidecarPath(repo: string) {
  return join(repo, ".git", "hunk-review-order.json");
}

const MAIN_BEFORE = Array.from({ length: 60 }, (_unused, index) =>
  index === 12 ? "export const threshold = 5;" : `export const line${index} = ${index};`,
).join("\n");

/** Sixty lines of a TypeScript module, with two edits far enough apart to leave gaps. */
function mainSource(generation: number) {
  return Array.from({ length: 60 }, (_unused, index) => {
    if (index === 12) return `export const threshold = ${generation === 0 ? 10 : 25};`;
    if (index === 44)
      return `export function describe(value: number) {\n  return \`value: \${value}\`;\n}`;
    return `export const line${index} = ${index};`;
  }).join("\n");
}

const FILLER_COUNT = 40;

/** Eight lines, two of which the rename edits: similar enough for git to pair the paths. */
const RENAMED_BEFORE = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].map(
  (name, index) => `const ${name} = ${index + 1};`,
);

/** Every path of the rich review, in review order. */
export const RICH_REVIEW_PATHS: readonly string[] = [
  "src/app/main.ts",
  "src/app/renamed-new.ts",
  "docs/日本語 ノート.md",
  "old/legacy.txt",
  "assets/logo.svg",
  "assets/image.png",
  "data/huge.json",
  ...Array.from(
    { length: FILLER_COUNT },
    (_unused, index) => `src/gen/module-${String(index).padStart(2, "0")}.ts`,
  ),
];

/** Bytes that git treats as binary: a PNG signature followed by a NUL-laden body. */
function binaryTestBytes(seed: number) {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, seed, 0, 1, 2, 3]);
}

/** Build the rich review's repository at `repo` and stage its changes. */
export function writeRichReviewRepo(
  repo: string,
  context: Readonly<Record<string, TestSidecarFileContext>> = {},
) {
  rmSync(repo, { recursive: true, force: true });
  const base: Record<string, string | Uint8Array> = {
    "src/app/main.ts": `${MAIN_BEFORE}\n`,
    "src/app/renamed-old.ts": RENAMED_BEFORE.join("\n") + "\n",
    "old/legacy.txt": "legacy line one\nlegacy line two\n",
    "assets/logo-old.svg":
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n',
    "assets/image.png": binaryTestBytes(1),
    "data/huge.json": "[\n0,\n0,\n0\n]\n",
  };
  for (let index = 0; index < FILLER_COUNT; index += 1) {
    base[`src/gen/module-${String(index).padStart(2, "0")}.ts`] =
      `export const id = ${index};\nexport const label = "m${index}";\n`;
  }
  commitBase(repo, base);

  writeTestFile(repo, "src/app/main.ts", `${mainSource(0)}\n`);
  git(repo, "mv", "src/app/renamed-old.ts", "src/app/renamed-new.ts");
  writeTestFile(
    repo,
    "src/app/renamed-new.ts",
    RENAMED_BEFORE.map((line) =>
      line.replace("alpha = 1;", "alpha = 10;").replace("gamma = 3;", "gamma = 30;"),
    ).join("\n") + "\n",
  );
  writeTestFile(repo, "docs/日本語 ノート.md", "# ノート\n\nÜnïcödé paths survive the trip.\n");
  rmSync(join(repo, "old", "legacy.txt"));
  git(repo, "mv", "assets/logo-old.svg", "assets/logo.svg");
  writeTestFile(repo, "assets/image.png", binaryTestBytes(2));
  // Past the too-large bound (20,000 changed lines), so the review offers no hunks for it.
  writeTestFile(
    repo,
    "data/huge.json",
    `[\n${Array.from({ length: 25_000 }, (_unused, index) => `${index},`).join("\n")}\n0\n]\n`,
  );
  for (let index = 0; index < FILLER_COUNT; index += 1) {
    writeTestFile(
      repo,
      `src/gen/module-${String(index).padStart(2, "0")}.ts`,
      `export const id = ${index};\nexport const label = "module ${index}";\n`,
    );
  }
  git(repo, "add", "-A");
  writeOrderSidecar(repo, RICH_REVIEW_PATHS, context);
}

/** Stage the rich review's next generation: one changed line in the first file. */
export function writeRichReviewGeneration(repo: string, generation: number) {
  writeTestFile(repo, "src/app/main.ts", `${mainSource(generation)}\n`);
  git(repo, "add", "-A");
}

/** The path of one file of the many-file review. */
function manyReviewPath(index: number) {
  return `pkg${index % 20}/dir${Math.floor(index / 20) % 10}/file-${String(index).padStart(4, "0")}.ts`;
}

/** Build a review of `count` small edited files across nested directories, for windowing. */
export function writeManyReviewRepo(repo: string, count: number) {
  rmSync(repo, { recursive: true, force: true });
  const base: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    base[manyReviewPath(index)] =
      `export const value = ${index};\nexport const name = "a${index}";\n`;
  }
  commitBase(repo, base);
  for (let index = 0; index < count; index += 1) {
    writeTestFile(
      repo,
      manyReviewPath(index),
      `export const value = ${index + 1};\nexport const name = "a${index}";\n`,
    );
  }
  git(repo, "add", "-A");
  writeOrderSidecar(
    repo,
    Array.from({ length: count }, (_unused, index) => manyReviewPath(index)),
  );
}

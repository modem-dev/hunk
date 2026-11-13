/**
 * A review that exercises every file shape the browser page draws.
 *
 * Built from a real git patch (new, deleted, pure-rename, and binary files, one with a
 * non-ASCII path) through the real patch loader, plus files the patch format cannot express
 * directly: a multi-hunk file with expandable gaps and a source reader, a renamed-and-edited
 * file, a too-large file, and enough small files to make the sidebar and stream scroll.
 * `generation` changes one file's content so a reload has something to show.
 */
import { loadAppBootstrap } from "../../../packages/hunk/src/core/changeset/loaders";
import type { DiffFile } from "../../../packages/hunk/src/core/changeset/model";
import { createTestDiffFile, createTestSourceFetcher } from "../../helpers/diff-helpers";

const PATCH = [
  "diff --git a/docs/日本語 ノート.md b/docs/日本語 ノート.md",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/docs/日本語 ノート.md",
  "@@ -0,0 +1,3 @@",
  "+# ノート",
  "+",
  "+Ünïcödé paths survive the trip.",
  "diff --git a/old/legacy.txt b/old/legacy.txt",
  "deleted file mode 100644",
  "index 2222222..0000000",
  "--- a/old/legacy.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-legacy line one",
  "-legacy line two",
  "diff --git a/assets/logo-old.svg b/assets/logo.svg",
  "similarity index 100%",
  "rename from assets/logo-old.svg",
  "rename to assets/logo.svg",
  "diff --git a/assets/image.png b/assets/image.png",
  "index 3333333..4444444 100644",
  "Binary files a/assets/image.png and b/assets/image.png differ",
  "",
].join("\n");

/** Sixty lines of a TypeScript module, with two edits far enough apart to leave gaps. */
function mainSource(version: number) {
  return Array.from({ length: 60 }, (_unused, index) => {
    if (index === 12) return `export const threshold = ${version === 0 ? 10 : 25};`;
    if (index === 44)
      return `export function describe(value: number) {\n  return \`value: \${value}\`;\n}`;
    return `export const line${index} = ${index};`;
  }).join("\n");
}

const MAIN_BEFORE = Array.from({ length: 60 }, (_unused, index) =>
  index === 12 ? "export const threshold = 5;" : `export const line${index} = ${index};`,
).join("\n");

/** Every file of the rich review, in review order, for one generation. */
export async function buildRichReviewFiles(generation: number): Promise<DiffFile[]> {
  const after = `${mainSource(generation)}\n`;
  const main = createTestDiffFile({
    id: "main",
    path: "src/app/main.ts",
    before: `${MAIN_BEFORE}\n`,
    after,
    context: 3,
    sourceFetcher: createTestSourceFetcher((side) => (side === "new" ? after : `${MAIN_BEFORE}\n`)),
  });
  const renamed = createTestDiffFile({
    id: "renamed",
    path: "src/app/renamed-new.ts",
    previousPath: "src/app/renamed-old.ts",
  });
  const patched = await loadAppBootstrap({ kind: "patch", text: PATCH, options: {} });
  const tooLarge = createTestDiffFile({
    id: "too-large",
    path: "data/huge.json",
    language: "json",
  });
  const fillers = Array.from({ length: 40 }, (_unused, index) =>
    createTestDiffFile({
      id: `filler-${index}`,
      path: `src/gen/module-${String(index).padStart(2, "0")}.ts`,
      before: `export const id = ${index};\nexport const label = "m${index}";\n`,
      after: `export const id = ${index};\nexport const label = "module ${index}";\n`,
    }),
  );

  return [
    main,
    renamed,
    ...patched.changeset.files,
    {
      ...tooLarge,
      isTooLarge: true,
      metadata: { ...tooLarge.metadata, hunks: [], splitLineCount: 0, unifiedLineCount: 0 },
      stats: { additions: 120_000, deletions: 3 },
    },
    ...fillers,
  ];
}

/** A large review of `count` small files across nested directories, for windowing. */
export function buildManyReviewFiles(count: number): DiffFile[] {
  return Array.from({ length: count }, (_unused, index) =>
    createTestDiffFile({
      id: `many-${index}`,
      path: `pkg${index % 20}/dir${Math.floor(index / 20) % 10}/file-${String(index).padStart(4, "0")}.ts`,
      before: `export const value = ${index};\nexport const name = "a${index}";\n`,
      after: `export const value = ${index + 1};\nexport const name = "a${index}";\n`,
    }),
  );
}

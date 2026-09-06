import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type {
  ExtensionCommand,
  ExtensionCommandHandler,
  ExtensionFileView,
  HunkExtensionAPI,
} from "../packages/hunk/src/extension-api/types";
import { createTestDiffFile, createTestSourceFetcher } from "../test/helpers/diff-helpers";
import galleryExtension, {
  createChangeAtlasLayout,
  createCssPaletteLayout,
  createDependencyLayout,
  impactMeter,
  versionChangeHighlights,
} from "../examples/extensions/jsx-file-view-gallery";
import { createFileViewInput, fileViewHunkCount } from "../packages/hunk/src/ui/fileViews/host";
import { validateFileViewLayout } from "../packages/hunk/src/ui/fileViews/layout";

const galleryRoot = join(import.meta.dir, "../examples/extensions/jsx-file-view-gallery");

/** Build a real parsed diff input backed by one checked-in gallery fixture pair. */
function fixtureInput(fixture: string, beforePath: string, afterPath: string, displayPath: string) {
  const before = readFileSync(join(galleryRoot, "fixtures", fixture, beforePath), "utf8");
  const after = readFileSync(join(galleryRoot, "fixtures", fixture, afterPath), "utf8");
  const sourceFetcher = createTestSourceFetcher((side) => (side === "old" ? before : after));
  const file = createTestDiffFile({
    after,
    before,
    context: 3,
    id: fixture,
    path: displayPath,
    sourceFetcher,
  });
  return {
    file,
    input: createFileViewInput(file, 100, new AbortController().signal),
    sourceFetcher,
  };
}

/** Build an exact-source public input from inline text for fallback-policy coverage. */
function sourceInput(before: string, after: string, path: string) {
  const sourceFetcher = createTestSourceFetcher((side) => (side === "old" ? before : after));
  const file = createTestDiffFile({
    after,
    before,
    context: 3,
    id: `inline:${path}`,
    path,
    sourceFetcher,
  });
  return createFileViewInput(file, 100, new AbortController().signal);
}

/** Capture the public registrations made by the gallery extension. */
function registerGallery() {
  const views: ExtensionFileView[] = [];
  let command: ExtensionCommand | undefined;
  let handler: ExtensionCommandHandler | undefined;
  galleryExtension({
    registerFileView(view: ExtensionFileView) {
      views.push(view);
    },
    registerCommand(candidate: ExtensionCommand, candidateHandler: ExtensionCommandHandler) {
      command = candidate;
      handler = candidateHandler;
    },
  } as HunkExtensionAPI);
  return { views, command: command!, handler: handler! };
}

/** Assert one demo retains valid host-owned hunk geometry and fixed painters. */
function expectValidDemoLayout(
  layout: Awaited<ReturnType<ExtensionFileView["layout"]>>,
  hunkCount: number,
) {
  expect(layout).not.toBeNull();
  if (!layout) return;
  expect(layout.hunkRows).toHaveLength(hunkCount);
  expect(layout.rows.every((row) => row.spans.length > 0 && row.component)).toBe(true);
  expect(validateFileViewLayout(layout, hunkCount, 100).valid).toBe(true);
}

describe("JSX file-view gallery", () => {
  test("renders a responsive impact atlas for a real three-hunk TypeScript refactor", () => {
    const { file, input } = fixtureInput("change-atlas", "before.ts", "after.ts", "invoice.ts");
    const layout = createChangeAtlasLayout(input);

    expect(fileViewHunkCount(file)).toBe(3);
    expectValidDemoLayout(layout, 3);
    expect(layout?.rows.map((row) => row.component?.height)).toEqual([3, 3, 3]);
    expect(impactMeter(0, 4, 6)).toBe("░░░░░░");
    expect(layout?.rows.map((row) => row.spans[0]?.text)).toEqual([
      expect.stringContaining("Change 1:"),
      expect.stringContaining("Change 2:"),
      expect.stringContaining("Change 3:"),
    ]);
  });

  test("omits nonexistent source sides for added and deleted files", () => {
    for (const [before, after, expectedSide] of [
      ["", "export const added = true;\n", "new"],
      ["export const removed = true;\n", "", "old"],
    ] as const) {
      const input = sourceInput(before, after, expectedSide === "new" ? "added.ts" : "deleted.ts");
      const layout = createChangeAtlasLayout(input);
      const hunkCount = input.file.hunks?.length ?? 0;

      expectValidDemoLayout(layout, hunkCount);
      expect(
        layout?.rows.flatMap((row) => row.sourceRanges ?? []).map((range) => range.side),
      ).toEqual([expectedSide]);
    }
  });

  test("renders semantic old/new swatches from exact CSS documents", async () => {
    const { file, input, sourceFetcher } = fixtureInput(
      "css-palette",
      "before.css",
      "after.css",
      "theme.css",
    );
    const layout = await createCssPaletteLayout(input);

    expect(fileViewHunkCount(file)).toBe(2);
    expectValidDemoLayout(layout, 2);
    expect(layout?.rows.map((row) => row.spans[0]?.text).join("\n")).toContain(
      "--accent: #7aa2f7 → #b48ead",
    );
    expect(layout?.rows.map((row) => row.spans[0]?.text).join("\n")).toContain(
      "--card-highlight: #24304a → #3b3150",
    );
    expect(sourceFetcher.calls).toEqual(["old", "new"]);
  });

  test("highlights only the meaningful changed version segment", () => {
    expect(versionChangeHighlights("1.2.3", "1.2.4")).toEqual({
      old: { before: "1.2.", changed: "3", after: "" },
      new: { before: "1.2.", changed: "4", after: "" },
    });
    expect(versionChangeHighlights("1.2.9", "1.3.0")).toEqual({
      old: { before: "1.", changed: "2", after: ".9" },
      new: { before: "1.", changed: "3", after: ".0" },
    });
    expect(versionChangeHighlights("1.9.4", "2.1.0")).toEqual({
      old: { before: "", changed: "1.9.4", after: "" },
      new: { before: "", changed: "2.1.0", after: "" },
    });
    expect(versionChangeHighlights("^1.2.3", "~1.2.4")).toEqual({
      old: { before: "", changed: "^1.2.3", after: "" },
      new: { before: "", changed: "~1.2.4", after: "" },
    });
    expect(versionChangeHighlights("1.2.3-beta.1", "1.2.4-beta.2")).toEqual({
      old: { before: "", changed: "1.2.3-beta.1", after: "" },
      new: { before: "", changed: "1.2.4-beta.2", after: "" },
    });
  });

  test("renders highlighted versions from a real multi-hunk package update", async () => {
    const { file, input } = fixtureInput(
      "package-dependencies",
      "before/package.json",
      "after/package.json",
      "package.json",
    );
    const layout = await createDependencyLayout(input);
    const fallback = layout?.rows.map((row) => row.spans[0]?.text).join("\n");

    expect(fileViewHunkCount(file)).toBe(2);
    expectValidDemoLayout(layout, 2);
    expect(fallback).toContain("react: 19.1.0 → 19.2.0 (dependencies)");
    expect(fallback).toContain("typescript: 5.7.3 → 5.9.2 (devDependencies)");
  });

  test("falls back when conservative semantic parsing recognizes no rows", async () => {
    const unsupportedCss = sourceInput(
      ":root {\n  --accent: #12345;\n}\n",
      ":root {\n  --accent: #1234567;\n}\n",
      "theme.css",
    );
    const alphaCss = sourceInput(
      ":root {\n  --accent: #1234;\n}\n",
      ":root {\n  --accent: #12345678;\n}\n",
      "alpha.css",
    );
    const duplicateCss = sourceInput(
      ".a {\n  --accent: #111111;\n}\n.b {\n  --accent: #222222;\n}\n",
      ".a {\n  --accent: #333333;\n}\n.b {\n  --accent: #444444;\n}\n",
      "duplicate.css",
    );
    const emptyOldCss = sourceInput("", ":root {\n  --accent: #123456;\n}\n", "new.css");
    const metadataOnlyPackage = sourceInput(
      '{\n  "name": "demo",\n  "scripts": { "test": "bun test" }\n}\n',
      '{\n  "name": "demo",\n  "scripts": { "test": "bun test --watch" }\n}\n',
      "package.json",
    );
    const duplicateDependency = sourceInput(
      '{\n  "dependencies": {\n    "x": "1.0.0",\n    "x": "2.0.0"\n  }\n}\n',
      '{\n  "dependencies": {\n    "x": "1.0.1",\n    "x": "2.0.1"\n  }\n}\n',
      "package.json",
    );

    expect(await createCssPaletteLayout(unsupportedCss)).toBeNull();
    expect(await createCssPaletteLayout(alphaCss)).toBeNull();
    expect(await createCssPaletteLayout(duplicateCss)).toBeNull();
    expect(await createCssPaletteLayout(emptyOldCss)).not.toBeNull();
    expect(await createDependencyLayout(metadataOnlyPackage)).toBeNull();
    expect(await createDependencyLayout(duplicateDependency)).toBeNull();
  });

  test("registers one contextual F8 command for precise file-specific views", () => {
    const { views, command, handler } = registerGallery();
    expect(views.map((view) => view.id)).toEqual([
      "change-atlas",
      "palette-delta",
      "dependency-delta",
    ]);
    expect(command).toMatchObject({ id: "toggle-jsx-gallery", key: "f8" });
    expect(views[0]?.matches({ path: "after.ts", previousPath: "before.ts" } as never)).toBe(true);
    expect(views[1]?.matches({ path: "theme.css.map" } as never)).toBe(false);
    expect(views[2]?.matches({ path: "notes/package.json.md" } as never)).toBe(false);

    const toggled: string[] = [];
    for (const path of ["src/after.ts", "theme.css", "fixtures/package.json"]) {
      handler({
        fileViews: { toggle: (viewId: string) => toggled.push(viewId) },
        selection: { file: { path } },
      } as never);
    }
    expect(toggled).toEqual(["change-atlas", "palette-delta", "dependency-delta"]);
  });
});

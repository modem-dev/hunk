/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserReviewApiClient } from "../lib/apiClient";
import { HUNK_WEB_THEME } from "../lib/theme";
import type { BrowserReviewDocument, BrowserReviewFile } from "../lib/reviewTypes";
import { ReviewStream } from "./ReviewStream";

const api = {} as BrowserReviewApiClient;

function file(index: number, overrides: Partial<BrowserReviewFile> = {}): BrowserReviewFile {
  return {
    key: `file:${index}`,
    runtimeId: `runtime:${index}`,
    path: `src/file-${String(index).padStart(4, "0")}.ts`,
    changeKind: "change",
    additions: index,
    deletions: 1,
    statsTruncated: false,
    hunkCount: 1,
    flags: { untracked: false, binary: false, tooLarge: false, partial: true },
    patchResourceId: `patch:${index}`,
    canonicalResourceId: `canonical:${index}`,
    sourceResourceIds: {},
    hunks: [{ index: 0, header: "@@ -1 +1 @@", oldRange: [1, 1], newRange: [1, 1] }],
    notes: [],
    ...overrides,
  };
}

function document(files: BrowserReviewFile[]): BrowserReviewDocument {
  return {
    version: 1,
    generation: "generation:stream",
    documentIdentity: "document:stream",
    changesetId: "changeset:stream",
    title: "Continuous review",
    sourceLabel: "test",
    files,
    resources: [],
    capabilities: { actions: [] },
  };
}

function render(files: BrowserReviewFile[]) {
  return renderToStaticMarkup(
    <ReviewStream
      api={api}
      document={document(files)}
      mutableNotes={[]}
      onVisibleFile={() => {}}
      theme={HUNK_WEB_THEME}
    />,
  );
}

describe("continuous browser review stream", () => {
  test("keeps all state variants in one ordered stream", () => {
    const html = render([
      file(0, { changeKind: "rename-pure", previousPath: "src/old.ts", path: "src/new.ts" }),
      file(1, { changeKind: "new" }),
      file(2, { changeKind: "deleted" }),
      file(3, { flags: { untracked: true, binary: false, tooLarge: false, partial: true } }),
      file(4, { flags: { untracked: false, binary: true, tooLarge: false, partial: true } }),
      file(5, { flags: { untracked: false, binary: false, tooLarge: true, partial: true } }),
    ]);
    expect(html.match(/data-file-key=/g) ?? []).toHaveLength(6);
    expect(html.indexOf("src/new.ts")).toBeLessThan(html.indexOf("src/file-0001.ts"));
    expect(html).toContain("from src/old.ts");
    expect(html).toContain("added");
    expect(html).toContain("deleted");
    expect(html).toContain("untracked");
    expect(html).toContain("Binary file");
    expect(html).toContain("File too large");
    expect(html).toContain("Loading canonical review resource");
  });

  test("renders a bounded large-review shell without dropping or reordering files", () => {
    const files = Array.from({ length: 1_000 }, (_, index) => file(index));
    const started = performance.now();
    const html = render(files);
    expect(html.match(/data-file-key=/g) ?? []).toHaveLength(1_000);
    expect(html.indexOf(files[0]!.path)).toBeLessThan(html.indexOf(files.at(-1)!.path));
    expect(html.match(/data-window-state="mounted"/g) ?? []).toHaveLength(4);
    expect(html.match(/data-window-state="spacer"/g) ?? []).toHaveLength(996);
    expect(html.match(/class="review-file__spacer"/g) ?? []).toHaveLength(996);
    expect(html.match(/data-resource-state="loading"/g) ?? []).toHaveLength(4);
    expect(html.match(/data-resource-state="deferred"/g) ?? []).toHaveLength(996);
    expect(html.length).toBeLessThan(2_000_000);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

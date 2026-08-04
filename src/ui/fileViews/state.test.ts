import { describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "../../extension-api/types";
import type { RegisteredFileView } from "../../extensions/types";
import {
  bumpFileViewEpoch,
  reconcileFileViewEpochs,
  reconcileFileViewSelections,
  registeredFileViewKey,
  resolveBulkFileViewTarget,
  resolveRegisteredFileView,
  selectFileView,
  selectFileViewForFiles,
} from "./state";

describe("file-view selection state", () => {
  test("keeps valid per-file choices across reload while dropping stale ids and views", () => {
    expect(
      reconcileFileViewSelections(
        {
          readme: "preview:rendered",
          gone: "other:view",
          stale: "removed:view",
        },
        ["readme", "stale"],
        new Set(["preview:rendered"]),
      ),
    ).toEqual({ readme: "preview:rendered" });
  });

  test("preserves selection identity when reconciliation removes nothing", () => {
    const current = { readme: "preview:rendered" };
    expect(reconcileFileViewSelections(current, ["readme"], new Set(["preview:rendered"]))).toBe(
      current,
    );
    const empty = {};
    expect(reconcileFileViewSelections(empty, [], new Set())).toBe(empty);
  });

  test("stores raw implicitly and avoids needless state changes", () => {
    const active = selectFileView({}, "readme", "preview:rendered");
    expect(active).toEqual({ readme: "preview:rendered" });
    expect(selectFileView(active, "readme", "preview:rendered")).toBe(active);
    expect(selectFileView(active, "readme", null)).toEqual({});
  });

  test("offers a bulk target only while the selected file still matches", () => {
    const registered = {
      extensionId: "preview",
      view: {
        id: "rendered",
        title: "Rendered",
        matches: (file) => file.path.endsWith(".md"),
        layout: () => null,
      },
    } satisfies RegisteredFileView;
    const files = [
      { id: "selected", path: "selected.md" },
      { id: "other", path: "other.md" },
      { id: "source", path: "source.ts" },
    ] as unknown as ExtensionDiffFile[];
    expect(
      resolveBulkFileViewTarget({
        current: { selected: "preview:rendered" },
        files,
        registered,
        selectedFileId: "selected",
      }),
    ).toEqual({ key: "preview:rendered", fileIds: ["selected", "other"] });

    expect(
      resolveBulkFileViewTarget({
        current: { selected: "preview:rendered" },
        files: [
          { id: "selected", path: "selected.bin" },
          ...files.slice(1),
        ] as unknown as ExtensionDiffFile[],
        registered,
        selectedFileId: "selected",
      }),
    ).toBeNull();
  });

  test("applies one view to matching files without changing nonmatches", () => {
    const current = { first: "preview:old", second: "other:view", untouched: "raw:custom" };
    const selected = selectFileViewForFiles(current, ["first", "second"], "preview:new");

    expect(selected).toEqual({
      first: "preview:new",
      second: "preview:new",
      untouched: "raw:custom",
    });
    expect(selectFileViewForFiles(selected, ["first", "second"], "preview:new")).toBe(selected);
    expect(selectFileViewForFiles(current, [], "preview:new")).toBe(current);
  });

  test("counts refreshes per view from an implicit zero and always changes map identity", () => {
    const first = bumpFileViewEpoch(new Map(), "preview:rendered");
    expect([...first]).toEqual([["preview:rendered", 1]]);

    const second = bumpFileViewEpoch(first, "preview:rendered");
    expect(second).not.toBe(first);
    expect(second.get("preview:rendered")).toBe(2);
    // One view's invalidation never disturbs another's prepared layouts.
    expect(bumpFileViewEpoch(second, "other:view").get("preview:rendered")).toBe(2);
  });

  test("drops epochs for views a reload removed while preserving identity otherwise", () => {
    const current = bumpFileViewEpoch(
      bumpFileViewEpoch(new Map(), "preview:rendered"),
      "gone:view",
    );
    expect([...reconcileFileViewEpochs(current, new Set(["preview:rendered"]))]).toEqual([
      ["preview:rendered", 1],
    ]);
    expect(reconcileFileViewEpochs(current, new Set(["preview:rendered", "gone:view"]))).toBe(
      current,
    );
    const empty = new Map<string, number>();
    expect(reconcileFileViewEpochs(empty, new Set())).toBe(empty);
  });

  test("allows an extension view id named raw because only null is the raw sentinel", () => {
    const rawNamedView = {
      extensionId: "preview",
      view: { id: "raw" },
    } as RegisteredFileView;

    expect(registeredFileViewKey(rawNamedView)).toBe("preview:raw");
    expect(resolveRegisteredFileView([rawNamedView], "preview", "raw")).toBe(rawNamedView);
    expect(resolveRegisteredFileView([rawNamedView], "other", "preview:raw")).toBe(rawNamedView);
  });
});

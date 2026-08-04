import { describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "../../extension-api/types";
import type { RegisteredFileView } from "../../extensions/types";
import {
  bumpFileViewEpoch,
  fileViewLayoutEpoch,
  reconcileFileViewEpochs,
  reconcileFileViewSelections,
  registeredFileViewKey,
  resolveBulkFileViewTarget,
  resolveFileViewSelectionTarget,
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
    expect(fileViewLayoutEpoch(first, "preview:rendered", "readme")).toBe(1);

    const second = bumpFileViewEpoch(first, "preview:rendered");
    expect(second).not.toBe(first);
    expect(fileViewLayoutEpoch(second, "preview:rendered", "readme")).toBe(2);
    // One view's invalidation never disturbs another's prepared layouts.
    const other = bumpFileViewEpoch(second, "other:view");
    expect(fileViewLayoutEpoch(other, "preview:rendered", "readme")).toBe(2);
  });

  test("scopes a refresh to one file without disturbing the view's other presentations", () => {
    const viewWide = bumpFileViewEpoch(new Map(), "preview:rendered");
    const scoped = bumpFileViewEpoch(viewWide, "preview:rendered", "readme");

    expect(fileViewLayoutEpoch(scoped, "preview:rendered", "readme")).toBe(2);
    // The other file presenting the same view keeps the epoch its prepared layout is retained under.
    expect(fileViewLayoutEpoch(scoped, "preview:rendered", "other")).toBe(
      fileViewLayoutEpoch(viewWide, "preview:rendered", "other"),
    );
    // Either kind of bump always moves the composed epoch, whichever order they arrive in.
    expect(
      fileViewLayoutEpoch(
        bumpFileViewEpoch(scoped, "preview:rendered"),
        "preview:rendered",
        "other",
      ),
    ).toBe(2);
    expect(fileViewLayoutEpoch(new Map(), "preview:rendered", "readme")).toBe(0);
  });

  test("keeps arbitrary view ids distinct from file-scoped epoch keys", () => {
    const controlCharacterView = "preview:bad\0view";
    const similarlyShapedView = "preview:bad";
    const current = bumpFileViewEpoch(new Map(), controlCharacterView);
    const scoped = bumpFileViewEpoch(current, similarlyShapedView, "view");

    expect(fileViewLayoutEpoch(scoped, controlCharacterView, "other")).toBe(1);
    expect(fileViewLayoutEpoch(scoped, similarlyShapedView, "view")).toBe(1);
    expect(fileViewLayoutEpoch(scoped, similarlyShapedView, "other")).toBe(0);
  });

  test("drops epochs for views and files a reload removed while preserving identity otherwise", () => {
    const current = bumpFileViewEpoch(
      bumpFileViewEpoch(
        bumpFileViewEpoch(bumpFileViewEpoch(new Map(), "preview:rendered"), "gone:view"),
        "preview:rendered",
        "readme",
      ),
      "preview:rendered",
      "deleted",
    );
    const kept = reconcileFileViewEpochs(current, ["readme"], new Set(["preview:rendered"]));

    expect(fileViewLayoutEpoch(kept, "preview:rendered", "readme")).toBe(2);
    // A scoped entry outlives neither its view nor the file it names.
    expect(fileViewLayoutEpoch(kept, "preview:rendered", "deleted")).toBe(1);
    expect(fileViewLayoutEpoch(kept, "gone:view", "readme")).toBe(0);

    expect(
      reconcileFileViewEpochs(
        current,
        ["readme", "deleted"],
        new Set(["preview:rendered", "gone:view"]),
      ),
    ).toBe(current);
    const empty = new Map<string, number>();
    expect(reconcileFileViewEpochs(empty, [], new Set())).toBe(empty);
  });

  test("names why a view cannot become the selected file's presentation", () => {
    const file = { id: "readme", path: "README.md" } as unknown as ExtensionDiffFile;
    const view = (matches: (file: ExtensionDiffFile) => boolean) =>
      ({ extensionId: "preview", view: { id: "rendered", matches } }) as RegisteredFileView;
    const target = {
      extensionId: "preview",
      file,
      unavailableReason: undefined,
      viewId: "rendered",
    };

    const registered = view(() => true);
    expect(resolveFileViewSelectionTarget({ ...target, registered })).toEqual({
      ok: true,
      registered,
    });
    expect(resolveFileViewSelectionTarget({ ...target, registered: undefined })).toEqual({
      ok: false,
      refusal: 'Extension preview targeted unknown file view "rendered"',
    });
    expect(resolveFileViewSelectionTarget({ ...target, registered: view(() => false) })).toEqual({
      ok: false,
      refusal: 'File view "rendered" does not match the selected file • using raw diff',
    });
    expect(
      resolveFileViewSelectionTarget({
        ...target,
        registered: view(() => {
          throw new Error("matcher exploded");
        }),
      }),
    ).toEqual({
      ok: false,
      refusal: 'Extension preview file view "rendered" failed matching the selected file',
    });
    // A host constraint outranks the view: the file is staying on raw diff.
    expect(
      resolveFileViewSelectionTarget({ ...target, registered, unavailableReason: "raw only" }),
    ).toEqual({ ok: false, refusal: "raw only" });
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

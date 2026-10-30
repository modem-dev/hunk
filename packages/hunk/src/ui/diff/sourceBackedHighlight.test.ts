import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import {
  createSourceBackedHighlightPlan,
  remapSourceBackedHighlight,
} from "./sourceBackedHighlight";

const PARTIAL_PATCH = `diff --git a/repro.ex b/repro.ex
--- a/repro.ex
+++ b/repro.ex
@@ -4,4 +4,4 @@
   Line two.
-  Line three.
+  Line three, edited.
   """
   def hello do
`;
const OLD_SOURCE = `defmodule Repro do
  @doc """
  Line one.
  Line two.
  Line three.
  """
  def hello do
    :world
  end
end
`;
const NEW_SOURCE = OLD_SOURCE.replace("Line three.", "Line three, edited.");

/** Parse one test patch into its single partial file metadata object. */
function parsePartialMetadata(patch = PARTIAL_PATCH) {
  const metadata = parsePatchFiles(patch, "source-backed-test", true)[0]?.files[0];
  if (!metadata) {
    throw new Error("Expected one partial patch file");
  }
  return metadata;
}

describe("source-backed highlight planning", () => {
  test("grafts validated source prefixes and remaps them to partial line indexes", () => {
    const metadata = parsePartialMetadata();
    const plan = createSourceBackedHighlightPlan(
      metadata,
      OLD_SOURCE.replaceAll("\n", "\r\n"),
      NEW_SOURCE,
    );

    expect(plan).not.toBeNull();
    if (!plan) {
      throw new Error("Expected a source-backed highlight plan");
    }

    expect(plan.metadata.isPartial).toBe(false);
    expect(plan.metadata.deletionLines[0]).toBe("defmodule Repro do\n");
    expect(plan.metadata.deletionLines.at(-1)).toBe("  def hello do\n");
    expect(plan.deletionLineMap).toEqual([3, 4, 5, 6]);
    expect(plan.additionLineMap).toEqual([3, 4, 5, 6]);

    const remapped = remapSourceBackedHighlight(plan, {
      deletionLines: plan.metadata.deletionLines.map((_, index) => `old-${index}`),
      additionLines: plan.metadata.additionLines.map((_, index) => `new-${index}`),
    });
    expect(remapped.deletionLines).toEqual(["old-3", "old-4", "old-5", "old-6"]);
    expect(remapped.additionLines).toEqual(["new-3", "new-4", "new-5", "new-6"]);
  });

  test("rejects source snapshots that raced or do not match the visible patch", () => {
    const metadata = parsePartialMetadata();

    expect(
      createSourceBackedHighlightPlan(
        metadata,
        OLD_SOURCE,
        NEW_SOURCE.replace("Line two.", "A mismatched hidden snapshot."),
      ),
    ).toBeNull();
    expect(createSourceBackedHighlightPlan(metadata, null, NEW_SOURCE)).toBeNull();
  });

  test("accepts an absent side for added and deleted files", () => {
    const addedPatch = `diff --git a/added.ex b/added.ex
new file mode 100644
--- /dev/null
+++ b/added.ex
@@ -0,0 +1,2 @@
+@doc """
+body
\\ No newline at end of file
`;
    const deletedPatch = `diff --git a/deleted.ex b/deleted.ex
deleted file mode 100644
--- a/deleted.ex
+++ /dev/null
@@ -1,2 +0,0 @@
-@doc """
-body
\\ No newline at end of file
`;

    const added = createSourceBackedHighlightPlan(
      parsePartialMetadata(addedPatch),
      null,
      '@doc """\nbody',
    );
    const deleted = createSourceBackedHighlightPlan(
      parsePartialMetadata(deletedPatch),
      '@doc """\nbody',
      null,
    );

    expect(added?.metadata.deletionLines).toEqual([]);
    expect(added?.metadata.additionLines.at(-1)).toBe("body");
    expect(deleted?.metadata.additionLines).toEqual([]);
    expect(deleted?.metadata.deletionLines.at(-1)).toBe("body");
  });
});

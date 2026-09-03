import { describe, expect, test } from "bun:test";
import { changesetFromPatch } from "./fromPatch";

/**
 * A hunk body line is always exactly one sign char plus its content, so a content line
 * that happens to start with `++` or `--` (e.g. `++i;`, `--flag`) reads `+++…`/`---…`
 * in the patch. File headers never appear inside a hunk, so content lines decide their
 * own index in the per-side line arrays.
 */
const ADDITION_PLUS_PREFIX_PATCH = [
  "diff --git a/add_plus.txt b/add_plus.txt",
  "index 0000000..1111111 100644",
  "--- a/add_plus.txt",
  "+++ b/add_plus.txt",
  "@@ -1,3 +1,4 @@",
  " one",
  "\u001b[1;35m-two\u001b[m",
  "\u001b[32m+++ plus\u001b[m",
  "\u001b[36m+three\u001b[m",
  " four",
  "",
].join("\n");

const DELETION_MINUS_PREFIX_PATCH = [
  "diff --git a/del_minus.txt b/del_minus.txt",
  "index 0000000..2222222 100644",
  "--- a/del_minus.txt",
  "+++ b/del_minus.txt",
  "@@ -1,3 +1,3 @@",
  " one",
  "\u001b[1;35m--- flag\u001b[m",
  "\u001b[36m+two\u001b[m",
  " three",
  "",
].join("\n");

describe("collectLineMoveKinds", () => {
  test("indexes an added content line that starts with ++', not its following lines' move kind", () => {
    const changeset = changesetFromPatch(ADDITION_PLUS_PREFIX_PATCH, "t", "probe", null);
    const file = changeset.files.find((entry) => entry.path === "add_plus.txt")!;

    expect(file.metadata.additionLines).toEqual(["one\n", "++ plus\n", "three\n", "four\n"]);
    expect(file.lineMoveKinds?.additionLines).toEqual([undefined, undefined, "moved", undefined]);
  });

  test("indexes a deleted content line that starts with --', keeping its move kind", () => {
    const changeset = changesetFromPatch(DELETION_MINUS_PREFIX_PATCH, "t", "probe", null);
    const file = changeset.files.find((entry) => entry.path === "del_minus.txt")!;

    expect(file.metadata.deletionLines).toEqual(["one\n", "-- flag\n", "three\n"]);
    expect(file.lineMoveKinds?.deletionLines).toEqual([undefined, "moved", undefined]);
  });
});

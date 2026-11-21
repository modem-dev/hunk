import { describe, expect, test } from "bun:test";
import { changesetFromPatch } from "./fromPatch";

const goodFile = [
  "diff --git a/notes.txt b/notes.txt",
  "new file mode 100644",
  "index 0000000000..3b18e512d6",
  "--- /dev/null",
  "+++ b/notes.txt",
  "@@ -0,0 +1,2 @@",
  "+hello",
  "+world",
  "",
].join("\n");

// A hunk body whose line counts disagree with its header: unparseable, but it
// must not take the rest of the review down with it.
const poisonFile = [
  "diff --git a/evil.bin b/evil.bin",
  "new file mode 100644",
  "index 0000000000..1234567890",
  "--- /dev/null",
  "+++ b/evil.bin",
  "@@ -0,0 +1,5 @@",
  "+hello",
  "+world",
  "",
].join("\n");

describe("changesetFromPatch", () => {
  test("parses a clean multi-file patch unchanged", () => {
    const changeset = changesetFromPatch(
      `${goodFile}${goodFile.replaceAll("notes.txt", "other.txt")}`,
      "title",
      "label",
      null,
    );
    expect(changeset.files.length).toBe(2);
    expect(changeset.files[0]?.path).toBe("notes.txt");
    expect(changeset.files[1]?.path).toBe("other.txt");
  });

  test("keeps good files when one file chunk is unparseable", () => {
    // Regression test: a single poisoned file used to make the whole-patch
    // parse throw, and the catch-all returned zero files for the review.
    // The fallback keeps the good file and a placeholder for the bad one.
    const changeset = changesetFromPatch(`${goodFile}${poisonFile}`, "title", "label", null);
    expect(changeset.files.length).toBe(2);
    expect(changeset.files[0]?.path).toBe("notes.txt");
    expect(changeset.files[1]?.path).toBe("evil.bin");
    expect(changeset.files[1]?.metadata.hunks).toEqual([]);
    expect(changeset.files[1]?.patch).toContain("Skipped file with unparseable diff content");
  });

  test("preserves file order and content on both sides of an unparseable chunk", () => {
    const changeset = changesetFromPatch(
      `${goodFile}${poisonFile}${goodFile.replaceAll("notes.txt", "last.txt")}`,
      "title",
      "label",
      null,
    );

    expect(changeset.files.map((file) => file.path)).toEqual(["notes.txt", "evil.bin", "last.txt"]);
    expect(changeset.files[0]?.stats).toEqual({ additions: 2, deletions: 0 });
    expect(changeset.files[2]?.stats).toEqual({ additions: 2, deletions: 0 });
    expect(changeset.files[2]?.patch).toContain("diff --git a/last.txt b/last.txt");
  });

  test("keeps placeholders when every file chunk is unparseable", () => {
    const changeset = changesetFromPatch(poisonFile, "title", "label", null);

    expect(changeset.files.map((file) => file.path)).toEqual(["evil.bin"]);
    expect(changeset.title).toBe("title");
    expect(changeset.sourceLabel).toBe("label");
  });

  test("retains exact quoted paths and both fetcher builders during fallback", () => {
    const sourcePaths: string[] = [];
    const bytePaths: string[] = [];
    const changeset = changesetFromPatch(
      `${poisonFile}${goodFile
        .replaceAll("a/notes.txt", '"a/notes\\tfile.txt"')
        .replaceAll("b/notes.txt", '"b/notes\\tfile.txt"')}`,
      "title",
      "label",
      null,
      {
        sourceFetcherBuilder: ({ path }) => {
          sourcePaths.push(path);
          return undefined;
        },
        byteFetcherBuilder: ({ path }) => {
          bytePaths.push(path);
          return undefined;
        },
      },
    );

    expect(changeset.files.map((file) => file.path)).toEqual(["evil.bin", "notes\tfile.txt"]);
    expect(sourcePaths).toEqual(["evil.bin", "notes\tfile.txt"]);
    expect(bytePaths).toEqual(sourcePaths);
  });
});

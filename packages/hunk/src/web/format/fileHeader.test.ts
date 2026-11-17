import { describe, expect, test } from "bun:test";
import { webFileHeaderPath, webFileStateChip } from "./fileHeader";

describe("webFileHeaderPath", () => {
  test("splits a path into its directory and basename", () => {
    expect(
      webFileHeaderPath({ path: "src/app/main.ts", changeKind: "change", untracked: false }),
    ).toEqual({ text: "src/app/main.ts", directory: "src/app/", basename: "main.ts" });
    expect(
      webFileHeaderPath({ path: "README.md", changeKind: "change", untracked: false }),
    ).toEqual({ text: "README.md", directory: "", basename: "README.md" });
  });

  test("keeps a rename's old name apart and its text as the shared label", () => {
    const sameDirectory = webFileHeaderPath({
      path: "src/app/renamed-new.ts",
      previousPath: "src/app/renamed-old.ts",
      changeKind: "rename-changed",
      untracked: false,
    });
    expect(sameDirectory).toEqual({
      text: "src/app/renamed-old.ts -> renamed-new.ts",
      from: "src/app/renamed-old.ts",
      directory: "",
      basename: "renamed-new.ts",
    });

    const moved = webFileHeaderPath({
      path: "b/new.ts",
      previousPath: "a/old.ts",
      changeKind: "rename-pure",
      untracked: false,
    });
    expect(moved).toEqual({
      text: "a/old.ts -> b/new.ts",
      from: "a/old.ts",
      directory: "b/",
      basename: "new.ts",
    });
    expect(`${moved.from} -> ${moved.directory}${moved.basename}`).toBe(moved.text);
  });
});

describe("webFileStateChip", () => {
  test("names the change kind and says nothing for a plain modification", () => {
    expect(webFileStateChip({ changeKind: "change", untracked: false })).toBeNull();
    expect(webFileStateChip({ changeKind: "new", untracked: false })).toBe("new");
    expect(webFileStateChip({ changeKind: "new", untracked: true })).toBe("untracked");
    expect(webFileStateChip({ changeKind: "deleted", untracked: false })).toBe("deleted");
  });

  test("says why a file renders no rows", () => {
    expect(
      webFileStateChip({ changeKind: "rename-pure", untracked: false, emptyReason: "rename-only" }),
    ).toBe("renamed, no content changes");
    expect(
      webFileStateChip({ changeKind: "change", untracked: false, emptyReason: "binary" }),
    ).toBe("binary");
    expect(
      webFileStateChip({ changeKind: "change", untracked: false, emptyReason: "too-large" }),
    ).toBe("too large");
    expect(webFileStateChip({ changeKind: "new", untracked: false, emptyReason: "new-file" })).toBe(
      "new · empty",
    );
  });

  test("adds a binary file's sizes when given", () => {
    expect(
      webFileStateChip({
        changeKind: "change",
        untracked: false,
        emptyReason: "binary",
        sizes: "135 B → 127 B",
      }),
    ).toBe("binary · 135 B → 127 B");
  });
});

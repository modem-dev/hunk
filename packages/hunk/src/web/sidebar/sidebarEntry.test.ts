import { describe, expect, test } from "bun:test";
import { treePathsOf } from "./sidebarEntry";

describe("treePathsOf", () => {
  test("keeps distinct paths as they are", () => {
    expect(treePathsOf([{ path: "src/a.ts" }, { path: "src/b.ts" }])).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  // Intent: the model allows two files at one path (a delete and an add), and the tree keys
  // rows by path, so a repeat needs its own path or one file has no row to select.
  test("gives every repeated path its own row, avoiding paths already in the review", () => {
    const paths = treePathsOf([
      { path: "src/a.ts" },
      { path: "src/a.ts (2)" },
      { path: "src/a.ts" },
      { path: "src/a.ts" },
    ]);

    expect(paths).toEqual(["src/a.ts", "src/a.ts (2)", "src/a.ts (3)", "src/a.ts (4)"]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  // Intent: the tree draws names as plain text, so an override would fake the extension.
  test("spells out hidden characters, keeping files that differ only by one apart", () => {
    const paths = treePathsOf([
      { path: "file\u202Etxt.exe" },
      { path: "file<U+202E>txt.exe" },
      { path: "docs/שלום.md" },
    ]);

    expect(paths).toEqual(["file<U+202E>txt.exe", "file<U+202E>txt.exe (2)", "docs/שלום.md"]);
  });

  // Intent: the tree keys folders by path too, so two different folders must never merge
  // (their rows, selection, and viewed roll-ups would combine).
  test("keeps folders distinct when spelling makes their names collide", () => {
    const paths = treePathsOf([
      { path: "a\u200B/one.ts" },
      { path: "a<U+200B>/two.ts" },
      { path: "a<U+200B>/one.ts" },
      { path: "a\u200B/three.ts" },
    ]);

    expect(paths).toEqual([
      "a<U+200B>/one.ts",
      "a<U+200B> (2)/two.ts",
      "a<U+200B> (2)/one.ts",
      "a<U+200B>/three.ts",
    ]);
    const folder = (path: string) => path.slice(0, path.lastIndexOf("/"));
    expect(folder(paths[0]!)).toBe(folder(paths[3]!));
    expect(folder(paths[1]!)).toBe(folder(paths[2]!));
    expect(folder(paths[0]!)).not.toBe(folder(paths[1]!));
  });

  test("keeps a literal suffixed name its own spelling", () => {
    expect(treePathsOf([{ path: "a.ts" }, { path: "a.ts" }, { path: "a.ts (2)" }])).toEqual([
      "a.ts",
      "a.ts (3)",
      "a.ts (2)",
    ]);
  });
});

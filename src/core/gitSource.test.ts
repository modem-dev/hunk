import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gitEndpointSourceSpec } from "./gitSource";

describe("gitEndpointSourceSpec", () => {
  test("maps every endpoint kind to a source spec", () => {
    expect(gitEndpointSourceSpec({ kind: "none" }, "/repo", "a.ts")).toEqual({ kind: "none" });
    expect(gitEndpointSourceSpec({ kind: "git-ref", ref: "HEAD" }, "/repo", "a.ts")).toEqual({
      kind: "git-blob",
      repoRoot: "/repo",
      ref: "HEAD",
      path: "a.ts",
    });
    expect(gitEndpointSourceSpec({ kind: "index" }, "/repo", "a.ts")).toEqual({
      kind: "git-index",
      repoRoot: "/repo",
      path: "a.ts",
    });
    expect(gitEndpointSourceSpec({ kind: "worktree" }, "/repo", "a.ts")).toEqual({
      kind: "fs",
      absolutePath: join("/repo", "a.ts"),
    });
  });
});

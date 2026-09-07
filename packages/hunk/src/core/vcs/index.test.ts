import { describe, expect, test } from "bun:test";
import { HunkUserError } from "../run/errors";
import {
  createUnsupportedVcsOperationError,
  createVcsCatalog,
  detectVcs,
  extendVcsCatalog,
  getConfiguredVcsAdapter,
  getDefaultVcsAdapter,
  getVcsAdapter,
  isVcsId,
  isVcsReviewInput,
  loadVcsReview,
  operationFromInput,
} from ".";
import type { VcsAdapter } from "./types";

function adapter(
  id: string,
  options: {
    root?: string;
    priority?: number;
    operations?: VcsAdapter["operations"];
  } = {},
): VcsAdapter {
  return {
    id,
    name: id.toUpperCase(),
    detectionPriority: options.priority,
    detect: () => (options.root ? { id, repoRoot: options.root } : null),
    operations: options.operations ?? {},
  };
}

describe("VCS catalog", () => {
  test("orders detection by priority while preserving tie order", () => {
    const catalog = createVcsCatalog(
      [adapter("first", { priority: 10 }), adapter("low"), adapter("second", { priority: 10 })],
      "first",
    );
    expect(catalog.adapters.map((entry) => entry.id)).toEqual(["first", "second", "low"]);
  });

  test("extends without replacing reserved or already claimed ids", () => {
    const git = adapter("git");
    const base = createVcsCatalog([git], "git");
    const catalog = extendVcsCatalog(base, [adapter("git"), adapter("hg"), adapter("hg")]);

    expect(catalog.adapters.map((entry) => entry.id)).toEqual(["git", "hg"]);
    expect(catalog.reservedIds).toEqual(new Set(["git"]));
    expect(isVcsId("git", catalog)).toBe(true);
    expect(isVcsId("hg", catalog)).toBe(false);
  });

  test("resolves configured and default adapters from the supplied catalog", () => {
    const git = adapter("git");
    const hg = adapter("hg");
    const catalog = createVcsCatalog([git, hg], "git", ["git"]);

    expect(getDefaultVcsAdapter(catalog)).toBe(git);
    expect(getConfiguredVcsAdapter(undefined, catalog)).toBe(git);
    expect(getVcsAdapter("hg", catalog)).toBe(hg);
    expect(() => getVcsAdapter("missing", catalog)).toThrow("Unsupported VCS: missing");
  });

  test("detects the nearest root before consulting same-root priority", () => {
    const catalog = createVcsCatalog(
      [
        adapter("outer-high", { root: "/repo", priority: 100 }),
        adapter("inner", { root: "/repo/nested", priority: 0 }),
      ],
      "outer-high",
    );
    expect(detectVcs("/repo/nested/src", catalog)?.id).toBe("inner");
  });

  test("uses priority for colocated detections and isolates throwing adapters", () => {
    const broken: VcsAdapter = {
      id: "broken",
      name: "Broken",
      detectionPriority: 1_000,
      detect: () => {
        throw new Error("boom");
      },
      operations: {},
    };
    const catalog = createVcsCatalog(
      [broken, adapter("low", { root: "/repo" }), adapter("high", { root: "/repo", priority: 5 })],
      "low",
    );
    expect(detectVcs("/repo/src", catalog)?.id).toBe("high");
  });
});

describe("VCS operation dispatch", () => {
  test("classifies exactly the adapter-backed review inputs", () => {
    expect(isVcsReviewInput({ kind: "vcs", staged: false, options: {} })).toBe(true);
    expect(isVcsReviewInput({ kind: "show", options: {} })).toBe(true);
    expect(isVcsReviewInput({ kind: "stash-show", options: {} })).toBe(true);
    expect(isVcsReviewInput({ kind: "patch", file: "change.patch", options: {} })).toBe(false);
    expect(isVcsReviewInput({ kind: "diff", left: "a", right: "b", options: {} })).toBe(false);
  });

  test("maps review inputs to operation keys", () => {
    expect(operationFromInput({ kind: "vcs", staged: false, options: {} }).kind).toBe(
      "working-tree-diff",
    );
    expect(operationFromInput({ kind: "show", options: {} }).kind).toBe("revision-show");
    expect(operationFromInput({ kind: "stash-show", options: {} }).kind).toBe("stash-show");
  });

  test("loads through the selected operation", async () => {
    const git = adapter("git", {
      operations: {
        "working-tree-diff": {
          async load(_input, { cwd }) {
            return { repoRoot: cwd, sourceLabel: cwd, title: "review", patchText: "" };
          },
        },
      },
    });
    const catalog = createVcsCatalog([git], "git");
    const input = { kind: "vcs", staged: false, options: {} } as const;
    const result = await loadVcsReview(git, operationFromInput(input), { cwd: "/repo" }, catalog);
    expect(result.repoRoot).toBe("/repo");
  });

  test("recommends a supporting adapter from the active catalog", () => {
    const git = adapter("git", {
      operations: {
        "stash-show": {
          async load() {
            return { repoRoot: "/repo", sourceLabel: "/repo", title: "stash", patchText: "" };
          },
        },
      },
    });
    const jj = adapter("jj");
    const catalog = createVcsCatalog([jj, git], "git");
    const error = createUnsupportedVcsOperationError(jj, "stash-show", catalog);
    expect(error).toBeInstanceOf(HunkUserError);
    expect(error.message).toContain("requires GIT VCS mode");
  });
});

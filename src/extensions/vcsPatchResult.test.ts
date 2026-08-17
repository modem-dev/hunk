import { describe, expect, test } from "bun:test";
import { toInternalVcsPatchResult } from "./vcsPatchResult";
import { HunkExtensionUserError } from "../extension-api/types";
import { HunkUserError, toUserFacingError } from "../core/run/errors";
import { SourceTextTooLargeError } from "../core/changeset/fileSource";
import { toInternalVcsAdapter } from "./runExtension";
import type {
  ExtensionVcsFileSourceRequest,
  ExtensionVcsPatchResult,
} from "../extension-api/types";

const ADDED_FILE_PATCH = [
  "diff --git a/note.txt b/note.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/note.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  "",
].join("\n");

function baseResult(overrides: Partial<ExtensionVcsPatchResult> = {}): ExtensionVcsPatchResult {
  return {
    repoRoot: "/repo",
    sourceLabel: "/repo",
    title: "demo working copy",
    patchText: "",
    ...overrides,
  };
}

describe("published source readers", () => {
  test("become a per-file fetcher that reads each side once", async () => {
    const requests: ExtensionVcsFileSourceRequest[] = [];
    const result = toInternalVcsPatchResult(
      baseResult({
        sourceCacheKey: "snapshot-1",
        readFileSource: async (request) => {
          requests.push(request);
          return `${request.side} text`;
        },
      }),
    );

    const fetcher = result.sourceFetcherBuilder?.({
      path: "src/a.ts",
      previousPath: "src/old.ts",
      type: "rename-changed",
      isUntracked: false,
      isBinary: false,
    });

    expect(fetcher?.cacheKey).toBe("snapshot-1");
    expect(await fetcher?.getFullText("old")).toBe("old text");
    expect(await fetcher?.getFullText("new")).toBe("new text");
    // Asking again is served from the cache the boundary owns, so an adapter
    // never has to memoize reads itself.
    expect(await fetcher?.getFullText("old")).toBe("old text");
    expect(requests).toEqual([
      {
        path: "src/a.ts",
        previousPath: "src/old.ts",
        changeType: "rename-changed",
        isUntracked: false,
        side: "old",
      },
      {
        path: "src/a.ts",
        previousPath: "src/old.ts",
        changeType: "rename-changed",
        isUntracked: false,
        side: "new",
      },
    ]);
  });

  test("are never consulted for binary files", () => {
    let calls = 0;
    const result = toInternalVcsPatchResult(
      baseResult({
        readFileSource: async () => {
          calls += 1;
          return "unreachable";
        },
      }),
    );

    expect(
      result.sourceFetcherBuilder?.({
        path: "logo.png",
        type: "change",
        isUntracked: false,
        isBinary: true,
      }),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("do not cache a failed read, so expansion can be retried", async () => {
    let attempts = 0;
    const result = toInternalVcsPatchResult(
      baseResult({
        readFileSource: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("source too large");
          }
          return "recovered";
        },
      }),
    );

    const fetcher = result.sourceFetcherBuilder?.({
      path: "src/a.ts",
      type: "change",
      isUntracked: false,
      isBinary: false,
    });

    await expect(fetcher?.getFullText("new")).rejects.toThrow("source too large");
    expect(await fetcher?.getFullText("new")).toBe("recovered");
  });

  test("translate and cache public too-large results without re-reading the adapter", async () => {
    let attempts = 0;
    const result = toInternalVcsPatchResult(
      baseResult({
        readFileSource: async () => {
          attempts += 1;
          return attempts === 1 ? { kind: "too-large", maxBytes: 42 } : "recovered";
        },
      }),
    );
    const fetcher = result.sourceFetcherBuilder?.({
      path: "src/a.ts",
      type: "change",
      isUntracked: false,
      isBinary: false,
    });

    await expect(fetcher?.getFullText("new")).rejects.toEqual(new SourceTextTooLargeError(42));
    await expect(fetcher?.getFullText("new")).rejects.toEqual(new SourceTextTooLargeError(42));
    expect(attempts).toBe(1);
  });

  test("are absent when the result declares none", () => {
    expect(toInternalVcsPatchResult(baseResult()).sourceFetcherBuilder).toBeUndefined();
  });
});

describe("published extra files", () => {
  test("build a diff file from a one-file patch, labeled with the declared path", () => {
    const result = toInternalVcsPatchResult(
      baseResult({
        readFileSource: async () => "hello\n",
        extraFiles: [
          { kind: "patch", path: "note.txt", patchText: ADDED_FILE_PATCH, isUntracked: true },
        ],
      }),
    );

    const [file] = result.extraFiles ?? [];
    expect(file?.id).toBe("/repo:0:note.txt");
    expect(file?.path).toBe("note.txt");
    expect(file?.isUntracked).toBe(true);
    expect(file?.stats).toEqual({ additions: 1, deletions: 0 });
    expect(file?.metadata.type).toBe("new");
    // Patch entries share the result's source reader; skipped ones cannot.
    expect(file?.sourceFetcher).toBeDefined();
  });

  test("build a placeholder for a skipped file with no content to read", () => {
    const result = toInternalVcsPatchResult(
      baseResult({
        extraFiles: [
          {
            kind: "skipped",
            path: "generated.txt",
            reason: "too-large",
            changeType: "new",
            isUntracked: true,
            stats: { additions: 100_001, deletions: 0 },
            statsTruncated: true,
          },
        ],
        readFileSource: async () => "unreachable",
      }),
    );

    const [file] = result.extraFiles ?? [];
    expect(file?.path).toBe("generated.txt");
    expect(file?.isTooLarge).toBe(true);
    expect(file?.isUntracked).toBe(true);
    expect(file?.stats).toEqual({ additions: 100_001, deletions: 0 });
    expect(file?.statsTruncated).toBe(true);
    expect(file?.metadata.hunks).toHaveLength(0);
    expect(file?.sourceFetcher).toBeUndefined();
  });

  test("defaults a skipped file to a modification with no counted lines", () => {
    const result = toInternalVcsPatchResult(
      baseResult({
        extraFiles: [{ kind: "skipped", path: "huge.bin", reason: "too-large" }],
      }),
    );

    const [file] = result.extraFiles ?? [];
    expect(file?.metadata.type).toBe("change");
    expect(file?.stats).toEqual({ additions: 0, deletions: 0 });
    expect(file?.isUntracked).toBeUndefined();
  });

  test("keeps declared order and numbers ids by position", () => {
    const result = toInternalVcsPatchResult(
      baseResult({
        extraFiles: [
          { kind: "skipped", path: "big.txt", reason: "too-large" },
          { kind: "patch", path: "note.txt", patchText: ADDED_FILE_PATCH },
        ],
      }),
    );

    expect(result.extraFiles?.map((file) => file.id)).toEqual([
      "/repo:0:big.txt",
      "/repo:1:note.txt",
    ]);
  });
});

describe("published user errors", () => {
  test("normalize into Hunk's own user-facing error", () => {
    const normalized = toUserFacingError(
      new HunkExtensionUserError("No Mercurial repository here.", {
        suggestions: ["Run the command from an `hg` checkout."],
      }),
    );

    expect(normalized).toBeInstanceOf(HunkUserError);
    expect((normalized as HunkUserError).message).toBe("No Mercurial repository here.");
    expect((normalized as HunkUserError).suggestions).toEqual([
      "Run the command from an `hg` checkout.",
    ]);
  });

  test("are recognized structurally, so a plain object carries the same weight", () => {
    const normalized = toUserFacingError({
      name: "HunkExtensionUserError",
      message: "Backend unavailable.",
      suggestions: ["Install it.", 42],
    });

    expect(normalized).toBeInstanceOf(HunkUserError);
    // A non-string suggestion is dropped rather than rendered as "42".
    expect((normalized as HunkUserError).suggestions).toEqual(["Install it."]);
  });

  test("leave ordinary failures alone", () => {
    const bug = new TypeError("cannot read property of undefined");
    expect(toUserFacingError(bug)).toBe(bug);
  });

  test("reach the user through the adapter boundary", async () => {
    const adapter = toInternalVcsAdapter({
      id: "demo",
      name: "Demo VCS",
      detect: () => null,
      operations: {
        "working-tree-diff": {
          load: async () => {
            throw new HunkExtensionUserError("Demo VCS cannot review a working copy.", {
              suggestions: ["Commit first."],
            });
          },
          watchSignature: () => {
            throw new HunkExtensionUserError("No signature available.");
          },
        },
      },
    });

    const operation = adapter.operations["working-tree-diff"]!;
    const input = { kind: "vcs", staged: false, options: {} } as const;

    await expect(operation.load(input, { cwd: "/repo" })).rejects.toBeInstanceOf(HunkUserError);
    expect(() => operation.watchSignature!(input, { cwd: "/repo" })).toThrow(
      "No signature available.",
    );
  });

  test("drop an operation whose load is not callable rather than crashing mid-review", () => {
    const adapter = toInternalVcsAdapter({
      id: "bare",
      name: "Bare VCS",
      detect: () => null,
      operations: { "working-tree-diff": {} as never },
    });

    expect(adapter.operations["working-tree-diff"]).toBeUndefined();
  });
});

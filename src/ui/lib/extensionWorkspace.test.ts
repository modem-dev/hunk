import { join, resolve, sep } from "node:path";
import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import type { CliInput, CommonOptions } from "../../core/run/commandInputs";
import {
  normalizeWorkspaceLocationRequest,
  normalizeWorkspaceWriteRequest,
  resolveExtensionWorkspaceRead,
  resolveExtensionWorkspaceLocation,
  resolveExtensionWorkspaceWriteTarget,
  type WorkspaceFileSource,
} from "./extensionWorkspace";

const ROOT = resolve(sep, "repo");
const NO_OPTIONS: CommonOptions = {};
const WORKING_TREE_INPUT = {
  kind: "vcs",
  staged: false,
  options: NO_OPTIONS,
} satisfies CliInput;

/** One reviewed file as the workspace policy sees it, changed unless told otherwise. */
function createTestWorkspaceFile(
  overrides: Partial<WorkspaceFileSource> = {},
): WorkspaceFileSource {
  return { id: "alpha", path: "src/alpha.ts", metadata: { type: "change" }, ...overrides };
}

/** Classify one file id against one review input, defaulting to a writable review. */
function resolveTestTarget({
  fileId = "alpha",
  files = [createTestWorkspaceFile()],
  input = { kind: "vcs", staged: false, options: NO_OPTIONS } satisfies CliInput,
  root = ROOT,
}: {
  fileId?: string;
  files?: WorkspaceFileSource[];
  input?: CliInput;
  root?: string;
} = {}) {
  return resolveExtensionWorkspaceWriteTarget({ fileId, files, input, root });
}

describe("extension workspace write policy", () => {
  test("resolves a working-tree review file against the repository root", () => {
    const target = resolveTestTarget();

    expect(target).toEqual({
      writable: true,
      path: "src/alpha.ts",
      absolutePath: join(ROOT, "src", "alpha.ts"),
    });
  });

  test("refuses every review that is not the plain working tree", () => {
    const inputs: Array<[string, CliInput]> = [
      ["vcs range", { kind: "vcs", staged: false, range: "main..HEAD", options: NO_OPTIONS }],
      [
        "vcs endpoints",
        {
          kind: "vcs",
          staged: false,
          rangeEndpoints: { from: "main", to: "feature" },
          options: NO_OPTIONS,
        },
      ],
      ["vcs staged", { kind: "vcs", staged: true, options: NO_OPTIONS }],
      ["show", { kind: "show", ref: "HEAD", options: NO_OPTIONS }],
      ["stash show", { kind: "stash-show", options: NO_OPTIONS }],
      ["file pair", { kind: "diff", left: "before.ts", right: "after.ts", options: NO_OPTIONS }],
      ["patch", { kind: "patch", file: "change.patch", options: NO_OPTIONS }],
      ["difftool", { kind: "difftool", left: "before.ts", right: "after.ts", options: NO_OPTIONS }],
    ];

    for (const [label, input] of inputs) {
      const target = resolveTestTarget({ input });
      expect(target.writable, label).toBe(false);
      expect(target.writable ? "" : target.detail).toContain("working-tree only");
    }
  });

  test("names each non-working-tree review in its refusal", () => {
    const staged = resolveTestTarget({
      input: { kind: "vcs", staged: true, options: NO_OPTIONS },
    });
    const show = resolveTestTarget({ input: { kind: "show", ref: "HEAD", options: NO_OPTIONS } });

    expect(staged.writable ? "" : staged.detail).toContain("staged changes");
    expect(show.writable ? "" : show.detail).toContain("a single revision");
  });

  test("refuses a session that cannot reload after the write", () => {
    // Every successful write reloads the session, so a review that can never be
    // rebuilt — `--agent-context -` consumed stdin — must not accept one.
    const target = resolveTestTarget({
      input: { kind: "vcs", staged: false, options: { agentContext: "-" } },
    });

    expect(target.writable).toBe(false);
    expect(target.writable ? "" : target.detail).toContain("a session that can reload");
    expect(target.writable ? "" : target.detail).toContain("--agent-context -");
  });

  test("keeps an agent context read from a file writable", () => {
    const target = resolveTestTarget({
      input: { kind: "vcs", staged: false, options: { agentContext: "notes.json" } },
    });

    expect(target.writable).toBe(true);
  });

  test("refuses a file id no reviewed file carries", () => {
    const target = resolveTestTarget({ fileId: "missing" });

    expect(target).toEqual({
      writable: false,
      detail: 'No reviewed file has the id "missing".',
    });
  });

  test("refuses files with no writable new side", () => {
    const deleted = resolveTestTarget({
      files: [createTestWorkspaceFile({ metadata: { type: "deleted" } })],
    });
    const binary = resolveTestTarget({ files: [createTestWorkspaceFile({ isBinary: true })] });
    const tooLarge = resolveTestTarget({ files: [createTestWorkspaceFile({ isTooLarge: true })] });

    expect(deleted.writable ? "" : deleted.detail).toContain("was deleted in this review");
    expect(binary.writable ? "" : binary.detail).toContain("is binary");
    expect(tooLarge.writable ? "" : tooLarge.detail).toContain("too large");
  });

  test("refuses a reviewed path that escapes the review root", () => {
    // Patch text is not a boundary Hunk controls, so a traversal in a reviewed
    // path is refused rather than resolved.
    const escaping = resolveTestTarget({
      files: [createTestWorkspaceFile({ path: "../outside/secrets.ts" })],
    });
    const root = resolveTestTarget({ files: [createTestWorkspaceFile({ path: "." })] });

    expect(escaping.writable ? "" : escaping.detail).toContain("outside the reviewed repository");
    expect(root.writable ? "" : root.detail).toContain("outside the reviewed repository");
  });

  test("allows a path that only looks like a traversal", () => {
    const target = resolveTestTarget({
      files: [createTestWorkspaceFile({ path: "..config/alpha.ts" })],
    });

    expect(target.writable).toBe(true);
  });

  test("trims the CR the diff parser can leave on a reviewed path", () => {
    const target = resolveTestTarget({
      files: [createTestWorkspaceFile({ path: "src/alpha.ts\r" })],
    });

    expect(target).toEqual({
      writable: true,
      path: "src/alpha.ts",
      absolutePath: join(ROOT, "src", "alpha.ts"),
    });
  });
});

describe("extension workspace document reads", () => {
  /** One reviewed file whose fetcher reports the side it was asked for. */
  function createTestReadableFile(overrides: Partial<WorkspaceFileSource> = {}) {
    return createTestWorkspaceFile({
      sourceFetcher: { getFullText: async (side) => `${side} text` },
      ...overrides,
    });
  }

  test("binds the read to the side the caller asked for", async () => {
    const files = [createTestReadableFile()];

    await expect(
      resolveExtensionWorkspaceRead({ fileId: "alpha", files, side: "new" })?.(),
    ).resolves.toBe("new text");
    await expect(
      resolveExtensionWorkspaceRead({ fileId: "alpha", files, side: "old" })?.(),
    ).resolves.toBe("old text");
  });

  test("answers with no read for an unknown file id", () => {
    // A probe is an ordinary question: an id nothing carries is an answer, not
    // a failure, exactly as `canWriteDocument` treats one.
    expect(
      resolveExtensionWorkspaceRead({
        fileId: "missing",
        files: [createTestReadableFile()],
        side: "new",
      }),
    ).toBeNull();
  });

  test("answers with no read for a file the loader gave no source", () => {
    expect(
      resolveExtensionWorkspaceRead({
        fileId: "alpha",
        files: [createTestWorkspaceFile()],
        side: "new",
      }),
    ).toBeNull();
  });

  test("reads a file in review kinds that refuse writes", () => {
    // Reads are review-kind blind on purpose, so nothing here consults the
    // input the write policy branches on.
    const read = resolveExtensionWorkspaceRead({
      fileId: "alpha",
      files: [createTestReadableFile({ metadata: { type: "deleted" } })],
      side: "old",
    });

    expect(read).not.toBeNull();
  });

  test("throws for a side that names neither document", () => {
    for (const side of [undefined, null, "both", "New", 0]) {
      expect(() =>
        resolveExtensionWorkspaceRead({ fileId: "alpha", files: [createTestReadableFile()], side }),
      ).toThrow('side to be "old" or "new"');
    }
  });
});

describe("extension workspace write requests", () => {
  test("accepts a well-formed request, empty replacement text included", () => {
    expect(normalizeWorkspaceWriteRequest({ fileId: "alpha", text: "" })).toEqual({
      fileId: "alpha",
      text: "",
    });
  });

  test("throws for a malformed request rather than answering it", () => {
    expect(() => normalizeWorkspaceWriteRequest(undefined)).toThrow("non-empty fileId");
    expect(() => normalizeWorkspaceWriteRequest({ text: "x" })).toThrow("non-empty fileId");
    expect(() => normalizeWorkspaceWriteRequest({ fileId: "", text: "x" })).toThrow(
      "non-empty fileId",
    );
    expect(() => normalizeWorkspaceWriteRequest({ fileId: "alpha" })).toThrow(
      "text to be a string",
    );
    expect(() => normalizeWorkspaceWriteRequest({ fileId: "alpha", text: 12 })).toThrow(
      "text to be a string",
    );
  });
});

describe("extension workspace locations", () => {
  test("resolves the repository path and maps old-side lines from parsed hunk metadata", () => {
    const file = createTestDiffFile({
      id: "alpha",
      path: "packages/app/alpha.ts",
      before: "one\ntwo\nthree\nfour\n",
      after: "one\nfour\n",
    });

    expect(
      resolveExtensionWorkspaceLocation({
        files: [file],
        input: WORKING_TREE_INPUT,
        request: { fileId: "alpha", hunkIndex: 0, line: { side: "old", line: 3 } },
        root: ROOT,
      }),
    ).toEqual({ path: join(ROOT, "packages", "app", "alpha.ts"), line: 2 });
  });

  test("rejects malformed source addresses and returns null for unavailable metadata", () => {
    expect(() => normalizeWorkspaceLocationRequest(undefined)).toThrow("non-empty fileId");
    expect(() => normalizeWorkspaceLocationRequest({ fileId: "alpha", hunkIndex: -1 })).toThrow(
      "non-negative integer",
    );
    expect(() =>
      normalizeWorkspaceLocationRequest({
        fileId: "alpha",
        line: { side: "both", line: 1 },
      }),
    ).toThrow('line.side must be "old" or "new"');
    expect(
      resolveExtensionWorkspaceLocation({
        files: [createTestWorkspaceFile({ metadata: undefined })],
        input: WORKING_TREE_INPUT,
        request: { fileId: "alpha" },
        root: ROOT,
      }),
    ).toBeNull();
  });

  test("preserves old-side offsets through context and multi-line replacements", () => {
    const removed = createTestDiffFile({
      id: "removed",
      path: "removed.ts",
      before: "one\ntwo\nthree\nfour\n",
      after: "one\nfour\n",
      context: 1,
    });
    const replaced = createTestDiffFile({
      id: "replaced",
      path: "replaced.ts",
      before: "one\ntwo\nthree\nfour\n",
      after: "one\nTWO\nTHREE\nfour\n",
    });

    expect(
      resolveExtensionWorkspaceLocation({
        files: [removed],
        input: WORKING_TREE_INPUT,
        request: { fileId: "removed", hunkIndex: 0, line: { side: "old", line: 3 } },
        root: ROOT,
      })?.line,
    ).toBe(2);
    expect(
      resolveExtensionWorkspaceLocation({
        files: [replaced],
        input: WORKING_TREE_INPUT,
        request: { fileId: "replaced", hunkIndex: 0, line: { side: "old", line: 3 } },
        root: ROOT,
      })?.line,
    ).toBe(3);
  });

  test("uses direct comparison provenance and refuses unattested patch paths", () => {
    const file = createTestDiffFile({ id: "alpha", path: "after.ts" });
    const directInput = {
      kind: "diff",
      left: "nested/before.ts",
      right: "nested/after.ts",
      options: NO_OPTIONS,
    } satisfies CliInput;

    expect(
      resolveExtensionWorkspaceLocation({
        files: [file],
        input: directInput,
        request: { fileId: "alpha", line: { side: "new", line: 2 } },
        root: ROOT,
      }),
    ).toEqual({ path: join(ROOT, "nested", "after.ts"), line: 2 });
    expect(
      resolveExtensionWorkspaceLocation({
        files: [file],
        input: { kind: "patch", text: file.patch, options: NO_OPTIONS },
        request: { fileId: "alpha" },
        root: ROOT,
      }),
    ).toBeNull();
  });

  test("resolves deleted direct comparisons to their old-side source", () => {
    const file = createTestDiffFile({
      id: "deleted",
      path: "deleted.ts",
      before: "one\ntwo\n",
      after: "",
    });

    expect(
      resolveExtensionWorkspaceLocation({
        files: [file],
        input: {
          kind: "diff",
          left: "archive/deleted.ts",
          right: "/dev/null",
          options: NO_OPTIONS,
        },
        request: { fileId: "deleted", hunkIndex: 0, line: { side: "old", line: 2 } },
        root: ROOT,
      }),
    ).toEqual({ path: join(ROOT, "archive", "deleted.ts"), line: 2 });
  });
});

import { join, resolve, sep } from "node:path";
import { describe, expect, test } from "bun:test";
import type { CliInput, CommonOptions } from "../../core/types";
import {
  normalizeWorkspaceWriteRequest,
  resolveExtensionWorkspaceWriteTarget,
  type WorkspaceWriteFileSource,
} from "./extensionWorkspace";

const ROOT = resolve(sep, "repo");
const NO_OPTIONS: CommonOptions = {};

/** One reviewed file as the write policy sees it, changed unless told otherwise. */
function createTestWorkspaceFile(
  overrides: Partial<WorkspaceWriteFileSource> = {},
): WorkspaceWriteFileSource {
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
  files?: WorkspaceWriteFileSource[];
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

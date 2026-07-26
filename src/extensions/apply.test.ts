import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import type { Changeset, DiffFile } from "../core/types";
import type { VcsAdapter } from "../core/vcs/types";
import {
  applyExtensionChangesetTransforms,
  applyExtensionFileLanguages,
  createExtensionApplyNotices,
  reportExtensionApplyIssues,
  createUnknownVcsNotice,
  resolveExtensionDetectedVcsId,
  resolveExtensionVcsAdapters,
  resolveSessionVcsId,
} from "./apply";
import { createExtensionNotificationHub } from "./notifications";
import {
  createEmptyExtensionLoadResult,
  type ChangesetTransform,
  type ExtensionLoadResult,
} from "./types";

/** Build a load result with a captured notification sink for assertions. */
function createTestLoadResult(): { result: ExtensionLoadResult; notices: string[] } {
  const notifications = createExtensionNotificationHub();
  const notices: string[] = [];
  notifications.subscribe((notification) => notices.push(notification.message));
  return { result: createEmptyExtensionLoadResult("/repo", notifications), notices };
}

function createTestChangeset(overrides: Partial<Changeset> = {}): Changeset {
  return { id: "changeset:test", sourceLabel: "repo", title: "test", files: [], ...overrides };
}

/**
 * Build files with real Pierre metadata.
 *
 * Transform validation looks at `metadata.hunks`, so fixtures have to carry the
 * same shape the loader produces; a hand-rolled `metadata: {}` would only prove
 * that a file the renderer cannot draw is accepted.
 */
function createTestFiles(): DiffFile[] {
  return [
    createTestDiffFile({ id: "a", path: "a.ts" }),
    createTestDiffFile({ id: "b", path: "b.lock" }),
    createTestDiffFile({ id: "c", path: "c.ts" }),
  ];
}

/** Build a minimal adapter; only id/name/detect matter to the registration rules. */
function createTestVcsAdapter(id: string): VcsAdapter {
  return { id, name: id, detect: () => null, operations: {} };
}

describe("extension file languages", () => {
  test("registers extension mappings and skips built-in ones", () => {
    const { result } = createTestLoadResult();
    result.registry.fileLanguages.push(
      { extensionId: "langs", extension: "zig", language: "zig" },
      { extensionId: "langs", extension: "mts", language: "javascript" },
    );

    const issues = applyExtensionFileLanguages(result.registry);

    expect(issues).toEqual([
      {
        extensionId: "langs",
        message: "Skipped file language .mts from extension langs • Hunk defines it",
      },
    ]);
  });

  test("lets the last extension registration win for the same file extension", async () => {
    const { getFiletypeFromFileName } = await import("../core/fileLanguage");
    const { result } = createTestLoadResult();
    result.registry.fileLanguages.push(
      { extensionId: "first", extension: "hunkfixture", language: "python" },
      { extensionId: "second", extension: "hunkfixture", language: "ruby" },
    );

    expect(applyExtensionFileLanguages(result.registry)).toEqual([]);
    expect(getFiletypeFromFileName("sample.hunkfixture")).toBe("ruby");
  });
});

describe("extension VCS adapters", () => {
  test("skips an adapter whose id collides with a built-in backend", () => {
    const { result } = createTestLoadResult();
    result.registry.vcsAdapters.push(
      { extensionId: "impostor", adapter: createTestVcsAdapter("git") },
      { extensionId: "mercurial", adapter: createTestVcsAdapter("hg") },
    );

    const { adapters, issues } = resolveExtensionVcsAdapters(result.registry);

    expect(adapters.map((adapter) => adapter.id)).toEqual(["hg"]);
    expect(issues).toEqual([
      {
        extensionId: "impostor",
        message:
          'Skipped VCS adapter "git" from extension impostor • a built-in backend owns that id',
      },
    ]);
  });

  test("keeps the first registration when two extensions claim one id", () => {
    const { result } = createTestLoadResult();
    result.registry.vcsAdapters.push(
      { extensionId: "first", adapter: createTestVcsAdapter("hg") },
      { extensionId: "second", adapter: createTestVcsAdapter("hg") },
    );

    const { adapters, issues } = resolveExtensionVcsAdapters(result.registry);

    expect(adapters.length).toBe(1);
    expect(issues[0]?.extensionId).toBe("second");
  });

  test("only detects through extension adapters where no built-in claims the directory", () => {
    const claimsEverything: VcsAdapter = {
      id: "hg",
      name: "Mercurial",
      detect: (cwd) => ({ id: "hg", repoRoot: cwd }),
      operations: {},
    };

    // The repo Hunk itself lives in is a Git checkout, so built-ins win there.
    expect(resolveExtensionDetectedVcsId(process.cwd(), [claimsEverything])).toBeUndefined();
    // A directory no built-in recognizes is available to extension adapters.
    expect(resolveExtensionDetectedVcsId("/", [claimsEverything])).toBe("hg");
    expect(resolveExtensionDetectedVcsId("/", [])).toBeUndefined();
  });
});

describe("extension changeset transforms", () => {
  /** Register one transform on the result's registry. */
  function addTransform(
    result: ExtensionLoadResult,
    extensionId: string,
    transform: ChangesetTransform,
  ) {
    result.registry.changesetTransforms.push({ extensionId, transform });
  }

  test("runs transforms in registration order, feeding each the previous output", async () => {
    const { result } = createTestLoadResult();
    addTransform(result, "first", (changeset) => ({ ...changeset, title: `${changeset.title}:a` }));
    addTransform(result, "second", async (changeset) => ({
      ...changeset,
      title: `${changeset.title}:b`,
    }));

    const transformed = await applyExtensionChangesetTransforms(result, createTestChangeset());

    expect(transformed.title).toBe("test:a:b");
  });

  test("skips a throwing transform and keeps the previous changeset", async () => {
    const { result, notices } = createTestLoadResult();
    addTransform(result, "broken", () => {
      throw new Error("transform blew up");
    });
    addTransform(result, "healthy", (changeset) => ({ ...changeset, title: "survived" }));

    const transformed = await applyExtensionChangesetTransforms(result, createTestChangeset());

    expect(transformed.title).toBe("survived");
    expect(notices).toEqual([
      "Extension broken failed transforming the changeset • transform blew up",
    ]);
  });

  test("keeps the previous changeset when a transform returns something unusable", async () => {
    const { result, notices } = createTestLoadResult();
    addTransform(result, "sloppy", () => undefined as unknown as Changeset);

    const transformed = await applyExtensionChangesetTransforms(result, createTestChangeset());

    expect(transformed.title).toBe("test");
    expect(notices).toEqual([
      "Extension sloppy returned an invalid changeset (not an object) • keeping the previous one",
    ]);
  });

  test("rejects a changeset whose files are not DiffFile-shaped", async () => {
    const { result, notices } = createTestLoadResult();
    addTransform(result, "sloppy", (changeset) => ({
      ...changeset,
      files: [{ id: "a" }] as unknown as Changeset["files"],
    }));

    const transformed = await applyExtensionChangesetTransforms(result, createTestChangeset());

    expect(transformed.files).toEqual([]);
    expect(notices).toEqual([
      "Extension sloppy returned an invalid changeset (files[0].path is not a string) • keeping the previous one",
    ]);
  });

  test("rejects a file whose metadata carries no hunks the renderer can draw", async () => {
    for (const [metadata, reason] of [
      [{}, "files[0].metadata.hunks is not an array"],
      [{ hunks: "nope" }, "files[0].metadata.hunks is not an array"],
      [{ hunks: [{}] }, "files[0].metadata.hunks contains an unusable hunk"],
      [null, "files[0].metadata is not an object"],
    ] as const) {
      const { result, notices } = createTestLoadResult();
      const files = createTestFiles();
      addTransform(result, "sloppy", (changeset) => ({
        ...changeset,
        files: [{ ...changeset.files[0], metadata }] as unknown as Changeset["files"],
      }));

      const transformed = await applyExtensionChangesetTransforms(
        result,
        createTestChangeset({ files }),
      );

      // The whole previous changeset carries forward, not a partially applied one.
      expect(transformed.files.map((file) => file.id)).toEqual(["a", "b", "c"]);
      expect(notices).toEqual([
        `Extension sloppy returned an invalid changeset (${reason}) • keeping the previous one`,
      ]);
    }
  });

  test("rejects a file the sidebar and totals could not summarize", async () => {
    const { result, notices } = createTestLoadResult();
    addTransform(result, "sloppy", () => ({
      ...createTestChangeset(),
      files: [
        { ...createTestDiffFile({ id: "a" }), stats: undefined },
      ] as unknown as Changeset["files"],
    }));

    await applyExtensionChangesetTransforms(result, createTestChangeset());

    expect(notices).toEqual([
      "Extension sloppy returned an invalid changeset (files[0].stats is missing addition and deletion counts) • keeping the previous one",
    ]);
  });

  test("rejects an agent context without annotations", async () => {
    const { result, notices } = createTestLoadResult();
    addTransform(result, "sloppy", () => ({
      ...createTestChangeset(),
      files: [
        { ...createTestDiffFile({ id: "a" }), agent: { path: "a.ts" } },
      ] as unknown as Changeset["files"],
    }));

    await applyExtensionChangesetTransforms(result, createTestChangeset());

    expect(notices).toEqual([
      "Extension sloppy returned an invalid changeset (files[0].agent has no annotations array) • keeping the previous one",
    ]);
  });

  test("rejects duplicate file ids that would collide in review state", async () => {
    const { result, notices } = createTestLoadResult();
    const files = createTestFiles();
    addTransform(result, "duplicator", (changeset) => ({
      ...changeset,
      files: [...changeset.files, changeset.files[0]] as Changeset["files"],
    }));

    const transformed = await applyExtensionChangesetTransforms(
      result,
      createTestChangeset({ files }),
    );

    expect(transformed.files.map((file) => file.id)).toEqual(["a", "b", "c"]);
    expect(notices).toEqual([
      'Extension duplicator returned an invalid changeset (duplicate file id "a") • keeping the previous one',
    ]);
  });

  test("rejects a file with an empty id", async () => {
    const { result, notices } = createTestLoadResult();
    addTransform(result, "sloppy", (changeset) => ({
      ...changeset,
      files: [{ ...createTestDiffFile({ id: "a" }), id: "" }] as unknown as Changeset["files"],
    }));

    await applyExtensionChangesetTransforms(result, createTestChangeset());

    expect(notices).toEqual([
      "Extension sloppy returned an invalid changeset (files[0].id is not a non-empty string) • keeping the previous one",
    ]);
  });

  test("accepts a transform that filters and reorders files", async () => {
    const { result } = createTestLoadResult();
    addTransform(result, "collapse", (changeset) => ({
      ...changeset,
      files: [...changeset.files].filter((file) => !file.path.endsWith(".lock")).reverse(),
    }));

    const transformed = await applyExtensionChangesetTransforms(
      result,
      createTestChangeset({ files: createTestFiles() }),
    );

    expect(transformed.files.map((file) => file.id)).toEqual(["c", "a"]);
  });

  test("returns the original changeset when no transforms are registered", async () => {
    const { result } = createTestLoadResult();
    const changeset = createTestChangeset();

    expect(await applyExtensionChangesetTransforms(result, changeset)).toBe(changeset);
    expect(await applyExtensionChangesetTransforms(undefined, changeset)).toBe(changeset);
  });
});

describe("extension apply issue reporting", () => {
  test("renders issues as uniquely keyed startup notices", () => {
    const notices = createExtensionApplyNotices([
      { extensionId: "langs", message: "first" },
      { extensionId: "langs", message: "second" },
    ]);

    expect(notices.map((notice) => notice.message)).toEqual(["first", "second"]);
    expect(new Set(notices.map((notice) => notice.key)).size).toBe(2);
  });

  test("routes issues to ctx.notify as warnings for mid-session reloads", () => {
    const { result, notices } = createTestLoadResult();

    reportExtensionApplyIssues([{ extensionId: "langs", message: "skipped" }], result.context);

    expect(notices).toEqual(["skipped"]);
  });
});

describe("resolveSessionVcsId", () => {
  /** One extension-registered backend, minimal but structurally real. */
  const hgAdapter: VcsAdapter = {
    id: "hg",
    name: "Mercurial",
    detect: () => null,
    operations: {},
  };

  test("honors a configured id a loaded extension backend owns", () => {
    // `vcs = "hg"` with a Mercurial extension installed is unambiguous intent.
    expect(resolveSessionVcsId("hg", process.cwd(), [hgAdapter])).toEqual({ vcsId: "hg" });
  });

  test("honors a configured id a built-in backend owns", () => {
    expect(resolveSessionVcsId("git", process.cwd(), [])).toEqual({ vcsId: "git" });
  });

  test("falls back to detection and reports an id nothing owns", () => {
    const resolved = resolveSessionVcsId("hg", process.cwd(), []);

    expect(resolved.unknownVcsId).toBe("hg");
    // The repo Hunk lives in is a Git checkout, so detection lands there.
    expect(resolved.vcsId).toBe("git");
  });

  test("leaves an unset id alone", () => {
    expect(resolveSessionVcsId(undefined, process.cwd(), [])).toEqual({ vcsId: undefined });
  });

  test("names the id and the fallback in the notice", () => {
    const notice = createUnknownVcsNotice("hg", "git");

    expect(notice.key).toBe("vcs:unknown:hg");
    expect(notice.message).toContain('Unknown vcs "hg"');
    expect(notice.message).toContain("falling back to git");
  });

  test("strips terminal control sequences from a config-authored id", () => {
    // The id is quoted straight out of a config file, which a repo can control.
    const notice = createUnknownVcsNotice("h\u001b[31mg", "git");

    expect(notice.message).not.toContain("\u001b");
  });
});

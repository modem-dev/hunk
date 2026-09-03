import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import {
  HUNK_CORE_VCS_DETECTION_PRIORITY,
  HUNK_DEFAULT_VCS_DETECTION_PRIORITY,
} from "../extension-api/types";
import type { Changeset, DiffFile } from "../core/changeset/model";
import { extendVcsCatalog } from "../core/vcs";
import type { VcsAdapter } from "../core/vcs/types";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { HUNK_FILES_PANE_KEY } from "./extensionIds";
import {
  applyExtensionChangesetTransforms,
  applyExtensionFileLanguages,
  createExtensionApplyNotices,
  reportExtensionApplyIssues,
  createUnknownVcsNotice,
  resolveDetectedVcsIdWithExtensions,
  resolveExtensionCommands,
  resolveExtensionFileViews,
  resolveExtensionKeyboardModes,
  resolveExtensionLineHighlighters,
  resolveExtensionPanes,
  resolveExtensionSessionOptions,
  resolveExtensionVcsAdapters,
  resolveSessionVcsId,
} from "./apply";
import { createExtensionNotificationHub } from "./notifications";
import {
  createEmptyExtensionLoadResult,
  type ChangesetTransform,
  type ExtensionLoadResult,
} from "./types";

const tempDirs: string[] = [];
const BASE_VCS_CATALOG = getBundledVcsCatalog();

/** Build a complete test catalog from bundled and extension adapters. */
function catalogWith(adapters: readonly VcsAdapter[] = []) {
  return extendVcsCatalog(BASE_VCS_CATALOG, adapters);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a throwaway directory that is removed after the test. */
function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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
      {
        extensionId: "langs",
        matcher: { kind: "extension", value: "zig" },
        language: "zig",
      },
      {
        extensionId: "langs",
        matcher: { kind: "extension", value: "mts" },
        language: "javascript",
      },
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
    const { fileLanguageForPath } = await import("../core/changeset/fileLanguageLookup");
    const { result } = createTestLoadResult();
    result.registry.fileLanguages.push(
      {
        extensionId: "first",
        matcher: { kind: "extension", value: "hunkfixture" },
        language: "python",
      },
      {
        extensionId: "second",
        matcher: { kind: "extension", value: "hunkfixture" },
        language: "ruby",
      },
    );

    expect(applyExtensionFileLanguages(result.registry)).toEqual([]);
    expect(fileLanguageForPath("sample.hunkfixture")).toBe("ruby");
  });

  test("applies exact-filename and glob selectors through the extension registry", async () => {
    const { fileLanguageForPath } = await import("../core/changeset/fileLanguageLookup");
    const { result } = createTestLoadResult();
    result.registry.fileLanguages.push(
      {
        extensionId: "named",
        matcher: { kind: "filename", value: "HunkExtensionFile" },
        language: "python",
      },
      {
        extensionId: "generated",
        matcher: { kind: "glob", value: "generated/**/*.hunk", target: "path" },
        language: "ruby",
      },
    );

    expect(applyExtensionFileLanguages(result.registry)).toEqual([]);
    expect(fileLanguageForPath("tools/HunkExtensionFile")).toBe("python");
    expect(fileLanguageForPath("generated/nested/example.hunk")).toBe("ruby");
    expect(fileLanguageForPath("source/example.hunk")).toBe("text");
  });

  test("atomically removes selectors that disappear from a reload", async () => {
    const { fileLanguageForPath } = await import("../core/changeset/fileLanguageLookup");
    const { result } = createTestLoadResult();
    result.registry.fileLanguages.push({
      extensionId: "temporary",
      matcher: { kind: "filename", value: "TemporaryHunkfile" },
      language: "python",
    });

    applyExtensionFileLanguages(result.registry);
    expect(fileLanguageForPath("nested/TemporaryHunkfile")).toBe("python");

    applyExtensionFileLanguages(createEmptyExtensionLoadResult("/repo").registry);
    expect(fileLanguageForPath("nested/TemporaryHunkfile")).toBe("text");
    // Bundled Starlark selectors survive a user-extension-only reload wipe.
    expect(fileLanguageForPath("pkg/BUILD")).toBe("python");
  });

  test("lets a user extension replace a bundled Starlark selector", async () => {
    const { fileLanguageForPath } = await import("../core/changeset/fileLanguageLookup");
    const { result } = createTestLoadResult();
    result.registry.fileLanguages.push({
      extensionId: "override",
      matcher: { kind: "filename", value: "BUILD" },
      language: "ruby",
    });

    expect(applyExtensionFileLanguages(result.registry)).toEqual([]);
    expect(fileLanguageForPath("pkg/BUILD")).toBe("ruby");
  });

  test("keeps reserved extensions authoritative over broader selectors", async () => {
    const { fileLanguageForPath } = await import("../core/changeset/fileLanguageLookup");
    const { result } = createTestLoadResult();
    result.registry.fileLanguages.push({
      extensionId: "broad",
      matcher: { kind: "glob", value: "*.mts", target: "basename" },
      language: "javascript",
    });

    expect(applyExtensionFileLanguages(result.registry)).toEqual([]);
    expect(fileLanguageForPath("src/example.mts")).toBe("typescript");
  });
});

describe("extension session options", () => {
  test("lets any transient request win for the shared review session", () => {
    const result = createEmptyExtensionLoadResult("/repo");
    result.registry.sessionOptions.push(
      { extensionId: "default", options: { viewPreferences: "default" } },
      { extensionId: "guide", options: { viewPreferences: "transient" } },
    );

    expect(resolveExtensionSessionOptions(result.registry)).toEqual({
      transientViewPreferences: true,
    });
  });
});

describe("extension VCS adapters", () => {
  test("skips an adapter whose id collides with a built-in backend", () => {
    const { result } = createTestLoadResult();
    result.registry.vcsAdapters.push(
      { extensionId: "impostor", adapter: createTestVcsAdapter("git") },
      { extensionId: "mercurial", adapter: createTestVcsAdapter("hg") },
    );

    const { adapters, issues } = resolveExtensionVcsAdapters(result.registry, BASE_VCS_CATALOG);

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

    const { adapters, issues } = resolveExtensionVcsAdapters(result.registry, BASE_VCS_CATALOG);

    expect(adapters.length).toBe(1);
    expect(issues[0]?.extensionId).toBe("second");
  });
});

describe("extension panes", () => {
  test("resolves no panes from an empty registry", () => {
    const result = createEmptyExtensionLoadResult();

    const { panes, issues } = resolveExtensionPanes(result.registry);

    expect(panes).toEqual([]);
    expect(issues).toEqual([]);
  });

  test("keeps every distinct pane and reports duplicate keys", () => {
    const result = createEmptyExtensionLoadResult();
    const tree = { id: "tree", component: () => null };
    const flat = { id: "flat", component: () => null };
    const treeAgain = { id: "tree", component: () => null };
    result.registry.panes.push(
      { extensionId: "alpha", pane: tree },
      { extensionId: "beta", pane: flat },
      { extensionId: "alpha", pane: treeAgain },
    );

    const { panes, issues } = resolveExtensionPanes(result.registry);

    // Registration is additive: distinct panes from any extension coexist,
    // while this fixture's identity collision is refused.
    expect(panes).toEqual([
      { extensionId: "alpha", pane: tree },
      { extensionId: "beta", pane: flat },
    ]);
    expect(issues).toEqual([
      {
        extensionId: "alpha",
        message: 'Skipped duplicate pane "alpha:tree" from extension alpha',
      },
    ]);
  });

  test("keeps the first pane when several registrations replace one target", () => {
    const result = createEmptyExtensionLoadResult();
    const first = {
      id: "first-files",
      replaces: HUNK_FILES_PANE_KEY,
      component: () => null,
    };
    const second = {
      id: "second-files",
      replaces: HUNK_FILES_PANE_KEY,
      component: () => null,
    };
    const extra = { id: "extra", component: () => null };
    result.registry.panes.push(
      { extensionId: "alpha", pane: first },
      { extensionId: "beta", pane: second },
      { extensionId: "beta", pane: extra },
    );

    const { panes, issues } = resolveExtensionPanes(result.registry);

    expect(panes).toEqual([
      { extensionId: "alpha", pane: first },
      { extensionId: "beta", pane: extra },
    ]);
    expect(issues).toEqual([
      {
        extensionId: "beta",
        message:
          'Skipped pane "beta:second-files" from extension beta • another pane already replaces "hunk:files"',
      },
    ]);
  });
});

describe("extension file views", () => {
  test("keeps the first duplicate view identity in registration order", () => {
    const result = createEmptyExtensionLoadResult();
    const plain = { id: "plain", title: "Plain", matches: () => true, layout: () => null };
    result.registry.fileViews.push(
      { extensionId: "first", view: plain },
      { extensionId: "first", view: { ...plain, title: "Later" } },
    );

    const { views, issues } = resolveExtensionFileViews(result.registry);

    expect(views).toEqual([{ extensionId: "first", view: plain }]);
    expect(issues[0]?.message).toContain('duplicate file view "first:plain"');
  });
});

describe("extension line highlighters", () => {
  test("keeps the first duplicate highlighter identity in registration order", () => {
    const result = createEmptyExtensionLoadResult();
    const matches = { id: "matches", highlight: () => null };
    result.registry.lineHighlighters.push(
      { extensionId: "first", highlighter: matches },
      { extensionId: "first", highlighter: { ...matches } },
    );

    const { highlighters, issues } = resolveExtensionLineHighlighters(result.registry);

    expect(highlighters).toEqual([{ extensionId: "first", highlighter: matches }]);
    expect(issues[0]?.message).toContain('duplicate line highlighter "first:matches"');
  });
});

describe("extension keyboard modes", () => {
  test("keeps the first duplicate qualified identity", () => {
    const result = createEmptyExtensionLoadResult();
    const normal = { id: "normal", title: "Normal", onKey: () => "handled" as const };
    result.registry.keyboardModes.push(
      { extensionId: "vim", mode: normal },
      { extensionId: "other", mode: normal },
      { extensionId: "vim", mode: { ...normal, title: "Later" } },
    );

    const { modes, issues } = resolveExtensionKeyboardModes(result.registry);

    expect(modes.map((entry) => `${entry.extensionId}:${entry.mode.id}`)).toEqual([
      "vim:normal",
      "other:normal",
    ]);
    expect(issues).toEqual([
      {
        extensionId: "vim",
        message: 'Skipped duplicate keyboard mode "vim:normal" from extension vim',
      },
    ]);
  });
});

describe("extension commands", () => {
  test("keeps every distinct command and reports duplicate ids", () => {
    const result = createEmptyExtensionLoadResult();
    const handler = () => {};
    result.registry.commands.push(
      { extensionId: "alpha", command: { id: "toggle", title: "Toggle" }, handler },
      { extensionId: "beta", command: { id: "toggle", title: "Toggle" }, handler },
      { extensionId: "alpha", command: { id: "toggle", title: "Again" }, handler },
    );

    const { commands, issues } = resolveExtensionCommands(result.registry);

    // Ids namespace by extension, so same-named commands from different
    // extensions coexist while a true duplicate is refused.
    expect(commands.map((entry) => `${entry.extensionId}.${entry.command.id}`)).toEqual([
      "alpha.toggle",
      "beta.toggle",
    ]);
    expect(issues).toEqual([
      {
        extensionId: "alpha",
        message: 'Skipped duplicate command "alpha.toggle" from extension alpha',
      },
    ]);
  });
});

describe("resolveDetectedVcsIdWithExtensions", () => {
  /** Build a Mercurial-shaped adapter that walks upward for a `.hg` marker. */
  function createTestHgAdapter(detectionPriority?: number): VcsAdapter {
    return {
      id: "hg",
      name: "Mercurial",
      detectionPriority,
      detect: (cwd) => {
        let current = resolve(cwd);
        for (;;) {
          if (existsSync(join(current, ".hg"))) {
            return { id: "hg", repoRoot: current };
          }
          const parent = dirname(current);
          if (parent === current) {
            return null;
          }
          current = parent;
        }
      },
      operations: {},
    };
  }

  test("prefers a nearer extension checkout over an outer built-in repository", () => {
    const repo = createTempDir("hunk-apply-nested-hg-");
    const inner = join(repo, "inner-hg");
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(inner, ".hg"), { recursive: true });

    expect(resolveDetectedVcsIdWithExtensions(inner, catalogWith([createTestHgAdapter()]))).toBe(
      "hg",
    );
    expect(resolveDetectedVcsIdWithExtensions(inner, BASE_VCS_CATALOG)).toBe("git");
  });

  test("uses priority only for colocated roots", () => {
    const repo = createTempDir("hunk-apply-colocated-");
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".hg"));

    expect(resolveDetectedVcsIdWithExtensions(repo, catalogWith([createTestHgAdapter()]))).toBe(
      "git",
    );
    expect(
      resolveDetectedVcsIdWithExtensions(
        repo,
        catalogWith([createTestHgAdapter(HUNK_CORE_VCS_DETECTION_PRIORITY + 1)]),
      ),
    ).toBe("hg");
    expect(
      resolveDetectedVcsIdWithExtensions(
        repo,
        catalogWith([createTestHgAdapter(HUNK_DEFAULT_VCS_DETECTION_PRIORITY)]),
      ),
    ).toBe("git");
  });

  test("never overrides an explicit vcs the complete catalog owns", () => {
    const repo = createTempDir("hunk-apply-explicit-");
    const inner = join(repo, "inner-hg");
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(inner, ".hg"), { recursive: true });
    const catalog = catalogWith([createTestHgAdapter()]);

    expect(resolveDetectedVcsIdWithExtensions(inner, catalog, "git")).toBeUndefined();
    expect(resolveDetectedVcsIdWithExtensions(inner, catalog, "hg")).toBeUndefined();
    expect(resolveDetectedVcsIdWithExtensions(inner, catalog, "bzr")).toBe("hg");
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
    expect(resolveSessionVcsId("hg", process.cwd(), catalogWith([hgAdapter]))).toEqual({
      vcsId: "hg",
    });
  });

  test("honors a configured id a built-in backend owns", () => {
    expect(resolveSessionVcsId("git", process.cwd(), BASE_VCS_CATALOG)).toEqual({ vcsId: "git" });
  });

  test("falls back to detection and reports an id nothing owns", () => {
    const resolved = resolveSessionVcsId("hg", process.cwd(), BASE_VCS_CATALOG);

    expect(resolved.unknownVcsId).toBe("hg");
    // The repo Hunk lives in is a Git checkout, so detection lands there.
    expect(resolved.vcsId).toBe("git");
  });

  test("leaves an unset id alone", () => {
    expect(resolveSessionVcsId(undefined, process.cwd(), BASE_VCS_CATALOG)).toEqual({
      vcsId: undefined,
    });
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

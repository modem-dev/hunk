import { describe, expect, test } from "bun:test";
import type { Changeset } from "../core/types";
import type { VcsAdapter } from "../core/vcs/types";
import {
  applyExtensionChangesetTransforms,
  applyExtensionFileLanguages,
  createExtensionApplyNotices,
  reportExtensionApplyIssues,
  resolveExtensionDetectedVcsId,
  resolveExtensionVcsAdapters,
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
      "Extension sloppy returned an invalid changeset • keeping the previous one",
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
    expect(notices.length).toBe(1);
  });

  test("accepts a transform that filters and reorders files", async () => {
    const { result } = createTestLoadResult();
    const files = [
      { id: "a", path: "a.ts", metadata: {} },
      { id: "b", path: "b.lock", metadata: {} },
      { id: "c", path: "c.ts", metadata: {} },
    ] as unknown as Changeset["files"];
    addTransform(result, "collapse", (changeset) => ({
      ...changeset,
      files: [...changeset.files].filter((file) => !file.path.endsWith(".lock")).reverse(),
    }));

    const transformed = await applyExtensionChangesetTransforms(
      result,
      createTestChangeset({ files }),
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

import { describe, expect, test } from "bun:test";
import { runExtensionFactory, toInternalVcsAdapter } from "./runExtension";
import { createEmptyExtensionRegistry, type ExtensionLoadIssue } from "./types";

/** Build the metadata one bundled-style extension would load under. */
function bundledMetadata(id: string) {
  return { id, sourcePath: `hunk:bundled/${id}`, origin: "bundled" as const };
}

describe("runExtensionFactory", () => {
  test("applies a synchronous factory before returning, with nothing to await", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    // The bundled tier depends on this: adapter resolution is synchronous, so a
    // static factory has to be fully applied by the time this call returns.
    const pending = runExtensionFactory({
      metadata: bundledMetadata("demo"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerFileLanguage(".demo", "demo");
      },
    });

    expect(pending).toBeUndefined();
    expect(issues).toEqual([]);
    expect(registry.extensions.map((extension) => extension.id)).toEqual(["demo"]);
    expect(registry.fileLanguages.map((entry) => entry.extension)).toEqual(["demo"]);
  });

  test("rolls a throwing synchronous factory back before returning", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    const pending = runExtensionFactory({
      metadata: bundledMetadata("broken"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerFileLanguage(".broken", "broken");
        throw new Error("boom");
      },
    });

    expect(pending).toBeUndefined();
    expect(registry.fileLanguages).toEqual([]);
    expect(registry.extensions).toEqual([]);
    expect(issues).toEqual([
      {
        extensionId: "broken",
        path: "hunk:bundled/broken",
        origin: "bundled",
        message: "boom",
      },
    ]);
  });

  test("hands back a promise for an async factory and isolates its rejection", async () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    const pending = runExtensionFactory({
      metadata: { id: "async", sourcePath: "/ext/async.ts", origin: "global" },
      registry,
      issues,
      factory: async (hunk) => {
        hunk.registerFileLanguage(".async", "async");
        await Promise.resolve();
        throw new Error("late failure");
      },
    });

    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(registry.fileLanguages).toEqual([]);
    expect(issues.map((issue) => issue.message)).toEqual(["late failure"]);
  });

  test("seals the API so a deferred callback cannot register later", async () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    let escaped:
      | { registerFileLanguage: (extension: string, language: string) => void }
      | undefined;

    runExtensionFactory({
      metadata: bundledMetadata("escapee"),
      registry,
      issues,
      factory: (hunk) => {
        escaped = hunk;
      },
    });

    expect(() => escaped?.registerFileLanguage(".late", "late")).toThrow(
      "escapee: hunk.registerFileLanguage() can only be called while the extension is loading.",
    );
    expect(registry.fileLanguages).toEqual([]);
  });
});

describe("toInternalVcsAdapter detection ids", () => {
  test("forces a mismatched detection id back to the registered adapter id", () => {
    const mismatches: string[] = [];
    const adapter = toInternalVcsAdapter(
      {
        id: "hg",
        name: "Mercurial",
        // A detection id that disagrees with the registered one is the bug this
        // guards: it used to flow into `getVcsAdapter`, which owns no adapter by
        // that name and aborts the whole session with "Unsupported VCS".
        detect: (cwd: string) => ({ id: "mercurial", repoRoot: cwd }),
      },
      (returnedId) => mismatches.push(returnedId),
    );

    expect(adapter.detect("/repo")).toEqual({ id: "hg", repoRoot: "/repo" });
    expect(mismatches).toEqual(["mercurial"]);
  });

  test("reports one mismatch per adapter however often detection runs", () => {
    const mismatches: string[] = [];
    const adapter = toInternalVcsAdapter(
      {
        id: "hg",
        name: "Mercurial",
        detect: (cwd: string) => ({ id: "mercurial", repoRoot: cwd }),
      },
      (returnedId) => mismatches.push(returnedId),
    );

    adapter.detect("/repo");
    adapter.detect("/repo");
    adapter.detect("/other");

    expect(mismatches).toEqual(["mercurial"]);
  });

  test("passes a matching detection through untouched, with no diagnostic", () => {
    const mismatches: string[] = [];
    const detection = { id: "hg", repoRoot: "/repo" };
    const adapter = toInternalVcsAdapter(
      { id: "hg", name: "Mercurial", detect: () => detection },
      (returnedId) => mismatches.push(returnedId),
    );

    expect(adapter.detect("/repo")).toBe(detection);
    expect(mismatches).toEqual([]);
  });

  test("treats a detection without a usable repoRoot as no detection", () => {
    // `detectVcs` measures distance with `path.relative(detected.repoRoot, cwd)`,
    // and does it outside its own per-adapter try/catch — so a missing repoRoot
    // used to throw straight past detection and abort startup.
    for (const detection of [
      { id: "hg" },
      { id: "hg", repoRoot: undefined },
      { id: "hg", repoRoot: "" },
      { id: "hg", repoRoot: 7 },
      { id: "hg", repoRoot: null },
    ]) {
      const adapter = toInternalVcsAdapter({
        id: "hg",
        name: "Mercurial",
        detect: () => detection as { id: string; repoRoot: string },
      });

      expect(adapter.detect("/repo")).toBeNull();
    }
  });

  test("treats a non-detection return value as no detection", () => {
    const adapter = toInternalVcsAdapter({
      id: "hg",
      name: "Mercurial",
      // Only an untyped extension can produce this, and it must not become a
      // detection object whose `repoRoot` is undefined.
      detect: () => "yes" as unknown as { id: string; repoRoot: string },
    });

    expect(adapter.detect("/repo")).toBeNull();
  });

  test("records the mismatch on the registry when registered through the public API", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("hg-ext"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerVcsAdapter({
          id: "hg",
          name: "Mercurial",
          detect: (cwd: string) => ({ id: "mercurial", repoRoot: cwd }),
        });
      },
    });

    expect(issues).toEqual([]);
    const adapter = registry.vcsAdapters[0]?.adapter;
    expect(adapter?.detect("/repo")).toEqual({ id: "hg", repoRoot: "/repo" });
    expect(registry.logs).toEqual([
      {
        extensionId: "hg-ext",
        message:
          'VCS adapter "hg" returned detection id "mercurial" • using the registered id instead',
      },
    ]);
  });
});

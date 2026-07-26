import { describe, expect, test } from "bun:test";
import { runExtensionFactory } from "./runExtension";
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

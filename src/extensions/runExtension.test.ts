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

describe("registerSidebarView", () => {
  test("collects a valid view tagged with the owning extension", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const component = () => null;

    runExtensionFactory({
      metadata: bundledMetadata("side"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerSidebarView({ id: "tree", component });
      },
    });

    expect(issues).toEqual([]);
    expect(registry.sidebarViews).toEqual([
      { extensionId: "side", view: { id: "tree", component } },
    ]);
  });

  test("rejects a view without a component function and rolls the factory back", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("broken-side"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerSidebarView({ id: "tree" } as never);
      },
    });

    expect(registry.sidebarViews).toEqual([]);
    expect(issues.map((issue) => issue.extensionId)).toEqual(["broken-side"]);
    expect(issues[0]?.message).toContain("component function");
  });

  test("rolls a registered view back when the factory later throws", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("half-side"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerSidebarView({ id: "tree", component: () => null });
        throw new Error("after registering");
      },
    });

    // A failed factory is not loaded, so its sidebar must not win the session.
    expect(registry.sidebarViews).toEqual([]);
    expect(issues.map((issue) => issue.extensionId)).toEqual(["half-side"]);
  });
});

describe("registerFileView", () => {
  test("collects a layout callback that may return bounded custom row components", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const component = () => null;
    const layout = () => ({
      rows: [
        {
          id: "custom",
          spans: [{ text: "fallback" }],
          component: { height: 2, render: component },
        },
      ],
      hunkRows: [],
    });

    runExtensionFactory({
      metadata: bundledMetadata("presentation"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerFileView({
          id: "plain",
          title: "Plain",
          matches: () => true,
          layout,
        });
      },
    });

    expect(issues).toEqual([]);
    expect(registry.fileViews).toHaveLength(1);
    expect(registry.fileViews[0]?.extensionId).toBe("presentation");
    expect(registry.fileViews[0]?.view.layout).toBe(layout);
  });

  test("rejects a file view without a layout function", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("broken-presentation"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerFileView({ id: "plain", title: "Plain", matches: () => true } as never);
      },
    });

    expect(registry.fileViews).toEqual([]);
    expect(issues[0]?.message).toContain("layout() function");
  });

  test("keeps an interactive mode optional but refuses one that could never be entered", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const mode = { onKey: () => "handled" as const };

    runExtensionFactory({
      metadata: bundledMetadata("interactive"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerFileView({
          id: "keyed",
          title: "Keyed",
          matches: () => true,
          layout: () => null,
          mode,
        });
      },
    });

    expect(issues).toEqual([]);
    expect(registry.fileViews[0]?.view.mode).toBe(mode);

    const brokenRegistry = createEmptyExtensionRegistry();
    const brokenIssues: ExtensionLoadIssue[] = [];
    runExtensionFactory({
      metadata: bundledMetadata("broken-mode"),
      registry: brokenRegistry,
      issues: brokenIssues,
      factory: (hunk) => {
        hunk.registerFileView({
          id: "keyed",
          title: "Keyed",
          matches: () => true,
          layout: () => null,
          mode: {} as never,
        });
      },
    });

    expect(brokenRegistry.fileViews).toEqual([]);
    expect(brokenIssues[0]?.message).toContain("onKey() function");
  });
});

describe("hunk.events", () => {
  test("registers a bus listener under its owning extension", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const handler = () => {};

    runExtensionFactory({
      metadata: bundledMetadata("summary"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.events.on("summary:ready", handler);
      },
    });

    expect(issues).toEqual([]);
    expect(registry.customEventHandlers).toEqual([
      { extensionId: "summary", event: "summary:ready", handler },
    ]);
  });

  test("rolls bus registrations and queued factory events back with a failing factory", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("broken-events"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.events.on("broken:ready", () => {});
        hunk.events.emit("broken:ready", {});
        throw new Error("boom");
      },
    });

    expect(registry.customEventHandlers).toEqual([]);
    expect(registry.pendingCustomEvents).toEqual([]);
  });
});

describe("registerCommand", () => {
  test("collects a valid command tagged with the owning extension", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const handler = () => {};

    runExtensionFactory({
      metadata: bundledMetadata("cmd"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerCommand({ id: "toggle", title: "Toggle", key: "ctrl+y" }, handler);
        hunk.registerCommand({ id: "unbound", title: "Unbound" }, handler);
      },
    });

    expect(issues).toEqual([]);
    expect(registry.commands).toEqual([
      { extensionId: "cmd", command: { id: "toggle", title: "Toggle", key: "ctrl+y" }, handler },
      { extensionId: "cmd", command: { id: "unbound", title: "Unbound" }, handler },
    ]);
  });

  test("rejects an unparsable key chord and rolls the factory back", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("bad-key"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerCommand({ id: "toggle", title: "Toggle", key: "ctlr+y" }, () => {});
      },
    });

    // A typo'd chord fails the author loudly at registration instead of
    // registering a binding that silently never fires.
    expect(registry.commands).toEqual([]);
    expect(issues[0]?.message).toContain('Unknown modifier "ctlr"');
  });

  test("accepts a list of chords and rejects the list if any chord is bad", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const handler = () => {};

    runExtensionFactory({
      metadata: bundledMetadata("multi"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerCommand({ id: "toggle", title: "Toggle", key: ["ctrl+y", "f9"] }, handler);
      },
    });

    expect(issues).toEqual([]);
    expect(registry.commands[0]?.command.key).toEqual(["ctrl+y", "f9"]);

    const badRegistry = createEmptyExtensionRegistry();
    const badIssues: ExtensionLoadIssue[] = [];
    runExtensionFactory({
      metadata: bundledMetadata("multi-bad"),
      registry: badRegistry,
      issues: badIssues,
      factory: (hunk) => {
        // One bad chord in the list is a bad registration, not a partial one.
        hunk.registerCommand({ id: "toggle", title: "Toggle", key: ["ctrl+y", "f13"] }, handler);
      },
    });

    expect(badRegistry.commands).toEqual([]);
    expect(badIssues[0]?.message).toContain('Unknown key "f13"');

    const emptyRegistry = createEmptyExtensionRegistry();
    const emptyIssues: ExtensionLoadIssue[] = [];
    runExtensionFactory({
      metadata: bundledMetadata("multi-empty"),
      registry: emptyRegistry,
      issues: emptyIssues,
      factory: (hunk) => {
        hunk.registerCommand({ id: "toggle", title: "Toggle", key: [] }, handler);
      },
    });

    expect(emptyRegistry.commands).toEqual([]);
    expect(emptyIssues[0]?.message).toContain("non-empty chord string or array");
  });

  test("rejects a command without a handler function", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("no-handler"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerCommand({ id: "toggle", title: "Toggle" }, undefined as never);
      },
    });

    expect(registry.commands).toEqual([]);
    expect(issues[0]?.message).toContain("handler function");
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

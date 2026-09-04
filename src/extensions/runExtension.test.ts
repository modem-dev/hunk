import { describe, expect, test } from "bun:test";
import { resolveExtensionPanes } from "./apply";
import { runExtensionFactory, toInternalVcsAdapter } from "./runExtension";
import {
  createEmptyExtensionRegistry,
  HUNK_EXTENSION_API_VERSION,
  type ExtensionLoadIssue,
} from "./types";

/** Build the metadata one bundled-style extension would load under. */
function bundledMetadata(id: string) {
  return { id, sourcePath: `hunk:bundled/${id}`, origin: "bundled" as const };
}

describe("runExtensionFactory", () => {
  test("applies a synchronous factory before returning, with nothing to await", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    let apiVersion: number | undefined;

    // The bundled tier depends on this: adapter resolution is synchronous, so a
    // static factory has to be fully applied by the time this call returns.
    const pending = runExtensionFactory({
      metadata: bundledMetadata("demo"),
      registry,
      issues,
      factory: (hunk) => {
        apiVersion = hunk.apiVersion;
        hunk.registerFileLanguage(".demo", "demo");
      },
    });

    expect(pending).toBeUndefined();
    expect(apiVersion).toBe(HUNK_EXTENSION_API_VERSION);
    expect(issues).toEqual([]);
    expect(registry.extensions.map((extension) => extension.id)).toEqual(["demo"]);
    expect(registry.fileLanguages.map((entry) => entry.matcher)).toEqual([
      { kind: "extension", value: "demo" },
    ]);
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

  test("isolates a factory result whose then getter throws", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    const pending = runExtensionFactory({
      metadata: bundledMetadata("hostile-thenable"),
      registry,
      issues,
      factory: () =>
        Object.defineProperty({}, ["th", "en"].join(""), {
          get() {
            throw new Error("then exploded");
          },
        }) as Promise<void>,
    });

    expect(pending).toBeUndefined();
    expect(registry.extensions).toEqual([]);
    expect(issues.map((issue) => issue.message)).toEqual(["then exploded"]);
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

describe("registerPane", () => {
  test("accepts activation callbacks and rejects invalid values", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const onActivate = () => {};
    runExtensionFactory({
      metadata: bundledMetadata("activation"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerPane({ id: "valid", onActivate, component: () => null });
        expect(() =>
          hunk.registerPane({
            id: "invalid",
            onActivate: "activate" as unknown as () => void,
            component: () => null,
          }),
        ).toThrow("registerPane onActivate must be a function.");
      },
    });

    expect(issues).toEqual([]);
    expect(registry.panes[0]?.pane.onActivate).toBe(onActivate);
  });

  test("collects every placement with normalized width or height", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    runExtensionFactory({
      metadata: bundledMetadata("panes"),
      registry,
      issues,
      factory: (hunk) => {
        const size = { preferred: 3, min: 2, max: 4, fraction: 0.25 };
        for (const placement of ["left", "right"] as const) {
          hunk.registerPane({ id: placement, placement, width: size, component: () => null });
        }
        for (const placement of ["top", "bottom"] as const) {
          hunk.registerPane({ id: placement, placement, height: size, component: () => null });
        }
      },
    });
    expect(issues).toEqual([]);
    expect(
      registry.panes.map(({ pane }) => [
        pane.id,
        pane.placement,
        pane.placement === "left" || pane.placement === "right" ? pane.width : pane.height,
      ]),
    ).toEqual([
      ["left", "left", { preferred: 3, min: 2, max: 4, fraction: 0.25 }],
      ["right", "right", { preferred: 3, min: 2, max: 4, fraction: 0.25 }],
      ["top", "top", { preferred: 3, min: 2, max: 4, fraction: 0.25 }],
      ["bottom", "bottom", { preferred: 3, min: 2, max: 4, fraction: 0.25 }],
    ]);
  });

  test("uses placement-aware defaults for width and height", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    runExtensionFactory({
      metadata: bundledMetadata("pane-defaults"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerPane({ id: "side", placement: "right", component: () => null });
        hunk.registerPane({ id: "vertical", placement: "bottom", component: () => null });
      },
    });

    expect(issues).toEqual([]);
    expect(registry.panes[0]?.pane.width).toEqual({
      preferred: 34,
      min: 22,
      max: Number.MAX_SAFE_INTEGER,
    });
    expect(registry.panes[1]?.pane.height).toEqual({
      preferred: 8,
      min: 3,
      max: Number.MAX_SAFE_INTEGER,
    });
  });

  test("validates opt-ins, replacement keys, and synchronous availability callbacks", () => {
    for (const pane of [
      { id: "paint", currentLine: "yes", component: () => null },
      { id: "replacement", replaces: "", component: () => null },
      { id: "self", replaces: "bad-pane:self", component: () => null },
      { id: "availability", available: true, component: () => null },
    ]) {
      const registry = createEmptyExtensionRegistry();
      const issues: ExtensionLoadIssue[] = [];
      runExtensionFactory({
        metadata: bundledMetadata("bad-pane"),
        registry,
        issues,
        factory: (hunk) => hunk.registerPane(pane as never),
      });
      expect(registry.panes).toEqual([]);
      expect(issues).toHaveLength(1);
    }
  });

  test("rejects invalid placements, dimensions, and bounds", () => {
    const invalidPanes = [
      { id: "", component: () => null },
      { id: "component", component: null },
      { id: "placement", placement: "center", component: () => null },
      { id: "zero", width: { preferred: 0 }, component: () => null },
      { id: "fractional-preferred", width: { preferred: 1.5 }, component: () => null },
      { id: "infinite", width: { preferred: Number.POSITIVE_INFINITY }, component: () => null },
      { id: "zero-fraction", width: { preferred: 3, fraction: 0 }, component: () => null },
      { id: "negative-fraction", width: { preferred: 3, fraction: -0.1 }, component: () => null },
      { id: "large-fraction", width: { preferred: 3, fraction: 1.01 }, component: () => null },
      { id: "nan-fraction", width: { preferred: 3, fraction: Number.NaN }, component: () => null },
      {
        id: "infinite-fraction",
        width: { preferred: 3, fraction: Number.POSITIVE_INFINITY },
        component: () => null,
      },
      { id: "string-fraction", width: { preferred: 3, fraction: "0.2" }, component: () => null },
      { id: "boolean-fraction", width: { preferred: 3, fraction: true }, component: () => null },
      { id: "null-fraction", width: { preferred: 3, fraction: null }, component: () => null },
      {
        id: "unsafe",
        width: { preferred: Number.MAX_SAFE_INTEGER + 1 },
        component: () => null,
      },
      { id: "bounds", width: { preferred: 3, min: 4 }, component: () => null },
      { id: "maximum", width: { preferred: 4, max: 3 }, component: () => null },
      { id: "side-height", placement: "right", height: { preferred: 4 }, component: () => null },
      { id: "top-width", placement: "top", width: { preferred: 4 }, component: () => null },
    ];

    for (const pane of invalidPanes) {
      const registry = createEmptyExtensionRegistry();
      const issues: ExtensionLoadIssue[] = [];
      runExtensionFactory({
        metadata: bundledMetadata("bad-pane"),
        registry,
        issues,
        factory: (hunk) => hunk.registerPane(pane as never),
      });
      expect(registry.panes).toEqual([]);
      expect(issues).toHaveLength(1);
    }
  });

  test("rolls pane registrations back when their factory later throws", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    runExtensionFactory({
      metadata: bundledMetadata("half-pane"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerPane({ id: "tree", component: () => null });
        throw new Error("after registering");
      },
    });

    expect(registry.panes).toEqual([]);
    expect(issues.map((issue) => issue.extensionId)).toEqual(["half-pane"]);
  });
});

describe("configureSession", () => {
  test("records transient view preferences under the owning extension", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("trainer"),
      registry,
      issues,
      factory: (hunk) => hunk.configureSession({ viewPreferences: "transient" }),
    });

    expect(issues).toEqual([]);
    expect(registry.sessionOptions).toEqual([
      { extensionId: "trainer", options: { viewPreferences: "transient" } },
    ]);
  });

  test("rejects unknown policy values and rolls back earlier requests", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("broken-trainer"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.configureSession({ viewPreferences: "transient" });
        hunk.configureSession({ viewPreferences: "forever" } as never);
      },
    });

    expect(registry.sessionOptions).toEqual([]);
    expect(issues[0]?.message).toContain('"default" or "transient"');
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
    expect(registry.panes).toEqual([
      {
        extensionId: "side",
        pane: {
          id: "tree",
          placement: "left",
          width: { preferred: 34, min: 22, max: Number.MAX_SAFE_INTEGER },
          component,
        },
      },
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

    expect(registry.panes).toEqual([]);
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
    expect(registry.panes).toEqual([]);
    expect(issues.map((issue) => issue.extensionId)).toEqual(["half-side"]);
  });

  test("collides with registerPane through one identity path and keeps the first", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const first = () => null;
    const duplicate = () => null;

    runExtensionFactory({
      metadata: bundledMetadata("mixed"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerSidebarView({ id: "tree", component: first });
        hunk.registerPane({ id: "tree", component: duplicate });
      },
    });

    const resolved = resolveExtensionPanes(registry);
    expect(issues).toEqual([]);
    expect(resolved.panes).toHaveLength(1);
    expect(resolved.panes[0]?.pane.component).toBe(first);
    expect(resolved.issues).toEqual([
      {
        extensionId: "mixed",
        message: 'Skipped duplicate pane "mixed:tree" from extension mixed',
      },
    ]);
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

describe("registerLineHighlighter", () => {
  test("collects a valid highlighter under its owning extension", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const highlighter = { id: "matches", highlight: () => null };

    runExtensionFactory({
      metadata: bundledMetadata("search"),
      registry,
      issues,
      factory: (hunk) => hunk.registerLineHighlighter(highlighter),
    });

    expect(issues).toEqual([]);
    expect(registry.lineHighlighters).toEqual([{ extensionId: "search", highlighter }]);
  });

  test("rejects a highlighter without an id or a highlight() function", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("broken-search"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerLineHighlighter({ id: "no-callback" } as never);
      },
    });

    expect(registry.lineHighlighters).toEqual([]);
    expect(issues[0]?.message).toContain("highlight() function");

    const namelessRegistry = createEmptyExtensionRegistry();
    const namelessIssues: ExtensionLoadIssue[] = [];
    runExtensionFactory({
      metadata: bundledMetadata("nameless-search"),
      registry: namelessRegistry,
      issues: namelessIssues,
      factory: (hunk) => {
        hunk.registerLineHighlighter({ id: " ", highlight: () => null });
      },
    });

    expect(namelessRegistry.lineHighlighters).toEqual([]);
    expect(namelessIssues[0]?.message).toContain("non-empty id");
  });
});

describe("registerKeyboardMode", () => {
  test("collects a valid mode under its owning extension", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const mode = { id: "normal", title: "Vim normal", onKey: () => "handled" as const };

    runExtensionFactory({
      metadata: bundledMetadata("vim"),
      registry,
      issues,
      factory: (hunk) => hunk.registerKeyboardMode(mode),
    });

    expect(issues).toEqual([]);
    expect(registry.keyboardModes).toEqual([{ extensionId: "vim", mode }]);
  });

  test("validates the complete synchronous callback shape", () => {
    const cases = [
      [{ title: "Missing id", onKey: () => "handled" }, "non-empty id"],
      [{ id: "normal", onKey: () => "handled" }, "non-empty title"],
      [{ id: "normal", title: "Normal" }, "onKey() function"],
      [
        { id: "normal", title: "Normal", onKey: () => "handled", onEnter: true },
        "onEnter must be a function",
      ],
      [
        { id: "normal", title: "Normal", onKey: () => "handled", onExit: true },
        "onExit must be a function",
      ],
    ] as const;

    for (const [candidate, expected] of cases) {
      const registry = createEmptyExtensionRegistry();
      const issues: ExtensionLoadIssue[] = [];
      runExtensionFactory({
        metadata: bundledMetadata("broken-mode"),
        registry,
        issues,
        factory: (hunk) => hunk.registerKeyboardMode(candidate as never),
      });
      expect(registry.keyboardModes).toEqual([]);
      expect(issues[0]?.message).toContain(expected);
    }
  });

  test("rolls a registered mode back when its factory later throws", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    runExtensionFactory({
      metadata: bundledMetadata("half-mode"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerKeyboardMode({ id: "normal", title: "Normal", onKey: () => "pass" });
        throw new Error("after mode");
      },
    });

    expect(registry.keyboardModes).toEqual([]);
    expect(issues[0]?.message).toBe("after mode");
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

  test("preserves terminal-safe adapter ids that begin with a dash", () => {
    const adapter = toInternalVcsAdapter({
      id: "-custom",
      name: "Custom",
      detect: () => ({ id: "-custom", repoRoot: "/repo" }),
    });

    expect(adapter.id).toBe("-custom");
    expect(adapter.detect("/repo")).toEqual({ id: "-custom", repoRoot: "/repo" });
  });

  test("passes a matching detection through untouched, with no diagnostic", () => {
    const mismatches: string[] = [];
    const detection = { id: "hg", repoRoot: "/repo" };
    const adapter = toInternalVcsAdapter(
      { id: "hg", name: "Mercurial", detect: () => detection },
      (returnedId) => mismatches.push(returnedId),
    );

    expect(adapter.detect("/repo")).toEqual(detection);
    expect(mismatches).toEqual([]);
  });

  test("snapshots and sanitizes adapter metadata before it reaches diagnostics", () => {
    let nameReads = 0;
    const adapter = toInternalVcsAdapter({
      id: "demo",
      get name() {
        nameReads += 1;
        return nameReads === 1 ? "Demo\x1b[2J" : "Changed";
      },
      detect: () => null,
    });
    expect(adapter.name).toBe("Demo");
    expect(nameReads).toBe(1);
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

  test("registers generic CLI commands through the current API", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    const handler = () => ({ kind: "exit" as const });

    runExtensionFactory({
      metadata: bundledMetadata("tools"),
      registry,
      issues,
      factory: (hunk) => {
        expect(hunk.apiVersion).toBe(HUNK_EXTENSION_API_VERSION);
        hunk.registerCliCommand(
          { name: "greptile", summary: "Work with Greptile", usage: "<action>" },
          handler,
        );
      },
    });

    expect(issues).toEqual([]);
    expect(registry.cliCommands).toEqual([
      {
        extensionId: "tools",
        command: { name: "greptile", summary: "Work with Greptile", usage: "<action>" },
        handler,
      },
    ]);
  });

  test("rejects reserved CLI names and rolls back earlier registrations", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];

    runExtensionFactory({
      metadata: bundledMetadata("broken-cli"),
      registry,
      issues,
      factory: (hunk) => {
        hunk.registerCliCommand({ name: "tools", summary: "Tools" }, () => ({ kind: "exit" }));
        hunk.registerCliCommand({ name: "diff", summary: "Shadow diff" }, () => ({
          kind: "exit",
        }));
      },
    });

    expect(registry.cliCommands).toEqual([]);
    expect(issues[0]?.message).toContain('cannot replace built-in command "diff"');
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

describe("toInternalVcsAdapter history boundary", () => {
  test("requires providers to own selected-item review planning", () => {
    expect(() =>
      toInternalVcsAdapter({
        id: "incomplete",
        name: "Incomplete",
        detect: () => null,
        history: {
          open: () => ({
            read: async () => ({ commits: [], done: true }),
            close() {},
          }),
        } as never,
      }),
    ).toThrow("history must provide open() and planReview() functions");
  });

  test("copies and sanitizes bounded history pages", async () => {
    const commit = {
      revisionId: "a".repeat(40),
      displayId: "aaaaaaaa",
      parentRevisionIds: [] as string[],
      subject: "safe\x1b]52;c;cHdu\x07\nspoof",
      authorName: "Ada\rLovelace",
      authoredAt: "2026-01-01T00:00:00Z",
      decorations: [{ kind: "head" as const, label: "HEAD\x1b[2J" }],
    };
    let closed = 0;
    const adapter = toInternalVcsAdapter({
      id: "demo",
      name: "Demo",
      detect: () => null,
      history: {
        open: () => ({
          read: async () => ({ commits: [commit], done: true }),
          close: () => {
            closed += 1;
          },
        }),
        planReview: (selected) => ({
          kind: "revision-show",
          revisionId: selected.revisionId,
        }),
      },
    });
    const source = await adapter.history!.open({}, { cwd: "/repo" });
    const page = await source.read({ limit: 1 });

    expect(page.commits[0]?.subject).toBe("safespoof");
    expect(page.commits[0]?.authorName).toBe("AdaLovelace");
    expect(page.commits[0]?.decorations[0]?.label).toBe("HEAD");
    expect(page.commits[0]).not.toBe(commit);
    expect(closed).toBe(1);
  });

  test("rejects unsafe revision ids and required display fields erased by sanitization", async () => {
    const validCommit = {
      revisionId: "a".repeat(40),
      displayId: "aaaaaaaa",
      parentRevisionIds: [] as string[],
      subject: "Safe subject",
      authorName: "Ada",
      authoredAt: "2026-01-01T00:00:00Z",
      decorations: [],
    };
    const readCommit = async (commit: typeof validCommit) => {
      const adapter = toInternalVcsAdapter({
        id: "adversarial",
        name: "Adversarial",
        detect: () => null,
        history: {
          open: () => ({
            read: async () => ({ commits: [commit], done: true }),
            close() {},
          }),
          planReview: (selected) => ({
            kind: "revision-show",
            revisionId: selected.revisionId,
          }),
        },
      });
      return adapter
        .history!.open({}, { cwd: "/repo" })
        .then((source) => source.read({ limit: 1 }));
    };

    await expect(readCommit({ ...validCommit, revisionId: `unsafe\tid` })).rejects.toThrow(
      "terminal-safe immutable revision id",
    );
    for (const field of ["displayId", "subject", "authorName"] as const) {
      await expect(readCommit({ ...validCommit, [field]: "\x1b[2J" })).rejects.toThrow(
        `${field} must remain non-empty after sanitization`,
      );
    }
  });

  test("rejects tabs in provider-owned review action revision ids", async () => {
    const commit = {
      revisionId: "a".repeat(40),
      displayId: "aaaaaaaa",
      parentRevisionIds: [] as string[],
      subject: "Safe subject",
      authorName: "Ada",
      authoredAt: "2026-01-01T00:00:00Z",
      decorations: [],
    };
    const adapter = toInternalVcsAdapter({
      id: "adversarial-plan",
      name: "Adversarial plan",
      detect: () => null,
      history: {
        open: () => ({
          read: async () => ({ commits: [], done: true }),
          close() {},
        }),
        planReview: () => ({ kind: "revision-show", revisionId: "unsafe\tid" }),
      },
    });

    await expect(adapter.history!.planReview(commit, { cwd: "/repo" })).rejects.toThrow(
      "terminal-safe immutable revision id",
    );
  });

  test("snapshots source, page, commit, and decoration accessors exactly once", async () => {
    const reads = { sourceRead: 0, commits: 0, subject: 0, label: 0 };
    const commit = {
      revisionId: "a".repeat(40),
      displayId: "aaaaaaaa",
      parentRevisionIds: [],
      get subject() {
        reads.subject += 1;
        return reads.subject === 1 ? "Stable" : "Changed";
      },
      authorName: "Ada",
      authoredAt: "2026-01-01T00:00:00Z",
      decorations: [
        {
          kind: "tag",
          get label() {
            reads.label += 1;
            return reads.label === 1 ? "v1" : "changed";
          },
        },
      ],
    };
    const page = {
      get commits() {
        reads.commits += 1;
        return reads.commits === 1 ? [commit] : [{}, {}];
      },
      done: true,
    };
    const publicSource = {
      get read() {
        reads.sourceRead += 1;
        return async () => page;
      },
      close() {},
    };
    const adapter = toInternalVcsAdapter({
      id: "demo",
      name: "Demo",
      detect: () => null,
      history: {
        open: () => publicSource as never,
        planReview: (selected) => ({
          kind: "revision-show",
          revisionId: selected.revisionId,
        }),
      },
    });
    const source = await adapter.history!.open({}, { cwd: "/repo" });
    const result = await source.read({ limit: 1 });
    expect(result.commits[0]?.subject).toBe("Stable");
    expect(result.commits[0]?.decorations[0]?.label).toBe("v1");
    expect(reads).toEqual({ sourceRead: 1, commits: 1, subject: 1, label: 1 });
  });

  test("closes malformed and over-limit sources once", async () => {
    let closed = 0;
    const adapter = toInternalVcsAdapter({
      id: "demo",
      name: "Demo",
      detect: () => null,
      history: {
        open: () => ({
          read: async () => ({ commits: [{}, {}], done: false }) as never,
          close: () => {
            closed += 1;
          },
        }),
        planReview: (selected) => ({
          kind: "revision-show",
          revisionId: selected.revisionId,
        }),
      },
    });
    const source = await adapter.history!.open({}, { cwd: "/repo" });
    await expect(source.read({ limit: 1 })).rejects.toThrow("more commits");
    await source.close();
    expect(closed).toBe(1);
  });

  test("preserves custom-provider paging and provider-owned opaque review plans", async () => {
    const root = {
      revisionId: "opaque:root/revision",
      displayId: "root",
      parentRevisionIds: [],
      subject: "Root",
      authorName: "Ada",
      authoredAt: "2026-01-01T00:00:00Z",
      decorations: [],
    };
    const child = {
      ...root,
      revisionId: "opaque:child/revision",
      displayId: "child",
      parentRevisionIds: [root.revisionId],
      subject: "Child",
    };
    let page = 0;
    let plannedParent: string | undefined;
    const adapter = toInternalVcsAdapter({
      id: "opaque",
      name: "Opaque VCS",
      detect: (cwd) => ({ id: "opaque", repoRoot: cwd }),
      history: {
        open: () => ({
          read: async () =>
            page++ === 0 ? { commits: [child], done: false } : { commits: [root], done: true },
          close() {},
        }),
        planReview: (selected, _context, options) => {
          plannedParent = options?.parentRevisionId;
          return selected.parentRevisionIds.length
            ? {
                kind: "revision-range",
                fromRevisionId:
                  options?.parentRevisionId ?? `opaque:base-for/${selected.revisionId}`,
                toRevisionId: selected.revisionId,
              }
            : { kind: "revision-show", revisionId: `opaque:root-view/${selected.revisionId}` };
        },
      },
    });

    const source = await adapter.history!.open({}, { cwd: "/repo" });
    expect((await source.read({ limit: 1 })).commits.map((commit) => commit.revisionId)).toEqual([
      child.revisionId,
    ]);
    expect((await source.read({ limit: 1 })).commits.map((commit) => commit.revisionId)).toEqual([
      root.revisionId,
    ]);
    await expect(adapter.history!.planReview(child, { cwd: "/repo" })).resolves.toEqual({
      kind: "revision-range",
      fromRevisionId: `opaque:base-for/${child.revisionId}`,
      toRevisionId: child.revisionId,
    });
    await expect(
      adapter.history!.planReview(child, { cwd: "/repo" }, { parentRevisionId: root.revisionId }),
    ).resolves.toEqual({
      kind: "revision-range",
      fromRevisionId: root.revisionId,
      toRevisionId: child.revisionId,
    });
    expect(plannedParent).toBe(root.revisionId);
    await expect(adapter.history!.planReview(root, { cwd: "/repo" })).resolves.toEqual({
      kind: "revision-show",
      revisionId: `opaque:root-view/${root.revisionId}`,
    });
  });

  test("rejects parent-before-child ordering across page boundaries", async () => {
    const commit = (revisionId: string, parentRevisionIds: string[]) => ({
      revisionId,
      displayId: revisionId,
      parentRevisionIds,
      subject: revisionId,
      authorName: "Ada",
      authoredAt: "2026-01-01T00:00:00Z",
      decorations: [],
    });
    let page = 0;
    const adapter = toInternalVcsAdapter({
      id: "misordered",
      name: "Misordered",
      detect: () => null,
      history: {
        open: () => ({
          read: async () =>
            page++ === 0
              ? { commits: [commit("parent", [])], done: false }
              : { commits: [commit("child", ["parent"])], done: true },
          close() {},
        }),
        planReview: (selected) => ({
          kind: "revision-show",
          revisionId: selected.revisionId,
        }),
      },
    });
    const source = await adapter.history!.open({}, { cwd: "/repo" });
    await source.read({ limit: 1 });
    await expect(source.read({ limit: 1 })).rejects.toThrow(
      "VCS history returned parent parent before child child.",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { collectSessionCustomThemes } from "../core/theme/customThemes";
import type { Changeset } from "../core/changeset/model";
import { detectVcs, extendVcsCatalog } from "../core/vcs";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import {
  applyExtensionChangesetTransforms,
  applyExtensionFileLanguages,
  applyExtensionRegistrations,
  resolveDetectedVcsIdWithExtensions,
  resolveSessionVcsId,
} from "./apply";
import { emitExtensionEvent, emitExtensionEventBounded } from "./events";
import { createExtensionNotificationHub } from "./notifications";
import { runExtensionFactory } from "./runExtension";
import {
  createEmptyExtensionLoadResult,
  createEmptyExtensionRegistry,
  createExtensionContext,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionLoadResult,
} from "./types";

/**
 * Adversarial-but-plausible use of the public extension API, driven from JS.
 *
 * Every registration point is typed, and none of that typing exists at runtime.
 * Extensions are plain modules a user drops in a directory; plenty are written
 * in JavaScript, and even TypeScript ones are compiled away. So every value
 * below is something a real, well-meaning extension could actually pass — a
 * wrong-cased key, a synchronous function where an async one was wanted, a
 * value that is `null` because a lookup missed.
 *
 * The assertion is always the same shape, and it is the contract from
 * docs/extensions.md: **nothing escapes the host**. A bad input becomes a load
 * issue, an apply issue, a startup notice, or a contained handler warning. It
 * never throws past the API boundary, and it never reaches the renderer.
 */

/** Run one JavaScript-shaped factory through the real loading path. */
function loadFactory(factory: unknown) {
  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];

  const pending = runExtensionFactory({
    metadata: { id: "fuzz-ext", sourcePath: "/tmp/fuzz-ext.ts", origin: "config" },
    registry,
    issues,
    factory: factory as ExtensionFactory,
  });

  return { registry, issues, pending };
}

/** Build a load result whose notifications are captured rather than shown. */
function createCapturingLoadResult(): { result: ExtensionLoadResult; notices: string[] } {
  const notifications = createExtensionNotificationHub();
  const notices: string[] = [];
  notifications.subscribe((notification) => notices.push(notification.message));
  return { result: createEmptyExtensionLoadResult("/repo", notifications), notices };
}

/** A changeset shaped the way the review pipeline produces one. */
function createTestChangeset(): Changeset {
  return {
    id: "changeset-1",
    sourceLabel: "/repo",
    title: "working tree",
    files: [createTestDiffFile({ id: "file-1", path: "a.ts" })],
  } as Changeset;
}

/** Values a JavaScript extension plausibly passes where an object was expected. */
const BASE_VCS_CATALOG = getBundledVcsCatalog();

const JUNK_VALUES = [
  undefined,
  null,
  0,
  1,
  "",
  "nonsense",
  true,
  false,
  [],
  [1, 2, 3],
  {},
  Symbol("nope"),
  () => {},
  NaN,
] as const;

describe("registerTheme with junk", () => {
  test("a theme registration never throws out of the factory", () => {
    for (const junk of JUNK_VALUES) {
      const { issues } = loadFactory((hunk: Record<string, (value: unknown) => void>) => {
        hunk.registerTheme?.(junk);
      });

      // Either it registered (to be validated later) or it was refused as a
      // load issue — never an exception reaching the host.
      expect(Array.isArray(issues)).toBe(true);
    }
  });

  test("every registered theme survives collection, valid or not", () => {
    const { registry } = loadFactory((hunk: { registerTheme: (theme: unknown) => void }) => {
      // A plausible mix: one good theme, and several an author could produce by
      // reading colors out of untyped config.
      hunk.registerTheme({ id: "good", accent: "#112233" });
      hunk.registerTheme({ id: "numeric", accent: 0x112233 });
      hunk.registerTheme({ id: "rgb-string", background: "rgb(1,2,3)" });
      hunk.registerTheme({ id: "shorthand", background: "#123" });
      hunk.registerTheme({ id: "nested", text: { value: "#112233" } });
      hunk.registerTheme({ id: "listy", fileNew: ["#112233"] });
      hunk.registerTheme({ id: "null-color", muted: null });
      hunk.registerTheme({ id: "bad-base", base: "solarized-lite" });
      hunk.registerTheme({ id: "bad-scopes", syntaxScopes: { keyword: 42 } });
      hunk.registerTheme({ id: "scope-list", syntaxScopes: ["#112233"] });
      hunk.registerTheme({ id: "SHOUTING" });
      hunk.registerTheme({ id: "github-dark-default" });
    });

    const collected = collectSessionCustomThemes([], registry.themes);

    // Exactly one theme is usable; every other registration is reported.
    expect(collected.themes.map((theme) => theme.id)).toEqual(["good"]);
    expect(collected.notices).toHaveLength(registry.themes.length - 1);
    for (const notice of collected.notices) {
      expect(notice.message).toContain("Skipped theme");
      expect(notice.message).toContain("fuzz-ext");
    }
  });
});

describe("registerFileLanguage with junk", () => {
  test("refuses unusable extensions and languages as load issues", () => {
    for (const [extension, language] of [
      ["", "python"],
      ["   ", "python"],
      [".", "python"],
      ["ts", ""],
      ["ts", "   "],
      ["ts", null],
      ["ts", 7],
      [null, "python"],
      [undefined, undefined],
      [{}, []],
    ] as Array<[unknown, unknown]>) {
      const { registry, issues } = loadFactory(
        (hunk: { registerFileLanguage: (extension: unknown, language: unknown) => void }) => {
          hunk.registerFileLanguage(extension, language);
        },
      );

      expect(issues).toHaveLength(1);
      expect(issues[0]?.extensionId).toBe("fuzz-ext");
      // A failed factory is rolled back, so nothing partial is left behind.
      expect(registry.fileLanguages).toEqual([]);
      expect(registry.extensions).toEqual([]);
    }
  });

  test("normalizes plausible-but-untidy extensions instead of failing", () => {
    const { registry, issues } = loadFactory(
      (hunk: { registerFileLanguage: (extension: string, language: string) => void }) => {
        hunk.registerFileLanguage("..ZIG", "zig");
        hunk.registerFileLanguage("  .Bzl  ", "python");
      },
    );

    expect(issues).toEqual([]);
    expect(registry.fileLanguages.map((entry) => entry.matcher)).toEqual([
      { kind: "extension", value: "zig" },
      { kind: "extension", value: "bzl" },
    ]);
  });

  test("preserves exact filename and glob values through matching", async () => {
    const { fileLanguageForPath } = await import("../core/changeset/fileLanguageLookup");
    const { registry, issues } = loadFactory(
      (hunk: { registerFileLanguage: (matcher: unknown, language: string) => void }) => {
        hunk.registerFileLanguage({ kind: "filename", value: " Tool\\Hunkfile " }, "python");
        hunk.registerFileLanguage({ kind: "filename", value: " " }, "python");
        hunk.registerFileLanguage({ kind: "glob", value: "*.hunk ", target: "basename" }, "ruby");
        hunk.registerFileLanguage({ kind: "glob", value: "  ", target: "basename" }, "ruby");
        hunk.registerFileLanguage({ kind: "glob", value: " *\\name ", target: "basename" }, "ruby");
        hunk.registerFileLanguage({ kind: "glob", value: "foo?bar", target: "basename" }, "json");
        hunk.registerFileLanguage(
          { kind: "glob", value: "generated/**/*.ts", target: "path" },
          "typescript",
        );
        hunk.registerFileLanguage({ kind: "extension", value: "  .HunkExact  " }, "typescript");
      },
    );

    expect(issues).toEqual([]);
    expect(registry.fileLanguages.map((entry) => entry.matcher)).toEqual([
      { kind: "filename", value: " Tool\\Hunkfile " },
      { kind: "filename", value: " " },
      { kind: "glob", value: "*.hunk ", target: "basename" },
      { kind: "glob", value: "  ", target: "basename" },
      { kind: "glob", value: " *\\name ", target: "basename" },
      { kind: "glob", value: "foo?bar", target: "basename" },
      { kind: "glob", value: "generated/**/*.ts", target: "path" },
      { kind: "extension", value: "hunkexact" },
    ]);

    expect(applyExtensionFileLanguages(registry)).toEqual([]);
    expect(fileLanguageForPath("nested/ Tool\\Hunkfile ")).toBe("python");
    expect(fileLanguageForPath("nested/ ")).toBe("python");
    expect(fileLanguageForPath("nested/example.hunk ")).toBe("ruby");
    expect(fileLanguageForPath("nested/  ")).toBe("ruby");
    expect(fileLanguageForPath("nested/ x\\name ")).toBe("ruby");
    expect(fileLanguageForPath("nested/foo\\bar")).toBe("json");
    expect(fileLanguageForPath("nested/foo\0bar")).toBe("text");
    expect(fileLanguageForPath("generated/nested/example.ts")).toBe("typescript");
    expect(fileLanguageForPath("nested/example.hunkexact")).toBe("typescript");
  });

  test("refuses malformed matcher objects", () => {
    for (const matcher of [
      { kind: "filename", value: "" },
      { kind: "filename", value: "path/Hunkfile" },
      { kind: "glob", value: "*.ts" },
      { kind: "glob", value: "*.ts", target: "somewhere" },
      { kind: "glob", value: "*\0name", target: "basename" },
      { kind: "regex", value: ".*" },
      /.*\.ts/,
    ]) {
      const { registry, issues } = loadFactory(
        (hunk: { registerFileLanguage: (matcher: unknown, language: string) => void }) => {
          hunk.registerFileLanguage(matcher, "python");
        },
      );

      expect(issues).toHaveLength(1);
      expect(registry.fileLanguages).toEqual([]);
    }
  });
});

describe("registerVcsAdapter with junk", () => {
  test("refuses adapters missing the fields detection depends on", () => {
    for (const adapter of [
      undefined,
      null,
      {},
      { id: "hg" },
      { id: "hg", name: "Mercurial" },
      { id: "", name: "Mercurial", detect: () => null },
      { id: "hg", name: "", detect: () => null },
      { id: "hg", name: "Mercurial", detect: "not-a-function" },
      { id: "hg", name: "Mercurial", detect: () => null, operations: "nope" },
      { id: "hg", name: "Mercurial", detect: () => null, operations: [] },
    ] as unknown[]) {
      const { registry, issues } = loadFactory(
        (hunk: { registerVcsAdapter: (adapter: unknown) => void }) => {
          hunk.registerVcsAdapter(adapter);
        },
      );

      expect(issues).toHaveLength(1);
      expect(registry.vcsAdapters).toEqual([]);
    }
  });

  test("survives every plausible detect() return value", () => {
    const returns: unknown[] = [
      null,
      undefined,
      false,
      0,
      "",
      "yes",
      {},
      { id: "hg" },
      { repoRoot: "/repo" },
      { id: "mercurial", repoRoot: "/repo" },
      { id: 7, repoRoot: "/repo" },
      [],
    ];

    for (const value of returns) {
      const { registry, issues } = loadFactory(
        (hunk: { registerVcsAdapter: (adapter: unknown) => void }) => {
          hunk.registerVcsAdapter({
            id: "hg",
            name: "Mercurial",
            detect: () => value,
          });
        },
      );

      expect(issues).toEqual([]);
      const adapter = registry.vcsAdapters[0]?.adapter;
      expect(adapter).toBeDefined();

      const detected = adapter?.detect("/repo");
      if (detected) {
        // Whatever came back, the id is the registered one — the id every
        // downstream lookup keys off. A foreign id used to abort the session.
        expect(detected.id).toBe("hg");
      }

      // Detection over the complete catalog never throws either.
      const catalog = extendVcsCatalog(BASE_VCS_CATALOG, [adapter!]);
      expect(() => detectVcs("/repo", catalog)).not.toThrow();
      expect(() => resolveDetectedVcsIdWithExtensions("/repo", catalog)).not.toThrow();
      expect(() => resolveSessionVcsId("hg", "/repo", catalog)).not.toThrow();
    }
  });

  test("a detect() that throws does not stop other adapters being consulted", () => {
    const { registry } = loadFactory((hunk: { registerVcsAdapter: (adapter: unknown) => void }) => {
      hunk.registerVcsAdapter({
        id: "explodes",
        name: "Explodes",
        detect: () => {
          throw new Error("boom");
        },
      });
    });

    const adapters = registry.vcsAdapters.map((entry) => entry.adapter);
    // Hunk's own repo is a Git checkout, so a throwing extension adapter must
    // not prevent Git from being detected.
    expect(detectVcs(process.cwd(), extendVcsCatalog(BASE_VCS_CATALOG, adapters))?.id).toBe("git");
  });

  test("an adapter whose operations are unusable reports unsupported, not a TypeError", () => {
    const { registry, issues } = loadFactory(
      (hunk: { registerVcsAdapter: (adapter: unknown) => void }) => {
        hunk.registerVcsAdapter({
          id: "hg",
          name: "Mercurial",
          detect: (cwd: string) => ({ id: "hg", repoRoot: cwd }),
          operations: {
            "working-tree-diff": { load: "not-a-function" },
            "revision-show": null,
            "stash-show": 42,
          },
        });
      },
    );

    expect(issues).toEqual([]);
    // Every unusable entry is dropped, so lookup reports "not supported"
    // instead of calling something that is not callable mid-review.
    expect(registry.vcsAdapters[0]?.adapter.operations).toEqual({});
  });

  test("built-in ids stay reserved however an extension asks for them", () => {
    const { registry } = loadFactory((hunk: { registerVcsAdapter: (a: unknown) => void }) => {
      for (const id of ["git", "jj", "sl"]) {
        hunk.registerVcsAdapter({ id, name: id, detect: () => null });
      }
      hunk.registerVcsAdapter({ id: "hg", name: "Mercurial", detect: () => null });
    });

    const applied = applyExtensionRegistrations(
      {
        ...createEmptyExtensionLoadResult("/repo"),
        registry,
      },
      BASE_VCS_CATALOG,
    );

    expect(applied.vcsAdapters.map((adapter) => adapter.id)).toEqual(["hg"]);
    expect(applied.issues).toHaveLength(3);
  });
});

describe("on(event, handler) with junk", () => {
  test("refuses unknown events and non-function handlers", () => {
    for (const [event, handler] of [
      ["startup", null],
      ["startup", undefined],
      ["startup", "not-a-function"],
      ["startup", {}],
      ["Startup", () => {}],
      ["changesetLoaded", () => {}],
      ["", () => {}],
      [null, () => {}],
      [7, () => {}],
    ] as Array<[unknown, unknown]>) {
      const { registry, issues } = loadFactory(
        (hunk: { on: (event: unknown, handler: unknown) => void }) => {
          hunk.on(event, handler);
        },
      );

      expect(issues).toHaveLength(1);
      expect(registry.eventHandlers.startup).toEqual([]);
    }
  });

  test("a handler that throws, rejects, or mutates its payload is contained", async () => {
    const changeset = createTestChangeset();
    const liveFiles = changeset.files;
    const { result, notices } = createCapturingLoadResult();

    result.registry.eventHandlers.changeset_loaded.push(
      {
        extensionId: "thrower",
        handler: () => {
          throw new Error("boom");
        },
      },
      {
        extensionId: "rejecter",
        handler: () => Promise.reject(new Error("async boom")),
      },
      {
        extensionId: "mutator",
        handler: (payload) => {
          (payload as { changeset: { files: unknown[] } }).changeset.files.push({ id: "junk" });
        },
      },
      {
        extensionId: "deleter",
        handler: (payload) => {
          // Reaching for the envelope rather than the changeset: this must not
          // change what the handlers after it see.
          delete (payload as unknown as { changeset?: unknown }).changeset;
        },
      },
      {
        extensionId: "reader",
        handler: (payload, ctx) => {
          ctx.notify(
            `saw ${(payload as { changeset: Changeset }).changeset.files.length} files`,
            "info",
          );
        },
      },
    );

    emitExtensionEvent(result, "changeset_loaded", { changeset });
    await Bun.sleep(0);

    // The well-behaved handler still ran and still saw the real contents.
    expect(notices).toContain("saw 1 files");
    // Every misbehaving one was reported by name, and none of it reached the app.
    expect(notices.some((notice) => notice.includes("Extension thrower failed"))).toBe(true);
    expect(notices.some((notice) => notice.includes("Extension rejecter failed"))).toBe(true);
    expect(notices.some((notice) => notice.includes("Extension mutator failed"))).toBe(true);
    expect(notices.some((notice) => notice.includes("Extension deleter failed"))).toBe(true);
    expect(changeset.files).toBe(liveFiles);
    expect(changeset.files).toHaveLength(1);
  });

  test("a shutdown handler that never settles does not block exit", async () => {
    const { result, notices } = createCapturingLoadResult();
    result.registry.eventHandlers.shutdown.push({
      extensionId: "hangs",
      handler: () => new Promise<void>(() => {}),
    });

    const started = Date.now();
    await emitExtensionEventBounded(result, "shutdown", {}, 20);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(notices).toEqual([]);
  });
});

describe("transformChangeset with near-miss return shapes", () => {
  test("refuses a non-function transform as a load issue", () => {
    for (const junk of JUNK_VALUES.filter((value) => typeof value !== "function")) {
      const { registry, issues } = loadFactory(
        (hunk: { transformChangeset: (fn: unknown) => void }) => {
          hunk.transformChangeset(junk);
        },
      );

      expect(issues).toHaveLength(1);
      expect(registry.changesetTransforms).toEqual([]);
    }
  });

  test("keeps the previous changeset for every unusable return value", async () => {
    const nearMisses: unknown[] = [
      undefined,
      null,
      "changeset",
      42,
      [],
      {},
      { files: null },
      { files: "a.ts" },
      { files: [null] },
      { files: [{ path: "a.ts" }] },
      { files: [{ id: "", path: "a.ts" }] },
      { files: [{ id: "a", path: 7 }] },
      // Missing the stats the sidebar and the header totals read unguarded.
      { files: [{ id: "a", path: "a.ts", metadata: { hunks: [] } }] },
      // Missing the metadata the renderer draws from.
      { files: [{ id: "a", path: "a.ts", stats: { additions: 1, deletions: 0 } }] },
      {
        files: [
          { id: "a", path: "a.ts", stats: { additions: 1, deletions: 0 }, metadata: { hunks: 3 } },
        ],
      },
      {
        files: [
          {
            id: "a",
            path: "a.ts",
            stats: { additions: 1, deletions: 0 },
            metadata: { hunks: [{ noHunkContent: true }] },
          },
        ],
      },
      // Two files claiming one id corrupts selection and note targeting.
      {
        files: [
          {
            id: "dup",
            path: "a.ts",
            stats: { additions: 0, deletions: 0 },
            metadata: { hunks: [] },
          },
          {
            id: "dup",
            path: "b.ts",
            stats: { additions: 0, deletions: 0 },
            metadata: { hunks: [] },
          },
        ],
      },
    ];

    for (const returned of nearMisses) {
      const original = createTestChangeset();
      const { result, notices } = createCapturingLoadResult();
      result.registry.changesetTransforms.push({
        extensionId: "near-miss",
        transform: (() => returned) as never,
      });

      const next = await applyExtensionChangesetTransforms(result, original);

      // The changeset the UI renders is untouched, and the user was told why.
      expect(next).toBe(original);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("Extension near-miss returned an invalid changeset");
    }
  });

  test("a transform that throws or rejects keeps the previous changeset", async () => {
    for (const transform of [
      () => {
        throw new Error("sync boom");
      },
      () => Promise.reject(new Error("async boom")),
    ]) {
      const original = createTestChangeset();
      const { result, notices } = createCapturingLoadResult();
      result.registry.changesetTransforms.push({
        extensionId: "thrower",
        transform: transform as never,
      });

      const next = await applyExtensionChangesetTransforms(result, original);

      expect(next).toBe(original);
      expect(notices[0]).toContain("Extension thrower failed transforming the changeset");
    }
  });

  test("a valid transform still composes after a broken one", async () => {
    const original = createTestChangeset();
    const { result, notices } = createCapturingLoadResult();
    result.registry.changesetTransforms.push(
      { extensionId: "broken", transform: (() => "nope") as never },
      {
        extensionId: "working",
        transform: ((changeset: Changeset) => ({
          ...changeset,
          title: "rewritten",
        })) as never,
      },
    );

    const next = await applyExtensionChangesetTransforms(result, original);

    expect(next.title).toBe("rewritten");
    expect(notices).toHaveLength(1);
  });
});

describe("factories that misbehave outright", () => {
  test("a factory that throws is rolled back and reported", () => {
    const { registry, issues } = loadFactory(
      (hunk: { registerFileLanguage: (e: string, l: string) => void }) => {
        hunk.registerFileLanguage(".zig", "zig");
        throw new Error("halfway");
      },
    );

    expect(issues).toHaveLength(1);
    expect(registry.fileLanguages).toEqual([]);
    expect(registry.extensions).toEqual([]);
  });

  test("an async factory that rejects is rolled back and reported", async () => {
    const { registry, issues, pending } = loadFactory(
      async (hunk: { registerFileLanguage: (e: string, l: string) => void }) => {
        hunk.registerFileLanguage(".zig", "zig");
        throw new Error("halfway");
      },
    );

    await pending;

    expect(issues).toHaveLength(1);
    expect(registry.fileLanguages).toEqual([]);
  });

  test("a factory that stashes the API cannot mutate the registry later", () => {
    let escaped: Record<string, (...args: unknown[]) => void> | undefined;
    const { registry } = loadFactory((hunk: typeof escaped) => {
      escaped = hunk;
    });

    for (const method of [
      "configureSession",
      "registerTheme",
      "registerFileLanguage",
      "registerVcsAdapter",
      "transformChangeset",
      "on",
    ]) {
      expect(() => escaped?.[method]?.({}, {})).toThrow(
        /can only be called while the extension is loading/,
      );
    }

    expect(registry.themes).toEqual([]);
    expect(registry.vcsAdapters).toEqual([]);
    expect(registry.changesetTransforms).toEqual([]);
  });

  test("hunk.log coerces whatever it is given", () => {
    const { registry, issues } = loadFactory((hunk: { log: (message: unknown) => void }) => {
      hunk.log(undefined);
      hunk.log(null);
      hunk.log(42);
      hunk.log({ toString: () => "object" });
      hunk.log([1, 2]);
    });

    expect(issues).toEqual([]);
    expect(registry.logs.map((entry) => entry.message)).toEqual([
      "undefined",
      "null",
      "42",
      "object",
      "1,2",
    ]);
  });

  test("ctx.notify tolerates junk without a subscriber", () => {
    const context = createExtensionContext("/repo");

    for (const junk of JUNK_VALUES) {
      expect(() => context.notify(junk as string, junk as never)).not.toThrow();
    }
  });
});

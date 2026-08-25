import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Changeset } from "../core/changeset/model";
import { getVcsOperation } from "../core/vcs";
import type { VcsAdapter } from "../core/vcs/types";
import { discoverExtensions } from "./discovery";
import { retireExtensionLoadResult } from "./events";
import { loadExtensions } from "./host";
import { createExtensionNotificationHub } from "./notifications";
import {
  deriveExtensionId,
  HUNK_EXTENSION_API_VERSION,
  type ExtensionCandidate,
  type ExtensionFactory,
  type ExtensionOrigin,
} from "./types";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Write one file on disk, creating parent directories as needed. */
function writeTestFile(dir: string, fileName: string, source: string) {
  const path = join(dir, fileName);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source);
  return path;
}

/**
 * Write one real extension file and describe it as a discovery candidate.
 *
 * Extensions are loaded through a plain dynamic import, so tests exercise the
 * same TypeScript-from-disk path the product uses.
 */
function createTestExtension(
  dir: string,
  fileName: string,
  source: string,
  origin: ExtensionOrigin = "flag",
): ExtensionCandidate {
  const path = writeTestFile(dir, fileName, source);
  return { id: deriveExtensionId(path), path, origin };
}

function createTestChangeset(): Changeset {
  return { id: "changeset:test", sourceLabel: "repo", title: "test", files: [] };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("extension host", () => {
  test("publishes provisional ownership before the first module import settles", async () => {
    const dir = createTempDir("hunk-host-provisional-");
    const candidate = createTestExtension(dir, "delayed.ts", "export default function () {}\n");
    let finishImport!: (module: unknown) => void;
    const imported = new Promise<unknown>((resolve) => {
      finishImport = resolve;
    });
    let provisional: Awaited<ReturnType<typeof loadExtensions>> | undefined;

    const loading = loadExtensions({
      candidates: [candidate],
      cwd: dir,
      importExtensionModuleImpl: () => imported,
      onProvisionalLoad: (result) => {
        provisional = result;
      },
    });

    expect(provisional?.registry.eventBusPhase).toBe("loading");
    finishImport({ default: () => {} });
    expect(await loading).toBe(provisional!);
  });

  test("keeps retirement terminal when an asynchronous factory resumes late", async () => {
    const dir = createTempDir("hunk-host-retired-factory-");
    const candidate = createTestExtension(dir, "delayed.ts", "export default function () {}\n");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let shutdowns = 0;
    const factory: ExtensionFactory = async (hunk) => {
      hunk.on("shutdown", () => {
        shutdowns += 1;
      });
      markStarted();
      await barrier;
      hunk.registerTheme({ id: "too-late", label: "Too late", background: "#000000" });
    };
    let provisional: Awaited<ReturnType<typeof loadExtensions>> | undefined;
    const loading = loadExtensions({
      candidates: [candidate],
      cwd: dir,
      importExtensionModuleImpl: async () => ({ default: factory }),
      onProvisionalLoad: (result) => {
        provisional = result;
      },
    });
    await started;

    const retirement = retireExtensionLoadResult(provisional);
    release();
    const result = await loading;
    await retirement;

    expect(shutdowns).toBe(1);
    expect(result.registry.eventBusPhase).toBe("closed");
    expect(result.registry.themes).toEqual([]);
    expect(result.registry.extensions).toEqual([]);
  });

  test("collects registrations from a TypeScript extension on disk", async () => {
    const dir = createTempDir("hunk-host-register-");
    const candidate = createTestExtension(
      dir,
      "kitchen-sink.ts",
      `import type { HunkExtensionAPI } from ${JSON.stringify(join(import.meta.dir, "types.ts"))};

export default function (hunk: HunkExtensionAPI) {
  hunk.registerTheme({ id: "midnight", label: "Midnight", background: "#101010" });
  hunk.registerFileLanguage(".Prisma", "graphql");
  hunk.registerVcsAdapter({ id: "fossil", name: "Fossil", detect: () => null, operations: {} });
  hunk.transformChangeset((changeset) => ({ ...changeset, title: "transformed" }));
  hunk.on("changeset_loaded", () => {});
  hunk.log("ready");
}
`,
    );

    const result = await loadExtensions({ candidates: [candidate], cwd: dir });

    expect(result.issues).toEqual([]);
    expect(result.loaded).toEqual([
      { id: "kitchen-sink", sourcePath: candidate.path, origin: "flag" },
    ]);
    expect(result.registry.themes).toEqual([
      {
        extensionId: "kitchen-sink",
        theme: { id: "midnight", label: "Midnight", background: "#101010" },
      },
    ]);
    // Extensions may write ".Prisma"; Pierre wants a dotless, lowercased key.
    expect(result.registry.fileLanguages).toEqual([
      {
        extensionId: "kitchen-sink",
        matcher: { kind: "extension", value: "prisma" },
        language: "graphql",
      },
    ]);
    expect(result.registry.vcsAdapters.map((entry) => entry.adapter.id)).toEqual(["fossil"]);
    expect(result.registry.eventHandlers.changeset_loaded).toHaveLength(1);
    expect(result.registry.logs).toEqual([{ extensionId: "kitchen-sink", message: "ready" }]);

    const transform = result.registry.changesetTransforms[0];
    expect(transform?.extensionId).toBe("kitchen-sink");
    expect(
      (await transform?.transform(createTestChangeset(), { cwd: dir, notify: () => {} }))?.title,
    ).toBe("transformed");
  });

  test("replays a factory event after every extension has subscribed", async () => {
    const dir = createTempDir("hunk-host-factory-event-");
    const listener = createTestExtension(
      dir,
      "listener.ts",
      `export default function (hunk) {
  hunk.events.on("summary:ready", (payload) => hunk.log("received:" + payload.count));
}
`,
    );
    const emitter = createTestExtension(
      dir,
      "emitter.ts",
      `export default function (hunk) {
  hunk.events.emit("summary:ready", { count: 3 });
}
`,
    );

    const result = await loadExtensions({ candidates: [listener, emitter], cwd: dir });

    expect(result.issues).toEqual([]);
    expect(result.registry.logs).toEqual([{ extensionId: "listener", message: "received:3" }]);
    expect(result.registry.pendingCustomEvents).toEqual([]);
  });

  test("loads a folder extension whose index imports a sibling module", async () => {
    const dir = createTempDir("hunk-host-folder-");
    // The helper is written first so the index's relative import resolves.
    createTestExtension(
      dir,
      join("folder-ext", "helper.ts"),
      `export const language = "graphql";\n`,
    );
    const candidate = createTestExtension(
      dir,
      join("folder-ext", "index.ts"),
      `import { language } from "./helper";

export default function (hunk: { registerFileLanguage: (e: string, l: string) => void }) {
  hunk.registerFileLanguage("proof", language);
}
`,
      "config",
    );

    const result = await loadExtensions({ candidates: [candidate], cwd: dir });

    // The id comes from the folder, and the sibling import resolved at load time.
    expect(result.issues).toEqual([]);
    expect(result.loaded).toEqual([
      { id: "folder-ext", sourcePath: candidate.path, origin: "config" },
    ]);
    expect(result.registry.fileLanguages).toEqual([
      {
        extensionId: "folder-ext",
        matcher: { kind: "extension", value: "proof" },
        language: "graphql",
      },
    ]);
  });

  test("loads a manifest folder extension against its own node_modules", async () => {
    const root = createTempDir("hunk-host-manifest-dep-");
    const folder = join(root, "dep-ext");
    writeTestFile(
      folder,
      "package.json",
      `{"name":"dep-ext","hunk":{"extensions":["./src/index.ts"]},"dependencies":{"fake-dep":"1.0.0"}}`,
    );
    // A hand-written dependency stands in for an installed one: the point is
    // that the entry file resolves imports from the extension's own folder.
    writeTestFile(
      join(folder, "node_modules", "fake-dep"),
      "package.json",
      `{"name":"fake-dep","version":"1.0.0","main":"index.js"}`,
    );
    writeTestFile(
      join(folder, "node_modules", "fake-dep"),
      "index.js",
      `module.exports = { language: "graphql" };\n`,
    );
    const entryPath = writeTestFile(
      folder,
      join("src", "index.ts"),
      `import fakeDep from "fake-dep";

export default function (hunk: { registerFileLanguage: (e: string, l: string) => void }) {
  hunk.registerFileLanguage("dep", fakeDep.language);
}
`,
    );

    // Going through discovery is the point: the manifest is what turns the
    // folder into this one entry, and what keeps the folder's name as the id.
    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });
    const result = await loadExtensions({ candidates, cwd: root });

    expect(candidates).toEqual([{ id: "dep-ext", path: entryPath, origin: "flag" }]);
    expect(result.issues).toEqual([]);
    expect(result.loaded).toEqual([{ id: "dep-ext", sourcePath: entryPath, origin: "flag" }]);
    expect(result.registry.fileLanguages).toEqual([
      {
        extensionId: "dep-ext",
        matcher: { kind: "extension", value: "dep" },
        language: "graphql",
      },
    ]);
  });

  test("loads a discovered standalone .tsx entry with JSX in it", async () => {
    // The docs' sidebar example is a bare `flat-sidebar.tsx` in the global
    // extensions directory; discovery finding it and the host importing its
    // JSX is the whole contract that example depends on.
    const globalDir = createTempDir("hunk-host-tsx-");
    const entryPath = writeTestFile(
      globalDir,
      "flat-sidebar.tsx",
      `function FlatSidebar() {
  return <text content="flat" />;
}

export default function (hunk: { registerSidebarView: (view: unknown) => void }) {
  hunk.registerSidebarView({ id: "flat", component: FlatSidebar });
}
`,
    );

    const candidates = discoverExtensions({
      cwd: globalDir,
      repoRoot: undefined,
      globalExtensionsDir: globalDir,
      env: {},
    });
    const result = await loadExtensions({ candidates, cwd: globalDir });

    expect(candidates).toEqual([{ id: "flat-sidebar", path: entryPath, origin: "global" }]);
    expect(result.issues).toEqual([]);
    expect(result.loaded).toEqual([
      { id: "flat-sidebar", sourcePath: entryPath, origin: "global" },
    ]);
    expect(
      result.registry.panes.map((entry) => ({
        extensionId: entry.extensionId,
        viewId: entry.pane.id,
      })),
    ).toEqual([{ extensionId: "flat-sidebar", viewId: "flat" }]);
  });

  test("awaits an async factory before sealing the API", async () => {
    const dir = createTempDir("hunk-host-async-");
    const candidate = createTestExtension(
      dir,
      "async-pack.ts",
      `export default async function (hunk: { registerFileLanguage: (e: string, l: string) => void }) {
  await new Promise((resolve) => setTimeout(resolve, 1));
  hunk.registerFileLanguage("zig", "rust");
}
`,
    );

    const result = await loadExtensions({ candidates: [candidate], cwd: dir });

    expect(result.issues).toEqual([]);
    expect(result.registry.fileLanguages).toEqual([
      {
        extensionId: "async-pack",
        matcher: { kind: "extension", value: "zig" },
        language: "rust",
      },
    ]);
  });

  test("isolates a throwing extension without blocking the others", async () => {
    const dir = createTempDir("hunk-host-isolation-");
    const broken = createTestExtension(
      dir,
      "broken.ts",
      `export default function (hunk: { registerFileLanguage: (e: string, l: string) => void }) {
  hunk.registerFileLanguage("half", "done");
  throw new Error("boom");
}
`,
    );
    const missing: ExtensionCandidate = {
      id: "absent",
      path: join(dir, "absent.ts"),
      origin: "config",
    };
    const noDefault = createTestExtension(dir, "no-default.ts", "export const nope = 1;\n");
    const healthy = createTestExtension(
      dir,
      "healthy.ts",
      `export default function (hunk: { registerFileLanguage: (e: string, l: string) => void }) {
  hunk.registerFileLanguage("prisma", "graphql");
}
`,
    );

    const result = await loadExtensions({
      candidates: [broken, missing, noDefault, healthy],
      cwd: dir,
    });

    expect(result.loaded.map((entry) => entry.id)).toEqual(["healthy"]);
    expect(result.issues.map((issue) => issue.extensionId)).toEqual([
      "broken",
      "absent",
      "no-default",
    ]);
    expect(result.issues[0]?.message).toBe("boom");
    expect(result.issues[1]?.origin).toBe("config");
    expect(result.issues[2]?.message).toContain("default-export a function");
    // A partially applied extension must not leave registrations behind.
    expect(result.registry.fileLanguages).toEqual([
      {
        extensionId: "healthy",
        matcher: { kind: "extension", value: "prisma" },
        language: "graphql",
      },
    ]);
  });

  test("refuses reserved extension ids without touching the rest of the pass", async () => {
    const dir = createTempDir("hunk-host-reserved-");
    const source = `export default function (hunk: { registerFileLanguage: (e: string, l: string) => void }) {
  hunk.registerFileLanguage("prisma", "graphql");
}
`;
    // `hunk` owns every built-in command id and the bundled sidebar's view key;
    // `git` owns a shipped VCS backend. Neither may be claimed from disk.
    const vendor = createTestExtension(dir, "hunk.ts", source);
    const backend = createTestExtension(dir, "git.ts", source);
    const healthy = createTestExtension(dir, "healthy.ts", source);

    const result = await loadExtensions({
      candidates: [vendor, backend, healthy],
      cwd: dir,
      reservedExtensionIds: new Set(["git", "jj", "sl"]),
    });

    expect(result.loaded.map((entry) => entry.id)).toEqual(["healthy"]);
    expect(result.issues.map((issue) => issue.extensionId)).toEqual(["hunk", "git"]);
    expect(result.issues[0]?.message).toContain("reserved by Hunk");
    expect(result.issues[0]?.message).toContain(vendor.path);
    expect(result.issues[1]?.message).toContain("reserved by Hunk");
    expect(result.registry.fileLanguages).toEqual([
      {
        extensionId: "healthy",
        matcher: { kind: "extension", value: "prisma" },
        language: "graphql",
      },
    ]);
  });

  test("refuses ids that would not parse as a namespace", async () => {
    const dir = createTempDir("hunk-host-charset-");
    const source = `export default function (hunk: { log: (message: string) => void }) {
  hunk.log("loaded");
}
`;
    // A dot would break `<extensionId>.<commandId>`; a colon would break
    // `<extensionId>:<viewId>`, so neither can spell an id.
    const dotted = createTestExtension(dir, "my.ext.ts", source);
    const leading = createTestExtension(dir, "-lead.ts", source);

    const result = await loadExtensions({ candidates: [dotted, leading], cwd: dir });

    expect(result.loaded).toEqual([]);
    expect(result.issues.map((issue) => issue.extensionId)).toEqual(["my.ext", "-lead"]);
    expect(result.issues[0]?.message).toContain("not a usable extension id");
    expect(result.issues[1]?.message).toContain("not a usable extension id");
  });

  test("refuses a manifest folder whose declared id breaks the same rules", async () => {
    const root = createTempDir("hunk-host-manifest-id-");
    const folder = join(root, "my.ext");
    writeTestFile(folder, "package.json", `{"hunk":{"extensions":["./entry.ts"]}}`);
    writeTestFile(folder, "entry.ts", `export default function () {}\n`);

    // A single-entry manifest is named by its folder, so manifest ids reach the
    // same gate rather than getting a second, looser rule of their own.
    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });
    const result = await loadExtensions({ candidates, cwd: root });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["my.ext"]);
    expect(result.loaded).toEqual([]);
    expect(result.issues[0]?.message).toContain("not a usable extension id");
  });

  test("keeps the first extension claiming an id when two sources collide", async () => {
    const first = createTempDir("hunk-host-dup-first-");
    const second = createTempDir("hunk-host-dup-second-");
    const winner = createTestExtension(
      first,
      "notes.ts",
      `export default function (hunk: { log: (message: string) => void }) {
  hunk.log("first");
}
`,
      "config",
    );
    const loser = createTestExtension(
      second,
      "notes.ts",
      `export default function (hunk: { log: (message: string) => void }) {
  hunk.log("second");
}
`,
      "global",
    );

    const result = await loadExtensions({ candidates: [winner, loser], cwd: first });

    // Sharing an id would mean sharing a config table, command ids, and view
    // keys, so discovery order decides and the loser is reported.
    expect(result.loaded).toEqual([{ id: "notes", sourcePath: winner.path, origin: "config" }]);
    expect(result.registry.logs).toEqual([{ extensionId: "notes", message: "first" }]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.origin).toBe("global");
    expect(result.issues[0]?.message).toContain('another extension already loaded as "notes"');
    expect(result.issues[0]?.message).toContain(winner.path);
  });

  test("rejects registration attempted after the load pass finished", async () => {
    const dir = createTempDir("hunk-host-late-");
    const candidate = createTestExtension(
      dir,
      "late.ts",
      `export default function (hunk: {
  registerTheme: (theme: { id: string }) => void;
  log: (message: string) => void;
}) {
  setTimeout(() => {
    try {
      hunk.registerTheme({ id: "too-late" });
    } catch (error) {
      (globalThis as Record<string, unknown>).hunkLateRegistrationError = String(error);
    }
  }, 0);
}
`,
    );

    const result = await loadExtensions({ candidates: [candidate], cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(result.issues).toEqual([]);
    expect(result.registry.themes).toEqual([]);
    expect(String((globalThis as Record<string, unknown>).hunkLateRegistrationError)).toContain(
      "only be called while the extension is loading",
    );
  });

  test("defaults a VCS adapter registered without operations to an empty map", async () => {
    const dir = createTempDir("hunk-host-vcs-");
    // Written as JavaScript on purpose: the types make `operations` optional,
    // and only an untyped extension can leave the map off entirely.
    const candidate = createTestExtension(
      dir,
      "bare-adapter.js",
      `export default function (hunk) {
  hunk.registerVcsAdapter({ id: "fossil", name: "Fossil", detect: () => null });
}
`,
    );

    const result = await loadExtensions({ candidates: [candidate], cwd: dir });
    const adapter = result.registry.vcsAdapters[0]?.adapter;

    expect(result.issues).toEqual([]);
    expect(adapter?.operations).toEqual({});
    // The lookup that used to throw a raw TypeError now reports "unsupported".
    expect(
      getVcsOperation(adapter as VcsAdapter, {
        kind: "working-tree-diff",
        input: { kind: "vcs", staged: false, options: {} },
      }),
    ).toBeUndefined();
  });

  test("rejects a VCS adapter whose operations are not an object", async () => {
    const dir = createTempDir("hunk-host-vcs-invalid-");
    const candidate = createTestExtension(
      dir,
      "bad-adapter.js",
      `export default function (hunk) {
  hunk.registerVcsAdapter({ id: "fossil", name: "Fossil", detect: () => null, operations: [] });
}
`,
    );

    const result = await loadExtensions({ candidates: [candidate], cwd: dir });

    expect(result.registry.vcsAdapters).toEqual([]);
    expect(result.issues[0]?.message).toContain("operations");
  });

  test("delivers each extension its own config table", async () => {
    const dir = createTempDir("hunk-host-config-");
    const source = `export default function (hunk: {
  config: Record<string, unknown>;
  log: (message: string) => void;
}) {
  hunk.log(JSON.stringify(hunk.config));
}
`;
    const configured = createTestExtension(dir, "configured.ts", source);
    const unconfigured = createTestExtension(dir, "unconfigured.ts", source);

    const result = await loadExtensions({
      candidates: [configured, unconfigured],
      cwd: dir,
      extensionConfigs: { configured: { severity: "blocking" } },
    });

    expect(result.registry.logs).toEqual([
      { extensionId: "configured", message: '{"severity":"blocking"}' },
      { extensionId: "unconfigured", message: "{}" },
    ]);
  });

  test("routes ctx.notify through the host sink", async () => {
    const dir = createTempDir("hunk-host-notify-");
    const candidate = createTestExtension(
      dir,
      "notifier.ts",
      `export default function (hunk: {
  transformChangeset: (fn: (changeset: unknown, ctx: { notify: (m: string, t?: string) => void }) => unknown) => void;
}) {
  hunk.transformChangeset((changeset, ctx) => {
    ctx.notify("hello", "warning");
    return changeset;
  });
}
`,
    );

    const notices: Array<[string, string]> = [];
    const notifications = createExtensionNotificationHub();
    notifications.subscribe((notification) =>
      notices.push([notification.message, notification.type]),
    );
    const result = await loadExtensions({
      candidates: [candidate],
      cwd: dir,
      notifications,
    });

    // The load pass owns one context, so every extension notifies the same sink.
    expect(result.context.cwd).toBe(dir);
    expect(result.notifications).toBe(notifications);
    await result.registry.changesetTransforms[0]?.transform(createTestChangeset(), result.context);

    expect(notices).toEqual([["hello", "warning"]]);
  });

  test("gives every load pass a notification hub when none is supplied", async () => {
    const dir = createTempDir("hunk-host-no-sink-");
    const result = await loadExtensions({ candidates: [], cwd: dir });

    expect(() => result.context.notify("ignored")).not.toThrow();
    // The buffered notification is still delivered once a listener attaches.
    const seen: string[] = [];
    result.notifications.subscribe((notification) => seen.push(notification.message));
    expect(seen).toEqual(["ignored"]);
  });
});

describe("manifest api version gating", () => {
  test("refuses a candidate requiring a newer extension API without importing it", async () => {
    const dir = createTempDir("hunk-host-api-gate-");
    // A syntax error proves refusal happens before the module is ever imported.
    const path = writeTestFile(dir, "future.ts", "this is not valid typescript {{{");
    const candidate: ExtensionCandidate = {
      id: "future",
      path,
      origin: "global",
      requiresApiVersion: 999,
    };

    const result = await loadExtensions({ candidates: [candidate], cwd: dir });

    expect(result.loaded).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.extensionId).toBe("future");
    expect(result.issues[0]?.message).toContain("requires Hunk extension API v999");
    expect(result.issues[0]?.message).toContain("upgrade Hunk");
  });

  test("loads a candidate whose requirement matches the current extension API", async () => {
    const dir = createTempDir("hunk-host-api-ok-");
    const candidate = {
      ...createTestExtension(
        dir,
        "current.ts",
        `export default (hunk) => { hunk.registerFileLanguage("xyz", "xml"); };\n`,
      ),
      requiresApiVersion: HUNK_EXTENSION_API_VERSION,
    };

    const result = await loadExtensions({ candidates: [candidate], cwd: dir });

    expect(result.issues).toHaveLength(0);
    expect(result.loaded.map((extension) => extension.id)).toEqual(["current"]);
  });

  test("lets a later compatible source claim an id refused for its api requirement", async () => {
    const dir = createTempDir("hunk-host-api-dup-");
    const refusedPath = writeTestFile(dir, "newer/tool.ts", "export default () => {};\n");
    const compatible = createTestExtension(
      join(dir, "older"),
      "tool.ts",
      `export default (hunk) => { hunk.registerFileLanguage("abc", "xml"); };\n`,
    );

    const result = await loadExtensions({
      candidates: [
        { id: "tool", path: refusedPath, origin: "global", requiresApiVersion: 999 },
        compatible,
      ],
      cwd: dir,
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe(refusedPath);
    expect(result.loaded.map((extension) => extension.id)).toEqual(["tool"]);
  });
});

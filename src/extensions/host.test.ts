import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Changeset } from "../core/types";
import { getVcsOperation } from "../core/vcs";
import type { VcsAdapter } from "../core/vcs/types";
import { loadExtensions } from "./host";
import { createExtensionNotificationHub } from "./notifications";
import { deriveExtensionId, type ExtensionCandidate, type ExtensionOrigin } from "./types";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
  const path = join(dir, fileName);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source);
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
      { extensionId: "kitchen-sink", extension: "prisma", language: "graphql" },
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
      { extensionId: "async-pack", extension: "zig", language: "rust" },
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
      { extensionId: "healthy", extension: "prisma", language: "graphql" },
    ]);
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

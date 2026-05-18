import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedHunkSession } from "./index";
import { createScopedKeyInput } from "./mount";
import { embeddedHunkSessionInternals } from "./session";
import type { EmbeddedHunkSession } from "./types";

const patchText = [
  "diff --git a/example.ts b/example.ts",
  "--- a/example.ts",
  "+++ b/example.ts",
  "@@ -1 +1 @@",
  "-const value = 1;",
  "+const value = 2;",
  "",
].join("\n");

let previousHunkMcpDisable: string | undefined;

/** Return the private app bootstrap for assertions that public snapshots intentionally hide. */
function renderBootstrap(session: EmbeddedHunkSession) {
  return embeddedHunkSessionInternals(session).getRenderSnapshot().bootstrap;
}

/** Return the loaded patch text for one embedded session. */
function loadedPatch(session: EmbeddedHunkSession) {
  return renderBootstrap(session)
    .changeset.files.map((file) => file.patch)
    .join("\n");
}

describe("embedded Hunk sessions", () => {
  beforeEach(() => {
    previousHunkMcpDisable = process.env.HUNK_MCP_DISABLE;
    process.env.HUNK_MCP_DISABLE = "1";
  });

  afterEach(() => {
    if (previousHunkMcpDisable === undefined) {
      delete process.env.HUNK_MCP_DISABLE;
    } else {
      process.env.HUNK_MCP_DISABLE = previousHunkMcpDisable;
    }
  });

  test("loads embedded sessions through Hunk config resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-config-"));
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      const configHome = join(root, "config");
      mkdirSync(join(configHome, "hunk"), { recursive: true });
      writeFileSync(
        join(configHome, "hunk", "config.toml"),
        ['theme = "midnight"', 'mode = "stack"', "line_numbers = false"].join("\n"),
      );
      process.env.XDG_CONFIG_HOME = configHome;

      const session = await createEmbeddedHunkSession({
        cwd: root,
        source: { kind: "patch", text: patchText, options: { theme: "paper" } },
      });
      const snapshot = session.getSnapshot();

      expect(snapshot.status).toBe("ready");
      if (snapshot.status !== "ready") throw new Error("Expected embedded session to load.");
      expect("bootstrap" in snapshot).toBe(false);
      expect(snapshot.title).toBe("Patch review: stdin patch");
      expect(snapshot.fileCount).toBe(1);

      const bootstrap = renderBootstrap(session);
      expect(bootstrap.initialMode).toBe("stack");
      expect(bootstrap.initialShowLineNumbers).toBe(false);
      expect(bootstrap.initialTheme).toBe("paper");

      session.dispose();
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("open reuses the loaded review when source identity has not changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-open-same-source-"));
    const left = join(root, "before.ts");
    const right = join(root, "after.ts");

    try {
      writeFileSync(left, "export const value = 1;\n");
      writeFileSync(right, "export const value = 2;\nexport const first = true;\n");

      const source = { kind: "diff", left, right } as const;
      const session = await createEmbeddedHunkSession({ cwd: root, source });
      expect(loadedPatch(session)).toContain("first");

      writeFileSync(right, "export const value = 2;\nexport const second = true;\n");
      await session.open(source);

      expect(loadedPatch(session)).toContain("first");
      expect(loadedPatch(session)).not.toContain("second");

      await session.reload();

      expect(loadedPatch(session)).toContain("second");
      expect(loadedPatch(session)).not.toContain("first");

      session.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("keeps the previous source and reports errors when open fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-reload-error-"));

    try {
      const initialSource = { kind: "patch", text: patchText, label: "initial patch" } as const;
      const session = await createEmbeddedHunkSession({
        cwd: root,
        source: initialSource,
      });

      await expect(session.open({ kind: "patch", file: "missing.patch" })).rejects.toThrow();

      expect(session.source).toMatchObject(initialSource);
      const snapshot = session.getSnapshot();
      expect(snapshot.status).toBe("error");
      if (snapshot.status !== "error") throw new Error("Expected embedded reload to fail.");
      expect(snapshot.error).toContain("missing.patch");
      expect(snapshot.title).toBe("Patch review: initial patch");
      expect("bootstrap" in snapshot).toBe(false);

      session.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("scopes embedded key input to the active mount", () => {
    const sourceListeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const source = {
      on(event: string, listener: (...args: unknown[]) => void) {
        const listeners = sourceListeners.get(event) ?? new Set();
        listeners.add(listener);
        sourceListeners.set(event, listeners);
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        sourceListeners.get(event)?.delete(listener);
      },
    };
    let active = false;
    const scoped = createScopedKeyInput(source, () => active);
    const received: unknown[] = [];

    scoped.keyInput.on("keypress", (event: unknown) => {
      received.push(event);
    });

    sourceListeners.get("keypress")?.forEach((listener) => listener("hidden"));
    active = true;
    sourceListeners.get("keypress")?.forEach((listener) => listener("visible"));

    expect(received).toEqual(["visible"]);

    scoped.dispose();
    expect(sourceListeners.get("keypress")?.size).toBe(0);
  });
});

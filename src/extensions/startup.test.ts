import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionsConfig } from "../core/types";
import { createExtensionLoadNotices, loadStartupExtensions, mergeStartupNotices } from "./startup";
import { createEmptyExtensionLoadResult } from "./types";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createExtensionsConfig(overrides: Partial<ExtensionsConfig> = {}): ExtensionsConfig {
  return { enabled: true, paths: [], repoPaths: [], extensionConfigs: {}, ...overrides };
}

/** Write one extension entry into an XDG-shaped global extensions directory. */
function writeGlobalExtension(home: string, fileName: string, source: string) {
  const dir = join(home, "hunk", "extensions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, source);
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("extension startup", () => {
  test("returns an empty registry without touching disk when disabled", async () => {
    const home = createTempDir("hunk-startup-disabled-");
    writeGlobalExtension(home, "boom.ts", "throw new Error('should never run');\n");

    const result = await loadStartupExtensions({
      extensions: createExtensionsConfig({ enabled: false }),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });

    const empty = createEmptyExtensionLoadResult(home);
    expect(result.registry).toEqual(empty.registry);
    expect(result.loaded).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.context.cwd).toBe(home);
    expect(result.pendingTrustRepoRoot).toBeUndefined();
  });

  test("discovers and loads global extensions with their config tables", async () => {
    const home = createTempDir("hunk-startup-global-");
    writeGlobalExtension(
      home,
      "themed.ts",
      `export default function (hunk: { registerTheme: (t: { id: string }) => void; config: Record<string, unknown> }) {
  hunk.registerTheme({ id: String(hunk.config.themeId ?? "fallback") });
}
`,
    );

    const result = await loadStartupExtensions({
      extensions: createExtensionsConfig({
        extensionConfigs: { themed: { themeId: "midnight" } },
      }),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
      hostOverrides: { repoRoot: undefined },
    });

    expect(result.issues).toEqual([]);
    expect(result.loaded.map((entry) => entry.origin)).toEqual(["global"]);
    expect(result.registry.themes.map((entry) => entry.theme.id)).toEqual(["midnight"]);
  });

  test("maps load failures onto startup notices without dropping config notices", () => {
    const configNotice = { key: "deprecated:custom-theme-syntax", message: "legacy syntax" };
    const failing = {
      ...createEmptyExtensionLoadResult(),
      issues: [
        {
          extensionId: "broken",
          path: join("ext", "broken.ts"),
          origin: "global" as const,
          message: "boom\nstack line",
        },
      ],
    };

    expect(createExtensionLoadNotices(failing.issues)).toEqual([
      {
        key: `extension:${join("ext", "broken.ts")}`,
        message: "Extension broken failed to load • boom",
      },
    ]);
    expect(mergeStartupNotices([configNotice], failing)).toHaveLength(2);
  });

  test("keeps the original notice identity when nothing failed to load", () => {
    const notices = [{ key: "deprecated:custom-theme-syntax", message: "legacy syntax" }];

    expect(mergeStartupNotices(notices, createEmptyExtensionLoadResult())).toBe(notices);
    expect(mergeStartupNotices(undefined, createEmptyExtensionLoadResult())).toBeUndefined();
  });
});

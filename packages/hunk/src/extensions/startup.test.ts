import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionsConfig } from "../core/run/config";
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

  test("extends a provisional pass without executing its unchanged factories again", async () => {
    const root = createTempDir("hunk-startup-extend-");
    const configHome = join(root, "config");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const logPath = join(root, "factories.log");
    writeGlobalExtension(
      configHome,
      "global.ts",
      `import { appendFileSync } from "node:fs";
export default function (hunk) {
  appendFileSync(${JSON.stringify(logPath)}, "global\\n");
  hunk.events.emit("global:ready", {});
}
`,
    );

    const provisional = await loadStartupExtensions({
      extensions: createExtensionsConfig(),
      cwd: repo,
      env: { XDG_CONFIG_HOME: configHome } as NodeJS.ProcessEnv,
      deferEventBusBinding: true,
    });
    const repoExtensions = join(repo, ".hunk", "extensions");
    mkdirSync(repoExtensions, { recursive: true });
    writeFileSync(
      join(repoExtensions, "local.ts"),
      `import { appendFileSync } from "node:fs";
export default function (hunk) {
  appendFileSync(${JSON.stringify(logPath)}, "local\\n");
  hunk.events.on("global:ready", () => appendFileSync(${JSON.stringify(logPath)}, "event\\n"));
}
`,
    );

    const final = await loadStartupExtensions({
      extensions: createExtensionsConfig(),
      cwd: repo,
      env: { XDG_CONFIG_HOME: configHome } as NodeJS.ProcessEnv,
      projectRoot: repo,
      previousLoad: provisional,
      hostOverrides: { resolveRepoTrustImpl: () => "trusted" },
    });

    expect(readFileSync(logPath, "utf8")).toBe("global\nlocal\nevent\n");
    expect(final.loaded.map((extension) => extension.id)).toEqual(["global", "local"]);
  });

  test("shuts down a provisional pass before changed config requires rebuilding it", async () => {
    const home = createTempDir("hunk-startup-rebuild-");
    const logPath = join(home, "lifecycle.log");
    writeGlobalExtension(
      home,
      "configured.ts",
      `import { appendFileSync } from "node:fs";
export default function (hunk) {
  appendFileSync(${JSON.stringify(logPath)}, "factory:" + hunk.config.value + "\\n");
  hunk.on("shutdown", () => appendFileSync(${JSON.stringify(logPath)}, "shutdown\\n"));
}
`,
    );

    const provisional = await loadStartupExtensions({
      extensions: createExtensionsConfig({ extensionConfigs: { configured: { value: 1 } } }),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });
    await loadStartupExtensions({
      extensions: createExtensionsConfig({ extensionConfigs: { configured: { value: 2 } } }),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
      previousLoad: provisional,
    });

    expect(readFileSync(logPath, "utf8")).toBe("factory:1\nshutdown\nfactory:2\n");
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

  test("strips terminal control sequences out of failure notices", () => {
    // Import errors quote repo-controlled paths, which reach the status bar raw
    // unless the notice sanitizes them.
    const issues = [
      {
        extensionId: "broken",
        path: join("ext", "broken.ts"),
        origin: "repo" as const,
        message: "Cannot find module '\x1b[2J\x1b]0;pwned\x07./evil.ts'",
      },
    ];

    expect(createExtensionLoadNotices(issues)[0]?.message).toBe(
      "Extension broken failed to load • Cannot find module './evil.ts'",
    );
  });

  test("keeps the original notice identity when nothing failed to load", () => {
    const notices = [{ key: "deprecated:custom-theme-syntax", message: "legacy syntax" }];

    expect(mergeStartupNotices(notices, createEmptyExtensionLoadResult())).toBe(notices);
    expect(mergeStartupNotices(undefined, createEmptyExtensionLoadResult())).toBeUndefined();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionsConfig } from "../core/run/config";
import { resolveExtensionCliCommands } from "./cliCommands";
import {
  createExtensionLoadNotices,
  createSupersededExtensionNotices,
  loadStartupExtensions,
  mergeStartupNotices,
} from "./startup";
import { createEmptyExtensionLoadResult, createEmptyExtensionRegistry } from "./types";

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
  test("loads bundled core extensions without touching user extension files when disabled", async () => {
    const home = createTempDir("hunk-startup-disabled-");
    writeGlobalExtension(home, "boom.ts", "throw new Error('should never run');\n");

    const result = await loadStartupExtensions({
      extensions: createExtensionsConfig({ enabled: false }),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });

    expect(result.registry.cliCommands.map((entry) => entry.command.name)).toEqual(["gh"]);
    expect(result.loaded).toEqual([
      { id: "hunk", sourcePath: "hunk:bundled/gh", origin: "bundled" },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.context.cwd).toBe(home);
    expect(result.pendingTrustRepoRoot).toBeUndefined();
  });

  test("does not run a config-disabled bundled factory and permits a CLI enable", async () => {
    const home = createTempDir("hunk-startup-bundled-selection-");
    const disabled = await loadStartupExtensions({
      extensions: createExtensionsConfig({
        userDisabled: ["hunk.gh"],
        disabled: ["hunk.gh"],
      }),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });

    expect(disabled.registry.cliCommands).toEqual([]);
    expect(disabled.loaded).toEqual([]);

    const enabled = await loadStartupExtensions({
      extensions: createExtensionsConfig({
        userDisabled: ["hunk.gh"],
        disabled: ["hunk.gh"],
      }),
      cliSelectionOverrides: [{ id: "hunk.gh", enabled: true }],
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });
    expect(enabled.registry.cliCommands.map((entry) => entry.command.name)).toEqual(["gh"]);
  });

  test("filters disabled user candidates before importing them", async () => {
    const home = createTempDir("hunk-startup-user-selection-");
    writeGlobalExtension(home, "boom.ts", "throw new Error('should never run');\n");

    const result = await loadStartupExtensions({
      extensions: createExtensionsConfig({
        userDisabled: ["boom"],
        disabled: ["boom"],
      }),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });

    expect(result.issues).toEqual([]);
    expect(result.loaded.map((entry) => entry.origin)).toEqual(["bundled"]);
  });

  test("does not prompt for trust when every repository candidate is disabled", async () => {
    const repo = createTempDir("hunk-startup-repo-selection-");
    const extensionDir = join(repo, ".hunk", "extensions");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "local.ts"), "throw new Error('should never run');\n");
    let trustChecks = 0;

    const result = await loadStartupExtensions({
      extensions: createExtensionsConfig({
        repoDisabled: ["local"],
        disabled: ["local"],
      }),
      cwd: repo,
      projectRoot: repo,
      hostOverrides: {
        repoRoot: repo,
        resolveRepoTrustImpl: () => {
          trustChecks += 1;
          return "trusted";
        },
      },
    });

    expect(trustChecks).toBe(0);
    expect(result.pendingTrustRepoRoot).toBeUndefined();
    expect(result.issues).toEqual([]);
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
    expect(result.loaded.map((entry) => entry.origin)).toEqual(["bundled", "global"]);
    expect(result.registry.themes.map((entry) => entry.theme.id)).toEqual(["midnight"]);
  });

  test("keeps bundled CLI command ownership ahead of a user extension collision", async () => {
    const home = createTempDir("hunk-startup-gh-collision-");
    writeGlobalExtension(
      home,
      "hunk-gh.ts",
      `export default function (hunk) {
  hunk.registerCliCommand({ name: "gh", summary: "replacement" }, () => ({ kind: "exit" }));
}
`,
    );

    const result = await loadStartupExtensions({
      extensions: createExtensionsConfig(),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });
    const commands = resolveExtensionCliCommands(result.registry);

    expect(commands.commands.get("gh")?.extensionId).toBe("hunk");
    expect(commands.collisions).toEqual([
      { name: "gh", winnerExtensionId: "hunk", rejectedExtensionId: "hunk-gh" },
    ]);
    expect(createSupersededExtensionNotices(result)).toEqual([
      {
        key: "extension-superseded:hunk-gh",
        message: "`hunk gh` GitHub review commands are built in • hunk extension remove hunk-gh",
      },
    ]);
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
    expect(final.loaded.map((extension) => extension.id)).toEqual(["hunk", "global", "local"]);
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

  test("rebuilds and retires a staged registry when selection changes", async () => {
    const home = createTempDir("hunk-startup-selection-rebuild-");
    const logPath = join(home, "selection.log");
    writeGlobalExtension(
      home,
      "selected.ts",
      `import { appendFileSync } from "node:fs";
export default function (hunk) {
  appendFileSync(${JSON.stringify(logPath)}, "factory\\n");
  hunk.on("shutdown", () => appendFileSync(${JSON.stringify(logPath)}, "shutdown\\n"));
}
`,
    );

    const provisional = await loadStartupExtensions({
      extensions: createExtensionsConfig(),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });
    const rebuilt = await loadStartupExtensions({
      extensions: createExtensionsConfig({
        userDisabled: ["selected"],
        disabled: ["selected"],
      }),
      cwd: home,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
      previousLoad: provisional,
    });

    expect(readFileSync(logPath, "utf8")).toBe("factory\nshutdown\n");
    expect(rebuilt.loaded.map((entry) => entry.origin)).toEqual(["bundled"]);
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

  test("notices a still-installed extension whose feature Hunk now bundles", () => {
    const registry = createEmptyExtensionRegistry();
    registry.extensions.push(
      { id: "hunk-less-search", sourcePath: "/home/.config/hunk/extensions/x", origin: "global" },
      { id: "acme", sourcePath: "/repo/acme.ts", origin: "repo" },
    );
    const loaded = { ...createEmptyExtensionLoadResult(), registry };

    expect(createSupersededExtensionNotices(loaded)).toEqual([
      {
        key: "extension-superseded:hunk-less-search",
        message: "`/` content search is built in • hunk extension remove hunk-less-search",
      },
    ]);
    expect(mergeStartupNotices(undefined, loaded)).toHaveLength(1);
  });

  test("keeps the original notice identity when nothing failed to load", () => {
    const notices = [{ key: "deprecated:custom-theme-syntax", message: "legacy syntax" }];

    expect(mergeStartupNotices(notices, createEmptyExtensionLoadResult())).toBe(notices);
    expect(mergeStartupNotices(undefined, createEmptyExtensionLoadResult())).toBeUndefined();
  });
});

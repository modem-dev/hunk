import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExtensions } from "./discovery";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Write one extension entry file, creating parent directories as needed. */
function writeExtensionFile(...segments: string[]) {
  const path = join(...segments);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "export default () => {};\n");
  return path;
}

/** Create a repo root discovery can find without shelling out to a VCS. */
function createRepo(prefix: string) {
  const repo = createTempDir(prefix);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("extension discovery", () => {
  test("scans entry files and one level of folder extensions in the global dir", () => {
    const globalDir = createTempDir("hunk-ext-global-");
    const single = writeExtensionFile(globalDir, "beta.ts");
    const mjs = writeExtensionFile(globalDir, "alpha.mjs");
    const folderIndex = writeExtensionFile(globalDir, "gamma", "index.js");
    // Helper modules beside a folder entry are not entry points themselves.
    writeExtensionFile(globalDir, "gamma", "helper.ts");
    // Nesting deeper than one level is out of scope.
    writeExtensionFile(globalDir, "delta", "nested", "index.ts");
    writeExtensionFile(globalDir, "notes.md");

    const candidates = discoverExtensions({
      cwd: globalDir,
      globalExtensionsDir: globalDir,
      repoRoot: undefined,
      env: {},
    });

    expect(candidates.map((candidate) => candidate.path)).toEqual([mjs, single, folderIndex]);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(candidates.every((candidate) => candidate.origin === "global")).toBe(true);
  });

  test("orders flag, user config, global, then repo-local sources", () => {
    const repo = createRepo("hunk-ext-repo-");
    const globalDir = join(repo, "global-extensions");
    const flagPath = writeExtensionFile(repo, "dev", "flagged.ts");
    const configPath = writeExtensionFile(repo, "shared", "from-config.ts");
    const globalPath = writeExtensionFile(globalDir, "installed.ts");
    const repoPath = writeExtensionFile(repo, ".hunk", "extensions", "repo-local.ts");

    const candidates = discoverExtensions({
      cwd: repo,
      repoRoot: repo,
      globalExtensionsDir: globalDir,
      flagPaths: [flagPath],
      configPaths: [configPath],
      env: {},
    });

    expect(candidates).toEqual([
      { id: "flagged", path: flagPath, origin: "flag" },
      { id: "from-config", path: configPath, origin: "config" },
      { id: "installed", path: globalPath, origin: "global" },
      { id: "repo-local", path: repoPath, origin: "repo" },
    ]);
  });

  test("treats repo config paths as repo-local regardless of where they point", () => {
    const repo = createRepo("hunk-ext-repo-config-");
    const repoConfigPath = writeExtensionFile(repo, "tools", "policy.ts");

    const candidates = discoverExtensions({
      cwd: repo,
      repoRoot: repo,
      globalExtensionsDir: undefined,
      repoConfigPaths: ["tools/policy.ts"],
      env: {},
    });

    expect(candidates).toEqual([{ id: "policy", path: repoConfigPath, origin: "repo" }]);
  });

  test("expands explicit directory paths and keeps explicit file paths", () => {
    const root = createTempDir("hunk-ext-explicit-");
    const dirEntry = writeExtensionFile(root, "pack", "one.ts");
    const fileEntry = writeExtensionFile(root, "solo.ts");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [join(root, "pack"), "solo.ts"],
      env: {},
    });

    expect(candidates.map((candidate) => candidate.path)).toEqual([dirEntry, fileEntry]);
  });

  test("keeps a missing explicit path so the host can report it", () => {
    const root = createTempDir("hunk-ext-missing-");
    const missing = join(root, "absent.ts");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [missing],
      env: {},
    });

    expect(candidates).toEqual([{ id: "absent", path: missing, origin: "flag" }]);
  });

  test("dedupes one path across groups and keeps the first origin", () => {
    const repo = createRepo("hunk-ext-dedupe-");
    const repoPath = writeExtensionFile(repo, ".hunk", "extensions", "shared.ts");

    const candidates = discoverExtensions({
      cwd: repo,
      repoRoot: repo,
      globalExtensionsDir: undefined,
      flagPaths: [repoPath],
      env: {},
    });

    expect(candidates).toEqual([{ id: "shared", path: repoPath, origin: "flag" }]);
  });

  test("falls back to the XDG global extensions directory", () => {
    const home = createTempDir("hunk-ext-xdg-");
    const globalPath = writeExtensionFile(home, "hunk", "extensions", "themed.ts");

    const candidates = discoverExtensions({
      cwd: home,
      repoRoot: undefined,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });

    expect(candidates).toEqual([{ id: "themed", path: globalPath, origin: "global" }]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverExtensions } from "./discovery";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Compare the historical entry fields when package identity is asserted separately. */
function withoutPackageIdentity(candidates: ReturnType<typeof discoverExtensions>) {
  return candidates.map(({ package: _package, ...candidate }) => candidate);
}

/** Write one extension entry file, creating parent directories as needed. */
function writeExtensionFile(...segments: string[]) {
  const path = join(...segments);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "export default () => {};\n");
  return path;
}

/** Write one folder extension's `package.json`, creating the folder as needed. */
function writeExtensionManifest(dir: string, contents: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), contents);
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

  test("discovers .tsx and .jsx entries everywhere .ts entries are discovered", () => {
    // The runtime transpiler has always accepted TSX; discovery used to be the
    // only gap, forcing a manifest just to name an `index.tsx`.
    const globalDir = createTempDir("hunk-ext-tsx-");
    const standaloneTsx = writeExtensionFile(globalDir, "alpha.tsx");
    const standaloneJsx = writeExtensionFile(globalDir, "beta.jsx");
    const folderTsxIndex = writeExtensionFile(globalDir, "gamma", "index.tsx");

    const candidates = discoverExtensions({
      cwd: globalDir,
      globalExtensionsDir: globalDir,
      repoRoot: undefined,
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "alpha", path: standaloneTsx, origin: "global" },
      { id: "beta", path: standaloneJsx, origin: "global" },
      { id: "gamma", path: folderTsxIndex, origin: "global" },
    ]);
  });

  test("prefers index.ts over index.tsx for a folder shipping both", () => {
    const root = createTempDir("hunk-ext-tsx-index-order-");
    const typescriptIndex = writeExtensionFile(root, "dual", "index.ts");
    writeExtensionFile(root, "dual", "index.tsx");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [join(root, "dual")],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "dual", path: typescriptIndex, origin: "flag" },
    ]);
  });

  test("bootstraps repo-local extensions from .hunk without a bundled VCS marker", () => {
    const repo = createTempDir("hunk-ext-provider-neutral-repo-");
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const repoPath = writeExtensionFile(repo, ".hunk", "extensions", "custom-vcs.ts");

    const candidates = discoverExtensions({
      cwd: nested,
      globalExtensionsDir: undefined,
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "custom-vcs", path: repoPath, origin: "repo" },
    ]);
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

    expect(withoutPackageIdentity(candidates)).toEqual([
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

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "policy", path: repoConfigPath, origin: "repo" },
    ]);
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

  test("loads an explicit folder-extension path as one extension, not as a container", () => {
    const root = createTempDir("hunk-ext-folder-");
    const folderIndex = writeExtensionFile(root, "my-ext", "index.ts");
    // A helper beside the index is part of that extension, not an entry of its own.
    writeExtensionFile(root, "my-ext", "helper.ts");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      configPaths: ["my-ext"],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "my-ext", path: folderIndex, origin: "config" },
    ]);
  });

  test("prefers index.ts over index.js for an explicit folder-extension path", () => {
    const root = createTempDir("hunk-ext-folder-index-");
    const typescriptIndex = writeExtensionFile(root, "dual", "index.ts");
    writeExtensionFile(root, "dual", "index.js");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [join(root, "dual")],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "dual", path: typescriptIndex, origin: "flag" },
    ]);
  });

  test("scans an explicit directory without an index as a container of extensions", () => {
    const root = createTempDir("hunk-ext-container-");
    const first = writeExtensionFile(root, "pack", "alpha.ts");
    const second = writeExtensionFile(root, "pack", "beta.ts");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [join(root, "pack")],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "alpha", path: first, origin: "flag" },
      { id: "beta", path: second, origin: "flag" },
    ]);
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

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "absent", path: missing, origin: "flag" },
    ]);
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

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "shared", path: repoPath, origin: "flag" },
    ]);
  });

  test("falls back to the XDG global extensions directory", () => {
    const home = createTempDir("hunk-ext-xdg-");
    const globalPath = writeExtensionFile(home, "hunk", "extensions", "themed.ts");

    const candidates = discoverExtensions({
      cwd: home,
      repoRoot: undefined,
      env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv,
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "themed", path: globalPath, origin: "global" },
    ]);
  });
});

describe("folder extension manifests", () => {
  test("prefers a package.json manifest over the index fallback when scanning", () => {
    const globalDir = createTempDir("hunk-ext-manifest-scan-");
    const folder = join(globalDir, "manifest-ext");
    const entry = writeExtensionFile(folder, "src", "main.ts");
    writeExtensionManifest(folder, `{"hunk": {"extensions": ["./src/main.ts"]}}`);
    // The index is only reached when no manifest declares entries.
    writeExtensionFile(folder, "index.ts");

    const candidates = discoverExtensions({
      cwd: globalDir,
      repoRoot: undefined,
      globalExtensionsDir: globalDir,
      env: {},
    });

    // A single declared entry still answers to the folder's name, so
    // `[extension.manifest-ext]` keeps working.
    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "manifest-ext", path: entry, origin: "global" },
    ]);
  });

  test("resolves a manifest for an explicit folder path", () => {
    const root = createTempDir("hunk-ext-manifest-explicit-");
    const folder = join(root, "manifest-ext");
    const entry = writeExtensionFile(folder, "src", "main.ts");
    writeExtensionManifest(folder, `{"hunk": {"extensions": ["./src/main.ts"]}}`);

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      configPaths: ["manifest-ext"],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "manifest-ext", path: entry, origin: "config" },
    ]);
  });

  test("attributes a direct declared entry to its owning package before activation", () => {
    const root = createTempDir("hunk-ext-direct-owner-");
    const folder = join(root, "checkout-name");
    const entry = writeExtensionFile(folder, "src", "main.ts");
    writeExtensionManifest(
      folder,
      JSON.stringify({ hunk: { packageId: "owned-package", extensions: ["./src/main.ts"] } }),
    );

    expect(
      discoverExtensions({
        cwd: root,
        repoRoot: undefined,
        globalExtensionsDir: undefined,
        flagPaths: [entry],
        disabledPackageIds: new Set(["owned-package"]),
        env: {},
      }),
    ).toEqual([]);

    const enabled = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      configPaths: [entry],
      env: {},
    });
    expect(enabled[0]?.package).toEqual({ id: "owned-package", root: folder });
  });

  test("does not borrow an ancestor identity past a nearer manifest", () => {
    const root = createTempDir("hunk-ext-nearest-owner-");
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    const entry = writeExtensionFile(inner, "main.ts");
    writeExtensionFile(outer, "outer.ts");
    writeExtensionManifest(
      outer,
      JSON.stringify({ hunk: { packageId: "outer-package", extensions: ["./outer.ts"] } }),
    );
    writeExtensionFile(inner, "declared.ts");
    writeExtensionManifest(
      inner,
      JSON.stringify({ hunk: { packageId: "inner-package", extensions: ["./declared.ts"] } }),
    );

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [entry],
      env: {},
    });
    expect(candidates[0]?.package).toEqual({ id: "main", root: inner });
  });

  test.skipIf(process.platform === "win32")(
    "canonicalizes a symlinked direct entry to its manifest package denial",
    () => {
      const root = createTempDir("hunk-ext-symlink-owner-");
      const folder = join(root, "owned");
      const entry = writeExtensionFile(folder, "main.ts");
      writeExtensionManifest(
        folder,
        JSON.stringify({ hunk: { packageId: "owned-package", extensions: ["./main.ts"] } }),
      );
      const alias = join(root, "alias.ts");
      symlinkSync(entry, alias);

      const enabled = discoverExtensions({
        cwd: root,
        repoRoot: undefined,
        globalExtensionsDir: undefined,
        flagPaths: [alias],
        env: {},
      });
      expect(enabled[0]?.path).toBe(realpathSync(entry));
      expect(enabled[0]?.package?.id).toBe("owned-package");
      expect(
        discoverExtensions({
          cwd: root,
          repoRoot: undefined,
          globalExtensionsDir: undefined,
          flagPaths: [alias],
          disabledPackageIds: new Set(["owned-package"]),
          env: {},
        }),
      ).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps a manifest-declared external symlink under the same package denial",
    () => {
      const root = createTempDir("hunk-ext-external-symlink-owner-");
      const folder = join(root, "owned");
      const externalEntry = writeExtensionFile(root, "external", "main.ts");
      mkdirSync(folder, { recursive: true });
      const declaredSymlink = join(folder, "linked.ts");
      symlinkSync(externalEntry, declaredSymlink);
      writeExtensionManifest(
        folder,
        JSON.stringify({
          hunk: { packageId: "owned-package", extensions: ["./linked.ts"] },
        }),
      );

      const direct = discoverExtensions({
        cwd: root,
        repoRoot: undefined,
        globalExtensionsDir: undefined,
        flagPaths: [declaredSymlink],
        env: {},
      });
      const folderDiscovery = discoverExtensions({
        cwd: root,
        repoRoot: undefined,
        globalExtensionsDir: undefined,
        flagPaths: [folder],
        env: {},
      });
      expect(direct).toHaveLength(1);
      expect(direct[0]?.path).toBe(realpathSync(externalEntry));
      expect(direct[0]?.package).toEqual({
        id: "owned-package",
        root: realpathSync(folder),
      });
      expect(folderDiscovery).toEqual(direct);

      const deniedOptions = {
        cwd: root,
        repoRoot: undefined,
        globalExtensionsDir: undefined,
        disabledPackageIds: new Set(["owned-package"]),
        env: {},
      };
      expect(discoverExtensions({ ...deniedOptions, flagPaths: [declaredSymlink] })).toEqual([]);
      expect(discoverExtensions({ ...deniedOptions, flagPaths: [folder] })).toEqual([]);
    },
  );

  test("canonicalizes uppercase and invalid fallback package identities", () => {
    const root = createTempDir("hunk-ext-fallback-identity-");
    const upper = join(root, "Upper_Ext");
    const invalid = join(root, "invalid folder!");
    writeExtensionFile(upper, "index.ts");
    writeExtensionFile(invalid, "index.ts");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [upper, invalid],
      env: {},
    });
    expect(candidates.map((candidate) => candidate.package?.id).sort()).toEqual([
      "invalid-folder-",
      "upper_ext",
    ]);
  });

  test("rejects one package id claimed by distinct roots", () => {
    const root = createTempDir("hunk-ext-package-collision-");
    const first = join(root, "first");
    const second = join(root, "second");
    writeExtensionFile(first, "index.ts");
    writeExtensionFile(second, "index.ts");
    writeExtensionManifest(first, JSON.stringify({ hunk: { packageId: "shared" } }));
    writeExtensionManifest(second, JSON.stringify({ hunk: { packageId: "shared" } }));

    expect(
      discoverExtensions({
        cwd: root,
        repoRoot: undefined,
        globalExtensionsDir: undefined,
        flagPaths: [first, second],
        env: {},
      }),
    ).toEqual([]);
  });

  test("keeps manifest order and per-file ids when a manifest declares several entries", () => {
    const root = createTempDir("hunk-ext-manifest-multi-");
    const folder = join(root, "multi-ext");
    const alpha = writeExtensionFile(folder, "alpha.ts");
    const beta = writeExtensionFile(folder, "beta.ts");
    // Declared out of alphabetical order on purpose: a folder's entries sort as
    // one unit at the folder's position and keep the order the manifest gave.
    writeExtensionManifest(folder, `{"hunk": {"extensions": ["./beta.ts", "./alpha.ts"]}}`);

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "beta", path: beta, origin: "flag" },
      { id: "alpha", path: alpha, origin: "flag" },
    ]);
    expect(candidates.map((candidate) => candidate.package)).toEqual([
      { id: "multi-ext", root: folder },
      { id: "multi-ext", root: folder },
    ]);
  });

  test("uses explicit manifest package identity and filters all entries before precedence", () => {
    const root = createTempDir("hunk-ext-package-identity-");
    const folder = join(root, "checkout-name");
    writeExtensionFile(folder, "alpha.ts");
    writeExtensionFile(folder, "beta.ts");
    writeExtensionManifest(
      folder,
      JSON.stringify({
        name: "@acme/review-tools",
        version: "2.3.0",
        hunk: { packageId: "acme-review", extensions: ["./alpha.ts", "./beta.ts"] },
      }),
    );

    const enabled = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });
    expect(enabled.map((candidate) => candidate.package)).toEqual([
      { id: "acme-review", name: "@acme/review-tools", version: "2.3.0", root: folder },
      { id: "acme-review", name: "@acme/review-tools", version: "2.3.0", root: folder },
    ]);
    expect(
      discoverExtensions({
        cwd: root,
        repoRoot: undefined,
        globalExtensionsDir: undefined,
        flagPaths: [folder],
        disabledPackageIds: new Set(["acme-review"]),
        env: {},
      }),
    ).toEqual([]);
  });

  test("disambiguates duplicate ids within a multi-entry manifest", () => {
    const root = createTempDir("hunk-ext-manifest-duplicate-ids-");
    const folder = join(root, "multi-ext");
    const typescriptEntry = writeExtensionFile(folder, "alpha.ts");
    const javascriptEntry = writeExtensionFile(folder, "alpha.js");
    const reservedSuffixEntry = writeExtensionFile(folder, "alpha-2.ts");
    writeExtensionManifest(
      folder,
      `{"hunk": {"extensions": ["./alpha.ts", "./alpha.js", "./alpha-2.ts"]}}`,
    );

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "alpha", path: typescriptEntry, origin: "flag" },
      { id: "alpha-3", path: javascriptEntry, origin: "flag" },
      { id: "alpha-2", path: reservedSuffixEntry, origin: "flag" },
    ]);
  });

  test("falls back to the index entry when package.json is malformed", () => {
    const root = createTempDir("hunk-ext-manifest-broken-");
    const folder = join(root, "broken-manifest");
    const index = writeExtensionFile(folder, "index.ts");
    writeExtensionManifest(folder, `{ not json`);

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "broken-manifest", path: index, origin: "flag" },
    ]);
  });

  test("falls back to the index entry for a package.json without a hunk field", () => {
    const root = createTempDir("hunk-ext-manifest-plain-");
    const folder = join(root, "plain-package");
    const index = writeExtensionFile(folder, "index.ts");
    writeExtensionManifest(folder, `{"name": "x", "dependencies": {}}`);

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "plain-package", path: index, origin: "flag" },
    ]);
  });

  test("keeps a manifest entry pointing at a missing file so the host can report it", () => {
    const root = createTempDir("hunk-ext-manifest-missing-");
    const folder = join(root, "missing-entry");
    writeExtensionManifest(folder, `{"hunk": {"extensions": ["./src/main.ts"]}}`);

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "missing-entry", path: join(folder, "src", "main.ts"), origin: "flag" },
    ]);
  });
});

describe("tilde paths", () => {
  test("expands a leading ~/ in a config path to the user's home directory", () => {
    // `[extensions] paths` is hand-written TOML with no shell to expand it, and
    // the guide documents `~/dev/...`, so discovery has to do the expansion
    // itself. Before this, `~` resolved relative to cwd and never matched.
    const candidates = discoverExtensions({
      cwd: "/somewhere/else",
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      configPaths: ["~/dev/hunk-ext/index.ts"],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "hunk-ext", path: join(homedir(), "dev", "hunk-ext", "index.ts"), origin: "config" },
    ]);
  });

  test("expands a bare ~ to the home directory itself", () => {
    const candidates = discoverExtensions({
      cwd: "/somewhere/else",
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: ["~"],
      env: {},
    });

    // The home directory exists, so it is scanned as a directory rather than
    // taken as a literal entry file; either way it resolved to the real home.
    for (const candidate of candidates) {
      expect(candidate.path.startsWith(homedir())).toBe(true);
    }
  });

  test("expands a backslash-separated ~\\ prefix for Windows-written config", () => {
    const candidates = discoverExtensions({
      cwd: "/somewhere/else",
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      configPaths: ["~\\dev\\ext.ts"],
      env: {},
    });

    expect(candidates[0]?.path.startsWith(homedir())).toBe(true);
  });

  test("leaves ~user alone, since resolving another account's home is a shell feature", () => {
    const candidates = discoverExtensions({
      cwd: "/somewhere/else",
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      configPaths: ["~someone/ext.ts"],
      env: {},
    });

    expect(candidates[0]?.path).toBe(resolve("/somewhere/else", "~someone/ext.ts"));
  });
});

describe("manifest api version requirements", () => {
  test("attaches hunk.apiVersion to every entry the manifest declares", () => {
    const root = createTempDir("hunk-ext-manifest-api-");
    const folder = join(root, "api-ext");
    writeExtensionManifest(
      folder,
      JSON.stringify({ hunk: { extensions: ["./entry.ts"], apiVersion: 9 } }),
    );
    const entry = writeExtensionFile(folder, "entry.ts");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "api-ext", path: entry, origin: "flag", requiresApiVersion: 9 },
    ]);
  });

  test("applies hunk.apiVersion to the index fallback when no entries are declared", () => {
    const root = createTempDir("hunk-ext-manifest-api-index-");
    const folder = join(root, "api-index-ext");
    writeExtensionManifest(folder, JSON.stringify({ hunk: { apiVersion: 2 } }));
    const index = writeExtensionFile(folder, "index.ts");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "api-index-ext", path: index, origin: "flag", requiresApiVersion: 2 },
    ]);
  });

  test("ignores a malformed apiVersion instead of dropping the folder", () => {
    const root = createTempDir("hunk-ext-manifest-api-bad-");
    const folder = join(root, "bad-api-ext");
    writeExtensionManifest(
      folder,
      JSON.stringify({ hunk: { extensions: ["./entry.ts"], apiVersion: "4" } }),
    );
    const entry = writeExtensionFile(folder, "entry.ts");

    const candidates = discoverExtensions({
      cwd: root,
      repoRoot: undefined,
      globalExtensionsDir: undefined,
      flagPaths: [folder],
      env: {},
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "bad-api-ext", path: entry, origin: "flag" },
    ]);
  });
});

describe("managed install root scanning", () => {
  test("skips the installer's dot-prefixed staging and backup directories", () => {
    const globalDir = createTempDir("hunk-ext-installed-dots-");
    const installedRoot = join(globalDir, "installed");
    const real = writeExtensionFile(installedRoot, "real-ext", "index.ts");
    // Installer workspace directories carry full extension layouts but must not load.
    writeExtensionFile(installedRoot, ".staging-real-ext-123", "index.ts");
    writeExtensionFile(installedRoot, ".previous-real-ext", "index.ts");

    const candidates = discoverExtensions({
      cwd: globalDir,
      repoRoot: undefined,
      globalExtensionsDir: globalDir,
    });

    expect(withoutPackageIdentity(candidates)).toEqual([
      { id: "real-ext", path: real, origin: "global" },
    ]);
  });
});

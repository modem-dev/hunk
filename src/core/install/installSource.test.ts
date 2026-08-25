import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detectInstallSource, detectNpmClient, resolveDevInstallDir } from "./installSource";

const HOME_DIR = join("/", "home", "reviewer");

describe("install source detection", () => {
  test("honors an explicitly declared install source", () => {
    expect(
      detectInstallSource({
        env: { HUNK_INSTALL_SOURCE: "nix" },
        executablePath: join("/", "usr", "local", "bin", "hunk"),
        homeDir: HOME_DIR,
      }),
    ).toBe("nix");
  });

  test("accepts dev as a declared install source", () => {
    expect(
      detectInstallSource({
        env: { HUNK_INSTALL_SOURCE: "dev" },
        executablePath: join("/", "opt", "hunk", "bin", "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("dev");
  });

  test("ignores unknown declared install sources", () => {
    expect(
      detectInstallSource({
        env: { HUNK_INSTALL_SOURCE: "chocolatey" },
        executablePath: join("/", "opt", "hunk", "bin", "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("npm");
  });

  test("detects nixpkgs installs from their store path", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: "/nix/store/hash-hunk/bin/hunk",
        homeDir: HOME_DIR,
      }),
    ).toBe("nix");
  });

  test("detects mise installs from their install directory", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: "/home/reviewer/.local/share/mise/installs/aqua-modem-dev-hunk/1.2.3/hunk",
        homeDir: HOME_DIR,
      }),
    ).toBe("mise");
  });

  test("detects Homebrew installs from a resolved Cellar path", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: "/usr/local/bin/hunk",
        realpath: () => "/usr/local/Cellar/hunk/1.2.3/bin/hunk",
        homeDir: HOME_DIR,
      }),
    ).toBe("homebrew");
  });

  test("detects Homebrew installs under the Apple silicon and Linux prefixes", () => {
    for (const executablePath of [
      "/opt/homebrew/bin/hunk",
      "/home/linuxbrew/.linuxbrew/bin/hunk",
    ]) {
      expect(detectInstallSource({ env: {}, executablePath, homeDir: HOME_DIR })).toBe("homebrew");
    }
  });

  test("does not classify a Homebrew-installed Bun running Hunk from source as Homebrew", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: "/opt/homebrew/Cellar/bun/1.1.42/bin/bun",
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("npm");
  });

  test("keeps npm for global npm packages under a Homebrew-installed Node", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: "/opt/homebrew/lib/node_modules/hunkdiff-darwin-arm64/bin/hunk",
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("npm");
  });

  test("detects curl installer installs from the ~/.hunk/bin layout", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: join(HOME_DIR, ".hunk", "bin", "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("curl");
  });

  test("accepts curl as a declared install source", () => {
    expect(
      detectInstallSource({
        env: { HUNK_INSTALL_SOURCE: "curl" },
        executablePath: join("/", "opt", "hunk", "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("curl");
  });

  test("accepts pacman as declared install source", () => {
    expect(
      detectInstallSource({
        env: { HUNK_INSTALL_SOURCE: "pacman" },
        executablePath: join("/", "usr", "lib", "hunkdiff", "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("pacman");
  });

  test("keeps npm for a .hunk segment that is not followed by bin", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: join(HOME_DIR, "projects", ".hunk", "review", "node_modules", "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("npm");
  });

  test("classifies a curl install redirected by HUNK_INSTALL_DIR as a local source build", () => {
    const installDir = join(HOME_DIR, "tools", "bin");
    expect(
      detectInstallSource({
        env: { HUNK_INSTALL_DIR: installDir },
        executablePath: join(installDir, "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("dev");
  });

  test("detects local source builds installed into the default install directory", () => {
    // Built from this platform's own default so the check tracks `scripts/install-bin.ts`.
    const installDir = resolveDevInstallDir({}, HOME_DIR);
    expect(installDir).toBeDefined();
    expect(
      detectInstallSource({
        env: {},
        executablePath: join(installDir!, "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("dev");
  });

  test("detects local source builds inside an overridden install directory", () => {
    const installDir = join(HOME_DIR, "tools", "bin");
    expect(
      detectInstallSource({
        env: { HUNK_INSTALL_DIR: installDir },
        executablePath: join(installDir, "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("dev");
  });

  test("detects local source builds from an untagged version", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: join("/", "opt", "hunk", "bin", "hunk"),
        version: "0.0.0-unknown",
        homeDir: HOME_DIR,
      }),
    ).toBe("dev");
  });

  test("falls back to the npm package path", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: join(HOME_DIR, ".nvm", "versions", "node", "v22", "bin", "hunk"),
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("npm");
  });

  test("keeps npm for paths that only mention mise outside an install directory", () => {
    expect(
      detectInstallSource({
        env: {},
        executablePath: "/home/mise/projects/hunk/node_modules/.bin/hunk",
        version: "1.2.3",
        homeDir: HOME_DIR,
      }),
    ).toBe("npm");
  });

  test("resolves the install:bin target directory from the environment", () => {
    expect(resolveDevInstallDir({ HUNK_INSTALL_DIR: "/srv/bin" }, HOME_DIR)).toBe("/srv/bin");
    expect(resolveDevInstallDir({}, undefined)).toBeUndefined();
  });
});

describe("npm client detection", () => {
  test("picks bun for bun global installs", () => {
    expect(detectNpmClient(join(HOME_DIR, ".bun", "bin", "hunk"))).toBe("bun");
  });

  test("picks pnpm for pnpm global installs", () => {
    expect(detectNpmClient(join(HOME_DIR, ".local", "share", "pnpm", "hunk"))).toBe("pnpm");
  });

  test("picks npm for everything else", () => {
    expect(
      detectNpmClient(join("/", "usr", "lib", "node_modules", "hunkdiff", "bin", "hunk")),
    ).toBe("npm");
  });
});

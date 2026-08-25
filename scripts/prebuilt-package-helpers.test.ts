import { describe, expect, test } from "bun:test";
import {
  PLATFORM_PACKAGE_MATRIX,
  assertOptionalPeerDependencyContract,
  binaryFilenameForSpec,
  buildOptionalDependencyMap,
  buildPlatformPackageManifest,
  getHostPlatformPackageSpec,
  getPlatformPackageSpecByName,
  getPlatformPackageSpecForHost,
  normalizeHostArch,
  normalizeHostPlatform,
  sortPlatformPackageSpecs,
  type PackageDependencyManifest,
  type PlatformPackageSpec,
} from "./prebuilt-package-helpers";

/** Build matching source and staged manifests for optional-peer tests. */
function createOptionalPeerContract(): {
  root: PackageDependencyManifest;
  staged: PackageDependencyManifest;
} {
  return {
    root: {
      devDependencies: { "@pierre/diffs": "1.3.5" },
      peerDependencies: { "@pierre/diffs": "1.3.5" },
      peerDependenciesMeta: { "@pierre/diffs": { optional: true } },
    },
    staged: {
      peerDependencies: { "@pierre/diffs": "1.3.5" },
      peerDependenciesMeta: { "@pierre/diffs": { optional: true } },
    },
  };
}

describe("prebuilt package helpers", () => {
  test("buildOptionalDependencyMap includes every supported platform package at one version", () => {
    const version = "9.9.9";
    const dependencies = buildOptionalDependencyMap(version);

    expect(Object.keys(dependencies).sort()).toEqual(
      PLATFORM_PACKAGE_MATRIX.map((spec) => spec.packageName).sort(),
    );
    expect(new Set(Object.values(dependencies))).toEqual(new Set([version]));
  });

  test("assertOptionalPeerDependencyContract accepts a preserved optional peer", () => {
    const { root, staged } = createOptionalPeerContract();

    expect(() => assertOptionalPeerDependencyContract(root, staged, "@pierre/diffs")).not.toThrow();
  });

  test("assertOptionalPeerDependencyContract rejects dependency contract drift", () => {
    const mutations: Array<
      (root: PackageDependencyManifest, staged: PackageDependencyManifest) => void
    > = [
      (root) => delete root.devDependencies?.["@pierre/diffs"],
      (root) => {
        root.dependencies = { "@pierre/diffs": "1.3.5" };
      },
      (root) => {
        root.peerDependencies = { "@pierre/diffs": "1.3.4" };
      },
      (root) => {
        root.peerDependenciesMeta = { "@pierre/diffs": { optional: false } };
      },
      (_root, staged) => {
        staged.dependencies = { "@pierre/diffs": "1.3.5" };
      },
      (_root, staged) => {
        staged.peerDependencies = { "@pierre/diffs": "1.3.4" };
      },
      (_root, staged) => {
        staged.peerDependenciesMeta = { "@pierre/diffs": { optional: false } };
      },
    ];

    for (const mutate of mutations) {
      const { root, staged } = createOptionalPeerContract();
      mutate(root, staged);

      expect(() => assertOptionalPeerDependencyContract(root, staged, "@pierre/diffs")).toThrow();
    }
  });

  test("binaryFilenameForSpec keeps unix package binaries extensionless", () => {
    for (const spec of PLATFORM_PACKAGE_MATRIX) {
      if (spec.os === "windows") {
        continue;
      }
      expect(binaryFilenameForSpec(spec)).toBe("hunk");
    }
  });

  test("binaryFilenameForSpec adds .exe for windows packages", () => {
    const windowsSpec: PlatformPackageSpec = {
      packageName: "hunkdiff-windows-x64",
      os: "windows",
      cpu: "x64",
      binaryName: "hunk",
      binaryRelativePath: "bin/hunk.exe",
    };

    expect(binaryFilenameForSpec(windowsSpec)).toBe("hunk.exe");
  });

  test("normalizeHostPlatform and normalizeHostArch reject unsupported values", () => {
    expect(normalizeHostPlatform("linux")).toBe("linux");
    expect(normalizeHostPlatform("win32")).toBe("windows");
    expect(normalizeHostPlatform("freebsd" as NodeJS.Platform)).toBeUndefined();

    expect(normalizeHostArch("x64")).toBe("x64");
    expect(normalizeHostArch("arm64")).toBe("arm64");
    expect(normalizeHostArch("ia32" as NodeJS.Architecture)).toBeUndefined();
  });

  test("getPlatformPackageSpecByName returns known package specs", () => {
    expect(getPlatformPackageSpecByName("hunkdiff-linux-x64")?.cpu).toBe("x64");
    expect(getPlatformPackageSpecByName("hunkdiff-darwin-arm64")?.os).toBe("darwin");
    expect(getPlatformPackageSpecByName("hunkdiff-does-not-exist")).toBeUndefined();
  });

  test("getPlatformPackageSpecForHost resolves supported combinations and rejects unsupported ones", () => {
    expect(getPlatformPackageSpecForHost("linux", "x64").packageName).toBe("hunkdiff-linux-x64");
    expect(getPlatformPackageSpecForHost("darwin", "arm64").packageName).toBe(
      "hunkdiff-darwin-arm64",
    );
    expect(() => getPlatformPackageSpecForHost("freebsd" as NodeJS.Platform, "x64")).toThrow(
      "Unsupported host platform for prebuilt packaging: freebsd",
    );
    expect(() => getPlatformPackageSpecForHost("linux", "ia32" as NodeJS.Architecture)).toThrow(
      "Unsupported host architecture for prebuilt packaging: ia32",
    );
    expect(getPlatformPackageSpecForHost("linux", "arm64").packageName).toBe(
      "hunkdiff-linux-arm64",
    );
    expect(getPlatformPackageSpecForHost("win32", "x64").packageName).toBe("hunkdiff-windows-x64");
  });

  test("getHostPlatformPackageSpec resolves the current machine", () => {
    expect(getHostPlatformPackageSpec()).toEqual(
      getPlatformPackageSpecForHost(process.platform, process.arch),
    );
  });

  test("buildPlatformPackageManifest carries provenance metadata and a native bin script", () => {
    const repository = {
      type: "git",
      url: "git+https://github.com/modem-dev/hunk.git",
    };
    const manifest = buildPlatformPackageManifest(
      {
        version: "1.2.3",
        description: "Desktop diff viewer",
        repository,
        homepage: "https://github.com/modem-dev/hunk#readme",
        bugs: { url: "https://github.com/modem-dev/hunk/issues" },
        license: "MIT",
      },
      getPlatformPackageSpecForHost("linux", "x64"),
    );

    expect(manifest.name).toBe("hunkdiff-linux-x64");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.bin).toEqual({ hunk: "bin/hunk" });
    expect(manifest.repository).toEqual(repository);
    expect(manifest.homepage).toBe("https://github.com/modem-dev/hunk#readme");
    expect(manifest.bugs).toEqual({ url: "https://github.com/modem-dev/hunk/issues" });
    expect(manifest.os).toEqual(["linux"]);
    expect(manifest.cpu).toEqual(["x64"]);
  });

  test("buildPlatformPackageManifest maps Windows packages to npm win32", () => {
    const manifest = buildPlatformPackageManifest(
      {
        version: "1.2.3",
        description: "Desktop diff viewer",
        license: "MIT",
      },
      getPlatformPackageSpecForHost("win32", "x64"),
    );

    expect(manifest.name).toBe("hunkdiff-windows-x64");
    expect(manifest.bin).toEqual({ hunk: "bin/hunk.exe" });
    expect(manifest.os).toEqual(["win32"]);
    expect(manifest.cpu).toEqual(["x64"]);
  });

  test("sortPlatformPackageSpecs keeps package publish order stable", () => {
    const reversed = [...PLATFORM_PACKAGE_MATRIX].reverse();
    expect(sortPlatformPackageSpecs(reversed).map((spec) => spec.packageName)).toEqual([
      "hunkdiff-darwin-arm64",
      "hunkdiff-darwin-x64",
      "hunkdiff-linux-arm64",
      "hunkdiff-linux-x64",
      "hunkdiff-windows-x64",
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  PLATFORM_PACKAGE_MATRIX,
  binaryFilenameForSpec,
  buildOptionalDependencyMap,
  getHostPlatformPackageSpec,
  getPlatformPackageSpecByName,
  getPlatformPackageSpecForHost,
  normalizeHostArch,
  normalizeHostPlatform,
  sortPlatformPackageSpecs,
  type PlatformPackageSpec,
} from "../scripts/prebuilt-package-helpers";

describe("prebuilt package helpers", () => {
  test("buildOptionalDependencyMap includes every supported platform package at one version", () => {
    const version = "9.9.9";
    const dependencies = buildOptionalDependencyMap(version);

    expect(Object.keys(dependencies).sort()).toEqual(
      PLATFORM_PACKAGE_MATRIX.map((spec) => spec.packageName).sort(),
    );
    expect(new Set(Object.values(dependencies))).toEqual(new Set([version]));
  });

  test("binaryFilenameForSpec keeps unix package binaries extensionless", () => {
    for (const spec of PLATFORM_PACKAGE_MATRIX) {
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
    expect(() => getPlatformPackageSpecForHost("linux", "arm64")).toThrow(
      "No published prebuilt package spec matches linux/arm64",
    );
  });

  test("getHostPlatformPackageSpec resolves the current machine", () => {
    expect(getHostPlatformPackageSpec()).toEqual(
      getPlatformPackageSpecForHost(process.platform, process.arch),
    );
  });

  test("sortPlatformPackageSpecs keeps package publish order stable", () => {
    const reversed = [...PLATFORM_PACKAGE_MATRIX].reverse();
    expect(sortPlatformPackageSpecs(reversed).map((spec) => spec.packageName)).toEqual([
      "hunkdiff-darwin-arm64",
      "hunkdiff-darwin-x64",
      "hunkdiff-linux-x64",
    ]);
  });
});

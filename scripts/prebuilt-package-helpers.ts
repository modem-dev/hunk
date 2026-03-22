#!/usr/bin/env bun

import os from "node:os";
import path from "node:path";

export type SupportedPlatform = "darwin" | "linux" | "windows";
export type SupportedArch = "x64" | "arm64";

export interface PlatformPackageSpec {
  packageName: string;
  os: SupportedPlatform;
  cpu: SupportedArch;
  binaryName: string;
  binaryRelativePath: string;
}

const PLATFORM_NAME_MAP: Partial<Record<NodeJS.Platform, SupportedPlatform>> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const ARCH_NAME_MAP: Partial<Record<NodeJS.Architecture, SupportedArch>> = {
  x64: "x64",
  arm64: "arm64",
};

/** Platforms we actually plan to publish in the first prebuilt-binary rollout. */
export const PLATFORM_PACKAGE_MATRIX: PlatformPackageSpec[] = [
  {
    packageName: "hunkdiff-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    binaryName: "hunk",
    binaryRelativePath: "bin/hunk",
  },
  {
    packageName: "hunkdiff-darwin-x64",
    os: "darwin",
    cpu: "x64",
    binaryName: "hunk",
    binaryRelativePath: "bin/hunk",
  },
  {
    packageName: "hunkdiff-linux-x64",
    os: "linux",
    cpu: "x64",
    binaryName: "hunk",
    binaryRelativePath: "bin/hunk",
  },
] as const;

/** Normalize a Node platform string into Hunk's package naming vocabulary. */
export function normalizeHostPlatform(platform: NodeJS.Platform) {
  return PLATFORM_NAME_MAP[platform];
}

/** Normalize a Node architecture string into Hunk's package naming vocabulary. */
export function normalizeHostArch(arch: NodeJS.Architecture) {
  return ARCH_NAME_MAP[arch];
}

/** Find one known prebuilt package spec by package name. */
export function getPlatformPackageSpecByName(packageName: string) {
  return PLATFORM_PACKAGE_MATRIX.find((candidate) => candidate.packageName === packageName);
}

/** Resolve the published package spec for a given Node platform/architecture pair. */
export function getPlatformPackageSpecForHost(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
) {
  const normalizedPlatform = normalizeHostPlatform(platform);
  if (!normalizedPlatform) {
    throw new Error(`Unsupported host platform for prebuilt packaging: ${platform}`);
  }

  const normalizedArch = normalizeHostArch(arch);
  if (!normalizedArch) {
    throw new Error(`Unsupported host architecture for prebuilt packaging: ${arch}`);
  }

  const spec = PLATFORM_PACKAGE_MATRIX.find(
    (candidate) => candidate.os === normalizedPlatform && candidate.cpu === normalizedArch,
  );
  if (!spec) {
    throw new Error(
      `No published prebuilt package spec matches ${normalizedPlatform}/${normalizedArch}`,
    );
  }

  return spec;
}

/** Return the Hunk package spec that matches the current machine. */
export function getHostPlatformPackageSpec() {
  return getPlatformPackageSpecForHost(os.platform(), os.arch());
}

/** Build the optional dependency map for the top-level hunkdiff package. */
export function buildOptionalDependencyMap(
  version: string,
  specs: readonly PlatformPackageSpec[] = PLATFORM_PACKAGE_MATRIX,
) {
  return Object.fromEntries(specs.map((spec) => [spec.packageName, version]));
}

/** Return the executable filename for a platform package. */
export function binaryFilenameForSpec(spec: PlatformPackageSpec) {
  return spec.os === "windows" ? `${spec.binaryName}.exe` : spec.binaryName;
}

/** Resolve a path under the generated prebuilt npm release directory. */
export function releaseNpmDir(repoRoot: string) {
  return path.join(repoRoot, "dist", "release", "npm");
}

/** Resolve a path under the generated prebuilt binary artifact directory. */
export function releaseArtifactsDir(repoRoot: string) {
  return path.join(repoRoot, "dist", "release", "artifacts");
}

/** Sort package specs into stable npm publish order. */
export function sortPlatformPackageSpecs(specs: readonly PlatformPackageSpec[]) {
  return [...specs].sort((left, right) => left.packageName.localeCompare(right.packageName));
}

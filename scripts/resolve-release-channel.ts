#!/usr/bin/env bun

export interface ReleaseChannelResolution {
  npmTag: string;
  makeLatest: boolean;
}

interface StableVersion {
  major: number;
  minor: number;
  patch: number;
}

interface ResolveReleaseChannelInput {
  eventName: string;
  refName: string;
  requestedNpmTag?: string;
  currentLatestVersion?: string;
}

/** Parse one stable semantic version, accepting the repository's leading `v` tag form. */
function parseStableVersion(value: string): StableVersion {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Expected a stable semantic version, received ${JSON.stringify(value)}.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Compare two stable semantic versions without relying on an installed semver package. */
function compareStableVersions(left: StableVersion, right: StableVersion) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** Resolve npm and GitHub latest-release policy for one release workflow invocation. */
export function resolveReleaseChannel(input: ResolveReleaseChannelInput): ReleaseChannelResolution {
  if (input.eventName === "workflow_dispatch") {
    const requestedNpmTag = input.requestedNpmTag?.trim();
    if (!requestedNpmTag) {
      throw new Error("Manual release dispatch requires an npm tag.");
    }
    return { npmTag: requestedNpmTag, makeLatest: requestedNpmTag === "latest" };
  }

  if (input.eventName !== "push") {
    throw new Error(`Unsupported release event ${JSON.stringify(input.eventName)}.`);
  }

  if (/-(?:alpha|beta|rc)(?:[.-]|$)/.test(input.refName)) {
    return { npmTag: "beta", makeLatest: false };
  }

  const target = parseStableVersion(input.refName);
  const currentLatest = parseStableVersion(input.currentLatestVersion ?? "");
  const comparison = compareStableVersions(target, currentLatest);
  if (comparison === 0) {
    throw new Error(`Release ${input.refName} is already npm latest.`);
  }
  if (comparison > 0) {
    return { npmTag: "latest", makeLatest: true };
  }

  return {
    npmTag: `backport-${target.major}.${target.minor}`,
    makeLatest: false,
  };
}

/** Parse the release workflow's small CLI surface. */
function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: resolve-release-channel.ts --event <event> --ref <ref> --requested-tag <tag> --current-latest <version>",
      );
    }
    values.set(name, value);
  }

  return {
    eventName: values.get("--event") ?? "",
    refName: values.get("--ref") ?? "",
    requestedNpmTag: values.get("--requested-tag"),
    currentLatestVersion: values.get("--current-latest"),
  };
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(resolveReleaseChannel(parseArgs(Bun.argv.slice(2))))}\n`);
}

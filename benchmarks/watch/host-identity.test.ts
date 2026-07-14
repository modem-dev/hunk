import { describe, expect, test } from "bun:test";
import { assertWatchHostIdentity } from "./host-identity";
import { watchHostIdSchema } from "./schema";

describe("watch host identity", () => {
  test("distinguishes the two named macOS ARM64 hosts", () => {
    expect(() =>
      assertWatchHostIdentity("macos-arm64-aarmstrong", {
        platform: "darwin",
        arch: "arm64",
        hostname: "aarmstrong.local",
      }),
    ).not.toThrow();
    expect(() =>
      assertWatchHostIdentity("macos-arm64-aarmstrong", {
        platform: "darwin",
        arch: "arm64",
        hostname: "curie.local",
      }),
    ).toThrow("physical hostname");
    expect(() =>
      assertWatchHostIdentity("macos-arm64-currie", {
        platform: "darwin",
        arch: "arm64",
        hostname: "curie.local",
      }),
    ).not.toThrow();
  });

  test("requires the ephemeral x64 Windows host to be GitHub Actions", () => {
    expect(() =>
      assertWatchHostIdentity("windows-x64-gha", {
        platform: "win32",
        arch: "x64",
        hostname: "runner",
        env: {},
      }),
    ).toThrow("GitHub Actions");
    expect(() =>
      assertWatchHostIdentity("windows-x64-gha", {
        platform: "win32",
        arch: "x64",
        hostname: "runner",
        env: { GITHUB_ACTIONS: "true", RUNNER_OS: "Windows" },
      }),
    ).not.toThrow();
  });

  test("rejects noncanonical host IDs in runner configuration", () => {
    expect(() => watchHostIdSchema.parse("made-up-host")).toThrow();
  });
});

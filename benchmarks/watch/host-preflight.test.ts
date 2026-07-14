import { describe, expect, test } from "bun:test";
import { WATCH_HOST_PROFILES, assertMacPowerState, dryRunHostPreflight } from "./host-preflight";

describe("watch host preparation profiles", () => {
  test("pins the required remote endpoints, workspaces, and Bun paths", () => {
    expect(WATCH_HOST_PROFILES["macos-arm64-aarmstrong"]).toMatchObject({
      endpoint: "justin@100.65.101.78",
      bunPath: "/Users/justin/.hunk-watch-tools/bun-1.3.14/bin/bun",
      filesystem: "APFS",
    });
    expect(WATCH_HOST_PROFILES["linux-x64-sentry-agent"]).toMatchObject({
      endpoint: "justin@100.125.201.29",
      bunPath: "/home/justin/.bun/bin/bun",
      filesystem: "record-only",
    });
    expect(WATCH_HOST_PROFILES["windows-arm64-hunk-windows"]).toMatchObject({
      endpoint: "hunk@hunk-windows.tail95b37.ts.net",
      workspace: "C:\\DEV\\hunk-watch-campaigns",
      bunPath: "C:\\Users\\hunk\\.bun\\bin\\bun.exe",
      filesystem: "NTFS",
    });
    expect(WATCH_HOST_PROFILES["windows-x64-gha"]).toMatchObject({
      endpoint: null,
      arch: "x64",
      filesystem: "NTFS",
    });
  });

  test("validates the active macOS power mode rather than an inactive profile", () => {
    expect(() =>
      assertMacPowerState("Now drawing from 'AC Power'", "Currently in use:\n powermode 0"),
    ).not.toThrow();
    expect(() =>
      assertMacPowerState("Now drawing from 'AC Power'", "Currently in use:\n powermode 2"),
    ).toThrow("active low-power mode disabled");
  });

  test("dry-run preflight declares that it cannot mutate the host", () => {
    const result = dryRunHostPreflight(WATCH_HOST_PROFILES["linux-x64-sentry-agent"]);
    expect(result).toMatchObject({ mode: "dry-run", mutatesHost: false });
  });
});

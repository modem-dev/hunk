import { describe, expect, test } from "bun:test";
import { HunkUserError } from "../run/errors";
import {
  assertReliableWatchRuntime,
  MINIMUM_RELIABLE_WATCH_BUN_VERSION,
  supportsReliableWatchMode,
} from "./runtime";

describe("watch runtime compatibility", () => {
  test("accepts the fixed Bun release and newer runtimes", () => {
    expect(MINIMUM_RELIABLE_WATCH_BUN_VERSION).toBe("1.3.14");
    expect(supportsReliableWatchMode("1.3.14")).toBe(true);
    expect(supportsReliableWatchMode("1.3.14+abc123")).toBe(true);
    expect(supportsReliableWatchMode("1.4.0")).toBe(true);
    expect(supportsReliableWatchMode("1.4.0-canary.1")).toBe(true);
    expect(supportsReliableWatchMode("2.0.0-canary.1")).toBe(true);
  });

  test("rejects affected and malformed runtime versions", () => {
    expect(supportsReliableWatchMode("1.3.10")).toBe(false);
    expect(supportsReliableWatchMode("1.3.13")).toBe(false);
    expect(supportsReliableWatchMode("1.3.14-canary.1")).toBe(false);
    expect(supportsReliableWatchMode("not-a-version")).toBe(false);
  });

  test("reports the deadlock risk and recovery options", () => {
    expect(() => assertReliableWatchRuntime("1.3.10")).toThrow(HunkUserError);
    expect(() => assertReliableWatchRuntime("1.3.10")).toThrow(
      "can deadlock while closing filesystem watchers",
    );

    try {
      assertReliableWatchRuntime("1.3.10");
    } catch (error) {
      expect(error).toMatchObject({
        suggestions: ["Upgrade Bun with `bun upgrade`, or run Hunk without `--watch`."],
      });
    }
  });
});

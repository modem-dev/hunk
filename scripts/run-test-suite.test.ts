import { describe, expect, test } from "bun:test";
import {
  buildTestShardCommand,
  DEFAULT_TEST_PATTERNS,
  resolveTestShardCount,
  terminateTestShardProcesses,
} from "./run-test-suite";

describe("test suite sharding", () => {
  test("uses the available CPUs up to the automatic cap", () => {
    expect(resolveTestShardCount(1)).toBe(1);
    expect(resolveTestShardCount(2)).toBe(2);
    expect(resolveTestShardCount(32)).toBe(2);
  });

  test("accepts an explicit positive shard count on Linux", () => {
    expect(resolveTestShardCount(32, "1", "linux")).toBe(1);
    expect(resolveTestShardCount(2, "16", "linux")).toBe(16);
  });

  test("keeps non-Linux suites serial to avoid cross-process port races", () => {
    expect(resolveTestShardCount(32, undefined, "win32")).toBe(1);
    expect(resolveTestShardCount(32, "16", "darwin")).toBe(1);
  });

  test("rejects malformed or excessive shard overrides", () => {
    expect(() => resolveTestShardCount(8, "0")).toThrow(
      "HUNK_TEST_SHARDS must be a positive safe integer",
    );
    expect(() => resolveTestShardCount(8, "2.5")).toThrow(
      "HUNK_TEST_SHARDS must be a positive safe integer",
    );
    expect(() => resolveTestShardCount(8, "999999999999999999999999")).toThrow(
      "HUNK_TEST_SHARDS must be a positive safe integer",
    );
    expect(() => resolveTestShardCount(8, "65")).toThrow("HUNK_TEST_SHARDS cannot exceed 64");
  });

  test("builds serial and sharded Bun commands", () => {
    expect(buildTestShardCommand("/opt/bun", 1, 1)).toEqual([
      "/opt/bun",
      "test",
      "--no-orphans",
      ...DEFAULT_TEST_PATTERNS,
    ]);
    expect(buildTestShardCommand("/opt/bun", 2, 4, ["--rerun-each=2"])).toEqual([
      "/opt/bun",
      "test",
      "--no-orphans",
      "--shard=2/4",
      ...DEFAULT_TEST_PATTERNS,
      "--rerun-each=2",
    ]);
  });

  test("forwards termination while tolerating an already stopped shard", () => {
    const signals: Array<NodeJS.Signals> = [];
    terminateTestShardProcesses(
      [
        { kill: (signal) => signals.push(signal as NodeJS.Signals) },
        {
          kill: () => {
            throw new Error("already stopped");
          },
        },
      ],
      "SIGTERM",
    );

    expect(signals).toEqual(["SIGTERM"]);
  });
});

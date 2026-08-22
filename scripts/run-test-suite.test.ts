import { describe, expect, test } from "bun:test";
import {
  buildTestShardCommand,
  DEFAULT_TEST_PATTERNS,
  resolveTestShardCount,
  terminateTestShardProcesses,
} from "./run-test-suite";

describe("test suite sharding", () => {
  test("uses the available CPUs up to the automatic Linux cap", () => {
    expect(resolveTestShardCount(1, undefined, "linux")).toBe(1);
    expect(resolveTestShardCount(2, undefined, "linux")).toBe(2);
    expect(resolveTestShardCount(32, undefined, "linux")).toBe(2);
  });

  test("accepts an explicit positive shard count on Linux", () => {
    expect(resolveTestShardCount(32, "1", "linux")).toBe(1);
    expect(resolveTestShardCount(2, "16", "linux")).toBe(16);
  });

  test("keeps non-Linux suites serial", () => {
    expect(resolveTestShardCount(32, undefined, "win32")).toBe(1);
    expect(resolveTestShardCount(32, "16", "darwin")).toBe(1);
  });

  test("rejects malformed or excessive Linux shard overrides", () => {
    expect(() => resolveTestShardCount(8, "0", "linux")).toThrow(
      "HUNK_TEST_SHARDS must be a positive safe integer",
    );
    expect(() => resolveTestShardCount(8, "2.5", "linux")).toThrow(
      "HUNK_TEST_SHARDS must be a positive safe integer",
    );
    expect(() => resolveTestShardCount(8, "999999999999999999999999", "linux")).toThrow(
      "HUNK_TEST_SHARDS must be a positive safe integer",
    );
    expect(() => resolveTestShardCount(8, "65", "linux")).toThrow(
      "HUNK_TEST_SHARDS cannot exceed 64",
    );
  });

  test("builds serial and sharded Bun commands", () => {
    expect(buildTestShardCommand("/opt/bun", 1, 1, [], "linux")).toEqual([
      "/opt/bun",
      "test",
      "--no-orphans",
      ...DEFAULT_TEST_PATTERNS,
    ]);
    expect(buildTestShardCommand("/opt/bun", 2, 4, ["--rerun-each=2"], "linux")).toEqual([
      "/opt/bun",
      "test",
      "--no-orphans",
      "--shard=2/4",
      ...DEFAULT_TEST_PATTERNS,
      "--rerun-each=2",
    ]);
    expect(buildTestShardCommand("C:\\bun.exe", 1, 1, [], "win32")).toEqual([
      "C:\\bun.exe",
      "test",
      ...DEFAULT_TEST_PATTERNS,
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

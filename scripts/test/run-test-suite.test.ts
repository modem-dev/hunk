import { describe, expect, test } from "bun:test";
import {
  buildTestShardCommand,
  DEFAULT_TEST_PATTERNS,
  requiresSerialTestExecution,
  resolveTestGroupShardCount,
  resolveTestInvocation,
  resolveTestShardCount,
  TEST_PATTERN_GROUPS,
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

  test("keeps automatic non-Linux suites serial but accepts explicit CI sharding", () => {
    expect(resolveTestShardCount(32, undefined, "win32")).toBe(1);
    expect(resolveTestShardCount(32, "2", "win32")).toBe(2);
    expect(resolveTestShardCount(32, "16", "darwin")).toBe(16);
  });

  test("keeps PTY integration serial by default while allowing measured overrides", () => {
    expect(resolveTestGroupShardCount(32, undefined, "linux", "integration")).toBe(1);
    expect(resolveTestGroupShardCount(32, "2", "linux", "integration")).toBe(2);
    expect(resolveTestGroupShardCount(32, undefined, "linux", "default")).toBe(2);
  });

  test("rejects malformed or excessive shard overrides", () => {
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

  test("resolves named test groups without forwarding the selector", () => {
    expect(resolveTestInvocation(["--group=integration", "--rerun-each=2"])).toEqual({
      forwardedArgs: ["--rerun-each=2"],
      group: "integration",
      patterns: TEST_PATTERN_GROUPS.integration,
    });
    expect(resolveTestInvocation([]).group).toBe("default");
    expect(() => resolveTestInvocation(["--group=missing"])).toThrow("Unknown test group: missing");
    expect(() => resolveTestInvocation(["--group=toString"])).toThrow(
      "Unknown test group: toString",
    );
    expect(() => resolveTestInvocation(["--group=default", "--group=integration"])).toThrow(
      "Only one --group argument may be provided",
    );
  });

  test("keeps filtered and file-output invocations serial", () => {
    expect(requiresSerialTestExecution([])).toBe(false);
    expect(requiresSerialTestExecution(["--rerun-each=2"])).toBe(false);
    expect(requiresSerialTestExecution(["-t", "one test"])).toBe(true);
    expect(requiresSerialTestExecution(["--only"])).toBe(true);
    expect(requiresSerialTestExecution(["--test-name-pattern=one test"])).toBe(true);
    expect(requiresSerialTestExecution(["--coverage"])).toBe(true);
    expect(requiresSerialTestExecution(["--coverage-dir=coverage/custom"])).toBe(true);
    expect(requiresSerialTestExecution(["--reporter-outfile=reports/junit.xml"])).toBe(true);
    expect(requiresSerialTestExecution(["--reporter-outfile", "reports/junit.xml"])).toBe(true);
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
    expect(
      buildTestShardCommand("C:\\bun.exe", 1, 1, [], "win32", TEST_PATTERN_GROUPS.integration),
    ).toEqual(["C:\\bun.exe", "test", ...TEST_PATTERN_GROUPS.integration]);
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

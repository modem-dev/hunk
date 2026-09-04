import { describe, expect, test } from "bun:test";
import { logSignalExitCode } from "./runInteractiveLog";

describe("interactive log lifecycle", () => {
  test("preserves conventional signal exit codes after cleanup", () => {
    expect(logSignalExitCode("SIGINT")).toBe(130);
    expect(logSignalExitCode("SIGHUP")).toBe(129);
    expect(logSignalExitCode("SIGTERM")).toBe(143);
  });
});

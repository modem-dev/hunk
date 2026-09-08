import { describe, expect, mock, test } from "bun:test";
import type { InteractiveHistoryRuntime } from "../history/types";
import { logSignalExitCode, runInteractiveLog } from "./runInteractiveLog";

describe("interactive log lifecycle", () => {
  test("preserves conventional signal exit codes after cleanup", () => {
    expect(logSignalExitCode("SIGINT")).toBe(130);
    expect(logSignalExitCode("SIGHUP")).toBe(129);
    expect(logSignalExitCode("SIGTERM")).toBe(143);
  });

  test("closes cursor then extension authority when interactive input has no terminal", async () => {
    const events: string[] = [];
    const runtime = {
      close: mock(async () => {
        events.push("cursor");
      }),
      extensionSession: {
        shutdown: mock(async () => {
          events.push("extensions");
        }),
      },
    } as unknown as InteractiveHistoryRuntime;

    await expect(
      runInteractiveLog(runtime, {
        stdin: { isTTY: false } as never,
        stdout: { isTTY: true } as never,
      }),
    ).rejects.toThrow("requires a terminal");
    expect(events).toEqual(["cursor", "extensions"]);
  });

  test("still shuts down extensions when non-terminal cursor cleanup rejects", async () => {
    const events: string[] = [];
    const failure = new Error("cursor close failed");
    const runtime = {
      close: mock(async () => {
        events.push("cursor");
        throw failure;
      }),
      extensionSession: {
        shutdown: mock(async () => {
          events.push("extensions");
        }),
      },
    } as unknown as InteractiveHistoryRuntime;

    await expect(
      runInteractiveLog(runtime, {
        stdin: { isTTY: false } as never,
        stdout: { isTTY: true } as never,
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual(["cursor", "extensions"]);
  });
});

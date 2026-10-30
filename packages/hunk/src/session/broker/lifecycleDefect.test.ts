import { describe, expect, test } from "bun:test";
import { SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE } from "@hunk/session-broker";
import { reportHunkSessionBrokerLifecycleDefect } from "./lifecycleDefect";

describe("Hunk session broker lifecycle defect composition", () => {
  test("writes only the fixed message even when called with sensitive input", () => {
    const originalConsoleError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      reportHunkSessionBrokerLifecycleDefect(`credential-${crypto.randomUUID()}`);
    } finally {
      console.error = originalConsoleError;
    }

    expect(calls).toEqual([[SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]]);
  });
});

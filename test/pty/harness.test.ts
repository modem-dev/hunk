import { describe, expect, test } from "bun:test";
import type { Session } from "tuistory";
import { createPtyHarness } from "./harness";

/** Simulate a key whose first output-idle cycle ends before its destination is painted. */
function createTestTransitionSession(screens: string[]) {
  const inputs: Parameters<Session["sendKey"]>[0][] = [];
  let frame = 0;
  const session: Pick<Session, "sendKey" | "text" | "waitForText" | "waitIdle"> = {
    sendKey(key) {
      inputs.push(key);
    },
    async text() {
      return screens[frame]!;
    },
    async waitForText() {
      frame = screens.length - 1;
      return screens[frame]!;
    },
    async waitIdle() {
      frame = Math.min(frame + 1, screens.length - 1);
    },
  };
  return { inputs, session };
}

describe("PTY transition synchronization", () => {
  test("waits past shared content until the destination is visible", async () => {
    const { session, inputs } = createTestTransitionSession([
      "Second history commit — review",
      "Second history commit — Enter open",
    ]);
    const harness = createPtyHarness();
    const snapshot = await harness.pressAndWaitForSnapshot(session, "q", (text) =>
      text.includes("Enter open"),
    );
    expect(snapshot).toBe("Second history commit — Enter open");
    expect(inputs).toEqual(["q"]);
  });

  test("reports a missing destination without retrying the key", async () => {
    const { session, inputs } = createTestTransitionSession(["Draft note — body"]);
    const harness = createPtyHarness();
    await expect(
      harness.pressAndWaitForSnapshot(
        session,
        ["ctrl", "s"],
        (text) => !text.includes("Draft note") && text.includes("Your note"),
        1,
      ),
    ).rejects.toThrow("Last snapshot:\nDraft note — body");
    expect(inputs).toEqual([["ctrl", "s"]]);
  });

  test("rejects a predicate that cannot distinguish the destination", async () => {
    const { session, inputs } = createTestTransitionSession(["Shared content"]);
    const harness = createPtyHarness();
    await expect(
      harness.pressAndWaitForSnapshot(session, "q", (text) => text.includes("Shared content")),
    ).rejects.toThrow("destination was visible before the keypress");
    expect(inputs).toEqual([]);
  });

  test("waits directly for text produced by a key transition", async () => {
    const { session, inputs } = createTestTransitionSession(["Review", "Theme selector"]);
    const harness = createPtyHarness();
    await expect(harness.pressAndWaitForText(session, "t", /Theme selector/)).resolves.toBe(
      "Theme selector",
    );
    expect(inputs).toEqual(["t"]);
  });

  test("rejects text already visible before the key transition", async () => {
    const { session, inputs } = createTestTransitionSession(["Draft note — body"]);
    const harness = createPtyHarness();
    await expect(harness.pressAndWaitForText(session, ["ctrl", "s"], /Draft note/)).rejects.toThrow(
      "destination was visible before the keypress",
    );
    expect(inputs).toEqual([]);
  });
});

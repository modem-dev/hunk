import { describe, expect, test } from "bun:test";
import type { Session } from "tuistory";
import { createPtyHarness } from "./harness";

/** Simulate a key whose output-idle wait returns before its destination is painted. */
function createTestTransitionSession(screens: string[]) {
  const inputs: Parameters<Session["press"]>[0][] = [];
  let frame = 0;
  const session: Pick<Session, "press" | "text" | "waitIdle"> = {
    async press(key) {
      inputs.push(key);
    },
    async text() {
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
});

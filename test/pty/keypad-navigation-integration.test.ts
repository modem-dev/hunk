import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Allow real terminal startup and redraws on slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/** Compare code rows without transient chrome or status messages. */
function codeRows(text: string) {
  return text.split("\n").filter((line) => /line\d+ = \d+;/.test(line));
}

describe("PTY keypad navigation", () => {
  test("Kitty keypad PageDown and PageUp scroll like the main keyboard keys", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split", "--cursor-line", "off"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/line01 = 101;/, { timeout: 15_000 });
      const paged = await harness.pressAndWaitForSnapshot(
        session,
        "pagedown",
        (text) => !text.includes("line01 = 101;") && /line\d+ = \d+;/.test(text),
        5_000,
      );
      await harness.pressAndWaitForText(session, "pageup", /line01 = 101;/, { timeout: 5_000 });

      session.writeRaw("\x1b[57422u");
      const keypadDown = await harness.waitForSnapshot(
        session,
        (text) => codeRows(text).join("\n") === codeRows(paged).join("\n"),
        5_000,
      );
      expect(codeRows(keypadDown)).toEqual(codeRows(paged));

      session.writeRaw("\x1b[57421u");
      const keypadUp = await session.waitForText(/line01 = 101;/, { timeout: 5_000 });
      expect(codeRows(keypadUp)).toEqual(codeRows(initial));
    } finally {
      session.close();
    }
  });
});

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/**
 * Drives the real feedback form in a live review.
 *
 * These runs never press send: the form is opened, typed into, and closed, so they cannot reach
 * Modem even once the build carries a real channel token. Sending is covered with an injected
 * sender in `AppHost.feedback.test.tsx`.
 */
describe("PTY feedback form", () => {
  test("opens from the Help menu with the disclosure and keeps typing out of review commands", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 120,
      rows: 40,
    });

    try {
      await session.waitForText(/alpha\.ts/, { timeout: 15_000 });

      await harness.clickAndWaitForText(session, /Help/, /Send feedback…/, { timeout: 5_000 });
      const form = await harness.clickAndWaitForText(
        session,
        /Send feedback…/,
        /Send feedback to the Hunk team/,
        { timeout: 5_000 },
      );
      expect(form).toContain("This sends your message to the team that makes Hunk");
      expect(form).toContain("modem.dev");
      expect(form).toContain("Nothing is sent until you confirm.");
      expect(form).toContain("IP address");
      expect(form).toContain("send to Modem");

      // `]` and `q` are review commands; inside the form they are only text.
      await session.type("Resize jumps ] q");
      const typed = await session.waitForText(/Resize jumps \] q/, { timeout: 5_000 });
      expect(typed).toContain("Send feedback to the Hunk team");

      await session.press("esc");
      const asking = await session.waitForText(/Discard this feedback\?/, { timeout: 5_000 });
      expect(asking).toContain("Nothing has been sent");

      await session.press("enter");
      const closed = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Send feedback to the Hunk team"),
        5_000,
      );
      expect(closed).toContain("alpha.ts");
    } finally {
      session.close();
    }
  });

  test("hunk feedback with no message opens the standalone form and exits on cancel", async () => {
    const command = harness.buildHunkCommand(["feedback"]);
    const session = await harness.launchShellCommand({
      command: `${command}; printf '\\nFEEDBACK_EXIT:%s\\n' "$?"`,
      cols: 100,
      rows: 40,
    });

    try {
      const form = await session.waitForText(/Send feedback to the Hunk team/, { timeout: 15_000 });
      expect(form).toContain("This sends your message to the team that makes Hunk");

      await session.press("esc");
      const exited = await session.waitForText(/FEEDBACK_EXIT:0/, { timeout: 5_000 });
      expect(exited).not.toContain("Sent.");
    } finally {
      session.close();
    }
  });

  test("a piped message is confirmed on the terminal, and `n` sends nothing", async () => {
    const command = harness.buildHunkCommand(["feedback", "--file", "-"]);
    const session = await harness.launchShellCommand({
      // `y` on stdin must never count as the answer; the prompt reads the terminal.
      command: `printf 'y\\nPiped feedback\\n' | ${command}; printf '\\nFEEDBACK_EXIT:%s\\n' "$?"`,
      cols: 120,
      rows: 40,
    });

    try {
      const prompt = await session.waitForText(/Send this feedback to Modem\? \[y\/N\]/, {
        timeout: 15_000,
      });
      expect(prompt).toContain('"message": "y\\nPiped feedback"');

      session.writeRaw("n\r");
      const exited = await session.waitForText(/FEEDBACK_EXIT:0/, { timeout: 5_000 });
      expect(exited).toContain("Not sent.");
    } finally {
      session.close();
    }
  });
});

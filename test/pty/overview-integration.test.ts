import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY overview dialog", () => {
  /**
   * Build a file pair with an agent-context sidecar that has a top-level title
   * and description so the auto-open behaviour can be exercised.
   */
  function createOverviewFilePair() {
    const fixture = harness.createAgentFilePair();

    // Write a richer sidecar that adds changeset-level title + description on top
    // of the existing file annotations so both agent notes and the overview dialog
    // can be tested in the same session.
    writeFileSync(
      fixture.agentContext,
      JSON.stringify({
        version: 1,
        title: "PR title",
        description: "# Summary\n\nHello overview",
        files: [
          {
            path: basename(fixture.after),
            annotations: [
              {
                newRange: [2, 2],
                summary: "Adds bonus export.",
                rationale: "Highlights the follow-up addition for review.",
              },
            ],
          },
        ],
      }),
    );

    return fixture;
  }

  test("overview overlay auto-opens and can be toggled with o and Esc", async () => {
    const fixture = createOverviewFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        fixture.before,
        fixture.after,
        "--mode",
        "split",
        "--agent-context",
        fixture.agentContext,
      ],
      cols: 140,
      rows: 24,
    });

    try {
      // (1) Overview should auto-open because the sidecar has title + description.
      const autoOpened = await harness.waitForSnapshot(
        session,
        (text) => text.includes("PR title") && text.includes("Hello overview"),
        15_000,
      );
      expect(autoOpened).toContain("PR title");
      expect(autoOpened).toContain("Hello overview");

      // (2) Esc should close the overlay and reveal the diff stream.
      await session.press("escape");
      const afterEsc = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Hello overview") && text.includes("after.ts"),
        5_000,
      );
      expect(afterEsc).not.toContain("Hello overview");
      expect(afterEsc).toContain("after.ts");

      // (3) o should reopen the overlay.
      await session.press("o");
      const reopened = await harness.waitForSnapshot(
        session,
        (text) => text.includes("PR title"),
        5_000,
      );
      expect(reopened).toContain("PR title");

      // (4) Esc again should close it.
      await session.press("escape");
      const closedAgain = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Hello overview"),
        5_000,
      );
      expect(closedAgain).not.toContain("Hello overview");

      // (5) o once more to reopen, then o again to toggle closed.
      await session.press("o");
      await harness.waitForSnapshot(session, (text) => text.includes("PR title"), 5_000);

      await session.press("o");
      const toggledClosed = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Hello overview"),
        5_000,
      );
      expect(toggledClosed).not.toContain("Hello overview");
    } finally {
      session.close();
    }
  });
});

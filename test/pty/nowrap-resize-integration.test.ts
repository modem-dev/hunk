import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Allow real terminal startup and repeated resize acknowledgements on slower CI hosts. */
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

test("fixed split nowrap resizes preserve cross-file navigation and wrapping still reflows", async () => {
  const fixture = harness.createPinnedHeaderRepoFixture();
  const session = await harness.launchHunk({
    args: ["diff", "--mode", "split", "--no-sidebar"],
    cwd: fixture.dir,
    cols: 120,
    rows: 24,
  });

  try {
    await harness.waitForSnapshot(session, (text) => text.includes("line01 = 101"), 15_000);
    await harness.pressAndWaitForSnapshot(
      session,
      "]",
      (text) => text.includes("line17 = 117") && !text.includes("line01 = 101"),
    );

    for (const cols of [180, 100, 140, 100, 180, 120]) {
      session.resize({ cols, rows: 24 });
      // A moved split separator acknowledges the live-width repaint, not a stale old frame.
      const frame = await harness.waitForSnapshot(session, (text) => {
        const row = text.split("\n").find((line) => line.includes("line17 = 117"));
        return Boolean(row && row.lastIndexOf("▌") === Math.floor(cols / 2) - 1);
      });
      expect(frame).toContain("second.ts");
      expect(frame).toContain("line32 = 132");
      expect(frame).not.toContain("line01 = 101");
    }

    await harness.pressAndWaitForSnapshot(session, "[", (text) => text.includes("line01 = 101"));
    await harness.pressAndWaitForSnapshot(
      session,
      "]",
      (text) => text.includes("line17 = 117") && !text.includes("line01 = 101"),
    );

    await harness.pressAndWaitForSnapshot(session, "[", (text) => text.includes("line01 = 101"));
    session.resize({ cols: 60, rows: 24 });
    await harness.waitForSnapshot(session, (text) => {
      const row = text.split("\n").find((line) => line.includes("line01"));
      return Boolean(row && row.lastIndexOf("▌") === 29);
    });
    const wrapped = await harness.pressAndWaitForSnapshot(
      session,
      "w",
      (text) => text.includes("101;") && !text.includes("line16"),
    );
    expect(wrapped).toContain("line01");

    session.resize({ cols: 120, rows: 24 });
    const wideWrapped = await harness.waitForSnapshot(
      session,
      (text) => text.includes("line01 = 101") && text.includes("line16 = 116"),
    );
    expect(wideWrapped).toMatch(/▌.*▌/);
    session.resize({ cols: 60, rows: 24 });
    await harness.waitForSnapshot(
      session,
      (text) => text.includes("101;") && !text.includes("line16"),
    );
    const nowrap = await harness.pressAndWaitForSnapshot(
      session,
      "w",
      (text) => !text.includes("101;") && text.includes("line16"),
    );
    expect(nowrap).toContain("line01");
  } finally {
    session.close();
  }
});

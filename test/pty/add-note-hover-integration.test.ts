import { afterEach, expect, test } from "bun:test";
import { createPtyHarness, lineIndexOf, moveMouse, sleep } from "./harness";

const harness = createPtyHarness();
afterEach(() => harness.cleanup());

test("add-note hover after navigation survives the deferred viewport read", async () => {
  const fixture = harness.createMultiHunkFilePair();
  const session = await harness.launchHunk({
    args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
    cols: 104,
    rows: 13,
  });
  try {
    await session.waitForText(/line1 = 100/, { timeout: 15_000 });
    await harness.ensureKeyboardIsLive(session);
    session.writeRaw("]");
    const navigated = await session.waitForText(/line60 = 6000/);
    const row = lineIndexOf(navigated, "line60 = 6000") - 1;
    await moveMouse(session, 80, row);
    const hovered = await session.waitForText(/\[\+\]/);
    await sleep(100);
    expect(await session.text({ immediate: true })).toContain("[+]");
    const badgeRow = lineIndexOf(hovered, "[+]") - 1;
    const badgeColumn = hovered.split("\n")[badgeRow + 1]!.indexOf("[+]");
    session.writeRaw(
      `\x1b[<0;${badgeColumn + 2};${badgeRow + 1}M\x1b[<0;${badgeColumn + 2};${badgeRow + 1}m`,
    );
    await session.waitForText(/Draft note/);
  } finally {
    session.close();
  }
}, 20_000);

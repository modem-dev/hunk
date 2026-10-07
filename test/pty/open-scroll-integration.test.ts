import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const roots: string[] = [];
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

/** Create long identifiable lines without depending on a repository or user configuration. */
function createOpenScrollTestText(count: number, suffix = "x".repeat(90)) {
  return Array.from(
    { length: count },
    (_, index) => `LINE_${String(index + 1).padStart(3, "0")} ${suffix}`,
  ).join("\n");
}

/** Read the first visible source line, ignoring document chrome and wrapped continuation rows. */
function firstOpenScrollTestLine(frame: string) {
  return Number(frame.match(/LINE_(\d+)/)?.[1]);
}

/** Create a standalone document that the source-built PTY app can watch. */
function createOpenScrollTestFixture() {
  const root = mkdtempSync(join(tmpdir(), "hunk-open-scroll-"));
  roots.push(root);
  const path = join(root, "scroll.txt");
  writeFileSync(path, createOpenScrollTestText(300));
  return path;
}

test("initial open fills the document viewport before keyboard input and after resizing", async () => {
  const path = createOpenScrollTestFixture();
  writeFileSync(path, createOpenScrollTestText(100, ""));
  const session = await harness.launchHunk({
    args: ["open", path, "--no-wrap", "--no-line-numbers"],
    cols: 40,
    rows: 20,
  });

  try {
    const first = await session.waitForText("LINE_017");
    expect(first.match(/LINE_\d+/g)).toHaveLength(17);
    session.resize({ cols: 42, rows: 24 });
    const resized = await session.waitForText("LINE_021");
    expect(resized.match(/LINE_\d+/g)).toHaveLength(21);
    await session.press("q");
  } finally {
    session.close();
  }
});

test("deep open scrolling retains the logical line through wrap, gutters and terminal resize", async () => {
  const path = createOpenScrollTestFixture();
  const session = await harness.launchHunk({
    args: ["open", path, "--no-wrap", "--no-line-numbers"],
    cols: 40,
    rows: 12,
  });
  try {
    await session.waitForText("LINE_001");
    await harness.ensureKeyboardIsLive(session);
    session.writeRaw("j".repeat(250));
    await harness.waitForSnapshot(session, (text) => firstOpenScrollTestLine(text) === 251);
    await session.press("w");
    expect(firstOpenScrollTestLine(await session.text())).toBe(251);
    await session.press("l");
    expect(firstOpenScrollTestLine(await session.text())).toBe(251);
    session.resize({ cols: 25, rows: 12 });
    await harness.waitForSnapshot(session, (text) => firstOpenScrollTestLine(text) === 251);
    session.resize({ cols: 65, rows: 16 });
    await harness.waitForSnapshot(session, (text) => firstOpenScrollTestLine(text) === 251);
    await session.press("w");
    expect(firstOpenScrollTestLine(await session.text())).toBe(251);
    await session.press("down");
    expect(firstOpenScrollTestLine(await session.text())).toBe(252);
    await session.scrollDown(1);
    expect(firstOpenScrollTestLine(await session.text())).toBeGreaterThan(252);
    await session.press("g");
    await session.waitForText("LINE_001");
    await session.press("q");
  } finally {
    session.close();
  }
});

test("watched source shrink clamps deep scrolling to the surviving end instead of line one", async () => {
  const path = createOpenScrollTestFixture();
  const session = await harness.launchHunk({
    args: ["open", path, "--wrap", "--no-line-numbers"],
    cols: 40,
    rows: 12,
  });
  try {
    await session.waitForText("LINE_001");
    await harness.ensureKeyboardIsLive(session);
    session.writeRaw("j".repeat(800));
    await harness.waitForSnapshot(session, (text) => firstOpenScrollTestLine(text) === 201);
    writeFileSync(path, createOpenScrollTestText(100));
    await session.waitForText("LINE_100");
    expect(firstOpenScrollTestLine(await session.text())).toBeGreaterThan(90);
    // The bottom clamp can land inside a wrapped line; align to a full line before comparing prefixes.
    await session.press("g");
    session.writeRaw("j".repeat(356));
    await harness.waitForSnapshot(session, (text) => firstOpenScrollTestLine(text) === 90);
    const survivingLine = firstOpenScrollTestLine(await session.text());
    writeFileSync(path, createOpenScrollTestText(300, "replacement ".repeat(12)));
    await session.waitForText("replacement");
    expect(firstOpenScrollTestLine(await session.text())).toBe(survivingLine);
    await session.press("w");
    expect(firstOpenScrollTestLine(await session.text())).toBe(survivingLine);
    await session.press("g");
    await session.waitForText("LINE_001");
    await session.press("q");
  } finally {
    session.close();
  }
});

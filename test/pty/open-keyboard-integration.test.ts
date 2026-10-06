import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const roots: string[] = [];
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

/** Create complete documents and an editor whose invocation is observable outside the terminal. */
function createTestOpenKeyboardFixture() {
  const root = mkdtempSync(join(tmpdir(), "hunk-open-keyboard-"));
  roots.push(root);
  writeFileSync(
    join(root, "a.txt"),
    Array.from({ length: 100 }, (_, index) => `FIRST_DOCUMENT_ROW_${index + 1}`).join("\n"),
  );
  writeFileSync(join(root, "b.txt"), "SECOND_DOCUMENT\n");
  const marker = join(root, "editor-invoked");
  const editor = join(root, "editor.mjs");
  writeFileSync(
    editor,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "invoked");`,
  );
  return { root, marker, env: { EDITOR: `"${process.execPath}" "${editor}"` } };
}

describe("open keyboard bursts", () => {
  test("raw help and theme bursts block editor commands until their modal closes", async () => {
    const fixture = createTestOpenKeyboardFixture();
    const session = await harness.launchHunk({
      args: ["open", join(fixture.root, "a.txt")],
      cols: 100,
      rows: 20,
      env: fixture.env,
    });
    try {
      await session.waitForText("FIRST_DOCUMENT_ROW_1");
      await harness.ensureKeyboardIsLive(session);
      session.writeRaw("?eq");
      await session.waitForText("Controls help");
      expect(existsSync(fixture.marker)).toBe(false);
      await session.press("?");
      await harness.waitForSnapshot(session, (text) => !text.includes("Controls help"));

      session.writeRaw("t\x1b[Beq");
      await session.waitForText("Theme selector");
      expect(existsSync(fixture.marker)).toBe(false);
      session.writeRaw("\re");
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Theme selector") && existsSync(fixture.marker),
      );
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("raw Tab/Down scrolls the newly focused document instead of selecting the next file", async () => {
    const fixture = createTestOpenKeyboardFixture();
    const session = await harness.launchHunk({ args: ["open", fixture.root], cols: 100, rows: 20 });
    try {
      await session.waitForText("a.txt");
      await harness.ensureKeyboardIsLive(session);
      await session.click(/a\.txt/, { first: true });
      await session.waitForText("FIRST_DOCUMENT_ROW_1");
      session.writeRaw("\t\x1b[B");
      const frame = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("Document · read-only") &&
          text.includes("FIRST_DOCUMENT_ROW_2") &&
          !/FIRST_DOCUMENT_ROW_1\b/.test(text),
      );
      expect(frame).not.toContain("SECOND_DOCUMENT");
      expect(frame).toContain("Document · read-only");
      await session.press("q");
    } finally {
      session.close();
    }
  });
});

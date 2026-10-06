import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "invoked\\n");`,
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

describe("open menu accelerators", () => {
  test("mouse entries and raw refresh/edit/quit accelerators share menu closing and command effects", async () => {
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
      await session.click(/File/, { first: true });
      await session.waitForText("Refresh documents");
      await session.click(/Refresh documents/, { first: true });
      await harness.waitForSnapshot(session, (text) => !text.includes("Refresh documents"));

      await session.press("f10");
      await session.waitForText("Refresh documents");
      session.writeRaw("r");
      await harness.waitForSnapshot(session, (text) => !text.includes("Refresh documents"));
      await session.click(/File/, { first: true });
      await session.waitForText("Open file in $EDITOR");
      await session.click(/Open file in \$EDITOR/, { first: true });
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Refresh documents") && existsSync(fixture.marker),
      );
      expect(readFileSync(fixture.marker, "utf8").trim().split("\n")).toHaveLength(1);

      session.writeRaw("\x1b[21~e");
      await harness.waitForSnapshot(
        session,
        (text) =>
          !text.includes("Refresh documents") &&
          readFileSync(fixture.marker, "utf8").trim().split("\n").length === 2,
      );
      const quitOutputStart = session.getRawOutput().length;
      session.writeRaw("\x1b[21~q");
      await harness.waitForSnapshot(session, () =>
        session.getRawOutput().slice(quitOutputStart).includes("\x1b[?1049l"),
      );
    } finally {
      session.close();
    }
  });

  test("raw menu accelerators respect configured remaps and ignore the replaced defaults", async () => {
    const fixture = createTestOpenKeyboardFixture();
    const configHome = harness.createIsolatedConfigHome();
    const configDir = join(configHome, "hunk");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.toml"),
      '[keybindings]\n"hunk.app.refresh" = "x"\n"hunk.documents.edit" = "o"\n"hunk.app.quit" = "z"\n',
    );
    const session = await harness.launchHunk({
      args: ["open", join(fixture.root, "a.txt")],
      cols: 100,
      rows: 20,
      env: { ...fixture.env, XDG_CONFIG_HOME: configHome },
    });
    try {
      await session.waitForText("FIRST_DOCUMENT_ROW_1");
      await harness.ensureKeyboardIsLive(session);
      session.writeRaw("\x1b[21~req");
      await session.waitForText("Refresh documents");
      expect(existsSync(fixture.marker)).toBe(false);
      expect(await session.text()).toMatch(/Open file in \$EDITOR\s+o/);
      await session.press("x");
      await harness.waitForSnapshot(session, (text) => !text.includes("Refresh documents"));
      session.writeRaw("\x1b[21~o");
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Refresh documents") && existsSync(fixture.marker),
      );
      const quitOutputStart = session.getRawOutput().length;
      session.writeRaw("\x1b[21~z");
      await harness.waitForSnapshot(session, () =>
        session.getRawOutput().slice(quitOutputStart).includes("\x1b[?1049l"),
      );
    } finally {
      session.close();
    }
  });
});

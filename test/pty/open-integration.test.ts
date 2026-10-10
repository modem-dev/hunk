import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const roots: string[] = [];
setDefaultTimeout(30_000);
afterEach(() => {
  harness.cleanup();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

/** Create a non-repository fixture so browsing proves it does not depend on a diff source. */
function createOpenTestFixture() {
  const root = mkdtempSync(join(tmpdir(), "hunk-open-pty-"));
  roots.push(root);
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "child.ts"), "const childDocument = 42;\n");
  writeFileSync(join(root, "README.md"), "# Whole document\nUnchanged content\n");
  writeFileSync(join(root, ".hidden"), "Hidden document\n");
  writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2]));
  writeFileSync(
    join(root, "large.ts"),
    Array.from(
      { length: 300 },
      (_, index) => `const completeLine${index + 1} = ${index + 1};`,
    ).join("\n") + "\n",
  );
  return root;
}

describe("hunk open", () => {
  test("edits through a private copy and refreshes the saved complete document", async () => {
    const root = createOpenTestFixture();
    const path = join(root, "README.md");
    const editor = join(root, "editor.mjs");
    const target = join(root, "editor-target.txt");
    writeFileSync(
      editor,
      `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(target)}, process.argv[2]);
      writeFileSync(process.argv[2], "Saved document from editor\\n");`,
    );
    const session = await harness.launchHunk({
      args: ["open", path],
      cols: 100,
      rows: 20,
      env: { EDITOR: `"${process.execPath}" "${editor}"` },
    });
    try {
      await session.waitForText("Whole document");
      await harness.ensureKeyboardIsLive(session);
      await session.press("e");
      await session.waitForText("Saved document from editor");
      expect(readFileSync(target, "utf8")).not.toBe(path);
      expect(readFileSync(path, "utf8")).toBe("Saved document from editor\n");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("a burst of edit/edit/quit launches once and reports a retained recovery copy after teardown", async () => {
    const root = createOpenTestFixture();
    const path = join(root, "README.md");
    const editor = join(root, "conflicting-editor.mjs");
    const targets = join(root, "editor-targets.txt");
    writeFileSync(
      editor,
      `import { appendFileSync, writeFileSync } from "node:fs";
      appendFileSync(${JSON.stringify(targets)}, process.argv[2] + "\\n");
      writeFileSync(${JSON.stringify(path)}, "Concurrent external update\\n");
      await new Promise(resolve => setTimeout(resolve, 100));
      writeFileSync(process.argv[2], "Editor recovery content\\n");`,
    );
    const session = await harness.launchHunk({
      args: ["open", path],
      cols: 120,
      rows: 20,
      env: { EDITOR: `"${process.execPath}" "${editor}"` },
    });
    let recoveryDirectory: string | undefined;

    try {
      await session.waitForText("Whole document");
      await harness.ensureKeyboardIsLive(session);
      session.writeRaw("eeq");
      await harness.waitForSnapshot(session, () => {
        const raw = session.getRawOutput();
        return (
          raw.lastIndexOf("Editor copy retained in") > raw.lastIndexOf("\x1b[?1049l") &&
          raw.includes("Editor copy retained in")
        );
      });
      const copies = readFileSync(targets, "utf8").trim().split("\n");
      expect(copies).toHaveLength(1);
      recoveryDirectory = dirname(copies[0]!);
      expect(readFileSync(copies[0]!, "utf8")).toBe("Editor recovery content\n");
      expect(readFileSync(path, "utf8")).toBe("Concurrent external update\n");
    } finally {
      session.close();
      if (recoveryDirectory) rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("retains wrapped right-edge characters beside the scrollbar after resizing", async () => {
    const root = createOpenTestFixture();
    const path = join(root, "edge.txt");
    writeFileSync(
      path,
      Array.from({ length: 40 }, () => "12345678901234567890123456789X").join("\n"),
    );
    const session = await harness.launchHunk({
      args: ["open", path, "--wrap", "--no-line-numbers"],
      cols: 30,
      rows: 16,
    });

    try {
      await session.waitForText("X");
      await harness.ensureKeyboardIsLive(session);
      session.resize({ cols: 29, rows: 16 });
      await session.waitForText("9X");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("keyboard navigation reaches the lower help controls without activating document commands", async () => {
    const root = createOpenTestFixture();
    const session = await harness.launchHunk({
      args: ["open", join(root, "README.md")],
      cols: 100,
      rows: 20,
    });

    try {
      await session.waitForText("Whole document");
      await harness.ensureKeyboardIsLive(session);
      await session.press("?");
      await session.waitForText("Controls help");
      expect(await session.text()).not.toContain("Scroll right / expand");
      await session.press("end");
      await session.waitForText("Scroll right / expand");
      await session.press("q");
      expect(await session.text()).toContain("Controls help");
      await session.press("escape");
      await session.waitForText("Whole document");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("wraps complete documents with exact geometry and preserves line navigation across toggles", async () => {
    const root = createOpenTestFixture();
    const path = join(root, "wrapped.txt");
    writeFileSync(path, `BEGIN ${"word ".repeat(36)} WRAPPED_TAIL\nFOLLOWING_DOCUMENT_LINE\n`);
    const session = await harness.launchHunk({
      args: ["open", path, "--wrap"],
      cols: 42,
      rows: 20,
    });
    try {
      await session.waitForText("WRAPPED_TAIL");
      await harness.ensureKeyboardIsLive(session);
      expect(await session.text()).toContain("FOLLOWING_DOCUMENT_LINE");
      await session.press("w");
      await harness.waitForSnapshot(session, (text) => !text.includes("WRAPPED_TAIL"));
      expect(await session.text()).toContain("FOLLOWING_DOCUMENT_LINE");
      await session.press("w");
      await session.waitForText("WRAPPED_TAIL");
      session.resize({ cols: 60, rows: 16 });
      await session.waitForText("FOLLOWING_DOCUMENT_LINE");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("opens a complete file, scrolls, resizes and reuses normal theme/help/menu chrome", async () => {
    const root = createOpenTestFixture();
    const session = await harness.launchHunk({
      args: ["open", join(root, "large.ts"), "--theme", "github-dark-default"],
      cols: 100,
      rows: 20,
    });
    try {
      await session.waitForText("completeLine1 = 1");
      await harness.ensureKeyboardIsLive(session);
      let keywords = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        keywords = await session.text({ immediate: true, only: { foreground: "#ff7b72" } });
        if (keywords.includes("const")) break;
        await session.waitIdle({ timeout: 50 });
      }
      expect(keywords).toContain("const");
      const frame = await session.text();
      expect(frame).not.toContain("@@");
      expect(frame).not.toContain("+300");
      await session.press(["shift", "g"]);
      await session.waitForText("completeLine300 = 300");
      session.resize({ cols: 65, rows: 16 });
      await session.waitForText("completeLine300 = 300");
      await session.press("g");
      await session.waitForText("completeLine1 = 1");
      await session.press("t");
      await session.waitForText("github-dark-default");
      await session.press("escape");
      await session.click(/View/, { first: true });
      await session.waitForText("Line numbers");
      await session.press("escape");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("expands directories by keyboard and mouse, toggles hidden files, watches and shows binary placeholders", async () => {
    const root = createOpenTestFixture();
    const session = await harness.launchHunk({ args: ["open", root], cols: 120, rows: 24 });
    try {
      await session.waitForText("README.md");
      await harness.ensureKeyboardIsLive(session);
      expect(await session.text()).not.toContain(".hidden");
      await session.press("down");
      await session.press("right");
      await session.waitForText("child.ts");
      await session.press("down");
      await session.waitForText("childDocument = 42");
      await session.click(/README\.md/, { first: true });
      await session.waitForText("# Whole document");
      await session.press("i");
      await session.waitForText(".hidden");
      await session.click(/binary/, { first: true });
      await session.waitForText("Binary file");
      await session.click(/README\.md/, { first: true });
      writeFileSync(join(root, "README.md"), "# Refreshed document\n");
      await session.waitForText("# Refreshed document");
      rmSync(join(root, "README.md"));
      await session.waitForText("File no longer exists");
      await session.press("q");
    } finally {
      session.close();
    }
  });
});

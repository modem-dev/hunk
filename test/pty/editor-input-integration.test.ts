import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const roots: string[] = [];

afterEach(() => {
  harness.cleanup();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

/** Verify that editor handoff delivers the first key without an Enter workaround. */
test.each([
  { label: "a plain first key", input: "j" },
  { label: "a first key coalesced with a terminal reply", input: "\x1b[?1;2cj" },
])(
  "a terminal editor receives $label and returns input to the review",
  async ({ input }) => {
    const root = mkdtempSync(join(tmpdir(), "hunk-editor-input-"));
    roots.push(root);
    const before = join(root, "before.txt");
    const after = join(root, "after.txt");
    const received = join(root, "editor-input.txt");
    const editor = join(root, "editor.mjs");
    writeFileSync(before, "before\n");
    writeFileSync(after, "after\n");
    writeFileSync(
      editor,
      `import { writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  // Strip complete replies without discarding keys delivered in the same chunk.
  const keys = stripVTControlCharacters(data.toString());
  if (!keys) return;
  writeFileSync(${JSON.stringify(received)}, keys);
  process.stdin.setRawMode(false);
  process.exit(0);
});
process.stdin.resume();
process.stdout.write("\\x1b[2J\\x1b[HEDITOR_READY_FOR_FIRST_KEY");
`,
    );
    const session = await harness.launchHunk({
      args: ["diff", "--files", before, after, "--no-extensions"],
      cwd: root,
      cols: 100,
      rows: 24,
      env: { EDITOR: `"${process.execPath}" "${editor}"` },
    });

    try {
      await session.waitForText("after.txt");
      await harness.ensureKeyboardIsLive(session);
      await session.press("e");
      await session.waitForText("EDITOR_READY_FOR_FIRST_KEY");
      session.writeRaw(input);
      await harness.waitForSnapshot(
        session,
        (text) => existsSync(received) && text.includes("after.txt"),
      );
      expect(readFileSync(received, "utf8")).toBe("j");
      await session.press("?");
      await session.waitForText("Controls help");
      await session.press("?");
      await session.press("q");
    } finally {
      session.close();
    }
  },
  30_000,
);

/** Smoke-test the reported editor when Neovim is installed on the test host. */
test.skipIf(!Bun.which("nvim"))(
  "Neovim accepts j without Enter after opening from a review",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-neovim-input-"));
    roots.push(root);
    const before = join(root, "before.txt");
    const after = join(root, "after.txt");
    writeFileSync(before, "before\nsecond line\nthird line\n");
    writeFileSync(after, "after\nsecond line\nthird line\n");
    const session = await harness.launchHunk({
      args: ["diff", "--files", before, after, "--no-extensions"],
      cwd: root,
      cols: 100,
      rows: 24,
      env: { EDITOR: 'nvim --clean -c "set laststatus=2 statusline=NVIM_LINE_%l"' },
    });

    try {
      await session.waitForText("after.txt");
      await harness.ensureKeyboardIsLive(session);
      await session.press("e");
      await session.waitForText("NVIM_LINE_1");
      session.writeRaw("j");
      await session.waitForText("NVIM_LINE_2");
      session.writeRaw(":q!\r");
      await session.waitForText("before.txt ↔ after.txt");
      await session.press("?");
      await session.waitForText("Controls help");
      await session.press("escape");
      await session.press("q");
    } finally {
      session.close();
    }
  },
  30_000,
);

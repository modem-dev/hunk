import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give source loading and asynchronous Shiki highlighting enough headroom in CI. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/** Create a contiguous added TypeScript file large enough to use the highlight worker. */
function createLargeHighlightTestFiles() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-highlight-worker-"));
  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  const contents = Array.from(
    { length: 8_000 },
    (_, index) => `export const workerLine${index} = ${index};`,
  ).join("\n");
  writeFileSync(before, "");
  writeFileSync(after, `${contents}\n`);
  return { after, before, dir };
}

/** Return generated worker-line indexes visible in one PTY snapshot. */
function visibleWorkerLineIndexes(snapshot: string) {
  return Array.from(snapshot.matchAll(/workerLine(\d+)/g), (match) => Number(match[1]));
}

describe("PTY syntax highlighting", () => {
  test("keeps key input responsive while a large added file highlights", async () => {
    const fixture = createLargeHighlightTestFiles();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--fast", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      const initial = await session.waitForText(/export const workerLine\d+ = \d+;/, {
        timeout: 15_000,
      });
      const lastInitialLineIndex = Math.max(...visibleWorkerLineIndexes(initial));
      expect(lastInitialLineIndex).toBeGreaterThanOrEqual(0);

      // Effects schedule highlighting after the first plain-text paint. Inject input as soon as
      // source rows make that paint observable, then require Hunk to process the navigation.
      // Tuistory's press() waits up to 500ms for idleness, so observe the viewport instead.
      session.sendKey("pagedown");
      await harness.waitForSnapshot(
        session,
        (snapshot) =>
          visibleWorkerLineIndexes(snapshot).some((index) => index > lastInitialLineIndex),
        1_000,
      );

      let colored = "";
      for (let iteration = 0; iteration < 200; iteration += 1) {
        await session.waitIdle({ timeout: 50 });
        colored = await session.text({ immediate: true, only: { foreground: "#ff7b72" } });
        if (colored.includes("export")) {
          break;
        }
      }
      expect(colored).toContain("export");
    } finally {
      session.close();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("keeps code after a hidden Elixir heredoc opener out of the string token state", async () => {
    const fixture = harness.createElixirHeredocRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 100,
      rows: 24,
    });

    try {
      await session.waitForText(/Line five, edited/, { timeout: 15_000 });

      let keywords = "";
      let comments = "";
      for (let iteration = 0; iteration < 200; iteration += 1) {
        await session.waitIdle({ timeout: 50 });
        keywords = await session.text({ immediate: true, only: { foreground: "#ff7b72" } });
        comments = await session.text({ immediate: true, only: { foreground: "#8b949e" } });
        if (keywords.includes("def") && comments.includes("Line five, edited.")) {
          break;
        }
      }

      expect(keywords).toContain("def");
      expect(comments).toContain("Line five, edited.");
      expect(comments).toContain('"""');
      expect(
        await session.text({ immediate: true, only: { foreground: "#a5d6ff" } }),
      ).not.toContain("def hello");
    } finally {
      session.close();
    }
  });
});

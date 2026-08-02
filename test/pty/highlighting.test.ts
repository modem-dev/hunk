import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give source loading and asynchronous Shiki highlighting enough headroom in CI. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY syntax highlighting", () => {
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

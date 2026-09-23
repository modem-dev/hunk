import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "tuistory";
import { resolveTheme } from "../../packages/hunk/src/ui/themes";
import { createPtyHarness, lineIndexOf } from "./harness";

/**
 * The bundled `/` content search in a real terminal: the prompt opens on the
 * status row, Enter lands the matching line near the viewport top, `n` / `N`
 * step and wrap, the landed match carries the inverted current mark, Tab still
 * reaches the file filter, and the documented remap hands `/` back to it.
 */

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

/** The last non-blank terminal row, where the status line paints. */
function statusRow(text: string) {
  return text.trimEnd().split("\n").at(-1) ?? "";
}

/** The background painted under the first `needle` cell on the terminal row that shows it. */
function backgroundUnder(session: Session, needle: string) {
  for (const line of session.getTerminalData().lines) {
    const text = line.spans.map((span) => span.text).join("");
    const column = text.indexOf(needle);
    if (column === -1) {
      continue;
    }
    return line.spans.flatMap((span) => [...span.text].map(() => span.bg))[column]?.toLowerCase();
  }
  return undefined;
}

describe("PTY content search", () => {
  test("/ searches, Enter reveals the match, and n / N step through the review", async () => {
    const fixture = harness.createSearchRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "unified"],
      cwd: fixture.dir,
      cols: 120,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      // The second match sits below the fold, so a landing there has to scroll.
      expect(initial).toContain('readConfig("first")');
      expect(initial).not.toContain('readConfig("second")');
      await harness.ensureKeyboardIsLive(session);

      await session.type("/");
      await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).trimStart().startsWith("/ search diff"),
        5_000,
      );
      await session.type("readconfig");
      await harness.waitForSnapshot(session, (text) => text.includes("/ readconfig"), 5_000);
      await session.press("enter");

      // Strictly forward from the current hunk (alpha's first), so the first
      // landing is alpha's second hunk, revealed a little below the top edge.
      const landed = await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).includes("[2/3] alpha.ts:62"),
        5_000,
      );
      expect(landed).toContain('— const bottom = readConfig("second");');
      const row = lineIndexOf(landed, 'readConfig("second")');
      expect(row).toBeGreaterThan(1);
      expect(row).toBeLessThan(8);

      // The landed match is painted with the inverted "current" mark — the
      // theme's text color as background — while the other matches carry a
      // tinted mark. Marks are prepared after the landing paints, so poll.
      const theme = resolveTheme("auto", "dark");
      await harness.waitForSnapshot(
        session,
        () => backgroundUnder(session, 'readConfig("second")') === theme.text.toLowerCase(),
        5_000,
      );
      expect(backgroundUnder(session, 'readConfig("third")')).not.toBe(theme.text.toLowerCase());
      expect(backgroundUnder(session, 'readConfig("third")')).not.toBe(
        backgroundUnder(session, 'other = readConfig("third")'),
      );

      await session.press("n");
      await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).includes("[3/3] beta.ts:1"),
        5_000,
      );
      await session.press("n");
      const wrapped = await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).includes("[1/3] alpha.ts:1"),
        5_000,
      );
      expect(statusRow(wrapped)).toContain("wrapped");
      expect(lineIndexOf(wrapped, 'readConfig("first")')).toBeLessThan(8);

      await session.type("N");
      await harness.waitForSnapshot(
        session,
        (text) =>
          statusRow(text).includes("[3/3] beta.ts:1") && statusRow(text).includes("wrapped"),
        5_000,
      );

      // Tab still opens the file filter beside the persistent search item.
      await session.press("tab");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("filter: type to filter files"),
        5_000,
      );
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("filter: type to filter files"),
        5_000,
      );
    } finally {
      session.close();
    }
  });

  test("repeated occurrences on the landed line each carry a mark", async () => {
    const fixture = harness.createSearchRepoFixture();
    writeFileSync(
      join(fixture.dir, "beta.ts"),
      'const pair = needle("first") + needle("second");\n',
    );
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "unified"],
      cwd: fixture.dir,
      cols: 120,
      rows: 14,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await harness.ensureKeyboardIsLive(session);
      await session.type("/");
      await harness.waitForSnapshot(session, (text) => text.includes("/ search diff"), 5_000);
      await session.type("needle");
      await session.press("enter");
      await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).includes("[1/1] beta.ts:1"),
        5_000,
      );

      const theme = resolveTheme("auto", "dark");
      await harness.waitForSnapshot(
        session,
        () => backgroundUnder(session, 'needle("first")') === theme.text.toLowerCase(),
        5_000,
      );
      const laterBackground = backgroundUnder(session, 'needle("second")');
      expect(laterBackground).toBeDefined();
      expect(laterBackground).not.toBe(theme.text.toLowerCase());
      expect(laterBackground).not.toBe(backgroundUnder(session, "pair ="));
    } finally {
      session.close();
    }
  });

  test("an empty query is refused, escape keeps the search, and the emptied prompt clears it", async () => {
    const fixture = harness.createSearchRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "unified"],
      cwd: fixture.dir,
      cols: 120,
      rows: 14,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await harness.ensureKeyboardIsLive(session);

      await session.press("n");
      await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).includes("No search yet — press / to search"),
        5_000,
      );

      await session.type("/");
      await harness.waitForSnapshot(session, (text) => text.includes("/ search diff"), 5_000);
      await session.type("zzz");
      await session.press("enter");
      await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).includes('No match for "zzz"'),
        5_000,
      );

      // Reopen: the last query is prefilled; Escape clears it, Escape again cancels
      // and leaves the last report in place.
      await session.type("/");
      await harness.waitForSnapshot(session, (text) => text.includes("/ zzz"), 5_000);
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => text.includes("/ search diff"), 5_000);
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).includes('No match for "zzz"'),
        5_000,
      );

      // Escape then Enter submits the emptied prompt, which ends the search.
      await session.type("/");
      await harness.waitForSnapshot(session, (text) => text.includes("/ zzz"), 5_000);
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => text.includes("/ search diff"), 5_000);
      await session.press("enter");
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("No match") && !text.includes("/ search diff"),
        5_000,
      );
      await session.press("n");
      await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).includes("No search yet"),
        5_000,
      );
    } finally {
      session.close();
    }
  });

  test("remapping the filter onto / takes the key back from search", async () => {
    const configHome = harness.createIsolatedConfigHome();
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    writeFileSync(
      join(configHome, "hunk", "config.toml"),
      '[keybindings]\n"hunk.review.focusFilter" = "/"\n',
    );
    const fixture = harness.createSearchRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "unified"],
      cwd: fixture.dir,
      cols: 120,
      rows: 14,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      // An exclusive user binding is not a conflict: no warning names the bundled command.
      expect(initial).not.toContain("hunk.search.find");
      await harness.ensureKeyboardIsLive(session);

      await session.type("/");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("filter: type to filter files"),
        5_000,
      );
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("filter: type to filter files"),
        5_000,
      );

      // Search kept `n` / `N` and is still reachable from the Navigate menu.
      await session.press("n");
      await harness.waitForSnapshot(
        session,
        (text) => statusRow(text).includes("No search yet"),
        5_000,
      );
    } finally {
      session.close();
    }
  });
});

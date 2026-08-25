import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_DARK_THEME_ID, resolveTheme } from "../../src/ui/themes";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const theme = resolveTheme(DEFAULT_DARK_THEME_ID, "dark");

setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/**
 * Moved-line tinting is asserted through the rendered screen rather than at the row model or
 * the palette helper because both of those stayed correct while the wrapped renderer painted
 * moved rows as ordinary additions and deletions. Wrapping and layout are covered as a matrix
 * for the same reason: each combination reaches the palette through its own cell builder.
 */
describe("PTY moved-line coloring", () => {
  for (const layout of ["stack", "split"] as const) {
    for (const wrap of ["--wrap", "--no-wrap"] as const) {
      test(`tints moved rows apart from ordinary added rows in ${layout} with ${wrap}`, async () => {
        const fixture = harness.createMovedLinesRepoFixture();
        const session = await harness.launchHunk({
          args: ["diff", "--mode", layout, wrap],
          cwd: fixture.dir,
          cols: 160,
          rows: 40,
        });

        try {
          await session.waitForText(/MOVED BLOCK ALPHA/, { timeout: 15_000 });

          const movedTinted = await session.text({
            immediate: true,
            only: { background: theme.movedAddedBg },
          });
          const addedTinted = await session.text({
            immediate: true,
            only: { background: theme.addedBg },
          });
          const removedTinted = await session.text({
            immediate: true,
            only: { background: theme.removedBg },
          });

          // Both sides of the move carry the moved tint: the deletion in source.txt and the
          // addition in destination.txt.
          for (const line of fixture.movedBlock) {
            expect(movedTinted).toContain(line);
          }
          expect(addedTinted).not.toContain("MOVED BLOCK");
          expect(removedTinted).not.toContain("MOVED BLOCK");

          // A genuinely new line in the same diff still paints as an ordinary addition.
          expect(addedTinted).toContain(fixture.plainAddition);
          expect(movedTinted).not.toContain(fixture.plainAddition);
        } finally {
          session.close();
        }
      });
    }
  }
});

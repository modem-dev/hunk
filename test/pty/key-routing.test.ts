import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness, lineIndexOf, sleep } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/**
 * Key-ownership routing across the global handler chain and the focused widget.
 *
 * OpenTUI runs Hunk's global key handler before the focused renderable, so a
 * global handler that acts on a key without consuming it lets the focused
 * widget act on the same key a second time. Each test here pins one
 * user-visible consequence of that double-handling — or one deliberate
 * fallthrough that must keep working.
 *
 * Pager mode is where the focused-widget half of this is directly reachable:
 * the review scroll box is focused there by design, and since pager gained the
 * full review controls it also has menus and the theme selector. Review mode's
 * equivalents are covered in `src/ui/AppHost.key-routing.test.tsx`, which hands
 * the scroll box focus directly.
 */
describe("PTY key routing", () => {
  test("one Escape closes the help overlay without wiping typed filter text", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      // Open the help overlay first, then focus the filter and type into it
      // behind the overlay.
      await session.press("?");
      await session.waitForText(/Controls help/, { timeout: 5_000 });

      await session.press("/");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("filter: type to filter files"),
        5_000,
      );
      await session.type("beta");
      await harness.waitForSnapshot(session, (text) => text.includes("filter: beta"), 5_000);

      // One Escape must close the overlay and do nothing else. The overlay
      // handler owns the key; the filter input must never see it.
      await session.press("escape");
      const afterEscape = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Controls help"),
        5_000,
      );

      expect(afterEscape).toContain("filter: beta");
      expect(afterEscape).not.toContain("filter: type to filter files");
    } finally {
      session.close();
    }
  });

  test("Enter on a menu item does not also submit the focused filter", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).toMatch(/▌.*▌/);

      // Focus the filter and narrow to one file so the filter is visibly live.
      await session.press("/");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("filter: type to filter files"),
        5_000,
      );
      await session.type("beta");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("filter: beta") && !text.includes("alpha.ts"),
        5_000,
      );

      // Open the menu bar and pick "Stacked view" from the View menu with Enter.
      await session.press("f10");
      await session.waitForText(/Reload/, { timeout: 5_000 });
      await session.press("right");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("Split view") && text.includes("Stacked view"),
        5_000,
      );
      await session.press("down");
      await session.press("enter");

      // The menu item must run (layout switches to stacked) and the Enter must
      // stop there: the filter keeps focus and its text instead of submitting.
      const afterEnter = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && text.includes("-  export const beta = 1;"),
        5_000,
      );

      expect(afterEnter).toContain("filter: beta");
      expect(afterEnter).not.toContain("filter=beta");
    } finally {
      session.close();
    }
  });

  test("F10 does not open the menu bar while a note draft is focused", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });

      // The note composer owns the keyboard; F10 must not pop the menu bar
      // over an in-progress draft.
      await session.press("f10");
      await sleep(400);
      const afterF10 = await session.text({ immediate: true });
      expect(afterF10).not.toContain("Reload");
      expect(afterF10).toContain("Draft note");

      // The draft is still focused and still accepts text.
      await session.type("menu stays closed");
      const typed = await session.waitForText(/menu stays closed/, { timeout: 5_000 });
      expect(typed).toContain("menu stays closed");
    } finally {
      session.close();
    }
  });

  test("menu arrows do not scroll the pager stream behind an open menu", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/scroll\.ts/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      // Pager focuses the review scroll box, so every key the global chain
      // leaves unconsumed also reaches the scroll box's own arrow scrolling.
      await session.press("f10");
      const menuOpen = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Quit"),
        5_000,
      );

      const anchorRow = 20;
      const anchorText = menuOpen.split("\n")[anchorRow]?.trim() ?? "";
      expect(anchorText.length).toBeGreaterThan(0);

      for (let press = 0; press < 3; press += 1) {
        await session.press("down");
        await session.waitIdle({ timeout: 300 });
      }

      const afterArrows = await session.text({ immediate: true });
      expect(lineIndexOf(afterArrows, anchorText)).toBe(anchorRow);
    } finally {
      session.close();
    }
  });

  test("the theme selector uses vertical review keys without scrolling the pager stream", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/scroll\.ts/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      await session.press("t");
      const selectorOpen = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Theme selector"),
        5_000,
      );

      const anchorRow = 20;
      const anchorText = selectorOpen.split("\n")[anchorRow]?.trim() ?? "";
      expect(anchorText.length).toBeGreaterThan(0);

      // The review's down key moves the selector and must not reach the focused scroll box.
      await session.press("j");
      await session.waitIdle({ timeout: 400 });

      const selectedBefore = selectorOpen.split("\n").find((line) => line.includes("›"));
      const afterKey = await session.text({ immediate: true });
      const selectedAfter = afterKey.split("\n").find((line) => line.includes("›"));
      expect(lineIndexOf(afterKey, anchorText)).toBe(anchorRow);
      expect(afterKey).toContain("Theme selector");
      expect(selectedAfter).not.toBe(selectedBefore);
    } finally {
      session.close();
    }
  });

  test("menu accelerators still fall through: ? opens help and closes the menu", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["show", "HEAD"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      await session.press("f10");
      await session.waitForText(/Reload/, { timeout: 5_000 });

      // An open menu is deliberately not fully modal: keys the menu does not
      // use keep falling through to the command table.
      await session.press("?");
      const help = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Controls help"),
        5_000,
      );

      expect(help).not.toContain("Reload");
    } finally {
      session.close();
    }
  });

  test("vertical review keys move an open menu without scrolling the stream", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["show", "HEAD", "--cursor-line", "off"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      await session.press("f10");
      const menuOpen = await session.waitForText(/Reload/, { timeout: 5_000 });

      const anchorRow = 20;
      const anchorText = menuOpen.split("\n")[anchorRow]?.trim() ?? "";
      expect(anchorText.length).toBeGreaterThan(0);

      await session.press("j");
      await session.waitIdle({ timeout: 300 });

      const afterKey = await session.text({ immediate: true });
      expect(lineIndexOf(afterKey, anchorText)).toBe(anchorRow);
    } finally {
      session.close();
    }
  });
});

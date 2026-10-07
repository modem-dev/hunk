import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { UserKeyBinding } from "../../core/run/config";
import { ThemeController } from "../theme/controller";
import { availableThemes } from "../themes";
import { DocumentApp } from "./DocumentApp";
import { DocumentBrowserController } from "./controller";

/** Mount real document chrome with independently observable source capabilities. */
async function createTestKeyboardApp(keybindings: Record<string, UserKeyBinding> = {}) {
  const edit = mock(async () => null);
  const list = mock(async () => ({
    kind: "entries" as const,
    entries: [
      { key: "a", name: "a.txt", kind: "file" as const, hidden: false },
      { key: "b", name: "b.txt", kind: "file" as const, hidden: false },
    ],
  }));
  const controller = new DocumentBrowserController({
    root: { key: "root", name: "Collection", kind: "directory", hidden: false },
    list,
    async read(key) {
      return {
        kind: "text",
        text: Array.from({ length: 100 }, (_, index) => `${key} ROW ${index + 1}`).join("\n"),
        identity: key,
      };
    },
    edit,
  });
  await controller.initialize();
  await controller.select("a");
  const themeController = new ThemeController({ initialTheme: "github-dark-default" });
  const quit = mock(() => undefined);
  const setup = await testRender(
    <DocumentApp
      controller={controller}
      themeController={themeController}
      options={{}}
      keybindings={keybindings}
      onQuit={quit}
    />,
    { width: 90, height: 20 },
  );
  await act(async () => setup.renderOnce());

  /** Deliver several decoded keys without allowing a React render between them. */
  const burst = async (...keys: string[]) => {
    await act(async () => {
      const sequences: Record<string, string> = {
        tab: "\t",
        down: "\x1b[B",
        up: "\x1b[A",
        right: "\x1b[C",
        left: "\x1b[D",
        return: "\r",
        escape: "\x1b[27u",
        f10: "\x1b[21~",
      };
      for (const key of keys) setup.mockInput.pressKey(sequences[key] ?? key);
      await Bun.sleep(20);
    });
    await act(async () => setup.renderOnce());
  };

  /** Click the actual rendered menu entry so pointer and shortcut tests share command effects. */
  const clickMenuItem = async (label: string) => {
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(label));
    if (y < 0) throw new Error(`Missing menu entry: ${label}`);
    const x = lines[y]!.indexOf(label);
    await act(async () => {
      await setup.mockMouse.click(x + 1, y);
      await Bun.sleep(20);
    });
    await act(async () => setup.renderOnce());
  };

  /** Dispose mounted UI and source work even if a burst assertion fails. */
  const close = async () => {
    await act(async () => setup.renderer.destroy());
    await controller.close();
  };

  return { setup, controller, themeController, edit, list, quit, burst, clickMenuItem, close };
}

test("content clicks dismiss menus and route the next key to the document or tree", async () => {
  const app = await createTestKeyboardApp();

  try {
    await app.burst("f10");
    expect(app.setup.captureCharFrame()).toContain("Refresh documents");
    await act(async () => {
      await app.setup.mockMouse.click(55, 8);
      app.setup.mockInput.pressArrow("down");
      app.setup.mockInput.pressKey("\r");
      await Bun.sleep(20);
    });
    await act(async () => app.setup.renderOnce());
    expect(app.setup.captureCharFrame()).not.toContain("Refresh documents");
    expect(app.setup.captureCharFrame()).toContain("Document ·");
    expect(app.controller.getSnapshot().selectedKey).toBe("a");
    expect(app.edit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    // Help's dropdown leaves the tree's left edge uncovered for a genuine outside click.
    await app.burst("f10", "right", "right");
    expect(app.setup.captureCharFrame()).toContain("Controls help");
    await act(async () => {
      await app.setup.mockMouse.click(2, 2);
      app.setup.mockInput.pressArrow("down");
      await Bun.sleep(20);
    });
    await act(async () => app.setup.renderOnce());
    expect(app.setup.captureCharFrame()).not.toContain("Controls help");
    expect(app.controller.getSnapshot().selectedKey).toBe("b");
    expect(app.setup.captureCharFrame()).toContain("Tree ·");
  } finally {
    await app.close();
  }
});

test("help owns later keys in its opening burst and releases them in its closing burst", async () => {
  const app = await createTestKeyboardApp();
  try {
    await app.burst("?", "e", "q", "down");
    expect(app.setup.captureCharFrame()).toContain("Controls help");
    expect(app.edit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.controller.getSnapshot().selectedKey).toBe("a");

    await app.burst("?", "e");
    expect(app.setup.captureCharFrame()).not.toContain("Controls help");
    expect(app.edit).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

test("focus and sidebar changes route subsequent movement to the live surface", async () => {
  const app = await createTestKeyboardApp();
  try {
    await app.burst("tab", "down");
    expect(app.controller.getSnapshot().selectedKey).toBe("a");
    expect(app.setup.captureCharFrame()).not.toMatch(/a ROW 1\s*$/m);
    expect(app.setup.captureCharFrame()).toContain("a ROW 2");

    await app.burst("tab", "down");
    expect(app.controller.getSnapshot().selectedKey).toBe("b");
    await app.burst("s", "g");
    expect(app.controller.getSnapshot().selectedKey).toBe("b");
    await app.burst("s", "g");
    expect(app.controller.getSnapshot().selectedKey).toBe("root");
  } finally {
    await app.close();
  }
});

test("theme opening, acceptance and cancellation update modal ownership within a burst", async () => {
  const app = await createTestKeyboardApp();
  try {
    await app.burst("t", "down", "e", "q");
    expect(app.edit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.controller.getSnapshot().selectedKey).toBe("a");
    const themes = availableThemes([], null);
    const initialIndex = themes.findIndex((theme) => theme.id === "github-dark-default");
    await app.burst("return", "e");
    expect(app.themeController.getSnapshot().themeId).toBe(
      themes[(initialIndex + 1) % themes.length]!.id,
    );
    expect(app.edit).toHaveBeenCalledTimes(1);

    await app.burst("t", "escape", "e");
    expect(app.edit).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
  }
});

test("menu toggles and menu-launched themes use live ownership before a render", async () => {
  const app = await createTestKeyboardApp();
  try {
    await app.burst("f10", "f10", "e");
    expect(app.edit).toHaveBeenCalledTimes(1);
    await app.burst("f10", "right", "return", "e", "down", "return");
    expect(app.edit).toHaveBeenCalledTimes(1);
    expect(app.controller.getSnapshot().selectedKey).toBe("a");
    expect(app.themeController.getSnapshot().themeId).not.toBe("github-dark-default");
  } finally {
    await app.close();
  }
});

test("pointer focus and menu help actions share the keyboard's live state", async () => {
  const app = await createTestKeyboardApp();
  try {
    await act(async () => {
      await app.setup.mockMouse.click(55, 2);
      app.setup.mockInput.pressArrow("down");
    });
    expect(app.controller.getSnapshot().selectedKey).toBe("a");
    await app.burst("tab", "down");
    expect(app.controller.getSnapshot().selectedKey).toBe("b");

    await app.burst("f10", "right", "right", "return", "e");
    expect(app.setup.captureCharFrame()).toContain("Controls help");
    expect(app.edit).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test("advertised menu accelerators and pointer entries dispatch the same commands and close the menu", async () => {
  const app = await createTestKeyboardApp();
  try {
    const initialLists = app.list.mock.calls.length;
    await app.burst("f10", "r");
    expect(app.list).toHaveBeenCalledTimes(initialLists + 1);
    expect(app.setup.captureCharFrame()).not.toContain("Refresh documents");
    await app.burst("f10");
    await app.clickMenuItem("Refresh documents");
    expect(app.list).toHaveBeenCalledTimes(initialLists + 2);
    expect(app.setup.captureCharFrame()).not.toContain("Refresh documents");

    await app.burst("f10", "e");
    expect(app.edit).toHaveBeenCalledTimes(1);
    expect(app.setup.captureCharFrame()).not.toContain("Open file in $EDITOR");
    await app.burst("f10");
    await app.clickMenuItem("Open file in $EDITOR");
    expect(app.edit).toHaveBeenCalledTimes(2);
    expect(app.setup.captureCharFrame()).not.toContain("Open file in $EDITOR");

    await app.burst("f10", "q");
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.setup.captureCharFrame()).not.toContain("Refresh documents");
    await app.burst("f10");
    await app.clickMenuItem("Quit");
    expect(app.quit).toHaveBeenCalledTimes(2);
    expect(app.setup.captureCharFrame()).not.toContain("Refresh documents");
  } finally {
    await app.close();
  }
});

test("menu accelerators honor remaps while unrecognized keys leave the menu open", async () => {
  const app = await createTestKeyboardApp({
    "hunk.app.refresh": "x",
    "hunk.documents.edit": "o",
    "hunk.app.quit": "z",
  });
  try {
    const initialLists = app.list.mock.calls.length;
    await app.burst("f10", "r", "e", "q", "!");
    expect(app.list).toHaveBeenCalledTimes(initialLists);
    expect(app.edit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.setup.captureCharFrame()).toMatch(/Refresh documents\s+x/);
    expect(app.setup.captureCharFrame()).toMatch(/Open file in \$EDITOR\s+o/);
    expect(app.setup.captureCharFrame()).toMatch(/Quit\s+z/);

    await app.burst("x");
    expect(app.list).toHaveBeenCalledTimes(initialLists + 1);
    expect(app.setup.captureCharFrame()).not.toContain("Refresh documents");
    await app.burst("f10", "o");
    expect(app.edit).toHaveBeenCalledTimes(1);
    await app.burst("f10", "z");
    expect(app.quit).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

test("unbound menu commands remain callable by pointer or menu navigation but not their old keys", async () => {
  const app = await createTestKeyboardApp({
    "hunk.app.refresh": false,
    "hunk.documents.edit": false,
    "hunk.app.quit": false,
  });
  try {
    const initialLists = app.list.mock.calls.length;
    await app.burst("f10", "r", "e", "q");
    expect(app.list).toHaveBeenCalledTimes(initialLists);
    expect(app.edit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.setup.captureCharFrame()).toContain("Refresh documents");

    await app.burst("return");
    expect(app.list).toHaveBeenCalledTimes(initialLists + 1);
    await app.burst("f10", "down", "return");
    expect(app.edit).toHaveBeenCalledTimes(1);
    await app.burst("f10");
    await app.clickMenuItem("Quit");
    expect(app.quit).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

test("menu navigation owns arrows and Tab while help and themes still isolate command accelerators", async () => {
  const app = await createTestKeyboardApp();
  try {
    await app.burst("f10", "down", "return");
    expect(app.edit).toHaveBeenCalledTimes(1);
    expect(app.controller.getSnapshot().selectedKey).toBe("a");
    await app.burst("f10", "tab", "return", "e", "q");
    expect(app.setup.captureCharFrame()).toContain("Theme selector");
    expect(app.edit).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();

    await app.burst("escape", "f10", "?", "e", "q");
    expect(app.setup.captureCharFrame()).toContain("Controls help");
    expect(app.edit).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    await app.burst("?");
    expect(app.setup.captureCharFrame()).not.toContain("Refresh documents");
  } finally {
    await app.close();
  }
});

import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { AppMenus, MenuEntry } from "../components/chrome/menu";
import { useMenuController } from "./useMenuController";

/**
 * The controller's behavior when the menus record changes under an open menu —
 * the Extensions menu vanishes when a session reload drops the last registered
 * extension command, and the bar must not keep an invisible menu "open".
 */

function menuItem(label: string): MenuEntry {
  return { kind: "item", label, action: () => {} };
}

const BASE_MENUS: AppMenus = {
  file: [menuItem("Quit")],
  view: [menuItem("Sidebar")],
};

const MENUS_WITH_EXTENSIONS: AppMenus = {
  ...BASE_MENUS,
  extensions: [menuItem("Open the probe pane")],
};

describe("useMenuController", () => {
  test("treats an open menu as closed when its spec vanishes, without reopening on return", async () => {
    let controller!: ReturnType<typeof useMenuController>;
    let setMenus!: (menus: AppMenus) => void;

    function Probe({ initial }: { initial: AppMenus }) {
      const [menus, set] = useState(initial);
      setMenus = set;
      controller = useMenuController(menus);
      return null;
    }

    const setup = await testRender(<Probe initial={MENUS_WITH_EXTENSIONS} />, {
      width: 80,
      height: 24,
    });

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      await act(async () => {
        controller.openMenu("extensions");
      });
      expect(controller.activeMenuId).toBe("extensions");
      expect(controller.activeMenuSpec?.id).toBe("extensions");

      // The registry reload drops the extension commands: the open menu's spec
      // is gone, and the controller reports it closed rather than invisible.
      await act(async () => {
        setMenus(BASE_MENUS);
      });
      expect(controller.activeMenuId).toBeNull();
      expect(controller.activeMenuSpec).toBeUndefined();
      expect(controller.activeMenuEntries).toEqual([]);

      // Closed means really closed: the next toggle opens the menu it names
      // instead of dismissing a phantom, exactly what an F10 press goes through.
      await act(async () => {
        controller.toggleMenu("file");
      });
      expect(controller.activeMenuId).toBe("file");

      await act(async () => {
        controller.closeMenu();
      });

      // The Extensions menu coming back does not spring the dropdown back open:
      // the stale id was cleared, not merely masked.
      await act(async () => {
        setMenus(MENUS_WITH_EXTENSIONS);
      });
      expect(controller.activeMenuId).toBeNull();
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("re-anchors the highlight when an open menu's entries change", async () => {
    let controller!: ReturnType<typeof useMenuController>;
    let setMenus!: (menus: AppMenus) => void;
    const ran: string[] = [];
    const runItem = (label: string): MenuEntry => ({
      kind: "item",
      label,
      action: () => ran.push(label),
    });

    const longFileMenu: AppMenus = {
      file: [runItem("Focus"), runItem("Reload"), runItem("Quit")],
    };
    // "Reload" drops out and a separator lands where "Quit" used to sit.
    const shrunkFileMenu: AppMenus = {
      file: [runItem("Focus"), { kind: "separator" }, runItem("Quit")],
    };

    function Probe({ initial }: { initial: AppMenus }) {
      const [menus, set] = useState(initial);
      setMenus = set;
      controller = useMenuController(menus);
      return null;
    }

    const setup = await testRender(<Probe initial={longFileMenu} />, { width: 80, height: 24 });

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      await act(async () => {
        controller.openMenu("file");
      });
      await act(async () => {
        controller.moveMenuItem(1);
      });
      expect(controller.activeMenuItemIndex).toBe(1);

      // The stored index now points at the separator; the highlight resolves
      // to the nearest selectable item and Enter runs it instead of no-oping.
      await act(async () => {
        setMenus(shrunkFileMenu);
      });
      expect(controller.activeMenuItemIndex).toBe(2);
      await act(async () => {
        controller.activateCurrentMenuItem();
      });
      expect(ran).toEqual(["Quit"]);

      // An index past a shrunken list resolves back inside it.
      await act(async () => {
        controller.openMenu("file");
      });
      await act(async () => {
        controller.moveMenuItem(1);
      });
      expect(controller.activeMenuItemIndex).toBe(2);
      await act(async () => {
        setMenus({ file: [runItem("Focus")] });
      });
      expect(controller.activeMenuItemIndex).toBe(0);
      await act(async () => {
        controller.activateCurrentMenuItem();
      });
      expect(ran).toEqual(["Quit", "Focus"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("skips disabled entries and refuses direct activation", async () => {
    let controller!: ReturnType<typeof useMenuController>;
    const ran: string[] = [];
    const menus: AppMenus = {
      commit: [
        { kind: "item", label: "Root parent", disabled: true, action: () => ran.push("disabled") },
        { kind: "item", label: "Open diff", action: () => ran.push("open") },
      ],
    };

    function Probe() {
      controller = useMenuController(menus);
      return null;
    }

    const setup = await testRender(<Probe />, { width: 80, height: 24 });
    try {
      await act(async () => {
        await setup.renderOnce();
        controller.openMenu("commit");
      });
      expect(controller.activeMenuItemIndex).toBe(1);
      await act(async () => controller.activateCurrentMenuItem());
      expect(ran).toEqual(["open"]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("keeps rapid menu switch and activation sequential before a rerender", async () => {
    let controller!: ReturnType<typeof useMenuController>;
    const ran: string[] = [];
    const menus: AppMenus = {
      file: [{ kind: "item", label: "Open", action: () => ran.push("file") }],
      view: [{ kind: "item", label: "Theme", action: () => ran.push("view") }],
    };
    function Probe() {
      controller = useMenuController(menus);
      return null;
    }
    const setup = await testRender(<Probe />, { width: 80, height: 24 });
    try {
      await act(async () => setup.renderOnce());
      await act(async () => {
        controller.openMenu("file");
        controller.switchMenu(1);
        controller.activateCurrentMenuItem();
      });
      expect(ran).toEqual(["view"]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("cycling skips menus the session does not show", async () => {
    let controller!: ReturnType<typeof useMenuController>;

    function Probe() {
      controller = useMenuController(BASE_MENUS);
      return null;
    }

    const setup = await testRender(<Probe />, { width: 80, height: 24 });

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      await act(async () => {
        controller.openMenu("file");
      });
      await act(async () => {
        controller.switchMenu(1);
      });
      expect(controller.activeMenuId).toBe("view");

      // Wrapping from the last visible menu lands on the first visible one —
      // never on extensions or help, which this session does not show.
      await act(async () => {
        controller.switchMenu(1);
      });
      expect(controller.activeMenuId).toBe("file");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});

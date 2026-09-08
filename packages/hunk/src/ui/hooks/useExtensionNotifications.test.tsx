import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect } from "react";
import {
  createExtensionNotificationHub,
  type ExtensionNotificationHub,
} from "../../extensions/notifications";
import { useExtensionNotifications } from "./useExtensionNotifications";

const TOAST_DURATION_MS = 40;

/** Render the hook and record every active notification it hands back. */
function ToastHarness({
  hub,
  seen,
}: {
  hub: ExtensionNotificationHub;
  seen: Array<string | null>;
}) {
  const active = useExtensionNotifications(hub, { durationMs: TOAST_DURATION_MS });

  useEffect(() => {
    seen.push(active?.message ?? null);
  }, [active, seen]);

  return (
    <box>
      <text>{active?.message ?? ""}</text>
    </box>
  );
}

describe("useExtensionNotifications", () => {
  test("shows buffered notifications one at a time and retires each by id", async () => {
    const hub = createExtensionNotificationHub();
    // Notified before the UI subscribed, exactly like a `startup` handler.
    hub.notify("first");
    hub.notify("second");
    const seen: Array<string | null> = [];

    const setup = await testRender(<ToastHarness hub={hub} seen={seen} />, {
      width: 60,
      height: 4,
    });

    /** Let the toast timers run, then repaint with whatever state they produced. */
    const settle = async (ms: number) => {
      await act(async () => {
        await Bun.sleep(ms);
      });
      await act(async () => {
        await setup.renderOnce();
      });
    };

    try {
      await settle(0);
      expect(setup.captureCharFrame()).toContain("first");

      await settle(TOAST_DURATION_MS + 20);
      expect(setup.captureCharFrame()).toContain("second");

      await settle(TOAST_DURATION_MS + 20);
      expect(setup.captureCharFrame()).not.toContain("second");
      // The leading null is the mount render, before the buffered flush lands.
      expect(seen).toEqual([null, "first", "second", null]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a notification that arrives mid-window is not retired by the running timer", async () => {
    const hub = createExtensionNotificationHub();
    hub.notify("first");
    const seen: Array<string | null> = [];

    const setup = await testRender(<ToastHarness hub={hub} seen={seen} />, {
      width: 60,
      height: 4,
    });

    try {
      await act(async () => {
        // Arrives while the first toast's dismissal timer is already armed.
        await Bun.sleep(TOAST_DURATION_MS / 2);
        hub.notify("second");
      });
      await act(async () => {
        await Bun.sleep(TOAST_DURATION_MS);
      });
      await act(async () => {
        await setup.renderOnce();
      });

      // Dismissal drops the notification the timer was armed for, by id, so the
      // one that arrived mid-window still gets its own full window.
      expect(setup.captureCharFrame()).toContain("second");
      expect(seen).toEqual([null, "first", "second"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});

import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { useExtensionAppController } from "./useExtensionAppController";

/** Build one renderer identity whose terminal ownership can outlive hook mounts. */
function createTestAppRenderer() {
  return {
    destroyed: false,
    resume: mock(() => {}),
    suspend: mock(() => {}),
    renderer: null as unknown as {
      readonly isDestroyed: boolean;
      resume: () => void;
      suspend: () => void;
    },
  };
}

/** Mount app controls with mutable review authority and a traced renderer. */
async function renderController(appRenderer = createTestAppRenderer()) {
  let live = true;
  let controller!: ReturnType<typeof useExtensionAppController>;
  appRenderer.renderer ||= {
    get isDestroyed() {
      return appRenderer.destroyed;
    },
    suspend: appRenderer.suspend,
    resume: appRenderer.resume,
  };

  function Harness() {
    controller = useExtensionAppController({
      createReviewCapabilityLease: () => ({ isLive: () => live }),
      renderer: appRenderer.renderer,
    });
    return null;
  }

  const setup = await testRender(<Harness />, { width: 20, height: 2 });
  await act(async () => setup.renderOnce());
  return {
    controller: () => controller,
    destroyRenderer: () => {
      appRenderer.destroyed = true;
    },
    resume: appRenderer.resume,
    retire: () => {
      live = false;
    },
    setup,
    suspend: appRenderer.suspend,
  };
}

describe("useExtensionAppController", () => {
  test("suspends around extension work and passes its result through", async () => {
    const harness = await renderController();
    const openInApp = harness.controller().createOpenInApp();
    const calls: string[] = [];

    try {
      await expect(
        openInApp(async () => {
          calls.push("app");
          return 42;
        }),
      ).resolves.toBe(42);
      expect(calls).toEqual(["app"]);
      expect(harness.suspend).toHaveBeenCalledTimes(1);
      expect(harness.resume).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("restores after application failures without replacing their error", async () => {
    const harness = await renderController();
    const openInApp = harness.controller().createOpenInApp();
    const failure = new Error("app failed");

    try {
      await expect(
        openInApp(() => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(harness.resume).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("refuses stale and concurrent handoffs before invoking extension code", async () => {
    const harness = await renderController();
    const stale = harness.controller().createOpenInApp();
    harness.retire();

    try {
      let staleRuns = 0;
      await expect(
        stale(() => {
          staleRuns += 1;
        }),
      ).rejects.toThrow("after the review reloads");
      expect(staleRuns).toBe(0);

      const currentHarness = await renderController();
      try {
        let finish!: () => void;
        const waiting = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const first = currentHarness.controller().createOpenInApp();
        const second = currentHarness.controller().createOpenInApp();
        const active = first(async () => await waiting);
        await expect(second(() => "never")).rejects.toThrow("another application owns");
        finish();
        await active;
      } finally {
        await act(async () => currentHarness.setup.renderer.destroy());
      }
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("keeps terminal ownership across controller remounts", async () => {
    const renderer = createTestAppRenderer();
    const firstHarness = await renderController(renderer);
    const secondHarness = await renderController(renderer);
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });

    try {
      const active = firstHarness.controller().createOpenInApp()(async () => await waiting);
      await expect(secondHarness.controller().createOpenInApp()(() => "never")).rejects.toThrow(
        "another application owns",
      );
      finish();
      await active;
      expect(renderer.suspend).toHaveBeenCalledTimes(1);
      expect(renderer.resume).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => firstHarness.setup.renderer.destroy());
      await act(async () => secondHarness.setup.renderer.destroy());
    }
  });

  test("does not resume a renderer destroyed while the app owns the terminal", async () => {
    const harness = await renderController();
    const openInApp = harness.controller().createOpenInApp();

    try {
      await openInApp(() => harness.destroyRenderer());
      expect(harness.resume).not.toHaveBeenCalled();
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("does not replace the application's result when renderer restoration fails", async () => {
    let controller!: ReturnType<typeof useExtensionAppController>;
    function Harness() {
      controller = useExtensionAppController({
        createReviewCapabilityLease: () => ({ isLive: () => true }),
        renderer: {
          isDestroyed: false,
          suspend: () => {},
          resume: () => {
            throw new Error("resume failed");
          },
        },
      });
      return null;
    }
    const setup = await testRender(<Harness />, { width: 20, height: 2 });
    await act(async () => setup.renderOnce());
    const originalError = console.error;
    console.error = mock(() => {});
    try {
      await expect(controller.createOpenInApp()(() => "app result")).resolves.toBe("app result");
      expect(console.error).toHaveBeenCalled();
    } finally {
      console.error = originalError;
      await act(async () => setup.renderer.destroy());
    }
  });
});

import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { useExtensionDialogController } from "./useExtensionDialogController";

/** Mount the controller with a replaceable review-generation token. */
async function renderController() {
  let controller!: ReturnType<typeof useExtensionDialogController>;
  let replaceReview!: () => void;

  function Harness() {
    const [reviewGeneration, setReviewGeneration] = useState<object>({});
    replaceReview = () => setReviewGeneration({});
    controller = useExtensionDialogController({ reviewGeneration });
    return null;
  }

  const setup = await testRender(<Harness />, { width: 40, height: 4 });
  await act(async () => setup.renderOnce());
  return {
    setup,
    controller: () => controller,
    replaceReview: () => replaceReview(),
  };
}

/** Flush React state and external-store updates into the hook harness. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderOnce());
}

describe("useExtensionDialogController", () => {
  test("answers select and input requests while resetting each promoted request", async () => {
    const harness = await renderController();
    const dialogs = harness.controller().createDialogs("probe");
    let selected!: Promise<string | null>;
    let typed!: Promise<string | null>;

    try {
      await act(async () => {
        selected = dialogs.select({ title: "Target?", options: ["one", "two", "three"] });
        typed = dialogs.input({ title: "Branch?", initial: "feature/base" });
      });
      await flush(harness.setup);

      expect(harness.controller().request).toMatchObject({ kind: "select", title: "Target?" });
      expect(harness.controller().selectedIndex).toBe(0);

      await act(async () => harness.controller().moveSelection(-1));
      expect(harness.controller().selectedIndex).toBe(2);

      await act(async () => harness.controller().accept());
      expect(await selected).toBe("three");
      await flush(harness.setup);

      expect(harness.controller().request).toMatchObject({ kind: "input", title: "Branch?" });
      expect(harness.controller().selectedIndex).toBe(0);
      expect(harness.controller().inputValue).toBe("feature/base");

      await act(async () => harness.controller().updateInput("feature/typed"));
      await act(async () => harness.controller().accept());
      expect(await typed).toBe("feature/typed");
      await flush(harness.setup);
      expect(harness.controller().request).toBeNull();
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("cancels pending requests when a soft reload replaces the review", async () => {
    const harness = await renderController();
    const dialogs = harness.controller().createDialogs("probe");
    let confirmed!: Promise<boolean>;
    let typed!: Promise<string | null>;

    try {
      await act(async () => {
        confirmed = dialogs.confirm({ title: "Still relevant?" });
        typed = dialogs.input({ title: "Queued behind it" });
      });
      await flush(harness.setup);
      expect(harness.controller().request).toMatchObject({ title: "Still relevant?" });

      await act(async () => harness.replaceReview());
      await flush(harness.setup);

      expect(await confirmed).toBe(false);
      expect(await typed).toBeNull();
      expect(harness.controller().request).toBeNull();

      // Reload cancellation drains but does not close the queue for the replacement review.
      let afterReload!: Promise<boolean>;
      await act(async () => {
        afterReload = dialogs.confirm({ title: "New review?" });
      });
      await flush(harness.setup);
      await act(async () => harness.controller().accept());
      expect(await afterReload).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("shuts down the queue on unmount", async () => {
    const harness = await renderController();
    const dialogs = harness.controller().createDialogs("probe");
    let confirmed!: Promise<boolean>;
    let selected!: Promise<string | null>;
    await act(async () => {
      confirmed = dialogs.confirm({ title: "Open?" });
      selected = dialogs.select({ title: "Queued?", options: ["one"] });
    });

    await act(async () => harness.setup.renderer.destroy());

    expect(await confirmed).toBe(false);
    expect(await selected).toBeNull();
    expect(await dialogs.input({ title: "Too late?" })).toBeNull();
  });
});

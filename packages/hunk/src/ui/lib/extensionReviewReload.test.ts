import { describe, expect, mock, test } from "bun:test";
import { createExtensionReviewReloadControls } from "./extensionReviewReload";

describe("createExtensionReviewReloadControls", () => {
  test("forwards a live request and preserves the host result", async () => {
    const result = { ok: true } as const;
    const requestReload = mock(async () => result);
    const controls = createExtensionReviewReloadControls({
      isLive: () => true,
      requestReload,
    });

    await expect(controls.requestReload()).resolves.toBe(result);
    expect(requestReload).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(controls)).toBe(true);
  });

  test("refuses an expired review without starting host work", async () => {
    const requestReload = mock(async () => ({ ok: true }) as const);
    const controls = createExtensionReviewReloadControls({
      isLive: () => false,
      requestReload,
    });

    await expect(controls.requestReload()).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      detail: "This review reload request is no longer current.",
    });
    expect(requestReload).not.toHaveBeenCalled();
  });
});

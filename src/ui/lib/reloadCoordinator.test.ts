import { describe, expect, test } from "bun:test";
import { WATCH_CHECK_CANCELLED_CODE } from "../../core/watchController";
import { createSessionReloadCoordinator } from "./reloadCoordinator";

/** Assert that a reload operation was silently superseded. */
function expectSuperseded(run: () => unknown) {
  try {
    run();
    throw new Error("Expected the reload to be superseded.");
  } catch (error) {
    expect(error).toMatchObject({
      name: "AbortError",
      code: WATCH_CHECK_CANCELLED_CODE,
    });
  }
}

describe("createSessionReloadCoordinator", () => {
  test("rejects watch events owned by retired content", () => {
    const coordinator = createSessionReloadCoordinator();
    const initial = coordinator.begin({ reason: "manual" });
    initial.publishContent(() => {});
    initial.finish();

    expectSuperseded(() => coordinator.begin({ reason: "watch", watchContentGeneration: 0 }));
    coordinator.begin({ reason: "watch", watchContentGeneration: 1 }).finish();
  });

  test("prevents watch retries from superseding an authoritative reload", () => {
    const coordinator = createSessionReloadCoordinator();
    const watch = coordinator.begin({ reason: "watch", watchContentGeneration: 0 });
    const daemon = coordinator.begin({ reason: "daemon" });

    expectSuperseded(() => watch.assertCurrent());
    expectSuperseded(() => coordinator.begin({ reason: "watch", watchContentGeneration: 0 }));

    daemon.finish();
    coordinator.begin({ reason: "watch", watchContentGeneration: 0 }).finish();
  });

  test("finishing superseded work does not release newer reload priority", () => {
    const coordinator = createSessionReloadCoordinator();
    const first = coordinator.begin({ reason: "manual" });
    const second = coordinator.begin({ reason: "daemon" });

    first.finish();
    expectSuperseded(() => coordinator.begin({ reason: "watch", watchContentGeneration: 0 }));

    second.finish();
    coordinator.begin({ reason: "watch", watchContentGeneration: 0 }).finish();
  });

  test("checks cancellation before publishing content", () => {
    const coordinator = createSessionReloadCoordinator();
    const controller = new AbortController();
    const reload = coordinator.begin({
      reason: "watch",
      signal: controller.signal,
      watchContentGeneration: 0,
    });
    controller.abort();

    expect(() => reload.publishContent(() => {})).toThrow();
    reload.finish();
  });

  test("allows each attempt to publish once and rejects use after finish", () => {
    const coordinator = createSessionReloadCoordinator();
    const reload = coordinator.begin({ reason: "manual" });

    reload.publishContent(() => {});
    expect(() => reload.publishContent(() => {})).toThrow("already published");
    reload.finish();
    expect(() => reload.assertCurrent()).toThrow("finished");
    expect(() => reload.publishContent(() => {})).toThrow("finished");
    reload.finish();
  });

  test("advances content ownership only after publication succeeds", () => {
    const coordinator = createSessionReloadCoordinator();
    const failed = coordinator.begin({ reason: "manual" });
    expect(() =>
      failed.publishContent(() => {
        throw new Error("publication failed");
      }),
    ).toThrow("publication failed");
    failed.finish();

    const retry = coordinator.begin({ reason: "watch", watchContentGeneration: 0 });
    expect(retry.publishContent((generation) => generation)).toBe(1);
    retry.finish();

    const current = coordinator.begin({ reason: "watch", watchContentGeneration: 1 });
    expect(current.publishContent((generation) => generation)).toBe(2);
    current.finish();
  });
});

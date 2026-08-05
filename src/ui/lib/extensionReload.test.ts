import { describe, expect, test } from "bun:test";
import { createEmptyExtensionLoadResult } from "../../extensions/types";
import { stageExtensionReload } from "./extensionReload";

/** Create an externally resolved promise for reload-order tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("stageExtensionReload", () => {
  test("leaves the active registry open while a replacement is loading", async () => {
    const active = createEmptyExtensionLoadResult();
    active.registry.eventBusPhase = "ready";
    active.registry.emitCustomEvent = () => {};
    const replacement = createEmptyExtensionLoadResult();
    const load = deferred<typeof replacement>();
    let current = true;
    const pending = stageExtensionReload({
      active,
      load: () => load.promise,
      assertCurrent: () => {
        if (!current) throw new Error("superseded");
      },
      publish: () => {
        throw new Error("a stale replacement must not publish");
      },
    });

    expect(active.registry.eventBusPhase).toBe("ready");
    expect(active.registry.emitCustomEvent).toBeFunction();
    current = false;
    load.resolve(replacement);

    await expect(pending).rejects.toThrow("superseded");
    expect(active.registry.eventBusPhase).toBe("ready");
    expect(active.registry.emitCustomEvent).toBeFunction();
    expect(replacement.registry.eventBusPhase).toBe("closed");
  });

  test("retires the active registry only after the replacement is current", async () => {
    const active = createEmptyExtensionLoadResult();
    active.registry.eventBusPhase = "ready";
    active.registry.emitCustomEvent = () => {};
    const replacement = createEmptyExtensionLoadResult();
    let published = active;

    expect(
      await stageExtensionReload({
        active,
        load: async () => replacement,
        assertCurrent: () => {},
        publish: (next) => {
          published = next;
        },
      }),
    ).toBe(replacement);
    expect(published).toBe(replacement);
    expect(String(active.registry.eventBusPhase)).toBe("closed");
    expect(active.registry.emitCustomEvent).toBeUndefined();
  });

  test("publishes before another load continuation can observe the retired registry", async () => {
    const active = createEmptyExtensionLoadResult();
    active.registry.eventBusPhase = "ready";
    const replacement = createEmptyExtensionLoadResult();
    const load = deferred<typeof replacement>();
    let published = active;
    const pending = stageExtensionReload({
      active,
      load: () => load.promise,
      assertCurrent: () => {},
      publish: (next) => {
        published = next;
      },
    });
    const observed = load.promise.then(() => ({
      published,
      activePhase: active.registry.eventBusPhase,
    }));

    load.resolve(replacement);
    const duringPublication = await observed;
    await pending;

    expect(duringPublication.published).toBe(replacement);
    expect(duringPublication.activePhase).toBe("closed");
  });
});

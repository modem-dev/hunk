import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createWatchTestClock } from "../../../test/helpers/watchTest";
import type { CliInput, ReloadContext } from "../../core/types";
import type { WatchEventSourceCallbacks } from "../../core/watchController";
import { useWatchedInput, type WatchedInputRuntime } from "./useWatchedInput";

const input = {
  kind: "diff",
  left: "before.ts",
  right: "after.ts",
  options: { watch: true },
} satisfies CliInput;
const reloadContext: ReloadContext = { cwd: process.cwd() };

/** Create an externally resolved promise for hook-lifetime tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

/** Mount only the watch hook behind a minimal OpenTUI renderable. */
function WatchHarness({
  refresh,
  runtime,
}: {
  refresh: (signal: AbortSignal) => void | Promise<void>;
  runtime: WatchedInputRuntime;
}) {
  useWatchedInput({ enabled: true, input, reloadContext, refresh, runtime });
  return <text>watch</text>;
}

/** Settle the effect and its bounded promise chain. */
async function settle(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    for (let attempt = 0; attempt < 8; attempt++) await Promise.resolve();
    await setup.renderOnce();
  });
}

describe("useWatchedInput cancellation", () => {
  test("aborts fallback signature initialization when the hook unmounts", async () => {
    let initializationSignal: AbortSignal | undefined;
    const runtime: WatchedInputRuntime = {
      resolvePlan: () => ({ coverage: "hybrid", targets: [] }),
      getSignature: (_input, context) => {
        initializationSignal = context.signal;
        return new Promise<string>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(context.signal?.reason), {
            once: true,
          });
        });
      },
      createEventSource: () => {
        throw new Error("initialization should not create an event source");
      },
    };
    const setup = await testRender(<WatchHarness refresh={() => {}} runtime={runtime} />, {
      width: 20,
      height: 4,
    });

    await settle(setup);
    expect(initializationSignal?.aborted).toBe(false);
    await act(async () => setup.renderer.destroy());
    expect(initializationSignal?.aborted).toBe(true);
  });

  test("forwards the controller signal to an in-flight refresh", async () => {
    const clock = createWatchTestClock();
    const refreshGate = deferred<void>();
    let signature = "old";
    let sourceCallbacks: WatchEventSourceCallbacks | undefined;
    let refreshSignal: AbortSignal | undefined;
    const runtime: WatchedInputRuntime = {
      clock: clock.clock,
      resolvePlan: () => ({ coverage: "hybrid", targets: [] }),
      getSignature: () => signature,
      createEventSource: (_plan, callbacks) => {
        sourceCallbacks = callbacks;
        return { close() {} };
      },
    };
    const setup = await testRender(
      <WatchHarness
        runtime={runtime}
        refresh={(signal) => {
          refreshSignal = signal;
          return refreshGate.promise;
        }}
      />,
      { width: 20, height: 4 },
    );

    await settle(setup);
    expect(sourceCallbacks).toBeDefined();
    signature = "new";
    await act(async () => {
      sourceCallbacks?.onEvent();
      clock.advanceBy(200);
      for (let attempt = 0; attempt < 8; attempt++) await Promise.resolve();
    });
    expect(refreshSignal?.aborted).toBe(false);

    await act(async () => setup.renderer.destroy());
    expect(refreshSignal?.aborted).toBe(true);
    refreshGate.resolve();
  });
});

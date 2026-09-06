import { expect, mock, test } from "bun:test";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { runInteractiveApp } from "./runInteractiveApp";

test("retires extensions and closes the controlling terminal when review runtime creation fails", async () => {
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "runtime-failure",
    files: [],
  });
  const close = mock(() => undefined);
  const retireExtensions = mock(async () => undefined);
  const runSession = mock(async () => undefined);
  const failure = new Error("registration failed");

  await expect(
    runInteractiveApp(
      {
        bootstrap: bootstrap as never,
        controllingTerminal: {
          stdin: { isTTY: true } as never,
          close,
        },
      },
      {
        createReviewRuntime: mock(() => {
          throw failure;
        }) as never,
        runSession: runSession as never,
        retireExtensions: retireExtensions as never,
      },
    ),
  ).rejects.toBe(failure);

  expect(runSession).not.toHaveBeenCalled();
  expect(retireExtensions).toHaveBeenCalledTimes(1);
  expect(retireExtensions).toHaveBeenCalledWith(bootstrap.extensions);
  expect(close).toHaveBeenCalledTimes(1);
});

test("stops the broker and retires extensions before exceptional renderer teardown", async () => {
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "renderer-failure",
    files: [],
  });
  const events: string[] = [];
  const failure = new Error("render failed");
  const stop = mock(() => events.push("stop"));
  const retireExtensions = mock(async () => {
    events.push("retire-start");
    await Promise.resolve();
    events.push("retire-finish");
  });
  const runSession = mock(
    async (options: Parameters<typeof import("./session/runHunkSession").runHunkSession>[0]) => {
      await options.onFailure?.(failure);
      events.push("destroy");
      throw failure;
    },
  );

  await expect(
    runInteractiveApp(
      { bootstrap: bootstrap as never, controllingTerminal: null },
      {
        createReviewRuntime: (() => ({
          hostClient: undefined,
          reviewProducer: undefined,
          stop,
        })) as never,
        runSession: runSession as never,
        retireExtensions: retireExtensions as never,
      },
    ),
  ).rejects.toBe(failure);

  expect(events).toEqual(["stop", "retire-start", "retire-finish", "destroy"]);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(retireExtensions).toHaveBeenCalledTimes(1);
});

test("retries broker cleanup before teardown when the exceptional stop attempt fails", async () => {
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "broker-stop-failure",
    files: [],
  });
  const events: string[] = [];
  const failure = new Error("render failed");
  let stopAttempts = 0;
  const stop = mock(() => {
    stopAttempts += 1;
    events.push(`stop-${stopAttempts}`);
    if (stopAttempts === 1) throw new Error("socket close failed");
  });
  const retireExtensions = mock(async () => {
    events.push("retire");
  });
  const runSession = mock(
    async (options: Parameters<typeof import("./session/runHunkSession").runHunkSession>[0]) => {
      try {
        await options.onFailure?.(failure);
      } catch {}
      await options.beforeTeardown?.();
      events.push("destroy");
      throw failure;
    },
  );

  await expect(
    runInteractiveApp(
      { bootstrap: bootstrap as never, controllingTerminal: null },
      {
        createReviewRuntime: (() => ({
          hostClient: undefined,
          reviewProducer: undefined,
          stop,
        })) as never,
        runSession: runSession as never,
        retireExtensions: retireExtensions as never,
      },
    ),
  ).rejects.toBe(failure);

  expect(events).toEqual(["stop-1", "retire", "stop-2", "destroy"]);
  expect(stop).toHaveBeenCalledTimes(2);
});

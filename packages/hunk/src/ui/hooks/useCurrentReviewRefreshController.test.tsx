import { describe, expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createWatchTestRuntime } from "../../../../../test/helpers/watchTest";
import type { CliInput } from "../../core/run/commandInputs";
import type { ReloadSessionOptions, ReloadedSessionResult } from "../../session/types";
import type { WorkspaceRefreshRequest } from "../currentReviewRefresh";
import {
  useCurrentReviewRefreshController,
  type CurrentReviewRefreshController,
} from "./useCurrentReviewRefreshController";

const reloadedResult: ReloadedSessionResult = {
  sessionId: "test",
  inputKind: "diff",
  title: "before.ts → after.ts",
  sourceLabel: "after.ts",
  fileCount: 1,
  selectedHunkIndex: 0,
};

/** Render the controller with mutable view state so descriptor replacement can be observed. */
function RefreshHarness({
  input,
  onController,
  onRegister,
  onReload,
  onSetTheme,
  onWatchReloadPending,
  watchRuntime,
}: {
  input: CliInput;
  onController: (controller: CurrentReviewRefreshController) => void;
  onRegister: (request: WorkspaceRefreshRequest) => () => void;
  onSetTheme?: (setTheme: (themeId: string) => void) => void;
  onReload: (input: CliInput, options?: ReloadSessionOptions) => Promise<ReloadedSessionResult>;
  onWatchReloadPending?: () => void;
  watchRuntime?: Parameters<typeof useCurrentReviewRefreshController>[0]["watchRuntime"];
}) {
  const [themeId, setThemeId] = useState("dracula");
  const controller = useCurrentReviewRefreshController({
    input,
    onRegisterWorkspaceRefreshRequest: onRegister,
    onReloadSession: onReload,
    onWatchReloadPending,
    reloadContext: { cwd: "/repo" },
    sourceLabel: "/repo",
    view: {
      layoutMode: "stack",
      themeId,
      showAgentNotes: true,
      showHunkHeaders: true,
      showLineNumbers: true,
      showMenuBar: true,
      wrapLines: false,
    },
    watchRuntime,
  });
  onController(controller);
  onSetTheme?.(setThemeId);

  return (
    <box>
      <text>{themeId}</text>
    </box>
  );
}

const reloadableInput: CliInput = {
  kind: "diff",
  left: "before.ts",
  right: "after.ts",
  options: {},
};

describe("useCurrentReviewRefreshController", () => {
  test("replaces and cleans up the registered descriptor while refresh operations stay stable", async () => {
    const registered: WorkspaceRefreshRequest[] = [];
    const cleaned: WorkspaceRefreshRequest[] = [];
    let active: WorkspaceRefreshRequest | undefined;
    let controller!: CurrentReviewRefreshController;
    let setTheme!: (themeId: string) => void;
    const reloads: Array<{ input: CliInput; options?: ReloadSessionOptions }> = [];
    const setup = await testRender(
      <RefreshHarness
        input={reloadableInput}
        onController={(value) => {
          controller = value;
        }}
        onSetTheme={(value) => {
          setTheme = value;
        }}
        onRegister={(request) => {
          registered.push(request);
          active = request;
          return () => {
            cleaned.push(request);
            if (active === request) active = undefined;
          };
        }}
        onReload={async (input, options) => {
          reloads.push({ input, options });
          return reloadedResult;
        }}
      />,
      { width: 20, height: 4 },
    );

    try {
      await act(async () => setup.renderOnce());
      expect(registered).toHaveLength(1);
      const initialOperations = {
        general: controller.refreshCurrentInput,
        manual: controller.triggerRefreshCurrentInput,
        watch: controller.refreshWatchedInput,
      };

      await act(async () => {
        setTheme("nord");
        await setup.renderOnce();
      });

      expect(registered).toHaveLength(2);
      expect(cleaned).toEqual([registered[0]!]);
      expect(active).toBe(registered[1]);
      expect(registered[1]?.nextInput.options.theme).toBe("nord");
      expect(controller.refreshCurrentInput).toBe(initialOperations.general);
      expect(controller.triggerRefreshCurrentInput).toBe(initialOperations.manual);
      expect(controller.refreshWatchedInput).toBe(initialOperations.watch);

      await controller.refreshCurrentInput({ reason: "manual", reloadExtensions: true });
      expect(reloads).toEqual([
        {
          input: registered[1]!.nextInput,
          options: {
            reason: "manual",
            reloadExtensions: true,
            resetApp: false,
            sourcePath: undefined,
          },
        },
      ]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }

    expect(cleaned).toEqual(registered);
    expect(active).toBeUndefined();
  });

  test("manual reload reports a rejection while the general operation preserves it", async () => {
    let controller!: CurrentReviewRefreshController;
    const failure = new Error("reload failed");
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const setup = await testRender(
      <RefreshHarness
        input={reloadableInput}
        onController={(value) => {
          controller = value;
        }}
        onRegister={() => () => {}}
        onReload={async () => {
          throw failure;
        }}
      />,
      { width: 20, height: 4 },
    );

    try {
      await expect(controller.refreshCurrentInput({ reason: "manual" })).rejects.toBe(failure);
      await act(async () => {
        controller.triggerRefreshCurrentInput();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(consoleError).toHaveBeenCalledWith("Failed to reload the current diff.", failure);
    } finally {
      consoleError.mockRestore();
      await act(async () => setup.renderer.destroy());
    }
  });

  test("keeps manual and watch reasons distinct and forwards the watch-pending callback", async () => {
    const watch = createWatchTestRuntime();
    const reloads: ReloadSessionOptions[] = [];
    let pendingCount = 0;
    let controller!: CurrentReviewRefreshController;
    const setup = await testRender(
      <RefreshHarness
        input={{ ...reloadableInput, options: { watch: true } }}
        onController={(value) => {
          controller = value;
        }}
        onRegister={() => () => {}}
        onReload={async (_input, options) => {
          reloads.push(options ?? {});
          return reloadedResult;
        }}
        onWatchReloadPending={() => pendingCount++}
        watchRuntime={watch.runtime}
      />,
      { width: 20, height: 4 },
    );

    try {
      await act(async () => setup.renderOnce());
      controller.triggerRefreshCurrentInput();
      await act(async () => {
        await Promise.resolve();
        watch.setSignature("signature:1");
        watch.emit();
        watch.advanceBy(200);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(pendingCount).toBe(1);
      expect(reloads.map((options) => options.reason)).toEqual(["manual", "watch"]);
      expect(reloads.every((options) => options.resetApp === false)).toBe(true);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("leaves non-reloadable input unregistered, unwatched, and inert", async () => {
    const watch = createWatchTestRuntime();
    let controller!: CurrentReviewRefreshController;
    let registrations = 0;
    let reloads = 0;
    const setup = await testRender(
      <RefreshHarness
        input={{ kind: "patch", text: "stdin patch", options: { watch: true } }}
        onController={(value) => {
          controller = value;
        }}
        onRegister={() => {
          registrations++;
          return () => {};
        }}
        onReload={async () => {
          reloads++;
          return reloadedResult;
        }}
        watchRuntime={watch.runtime}
      />,
      { width: 20, height: 4 },
    );

    try {
      await act(async () => setup.renderOnce());
      expect(controller.canRefreshCurrentInput).toBe(false);
      await controller.refreshCurrentInput({ reason: "manual" });
      controller.triggerRefreshCurrentInput();
      await controller.refreshWatchedInput();
      expect(registrations).toBe(0);
      expect(reloads).toBe(0);
      expect(watch.sources).toHaveLength(0);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});

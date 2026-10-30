import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestStatusRuntime } from "../../../../../test/helpers/status-runtime";
import { APP_COMMAND_NAMES } from "../../core/run/commandCatalog";
import type { UserKeyBinding } from "../../core/run/config";
import { DOCUMENT_COMMAND_NAMES } from "../../core/run/documentCommandCatalog";
import { HISTORY_COMMAND_NAMES } from "../../core/run/historyCommandCatalog";
import { STATUS_COMMAND_NAMES } from "../../core/run/statusCommandCatalog";
import { runExtensionFactory } from "../../extensions/runExtension";
import { buildSessionCommands } from "../lib/sessionRegistrations";
import { ThemeController } from "../theme/controller";
import { StatusController } from "./controller";
import { StatusApp, type StatusOutcome } from "./StatusApp";

test("status accepts every inactive catalog name and registered bundled/user command without stealing active keys", async () => {
  const runtime = createTestStatusRuntime();
  const issues: Parameters<typeof runExtensionFactory>[0]["issues"] = [];
  runExtensionFactory({
    metadata: { id: "catalog-test", sourcePath: "test:catalog", origin: "global" },
    registry: runtime.extensionSession.current.registry,
    issues,
    factory(hunk) {
      hunk.registerCommand({ id: "inspect", title: "Inspect", key: "x" }, () => {});
    },
  });
  expect(issues).toEqual([]);
  const registered = buildSessionCommands(runtime.extensionSession.current.registry);
  expect(registered.some((entry) => entry.extensionId === "hunk")).toBe(true);
  const bindings: Record<string, UserKeyBinding> = {};
  for (const name of [
    ...APP_COMMAND_NAMES,
    ...DOCUMENT_COMMAND_NAMES,
    ...HISTORY_COMMAND_NAMES,
    ...registered.map((entry) => `${entry.extensionId}.${entry.command.id}`),
  ]) {
    if (!STATUS_COMMAND_NAMES.has(name)) bindings[name] = "j";
  }
  runtime.keybindings = { ...bindings, "hunk.status.nextRow": "n" };
  const controller = new StatusController(runtime);
  controller.resume = () => {};
  const outcome = mock(() => undefined);
  const setup = await testRender(
    <StatusApp
      controller={controller}
      runtime={runtime}
      themeController={new ThemeController({ initialTheme: "nord" })}
      sessionViewPreferences={runtime.initialViewPreferences}
      onOutcome={outcome}
    />,
    { width: 120, height: 24 },
  );
  try {
    await act(async () => setup.renderOnce());
    expect(controller.getSnapshot().notice).toBe("");
    await act(async () => setup.mockInput.pressKey("j"));
    expect(controller.getSnapshot().selected).toBe("path:alpha.ts");
    await act(async () => setup.mockInput.pressKey("n"));
    expect(controller.getSnapshot().selected).toBe("path:beta.ts");
    expect(outcome).not.toHaveBeenCalled();
  } finally {
    await act(async () => setup.renderer.destroy());
    await controller.close();
    await runtime.extensionSession.shutdown();
  }
});

for (const scenario of ["staged", "unstaged", "mixed", "no-index"] as const) {
  test(`status Enter, shortcuts, menu and action strip share supported comparisons: ${scenario}`, async () => {
    const runtime = createTestStatusRuntime();
    runtime.snapshot.paths = [
      {
        path: "selected.ts",
        ...(scenario === "no-index"
          ? {}
          : {
              index: scenario === "unstaged" ? ("unchanged" as const) : ("modified" as const),
            }),
        worktree: scenario === "staged" ? "unchanged" : "modified",
        conflict: false,
      },
    ];
    runtime.snapshot.changedPathCount = 1;
    runtime.snapshot.reviewActions = [
      ...(scenario === "staged" || scenario === "mixed"
        ? [{ id: "staged" as const, label: "Staged changes" }]
        : []),
      ...(scenario !== "staged"
        ? [
            {
              id: "unstaged" as const,
              label: scenario === "no-index" ? "Working copy changes" : "Working tree changes",
            },
          ]
        : []),
    ];
    const controller = new StatusController(runtime);
    controller.resume = () => {};
    const outcome = mock((_outcome: StatusOutcome) => undefined);
    const setup = await testRender(
      <StatusApp
        controller={controller}
        runtime={runtime}
        themeController={new ThemeController({ initialTheme: "nord" })}
        sessionViewPreferences={runtime.initialViewPreferences}
        onOutcome={outcome}
      />,
      { width: scenario === "no-index" ? 42 : 120, height: 24 },
    );

    /** Settle action preparation before exercising another entry point. */
    const press = async (key: string) => {
      await act(async () => setup.mockInput.pressKey(key));
      await act(async () => setup.renderOnce());
    };

    try {
      await act(async () => setup.renderOnce());
      const expected = scenario === "staged" ? "staged" : "unstaged";
      await press("\r");
      expect(outcome.mock.calls[0]?.[0]).toEqual({
        kind: "open-review",
        actionId: expected,
        filePath: "selected.ts",
      });
      outcome.mockClear();
      await press("s");
      expect(outcome.mock.calls.map(([value]) => value)).toEqual(
        scenario === "staged" || scenario === "mixed"
          ? [{ kind: "open-review", actionId: "staged" }]
          : [],
      );
      outcome.mockClear();
      await press("u");
      expect(outcome.mock.calls.map(([value]) => value)).toEqual(
        scenario !== "staged" ? [{ kind: "open-review", actionId: "unstaged" }] : [],
      );
      outcome.mockClear();

      const first = runtime.snapshot.reviewActions[0]!;
      const frame = setup.captureCharFrame().split("\n");
      const y = frame.findIndex((line) => line.includes(first.label));
      expect(y).toBeGreaterThanOrEqual(0);
      if (scenario === "no-index") expect(frame.join("\n")).not.toContain("Unstaged");
      await act(async () => setup.mockMouse.click(frame[y]!.indexOf(first.label) + 1, y));
      await act(async () => setup.renderOnce());
      expect(outcome.mock.calls[0]?.[0]).toEqual({ kind: "open-review", actionId: first.id });
      outcome.mockClear();
      await press("\x1b[21~");
      await press("\x1b[B");
      await press("\r");
      expect(outcome.mock.calls[0]?.[0]).toEqual({ kind: "open-review", actionId: first.id });
    } finally {
      await act(async () => setup.renderer.destroy());
      await controller.close();
      await runtime.extensionSession.shutdown();
    }
  });
}

test("mounted expanded status does not reproject paths on keyboard movement or notices", async () => {
  const runtime = createTestStatusRuntime();
  let pathReads = 0;
  runtime.snapshot.paths = Array.from({ length: 20_000 }, (_, index) => ({
    get path() {
      pathReads++;
      return `nested/${index}/long-expanded-file-name.ts`;
    },
    index: "modified" as const,
    worktree: "modified" as const,
    conflict: false,
  }));
  runtime.snapshot.changedPathCount = runtime.snapshot.paths.length;
  const controller = new StatusController(runtime);
  controller.resume = () => {};
  controller.togglePathGroup("tracked");
  const setup = await testRender(
    <StatusApp
      controller={controller}
      runtime={runtime}
      themeController={new ThemeController({ initialTheme: "nord" })}
      sessionViewPreferences={runtime.initialViewPreferences}
      onOutcome={() => undefined}
    />,
    { width: 42, height: 10 },
  );
  try {
    await act(async () => setup.renderOnce());
    const initialReads = pathReads;
    expect(initialReads).toBeGreaterThanOrEqual(20_000);
    for (let step = 0; step < 8; step++) {
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => controller.setNotice(`Notice ${step}`));
      await act(async () => setup.renderOnce());
    }
    expect(pathReads).toBe(initialReads);
    expect(controller.getSnapshot().top).toBeGreaterThan(0);
    expect(setup.captureCharFrame()).toContain("Notice 7");
  } finally {
    await act(async () => setup.renderer.destroy());
    await controller.close();
    await runtime.extensionSession.shutdown();
  }
});

import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type {
  ExtensionCommandContext,
  ExtensionCommandControls,
  ExtensionDialogs,
  ExtensionFileViewControls,
  ExtensionKeyboardModeControls,
  ExtensionLineHighlightControls,
  ExtensionPaneControls,
  ExtensionReviewControls,
  ExtensionReviewNavigation,
  ExtensionReviewSelection,
  ExtensionWorkspace,
} from "../../extension-api/types";
import { createEmptyExtensionLoadResult, type RegisteredCommand } from "../../extensions/types";
import { useExtensionCommandRunner } from "./useExtensionCommandRunner";

const commandControls = {} as ExtensionCommandControls;
const dialogs = {} as ExtensionDialogs;
const fileViews = {} as ExtensionFileViewControls;
const keyboardModes = {} as ExtensionKeyboardModeControls;
const highlights = {} as ExtensionLineHighlightControls;
const navigation = {} as ExtensionReviewNavigation;
const panes = {} as ExtensionPaneControls;
const review = {} as ExtensionReviewControls;
const workspace = {} as ExtensionWorkspace;
const selection = Object.freeze({
  file: null,
  hunkIndex: null,
  currentLine: null,
}) as ExtensionReviewSelection;

/** Mount the command runner and expose its stable invocation callback. */
async function renderRunner({
  createPanes = () => panes,
  extensions = createEmptyExtensionLoadResult("/repo"),
}: {
  createPanes?: () => ExtensionPaneControls;
  extensions?: ReturnType<typeof createEmptyExtensionLoadResult>;
} = {}) {
  let run!: (registered: RegisteredCommand) => void;

  function Harness() {
    run = useExtensionCommandRunner({
      commandControls,
      createDialogs: () => dialogs,
      createFileViewControls: () => fileViews,
      createKeyboardModeControls: () => keyboardModes,
      createLineHighlightControls: () => highlights,
      createNavigation: () => navigation,
      createPaneControls: createPanes,
      createReviewControls: () => review,
      createWorkspaceControls: () => workspace,
      extensions,
      getSelection: () => selection,
    });
    return <text>runner</text>;
  }

  const setup = await testRender(<Harness />, { width: 20, height: 2 });
  await act(async () => setup.renderOnce());
  return { current: () => run, extensions, setup };
}

/** Build one registered command around a test handler. */
function command(handler: RegisteredCommand["handler"]): RegisteredCommand {
  return {
    extensionId: "probe",
    command: { id: "run", title: "Run", key: "y" },
    handler,
  };
}

describe("useExtensionCommandRunner", () => {
  test("composes every public capability and freezes selection at invocation", async () => {
    const harness = await renderRunner();
    let context: ExtensionCommandContext | undefined;

    try {
      harness.current()(
        command((ctx) => {
          context = ctx;
        }),
      );

      expect(context).toMatchObject({
        commands: commandControls,
        dialogs,
        fileViews,
        highlights,
        keyboardModes,
        navigation,
        panes,
        review,
        selection,
        sidebars: panes,
        workspace,
      });
      expect(context?.cwd).toBe("/repo");
      expect(Object.isFrozen(context?.selection)).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("contains context-construction and handler throws with the attributed warning", async () => {
    const harness = await renderRunner({
      createPanes: () => {
        throw new Error("context boom");
      },
    });
    const notifications: Array<{ message: string; type: string }> = [];
    const unsubscribe = harness.extensions.notifications.subscribe((notification) =>
      notifications.push(notification),
    );

    try {
      expect(() => harness.current()(command(() => {}))).not.toThrow();
      expect(notifications.map(({ message, type }) => ({ message, type }))).toEqual([
        {
          message: 'Extension probe failed command "run" • context boom',
          type: "warning",
        },
      ]);
    } finally {
      unsubscribe();
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("contains synchronous handler throws with the same attributed warning", async () => {
    const harness = await renderRunner();
    const notifications: Array<{ message: string; type: string }> = [];
    const unsubscribe = harness.extensions.notifications.subscribe((notification) =>
      notifications.push(notification),
    );

    try {
      expect(() =>
        harness.current()(
          command(() => {
            throw new Error("sync boom");
          }),
        ),
      ).not.toThrow();
      expect(notifications.map(({ message, type }) => ({ message, type }))).toEqual([
        {
          message: 'Extension probe failed command "run" • sync boom',
          type: "warning",
        },
      ]);
    } finally {
      unsubscribe();
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("contains rejected handler promises with the same attributed warning", async () => {
    const harness = await renderRunner();
    const notifications: Array<{ message: string; type: string }> = [];
    const unsubscribe = harness.extensions.notifications.subscribe((notification) =>
      notifications.push(notification),
    );

    try {
      harness.current()(command(async () => Promise.reject("async boom")));
      await act(async () => Bun.sleep(0));
      expect(notifications.map(({ message, type }) => ({ message, type }))).toEqual([
        {
          message: 'Extension probe failed command "run" • async boom',
          type: "warning",
        },
      ]);
    } finally {
      unsubscribe();
      await act(async () => harness.setup.renderer.destroy());
    }
  });
});

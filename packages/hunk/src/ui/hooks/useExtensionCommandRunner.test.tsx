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
  ExtensionPromptControls,
  ExtensionReviewControls,
  ExtensionStatusLineControls,
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
const review: ExtensionReviewControls = {
  snapshot: () => null,
  setPresentationScope: () => false,
  clearPresentationScope: () => undefined,
};
const workspace = {} as ExtensionWorkspace;
const statusLine = {} as ExtensionStatusLineControls;
const prompts = {} as ExtensionPromptControls;
const selection = Object.freeze({
  file: null,
  hunkIndex: null,
  currentLine: null,
  files: [],
  layout: "unified",
}) as ExtensionReviewSelection;

/** Mount the command runner and expose its stable invocation callback. */
async function renderRunner({
  createPanes = () => panes,
  createReview = () => review,
  extensions = createEmptyExtensionLoadResult("/repo"),
}: {
  createPanes?: () => ExtensionPaneControls;
  createReview?: () => ExtensionReviewControls;
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
      createPromptControls: () => prompts,
      createReviewControls: createReview,
      createStatusLineControls: () => statusLine,
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

  test("retains leased review controls for setters and late failure cleanup", async () => {
    let generation = "before";
    const state: { activeScope: string | null } = { activeScope: null };
    let reject!: (error: Error) => void;
    let context!: ExtensionCommandContext;
    const harness = await renderRunner({
      createReview: () => {
        const owner = generation;
        return {
          snapshot: () => null,
          setPresentationScope: (scope) => {
            if (owner !== generation || scope.generation !== generation) return false;
            state.activeScope = generation;
            return true;
          },
          clearPresentationScope: () => {
            if (owner === generation) state.activeScope = null;
          },
        };
      },
    });
    const scope = () => ({
      generation,
      files: [{ fileId: "alpha", hunkIndexes: [0] }],
    });
    try {
      harness.current()(
        command((ctx) => {
          context = ctx;
          expect(ctx.review.setPresentationScope(scope())).toBe(true);
          return new Promise<void>((_resolve, rejectPromise) => {
            reject = rejectPromise;
          });
        }),
      );
      expect(state.activeScope).toBe("before");
      context.review.clearPresentationScope();
      expect(state.activeScope).toBeNull();

      generation = "after";
      harness.current()(
        command((ctx) => {
          expect(ctx.review.setPresentationScope(scope())).toBe(true);
        }),
      );
      expect(state.activeScope).toBe("after");
      expect(context.review.setPresentationScope(scope())).toBe(false);
      context.review.clearPresentationScope();
      expect(state.activeScope).toBe("after");
      await act(async () => {
        reject(new Error("old command failed"));
        await Bun.sleep(0);
      });
      expect(state.activeScope).toBe("after");

      harness.current()(
        command(() => {
          throw new Error("current command failed");
        }),
      );
      expect(state.activeScope).toBeNull();
    } finally {
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

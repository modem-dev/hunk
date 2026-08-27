/**
 * Builds extension command contexts and contains failures at the command boundary.
 *
 * Each invocation freezes selection and review-bound controls at the keypress that started it,
 * while navigation and public Hunk commands continue reading committed App state after awaits.
 * Context construction, synchronous handler throws, and rejected handler promises all report the
 * existing attributed warning without escaping into keyboard or menu dispatch.
 */

import { useCallback } from "react";
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
import type { ExtensionLoadResult, RegisteredCommand } from "../../extensions/types";

/** Describe an extension command failure without assuming an Error instance. */
function commandFailureMessage(registered: RegisteredCommand, error: unknown) {
  const detail = error instanceof Error ? error.message || error.name : String(error);
  return (
    `Extension ${registered.extensionId} failed command "${registered.command.id}" • ` + detail
  );
}

/** Construct and invoke extension commands against the current committed runtime. */
export function useExtensionCommandRunner({
  commandControls,
  createDialogs,
  createFileViewControls,
  createKeyboardModeControls,
  createLineHighlightControls,
  createNavigation,
  createPaneControls,
  createReviewControls,
  createWorkspaceControls,
  extensions,
  getSelection,
}: {
  commandControls: ExtensionCommandControls;
  createDialogs: (extensionId: string) => ExtensionDialogs;
  createFileViewControls: (extensionId: string) => ExtensionFileViewControls;
  createKeyboardModeControls: (
    extensionId: string,
    registry: ExtensionLoadResult["registry"] | undefined,
  ) => ExtensionKeyboardModeControls;
  createLineHighlightControls: (extensionId: string) => ExtensionLineHighlightControls;
  createNavigation: (extensionId: string) => ExtensionReviewNavigation;
  createPaneControls: (extensionId: string) => ExtensionPaneControls;
  createReviewControls: () => ExtensionReviewControls;
  createWorkspaceControls: (extensionId: string) => ExtensionWorkspace;
  extensions?: ExtensionLoadResult;
  getSelection: () => ExtensionReviewSelection;
}) {
  return useCallback(
    (registered: RegisteredCommand) => {
      const report = (error: unknown) => {
        extensions?.context.notify(commandFailureMessage(registered, error), "warning");
      };

      try {
        const panes = createPaneControls(registered.extensionId);
        // Build the complete context before invoking the handler; selection is frozen here.
        const context: ExtensionCommandContext = {
          cwd: extensions?.context.cwd ?? process.cwd(),
          commands: commandControls,
          keyboardModes: createKeyboardModeControls(registered.extensionId, extensions?.registry),
          notify: (message, type) => extensions?.context.notify(message, type),
          panes,
          sidebars: panes,
          fileViews: createFileViewControls(registered.extensionId),
          highlights: createLineHighlightControls(registered.extensionId),
          review: createReviewControls(),
          selection: getSelection(),
          dialogs: createDialogs(registered.extensionId),
          workspace: createWorkspaceControls(registered.extensionId),
          navigation: createNavigation(registered.extensionId),
        };

        const returned = registered.handler(context);
        // Route async rejections through the same warning as synchronous failures.
        if (returned && typeof (returned as PromiseLike<void>).then === "function") {
          Promise.resolve(returned).catch(report);
        }
      } catch (error) {
        report(error);
      }
    },
    [
      commandControls,
      createDialogs,
      createFileViewControls,
      createKeyboardModeControls,
      createLineHighlightControls,
      createNavigation,
      createPaneControls,
      createReviewControls,
      createWorkspaceControls,
      extensions,
      getSelection,
    ],
  );
}

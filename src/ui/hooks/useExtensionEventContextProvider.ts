/**
 * Installs the controls lifecycle and custom-event handlers receive after App commits.
 *
 * AppHost publishes startup and reload events from its parent layout effect, after this child
 * effect has attached pane, navigation, dialog, and bus controls for the committed review. Registry
 * replacement and unmount remove only the provider this hook installed, so stale cleanup cannot
 * detach a successor runtime.
 */

import { useLayoutEffect } from "react";
import type {
  ExtensionDialogs,
  ExtensionEventContext,
  ExtensionPaneControls,
  ExtensionReviewReloadControls,
  ExtensionReviewNavigation,
} from "../../extension-api/types";
import { emitExtensionCustomEvent } from "../../extensions/events";
import type { ExtensionLoadResult } from "../../extensions/types";

/** Attach one committed extension event-context provider with identity-checked cleanup. */
export function useExtensionEventContextProvider({
  createDialogs,
  createNavigation,
  createPaneControls,
  createReviewReloadControls,
  extensions,
}: {
  createDialogs: (extensionId: string) => ExtensionDialogs;
  createNavigation: (extensionId: string) => ExtensionReviewNavigation;
  createPaneControls: (extensionId: string) => ExtensionPaneControls;
  createReviewReloadControls: () => ExtensionReviewReloadControls;
  extensions?: ExtensionLoadResult;
}) {
  useLayoutEffect(() => {
    if (!extensions) return;

    const provider = (extensionId: string): ExtensionEventContext => {
      const panes = createPaneControls(extensionId);
      return {
        cwd: extensions.context.cwd,
        notify: (message, type) => extensions.context.notify(message, type),
        panes,
        sidebars: panes,
        navigation: createNavigation(extensionId),
        dialogs: createDialogs(extensionId),
        review: createReviewReloadControls(),
        events: {
          emit(event, payload) {
            emitExtensionCustomEvent(extensions, event, payload);
          },
        },
      };
    };

    // Install after commit so lifecycle events cannot capture controls from abandoned renders.
    extensions.eventContextProvider = provider;
    return () => {
      // Preserve a newer provider installed by a successor App instance.
      if (extensions.eventContextProvider === provider) {
        delete extensions.eventContextProvider;
      }
    };
  }, [createDialogs, createNavigation, createPaneControls, createReviewReloadControls, extensions]);
}

import { Component, useMemo, type ReactNode } from "react";
import type {
  ExtensionDiffFile,
  ExtensionNotifyType,
  ExtensionSidebarActions,
  ExtensionSidebarKeybindings,
  ExtensionSidebarViewProps,
} from "../../../extension-api/types";
import { BuiltInSidebarView } from "../../../extensions/default/ui/sidebar";
import type { ExtensionNotifySink, RegisteredSidebarView } from "../../../extensions/types";
import type { DiffFile } from "../../../core/types";
import { createGuardedReviewNavigation } from "../../lib/extensionNavigation";
import type { AppTheme } from "../../themes";
import { toExtensionPaintTheme } from "../../lib/extensionPaintTheme";

/** Read an error's message without assuming extension components throw `Error` instances. */
function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

/**
 * Contain one extension component's render failures to the sidebar.
 *
 * The isolation contract promises a misbehaving extension costs a warning, not
 * the session: a throw during render lands here instead of unwinding the whole
 * app tree, the extension is named once, and the built-in sidebar takes over.
 *
 * The failure is scoped to the *registration*, not the session: every
 * extension load pass registers a fresh `RegisteredSidebarView` object, so a
 * reload that ships a fixed component arrives as a new identity — even under
 * the same extension and view ids — and clears the failed state to give it a
 * real chance instead of leaving the fallback pinned for the session.
 */
class ExtensionSidebarErrorBoundary extends Component<
  {
    registered: RegisteredSidebarView;
    fallback: ReactNode;
    onError: (error: unknown) => void;
    children: ReactNode;
  },
  { failed: boolean; registered: RegisteredSidebarView | null }
> {
  override state = { failed: false, registered: null as RegisteredSidebarView | null };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { registered: RegisteredSidebarView },
    state: { failed: boolean; registered: RegisteredSidebarView | null },
  ) {
    if (props.registered !== state.registered) {
      return { registered: props.registered, failed: false };
    }

    return null;
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Mount the active sidebar view — bundled or extension-contributed.
 *
 * The host stays the authority on layout: this renders inside the exact box
 * the sidebar occupies — width, border, and panel surface — and only the
 * contents come from the view component. Everything handed to the component is
 * either a frozen view or a guarded callback, so the review model cannot be
 * corrupted from inside a custom sidebar. The built-in sidebar takes this
 * exact path too: it is a bundled extension consuming these same props, which
 * is what keeps them sufficient for third-party sidebars.
 */
export function ExtensionSidebarPane({
  registered,
  files,
  fileViews,
  selectedFileId,
  selectedHunkIndex,
  showTopChrome,
  theme,
  width,
  keybindings,
  notify,
  onSelectFile,
  onSelectHunk,
  onRenderFailure,
}: {
  registered: RegisteredSidebarView;
  /**
   * The visible review-stream files, already filtered like the built-in
   * sidebar's. Host-side only: the guarded actions validate navigation targets
   * against it, while the component sees `fileViews`.
   */
  files: DiffFile[];
  /**
   * The same files as frozen read-only views, converted once by the host.
   *
   * Passed in rather than derived here so sidebar props and the selection
   * command handlers receive come out of one conversion.
   */
  fileViews: ExtensionDiffFile[];
  selectedFileId: string | null;
  selectedHunkIndex: number | null;
  showTopChrome: boolean;
  theme: AppTheme;
  width: number;
  keybindings: ExtensionSidebarKeybindings;
  notify: ExtensionNotifySink;
  onSelectFile: (fileId: string) => void;
  onSelectHunk: (fileId: string, hunkIndex: number) => void;
  /**
   * Called when the view fails rendering, in place of the in-pane fallback.
   *
   * With several panes open, a crashed extra pane should close rather than
   * turn into a second copy of the built-in file navigation; the host owns
   * that policy, so it owns this callback.
   */
  onRenderFailure?: () => void;
}) {
  const { extensionId } = registered;
  const publicTheme = useMemo(() => toExtensionPaintTheme(theme), [theme]);

  const actions = useMemo<ExtensionSidebarActions>(
    () =>
      Object.freeze({
        // The same guarded navigation a command handler's `navigation` uses,
        // so a sidebar row click and a command jump enforce one contract.
        ...createGuardedReviewNavigation({
          extensionId,
          getFiles: () => files,
          notify,
          onSelectFile,
          onSelectHunk,
        }),
        notify(message: string, type: ExtensionNotifyType = "info") {
          notify(`${extensionId}: ${message}`, type);
        },
      }),
    [extensionId, files, notify, onSelectFile, onSelectHunk],
  );

  // The published contract types the component's return opaquely (`unknown`)
  // because the contract module carries no React types; inside the host it is
  // an ordinary function component rendered in Hunk's own tree.
  const View = registered.view.component as (props: ExtensionSidebarViewProps) => ReactNode;

  const viewProps: ExtensionSidebarViewProps = {
    files: fileViews,
    selectedFileId,
    selectedHunkIndex,
    width,
    theme: publicTheme,
    keybindings,
    actions,
  };

  /** The pane chrome the host owns, whichever component fills it. */
  const paneBox = (children: ReactNode) => (
    <box
      style={{
        width,
        border: showTopChrome ? ["top"] : [],
        borderColor: theme.border,
        backgroundColor: theme.panel,
        paddingX: 0,
        flexDirection: "column",
        ...(showTopChrome ? { paddingY: 1 } : { paddingTop: 0, paddingBottom: 1 }),
      }}
    >
      {children}
    </box>
  );

  return (
    <ExtensionSidebarErrorBoundary
      registered={registered}
      // The host decides what a failure looks like: a pane it wants closed
      // renders nothing while the close lands, and the bundled files pane —
      // which has no better view to fall back to — degrades in place to the
      // built-in component fed the same props.
      fallback={onRenderFailure ? null : paneBox(<BuiltInSidebarView {...viewProps} />)}
      onError={(error) => {
        notify(
          `Extension ${extensionId} sidebar view "${registered.view.id}" failed rendering • ` +
            `${describeError(error)}${onRenderFailure ? "" : " • using the built-in sidebar"}`,
          "warning",
        );
        onRenderFailure?.();
      }}
    >
      {paneBox(<View {...viewProps} />)}
    </ExtensionSidebarErrorBoundary>
  );
}

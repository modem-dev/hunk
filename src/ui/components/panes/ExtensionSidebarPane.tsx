import { Component, useMemo, type ReactNode } from "react";
import type {
  ExtensionNotifyType,
  ExtensionSidebarActions,
  ExtensionSidebarTheme,
  ExtensionSidebarViewProps,
} from "../../../extension-api/types";
import { BuiltInSidebarView } from "../../../extensions/bundled/sidebar";
import { toReadOnlyFileViews } from "../../../extensions/events";
import type { ExtensionNotifySink, RegisteredSidebarView } from "../../../extensions/types";
import type { DiffFile } from "../../../core/types";
import type { AppTheme } from "../../themes";

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
 * app tree, the extension is named once, and the built-in sidebar takes over
 * for the rest of the session. The boundary is keyed by extension and view id
 * at the call site, so a reloaded registry gets a fresh chance.
 */
class ExtensionSidebarErrorBoundary extends Component<
  { fallback: ReactNode; onError: (error: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Project the active theme onto the public token slice custom sidebars render with. */
function toSidebarTheme(theme: AppTheme): ExtensionSidebarTheme {
  return {
    appearance: theme.appearance,
    background: theme.background,
    panel: theme.panel,
    panelAlt: theme.panelAlt,
    border: theme.border,
    accent: theme.accent,
    accentMuted: theme.accentMuted,
    text: theme.text,
    muted: theme.muted,
    selectedHunk: theme.selectedHunk,
    badgeAdded: theme.badgeAdded,
    badgeRemoved: theme.badgeRemoved,
    badgeNeutral: theme.badgeNeutral,
    fileNew: theme.fileNew,
    fileDeleted: theme.fileDeleted,
    fileRenamed: theme.fileRenamed,
    fileModified: theme.fileModified,
    fileUntracked: theme.fileUntracked,
    noteBorder: theme.noteBorder,
  };
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
  selectedFileId,
  selectedHunkIndex,
  showTopChrome,
  theme,
  width,
  notify,
  onSelectFile,
  onSelectHunk,
}: {
  registered: RegisteredSidebarView;
  /** The visible review-stream files, already filtered like the built-in sidebar's. */
  files: DiffFile[];
  selectedFileId: string | null;
  selectedHunkIndex: number | null;
  showTopChrome: boolean;
  theme: AppTheme;
  width: number;
  notify: ExtensionNotifySink;
  onSelectFile: (fileId: string) => void;
  onSelectHunk: (fileId: string, hunkIndex: number) => void;
}) {
  const { extensionId } = registered;
  const publicFiles = useMemo(() => toReadOnlyFileViews(files), [files]);
  const publicTheme = useMemo(() => Object.freeze(toSidebarTheme(theme)), [theme]);

  const actions = useMemo<ExtensionSidebarActions>(() => {
    /** Reject a navigation target the review stream cannot show. */
    const assertVisibleFileId = (method: string, fileId: string) => {
      if (files.some((file) => file.id === fileId)) {
        return true;
      }

      notify(`Extension ${extensionId} ${method} targeted unknown file id "${fileId}"`, "warning");
      return false;
    };

    /** Turn one action failure into a warning naming the extension. */
    const guard = (method: string, run: () => void) => {
      try {
        run();
      } catch (error) {
        notify(`Extension ${extensionId} failed ${method} • ${describeError(error)}`, "warning");
      }
    };

    return Object.freeze({
      selectFile(fileId: string) {
        guard("selectFile", () => {
          if (assertVisibleFileId("selectFile", fileId)) {
            onSelectFile(fileId);
          }
        });
      },
      selectHunk(fileId: string, hunkIndex: number) {
        guard("selectHunk", () => {
          if (assertVisibleFileId("selectHunk", fileId)) {
            onSelectHunk(fileId, Math.max(0, Math.floor(hunkIndex)));
          }
        });
      },
      notify(message: string, type: ExtensionNotifyType = "info") {
        notify(`${extensionId}: ${message}`, type);
      },
    });
  }, [extensionId, files, notify, onSelectFile, onSelectHunk]);

  // The published contract types the component's return opaquely (`unknown`)
  // because the contract module carries no React types; inside the host it is
  // an ordinary function component rendered in Hunk's own tree.
  const View = registered.view.component as (props: ExtensionSidebarViewProps) => ReactNode;

  const viewProps: ExtensionSidebarViewProps = {
    files: publicFiles,
    selectedFileId,
    selectedHunkIndex,
    width,
    theme: publicTheme,
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
      // The bundled sidebar consumes the same props, so a failed extension view
      // degrades to the default sidebar without leaving the extension pipeline's
      // prop model. The bundled view failing is a Hunk bug and crashes as such.
      fallback={paneBox(<BuiltInSidebarView {...viewProps} />)}
      onError={(error) => {
        notify(
          `Extension ${extensionId} sidebar view "${registered.view.id}" failed rendering • ` +
            `${describeError(error)} • using the built-in sidebar`,
          "warning",
        );
      }}
    >
      {paneBox(<View {...viewProps} />)}
    </ExtensionSidebarErrorBoundary>
  );
}

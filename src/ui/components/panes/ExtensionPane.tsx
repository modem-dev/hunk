import { Component, memo, useMemo, type ReactNode } from "react";
import type {
  ExtensionDiffFile,
  ExtensionNotifyType,
  ExtensionPaneActions,
  ExtensionPaneKeybindings,
  ExtensionPaneProps,
  ExtensionCurrentLinePaint,
} from "../../../extension-api/types";
import type { DiffFile } from "../../../core/types";
import { paneKey } from "../../../extensions/apply";
import { BuiltInSidebarView } from "../../../extensions/default/ui/sidebar";
import { HUNK_FILES_PANE_KEY } from "../../../extensions/extensionIds";
import type { ExtensionNotifySink, RegisteredPane } from "../../../extensions/types";
import { createGuardedReviewNavigation } from "../../lib/extensionNavigation";
import { toExtensionPaintTheme } from "../../lib/extensionPaintTheme";
import type { AppTheme } from "../../themes";

function describeError(error: unknown) {
  return error instanceof Error ? error.message || error.name : String(error);
}

/** Contain render failures to one registration identity. */
class ExtensionPaneErrorBoundary extends Component<
  {
    registered: RegisteredPane;
    fallback: ReactNode;
    onError: (error: unknown) => void;
    children: ReactNode;
  },
  { failed: boolean; registered: RegisteredPane | null }
> {
  override state = { failed: false, registered: null as RegisteredPane | null };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: { registered: RegisteredPane },
    state: { failed: boolean; registered: RegisteredPane | null },
  ) {
    return props.registered !== state.registered
      ? { registered: props.registered, failed: false }
      : null;
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface ExtensionPaneHostProps {
  registered: RegisteredPane;
  files: DiffFile[];
  fileViews: ExtensionDiffFile[];
  selectedFileId: string | null;
  selectedHunkIndex: number | null;
  placement: ExtensionPaneProps["placement"];
  theme: AppTheme;
  width: number;
  height: number;
  currentLine: ExtensionCurrentLinePaint | null;
  showTopChrome?: boolean;
  keybindings: ExtensionPaneKeybindings;
  notify: ExtensionNotifySink;
  onSelectFile: (fileId: string) => void;
  onSelectHunk: (fileId: string, hunkIndex: number) => void;
  onRenderFailure?: () => void;
}

/** Mount a public pane component inside the exact rectangle planned by the host. */
function ExtensionPaneHostView({
  registered,
  files,
  fileViews,
  selectedFileId,
  selectedHunkIndex,
  placement,
  theme,
  width,
  height,
  currentLine,
  showTopChrome = false,
  keybindings,
  notify,
  onSelectFile,
  onSelectHunk,
  onRenderFailure,
}: ExtensionPaneHostProps) {
  const { extensionId } = registered;
  const publicTheme = useMemo(() => toExtensionPaintTheme(theme), [theme]);
  const actions = useMemo<ExtensionPaneActions>(
    () =>
      Object.freeze({
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
  const View = registered.pane.component as (props: ExtensionPaneProps) => ReactNode;
  const viewProps: ExtensionPaneProps = {
    files: fileViews,
    selectedFileId,
    selectedHunkIndex,
    placement,
    width,
    height,
    theme: publicTheme,
    keybindings,
    actions,
    currentLine: registered.pane.currentLine ? currentLine : null,
  };
  const filesChrome = paneKey(registered) === HUNK_FILES_PANE_KEY;
  const box = (children: ReactNode) => (
    <box
      style={{
        width,
        height,
        flexShrink: 0,
        overflow: "hidden",
        flexDirection: "column",
        backgroundColor: theme.panel,
        ...(filesChrome
          ? {
              border: showTopChrome ? (["top"] as const) : [],
              borderColor: theme.border,
              ...(showTopChrome ? { paddingTop: 1, paddingBottom: 1 } : { paddingBottom: 1 }),
            }
          : {}),
      }}
    >
      {children}
    </box>
  );
  const fallback = onRenderFailure
    ? null
    : filesChrome
      ? box(<text fg={publicTheme.muted}>Files pane unavailable</text>)
      : box(<BuiltInSidebarView {...viewProps} />);
  return (
    <ExtensionPaneErrorBoundary
      registered={registered}
      fallback={fallback}
      onError={(error) => {
        const fallbackNotice =
          onRenderFailure || filesChrome ? "" : " • using the built-in files pane";
        notify(
          `Extension ${extensionId} pane "${registered.pane.id}" failed rendering • ${describeError(error)}${fallbackNotice}`,
          "warning",
        );
        onRenderFailure?.();
      }}
    >
      {box(<View {...viewProps} />)}
    </ExtensionPaneErrorBoundary>
  );
}

/** Avoid repainting panes that did not opt into current-line updates. */
export const ExtensionPaneHost = memo(
  ExtensionPaneHostView,
  (previous, next) =>
    previous.registered === next.registered &&
    previous.files.length === next.files.length &&
    previous.files.every((file, index) => file === next.files[index]) &&
    previous.selectedFileId === next.selectedFileId &&
    previous.selectedHunkIndex === next.selectedHunkIndex &&
    previous.placement === next.placement &&
    previous.theme === next.theme &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.showTopChrome === next.showTopChrome &&
    previous.keybindings === next.keybindings &&
    (!next.registered.pane.currentLine || previous.currentLine === next.currentLine),
);

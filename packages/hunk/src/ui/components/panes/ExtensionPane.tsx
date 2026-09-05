import { MouseButton, type MouseEvent as TuiMouseEvent } from "@opentui/core";
import { Component, memo, useMemo, useRef, type ReactNode } from "react";
import type {
  ExtensionDiffFile,
  ExtensionNotifyType,
  ExtensionPaneActions,
  ExtensionPaneKeybindings,
  ExtensionPaneProps,
  ExtensionCurrentLinePaint,
} from "../../../extension-api/types";
import type { DiffFile } from "../../../core/changeset/model";
import { paneKey } from "../../../extensions/apply";
import { FlexFileSidebar } from "../../../extensions/default/ui/sidebar";
import { HUNK_FILES_PANE_KEY } from "../../../extensions/extensionIds";
import type { ExtensionNotifySink, RegisteredPane } from "../../../extensions/types";
import { createGuardedReviewNavigation } from "../../lib/extensionNavigation";
import { toExtensionPaintTheme } from "../../lib/extensionPaintTheme";
import type { AppTheme } from "../../themes";

function describeError(error: unknown) {
  return error instanceof Error ? error.message || error.name : String(error);
}

/** Run a pane activation without allowing extension failures to escape into mouse routing. */
function activatePane(registered: RegisteredPane, notify: ExtensionNotifySink) {
  const onActivate = registered.pane.onActivate;
  if (!onActivate) return;

  const report = (error: unknown) =>
    notify(
      `Extension ${registered.extensionId} pane "${registered.pane.id}" activation failed • ${describeError(error)}`,
      "warning",
    );
  try {
    const result = (onActivate as () => unknown)();
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).catch(report);
    }
  } catch (error) {
    report(error);
  }
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
  review?: ExtensionPaneProps["review"];
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
  onRevealLine: (fileId: string, side: "old" | "new", line: number) => "line" | "hunk" | "none";
  onRenderFailure?: () => void;
}

/** Mount a public pane component inside the exact rectangle planned by the host. */
function ExtensionPaneHostView({
  registered,
  review = null,
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
  onRevealLine,
  onRenderFailure,
}: ExtensionPaneHostProps) {
  const { extensionId } = registered;
  const publicTheme = useMemo(() => toExtensionPaintTheme(theme), [theme]);
  // Selection rerenders the pane host, but it does not replace the capabilities these callbacks
  // represent. Keep the public actions stable so memoized extension rows do not all repaint when
  // only the selected file changed; ref indirection still invokes the latest host generation.
  const actionTargetsRef = useRef({ notify, onSelectFile, onSelectHunk, onRevealLine });
  actionTargetsRef.current = { notify, onSelectFile, onSelectHunk, onRevealLine };
  const actions = useMemo<ExtensionPaneActions>(
    () =>
      Object.freeze({
        ...createGuardedReviewNavigation({
          extensionId,
          getFiles: () => files,
          notify: (message, type) => actionTargetsRef.current.notify(message, type),
          onSelectFile: (fileId) => actionTargetsRef.current.onSelectFile(fileId),
          onSelectHunk: (fileId, hunkIndex) =>
            actionTargetsRef.current.onSelectHunk(fileId, hunkIndex),
          onRevealLine: (fileId, side, line) =>
            actionTargetsRef.current.onRevealLine(fileId, side, line),
        }),
        notify(message: string, type: ExtensionNotifyType = "info") {
          actionTargetsRef.current.notify(`${extensionId}: ${message}`, type);
        },
      }),
    [extensionId, files],
  );
  const View = registered.pane.component as (props: ExtensionPaneProps) => ReactNode;
  const viewProps: ExtensionPaneProps = {
    review,
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
  const onMouseDown = (event: TuiMouseEvent) => {
    if (event.button === MouseButton.LEFT) activatePane(registered, notify);
  };
  const box = (children: ReactNode) => (
    <box
      onMouseDown={onMouseDown}
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
      : box(<FlexFileSidebar {...viewProps} />);
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
    previous.review === next.review &&
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

import type { BoxRenderable, MouseEvent as TuiMouseEvent, Renderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { Component, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { ExtensionDialogActions, ExtensionDialogProps } from "../../../extension-api/types";
import type {
  ExtensionDialogRequest,
  ExtensionInputDialogRequest,
  ExtensionOpenDialogRequest,
  ExtensionSelectDialogRequest,
} from "../../lib/extensionDialogs";
import { planExtensionOpenDialog, windowDialogText } from "../../lib/extensionDialogGeometry";
import { extensionToastPrefix } from "../../lib/extensionNotifications";
import { listWindowStart } from "../../lib/listWindow";
import { MODAL_FRAME_CHROME_ROWS, resolveModalGeometry } from "../../lib/modalGeometry";
import { toExtensionPaintTheme } from "../../lib/extensionPaintTheme";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ConfirmDialog, confirmDialogHeight, DialogActionRow } from "./ConfirmDialog";
import { ModalFrame } from "./ModalFrame";

/**
 * The modal surface behind `ctx.dialogs`.
 *
 * Every dialog is drawn by Hunk from host-controlled chrome, with the
 * extension's own text confined to the title, body, and choices. User-installed
 * extensions receive an attribution row using the same `ext` marker `notify`
 * toasts carry, so their prompts cannot look like Hunk asking. Bundled
 * extensions are Hunk-owned UI and omit that redundant row.
 *
 * Keyboard handling deliberately lives in `useAppKeyboardShortcuts` beside
 * every other modal surface; this component owns mouse parity only.
 */

/** Width every extension dialog is drawn at, clamped to the terminal. */
function dialogWidth(terminalWidth: number) {
  return Math.min(72, Math.max(40, terminalWidth - 8));
}

/** The attribution line naming the extension that raised the dialog. */
function attributionText(extensionId: string, width: number) {
  return fitText(`${extensionToastPrefix()} ${extensionId}`, width);
}

/** Report whether one focused renderable belongs to a custom dialog's bounded root. */
function isWithinRenderable(root: Renderable, candidate: Renderable | null) {
  let current = candidate;
  while (current) {
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

export function ExtensionDialog({
  copySupported,
  inputValue,
  onAcceptRequest,
  onCancelRequest,
  onChangeInputRequest,
  onClose,
  onCopy,
  onNotify,
  onPickOptionRequest,
  onRenderFailure,
  request,
  selectedIndex,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  copySupported: boolean;
  /** Live text of an input dialog's field; ignored by the other kinds. */
  inputValue: string;
  onAcceptRequest: (requestId: number, selectedIndexOverride?: number) => void;
  onCancelRequest: (requestId: number) => void;
  onChangeInputRequest: (requestId: number, value: string) => void;
  onClose: (requestId: number) => void;
  onCopy: (requestId: number, text: string) => boolean;
  onNotify: (requestId: number, message: string) => void;
  /** Highlight one option row without accepting it, mirroring the theme selector. */
  onPickOptionRequest: (requestId: number, index: number) => void;
  onRenderFailure: (requestId: number, error: unknown) => void;
  request: ExtensionDialogRequest;
  selectedIndex: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  if (request.kind === "open") {
    return (
      <ExtensionOpenDialog
        copySupported={copySupported}
        onCancel={() => onCancelRequest(request.id)}
        onClose={onClose}
        onCopy={onCopy}
        onNotify={onNotify}
        onRenderFailure={onRenderFailure}
        request={request}
        terminalHeight={terminalHeight}
        terminalWidth={terminalWidth}
        theme={theme}
      />
    );
  }

  if (request.kind === "select") {
    return (
      <ExtensionSelectDialog
        onAccept={(selectedIndexOverride) => onAcceptRequest(request.id, selectedIndexOverride)}
        onCancel={() => onCancelRequest(request.id)}
        onPickOption={(index) => onPickOptionRequest(request.id, index)}
        request={request}
        selectedIndex={selectedIndex}
        terminalHeight={terminalHeight}
        terminalWidth={terminalWidth}
        theme={theme}
      />
    );
  }

  if (request.kind === "input") {
    return (
      <ExtensionInputDialog
        inputValue={inputValue}
        onAccept={() => onAcceptRequest(request.id)}
        onCancel={() => onCancelRequest(request.id)}
        onChangeInput={(value) => onChangeInputRequest(request.id, value)}
        request={request}
        terminalHeight={terminalHeight}
        terminalWidth={terminalWidth}
        theme={theme}
      />
    );
  }

  const frame = resolveModalGeometry({
    width: dialogWidth(terminalWidth),
    height: Number.MAX_SAFE_INTEGER,
    terminalWidth,
    terminalHeight,
  });
  const bodyWidth = Math.max(1, frame.width - 4);
  const availableBodyRows = Math.max(0, frame.height - confirmDialogHeight(0));
  const attributionRows = request.showAttribution && availableBodyRows > 0 ? 1 : 0;
  const rowsAfterAttribution = Math.max(0, availableBodyRows - attributionRows);
  const attributionGapRows =
    attributionRows > 0 && request.bodyLines.length > 0 && rowsAfterAttribution > 1 ? 1 : 0;
  const bodyRows = Math.max(0, rowsAfterAttribution - attributionGapRows);
  const visibleBody = windowDialogText(request.bodyLines, bodyWidth, bodyRows);

  return (
    <ConfirmDialog
      actions={[
        {
          keyLabel: "enter/y",
          label: request.confirmLabel,
          run: () => onAcceptRequest(request.id),
        },
        {
          keyLabel: "esc/n",
          label: request.cancelLabel,
          run: () => onCancelRequest(request.id),
        },
      ]}
      height={confirmDialogHeight(visibleBody.lines.length + attributionRows + attributionGapRows)}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={request.title}
      width={frame.width}
      onClose={() => onCancelRequest(request.id)}
    >
      {attributionRows > 0 ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.badgeNeutral}>{attributionText(request.extensionId, bodyWidth)}</text>
        </box>
      ) : null}
      {attributionGapRows > 0 ? <box style={{ width: "100%", height: 1 }} /> : null}
      {visibleBody.lines.map((line, index) => (
        // Body lines are positional prose, so their index is their identity.
        <box key={`${index}-${line}`} style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted}>{fitText(line, bodyWidth)}</text>
        </box>
      ))}
    </ConfirmDialog>
  );
}

/** Contain a custom dialog's render failure to its request identity. */
class ExtensionDialogErrorBoundary extends Component<
  {
    request: ExtensionOpenDialogRequest;
    fallback: ReactNode;
    onError: (error: unknown) => void;
    retireActions: () => void;
    children: ReactNode;
  },
  { failed: boolean; request: ExtensionOpenDialogRequest | null }
> {
  override state = { failed: false, request: null as ExtensionOpenDialogRequest | null };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: { request: ExtensionOpenDialogRequest },
    state: { failed: boolean; request: ExtensionOpenDialogRequest | null },
  ) {
    return props.request !== state.request ? { request: props.request, failed: false } : null;
  }
  override componentDidCatch(error: unknown) {
    this.props.retireActions();
    this.props.onError(error);
  }
  override componentWillUnmount() {
    this.props.retireActions();
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Mount an extension-owned component inside host-controlled modal chrome. */
function ExtensionOpenDialog({
  copySupported,
  onCancel,
  onClose,
  onCopy,
  onNotify,
  onRenderFailure,
  request,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  copySupported: boolean;
  onCancel: () => void;
  onClose: (requestId: number) => void;
  onCopy: (requestId: number, text: string) => boolean;
  onNotify: (requestId: number, message: string) => void;
  onRenderFailure: (requestId: number, error: unknown) => void;
  request: ExtensionOpenDialogRequest;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  const renderer = useRenderer();
  const componentRootRef = useRef<BoxRenderable | null>(null);
  const layout = planExtensionOpenDialog(request, terminalWidth, terminalHeight);
  const { attributionGapRows, attributionRows, bodyWidth, componentHeight, frame } = layout;
  const publicTheme = useMemo(() => toExtensionPaintTheme(theme), [theme]);
  const actionLease = request.actionLease;
  const actions = useMemo<ExtensionDialogActions>(
    () =>
      Object.freeze({
        close: () => {
          if (actionLease.active) onClose(request.id);
        },
        copy: (text: string) => actionLease.active && onCopy(request.id, text),
        notify: (message: string) => {
          if (actionLease.active) onNotify(request.id, message);
        },
      }),
    [actionLease, onClose, onCopy, onNotify, request.id],
  );
  const viewProps: ExtensionDialogProps = {
    width: bodyWidth,
    height: componentHeight,
    theme: publicTheme,
    copySupported,
    actions,
  };
  const View = request.component as (props: ExtensionDialogProps) => ReactNode;
  const componentBox = (children: ReactNode, fallback = false) => (
    <box
      ref={fallback ? undefined : componentRootRef}
      focusable={true}
      focused={fallback}
      visible={componentHeight > 0}
      style={{
        width: bodyWidth,
        height: componentHeight,
        flexShrink: 0,
        overflow: "hidden",
        flexDirection: "column",
        backgroundColor: theme.panel,
      }}
    >
      {children}
    </box>
  );

  useLayoutEffect(() => {
    const root = componentRootRef.current;
    if (root && !isWithinRenderable(root, renderer.currentFocusedRenderable)) {
      // A nested input that focused itself during mount wins. Otherwise the
      // bounded root traps unhandled keys before they reach the review.
      root.focus();
    }
  }, [renderer, request.id]);

  return (
    <ModalFrame
      height={frame.height}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={request.title}
      width={frame.width}
      onClose={onCancel}
    >
      {attributionRows > 0 ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.badgeNeutral}>{layout.attributionText}</text>
        </box>
      ) : null}
      {attributionGapRows > 0 ? <box style={{ width: "100%", height: 1 }} /> : null}
      <ExtensionDialogErrorBoundary
        key={request.id}
        request={request}
        fallback={componentBox(<text fg={publicTheme.muted}>Dialog unavailable</text>, true)}
        retireActions={() => {
          actionLease.active = false;
        }}
        onError={(error) => {
          onRenderFailure(request.id, error);
        }}
      >
        {componentBox(<View {...viewProps} />)}
      </ExtensionDialogErrorBoundary>
    </ModalFrame>
  );
}

/** Render a select dialog as a keyboard- and mouse-driven option list. */
function ExtensionSelectDialog({
  onAccept,
  onCancel,
  onPickOption,
  request,
  selectedIndex,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  onAccept: (selectedIndexOverride?: number) => void;
  onCancel: () => void;
  onPickOption: (index: number) => void;
  request: ExtensionSelectDialogRequest;
  selectedIndex: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  const frame = resolveModalGeometry({
    width: dialogWidth(terminalWidth),
    height: Math.min(Math.max(11, terminalHeight - 6), 24),
    terminalWidth,
    terminalHeight,
  });
  const bodyWidth = Math.max(1, frame.width - 4);
  const contentRows = Math.max(0, frame.height - MODAL_FRAME_CHROME_ROWS);
  const attributionRows = request.showAttribution && contentRows >= 2 ? 1 : 0;
  const actionRows = contentRows - attributionRows >= 2 ? 1 : 0;
  const statusRows = contentRows - attributionRows - actionRows >= 2 ? 1 : 0;
  const actionGapRows = contentRows - attributionRows - actionRows - statusRows >= 2 ? 1 : 0;
  const visibleRows = Math.max(
    0,
    contentRows - attributionRows - actionRows - statusRows - actionGapRows,
  );
  const start = listWindowStart(selectedIndex, request.options.length, Math.max(1, visibleRows));
  const visibleOptions = request.options.slice(start, start + visibleRows);
  const markerWidth = 2;
  const labelWidth = Math.max(4, bodyWidth - markerWidth);

  return (
    <ModalFrame
      height={frame.height}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={request.title}
      width={frame.width}
      onClose={onCancel}
    >
      {attributionRows > 0 ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.badgeNeutral}>{attributionText(request.extensionId, bodyWidth)}</text>
        </box>
      ) : null}
      {visibleOptions.map((option, offset) => {
        const index = start + offset;
        const selected = index === selectedIndex;
        return (
          <box
            // Options may repeat, so the row's position is what identifies it.
            key={`${index}-${option}`}
            style={{
              width: "100%",
              height: 1,
              flexDirection: "row",
              backgroundColor: selected ? theme.accentMuted : theme.panel,
            }}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              onPickOption(index);
              onAccept(index);
            }}
          >
            <text fg={selected ? theme.text : theme.muted}>
              {padText(selected ? "›" : " ", markerWidth)}
            </text>
            <text fg={selected ? theme.text : theme.muted}>{fitText(option, labelWidth)}</text>
          </box>
        );
      })}
      {statusRows > 0 ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted}>
            {fitText(
              `${start + 1}-${Math.min(start + visibleRows, request.options.length)} of ${request.options.length}`,
              bodyWidth,
            )}
          </text>
        </box>
      ) : null}
      {actionGapRows > 0 ? <box style={{ width: "100%", height: 1 }} /> : null}
      {actionRows > 0 ? (
        <DialogActionRow
          actions={[
            { keyLabel: "enter", label: "choose", run: () => onAccept(selectedIndex) },
            { keyLabel: "esc", label: "cancel", run: onCancel },
          ]}
          theme={theme}
        />
      ) : null}
    </ModalFrame>
  );
}

/** Render an input dialog as a focused single-line field. */
function ExtensionInputDialog({
  inputValue,
  onAccept,
  onCancel,
  onChangeInput,
  request,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  inputValue: string;
  onAccept: () => void;
  onCancel: () => void;
  onChangeInput: (value: string) => void;
  request: ExtensionInputDialogRequest;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  // ModalFrame chrome plus field, spacer, actions, and optional attribution + spacer.
  const frame = resolveModalGeometry({
    width: dialogWidth(terminalWidth),
    height: request.showAttribution ? 10 : 8,
    terminalWidth,
    terminalHeight,
  });
  const bodyWidth = Math.max(1, frame.width - 4);
  const contentRows = Math.max(0, frame.height - MODAL_FRAME_CHROME_ROWS);
  const attributionRows = request.showAttribution && contentRows >= 2 ? 1 : 0;
  const actionRows = contentRows - attributionRows >= 2 ? 1 : 0;
  const attributionGapRows = contentRows - attributionRows - actionRows >= 2 ? 1 : 0;
  const fieldGapRows = contentRows - attributionRows - actionRows - attributionGapRows >= 2 ? 1 : 0;
  const fieldRows = Math.max(
    0,
    contentRows - attributionRows - actionRows - attributionGapRows - fieldGapRows,
  );

  return (
    <ModalFrame
      height={frame.height}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={request.title}
      width={frame.width}
      onClose={onCancel}
    >
      {attributionRows > 0 ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.badgeNeutral}>{attributionText(request.extensionId, bodyWidth)}</text>
        </box>
      ) : null}
      {attributionGapRows > 0 ? <box style={{ width: "100%", height: 1 }} /> : null}
      {fieldRows > 0 ? (
        <box style={{ width: "100%", height: 1, backgroundColor: theme.panelAlt }}>
          {/* The field only edits text: Enter and Escape are answered by
              useAppKeyboardShortcuts, where every dialog's action keys live —
              the app's global key handler consumes them before a focused
              renderable's own submit machinery could see them. */}
          <input
            width={bodyWidth}
            value={inputValue}
            placeholder={request.placeholder}
            focused={true}
            onInput={onChangeInput}
          />
        </box>
      ) : null}
      {fieldGapRows > 0 ? <box style={{ width: "100%", height: 1 }} /> : null}
      {actionRows > 0 ? (
        <DialogActionRow
          actions={[
            { keyLabel: "enter", label: "submit", run: onAccept },
            { keyLabel: "esc", label: "cancel", run: onCancel },
          ]}
          theme={theme}
        />
      ) : null}
    </ModalFrame>
  );
}

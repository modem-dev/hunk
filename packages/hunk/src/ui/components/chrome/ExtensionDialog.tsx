import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type {
  ExtensionDialogRequest,
  ExtensionInputDialogRequest,
  ExtensionSelectDialogRequest,
} from "../../lib/extensionDialogs";
import { extensionToastPrefix } from "../../lib/extensionNotifications";
import { windowDialogText } from "../../lib/extensionDialogGeometry";
import { listWindowStart } from "../../lib/listWindow";
import { MODAL_FRAME_CHROME_ROWS, resolveModalGeometry } from "../../lib/modalGeometry";
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

export function ExtensionDialog({
  inputValue,
  onAccept,
  onCancel,
  onChangeInput,
  onPickOption,
  request,
  selectedIndex,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  /** Live text of an input dialog's field; ignored by the other kinds. */
  inputValue: string;
  onAccept: (selectedIndexOverride?: number) => void;
  onCancel: () => void;
  onChangeInput: (value: string) => void;
  /** Highlight one option row without accepting it, mirroring the theme selector. */
  onPickOption: (index: number) => void;
  request: ExtensionDialogRequest;
  selectedIndex: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  if (request.kind === "select") {
    return (
      <ExtensionSelectDialog
        onAccept={onAccept}
        onCancel={onCancel}
        onPickOption={onPickOption}
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
        onAccept={onAccept}
        onCancel={onCancel}
        onChangeInput={onChangeInput}
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
        { keyLabel: "enter/y", label: request.confirmLabel, run: onAccept },
        { keyLabel: "esc/n", label: request.cancelLabel, run: onCancel },
      ]}
      height={confirmDialogHeight(visibleBody.lines.length + attributionRows + attributionGapRows)}
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
      {visibleBody.lines.map((line, index) => (
        // Body lines are positional prose, so their index is their identity.
        <box key={`${index}-${line}`} style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted}>{fitText(line, bodyWidth)}</text>
        </box>
      ))}
    </ConfirmDialog>
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

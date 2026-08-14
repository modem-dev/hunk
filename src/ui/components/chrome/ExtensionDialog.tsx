import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type {
  ExtensionDialogRequest,
  ExtensionInputDialogRequest,
  ExtensionSelectDialogRequest,
} from "../../ext/extensionDialogs";
import { extensionToastPrefix } from "../../ext/extensionNotifications";
import { listWindowStart } from "../../lib/listWindow";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ConfirmDialog, confirmDialogHeight } from "./ConfirmDialog";
import { ModalFrame } from "./ModalFrame";

/**
 * The modal surface behind `ctx.dialogs`.
 *
 * Every dialog is drawn by Hunk from host-controlled chrome, with the
 * extension's own text confined to the title, body, and choices — a prompt an
 * extension raises can never look like Hunk asking. The attribution row reuses
 * the same `ext` marker `notify` toasts carry, so "this came from an extension"
 * reads the same wherever extension output appears.
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
  onAccept: () => void;
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
        onCancel={onCancel}
        onChangeInput={onChangeInput}
        request={request}
        terminalHeight={terminalHeight}
        terminalWidth={terminalWidth}
        theme={theme}
      />
    );
  }

  const width = dialogWidth(terminalWidth);
  const bodyWidth = Math.max(1, width - 4);

  return (
    <ConfirmDialog
      actions={[
        { keyLabel: "enter/y", label: request.confirmLabel, run: onAccept },
        { keyLabel: "esc/n", label: request.cancelLabel, run: onCancel },
      ]}
      height={confirmDialogHeight(request.bodyLines.length > 0 ? request.bodyLines.length + 2 : 1)}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={request.title}
      width={width}
      onClose={onCancel}
    >
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.badgeNeutral}>{attributionText(request.extensionId, bodyWidth)}</text>
      </box>
      {request.bodyLines.length > 0 ? <box style={{ width: "100%", height: 1 }} /> : null}
      {request.bodyLines.map((line, index) => (
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
  onCancel,
  onPickOption,
  request,
  selectedIndex,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  onCancel: () => void;
  onPickOption: (index: number) => void;
  request: ExtensionSelectDialogRequest;
  selectedIndex: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  const width = dialogWidth(terminalWidth);
  const bodyWidth = Math.max(1, width - 4);
  const modalHeight = Math.min(Math.max(11, terminalHeight - 6), 24);
  // ModalFrame chrome, plus this dialog's attribution, legend, spacer, and the
  // row that reports how many options fell outside the window.
  const visibleRows = Math.max(3, modalHeight - 9);
  const start = listWindowStart(selectedIndex, request.options.length, visibleRows);
  const visibleOptions = request.options.slice(start, start + visibleRows);
  const markerWidth = 2;
  const labelWidth = Math.max(4, bodyWidth - markerWidth);

  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={request.title}
      width={width}
      onClose={onCancel}
    >
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.badgeNeutral}>{attributionText(request.extensionId, bodyWidth)}</text>
      </box>
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>{fitText("↑/↓ move  Enter choose  Esc cancel", bodyWidth)}</text>
      </box>
      <box style={{ width: "100%", height: 1 }} />
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
            }}
          >
            <text fg={selected ? theme.text : theme.muted}>
              {padText(selected ? "›" : " ", markerWidth)}
            </text>
            <text fg={selected ? theme.text : theme.muted}>{fitText(option, labelWidth)}</text>
          </box>
        );
      })}
      {start + visibleRows < request.options.length ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted}>
            {fitText(`… ${request.options.length - start - visibleRows} more`, bodyWidth)}
          </text>
        </box>
      ) : null}
    </ModalFrame>
  );
}

/** Render an input dialog as a focused single-line field. */
function ExtensionInputDialog({
  inputValue,
  onCancel,
  onChangeInput,
  request,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  inputValue: string;
  onCancel: () => void;
  onChangeInput: (value: string) => void;
  request: ExtensionInputDialogRequest;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  const width = dialogWidth(terminalWidth);
  const bodyWidth = Math.max(1, width - 4);
  // ModalFrame chrome plus attribution, spacer, field, spacer, legend.
  const modalHeight = 10;

  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={request.title}
      width={width}
      onClose={onCancel}
    >
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.badgeNeutral}>{attributionText(request.extensionId, bodyWidth)}</text>
      </box>
      <box style={{ width: "100%", height: 1 }} />
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
      <box style={{ width: "100%", height: 1 }} />
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>{fitText("Enter submit  Esc cancel", bodyWidth)}</text>
      </box>
    </ModalFrame>
  );
}

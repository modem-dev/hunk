import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type {
  ExtensionDialogRequest,
  ExtensionDocumentCopyRequest,
  ExtensionDocumentDialogRequest,
  ExtensionInputDialogRequest,
  ExtensionSelectDialogRequest,
} from "../../lib/extensionDialogs";
import { extensionToastPrefix } from "../../lib/extensionNotifications";
import { windowDialogLiteralText, windowDialogText } from "../../lib/extensionDialogGeometry";
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

/** Preserve meaningful text when a constrained document has only one row. */
function windowDocumentText(sourceLines: readonly string[], width: number, maxRows: number) {
  const windowed = windowDialogText(sourceLines, width, maxRows);
  if (maxRows !== 1 || !windowed.truncated) return windowed;

  const firstLine = windowDialogText(sourceLines, width, Number.MAX_SAFE_INTEGER).lines[0] ?? "";
  return { lines: [fitText(`${firstLine}…`, width, "…")], truncated: true };
}

export function ExtensionDialog({
  copySupported,
  inputValue,
  onAccept,
  onCancel,
  onChangeInput,
  onCopyDocument,
  onPickOption,
  request,
  selectedIndex,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  copySupported: boolean;
  /** Live text of an input dialog's field; ignored by the other kinds. */
  inputValue: string;
  onAccept: (selectedIndexOverride?: number) => void;
  onCancel: () => void;
  onChangeInput: (value: string) => void;
  onCopyDocument: (copy: ExtensionDocumentCopyRequest) => void;
  /** Highlight one option row without accepting it, mirroring the theme selector. */
  onPickOption: (index: number) => void;
  request: ExtensionDialogRequest;
  selectedIndex: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  if (request.kind === "document") {
    return (
      <ExtensionDocumentDialog
        copySupported={copySupported}
        onCancel={onCancel}
        onCopyDocument={onCopyDocument}
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

/** Render read-only guidance with an optional host-mediated clipboard card. */
function ExtensionDocumentDialog({
  copySupported,
  onCancel,
  onCopyDocument,
  request,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  copySupported: boolean;
  onCancel: () => void;
  onCopyDocument: (copy: ExtensionDocumentCopyRequest) => void;
  request: ExtensionDocumentDialogRequest;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  const width = Math.min(84, Math.max(40, terminalWidth - 8));
  const measuredFrame = resolveModalGeometry({
    width,
    height: Number.MAX_SAFE_INTEGER,
    terminalWidth,
    terminalHeight,
  });
  const bodyWidth = Math.max(1, measuredFrame.width - 4);
  const cardWidth = Math.max(1, bodyWidth - 4);
  const cardTextWidth = Math.max(1, cardWidth - 4);
  const idealBodyRows = windowDialogText(request.bodyLines, bodyWidth, Number.MAX_SAFE_INTEGER)
    .lines.length;
  const copy = request.copy;
  const idealCopyRows = copy
    ? windowDialogLiteralText(copy.displayLines, cardTextWidth, Number.MAX_SAFE_INTEGER).lines
        .length
    : 0;
  const hasBody = idealBodyRows > 0;
  const hasCopy = copy !== null;
  const idealContentRows =
    (request.showAttribution ? 2 : 0) +
    idealBodyRows +
    (hasBody && hasCopy ? 1 : 0) +
    (hasCopy ? 1 + idealCopyRows + 2 : 0) +
    2;
  const frame = resolveModalGeometry({
    width,
    // The inner flex column lets the final action use the last
    // chrome-adjacent row without adding an empty footer row.
    height: idealContentRows + MODAL_FRAME_CHROME_ROWS - 1,
    terminalWidth,
    terminalHeight,
  });
  const contentRows = Math.max(0, frame.height - MODAL_FRAME_CHROME_ROWS + 1);
  const actionRows = contentRows > 0 ? 1 : 0;
  const minimumCopyRows = hasCopy ? 2 : 0;
  const minimumContentRows =
    (request.showAttribution ? 1 : 0) + (hasBody ? 1 : 0) + minimumCopyRows + actionRows;
  const actionGapRows = contentRows > minimumContentRows ? 1 : 0;
  let remainingRows = Math.max(0, contentRows - actionRows - actionGapRows);
  const attributionRows = request.showAttribution && remainingRows > 0 ? 1 : 0;
  remainingRows -= attributionRows;
  const minimumVisibleDocumentRows = (hasBody ? 1 : 0) + minimumCopyRows;
  const attributionGapRows =
    attributionRows > 0 && remainingRows > minimumVisibleDocumentRows ? 1 : 0;
  remainingRows -= attributionGapRows;
  const copyReserve = hasCopy ? Math.min(minimumCopyRows, remainingRows) : 0;
  const bodyCopyGapReserve = hasBody && hasCopy && remainingRows > copyReserve + 1 ? 1 : 0;
  const bodyRows = Math.min(
    idealBodyRows,
    Math.max(0, remainingRows - copyReserve - bodyCopyGapReserve),
  );
  remainingRows -= bodyRows;
  const bodyCopyGapRows = bodyRows > 0 && hasCopy && remainingRows > 3 ? 1 : 0;
  remainingRows -= bodyCopyGapRows;
  const copyLabelRows = hasCopy && remainingRows > 1 ? 1 : 0;
  remainingRows -= copyLabelRows;
  const copyCardRows = hasCopy ? remainingRows : 0;
  const visibleBody = windowDocumentText(request.bodyLines, bodyWidth, bodyRows);
  const visibleCopy = copy
    ? windowDialogLiteralText(
        copy.displayLines,
        cardTextWidth,
        copyCardRows >= 3 ? copyCardRows - 2 : copyCardRows,
      )
    : { lines: [], truncated: false };

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
      <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
        {attributionRows > 0 ? (
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.badgeNeutral}>{attributionText(request.extensionId, bodyWidth)}</text>
          </box>
        ) : null}
        {attributionGapRows > 0 ? <box style={{ width: "100%", height: 1 }} /> : null}
        {visibleBody.lines.map((line, index) => (
          <box key={`body:${index}:${line}`} style={{ width: "100%", height: 1 }}>
            <text fg={theme.text}>{fitText(line, bodyWidth)}</text>
          </box>
        ))}
        {bodyCopyGapRows > 0 ? <box style={{ width: "100%", height: 1 }} /> : null}
        {copy && copyLabelRows > 0 ? (
          <box style={{ width: "100%", height: 1, paddingLeft: 1 }}>
            <text fg={theme.badgeNeutral}>{fitText(copy.label, bodyWidth - 1)}</text>
          </box>
        ) : null}
        {copy && copyCardRows > 0 ? (
          <box style={{ width: "100%", height: copyCardRows, paddingLeft: 1 }}>
            <box
              style={{
                width: cardWidth,
                height: copyCardRows,
                flexDirection: "column",
                ...(copyCardRows >= 3
                  ? {
                      border: true,
                      borderColor: theme.border,
                      paddingLeft: 1,
                      paddingRight: 1,
                    }
                  : {}),
              }}
            >
              {visibleCopy.lines.map((line, index) => (
                <box key={`copy:${index}:${line}`} style={{ width: "100%", height: 1 }}>
                  <text fg={theme.text}>{fitText(line, cardTextWidth)}</text>
                </box>
              ))}
            </box>
          </box>
        ) : null}
        {actionGapRows > 0 ? <box style={{ width: "100%", height: 1 }} /> : null}
        {actionRows > 0 && copy ? (
          <DocumentCopyAction
            copy={copy}
            copySupported={copySupported}
            onCopyDocument={onCopyDocument}
            theme={theme}
            width={bodyWidth}
          />
        ) : actionRows > 0 ? (
          <DialogActionRow
            actions={[{ keyLabel: "esc", label: "close", run: onCancel }]}
            theme={theme}
          />
        ) : null}
      </box>
    </ModalFrame>
  );
}

/** Render the compact copy affordance beneath a document card. */
function DocumentCopyAction({
  copy,
  copySupported,
  onCopyDocument,
  theme,
  width,
}: {
  copy: ExtensionDocumentCopyRequest;
  copySupported: boolean;
  onCopyDocument: (copy: ExtensionDocumentCopyRequest) => void;
  theme: AppTheme;
  width: number;
}) {
  const label = copySupported ? ` ⧉  Copy ${copy.label.toLowerCase()} ` : " Copy unavailable ";
  return (
    <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
      <box
        style={{ backgroundColor: copySupported ? theme.accentMuted : theme.panelAlt }}
        onMouseUp={(event: TuiMouseEvent) => {
          event.stopPropagation();
          if (copySupported) onCopyDocument(copy);
        }}
      >
        <text fg={copySupported ? theme.text : theme.muted}>{label}</text>
      </box>
      <text fg={theme.muted}>{padText("", Math.max(1, width - label.length))}</text>
    </box>
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

import type { ExtensionNotification } from "../../extensions/notifications";
import type { ExtensionNotifyType } from "../../extensions/types";
import { sanitizeTerminalText } from "../../lib/terminalText";
import type { AppTheme } from "../themes";

/**
 * How long one extension toast stays on screen before the next queued one shows.
 *
 * Matched to the existing transient status messages so extension output does not
 * read as a different class of chrome.
 */
export const EXTENSION_TOAST_DURATION_MS = 4_000;

/** Depth of the visible queue; older pending toasts past this are dropped. */
export const EXTENSION_TOAST_QUEUE_LIMIT = 8;

/** Short prefix marking a row as extension output rather than Hunk's own status. */
const TOAST_PREFIX = "ext";

/** Reserve room for the prefix, its separator, and the row's own padding. */
const TOAST_CHROME_COLUMNS = TOAST_PREFIX.length + 3;

/** Pick the theme token one notification type is rendered in. */
export function extensionToastColor(type: ExtensionNotifyType, theme: AppTheme) {
  switch (type) {
    case "error":
      return theme.badgeRemoved;
    case "warning":
      return theme.fileModified;
    case "info":
      return theme.badgeNeutral;
  }
}

/**
 * Fit one notification message into the terminal width.
 *
 * The toast is deliberately a single row, so an over-long message is truncated
 * with an ellipsis rather than being allowed to reflow the app chrome. The text
 * is extension-authored and routinely carries repo-controlled fragments (paths,
 * error messages), so escape sequences are stripped before it reaches the
 * terminal, exactly like every other untrusted-text surface in Hunk.
 */
export function extensionToastMessage(message: string, terminalWidth: number) {
  // Strip escapes before collapsing whitespace: collapsing first could split a
  // control sequence into fragments the sanitizer no longer recognizes.
  const singleLine = sanitizeTerminalText(message).replaceAll(/\s+/g, " ").trim();
  const available = Math.max(8, terminalWidth - TOAST_CHROME_COLUMNS);
  return singleLine.length > available ? `${singleLine.slice(0, available - 1)}…` : singleLine;
}

/** Label shown before every toast message. */
export function extensionToastPrefix() {
  return TOAST_PREFIX;
}

/**
 * Append one notification to the pending queue, newest last.
 *
 * The queue is bounded because notifications arrive from third-party code: a
 * looping extension should cost the user one stale row, not an unbounded
 * backlog they have to wait out.
 */
export function enqueueExtensionNotification(
  queue: readonly ExtensionNotification[],
  notification: ExtensionNotification,
): ExtensionNotification[] {
  const next = [...queue, notification];
  return next.length > EXTENSION_TOAST_QUEUE_LIMIT
    ? next.slice(next.length - EXTENSION_TOAST_QUEUE_LIMIT)
    : next;
}

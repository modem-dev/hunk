import type { ExtensionNotification } from "../../../extensions/notifications";
import {
  extensionToastColor,
  extensionToastMessage,
  extensionToastPrefix,
} from "../../lib/extensionNotifications";
import type { AppTheme } from "../../themes";

/**
 * One-row surface for extension `ctx.notify` output.
 *
 * Deliberately not a modal: extensions talk while the user is reviewing, so the
 * message sits on a single line at the bottom of the app and disappears on its
 * own. Only the active notification renders; queueing lives in the hook that
 * owns the timers.
 */
export function ExtensionToast({
  notification,
  terminalWidth,
  theme,
}: {
  notification: ExtensionNotification;
  terminalWidth: number;
  theme: AppTheme;
}) {
  return (
    <box
      style={{
        height: 1,
        backgroundColor: theme.panelAlt,
        paddingLeft: 1,
        paddingRight: 1,
        alignItems: "center",
        flexDirection: "row",
      }}
    >
      <text fg={extensionToastColor(notification.type, theme)}>{extensionToastPrefix()}</text>
      <text fg={theme.muted}>
        {` ${extensionToastMessage(notification.message, terminalWidth)}`}
      </text>
    </box>
  );
}

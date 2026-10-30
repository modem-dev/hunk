import type {
  ExtensionKeyboardMode,
  ExtensionKeyboardModeContext,
  ExtensionKeyboardModeKeyResult,
  ExtensionKeyEvent,
} from "../../extension-api/types";
import type { ExtensionRegistry, RegisteredKeyboardMode } from "../../extensions/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import {
  deliverSynchronousExtensionModeKey,
  runSynchronousExtensionModeLifecycle,
} from "../lib/synchronousExtensionCallback";

/** Everything the host retains while one session keyboard mode is active. */
export interface ActiveSessionKeyboardMode {
  readonly extensionId: string;
  readonly modeId: string;
  readonly registered: RegisteredKeyboardMode;
  readonly mode: ExtensionKeyboardMode;
  readonly ctx: ExtensionKeyboardModeContext;
  readonly registry: ExtensionRegistry;
}

/** Attribute one contained callback failure to its extension and mode. */
function formatKeyboardModeFailure(
  active: ActiveSessionKeyboardMode,
  action: string,
  detail: string,
) {
  return `Extension ${active.extensionId} keyboard mode "${active.modeId}" failed ${action} • ${detail}`;
}

/** Report whether an activation still belongs to the live extension registry. */
export function sessionKeyboardModeStillValid(
  active: ActiveSessionKeyboardMode,
  registry: ExtensionRegistry | undefined,
  modes: readonly RegisteredKeyboardMode[],
): boolean {
  return (
    active.registry === registry &&
    active.registry.eventBusPhase !== "closed" &&
    modes.includes(active.registered)
  );
}

/** Return the terminal-safe human label for one extension-authored mode title. */
export function sessionKeyboardModeDisplayTitle(active: ActiveSessionKeyboardMode): string {
  const title = sanitizeTerminalLine(active.mode.title).trim();
  return title || sanitizeTerminalLine(`${active.extensionId}:${active.modeId}`);
}

/** Build the persistent status label for one active session mode. */
export function sessionKeyboardModeStatusHint(active: ActiveSessionKeyboardMode): string {
  const owner = sanitizeTerminalLine(`${active.extensionId}:${active.modeId}`);
  return `${sessionKeyboardModeDisplayTitle(active)} — ext ${owner} — Esc exits`;
}

/** Run one lifecycle callback synchronously with extension failure containment. */
export function runSessionKeyboardModeLifecycle(
  active: ActiveSessionKeyboardMode,
  phase: "onEnter" | "onExit",
  notify: (message: string) => void,
): boolean {
  const callback = active.mode[phase];
  return runSynchronousExtensionModeLifecycle(
    callback ? () => callback.call(active.mode, active.ctx) : undefined,
    phase,
    (action, detail) => formatKeyboardModeFailure(active, action, detail),
    notify,
  );
}

/** Deliver one frozen public key snapshot and normalize the extension's routing answer. */
export function deliverSessionKeyboardModeKey(
  active: ActiveSessionKeyboardMode,
  key: ExtensionKeyEvent,
  notify: (message: string) => void,
): ExtensionKeyboardModeKeyResult {
  return deliverSynchronousExtensionModeKey(
    () => active.mode.onKey.call(active.mode, key, active.ctx),
    (action, detail) => formatKeyboardModeFailure(active, action, detail),
    notify,
  );
}

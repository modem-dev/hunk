import type {
  ExtensionFileViewMode,
  ExtensionFileViewModeContext,
  ExtensionFileViewModeKeyResult,
  ExtensionKeyEvent,
} from "../../extension-api/types";
import type { RegisteredFileView } from "../../extensions/types";
import { registeredFileViewKey } from "./state";

/** Read an error's message without assuming extensions throw `Error` instances. */
function describeError(error: unknown) {
  return error instanceof Error ? error.message || error.name : String(error);
}

/**
 * The one interactive file-view mode a session can have running.
 *
 * A file view is normally a pure presentation, so this record is the whole of
 * what "the extension is holding the keyboard" means: which registration owns
 * the keys, which file its context describes, and the review generation it was
 * entered against. Everything the host needs to route a key, decide the mode is
 * still valid, and tear it down exactly once lives here rather than being
 * re-derived at each call site.
 */
export interface ActiveFileViewMode {
  /** The extension that registered the view — whose code every callback here is. */
  readonly extensionId: string;
  /** The view's own id, as its extension declared it. */
  readonly viewId: string;
  /** The qualified `<extensionId>:<viewId>` key file-view selections are stored under. */
  readonly viewKey: string;
  readonly fileId: string;
  /**
   * The registration object the mode belongs to.
   *
   * Compared by identity: an extension reload produces new registration
   * objects, and a mode whose handler no longer belongs to the session must
   * not keep receiving keys.
   */
  readonly registered: RegisteredFileView;
  readonly mode: ExtensionFileViewMode;
  /** Built once at activation and handed to every lifecycle callback and key. */
  readonly ctx: ExtensionFileViewModeContext;
  /** Identity token of the review this mode was entered against. */
  readonly reviewGeneration: unknown;
}

/** Why `enterMode` refused, phrased for the user, or the mode it resolved. */
export type FileViewModeActivation =
  | {
      readonly ok: true;
      readonly registered: RegisteredFileView;
      readonly mode: ExtensionFileViewMode;
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * Decide whether one `enterMode` call can start a mode.
 *
 * Three refusals, each named rather than collapsed into one "cannot": the id
 * resolved to nothing, the view has no mode to run, or the view is not what the
 * selected file is currently showing. The last is the load-bearing one — a mode
 * routes keys on behalf of rows that are on screen, so entering it for a view
 * the user is not looking at would hijack the keyboard invisibly.
 */
export function resolveFileViewModeActivation({
  activeViewKey,
  extensionId,
  registered,
  viewId,
}: {
  activeViewKey: string | null;
  extensionId: string;
  registered: RegisteredFileView | undefined;
  viewId: string;
}): FileViewModeActivation {
  if (!registered) {
    return {
      ok: false,
      refusal: `Extension ${extensionId} targeted unknown file view "${viewId}"`,
    };
  }

  const mode = registered.view.mode;
  if (!mode) {
    return {
      ok: false,
      refusal: `Extension ${extensionId} file view "${viewId}" has no interactive mode`,
    };
  }

  if (registeredFileViewKey(registered) !== activeViewKey) {
    return {
      ok: false,
      refusal: `File view "${viewId}" is not the selected file's presentation • select it first`,
    };
  }

  return { ok: true, registered, mode };
}

/**
 * Report whether an active mode still describes what the user is looking at.
 *
 * The host exits a mode rather than letting it drift: its context names one
 * file and one presentation, so the moment the review moves — another file
 * selected, the view switched away, a reload replacing the changeset, an
 * extension reload replacing the registration — the mode's keys would be acting
 * on something that is no longer on screen.
 */
export function fileViewModeStillValid(
  active: ActiveFileViewMode,
  {
    activeViewKey,
    reviewGeneration,
    selectedFileId,
    views,
  }: {
    activeViewKey: string | null;
    reviewGeneration: unknown;
    selectedFileId: string | null;
    views: readonly RegisteredFileView[];
  },
): boolean {
  return (
    active.fileId === selectedFileId &&
    active.viewKey === activeViewKey &&
    active.reviewGeneration === reviewGeneration &&
    views.includes(active.registered)
  );
}

/** The unobtrusive status line shown while a mode holds the keyboard. */
export function fileViewModeStatusHint(active: ActiveFileViewMode): string {
  return `${active.extensionId}:${active.viewId} mode — Esc exits`;
}

/** Attribute one mode failure to the extension and the action that raised it. */
function formatFileViewModeFailure(active: ActiveFileViewMode, action: string, error: unknown) {
  return (
    `Extension ${active.extensionId} file view "${active.viewId}" mode ` +
    `failed ${action} • ${describeError(error)}`
  );
}

/**
 * Run one mode lifecycle callback, containing a failure as a warning.
 *
 * Returns whether the callback completed, which is what `onEnter` needs: a mode
 * whose entry threw never gets to hold the keyboard. `onExit` ignores the answer
 * — the mode is leaving either way.
 */
export function runFileViewModeLifecycle(
  active: ActiveFileViewMode,
  phase: "onEnter" | "onExit",
  notify: (message: string) => void,
): boolean {
  const callback = active.mode[phase];
  if (!callback) return true;

  try {
    callback.call(active.mode, active.ctx);
    return true;
  } catch (error) {
    notify(formatFileViewModeFailure(active, phase, error));
    return false;
  }
}

/**
 * Hand one key to an active mode and normalize its answer.
 *
 * A throw becomes `"exit"` — after a warning — so a broken handler gives the
 * keyboard back instead of swallowing every subsequent key. Anything that is
 * not a documented result (a handler that forgot to return) is read as
 * `"pass"`: declining a key leaves the app behaving exactly as it would with no
 * mode running, which is the safe reading of "the extension said nothing".
 */
export function deliverFileViewModeKey(
  active: ActiveFileViewMode,
  key: ExtensionKeyEvent,
  notify: (message: string) => void,
): ExtensionFileViewModeKeyResult {
  let result: ExtensionFileViewModeKeyResult;
  try {
    result = active.mode.onKey.call(active.mode, key, active.ctx);
  } catch (error) {
    notify(formatFileViewModeFailure(active, "onKey", error));
    return "exit";
  }

  return result === "handled" || result === "exit" ? result : "pass";
}

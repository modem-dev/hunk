import type {
  ExtensionDiffFile,
  ExtensionFileViewMode,
  ExtensionFileViewModeContext,
  ExtensionFileViewModeKeyResult,
  ExtensionKeyEvent,
} from "../../extension-api/types";
import type { RegisteredFileView } from "../../extensions/types";
import {
  deliverSynchronousExtensionModeKey,
  runSynchronousExtensionModeLifecycle,
} from "../lib/synchronousExtensionCallback";
import { registeredFileViewKey, resolveFileViewSelectionTarget } from "./state";

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

/** The selection an activation must apply before the mode can hold the keyboard. */
export interface FileViewModeSelection {
  readonly fileId: string;
  readonly viewKey: string;
}

/** Why `enterMode` refused, phrased for the user, or the mode it resolved. */
export type FileViewModeActivation =
  | {
      readonly ok: true;
      readonly registered: RegisteredFileView;
      readonly mode: ExtensionFileViewMode;
      /**
       * The presentation the host must select alongside entering, or `null` when
       * the view is already what the file shows.
       *
       * Entering a mode *makes* its rows visible rather than requiring the user
       * to have made them visible first, so "the view is not showing yet" is an
       * instruction to the host, not a refusal.
       */
      readonly select: FileViewModeSelection | null;
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * Decide whether one `enterMode` call can start a mode, and what it must select.
 *
 * A mode routes keys on behalf of rows that are on screen. That invariant is
 * kept by *putting* the view on screen as part of activating it — the host
 * applies `select` and the mode in one update — rather than by refusing every
 * call that arrives before the user chose the view. What remains are the
 * refusals no selection could fix, each named rather than collapsed into one
 * "cannot": no file is selected, the view cannot be shown for that file at all
 * (unknown id, host-owned raw rendering, a view that does not claim the file, a
 * matcher that throws — the containment `select` applies, resolved by the one
 * shared policy so the two entry points cannot disagree), or the view declares
 * no mode to run.
 */
export function resolveFileViewModeActivation({
  activeViewKey,
  extensionId,
  file,
  registered,
  unavailableReason,
  viewId,
}: {
  activeViewKey: string | null;
  extensionId: string;
  file: ExtensionDiffFile | null;
  registered: RegisteredFileView | undefined;
  unavailableReason: string | undefined;
  viewId: string;
}): FileViewModeActivation {
  if (!file) {
    return {
      ok: false,
      refusal: `Extension ${extensionId} cannot enter a mode without a selected file`,
    };
  }

  const target = resolveFileViewSelectionTarget({
    extensionId,
    file,
    registered,
    unavailableReason,
    viewId,
  });
  if (!target.ok) return target;

  const mode = target.registered.view.mode;
  if (!mode) {
    return {
      ok: false,
      refusal: `Extension ${extensionId} file view "${viewId}" has no interactive mode`,
    };
  }

  const viewKey = registeredFileViewKey(target.registered);
  return {
    ok: true,
    registered: target.registered,
    mode,
    select: viewKey === activeViewKey ? null : { fileId: file.id, viewKey },
  };
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
function formatFileViewModeFailure(active: ActiveFileViewMode, action: string, detail: string) {
  return (
    `Extension ${active.extensionId} file view "${active.viewId}" mode ` +
    `failed ${action} • ${detail}`
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
  return runSynchronousExtensionModeLifecycle(
    callback ? () => callback.call(active.mode, active.ctx) : undefined,
    phase,
    (action, detail) => formatFileViewModeFailure(active, action, detail),
    notify,
  );
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
  return deliverSynchronousExtensionModeKey(
    () => active.mode.onKey.call(active.mode, key, active.ctx),
    (action, detail) => formatFileViewModeFailure(active, action, detail),
    notify,
  );
}

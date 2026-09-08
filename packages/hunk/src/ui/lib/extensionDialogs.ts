/**
 * The queue behind `ctx.dialogs`, kept free of React on purpose.
 *
 * Extensions ask questions from async handlers, so the interesting behavior is
 * ordering and settlement — one dialog on screen at a time, later requests
 * waiting their turn, everything still waiting resolving its cancel value when
 * the session goes away. None of that is rendering, so it lives here as plain
 * state a unit test can drive: App subscribes, draws whatever `current()`
 * reports, and answers it with `accept`/`cancel`.
 */

import type {
  ExtensionConfirmOptions,
  ExtensionDialogs,
  ExtensionInputOptions,
  ExtensionSelectOptions,
} from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";

/** Default label for the accepting action of a confirm dialog. */
const DEFAULT_CONFIRM_LABEL = "ok";

/** Default label for the dismissing action of a confirm dialog. */
const DEFAULT_CANCEL_LABEL = "cancel";

/** Body lines one confirm dialog may show; beyond this the modal stops being a prompt. */
const MAX_CONFIRM_BODY_LINES = 6;

/** What every queued dialog carries, whatever kind it is. */
interface ExtensionDialogRequestBase {
  /**
   * Monotonic per-queue id.
   *
   * Two identical-looking dialogs are still different questions, so the UI
   * keys its per-dialog state (highlighted option, typed text) off this rather
   * than off the request's contents.
   */
  id: number;
  /** The extension that raised the dialog, rendered as its attribution. */
  extensionId: string;
  /** Whether host chrome should identify the extension that raised the dialog. */
  showAttribution: boolean;
  title: string;
}

export interface ExtensionConfirmDialogRequest extends ExtensionDialogRequestBase {
  kind: "confirm";
  bodyLines: string[];
  confirmLabel: string;
  cancelLabel: string;
}

export interface ExtensionSelectDialogRequest extends ExtensionDialogRequestBase {
  kind: "select";
  options: string[];
}

export interface ExtensionInputDialogRequest extends ExtensionDialogRequestBase {
  kind: "input";
  placeholder: string;
  initial: string;
}

/** One dialog the host should draw, normalized from what an extension asked for. */
export type ExtensionDialogRequest =
  | ExtensionConfirmDialogRequest
  | ExtensionSelectDialogRequest
  | ExtensionInputDialogRequest;

/** What a dialog hands back to the awaiting handler. */
type ExtensionDialogResult = boolean | string | null;

/** The host-side controller for every extension dialog in one session. */
export interface ExtensionDialogQueue {
  /** Build the `dialogs` object one extension's command handlers receive. */
  createDialogs(
    extensionId: string,
    options?: { isLive?: () => boolean; showAttribution?: boolean },
  ): ExtensionDialogs;
  /** The dialog that should be on screen, or `null` when none is. */
  current(): ExtensionDialogRequest | null;
  /**
   * Accept the dialog with this id.
   *
   * A confirm resolves `true`. A select or input resolves `value`; without one
   * there is nothing to hand back, so it settles as a cancel instead.
   *
   * Answering anything but the current dialog is ignored: an answer computed
   * for a dialog the queue has already moved past — a repeated key, a late
   * cancel racing a user's accept — can never settle the one queued behind it.
   */
  accept(id: number, value?: string): void;
  /** Cancel the dialog with this id, resolving its cancel value. */
  cancel(id: number): void;
  /**
   * Cancel the visible dialog and everything queued, keeping the queue open.
   *
   * Called on session reload: the changeset (and possibly the extension
   * registry) is being swapped out from under the question, so open dialogs
   * resolve their cancel values while later requests stay welcome.
   */
  cancelAll(): void;
  /**
   * Cancel everything and refuse further requests.
   *
   * Called when the review unmounts. The queue stays closed afterwards so a
   * handler that asks during teardown gets an immediate cancel rather than a
   * promise nothing will ever settle.
   */
  shutdown(): void;
  /** Observe changes to `current()`; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Reject a malformed request the same way for every dialog kind. */
function invalid(method: string, problem: string): never {
  throw new Error(`dialogs.${method} ${problem}`);
}

/** Normalize an extension-authored title, or reject it. */
function normalizeTitle(method: string, title: unknown) {
  if (typeof title !== "string" || title.trim().length === 0) {
    invalid(method, "requires a non-empty title.");
  }

  return sanitizeTerminalLine(title.trim());
}

/** Normalize an optional extension-authored label, falling back to Hunk's own. */
function normalizeLabel(label: unknown, fallback: string) {
  if (typeof label !== "string" || label.trim().length === 0) {
    return fallback;
  }

  return sanitizeTerminalLine(label.trim());
}

/**
 * Split an optional body into renderable lines.
 *
 * Authors write body text as prose with newlines in it, so the newlines are
 * honored as line breaks and each resulting line is sanitized on its own —
 * dialog text is third-party and routinely carries repo-controlled fragments,
 * exactly like toast text.
 */
function normalizeBodyLines(body: unknown) {
  if (typeof body !== "string" || body.length === 0) {
    return [];
  }

  return body
    .split("\n")
    .slice(0, MAX_CONFIRM_BODY_LINES)
    .map((line) => sanitizeTerminalLine(line));
}

/** Normalize the choices of a select dialog, or reject them. */
function normalizeOptions(options: unknown) {
  if (!Array.isArray(options) || options.length === 0) {
    invalid("select", "requires at least one option.");
  }

  return options.map((option) => {
    if (typeof option !== "string") {
      invalid("select", "options must all be strings.");
    }

    return sanitizeTerminalLine(option);
  });
}

/**
 * Create the dialog queue one App instance owns.
 *
 * FIFO across every extension: the queue has no notion of who is asking beyond
 * the attribution it renders, so one extension cannot jump ahead of another.
 */
export function createExtensionDialogQueue(): ExtensionDialogQueue {
  /** Pending dialogs, current one first. */
  const pending: {
    request: ExtensionDialogRequest;
    settle: (value: ExtensionDialogResult) => void;
    isLive: () => boolean;
  }[] = [];
  const listeners = new Set<() => void>();
  let closed = false;
  let nextId = 1;

  /** Tell subscribers the visible dialog changed. */
  const notify = () => {
    // Set iteration tolerates a listener unsubscribing itself mid-notify.
    for (const listener of listeners) {
      listener();
    }
  };

  /** The cancel value one request resolves with: `false` for confirm, `null` otherwise. */
  const cancelValueFor = (request: ExtensionDialogRequest): ExtensionDialogResult =>
    request.kind === "confirm" ? false : null;

  /**
   * Queue one request and hand back the promise its handler awaits.
   *
   * Notifies only when the request becomes the visible one, so queueing behind
   * an open dialog does not churn the UI.
   */
  function enqueue<Result extends ExtensionDialogResult>(
    build: (id: number) => ExtensionDialogRequest,
    cancelValue: Result,
    isLive: () => boolean,
  ): Promise<Result> {
    return new Promise<Result>((resolve) => {
      if (closed || !isLive()) {
        resolve(cancelValue);
        return;
      }

      const request = build(nextId);
      nextId += 1;
      const wasIdle = pending.length === 0;
      // The result type is decided by the request kind the caller built, which
      // is the one place both halves are known.
      pending.push({ request, settle: (value) => resolve(value as Result), isLive });
      if (wasIdle) {
        notify();
      }
    });
  }

  /** Resolve every pending dialog with its cancel value. */
  const drainPending = () => {
    const drained = pending.splice(0);
    for (const entry of drained) {
      entry.settle(cancelValueFor(entry.request));
    }

    if (drained.length > 0) {
      notify();
    }
  };

  /** Settle the current dialog and promote whatever was queued behind it. */
  const settleCurrent = (value: ExtensionDialogResult) => {
    const active = pending.shift();
    if (!active) {
      return;
    }

    active.settle(value);
    notify();
  };

  return {
    createDialogs(extensionId: string, options = {}): ExtensionDialogs {
      const isLive = options.isLive ?? (() => true);
      const showAttribution = options.showAttribution !== false;
      return {
        // Async so a validation failure rejects the returned promise instead of
        // throwing synchronously out of the extension's `await`.
        async confirm(options: ExtensionConfirmOptions) {
          const title = normalizeTitle("confirm", options?.title);
          return await enqueue<boolean>(
            (id) => ({
              kind: "confirm",
              id,
              extensionId,
              showAttribution,
              title,
              bodyLines: normalizeBodyLines(options.body),
              confirmLabel: normalizeLabel(options.confirmLabel, DEFAULT_CONFIRM_LABEL),
              cancelLabel: normalizeLabel(options.cancelLabel, DEFAULT_CANCEL_LABEL),
            }),
            false,
            isLive,
          );
        },
        async select(options: ExtensionSelectOptions) {
          const title = normalizeTitle("select", options?.title);
          const choices = normalizeOptions(options.options);
          return await enqueue<string | null>(
            (id) => ({
              kind: "select",
              id,
              extensionId,
              showAttribution,
              title,
              options: choices,
            }),
            null,
            isLive,
          );
        },
        async input(options: ExtensionInputOptions) {
          const title = normalizeTitle("input", options?.title);
          return await enqueue<string | null>(
            (id) => ({
              kind: "input",
              id,
              extensionId,
              showAttribution,
              title,
              placeholder: normalizeLabel(options.placeholder, ""),
              // Sanitized like every other extension-authored string, but not
              // trimmed: the text is the field's starting value, and leading or
              // trailing spaces the extension put there are content.
              initial:
                typeof options.initial === "string" ? sanitizeTerminalLine(options.initial) : "",
            }),
            null,
            isLive,
          );
        },
      };
    },

    current() {
      return pending[0]?.request ?? null;
    },

    accept(id: number, value?: string) {
      const active = pending[0];
      if (!active || active.request.id !== id) {
        return;
      }

      if (!active.isLive()) {
        settleCurrent(cancelValueFor(active.request));
        return;
      }

      if (active.request.kind === "confirm") {
        settleCurrent(true);
        return;
      }

      settleCurrent(value ?? null);
    },

    cancel(id: number) {
      const active = pending[0];
      if (!active || active.request.id !== id) {
        return;
      }

      settleCurrent(cancelValueFor(active.request));
    },

    cancelAll() {
      drainPending();
    },

    shutdown() {
      closed = true;
      drainPending();
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

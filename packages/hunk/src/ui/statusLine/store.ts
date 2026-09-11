/**
 * Holds the status line's state — persistent items and the FIFO prompt queue — as plain
 * observable data with no renderer in it.
 *
 * `App` and `LogApp` each own one store: they subscribe, draw whatever the snapshot reports,
 * and answer the current prompt through `updatePromptValue`, `submitPrompt`, and
 * `cancelPrompt`. Consumers (the host filter, `hunk log` search, extensions) push items and
 * await prompts; nothing here re-probes a callback, which is the failure mode pane
 * availability has with extension-held state.
 *
 * Prompt lifetimes mirror `ctx.dialogs`: one on screen at a time, later requests queue in call
 * order, a reload cancels pending prompts except host requests explicitly retained across content
 * changes, and shutdown settles everything and refuses later requests so no handler is left awaiting.
 */
import { sanitizeTerminalLine } from "../../lib/terminalText";
import type {
  StatusItem,
  StatusLineSnapshot,
  StatusPromptOptions,
  StatusPromptRequest,
} from "./types";

/** How the host scopes and attributes one prompt request. */
export interface StatusPromptRequestOptions {
  /** Keep a host input across content reloads; extension requests never opt into this lifetime. */
  surviveReload?: boolean;
  /** Whether the requester still holds authority; a dead owner cancels rather than asks. */
  isLive?: () => boolean;
  /** Third-party marker painted before the prefix; omitted for host and bundled prompts. */
  attribution?: string | null;
  /** Receives the failure detail of a throwing `onChange`, once per prompt. */
  onChangeFailed?: (detail: string) => void;
}

export interface StatusLineStore {
  getSnapshot(): StatusLineSnapshot;
  subscribe(listener: () => void): () => void;
  /** Set or replace one item, keeping its slot when it already exists. */
  setItem(item: StatusItem): void;
  clearItem(id: string): void;
  /** Remove every item whose id the predicate accepts. */
  clearItems(predicate: (id: string) => boolean): void;
  /**
   * Queue one prompt and return its id alongside its answer.
   *
   * `id` is `null` when the request was refused outright (store shut down, owner dead), in which
   * case `answer` is already `null`. Hosts use the id to submit or cancel their own prompt from
   * focus changes; extensions only ever see `requestPrompt`.
   */
  openPrompt(
    options: StatusPromptOptions,
    requestOptions?: StatusPromptRequestOptions,
  ): { id: number | null; answer: Promise<string | null> };
  /** Queue one prompt; resolves the submitted text, or `null` on cancel, reload, or shutdown. */
  requestPrompt(
    options: StatusPromptOptions,
    requestOptions?: StatusPromptRequestOptions,
  ): Promise<string | null>;
  /** Replace the current prompt's text as the user types; ignored for a non-current id. */
  updatePromptValue(id: number, value: string): void;
  /** Resolve the current prompt with its live value; ignored for a non-current id. */
  submitPrompt(id: number): void;
  /** Resolve the current prompt with `null`; ignored for a non-current id. */
  cancelPrompt(id: number): void;
  /** Cancel reload-scoped prompts while retaining opted-in host inputs and their queue order. */
  cancelReloadPrompts(): void;
  /** Cancel the visible prompt and everything queued, keeping the store open. */
  cancelAllPrompts(): void;
  /** Cancel everything and refuse further prompts. */
  shutdown(): void;
}

interface PendingPrompt {
  surviveReload: boolean;
  request: StatusPromptRequest;
  settle: (value: string | null) => void;
  isLive: () => boolean;
  onChange?: (value: string) => void;
  onChangeFailed?: (detail: string) => void;
  /** Whether a failing `onChange` has already been reported for this prompt. */
  warned: boolean;
}

/** Sanitize optional consumer text, falling back to empty. */
function cleanText(value: unknown) {
  return typeof value === "string" ? sanitizeTerminalLine(value) : "";
}

/** Create the store one surface owns for the life of its mount. */
export function createStatusLineStore(): StatusLineStore {
  const items = new Map<string, StatusItem>();
  const pending: PendingPrompt[] = [];
  const listeners = new Set<() => void>();
  let closed = false;
  let nextId = 1;
  let snapshot: StatusLineSnapshot = { items: [], prompt: null };

  const publish = () => {
    snapshot = { items: [...items.values()], prompt: pending[0]?.request ?? null };
    for (const listener of listeners) listener();
  };

  /** Settle the current prompt and promote whatever was queued behind it. */
  const settleCurrent = (value: string | null) => {
    const active = pending.shift();
    if (!active) return;
    active.settle(value);
    publish();
  };

  /** Resolve every pending prompt with `null`. */
  const drainPending = () => {
    const drained = pending.splice(0);
    for (const entry of drained) entry.settle(null);
    if (drained.length > 0) publish();
  };

  const current = (id: number) => {
    const active = pending[0];
    return active && active.request.id === id ? active : undefined;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setItem(item) {
      items.set(item.id, item);
      publish();
    },
    clearItem(id) {
      if (items.delete(id)) publish();
    },
    clearItems(predicate) {
      const removed = Array.from(items.keys()).filter(predicate);
      for (const id of removed) items.delete(id);
      if (removed.length > 0) publish();
    },
    openPrompt(options, requestOptions = {}) {
      const isLive = requestOptions.isLive ?? (() => true);
      if (closed || !isLive()) {
        return { id: null, answer: Promise.resolve(null) };
      }
      const request: StatusPromptRequest = {
        id: nextId,
        prefix: cleanText(options.prefix),
        placeholder: cleanText(options.placeholder),
        value: cleanText(options.initial),
        attribution: requestOptions.attribution ? cleanText(requestOptions.attribution) : null,
      };
      nextId += 1;
      const answer = new Promise<string | null>((resolve) => {
        const wasIdle = pending.length === 0;
        pending.push({
          request,
          surviveReload: requestOptions.surviveReload === true,
          settle: resolve,
          isLive,
          onChange: typeof options.onChange === "function" ? options.onChange : undefined,
          onChangeFailed: requestOptions.onChangeFailed,
          warned: false,
        });
        // Queueing behind an open prompt does not change what is on screen.
        if (wasIdle) publish();
      });
      return { id: request.id, answer };
    },
    requestPrompt(options, requestOptions) {
      return this.openPrompt(options, requestOptions).answer;
    },
    updatePromptValue(id, value) {
      const active = current(id);
      if (!active) return;
      active.request = { ...active.request, value };
      publish();
      if (!active.onChange) return;
      try {
        active.onChange(value);
      } catch (error) {
        if (active.warned) return;
        active.warned = true;
        active.onChangeFailed?.(
          error instanceof Error ? error.message || error.name : String(error),
        );
      }
    },
    submitPrompt(id) {
      const active = current(id);
      if (!active) return;
      settleCurrent(active.isLive() ? active.request.value : null);
    },
    cancelPrompt(id) {
      if (current(id)) settleCurrent(null);
    },
    cancelReloadPrompts() {
      const cancelled = pending.filter((entry) => !entry.surviveReload);
      if (cancelled.length === 0) return;
      const retained = pending.filter((entry) => entry.surviveReload);
      pending.splice(0, pending.length, ...retained);
      for (const entry of cancelled) entry.settle(null);
      publish();
    },
    cancelAllPrompts: drainPending,
    shutdown() {
      closed = true;
      drainPending();
    },
  };
}

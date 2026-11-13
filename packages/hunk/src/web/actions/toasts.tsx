/** @jsxImportSource react */
/**
 * A small live region for outcomes that have no place nearer to where the person acted.
 *
 * A failed save stays on its composer and a refused delete on its card; what remains — a
 * refresh that failed, a filter the session refused, a toggle that did not apply — is shown here
 * and announced politely (`aria-live`). Messages come from the shared error catalog; this module
 * only holds and times them.
 */
import { useSyncExternalStore } from "react";

/** One message in the region. */
export interface WebToast {
  id: number;
  tone: "info" | "error";
  message: string;
}

/** How long a toast stays before it leaves on its own. */
export const TOAST_LIFETIME_MS = 6_000;

/** The page's toasts, observable by React. */
export class WebToasts {
  private toasts: readonly WebToast[] = [];
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  getSnapshot = () => this.toasts;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Show one message; it dismisses itself after `TOAST_LIFETIME_MS`. */
  show(message: string, tone: WebToast["tone"] = "error") {
    const toast = { id: this.nextId++, tone, message };
    this.set([...this.toasts, toast].slice(-4));
    setTimeout(() => this.dismiss(toast.id), TOAST_LIFETIME_MS);
    return toast.id;
  }

  dismiss(id: number) {
    if (this.toasts.some((toast) => toast.id === id)) {
      this.set(this.toasts.filter((toast) => toast.id !== id));
    }
  }

  private set(next: readonly WebToast[]) {
    this.toasts = next;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

/** The toast region, always mounted so screen readers hear what arrives. */
export function ToastRegion({ toasts }: { toasts: WebToasts }) {
  const shown = useSyncExternalStore(toasts.subscribe, toasts.getSnapshot);
  return (
    <div className="toast-region" aria-live="polite" role="status" data-testid="toasts">
      {shown.map((toast) => (
        <div key={toast.id} className="toast" data-tone={toast.tone}>
          <span>{toast.message}</span>
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss"
            onClick={() => toasts.dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

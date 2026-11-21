/** @jsxImportSource react */
/**
 * Draws one modal dialog over the page: a backdrop and an `aria-modal` dialog box.
 *
 * Every modal on the page (help, the command palette, go to file) is drawn through this, so
 * the modal rules live here once: while any is open the page's shortcuts are suspended
 * (`pageModalOpen`, which the keyboard dispatch checks), Tab and Shift+Tab cycle within the
 * dialog instead of leaving it, and a click on the backdrop closes it. The dialog's own keys
 * (Escape, arrows, Enter) stay with its content; the caller that opened it restores focus.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

/** How many modal dialogs are open right now. */
let openModals = 0;

/** Whether a modal dialog is open, so page shortcuts stand down. */
export function pageModalOpen() {
  return openModals > 0;
}

/** What can take focus inside a dialog, in tab order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalDialogProps {
  className: string;
  testId: string;
  onClose: () => void;
  /** Labels the dialog: a visible heading's id, or a text label. */
  labelledBy?: string;
  label?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

/** One modal dialog. */
export function ModalDialog(props: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    openModals += 1;
    return () => {
      openModals -= 1;
    };
  }, []);

  /** Keep Tab inside the dialog, wrapping at either end. */
  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={props.className}
        role="dialog"
        aria-modal="true"
        {...(props.labelledBy ? { "aria-labelledby": props.labelledBy } : {})}
        {...(props.label ? { "aria-label": props.label } : {})}
        data-testid={props.testId}
        onKeyDown={(event) => {
          trapTab(event);
          props.onKeyDown?.(event);
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

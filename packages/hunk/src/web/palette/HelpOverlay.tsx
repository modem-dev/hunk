/** @jsxImportSource react */
/**
 * Draws the keyboard help: the shared help sections, keyed with this page's chords.
 *
 * A modal dialog with a heading per section and a two-column table per section; Escape, the
 * close button, `?` again, or a click outside closes it, and the caller restores focus.
 */
import { useEffect, useRef } from "react";
import { ModalDialog } from "./ModalDialog";
import type { WebHelpSection } from "./paletteEntries";

export interface HelpOverlayProps {
  sections: readonly WebHelpSection[];
  onClose: () => void;
}

/** The help dialog. */
export function HelpOverlay({ sections, onClose }: HelpOverlayProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => closeRef.current?.focus(), []);

  return (
    <ModalDialog
      className="help-overlay"
      labelledBy="help-title"
      testId="help-overlay"
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "?") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="help-header">
        <h2 id="help-title">Keyboard shortcuts</h2>
        <button ref={closeRef} type="button" className="tool-button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="help-sections">
        {sections.map((section) => (
          <section key={section.title} className="help-section" aria-label={section.title}>
            <h3>{section.title}</h3>
            <table>
              <tbody>
                {section.rows.map((row) => (
                  <tr key={`${row.keys}:${row.description}`}>
                    <th scope="row">
                      <kbd>{row.keys}</kbd>
                    </th>
                    <td>{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </ModalDialog>
  );
}

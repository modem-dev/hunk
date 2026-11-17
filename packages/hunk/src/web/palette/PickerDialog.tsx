/** @jsxImportSource react */
/**
 * Draws one modal picker: a search field over a ranked list, for the palette and go-to-file.
 *
 * The field is an ARIA combobox that owns a listbox; the active option follows the arrow
 * keys and is announced through `aria-activedescendant`, so focus never leaves the field.
 * Enter or a click picks the active row; Escape or a click outside closes the dialog, and the
 * caller restores focus. Ranking belongs to the caller (`rank`), so both pickers share this
 * component and differ only in their rows.
 *
 * A caller may name each row's section (`sectionOf`). While the query is empty the rows are
 * gathered under section headings, in order of first appearance, and each row drops its own
 * category label; once the user types, the list is one flat list in the caller's ranking.
 * Headings sit in `role="group"` wrappers labelled by the heading, so the listbox stays valid
 * and arrow keys only ever visit options.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ModalDialog } from "./ModalDialog";

export interface PickerDialogProps<T> {
  label: string;
  placeholder: string;
  items: readonly T[];
  rank: (items: readonly T[], query: string) => T[];
  itemKey: (item: T) => string;
  /** Draws one row; `sectioned` is true while a heading already names the row's category. */
  renderItem: (item: T, context: { sectioned: boolean }) => ReactNode;
  /** The section heading a row belongs under while the query is empty. */
  sectionOf?: (item: T) => string;
  onPick: (item: T) => void;
  onClose: () => void;
  /** Shown when nothing matches. */
  empty: string;
  testId: string;
}

/** The most rows the list draws; typing narrows the rest. */
const MAX_ROWS = 200;

/** One picker dialog. */
export function PickerDialog<T>(props: PickerDialogProps<T>) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const { items, rank } = props;
  const { sectionOf } = props;
  const sectioned = sectionOf !== undefined && query.trim() === "";
  const { ranked, groups } = useMemo(() => {
    const ordered = rank(items, query).slice(0, MAX_ROWS);
    if (!sectioned || !sectionOf) return { ranked: ordered, groups: null };
    // Group by section in order of first appearance; each group keeps the caller's ranking.
    const byTitle = new Map<string, T[]>();
    for (const item of ordered) {
      const title = sectionOf(item);
      byTitle.set(title, [...(byTitle.get(title) ?? []), item]);
    }
    const grouped = [...byTitle].map(([title, rows]) => ({ title, rows }));
    return { ranked: grouped.flatMap((group) => group.rows), groups: grouped };
  }, [items, rank, query, sectioned, sectionOf]);
  const activeIndex = Math.min(active, Math.max(0, ranked.length - 1));
  const optionId = (index: number) => `${listId}-option-${index}`;

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const pick = (index: number) => {
    const item = ranked[index];
    if (item !== undefined) props.onPick(item);
  };

  const renderOption = (item: T, inSection: boolean) => {
    const index = ranked.indexOf(item);
    return (
      <div
        key={props.itemKey(item)}
        id={optionId(index)}
        data-index={index}
        role="option"
        aria-selected={index === activeIndex}
        className="picker-option"
        onMouseMove={() => index !== activeIndex && setActive(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => pick(index)}
      >
        {props.renderItem(item, { sectioned: inSection })}
      </div>
    );
  };

  return (
    <ModalDialog
      className="picker"
      label={props.label}
      testId={props.testId}
      onClose={props.onClose}
    >
      <input
        ref={inputRef}
        className="picker-input"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={props.label}
        aria-activedescendant={ranked.length > 0 ? optionId(activeIndex) : undefined}
        placeholder={props.placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((activeIndex + 1) % Math.max(1, ranked.length));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((activeIndex - 1 + ranked.length) % Math.max(1, ranked.length));
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(activeIndex);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <div
        ref={listRef}
        id={listId}
        className="picker-list"
        role="listbox"
        aria-label={props.label}
      >
        {groups
          ? groups.map((group, groupIndex) => (
              <div
                key={group.title}
                className="picker-group"
                role="group"
                aria-labelledby={`${listId}-section-${groupIndex}`}
              >
                <div
                  id={`${listId}-section-${groupIndex}`}
                  className="picker-section"
                  data-testid="picker-section"
                >
                  {group.title}
                </div>
                {group.rows.map((item) => renderOption(item, true))}
              </div>
            ))
          : ranked.map((item) => renderOption(item, false))}
      </div>
      {ranked.length === 0 ? <p className="picker-empty">{props.empty}</p> : null}
    </ModalDialog>
  );
}

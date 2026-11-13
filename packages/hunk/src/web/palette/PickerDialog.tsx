/** @jsxImportSource react */
/**
 * Draws one modal picker: a search field over a ranked list, for the palette and go-to-file.
 *
 * The field is an ARIA combobox that owns a listbox; the active option follows the arrow
 * keys and is announced through `aria-activedescendant`, so focus never leaves the field.
 * Enter or a click picks the active row; Escape or a click outside closes the dialog, and the
 * caller restores focus. Ranking belongs to the caller (`rank`), so both pickers share this
 * component and differ only in their rows.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

export interface PickerDialogProps<T> {
  label: string;
  placeholder: string;
  items: readonly T[];
  rank: (items: readonly T[], query: string) => T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
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
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();
  const { items, rank } = props;
  const ranked = useMemo(() => rank(items, query).slice(0, MAX_ROWS), [items, rank, query]);
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

  return (
    <div
      className="picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        className="picker"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        data-testid={props.testId}
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
        <ul
          ref={listRef}
          id={listId}
          className="picker-list"
          role="listbox"
          aria-label={props.label}
        >
          {ranked.map((item, index) => (
            <li
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
              {props.renderItem(item)}
            </li>
          ))}
        </ul>
        {ranked.length === 0 ? <p className="picker-empty">{props.empty}</p> : null}
      </div>
    </div>
  );
}

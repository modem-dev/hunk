/**
 * Shapes of the host-owned status line: persistent text items, one inline prompt, and the
 * keyboard-mode badge.
 *
 * Items are declarative text in symbolic colors so the host can measure and truncate them without
 * a theme and paint them with the active one. The prompt is a real focused input the host draws;
 * consumers only describe it and await its answer.
 */
import type { ExtensionFileViewSpan } from "../../extension-api/types";

/** One symbolic run of status text; the same span vocabulary file views use. */
export type StatusSpan = ExtensionFileViewSpan;

/** One persistent status contribution, keyed by a globally unique id. */
export interface StatusItem {
  readonly id: string;
  readonly spans: readonly StatusSpan[];
  /** Defaults to "left". Right items sit beside the host badge. */
  readonly alignment?: "left" | "right";
  /** Higher survives longer when the row overflows. Defaults to 0. */
  readonly priority?: number;
}

/** What a consumer asks of the inline prompt. */
export interface StatusPromptOptions {
  /** Painted before the input and not part of the value, e.g. `/` or `filter:`. */
  prefix?: string;
  placeholder?: string;
  initial?: string;
  /** Called on every edit, for consumers that react while the user types. */
  onChange?(value: string): void;
}

/** One prompt the host should draw, normalized from what a consumer asked for. */
export interface StatusPromptRequest {
  /** Monotonic per-store id, so answer state never carries between two prompts. */
  readonly id: number;
  readonly prefix: string;
  readonly placeholder: string;
  /** Live text of the field; the store updates it as the user types. */
  readonly value: string;
  /** Marker naming a third-party owner, painted before the prefix. `null` for host and bundled prompts. */
  readonly attribution: string | null;
}

/** The status line as one surface reads it. */
export interface StatusLineSnapshot {
  readonly items: readonly StatusItem[];
  readonly prompt: StatusPromptRequest | null;
}

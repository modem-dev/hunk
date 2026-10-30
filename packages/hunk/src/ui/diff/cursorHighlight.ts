/** Defines cursor paint inputs and matches them to stable planned-row identities. */
import type { CursorLine } from "../../core/run/commandInputs";

/** Cursor paint inputs shared by review planning and mounted code rows. */
export interface CursorHighlight {
  /** The render plan anchor of the row the cursor rests on, shared with reveal lookups. */
  stableKey: string;
  style: Exclude<CursorLine, "off">;
  /** Which half of a split row the cursor sits on, and where a note would anchor. */
  side: "old" | "new";
}

/** Report whether one planned row carries the anchor the cursor rests on. */
export function plannedRowMatchesCursor(
  row: { stableKey: string; stableAliasKeys?: readonly string[] },
  cursor: CursorHighlight | undefined,
) {
  return (
    cursor !== undefined &&
    (row.stableKey === cursor.stableKey || row.stableAliasKeys?.includes(cursor.stableKey) === true)
  );
}

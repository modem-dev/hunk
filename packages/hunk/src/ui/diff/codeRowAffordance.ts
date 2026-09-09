/** Derives code-row controls shared by hover state and mounted rendering. */
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { CodeDiffRow } from "./reviewRenderPlan";

/** Text painted for the code-row add-note affordance. */
export const CODE_ROW_ADD_NOTE_BADGE_TEXT = "[+]";

/** Terminal columns reserved for the code-row add-note affordance. */
export const CODE_ROW_ADD_NOTE_BADGE_WIDTH = CODE_ROW_ADD_NOTE_BADGE_TEXT.length;

/** Resolve the preferred line target for a code row's add-note action. */
export function resolveCodeRowNoteTarget(row: CodeDiffRow): UserNoteLineTarget | undefined {
  if (row.type === "split-line") {
    if (row.right.lineNumber !== undefined) {
      return { side: "new", line: row.right.lineNumber };
    }
    return row.left.lineNumber !== undefined
      ? { side: "old", line: row.left.lineNumber }
      : undefined;
  }

  if (row.cell.newLineNumber !== undefined) {
    return { side: "new", line: row.cell.newLineNumber };
  }
  return row.cell.oldLineNumber !== undefined
    ? { side: "old", line: row.cell.oldLineNumber }
    : undefined;
}

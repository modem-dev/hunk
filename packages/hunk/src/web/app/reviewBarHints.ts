/**
 * Lists the review bar's key hints: the commands a reviewer reaches for most, each shown with
 * the key the page's resolved keymap gives it.
 *
 * The commands are named by id and the keys are never written here: the caller reads each
 * command's first chord from the page keymap (the catalog's defaults with the user's
 * `[keybindings]` folded in by the host, plus the page's own chords), so a remap shows up in
 * the bar as it does in the terminal. A pair shows as two keys and one label; a command with no
 * chord is left out, and a pair with neither bound drops entirely.
 */
import type { WebImplementedCommandId } from "../commands/webCommandTable";
import type { WebLocalCommandId } from "../commands/webLocalCommands";

/** A command the bar may hint, from the shared catalog or the page's own list. */
type ReviewBarCommandId = WebImplementedCommandId | WebLocalCommandId;

/** One hint as the bar draws it: its keys, in order, and a one- or two-word label. */
export interface ReviewBarHint {
  id: string;
  keys: string[];
  label: string;
}

/** The hinted commands in the order the bar shows them. */
const REVIEW_BAR_HINT_COMMANDS: readonly {
  id: string;
  label: string;
  commands: readonly ReviewBarCommandId[];
}[] = [
  { id: "hunk", label: "hunk", commands: ["hunk.review.previousHunk", "hunk.review.nextHunk"] },
  { id: "file", label: "file", commands: ["hunk.review.previousFile", "hunk.review.nextFile"] },
  {
    id: "annotated",
    label: "annotated",
    commands: ["hunk.review.previousAnnotatedHunk", "hunk.review.nextAnnotatedHunk"],
  },
  { id: "note", label: "add note", commands: ["hunk.review.startNote"] },
  { id: "viewed", label: "viewed", commands: ["hunk.web.toggleViewed"] },
];

/** The bar's hints, given the first chord label of each command on this page. */
export function reviewBarHints(
  firstChord: (commandId: ReviewBarCommandId) => string | undefined,
): ReviewBarHint[] {
  return REVIEW_BAR_HINT_COMMANDS.flatMap(({ id, label, commands }) => {
    const keys = commands.flatMap((command) => {
      const chord = firstChord(command);
      return chord ? [chord] : [];
    });
    return keys.length > 0 ? [{ id, keys, label }] : [];
  });
}

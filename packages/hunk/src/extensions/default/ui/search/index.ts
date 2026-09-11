/**
 * Registers Hunk's bundled `less`-style content search on `/`, `n`, and `N`.
 *
 * `/` opens the status-line prompt; Enter jumps to the next hunk matching the typed text, and
 * `n` / `N` repeat it in either direction, wrapping. The status row then reports where the
 * review landed, and a registered line highlighter marks every match inside the diff with the
 * landed line as the one `"current"` mark. Stepping is hunk-granular so each press visibly
 * moves, while the jump itself is `revealLine` on the first matching line so a hit deep inside
 * a tall hunk lands on the match rather than the hunk's anchor.
 *
 * The session is process-wide (bundled factories run once), so each command hands it the
 * visible files from `ctx.selection.files`; nothing here shadows the changeset or closes over a
 * review. Marks are a pure derivation of the session's query and current target, so every path
 * that changes either asks the host to re-derive through `ctx.highlights.refresh`.
 */
import type {
  ExtensionCommandContext,
  ExtensionReviewNavigation,
  ExtensionReviewSelection,
} from "../../../../extension-api/types";
import type { ExtensionFactory } from "../../../types";
import type { SearchPosition, SearchTarget } from "./search";
import { createSearchSession, formatOutcomeSpans, type SearchOutcome } from "./session";

export const BUNDLED_SEARCH_HIGHLIGHTER_ID = "search.matches";
export const BUNDLED_SEARCH_STATUS_ITEM_ID = "search.status";
export const BUNDLED_SEARCH_FIND_COMMAND_ID = "search.find";
export const BUNDLED_SEARCH_NEXT_COMMAND_ID = "search.next";
export const BUNDLED_SEARCH_PREVIOUS_COMMAND_ID = "search.previous";

/** Where the review is pointing, as the search compares positions. */
function positionOf(selection: ExtensionReviewSelection): SearchPosition {
  return { fileId: selection.file?.id ?? null, hunkIndex: selection.hunkIndex };
}

/**
 * Jump to one target: the exact line when the patch numbered it, else the hunk.
 *
 * `revealLine` itself degrades to the containing hunk when the review draws no row for the
 * line, so the fallback here is only for a match the patch never numbered at all.
 */
function performNavigation(navigation: ExtensionReviewNavigation, target: SearchTarget) {
  if (target.line.lineNumber === null) {
    navigation.selectHunk(target.fileId, target.hunkIndex);
    return;
  }

  navigation.revealLine(target.fileId, target.line.side, target.line.lineNumber);
}

/** Apply one outcome: navigate on a hit, re-derive marks, and report on the status row. */
function deliver(ctx: ExtensionCommandContext, outcome: SearchOutcome) {
  if (outcome.kind === "moved") {
    performNavigation(ctx.navigation, outcome.target);
  }
  ctx.highlights.refresh(BUNDLED_SEARCH_HIGHLIGHTER_ID);
  ctx.statusLine.set({
    id: BUNDLED_SEARCH_STATUS_ITEM_ID,
    spans: formatOutcomeSpans(outcome),
    priority: 1,
  });
}

const registerBundledSearch: ExtensionFactory = (hunk) => {
  const session = createSearchSession({ mode: "literal" });

  hunk.registerLineHighlighter({
    id: BUNDLED_SEARCH_HIGHLIGHTER_ID,
    highlight: ({ file }) => session.marksFor(file),
  });

  hunk.registerCommand(
    { id: BUNDLED_SEARCH_FIND_COMMAND_ID, title: "Search diff content", key: "/" },
    async (ctx) => {
      // The prompt reopens on the last query so Enter repeats it and Escape clears it first.
      const query = await ctx.prompts.line({
        prefix: "/",
        placeholder: "search diff",
        initial: session.query ?? "",
      });
      if (query === null) {
        return;
      }

      if (query.trim().length === 0) {
        // Submitting an emptied prompt is the way out of a search: marks and the
        // status item go with the query rather than reserving the row forever.
        session.clear();
        ctx.highlights.refresh(BUNDLED_SEARCH_HIGHLIGHTER_ID);
        ctx.statusLine.clear(BUNDLED_SEARCH_STATUS_ITEM_ID);
        return;
      }

      // The selection is frozen at `/`, so the search starts from where it was pressed.
      deliver(ctx, session.search(query, ctx.selection.files, positionOf(ctx.selection)));
    },
  );

  hunk.registerCommand(
    { id: BUNDLED_SEARCH_NEXT_COMMAND_ID, title: "Next search match", key: "n" },
    (ctx) => {
      deliver(ctx, session.repeat("forward", ctx.selection.files, positionOf(ctx.selection)));
    },
  );

  hunk.registerCommand(
    { id: BUNDLED_SEARCH_PREVIOUS_COMMAND_ID, title: "Previous search match", key: "N" },
    (ctx) => {
      deliver(ctx, session.repeat("backward", ctx.selection.files, positionOf(ctx.selection)));
    },
  );
};

export default registerBundledSearch;

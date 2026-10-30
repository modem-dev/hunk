import type {
  ExtensionCommandContext,
  ExtensionReviewNavigation,
  ExtensionReviewSnapshot,
  ExtensionReviewSnapshotFile,
  ExtensionReviewSnapshotNote,
  HunkExtensionAPI,
} from "hunkdiff/extension";

export interface ReviewNoteChoice {
  label: string;
  noteId: string;
}

/** Resolve a sanitized dialog answer through the unique ordinal prefix we control. */
export function selectedReviewNoteChoice(choices: readonly ReviewNoteChoice[], selected: string) {
  const ordinal = /^(\d+)\.\s/u.exec(selected)?.[1];
  if (ordinal === undefined) return undefined;
  return choices[Number(ordinal) - 1];
}

/** Collapse note text into one compact selector label. */
function oneLineSummary(summary: string) {
  return summary.replace(/\s+/gu, " ").trim() || "Untitled note";
}

/** Describe one note's preferred source location without deriving a replacement anchor. */
function noteLocation(note: ExtensionReviewSnapshotNote) {
  const preferred = note.anchor.preferred;
  return preferred ? `:${preferred.line} (${preferred.side})` : "";
}

/** Build unique selector choices in the authoritative saved-note order. */
export function buildReviewNoteChoices(snapshot: ExtensionReviewSnapshot): ReviewNoteChoice[] {
  const pathByFileKey = new Map(snapshot.files.map((file) => [file.fileKey, file.path]));
  return snapshot.notes.map((note, index) => {
    const path = pathByFileKey.get(note.fileKey) ?? `retired file ${note.fileKey}`;
    return {
      label: `${index + 1}. [${note.resolution}] ${path}${noteLocation(note)} — ${oneLineSummary(note.summary)}`,
      noteId: note.id,
    };
  });
}

/** Preserve an authoritative hunk fallback while requesting the note's exact line. */
export function navigateToSavedReviewNote(
  navigation: ExtensionReviewNavigation,
  file: ExtensionReviewSnapshotFile,
  note: ExtensionReviewSnapshotNote,
) {
  const ownerHunkIndex = note.anchor.ownerHunkIndex;
  if (ownerHunkIndex !== undefined) {
    navigation.selectHunk(file.runtimeId, ownerHunkIndex);
  }

  const preferred = note.anchor.preferred;
  if (preferred) {
    // The line may belong to an expanded gap that has since collapsed. Selecting its
    // authoritative owner first leaves a useful landing even when exact reveal is refused.
    navigation.revealLine(file.runtimeId, preferred.side, preferred.line);
  } else if (ownerHunkIndex === undefined) {
    navigation.selectFile(file.runtimeId);
  }
}

/** Navigate to the current authoritative location for one saved note. */
function revealSavedNote(ctx: ExtensionCommandContext, noteId: string) {
  const current = ctx.review.snapshot();
  if (!current) {
    ctx.notify("The review changed; open the note navigator again", "warning");
    return;
  }

  const note = current.notes.find((candidate) => candidate.id === noteId);
  if (!note) {
    ctx.notify("That saved note no longer exists", "warning");
    return;
  }
  if (note.resolution === "orphaned") {
    ctx.notify("That note is orphaned and has no current review location", "warning");
    return;
  }

  const file = current.files.find((candidate) => candidate.fileKey === note.fileKey);
  if (!file) {
    ctx.notify("That note's file is no longer in the review", "warning");
    return;
  }

  navigateToSavedReviewNote(ctx.navigation, file, note);
}

/** Register a complete saved-note picker backed by authoritative review snapshots. */
export default function registerReviewNoteNavigator(hunk: HunkExtensionAPI) {
  hunk.registerCommand(
    { id: "navigate", title: "Navigate saved review note…", key: "f8" },
    async (ctx) => {
      const snapshot = ctx.review.snapshot();
      if (!snapshot) {
        ctx.notify("The current review is unavailable to this command", "warning");
        return;
      }

      const choices = buildReviewNoteChoices(snapshot);
      if (choices.length === 0) {
        ctx.notify("This review has no saved notes");
        return;
      }

      const selected = await ctx.dialogs.select({
        title: "Navigate saved review note",
        options: choices.map((choice) => choice.label),
      });
      if (selected === null) return;

      const choice = selectedReviewNoteChoice(choices, selected);
      if (choice) revealSavedNote(ctx, choice.noteId);
    },
  );
}

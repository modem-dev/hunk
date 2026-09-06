import type { Hunk } from "@pierre/diffs";
import type { DiffFile } from "../../core/changeset/model";
import type { ReviewNoteSource } from "../../core/run/commandInputs";
import type { AgentAnnotation } from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { reviewAnnotationOverlapsHunk } from "../../core/review/annotations";
import { resolveReviewNoteAnchor, reviewGapOwnerHunkIndex } from "../../core/review/anchors";
import type { ReviewHunkSpan } from "../../core/review/geometry";
import type { ReviewLineAddressV1, ReviewRangeAnchorV1 } from "../../core/review/types";
import { fileLabel } from "./files";

export interface VisibleAgentNote {
  id: string;
  annotation: AgentAnnotation;
  /**
   * Where this note hangs, as the shared resolver decided it: the owning hunk plus the
   * line the card sits beside. Render planning places the card from this and never from
   * range containment against the rows it happens to have drawn.
   */
  anchor: ReviewRangeAnchorV1;
  source?: ReviewNoteSource | "draft";
  editable?: boolean;
  /** Shared semantic relationship metadata; static sidecars omit it. */
  thread?: {
    noteId: string;
    parentId?: string;
    depth: number;
    hasNextSibling?: boolean;
    ancestorHasNextSibling?: readonly boolean[];
  };
  /** Explicit capabilities for this card; source labels do not grant authority. */
  actions?: {
    onEdit?: () => void;
    onReply?: () => void;
    onDelete?: () => void;
  };
  draft?: {
    body: string;
    focused: boolean;
    onBlur?: () => void;
    onCancel: () => void;
    onFocus?: () => void;
    onInput: (value: string) => void;
    onSave: () => void;
  };
}

export interface AnnotationAnchor {
  side: "old" | "new";
  lineNumber: number;
}

/** Build the source and author label shown for one inline note. */
export function inlineNoteTitle(annotation: AgentAnnotation, noteIndex: number, noteCount: number) {
  if (annotation.source === "user-draft") {
    return sanitizeTerminalLine(annotation.title?.trim() ?? "") || "Draft note";
  }

  const source = reviewNoteSource(annotation);
  const author = sanitizeTerminalLine(annotation.author?.trim() ?? "");
  const label = source === "user" ? "Your note" : author ? `${author} note` : "Agent note";
  return noteCount > 1 ? `${label} ${noteIndex + 1}/${noteCount}` : label;
}

/** Resolve the user-facing source for one inline note annotation. */
export function reviewNoteSource(annotation: AgentAnnotation): ReviewNoteSource {
  if (annotation.source === "user") {
    return "user";
  }

  if (annotation.source === "mcp" || annotation.source === "agent") {
    return "agent";
  }

  return "ai";
}

/** Return the annotations relevant to the currently selected hunk. */
export function getSelectedAnnotations(file: DiffFile | undefined, hunk: Hunk | undefined) {
  if (!file?.agent || !hunk) {
    return [];
  }

  return file.agent.annotations.filter((annotation) =>
    reviewAnnotationOverlapsHunk(annotation, hunk),
  );
}

/** Resolve the primary visual anchor for an annotation. */
export function annotationAnchor(annotation: AgentAnnotation): AnnotationAnchor | null {
  if (annotation.newRange) {
    return {
      side: "new",
      lineNumber: annotation.newRange[0],
    };
  }

  if (annotation.oldRange) {
    return {
      side: "old",
      lineNumber: annotation.oldRange[0],
    };
  }

  return null;
}

/** One note's declared target, from the surface that knows where the note was written. */
export interface VisibleNoteTarget extends ReviewLineAddressV1 {
  hunkIndex: number;
}

/**
 * Builds one note the review stream draws, resolving where it hangs through core.
 *
 * Every kind of note goes through here — sidecar annotations, agent live comments, the
 * reviewer's own notes, and the open draft — so ownership is decided once by the shared
 * resolver. A note that declares its target keeps it; one that only carries ranges hangs
 * from the line those ranges start at, and from the hunk owning the gap that line falls
 * in when no hunk contains it at all.
 */
export function createVisibleAgentNote(
  hunks: readonly ReviewHunkSpan[],
  note: Omit<VisibleAgentNote, "anchor"> & { target?: VisibleNoteTarget },
): VisibleAgentNote {
  const { target, ...visible } = note;
  const rangeAnchor = annotationAnchor(note.annotation);
  const preferred: ReviewLineAddressV1 | undefined = target
    ? { side: target.side, line: target.line }
    : rangeAnchor
      ? { side: rangeAnchor.side, line: rangeAnchor.lineNumber }
      : undefined;
  const fallbackOwnerHunkIndex =
    target?.hunkIndex ??
    (preferred ? reviewGapOwnerHunkIndex(hunks, preferred.side, preferred.line) : undefined);

  return {
    ...visible,
    anchor: resolveReviewNoteAnchor(hunks, {
      ...(note.annotation.oldRange ? { oldRange: note.annotation.oldRange } : {}),
      ...(note.annotation.newRange ? { newRange: note.annotation.newRange } : {}),
      ...(preferred ? { preferred } : {}),
      ...(fallbackOwnerHunkIndex !== undefined ? { fallbackOwnerHunkIndex } : {}),
    }),
  };
}

function formatGithubStyleRange(prefix: "L" | "R", range: [number, number]) {
  return range[0] === range[1]
    ? `${prefix}${range[0]}`
    : `${prefix}${range[0]}–${prefix}${range[1]}`;
}

/** Build a concise GitHub-style file-and-line label for inline note rows. */
export function annotationRangeLabel(annotation: AgentAnnotation, file?: DiffFile) {
  const locationParts: string[] = [];

  if (annotation.oldRange) {
    locationParts.push(formatGithubStyleRange("L", annotation.oldRange));
  }

  if (annotation.newRange) {
    locationParts.push(formatGithubStyleRange("R", annotation.newRange));
  }

  const location = locationParts.join(" → ") || "hunk";
  return file ? `${fileLabel(file)} ${location}` : location;
}

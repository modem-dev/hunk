import type { Hunk } from "@pierre/diffs";
import type { AgentAnnotation, DiffFile, ReviewNoteSource } from "../../core/types";
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
  draft?: {
    body: string;
    focused: boolean;
    onBlur?: () => void;
    onCancel: () => void;
    onFocus?: () => void;
    onInput: (value: string) => void;
    onSave: () => void;
  };
  onRemove?: () => void;
}

export interface AnnotationAnchor {
  side: "old" | "new";
  lineNumber: number;
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

/** Format an inclusive line range for note labels. */
function formatRange(range: [number, number]) {
  return range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`;
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

/** Build the compact file-and-lines label shown on a framed agent note card. */
export function annotationLocationLabel(file: DiffFile, annotation: AgentAnnotation) {
  const locationParts: string[] = [];

  if (annotation.oldRange) {
    locationParts.push(`-${formatRange(annotation.oldRange)}`);
  }

  if (annotation.newRange) {
    locationParts.push(`+${formatRange(annotation.newRange)}`);
  }

  const location = locationParts.length > 0 ? ` ${locationParts.join(" ")}` : "";
  return `${fileLabel(file)}${location}`;
}

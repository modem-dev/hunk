import type { Hunk } from "@pierre/diffs";
import type { AgentAnnotation, DiffFile, ReviewNoteSource } from "../../core/types";
import { hunkLineRange } from "../../core/liveComments";
import { fileLabel } from "./files";

export interface VisibleAgentNote {
  id: string;
  annotation: AgentAnnotation;
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

/** Return whether a note should remain visible when the AI note layer is hidden. */
export function alwaysShowReviewNote(annotation: AgentAnnotation) {
  return reviewNoteSource(annotation) === "user";
}

/** Check whether two inclusive line ranges overlap. */
function overlap(rangeA: [number, number], rangeB: [number, number]) {
  return rangeA[0] <= rangeB[1] && rangeB[0] <= rangeA[1];
}

/** Check whether an annotation belongs to the visible span of a hunk. */
function annotationOverlapsHunk(annotation: AgentAnnotation, hunk: Hunk) {
  const hunkRange = hunkLineRange(hunk);

  if (annotation.newRange && overlap(annotation.newRange, hunkRange.newRange)) {
    return true;
  }

  if (annotation.oldRange && overlap(annotation.oldRange, hunkRange.oldRange)) {
    return true;
  }

  return false;
}

/** Return the annotations relevant to the currently selected hunk. */
export function getSelectedAnnotations(file: DiffFile | undefined, hunk: Hunk | undefined) {
  if (!file?.agent || !hunk) {
    return [];
  }

  return file.agent.annotations.filter((annotation) => annotationOverlapsHunk(annotation, hunk));
}

/** Mark which hunks in a file have any agent annotations attached. */
export function getAnnotatedHunkIndices(file: DiffFile | undefined) {
  const annotated = new Set<number>();
  if (!file?.agent) {
    return annotated;
  }

  file.metadata.hunks.forEach((hunk, index) => {
    if (file.agent?.annotations.some((annotation) => annotationOverlapsHunk(annotation, hunk))) {
      annotated.add(index);
    }
  });

  return annotated;
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

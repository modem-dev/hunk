import type { Hunk } from "@pierre/diffs";
import type { AgentAnnotation, DiffFile } from "../../core/types";
import { fileLabel } from "./files";

export interface VisibleAgentNote {
  id: string;
  annotation: AgentAnnotation;
}

export interface AnnotationAnchor {
  side: "old" | "new";
  lineNumber: number;
}

/** Check whether two inclusive line ranges overlap. */
function overlap(rangeA: [number, number], rangeB: [number, number]) {
  return rangeA[0] <= rangeB[1] && rangeB[0] <= rangeA[1];
}

/** Compute the old/new line ranges covered by a hunk, including single-line edge cases. */
function hunkLineRange(hunk: Hunk) {
  const newEnd = Math.max(hunk.additionStart, hunk.additionStart + Math.max(hunk.additionLines, 1) - 1);
  const oldEnd = Math.max(hunk.deletionStart, hunk.deletionStart + Math.max(hunk.deletionLines, 1) - 1);

  return {
    oldRange: [hunk.deletionStart, oldEnd] as [number, number],
    newRange: [hunk.additionStart, newEnd] as [number, number],
  };
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

/** Build a concise side-aware range label for inline note rows. */
export function annotationRangeLabel(annotation: AgentAnnotation) {
  const locationParts: string[] = [];

  if (annotation.oldRange) {
    locationParts.push(`◀ old ${formatRange(annotation.oldRange)}`);
  }

  if (annotation.newRange) {
    locationParts.push(`▶ new ${formatRange(annotation.newRange)}`);
  }

  return locationParts.join(" · ") || "hunk";
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

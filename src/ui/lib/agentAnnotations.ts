import type { AgentAnnotation, DiffFile, ReviewNoteSource } from "../../core/types";
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

/** Format an inclusive line range for note labels. */
function formatRange(range: [number, number]) {
  return range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`;
}

/** Format one range using GitHub's old/new side prefixes. */
function formatGithubStyleRange(prefix: "L" | "R", range: [number, number]) {
  return range[0] === range[1]
    ? `${prefix}${range[0]}`
    : `${prefix}${range[0]}–${prefix}${range[1]}`;
}

/** Build a concise GitHub-style file-and-line label for inline note rows. */
export function annotationRangeLabel(annotation: AgentAnnotation, file?: DiffFile) {
  const locationParts: string[] = [];
  if (annotation.oldRange) locationParts.push(formatGithubStyleRange("L", annotation.oldRange));
  if (annotation.newRange) locationParts.push(formatGithubStyleRange("R", annotation.newRange));

  const location = locationParts.join(" → ") || "hunk";
  return file ? `${fileLabel(file)} ${location}` : location;
}

/** Build the compact file-and-lines label shown on a framed agent note card. */
export function annotationLocationLabel(file: DiffFile, annotation: AgentAnnotation) {
  const locationParts: string[] = [];
  if (annotation.oldRange) locationParts.push(`-${formatRange(annotation.oldRange)}`);
  if (annotation.newRange) locationParts.push(`+${formatRange(annotation.newRange)}`);

  const location = locationParts.length > 0 ? ` ${locationParts.join(" ")}` : "";
  return `${fileLabel(file)}${location}`;
}

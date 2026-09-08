/**
 * Loads and validates the optional review sidecar JSON (`--agent-context`).
 *
 * "Sidecar" names the file and its loader; "agent" names what the file carries. The notes
 * inside it stay `AgentAnnotation` / `AgentFileContext` because that is both the published
 * extension contract and the term the UI shows. Keeping the two apart leaves `agent` free to
 * mean the coding-agent command surface in `packages/hunk/src/session/agent/`.
 */
import { resolve as resolvePath } from "node:path";
import type { AgentAnnotation, AgentFileContext } from "../../extension-api/types";
import type { SidecarContext } from "./model";

interface SidecarLoadOptions {
  cwd?: string;
}

type AnnotationConfidence = NonNullable<AgentAnnotation["confidence"]>;

const annotationConfidenceValues = [
  "low",
  "medium",
  "high",
] as const satisfies readonly AnnotationConfidence[];

/** Return an optional string field without repeating sidecar coercion policy. */
function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

/** Return an optional non-empty string field. */
function optionalNonEmptyString(value: unknown) {
  const text = optionalString(value);
  return text?.length ? text : undefined;
}

/** Return a supported annotation confidence without widening untrusted input. */
function optionalAnnotationConfidence(value: unknown): AnnotationConfidence | undefined {
  return annotationConfidenceValues.find((confidence) => confidence === value);
}

/** Normalize a line-range tuple if the sidecar provides one. */
function normalizeRange(range: unknown): [number, number] | undefined {
  if (!Array.isArray(range) || range.length !== 2) {
    return undefined;
  }

  const [start, end] = range;

  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end)
  ) {
    throw new Error("Annotation ranges must be integer tuples.");
  }

  if (start < 1 || end < 1) {
    throw new Error("Annotation ranges must use positive 1-based line numbers.");
  }

  if (end < start) {
    throw new Error("Annotation ranges must be ordered start..end tuples.");
  }

  return [start, end];
}

/** Normalize one note from the optional agent-context sidecar JSON. */
function normalizeAnnotation(annotation: unknown): AgentAnnotation {
  if (!annotation || typeof annotation !== "object") {
    throw new Error("Agent annotations must be objects.");
  }

  const item = annotation as Record<string, unknown>;
  const summary = optionalNonEmptyString(item.summary);
  if (summary === undefined) {
    throw new Error("Each agent annotation requires a summary.");
  }

  return {
    id: optionalString(item.id),
    oldRange: normalizeRange(item.oldRange),
    newRange: normalizeRange(item.newRange),
    summary,
    rationale: optionalString(item.rationale),
    markup: optionalNonEmptyString(item.markup),
    tags: Array.isArray(item.tags)
      ? item.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined,
    confidence: optionalAnnotationConfidence(item.confidence),
    source: optionalString(item.source),
    author: optionalString(item.author),
    createdAt: optionalString(item.createdAt),
  };
}

/** Normalize one file entry from the optional agent-context sidecar JSON. */
function normalizeAnnotationFile(file: unknown): AgentFileContext {
  if (!file || typeof file !== "object") {
    throw new Error("Agent context files must be objects.");
  }

  const value = file as Record<string, unknown>;
  const path = optionalNonEmptyString(value.path);
  if (path === undefined) {
    throw new Error("Agent context file entries require a non-empty path.");
  }

  const annotations = Array.isArray(value.annotations) ? value.annotations : [];
  return {
    path,
    summary: optionalString(value.summary),
    annotations: annotations.map(normalizeAnnotation),
  };
}

/** Load the optional agent-context sidecar from a file path or stdin. */
export async function loadSidecarContext(
  pathOrDash?: string,
  { cwd = process.cwd() }: SidecarLoadOptions = {},
): Promise<SidecarContext | null> {
  if (!pathOrDash) {
    return null;
  }

  const raw =
    pathOrDash === "-"
      ? await new Response(Bun.stdin.stream()).text()
      : await Bun.file(resolvePath(cwd, pathOrDash)).text();

  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Agent context must be a JSON object.");
  }

  const files = Array.isArray(parsed.files) ? parsed.files.map(normalizeAnnotationFile) : [];

  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    files,
  };
}

/** Match agent context to a diff file by current path first, then previous path for renames. */
export function findSidecarFileContext(
  sidecar: SidecarContext | null,
  currentPath: string,
  previousPath?: string,
): AgentFileContext | null {
  if (!sidecar) {
    return null;
  }

  return (
    sidecar.files.find((file) => file.path === currentPath || file.path === previousPath) ?? null
  );
}

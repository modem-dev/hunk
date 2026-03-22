import type { AgentContext, AgentFileContext } from "./types";

/** Normalize one file entry from the optional agent-context sidecar JSON. */
function normalizeAnnotationFile(file: unknown): AgentFileContext {
  if (!file || typeof file !== "object") {
    throw new Error("Agent context files must be objects.");
  }

  const value = file as Record<string, unknown>;

  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new Error("Agent context file entries require a non-empty path.");
  }

  const annotations = Array.isArray(value.annotations) ? value.annotations : [];

  return {
    path: value.path,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    annotations: annotations.map((annotation) => {
      if (!annotation || typeof annotation !== "object") {
        throw new Error("Agent annotations must be objects.");
      }

      const item = annotation as Record<string, unknown>;

      if (typeof item.summary !== "string" || item.summary.length === 0) {
        throw new Error("Each agent annotation requires a summary.");
      }

      /** Normalize a line-range tuple if the sidecar provides one. */
      const normalizeRange = (range: unknown) => {
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

        return [start, end] as [number, number];
      };

      return {
        id: typeof item.id === "string" ? item.id : undefined,
        oldRange: normalizeRange(item.oldRange),
        newRange: normalizeRange(item.newRange),
        summary: item.summary,
        rationale: typeof item.rationale === "string" ? item.rationale : undefined,
        tags: Array.isArray(item.tags)
          ? item.tags.filter((tag): tag is string => typeof tag === "string")
          : undefined,
        confidence:
          item.confidence === "low" || item.confidence === "medium" || item.confidence === "high"
            ? item.confidence
            : undefined,
        source: typeof item.source === "string" ? item.source : undefined,
        author: typeof item.author === "string" ? item.author : undefined,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
      };
    }),
  };
}

/** Load the optional agent-context sidecar from a file path or stdin. */
export async function loadAgentContext(pathOrDash?: string): Promise<AgentContext | null> {
  if (!pathOrDash) {
    return null;
  }

  const raw =
    pathOrDash === "-"
      ? await new Response(Bun.stdin.stream()).text()
      : await Bun.file(pathOrDash).text();

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
export function findAgentFileContext(
  agentContext: AgentContext | null,
  currentPath: string,
  previousPath?: string,
): AgentFileContext | null {
  if (!agentContext) {
    return null;
  }

  return (
    agentContext.files.find(
      (file) => file.path === currentPath || (previousPath ? file.path === previousPath : false),
    ) ?? null
  );
}

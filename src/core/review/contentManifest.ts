import type {
  ReviewDocumentProjectionV1,
  ReviewHunkV1,
  ReviewNoteV1,
  ReviewResourceDescriptorV1,
} from "./types";

export interface ReviewContentManifestFile {
  key: string;
  path: string;
  previousPath?: string;
  changeKind: string;
  language?: string;
  agentSummary?: string;
  stats: { additions: number; deletions: number; truncated: boolean };
  flags: { untracked: boolean; binary: boolean; tooLarge: boolean; partial: boolean };
  patch: string;
  additionLines: string[];
  deletionLines: string[];
  lineMoveKinds?: {
    additionLines: Array<"moved" | null>;
    deletionLines: Array<"moved" | null>;
  };
  hunks: ReviewHunkV1[];
  notes: ReviewNoteV1[];
  expandedContext: Array<{
    gapId: string;
    side: "old" | "new";
    oldRange: readonly [number, number];
    newRange: readonly [number, number];
    sourceText: string;
  }>;
}

/** Renderer-neutral semantic snapshot used by terminal/web parity tests. */
export interface ReviewContentManifest {
  version: 1;
  documentIdentity: string;
  sourceLabel: string;
  title: string;
  summary?: string;
  agentSummary?: string;
  files: ReviewContentManifestFile[];
}

/** Find a generation resource and assert that its descriptor is present. */
function resourceById(resources: ReviewResourceDescriptorV1[], id: string) {
  const resource = resources.find((candidate) => candidate.id === id);
  if (!resource) throw new Error(`Review document references missing resource ${id}.`);
  return resource;
}

/**
 * Build a deterministic semantic manifest from a projected review document.
 *
 * Generation ids, runtime ids, renderer rows, wrapping and geometry are
 * intentionally absent. Referenced patch and expanded-source bodies are
 * resolved so equality includes the exact content users review.
 */
export function buildReviewContentManifest(
  projection: ReviewDocumentProjectionV1,
): ReviewContentManifest {
  const { document, resourceContents } = projection;
  return {
    version: 1,
    documentIdentity: document.documentIdentity,
    sourceLabel: document.sourceLabel,
    title: document.title,
    ...(document.summary !== undefined ? { summary: document.summary } : {}),
    ...(document.agentSummary !== undefined ? { agentSummary: document.agentSummary } : {}),
    files: document.files.map((file) => {
      resourceById(document.resources, file.patchResourceId);
      const patch = resourceContents[file.patchResourceId];
      if (patch === undefined) {
        throw new Error(`Review projection omits patch resource ${file.patchResourceId}.`);
      }

      return {
        key: file.key,
        path: file.path,
        ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
        changeKind: file.changeKind,
        ...(file.language !== undefined ? { language: file.language } : {}),
        ...(file.agentSummary !== undefined ? { agentSummary: file.agentSummary } : {}),
        stats: { ...file.stats },
        flags: { ...file.flags },
        patch,
        additionLines: [...file.additionLines],
        deletionLines: [...file.deletionLines],
        ...(file.lineMoveKinds
          ? {
              lineMoveKinds: {
                additionLines: [...file.lineMoveKinds.additionLines],
                deletionLines: [...file.lineMoveKinds.deletionLines],
              },
            }
          : {}),
        hunks: file.hunks.map((hunk) => ({
          ...hunk,
          hunkContent: hunk.hunkContent.map((content) => ({ ...content })),
        })),
        notes: file.notes.map((note) => ({
          ...note,
          anchor: {
            ...note.anchor,
            ...(note.anchor.oldRange
              ? { oldRange: [...note.anchor.oldRange] as [number, number] }
              : {}),
            ...(note.anchor.newRange
              ? { newRange: [...note.anchor.newRange] as [number, number] }
              : {}),
            ...(note.anchor.preferred ? { preferred: { ...note.anchor.preferred } } : {}),
            intersectingHunkIndices: [...note.anchor.intersectingHunkIndices],
          },
          ...(note.tags ? { tags: [...note.tags] } : {}),
        })),
        expandedContext: file.expandedContext.map((expanded) => {
          resourceById(document.resources, expanded.sourceResourceId);
          const sourceText = resourceContents[expanded.sourceResourceId];
          if (sourceText === undefined) {
            throw new Error(
              `Review projection omits expanded source resource ${expanded.sourceResourceId}.`,
            );
          }
          return {
            gapId: expanded.gapId,
            side: expanded.side,
            oldRange: [...expanded.oldRange] as [number, number],
            newRange: [...expanded.newRange] as [number, number],
            sourceText,
          };
        }),
      };
    }),
  };
}

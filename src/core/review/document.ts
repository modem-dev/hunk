import { createHash, type Hash } from "node:crypto";
import type { AgentAnnotation, Changeset, DiffFile } from "../types";
import {
  reviewDigest,
  reviewDocumentIdentity,
  reviewResourceId,
  semanticFileEntryIdentity,
} from "./identity";
import { measureJsonStream } from "./jsonStream";
import { projectReviewNote, stableReviewNoteId } from "./notes";
import {
  REVIEW_DOCUMENT_VERSION,
  type ReviewDocumentGeneration,
  type ReviewDocumentProjectionV1,
  type ReviewExpandedContextV1,
  type ReviewFileV1,
  type ReviewHunkV1,
  type ReviewNoteOriginV1,
  type ReviewResourceDescriptorV1,
  type ReviewSide,
  type ReviewSourceResourceDescriptorV1,
} from "./types";

export interface ReviewAdditionalNoteInput {
  origin: Exclude<ReviewNoteOriginV1, "sidecar">;
  annotation: AgentAnnotation;
  editable?: boolean;
}

export interface ReviewExpandedContextInput {
  gapId: string;
  side: ReviewSide;
  oldRange: readonly [number, number];
  newRange: readonly [number, number];
  /** Full source snapshot used by the current expansion model. */
  sourceText: string;
}

export interface ProjectReviewDocumentOptions {
  /** Authoritative generation supplied by a future runtime publication boundary. */
  generation?: ReviewDocumentGeneration;
  sourceIdentity?: string;
  additionalNotesByFileId?: Readonly<Record<string, readonly ReviewAdditionalNoteInput[]>>;
  expandedContextByFileId?: Readonly<Record<string, readonly ReviewExpandedContextInput[]>>;
}

interface ReviewFileEntry {
  file: DiffFile;
  key: string;
  patchDigest: string;
  hunks: ReviewHunkV1[];
}

/** Return the UTF-8 size used by resource bounds and chunking. */
function utf8ByteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

/** Convert one Pierre hunk into an explicit JSON-safe semantic record. */
function projectHunk(file: DiffFile, index: number): ReviewHunkV1 {
  const hunk = file.metadata.hunks[index]!;
  return {
    index,
    collapsedBefore: hunk.collapsedBefore,
    splitLineCount: hunk.splitLineCount,
    splitLineStart: hunk.splitLineStart,
    unifiedLineCount: hunk.unifiedLineCount,
    unifiedLineStart: hunk.unifiedLineStart,
    additionCount: hunk.additionCount,
    additionStart: hunk.additionStart,
    additionLines: hunk.additionLines,
    deletionCount: hunk.deletionCount,
    deletionStart: hunk.deletionStart,
    deletionLines: hunk.deletionLines,
    deletionLineIndex: hunk.deletionLineIndex,
    additionLineIndex: hunk.additionLineIndex,
    hunkContent: hunk.hunkContent.map((content) =>
      content.type === "context"
        ? {
            type: "context",
            lines: content.lines,
            additionLineIndex: content.additionLineIndex,
            deletionLineIndex: content.deletionLineIndex,
          }
        : {
            type: "change",
            additions: content.additions,
            deletions: content.deletions,
            additionLineIndex: content.additionLineIndex,
            deletionLineIndex: content.deletionLineIndex,
          },
    ),
    ...(hunk.hunkSpecs !== undefined ? { hunkSpecs: hunk.hunkSpecs } : {}),
    ...(hunk.hunkContext !== undefined ? { hunkContext: hunk.hunkContext } : {}),
    noEOFCRAdditions: Boolean(hunk.noEOFCRAdditions),
    noEOFCRDeletions: Boolean(hunk.noEOFCRDeletions),
  };
}

/** Feed one unambiguous string sequence into a semantic identity without giant JSON buffers. */
function updateIdentityStrings(hash: Hash, label: string, values: readonly string[]) {
  hash.update(`${label}:${values.length}:`);
  const pending: string[] = [];
  let pendingCharacters = 0;
  const flush = () => {
    if (pending.length === 0) return;
    hash.update(pending.join(""), "utf8");
    pending.length = 0;
    pendingCharacters = 0;
  };
  for (const value of values) {
    // UTF-16 length plus a separator makes adjacent arbitrary strings unambiguous while batching
    // hash updates avoids the per-line native-call cost on giant reviews.
    const framed = `${value.length}:${value};`;
    pending.push(framed);
    pendingCharacters += framed.length;
    if (pendingCharacters >= 64 * 1024) flush();
  }
  flush();
}

/** Hash every renderer-neutral file fact without allocating one complete duplicate JSON string. */
function reviewFileContentIdentity(file: DiffFile, patchDigest: string, hunks: ReviewHunkV1[]) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      patchDigest,
      changeKind: file.metadata.type,
      language: file.language,
      stats: file.stats,
      statsTruncated: Boolean(file.statsTruncated),
      flags: {
        untracked: Boolean(file.isUntracked),
        binary: Boolean(file.isBinary),
        tooLarge: Boolean(file.isTooLarge),
        partial: Boolean(file.metadata.isPartial),
      },
      sourceIdentity:
        file.sourceFetcher?.cacheKey ?? (file.sourceFetcher ? "available" : undefined),
    }),
  );
  updateIdentityStrings(hash, "additions", file.metadata.additionLines);
  updateIdentityStrings(hash, "deletions", file.metadata.deletionLines);
  hash.update(JSON.stringify(hunks));
  hash.update(JSON.stringify(file.lineMoveKinds ?? null));
  return hash.digest("hex");
}

/** Allocate stable entry keys, using occurrence only for semantically identical copies. */
function buildReviewFileEntries(files: readonly DiffFile[], sourceIdentity: string) {
  const duplicateCounts = new Map<string, number>();
  return files.map((file): ReviewFileEntry => {
    const patchDigest = reviewDigest(file.patch);
    const hunks = file.metadata.hunks.map((_hunk, index) => projectHunk(file, index));
    const contentIdentity = reviewFileContentIdentity(file, patchDigest, hunks);
    const duplicateKey = JSON.stringify([
      sourceIdentity,
      file.previousPath ?? "",
      file.path,
      contentIdentity,
    ]);
    const duplicateIndex = duplicateCounts.get(duplicateKey) ?? 0;
    duplicateCounts.set(duplicateKey, duplicateIndex + 1);

    return {
      file,
      patchDigest,
      hunks,
      key: semanticFileEntryIdentity({
        sourceIdentity,
        path: file.path,
        previousPath: file.previousPath,
        contentIdentity,
        duplicateIndex,
      }),
    };
  });
}

/** Create or update one materialized source descriptor. */
function materializeSourceResource(
  descriptor: ReviewSourceResourceDescriptorV1,
  text: string,
): ReviewSourceResourceDescriptorV1 {
  return {
    ...descriptor,
    byteLength: utf8ByteLength(text),
    digest: reviewDigest(text),
  };
}

/** Project one ordered note list with file-wide id collision disambiguation. */
function projectNotes(
  file: DiffFile,
  fileKey: string,
  usedIds: Set<string>,
  inputs: readonly {
    origin: ReviewNoteOriginV1;
    annotation: AgentAnnotation;
    editable?: boolean;
  }[],
) {
  return inputs.map((input) => {
    const baseId = stableReviewNoteId(input.annotation, fileKey, input.origin);
    let projectedId = baseId;
    let suffix = 1;
    while (usedIds.has(projectedId)) {
      projectedId = `${baseId}:${suffix}`;
      suffix += 1;
    }
    usedIds.add(projectedId);

    return projectReviewNote({
      annotation: input.annotation,
      projectedId,
      fileKey,
      hunks: file.metadata.hunks,
      origin: input.origin,
      editable: input.editable,
    });
  });
}

/** Project a document using one already selected generation. */
function projectReviewDocumentGeneration(
  changeset: Changeset,
  options: ProjectReviewDocumentOptions,
  documentIdentity: string,
  generation: ReviewDocumentGeneration,
  fileEntries: readonly ReviewFileEntry[],
): ReviewDocumentProjectionV1 {
  const resources: ReviewResourceDescriptorV1[] = [];
  const resourceContents: Record<string, string> = {};
  const usedNoteIds = new Set<string>();

  const files = fileEntries.map(({ file, key: fileKey, patchDigest, hunks }): ReviewFileV1 => {
    const patchResourceId = reviewResourceId(generation, fileKey, "patch");
    resources.push({
      id: patchResourceId,
      kind: "patch",
      generation,
      fileKey,
      contentType: "text/x-diff; charset=utf-8",
      byteLength: utf8ByteLength(file.patch),
      digest: patchDigest,
    });
    resourceContents[patchResourceId] = file.patch;

    const sourceResourceIds: Partial<Record<ReviewSide, string>> = {};
    if (file.sourceFetcher) {
      for (const side of ["old", "new"] as const) {
        const id = reviewResourceId(generation, fileKey, "source", side);
        sourceResourceIds[side] = id;
        resources.push({
          id,
          kind: "source",
          generation,
          fileKey,
          side,
          contentType: "text/plain; charset=utf-8",
          sourceIdentity: file.sourceFetcher.cacheKey ?? `${fileKey}:${side}`,
        });
      }
    }

    const expandedContext: ReviewExpandedContextV1[] = [];
    for (const expanded of options.expandedContextByFileId?.[file.id] ?? []) {
      let sourceResourceId = sourceResourceIds[expanded.side];
      if (!sourceResourceId) {
        sourceResourceId = reviewResourceId(generation, fileKey, "source", expanded.side);
        sourceResourceIds[expanded.side] = sourceResourceId;
        resources.push({
          id: sourceResourceId,
          kind: "source",
          generation,
          fileKey,
          side: expanded.side,
          contentType: "text/plain; charset=utf-8",
          sourceIdentity: `${fileKey}:${expanded.side}`,
        });
      }

      const descriptorIndex = resources.findIndex((resource) => resource.id === sourceResourceId);
      const descriptor = resources[descriptorIndex] as ReviewSourceResourceDescriptorV1;
      resources[descriptorIndex] = materializeSourceResource(descriptor, expanded.sourceText);
      resourceContents[sourceResourceId] = expanded.sourceText;
      expandedContext.push({
        gapId: expanded.gapId,
        side: expanded.side,
        oldRange: [...expanded.oldRange] as [number, number],
        newRange: [...expanded.newRange] as [number, number],
        sourceResourceId,
      });
    }

    const notes = projectNotes(file, fileKey, usedNoteIds, [
      ...(file.agent?.annotations ?? []).map((annotation) => ({
        annotation,
        origin: "sidecar" as const,
      })),
      ...(options.additionalNotesByFileId?.[file.id] ?? []),
    ]);

    const canonicalResourceId = reviewResourceId(generation, fileKey, "canonical-file");
    const reviewFile: ReviewFileV1 = {
      key: fileKey,
      runtimeId: file.id,
      path: file.path,
      ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
      changeKind: file.metadata.type,
      ...(file.language !== undefined ? { language: file.language } : {}),
      ...(file.agent?.summary !== undefined ? { agentSummary: file.agent.summary } : {}),
      stats: {
        additions: file.stats.additions,
        deletions: file.stats.deletions,
        truncated: Boolean(file.statsTruncated),
      },
      flags: {
        untracked: Boolean(file.isUntracked),
        binary: Boolean(file.isBinary),
        tooLarge: Boolean(file.isTooLarge),
        partial: Boolean(file.metadata.isPartial),
      },
      patchResourceId,
      canonicalResourceId,
      sourceResourceIds,
      // Isolate authority from extension-owned normalized arrays so lazy canonical bytes cannot
      // change under one generation if an extension retains and later mutates its returned model.
      additionLines: [...file.metadata.additionLines],
      deletionLines: [...file.metadata.deletionLines],
      ...(file.lineMoveKinds
        ? {
            lineMoveKinds: {
              additionLines: file.lineMoveKinds.additionLines.map((kind) => kind ?? null),
              deletionLines: file.lineMoveKinds.deletionLines.map((kind) => kind ?? null),
            },
          }
        : {}),
      hunks,
      notes,
      expandedContext,
    };
    // Browser-only canonical bytes, size, and digest remain lazy until the producer is read.
    resources.push({
      id: canonicalResourceId,
      kind: "canonical-file",
      generation,
      fileKey,
      contentType: "application/vnd.hunk.review-file+json; charset=utf-8",
    });
    return reviewFile;
  });

  return {
    document: {
      version: REVIEW_DOCUMENT_VERSION,
      generation,
      documentIdentity,
      changesetId: changeset.id,
      sourceLabel: changeset.sourceLabel,
      title: changeset.title,
      ...(changeset.summary !== undefined ? { summary: changeset.summary } : {}),
      ...(changeset.agentSummary !== undefined ? { agentSummary: changeset.agentSummary } : {}),
      files,
      resources,
    },
    resourceContents,
  };
}

/** Strip publication addresses while retaining canonical reviewed content and resource digests. */
function generationSemanticContent(projection: ReviewDocumentProjectionV1) {
  const { document } = projection;
  const resourcesById = new Map(document.resources.map((resource) => [resource.id, resource]));
  const semanticResource = (id: string) => {
    const resource = resourcesById.get(id);
    if (!resource) throw new Error(`Review document references missing resource ${id}.`);
    const { id: _id, generation: _generation, ...semantic } = resource;
    return semantic;
  };

  return {
    version: document.version,
    documentIdentity: document.documentIdentity,
    sourceLabel: document.sourceLabel,
    title: document.title,
    summary: document.summary,
    agentSummary: document.agentSummary,
    files: document.files.map((file) => {
      const {
        runtimeId: _runtimeId,
        patchResourceId,
        canonicalResourceId: _canonicalResourceId,
        sourceResourceIds,
        expandedContext,
        ...semanticFile
      } = file;
      return {
        ...semanticFile,
        patchResource: semanticResource(patchResourceId),
        sourceResources: (["old", "new"] as const).flatMap((side) => {
          const id = sourceResourceIds[side];
          return id ? [{ side, resource: semanticResource(id) }] : [];
        }),
        expandedContext: expandedContext.map(({ sourceResourceId, ...context }) => ({
          ...context,
          sourceResource: semanticResource(sourceResourceId),
        })),
      };
    }),
  };
}

/**
 * Project the normalized terminal changeset into the renderer-neutral v1 document.
 *
 * File and note order is copied verbatim. Functions and Pierre implementation
 * objects never cross the boundary; patches and loaded source become addressed
 * generation resources. Without an authoritative override, generation hashes the
 * canonical reviewed content rather than the loader's runtime changeset id.
 */
export function projectReviewDocument(
  changeset: Changeset,
  options: ProjectReviewDocumentOptions = {},
): ReviewDocumentProjectionV1 {
  const sourceIdentity = options.sourceIdentity ?? `changeset:${changeset.id}`;
  const documentIdentity = reviewDocumentIdentity(sourceIdentity);
  const fileEntries = buildReviewFileEntries(changeset.files, sourceIdentity);

  if (options.generation !== undefined) {
    return projectReviewDocumentGeneration(
      changeset,
      options,
      documentIdentity,
      options.generation,
      fileEntries,
    );
  }

  const seedProjection = projectReviewDocumentGeneration(
    changeset,
    options,
    documentIdentity,
    "generation:semantic-seed",
    fileEntries,
  );
  const generation = `generation:${
    measureJsonStream(generationSemanticContent(seedProjection)).digest
  }`;
  return projectReviewDocumentGeneration(
    changeset,
    options,
    documentIdentity,
    generation,
    fileEntries,
  );
}
